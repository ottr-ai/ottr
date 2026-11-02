// Mutation testing for src/release.ts. Its suite drives real git repos (~75 s a run: a git spawn
// costs ~0.5-1 s on Windows), so only this file's mutants pay for it — the same isolation pattern
// as stryker.worktree.config.mjs.
import base from "./stryker.config.mjs";
import { mutationConcurrency } from "./scripts/stryker-load.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The ulimit prefix matches the main config's cap, so a runaway aborts instead of OOMing the
  // host. --bail: a killed mutant needs only the first failing test, not the whole ~84 s git suite.
  // scripts/mutant-run.ts runs it in a private TMPDIR and removes it afterwards, also after a bail
  // that skips afterAll: no fixture or mutant touches the worker's shared /tmp.
  commandRunner: { command: "ulimit -d 2097152 && bun scripts/mutant-run.ts bun test --bail src/release.test.ts" },
  mutate: ["src/release.ts"],
  // 8, not the base cap: this git-spawn-heavy suite inflated every run past any timeout
  // budget at higher concurrency (80/80 timed out at 16-way, 2026-09-30); 8 keeps runs within the
  // budget below. The CPU-derived value and STRYKER_CONCURRENCY only lower it.
  concurrency: Math.min(8, mutationConcurrency()),
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
