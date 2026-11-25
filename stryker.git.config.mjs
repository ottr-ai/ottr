// Mutation testing for the git area (OTTR-1275): git transport and hosts, PRs,
// inline PRs, forks and fork analysis, Dependabot, issues, branch rules, and the
// board repo guard helper.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "git";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/git*.ts",
    "src/github*.ts",
    "src/prs.ts",
    "src/prInline.ts",
    "src/forks.ts",
    "src/forkAnalysis.ts",
    "src/dependabot.ts",
    "src/branchRules.ts",
    "src/deepen.ts",
    "src/issues.ts",
    "src/test/boardRepoGuard.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-git.json",
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  // Risk: if this area's first real run mass-times out, give it the module-config
  // budget (timeoutMS 120000, timeoutFactor 3, cap 8), like stryker.release.config.mjs.
  thresholds: { ...base.thresholds, break: 76 },
};
