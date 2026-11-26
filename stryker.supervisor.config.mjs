// Mutation testing for the supervisor area (OTTR-1275): the supervisor loop,
// the card scheduler, and the turn runner.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "supervisor";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/supervisor.ts",
    "src/scheduler.ts",
    "src/runner.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-supervisor.json",
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
