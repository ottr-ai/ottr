// Mutation testing for the integrations area (OTTR-1275): Jira, LLM gateway and
// proxy, Alate bridge, web push, notifications, hosted mode, plugin skills,
// service quotas, and the small external-service helpers.
import { makeBaseConfig } from "./scripts/stryker-base.mjs";

const base = makeBaseConfig(24);

export const areaName = "integrations";

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "src/jira*.ts",
    "src/llm*.ts",
    "src/alate.ts",
    "src/updates.ts",
    "src/webpush.ts",
    "src/notifications.ts",
    "src/hosted.ts",
    "src/pluginSkills.ts",
    "src/serviceQuota*.ts",
    "src/quota.ts",
    "src/topics.ts",
    "src/trustedLists.ts",
    "src/auditLeads.ts",
    "src/repoHomepage.ts",
    "!**/*.test.ts",
  ],
  incrementalFile: "reports/stryker-incremental-integrations.json",
  // break = the standing measured floor (76, the 2026-10-31 full score at 16b3326
  // rounded down). Raise to this config's measured score at its first real run.
  thresholds: { ...base.thresholds, break: 76 },
};
