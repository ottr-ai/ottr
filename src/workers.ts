import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { ensureProjectPackages } from "./apt.ts";
import { platform } from "./platform/index.ts";
import type { RunSink } from "./runner.ts";
import { watchProgress } from "./stryker.ts";
import { buildToolsPath, ensureProjectTools } from "./tools.ts";
import type { RunResult } from "./types.ts";
import { stripGitAuthEnv } from "./worktree.ts";

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
	/** Only for tests: replaces the link dir prepended to the child's PATH. */
	buildPath?: typeof buildToolsPath;
	/** Only for tests: roots the /sweep scan instead of /workspace. */
	sweepRoots?: readonly string[];
	/** Only for tests: the SIGTERM grace period of /sweep instead of 1000ms. */
	sweepGraceMs?: number;
}): Bun.Server<never> {
	// Pids of the live /run children. The sweep must never stop a turn that still runs:
	// a merge turn removes its own worktree mid-run (AGENTS.md step 5), so omp's cwd link
	// ends in " (deleted)" while the turn still has to push and report. Removed on close.
	const runChildren = new Set<number>();
	return Bun.serve({
		port: opts.port ?? 8787,
		hostname: "0.0.0.0",
		// Long silent turns must not be cut by an idle timeout.
		idleTimeout: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/healthz")
				return new Response("ok");
			if (request.method === "POST" && url.pathname === "/sweep") {
				if (opts.token && request.headers.get("x-otwr-token") !== opts.token)
					return new Response("unauthorized", { status: 401 });
				try {
					const stopped = await sweepLeftovers({
						roots: opts.sweepRoots,
						graceMs: opts.sweepGraceMs,
						keepPids: runChildren,
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
					pathDir = (opts.buildPath ?? buildToolsPath)(project);
					notes = [...aptLines, ...toolLines].map((l) => `${l}\n`).join("");
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
			child.on("close", forgetChild);
			// A spawn error never fires "close", so forget here too.
			child.on("error", forgetChild);
			if (child.pid !== undefined) runChildren.add(child.pid);
			const killTree = (): void => {
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
				stderrTail = `${stderrTail}${err.message}\n`
					.replace(/\r\n/g, "\n")
					.slice(-4000);
			});

			const enc = new TextEncoder();
			let closed = false;
			let stopWatch = (): void => {};
			const stream = new ReadableStream({
				start(controller) {
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
						if (partial.length > 0) push(`${partial}\n`);
						push(
							`${JSON.stringify({ [WORKER_DONE]: { exitCode: code ?? null, stderrTail } })}\n`,
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

function parseSentinel(
	line: string,
): { exitCode: number | null; stderrTail: string } | null {
	try {
		const v = JSON.parse(line) as Record<string, unknown>;
		const done = v[WORKER_DONE];
		if (
			typeof done === "object" &&
			done !== null &&
			"exitCode" in done &&
			typeof (done as Record<string, unknown>).stderrTail === "string"
		)
			return done as { exitCode: number | null; stderrTail: string };
	} catch {
		// not JSON, not the sentinel
	}
	return null;
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
): { url: string; pid: null; done: Promise<RunResult>; kill(): void } {
	const url = nextUrl(target);
	sink.logMark(`worker: dispatching to ${url}\n`);
	const controller = new AbortController();
	let settled = false;
	const {
		promise: done,
		resolve: resolveDone,
		reject: rejectDone,
	} = Promise.withResolvers<RunResult>();
	const finish = (r: RunResult): void => {
		if (settled) return;
		settled = true;
		resolveDone(r);
	};
	const fail = (e: unknown): void => {
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
			if (res.status !== 200) {
				// The daemon's 500 body ("spawn failed: ...") is the real cause; surface it
				// instead of only the status. ponytail: capped, the body is one error line.
				const redirected = res.status >= 300 && res.status < 400;
				const body = (await res.text()).trim().slice(0, 300);
				throw new WorkerConnectError(
					`worker ${url} responded ${res.status}${redirected ? " (redirect not followed)" : ""}${body ? `: ${body}` : ""}`,
				);
			}
		} catch (err) {
			if (controller.signal.aborted) return; // kill() already settled
			fail(
				err instanceof WorkerConnectError
					? err
					: new WorkerConnectError(String(err)),
			);
			return;
		}

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
}): Promise<SweptProcess[]> {
	const roots = opts?.roots ?? ["/workspace"];
	const graceMs = opts?.graceMs ?? 1000;
	// One /proc snapshot of the parent links; the kept set is the keep roots plus
	// every descendant (BFS over ppid). A process that forks after the snapshot is
	// swept at the next tick, same known gap killTree has.
	const ppid = new Map<number, number>();
	for (const name of readdirSync("/proc")) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
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
	for (const name of readdirSync("/proc")) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
		if (keep.has(pid)) continue; // a live /run child (or its tree) is not a leftover
		let cwdLink: string;
		try {
			cwdLink = readlinkSync(`/proc/${pid}/cwd`);
		} catch {
			continue; // exited, zombie, or permission denied
		}
		const match = matchSweepTarget(cwdLink, roots);
		if (!match) continue;
		let command = "";
		try {
			command = readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.split("\0")
				.filter((seg) => seg !== "")
				.join(" ");
		} catch {}
		targets.push({ pid, command, ...match });
	}
	const stopped: SweptProcess[] = [];
	for (const target of targets) {
		try {
			process.kill(target.pid, "SIGTERM");
		} catch {
			continue; // ESRCH: already gone
		}
		stopped.push(target);
	}
	if (stopped.length > 0) await Bun.sleep(graceMs);
	for (const target of stopped) {
		try {
			// Signal 0: existence probe. ESRCH here means the process took the TERM.
			process.kill(target.pid, 0);
			process.kill(target.pid, "SIGKILL");
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
		const body = (await res.text()).trim().slice(0, 300);
		throw new WorkerConnectError(
			`worker ${url}/sweep responded ${res.status}${body ? `: ${body}` : ""}`,
		);
	}
	const stopped = (await res.json()) as unknown;
	if (!Array.isArray(stopped))
		throw new WorkerConnectError(`worker ${url}/sweep sent a non-array body`);
	return stopped as SweptProcess[];
}
