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
  // break = killed-only score rounded down (2118 killed of 2446 = 86.59%, 2026-10-25 run after
  // the round-5 behavior tests). That run reported 99.02, but it counted 304 timeouts as
  // detected: the host ran other cards' Stryker runs at a load average of ~25, so most of those
  // are slow runs, not hangs. The 24 survivors are all equivalent mutants (OTTR-175 report).
  // Raise the break when a clean run on a quiet host measures more. History: 84.10 (2026-10-14
  // clean run), 77.51 (2026-10-25 release review, before round 5).
  thresholds: { ...base.thresholds, break: 86 },
};
