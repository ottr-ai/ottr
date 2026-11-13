// Hosted mode in the turn engine (docs/specs/hosted-mode.md sections 1, 4 and 5): interim and
// final metering records, the credit gate, the credit stop and release, and the hosted prompt
// suffixes.

import { afterEach, describe, expect, jest, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Hosted,
	HostedWording,
	MeteringRecord,
	TokenUsage,
} from "./hosted.ts";
import { ARCH_REVIEW_MARKER, DEEPEN_POINTS } from "./prompts.ts";
import { applyEvent, createRunSink, newEventState } from "./runner.ts";
import { ProjectStore } from "./store.ts";
import type { TurnLoop, TurnOps, TurnProject } from "./turn.ts";
import {
	CREDIT_CHECK_FAILED,
	CREDIT_RETRY_MS,
	createTurnLoop,
} from "./turn.ts";
import type { Outcome, RecordedFinding, RunResult } from "./types.ts";

// ---- fakes -----------------------------------------------------------------

type StartArgs = Parameters<TurnOps["startRun"]>[0];

interface Recorded {
	runs: StartArgs[];
	createWorktree: unknown[];
	removeWorktree: unknown[];
}

function runResult(p: Partial<RunResult> = {}): RunResult {
	return {
		exitCode: 0,
		sessionId: "sess-1",
		model: "m",
		outcome: null,
		asked: null,
		proposed: null,
		recorded: [],
		approvalRefused: false,
		sawTerminalEnd: true,
		finalText: "ok",
		killed: false,
		stderrTail: "",
		...p,
	};
}

const answered = (p: Partial<RunResult> = {}) =>
	runResult({
		outcome: { status: "answered", summary: "did it" } satisfies Outcome,
		...p,
	});

type FixtureOps = Partial<TurnOps> & {
	holdFollowUps?: boolean;
	scheduledCap?: number | null;
};

// Only an explicit turn owns a temporary cap. Its callbacks and finally close that cap before automatic dispatch.
function holdFollowUps(
	projects: Map<string, TurnProject>,
	options: TurnOps & { holdFollowUps?: boolean; scheduledCap?: number | null },
): TurnLoop {
	const { holdFollowUps: hold = false, scheduledCap, ...ops } = options;
	if (!hold) return createTurnLoop(projects, ops);
	const admission = new AsyncLocalStorage<{ allowed: boolean }>();
	const close = () => {
		const state = admission.getStore();
		if (state) state.allowed = false;
	};
	const controlled: TurnOps = {
		...ops,
		maxTotalRuns: () => {
			const state = admission.getStore();
			if (!state)
				return scheduledCap === undefined ? ops.maxTotalRuns() : scheduledCap;
			return state.allowed ? ops.maxTotalRuns() : 0;
		},
		publishSoon: () => {
			close();
			ops.publishSoon();
		},
		startRun: (options) => {
			close();
			return ops.startRun(options);
		},
	};
	if (ops.hosted !== undefined) {
		const hosted = ops.hosted;
		controlled.hosted = {
			...hosted,
			hooks: {
				...hosted.hooks,
				creditOk: () => {
					close();
					return hosted.hooks.creditOk();
				},
			},
		};
	}
	const loop = createTurnLoop(projects, controlled);
	const runTurn = loop.runTurn;
	loop.runTurn = (name, id) =>
		admission.run({ allowed: true }, async () => {
			try {
				await runTurn(name, id);
			} finally {
				close();
			}
		});
	return loop;
}

/** The minimal TurnOps a turn needs, after src/turn.test.ts's fakeOps. */
function fakeOps(record: Recorded, overrides: FixtureOps = {}): TurnOps {
	return {
		extensionPath: "ext.ts",
		board: { url: "http://127.0.0.1:4747", token: "boot-token" },
		maxTotalRuns: () => 10,
		drained: () => false,
		drainedRunner: () => false,
		modelRoles: () => ({ default: "fake/default-model" }),
		// An empty catalog unless a test sets one: the real modelList spawns this
		// machine's omp and caches its answer process-wide, which would leak into
		// every other modelList call and stall the flushPromises-driven tests.
		modelList: async () => [],
		workCheck: () => false,
		publishSoon: () => {},
		notifyLog: () => {},
		refreshRelease: async () => {},
		refreshArchReview: async () => {},
		resolveTarget: async () => ({
			target: "origin/main",
			sha: "sha0",
			warning: null,
		}),
		createWorktree: async (o: { worktreePath: string }) => {
			record.createWorktree.push(o);
			mkdirSync(o.worktreePath, { recursive: true });
		},
		removeWorktree: async (o: unknown) => {
			record.removeWorktree.push(o);
		},
		commitsAhead: async () => 1,
		changedFiles: async () => [],
		diffStat: async () => [],
		diffText: async () => null,
		revListCount: async () => null,
		cleanMergeTree: async () => null,
		isClean: async () => true,
		isIntegrated: async () => true,
		unsavedWork: async () => null,
		statusFiles: async () => [],
		quarantineUntracked: async () => ({ moved: [], refused: [] }),
		saveDoneFiles: async () => ({
			moved: [],
			copied: [],
			tooLarge: [],
			failed: [],
		}),
		worktreeHusk: async () => false,
		trackedFiles: async () => [],
		worktreeLinked: async () => true,
		ignoreInMain: async () => {},
		branchMergedOrGone: async () => true,
		hasRules: () => true,
		targetCommits: async () => 3,
		targetSha: async () => null,
		targetContains: async () => false,
		serverMergePush: async () => ({ status: "skipped" as const }),
		githubAuthHint: async () => null,
		fetchOriginBranch: async () => null,
		branchUnpushed: async () => false,
		checkedOutBranch: async () => null,
		checkoutState: async () => ({ head: "head0", status: "" }),
		rebaseTargetBranch: async () => ({
			ok: false as const,
			conflict: true,
			error: "CONFLICT (content): Merge conflict in src/a.ts",
		}),
		runMergeGates: async () => {
			throw new Error("merge gates must not run in these tests");
		},
		mergeHoldMismatch: async () => ({
			mismatch: false,
			pushDiff: null,
			auditedTip: null,
		}),
		mergeHoldLanded: async () => false,
		resetBranchTo: async () => true,
		pidAlive: () => true,
		startRun: async (o: StartArgs) => {
			record.runs.push(o);
			await o.onSession?.("sess-1");
			return {
				pid: 4242,
				done: Promise.resolve(answered()),
				kill: async () => {},
			};
		},
		ensurePackages: async () => [],
		genTitle: async () => null,
		// The comprehension gate defaults to a clean pass here: only the prompt-gate tests inject
		// a seam, so ordinary turn tests exercise the run loop, not the gate (OTTR-823).
		gateCheck: async () => ({
			builds: "the task",
			checks: "the recorded run",
			points: DEEPEN_POINTS.map(() => ({ covered: true, reason: "fine" })),
			questions: [],
		}),
		titleRetryDelayMs: 5,
		publishRelease: async () => "published",
		runReleaseCommand: async () => "ran",
		archReviewDelta: async () => ({ delta: 0, reviewed: true, anchor: "a" }),
		commitSubjects: async () => [],
		http400Dir: join(tmpdir(), "ottr-test-no-http400"),
		...overrides,
	};
}

