import { queueOrder } from "../scheduler.ts";
import type { RunState, Stage, Task, TaskCard } from "../types.ts";
import { doneReadKey, recommendsSteps } from "../types.ts";

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
	| "cancelledAt"
	| "asked"
	| "answered"
	| "kind"
	| "research"
	| "steps"
>;

/** Cards a read mark can stick to: answered question cards, PR review cards, and done research
 * cards with a resolved steps report. A cancelled card is final: no read mark, no unread badge
 * (the server's seenableIds drops it too). */
export function seenable(
	t: Pick<
		TaskCard,
		"answered" | "cancelledAt" | "kind" | "stage" | "research" | "steps"
	>,
): boolean {
	return (
		t.cancelledAt === null &&
		(t.answered === true ||
			t.kind === "pr_review" ||
			(t.research && t.stage === "done" && t.steps !== "unknown"))
	);
}

/** Unread: has something to read and no read mark yet. */
export function isUnread(
	t: Pick<
		TaskCard,
		"id" | "answered" | "cancelledAt" | "kind" | "stage" | "research" | "steps"
	>,
	seen: ReadonlySet<string>,
): boolean {
	return seenable(t) && !seen.has(t.id);
}

/** OTTR-488 resolution: how a card's research report treats steps. 'yes' = steps report (pinned until a drawer button clears it), 'no' = pure info (pinned until opened), 'quiet' = nothing to pin (legacy report without steps, or no report). Server views ship resolved steps (app.ts viewSteps), so cards normally carry the stored value; the regex fallback covers direct TaskView reads and keeps the table testable. */
export function researchSteps(t: {
	steps: Task["steps"];
	report?: string | null;
}): "yes" | "no" | "quiet" {
	if (t.steps === "yes") return "yes";
	if (t.steps === "no") return "no";
	return t.report != null && recommendsSteps(t.report) ? "yes" : "quiet";
}

/** OTTR-488: opening a card marks it read — except a steps report, which only its drawer buttons clear ('Implement steps' / 'No further steps'). */
export function autoMarkOnOpen(
	t: Pick<
		TaskCard,
		"answered" | "cancelledAt" | "kind" | "stage" | "research" | "steps"
	>,
): boolean {
	return seenable(t) && researchSteps(t) !== "yes";
}

/** OTTR-566: a done card whose opening counts as a read for the rail's unread dot. Cancelled and
 * retro cards never count; cards done at or before the server's baseline (`since`) count as read,
 * so the feature does not light every project with history on first load. */
export function doneReadable(
	t: Pick<TaskCard, "stage" | "cancelledAt" | "kind" | "state" | "doneAt">,
	since: number,
): boolean {
	return (
		t.stage === "done" &&
		t.cancelledAt === null &&
		// Retro cards never count, even the on-board kinds (running, needs_you): the
		// unread-done dot is for work cards only, so the retro check stays direct.
		t.kind !== "retro" &&
		t.doneAt !== null &&
		t.doneAt > since
	);
}

/** OTTR-566: a newly done card nobody has opened yet (drives the rail's steel dot). OTTR-827: the
 * dot counts a card only when its face shows the New badge's content (seenable) — a merged work
 * card, quiet research, a retro or a cancelled card shows nothing, so it never lights the dot.
 * The read mark is keyed by completion (`id@doneAt`), so a card that returns to Done is unread
 * again; opening marks both this key and the plain id, so the marks move together. */
export function doneUnread(
	t: Pick<
		TaskCard,
		| "id"
		| "answered"
		| "cancelledAt"
		| "kind"
		| "stage"
		| "research"
		| "steps"
		| "state"
		| "doneAt"
	>,
	seen: ReadonlySet<string>,
	since: number,
): boolean {
	return (
		doneReadable(t, since) &&
		seenable(t) &&
		t.doneAt !== null &&
		!seen.has(doneReadKey({ id: t.id, doneAt: t.doneAt }))
	);
}

