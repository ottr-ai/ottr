/** Client-side slicing and line classification for unified git diffs. */

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

/** Splits a unified diff into one section per file, in file order. Text without any `diff --git ` line yields []. */
export function splitDiffSections(text: string): DiffSection[] {
	const lines = text.split("\n");
	const heads: number[] = [];
	for (const [i, line] of lines.entries()) {
		if (line.startsWith("diff --git ")) heads.push(i);
	}
	const sections: DiffSection[] = [];
	for (const [n, start] of heads.entries()) {
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
		sections.push({ path, names, lines: sectionLines });
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

/** Adds old/new line numbers to one file section's lines by walking its `@@` hunk headers.
 *  Inside a hunk the class comes from the prefix character alone: body text may itself read
 *  as a header (`--- ` from a removed SQL or Lua comment, `+++ ` from an added one), which
 *  the whole-diff classifier would misfile as meta. The header's counts end the hunk, so
 *  nothing after it shifts the numbering; a combined-diff `@@@` header ends it with the
 *  numbers cleared. */
export function numberDiffLines(lines: string[]): DiffLine[] {
	const out: DiffLine[] = [];
	let oldNo = 0;
	let newNo = 0;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of lines) {
		const header =
			oldLeft === 0 && newLeft === 0 ? line.match(HUNK_HEADER) : null;
		if (header !== null) {
			oldNo = Number(header[1]);
			newNo = Number(header[3]);
			// Omitted count means one line: git writes `@@ -5 +5,2 @@`, not `@@ -5,1 +5,2 @@`.
			oldLeft = header[2] === undefined ? 1 : Number(header[2]);
			newLeft = header[4] === undefined ? 1 : Number(header[4]);
			out.push({ cls: "hunk", old: null, new: null, text: line });
			continue;
		}
		if (oldLeft > 0 || newLeft > 0) {
			if (line.startsWith("@@")) {
				oldLeft = 0;
				newLeft = 0;
				out.push({ cls: "hunk", old: null, new: null, text: line });
				continue;
			}
			const first = line.charAt(0);
			if (first === "+") {
				newLeft--;
				out.push({ cls: "add", old: null, new: newNo++, text: line });
				continue;
			}
			if (first === "-") {
				oldLeft--;
				out.push({ cls: "del", old: oldNo++, new: null, text: line });
				continue;
			}
			if (first === "\\") {
				// The no-newline marker belongs to the previous line: no numbers, no advance.
				out.push({ cls: "ctx", old: null, new: null, text: line });
				continue;
			}
			oldLeft--;
			newLeft--;
			out.push({ cls: "ctx", old: oldNo++, new: newNo++, text: line });
			continue;
		}
		out.push({ cls: diffLineClass(line), old: null, new: null, text: line });
	}
	return out;
}
