/** Client-side slicing and line classification for unified git diffs. */

/** One row of a line-level diff between two drafts: kept, added or removed. */
export type DiffRow = { kind: "same" | "add" | "del"; text: string };

/** Line count above which lineDiff skips the LCS: the whole old side becomes del rows, the whole new side add rows (bounded memory, no O(n·m) table). */
const LINE_DIFF_MAX = 2000;

/** dp cell read for the flat LCS table (row-major, `w` cells per row); indices are in bounds by construction, so the fallback is unreachable. */
function dpCell(dp: Uint32Array, w: number, i: number, j: number): number {
	return dp[i * w + j] ?? 0;
}

/** dp[i][j] = LCS length of al[i..] vs bl[j..], kept in one flat row-major table (w = bl.length + 1). */
function lcsTable(al: string[], bl: string[]): Uint32Array {
	const m = al.length;
	const w = bl.length + 1;
	const dp = new Uint32Array((m + 1) * w);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = bl.length - 1; j >= 0; j--) {
			dp[i * w + j] =
				al[i] === bl[j]
					? dpCell(dp, w, i + 1, j + 1) + 1
					: Math.max(dpCell(dp, w, i + 1, j), dpCell(dp, w, i, j + 1));
		}
	}
	return dp;
}

/** Walks the LCS table and pushes one row per step: same lines first, then the leftover old/new tails. */
function pushRows(
	out: DiffRow[],
	al: string[],
	bl: string[],
	dp: Uint32Array,
	w: number,
): void {
	let i = 0;
	let j = 0;
	const m = al.length;
	const n = bl.length;
	// i < m and j < n keep every read in bounds; the ?? fallbacks are unreachable.
	while (i < m && j < n) {
		const ai = al[i] ?? "";
		const bj = bl[j] ?? "";
		if (ai === bj) {
			out.push({ kind: "same", text: ai });
			i++;
			j++;
		} else if (dpCell(dp, w, i + 1, j) >= dpCell(dp, w, i, j + 1)) {
			out.push({ kind: "del", text: ai });
			i++;
		} else {
			out.push({ kind: "add", text: bj });
			j++;
		}
	}
	while (i < m) out.push({ kind: "del", text: al[i++] ?? "" });
	while (j < n) out.push({ kind: "add", text: bl[j++] ?? "" });
}

/** Line-level LCS diff of `a` vs `b`, split on "\n". Beyond the cap both sides come back whole: old as del, new as add. */
export function lineDiff(a: string, b: string): DiffRow[] {
	// A wholly empty side is no lines, not one empty line: "" and "a" differ by one add.
	const al = a === "" ? [] : a.split("\n");
	const bl = b === "" ? [] : b.split("\n");
	if (al.length > LINE_DIFF_MAX || bl.length > LINE_DIFF_MAX) {
		return [
			...al.map((text) => ({ kind: "del", text }) as const),
			...bl.map((text) => ({ kind: "add", text }) as const),
		];
	}
	const dp = lcsTable(al, bl);
	const out: DiffRow[] = [];
	pushRows(out, al, bl, dp, bl.length + 1);
	return out;
}

/** A question's diff link `[label](diff:a.ts,b.ts)`: opens those files' diff sections. */
export type DiffLinkPart =
	| { kind: "text"; text: string }
	| { kind: "link"; label: string; files: string[] };

const DIFF_LINK_RE = /\[([^\]\n]*)\]\((diff:[^()\s]+)\)/g;

/** Splits question text into plain runs and diff links; text outside links stays literal
 *  (a `diff:` href without paths degrades to plain text too). A bare quoted path that names
 *  one of `changed` becomes a link to that file's diff section; unchanged paths stay literal. */
export function diffLinkParts(
	text: string,
	changed?: readonly string[],
): DiffLinkPart[] {
	const out: DiffLinkPart[] = [];
	let last = 0;
	for (const m of text.matchAll(DIFF_LINK_RE)) {
		const start = m.index ?? 0;
		const files = (m[2] ?? "")
			.slice("diff:".length)
			.split(",")
			.map((f) => f.trim())
			.filter((f) => f !== "");
		if (files.length === 0) continue;
		if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
		out.push({ kind: "link", label: m[1] ?? "", files });
		last = start + m[0].length;
	}
	if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
	if (changed === undefined || changed.length === 0) return out;
	return out.flatMap((part) =>
		part.kind === "text" ? pathLinkParts(part.text, changed) : [part],
	);
}

