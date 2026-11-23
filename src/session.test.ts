// Pure readers of omp's JSONL transcripts, tested directly against temp dirs —
// no store fixture (SQLite, WAL, instance lock) needed.
import { afterAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanTitle,
	firstSessionTitle,
	firstWorkTitle,
	readTranscript,
	sessionContext,
	sessionFile,
	sessionHoldsPrompt,
	sessionModel,
	TRANSCRIPT_MAX_BYTES,
	TRANSCRIPT_MAX_SUB_FILES,
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

describe("sessionModel", () => {
	const sid = "11110000-0000-0000-0000-000000000003";
	const model = (name: string, extra: Record<string, unknown> = {}) =>
		`${JSON.stringify({ type: "model_change", model: name, ...extra })}\n`;

	test("takes the last plain or default-role record; skips fallback and temporary switches", () => {
		const d = dir("model");
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			model("zai/glm-5.3-flash") +
				model("zai/glm-5.3-air", { role: "temporary" }) +
				model("anthropic/claude-haiku-4-5", {
					role: "fallback",
					resolvedModelIsFallback: true,
				}),
		);
		expect(sessionModel(d, sid)).toBe("zai/glm-5.3-flash");
	});

	test("a default-role record after a fallback record counts", () => {
		const d = dir("model-default");
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			model("zai/glm-5.3-flash", { role: "fallback" }) +
				model("zai/glm-5.3-flash", { role: "default" }),
		);
		expect(sessionModel(d, sid)).toBe("zai/glm-5.3-flash");
	});

	test("no model_change record, null id, or missing file gives null", () => {
		const d = dir("model-empty");
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"session"}\n{"type":"message"}\n',
		);
		expect(sessionModel(d, sid)).toBe(null);
		expect(sessionModel(d, null)).toBe(null);
		expect(sessionModel(root, sid)).toBe(null); // missing sessions dir
	});
});

