import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireMutationLock,
	isStrykerRun,
	mutationConcurrency,
	sandboxTempDirName,
} from "./scripts/stryker-load.mjs";

// One mutation run at a time on a worker: every Stryker run imports this base module, so the
// host-global lock (/tmp/ott-stryker.lock) serializes all five Stryker runs here. A second run
// waits and logs; a lock from a killed run is taken over. Only a run takes the lock, never a
// plain import: a tool that reads the configs to learn their mutate arrays
// (scripts/mutation-delta.ts) must not hold the lock its own Stryker children then wait for
// (OTTR-366). The lock stays host-global even though the sandbox below is per checkout, so
// parallel runs on loaded hosts keep waiting instead of mass-timing-out (2026-09-30 review).
const mutationLockBase = join(tmpdir(), "ott-stryker");
// The sandbox parent is per checkout and wiped at run start (OTTR-500): the machine-global
// parent let a killed run's leftover sandbox hold a foreign or stale tree, and Stryker's
// per-test stage 1 then skipped the missing files and ran mutants against it. Different
// checkouts hash to different parents, and while a run holds the lock no other run is active,
// so the wipe of this checkout's parent cannot touch a concurrent run. Only a run wipes,
// never a plain import (same isStrykerRun gate as the lock).
const tempDirName = sandboxTempDirName();
if (isStrykerRun()) {
	acquireMutationLock(mutationLockBase);
	rmSync(tempDirName, { recursive: true, force: true });
}

