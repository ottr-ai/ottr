import { expect, test } from "bun:test";
import { ARCH_REVIEW_MARKER } from "../prompts.ts";
import type { TaskCard } from "../types.ts";
import {
	alarmLabel,
	cardMark,
	holdFor,
	splitAlarms,
	statusLine,
	strykerProgress,
	strykerStats,
} from "./status.ts";

const t = (
	overrides: Partial<Parameters<typeof statusLine>[0]> = {},
): Parameters<typeof statusLine>[0] => ({
	state: "queued",
	stage: "todo",
	needsReason: null,
	pendingPrompt: null,
	asked: null,
	...overrides,
});

test("statusLine queued precedence: needsReason beats everything", () => {
	expect(statusLine(t({ needsReason: "exit 1" }), true)).toBe("resuming");
	expect(
		statusLine(t({ needsReason: "exit 1", pendingPrompt: "hi" }), false),
	).toBe("resuming");
});

test("statusLine queued with pendingPrompt waits for a slot", () => {
	expect(statusLine(t({ pendingPrompt: "hi" }), false)).toBe(
		"reply queued · waits for a free slot",
	);
});

test("statusLine queued todo depends on hasRules", () => {
	expect(statusLine(t(), false)).toBe("waiting for rules");
	expect(statusLine(t(), true)).toBe("queued");
});

test("statusLine queued merging shows hold only when present", () => {
	expect(statusLine(t({ stage: "merging" }), true, "blocked by X")).toBe(
		"blocked by X",
	);
	expect(statusLine(t({ stage: "merging" }), true, null)).toBe("queued");
});

test("statusLine names the update restart while drained", () => {
	expect(statusLine(t(), true, null, true)).toBe(
		"waiting for the update restart",
	);
	expect(statusLine(t({ pendingPrompt: "hi" }), false, null, true)).toBe(
		"reply queued · waits for the update restart",
	);
	// Per-card reasons outrank the drain: the rules gate, a hold, a resume reason.
	expect(statusLine(t(), false, null, true)).toBe("waiting for rules");
	expect(statusLine(t({ stage: "merging" }), true, "blocked by X", true)).toBe(
		"blocked by X",
	);
	expect(statusLine(t({ needsReason: "exit 1" }), true, null, true)).toBe(
		"resuming",
	);
	// Without a drain the old words stay.
	expect(statusLine(t(), true)).toBe("queued");
});

test("statusLine queued todo shows hold, rules gate outranks", () => {
	expect(statusLine(t({ stage: "todo" }), true, "waiting for M1")).toBe(
		"waiting for M1",
	);
	expect(statusLine(t({ stage: "todo" }), false, "waiting for M1")).toBe(
		"waiting for rules",
	);
});

test("statusLine queued in_progress and merging show their hold", () => {
	expect(
		statusLine(t({ stage: "in_progress" }), true, "waiting for #a1 card a1"),
	).toBe("waiting for #a1 card a1");
	expect(
		statusLine(t({ stage: "merging" }), true, "waiting for #a1 card a1"),
	).toBe("waiting for #a1 card a1");
});

test("statusLine backlog cards", () => {
	expect(statusLine(t({ stage: "backlog", state: "idle" }), true)).toBe(
		"in backlog",
	);
	expect(statusLine(t({ stage: "backlog" }), true)).toBe("grill queued");
});

test("statusLine non-queued states", () => {
	expect(statusLine(t({ state: "preparing" }), false)).toBe("preparing");
	expect(statusLine(t({ state: "running" }), false)).toBe("running");
	// Only asked !== null matters, so the empty array stands for an outstanding ask.
	expect(statusLine(t({ state: "needs_you", asked: [] }), false)).toBe(
		"question asked",
	);
	expect(statusLine(t({ state: "needs_you", asked: null }), false)).toBe(
		"action required",
	);
	// idle with a reason is a release card parked while its review's findings land.
	expect(
		statusLine(
			t({
				state: "idle",
				stage: "merging",
				needsReason: "waiting for the review's findings to be implemented",
			}),
			false,
		),
	).toBe("waiting for the review's findings to be implemented");
	// Plain idle is the only other RunState; it always renders "done".
	expect(statusLine(t({ state: "idle" }), false)).toBe("done");
});

