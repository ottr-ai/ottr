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
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
