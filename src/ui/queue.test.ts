import { describe, expect, test } from "bun:test";
import type { AskQuestion, RunState, Stage, TaskCard } from "../types.ts";
import {
	donePage,
	dropBeforeId,
	laneCounts,
	laneOrder,
	laneStage,
	reorderIds,
	slotUse,
	spliceColumn,
} from "./queue.ts";

const t = (
	stage: Stage,
	state: RunState,
	cancelledAt: number | null = null,
	queuedAt: number | null = null,
	createdAt = 0,
) => ({ stage, state, cancelledAt, queuedAt, createdAt });

/** A card with the fields laneCounts reads; extras mirror the TaskCard facts. */
const card = (
	id: string,
	stage: Stage,
	state: RunState,
	over: Partial<
		Pick<
			TaskCard,
			"title" | "sessionTitle" | "prompt" | "summary" | "asked" | "answered"
		>
	> = {},
) => ({
	id,
	stage,
	state,
	title: over.title ?? `Task ${id}`,
	sessionTitle: over.sessionTitle ?? "",
	prompt: over.prompt ?? "",
	summary: over.summary ?? null,
	asked: over.asked ?? null,
	answered: over.answered ?? false,
});

test("slotUse counts running tasks per stage", () => {
	expect(
		slotUse([
			t("todo", "queued"),
			t("todo", "running"),
			t("in_progress", "running"),
			t("in_progress", "needs_you"),
			t("merging", "running"),
			t("merging", "preparing"),
			t("done", "idle"),
		]),
	).toEqual({ todo: 1, in_progress: 1, merging: 2 });
});

test("slotUse skips cancelled and non-running tasks", () => {
	expect(
		slotUse([
			t("in_progress", "running", 123),
			t("merging", "queued"),
			t("todo", "running"),
		]),
	).toEqual({
		todo: 1,
		in_progress: 0,
		merging: 0,
	});
});

test("slotUse counts preparing and skips cancelled preparing tasks", () => {
	expect(
		slotUse([t("todo", "preparing"), t("in_progress", "preparing", 7)]),
	).toEqual({ todo: 1, in_progress: 0, merging: 0 });
});

test("laneOrder puts non-queued first, then queued in queue priority", () => {
	// queuedAt ?? createdAt fallback: q3 has no queuedAt and falls back to createdAt.
	const tasks = [
		t("todo", "queued", null, 30),
		t("in_progress", "running"),
		t("todo", "queued", null, null, 10),
		t("merging", "needs_you"),
		t("todo", "queued", null, 20),
	];
	expect(laneOrder(tasks).map((x) => x.state)).toEqual([
		"running",
		"needs_you",
		"queued",
		"queued",
		"queued",
	]);
});

test("laneOrder tie-breaks equal queuedAt on createdAt", () => {
	const tasks = [
		t("todo", "queued", null, 5, 20),
		t("todo", "queued", null, 5, 10),
	];
	expect(laneOrder(tasks).map((x) => x.createdAt)).toEqual([10, 20]);
});

test("spliceColumn replaces only column ids with the resequencing", () => {
	expect(
		spliceColumn(["a", "b", "c", "d"], ["a", "c", "d"], ["d", "a", "c"]),
	).toEqual(["d", "b", "a", "c"]);
});

test("laneCounts counts a backlog card under counts.backlog", () => {
	const tasks = [card("t1", "todo", "queued"), card("t2", "backlog", "idle")];
	const { shown, counts } = laneCounts(tasks, "", new Set());
	expect(counts.backlog).toEqual({
		shown: 1,
		total: 1,
		fresh: 0,
		waiting: 0,
		alarm: null,
	});
	// Backlog cards stay in shown; the todo lane filters them out for its own list.
	expect(shown.filter((t) => t.stage === "backlog")).toHaveLength(1);
	// The filter applies to backlog like any stage.
	const filtered = laneCounts(tasks, "t2", new Set());
	expect(filtered.counts.backlog.shown).toBe(1);
	expect(filtered.counts.todo.shown).toBe(0);
});

test("laneStage moves a started backlog card into the todo flow", () => {
	const parked = { stage: "backlog", state: "idle" } as const;
	const running = { stage: "backlog", state: "running" } as const;
	const waiting = { stage: "backlog", state: "needs_you" } as const;
	expect(laneStage(parked)).toBe("backlog");
	expect(laneStage(running)).toBe("todo");
	expect(laneStage(waiting)).toBe("todo");
});

test("laneCounts counts a started backlog card with the todo flow", () => {
	const tasks = [
		card("t1", "backlog", "idle"),
		card("t2", "backlog", "running"),
		card("t3", "backlog", "needs_you", { asked: [{}] as AskQuestion[] }),
	];
	const { counts } = laneCounts(tasks, "", new Set());
	// The parked row keeps the idle idea only.
	expect(counts.backlog).toEqual({
		shown: 1,
		total: 1,
		fresh: 0,
		waiting: 0,
		alarm: null,
	});
	// Started cards count with todo; a waiting grill session raises the alarm.
	expect(counts.todo).toEqual({
		shown: 2,
		total: 2,
		fresh: 0,
		waiting: 1,
		alarm: "asked",
	});
});