// Mutation testing: `bun run test:mutation` runs this config, then stryker.release.config.mjs,
// stryker.turn.config.mjs, stryker.worktree.config.mjs and stryker.update-image.config.mjs.
// @hughescr/stryker-bun-runner runs bun test with per-test coverage: each mutant runs only the
// tests that reach it, and unreached mutants are reported NoCoverage. The 2026-09-30 retry
// blocker (a mangled Windows preload path) is gone: releases 1.5/1.6 fixed it and mutation runs
// are Linux-only since the ulimit days anyway. Measured at 053838a (2026-11-04): the turn run
// fell 4.5 h -> 66 min with 99.75% identical verdicts; 42 mutants turned NoCoverage and 7
// order-dependent kills in turn.test.ts became survivors.
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  bun: {
    // Bounds the dry run's single `bun test` process (the full sequential suite; the whole suite
    // measured 8 m 16 s under this runner at 053838a). Mutant runs get Stryker's per-mutant
    // budget instead: timeoutMS + timeoutFactor x the dry-run time of their covering tests.
    timeout: 1_200_000,
    // Replaces the command runner's `ulimit -d 2097152`: the runaway mutants in the stdout
    // line-split loop of src/workers.ts must not OOM the host and falsely kill neighbor
    // mutants. A bun test child over the 2 GB ceiling is killed and scored Timeout
    // (detected), like the ulimit OOM abort was Killed before. ulimit is POSIX-only, so
    // mutation runs needed Linux; the RSS ceiling works everywhere the runner does.
    maxChildRss: 2_147_483_648,
  },
  coverageAnalysis: "perTest",
  // Mutant runs bail at the first failing test (Stryker's default), so a killed mutant pays
  // only its covering tests up to the killer. The dry run never bails. worktree.test.ts and
  // release.test.ts drive real git repos and stay isolated into their own configs, so only the
  // matching module's mutants pay for them.
  // Incremental, one cache file per config: the five configs share this base module, so the
  // single default path would let one run reuse another config's verdicts (why incremental
  // was off). With perTest coverage the cache tracks changed tests too (the command runner's
  // R8-3 staleness is gone). Release reviews run --force so a release never reuses verdicts
  // across fixture, config, dependency or Stryker-version changes the differ cannot see
  // (docs/ARCH-REVIEWS.md "Delta gate").
  incremental: true,
  incrementalFile: "reports/stryker-incremental-main.json",
  // Half of the host CPUs (os.availableParallelism()), at least 1, so a run never asks for more
  // CPU than the host has; STRYKER_CONCURRENCY wins when set. Capped at the measured 24: each
  // worker runs under the 2 GB cap, the 421-mutant uniform sample kept every verdict identical
  // at c8/c16/c24, while 48 slots produced 5 false timeouts from CPU saturation, so do not
  // raise the cap without re-measuring. The 2026-10-13 exit-137 run
  // deaths were never memory: a guard mutant signalled the whole process group until a fake kill
  // was injected (fixed the same day). On a loaded machine inflated
  // run times can still mass-time-out past the budget (2026-09-30 review; a full clean base pass
  // once measured ~4 h at 8, 2026-10-13).
  concurrency: Math.min(24, mutationConcurrency()),
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time. The sandbox is a cold copy in
  // %TEMP%, so runs inflate past the standalone suite time; the 5 s / 1.5x default was too tight.
  timeoutMS: 10000,
  timeoutFactor: 2,
  // The dry run (full sequential suite, then each test file alone) took 260 s standalone on a quiet
  // host at 16b3326; the cold sandbox crossed Stryker's 5-minute default (2026-10-30 v0.2.0 review).
  dryRunTimeoutMinutes: 20,
  // Sandbox outside any repo: a mutant that drops git()'s cwd must fail there, not run git in this
  // repo. Per checkout and wiped at run start (OTTR-500, see the header above).
  tempDirName,
  // TypeScript 7's JS API has no parseConfigFileTextToJson, which Stryker 10's sandbox tsconfig
  // rewrite calls. Our tsconfig has no extends/references to rewrite, so point it at a missing file.
  tsconfigFile: "no-tsconfig-rewrite.json",
  mutate: [
    "src/**/*.ts",
    // Worker policy (notification defaults, client matching): unit-tested via a fake
    // `self` in sw.test.js. .js and untyped, so it is listed explicitly.
    "src/ui/sw.js",
    "extension/**/*.ts",
    // Test files are never mutants: extension/tracker.test.ts matched extension/**/*.ts (R8-6).
    "!**/*.test.ts",
    // mutated by stryker.worktree.config.mjs, the only run that pays for its git-backed tests
    "!src/worktree.ts",
    // mutated by stryker.release.config.mjs, the only run that pays for its git-backed tests
    "!src/release.ts",
    // mutated by stryker.turn.config.mjs, the only run that pays for its store-backed suite
    "!src/turn.ts",
    // ponytail: no unit seam, Bun.serve starts on import; covered by scripts/boot-smoke.ts (bun run check).
    // Upgrade: start the server only under `import.meta.main`, then test the handlers.
    "!src/server.ts",
    // Prose for the model; killing its mutants would take tests that pin wording.
    "!src/prompts.ts",
    // Not mutated, on purpose:
    // - src/ui/app.tsx, src/ui/settings.tsx, src/ui/kit.tsx (.tsx, so "src/**/*.ts" skips them): the
    //   React render tree plus browser I/O (fetch, FileReader, localStorage). bun test has no DOM
    //   renderer and a component harness would be new dependencies. Move pure policy into a tested
    //   .ts module (e.g. src/ui/models.ts) instead of growing these files.
    // - src/app.ts: createApp(deps) is importable and src/app.test.ts drives it in-process (no
    //   Bun.serve on import), but the file is thousands of lines of route wiring, and each mutant
    //   would pay for the whole app suite. Policy belongs in a mutated module with its own tests
    //   (src/alate.ts, src/scheduler.ts), and app.ts keeps only the wiring.
    "!src/app.ts",
  ],
  reporters: ["clear-text", "progress"],
  // break = the 2026-10-31 measured score at 16b3326 (76.48%, 14,098 mutants) rounded down; it was
  // 74 from the 2026-10-14 clean measured score (74.89%). Raise it when the score
  // rises. The 2026-10-13 99.42 did not reproduce on this worker (873 survivors over 7,034
  // mutants; planted-survivor probes pass the whole suite here, so this host's verdicts are
  // honest); on 2026-10-14 the break was lowered to the measured score by decision. The
  // 2026-10-12 score (86.83) was not adopted: it reused cached results and counted
  // EADDRINUSE-failed concurrent runs as kills. The 2026-09-30 baseline (64) predates the
  // killing tests the 2026-10-12 review follow-up added. --bail also ended the OOM deaths:
  // full-suite runs of killed mutants accumulated leaked test servers until the host OOM-killed
  // the run (~1,430 tested in, at every concurrency tried).
  thresholds: { high: 80, low: 60, break: 76 },
};
