// Mutation testing for src/release.ts. Its suite drives real git repos (~75 s a run: a git spawn
// costs ~0.5-1 s on Windows), so only this file's mutants pay for it — the same isolation pattern
// as stryker.worktree.config.mjs.
import base from "./stryker.config.mjs";
import { cappedConcurrency } from "./scripts/stryker-load.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The runner runs exactly src/release.test.ts, bailing at the first failing test: a killed
  // mutant needs only the first failure, not the whole ~84 s git suite. base.bun's 2 GB
  // maxChildRss keeps a runaway from OOMing the host; the runner's own temp dirs are removed
  // when the run ends.
  bun: { ...base.bun, timeout: 600_000, testFiles: ["src/release.test.ts"] },
  mutate: ["src/release.ts"],
  // Own cache file: all five configs share the base module (stryker.config.mjs).
  incrementalFile: "reports/stryker-incremental-release.json",
  // 8, not the base cap: this git-spawn-heavy suite inflated every run past any timeout
  // budget at higher concurrency (80/80 timed out at 16-way, 2026-09-30); 8 keeps runs within the
  // budget below. The CPU-derived value, the memory rule and STRYKER_CONCURRENCY only lower it.
  concurrency: cappedConcurrency(8),
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time. The git-heavy suite inflates
  // under parallel runners, and a git spawn's cost on Windows swings ~3x with machine state
  // (74 s standalone in the morning, 160-260 s the same afternoon), so the budget is sized for
  // the slow state: survivors pay the full suite and must not time out.
  timeoutMS: 120000,
  timeoutFactor: 3,
  // break = measured score rounded down (76.79%, 2026-10-25 release review run at f0e3416);
  // raise it when the score rises. Earlier: 75.49 (2026-10-14 clean run on this worker). The
  // 2026-10-13 73.57 came from the shared-host run whose base score did not reproduce on this
  // worker (see stryker.config.mjs); the 2026-10-12 72.10 came from the same polluted review
  // run as base's 86.83.
  thresholds: { ...base.thresholds, break: 76 },
};
