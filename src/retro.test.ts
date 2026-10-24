import { describe, expect, test } from "bun:test";
import { RETRO_MARKER, retroPrompt } from "./prompts.ts";
import {
	collectRetroFacts,
	factsMarkdown,
	frictionFilter,
	lessonsQueued,
	sumUsageIn,
} from "./retro.ts";
import { isRetro } from "./scheduler.ts";
import type { Task, Turn } from "./types.ts";

let seq = 0;
function turn(p: Partial<Turn> = {}): Turn {
	seq += 1;
	return {
		id: seq,
		taskId: "t1",
		kind: "work",
		prompt: "p",
		input: null,
		startedAt: 1_000,
		endedAt: 61_000,
		pid: null,
		exitCode: 0,
		outcome: "ready",
		summary: null,
		details: null,
		question: null,
		error: null,
		model: null,
		...p,
	};
}

function retroTask(p: Partial<Task> = {}): Task {
	seq += 1;
	return {
		id: `t${seq}`,
		kind: p.kind ?? "work",
		project: "proj",
		title: `task ${seq}`,
		prompt: `prompt ${seq}`,
		stage: "done",
		state: "idle",
		needsReason: null,
		pendingPrompt: null,
		images: [],
		pendingImages: [],
		shots: [],
		branch: null,
		base: null,
		worktree: null,
		sessionId: null,
		summary: null,
		details: null,
		report: null,
		research: false,
		createdAt: 1,
		updatedAt: 1,
		queuedAt: 1,
		doneAt: 1,
		cancelledAt: null,
		commits: null,
		releaseVersion: null,
		releaseNotes: null,
		asked: null,
		model: null,
		keptFiles: [],
		followUpOf: null,
		pushSha: null,
		topic: null,
		dependsOn: [],
		updateIds: [],
		updateMergeApproved: false,
		forkMergeApproved: false,
		diffFiles: null,
		diffText: null,
		workCheckLog: [],
		workCheckSendbacks: 0,
		workCheckHead: null,
		priority: null,
		closeCandidate: null,
		...p,
	};
}

/** Synthetic omp transcript: two assistant messages with usage, a bash call with a
 * start/end pair, a write error, and a stop continuation. tool_execution_start at
 * t=10_000, result at t=70_000 → 60.00s. */
