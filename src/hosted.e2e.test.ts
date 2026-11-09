// Hosted mode end to end (docs/specs/hosted-mode.md sections 2-5): the real createApp and
// createTurnLoop wired as src/server.ts wires them, a fake control plane on a real Bun.serve
// that the real controlPlaneHooks client calls, and a test "proxy" that signs every request.
// The agent runs go through the real startRun and run sink: only the omp child is fake, and it
// feeds omp-shaped JSON lines (message_end usage, report_outcome, agent_end) on its stdout.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp, type Entry } from "./app.ts";
import { NonceCache, signIdentity, verifyIdentity } from "./auth.ts";
import { GlobalStore } from "./globalStore.ts";
import {
	controlPlaneHooks,
	DEFAULT_CREDIT_REASON,
	type Hosted,
	type MeteringRecord,
	readHostedConfig,
	type TokenUsage,
} from "./hosted.ts";
import { type RunLauncher, startRun } from "./runner.ts";
import { checkRoleFor } from "./scheduler.ts";
import { ProjectStore } from "./store.ts";
import { createTurnLoop, type TurnLoop, type TurnOps } from "./turn.ts";
import { VmTokens } from "./vmTokens.ts";
import {
	archReviewDelta,
	branchMergedOrGone,
	branchUnpushed,
	changedFiles,
	checkedOutBranch,
	commitsAhead,
	createWorktree,
	diffStat,
	diffText,
	fetchOriginBranch,
	git,
	hasRules,
	ignoreInMain,
	isClean,
	isIntegrated,
	mergeHoldLanded,
	mergeHoldMismatch,
	quarantineUntracked,
	rebaseTargetBranch,
	removeWorktree,
	resetBranchTo,
	resolveTarget,
	serverMergePush,
	setHostedGitAuth,
	statusFiles,
	targetCommits,
	targetContains,
	trackedFiles,
	unsavedWork,
	worktreeHusk,
	worktreeLinked,
} from "./worktree.ts";

const TENANT = "acme";
const SECRET = "e2e-tenant-secret-".repeat(3);
const PUBLIC = "acme.ottr.cloud";
const BOOT = "boot-token-e2e";
const WORK_MODEL = "anthropic/claude-opus-5-5";
const CHECK_ROLE = checkRoleFor(WORK_MODEL);
const CHECK_MODEL = "openai/gpt-6";
const WORK_PROMPT = "Add a hello.txt file that greets the tenant.";
const PASS = JSON.stringify({ blockers: [], fixed: [], notes: [] });

// Dyadic usage values: the sums are exact in floating point.
const WORK_USAGE: TokenUsage = {
	input: 1200 + 400,
	output: 300 + 120,
	cacheRead: 9000 + 9500,
	cacheWrite: 10 + 0,
	cost: 0.25 + 0.125,
};
const CHECK_USAGE: TokenUsage = {
	input: 5000,
	output: 200,
	cacheRead: 64,
	cacheWrite: 0,
	cost: 0.0625,
};

const root = mkdtempSync(join(tmpdir(), "hosted-e2e-"));
const servers: Server<undefined>[] = [];
const stores: { close(): void }[] = [];

/** Ordered trace across the control plane and the fake omp: proves credit came before any run. */
const trace: string[] = [];

// ---- fake control plane ----------------------------------------------------

interface ControlPlane {
	url: string;
	metering: MeteringRecord[];
	creditCalls: number;
	/** Requests the control plane refused: a missing, forged, replayed or non-tenant header. */
	refused: string[];
	/** Resolves once `n` metering records have arrived. */
	meteringCount(n: number): Promise<void>;
	/** Resolves once the credit endpoint has answered `n` times. */
	creditCount(n: number): Promise<void>;
}

/**
 * The control plane answers the first credit check with ok:true and every later one with
 * ok:false. The work turn then runs (work run + check run), and the chained merge turn parks at
 * the credit gate: the card settles in the merge column with no third agent run.
 */
