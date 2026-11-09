// Mutation testing for src/turn.ts, the turn-loop state machine. Its suite runs a real ProjectStore
// per test, which inflates the whole-suite runs of the main config past their budget (513 of 516
// mutants timed out there, 2026-10-01), so only this module's mutants pay for its suite — the same
// isolation pattern as stryker.release.config.mjs and stryker.worktree.config.mjs.
import base from "./stryker.config.mjs";
import { mutationConcurrency } from "./scripts/stryker-load.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The runner runs exactly src/turn.test.ts, and perTest coverage selects only the covering
  // tests per mutant, bailing at the first failure: a surviving mutant still runs all its
  // covering tests, a killed one stops at the first. base.bun's 2 GB maxChildRss keeps a
  // runaway from OOMing the host; the runner's own temp dirs are removed when the run ends.
  bun: { ...base.bun, timeout: 300_000, testFiles: ["src/turn.test.ts"] },
  mutate: ["src/turn.ts"],
  // Own cache file: all five configs share the base module (stryker.config.mjs).
  incrementalFile: "reports/stryker-incremental-turn.json",
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
  // left 3 survivors). The measured 93.4 exceeds 90, so the break holds the cap of 90 per
  // coding-guideline.md (2026-11-09): a break never goes above 90; a threshold above 90 may be
  // set to 90. Raise the break when a clean run on a quiet host measures more, but never above
  // 90. History: 93 (2026-11-09, capped from the measured 93), 86.59 (2026-10-25, after round 5),
  // 84.10 (2026-10-14 clean run), 77.51 (2026-10-25 review).
  thresholds: { ...base.thresholds, break: 90 },
};
