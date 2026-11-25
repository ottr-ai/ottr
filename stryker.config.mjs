// The base mutation config holds the full mutate set as the reference universe, and the
// exactly-once check (scripts/stryker-areas.ts) compares it against the area configs.
// `bun run test:mutation` no longer runs this file. All fourteen configs share the factory
// in scripts/stryker-base.mjs, and each config file calls it exactly once with its own cap,
// so every run computes and logs its concurrency exactly once — one line, with the slot
// count the run actually uses (OTTR-886).
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default makeBaseConfig(24);
