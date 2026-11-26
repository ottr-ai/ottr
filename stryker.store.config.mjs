// Mutation testing for the store area (OTTR-1275): task store, global store,
// PostgreSQL and SQLite drivers, schema, and the store test helpers.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "store";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/store*.ts",
    "src/globalStore.ts",
    "src/postgres*.ts",
    "src/sqliteDriver.ts",
    "src/dblock.ts",
    "src/sealedConfig.ts",
    "src/test/postgres*.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-store.json",
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
