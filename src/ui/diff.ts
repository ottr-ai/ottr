/** Client-side slicing and line classification for unified git diffs. */

/** A question's diff link `[label](diff:a.ts,b.ts)`: opens those files' diff sections. */
export type DiffLinkPart =
	| { kind: "text"; text: string }
	| { kind: "link"; label: string; files: string[] };

const DIFF_LINK_RE = /\[([^\]\n]*)\]\((diff:[^()\s]+)\)/g;

/** Splits question text into plain runs and diff links; text outside links stays literal
 *  (a `diff:` href without paths degrades to plain text too). */
export function diffLinkParts(text: string): DiffLinkPart[] {
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

/** One file's section of a unified diff, from its `diff --git` line to the next; null when the
 *  file has no section (also the answer for a diff truncated before this file's section). */
export function diffFileSlice(text: string, file: string): string | null {
	const lines = text.split("\n");
	const wanted = statNames(file);
	const heads: number[] = [];
	for (const [i, line] of lines.entries()) {
		if (line.startsWith("diff --git ")) heads.push(i);
	}
	for (const [n, start] of heads.entries()) {
		const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
		const section = lines.slice(start, end).join("\n");
		if (sectionNames(section).some((name) => wanted.includes(name))) {
			return section;
		}
	}
	return null;
}
