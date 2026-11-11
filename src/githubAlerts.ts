import type { GhFn } from "./forks.ts";
import { ownerRepo, runGh } from "./release.ts";

const ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const LABEL_MAX = 120;

type Fetch = {
	alerts: Record<string, unknown>[];
	reason: string | null;
};

const SEVERITY_RANK: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

/** Control chars, newlines and tabs become single spaces; runs of spaces collapse.
 * The DATA fence markers and the Unicode line separators die too: untrusted text must
 * never carry one, or it could end its DATA block early (forkAnalysis.ts clean()). */
export function cleanText(v: unknown, max = LABEL_MAX): string {
	const s = String(v ?? "")
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/<<<DATA|DATA>>>/g, "[fence marker removed]")
		.replace(/ +/g, " ")
		.trim();
	return s.length > max ? s.slice(0, max) : s;
}

const str = (o: Record<string, unknown> | undefined, key: string): unknown =>
	o?.[key];

function severity(a: Record<string, unknown>): string {
	return cleanText(
		str(str(a, "rule") as Record<string, unknown>, "security_severity_level") ??
			str(str(a, "rule") as Record<string, unknown>, "severity") ??
			str(str(a, "security_advisory") as Record<string, unknown>, "severity") ??
			str(a, "severity") ??
			"others",
	).toLowerCase();
}

/** Severity label used in the counts line; unknown severities fall in "others". */
const countsLabel = (s: string): string =>
	SEVERITY_RANK[s] === undefined ? "others" : s;

/** One alert endpoint's GitHub kind. */
type AlertKind = "dependabot" | "code-scanning" | "secret-scanning";

/** Human name for one endpoint kind, used in the parse-failure reason. */
const KIND_LABEL: Record<AlertKind, string> = {
	dependabot: "dependabot",
	"code-scanning": "code scanning",
	"secret-scanning": "secret scanning",
};

/** One fetched page plus the next page's cursor (set only when headers were read). */
type Page = Fetch & { nextAfter: string | null };

/** gh api -i prints the response headers, a blank line, then the body. */
function splitBody(stdout: string): { headers: string; body: string } {
	const m = /\r?\n\r?\n/.exec(stdout);
	if (m === null || m.index === undefined) return { headers: "", body: stdout };
	return {
		headers: stdout.slice(0, m.index),
		body: stdout.slice(m.index + m[0].length),
	};
}

/** A cursor token we are willing to reuse in a request URL: stays percent-encoded. */
const CURSOR_RE = /^[A-Za-z0-9_%.~+=:-]{1,300}$/;

/** The after cursor of the Link header's rel="next" URL, or null when none is usable. */
function nextAfterFromLink(headers: string): string | null {
	for (const line of headers.split(/\r?\n/)) {
		if (!/^link:/i.test(line)) continue;
		const next = line
			.slice(5)
			.split(",")
			.find((part) => part.includes('rel="next"'));
		const url = /<([^>]+)>/.exec(next ?? "")?.[1] ?? "";
		const cursor = /[?&]after=([^&\s>]+)/.exec(url)?.[1];
		return cursor !== undefined && CURSOR_RE.test(cursor) ? cursor : null;
	}
	return null;
}

/** One gh page's parsed array, or the reason the page failed. Dependabot reads
 * headers too: it rejected offset pagination (page, HTTP 400) and its Link
 * header carries the next page's after cursor. */
async function fetchPage(
	gh: GhFn,
	path: string,
	kind: AlertKind,
): Promise<Page> {
	const withHeaders = kind === "dependabot";
	const args = withHeaders ? ["api", "-i", path] : ["api", path];
	let res: { code: number; stdout: string; stderr: string };
	try {
		res = await gh(args, 30_000);
	} catch (e) {
		return {
			alerts: [],
			reason: cleanText((e as Error).message, 200),
			nextAfter: null,
		};
	}
	if (res.code !== 0) {
		const line = res.stderr.split("\n")[0] ?? "";
		const reason = cleanText(line, 200) || `exit ${res.code}`;
		return { alerts: [], reason, nextAfter: null };
	}
	let stdout = res.stdout;
	let nextAfter: string | null = null;
	if (withHeaders) {
		const head = splitBody(stdout);
		stdout = head.body;
		nextAfter = nextAfterFromLink(head.headers);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = "not json";
	}
	if (!Array.isArray(parsed)) {
		return {
			alerts: [],
			reason: `could not parse the ${KIND_LABEL[kind]} response`,
			nextAfter: null,
		};
	}
	return { alerts: parsed, reason: null, nextAfter };
}

