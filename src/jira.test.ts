import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	assertAllowedHost,
	detectType,
	type JiraConn,
	JiraError,
	type JiraNet,
	normalizeSiteUrl,
	searchIssues,
	testConnection,
} from "./jira.ts";
import { adfToMarkdown, wikiToMarkdown } from "./jiraMarkup.ts";
import fc from "./test/properties.ts";

// Jira REST client (docs/specs/jira-import.md section 1) against a local HTTP stub.

interface Seen {
	method: string;
	path: string;
	auth: string | null;
	accept: string | null;
	body: unknown;
}

let seen: Seen[] = [];
let answer: (req: Seen) => Response | Promise<Response> = () =>
	Response.json({});

const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		const text = await req.text();
		const s: Seen = {
			method: req.method,
			path: new URL(req.url).pathname,
			auth: req.headers.get("authorization"),
			accept: req.headers.get("accept"),
			body: text === "" ? undefined : JSON.parse(text),
		};
		seen.push(s);
		return answer(s);
	},
});
afterAll(() => stub.stop(true));

beforeEach(() => {
	seen = [];
	answer = () => Response.json({});
});

const SITE = "https://jira.test";
const BASE = `http://127.0.0.1:${stub.port}`;

/** The real request path, with the https origin pointed at the plain-http stub. */
const toStub = ((input: string | URL | Request, init?: RequestInit) =>
	fetch(String(input).replace(SITE, BASE), init)) as typeof fetch;

const net = (o: Partial<JiraNet> = {}): JiraNet => ({
	hosted: false,
	fetch: toStub,
	...o,
});

const TOKEN = "tok-S3CRET-value";
const cloud: JiraConn = {
	site: SITE,
	type: "cloud",
	email: "me@acme.test",
	token: TOKEN,
	customFields: [],
};
const dc: JiraConn = { ...cloud, type: "datacenter", email: null };

const issue = (key: string, fields: Record<string, unknown> = {}) => ({
	key,
	fields: { summary: `sum ${key}`, ...fields },
});

async function jiraError(p: Promise<unknown>): Promise<JiraError> {
	try {
		await p;
	} catch (err) {
		expect(err).toBeInstanceOf(JiraError);
		return err as JiraError;
	}
	throw new Error("expected a JiraError");
}

describe("searchIssues: Cloud", () => {
	test("POST /rest/api/3/search/jql with Basic auth, pages by nextPageToken", async () => {
		answer = (s) => {
			const b = s.body as { nextPageToken?: string };
			return b.nextPageToken === "page-2"
				? Response.json({ issues: [issue("A-3")], isLast: true })
				: Response.json({
						issues: [issue("A-1"), issue("A-2")],
						nextPageToken: "page-2",
						isLast: false,
					});
		};
		const first = await searchIssues(cloud, "project = A", null, net());
		expect(first.issues.map((i) => i.key)).toEqual(["A-1", "A-2"]);
		expect(first.next).toBe("page-2");
		expect(first.total).toBeNull();
		const second = await searchIssues(cloud, "project = A", "page-2", net());
		expect(second.issues.map((i) => i.key)).toEqual(["A-3"]);
		expect(second.next).toBeNull();

		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"POST /rest/api/3/search/jql",
			"POST /rest/api/3/search/jql",
		]);
		const basic = `Basic ${Buffer.from(`me@acme.test:${TOKEN}`).toString("base64")}`;
		expect(seen.every((s) => s.auth === basic)).toBe(true);
		expect(seen.every((s) => s.accept === "application/json")).toBe(true);
		const fields = ["summary", "issuetype", "status", "priority"];
		expect(seen[0]?.body).toEqual({
			jql: "project = A",
			maxResults: 50,
			fields,
		});
		expect(seen[1]?.body).toEqual({
			jql: "project = A",
			maxResults: 50,
			fields,
			nextPageToken: "page-2",
		});
	});

	test("isLast wins over a leftover nextPageToken", async () => {
		answer = () =>
			Response.json({ issues: [], nextPageToken: "stale", isLast: true });
		expect((await searchIssues(cloud, "x", null, net())).next).toBeNull();
	});

	test("full search maps ADF descriptions and requests every field", async () => {
		const doc = {
			type: "doc",
			version: 1,
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Hello" }] },
			],
		};
		answer = () =>
			Response.json({
				issues: [issue("A-1", { description: doc, priority: null })],
				isLast: true,
			});
		const c = { ...cloud, customFields: ["customfield_9"] };
		const [got] = (await searchIssues(c, "x", null, net(), { full: true }))
			.issues;
		expect(got?.description).toBe(adfToMarkdown(doc));
		expect(got?.priority).toBe("");
		expect((seen[0]?.body as { fields: string[] } | undefined)?.fields).toEqual(
			[
				"summary",
				"issuetype",
				"status",
				"priority",
				"description",
				"labels",
				"components",
				"parent",
				"customfield_9",
			],
		);
	});
});