/** The one mark a rail row shows, by rank: needs action > asked > running > unread done. */
export function railTop(c: {
	needs: number;
	asks: number;
	running: number;
	unread: number;
}): "needs" | "asked" | "running" | "unread" | null {
	if (c.needs > 0) return "needs";
	if (c.asks > 0) return "asked";
	if (c.running > 0) return "running";
	if (c.unread > 0) return "unread";
	return null;
}

const STAGES = [
	"todo",
	"in_progress",
	"merging",
	"done",
	"backlog",
] as const satisfies readonly Stage[];

/** Per-stage board numbers: the lane-head badges and the non-done tab badges. */
export type LaneCount = {
	/** Cards matching the search filter. */
	shown: number;
	/** All cards in the stage, ignoring the filter. */
	total: number;
	/** Done only: cards not opened yet (answers, PR reviews). */
	fresh: number;
	/** needs_you cards, ignoring the filter: an alarm must not hide behind the search box. */
	waiting: number;
	/** null while nothing waits; "asked" while every waiting card has its question out. */
	alarm: "needs" | "asked" | null;
};

/** The lane a card shows in: a kicked backlog card (grill session queued/running/needs_you) joins the todo flow; the backlog row keeps parked ideas only.
 * A cancelled card settles in the done lane with its "Cancelled" chip; no other lane shows it. */
export function laneStage(
	t: Pick<Task, "cancelledAt" | "stage" | "state">,
): Stage {
	if (t.cancelledAt !== null) return "done";
	return t.stage === "backlog" && t.state !== "idle" ? "todo" : t.stage;
}

/** A card the board lanes list. A retro card runs visibly in its lane (Todo, In progress,
 * Merging) and hides only in Done, where its source card's Work steps already carry it; a
 * cancelled retro settles in Done too, so it hides as well. A retro that needs the user stays
 * visible in every lane: a hidden question would hide waiting work. */
export function onBoard(
	t: Pick<TaskCard, "kind" | "state" | "cancelledAt" | "stage">,
): boolean {
	return (
		t.kind !== "retro" || t.state === "needs_you" || laneStage(t) !== "done"
	);
}

/** The board's search filter plus per-stage counts: the shown list for the lanes, counts for tab strip and lane heads.
 * Cards off the board (see onBoard) are in neither the shown list nor any count. */
export function laneCounts<T extends LaneTask>(
	tasks: readonly T[],
	query: string,
	seen: ReadonlySet<string>,
): { shown: T[]; counts: Record<Stage, LaneCount> } {
	const board = tasks.filter(onBoard);
	const q = query.trim().toLowerCase();
	// Contains match on the id, what the card shows, plus the full prompt and latest summary.
	const shown =
		q === ""
			? board
			: board.filter((t) =>
					`${t.id}\n${t.sessionTitle || t.title}\n${t.prompt}\n${t.summary ?? ""}`
						.toLowerCase()
						.includes(q),
				);
	const counts = {} as Record<Stage, LaneCount>;
	for (const stage of STAGES) {
		const visible = shown.filter((t) => laneStage(t) === stage);
		const waiting = board.filter(
			(t) => laneStage(t) === stage && t.state === "needs_you",
		);
		counts[stage] = {
			shown: visible.length,
			total: board.filter((t) => laneStage(t) === stage).length,
			fresh:
				stage === "done" ? visible.filter((t) => isUnread(t, seen)).length : 0,
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

/** The done lane's visible page: the newest `limit` cards, grown to cover every pinned card (unread
 * answers and starred cards) so a pinned card never sits behind the cut. Returns the slice and how
 * many cards stay hidden behind the "Show more" button (0 renders no button). */
export function donePage<T>(
	tasks: readonly T[],
	pinned: (t: T) => boolean,
	limit: number,
): { shown: T[]; hidden: number } {
	const lastFresh = tasks.reduce((last, t, i) => (pinned(t) ? i : last), -1);
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