function fakeProject(store: ProjectStore): TurnProject {
	return {
		store,
		name: store.name,
		path: store.path,
		target: null,
		gitless: false,
		github: null,
		protectedTarget: false,
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	};
}

const CREDIT_REASON = "Out of credit (test reason).";

/** A hosted config with recording hooks; the credit gate answers true unless told otherwise. */
function fakeHosted(
	o: { credit?: () => Promise<boolean>; wording?: Partial<HostedWording> } = {},
) {
	const reports: MeteringRecord[] = [];
	let creditCalls = 0;
	const hosted: Hosted = {
		config: {
			tenant: "t1",
			secret: "s".repeat(32),
			controlUrl: "http://127.0.0.1:9",
			wording: {
				workSuffix: "",
				mergeSuffix: "",
				resumeSuffix: "",
				creditReason: CREDIT_REASON,
				...o.wording,
			},
		},
		hooks: {
			reportUsage: (r) => {
				reports.push(r);
			},
			creditOk: () => {
				creditCalls += 1;
				return (o.credit ?? (async () => true))();
			},
			gitToken: async () => null,
		},
	};
	return { hosted, reports, creditCalls: () => creditCalls };
}

const dirs: string[] = [];
const stores: ProjectStore[] = [];

async function setup(overrides: FixtureOps = {}) {
	const dir = mkdtempSync(join(tmpdir(), "hosted-turn-test-"));
	dirs.push(dir);
	const store = await ProjectStore.open(dir);
	stores.push(store);
	const record: Recorded = { runs: [], createWorktree: [], removeWorktree: [] };
	const projects = new Map([[store.name, fakeProject(store)]]);
	const loop = holdFollowUps(projects, fakeOps(record, overrides));
	return { store, record, loop };
}

function saveSession(store: ProjectStore, sid: string): void {
	mkdirSync(store.sessionsDir, { recursive: true });
	writeFileSync(join(store.sessionsDir, `1_${sid}.jsonl`), "{}\n");
}

async function flushPromises() {
	await Promise.resolve();
	await new Promise((r) => setImmediate(r));
	await Promise.resolve();
	await new Promise((r) => setImmediate(r));
}

afterEach(async () => {
	for (const s of stores.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usage = (n: number): TokenUsage => ({
	input: n,
	output: n + 1,
	cacheRead: n + 2,
	cacheWrite: n + 3,
	cost: n / 100,
});

// ---- metering capture ------------------------------------------------------

describe("hosted metering capture", () => {
	const end = (message: unknown) => ({ type: "message_end", message });

	test("applyEvent sums the usage of every assistant message_end and skips malformed usage", () => {
		const s = newEventState();
		expect(s.usage).toBeNull();
		applyEvent(
			s,
			end({
				role: "assistant",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 1000,
					cacheWrite: 5,
					totalTokens: 1125,
					cost: { input: 0.1, output: 0.2, total: 0.25 },
				},
			}),
			true,
		);
		applyEvent(
			s,
			end({
				role: "assistant",
				usage: {
					input: 50,
					output: 10,
					cacheRead: 500,
					cacheWrite: 0,
					cost: { total: 0.5 },
				},
			}),
			true,
		);
		// Malformed: no usage object, a string, bad numbers, no cost, a user message.
		applyEvent(s, end({ role: "assistant" }), true);
		applyEvent(s, end({ role: "assistant", usage: "lots" }), true);
		applyEvent(
			s,
			end({
				role: "assistant",
				usage: {
					input: Number.NaN,
					output: -4,
					cacheRead: "7",
					cacheWrite: Number.POSITIVE_INFINITY,
					cost: { total: "1" },
				},
			}),
			true,
		);
		applyEvent(
			s,
			end({ role: "assistant", usage: { input: 1, cost: 3 } }),
			true,
		);
		applyEvent(
			s,
			end({ role: "user", usage: { input: 9999, cost: { total: 99 } } }),
			true,
		);
		applyEvent(
			s,
			{ type: "message_start", message: { role: "assistant" } },
			true,
		);
		expect(s.usage).toEqual({
			input: 151,
			output: 30,
			cacheRead: 1500,
			cacheWrite: 5,
			cost: 0.75,
		});
	});

	test("a run sink puts the summed usage on its result, and leaves it out while omp reported none", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hosted-sink-"));
		dirs.push(dir);
		const quiet = createRunSink({
			logPath: join(dir, "a.log"),
			dataRoot: dir,
			meter: true,
		});
		quiet.line(JSON.stringify(end({ role: "assistant" })));
		await quiet.drain();
		expect(
			"usage" in quiet.result({ exitCode: 0, killed: false, stderrTail: "" }),
		).toBe(false);

		const sink = createRunSink({
			logPath: join(dir, "b.log"),
			dataRoot: dir,
			meter: true,
		});
		for (const n of [1, 2])
			sink.line(
				JSON.stringify(
					end({
						role: "assistant",
						usage: {
							input: n,
							output: n,
							cacheRead: n,
							cacheWrite: n,
							cost: { total: n },
						},
					}),
				),
			);
		await sink.drain();
		expect(
			sink.result({ exitCode: 0, killed: false, stderrTail: "" }).usage,
		).toEqual({ input: 3, output: 3, cacheRead: 3, cacheWrite: 3, cost: 3 });
	});

	test("without the meter flag, usage stays null and the sink result has no usage key", async () => {
		const usage = {
			input: 5,
			output: 5,
			cacheRead: 5,
			cacheWrite: 5,
			cost: { total: 1 },
		};
		const s = newEventState();
		applyEvent(s, end({ role: "assistant", usage }));
		expect(s.usage).toBeNull();

		const dir = mkdtempSync(join(tmpdir(), "hosted-sink-"));
		dirs.push(dir);
		const sink = createRunSink({ logPath: join(dir, "c.log"), dataRoot: dir });
		sink.line(JSON.stringify(end({ role: "assistant", usage })));
		sink.line(JSON.stringify(end({ role: "assistant", usage })));
		await sink.drain();
		expect(
			"usage" in sink.result({ exitCode: 0, killed: false, stderrTail: "" }),
		).toBe(false);
		expect(sink.state.usage).toBeNull();
	});

	test("a run sink calls onUsage with the cumulative usage after each assistant message_end that changed it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hosted-sink-"));
		dirs.push(dir);
		const seen: [TokenUsage, string | null][] = [];
		const sink = createRunSink({
			logPath: join(dir, "d.log"),
			dataRoot: dir,
			meter: true,
			onUsage: (u, model) => {
				seen.push([u, model]);
			},
		});
		const msg = (n: number) => ({
			role: "assistant",
			usage: {
				input: n,
				output: n,
				cacheRead: n,
				cacheWrite: n,
				cost: { total: n },
			},
		});
		const all = (n: number) => ({
			input: n,
			output: n,
			cacheRead: n,
			cacheWrite: n,
			cost: n,
		});
		sink.line(
			JSON.stringify({
				type: "message_start",
				message: { role: "assistant", provider: "p", model: "m" },
			}),
		);
		sink.line(JSON.stringify(end(msg(1))));
		// No change: an assistant message without usage, one with zero usage, a user message.
		sink.line(JSON.stringify(end({ role: "assistant" })));
		sink.line(JSON.stringify(end(msg(0))));
		sink.line(JSON.stringify(end({ ...msg(9), role: "user" })));
		sink.line(JSON.stringify(end(msg(2))));
		await sink.drain();
		expect(seen).toEqual([
			[all(1), "p/m"],
			[all(3), "p/m"],
		]);
		// The callback gets a copy: changing it never changes the run's sum.
		seen[1]![0].input = 1000;
		expect(sink.state.usage).toEqual(all(3));

		const off: TokenUsage[] = [];
		const plain = createRunSink({
			logPath: join(dir, "e.log"),
			dataRoot: dir,
			onUsage: (u) => {
				off.push(u);
			},
		});
		plain.line(JSON.stringify(end(msg(1))));
		await plain.drain();
		expect(off).toEqual([]);
	});
});