describe("searchIssues: Data Center", () => {
	test("POST /rest/api/2/search with Bearer auth, pages by startAt", async () => {
		answer = (s) => {
			const { startAt } = s.body as { startAt: number };
			const n = Math.min(50, 120 - startAt);
			return Response.json({
				startAt,
				maxResults: 50,
				total: 120,
				issues: Array.from({ length: n }, (_, i) =>
					issue(`D-${startAt + i + 1}`),
				),
			});
		};
		const nexts: (string | null)[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 3; page++) {
			const r = await searchIssues(dc, "project = D", cursor, net());
			expect(r.total).toBe(120);
			nexts.push(r.next);
			cursor = r.next;
		}
		expect(nexts).toEqual(["50", "100", null]);
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(
			Array(3).fill("POST /rest/api/2/search"),
		);
		expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
		expect(seen.map((s) => (s.body as { startAt: number }).startAt)).toEqual([
			0, 50, 100,
		]);
		expect(seen[0]?.body).toEqual({
			jql: "project = D",
			startAt: 0,
			maxResults: 50,
			fields: ["summary", "issuetype", "status", "priority"],
		});
	});

	test("maps every field of a full issue", async () => {
		answer = () =>
			Response.json({
				startAt: 0,
				total: 1,
				issues: [
					issue("D-7", {
						summary: "Fix login",
						description: "plain *bold* text",
						issuetype: { name: "Bug" },
						status: { name: "In Progress" },
						priority: { name: "High" },
						labels: ["ui", "auth"],
						components: [{ name: "Web" }, { name: "API" }],
						parent: { key: "D-1" },
						customfield_1: "one",
						customfield_2: { value: "two" },
						customfield_3: null,
					}),
				],
			});
		const c = {
			...dc,
			customFields: ["customfield_2", "customfield_3", "customfield_1"],
		};
		const r = await searchIssues(c, "key = D-7", null, net(), { full: true });
		expect(r.next).toBeNull();
		expect(r.issues).toEqual([
			{
				key: "D-7",
				summary: "Fix login",
				description: wikiToMarkdown("plain *bold* text"),
				issueType: "Bug",
				status: "In Progress",
				priority: "High",
				labels: ["ui", "auth"],
				components: ["Web", "API"],
				parent: "D-1",
				custom: [
					{ id: "customfield_2", text: "two" },
					{ id: "customfield_1", text: "one" },
				],
			},
		]);
	});

	test("a non-numeric cursor is refused before any request", async () => {
		const e = await jiraError(searchIssues(dc, "x", "abc", net()));
		expect(e.kind).toBe("jql");
		expect(seen).toHaveLength(0);
	});

	test("an answer without an issue list is a bad response", async () => {
		answer = () => Response.json({ total: 3 });
		expect((await jiraError(searchIssues(dc, "x", null, net()))).kind).toBe(
			"bad_response",
		);
	});
});

describe("detectType", () => {
	const serverInfo = (deploymentType: unknown) => () =>
		Response.json({ deploymentType, version: "9.12.0" });

	test.each([
		["Cloud", "cloud"],
		["DataCenter", "datacenter"],
		["Server", "datacenter"],
	])("deploymentType %s -> %s", async (value, type) => {
		answer = serverInfo(value);
		expect(await detectType(SITE, net())).toEqual({
			type: type as "cloud" | "datacenter",
		});
		expect(seen).toEqual([
			{
				method: "GET",
				path: "/rest/api/2/serverInfo",
				auth: null,
				accept: "application/json",
				body: undefined,
			},
		]);
	});

	test("an unknown or missing deploymentType gives a reason", async () => {
		answer = serverInfo("Mainframe");
		const r = await detectType(SITE, net());
		expect(r.type).toBeNull();
		expect("reason" in r && r.reason).toContain("Mainframe");
		answer = serverInfo(undefined);
		const missing = await detectType(SITE, net());
		expect(missing.type).toBeNull();
		expect("reason" in missing && missing.reason).toContain("deployment type");
	});

	test("401 and non-JSON answers give a reason, not a throw", async () => {
		answer = () => new Response("no", { status: 401 });
		const denied = await detectType(SITE, net());
		expect(denied.type).toBeNull();
		expect("reason" in denied && denied.reason).toContain("401");
		answer = () =>
			new Response("<html>login</html>", {
				headers: { "content-type": "text/html" },
			});
		const html = await detectType(SITE, net());
		expect(html.type).toBeNull();
		expect("reason" in html && html.reason).toContain("JSON");
	});
});

