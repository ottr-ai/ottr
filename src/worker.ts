import { homedir, tmpdir } from "node:os";
import { ensureAllPackages } from "./apt.ts";
import { auditProvisioned, rulesDirEntries } from "./provision.ts";
import { ensureAllPython } from "./python.ts";
import { formatBytes, sweepTmpDirs } from "./tmpsweep.ts";
import { ensureAllTools } from "./tools.ts";
import { serveWorker } from "./workers.ts";

// Import-safe: Stryker's bun runner eagerly imports every mutated file to prime per-test
// coverage (coverage-preload.js in @hughescr/stryker-bun-runner 1.6), and a top-level exit
// there kills the whole test run — try/catch cannot catch process.exit. The guard keeps the
// entry behavior: `bun src/worker.ts` still fails closed without a token, and the runner's
// mutants on this guard stay killed through the worker.ts spawn test in src/workers.test.ts.
if (import.meta.main) {
	// Fail closed: without the token the 0.0.0.0 /run endpoint lets any client run argv.
	const token = process.env.OTTR_WORKER_TOKEN;
	if (!token) {
		console.error("OTTR_WORKER_TOKEN is required");
		process.exit(1);
	}

	// OTTR-754: build the server first so serving starts at once and the sweep can see
	// this worker's live turn start times before it deletes anything.
	const server = serveWorker({
		port: Number(process.env.WORKER_PORT) || 8787,
		token,
		// The provision guard audits this container's shared home when a run settles
		// (docs/specs/turn-provision-guard.md); the spawn-time rules capture scopes the
		// untracked scan to entries the run itself added.
		auditProvisioned: (sinceMs, rulesAtStart) =>
			auditProvisioned(homedir(), sinceMs, rulesAtStart),
		rulesAtStart: () => rulesDirEntries(homedir()),
	});

	// OTTR-754: the sweep passes the live turn starts so a running turn's /tmp
	// scratch survives, and logs each removal line for the worker's own console.
	const sweep = (): void => {
		for (const { name, bytes } of sweepTmpDirs(tmpdir(), {
			liveTurnStarts: server.runStarts(),
		})) {
			console.log(`sweep: removed ${name} (${formatBytes(bytes)})`);
		}
	};
	sweep();
	setInterval(sweep, 60 * 60 * 1000);

	// Serving starts at once: a turn that arrives during the install queues behind it (src/apt.ts).
	Promise.all([
		ensureAllPackages().then(
			(lines) => lines,
			(err) => {
				throw new Error(`apt: ${err instanceof Error ? err.message : err}`);
			},
		),
		ensureAllTools().then(
			(lines) => lines,
			(err) => {
				throw new Error(`tools: ${err instanceof Error ? err.message : err}`);
			},
		),
		ensureAllPython().then(
			(lines) => lines,
			(err) => {
				throw new Error(`pip: ${err instanceof Error ? err.message : err}`);
			},
		),
	]).then(
		(results) => {
			for (const line of results.flat()) console.log(line);
		},
		(err) => console.error(err instanceof Error ? err.message : String(err)),
	);

	process.on("SIGINT", () => {
		server.stop(true);
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		server.stop(true);
		process.exit(0);
	});
}