// ---- metering at settle ----------------------------------------------------

describe("hosted metering at settle", () => {
	const PASS = JSON.stringify({ blockers: [], fixed: [], notes: [] });

	/** Work runs report ready with `work`; check runs (the check prompt's opening) pass with `check`. */
	function checkedRun(record: Recorded, work: RunResult, check: RunResult) {
		return async (o: StartArgs) => {
			record.runs.push(o);
			await o.onSession?.(`sess-${record.runs.length}`);
			const isCheck = o.prompt.startsWith("You are the second model");
			return {
				pid: 4242,
				done: Promise.resolve(isCheck ? check : work),
				kill: async () => {},
			};
		};
	}

	async function workCheckCase(
		hosted: Hosted | undefined,
		roles: Record<string, string>,
		work: RunResult,
		check: RunResult,
	) {
		const record: Recorded = {
			runs: [],
			createWorktree: [],
			removeWorktree: [],
		};
		const dir = mkdtempSync(join(tmpdir(), "hosted-turn-test-"));
		dirs.push(dir);
		const store = await ProjectStore.open(dir);
		stores.push(store);
		const loop = holdFollowUps(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				// Holds the chained merge turn: each test asserts one work turn's settle.
				holdFollowUps: true,
				targetSha: async () => "sha1",
				workCheck: () => true,
				modelRoles: () => roles,
				startRun: checkedRun(record, work, check),
				hosted,
			}),
		);
		return { store, record, loop };
	}

	const ready = (model: string, u: TokenUsage) =>
		runResult({
			model,
			usage: u,
			outcome: { status: "ready", summary: "did it" } satisfies Outcome,
		});

	test("a work turn with a work check reports the work run (default) and the check run (its check role)", async () => {
		const { hosted, reports } = fakeHosted();
		const { store, record, loop } = await workCheckCase(
			hosted,
			{ default: "fake/default-model", adversary: "zai/glm-5.3-flash" },
			ready("openai/gpt-6", usage(10)),
			runResult({
				model: "zai/glm-5.3-flash",
				usage: usage(3),
				finalText: PASS,
			}),
		);
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(2);
		expect((await store.getTask(task.id))!.stage).toBe("merging");
		const turnId = (await store.listTurns(task.id))[0]!.id;
		const base = {
			tenant: "t1",
			project: store.name,
			taskId: task.id,
			turnId,
			kind: "work",
		};
		expect(reports).toEqual([
			{
				...base,
				role: "default",
				model: "openai/gpt-6",
				run: 0,
				final: true,
				usage: usage(10),
				outcome: "ready",
				title: "work please",
			},
			{
				...base,
				role: "adversary",
				model: "zai/glm-5.3-flash",
				run: 1,
				final: true,
				usage: usage(3),
			},
		]);
	});

	test("a check retry is a new run: each run of the turn has its own run index", async () => {
		const { hosted, reports } = fakeHosted();
		const results = [
			ready("openai/gpt-6", usage(10)),
			runResult({
				model: "zai/glm-5.3-flash",
				usage: usage(2),
				exitCode: 1,
				stderrTail: "check crashed",
				sawTerminalEnd: false,
			}),
			runResult({
				model: "zai/glm-5.3-flash",
				usage: usage(3),
				finalText: PASS,
			}),
		];
		const record: Recorded = {
			runs: [],
			createWorktree: [],
			removeWorktree: [],
		};
		const dir = mkdtempSync(join(tmpdir(), "hosted-turn-test-"));
		dirs.push(dir);
		const store = await ProjectStore.open(dir);
		stores.push(store);
		const loop = holdFollowUps(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				holdFollowUps: true,
				targetSha: async () => "sha1",
				workCheck: () => true,
				modelRoles: () => ({
					default: "fake/default-model",
					adversary: "zai/glm-5.3-flash",
				}),
				// The runs get the three results in order: work, failed check, passing check.
				startRun: async (o) => {
					record.runs.push(o);
					await o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(results[record.runs.length - 1]!),
						kill: async () => {},
					};
				},
				hosted,
			}),
		);
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(3);
		expect((await store.getTask(task.id))!.stage).toBe("merging");
		expect(reports.map((r) => [r.run, r.role, r.final, r.usage])).toEqual([
			[0, "default", true, usage(10)],
			[1, "adversary", true, usage(2)],
			[2, "adversary", true, usage(3)],
		]);
		const keys = reports.map((r) =>
			JSON.stringify([r.project, r.taskId, r.turnId, r.kind, r.role, r.run]),
		);
		expect(new Set(keys).size).toBe(3);
	});

	test("an anthropic work run's check meters as critic; a missing check role meters as default", async () => {
		const critic = fakeHosted();
		const a = await workCheckCase(
			critic.hosted,
			{ default: "fake/default-model", critic: "openai/gpt-6" },
			ready("anthropic/claude-opus-5-5", usage(1)),
			runResult({ model: "openai/gpt-6", usage: usage(2), finalText: PASS }),
		);
		const t1 = await a.store.createTask("work please");
		await a.loop.runTurn(a.store.name, t1.id);
		expect(critic.reports.map((r) => r.role)).toEqual(["default", "critic"]);

		const fallback = fakeHosted();
		const b = await workCheckCase(
			fallback.hosted,
			{ default: "fake/default-model" },
			ready("openai/gpt-6", usage(1)),
			runResult({
				model: "fake/default-model",
				usage: usage(2),
				finalText: PASS,
			}),
		);
		const t2 = await b.store.createTask("work please");
		await b.loop.runTurn(b.store.name, t2.id);
		expect(fallback.reports.map((r) => [r.role, r.model])).toEqual([
			["default", "openai/gpt-6"],
			["default", "fake/default-model"],
		]);
	});

	test("a run that reported no usage meters zeros and a null model", async () => {
		const { hosted, reports } = fakeHosted();
		const { store, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
			startRun: async (o: StartArgs) => {
				await o.onSession?.("sess-1");
				return {
					pid: 1,
					done: Promise.resolve(answered({ model: null })),
					kill: async () => {},
				};
			},
		});
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(reports).toHaveLength(1);
		expect(reports[0]!.model).toBeNull();
		expect(reports[0]!.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
		// M10: the settled work turn's card outcome and the card title ride this record.
		expect(reports[0]!.outcome).toBe("answered");
		expect(reports[0]!.title).toBe("work please");
	});

	test("a merge turn that integrates reports the integrated outcome and the card title", async () => {
		const { hosted, reports } = fakeHosted();
		const { store, record, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
			startRun: async (o: StartArgs) => {
				record.runs.push(o);
				await o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							model: "openai/gpt-6",
							usage: usage(4),
							outcome: {
								status: "integrated",
								summary: "landed",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = await store.createTask("merge the card please");
		await store.updateTask(task.id, { stage: "merging" });
		await loop.runTurn(store.name, task.id);

		expect((await store.getTask(task.id))!.stage).toBe("done");
		expect(reports).toEqual([
			{
				tenant: "t1",
				project: store.name,
				taskId: task.id,
				turnId: (await store.listTurns(task.id))[0]!.id,
				kind: "merge",
				role: "default",
				model: "openai/gpt-6",
				run: 0,
				final: true,
				usage: usage(4),
				outcome: "integrated",
				title: "merge the card please",
			},
		]);
	});

	test("the title is the card prompt's first line, trimmed and cut to 200 characters", async () => {
		const { hosted, reports } = fakeHosted();
		const { store, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
		});
		const task = await store.createTask(
			`   ${"x".repeat(300)}\nsecond line   `,
		);
		await loop.runTurn(store.name, task.id);

		expect(reports).toHaveLength(1);
		expect(reports[0]!.title).toBe("x".repeat(200));
	});

	test("a dependency hold requeues the card: the record sends queued, never needs_you", async () => {
		const { hosted, reports } = fakeHosted();
		let depId = "";
		const { store, record, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
			startRun: async (o: StartArgs) => {
				record.runs.push(o);
				await o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "holding",
								dependsOn: [depId],
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const dep = await store.createTask("the dependency");
		depId = dep.id;
		const task = await store.createTask("held on the dependency");
		await loop.runTurn(store.name, task.id);

		// The dep hold requeued the card (no park): the board shows queued, and the record
		// must not claim needs_you — the control plane would email the owner needlessly.
		const after = (await store.getTask(task.id))!;
		expect(after.state).toBe("queued");
		expect(after.dependsOn).toContain(dep.id);
		expect((await store.listTurns(task.id))[0]!.outcome).toBe("needs_you");
		expect(reports[0]!.outcome).toBe("queued");
		expect(reports[0]!.title).toBe("held on the dependency");
	});

	test("a self-hosted loop reports nothing and never asks for credit", async () => {
		const { reports, creditCalls } = fakeHosted();
		const { store, record, loop } = await workCheckCase(
			undefined,
			{ default: "fake/default-model", adversary: "zai/glm-5.3-flash" },
			ready("openai/gpt-6", usage(10)),
			runResult({
				model: "zai/glm-5.3-flash",
				usage: usage(3),
				finalText: PASS,
			}),
		);
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(2);
		expect(reports).toEqual([]);
		expect(creditCalls()).toBe(0);
	});

	test("a metering hook that throws never fails the settle", async () => {
		const { hosted } = fakeHosted();
		hosted.hooks.reportUsage = () => {
			throw new Error("control plane down");
		};
		const { store, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
		});
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = (await store.getTask(task.id))!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
	});
});

// ---- interim metering ------------------------------------------------------

describe("hosted interim metering", () => {
	test("an active run sends throttled interim records with its cumulative usage, under the final record's key", async () => {
		const { hosted, reports } = fakeHosted();
		let onUsage: StartArgs["onUsage"];
		const done = Promise.withResolvers<RunResult>();
		const { store, loop } = await setup({
			hosted,
			meteringIntervalMs: 60_000,
			commitsAhead: async () => 0,
			startRun: async (o: StartArgs) => {
				onUsage = o.onUsage;
				await o.onSession?.("sess-1");
				return { pid: 4242, done: done.promise, kill: async () => {} };
			},
		});
		const task = await store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		const key = `${store.name}/${task.id}`;
		for (let i = 0; i < 100 && !loop.running.has(key); i++)
			await flushPromises();
		expect(onUsage).toBeDefined();
		const sent = () => reports.map((r) => [r.final, r.usage]);

		// Fake timers drive the throttle interval (60 s in this setup).
		jest.useFakeTimers();
		try {
			// The first change goes out at once; two more inside the interval wait for its end.
			onUsage!(usage(1), "m/a");
			onUsage!(usage(2), "m/a");
			onUsage!(usage(3), "m/a");
			expect(sent()).toEqual([[false, usage(1)]]);
			jest.advanceTimersByTime(60_000);
			// One record at the end of the interval, with the newest usage only.
			expect(sent()).toEqual([
				[false, usage(1)],
				[false, usage(3)],
			]);

			// A change still waiting when the run ends goes out only in the final record.
			onUsage!(usage(4), "m/a");
			done.resolve(answered({ model: "m/a", usage: usage(5) }));
			await run;
			onUsage!(usage(6), "m/a");
			jest.advanceTimersByTime(600_000);
			expect(sent()).toEqual([
				[false, usage(1)],
				[false, usage(3)],
				[true, usage(5)],
			]);
		} finally {
			jest.useRealTimers();
		}
		const turnId = (await store.listTurns(task.id))[0]!.id;
		for (const r of reports)
			expect(r).toMatchObject({
				tenant: "t1",
				project: store.name,
				taskId: task.id,
				turnId,
				kind: "work",
				role: "default",
				run: 0,
				model: "m/a",
			});
	});

	test("a throwing metering hook never breaks the interim records or the run", async () => {
		const { hosted } = fakeHosted();
		let calls = 0;
		hosted.hooks.reportUsage = () => {
			calls += 1;
			throw new Error("control plane down");
		};
		let onUsage: StartArgs["onUsage"];
		const done = Promise.withResolvers<RunResult>();
		const { store, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
			startRun: (o: StartArgs) => {
				onUsage = o.onUsage;
				return { pid: 4242, done: done.promise, kill: async () => {} };
			},
		});
		const task = await store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		const key = `${store.name}/${task.id}`;
		for (let i = 0; i < 100 && !loop.running.has(key); i++)
			await flushPromises();
		expect(() => onUsage!(usage(1), "m/a")).not.toThrow();
		done.resolve(answered({ usage: usage(1) }));
		await run;
		expect(calls).toBe(2);
		expect((await store.getTask(task.id))!.stage).toBe("done");
	});
});

