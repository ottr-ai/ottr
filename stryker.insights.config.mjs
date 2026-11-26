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
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