const SESSION_TEXT = [
	JSON.stringify({
		type: "message",
		timestamp: 10_000,
		message: {
			role: "assistant",
			model: "glm-5.3-flash",
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 3000,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "echo tool-output-secret" },
				},
			],
		},
	}),
	JSON.stringify({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: 10_000,
		data: {
			toolCallId: "call_1",
			toolName: "bash",
			startedAt: 10_000,
			args: { command: "echo tool-output-secret" },
			intent: "Running the tests",
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: 70_000,
		message: {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [],
			isError: false,
			details: { wallTimeMs: 60_000 },
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: 80_000,
		message: {
			role: "assistant",
			model: "glm-5.3-flash",
			usage: {
				input: 2000,
				output: 50,
				cacheRead: 1000,
				cacheWrite: 0,
				cost: { total: 0.03 },
			},
			content: [],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: 90_000,
		message: {
			role: "toolResult",
			toolCallId: "call_x",
			toolName: "write",
			content: [],
			isError: true,
			details: { wallTimeMs: 120 },
		},
	}),
	JSON.stringify({
		type: "custom_message",
		customType: "session-stop-continuation",
		timestamp: 100_000,
	}),
].join("\n");

const SUB_TEXT = [
	JSON.stringify({
		type: "message",
		timestamp: 20_000,
		message: {
			role: "assistant",
			model: "glm-5.3-flash",
			usage: {
				input: 500,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
			content: [],
		},
	}),
].join("\n");

function fixtureTasks(): Task[] {
	return [
		retroTask({
			id: "prop1",
			title: "proposal open",
			state: "needs_you",
			needsReason:
				"Proposed by the retro of parent. Accept to start it, edit the prompt first, or cancel to decline.",
		}),
		retroTask({
			id: "prop2",
			title: "proposal declined",
			state: "idle",
			cancelledAt: 2,
			needsReason:
				"Proposed by the retro of parent. Accept to start it, edit the prompt first, or cancel to decline.",
		}),
		retroTask({
			id: "old1",
			title: "old retro",
			kind: "retro",
			prompt: `${RETRO_MARKER}old task`,
			details: "## Report\nLessons queued\n1. lesson one\n\n## Next",
		}),
		retroTask({
			id: "old2",
			title: "older retro",
			kind: "retro",
			prompt: `${RETRO_MARKER}older task`,
			details: "Lessons queued\n2. lesson two",
		}),
	];
}

const LOG = [
	"other log line",
	"supervisor: CI passed for abc123",
	"supervisor: CI failed for def456; filed follow-up id9",
	"",
].join("\n");

function facts(o: Partial<Parameters<typeof collectRetroFacts>[0]> = {}) {
	return collectRetroFacts({
		turns: [],
		log: LOG,
		sessionText: SESSION_TEXT,
		subagentTexts: [SUB_TEXT],
		tasks: fixtureTasks(),
		...o,
	});
}

describe("collectRetroFacts", () => {
	test("cost, tokens and cache share across main and subagent sessions", () => {
		const f = facts();
		expect(f.cost.total).toBeCloseTo(0.05, 6);
		expect(f.cost.byModel["glm-5.3-flash"]).toBeCloseTo(0.05, 6);
		expect(f.cost.tokens).toBe(1000 + 100 + 3000 + 2000 + 50 + 1000 + 500 + 10);
		expect(f.cost.cacheRead).toBe(4000);
		expect(f.subagents.count).toBe(1);
		expect(f.subagents.cost).toBeCloseTo(0.01, 6);
		expect(f.subagents.costShare).toBeCloseTo(0.2, 6);
	});

	test("per-tool calls, errors and seconds; slowest with intent only", () => {
		const f = facts();
		const bash = f.tools.find((t) => t.name === "bash");
		expect(bash).toEqual({ name: "bash", calls: 1, errors: 0, seconds: 60 });
		const write = f.tools.find((t) => t.name === "write");
		expect(write).toEqual({ name: "write", calls: 1, errors: 1, seconds: 0 });
		expect(f.slowest[0]).toEqual({
			tool: "bash",
			intent: "Running the tests",
			seconds: 60,
		});
	});

	test("no tool output text enters the facts or the markdown", () => {
		const f = facts();
		const md = factsMarkdown(f);
		expect(JSON.stringify(f)).not.toContain("tool-output-secret");
		expect(md).not.toContain("tool-output-secret");
		expect(md).not.toContain("echo");
		expect(md.startsWith("## Facts (computed by Ottr)")).toBe(true);
		expect(md).toContain("CI failed for def456; filed follow-up id9");
	});

	test("turn facts: duration, model, error, input cut at 300 chars", () => {
		const long = "x".repeat(400);
		const f = facts({
			turns: [
				turn({ input: long, model: "glm-5.3-flash" }),
				turn({
					kind: "merge",
					outcome: "needs_you",
					error: "boom",
					endedAt: null,
				}),
			],
		});
		expect(f.turns[0]!.input).toBe("x".repeat(300));
		expect(f.turns[0]!.seconds).toBe(60);
		expect(f.turns[1]!.seconds).toBeNull();
		expect(f.turns[1]!.outcome).toBe("needs_you");
		expect(f.needsYouEpisodes).toBe(1);
	});

	test("CI verdict is the last supervisor: CI line; none in log means null", () => {
		expect(facts().ciVerdict).toBe(
			"supervisor: CI failed for def456; filed follow-up id9",
		);
		expect(facts({ log: "nothing here" }).ciVerdict).toBeNull();
	});

	test("open and declined proposals, lessons from the last 20 retros", () => {
		const f = facts();
		expect(f.openProposals).toEqual([{ id: "prop1", title: "proposal open" }]);
		expect(f.declinedProposals).toEqual([
			{ id: "prop2", title: "proposal declined" },
		]);
		expect(f.lessons).toEqual([
			"Lessons queued\n1. lesson one",
			"Lessons queued\n2. lesson two",
		]);
	});
});

describe("frictionFilter", () => {
	const smooth = facts({
		log: "supervisor: CI passed for abc",
		sessionText: "",
		subagentTexts: [],
		turns: [turn()],
		tasks: [],
	});
	test("false for a smooth single work turn", () => {
		expect(frictionFilter(smooth)).toBe(false);
	});
	test("true on a user reply/steer", () => {
		expect(
			frictionFilter({ ...smooth, turns: [turn({ input: "note" })] }),
		).toBe(true);
	});
	test("true on a needs_you episode", () => {
		expect(
			frictionFilter({ ...smooth, turns: [turn({ outcome: "needs_you" })] }),
		).toBe(true);
	});
	test("true on a second work turn", () => {
		expect(frictionFilter({ ...smooth, turns: [turn(), turn()] })).toBe(true);
	});
	test("true on a report_outcome tool error", () => {
		expect(
			frictionFilter({
				...smooth,
				tools: [{ name: "report_outcome", calls: 1, errors: 1, seconds: 0 }],
			}),
		).toBe(true);
	});
	test("true on a session-stop continuation", () => {
		expect(frictionFilter({ ...smooth, continuations: 1 })).toBe(true);
	});
	test("true on failed CI", () => {
		expect(frictionFilter({ ...smooth, ciFailed: true })).toBe(true);
	});
	test("false for CI passed", () => {
		expect(frictionFilter({ ...smooth, ciFailed: false })).toBe(false);
	});
	test("true at cost 0.50, false below", () => {
		expect(
			frictionFilter({ ...smooth, cost: { ...smooth.cost, total: 0.5 } }),
		).toBe(true);
		expect(
			frictionFilter({ ...smooth, cost: { ...smooth.cost, total: 0.49 } }),
		).toBe(false);
	});
});

describe("isRetro", () => {
	test("is true only for kind 'retro', whatever the prompt says", () => {
		expect(isRetro(retroTask({ kind: "retro" }))).toBe(true);
		// A work card whose prompt merely starts with the marker is not a retro.
		expect(
			isRetro(
				retroTask({
					prompt: retroPrompt({ title: "x", model: null, handoff: "h" }),
				}),
			),
		).toBe(false);
		expect(isRetro(retroTask())).toBe(false);
	});
});

describe("lessonsQueued", () => {
	test("cuts at the next heading and handles null", () => {
		expect(lessonsQueued("intro\nLessons queued\n- a\n- b\n## More")).toBe(
			"Lessons queued\n- a\n- b",
		);
		expect(lessonsQueued("Lessons queued\n- a")).toBe("Lessons queued\n- a");
		expect(lessonsQueued("no lessons here")).toBeNull();
		expect(lessonsQueued(null)).toBeNull();
	});
});

describe("sumUsageIn", () => {
	const from = Date.parse("2026-09-27T10:00:00.000Z");
	const to = Date.parse("2026-09-27T11:00:00.000Z");

	function usageLine(at: number, input: number, cost: number): string {
		return JSON.stringify({
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				model: "m",
				usage: {
					input,
					output: 2,
					cacheRead: 4,
					cacheWrite: 8,
					cost: { total: cost },
				},
			},
		});
	}

	const tx = (
		sessionText: string | null,
		subagentTexts: string[] = [],
		complete = true,
	) => ({ sessionText, subagentTexts, complete });

	test("sums assistant usage inside the inclusive window across session and subagents", () => {
		const session = [
			usageLine(from - 1, 100, 1), // one ms before the window
			usageLine(from, 10, 0.25), // inclusive start edge
			usageLine(to, 20, 0.5), // inclusive end edge
			usageLine(to + 1, 200, 2), // one ms after the window
		].join("\n");
		const sub = usageLine(from + 30_000, 5, 0.125);
		expect(sumUsageIn(tx(session, [sub]), from, to)).toEqual({
			tokensIn: 10 + 20 + 5,
			tokensOut: 2 * 3,
			cacheRead: 4 * 3,
			cacheWrite: 8 * 3,
			cost: 0.25 + 0.5 + 0.125,
		});
	});

	test("a record without a parseable timestamp lands in no window", () => {
		const session = [
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 50, cost: { total: 9 } },
				},
			}),
			usageLine(from + 1, 0, 0), // the session ran in the window
		].join("\n");
		expect(sumUsageIn(tx(session), from, to)?.tokensIn).toBe(0);
	});

	test("an owned window without usage is a confirmed zero", () => {
		const session = JSON.stringify({
			type: "message",
			timestamp: new Date(from + 5).toISOString(),
			message: { role: "user", content: "go" },
		});
		expect(sumUsageIn(tx(session), from, to)).toEqual({
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	});

	test("a missing transcript proves nothing: null, not zeros", () => {
		expect(sumUsageIn(tx(null), from, to)).toBeNull();
		// Subagent files alone cannot show the turn ran in this session.
		expect(sumUsageIn(tx(null, [usageLine(from, 1, 1)]), from, to)).toBeNull();
	});

	test("an incomplete transcript (unreadable subagent source) gives null", () => {
		const good = usageLine(from, 10, 1);
		expect(sumUsageIn(tx(good, [], false), from, to)).toBeNull();
		expect(sumUsageIn(tx(good, [good], false), from, to)).toBeNull();
	});

	test("a session without a record in the window is another session's turn: null", () => {
		const session = usageLine(to + 60_000, 10, 2);
		expect(sumUsageIn(tx(session), from, to)).toBeNull();
	});

	test("a malformed record in the session or a subagent file gives null", () => {
		const good = usageLine(from, 10, 1);
		for (const bad of ["{not json", "42", "null"]) {
			expect(sumUsageIn(tx(`${good}\n${bad}`), from, to)).toBeNull();
			expect(sumUsageIn(tx(good, [bad]), from, to)).toBeNull();
		}
		// Blank lines and a trailing newline are not records.
		expect(sumUsageIn(tx(`${good}\n\n`), from, to)?.cost).toBe(1);
	});
});
