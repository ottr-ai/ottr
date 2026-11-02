// Mutation testing for src/turn.ts, the turn-loop state machine. Its suite runs a real ProjectStore
// per test, which inflates the whole-suite runs of the main config past their budget (513 of 516
// mutants timed out there, 2026-10-01), so only this module's mutants pay for its suite — the same
// isolation pattern as stryker.release.config.mjs and stryker.worktree.config.mjs.
import base from "./stryker.config.mjs";
import { mutationConcurrency } from "./scripts/stryker-load.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The 2 GB cap matches the main config, so a runaway aborts (Bun OOM, counts as Killed) instead
  // of OOMing the host. --bail cannot change a verdict: a surviving mutant still runs all tests, a
  // killed one stops at the first failure. scripts/mutant-run.ts gives each run a private TMPDIR
  // and removes it afterwards: no fixture or mutant touches the worker's shared /tmp.
  commandRunner: { command: "ulimit -d 2097152 && bun scripts/mutant-run.ts bun test --bail src/turn.test.ts" },
  mutate: ["src/turn.ts"],
  // The base cap; the capped uniform sample kept verdicts identical at c24 (OTTR-19), and the
  // 60 s + 2x budget leaves ~10x headroom over the ~8 s store suite. The CPU-derived value and
  // STRYKER_CONCURRENCY only lower it.
  concurrency: Math.min(24, mutationConcurrency()),
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time: the store-heavy suite inflates
  // in the cold sandbox under parallel runners.
  timeoutMS: 60000,
  timeoutFactor: 2,
  // break = killed-only score rounded down (2462 killed of 2635 = 93.4%, 2026-10-30 release
  // v0.2.0 review run at 16b3326; that run reported 94.50 with 28 timeouts and 145 survivors).
  // Timeouts count as detected but are not counted here: under host load they are mostly slow
  // survivors, not hangs (a 2026-10-31 rerun at a load average of ~90 timed out 1000 mutants and
  // left 3 survivors). Raise the break when a clean run on a quiet host measures more. History:
  // 86.59 (2026-10-25, after round 5), 84.10 (2026-10-14 clean run), 77.51 (2026-10-25 review).
  thresholds: { ...base.thresholds, break: 93 },
};