describe("testConnection", () => {
	test("Cloud asks /rest/api/3/myself, Data Center /rest/api/2/myself", async () => {
		answer = () => Response.json({ displayName: "Ada Lovelace" });
		expect(await testConnection(cloud, net())).toEqual({
			displayName: "Ada Lovelace",
		});
		expect(await testConnection(dc, net())).toEqual({
			displayName: "Ada Lovelace",
		});
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"GET /rest/api/3/myself",
			"GET /rest/api/2/myself",
		]);
	});

	test("an answer without displayName is a bad response", async () => {
		answer = () => Response.json({ name: "x" });
		expect((await jiraError(testConnection(dc, net()))).kind).toBe(
			"bad_response",
		);
	});
});

describe("errors", () => {
	test("400 with errorMessages is a JQL error carrying Jira's text", async () => {
		answer = () =>
			Response.json(
				{
					errorMessages: ["The value 'NOPE' does not exist for 'project'."],
					errors: { jql: "Field 'foo' does not exist." },
				},
				{ status: 400 },
			);
		const e = await jiraError(
			searchIssues(cloud, "project = NOPE", null, net()),
		);
		expect(e.kind).toBe("jql");
		expect(e.status).toBe(400);
		expect(e.message).toBe(
			"The value 'NOPE' does not exist for 'project'.; Field 'foo' does not exist.",
		);
	});

	test.each([401, 403])("%i is an auth error without the token", async (st) => {
		answer = () => new Response("denied", { status: st });
		const e = await jiraError(searchIssues(cloud, "x", null, net()));
		expect(e.kind).toBe("auth");
		expect(e.status).toBe(st);
		expect(e.message).not.toContain(TOKEN);
	});

	test("another error status is a bad response", async () => {
		answer = () => Response.json({ errorMessages: ["down"] }, { status: 503 });
		const e = await jiraError(testConnection(dc, net()));
		expect(e.kind).toBe("bad_response");
		expect(e.message).toContain("503");
		expect(e.message).toContain("down");
	});

	test("a 302 is a redirect error naming Location; it is not followed", async () => {
		answer = () =>
			new Response(null, {
				status: 302,
				headers: { location: `${BASE}/login.jsp` },
			});
		const e = await jiraError(searchIssues(dc, "x", null, net()));
		expect(e.kind).toBe("redirect");
		expect(e.status).toBe(302);
		expect(e.message).toContain(`${BASE}/login.jsp`);
		expect(seen).toHaveLength(1);
	});

	test("a stub that never answers gives a timeout", async () => {
		answer = () => new Promise<Response>(() => {});
		const e = await jiraError(
			searchIssues(cloud, "x", null, net({ timeoutMs: 200 })),
		);
		expect(e.kind).toBe("timeout");
		expect(e.message).toBe("Jira did not answer within 0.2 s");
		expect(e.status).toBeNull();
	});

	test("a refused connection is a network error without the token", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response() });
		const deadBase = `http://127.0.0.1:${dead.port}`;
		await dead.stop(true);
		const refused = ((input: string | URL | Request, init?: RequestInit) =>
			fetch(String(input).replace(SITE, deadBase), init)) as typeof fetch;
		const e = await jiraError(
			searchIssues(dc, "x", null, net({ fetch: refused })),
		);
		expect(e.kind).toBe("network");
		expect(e.message).toStartWith("could not reach Jira: ");
		expect(e.message).not.toContain(TOKEN);
	});

	test("a fetch error that echoes the credentials is redacted", async () => {
		const echo = ((_: unknown, init?: RequestInit) =>
			Promise.reject(
				new Error(
					`socket closed: ${(init?.headers as Record<string, string> | undefined)?.Authorization}`,
				),
			)) as typeof fetch;
		for (const c of [cloud, dc]) {
			const e = await jiraError(
				searchIssues(c, "x", null, net({ fetch: echo })),
			);
			expect(e.kind).toBe("network");
			expect(e.message).toContain("[redacted]");
			expect(e.message).not.toContain(TOKEN);
			expect(e.message).not.toContain(
				Buffer.from(`me@acme.test:${TOKEN}`).toString("base64"),
			);
		}
	});
});