test("cardMark: only a done card earns the check; a parked release waits", () => {
	// The release card parked at merging while its review's findings land (needsReason set).
	expect(cardMark(t({ state: "idle", stage: "merging" }))).toBe("queued");
	expect(cardMark(t({ state: "idle", stage: "done" }))).toBe("done");
	expect(cardMark(t({ state: "queued", stage: "merging" }))).toBe("queued");
	expect(cardMark(t({ state: "needs_you", asked: [] }))).toBe("asked");
	expect(cardMark(t({ state: "needs_you" }))).toBe("needs");
	expect(cardMark(t({ state: "preparing" }))).toBe("preparing");
});

const card = (over: Partial<TaskCard>): TaskCard =>
	({
		id: "t1",
		kind: "work",
		title: "Task one",
		prompt: "work",
		project: "proj",
		state: "queued",
		stage: "todo",
		cancelledAt: null,
		createdAt: 0,
		doneAt: null,
		dependsOn: [],
		releaseVersion: null,
		followUpOf: null,
		asked: null,
		...over,
	}) as TaskCard;

const MERGE_HOLD = "waiting for the review to finish";
const review = (over: Partial<TaskCard> = {}): TaskCard =>
	card({
		id: "r1",
		kind: "review",
		prompt: `${ARCH_REVIEW_MARKER} review`,
		...over,
	});

test("holdFor: merges show the merge gate, todos their dependencies in any lane", () => {
	// The dependency sits in Merging, not in the waiting card's own lane.
	const a1 = card({ id: "a1", title: "card a1", stage: "merging" });
	const b2 = card({ id: "b2", title: "card b2", stage: "done", state: "idle" });
	const live = review({ stage: "in_progress", state: "running" });
	const project = [live, a1, b2];
	expect(holdFor(card({ dependsOn: ["a1", "b2"] }), project)).toBe(
		"waiting for #a1 card a1",
	);
	expect(holdFor(card({ dependsOn: ["b2"] }), project)).toBeNull();
	expect(holdFor(card({ stage: "merging" }), [a1, b2])).toBeNull();
	// A started card still waits on its unfinished dependencies.
	expect(
		holdFor(card({ stage: "in_progress", dependsOn: ["a1"] }), project),
	).toBe("waiting for #a1 card a1");
	// A merging card with no open review shows its dependency hold.
	expect(holdFor(card({ stage: "merging", dependsOn: ["a1"] }), [a1, b2])).toBe(
		"waiting for #a1 card a1",
	);
	// The review gate outranks the dependency hold.
	expect(holdFor(card({ stage: "merging", dependsOn: ["a1"] }), project)).toBe(
		MERGE_HOLD,
	);
	// A done card never holds.
	expect(
		holdFor(card({ stage: "done", state: "idle", dependsOn: ["a1"] }), project),
	).toBeNull();
});

test("holdFor todo reads the dependency from the full list, not its own lane", () => {
	// The dependency runs in another lane; the todo's own lane list would miss it.
	const running = card({
		id: "m1",
		title: "First",
		stage: "merging",
		state: "running",
	});
	const todo = card({ id: "m2", title: "Second", dependsOn: ["m1"] });
	expect(holdFor(todo, [running, todo])).toBe("waiting for #m1 First");
	// No deps: a live review's merge hold must not leak onto the todo card.
	const plain = card({ id: "m3", title: "Third" });
	const live = review({ stage: "in_progress", state: "running" });
	expect(holdFor(plain, [live, running, plain])).toBeNull();
	// A dependency already done or cancelled holds nothing.
	const doneDep = card({
		id: "m4",
		title: "Done dep",
		stage: "done",
		state: "idle",
	});
	const follower = card({ id: "m5", title: "Fifth", dependsOn: ["m4"] });
	expect(holdFor(follower, [doneDep, follower])).toBeNull();
});

