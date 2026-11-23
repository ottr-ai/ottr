import { type ChildProcess, spawn } from "node:child_process";
import {
	chownSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ensurePackages as ensureAptPackages, parseAptTxt } from "./apt.ts";
import { prepareTurnCache } from "./cachesweep.ts";
import { pidAlive } from "./dblock.ts";
import { devNullGuard } from "./devNullGuard.ts";
import { acquireLayerUse } from "./layers.ts";
import { type SignIn, signIns } from "./login.ts";
import { platform } from "./platform/index.ts";
import { redirectProxyHint } from "./proxyHint.ts";
import {
	ensurePython as buildPythonVenv,
	mergeRequirements,
	parseRequirements,
	type RequirementLine,
} from "./python.ts";
import type { RunSink } from "./runner.ts";
import { sessionFile } from "./session.ts";
import {
	BUSY_MIN_TICKS,
	cardNumOf,
	type DepProof,
	extractInlinePids,
	extractLockPaths,
	extractPidPaths,
	extractPorts,
	type KillExpect,
	type LastTool,
	type LockFact,
	lastToolCall,
	lockFacts,
	lockPathAllowed,
	newestSessionFile,
	normalizeCmd,
	parseLockPid,
	parsePidFile,
	pidFileFacts,
	portListeners,
	readTree,
	type StaleProbe,
} from "./staleTurn.ts";
import { watchProgress } from "./stryker.ts";
import { readCgroup } from "./systemStats.ts";
import { runMarkerPath, tmpDiskSpace, touchRunMarker } from "./tmpsweep.ts";
import {
	buildToolsPath,
	installTools,
	parseToolsJson,
	type ToolEntry,
} from "./tools.ts";
import {
	applyTurnGitEnv,
	applyTurnHomeEnv,
	closeProjectDir,
	ensureProjectIdentity,
	ensureTurnStoreAccess,
	newLayerToken,
	type ProvisionPaths,
	prepareRunWorkspace,
	prepareTurnHome,
	projectTurnUid,
	releaseLayerCopyUse,
	type TurnHome,
	type TurnIdentity,
	turnHomesRoot,
	uidCollisionNote,
} from "./turnUid.ts";
import type { RunResult } from "./types.ts";
import { stripGitAuthEnv, stripProxyCredentials } from "./worktree.ts";

/**
 * Sentinel key of the final response line: the daemon streams omp stdout lines
 * verbatim, then `JSON.stringify({ [WORKER_DONE]: { exitCode, stderrTail } })`.
 *
 * Cancel is the client aborting the run request; the daemon answers by killing the
 * child tree (D4 "cancel (forwarded kill)"). There is deliberately no /cancel
 * endpoint, so N worker replicas behind distinct DNS names stay cancel-correct:
 * each client aborts only its own request.
 */
export const WORKER_DONE = "xdevWorkerDone";

export interface WorkerTarget {
	urls: string[];
	token?: string;
}

export interface WorkerRequest {
	id: string;
	argv: string[];
	cwd: string;
	stdin: string;
	env: Record<string, string>;
	/** The run's project, set by the board on every dispatch (OTTR-994): the turn
	 * identity key. Present even when the turn env strips OTTR_PROJECT (retro and
	 * proposal runs), so a project-less run can only be a direct API caller. */
	project?: string;
	/** The board's confirmed read-only GitHub token env (docs/specs/turn-read-token.md),
	 * applied after the strips — the only GitHub token names a turn may hold. */
	githubReadEnv?: Record<string, string>;
	/** The board's trusted provisioning lists, read from the board home and carried on the
	 * request (docs/specs/worker-list-isolation.md). A worker never reads the shared-home
	 * copies. Classic worker turns carry them here; the vm-runner dispatch carries the
	 * VM bake's own lists on VmSpec (docs/specs/vm-list-isolation.md). */
	lists?: ProvisionLists;
	/** Set only for a vm-runner dispatch (docs/adr/0009-microvm-workers.md); classic workers
	 * are never sent one and ignore it. */
	vm?: VmSpec;
}

/**
 * The board's trusted provisioning lists, raw text. Every field is optional;
 * a missing field means an empty list. No `aptAll`: apt installs read only the
 * project's own list (src/apt.ts), so the fleet apt list has no consumer.
 */
export interface ProvisionLists {
	tools?: string;
	toolsAll?: string;
	apt?: string;
	requirements?: string;
	requirementsAll?: string;
}

/** What vm-runner needs beyond the classic request to run the turn in a fresh microVM. */
export interface VmSpec {
	project: string;
	taskId: string;
	/** Task branch, e.g. "ott/ottr-1-x". */
	branch: string;
	/** task.base: the ref or sha the branch forked from. */
	base: string;
	/** URL the VM uses for the board, e.g. "http://ottr:8080" (OTTR_BOARD_URL). */
	boardUrl: string;
	/** Raw per-turn VM token (git, /llm, /hindsight, card filing). */
	token: string;
	/** Provider ids routed through the board's /llm proxy (pi-native). */
	providers: string[];
	/** true: HINDSIGHT_API_URL=<boardUrl>/hindsight, token = VM token. */
	hindsight: boolean;
	/** Pinned agent layer dir on the shared home, e.g. /root/.alate/layers/<id>. */
	layerDir: string | null;
	/** Absolute paths under /data/<project>/ (files or dirs) copied in at the same path. */
	copyIn: string[];
	/** Absolute dirs under /data/<project>/ whose new/changed files sync back. */
	copyOut: string[];
	/** Board-written card files (e.g. the code scanning alert list) written into the guest's fresh clone after the clone and before omp starts; every path sits inside the run's cwd. The /run validation caps the list at 4 entries of at most 1 MB each. */
	cloneFiles?: { path: string; text: string }[];
	/** The board's trusted provisioning lists (docs/specs/vm-list-isolation.md): the bake
	 * installs exactly these texts; the shared home is never a provisioning input. */
	lists?: ProvisionLists;
}

/** The microVM's end state of the task branch, carried on the done sentinel. */
export interface VmOutcome {
	/** Sha of refs/heads/<branch> the VM last pushed; null = never pushed. */
	head: string | null;
	/** Last push failure text. */
	pushError: string | null;
	/** `git status --porcelain --untracked-files=all` lines at the end; null = the VM could not report. */
	dirty: string[] | null;
	/** Uncommitted files the turn leaves for the board (`research-report.md`, `shots/**`),
	 * worktree-relative, base64 bytes; absent when there are none. The board writes only those
	 * two paths into the server worktree. */
	files?: { path: string; b64: string }[];
}

/**
 * The worker's own omp store: the default home location, even when the board pins its own copy
 * elsewhere (R5-1; the same path `loginStores` in src/login.ts resolves for the workers' store,
 * compose binds it as OTTR_AGENT_DB).
 */
const workerAgentDb = (): string =>
	join(process.env.HOME ?? homedir(), ".omp", "agent", "agent.db");

/**
 * One live or detached run. A detached entry stays in runChildren (its keep-set), keeps
 * the child when the stream drops, and gains `result` or `killed` when the child ends.
 */
interface ActiveRun extends DetachedRun {
	/** Set by /detach: the stream is gone, and nothing on the dead request kills the child. */
	detached: boolean;
	/** Ends the client stream without touching the child; the push helper guards closed. */
	closeStream(): void;
	/** The run's per-card scratch dir (OTTR-1295): the sweeps refresh this run's
	 * liveness marker at it, so a sibling worker sharing the turn-homes volume
	 * keeps the dir. */
	scratch: string;
}

export interface DetachedRun {
	id: string;
	cwd: string;
	pid: number | null;
	running: boolean;
	startedAt: number;
	/** The run's OTTR_DATA_DIR from the request env, when the board set one; null when it
	 * did not. Kept on the entry (attached and detached, so /detached serializes it too)
	 * because /runprobe reads the session transcripts under it after the stream drops
	 * (OTTR-1261). */
	dataDir?: string | null;
	result?: {
		exitCode: number | null;
		stderrTail: string;
		vm?: VmOutcome;
		/** The shared home's provisioned-layer drift the daemon's close audit found. */
		provisionDrift?: string[];
		/** The kernel OOM kill the run died by: set only when the child ended with no
		 * exit code and memory.events' oom_kill count grew between spawn and close
		 * (docs/specs/worker-oom-continue.md). */
		oomKilled?: boolean;
		/** The container's memory.max byte limit read beside the oom_kill counters;
		 * null without a limit ("max") or when the cgroup files were unreadable. */
		memoryLimitBytes?: number | null;
	};
	killed?: boolean;
}

