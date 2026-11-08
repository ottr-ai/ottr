// Hosted mode in the turn engine (docs/specs/hosted-mode.md sections 1, 4 and 5): metering
// records at settle, the credit gate, the credit stop and the hosted prompt suffixes.

import { afterEach, describe, expect, test } from "bun:test";
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
import { applyEvent, createRunSink, newEventState } from "./runner.ts";
import { ProjectStore } from "./store.ts";
import type { TurnOps, TurnProject } from "./turn.ts";
import {
	CREDIT_CHECK_FAILED,
	CREDIT_RETRY_MS,
	createTurnLoop,
} from "./turn.ts";
import type { Outcome, RunResult } from "./types.ts";

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

/** The minimal TurnOps a turn needs, after src/turn.test.ts's fakeOps. */
function fakeOps(record: Recorded, overrides: Partial<TurnOps> = {}): TurnOps {
	return {
		extensionPath: "ext.ts",
		board: { url: "http://127.0.0.1:4747", token: "boot-token" },
		maxTotalRuns: () => 10,
		drained: () => false,
		drainedRunner: () => false,
		modelRoles: () => ({ default: "fake/default-model" }),
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
		isClean: async () => true,
		isIntegrated: async () => true,
		unsavedWork: async () => null,
		statusFiles: async () => [],
		quarantineUntracked: async () => [],
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
		resetBranchTo: async () => true,
		pidAlive: () => true,
		startRun: (o: StartArgs) => {
			record.runs.push(o);
			o.onSession?.("sess-1");
			return {
				pid: 4242,
				done: Promise.resolve(answered()),
				kill: async () => {},
			};
		},
		ensurePackages: async () => [],
		genTitle: async () => null,
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

function setup(overrides: Partial<TurnOps> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "hosted-turn-test-"));
	dirs.push(dir);
	const store = ProjectStore.open(dir);
	stores.push(store);
	const record: Recorded = { runs: [], createWorktree: [], removeWorktree: [] };
	const projects = new Map([[store.name, fakeProject(store)]]);
	const loop = createTurnLoop(projects, fakeOps(record, overrides));
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

afterEach(() => {
	for (const s of stores.splice(0)) s.close();
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
		);
		// Malformed: no usage object, a string, bad numbers, no cost, a user message.
		applyEvent(s, end({ role: "assistant" }));
		applyEvent(s, end({ role: "assistant", usage: "lots" }));
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
		);
		applyEvent(s, end({ role: "assistant", usage: { input: 1, cost: 3 } }));
		applyEvent(
			s,
			end({ role: "user", usage: { input: 9999, cost: { total: 99 } } }),
		);
		applyEvent(s, { type: "message_start", message: { role: "assistant" } });
		expect(s.usage).toEqual({
			input: 151,
			output: 30,
			cacheRead: 1500,
			cacheWrite: 5,
			cost: 0.75,
		});
	});

	test("a run sink puts the summed usage on its result, and leaves it out while omp reported none", () => {
		const dir = mkdtempSync(join(tmpdir(), "hosted-sink-"));
		dirs.push(dir);
		const quiet = createRunSink({ logPath: join(dir, "a.log"), dataRoot: dir });
		quiet.line(JSON.stringify(end({ role: "assistant" })));
		expect(
			"usage" in quiet.result({ exitCode: 0, killed: false, stderrTail: "" }),
		).toBe(false);

		const sink = createRunSink({ logPath: join(dir, "b.log"), dataRoot: dir });
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
		expect(
			sink.result({ exitCode: 0, killed: false, stderrTail: "" }).usage,
		).toEqual({ input: 3, output: 3, cacheRead: 3, cacheWrite: 3, cost: 3 });
	});
});

// ---- metering at settle ----------------------------------------------------

