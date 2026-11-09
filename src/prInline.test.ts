import { describe, expect, test } from "bun:test";
import {
	fitDraftToDiff,
	formatInlineComment,
	type InlineComment,
	parseReviewDraft,
	reviewPayloadComments,
} from "./prInline.ts";
import fc from "./test/properties.ts";

const one = (path: string, line: number, body: string): InlineComment => ({
	path,
	line,
	startLine: null,
	body,
});

describe("parseReviewDraft", () => {
	test("splits the body from single-line and range blocks", () => {
		const text = [
			"Summary line.",
			"",
			"<!-- inline src/a.ts:12 -->",
			"Null check missing.",
			"<!-- /inline -->",
			"",
			"<!-- inline src/b.ts:3-7 -->",
			"Extract this loop.",
			"<!-- /inline -->",
			"",
			"Closing remark.",
		].join("\n");
		expect(parseReviewDraft(text)).toEqual({
			body: "Summary line.\n\nClosing remark.",
			comments: [
				one("src/a.ts", 12, "Null check missing."),
				{ path: "src/b.ts", line: 7, startLine: 3, body: "Extract this loop." },
			],
		});
	});

	test("keeps a suggestion fence in a comment verbatim", () => {
		const body =
			"Use the guard:\n```suggestion\n\tif (!x) return;\n  call(x);\n```";
		const text = `Top.\n\n<!-- inline a.ts:4-5 -->\n${body}\n<!-- /inline -->`;
		expect(parseReviewDraft(text).comments).toEqual([
			{ path: "a.ts", line: 5, startLine: 4, body },
		]);
	});

	test("matches marker lines after trimming and takes the last :N as the line", () => {
		const text = "  <!-- inline dir/x:y.ts:9 -->  \nNote\n\t<!-- /inline -->";
		expect(parseReviewDraft(text)).toEqual({
			body: "",
			comments: [one("dir/x:y.ts", 9, "Note")],
		});
	});

	test("an unclosed block stays in the body as plain text", () => {
		const text = "Body.\n<!-- inline a.ts:3 -->\nOpen finding.";
		expect(parseReviewDraft(text)).toEqual({ body: text, comments: [] });
	});

	test("a new open marker returns the earlier open block to the body", () => {
		const text = [
			"<!-- inline a.ts:1 -->",
			"Lost close.",
			"<!-- inline b.ts:2 -->",
			"Real one.",
			"<!-- /inline -->",
		].join("\n");
		expect(parseReviewDraft(text)).toEqual({
			body: "<!-- inline a.ts:1 -->\nLost close.",
			comments: [one("b.ts", 2, "Real one.")],
		});
	});

	test("a bad marker is plain text, also inside a block", () => {
		for (const marker of [
			"<!-- inline a.ts:0 -->",
			"<!-- inline a.ts:5-5 -->",
			"<!-- inline a.ts:6-5 -->",
			"<!-- inline a.ts:99999999999999999999 -->",
			"<!-- inline  :3 -->",
			"<!-- inline a.ts -->",
		]) {
			const text = `${marker}\nText\n<!-- /inline -->`;
			expect(parseReviewDraft(text)).toEqual({ body: text, comments: [] });
		}
		const path = "p".repeat(1001);
		const long = `<!-- inline ${path}:1 -->\nText\n<!-- /inline -->`;
		expect(parseReviewDraft(long).comments).toEqual([]);
		const inside =
			"<!-- inline a.ts:2 -->\n<!-- inline a.ts:0 -->\n<!-- /inline -->";
		expect(parseReviewDraft(inside).comments).toEqual([
			one("a.ts", 2, "<!-- inline a.ts:0 -->"),
		]);
	});

	test("a block with an empty body is dropped with its markers", () => {
		const text =
			"Body.\n\n<!-- inline a.ts:3 -->\n  \n\t\n<!-- /inline -->\n\nEnd.";
		expect(parseReviewDraft(text)).toEqual({
			body: "Body.\n\nEnd.",
			comments: [],
		});
	});

	test("reads CRLF and collapses blank runs in the body", () => {
		const text =
			"Top.\r\n\r\n\r\n\r\nMiddle.\r\n<!-- inline a.ts:3 -->\r\nFix.\r\nMore.\r\n<!-- /inline -->\r\n";
		expect(parseReviewDraft(text)).toEqual({
			body: "Top.\n\nMiddle.",
			comments: [one("a.ts", 3, "Fix.\nMore.")],
		});
	});
});

describe("formatInlineComment", () => {
	test("writes single-line and range markers", () => {
		expect(formatInlineComment(one("a.ts", 3, "x"))).toBe(
			"<!-- inline a.ts:3 -->\nx\n<!-- /inline -->",
		);
		expect(
			formatInlineComment({ path: "a.ts", line: 9, startLine: 2, body: "y" }),
		).toBe("<!-- inline a.ts:2-9 -->\ny\n<!-- /inline -->");
	});
});

