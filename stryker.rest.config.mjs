// Mutation testing for the rest area (OTTR-1275): the catch-all for every
// mutable file no other area claims. Its negations mirror the other nine area
// configs and the seven base exclusions; scripts/stryker-areas.ts (bun run
// check) fails when a file lands in two configs or in none, so this list and
// the other configs cannot drift apart silently.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "rest";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/**/*.ts",
    "extension/**/*.ts",
    // Test files are never mutants.
    "!**/*.test.ts",
    // Mutated by the module configs, not by an area.
    "!src/release.ts",
    "!src/turn.ts",
    "!src/worktree.ts",
    // No unit seam or prose, excluded in the base config.
    "!src/app.ts",
    "!src/server.ts",
    "!src/prompts.ts",
    "!src/vmValidateSmoke.ts",
    // ui area
    "!src/ui/**",
    // store area
    "!src/store*.ts",
    "!src/globalStore.ts",
    "!src/postgres*.ts",
    "!src/sqliteDriver.ts",
    "!src/dblock.ts",
    "!src/sealedConfig.ts",
    "!src/test/postgres*.ts",
    // supervisor area
    "!src/supervisor.ts",
    "!src/scheduler.ts",
    "!src/runner.ts",
    // workers area
    "!src/workers.ts",
    "!src/turnUid.ts",
    "!src/mergeTurnUid.ts",
    "!src/turnPackages.ts",
    "!src/turnGithubToken.ts",
    "!src/confine.ts",
    "!src/session.ts",
    "!src/layers.ts",
    "!src/layerLeaseLock.ts",
    "!src/worker.ts",
    "!src/childEnv.ts",
    "!src/runTokens.ts",
    // vm area
    "!src/vm*.ts",
    // git area
    "!src/git*.ts",
    "!src/github*.ts",
    "!src/prs.ts",
    "!src/prInline.ts",
    "!src/forks.ts",
    "!src/forkAnalysis.ts",
    "!src/dependabot.ts",
    "!src/branchRules.ts",
    "!src/deepen.ts",
    "!src/issues.ts",
    "!src/test/boardRepoGuard.ts",
    // integrations area
    "!src/jira*.ts",
    "!src/llm*.ts",
    "!src/alate.ts",
    "!src/updates.ts",
    "!src/webpush.ts",
    "!src/notifications.ts",
    "!src/hosted.ts",
    "!src/pluginSkills.ts",
    "!src/serviceQuota*.ts",
    "!src/quota.ts",
    "!src/topics.ts",
    "!src/trustedLists.ts",
    "!src/auditLeads.ts",
    "!src/repoHomepage.ts",
    // insights area
    "!src/trending.ts",
    "!src/retro.ts",
    "!src/omp*.ts",
    "!src/codeScanWatch.ts",
    "!src/duplicateGate.ts",
    "!src/updateCycle.ts",
    "!src/orphans.ts",
    "!src/tmpsweep.ts",
    "!src/systemStats.ts",
    "!src/systemSampleLog.ts",
    "!src/perf*.ts",
    "!src/stryker.ts",
    // ops area
    "!src/releaseLine*.ts",
    "!src/releaseSummary.ts",
    "!src/backup.ts",
    "!src/boardBundle.ts",
    "!src/images.ts",
    "!src/provision.ts",
    "!src/python.ts",
    "!src/apt.ts",
    "!src/sandboxRun.ts",
    "!src/platform/**",
    "!src/dev.ts",
    "!src/restore.ts",
    "!src/memory.ts",
    "!src/vendor.ts",
    "!src/errmsg.ts",
    "!src/levels.ts",
    "!src/progress.ts",
    "!src/crash.ts",
    "!src/prefix.ts",
    "!src/singleFlight.ts",
    "!src/projectOrder.ts",
    "!src/test/sshKeygenStub.ts",
    "!src/test/suiteEnv.ts",
  ],
  incrementalFile: "reports/stryker-incremental-rest.json",
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