function startControlPlane(): ControlPlane {
	const nonces = new NonceCache();
	const waiters: { done: () => boolean; resolve: () => void }[] = [];
	const wake = () => {
		for (const w of [...waiters])
			if (w.done()) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve();
			}
	};
	const until = (done: () => boolean) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (done()) resolve();
		else waiters.push({ done, resolve });
		return promise;
	};
	const cp: ControlPlane = {
		url: "",
		metering: [],
		creditCalls: 0,
		refused: [],
		meteringCount: (n) => until(() => cp.metering.length >= n),
		creditCount: (n) => until(() => cp.creditCalls >= n),
	};
	const base = `/v1/tenants/${TENANT}`;
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const id = verifyIdentity(req.headers.get("x-ottr-identity"), {
				secret: SECRET,
				tenant: TENANT,
				nonces,
			});
			if (!id.ok || id.role !== "tenant") {
				cp.refused.push(
					`${req.method} ${path}: ${id.ok ? id.role : id.reason}`,
				);
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			if (req.method === "GET" && path === `${base}/credit`) {
				cp.creditCalls += 1;
				trace.push(`credit#${cp.creditCalls}`);
				const ok = cp.creditCalls === 1;
				queueMicrotask(wake);
				return Response.json({ ok });
			}
			if (req.method === "POST" && path === `${base}/metering`) {
				cp.metering.push((await req.json()) as MeteringRecord);
				trace.push(`metering#${cp.metering.length}`);
				queueMicrotask(wake);
				return new Response(null, { status: 204 });
			}
			cp.refused.push(`${req.method} ${path}: no such route`);
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	servers.push(srv);
	cp.url = `http://127.0.0.1:${srv.port}`;
	return cp;
}

// ---- fake omp child ----------------------------------------------------------

/** EventEmitter stand-in for the spawned omp child (src/runner.test.ts's FakeOmp). */
class FakeOmp extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	written: string[] = [];
	onPrompt: () => void = () => {};
	stdin = Object.assign(new EventEmitter(), {
		write: (s: string) => {
			this.written.push(s);
		},
		// startRun writes the prompt, then ends stdin: the run "starts" here.
		end: () => {
			setImmediate(this.onPrompt);
		},
	});
	constructor(readonly pid: number) {
		super();
	}
}

/** Fake pids of the children still running; the loop's pidAlive reads them. */
const livePids = new Set<number>();
let nextPid = 900_000;

/** The test's own git, for fixtures and the fake agent's commit; never the code under test. */
const gitSync = (cwd: string, ...args: string[]) =>
	execFileSync(
		"git",
		["-c", "user.name=e2e", "-c", "user.email=e2e@test", ...args],
		{ cwd, stdio: "pipe", encoding: "utf8" },
	);

/** src/server.ts's targetSha (not exported there): a ref's local tip, else null. */
async function targetSha(
	mainPath: string,
	ref: string,
): Promise<string | null> {
	const r = await git(
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		mainPath,
	).catch(() => null);
	return r && r.code === 0 ? r.stdout.trim() || null : null;
}

function splitModel(selector: string): { provider: string; model: string } {
	const slash = selector.indexOf("/");
	return {
		provider: selector.slice(0, slash),
		model: selector.slice(slash + 1),
	};
}

/** One assistant message in omp's JSON event shape, with its usage on message_end. */
function assistant(
	selector: string,
	text: string,
	usage: Omit<TokenUsage, "cost"> & { cost: number },
): unknown[] {
	const { provider, model } = splitModel(selector);
	const message = {
		role: "assistant",
		provider,
		model,
		content: [{ type: "text", text }],
	};
	return [
		{ type: "message_start", message },
		{
			type: "message_end",
			message: {
				...message,
				usage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					totalTokens:
						usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
					cost: { input: 0, output: 0, total: usage.cost },
				},
			},
		},
	];
}

/** The work agent: commits in its worktree, reports ready, ends; two assistant messages. */
function workEvents(): unknown[] {
	return [
		{ type: "session", id: "sess-work", version: 3, cwd: "." },
		{ type: "agent_start" },
		...assistant(WORK_MODEL, "Adding the file.", {
			input: 1200,
			output: 300,
			cacheRead: 9000,
			cacheWrite: 10,
			cost: 0.25,
		}),
		{
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "report_outcome",
			args: { status: "ready", summary: "Added hello.txt" },
		},
		{
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "report_outcome",
			isError: false,
			result: { content: [{ type: "text", text: "reported" }] },
		},
		...assistant(WORK_MODEL, "Done: hello.txt is committed.", {
			input: 400,
			output: 120,
			cacheRead: 9500,
			cacheWrite: 0,
			cost: 0.125,
		}),
		{
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Done: hello.txt is committed." }],
				},
			],
		},
	];
}

