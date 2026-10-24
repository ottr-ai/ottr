// A board for UI work, e.g. impeccable live: one scratch project under .dev/ and no agent runs.
// Never `bun start` in a checkout for this: it adopts every project in the parent folder, marks the
// live board's running turns "tracker restarted" and queues them again, so they run twice.
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", ".dev");
// Full demo pool for design work: five projects with backdated tasks, turns and events.
// Seeds once; `bun scripts/demo-data.ts --force` rebuilds it.
const { seedDemo } = await import("../scripts/demo-data.ts");
seedDemo(root);
process.env.OMP_TRACKER_ROOTS = root;
process.env.OTTR_STATE_DIR ??= resolve(root, "state");
// Fabricated running/preparing cards must survive recoverRestarted and sweepLostTurns:
// no agent processes exist here (maxTotal 0), so both sweeps would only requeue the seed.
process.env.OTTR_DEMO = "1";
process.env.OMP_TRACKER_MAX_TOTAL = "0";
process.env.PORT ??= "5747"; // outside 4700-4899, where scripts/e2e-steer.js picks its ports
// Opts into Bun's HTML dev server (HMR); see the development flag in server.ts.
process.env.NODE_ENV ??= "development";
// Dynamic on purpose: server.ts reads the env and scans the roots while it loads, and a static
// import would load it before the lines above run.
await import("./server.ts");
