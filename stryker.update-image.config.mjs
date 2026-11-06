// Mutation testing for scripts/update-image.ts, the fifth run of `bun run test:mutation`. Its test
// drives real git fixtures, so only this file's mutants pay for them.
import base from "./stryker.config.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  // The runner runs exactly scripts/update-image.test.ts and bails at the first failing test;
  // its temp dirs are removed when the run ends. base.bun's 2 GB maxChildRss keeps a runaway
  // from OOMing the host.
  bun: { ...base.bun, timeout: 600_000, testFiles: ["scripts/update-image.test.ts"] },
  mutate: ["scripts/update-image.ts"],
  // 8, not the main config's 24, with the git-heavy configs' budget (timeoutMS + timeoutFactor x
  // dry-run net time). The comment here said "Pinned at 8" while the field was missing, so the run
  // inherited 24-way and the 10 s + 2x budget. Under host load (load average ~50, 2026-10-30)
  // that budget turned survivors into timeouts: of 17 timed-out mutants re-run at 6-way with a
  // 300 s budget, 11 survived and 6 were killed. Real hangs (the `i--` in the --env-file loop)
  // still time out under any budget and count as detected.
  concurrency: 8,
  timeoutMS: 120000,
  timeoutFactor: 3,
  // Own cache file: all five configs share the base module (stryker.config.mjs), which is
  // why incremental was off here (R8-3: an inherited untracked cache file would have
  // corrupted the main one).
  incrementalFile: "reports/stryker-incremental-update-image.json",
  // Sandbox outside any git repo: the test clones/inspects repos, a sandbox inside this repo
  // would nest them.
  tempDirName: base.tempDirName,
  // ignoreStatic on, measured 2026-11-06 at 1da6398: 27 static mutants of 1,286, all killed
  // in the baseline run, so ignoring them moved the score 94.71% -> 94.52% (static removal is
  // the only cause) and cut the mutant phase 5m53s -> 5m18s.
  ignoreStatic: true,
  // break = measured score rounded down (94.52% with ignoreStatic, 2026-11-06 at 1da6398;
  // raised from 91 = the 91.97% measured 2026-10-31 at 4f6d93b plus the survivor-kill
  // tests: 684 killed, 3 timed out, 60 survived, with the 8-way 120 s + 3x budget above). The
  // 2026-10-30 review's 88.95 and the earlier 83.08 (2026-10-25, f0e3416) and 76.96 (2026-10-14)
  // ran 24-way on the 10 s + 2x budget and counted slow survivors as timeouts: the same code
  // measured 76.84 on the honest budget before these tests. Raise it when the score rises. Most
  // survivors left are equivalent (unreachable fallbacks, never-empty git output) or sit in the
  // `import.meta.main` CLI entry. The script-side caps are defense in depth: the /api/drain
  // route re-sanitizes, so a surviving cap mutant cannot change what the notice shows.
  thresholds: { ...base.thresholds, break: 94 },
};