/** Path characters except the dot; the dot needs the two-sided border rule below, since a
 *  sentence-final dot after a path is prose, not part of a longer name. */
const PATH_BODY = /[A-Za-z0-9_@~/+-]/;
/** Characters a file path may continue with: a match bordered by one of these would cut a
 *  longer token (src/ui/diff.ts inside src/ui/diff.tsx, a path inside a URL) in half. */
const PATH_BORDER = /[A-Za-z0-9_@~/.+-]/;

/** Splits one plain run so each whole-token occurrence of a changed path becomes a single-file
 *  link labelled with the path as the question quoted it. Longest path wins, so a changed
 *  src/ui/diff.tsx beats its own src/ui/diff.ts prefix. The right border allows one trailing
 *  period: a dot followed by prose or the end is a sentence mark, a dot followed by more path
 *  text (foo.d.ts) still refuses the match. */
function pathLinkParts(
	text: string,
	changed: readonly string[],
): DiffLinkPart[] {
	const alts = [...changed]
		.sort((a, b) => b.length - a.length)
		.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const re = new RegExp(
		`(?<!${PATH_BORDER.source})(?:${alts.join("|")})(?!(?:${PATH_BODY.source}|\\.${PATH_BORDER.source}))`,
		"g",
	);
	const out: DiffLinkPart[] = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		const start = m.index ?? 0;
		if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
		out.push({ kind: "link", label: m[0], files: [m[0]] });
		last = start + m[0].length;
	}
	if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
	return out;
}

const META =
	/^(diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename (?:from|to) |copy (?:from|to) |Binary )/;

/** Line kind for diff highlighting: file and hunk headers, added and removed lines, context. */
export function diffLineClass(
	line: string,
): "add" | "del" | "hunk" | "meta" | "ctx" {
	if (line.startsWith("@@")) return "hunk";
	if (META.test(line)) return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	return "ctx";
}

/** The paths one diff section names: the `diff --git` pair plus the `--- a/` and `+++ b/` headers
 *  (the git line alone covers binary sections, which have no ---/+++ headers). */
function sectionNames(section: string): string[] {
	const names: string[] = [];
	const git = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
	if (git !== null) names.push(git[1] ?? "", git[2] ?? "");
	const old = section.match(/^--- a\/(.+)$/m);
	if (old !== null) names.push(old[1] ?? "");
	const neu = section.match(/^\+\+\+ b\/(.+)$/m);
	if (neu !== null) names.push(neu[1] ?? "");
	return names;
}

/** Paths a numstat entry may name: the path itself plus both sides of a rename, which git writes
 *  as "old => new" or, around a renamed directory, "dir/{old => new}/rest". */
function statNames(file: string): string[] {
	const names = [file];
	const brace = file.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
	if (brace !== null) {
		names.push((brace[1] ?? "") + (brace[2] ?? "") + (brace[4] ?? ""));
		names.push((brace[1] ?? "") + (brace[3] ?? "") + (brace[4] ?? ""));
	} else {
		const arrow = file.match(/^(.*) => (.*)$/);
		if (arrow !== null) names.push(arrow[1] ?? "", arrow[2] ?? "");
	}
	return names;
}

