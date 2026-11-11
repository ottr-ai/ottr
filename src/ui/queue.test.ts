import { describe, expect, test } from "bun:test";
import type { AskQuestion, RunState, Stage, TaskCard } from "../types.ts";
import { doneReadKey } from "../types.ts";
import {
	autoMarkOnOpen,
	donePage,
	doneReadable,
	doneUnread,
	dropBeforeId,
	isUnread,
	laneCounts,
	laneOrder,
	laneStage,
	railTop,
	reorderIds,
	researchSteps,
	seenable,
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
			| "title"
			| "sessionTitle"
			| "prompt"
			| "summary"
			| "cancelledAt"
			| "asked"
			| "answered"
			| "kind"
			| "research"
			| "steps"
		>
	> = {},
) => ({
	id,
	stage,
	state,
	cancelledAt: over.cancelledAt ?? null,
	title: over.title ?? `Task ${id}`,
	sessionTitle: over.sessionTitle ?? "",
	prompt: over.prompt ?? "",
	summary: over.summary ?? null,
	asked: over.asked ?? null,
	answered: over.answered ?? false,
	kind: over.kind ?? "work",
	research: over.research ?? false,
	steps: over.steps ?? "unknown",
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

test("laneStage parks a cancelled card in the done lane, whatever its old stage", () => {
	expect(
		laneStage({ stage: "in_progress", state: "idle", cancelledAt: 5 }),
	).toBe("done");
	expect(laneStage({ stage: "merging", state: "idle", cancelledAt: 5 })).toBe(
		"done",
	);
	expect(laneStage({ stage: "backlog", state: "idle", cancelledAt: 5 })).toBe(
		"done",
	);
	expect(laneStage({ stage: "done", state: "idle", cancelledAt: 5 })).toBe(
		"done",
	);
});

test("a cancelled card counts in no lane total but the done one, and never as fresh", () => {
	const tasks = [
		card("live", "in_progress", "running"),
		card("dead", "in_progress", "idle", { cancelledAt: 5, answered: true }),
	];
	const { shown, counts } = laneCounts(tasks, "", new Set());
	// The live card keeps its lane; the cancelled one rides with done only.
	expect(counts.in_progress.total).toBe(1);
	expect(counts.done.total).toBe(1);
	// An answer on a cancelled card is final: no unread badge, no alarm.
	expect(counts.done.fresh).toBe(0);
	expect(counts.in_progress.waiting).toBe(0);
	expect(shown).toHaveLength(2);
});

test("a cancelled card is never seenable, so never unread", () => {
	const dead = card("dead", "done", "idle", { cancelledAt: 5, answered: true });
	expect(seenable(dead)).toBe(false);
	expect(isUnread(dead, new Set())).toBe(false);
	// The live twin keeps its badge behavior.
	const live = card("live", "done", "idle", { answered: true });
	expect(seenable(live)).toBe(true);
	expect(isUnread(live, new Set())).toBe(true);
});

test("researchSteps resolves the stored steps value first, then falls back to the report regex", () => {
	// Stored values from the harvest pass through.
	expect(researchSteps({ steps: "yes" })).toBe("yes");
	expect(researchSteps({ steps: "no" })).toBe("no");
	// 'unknown' falls back to the legacy regex: a matching report resurfaces as a
	// steps report, a non-matching one or no report stays quiet.
	expect(
		researchSteps({
			steps: "unknown",
			report: "## Recommended steps\n\n1. Do it",
		}),
	).toBe("yes");
	expect(
		researchSteps({
			steps: "unknown",
			report: "Our recommended steps are listed below.",
		}),
	).toBe("yes");
	expect(
		researchSteps({
			steps: "unknown",
			report: "## Short answer\n\nThe rack fits as-is.",
		}),
	).toBe("quiet");
	// Cards may omit report: no report, nothing to pin.
	expect(researchSteps({ steps: "unknown" })).toBe("quiet");
	expect(researchSteps({ steps: "unknown", report: null })).toBe("quiet");
});

test("autoMarkOnOpen clears everything on open except a steps report", () => {
	// A steps report pins until its drawer buttons clear it: opening marks nothing.
	expect(
		autoMarkOnOpen(
			card("r1", "done", "idle", { research: true, steps: "yes" }),
		),
	).toBe(false);
	// A pure-info report pins until the drawer is opened, like an answer.
	expect(
		autoMarkOnOpen(card("r2", "done", "idle", { research: true, steps: "no" })),
	).toBe(true);
	// A quiet research card is not seenable, so auto-mark is off.
	expect(
		autoMarkOnOpen(
			card("r3", "done", "idle", { research: true, steps: "unknown" }),
		),
	).toBe(false);
	// Answers keep the old behavior: opening marks them read.
	expect(autoMarkOnOpen(card("q1", "done", "idle", { answered: true }))).toBe(
		true,
	);
	// A cancelled card is final: no read mark at all.
	expect(
		autoMarkOnOpen(
			card("r4", "done", "idle", {
				cancelledAt: 5,
				research: true,
				steps: "yes",
			}),
		),
	).toBe(false);
});

test("seenable pins done research cards with a resolved steps report only", () => {
	expect(
		seenable(card("r1", "done", "idle", { research: true, steps: "yes" })),
	).toBe(true);
	expect(
		seenable(card("r2", "done", "idle", { research: true, steps: "no" })),
	).toBe(true);
	// A view 'unknown' means quiet: the server resolved the regex already, so
	// unknown here is a report-less legacy card, never a hidden steps report.
	expect(
		seenable(card("r3", "done", "idle", { research: true, steps: "unknown" })),
	).toBe(false);
	// Not done yet: a running research card waits in its lane, not the Inbox.
	expect(
		seenable(
			card("r4", "in_progress", "running", { research: true, steps: "yes" }),
		),
	).toBe(false);
	// Cancelled is final, steps or not.
	expect(
		seenable(
			card("r5", "done", "idle", {
				cancelledAt: 5,
				research: true,
				steps: "yes",
			}),
		),
	).toBe(false);
});

test("slotUse frees the slot of a cancelled running card", () => {
	expect(
		slotUse([
			{ stage: "in_progress", state: "running", cancelledAt: 5 },
			{ stage: "merging", state: "running", cancelledAt: null },
		]),
	).toEqual({ todo: 0, in_progress: 0, merging: 1 });
});

test("laneStage moves a started backlog card into the todo flow", () => {
	const parked = {
		stage: "backlog",
		state: "idle",
		cancelledAt: null,
	} as const;
	const running = {
		stage: "backlog",
		state: "running",
		cancelledAt: null,
	} as const;
	const waiting = {
		stage: "backlog",
		state: "needs_you",
		cancelledAt: null,
	} as const;
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

test("laneCounts shows a retro in every lane except Done", () => {
	const tasks = [
		card("r-queued", "todo", "queued", { kind: "retro" }),
		card("r-running", "in_progress", "running", { kind: "retro" }),
		card("r-done", "done", "idle", { kind: "retro" }),
		card("r-cancelled", "merging", "idle", { kind: "retro", cancelledAt: 5 }),
	];
	const { shown, counts } = laneCounts(tasks, "", new Set());
	// The queued and running retros sit in their lanes; a cancelled retro settles
	// in Done and hides like the done one.
	expect(shown.map((t) => t.id)).toEqual(["r-queued", "r-running"]);
	expect(counts.todo.total).toBe(1);
	expect(counts.merging.total).toBe(0);
	expect(counts.done.total).toBe(0);
	expect(counts.in_progress).toEqual({
		shown: 1,
		total: 1,
		fresh: 0,
		waiting: 0,
		alarm: null,
	});
	// A search that matches the running retro finds its card.
	const filtered = laneCounts(tasks, "r-running", new Set());
	expect(filtered.shown.map((t) => t.id)).toEqual(["r-running"]);
	expect(filtered.counts.in_progress.total).toBe(1);
});

test("laneCounts shows a retro that needs the user even in Done", () => {
	const tasks = [
		card("r", "done", "needs_you", {
			kind: "retro",
			asked: [{ question: "q", options: [], multi: false, recommended: null }],
		}),
	];
	const { shown, counts } = laneCounts(tasks, "", new Set());
	expect(shown.map((t) => t.id)).toEqual(["r"]);
	expect(counts.done).toEqual({
		shown: 1,
		total: 1,
		fresh: 0,
		waiting: 1,
		alarm: "asked",
	});
});

test("laneCounts shows a retro that needs the user and counts it as waiting", () => {
	const tasks = [
		card("r", "in_progress", "needs_you", { kind: "retro" }),
		card("r-done", "done", "idle", { kind: "retro" }),
	];
	const { shown, counts } = laneCounts(tasks, "", new Set());
	expect(shown.map((t) => t.id)).toEqual(["r"]);
	expect(counts.in_progress).toEqual({
		shown: 1,
		total: 1,
		fresh: 0,
		waiting: 1,
		alarm: "needs",
	});
	expect(counts.done.total).toBe(0);
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

test("drag slot edges: an unknown card, the first card, and the exact midpoint", () => {
	const cards = [
		{ id: "a", middle: 30 },
		{ id: "b", middle: 90 },
	];
	// A drag id that is not in the list has no slot at all (undefined, not the end slot).
	expect(dropBeforeId(cards, "z", 10)).toBeUndefined();
	// Dragging the first card below every other one lands on the end slot (null, not "no slot").
	expect(dropBeforeId(cards, "a", 100)).toBeNull();
	// A y equal to a card's midpoint sits below it: the boundary is strict.
	expect(dropBeforeId(cards, "b", 30)).toBeUndefined();
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

test("a PR review card counts as unread until opened, like an answered card", () => {
	const tasks = [card("p1", "done", "idle", { kind: "pr_review" })];
	expect(laneCounts(tasks, "", new Set()).counts.done.fresh).toBe(1);
	expect(laneCounts(tasks, "", new Set(["p1"])).counts.done.fresh).toBe(0);
	// A done work card without an answer never counts, even unseen.
	expect(
		laneCounts([card("w1", "done", "idle")], "", new Set()).counts.done.fresh,
	).toBe(0);
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

	test("a starred card older than the limit grows the cut to include it", () => {
		const tasks = n(45);
		// A starred card among the old ones pins like an unread answer: the cut covers it.
		const page = donePage(tasks, (t) => t === "t5" || t === "t30", 20);
		expect(page.shown).toEqual(n(31));
		expect(page.hidden).toBe(14);
	});
});

describe("railTop", () => {
	test("ranks needs > asked > running > unread", () => {
		const z = { needs: 0, asks: 0, running: 0, unread: 0 };
		expect(railTop(z)).toBeNull();
		expect(railTop({ ...z, unread: 2 })).toBe("unread");
		expect(railTop({ ...z, running: 1, unread: 2 })).toBe("running");
		expect(railTop({ ...z, asks: 1, running: 1, unread: 1 })).toBe("asked");
		expect(railTop({ needs: 1, asks: 1, running: 1, unread: 1 })).toBe("needs");
	});
});

describe("doneUnread", () => {
	const since = 1000;
	const done = (
		id: string,
		doneAt: number | null,
		over: Parameters<typeof card>[3] = {},
	) => ({ ...card(id, "done", "idle", over), doneAt });
	test("only post-baseline, uncancelled, on-board seenable done cards count", () => {
		const none = new Set<string>();
		const answered = { answered: true };
		expect(doneUnread(done("a", since, answered), none, since)).toBe(false);
		expect(doneUnread(done("a", since + 1, answered), none, since)).toBe(true);
		expect(doneUnread(done("a", null, answered), none, since)).toBe(false);
		expect(
			doneUnread(
				done("a", since + 1, { ...answered, cancelledAt: 5 }),
				none,
				since,
			),
		).toBe(false);
		expect(
			doneUnread(
				done("a", since + 1, { ...answered, kind: "retro" }),
				none,
				since,
			),
		).toBe(false);
		expect(
			doneUnread(
				{ ...card("a", "todo", "idle", answered), doneAt: since + 1 },
				none,
				since,
			),
		).toBe(false);
		expect(
			doneUnread(
				done("a", since + 1, answered),
				new Set([`a@${since + 1}`]),
				since,
			),
		).toBe(false);
		expect(
			doneUnread(done("a", since + 1, answered), new Set(["a"]), since),
		).toBe(true);
		expect(
			doneUnread(
				done("a", since + 2, answered),
				new Set([`a@${since + 1}`]),
				since,
			),
		).toBe(true);
		expect(doneReadable(done("a", since + 1), since)).toBe(true);
	});
	test("OTTR-827: a card that shows nothing never counts (merged work, quiet research)", () => {
		const none = new Set<string>();
		expect(doneUnread(done("m", since + 1), none, since)).toBe(false);
		expect(
			doneUnread(
				done("m", since + 1),
				new Set([doneReadKey({ id: "m", doneAt: since + 1 })]),
				since,
			),
		).toBe(false);
		expect(
			doneUnread(
				done("q", since + 1, { research: true, steps: "unknown" }),
				none,
				since,
			),
		).toBe(false);
	});
	test("OTTR-827: the rail count equals the number of cards whose face shows New", () => {
		const cards = [
			done("m", since + 1), // merged work card
			done("q", since + 1, { answered: true }), // answered card
			done("p", since + 1, { kind: "pr_review" }), // PR review
			done("r", since + 1, { research: true, steps: "yes" }), // research with steps
			done("s", since + 1, { research: true, steps: "unknown" }), // research without steps
			done("t", since + 1, { kind: "retro" }), // retro
			{ ...done("c", since + 1), cancelledAt: 5 }, // cancelled
		];
		const none = new Set<string>();
		// New badges: the answered card, the PR review, the research report. No badge
		// on a merged card, quiet research, a retro or a cancelled card.
		expect(cards.filter((c) => isUnread(c, none)).map((c) => c.id)).toEqual([
			"q",
			"p",
			"r",
		]);
		// Empty seen set and a fully read set agree: the rail counts exactly the badges.
		const read = new Set([
			...cards.map((c) => c.id),
			...cards.map((c) => doneReadKey({ id: c.id, doneAt: since + 1 })),
		]);
		for (const seen of [none, read]) {
			expect(cards.filter((c) => doneUnread(c, seen, since)).length).toBe(
				cards.filter((c) => isUnread(c, seen)).length,
			);
		}
	});
	test("a steps report's rail dot follows its done key, its Inbox pin the plain id", () => {
		const r = done("r", since + 1, { research: true, steps: "yes" });
		const key = doneReadKey({ id: "r", doneAt: since + 1 });
		expect(doneUnread(r, new Set(), since)).toBe(true);
		expect(doneUnread(r, new Set(["r"]), since)).toBe(true);
		expect(doneUnread(r, new Set([key]), since)).toBe(false);
		expect(isUnread(r, new Set([key]))).toBe(true);
		expect(isUnread(r, new Set(["r"]))).toBe(false);
	});
});
