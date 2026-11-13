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

/** The open block: its marker and its raw lines (marker included). */
interface OpenBlock {
	marker: Omit<InlineComment, "body">;
	raw: string[];
}

/** Classifies one draft line: opens, closes, extends the open block, or stays plain body text. */
function scanDraftLine(
	body: string[],
	comments: InlineComment[],
	open: OpenBlock | null,
	line: string,
): OpenBlock | null {
	const marker = openMarker(line);
	if (marker) {
		if (open) body.push(...open.raw);
		return { marker, raw: [line] };
	}
	if (open === null) {
		body.push(line);
		return null;
	}
	if (line.trim() === CLOSE) {
		const content = open.raw.slice(1).join("\n").trim();
		if (content !== "") comments.push({ ...open.marker, body: content });
		return null;
	}
	open.raw.push(line);
	return open;
}

/** Splits a draft into the review body and the inline comments. A block with a bad
 *  marker or no close marker stays in the body as plain text; a block with an empty
 *  body is dropped. Total: never throws. */
export function parseReviewDraft(text: string): ParsedReview {
	const body: string[] = [];
	const comments: InlineComment[] = [];
	let open: OpenBlock | null = null;
	for (const line of text.split(/\r\n|\r|\n/))
		open = scanDraftLine(body, comments, open, line);
	if (open) body.push(...open.raw);
	return { body: normalizeBody(body), comments };
}

/** The model's machine-readable verdict for the review body (docs/specs/pr-reviews.md "Post").
 *  A verdict line is a whole plain line — outside every inline block — whose trimmed text is
 *  exactly `<!-- blocking: yes -->` or `<!-- blocking: no -->`; matching is strict lowercase
 *  after trim, and a line inside a closed marked block is comment content that never votes.
 *  The verdict is honored only when exactly one plain verdict line exists and it is the
 *  review's last non-blank line. A scan that ends inside a block fails safe: parseReviewDraft
 *  keeps an unclosed block's lines as plain body text, so plant lines can hide behind a
 *  broken opener. Anything else (none, a second candidate, content after the verdict) is a
 *  contradiction and fails safe to blocking. Every plain verdict line comes out of the text;
 *  block bodies and all other lines stay byte-identical. */
export function parseBlockingVerdict(text: string): {
	text: string;
	blocking: boolean;
} {
	const lines = text.split(/\r\n|\r|\n/);
	// A line inside a closed marked block is comment content: a PR line quoted there
	// keeps its text and never votes.
	let open = false;
	const votes: number[] = [];
	// The last non-blank line of the whole text, block content included: any content
	// after the verdict fails safe.
	let lastLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const t = line.trim();
		if (t !== "") lastLine = i;
		if (!open && openMarker(line) !== null) {
			open = true;
			continue;
		}
		if (open) {
			if (t === CLOSE) open = false;
			continue;
		}
		if (t === "<!-- blocking: yes -->" || t === "<!-- blocking: no -->")
			votes.push(i);
	}
	const strip = () => {
		for (let i = votes.length - 1; i >= 0; i--) lines.splice(votes[i]!, 1);
	};
	// Fail safe when the scan ends inside a block: parseReviewDraft keeps an unclosed
	// block's lines as plain body text, so plant lines after a broken opener must not
	// hide from the vote or from the content rule. Zero verdicts, a second candidate,
	// or content after the verdict fails safe too. Stripping the plain marker lines
	// keeps the draft clean.
	if (open || votes.length !== 1 || votes[0] !== lastLine) {
		strip();
		return { text: lines.join("\n"), blocking: true };
	}
	const blocking = lines[votes[0]!]!.trim() !== "<!-- blocking: no -->";
	strip();
	return { text: lines.join("\n"), blocking };
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

/** Mutable cursor over one parsed diff walk. */
interface DiffState {
	files: Map<string, Map<number, number>>;
	/** The current file's commentable lines, null outside a `b/` file. */
	lines: Map<number, number> | null;
	hunk: number;
	/** The next RIGHT-side line number the diff prints. */
	right: number;
	/** Lines left in the hunk on the old and the new side. */
	oldLeft: number;
	newLeft: number;
}

/** One hunk-body line: counts it down and maps commentable RIGHT lines. True when consumed. */
function hunkLine(state: DiffState, line: string): boolean {
	if (state.oldLeft > 0 || state.newLeft > 0) {
		const kind = line[0];
		if (kind === "\\") return true;
		if (kind === " " || kind === undefined) {
			state.lines?.set(state.right, state.hunk);
			state.right++;
			state.oldLeft--;
			state.newLeft--;
			return true;
		}
		if (kind === "+") {
			state.lines?.set(state.right, state.hunk);
			state.right++;
			state.newLeft--;
			return true;
		}
		if (kind === "-") {
			state.oldLeft--;
			return true;
		}
		state.oldLeft = 0;
		state.newLeft = 0;
	}
	return false;
}

/** One file or hunk header line: switches the current file or starts the next hunk. */
function headerLine(state: DiffState, line: string): void {
	if (line.startsWith("diff --git ")) state.lines = null;
	else if (line.startsWith("+++ ")) {
		const target = line.slice(4);
		if (target.startsWith("b/")) {
			const path = target.slice(2);
			state.lines = state.files.get(path) ?? new Map();
			state.files.set(path, state.lines);
		} else state.lines = null;
	} else {
		const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (m) {
			state.hunk++;
			state.oldLeft = m[1] === undefined ? 1 : Number(m[1]);
			state.right = Number(m[2]);
			state.newLeft = m[3] === undefined ? 1 : Number(m[3]);
		}
	}
}

/** Commentable RIGHT-side lines per path: line → hunk index (unique across the diff). */
function commentableLines(diff: string): Map<string, Map<number, number>> {
	const state: DiffState = {
		files: new Map(),
		lines: null,
		hunk: -1,
		right: 0,
		oldLeft: 0,
		newLeft: 0,
	};
	for (const line of diff.split(/\r?\n/)) {
		if (!hunkLine(state, line)) headerLine(state, line);
	}
	return state.files;
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
