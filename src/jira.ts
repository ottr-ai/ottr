import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { JiraIssue } from "./jiraCards.ts";
import { adfToMarkdown, fieldText, wikiToMarkdown } from "./jiraMarkup.ts";
import type { JiraType } from "./types.ts";

// Jira REST client for the import feature (docs/specs/jira-import.md section 1).

export interface JiraConn {
	site: string;
	type: JiraType;
	email: string | null;
	token: string;
	customFields: string[];
}

export class JiraError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly kind:
			| "jql"
			| "auth"
			| "network"
			| "timeout"
			| "redirect"
			| "blocked"
			| "bad_response",
	) {
		super(message);
		this.name = "JiraError";
	}
}

/**
 * The HTTP call. `pin` is the address the hosted SSRF check approved: the transport must
 * connect to exactly that address (no second DNS lookup), and keep the TLS name check on
 * the URL's hostname. `pin` is null when nothing was checked (not hosted).
 */
export type JiraTransport = (
	url: string,
	init: RequestInit & { signal: AbortSignal },
	pin: string | null,
) => Promise<Response>;

export interface JiraNet {
	/** Tests replace the transport; the default is `pinnedFetch`. */
	fetch?: JiraTransport;
	/** Hosted mode: refuse hosts that resolve to private, loopback or link-local addresses. */
	hosted: boolean;
	lookup?: (host: string) => Promise<string[]>;
	/** Default 15000. */
	timeoutMs?: number;
}

/**
 * Plain fetch when `pin` is null. With a pin, a node:https request whose `lookup` answers
 * only the pinned address, so a DNS change after the check cannot move the connection;
 * SNI and certificate checks still use the URL's hostname. `tls` adds trust (tests only).
 */
export function pinnedFetch(
	url: string,
	init: RequestInit & { signal: AbortSignal },
	pin: string | null,
	tls: { ca?: string } = {},
): Promise<Response> {
	if (pin === null) return fetch(url, { ...init, redirect: "manual" });
	const family = isIP(pin);
	const lookup: LookupFunction = (_host, opts, cb) => {
		if (opts.all) cb(null, [{ address: pin, family }]);
		else cb(null, pin, family);
	};
	const u = new URL(url);
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const req = httpsRequest(
		{
			method: init.method ?? "GET",
			host: u.hostname.replace(/^\[(.*)\]$/, "$1"),
			port: u.port === "" ? 443 : Number(u.port),
			path: `${u.pathname}${u.search}`,
			headers: init.headers as Record<string, string>,
			lookup,
			signal: init.signal,
			...tls,
		},
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("error", reject);
			res.on("end", () => {
				const headers = new Headers();
				for (const [k, v] of Object.entries(res.headers))
					if (v !== undefined)
						headers.set(k, Array.isArray(v) ? v.join(", ") : v);
				const status = res.statusCode ?? 502;
				// A Response cannot carry a body for these statuses.
				const empty = status === 204 || status === 304;
				resolve(
					new Response(empty ? null : Buffer.concat(chunks), {
						status,
						headers,
					}),
				);
			});
		},
	);
	req.on("error", reject);
	if (typeof init.body === "string") req.write(init.body);
	req.end();
	return promise;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 50;
const BASE_FIELDS = ["summary", "issuetype", "status", "priority"];
const FULL_FIELDS = ["description", "labels", "components", "parent"];

/** https only, no user info, query or fragment; origin plus optional context path, no trailing slash. */
export function normalizeSiteUrl(
	raw: string,
): { site: string } | { error: string } {
	const s = raw.trim();
	if (s === "") return { error: "enter the Jira site URL" };
	let url: URL;
	try {
		url = new URL(s);
	} catch {
		return { error: "the site URL is not a valid URL" };
	}
	if (url.protocol !== "https:")
		return { error: "the site URL must start with https://" };
	if (url.username !== "" || url.password !== "")
		return { error: "the site URL must not contain a user name or password" };
	// The parser drops an empty "?" or "#", so check the raw text too.
	if (url.search !== "" || s.includes("?"))
		return { error: "the site URL must not contain a query (?)" };
	if (url.hash !== "" || s.includes("#"))
		return { error: "the site URL must not contain a fragment (#)" };
	return { site: url.origin + url.pathname.replace(/\/+$/, "") };
}

function ipv4Octets(ip: string): number[] | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	const out: number[] = [];
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		out.push(n);
	}
	return out;
}