// RIGHT side of src/a.ts: hunk 1 = lines 1-5 (2 and 3 added), hunk 2 = lines 21-23 (22 added).
// gone.ts is deleted, so it has no RIGHT lines.
const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,4 +1,5 @@ function top() {",
	" line1",
	"-old2",
	"+new2",
	"+new3",
	" line3",
	" line4",
	"@@ -20,3 +21,3 @@",
	" c20",
	"-d21",
	"\\ No newline at end of file",
	"+a22",
	" c22",
	"diff --git a/gone.ts b/gone.ts",
	"deleted file mode 100644",
	"--- a/gone.ts",
	"+++ /dev/null",
	"@@ -1,2 +0,0 @@",
	"-x",
	"-y",
	"",
].join("\n");

const block = (loc: string, body: string) =>
	`<!-- inline ${loc} -->\n${body}\n<!-- /inline -->`;

describe("fitDraftToDiff", () => {
	test("keeps comments on added and context lines and ranges inside one hunk", () => {
		const draft = [
			"Summary.",
			block("src/a.ts:2", "on added"),
			block("src/a.ts:1", "on context"),
			block("src/a.ts:2-5", "range in hunk 1"),
			block("src/a.ts:23", "context after a no-newline note"),
		].join("\n\n");
		expect(fitDraftToDiff(draft, DIFF)).toEqual({ text: draft, moved: 0 });
	});

	test("moves comments the diff does not show into the body with a label", () => {
		const draft = [
			"Summary.",
			block("gone.ts:1", "deleted file"),
			block("src/a.ts:10", "between hunks"),
			block("other.ts:1", "unknown path"),
			block("src/a.ts:4-22", "across hunks"),
			block("src/a.ts:22", "kept"),
		].join("\n\n");
		const fit = fitDraftToDiff(draft, DIFF);
		expect(fit.moved).toBe(4);
		expect(parseReviewDraft(fit.text)).toEqual({
			body: [
				"Summary.",
				"**`gone.ts:1`**\n\ndeleted file",
				"**`src/a.ts:10`**\n\nbetween hunks",
				"**`other.ts:1`**\n\nunknown path",
				"**`src/a.ts:4-22`**\n\nacross hunks",
			].join("\n\n"),
			comments: [one("src/a.ts", 22, "kept")],
		});
	});

	test("stray marker lines in the body cannot pair up into a block", () => {
		// The open marker of a.ts:1 loses its block to b.ts:2; the second close is stray.
		const draft = [
			"<!-- inline src/a.ts:1 -->",
			"Lost.",
			block("src/a.ts:2", "kept"),
			"<!-- /inline -->",
		].join("\n");
		const fit = fitDraftToDiff(draft, DIFF);
		expect(parseReviewDraft(fit.text).comments).toEqual([
			one("src/a.ts", 2, "kept"),
		]);
		expect(fitDraftToDiff(fit.text, DIFF)).toEqual({
			text: fit.text,
			moved: 0,
		});
	});
});

describe("reviewPayloadComments", () => {
	test("maps single lines and ranges to RIGHT-side GitHub comments", () => {
		expect(
			reviewPayloadComments([
				one("a.ts", 3, "x"),
				{ path: "b.ts", line: 9, startLine: 4, body: "y" },
			]),
		).toEqual([
			{ path: "a.ts", line: 3, side: "RIGHT", body: "x" },
			{
				path: "b.ts",
				line: 9,
				side: "RIGHT",
				body: "y",
				start_line: 4,
				start_side: "RIGHT",
			},
		]);
	});
});

// ---- properties ----

const PATHS = ["a.ts", "src/b.ts", "c d.ts"];

// Plain text that can never form a marker line (no letters of "inline", no "/").
const plainLine = fc.string({
	unit: fc.constantFrom("a", "b", " ", "\t", "`", "-", ":", "<", "!", "1", "#"),
	maxLength: 12,
});
/** Trimmed lines; a comment body keeps blank runs, the review body collapses them. */
const commentText = fc
	.array(plainLine, { minLength: 1, maxLength: 6 })
	.map((lines) => lines.join("\n").trim())
	.filter((b) => b !== "");
const bodyText = fc.array(plainLine, { maxLength: 6 }).map((lines) =>
	lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim(),
);