describe("normalizeSiteUrl", () => {
	test.each([
		["https://acme.atlassian.net", "https://acme.atlassian.net"],
		["  https://Acme.Atlassian.NET/  ", "https://acme.atlassian.net"],
		["https://jira.corp/jira/", "https://jira.corp/jira"],
		["https://jira.corp:443/jira//", "https://jira.corp/jira"],
		["https://jira.corp:8443/", "https://jira.corp:8443"],
	])("%p -> %p", (raw, site) => {
		expect(normalizeSiteUrl(raw)).toEqual({ site });
	});

	test.each([
		"",
		"jira.corp",
		"http://jira.corp",
		"ftp://jira.corp",
		"https://user@jira.corp",
		"https://user:pw@jira.corp",
		"https://jira.corp/?a=1",
		"https://jira.corp/jira?",
		"https://jira.corp/#top",
		"https://jira.corp#",
	])("%p is refused", (raw) => {
		const r = normalizeSiteUrl(raw);
		expect("error" in r && r.error.length > 0).toBe(true);
	});

	test("property: never throws; accepted sites are clean and stable", () => {
		const url = fc.webUrl({
			validSchemes: ["https", "http"],
			withQueryParameters: true,
			withFragments: true,
			authoritySettings: { withUserInfo: true, withPort: true },
		});
		const input = fc.oneof(
			fc.string(),
			url,
			fc
				.tuple(url, fc.constantFrom("", "/", "//", "?", "#", " ", "@x"))
				.map(([u, s]) => u + s),
		);
		fc.assert(
			fc.property(input, (raw) => {
				const r = normalizeSiteUrl(raw);
				if ("error" in r) return;
				expect(r.site).toStartWith("https://");
				expect(r.site).not.toContain("?");
				expect(r.site).not.toContain("#");
				expect(r.site.slice(8).split("/")[0]).not.toContain("@");
				expect(normalizeSiteUrl(r.site)).toEqual({ site: r.site });
			}),
			{ seed: 42, numRuns: 150 },
		);
	});
});

describe("assertAllowedHost", () => {
	const hosted = (addr: string): JiraNet => ({
		hosted: true,
		lookup: async () => [addr],
	});

	test.each([
		"127.0.0.1",
		"10.0.0.5",
		"192.168.1.1",
		"169.254.169.254",
		"172.16.0.1",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::",
		"::1",
		"fd00::1",
		"fe80::1",
		"::ffff:10.0.0.1",
		"::ffff:127.0.0.1",
	])("hosted: %s is blocked", async (addr) => {
		const e = await jiraError(assertAllowedHost(SITE, hosted(addr)));
		expect(e.kind).toBe("blocked");
		expect(e.message).toContain(addr);
	});

	test.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])(
		"hosted: %s is allowed",
		async (addr) => {
			await assertAllowedHost(SITE, hosted(addr));
		},
	);

	test("one private address among public ones blocks", async () => {
		const n: JiraNet = {
			hosted: true,
			lookup: async () => ["93.184.216.34", "10.1.2.3"],
		};
		expect((await jiraError(assertAllowedHost(SITE, n))).kind).toBe("blocked");
	});

	test("hosted: a literal IP host is checked without a lookup", async () => {
		const n: JiraNet = {
			hosted: true,
			lookup: () => Promise.reject(new Error("lookup must not run")),
		};
		for (const site of ["https://127.0.0.1", "https://[::1]:8443/jira"])
			expect((await jiraError(assertAllowedHost(site, n))).kind).toBe(
				"blocked",
			);
	});

	test("hosted: a failed lookup is a network error", async () => {
		const n: JiraNet = {
			hosted: true,
			lookup: () => Promise.reject(new Error("ENOTFOUND")),
		};
		const e = await jiraError(assertAllowedHost(SITE, n));
		expect(e.kind).toBe("network");
		expect(e.message).toContain("ENOTFOUND");
	});

	test("not hosted: private hosts are allowed and nothing is resolved", async () => {
		let lookups = 0;
		await assertAllowedHost("https://127.0.0.1", {
			hosted: false,
			lookup: async () => {
				lookups++;
				return ["127.0.0.1"];
			},
		});
		await assertAllowedHost(SITE, {
			hosted: false,
			lookup: async () => {
				lookups++;
				return ["10.0.0.1"];
			},
		});
		expect(lookups).toBe(0);
	});

	test("hosted: a search to a blocked host makes no fetch call", async () => {
		let calls = 0;
		const counting = ((input: string | URL | Request, init?: RequestInit) => {
			calls++;
			return toStub(input, init);
		}) as typeof fetch;
		const e = await jiraError(
			searchIssues(cloud, "x", null, {
				...hosted("10.0.0.5"),
				fetch: counting,
			}),
		);
		expect(e.kind).toBe("blocked");
		expect(calls).toBe(0);
		expect(seen).toHaveLength(0);
	});

	test("hosted: an allowed host goes through to the request", async () => {
		answer = () => Response.json({ displayName: "Ada" });
		const n = net({ hosted: true, lookup: async () => ["93.184.216.34"] });
		expect(await testConnection(dc, n)).toEqual({ displayName: "Ada" });
	});
});