/** All open alerts of one endpoint, capped at MAX_PAGES. Dependabot pages by the
 * after cursor until its Link header runs out; the scanning endpoints keep
 * whole offset pages until a short one. */
async function fetchEndpoint(
	gh: GhFn,
	id: string,
	kind: AlertKind,
): Promise<Fetch> {
	const base = `repos/${id}/${kind}/alerts`;
	const all: Record<string, unknown>[] = [];
	if (kind === "dependabot") {
		let after: string | null = null;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const cursor = after === null ? "" : `&after=${after}`;
			const r = await fetchPage(
				gh,
				`${base}?state=open&per_page=${PAGE_SIZE}${cursor}`,
				kind,
			);
			if (r.reason !== null) return r;
			all.push(...r.alerts);
			if (r.nextAfter === null) break;
			after = r.nextAfter;
		}
		return { alerts: all, reason: null };
	}
	for (let page = 1; page <= MAX_PAGES; page++) {
		const r = await fetchPage(
			gh,
			`${base}?state=open&per_page=${PAGE_SIZE}&page=${page}`,
			kind,
		);
		if (r.reason !== null) return r;
		all.push(...r.alerts);
		if (r.alerts.length < PAGE_SIZE) break;
	}
	return { alerts: all, reason: null };
}

type Category = {
	name: string;
	kind: AlertKind;
	fetch: Fetch;
	severities: boolean;
	item: (a: Record<string, unknown>) => string;
};

function top(
	alerts: Record<string, unknown>[],
	topN: number,
): Record<string, unknown>[] {
	return [...alerts]
		.sort((a, b) => {
			const d =
				(SEVERITY_RANK[severity(a)] ?? 4) - (SEVERITY_RANK[severity(b)] ?? 4);
			if (d !== 0) return d;
			return (Number(a.number) || 0) - (Number(b.number) || 0);
		})
		.slice(0, topN);
}

