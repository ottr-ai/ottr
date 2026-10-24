// Mutation testing for src/release.ts. Its suite drives real git repos (~75 s a run: a git spawn
// costs ~0.5-1 s on Windows), so only this file's mutants pay for it — the same isolation pattern
// as stryker.worktree.config.mjs.
import base from "./stryker.config.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The ulimit prefix matches the main config's cap, so a runaway aborts instead of OOMing the
  // host. --bail: a killed mutant needs only the first failing test, not the whole ~84 s git suite. Bun
  // skips afterAll on bail, but each fixture dir is swept by the next run (see sweepStaleFixtures).
  commandRunner: { command: "ulimit -d 2097152 && bun test --bail src/release.test.ts" },
  mutate: ["src/release.ts"],
  // 8, not the new base of 24: this git-spawn-heavy suite inflated every run past any timeout
  // budget at higher concurrency (80/80 timed out at 16-way, 2026-09-30); 8 keeps runs within the
  // budget below.
  concurrency: 8,
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time. The git-heavy suite inflates
  // under parallel runners, and a git spawn's cost on Windows swings ~3x with machine state
  // (74 s standalone in the morning, 160-260 s the same afternoon), so the budget is sized for
  // the slow state: survivors pay the full suite and must not time out.
  timeoutMS: 120000,
  timeoutFactor: 3,
  // break = the 2026-10-14 clean measured score (75.49%) rounded down; raise it when the score
  // rises. The 2026-10-13 73.57 came from the shared-host run whose base score did not reproduce
  // on this worker (see stryker.config.mjs); the 2026-10-12 72.10 came from the same polluted
  // review run as base's 86.83.
  thresholds: { ...base.thresholds, break: 75 },
};
