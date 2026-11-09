// omp stats dashboard: the board runs omp's own `omp stats` web dashboard on demand, feeds it
// a mirror of every board session transcript, and stops it after 30 minutes without use. This
// module owns the child process, its state machine, and the proxy's forward + wait pages; the
// server owns the listener and its guards.
// Spec: docs/specs/omp-stats-dashboard.md ("Dashboard process", "Idle stop", "Forwarding").
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stripANSI } from "bun";
import { errmsg } from "./errmsg.ts";
import {
	type MirrorResult,
	type MirrorSource,
	mirrorSessions,
} from "./ompStatsMirror.ts";

/** No proxy request for this long stops a running dashboard. */
export const OMP_STATS_IDLE_MS = 30 * 60_000;
/** Not omp's own 3847: a board there would block the user's `omp stats`, and omp's
 *  port-conflict probe would then reach the board. */
export const OMP_STATS_DEFAULT_PORT = 3848;

/** The Settings link payload: the proxy port the browser opens, or why there is none. */
export interface OmpStatsDashboardInfo {
	port: number | null;
	error: string | null;
}

export type DashboardPhase =
	| "stopped"
	| "copying"
	| "starting"
	| "running"
	| "failed";

/** `port` is the child's upstream port while running; `error` the reason of a failed start
 *  or exit. */
export interface DashboardState {
	phase: DashboardPhase;
	port: number | null;
	error: string | null;
}

/** The parts of a spawned child the manager uses: a seam so tests can fake omp. */
export interface DashboardChild {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: NodeJS.Signals | number): void;
}

export interface DashboardDeps {
	/** `<boardOmpHome()>/.omp/ottr-stats-dashboard`: server-only, never a worker volume. */
	baseDir: string;
	sources: () => MirrorSource[];
	env: () => Record<string, string | undefined>;
	spawn?: (
		argv: string[],
		env: Record<string, string | undefined>,
	) => DashboardChild;
	mirror?: typeof mirrorSessions;
	now?: () => number;
	startTimeoutMs?: number;
	log?: (msg: string) => void;
}

export interface OmpStatsDashboard {
	/** Records activity now; starts the dashboard when stopped or failed. Never blocks. */
	ensure(): DashboardState;
	state(): DashboardState;
	/** The server's 60 s tick: stops an idle dashboard, otherwise refreshes the mirror. */
	tick(): Promise<void>;
	/** SIGTERMs the child, if any. */
	stop(): void;
}

/** Reads OTTR_OMP_STATS_PORT: unset or empty -> 3848; `0` / `off` -> disabled; anything that
 *  is not a port -> disabled with the reason. */
export function parseOmpStatsPort(
	raw: string | undefined,
): OmpStatsDashboardInfo {
	if (raw === undefined || raw.trim() === "")
		return { port: OMP_STATS_DEFAULT_PORT, error: null };
	const value = raw.trim();
	if (value === "0" || value.toLowerCase() === "off") {
		return { port: null, error: "disabled by OTTR_OMP_STATS_PORT" };
	}
	const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { port: null, error: `OTTR_OMP_STATS_PORT is not a port: ${raw}` };
	}
	return { port, error: null };
}

const DASHBOARD_LINE =
	/Dashboard available at:\s*http:\/\/127\.0\.0\.1:(\d{1,5})(?!\d)/;

/** The child's port from omp's "Dashboard available at: http://127.0.0.1:<port>" line. */
export function parseDashboardPort(text: string): number | null {
	const m = DASHBOARD_LINE.exec(stripANSI(text));
	if (m?.[1] === undefined) return null;
	const port = Number(m[1]);
	return port >= 1 && port <= 65535 ? port : null;
}

const ARGV = ["stats", "--port", "0", "--host", "127.0.0.1"];

function defaultSpawn(
	argv: string[],
	env: Record<string, string | undefined>,
): DashboardChild {
	return Bun.spawn(["omp", ...argv], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
		windowsHide: true,
	});
}

/** Reads a stream to its end as text, handing over each complete line. Swallows read errors:
 *  a broken pipe only ends the output, the exit code still reports the outcome. */
