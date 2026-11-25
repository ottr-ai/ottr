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
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). No per-area score exists yet; raise to this config's measured
  // score at its first real run (docs/specs/stryker-area-configs.md).
  thresholds: { ...base.thresholds, break: 76 },
};