test("drag slot follows card midpoints and skips the old position", () => {
	const cards = [
		{ id: "a", middle: 30 },
		{ id: "b", middle: 90 },
		{ id: "c", middle: 150 },
		{ id: "d", middle: 210 },
	];
	expect(dropBeforeId(cards, "b", 20)).toBe("a");
	expect(dropBeforeId(cards, "b", 35)).toBeUndefined(); // directly above old slot
	expect(dropBeforeId(cards, "b", 130)).toBeUndefined(); // directly below old slot
	expect(dropBeforeId(cards, "b", 170)).toBe("d");
	expect(
		dropBeforeId([...cards.slice(0, 3), { id: "d", middle: 276 }], "b", 220),
	).toBe("d"); // shifted target stays selected
	expect(dropBeforeId(cards, "b", 230)).toBeNull();
	expect(dropBeforeId(cards, "d", 230)).toBeUndefined(); // source is last
});

test("laneCounts filters by query across id, titles, prompt and summary", () => {
	const tasks = [
		card("t1", "todo", "queued", { title: "Extract logic", prompt: "move it" }),
		card("t2", "in_progress", "running", { summary: "parser done" }),
	];
	expect(laneCounts(tasks, "", new Set()).shown).toHaveLength(2);
	const { shown } = laneCounts(tasks, "LOGI", new Set());
	expect(shown.map((t) => t.id)).toEqual(["t1"]);
	expect(laneCounts(tasks, "parser", new Set()).shown.map((t) => t.id)).toEqual(
		["t2"],
	);
	expect(laneCounts(tasks, "  parse  ", new Set()).shown).toHaveLength(1);
	expect(laneCounts(tasks, "nomatch", new Set()).shown).toHaveLength(0);
});

test("laneCounts counts shown, total, fresh and waiting per stage", () => {
	const seen = new Set(["t3"]);
	const tasks = [
		card("t1", "todo", "queued"),
		card("t2", "todo", "running", { title: "wrong" }),
		card("t3", "done", "idle", { answered: true }), // opened: not fresh
		card("t4", "done", "idle", { answered: true }), // unopened: fresh
	];
	const { counts } = laneCounts(tasks, "", seen);
	expect(counts.todo).toEqual({
		shown: 2,
		total: 2,
		fresh: 0,
		waiting: 0,
		alarm: null,
	});
	expect(counts.done).toEqual({
		shown: 2,
		total: 2,
		fresh: 1,
		waiting: 0,
		alarm: null,
	});
	// Fresh follows the filter while total ignores it.
	expect(laneCounts(tasks, "t1", seen).counts.done).toMatchObject({
		shown: 0,
		total: 2,
		fresh: 0,
	});
});

test("laneCounts keeps waiting and alarm search-unfiltered", () => {
	const tasks = [
		card("t1", "todo", "needs_you", { asked: null }), // plain needs: alarm "needs"
		card("t2", "todo", "needs_you", {
			asked: [{ question: "q", options: [], multi: false, recommended: null }],
		}),
		card("t3", "merging", "needs_you", { asked: null }),
	];
	const { counts } = laneCounts(tasks, "nothing-matches-this", new Set());
	expect(counts.todo).toMatchObject({ shown: 0, waiting: 2, alarm: "needs" });
	expect(counts.merging).toMatchObject({
		shown: 0,
		waiting: 1,
		alarm: "needs",
	});
	// Every waiting card holding its question out upgrades the alarm to "asked".
	const allAsked = [
		card("t4", "in_progress", "needs_you", {
			asked: [{ question: "q", options: [], multi: false, recommended: null }],
		}),
	];
	expect(laneCounts(allAsked, "", new Set()).counts.in_progress.alarm).toBe(
		"asked",
	);
});

test("reorderIds splices a within-column drop into the global queue order", () => {
	const tasks = [
		{ ...t("todo", "queued", null, 10), id: "t1" },
		{ ...t("in_progress", "running"), id: "t2" },
		{ ...t("todo", "queued", null, 20), id: "t3" },
		{ ...t("todo", "queued", null, 30), id: "t4" },
		{ ...t("merging", "queued", null, 40), id: "t5" },
	];
	// Global order by queue priority: t1, t3, t4, t5. Moving t4 ahead of t1 keeps t3 and the other lane.
	expect(reorderIds(tasks, "todo", "t4", "t1")).toEqual([
		"t4",
		"t1",
		"t3",
		"t5",
	]);
	// A null beforeId appends to the lane end.
	expect(reorderIds(tasks, "todo", "t1", null)).toEqual([
		"t3",
		"t4",
		"t1",
		"t5",
	]);
	// Dropping a card directly above its old slot leaves the order untouched.
	expect(reorderIds(tasks, "todo", "t1", "t3")).toEqual([
		"t1",
		"t3",
		"t4",
		"t5",
	]);
	// A running card is not in the queue, so there is nothing to reorder.
	expect(reorderIds(tasks, "in_progress", "t2", "t1")).toBeNull();
});

describe("donePage", () => {
	const n = (count: number): string[] =>
		Array.from({ length: count }, (_, i) => `t${i}`);
	const noUnread = (): boolean => false;

	test("a short lane stays whole with nothing hidden", () => {
		const tasks = n(20);
		expect(donePage(tasks, noUnread, 20)).toEqual({
			shown: tasks,
			hidden: 0,
		});
	});

	test("a long lane keeps the newest page and counts the rest", () => {
		const page = donePage(n(45), noUnread, 20);
		expect(page.shown).toEqual(n(20));
		expect(page.hidden).toBe(25);
	});

	test("the cut grows to cover the last unread answer", () => {
		const tasks = n(45);
		const page = donePage(tasks, (t) => t === "t30", 20);
		expect(page.shown).toEqual(n(31));
		expect(page.hidden).toBe(14);
	});

	test("an unread answer inside the page changes nothing", () => {
		const page = donePage(n(45), (t) => t === "t5", 20);
		expect(page.shown).toEqual(n(20));
		expect(page.hidden).toBe(25);
	});
});