export function serveWorker(opts: {
	port?: number;
	token?: string | null;
	/** Only for tests: the command the daemon runs instead of `omp`. */
	ompPath?: string;
	/** Only for tests: the home provisioning reads and installs into instead of the worker's
	 * own home (the daemon's homedir()). */
	home?: string;
	/** Only for tests: replaces the apt install that runs before omp. */
	ensurePackages?: typeof ensureAptPackages;
	/** Only for tests: replaces the tools install that runs before omp. */
	ensureTools?: typeof installTools;
	/** Only for tests: replaces the requirements venv build that runs before omp. */
	ensurePython?: typeof buildPythonVenv;
	/** Only for tests: replaces the link dir prepended to the child's PATH. */
	buildPath?: typeof buildToolsPath;
	/** The post-run provision guard (docs/specs/turn-provision-guard.md): the daemon audits its
	 * container's shared home against alate's manifest when a run closes. src/worker.ts injects
	 * the real audit; tests omit it and the audit stays off. */
	auditProvisioned?: (
		sinceMs: number,
		rulesAtStart?: readonly string[],
	) => readonly string[];
	/** Captured when a run spawns, before omp starts: the rules dir entries the audit's
	 * untracked scan compares against, so only entries the run added are findings.
	 * src/worker.ts injects the real capture; tests omit it and the scan stays off. */
	rulesAtStart?: () => readonly string[];
	/** Only for tests: roots the /sweep scan instead of /workspace. */
	sweepRoots?: readonly string[];
	/** Only for tests: the SIGTERM grace period of /sweep instead of 1000ms. */
	sweepGraceMs?: number;
	/** Only for tests: the /proc tree /sweep scans instead of the real one. */
	sweepProcRoot?: string;
	/** Only for tests: the signal call /sweep uses instead of process.kill, so a
	 * test can never signal a process it did not create. */
	sweepKill?: typeof process.kill;
	/** Only for tests: the expiry of /detached entries instead of 24 h. */
	detachedTtlMs?: number;
	/** Per-project turn identity (OTTR-994, docs/specs/worker-turn-uid-isolation.md): when set
	 * (src/worker.ts, root daemons only), every turn with a project drops to its project's
	 * uid, provisions into its turn home, and runs with a per-project HOME. Tests and
	 * non-root daemons omit it (or pass null) and keep the legacy identity. */
	turnUid?: {
		homesRoot: string;
		workerHome: string;
		/** Shared roots whose per-project dir is closed for other projects per run. */
		dataRoots: readonly string[];
		/** The workspace mount root: run cwds must live under it (fail closed). */
		workspaceRoot: string;
		/** Provisioning paths the boot/test can point at temp files (OTTR-1184). */
		provisionPaths?: ProvisionPaths;
		/** Only for tests: the turn identity the run drops to instead of the
		 * project's hashed uid. Chown-to-self needs no privilege, so identity
		 * tests run without root (the prune tests use the same selfIds trick). */
		ids?: TurnIdentity;
		/** Only for tests: replaces the mount check of the per-turn store-access check. */
		isMounted?: (path: string) => boolean;
	} | null;
	/** Only for tests: the sign-ins GET /signins reports instead of reading the worker's own store. */
	readSignIns?: () => SignIn[];
	/** Only for tests: the cgroup v2 directory GET /stats and the runs' OOM snapshots
	 * read instead of /sys/fs/cgroup (docs/specs/worker-oom-continue.md). */
	cgroupRoot?: string;
	/** Only for tests: the mutation lock file GET /stats reads instead of tmpdir()/ott-stryker.lock. */
	lockPath?: string;
	/** Only for tests: the /proc tree GET /stats reads the runs' usage from instead of the real one. */
	statsProcRoot?: string;
	/** Only for tests: the /proc tree /runprobe walks for a run's process tree and
	 * /stalefix re-checks the descendant chain in, instead of the real one (OTTR-1261). */
	staleProcRoot?: string;
	/** Only for tests: the sessions dir /runprobe and /stalefix resolve the run's
	 * session transcript in (by the request's session id, or newest-since-start
	 * without one), instead of `<dataDir>/sessions` (OTTR-1261). */
	staleSessionsDir?: string;
	/** Only for tests: the signal call /stalefix kill uses instead of process.kill, so
	 * a test can never signal a process it did not create (OTTR-1261). */
	staleKill?: typeof process.kill;
}): Bun.Server<never> & {
	runStarts(): number[];
	runScratches(): string[];
} {
	// Pids of the live /run children. The sweep must never stop a turn that still runs:
	// a merge turn removes its own worktree mid-run (AGENTS.md step 5), so omp's cwd link
	// ends in " (deleted)" while the turn still has to push and report. Removed on close.
	const runChildren = new Set<number>();
	// Live /run children by the server's run id, plus the runs that detached from a dying
	// server: a rolling restart drops the stream but must keep the child, and boot
	// recovery re-binds it through /detached. Detached entries expire after 24 h; a
	// worker restart loses them, and rows the server cannot re-bind settle as lost.
	const active = new Map<string, ActiveRun>();
	const detached = new Map<string, ActiveRun>();
	// Ids the sweep removed after the run finished, with the removal time: a late
	// kill answers 410 with the expiry instead of a bare not-found.
	const reaped = new Map<string, number>();
	const pruneDetached = (): void => {
		const ttl = opts.detachedTtlMs ?? 24 * 60 * 60 * 1000;
		const now = Date.now();
		for (const [id, e] of detached) {
			// A still-running run keeps its entry past the ttl: deleting it would
			// strand the child unstoppable with its pid held in runChildren.
			if (e.running) continue;
			if (now - e.startedAt > ttl) {
				detached.delete(id);
				reaped.set(id, now);
			}
		}
		for (const [id, at] of reaped) if (now - at > ttl) reaped.delete(id);
	};
	const tokenOk = (request: Request): boolean =>
		!opts.token || request.headers.get("x-otwr-token") === opts.token;
	// OTTR-548: the worker self-reports its own store's sign-ins; the board never reads
	// the worker store (R5-1). Always HTTP 200: the board's tick decides what a null
	// signIns list means, and a warning must never start with a failed request.
	const handleSignIns = async (request: Request): Promise<Response> => {
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		const dbPath = workerAgentDb();
		try {
			// The injected reader answers without touching the worker's own store.
			// The default guards first: a readonly open of a missing path fails
			// with a message that names no file.
			const read =
				opts.readSignIns ??
				(() => {
					if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist`);
					return signIns(dbPath);
				});
			// OTTR-754: the board's /tmp gate reads the worker's self-reported space on
			// both response shapes; null only when statfs itself failed.
			return Response.json({
				signIns: read(),
				tmp: tmpDiskSpace("/tmp"),
			});
		} catch (err) {
			return Response.json({
				signIns: null,
				error: `${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
				tmp: tmpDiskSpace("/tmp"),
			});
		}
	};
	// The System view's per-container numbers: the worker reads its own cgroup, since
	// the server's /proc sees only the whole Docker VM. Each live run's process tree
	// (attached or detached) adds the turn's own share, keyed by the server's run id.
	const handleStats = (request: Request): Response => {
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		const runs = [...active.values(), ...detached.values()].flatMap((e) =>
			e.running && e.pid !== null ? [{ id: e.id, pid: e.pid }] : [],
		);
		return Response.json(
			readCgroup({
				root: opts.cgroupRoot,
				lockPath: opts.lockPath,
				runs,
				procRoot: opts.statsProcRoot,
			}),
		);
	};
	const handleSweep = async (request: Request): Promise<Response> => {
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		try {
			const stopped = await sweepLeftovers({
				roots: opts.sweepRoots,
				graceMs: opts.sweepGraceMs,
				keepPids: runChildren,
				procRoot: opts.sweepProcRoot,
				kill: opts.sweepKill,
			});
			return Response.json(stopped);
		} catch (err) {
			return new Response(err instanceof Error ? err.message : String(err), {
				status: 500,
			});
		}
	};
	const handleDetachKill = async (request: Request): Promise<Response> => {
		pruneDetached();
		let body: { id?: string };
		try {
			body = (await request.json()) as { id?: string };
		} catch {
			return new Response("bad json", { status: 400 });
		}
		const e = typeof body.id === "string" ? detached.get(body.id) : undefined;
		if (e === undefined) {
			if (typeof body.id === "string" && reaped.has(body.id))
				return new Response(`detached run ${body.id} expired and was reaped`, {
					status: 410,
				});
			return new Response("not found", { status: 404 });
		}
		if (e.pid !== null && e.running) platform.killTree(e.pid);
		e.killed = true;
		e.running = false;
		return Response.json({ killed: true });
	};
	const handleDetach = async (request: Request): Promise<Response> => {
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/detach") {
			// The restart drops every /run stream: release them all, keep the children.
			// The abort and cancel handlers no longer kill; the close handler records
			// the result into the detached entry instead of a gone stream.
			let n = 0;
			for (const [id, e] of active) {
				e.detached = true;
				e.closeStream();
				detached.set(id, e);
				active.delete(id);
				n++;
			}
			return Response.json({ detached: n });
		}
		if (request.method === "GET" && url.pathname === "/detached") {
			pruneDetached();
			return Response.json(
				[...detached.values()].map(
					// The internal detach flag, the stream closure, and the run's scratch
					// path (OTTR-1295, daemon-internal) stay off the wire.
					({ closeStream: _c, detached: _d, scratch: _s, ...entry }) => entry,
				),
			);
		}
		if (request.method === "POST" && url.pathname === "/detach/kill")
			return handleDetachKill(request);
		return new Response("not found", { status: 404 });
	};
	// OTTR-1261 (stale turn recovery): the probe below is read-only, and the fixes
	// answer from a fixed allowlist whose preconditions are re-checked immediately
	// before each act — a refused fix changes nothing and carries the reason back.
	// Both endpoints act only on the daemon's own run entries.
	const runEntry = (id: string): ActiveRun | undefined => {
		pruneDetached();
		return active.get(id) ?? detached.get(id);
	};
	// The detach-kill answer style: an expired entry answers 410 with the expiry,
	// every other unknown id 404. An entry without a pid never spawned a child, so
	// there is nothing to probe or fix either.
	const unknownRun = (id: string): Response => {
		if (reaped.has(id))
			return new Response(`detached run ${id} expired and was reaped`, {
				status: 410,
			});
		return new Response("not found", { status: 404 });
	};
	// The sessions dir a probe or fix reads (OTTR-1261): the run's own data dir,
	// captured at spawn; the test seam replaces it wholesale.
	const staleSessionsDirOf = (e: ActiveRun): string | null =>
		opts.staleSessionsDir ?? (e.dataDir ? join(e.dataDir, "sessions") : null);
	const handleRunProbe = async (request: Request): Promise<Response> => {
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}
		if (typeof body !== "object" || body === null)
			return new Response("bad request", { status: 400 });
		const { run, sessionId } = body as {
			run?: unknown;
			sessionId?: unknown;
		};
		if (typeof run !== "string" || run === "")
			return new Response("bad request", { status: 400 });
		// The session id selects the run's own transcript: absent, or a short
		// non-empty string — anything else is a bad body (OTTR-1261).
		if (!validSessionId(sessionId))
			return new Response("bad request", { status: 400 });
		const e = runEntry(run);
		if (e === undefined || e.pid === null) return unknownRun(run);
		return Response.json(
			staleProbeOf(
				e,
				opts.staleProcRoot ?? "/proc",
				staleSessionsDirOf(e),
				sessionId ?? null,
			),
		);
	};
	const handleStaleFix = async (request: Request): Promise<Response> => {
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}
		if (typeof body !== "object" || body === null)
			return new Response("bad request", { status: 400 });
		const { run, action, path, pid, sessionId, expect } = body as {
			run?: unknown;
			action?: unknown;
			path?: unknown;
			pid?: unknown;
			sessionId?: unknown;
			expect?: unknown;
		};
		// The whole request shape validates before any entry lookup: a non-conforming
		// body is 400 even for a run id this daemon does not know. Both fixes carry
		// the diagnosis (expect), so the act-time recheck compares against the
		// diagnosed facts, never a fresh guess (OTTR-1261).
		if (typeof run !== "string" || run === "")
			return new Response("bad request", { status: 400 });
		if (!validSessionId(sessionId))
			return new Response("bad request", { status: 400 });
		if (action === "unlock") {
			if (typeof path !== "string" || path === "" || !validUnlockExpect(expect))
				return new Response("bad request", { status: 400 });
			const e = runEntry(run);
			if (e === undefined || e.pid === null) return unknownRun(run);
			return Response.json(
				staleUnlock(e, path, expect, staleSessionsDirOf(e), sessionId ?? null),
			);
		}
		if (
			action !== "kill" ||
			typeof pid !== "number" ||
			!Number.isInteger(pid) ||
			pid <= 0 ||
			!validKillExpect(expect)
		)
			return new Response("bad request", { status: 400 });
		const e = runEntry(run);
		if (e === undefined || e.pid === null) return unknownRun(run);
		return Response.json(
			staleKillChild(
				e,
				pid,
				expect,
				opts.staleProcRoot ?? "/proc",
				opts.staleKill ?? process.kill,
				staleSessionsDirOf(e),
				sessionId ?? null,
			),
		);
	};
	// The daemon provisions into the run's turn home (the test's when opts.home is set,
	// the per-project turn home when turn identity is on). The request lists are texts,
	// so no read path can reach for the shared home.
	const workerHome = opts.home ?? homedir();
	const turnUid = opts.turnUid ?? null;
	// A failed install or a broken request list ends the run with the error as its stderr
	// tail (the sentinel), so the client sees the provisioner's failure and no run spawns.
	const provisionResponse = async (
		body: WorkerRequest,
		home: string,
	): Promise<{ notes: string; pathDir: string } | Response> => {
		try {
			return await provisionRun(
				opts.ensurePackages ?? ensureAptPackages,
				opts.ensureTools ?? installTools,
				opts.ensurePython ?? buildPythonVenv,
				opts.buildPath ?? buildToolsPath,
				parseTurnLists(body.lists),
				home,
			);
		} catch (err) {
			const stderrTail = `${err instanceof Error ? err.message : String(err)}\n`;
			return new Response(
				`${JSON.stringify({ [WORKER_DONE]: { exitCode: 1, stderrTail } })}\n`,
				{ headers: { "content-type": "text/plain; charset=utf-8" } },
			);
		}
	};
	const parseRunBody = async (
		request: Request,
	): Promise<WorkerRequest | Response> => {
		let body: WorkerRequest;
		try {
			body = (await request.json()) as WorkerRequest;
		} catch {
			return new Response("bad json", { status: 400 });
		}
		if (!validRunBody(body))
			return new Response("bad request", { status: 400 });
		return body;
	};
	// The request's provisioning lists (the board's trusted copies, never the shared home)
	// install in this container before omp starts; a failed install or a broken list ends
	// the run with the error, and the client giving up mid-install must not orphan the run.
	const prepared = async (
		request: Request,
		body: WorkerRequest,
	): Promise<{ notes: string; pathDir: string } | Response> => {
		const project = body.project ?? body.env?.OTTR_PROJECT;
		if (typeof project !== "string" || project === "")
			// No project: no provisioning, and the lists stay ignored (nothing to provision for).
			return { notes: "", pathDir: "" };
		let turnHome: TurnHome | null = null;
		if (turnUid) {
			try {
				turnHome = prepareTurnHome(
					turnUid.homesRoot,
					project,
					turnUid.ids ?? projectTurnUid(project),
				);
			} catch (err) {
				return new Response(`turn-uid: ${String(err)}`, { status: 500 });
			}
		}
		const provided = await provisionResponse(
			body,
			turnHome === null ? workerHome : turnHome.provision,
		);
		if (provided instanceof Response) return provided;
		// The client gave up during the install: spawning now would orphan the run.
		if (request.signal.aborted) return new Response("aborted", { status: 499 });
		return provided;
	};
	const handleRun = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/run")
			return new Response("not found", { status: 404 });
		if (!tokenOk(request)) return new Response("unauthorized", { status: 401 });
		const parsed = await parseRunBody(request);
		if (parsed instanceof Response) return parsed;
		const run = await prepared(request, parsed);
		if (run instanceof Response) return run;
		return startRun(request, parsed, run.notes, run.pathDir);
	};
	const startRun = async (
		request: Request,
		body: WorkerRequest,
		notes: string,
		pathDir: string,
	): Promise<Response> => {
		// The run's start, stamped before anything the run owns exists: the scratch dir
		// created below carries its creation mtime, and the sweeps' live-run guard
		// (start <= newest mtime) must hold even for a scratch that never sees a write.
		const startedAt = Date.now();
		const env = runChildEnv(body.env, body.githubReadEnv, pathDir);
		// Per-project turn identity (OTTR-994): the run drops to its project's uid, its
		// HOME moves to the per-project turn home or layer copy, its project dirs under
		// the shared roots close for other projects, and its cwd plus git common dir
		// become writable by the uid. Any failure here fails the run: never a silent
		// fall-back to a root turn.
		let ids: TurnIdentity | null = null;
		let runNotes = notes;
		// OTTR-1215: the guard runs before this container runs a turn. A repaired
		// device carries its one notice into this run's stream once; a device the
		// guard cannot repair refuses the run closed.
		const dn = devNullGuard.check();
		if (dn.broken && !dn.repaired)
			return new Response(`devnull: ${dn.notice}`, { status: 500 });
		if (dn.first) {
			runNotes += `devnull: ${dn.notice}\n`;
			console.error(`devnull: ${dn.notice}`);
		}
		// The run's release of its layer-copy marker line (OTTR-1179); it rides
		// the same closure as the layer lease, so a finished run stops
		// protecting its copy and the next prune for the project reclaims it.
		let releaseCopyUse: (() => void) | null = null;
		// One project name for the whole run: identity, cache and scratch all key on it.
		const project = body.project ?? body.env?.OTTR_PROJECT;
		if (turnUid) {
			if (typeof project === "string" && project !== "") {
				try {
					ids = turnUid.ids ?? projectTurnUid(project);
					const collision = uidCollisionNote(project, ids);
					if (collision !== null) runNotes += `${collision}\n`;
					const turnHome = prepareTurnHome(turnUid.homesRoot, project, ids);
					const copyToken = newLayerToken();
					const home = applyTurnHomeEnv(env, {
						workerHome: turnUid.workerHome,
						turnHome,
						ids,
						copyToken,
					});
					if (home.pinned)
						releaseCopyUse = () =>
							releaseLayerCopyUse(
								turnHome.layers,
								basename(home.home),
								copyToken,
							);
					// Per-turn store access (OTTR-1291): a root omp run between turns
					// resets the shared store modes, so every turn restores them before
					// it spawns. A mounted drifted store refuses the run instead of
					// chmodding through the mount.
					const agentDir =
						typeof env.PI_CODING_AGENT_DIR === "string" &&
						env.PI_CODING_AGENT_DIR !== ""
							? env.PI_CODING_AGENT_DIR
							: join(env.HOME ?? "", ".omp", "agent");
					const drift = ensureTurnStoreAccess(
						turnUid.workerHome,
						join(agentDir, "agent.db"),
						ids,
						{ isMounted: turnUid.isMounted },
					);
					if (drift !== null) runNotes += `${drift}\n`;
					ensureProjectIdentity(project, ids, turnHome, turnUid.provisionPaths);
					applyTurnGitEnv(env, project, turnHome);
					for (const root of turnUid.dataRoots)
						closeProjectDir(join(root, project), ids);
					prepareRunWorkspace(body.cwd, ids, turnUid.workspaceRoot, project);
				} catch (err) {
					return new Response(`turn-uid: ${String(err)}`, { status: 500 });
				}
			}
		}
		// The provision guard's untracked scan compares against the rules dir as it
		// stood before omp started (docs/specs/turn-provision-guard.md).
		const rulesAtStart = opts.rulesAtStart ? opts.rulesAtStart() : undefined;
		// The OOM detection window opens here: the oom_kill count before the spawn,
		// so a kernel kill that lands during this run is distinguishable from one
		// the container already carried (docs/specs/worker-oom-continue.md).
		const oomBefore = oomSnapshot(opts.cgroupRoot);
		// The worker's own lease on the child's pinned layer (OTTR-1132): it lives until the
		// child closes, so no stream loss, detach, or board settlement can drop it. The
		// release stays in this closure, off the entry that /detached serializes.
		let release: () => void;
		try {
			const lease = workerLayerLease(workerHome, env.HOME);
			release =
				releaseCopyUse === null
					? lease
					: () => {
							lease();
							releaseCopyUse();
						};
		} catch (err) {
			return new Response(`layer lease failed: ${String(err)}`, {
				status: 500,
			});
		}
		// OTTR-1211: per-project cache (every card of the project shares it, two
		// projects never do) and the project's per-card scratch parent, both in the
		// project's turn home — outside the audited shared home and the capped /tmp.
		// Best effort: a failed prep keeps the default env rather than failing the run.
		const turnRoots = prepareTurnCache(
			turnUid?.homesRoot ?? turnHomesRoot(),
			project,
			ids,
		);
		if (turnRoots !== null) Object.assign(env, turnRoots.cacheEnv);
		// The card's private scratch: TMPDIR points into a per-run dir, so the run's
		// temp (pip and bun spills, tool temp) dies with the run — a normal end and a
		// cancel both pass through the child's close. OTTR_TMP_ROOT names this daemon's
		// temp root for files that must stay host-global under the redirected TMPDIR —
		// the mutation lock reads it (scripts/stryker-base.mjs), and GET /stats reads
		// the same root. The run's uid owns the dir: the child drops to that uid
		// (OTTR-994). The run id is a single safe path segment; the mkdtemp suffix
		// keeps concurrent runs unique.
		const scratchParent = turnRoots?.tmp ?? tmpdir();
		const scratch = mkdtempSync(
			join(scratchParent, `run-${runIdSegment(body.id)}-`),
		);
		// OTTR-1295: the liveness marker rides beside the scratch in the daemon-owned
		// parent (written before the scratch's chown, never chowned itself), so a
		// sibling worker sharing the turn-homes volume sees a live run its own
		// starts and /proc cannot. Best effort, like the scratch prep.
		touchRunMarker(scratch);
		env.TMPDIR = scratch;
		env.OTTR_TMP_ROOT = tmpdir();
		if (ids !== null) chownSync(scratch, ids.uid, ids.gid);
		const removeScratch = (): void => {
			try {
				rmSync(scratch, { recursive: true, force: true });
			} catch {
				// A leftover process still holds an entry (a detached dev server's cwd):
				// the next aged sweep takes the tree when its holds clear.
			}
			try {
				rmSync(runMarkerPath(scratch), { force: true });
			} catch {
				// A stale marker expires under the sweep's age rule.
			}
		};
		let child: ChildProcess;
		try {
			child = spawn(opts.ompPath ?? "omp", body.argv, {
				cwd: body.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				...(ids ? { uid: ids.uid, gid: ids.gid } : {}),
			});
		} catch (err) {
			release();
			removeScratch();
			return new Response(`spawn failed: ${String(err)}`, { status: 500 });
		}
		// A live child can emit "error" after spawn. Only a no-child spawn error releases
		// before "close"; a live child's lease must remain held.
		child.on("error", () => {
			if (child.pid === undefined) {
				release();
				removeScratch(); // "close" never fires without a pid
			}
		});
		child.on("close", release);
		child.on("close", removeScratch);
		const forgetChild = (): void => {
			if (child.pid !== undefined) runChildren.delete(child.pid);
		};
		// A spawn error never fires "close", so forget here too.
		child.on("error", forgetChild);
		if (child.pid !== undefined) runChildren.add(child.pid);
		const entry: ActiveRun = {
			id: body.id,
			cwd: body.cwd,
			pid: child.pid ?? null,
			running: true,
			startedAt,
			dataDir: body.env?.OTTR_DATA_DIR ?? null,
			detached: false,
			scratch,
			closeStream: (): void => {},
		};
		active.set(entry.id, entry);
		const forgetEntry = (): void => {
			if (active.get(entry.id) === entry) active.delete(entry.id);
		};
		const killTree = (): void => {
			// Detach releases the client on purpose: nothing on the dead request may kill
			// the child afterwards, and the push helper's closed path lands here too.
			if (entry.detached) return;
			if (child.pid !== undefined) platform.killTree(child.pid);
		};
		// stderrTail stays reserved for omp's stderr: classify's no-stderr death rules
		// (provider rejection, dispatch context) need an empty tail to fire. The apt
		// install notes ride the stream as plain stdout lines instead.
		const state: RunStreamState = {
			closed: false,
			stopWatch: (): void => {},
			partial: "",
			stderrTail: "",
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			state.stderrTail = `${state.stderrTail}${chunk.toString("utf8")}`
				.replace(/\r\n/g, "\n")
				.slice(-4000);
		});
		child.on("error", (err: Error) => {
			forgetEntry();
			state.stderrTail = `${state.stderrTail}${err.message}\n`
				.replace(/\r\n/g, "\n")
				.slice(-4000);
		});
		const stream = openRunStream({
			child,
			entry,
			notes: runNotes,
			stdin: body.stdin,
			state,
			killTree,
			forgetChild,
			forgetEntry,
			auditProvisioned: opts.auditProvisioned,
			rulesAtStart,
			cgroupRoot: opts.cgroupRoot,
			oomBefore,
		});
		request.signal.addEventListener("abort", killTree);
		return new Response(stream, {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	};
	const route = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/healthz") {
			// OTTR-1215: the container probe also guards: it repairs a broken
			// /dev/null between turns, and a device it cannot repair answers 503,
			// which makes compose restart the container onto a fresh /dev.
			const dn = devNullGuard.check();
			if (dn.broken && !dn.repaired)
				return new Response(`devnull: ${dn.notice}`, { status: 503 });
			return new Response("ok");
		}
		if (request.method === "GET" && url.pathname === "/signins")
			return handleSignIns(request);
		if (request.method === "GET" && url.pathname === "/stats")
			return handleStats(request);
		if (request.method === "POST" && url.pathname === "/sweep")
			return handleSweep(request);
		if (request.method === "POST" && url.pathname === "/runprobe")
			return handleRunProbe(request);
		if (request.method === "POST" && url.pathname === "/stalefix")
			return handleStaleFix(request);
		if (
			url.pathname === "/detach" ||
			url.pathname === "/detached" ||
			url.pathname === "/detach/kill"
		)
			return handleDetach(request);
		return handleRun(request);
	};
	// OTTR-754: the sweep reads the startedAt of every live entry (attached and
	// detached — detached work is still live) so it never deletes a turn's own /tmp scratch.
	const runStarts = (): number[] => [
		...[...active.values(), ...detached.values()].map((e) => e.startedAt),
	];
	// OTTR-1295: the same entries' scratch paths — the sweeps refresh each run's
	// liveness marker from them, so a sibling worker sharing the turn-homes
	// volume keeps a live foreign scratch its own guards cannot see.
	const runScratches = (): string[] => [
		...[...active.values(), ...detached.values()].map((e) => e.scratch),
	];
	const server = Bun.serve({
		port: opts.port ?? 8787,
		hostname: "0.0.0.0",
		// Long silent turns must not be cut by an idle timeout.
		idleTimeout: 0,
		fetch: (request) => route(request),
	});
	return Object.assign(server, { runStarts, runScratches });
}