/** The second-model check: answers with the model it was launched with, and passes. */
function checkEvents(selector: string): unknown[] {
	return [
		{ type: "session", id: "sess-check", version: 3, cwd: "." },
		{ type: "agent_start" },
		...assistant(selector, PASS, CHECK_USAGE),
		{
			type: "agent_end",
			messages: [
				{ role: "assistant", content: [{ type: "text", text: PASS }] },
			],
		},
	];
}

/** What every launched child saw: its argv and prompt. */
const launches: { args: readonly string[]; prompt: string; cwd: string }[] = [];

const launcher: RunLauncher = (_command, args, options) => {
	const fake = new FakeOmp(nextPid++);
	livePids.add(fake.pid);
	const cwd = String(options.cwd);
	fake.onPrompt = () => {
		const prompt = fake.written.join("");
		launches.push({ args, prompt, cwd });
		const isCheck = prompt.startsWith(
			"You are the second model checking a finished work card",
		);
		trace.push(isCheck ? "run:check" : "run:work");
		let events: unknown[];
		if (isCheck) {
			const m = args.indexOf("--model");
			events = checkEvents(m === -1 ? "unknown/none" : (args[m + 1] ?? ""));
		} else {
			// The agent's work: one commit on the card branch in its worktree.
			writeFileSync(join(cwd, "hello.txt"), `hello ${TENANT}\n`);
			gitSync(cwd, "add", "hello.txt");
			gitSync(cwd, "commit", "-qm", "feat: add hello.txt");
			events = workEvents();
		}
		const text = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		// Two chunks split inside a line: the sink must buffer the partial line.
		const cut = Math.floor(text.length / 2);
		fake.stdout.emit("data", Buffer.from(text.slice(0, cut)));
		fake.stdout.emit("data", Buffer.from(text.slice(cut)));
		livePids.delete(fake.pid);
		fake.emit("close", 0);
	};
	return fake as unknown as ChildProcess; // the fake stands in for Node's class
};

// ---- the composed board ------------------------------------------------------

interface Board {
	url: string;
	store: ProjectStore;
	loop: TurnLoop;
	logs: string[];
}

let cp: ControlPlane;
let board: Board;

function makeRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	gitSync(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "AGENTS.md"), "# Rules\n\nKeep it small.\n");
	writeFileSync(join(dir, "README.md"), "# app\n");
	gitSync(dir, "add", "AGENTS.md", "README.md");
	gitSync(dir, "commit", "-qm", "seed");
}

