// Mutation testing for scripts/update-image.ts, the fifth run of `bun run test:mutation`. Its test
// drives real git fixtures, so only this file's mutants pay for them.
import base from "./stryker.config.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  commandRunner: { command: "ulimit -d 2097152 && bun test --bail scripts/update-image.test.ts" },
  mutate: ["scripts/update-image.ts"],
  // Pinned at 8: without it this inherits the main config's 24, and this git-fixture suite
  // inherits the base budget (10 s + 2x), which a 24-way run can inflate past — same caution as
  // the release and worktree configs.
  // incremental off (R8-3): an inherited untracked cache file would corrupt the main one.
  incremental: false,
  // Sandbox outside any git repo: the test clones/inspects repos, a sandbox inside this repo
  // would nest them.
  tempDirName: base.tempDirName,
  // break = measured score rounded down (83.08%, 2026-10-25 release review run at f0e3416;
  // earlier 76.96, 2026-10-14); raise it when the score rises. The 2026-10-13 73.43 came from
  // the shared-host run whose base score did not reproduce here. The script-side caps are
  // defense in depth: the /api/drain route re-sanitizes, so a surviving cap mutant cannot
  // change what the notice shows.
  thresholds: { ...base.thresholds, break: 83 },
};