/** The request's list fields; every one optional, a string when present. */
const LIST_FIELDS = [
	"tools",
	"toolsAll",
	"apt",
	"requirements",
	"requirementsAll",
] as const;

/** The lists ride as raw texts: any other shape answers 400 before any provisioning
 * (the parsers own the content, and a broken list fails the run like an install does). */
function validLists(lists: WorkerRequest["lists"]): boolean {
	if (lists === undefined) return true;
	if (typeof lists !== "object" || lists === null || Array.isArray(lists))
		return false;
	const rec = lists as Record<string, unknown>;
	return LIST_FIELDS.every(
		(f) => rec[f] === undefined || typeof rec[f] === "string",
	);
}

/** Serialized strings and arrays are not environment records. */
export function validWorkerEnv(env: unknown): env is Record<string, string> {
	return (
		typeof env === "object" &&
		env !== null &&
		!Array.isArray(env) &&
		Object.values(env).every((value) => typeof value === "string")
	);
}

/** OTTR-1211: the run id as one safe path segment for the per-card scratch dir.
 * The board sends plain ids, but the path must survive any body: every character
 * outside [A-Za-z0-9._-] becomes "_", and an empty or dotted result is "run". */
function runIdSegment(id: string): string {
	const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
	return safe === "" || safe === "." || safe === ".." ? "run" : safe;
}