/** createTurnLoop + createApp with the hosted deps, after src/server.ts's wiring. */
function mountBoard(hosted: Hosted): Board {
	const g = GlobalStore.open(join(root, "global"));
	stores.push(g);
	const projectDir = join(root, "app");
	makeRepo(projectDir);
	const store = ProjectStore.open(projectDir);
	stores.push(store);
	const projects = new Map<string, Entry>();
	projects.set(store.name, {
		path: projectDir,
		name: store.name,
		store,
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
	});
	const shared = {
		maxTotalRuns: 3,
		reviewCheck: true,
		workCheck: true,
		idleReviews: true,
		trendingScan: true,
		commitIdentity: null,
		removedPaths: [] as string[],
		envValues: {} as Record<string, string>,
		projectPaths: [] as string[],
		projectOrder: [] as string[],
	};
	const board = { url: "http://127.0.0.1:4747", token: BOOT };
	const vmTokens = new VmTokens({ file: null });
	// Late-bound like server.ts: the loop's closures call into `app`, declared below; both
	// exist before the first schedule tick.
	const notWired = (what: string) => async (): Promise<never> => {
		throw new Error(`${what} must not run in this test`);
	};
	const ops: TurnOps = {
		extensionPath: resolve(import.meta.dir, "..", "extension", "tracker.ts"),
		board,
		maxTotalRuns: () => shared.maxTotalRuns,
		reviewCheck: () => shared.reviewCheck,
		workCheck: () => shared.workCheck,
		// The check role's model; the board reads omp's role config otherwise.
		modelRoles: () => ({ default: WORK_MODEL, [CHECK_ROLE]: CHECK_MODEL }),
		// Titles come from another omp run: a fixed title keeps the fake runs to work + check.
		genTitle: async () => "Add hello file",
		titleRetryDelayMs: 5,
		drained: () => app.drained(),
		drainedRunner: (id) => app.drainedRunner(id),
		publishSoon: () => app.publishSoon(),
		notifyLog: (project, id) => app.notifyLog(project, id),
		refreshRelease: async () => {},
		refreshArchReview: async () => {},
		resolveTarget,
		createWorktree,
		removeWorktree,
		commitsAhead,
		changedFiles,
		diffStat,
		diffText,
		isClean,
		isIntegrated,
		unsavedWork,
		statusFiles,
		quarantineUntracked,
		trackedFiles,
		worktreeHusk,
		worktreeLinked,
		ignoreInMain,
		branchMergedOrGone,
		hasRules,
		targetCommits,
		targetSha,
		targetContains,
		branchUnpushed,
		checkedOutBranch,
		serverMergePush,
		pushAuthKind: (url) => app.pushAuthKind(url),
		githubAuthHint: (url) => app.githubAuthHint(url),
		fetchOriginBranch,
		rebaseTargetBranch,
		runMergeGates: notWired("the merge gates"),
		mergeHoldMismatch,
		mergeHoldLanded,
		resetBranchTo,
		pidAlive: (pid) => livePids.has(pid),
		vmTokens,
		// The real runner: argv, stdin prompt, run sink and applyEvent; only the child is fake.
		startRun: (o) => startRun({ ...o, launcher, memoryConfigPath: null }),
		ensurePackages: async () => [],
		publishRelease: notWired("a release publish"),
		runReleaseCommand: notWired("a release command"),
		archReviewDelta,
		http400Dir: join(root, "no-http400"),
		hosted,
	};
	const loop = createTurnLoop(projects, ops);
	const serverRef: { current: Server<undefined> | undefined } = {
		current: undefined,
	};
	const app = createApp({
		gstore: g,
		defaultDir: root,
		projects,
		cancel: loop.cancel,
		stopTurn: loop.stopTurn,
		creditStop: loop.creditStop,
		finishKept: loop.finishKept,
		claimedPids: () => new Set<number>(),
		schedule: loop.schedule,
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared,
		serverRef,
		board,
		vmTokens,
		hosted,
	});
	const srv = Bun.serve({ port: 0, ...app.serveOptions });
	serverRef.current = srv;
	servers.push(srv);
	return { url: srv.url.href, store, loop, logs: [] };
}

/**
 * The proxy: forwards with the tenant's public Host and Origin and a fresh signed owner header.
 * `identity: null` sends no header; a string sends that exact header (a replay).
 */
