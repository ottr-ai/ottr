// OTTR-1259: the inbox sweep's seen seam — the loop ops that read the board's
// seen keys and baseline, so the sweep's filing candidates are exactly the
// unread Inbox. server.ts spreads this into createTurnLoop's ops; it must
// delegate to the app accessors, or production filings read an empty seen set.
import type { App } from "./app.ts";

export type SweepSeenOps = {
	seenIds: () => Promise<string[]>;
	seenSince: () => Promise<number>;
};

export function sweepSeenOps(
	// A thunk: the ops object builds before createApp runs (the loop exists
	// below the app), so the accessors must stay late-bound like turnReadToken's.
	app: () => Pick<App, "seenIds" | "seenSince">,
): SweepSeenOps {
	return {
		seenIds: () => app().seenIds(),
		seenSince: async () => await app().seenSince(),
	};
}