/** A /run request is well-formed when argv is all strings, cwd is an existing absolute
 * directory, and the lists are texts. */
function validRunBody(body: WorkerRequest): boolean {
	return (
		typeof body === "object" &&
		body !== null &&
		Array.isArray(body.argv) &&
		body.argv.every((a) => typeof a === "string") &&
		typeof body.cwd === "string" &&
		body.cwd !== "" &&
		isAbsolute(body.cwd) &&
		existsSync(body.cwd) &&
		statSync(body.cwd).isDirectory() &&
		validWorkerEnv(body.env) &&
		(body.githubReadEnv === undefined || validWorkerEnv(body.githubReadEnv)) &&
		validLists(body.lists)
	);
}

/** The request's lists, parsed once at the boundary; absent fields mean empty lists. */
interface TurnLists {
	tools: ToolEntry[];
	toolsAll: ToolEntry[];
	apt: string[];
	requirements: RequirementLine[];
	requirementsAll: RequirementLine[];
}

/** Parses one list field with an existing parser; a failure names the field, so the run's
 * stderr tail says which list was bad. */
function parseListField<T>(
	field: string,
	text: string | undefined,
	parse: (raw: string) => T,
): T {
	if (text === undefined) return [] as T;
	try {
		return parse(text);
	} catch (err) {
		throw new Error(
			`${err instanceof Error ? err.message : String(err)} (request field: ${field})`,
		);
	}
}

function parseTurnLists(lists: WorkerRequest["lists"]): TurnLists {
	return {
		tools: parseListField("tools", lists?.tools, parseToolsJson),
		toolsAll: parseListField("toolsAll", lists?.toolsAll, parseToolsJson),
		apt: parseListField("apt", lists?.apt, parseAptTxt),
		requirements: parseListField(
			"requirements",
			lists?.requirements,
			parseRequirements,
		),
		requirementsAll: parseListField(
			"requirementsAll",
			lists?.requirementsAll,
			parseRequirements,
		),
	};
}

/** Installs the request's packages, tools and python venv, and resolves the tools PATH dir.
 * Throws when a list parse or an install fails: the caller answers with the error as the
 * run's stderr tail. */
async function provisionRun(
	ensurePackages: typeof ensureAptPackages,
	ensureTools: typeof installTools,
	ensurePython: typeof buildPythonVenv,
	buildPath: typeof buildToolsPath,
	lists: TurnLists,
	home: string,
): Promise<{ notes: string; pathDir: string }> {
	const aptLines = await ensurePackages(lists.apt, "the run request");
	// Install order stays the fleet's entries first, then the project's own.
	const toolLines = await ensureTools(
		[...lists.toolsAll, ...lists.tools],
		home,
	);
	// The venv builds into the shared home, but stays off the PATH: a worker work
	// turn keeps its ad-hoc pip --user flow, and a venv bin dir first on PATH would
	// shadow the user site it installs into (docs/specs/merge-turn-packages.md).
	const pipLines = await ensurePython(
		mergeRequirements(lists.requirements, lists.requirementsAll),
		home,
	);
	// Link priority stays the project's name first, then _all (buildToolsPath first-wins).
	const pathDir = buildPath([...lists.tools, ...lists.toolsAll], home);
	const notes = [...aptLines, ...toolLines, ...pipLines]
		.map((l) => `${l}\n`)
		.join("");
	return { notes, pathDir };
}

/**
 * The worker's lease on the layer the child's HOME pins (OTTR-1132), as acquireLayerUse's
 * idempotent release (it never throws: a failed release warns and keeps the protection). Only a
 * real directory straight below the worker home's `.alate/layers` takes a lease, in the
 * worker home's own registry: the request never picks the root. Any other HOME (the flat
 * home, a symlinked or nested path, a foreign home) gets a no-op release. A failed
 * acquisition throws, so no child reads an unprotected layer.
 */
function workerLayerLease(
	workerHome: string,
	home: string | undefined,
): () => void {
	const none = (): void => {};
	if (home === undefined || !isAbsolute(home)) return none;
	let real: string;
	let layersRoot: string;
	try {
		real = realpathSync(home);
		layersRoot = join(realpathSync(workerHome), ".alate", "layers");
	} catch {
		return none;
	}
	// Any symlink on the way (a planted layers/<id> link, a linked .alate) changes the
	// realpath: equality proves HOME is the real layer dir itself.
	if (real !== home || dirname(real) !== layersRoot) return none;
	if (!statSync(real).isDirectory()) return none;
	return acquireLayerUse(workerHome, basename(real));
}

/** The child's env: request env over the container env, minus every push credential and the
 * alate key; the tools link dir prepended to PATH. */
function runChildEnv(
	requestEnv: Record<string, string>,
	githubReadEnv: Record<string, string> | undefined,
	pathDir: string,
): Record<string, string | undefined> {
	// The worker's own token drives every worker, and the container env can hold a git
	// host token (an operator's GH_TOKEN): a turn inherits neither, from the container
	// or the request. Push credentials stay on the server (D6).
	// The container may carry a Hindsight seed (docker-compose.yml): the board strips
	// HINDSIGHT_* from the dispatched env and re-adds the run's own binding, so the
	// container names must lose the seed BEFORE the merge, or the delete after it would
	// take the request's bound values too (docs/specs/hindsight-bank-binding.md).
	const containerEnv: Record<string, string | undefined> = { ...process.env };
	for (const k of Object.keys(containerEnv))
		if (k.startsWith("HINDSIGHT_")) delete containerEnv[k];
	const env: Record<string, string | undefined> = {
		...containerEnv,
		...requestEnv,
	};
	stripGitAuthEnv(env);
	// OTTR-693: the board strips GIT_CONFIG_GLOBAL from the dispatched env (the
	// pointer names a file only the server mounts); this side deletes whatever the
	// worker container itself carries, so the turn's git never swaps the shared
	// home's ~/.gitconfig for a file that does not exist here.
	delete env.GIT_CONFIG_GLOBAL;
	delete env.OTTR_WORKER_TOKEN;
	// Same strip as childEnv on the server: no turn ever needs the alate key.
	delete env.ALATE_API_KEY;
	// Same strip as childEnv on the server: the container env can carry a
	// corporate proxy URL with credentials; a turn keeps host and port only.
	stripProxyCredentials(env);
	// The delivered read-only GitHub token lands last (docs/specs/turn-read-token.md):
	// it survives every strip above and overrides any ambient name.
	Object.assign(env, githubReadEnv);
	// Apply these after every source, including the secondary request environment.
	delete env.OTTR_DATABASE_URL;
	// Same strip as childEnv on the server: the SecretBox master key unseals the
	// sealed credential store; a turn inherits it from neither the container env
	// nor a request env.
	delete env.OTTR_SECRET_KEY;
	// The tools link dir is per tool set: project pins, then _all pins, then the container
	// PATH. The daemon's own PATH never changes, and two projects never see each
	// other's pins because the dir is keyed by the project's own tool set.
	if (pathDir) env.PATH = `${pathDir}:${String(env.PATH ?? "")}`;
	return env;
}

/** Memory bound for one accumulated stream line (worker daemon stdout, the board's
 * worker stream reader, the VM relay). Counted in UTF-16 characters of the decoded
 * text (within 2x of the wire bytes for any input), far above any real event line.
 * A newline-free line over this size is dropped with a notice line instead of
 * growing the reader's buffer: validation #OTTR-1231 OOM-killed a 512 MiB job at a
 * 128 MiB newline-free line, with superlinear CPU from the rescan-from-offset-zero
 * search (OTTR-1035). */
export const MAX_STREAM_LINE_CHARS = 4 * 1024 * 1024;

/** The plain-text loss notice feedCappedLines emits once per dropped oversized
 * line. Not JSON: every sink logs it verbatim into the run log. */
export const lineDropNotice = (): string =>
	`[ottr] dropped a stream line over ${MAX_STREAM_LINE_CHARS} characters; the rest of the line is skipped`;

