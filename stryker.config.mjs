import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutation testing: `bun run test:mutation` runs this config, then stryker.release.config.mjs,
// stryker.turn.config.mjs, stryker.worktree.config.mjs and stryker.update-image.config.mjs.
// ponytail: Stryker's built-in command runner re-runs the whole suite per mutant, so there is no per-test
// coverage (no "NoCoverage" status). @hughescr/stryker-bun-runner would add it; retried 2026-09-30 on
// 1.4.0 + bun 1.3.14: its generated preload still imports a mangled path (ode_modules@hughescr...js,
// separators eaten on Windows). Retry when a release fixes that.
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "command",
  // worktree.test.ts and release.test.ts drive real git repos. A git spawn costs ~0.5-1 s on Windows,
  // so those suites cost ~75 s a run; both are isolated into their own configs and only the matching
  // module's mutants pay for them. scripts/dev-updater.test.js and scripts/update-image.test.ts drive
  // real git too and test no file this config mutates. --bail: a killed mutant needs only the first
  // failing test (same pattern as the isolated configs); verdicts are unchanged — a surviving mutant
  // still runs the whole suite, and bail never turns a killed mutant into a survivor.
  commandRunner: {
    command: "ulimit -d 2097152 && bun scripts/mutant-run.ts",
    // The runner script holds the dry run, --bail and the five --path-ignore-patterns. Stage 1
    // runs only the test files whose import closure contains the mutated file; stage-1 survivors
    // then run the full suite with --parallel=8. The dry run stays the full sequential suite, so
    // the timeout budget is unchanged; a once-per-run pass runs each test file alone to rule out
    // stage-1 false kills. The 2 GB data-segment cap stops the runaway mutants in
    // src/workers.ts:151-153 from OOM-killing the host and falsely killing neighbor mutants:
    // a runaway dies as a Bun OOM abort, which counts as Killed. ulimit is
    // POSIX-only, so mutation runs need Linux.
  },
  coverageAnalysis: "off",
  // No `incremental`: with the command runner the cache detects changed mutants only, never
  // changed tests, so a Killed mutant survives its killing test being deleted or weakened
  // (finding R8-3, 2026-10-12 review). Every run re-tests everything; do not re-enable.
  // 24 workers, each under the 2 GB cap. The 421-mutant uniform sample kept every verdict
  // identical at c8/c16/c24, while 48 slots produced 5 false timeouts from CPU saturation, so do
  // not raise past 24 without re-measuring. The 2026-10-13 exit-137 run
  // deaths were never memory: a guard mutant signalled the whole process group until a fake kill
  // was injected (fixed the same day). On a loaded machine inflated
  // run times can still mass-time-out past the budget (2026-09-30 review; a full clean base pass
  // once measured ~4 h at 8, 2026-10-13).
  concurrency: 24,
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time. The sandbox is a cold copy in
  // %TEMP%, so runs inflate past the standalone suite time; the 5 s / 1.5x default was too tight.
  timeoutMS: 10000,
  timeoutFactor: 2,
  // Sandbox outside any repo: a mutant that drops git()'s cwd must fail there, not run git in this repo.
  tempDirName: join(tmpdir(), "ott-stryker"),
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
    // ponytail: no unit seam, Bun.serve starts on import; covered by the live proofs in PLAN.md.
    // Upgrade: start the server only under `import.meta.main`, then test the handlers.
    "!src/server.ts",
    // Prose for the model; killing its mutants would take tests that pin wording.
    "!src/prompts.ts",
    // Not mutated, on purpose:
    // - src/ui/app.tsx: what the model-picker/status-line extraction (ott/613bf146) leaves is the
    //   React render tree plus browser I/O (fetch, FileReader, localStorage). bun test has no DOM
    //   renderer and a component harness would be new dependencies. Move pure policy into a tested
    //   .ts module instead of growing the file.
    // - src/app.ts: the route construction that moved out of server.ts (ott/7f31693f), inheriting
    //   server.ts's exclusion rationale (Bun.serve on import, covered by live proofs). A follow-up
    //   task owns extracting testable policy and bringing the file back into the set.
    "!src/app.ts",
  ],
  reporters: ["clear-text", "progress"],
  // break = the 2026-10-14 clean measured score (74.89%) rounded down; raise it when the score
  // rises. The 2026-10-13 99.42 did not reproduce on this worker (873 survivors over 7,034
  // mutants; planted-survivor probes pass the whole suite here, so this host's verdicts are
  // honest); on 2026-10-14 the break was lowered to the measured score by decision. The
  // 2026-10-12 score (86.83) was not adopted: it reused cached results and counted
  // EADDRINUSE-failed concurrent runs as kills. The 2026-09-30 baseline (64) predates the
  // killing tests the 2026-10-12 review follow-up added. --bail also ended the OOM deaths:
  // full-suite runs of killed mutants accumulated leaked test servers until the host OOM-killed
  // the run (~1,430 tested in, at every concurrency tried).
  thresholds: { high: 80, low: 60, break: 74 },
};
