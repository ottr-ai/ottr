import { isReview } from "../scheduler.ts";
import type { Task } from "../types.ts";
import type { SlotCounts } from "./queue.ts";

/** Which of the three workflow diagrams a card runs (README, "The three workflows"). */
export type WorkflowKind = "task" | "review" | "release";

/** A release card publishes after its review; the Review button's card is a bare review;
 * every other card builds. */
export function workflowKind(
	t: Pick<Task, "kind" | "releaseVersion">,
): WorkflowKind {
	if (t.releaseVersion !== null) return "release";
	if (isReview(t)) return "review";
	return "task";
}

/** The task diagram hardcodes the default slots ("2 / project · 3 total"); the Workflow modal
 *  swaps the project's live settings in. A no-op when the diagram's wording ever changes. */
export function withLiveSlots(
	svg: string,
	maxParallel: number | null,
	maxTotal: number | null,
): string {
	return svg.replace(
		"2 / project · 3 total",
		`${maxParallel ?? "no cap"} / project · ${maxTotal ?? "no cap"} total`,
	);
}

/** The modal's live status line under the diagram: slot use and queue of the card's project,
 *  the machine-wide cap use, and a draining note. Empty clauses drop out. */
export function workflowLive(l: {
	/** The name the board shows for the card's project. */
	label: string;
	slots: SlotCounts;
	/** Cards queued for a free slot on this project. */
	waiting: number;
	maxParallel: number | null;
	maxTotal: number | null;
	usedTotal: number;
	draining: boolean;
}): string {
	const used = l.slots.todo + l.slots.in_progress + l.slots.merging;
	return [
		l.maxParallel === null
			? `${l.label}: ${used} running (no project cap)`
			: `${l.label}: ${used} of ${l.maxParallel} agents running`,
		l.waiting > 0 ? `${l.waiting} queued for a free slot` : null,
		l.slots.merging > 0 ? `${l.slots.merging} in a merge turn` : null,
		l.maxTotal === null
			? `${l.usedTotal} running across all projects (no cap)`
			: `${l.usedTotal} of ${l.maxTotal} across all projects`,
		l.draining ? "board drains for an update — queued cards wait" : null,
	]
		.filter((s) => s !== null)
		.join(" · ");
}