// ---- credit gate -----------------------------------------------------------

describe("hosted credit gate", () => {
	test("no credit parks the card with the credit reason and starts nothing", async () => {
		const { hosted, creditCalls } = fakeHosted({ credit: async () => false });
		const { store, record, loop } = await setup({ hosted });
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		await flushPromises();

		expect(record.runs).toHaveLength(0);
		expect(record.createWorktree).toHaveLength(0);
		expect(await store.listTurns(task.id)).toHaveLength(0);
		const after = (await store.getTask(task.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.worktree).toBeNull();
		// The settle's schedule() tick sees a parked card: no second gate call.
		expect(creditCalls()).toBe(1);
	});

	test("a merge turn is gated too", async () => {
		const { hosted } = fakeHosted({ credit: async () => false });
		const { store, record, loop } = await setup({ hosted });
		const task = await store.createTask("work please");
		await store.updateTask(task.id, { stage: "merging" });
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(0);
		const after = (await store.getTask(task.id))!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
	});

	test("a failed credit check holds the card queued for a minute", async () => {
		const { hosted, creditCalls } = fakeHosted({
			credit: async () => {
				throw new Error("control plane unreachable");
			},
		});
		const { store, record, loop } = await setup({ hosted });
		const task = await store.createTask("work please");
		const before = Date.now();
		await loop.runTurn(store.name, task.id);
		await flushPromises();
		const after = Date.now();

		expect(record.runs).toHaveLength(0);
		expect(await store.listTurns(task.id)).toHaveLength(0);
		const held = (await store.getTask(task.id))!;
		expect(held.state).toBe("queued");
		expect(held.needsReason).toBe(CREDIT_CHECK_FAILED);
		expect(held.holdUntil).toBeGreaterThanOrEqual(before + CREDIT_RETRY_MS);
		expect(held.holdUntil).toBeLessThanOrEqual(after + CREDIT_RETRY_MS);
		// The hold keeps the scheduler off the card: no hot loop of gate calls.
		await loop.schedule();
		await flushPromises();
		expect(creditCalls()).toBe(1);
	});

	test("credit available starts the turn as before", async () => {
		const { hosted, creditCalls } = fakeHosted();
		const { store, record, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
		});
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(creditCalls()).toBe(1);
		expect(record.runs).toHaveLength(1);
		expect((await store.getTask(task.id))!.stage).toBe("done");
	});
});

