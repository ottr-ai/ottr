// Mutation testing for src/worktree.ts, the second half of `bun run test:mutation`. Its tests drive real
// git repos (~4 s a run alone, ~10 s with 23 in parallel), so only this file's mutants pay for them.
import base from "./stryker.config.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  commandRunner: { command: "ulimit -d 2097152 && bun test --bail --timeout 60000 src/worktree.test.ts" },
  mutate: ["src/worktree.ts"],
  // 8, not the new base of 24: this git-spawn-heavy suite timed out at 16-way on the loaded machine
  // (2026-09-30, 32/38 in the first minutes); 8 keeps runs inside the budget below. Fixture dirs
  // of bail-killed runs are swept by the next run (sweepStaleFixtures in worktree.test.ts).
  concurrency: 8,
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time, sized for the slow machine
  // state: a git spawn's cost on Windows swings ~3x, and the git-heavy suite inflates with it.
  timeoutMS: 120000,
  timeoutFactor: 3,
  // break = measured score rounded down (68.27%, 2026-10-25 release review run at f0e3416).
  // Earlier: 60.17 (2026-10-14 clean run on this worker; the 2026-10-13 shared-host
  // measurement was 58.87). Never lower it; raise it when a clean run measures above 68.
  thresholds: { ...base.thresholds, break: 68 },
};
