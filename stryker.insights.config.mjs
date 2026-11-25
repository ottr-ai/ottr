// Mutation testing for the insights area (OTTR-1275): trending, retro, omp
// stats and watch, code scanning watch, duplicate gate, update cycle, orphans
// and temp sweeps, system stats, and perf lenses.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "insights";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/trending.ts",
    "src/retro.ts",
    "src/omp*.ts",
    "src/codeScanWatch.ts",
    "src/duplicateGate.ts",
    "src/updateCycle.ts",
    "src/orphans.ts",
    "src/tmpsweep.ts",
    "src/systemStats.ts",
    "src/systemSampleLog.ts",
    "src/perf*.ts",
    "src/stryker.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-insights.json",
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