describe("hosted metering at settle", () => {
	const PASS = JSON.stringify({ blockers: [], fixed: [], notes: [] });

	/** Work runs report ready with `work`; check runs (the check prompt's opening) pass with `check`. */
	function checkedRun(record: Recorded, work: RunResult, check: RunResult) {
		return (o: StartArgs) => {
			record.runs.push(o);
			o.onSession?.(`sess-${record.runs.length}`);
			const isCheck = o.prompt.startsWith("You are the second model");
			return {
				pid: 4242,
				done: Promise.resolve(isCheck ? check : work),
				kill: async () => {},
			};
		};
	}

	function workCheckCase(
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
		const store = ProjectStore.open(dir);
		stores.push(store);
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				// Holds the chained merge turn: each test asserts one work turn's settle.
				maxTotalRuns: () => 0,
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
		const { store, record, loop } = workCheckCase(
			hosted,
			{ default: "fake/default-model", adversary: "zai/glm-5.3-flash" },
			ready("openai/gpt-6", usage(10)),
			runResult({
				model: "zai/glm-5.3-flash",
				usage: usage(3),
				finalText: PASS,
			}),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(2);
		expect(store.getTask(task.id)!.stage).toBe("merging");
		const turnId = store.listTurns(task.id)[0]!.id;
		const base = {
			tenant: "t1",
			project: store.name,
			taskId: task.id,
			turnId,
			kind: "work",
		};
		expect(reports).toEqual([
			{ ...base, role: "default", model: "openai/gpt-6", usage: usage(10) },
			{
				...base,
				role: "adversary",
				model: "zai/glm-5.3-flash",
				usage: usage(3),
			},
		]);
	});

	test("an anthropic work run's check meters as critic; a missing check role meters as default", async () => {
		const critic = fakeHosted();
		const a = workCheckCase(
			critic.hosted,
			{ default: "fake/default-model", critic: "openai/gpt-6" },
			ready("anthropic/claude-opus-5-5", usage(1)),
			runResult({ model: "openai/gpt-6", usage: usage(2), finalText: PASS }),
		);
		const t1 = a.store.createTask("work please");
		await a.loop.runTurn(a.store.name, t1.id);
		expect(critic.reports.map((r) => r.role)).toEqual(["default", "critic"]);

		const fallback = fakeHosted();
		const b = workCheckCase(
			fallback.hosted,
			{ default: "fake/default-model" },
			ready("openai/gpt-6", usage(1)),
			runResult({
				model: "fake/default-model",
				usage: usage(2),
				finalText: PASS,
			}),
		);
		const t2 = b.store.createTask("work please");
		await b.loop.runTurn(b.store.name, t2.id);
		expect(fallback.reports.map((r) => [r.role, r.model])).toEqual([
			["default", "openai/gpt-6"],
			["default", "fake/default-model"],
		]);
	});

	test("a run that reported no usage meters zeros and a null model", async () => {
		const { hosted, reports } = fakeHosted();
		const { store, loop } = setup({
			hosted,
			commitsAhead: async () => 0,
			startRun: (o: StartArgs) => {
				o.onSession?.("sess-1");
				return {
					pid: 1,
					done: Promise.resolve(answered({ model: null })),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
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
	});

	test("a self-hosted loop reports nothing and never asks for credit", async () => {
		const { reports, creditCalls } = fakeHosted();
		const { store, record, loop } = workCheckCase(
			undefined,
			{ default: "fake/default-model", adversary: "zai/glm-5.3-flash" },
			ready("openai/gpt-6", usage(10)),
			runResult({
				model: "zai/glm-5.3-flash",
				usage: usage(3),
				finalText: PASS,
			}),
		);
		const task = store.createTask("work please");
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
		const { store, loop } = setup({ hosted, commitsAhead: async () => 0 });
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
	});
});

// ---- credit gate -----------------------------------------------------------

describe("hosted credit gate", () => {
	test("no credit parks the card with the credit reason and starts nothing", async () => {
		const { hosted, creditCalls } = fakeHosted({ credit: async () => false });
		const { store, record, loop } = setup({ hosted });
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		await flushPromises();

		expect(record.runs).toHaveLength(0);
		expect(record.createWorktree).toHaveLength(0);
		expect(store.listTurns(task.id)).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.worktree).toBeNull();
		// The settle's schedule() tick sees a parked card: no second gate call.
		expect(creditCalls()).toBe(1);
	});

	test("a merge turn is gated too", async () => {
		const { hosted } = fakeHosted({ credit: async () => false });
		const { store, record, loop } = setup({ hosted });
		const task = store.createTask("work please");
		store.updateTask(task.id, { stage: "merging" });
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
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
		const { store, record, loop } = setup({ hosted });
		const task = store.createTask("work please");
		const before = Date.now();
		await loop.runTurn(store.name, task.id);
		await flushPromises();
		const after = Date.now();

		expect(record.runs).toHaveLength(0);
		expect(store.listTurns(task.id)).toHaveLength(0);
		const held = store.getTask(task.id)!;
		expect(held.state).toBe("queued");
		expect(held.needsReason).toBe(CREDIT_CHECK_FAILED);
		expect(held.holdUntil).toBeGreaterThanOrEqual(before + CREDIT_RETRY_MS);
		expect(held.holdUntil).toBeLessThanOrEqual(after + CREDIT_RETRY_MS);
		// The hold keeps the scheduler off the card: no hot loop of gate calls.
		loop.schedule();
		await flushPromises();
		expect(creditCalls()).toBe(1);
	});

	test("credit available starts the turn as before", async () => {
		const { hosted, creditCalls } = fakeHosted();
		const { store, record, loop } = setup({
			hosted,
			commitsAhead: async () => 0,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(creditCalls()).toBe(1);
		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});
});

// ---- credit stop -----------------------------------------------------------

describe("hosted credit stop", () => {
	test("creditStop stops the running turn, keeps the worktree and parks with the credit reason", async () => {
		const { hosted, reports } = fakeHosted();
		let killed = false;
		const { store, record, loop } = setup({
			hosted,
			startRun: (o: StartArgs) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
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
		const task = store.createTask("work please");
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
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(CREDIT_REASON);
		expect(after.cancelledAt).toBeNull();
		expect(after.sessionId).toBe("sess-1");
		expect(after.worktree).not.toBeNull();
		expect(existsSync(after.worktree!)).toBe(true);
		expect(store.listTurns(task.id)[0]!.error).toBe("stopped");
		// The stopped run's usage so far is still metered.
		expect(reports).toHaveLength(1);
		expect(reports[0]!.usage).toEqual(usage(7));
	});

	test("creditStop with nothing running stops nothing", async () => {
		const { hosted } = fakeHosted();
		const { store, loop } = setup({ hosted });
		store.createTask("work please");
		await expect(loop.creditStop()).resolves.toBe(0);
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
		prepare: (store: ProjectStore, id: string) => void = () => {},
	): Promise<string> {
		const { store, record, loop } = setup({
			hosted,
			commitsAhead: async () => 0,
		});
		const task = store.createTask("work please");
		prepare(store, task.id);
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(1);
		return record.runs[0]!.prompt;
	}

	const merging = (store: ProjectStore, id: string) =>
		store.updateTask(id, { stage: "merging" });
	const replying = (store: ProjectStore, id: string) => {
		store.updateTask(id, {
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
