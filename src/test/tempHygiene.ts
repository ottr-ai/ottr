/**
 * OTTR-1209: a bun test run must leave no new fixture temp dirs in the OS temp dir. Worker
 * /tmp caps filled on 2026-11-22 (~17,500 app-box-* dirs, ENOSPC) because src/app.test.ts
 * testBox() made one mkdtempSync home per secret-box store and never removed it, and other
 * fixture families leaked the same way. This preload (bunfig [test] preload, bun test only)
 * runs two mechanisms:
 *
 * 1. Containment: before any test file loads, the preload points TMPDIR at a per-process run
 *    root, so every fixture mkdtemp of the run lands inside that root instead of the shared
 *    OS temp dir. Concurrent bun test runs on the same host (the board runs merges, reviews
 *    and work turns side by side) each get their own root and cannot see each other's
 *    fixtures, so no run can be blamed for another run's dirs.
 * 2. The guard: a preload-registered afterAll fires once, after the files' own afterAll
 *    hooks (probe-verified). It lists the run root and fails the run when entries with a
 *    known fixture prefix remain - a leak its creator's cleanup missed shows up here with
 *    its full name. The root is removed afterwards, so even a family without a guarded
 *    prefix leaves no trace in the OS temp dir.
 *
 * suiteEnv.ts snapshots the env per test and its restore keeps TMPDIR, so the redirect
 * survives every restore. Children spawned by tests inherit the root; a child bun test
 * redirects into a nested root of its own and removes it at its own end.
 */
import { afterAll, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every fixture prefix a creator in this repo leaves under tmpdir(); the OTTR-1209 leak families. */
const FIXTURE_PREFIXES = [
	"app-box-",
	"app-routes-",
	"gate-replay-",
	"gate-handoff-",
	"dev-board-",
	"rename-live-",
	"demo-seed-failure-",
	"readme-screenshot-test-",
];

const runRoot = mkdtempSync(join(tmpdir(), "ottr-suite-"));
process.env.TMPDIR = runRoot;

afterAll(() => {
	let fresh: string[] = [];
	try {
		if (existsSync(runRoot)) {
			fresh = readdirSync(runRoot).filter((name) =>
				FIXTURE_PREFIXES.some((prefix) => name.startsWith(prefix)),
			);
		}
	} finally {
		rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 });
	}
	if (fresh.length > 0) {
		console.error(
			`[temp-hygiene] the test run left ${fresh.length} fixture temp dir(s) in its run root:\n  ${fresh.join("\n  ")}`,
		);
	}
	expect(fresh).toEqual([]);
});
