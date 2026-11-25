// Mutation testing for the ui area (OTTR-1275): the board UI modules under
// src/ui/ and the service worker sw.js. The React render tree (.tsx) stays out:
// the base glob never matched it (see the base config note).
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "ui";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: ["src/ui/**/*.ts", "src/ui/sw.js", "!src/ui/sw.test.js", "!**/*.test.ts"],
  incrementalFile: "reports/stryker-incremental-ui.json",
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
