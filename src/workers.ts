import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { ensureProjectPackages } from "./apt.ts";
import { type SignIn, signIns } from "./login.ts";
import { platform } from "./platform/index.ts";
import { redirectProxyHint } from "./proxyHint.ts";
import { ensureProjectPython } from "./python.ts";
import type { RunSink } from "./runner.ts";
import { watchProgress } from "./stryker.ts";
import { readCgroup } from "./systemStats.ts";
import { buildToolsPath, ensureProjectTools } from "./tools.ts";
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
	/** Set only for a vm-runner dispatch (docs/adr/0009-microvm-workers.md); classic workers
	 * are never sent one and ignore it. */
	vm?: VmSpec;
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
}

export interface DetachedRun {
	id: string;
	cwd: string;
	pid: number | null;
	running: boolean;
	startedAt: number;
	result?: {
		exitCode: number | null;
		stderrTail: string;
		vm?: VmOutcome;
		/** The shared home's provisioned-layer drift the daemon's close audit found. */
		provisionDrift?: string[];
	};
	killed?: boolean;
}

export function serveWorker(opts: {
	port?: number;
	token?: string | null;
	/** Only for tests: the command the daemon runs instead of `omp`. */
	ompPath?: string;
	/** Only for tests: replaces the apt install that runs before omp. */
	ensurePackages?: typeof ensureProjectPackages;
	/** Only for tests: replaces the tools.json install that runs before omp. */
	ensureTools?: typeof ensureProjectTools;
	/** Only for tests: replaces the requirements.txt venv build that runs before omp. */
	ensurePython?: typeof ensureProjectPython;
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
	/** Only for tests: the sign-ins GET /signins reports instead of reading the worker's own store. */
	readSignIns?: () => SignIn[];
	/** Only for tests: the cgroup v2 directory GET /stats reads instead of /sys/fs/cgroup. */
	cgroupRoot?: string;
	/** Only for tests: the mutation lock file GET /stats reads instead of tmpdir()/ott-stryker.lock. */
	lockPath?: string;
	/** Only for tests: the /proc tree GET /stats reads the runs' usage from instead of the real one. */
	statsProcRoot?: string;
}): Bun.Server<never> {
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
	const pruneDetached = (): void => {
		const ttl = opts.detachedTtlMs ?? 24 * 60 * 60 * 1000;
		const now = Date.now();
		for (const [id, e] of detached)
			if (now - e.startedAt > ttl) detached.delete(id);
	};
	return Bun.serve({
		port: opts.port ?? 8787,
		hostname: "0.0.0.0",
		// Long silent turns must not be cut by an idle timeout.
		idleTimeout: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/healthz")
				return new Response("ok");
			// OTTR-548: the worker self-reports its own store's sign-ins; the board never reads
			// the worker store (R5-1). Always HTTP 200: the board's tick decides what a null
			// signIns list means, and a warning must never start with a failed request.
			if (request.method === "GET" && url.pathname === "/signins") {
				if (opts.token && request.headers.get("x-otwr-token") !== opts.token)
					return new Response("unauthorized", { status: 401 });
				const dbPath = workerAgentDb();
				try {
					// The injected reader answers without touching the worker's own store.
					// The default guards first: a readonly open of a missing path fails
					// with a message that names no file.
					const read =
						opts.readSignIns ??
						(() => {
							if (!existsSync(dbPath))
								throw new Error(`${dbPath} does not exist`);
							return signIns(dbPath);
						});
					return Response.json({ signIns: read() });
				} catch (err) {
					return Response.json({
						signIns: null,
						error: `${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}
			// The System view's per-container numbers: the worker reads its own cgroup, since
			// the server's /proc sees only the whole Docker VM. Each live run's process tree
			// (attached or detached) adds the turn's own share, keyed by the server's run id.
			if (request.method === "GET" && url.pathname === "/stats") {
				if (opts.token && request.headers.get("x-otwr-token") !== opts.token)
					return new Response("unauthorized", { status: 401 });
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
			}
			if (request.method === "POST" && url.pathname === "/sweep") {
				if (opts.token && request.headers.get("x-otwr-token") !== opts.token)
					return new Response("unauthorized", { status: 401 });
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
					return new Response(
						err instanceof Error ? err.message : String(err),
						{
							status: 500,
						},
					);
				}
			}
			if (
				url.pathname === "/detach" ||
				url.pathname === "/detached" ||
				url.pathname === "/detach/kill"
			) {
				if (opts.token && request.headers.get("x-otwr-token") !== opts.token)
					return new Response("unauthorized", { status: 401 });
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
							// The internal detach flag and the stream closure stay off the wire.
							({ closeStream: _c, detached: _d, ...entry }) => entry,
						),
					);
				}
				if (request.method === "POST" && url.pathname === "/detach/kill") {
					pruneDetached();
					let body: { id?: string };
					try {
						body = (await request.json()) as { id?: string };
					} catch {
						return new Response("bad json", { status: 400 });
					}
					const e =
						typeof body.id === "string" ? detached.get(body.id) : undefined;
					if (!e) return new Response("not found", { status: 404 });
					if (e.pid !== null && e.running) platform.killTree(e.pid);
					e.killed = true;
					e.running = false;
					return Response.json({ killed: true });
				}
			}
			if (request.method !== "POST" || url.pathname !== "/run")
				return new Response("not found", { status: 404 });
			if (opts.token && request.headers.get("x-otwr-token") !== opts.token)
				return new Response("unauthorized", { status: 401 });
			let body: WorkerRequest;
			try {
				body = (await request.json()) as WorkerRequest;
			} catch {
				return new Response("bad json", { status: 400 });
			}
			if (
				!Array.isArray(body.argv) ||
				!body.argv.every((a) => typeof a === "string") ||
				typeof body.cwd !== "string" ||
				body.cwd === "" ||
				!isAbsolute(body.cwd) ||
				!existsSync(body.cwd) ||
				!statSync(body.cwd).isDirectory()
			)
				return new Response("bad request", { status: 400 });

			// The project's package list (alate provisions it into the shared home) is installed
			// in this container before omp starts; a failed install ends the run with apt's error.
			let notes = "";
			let pathDir = "";
			const project = body.env?.OTTR_PROJECT;
			if (typeof project === "string" && project !== "") {
				try {
					const aptLines = await (opts.ensurePackages ?? ensureProjectPackages)(
						project,
					);
					const toolLines = await (opts.ensureTools ?? ensureProjectTools)(
						project,
					);
					// The venv builds into the shared home, but stays off the PATH: a worker work
					// turn keeps its ad-hoc pip --user flow, and a venv bin dir first on PATH would
					// shadow the user site it installs into (docs/specs/merge-turn-packages.md).
					const pipLines = await (opts.ensurePython ?? ensureProjectPython)(
						project,
					);
					pathDir = (opts.buildPath ?? buildToolsPath)(project);
					notes = [...aptLines, ...toolLines, ...pipLines]
						.map((l) => `${l}\n`)
						.join("");
				} catch (err) {
					const stderrTail = `${err instanceof Error ? err.message : String(err)}\n`;
					return new Response(
						`${JSON.stringify({ [WORKER_DONE]: { exitCode: 1, stderrTail } })}\n`,
						{ headers: { "content-type": "text/plain; charset=utf-8" } },
					);
				}
				// The client gave up during the install: spawning now would orphan the run.
				if (request.signal.aborted)
					return new Response("aborted", { status: 499 });
			}

			// The worker's own token drives every worker, and the container env can hold a git
			// host token (an operator's GH_TOKEN): a turn inherits neither, from the container
			// or the request. Push credentials stay on the server (D6).
			const env: Record<string, string | undefined> = {
				...process.env,
				...body.env,
			};
			stripGitAuthEnv(env);
			delete env.OTTR_WORKER_TOKEN;
			// Same strip as childEnv on the server: no turn ever needs the alate key.
			delete env.ALATE_API_KEY;
			// Same strip as childEnv on the server: the container env can carry a
			// corporate proxy URL with credentials; a turn keeps host and port only.
			stripProxyCredentials(env);
			// The provision guard's untracked scan compares against the rules dir as it
			// stood before omp started (docs/specs/turn-provision-guard.md).
			const rulesAtStart = opts.rulesAtStart ? opts.rulesAtStart() : undefined;
			let child: ChildProcess;
			// The tools link dir is per tool set: project pins, then _all pins, then the container
			// PATH. The daemon's own PATH never changes, and two projects never see each
			// other's pins because the dir is keyed by the project's own tool set.
			if (pathDir) env.PATH = `${pathDir}:${String(env.PATH ?? "")}`;
			try {
				child = spawn(opts.ompPath ?? "omp", body.argv, {
					cwd: body.cwd,
					env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (err) {
				return new Response(`spawn failed: ${String(err)}`, { status: 500 });
			}
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
				startedAt: Date.now(),
				detached: false,
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
			let stderrTail = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrTail = `${stderrTail}${chunk.toString("utf8")}`
					.replace(/\r\n/g, "\n")
					.slice(-4000);
			});
			child.on("error", (err: Error) => {
				forgetEntry();
				stderrTail = `${stderrTail}${err.message}\n`
					.replace(/\r\n/g, "\n")
					.slice(-4000);
			});

			const enc = new TextEncoder();
			let closed = false;
			let stopWatch = (): void => {};
			const stream = new ReadableStream({
				start(controller) {
					entry.closeStream = (): void => {
						if (closed) return;
						closed = true;
						stopWatch();
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
						if (closed) return;
						try {
							controller.enqueue(enc.encode(text));
						} catch {
							closed = true; // the stream ended without cancel(): nobody reads omp now
							killTree();
						}
					};
					// The install notes lead the stream as plain lines: the client logs non-JSON
					// lines verbatim, and omp's stderr tail stays clean for classify's rules.
					if (notes) push(notes);
					// Stryker progress rides the stream as one more event line (stryker.ts).
					stopWatch = watchProgress(child.pid, push);
					let partial = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						partial += chunk.toString("utf8");
						let idx = partial.indexOf("\n");
						while (idx >= 0) {
							push(partial.slice(0, idx + 1));
							partial = partial.slice(idx + 1);
							idx = partial.indexOf("\n");
						}
					});
					// omp may die before reading stdin; a bare write would then crash us.
					child.stdin?.on("error", () => {});
					child.stdin?.write(body.stdin, "utf8");
					child.stdin?.end();
					child.on("close", (code) => {
						stopWatch();
						forgetChild();
						forgetEntry();
						// The provision guard audits this container's shared home once the run's
						// writes are final (docs/specs/turn-provision-guard.md); drift rides the
						// result, and classify parks the turn.
						const provisionDrift =
							opts.auditProvisioned?.(entry.startedAt, rulesAtStart) ?? [];
						const driftField = provisionDrift.length
							? { provisionDrift: [...provisionDrift] }
							: {};
						if (entry.detached) {
							// No client listens any more: the result waits in /detached for boot
							// recovery instead of a sentinel on a gone stream.
							entry.running = false;
							entry.result = {
								exitCode: code ?? null,
								stderrTail,
								...driftField,
							};
							return;
						}
						if (partial.length > 0) push(`${partial}\n`);
						push(
							`${JSON.stringify({ [WORKER_DONE]: { exitCode: code ?? null, stderrTail, host: hostname(), ...driftField } })}\n`,
						);
						if (!closed) controller.close(); // else the client aborted; the stream is gone
					});
				},
				cancel() {
					closed = true;
					stopWatch();
					killTree();
				},
			});
			request.signal.addEventListener("abort", killTree);
			return new Response(stream, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
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
} | null {
	const stringList = (v: unknown): v is string[] =>
		Array.isArray(v) && v.length > 0 && v.every((l) => typeof l === "string");
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
	return target.urls[rr++ % target.urls.length]!;
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
		resolveDone(r);
	};
	const fail = (e: unknown): void => {
		resolveAccepted(false);
		if (settled) return;
		settled = true;
		rejectDone(e);
	};

	(async () => {
		let res: Response;
		try {
			res = await fetch(url + "/run", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(target.token ? { "x-otwr-token": target.token } : {}),
				},
				body: JSON.stringify(req),
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

		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let partial = "";
		let lost: string | undefined;
		try {
			for (;;) {
				const { done: ended, value } = await reader.read();
				if (ended) break;
				partial += dec.decode(value, { stream: true });
				let idx = partial.indexOf("\n");
				while (idx >= 0) {
					const line = partial.slice(0, idx);
					partial = partial.slice(idx + 1);
					const sentinel = parseSentinel(line);
					if (sentinel) {
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
							}),
						);
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
		if (settled) return;
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
		const cardId = segments[wt + 1]!;
		if (project === "" || cardId === "") continue;
		return { project, cardId };
	}
	return null;
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
	const keep = new Set<number>();
	const queue = [...(opts?.keepPids ?? [])];
	while (queue.length > 0) {
		const pid = queue.pop()!;
		if (keep.has(pid)) continue;
		keep.add(pid);
		for (const [child, parent] of ppid)
			if (parent === pid && !keep.has(child)) queue.push(child);
	}
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
		if (!match) continue;
		let command = "";
		try {
			command = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8")
				.split("\0")
				.filter((seg) => seg !== "")
				.join(" ");
		} catch {}
		targets.push({ pid, command, ...match });
	}
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