function countsLine(
	name: string,
	alerts: Record<string, unknown>[],
	severities: boolean,
): string {
	const n = alerts.length;
	if (!severities || n === 0) return `- ${name}: ${n} open`;
	const tally = new Map<string, number>();
	for (const a of alerts) {
		const s = countsLabel(severity(a));
		tally.set(s, (tally.get(s) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const s of ["critical", "high", "medium", "low", "others"]) {
		const c = tally.get(s);
		if (c) parts.push(`${c} ${s}`);
	}
	return `- ${name}: ${n} open (${parts.join(", ")})`;
}

/** GitHub's fixed answers for a disabled feature; they collapse to "not enabled". */
const NOT_ENABLED_RE = [
	/Advanced Security must be enabled/i,
	/Secret scanning is disabled/i,
];

/** One category's failure line: "not enabled" for a disabled feature, the redacted reason otherwise. */
function alertTypeLine(name: string, kind: AlertKind, reason: string): string {
	const disabled =
		NOT_ENABLED_RE.some((re) => re.test(reason)) ||
		(kind === "secret-scanning" && reason.includes("HTTP 404"));
	if (disabled) return `- ${name}: not enabled`;
	return `- ${name}: not available (${reason})`;
}

function itemLines(
	alerts: Record<string, unknown>[],
	topN: number,
	item: (a: Record<string, unknown>) => string,
): string[] {
	return top(alerts, topN).map((a) => {
		const sev = severity(a);
		const tail = SEVERITY_RANK[sev] === undefined ? "" : ` (${sev})`;
		return `  - ${cleanText(item(a))}${tail} ${cleanText(a.html_url, Infinity)}`;
	});
}

const depItem = (a: Record<string, unknown>): string => {
	const dep = str(a, "dependency") as Record<string, unknown> | undefined;
	const pkg = str(dep, "package") as Record<string, unknown> | undefined;
	const vuln = str(a, "security_vulnerability") as
		| Record<string, unknown>
		| undefined;
	const adv = str(a, "security_advisory") as
		| Record<string, unknown>
		| undefined;
	const pkgName = cleanText(str(pkg, "name"));
	const range = cleanText(str(vuln, "vulnerable_version_range"));
	const label =
		pkgName !== "" || range !== ""
			? `${pkgName} ${range}`.trim()
			: cleanText(str(adv, "summary"));
	return label || "(unknown)";
};

const codeItem = (a: Record<string, unknown>): string => {
	const rule = str(a, "rule") as Record<string, unknown> | undefined;
	return cleanText(str(rule, "id")) || "(unknown)";
};

const secretItem = (a: Record<string, unknown>): string => {
	const label =
		cleanText(str(a, "secret_type_display_name")) ||
		cleanText(str(a, "secret_type")) ||
		"(unknown)";
	const validity = str(a, "validity");
	const tail =
		typeof validity === "string" && validity.length > 0
			? ` (${cleanText(validity)})`
			: "";
	return `${label}${tail}`;
};

/**
 * Short untrusted-DATA summary of a project repo's open GitHub security alerts.
 * Never throws. Every API-derived string is sanitized; values under keys named
 * "secret" are never read or emitted. A failed endpoint becomes one line for its
 * type ("not enabled" for a disabled feature, the redacted reason otherwise);
 * only a failure of all three types returns the single "alerts unavailable" line.
 */
export async function githubAlertSummary(o: {
	repo: string | null;
	gh?: GhFn;
	top?: number;
}): Promise<string> {
	const gh = o.gh ?? runGh;
	const topN = o.top ?? 5;
	if (o.repo === null) {
		return "alerts unavailable: project has no GitHub remote";
	}
	// ownerRepo reads URL tails only; a bare "owner/name" entry is already normalized.
	const id = ownerRepo(o.repo) ?? (ID_RE.test(o.repo) ? o.repo : null);
	if (id === null || !ID_RE.test(id)) {
		return "alerts unavailable: cannot read owner/name from the project remote";
	}
	const results = await Promise.all([
		fetchEndpoint(gh, id, "dependabot"),
		fetchEndpoint(gh, id, "code-scanning"),
		fetchEndpoint(gh, id, "secret-scanning"),
	]);
	const [dep, code, secret] = results;
	// Only a total failure collapses to one line: a single disabled feature must not
	// hide the other types' alerts.
	if (dep.reason !== null && code.reason !== null && secret.reason !== null) {
		return `alerts unavailable: ${dep.reason}`;
	}
	const total = dep.alerts.length + code.alerts.length + secret.alerts.length;
	const categories: Category[] = [
		{
			name: "Dependabot",
			kind: "dependabot",
			fetch: dep,
			severities: true,
			item: depItem,
		},
		{
			name: "Code scanning",
			kind: "code-scanning",
			fetch: code,
			severities: true,
			item: codeItem,
		},
		{
			name: "Secret scanning",
			kind: "secret-scanning",
			fetch: secret,
			severities: false,
			item: secretItem,
		},
	];
	const lines: string[] = [`GitHub security alerts for ${id}: ${total} open.`];
	for (const c of categories) {
		if (c.fetch.reason !== null) {
			lines.push(alertTypeLine(c.name, c.kind, c.fetch.reason));
			continue;
		}
		lines.push(countsLine(c.name, c.fetch.alerts, c.severities));
		if (c.fetch.alerts.length > 0)
			lines.push(...itemLines(c.fetch.alerts, topN, c.item));
	}
	return lines.join("\n");
}
