// Mutation testing for src/worktree.ts, the second half of `bun run test:mutation`. Its tests drive real
// git repos (~4 s a run alone, ~10 s with 23 in parallel), so only this file's mutants pay for them.
import base from "./stryker.config.mjs";
import { mutationConcurrency } from "./scripts/stryker-load.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // scripts/mutant-run.ts gives each run a private TMPDIR and removes it afterwards, also after a
  // bail that skips afterAll: no fixture or mutant touches the worker's shared /tmp.
  commandRunner: { command: "ulimit -d 2097152 && bun scripts/mutant-run.ts bun test --bail --timeout 60000 src/worktree.test.ts" },
  mutate: ["src/worktree.ts"],
  // 8, not the base cap: this git-spawn-heavy suite timed out at 16-way on the loaded machine
  // (2026-09-30, 32/38 in the first minutes); 8 keeps runs inside the budget below. The
  // CPU-derived value and STRYKER_CONCURRENCY only lower it.
  concurrency: Math.min(8, mutationConcurrency()),
  // Budget per run = timeoutMS + timeoutFactor x dry-run net time, sized for the slow machine
  // state: a git spawn's cost on Windows swings ~3x, and the git-heavy suite inflates with it.
  timeoutMS: 120000,
  timeoutFactor: 3,
  // break = measured score rounded down (70.68%, 2026-10-30 release v0.2.0 review run at
  // 16b3326: 903 killed, 18 timed out, 382 survived). Earlier: 68.27 (2026-10-25 at f0e3416),
  // 60.17 (2026-10-14 clean run; the 2026-10-13 shared-host measurement was 58.87). Never lower
  // it; raise it when a clean run measures above 70.
  thresholds: { ...base.thresholds, break: 70 },
};
