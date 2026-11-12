/** Deterministic performance lens for automatic PR reviews: it scans a PR diff's added
 * lines for per-item queries inside loops and for nested loops or linear scans inside
 * loops, and hands the candidates to the review model as unverified leads. Pure: no I/O,
 * no store. */

/** Changed-path globs that arm the lens: database/query and repository files. */
export const PERF_LENS_GLOBS: readonly string[] = ["**/db/**", "**/*repo*"];

/** PR labels that arm the lens (exact match). */
export const PERF_LENS_LABELS: readonly string[] = ["perf"];

/** One deterministic candidate: an unverified lead the review model must check against
 * the diff before it reports anything. */
export interface PerfFinding {
	kind: "n+1" | "quadratic";
	/** Path as in the diff's `+++ b/` line. */
	path: string;
	/** 1-based line of the new file, tracked from the `@@` hunk headers. */
	line: number;
	/** The trimmed added line, capped at 120 characters. */
	snippet: string;
}

/** Longest candidate snippet kept. */
const SNIPPET_MAX = 120;

/** Most candidates one scan reports; the scan stops there and the render says how many
 * candidates past the cap were omitted. */
const FINDINGS_CAP = 20;

/** True when the lens is armed for a change: a changed path matches a glob, or a label
 * exactly equals one of the lens labels. Globs match case-insensitively, so the repo
 * glob also arms on repository files named like `userRepo.ts`. */
export function perfLensTriggered(
	changedPaths: string[],
	labels: string[],
): boolean {
	if (labels.some((l) => PERF_LENS_LABELS.includes(l))) return true;
	const matchers = PERF_LENS_GLOBS.map((g) => new Bun.Glob(g.toLowerCase()));
	return changedPaths.some((p) =>
		matchers.some((m) => m.match(p.toLowerCase())),
	);
}

/** Unique changed paths of a unified diff, from its `+++ b/<path>` lines; deleted files
 * (`/dev/null`) are skipped. Tolerant: everything else in the text is ignored. */
export function changedDiffPaths(diff: string): string[] {
	const out: string[] = [];
	for (const raw of diff.split("\n")) {
		const p = fileHeaderPath(raw);
		if (p !== null && !out.includes(p)) out.push(p);
	}
	return out;
}

/** A loop-open line: a `for`/`while`/`foreach` keyword, or an iterating method call. */
const LOOP_KEYWORD_RE = /\b(?:for|while|foreach)\b/;
const LOOP_METHOD_NEEDLES = [".forEach(", ".map(", ".each("];

/** A per-item query: a SQL literal keyword, a query-style method call, or a database
 * receiver's method call. */
const SQL_KEYWORD_RE = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/;
const QUERY_METHOD_NEEDLES = [
	".query(",
	".prepare(",
	".execute(",
	".raw(",
	".findMany(",
	".findOne(",
	".fetchAll(",
];
const DB_RECEIVER_RE =
	/\b(?:db|conn|tx|trx|store|repo|prisma|knex|drizzle|sql)\.\w+\s*\(/;

/** A linear scan: a full-pass array method. */
const SCAN_NEEDLES = [
	".includes(",
	".indexOf(",
	".lastIndexOf(",
	".find(",
	".findIndex(",
	".some(",
	".filter(",
];

/** The `@@ -a,b +c,d @@` header; capture group 1 is the new file's first line number. */
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** New-file start line of a `@@` hunk header; null on any other line. */
function hunkStart(raw: string): number | null {
	const hunk = HUNK_RE.exec(raw);
	return hunk === null ? null : Number(hunk[1]);
}

/** The path of a `+++ b/<path>` line; null on any other line and for `/dev/null`. */
function fileHeaderPath(raw: string): string | null {
	if (!raw.startsWith("+++ b/")) return null;
	const p = raw.slice(6).trim();
	return p === "" || p === "/dev/null" ? null : p;
}

/** Comment lines are prose, never code: they neither open loops nor close them. */
function isComment(trimmed: string): boolean {
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("<!--")
	);
}

function isLoopOpen(trimmed: string): boolean {
	return (
		LOOP_KEYWORD_RE.test(trimmed) ||
		LOOP_METHOD_NEEDLES.some((n) => trimmed.includes(n))
	);
}

function isQueryLine(trimmed: string): boolean {
	return (
		SQL_KEYWORD_RE.test(trimmed) ||
		QUERY_METHOD_NEEDLES.some((n) => trimmed.includes(n)) ||
		DB_RECEIVER_RE.test(trimmed)
	);
}

function isScanLine(trimmed: string): boolean {
	return SCAN_NEEDLES.some((n) => trimmed.includes(n));
}