/** Line-splitting state of one stream: the unterminated tail, bounded by
 * MAX_STREAM_LINE_CHARS, and whether the reader is inside a dropped oversized line. */
export interface LineCapState {
	partial: string;
	dropping: boolean;
}

/** Feeds one decoded chunk through `line` a full line at a time, with a per-line cap.
 * The newline search runs over the new chunk only, never a rescan of the accumulated
 * tail. A line whose accumulation would pass MAX_STREAM_LINE_CHARS is dropped: the
 * tail is discarded, `dropped` fires once, the rest of that line is skipped up to its
 * newline (in this chunk or a later one), and following lines are kept. Every stdout
 * and event stream reader feeds through this, so one oversized line can neither grow
 * memory without bound nor pay a full-buffer rescan per chunk (OTTR-1035). */
export function feedCappedLines(
	cap: LineCapState,
	chunk: string,
	line: (text: string) => void,
	dropped: () => void,
): void {
	let start = 0;
	for (;;) {
		const end = chunk.indexOf("\n", start);
		if (end === -1) break;
		const seg = chunk.slice(start, end);
		if (cap.dropping)
			cap.dropping = false; // the dropped line ends here; keep the next
		else if (cap.partial.length + seg.length > MAX_STREAM_LINE_CHARS) {
			// This line completes over the cap inside one chunk: drop it whole. The
			// newline already ended it, so no skip mode is needed for the rest.
			cap.partial = "";
			dropped();
		} else {
			line(cap.partial ? cap.partial + seg : seg);
			cap.partial = "";
		}
		start = end + 1;
	}
	const rest = start === 0 ? chunk : chunk.slice(start);
	if (!rest || cap.dropping) return;
	if (cap.partial.length + rest.length > MAX_STREAM_LINE_CHARS) {
		cap.partial = "";
		cap.dropping = true;
		dropped();
		return;
	}
	cap.partial += rest;
}

/** End-of-stream flush for feedCappedLines: emits the bounded unterminated tail as
 * the last line. A dropped line has no tail and no second notice; its notice fired
 * at the drop. */
export function flushCappedLines(
	cap: LineCapState,
	line: (text: string) => void,
): void {
	if (cap.partial.length > 0) {
		line(cap.partial);
		cap.partial = "";
	}
}

/** Mutable state of one /run: the stream's closed flag, the stryker watch stopper, omp's
 * unterminated stdout tail, and the reserved stderr tail. */
interface RunStreamState {
	closed: boolean;
	stopWatch(): void;
	partial: string;
	stderrTail: string;
}

/** What openRunStream needs to wire one run's stream to its child and lifecycle helpers. */
interface RunStreamArgs {
	child: ChildProcess;
	entry: ActiveRun;
	notes: string;
	stdin: string;
	state: RunStreamState;
	killTree(): void;
	forgetChild(): void;
	forgetEntry(): void;
	auditProvisioned?: (
		sinceMs: number,
		rulesAtStart?: readonly string[],
	) => readonly string[];
	rulesAtStart: readonly string[] | undefined;
	/** The run's cgroup v2 root: the after-close OOM snapshot reads the same seam
	 * GET /stats reads (docs/specs/worker-oom-continue.md). */
	cgroupRoot: string | undefined;
	/** The OOM snapshot taken before the spawn; null when the container had no
	 * readable memory.events at spawn time. */
	oomBefore: OomSnapshot | null;
}

/** Feeds one omp stdout chunk through push a full line at a time; the tail stays in `state`. */
function pushLines(
	state: RunStreamState,
	chunk: Buffer,
	push: (text: string) => void,
): void {
	state.partial += chunk.toString("utf8");
	let idx = state.partial.indexOf("\n");
	while (idx >= 0) {
		push(state.partial.slice(0, idx + 1));
		state.partial = state.partial.slice(idx + 1);
		idx = state.partial.indexOf("\n");
	}
}

/** One OOM snapshot of the worker container's cgroup v2 files
 * (docs/specs/worker-oom-continue.md): the memory.events oom_kill count and the
 * memory.max byte limit ("max" and unreadable files degrade to null). Null when the
 * container had no readable memory.events, so a run without cgroup v2 never flags.
 * readCgroup never throws, and neither does this. */
interface OomSnapshot {
	oomKill: number;
	limitBytes: number | null;
}

function oomSnapshot(cgroupRoot: string | undefined): OomSnapshot | null {
	const reading = readCgroup({ root: cgroupRoot });
	if (reading.memoryEvents === null) return null;
	return {
		oomKill: reading.memoryEvents.oomKill,
		limitBytes:
			typeof reading.memoryMax === "number" ? reading.memoryMax : null,
	};
}

/** The run's end: forget the child, audit the shared home's drift, then either park the
 * result on the detached entry or flush the stdout tail and the done sentinel. */
function finishRun(
	args: RunStreamArgs,
	code: number | null,
	push: (text: string) => void,
	closeController: () => void,
): void {
	const { entry, state } = args;
	state.stopWatch();
	args.forgetChild();
	args.forgetEntry();
	// The provision guard audits this container's shared home once the run's
	// writes are final (docs/specs/turn-provision-guard.md); drift rides the
	// result, and classify parks the turn.
	const provisionDrift =
		args.auditProvisioned?.(entry.startedAt, args.rulesAtStart) ?? [];
	const driftField = provisionDrift.length
		? { provisionDrift: [...provisionDrift] }
		: {};
	// OOM naming (docs/specs/worker-oom-continue.md): a child that ended with no exit
	// code while the container's oom_kill count grew between the snapshots died by the
	// kernel OOM killer, and the limit rides along. An exit-code end never flags, and a
	// null snapshot keeps today's shape. Sync reads only (readCgroup is readFileSync
	// based), so finishRun stays sync.
	let oomField: { oomKilled: true; memoryLimitBytes: number | null } | {} = {};
	if (code === null && args.oomBefore !== null) {
		const after = oomSnapshot(args.cgroupRoot);
		if (after !== null && after.oomKill > args.oomBefore.oomKill)
			oomField = { oomKilled: true, memoryLimitBytes: after.limitBytes };
	}
	if (entry.detached) {
		// No client listens any more: the result waits in /detached for boot
		// recovery instead of a sentinel on a gone stream.
		entry.running = false;
		entry.result = {
			exitCode: code ?? null,
			stderrTail: state.stderrTail,
			...driftField,
			...oomField,
		};
		return;
	}
	if (state.partial.length > 0) push(`${state.partial}\n`);
	push(
		`${JSON.stringify({ [WORKER_DONE]: { exitCode: code ?? null, stderrTail: state.stderrTail, host: hostname(), ...driftField, ...oomField } })}\n`,
	);
	closeController();
}

/** The run's response stream: install notes, omp stdout lines, the stryker progress watch,
 * and the done sentinel — while the entry stays attached to a client. */
function openRunStream(args: RunStreamArgs): ReadableStream<Uint8Array> {
	const { entry, state } = args;
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			entry.closeStream = (): void => {
				if (state.closed) return;
				state.closed = true;
				state.stopWatch();
				try {
					controller.close();
				} catch {
					// already gone
				}
			};
			// Lines omp wrote before the kill still drain from the pipe after the client
			// left; a push into the gone stream throws from an event handler, which crashes
			// this daemon (no crash trap) and every turn it runs.
			const push = (text: string): void => {
				if (state.closed) return;
				try {
					controller.enqueue(enc.encode(text));
				} catch {
					state.closed = true; // the stream ended without cancel(): nobody reads omp now
					args.killTree();
				}
			};
			// The install notes lead the stream as plain lines: the client logs non-JSON
			// lines verbatim, and omp's stderr tail stays clean for classify's rules.
			if (args.notes) push(args.notes);
			// Stryker progress rides the stream as one more event line (stryker.ts).
			state.stopWatch = watchProgress(args.child.pid, push);
			args.child.stdout?.on("data", (chunk: Buffer) =>
				pushLines(state, chunk, push),
			);
			// omp may die before reading stdin; a bare write would then crash us.
			args.child.stdin?.on("error", () => {});
			args.child.stdin?.write(args.stdin, "utf8");
			args.child.stdin?.end();
			args.child.on("close", (code) =>
				finishRun(args, code, push, () => {
					if (!state.closed) controller.close(); // else the client aborted; the stream is gone
				}),
			);
		},
		cancel() {
			state.closed = true;
			state.stopWatch();
			args.killTree();
		},
	});
}

/** Thrown when the worker is unreachable or answers non-200; the caller settles the run as a lost worker. */
export class WorkerConnectError extends Error {}

/**
 * Thrown when vm-runner answers /run with 503 + `x-ottr-busy: 1` (every OTTR_VM_MAX microVM
 * taken). Not a WorkerConnectError: nothing ran and nothing is lost, the card just waits.
 */
export class WorkerBusyError extends Error {}

function parseSentinel(line: string): {
	exitCode: number | null;
	stderrTail: string;
	host?: string;
	vm?: VmOutcome;
	provisionDrift?: string[];
	oomKilled?: boolean;
	memoryLimitBytes?: number | null;
} | null {
	const stringList = (v: unknown): v is string[] =>
		Array.isArray(v) && v.length > 0 && v.every((l) => typeof l === "string");
	// Loose checks like the rest of the sentinel: a field with the wrong type is
	// dropped, never trusted (docs/specs/worker-oom-continue.md).
	const byteLimit = (v: unknown): v is number | null =>
		v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
	try {
		const v = JSON.parse(line) as Record<string, unknown>;
		const done = v[WORKER_DONE] as Record<string, unknown> | undefined;
		if (
			typeof done === "object" &&
			done !== null &&
			"exitCode" in done &&
			typeof done.stderrTail === "string"
		)
			return {
				exitCode: done.exitCode as number | null,
				stderrTail: done.stderrTail,
				...(typeof done.host === "string" && done.host !== ""
					? { host: done.host }
					: {}),
				...(isVmOutcome(done.vm) ? { vm: vmOutcome(done.vm) } : {}),
				...(stringList(done.provisionDrift)
					? { provisionDrift: done.provisionDrift }
					: {}),
				...(typeof done.oomKilled === "boolean"
					? { oomKilled: done.oomKilled }
					: {}),
				...(byteLimit(done.memoryLimitBytes)
					? { memoryLimitBytes: done.memoryLimitBytes }
					: {}),
			};
	} catch {
		// not JSON, not the sentinel
	}
	return null;
}

function isVmOutcome(v: unknown): v is VmOutcome {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.head === null || typeof o.head === "string") &&
		(o.pushError === null || typeof o.pushError === "string") &&
		(o.dirty === null ||
			(Array.isArray(o.dirty) && o.dirty.every((l) => typeof l === "string")))
	);
}

/** The outcome with `files` kept only when every entry has a string path and b64. */
function vmOutcome(v: VmOutcome): VmOutcome {
	const { files, ...rest } = v as VmOutcome & { files?: unknown };
	return Array.isArray(files) &&
		files.every(
			(f) =>
				typeof f === "object" &&
				f !== null &&
				typeof (f as Record<string, unknown>).path === "string" &&
				typeof (f as Record<string, unknown>).b64 === "string",
		)
		? { ...rest, files: files as { path: string; b64: string }[] }
		: rest;
}

/** Round-robin over the target's urls; shared by runWorker and the dispatch log line. */
let rr = 0;
function nextUrl(target: WorkerTarget): string {
	const url = target.urls[rr % target.urls.length];
	rr += 1;
	if (url !== undefined) return url;
	return "";
}

