// Pure readers of omp's JSONL transcripts, tested directly against temp dirs —
// no store fixture (SQLite, WAL, instance lock) needed.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	firstSessionTitle,
	sessionContext,
	sessionFile,
	sessionHoldsPrompt,
} from "./session.ts";

const root = mkdtempSync(join(tmpdir(), "session-parser-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
const dir = (name: string) => {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	return d;
};

/** omp's layout: line 1 = latest title (rewritten in place), body = appended title_change history. */
const session = (dir: string, sid: string, titles: string[], extra = "") =>
	writeFileSync(
		join(dir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
		`{"type":"title","v":1,"title":"${titles.at(-1) ?? ""}"}\n{"type":"session"}\n${extra}` +
			titles
				.map(
					(t) => `{"type":"title_change","title":"${t}"}\n{"type":"message"}\n`,
				)
				.join(""),
	);

describe("sessionFile", () => {
	test("finds `<ts>_<sessionId>.jsonl`; null id, unknown id, and missing dir give null", () => {
		const d = dir("lookup");
		writeFileSync(
			join(
				d,
				"2026-09-27T10-00-00-000Z_11110000-0000-0000-0000-000000000001.jsonl",
			),
			"{}\n",
		);
		expect(sessionFile(d, "11110000-0000-0000-0000-000000000001")).toBe(
			join(
				d,
				"2026-09-27T10-00-00-000Z_11110000-0000-0000-0000-000000000001.jsonl",
			),
		);
		expect(sessionFile(d, null)).toBe(null);
		expect(sessionFile(d, "11110000-0000-0000-0000-0000000000ff")).toBe(null);
		expect(
			sessionFile(
				join(root, "no-such-dir"),
				"11110000-0000-0000-0000-000000000001",
			),
		).toBe(null); // missing sessions dir
	});
});

describe("sessionHoldsPrompt", () => {
	const sid = "11110000-0000-0000-0000-000000000002";
	test("matches string and text-part user messages; ignores other roles and missing files", () => {
		const d = dir("holds");
		const prompt = "line one\nline two";
		const padded = `prefix\n${prompt}`;
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"message","message":{"role":"assistant","content":"line one\\nline two"}}\n' +
				`{"type":"message","message":{"role":"user","content":${JSON.stringify(padded)}}}\n` +
				`{"type":"message","message":{"role":"user","content":[${JSON.stringify({ type: "text", text: prompt })}]}}\n`,
		);
		expect(sessionHoldsPrompt(d, sid, prompt)).toBe(true);
		expect(sessionHoldsPrompt(d, sid, "no such text")).toBe(false);
		expect(sessionHoldsPrompt(root, sid, prompt)).toBe(false); // no file
		expect(sessionHoldsPrompt(root, null, prompt)).toBe(false);
	});
});

describe("firstSessionTitle", () => {
	test("reads the session's first title; null id and missing files give null", () => {
		const d = dir("titled");
		const sid = "0123abcd-0000-1111-2222-333344445555";
		writeFileSync(
			join(d, `2026-09-26T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"Fix the thing","updatedAt":"x","pad":"0000"}\n{"type":"session"}\n',
		);
		expect(firstSessionTitle(d, sid)).toBe("Fix the thing");
		expect(firstSessionTitle(d, "0123abcd-0000-1111-2222-33334444ffff")).toBe(
			null,
		); // no file
		expect(firstSessionTitle(d, null)).toBe(null);
	});

	test("an empty or whitespace-only session title is null", () => {
		const d = dir("untitled");
		const sid = "0123abcd-aaaa-bbbb-cccc-ddddeeeeffff";
		writeFileSync(
			join(d, `2026-09-26T10-00-01-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"","pad":"0"}\n',
		);
		const sid2 = "0123abcd-aaaa-bbbb-cccc-ddddeeeefff0";
		writeFileSync(
			join(d, `2026-09-26T10-00-02-000Z_${sid2}.jsonl`),
			'{"type":"title","v":1,"title":"   ","pad":"0"}\n',
		);
		expect(firstSessionTitle(d, sid)).toBe(null);
		expect(firstSessionTitle(d, sid2)).toBe(null);
	});

	test("skips blank and nested title_changes; the first real one beats line 1", () => {
		const d = dir("history");
		const sid = "aaaa0000-0000-0000-0000-000000000001";
		expect(firstSessionTitle(d, sid)).toBe(null); // no sessions files yet
		session(d, sid, []);
		expect(firstSessionTitle(d, sid)).toBe(null); // omp hasn't titled it yet

		// Another record type with its own title, carrying the needle in nested data, must be skipped.
		const nested = `{"type":"custom","title":"Not A Title","data":{"type":"title_change","title":"Nested"}}\n`;
		session(
			d,
			sid,
			["   ", "Add Task Priority Flag", "Rebase, Verify, and Merge Branch"],
			nested,
		); // a blank change is skipped
		expect(firstSessionTitle(d, sid)).toBe("Add Task Priority Flag");
	});

	test("rescans a grown session file whose mtime did not move (Windows ms ticks)", () => {
		const d = dir("retick");
		const sid = "dddd0000-0000-0000-0000-000000000001";
		const file = join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`);
		writeFileSync(
			file,
			'{"type":"title","v":1,"title":""}\n{"type":"session"}\n',
		);
		// Pin the mtime to a whole ms: the rewrite below then lands in the same tick, as on CI.
		const tick = new Date(1727424000000);
		utimesSync(file, tick, tick);
		expect(firstSessionTitle(d, sid)).toBe(null); // empty line-1 title
		writeFileSync(
			file,
			'{"type":"title","v":1,"title":"Real Title"}\n{"type":"session"}\n{"type":"title_change","title":"Real Title"}\n',
		);
		utimesSync(file, tick, tick);
		expect(firstSessionTitle(d, sid)).toBe("Real Title");
	});

	test("reads a title_change on the last line without a trailing newline", () => {
		const d = dir("eof");
		const sid = "cccc0000-0000-0000-0000-000000000001";
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			`{"type":"title","v":1,"title":"Latest"}\n{"type":"session"}\n{"type":"title_change","title":"Original"}`,
		);
		expect(firstSessionTitle(d, sid)).toBe("Original");
	});

	test("each session id resolves to its own file's title", () => {
		const d = dir("follow-up");
		const parent = "bbbb0000-0000-0000-0000-000000000001";
		const child = "bbbb0000-0000-0000-0000-000000000002";
		session(d, parent, ["Add Task Priority Flag"]);
		session(d, child, ["Show Priority On Cards"]);
		expect(firstSessionTitle(d, parent)).toBe("Add Task Priority Flag");
		expect(firstSessionTitle(d, child)).toBe("Show Priority On Cards");
	});
});

describe("sessionContext", () => {
	const msg = (tokens: number, epoch: number, completedAt: string) =>
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5.3-flash",
				timestamp: completedAt,
				completedAt,
				usage: {},
				contextSnapshot: {
					promptTokens: tokens,
					nonMessageTokens: 1,
					compactionEpoch: epoch,
				},
			},
		});

	test("returns the LAST assistant message's snapshot, skipping noise and model_usage", () => {
		const d = dir("ctx");
		const sid = "aaaa0000-0000-0000-0000-00000000000c";
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			`{"type":"session"}\n{"type":"model_usage","tokens":1}\n${msg(100, 0, "2026-09-27T10:00:01Z")}\nnot json\n${msg(200, 2, "2026-09-27T10:00:02Z")}\n`,
		);
		expect(sessionContext(d, sid)).toEqual({
			promptTokens: 200,
			model: "zai/glm-5.3-flash",
			compactions: 2,
			at: Date.parse("2026-09-27T10:00:02Z"),
		});
	});

	test("falls back to timestamp when completedAt is missing and tolerates unnamed models", () => {
		const d = dir("ctx-fallback");
		const sid = "aaaa0000-0000-0000-0000-00000000000f";
		const line = JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				provider: "",
				model: "glm-5.3-flash",
				timestamp: "2026-09-27T10:00:03Z",
				contextSnapshot: { promptTokens: 5 },
			},
		});
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			`${line}\n`,
		);
		expect(sessionContext(d, sid)).toEqual({
			promptTokens: 5,
			model: "glm-5.3-flash",
			compactions: 0,
			at: Date.parse("2026-09-27T10:00:03Z"),
		});
	});

	test("null for no file, no assistant messages, and null sessionId", () => {
		const d = dir("ctx-null");
		const sid = "aaaa0000-0000-0000-0000-00000000000n";
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"session"}\n{"type":"model_usage","tokens":1}\n',
		);
		expect(sessionContext(d, sid)).toBeNull(); // no assistant message
		expect(
			sessionContext(d, "bbbb0000-0000-0000-0000-00000000000n"),
		).toBeNull(); // no file
		expect(sessionContext(d, null)).toBeNull();
	});
});
