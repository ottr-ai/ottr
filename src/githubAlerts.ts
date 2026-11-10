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

/** Control chars, newlines and tabs become single spaces; runs of spaces collapse. */
export function cleanText(v: unknown, max = LABEL_MAX): string {
	const s = String(v ?? "")
		.replace(/\p{Cc}/gu, " ")
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

/** Human name for one endpoint kind, used in the parse-failure reason. */
const KIND_LABEL: Record<
	"dependabot" | "code-scanning" | "secret-scanning",
	string
> = {
	dependabot: "dependabot",
	"code-scanning": "code scanning",
	"secret-scanning": "secret scanning",
};

/** One gh page's parsed array, or the reason the page failed. */
async function fetchPage(
	gh: GhFn,
	path: string,
	kind: "dependabot" | "code-scanning" | "secret-scanning",
): Promise<Fetch> {
	let res: { code: number; stdout: string; stderr: string };
	try {
		res = await gh(["api", path], 30_000);
	} catch (e) {
		return { alerts: [], reason: cleanText((e as Error).message, 200) };
	}
	if (res.code !== 0) {
		const line = res.stderr.split("\n")[0] ?? "";
		const reason = cleanText(line, 200) || `exit ${res.code}`;
		return { alerts: [], reason };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		parsed = "not json";
	}
	if (!Array.isArray(parsed)) {
		return {
			alerts: [],
			reason: `could not parse the ${KIND_LABEL[kind]} response`,
		};
	}
	return { alerts: parsed, reason: null };
}

/** All open alerts of one endpoint: whole pages until a short page, capped at MAX_PAGES. */
async function fetchEndpoint(
	gh: GhFn,
	id: string,
	kind: "dependabot" | "code-scanning" | "secret-scanning",
): Promise<Fetch> {
	const base = `repos/${id}/${kind}-alerts`;
	const all: Record<string, unknown>[] = [];
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
	alerts: Record<string, unknown>[];
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
 * "secret" are never read or emitted.
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
	for (const r of results) {
		if (r.reason !== null) return `alerts unavailable: ${r.reason}`;
	}
	const [dep, code, secret] = results;
	const total = dep.alerts.length + code.alerts.length + secret.alerts.length;
	const categories: Category[] = [
		{ name: "Dependabot", alerts: dep.alerts, severities: true, item: depItem },
		{
			name: "Code scanning",
			alerts: code.alerts,
			severities: true,
			item: codeItem,
		},
		{
			name: "Secret scanning",
			alerts: secret.alerts,
			severities: false,
			item: secretItem,
		},
	];
	const lines: string[] = [`GitHub security alerts for ${id}: ${total} open.`];
	for (const c of categories) {
		lines.push(countsLine(c.name, c.alerts, c.severities));
		if (c.alerts.length > 0) lines.push(...itemLines(c.alerts, topN, c.item));
	}
	return lines.join("\n");
}