function proxyFetch(
	path: string,
	init: { method?: string; body?: unknown; identity?: string | null } = {},
): Promise<Response> {
	const identity =
		init.identity === undefined
			? signIdentity(SECRET, TENANT, "owner")
			: init.identity;
	return fetch(new URL(path, board.url), {
		method: init.method ?? (init.body === undefined ? "GET" : "POST"),
		headers: {
			Host: PUBLIC,
			Origin: `https://${PUBLIC}`,
			"content-type": "application/json",
			...(identity === null ? {} : { "x-ottr-identity": identity }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

beforeAll(() => {
	cp = startControlPlane();
	const config = readHostedConfig({
		OTTR_HOSTED: "1",
		OTTR_HOSTED_TENANT: TENANT,
		OTTR_HOSTED_SECRET: SECRET,
		OTTR_HOSTED_CONTROL_URL: cp.url,
	});
	if (config === null) throw new Error("hosted config did not parse");
	const hookLogs: string[] = [];
	board = mountBoard({
		config,
		hooks: controlPlaneHooks(config, { log: (m) => hookLogs.push(m) }),
	});
	board.logs = hookLogs;
});

afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const s of stores) s.close();
	// createApp installs the hosted git credential resolver process-wide: leave none behind.
	setHostedGitAuth(null);
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Bounded wait for a store fact that no event exposes (the turn loop has no settle signal). */
async function eventually(what: string, done: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

describe("hosted mode end to end", () => {
	test("a proxied card runs work + check, meters each run per role, and parks at the credit gate", async () => {
		// File the card parked in the backlog: nothing may run or ask for credit yet.
		const created = await proxyFetch(
			`/api/projects/${board.store.name}/tasks`,
			{ body: { prompt: WORK_PROMPT, backlog: true } },
		);
		expect(created.status).toBe(200);
		const task = board.store.listTasks().find((t) => t.prompt === WORK_PROMPT);
		expect(task).toBeDefined();
		const id = task!.id;
		expect(board.store.getTask(id)!.stage).toBe("backlog");
		expect(cp.creditCalls).toBe(0);

		// Start it the way the board's "move to todo" does; the route ticks the scheduler.
		const started = await proxyFetch(
			`/api/projects/${board.store.name}/tasks/${id}/backlog`,
			{ body: { to: "todo" } },
		);
		expect(started.status).toBe(200);

		// Work run -> check run -> settle at merging -> the chained merge turn hits the gate.
		await cp.meteringCount(2);
		await cp.creditCount(2);
		await eventually(
			"the merge turn to park at the credit gate",
			() => board.store.getTask(id)!.state === "needs_you",
		);

		const card = board.store.getTask(id)!;
		expect(card.stage).toBe("merging");
		expect(card.needsReason).toBe(DEFAULT_CREDIT_REASON);
		expect(card.workCheckLog.map((r) => r.outcome)).toEqual(["pass"]);
		expect(card.workCheckLog[0]!.model).toBe(CHECK_MODEL);

		// Exactly one turn ran (the merge turn never got past the gate), with two agent runs.
		const turns = board.store.listTurns(id);
		expect(turns).toHaveLength(1);
		expect(launches).toHaveLength(2);
		expect(launches[0]!.prompt).toContain(WORK_PROMPT);
		const checkArgs = launches[1]!.args;
		expect(checkArgs[checkArgs.indexOf("--model") + 1]).toBe(CHECK_MODEL);

		// Credit before the first run; the second credit call is the merge turn's gate.
		expect(trace.indexOf("credit#1")).toBe(0);
		expect(trace.indexOf("run:work")).toBeGreaterThan(
			trace.indexOf("credit#1"),
		);
		expect(trace.indexOf("run:check")).toBeGreaterThan(
			trace.indexOf("run:work"),
		);
		expect(trace.indexOf("credit#2")).toBeGreaterThan(
			trace.indexOf("run:check"),
		);

		const base = {
			tenant: TENANT,
			project: board.store.name,
			taskId: id,
			turnId: turns[0]!.id,
			kind: "work",
		};
		expect(CHECK_ROLE).toBe("critic");
		expect(cp.metering).toEqual([
			{ ...base, role: "default", model: WORK_MODEL, usage: WORK_USAGE },
			{ ...base, role: CHECK_ROLE, model: CHECK_MODEL, usage: CHECK_USAGE },
		]);
		// Every control-plane call carried a valid tenant identity, and none failed.
		expect(cp.refused).toEqual([]);
		expect(board.logs).toEqual([]);
	}, 30_000);

	test("through the proxy the board says hosted; unsigned and replayed requests are 401", async () => {
		const state = await proxyFetch("/api/state");
		expect(state.status).toBe(200);
		expect(await state.json()).toMatchObject({
			hosted: true,
			onboarding: false,
		});

		expect((await proxyFetch("/api/state", { identity: null })).status).toBe(
			401,
		);

		const once = signIdentity(SECRET, TENANT, "owner");
		expect((await proxyFetch("/api/state", { identity: once })).status).toBe(
			200,
		);
		expect((await proxyFetch("/api/state", { identity: once })).status).toBe(
			401,
		);

		const prompt = "replayed card";
		const filed = await proxyFetch(`/api/projects/${board.store.name}/tasks`, {
			body: { prompt },
			identity: once,
		});
		expect(filed.status).toBe(401);
		expect(board.store.listTasks().some((t) => t.prompt === prompt)).toBe(
			false,
		);
	});
});