/** The finding class of one added line inside `depth` open loops, or null when the line
 * matches nothing. A line yields at most one finding: the query class wins over the
 * scan class, and a nested loop only counts when the line matches nothing else. */
function classifyLine(
	trimmed: string,
	depth: number,
): PerfFinding["kind"] | null {
	if (depth === 0) return null;
	if (isQueryLine(trimmed)) return "n+1";
	if (isScanLine(trimmed)) return "quadratic";
	if (isLoopOpen(trimmed)) return "quadratic";
	return null;
}

/** One diff line shaped for the scan. */
interface ScanLine {
	/** Path from the file's `+++ b/` header; null outside a real file (deleted files). */
	path: string | null;
	/** 1-based line of the new file, tracked from the `@@` hunk headers. */
	line: number;
	/** The line without its diff marker, trimmed. */
	trimmed: string;
	/** Indent of the line in the new file. */
	indent: number;
	/** True when the change adds this line. */
	added: boolean;
	/** True on the first line after a hunk or file boundary: per-file loop state
	 * resets before it. */
	boundary: boolean;
}

/** The diff as scan lines: hunk headers set the new-file line counter, `diff --git`
 * and `+++` switch the file, deleted lines drop out (they exist in neither the scan
 * nor the new file), and blank and comment lines pass untracked (they never match and
 * never close a loop; both still advance the counter). Added and context lines yield. */
function* scanLines(diff: string): Generator<ScanLine> {
	let path: string | null = null;
	let line = 1;
	let boundary = true;
	for (const raw of diff.split("\n")) {
		const start = hunkStart(raw);
		if (start !== null) {
			line = start;
			boundary = true;
			continue;
		}
		if (raw.startsWith("diff --git ") || raw.startsWith("+++ ")) {
			path = fileHeaderPath(raw);
			line = 1;
			boundary = true;
			continue;
		}
		if (raw.startsWith("-")) continue;
		// The `\ No newline at end of file` marker annotates the line above it: it is
		// no line of either file, so it advances nothing, matches nothing, and closes
		// no loop (prInline.ts handles the same marker in its hunk walk).
		if (raw.startsWith("\\")) continue;
		const added = raw.startsWith("+");
		const content = added ? raw.slice(1) : raw;
		const trimmed = content.trim();
		if (trimmed === "" || isComment(trimmed)) {
			line++;
			continue;
		}
		yield {
			path,
			line,
			trimmed,
			indent: content.length - content.trimStart().length,
			added,
			boundary,
		};
		boundary = false;
		line++;
	}
}

/** Open loops whose indent the line's indent reaches: the line closes them. */
function closeLoops(loops: number[], indent: number): void {
	while (loops.length > 0 && (loops.at(-1) ?? -1) >= indent) loops.pop();
}

/** The candidate of one scan line, or null when the line yields no candidate. */
function finding(l: ScanLine, kind: PerfFinding["kind"]): PerfFinding {
	return {
		kind,
		path: l.path ?? "",
		line: l.line,
		snippet: l.trimmed.slice(0, SNIPPET_MAX),
	};
}

/** Candidates of one PR diff, in diff order, at most FINDINGS_CAP of them. The scan runs
 * only when the lens is armed for the diff's paths or the PR's labels; an untriggered
 * diff returns [] without a scan. Only added lines inside an open loop match: the loop
 * stack per file closes on dedent (see closeLoops) and a loop-open line opens one after
 * the line's own classification. */
export function perfFindings(diff: string, labels: string[]): PerfFinding[] {
	if (!perfLensTriggered(changedDiffPaths(diff), labels)) return [];
	const out: PerfFinding[] = [];
	const loops: number[] = [];
	for (const l of scanLines(diff)) {
		if (l.path === null) continue;
		if (l.boundary) loops.length = 0;
		closeLoops(loops, l.indent);
		const kind = l.added ? classifyLine(l.trimmed, loops.length) : null;
		if (kind !== null) {
			out.push(finding(l, kind));
			if (out.length >= FINDINGS_CAP) return out;
		}
		if (isLoopOpen(l.trimmed)) loops.push(l.indent);
	}
	return out;
}

/** The candidates as DATA block lines for the review model: one line per finding, and
 * when more than FINDINGS_CAP came in, a closing line that says how many were omitted. */
export function renderPerfCandidates(findings: PerfFinding[]): string {
	const kept = findings.slice(0, FINDINGS_CAP);
	const lines = kept.map(
		(f) => `- ${f.path}:${f.line} ${f.kind}: ${f.snippet}`,
	);
	const cut = findings.length - kept.length;
	if (cut > 0) lines.push(`${cut} more candidate(s) omitted`);
	return lines.join("\n");
}
