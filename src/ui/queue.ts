import { queueOrder } from "../scheduler.ts";
import type { RunState, Stage, Task, TaskCard } from "../types.ts";

/** Card facts the lane counts and the search filter read. */
type LaneTask = Pick<
	TaskCard,
	| "id"
	| "sessionTitle"
	| "title"
	| "prompt"
	| "summary"
	| "stage"
	| "state"
	| "asked"
	| "answered"
>;

const STAGES = [
	"todo",
	"in_progress",
	"merging",
	"done",
	"backlog",
] as const satisfies readonly Stage[];

/** Per-stage board numbers: the tab-strip counts and the lane-head badges. */
export type LaneCount = {
	/** Cards matching the search filter. */
	shown: number;
	/** All cards in the stage, ignoring the filter. */
	total: number;
	/** Done only: answered cards not opened yet. */
	fresh: number;
	/** needs_you cards, ignoring the filter: an alarm must not hide behind the search box. */
	waiting: number;
	/** null while nothing waits; "asked" while every waiting card has its question out. */
	alarm: "needs" | "asked" | null;
};

/** The lane a card shows in: a kicked backlog card (grill session queued/running/needs_you) joins the todo flow; the backlog row keeps parked ideas only. */
export function laneStage(t: Pick<Task, "stage" | "state">): Stage {
	return t.stage === "backlog" && t.state !== "idle" ? "todo" : t.stage;
}

/** The board's search filter plus per-stage counts: the shown list for the lanes, counts for tab strip and lane heads. */
export function laneCounts<T extends LaneTask>(
	tasks: readonly T[],
	query: string,
	seen: ReadonlySet<string>,
): { shown: T[]; counts: Record<Stage, LaneCount> } {
	const q = query.trim().toLowerCase();
	// Contains match on the id, what the card shows, plus the full prompt and latest summary.
	const shown =
		q === ""
			? [...tasks]
			: tasks.filter((t) =>
					`${t.id}\n${t.sessionTitle || t.title}\n${t.prompt}\n${t.summary ?? ""}`
						.toLowerCase()
						.includes(q),
				);
	const counts = {} as Record<Stage, LaneCount>;
	for (const stage of STAGES) {
		const visible = shown.filter((t) => laneStage(t) === stage);
		const waiting = tasks.filter(
			(t) => laneStage(t) === stage && t.state === "needs_you",
		);
		counts[stage] = {
			shown: visible.length,
			total: tasks.filter((t) => laneStage(t) === stage).length,
			fresh:
				stage === "done"
					? visible.filter((t) => t.answered && !seen.has(t.id)).length
					: 0,
			waiting: waiting.length,
			alarm:
				waiting.length === 0
					? null
					: waiting.every((t) => t.asked !== null)
						? "asked"
						: "needs",
		};
	}
	return { shown, counts };
}

/** The done lane's visible page: the newest `limit` cards, grown to cover every unread answer so
 * a pinned card can never sit behind the cut. Returns the slice and how many cards stay hidden
 * behind the "Show more" button (0 renders no button). */
export function donePage<T>(
	tasks: readonly T[],
	unread: (t: T) => boolean,
	limit: number,
): { shown: T[]; hidden: number } {
	const lastFresh = tasks.reduce((last, t, i) => (unread(t) ? i : last), -1);
	const cut = Math.max(limit, lastFresh + 1);
	const hidden = Math.max(0, tasks.length - cut);
	// The caller treats the returned array as read-only, so the uncropped branch hands back
	// the input array itself instead of copying it.
	return { shown: hidden > 0 ? tasks.slice(0, cut) : (tasks as T[]), hidden };
}

/** Card facts the queue reorder reads. */
type QueueTask = Pick<
	Task,
	"id" | "stage" | "cancelledAt" | "state" | "queuedAt" | "createdAt"
>;

/** New global queue order after a within-column drop, or null when `dragId` is not queued in `stage`. */
export function reorderIds(
	tasks: readonly QueueTask[],
	stage: Stage,
	dragId: string,
	beforeId: string | null,
): string[] | null {
	const queue = queueOrder(tasks);
	const columnIds = queue.filter((t) => t.stage === stage).map((t) => t.id);
	if (!columnIds.includes(dragId)) return null;
	const next = columnIds.filter((id) => id !== dragId);
	const at = beforeId === null ? next.length : next.indexOf(beforeId);
	next.splice(at < 0 ? next.length : at, 0, dragId);
	return spliceColumn(
		queue.map((t) => t.id),
		columnIds,
		next,
	);
}

/** Slot stages in display order; done is absent because it frees the slot. */
export const SLOT_STAGES = ["todo", "in_progress", "merging"] as const;

/** Slots in use per board stage, for the task-queue widget and the Workflow modal's live line. */
export type SlotCounts = Record<(typeof SLOT_STAGES)[number], number>;

/** One slot per running or preparing, non-cancelled omp process, grouped by stage; done and cancelled free the slot. */
export function slotUse(
	tasks: readonly {
		stage: Stage;
		state: RunState;
		cancelledAt: number | null;
	}[],
): SlotCounts {
	const counts: SlotCounts = { todo: 0, in_progress: 0, merging: 0 };
	for (const t of tasks) {
		if (t.cancelledAt !== null) continue;
		if (t.state !== "running" && t.state !== "preparing") continue;
		// ponytail: a running task with stage done or backlog would break the pie's stage keys; drop it rather than invent a segment.
		if (t.stage === "done" || t.stage === "backlog") continue;
		counts[t.stage] += 1;
	}
	return counts;
}

/** Column display order: non-queued cards first (running/needs_you can never sit below a queued card), then queue priority. */
export function laneOrder<
	T extends Pick<Task, "cancelledAt" | "state" | "queuedAt" | "createdAt">,
>(tasks: readonly T[]): T[] {
	return [
		...tasks.filter((t) => !(t.cancelledAt === null && t.state === "queued")),
		...queueOrder(tasks),
	];
}

/** Map a within-column resequencing (`next`, a permutation of `columnIds`) onto the global id list, keeping all other slots. */
export function spliceColumn(
	globalIds: readonly string[],
	columnIds: readonly string[],
	next: readonly string[],
): string[] {
	const incoming = [...next];
	// `next` is a permutation of `columnIds`, so shift() is defined for every hit; ?? keeps a stray id in place.
	return globalIds.map((id) =>
		columnIds.includes(id) ? (incoming.shift() ?? id) : id,
	);
}

/** The gap under the pointer, or no new slot when it borders the dragged card's old place. */
export function dropBeforeId(
	cards: readonly { id: string; middle: number }[],
	dragId: string,
	y: number,
): string | null | undefined {
	const origin = cards.findIndex((card) => card.id === dragId);
	if (origin < 0) return undefined;
	const others = cards.filter((card) => card.id !== dragId);
	const before = others.find((card) => y < card.middle)?.id ?? null;
	return before === (others[origin]?.id ?? null) ? undefined : before;
}
