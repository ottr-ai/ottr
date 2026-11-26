// Mutation testing for the ops area (OTTR-1275): release line scanning and
// summaries, backup, board bundle, images, provision, python and apt helpers,
// sandbox runs, the platform layer, and small process utilities.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "ops";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/releaseLine*.ts",
    "src/releaseSummary.ts",
    "src/backup.ts",
    "src/boardBundle.ts",
    "src/images.ts",
    "src/provision.ts",
    "src/python.ts",
    "src/apt.ts",
    "src/sandboxRun.ts",
    "src/platform/**",
    "src/dev.ts",
    "src/restore.ts",
    "src/memory.ts",
    "src/vendor.ts",
    "src/errmsg.ts",
    "src/levels.ts",
    "src/progress.ts",
    "src/crash.ts",
    "src/prefix.ts",
    "src/singleFlight.ts",
    "src/projectOrder.ts",
    "src/test/sshKeygenStub.ts",
    "src/test/suiteEnv.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-ops.json",
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
