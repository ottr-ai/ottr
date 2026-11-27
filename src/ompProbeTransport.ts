import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunSink, type RunSink } from "./runner.ts";
import { runWorker, type WorkerRequest, type WorkerTarget } from "./workers.ts";

/** The exact argv one probe runs: strict x.y.z only, so the version can never
 * inject bunx flags or arguments (argv-injection guard at the trust boundary). */
export const probeArgv = (version: string): string[] => {
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(`omp models probe: version is not x.y.z: ${version}`);
	return ["bunx", `@oh-my-pi/pi-coding-agent@${version}`, "models", "--json"];
};

/** The request env: the proxy names only. No PATH (the worker's own PATH wins),
 * no HOME (the daemon points the probe's HOME at its per-run scratch), no
 * identity/credential names (the daemon strips those again on its side). */
export const probeRequestEnv = (
	source: NodeJS.ProcessEnv,
): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const name of [
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"no_proxy",
	]) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
};

/** Cap of the probe's collected stdout, in characters: a models list is far
 * smaller, so the cap only bounds a runaway version's output. Past the cap the
 * lines still reach the run log but stop appending to the collection. */
const STDOUT_CAP_CHARS = 1_100_000;

/** createRunSink with the probe's stdout lines collected into one string (the
 * fakeSink wrapper pattern): the run log stays complete, the collection is the
 * probe's stdout. */
const collectingSink = (tmp: string): RunSink & { collected: string } => {
	const base = createRunSink({
		logPath: join(tmp, "probe.log"),
		dataRoot: tmp,
	});
	let collected = "";
	return {
		...base,
		get collected(): string {
			return collected;
		},
		line: (raw: string): void => {
			if (collected.length < STDOUT_CAP_CHARS) collected += `${raw}\n`;
			base.line(raw);
		},
	};
};

/** Server-side transport for the omp watch's candidate probe: runs `omp models
 * --json` for one exact release on a worker container through the board's
 * existing dispatch, and returns {code, stdout, stderr}. A throw is a
 * transport failure only: the caller logs the warning and files normal 7-day
 * bump cards, never a lastError. */
export function createOmpProbeTransport(deps: {
	/** The board's worker dispatch target (OTTR_WORKER_URLS). null/undefined or empty urls: every probe call throws — the watch logs the warning and files normal 7-day bump cards. */
	target: WorkerTarget | null | undefined;
	/** Test seam; production uses runWorker. */
	spawn?: typeof runWorker;
	/** Test seam for the env whitelist source; production reads process.env. */
	env?: () => NodeJS.ProcessEnv;
}): (
	version: string,
	timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }> {
	return async (version, timeoutMs) => {
		const target = deps.target;
		if (target === null || target === undefined || target.urls.length === 0)
			throw new Error(
				"omp models probe: no worker target configured (OTTR_WORKER_URLS)",
			);
		const req: WorkerRequest = {
			id: `ompprobe-${randomUUID()}`,
			argv: probeArgv(version),
			cwd: "/tmp", // exists in every worker container; a probe run's real cwd is the daemon's scratch
			stdin: "",
			env: probeRequestEnv(deps.env?.() ?? process.env),
			probe: true,
		};
		const tmp = mkdtempSync(join(tmpdir(), "ottr-omp-probe-")); // holds only the sink log; removed in finally (the old probe's HOME pattern)
		try {
			const sink = collectingSink(tmp);
			const run = (deps.spawn ?? runWorker)(req, target, sink);
			const timer = setTimeout(() => run.kill(), timeoutMs);
			try {
				const r = await run.done;
				if (r.killed === true)
					throw new Error(`omp models probe timed out after ${timeoutMs} ms`);
				if (r.exitCode === null)
					throw new Error(
						`omp models probe ended without an exit code: ${r.stderrTail.slice(-200)}`,
					);
				return {
					code: r.exitCode,
					stdout: sink.collected,
					stderr: r.stderrTail,
				};
			} finally {
				clearTimeout(timer);
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	};
}
