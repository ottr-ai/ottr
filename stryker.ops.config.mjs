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
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