/** POSTs the run request; maps the busy and non-200 answers to the worker errors. */
async function dispatchRun(
	url: string,
	req: WorkerRequest,
	target: WorkerTarget,
	controller: AbortController,
): Promise<Response> {
	if (
		!validWorkerEnv(req.env) ||
		(req.githubReadEnv !== undefined && !validWorkerEnv(req.githubReadEnv))
	)
		throw new WorkerConnectError("bad request environment");
	const env = { ...req.env };
	delete env.OTTR_DATABASE_URL;
	const githubReadEnv =
		req.githubReadEnv === undefined ? undefined : { ...req.githubReadEnv };
	if (githubReadEnv !== undefined) delete githubReadEnv.OTTR_DATABASE_URL;
	const res = await fetch(`${url}/run`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(target.token ? { "x-otwr-token": target.token } : {}),
		},
		body: JSON.stringify({ ...req, env, githubReadEnv }),
		signal: controller.signal,
		// redirect: "manual": the worker token must never follow a redirect
		// off-host; a 3xx answer fails the dispatch like any non-200.
		redirect: "manual",
		// The daemon never idles out (idleTimeout 0); a silent turn (a quiet build,
		// hidden reasoning) must not trip Bun's default 5-minute client idle timer.
		timeout: false,
	});
	if (res.status === 503 && res.headers.get("x-ottr-busy") === "1") {
		await res.body?.cancel();
		throw new WorkerBusyError(`worker ${url} is busy`);
	}
	if (res.status !== 200) {
		// The daemon's 500 body ("spawn failed: ...") is the real cause; surface it
		// instead of only the status. ponytail: capped, the body is one error line.
		const redirected = res.status >= 300 && res.status < 400;
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url} responded ${res.status}${redirected ? ` (redirect not followed${redirectProxyHint(url, res)})` : ""}${body ? `: ${body}` : ""}`,
		);
	}
	return res;
}

/** Settles the run from the done sentinel: the stderr lines, then the sink's result. */
function settleSentinel(
	sentinel: NonNullable<ReturnType<typeof parseSentinel>>,
	sink: RunSink,
	url: string,
	finish: (r: RunResult) => void,
): void {
	for (const l of sentinel.stderrTail.split("\n"))
		if (l.trim()) sink.stderrLine(l);
	finish(
		sink.result({
			exitCode: sentinel.exitCode,
			killed: false,
			stderrTail: sentinel.stderrTail,
			...(typeof sentinel.host === "string" && sentinel.host !== ""
				? {
						ranOn: `worker ${new URL(url).hostname} (${sentinel.host})`,
					}
				: {}),
			...(sentinel.vm ? { vm: sentinel.vm } : {}),
			...(sentinel.provisionDrift
				? { provisionDrift: sentinel.provisionDrift }
				: {}),
			...(sentinel.oomKilled !== undefined
				? { oomKilled: sentinel.oomKilled }
				: {}),
			...(sentinel.memoryLimitBytes !== undefined
				? { memoryLimitBytes: sentinel.memoryLimitBytes }
				: {}),
		}),
	);
}

/** Reads the worker's stream to its done sentinel and settles the run; a stream that dies
 * first aborts the request (so the daemon kills omp) and settles as a lost connection. */
async function consumeRun(
	url: string,
	res: Response,
	controller: AbortController,
	sink: RunSink,
	finish: (r: RunResult) => void,
	settled: () => boolean,
): Promise<void> {
	const body = res.body;
	if (body === null) throw new Error(`worker ${url} answered 200 with no body`);
	const reader = body.getReader();
	const dec = new TextDecoder();
	let partial = "";
	let lost: string | undefined;
	try {
		for (;;) {
			if (settled()) return;
			const { done: ended, value } = await reader.read();
			if (settled()) return;
			if (ended) break;
			partial += dec.decode(value, { stream: true });
			let idx = partial.indexOf("\n");
			while (idx >= 0) {
				const line = partial.slice(0, idx);
				partial = partial.slice(idx + 1);
				const sentinel = parseSentinel(line);
				if (sentinel) {
					settleSentinel(sentinel, sink, url, finish);
					return;
				}
				sink.line(line);
				idx = partial.indexOf("\n");
			}
		}
	} catch (err) {
		// Keep the cause: the tail names why the stream died (idle timer, reset, ...).
		lost = err instanceof Error ? err.message : String(err);
	}
	if (partial.trim()) sink.line(partial);
	if (settled()) return;
	// Gone without a sentinel: cancel the request so the daemon kills omp instead of
	// running a turn whose client left (also covers a throw inside the read loop).
	controller.abort();
	finish(
		sink.result({
			exitCode: null,
			killed: false,
			stderrTail: `${sink.tail()}\nworker connection lost${lost ? `: ${lost}` : ""}`,
			workerLost: true,
		}),
	);
}

export function runWorker(
	req: WorkerRequest,
	target: WorkerTarget,
	sink: RunSink,
): {
	url: string;
	pid: null;
	done: Promise<RunResult>;
	/** true once the runner answered /run with 200 (the turn started); false when the
	 * dispatch never started (busy, refused, unreachable, killed first). Never rejects. */
	accepted: Promise<boolean>;
	kill(): void;
} {
	const url = nextUrl(target);
	sink.logMark(`worker: dispatching to ${url}\n`);
	const controller = new AbortController();
	let settled = false;
	const {
		promise: done,
		resolve: resolveDone,
		reject: rejectDone,
	} = Promise.withResolvers<RunResult>();
	const { promise: accepted, resolve: resolveAccepted } =
		Promise.withResolvers<boolean>();
	const finish = (r: RunResult): void => {
		resolveAccepted(false); // no-op once the 200 resolved it true
		if (settled) return;
		settled = true;
		void sink.drain().then(() => resolveDone(r), rejectDone);
	};
	const fail = (e: unknown): void => {
		resolveAccepted(false);
		if (settled) return;
		settled = true;
		void sink.drain().then(() => rejectDone(e), rejectDone);
	};

	(async () => {
		let res: Response;
		try {
			res = await dispatchRun(url, req, target, controller);
		} catch (err) {
			if (controller.signal.aborted) return; // kill() already settled
			fail(
				err instanceof WorkerConnectError || err instanceof WorkerBusyError
					? err
					: new WorkerConnectError(String(err)),
			);
			return;
		}
		resolveAccepted(true);

		await consumeRun(url, res, controller, sink, finish, () => settled);
	})().catch(fail);

	return {
		url,
		// pid lives in the worker container's namespace; the tracker never sees it.
		pid: null,
		done,
		accepted,
		kill: () => {
			if (settled) return;
			// The daemon's killTree is fire-and-forget: abort and settle now, never wait.
			controller.abort();
			finish(
				sink.result({ exitCode: null, killed: true, stderrTail: sink.tail() }),
			);
		},
	};
}

export interface SweptProcess {
	pid: number;
	/** Full argv joined with single spaces, "" when unreadable. */
	command: string;
	/** Path segment between the root and .worktrees. */
	project: string;
	/** Path segment right after .worktrees. */
	cardId: string;
}

/**
 * Classifies a /proc/<pid>/cwd readlink result against the sweep roots. A deleted
 * worktree leaves the link pointing at "<root>/<project>/.worktrees/<cardId>... (deleted)";
 * only that exact suffix counts, so a still-present worktree never matches.
 */
export function matchSweepTarget(
	cwdLink: string,
	roots: readonly string[],
): { project: string; cardId: string } | null {
	const suffix = " (deleted)";
	if (!cwdLink.endsWith(suffix)) return null;
	const p = cwdLink.slice(0, -suffix.length);
	for (const root of roots) {
		if (p !== root && !p.startsWith(`${root}/`)) continue;
		const segments = p.slice(root.length + 1).split("/");
		const wt = segments.indexOf(".worktrees");
		if (wt <= 0 || wt + 1 >= segments.length) continue;
		const project = segments.slice(0, wt).join("/");
		const cardId = segments[wt + 1];
		if (project === "" || cardId === undefined || cardId === "") continue;
		return { project, cardId };
	}
	return null;
}

/** One /proc snapshot of pid → parent: unreadable stat or an exited pid is skipped. */
function procParents(procRoot: string): Map<number, number> {
	const ppid = new Map<number, number>();
	for (const name of readdirSync(procRoot)) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		try {
			const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
			// comm can hold spaces and parens: fields start after the last ")".
			const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const parent = Number(after[1]);
			if (Number.isInteger(parent)) ppid.set(pid, parent);
		} catch {
			// exited between readdir and stat
		}
	}
	return ppid;
}

/** The keep roots plus every descendant, via BFS over the ppid snapshot. */
function keepTrees(
	ppid: Map<number, number>,
	keepPids: Iterable<number>,
): Set<number> {
	const keep = new Set<number>();
	const queue = [...keepPids];
	while (queue.length > 0) {
		const pid = queue.pop();
		if (pid === undefined) break;
		if (keep.has(pid)) continue;
		keep.add(pid);
		for (const [child, parent] of ppid)
			if (parent === pid && !keep.has(child)) queue.push(child);
	}
	return keep;
}

/** Full argv joined with single spaces, "" when unreadable. */
function pidCommand(procRoot: string, pid: number): string {
	try {
		return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8")
			.split("\0")
			.filter((seg) => seg !== "")
			.join(" ");
	} catch {
		return "";
	}
}

/** The processes whose cwd is a deleted worktree under the roots; kept pids are never targets. */
function sweepTargets(
	roots: readonly string[],
	procRoot: string,
	keep: Set<number>,
): SweptProcess[] {
	const targets: SweptProcess[] = [];
	for (const name of readdirSync(procRoot)) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
		if (keep.has(pid)) continue; // a live /run child (or its tree) is not a leftover
		let cwdLink: string;
		try {
			cwdLink = readlinkSync(`${procRoot}/${pid}/cwd`);
		} catch {
			continue; // exited, zombie, or permission denied
		}
		const match = matchSweepTarget(cwdLink, roots);
		if (match === null) continue;
		targets.push({ pid, command: pidCommand(procRoot, pid), ...match });
	}
	return targets;
}

/** SIGTERM first, then SIGKILL after the grace period for anything still alive. */
async function stopTargets(
	targets: SweptProcess[],
	kill: typeof process.kill,
	graceMs: number,
): Promise<SweptProcess[]> {
	const stopped: SweptProcess[] = [];
	for (const target of targets) {
		try {
			kill(target.pid, "SIGTERM");
		} catch {
			continue; // ESRCH: already gone
		}
		stopped.push(target);
	}
	if (stopped.length > 0) await Bun.sleep(graceMs);
	for (const target of stopped) {
		try {
			// Signal 0: existence probe. ESRCH here means the process took the TERM.
			kill(target.pid, 0);
			kill(target.pid, "SIGKILL");
		} catch {
			// already exited between the check and the kill
		}
	}
	return stopped;
}

/**
 * Kills processes whose cwd is a deleted worktree under the roots (leftover dev
 * servers from a finished card). SIGTERM first, then SIGKILL after the grace
 * period for anything still alive. Throws when /proc itself is unreadable.
 *
 * `keepPids` names processes that must survive: the daemon's live /run children.
 * Their whole descendant trees are excluded too, so a turn's shells and dev
 * servers stay safe while the turn runs. A merge turn can remove its own
 * worktree mid-run, which turns its cwd link into a " (deleted)" one — still a
 * live run, never a leftover.
 */
async function sweepLeftovers(opts?: {
	roots?: readonly string[];
	graceMs?: number;
	keepPids?: Iterable<number>;
	/** Only for tests: the /proc tree to scan instead of the real one. */
	procRoot?: string;
	/** Only for tests: the signal call instead of process.kill. A test must never
	 * let a sweep signal a process it did not create: a mutant that widens the
	 * target set would otherwise kill the worker daemon, Stryker, and the shell. */
	kill?: typeof process.kill;
}): Promise<SweptProcess[]> {
	const roots = opts?.roots ?? ["/workspace"];
	const graceMs = opts?.graceMs ?? 1000;
	const procRoot = opts?.procRoot ?? "/proc";
	const kill = opts?.kill ?? process.kill;
	// One /proc snapshot of the parent links; the kept set is the keep roots plus
	// every descendant (BFS over ppid). A process that forks after the snapshot is
	// swept at the next tick, same known gap killTree has.
	const keep = keepTrees(procParents(procRoot), opts?.keepPids ?? []);
	const targets = sweepTargets(roots, procRoot, keep);
	return stopTargets(targets, kill, graceMs);
}

// --- Stale turn recovery (OTTR-1261): the /runprobe facts and the /stalefix
// allowlist. Session and command text are untrusted: they select which facts to
// read, never what to execute, and every fix re-derives its preconditions from
// real paths and a fresh /proc walk immediately before it acts.

/** Cap of a process's argv on the wire, and of the session text a fix compares. */
const SESSION_TAIL_BYTES = 64 * 1024;

/** The temp roots a lock may live in when the card-number segment rule passes. The
 *  process tmpdir rides the list (OTTR-1306): a redirected TMPDIR (the fast-scratch
 *  rule for full runs) is still a known temp root. */
const STALE_TEMP_ROOTS = [...new Set(["/tmp", "/var/tmp", tmpdir()])];

/** Reads at most `len` bytes at absolute offset `from` of an open file and decodes them
 * tolerantly (a byte cut mid code point never throws). */
function decodeAt(fd: number, from: number, len: number): string {
	const buf = Buffer.alloc(len);
	let read = 0;
	while (read < len) {
		const n = readSync(fd, buf, read, len - read, from + read);
		if (n <= 0) break;
		read += n;
	}
	return new TextDecoder("utf8", { fatal: false }).decode(
		buf.subarray(0, read),
	);
}

/** The first at most `bytes` bytes of a file, or null when it cannot be read. */
function readHeadText(path: string, bytes: number): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		return decodeAt(fd, 0, Math.min(bytes, size));
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/** The last at most `bytes` bytes of a file, or null when it cannot be read. A first
 * line the window cut mid-record is dropped, so the JSONL parse only sees whole lines. */
function readTailText(path: string, bytes: number): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		const from = Math.max(0, size - bytes);
		const text = decodeAt(fd, from, size - from);
		if (from === 0) return text;
		const nl = text.indexOf("\n");
		return nl === -1 ? "" : text.slice(nl + 1);
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/** The session file a probe or fix reads (OTTR-1261): the run's own file by session
 * id when the request names one — a missing id resolves to null, never to a foreign
 * transcript; without an id the newest file since the run started, still only a
 * signal (nearly every run dispatches its session id within the first events). */
function staleSessionPath(
	e: { startedAt: number },
	sessionsDir: string | null,
	sessionId: string | null,
): string | null {
	if (sessionsDir === null) return null;
	if (sessionId !== null) return sessionFile(sessionsDir, sessionId);
	return newestSessionFile(sessionsDir, e.startedAt)?.path ?? null;
}

/** The last tool call the resolved session tail holds right now, or null. Same
 * bounded tail read for the probe and both fixes, so the act-time recheck compares
 * against what the probe diagnosed (OTTR-1261). */
function staleSessionLastTool(
	e: { startedAt: number },
	sessionsDir: string | null,
	sessionId: string | null,
): LastTool | null {
	const path = staleSessionPath(e, sessionsDir, sessionId);
	if (path === null) return null;
	try {
		const tail = readTailText(path, SESSION_TAIL_BYTES);
		return tail === null ? null : lastToolCall(tail);
	} catch {
		return null;
	}
}

/** The /runprobe answer for one run entry (OTTR-1261). Every field degrades on its own
 * internal failure — the probe never fails because one fact is unreadable. */
function staleProbeOf(
	e: {
		pid: number | null;
		startedAt: number;
		dataDir?: string | null;
	},
	procRoot: string,
	sessionsDir: string | null,
	sessionId: string | null,
): StaleProbe {
	// readTree is null on an unreadable /proc or a dead run pid: the tree degrades to
	// empty, and alive below still reports what pidAlive saw. A null entry pid is the
	// not-yet-spawned case: no tree, not alive.
	const procs = e.pid === null ? [] : (readTree(e.pid, procRoot) ?? []);
	const alive = e.pid !== null && pidAlive(e.pid);
	// sessionAt is the resolved file's mtime — the run's own file by session id, or
	// the newest since startedAt without one (OTTR-1261). Unreadable fails the
	// session signal: null, no suspect on a guessed file.
	const sessionPath = staleSessionPath(e, sessionsDir, sessionId);
	let sessionAt: number | null = null;
	if (sessionPath !== null) {
		try {
			sessionAt = statSync(sessionPath).mtimeMs;
		} catch {
			sessionAt = null;
		}
	}
	const lastTool = staleSessionLastTool(e, sessionsDir, sessionId);
	// The last tool command is untrusted text: it selects which facts to read, never
	// what to execute. Confinement is a fix-time decision, so the probe reads every
	// candidate kind anywhere on this host.
	const command = lastTool?.command ?? "";
	let locks: LockFact[] = [];
	try {
		locks = lockFacts(extractLockPaths(command));
	} catch {
		locks = [];
	}
	let pidFiles: LockFact[] = [];
	try {
		pidFiles = pidFileFacts(extractPidPaths(command));
	} catch {
		pidFiles = [];
	}
	let pids: StaleProbe["pids"] = [];
	try {
		pids = extractInlinePids(command).map(({ pid }) => ({
			pid,
			alive: pidAlive(pid),
		}));
	} catch {
		pids = [];
	}
	let ports: StaleProbe["ports"] = [];
	try {
		ports = extractPorts(command).map(({ port }) => ({
			port,
			listeners: portListeners(port, procRoot),
		}));
	} catch {
		ports = [];
	}
	return {
		pid: e.pid,
		alive,
		procs,
		sessionAt,
		lastTool,
		locks,
		pidFiles,
		pids,
		ports,
	};
}

/** One /stalefix answer: ok, or the failed precondition by name. A refusal changes
 * nothing (OTTR-1261). */
type StaleFixResult = { ok: true } | { ok: false; reason: string };

/** The unlock fix: unlink a lock file whose pid is proven dead. Act time adds the
 * session recheck first (OTTR-1261): the session's last tool call must still name
 * the path — the turn still waits on it — before the existing preconditions run.
 * The expect payload carries the diagnosed command; this endpoint reads nothing
 * else from it. Confinement is re-derived from real paths, so a symlink the
 * session text planted cannot widen the set; the card-number scratch rule applies
 * to the real path too. A refusal changes nothing. */
function staleUnlock(
	e: { cwd: string; startedAt: number; dataDir?: string | null },
	rawPath: string,
	_expect: { sessionCommand: string },
	sessionsDir: string | null,
	sessionId: string | null,
): StaleFixResult {
	const current = staleSessionLastTool(e, sessionsDir, sessionId);
	if (
		current === null ||
		normalizeCmd(current.command) === "" ||
		!normalizeCmd(current.command).includes(normalizeCmd(rawPath))
	)
		return {
			ok: false,
			reason: `the turn moved on: ${rawPath} is no longer the wait`,
		};
	let realCwd: string;
	let realPath: string;
	try {
		realCwd = realpathSync(e.cwd);
		realPath = realpathSync(rawPath);
	} catch {
		return { ok: false, reason: "lock path does not resolve" };
	}
	const inWorktree = realPath === realCwd || realPath.startsWith(`${realCwd}/`);
	const inTemp = STALE_TEMP_ROOTS.some(
		(root) => realPath === root || realPath.startsWith(`${root}/`),
	);
	if (
		!inWorktree &&
		!(
			inTemp && lockPathAllowed(realPath, realCwd, cardNumOf(basename(realCwd)))
		)
	)
		return {
			ok: false,
			reason: `lock path ${rawPath} is outside the card's own dirs`,
		};
	let st: Stats;
	try {
		st = statSync(realPath);
	} catch {
		return { ok: false, reason: "lock file does not exist" };
	}
	if (!st.isFile())
		return { ok: false, reason: "lock path is not a regular file" };
	const pid = parseLockPid(readHeadText(realPath, 1024) ?? "");
	if (pid === null || pid <= 1)
		return { ok: false, reason: "lock does not name a pid > 1" };
	if (pidAlive(pid))
		return { ok: false, reason: `lock pid ${pid} is still alive` };
	try {
		unlinkSync(realPath);
	} catch (err) {
		return {
			ok: false,
			reason: `unlink failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true };
}

/** The kill fix: SIGTERM one process the diagnosis proved hung, with every
 * precondition re-checked at act time (OTTR-1261), in order: a fresh walk over the
 * proc seam still shows a strict descendant of the run; its current argv still runs
 * the diagnosed command; the session's last tool call is still that call, unbounded;
 * the child gained no BUSY_MIN_TICKS window of ticks since the probe; the diagnosed
 * dependency is still dead. TERM only — never the omp pid, the daemon pid, or pid 1.
 * A refused check changes nothing. */
function staleKillChild(
	e: { pid: number | null; startedAt: number; dataDir?: string | null },
	pid: number,
	expect: KillExpect,
	procRoot: string,
	kill: typeof process.kill,
	sessionsDir: string | null,
	sessionId: string | null,
): StaleFixResult {
	if (pid === 1) return { ok: false, reason: "pid 1 is never a fix target" };
	if (pid === process.pid)
		return { ok: false, reason: "the daemon's own pid is never a fix target" };
	if (e.pid === null || pid === e.pid)
		return { ok: false, reason: "the run's own pid is never a fix target" };
	// (a) Fresh walk over the proc seam: readTree holds the run pid plus its
	// descendants only, so a hit here is still a strict descendant.
	const procs = readTree(e.pid, procRoot);
	if (procs === null) return { ok: false, reason: "the run pid is gone" };
	const child = procs.find((s) => s.pid === pid);
	if (child === undefined)
		return {
			ok: false,
			reason: `pid ${pid} is not in the turn's process tree`,
		};
	// (b) The child's current argv still runs the diagnosed command. An empty
	// expect command matches everything, so it refuses instead.
	const want = normalizeCmd(expect.sessionCommand);
	if (want === "")
		return { ok: false, reason: "no session command to re-check" };
	if (!normalizeCmd(child.command).includes(want))
		return { ok: false, reason: "the child's command changed" };
	// (c) The session's last tool call is still the diagnosed call, unbounded —
	// the agent has not moved on.
	const current = staleSessionLastTool(e, sessionsDir, sessionId);
	if (
		current === null ||
		normalizeCmd(current.command) !== want ||
		current.timeout !== 0
	)
		return { ok: false, reason: "the session's last tool call changed" };
	// (d) The child has not resumed: under the BUSY_MIN_TICKS window since the probe.
	if (child.ticks > expect.ticks + BUSY_MIN_TICKS - 1)
		return {
			ok: false,
			reason: `the child resumed: ${child.ticks - expect.ticks} ticks gained`,
		};
	// (e) The diagnosed dependency is still dead.
	if (!depStillDead(expect.dep, procRoot))
		return { ok: false, reason: "the dependency cleared" };
	// (f) Every precondition held on this host: TERM that child only.
	try {
		kill(pid, "SIGTERM");
	} catch (err) {
		return {
			ok: false,
			reason: `signal failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true };
}

/** The diagnosed dependency is still dead at act time (OTTR-1261): a lock or pid
 * file still names the diagnosed pid and that pid is gone on this host, an inline
 * pid is gone, a port still has no listener. An unreadable file or net table fails
 * closed — the dependency did not prove dead. */
function depStillDead(dep: DepProof, procRoot: string): boolean {
	if (dep.kind === "inline") return !pidAlive(dep.pid);
	if (dep.kind === "port") return portListeners(dep.port, procRoot) === 0;
	const text = readHeadText(dep.path, 1024) ?? "";
	const parsed =
		dep.kind === "lockfile" ? parseLockPid(text) : parsePidFile(text);
	return parsed !== null && parsed === dep.pid && !pidAlive(parsed);
}

/** POST /sweep to a worker: kills the processes whose worktree is gone on that host. */
export async function sweepWorker(
	target: WorkerTarget,
	url: string,
): Promise<SweptProcess[]> {
	let res: Response;
	try {
		res = await fetch(`${url}/sweep`, {
			method: "POST",
			headers: {
				...(target.token ? { "x-otwr-token": target.token } : {}),
			},
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		throw new WorkerConnectError(String(err));
	}
	if (res.status !== 200) {
		const redirected = res.status >= 300 && res.status < 400;
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url}/sweep responded ${res.status}${redirected ? ` (redirect not followed${redirectProxyHint(url, res)})` : ""}${body ? `: ${body}` : ""}`,
		);
	}
	const stopped = (await res.json()) as unknown;
	if (!Array.isArray(stopped))
		throw new WorkerConnectError(`worker ${url}/sweep sent a non-array body`);
	return stopped as SweptProcess[];
}

