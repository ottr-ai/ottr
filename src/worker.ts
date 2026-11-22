import { homedir, tmpdir } from "node:os";
import { auditProvisioned, rulesDirEntries } from "./provision.ts";
import { sweepTmpDirsLogged } from "./tmpsweep.ts";
import {
	bootTurnIsolation,
	ensureForkCapacity,
	isolationEnabled,
	turnHomesRoot,
} from "./turnUid.ts";
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
	// OTTR-994: the boot steps of the per-project turn identity run first (they are
	// top-dir cheap): the shared home becomes traversable-not-listable for turn uids,
	// the flat state dirs omp writes through the pin's links become sticky-writable,
	// and the project dirs under the shared roots take their project uid. A non-root
	// daemon gets one off note and no change.
	const dataRoots = ["/workspace", "/data"] as const;
	for (const note of bootTurnIsolation(homedir(), [...dataRoots]))
		console.log(`turn-uid: ${note}`);
	if (isolationEnabled()) {
		const forkNote = ensureForkCapacity();
		if (forkNote !== null) console.log(`turn-uid: ${forkNote}`);
	}
	const server = serveWorker({
		port: Number(process.env.WORKER_PORT) || 8787,
		token,
		// The provision guard audits this container's shared home when a run settles
		// (docs/specs/turn-provision-guard.md); the spawn-time rules capture scopes the
		// untracked scan to entries the run itself added.
		auditProvisioned: (sinceMs, rulesAtStart) =>
			auditProvisioned(homedir(), sinceMs, rulesAtStart),
		rulesAtStart: () => rulesDirEntries(homedir()),
		// OTTR-994: root daemons give every turn its project's uid and turn home
		// (docs/specs/worker-turn-uid-isolation.md).
		turnUid: isolationEnabled()
			? {
					homesRoot: turnHomesRoot(),
					workerHome: homedir(),
					dataRoots,
					workspaceRoot: "/workspace",
				}
			: null,
	});

	// OTTR-754: the sweep passes the live turn starts so a running turn's /tmp
	// scratch survives, and logs each removal line for the worker's own console.
	const sweep = (): void => {
		sweepTmpDirsLogged(tmpdir(), { liveTurnStarts: server.runStarts() });
	};
	sweep();
	setInterval(sweep, 60 * 60 * 1000);

	// The shared home is no longer a provisioning input (docs/specs/worker-list-isolation.md),
	// so startup has nothing to pre-warm from: a project's first turn here installs its tools
	// inline from the lists the board sends on its /run request. Serving already started.

	process.on("SIGINT", () => {
		server.stop(true);
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		server.stop(true);
		process.exit(0);
	});
}