function blockedV4(o: number[]): boolean {
	const [a = 0, b = 0, c = 0] = o;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/** Eight 16-bit groups, or null when `ip` is not an IPv6 address. */
function ipv6Groups(ip: string): number[] | null {
	let s = ip.replace(/%.*$/, "");
	let tail: number[] = [];
	const lastColon = s.lastIndexOf(":");
	if (s.slice(lastColon + 1).includes(".")) {
		const o = ipv4Octets(s.slice(lastColon + 1));
		if (!o) return null;
		const [a = 0, b = 0, c = 0, d = 0] = o;
		tail = [(a << 8) | b, (c << 8) | d];
		s = s.slice(0, lastColon + 1);
		if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const parse = (h: string): number[] | null => {
		if (h === "") return [];
		const out: number[] = [];
		for (const g of h.split(":")) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
			out.push(Number.parseInt(g, 16));
		}
		return out;
	};
	const head = parse(halves[0] ?? "");
	const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
	if (!head || !rest) return null;
	const given = head.length + rest.length + tail.length;
	if (halves.length === 1) return given === 8 ? [...head, ...tail] : null;
	if (given > 7) return null;
	return [...head, ...new Array<number>(8 - given).fill(0), ...rest, ...tail];
}

function blockedV6(g: number[]): boolean {
	const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
	const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
	const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
	// ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible; covers :: and ::1).
	if (zeroPrefix && (g5 === 0xffff || g5 === 0)) return blockedV4(v4);
	return (
		(g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(g0 & 0xff00) === 0xff00 // ff00::/8 multicast
	);
}

/** True when the address is private, loopback, link-local, unspecified or not an IP at all. */
function blockedAddress(ip: string): boolean {
	const v4 = ipv4Octets(ip);
	if (v4) return blockedV4(v4);
	const v6 = ipv6Groups(ip);
	return v6 ? blockedV6(v6) : true;
}

const defaultLookup = async (host: string): Promise<string[]> =>
	(await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * Hosted mode only: throws JiraError "blocked" when the site's host is or resolves to a
 * non-public address. Returns the checked address that the request must connect to, or
 * null when not hosted (nothing checked, nothing pinned).
 */
export async function assertAllowedHost(
	site: string,
	net: JiraNet,
): Promise<string | null> {
	if (!net.hosted) return null;
	let host: string;
	try {
		host = new URL(site).hostname.replace(/^\[(.*)\]$/, "$1");
	} catch {
		throw new JiraError("the site URL is not a valid URL", null, "network");
	}
	let addresses: string[];
	if (isIP(host) !== 0) addresses = [host];
	else {
		try {
			addresses = await (net.lookup ?? defaultLookup)(host);
		} catch (err) {
			throw new JiraError(
				`could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}`,
				null,
				"network",
			);
		}
		if (addresses.length === 0)
			throw new JiraError(`could not resolve ${host}`, null, "network");
	}
	const bad = addresses.find(blockedAddress);
	if (bad !== undefined)
		throw new JiraError(
			`${host} resolves to a private address (${bad}); hosted mode blocks it`,
			null,
			"blocked",
		);
	return addresses[0] ?? host;
}

function authHeader(c: JiraConn): string {
	return c.type === "cloud"
		? `Basic ${Buffer.from(`${c.email ?? ""}:${c.token}`).toString("base64")}`
		: `Bearer ${c.token}`;
}

/** Jira's own error text: `errorMessages` plus the values of `errors`. */
function jiraMessages(body: unknown): string {
	const b = obj(body);
	const out: string[] = [];
	if (Array.isArray(b.errorMessages))
		for (const m of b.errorMessages) if (typeof m === "string") out.push(m);
	for (const m of Object.values(obj(b.errors)))
		if (typeof m === "string") out.push(m);
	return out.join("; ");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function send(
	site: string,
	c: JiraConn | null,
	method: "GET" | "POST",
	path: string,
	body: unknown,
	net: JiraNet,
): Promise<unknown> {
	// One deadline covers the hosted DNS check and the request: a stalled resolver times out too.
	const timeoutMs = net.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const signal = AbortSignal.timeout(timeoutMs);
	const timedOut = () =>
		new JiraError(
			`Jira did not answer within ${timeoutMs / 1000} s`,
			null,
			"timeout",
		);
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(timedOut());
	signal.addEventListener("abort", onAbort, { once: true });
	let pin: string | null;
	try {
		pin = await Promise.race([assertAllowedHost(site, net), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		aborted.catch(() => {});
	}
	const headers: Record<string, string> = { Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (c) headers.Authorization = authHeader(c);
	let res: Response;
	let text: string;
	try {
		res = await (net.fetch ?? pinnedFetch)(
			`${site}${path}`,
			{
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
				signal,
			},
			pin,
		);
		text = await res.text();
	} catch (err) {
		if (signal.aborted) throw timedOut();
		throw new JiraError(
			`could not reach Jira: ${err instanceof Error ? err.message : String(err)}`,
			null,
			"network",
		);
	}
	const { status } = res;
	if (status >= 300 && status < 400)
		throw new JiraError(
			`Jira answered with a redirect (${status}) to ${res.headers.get("location") ?? "no Location"}; check the site URL`,
			status,
			"redirect",
		);
	const json = parseJson(text);
	if (status === 400)
		throw new JiraError(
			jiraMessages(json) || "Jira refused the request (HTTP 400)",
			status,
			"jql",
		);
	if (status === 401 || status === 403)
		throw new JiraError(`Jira refused access (HTTP ${status})`, status, "auth");
	if (status < 200 || status >= 300) {
		const detail = jiraMessages(json);
		throw new JiraError(
			`Jira answered HTTP ${status}${detail ? `: ${detail}` : ""}`,
			status,
			"bad_response",
		);
	}
	if (json === undefined)
		throw new JiraError(
			"Jira answered with something other than JSON",
			status,
			"bad_response",
		);
	return json;
}

/** Every Jira call goes through here; no message ever carries the token. */
async function request(
	site: string,
	c: JiraConn | null,
	method: "GET" | "POST",
	path: string,
	net: JiraNet,
	body?: unknown,
): Promise<unknown> {
	try {
		return await send(site, c, method, path, body, net);
	} catch (err) {
		if (c && c.token !== "" && err instanceof Error) {
			const secrets = [c.token, authHeader(c).replace(/^\S+ /, "")];
			let msg = err.message;
			for (const s of secrets) msg = msg.split(s).join("[redacted]");
			if (msg !== err.message)
				throw err instanceof JiraError
					? new JiraError(msg, err.status, err.kind)
					: new Error(msg);
		}
		throw err;
	}
}

function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Reads `deploymentType` from the unauthenticated serverInfo endpoint. */
export async function detectType(
	site: string,
	net: JiraNet,
): Promise<{ type: JiraType } | { type: null; reason: string }> {
	let info: unknown;
	try {
		info = await request(site, null, "GET", "/rest/api/2/serverInfo", net);
	} catch (err) {
		return {
			type: null,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
	const kind = obj(info).deploymentType;
	if (kind === "Cloud") return { type: "cloud" };
	if (kind === "Server" || kind === "DataCenter") return { type: "datacenter" };
	return {
		type: null,
		reason:
			typeof kind === "string"
				? `Jira reported an unknown deployment type "${kind}"`
				: "Jira did not report a deployment type",
	};
}

export async function testConnection(
	c: JiraConn,
	net: JiraNet,
): Promise<{ displayName: string }> {
	const v = c.type === "cloud" ? 3 : 2;
	const me = obj(await request(c.site, c, "GET", `/rest/api/${v}/myself`, net));
	if (typeof me.displayName !== "string")
		throw new JiraError(
			"Jira did not return a user name",
			null,
			"bad_response",
		);
	return { displayName: me.displayName };
}

function toIssue(raw: unknown, c: JiraConn): JiraIssue | null {
	const issue = obj(raw);
	if (typeof issue.key !== "string" || issue.key === "") return null;
	const f = obj(issue.fields);
	const desc = f.description;
	const description =
		desc == null
			? ""
			: c.type === "cloud"
				? adfToMarkdown(desc)
				: wikiToMarkdown(str(desc));
	const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
	return {
		key: issue.key,
		summary: str(f.summary),
		description,
		issueType: str(obj(f.issuetype).name),
		status: str(obj(f.status).name),
		priority: str(obj(f.priority).name),
		labels: list(f.labels).filter((l): l is string => typeof l === "string"),
		components: list(f.components)
			.map((x) => str(obj(x).name))
			.filter((n) => n !== ""),
		parent: str(obj(f.parent).key),
		custom: c.customFields
			.map((id) => ({ id, text: fieldText(f[id]) }))
			.filter((x) => x.text.trim() !== ""),
	};
}

function issuesOf(body: Record<string, unknown>): unknown[] {
	if (!Array.isArray(body.issues))
		throw new JiraError(
			"Jira's search answer has no issue list",
			null,
			"bad_response",
		);
	return body.issues;
}

/** One page of a JQL search. `cursor` is Cloud's nextPageToken or Data Center's startAt. */
export async function searchIssues(
	c: JiraConn,
	jql: string,
	cursor: string | null,
	net: JiraNet,
	o: { full?: boolean; pageSize?: number } = {},
): Promise<{ issues: JiraIssue[]; next: string | null; total: number | null }> {
	const maxResults = o.pageSize ?? DEFAULT_PAGE_SIZE;
	const fields = o.full
		? [...BASE_FIELDS, ...FULL_FIELDS, ...c.customFields]
		: BASE_FIELDS;
	const map = (raw: unknown[]) =>
		raw.map((r) => toIssue(r, c)).filter((i): i is JiraIssue => i !== null);
	if (c.type === "cloud") {
		const body = obj(
			await request(c.site, c, "POST", "/rest/api/3/search/jql", net, {
				jql,
				maxResults,
				fields,
				...(cursor ? { nextPageToken: cursor } : {}),
			}),
		);
		const issues = map(issuesOf(body));
		const token = body.nextPageToken;
		const next =
			body.isLast === true || typeof token !== "string" || token === ""
				? null
				: token;
		return { issues, next, total: null };
	}
	if (cursor !== null && !/^\d+$/.test(cursor))
		throw new JiraError(`invalid page cursor "${cursor}"`, null, "jql");
	const startAt = cursor === null ? 0 : Number(cursor);
	const body = obj(
		await request(c.site, c, "POST", "/rest/api/2/search", net, {
			jql,
			startAt,
			maxResults,
			fields,
		}),
	);
	const raw = issuesOf(body);
	const total = typeof body.total === "number" ? body.total : null;
	const end = startAt + raw.length;
	const next =
		total !== null && raw.length > 0 && end < total ? String(end) : null;
	return { issues: map(raw), next, total };
}