/** One file's section of a unified diff, split out for per-file cards. */
export type DiffSection = {
	/** Display path: the `+++ b/` side, or the `--- a/` side when the new side is absent or `/dev/null` (deleted file); falls back to names[0]. */
	path: string;
	/** Every path the section answers to: the `diff --git a/… b/…` pair plus the `--- a/` and `+++ b/` names. */
	names: string[];
	/** The section's lines, from the `diff --git` header through the section's last content line; never a trailing empty line. */
	lines: string[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Derives one section's slice and path; `start` is where the section's `diff --git` line sits. */
function splitSection(
	lines: string[],
	heads: number[],
	n: number,
	start: number,
): DiffSection {
	let end =
		n + 1 < heads.length ? (heads[n + 1] ?? lines.length) : lines.length;
	while (end > start && lines[end - 1] === "") end--;
	const sectionLines = lines.slice(start, end);
	const names = sectionNames(sectionLines.join("\n"));
	const neu = sectionLines.find((l) => l.startsWith("+++ "));
	const old = sectionLines.find((l) => l.startsWith("--- "));
	// Pure renames carry no ---/+++ headers: the `diff --git` pair's b-side (names[1]) is
	// then the new path; names[0] is the last resort for sections with no names at all.
	let path = names[1] ?? names[0] ?? "";
	if (neu !== undefined) {
		const p = neu.slice("+++ ".length).replace(/^b\//, "");
		if (p !== "/dev/null") path = p;
	} else if (old !== undefined) {
		path = old.slice("--- ".length).replace(/^a\//, "");
	}
	return { path, names, lines: sectionLines };
}

/** Splits a unified diff into one section per file, in file order. Text without any `diff --git ` line yields []. */
export function splitDiffSections(text: string): DiffSection[] {
	const lines = text.split("\n");
	const heads: number[] = [];
	for (const [i, line] of lines.entries()) {
		if (line.startsWith("diff --git ")) heads.push(i);
	}
	const sections: DiffSection[] = [];
	for (const [n, start] of heads.entries()) {
		sections.push(splitSection(lines, heads, n, start));
	}
	return sections;
}

/** Picks the sections for the named drawer files, keeping the requested order; a file whose section is absent is skipped. Matches with the same rules the old diffFileSlice used (statNames: raw path, `old => new`, and `dir/{old => new}/rest` brace forms). */
export function pickDiffSections(
	all: DiffSection[],
	files: string[],
): DiffSection[] {
	const picked: DiffSection[] = [];
	const taken = new Set<DiffSection>();
	for (const file of files) {
		const wanted = statNames(file);
		for (const section of all) {
			if (taken.has(section)) continue;
			if (section.names.some((name) => wanted.includes(name))) {
				picked.push(section);
				taken.add(section);
				break;
			}
		}
	}
	return picked;
}

/** One renderable diff line: class for color, old/new line numbers from the `@@ -o[,oc] +n[,nc] @@` headers (null = no number). */
export type DiffLine = {
	cls: "add" | "del" | "hunk" | "meta" | "ctx";
	old: number | null;
	new: number | null;
	text: string;
};

/** Running counters for one open hunk: the next old/new numbers and the lines each side has left. */
type HunkCounters = {
	oldNo: number;
	newNo: number;
	oldLeft: number;
	newLeft: number;
};

/** Pushes one in-hunk line with its numbers; a bare `@@` line ends the hunk by clearing the counters. */
function pushHunkLine(out: DiffLine[], line: string, c: HunkCounters): void {
	if (line.startsWith("@@")) {
		c.oldLeft = 0;
		c.newLeft = 0;
		out.push({ cls: "hunk", old: null, new: null, text: line });
		return;
	}
	const first = line.charAt(0);
	if (first === "+") {
		c.newLeft--;
		out.push({ cls: "add", old: null, new: c.newNo++, text: line });
	} else if (first === "-") {
		c.oldLeft--;
		out.push({ cls: "del", old: c.oldNo++, new: null, text: line });
	} else if (first === "\\") {
		// The no-newline marker belongs to the previous line: no numbers, no advance.
		out.push({ cls: "ctx", old: null, new: null, text: line });
	} else {
		c.oldLeft--;
		c.newLeft--;
		out.push({ cls: "ctx", old: c.oldNo++, new: c.newNo++, text: line });
	}
}

/** Adds old/new line numbers to one file section's lines by walking its `@@` hunk headers.
 *  Inside a hunk the class comes from the prefix character alone: body text may itself read
 *  as a header (`--- ` from a removed SQL or Lua comment, `+++ ` from an added one), which
 *  the whole-diff classifier would misfile as meta. The header's counts end the hunk, so
 *  nothing after it shifts the numbering; a combined-diff `@@@` header ends it with the
 *  numbers cleared. */
export function numberDiffLines(lines: string[]): DiffLine[] {
	const out: DiffLine[] = [];
	const c: HunkCounters = { oldNo: 0, newNo: 0, oldLeft: 0, newLeft: 0 };
	for (const line of lines) {
		const header =
			c.oldLeft === 0 && c.newLeft === 0 ? line.match(HUNK_HEADER) : null;
		if (header !== null) {
			c.oldNo = Number(header[1]);
			c.newNo = Number(header[3]);
			// Omitted count means one line: git writes `@@ -5 +5,2 @@`, not `@@ -5,1 +5,2 @@`.
			c.oldLeft = header[2] === undefined ? 1 : Number(header[2]);
			c.newLeft = header[4] === undefined ? 1 : Number(header[4]);
			out.push({ cls: "hunk", old: null, new: null, text: line });
			continue;
		}
		if (c.oldLeft > 0 || c.newLeft > 0) {
			pushHunkLine(out, line, c);
			continue;
		}
		out.push({ cls: diffLineClass(line), old: null, new: null, text: line });
	}
	return out;
}