const commentArb: fc.Arbitrary<InlineComment> = fc
	.record({
		path: fc
			.string({
				unit: fc.constantFrom("a", "/", ".", ":", "-", " ", "1", "é"),
				minLength: 1,
				maxLength: 20,
			})
			.filter((p) => p.trim() !== ""),
		start: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
		span: fc.integer({ min: 1, max: 50 }),
		body: commentText,
	})
	.map(({ path, start, span, body }) =>
		start === null
			? { path, line: span, startLine: null, body }
			: { path, line: start + span, startLine: start, body },
	);

// Draft lines mixing text, valid and bad markers, close markers and fences.
const draftLine = fc.oneof(
	plainLine,
	fc.constantFrom(
		"",
		"```suggestion",
		"```",
		"<!-- /inline -->",
		"<!-- inline a.ts:0 -->",
	),
	fc
		.record({
			path: fc.constantFrom(...PATHS, "unknown.ts"),
			line: fc.integer({ min: 1, max: 30 }),
			span: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
		})
		.map(({ path, line, span }) =>
			span === null
				? `<!-- inline ${path}:${line} -->`
				: `<!-- inline ${path}:${line}-${line + span} -->`,
		),
);
const draftArb = fc
	.tuple(fc.array(draftLine, { maxLength: 30 }), fc.constantFrom("\n", "\r\n"))
	.map(([lines, eol]) => lines.join(eol));

type Op = " " | "+" | "-";
interface FileSpec {
	path: string;
	hunks: { gap: number; ops: Op[] }[];
}
const diffArb = fc.array(
	fc.record({
		path: fc.constantFrom(...PATHS),
		hunks: fc.array(
			fc.record({
				gap: fc.integer({ min: 0, max: 4 }),
				ops: fc.array(fc.constantFrom<Op>(" ", "+", "-"), {
					minLength: 1,
					maxLength: 8,
				}),
			}),
			{ minLength: 1, maxLength: 3 },
		),
	}),
	{ maxLength: 3 },
);

/** Renders the files as a git diff and returns the reference set of commentable
 *  RIGHT lines as "path:line" → hunk id. */
function renderDiff(files: FileSpec[]): {
	diff: string;
	ref: Map<string, string>;
} {
	const out: string[] = [];
	const ref = new Map<string, string>();
	for (const [f, file] of files.entries()) {
		out.push(
			`diff --git a/${file.path} b/${file.path}`,
			`--- a/${file.path}`,
			`+++ b/${file.path}`,
		);
		let oldLine = 1;
		let newLine = 1;
		for (const [h, { gap, ops }] of file.hunks.entries()) {
			oldLine += gap;
			newLine += gap;
			const oldCount = ops.filter((op) => op !== "+").length;
			const newCount = ops.filter((op) => op !== "-").length;
			out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
			let right = newLine;
			for (const op of ops) {
				// "+" renders "+++ b/<path>": a hunk line that reads like a file header.
				out.push(`${op}++ b/${file.path}`);
				if (op !== "-") ref.set(`${file.path}:${right++}`, `${f}.${h}`);
			}
			oldLine += oldCount;
			newLine += newCount;
		}
	}
	return { diff: out.join("\n"), ref };
}

function fitsRef(c: InlineComment, ref: Map<string, string>): boolean {
	const hunk = ref.get(`${c.path}:${c.line}`);
	if (hunk === undefined) return false;
	return c.startLine === null || ref.get(`${c.path}:${c.startLine}`) === hunk;
}

describe("prInline properties", () => {
	test("parseReviewDraft and fitDraftToDiff never throw", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string({ unit: "binary" }), draftArb),
				fc.string({ unit: "binary" }),
				(draft, diff) => {
					parseReviewDraft(draft);
					fitDraftToDiff(draft, diff);
				},
			),
		);
	});

	test("a body plus formatted blocks parses back to the same body and comments", () => {
		fc.assert(
			fc.property(
				bodyText,
				fc.array(commentArb, { maxLength: 4 }),
				fc.boolean(),
				(body, comments, crlf) => {
					const joined = [body, ...comments.map(formatInlineComment)].join(
						"\n\n",
					);
					const draft = crlf ? joined.replaceAll("\n", "\r\n") : joined;
					expect(parseReviewDraft(draft)).toEqual({ body, comments });
				},
			),
		);
	});

	test("fitDraftToDiff keeps exactly the fitting comments and is idempotent", () => {
		fc.assert(
			fc.property(draftArb, diffArb, (draft, files) => {
				const { diff, ref } = renderDiff(files);
				const before = parseReviewDraft(draft).comments;
				const fit = fitDraftToDiff(draft, diff);
				const after = parseReviewDraft(fit.text).comments;
				expect(after).toEqual(before.filter((c) => fitsRef(c, ref)));
				expect(fit.moved).toBe(before.length - after.length);
				expect(fitDraftToDiff(fit.text, diff)).toEqual({
					text: fit.text,
					moved: 0,
				});
			}),
		);
	});
});