// ---- credit stop -----------------------------------------------------------

describe("hosted credit stop", () => {
	test("creditStop stops the running turn, keeps the worktree and parks with the credit reason", async () => {
		const { hosted, reports } = fakeHosted();
		let killed = false;
		const { store, record, loop } = await setup({
			hosted,
			startRun: async (o: StartArgs) => {
				record.runs.push(o);
				await o.onSession?.("sess-1");
				const { promise, resolve } = Promise.withResolvers<RunResult>();
				return {
					pid: 4242,
					done: promise,
					kill: async () => {
						killed = true;
						resolve(
							runResult({
								killed: true,
								sawTerminalEnd: false,
								model: "openai/gpt-6",
								usage: usage(7),
							}),
						);
					},
				};
			},
		});
		const task = await store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		for (
			let i = 0;
			i < 100 && !loop.running.has(`${store.name}/${task.id}`);
			i++
		)
			await flushPromises();
		expect(loop.running.has(`${store.name}/${task.id}`)).toBe(true);

		await expect(loop.creditStop()).resolves.toBe(1);
		await run;

		expect(killed).toBe(true);
		expect(record.removeWorktree).toHaveLength(0);
		const after = (await store.getTask(task.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.cancelledAt).toBeNull();
		expect(after.sessionId).toBe("sess-1");
		expect(after.worktree).not.toBeNull();
		expect(existsSync(after.worktree!)).toBe(true);
		expect((await store.listTurns(task.id))[0]!.error).toBe("stopped");
		// The stopped run's usage so far is still metered, with the parked card's outcome.
		expect(reports).toHaveLength(1);
		expect(reports[0]!.usage).toEqual(usage(7));
		expect(reports[0]!.outcome).toBe("needs_you");
		expect(reports[0]!.title).toBe("work please");
	});

	test("creditStop with nothing running stops nothing", async () => {
		const { hosted } = fakeHosted();
		const { store, loop } = await setup({ hosted });
		await store.createTask("work please");
		await expect(loop.creditStop()).resolves.toBe(0);
	});

	/** Work or merge runs resolve `main` at once; each check run (check.yml) hangs until killed. */
	function hangingChecks(
		main: RunResult,
		completionError: Error | null = null,
	) {
		const runs: StartArgs[] = [];
		const checks: { killed: boolean }[] = [];
		const startRun = async (o: StartArgs) => {
			runs.push(o);
			await o.onSession?.("sess-1");
			if (o.config?.endsWith("check.yml") !== true)
				return { pid: 4242, done: Promise.resolve(main), kill: async () => {} };
			const check = { killed: false };
			checks.push(check);
			const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
			return {
				pid: 4343,
				done: promise,
				kill: async () => {
					check.killed = true;
					if (completionError === null)
						resolve(runResult({ killed: true, sawTerminalEnd: false }));
					else reject(completionError);
				},
			};
		};
		return { runs, checks, startRun };
	}

	async function waitFor(cond: () => boolean | Promise<boolean>) {
		for (let i = 0; i < 200 && !(await cond()); i++) await flushPromises();
		expect(await cond()).toBe(true);
	}

	const readyRun = runResult({
		model: "openai/gpt-6",
		outcome: { status: "ready", summary: "did it" } satisfies Outcome,
	});

	test("creditStop kills a running work check: no second attempt, the card parks with the credit reason", async () => {
		const { hosted } = fakeHosted();
		const h = hangingChecks(readyRun);
		const { store, record, loop } = await setup({
			hosted,
			holdFollowUps: true,
			targetSha: async () => "sha1",
			workCheck: () => true,
			modelRoles: () => ({
				default: "fake/default-model",
				adversary: "zai/glm-5.3-flash",
			}),
			startRun: h.startRun,
		});
		const task = await store.createTask("work please");
		const checkKey = `${store.name}/${task.id}:workcheck`;
		const run = loop.runTurn(store.name, task.id);
		await waitFor(() => loop.running.has(checkKey));

		await expect(loop.creditStop()).resolves.toBe(1);
		await run;

		expect(h.checks).toEqual([{ killed: true }]);
		// The work run and one check attempt: the killed check never retries.
		expect(h.runs).toHaveLength(2);
		expect(loop.running.has(checkKey)).toBe(false);
		expect(record.removeWorktree).toHaveLength(0);
		const after = (await store.getTask(task.id))!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.cancelledAt).toBeNull();
		expect(after.sessionId).toBe("sess-1");
		expect(after.worktree).not.toBeNull();
		expect(existsSync(after.worktree!)).toBe(true);
		// No failed-check record: the stop is not a check verdict.
		expect(after.workCheckLog).toEqual([]);
	});

	test("creditStop kills a running review check: no second attempt, nothing filed, the card parks with the credit reason", async () => {
		const { hosted } = fakeHosted();
		const finding: RecordedFinding = {
			prompt: "Bug A",
			model: null,
			rank: 1,
			security: null,
		};
		const h = hangingChecks(
			runResult({
				outcome: { status: "answered", summary: "review done" },
				recorded: [finding],
			}),
		);
		const { store, record, loop } = await setup({
			hosted,
			holdFollowUps: true,
			commitsAhead: async () => 0,
			startRun: h.startRun,
		});
		const review = await store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		await store.updateTask(review.id, { base: "shaR" });
		const checkKey = `${store.name}/${review.id}:check`;
		const run = loop.runTurn(store.name, review.id);
		await waitFor(() => loop.running.has(checkKey));

		await expect(loop.creditStop()).resolves.toBe(1);
		await run;

		expect(h.checks).toEqual([{ killed: true }]);
		expect(h.runs).toHaveLength(2);
		expect(loop.running.has(checkKey)).toBe(false);
		expect(record.removeWorktree).toHaveLength(0);
		expect(
			(await store.listTasks()).filter((t) => t.followUpOf === review.id),
		).toEqual([]);
		const after = (await store.getTask(review.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.cancelledAt).toBeNull();
	});

	test.each(["work", "review"] as const)(
		"creditStop completes after a %s check rejects its persistence callback",
		async (kind) => {
			const { hosted } = fakeHosted();
			const failure = new Error("check callback persistence failed");
			const h = hangingChecks(
				kind === "work"
					? readyRun
					: runResult({
							outcome: { status: "answered", summary: "review done" },
							recorded: [
								{ prompt: "Bug A", model: null, rank: 1, security: null },
							],
						}),
				failure,
			);
			const { store, record, loop } = await setup({
				hosted,
				holdFollowUps: true,
				targetSha: async () => "sha1",
				workCheck: () => kind === "work",
				commitsAhead: async () => (kind === "work" ? 1 : 0),
				modelRoles: () => ({
					default: "fake/default-model",
					adversary: "zai/glm-5.3-flash",
				}),
				startRun: h.startRun,
			});
			const task = await store.createTask(
				kind === "work"
					? "work please"
					: `${ARCH_REVIEW_MARKER}main (3 commits)`,
				null,
				kind === "work" ? "work" : "review",
			);
			if (kind === "review") await store.updateTask(task.id, { base: "shaR" });
			const key = `${store.name}/${task.id}:${kind === "work" ? "workcheck" : "check"}`;
			const run = loop.runTurn(store.name, task.id);
			await waitFor(() => loop.running.has(key));
			await expect(loop.creditStop()).resolves.toBe(1);
			await run;
			expect(h.checks).toEqual([{ killed: true }]);
			expect(h.runs).toHaveLength(2);
			expect(await store.getTask(task.id)).toMatchObject({
				state: "needs_you",
				needsReason: CREDIT_REASON,
				cancelledAt: null,
			});
			expect(record.removeWorktree).toHaveLength(0);
			expect(await Bun.file(await store.logPath(task.id)).text()).toContain(
				failure.message,
			);
		},
	);

	test("creditStop during the prepare parks the turn before any agent run starts", async () => {
		const { hosted } = fakeHosted();
		const prepare = Promise.withResolvers<void>();
		let preparing = false;
		const { store, record, loop } = await setup({
			hosted,
			resolveTarget: async () => {
				preparing = true;
				await prepare.promise;
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		const task = await store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await waitFor(() => preparing);

		await expect(loop.creditStop()).resolves.toBe(1);
		prepare.resolve();
		await run;

		expect(record.runs).toHaveLength(0);
		expect(await store.listTurns(task.id)).toHaveLength(0);
		const after = (await store.getTask(task.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.cancelledAt).toBeNull();
	});

	test("a gate answer that started before the stop does not let the turn run", async () => {
		const answer = Promise.withResolvers<boolean>();
		const { hosted } = fakeHosted({ credit: () => answer.promise });
		const { store, record, loop } = await setup({ hosted });
		const task = await store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await flushPromises();
		expect((await store.getTask(task.id))!.state).toBe("preparing");

		await expect(loop.creditStop()).resolves.toBe(1);
		answer.resolve(true);
		await run;

		expect(record.runs).toHaveLength(0);
		const after = (await store.getTask(task.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
	});

	test("after creditStop a new gate asks again: credit now runs the turn, no credit parks it", async () => {
		let credit = false;
		const { hosted, creditCalls } = fakeHosted({ credit: async () => credit });
		const { store, record, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
		});
		await expect(loop.creditStop()).resolves.toBe(0);

		const parked = await store.createTask("first");
		await loop.runTurn(store.name, parked.id);
		expect(record.runs).toHaveLength(0);
		expect((await store.getTask(parked.id))!.needsReason).toBe(CREDIT_REASON);

		credit = true;
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(creditCalls()).toBe(2);
		expect(record.runs).toHaveLength(1);
		expect((await store.getTask(task.id))!.stage).toBe("done");
	});

	test("a fresh gate answer clears the hold, but a turn marked in its prepare still parks", async () => {
		const { hosted } = fakeHosted();
		const prepare = Promise.withResolvers<void>();
		let blocked: string | null = null;
		const { store, record, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
			// Only the first card's prepare waits; every later prepare runs through.
			resolveTarget: async () => {
				if (blocked === null) {
					blocked = "first";
					await prepare.promise;
				}
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		const first = await store.createTask("first");
		const run = loop.runTurn(store.name, first.id);
		await waitFor(() => blocked !== null);
		await expect(loop.creditStop()).resolves.toBe(1);

		const second = await store.createTask("second");
		await loop.runTurn(store.name, second.id);
		expect(record.runs).toHaveLength(1);
		expect((await store.getTask(second.id))!.stage).toBe("done");

		prepare.resolve();
		await run;
		expect(record.runs).toHaveLength(1);
		const after = (await store.getTask(first.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
	});

	test("a self-hosted loop ignores the credit hold: work run and check run as before", async () => {
		const h = hangingChecks(readyRun);
		const passCheck = (o: StartArgs) => {
			if (o.config?.endsWith("check.yml") !== true) return h.startRun(o);
			h.runs.push(o);
			return {
				pid: 4343,
				done: Promise.resolve(
					runResult({
						finalText: JSON.stringify({ blockers: [], fixed: [], notes: [] }),
					}),
				),
				kill: async () => {},
			};
		};
		const { store, loop } = await setup({
			holdFollowUps: true,
			targetSha: async () => "sha1",
			workCheck: () => true,
			startRun: passCheck,
		});
		await loop.creditStop();
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(h.runs).toHaveLength(2);
		const after = (await store.getTask(task.id))!;
		expect(after.stage).toBe("merging");
		expect(after.needsReason).toBeNull();
	});

	/** A loop whose title generations fail and whose run stalls until killed or finished. */
	async function titleRetrySetup(hosted: Hosted | undefined) {
		let genCalls = 0;
		const { promise: secondGen, resolve: sawSecondGen } =
			Promise.withResolvers<void>();
		const { promise: done, resolve } = Promise.withResolvers<RunResult>();
		const { store, record, loop } = await setup({
			hosted,
			// Long enough that the test reaches creditStop before the timer fires.
			titleRetryDelayMs: 200,
			genTitle: async () => {
				genCalls += 1;
				if (genCalls > 1) sawSecondGen();
				return null;
			},
			// The comprehension gate defaults to a clean pass here: only the prompt-gate tests inject
			// a seam, so ordinary turn tests exercise the run loop, not the gate (OTTR-823).
			gateCheck: async () => ({
				builds: "the task",
				checks: "the recorded run",
				points: DEEPEN_POINTS.map(() => ({ covered: true, reason: "fine" })),
				questions: [],
			}),
			startRun: async (o: StartArgs) => {
				record.runs.push(o);
				await o.onSession?.("sess-1");
				return {
					pid: 4242,
					done,
					kill: async () => {
						resolve(runResult({ killed: true, sawTerminalEnd: false }));
					},
				};
			},
		});
		// Resolves when the store releases the title hold: the retry settled or was cancelled.
		const { promise: holdReleased, resolve: released } =
			Promise.withResolvers<void>();
		const release = store.releaseTitleHold.bind(store);
		store.releaseTitleHold = async (id: string) => {
			const had = await release(id);
			if (had) released();
			return had;
		};
		return {
			store,
			loop,
			secondGen,
			holdReleased,
			finish: () => resolve(answered()),
			genCalls: () => genCalls,
		};
	}

	test("creditStop before a failed title's retry fires skips the retry's model call", async () => {
		const { hosted } = fakeHosted();
		const t = await titleRetrySetup(hosted);
		const task = await t.store.createTask("work please");
		const run = t.loop.runTurn(t.store.name, task.id);
		const key = `${t.store.name}/${task.id}`;
		await waitFor(() => t.loop.running.has(key));
		expect(t.genCalls()).toBe(1);
		expect(await t.store.titleHold(task.id)).toBe(true);
		await expect(t.loop.creditStop()).resolves.toBe(1);
		await run;
		await t.holdReleased;

		expect(t.genCalls()).toBe(1);
		expect(await t.store.titleHold(task.id)).toBe(false);
		const after = (await t.store.getTask(task.id))!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
	});

	test("self-hosted: the failed title's retry still runs", async () => {
		const t = await titleRetrySetup(undefined);
		const task = await t.store.createTask("work please");
		const run = t.loop.runTurn(t.store.name, task.id);
		await t.secondGen;
		await t.holdReleased;
		expect(t.genCalls()).toBe(2);
		t.finish();
		await run;
	});
});

// ---- credit release --------------------------------------------------------

describe("hosted credit release", () => {
	test("creditRelease queues only the credit-parked needs_you cards like a Resume; a second call queues none", async () => {
		const { hosted } = fakeHosted({ credit: async () => false });
		// No schedule tick may claim a released card: the test reads the queue writes.
		const { store, record, loop } = await setup({
			hosted,
			holdFollowUps: true,
			scheduledCap: 0,
		});
		const gated = await store.createTask("parked at the gate");
		await loop.runTurn(store.name, gated.id);
		expect((await store.getTask(gated.id))!.needsReason).toBe(CREDIT_REASON);
		// A card the credit stop parked, with a steer that the owner queued before the stop.
		const stopped = await store.createTask("stopped mid-run");
		await store.updateTask(stopped.id, {
			state: "needs_you",
			needsReason: CREDIT_REASON,
			sessionId: "sess-9",
			pendingPrompt: "also fix the docs",
			pendingBy: "user",
		});
		const other = await store.createTask("parked for another reason");
		const otherReason =
			"Turn stopped. Reply to continue the session, Resume to rerun it, or cancel the card.";
		await store.updateTask(other.id, {
			state: "needs_you",
			needsReason: otherReason,
		});
		const cancelled = await store.createTask("cancelled while parked");
		await store.updateTask(cancelled.id, {
			state: "needs_you",
			needsReason: CREDIT_REASON,
			cancelledAt: Date.now(),
		});

		await expect(loop.creditRelease()).resolves.toBe(2);
		await flushPromises();

		// The release's "." is the board's own voice, not a user message.
		expect(await store.getTask(gated.id)).toMatchObject({
			state: "queued",
			pendingPrompt: ".",
			pendingBy: "supervisor",
			needsReason: null,
			holdUntil: null,
		});
		// Resume sends the queued steer alone, on the kept session.
		expect(await store.getTask(stopped.id)).toMatchObject({
			state: "queued",
			pendingPrompt: "also fix the docs",
			pendingBy: "user",
			needsReason: null,
			sessionId: "sess-9",
		});
		expect(await store.getTask(other.id)).toMatchObject({
			state: "needs_you",
			needsReason: otherReason,
			pendingPrompt: null,
		});
		expect((await store.getTask(cancelled.id))!.state).toBe("needs_you");
		expect(record.runs).toHaveLength(0);

		await expect(loop.creditRelease()).resolves.toBe(0);
		expect((await store.getTask(other.id))!.state).toBe("needs_you");
	});

	test("a no-credit gate answer that started before a release requeues the card instead of parking it", async () => {
		const stale = Promise.withResolvers<boolean>();
		let calls = 0;
		const { hosted } = fakeHosted({
			credit: () => (++calls === 1 ? stale.promise : Promise.resolve(true)),
		});
		// No schedule tick may claim the card: the test runs each turn itself.
		const { store, record, loop } = await setup({
			hosted,
			holdFollowUps: true,
			commitsAhead: async () => 0,
		});
		const task = await store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await flushPromises();
		expect((await store.getTask(task.id))!.state).toBe("preparing");

		// The card is preparing, so the release skips it.
		await expect(loop.creditRelease()).resolves.toBe(0);
		stale.resolve(false);
		await run;

		expect(record.runs).toHaveLength(0);
		expect(await store.getTask(task.id)).toMatchObject({
			state: "queued",
			holdUntil: null,
		});
		expect((await store.getTask(task.id))!.needsReason).not.toBe(CREDIT_REASON);

		await loop.runTurn(store.name, task.id);
		expect(calls).toBe(2);
		expect(record.runs).toHaveLength(1);
		expect((await store.getTask(task.id))!.stage).toBe("done");
	});

	test("a no-credit answer after the release still parks a card that a later gate checks", async () => {
		const { hosted } = fakeHosted({ credit: async () => false });
		const { store, record, loop } = await setup({
			hosted,
			holdFollowUps: true,
		});
		await expect(loop.creditRelease()).resolves.toBe(0);
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(await store.getTask(task.id)).toMatchObject({
			state: "needs_you",
			needsReason: CREDIT_REASON,
		});
	});

	test("a released card waits for an active usage-limit hold like any board-queued card", async () => {
		const resetsAt = Date.now() + 3_600_000;
		let credit = false;
		const { hosted } = fakeHosted({ credit: async () => credit });
		const { store, record, loop } = await setup({
			hosted,
			holdFollowUps: true,
			quota: async () => ({
				limits: [
					{
						provider: "fake",
						label: "5 hours",
						window: "5h",
						plan: null,
						usedPct: 100,
						resetsAt,
					},
				],
				error: null,
				at: Date.now(),
			}),
		});
		const task = await store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect((await store.getTask(task.id))!.needsReason).toBe(CREDIT_REASON);

		credit = true;
		await expect(loop.creditRelease()).resolves.toBe(1);
		expect((await store.getTask(task.id))!.pendingBy).toBe("supervisor");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(0);
		expect(await store.getTask(task.id)).toMatchObject({
			state: "queued",
			holdUntil: resetsAt,
			holdProvider: "fake",
		});
	});

	test("a self-hosted loop releases nothing", async () => {
		const { store, loop } = await setup({ maxTotalRuns: () => 0 });
		const task = await store.createTask("parked");
		await store.updateTask(task.id, {
			state: "needs_you",
			needsReason: CREDIT_REASON,
		});
		await expect(loop.creditRelease()).resolves.toBe(0);
		expect((await store.getTask(task.id))!.state).toBe("needs_you");
	});
});

// ---- hosted wording --------------------------------------------------------

describe("hosted prompt suffixes", () => {
	const wording = {
		workSuffix: "HOSTED-WORK-SUFFIX",
		mergeSuffix: "HOSTED-MERGE-SUFFIX",
		resumeSuffix: "HOSTED-RESUME-SUFFIX",
	};
	const SUFFIXES = Object.values(wording);

	async function promptOf(
		hosted: Hosted | undefined,
		prepare: (
			store: ProjectStore,
			id: string,
		) => unknown | Promise<unknown> = () => {},
	): Promise<string> {
		const { store, record, loop } = await setup({
			hosted,
			commitsAhead: async () => 0,
		});
		const task = await store.createTask("work please");
		await prepare(store, task.id);
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(1);
		return record.runs[0]!.prompt;
	}

	const merging = async (store: ProjectStore, id: string) =>
		await store.updateTask(id, { stage: "merging" });
	const replying = async (store: ProjectStore, id: string) => {
		await store.updateTask(id, {
			stage: "in_progress",
			sessionId: "sess-1",
			pendingPrompt: "please continue",
		});
		saveSession(store, "sess-1");
	};

	test("a hosted work, merge and resume prompt each end with their own suffix", async () => {
		const { hosted } = fakeHosted({ wording });
		const work = await promptOf(hosted);
		expect(work.endsWith(`\n\n${wording.workSuffix}`)).toBe(true);
		expect(work).not.toContain(wording.mergeSuffix);
		expect(work).not.toContain(wording.resumeSuffix);

		const merge = await promptOf(hosted, merging);
		expect(merge.endsWith(`\n\n${wording.mergeSuffix}`)).toBe(true);
		expect(merge).not.toContain(wording.workSuffix);

		const resume = await promptOf(hosted, replying);
		expect(resume).toContain("please continue");
		expect(resume.endsWith(`\n\n${wording.resumeSuffix}`)).toBe(true);
		expect(resume).not.toContain(wording.workSuffix);
	});

	test("a self-hosted board and empty hosted suffixes leave every prompt unchanged", async () => {
		const empty = fakeHosted().hosted;
		for (const prepare of [undefined, merging, replying]) {
			const own = await promptOf(undefined, prepare);
			for (const s of SUFFIXES) expect(own).not.toContain(s);
			expect(await promptOf(empty, prepare)).toBe(own);
		}
	});
});