/** GET /detached from a worker: the runs that outlive a dropped /run stream. */
export async function detachedRuns(
	url: string,
	token?: string,
): Promise<DetachedRun[]> {
	let res: Response;
	try {
		res = await fetch(`${url}/detached`, {
			headers: {
				...(token ? { "x-otwr-token": token } : {}),
			},
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		throw new WorkerConnectError(String(err));
	}
	if (res.status !== 200) {
		const redirected = res.status >= 300 && res.status < 400;
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url}/detached responded ${res.status}${redirected ? ` (redirect not followed${redirectProxyHint(url, res)})` : ""}${body ? `: ${body}` : ""}`,
		);
	}
	const runs = (await res.json()) as unknown;
	if (!Array.isArray(runs))
		throw new WorkerConnectError(
			`worker ${url}/detached sent a non-array body`,
		);
	return runs as DetachedRun[];
}

/** POST /detach/kill to a worker: the cancel path for a re-bound detached run. */
export async function killDetached(
	url: string,
	token: string | undefined,
	id: string,
): Promise<void> {
	let res: Response;
	try {
		res = await fetch(`${url}/detach/kill`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { "x-otwr-token": token } : {}),
			},
			body: JSON.stringify({ id }),
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		throw new WorkerConnectError(String(err));
	}
	if (res.status !== 200) {
		const redirected = res.status >= 300 && res.status < 400;
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url}/detach/kill responded ${res.status}${redirected ? ` (redirect not followed${redirectProxyHint(url, res)})` : ""}${body ? `: ${body}` : ""}`,
		);
	}
}

