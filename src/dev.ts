// A board for UI work, e.g. impeccable live: one scratch project under .dev/ and no agent runs.
// Never `bun start` in a checkout for this: it adopts every project in the parent folder, marks the
// live board's running turns "tracker restarted" and queues them again, so they run twice.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Seeds the scratch root, points the env at it, and loads the server. Entry-only behavior,
 * exported so dev.test.ts can drive it behind mocks. Importing this module runs nothing:
 * Stryker's bun runner eagerly imports every mutated file to prime per-test coverage
 * (coverage-preload.js in @hughescr/stryker-bun-runner 1.6), and side effects there would
 * seed demo data and leak env into every test file before any test installs its mocks.
 */
export async function bootstrap(): Promise<void> {
	process.env.PORT ??= "5747"; // outside 4700-4899, where scripts/e2e-steer.js picks its ports
	const { heldDb, seedDemo } = await import("../scripts/demo-data.ts");
	// A board that still runs on the shared .dev root (a leftover shot attempt) holds its
	// dbs under an exclusive lock, and server.ts refuses a second instance. This board then
	// seeds its own root per port, so it boots beside the other one.
	let root = resolve(import.meta.dir, "..", ".dev");
	const held = heldDb(root);
	if (held !== null) {
		root = resolve(import.meta.dir, "..", `.dev-${process.env.PORT}`);
		console.warn(
			`dev board: ${held} is held by another board; seeding ${root} instead`,
		);
	}
	// Full demo pool for design work: five projects with backdated tasks, turns and events.
	// Seeds once; `bun scripts/demo-data.ts --force` rebuilds it.
	seedDemo(root);
	process.env.OMP_TRACKER_ROOTS = root;
	process.env.OTTR_STATE_DIR ??= resolve(root, "state");
	// The Settings Env section reads <home>/.ottr/workers/<project>/env.txt; the dev board
	// reads this fixture home instead of the real one, so demo names never touch a live home.
	process.env.OTTR_WORKERS_HOME ??= resolve(root, "workers-home");
	{
		const home = process.env.OTTR_WORKERS_HOME;
		for (const [project, names] of [
			["_all", ["GODOT_EXPERIMENT"]],
			["pixelforge", ["PIXELLAB_API_KEY"]],
		] as const) {
			const dir = resolve(home, ".ottr", "workers", project);
			mkdirSync(dir, { recursive: true });
			writeFileSync(resolve(dir, "env.txt"), `${names.join("\n")}\n`);
		}
	}
	// Fabricated running/preparing cards must survive recoverRestarted and sweepLostTurns, and
	// queued ones must never start: no agent processes exist here. OTTR_DEMO blocks all three.
	process.env.OTTR_DEMO = "1";
	process.env.OMP_TRACKER_MAX_TOTAL = "none"; // the header shows n/∞, as on a board with no cap
	// Opts into Bun's HTML dev server (HMR); see the development flag in server.ts.
	process.env.NODE_ENV ??= "development";
	// Dynamic on purpose: server.ts reads the env and scans the roots while it loads, and a static
	// import would load it before the lines above run.
	await import("./server.ts");
}

if (import.meta.main) await bootstrap();
