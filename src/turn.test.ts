import { Database } from "bun:sqlite";
import {
	afterEach,
	describe,
	expect,
	jest,
	setSystemTime,
	test,
} from "bun:test";
import { execSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { createApp } from "./app.ts";
import { GlobalStore } from "./globalStore.ts";
import {
	ARCH_REVIEW_MARKER,
	BOARD_CHECK_PROMPT,
	DEP_HELD_PROMPT,
	followUpPrompt,
	LOST_SESSION,
	mergePrompt,
	PROPOSED_REASON_PREFIX,
	RESEARCH_REPORT,
	RETRO_MARKER,
	RULES_INTERVIEW_MARKER,
	replyPrompt,
	restartResumePrompt,
	WORK_CHECK_MAX_SENDBACKS,
} from "./prompts.ts";
import { hitUsageLimit, WORKER_LOST } from "./runner.ts";
import {
	FINDINGS_HOLD,
	isRetro,
	isReview,
	liveCard,
	PROMPT_EDIT_HELD,
	pickRunnable,
	UNCHECKED_FINDINGS_HOLD,
} from "./scheduler.ts";
import { DEFAULT_SETTINGS, ProjectStore } from "./store.ts";
import fc from "./test/properties.ts";
import { turnEnv } from "./tokens.ts";
import type { TurnLoop, TurnOps, TurnProject } from "./turn.ts";
import {
	appendLog,
	cancelKeptReason,
	checkRunError,
	createTurnLoop,
	FORK_HOLD_REASON,
	generateTitle,
	getSettingsLogged,
	isKeptReason,
	keptReason,
	logStoreError,
	MERGE_HOLD_MISMATCH_REASON,
	modelSwap,
	parseReleaseVersion,
	parseTopicReport,
	tmpEnrichNeedsReason,
	turnModel,
	UI_SHOT_WARNING,
	UPDATE_HOLD_REASON,
	uiFiles,
	VM_BUSY_RETRY_MS,
	writeVmFiles,
} from "./turn.ts";
import type {
	Outcome,
	ProposalSummary,
	RecordedFinding,
	RunResult,
	WorkCheckRun,
} from "./types.ts";
import { vmState } from "./vmState.ts";
import { VmTokens } from "./vmTokens.ts";
import type { DetachedRun, WorkerTarget } from "./workers.ts";
import {
	isClean as gitIsClean,
	PUSH_LANDED_BEFORE_ATTEMPT,
	checkoutState as realCheckoutState,
	resolveTarget as realResolveTarget,
	statusFiles as realStatusFiles,
	trackedFiles as realTrackedFiles,
	unsavedWork as realUnsavedWork,
	worktreeHusk as realWorktreeHusk,
	setNetworkGitAuth,
} from "./worktree.ts";

// ---- fakes -----------------------------------------------------------------

interface Recorded {
	createWorktree: unknown[];
	removeWorktree: unknown[];
	runs: {
		cwd: string;
		prompt: string;
		images?: unknown[];
		resumeId?: string | null;
		sessionName?: string | null;
		env?: Record<string, string>;
		secrets?: readonly string[];
		stripBoard?: boolean;
		stripGithubToken?: boolean;
		tools?: string | null;
		config?: string | null;
		skills?: string | null;
		extensionPath?: string | null;
		model?: string | null;
		maxTime?: string | null;
		worker?: WorkerTarget | null;
		board?: {
			url: string;
			token: string;
			project: string;
			taskId: string;
		} | null;
		onSession?: (sid: string) => void;
	}[];
	publishRelease: unknown[];
	runReleaseCommand: unknown[];
	quarantine: { worktreePath: string; quarantineDir: string }[];
	ignoreInMain: { mainPath: string; rel: string }[];
	publishSoon: number;
	notifyLog: [string, string][];
	killed: boolean;
	/** The fake run resolves `done` with this proposal (a retro run's propose_task). */
	proposal: {
		prompt: string;
		model: string | null;
		summary: ProposalSummary | null;
	} | null;
	/** The fake run resolves `done` with these findings (a review run's propose_task calls). */
	recorded: RecordedFinding[];
}

/** An omp RunResult the fakes resolve `done` with; fields match types.ts. */
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

function fakeOps(record: Recorded, overrides: Partial<TurnOps> = {}): TurnOps {
	return {
		extensionPath: "ext.ts",
		board: { url: "http://127.0.0.1:4747", token: "boot-token" },
		maxTotalRuns: () => 10,
		drained: () => false,
		drainedRunner: () => false,
		// A neutral default role (no provider lends it) unless a test sets one: the real
		// modelRoles reads this machine's config.yml, and a worker turn needs a model to run.
		modelRoles: () => ({ default: "fake/default-model" }),
		// The work-card check defaults off here: only the work-check tests switch it on, so a
		// ready work turn settles to merging/queued exactly as before OTTR-28.
		workCheck: () => false,
		publishSoon: () => {
			record.publishSoon += 1;
		},
		notifyLog: (project: string, id: string) => {
			record.notifyLog.push([project, id]);
		},
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
		// OTTR-708: a static snapshot reads unchanged, so the checkout guard never fires
		// unless a test scripts a before/after change.
		checkoutState: async () => ({ head: "head0", status: "" }),
		unsavedWork: async () => null,
		statusFiles: async () => [],
		quarantineUntracked: async (
			worktreePath: string,
			quarantineDir: string,
		) => {
			record.quarantine.push({ worktreePath, quarantineDir });
			return [];
		},
		worktreeHusk: async () => false,
		trackedFiles: async () => [],
		worktreeLinked: async () => true,
		ignoreInMain: async (mainPath: string, rel: string) => {
			record.ignoreInMain.push({ mainPath, rel });
		},
		branchMergedOrGone: async () => true,
		hasRules: () => true,
		targetCommits: async () => 3,
		targetSha: async () => null,
		// Fails closed like the real git read: containment must be proven, never assumed.
		targetContains: async () => false,
		serverMergePush: async () => ({ status: "skipped" as const }),
		githubAuthHint: async () => null,
		fetchOriginBranch: async () => null,
		// No rejected push in the default fixtures: the merge hold's git fact stays false.
		branchUnpushed: async () => false,
		// The default main checkout sits on main, so no off-default finding fires.
		checkedOutBranch: async () => null,
		// The default cannot converge (a conflict), so a rejected push still queues the
		// recovery steer exactly as before OTTR-510; tests on the converged path override both.
		rebaseTargetBranch: async () => ({
			ok: false as const,
			conflict: true,
			error: "CONFLICT (content): Merge conflict in src/a.ts",
		}),
		runMergeGates: async () => {
			throw new Error(
				"merge gates must not run unless the automatic rebase converged",
			);
		},
		mergeHoldMismatch: async () => ({
			mismatch: false,
			pushDiff: null,
			auditedTip: null,
		}),
		mergeHoldLanded: async () => false,
		resetBranchTo: async () => true,
		pidAlive: () => true,
		startRun: (o: {
			cwd: string;
			prompt: string;
			env?: Record<string, string>;
			stripBoard?: boolean;
			stripGithubToken?: boolean;
			tools?: string | null;
			config?: string | null;
			skills?: string | null;
			board?: {
				url: string;
				token: string;
				project: string;
				taskId: string;
			} | null;
			onSession?: (sid: string) => void;
		}) => {
			record.runs.push(o);
			o.onSession?.("sess-1");
			return {
				pid: 4242,
				done: Promise.resolve(
					runResult({
						outcome: {
							status: "answered",
							summary: "did it",
						} satisfies Outcome,
						proposed: record.proposal,
						recorded: record.recorded,
					}),
				),
				kill: async () => {
					record.killed = true;
				},
			};
		},
		ensurePackages: async () => [],
		// The default keeps work turns unnamed exactly as before the prepare-phase titler.
		genTitle: async () => null,
		// A failed generation schedules its one retry; keep that wait out of the tests' way.
		titleRetryDelayMs: 5,
		publishRelease: async () => "published",
		runReleaseCommand: async () => "ran",
		archReviewDelta: async () => ({ delta: 0, reviewed: true, anchor: "a" }),
		// The check run's git input is stubbed like http400Dir: tests never spawn real git.
		commitSubjects: async () => [],
		// Tests must not depend on the operator's real ~/.omp/logs/http-400-requests.
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

// ---- tests -----------------------------------------------------------------

const dirs: string[] = [];
const stores: ProjectStore[] = [];

function freshStore(): ProjectStore {
	const dir = mkdtempSync(join(tmpdir(), "turn-test-"));
	dirs.push(dir);
	const store = ProjectStore.open(dir);
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("turn loop", () => {
	test("a finished run records ranOn on the turn; a run without one leaves it null", async () => {
		const { store, loop } = setup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							ranOn: "worker-a (abc)",
							outcome: { status: "answered", summary: "did it" },
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("worker run");
		await loop.runTurn(store.name, task.id);
		const turns = store.listTurns(task.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.ranOn).toBe("worker-a (abc)");
		expect(turns[0]!.outcome).toBe("answered");

		const { store: plainStore, loop: plainLoop } = setup();
		const plain = plainStore.createTask("plain run");
		await plainLoop.runTurn(plainStore.name, plain.id);
		expect(plainStore.listTurns(plain.id)[0]!.ranOn).toBeNull();
	});

	test("queued work turn lands done: branch, session, commits, worktree removed", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, { commitsAhead: async () => 0 }),
		);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		// outcome answered + commitsAhead 0 classifies to done/idle.
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.commits).toBe(3);
		expect(after.branch).toBe(`ott/${task.id.toLowerCase()}-work-please`);
		expect(after.sessionId).toBe("sess-1");
		// Stage went todo -> in_progress (in onSession) before landing done.
		const events = store.events().filter((e) => e.kind === "stage");
		expect(events.map((e) => e.to)).toContain("in_progress");
		// Worktree created then removed exactly once with the created branch.
		expect(record.createWorktree).toHaveLength(1);
		expect(record.removeWorktree).toHaveLength(1);
		expect(record.removeWorktree[0]).toMatchObject({ branch: after.branch });
		// One turn recorded with the outcome and the model.
		const turns = store.listTurns(task.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.outcome).toBe("answered");
		expect(turns[0]!.pid).toBe(4242);
		expect(turns[0]!.model).toBe("m");
		// The task's selector level lands on the recorded model (transcripts carry the bare model only).
		const picked = store.createTask("work with a level", "m:max");
		await loop.runTurn(store.name, picked.id);
		expect(store.listTurns(picked.id)[0]!.model).toBe("m:max");
		// The turn's prompt reached the fake process in the created worktree.
		expect(record.runs[0]!.cwd).toContain(task.id);
		expect(record.runs[0]!.prompt).toContain("work please");
		// The create_task tool's coordinates flow into the run env.
		expect(record.runs[0]!.board).toEqual({
			url: "http://127.0.0.1:4747",
			token: "boot-token",
			project: store.name,
			taskId: task.id,
		});
		// runTurn's finally reschedules the board.
		expect(record.publishSoon).toBeGreaterThan(0);
	});

	test("review turns pin a fixed session name; a plain work turn pins none", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });

		const review = store.createTask(
			`${ARCH_REVIEW_MARKER} review origin/main`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);
		expect(record.runs[0]!.sessionName).toBe("Review");

		const work = store.createTask("work please");
		await loop.runTurn(store.name, work.id);
		expect(record.runs[1]!.sessionName).toBeNull();
	});

	test("prepare generates the card title once and pins it on the run", async () => {
		const prompts: string[] = [];
		const { store, record, loop } = setup({
			genTitle: async (prompt: string) => {
				prompts.push(prompt);
				return "Fix the login gate";
			},
		});

		const task = store.createTask(
			"fix the login redirect for expired sessions",
		);
		await loop.runTurn(store.name, task.id);
		expect(prompts).toEqual([task.prompt]);
		expect(record.runs[0]!.sessionName).toBe("Fix the login gate");
		// Persisted in prepare: the card shows the generated name before the run even starts.
		expect(store.sessionTitle(store.getTask(task.id)!)).toBe(
			"Fix the login gate",
		);

		// A stored title is reused, never regenerated: a later prepare re-pins the same name.
		const carried = store.createTask("second task with a stored title");
		store.nameTask(carried.id, "Carried over");
		await loop.runTurn(store.name, carried.id);
		expect(prompts).toHaveLength(1);
		expect(record.runs[1]!.sessionName).toBe("Carried over");
	});

	test("a failed title generation starts the turn unnamed on the prompt cut", async () => {
		const { store, record, loop } = setup({ genTitle: async () => null });

		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBeNull();
		expect(store.frozenTitle(store.getTask(task.id)!)).toBe(task.title);
	});

	test("a board check runs in the server with the board env; the same text unmarked goes to a worker", async () => {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
		});
		const check = store.createTask(BOARD_CHECK_PROMPT);
		store.setBoardCheckId(check.id);
		await loop.runTurn(store.name, check.id);
		const run = record.runs[0]!;
		// Only loopback in the server's own container reaches the whole board API.
		expect(run.worker).toBeNull();
		expect(run.prompt).toBe(BOARD_CHECK_PROMPT);
		expect(run.sessionName).toBe("Board check");
		expect(run.board).toEqual({
			url: "http://127.0.0.1:4747",
			token: "boot-token",
			project: store.name,
			taskId: check.id,
		});

		// An agent can file the same text, but only the route's mark keeps a card off the workers.
		const copy = store.createTask(BOARD_CHECK_PROMPT);
		await loop.runTurn(store.name, copy.id);
		expect(record.runs[1]!.worker).toEqual({ urls: ["http://worker-a:8787"] });
		expect(record.runs[1]!.sessionName).toBeNull();
	});

	test("retro card runs raw prompt with the retro flags and no board, and files its proposal as a held card", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		record.proposal = {
			prompt: "Add a benchmark for the merge path",
			model: "zai/glm",
			summary: {
				whatChanges: "Add a benchmark script for the merge path.",
				why: "Merge turns re-run the same slow path on every retro.",
				gain: "About 30 seconds per retro run.",
				risk: "none found",
				check: "bun test src/merge-bench.test.ts passes.",
			},
		};
		const task = store.createTask(
			`${RETRO_MARKER}the weekly retro`,
			null,
			"retro",
		);

		await loop.runTurn(store.name, task.id);

		// Run flags: raw prompt, no board coordinates, no worker, retro env and argv.
		const run = record.runs[0]!;
		expect(run.prompt).toContain("the weekly retro");
		expect(run.board).toBeNull();
		expect(run.env).toEqual({ OTTR_RETRO: "1" });
		expect(run.stripBoard).toBe(true);
		expect(run.tools).toBe("read,grep,glob,report_outcome,propose_task");
		expect(run.config).toBe(join(dirname("ext.ts"), "retro.yml"));
		expect(run.skills).toBe("retro");

		// The proposal is a held child card.
		const kids = store.listTasks().filter((t) => t.followUpOf === task.id);
		expect(kids).toHaveLength(1);
		const kid = kids[0]!;
		expect(kid.state).toBe("needs_you");
		expect(kid.needsReason?.startsWith(PROPOSED_REASON_PREFIX)).toBe(true);
		// No parent: the reason names the retro card itself by id, not its title.
		expect(kid.needsReason).toContain(task.id);
		expect(kid.needsReason).not.toContain("the weekly retro");
		expect(kid.model).toBe("zai/glm");
		// The five decision fields ride to the child card for the drawer's panel.
		expect(kid.proposalSummary).toEqual({
			whatChanges: "Add a benchmark script for the merge path.",
			why: "Merge turns re-run the same slow path on every retro.",
			gain: "About 30 seconds per retro run.",
			risk: "none found",
			check: "bun test src/merge-bench.test.ts passes.",
		});
		expect(kid.prompt).toContain("handoffs");
		expect(kid.prompt).toContain("Add a benchmark for the merge path");
		// The handoff file exists and describes the finished retro.
		const handoff = readFileSync(
			join(store.tasksDir, "handoffs", `${kid.id}.md`),
			"utf8",
		);
		expect(handoff).toContain("the weekly retro");
		expect(logText(store, task.id)).toContain(
			`filed proposal ${kid.id} (held for approval)`,
		);
		// The retro card itself settles done like a work card.
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a trending scout runs on a worker, read-only in the main checkout with only its tools, and settles done", async () => {
		const unsaved: string[] = [];
		const { store, record, loop } = setup({
			// The scout reads third-party text: with a worker pool it never runs on the server (D6).
			workerTarget: { urls: ["http://worker-a:8787"] },
			// commitsAhead keeps its default 1: the main checkout's own commits are never the scout's.
			unsavedWork: async (wt: string) => {
				unsaved.push(wt);
				return null;
			},
		});
		const task = store.createTask(
			"Trending scout for demo\nread the bundle",
			null,
			"trending",
		);

		await loop.runTurn(store.name, task.id);

		const run = record.runs[0]!;
		expect(run.cwd).toBe(store.path);
		expect(run.worker).toEqual({ urls: ["http://worker-a:8787"] });
		// A local fallback spawn runs without the board's GitHub token too.
		expect(run.stripGithubToken).toBe(true);
		expect(run.prompt).toBe(task.prompt);
		expect(run.env).toEqual({ OTTR_TRENDING: "1" });
		expect(run.tools).toBe(
			"read,grep,glob,report_outcome,propose_repo,judge_repo",
		);
		// The overlay turns autolearn off, so omp adds no learn/manage_skill tools.
		expect(run.config).toBe("trending.yml");
		// Its two tools call the board, so the board env stays.
		expect(run.stripBoard).toBe(false);
		expect(run.board).toEqual({
			url: "http://127.0.0.1:4747",
			token: "boot-token",
			project: store.name,
			taskId: task.id,
		});
		// No worktree, no quarantine, no unsaved-work gate: the main checkout stays untouched.
		expect(record.createWorktree).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
		expect(record.quarantine).toHaveLength(0);
		expect(unsaved).toEqual([]);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.branch).toBeNull();
	});

	test("a retro proposal names its source card once by id and title", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const source = store.createTask(
			"Rebase and retry when the server push after a merge fails",
		);
		const retro = store.createTask(
			`${RETRO_MARKER}${source.title}`,
			null,
			"retro",
		);
		store.updateTask(retro.id, { followUpOf: source.id });
		record.proposal = {
			prompt: "Add a benchmark for the merge path",
			model: null,
			summary: null,
		};

		await loop.runTurn(store.name, retro.id);

		const kid = store.listTasks().find((t) => t.followUpOf === retro.id);
		expect(kid).toBeDefined();
		const reason = kid!.needsReason ?? "";
		expect(reason.startsWith(PROPOSED_REASON_PREFIX)).toBe(true);
		expect(reason).toBe(
			`Retro proposal from ${source.id}. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
		);
		// The reason carries the source's id, never the retro's own "Retro of ..." title.
		expect(reason).toContain(source.id);
		expect(reason).not.toContain(source.title);
		expect(/retro of retro of/i.test(reason)).toBe(false);
		expect(reason).not.toContain(retro.id);
		// A proposal without a summary keeps the field null; the drawer falls back
		// to the prompt's first paragraph.
		expect(kid!.proposalSummary).toBeNull();
	});

	test("retro proposal filing is capped at 3 open proposals", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");
		// Three already-open, untouched proposals fill the cap. The first keeps the
		// pre-2026-11 wording: stored cards still count against the cap.
		for (let i = 0; i < 3; i++) {
			const p = store.createTask(`proposal ${i}`);
			store.updateTask(p.id, {
				state: "needs_you",
				needsReason:
					i === 0
						? "Proposed by the retro of an older retro. Accept to start it, edit the prompt first, or cancel to decline."
						: `${PROPOSED_REASON_PREFIX}an older retro. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
			});
		}
		record.proposal = { prompt: "one too many", model: null, summary: null };

		await loop.runTurn(store.name, retro.id);

		expect(
			store.listTasks().filter((t) => t.followUpOf === retro.id),
		).toHaveLength(0);
		expect(logText(store, retro.id)).toContain(
			"retro: proposal dropped: cap of 3 open proposals reached",
		);
	});

	test("a cancelled proposal does not count against the cap", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");
		for (let i = 0; i < 3; i++) {
			const p = store.createTask(`proposal ${i}`);
			store.updateTask(p.id, {
				state: "needs_you",
				needsReason: `${PROPOSED_REASON_PREFIX}an older retro.`,
				...(i === 0 ? { cancelledAt: Date.now() } : {}),
			});
		}
		record.proposal = {
			prompt: "fits under the cap",
			model: null,
			summary: null,
		};

		await loop.runTurn(store.name, retro.id);

		const kid = store.listTasks().find((t) => t.followUpOf === retro.id);
		expect(kid).toBeDefined();
		expect(kid!.prompt).toContain("fits under the cap");
	});

	test("retro reply resumes with retroReplyPrompt, not the work reply", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");
		store.updateTask(retro.id, {
			sessionId: "sess-1",
			pendingPrompt: "also check the CI logs",
		});
		saveSession(store, "sess-1");

		await loop.runTurn(store.name, retro.id);

		const run = record.runs[0]!;
		expect(run.resumeId).toBe("sess-1");
		expect(run.prompt).toContain("also check the CI logs");
		// retroReplyPrompt resumes the retro, not the work reply.
		expect(run.prompt).toContain("Continue the retro.");
	});

	test("interview card runs in the main checkout, raw prompt, settles done without worktree ops", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, { commitsAhead: async () => 0 }),
		);
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}demo`,
			null,
			"interview",
		);

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.branch).toBeNull();
		// The run happened in the project checkout, never in a created worktree.
		expect(record.createWorktree).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
		expect(record.runs[0]!.cwd).toBe(store.path);
		expect(record.runs[0]!.prompt).toBe(task.prompt);
		// unsavedWork never gated the main checkout.
		expect(after.keptFiles).toEqual([]);
		// A ready outcome is normalized to answered and still settles done.
		const turns = store.listTurns(task.id);
		expect(turns[0]!.outcome).toBe("answered");
	});

	test("interview card ignores the commits-ahead gate (its AGENTS.md commit is on main)", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const projects = new Map([[store.name, fakeProject(store)]]);
		// A work task reporting answered with a commit ahead is bounced; the interview committed
		// AGENTS.md on the main checkout (no base branch), so the gate must not count it.
		const loop = createTurnLoop(
			projects,
			fakeOps(record, { commitsAhead: async () => 1 }),
		);
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}demo`,
			null,
			"interview",
		);

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(store.getTask(task.id)!.state).toBe("idle");
	});

	test("interview card with a ready outcome settles done", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};

		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "ready",
									summary: "rules written",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}demo`,
			null,
			"interview",
		);

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(store.listTurns(task.id)[0]!.outcome).toBe("answered");
	});

	test("the turn row records the agent layer the run pinned", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};

		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						layerId: "A",
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "ready",
									summary: "rules written",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}demo`,
			null,
			"interview",
		);

		await loop.runTurn(store.name, task.id);

		// The audit record (docs/specs/agent-layer-switch.md "Record"): the run's
		// pinned layer id lands on the turn row; a flat-home run records null.
		expect(store.listTurns(task.id)[0]!.layer).toBe("A");
	});

	test("backlog card runs a grill turn: no worktree, ready parks it idle in backlog", async () => {
		const record = baseRecord();
		const store = freshStore();
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				startRun: (o: {
					cwd: string;
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "ready",
									summary: "grilled",
									details: "Build X. Accept: Y. Non-goals: Z.",
								} satisfies Outcome,
							}),
						),
						kill: async () => {},
					};
				},
			}),
		);
		const task = store.createTask("an idea");
		store.updateTask(task.id, { stage: "backlog" });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("backlog");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		expect(after.branch).toBeNull();
		// No worktree was ever cut or removed; the run happened in the main checkout.
		expect(record.createWorktree).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
		expect(record.runs[0]!.cwd).toBe(store.path);
		// The user's prompt is pristine in the card; grillPrompt wraps it per turn.
		expect(after.prompt).toBe("an idea");
		expect(record.runs[0]!.prompt).toContain("grilling session");
		expect(record.runs[0]!.prompt).toContain("an idea");
		// The refined task text lands on the card for promotion.
		expect(after.details).toBe("Build X. Accept: Y. Non-goals: Z.");
	});

	test("a grill turn that ends on an ask parks needs_you with the question", async () => {
		const record = baseRecord();
		const store = freshStore();
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								asked: [
									{
										question: "Which scope?",
										options: [{ label: "a" }],
										multi: false,
										recommended: null,
									},
								],
							}),
						),
						kill: async () => {},
					};
				},
			}),
		);
		const task = store.createTask("an idea");
		store.updateTask(task.id, { stage: "backlog" });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("backlog");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("Wants your answer: Which scope?");
		expect(after.asked).toEqual([
			{
				question: "Which scope?",
				options: [{ label: "a" }],
				multi: false,
				recommended: null,
			},
		]);
	});

	test("a reply to a grilled card resumes in the main checkout and stays backlog", async () => {
		const record = baseRecord();
		const store = freshStore();
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(projects, fakeOps(record));
		const task = store.createTask("an idea");
		store.updateTask(task.id, { stage: "backlog" });
		await loop.runTurn(store.name, task.id);
		// A reply queues like the answer route does: pending text on a queued card.
		store.updateTask(task.id, {
			sessionId: "sess-1",
			pendingPrompt: "use option B",
			state: "queued",
			queuedAt: Date.now(),
		});
		saveSession(store, "sess-1");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("backlog");
		expect(after.state).toBe("idle");
		expect(record.createWorktree).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
		expect(record.runs).toHaveLength(2);
		expect(record.runs[1]!.cwd).toBe(store.path);
		expect(record.runs[1]!.prompt).toContain("use option B");
	});

	test("merge turn done: pushSha pinned when origin tip equals local target tip", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				// The Done path also reads the branch tip (OTTR-326 gate) and the mergeHead
				// anchor, so the stub answers by ref: the pin needs local === origin.
				targetSha: async (_mainPath: string, ref: string) =>
					ref === "origin/main" || ref === "refs/remotes/origin/main"
						? "abc123"
						: "branch-tip",
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "integrated",
									summary: "did it",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask("merge please");
		store.updateTask(task.id, { stage: "merging" });

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)?.stage).toBe("done");
		expect(store.getTask(task.id)?.pushSha).toBe("abc123");
	});

	test("merge turn done: pushSha stays null when origin tip differs from local target tip", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				// The local target tip and the origin tip differ, so the CI pin stays unset.
				targetSha: async (_mainPath: string, ref: string) =>
					ref === "origin/main"
						? "abc123"
						: ref === "refs/remotes/origin/main"
							? "def456"
							: "branch-tip",
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "integrated",
									summary: "did it",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask("merge please 2");
		store.updateTask(task.id, { stage: "merging" });

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)?.stage).toBe("done");
		expect(store.getTask(task.id)?.pushSha).toBeNull();
	});

	test("omp exits non-zero: task waits for you with the classify reason", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const ops = fakeOps(record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(runResult({ exitCode: 1 })),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(projects, ops);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("omp exited with code 1 before finishing.");
		// The worktree is kept: nothing landed, nothing gets deleted.
		expect(record.removeWorktree).toHaveLength(0);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe(after.needsReason);
	});

	test("a no-stderr death with dispatch context writes the same line to the turn log", async () => {
		const { store, loop } = setup({
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							exitCode: 1,
							dispatch: "local, argv 12, cwd wt, pid 4242, 41s",
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const line =
			"omp exited with code 1 before finishing (dispatch local, argv 12, cwd wt, pid 4242, 41s, no stderr).";
		expect(store.getTask(task.id)!.needsReason).toBe(line);
		expect(logText(store, task.id)).toContain(`${line}\n`);
	});

	test("tracker error: task waits for you with 'Tracker error: <msg>'", async () => {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const ops = fakeOps(record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.reject(new Error("boom")),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(projects, ops);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("Tracker error: boom");
		expect(record.removeWorktree).toHaveLength(0);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe("boom");
	});
});

// ---- coverage additions -----------------------------------------------------

const BACKGROUND_WAIT =
	"The agent ended its turn while waiting on a background job";

test("no agent run carries git host auth, merge turns included (D6)", async () => {
	setNetworkGitAuth(() => ({ GIT_SSH_COMMAND: "ssh -i /k" }));
	try {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const merge = store.createTask("merge please");
		store.updateTask(merge.id, { stage: "merging" });
		await loop.runTurn(store.name, merge.id);
		// env is always an object now; the assertion is that it carries no git auth.
		expect(record.runs[0]!.env).toEqual({});

		const work = store.createTask("work please");
		await loop.runTurn(store.name, work.id);
		expect(record.runs[1]!.env).toEqual({});
	} finally {
		setNetworkGitAuth(() => ({}));
	}
});

// OTTR-605: a card that starts before the first push (the board added the project, origin
// is still an empty repo) must park needs_you with a reason that names the "Push to
// origin" button — the real resolveTarget runs against real git here.
test("a merge turn on an origin without the target branch parks naming Push to origin", async () => {
	const run = (cwd: string, ...args: string[]): void => {
		execSync(`git ${args.join(" ")}`, { cwd, stdio: "ignore" });
	};
	const { store, loop } = setup({ resolveTarget: realResolveTarget });
	// The main checkout holds a commit; origin is an empty bare repo.
	const dir = store.path;
	const origin = mkdtempSync(join(tmpdir(), "turn-test-origin-"));
	dirs.push(origin);
	run(origin, "init", "-q", "--bare", "-b", "main");
	run(dir, "init", "-q", "-b", "main");
	run(dir, "config", "user.email", "t@t");
	run(dir, "config", "user.name", "t");
	run(dir, "commit", "-q", "--allow-empty", "-m", "seed");
	run(dir, "remote", "add", "origin", origin);
	store.setSettings({ originUrl: origin });
	const task = store.createTask("merge please");
	store.updateTask(task.id, { stage: "merging" });

	await loop.runTurn(store.name, task.id);

	const parked = store.getTask(task.id)!;
	expect(parked.state).toBe("needs_you");
	expect(parked.needsReason).toContain(
		'origin has no main branch yet, so origin/main cannot resolve. Push the local main with the board\'s "Push to origin" button',
	);
});

function baseRecord(): Recorded {
	return {
		createWorktree: [],
		removeWorktree: [],
		runs: [],
		publishRelease: [],
		runReleaseCommand: [],
		publishSoon: 0,
		notifyLog: [],
		killed: false,
		quarantine: [],
		ignoreInMain: [],
		proposal: null,
		recorded: [],
	};
}

function setup(overrides: Partial<TurnOps> = {}) {
	const store = freshStore();
	const record = baseRecord();
	const projects = new Map([[store.name, fakeProject(store)]]);
	const loop = createTurnLoop(projects, fakeOps(record, overrides));
	return { store, record, projects, loop };
}

/** Like setup, for overrides that need the record itself (e.g. integratedRun(record)). */
function setupWith(record: Recorded, overrides: Partial<TurnOps> = {}) {
	const store = freshStore();
	const projects = new Map([[store.name, fakeProject(store)]]);
	const loop = createTurnLoop(projects, fakeOps(record, overrides));
	return { store, record, projects, loop };
}

function logText(store: ProjectStore, id: string): string {
	return readFileSync(store.logPath(id), "utf8");
}

function saveSession(store: ProjectStore, sid: string): void {
	mkdirSync(store.sessionsDir, { recursive: true });
	writeFileSync(join(store.sessionsDir, `1_${sid}.jsonl`), "{}\n");
}

/** A card waiting for a reply turn on a saved session. */
function replyCard(store: ProjectStore, prompt: string, kind?: "retro") {
	const task = store.createTask(prompt, null, kind);
	store.updateTask(task.id, {
		stage: "in_progress",
		sessionId: "s1",
		pendingPrompt: "just finish it",
	});
	saveSession(store, "s1");
	return task;
}

function setImage(store: ProjectStore, id: string, name: string, body: string) {
	mkdirSync(store.imagesDir(id), { recursive: true });
	writeFileSync(join(store.imagesDir(id), name), body);
}

// settleReviews is voided inside schedule(); no completion promise exists, so drain the
// microtask/macrotask chain with setImmediate rounds — deterministic, no wall-clock duration.
async function flushPromises() {
	await Promise.resolve();
	await new Promise((r) => setImmediate(r));
	await Promise.resolve();
	await new Promise((r) => setImmediate(r));
}

/** Polls until the predicate holds, bounded. The concurrent-turn tests drain real
 * async settle chains whose round count varies (real git reads), so a fixed flush
 * count would race; this awaits the real condition instead of a guessed duration. */
async function eventually(cond: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("eventually: condition never held");
		await Bun.sleep(2);
	}
}

/** Settled read of one card: done/idle, or needs_you with its reason. */
async function settled(
	store: ProjectStore,
	id: string,
): Promise<{ stage: string; state: string; needsReason: string | null }> {
	await eventually(() => {
		const t = store.getTask(id)!;
		return t.stage === "done" || t.state === "needs_you";
	});
	const t = store.getTask(id)!;
	return { stage: t.stage, state: t.state, needsReason: t.needsReason };
}

/** startRun override whose run reports integrated: the release-approve path. */
function integratedRun(record: Recorded) {
	return (o: { prompt: string; onSession?: (sid: string) => void }) => {
		record.runs.push(o as never);
		o.onSession?.("sess-1");
		return {
			pid: 4242,
			done: Promise.resolve(
				runResult({
					outcome: {
						status: "integrated",
						summary: "approved",
					} satisfies Outcome,
				}),
			),
			kill: async () => {},
		};
	};
}

/** publishRelease override that records its argument and resolves with a tag line. */
function publishingRelease(record: Recorded) {
	return async (o: unknown) => {
		record.publishRelease.push(o);
		return "tagged";
	};
}

describe("turn helpers", () => {
	test("keptReason names the unsaved files", () => {
		expect(keptReason("M f.ts")).toBe(
			"Kept the worktree: M f.ts. Reply to continue, or Cancel to delete it.",
		);
	});

	test("parseReleaseVersion: first version, prerelease, boundaries", () => {
		expect(parseReleaseVersion("merged as v1.2.3 in #5")).toBe("v1.2.3");
		expect(parseReleaseVersion("released v1.2.3-rc.1 today")).toBe(
			"v1.2.3-rc.1",
		);
		expect(parseReleaseVersion("no version here")).toBe(null);
		expect(parseReleaseVersion("v1 is not semantic")).toBe(null);
		expect(parseReleaseVersion("xv1.2.3 has no word boundary")).toBe(null);
	});

	test("parseTopicReport: last line wins, normalized", () => {
		expect(parseTopicReport("did the thing\ntopic: auth flow")).toBe(
			"auth flow",
		);
		expect(parseTopicReport("no topic line here")).toBe(null);
		expect(parseTopicReport("see topic: not at line start")).toBe(null);
		expect(parseTopicReport("topic: first\ntopic: second")).toBe("second");
		expect(parseTopicReport("Topic: Deploy Prep")).toBe("Deploy Prep");
		expect(parseTopicReport("topic:   Spaced   Out.  ")).toBe("Spaced Out");
		expect(parseTopicReport(`topic: ${"x".repeat(50)}`)).toBe("x".repeat(40));
		expect(parseTopicReport("topic: .")).toBe(null);
	});

	test("parseTopicReport: topic has no outer whitespace", () => {
		fc.assert(
			fc.property(fc.string(), (body) => {
				const topic = parseTopicReport(`topic: ${body}`);
				fc.pre(topic !== null);
				expect(topic).toBe(topic!.trim());
			}),
			{ examples: [["! ."]] },
		);
	});

	test("turnModel: re-attaches the selector's thinking level to the transcript model", () => {
		expect(turnModel("zai/glm-5.3-flash", "zai/glm-5.3-flash:max")).toBe(
			"zai/glm-5.3-flash:max",
		);
		// No level on the selector: the transcript model stands.
		expect(turnModel("zai/glm-5.3-flash", "zai/glm-5.3-flash")).toBe(
			"zai/glm-5.3-flash",
		);
		// A base mismatch means the selector cannot have resolved to the transcript model.
		expect(turnModel("other/m", "zai/glm-5.3-flash:max")).toBe("other/m");
		// Unknown suffixes are ids, not levels (e.g. "openrouter/x:exacto").
		expect(turnModel("openrouter/x", "openrouter/x:exacto")).toBe(
			"openrouter/x",
		);
		// Missing sides pass through.
		expect(turnModel(null, "zai/glm-5.3-flash:max")).toBe(null);
		expect(turnModel("zai/glm-5.3-flash", null)).toBe("zai/glm-5.3-flash");
	});

	test("modelSwap: names the dispatched selector only when the served base differs", () => {
		// The provider-error fallback: the run served another model than dispatched.
		expect(modelSwap("zai/glm-5.3", "anthropic/claude-opus-5-5:medium")).toBe(
			"anthropic/claude-opus-5-5:medium",
		);
		// A thinking-level difference alone is not a swap: the transcript records the bare model.
		expect(modelSwap("zai/glm-5.3-flash", "zai/glm-5.3-flash:max")).toBe(null);
		expect(modelSwap("zai/glm-5.3-flash", "zai/glm-5.3-flash")).toBe(null);
		// An unknown side proves nothing.
		expect(modelSwap(null, "zai/glm-5.3-flash:max")).toBe(null);
		expect(modelSwap("zai/glm-5.3-flash", null)).toBe(null);
	});

	test("logStoreError: once per window per project", () => {
		const seen: string[] = [];
		const orig = console.error;
		console.error = (_: string, err: unknown) => seen.push(String(err));
		try {
			logStoreError("alpha", new Error("a1"));
			logStoreError("alpha", new Error("a2"));
			logStoreError("beta", new Error("b1"));
		} finally {
			console.error = orig;
		}
		expect(seen).toEqual(["Error: a1", "Error: b1"]);
	});

	test("getSettingsLogged: store settings pass through", () => {
		const { store } = setup();
		const e = fakeProject(store);
		expect(getSettingsLogged(e)).toEqual(store.getSettings());
	});

	test("getSettingsLogged: sick store gets defaults with a private copyExtra", () => {
		const seen: string[] = [];
		const orig = console.error;
		console.error = (_: string, err: unknown) => seen.push(String(err));
		try {
			const sick = {
				name: `sick-${Math.random()}`,
				getSettings() {
					throw new Error("database is locked");
				},
			} as unknown as ProjectStore;
			const s = getSettingsLogged({ store: sick } as TurnProject);
			expect(s).toEqual(DEFAULT_SETTINGS);
			s.copyExtra.push("extra");
			expect(DEFAULT_SETTINGS.copyExtra).toEqual([]);
		} finally {
			console.error = orig;
		}
	});

	test("appendLog writes the line and fires the notify hook", () => {
		const { store, record } = setup();
		const task = store.createTask("log me");
		appendLog(store, task.id, "hello");
		expect(readFileSync(store.logPath(task.id), "utf8")).toBe("hello\n");
		expect(record.notifyLog).toContainEqual([store.name, task.id]);
	});

	test.skipIf(process.platform !== "linux")(
		"appendLog refuses a log file planted as a symlink and leaves its target unchanged",
		() => {
			const { store } = setup();
			const task = store.createTask("log me");
			const outside = mkdtempSync(join(tmpdir(), "ottr-outside-"));
			try {
				const target = join(outside, "victim.txt");
				writeFileSync(target, "original\n");
				mkdirSync(dirname(store.logPath(task.id)), { recursive: true });
				symlinkSync(target, store.logPath(task.id));
				expect(() => appendLog(store, task.id, "planted")).toThrow(/refusing/);
				expect(readFileSync(target, "utf8")).toBe("original\n");
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);
});

describe("turn quarantine", () => {
	test("clean work turn with scratch: quarantined, card settles, log names the files", async () => {
		const { store, record, loop } = setup({
			// The queued merging card would otherwise auto-chain a merge turn in runTurn's
			// finally; the cap keeps the card at the settle instant these tests assert.
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			quarantineUntracked: async (worktreePath, quarantineDir) => {
				record.quarantine.push({ worktreePath, quarantineDir });
				return [".smoke-1.png", ".smoke-2.png"];
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.quarantine).toHaveLength(1);
		expect(record.quarantine[0]!.quarantineDir).toBe(
			join(store.tasksDir, "quarantine", task.id),
		);
		// isClean (default true) read after quarantine classifies as before.
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(logText(store, task.id)).toContain(
			"quarantined 2 untracked file(s) to .tasks/quarantine/" +
				task.id +
				": .smoke-1.png, .smoke-2.png",
		);
	});

	test("quarantine failure: facts still classify, failure logged, no crash", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0, // hold the chained merge turn; assert the settle instant
			commitsAhead: async () => 1,
			quarantineUntracked: async () => {
				throw new Error("git boom");
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(logText(store, task.id)).toContain("quarantine failed: git boom");
	});

	test("crash turn: quarantine not called", async () => {
		const { store, record, loop } = setup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(runResult({ exitCode: 1, outcome: null })),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.quarantine).toHaveLength(0);
	});

	test("ask turn: quarantine not called", async () => {
		const { store, record, loop } = setup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: null,
							asked: [
								{
									question: "which db?",
									options: [],
									multi: false,
									recommended: null,
								},
							],
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.quarantine).toHaveLength(0);
	});

	test("merge turn in the main checkout: quarantine not called", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("merge please");
		// A merge turn is a merging-stage task; a todo task would run as work and quarantine.
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.quarantine).toHaveLength(0);
	});

	test("interview and research cards: quarantine not called", async () => {
		const { store, record, loop } = setup();
		const interview = store.createTask(
			`${RULES_INTERVIEW_MARKER}demo`,
			null,
			"interview",
		);
		await loop.runTurn(store.name, interview.id);
		const research = store.createTask("research something");
		store.updateTask(research.id, { research: true });
		await loop.runTurn(store.name, research.id);
		expect(record.quarantine).toHaveLength(0);
	});
});

describe("merge-turn diff capture", () => {
	test("a merge turn captures the branch's stat and diff before integrating", async () => {
		const { store, loop } = setup({
			diffStat: async () => [{ file: "src/a.ts", plus: 2, minus: 1 }],
			diffText: async () => "diff --git a/src/a.ts b/src/a.ts\n",
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id);
		expect(after?.diffFiles).toEqual([{ file: "src/a.ts", plus: 2, minus: 1 }]);
		expect(after?.diffText).toBe("diff --git a/src/a.ts b/src/a.ts\n");
	});

	test("a work turn captures nothing", async () => {
		const { store, loop } = setup({
			diffStat: async () => [{ file: "src/a.ts", plus: 2, minus: 1 }],
			diffText: async () => "diff --git a/src/a.ts b/src/a.ts\n",
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)?.diffFiles).toBeNull();
		expect(store.getTask(task.id)?.diffText).toBeNull();
	});

	test("an already-integrated branch keeps the earlier capture", async () => {
		const { store, loop } = setup({
			// A retried merge turn: the first attempt landed the branch, so nothing is ahead.
			commitsAhead: async () => 0,
			diffStat: async () => [{ file: "src/a.ts", plus: 2, minus: 1 }],
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
			diffFiles: [{ file: "first.txt", plus: 1, minus: 0 }],
			diffText: "first",
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)?.diffFiles).toEqual([
			{ file: "first.txt", plus: 1, minus: 0 },
		]);
	});
});

describe("turn schedule", () => {
	test("global cap 0 starts nothing but still publishes", async () => {
		const { store, record, loop } = setup({ maxTotalRuns: () => 0 });
		store.createTask("queued");
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(0);
		expect(record.publishSoon).toBeGreaterThan(0);
	});

	test("a null global cap starts every queued card", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => null,
			// The runs hang, so the three starts this test expects stay the only ones.
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		store.setSettings({ maxParallel: null });
		store.createTask("queued one");
		store.createTask("queued two");
		store.createTask("queued three");
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(3);
	});

	test("a trending scout takes only a slot the normal picks left, one scout at a time", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => null,
			// The runs hang, so the starts this test expects stay the only ones.
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		store.setSettings({ maxParallel: 2 });
		const first = store.createTask("scout one", null, "trending");
		const second = store.createTask("scout two", null, "trending");
		store.updateTask(first.id, { queuedAt: 1 });
		store.updateTask(second.id, { queuedAt: 2 });
		store.createTask("work one");
		store.createTask("work two");
		loop.schedule();
		await flushPromises();
		// Both slots went to the normal cards, although the scouts queued first.
		expect(record.runs).toHaveLength(2);
		expect(store.getTask(first.id)!.state).toBe("queued");
		expect(store.getTask(second.id)!.state).toBe("queued");

		// Free slots: the oldest scout starts; the other waits while one scout runs.
		store.setSettings({ maxParallel: 4 });
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(3);
		expect(record.runs[2]!.prompt).toBe("scout one");
		expect(record.runs[2]!.cwd).toBe(store.path);
		expect(store.getTask(second.id)!.state).toBe("queued");
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(3);
		expect(store.getTask(second.id)!.state).toBe("queued");
	});

	test("a prompt-edit hold starts no turn until it clears", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => null,
			// The run hangs, so the one start this test expects stays the only one.
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		store.setSettings({ maxParallel: null });
		const task = store.createTask("queued work");
		// The drawer's open editor claims the hold (edit/start): a scheduler tick must
		// defer the card, or the agent runs the saved prompt over the unsaved draft.
		// The claim is PROMPT_EDIT_HELD exactly because nothing renews it — a hidden
		// tab's throttled timers must not lapse the hold mid-edit.
		store.updateTask(task.id, { holdUntil: PROMPT_EDIT_HELD });
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)?.state).toBe("queued");
		// Saving (editTask) or closing the editor (edit/stop) clears the hold; the
		// next tick starts the card.
		store.updateTask(task.id, { holdUntil: null });
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(1);
	});

	test("an update's hold starts no new turn until it lapses", async () => {
		let held = true;
		const { store, record, loop } = setup({
			drained: () => held,
			// The run hangs, so the one start this test expects stays the only one.
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("queued work");
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)?.state).toBe("queued");
		held = false;
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(1);
		expect(record.runs[0]?.prompt).toContain("queued work");
	});

	test("an update's hold still starts the board check, and only it", async () => {
		const { store, record, loop } = setup({
			drained: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		store.setSettings({ maxParallel: 1 });
		// Queued first: without the hold, this card would take the one slot.
		const work = store.createTask("queued work");
		const check = store.createTask(BOARD_CHECK_PROMPT);
		store.setBoardCheckId(check.id);
		loop.schedule();
		await flushPromises();
		expect(record.runs.map((r) => r.prompt)).toEqual([BOARD_CHECK_PROMPT]);
		expect(store.getTask(work.id)?.state).toBe("queued");
	});

	test("a dependent card starts only after its dependency is done", async () => {
		const { store, record, loop } = setup({
			// The dependency's run hangs: the default fake run resolves answered, which would
			// land the card done and start the dependent within this same flush.
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		const m1 = store.createTask("first");
		const m2 = store.createTask("second");
		store.updateTask(m2.id, { dependsOn: [m1.id] });
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(1);
		expect(record.runs[0]!.prompt).toContain("first");
		store.updateTask(m1.id, { stage: "done", state: "idle" });
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(2);
		expect(record.runs[1]!.prompt).toContain("second");
	});

	test("each tick refreshes release, arch review and open PRs per project", async () => {
		let released = 0;
		let reviewed = 0;
		let prs = 0;
		const { loop } = setup({
			refreshRelease: async () => {
				released += 1;
			},
			refreshArchReview: async () => {
				reviewed += 1;
			},
			refreshOpenPrs: () => {
				prs += 1;
			},
		});
		loop.schedule();
		await flushPromises();
		expect(released).toBe(1);
		expect(reviewed).toBe(1);
		expect(prs).toBe(1);
	});

	test("isClean result lands in dirty; a git failure keeps the old flag", async () => {
		const { store, projects, loop } = setup({ isClean: async () => true });
		const e = projects.get(store.name)!;
		e.dirty = true;
		loop.schedule();
		await flushPromises();
		expect(e.dirty).toBe(false);

		e.dirty = true;
		const failing = createTurnLoop(
			projects,
			fakeOps(baseRecord(), {
				isClean: async () => {
					throw new Error("git gone");
				},
			}),
		);
		failing.schedule();
		await flushPromises();
		expect(e.dirty).toBe(true);
	});

	test("runTurn on an unknown project is a no-op", async () => {
		const { record, loop } = setup();
		await loop.runTurn("no-such-project", "no-such-task");
		expect(record.publishSoon).toBe(0);
		expect(record.runs).toHaveLength(0);
	});
});

describe("turn runTurn guards", () => {
	test("cancelled task never starts", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, { cancelledAt: Date.now() });
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(record.createWorktree).toHaveLength(0);
		expect(record.publishSoon).toBe(0);
	});

	test("non-queued task never starts", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, { state: "needs_you" });
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(record.createWorktree).toHaveLength(0);
	});

	test("a second runTurn while one is live does not double-start", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // the settled card must not auto-chain a merge turn into the count
		});
		const task = store.createTask("work please");
		const { resolve: releaseDone } = Promise.withResolvers<RunResult>();
		const p1 = loop.runTurn(store.name, task.id);
		// First call is synchronous up to the first await; the claim is in place now.
		const p2 = loop.runTurn(store.name, task.id);
		releaseDone(runResult({}));
		await Promise.all([p1, p2]);
		expect(record.runs).toHaveLength(1);
	});

	test("cancel during worktree creation removes the fresh worktree and never starts omp", async () => {
		const { store, record, loop } = setup({
			createWorktree: async (o: { worktreePath: string }) => {
				record.createWorktree.push(o);
				store.updateTask(store.listTasks()[0]!.id, {
					cancelledAt: Date.now(),
				});
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.removeWorktree).toHaveLength(1);
		expect(record.runs).toHaveLength(0);
	});

	test("resolveTarget warning is logged", async () => {
		const { store, loop } = setup({
			resolveTarget: async () => ({
				target: "origin/main",
				sha: "sha0",
				warning: "head moved",
			}),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain("! head moved");
	});

	test("release card worktrees start from the frozen base", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("release v1.0.0");
		store.updateTask(task.id, { releaseVersion: "v1.0.0", base: "shaR" });
		await loop.runTurn(store.name, task.id);
		expect(record.createWorktree[0]).toMatchObject({ base: "shaR" });
		expect(logText(store, task.id)).toContain("(frozen release base)");
	});
});

describe("turn sessions, steering and images", () => {
	test("saved session resumes and consumes the pending prompt and images", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // no chained merge turn: its fresh-session note would pollute the log
		});
		const task = store.createTask("work please");
		saveSession(store, "s9");
		store.updateTask(task.id, {
			sessionId: "s9",
			pendingPrompt: "continue\n\nplease",
			pendingImages: ["p.png"],
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.resumeId).toBe("s9");
		expect(record.runs[0]!.prompt).toContain("continue");
		expect(
			(record.runs[0]!.images?.[0] as string | undefined)?.endsWith("p.png"),
		).toBe(true);
		expect(logText(store, task.id)).not.toContain("omp never saved session");
		const after = store.getTask(task.id)!;
		expect(after.pendingPrompt).toBe(null);
		expect(after.pendingImages).toEqual([]);
		// The delivered user text rides the turn for the timeline.
		expect(store.listTurns(task.id).at(-1)!.input).toBe("continue\n\nplease");
	});

	test("lost session starts fresh with the pending text as a note", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, { sessionId: "s9", pendingPrompt: "continue" });
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.resumeId).toBe(null);
		expect(logText(store, task.id)).toContain("! omp never saved session s9");
		expect(record.runs[0]!.prompt).toContain("work please");
		expect(record.runs[0]!.prompt).toContain("continue");
	});

	test("work turns send the task images plus pending ones, with byte sizes logged", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		setImage(store, task.id, "a.png", "abc");
		store.updateTask(task.id, { images: ["a.png"], pendingImages: ["b.png"] });
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.images).toHaveLength(2);
		const log = logText(store, task.id);
		expect(log).toContain("attached image");
		expect(log).toContain("(3 bytes)");
		expect(log).toContain("(missing)");
	});

	test("work turn copies agent-reported shots, skipping missing paths", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: ["ui.png", "nope.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		// Minimal PNG header: passes the magic-byte sniff.
		writeFileSync(
			join(wt, "ui.png"),
			Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toHaveLength(1);
		expect(after.shots[0]).toMatch(/^\d+\.png$/);
		expect(existsSync(join(store.imagesDir(task.id), after.shots[0]!))).toBe(
			true,
		);
		expect(logText(store, task.id)).toContain("! shot nope.png");
		// Copy, never move: the source stays in the worktree (tracked shots must keep
		// the tree clean for the ready gate; untracked ones are the quarantine's job).
		expect(existsSync(join(wt, "ui.png"))).toBe(true);
	});

	test("shots reported twice in one outcome are saved once", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: ["ui.png", "same.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		const png = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		writeFileSync(join(wt, "ui.png"), png);
		writeFileSync(join(wt, "same.png"), png); // byte-identical repeat
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toHaveLength(1);
		expect(readdirSync(store.imagesDir(task.id))).toHaveLength(1);
		expect(logText(store, task.id)).toContain(
			"! shot same.png: duplicate of an existing screenshot",
		);
	});

	test("re-reporting the same shots on a later turn adds nothing", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: ["ui.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		writeFileSync(
			join(wt, "ui.png"),
			Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		await loop.runTurn(store.name, task.id);
		const first = store.getTask(task.id)!;
		expect(first.shots).toHaveLength(1);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toEqual(first.shots);
		expect(readdirSync(store.imagesDir(task.id))).toHaveLength(1);
	});

	// A real decodable 16×24 8-bit gray PNG; `sub` picks Sub row filtering, so two
	// encodings of the same pixels differ byte-wise but decode identically.
	const grayPng = (
		pixels: Uint8Array,
		sub: boolean,
	): Uint8Array<ArrayBuffer> => {
		const w = 24;
		const h = 16;
		const crc32 = (buf: Buffer): number => {
			let c = ~0;
			for (const byte of buf) {
				c ^= byte;
				for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
			}
			return ~c >>> 0;
		};
		const chunk = (type: string, data: Buffer): Buffer => {
			const head = Buffer.alloc(4);
			head.writeUInt32BE(data.length);
			const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
			const crc = Buffer.alloc(4);
			crc.writeUInt32BE(crc32(body));
			return Buffer.concat([head, body, crc]);
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(w, 0);
		ihdr.writeUInt32BE(h, 4);
		ihdr[8] = 8; // bit depth
		ihdr[9] = 0; // grayscale
		const raw = Buffer.alloc(h * (w + 1));
		for (let y = 0; y < h; y++) {
			raw[y * (w + 1)] = sub ? 1 : 0;
			for (let x = 0; x < w; x++) {
				const px = pixels[y * w + x]!;
				raw[y * (w + 1) + 1 + x] =
					sub && x > 0 ? (px - pixels[y * w + x - 1]!) & 0xff : px;
			}
		}
		return Uint8Array.from(
			Buffer.concat([
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				chunk("IHDR", ihdr),
				chunk("IDAT", deflateSync(raw)),
				chunk("IEND", Buffer.alloc(0)),
			]),
		);
	};
	const screenPixels = Uint8Array.from(
		{ length: 24 * 16 },
		(_, i) => (i * 7) & 0xff,
	);
	const otherPixels = Uint8Array.from(
		{ length: 24 * 16 },
		(_, i) => (200 - i * 7) & 0xff,
	);

	test("a re-captured screen with new bytes replaces the stored shot instead of doubling", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: [record.runs.length === 1 ? "ui.png" : "ui2.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "ui.png"), grayPng(screenPixels, false));
		await loop.runTurn(store.name, task.id);
		// Same screen captured again on a later turn: re-encoded bytes, identical pixels.
		writeFileSync(join(wt, "ui2.png"), grayPng(screenPixels, true));
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toEqual(["1.png"]);
		expect(readdirSync(store.imagesDir(task.id))).toEqual(["1.png"]);
		// The stored shot now carries the newer capture's bytes.
		expect(
			readFileSync(join(store.imagesDir(task.id), "1.png")).equals(
				Buffer.from(grayPng(screenPixels, true)),
			),
		).toBe(true);
		expect(logText(store, task.id)).toContain(
			"! shot ui2.png: visually identical to 1.png — replaced it",
		);
	});

	test("a visually different new shot still appends", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: [record.runs.length === 1 ? "ui.png" : "ui2.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "ui.png"), grayPng(screenPixels, false));
		await loop.runTurn(store.name, task.id);
		writeFileSync(join(wt, "ui2.png"), grayPng(otherPixels, false));
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toHaveLength(2);
		expect(readdirSync(store.imagesDir(task.id))).toHaveLength(2);
	});

	test("one outcome reporting the same screen in two encodings saves one", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: ["ui.png", "ui2.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "ui.png"), grayPng(screenPixels, false));
		writeFileSync(join(wt, "ui2.png"), grayPng(screenPixels, true));
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toHaveLength(1);
		expect(readdirSync(store.imagesDir(task.id))).toHaveLength(1);
		expect(logText(store, task.id)).toContain(
			"! shot ui2.png: visually identical to a shot saved this turn",
		);
	});

	test("work turn adopts a shots/ directory when the outcome's shots were stripped", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							// omp 18.6.3 declares report_outcome without shots: the field never arrives.
							outcome: { status: "ready", summary: "did it" },
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(join(wt, "shots"), { recursive: true });
		writeFileSync(
			join(wt, "shots", "ui.png"),
			Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toHaveLength(1);
		expect(existsSync(join(store.imagesDir(task.id), after.shots[0]!))).toBe(
			true,
		);
		// The source stays (copy, never move); the quarantine may sweep it later,
		// after this copy landed.
		expect(existsSync(join(wt, "shots", "ui.png"))).toBe(true);
	});

	test("shots adoption skips git-tracked files in the shots/ directory", async () => {
		// The 2026-10-14 incident: a committed smoke shot rode every fresh worktree, and a
		// work turn with no reported shots adopted it as if the agent had captured it.
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			trackedFiles: (p: string, rel: string) => realTrackedFiles(p, rel),
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: { status: "ready", summary: "did it" },
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(join(wt, "shots"), { recursive: true });
		const png = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		writeFileSync(join(wt, "shots", "committed.png"), png);
		// Distinct bytes: byte-identical shots are deduped as one screenshot.
		writeFileSync(join(wt, "shots", "fresh.png"), Uint8Array.from([...png, 1]));
		execSync("git init -q -b main", { cwd: wt });
		execSync("git add shots/committed.png", { cwd: wt });
		execSync("git -c user.name=t -c user.email=t@t commit -qm c", { cwd: wt });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.shots).toEqual(["1.png"]); // the tracked shot never arrives
		expect(existsSync(join(store.imagesDir(task.id), "1.png"))).toBe(true);
	});

	test("ready with committed shots and a clean tree queues the merge, keeping the files", async () => {
		// The 2026-10-07 incident: the settle path unlinked the agent's named shots after
		// copying them; committed shots turned into ` D` rows, the ready gate read the
		// tree dirty, and the turn bounced with "uncommitted changes". Reproduced with a
		// real git worktree so isClean sees what the agent left.
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0, // hold the chained merge turn; assert the settle instant
			commitsAhead: async () => 1,
			isClean: (p: string) => gitIsClean(p), // real cleanliness, not the fake
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: [
									"shots/board-advisories.png",
									"shots/settings-kept-days.png",
								],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(join(wt, "shots"), { recursive: true });
		const png = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		writeFileSync(join(wt, "shots", "board-advisories.png"), png);
		// Distinct bytes: byte-identical shots are deduped as one screenshot.
		writeFileSync(
			join(wt, "shots", "settings-kept-days.png"),
			Uint8Array.from([...png, 1]),
		);
		execSync("git init -q -b main", { cwd: wt });
		execSync("git add .", { cwd: wt });
		execSync("git -c user.name=t -c user.email=t@t commit -qm c", { cwd: wt });
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(null);
		expect(after.shots).toHaveLength(2);
		for (const name of after.shots)
			expect(existsSync(join(store.imagesDir(task.id), name!))).toBe(true);
		// The worktree keeps its files: the tree the classifier read stays clean.
		expect(existsSync(join(wt, "shots", "board-advisories.png"))).toBe(true);
		expect(existsSync(join(wt, "shots", "settings-kept-days.png"))).toBe(true);
	});

	test("work turn changing ui files without shots logs a warning", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			changedFiles: async () => ["src/ui/app.tsx", "src/store.ts"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain(UI_SHOT_WARNING);
	});

	test("work turn changing ui files without shots re-prompts to capture one", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0, // no chained turn: the re-prompt stays pending for its assertions
			changedFiles: async () => ["src/ui/app.tsx"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// The merge queue is replaced by an automatic resume that asks for the shot.
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toContain("screenshot");
		expect(after.pendingPrompt).toContain("shots field");
		expect(logText(store, task.id)).toContain(UI_SHOT_WARNING);
	});

	test("a second ui-shot miss parks the card at needs_you instead of settling on", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			changedFiles: async () => ["src/ui/app.tsx"],
		});
		const task = store.createTask("work please");
		// The marker from an earlier miss: the auto re-prompt already ran, so this miss
		// must not sail on to merging — done without a screenshot is not an outcome.
		appendLog(store, task.id, `${UI_SHOT_WARNING}: src/ui/app.tsx`);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("screenshot");
		expect(after.pendingPrompt).toBeNull();
	});

	test("ui-shot warning alone when the turn does not settle clean", async () => {
		const { store, loop } = setup({
			changedFiles: async () => ["src/ui/app.tsx"],
			isClean: async () => false,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.pendingPrompt).toBeNull();
		expect(logText(store, task.id)).toContain(UI_SHOT_WARNING);
	});

	test("ui-shot re-prompt does not overwrite mid-run steering", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				changedFiles: async () => ["src/ui/app.tsx"],
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					store.updateTask(task.id, { pendingPrompt: "also fix the button" });
					return {
						pid: 4242,
						done: Promise.resolve(runResult()),
						kill: async () => {},
					};
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.stage).toBe("in_progress");
		expect(after.pendingPrompt).toBe("also fix the button");
		expect(logText(store, task.id)).toContain(UI_SHOT_WARNING);
	});

	test("work turn changing ui files with a copied shot logs no warning", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			changedFiles: async () => ["src/ui/app.tsx"],
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								shots: ["ui.png"],
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const wt = join(store.worktreesDir, task.id);
		mkdirSync(wt, { recursive: true });
		// Minimal PNG header: passes the magic-byte sniff.
		writeFileSync(
			join(wt, "ui.png"),
			Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.shots).toHaveLength(1);
		expect(logText(store, task.id)).not.toContain("no screenshot was attached");
	});

	test("work turn changing no ui files logs no warning", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			changedFiles: async () => ["src/store.ts"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).not.toContain("no screenshot was attached");
	});

	test("a stylesheet outside src/ui fires the guard: every project gets it", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			changedFiles: async () => ["src/components/discover.css"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		// The re-prompt names what changed and where the shot goes, not ottr's own dev board.
		expect(after.pendingPrompt).toContain("src/components/discover.css");
		expect(after.pendingPrompt).toContain("shots/");
		expect(after.pendingPrompt).not.toContain("src/dev.ts");
		expect(logText(store, task.id)).toContain(UI_SHOT_WARNING);
	});

	test("uiFiles: styles, markup, components and ui/ code count; tests and docs do not", () => {
		expect(
			uiFiles([
				"src/components/discover.css",
				"web/index.html",
				"src/ui/app.tsx",
				"src/ui/status.ts",
				"src/pages/Home.vue",
				"src/store.ts",
				"web/app.js",
				"README.md",
				"src/ui/notify.test.ts",
				"src/components/Card.test.tsx",
				"src/components/Card.stories.tsx",
				"e2e/board.tsx",
				"src/__tests__/Board.tsx",
			]),
		).toEqual([
			"src/components/discover.css",
			"web/index.html",
			"src/ui/app.tsx",
			"src/ui/status.ts",
			"src/pages/Home.vue",
		]);
	});

	test("merge turns never run the ui-shot diff", async () => {
		const { store, loop } = setup({
			changedFiles: async () => {
				throw new Error("merge turns must not diff");
			},
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-x",
			branch: "ott/x",
		});
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).not.toContain("no screenshot was attached");
	});

	test("merge turns send no images even with pending ones", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-x",
			branch: "ott/x",
			pendingImages: ["z.png"],
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.images).toEqual([]);
		expect(record.runs[0]!.prompt).toContain("ott/x");
		expect(record.runs[0]!.prompt).toContain("origin/main");
	});

	test("provider rejects the attached images: quarantine, note, one text-only retry", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // assert the settle instant; the retry runs via a direct runTurn
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				// The rejection kills omp before its first event: no session announcement.
				if (record.runs.length === 1)
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								exitCode: 1,
								sessionId: null,
								sawTerminalEnd: false,
								finalText: "",
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				o.onSession?.("sess-2");
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const task = store.createTask("work please");
		setImage(store, task.id, "1.png", "rejected-bytes");
		store.updateTask(task.id, { images: ["1.png"] });

		await loop.runTurn(store.name, task.id);

		const afterFirst = store.getTask(task.id)!;
		// Requeued for the text-only retry, not needs_you.
		expect(afterFirst.state).toBe("queued");
		expect(afterFirst.needsReason).toContain("retrying text-only");
		// The failed turn keeps the note, and the file moved rather than vanished.
		expect(store.listTurns(task.id)[0]!.error).toContain("retrying text-only");
		expect(existsSync(join(store.imagesDir(task.id), "1.png"))).toBe(false);
		expect(
			existsSync(join(store.tasksDir, "quarantine", task.id, "1.png")),
		).toBe(true);
		expect(afterFirst.images).toEqual([]);

		// The retry (the scheduler's next pick) re-sends the original prompt with no images.
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(2);
		expect(record.runs[1]!.images).toEqual([]);
		expect(record.runs[1]!.prompt).toContain("work please");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
	});

	test.skipIf(process.platform !== "linux")(
		"image quarantine refuses a symlinked quarantine dir",
		async () => {
			const outside = mkdtempSync(join(tmpdir(), "turn-quarantine-out-"));
			dirs.push(outside);
			const { store, record, loop } = setup({
				maxTotalRuns: () => 0,
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								exitCode: 1,
								sessionId: null,
								sawTerminalEnd: false,
								finalText: "",
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			});
			const task = store.createTask("work please");
			setImage(store, task.id, "1.png", "rejected-bytes");
			store.updateTask(task.id, { images: ["1.png"] });
			symlinkSync(outside, join(store.tasksDir, "quarantine"));

			await loop.runTurn(store.name, task.id);

			expect(readdirSync(outside)).toEqual([]);
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("needs_you");
			expect(after.needsReason).toContain("Image quarantine failed");
			expect(after.needsReason).toContain("refusing");
		},
	);

	test("the text-only retry failing too still lands in needs_you", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // assert the settle instant; each turn runs via a direct runTurn
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							exitCode: 1,
							sessionId: null,
							sawTerminalEnd: false,
							finalText: "",
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const task = store.createTask("work please");
		setImage(store, task.id, "1.png", "rejected-bytes");
		store.updateTask(task.id, { images: ["1.png"] });

		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.state).toBe("queued"); // first failure: quarantine + retry
		await loop.runTurn(store.name, task.id); // the retry is text-only and dies too
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("omp exited with code 1 before finishing.");
		expect(record.runs[1]!.images).toEqual([]);
		// One retry, then a human: a third run never starts.
		expect(record.runs).toHaveLength(2);
	});

	test("a text turn dying pre-event with a logged HTTP 400 names the evidence file", async () => {
		const seedDir = mkdtempSync(join(tmpdir(), "http400-turn-"));
		try {
			const { store, record, loop } = setup({
				http400Dir: seedDir,
				maxTotalRuns: () => 0, // assert the settle instant; the turn runs directly
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					// omp writes the 400 entry while the turn runs, so it lands inside
					// the turn's window by construction.
					writeFileSync(join(seedDir, `${Date.now()}-evidence1.json`), "{}");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								exitCode: 1,
								sessionId: null,
								sawTerminalEnd: false,
								finalText: "",
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			});
			const task = store.createTask("work please");

			await loop.runTurn(store.name, task.id);
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("needs_you");
			expect(after.needsReason).toContain(
				"The provider rejects this prompt's content - reword the task (evidence: ~/.omp/logs/http-400-requests/",
			);
			expect(after.needsReason!.endsWith("evidence1.json).")).toBe(true);
		} finally {
			rmSync(seedDir, { recursive: true, force: true });
		}
	});

	test("steering landing mid-run is queued as the next turn, not consumed", async () => {
		const store = freshStore();
		const record = baseRecord();
		let unsavedCalls = 0;
		const task = store.createTask("work please");
		// Cap 0: the finally's schedule() must not start the queued follow-up mid-assertion.
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					if (record.runs.length === 1) {
						store.updateTask(task.id, { pendingPrompt: "steer mid-run" });
					}
					return {
						pid: 4242,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
				unsavedWork: async () => {
					unsavedCalls += 1;
					return null;
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.stage).toBe("in_progress");
		expect(after.pendingPrompt).toBe("steer mid-run");
		// The queued steer rides the next turn; this one delivered no user text.
		expect(store.listTurns(task.id).at(-1)!.input).toBe(null);
		// Steering at turn end short-circuits before the done path.
		expect(unsavedCalls).toBe(0);
	});

	test("a model switch mid-run lands with the next turn", async () => {
		const store = freshStore();
		const record = baseRecord();
		let unsavedCalls = 0;
		const task = store.createTask("work please");
		// Cap 0: the finally's schedule() must not start the queued follow-up mid-assertion.
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				startRun: (o: {
					prompt: string;
					model?: string | null;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					if (record.runs.length === 1) {
						// Like a mid-run steer, the row write is what queues the switch.
						store.updateTask(task.id, {
							model: "switched-model",
							pendingPrompt: "steer mid-run",
						});
					}
					return {
						pid: 4242,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
				unsavedWork: async () => {
					unsavedCalls += 1;
					return null;
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		// The steer queued the follow-up turn; the model switch rode along instead of settling.
		expect(store.getTask(task.id)!.state).toBe("queued");
		await loop.runTurn(store.name, task.id);
		const second = record.runs[1] as { prompt?: string; model?: string | null };
		expect(second.model).toBe("switched-model");
		expect(second.prompt).toContain("steer mid-run");
		expect(unsavedCalls).toBe(0);
	});

	test("grown pending prompt consumes only the sent prefix", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		saveSession(store, "s9");
		store.updateTask(task.id, { sessionId: "s9", pendingPrompt: "one" });
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("s9");
					store.updateTask(task.id, {
						pendingPrompt: "one\n\ntwo",
						pendingImages: ["a", "b"],
					});
					return {
						pid: 4242,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.pendingPrompt).toBe("two");
		expect(after.pendingImages).toEqual(["a", "b"]);
	});

	test("a new steer that only starts with the sent text stays whole", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		saveSession(store, "s9");
		store.updateTask(task.id, { sessionId: "s9", pendingPrompt: "one" });
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				// During the prepare window the user cancels the steer "one" and sends a new one.
				ensurePackages: async () => {
					store.updateTask(task.id, { pendingPrompt: "one more thing" });
					return [];
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.pendingPrompt).toBe("one more thing");
	});

	test("onSession upgrades preparing to running once, then ignores repeats", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		let onSession: ((sid: string) => void) | undefined;
		const { promise: gate, resolve: releaseDone } =
			Promise.withResolvers<RunResult>();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					onSession = o.onSession;
					markStarted();
					return {
						pid: 4242,
						done: gate,
						kill: async () => {},
					};
				},
			}),
		);
		const running = loop.runTurn(store.name, task.id);
		// runTurn suspends at its first await; wait until it reached startRun.
		await started;
		// First report: preparing -> running (and todo -> in_progress for work turns).
		onSession?.("s1");
		expect(store.getTask(task.id)!.sessionId).toBe("s1");
		expect(store.getTask(task.id)!.state).toBe("running");
		// A repeat once the task left preparing is ignored, cancelled or not.
		store.updateTask(task.id, { cancelledAt: Date.now() });
		onSession?.("s2");
		expect(store.getTask(task.id)!.sessionId).toBe("s1");
		releaseDone(runResult({}));
		await running;
		const stageEvents = store
			.events()
			.filter((e) => e.kind === "stage" && e.to === "in_progress");
		expect(stageEvents).toHaveLength(1);
	});
});

describe("turn classify wiring", () => {
	test("git fact rejections fall back to their defaults", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => {
				throw new Error("no repo");
			},
			isClean: async () => {
				throw new Error("no repo");
			},
			isIntegrated: async () => {
				throw new Error("no repo");
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		// commitsAhead rejection reads as 0, so an answered turn still lands done.
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a work turn's integrated outcome is rejected without a git look", async () => {
		const record = baseRecord();
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				isIntegrated: async () => false,
				startRun: integratedRun(record),
			}),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("Work turns do not merge; report ready.");
	});

	test("a worktree that lost its git link settles done from the branch proof", async () => {
		const record = baseRecord();
		const store = freshStore();
		// Deregistered worktree shape: checkout files kept, the .git link gone entirely.
		const wt = mkdtempSync(join(tmpdir(), "turn-lost-link-"));
		dirs.push(wt);
		writeFileSync(join(wt, "kept.txt"), "checkout");
		let integratedCalls = 0;
		let mergedCalls = 0;
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				isIntegrated: async () => {
					integratedCalls += 1;
					return false;
				},
				worktreeHusk: async () => false,
				worktreeLinked: async () => false,
				branchMergedOrGone: async () => {
					mergedCalls += 1;
					return true;
				},
				startRun: integratedRun(record),
			}),
		);
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/lost-link",
			worktree: wt,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(integratedCalls).toBe(0);
		expect(mergedCalls).toBe(1);
	});

	test("a worktree that lost its git link names the real cause when the branch diverged", async () => {
		const record = baseRecord();
		const store = freshStore();
		const wt = mkdtempSync(join(tmpdir(), "turn-lost-link-"));
		dirs.push(wt);
		writeFileSync(join(wt, "kept.txt"), "checkout");
		let integratedCalls = 0;
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				isIntegrated: async () => {
					integratedCalls += 1;
					return false;
				},
				worktreeHusk: async () => false,
				worktreeLinked: async () => false,
				branchMergedOrGone: async () => false,
				startRun: integratedRun(record),
			}),
		);
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/lost-link",
			worktree: wt,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"worktree link lost and branch has unreached commits",
		);
		expect(integratedCalls).toBe(0);
	});

	test("background wait auto-continues once, then a repeat asks you", async () => {
		const { store, record, loop } = setup({
			// Cap 0: keep the auto-queued card from being re-started by the finally's schedule.
			maxTotalRuns: () => 0,
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({ exitCode: 0, sawTerminalEnd: false }),
					),
					kill: async () => {},
				};
			},
		});
		const first = store.createTask("work please");
		await loop.runTurn(store.name, first.id);
		const afterFirst = store.getTask(first.id)!;
		expect(afterFirst.state).toBe("queued");
		expect(afterFirst.pendingPrompt).toBe(
			"Your previous turn ended while a background job ran; the run exits and kills the job. Continue the task and run slow gates in the foreground.",
		);
		expect(afterFirst.needsReason).toContain(BACKGROUND_WAIT);

		// Second streak on a fresh card: the previous turn's error is already a
		// background wait, so classify demands a human.
		const second = store.createTask("work again");
		const t1 = store.startTurn(second.id, "work", "p", 1);
		store.finishTurn(t1.id, {
			endedAt: Date.now(),
			error: "earlier failure",
		});
		const t2 = store.startTurn(second.id, "work", "p", 2);
		store.finishTurn(t2.id, { endedAt: Date.now(), error: BACKGROUND_WAIT });
		await loop.runTurn(store.name, second.id);
		const afterSecond = store.getTask(second.id)!;
		expect(afterSecond.state).toBe("needs_you");
		expect(afterSecond.needsReason).toContain(`${BACKGROUND_WAIT} again`);
	});

	test("killed run finishes the turn as cancelled and keeps the worktree", async () => {
		const { store, record, loop } = setup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(runResult({ killed: true })),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.listTurns(task.id)[0]!.error).toBe("cancelled");
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("cancel landing while the run resolves finishes the turn as cancelled", async () => {
		const { store, record, loop } = setup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				store.updateTask(store.listTasks()[0]!.id, {
					cancelledAt: Date.now(),
				});
				return {
					pid: 4242,
					done: Promise.resolve(runResult({})),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.listTurns(task.id)[0]!.error).toBe("cancelled");
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("unsaved work on a done work turn keeps the worktree and records the files", async () => {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			unsavedWork: async () => "M f.ts",
			statusFiles: async () => ["f.ts"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(keptReason("M f.ts"));
		expect(after.keptFiles).toEqual(["f.ts"]);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("turn details fall back to the final text; outcome questions surface", async () => {
		const record = baseRecord();
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "needs_you",
									summary: "stuck",
									question: "why?",
								} satisfies Outcome,
								finalText: "the text",
								asked: [
									{ question: "why?", choices: [{ label: "a" }] },
								] as never,
							}),
						),
						kill: async () => {},
					};
				},
			}),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const turn = store.listTurns(task.id)[0]!;
		// outcome.details is undefined, so the final text is recorded as details.
		expect(turn.details).toBe("the text");
		expect(turn.question).toBe("why?");
		const after = store.getTask(task.id)!;
		expect(after.needsReason).toBe("Wants your answer: why?");
	});

	test("a tool ask without a report still marks the turn's question", async () => {
		const record = baseRecord();
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								asked: [
									{ question: "why?", choices: [{ label: "a" }] },
								] as never,
							}),
						),
						kill: async () => {},
					};
				},
			}),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const turn = store.listTurns(task.id)[0]!;
		// The drawer styles the echoed reason by this marker, report or no report.
		expect(turn.question).toBe("why?");
		expect(turn.error).toBe("Wants your answer: why?");
	});

	test("a needs_you report without an ask is a hold, not a question", async () => {
		const record = baseRecord();
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "needs_you",
									summary: "merge held",
									question: "Re-run the merge turn after X is merged.",
								} satisfies Outcome,
							}),
						),
						kill: async () => {},
					};
				},
			}),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const turn = store.listTurns(task.id)[0]!;
		// No ask tool call ran, so the timeline must keep the alert styling: question
		// stays null even though the report carries prose in its question field.
		expect(turn.question).toBeNull();
		expect(turn.outcome).toBe("needs_you");
		// The instruction still surfaces, as the hold reason.
		expect(turn.error).toBe("Re-run the merge turn after X is merged.");
	});

	test("removeWorktree failure on done is logged, not thrown", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			removeWorktree: async () => {
				throw new Error("busy");
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain("! removeWorktree: busy");
		expect(store.getTask(task.id)!.stage).toBe("done");
	});
});

describe("turn release cards", () => {
	function releaseTask(store: ProjectStore) {
		const task = store.createTask("release v1.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-x",
			branch: "ott/rel",
			releaseNotes: "notes body",
		});
		return task;
	}

	test("a release card's turn pins its session name", async () => {
		const { store, record, loop } = setup();
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBe("Release review");
	});

	test("a release review that would merge is bounced: reviews must not commit", async () => {
		const { store, record, loop } = setup({ isIntegrated: async () => false });
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.needsReason).toBe(
			"A release review must not commit. Cancel this release, or reply to continue.",
		);
		expect(record.publishRelease).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a Review-button review that would merge is bounced like a release review", async () => {
		const { store, record, loop } = setup({ isIntegrated: async () => false });
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, {
			stage: "merging",
			state: "queued",
			base: "shaR",
			worktree: "wt-r",
			branch: "ott/review",
		});
		await loop.runTurn(store.name, review.id);
		expect(store.getTask(review.id)?.needsReason).toBe(
			"A review must not commit. Cancel this review, or reply to continue.",
		);
		expect(record.publishRelease).toHaveLength(0);
	});

	test("an approved Review-button review waits in merging while its findings are open", async () => {
		// A review commits nothing: no commits ahead of the target.
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		const finding = store.createTask("review finding");
		store.updateTask(finding.id, {
			stage: "in_progress",
			followUpOf: review.id,
		});
		await loop.runTurn(store.name, review.id);
		const after = store.getTask(review.id);
		expect(after?.stage).toBe("merging");
		expect(after?.state).toBe("idle");
		expect(after?.needsReason).toBe(
			"waiting for the review's findings to be implemented",
		);
		expect(record.publishRelease).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a Review-button review's leftover files never keep its worktree", async () => {
		// Mutation runs leave report files, and a review must not commit: its worktree is disposable.
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			unsavedWork: async () => "uncommitted changes",
		});
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);
		expect(store.getTask(review.id)?.stage).toBe("done");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("an approved release waits while its review findings are open", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = releaseTask(store);
		// create_task links each finding to the review that filed it.
		const finding = store.createTask("review finding");
		store.updateTask(finding.id, { stage: "in_progress", followUpOf: task.id });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(
			"waiting for the review's findings to be implemented",
		);
		expect(record.publishRelease).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("an approved release publishes with the commits since the last review", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			archReviewDelta: async () => ({ delta: 12, reviewed: true, anchor: "a" }),
			startRun: integratedRun(record),
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("Released v1.0.0");
		expect(after.commits).toBe(3);
		expect(after.keptFiles).toEqual([]);
		// The tag goes on the target's head (resolveTarget's sha0), which holds the reviewed shaR.
		expect(record.publishRelease[0]).toMatchObject({
			version: "v1.0.0",
			reviewed: "shaR",
			sha: "sha0",
			notes: "notes body",
			archReview: { delta: 12 },
		});
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("release notes edited through the app route reach the publisher", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = releaseTask(store);
		store.updateTask(task.id, { state: "needs_you" });
		const dir = mkdtempSync(join(tmpdir(), "turn-test-"));
		dirs.push(dir);
		const gstore = GlobalStore.open(join(dir, "g"));
		const app = createApp({
			gstore,
			defaultDir: dir,
			projects,
			cancel: async () => ({ removed: true }),
			stopTurn: async () => ({ ok: true }),
			finishKept: async () => ({ ok: true }),
			claimedPids: () => new Set<number>(),
			schedule: () => {},
			serverVersion: "test",
			port: 0,
			publicHosts: [],
			shared: {
				maxTotalRuns: 3,
				reviewCheck: true,
				workCheck: true,
				idleReviews: true,
				trendingScan: true,
				commitIdentity: null,
				removedPaths: [],
				envValues: {},
				projectPaths: [],
				projectOrder: [],
			},
			serverRef: { current: undefined },
		});
		const server = Bun.serve({ port: 0, ...app.serveOptions });
		app.serverRef.current = server; // api() reads the connection's address through it
		try {
			const res = await fetch(
				new URL(
					`/api/projects/${store.name}/tasks/${task.id}/release-notes`,
					server.url,
				),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						// deps.port is 0 in the test mount; api() matches Host and Origin on it.
						Host: "127.0.0.1:0",
						Origin: "http://127.0.0.1:0",
					},
					body: JSON.stringify({ notes: "edited release notes" }),
				},
			);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
			gstore.close();
		}
		store.updateTask(task.id, { state: "queued" });
		await loop.runTurn(store.name, task.id);
		expect(record.publishRelease[0]).toMatchObject({
			version: "v1.0.0",
			notes: "edited release notes",
		});
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a failed publish parks the card with the release failure", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			publishRelease: async () => {
				throw new Error("push denied");
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Release failed: push denied. Fix it, then reply to retry.",
		);
	});

	test("cancel landing during the publish owns the card", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			publishRelease: async () => {
				store.updateTask(store.listTasks()[0]!.id, {
					cancelledAt: Date.now(),
				});
				return "tagged";
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		expect(store.listTurns(task.id).at(-1)!.error).toBe("cancelled");
		expect(store.getTask(task.id)!.stage).toBe("merging");
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a cancel landing during a release turn's publish is refused and the release lands", async () => {
		const record = baseRecord();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			publishRelease: async (o: unknown) => {
				record.publishRelease.push(o);
				reached.resolve();
				await gate.promise;
				return "tagged";
			},
		});
		const e = projects.get(store.name)!;
		e.target = "origin/main";
		const task = releaseTask(store);
		const turn = loop.runTurn(store.name, task.id);
		await reached.promise;
		await expect(loop.cancel(e, task.id, false)).resolves.toEqual({
			error: "release already publishing",
			status: 409,
		});
		expect(store.getTask(task.id)!.cancelledAt).toBe(null);
		expect(record.removeWorktree).toHaveLength(0);
		gate.resolve();
		await turn;
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("Released v1.0.0");
		expect(record.publishRelease).toHaveLength(1);
	});

	test("a release command gets a notes file and its output logged", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			runReleaseCommand: async (o: unknown) => {
				record.runReleaseCommand.push(o);
				return "published v1.0.0";
			},
		});
		projects.get(store.name)!.target = "origin/main";
		store.setSettings({ releaseCommand: "bin release" });
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("Released v1.0.0");
		expect(record.runReleaseCommand[0]).toMatchObject({
			command: "bin release",
			cwd: "wt-x",
			version: "v1.0.0",
		});
		const log = logText(store, task.id);
		expect(log).toContain("$ bin release");
		expect(log).toContain("published v1.0.0");
		expect(
			readFileSync(join(store.tasksDir, `release-${task.id}.md`), "utf8"),
		).toBe("notes body");
	});

	test.skipIf(process.platform !== "linux")(
		"a release notes file planted as a symlink is refused and its target stays unchanged",
		async () => {
			const record = baseRecord();
			const { store, projects, loop } = setupWith(record, {
				isIntegrated: async () => true,
				startRun: integratedRun(record),
				runReleaseCommand: async (o: unknown) => {
					record.runReleaseCommand.push(o);
					return "published v1.0.0";
				},
			});
			const outside = mkdtempSync(join(tmpdir(), "ottr-outside-"));
			try {
				const target = join(outside, "victim.txt");
				writeFileSync(target, "original\n");
				projects.get(store.name)!.target = "origin/main";
				store.setSettings({ releaseCommand: "bin release" });
				const task = releaseTask(store);
				symlinkSync(target, join(store.tasksDir, `release-${task.id}.md`));
				await loop.runTurn(store.name, task.id);
				expect(store.getTask(task.id)!.needsReason).toContain("refusing");
				expect(record.runReleaseCommand).toHaveLength(0);
				expect(readFileSync(target, "utf8")).toBe("original\n");
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);

	test("a release command frees its scheduler slot when it settles", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			runReleaseCommand: async (
				o: Parameters<TurnOps["runReleaseCommand"]>[0],
			) => {
				record.runReleaseCommand.push(o);
				// The real runReleaseCommand registers its process via onSpawn.
				o.onSpawn?.({
					pid: 4242,
					done: Promise.resolve(),
					kill: async () => {},
				});
				return "published v1.0.0";
			},
		});
		projects.get(store.name)!.target = "origin/main";
		store.setSettings({ releaseCommand: "bin release" });
		const task = releaseTask(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
		// The leak: onSpawn's entry stayed in `running` and consumed a global-cap slot.
		expect(loop.running.size).toBe(0);
	});

	test("a release command gets the commits since the last review", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			archReviewDelta: async () => ({ delta: 12, reviewed: true, anchor: "a" }),
			runReleaseCommand: async (o: unknown) => {
				record.runReleaseCommand.push(o);
				return "published v1.0.0";
			},
		});
		projects.get(store.name)!.target = "origin/main";
		store.setSettings({ releaseCommand: "bin release" });
		await loop.runTurn(store.name, releaseTask(store).id);
		expect(record.runReleaseCommand[0]).toMatchObject({
			archReview: { delta: 12 },
		});
	});
});

describe("turn settleReviews", () => {
	function parkedCard(store: ProjectStore) {
		const task = store.createTask("release v2.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "idle",
			needsReason: "waiting for the review's findings to be implemented",
			releaseVersion: "v2.0.0",
			base: "b",
			worktree: "wt",
		});
		return task;
	}

	test("a parked release publishes once its findings are done", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		loop.schedule();
		await flushPromises();
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("Released v2.0.0");
		expect(after.needsReason).toBe(null);
		expect(record.publishRelease).toHaveLength(1);
	});

	test("a cancel landing before a parked release's publish skips the publish and keeps the cancel", async () => {
		const record = baseRecord();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const { store, projects, loop } = setupWith(record, {
			archReviewDelta: async () => {
				reached.resolve();
				await gate.promise;
				return { delta: 0, reviewed: true, anchor: "a" };
			},
			publishRelease: publishingRelease(record),
		});
		const e = projects.get(store.name)!;
		e.target = "origin/main";
		const task = parkedCard(store);
		loop.schedule();
		await reached.promise;
		await loop.cancel(e, task.id, false);
		gate.resolve();
		await flushPromises();
		const after = store.getTask(task.id)!;
		expect(record.publishRelease).toHaveLength(0);
		expect(after.cancelledAt).not.toBe(null);
		expect(after.stage).not.toBe("done");
		expect(after.summary).not.toBe("Released v2.0.0");
		expect(logText(store, task.id)).toContain(
			"release skipped: the card was cancelled",
		);
	});

	test("a cancel landing during a parked release's publish is refused and the release lands", async () => {
		const record = baseRecord();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: async (o: unknown) => {
				record.publishRelease.push(o);
				reached.resolve();
				await gate.promise;
				return "tagged";
			},
		});
		const e = projects.get(store.name)!;
		e.target = "origin/main";
		const task = parkedCard(store);
		loop.schedule();
		await reached.promise;
		await expect(loop.cancel(e, task.id, false)).resolves.toEqual({
			error: "release already publishing",
			status: 409,
		});
		expect(store.getTask(task.id)!.cancelledAt).toBe(null);
		expect(record.removeWorktree).toHaveLength(0);
		gate.resolve();
		await flushPromises();
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("Released v2.0.0");
		expect(record.publishRelease).toHaveLength(1);
	});

	test("an update's hold keeps a parked release from its publish until the hold lapses", async () => {
		const record = baseRecord();
		let held = true;
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			drained: () => held,
		});
		for (const p of projects.values()) p.target = "origin/main";
		const task = parkedCard(store);
		loop.schedule();
		await flushPromises();
		expect(record.publishRelease).toHaveLength(0);
		held = false;
		loop.schedule();
		await flushPromises();
		expect(store.getTask(task.id)?.stage).toBe("done");
		expect(record.publishRelease).toHaveLength(1);
	});

	test("a parked Review-button review is done, without a publish, once its findings are done", async () => {
		const { store, record, projects, loop } = setup({
			statusFiles: async () => ["stryker-report.md"],
		});
		for (const p of projects.values()) p.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		const wt = join(store.worktreesDir, review.id);
		mkdirSync(wt, { recursive: true });
		store.updateTask(review.id, {
			stage: "merging",
			state: "idle",
			needsReason: "waiting for the review's findings to be implemented",
			base: "b",
			worktree: wt,
		});
		const finding = store.createTask("review finding");
		store.updateTask(finding.id, {
			stage: "in_progress",
			state: "needs_you",
			followUpOf: review.id,
		});
		loop.schedule();
		await flushPromises();
		expect(store.getTask(review.id)?.stage).toBe("merging");
		store.updateTask(finding.id, { stage: "done", state: "idle" });
		loop.schedule();
		await flushPromises();
		const after = store.getTask(review.id);
		expect(after?.stage).toBe("done");
		expect(after?.needsReason).toBeNull();
		expect(after?.commits).toBe(3);
		// The review's generated report files survive on the done drawer.
		expect(after?.uncommittedFiles).toEqual(["stryker-report.md"]);
		expect(record.publishRelease).toHaveLength(0);
		expect(record.runReleaseCommand).toHaveLength(0);
	});

	test("a failing settle parks the card as needs_you", async () => {
		const { store, projects, loop } = setup({
			publishRelease: async () => {
				throw new Error("no tag");
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		loop.schedule();
		await flushPromises();
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Release failed: no tag. Fix it, then reply to retry.",
		);
	});

	test("settle waits for other merging turns to finish", async () => {
		const { store, record, projects, loop } = setup();
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		const merger = store.createTask("merging now");
		store.updateTask(merger.id, { stage: "merging", state: "running" });
		loop.schedule();
		await flushPromises();
		expect(store.getTask(task.id)!.stage).toBe("merging");
		expect(record.publishRelease).toHaveLength(0);
	});

	test("a parked release publishes while a merge it holds waits in the queue", async () => {
		// The held merge waits for the publish, so settle waiting for that merge would deadlock both.
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		const late = store.createTask("added during the review");
		store.updateTask(late.id, {
			stage: "merging",
			state: "queued",
			branch: "ott/late",
		});
		loop.schedule();
		await flushPromises();
		expect(store.getTask(task.id)?.stage).toBe("done");
		expect(record.publishRelease).toHaveLength(1);
	});

	test("no target: settle does nothing", async () => {
		const { store, record, loop } = setup();
		const task = parkedCard(store);
		loop.schedule();
		await flushPromises();
		expect(store.getTask(task.id)!.stage).toBe("merging");
		expect(record.publishRelease).toHaveLength(0);
	});

	test("cards without the parked shape are ignored", async () => {
		const { store, record, projects, loop } = setup();
		projects.get(store.name)!.target = "origin/main";
		const task = store.createTask("release v3.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "idle",
			// needsReason stays null: not a parked card
			releaseVersion: "v3.0.0",
			base: "b",
			worktree: "wt",
		});
		loop.schedule();
		await flushPromises();
		expect(store.getTask(task.id)!.state).toBe("idle");
		expect(record.publishRelease).toHaveLength(0);
	});

	test("parked releases in two projects share the global cap within one tick (R3-5)", async () => {
		const record = baseRecord();
		const a = freshStore();
		const b = freshStore();
		const loop = createTurnLoop(
			new Map([
				[a.name, { ...fakeProject(a), target: "origin/main" }],
				[b.name, { ...fakeProject(b), target: "origin/main" }],
			]),
			fakeOps(record, {
				maxTotalRuns: () => 1,
				// Both commands stay open: without a slot claim before the first await, the
				// second project's settle starts too.
				runReleaseCommand: (o: Parameters<TurnOps["runReleaseCommand"]>[0]) => {
					record.runReleaseCommand.push(o);
					o.onSpawn?.({
						pid: 4242,
						done: new Promise<void>(() => {}),
						kill: async () => {},
					});
					return new Promise<string>(() => {});
				},
			}),
		);
		a.setSettings({ releaseCommand: "bin release" });
		b.setSettings({ releaseCommand: "bin release" });
		parkedCard(a);
		parkedCard(b);
		loop.schedule();
		await flushPromises();
		expect(record.runReleaseCommand).toHaveLength(1);
	});
});

describe("turn merge outcomes", () => {
	test("an integrated merge turn stamps the release version", async () => {
		const { store, record, loop } = setup({
			isIntegrated: async () => true,
			// A real tag of the released name points at the pushed head.
			targetSha: async () => "sha-pushed",
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "Released v7.7.7",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.releaseVersion).toBe("v7.7.7");
	});

	test("an answered merge turn asks you about the unexpected outcome", async () => {
		const { store, loop } = setup();
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			'Unexpected outcome "answered" in a merge turn.',
		);
	});
});

describe("turn survivor rounds", () => {
	test("settleReviews skips cards failing any parked predicate", async () => {
		const shapes = [
			{ stage: "in_progress" as const },
			{ state: "running" as const },
			{ needsReason: null },
			{ releaseVersion: null },
			{ base: null },
			{ worktree: null },
			{ cancelledAt: Date.now() },
		];
		for (const patch of shapes) {
			const record = baseRecord();
			const { store, projects, loop } = setupWith(record, {
				publishRelease: publishingRelease(record),
			});
			projects.get(store.name)!.target = "origin/main";
			const task = store.createTask("release v9.0.0");
			store.updateTask(task.id, {
				stage: "merging",
				state: "idle",
				needsReason: "waiting for the review's findings to be implemented",
				releaseVersion: "v9.0.0",
				base: "b",
				worktree: "wt",
				...patch,
			});
			loop.schedule();
			await flushPromises();
			const after = store.getTask(task.id)!;
			expect(after.stage).not.toBe("done");
			expect(record.publishRelease).toHaveLength(0);
			store.close();
		}
	});

	test("settleReviews ignores idle and needs_you merging rows as blockers", async () => {
		for (const blockerState of ["idle", "needs_you"] as const) {
			const record = baseRecord();
			const { store, projects, loop } = setupWith(record, {
				publishRelease: publishingRelease(record),
			});
			projects.get(store.name)!.target = "origin/main";
			// The blocker row predates the card and is cancelled: not a finding for
			// findingsHold, and its idle/needs_you state does not block settling.
			const other = store.createTask("other merge");
			store.updateTask(other.id, {
				stage: "merging",
				state: blockerState,
				cancelledAt: Date.now(),
			});
			const task = store.createTask("release v9.1.0");
			store.updateTask(task.id, {
				stage: "merging",
				state: "idle",
				needsReason: "waiting for the review's findings to be implemented",
				releaseVersion: "v9.1.0",
				base: "b",
				worktree: "wt",
			});
			loop.schedule();
			await flushPromises();
			expect(store.getTask(task.id)!.stage).toBe("done");
			expect(record.publishRelease).toHaveLength(1);
			store.close();
		}
	});

	test("parseReleaseVersion: multi-digit and multi-component versions", () => {
		expect(parseReleaseVersion("v10.20.30 lands")).toBe("v10.20.30");
		expect(parseReleaseVersion("v1.2.3.4")).toBe("v1.2.3.4");
		expect(parseReleaseVersion("V1.2.3 upper case")).toBe(null);
	});

	test("a pending prompt without a session rides along with the work images", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			images: ["a.png"],
			pendingImages: ["b.png"],
			pendingPrompt: "also this",
		});
		await loop.runTurn(store.name, task.id);
		// No session: the prompt is resent, so its images plus pending ones go out.
		expect(record.runs[0]!.images).toHaveLength(2);
		expect(record.runs[0]!.prompt).toContain("also this");
	});

	test("a merge turn's onSession does not touch the stage", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "no version here",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
			isIntegrated: async () => true,
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		const events = store
			.events()
			.filter((e) => e.kind === "stage" && e.to === "in_progress");
		expect(events).toHaveLength(0);
		// Integrated summary without a version stamps nothing.
		expect(store.getTask(task.id)!.releaseVersion).toBe(null);
	});

	test("out-of-order pending images are not treated as the sent prefix", async () => {
		const record = baseRecord();
		const store = freshStore();
		const task = store.createTask("work please");
		saveSession(store, "s9");
		store.updateTask(task.id, {
			sessionId: "s9",
			pendingPrompt: "one",
			pendingImages: ["a"],
		});
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("s9");
					store.updateTask(task.id, { pendingImages: ["b", "a"] });
					return {
						pid: 4242,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		// ["b","a"] does not start with the sent ["a"], so nothing is sliced off.
		expect(store.getTask(task.id)!.pendingImages).toEqual(["b", "a"]);
	});

	test("a re-queued turn stamps queuedAt and leaves commits alone", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("sess-1");
					store.updateTask(task.id, { pendingPrompt: "steer" });
					return {
						pid: 4242,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.queuedAt).toBeGreaterThan(0);
		expect(after.commits).toBe(null);
	});

	test("a done work turn never stamps a release version", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "Released v5.5.5",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
			isIntegrated: async () => true,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		// Only merge turns stamp versions from integrate reports.
		expect(store.getTask(task.id)!.releaseVersion).toBe(null);
	});
});

describe("turn ci watch pinning", () => {
	function mergeDoneSetup(overrides: Partial<TurnOps>) {
		const record = baseRecord();
		const setup = setupWith(record, {
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "landed",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
			...overrides,
		});
		const task = setup.store.createTask("merge please");
		setup.store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		return { ...setup, task };
	}

	test("matching local and pushed tips pin the push sha", async () => {
		const shaCalls: [string, string][] = [];
		const { store, record, loop, task } = mergeDoneSetup({
			targetSha: async (mainPath: string, ref: string) => {
				shaCalls.push([mainPath, ref]);
				return "sha-pushed";
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(shaCalls).toEqual([
			// The push refusal reads the local tip first (OTTR-326), then the Done write stamps
			// the mergeHead anchor, then CI watch pins from the local and origin tips.
			[store.path, "refs/heads/main"],
			[store.path, "origin/main"],
			[store.path, "origin/main"],
			[store.path, "refs/remotes/origin/main"],
		]);
		expect(store.getTask(task.id)!.pushSha).toBe("sha-pushed");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("an integrate report naming a version stamps it when a tag points at the pushed head", async () => {
		const { store, loop, task } = mergeDoneSetup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "Released v1.2.3",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		// The default fake targetSha resolves every ref, the tag included, to "sha-pushed".
		expect(store.getTask(task.id)!.releaseVersion).toBe("v1.2.3");
		expect(store.getTask(task.id)!.pushSha).toBe("sha-pushed");
	});

	test("a version in the report prose without a tag does not stamp", async () => {
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("refs/tags/") ? null : "sha-pushed",
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary:
									"61ca050 docs(readme): fix stale facts and describe v1.2.3 features",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.releaseVersion).toBe(null);
		// The CI-watch pin is independent of the stamp.
		expect(store.getTask(task.id)!.pushSha).toBe("sha-pushed");
		expect(logText(store, task.id)).toContain(
			"- no release stamp for v1.2.3: no tag on the pushed head",
		);
	});

	test("a tag pointing at another commit does not stamp", async () => {
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("refs/tags/") ? "tagged-elsewhere" : "sha-pushed",
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "Released v1.2.3",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.releaseVersion).toBe(null);
	});

	test("a pushed tip that differs from the local target skips the pin", async () => {
		const { store, record, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("origin/") ? "local-tip" : "older-origin-tip",
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.pushSha).toBe(null);
		expect(logText(store, task.id)).toContain(
			"- CI watch skipped: merge push not on origin",
		);
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("unresolvable tips skip the pin", async () => {
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async () => {
				throw new Error("no such ref");
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.pushSha).toBe(null);
		expect(logText(store, task.id)).toContain(
			"- CI watch skipped: merge push not on origin",
		);
	});

	test("the server push runs before the integration check, so a local-only merge lands", async () => {
		let pushed = false;
		const calls: [string, string, string, string][] = [];
		const { store, record, loop, task } = mergeDoneSetup({
			// Origin holds the merge only after the server push: the check must come after it.
			isIntegrated: async () => pushed,
			serverMergePush: async (
				mainPath: string,
				wt: string,
				target: string,
				branch: string,
			) => {
				calls.push([mainPath, wt, target, branch]);
				pushed = true;
				return { status: "pushed" as const, output: "" };
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(calls).toEqual([[store.path, "wt-m", "origin/main", "ott/m"]]);
		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(record.removeWorktree).toHaveLength(1);
		expect(logText(store, task.id)).toContain(
			"- pushed origin/main from the server",
		);
	});

	test("a held merge with patches beyond the approved head parks instead of pushing", async () => {
		const pushes: string[] = [];
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("origin/") ? "sha-pushed" : "sha-local-main",
			serverMergePush: async (_m: string, _w: string, target: string) => {
				pushes.push(target);
				return { status: "pushed" as const, output: "" };
			},
			mergeHoldMismatch: async () => ({
				mismatch: true,
				pushDiff: "diff --git a/evil.txt b/evil.txt",
				auditedTip: null,
			}),
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(pushes).toEqual([]);
		expect(t.stage).toBe("in_progress");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(MERGE_HOLD_MISMATCH_REASON);
		expect(t.holdHead).toBe("sha-local-main");
		// The park stores the flagged push-side delta so the reviewer reads what failed.
		expect(t.diffText).toBe("diff --git a/evil.txt b/evil.txt");
	});

	test("a held fork merge with patches beyond the approved head parks too", async () => {
		const pushes: string[] = [];
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async () => "sha-local-main",
			serverMergePush: async () => {
				pushes.push("origin/main");
				return { status: "pushed" as const, output: "" };
			},
			mergeHoldMismatch: async () => ({
				mismatch: true,
				pushDiff: null,
				auditedTip: null,
			}),
		});
		store.updateTask(task.id, { forkMergeHead: "sha-approved" });
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(pushes).toEqual([]);
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(MERGE_HOLD_MISMATCH_REASON);
		expect(t.diffText).toBeNull();
	});

	test("an approved head already on origin settles a stale local main without a park", async () => {
		const pushes: string[] = [];
		const { store, record, loop, task } = mergeDoneSetup({
			// VELV-89: the agent's own push moved only origin, so the local branch sits behind
			// it and the ordinary worktree proof cannot see the landing.
			isIntegrated: async () => false,
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "refs/heads/main" ? "sha-stale-local" : "sha-approved",
			mergeHoldLanded: async () => true,
			mergeHoldMismatch: async () => {
				throw new Error("a landed merge must not reach the mismatch gate");
			},
			serverMergePush: async () => {
				pushes.push("origin/main");
				return { status: "pushed" as const, output: "" };
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		// The remote target already holds the work: no push, no park, the card lands.
		expect(pushes).toEqual([]);
		expect(t.stage).toBe("done");
		expect(t.state).toBe("idle");
		expect(t.needsReason).toBeNull();
		expect(t.holdHead).toBeNull();
		expect(record.removeWorktree).toHaveLength(1);
		expect(logText(store, task.id)).toContain(
			"- approved head already on origin/main: the merge landed without the local branch moving",
		);
	});

	test("a hold probe that cannot fetch still parks on the gate's failure", async () => {
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "refs/heads/main" ? "sha-stale-local" : "sha-origin",
			// The probe fetch failed; the gate re-fetches and fails closed too.
			mergeHoldLanded: async () => false,
			mergeHoldMismatch: async () => ({
				mismatch: true,
				pushDiff: "diff --git a/evil.txt b/evil.txt",
				auditedTip: null,
			}),
			serverMergePush: async () => {
				throw new Error("a parked hold must not push");
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(MERGE_HOLD_MISMATCH_REASON);
		expect(t.holdHead).toBe("sha-stale-local");
	});

	test("extra patches on the remote beyond the approved head still park a stale local main", async () => {
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "refs/heads/main" ? "sha-stale-local" : "sha-origin",
			// Containment held but the remote carries patches beyond the approval.
			mergeHoldLanded: async () => false,
			mergeHoldMismatch: async () => ({
				mismatch: true,
				pushDiff: "diff --git a/evil.txt b/evil.txt",
				auditedTip: "sha-origin",
			}),
			resetBranchTo: async () => true,
			serverMergePush: async () => {
				throw new Error("a parked hold must not push");
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(MERGE_HOLD_MISMATCH_REASON);
		expect(t.diffText).toBe("diff --git a/evil.txt b/evil.txt");
	});

	test("a mismatch park resets the branch, so the next card's push excludes the held patches", async () => {
		// Fake branch state: card A's merge left the held patches as the local tip.
		let branchTip = "sha-A-patches";
		const resets: [string, string][] = [];
		const pushes: string[] = [];
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("origin/")
					? "sha-origin"
					: ref === "refs/heads/main"
						? branchTip
						: null,
			mergeHoldMismatch: async () => ({
				mismatch: true,
				pushDiff: "diff --git a/evil.txt b/evil.txt",
				auditedTip: "sha-origin",
			}),
			resetBranchTo: async (_m: string, branch: string, tip: string) => {
				resets.push([branch, tip]);
				branchTip = tip;
				return true;
			},
			serverMergePush: async (_m: string, _w: string, target: string) => {
				pushes.push(`${target}@${branchTip}`);
				return { status: "pushed" as const, output: "" };
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const a = store.getTask(task.id)!;
		expect(a.stage).toBe("in_progress");
		expect(a.state).toBe("needs_you");
		expect(a.holdHead).toBe("sha-A-patches");
		// The park moved the local target branch back to the audited origin tip.
		expect(resets).toEqual([["main", "sha-origin"]]);
		expect(a.diffText).toBe("diff --git a/evil.txt b/evil.txt");

		// Card B merges with no approved heads: its push carries only its own work.
		const b = store.createTask("merge b please");
		store.updateTask(b.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/b",
		});
		await loop.runTurn(store.name, b.id);
		expect(pushes).toEqual(["origin/main@sha-origin"]);
		expect(store.getTask(b.id)!.stage).toBe("done");
	});

	test("a park that cannot reset the branch pins later pushes of the held tip", async () => {
		const pushes: string[] = [];
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("origin/")
					? "sha-origin"
					: ref === "refs/heads/main"
						? "sha-A-patches"
						: null,
			mergeHoldMismatch: async () => ({
				// The gate fetch failed: no audited tip, so the park cannot reset the branch.
				mismatch: true,
				pushDiff: "diff --git a/evil.txt b/evil.txt",
				auditedTip: null,
			}),
			resetBranchTo: async () => {
				throw new Error("must not reset without an audited tip");
			},
			serverMergePush: async () => {
				pushes.push("origin/main");
				return { status: "pushed" as const, output: "" };
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const a = store.getTask(task.id)!;
		expect(a.state).toBe("needs_you");
		expect(a.needsReason).toBe(MERGE_HOLD_MISMATCH_REASON);

		const b = store.createTask("merge b please");
		store.updateTask(b.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/b",
		});
		await loop.runTurn(store.name, b.id);
		expect(pushes).toEqual([]);
		const bt = store.getTask(b.id)!;
		expect(bt.stage).toBe("merging");
		expect(bt.state).toBe("needs_you");
		expect(bt.needsReason).toContain(`card #${task.id} parks a held merge`);
	});

	test("a merge whose head is exactly the approved push head pushes without the patch compare", async () => {
		const { store, loop, task } = mergeDoneSetup({
			targetSha: async (_mainPath: string, ref: string) =>
				ref.startsWith("origin/") ? "sha-pushed" : "sha-approved",
			serverMergePush: async () => ({ status: "pushed" as const, output: "" }),
			mergeHoldMismatch: async () => {
				throw new Error("must not compare when the head is the approved one");
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a merge without a hold approval is not gated", async () => {
		const { store, loop, task } = mergeDoneSetup({
			mergeHoldMismatch: async () => {
				throw new Error("no hold columns set: nothing to compare");
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a held merge that passes the gate pins the push to the audited tip", async () => {
		const calls: unknown[][] = [];
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async (...args: unknown[]) => {
				calls.push(args);
				return { status: "pushed" as const, output: "" };
			},
			mergeHoldMismatch: async () => ({
				mismatch: false,
				pushDiff: null,
				auditedTip: "sha-audited",
			}),
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(calls.at(-1)![4]).toBe("sha-audited");
	});

	test("a merge agent that removed its worktree still gets the server push", async () => {
		const calls: string[] = [];
		// The worktree is alive when the turn dispatches; the merge agent removes it during
		// its run, so the husk only shows at the settle (OTTR-341 never dispatches into one).
		let removed = false;
		const { store, loop, task } = mergeDoneSetup({
			worktreeHusk: async () => removed,
			branchMergedOrGone: async () => true,
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				removed = true;
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "landed",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
			serverMergePush: async (
				_m: string,
				_w: string,
				_t: string,
				branch: string,
			) => {
				calls.push(branch);
				return { status: "pushed" as const, output: "" };
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(calls).toEqual(["ott/m"]);
		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(logText(store, task.id)).toContain(
			"- pushed origin/main from the server",
		);
	});

	test("a needs_you report on a push authentication failure resolves to integrated once the server pushed", async () => {
		let pushed = false;
		const { store, record, loop, task } = mergeDoneSetup({
			isIntegrated: async () => pushed,
			serverMergePush: async () => {
				pushed = true;
				return {
					status: "pushed" as const,
					output:
						"To git.example.com:a/r.git\n   1111111..2222222  main -> main",
				};
			},
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "push blocked",
								details:
									"fatal: Authentication failed for 'https://git.example.com/a/r.git/'",
								question: "Can you push main for me?",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("done");
		expect(record.removeWorktree).toHaveLength(1);
		const turn = store.listTurns(task.id).at(-1)!;
		expect(turn.outcome).toBe("integrated");
		expect(turn.details).toContain("main -> main");
	});

	test("a needs_you report for another reason stays needs_you after a server push", async () => {
		const { store, loop, task, record } = mergeDoneSetup({
			serverMergePush: async () => ({ status: "pushed" as const, output: "" }),
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "conflict",
								question: "Which side wins in src/a.ts?",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.state).toBe("needs_you");
	});

	test("a failed server push keeps the card at merging with git's reason and the worktree", async () => {
		const { store, record, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "failed" as const,
				error: "fatal: [REDACTED] rejected",
			}),
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(
			"Server push to origin failed: fatal: [REDACTED] rejected",
		);
		// OTTR-465: without a pinned URL no re-check can run, so the retry stays off and says so.
		expect(logText(store, task.id)).toContain("no pinned origin URL");
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a server push refused by a GitHub branch rule parks with the PR-mode hint", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "failed" as const,
				error:
					"remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Changes must be made through a pull request.",
			}),
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toContain("PR mode");
		expect(t.needsReason).toContain(
			"This push was refused by a GitHub branch rule",
		);
	});

	test("a plain server push failure parks without the PR-mode hint", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "failed" as const,
				error: "remote: HTTP Basic: Access denied",
			}),
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).not.toContain("PR mode");
	});

	test("OTTR-743: a cannot-lock-ref push the remote already held lands as done with the recovery reason", async () => {
		const { store, record, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "pushed" as const,
				output: `${PUSH_LANDED_BEFORE_ATTEMPT}: the remote ref moved while the push ran ("cannot lock ref"), and the fetched main already contains the pushed head`,
			}),
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		// Same state as a successful push: the card lands, no needs_you, the worktree goes.
		expect(t.stage).toBe("done");
		expect(t.needsReason).toBeNull();
		expect(record.removeWorktree).toHaveLength(1);
		// One log line names the reason.
		expect(logText(store, task.id)).toContain(
			"- push landed on origin before this attempt",
		);
	});

	test("OTTR-743: a cannot-lock-ref push whose head origin lacks parks as today", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "failed" as const,
				error:
					"! [remote rejected] main -> main (cannot lock ref 'refs/heads/main': is at ba8b25e but expected 1b467ba)",
			}),
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(
			"Server push to origin failed: ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main': is at ba8b25e but expected 1b467ba)",
		);
	});

	test("a rejected server push fetches origin and queues a rebase merge turn, not needs_you", async () => {
		const fetches: string[] = [];
		let pushes = 0;
		const { store, record, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return pushes === 1
					? {
							status: "rejected" as const,
							error: "! [rejected] main -> main (non-fast-forward)",
						}
					: { status: "pushed" as const, output: "" };
			},
			fetchOriginBranch: async (
				_mainPath: string,
				branch: string,
				originUrl: string,
			) => {
				fetches.push(`${branch}@${originUrl}`);
				return null;
			},
		});
		// maxParallel 0 keeps the scheduler's post-settle schedule() from auto-starting the
		// queued rebase turn mid-assertion; phase 2 below starts it like the merge slot would.
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// The card lands queued with the rebase prompt, not parked at needs_you.
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBeNull();
		expect(after.pushRetries).toBe(1);
		// OTTR-510 re-fetch: the steer's queue fetches origin again before the turn goes out.
		expect(fetches).toEqual([
			"main@ssh://git.example.com/a/r.git",
			"main@ssh://git.example.com/a/r.git",
		]);
		expect(after.pendingPrompt).toContain(
			"rebase the local target branch onto origin/main",
		);
		expect(after.pendingPrompt).toContain("automatic rebase retry 1 of 2");
		expect(after.pendingBy).toBe("supervisor");
		expect(logText(store, task.id)).toContain(
			"server push rejected: origin moved, merge turn queued to rebase (retry 1 of 2)",
		);
		expect(record.removeWorktree).toHaveLength(0);
		// The queued turn runs with the rebase prompt, the push runs again, and the card lands.
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(pushes).toBe(2);
		expect(record.runs[1]!.prompt).toContain(
			"rebase the local target branch onto origin/main",
		);
		expect(store.listTurns(task.id)[1]!.inputBy).toBe("supervisor");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("origin moved while a card merges: the automatic rebase and gates converge and no steer goes out", async () => {
		let pushes = 0;
		const rebases: string[] = [];
		const gates: string[] = [];
		const { store, record, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return pushes === 1
					? {
							status: "rejected" as const,
							error: "! [rejected] main -> main (non-fast-forward)",
						}
					: { status: "pushed" as const, output: "" };
			},
			fetchOriginBranch: async () => null,
			rebaseTargetBranch: async (mainPath: string, branch: string) => {
				rebases.push(`${mainPath}:${branch}`);
				return { ok: true as const };
			},
			runMergeGates: async (mainPath: string) => {
				gates.push(mainPath);
				return { ok: true, output: "" };
			},
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// The retry push landed: the card is done, no recovery steer, no budget spent.
		expect(after.stage).toBe("done");
		expect(after.pendingPrompt).toBeNull();
		expect(after.pushRetries).toBe(0);
		expect(pushes).toBe(2);
		expect(rebases).toEqual([`${store.path}:main`]);
		expect(gates).toEqual([store.path]);
		expect(logText(store, task.id)).toContain(
			"merge gates passed on the rebased main",
		);
		expect(logText(store, task.id)).not.toContain(
			"automatic rebase retry 1 of 2",
		);
		expect(logText(store, task.id)).not.toContain(
			"merge turn queued to rebase",
		);
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("a conflicting automatic rebase still queues the steer and runs no gates", async () => {
		let pushes = 0;
		let gateRuns = 0;
		const { store, record, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return {
					status: "rejected" as const,
					error: "! [rejected] main -> main (non-fast-forward)",
				};
			},
			fetchOriginBranch: async () => null,
			rebaseTargetBranch: async () => ({
				ok: false as const,
				conflict: true,
				error: "CONFLICT (content): Merge conflict in src/a.ts",
			}),
			runMergeGates: async () => {
				gateRuns += 1;
				return { ok: true, output: "" };
			},
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.pushRetries).toBe(1);
		expect(after.pendingPrompt).toContain("automatic rebase retry 1 of 2");
		expect(gateRuns).toBe(0);
		expect(pushes).toBe(1);
		const log = logText(store, task.id);
		expect(log).toContain("the automatic rebase of main hit a conflict");
		expect(log).toContain(
			"server push rejected: origin moved, merge turn queued to rebase (retry 1 of 2)",
		);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("failed merge gates on the rebased target queue the steer before any second push", async () => {
		let pushes = 0;
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return {
					status: "rejected" as const,
					error: "! [rejected] main -> main (non-fast-forward)",
				};
			},
			fetchOriginBranch: async () => null,
			rebaseTargetBranch: async () => ({ ok: true as const }),
			runMergeGates: async () => ({
				ok: false,
				output: "bun run check exited 1\nerror: check failed",
			}),
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.pushRetries).toBe(1);
		expect(pushes).toBe(1);
		const log = logText(store, task.id);
		expect(log).toContain("merge gates failed on the rebased main");
		expect(log).toContain("merge gates output");
	});

	test("a still-rejected retry push queues the steer on a fresh fetch", async () => {
		const fetches: string[] = [];
		let pushes = 0;
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return {
					status: "rejected" as const,
					error: "! [rejected] main -> main (non-fast-forward)",
				};
			},
			fetchOriginBranch: async (
				_mainPath: string,
				branch: string,
				originUrl: string,
			) => {
				fetches.push(`${branch}@${originUrl}`);
				return null;
			},
			rebaseTargetBranch: async () => ({ ok: true as const }),
			runMergeGates: async () => ({ ok: true, output: "" }),
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.pushRetries).toBe(1);
		expect(pushes).toBe(2);
		expect(fetches).toHaveLength(2);
		expect(logText(store, task.id)).toContain(
			"the retry push of origin/main rejected after the automatic rebase",
		);
	});

	test("a failed push under a bare 403 appends the GitHub SAML hint to the park reason", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "failed" as const,
				error:
					"fatal: unable to access 'https://acme.ghe.com/o/r.git/': The requested URL returned error: 403",
				output: "! [RESTRICTED]",
			}),
			githubAuthHint: async () =>
				"\nGitHub: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to an organization that has SAML SSO enabled.",
		});
		store.setSettings({
			originUrl: "https://acme.ghe.com/o/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toContain("Server push to origin failed:");
		expect(t.needsReason).toContain(
			"Resource protected by organization SAML enforcement",
		);
	});

	test("a failed push where the probe cannot answer parks the bare git error only", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "failed" as const,
				error:
					"fatal: unable to access 'https://acme.ghe.com/o/r.git/': The requested URL returned error: 403",
				output: "! [RESTRICTED]",
			}),
			githubAuthHint: async () => null,
		});
		store.setSettings({
			originUrl: "https://acme.ghe.com/o/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toContain("Server push to origin failed:");
		expect(t.needsReason).toContain("returned error: 403");
		expect(t.needsReason).not.toContain("GitHub:");
	});

	test("a failed (non-conflict) automatic rebase parks needs_you", async () => {
		let pushes = 0;
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return {
					status: "rejected" as const,
					error: "! [rejected] main -> main (non-fast-forward)",
				};
			},
			fetchOriginBranch: async () => null,
			rebaseTargetBranch: async () => ({
				ok: false as const,
				conflict: false,
				error: "fatal: cannot rebase: You have unstaged changes",
			}),
			runMergeGates: async () => ({ ok: true, output: "" }),
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toContain("Server push to origin failed:");
		expect(t.needsReason).toContain(
			"the automatic rebase failed: fatal: cannot rebase: You have unstaged changes",
		);
		expect(t.pendingPrompt).toBeNull();
		expect(t.pushRetries).toBe(0);
		expect(pushes).toBe(1);
	});

	test("a rejected push holds the project's other merges until main reaches origin", async () => {
		let pushes = 0;
		const {
			store,
			record,
			loop,
			projects,
			task: a,
		} = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return pushes === 1
					? {
							status: "rejected" as const,
							error: "! [rejected] main -> main (non-fast-forward)",
						}
					: { status: "pushed" as const, output: "" };
			},
			fetchOriginBranch: async () => null,
			// The tick's refresh reads the same git fact the eager flag writes: unpushed
			// between the rejected push and the repairing one, pushed after it.
			branchUnpushed: async () => pushes === 1,
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		// Card b queued before a's rejection: queue order alone would start b first and
		// pile its merge onto the unpushed main (the 2026-11-04 incident). The hold must
		// invert the order: the rejected card's rebase retry repairs main first.
		const b = store.createTask("merge b please");
		store.updateTask(b.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/b",
		});
		await loop.runTurn(store.name, a.id);
		const after = store.getTask(a.id)!;
		expect(after.state).toBe("queued");
		expect(after.pushRetries).toBe(1);
		// The rejection holds the project's merges at once, before any tick's refresh.
		expect(projects.get(store.name)!.mainUnpushed).toBe(true);
		// Exactly the gate schedule() runs: only the retry card may start; once main
		// reached origin, b is the runnable merge again.
		const gate = (unpushed: boolean) =>
			pickRunnable(store.listTasks(), {
				maxParallel: null,
				hasRules: true,
				mainUnpushed: unpushed,
			}).map((t) => t.id);
		expect(gate(true)).toEqual([a.id]);
		expect(gate(false)).toEqual([b.id]);
		// The retry turn rebases, the server push lands, and the hold lifts.
		await loop.runTurn(store.name, a.id);
		expect(store.getTask(a.id)!.stage).toBe("done");
		expect(projects.get(store.name)!.mainUnpushed).toBe(false);
		expect(pushes).toBe(2);
		// The second card merges after the repaired main, and its push succeeds.
		await loop.runTurn(store.name, b.id);
		expect(store.getTask(b.id)!.stage).toBe("done");
		expect(pushes).toBe(3);
		expect(record.removeWorktree).toHaveLength(2);
	});

	test("a push failure that parks needs_you still recovers when the user replies", async () => {
		// A non-rejection push failure (auth, network) parks needs_you with pushRetries 0;
		// local main holds the merged commits, so the push hold engages. The user's reply
		// queues the card again (app.ts sets pendingBy "user") — the hold must let exactly
		// that card run, or it would lock out the only merge that can push main (ALAT-60).
		let pushes = 0;
		const {
			store,
			record,
			loop,
			projects,
			task: a,
		} = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return pushes === 1
					? {
							status: "failed" as const,
							error:
								"fatal: unable to access 'https://github.com/a/r.git': Could not resolve host",
						}
					: { status: "pushed" as const, output: "" };
			},
			// The tick's refresh reads the same git fact the production failure leaves:
			// unpushed between the failed push and the repairing one, pushed after it.
			branchUnpushed: async () => pushes === 1,
		});
		// No pinned origin URL: the in-turn re-check cannot run, so the card parks.
		store.setSettings({ originUrl: null, maxParallel: 0 });
		await loop.runTurn(store.name, a.id);
		const parked = store.getTask(a.id)!;
		expect(parked.state).toBe("needs_you");
		expect(parked.pushRetries).toBe(0);
		// The failure left main unpushed: the hold engages for every queued merge.
		expect(projects.get(store.name)!.mainUnpushed).toBe(true);
		const b = store.createTask("merge b please");
		store.updateTask(b.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/b",
		});
		const gate = () =>
			pickRunnable(store.listTasks(), {
				maxParallel: null,
				hasRules: true,
				mainUnpushed: true,
			}).map((t) => t.id);
		// A supervisor queue of the parked card stays held: no user directed it, and the
		// normal queued merge b is held too — only a user reply (or a rebase retry) runs.
		store.updateTask(a.id, {
			state: "queued",
			needsReason: null,
			pendingPrompt: "retry",
			pendingBy: "supervisor",
			queuedAt: Date.now(),
		});
		expect(gate()).toEqual([]);
		store.updateTask(a.id, { state: "needs_you", pendingPrompt: null });
		// The user replies: the reply route queues the card with pendingBy "user".
		store.updateTask(a.id, {
			state: "queued",
			needsReason: null,
			pendingPrompt: "retry the push",
			pendingBy: "user",
			queuedAt: Date.now(),
		});
		expect(gate()).toEqual([a.id]);
		// The recovered turn pushes and lands, and the hold lifts for the other card.
		await loop.runTurn(store.name, a.id);
		expect(store.getTask(a.id)!.stage).toBe("done");
		expect(projects.get(store.name)!.mainUnpushed).toBe(false);
		expect(pushes).toBe(2);
		await loop.runTurn(store.name, b.id);
		expect(store.getTask(b.id)!.stage).toBe("done");
		expect(pushes).toBe(3);
		expect(record.removeWorktree).toHaveLength(2);
	});

	test("the third rejected push parks the card at needs_you with git's reason", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "rejected" as const,
				error: "! [rejected] main -> main (non-fast-forward)",
			}),
			fetchOriginBranch: async () => {
				throw new Error("must not fetch beyond the retry budget");
			},
		});
		store.updateTask(task.id, { pushRetries: 2 });
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(
			"Server push to origin failed: ! [rejected] main -> main (non-fast-forward)",
		);
		expect(t.pushRetries).toBe(2);
		expect(t.pendingPrompt).toBeNull();
	});

	test("a hold-approved merge origin rejects keeps needs_you: the lease covers one exact head", async () => {
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => ({
				status: "rejected" as const,
				error: "! [rejected] main -> main (stale info)",
			}),
			mergeHoldMismatch: async () => ({
				mismatch: false,
				pushDiff: null,
				auditedTip: "sha-audited",
			}),
			fetchOriginBranch: async () => {
				throw new Error("must not fetch a held push");
			},
		});
		store.updateTask(task.id, {
			updateIds: ["x@1"],
			updateMergeHead: "sha-approved",
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(
			"Server push to origin failed: ! [rejected] main -> main (stale info)",
		);
		expect(t.pushRetries).toBe(0);
	});

	test("a failed push retries once when origin did not move, and the card lands", async () => {
		let pushes = 0;
		const fetches: string[] = [];
		const error =
			"remote: Permission to Skare69/agent-data.git denied to ottr-board\nfatal: unable to access 'https://github.com/Skare69/agent-data.git/': The requested URL returned error: 403\nerror: failed to push some refs to 'https://github.com/Skare69/agent-data.git'";
		const { store, record, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return pushes === 1
					? {
							status: "failed" as const,
							error,
							output: `Enumerating objects: 5, done.\n${error}`,
						}
					: { status: "pushed" as const, output: "" };
			},
			fetchOriginBranch: async (
				_mainPath: string,
				branch: string,
				originUrl: string,
			) => {
				fetches.push(`${branch}@${originUrl}`);
				return null;
			},
			// The fetched origin tip still sits at the merge's base, so the local head is a
			// fast-forward of it: the exact situation ALAT-60 recovered from on a later turn.
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "refs/remotes/origin/main" ? "sha-base" : "sha-head",
			targetContains: async () => true,
			pushRetryDelayMs: 0,
		});
		store.setSettings({
			originUrl: "https://github.com/Skare69/agent-data.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("done");
		expect(t.needsReason).toBeNull();
		// The rebase-retry budget stays untouched: this retry never queued a turn.
		expect(t.pushRetries).toBe(0);
		expect(pushes).toBe(2);
		expect(fetches).toEqual(["main@https://github.com/Skare69/agent-data.git"]);
		const text = logText(store, task.id);
		expect(text).toContain(
			"remote: Permission to Skare69/agent-data.git denied to ottr-board",
		);
		expect(text).toContain("Enumerating objects: 5, done.");
		expect(text).toContain("retrying the server push once");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("two failed pushes park with every reason line, the full output and the push auth", async () => {
		let pushes = 0;
		const error =
			"remote: Permission to Skare69/agent-data.git denied to ottr-board\nerror: failed to push some refs to 'https://github.com/Skare69/agent-data.git'";
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return {
					status: "failed" as const,
					error,
					output: `Enumerating objects: 3, done.\n${error}`,
				};
			},
			fetchOriginBranch: async () => null,
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "refs/remotes/origin/main" ? "sha-base" : "sha-head",
			targetContains: async () => true,
			pushRetryDelayMs: 0,
			pushAuthKind: (url: string) =>
				url === "https://github.com/Skare69/agent-data.git"
					? "a board-stored token for github.com (personal access token)"
					: null,
		});
		store.setSettings({
			originUrl: "https://github.com/Skare69/agent-data.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.stage).toBe("merging");
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(`Server push to origin failed: ${error}`);
		expect(pushes).toBe(2);
		const text = logText(store, task.id);
		expect(text).toContain(
			"remote: Permission to Skare69/agent-data.git denied to ottr-board",
		);
		expect(text).toContain("Enumerating objects: 3, done.");
		expect(text).toContain(
			"push auth: a board-stored token for github.com (personal access token)",
		);
	});

	test("a failed origin re-check parks with its own reason and no retry", async () => {
		let pushes = 0;
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return { status: "failed" as const, error: "fatal: denied" };
			},
			fetchOriginBranch: async () => {
				throw new Error("ssh: token refresh failed");
			},
			pushRetryDelayMs: 0,
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe(
			"Server push to origin failed: fatal: denied\norigin re-check failed: ssh: token refresh failed",
		);
		expect(pushes).toBe(1);
	});

	test("origin moved: the failed push does not retry", async () => {
		let pushes = 0;
		const { store, loop, task } = mergeDoneSetup({
			serverMergePush: async () => {
				pushes += 1;
				return { status: "failed" as const, error: "fatal: denied" };
			},
			fetchOriginBranch: async () => null,
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "refs/remotes/origin/main" ? "sha-moved" : "sha-head",
			targetContains: async () => false,
			pushRetryDelayMs: 0,
		});
		store.setSettings({
			originUrl: "ssh://git.example.com/a/r.git",
			maxParallel: 0,
		});
		await loop.runTurn(store.name, task.id);
		const t = store.getTask(task.id)!;
		expect(t.state).toBe("needs_you");
		expect(t.needsReason).toBe("Server push to origin failed: fatal: denied");
		expect(pushes).toBe(1);
		expect(logText(store, task.id)).toContain("not retrying the push");
	});
});

describe("turn survivor rounds 3", () => {
	test("an interview card runs the raw prompt in the main checkout and settles ready as done", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: (o: {
				cwd: string;
				prompt: string;
				onSession?: (sid: string) => void;
			}) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "rules set",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}${store.name}`,
			null,
			"interview",
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// ready is rewritten to answered, and answered with no commits settles done.
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		// Interview cards run in the main checkout with the raw prompt and no worktree dance.
		expect(record.runs[0]!.cwd).toBe(store.path);
		expect(record.runs[0]!.prompt).toBe(task.prompt);
		expect(record.createWorktree).toHaveLength(0);
		expect(projects.get(store.name)!.target).toBe("origin/main");
	});

	test("the sibling list skips cancelled and done tasks", async () => {
		const { store, record, loop } = setup();
		const dead = store.createTask("dead sibling");
		store.updateTask(dead.id, { cancelledAt: Date.now() });
		const finished = store.createTask("done sibling");
		store.updateTask(finished.id, { stage: "done" });
		const live = store.createTask("live sibling");
		store.updateTask(live.id, { stage: "in_progress" });
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const prompt = record.runs[0]!.prompt;
		expect(prompt).toContain("live sibling");
		expect(prompt).not.toContain("dead sibling");
		expect(prompt).not.toContain("done sibling");
	});

	test("a shrunken pending image list keeps the remainder untouched", async () => {
		const record = baseRecord();
		const store = freshStore();
		const task = store.createTask("work please");
		saveSession(store, "s9");
		store.updateTask(task.id, {
			sessionId: "s9",
			pendingPrompt: "one",
			pendingImages: ["a", "b"],
		});
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					record.runs.push(o as never);
					o.onSession?.("s9");
					store.updateTask(task.id, { pendingImages: ["a"] });
					return {
						pid: 4242,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
			}),
		);
		await loop.runTurn(store.name, task.id);
		// ["a"] is shorter than the sent ["a","b"], so no prefix is sliced off.
		expect(store.getTask(task.id)!.pendingImages).toEqual(["a"]);
	});

	test("unsaved work on a done merge turn holds the card at merging", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			isIntegrated: async () => true,
			unsavedWork: async () => "M x.ts",
			statusFiles: async () => ["x.ts"],
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
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
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(keptReason("M x.ts"));
		expect(after.keptFiles).toEqual(["x.ts"]);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("an integrated merge turn stamps a version found in the details", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			isIntegrated: async () => true,
			// A real tag of the released name points at the pushed head.
			targetSha: async () => "sha-pushed",
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "landed",
								details: "released v8.8.8 today",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.releaseVersion).toBe("v8.8.8");
	});

	test("a release command holds queued merges; without one the merge runs", async () => {
		const withCommand = baseRecord();
		const commandStore = freshStore();
		const commandProjects = new Map([
			[commandStore.name, fakeProject(commandStore)],
		]);
		commandStore.setSettings({ releaseCommand: "bin release" });
		const merge = commandStore.createTask("merge please");
		commandStore.updateTask(merge.id, { stage: "merging", state: "queued" });
		const release = commandStore.createTask("release v1.0.0");
		commandStore.updateTask(release.id, { releaseVersion: "v1.0.0" });
		const commandLoop = createTurnLoop(
			commandProjects,
			fakeOps(withCommand, {
				startRun: (o: { prompt: string }) => {
					withCommand.runs.push(o as never);
					return {
						pid: 1,
						done: new Promise<RunResult>(() => {}),
						kill: async () => {},
					};
				},
			}),
		);
		commandLoop.schedule();
		await flushPromises();
		// The queued release card starts its review; the merge stays queued while it does.
		expect(withCommand.runs).toHaveLength(1);
		expect(["preparing", "running"]).toContain(
			commandStore.getTask(release.id)!.state,
		);
		expect(commandStore.getTask(merge.id)!.state).toBe("queued");

		const without = baseRecord();
		const plainStore = freshStore();
		const plainProjects = new Map([[plainStore.name, fakeProject(plainStore)]]);
		const plainMerge = plainStore.createTask("merge please");
		plainStore.updateTask(plainMerge.id, {
			stage: "merging",
			state: "queued",
		});
		const plainRelease = plainStore.createTask("release v1.0.0");
		plainStore.updateTask(plainRelease.id, { releaseVersion: "v1.0.0" });
		const plainLoop = createTurnLoop(
			plainProjects,
			fakeOps(without, {
				startRun: (o: {
					prompt: string;
					onSession?: (sid: string) => void;
				}) => {
					without.runs.push(o as never);
					o.onSession?.("s1");
					return {
						pid: 2,
						done: Promise.resolve(runResult({})),
						kill: async () => {},
					};
				},
			}),
		);
		plainLoop.schedule();
		await flushPromises();
		// Without a release command nothing holds the merge slot back: the card started.
		expect(plainStore.getTask(plainMerge.id)!.state).not.toBe("queued");
		expect(without.runs).not.toHaveLength(0);
	});
});

describe("turn research cards", () => {
	function researchStore() {
		const store = freshStore();
		const record: Recorded = {
			createWorktree: [],
			removeWorktree: [],
			runs: [],
			publishRelease: [],
			runReleaseCommand: [],
			quarantine: [],
			ignoreInMain: [],
			publishSoon: 0,
			notifyLog: [],
			killed: false,
			proposal: null,
			recorded: [],
		};
		const projects = new Map([[store.name, fakeProject(store)]]);
		return { store, record, projects };
	}

	function researchTask(store: ProjectStore) {
		const task = store.createTask("research something");
		store.updateTask(task.id, { research: true });
		return task;
	}

	test("research work turn done: report harvested, worktree removed", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# findings");
				},
			}),
		);
		const task = researchTask(store);

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.report).toBe("# findings");
		// The worktree is disposable once the report is archived.
		expect(record.removeWorktree).toHaveLength(1);
		// The run got the work prompt with the research hatch (the flag no longer picks a prompt).
		expect(record.runs[0]!.prompt).toContain("only researches a topic");
	});

	test("a harvested report with a Recommended steps heading stores steps yes", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(
						join(o.worktreePath, RESEARCH_REPORT),
						"# findings\n\n## Recommended steps\n\n- do it",
					);
				},
			}),
		);
		const task = researchTask(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.steps).toBe("yes");
	});

	test("a harvested report without the heading stores steps no", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# findings");
				},
			}),
		);
		const task = researchTask(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.steps).toBe("no");
	});

	test("a loose Recommended-steps heading variant stores steps yes", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(
						join(o.worktreePath, RESEARCH_REPORT),
						"# findings\n\n## Recommended adoption steps\n\n1. Do it",
					);
				},
			}),
		);
		const task = researchTask(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.steps).toBe("yes");
	});

	test("a plain work card with no report file keeps steps unknown", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, { commitsAhead: async () => 0 }),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.steps).toBe("unknown");
	});

	// OTTR-233: a refused report holds every work card — a plain card too — before the
	// untracked-file quarantine and the worktree removal, and never copies the target.
	for (const research of [false, true])
		for (const shape of ["symlink", "oversized"] as const)
			test.skipIf(shape === "symlink" && process.platform !== "linux")(
				`a ${shape} report on a ${research ? "research" : "plain"} card holds the card`,
				async () => {
					const { store, record, projects } = researchStore();
					const outside = mkdtempSync(join(tmpdir(), "turn-report-secret-"));
					dirs.push(outside);
					const secret = join(outside, "secret");
					writeFileSync(secret, "top secret");
					const loop = createTurnLoop(
						projects,
						fakeOps(record, {
							commitsAhead: async () => 0,
							createWorktree: async (o: { worktreePath: string }) => {
								record.createWorktree.push(o);
								mkdirSync(o.worktreePath, { recursive: true });
								const p = join(o.worktreePath, RESEARCH_REPORT);
								if (shape === "symlink") symlinkSync(secret, p);
								else writeFileSync(p, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
							},
						}),
					);
					const task = research
						? researchTask(store)
						: store.createTask("work please");

					await loop.runTurn(store.name, task.id);

					const after = store.getTask(task.id)!;
					expect(after.report ?? "").not.toContain("top secret");
					expect(after.stage).toBe("in_progress");
					expect(after.state).toBe("needs_you");
					expect(after.needsReason).toContain("cannot be read");
					expect(after.needsReason).toContain(
						shape === "symlink" ? "a symlink" : "larger than",
					);
					expect(record.quarantine).toHaveLength(0);
					expect(record.removeWorktree).toHaveLength(0);
				},
			);

	test("research turn saves agent-reported shots before the worktree goes", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# findings");
					// Minimal PNG header: passes the magic-byte sniff.
					writeFileSync(
						join(o.worktreePath, "answer.png"),
						Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
					);
				},
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "answered",
									summary: "researched",
									shots: ["answer.png"],
								},
							}),
						),
						kill: async () => {},
					};
				},
			}),
		);
		const task = researchTask(store);

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.shots).toHaveLength(1);
		expect(after.shots[0]).toMatch(/^\d+\.png$/);
		// The shot outlives the worktree the research answer was produced in.
		expect(existsSync(join(store.imagesDir(task.id), after.shots[0]!))).toBe(
			true,
		);
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("research work turn with no outcome settles done from the report file", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						// Exit 0 but the agent never called report_outcome.
						done: Promise.resolve(runResult()),
						kill: async () => {
							record.killed = true;
						},
					};
				},
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "rep");
				},
			}),
		);
		const task = researchTask(store);

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.report).toBe("rep");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("research work turn answered without a report file asks you", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, { commitsAhead: async () => 0 }),
		);
		const task = researchTask(store);

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("research-report.md");
		expect(after.report).toBeNull();
	});

	test("research work turn reporting ready is coerced to answered and settles done", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "ready",
									summary: "research ready",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "rep");
				},
			}),
		);
		const task = researchTask(store);

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(store.listTurns(task.id)[0]!.outcome).toBe("answered");
	});

	test("unmarking a coerced card: its next ready report settles merging, not done", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				// Hold the chained merge turn; assert the settle instant.
				maxTotalRuns: () => 0,
				commitsAhead: async () => 1,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "ready",
									summary: "real work this time",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
				// No research-report.md: the agent did not self-declare again.
			}),
		);
		const task = researchTask(store);
		// The unmark route's write: the flag clears before the next turn starts.
		store.updateTask(task.id, { research: false });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(store.listTurns(task.id)[0]!.outcome).toBe("ready");
		expect(after.report).toBeNull();
	});

	test("a research card's reply turn with landable commits and no report demotes it to work", async () => {
		const { store, record, projects } = researchStore();
		let runs = 0;
		let commits = 0;
		let wtPath = "";
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				// Hold the chained merge turn; assert the settle instant.
				maxTotalRuns: () => 0,
				commitsAhead: async () => commits,
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					wtPath = o.worktreePath;
					mkdirSync(o.worktreePath, { recursive: true });
					// Turn 1 self-declares research by writing the report file.
					if (runs === 0)
						writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# findings");
				},
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					runs += 1;
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: (runs === 1
									? { status: "answered", summary: "researched" }
									: {
											status: "ready",
											summary: "real work this time",
										}) satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask("research something");

		// Turn 1: writing the report file marks the card research; it settles done.
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.research).toBe(true);
		expect(store.getTask(task.id)!.stage).toBe("done");

		// The reply turn commits real work and removes the report file.
		rmSync(join(wtPath, RESEARCH_REPORT));
		store.updateTask(task.id, {
			pendingPrompt: "make it a real fix",
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
		});
		commits = 1;
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.research).toBe(false);
		expect(store.listTurns(task.id)[1]!.outcome).toBe("ready");
	});

	test("research work turn with an extra uncommitted file still settles done", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				unsavedWork: async () => {
					throw new Error("unsavedWork must not run for research cards");
				},
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "rep");
					writeFileSync(join(o.worktreePath, "scratch.txt"), "uncommitted");
				},
				statusFiles: async () => ["research-report.md", "scratch.txt"],
			}),
		);
		const task = researchTask(store);

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.uncommittedFiles).toEqual([
			"research-report.md",
			"scratch.txt",
		]);
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("a plain work task writing the report self-declares research and settles done", async () => {
		const { store, record, projects } = researchStore();
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "ready",
									summary: "looked like work",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
				createWorktree: async (o: { worktreePath: string }) => {
					record.createWorktree.push(o);
					mkdirSync(o.worktreePath, { recursive: true });
					writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# answer");
				},
			}),
		);
		const task = store.createTask("ordinary work");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.research).toBe(true);
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.report).toBe("# answer");
		expect(store.listTurns(task.id)[0]!.outcome).toBe("answered");
		expect(record.removeWorktree).toHaveLength(1);
	});
});

describe("lost-process sweep", () => {
	/** startRun override whose first run hangs forever on pid 4242: the vanished-process fixture. */
	function hungRun(record: Recorded, markStarted: () => void) {
		return (o: Parameters<TurnOps["startRun"]>[0]) => {
			record.runs.push(o);
			o.onSession?.("sess-1");
			markStarted();
			if (record.runs.length > 1)
				return {
					pid: 5050,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			return {
				pid: 4242,
				done: Promise.withResolvers<RunResult>().promise,
				kill: async () => {
					record.killed = true;
				},
			};
		};
	}

	test("a swept review settles, requeues, and its held merge lands", async () => {
		const store = freshStore();
		const record = baseRecord();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 1,
				pidAlive: (pid: number) => pid !== 4242,
				// A review never leaves commits on its base: its answered report settles done.
				commitsAhead: async () => 0,
				targetSha: async (_mainPath: string, ref: string) =>
					ref === "HEAD" ? "abc123def456" : null,
				// Run 1 hangs on a dead pid. Run 2 is the review's resume: a review is
				// read-only, it reports answered. Run 3 is the held merge turn: it lands
				// and reports integrated (only a merge turn may).
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					if (record.runs.length === 1) {
						markStarted();
						return {
							pid: 4242,
							done: Promise.withResolvers<RunResult>().promise,
							kill: async () => {
								record.killed = true;
							},
						};
					}
					const outcome =
						record.runs.length === 2
							? ({ status: "answered", summary: "did it" } satisfies Outcome)
							: ({ status: "integrated", summary: "landed" } satisfies Outcome);
					return {
						pid: 5050,
						done: Promise.resolve(runResult({ outcome })),
						kill: async () => {},
					};
				},
			}),
		);
		// The clipshelf shape: a review hangs on a dead pid while it holds every queued merge
		// ("waiting for the review to finish").
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER} review origin/main`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "abc123def456" });
		const merge = store.createTask("merge plz");
		store.updateTask(merge.id, { stage: "merging", branch: "ott/merge-plz" });
		void loop.runTurn(store.name, review.id);
		await started; // the turn row exists and the run hangs on pid 4242

		// Tick 1: settle the lost run and requeue the review.
		loop.schedule();
		await flushPromises();

		const after = store.getTask(review.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"The agent process (pid 4242) disappeared during this turn - resuming automatically. Cancel to stop it instead.",
		);
		// The worktree survived, so the resume rides the restart prompt (clean-tree shortcut).
		expect(after.pendingPrompt).toBe(
			restartResumePrompt({ sha: "abc123def456", clean: true }),
		);
		const turn = store.listTurns(review.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.exitCode).toBeNull();
		expect(turn.error).toBe("lost agent process (pid 4242)");
		expect(loop.running.size).toBe(0); // the dead entry no longer holds the cap slot

		// Tick 2: the review runs again and finishes; with it done, the held merge lands.
		loop.schedule();
		await flushPromises();

		expect(store.getTask(review.id)!.stage).toBe("done");
		expect(store.getTask(merge.id)!.stage).toBe("done");
	});

	test("a live pid is left alone", async () => {
		const store = freshStore();
		const record = baseRecord();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, { startRun: hungRun(record, markStarted) }),
		);
		const task = store.createTask("work please");
		void loop.runTurn(store.name, task.id);
		await started;

		loop.schedule();
		await flushPromises();

		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(loop.running.size).toBe(1);
		expect(record.runs).toHaveLength(1);
	});

	test("board start sweeps stale turn rows with dead pids", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				// Cap 0: the first tick sweeps (it runs before the cap check) but starts nothing.
				maxTotalRuns: () => 0,
				pidAlive: (pid: number) => pid !== 4344,
			}),
		);
		// A row a crashed predecessor left open: no entry in this loop's `running` map.
		const task = store.createTask("crashed elsewhere");
		store.updateTask(task.id, { state: "running", sessionId: "sess-9" });
		store.startTurn(task.id, "work", "old prompt", 4344);

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("lost agent process (pid 4344)");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe("."); // no worktree: the plain continue marker
		expect(logText(store, task.id)).toContain("lost agent process (pid 4344)");
		// Cap 0 stopped the same-tick resume: it starts on a later tick.
		expect(record.runs).toHaveLength(0);
	});

	test("board start sweeps stale pid-null rows with no live worker entry", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				// Cap 0: the first tick sweeps (it runs before the cap check) but starts nothing.
				maxTotalRuns: () => 0,
				pidAlive: () => true, // nothing for the pid path to catch
			}),
		);
		// A worker run a crashed predecessor left open: pid null, no entry in this loop's `running` map.
		const task = store.createTask("crashed worker");
		store.updateTask(task.id, { state: "running", sessionId: "sess-9" });
		store.startTurn(task.id, "work", "old prompt", null);

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("lost agent process (worker run)");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"The worker running this turn disappeared - resuming automatically. Cancel to stop it instead.",
		);
		expect(after.pendingPrompt).toBe("."); // no worktree: the plain continue marker
		expect(logText(store, task.id)).toContain(
			"lost agent process (worker run)",
		);
		// Cap 0 stopped the same-tick resume: it starts on a later tick.
		expect(record.runs).toHaveLength(0);
	});

	test("a live worker entry (pid null) is left alone", async () => {
		const store = freshStore();
		const record = baseRecord();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				pidAlive: () => true, // nothing for the pid path to catch
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					markStarted();
					return {
						pid: null, // worker client: the stream is the liveness proof
						done: Promise.withResolvers<RunResult>().promise,
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask("work please");
		void loop.runTurn(store.name, task.id);
		await started;

		loop.schedule();
		await flushPromises();

		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(loop.running.size).toBe(1);
		expect(record.runs).toHaveLength(1);
	});

	test("a cancelled card is settled but not requeued", async () => {
		const store = freshStore();
		const record = baseRecord();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				pidAlive: (pid: number) => pid !== 4242,
				startRun: hungRun(record, markStarted),
			}),
		);
		const task = store.createTask("work please");
		void loop.runTurn(store.name, task.id);
		await started;
		// cancelTask marks the card, then waits out the run before finishing its state move.
		store.updateTask(task.id, { cancelledAt: Date.now() });

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("lost agent process (pid 4242)");
		// Cancel owns the card: settled, but not requeued (cancelTask finishes the state move).
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(store.getTask(task.id)!.pendingPrompt).toBeNull();
		expect(record.runs).toHaveLength(1);
	});

	test("a late done after the sweep leaves the settled turn alone", async () => {
		const store = freshStore();
		const record = baseRecord();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const { promise: gate, resolve: releaseDone } =
			Promise.withResolvers<RunResult>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0, // keep the finally's schedule() from restarting the card
				pidAlive: (pid: number) => pid !== 4242,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					markStarted();
					return {
						pid: 4242,
						done: gate,
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await started;
		loop.schedule();
		await flushPromises();
		const endedAt = store.listTurns(task.id)[0]!.endedAt;
		expect(endedAt).not.toBeNull();

		// The hung pipes finally close, after the sweep already settled the row.
		releaseDone(
			runResult({
				outcome: { status: "answered", summary: "did it" } satisfies Outcome,
			}),
		);
		await run;

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).toBe(endedAt); // untouched by the late resolution
		expect(turn.outcome).toBeNull();
		expect(turn.error).toBe("lost agent process (pid 4242)");
		expect(store.getTask(task.id)!.state).toBe("queued");
		expect(record.runs).toHaveLength(1);
		expect(loop.running.size).toBe(0);
	});

	test("a run that ended is not lost while its settle awaits git", async () => {
		const store = freshStore();
		const record = baseRecord();
		let tick = (): void => {};
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				commitsAhead: async () => 0, // answered, no commits: done/idle
				maxTotalRuns: () => 0, // keep the finally's schedule() from starting anything
				pidAlive: (pid: number) => pid !== 4242, // omp already exited
				// Any other card's event can tick the scheduler while the settle awaits git.
				worktreeHusk: async () => {
					tick();
					return false;
				},
			}),
		);
		tick = () => loop.schedule();
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		await flushPromises();

		expect(logText(store, task.id)).not.toContain("lost agent process");
		const after = store.getTask(task.id);
		expect([after?.stage, after?.state]).toEqual(["done", "idle"]);
		// No resume prompt is left behind to replace the next turn's own prompt (a merge turn got
		// "Tracker restarted..." instead of its merge prompt and re-reported ready).
		expect(after?.pendingPrompt).toBeNull();
	});
});

describe("package list", () => {
	test("a local turn installs the project's packages before omp starts and logs the result", async () => {
		const order: string[] = [];
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // hold the chained merge turn: one install, one omp
			ensurePackages: async (project: string) => {
				order.push(`install ${project}`);
				return ["apt: installed libnss3"];
			},
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				order.push("omp");
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({ outcome: { status: "answered", summary: "ok" } }),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(order).toEqual([`install ${store.name}`, "omp"]);
		expect(logText(store, task.id)).toContain("apt: installed libnss3");
	});

	test("a work turn sent to a worker leaves the install to that worker; its merge turn installs here", async () => {
		const asked: string[] = [];
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // each turn runs via a direct runTurn
			workerTarget: { urls: ["http://worker-a:8787"] },
			ensurePackages: async (project: string) => {
				asked.push(project);
				return [];
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(asked).toEqual([]);
		// D6: merge turns stay server-side, so the server needs the packages too.
		store.updateTask(task.id, { stage: "merging", state: "queued" });
		await loop.runTurn(store.name, task.id);
		expect(asked).toEqual([store.name]);
		expect(record.runs).toHaveLength(2);
	});

	test("a merge turn whose session model cannot load reruns with the board's default role", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // each turn runs via a direct runTurn
			workerTarget: { urls: ["http://worker-a:8787"] },
			modelRoles: () => ({ default: "anthropic/claude-opus-5-5:medium" }),
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				return {
					pid: 4242,
					// omp restores the saved model only without --model.
					done: Promise.resolve(
						o.model
							? runResult({ outcome: { status: "integrated", summary: "ok" } })
							: runResult({
									exitCode: 1,
									sawTerminalEnd: false,
									finalText: "",
									stderrTail:
										"error: Could not restore model zai/glm-5.3-flash.\n",
								}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		saveSession(store, "sess-1");
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			sessionId: "sess-1",
			pendingPrompt: "please merge",
		});
		await loop.runTurn(store.name, task.id);
		const mid = store.getTask(task.id)!;
		expect(mid.state).toBe("queued");
		expect(mid.pendingPrompt).toBe("please merge"); // the reply never reached the session
		await loop.runTurn(store.name, task.id);
		expect(record.runs.map((r) => r.model)).toEqual([
			null,
			"anthropic/claude-opus-5-5:medium",
		]);
		expect(record.runs[1]!.resumeId).toBe("sess-1");
		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.stage).toBe("done");
		expect(after.model).toBeNull(); // the card keeps the default role
	});

	test("a failed install stops the turn before omp starts and names apt's error", async () => {
		const { store, record, loop } = setup({
			ensurePackages: async () => {
				throw new Error(
					"apt: apt-get install failed (exit 100): E: Unable to locate package nope",
				);
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("Unable to locate package nope");
	});
});

describe("prepareTurn", () => {
	test("a turn logs one env line naming listed-but-valueless names", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			turnEnv: async () => ({ env: {}, missing: ["FOO", "BAR"] }),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain(
			"env: no value for FOO, BAR (set it under Settings, Env)",
		);
	});

	test("a worker turn whose credential cannot be lent does not start, and the card shows the cause", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			turnEnv: async () => ({
				env: {},
				missing: [],
				credentialError:
					"omp did not refresh the board's anthropic sign-in: invalid_grant",
			}),
		});
		const task = store.createTask("work please", "anthropic/claude-opus-5-5");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Sign-in: omp did not refresh the board's anthropic sign-in: invalid_grant. The turn did not start. Sign in again under Settings, Provider sign-in, then reply to retry.",
		);
	});

	test("a local turn passes the env values and a PATH prefixed with the link dir", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			turnEnv: async () => ({ env: { FOO: "v" }, missing: [] }),
			prepareTurn: async () => ({ lines: [], pathDir: "/tmp/x" }),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const env = record.runs[0]!.env;
		expect(env?.FOO).toBe("v");
		expect(env?.PATH?.startsWith("/tmp/x:")).toBe(true);
	});

	test("a worker-dispatched turn still gets the env values and the missing line, but no tools prep", async () => {
		let prepared = false;
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			turnEnv: async () => ({
				env: { FOO: "v" },
				missing: ["BAR"],
				secrets: ["lent-tok"],
			}),
			prepareTurn: async () => {
				prepared = true;
				return { lines: [], pathDir: null };
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(prepared).toBe(false);
		expect(logText(store, task.id)).toContain(
			"env: no value for BAR (set it under Settings, Env)",
		);
		expect(record.runs[0]!.env?.FOO).toBe("v");
		expect(record.runs[0]!.secrets).toEqual(["lent-tok"]);
	});

	/** A board store in omp's layout with one fresh OAuth sign-in per provider. */
	function boardStore(tokens: Record<string, string>): string {
		const lendDir = mkdtempSync(join(tmpdir(), "ottr-turn-lend-"));
		dirs.push(lendDir);
		const dbPath = join(lendDir, "agent.db");
		const db = new Database(dbPath);
		db.exec(`CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
			disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
			updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)))`);
		const add = db.query(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, 'acct-1')",
		);
		for (const [provider, access] of Object.entries(tokens))
			add.run(
				provider,
				JSON.stringify({
					access,
					refresh: `refresh-${provider}`,
					expires: Date.now() + 8 * 3_600_000,
					authorizedAt: Date.now() - 60_000,
				}),
			);
		db.close();
		return dbPath;
	}

	/** A worker loop whose turnEnv is the server's wiring against `dbPath`. */
	function lendingSetup(dbPath: string, overrides: Partial<TurnOps> = {}) {
		return setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			turnEnv: (project, model) =>
				turnEnv(project, model, {}, { dbPath, home: dirname(dbPath) }),
			...overrides,
		});
	}

	test("a worker turn runs the card's model as --model and lends its token; a local turn lends none", async () => {
		const seen: Array<string | null> = [];
		const worker = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			turnEnv: async (_project, model) => {
				seen.push(model);
				return { env: {}, missing: [] };
			},
		});
		const w = worker.store.createTask("work please", "zai/glm-5.3-flash");
		await worker.loop.runTurn(worker.store.name, w.id);
		expect(worker.record.runs[0]!.model).toBe("zai/glm-5.3-flash");
		const local = setup({
			maxTotalRuns: () => 0,
			turnEnv: async (_project, model) => {
				seen.push(model);
				return { env: {}, missing: [] };
			},
		});
		const l = local.store.createTask("work please", "zai/glm-5.3-flash");
		await local.loop.runTurn(local.store.name, l.id);
		// A local run uses the board store itself: no model to lend for.
		expect(seen).toEqual(["zai/glm-5.3-flash", null]);
		expect(local.record.runs[0]!.model).toBe("zai/glm-5.3-flash");
	});

	test("board and worker default roles differ: the turn runs the board's default role explicitly, with its token", async () => {
		// The worker's own config.yml may name another default; an explicit --model makes omp run
		// the board's default, the model the token is lent for.
		const dbPath = boardStore({
			anthropic: "access-board",
			zai: "zai-board",
		});
		const { store, record, loop } = lendingSetup(dbPath, {
			modelRoles: () => ({ default: "anthropic/claude-opus-5-5:high" }),
		});
		// No card model, and an empty one: both resolve to the board's default role.
		const none = store.createTask("work please");
		await loop.runTurn(store.name, none.id);
		const empty = store.createTask("work please", "  ");
		await loop.runTurn(store.name, empty.id);
		expect(record.runs.map((r) => [r.model, r.env])).toEqual([
			[
				"anthropic/claude-opus-5-5:high",
				{ ANTHROPIC_OAUTH_TOKEN: "access-board" },
			],
			[
				"anthropic/claude-opus-5-5:high",
				{ ANTHROPIC_OAUTH_TOKEN: "access-board" },
			],
		]);
	});

	test("a resume after the card's model changed runs and lends the resolved model", async () => {
		const dbPath = boardStore({
			anthropic: "access-board",
			zai: "zai-board",
		});
		const { store, record, loop } = lendingSetup(dbPath, {
			modelRoles: () => ({ default: "anthropic/claude-opus-5-5" }),
		});
		/** A card whose saved session ran zai, with a pending reply. */
		const resumable = (sid: string) => {
			const task = store.createTask("work please", "zai/glm-5.3-flash");
			mkdirSync(store.sessionsDir, { recursive: true });
			writeFileSync(
				join(store.sessionsDir, `1_${sid}.jsonl`),
				`${JSON.stringify({ type: "model_change", model: "zai/glm-5.3-flash" })}\n`,
			);
			store.updateTask(task.id, { sessionId: sid, pendingPrompt: "go on" });
			return task;
		};
		// The card's model is cleared: the session's model wins over the default role.
		const cleared = resumable("s-cleared");
		store.updateTask(cleared.id, { model: null });
		await loop.runTurn(store.name, cleared.id);
		// The card switched to another model: the card wins, and omp switches with --model.
		const switched = resumable("s-switched");
		store.updateTask(switched.id, { model: "anthropic/claude-opus-5-5" });
		await loop.runTurn(store.name, switched.id);
		expect(record.runs.map((r) => [r.resumeId, r.model, r.env])).toEqual([
			["s-cleared", "zai/glm-5.3-flash", { ZAI_API_KEY: "zai-board" }],
			[
				"s-switched",
				"anthropic/claude-opus-5-5",
				{ ANTHROPIC_OAUTH_TOKEN: "access-board" },
			],
		]);
	});

	test("a worker turn with no model anywhere does not start, and the card shows the cause", async () => {
		const { store, record, loop } = lendingSetup(boardStore({}), {
			modelRoles: () => ({ smol: "zai/glm-5.3-flash" }),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Sign-in: no model for this worker turn. The card sets none, the saved session names none, and the board's config.yml has no default role. Pick a model on the card, or set modelRoles.default, then reply to retry.",
		);
	});

	test("a worker turn whose provider has no board sign-in does not start, and the card shows the cause", async () => {
		const { store, record, loop } = lendingSetup(boardStore({}));
		const task = store.createTask("work please", "anthropic/claude-opus-5-5");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Sign-in: the board has no anthropic sign-in. The turn did not start. Sign in again under Settings, Provider sign-in, then reply to retry.",
		);
	});

	test("an empty credential error still stops the worker turn", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			turnEnv: async () => ({ env: {}, missing: [], credentialError: "" }),
		});
		const task = store.createTask("work please", "anthropic/claude-opus-5-5");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)!.needsReason).toBe(
			"Sign-in: the board cannot lend a credential. The turn did not start. Sign in again under Settings, Provider sign-in, then reply to retry.",
		);
	});

	test("a busy board store stops the turn with a retry reason, not a sign-in prompt", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			turnEnv: async () => ({
				env: {},
				missing: [],
				credentialError:
					"the board store /agent/agent.db is busy (a write did not end within 5 s)",
				busy: true,
			}),
		});
		const task = store.createTask("work please", "anthropic/claude-opus-5-5");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)!.needsReason).toBe(
			"Sign-in: the board store /agent/agent.db is busy (a write did not end within 5 s). The turn did not start. Reply to retry; do not sign in again.",
		);
	});

	test("a worker-dispatched turn never calls prepareTurn", async () => {
		let called = false;
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			prepareTurn: async () => {
				called = true;
				return { lines: [], pathDir: null };
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(called).toBe(false);
	});

	test("a prepareTurn rejection stops the turn before omp starts", async () => {
		const { store, record, loop } = setup({
			prepareTurn: async () => {
				throw new Error("tools: download failed");
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("tools: download failed");
	});
});

describe("turn ownership, cap and settle regressions", () => {
	/** A store whose listTasks always throws: a locked database mid-tick. */
	function sickStore(store: ProjectStore): ProjectStore {
		return new Proxy(store, {
			get(target, prop) {
				if (prop === "listTasks")
					return () => {
						throw new Error("database is locked");
					};
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	test("sweep leaves a turn its runTurn still owns (slow post-run git)", async () => {
		const store = freshStore();
		const record = baseRecord();
		const huskReached = Promise.withResolvers<void>();
		let releaseHusk: (() => void) | null = null;
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				commitsAhead: async () => 0,
				pidAlive: () => false, // omp already exited; only runTurn's settle remains
				worktreeHusk: async () => {
					huskReached.resolve();
					return new Promise<boolean>((res) => {
						releaseHusk = () => res(false);
					});
				},
			}),
		);
		const task = store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await huskReached.promise; // past running.delete, still before the settle writes

		// The tick fires while runTurn is between `running.delete` and its settle writes.
		loop.schedule();
		await flushPromises();

		// The preparing claim owns the row: no lost-settle, no requeue under the live run.
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(logText(store, task.id)).not.toContain("lost agent process");
		expect(store.getTask(task.id)!.state).toBe("running");

		releaseHusk!();
		await run;

		// runTurn settles exactly once, with no phantom requeue from a sweep write.
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.pendingPrompt).toBeNull();
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBeNull();
	});

	test("sweep leaves a worker turn whose pid getter filled in after startTurn", async () => {
		const store = freshStore();
		const record = baseRecord();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		let pid: number | null = null;
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				pidAlive: () => true,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					markStarted();
					// A handle that learns its pid only after startTurn.
					queueMicrotask(() => {
						pid = 4242;
					});
					return {
						get pid() {
							return pid;
						},
						done: Promise.withResolvers<RunResult>().promise,
						kill: async () => {},
					};
				},
			}),
		);
		const task = store.createTask("work please");
		void loop.runTurn(store.name, task.id);
		await started;

		loop.schedule();
		await flushPromises();

		// The row's pid is null but the live entry owns the turn: no lost-settle.
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.listTurns(task.id)[0]!.pid).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(logText(store, task.id)).not.toContain("lost agent process");
	});

	test("cancel during prepare keeps the card: no run starts", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				// cancelTask's kept path answers during the prepare awaits and owns the card.
				ensurePackages: async () => {
					store.updateTask(task.id, {
						cancelledAt: null,
						state: "needs_you",
						needsReason: keptReason("M f.ts"),
					});
					return [];
				},
			}),
		);
		const task = store.createTask("work please");
		// An existing worktree: the prepare window is resolveTarget + ensurePackages.
		store.updateTask(task.id, { worktree: "wt-x", branch: "ott/x" });
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(keptReason("M f.ts"));
		expect(store.listTurns(task.id)).toHaveLength(0);
	});

	test("cancel during settle cannot write over the kept card", async () => {
		const store = freshStore();
		const record = baseRecord();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				commitsAhead: async () => 0,
				isIntegrated: async () => {
					reached.resolve();
					await gate.promise;
					return true;
				},
			}),
		);
		const task = store.createTask("work please");
		store.updateTask(task.id, { worktree: "wt-x", branch: "ott/x" });
		const run = loop.runTurn(store.name, task.id);
		await reached.promise; // settle-phase git in flight
		store.updateTask(task.id, {
			cancelledAt: null,
			state: "needs_you",
			needsReason: keptReason("M f.ts"),
		});
		gate.resolve();
		await run;

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(keptReason("M f.ts"));
		expect(store.listTurns(task.id)[0]!.error).toBe("cancelled");
	});

	test("the global cap counts each live run once and holds within the tick", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 2,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		store.setSettings({ maxParallel: 4 });
		for (let i = 0; i < 4; i++) store.createTask(`task ${i}`);
		loop.schedule();
		await flushPromises();
		// A live run used to sit in both `running` and `preparing` and the tick started all 4.
		expect(record.runs).toHaveLength(2);
	});

	test("a cap with headroom starts a new run on the same tick", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 3,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		store.setSettings({ maxParallel: 4 });
		const t1 = store.createTask("one");
		const t2 = store.createTask("two");
		const t3 = store.createTask("three");
		void loop.runTurn(store.name, t1.id);
		void loop.runTurn(store.name, t2.id);
		await flushPromises(); // both runs reach `running` (4 counted by the old sum)
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(3);
		expect(record.runs[2]!.prompt).toContain("three");
		expect(store.getTask(t3.id)!.state).not.toBe("queued");
	});

	test("a full cap still refreshes every project flag", async () => {
		const { store, record, projects, loop } = setup({
			maxTotalRuns: () => 0,
			isClean: async () => false,
		});
		const e = projects.get(store.name)!;
		loop.schedule();
		await flushPromises();
		expect(e.dirty).toBe(true);
		expect(record.runs).toHaveLength(0);
	});

	test("a store whose listTasks throws does not stop the other projects' schedule", async () => {
		const good = freshStore();
		const sick = freshStore();
		const record = baseRecord();
		const seen: string[] = [];
		const origError = console.error;
		console.error = (first: unknown, second?: unknown) => {
			seen.push(`${String(first)} ${String(second)}`);
		};
		try {
			const loop = createTurnLoop(
				new Map([
					[sick.name, { ...fakeProject(sick), store: sickStore(sick) }],
					[good.name, fakeProject(good)],
				]),
				fakeOps(record, {
					// Held launch: a resolved run requeues the card (merging) and the loop's
					// end-of-turn schedule() would legitimately start its merge turn, so the
					// run count would depend on how far the microtasks drain.
					startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
						record.runs.push(o);
						o.onSession?.("sess-1");
						return {
							pid: 4242,
							done: new Promise<RunResult>(() => {}),
							kill: async () => {},
						};
					},
				}),
			);
			good.createTask("work please");
			expect(() => loop.schedule()).not.toThrow();
			await flushPromises();
			expect(record.runs).toHaveLength(1);
			expect(record.runs[0]!.board!.project).toBe(good.name);
			expect(seen.join("\n")).toContain(sick.name);
			expect(seen.join("\n")).toContain("database is locked");
		} finally {
			console.error = origError;
		}
	});

	test("the ui-shot guard counts the card's earlier screenshots", async () => {
		const { store, loop } = setup({
			changedFiles: async () => ["src/ui/app.tsx"],
			// Assert the settle instant: the requeued merge turn is real but must not
			// start inside this await and flip the card to preparing.
			maxTotalRuns: () => 0,
		});
		const task = store.createTask("work please");
		// An earlier turn on this card attached a shot; changedFiles is the cumulative diff.
		store.updateTask(task.id, { shots: ["a.png"] });
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBeNull();
		expect(logText(store, task.id)).not.toContain(UI_SHOT_WARNING);
	});

	test("a pending reply reaches a fresh release session and its turn input", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("release v1.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-x",
			branch: "ott/rel",
			releaseNotes: "notes body",
			sessionId: "s1",
			pendingPrompt: "skip X",
		});
		await loop.runTurn(store.name, task.id);

		// The raw release prompt must carry the lost-session note and the reply.
		expect(record.runs[0]!.prompt).toContain(LOST_SESSION);
		expect(record.runs[0]!.prompt).toContain("skip X");
		expect(store.listTurns(task.id)[0]!.input).toBe("skip X");
	});

	test("a pending reply reaches a fresh merge session and its turn input", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
			sessionId: "s1",
			pendingPrompt: "also bump the chart",
		});
		await loop.runTurn(store.name, task.id);

		expect(record.runs[0]!.prompt).toContain("also bump the chart");
		expect(store.listTurns(task.id)[0]!.input).toBe("also bump the chart");
	});

	test("the delivered input keeps the park's authorship: supervisor parks vs user steers", async () => {
		const { store, loop } = setup();
		const held = store.createTask("merge please");
		store.updateTask(held.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
			sessionId: "s1",
			pendingPrompt: "the check sent this back",
			pendingBy: "supervisor",
		});
		await loop.runTurn(store.name, held.id);
		expect(store.listTurns(held.id)[0]!.inputBy).toBe("supervisor");

		const steered = store.createTask("merge please two");
		store.updateTask(steered.id, {
			stage: "merging",
			branch: "ott/y",
			base: "sha0",
			worktree: "wt-y",
			sessionId: "s2",
			pendingPrompt: "also bump the chart",
			pendingBy: "user",
		});
		await loop.runTurn(store.name, steered.id);
		expect(store.listTurns(steered.id)[0]!.inputBy).toBe("user");
	});

	test("a pending reply reaches a fresh interview session", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}demo`,
			null,
			"interview",
		);
		store.updateTask(task.id, {
			sessionId: "s1",
			pendingPrompt: "answer part two",
		});
		await loop.runTurn(store.name, task.id);

		expect(record.runs[0]!.prompt).toContain("answer part two");
		expect(store.listTurns(task.id)[0]!.input).toBe("answer part two");
	});

	test("kept reasons recognize both the delete keep and the cancel keep", () => {
		expect(cancelKeptReason("M f.ts")).toBe("Cancel kept the worktree: M f.ts");
		expect(isKeptReason(keptReason("M f.ts"))).toBe(true);
		expect(isKeptReason(cancelKeptReason("M f.ts"))).toBe(true);
		expect(isKeptReason("Release failed: push denied. Fix it.")).toBe(false);
		expect(isKeptReason(null)).toBe(false);
	});

	test("recoverRestarted settles open rows and requeues through the restart route", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				// The crashed predecessor's agent pid died with it.
				pidAlive: (pid: number) => pid !== 4344,
				targetSha: async (_mainPath: string, ref: string) =>
					ref === "HEAD" ? "abc123def" : null,
			}),
		);
		const task = store.createTask("interrupted");
		store.updateTask(task.id, {
			state: "running",
			sessionId: "sess-9",
			worktree: "wt-x",
			branch: "ott/x",
		});
		store.startTurn(task.id, "work", "old prompt", 4344);
		await loop.recoverRestarted();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("tracker restarted");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
		);
		expect(after.pendingPrompt).toBe(
			restartResumePrompt({ sha: "abc123def", clean: true }),
		);
		expect(record.runs).toHaveLength(0);
	});

	test("recoverRestarted leaves a card whose agent pid survived the restart running", async () => {
		let shaCalls = 0;
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				// pid 4344 is the predecessor's agent and it outlived the tracker restart.
				pidAlive: (pid: number) => pid === 4344,
				targetSha: async () => {
					shaCalls += 1;
					return "abc123def";
				},
			}),
		);
		const task = store.createTask("agent outlived the tracker");
		store.updateTask(task.id, {
			state: "running",
			sessionId: "sess-9",
			worktree: "wt-x",
			branch: "ott/x",
		});
		store.startTurn(task.id, "work", "old prompt", 4344);
		await loop.recoverRestarted();

		// The live pid owns the worktree: no settle, no requeue, no second startRun.
		// sweepLostTurns settles and requeues the card once the pid dies.
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).toBeNull();
		expect(turn.error).toBeNull();
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("running");
		expect(after.needsReason).toBeNull();
		expect(after.pendingPrompt).toBeNull();
		expect(record.runs).toHaveLength(0);
		expect(shaCalls).toBe(0);
		expect(logText(store, task.id)).toContain(
			"agent pid 4344 survived the tracker restart; leaving the card running",
		);
	});

	test("recoverRestarted ends a cancelled card idle and never requeues it", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, { maxTotalRuns: () => 0 }),
		);
		const task = store.createTask("cancelling");
		store.updateTask(task.id, {
			state: "running",
			sessionId: "sess-9",
			cancelledAt: Date.now(),
			pendingPrompt: "manual note",
		});
		store.startTurn(task.id, "work", "old prompt", 4344);
		await loop.recoverRestarted();

		// The row is settled, the dead cancel is finished: idle (hidden, no longer counted as
		// active by project remove), no requeue, no pendingPrompt write.
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("tracker restarted");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("idle");
		expect(after.pendingPrompt).toBe("manual note");
	});

	test("recoverRestarted keeps a pending reply over the restart resume prompt", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				// The crashed predecessor's agent pid died with it.
				pidAlive: (pid: number) => pid !== 4344,
				targetSha: async (_mainPath: string, ref: string) =>
					ref === "HEAD" ? "abc123def" : null,
			}),
		);
		const task = store.createTask("interrupted with a reply");
		store.updateTask(task.id, {
			state: "running",
			sessionId: "sess-9",
			worktree: "wt-x",
			branch: "ott/x",
			pendingPrompt: "typed reply",
		});
		store.startTurn(task.id, "work", "old prompt", 4344);
		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
		);
		expect(after.pendingPrompt).toBe("typed reply");
	});

	test("a restart re-sends a merge turn's prompt its session never saved", async () => {
		const { store, record, loop } = setup({
			// The crashed predecessor's agent pid died with it.
			pidAlive: (pid: number) => pid !== 4344,
			targetSha: async (_p: string, ref: string) =>
				ref === "HEAD" ? "abc123def" : null,
		});
		// The session file exists (the first turn saved it) but the merge prompt never reached it.
		saveSession(store, "sess-9");
		const task = store.createTask("merge work");
		store.updateTask(task.id, {
			state: "running",
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
			sessionId: "sess-9",
		});
		store.startTurn(
			task.id,
			"merge",
			mergePrompt({ branch: "ott/x", target: "main" }),
			4344,
		);
		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.pendingPrompt).toContain("Your turn to integrate");
		expect(after.pendingPrompt).toContain(
			restartResumePrompt({ sha: "abc123def", clean: true }),
		);

		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.prompt).toContain("Your turn to integrate");
		expect(record.runs[0]!.prompt).toContain("Tracker restarted.");
	});

	test("a restart re-sends an interrupted reply turn's text its session never saved", async () => {
		const { store, record, loop } = setup({
			// The crashed predecessor's agent pid died with it.
			pidAlive: (pid: number) => pid !== 4344,
			targetSha: async (_p: string, ref: string) =>
				ref === "HEAD" ? "abc123def" : null,
		});
		saveSession(store, "sess-9");
		const task = store.createTask("work then reply");
		store.updateTask(task.id, {
			state: "running",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
			sessionId: "sess-9",
		});
		store.startTurn(
			task.id,
			"work",
			replyPrompt({ text: "please also bump the chart", kind: "work" }),
			4344,
		);
		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.pendingPrompt).toContain("please also bump the chart");
		expect(after.pendingPrompt).toContain("Tracker restarted.");

		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.prompt).toContain("please also bump the chart");
	});

	test("a restart keeps the note alone when the session already holds the interrupted prompt", async () => {
		const { store, loop } = setup({
			// The crashed predecessor's agent pid died with it.
			pidAlive: (pid: number) => pid !== 4344,
			targetSha: async (_p: string, ref: string) =>
				ref === "HEAD" ? "abc123def" : null,
		});
		const task = store.createTask("merge work");
		store.updateTask(task.id, {
			state: "running",
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
			sessionId: "sess-9",
		});
		const merge = mergePrompt({ branch: "ott/x", target: "main" });
		store.startTurn(task.id, "merge", merge, 4344);
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `1_sess-9.jsonl`),
			`{"type":"message","message":{"role":"user","content":${JSON.stringify(merge)}}}\n`,
		);
		await loop.recoverRestarted();

		expect(store.getTask(task.id)!.pendingPrompt).toBe(
			restartResumePrompt({ sha: "abc123def", clean: true }),
		);
	});

	test("recoverRestarted requeues a preparing card with no turn row", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, { maxTotalRuns: () => 0 }),
		);
		const task = store.createTask("crashed in preparation");
		store.updateTask(task.id, { state: "preparing" });
		await loop.recoverRestarted();

		// No row existed, so nothing was finished; the card is requeued with the restart reason.
		expect(store.listTurns(task.id)).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
		);
		expect(logText(store, task.id)).toContain(
			"tracker restarted; requeueing the card",
		);

		// Cancellation invariant: a cancel that died with the tracker ends idle, never requeued.
		const cancelled = store.createTask("cancelled in preparation");
		store.updateTask(cancelled.id, {
			state: "preparing",
			cancelledAt: Date.now(),
			pendingPrompt: "manual note",
		});
		await loop.recoverRestarted();
		const cAfter = store.getTask(cancelled.id)!;
		expect(cAfter.state).toBe("idle");
		expect(cAfter.pendingPrompt).toBe("manual note");
	});

	test("recoverRestarted requeues a later preparation whose last row is already ended", async () => {
		const store = freshStore();
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, { maxTotalRuns: () => 0 }),
		);
		const task = store.createTask("crashed after a finished turn");
		store.updateTask(task.id, { state: "preparing" });
		store.startTurn(task.id, "work", "old prompt", 4344);
		store.finishTurn(store.listTurns(task.id)[0]!.id, {
			endedAt: 12345,
			exitCode: 0,
			error: null,
		});
		await loop.recoverRestarted();

		// The ended row is not settled twice: its original end stays untouched.
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).toBe(12345);
		expect(turn.error).toBeNull();
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
		);
		expect(after.pendingPrompt).toBe(".");

		// Cancellation invariant: a cancelled card with an ended row ends idle, its row untouched.
		const cancelled = store.createTask("cancelled after a finished turn");
		store.updateTask(cancelled.id, {
			state: "preparing",
			cancelledAt: Date.now(),
			pendingPrompt: "manual note",
		});
		store.startTurn(cancelled.id, "work", "old prompt", 4345);
		store.finishTurn(store.listTurns(cancelled.id)[0]!.id, {
			endedAt: 12346,
			exitCode: 0,
			error: null,
		});
		await loop.recoverRestarted();
		const cAfter = store.getTask(cancelled.id)!;
		expect(cAfter.state).toBe("idle");
		expect(cAfter.pendingPrompt).toBe("manual note");
		expect(store.listTurns(cancelled.id)).toHaveLength(1);
	});
});
describe("turn cancel, finish-kept and restart recovery", () => {
	/** Seeds a card with a live-looking worktree and returns it. */
	function seed(
		store: ProjectStore,
		patch: Record<string, unknown> = {},
	): ReturnType<ProjectStore["createTask"]> {
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			stage: "in_progress",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
			base: "abc",
			...patch,
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });
		return task;
	}

	test("cancel keeps a dirty worktree as needs_you with the kept reason", async () => {
		const { store, record, loop } = setup({
			unsavedWork: async () => "uncommitted changes to foo.txt",
			statusFiles: async () => ["foo.txt"],
		});
		const task = seed(store);
		const e = fakeProject(store);

		await expect(loop.cancel(e, task.id, false)).resolves.toEqual({
			kept: "uncommitted changes to foo.txt",
		});

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason?.startsWith("Cancel kept the worktree: ")).toBe(
			true,
		);
		expect(after.keptFiles).toEqual(["foo.txt"]);
		expect(after.cancelledAt).toBeNull();
		expect(record.removeWorktree).toHaveLength(0);
		expect(logText(store, task.id)).toContain("! cancel kept the worktree:");
	});

	test("cancel kills the run and removes a clean worktree", async () => {
		const { store, record, loop } = setup();
		const task = seed(store);
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: Promise.resolve(),
			kill: async () => {
				record.killed = true;
			},
		});

		await expect(
			loop.cancel(fakeProject(store), task.id, false),
		).resolves.toEqual({
			removed: true,
		});

		expect(record.killed).toBe(true);
		expect(record.removeWorktree).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("idle");
		expect(after.cancelledAt).not.toBeNull();
	});

	test("stop kills the run, keeps the session and parks the card at needs_you", async () => {
		const { promise, resolve } = Promise.withResolvers<RunResult>();
		const { store, record, loop } = setup({
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: promise,
					kill: async () => {
						record.killed = true;
						resolve(runResult({ killed: true, sawTerminalEnd: false }));
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

		await expect(loop.stopTurn(fakeProject(store), task.id)).resolves.toEqual({
			ok: true,
		});
		await run;

		expect(record.killed).toBe(true);
		expect(record.removeWorktree).toHaveLength(0);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe("stopped");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("Turn stopped.");
		expect(after.cancelledAt).toBeNull();
		expect(after.sessionId).toBe("sess-1");
		expect(after.stage).toBe("in_progress");
	});

	test("stop without a live run is a 409, unknown task a 404", async () => {
		const { store, loop } = setup();
		const task = seed(store);
		await expect(loop.stopTurn(fakeProject(store), task.id)).resolves.toEqual({
			error: "no turn is running",
			status: 409,
		});
		await expect(
			loop.stopTurn(fakeProject(store), "no-such-task"),
		).resolves.toEqual({ error: "unknown task", status: 404 });
	});

	test("stop on a cancelled task is a 409", async () => {
		const { store, loop } = setup();
		const task = seed(store, { cancelledAt: Date.now() });
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: Promise.resolve(),
			kill: async () => {},
		});
		await expect(loop.stopTurn(fakeProject(store), task.id)).resolves.toEqual({
			error: "task is cancelled",
			status: 409,
		});
	});

	test("a forced cancel deletes a dirty worktree anyway", async () => {
		let unsavedCalls = 0;
		const { store, loop } = setup({
			unsavedWork: async () => {
				unsavedCalls += 1;
				return "uncommitted changes";
			},
		});
		const task = seed(store);

		await expect(
			loop.cancel(fakeProject(store), task.id, true),
		).resolves.toEqual({
			removed: true,
		});

		expect(unsavedCalls).toBe(0);
		expect(store.getTask(task.id)!.state).toBe("idle");
	});

	test("a husk worktree has nothing to keep", async () => {
		let unsavedCalls = 0;
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			unsavedWork: async () => {
				unsavedCalls += 1;
				return "uncommitted changes";
			},
		});
		const task = seed(store);

		await expect(
			loop.cancel(fakeProject(store), task.id, false),
		).resolves.toEqual({
			removed: true,
		});

		expect(unsavedCalls).toBe(0);
		expect(record.removeWorktree).toHaveLength(1);
		// The default branchMergedOrGone mock returns true: the branch is merged, so it goes too.
		expect(record.removeWorktree[0]).toMatchObject({
			branch: `ott/${task.id}`,
		});
	});

	test("a husk cancel keeps the branch whose commits never reached the target", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			branchMergedOrGone: async () => false,
		});
		const task = seed(store);
		const e = fakeProject(store);

		await expect(loop.cancel(e, task.id, false)).resolves.toEqual({
			removed: true,
		});

		// The husk holds no checkout, but the branch holds the work: the cancel keeps it.
		expect(record.removeWorktree).toHaveLength(1);
		expect(record.removeWorktree[0]).toMatchObject({ branch: null });
		expect(logText(store, task.id)).toContain(
			`! cancel kept the branch ott/${task.id}: it holds commits that never reached abc`,
		);
		expect(store.getTask(task.id)!.state).toBe("idle");
	});

	test("finish-kept applies move/ignore/delete choices", async () => {
		const { store, record, loop } = setup();
		const task = seed(store, {
			state: "needs_you",
			needsReason: keptReason("uncommitted changes"),
			keptFiles: ["a.txt", "b.txt", "c.txt"],
		});
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "moved");
		const e = fakeProject(store);

		await expect(
			loop.finishKept(e, task.id, {
				"a.txt": "move",
				"b.txt": "ignore",
				"c.txt": "delete",
			}),
		).resolves.toEqual({ ok: true });

		expect(existsSync(join(store.path, "a.txt"))).toBe(true);
		expect(record.ignoreInMain).toEqual([
			{ mainPath: store.path, rel: "b.txt" },
		]);
		expect(record.removeWorktree).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.keptFiles).toEqual([]);
		expect(after.commits).toBe(3);
		expect(logText(store, task.id)).toContain(
			"finished kept worktree: 1 moved, 1 ignored, 1 deleted",
		);
	});

	test("finish-kept refuses while a turn is running", async () => {
		const { store, record, loop } = setup();
		const task = seed(store, {
			state: "needs_you",
			needsReason: keptReason("uncommitted changes"),
			keptFiles: ["a.txt"],
		});
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: Promise.resolve(),
			kill: async () => {},
		});

		expect(
			await loop.finishKept(fakeProject(store), task.id, { "a.txt": "move" }),
		).toEqual({ error: "a turn is running", status: 409 });
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a restart-interrupted cancel asks the kept-worktree question", async () => {
		const { store, record, loop } = setup({
			unsavedWork: async () => "uncommitted changes to bar.txt",
			statusFiles: async () => ["bar.txt"],
		});
		const task = seed(store);
		store.updateTask(task.id, { cancelledAt: Date.now() });
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason?.startsWith("Cancel kept the worktree: ")).toBe(
			true,
		);
		expect(after.keptFiles).toEqual(["bar.txt"]);
		expect(after.cancelledAt).toBeNull();
		expect(record.removeWorktree).toHaveLength(0);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("tracker restarted");
	});

	test("a restart-interrupted cancel removes a clean worktree", async () => {
		const { store, record, loop } = setup();
		const task = seed(store);
		store.updateTask(task.id, { cancelledAt: Date.now() });
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		expect(store.getTask(task.id)!.state).toBe("idle");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("recoverRestarted requeues a plain running task", async () => {
		const { store, loop } = setup({
			targetSha: async () => "abc123def456",
			isClean: async () => true,
		});
		const task = seed(store);
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
		);
		expect(after.pendingPrompt).toBe(
			restartResumePrompt({ sha: "abc123def456", clean: true }),
		);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("tracker restarted");
	});

	test("the demo switch keeps seeded cards through both sweeps and starts no queued card", async () => {
		const { store, record, loop } = setup({
			pidAlive: () => false,
			isClean: async () => true,
			targetSha: async () => "abc123def456",
			maxTotalRuns: () => null, // the dev board runs with no cap
		});
		process.env.OTTR_DEMO = "1";
		try {
			const a = seed(store);
			store.startTurn(a.id, "work", "carry on", null);
			const b = seed(store, { state: "preparing" });
			store.startTurn(b.id, "work", "carry on", null);
			store.setSettings({ maxParallel: null }); // only the demo switch may hold it
			const queued = store.createTask("queued demo card");

			await loop.recoverRestarted();
			loop.schedule();
			await flushPromises();

			expect(store.getTask(a.id)!.state).toBe("running");
			expect(store.getTask(b.id)!.state).toBe("preparing");
			expect(store.listTurns(a.id).at(-1)!.endedAt).toBeNull();
			expect(store.listTurns(b.id).at(-1)!.endedAt).toBeNull();
			expect(store.getTask(queued.id)!.state).toBe("queued");
			expect(record.runs).toHaveLength(0);
		} finally {
			delete process.env.OTTR_DEMO;
		}
	});

	test("cancel keeps a real dirty worktree under the Cancel prefix (R5-2)", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "turn-cancel-repo-"));
		dirs.push(repoDir);
		const run = (cmd: string) => execSync(cmd, { stdio: "ignore" });
		run(`git init -q ${repoDir}`);
		run(`git -C ${repoDir} config user.email t@t`);
		run(`git -C ${repoDir} config user.name t`);
		writeFileSync(join(repoDir, "seed.txt"), "s");
		run(`git -C ${repoDir} add seed.txt`);
		run(`git -C ${repoDir} commit -qm seed`);
		const base = execSync("git rev-parse HEAD", {
			cwd: repoDir,
			encoding: "utf8",
		}).trim();

		const record = baseRecord();
		const { store, loop } = setup({
			unsavedWork: realUnsavedWork,
			statusFiles: realStatusFiles,
			worktreeHusk: realWorktreeHusk,
		});
		const task = seed(store, { base });
		const wt = store.getTask(task.id)!.worktree!;
		run(`git -C ${repoDir} worktree add -q "${wt}" -b ${task.branch}`);
		writeFileSync(join(wt, "scratch.txt"), "unsaved");

		await expect(
			loop.cancel(fakeProject(store), task.id, false),
		).resolves.toEqual({ kept: expect.any(String) });

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		// Old code reused keptReason(), whose "Kept the worktree: " prefix is what the
		// supervisor's auto-tend matches: it replied to a card the user had just cancelled.
		expect(after.needsReason!.startsWith("Cancel kept the worktree: ")).toBe(
			true,
		);
		expect(after.needsReason!.startsWith("Kept the worktree: ")).toBe(false);
		expect(after.keptFiles).toContain("scratch.txt");
		expect(after.cancelledAt).toBeNull();
		expect(record.removeWorktree).toHaveLength(0);
	});
});

describe("arch-review survivor kills", () => {
	function deferred<T>() {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	/** Store view with selected methods overridden; the rest resolves through the prototype. */
	function proxyStore(
		store: ProjectStore,
		over: Record<string, unknown>,
	): ProjectStore {
		const p = Object.create(store) as ProjectStore & Record<string, unknown>;
		for (const [k, v] of Object.entries(over)) p[k] = v;
		return p as ProjectStore;
	}

	function spyErrors(): string[] {
		const seen: string[] = [];
		const orig = console.error;
		console.error = (_: unknown, err: unknown) => seen.push(String(err));
		spyErrorsRestore = () => {
			console.error = orig;
		};
		return seen;
	}
	let spyErrorsRestore: (() => void) | null = null;

	function openTurn(store: ProjectStore, id: string, pid: number | null) {
		store.updateTask(id, { state: "running" });
		store.startTurn(id, "work", "carry on", pid);
	}

	async function withErrors(fn: () => Promise<void> | void): Promise<string[]> {
		const seen = spyErrors();
		try {
			await fn();
		} finally {
			spyErrorsRestore?.();
			spyErrorsRestore = null;
		}
		return seen;
	}

	function parkedCard(store: ProjectStore) {
		const task = store.createTask("release v9.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "idle",
			needsReason: "waiting for the review's findings to be implemented",
			releaseVersion: "v9.0.0",
			base: "shaR",
			worktree: "wt-k",
			branch: "ott/k",
		});
		return task;
	}

	function keptTask(store: ProjectStore, patch: Record<string, unknown> = {}) {
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "needs_you",
			stage: "in_progress",
			needsReason: keptReason("M a.txt"),
			keptFiles: ["a.txt"],
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
			base: "abc",
			...patch,
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });
		return task;
	}

	// ---- settleLostTurn / recoverRestarted -------------------------------------

	test("recoverRestarted logs 'settling the turn' for an open row and 'requeueing the card' without one", async () => {
		const a = freshStore();
		const b = freshStore();
		const loop = createTurnLoop(
			new Map([
				[a.name, fakeProject(a)],
				[b.name, fakeProject(b)],
			]),
			fakeOps(baseRecord()),
		);
		const ta = a.createTask("open row");
		openTurn(a, ta.id, null);
		const tb = b.createTask("no row");
		b.updateTask(tb.id, { state: "running" });

		await loop.recoverRestarted();

		expect(logText(a, ta.id)).toContain(
			"! tracker restarted; settling the turn",
		);
		expect(logText(b, tb.id)).toContain(
			"! tracker restarted; requeueing the card",
		);
	});

	test("recoverRestarted with no worktree requeues with '.' and never reads the target sha", async () => {
		let shaCalls = 0;
		const { store, loop } = setup({
			targetSha: async () => {
				shaCalls += 1;
				return "abc";
			},
		});
		const task = store.createTask("bare card");
		store.updateTask(task.id, { state: "running", worktree: null });
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		expect(shaCalls).toBe(0);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe(".");
	});

	test("recoverRestarted falls back to '.' when the worktree sha read fails", async () => {
		const { store, loop } = setup({
			targetSha: async () => {
				throw new Error("git gone");
			},
		});
		const task = store.createTask("card");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe(".");
	});

	test("recoverRestarted requeues with the unchanged-tree hint only for a clean tree", async () => {
		const { store, loop } = setup({
			targetSha: async () => "abc123def456789",
			isClean: async () => {
				throw new Error("git gone");
			},
		});
		const task = store.createTask("card");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		// A dirty (unreadable = not proven clean) tree collapses to ".".
		expect(store.getTask(task.id)!.pendingPrompt).toBe(".");
	});

	test("recoverRestarted leaves non-running cards alone", async () => {
		const { store, loop } = setup();
		const task = store.createTask("idle card");
		store.updateTask(task.id, { state: "idle" });
		store.startTurn(task.id, "work", "carry on", null);

		await loop.recoverRestarted();

		expect(store.getTask(task.id)!.state).toBe("idle");
		// The open row was not settled behind the card's back.
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
	});

	test("a sick store does not stop recoverRestarted for the other projects", async () => {
		const sick = freshStore();
		const healthy = freshStore();
		const loop = createTurnLoop(
			new Map([
				// A fresh sick view per call: the prototype override throws every time.
				[
					sick.name,
					fakeProject(
						proxyStore(sick, {
							listTasks() {
								throw new Error("database is locked");
							},
						}),
					),
				],
				[healthy.name, fakeProject(healthy)],
			]),
			fakeOps(baseRecord()),
		);
		const task = healthy.createTask("fine here");
		healthy.updateTask(task.id, { state: "running" });
		healthy.startTurn(task.id, "work", "carry on", null);

		const seen = await withErrors(() => loop.recoverRestarted());

		expect(seen.join("\n")).toContain("database is locked");
		expect(healthy.getTask(task.id)!.state).toBe("queued");
	});

	test("recoverRestarted turns a failing settle row into a logged error", async () => {
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([
				[
					store.name,
					fakeProject(
						proxyStore(store, {
							finishTurn() {
								throw new Error("write failed");
							},
						}),
					),
				],
			]),
			fakeOps(baseRecord()),
		);
		const task = store.createTask("card");
		store.updateTask(task.id, { state: "running" });
		store.startTurn(task.id, "work", "carry on", null);

		const seen = await withErrors(() => loop.recoverRestarted());

		expect(seen.join("\n")).toContain("write failed");
	});

	// ---- sweepLostTurns ---------------------------------------------------------

	test("the lost sweep settles a claimed run whose agent pid died", async () => {
		const doneGate = deferred<RunResult>();
		const { store, record, loop } = setupWith(baseRecord(), {
			pidAlive: () => false,
			// The sweep requeues the card; the cap keeps the resumed turn from claiming it
			// mid-assertion.
			maxTotalRuns: () => 0,
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: doneGate.promise,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("hangs forever");
		const run = loop.runTurn(store.name, task.id);
		await flushPromises();

		loop.schedule();
		await flushPromises();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("lost agent process (pid 4242)");

		doneGate.resolve(runResult());
		await run;
	});

	test("the lost sweep logs a store that cannot be listed", async () => {
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([
				[
					store.name,
					fakeProject(
						proxyStore(store, {
							listTasks() {
								throw new Error("table missing");
							},
						}),
					),
				],
			]),
			fakeOps(baseRecord()),
		);

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("table missing");
	});

	test("the lost sweep skips a card whose row vanished before the settle", async () => {
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([
				[
					store.name,
					fakeProject(
						proxyStore(store, {
							getTask: () => null,
						}),
					),
				],
			]),
			fakeOps(baseRecord()),
		);
		const task = store.createTask("vanishing card");
		store.updateTask(task.id, { state: "running" });
		store.startTurn(task.id, "work", "carry on", null);

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		// The settle is skipped quietly: no task writes, no error log.
		expect(seen).toEqual([]);
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
	});

	test("the lost sweep turns a failing settle into a logged error", async () => {
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([
				[
					store.name,
					fakeProject(
						proxyStore(store, {
							finishTurn() {
								throw new Error("row write failed");
							},
						}),
					),
				],
			]),
			fakeOps(baseRecord()),
		);
		const task = store.createTask("card");
		store.updateTask(task.id, { state: "running" });
		store.startTurn(task.id, "work", "carry on", null);

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("row write failed");
	});

	// ---- schedule ----------------------------------------------------------------

	test("a store that cannot be listed rejects into the log, not the scheduler", async () => {
		const sick = freshStore();
		const healthy = freshStore();
		const loop = createTurnLoop(
			new Map([
				[
					sick.name,
					fakeProject(
						proxyStore(sick, {
							listTasks() {
								throw new Error("locked again");
							},
						}),
					),
				],
				[healthy.name, fakeProject(healthy)],
			]),
			fakeOps(baseRecord()),
		);
		const task = healthy.createTask("start me");
		healthy.updateTask(task.id, { state: "queued" });

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("locked again");
		// The healthy project still ran its runnable card.
		expect(healthy.getTask(task.id)!.state).not.toBe("queued");
	});

	// ---- settleReleases ------------------------------------------------------------

	test("a busy merging card parks settleReleases", async () => {
		const { store, record, projects, loop } = setup();
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		const merger = store.createTask("merging now");
		store.updateTask(merger.id, { stage: "merging", state: "running" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	test("a non-merging busy card does not block settleReleases", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		// The review's turn is settled long ago: a card created later is not a finding.
		const first = store.startTurn(task.id, "work", "review", 1);
		store.finishTurn(first.id, { endedAt: 1 });
		const worker = store.createTask("working now");
		store.updateTask(worker.id, { stage: "in_progress", state: "running" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(1);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a needs_you parked shape never publishes", async () => {
		// The recording fake: the default publishRelease records nothing, so a publish would
		// pass unnoticed.
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		store.updateTask(task.id, { state: "needs_you" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	test("overlapping ticks settle the same release card once", async () => {
		const gate = deferred<string>();
		const published: unknown[] = [];
		const { store, projects, loop } = setupWith(baseRecord(), {
			publishRelease: async () => {
				published.push(1);
				return gate.promise;
			},
		});
		projects.get(store.name)!.target = "origin/main";
		parkedCard(store);

		loop.schedule();
		loop.schedule();
		await flushPromises();

		expect(published).toHaveLength(1);
		gate.resolve("tagged");
		await flushPromises();
		expect(store.getTask(store.listTasks()[0]!.id)!.stage).toBe("done");
	});

	test("a settled release holds for findings created before its last turn ended", async () => {
		const { store, record, projects, loop } = setup();
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		store.startTurn(task.id, "work", "review", 1);
		// endedAt in the future: the finding (created now) lands before `end` -> hold.
		store.finishTurn(store.listTurns(task.id)[0]!.id, {
			endedAt: Date.now() + 60_000,
		});
		const finding = store.createTask("late finding");
		store.updateTask(finding.id, { stage: "in_progress" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
	});

	test("a release hold uses the last turn row, not the first", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		// Two settled rows: the FIRST ends in the future, the LAST long ago. Only reading the
		// last row (end = 1) puts the later-created finding outside the window and publishes.
		const first = store.startTurn(task.id, "work", "review", 1);
		store.finishTurn(first.id, { endedAt: Date.now() + 60_000 });
		const second = store.startTurn(task.id, "work", "review", 2);
		store.finishTurn(second.id, { endedAt: 1 });
		const finding = store.createTask("late finding");
		store.updateTask(finding.id, { stage: "in_progress" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(1);
	});

	test("a card with no turn rows holds against later findings", async () => {
		const { store, record, projects, loop } = setup();
		projects.get(store.name)!.target = "origin/main";
		parkedCard(store);
		const finding = store.createTask("late finding");
		store.updateTask(finding.id, { stage: "in_progress" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
	});

	test("a finished settle frees its cap slot for the next tick", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			maxTotalRuns: () => 1,
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		parkedCard(store);
		loop.schedule();
		await flushPromises();
		expect(record.publishRelease).toHaveLength(1);

		const task = store.createTask("start me next tick");
		store.updateTask(task.id, { state: "queued" });
		loop.schedule();
		await flushPromises();

		// The freed cap slot lets the queued card start. The loop may legitimately chain its
		// merge turn in the same drain; the mutant target (preparing.delete dropped) yields 0.
		expect(record.runs.length).toBeGreaterThanOrEqual(1);
	});

	test("a settled release card can be re-parked and publishes again", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedCard(store);
		loop.schedule();
		await flushPromises();
		expect(record.publishRelease).toHaveLength(1);

		store.updateTask(task.id, {
			stage: "merging",
			state: "idle",
			needsReason: "waiting for the review's findings to be implemented",
		});
		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(2);
	});

	test("a settle that cannot list tasks rejects into the log", async () => {
		const store = freshStore();
		const loop = createTurnLoop(
			new Map([
				[
					store.name,
					fakeProject(
						proxyStore(store, {
							listTasks() {
								throw new Error("settle boom");
							},
						}),
					),
				],
			]),
			fakeOps(baseRecord()),
		);

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("settle boom");
	});

	// ---- runTurn: pre-run ownership and turn input ---------------------------------

	test("a cancel landing during ensurePackages stops the run before the spawn", async () => {
		const { store, record, loop } = setup({
			ensurePackages: async () => {
				store.updateTask(store.listTasks()[0]!.id, {
					cancelledAt: Date.now(),
				});
				return [];
			},
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			state: "queued",
			worktree: "wt-p",
			branch: "ott/p",
			base: "sha0",
		});

		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(0);
		// The card still stands where the cancel left it; no settle clobbered it.
		expect(store.getTask(task.id)!.state).toBe("preparing");
		expect(store.getTask(task.id)!.cancelledAt).not.toBeNull();
	});

	test("a task deleted mid-prepare stops quietly instead of erroring", async () => {
		const store = freshStore();
		let armed = false;
		const real = store.getTask.bind(store);
		const view = proxyStore(store, {
			getTask(id: string) {
				const t = real(id);
				return armed && t ? null : t;
			},
		});
		const record = baseRecord();
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(view)]]),
			fakeOps(record, {
				ensurePackages: async () => {
					armed = true;
					return [];
				},
			}),
		);
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			state: "queued",
			worktree: "wt-p",
			branch: "ott/p",
			base: "sha0",
		});

		await loop.runTurn(store.name, task.id);

		// Quiet stop: no run, the card stands where the claim left it.
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)!.state).toBe("preparing");
	});

	test("a reply to a saved session is recorded as the turn's input", async () => {
		const { store, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			sessionId: "sess-1",
			pendingPrompt: "add tests",
		});
		saveSession(store, "sess-1");

		await loop.runTurn(store.name, task.id);

		expect(store.listTurns(task.id)[0]!.input).toBe("add tests");
	});

	test("a '.' continue on a fresh session is not recorded as user text", async () => {
		const { store, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, { sessionId: "sess-1", pendingPrompt: "." });

		await loop.runTurn(store.name, task.id);

		expect(store.listTurns(task.id)[0]!.input).toBeNull();
	});

	test("a '.' continue on a saved session is recorded as user text", async () => {
		const { store, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, { sessionId: "sess-1", pendingPrompt: "." });
		saveSession(store, "sess-1");

		await loop.runTurn(store.name, task.id);

		expect(store.listTurns(task.id)[0]!.input).toBe(".");
	});

	test("a real reply folded into a fresh session is recorded as user text", async () => {
		const { store, loop } = setup();
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			sessionId: "sess-1",
			pendingPrompt: "do stuff",
		});

		await loop.runTurn(store.name, task.id);

		expect(store.listTurns(task.id)[0]!.input).toBe("do stuff");
	});

	// ---- keptFiles at settle ---------------------------------------------------------

	test("a done work turn clears stale keptFiles", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			statusFiles: async () => ["leftover.txt"],
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, { keptFiles: ["stale.txt"] });

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(store.getTask(task.id)!.keptFiles).toEqual([]);
		expect(store.getTask(task.id)!.uncommittedFiles).toEqual(["leftover.txt"]);
	});

	test("a done release card leaves keptFiles untouched", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			isIntegrated: async () => true,
			startRun: integratedRun(record),
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = store.createTask("release v1.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-x",
			branch: "ott/rel",
			keptFiles: ["history.txt"],
		});

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(store.getTask(task.id)!.keptFiles).toEqual(["history.txt"]);
	});

	test("finishing a kept worktree keeps the run's uncommitted files on the done card", async () => {
		const { store, loop, record } = setup();
		const task = store.createTask("kept work");
		const wt = join(store.worktreesDir, task.id);
		store.updateTask(task.id, {
			state: "needs_you",
			stage: "in_progress",
			needsReason: keptReason("M a.txt"),
			keptFiles: ["a.txt"],
			worktree: wt,
			branch: `ott/${task.id}`,
			base: "abc",
		});
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "a.txt"), "moved");
		const e = fakeProject(store);

		await loop.finishKept(e, task.id, {});

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		// The kept list is this run's uncommitted files: the done drawer keeps the
		// names now that the worktree they lived in is gone.
		expect(after.uncommittedFiles).toEqual(["a.txt"]);
		expect(after.keptFiles).toEqual([]);
		expect(record.removeWorktree).toHaveLength(1);
	});

	// ---- cancel ----------------------------------------------------------------------

	test("cancel removes the worktree with its exact coordinates", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
			base: "abc",
		});

		await loop.cancel(fakeProject(store), task.id, false);

		expect(record.removeWorktree).toEqual([
			{
				mainPath: store.path,
				worktreePath: join(store.worktreesDir, task.id),
				branch: `ott/${task.id}`,
				log: expect.any(Function),
			},
		]);
	});

	test("a failing cancel removal is logged, not thrown", async () => {
		const { store, loop } = setup({
			removeWorktree: async () => {
				throw new Error("busy worktree");
			},
		});
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
			base: "abc",
		});

		await expect(
			loop.cancel(fakeProject(store), task.id, false),
		).resolves.toEqual({ removed: true });
		expect(logText(store, task.id)).toContain(
			"! cancel removeWorktree: busy worktree",
		);
	});

	test("a cancel with no known base names that in the kept reason", async () => {
		const { store, loop } = setup({
			unsavedWork: async () => "uncommitted changes to foo.txt",
		});
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
			base: null,
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });

		await expect(
			loop.cancel({ ...fakeProject(store), target: null }, task.id, false),
		).resolves.toEqual({ kept: "its base commit is unknown" });

		expect(store.getTask(task.id)!.needsReason).toBe(
			"Cancel kept the worktree: its base commit is unknown",
		);
	});

	test("a done card's worktree is cancelled like a forced one", async () => {
		let unsavedCalls = 0;
		const { store, record, loop } = setup({
			unsavedWork: async () => {
				unsavedCalls += 1;
				return "uncommitted changes";
			},
		});
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			stage: "done",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });

		await expect(
			loop.cancel(fakeProject(store), task.id, false),
		).resolves.toEqual({ removed: true });
		expect(unsavedCalls).toBe(0);
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("a release card's worktree is cancelled like a forced one", async () => {
		let unsavedCalls = 0;
		const { store, record, loop } = setup({
			unsavedWork: async () => {
				unsavedCalls += 1;
				return "uncommitted changes";
			},
		});
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });

		await expect(
			loop.cancel(fakeProject(store), task.id, false),
		).resolves.toEqual({ removed: true });
		expect(unsavedCalls).toBe(0);
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("a forced cancel deletes a dirty worktree anyway", async () => {
		let unsavedCalls = 0;
		const { store, loop } = setup({
			unsavedWork: async () => {
				unsavedCalls += 1;
				return "uncommitted changes";
			},
		});
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
		});
		mkdirSync(join(store.worktreesDir, task.id), { recursive: true });

		await expect(
			loop.cancel(fakeProject(store), task.id, true),
		).resolves.toEqual({ removed: true });
		expect(unsavedCalls).toBe(0);
	});

	test("a task deleted under a live run makes cancel report the unknown task", async () => {
		const store = freshStore();
		let armed = false;
		const real = store.getTask.bind(store);
		const view = proxyStore(store, {
			getTask(id: string) {
				const t = real(id);
				return armed && t ? null : t;
			},
		});
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(view)]]),
			fakeOps(baseRecord()),
		);
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			state: "running",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
		});
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: Promise.resolve(),
			kill: async () => {
				armed = true;
			},
		});

		await expect(
			loop.cancel(fakeProject(view), task.id, false),
		).rejects.toThrow(/unknown task/);
	});

	// ---- finishKept ------------------------------------------------------------------

	async function finishKeptCase(
		patch: Record<string, unknown> = {},
		overrides: Partial<TurnOps> = {},
	) {
		const { store, record, projects, loop } = setup(overrides);
		projects.get(store.name)!.target = "origin/main";
		const task = keptTask(store, patch);
		return {
			store,
			record,
			loop,
			task,
			e: projects.get(store.name)!,
		};
	}

	test("finish-kept on an unknown task answers 404 unknown task", async () => {
		const { store, loop } = await finishKeptCase();
		await expect(
			loop.finishKept(fakeProject(store), "no-such-task", {}),
		).resolves.toEqual({ error: "unknown task", status: 404 });
	});

	test("finish-kept refuses cards not parked on a kept worktree", async () => {
		const idle = await finishKeptCase({ state: "idle" });
		await expect(
			idle.loop.finishKept(idle.e, idle.task.id, {}),
		).resolves.toEqual({
			error: "task is not kept on a worktree",
			status: 409,
		});

		const todo = await finishKeptCase({ stage: "todo" });
		await expect(
			todo.loop.finishKept(todo.e, todo.task.id, {}),
		).resolves.toEqual({
			error: "task is not kept on a worktree",
			status: 409,
		});

		const asked = await finishKeptCase({
			needsReason: "Which database should I use?",
		});
		await expect(
			asked.loop.finishKept(asked.e, asked.task.id, {}),
		).resolves.toEqual({
			error: "task is not kept on a worktree",
			status: 409,
		});
	});

	test("finish-kept works for both kept stages", async () => {
		const inProgress = await finishKeptCase({ keptFiles: ["a.txt"] });
		writeFileSync(
			join(inProgress.store.worktreesDir, inProgress.task.id, "a.txt"),
			"moved",
		);
		await expect(
			inProgress.loop.finishKept(inProgress.e, inProgress.task.id, {}),
		).resolves.toEqual({ ok: true });

		const merging = await finishKeptCase({
			stage: "merging",
			keptFiles: ["a.txt"],
		});
		writeFileSync(
			join(merging.store.worktreesDir, merging.task.id, "a.txt"),
			"moved",
		);
		await expect(
			merging.loop.finishKept(merging.e, merging.task.id, {}),
		).resolves.toEqual({ ok: true });
	});

	test("finish-kept moves, ignores and deletes kept files", async () => {
		const { store, record, loop, task, e } = await finishKeptCase({
			keptFiles: ["a.txt", "b.txt", "c.txt"],
		});
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "moved");

		await expect(
			loop.finishKept(e, task.id, {
				"a.txt": "move",
				"b.txt": "ignore",
				"c.txt": "delete",
			}),
		).resolves.toEqual({ ok: true });

		expect(existsSync(join(store.path, "a.txt"))).toBe(true);
		expect(record.ignoreInMain).toEqual([
			{ mainPath: store.path, rel: "b.txt" },
		]);
		expect(record.removeWorktree).toEqual([
			{
				mainPath: store.path,
				worktreePath: join(store.worktreesDir, task.id),
				branch: store.getTask(task.id)!.branch,
				log: expect.any(Function),
			},
		]);
	});

	test("finish-kept refuses when HEAD is not integrated", async () => {
		const { store, loop, task, e } = await finishKeptCase(
			{
				keptFiles: [],
			},
			{ isIntegrated: async () => false },
		);
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "x");

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			error: "HEAD is not integrated into origin/main",
			status: 409,
		});
	});

	test("finish-kept treats an isIntegrated failure as not integrated", async () => {
		const { store, loop, task, e } = await finishKeptCase(
			{
				keptFiles: [],
			},
			{
				isIntegrated: async () => {
					throw new Error("git exploded");
				},
			},
		);
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "x");

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			error: "HEAD is not integrated into origin/main",
			status: 409,
		});
	});

	test("finish-kept on a husk without a branch asks for the branch", async () => {
		const { loop, task, e } = await finishKeptCase(
			{
				worktree: null,
				branch: null,
				keptFiles: [],
			},
			{ worktreeHusk: async () => true },
		);

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			error: "worktree is missing and no branch to check",
			status: 409,
		});
	});

	test("finish-kept refuses a husk whose branch never merged", async () => {
		const { loop, task, e } = await finishKeptCase(
			{
				keptFiles: [],
			},
			{
				worktreeHusk: async () => true,
				branchMergedOrGone: async () => false,
			},
		);

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			error: `branch ${e.store.getTask(task.id)!.branch} has commits that never reached origin/main`,
			status: 409,
		});
	});

	test("finish-kept accepts a husk whose branch merged", async () => {
		const { record, loop, task, e } = await finishKeptCase(
			{
				keptFiles: [],
			},
			{
				worktreeHusk: async () => true,
				branchMergedOrGone: async () => true,
			},
		);

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			ok: true,
		});
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("finish-kept refuses without any integration target", async () => {
		const { store, loop, task, e } = await finishKeptCase({ base: null });
		e.target = null;
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "x");

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			error: "no integration target",
			status: 409,
		});
	});

	test("finish-kept answers 400 for an invalid choice value", async () => {
		const { store, loop, task, e } = await finishKeptCase();
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "x");

		await expect(
			loop.finishKept(e, task.id, { "a.txt": "bogus" }),
		).resolves.toEqual({
			error: "choice for a.txt must be move, ignore, or delete",
			status: 400,
		});
	});

	test("finish-kept answers 400 for a path outside the kept list", async () => {
		const { loop, task, e } = await finishKeptCase();

		await expect(
			loop.finishKept(e, task.id, { "zzz.txt": "move" }),
		).resolves.toEqual({ error: "unknown kept file: zzz.txt", status: 400 });
	});

	test("finish-kept refuses to move onto an existing main-checkout file", async () => {
		const { store, loop, task, e } = await finishKeptCase();
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "moved");
		writeFileSync(join(store.path, "a.txt"), "already here");

		await expect(
			loop.finishKept(e, task.id, { "a.txt": "move" }),
		).resolves.toEqual({
			error: "file already exists in the main checkout: a.txt",
			status: 409,
		});
	});

	test.skipIf(process.platform !== "linux")(
		"finish-kept moves a symlinked kept file as a link, not the target's content",
		async () => {
			const { store, loop, task, e } = await finishKeptCase();
			const outside = mkdtempSync(join(tmpdir(), "turn-kept-secret-"));
			dirs.push(outside);
			const secret = join(outside, "secret.txt");
			writeFileSync(secret, "top secret");
			symlinkSync(secret, join(store.worktreesDir, task.id, "a.txt"));

			await expect(
				loop.finishKept(e, task.id, { "a.txt": "move" }),
			).resolves.toEqual({ ok: true });

			const moved = join(store.path, "a.txt");
			expect(lstatSync(moved).isSymbolicLink()).toBe(true);
			expect(readlinkSync(moved)).toBe(secret);
			expect(readFileSync(secret, "utf8")).toBe("top secret");
		},
	);

	test.skipIf(process.platform !== "linux")(
		"finish-kept keeps a relative link inside the worktree pointing at the moved sibling",
		async () => {
			const { store, loop, task, e } = await finishKeptCase({
				keptFiles: ["out/latest", "out/run-3"],
			});
			const out = join(store.worktreesDir, task.id, "out");
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "run-3"), "run");
			symlinkSync("run-3", join(out, "latest"));

			await expect(
				loop.finishKept(e, task.id, {
					"out/latest": "move",
					"out/run-3": "move",
				}),
			).resolves.toEqual({ ok: true });

			const moved = join(store.path, "out", "latest");
			expect(readlinkSync(moved)).toBe("run-3");
			expect(readFileSync(moved, "utf8")).toBe("run");
		},
	);

	test.skipIf(process.platform !== "linux")(
		"finish-kept refuses a move through a symlinked main-checkout dir",
		async () => {
			const { store, loop, task, e } = await finishKeptCase({
				keptFiles: ["sub/f.txt"],
			});
			const outside = mkdtempSync(join(tmpdir(), "turn-kept-outside-"));
			dirs.push(outside);
			mkdirSync(join(store.worktreesDir, task.id, "sub"), { recursive: true });
			writeFileSync(join(store.worktreesDir, task.id, "sub", "f.txt"), "x");
			symlinkSync(outside, join(store.path, "sub"));

			const res = (await loop.finishKept(e, task.id, {
				"sub/f.txt": "move",
			})) as { error: string; status: number };

			expect(res.status).toBe(409);
			expect(res.error).toMatch(/cannot move sub\/f.txt/);
			expect(res.error).toMatch(/refusing/);
			expect(readdirSync(outside)).toEqual([]);
		},
	);

	test("finish-kept refuses a move when the worktree is gone", async () => {
		const { loop, task, e } = await finishKeptCase(
			{
				worktree: null,
			},
			{
				worktreeHusk: async () => true,
				branchMergedOrGone: async () => true,
			},
		);

		await expect(
			loop.finishKept(e, task.id, { "a.txt": "move" }),
		).resolves.toEqual({
			error: "file missing in the worktree: a.txt",
			status: 409,
		});
	});

	test("finish-kept refuses a move whose file is missing in the worktree", async () => {
		const { loop, task, e } = await finishKeptCase();

		await expect(
			loop.finishKept(e, task.id, { "a.txt": "move" }),
		).resolves.toEqual({
			error: "file missing in the worktree: a.txt",
			status: 409,
		});
	});

	test("finish-kept on a worktree-less kept card skips the removal", async () => {
		const { record, loop, task, e } = await finishKeptCase(
			{
				worktree: null,
				branch: "ott/ghost",
				keptFiles: [],
			},
			{ worktreeHusk: async () => true, branchMergedOrGone: async () => true },
		);

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			ok: true,
		});
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("finish-kept removal failure still finishes the card", async () => {
		const { store, loop, task, e } = await finishKeptCase(
			{
				keptFiles: [],
			},
			{
				removeWorktree: async () => {
					throw new Error("remove boom");
				},
			},
		);
		writeFileSync(join(store.worktreesDir, task.id, "a.txt"), "x");

		await expect(loop.finishKept(e, task.id, {})).resolves.toEqual({
			ok: true,
		});
		expect(logText(store, task.id)).toContain("! removeWorktree: remove boom");
	});
});

describe("turn update-card merge hold (U7)", () => {
	test("a hold-update-merges project parks a done update card for a reply", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"] });
		store.setSettings({ holdUpdateMerges: true });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(UPDATE_HOLD_REASON);
		// Not done: the worktree stays for the approving settle to integrate.
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("no hold when the setting is off", async () => {
		// commitsAhead 0: a ready work settle integrates straight to done.
		const { store, loop } = setup({ commitsAhead: async () => 0 });
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"] });
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("no hold without updateIds", async () => {
		const { store, loop } = setup({ commitsAhead: async () => 0 });
		const task = store.createTask("plain work");
		store.setSettings({ holdUpdateMerges: true });
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("an approval binds to the parked head: a later commit parks the card again", async () => {
		let head: string | null = "sha-1";
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			targetSha: async (_p: string, ref: string) =>
				ref === "HEAD" ? head : null,
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"] });
		store.setSettings({ holdUpdateMerges: true });
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.holdHead).toBe("sha-1");
		// What POST /reply does (U7): queue the card and approve the parked head.
		const approve = () =>
			store.updateTask(task.id, {
				pendingPrompt: "approved",
				state: "queued",
				queuedAt: Date.now(),
				needsReason: null,
				updateMergeHead: store.getTask(task.id)!.holdHead,
				holdHead: null,
			});
		approve();
		head = "sha-2"; // the agent commits after the approval
		await loop.runTurn(store.name, task.id);
		let after = store.getTask(task.id)!;
		expect(after.needsReason).toBe(UPDATE_HOLD_REASON);
		expect(after.holdHead).toBe("sha-2");
		expect(record.removeWorktree).toHaveLength(0);
		// HEAD unreadable: an approval never matches, the hold fails closed.
		approve();
		head = null;
		await loop.runTurn(store.name, task.id);
		after = store.getTask(task.id)!;
		expect(after.needsReason).toBe(UPDATE_HOLD_REASON);
		expect(after.holdHead).toBeNull();
		expect(after.updateMergeHead).toBeNull(); // the park spent the sha-2 approval
		// A reply with no parked head approves nothing; the next settle parks at sha-2 again.
		head = "sha-2";
		approve();
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.holdHead).toBe("sha-2");
		// Approved at the head the next settle sees: it integrates.
		approve();
		await loop.runTurn(store.name, task.id);
		after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("an agent's own needs_you with the hold text leaves no head to approve", async () => {
		const { store, loop } = setup({
			targetSha: async () => "sha-1",
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "hold",
								question: UPDATE_HOLD_REASON,
							},
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"], holdHead: "stale" });
		store.setSettings({ holdUpdateMerges: true });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.needsReason).toBe(UPDATE_HOLD_REASON);
		expect(after.holdHead).toBeNull();
	});

	// AGEN-24: the parked hold text reached the approving turn as a rejected report and the
	// agent read "reply to approve the merge" as an order to merge itself. The approval now
	// queues a merge turn with no prompt text; a change-request reply still rides alone.
	test("a change-request reply's work-turn prompt carries no rejected-hold line", async () => {
		const head = "sha-1";
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			targetSha: async (_p: string, ref: string) =>
				ref === "HEAD" ? head : null,
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"] });
		store.setSettings({ holdUpdateMerges: true });
		saveSession(store, "sess-1");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.holdHead).toBe("sha-1");
		// A non-approval reply queues a work turn with the text; the hold stays parked.
		store.updateTask(task.id, {
			pendingPrompt: "Update approved",
			pendingBy: "user",
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
		});
		await loop.runTurn(store.name, task.id);
		const prompt = record.runs.at(-1)!.prompt;
		// The agent sees the user's reply only: the hold text is not a rejection.
		expect(prompt).toContain("Update approved");
		expect(prompt).not.toContain(
			"The tracker rejected your last report_outcome",
		);
		// The hold was not spent: the settle parks the card again for an approval.
		expect(store.getTask(task.id)!.stage).toBe("in_progress");
		expect(store.getTask(task.id)!.needsReason).toBe(UPDATE_HOLD_REASON);
	});

	test("an approved card whose worktree is gone and whose head is on the target settles done", async () => {
		let head: string | null = "sha-1";
		// AGEN-33: the approval queues the normal merge turn; the merge agent lands it and
		// removes the worktree before it reports. The worktree is alive at dispatch (the
		// pre-dispatch husk guard must not settle the card) and gone by the settle: the HEAD
		// read fails there and the target proves the approved head landed, so the card
		// settles done instead of parking.
		let merged = false;
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			targetSha: async (_p: string, ref: string) =>
				ref === "HEAD" ? head : null,
			worktreeHusk: async () => merged,
			worktreeLinked: async () => !merged,
			branchMergedOrGone: async () => merged,
			isIntegrated: async () => merged,
			targetContains: async () => merged,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				// The merge lands and the worktree disappears mid-run, only on the
				// approving run: the first run still parks the hold normally.
				if (record.runs.length === 2) {
					merged = true;
					head = null; // the worktree is gone: the HEAD read fails
				}
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: merged
								? {
										status: "integrated",
										summary: "merged and removed the worktree",
									}
								: { status: "answered", summary: "did it" },
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"] });
		store.setSettings({ holdUpdateMerges: true });
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.holdHead).toBe("sha-1");
		// What POST /reply does now: the approval spends the parked head and queues the
		// merge turn; no work turn runs for it.
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
			updateMergeHead: store.getTask(task.id)!.holdHead,
			holdHead: null,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// The approved head is contained in the target: done, never parked again.
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		// Both turns dispatched: the in-run hold settle settled the card, not the
		// pre-dispatch guard (that one has its own no-dispatch test below).
		expect(record.runs).toHaveLength(2);
	});

	// OTTR-341: an approval whose worktree is already gone must not dispatch a turn into
	// the dead cwd (AGEN-24: every worker refused the turn with a 400, and the card stayed
	// needs_you forever on a lost-worker reason).
	test("an approved update card with no worktree and its head on the target settles done with no dispatch", async () => {
		const { store, record, loop } = setup({
			// The worktree was removed after the agent merged by itself (AGEN-24); the target
			// proves the approved head landed.
			worktreeHusk: async () => true,
			targetContains: async () => true,
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, {
			updateIds: ["a@1"],
			worktree: "/nonexistent/ottr-341-worktree",
			branch: "ott/update-pins",
		});
		// The approval state (the parked head spent, holdHead cleared); the pre-dispatch
		// guard ignores stage and consumes any queued reply text.
		store.updateTask(task.id, {
			pendingPrompt: "Approved.",
			pendingBy: "user",
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
			updateMergeHead: "sha-1",
			holdHead: null,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		// The turn never ran, so its queued reply is consumed and no worker saw the dead cwd.
		expect(after.pendingPrompt).toBeNull();
		expect(record.runs).toHaveLength(0);
	});

	test("a fork-born card approved with its worktree gone and its head on the target settles done", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			targetContains: async () => true,
		});
		const task = store.createTask("fork follow-up");
		store.updateTask(task.id, {
			worktree: "/nonexistent/ottr-341-worktree",
			branch: "ott/fork-follow-up",
		});
		store.updateTask(task.id, {
			pendingPrompt: "Approved.",
			pendingBy: "user",
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
			forkMergeHead: "sha-2",
			holdHead: null,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		expect(record.runs).toHaveLength(0);
	});

	test("an approved card with no worktree and its head not on the target parks with the worktree-gone reason", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			// Fails closed like the real git read: containment must be proven, never assumed.
			targetContains: async () => false,
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, {
			updateIds: ["a@1"],
			worktree: "/nonexistent/ottr-341-worktree",
			branch: "ott/update-pins",
		});
		store.updateTask(task.id, {
			pendingPrompt: "Approved.",
			pendingBy: "user",
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
			updateMergeHead: "sha-1",
			holdHead: null,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"The card's worktree is gone; its work is not on origin/main. Cancel the card or recreate the work.",
		);
		expect(record.runs).toHaveLength(0);
	});

	// OTTR-349: a branch whose tip still sits at its base proves nothing — review, release
	// and retro cards never commit, and base is always an ancestor of the target. The guard
	// must not settle such a card done on that vacuous proof; it rebuilds the worktree instead.
	test("a husk worktree whose branch has no commits past base recreates the worktree and dispatches", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			// The zero-commit branch tip sits at base (sha0), which is always an ancestor of the
			// target: containment holds vacuously and must not settle the card done unheard.
			targetSha: async (_p, ref) =>
				ref === "refs/heads/ott/do-a-thing" ? "sha0" : null,
			targetContains: async () => true,
		});
		const task = store.createTask("do a thing");
		store.updateTask(task.id, {
			worktree: join(tmpdir(), "ottr-349-worktree"),
			branch: "ott/do-a-thing",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.createWorktree).toHaveLength(1);
		expect(record.createWorktree[0]).toMatchObject({
			worktreePath: join(tmpdir(), "ottr-349-worktree"),
			branch: "ott/do-a-thing",
			base: "sha0",
		});
		// The turn ran in the rebuilt worktree; no done settle consumed it unheard.
		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.needsReason).toBeNull();
	});

	// OTTR-347: a husk whose branch survives holds the work; the tracker rebuilds the
	// worktree from the branch and dispatches instead of parking.
	test("a queued card whose husk worktree can be rebuilt from its branch recreates and dispatches", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			// The branch exists with a head the target does not contain.
			targetSha: async (_p: string, ref: string) =>
				ref === "refs/heads/ott/rebuild-me" ? "branch-sha" : null,
		});
		const task = store.createTask("rebuild me");
		store.updateTask(task.id, {
			// A path whose missing parents sit under a writable root: the fake createWorktree
			// mkdirs the path, and "/nonexistent/..." throws EACCES for a non-root runner,
			// which parked the turn as "Tracker error" and left record.runs empty on CI.
			worktree: join(tmpdir(), "ottr-347-rebuild-worktree"),
			branch: "ott/rebuild-me",
		});

		await loop.runTurn(store.name, task.id);

		expect(record.createWorktree).toHaveLength(1);
		expect(record.createWorktree[0]).toMatchObject({
			branch: "ott/rebuild-me",
			base: "branch-sha",
		});
		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.needsReason).toBeNull();
	});

	test("a review card's husk worktree on its frozen base recreates and runs instead of settling done", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			// The review card's branch sits at its frozen base: containment is vacuous.
			targetSha: async (_p, ref) =>
				ref === "refs/heads/ott/review-the-board" ? "sha0" : null,
			targetContains: async () => true,
		});
		const task = store.createTask("review the board", null, "review");
		store.updateTask(task.id, {
			base: "sha0",
			worktree: join(tmpdir(), "ottr-349-review-worktree"),
			branch: "ott/review-the-board",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.createWorktree).toHaveLength(1);
		// The review ran; the buggy guard settled the card done with zero runs here.
		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.needsReason).toBeNull();
	});

	test("a husk worktree whose branch is gone recreates the worktree from base", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			// The branch ref is gone: no proof either way, and a husk holds nothing recoverable.
			targetSha: async () => null,
		});
		const task = store.createTask("do a thing");
		store.updateTask(task.id, {
			worktree: join(tmpdir(), "ottr-349-gone-branch-worktree"),
			branch: "ott/do-a-thing",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.createWorktree).toHaveLength(1);
		expect(record.createWorktree[0]).toMatchObject({
			branch: "ott/do-a-thing",
			base: "sha0",
		});
		expect(record.runs).toHaveLength(1);
	});

	test("a husk worktree whose branch is gone and whose approved head is not on the target parks", async () => {
		const { store, record, loop } = setup({
			worktreeHusk: async () => true,
			// The branch ref is gone and the approved head never reached the target: nothing
			// to rebuild from, so the card parks for the user.
			targetSha: async () => null,
			targetContains: async () => false,
		});
		const task = store.createTask("do a thing");
		store.updateTask(task.id, {
			worktree: join(tmpdir(), "ottr-347-park-worktree"),
			branch: "ott/do-a-thing",
			updateMergeHead: "sha9",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"The card's worktree is gone; its work is not on origin/main. Cancel the card or recreate the work.",
		);
		expect(record.runs).toHaveLength(0);
		expect(record.createWorktree).toHaveLength(0);
	});

	test("a queued card whose worktree still exists dispatches as before", async () => {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
		});
		const task = store.createTask("do a thing");
		store.updateTask(task.id, {
			worktree: "/fake/ottr-341-worktree",
			branch: "ott/do-a-thing",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.needsReason).toBeNull();
	});
});

// Survivor round 4 (2026-10-14): exact-output kills for the src/turn.ts survivors of the
// 2026-10-13/14 full mutation runs. Every assert pins an observable output (task field,
// log line, recorded fake call), never source text.
describe("turn survivor round 4", () => {
	const dieBeforeOutput = () => ({
		pid: 4242,
		done: Promise.resolve(
			runResult({
				exitCode: 1,
				sessionId: null,
				sawTerminalEnd: false,
				finalText: "",
			}),
		),
		kill: async () => {},
	});

	test("quarantine note over 20 files: exactly 20 names and the ellipsis", async () => {
		const files = Array.from({ length: 21 }, (_, i) => `f${i + 1}.tmp`);
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			quarantineUntracked: async () => files,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const names = files.slice(0, 20).join(", ");
		expect(logText(store, task.id)).toContain(
			`quarantined 21 untracked file(s) to .tasks/quarantine/${task.id}: ${names} …\n`,
		);
	});

	test("quarantine note at 2 files: the line ends after the last name", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			quarantineUntracked: async () => [".smoke-1.png", ".smoke-2.png"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(logText(store, task.id)).toContain(
			`quarantined 2 untracked file(s) to .tasks/quarantine/${task.id}: ` +
				".smoke-1.png, .smoke-2.png\n",
		);
	});

	test("a husk merge turn proves integration from the main repo with the task branch", async () => {
		const bmgCalls: unknown[][] = [];
		// The worktree dies during the run: the first husk read is OTTR-341's dispatch
		// guard (alive), the settle's later reads see the husk and read the main repo.
		let huskReads = 0;
		const { store, loop } = setup({
			maxTotalRuns: () => 0, // hold the chained merge turn; each settle runs via a direct runTurn
			worktreeHusk: async () => huskReads++ > 0,
			branchMergedOrGone: async (...args: unknown[]) => {
				bmgCalls.push(args);
				return true;
			},
			isClean: async () => {
				throw new Error("a husk turn must not read the worktree tree");
			},
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
		});
		await loop.runTurn(store.name, task.id);
		// fromMain passes the branch itself — never a placeholder or a dropped argument.
		expect(bmgCalls).toEqual([[store.path, "ott/x", "origin/main"]]);

		const branchless = store.createTask("merge without branch");
		store.updateTask(branchless.id, {
			stage: "merging",
			base: "sha0",
			worktree: "wt-y",
		});
		await loop.runTurn(store.name, branchless.id);
		expect(bmgCalls[1]).toEqual([store.path, "", "origin/main"]);
	});

	test("a no-stderr death without images never quarantines images or retries text-only", async () => {
		const { store, loop } = setup({
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("sess-1");
				return dieBeforeOutput();
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.needsReason ?? "").not.toContain("retrying text-only");
		expect(logText(store, task.id)).not.toContain("provider rejected");
	});

	test("the provider note is logged exactly once per rejected turn", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // the text-only retry runs via a direct runTurn below
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				if (record.runs.length === 1) return dieBeforeOutput();
				o.onSession?.("sess-2");
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: { status: "answered", summary: "did it" },
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		setImage(store, task.id, "1.png", "rejected-bytes");
		store.updateTask(task.id, { images: ["1.png"] });

		await loop.runTurn(store.name, task.id);

		// The classification note (appendLog) and the quarantine note must not double-log.
		const hits = logText(store, task.id).match(/provider rejected/g) ?? [];
		expect(hits).toHaveLength(1);
	});

	test("an image quarantine failure parks the card at needs_you with the exact stage", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				return dieBeforeOutput();
			},
		});
		const task = store.createTask("work please");
		setImage(store, task.id, "1.png", "rejected-bytes");
		// A file where the quarantine dir must be: every rename/mkdir inside fails.
		mkdirSync(join(store.tasksDir, "quarantine"), { recursive: true });
		writeFileSync(join(store.tasksDir, "quarantine", task.id), "blocked");
		store.updateTask(task.id, { images: ["1.png"] });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.stage).toBe("in_progress");
		expect(after.needsReason).toMatch(/^Image quarantine failed: .+\.$/);
		expect(store.listTurns(task.id)[0]!.error ?? "").toContain(
			"Image quarantine failed",
		);
	});

	test("a plain review that lands done never publishes a release", async () => {
		// A review commits nothing: no commits ahead of the target. No finding cards exist,
		// so findingsHold returns null and the done settle must not touch release plumbing.
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
		});
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);

		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(record.publishRelease).toHaveLength(0);
		expect(record.runReleaseCommand).toHaveLength(0);
	});

	test("ui-shot re-prompt reason is exact", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			changedFiles: async () => ["src/ui/app.tsx"],
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.needsReason).toBe(
			"no screenshot attached - resuming automatically to capture one. Cancel to stop it instead.",
		);
	});

	test("a changedFiles crash under the ui-shot guard is swallowed", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			changedFiles: async () => {
				throw new Error("git diff boom");
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
	});

	test("a research crash turn keeps its crash reason, never a missing-report bounce", async () => {
		const { store, record, loop } = setup({
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return dieBeforeOutput();
			},
		});
		const task = store.createTask("research something");
		store.updateTask(task.id, { research: true });
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.needsReason ?? "").toContain("omp exited with code");
		expect(after.needsReason ?? "").not.toContain(RESEARCH_REPORT);
	});

	test("work done without an outcome keeps summary, details, topic and queuedAt exact", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: null,
							finalText: "shipped the thing\ntopic: widgets",
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			summary: "before",
			details: "old details",
			queuedAt: 12345,
		});
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.summary).toBe("before");
		expect(after.details).toBe("shipped the thing\ntopic: widgets");
		expect(after.topic).toBe("widgets");
		expect(after.queuedAt).toBe(12345);
		expect(after.asked).toBe(null);
	});

	test("an integrated merge without a version stamps nothing and never logs a null-version skip", async () => {
		const { store, loop } = setup({
			targetSha: async () => "sha-pushed",
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
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
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		// No version in the report: no stamp, and the skip log names the version, never "null".
		expect(after.releaseVersion).toBe(null);
		expect(after.pushSha).toBe("sha-pushed");
		expect(logText(store, task.id)).not.toContain("no release stamp for null");
	});

	test("tracker error writes the bang line to the turn log", async () => {
		const { store, record, loop } = setup({
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.reject(new Error("boom")),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(logText(store, task.id)).toContain("! boom\n");
	});
});

describe("turn fork-born merge hold", () => {
	function forkCase(overrides: Partial<TurnOps> = {}) {
		const s = setup({ commitsAhead: async () => 0, ...overrides });
		const parent = s.store.createTask("fork research: weekly digest");
		s.store.updateTask(parent.id, {
			topic: "fork research",
			research: true,
			stage: "done",
			state: "idle",
		});
		const task = s.store.createTask("adopt fork idea");
		s.store.updateTask(task.id, { followUpOf: parent.id });
		return { ...s, task };
	}

	test("a fork-born done card parks for merge approval, even with holdUpdateMerges off", async () => {
		const { store, record, loop, task } = forkCase();
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(FORK_HOLD_REASON);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("with forkMergeHold off a fork-born card settles done like any work card", async () => {
		const { store, record, loop, task } = forkCase();
		store.setSettings({ forkMergeHold: false });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("turning forkMergeHold off does not release a card parked on a fork hold", async () => {
		const { store, record, loop, task } = forkCase();
		// Parked as today: the settle left a head to approve and spent no fork approval.
		store.updateTask(task.id, {
			state: "queued",
			pendingPrompt: "keep going",
			pendingBy: "user",
			needsReason: null,
			holdHead: "sha-1",
			forkMergeHead: null,
		});
		store.setSettings({ forkMergeHold: false });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(FORK_HOLD_REASON);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("an approved fork-born card integrates only at the approved head", async () => {
		const { store, record, loop, task } = forkCase();
		store.updateTask(task.id, { forkMergeHead: "sha-1" });
		// The fake HEAD is unreadable (null): the approval does not match.
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.needsReason).toBe(FORK_HOLD_REASON);
		expect(record.removeWorktree).toHaveLength(0);
		const ok = forkCase({ targetSha: async () => "sha-1" });
		ok.store.updateTask(ok.task.id, { forkMergeHead: "sha-1" });
		await ok.loop.runTurn(ok.store.name, ok.task.id);
		expect(ok.store.getTask(ok.task.id)!.stage).toBe("done");
		expect(ok.record.removeWorktree).toHaveLength(1);
	});

	test("a card filed from a fork-born card inherits the hold", async () => {
		const { store, loop, task } = forkCase();
		const child = store.createTask("split-off fork work");
		store.updateTask(child.id, { followUpOf: task.id });
		await loop.runTurn(store.name, child.id);
		expect(store.getTask(child.id)!.needsReason).toBe(FORK_HOLD_REASON);
	});

	test("a retro filed below fork-born work settles done and files its proposal", async () => {
		const { store, record, loop, task } = forkCase();
		record.proposal = { prompt: "Add a benchmark", model: null, summary: null };
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");
		store.updateTask(retro.id, { followUpOf: task.id });
		await loop.runTurn(store.name, retro.id);
		expect(store.getTask(retro.id)!.stage).toBe("done");
		expect(
			store.listTasks().filter((t) => t.followUpOf === retro.id),
		).toHaveLength(1);
	});

	test("a follow-up of a non-fork parent settles done", async () => {
		const { store, loop, task } = forkCase();
		const retro = store.createTask("weekly retro");
		store.updateTask(task.id, { followUpOf: retro.id });
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});
});

describe("fork-born work check before the hold", () => {
	// A fork-born card whose ready report carries commits classifies merging/queued; the
	// fork hold would park it, and the second-model check must judge the head first
	// (OTTR-766: the park must not preempt the check).
	function forkCheckCase(
		head: { sha: string },
		checks: RunResult[],
		overrides: Partial<TurnOps> = {},
		works: RunResult[] = [],
	) {
		const record = baseRecord();
		const s = setupWith(record, {
			// Holds the chained send-back turn so each test asserts the settle instant.
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			startRun: checkedRun(record, checks, works),
			workCheck: () => true,
			diffText: async () => "const x = 1;\n",
			...overrides,
		});
		const parent = s.store.createTask("fork research: weekly digest");
		s.store.updateTask(parent.id, {
			topic: "fork research",
			research: true,
			stage: "done",
			state: "idle",
		});
		const task = s.store.createTask("adopt fork idea");
		s.store.updateTask(task.id, { followUpOf: parent.id });
		return { ...s, task };
	}

	test("a fork-born ready report starts a work check before the hold parks", async () => {
		const { store, record, loop, task } = forkCheckCase({ sha: "sha-1" }, [
			pass(["small nit"]),
		]);
		await loop.runTurn(store.name, task.id);

		// The work run and the check ran; the park never preempted the check.
		expect(record.runs).toHaveLength(2);
		expect(record.runs[1]!.prompt).toContain("You are the second model");
		const after = store.getTask(task.id)!;
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		expect(after.workCheckHead).toBe("sha-1");
	});

	test("a passed fork-born check parks the hold at the checked head", async () => {
		const { store, record, loop, task } = forkCheckCase({ sha: "sha-1" }, [
			pass(),
		]);
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(FORK_HOLD_REASON);
		// The park is the check's verdict, not a pre-check hold: the head was judged.
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		// The approval covers exactly the head the check judged.
		expect(after.holdHead).toBe("sha-1");
		// A check pass spends no fork approval.
		expect(after.forkMergeHead).toBeNull();
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a blocking fork-born check sends the work back instead of parking", async () => {
		const { store, record, loop, task } = forkCheckCase({ sha: "sha-1" }, [
			block("tests were weakened", "const x = 1;"),
		]);
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(2); // work run + check run; no park, no merge turn
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBeNull();
		expect(after.holdHead).toBeNull();
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.workCheckLog[0]!.outcome).toBe("blockers");
		expect(after.pendingPrompt).toContain("tests were weakened");
	});

	test("an approval routes the checked fork-born card through the merge queue", async () => {
		const { store, loop, task } = forkCheckCase(
			{ sha: "sha-1" },
			[pass()],
			{ maxTotalRuns: () => 10 },
			[
				runResult({ outcome: { status: "ready", summary: "did it" } }),
				runResult({
					outcome: {
						status: "integrated",
						summary: "pushed",
					} satisfies Outcome,
				}),
			],
		);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.needsReason).toBe(FORK_HOLD_REASON);
		// The head the approval will cover is the head the check passed.
		expect(store.getTask(task.id)!.workCheckLog[0]!.outcome).toBe("pass");

		// The drawer's approval reply spends the parked head and queues the merge turn
		// (the exact write holdApprovalReply makes on APPROVE_REPLY).
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			needsReason: null,
			holdHead: null,
			forkMergeHead: "sha-1",
		});
		await loop.runTurn(store.name, task.id);

		// The merge turn integrated; the work turn never merged by itself.
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
	});
});

describe("trusted kind, not prompt text", () => {
	test("a work card with a privileged marker prompt gets no privileged kind", () => {
		const { store } = setup();
		store.createTask(`${RETRO_MARKER}retro text`);
		store.createTask(`${ARCH_REVIEW_MARKER}review text`);
		store.createTask(`${RULES_INTERVIEW_MARKER}interview text`);
		const tasks = store.listTasks();
		const retro = tasks.find((t) => t.prompt === `${RETRO_MARKER}retro text`)!;
		const review = tasks.find(
			(t) => t.prompt === `${ARCH_REVIEW_MARKER}review text`,
		)!;
		const interview = tasks.find(
			(t) => t.prompt === `${RULES_INTERVIEW_MARKER}interview text`,
		)!;
		for (const t of [retro, review, interview]) expect(t.kind).toBe("work");
		expect(isRetro(retro)).toBe(false);
		expect(isReview(review)).toBe(false);
		expect(liveCard(tasks, "retro")).toBe(false);
		expect(liveCard(tasks, "interview")).toBe(false);
		// No interview exemption: a fresh todo needs the rules file like any work card.
		expect(
			pickRunnable(tasks, { maxParallel: null, hasRules: false }).find(
				(t) => t.id === interview.id,
			),
		).toBeUndefined();
		// A real interview card keeps its exemption.
		const real = store.createTask("real interview", null, "interview");
		expect(
			pickRunnable(store.listTasks(), {
				maxParallel: null,
				hasRules: false,
			}).find((t) => t.id === real.id),
		).toBeDefined();
	});
});

describe("review findings check", () => {
	const reviewCard = (store: ProjectStore) => {
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		return review;
	};
	const finding = (
		prompt: string,
		rank: number | null = null,
		security: "critical" | "high" | null = null,
	): RecordedFinding => ({ prompt, model: null, rank, security });

	test("recorded findings park the review, run one check, and file the kept ones", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1), finding("Bug B", 2)];
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			modelRoles: () => ({ adversary: "zai/glm-5.3-flash:medium" }),
			commitSubjects: async () => ["a1 fix it upstream"],
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				const result =
					record.runs.length === 1
						? runResult({
								outcome: { status: "answered", summary: "review done" },
								recorded: record.recorded,
							})
						: runResult({
								finalText:
									'[{"id":1,"keep":true,"reason":""},{"id":2,"keep":false,"reason":"handled at src/x.ts:42"}]',
							});
				return {
					pid: 4242,
					done: Promise.resolve(result),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		const after = store.getTask(review.id)!;
		// Parked while the (kept) finding is open, exactly like create_task findings.
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);
		// The check is a fresh session: never --resume, never the review's extension.
		expect(record.runs).toHaveLength(2);
		const check = record.runs[1]!;
		expect(check.resumeId).toBeNull();
		expect(check.extensionPath).toBeNull();
		expect(check.tools).toBe("read,grep,glob");
		expect(check.config).toBe(join(dirname("ext.ts"), "check.yml"));
		expect(check.model).toBe("zai/glm-5.3-flash:medium");
		expect(check.cwd).toBe(after.worktree!);
		expect(check.prompt).toContain("shaR");
		expect(check.prompt).toContain("Bug A");
		expect(check.prompt).toContain("a1 fix it upstream");
		// Only the kept finding becomes a card, linked to the review like create_task linked it.
		const kids = store.listTasks().filter((t) => t.followUpOf === review.id);
		expect(kids.map((k) => k.prompt)).toEqual(["Bug A"]);
		// The scheduler may already have claimed the card; the queue stage is the contract.
		expect(kids[0]!.stage).toBe("todo");
		// Counts and the drop reason live on the review card.
		expect(after.summary).toContain("2 recorded, 1 filed, 1 not filed");
		expect(after.details).toContain("handled at src/x.ts:42");
		expect(after.details).toContain("filed as card #");
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("a Claude review checked by Claude warns on the review card", async () => {
		// Claude via github-copilot routes to the critic role (the vendor decides, not the
		// provider prefix); a critic that also points at Claude warns on the card.
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			modelRoles: () => ({ critic: "anthropic/claude-opus-5-5:medium" }),
			commitSubjects: async () => ["a1 fix it upstream"],
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				const result =
					record.runs.length === 1
						? runResult({
								model: "github-copilot/claude-sonnet-4-5",
								outcome: { status: "answered", summary: "review done" },
								recorded: record.recorded,
							})
						: runResult({
								finalText: '[{"id":1,"keep":true,"reason":""}]',
							});
				return {
					pid: 4242,
					done: Promise.resolve(result),
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);

		expect(record.runs[1]!.model).toBe("anthropic/claude-opus-5-5:medium");
		const after = store.getTask(review.id)!;
		expect(after.summary).toContain(
			"check 0s on anthropic/claude-opus-5-5:medium — same vendor as the review",
		);
	});

	test("a release's recorded blockers file as findings and park it at merging, unapproved", async () => {
		const record = baseRecord();
		record.recorded = [finding("Blocker: the notes drop the late commits", 1)];
		const { store, projects, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			modelRoles: () => ({ adversary: "zai/glm-5.3-flash:medium" }),
			commitSubjects: async () => ["a1 fix it upstream"],
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				const result =
					record.runs.length === 1
						? runResult({
								outcome: {
									status: "answered",
									summary: "blockers recorded as findings",
								},
								recorded: record.recorded,
							})
						: runResult({
								finalText: '[{"id":1,"keep":true,"reason":""}]',
							});
				return {
					pid: 4242,
					done: Promise.resolve(result),
					kill: async () => {
						record.killed = true;
					},
				};
			},
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const release = store.createTask("release v2.0.0");
		store.updateTask(release.id, {
			base: "shaR",
			releaseVersion: "v2.0.0",
			releaseNotes: "notes body",
		});
		await loop.runTurn(store.name, release.id);
		const after = store.getTask(release.id)!;
		// The answered report parks the release at merging while the finding is open, not needs_you.
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);
		// The check filed the blocker as a finding card that holds the release.
		const kids = store.listTasks().filter((t) => t.followUpOf === release.id);
		expect(kids.map((k) => k.prompt)).toEqual([
			"Blocker: the notes drop the late commits",
		]);
		// Nothing publishes before the user approves.
		expect(record.publishRelease).toHaveLength(0);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("with the switch off the top 10 plus security findings file without a check run", async () => {
		const record = baseRecord();
		record.recorded = [
			...Array.from({ length: 12 }, (_, i) => finding(`Bug ${i + 1}`, i + 1)),
			finding("Sec leak", 13, "high"),
		];
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			reviewCheck: () => false,
		});
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(1); // the review only: no check session
		const kids = store
			.listTasks()
			.filter((t) => t.followUpOf === review.id)
			.map((t) => t.prompt);
		expect(kids).toHaveLength(11); // cap 10 + the confirmed high security finding
		expect(kids).toContain("Sec leak");
		expect(kids).not.toContain("Bug 11");
		const after = store.getTask(review.id)!;
		expect(after.details).toContain("below the cap of 10: Bug 11");
		expect(after.summary).toContain("13 recorded, 11 filed, 2 not filed");
	});

	test("a failed check run retries once and then files", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				const result =
					record.runs.length === 1
						? runResult({
								outcome: { status: "answered", summary: "review done" },
								recorded: record.recorded,
							})
						: record.runs.length === 2
							? runResult({
									exitCode: 1,
									stderrTail: "error: the provider dropped the connection\n",
								})
							: runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' });
				return {
					pid: 4242,
					done: Promise.resolve(result),
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(3); // review + failed check + retry
		const kids = store.listTasks().filter((t) => t.followUpOf === review.id);
		expect(kids.map((k) => k.prompt)).toEqual(["Bug A"]);
		expect(store.getTask(review.id)!.state).toBe("idle");
	});

	test("a check that fails twice leaves the review needs_you with the error and files nothing", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							exitCode: record.runs.length === 1 ? 0 : 1,
							finalText: record.runs.length === 1 ? "ok" : "",
							outcome:
								record.runs.length === 1
									? { status: "answered", summary: "review done" }
									: null,
							recorded: record.runs.length === 1 ? record.recorded : [],
						}),
					),
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(3); // review + two check attempts
		const after = store.getTask(review.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("failed twice");
		expect(store.listTasks().filter((t) => t.followUpOf === review.id)).toEqual(
			[],
		);
	});

	/** A review whose check hits the openai-codex usage limit; `duringQuota` runs while the
	 * board awaits the quota for the check's hold (the second fetch — the start gate's own
	 * fetch comes first), where a cancel or a steer can land. */
	async function limitedReview(
		duringQuota: (store: ProjectStore, id: string) => void = () => {},
	) {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const resetsAt = Date.now() + 3_600_000;
		const ref: { id: string; store?: ProjectStore } = { id: "" };
		let quotaCalls = 0;
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			quota: async () => {
				quotaCalls++;
				if (quotaCalls === 2) duringQuota(ref.store!, ref.id);
				return {
					limits: [
						{
							provider: "openai-codex",
							label: "5 hours",
							window: "5h",
							plan: null,
							usedPct: 100,
							resetsAt,
						},
					],
					error: null,
					at: Date.now(),
				};
			},
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				const result =
					record.runs.length === 1
						? runResult({
								outcome: { status: "answered", summary: "review done" },
								recorded: record.recorded,
							})
						: runResult({
								exitCode: 1,
								model: "openai-codex/gpt-5.5",
								providerError:
									"Codex error event: The usage limit has been reached (code=usage_limit_reached)",
							});
				return {
					pid: 4242,
					done: Promise.resolve(result),
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		ref.store = store;
		ref.id = review.id;
		await loop.runTurn(store.name, review.id);
		return { record, store, review, resetsAt };
	}

	test("a check at the usage limit holds the review until the reset and files nothing", async () => {
		const { record, store, review, resetsAt } = await limitedReview();
		expect(record.runs).toHaveLength(2); // review + one check attempt: no retry at the limit
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("queued");
		expect(after.holdUntil).toBe(resetsAt);
		expect(after.needsReason).toContain("openai-codex usage limit");
		expect(after.pendingPrompt).toContain("usage limit");
		expect(store.listTasks().filter((t) => t.followUpOf === review.id)).toEqual(
			[],
		);
	});

	test("a cancel that keeps the worktree during the quota await is not resumed by the hold", async () => {
		const kept = "Cancel kept the worktree: uncommitted changes";
		const { store, review } = await limitedReview((s, id) =>
			s.updateTask(id, { state: "needs_you", needsReason: kept }),
		);
		const after = store.getTask(review.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(kept);
		expect(after.holdUntil).toBeNull();
	});

	test("a message steered during the quota await survives the hold", async () => {
		const { store, review } = await limitedReview((s, id) =>
			s.updateTask(id, { pendingPrompt: "also check the docs" }),
		);
		const after = store.getTask(review.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toStartWith("also check the docs\n\n");
		expect(after.pendingPrompt).toContain("usage limit");
	});

	// The dispatched model's provider is out of quota: starts hold until the reset, deaths
	// continue once, and the death's continue waits for the provider's reported reset. A
	// queued continue without a reset is picked up at once by the loop's own schedule(), so
	// these tests flush until the chain reaches a terminal state (a park or a success).
	describe("usage-limit start gate and auto-continue", () => {
		const fakeQuota =
			(provider: string, usedPct: number, resetsAt: number | null) =>
			async () => ({
				limits: [
					{
						provider,
						label: "5 hours",
						window: "5h",
						plan: null,
						usedPct,
						resetsAt,
					},
				],
				error: null,
				at: Date.now(),
			});
		const dyingRun =
			(record: Recorded, model = "fake/glm") =>
			(o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							exitCode: 1,
							model,
							providerError: "429 quota exhausted",
						}),
					),
					kill: async () => {},
				};
			};
		const runnableIds = (store: ProjectStore, now?: number) =>
			pickRunnable(store.listTasks(), {
				maxParallel: null,
				hasRules: true,
				now,
			}).map((t) => t.id);
		/** Drains the loop's own background turns until the card leaves the given states. */
		const untilSettled = async (
			store: ProjectStore,
			id: string,
			inFlight: (state: string, stage: string) => boolean,
		) => {
			for (let i = 0; i < 100; i++) {
				const t = store.getTask(id)!;
				if (!inFlight(t.state, t.stage)) return;
				await flushPromises();
			}
		};

		test("a start at the provider's limit holds the card until the reset and starts nothing", async () => {
			const resetsAt = Date.now() + 3_600_000;
			const record = baseRecord();
			const { store, loop } = setupWith(record, {
				quota: fakeQuota("fake", 100, resetsAt),
				startRun: dyingRun(record),
			});
			const task = store.createTask("work please");
			await loop.runTurn(store.name, task.id);

			expect(record.runs).toHaveLength(0);
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("queued");
			expect(after.holdUntil).toBe(resetsAt);
			expect(after.needsReason).toContain("The fake usage limit is reached");
			expect(after.needsReason).toContain("starts the task again");
			expect(runnableIds(store)).not.toContain(task.id);
			expect(runnableIds(store, resetsAt + 1)).toContain(task.id);
		});

		test("a queued user message overrides the start gate and runs now", async () => {
			const resetsAt = Date.now() + 3_600_000;
			const record = baseRecord();
			const { store, loop } = setupWith(record, {
				quota: fakeQuota("fake", 100, resetsAt),
				startRun: dyingRun(record),
			});
			const task = store.createTask("work please");
			await loop.runTurn(store.name, task.id);
			expect(store.getTask(task.id)!.holdUntil).toBe(resetsAt);

			// The steer route's write: a message on a held card clears the hold and runs it now,
			// even though the quota state still reports the provider as exhausted.
			store.updateTask(task.id, {
				pendingPrompt: "run it now",
				pendingBy: "user",
				holdUntil: null,
			});
			await loop.runTurn(store.name, task.id);

			expect(record.runs).toHaveLength(1);
			expect(record.runs[0]!.prompt).toContain("run it now");
			// The user text is consumed; the run dies at the limit anyway and the death's
			// continue takes over, holding until the same reset.
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("queued");
			expect(after.holdUntil).toBe(resetsAt);
			expect(after.pendingPrompt).toBe(".");
			expect(after.needsReason).toStartWith(
				"The run stopped at the provider's usage limit",
			);
		});

		test("a user message combined under the resume marker overrides the gate too", async () => {
			const resetsAt = Date.now() + 3_600_000;
			const record = baseRecord();
			const { store, loop } = setupWith(record, {
				quota: fakeQuota("fake", 100, resetsAt),
				startRun: dyingRun(record),
			});
			const task = store.createTask("work please");
			// The death-continue's park: the tracker's "." resume, held until the reset.
			store.updateTask(task.id, {
				state: "queued",
				pendingPrompt: ".",
				pendingBy: "supervisor",
				holdUntil: resetsAt,
			});
			// The steer route's write on that held card: the message combines under the
			// marker, the hold clears, and authorship records the user (the run-now signal).
			store.updateTask(task.id, {
				pendingPrompt: ".\n\nrun it now",
				pendingBy: "user",
				holdUntil: null,
			});
			await loop.runTurn(store.name, task.id);

			expect(record.runs).toHaveLength(1);
			expect(record.runs[0]!.prompt).toContain("run it now");
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("queued");
			expect(after.holdUntil).toBe(resetsAt);
			expect(after.pendingPrompt).toBe(".");
		});

		test("supervisor-parked pending text does not override the start gate", async () => {
			const resetsAt = Date.now() + 3_600_000;
			const record = baseRecord();
			const { store, loop } = setupWith(record, {
				quota: fakeQuota("fake", 100, resetsAt),
				startRun: dyingRun(record),
			});
			const task = store.createTask("work please");
			store.updateTask(task.id, {
				pendingPrompt: "Report the same outcome again after the reset.",
				pendingBy: "supervisor",
			});
			await loop.runTurn(store.name, task.id);

			// The park's own instruction waits like the card it parked: no run until the reset.
			expect(record.runs).toHaveLength(0);
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("queued");
			expect(after.holdUntil).toBe(resetsAt);
			expect(after.pendingPrompt).toBe(
				"Report the same outcome again after the reset.",
			);
		});

		test("a run the provider stops mid-turn continues automatically until its reset", async () => {
			const resetsAt = Date.now() + 3_600_000;
			const record = baseRecord();
			// No default role: the start gate cannot bind a provider, so the run goes out;
			// the served model's provider is the one the death's continue waits for.
			const { store, loop } = setupWith(record, {
				modelRoles: () => ({}),
				quota: fakeQuota("fake", 100, resetsAt),
				startRun: dyingRun(record),
			});
			const task = store.createTask("work please");
			await loop.runTurn(store.name, task.id);

			expect(record.runs).toHaveLength(1);
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("queued");
			expect(after.holdUntil).toBe(resetsAt);
			expect(after.pendingPrompt).toBe(".");
			expect(after.needsReason).toStartWith(
				"The run stopped at the provider's usage limit",
			);
			expect(after.needsReason).toContain("fake limit resets at");
			// The turn row carries the reason, so the next classify sees the streak.
			expect(store.listTurns(task.id).at(-1)!.error).toStartWith(
				"The run stopped at the provider's usage limit",
			);
			// Held past the reset: the scheduler starts the continue then, not now.
			expect(runnableIds(store)).not.toContain(task.id);
			expect(runnableIds(store, resetsAt + 1)).toContain(task.id);
		});

		test("a quota death without a known reset continues at once, and the next death parks", async () => {
			const record = baseRecord();
			const { store, loop } = setupWith(record, {
				quota: fakeQuota("fake", 60, Date.now() + 3_600_000),
				startRun: dyingRun(record),
			});
			const task = store.createTask("work please");
			await loop.runTurn(store.name, task.id);
			// The first settle queued a continue with no hold: the loop's schedule() starts it
			// right away, it dies the same way, and the streak rule parks for a human.
			await untilSettled(
				store,
				task.id,
				(state, stage) =>
					state === "preparing" ||
					state === "running" ||
					(state === "queued" && stage === "in_progress"),
			);

			expect(record.runs).toHaveLength(2);
			const after = store.getTask(task.id)!;
			expect(after.state).toBe("needs_you");
			expect(after.needsReason).toContain(
				"The run stopped at the provider's usage limit again after the automatic continue",
			);
			expect(after.needsReason).toContain("429 quota exhausted");
			expect(after.pendingPrompt).toBeNull();
			const rows = store.listTurns(task.id);
			expect(rows).toHaveLength(2);
			expect(rows[0]!.error).toBe(
				"The run stopped at the provider's usage limit - continuing automatically. Cancel to stop it instead.",
			);
		});

		test("the automatic continue runs the task and its success settles normally", async () => {
			const record = baseRecord();
			const { store, loop } = setupWith(record, {
				commitsAhead: async () => 0,
				quota: fakeQuota("fake", 60, Date.now() + 3_600_000),
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess");
					// The continue succeeds with an answered outcome and no commits: the card
					// settles done/idle, which the merge queue does not pick up, so the
					// background chain ends here.
					const result =
						record.runs.length === 1
							? runResult({
									exitCode: 1,
									model: "fake/glm",
									providerError: "429 quota exhausted",
								})
							: runResult({
									outcome: { status: "answered", summary: "continued fine" },
								});
					return {
						pid: 4242,
						done: Promise.resolve(result),
						kill: async () => {},
					};
				},
			});
			const task = store.createTask("work please");
			await loop.runTurn(store.name, task.id);
			await untilSettled(
				store,
				task.id,
				(state, stage) =>
					state === "preparing" ||
					state === "running" ||
					(state === "queued" && stage === "in_progress"),
			);

			expect(record.runs).toHaveLength(2);
			const after = store.getTask(task.id)!;
			// The continue's successful run settled the card like any answered work turn.
			expect(after.stage).toBe("done");
			expect(after.state).toBe("idle");
			expect(after.needsReason).toBeNull();
			expect(after.pendingPrompt).toBeNull();
			expect(store.listTurns(task.id)).toHaveLength(2);
		});
	});

	test("the check holds a global cap slot while it runs", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: checkDone,
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		const turn = loop.runTurn(store.name, review.id);
		await flushPromises();
		expect(record.runs).toHaveLength(2);
		expect([...loop.running.keys()]).toContain(
			`${store.name}/${review.id}:check`,
		);
		releaseCheck(
			runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
		);
		await turn;
		expect([...loop.running.keys()]).not.toContain(
			`${store.name}/${review.id}:check`,
		);
		const kids = store.listTasks().filter((t) => t.followUpOf === review.id);
		expect(kids).toHaveLength(1);
	});

	test("the lost sweep settles a review check whose agent pid died and frees the slot", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, loop } = setupWith(record, {
			// Cap 1: after the sweep, a queued card must start again (both cap units gone).
			maxTotalRuns: () => 1,
			commitsAhead: async () => 0,
			pidAlive: () => false, // the check's omp died; a grandchild keeps `done` hanging
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: record.runs.length === 2
								? checkDone
								: Promise.resolve(
										runResult({
											outcome: {
												status: "ready",
												summary: "did it",
											} satisfies Outcome,
										}),
									),
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		const run = loop.runTurn(store.name, review.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(
			`${store.name}/${review.id}:check`,
		);
		expect(store.getTask(review.id)!.state).toBe("running");

		loop.schedule(); // the tick: the check pid is dead
		await flushPromises();

		const after = store.getTask(review.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("lost check agent process (pid 4242)");
		expect([...loop.running.keys()]).not.toContain(
			`${store.name}/${review.id}:check`,
		);
		// The late `done` must not touch the card the sweep parked, and files nothing.
		releaseCheck(
			runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
		);
		await run;
		expect(store.getTask(review.id)!.state).toBe("needs_you");
		expect(store.listTasks().filter((t) => t.followUpOf === review.id)).toEqual(
			[],
		);

		// Both cap units are free: a queued card starts under the cap of 1.
		store.createTask("other card");
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(3); // review + check + the other card's run
	});

	test("the lost sweep never touches a live review check", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0, // keep any follow-up turn from claiming mid-assertion
			commitsAhead: async () => 0,
			pidAlive: () => true, // the check's own pid is alive
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: checkDone,
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		const run = loop.runTurn(store.name, review.id);
		await flushPromises();
		expect(store.getTask(review.id)!.state).toBe("running");

		loop.schedule(); // the tick: the check is alive, so nothing settles
		await flushPromises();

		expect(store.getTask(review.id)!.state).toBe("running");
		expect([...loop.running.keys()]).toContain(
			`${store.name}/${review.id}:check`,
		);

		releaseCheck(
			runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
		);
		await run;
		expect(
			store.listTasks().filter((t) => t.followUpOf === review.id),
		).toHaveLength(1);
	});

	test("checkRunError names stopped runs, non-zero exits and empty verdicts", () => {
		expect(checkRunError(runResult({ finalText: "verdicts" }))).toBeNull();
		expect(checkRunError(runResult({ killed: true }))).toMatch(/stopped/);
		expect(
			checkRunError(runResult({ exitCode: 1, stderrTail: "boom\n" })),
		).toBe("the check run exited with code 1: boom");
		const limited = runResult({
			exitCode: 1,
			providerError:
				"Codex error event: The usage limit has been reached (code=usage_limit_reached)",
		});
		expect(checkRunError(limited)).toMatch(/provider usage limit is reached/);
		expect(hitUsageLimit(limited)).toBe(true);
		expect(
			hitUsageLimit(runResult({ exitCode: 1, stderrTail: "boom\n" })),
		).toBe(false);
		expect(checkRunError(runResult({ finalText: "  " }))).toMatch(
			/without a final message/,
		);
	});

	test("checkRunError reads the death line, not omp's recovery hints", () => {
		const stderrTail = [
			"error: No API key found for anthropic.",
			"Use /login, set an API key environment variable, or create /etc/ottr/omp-agent/agent.db",
			"      at #di (/usr/local/bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js:28745:105)",
			"      at async #co (/usr/local/bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js:28739:41727)",
			"[Recovery]",
			"  Main: omp --resume 01a16f59-c1c5-702b-a4e8-9cb3c01ef1b3",
		].join("\n");
		expect(checkRunError(runResult({ exitCode: 1, stderrTail }))).toBe(
			"the check run exited with code 1: anthropic has no usable sign-in. Sign in again under Settings, then reply to re-run the check",
		);
		expect(
			checkRunError(
				runResult({
					exitCode: 1,
					stderrTail: "[Recovery]\n  Main: omp --resume abc",
				}),
			),
		).toBe("the check run exited with code 1: Main: omp --resume abc");
	});

	test("checkRunError shows the provider's error when stderr names no cause (OTTR-670)", () => {
		expect(
			checkRunError(
				runResult({
					exitCode: 1,
					stderrTail: "",
					providerError: "500 upstream\nconnect error",
				}),
			),
		).toBe("the check run exited with code 1: 500 upstream connect error");
		const long = checkRunError(
			runResult({
				exitCode: 1,
				providerError: `overloaded ${"x".repeat(900)}`,
			}),
		);
		expect(long).toStartWith("the check run exited with code 1: overloaded x");
		expect(long?.length).toBeLessThan(400);
		expect(
			checkRunError(
				runResult({
					exitCode: 1,
					stderrTail: "error: boom\n",
					providerError: "500 upstream",
				}),
			),
		).toBe("the check run exited with code 1: boom");
		const zai = runResult({
			exitCode: 1,
			providerError:
				'429 {"type":"error","error":{"type":"rate_limit_error","code":"1310","message":"[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-10 19:51:43]"}}',
		});
		expect(checkRunError(zai)).toMatch(/provider usage limit is reached/);
	});
});

// startRun fake: work-agent runs report ready, check runs (spotted by the check prompt's
// first words) are served from `checks` in order — one turn appends exactly one work run
// plus its check runs, so absolute run indexes would hand a check verdict to a work run.
const checkedRun = (
	record: Recorded,
	checks: RunResult[],
	works: RunResult[] = [],
) => {
	let checkIndex = 0;
	let workIndex = 0;
	return (o: Parameters<TurnOps["startRun"]>[0]) => {
		record.runs.push(o);
		o.onSession?.(`sess-${record.runs.length}`);
		const isCheck = o.prompt.startsWith("You are the second model");
		return {
			pid: 4242,
			done: Promise.resolve(
				isCheck
					? (checks[checkIndex++] ?? runResult({}))
					: (works[workIndex++] ??
							runResult({
								outcome: {
									status: "ready",
									summary: "did it",
								} satisfies Outcome,
							})),
			),
			kill: async () => {},
		};
	};
};

const pass = (notes: string[] = []) =>
	runResult({
		finalText: JSON.stringify({ blockers: [], fixed: [], notes }),
	});
const block = (finding: string, quote: string, bugClass?: string) =>
	runResult({
		finalText: JSON.stringify({
			blockers:
				bugClass === undefined
					? [{ finding, quote }]
					: [{ finding, quote, bugClass }],
			fixed: [],
			notes: [],
		}),
	});

describe("work card check", () => {
	// A ready work turn classifies merging/queued (commitsAhead 1, clean), which is the
	// check block's gate. maxTotalRuns 0 holds the chained merge turn so each test asserts
	// the settle instant; head.sha is mutable so later turns can push "new commits".
	function workCheckCase(
		head: { sha: string },
		checks: RunResult[],
		overrides: Partial<TurnOps> = {},
		works: RunResult[] = [],
	) {
		const record = baseRecord();
		return setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			startRun: checkedRun(record, checks, works),
			workCheck: () => true,
			...overrides,
		});
	}

	test("a ready card with commits ahead runs the check once, and a pass keeps it merging/queued", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(head, [pass(["small nit"])], {
			modelRoles: () => ({ adversary: "zai/glm-5.3-flash:medium" }),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(2); // the work run + one check run
		const check = record.runs[1]!;
		// The check is a fresh session: never --resume, never the work run's extension.
		expect(check.resumeId).toBeNull();
		expect(check.extensionPath).toBeNull();
		expect(check.tools).toBe("read,grep,glob");
		expect(check.config).toBe(join(dirname("ext.ts"), "check.yml"));
		expect(check.model).toBe("zai/glm-5.3-flash:medium");
		expect(check.cwd).toBe(store.getTask(task.id)!.worktree!);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckHead).toBe("sha1");
		expect(after.workCheckSendbacks).toBe(0);
		// The first completed check stamps the ready report it judged.
		expect(after.workCheckReport).toBe("did it");
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		expect(after.workCheckLog[0]!.notes).toEqual(["small nit"]);
	});

	test("a missing check role records the default role's model, not null", async () => {
		const head = { sha: "sha1" };
		// No adversary role in the harness default ({ default: "fake/default-model" }):
		// the card must name the model the check actually fell back to.
		const { store, loop } = workCheckCase(head, [pass(["small nit"])]);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		// The launch still passes the raw selector (omp resolves its default); the card
		// record names the model that fallback resolves to.
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.workCheckLog[0]!.model).toBe("fake/default-model");
		expect(after.workCheckLog[0]!.warn).toBeUndefined();
	});

	test("a blocker whose quote is in the diff sends the card back to the work agent", async () => {
		const { store, loop } = workCheckCase(
			{ sha: "sha1" },
			[block("tests were weakened", "const x = 1;")],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("queued");
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.workCheckHead).toBe("sha1");
		expect(after.needsReason).toBeNull();
		expect(after.pendingPrompt).toContain("tests were weakened");
		expect(after.pendingPrompt).toContain("const x = 1;");
		expect(after.workCheckLog[0]!.outcome).toBe("blockers");
	});

	test("a nit or pre-existing severity never blocks, even with a good quote", async () => {
		const { store, loop } = workCheckCase(
			{ sha: "sha1" },
			[
				runResult({
					finalText: JSON.stringify({
						blockers: [
							{
								finding: "naming",
								quote: "const x = 1;",
								severity: "nit",
							},
							{
								finding: "old bug",
								quote: "const x = 1;",
								severity: "pre-existing",
							},
						],
						fixed: [],
						notes: [],
					}),
				}),
			],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckSendbacks).toBe(0);
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		expect(after.workCheckLog[0]!.blockers).toEqual([]);
		expect(after.workCheckLog[0]!.notes).toEqual([
			"naming (nit — recorded, not blocking)",
			"old bug (pre-existing — recorded, not blocking)",
		]);
	});

	test("an important blocker keeps its class and sends back tagged with it", async () => {
		const { store, loop } = workCheckCase(
			{ sha: "sha1" },
			[
				runResult({
					finalText: JSON.stringify({
						blockers: [
							{
								finding: "off by one",
								quote: "const x = 1;",
								severity: "important",
								bugClass: "off-by-one",
							},
						],
						fixed: [],
						notes: [],
					}),
				}),
			],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.pendingPrompt).toContain("[off-by-one] off by one");
		// The stored roundtrip keeps the class the send-back showed.
		expect(after.workCheckLog[0]!.blockers[0]).toEqual({
			finding: "off by one",
			quote: "const x = 1;",
			severity: "important",
			bugClass: "off-by-one",
		});
	});

	test("a re-check at a new head prompts with only the commits since the previous check", async () => {
		const head = { sha: "sha1" };
		const diffs: string[] = [];
		const { store, record, loop } = workCheckCase(
			head,
			[block("tests were weakened", "const x = 1;"), pass()],
			{
				diffText: async (_wt: unknown, from: string) => {
					diffs.push(from);
					return from === "sha1"
						? "const y = 2;\n"
						: "const x = 1;\nconst y = 2;\n";
				},
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);
		expect(record.runs[1]!.prompt).toContain("Diff of the branch");

		head.sha = "sha2"; // the agent pushed fixes
		await loop.runTurn(store.name, task.id);

		// Three diff reads: the first check's full diff, then the re-check's full diff for
		// quote validation plus the new-commits-only diff for the prompt.
		expect(diffs).toHaveLength(3);
		expect(diffs[2]).toBe("sha1");
		const recheckPrompt = record.runs[3]!.prompt;
		expect(recheckPrompt).toContain(
			"Diff of only the new commits since the previous check",
		);
		expect(recheckPrompt).toContain("const y = 2;\n");
		expect(recheckPrompt).not.toContain("const x = 1;\nconst y = 2;\n");
		// The re-check judges the update against the original result.
		expect(recheckPrompt).toContain("Original ready report");
		expect(recheckPrompt).toContain("New ready report");
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.workCheckHead).toBe("sha2");
	});

	test("a later pass at a new head that names the blocker fixed resolves it and keeps the sendback count", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(
			head,
			[
				block("tests were weakened", "const x = 1;"),
				runResult({
					finalText: JSON.stringify({
						blockers: [],
						fixed: [{ id: 1, reason: "test restored in the fix commit" }],
						notes: [],
					}),
				}),
			],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);

		head.sha = "sha2"; // the agent pushed fixes
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(record.runs).toHaveLength(4); // two work runs, two checks
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.workCheckHead).toBe("sha2");
		const first = after.workCheckLog[0]!;
		expect(first.outcome).toBe("blockers");
		expect(first.blockers[0]!.status).toBe("fixed");
		expect(first.blockers[0]!.statusReason).toBe(
			"test restored in the fix commit",
		);
		expect(after.workCheckLog[1]!.outcome).toBe("pass");
	});

	test("a fifth blocking check parks the card on needs_you with the findings", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(
			head,
			[
				block("tests were weakened", "const x = 1;"),
				block("scope creep", "also touched README"),
				block("tests were weakened", "const x = 1;"),
				block("scope creep", "also touched README"),
				runResult({
					finalText: JSON.stringify({
						blockers: [
							{ finding: "scope creep", quote: "also touched README" },
							{
								finding: `${"long finding ".repeat(40).trim()} end`,
								quote: "also touched README",
							},
						],
						fixed: [],
						notes: [],
					}),
				}),
			],
			{
				diffText: async () => "const x = 1;\nalso touched README\n",
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);

		head.sha = "sha2";
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(2);

		head.sha = "sha3";
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(3);

		head.sha = "sha4";
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(
			WORK_CHECK_MAX_SENDBACKS,
		);

		head.sha = "sha5";
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(record.runs).toHaveLength(10); // five work runs, five checks
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(
			`blocked the merge ${WORK_CHECK_MAX_SENDBACKS + 1} times`,
		);
		expect(after.needsReason).toContain("scope creep");
		const longFinding = `${"long finding ".repeat(40).trim()} end`;
		expect(after.needsReason).toContain(longFinding);
		expect(after.workCheckHead).toBe("sha5");
		// The user gets clickable choices, not only a reason text.
		expect(after.asked![0]!.question).toContain("scope creep");
		expect(after.asked![0]!.options.map((o) => o.label)).toEqual([
			"Send it back",
			"Merge anyway",
		]);
	});

	test("with the switch off no check run starts and the card stays merging/queued", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(head, [], {
			workCheck: () => false,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(1); // the work run only
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckHead).toBeNull();
		expect(after.workCheckLog).toEqual([]);
	});

	test("a re-ready at an unchanged head after a send-back reruns the check, and the fifth block parks", async () => {
		const head = { sha: "sha1" };
		const diffs: string[] = [];
		const { store, record, loop } = workCheckCase(
			head,
			[
				block("tests were weakened", "const x = 1;"),
				block("tests were weakened", "const x = 1;"),
				block("tests were weakened", "const x = 1;"),
				block("tests were weakened", "const x = 1;"),
				block("tests were weakened", "const x = 1;"),
			],
			{
				diffText: async (_wt: unknown, from: string) => {
					diffs.push(from);
					return "const x = 1;\n";
				},
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);

		// Ready again with no new commits and no new report text: still a fresh check run —
		// the update may be new evidence or a corrected claim — never a word-for-word resend.
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(4); // two work runs, two checks
		const recheck = record.runs[3]!;
		expect(recheck.prompt).toContain("This is a re-check");
		expect(recheck.prompt).toContain("Original ready report");
		expect(recheck.prompt).toContain("did it");
		expect(recheck.prompt).toContain("tests were weakened");
		// At the unchanged head the re-check diff starts at the checked head, not the base.
		expect(diffs[diffs.length - 1]).toBe("sha1");
		expect(recheck.prompt).toContain(
			"Diff of only the new commits since the previous check",
		);
		expect(recheck.prompt).not.toContain("Diff of the branch");
		const after = store.getTask(task.id)!;
		expect(after.workCheckSendbacks).toBe(2);
		expect(after.pendingPrompt).toContain("tests were weakened");
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("queued");
		expect(after.workCheckLog).toHaveLength(2);
		expect(after.workCheckLog[1]!.outcome).toBe("blockers");
		// The rerun re-cited the quote, so the first blocker stays open.
		expect(after.workCheckLog[0]!.blockers[0]!.status).toBeUndefined();

		// Reruns three and four add one work run and one check run each.
		await loop.runTurn(store.name, task.id);
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(8);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(
			WORK_CHECK_MAX_SENDBACKS,
		);

		// The fifth failing check at the same head hits the cap: needs_you.
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(10); // five work runs, five checks
		const parked = store.getTask(task.id)!;
		expect(parked.state).toBe("needs_you");
		expect(parked.needsReason).toContain(
			`blocked the merge ${WORK_CHECK_MAX_SENDBACKS + 1} times`,
		);
		expect(parked.workCheckSendbacks).toBe(WORK_CHECK_MAX_SENDBACKS);
		expect(parked.asked![0]!.options.map((o) => o.label)).toEqual([
			"Send it back",
			"Merge anyway",
		]);
	});

	test("the re-check input holds the original report, the sent-back blockers, and the new report", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(
			head,
			[block("the claim is wrong", "const x = 1;"), pass()],
			{ diffText: async () => "const x = 1;\n" },
			[
				runResult({
					outcome: {
						status: "ready",
						summary: "first report",
						details: "Claims the widget works on this branch.",
					} satisfies Outcome,
				}),
				runResult({
					outcome: {
						status: "ready",
						summary: "second report",
						details: "Corrects the claim: the widget needs a config flag.",
					} satisfies Outcome,
				}),
			],
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		// The first check input has the run's report and neither earlier blockers nor an
		// original report; the completed check stamps the report as the original result.
		const first = record.runs[1]!;
		expect(first.prompt).toContain("Ready report of the run being checked");
		expect(first.prompt).toContain("Claims the widget works on this branch.");
		expect(first.prompt).not.toContain("Original ready report");
		expect(first.prompt).not.toContain("Earlier blockers:");
		expect(store.getTask(task.id)!.workCheckReport).toBe(
			"first report\n\nClaims the widget works on this branch.",
		);

		// Ready again at the unchanged head: the re-check judges the update against the
		// original result, and a corrected claim is not a current claim.
		await loop.runTurn(store.name, task.id);
		const recheck = record.runs[3]!;
		expect(recheck.prompt).toContain("Original ready report");
		expect(recheck.prompt).toContain("Claims the widget works on this branch.");
		expect(recheck.prompt).toContain("New ready report");
		expect(recheck.prompt).toContain("Corrects the claim");
		expect(recheck.prompt).toContain(
			"a claim the new report corrects or takes back is not a blocker",
		);
		expect(recheck.prompt).toContain("the claim is wrong");
		// The second check passed, and the original report stays stored, never overwritten.
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckReport).toBe(
			"first report\n\nClaims the widget works on this branch.",
		);
	});

	test("an evidence rerun that passes at the unchanged head resolves the blocker", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(
			head,
			[
				block(
					"no check run backs the ready report",
					"const x = 1;",
					"unverified-claim",
				),
				runResult({
					finalText: JSON.stringify({
						blockers: [],
						fixed: [{ id: 1, reason: "the transcript shows the command ran" }],
						notes: [],
					}),
				}),
			],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);

		// The agent produced the missing evidence; the same-head rerun confirms it.
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(4); // two work runs, two checks
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckHead).toBe("sha1");
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.workCheckLog).toHaveLength(2);
		expect(after.workCheckLog[1]!.outcome).toBe("pass");
		expect(after.workCheckLog[0]!.blockers[0]!.status).toBe("fixed");
		expect(after.workCheckLog[0]!.blockers[0]!.statusReason).toBe(
			"the transcript shows the command ran",
		);
	});

	test("a human reply at an unchanged head reruns the check with the reply in its input", async () => {
		const head = { sha: "sha1" };
		const reply = "I reviewed the auth change myself and approve. Merge it.";
		const { store, record, loop } = workCheckCase(
			head,
			[
				block(
					"touches auth and secrets; a human must review this first",
					"const x = 1;",
				),
				pass(["the user approved the blocker"]),
			],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);

		// The fakes settle within one millisecond; real runs put the reply turn strictly
		// after the first check's `at`. Backdate the stored check to encode that order.
		const blocked = store.getTask(task.id)!;
		store.updateTask(task.id, {
			workCheckLog: blocked.workCheckLog.map((r) => ({
				...r,
				at: r.at - 1000,
			})),
		});
		// The user's reply parks its text verbatim in pendingPrompt (the reply endpoint).
		store.updateTask(task.id, { pendingPrompt: reply });
		await loop.runTurn(store.name, task.id);

		// The reply forced a re-check at the same head: a second check run, with the reply.
		expect(record.runs).toHaveLength(4); // two work runs, two checks
		const check = record.runs[3]!;
		expect(check.prompt).toContain(reply);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckHead).toBe("sha1");
		expect(after.workCheckLog).toHaveLength(2);
		expect(after.workCheckLog[1]!.outcome).toBe("pass");
		// The approved blocker resolved when the re-check dropped it.
		expect(after.workCheckLog[0]!.blockers[0]!.status).toBe("fixed");
	});

	test("a human reply does not clear a code blocker the re-check cites again", async () => {
		const head = { sha: "sha1" };
		const reply = "I looked at it, ship it.";
		const { store, record, loop } = workCheckCase(
			head,
			[
				block("tests were weakened", "const x = 1;"),
				block("tests are still weakened", "const x = 1;"),
			],
			{ diffText: async () => "const x = 1;\n" },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckSendbacks).toBe(1);

		// Same backdate as above: keep the reply turn strictly after the first check's `at`.
		const blocked = store.getTask(task.id)!;
		store.updateTask(task.id, {
			workCheckLog: blocked.workCheckLog.map((r) => ({
				...r,
				at: r.at - 1000,
			})),
		});
		store.updateTask(task.id, { pendingPrompt: reply });
		await loop.runTurn(store.name, task.id);

		// The re-check ran and still blocks: the reply did not clear the code problem.
		expect(record.runs).toHaveLength(4);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("queued");
		expect(after.workCheckSendbacks).toBe(2);
		expect(after.pendingPrompt).toContain("tests are still weakened");
		expect(after.workCheckLog).toHaveLength(2);
		expect(after.workCheckLog[1]!.outcome).toBe("blockers");
		expect(after.workCheckLog[0]!.blockers[0]!.status).toBeUndefined(); // re-cited: stays open
	});

	test("a re-ready at an unchanged head with no open blockers starts no check", async () => {
		const head = { sha: "sha1" };
		const { store, record, loop } = workCheckCase(head, [pass()]);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.workCheckHead).toBe("sha1");

		// Simulate a fresh ready at the same head (the merge queue has not taken the card).
		store.updateTask(task.id, { stage: "in_progress", state: "queued" });
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(3); // no second check run
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckLog).toHaveLength(1);
	});

	test("a check that fails twice leaves the card needs_you without stamping the head", async () => {
		const head = { sha: "sha1" };
		// A transient failure, not a usage limit: the limit skips the retry and holds instead.
		const transient = runResult({
			exitCode: 1,
			stderrTail: "error: the provider dropped the connection\n",
		});
		const { store, record, loop } = workCheckCase(head, [transient, transient]);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(3); // work run + two check attempts
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("failed twice");
		expect(after.workCheckHead).toBeNull();
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("error");
		// No adversary role: the record names the default role the check fell back to.
		expect(after.workCheckLog[0]!.model).toBe("fake/default-model");
		expect(after.workCheckLog[0]!.error).toContain(
			"the provider dropped the connection",
		);
	});

	const usageLimited = runResult({
		exitCode: 1,
		model: "openai-codex/gpt-5.5",
		providerError:
			"Codex error event: The usage limit has been reached (code=usage_limit_reached)",
	});

	test("a check at the usage limit holds the card until the reset, then runs again", async () => {
		const head = { sha: "sha1" };
		const resetsAt = Date.now() + 3_600_000;
		const { store, record, loop } = workCheckCase(
			head,
			[usageLimited, pass()],
			{
				modelRoles: () => ({ adversary: "openai-codex/gpt-5.5" }),
				quota: async () => ({
					limits: [
						{
							provider: "openai-codex",
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
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(2); // work run + one check attempt: no retry at the limit
		const held = store.getTask(task.id)!;
		expect(held.stage).toBe("in_progress");
		expect(held.state).toBe("queued");
		expect(held.holdUntil).toBe(resetsAt);
		expect(held.needsReason).toContain("openai-codex");
		expect(held.needsReason).toContain(
			`${new Date(resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
		);
		expect(held.needsReason).not.toContain("failed twice");
		expect(held.pendingPrompt).toContain("Report the same outcome again");
		expect(held.workCheckHead).toBeNull();
		expect(held.workCheckLog[0]!.outcome).toBe("error");
		const ids = (now?: number) =>
			pickRunnable(store.listTasks(), {
				maxParallel: null,
				hasRules: true,
				now,
			}).map((t) => t.id);
		expect(ids()).not.toContain(task.id);
		expect(ids(resetsAt + 1)).toContain(task.id);
		// A queue reorder rewrites queuedAt; the hold must survive it.
		const other = store.createTask("another");
		expect(store.reorderQueue([task.id, other.id])).toBe(true);
		expect(store.getTask(task.id)!.holdUntil).toBe(resetsAt);
		expect(ids()).not.toContain(task.id);
		store.updateTask(other.id, { state: "idle" });

		// After the reset the scheduler starts the turn: the agent re-reports ready, the check re-runs.
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(4);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckHead).toBe("sha1");
	});

	test("a check at the usage limit with no known reset parks needs_you after one attempt", async () => {
		const { store, record, loop } = workCheckCase({ sha: "sha1" }, [
			usageLimited,
		]);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(2); // work run + one check attempt
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("usage limit");
		expect(after.needsReason).not.toContain("failed twice");
		expect(after.workCheckHead).toBeNull();
	});

	test("the check holds a global cap slot while it runs", async () => {
		const head = { sha: "sha1" };
		const record = baseRecord();
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: {
											status: "ready",
											summary: "did it",
										} satisfies Outcome,
									}),
								)
							: checkDone,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const turn = loop.runTurn(store.name, task.id);
		await flushPromises();
		expect(record.runs).toHaveLength(2);
		expect([...loop.running.keys()]).toContain(
			`${store.name}/${task.id}:workcheck`,
		);
		releaseCheck(pass());
		await turn;
		expect([...loop.running.keys()]).not.toContain(
			`${store.name}/${task.id}:workcheck`,
		);
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	test("the lost sweep settles a work check whose agent pid died and records the run", async () => {
		const head = { sha: "sha1" };
		const record = baseRecord();
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0, // hold any chained turn; the assertion is the parked state
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			workCheck: () => true,
			pidAlive: () => false, // the check's omp died; a grandchild keeps `done` hanging
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: {
											status: "ready",
											summary: "did it",
										} satisfies Outcome,
									}),
								)
							: checkDone,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(
			`${store.name}/${task.id}:workcheck`,
		);
		expect(store.getTask(task.id)!.state).toBe("running");

		loop.schedule(); // the tick: the check pid is dead
		await flushPromises();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("The work check was lost");
		expect(after.needsReason).toContain("lost check agent process (pid 4242)");
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("error");
		expect(after.workCheckLog[0]!.error).toContain(
			"lost check agent process (pid 4242)",
		);
		expect(after.workCheckHead).toBeNull(); // no head stamp: a re-run checks again

		releaseCheck(pass());
		await run;
		// The late `done` must not touch the card the sweep parked.
		expect(store.getTask(task.id)!.state).toBe("needs_you");
	});

	test("a blocker whose quote matches nothing demotes to a note beside a real note", async () => {
		const head = { sha: "sha1" };
		const { store, loop } = workCheckCase(head, [
			runResult({
				finalText: JSON.stringify({
					blockers: [{ finding: "naming is off", quote: "NO SUCH QUOTE" }],
					fixed: [],
					notes: ["small nit"],
				}),
			}),
		]);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		const run = after.workCheckLog[0]!;
		expect(run.outcome).toBe("pass");
		expect(run.blockers).toEqual([]);
		expect(run.notes[0]).toContain("naming is off");
		expect(run.notes[0]).toContain("(quote matched nothing");
		expect(run.notes).toContain("small nit");
	});

	test("an anthropic work run checks with the critic role's selector", async () => {
		const head = { sha: "sha1" };
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			modelRoles: () => ({ critic: "openai-codex/gpt-6.1-sol:max" }),
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						record.runs.length === 1
							? runResult({
									model: "anthropic/claude-sonnet-4",
									outcome: {
										status: "ready",
										summary: "did it",
									} satisfies Outcome,
								})
							: pass(),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs[1]!.model).toBe("openai-codex/gpt-6.1-sol:max");
	});

	test("a check that runs on the work model itself warns on the card", async () => {
		const head = { sha: "sha1" };
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			modelRoles: () => ({ adversary: "zai/glm-5.3-flash:medium" }),
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						record.runs.length === 1
							? runResult({
									// Another thinking level is still the same model.
									model: "zai/glm-5.3-flash:high",
									outcome: {
										status: "ready",
										summary: "did it",
									} satisfies Outcome,
								})
							: pass(),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const run = store.getTask(task.id)!.workCheckLog[0]!;
		expect(run.outcome).toBe("pass");
		expect(run.model).toBe("zai/glm-5.3-flash:medium");
		expect(run.warn).toBe(
			"The check model zai/glm-5.3-flash:medium is the same model as the run it checks — no second-model opinion.",
		);
	});

	test("a check on the work model's vendor, another model, warns with the vendor reason", async () => {
		const head = { sha: "sha1" };
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => head.sha,
			modelRoles: () => ({ adversary: "zai/glm-5:medium" }),
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						record.runs.length === 1
							? runResult({
									model: "zai/glm-5.3-flash",
									outcome: {
										status: "ready",
										summary: "did it",
									} satisfies Outcome,
								})
							: pass(),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.workCheckLog[0]!.warn).toBe(
			"The check model zai/glm-5:medium is from the same vendor as the run it checks — no second-vendor opinion.",
		);
	});
});

// Dep-held turns (OTTR-34): a needs_you report_outcome with dependsOn requeues the card in
// its current stage with DEP_HELD_PROMPT parked; the dispatcher swaps the marker for
// depResumePrompt at restart.
describe("turn dep hold (report_outcome dependsOn)", () => {
	/** startRun override whose run reports needs_you holding on `depIds` (read late, after setup). */
	function holdingRun(
		record: Recorded,
		depIds: () => string[],
	): Partial<TurnOps> {
		return {
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "holding",
								dependsOn: depIds(),
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		};
	}

	/** Like setup, but the holdingRun override reads dep ids lazily. */
	function depCase(depIds: () => string[]) {
		const store = freshStore();
		const record = baseRecord();
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, holdingRun(record, depIds)),
		);
		return { store, record, loop };
	}

	test("a needs_you outcome with dependsOn requeues the work card and stores the ids", async () => {
		let depId = "";
		const { store, loop } = depCase(() => [depId]);
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.stage).toBe("in_progress");
		expect(after.dependsOn).toContain(dep.id);
		expect(after.needsReason).toBe(`waiting for #${dep.id} the blocker`);
		expect(after.pendingPrompt).toBe(DEP_HELD_PROMPT);
	});

	test("a merge-kind card requeues at merging the same way", async () => {
		let depId = "";
		const { store, loop } = depCase(() => [depId]);
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("merge please");
		store.updateTask(task.id, { stage: "merging" });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.stage).toBe("merging");
		expect(after.needsReason).toBe(`waiting for #${dep.id} the blocker`);
		expect(after.pendingPrompt).toBe(DEP_HELD_PROMPT);
	});

	test("a dependsOn id that is not a card parks needs_you naming it, ids unchanged", async () => {
		const { store, loop } = depCase(() => ["nope"]);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("nope");
		expect(after.dependsOn).toEqual([]);
	});

	test("a dependsOn naming the card itself parks needs_you naming it", async () => {
		let taskId = "";
		const { store, loop } = depCase(() => [taskId]);
		const task = store.createTask("work please");
		taskId = task.id;

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(`#${task.id}`);
		expect(after.dependsOn).toEqual([]);
	});

	/** One dep-held resume: `done` picks the dependency's end state the prompt must name. */
	async function depResumeCase(done: boolean): Promise<{
		prompt: string;
		depId: string;
		store: ProjectStore;
	}> {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
		});
		const dep = store.createTask("the blocker");
		store.updateTask(dep.id, {
			stage: done ? "done" : "in_progress",
			state: "idle",
			...(done ? {} : { cancelledAt: Date.now() }),
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			sessionId: "sess-1",
			state: "queued",
			queuedAt: Date.now(),
			pendingPrompt: DEP_HELD_PROMPT,
			dependsOn: [dep.id],
		});
		saveSession(store, "sess-1");

		await loop.runTurn(store.name, task.id);
		return { prompt: record.runs[0]!.prompt, depId: dep.id, store };
	}

	test("a dep-held card restarts naming its dependency done", async () => {
		const { prompt, depId, store } = await depResumeCase(true);
		expect(prompt).toContain(`#${depId} the blocker: done`);
		// Wrapped by replyPrompt: the reply scaffold is there.
		expect(prompt).toContain("call report_outcome");
		// The reply is consumed: a leftover pendingPrompt would read as mid-run steering
		// at settle and requeue the card forever.
		const after = store.getTask(
			store.listTasks().find((t) => t.prompt === "work please")!.id,
		)!;
		expect(after.pendingPrompt).toBeNull();
		expect(after.state).toBe("idle");
	});

	test("a dep-held card restarts naming its dependency cancelled", async () => {
		const { prompt, depId } = await depResumeCase(false);
		expect(prompt).toContain(`#${depId} the blocker: cancelled`);
		expect(prompt).toContain("call report_outcome");
	});

	test("a dependsOn id naming no project parks needs_you naming it, ids unchanged", async () => {
		const { store, loop } = depCase(() => ["NOPE-5"]);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("NOPE-5");
		expect(after.needsReason).toContain("no project NOPE");
		expect(after.dependsOn).toEqual([]);
	});

	/** Two projects on one loop: `store` (own) and `foreign` with the AD id handle, so
	 * report_outcome may hold on the foreign project's cards. */
	function twoProjectCase(depIds: () => string[]) {
		const store = freshStore();
		const foreign = freshStore();
		foreign.setSettings({ taskIdPrefix: "AD" });
		const foreignDep = foreign.createTask("the foreign blocker");
		const record = baseRecord();
		const projects = new Map([
			[store.name, fakeProject(store)],
			[foreign.name, fakeProject(foreign)],
		]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, holdingRun(record, depIds)),
		);
		return { store, foreign, foreignDep, record, loop };
	}

	test("a cross-project dependsOn id is recorded and holds like a local one", async () => {
		const { store, foreignDep, loop } = twoProjectCase(() => [foreignDep.id]);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.stage).toBe("in_progress");
		expect(after.dependsOn).toEqual([foreignDep.id]);
		expect(after.needsReason).toBe(
			`waiting for #${foreignDep.id} the foreign blocker`,
		);
		expect(after.pendingPrompt).toBe(DEP_HELD_PROMPT);
	});

	test("a dep-held card restarts naming its foreign dependency done", async () => {
		const store = freshStore();
		const foreign = freshStore();
		foreign.setSettings({ taskIdPrefix: "AD" });
		const foreignDep = foreign.createTask("the foreign blocker");
		const record = baseRecord();
		const projects = new Map([
			[store.name, fakeProject(store)],
			[foreign.name, fakeProject(foreign)],
		]);
		const loop = createTurnLoop(projects, fakeOps(record));
		const task = replyCard(store, "work please");
		store.updateTask(task.id, {
			pendingPrompt: DEP_HELD_PROMPT,
			dependsOn: [foreignDep.id],
		});
		foreign.updateTask(foreignDep.id, { stage: "done", state: "idle" });

		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.prompt).toContain(
			`#${foreignDep.id} the foreign blocker: done`,
		);
		// The foreign store resolved the title; the own store's fallback would repeat the id.
		expect(record.runs[0]!.prompt).not.toContain(
			`#${foreignDep.id} ${foreignDep.id}: done`,
		);
	});

	test("a ready outcome with dependsOn records the ids but keeps the normal next state", async () => {
		let depId = "";
		const { store, record, loop } = setup({
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "ready",
								summary: "did it",
								dependsOn: [depId],
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.dependsOn).toContain(dep.id);
		expect(after.pendingPrompt).toBeNull();
	});
});

// OTTR-45: while a second-model check runs, the card must stay in_progress/running so the
// schedule tick neither starts the chained merge turn nor settles a parked review early.
describe("card state while a second-model check runs", () => {
	const passVerdict = () =>
		runResult({
			finalText: JSON.stringify({ blockers: [], fixed: [], notes: [] }),
		});
	// Deterministic wait: drains microtasks until f() holds, bounded so a broken
	// setup fails its assertions instead of hanging.
	const until = async (f: () => boolean) => {
		for (let i = 0; i < 100 && !f(); i++) await flushPromises();
	};

	test("a ready work card stays in_progress/running while its check runs, and schedule starts no merge turn", async () => {
		const record = baseRecord();
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const mergeDone = new Promise<RunResult>(() => {}); // the merge turn starts and hangs
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 1,
			targetSha: async () => "sha1",
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: {
											status: "ready",
											summary: "did it",
										} satisfies Outcome,
									}),
								)
							: record.runs.length === 2
								? checkDone
								: mergeDone,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const turn = loop.runTurn(store.name, task.id);
		await until(() => record.runs.length === 2);
		// The check is in flight: the card must not read as mergeable yet.
		expect(record.runs).toHaveLength(2);
		const during = store.getTask(task.id)!;
		expect(during.stage).toBe("in_progress");
		expect(during.state).toBe("running");
		// The tick sees a running work card: nothing to pick, no merge turn starts.
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(2);
		expect(store.getTask(task.id)!.stage).toBe("in_progress");
		expect(store.getTask(task.id)!.state).toBe("running");
		releaseCheck(passVerdict());
		await turn;
		await until(() => record.runs.length === 3);
		const after = store.getTask(task.id)!;
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		expect(after.workCheckHead).toBe("sha1");
		expect(after.stage).toBe("merging");
		expect(record.runs).toHaveLength(3); // the chained merge turn started
		expect(record.runs[2]!.prompt).not.toContain("You are the second model");
	});

	test("a blocking work check starts no merge turn and sends the card back", async () => {
		const record = baseRecord();
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const mergeDone = new Promise<RunResult>(() => {}); // the merge turn starts and hangs
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 1,
			targetSha: async () => "sha1",
			diffText: async () => "const x = 1;\n",
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: {
											status: "ready",
											summary: "did it",
										} satisfies Outcome,
									}),
								)
							: record.runs.length === 2
								? checkDone
								: mergeDone,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const turn = loop.runTurn(store.name, task.id);
		await until(() => record.runs.length === 2);
		expect(record.runs).toHaveLength(2);
		expect(store.getTask(task.id)!.stage).toBe("in_progress");
		expect(store.getTask(task.id)!.state).toBe("running");
		loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(2); // a running card is not mergeable
		releaseCheck(
			runResult({
				finalText: JSON.stringify({
					blockers: [{ finding: "tests were weakened", quote: "const x = 1;" }],
					fixed: [],
					notes: [],
				}),
			}),
		);
		await turn;
		await flushPromises();
		// The send-back requeued the card and the loop immediately resumed the work agent:
		// in_progress/running again, never merging, and the third run is the resumed work
		// turn — no merge turn starts for this head.
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("running");
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.workCheckHead).toBe("sha1");
		expect(after.needsReason).toBeNull();
		expect(after.workCheckLog[0]!.outcome).toBe("blockers");
		expect(record.runs).toHaveLength(3);
		expect(record.runs[2]!.prompt).not.toContain("You are the second model");
	});

	test("a release review with recorded findings does not publish while its check runs", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: checkDone,
					kill: async () => {},
				};
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}release v1.0.0`,
			null,
			"review",
		);
		store.updateTask(review.id, {
			stage: "in_progress",
			state: "queued",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-x",
			branch: "ott/rel",
			releaseNotes: "notes body",
		});
		const turn = loop.runTurn(store.name, review.id);
		await until(() => record.runs.length === 2);
		expect(record.runs).toHaveLength(2);
		const during = store.getTask(review.id)!;
		expect(during.stage).toBe("in_progress");
		expect(during.state).toBe("running");
		// The tick must not settle a review whose check has not even finished.
		loop.schedule();
		await flushPromises();
		expect(record.publishRelease).toHaveLength(0);
		const ticking = store.getTask(review.id)!;
		expect(ticking.stage).toBe("in_progress");
		expect(ticking.state).toBe("running");
		releaseCheck(
			runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
		);
		await turn;
		await flushPromises();
		const kids = store.listTasks().filter((t) => t.followUpOf === review.id);
		expect(kids).toHaveLength(1);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);
		expect(record.publishRelease).toHaveLength(0);
		store.updateTask(kids[0]!.id, { stage: "done", state: "idle" });
		loop.schedule();
		await flushPromises();
		expect(record.publishRelease).toHaveLength(1);
		const done = store.getTask(review.id)!;
		expect(done.stage).toBe("done");
		expect(done.summary).toBe("Released v1.0.0");
	});

	test("a Review-button review is not done while its check runs", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: checkDone,
					kill: async () => {},
				};
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		const turn = loop.runTurn(store.name, review.id);
		await until(() => record.runs.length === 2);
		expect(record.runs).toHaveLength(2);
		const during = store.getTask(review.id)!;
		expect(during.stage).toBe("in_progress");
		expect(during.state).toBe("running");
		loop.schedule();
		await flushPromises();
		const ticking = store.getTask(review.id)!;
		expect(ticking.stage).not.toBe("done");
		expect(ticking.stage).toBe("in_progress");
		expect(ticking.state).toBe("running");
		expect(record.publishRelease).toHaveLength(0);
		releaseCheck(
			runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
		);
		await turn;
		await flushPromises();
		const kids = store.listTasks().filter((t) => t.followUpOf === review.id);
		expect(kids).toHaveLength(1);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);
		expect(record.publishRelease).toHaveLength(0);
	});
});

describe("turn survivor round 5 — helpers", () => {
	type TitleSpawn = NonNullable<Parameters<typeof generateTitle>[1]>;
	/** Fake `omp auth-gateway stdio`: records each request body and answers with `reply`. */
	function gateway(reply: string, code = 0) {
		const requests: {
			body: { messages: { role: string; content: string }[] };
		}[] = [];
		const spawn: TitleSpawn = async (_argv, o) => {
			requests.push(JSON.parse(o.stdin));
			return {
				code,
				stdout: `${JSON.stringify({ ready: true })}\n${JSON.stringify({
					id: 1,
					status: 200,
					body: { choices: [{ message: { content: reply } }] },
				})}\n`,
				stderr: code === 0 ? "" : "gateway down",
			};
		};
		return { spawn, requests };
	}

	test("generateTitle sends a system instruction and the prompt's first 1000 chars", async () => {
		const g = gateway("Fix login");
		const prompt = `fix the login ${"x".repeat(1500)}`;
		expect(await generateTitle(prompt, g.spawn)).toBe("Fix login");
		expect(g.requests).toHaveLength(1);
		const messages = g.requests[0]!.body.messages;
		expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
		expect(messages[0]!.content).toContain("title");
		expect(messages[1]!.content).toBe(prompt.slice(0, 1000));
	});

	test("generateTitle: a blank prompt asks no model and gets no title", async () => {
		const g = gateway("Should not be asked");
		expect(await generateTitle("   \n\t", g.spawn)).toBeNull();
		expect(g.requests).toHaveLength(0);
	});

	test("generateTitle normalizes the reply: first line, collapsed spaces, outer quotes, 80 chars", async () => {
		const cases: [string, string][] = [
			["  Fix   the\tlogin  \nsecond line", "Fix the login"],
			[`""Fix login""`, "Fix login"],
			[`"Don't break 'quoted' words"`, "Don't break 'quoted' words"],
			["Plain title", "Plain title"],
			[`  'Spaced quote'  `, "Spaced quote"],
			["**Task Name: OTTR-292**", "Task Name: OTTR-292"],
		];
		for (const [reply, title] of cases)
			expect(await generateTitle("name me", gateway(reply).spawn)).toBe(title);
		const long = await generateTitle("name me", gateway("w".repeat(100)).spawn);
		expect(long).toBe("w".repeat(80));
	});

	test("generateTitle: an empty or all-quote reply and a gateway failure give null", async () => {
		expect(await generateTitle("name me", gateway(`""`).spawn)).toBeNull();
		expect(await generateTitle("name me", gateway("   ").spawn)).toBeNull();
		expect(await generateTitle("name me", gateway("x", 1).spawn)).toBeNull();
	});

	test("generateTitle: the OTTR-538 refusal gets no title and the system prompt forbids opening links", async () => {
		const causes: string[] = [];
		const g = gateway(
			"I can't open links, including TikTok, so I can't see what's in that video. Could",
		);
		const title = await generateTitle(
			"https://vm.tiktok.com/ZGdXh1whN/ any new advice for us?",
			g.spawn,
			(c) => causes.push(c),
		);
		expect(title).toBeNull();
		expect(causes).toEqual(["not a title (refusal reply)"]);
		expect(g.requests).toHaveLength(1);
		expect(g.requests[0]!.body.messages[0]!.content).toContain(
			"never open links",
		);
	});

	test("generateTitle: a curly-apostrophe refusal is rejected like a straight one", async () => {
		const causes: string[] = [];
		const title = await generateTitle(
			"name me",
			gateway("I can\u2019t open links").spawn,
			(c) => causes.push(c),
		);
		expect(title).toBeNull();
		expect(causes).toEqual(["not a title (refusal reply)"]);
	});

	test("generateTitle: a reply over 8 words is not a title", async () => {
		const causes: string[] = [];
		// 10 words: Add configurable retry backoff windows for every queue worker pool.
		const reply =
			"Add configurable retry backoff windows for every queue worker pool";
		const title = await generateTitle("name me", gateway(reply).spawn, (c) =>
			causes.push(c),
		);
		expect(title).toBeNull();
		expect(causes).toEqual(["not a title (over 8 words)"]);
	});

	test("generateTitle: a normal 3-8 word reply still names the card", async () => {
		const g = gateway("Check TikTok link for advice");
		expect(
			await generateTitle(
				"https://vm.tiktok.com/ZGdXh1whN/ any new advice for us?",
				g.spawn,
			),
		).toBe("Check TikTok link for advice");
		// The 8-word cap boundary holds: eight words pass.
		const eight = "Fix the flaky login redirect test in CI";
		expect(await generateTitle("name me", gateway(eight).spawn)).toBe(eight);
	});

	test("generateTitle: an OTTR-516 follow-up titles the work with the parent as context, never the handoff path", async () => {
		const g = gateway("Add report path line to agent docs");
		const title = await generateTitle(
			followUpPrompt({
				text: "Add a report-path line to /workspace/ottr/AGENTS.md so agents read a finished Stryker run's survivors from its report file instead of re-running the gate.",
				title:
					"Retro of Take the memory backend choice out of the agent layer: the deployment…",
				handoffPath: "/data/ottr/handoffs/OTTR-492.md",
			}),
			g.spawn,
		);
		expect(title).toBe("Add report path line to agent docs");
		const content = g.requests[0]!.body.messages[1]!.content;
		expect(content).toContain(
			"Continues: Retro of Take the memory backend choice out of the agent layer: the deployment…",
		);
		expect(content).toContain("Add a report-path line");
		expect(content).not.toContain("/data/");
		expect(content).not.toContain("OTTR-492");
		expect(content).not.toContain("@");
		expect(content).not.toContain("Read the handoff");
	});

	test("generateTitle: the Implement steps shape titles the work, not the fixed instruction", async () => {
		const g = gateway("Implement loading skeleton primitive");
		const title = await generateTitle(
			followUpPrompt({
				// The fixed "Implement steps" text (IMPLEMENT_RECOMMENDATIONS, src/ui/app.tsx).
				text: "Implement the recommended steps (a `## Recommended steps` heading in the report; older reports call them next steps or action items) from the research report in the handoff. If the steps split into independent pieces of work, implement the first one in this task and file each other piece as its own card with the create_task tool. If the report recommends no steps, change nothing and report that.",
				title: "Loading-state UX advice for Ottr",
				handoffPath: "/data/ottr/handoffs/OTTR-572.md",
			}),
			g.spawn,
		);
		expect(title).toBe("Implement loading skeleton primitive");
		const content = g.requests[0]!.body.messages[1]!.content;
		expect(content).toContain("Continues: Loading-state UX advice for Ottr");
		expect(content).toContain("Implement the recommended steps");
		expect(content).not.toContain("/data/");
		expect(content).not.toContain("@");
	});

	test("generateTitle: a reply naming a path or the handoff step is not a title", async () => {
		const causes: string[] = [];
		expect(
			await generateTitle(
				"name me",
				gateway("Read @/data/ottr/handoffs/OTTR-516.md first.").spawn,
				(c) => causes.push(c),
			),
		).toBeNull();
		expect(causes).toEqual(["not a title (names a file path)"]);
		causes.length = 0;
		expect(
			await generateTitle(
				"name me",
				gateway(
					"Read the handoff file to see the report and recommended steps.",
				).spawn,
				(c) => causes.push(c),
			),
		).toBeNull();
		expect(causes).toEqual(["not a title (names the handoff step)"]);
		// OTTR-574's good title survives the path and handoff heads.
		expect(
			await generateTitle(
				"name me",
				gateway("Implement Button Capitalization Recommendations").spawn,
			),
		).toBe("Implement Button Capitalization Recommendations");
	});

	test("uiFiles: test/ folders, extra suffixes and root ui/ code", () => {
		expect(
			uiFiles([
				"test/Board.tsx",
				"docs/page.html.md",
				"web/foo.test.bak/page.html",
				"src/ui/app.js.map",
				"ui/app.ts",
			]),
		).toEqual(["web/foo.test.bak/page.html", "ui/app.ts"]);
	});

	test("ui-shot re-prompt lists five files, then an ellipsis", async () => {
		const six = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}.css`);
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			changedFiles: async () => six,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const prompt = store.getTask(task.id)!.pendingPrompt ?? "";
		expect(prompt).toContain("(a.css, b.css, c.css, d.css, e.css, …)");
		expect(prompt).not.toContain("f.css");
	});

	test("ui-shot re-prompt with exactly five files has no ellipsis", async () => {
		const five = ["a", "b", "c", "d", "e"].map((n) => `${n}.css`);
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			changedFiles: async () => five,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const prompt = store.getTask(task.id)!.pendingPrompt ?? "";
		expect(prompt).toContain("(a.css, b.css, c.css, d.css, e.css)");
		expect(prompt).not.toContain("…");
	});

	test("checkRunError: a non-zero exit with no stderr names only the code", () => {
		expect(checkRunError(runResult({ exitCode: 2, stderrTail: "  \n" }))).toBe(
			"the check run exited with code 2",
		);
	});

	test("image quarantine moves only the files that exist and counts them", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							exitCode: 1,
							sessionId: null,
							sawTerminalEnd: false,
							finalText: "",
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		setImage(store, task.id, "1.png", "rejected-bytes");
		store.updateTask(task.id, { images: ["1.png", "gone.png"] });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.images).toEqual(["gone.png"]);
		expect(
			existsSync(join(store.tasksDir, "quarantine", task.id, "1.png")),
		).toBe(true);
		expect(logText(store, task.id)).toContain(
			`quarantined 1 image(s) to .tasks/quarantine/${task.id}: 1.png `,
		);
	});

	test("parseReleaseVersion keeps every prerelease part", () => {
		expect(parseReleaseVersion("shipped v1.2.3-rc.10 today")).toBe(
			"v1.2.3-rc.10",
		);
		expect(parseReleaseVersion("shipped v1.2.3-rc.1.2 today")).toBe(
			"v1.2.3-rc.1.2",
		);
		expect(parseReleaseVersion("shipped v1.2.3-beta today")).toBe(
			"v1.2.3-beta",
		);
	});

	test("parseTopicReport: no space after the colon, inner dots, cut at a space", () => {
		expect(parseTopicReport("topic:v2 rollout")).toBe("v2 rollout");
		expect(parseTopicReport("topic: v1.2 rollout.")).toBe("v1.2 rollout");
		expect(parseTopicReport(`topic: ${"a".repeat(39)} bcd`)).toBe(
			"a".repeat(39),
		);
	});

	test("turnModel: a selector without a level keeps the transcript's own level", () => {
		expect(turnModel("zai/glm-5.3-flash:high", "zai/glm-5.3-flash")).toBe(
			"zai/glm-5.3-flash:high",
		);
	});

	test("logStoreError: the window ends at exactly 10 minutes", () => {
		const name = `edge-${Math.random()}`;
		const seen: string[] = [];
		const origError = console.error;
		const origNow = Date.now;
		let now = 1_000_000_000_000;
		console.error = (_: string, err: unknown) => seen.push(String(err));
		Date.now = () => now;
		try {
			logStoreError(name, new Error("first"));
			now += 599_999;
			logStoreError(name, new Error("inside"));
			now += 1; // exactly 600_000 ms after the first line
			logStoreError(name, new Error("again"));
		} finally {
			console.error = origError;
			Date.now = origNow;
		}
		expect(seen).toEqual(["Error: first", "Error: again"]);
	});

	test("getSettingsLogged: a sick store logs its error", () => {
		const seen: string[] = [];
		const orig = console.error;
		console.error = (_: string, err: unknown) => seen.push(String(err));
		try {
			const sick = {
				name: `sick-${Math.random()}`,
				getSettings() {
					throw new Error("database is locked");
				},
			} as unknown as ProjectStore;
			getSettingsLogged({ store: sick } as TurnProject);
		} finally {
			console.error = orig;
		}
		expect(seen).toEqual(["Error: database is locked"]);
	});

	test("held update and fork-born cards tell the user to approve the merge", async () => {
		const u = setup();
		const update = u.store.createTask("update pins");
		u.store.updateTask(update.id, { updateIds: ["a@1"] });
		u.store.setSettings({ holdUpdateMerges: true });
		await u.loop.runTurn(u.store.name, update.id);
		expect(u.store.getTask(update.id)!.needsReason).toContain("approve");

		const f = setup({ commitsAhead: async () => 0 });
		const parent = f.store.createTask("fork research: weekly digest");
		f.store.updateTask(parent.id, {
			topic: "fork research",
			research: true,
			stage: "done",
			state: "idle",
		});
		const fork = f.store.createTask("adopt fork idea");
		f.store.updateTask(fork.id, { followUpOf: parent.id });
		await f.loop.runTurn(f.store.name, fork.id);
		const held = f.store.getTask(fork.id)!;
		expect(held.state).toBe("needs_you");
		expect(held.needsReason).toContain("approve");
	});
});

describe("turn survivor round 5 — sweep, schedule, release publish, reviews", () => {
	/** Store view with selected methods overridden; the rest resolves through the prototype. */
	function proxyStore(
		store: ProjectStore,
		over: Record<string, unknown>,
	): ProjectStore {
		const p = Object.create(store) as ProjectStore & Record<string, unknown>;
		for (const [k, v] of Object.entries(over)) p[k] = v;
		return p as ProjectStore;
	}

	/** Runs fn with console.error captured; returns the logged error values. */
	async function withErrors(fn: () => Promise<void> | void): Promise<string[]> {
		const seen: string[] = [];
		const orig = console.error;
		console.error = (_: unknown, err: unknown) => {
			seen.push(String(err));
		};
		try {
			await fn();
		} finally {
			console.error = orig;
		}
		return seen;
	}

	/** The stale-row fixture: pid 4344 is dead, cap 0 keeps the requeued card from restarting. */
	function sweepSetup() {
		return setup({
			maxTotalRuns: () => 0,
			pidAlive: (pid: number) => pid !== 4344,
		});
	}

	/** A review run whose findings check hangs on `checkPid` (the review run itself ends). */
	function checkCase(
		checkPid: number | null,
		overrides: Partial<TurnOps> = {},
		wrap: (s: ProjectStore) => ProjectStore = (s) => s,
	) {
		const store = freshStore();
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(wrap(store))]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				commitsAhead: async () => 0,
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess");
					const isReview = record.runs.length === 1;
					return {
						pid: isReview ? 4242 : checkPid,
						done: isReview
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: new Promise<RunResult>(() => {}),
						kill: async () => {},
					};
				},
				...overrides,
			}),
		);
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		const checkKey = `${store.name}/${review.id}:check`;
		return { store, record, loop, review, checkKey };
	}

	function parkedRelease(store: ProjectStore, version = "v4.0.0") {
		const task = store.createTask(`release ${version}`);
		store.updateTask(task.id, {
			stage: "merging",
			state: "idle",
			needsReason: FINDINGS_HOLD,
			releaseVersion: version,
			base: "shaR",
			worktree: "wt",
		});
		return task;
	}

	// ---- settleLostTurn ---------------------------------------------------------

	test("a lost row re-sends its own prompt, not an earlier row's", async () => {
		const { store, loop } = sweepSetup();
		const task = store.createTask("two turns");
		store.updateTask(task.id, { state: "running", sessionId: "sess-9" });
		saveSession(store, "sess-9"); // saved, but it never recorded the prompt
		const first = store.startTurn(task.id, "work", "first prompt", 4343);
		store.finishTurn(first.id, { endedAt: 1 });
		store.startTurn(task.id, "work", "second prompt", 4344);

		loop.schedule();
		await flushPromises();

		expect(store.getTask(task.id)!.pendingPrompt).toBe("second prompt\n\n.");
	});

	test("a restart with a saved session and no open row requeues with the plain continue", async () => {
		const { store, loop } = setup();
		const task = store.createTask("restart me");
		store.updateTask(task.id, { state: "running", sessionId: "sess-9" });
		saveSession(store, "sess-9");

		await loop.recoverRestarted();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe(".");
	});

	// ---- sweepLostTurns -----------------------------------------------------------

	test("the lost sweep settles a preparing card's dead row without re-sending an unsaved prompt", async () => {
		const { store, loop } = sweepSetup();
		const task = store.createTask("left preparing");
		// The session id is known, but omp never wrote its file.
		store.updateTask(task.id, { state: "preparing", sessionId: "sess-9" });
		store.startTurn(task.id, "work", "old prompt", 4344);

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("lost agent process (pid 4344)");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe(".");
	});

	test("the lost sweep leaves a parked card's open row alone", async () => {
		const { store, loop } = sweepSetup();
		const task = store.createTask("parked with an open row");
		store.updateTask(task.id, {
			state: "needs_you",
			needsReason: "which colour?",
		});
		store.startTurn(task.id, "work", "old prompt", 4344);

		loop.schedule();
		await flushPromises();

		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("which colour?");
		expect(after.pendingPrompt).toBeNull();
	});

	test("a running card whose last row already ended is not settled again", async () => {
		const { store, loop } = sweepSetup();
		const task = store.createTask("between run and check");
		store.updateTask(task.id, { state: "running" });
		const row = store.startTurn(task.id, "work", "old prompt", 4344);
		store.finishTurn(row.id, { endedAt: 1, exitCode: 0 });

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).toBe(1);
		expect(turn.error).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
	});

	test("a pid-less open row whose worker stream is live is left alone", async () => {
		const { store, loop } = sweepSetup();
		const task = store.createTask("worker run");
		store.updateTask(task.id, { state: "running" });
		store.startTurn(task.id, "work", "old prompt", null);
		const entry = {
			pid: null,
			done: new Promise<void>(() => {}),
			kill: async () => {},
		};
		loop.running.set(`${store.name}/${task.id}`, entry);

		loop.schedule();
		await flushPromises();

		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(loop.running.get(`${store.name}/${task.id}`)).toBe(entry);
	});

	test("the sweep keeps a live entry whose pid is not the dead row's pid", async () => {
		const { store, loop } = sweepSetup();
		const task = store.createTask("dead row, other live process");
		store.updateTask(task.id, { state: "running" });
		store.startTurn(task.id, "work", "old prompt", 4344);
		const key = `${store.name}/${task.id}`;
		const entry = {
			pid: 777,
			done: new Promise<void>(() => {}),
			kill: async () => {},
		};
		loop.running.set(key, entry);

		loop.schedule();
		await flushPromises();

		// The dead row settles, but only the entry holding pid 4344 could be abandoned.
		expect(store.listTurns(task.id)[0]!.error).toBe(
			"lost agent process (pid 4344)",
		);
		expect(loop.running.get(key)).toBe(entry);
	});

	test("a store whose first listing fails is logged by the sweep", async () => {
		const store = freshStore();
		let calls = 0;
		const loop = createTurnLoop(
			new Map([
				[
					store.name,
					fakeProject(
						proxyStore(store, {
							listTasks() {
								calls += 1;
								if (calls === 1) throw new Error("sweep listing failed");
								return store.listTasks();
							},
						}),
					),
				],
			]),
			fakeOps(baseRecord()),
		);

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(calls).toBeGreaterThan(1); // the schedule's own listing succeeded
		expect(seen.join("\n")).toContain("sweep listing failed");
	});

	// ---- sweepLostTurns: lost second-model checks ---------------------------------

	test("a lost pid-less review check parks the card with the review reason", async () => {
		const { store, loop, review, checkKey } = checkCase(null, {
			pidAlive: () => true,
		});
		void loop.runTurn(store.name, review.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(checkKey);

		loop.schedule();
		await flushPromises();

		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"The review check was lost: lost check agent process. Reply to re-run the review, or cancel the card.",
		);
		expect(after.workCheckLog).toEqual([]); // a review check is not a work-check run
		expect(logText(store, review.id)).toContain("lost check agent process");
		expect([...loop.running.keys()]).not.toContain(checkKey);
	});

	test("a lost check on a cancelled card leaves the card to the cancel", async () => {
		const { store, loop, review, checkKey } = checkCase(4242, {
			pidAlive: () => false,
		});
		void loop.runTurn(store.name, review.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(checkKey);
		store.updateTask(review.id, { cancelledAt: Date.now() });

		loop.schedule();
		await flushPromises();

		const after = store.getTask(review.id)!;
		expect(after.state).toBe("running");
		expect(after.needsReason).toBeNull();
		expect(logText(store, review.id)).toContain(
			"lost check agent process (pid 4242)",
		);
		expect([...loop.running.keys()]).not.toContain(checkKey);
	});

	test("a check whose card vanished before the settle is skipped quietly", async () => {
		let gone = false;
		const { store, loop, review, checkKey } = checkCase(
			4242,
			{ pidAlive: () => false },
			(s) =>
				proxyStore(s, {
					getTask: (id: string) => (gone ? null : s.getTask(id)),
				}),
		);
		void loop.runTurn(store.name, review.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(checkKey);
		gone = true;

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen).toEqual([]);
		expect([...loop.running.keys()]).not.toContain(checkKey);
		expect(store.getTask(review.id)!.state).toBe("running");
	});

	test("a lost-check settle that cannot write is logged", async () => {
		let fail = false;
		const { store, loop, review, checkKey } = checkCase(
			4242,
			{ pidAlive: () => false },
			(s) =>
				proxyStore(s, {
					updateTask: (
						id: string,
						patch: Parameters<ProjectStore["updateTask"]>[1],
					) => {
						if (fail) throw new Error("check park failed");
						return s.updateTask(id, patch);
					},
				}),
		);
		void loop.runTurn(store.name, review.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(checkKey);
		fail = true;

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("check park failed");
		expect(store.getTask(review.id)!.state).toBe("running");
	});

	test("a lost work check records an error run with no blockers and no notes", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => "sha1",
			workCheck: () => true,
			pidAlive: () => false,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: {
											status: "ready",
											summary: "did it",
										} satisfies Outcome,
									}),
								)
							: new Promise<RunResult>(() => {}),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		void loop.runTurn(store.name, task.id);
		await flushPromises();
		expect([...loop.running.keys()]).toContain(
			`${store.name}/${task.id}:workcheck`,
		);

		loop.schedule();
		await flushPromises();

		const entry = store.getTask(task.id)!.workCheckLog[0]!;
		expect(entry.outcome).toBe("error");
		expect(entry.blockers).toEqual([]);
		expect(entry.notes).toEqual([]);
		expect(entry.model).toBeNull();
		expect(entry.durationMs).toBe(0);
	});

	// ---- schedule -------------------------------------------------------------------

	test("a schedule step that throws for a project is logged", async () => {
		const { store, loop } = setup({
			hasRules: () => {
				throw new Error("rules unreadable");
			},
		});
		store.createTask("start me");

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("rules unreadable");
	});

	test("an unlimited cap still settles a parked release", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			maxTotalRuns: () => null,
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(1);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	// ---- publishReleaseCard -----------------------------------------------------------

	test("a parked release tags the freshly fetched head with empty notes when none were written", async () => {
		const record = baseRecord();
		const resolves: unknown[][] = [];
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			resolveTarget: async (mainPath: string, fetch?: boolean) => {
				resolves.push([mainPath, fetch]);
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);

		loop.schedule();
		await flushPromises();

		expect(resolves).toEqual([[store.path, true]]);
		expect(record.publishRelease[0]).toMatchObject({ sha: "sha0", notes: "" });
		// No target warning: the card log carries no stray line for it.
		expect(logText(store, task.id).split("\n")).not.toContain("null");
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a parked release passes the finding merges as the publish anchors", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);
		// A finding card the review filed, done and stamped with its merge head.
		const finding = store.createTask("fix the found bug");
		store.updateTask(finding.id, {
			followUpOf: task.id,
			stage: "done",
			state: "idle",
			mergeHead: "shaF",
		});

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(1);
		expect(record.publishRelease[0]).toMatchObject({ findings: ["shaF"] });
	});

	test("a target warning at publish reaches the release card's log", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			resolveTarget: async () => ({
				target: "origin/trunk",
				sha: "sha0",
				warning: "origin/main is gone; tagging origin/trunk",
			}),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);

		loop.schedule();
		await flushPromises();

		expect(logText(store, task.id)).toContain(
			"origin/main is gone; tagging origin/trunk",
		);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a failed review-delta read publishes without the review range", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			archReviewDelta: async () => {
				throw new Error("git log failed");
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(1);
		expect(record.publishRelease[0]).toMatchObject({ archReview: null });
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("Released v4.0.0");
	});

	test("a release command without notes gets an empty notes file, shows its output and holds the card's live slot", async () => {
		const record = baseRecord();
		const handle = {
			pid: 4545,
			done: Promise.resolve(),
			kill: async () => {},
		};
		let key = "";
		let liveEntry: unknown = "unset";
		const { store, projects, loop } = setupWith(record, {
			runReleaseCommand: async (
				o: Parameters<TurnOps["runReleaseCommand"]>[0],
			) => {
				record.runReleaseCommand.push(o);
				o.onSpawn?.(handle);
				// The board's progress and pid views read the card's live entry.
				liveEntry = loop.running.get(key);
				o.log("building assets");
				return "released v4.0.0";
			},
		});
		projects.get(store.name)!.target = "origin/main";
		store.setSettings({ releaseCommand: "bin release" });
		const task = parkedRelease(store);
		key = `${store.name}/${task.id}`;

		loop.schedule();
		await flushPromises();

		expect(record.runReleaseCommand).toHaveLength(1);
		expect(liveEntry).toBe(handle);
		expect(logText(store, task.id)).toContain("| building assets");
		expect(
			readFileSync(join(store.tasksDir, `release-${task.id}.md`), "utf8"),
		).toBe("");
		expect(loop.running.size).toBe(0);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	// ---- settleReviews ------------------------------------------------------------------

	test("a cancelled merge card still marked running does not hold the publish", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);
		const merger = store.createTask("cancelled mid-merge");
		store.updateTask(merger.id, {
			stage: "merging",
			state: "running",
			cancelledAt: Date.now(),
		});

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(1);
		expect(store.getTask(task.id)!.stage).toBe("done");
	});

	test("a merge in preparing holds the publish", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);
		const merger = store.createTask("merge starting");
		store.updateTask(merger.id, { stage: "merging", state: "preparing" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	test("a parked shape in needs_you never publishes", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const task = parkedRelease(store);
		store.updateTask(task.id, { state: "needs_you" });

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
	});

	test("parked releases in two projects both publish in one tick", async () => {
		const record = baseRecord();
		const a = freshStore();
		const b = freshStore();
		const loop = createTurnLoop(
			new Map([
				[a.name, { ...fakeProject(a), target: "origin/main" }],
				[b.name, { ...fakeProject(b), target: "origin/main" }],
			]),
			fakeOps(record, { publishRelease: publishingRelease(record) }),
		);
		const ta = parkedRelease(a, "v5.0.0");
		const tb = parkedRelease(b, "v6.0.0");

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(2);
		expect(a.getTask(ta.id)!.stage).toBe("done");
		expect(b.getTask(tb.id)!.stage).toBe("done");
	});

	test("a Review-button card with a worktree finishes without a publish", async () => {
		const record = baseRecord();
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
		});
		projects.get(store.name)!.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, {
			stage: "merging",
			state: "idle",
			needsReason: FINDINGS_HOLD,
			base: "b",
			worktree: "wt",
		});

		loop.schedule();
		await flushPromises();

		expect(record.publishRelease).toHaveLength(0);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBeNull(); // no "Released …" summary
		expect(after.commits).toBe(3);
	});

	test("a Review-button settle whose commit count fails is logged and stays parked", async () => {
		const { store, projects, loop } = setup({
			targetCommits: async () => {
				throw new Error("rev-list failed");
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, {
			stage: "merging",
			state: "idle",
			needsReason: FINDINGS_HOLD,
			base: "b",
		});

		const seen = await withErrors(() => {
			loop.schedule();
			return flushPromises();
		});

		expect(seen.join("\n")).toContain("rev-list failed");
		expect(store.getTask(review.id)!.stage).toBe("merging");
	});
});

// Round 5, runTurn setup (claim to turn start): every test checks an observable fact —
// a recorded ops call, a store field, a turns row, a log fact or the running card's progress.
describe("turn survivor round 5 — run setup", () => {
	const answeredRun = () => ({
		pid: 4242,
		done: Promise.resolve(
			runResult({ outcome: { status: "answered", summary: "did it" } }),
		),
		kill: async () => {},
	});

	function loopFor(
		store: ProjectStore,
		record: Recorded,
		overrides: Partial<TurnOps>,
	) {
		return createTurnLoop(
			new Map([[store.name, fakeProject(store)]]),
			fakeOps(record, overrides),
		);
	}

	function mergeCard(store: ProjectStore) {
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			base: "sha0",
			worktree: "wt-x",
		});
		return task;
	}

	const noTrackerError = (store: ProjectStore, id: string) =>
		expect(store.getTask(id)!.needsReason ?? "").not.toContain("Tracker error");

	test("resolveTarget fetches fresh only when the card lacks its worktree or branch", async () => {
		const calls: [string, boolean | undefined][] = [];
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			resolveTarget: async (path: string, fresh?: boolean) => {
				calls.push([path, fresh]);
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		const fresh = store.createTask("fresh card");
		const kept = store.createTask("kept card");
		store.updateTask(kept.id, {
			stage: "in_progress",
			worktree: "wt-k",
			branch: "ott/k",
			base: "sha0",
		});
		const noBranch = store.createTask("worktree without branch");
		store.updateTask(noBranch.id, {
			stage: "in_progress",
			worktree: "wt-n",
			base: "sha0",
		});
		const noWorktree = store.createTask("branch without worktree");
		store.updateTask(noWorktree.id, {
			stage: "in_progress",
			branch: "ott/w",
			base: "sha0",
		});
		for (const t of [fresh, kept, noBranch, noWorktree])
			await loop.runTurn(store.name, t.id);
		expect(calls).toEqual([
			[store.path, true],
			[store.path, false],
			[store.path, true],
			[store.path, true],
		]);
	});

	test("a fresh work card's prepare log: turn header, worktree line, no empty warning", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const branch = store.getTask(task.id)!.branch!;
		const log = logText(store, task.id);
		expect(log).toContain("== work turn ");
		expect(log).toContain(`+ worktree ${branch} from origin/main at sha0\n`);
		// resolveTarget's null warning must not leave a "! null" line on the card.
		expect(log).not.toContain("! null");
		// The only card on the board lists no sibling, never itself.
		expect(record.runs[0]!.prompt).toContain(
			"Other tasks in flight for this project:\n- none\n",
		);
	});

	test("the settled turn records its logOffset at the turn header", async () => {
		const { store, loop } = setup();
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const turn = store.listTurns(task.id).at(-1)!;
		const log = logText(store, task.id);
		// The offset points at the turn's own header line in the card log.
		expect(turn.logOffset).not.toBeNull();
		expect(log.slice(turn.logOffset!)).toMatch(/^== (work|merge) turn /);
		// The header was the last line before the turn's own output: the bytes before it
		// are whole earlier lines (or nothing at all — a fresh card's header opens the file).
		const before = log.slice(0, turn.logOffset!);
		expect(before === "" || before.endsWith("\n")).toBe(true);
		expect(before).not.toMatch(/== (work|merge) turn $/);
	});

	test("a resolveTarget warning reaches the card log", async () => {
		const { store, loop } = setup({
			resolveTarget: async () => ({
				target: "origin/main",
				sha: "sha0",
				warning: "fetch failed: offline",
			}),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain("! fetch failed: offline\n");
	});

	test("a merge turn's log names the merge kind", async () => {
		const { store, loop } = setup({ commitsAhead: async () => 0 });
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain("== merge turn ");
	});

	test("prepare names an unnamed card from the generated title and logs it", async () => {
		const { store, record, loop } = setup({
			genTitle: async () => "Fix the header",
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBe("Fix the header");
		expect(logText(store, task.id)).toContain("+ title: Fix the header\n");
	});

	test("a failed title generation logs the fallback and names nothing", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBeNull();
		const log = logText(store, task.id);
		expect(log).toContain("title generation failed");
		expect(log).not.toContain("+ title:");
	});

	test("a failed title generation retries once and the retry names the card", async () => {
		let calls = 0;
		// The test resumes on the retry's generation call, never on a guessed wait.
		const { promise: retried, resolve: sawRetry } =
			Promise.withResolvers<void>();
		// The run stalls, so no later turn's prepare can claim the retry before the timer does.
		const { promise: finishRun, resolve: finish } =
			Promise.withResolvers<RunResult>();
		const { store, record, loop } = setup({
			genTitle: async (_prompt, _spawn, onFail) => {
				calls += 1;
				if (calls === 1) {
					onFail?.("gateway status 502: bad gateway");
					return null;
				}
				sawRetry();
				return "Named on retry";
			},
			startRun: (o) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return { pid: 4242, done: finishRun, kill: async () => {} };
			},
		});
		const task = store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		const key = `${store.name}/${task.id}`;
		for (let i = 0; i < 100 && !loop.running.has(key); i++)
			await flushPromises();
		await retried; // the scheduled retry ran while the stalled run holds the card
		await Promise.resolve(); // let the retry's nameTask land
		expect(calls).toBe(2);
		expect(store.titleHold(task.id)).toBe(false);
		expect(store.frozenTitle(store.getTask(task.id)!)).toBe("Named on retry");
		expect(logText(store, task.id)).toContain(
			"+ title: Named on retry (retry after a failed first attempt)",
		);
		// A later turn never generates again: the one retry is spent.
		finish(runResult({ outcome: { status: "answered", summary: "did it" } }));
		await run;
		await loop.runTurn(store.name, task.id);
		expect(calls).toBe(2);
	});

	test("a failed generation retries at the next turn start, once", async () => {
		let calls = 0;
		const { store, record, loop } = setup({
			genTitle: async (_prompt, _spawn, onFail) => {
				calls += 1;
				if (calls === 1) {
					onFail?.("gateway status 502: bad gateway");
					return null;
				}
				return "Named on turn two";
			},
			// Only a turn start may claim the retry in this test; the timer must not fire first.
			titleRetryDelayMs: 3_600_000,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBeNull();
		// The work turn's write schedules its merge turn on the loop; wait for that prepare:
		// it sees the hold, generates again, and names the card. The log line proves prepare,
		// not the timer, claimed the retry.
		for (
			let i = 0;
			i < 100 && !logText(store, task.id).includes("Named on turn two");
			i++
		)
			await flushPromises();
		expect(logText(store, task.id)).toContain("+ title: Named on turn two\n");
		expect(calls).toBe(2);
		expect(store.titleHold(task.id)).toBe(false);
		expect(store.frozenTitle(store.getTask(task.id)!)).toBe(
			"Named on turn two",
		);
		// A later turn never generates again: the one retry is spent.
		await loop.runTurn(store.name, task.id);
		expect(calls).toBe(2);
	});

	test("a release card keeps its fixed session name and never generates a title", async () => {
		let generated = 0;
		const { store, record, loop } = setup({
			genTitle: async () => {
				generated += 1;
				return "Generated";
			},
		});
		const task = store.createTask("release v1.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-x",
			branch: "ott/rel",
			releaseNotes: "notes body",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBe("Release review");
		expect(generated).toBe(0);
	});

	test("a release version without a frozen base is no release review: it gets a generated title", async () => {
		const { store, record, loop } = setup({
			genTitle: async () => "Generated",
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, { releaseVersion: "v2.0.0" });
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.sessionName).toBe("Generated");
	});

	test("a Review-button review run gets OTTR_REVIEW=1", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);
		expect(record.runs[0]!.env).toEqual({ OTTR_REVIEW: "1" });
	});

	test("a cancel during worktree creation removes exactly that worktree and starts nothing", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		const loop = loopFor(store, record, {
			createWorktree: async (o: { worktreePath: string }) => {
				record.createWorktree.push(o);
				store.updateTask(task.id, { cancelledAt: Date.now() });
			},
		});
		await loop.runTurn(store.name, task.id);
		const branch = store.getTask(task.id)!.branch;
		expect(record.removeWorktree).toEqual([
			{
				mainPath: store.path,
				worktreePath: join(store.worktreesDir, task.id),
				branch,
				log: expect.any(Function),
			},
		]);
		expect(record.runs).toHaveLength(0);
	});

	test("a failed cleanup of a cancelled fresh worktree is logged with its error", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		const loop = loopFor(store, record, {
			createWorktree: async (o: { worktreePath: string }) => {
				record.createWorktree.push(o);
				store.updateTask(task.id, { cancelledAt: Date.now() });
			},
			removeWorktree: async () => {
				throw new Error("worktree busy");
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(logText(store, task.id)).toContain(
			"! removeWorktree: worktree busy\n",
		);
		expect(record.runs).toHaveLength(0);
	});

	test("a failed diff stat skips the capture and the merge turn still runs", async () => {
		const { store, record, loop } = setup({
			diffStat: async () => {
				throw new Error("git gone");
			},
			diffText: async () => "diff text",
		});
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.diffFiles).toBeNull();
		noTrackerError(store, task.id);
	});

	test("a failed raw diff keeps the stat, stores no text, and logs the file count", async () => {
		const { store, record, loop } = setup({
			diffStat: async () => [{ file: "src/a.ts", plus: 2, minus: 1 }],
			diffText: async () => {
				throw new Error("git gone");
			},
		});
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.diffFiles).toEqual([{ file: "src/a.ts", plus: 2, minus: 1 }]);
		expect(after.diffText).toBeNull();
		expect(logText(store, task.id)).toContain("- captured diff: 1 file(s)\n");
		expect(record.runs).toHaveLength(1);
		noTrackerError(store, task.id);
	});

	test("a raw diff over 200 KB is cut at 200 KB with the truncation note", async () => {
		const text = `${"a".repeat(200_000)}b`;
		const { store, loop } = setup({
			diffStat: async () => [{ file: "big.txt", plus: 1, minus: 0 }],
			diffText: async () => text,
		});
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.diffText).toBe(
			`${"a".repeat(200_000)}\n… diff truncated at 200 KB`,
		);
	});

	test("a raw diff of exactly 200 KB is stored whole", async () => {
		const text = "a".repeat(200_000);
		const { store, loop } = setup({
			diffStat: async () => [{ file: "big.txt", plus: 1, minus: 0 }],
			diffText: async () => text,
		});
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.diffText).toBe(text);
	});

	test("a steer that lands during prepare rides this turn's prompt", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		const loop = loopFor(store, record, {
			resolveTarget: async () => {
				store.updateTask(task.id, { pendingPrompt: "use the blue theme" });
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.prompt).toContain(
			"Note from the user: use the blue theme",
		);
	});

	test("a dep-held card whose dependency left the project names it as done", async () => {
		const { store, record, loop } = setup();
		const task = replyCard(store, "work please");
		store.updateTask(task.id, {
			pendingPrompt: DEP_HELD_PROMPT,
			dependsOn: ["OTTR-404"],
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.prompt).toContain("- #OTTR-404 OTTR-404: done");
		noTrackerError(store, task.id);
	});

	test("a reply after the only, rejected turn carries the rejection", async () => {
		const { store, record, loop } = setup();
		const task = replyCard(store, "work please");
		const prior = store.startTurn(task.id, "work", "p", null);
		store.finishTurn(prior.id, {
			endedAt: Date.now(),
			outcome: "ready",
			error: "no commits on the branch",
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.prompt).toContain(
			"The tracker rejected your last report_outcome: no commits on the branch",
		);
	});

	test("a retro reply after the only, rejected turn carries the rejection", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const retro = replyCard(store, `${RETRO_MARKER}the retro`, "retro");
		const prior = store.startTurn(retro.id, "work", "p", null);
		store.finishTurn(prior.id, {
			endedAt: Date.now(),
			outcome: "answered",
			error: "the retro report is empty",
		});
		await loop.runTurn(store.name, retro.id);
		const prompt = record.runs[0]!.prompt;
		expect(prompt).toContain("Continue the retro.");
		expect(prompt).toContain(
			"The tracker rejected your last report_outcome: the retro report is empty",
		);
	});

	test("a reply turn sends only the reply's images, not the original prompt's", async () => {
		const { store, record, loop } = setup();
		const task = replyCard(store, "work please");
		store.updateTask(task.id, {
			images: ["a.png"],
			pendingImages: ["b.png"],
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.images).toEqual([
			join(store.imagesDir(task.id), "b.png"),
		]);
	});

	test("run log and progress events: progress shows only once the run is registered", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		let progress: ((text: string | null) => void) | undefined;
		let logNotes: [string, string][] = [];
		const { promise: gate, resolve: releaseDone } =
			Promise.withResolvers<RunResult>();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = loopFor(store, record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				o.onSession?.("s1");
				progress = o.onProgress;
				markStarted();
				// Before startRun returns there is no running entry: the event shows nothing.
				o.onProgress?.("early");
				const before = record.notifyLog.length;
				o.onLog?.();
				logNotes = record.notifyLog.slice(before);
				return { pid: 4242, done: gate, kill: async () => {} };
			},
		});
		const running = loop.runTurn(store.name, task.id);
		await started;
		const key = `${store.name}/${task.id}`;
		expect(logNotes).toEqual([[store.name, task.id]]);
		expect(loop.running.get(key)?.progress).toBeUndefined();
		const published = record.publishSoon;
		progress?.("Stryker 40%");
		expect(loop.running.get(key)?.progress).toBe("Stryker 40%");
		expect(record.publishSoon).toBe(published + 1);
		progress?.(null);
		expect(loop.running.get(key)?.progress).toBeUndefined();
		expect(record.publishSoon).toBe(published + 2);
		releaseDone(
			runResult({ outcome: { status: "answered", summary: "did it" } }),
		);
		await running;
		noTrackerError(store, task.id);
	});

	test("progressAt moves only when the progress numbers move (OTTR-469)", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		let progress: ((text: string | null) => void) | undefined;
		const { promise: gate, resolve: releaseDone } =
			Promise.withResolvers<RunResult>();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<void>();
		const loop = loopFor(store, record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o as never);
				o.onSession?.("s1");
				progress = o.onProgress;
				markStarted();
				return { pid: 4242, done: gate, kill: async () => {} };
			},
		});
		const running = loop.runTurn(store.name, task.id);
		await started;
		const key = `${store.name}/${task.id}`;
		const stryker = (pct: number, elapsed: string, tested: number): string =>
			`Mutation testing ${pct}% (elapsed: ${elapsed}, remaining: ~1h 23m) ${tested}/6523 tested (38 survived)`;
		// Fake clock: onProgress stamps Date.now(), so the tests pin exact stamps.
		setSystemTime(new Date(1_800_000_000_000));
		try {
			// The first numbered status is a movement: the entry stamps when the meter moved.
			progress?.(stryker(40, "~2h 0m", 2600));
			const firstAt = loop.running.get(key)?.progressAt;
			expect(firstAt).toBe(1_800_000_000_000);
			expect(loop.running.get(key)?.progressKey).toBe("40/2600/6523");
			// Elapsed ticks of a frozen run: the line repeats its numbers, the stamp stays.
			setSystemTime(new Date(1_800_000_000_001));
			progress?.(stryker(40, "~2h 1m", 2600));
			expect(loop.running.get(key)?.progressAt).toBe(firstAt);
			// The tested count moving is a movement: a fresh stamp.
			setSystemTime(new Date(1_800_000_000_500));
			progress?.(stryker(41, "~2h 1m", 2612));
			expect(loop.running.get(key)?.progressAt).toBe(1_800_000_000_500);
			// Text without numbers ends the movement; the stamp keeps the last movement.
			progress?.(null);
			expect(loop.running.get(key)?.progress).toBeUndefined();
			expect(loop.running.get(key)?.progressKey).toBeUndefined();
			expect(loop.running.get(key)?.progressAt).toBe(1_800_000_000_500);
		} finally {
			setSystemTime();
		}
		releaseDone(
			runResult({ outcome: { status: "answered", summary: "did it" } }),
		);
		await running;
		noTrackerError(store, task.id);
	});

	test("a repeated session report while running keeps the first session id", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		let seen: string | null | undefined;
		const loop = loopFor(store, record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("s1");
				o.onSession?.("s2");
				seen = store.getTask(task.id)!.sessionId;
				return answeredRun();
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(seen).toBe("s1");
	});

	test("a session report after a cancel in the spawn window leaves the card untouched", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		let seen: { state: string; sessionId: string | null } | undefined;
		const loop = loopFor(store, record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				store.updateTask(task.id, { cancelledAt: Date.now() });
				o.onSession?.("s1");
				const cur = store.getTask(task.id)!;
				seen = { state: cur.state, sessionId: cur.sessionId };
				return answeredRun();
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(seen).toEqual({ state: "preparing", sessionId: null });
	});

	test("a merge turn's session report never moves the card to in progress", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = mergeCard(store);
		let stage: string | undefined;
		const loop = loopFor(store, record, {
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				// The card sits at todo when the merge session starts.
				store.updateTask(task.id, { stage: "todo" });
				o.onSession?.("s1");
				stage = store.getTask(task.id)!.stage;
				return answeredRun();
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(stage).toBe("todo");
	});

	test("a grill turn's session report keeps the card in the backlog", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("grill me");
		store.updateTask(task.id, { stage: "backlog" });
		let seen: { stage: string; state: string } | undefined;
		const loop = loopFor(store, record, {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("s1");
				const cur = store.getTask(task.id)!;
				seen = { stage: cur.stage, state: cur.state };
				return answeredRun();
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(seen).toEqual({ stage: "backlog", state: "running" });
	});

	test("a steer landing during package install on a card without pending text stays queued", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = store.createTask("work please");
		const loop = loopFor(store, record, {
			maxTotalRuns: () => 0,
			ensurePackages: async () => {
				// The steer text starts with "null": no stale prefix may be stripped from it.
				store.updateTask(task.id, { pendingPrompt: "null check the parser" });
				return [];
			},
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.pendingPrompt).toBe("null check the parser");
		const turns = store.listTurns(task.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.prompt).not.toContain("null check the parser");
		noTrackerError(store, task.id);
	});

	test("a steer cancelled during package install: the turn still starts and records the reply", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = replyCard(store, "work please");
		store.updateTask(task.id, {
			pendingPrompt: "one",
			pendingImages: ["a.png"],
		});
		const loop = loopFor(store, record, {
			maxTotalRuns: () => 0,
			ensurePackages: async () => {
				store.updateTask(task.id, { pendingPrompt: null, pendingImages: [] });
				return [];
			},
		});
		await loop.runTurn(store.name, task.id);
		const turns = store.listTurns(task.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.input).toBe("one");
		expect(store.getTask(task.id)!.pendingPrompt).toBeNull();
		noTrackerError(store, task.id);
	});

	test("pending images that no longer start with the sent ones stay queued", async () => {
		const store = freshStore();
		const record = baseRecord();
		const task = replyCard(store, "work please");
		store.updateTask(task.id, {
			pendingPrompt: "one",
			pendingImages: ["a", "b"],
		});
		const loop = loopFor(store, record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				o.onSession?.("s1");
				store.updateTask(task.id, {
					pendingPrompt: "one\n\ntwo",
					pendingImages: ["a", "c"],
				});
				return answeredRun();
			},
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.pendingPrompt).toBe("two");
		expect(after.pendingImages).toEqual(["a", "c"]);
	});
});

describe("turn survivor round 5 — run result and merge push", () => {
	const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	/** startRun override whose run resolves with runResult(p). */
	function finishing(record: Recorded, p: Partial<RunResult>) {
		return (o: Parameters<TurnOps["startRun"]>[0]) => {
			record.runs.push(o);
			o.onSession?.("sess-1");
			return {
				pid: 4242,
				done: Promise.resolve(runResult(p)),
				kill: async () => {
					record.killed = true;
				},
			};
		};
	}

	/** setupWith plus a run that resolves with runResult(p); chained turns are held. */
	function withRun(p: Partial<RunResult>, overrides: Partial<TurnOps> = {}) {
		const record = baseRecord();
		return setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: finishing(record, p),
			...overrides,
		});
	}

	function mergeCard(store: ProjectStore, worktree = "wt-m") {
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree,
			branch: "ott/m",
		});
		return task;
	}

	function researchCard(store: ProjectStore) {
		const task = store.createTask("research something");
		store.updateTask(task.id, { research: true });
		return task;
	}

	/** createWorktree override that also writes the research report file. */
	function withReport(record: Recorded) {
		return async (o: { worktreePath: string }) => {
			record.createWorktree.push(o);
			mkdirSync(o.worktreePath, { recursive: true });
			writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# findings");
		};
	}

	function workTree(store: ProjectStore, id: string): string {
		const wt = join(store.worktreesDir, id);
		mkdirSync(wt, { recursive: true });
		return wt;
	}

	function lastTurn(store: ProjectStore, id: string) {
		return store.listTurns(id).at(-1)!;
	}

	test("a merge turn never reads a research report left in its worktree", async () => {
		const { store, loop } = withRun({
			outcome: { status: "integrated", summary: "landed" },
		});
		const wt = join(store.worktreesDir, "merge-wt");
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, RESEARCH_REPORT), "# stray notes");
		const task = mergeCard(store, wt);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.research).toBe(false);
		expect(after.report).toBeNull();
	});

	test("a release card with a report file is never flagged research", async () => {
		const { store, loop } = withRun({
			outcome: { status: "answered", summary: "reviewed" },
		});
		const task = store.createTask("release v1.0.0");
		const wt = workTree(store, task.id);
		writeFileSync(join(wt, RESEARCH_REPORT), "# review notes");
		store.updateTask(task.id, {
			stage: "in_progress",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: wt,
			branch: "ott/rel",
		});
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.research).toBe(false);
	});

	test("a plain work card without a report stays a work card: ready goes to merging", async () => {
		const { store, loop } = withRun({
			outcome: { status: "ready", summary: "did it" },
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.research).toBe(false);
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
	});

	test("a research card whose report is still there keeps its mark on a ready report with commits", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			createWorktree: withReport(record),
			startRun: finishing(record, {
				outcome: { status: "ready", summary: "researched" },
			}),
		});
		const task = researchCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.research).toBe(true);
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("1 commit(s)");
	});

	test("a research card without its report keeps its mark on an answered report with commits", async () => {
		const { store, loop } = withRun({
			outcome: { status: "answered", summary: "researched" },
		});
		const task = researchCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.research).toBe(true);
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("1 commit(s)");
	});

	test("a research card's ready report without commits stays research and asks for the report", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "ready", summary: "researched" } },
			{ commitsAhead: async () => 0 },
		);
		const task = researchCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.research).toBe(true);
		expect(after.stage).toBe("in_progress");
		expect(after.needsReason).toContain(RESEARCH_REPORT);
	});

	test("a killed run that no stop request owns leaves the card as the cancel wrote it", async () => {
		const record = baseRecord();
		const held = Promise.withResolvers<RunResult>();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return { pid: 4242, done: held.promise, kill: async () => {} };
			},
		});
		const task = store.createTask("work please");
		const key = `${store.name}/${task.id}`;
		const run = loop.runTurn(store.name, task.id);
		for (let i = 0; i < 100 && !loop.running.has(key); i++)
			await flushPromises();
		expect(loop.running.has(key)).toBe(true);
		// A cancel whose kill wait timed out kept the worktree and handed the card back.
		const kept = cancelKeptReason("uncommitted changes to a.txt");
		store.updateTask(task.id, { state: "needs_you", needsReason: kept });
		held.resolve(runResult({ killed: true, sawTerminalEnd: false }));
		await run;
		expect(lastTurn(store, task.id).error).toBe("cancelled");
		const after = store.getTask(task.id)!;
		expect(after.needsReason).toBe(kept);
		expect(after.cancelledAt).toBeNull();
	});

	test("a cancel that lands during a stop owns the card", async () => {
		const record = baseRecord();
		const held = Promise.withResolvers<RunResult>();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: held.promise,
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		const task = store.createTask("work please");
		const key = `${store.name}/${task.id}`;
		const e = fakeProject(store);
		const run = loop.runTurn(store.name, task.id);
		for (let i = 0; i < 100 && !loop.running.has(key); i++)
			await flushPromises();
		expect(loop.running.has(key)).toBe(true);
		const stop = loop.stopTurn(e, task.id);
		await flushPromises();
		const cancel = loop.cancel(e, task.id, true);
		await flushPromises();
		held.resolve(runResult({ killed: true, sawTerminalEnd: false }));
		await run;
		await expect(stop).resolves.toEqual({ ok: true });
		await expect(cancel).resolves.toEqual({ removed: true });
		expect(lastTurn(store, task.id).error).toBe("stopped");
		const after = store.getTask(task.id)!;
		expect(after.cancelledAt).not.toBeNull();
		expect(after.state).toBe("idle");
		expect(after.needsReason ?? "").not.toContain("Turn stopped");
	});

	test("an interview turn's integrated report is rejected like a work turn's", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "integrated", summary: "rules set" } },
			{
				worktreeHusk: async () => true,
				worktreeLinked: async () => false,
				isIntegrated: async () => false,
				branchMergedOrGone: async () => true,
			},
		);
		const task = store.createTask(
			`${RULES_INTERVIEW_MARKER}${store.name}`,
			null,
			"interview",
		);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// Interviews are question cards: even with the branch proof at hand, an
		// integrated report from a work-kind turn never lands the card.
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("Work turns do not merge; report ready.");
	});

	test("a husk check that fails counts as no husk: the worktree decides integration", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "integrated", summary: "landed" } },
			{
				worktreeHusk: async () => {
					throw new Error("git missing");
				},
				isIntegrated: async () => false,
				branchMergedOrGone: async () => true,
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.needsReason).toBe(
			"Reported integrated, but HEAD is not on origin/main.",
		);
	});

	test("a link check that fails counts as unlinked: the main repo proves integration", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "integrated", summary: "landed" } },
			{
				worktreeLinked: async () => {
					throw new Error("git missing");
				},
				isIntegrated: async () => false,
				branchMergedOrGone: async () => true,
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
	});

	test("a needs_you turn leaves untracked files alone", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: finishing(record, {
				outcome: { status: "needs_you", summary: "stuck", question: "Which?" },
			}),
			quarantineUntracked: async (
				worktreePath: string,
				quarantineDir: string,
			) => {
				record.quarantine.push({ worktreePath, quarantineDir });
				return ["junk.txt"];
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.quarantine).toHaveLength(0);
		expect(logText(store, task.id)).not.toContain("junk.txt");
		expect(store.getTask(task.id)!.state).toBe("needs_you");
	});

	test("an outcome without shots and no shots/ dir adopts nothing and warns about no shot", async () => {
		const { store, loop } = withRun({
			outcome: { status: "ready", summary: "did it" },
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.shots).toEqual([]);
		expect(logText(store, task.id)).not.toContain("! shot");
	});

	test("a non-image under shots/ is skipped and named by its shots/ path", async () => {
		const { store, loop } = withRun({
			outcome: { status: "ready", summary: "did it" },
		});
		const task = store.createTask("work please");
		const wt = workTree(store, task.id);
		mkdirSync(join(wt, "shots"), { recursive: true });
		writeFileSync(join(wt, "shots", "notes.txt"), "not a picture");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.shots).toEqual([]);
		expect(existsSync(store.imagesDir(task.id))).toBe(false);
		expect(logText(store, task.id)).toContain(
			"! shot shots/notes.txt: not a recognized image",
		);
	});

	test("a reported shot outside the worktree is refused", async () => {
		const { store, loop } = withRun({
			outcome: {
				status: "ready",
				summary: "did it",
				shots: ["../escape.png"],
			},
		});
		const task = store.createTask("work please");
		const wt = workTree(store, task.id);
		writeFileSync(join(dirname(wt), "escape.png"), PNG);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.shots).toEqual([]);
		expect(logText(store, task.id)).toContain(
			"! shot ../escape.png: path escapes the worktree — keep the path inside the worktree, for example shots/<name>.png (shots/ is gitignored)",
		);
	});

	test("the card keeps the newest 8 shots", async () => {
		const { store, loop } = withRun({
			outcome: { status: "ready", summary: "did it", shots: ["ui.png"] },
		});
		const task = store.createTask("work please");
		const old = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map(
			(n) => `${n}.png`,
		);
		store.updateTask(task.id, { shots: old });
		const wt = workTree(store, task.id);
		writeFileSync(join(wt, "ui.png"), PNG);
		await loop.runTurn(store.name, task.id);
		const shots = store.getTask(task.id)!.shots;
		expect(shots).toHaveLength(8);
		expect(shots.slice(0, 7)).toEqual(old.slice(1));
		expect(shots[7]).toMatch(/^\d+\.png$/);
	});

	test("a clean turn with nothing untracked writes no quarantine line", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: finishing(record, {
				outcome: { status: "ready", summary: "did it" },
			}),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(record.quarantine).toHaveLength(1);
		expect(logText(store, task.id)).not.toContain("quarantined");
	});

	test("exactly 20 quarantined files are all listed without a truncation mark", async () => {
		const names = Array.from(
			{ length: 20 },
			(_, i) => `f${String(i + 1).padStart(2, "0")}`,
		);
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: finishing(record, {
				outcome: { status: "ready", summary: "did it" },
			}),
			quarantineUntracked: async () => names,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const line = logText(store, task.id)
			.split("\n")
			.find((l) => l.includes("quarantined 20 untracked file(s)"));
		expect(line).toBeDefined();
		expect(line!.endsWith(`${names.join(", ")}`)).toBe(true);
	});

	test("a work turn never takes the server merge push", async () => {
		const pushes: string[] = [];
		const { store, loop } = withRun(
			{ outcome: { status: "ready", summary: "did it" } },
			{
				serverMergePush: async (_m: string, _w: string, target: string) => {
					pushes.push(target);
					return { status: "failed" as const, error: "fatal: denied" };
				},
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBeNull();
		expect(pushes).toEqual([]);
	});

	test("a server push that throws keeps the merge card with git's reason", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "integrated", summary: "landed" } },
			{
				serverMergePush: async () => {
					throw new Error("ssh: connect refused");
				},
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Server push to origin failed: ssh: connect refused",
		);
		expect(logText(store, task.id)).toContain(
			"server push of origin/main failed: ssh: connect refused",
		);
	});

	test("a skipped server push neither logs a push nor resolves an auth failure", async () => {
		const { store, loop } = withRun({
			outcome: {
				status: "needs_you",
				summary: "push blocked",
				details: "fatal: Authentication failed for 'https://h/r.git/'",
			},
		});
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(lastTurn(store, task.id).outcome).toBe("needs_you");
		expect(logText(store, task.id)).not.toContain("from the server");
	});

	test("an auth failure named only in the summary resolves once the server pushed", async () => {
		let pushed = false;
		const { store, loop } = withRun(
			{
				outcome: {
					status: "needs_you",
					summary: "fatal: Authentication failed for origin",
				},
			},
			{
				isIntegrated: async () => pushed,
				serverMergePush: async () => {
					pushed = true;
					return { status: "pushed" as const, output: "" };
				},
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
		const turn = lastTurn(store, task.id);
		expect(turn.outcome).toBe("integrated");
		expect(
			turn.details!.startsWith("fatal: Authentication failed for origin"),
		).toBe(true);
		expect(turn.details).toContain("Server push of origin/main:\n(no output)");
		expect(logText(store, task.id)).toContain(
			"needs_you on a push authentication failure resolved",
		);
	});

	test("an auth failure named only in the question resolves and keeps the agent's details", async () => {
		let pushed = false;
		const { store, loop } = withRun(
			{
				outcome: {
					status: "needs_you",
					summary: "push blocked",
					details: "the remote said no",
					question: "git: Permission denied (publickey). Can you push?",
				},
			},
			{
				isIntegrated: async () => pushed,
				serverMergePush: async () => {
					pushed = true;
					return { status: "pushed" as const, output: "main -> main" };
				},
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.stage).toBe("done");
		const turn = lastTurn(store, task.id);
		expect(turn.outcome).toBe("integrated");
		expect(turn.details!.startsWith("the remote said no")).toBe(true);
		expect(turn.details).toContain("main -> main");
	});

	test("a merge turn without an outcome still takes the server push and lands from git", async () => {
		const { store, loop } = withRun(
			{ outcome: null },
			{
				serverMergePush: async () => ({
					status: "pushed" as const,
					output: "main -> main",
				}),
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(logText(store, task.id)).toContain(
			"pushed origin/main from the server",
		);
	});

	test("an answered merge report naming an auth failure is not rewritten by the push", async () => {
		const { store, loop } = withRun(
			{
				outcome: {
					status: "answered",
					summary: "Authentication failed, but merged locally",
				},
			},
			{
				serverMergePush: async () => ({
					status: "pushed" as const,
					output: "",
				}),
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.needsReason).toBe(
			'Unexpected outcome "answered" in a merge turn.',
		);
		expect(lastTurn(store, task.id).outcome).toBe("answered");
	});

	test("a husk work card's ready report names no uncommitted changes", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "ready", summary: "did it" } },
			{
				worktreeHusk: async () => true,
				branchMergedOrGone: async () => false,
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.needsReason).toBe(
			"Reported ready, but git shows 0 commit(s) ahead of the base.",
		);
	});

	test("a tree whose clean check fails counts as dirty", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "ready", summary: "did it" } },
			{
				isClean: async () => {
					throw new Error("git status failed");
				},
			},
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.needsReason).toBe(
			"Reported ready, but git shows 1 commit(s) ahead of the base and uncommitted changes.",
		);
	});

	test("a husk merge whose branch proof fails is not integrated", async () => {
		// The worktree dies during the run: the first husk read is OTTR-341's dispatch
		// guard (alive), the settle's later reads see the husk and read the main repo.
		let huskReads = 0;
		const { store, loop } = withRun(
			{ outcome: { status: "integrated", summary: "landed" } },
			{
				worktreeHusk: async () => huskReads++ > 0,
				branchMergedOrGone: async () => {
					throw new Error("git missing");
				},
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.needsReason).toBe(
			"worktree link lost and branch has unreached commits",
		);
	});

	test("a merge whose integration check fails is not integrated", async () => {
		const { store, loop } = withRun(
			{ outcome: { status: "integrated", summary: "landed" } },
			{
				isIntegrated: async () => {
					throw new Error("git missing");
				},
			},
		);
		const task = mergeCard(store);
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.needsReason).toBe(
			"Reported integrated, but HEAD is not on origin/main.",
		);
	});
});

describe("turn survivor round 5 — classify wiring", () => {
	/** startRun override resolving every run with `p` (session announced unless p says otherwise). */
	const runWith =
		(record: Recorded, p: Partial<RunResult>, during?: () => void) =>
		(o: Parameters<TurnOps["startRun"]>[0]) => {
			record.runs.push(o);
			if (p.sessionId !== null) o.onSession?.("sess-1");
			during?.();
			return {
				pid: 4242,
				done: Promise.resolve(runResult(p)),
				kill: async () => {},
			};
		};
	/** The provider-rejection shape: died before any output, no session, no stderr. */
	const diedBeforeOutput: Partial<RunResult> = {
		exitCode: 1,
		sessionId: null,
		sawTerminalEnd: false,
		finalText: "",
	};
	const NO_REPORT = "The agent finished without calling report_outcome.";

	test("a research card without its report file and no receipt asks for the receipt", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: runWith(record, {}),
		});
		const task = store.createTask("research please");
		store.updateTask(task.id, { research: true });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// No report file: classify must not take the report-present done rule.
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(NO_REPORT);
	});

	test("a husk worktree keeps a non-integrated reason that is not the integrated bounce", async () => {
		const record = baseRecord();
		// The worktree dies during the run: alive at dispatch (OTTR-341 never dispatches
		// into a husk), a husk by the settle, so classify reads its facts from the main repo.
		let husked = false;
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			worktreeHusk: async () => husked,
			branchMergedOrGone: async () => false,
			startRun: runWith(record, {}, () => {
				husked = true;
			}),
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, { branch: "ott/husk", worktree: "wt-husk" });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(NO_REPORT);
	});

	test("a husk worktree with an answered report and an unmerged branch settles done", async () => {
		const record = baseRecord();
		// Same mid-run removal: alive at dispatch, a husk at the settle.
		let husked = false;
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			worktreeHusk: async () => husked,
			branchMergedOrGone: async () => false,
			startRun: runWith(
				record,
				{ outcome: { status: "answered", summary: "did it" } },
				() => {
					husked = true;
				},
			),
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, { branch: "ott/husk", worktree: "wt-husk" });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// answered with 0 commits ahead (the husk reads 0) is done; the null reason must not crash.
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
	});

	test("a needs_you reason that mentions a dispatch is not copied into the run log", async () => {
		const reason = "Blocked on infra (dispatch q7) for now";
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: runWith(record, {
				outcome: { status: "needs_you", summary: "s", question: reason },
			}),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.needsReason).toBe(reason);
		expect(logText(store, task.id)).not.toContain(reason);
	});

	test("an exit without dispatch context is not copied into the run log", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: runWith(record, { exitCode: 1 }),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const reason = "omp exited with code 1 before finishing.";
		expect(store.getTask(task.id)!.needsReason).toBe(reason);
		expect(logText(store, task.id)).not.toContain(reason);
	});

	test("image quarantine keeps the card's images it did not move", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: runWith(record, diedBeforeOutput),
		});
		const task = store.createTask("work please");
		setImage(store, task.id, "a.png", "bytes-a");
		setImage(store, task.id, "b.png", "bytes-b");
		// gone.png has no file: nothing moves for it, so it stays on the card.
		store.updateTask(task.id, { images: ["a.png", "gone.png", "b.png"] });
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.images).toEqual(["gone.png"]);
		const line = logText(store, task.id)
			.split("\n")
			.find((l) => l.includes("provider rejected the attached images"));
		expect(line).toContain(
			`quarantined 2 image(s) to .tasks/quarantine/${task.id}: a.png, b.png — `,
		);
	});

	test("the image quarantine note lists at most 20 names", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: runWith(record, diedBeforeOutput),
		});
		const task = store.createTask("work please");
		const names = Array.from(
			{ length: 21 },
			(_, i) => `img${String(i + 1).padStart(2, "0")}.png`,
		);
		for (const n of names) setImage(store, task.id, n, n);
		store.updateTask(task.id, { images: names });
		await loop.runTurn(store.name, task.id);
		const line = logText(store, task.id)
			.split("\n")
			.find((l) => l.includes("provider rejected the attached images"));
		expect(line).toContain(
			`quarantined 21 image(s) to .tasks/quarantine/${task.id}: ${names.slice(0, 20).join(", ")} — `,
		);
		expect(line).not.toContain("img21.png");
	});

	test("a merge reply whose image quarantine fails parks at merging", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: runWith(record, diedBeforeOutput),
		});
		const task = store.createTask("merge please");
		saveSession(store, "s9");
		setImage(store, task.id, "1.png", "rejected-bytes");
		// A file where the quarantine dir must be: the move fails.
		mkdirSync(join(store.tasksDir, "quarantine"), { recursive: true });
		writeFileSync(join(store.tasksDir, "quarantine", task.id), "blocked");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			worktree: "wt-x",
			sessionId: "s9",
			pendingPrompt: "see the shot",
			pendingImages: ["1.png"],
		});
		await loop.runTurn(store.name, task.id);
		expect(record.runs[0]!.images).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toMatch(/^Image quarantine failed: /);
	});

	test("steering on a merge turn requeues it at merging", async () => {
		const record = baseRecord();
		let id = "";
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: runWith(
				record,
				{ outcome: { status: "integrated", summary: "merged" } },
				() => store.updateTask(id, { pendingPrompt: "steer mid-run" }),
			),
		});
		const task = store.createTask("merge please");
		id = task.id;
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			worktree: "wt-x",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe("steer mid-run");
	});

	test("an empty reported dependsOn is no hold: needs_you stays needs_you", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: runWith(record, {
				outcome: {
					status: "needs_you",
					summary: "stuck",
					question: "which db?",
					dependsOn: [],
				},
			}),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("which db?");
		expect(after.pendingPrompt).toBeNull();
	});

	test("a bad dependsOn id gets the reason for its own kind of mistake", async () => {
		let deps: string[] = [];
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) =>
				runWith(record, {
					outcome: { status: "needs_you", summary: "hold", dependsOn: deps },
				})(o),
		});
		const self = store.createTask("self hold");
		deps = [self.id];
		await loop.runTurn(store.name, self.id);
		expect(store.getTask(self.id)!.needsReason).toBe(
			`report_outcome's dependsOn names #${self.id}, which is this card itself. Reply to continue, or cancel the card.`,
		);

		const other = store.createTask("unknown hold");
		deps = ["nope"];
		await loop.runTurn(store.name, other.id);
		expect(store.getTask(other.id)!.needsReason).toBe(
			"report_outcome's dependsOn names #nope, which is not a card in this project. Reply to continue, or cancel the card.",
		);
	});

	test("a reported hold rewrites a stored dependsOn that holds a duplicate", async () => {
		let depId = "";
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) =>
				runWith(record, {
					outcome: { status: "needs_you", summary: "hold", dependsOn: [depId] },
				})(o),
		});
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("work please");
		store.updateTask(task.id, { dependsOn: [dep.id, dep.id] });
		await loop.runTurn(store.name, task.id);
		expect(store.getTask(task.id)!.dependsOn).toEqual([dep.id]);
	});

	test("a reported hold on a non-needs_you outcome records the ids but never requeues", async () => {
		let depId = "";
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			isIntegrated: async () => false,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) =>
				runWith(record, {
					outcome: { status: "ready", summary: "done", dependsOn: [depId] },
				})(o),
		});
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.dependsOn).toEqual([dep.id]);
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Reported ready, but git shows 0 commit(s) ahead of the base.",
		);
		expect(after.pendingPrompt).toBeNull();
	});

	test("a reported hold never replaces mid-run steering", async () => {
		let depId = "";
		let id = "";
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) =>
				runWith(
					record,
					{
						outcome: {
							status: "needs_you",
							summary: "hold",
							dependsOn: [depId],
						},
					},
					() => store.updateTask(id, { pendingPrompt: "steer mid-run" }),
				)(o),
		});
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("work please");
		id = task.id;
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe("steer mid-run");
		expect(after.needsReason).toBeNull();
	});

	test("a reported hold with an open ask keeps the question", async () => {
		let depId = "";
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) =>
				runWith(record, {
					outcome: { status: "needs_you", summary: "hold", dependsOn: [depId] },
					asked: [
						{ question: "pick one?", choices: [{ label: "a" }] },
					] as never,
				})(o),
		});
		const dep = store.createTask("the blocker");
		depId = dep.id;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("Wants your answer: pick one?");
		expect(after.dependsOn).toEqual([dep.id]);
	});

	test("a non-review card with recorded findings still lands done", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
	});

	test("a review that parks needs_you is not held for its recorded findings", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			// Check off: the parked card's assertions stay about the park, not the check.
			reviewCheck: () => false,
			startRun: runWith(record, {
				outcome: { status: "needs_you", summary: "s", question: "scope?" },
				recorded: record.recorded,
			}),
		});
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("scope?");
	});

	test("a plain review landing done never calls the release publish", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			publishRelease: publishingRelease(record),
		});
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
		expect(record.publishRelease).toHaveLength(0);
	});

	test("a merge turn with UI files in its diff never asks for a screenshot", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			changedFiles: async () => ["src/ui/app.tsx"],
			startRun: integratedRun(record),
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			branch: "ott/x",
			worktree: "wt-x",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.pendingPrompt).toBeNull();
		expect(logText(store, task.id)).not.toContain(UI_SHOT_WARNING);
	});
});

// Survivor round 5 (2026-10-25), slice F: runTurn's finish (report archive, unsaved
// check, U7 and fork holds, finishTurn, work-check gate, final write, retro proposal).
describe("turn survivor round 5 — run finish", () => {
	// A startRun fake that resolves `done` with `r`; `during` runs while the agent is live
	// (a mid-run steer lands there, as POST /steer does).
	const runReturning =
		(record: Recorded, r: Partial<RunResult>, during?: () => void) =>
		(o: Parameters<TurnOps["startRun"]>[0]) => {
			record.runs.push(o);
			o.onSession?.("sess-1");
			during?.();
			return {
				pid: 4242,
				done: Promise.resolve(runResult(r)),
				kill: async () => {},
			};
		};
	const askOutcome = (question: string): Partial<RunResult> => ({
		outcome: { status: "needs_you", summary: "blocked", question },
	});
	const forkChild = (store: ProjectStore, prompt: string) => {
		const parent = store.createTask("fork research: weekly digest");
		store.updateTask(parent.id, {
			topic: "fork research",
			research: true,
			stage: "done",
			state: "idle",
		});
		const task = store.createTask(prompt);
		store.updateTask(task.id, { followUpOf: parent.id });
		return task;
	};
	const kidsOf = (store: ProjectStore, id: string) =>
		store.listTasks().filter((t) => t.followUpOf === id);

	test("a steered research turn keeps the archived report until the turn settles", async () => {
		const record = baseRecord();
		let taskId = "";
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			createWorktree: async (o: { worktreePath: string }) => {
				record.createWorktree.push(o);
				mkdirSync(o.worktreePath, { recursive: true });
				writeFileSync(join(o.worktreePath, RESEARCH_REPORT), "# half-written");
			},
			startRun: runReturning(record, {}, () =>
				store.updateTask(taskId, { pendingPrompt: "also cover pricing" }),
			),
		});
		const task = store.createTask("research something");
		taskId = task.id;
		store.updateTask(task.id, { research: true, report: "# first answer" });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.report).toBe("# first answer");
	});

	test("unsaved work on a finished work card keeps it in progress, not merging", async () => {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			unsavedWork: async () => "uncommitted changes",
			statusFiles: async () => ["src/a.ts"],
		});
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(keptReason("uncommitted changes"));
		expect(after.keptFiles).toEqual(["src/a.ts"]);
		expect(record.removeWorktree).toHaveLength(0);
	});

	test("the update-merge hold never stalls a merge turn that integrated", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: integratedRun(record),
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, { stage: "merging", updateIds: ["a@1"] });
		store.setSettings({ holdUpdateMerges: true });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("the update-merge hold keeps an update card's own question", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: runReturning(record, askOutcome("pin a@2 or a@3?")),
		});
		const task = store.createTask("update pins");
		store.updateTask(task.id, { updateIds: ["a@1"] });
		store.setSettings({ holdUpdateMerges: true });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("pin a@2 or a@3?");
	});

	test("the fork hold never stalls a fork-born card's merge turn that integrated", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: integratedRun(record),
		});
		const task = forkChild(store, "adopt fork idea");
		store.updateTask(task.id, { stage: "merging" });

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("the fork hold keeps a fork-born card's own question", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			startRun: runReturning(record, askOutcome("which digest day?")),
		});
		const task = forkChild(store, "adopt fork idea");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.needsReason).toBe("which digest day?");
	});

	test("a fork-born card with commits to merge parks for approval instead of merging", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			startRun: runReturning(record, {
				outcome: { status: "ready", summary: "did it" },
			}),
		});
		const task = forkChild(store, "adopt fork idea");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(FORK_HOLD_REASON);
		expect(after.commits).toBeNull();
	});

	test("an empty ask list records no question and the card settles normally", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: runReturning(record, {
				asked: [],
				outcome: { status: "answered", summary: "did it" },
			}),
		});
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.needsReason).toBeNull();
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.question).toBeNull();
		expect(turn.error).toBeNull();
	});

	test("a merge card parked at merging never gets the work check", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			workCheck: () => true,
			startRun: runReturning(record, askOutcome("force-push the tag?")),
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, { stage: "merging" });

		await loop.runTurn(store.name, task.id);

		// Only the merge run itself: no second-model check run started.
		expect(record.runs).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("force-push the tag?");
		expect(after.workCheckLog).toHaveLength(0);
	});

	test("a steered turn re-enters the queue with a fresh queuedAt", async () => {
		const record = baseRecord();
		let taskId = "";
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			startRun: runReturning(record, {}, () =>
				store.updateTask(taskId, { pendingPrompt: "also fix the docs" }),
			),
		});
		const task = store.createTask("work please");
		taskId = task.id;
		store.updateTask(task.id, { queuedAt: 5 });
		const t0 = Date.now();

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.queuedAt).toBeGreaterThanOrEqual(t0);
	});

	test("a done work card shows the run's own summary", async () => {
		const { store, loop } = setup({ commitsAhead: async () => 0 });
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.summary).toBe("did it");
	});

	test("a release card bounced to needs_you keeps the run summary, not Released", async () => {
		const { store, loop } = setup({ isIntegrated: async () => false });
		const task = store.createTask("release v1.0.0");
		store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-x",
			branch: "ott/rel",
			releaseNotes: "notes body",
		});

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.summary).toBe("did it");
	});

	test("a plain work card's proposal is never filed as a card", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		record.proposal = {
			prompt: "not a retro idea",
			model: null,
			summary: null,
		};
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.stage).toBe("done");
		expect(store.listTasks()).toHaveLength(1);
	});

	test("a done retro without a proposal settles done and files nothing", async () => {
		const { store, loop } = setup({ commitsAhead: async () => 0 });
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");

		await loop.runTurn(store.name, retro.id);

		const after = store.getTask(retro.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		expect(store.listTasks()).toHaveLength(1);
	});

	test("a retro that ends on a question files no proposal", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			startRun: runReturning(record, {
				...askOutcome("which week?"),
				proposed: { prompt: "premature idea", model: null, summary: null },
			}),
		});
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");

		await loop.runTurn(store.name, retro.id);

		const after = store.getTask(retro.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("which week?");
		expect(kidsOf(store, retro.id)).toHaveLength(0);
	});

	test("proposals that are no longer held do not count against the cap", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");
		for (let i = 0; i < 3; i++) {
			const p = store.createTask(`proposal ${i}`);
			store.updateTask(p.id, {
				state: "idle",
				needsReason: `${PROPOSED_REASON_PREFIX}an older retro.`,
			});
		}
		record.proposal = {
			prompt: "fits under the cap",
			model: null,
			summary: null,
		};

		await loop.runTurn(store.name, retro.id);

		const kids = kidsOf(store, retro.id);
		expect(kids).toHaveLength(1);
		expect(kids[0]!.prompt).toContain("fits under the cap");
	});

	test("held proposals that already ran a turn do not count against the cap", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");
		for (let i = 0; i < 3; i++) {
			const p = store.createTask(`proposal ${i}`);
			store.updateTask(p.id, {
				state: "needs_you",
				needsReason: `${PROPOSED_REASON_PREFIX}an older retro.`,
			});
			const t = store.startTurn(p.id, "work", "p", null);
			store.finishTurn(t.id, { endedAt: Date.now() });
		}
		record.proposal = {
			prompt: "fits under the cap",
			model: null,
			summary: null,
		};

		await loop.runTurn(store.name, retro.id);

		const kids = kidsOf(store, retro.id);
		expect(kids).toHaveLength(1);
		expect(kids[0]!.prompt).toContain("fits under the cap");
	});

	test("a proposal filed when the handoffs folder already exists still gets its handoff", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		mkdirSync(join(store.tasksDir, "handoffs"), { recursive: true });
		record.proposal = { prompt: "second idea", model: null, summary: null };
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");

		await loop.runTurn(store.name, retro.id);

		const kid = kidsOf(store, retro.id)[0]!;
		const handoffPath = join(store.tasksDir, "handoffs", `${kid.id}.md`);
		expect(kid.prompt).toContain(`@${handoffPath}`);
		expect(existsSync(handoffPath)).toBe(true);
	});

	test("the proposal handoff describes the settled retro: its summary and session", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		record.proposal = { prompt: "an idea", model: null, summary: null };
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");

		await loop.runTurn(store.name, retro.id);

		const kid = kidsOf(store, retro.id)[0]!;
		const handoff = readFileSync(
			join(store.tasksDir, "handoffs", `${kid.id}.md`),
			"utf8",
		);
		expect(handoff).toContain("did it");
		expect(handoff).toContain("`sess-1`");
	});

	test("a failed handoff write files the proposal with its bare prompt and logs why", async () => {
		const { store, record, loop } = setup({ commitsAhead: async () => 0 });
		mkdirSync(store.tasksDir, { recursive: true });
		// A plain file where the handoffs folder belongs: mkdir fails.
		writeFileSync(join(store.tasksDir, "handoffs"), "not a folder");
		record.proposal = { prompt: "bare idea", model: null, summary: null };
		const retro = store.createTask(`${RETRO_MARKER}the retro`, null, "retro");

		await loop.runTurn(store.name, retro.id);

		const kid = kidsOf(store, retro.id)[0]!;
		expect(kid.prompt).toBe("bare idea");
		expect(kid.state).toBe("needs_you");
		expect(logText(store, retro.id)).toContain("handoff write failed");
	});
});

describe("turn survivor round 5 — post-finish branch", () => {
	type StartOpts = Parameters<TurnOps["startRun"]>[0];
	type CheckStep = RunResult | ((o: StartOpts) => RunResult);
	const finding = (
		prompt: string,
		rank: number | null = null,
		security: "critical" | "high" | null = null,
	): RecordedFinding => ({ prompt, model: null, rank, security });
	const reviewCard = (store: ProjectStore) => {
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		return review;
	};
	const verdicts = (...v: [number, boolean, string][]) =>
		runResult({
			finalText: JSON.stringify(
				v.map(([id, keep, reason]) => ({ id, keep, reason })),
			),
		});
	/** The first run is the review (its result patched by `review`); every later run is a check
	 * served from `checks` in order. Cap 0: filed cards never start mid-assertion. */
	function reviewSetup(
		record: Recorded,
		review: Partial<RunResult>,
		checks: CheckStep[],
		overrides: Partial<TurnOps> = {},
	) {
		const checkRuns: StartOpts[] = [];
		const s = setupWith(record, {
			commitsAhead: async () => 0,
			maxTotalRuns: () => 0,
			startRun: (o: StartOpts) => {
				record.runs.push(o);
				o.onSession?.("sess");
				let result: RunResult;
				if (record.runs.length === 1)
					result = runResult({
						outcome: { status: "answered", summary: "review done" },
						recorded: record.recorded,
						...review,
					});
				else {
					checkRuns.push(o);
					const step = checks.shift() ?? runResult({ finalText: "[]" });
					result = typeof step === "function" ? step(o) : step;
				}
				return {
					pid: 4242,
					done: Promise.resolve(result),
					kill: async () => {},
				};
			},
			...overrides,
		});
		return { ...s, checkRuns };
	}
	const kidsOf = (store: ProjectStore, id: string) =>
		store.listTasks().filter((t) => t.followUpOf === id);
	/** Freezes Date.now so a check run can advance it by a known amount. */
	async function withClock(
		fn: (advance: (ms: number) => void) => Promise<void>,
	) {
		const realNow = Date.now;
		let now = realNow();
		Date.now = () => now;
		try {
			await fn((ms) => {
				now += ms;
			});
		} finally {
			Date.now = realNow;
		}
	}

	test("a review that reports needs_you with one recorded finding files one card and stays needs_you", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop, checkRuns } = reviewSetup(
			record,
			{
				outcome: {
					status: "needs_you",
					summary: "need input",
					question: "which branch?",
				},
			},
			[verdicts([1, true, ""])],
		);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(2); // review + the findings check
		expect(checkRuns).toHaveLength(1);
		const kids = kidsOf(store, review.id);
		expect(kids.map((k) => k.prompt)).toEqual(["Bug A"]);
		const after = store.getTask(review.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe("which branch?");
		expect(after.summary).toContain("need input");
	});

	test("a second turn that records the same finding files no duplicate", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const park = {
			outcome: {
				status: "needs_you" as const,
				summary: "need input",
				question: "which branch?",
			},
		};
		// The harness serves the review result only on the first run, so the second
		// turn's review run arrives through the checks queue. Its own check must never
		// run: the already-linked finding is skipped, so the queue ends there.
		const { store, loop } = reviewSetup(record, park, [
			verdicts([1, true, ""]),
			runResult({ ...park, recorded: [finding("Bug A", 1)] }),
		]);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		store.updateTask(review.id, { state: "queued" });
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(3); // review + check + second review, no second check
		const kids = kidsOf(store, review.id);
		expect(kids.map((k) => k.prompt)).toEqual(["Bug A"]);
		expect(store.getTask(review.id)!.state).toBe("needs_you");
	});

	test("a review that records no findings runs no check and settles done", async () => {
		const record = baseRecord();
		const { store, loop } = reviewSetup(record, {}, []);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(1);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.summary).toBe("review done");
	});

	test("the check input lists only the other live cards, numbers findings from 1 and keeps their security", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1, "high"), finding("Bug B", 2)];
		let logPings: [string, string][] = [];
		const { store, loop, checkRuns } = reviewSetup(record, {}, [
			(o) => {
				const before = record.notifyLog.length;
				o.onLog?.();
				logPings = record.notifyLog.slice(before);
				return verdicts([1, true, ""], [2, true, ""]);
			},
		]);
		const review = reviewCard(store);
		const open = store.createTask("Open sibling card");
		const cancelled = store.createTask("Cancelled sibling card");
		store.updateTask(cancelled.id, { cancelledAt: Date.now() });
		const finished = store.createTask("Finished sibling card");
		store.updateTask(finished.id, { stage: "done" });
		await loop.runTurn(store.name, review.id);
		expect(checkRuns).toHaveLength(1);
		const check = checkRuns[0]!;
		const cards = check.prompt
			.split("Open cards of the project:\n")[1]!
			.split("\n\nCommits on main")[0]!;
		expect(cards).toBe(`- #${open.id} ${store.getTask(open.id)!.title}`);
		const findings = JSON.parse(
			check.prompt
				.split("Findings:\n")[1]!
				.split("\n\nOpen cards of the project:")[0]!,
		) as { id: number; security: string; prompt: string }[];
		expect(findings.map((f) => [f.id, f.prompt, f.security])).toEqual([
			[1, "Bug A", "high"],
			[2, "Bug B", ""],
		]);
		expect(check.maxTime).toBe("1800");
		// The check's transcript lines notify the review card's log viewers.
		expect(logPings).toEqual([[store.name, review.id]]);
		expect(
			kidsOf(store, review.id)
				.map((k) => k.prompt)
				.sort(),
		).toEqual(["Bug A", "Bug B"]);
	});

	test("with the check off: long heads cut at 120, below-cap lines and counts on the card", async () => {
		const record = baseRecord();
		const long = `${"L".repeat(130)}\nbody of the long finding`;
		record.recorded = [
			...Array.from({ length: 10 }, (_, i) => finding(`Bug ${i + 1}`, i + 1)),
			finding("Bug 11", 11),
			finding(long, 12),
		];
		const { store, loop } = reviewSetup(
			record,
			{
				outcome: {
					status: "answered",
					summary: "review done",
					details: "Review body",
				},
			},
			[],
			{ reviewCheck: () => false },
		);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(1);
		const after = store.getTask(review.id)!;
		const cut = "L".repeat(120);
		expect(after.summary).toBe(
			"review done\nFindings: 12 recorded, 10 filed, 2 not filed.",
		);
		expect(after.details!.startsWith("Review body\n\n## Findings\n")).toBe(
			true,
		);
		expect(after.details).toMatch(/- filed as card #\S+\n- filed as card #/);
		expect(after.details).toContain(
			`- below the cap of 10: Bug 11\n- below the cap of 10: ${cut}`,
		);
		expect(after.details).not.toContain("L".repeat(121));
		const log = logText(store, review.id);
		expect(log).toContain("below the cap of 10, not filed: Bug 11");
		expect(log).toContain(`below the cap of 10, not filed: ${cut}\n`);
		expect(log).toContain(
			"review findings: 12 recorded, 10 filed, 2 not filed, check off",
		);
	});

	test("a check that drops every finding: reasons, counts and the check time land in log and card", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1), finding("Bug B", 2)];
		await withClock(async (advance) => {
			const { store, loop } = reviewSetup(record, {}, [
				() => {
					advance(4000);
					return verdicts(
						[1, false, "dup of #7"],
						[2, false, "handled at src/x.ts:42"],
					);
				},
			]);
			const review = reviewCard(store);
			await loop.runTurn(store.name, review.id);
			expect(kidsOf(store, review.id)).toEqual([]);
			const after = store.getTask(review.id)!;
			expect(after.summary).toBe(
				"review done\nFindings: 2 recorded, 0 filed, 2 not filed (check 4s on fake/default-model).",
			);
			expect(after.details).toContain(
				"## Findings\n- none filed\n- dropped: Bug A — dup of #7\n- dropped: Bug B — handled at src/x.ts:42",
			);
			const log = logText(store, review.id);
			expect(log).toContain("dropped finding 1: dup of #7");
			expect(log).toContain("dropped finding 2: handled at src/x.ts:42");
			expect(log).toContain(
				"review findings: 2 recorded, 0 filed, 2 not filed, check 4s",
			);
		});
	});

	test("a failed check run is retried even when its final text holds verdicts", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop } = reviewSetup(record, {}, [
			runResult({
				exitCode: 1,
				stderrTail: "boom\n",
				finalText: '[{"id":1,"keep":true,"reason":""}]',
			}),
			verdicts([1, false, "stale finding"]),
		]);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(3);
		expect(kidsOf(store, review.id)).toEqual([]);
		expect(store.getTask(review.id)!.details).toContain("stale finding");
		expect(logText(store, review.id)).toContain(
			"attempt 1 failed: the check run exited with code 1: boom",
		);
	});

	test("a check without a JSON verdict twice parks the review with that reason and writes no findings report", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop } = reviewSetup(record, {}, [
			runResult({ finalText: "no verdict here" }),
			runResult({ finalText: "still no verdict" }),
		]);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(3);
		expect(kidsOf(store, review.id)).toEqual([]);
		const after = store.getTask(review.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(
			"failed twice: the check verdict was not valid JSON",
		);
		expect(after.summary).toBe("review done");
		expect(after.details ?? "").not.toContain("## Findings");
		const log = logText(store, review.id);
		expect(log).toContain(
			"attempt 1 failed: the check verdict was not valid JSON",
		);
		expect(log).toContain(
			"attempt 2 failed: the check verdict was not valid JSON",
		);
		expect(log).toContain(
			"gave up after a retry: the check verdict was not valid JSON",
		);
	});

	test("a review cancelled during a failing check is not parked needs_you", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		let reviewId = "";
		const { store, loop } = reviewSetup(record, {}, [
			runResult({ finalText: "no verdict here" }),
			() => {
				store.updateTask(reviewId, { cancelledAt: Date.now() });
				return runResult({ finalText: "still no verdict" });
			},
		]);
		const review = reviewCard(store);
		reviewId = review.id;
		await loop.runTurn(store.name, review.id);
		expect(record.runs).toHaveLength(3);
		const after = store.getTask(review.id)!;
		expect(after.needsReason ?? "").not.toContain("failed twice");
		expect(after.state).not.toBe("needs_you");
	});

	test("a review cancelled during a passing check files nothing and gets no findings report", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		let reviewId = "";
		const { store, loop } = reviewSetup(record, {}, [
			() => {
				store.updateTask(reviewId, { cancelledAt: Date.now() });
				return verdicts([1, true, ""]);
			},
		]);
		const review = reviewCard(store);
		reviewId = review.id;
		await loop.runTurn(store.name, review.id);
		expect(kidsOf(store, review.id)).toEqual([]);
		const after = store.getTask(review.id)!;
		expect(after.summary ?? "").not.toContain("Findings:");
		expect(after.details ?? "").not.toContain("## Findings");
	});

	test("a review settled from the merge stage without a report: the summary falls back, details start empty", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		const { store, loop } = reviewSetup(
			record,
			{ outcome: null, finalText: "" },
			[verdicts([1, true, ""])],
		);
		const review = reviewCard(store);
		store.updateTask(review.id, { stage: "merging", state: "queued" });
		await loop.runTurn(store.name, review.id);
		const kids = kidsOf(store, review.id);
		expect(kids.map((k) => k.prompt)).toEqual(["Bug A"]);
		const after = store.getTask(review.id)!;
		expect(
			after.summary!.startsWith(
				"Review finished\nFindings: 1 recorded, 1 filed",
			),
		).toBe(true);
		expect(after.details).toBe(
			`\n\n## Findings\n- filed as card #${kids[0]!.id}\n`,
		);
	});

	test("a check taken over by the lost sweep leaves the replacement turn's cap claim alone", async () => {
		const record = baseRecord();
		record.recorded = [finding("Bug A", 1)];
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		let releasePrepare: () => void = () => {};
		const prepareHeld = new Promise<void>((resolve) => {
			releasePrepare = resolve;
		});
		let targets = 0;
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 1,
			commitsAhead: async () => 0,
			pidAlive: () => false,
			// The second turn of the review (the replacement) holds in its prepare phase.
			resolveTarget: async () => {
				targets += 1;
				if (targets === 2) await prepareHeld;
				return { target: "origin/main", sha: "sha0", warning: null };
			},
			startRun: (o: StartOpts) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "review done" },
										recorded: record.recorded,
									}),
								)
							: record.runs.length === 2
								? checkDone
								: Promise.resolve(
										runResult({
											outcome: { status: "answered", summary: "again" },
										}),
									),
					kill: async () => {},
				};
			},
		});
		const review = reviewCard(store);
		const first = loop.runTurn(store.name, review.id);
		await flushPromises();
		loop.schedule(); // the check pid is dead: the sweep takes the check over
		await flushPromises();
		expect(store.getTask(review.id)!.state).toBe("needs_you");
		// A reply re-queues the review: its replacement turn claims the card's one cap unit.
		store.updateTask(review.id, { state: "queued" });
		const replacement = loop.runTurn(store.name, review.id);
		await flushPromises();
		const other = store.createTask("other card waits for the cap");
		// The old check's late end must not free the replacement's claim.
		releaseCheck(
			runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
		);
		await first;
		await flushPromises();
		expect(record.runs.some((r) => r.prompt.includes(other.prompt!))).toBe(
			false,
		);
		expect(store.getTask(other.id)!.state).toBe("queued");
		releasePrepare();
		await replacement;
	});
});

// Round 5, slice H: runTurn's work card → merging hand-off (the second-model work check):
// switch default, head read, reply window, check range, transcript evidence, prior-blocker
// resolution, the failed-check record and the lost-check takeover.
describe("turn survivor round 5 — work card to merging", () => {
	const CHECK_OPENING =
		"You are the second model checking a finished work card";
	const ready = () =>
		runResult({
			outcome: { status: "ready", summary: "did it" } satisfies Outcome,
		});
	const verdict = (v: {
		blockers?: { finding: string; quote: string }[];
		fixed?: { id: number; reason: string }[];
		notes?: string[];
	}) =>
		runResult({
			finalText: JSON.stringify({
				blockers: v.blockers ?? [],
				fixed: v.fixed ?? [],
				notes: v.notes ?? [],
			}),
		});
	/** A stored check run at `at`: a pass without blockers, else a blockers run. */
	const storedRun = (
		at: number,
		blockers: WorkCheckRun["blockers"] = [],
	): WorkCheckRun => ({
		at,
		model: null,
		outcome: blockers.length > 0 ? "blockers" : "pass",
		blockers,
		notes: [],
		durationMs: 0,
	});
	/** startRun fake: work runs report ready; check runs take `checks` in order. */
	function checkRuns(
		record: Recorded,
		checks: RunResult[],
		onCheck: (o: Parameters<TurnOps["startRun"]>[0]) => void = () => {},
	) {
		let next = 0;
		return (o: Parameters<TurnOps["startRun"]>[0]) => {
			record.runs.push(o);
			o.onSession?.(`sess-${record.runs.length}`);
			const isCheck = o.prompt.startsWith(CHECK_OPENING);
			if (isCheck) onCheck(o);
			return {
				pid: 4242,
				done: Promise.resolve(
					isCheck ? (checks[next++] ?? runResult({})) : ready(),
				),
				kill: async () => {},
			};
		};
	}
	/** A ready work card with one commit ahead at head sha1; maxTotalRuns 0 holds the merge turn. */
	function checkCase(checks: RunResult[], overrides: Partial<TurnOps> = {}) {
		const record = baseRecord();
		return setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => "sha1",
			diffText: async () => "const x = 1;\n",
			workCheck: () => true,
			startRun: checkRuns(record, checks),
			...overrides,
		});
	}
	const checkPrompts = (record: Recorded) =>
		record.runs.filter((r) => r.prompt.startsWith(CHECK_OPENING));
	/** A finished turn row that delivered a human message; returns its start time. */
	function humanTurn(store: ProjectStore, id: string, text: string): number {
		const t = store.startTurn(id, "work", "p", null, text);
		store.finishTurn(t.id, { endedAt: t.startedAt, exitCode: 0 });
		return t.startedAt;
	}

	test("a pass checks the worktree HEAD against the target and logs its model and duration", async () => {
		const record = baseRecord();
		const diffs: [string, string][] = [];
		let checkNotified: [string, string][] = [];
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			workCheck: () => true,
			modelRoles: () => ({ adversary: "zai/check-model" }),
			// Only the worktree HEAD has a sha; any other ref reads as unknown.
			targetSha: async (_wt: string, ref: string) =>
				ref === "HEAD" ? "sha1" : null,
			diffText: async (_wt: string, from: string, to: string) => {
				diffs.push([from, to]);
				return to === "HEAD" ? "const x = 1;\n" : null;
			},
			// The test clock stands still; the check alone moves it 5 s, and writes to the card log.
			startRun: checkRuns(record, [verdict({ notes: ["small nit"] })], (o) => {
				setSystemTime(new Date(Date.now() + 5000));
				const before = record.notifyLog.length;
				o.onLog?.();
				checkNotified = record.notifyLog.slice(before);
			}),
		});
		const task = store.createTask("work please");
		setSystemTime(new Date(Date.now()));
		try {
			await loop.runTurn(store.name, task.id);
		} finally {
			setSystemTime();
		}

		const check = checkPrompts(record)[0]!;
		expect(check.maxTime).toBe("1800");
		expect(check.prompt).toContain(", branch origin/main..sha1:");
		expect(check.prompt).toContain("const x = 1;");
		expect(diffs).toEqual([["origin/main", "HEAD"]]);
		// The check's log output notifies the board like the work run's.
		expect(checkNotified).toEqual([[store.name, task.id]]);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.workCheckHead).toBe("sha1");
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.model).toBe("zai/check-model");
		expect(after.workCheckLog[0]!.durationMs).toBe(5000);
		expect(logText(store, task.id)).toContain(
			"work check: 0 blocker(s), 1 note(s), 5s",
		);
	});

	test("an unknown head with no stored head still runs the check", async () => {
		const { store, record, loop } = checkCase([verdict({})], {
			targetSha: async () => null,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(checkPrompts(record)).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckHead).toBeNull();
	});

	test("an absent work-check switch counts as on", async () => {
		const { store, record, loop } = checkCase([verdict({})], {
			workCheck: undefined,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(checkPrompts(record)).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		expect(after.workCheckHead).toBe("sha1");
	});

	test("a work card that ends needs_you gets no check", async () => {
		const record = baseRecord();
		const { store, loop } = checkCase([verdict({})], {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "which database?",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.workCheckLog).toEqual([]);
		expect(after.workCheckHead).toBeNull();
	});

	test("a review card parked at merging gets no work check", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		const { store, projects, loop } = setupWith(record, {
			publishRelease: publishingRelease(record),
			commitsAhead: async () => 0,
			workCheck: () => true,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done: Promise.resolve(
						record.runs.length === 1
							? runResult({
									outcome: { status: "answered", summary: "review done" },
									recorded: record.recorded,
								})
							: runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' }),
					),
					kill: async () => {},
				};
			},
		});
		projects.get(store.name)!.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		await loop.runTurn(store.name, review.id);

		expect(record.runs).toHaveLength(2); // the review and its findings check only
		expect(checkPrompts(record)).toHaveLength(0);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("merging");
		expect(after.workCheckLog).toEqual([]);
	});

	test("a card the store no longer returns after the head read gets no check and no tracker error", async () => {
		const store = freshStore();
		const record = baseRecord();
		let gone = false;
		const vanishing = new Proxy(store, {
			get(target, prop) {
				if (prop === "getTask" && gone) return () => null;
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const loop = createTurnLoop(
			new Map([[store.name, fakeProject(vanishing)]]),
			fakeOps(record, {
				maxTotalRuns: () => 0,
				commitsAhead: async () => 1,
				workCheck: () => true,
				targetSha: async () => {
					gone = true;
					return "sha1";
				},
				startRun: checkRuns(record, [verdict({})]),
			}),
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		gone = false;

		expect(record.runs).toHaveLength(1);
		const after = store.getTask(task.id)!;
		expect(after.needsReason).toBeNull();
		expect(after.workCheckLog).toEqual([]);
	});

	test("a card cancelled during the head read gets no check", async () => {
		let cancel = () => {};
		const { store, record, loop } = checkCase([verdict({})], {
			targetSha: async () => {
				cancel();
				return "sha1";
			},
		});
		const task = store.createTask("work please");
		cancel = () => store.updateTask(task.id, { cancelledAt: Date.now() });
		await loop.runTurn(store.name, task.id);

		expect(record.runs).toHaveLength(1);
		expect(store.getTask(task.id)!.workCheckLog).toEqual([]);
	});

	test("an unreadable head checks the full diff against HEAD and clears the stored head", async () => {
		const { store, record, loop } = checkCase([verdict({})], {
			targetSha: async () => {
				throw new Error("not a git repository");
			},
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			workCheckLog: [storedRun(1)],
			workCheckHead: "old",
		});
		await loop.runTurn(store.name, task.id);

		const check = checkPrompts(record)[0]!;
		expect(check.prompt).toContain(", branch origin/main..HEAD:");
		expect(check.prompt).toContain("Diff of the branch");
		const after = store.getTask(task.id)!;
		expect(after.workCheckLog).toHaveLength(2);
		expect(after.workCheckHead).toBeNull();
	});

	test("a stored head without any check run still re-checks from the stored head", async () => {
		const froms: string[] = [];
		const { store, record, loop } = checkCase([verdict({})], {
			diffText: async (_wt: string, from: string) => {
				froms.push(from);
				return "const x = 1;\n";
			},
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, { workCheckHead: "old" });
		await loop.runTurn(store.name, task.id);

		// The stored head counts as a completed check: the re-check diff starts there, and
		// the full branch diff is still read to ground quotes.
		expect(froms).toEqual(["origin/main", "old"]);
		const prompt = checkPrompts(record)[0]!.prompt;
		expect(prompt).toContain(
			"Diff of only the new commits since the previous check",
		);
		expect(store.getTask(task.id)!.workCheckHead).toBe("sha1");
	});

	test("after an errored check, a new check sees the full diff and resolves only the open blockers", async () => {
		const { store, record, loop } = checkCase([verdict({})]);
		const task = store.createTask("work please");
		const settled = {
			finding: "old naming",
			quote: "let y",
			status: "fixed" as const,
			statusReason: "earlier fix",
		};
		const open = { finding: "weak tests", quote: "const x = 1;" };
		store.updateTask(task.id, {
			workCheckLog: [
				storedRun(1, [settled, open]),
				{
					at: 2,
					model: null,
					outcome: "error",
					blockers: [],
					notes: [],
					durationMs: 0,
					error: "quota exceeded",
				},
			],
			workCheckHead: null,
			workCheckSendbacks: 1,
		});
		await loop.runTurn(store.name, task.id);

		const prompt = checkPrompts(record)[0]!.prompt;
		expect(prompt).toContain("Diff of the branch");
		expect(prompt).toContain("\n1. weak tests\n   quote: const x = 1;");
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.workCheckLog).toHaveLength(3);
		expect(after.workCheckLog[0]!.blockers).toEqual([
			settled,
			{
				...open,
				status: "fixed",
				statusReason: "not re-cited by the re-check",
			},
		]);
		expect(after.workCheckLog[1]!.blockers).toEqual([]);
	});

	test("a human message from the last check's start instant is not reply data, and the re-check runs anyway", async () => {
		const { store, record, loop } = checkCase([verdict({})]);
		const task = store.createTask("work please");
		const said = humanTurn(store, task.id, "looks fine to me");
		store.updateTask(task.id, {
			workCheckLog: [
				storedRun(said, [{ finding: "weak tests", quote: "const x = 1;" }]),
			],
			workCheckHead: "sha1",
			workCheckSendbacks: 1,
		});
		await loop.runTurn(store.name, task.id);

		// Open blockers re-check on every ready. The message at the check's start instant
		// is not a reply, so it rides in no prompt.
		const prompt = checkPrompts(record)[0]!.prompt;
		expect(prompt).not.toContain("looks fine to me");
		expect(prompt).not.toContain("Human messages to the work agent");
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	test("a human reply after a passed check at the same head starts no check", async () => {
		const { store, record, loop } = checkCase([verdict({})]);
		const task = store.createTask("work please");
		const said = humanTurn(store, task.id, "also add a changelog line");
		store.updateTask(task.id, {
			workCheckLog: [storedRun(said - 1)],
			workCheckHead: "sha1",
		});
		await loop.runTurn(store.name, task.id);

		expect(checkPrompts(record)).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("queued");
		expect(after.workCheckLog).toHaveLength(1);
	});

	test("a reply-driven re-check at an unchanged head sees the reply and the since-head diff", async () => {
		const { store, record, loop } = checkCase([verdict({})]);
		const task = store.createTask("work please");
		const said = humanTurn(store, task.id, "I approve the auth change");
		store.updateTask(task.id, {
			workCheckLog: [
				storedRun(said - 1, [
					{ finding: "auth touched", quote: "const x = 1;" },
				]),
			],
			workCheckHead: "sha1",
			workCheckSendbacks: 1,
		});
		await loop.runTurn(store.name, task.id);

		const prompt = checkPrompts(record)[0]!.prompt;
		expect(prompt).toContain("I approve the auth change");
		// At the unchanged head the re-check diff starts at the checked head, not the base.
		expect(prompt).toContain(
			"Diff of only the new commits since the previous check",
		);
		expect(prompt).not.toContain("Diff of the branch");
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	test("a re-check at a new head reads the new-commits diff up to HEAD", async () => {
		const { store, record, loop } = checkCase([verdict({})], {
			targetSha: async () => "sha2",
			diffText: async (_wt: string, from: string, to: string) =>
				to !== "HEAD"
					? null
					: from === "sha1"
						? "const y = 2;\n"
						: "const x = 1;\nconst y = 2;\n",
		});
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			workCheckLog: [
				storedRun(1, [{ finding: "weak", quote: "const x = 1;" }]),
			],
			workCheckHead: "sha1",
			workCheckSendbacks: 1,
		});
		await loop.runTurn(store.name, task.id);

		const prompt = checkPrompts(record)[0]!.prompt;
		expect(prompt).toContain("Diff of only the new commits");
		expect(prompt).toContain("\n\nconst y = 2;\n\n");
		expect(prompt).not.toContain("const x = 1;\nconst y = 2;");
	});

	test("a blocker sent back names attempt 1 of the cap in the prompt and the log", async () => {
		const { store, loop } = checkCase([
			verdict({ blockers: [{ finding: "weak tests", quote: "const x = 1;" }] }),
		]);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.workCheckSendbacks).toBe(1);
		expect(after.pendingPrompt).toContain(
			`Send-back 1 of ${WORK_CHECK_MAX_SENDBACKS}: while fewer than ${WORK_CHECK_MAX_SENDBACKS} send-backs have run, a failing next check sends the card back again`,
		);
		expect(logText(store, task.id)).toContain(
			`sent back to the work agent (1 of ${WORK_CHECK_MAX_SENDBACKS})`,
		);
	});

	test("the fifth block numbers every finding in the needs_you reason", async () => {
		const { store, loop } = checkCase(
			[
				verdict({
					blockers: [
						{ finding: "first finding", quote: "const x = 1;" },
						{ finding: "second finding", quote: "const y = 2;" },
					],
				}),
			],
			{ diffText: async () => "const x = 1;\nconst y = 2;\n" },
		);
		const task = store.createTask("work please");
		store.updateTask(task.id, { workCheckSendbacks: WORK_CHECK_MAX_SENDBACKS });
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("1. first finding 2. second finding.");
	});

	test("a transcript quote blocks: the check gets the session file and reads it", async () => {
		const { store, record, loop } = checkCase([
			verdict({
				blockers: [{ finding: "claims tests ran", quote: "bun test: 12 pass" }],
			}),
		]);
		mkdirSync(store.sessionsDir, { recursive: true });
		const transcript = join(store.sessionsDir, "1_sess-1.jsonl");
		writeFileSync(transcript, '{"text":"bun test: 12 pass"}\n');
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(checkPrompts(record)[0]!.prompt.endsWith(`): ${transcript}`)).toBe(
			true,
		);
		const after = store.getTask(task.id)!;
		expect(after.workCheckLog[0]!.outcome).toBe("blockers");
		expect(after.workCheckLog[0]!.blockers[0]!.quote).toBe("bun test: 12 pass");
		expect(after.workCheckSendbacks).toBe(1);
	});

	test("with no diff and no transcript every quote demotes and the prompt holds neither", async () => {
		const { store, record, loop } = checkCase(
			[verdict({ blockers: [{ finding: "looks wrong", quote: "here" }] })],
			{ diffText: async () => null },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const prompt = checkPrompts(record)[0]!.prompt;
		expect(prompt).toContain(
			"read files in the worktree for the rest):\n\n\n\n",
		);
		expect(prompt.endsWith("read it in ranges): ")).toBe(true);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.workCheckLog[0]!.outcome).toBe("pass");
		expect(after.workCheckLog[0]!.notes[0]).toContain("looks wrong");
	});

	test("a check that answers no JSON twice parks the card with an error run", async () => {
		const { store, loop } = checkCase(
			[
				runResult({ finalText: "no verdict" }),
				runResult({ finalText: "still none" }),
			],
			{ modelRoles: () => ({ adversary: "zai/check-model" }) },
		);
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const reason = "the work check verdict was not valid JSON";
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(`failed twice: ${reason}.`);
		const run = after.workCheckLog[0]!;
		expect(run.model).toBe("zai/check-model");
		expect(run.outcome).toBe("error");
		expect(run.blockers).toEqual([]);
		expect(run.notes).toEqual([]);
		expect(run.error).toBe(reason);
		const text = logText(store, task.id);
		expect(text).toContain(`work check attempt 1 failed: ${reason}`);
		expect(text).toContain(`work check attempt 2 failed: ${reason}`);
		expect(text).toContain(`work check failed: ${reason}`);
	});

	test("a late check result after the lost sweep leaves the stored error run alone", async () => {
		const record = baseRecord();
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 0,
			commitsAhead: async () => 1,
			targetSha: async () => "sha1",
			workCheck: () => true,
			pidAlive: () => false,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess");
				return {
					pid: 4242,
					done: record.runs.length === 1 ? Promise.resolve(ready()) : checkDone,
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const run = loop.runTurn(store.name, task.id);
		await flushPromises();
		loop.schedule(); // the check pid is dead: the sweep parks the card
		await flushPromises();
		expect(store.getTask(task.id)!.workCheckLog[0]!.outcome).toBe("error");

		releaseCheck(verdict({}));
		await run;
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.workCheckLog).toHaveLength(1);
		expect(after.workCheckLog[0]!.outcome).toBe("error");
		expect(after.workCheckHead).toBeNull();
	});

	test("a late check result after the lost sweep keeps the replacement turn's cap slot", async () => {
		const record = baseRecord();
		let releaseCheck: (r: RunResult) => void = () => {};
		const checkDone = new Promise<RunResult>((resolve) => {
			releaseCheck = resolve;
		});
		let installs = 0;
		const { store, loop } = setupWith(record, {
			maxTotalRuns: () => 1,
			commitsAhead: async () => 1,
			targetSha: async () => "sha1",
			workCheck: () => true,
			pidAlive: () => false,
			// The replacement turn (the second install) hangs: it holds only its preparing claim.
			ensurePackages: async () => {
				installs++;
				return installs === 2 ? new Promise<string[]>(() => {}) : [];
			},
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.(`sess-${record.runs.length}`);
				return {
					pid: 4242,
					done:
						record.runs.length === 1
							? Promise.resolve(ready())
							: record.runs.length === 2
								? checkDone
								: new Promise<RunResult>(() => {}),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		const first = loop.runTurn(store.name, task.id);
		await flushPromises();
		loop.schedule(); // the check pid is dead: the sweep parks the card
		await flushPromises();
		expect(store.getTask(task.id)!.state).toBe("needs_you");

		// The user replies: a replacement turn claims the card's slot and hangs in its prepare.
		store.updateTask(task.id, { state: "queued", pendingPrompt: "re-run it" });
		void loop.runTurn(store.name, task.id);
		await flushPromises();
		expect(installs).toBe(2);
		const other = store.createTask("another card");

		releaseCheck(verdict({}));
		await first;
		await flushPromises();
		// The cap of 1 is still held by the replacement: the other card waits.
		expect(store.getTask(other.id)!.state).toBe("queued");
		expect(installs).toBe(2);
		expect(record.runs).toHaveLength(2);
	});
});

describe("turn survivor round 5 — run tail, cancel, finish-kept", () => {
	type StartArgs = Parameters<TurnOps["startRun"]>[0];
	const answered = (summary = "did it") =>
		runResult({ outcome: { status: "answered", summary } satisfies Outcome });

	/** Microtask-only drain: safe under fake timers (no setImmediate). */
	async function drainMicrotasks(n = 50) {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	async function waitFor(cond: () => boolean) {
		for (let i = 0; i < 100 && !cond(); i++) await flushPromises();
		expect(cond()).toBe(true);
	}

	function reviewWith(store: ProjectStore) {
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		return review;
	}

	test("a cancel during the review check keeps the deferred park off the cancelled card", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		// The cancel has marked the card and is still removing the worktree when the check ends:
		// the card is cancelled but still in its running state.
		const removing = Promise.withResolvers<void>();
		const removeGate = Promise.withResolvers<void>();
		let cancelling: Promise<unknown> = Promise.resolve();
		let duringCheck: () => Promise<unknown> = async () => undefined;
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			removeWorktree: async (o: unknown) => {
				record.removeWorktree.push(o);
				removing.resolve();
				await removeGate.promise;
			},
			startRun: (o: StartArgs) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				const first = record.runs.length === 1;
				const result = first
					? runResult({
							outcome: { status: "answered", summary: "review done" },
							recorded: record.recorded,
						})
					: runResult({ finalText: '[{"id":1,"keep":true,"reason":""}]' });
				return {
					pid: 4242,
					done: first
						? Promise.resolve(result)
						: duringCheck().then(() => result),
					kill: async () => {},
				};
			},
		});
		const review = reviewWith(store);
		duringCheck = async () => {
			cancelling = loop.cancel(fakeProject(store), review.id, false);
			await removing.promise;
			expect(store.getTask(review.id)!.state).toBe("running");
		};
		await loop.runTurn(store.name, review.id);
		removeGate.resolve();
		await expect(cancelling).resolves.toEqual({ removed: true });

		const after = store.getTask(review.id)!;
		expect(record.runs).toHaveLength(2); // the check did run
		expect(after.cancelledAt).not.toBeNull();
		// The findings park (merging/idle/FINDINGS_HOLD) never lands on the cancelled card.
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		expect(store.listTasks().filter((t) => t.followUpOf === review.id)).toEqual(
			[],
		);
	});

	test("a run whose session was never announced still settles to merging/queued", async () => {
		const { store, record, loop } = setup({
			maxTotalRuns: () => 0, // keep the finally's schedule() from starting the merge turn
			// No onSession call: the card never left preparing while the run went on.
			startRun: (o: StartArgs) => {
				record.runs.push(o);
				return {
					pid: 4242,
					done: Promise.resolve(answered()),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect([after.stage, after.state]).toEqual(["merging", "queued"]);
	});

	test("a work card settling to merging/queued gets a fresh queue time", async () => {
		// Cap 0 keeps the finally's schedule() from starting the merge turn.
		const { store, loop } = setup({ maxTotalRuns: () => 0 });
		const task = store.createTask("work please");
		store.updateTask(task.id, { queuedAt: 1 });
		const before = Date.now();
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect([after.stage, after.state]).toEqual(["merging", "queued"]);
		expect(after.queuedAt).toBeGreaterThanOrEqual(before);
	});

	test("a review parked on its findings keeps its old queue time", async () => {
		const record = baseRecord();
		record.recorded = [
			{ prompt: "Bug A", model: null, rank: 1, security: null },
		];
		const { store, loop } = setupWith(record, {
			commitsAhead: async () => 0,
			reviewCheck: () => false,
		});
		const review = reviewWith(store);
		store.updateTask(review.id, { queuedAt: 1 });
		await loop.runTurn(store.name, review.id);
		const after = store.getTask(review.id)!;
		expect([after.stage, after.state, after.needsReason]).toEqual([
			"merging",
			"idle",
			FINDINGS_HOLD,
		]);
		expect(after.queuedAt).toBe(1);
	});

	test("a merge proved by git without a receipt stamps no version from its prose", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			startRun: (o: StartArgs) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					// No report_outcome: git proves the merge; the final text names a version.
					done: Promise.resolve(
						runResult({ outcome: null, finalText: "pushed v1.2.3 to main" }),
					),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.releaseVersion).toBeNull();
		expect(after.pushSha).toBe("sha-pushed");
		expect(record.removeWorktree).toHaveLength(1);
		expect(logText(store, task.id)).toContain("worktree removed");
	});

	test("a rejected work integrated report pins no CI push sha", async () => {
		const record = baseRecord();
		const { store, loop } = setupWith(record, {
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			startRun: integratedRun(record),
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		// The report is rejected (AGEN-33): the park names the out-of-turn merge, and no
		// settle runs and no CI watch starts — the card never records a push sha it did
		// not earn through a merge turn.
		expect(after.stage).toBe("in_progress");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Out-of-turn merge: the branch head is already on origin/main. A work turn never merges; report ready.",
		);
		expect(after.pushSha).toBeNull();
		expect(logText(store, task.id)).not.toContain("CI watch skipped");
	});

	test("a target with origin/ inside its name reads its own remote-tracking ref", async () => {
		const record = baseRecord();
		const refs: string[] = [];
		const { store, loop } = setupWith(record, {
			resolveTarget: async () => ({
				target: "mirror-origin/main",
				sha: "sha0",
				warning: null,
			}),
			isIntegrated: async () => true,
			targetSha: async (_mainPath: string, ref: string) => {
				refs.push(ref);
				return ref === "mirror-origin/main" ||
					ref === "refs/remotes/origin/mirror-origin/main"
					? "sha-pushed"
					: null;
			},
			startRun: integratedRun(record),
		});
		const task = store.createTask("merge please");
		store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, task.id);
		expect(refs).toContain("refs/remotes/origin/mirror-origin/main");
		expect(store.getTask(task.id)!.pushSha).toBe("sha-pushed");
	});

	test("a run whose done rejects frees its slot: the requeued card runs again", async () => {
		let calls = 0;
		const { store, record, loop } = setup({
			startRun: (o: StartArgs) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				calls += 1;
				return {
					pid: 4242,
					done:
						calls === 1
							? Promise.reject(new Error("stream broke"))
							: Promise.resolve(answered()),
					kill: async () => {},
				};
			},
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		const failed = store.getTask(task.id)!;
		expect(failed.state).toBe("needs_you");
		expect(failed.needsReason).toBe("Tracker error: stream broke");
		expect(store.listTurns(task.id)[0]!.error).toBe("stream broke");
		await expect(loop.stopTurn(fakeProject(store), task.id)).resolves.toEqual({
			error: "no turn is running",
			status: 409,
		});

		store.updateTask(task.id, { state: "queued" });
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(2);
		expect(store.getTask(task.id)!.stage).toBe("merging");
	});

	/** First run hangs on dead pid 4242 until `release1`; later runs use pid 5050. */
	function abandonFixture(overrides: Partial<TurnOps> = {}) {
		const gate1 = Promise.withResolvers<RunResult>();
		const gate2 = Promise.withResolvers<RunResult>();
		const record = baseRecord();
		const store = freshStore();
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				pidAlive: (pid: number) => pid !== 4242,
				startRun: (o: StartArgs) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					if (record.runs.length === 1)
						return { pid: 4242, done: gate1.promise, kill: async () => {} };
					return {
						pid: 5050,
						done: gate2.promise,
						kill: async () => {
							record.killed = true;
							gate2.resolve(runResult({ killed: true, sawTerminalEnd: false }));
						},
					};
				},
				...overrides,
			}),
		);
		const task = store.createTask("work please");
		const key = `${store.name}/${task.id}`;
		return { record, store, projects, loop, task, key, gate1 };
	}

	test("a late done of an abandoned run leaves the resumed run's slot alone", async () => {
		const { record, store, loop, task, key, gate1 } = abandonFixture();
		const run1 = loop.runTurn(store.name, task.id);
		await waitFor(() => loop.running.has(key));
		// The sweep abandons the dead pid; a later tick starts the resumed run (pid 5050).
		for (let i = 0; i < 10 && record.runs.length < 2; i++) {
			loop.schedule();
			await flushPromises();
		}
		expect(record.runs).toHaveLength(2);
		expect(loop.running.get(key)?.pid).toBe(5050);

		gate1.resolve(answered());
		await run1;

		// The resumed run still owns the slot: Esc reaches it.
		await expect(loop.stopTurn(fakeProject(store), task.id)).resolves.toEqual({
			ok: true,
		});
		expect(record.killed).toBe(true);
	});

	test("a late done of an abandoned run keeps the resumed run's cap claim", async () => {
		let targets = 0;
		const hold = Promise.withResolvers<void>();
		const other = freshStore();
		const { record, store, projects, loop, task, key, gate1 } = abandonFixture({
			maxTotalRuns: () => 1,
			resolveTarget: async () => {
				targets += 1;
				// The resumed run (second resolve) sits in its prepare phase.
				if (targets === 2) await hold.promise;
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		projects.set(other.name, fakeProject(other));
		const run1 = loop.runTurn(store.name, task.id);
		await waitFor(() => loop.running.has(key));
		for (let i = 0; i < 10 && targets < 2; i++) {
			loop.schedule();
			await flushPromises();
		}
		expect(targets).toBe(2);
		expect(store.getTask(task.id)!.state).toBe("preparing");
		// A card in another project waits for the one global slot.
		const waiting = other.createTask("next in line");

		gate1.resolve(answered());
		await run1;
		await flushPromises();

		expect(other.getTask(waiting.id)!.state).toBe("queued");
		expect(record.runs).toHaveLength(1);
		hold.resolve();
	});

	test("a stop that raced a natural finish does not turn a later cancel into a stop", async () => {
		const gate1 = Promise.withResolvers<RunResult>();
		const gate2 = Promise.withResolvers<RunResult>();
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			startRun: (o: StartArgs) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				if (record.runs.length === 1)
					// The kill lands too late: the run finishes on its own.
					return { pid: 4242, done: gate1.promise, kill: async () => {} };
				return {
					pid: 5050,
					done: gate2.promise,
					kill: async () => {
						gate2.resolve(runResult({ killed: true, sawTerminalEnd: false }));
					},
				};
			},
		});
		const task = store.createTask("work please");
		const key = `${store.name}/${task.id}`;
		const run1 = loop.runTurn(store.name, task.id);
		await waitFor(() => loop.running.has(key));
		const stop = loop.stopTurn(fakeProject(store), task.id);
		gate1.resolve(answered());
		await expect(stop).resolves.toEqual({ ok: true });
		await run1;
		expect(store.listTurns(task.id)[0]!.error).toBeNull();

		store.updateTask(task.id, { stage: "in_progress", state: "queued" });
		const run2 = loop.runTurn(store.name, task.id);
		await waitFor(() => loop.running.has(key));
		await expect(
			loop.cancel(fakeProject(store), task.id, true),
		).resolves.toEqual({ removed: true });
		await run2;

		const second = store.listTurns(task.id).at(-1)!;
		expect(second.error).toBe("cancelled");
		expect(store.getTask(task.id)!.needsReason ?? "").not.toContain(
			"Turn stopped",
		);
	});

	test("stop returns after 15 s when the killed run never ends", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("hung");
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: new Promise<unknown>(() => {}),
			kill: async () => {
				record.killed = true;
			},
		});
		jest.useFakeTimers();
		try {
			let out: unknown = null;
			void loop.stopTurn(fakeProject(store), task.id).then((r) => {
				out = r;
			});
			await drainMicrotasks();
			jest.advanceTimersByTime(14_999);
			await drainMicrotasks();
			expect(out).toBeNull();
			jest.advanceTimersByTime(1);
			await drainMicrotasks();
			expect(out).toEqual({ ok: true });
			expect(record.killed).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	test("cancel removes the worktree after 15 s when the killed run never ends", async () => {
		const { store, record, loop } = setup();
		const task = store.createTask("hung");
		store.updateTask(task.id, {
			state: "running",
			stage: "in_progress",
			worktree: join(store.worktreesDir, task.id),
			branch: `ott/${task.id}`,
			base: "abc",
		});
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: new Promise<unknown>(() => {}),
			kill: async () => {
				record.killed = true;
			},
		});
		jest.useFakeTimers();
		try {
			let out: unknown = null;
			void loop.cancel(fakeProject(store), task.id, false).then((r) => {
				out = r;
			});
			await drainMicrotasks();
			jest.advanceTimersByTime(15_000);
			await drainMicrotasks();
			expect(out).toEqual({ removed: true });
			expect(record.removeWorktree).toHaveLength(1);
			expect(store.getTask(task.id)!.state).toBe("idle");
		} finally {
			jest.useRealTimers();
		}
	});

	test("finish-kept without a worktree refuses a branch with unreached commits", async () => {
		let huskCalls = 0;
		const { store, record, loop } = setup({
			branchMergedOrGone: async () => false,
			worktreeHusk: async () => {
				huskCalls += 1;
				return false;
			},
		});
		const task = store.createTask("kept work");
		store.updateTask(task.id, {
			stage: "in_progress",
			state: "needs_you",
			needsReason: keptReason("uncommitted changes"),
			worktree: null,
			branch: "ott/x",
			base: "abc",
		});
		await expect(
			loop.finishKept(fakeProject(store), task.id, {}),
		).resolves.toEqual({
			error: "branch ott/x has commits that never reached abc",
			status: 409,
		});
		expect(huskCalls).toBe(0);
		expect(record.removeWorktree).toHaveLength(0);
		expect(store.getTask(task.id)!.state).toBe("needs_you");
	});
});

describe("generateTitle failure causes", () => {
	const gatewaySpawn = (lines: unknown[]) => async () => ({
		code: 0,
		stdout: lines.map((line) => JSON.stringify(line)).join("\n"),
		stderr: "",
	});

	test("a success returns the cleaned title, card prefix stripped", async () => {
		const title = await generateTitle(
			"fix the gate",
			gatewaySpawn([
				{ ready: true },
				{
					id: 1,
					status: 200,
					body: {
						choices: [{ message: { content: "🩻 SKELE: Fix the gate" } }],
					},
				},
			]),
		);
		expect(title).toBe("Fix the gate");
	});

	test("a non-200 gateway status is reported as the cause", async () => {
		const causes: string[] = [];
		const title = await generateTitle(
			"fix the gate",
			gatewaySpawn([
				{ ready: true },
				{ id: 1, status: 502, body: { error: { message: "no quota" } } },
			]),
			(cause) => causes.push(cause),
		);
		expect(title).toBeNull();
		expect(causes).toEqual(["gateway status 502: no quota"]);
	});

	test("an empty reply is reported as the cause", async () => {
		const causes: string[] = [];
		const title = await generateTitle(
			"fix the gate",
			gatewaySpawn([
				{ ready: true },
				{
					id: 1,
					status: 200,
					body: { choices: [{ message: { content: "   " } }] },
				},
			]),
			(cause) => causes.push(cause),
		);
		expect(title).toBeNull();
		expect(causes).toEqual(["empty reply"]);
	});

	test("a hung gateway is reported as a timeout cause", async () => {
		// The deadline is generateTitle's own timer, so fake clocks drive it deterministically.
		jest.useFakeTimers();
		try {
			const causes: string[] = [];
			const pending = generateTitle(
				"fix the gate",
				async () => new Promise<never>(() => {}),
				(cause) => causes.push(cause),
				20,
			);
			jest.advanceTimersByTime(20);
			await expect(pending).resolves.toBeNull();
			expect(causes).toEqual(["timed out after 20ms"]);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("per-runner drain gates (OTTR-454)", () => {
	test("a drained worker gets no dispatch while the other still does", async () => {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: {
				urls: ["http://worker-a:8787", "http://worker-b:8787"],
			},
			drainedRunner: (id) => id === "worker-a",
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(1);
		expect((record.runs[0]!.worker as { urls: string[] }).urls).toEqual([
			"http://worker-b:8787",
		]);
	});

	test("every worker drained leaves the card queued and starts no run", async () => {
		const { store, record, loop } = setup({
			workerTarget: { urls: ["http://worker-a:8787"] },
			// Selective: "local" stays undrained, so the deferral must come from the
			// workers' check, not from the local branch that merge turns take.
			drainedRunner: (id) => id !== "local",
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)?.state).toBe("queued");
	});

	test("a board check starts while every worker is drained", async () => {
		// The check runs on the server's local runner: a workers-only hold must not
		// defer it, and the gate must take the workers' branch for nothing else.
		const { store, record, loop } = setup({
			workerTarget: { urls: ["http://worker-a:8787"] },
			drainedRunner: (id) => id !== "local",
		});
		const check = store.createTask(BOARD_CHECK_PROMPT);
		store.setBoardCheckId(check.id);
		await loop.runTurn(store.name, check.id);
		expect(record.runs).toHaveLength(1);
	});

	test("a drain that lands while the turn prepares parks the card", async () => {
		// Race path: the hold covers every worker only after the claim. Dispatching
		// would be fail-open, so the prepared turn parks for a human instead.
		let drained = false;
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			drainedRunner: (id) => drained && id === "worker-a",
			resolveTarget: async () => {
				drained = true; // the update holds the runner mid-prepare
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const card = store.getTask(task.id);
		expect(card?.state).toBe("needs_you");
		expect(card?.needsReason).toContain("Every worker is unavailable");
	});

	test("a local drain defers a merge turn but a worker turn still starts", async () => {
		const { store, record, loop } = setup({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			workerTarget: { urls: ["http://worker-a:8787"] },
			drainedRunner: (id) => id === "local",
		});
		const merge = store.createTask("merge please");
		store.updateTask(merge.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, merge.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(merge.id)?.state).toBe("queued");

		const work = store.createTask("queued work");
		await loop.runTurn(store.name, work.id);
		expect(record.runs).toHaveLength(1);
	});

	test("a local drain defers the board check too", async () => {
		const { store, record, loop } = setup({
			drainedRunner: () => true,
		});
		const check = store.createTask(BOARD_CHECK_PROMPT);
		store.setBoardCheckId(check.id);
		await loop.runTurn(store.name, check.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(check.id)?.state).toBe("queued");
	});

	test("runnerTurns buckets live runs by worker hostname and counts preparing", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				// A local run (merge, board check) carries no url: the entry counts local.
				if (o.worker == null)
					return {
						pid: 4321,
						done: Promise.withResolvers<RunResult>().promise,
						kill: async () => {},
					};
				return {
					pid: null,
					// The fake worker dispatch records the target url the entry carries.
					url: o.worker.urls[0]!,
					done: Promise.withResolvers<RunResult>().promise,
					kill: async () => {},
				};
			},
		});
		const check = store.createTask(BOARD_CHECK_PROMPT);
		store.setBoardCheckId(check.id);
		void loop.runTurn(store.name, check.id);
		const first = store.createTask("queued work");
		void loop.runTurn(store.name, first.id);
		const second = store.createTask("more work");
		void loop.runTurn(store.name, second.id);
		await flushPromises();
		// Two live runs share worker-a's hostname, and the local check counts apart.
		expect(loop.runnerTurns()).toEqual({
			local: 1,
			workers: { "worker-a": 2 },
			preparing: 3,
		});
	});
});

describe("/tmp free-space gates (OTTR-754)", () => {
	/** The ops override whose /tmp rule holds only `runner` (the worker hostname or "local"). */
	const tmpHolds = (...runners: string[]): Partial<TurnOps> => ({
		tmpFullLine: (r) =>
			runners.includes(r) ? `/tmp of ${r} is full (512 MiB)` : null,
	});

	test("a tmp-full worker gets no dispatch while the other still does", async () => {
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: {
				urls: ["http://worker-a:8787", "http://worker-b:8787"],
			},
			...tmpHolds("worker-a"),
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(1);
		expect(record.runs[0]!.worker?.urls).toEqual(["http://worker-b:8787"]);
	});

	test("every worker tmp-full leaves the card queued and starts no run", async () => {
		const { store, record, loop } = setup({
			workerTarget: { urls: ["http://worker-a:8787"] },
			...tmpHolds("worker-a"),
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)?.state).toBe("queued");
		// OTTR-754: the queued card carries the hold reason with the runner's free space.
		expect(store.getTask(task.id)?.needsReason).toBe(
			"/tmp of worker-a is full (512 MiB)",
		);
	});

	test("a drain-only hold writes no /tmp reason on the queued card", async () => {
		const { store, record, loop } = setup({
			workerTarget: { urls: ["http://worker-a:8787"] },
			drainedRunner: (id) => id === "worker-a",
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(task.id)?.state).toBe("queued");
		expect(store.getTask(task.id)?.needsReason).toBeNull();
	});

	test("a tmp-full local runner defers the board check", async () => {
		const { store, record, loop } = setup({
			...tmpHolds("local"),
		});
		const check = store.createTask(BOARD_CHECK_PROMPT);
		store.setBoardCheckId(check.id);
		await loop.runTurn(store.name, check.id);
		expect(record.runs).toHaveLength(0);
		expect(store.getTask(check.id)?.state).toBe("queued");
		expect(store.getTask(check.id)?.needsReason).toBe(
			"/tmp of local is full (512 MiB)",
		);
	});

	test("a /tmp hold that lands while the turn prepares parks with the runner's space", async () => {
		// Race path, mirror of the drain test: the hold covers the only worker after
		// the claim, so the prepared turn parks and the reason names the runner's space.
		let full = false;
		const { store, record, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			tmpFullLine: (r) =>
				full && r === "worker-a" ? "/tmp of worker-a is full (512 MiB)" : null,
			resolveTarget: async () => {
				full = true; // the /tmp limit reaches the runner mid-prepare
				return { target: "origin/main", sha: "sha0", warning: null };
			},
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(record.runs).toHaveLength(0);
		const card = store.getTask(task.id);
		expect(card?.state).toBe("needs_you");
		expect(card?.needsReason).toContain("/tmp of worker-a is full (512 MiB)");
	});

	test("an apt disk-failure reason names the free /tmp of the runner it ran on", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			tmpSpaceLine: (r) => `/tmp of ${r} has 512 MiB free`,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => ({
				pid: 4242,
				// The dispatch record the settle reads the runner from; the reason text
				// itself carries no dispatch token to parse.
				url: o.worker?.urls[0],
				done: Promise.resolve(
					runResult({
						exitCode: 1,
						stderrTail:
							"E: Some packages could not be authenticated... Splitting up /var/lib/apt/lists/extended_states",
					}),
				),
				kill: async () => {},
			}),
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(
			after.needsReason?.endsWith("/tmp of worker-a has 512 MiB free"),
		).toBe(true);
	});

	test("a failed run without the apt signature stays unenriched", async () => {
		const { store, loop } = setup({
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"] },
			tmpSpaceLine: (r) => `/tmp of ${r} has 512 MiB free`,
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => ({
				pid: 4242,
				url: o.worker?.urls[0],
				done: Promise.resolve(runResult({ exitCode: 1 })),
				kill: async () => {},
			}),
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.needsReason).toBe(
			"omp exited with code 1 before finishing.",
		);
	});

	test("tmpEnrichNeedsReason appends only on an apt signature, only with a phrase", () => {
		const space = (r: string) =>
			r === "worker-a" || r === "local"
				? `/tmp of ${r} has 512 MiB free`
				: null;
		expect(
			tmpEnrichNeedsReason(
				"omp exited with code 1 before finishing: Splitting up failed",
				"worker-a",
				space,
			),
		).toBe(
			"omp exited with code 1 before finishing: Splitting up failed; /tmp of worker-a has 512 MiB free",
		);
		// "is not signed" is the other apt disk-failure signature; a local run passes null.
		expect(
			tmpEnrichNeedsReason(
				"omp exited with code 1: package X is not signed",
				null,
				space,
			),
		).toBe(
			"omp exited with code 1: package X is not signed; /tmp of local has 512 MiB free",
		);
		// No signature, or a null line (space unknown): the reason stays.
		expect(
			tmpEnrichNeedsReason(
				"omp exited with code 1 before finishing",
				"worker-a",
				space,
			),
		).toBe("omp exited with code 1 before finishing");
		expect(
			tmpEnrichNeedsReason("apt: Splitting up failed", "worker-b", space),
		).toBe("apt: Splitting up failed");
	});
});

describe("detached re-bind after the restart", () => {
	const WT = "/srv/wt-x";
	const RESTART_ERROR =
		"the update restarted the board; the turn finished on the worker";
	const RESTART_REASON =
		"The update restarted the board and the turn finished on the worker - resuming automatically. Cancel to stop it instead.";

	/** A running card with an open pid-null worker row whose worktree matches the worker answer. */
	function seededWorkerRow(store: ProjectStore) {
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			state: "running",
			stage: "in_progress",
			sessionId: "sess-9",
			worktree: WT,
			branch: "ott/x",
		});
		store.startTurn(task.id, "work", "old prompt", null);
		return task;
	}

	/** setup whose worker answers `runs` per probe; killDetached records into `killed`. */
	function rebindSetup(
		runs: () => DetachedRun[],
		killed: { id: string; token: string | undefined }[] = [],
	) {
		return setup({
			// Cap 0: the sweep ticks settle but start no resumed run.
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"], token: "tok" },
			targetSha: async (_mainPath: string, ref: string) =>
				ref === "HEAD" ? "abc123def" : null,
			isClean: async () => true,
			detachedRuns: async () => runs(),
			killDetached: async (_url: string, token, id) => {
				killed.push({ id, token });
			},
		});
	}

	test("recoverRestarted re-binds a running detached run and leaves the card running", async () => {
		const running = true;
		const { store, record, loop } = rebindSetup(() => [
			{ id: "run-1", cwd: WT, pid: null, running, startedAt: 1 },
		]);
		const task = seededWorkerRow(store);

		await loop.recoverRestarted();

		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(record.runs).toHaveLength(0);
		// The sweep keeps polling the watcher: a still-running run leaves the row open.
		loop.schedule();
		await flushPromises();
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
	});

	test("a finished detached run settles at recovery through the resume route", async () => {
		const { store, loop } = rebindSetup(() => [
			{
				id: "run-1",
				cwd: WT,
				pid: null,
				running: false,
				startedAt: 1,
				result: { exitCode: 0, stderrTail: "" },
			},
		]);
		const task = seededWorkerRow(store);

		await loop.recoverRestarted();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe(RESTART_ERROR);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		// A detached completion is not a worker failure: the reason names the restart, and
		// no lost-worker parking is involved.
		expect(after.needsReason).toBe(RESTART_REASON);
		expect(after.pendingPrompt).toBe(
			restartResumePrompt({ sha: "abc123def", clean: true }),
		);
	});

	test("an unmatched row keeps the lost settle", async () => {
		const { store, loop } = rebindSetup(() => [
			{
				id: "run-1",
				cwd: "/srv/other",
				pid: null,
				running: true,
				startedAt: 1,
			},
		]);
		const task = seededWorkerRow(store);

		await loop.recoverRestarted();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("tracker restarted");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(
			"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
		);
	});

	test("an unreachable worker keeps the lost settle", async () => {
		const { store, loop } = setup({
			maxTotalRuns: () => 0,
			workerTarget: { urls: ["http://worker-a:8787"], token: "tok" },
			detachedRuns: async () => {
				throw new Error("connection refused");
			},
		});
		const task = seededWorkerRow(store);

		await loop.recoverRestarted();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("tracker restarted");
		expect(store.getTask(task.id)!.state).toBe("queued");
	});

	test("the sweep settles a re-bound row once the worker reports it finished", async () => {
		let running = true;
		const { store, loop } = rebindSetup(() => [
			{ id: "run-1", cwd: WT, pid: null, running, startedAt: 1 },
		]);
		const task = seededWorkerRow(store);
		await loop.recoverRestarted();

		loop.schedule();
		await flushPromises();
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();

		running = false;
		loop.schedule();
		await flushPromises();
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe(RESTART_ERROR);
		expect(store.getTask(task.id)!.state).toBe("queued");
		expect(store.getTask(task.id)!.needsReason).toBe(RESTART_REASON);

		// The watcher is dropped: a further sweep settles nothing again.
		loop.schedule();
		await flushPromises();
		expect(store.listTurns(task.id)).toHaveLength(1);
	});

	test("cancel of a re-bound row kills the detached run and drops the watcher", async () => {
		const killed: { id: string; token: string | undefined }[] = [];
		const { store, projects, loop } = rebindSetup(
			() => [{ id: "run-1", cwd: WT, pid: null, running: true, startedAt: 1 }],
			killed,
		);
		const task = seededWorkerRow(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await loop.cancel(e, task.id, true);

		expect(killed).toEqual([{ id: "run-1", token: "tok" }]);
		expect(store.getTask(task.id)!.state).toBe("idle");
		// The watcher is gone: a further sweep probes and kills nothing again.
		loop.schedule();
		await flushPromises();
		expect(killed).toEqual([{ id: "run-1", token: "tok" }]);
	});

	test("stop of a re-bound row kills the detached run and parks the card stopped", async () => {
		const killed: { id: string; token: string | undefined }[] = [];
		const { store, projects, loop } = rebindSetup(
			() => [{ id: "run-1", cwd: WT, pid: null, running: true, startedAt: 1 }],
			killed,
		);
		const task = seededWorkerRow(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await expect(loop.stopTurn(e, task.id)).resolves.toEqual({ ok: true });

		expect(killed).toEqual([{ id: "run-1", token: "tok" }]);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).not.toBeNull();
		expect(turn.error).toBe("stopped");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(
			"Turn stopped. Reply to continue the session, Resume to rerun it, or cancel the card.",
		);
	});
});

describe("detached re-bind survivor pins", () => {
	const WT = "/srv/wt-x";
	const URL_A = "http://worker-a:8787";
	const URL_B = "http://worker-b:8787";
	const RESTART_ERROR =
		"the update restarted the board; the turn finished on the worker";
	const RESTART_REASON =
		"The update restarted the board and the turn finished on the worker - resuming automatically. Cancel to stop it instead.";
	const TRACKER_REASON =
		"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.";
	const STOP_REASON =
		"Turn stopped. Reply to continue the session, Resume to rerun it, or cancel the card.";
	const RESTART_RESUME = restartResumePrompt({ sha: "abc123def", clean: true });

	const run1 = (running: boolean): DetachedRun => ({
		id: "run-1",
		cwd: WT,
		pid: null,
		running,
		startedAt: 1,
	});
	const finished1 = (): DetachedRun => ({
		...run1(false),
		result: { exitCode: 0, stderrTail: "" },
	});

	/** A running card, worktree WT, with an open worker row (pid null unless opts.pid). */
	function row(
		store: ProjectStore,
		opts: {
			pid?: number | null;
			cancelled?: boolean;
			worktree?: string | null;
			noRow?: boolean;
		} = {},
	) {
		const task = store.createTask("work please");
		store.updateTask(task.id, {
			state: "running",
			stage: "in_progress",
			sessionId: "sess-9",
			worktree: opts.worktree === undefined ? WT : opts.worktree,
			branch: "ott/x",
			...(opts.cancelled ? { cancelledAt: Date.now() } : {}),
		});
		if (!opts.noRow)
			store.startTurn(task.id, "work", "old prompt", opts.pid ?? null);
		return task;
	}

	function endRow(store: ProjectStore, id: string, error: string) {
		store.finishTurn(store.listTurns(id)[0]!.id, {
			endedAt: Date.now(),
			exitCode: null,
			error,
		});
	}

	/** setup with probe/kill recording; `answer(nth, url)` scripts each probe result. */
	function watchSetup(
		answer: (nth: number, url: string) => DetachedRun[],
		opts: {
			urls?: string[];
			/** null sends no token at all (WorkerTarget.token absent). */
			token?: string | null;
			kill?: false;
			killError?: string;
		} = {},
	) {
		const probes: { url: string; token: string }[] = [];
		const killed: { url: string; token: string | undefined; id: string }[] = [];
		let nth = 0;
		const store = freshStore();
		const record = baseRecord();
		// A target so a redone non-forced cancel (clean tree) removes the worktree.
		const projects = new Map([
			[store.name, { ...fakeProject(store), target: "origin/main" }],
		]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				maxTotalRuns: () => 0,
				workerTarget: {
					urls: opts.urls ?? [URL_A],
					...(opts.token === null ? {} : { token: opts.token ?? "tok" }),
				},
				targetSha: async (_mainPath: string, ref: string) =>
					ref === "HEAD" ? "abc123def" : null,
				detachedRuns: async (url: string, token: string) => {
					probes.push({ url, token });
					return answer(nth++, url);
				},
				...(opts.kill === false
					? {}
					: {
							killDetached: async (
								url: string,
								token: string | undefined,
								id: string,
							) => {
								killed.push({ url, token, id });
								if (opts.killError) throw new Error(opts.killError);
							},
						}),
			}),
		);
		return { store, record, projects, loop, probes, killed };
	}

	test("a live agent pid owns the card and is never probed for detached runs", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store, { pid: 4344 });

		await loop.recoverRestarted();

		expect(probes).toEqual([]);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		const log = logText(store, task.id);
		expect(log).toContain(
			"agent pid 4344 survived the tracker restart; leaving the card running",
		);
		expect(log).not.toContain("re-bound detached run");
	});

	test("a cancelled card is never re-bound; its interrupted cancel finishes", async () => {
		const { store, record, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store, { cancelled: true });

		await loop.recoverRestarted();

		expect(probes).toEqual([]);
		expect(store.listTurns(task.id)[0]!.error).toBe("tracker restarted");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("idle");
		// The dead cancel was redone: the worktree is gone and the card is idle.
		expect(record.removeWorktree).toHaveLength(1);
	});

	test("a running card with no turn row requeues without probing", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store, { noRow: true });

		await loop.recoverRestarted();

		expect(probes).toEqual([]);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(TRACKER_REASON);
		expect(after.pendingPrompt).toBe(RESTART_RESUME);
	});

	test("an ended pid-null row requeues without probing", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store);
		endRow(store, task.id, "earlier");

		await loop.recoverRestarted();

		expect(probes).toEqual([]);
		expect(store.listTurns(task.id)[0]!.error).toBe("earlier");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.pendingPrompt).toBe(RESTART_RESUME);
	});

	test("an ended row with a live pid requeues too", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store, { pid: 4344 });
		endRow(store, task.id, "earlier");

		await loop.recoverRestarted();

		expect(probes).toEqual([]);
		expect(store.listTurns(task.id)[0]!.error).toBe("earlier");
		expect(store.getTask(task.id)!.state).toBe("queued");
	});

	test("a null-worktree row is never probed; it keeps the lost settle", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store, { worktree: null });

		await loop.recoverRestarted();

		expect(probes).toEqual([]);
		expect(store.listTurns(task.id)[0]!.error).toBe("tracker restarted");
		expect(store.getTask(task.id)!.state).toBe("queued");
	});

	test("a missing worker target keeps the lost settle without probing", async () => {
		const store = freshStore();
		const record = baseRecord();
		const projects = new Map([[store.name, fakeProject(store)]]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				maxTotalRuns: () => 0,
				detachedRuns: async () => [run1(true)],
				// No workerTarget: the re-bind has nowhere to ask.
			}),
		);
		const task = row(store);

		await loop.recoverRestarted();

		expect(store.listTurns(task.id)[0]!.error).toBe("tracker restarted");
		expect(store.getTask(task.id)!.state).toBe("queued");
	});

	test("matchDetached asks workers in order and re-binds the first cwd match", async () => {
		const { store, loop, probes } = watchSetup(
			(_nth, url) => (url === URL_A ? [] : [run1(true)]),
			{ urls: [URL_A, URL_B] },
		);
		const task = row(store);

		await loop.recoverRestarted();

		expect(probes).toEqual([
			{ url: URL_A, token: "tok" },
			{ url: URL_B, token: "tok" },
		]);
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(logText(store, task.id)).toContain(
			"- re-bound detached run run-1 on worker-b:8787; the card stays running",
		);
	});

	test("a failing worker probe falls through to the next worker at recovery", async () => {
		const { store, loop, probes } = watchSetup(
			(_nth, url) => {
				if (url === URL_A) throw new Error("connection refused");
				return [finished1()];
			},
			{ urls: [URL_A, URL_B] },
		);
		const task = row(store);

		await loop.recoverRestarted();

		expect(probes).toEqual([
			{ url: URL_A, token: "tok" },
			{ url: URL_B, token: "tok" },
		]);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe(RESTART_ERROR);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(RESTART_REASON);
		expect(after.pendingPrompt).toBe(RESTART_RESUME);
	});

	test("an absent worker token probes with the empty token", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)], {
			token: null,
		});
		const task = row(store);

		await loop.recoverRestarted();
		expect(probes).toEqual([{ url: URL_A, token: "" }]);

		// The sweep's watcher poll probes with the same empty token.
		loop.schedule();
		await flushPromises();
		expect(probes).toEqual([
			{ url: URL_A, token: "" },
			{ url: URL_A, token: "" },
		]);
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
	});

	test("the lost scan leaves a re-bound row to its watcher", async () => {
		const { store, loop, probes } = watchSetup(() => [run1(true)]);
		const task = row(store);
		await loop.recoverRestarted();
		expect(probes).toHaveLength(1);

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.endedAt).toBeNull();
		expect(turn.error).toBeNull();
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("running");
		expect(after.needsReason).toBeNull();
		expect(probes).toHaveLength(2);
		expect(logText(store, task.id)).not.toContain("lost agent process");
	});

	test("a vanished run settles through the restart route and drops the watcher", async () => {
		const { store, loop, probes } = watchSetup((nth) =>
			nth === 0 ? [run1(true)] : [],
		);
		const task = row(store);
		await loop.recoverRestarted();

		loop.schedule();
		await flushPromises();

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe(RESTART_ERROR);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("queued");
		expect(after.needsReason).toBe(RESTART_REASON);
		expect(probes).toHaveLength(2);

		// The watcher is gone: no further probes, no second settle.
		loop.schedule();
		await flushPromises();
		expect(probes).toHaveLength(2);
		expect(store.listTurns(task.id)).toHaveLength(1);
	});

	test("a probe failure keeps its watcher while other rows settle", async () => {
		const { store, loop, probes } = watchSetup((nth) => {
			if (nth < 2) return [run1(true)];
			if (nth === 2) throw new Error("worker down mid-watch");
			return [finished1()];
		});
		const task1 = row(store);
		const task2 = row(store);
		await loop.recoverRestarted();
		expect(probes).toHaveLength(2);

		loop.schedule();
		await flushPromises();
		// The failed probe leaves its own row to its watcher; the other row settles.
		// (Watcher order follows the store's task order, so don't pin which is which.)
		const openId =
			store.listTurns(task1.id)[0]!.endedAt === null ? task1.id : task2.id;
		const settledId = openId === task1.id ? task2.id : task1.id;
		expect(store.listTurns(openId)[0]!.endedAt).toBeNull();
		expect(store.getTask(openId)!.state).toBe("running");
		expect(store.listTurns(settledId)[0]!.error).toBe(RESTART_ERROR);
		expect(store.getTask(settledId)!.state).toBe("queued");
		expect(probes).toHaveLength(4);

		// The kept watcher settles its row on the next tick.
		loop.schedule();
		await flushPromises();
		expect(store.listTurns(openId)[0]!.error).toBe(RESTART_ERROR);
		expect(store.getTask(openId)!.state).toBe("queued");
		expect(probes).toHaveLength(5);
	});

	test("a stale watcher on an ended row drops itself without a second settle", async () => {
		const { store, loop, probes } = watchSetup((nth) =>
			nth === 0 ? [run1(true)] : [finished1()],
		);
		const task = row(store);
		await loop.recoverRestarted();
		endRow(store, task.id, "manual");

		loop.schedule();
		await flushPromises();

		expect(store.listTurns(task.id)[0]!.error).toBe("manual");
		expect(probes).toHaveLength(2);

		loop.schedule();
		await flushPromises();
		expect(probes).toHaveLength(2);
	});

	test("a watcher whose project vanished drops itself without settling", async () => {
		const { store, projects, loop, probes } = watchSetup((nth) =>
			nth === 0 ? [run1(true)] : [finished1()],
		);
		const task = row(store);
		await loop.recoverRestarted();
		projects.delete(store.name);

		loop.schedule();
		await flushPromises();

		// The row is untouched: no project object exists to settle through.
		expect(store.listTurns(task.id)[0]!.endedAt).toBeNull();
		expect(store.getTask(task.id)!.state).toBe("running");
		expect(probes).toHaveLength(2);

		loop.schedule();
		await flushPromises();
		expect(probes).toHaveLength(2);
	});

	test("stop of a re-bound row works without a killDetached op", async () => {
		const { store, projects, loop } = watchSetup(() => [run1(true)], {
			kill: false,
		});
		const task = row(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await expect(loop.stopTurn(e, task.id)).resolves.toEqual({ ok: true });

		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe("stopped");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(STOP_REASON);
		expect(logText(store, task.id)).not.toContain("! stop killDetached");
	});

	test("a failed stop kill logs the failure and still parks the card", async () => {
		const { store, projects, loop, killed } = watchSetup(() => [run1(true)], {
			killError: "boom",
		});
		const task = row(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await expect(loop.stopTurn(e, task.id)).resolves.toEqual({ ok: true });

		expect(killed).toEqual([{ url: URL_A, token: "tok", id: "run-1" }]);
		const turn = store.listTurns(task.id)[0]!;
		expect(turn.error).toBe("stopped");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(STOP_REASON);
		expect(logText(store, task.id)).toContain("! stop killDetached: boom");
	});

	test("stop of an already-ended watched row keeps that row's error", async () => {
		const { store, projects, loop, probes, killed } = watchSetup(() => [
			run1(true),
		]);
		const task = row(store);
		await loop.recoverRestarted();
		endRow(store, task.id, "manual");
		const e = projects.get(store.name)!;

		await expect(loop.stopTurn(e, task.id)).resolves.toEqual({ ok: true });

		expect(store.listTurns(task.id)[0]!.error).toBe("manual");
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(killed).toEqual([{ url: URL_A, token: "tok", id: "run-1" }]);
		// The watcher is dropped with the stop: no further probes.
		loop.schedule();
		await flushPromises();
		expect(probes).toHaveLength(1);
	});

	test("cancel drops the watcher before any further probe", async () => {
		const { store, projects, loop, probes, killed } = watchSetup(() => [
			run1(true),
		]);
		const task = row(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await loop.cancel(e, task.id, true);

		expect(killed).toEqual([{ url: URL_A, token: "tok", id: "run-1" }]);
		expect(store.getTask(task.id)!.state).toBe("idle");
		expect(probes).toHaveLength(1);

		loop.schedule();
		await flushPromises();
		expect(probes).toHaveLength(1);
		expect(killed).toEqual([{ url: URL_A, token: "tok", id: "run-1" }]);
	});

	test("a failed cancel kill logs the failure and the cancel proceeds", async () => {
		const { store, projects, loop } = watchSetup(() => [run1(true)], {
			killError: "boom",
		});
		const task = row(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await expect(loop.cancel(e, task.id, true)).resolves.toEqual({
			removed: true,
		});

		expect(store.getTask(task.id)!.state).toBe("idle");
		expect(logText(store, task.id)).toContain("! cancel killDetached: boom");
	});

	test("cancel works without a killDetached op", async () => {
		const { store, projects, loop } = watchSetup(() => [run1(true)], {
			kill: false,
		});
		const task = row(store);
		await loop.recoverRestarted();
		const e = projects.get(store.name)!;

		await expect(loop.cancel(e, task.id, true)).resolves.toEqual({
			removed: true,
		});

		expect(store.getTask(task.id)!.state).toBe("idle");
		expect(logText(store, task.id)).not.toContain("! cancel killDetached");
	});

	test("a plain cancel of a live local run never touches the detach path", async () => {
		const { store, projects, loop, killed } = watchSetup(() => [run1(true)]);
		const task = store.createTask("local work");
		let kills = 0;
		loop.running.set(`${store.name}/${task.id}`, {
			pid: 4242,
			done: Promise.resolve(),
			kill: async () => {
				kills += 1;
			},
		});
		const e = projects.get(store.name)!;

		await loop.cancel(e, task.id, true);

		expect(kills).toBe(1);
		expect(killed).toEqual([]);
		expect(store.getTask(task.id)!.state).toBe("idle");
		// No detach-path error was logged: the task's log file was never even created.
		expect(existsSync(store.logPath(task.id))).toBe(false);
	});
});

describe("sync-commit hygiene (OTTR-531)", () => {
	/** A settled work turn with target origin/main on the project entry. */
	function targetedSetup(overrides: Partial<TurnOps> = {}) {
		const s = setup(overrides);
		s.projects.get(s.store.name)!.target = "origin/main";
		return s;
	}

	test("a settled outcome names a main checkout left on a foreign branch", async () => {
		const { store, loop } = targetedSetup({
			checkedOutBranch: async () => "ott/ottr-516-mean",
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.details).toContain(
			`Board: ${store.name}'s main checkout is on branch ott/ottr-516-mean, not main.`,
		);
	});

	test("a settled outcome names a local main that origin lacks", async () => {
		const { store, loop } = targetedSetup({
			branchUnpushed: async () => true,
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.details).toContain(
			`Board: ${store.name}'s local main has commits origin lacks.`,
		);
	});

	test("a clean main checkout adds no Board: line", async () => {
		const { store, loop } = targetedSetup();
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		expect(store.getTask(task.id)!.details ?? "").not.toContain("Board:");
	});

	test("pushSyncCommits on: the tick pushes once on the unpushed edge and lifts the hold", async () => {
		const calls: unknown[][] = [];
		const { store, projects, loop } = targetedSetup({
			branchUnpushed: async () => true,
			serverMergePush: async (...args: unknown[]) => {
				calls.push(args);
				return { status: "pushed" as const, output: "" };
			},
		});
		store.setSettings({ pushSyncCommits: true });
		const e = projects.get(store.name)!;
		loop.schedule();
		await flushPromises();

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			e.path,
			e.path,
			"origin/main",
			"",
			null,
			store.getSettings().originUrl,
		]);
		expect(e.mainUnpushed).toBe(false);
	});

	test("pushSyncCommits off: the tick never pushes", async () => {
		const calls: unknown[][] = [];
		const { loop } = setup({
			branchUnpushed: async () => true,
			serverMergePush: async (...args: unknown[]) => {
				calls.push(args);
				return { status: "pushed" as const, output: "" };
			},
		});
		loop.schedule();
		await flushPromises();

		expect(calls).toHaveLength(0);
	});
});

describe("turn PR-mode merge settle", () => {
	function prMergeSetup(overrides: Partial<TurnOps> = {}) {
		const record = baseRecord();
		const setup = setupWith(record, {
			prIntegrated: async () => true,
			targetSha: async (_m: string, ref: string) =>
				ref === "refs/heads/ott/m" ? "sha-tip" : "sha-old",
			pushBranch: async () => ({ status: "pushed" as const, output: "" }),
			openPr: async () => ({
				ok: true as const,
				pr: { number: 12, url: "https://github.com/acme/repo/pull/12" },
			}),
			serverMergePush: async () => {
				throw new Error("serverMergePush must not run in PR mode");
			},
			runMergeGates: async () => {
				throw new Error("merge gates must not run in PR mode");
			},
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "integrated",
								summary: "rebased",
								details: "gates green",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
			...overrides,
		});
		const e = setup.projects.get(setup.store.name)!;
		e.github = "https://github.com/acme/repo.git";
		setup.store.setSettings({
			prMode: true,
			originUrl: "https://github.com/acme/repo.git",
		});
		const task = setup.store.createTask("merge please");
		setup.store.updateTask(task.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		return { ...setup, e, task };
	}

	test("an integrated PR-mode merge pushes the branch and opens the PR", async () => {
		const pushes: unknown[][] = [];
		const opens: {
			repo: string;
			owner: string;
			branch: string;
			base: string;
			title: string;
			body: string;
		}[] = [];
		const { store, record, loop, task } = prMergeSetup({
			pushBranch: async (...args: unknown[]) => {
				pushes.push(args);
				return { status: "pushed" as const, output: "" };
			},
			openPr: async (o) => {
				opens.push(o);
				return {
					ok: true as const,
					pr: { number: 12, url: "https://github.com/acme/repo/pull/12" },
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(pushes).toEqual([
			[store.path, "ott/m", "https://github.com/acme/repo.git"],
		]);
		expect(opens).toHaveLength(1);
		expect(opens[0]).toMatchObject({
			repo: "acme/repo",
			owner: "acme",
			branch: "ott/m",
			base: "main",
			title: "merge please",
		});
		expect(opens[0]!.body).toContain("rebased");
		expect(opens[0]!.body).toContain("gates green");
		expect(opens[0]!.body).toContain(task.id);
		expect(opens[0]!.body).toContain("Ottr");
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(null);
		expect(after.prNumber).toBe(12);
		expect(after.prUrl).toBe("https://github.com/acme/repo/pull/12");
		expect(after.prHeadSha).toBe("sha-tip");
		expect(after.pushSha).toBe("sha-tip");
		// The done write never ran: the worktree stays.
		expect(record.removeWorktree).toHaveLength(0);
		expect(logText(store, task.id)).toContain("- PR #12 opened (base main)");
		// The merge prompt used the PR variant.
		expect(record.runs[0]!.prompt).toContain("opens the pull request");
		expect(record.runs[0]!.prompt).not.toContain("git merge --ff-only");
	});

	/** OTTR-760 source fields for a Dependabot PR #20; spread overrides per case. */
	function sourcePr(
		over: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			sourcePrNumber: 20,
			sourcePrUrl: "https://github.com/acme/repo/pull/20",
			sourcePrHeadRef: "dependabot/npm_and_yarn/vite-7.1.2",
			sourcePrHeadSha: "pr-head",
			sourcePrCrossRepo: false,
			sourcePrDependabot: true,
			...over,
		};
	}

	test("a clean Dependabot bump adopts its PR: no second PR opens (OTTR-760)", async () => {
		let opened = false;
		const { store, loop, task } = prMergeSetup({
			targetSha: async (_m: string, ref: string) =>
				ref === "refs/heads/ott/m" ? "pr-head" : "sha-old",
			pushBranch: async () => {
				throw new Error("pushBranch must not run for a clean source bump");
			},
			openPr: async () => {
				opened = true;
				return { ok: true as const, pr: { number: 99, url: null } };
			},
		});
		store.updateTask(task.id, sourcePr());
		await loop.runTurn(store.name, task.id);
		expect(opened).toBe(false);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(null);
		expect(after.prNumber).toBe(20);
		expect(after.prUrl).toBe("https://github.com/acme/repo/pull/20");
		expect(after.prHeadSha).toBe("pr-head");
		// The PR's CI runs on a head its author can rebase; the board watches the PR.
		expect(after.pushSha).toBe(null);
		expect(logText(store, task.id)).toContain(
			"- source PR #20 stays the card's PR",
		);
	});

	test("a cherry-picked clean bump with the same tree adopts its PR too (OTTR-760)", async () => {
		let opened = false;
		const { store, loop, task } = prMergeSetup({
			targetSha: async (_m: string, ref: string) =>
				ref === "refs/heads/ott/m" ? "sha-cherry" : "sha-old",
			treesEqual: async (_m: string, a: string, b: string) =>
				a === "pr-head" && b === "sha-cherry",
			openPr: async () => {
				opened = true;
				return { ok: true as const, pr: { number: 99, url: null } };
			},
		});
		store.updateTask(task.id, sourcePr());
		await loop.runTurn(store.name, task.id);
		expect(opened).toBe(false);
		const after = store.getTask(task.id)!;
		expect(after.prNumber).toBe(20);
		expect(after.prHeadSha).toBe("pr-head");
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
	});

	test("fixes on a cross-repo source PR park with the PR named and never open a PR (OTTR-760)", async () => {
		const comments: { repo: string; number: number; body: string }[] = [];
		let opened = false;
		const { store, loop, task } = prMergeSetup({
			targetSha: async (_m: string, ref: string) =>
				ref === "refs/heads/ott/m" ? "sha-fixed" : "sha-old",
			targetContains: async (_m: string, sha: string, tip: string) =>
				sha === "pr-head" && tip === "sha-fixed",
			treesEqual: async () => false,
			pushBranch: async () => {
				throw new Error("pushBranch must not run for a cross-repo source PR");
			},
			openPr: async () => {
				opened = true;
				return { ok: true as const, pr: { number: 99, url: null } };
			},
			prComment: async (o) => {
				comments.push(o);
				return { ok: true as const };
			},
		});
		store.updateTask(
			task.id,
			sourcePr({ sourcePrCrossRepo: true, sourcePrDependabot: false }),
		);
		await loop.runTurn(store.name, task.id);
		expect(opened).toBe(false);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("source PR #20");
		expect(after.needsReason).toContain("https://github.com/acme/repo/pull/20");
		expect(after.prNumber).toBe(null);
		expect(comments).toEqual([
			{
				repo: "acme/repo",
				number: 20,
				body: expect.stringContaining("ott/m"),
			},
		]);
	});

	test("fixes on a Dependabot PR comment @dependabot rebase instead of pushing (OTTR-760)", async () => {
		const comments: { repo: string; number: number; body: string }[] = [];
		const { store, loop, task } = prMergeSetup({
			targetSha: async (_m: string, ref: string) =>
				ref === "refs/heads/ott/m" ? "sha-fixed" : "sha-old",
			targetContains: async (_m: string, sha: string, tip: string) =>
				sha === "pr-head" && tip === "sha-fixed",
			treesEqual: async () => false,
			pushBranch: async () => {
				throw new Error("pushBranch must never push to a Dependabot branch");
			},
			openPr: async () => {
				throw new Error("openPr must not run for a source-PR card");
			},
			prComment: async (o) => {
				comments.push(o);
				return { ok: true as const };
			},
		});
		store.updateTask(task.id, sourcePr());
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("@dependabot");
		expect(comments).toEqual([
			{ repo: "acme/repo", number: 20, body: "@dependabot rebase" },
		]);
	});

	test("fixes on a same-repo source PR push to its head branch, no new PR (OTTR-760)", async () => {
		const pushes: unknown[][] = [];
		let opened = false;
		const { store, loop, task } = prMergeSetup({
			targetSha: async (_m: string, ref: string) =>
				ref === "refs/heads/ott/m" ? "sha-fixed" : "sha-old",
			targetContains: async (_m: string, sha: string, tip: string) =>
				sha === "pr-head" && tip === "sha-fixed",
			treesEqual: async () => false,
			pushBranch: async (...args: unknown[]) => {
				pushes.push(args);
				return { status: "pushed" as const, output: "" };
			},
			openPr: async () => {
				opened = true;
				return { ok: true as const, pr: { number: 99, url: null } };
			},
		});
		store.updateTask(
			task.id,
			sourcePr({
				sourcePrDependabot: false,
				sourcePrHeadRef: "contrib/fix-branch",
			}),
		);
		await loop.runTurn(store.name, task.id);
		expect(opened).toBe(false);
		expect(pushes).toEqual([
			[
				store.path,
				"ott/m",
				"https://github.com/acme/repo.git",
				"contrib/fix-branch",
			],
		]);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.prNumber).toBe(20);
		expect(after.prHeadSha).toBe("sha-fixed");
	});

	test("a failed branch push parks merging/needs_you and never opens the PR", async () => {
		let opened = false;
		const { store, loop, task } = prMergeSetup({
			pushBranch: async () => ({
				status: "failed" as const,
				error: "fatal: [REDACTED] denied",
				output: "fatal: [REDACTED] denied",
			}),
			openPr: async () => {
				opened = true;
				return { ok: true as const, pr: { number: 1, url: null } };
			},
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("fatal: [REDACTED] denied");
		expect(after.prNumber).toBe(null);
		expect(opened).toBe(false);
		expect(logText(store, task.id)).toContain("git's full push output");
	});

	test("a failed gh call parks merging/needs_you with the gh error", async () => {
		const { store, loop, task } = prMergeSetup({
			openPr: async () => ({
				ok: false as const,
				error: "HTTP 422: Validation Failed",
			}),
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("HTTP 422: Validation Failed");
		expect(after.prNumber).toBe(null);
	});

	test("an unproven integration ships nothing and parks not-on-target", async () => {
		const { store, loop, task } = prMergeSetup({
			prIntegrated: async () => false,
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("not on origin/main");
		expect(after.prNumber).toBe(null);
	});

	test("a card already carrying a PR never re-ships", async () => {
		const pushes: unknown[][] = [];
		const { store, loop, task } = prMergeSetup({
			pushBranch: async (...args: unknown[]) => {
				pushes.push(args);
				return { status: "pushed" as const, output: "" };
			},
		});
		store.updateTask(task.id, { prNumber: 12 });
		await loop.runTurn(store.name, task.id);
		expect(pushes).toHaveLength(0);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(null);
		expect(after.prNumber).toBe(12);
	});

	test("a needs_you report never ships even with a clean rebased tree", async () => {
		const pushes: unknown[][] = [];
		const { store, record, loop, task } = prMergeSetup({
			pushBranch: async (...args: unknown[]) => {
				pushes.push(args);
				return { status: "pushed" as const, output: "" };
			},
			openPr: async () => {
				throw new Error("openPr must not run for a needs_you report");
			},
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "needs_you",
								summary: "blocking finding",
								question:
									"A high finding blocks the ship: rotate the leaked key first.",
							} satisfies Outcome,
						}),
					),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		expect(pushes).toHaveLength(0);
		const after = store.getTask(task.id)!;
		// classify parks the card with the agent's question; the ship step and
		// its prNext override never ran.
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("rotate the leaked key first");
		expect(after.prNumber).toBe(null);
	});

	test("a merge turn without a receipt parks instead of landing or shipping", async () => {
		const { store, record, loop, task } = prMergeSetup({
			pushBranch: async () => {
				throw new Error("pushBranch must not run without a receipt");
			},
			openPr: async () => {
				throw new Error("openPr must not run without a receipt");
			},
			startRun: (o: { prompt: string; onSession?: (sid: string) => void }) => {
				record.runs.push(o as never);
				o.onSession?.("sess-1");
				return {
					pid: 4242,
					done: Promise.resolve(runResult({})),
					kill: async () => {},
				};
			},
		});
		await loop.runTurn(store.name, task.id);
		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("without calling report_outcome");
		expect(after.prNumber).toBe(null);
	});

	test("a PR-mode project schedules its queued merge even with main unpushed", async () => {
		const record = baseRecord();
		const s = setupWith(record, {
			prIntegrated: async () => true,
			pushBranch: async () => ({ status: "pushed" as const, output: "" }),
			openPr: async () => ({
				ok: true as const,
				pr: { number: 12, url: null },
			}),
		});
		const e = s.projects.get(s.store.name)!;
		e.github = "https://github.com/acme/repo.git";
		e.mainUnpushed = true;
		s.store.setSettings({ prMode: true });
		const task = s.store.createTask("merge please");
		s.store.updateTask(task.id, {
			stage: "merging",
			state: "queued",
			worktree: "wt-m",
			branch: "ott/m",
		});
		s.loop.schedule();
		await flushPromises();
		expect(record.runs).toHaveLength(1);
		expect(record.runs[0]!.prompt).toContain("opens the pull request");
	});
});

describe("microVM dispatch (OTTR-532)", () => {
	const VM_URL = "http://vm-runner:8787";
	const savedHealth = vmState.health;
	afterEach(() => {
		vmState.health = savedHealth;
		vmState.busy.clear();
		setSystemTime();
	});

	type RunOpts = Parameters<TurnOps["startRun"]>[0];

	/** A microVM project whose fake vm-runner answers with `answer` (mutable per test). */
	function vmSetup(overrides: Partial<TurnOps> = {}, microVm = true) {
		vmState.health = { configured: true, ok: true, reason: null };
		const calls: RunOpts[] = [];
		const envModels: (string | null)[] = [];
		const synced: [string, string][] = [];
		const tokens = new VmTokens({ file: null });
		const answer = {
			accepted: true,
			result: runResult({
				outcome: { status: "answered", summary: "done" },
			}),
		};
		const s = setup({
			// Cap 0: the settle's own schedule() starts no follow-up turn behind the test.
			maxTotalRuns: () => 0,
			commitsAhead: async () => 0,
			workerTarget: { urls: ["http://worker-a:8787"], token: "tok" },
			vmTarget: { urls: [VM_URL], token: "tok" },
			vmTokens: tokens,
			syncWorktreeTo: async (wt, sha) => {
				synced.push([wt, sha]);
			},
			turnEnv: async (_project, model) => {
				envModels.push(model);
				return { env: {}, missing: [] };
			},
			startRun: (o: RunOpts) => {
				calls.push(o);
				if (answer.accepted) o.onSession?.("sess-1");
				const target = o.vm?.target ?? o.worker ?? null;
				return {
					pid: target === null ? 4242 : null,
					...(target === null ? {} : { url: target.urls[0]! }),
					done: Promise.resolve(answer.result),
					...(o.vm ? { accepted: Promise.resolve(answer.accepted) } : {}),
					kill: async () => {},
				};
			},
			...overrides,
		});
		s.store.setSettings({ microVm });
		return { ...s, calls, envModels, synced, tokens, answer };
	}

	test("an eligible work turn goes to vm-runner only, lent nothing", async () => {
		const { store, loop, calls, envModels } = vmSetup();
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.vm?.target.urls).toEqual([VM_URL]);
		expect(calls[0]!.worker ?? null).toBeNull();
		const card = store.getTask(task.id)!;
		expect(calls[0]!.vm?.grant).toEqual({
			project: store.name,
			taskId: task.id,
			branch: card.branch!,
			repoPath: store.path,
			worktree: card.worktree!,
		});
		expect(calls[0]!.cwd).toBe(card.worktree!);
		// No provider token is lent to a microVM turn: turnEnv gets no model.
		expect(envModels).toEqual([null]);
	});

	test("microVM mode off keeps the classic worker pool", async () => {
		const { store, loop, calls, envModels } = vmSetup({}, false);
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.vm ?? null).toBeNull();
		expect(calls[0]!.worker?.urls).toEqual(["http://worker-a:8787"]);
		expect(envModels).toEqual(["fake/default-model"]);
	});

	test("a merge turn of a microVM project stays on the server", async () => {
		const { store, loop, calls } = vmSetup({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
		});
		const merge = store.createTask("merge please");
		store.updateTask(merge.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(store.name, merge.id);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.vm ?? null).toBeNull();
		expect(calls[0]!.worker ?? null).toBeNull();
	});

	test("a grill turn (main checkout) of a microVM project keeps the classic pool", async () => {
		const { store, loop, calls } = vmSetup();
		const idea = store.createTask("an idea");
		store.updateTask(idea.id, { stage: "backlog" });
		await loop.runTurn(store.name, idea.id);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.vm ?? null).toBeNull();
		expect(calls[0]!.cwd).toBe(store.path);
		expect(calls[0]!.worker?.urls).toEqual(["http://worker-a:8787"]);
	});

	test("a runner that is down leaves the card queued and unclaimed, with no fallback", async () => {
		const { store, loop, calls } = vmSetup();
		vmState.health = {
			configured: true,
			ok: false,
			reason: "connection refused",
		};
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(0);
		const card = store.getTask(task.id)!;
		expect(card.state).toBe("queued");
		expect(card.worktree).toBeNull();
		expect(store.listTurns(task.id)).toHaveLength(0);
	});

	test("a drained vm-runner defers the turn while the classic pool stays untouched", async () => {
		const { store, loop, calls } = vmSetup({
			drainedRunner: (id) => id === "vm-runner",
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(0);
		expect(store.getTask(task.id)!.state).toBe("queued");
	});

	test("busy requeues the card as it was, outside the lost streak; the next dispatch clears the mark", async () => {
		const { store, loop, calls, answer } = vmSetup();
		const task = store.createTask("queued work");
		store.updateTask(task.id, {
			pendingPrompt: "also fix the docs",
			pendingBy: "user",
		});
		answer.accepted = false;
		answer.result = runResult({
			exitCode: null,
			sessionId: null,
			workerBusy: true,
		});
		const key = `${store.name}/${task.id}`;
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(1);
		let card = store.getTask(task.id)!;
		expect(card.state).toBe("queued");
		expect(card.needsReason).toBeNull();
		expect(card.pendingPrompt).toBe("also fix the docs");
		expect(card.pendingBy).toBe("user");
		// Nothing ran: no turn row, so no lost-worker streak can count it.
		expect(store.listTurns(task.id)).toHaveLength(0);
		expect(vmState.busy.has(key)).toBe(true);

		// Inside the backoff the card is not even claimed.
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(1);
		expect(store.getTask(task.id)!.state).toBe("queued");

		setSystemTime(new Date(Date.now() + VM_BUSY_RETRY_MS + 1));
		answer.accepted = true;
		answer.result = runResult({
			outcome: { status: "answered", summary: "done" },
		});
		await loop.runTurn(store.name, task.id);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.vm?.target.urls).toEqual([VM_URL]);
		expect(vmState.busy.has(key)).toBe(false);
		card = store.getTask(task.id)!;
		expect(store.listTurns(task.id)).toHaveLength(1);
		expect(store.listTurns(task.id)[0]!.input).toBe("also fix the docs");
	});

	test("a dirty VM tree refuses ready and names its files, whatever the server worktree says", async () => {
		const { store, loop, answer, synced } = vmSetup({
			commitsAhead: async () => 1,
			// The server worktree looks clean; only the VM's report may decide.
			isClean: async () => true,
			targetSha: async (_path: string, ref: string) =>
				ref.startsWith("refs/heads/")
					? "b".repeat(40)
					: ref === "HEAD"
						? "a".repeat(40)
						: null,
		});
		answer.result = runResult({
			outcome: { status: "ready", summary: "done" },
			vm: {
				head: "b".repeat(40),
				pushError: null,
				dirty: [" M src/a.ts", "?? notes.txt"],
			},
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		const card = store.getTask(task.id)!;
		expect(card.state).toBe("needs_you");
		expect(card.needsReason).toContain("M src/a.ts");
		expect(card.needsReason).toContain("?? notes.txt");
		expect(synced).toEqual([[card.worktree!, "b".repeat(40)]]);
	});

	test("a clean VM outcome syncs the worktree to the branch tip and goes to merging", async () => {
		const { store, loop, answer, synced } = vmSetup({
			commitsAhead: async () => 1,
			// A stale server tree must not block a VM whose own tree was clean.
			isClean: async () => false,
			targetSha: async (_path: string, ref: string) =>
				ref.startsWith("refs/heads/")
					? "c".repeat(40)
					: ref === "HEAD"
						? "a".repeat(40)
						: null,
		});
		answer.result = runResult({
			outcome: { status: "ready", summary: "done" },
			vm: { head: "c".repeat(40), pushError: null, dirty: [] },
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		const card = store.getTask(task.id)!;
		expect(synced).toEqual([[card.worktree!, "c".repeat(40)]]);
		expect(card.stage).toBe("merging");
		expect(card.state).toBe("queued");
	});

	test("a VM that never pushed leaves a worktree already at the branch tip alone", async () => {
		const { store, loop, answer, synced } = vmSetup({
			targetSha: async (_path: string, ref: string) =>
				ref.startsWith("refs/heads/") || ref === "HEAD" ? "a".repeat(40) : null,
		});
		answer.result = runResult({
			outcome: { status: "answered", summary: "done" },
			vm: { head: null, pushError: "auth failed", dirty: [] },
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(synced).toEqual([]);
		expect(logText(store, task.id)).toContain(
			"microVM push failed: auth failed",
		);
	});

	test("a VM claiming a foreign head syncs to the real branch tip and logs the mismatch", async () => {
		const tip = "d".repeat(40);
		const foreign = "e".repeat(40);
		const { store, loop, answer, synced } = vmSetup({
			targetSha: async (path: string, ref: string) =>
				path === store.path && ref.startsWith("refs/heads/")
					? tip
					: ref === "HEAD"
						? "a".repeat(40)
						: null,
		});
		answer.result = runResult({
			outcome: { status: "answered", summary: "done" },
			vm: { head: foreign, pushError: null, dirty: [] },
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		const card = store.getTask(task.id)!;
		expect(synced).toEqual([[card.worktree!, tip]]);
		expect(logText(store, task.id)).toContain(
			`! microVM: reported head ${foreign} is not the branch tip ${tip}`,
		);
	});

	test("a VM whose branch does not resolve leaves the worktree unsynced and says so", async () => {
		const { store, loop, answer, synced } = vmSetup();
		answer.result = runResult({
			outcome: { status: "answered", summary: "done" },
			vm: { head: "f".repeat(40), pushError: null, dirty: [] },
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		expect(synced).toEqual([]);
		expect(logText(store, task.id)).toContain(
			"does not resolve; the worktree is not synced",
		);
	});

	test("a lost VM settles as a lost worker", async () => {
		const { store, loop, answer } = vmSetup();
		answer.result = runResult({
			exitCode: null,
			workerLost: true,
			stderrTail: "worker connection lost",
		});
		const task = store.createTask("queued work");
		await loop.runTurn(store.name, task.id);
		const card = store.getTask(task.id)!;
		expect(card.state).toBe("queued");
		expect(card.needsReason).toContain(WORKER_LOST);
		expect(card.pendingPrompt).toBe(".");
	});

	describe("token revoke at the restart settle", () => {
		const WT = "/srv/wt-vm";
		function seeded(store: ProjectStore) {
			const task = store.createTask("work please");
			store.updateTask(task.id, {
				state: "running",
				stage: "in_progress",
				sessionId: "sess-9",
				worktree: WT,
				branch: "ott/x",
			});
			store.startTurn(task.id, "work", "old prompt", null);
			return task;
		}
		const grantFor = (store: ProjectStore, id: string) => ({
			project: store.name,
			taskId: id,
			branch: "ott/x",
			repoPath: store.path,
			worktree: WT,
		});

		test("a still-running detached VM turn keeps its token across the restart", async () => {
			const { store, loop, tokens } = vmSetup({
				workerTarget: null,
				detachedRuns: async (url) =>
					url === VM_URL
						? [{ id: "run-1", cwd: WT, pid: null, running: true, startedAt: 1 }]
						: [],
			});
			const task = seeded(store);
			const raw = tokens.issue(grantFor(store, task.id));
			await loop.recoverRestarted();
			expect(store.getTask(task.id)!.state).toBe("running");
			expect(tokens.check(raw)).not.toBeNull();
		});

		test("a finished detached VM turn settles and its token dies", async () => {
			const runs: DetachedRun[] = [
				{
					id: "run-1",
					cwd: WT,
					pid: null,
					running: false,
					startedAt: 1,
					result: { exitCode: 0, stderrTail: "" },
				},
			];
			const { store, loop, tokens } = vmSetup({
				workerTarget: null,
				targetSha: async () => "abc123def",
				detachedRuns: async (url) => (url === VM_URL ? runs : []),
			});
			const task = seeded(store);
			const raw = tokens.issue(grantFor(store, task.id));
			await loop.recoverRestarted();
			expect(store.getTask(task.id)!.state).toBe("queued");
			expect(tokens.check(raw)).toBeNull();
		});
	});
});

describe("writeVmFiles", () => {
	test("writes the report and shots/ into the worktree; refuses every other path", () => {
		const wt = mkdtempSync(join(tmpdir(), "ottr-vmfiles-"));
		const outside = mkdtempSync(join(tmpdir(), "ottr-vmfiles-out-"));
		mkdirSync(join(wt, "src"));
		mkdirSync(join(wt, "shots"));
		symlinkSync(outside, join(wt, "shots", "link"));
		const b64 = (s: string) => Buffer.from(s).toString("base64");
		const logs: string[] = [];
		writeVmFiles(
			wt,
			[
				{ path: "research-report.md", b64: b64("# Report\n") },
				{ path: "shots/sub/a.png", b64: b64("png") },
				{ path: "../x", b64: b64("x") },
				{ path: "/etc/x", b64: b64("x") },
				{ path: "src/x.ts", b64: b64("x") },
				{ path: "shots/../src/y.ts", b64: b64("x") },
				{ path: "shots/link/evil.png", b64: b64("x") },
			],
			(l) => logs.push(l),
		);
		expect(readFileSync(join(wt, "research-report.md"), "utf8")).toBe(
			"# Report\n",
		);
		expect(readFileSync(join(wt, "shots", "sub", "a.png"), "utf8")).toBe("png");
		expect(existsSync(join(dirname(wt), "x"))).toBe(false);
		expect(existsSync(join(wt, "src", "x.ts"))).toBe(false);
		expect(existsSync(join(wt, "src", "y.ts"))).toBe(false);
		expect(readdirSync(outside)).toEqual([]);
		expect(logs).toHaveLength(5);
		rmSync(wt, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});
});

// OTTR-708: the cross-project checkout guard. A work turn snapshots every other project's
// main checkout before its agent runs and re-checks it at settle; a commit the board did
// not push, or a status change, parks the card needs_you. The card's own project and
// gitless projects are skipped, and a HEAD advance the board itself pushed with a clean
// tree is discounted.
describe("turn checkout guard (other projects)", () => {
	type Snap = { head: string | null; status: string };

	/** Two-project loop whose checkoutState fake reads a mutable per-path state map. */
	function twoProjectCase(
		overrides: Partial<TurnOps> = {},
		extra: TurnProject[] = [],
	) {
		const record = baseRecord();
		const store = freshStore();
		const other = freshStore();
		const states = new Map<string, Snap>();
		const projects = new Map<string, TurnProject>([
			[store.name, fakeProject(store)],
			[other.name, fakeProject(other)],
			...extra.map((p) => [p.name, p] as const),
		]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				checkoutState: async (path: string) =>
					states.get(path) ?? { head: "base0", status: "" },
				...overrides,
			}),
		);
		return { store, other, record, states, loop };
	}

	/** startRun override that changes the other checkout mid-run, then answers. */
	function changingRun(record: Recorded, change: () => void): Partial<TurnOps> {
		return {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				change();
				o.onSession?.("sess-1");
				const isFirstRun = record.runs.length === 1;
				return {
					pid: 4242,
					done: Promise.resolve(
						isFirstRun
							? runResult({
									outcome: {
										status: "answered",
										summary: "did it",
									} satisfies Outcome,
								})
							: // The chained merge turn (isIntegrated defaults true): reports integrated
								// so the settle completes to done/idle instead of parking on a
								// misreported outcome.
								runResult({
									outcome: {
										status: "integrated",
										summary: "landed",
									} satisfies Outcome,
								}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		};
	}

	test("a work turn whose other project gains a commit and a dirty file parks needs_you", async () => {
		const record = baseRecord();
		const { store, other, states, loop } = twoProjectCase({
			commitMeta: async () => [
				{
					sha: "abc1234",
					subject: "add widget",
					time: Date.now(),
					files: ["src/widget.ts"],
				},
			],
			...changingRun(record, () => {
				states.set(other.path, {
					head: "abc1234",
					status: " M src/widget.ts",
				});
			}),
		});
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(other.name);
		expect(after.needsReason).toContain("abc1234 add widget");
		expect(after.needsReason).toContain("src/widget.ts");
		expect(after.needsReason).toContain("create_task");
	});

	test("a work turn that leaves the other checkouts untouched settles without parking", async () => {
		// Filing a card in the other project goes through the board API: no git change,
		// so the snapshots read identical and the guard stays silent.
		const record = baseRecord();
		const { store, loop } = twoProjectCase(changingRun(record, () => {}));
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);
		// The chained merge turn settles asynchronously; drain it before reading the row.
		await flushPromises();

		const after = store.getTask(task.id)!;
		// The settled end state (not merely "no needs_you"): the work turn settles to
		// merging/queued, the chained merge turn lands it, done/idle.
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
	});

	test("a board-made merge advance of the other project with a clean tree does not park", async () => {
		// The merge turn reports integrated (it lands and pushes); the later work turn
		// reports answered and moves the other checkout to the merged head mid-run.
		let workRun = false;
		const integrated = () => ({
			pid: 4242,
			done: Promise.resolve(
				runResult({
					outcome: {
						status: "integrated",
						summary: "landed",
					} satisfies Outcome,
				}),
			),
			kill: async () => {},
		});
		const { store, other, record, states, loop } = twoProjectCase({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			serverMergePush: async () => ({
				status: "pushed" as const,
				output: "",
			}),
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				if (!workRun) return integrated();
				states.set(other.path, { head: "merged9", status: "" });
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		// The other project's merge turn lands first: its settle push records the head the
		// board itself moved the main checkout to.
		states.set(other.path, { head: "merged9", status: "" });
		const mergeTask = other.createTask("merge please");
		other.updateTask(mergeTask.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(other.name, mergeTask.id);
		await flushPromises();

		// Back at the pre-merge head; the work turn's agent moves it to the merged head
		// again. The recorded board push discounts the advance.
		states.delete(other.path);
		workRun = true;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	test("a merge whose push fails still discounts the head the merge agent advanced", async () => {
		// The merge agent fast-forwards the other project's main checkout before the
		// settle's push; a failed push must still record that advanced head, or the guard
		// of a concurrent work turn parks on the board's own merge.
		let workRun = false;
		const integrated = () => ({
			pid: 4242,
			done: Promise.resolve(
				runResult({
					outcome: {
						status: "integrated",
						summary: "landed",
					} satisfies Outcome,
				}),
			),
			kill: async () => {},
		});
		const { store, other, record, states, loop } = twoProjectCase({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			serverMergePush: async () => ({
				status: "failed" as const,
				error: "auth failed",
			}),
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				if (!workRun) return integrated();
				states.set(other.path, { head: "failed9", status: "" });
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		states.set(other.path, { head: "failed9", status: "" });
		const mergeTask = other.createTask("merge please");
		other.updateTask(mergeTask.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(other.name, mergeTask.id);
		await flushPromises();

		// The work turn's agent moves the other checkout to the advanced head again; the
		// failed push's recording still discounts it.
		states.delete(other.path);
		workRun = true;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	test("an in-flight merge turn of the other project discounts its head advance", async () => {
		// While the other project's own merge turn runs, its agent fast-forwards its main
		// checkout legitimately; the guard skips the project until that turn is over.
		const record = baseRecord();
		const { store, other, states, loop } = twoProjectCase({
			...changingRun(record, () => {
				states.set(other.path, { head: "midmerge", status: "" });
			}),
		});
		const mergeTask = other.createTask("merge please");
		other.updateTask(mergeTask.id, {
			stage: "merging",
			state: "running",
			worktree: "wt-m",
			branch: "ott/m",
		});
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);
		await flushPromises();

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	test("a refused push after the merge agent's fast-forward still records the head", async () => {
		// A parked held merge pins the branch tip: the settle refuses the push outright
		// (runPush returns failed before any server call). The merge agent already
		// fast-forwarded the main checkout, so the end-of-settle record must still
		// capture the head it left behind.
		let workRun = false;
		const integrated = () => ({
			pid: 4242,
			done: Promise.resolve(
				runResult({
					outcome: {
						status: "integrated",
						summary: "landed",
					} satisfies Outcome,
				}),
			),
			kill: async () => {},
		});
		const { store, other, record, states, loop } = twoProjectCase({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			serverMergePush: async () => ({
				status: "pushed" as const,
				output: "",
			}),
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				if (!workRun) return integrated();
				states.set(other.path, { head: "refused9", status: "" });
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		// The merge agent's fast-forward result, plus a parked held merge whose holdHead
		// pins the branch tip the settle reads.
		states.set(other.path, { head: "refused9", status: "" });
		const parked = other.createTask("held please");
		other.updateTask(parked.id, {
			state: "needs_you",
			holdHead: "sha-pushed",
			needsReason: MERGE_HOLD_MISMATCH_REASON,
		});
		const mergeTask = other.createTask("merge please");
		other.updateTask(mergeTask.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(other.name, mergeTask.id);
		await flushPromises();
		// The refusal path ran: the merge card parked on the held merge, not on a push.
		const mergeAfter = other.getTask(mergeTask.id)!;
		expect(mergeAfter.needsReason).toContain("parks a held merge");

		states.delete(other.path);
		workRun = true;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	test("a merge-hold park that resets the branch still records the head the settle left", async () => {
		// The merge agent fast-forwarded the main checkout beyond the approved head; the
		// settle parks on the mismatch and resetBranchTo moves the main checkout back to
		// the audited tip. No push runs at all, and the reset's head must still be
		// recorded.
		let workRun = false;
		const integrated = () => ({
			pid: 4242,
			done: Promise.resolve(
				runResult({
					outcome: {
						status: "integrated",
						summary: "landed",
					} satisfies Outcome,
				}),
			),
			kill: async () => {},
		});
		const { store, other, record, states, loop } = twoProjectCase({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			mergeHoldMismatch: async () => ({
				mismatch: true,
				pushDiff: null,
				auditedTip: "audited9",
			}),
			resetBranchTo: async () => {
				// The settle reset the checked-out branch in the main checkout: HEAD moved
				// back to the audited tip.
				states.set(other.path, { head: "audited9", status: "" });
				return true;
			},
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				if (!workRun) return integrated();
				states.set(other.path, { head: "audited9", status: "" });
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		// The merge agent's fast-forward left the main checkout at its own head before
		// the settle judged it against the approved head.
		states.set(other.path, { head: "mismatch9", status: "" });
		const mergeTask = other.createTask("merge please");
		other.updateTask(mergeTask.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
			updateMergeHead: "approved9",
		});
		await loop.runTurn(other.name, mergeTask.id);
		await flushPromises();
		// The mismatch park ran and the reset moved the head to the audited tip.
		const mergeAfter = other.getTask(mergeTask.id)!;
		expect(mergeAfter.needsReason).toBe(MERGE_HOLD_MISMATCH_REASON);
		expect(mergeAfter.holdHead).toBe("sha-pushed");

		states.delete(other.path);
		workRun = true;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	test("a throwing serverMergePush still records the head the merge agent advanced", async () => {
		// serverMergePush rejects (the push chain jumps to its catch); the merge agent's
		// fast-forward still left the advanced head behind, and the end-of-settle record
		// must capture it.
		let workRun = false;
		const integrated = () => ({
			pid: 4242,
			done: Promise.resolve(
				runResult({
					outcome: {
						status: "integrated",
						summary: "landed",
					} satisfies Outcome,
				}),
			),
			kill: async () => {},
		});
		const { store, other, record, states, loop } = twoProjectCase({
			isIntegrated: async () => true,
			targetSha: async () => "sha-pushed",
			serverMergePush: async () => {
				throw new Error("remote hung up");
			},
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				if (!workRun) return integrated();
				states.set(other.path, { head: "threw9", status: "" });
				return {
					pid: 4243,
					done: Promise.resolve(
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		});
		states.set(other.path, { head: "threw9", status: "" });
		const mergeTask = other.createTask("merge please");
		other.updateTask(mergeTask.id, {
			stage: "merging",
			worktree: "wt-m",
			branch: "ott/m",
		});
		await loop.runTurn(other.name, mergeTask.id);
		await flushPromises();

		states.delete(other.path);
		workRun = true;
		const task = store.createTask("work please");
		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	test("an unrecorded HEAD advance with a clean tree parks needs_you", async () => {
		const record = baseRecord();
		const { store, other, states, loop } = twoProjectCase(
			changingRun(record, () => {
				states.set(other.path, { head: "stealth9", status: "" });
			}),
		);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(other.name);
		expect(after.needsReason).toContain("moved to stealth");
	});

	test("own-project changes and gitless projects are skipped", async () => {
		const gitlessStore = freshStore();
		const record = baseRecord();
		const { store, states, loop } = twoProjectCase(
			changingRun(record, () => {
				// The card's own project and the gitless project both change mid-run;
				// the guard must stay silent for both.
				states.set(store.path, { head: "own9", status: " M src/x.ts" });
				states.set(gitlessStore.path, {
					head: "git9",
					status: "?? scratch.txt",
				});
			}),
			[{ ...fakeProject(gitlessStore), gitless: true }],
		);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);

		const after = store.getTask(task.id)!;
		expect(after.state).not.toBe("needs_you");
		expect(after.needsReason).toBeNull();
	});

	// OTTR-763: attribution. The guard parks a card only when its turn window alone
	// overlaps the change it saw in another project's checkout. When two or more turns
	// overlap the change, neither card parks: the board logs the change once and rings
	// one notice that names the commit and the running cards. A work turn whose change
	// touches only its own project's provisioned copies (projects/<project>/) is the
	// AGENTS.md sync rule's commit and is exempt outright.

	/** Three-project case for attribution: `store` (innocent), `guilty` (the turn that
	 * changes the watched checkout), and `shared` (the watched checkout both guards
	 * read, like agent-data on the real board). Pass `record` when the overrides need
	 * the same Recorded the loop's fakes write to. */
	function threeProjectCase(
		overrides: Partial<TurnOps> = {},
		record: Recorded = baseRecord(),
	) {
		const store = freshStore();
		const guilty = freshStore();
		const shared = freshStore();
		const states = new Map<string, Snap>();
		const projects = new Map<string, TurnProject>([
			[store.name, fakeProject(store)],
			[guilty.name, fakeProject(guilty)],
			[shared.name, fakeProject(shared)],
		]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				checkoutState: async (path: string) =>
					states.get(path) ?? { head: "base0", status: "" },
				...overrides,
			}),
		);
		return { store, guilty, shared, record, states, loop };
	}

	/** Two overlapping work runs. Each project's first run is its work run: both work
	 * runs wait until both are live, then the second one fires `change` while both turn
	 * windows hold. The chained merge run of a settled card reports integrated. */
	function overlappingRuns(
		record: Recorded,
		change: (at: number) => void,
	): Partial<TurnOps> {
		const seen = new Set<string>();
		let entered = 0;
		const bothIn = Promise.withResolvers<void>();
		const changed = Promise.withResolvers<void>();
		return {
			startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
				record.runs.push(o);
				o.onSession?.("sess-1");
				const key = o.board?.project ?? o.cwd;
				if (seen.has(key)) {
					return {
						pid: 4243,
						done: Promise.resolve(
							runResult({
								outcome: {
									status: "integrated",
									summary: "landed",
								} satisfies Outcome,
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				}
				seen.add(key);
				entered += 1;
				const second = entered === 2;
				const done = (async () => {
					if (second) {
						bothIn.resolve();
						// OTTR-772: the commit time predates the row write by a few
						// milliseconds, the race CI lost: startTurn wrote the row after
						// startRun returned, so its Date.now() could land past the commit
						// time the guard was attributing, and the guard blamed the wrong
						// turn. The row's started_at is the dispatch start, so the window
						// holds the commit regardless of the write lag.
						const at = Date.now();
						Bun.sleepSync(3);
						change(at);
						changed.resolve();
					} else {
						await changed.promise;
					}
				})();
				return {
					pid: 4242,
					done: done.then(() =>
						runResult({
							outcome: {
								status: "answered",
								summary: "did it",
							} satisfies Outcome,
						}),
					),
					kill: async () => {
						record.killed = true;
					},
				};
			},
		};
	}

	test("overlapping turns: no card parks and one notice names the commit and the cards", async () => {
		// Fails before OTTR-763: the innocent card parked needs_you with the guard
		// reason, because the guard compared snapshots without asking which turn made
		// the change.
		const changeTime = { t: 0 };
		const record = baseRecord();
		const { store, guilty, shared, states, loop } = threeProjectCase(
			{
				commitMeta: async () => [
					{
						sha: "abc1234",
						subject: "sync: add parallel-work check",
						time: changeTime.t,
						files: ["src/widget.ts"],
					},
				],
				...overlappingRuns(record, (at) => {
					changeTime.t = at;
					states.set(shared.path, {
						head: "abc1234",
						status: " M src/widget.ts",
					});
				}),
			},
			record,
		);
		const a = store.createTask("work please");
		const b = guilty.createTask("work please");

		await Promise.all([
			loop.runTurn(store.name, a.id),
			loop.runTurn(guilty.name, b.id),
		]);
		const afterA = await settled(store, a.id);
		const afterB = await settled(guilty, b.id);
		expect(afterA.stage).toBe("done");
		expect(afterA.state).toBe("idle");
		expect(afterA.needsReason).toBeNull();
		expect(afterB.stage).toBe("done");
		expect(afterB.state).toBe("idle");
		expect(afterB.needsReason).toBeNull();
		// One bell notice for the change: it names the commit and both running cards.
		const notices = loop.checkoutNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("abc1234 sync: add parallel-work check");
		expect(notices[0]).toContain(`${store.name}#${a.id}`);
		expect(notices[0]).toContain(`${guilty.name}#${b.id}`);
	});

	test("a lone turn that commits in the shared checkout still parks needs_you", async () => {
		// Pins OTTR-708 under attribution: no other turn window overlaps the change,
		// so the settling turn is the change's only blameable turn and parks as today.
		const changeTime = { t: 0 };
		const record = baseRecord();
		const { store, shared, states, loop } = threeProjectCase({
			commitMeta: async () => [
				{
					sha: "abc1234",
					subject: "sneak edit",
					time: changeTime.t,
					files: ["src/widget.ts"],
				},
			],
			...changingRun(record, () => {
				changeTime.t = Date.now();
				states.set(shared.path, {
					head: "abc1234",
					status: " M src/widget.ts",
				});
			}),
		});
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);
		await flushPromises();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain(shared.name);
		expect(after.needsReason).toContain("abc1234 sneak edit");
		expect(after.needsReason).toContain("src/widget.ts");
		expect(after.needsReason).toContain("create_task");
		expect(loop.checkoutNotices()).toHaveLength(0);
	});

	test("this project's provisioned-copy sync commit in the shared checkout is exempt", async () => {
		// Fails before OTTR-763: the ottr AGENTS.md sync rule says to commit the
		// data-repo copy of this project's context files in the same turn, but the
		// guard parked the card for exactly that commit.
		const changeTime = { t: 0 };
		const record = baseRecord();
		const { store, shared, states, loop } = threeProjectCase({
			commitMeta: async () => [
				{
					sha: "def5678",
					subject: `sync: capture ${store.name} AGENTS.md`,
					time: changeTime.t,
					files: [`projects/${store.name}/AGENTS.md`],
				},
			],
			...changingRun(record, () => {
				changeTime.t = Date.now();
				states.set(shared.path, { head: "def5678", status: "" });
			}),
		});
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);
		await flushPromises();

		const after = store.getTask(task.id)!;
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		expect(loop.checkoutNotices()).toHaveLength(0);
	});

	test("a sync commit that also touches an unrelated file still parks", async () => {
		// The exemption covers only the provisioned-copy file set: one extra file puts
		// the change back under the guard, and the lone turn is its only blameable turn.
		const changeTime = { t: 0 };
		const record = baseRecord();
		const { store, shared, states, loop } = threeProjectCase({
			commitMeta: async () => [
				{
					sha: "def5678",
					subject: `sync: capture ${store.name} AGENTS.md`,
					time: changeTime.t,
					files: [`projects/${store.name}/AGENTS.md`, "README.md"],
				},
			],
			...changingRun(record, () => {
				changeTime.t = Date.now();
				states.set(shared.path, {
					head: "def5678",
					status: " M README.md",
				});
			}),
		});
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);
		await flushPromises();

		const after = store.getTask(task.id)!;
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toContain("README.md");
		expect(loop.checkoutNotices()).toHaveLength(0);
	});

	test("a file-only change under overlapping turns parks neither and rings one notice", async () => {
		// No commit meta: the change carries no timestamp, so the guard falls back to
		// the turn windows themselves. Fails before OTTR-763: the innocent card parked.
		const record = baseRecord();
		const { store, guilty, shared, states, loop } = threeProjectCase(
			{
				...overlappingRuns(record, () => {
					states.set(shared.path, {
						head: "base0",
						status: "?? stray.txt",
					});
				}),
			},
			record,
		);
		const a = store.createTask("work please");
		const b = guilty.createTask("work please");

		await Promise.all([
			loop.runTurn(store.name, a.id),
			loop.runTurn(guilty.name, b.id),
		]);
		const afterA = await settled(store, a.id);
		const afterB = await settled(guilty, b.id);
		expect(afterA.needsReason).toBeNull();
		expect(afterB.needsReason).toBeNull();
		const notices = loop.checkoutNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("changed files stray.txt");
		expect(notices[0]).toContain(`${store.name}#${a.id}`);
		expect(notices[0]).toContain(`${guilty.name}#${b.id}`);
	});

	// The two tests below drive the REAL checkout reads and the REAL commit reader:
	// ops omits commitMeta, so guardNewCommits resolves to the real commitMeta through
	// the commitSubjects fallback pattern. They fail whenever the fallback answers
	// stub-shaped metadata (time = now, files = []), which is how the production wiring
	// broke before the send-back fix.

	/** A real git repository as the watched checkout; its guard reads are live. The
	 * first `workRuns` runs (one per project with a card) are the work runs: the last
	 * of them fires `change` while every work run is still live, and every work run
	 * finishes only after `change` completed, so each turn window holds the change.
	 * Later runs are a card's chained merge run and report integrated. */
	function realSharedRepoCase(
		record: Recorded,
		change: () => void | Promise<void>,
		workRuns = 1,
	): {
		store: ProjectStore;
		guilty: ProjectStore;
		repo: string;
		loop: TurnLoop;
	} {
		const store = freshStore();
		const guilty = freshStore();
		const other = freshStore();
		const repo = mkdtempSync(join(tmpdir(), "ottr-guard-repo-"));
		dirs.push(repo);
		const seenWorkRuns = new Set<string>();
		let entered = 0;
		let changed = false;
		const changeDone = Promise.withResolvers<void>();
		const run = (cwd: string, ...args: string[]): string => {
			const r = Bun.spawnSync(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (r.exitCode !== 0)
				throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
			return r.stdout.toString().trim();
		};
		run(repo, "init", "-q", "-b", "main");
		const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
		run(repo, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		const projects = new Map<string, TurnProject>([
			[store.name, fakeProject(store)],
			[guilty.name, fakeProject(guilty)],
			// The watched checkout is the real repository; every read is live.
			[other.name, { ...fakeProject(other), path: repo }],
		]);
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				checkoutState: (path: string) => realCheckoutState(path),
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					const key = o.board?.project ?? o.cwd;
					const workRun = !seenWorkRuns.has(key);
					seenWorkRuns.add(key);
					const outcome: Outcome = workRun
						? { status: "answered", summary: "did it" }
						: { status: "integrated", summary: "landed" };
					const done = (async () => {
						if (workRun) {
							entered += 1;
							if (entered === workRuns && !changed) {
								changed = true;
								await change();
								changeDone.resolve();
							} else {
								await changeDone.promise;
							}
						}
						return runResult({ outcome });
					})();
					return {
						pid: 4242,
						done,
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		return { store, guilty, repo, loop };
	}

	test("overlapping turns committing in a real watched checkout: no card parks, one notice", async () => {
		// The ALAT-104/OTTR-748 shape with a real repository and the real commit reader.
		// Fails whenever the guard's commit metadata goes stub-shaped: with time = now
		// and no files, the finished committer turn's window never holds the change, so
		// the innocent card parked needs_you.
		let sha = "";
		const record = baseRecord();
		const { store, guilty, repo, loop } = realSharedRepoCase(
			record,
			async () => {
				const git = (args: string[], env?: Record<string, string>): string => {
					const r = Bun.spawnSync(["git", ...args], {
						cwd: repo,
						stdout: "pipe",
						stderr: "pipe",
						env: env === undefined ? process.env : { ...process.env, ...env },
					});
					if (r.exitCode !== 0)
						throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
					return r.stdout.toString().trim();
				};
				// Real commit times carry whole-second granularity, and this test runs in
				// well under a second: commit at a whole-second boundary the wait has
				// passed, so the parsed committer time sits inside both turn windows.
				// A genuine wall-clock wait is the point here: the behavior under test is
				// git's committer-time granularity against the platform clock, which no
				// fake timer can produce.
				const at = Math.ceil((Date.now() + 50) / 1000) * 1000;
				await Bun.sleep(Math.max(at - Date.now(), 1));
				writeFileSync(join(repo, "src.ts"), "one\n");
				git(["add", "src.ts"]);
				git(
					[
						"-c",
						"user.name=t",
						"-c",
						"user.email=t@t",
						"commit",
						"-q",
						"-m",
						"sneak edit",
					],
					{ GIT_COMMITTER_DATE: new Date(at).toISOString() },
				);
				sha = git(["rev-parse", "--short", "HEAD"]);
			},
		);
		const a = store.createTask("work please");
		const b = guilty.createTask("work please");

		await Promise.all([
			loop.runTurn(store.name, a.id),
			loop.runTurn(guilty.name, b.id),
		]);
		const afterA = await settled(store, a.id);
		const afterB = await settled(guilty, b.id);
		expect(afterA.needsReason).toBeNull();
		expect(afterB.needsReason).toBeNull();
		const notices = loop.checkoutNotices();
		expect(notices).toHaveLength(1);
		// The notice names the REAL commit: the short sha git answered and its subject.
		expect(notices[0]).toContain(`${sha} sneak edit`);
		expect(notices[0]).toContain(`${store.name}#${a.id}`);
		expect(notices[0]).toContain(`${guilty.name}#${b.id}`);
	});

	test("a real provisioned-copy sync commit exempts without an injected commitMeta", async () => {
		// The AGENTS.md sync shape against a real repository: the commit adds
		// projects/<this project>/AGENTS.md, the real reader answers its file list, and
		// the exemption fires. Fails whenever the reader goes stub-shaped (no files),
		// which parked the syncing card before the send-back fix.
		const record = baseRecord();
		const store = freshStore();
		const other = freshStore();
		const repo = mkdtempSync(join(tmpdir(), "ottr-guard-sync-"));
		dirs.push(repo);
		const git = (cwd: string, ...args: string[]): string => {
			const r = Bun.spawnSync(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (r.exitCode !== 0)
				throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
			return r.stdout.toString().trim();
		};
		git(repo, "init", "-q", "-b", "main");
		git(
			repo,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"base",
		);
		const projects = new Map<string, TurnProject>([
			[store.name, fakeProject(store)],
			[other.name, { ...fakeProject(other), path: repo }],
		]);
		let committed = false;
		const loop = createTurnLoop(
			projects,
			fakeOps(record, {
				checkoutState: (path: string) => realCheckoutState(path),
				startRun: (o: Parameters<TurnOps["startRun"]>[0]) => {
					record.runs.push(o);
					o.onSession?.("sess-1");
					// First run: the work run commits the sync; later runs are the card's
					// chained merge run and report integrated, like the other fakes.
					const workRun = !committed;
					committed = true;
					if (workRun) {
						mkdirSync(join(repo, "projects", store.name), {
							recursive: true,
						});
						writeFileSync(
							join(repo, "projects", store.name, "AGENTS.md"),
							"rules\n",
						);
						git(repo, "add", "-A");
						git(
							repo,
							"-c",
							"user.name=t",
							"-c",
							"user.email=t@t",
							"commit",
							"-q",
							"-m",
							`sync: capture ${store.name} AGENTS.md`,
						);
					}
					return {
						pid: 4242,
						done: Promise.resolve(
							runResult({
								outcome: workRun
									? ({
											status: "answered",
											summary: "did it",
										} satisfies Outcome)
									: ({
											status: "integrated",
											summary: "landed",
										} satisfies Outcome),
							}),
						),
						kill: async () => {
							record.killed = true;
						},
					};
				},
			}),
		);
		const task = store.createTask("work please");

		await loop.runTurn(store.name, task.id);
		const after = await settled(store, task.id);
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBeNull();
		expect(loop.checkoutNotices()).toHaveLength(0);
	});
});

describe("stored review findings", () => {
	type StartOpts = Parameters<TurnOps["startRun"]>[0];
	const mkFinding = (
		prompt: string,
		rank: number | null = null,
		security: "critical" | "high" | null = null,
	): RecordedFinding => ({ prompt, model: null, rank, security });
	const reviewCard = (store: ProjectStore) => {
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}main (3 commits)`,
			null,
			"review",
		);
		store.updateTask(review.id, { base: "shaR" });
		return review;
	};
	const kidsOf = (store: ProjectStore, id: string) =>
		store.listTasks().filter((t) => t.followUpOf === id);
	const verdicts = (...v: [number, boolean, string][]) =>
		runResult({
			finalText: JSON.stringify(
				v.map(([id, keep, reason]) => ({ id, keep, reason })),
			),
		});
	const checkInput = (prompt: string) =>
		JSON.parse(
			prompt
				.split("Findings:\n")[1]!
				.split("\n\nOpen cards of the project:")[0]!,
		) as { id: number; prompt: string }[];

	/** A review run that delivers findings through the spec's onRecorded callback as they
	 * arrive, then serves `result` (or rejects when `fail` is set). Later runs are checks
	 * served from `checks` in order and captured in `checkRuns`. */
	function storedReviewSetup(
		record: Recorded,
		findings: RecordedFinding[],
		result: RunResult | { fail: Error },
		checks: RunResult[],
		overrides: Partial<TurnOps> = {},
	) {
		const checkRuns: StartOpts[] = [];
		const s = setupWith(record, {
			commitsAhead: async () => 0,
			maxTotalRuns: () => 0,
			startRun: (o: StartOpts) => {
				let done: Promise<RunResult>;
				if (o.maxTime) {
					// The second-model check over the stored set: a fresh capped session.
					checkRuns.push(o);
					done = Promise.resolve(
						checks.shift() ?? runResult({ finalText: "[]" }),
					);
				} else {
					record.runs.push(o);
					o.onSession?.("sess");
					// The run "parses" each propose_task as it arrives, before settling.
					for (const f of findings) o.onRecorded?.(f);
					done =
						record.runs.length === 1
							? "fail" in result
								? Promise.reject(result.fail)
								: Promise.resolve(result)
							: Promise.resolve(
									runResult({
										outcome: { status: "answered", summary: "reply" },
									}),
								);
				}
				return { pid: 4242, done, kill: async () => {} };
			},
			...overrides,
		});
		return { ...s, checkRuns };
	}

	test("findings persist through a never-settling run and a later answered turn checks and files them", async () => {
		const record = baseRecord();
		const { store, loop, checkRuns } = storedReviewSetup(
			record,
			[mkFinding("Bug A", 1), mkFinding("Bug B", 2)],
			{ fail: new Error("worker dispatch failed") },
			// The check over the STORED set keeps both, even though turn 2's own
			// run reported nothing recorded.
			[verdicts([1, true, ""], [2, true, ""])],
		);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);

		// Turn 1 never settled, yet both findings are on the card in arrival order.
		expect(store.listReviewFindings(review.id).map((f) => f.prompt)).toEqual([
			"Bug A",
			"Bug B",
		]);

		// Turn 2: a reply on the same card; its run records nothing and answers.
		store.updateTask(review.id, { state: "queued" });
		await loop.runTurn(store.name, review.id);

		// The check ran as a fresh session over the stored set and filed both findings.
		// record.runs holds review runs only; the check run is checkRuns[0].
		expect(record.runs).toHaveLength(2);
		expect(checkInput(checkRuns[0]!.prompt).map((f) => f.prompt)).toEqual([
			"Bug A",
			"Bug B",
		]);
		const kids = kidsOf(store, review.id);
		expect(kids.map((k) => k.prompt).sort()).toEqual(["Bug A", "Bug B"]);
		expect(kids.every((k) => k.stage === "todo")).toBe(true);
		// The card waits at merging for its findings, not done.
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);
	});

	test("done is refused while stored findings are unchecked; the stamp lets a done settle through", async () => {
		const record = baseRecord();
		const { store, loop, projects, checkRuns } = storedReviewSetup(
			record,
			[mkFinding("Bug A", 1), mkFinding("Bug B", 2)],
			runResult({
				outcome: { status: "answered", summary: "review done" },
				recorded: [],
			}),
			// The in-settle check keeps both; their cards hold the review at merging.
			[verdicts([1, true, ""], [2, true, ""])],
			// A null run cap so schedule()'s tick reaches settleReviews (a 0 cap
			// makes every tick return the cap bit before the settle).
			{ maxTotalRuns: () => null },
		);
		const review = reviewCard(store);
		store.appendReviewFinding(review.id, mkFinding("Bug A", 1));
		store.appendReviewFinding(review.id, mkFinding("Bug B", 2));
		await loop.runTurn(store.name, review.id);

		// The done-classified settle parked instead: the stored set was unchecked,
		// so the check ran in the same settle and its kept cards hold the review.
		let after = store.getTask(review.id)!;
		expect(after.stage).not.toBe("done");
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);
		expect(checkRuns).toHaveLength(1);
		const kids = kidsOf(store, review.id);
		expect(kids).toHaveLength(2);

		// Second half: the scheduled settle finishes the held review once the stamp
		// is in and the filed cards are done; no agent run, no re-check.
		for (const k of kids)
			store.updateTask(k.id, { stage: "done", state: "idle" });
		projects.get(store.name)!.target = "origin/main";
		loop.schedule();
		await flushPromises();
		after = store.getTask(review.id)!;
		expect(record.runs).toHaveLength(1); // the tick runs no agent
		expect(checkRuns).toHaveLength(1);
		expect(after.stage).toBe("done");
		expect(after.state).toBe("idle");

		// A finding that arrives after the check re-opens the refusal: park the card
		// back in the held shape (the needsReason is the tick's held marker), append,
		// and the tick refuses done until stamped.
		store.updateTask(review.id, {
			stage: "merging",
			state: "idle",
			needsReason: FINDINGS_HOLD,
		});
		store.appendReviewFinding(review.id, mkFinding("Bug C", 3));
		loop.schedule();
		await flushPromises();
		after = store.getTask(review.id)!;
		expect(after.stage).not.toBe("done");
		expect(after.state).toBe("needs_you");
		expect(after.needsReason).toBe(UNCHECKED_FINDINGS_HOLD);
		expect(checkRuns).toHaveLength(1);
	});

	test("lead findings file as unverified backlog cards and never enter the check or the cap", async () => {
		const record = baseRecord();
		const confirmed = Array.from({ length: 12 }, (_, i) =>
			mkFinding(`Bug ${i + 1}`, i + 1),
		);
		const leads = [
			mkFinding("Needs validation: maybe a race in the scheduler"),
			mkFinding("Needs validation: config load may double-read"),
			mkFinding("Needs validation: flaky retry on push"),
		];
		const { store, loop, projects, checkRuns } = storedReviewSetup(
			record,
			[...confirmed, ...leads],
			runResult({
				outcome: { status: "answered", summary: "review done" },
			}),
			// The check sees only the cap-10 confirmed selection and drops every one.
			[
				verdicts(
					...Array.from(
						{ length: 10 },
						(_, i) => [i + 1, false, "not real"] as [number, boolean, string],
					),
				),
			],
			// A null run cap so schedule()'s tick reaches settleReviews (a 0 cap
			// makes every tick return the cap bit before the settle).
			{ maxTotalRuns: () => null },
		);
		const review = reviewCard(store);
		await loop.runTurn(store.name, review.id);

		// The check input holds exactly the cap-10 confirmed selection: no leads,
		// no below-cap ranks.
		expect(checkRuns).toHaveLength(1);
		const input = checkInput(checkRuns[0]!.prompt);
		expect(input.map((f) => f.prompt)).toEqual(
			Array.from({ length: 10 }, (_, i) => `Bug ${i + 1}`),
		);

		// Each lead filed as a backlog card marked unverified, linked to the review.
		const kids = kidsOf(store, review.id);
		const leadKids = kids.filter((k) =>
			k.prompt.startsWith("Needs validation:"),
		);
		expect(leadKids).toHaveLength(3);
		for (const k of leadKids) {
			expect(k.stage).toBe("backlog");
			expect(k.state).toBe("idle");
			expect(k.queuedAt).toBeNull();
			expect(k.followUpOf).toBe(review.id);
			expect(k.details).toContain("Unverified lead from review");
		}

		// Below-cap confirmed findings stay logged, never filed.
		const filed = kids.map((k) => k.prompt);
		expect(filed).not.toContain("Bug 11");
		expect(filed).not.toContain("Bug 12");
		const after = store.getTask(review.id)!;
		expect(after.details).toContain("below the cap of 10: Bug 11");
		expect(after.details).toContain("below the cap of 10: Bug 12");

		// The check dropped all 10 confirmed findings and leads never hold Done:
		// the settle parks the review at merging/idle with the held marker, and the
		// scheduled tick lands Done with the full Done bookkeeping even though the
		// backlog lead cards stay open.
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		projects.get(store.name)!.target = "origin/main";
		loop.schedule();
		await flushPromises();
		const doneAfter = store.getTask(review.id)!;
		expect(doneAfter.stage).toBe("done");
		expect(doneAfter.needsReason).toBeNull();
		expect(leadKids.every((k) => k.stage === "backlog")).toBe(true);
	});

	test("a release review refuses to publish while its stored findings are unchecked", async () => {
		const record = baseRecord();
		// Stored findings from an earlier (lost) turn; this turn records nothing.
		const { store, projects, loop, checkRuns } = storedReviewSetup(
			record,
			[],
			runResult({
				outcome: { status: "answered", summary: "review done" },
				recorded: [],
			}),
			[verdicts([1, true, ""], [2, true, ""])],
			{ publishRelease: publishingRelease(record), maxTotalRuns: () => null },
		);
		projects.get(store.name)!.target = "origin/main";
		const review = store.createTask(
			`${ARCH_REVIEW_MARKER}release v1.0.0`,
			null,
			"review",
		);
		store.updateTask(review.id, {
			releaseVersion: "v1.0.0",
			base: "shaR",
			worktree: "wt-rel",
			branch: "ott/rel",
			releaseNotes: "notes body",
		});
		store.appendReviewFinding(review.id, mkFinding("Bug A", 1));
		store.appendReviewFinding(review.id, mkFinding("Bug B", 2));

		await loop.runTurn(store.name, review.id);

		// The live settle refuses Done: no publish, and the check ran on the
		// stored set in the same settle and filed both findings.
		expect(record.publishRelease).toHaveLength(0);
		expect(checkRuns).toHaveLength(1);
		const kids = kidsOf(store, review.id);
		expect(kids.map((k) => k.prompt).sort()).toEqual(["Bug A", "Bug B"]);
		const after = store.getTask(review.id)!;
		expect(after.stage).toBe("merging");
		expect(after.state).toBe("idle");
		expect(after.needsReason).toBe(FINDINGS_HOLD);

		// Findings implemented: the tick publishes and lands Done.
		for (const k of kids)
			store.updateTask(k.id, { stage: "done", state: "idle" });
		loop.schedule();
		await flushPromises();
		expect(record.publishRelease).toHaveLength(1);
		const done = store.getTask(review.id)!;
		expect(done.stage).toBe("done");
		expect(done.summary).toBe("Released v1.0.0");
	});
});