/** One ProcSample on the wire. */
function isProcSampleAnswer(s: unknown): boolean {
	if (typeof s !== "object" || s === null) return false;
	const o = s as Record<string, unknown>;
	return (
		typeof o.pid === "number" &&
		typeof o.ppid === "number" &&
		typeof o.ticks === "number" &&
		typeof o.command === "string"
	);
}

/** One LastTool on the wire, or null. */
function isLastToolAnswer(t: unknown): boolean {
	if (t === null) return true;
	if (typeof t !== "object") return false;
	const o = t as Record<string, unknown>;
	return (
		typeof o.tool === "string" &&
		typeof o.command === "string" &&
		(o.timeout === null || typeof o.timeout === "number")
	);
}

/** One LockFact on the wire. */
function isLockFactAnswer(f: unknown): boolean {
	if (typeof f !== "object" || f === null) return false;
	const o = f as Record<string, unknown>;
	return (
		typeof o.path === "string" &&
		typeof o.exists === "boolean" &&
		(o.pid === null || typeof o.pid === "number") &&
		(o.alive === null || typeof o.alive === "boolean")
	);
}

/** One inline pid fact on the wire. */
function isPidSampleAnswer(s: unknown): boolean {
	if (typeof s !== "object" || s === null) return false;
	const o = s as Record<string, unknown>;
	return typeof o.pid === "number" && typeof o.alive === "boolean";
}

/** One port fact on the wire. */
function isPortFactAnswer(s: unknown): boolean {
	if (typeof s !== "object" || s === null) return false;
	const o = s as Record<string, unknown>;
	return (
		typeof o.port === "number" &&
		(o.listeners === null || typeof o.listeners === "number")
	);
}

/** The /runprobe answer shape; any field off it fails whole. */
function isStaleProbeAnswer(v: unknown): v is StaleProbe {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.pid === null || typeof o.pid === "number") &&
		typeof o.alive === "boolean" &&
		Array.isArray(o.procs) &&
		o.procs.every(isProcSampleAnswer) &&
		(o.sessionAt === null || typeof o.sessionAt === "number") &&
		isLastToolAnswer(o.lastTool) &&
		Array.isArray(o.locks) &&
		o.locks.every(isLockFactAnswer) &&
		Array.isArray(o.pidFiles) &&
		o.pidFiles.every(isLockFactAnswer) &&
		Array.isArray(o.pids) &&
		o.pids.every(isPidSampleAnswer) &&
		Array.isArray(o.ports) &&
		o.ports.every(isPortFactAnswer)
	);
}

/** The request's session id (OTTR-1261): absent, or a non-empty string of at most
 * 200 chars. It selects the run's own transcript and nothing else. */
function validSessionId(sessionId: unknown): sessionId is string | undefined {
	return (
		sessionId === undefined ||
		(typeof sessionId === "string" &&
			sessionId !== "" &&
			sessionId.length <= 200)
	);
}

/** One dependency proof on the wire (OTTR-1261): where the diagnosed dead state
 * lives. A lock or pid file names a path and the pid it held; inline names a pid;
 * port names a port number (0 allowed). */
function validDepProof(dep: unknown): dep is DepProof {
	if (typeof dep !== "object" || dep === null) return false;
	const d = dep as Record<string, unknown>;
	const pidOk = (v: unknown): v is number =>
		typeof v === "number" && Number.isInteger(v) && v > 0;
	if (d.kind === "inline") return pidOk(d.pid);
	if (d.kind === "port")
		return (
			typeof d.port === "number" && Number.isInteger(d.port) && d.port >= 0
		);
	if (d.kind === "lockfile" || d.kind === "pidfile")
		return typeof d.path === "string" && d.path !== "" && pidOk(d.pid);
	return false;
}

/** The unlock request's expect (OTTR-1261): the diagnosed command rides with the
 * fix; the worker's unlock re-checks read nothing else from it. */
function validUnlockExpect(
	expect: unknown,
): expect is { sessionCommand: string } {
	if (typeof expect !== "object" || expect === null) return false;
	return typeof (expect as Record<string, unknown>).sessionCommand === "string";
}

/** The kill request's expect payload (OTTR-1261): the diagnosis the act-time
 * recheck compares against — the diagnosed command, the child's probe ticks, and
 * the dead dependency. */
function validKillExpect(expect: unknown): expect is KillExpect {
	if (typeof expect !== "object" || expect === null) return false;
	const e = expect as Record<string, unknown>;
	if (typeof e.sessionCommand !== "string") return false;
	if (!validDepProof(e.dep)) return false;
	return (
		typeof e.ticks === "number" && Number.isInteger(e.ticks) && e.ticks >= 0
	);
}

/** POST /runprobe to a worker: the read-only stale-turn facts for one run id
 * (OTTR-1261). The session id picks the run's own transcript on the worker when the
 * caller knows it; null/absent keeps the newest-since-start fallback (still only a
 * signal). Null when the worker answered 200 with a body off the StaleProbe shape;
 * transport failures and non-200 answers throw WorkerConnectError. */
export async function probeRun(
	target: WorkerTarget,
	url: string,
	runId: string,
	sessionId?: string | null,
): Promise<StaleProbe | null> {
	let res: Response;
	try {
		res = await fetch(`${url}/runprobe`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(target.token ? { "x-otwr-token": target.token } : {}),
			},
			body: JSON.stringify({ run: runId, ...(sessionId && { sessionId }) }),
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		throw new WorkerConnectError(String(err));
	}
	if (res.status !== 200) {
		const redirected = res.status >= 300 && res.status < 400;
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url}/runprobe responded ${res.status}${redirected ? ` (redirect not followed${redirectProxyHint(url, res)})` : ""}${body ? `: ${body}` : ""}`,
		);
	}
	const probe = (await res.json()) as unknown;
	if (!isStaleProbeAnswer(probe)) return null;
	return probe;
}

/** POST /stalefix to a worker: one allowlisted stale-turn fix, with the act-time
 * preconditions re-checked on the worker that owns the run (OTTR-1261). Both fixes
 * carry the diagnosis (`expect`); `sessionId` picks the run's own transcript for the
 * act-time session recheck when the caller knows it. The request passes through
 * verbatim. Null when the 200 body is off the fix-answer shape; transport failures
 * and non-200 answers throw WorkerConnectError. */
export async function staleFix(
	target: WorkerTarget,
	url: string,
	req:
		| {
				run: string;
				action: "unlock";
				path: string;
				expect: { sessionCommand: string };
				sessionId?: string;
		  }
		| {
				run: string;
				action: "kill";
				pid: number;
				expect: KillExpect;
				sessionId?: string;
		  },
): Promise<{ ok: boolean; reason?: string } | null> {
	let res: Response;
	try {
		res = await fetch(`${url}/stalefix`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(target.token ? { "x-otwr-token": target.token } : {}),
			},
			body: JSON.stringify(req),
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		throw new WorkerConnectError(String(err));
	}
	if (res.status !== 200) {
		const redirected = res.status >= 300 && res.status < 400;
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url}/stalefix responded ${res.status}${redirected ? ` (redirect not followed${redirectProxyHint(url, res)})` : ""}${body ? `: ${body}` : ""}`,
		);
	}
	const answer = (await res.json()) as unknown;
	if (typeof answer !== "object" || answer === null) return null;
	const { ok, reason } = answer as { ok?: unknown; reason?: unknown };
	if (
		typeof ok !== "boolean" ||
		(reason !== undefined && typeof reason !== "string")
	)
		return null;
	return answer as { ok: boolean; reason?: string };
}