async function readLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	try {
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		}
	} catch {
		// The exit handler reports the outcome.
	}
	pending += decoder.decode();
	if (pending !== "") onLine(pending);
}

const failed = (error: string): DashboardState => ({
	phase: "failed",
	port: null,
	error,
});
const STOPPED: DashboardState = { phase: "stopped", port: null, error: null };

export function createOmpStatsDashboard(
	deps: DashboardDeps,
): OmpStatsDashboard {
	const spawn = deps.spawn ?? defaultSpawn;
	const mirror = deps.mirror ?? mirrorSessions;
	const now = deps.now ?? Date.now;
	const startTimeoutMs = deps.startTimeoutMs ?? 60_000;
	const log = deps.log ?? (() => {});
	const agentDir = join(deps.baseDir, "agent");
	const sessionsDir = join(agentDir, "sessions");

	let state: DashboardState = STOPPED;
	let child: DashboardChild | null = null;
	let startTimer: ReturnType<typeof setTimeout> | undefined;
	let lastActivity = now();
	let refreshing = false;
	/** Bumped by every start and stop: a stale start or child exit compares its generation
	 *  and leaves the newer state alone. */
	let generation = 0;
	/** Mirror runs queue behind each other: a start's copy and a tick's refresh never write
	 *  the same file at once. */
	let mirrorQueue: Promise<unknown> = Promise.resolve();

	function runMirror(): Promise<MirrorResult> {
		const run = mirrorQueue.then(async () => {
			await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
			return mirror(sessionsDir, deps.sources());
		});
		mirrorQueue = run.catch(() => {});
		return run;
	}

	function logErrors(result: MirrorResult): void {
		if (result.errors.length === 0) return;
		log(
			`omp stats mirror: ${result.errors.length} file error(s), first: ${result.errors[0]}`,
		);
	}

	/** Ends the current generation: a pending start aborts, a child gets SIGTERM. */
	function retire(next: DashboardState): void {
		generation++;
		clearTimeout(startTimer);
		const c = child;
		child = null;
		state = next;
		c?.kill("SIGTERM");
	}

	function launch(gen: number): void {
		const env: Record<string, string | undefined> = {
			...deps.env(),
			PI_CODING_AGENT_DIR: agentDir,
		};
		delete env.TERN_PANE;
		delete env.TERN_PANE_SOCKET;
		let c: DashboardChild;
		try {
			c = spawn(ARGV, env);
		} catch (err) {
			state = failed(`omp stats did not start: ${errmsg(err)}`);
			return;
		}
		child = c;
		state = { phase: "starting", port: null, error: null };
		let lastLine = "";
		const onLine = (line: string) => {
			const clean = stripANSI(line).trim();
			if (clean !== "") lastLine = clean;
			if (gen !== generation || state.phase !== "starting") return;
			const port = parseDashboardPort(clean);
			if (port === null) return;
			clearTimeout(startTimer);
			state = { phase: "running", port, error: null };
		};
		// Both pipes drain to the end, so a chatty child never blocks on a full pipe.
		const drained = Promise.all([
			readLines(c.stdout, onLine),
			readLines(c.stderr, onLine),
		]);
		startTimer = setTimeout(() => {
			if (gen !== generation || state.phase !== "starting") return;
			const secs = Math.round(startTimeoutMs / 1000);
			retire(failed(`omp stats printed no dashboard address within ${secs} s`));
		}, startTimeoutMs);
		void c.exited.then(async (code) => {
			// The last lines may still sit in the pipes; a grandchild holding them open must
			// not hold the state, so the wait is short.
			const grace = Promise.withResolvers<void>();
			const graceTimer = setTimeout(grace.resolve, 1000);
			await Promise.race([drained, grace.promise]);
			clearTimeout(graceTimer);
			if (gen !== generation) return;
			clearTimeout(startTimer);
			child = null;
			const reason =
				lastLine !== "" ? lastLine : `omp stats exited with ${code}`;
			state =
				state.phase === "running" && code === 0 ? STOPPED : failed(reason);
			log(`omp stats exited with ${code}`);
		});
	}

	async function start(gen: number): Promise<void> {
		try {
			logErrors(await runMirror());
		} catch (err) {
			if (gen === generation)
				state = failed(`copying session transcripts failed: ${errmsg(err)}`);
			return;
		}
		if (gen === generation) launch(gen);
	}

	return {
		ensure() {
			lastActivity = now();
			if (state.phase === "stopped" || state.phase === "failed") {
				generation++;
				state = { phase: "copying", port: null, error: null };
				void start(generation);
			}
			return state;
		},
		state: () => state,
		async tick() {
			if (state.phase !== "running") return;
			if (now() - lastActivity >= OMP_STATS_IDLE_MS) {
				log("omp stats dashboard idle for 30 minutes, stopping it");
				retire(STOPPED);
				return;
			}
			if (refreshing) return;
			refreshing = true;
			try {
				logErrors(await runMirror());
			} catch (err) {
				log(`omp stats mirror refresh failed: ${errmsg(err)}`);
			} finally {
				refreshing = false;
			}
		},
		stop() {
			retire(STOPPED);
		},
	};
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The proxy's 503 page while the dashboard is not running. It reloads every 2 s while the
 *  start goes on; a failed start shows the error and leaves the retry to the user's reload. */
export function startingPage(state: DashboardState): Response {
	let title = "Starting omp stats";
	let message: string;
	let refresh = true;
	switch (state.phase) {
		case "copying":
			message = "Copying session transcripts…";
			break;
		case "failed":
			title = "omp stats failed";
			message = `omp stats did not start: ${state.error ?? "unknown error"}. Reload the page to try again.`;
			refresh = false;
			break;
		default:
			message = "Starting omp stats…";
	}
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${refresh ? '<meta http-equiv="refresh" content="2">\n' : ""}<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:40rem;padding:0 1rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>
`;
	return new Response(html, {
		status: 503,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

/** Request headers that never reach the child: hop-by-hop ones, the board's host, every
 *  credential of the caller, and the proxy chain. */
const DROP_REQUEST: Record<string, true> = {
	connection: true,
	"keep-alive": true,
	"proxy-authorization": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	host: true,
	"content-length": true,
	cookie: true,
	authorization: true,
	"x-api-key": true,
	forwarded: true,
};

/** Response headers of the upstream hop. `set-cookie` too: cookies ignore the port, so a
 *  dashboard cookie would land on the board's own `localhost` cookie jar. */
const DROP_RESPONSE: Record<string, true> = {
	connection: true,
	"keep-alive": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	"content-length": true,
	"content-encoding": true,
	"set-cookie": true,
};

function text(body: string, status: number): Response {
	return new Response(`${body}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

/** Forwards `req` (method, path, query, body, headers minus the dropped ones) to the child on
 *  `127.0.0.1:<port>` and streams its answer back, so server-sent events pass chunk by chunk. */
export async function forwardToDashboard(
	req: Request,
	port: number,
): Promise<Response> {
	const url = new URL(req.url);
	const headers = new Headers();
	for (const [name, value] of req.headers) {
		if (DROP_REQUEST[name] !== true && !name.startsWith("x-forwarded-"))
			headers.append(name, value);
	}
	// Identity: fetch would inflate a compressed answer, and the browser must not inflate it twice.
	headers.set("accept-encoding", "identity");
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
			method: req.method,
			headers,
			body: hasBody ? req.body : undefined,
			// Streams the request body instead of buffering it first.
			duplex: "half",
			redirect: "manual",
			// The browser hanging up (a closed /api/events tab) ends the upstream call.
			signal: req.signal,
		} as RequestInit);
	} catch (err) {
		if (req.signal.aborted) return text("client closed the request", 499);
		return text(`omp stats dashboard unreachable: ${errmsg(err)}`, 502);
	}
	const out = new Headers();
	for (const [name, value] of res.headers)
		if (DROP_RESPONSE[name] !== true) out.append(name, value);
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: out,
	});
}