test("holdFor merging: an open review holds the other merges, never its findings", () => {
	const open = review({ stage: "in_progress", state: "running" });
	const merge = card({ id: "m1", stage: "merging", state: "queued" });
	expect(holdFor(merge, [open, merge])).toBe(MERGE_HOLD);
	// create_task links a finding to its review; its merge never waits for that review.
	const finding = card({ id: "f1", stage: "merging", followUpOf: "r1" });
	expect(holdFor(finding, [open, finding])).toBeNull();
	expect(holdFor(merge, [merge])).toBeNull();
});

test("holdFor never holds a card outside todo and merging", () => {
	const live = review({ stage: "in_progress", state: "running" });
	const release = card({ stage: "in_progress", state: "idle" });
	expect(holdFor(release, [live, release])).toBeNull();
	const done = card({ stage: "done", state: "idle" });
	expect(holdFor(done, [live, done])).toBeNull();
});

test("splitAlarms splits plain needs from asks and counts preparing as running", () => {
	const need = card({ id: "n1", state: "needs_you" });
	const ask = card({ id: "n2", state: "needs_you", asked: [] });
	const live = card({ id: "n3", state: "running" });
	const prep = card({ id: "n4", state: "preparing" });
	const quiet = card({ id: "n5", state: "queued" });
	const split = splitAlarms([need, ask, live, prep, quiet]);
	expect(split.needs.map((x) => x.id)).toEqual(["n1"]);
	expect(split.asks.map((x) => x.id)).toEqual(["n2"]);
	expect(split.running.map((x) => x.id)).toEqual(["n3", "n4"]);
});

test("alarmLabel singular, plural, and empty", () => {
	expect(alarmLabel(1, 0)).toBe("1 task needs action");
	expect(alarmLabel(2, 1)).toBe("2 tasks need action · 1 question asked");
	expect(alarmLabel(0, 2)).toBe("2 questions asked");
	expect(alarmLabel(0, 0)).toBe("");
});

test("strykerProgress splits pct, tested/total, and the stats tail", () => {
	expect(
		strykerProgress(
			"Stryker 68% · 4454/6523 · 38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
		),
	).toEqual({
		tool: "Stryker",
		pct: 68,
		tested: 4454,
		total: 6523,
		rest: "38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left",
	});
	expect(strykerProgress("Stryker 0% · 0/6523 · ~0h 0m elapsed")).toEqual({
		tool: "Stryker",
		pct: 0,
		tested: 0,
		total: 6523,
		rest: "~0h 0m elapsed",
	});
});

test("strykerProgress parses mutate.py lines, with and without a survived count", () => {
	expect(
		strykerProgress("mutate.py 17% · 20/116 · 2 survived (10.0%)"),
	).toEqual({
		tool: "mutate.py",
		pct: 17,
		tested: 20,
		total: 116,
		rest: "2 survived (10.0%)",
	});
	expect(strykerProgress("mutate.py 17% · 20/116")).toEqual({
		tool: "mutate.py",
		pct: 17,
		tested: 20,
		total: 116,
		rest: "",
	});
});

test("strykerProgress returns null for text with no numbers", () => {
	expect(strykerProgress(null)).toBeNull();
	expect(strykerProgress(undefined)).toBeNull();
	expect(strykerProgress("running")).toBeNull();
	expect(strykerProgress("mutate.py running")).toBeNull();
	expect(strykerProgress("reply queued · waits for a free slot")).toBeNull();
});

test("strykerStats splits the stats tail into readout rows", () => {
	expect(
		strykerStats("38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left"),
	).toEqual([
		{ label: "Survived", value: "38 (0.9%)" },
		{ label: "Elapsed", value: "~2h 59m" },
		{ label: "Left", value: "~1h 23m" },
	]);
	expect(strykerStats("2 timed out · 4454/6523")).toEqual([
		{ label: "Timed out", value: "2" },
		{ label: "", value: "4454/6523" },
	]);
	expect(strykerStats("")).toEqual([]);
});
