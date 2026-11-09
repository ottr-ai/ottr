/** Inline comments in a PR review draft (docs/specs/pr-reviews.md "Inline comments").
 *  The draft is one text; an inline comment is a marked block in it:
 *    <!-- inline <path>:<line> -->   or   <!-- inline <path>:<start>-<end> -->
 *    comment body (may hold a ```suggestion fence)
 *    <!-- /inline -->
 *  Pure module: the server and the UI bundle share it, so no Node imports. */

export interface InlineComment {
	path: string;
	/** RIGHT-side line; for a range the last line. */
	line: number;
	/** RIGHT-side first line of a range, null for one line. */
	startLine: number | null;
	body: string;
}

export interface ParsedReview {
	body: string;
	comments: InlineComment[];
}

const OPEN = /^<!-- inline (.+):(\d+)(?:-(\d+))? -->$/s;
const CLOSE = "<!-- /inline -->";
const MAX_PATH = 1000;

function lineNumber(digits: string): number | null {
	const n = Number(digits);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The marker of a valid open line, else null. */
function openMarker(line: string): Omit<InlineComment, "body"> | null {
	const m = OPEN.exec(line.trim());
	if (!m) return null;
	const [, path = "", a = "", b] = m;
	if (path.trim() === "" || path.length > MAX_PATH || /[\r\n]/.test(path))
		return null;
	const first = lineNumber(a);
	if (first === null) return null;
	if (b === undefined) return { path, line: first, startLine: null };
	const last = lineNumber(b);
	if (last === null || first >= last) return null;
	return { path, line: last, startLine: first };
}

function normalizeBody(lines: readonly string[]): string {
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Splits a draft into the review body and the inline comments. A block with a bad
 *  marker or no close marker stays in the body as plain text; a block with an empty
 *  body is dropped. Total: never throws. */
export function parseReviewDraft(text: string): ParsedReview {
	const body: string[] = [];
	const comments: InlineComment[] = [];
	// The open block: its marker and its raw lines (marker included).
	let open: { marker: Omit<InlineComment, "body">; raw: string[] } | null =
		null;
	for (const line of text.split(/\r\n|\r|\n/)) {
		const marker = openMarker(line);
		if (marker) {
			if (open) body.push(...open.raw);
			open = { marker, raw: [line] };
		} else if (open && line.trim() === CLOSE) {
			const content = open.raw.slice(1).join("\n").trim();
			if (content !== "") comments.push({ ...open.marker, body: content });
			open = null;
		} else if (open) open.raw.push(line);
		else body.push(line);
	}
	if (open) body.push(...open.raw);
	return { body: normalizeBody(body), comments };
}

function location(c: Pick<InlineComment, "path" | "line" | "startLine">) {
	return c.startLine === null
		? `${c.path}:${c.line}`
		: `${c.path}:${c.startLine}-${c.line}`;
}

/** The marker block of one comment, without a trailing newline. */
export function formatInlineComment(c: InlineComment): string {
	return `<!-- inline ${location(c)} -->\n${c.body}\n${CLOSE}`;
}

/** Commentable RIGHT-side lines per path: line → hunk index (unique across the diff). */
function commentableLines(diff: string): Map<string, Map<number, number>> {
	const files = new Map<string, Map<number, number>>();
	let lines: Map<number, number> | null = null;
	let hunk = -1;
	let right = 0;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (oldLeft > 0 || newLeft > 0) {
			const kind = line[0];
			if (kind === "\\") continue;
			if (kind === " " || kind === undefined) {
				lines?.set(right, hunk);
				right++;
				oldLeft--;
				newLeft--;
				continue;
			}
			if (kind === "+") {
				lines?.set(right, hunk);
				right++;
				newLeft--;
				continue;
			}
			if (kind === "-") {
				oldLeft--;
				continue;
			}
			oldLeft = 0;
			newLeft = 0;
		}
		if (line.startsWith("diff --git ")) lines = null;
		else if (line.startsWith("+++ ")) {
			const target = line.slice(4);
			if (target.startsWith("b/")) {
				const path = target.slice(2);
				lines = files.get(path) ?? new Map();
				files.set(path, lines);
			} else lines = null;
		} else {
			const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (m) {
				hunk++;
				oldLeft = m[1] === undefined ? 1 : Number(m[1]);
				right = Number(m[2]);
				newLeft = m[3] === undefined ? 1 : Number(m[3]);
			}
		}
	}
	return files;
}

/** Wraps a line in backticks when it would read as a marker, so stray marker lines in
 *  the body (from a broken block) cannot pair up into a block on the next parse. */
function defuse(line: string): string {
	return openMarker(line) || line.trim() === CLOSE
		? `\`${line.trim()}\``
		: line;
}

/** Keeps each inline comment that GitHub accepts on `diff` (an added or context line,
 *  a range inside one hunk) and moves the others into the body as `**`path:line`**`
 *  plus their text. `moved` counts the moved comments. */
export function fitDraftToDiff(
	draft: string,
	diff: string,
): { text: string; moved: number } {
	const parsed = parseReviewDraft(draft);
	const files = commentableLines(diff);
	const kept: InlineComment[] = [];
	const movedParts: string[] = [];
	for (const c of parsed.comments) {
		const lines = files.get(c.path);
		const hunk = lines?.get(c.line);
		const fits =
			hunk !== undefined &&
			(c.startLine === null || lines?.get(c.startLine) === hunk);
		if (fits) kept.push(c);
		else movedParts.push(`**\`${location(c)}\`**\n\n${c.body}`);
	}
	const body = normalizeBody([
		...parsed.body.split("\n").map(defuse),
		...movedParts.flatMap((part) => ["", part]),
	]);
	const text = [body, ...kept.map(formatInlineComment)]
		.filter((part) => part !== "")
		.join("\n\n");
	return { text, moved: movedParts.length };
}

/** One entry of a GitHub review's `comments`, on the new file (RIGHT side). */
interface ReviewCommentPayload {
	path: string;
	line: number;
	side: "RIGHT";
	body: string;
	start_line?: number;
	start_side?: "RIGHT";
}

/** GitHub review `comments` entries for the reviews endpoint. */
export function reviewPayloadComments(
	comments: InlineComment[],
): ReviewCommentPayload[] {
	return comments.map((c): ReviewCommentPayload => {
		const entry: ReviewCommentPayload = {
			path: c.path,
			line: c.line,
			side: "RIGHT",
			body: c.body,
		};
		if (c.startLine === null) return entry;
		return { ...entry, start_line: c.startLine, start_side: "RIGHT" };
	});
}
