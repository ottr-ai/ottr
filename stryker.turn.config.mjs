// Mutation testing for src/turn.ts, the turn-loop state machine. Its suite runs a real ProjectStore
// per test, which inflates the whole-suite runs of the main config past their budget (513 of 516
// mutants timed out there, 2026-10-01), so only this module's mutants pay for its suite — the same
// isolation pattern as stryker.release.config.mjs and stryker.worktree.config.mjs.
import base from "./stryker.config.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The 2 GB cap matches the main config, so a runaway aborts (Bun OOM, counts as Killed) instead
  // of OOMing the host. --bail cannot change a verdict: a surviving mutant still runs all tests, a
  // killed one stops at the first failure.
  commandRunner: { command: "ulimit -d 2097152 && bun test --bail src/turn.test.ts" },
  mutate: ["src/turn.ts"],
  // 24 with the cap; the capped uniform sample kept verdicts identical at c24 (OTTR-19), and the
  // 60 s + 2x budget leaves ~10x headroom over the ~8 s store suite.
  concurrency: 24,
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time: the store-heavy suite inflates
  // in the cold sandbox under parallel runners.
  timeoutMS: 60000,
  timeoutFactor: 2,
  // break = measured score rounded down (84.10%, 2026-10-14 clean run on this worker, after the
  // round-4 behavior tests in turn.test.ts; the 2026-10-13 82.07 came from the shared-host run
  // whose base score did not reproduce here, and the 2026-10-12 76.30 from the same polluted
  // review run as base's 86.83); raise it when the score rises.
  thresholds: { ...base.thresholds, break: 84 },
};
