// Mutation testing for the workers area (OTTR-1275): the worker process surface,
// turn identity and tokens, confinement, layers and sessions.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "workers";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/workers.ts",
    "src/turnUid.ts",
    "src/turnGithubToken.ts",
    "src/confine.ts",
    "src/session.ts",
    "src/layers.ts",
    "src/layerLeaseLock.ts",
    "src/worker.ts",
    "src/childEnv.ts",
    "src/runTokens.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-workers.json",
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