describe("sessionHoldsPrompt", () => {
	const sid = "11110000-0000-0000-0000-000000000002";
	test("matches string and text-part user messages; ignores other roles and missing files", async () => {
		const d = dir("holds");
		const prompt = "line one\nline two";
		const padded = `prefix\n${prompt}`;
		writeFileSync(
			join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"message","message":{"role":"assistant","content":"line one\\nline two"}}\n' +
				`{"type":"message","message":{"role":"user","content":${JSON.stringify(padded)}}}\n` +
				`{"type":"message","message":{"role":"user","content":[${JSON.stringify({ type: "text", text: prompt })}]}}\n`,
		);
		expect(await sessionHoldsPrompt(d, sid, prompt)).toBe(true);
		expect(await sessionHoldsPrompt(d, sid, "no such text")).toBe(false);
		expect(await sessionHoldsPrompt(root, sid, prompt)).toBe(false); // no file
		expect(await sessionHoldsPrompt(root, null, prompt)).toBe(false);
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

	test("firstWorkTitle stays linear on a 1 MiB needle-dense line with no rename", () => {
		const d = dir("needle-dense");
		const sid = "eeee0000-0000-0000-0000-000000000001";
		const file = join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`);
		// One line, every needle in nested data (OTTR-1027): parsing per occurrence
		// reparses the whole line for every hit and goes quadratic on exactly this shape.
		const item = '{"type":"title_change","title":"Nested"}';
		const dense = `{"type":"custom","items":[${(item + ",").repeat(Math.ceil((1024 * 1024) / (item.length + 1)))}0]}`;
		expect(dense.includes("\n")).toBe(false);
		expect(dense.length).toBeGreaterThan(1024 * 1024);
		writeFileSync(file, `${dense}\n`);
		const start = performance.now();
		expect(firstWorkTitle(d, sid, "")).toBe(null); // only nested needles -> no rename
		expect(performance.now() - start).toBeLessThan(200);
		// A rename appended after the dense line still wins, and the scan reruns on growth.
		appendFileSync(file, '{"type":"title_change","title":"Real Rename"}\n');
		expect(firstWorkTitle(d, sid, "")).toBe("Real Rename");
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

describe("cleanTitle", () => {
	test("strips Markdown a titler model echoes; mid-title marks and plain titles stay", () => {
		expect(cleanTitle("**Task Name: OTTR-292**")).toBe("Task Name: OTTR-292");
		expect(cleanTitle("## Set up agent rules")).toBe("Set up agent rules");
		expect(cleanTitle("__Ship the fix__")).toBe("Ship the fix");
		expect(cleanTitle("`Fix` the gate")).toBe("Fix` the gate"); // leading backtick only
		// Mid-title marks are real code (`__init__`, `*args`): never stripped.
		expect(cleanTitle("Fix __init__ override")).toBe("Fix __init__ override");
		expect(cleanTitle("Handle *args forwarding")).toBe(
			"Handle *args forwarding",
		);
		expect(cleanTitle("  spaced   out  ")).toBe("spaced out");
		expect(cleanTitle("Plain title")).toBe("Plain title");
	});

	test("strips omp's card prefix when an icon heads the upper-case tag", () => {
		expect(
			cleanTitle("🩻 SKELE: Add loading skeletons to task drawer sections"),
		).toBe("Add loading skeletons to task drawer sections");
		expect(
			cleanTitle("🔌 FRAME: Close Progress Relay Socket on Frame Errors"),
		).toBe("Close Progress Relay Socket on Frame Errors");
		// The prefix match stops at the head: the inner "CI" in the remainder stays.
		expect(cleanTitle("✅ CI: Fix CI failure and merge the fix")).toBe(
			"Fix CI failure and merge the fix",
		);
		expect(cleanTitle("🃏 BOARD: Check board cards and dirty checkouts")).toBe(
			"Check board cards and dirty checkouts",
		);
	});

	test("keeps titles without a card head: no icon, or no upper-case tag with colon", () => {
		// No icon: a plain title keeps its tag, even upper-case before a colon.
		expect(cleanTitle("CI: fix flaky test")).toBe("CI: fix flaky test");
		// No upper-case tag + colon: nothing to strip, not even a lone leading icon.
		expect(cleanTitle("Add HTTP/2 support")).toBe("Add HTTP/2 support");
		expect(cleanTitle("🩻 Add loading skeletons")).toBe(
			"🩻 Add loading skeletons",
		);
	});
});

describe("readTranscript", () => {
	const sid = "88880000-0000-0000-0000-000000000001";
	const mainFile = (d: string) =>
		join(d, `2026-09-27T10-00-00-000Z_${sid}.jsonl`);
	const subDir = (d: string) => join(d, `2026-09-27T10-00-00-000Z_${sid}`);

	test("reads the main transcript and its small subagent files", async () => {
		const d = dir("transcript-baseline");
		const s = subDir(d);
		session(d, sid, ["Add Task Priority Flag"]);
		mkdirSync(s, { recursive: true });
		writeFileSync(join(s, "agent-a.jsonl"), '{"type":"session"}\n');
		writeFileSync(join(s, "agent-b.jsonl"), '{"type":"session"}\n');
		const texts = await readTranscript(d, sid);
		expect(texts.complete).toBe(true);
		expect(texts.oversize).toBe(false);
		expect(texts.sessionText).toContain("Add Task Priority Flag");
		expect(texts.subagentTexts).toEqual([
			'{"type":"session"}\n',
			'{"type":"session"}\n',
		]);
		// A null id still reads as "nothing there", never as a refusal.
		expect(await readTranscript(d, null)).toEqual({
			sessionText: null,
			subagentTexts: [],
			complete: true,
			oversize: false,
		});
	});

	test("an over-cap main transcript is refused unread", async () => {
		const d = dir("transcript-main-cap");
		session(d, sid, ["Add Task Priority Flag"]);
		truncateSync(mainFile(d), TRANSCRIPT_MAX_BYTES + 1);
		expect(await readTranscript(d, sid)).toEqual({
			sessionText: null,
			subagentTexts: [],
			complete: false,
			oversize: true,
		});
	});

	test("an over-cap subagent transcript is refused unread; the main text stays", async () => {
		const d = dir("transcript-sub-cap");
		const s = subDir(d);
		session(d, sid, ["Add Task Priority Flag"]);
		mkdirSync(s, { recursive: true });
		const big = join(s, "agent-big.jsonl");
		writeFileSync(big, '{"type":"session"}\n');
		writeFileSync(join(s, "agent-ok.jsonl"), '{"type":"session"}\n');
		truncateSync(big, TRANSCRIPT_MAX_BYTES + 1);
		const texts = await readTranscript(d, sid);
		expect(texts.sessionText).toContain("Add Task Priority Flag");
		expect(texts.complete).toBe(false);
		expect(texts.oversize).toBe(true);
	});

	test("more subagent transcripts than the count cap reads none of them", async () => {
		const d = dir("transcript-count-cap");
		const s = subDir(d);
		session(d, sid, ["Add Task Priority Flag"]);
		mkdirSync(s, { recursive: true });
		for (let i = 0; i < TRANSCRIPT_MAX_SUB_FILES + 1; i++) {
			writeFileSync(join(s, `agent-${i}.jsonl`), '{"type":"session"}\n');
		}
		const texts = await readTranscript(d, sid);
		expect(texts.sessionText).toContain("Add Task Priority Flag");
		expect(texts.subagentTexts).toHaveLength(0);
		expect(texts.complete).toBe(false);
		expect(texts.oversize).toBe(true);
	});

	test("over-cap subagent bytes stop the reads", async () => {
		const d = dir("transcript-total-cap");
		const s = subDir(d);
		session(d, sid, ["Add Task Priority Flag"]);
		mkdirSync(s, { recursive: true });
		for (let i = 0; i < 5; i++) {
			// Sparse files of 63 MiB each: every one is under the per-file cap, so only
			// the total budget stops the reads (4 read = 252 MiB, the 5th refused).
			const f = join(s, `agent-${i}.jsonl`);
			writeFileSync(f, '{"type":"session"}\n');
			truncateSync(f, 63 * 1024 * 1024);
		}
		const texts = await readTranscript(d, sid);
		expect(texts.sessionText).toContain("Add Task Priority Flag");
		expect(texts.complete).toBe(false);
		expect(texts.oversize).toBe(true);
	});

	test("non-.jsonl siblings are ignored; a missing subagent folder is complete", async () => {
		const d = dir("transcript-plain");
		session(d, sid, ["Add Task Priority Flag"]); // no sibling folder
		const plain = await readTranscript(d, sid);
		expect(plain.complete).toBe(true);
		expect(plain.oversize).toBe(false);
		expect(plain.subagentTexts).toHaveLength(0);

		const d2 = dir("transcript-stray");
		session(d2, sid, ["Show Priority On Cards"]);
		mkdirSync(subDir(d2), { recursive: true });
		writeFileSync(join(subDir(d2), "notes.txt"), "not a transcript\n");
		const stray = await readTranscript(d2, sid);
		expect(stray.complete).toBe(true);
		expect(stray.oversize).toBe(false);
		expect(stray.subagentTexts).toHaveLength(0);
	});

	test.skipIf(process.platform !== "linux")(
		"a planted symlink is refused, not followed",
		async () => {
			const d = dir("transcript-symlink-main");
			session(d, sid, ["Add Task Priority Flag"]);
			const planted = mainFile(dir("transcript-symlink-main-target"));
			writeFileSync(planted, '{"type":"title","v":1,"title":"Other"}\n');
			const real = mainFile(d);
			rmSync(real);
			symlinkSync(planted, real);
			expect(await readTranscript(d, sid)).toEqual({
				sessionText: null,
				subagentTexts: [],
				complete: false,
				oversize: false,
			});

			const d2 = dir("transcript-symlink-sub");
			const s2 = subDir(d2);
			session(d2, sid, ["Add Task Priority Flag"]);
			mkdirSync(s2, { recursive: true });
			const good = join(s2, "agent-good.jsonl");
			writeFileSync(good, '{"type":"session"}\n');
			const outside = join(root, "session-parser-outside.jsonl");
			writeFileSync(outside, '{"type":"secret"}\n');
			symlinkSync(outside, join(s2, "agent-link.jsonl"));
			const texts = await readTranscript(d2, sid);
			expect(texts.sessionText).toContain("Add Task Priority Flag");
			expect(texts.subagentTexts).toEqual(['{"type":"session"}\n']);
			expect(texts.complete).toBe(false);
			expect(texts.oversize).toBe(false);
		},
	);

	test("the other whole-file readers refuse an over-cap transcript gracefully", () => {
		const d = dir("transcript-overcap-readers");
		session(d, sid, ["Add Task Priority Flag"]);
		truncateSync(mainFile(d), TRANSCRIPT_MAX_BYTES + 1);
		expect(sessionModel(d, sid)).toBeNull();
	});

	test("sessionHoldsPrompt on an over-cap transcript is false", async () => {
		const d = dir("transcript-overcap-prompt");
		session(d, sid, ["Add Task Priority Flag"]);
		truncateSync(mainFile(d), TRANSCRIPT_MAX_BYTES + 1);
		expect(await sessionHoldsPrompt(d, sid, "Add Task Priority Flag")).toBe(
			false,
		);
	});

	test("firstSessionTitle on an over-cap transcript still returns the line-1 title", () => {
		const d = dir("transcript-overcap-title");
		session(d, sid, ["Add Task Priority Flag"]);
		truncateSync(mainFile(d), TRANSCRIPT_MAX_BYTES + 1);
		// topTitleChanges refuses the file -> []; the line-1 latest title is the fallback.
		expect(firstSessionTitle(d, sid)).toBe("Add Task Priority Flag");
	});
});
