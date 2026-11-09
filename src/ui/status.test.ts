import { expect, test } from "bun:test";
import { ARCH_REVIEW_MARKER } from "../prompts.ts";
import type { TaskCard } from "../types.ts";
import {
	alarmLabel,
	cardMark,
	etaLeft,
	holdFor,
	holdLeft,
	queuePosition,
	releaseHolding,
	reReleaseOf,
	reviewProgress,
	splitAlarms,
	statusLine,
	strykerProgress,
	strykerStats,
} from "./status.ts";

const t = (
	overrides: Partial<Parameters<typeof statusLine>[0]> = {},
): Parameters<typeof statusLine>[0] => ({
	id: "t1",
	cancelledAt: null,
	state: "queued",
	stage: "todo",
	needsReason: null,
	pendingPrompt: null,
	asked: null,
	holdUntil: null,
	kind: "work",
	releaseVersion: null,
	doneAt: null,
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

test("statusLine and cardMark word a cancelled card", () => {
	// The cancel leaves state idle and the old stage; both word it as cancelled.
	const dead = t({ cancelledAt: 5, state: "idle", stage: "in_progress" });
	expect(statusLine(dead, false)).toBe("cancelled");
	expect(cardMark(dead)).toBe("cancelled");
	// A cancelled done card too: never the plain "done" word or the check.
	const deadDone = t({ cancelledAt: 5, state: "idle", stage: "done" });
	expect(statusLine(deadDone, false)).toBe("cancelled");
	expect(cardMark(deadDone)).toBe("cancelled");
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

test("statusLine queued with a future holdUntil counts down instead of the raw stamp", () => {
	const reason = "usage limit: openai-codex resets 14:00";
	// Half a minute inside the 13m bucket: the floor stays 12m across the two Date.now calls.
	expect(
		statusLine(
			t({
				stage: "in_progress",
				needsReason: reason,
				holdUntil: Date.now() + 13 * 60_000 + 30_000,
			}),
			true,
		),
	).toBe("held · 13m left");
	// The board's own usage-limit sentence names the provider on the label.
	expect(
		statusLine(
			t({
				stage: "in_progress",
				needsReason:
					"The zai usage limit is reached. The board starts the task again after the limit resets at 2026-11-10 11:51 UTC. Send a message to run it now, or cancel the card.",
				holdUntil: Date.now() + 13 * 60_000 + 30_000,
			}),
			true,
		),
	).toBe("held · zai limit · 13m left");
	// The last minute reads "<1m", not until()'s "now".
	expect(
		statusLine(
			t({
				stage: "in_progress",
				needsReason: reason,
				holdUntil: Date.now() + 30_000,
			}),
			true,
		),
	).toBe("held · <1m left");
	expect(
		statusLine(
			t({ stage: "in_progress", needsReason: reason, holdUntil: 1 }),
			true,
		),
	).toBe("resuming");
});

test("holdLeft counts down in the shared until format, null once due", () => {
	const now = 1_790_683_200_000;
	expect(holdLeft(now + 12 * 60_000 + 30_000, now)).toBe("held · 12m left");
	expect(holdLeft(now + 90 * 60_000, now)).toBe("held · 1h 30m left");
	// The last minute: until() floors to "now", which reads wrong while held.
	expect(holdLeft(now + 30_000, now)).toBe("held · <1m left");
	expect(holdLeft(now + 59_999, now)).toBe("held · <1m left");
	expect(holdLeft(now + 60_000, now)).toBe("held · 1m left");
	expect(holdLeft(now, now)).toBeNull();
	expect(holdLeft(now - 1, now)).toBeNull();
});

test("holdLeft names the provider the board's usage-limit reason carries", () => {
	const now = 1_790_683_200_000;
	const zai =
		"The zai usage limit is reached. The board starts the task again after the limit resets at 2026-11-10 11:51 UTC. Send a message to run it now, or cancel the card.";
	expect(holdLeft(now + 90 * 60_000, now, zai)).toBe(
		"held · zai limit · 1h 30m left",
	);
	// The last minute keeps the name.
	expect(holdLeft(now + 30_000, now, zai)).toBe("held · zai limit · <1m left");
	// A cause the board did not write as a usage-limit sentence stays unnamed.
	expect(
		holdLeft(
			now + 90 * 60_000,
			now,
			"An open prompt edit holds the card and every close path releases it.",
		),
	).toBe("held · 1h 30m left");
	expect(holdLeft(now + 90 * 60_000, now, null)).toBe("held · 1h 30m left");
});

test("queuePosition reads the card's queueOrder slot", () => {
	// Earlier queuedAt runs first, so q2 is #1.
	const q1 = card({ id: "q1", state: "queued", queuedAt: 20 });
	const q2 = card({ id: "q2", state: "queued", queuedAt: 10 });
	const run = card({ id: "r9", state: "running", stage: "in_progress" });
	expect(queuePosition([run, q1, q2], q2)).toBe("#1 in queue");
	expect(queuePosition([run, q1, q2], q1)).toBe("#2 in queue");
	// Running, cancelled and unknown cards have no slot.
	expect(queuePosition([run, q1, q2], run)).toBeNull();
	expect(
		queuePosition(
			[run, q1, q2],
			card({ id: "zz", state: "queued", cancelledAt: 5 }),
		),
	).toBeNull();
	expect(queuePosition([], card({ id: "q3", state: "queued" }))).toBeNull();
	// Through statusLine the plain "queued" words become the slot; a held card keeps its hold.
	// needsReason rides explicitly: the card fixture casts, so unfilled fields are undefined.
	const plain = card({
		id: "p1",
		state: "queued",
		stage: "todo",
		queuedAt: 30,
		needsReason: null,
		pendingPrompt: null,
		holdUntil: null,
		asked: null,
	});
	expect(statusLine(plain, true, null, false, [q1, q2, plain])).toBe(
		"#3 in queue",
	);
	expect(
		statusLine({ ...plain, stage: "merging" }, true, "blocked by X", false, [
			q1,
			q2,
			plain,
		]),
	).toBe("blocked by X");
});

test("reviewProgress counts a running review's landed findings", () => {
	const r = review({ stage: "in_progress", state: "running" });
	const done1 = finding({ id: "f1", stage: "done", state: "idle", doneAt: 5 });
	const open = finding({ id: "f2" });
	const gone = finding({ id: "f3", cancelledAt: 5 });
	// A cancelled finding is not open: like reReleaseOf, it counts as handled.
	expect(reviewProgress([r, done1, open, gone], r)).toBe(
		"2 of 3 findings done",
	);
	// A release card runs the same review: it counts too.
	const rel = release({ state: "running", stage: "in_progress", doneAt: null });
	expect(reviewProgress([rel, done1, open], rel)).toBe("1 of 2 findings done");
	// Not running, not a review, or no finding yet: null, the plain words stay.
	expect(
		reviewProgress([r, done1, open], review({ stage: "in_progress" })),
	).toBeNull();
	expect(
		reviewProgress(
			[r, done1, open],
			review({ stage: "in_progress", state: "idle" }),
		),
	).toBeNull();
	expect(reviewProgress([r], r)).toBeNull();
	// Through statusLine the count replaces "running" on the card; progress outranks it.
	expect(statusLine(r, true, null, false, [r, done1, open, gone])).toBe(
		"2 of 3 findings done",
	);
	expect(statusLine(r, true, null, false)).toBe("running");
	expect(
		statusLine({ ...r, progress: "Stryker 5% · 1/10" }, true, null, false, [
			r,
			done1,
		]),
	).toBe("Stryker 5% · 1/10");
});

const release = (over: Partial<TaskCard> = {}): TaskCard =>
	card({
		id: "r1",
		releaseVersion: "v0.3.0",
		stage: "merging",
		state: "needs_you",
		doneAt: 10,
		...over,
	});
const finding = (over: Partial<TaskCard> = {}): TaskCard =>
	card({ id: "f1", title: "finding", followUpOf: "r1", ...over });

test("reReleaseOf describes the stalled release: findings done, merges held", () => {
	const r = release({ heldMerges: ["m1", "m2"] });
	const done = finding({ stage: "done", state: "idle", doneAt: 5 });
	expect(reReleaseOf(r, [r, done])).toEqual({
		ids: ["m1", "m2"],
		findings: 1,
	});
	// idle works like needs_you: the release parked while its findings landed.
	const parked = release({ state: "idle", heldMerges: ["m1"] });
	expect(reReleaseOf(parked, [parked, done])).toEqual({
		ids: ["m1"],
		findings: 1,
	});
	// A cancelled finding is not open: it does not block the re-release view.
	const gone = finding({ cancelledAt: 5 });
	expect(reReleaseOf(r, [r, gone])).toEqual({
		ids: ["m1", "m2"],
		findings: 1,
	});
});

test("reReleaseOf null cases", () => {
	const r = release({ heldMerges: ["m1"] });
	const done = finding({ stage: "done", state: "idle", doneAt: 5 });
	// A finding still open blocks the view.
	expect(reReleaseOf(r, [r, finding()])).toBeNull();
	// Running or queued states are not parked for the user.
	expect(
		reReleaseOf(release({ state: "running", heldMerges: ["m1"] }), [r, done]),
	).toBeNull();
	expect(
		reReleaseOf(release({ state: "queued", heldMerges: ["m1"] }), [r, done]),
	).toBeNull();
	// No held merges, no view.
	expect(reReleaseOf(release(), [r, done])).toBeNull();
	// Cancelled release, or a done one, never re-releases.
	expect(
		reReleaseOf(release({ cancelledAt: 5, heldMerges: ["m1"] }), [r, done]),
	).toBeNull();
	expect(
		reReleaseOf(release({ stage: "done", heldMerges: ["m1"] }), [r, done]),
	).toBeNull();
});

test("releaseHolding finds the release naming a card, via heldMerges", () => {
	const r = release({ heldMerges: ["m1"] });
	const m1 = card({ id: "m1", stage: "merging", state: "queued" });
	expect(releaseHolding(m1, [r, m1])).toEqual({
		id: "r1",
		version: "v0.3.0",
	});
	expect(releaseHolding(card({ id: "m2" }), [r, m1])).toBeNull();
});

test("holdFor names the stamped push hold, only on the held card", () => {
	// The server stamps queued merges the push hold parks (main has commits origin
	// lacks); the browser has no git, so the reason rides the card.
	const held = card({
		id: "m1",
		stage: "merging",
		state: "queued",
		pushHold: true,
	});
	expect(holdFor(held, [])).toBe("waiting for main to reach origin/main");
	// Without the stamp no hold shows: the stamp is the server's derived fact, like heldMerges.
	expect(
		holdFor(card({ id: "m2", stage: "merging", state: "queued" }), []),
	).toBeNull();
});

test("holdFor shows the stamped microVM hold, after an unfinished dependency", () => {
	const queued = card({
		id: "c1",
		stage: "todo",
		state: "queued",
		needsReason: null,
		pendingPrompt: null,
		vmHold: "waiting for a free microVM",
	});
	expect(holdFor(queued, [])).toBe("waiting for a free microVM");
	expect(statusLine(queued, true, holdFor(queued, []))).toBe(
		"waiting for a free microVM",
	);
	// The dependency is the real blocker: a free microVM would not start the card.
	const dep = card({ id: "d1", title: "schema", stage: "todo" });
	const blocked = { ...queued, dependsOn: ["d1"] };
	expect(holdFor(blocked, [dep, blocked])).toBe("waiting for #d1 schema");
	// A done card is never held, stamp or not.
	expect(holdFor({ ...queued, stage: "done" }, [])).toBeNull();
});

test("etaLeft gives the mutation-run style estimate until the median is used up", () => {
	const started = 1790683200000;
	// 4 minutes of median, 1 minute in: about 3m left.
	expect(etaLeft(4 * 60_000, started, started + 60_000)).toBe("about 3m left");
	// Two units at most, like the Stryker readout (duration() always renders both).
	expect(etaLeft(2 * 3600_000, started, started)).toBe("about 2h 0m left");
	// The median used up: elapsed alone from there.
	expect(etaLeft(60_000, started, started + 60_000)).toBeNull();
	expect(etaLeft(60_000, started, started + 120_000)).toBeNull();
});
