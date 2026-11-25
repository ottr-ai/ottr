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
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
