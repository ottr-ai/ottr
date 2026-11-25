// Mutation testing for the vm area (OTTR-1275): the microVM runner, validation,
// guest protocol, rootfs, network, tokens and state. The smoke CLI entry stays
// out (no unit seam, see the base config note on src/vmValidateSmoke.ts).
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "vm";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: ["src/vm*.ts", "!src/vmValidateSmoke.ts", "!**/*.test.ts"],
  incrementalFile: "reports/stryker-incremental-vm.json",
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
