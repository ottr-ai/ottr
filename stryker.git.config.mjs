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
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  // Risk: if this area's first real run mass-times out, give it the module-config
  // budget (timeoutMS 120000, timeoutFactor 3, cap 8), like stryker.release.config.mjs.
  thresholds: { ...base.thresholds, break: 76 },
};
