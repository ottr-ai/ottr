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
  // break = 76, the base config's measured score (76.48 at 16b3326, 2026-10-31)
  // rounded down; approved as this area's floor by the user on 2026-11-26 so no
  // threshold drops (OTTR-1275 work-check blockers). The full run after the merge
  // queue drains measures this area and sets its own break (measured, rounded
  // down, at most 90).
  thresholds: { ...base.thresholds, break: 76 },
};
