import { expect, test } from "bun:test";
import {
	type DepIndex,
	type DepProject,
	findDep,
	PUSH_HOLD,
	REVIEW_HOLD_MAX_MS,
} from "../scheduler.ts";
import type { TaskCard } from "../types.ts";
import { buildCardIndex } from "./cardIndex.ts";
import {
	alarmLabel,
	cardMark,
	type DepHoldContext,
	etaLeft,
	holdFor,
	holdLeft,
	indexDepIndex,
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
	project: "p",
	cancelledAt: null,
	state: "queued",
	stage: "todo",
	needsReason: null,
	pendingPrompt: null,
	asked: null,
	holdUntil: null,
	dependsOn: [],
	kind: "work",
	releaseVersion: null,
	doneAt: null,
	prNumber: null,
	pushSha: null,
	validatedAt: null,
	followUpOf: null,
	...overrides,
});

test("statusLine queued precedence: needsReason beats everything", () => {
	expect(statusLine(t({ needsReason: "exit 1" }), true)).toBe("resuming");
	expect(
		statusLine(t({ needsReason: "exit 1", pendingPrompt: "hi" }), false),
	).toBe("resuming");
});

test("statusLine: a queued card names its open dependency, not resuming", () => {
	// OTTR-1321: the parked shape (needsReason on record, stage in_progress) sat at
	// "resuming" for hours while its dependency held the dispatch.
	const dep = card({ id: "d1", title: "Schema", stage: "in_progress" });
	const parked = t({
		stage: "in_progress",
		needsReason: "waiting for #d1 Schema",
		dependsOn: ["d1"],
	});
	expect(statusLine(parked, true, undefined, false, [dep])).toBe(
		"waiting for #d1 Schema",
	);
	// The dependency done: the card resumes again, the stale reason on record.
	const done = card({
		id: "d1",
		title: "Schema",
		stage: "done",
		state: "idle",
	});
	expect(statusLine(parked, true, undefined, false, [done])).toBe("resuming");
	// A card without a tracker reason names the dependency too, at any stage.
	const plain = t({ stage: "in_progress", dependsOn: ["d1"] });
	expect(statusLine(plain, true, undefined, false, [dep])).toBe(
		"waiting for #d1 Schema",
	);
});

test("statusLine: a cross-project dependency id resolves to its title", () => {
	const foreign: DepIndex = (id) =>
		id === "AGEN-161"
			? {
					id,
					title: "Sync the token grant pinning rule",
					stage: "merging",
					cancelledAt: null,
				}
			: null;
	const parked = t({
		stage: "in_progress",
		needsReason: "waiting for #AGEN-161 Sync the token grant pinning rule",
		dependsOn: ["AGEN-161"],
	});
	expect(statusLine(parked, true, undefined, false, [], foreign)).toBe(
		"waiting for #AGEN-161 Sync the token grant pinning rule",
	);
});

test("statusLine: a foreign dependency's hold reads its own project", () => {
	// The board's foreign index hands back the full wire card, and the hold reads
	// the foreign project's context — never the follower's cards or resolver.
	const foreign: DepIndex = (id) =>
		id === "AGEN-162"
			? {
					id,
					title: "Sync the alate gate rule",
					stage: "merging",
					cancelledAt: null,
					pushHold: true,
				}
			: null;
	const parked = t({
		stage: "in_progress",
		needsReason: "waiting for #AGEN-162 Sync the alate gate rule",
		dependsOn: ["AGEN-162"],
	});
	const foreignHolds: (id: string) => DepHoldContext | null = (id) =>
		id === "AGEN-162" ? { cards: [] } : null;
	// An unrelated review runs in the follower's project: the foreign merge gate
	// must not see it (send-back 2, blocker 1).
	const localReview = review({
		stage: "in_progress",
		state: "running",
		createdAt: Date.now() - 60_000,
	});
	expect(
		statusLine(
			parked,
			true,
			undefined,
			false,
			[localReview],
			foreign,
			foreignHolds,
		),
	).toBe(`waiting for #AGEN-162 Sync the alate gate rule (${PUSH_HOLD})`);
	// A live review in the foreign project IS the dependency's hold (blocker 2).
	const foreignReview = review({
		id: "r9",
		title: "Agent-data review",
		stage: "in_progress",
		state: "running",
		createdAt: Date.now() - 60_000,
	});
	expect(
		statusLine(parked, true, undefined, false, [], foreign, (id) =>
			id === "AGEN-162" ? { cards: [foreignReview] } : null,
		),
	).toBe(
		"waiting for #AGEN-162 Sync the alate gate rule (waiting for the review to finish)",
	);
	// A nested dependsOn id resolves relative to the foreign project (blocker 3).
	const nestedForeign: DepIndex = (id) =>
		id === "AGEN-162"
			? {
					id,
					title: "Sync rules",
					stage: "todo",
					cancelledAt: null,
					dependsOn: ["c0ffee00"],
				}
			: null;
	const legacy = card({
		id: "c0ffee00",
		title: "Legacy prerequisite",
		stage: "todo",
	});
	const nestedIndex: DepIndex = (id) =>
		id === "c0ffee00"
			? { id, title: "Legacy prerequisite", stage: "todo", cancelledAt: null }
			: null;
	expect(
		statusLine(parked, true, undefined, false, [], nestedForeign, (id) =>
			id === "AGEN-162" ? { cards: [legacy], index: nestedIndex } : null,
		),
	).toBe(
		"waiting for #AGEN-162 Sync rules (waiting for #c0ffee00 Legacy prerequisite)",
	);
	// No foreign context: the plain wording stays.
	expect(statusLine(parked, true, undefined, false, [], foreign)).toBe(
		"waiting for #AGEN-162 Sync the alate gate rule",
	);
	// A dependency whose turn already runs names no gate (blocker 4): a review
	// can start after its merge starts, and the running card shows its own words.
	const runningDep = card({
		id: "d1",
		title: "Schema",
		stage: "merging",
		state: "running",
		pushHold: true,
	});
	expect(
		statusLine(
			t({ stage: "in_progress", dependsOn: ["d1"] }),
			true,
			undefined,
			false,
			[runningDep],
		),
	).toBe("waiting for #d1 Schema");
});

test("statusLine: every held dependency names its hold, not only one", () => {
	const held = card({
		id: "d1",
		title: "Schema",
		stage: "merging",
		pushHold: true,
	});
	const bare = card({ id: "d2", title: "Notes", stage: "todo" });
	expect(
		statusLine(
			t({ stage: "in_progress", dependsOn: ["d1", "d2"] }),
			true,
			undefined,
			false,
			[held, bare],
		),
	).toBe(`waiting for #d1 Schema (${PUSH_HOLD}), #d2 Notes`);
});

test("statusLine: an expired review hold frees the dependency's line", () => {
	// The 48h review cap only runs when the dependency's hold reads the current
	// time; without it a stale merge hold shows forever (send-back 3).
	const openReview = (createdAt: number): TaskCard =>
		card({
			id: "r1",
			title: "Cap review",
			kind: "review",
			stage: "in_progress",
			state: "running",
			createdAt,
		});
	const mergeDep = card({
		id: "d1",
		title: "Big review",
		stage: "merging",
		pushHold: true,
	});
	const parked = t({
		stage: "in_progress",
		needsReason: "waiting for #d1 Big review",
		dependsOn: ["d1"],
	});
	// Past the cap: the review hold expires, the push hold names the blocker.
	const expired = openReview(Date.now() - REVIEW_HOLD_MAX_MS - 1000);
	expect(statusLine(parked, true, undefined, false, [expired, mergeDep])).toBe(
		`waiting for #d1 Big review (${PUSH_HOLD})`,
	);
	// Inside the cap: the running review is the dependency's own hold.
	const fresh = openReview(Date.now() - 60_000);
	expect(statusLine(parked, true, undefined, false, [fresh, mergeDep])).toBe(
		"waiting for #d1 Big review (waiting for the review to finish)",
	);
});

test("statusLine: the open dependency's own hold rides the dep line", () => {
	const parked = t({
		stage: "in_progress",
		needsReason: "waiting for #d1 Schema",
		dependsOn: ["d1"],
	});
	// A usage-limit hold on the dependency counts down inside the dep line.
	const held = card({
		id: "d1",
		title: "Schema",
		stage: "todo",
		holdUntil: Date.now() + 3600_000,
		needsReason:
			"The zai usage limit is reached. The board starts the task again after the limit resets.",
	});
	expect(statusLine(parked, true, undefined, false, [held])).toMatch(
		/^waiting for #d1 Schema \(held · zai limit · .+ left\)$/,
	);
	// A merge held because main is ahead of origin names the push hold text.
	const pushed = card({
		id: "d2",
		title: "Notes",
		stage: "merging",
		pushHold: true,
	});
	expect(
		statusLine(
			t({
				stage: "in_progress",
				needsReason: "waiting for #d2 Notes",
				dependsOn: ["d2"],
			}),
			true,
			undefined,
			false,
			[pushed],
		),
	).toBe(`waiting for #d2 Notes (${PUSH_HOLD})`);
	// The dependency's hold facts absent: the plain dep line stays.
	const bare = card({ id: "d3", title: "Lint", stage: "todo" });
	expect(
		statusLine(
			t({
				stage: "in_progress",
				needsReason: "waiting for #d3 Lint",
				dependsOn: ["d3"],
			}),
			true,
			undefined,
			false,
			[bare],
		),
	).toBe("waiting for #d3 Lint");
	// Dependencies without hold facts keep the plain list wording.
	const a = card({ id: "d4", title: "Alpha", stage: "todo" });
	const b = card({ id: "d5", title: "Beta", stage: "todo" });
	expect(
		statusLine(
			t({ stage: "in_progress", dependsOn: ["d4", "d5"] }),
			true,
			undefined,
			false,
			[a, b],
		),
	).toBe("waiting for #d4 Alpha, #d5 Beta");
});

test("statusLine: a pending sandbox lead's validation wait beats a queued reply", () => {
	// Steer on a pending lead queues a reply, but the lead never runs as a work
	// turn, so the reply-queued words would be false (OTTR-1247 send-back).
	const lead = t({
		sandboxLead: true,
		validatedAt: null,
		followUpOf: "r1",
		pendingPrompt: "please merge",
	});
	expect(statusLine(lead, true, undefined, false, [])).toBe(
		"Waits for a validation run of review r1; a work turn has no sandbox_run.",
	);
});

test("statusLine: a pending sandbox lead's validation wait beats a tracker reason", () => {
	const lead = t({
		sandboxLead: true,
		validatedAt: null,
		followUpOf: "r1",
		needsReason: "exit 1",
	});
	expect(statusLine(lead, true)).toBe(
		"Waits for a validation run of review r1; a work turn has no sandbox_run.",
	);
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

test("statusLine parked PR-mode card names its open pull request, never done", () => {
	// The settle park (turn.ts): stage merging, state idle, no reason, PR open.
	expect(
		statusLine(t({ state: "idle", stage: "merging", prNumber: 53 }), true),
	).toBe("PR #53 open · waiting for merge");
	// pushSha is the CI watch's pin on the PR head: the verdict is pending.
	expect(
		statusLine(
			t({ state: "idle", stage: "merging", prNumber: 53, pushSha: "abc" }),
			true,
		),
	).toBe("PR #53 open · waiting for CI");
	// A park that carries a reason keeps it; the PR number alone is no reason.
	expect(
		statusLine(
			t({
				state: "idle",
				stage: "merging",
				prNumber: 53,
				needsReason: "waiting for the review's findings to be implemented",
			}),
			true,
		),
	).toBe("waiting for the review's findings to be implemented");
});

test("statusLine done card still says done, with or without a merged PR", () => {
	// A normal done card.
	expect(statusLine(t({ state: "idle", stage: "done" }), true)).toBe("done");
	// finishPrMerge keeps prNumber on the card after the PR merged: stage done wins.
	expect(
		statusLine(t({ state: "idle", stage: "done", prNumber: 53 }), true),
	).toBe("done");
});

test("cardMark: a parked PR-mode card waits, it never earns the done check", () => {
	expect(cardMark(t({ state: "idle", stage: "merging", prNumber: 53 }))).toBe(
		"queued",
	);
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
		needsReason: null,
		...over,
	}) as TaskCard;

const MERGE_HOLD = "waiting for the review to finish";
const review = (over: Partial<TaskCard> = {}): TaskCard =>
	card({
		id: "r1",
		kind: "review",
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

test("holdFor: past the 48 h cap the running review no longer holds (OTTR-1253)", () => {
	const open = review({
		stage: "in_progress",
		state: "running",
		createdAt: 1_000,
	});
	const merge = card({ id: "m1", stage: "merging", state: "queued" });
	expect(
		holdFor(merge, [open, merge], undefined, 1_000 + REVIEW_HOLD_MAX_MS),
	).toBeNull();
	expect(
		holdFor(merge, [open, merge], undefined, 1_000 + REVIEW_HOLD_MAX_MS - 1),
	).toBe(MERGE_HOLD);
});

test("holdFor never holds a card outside todo and merging", () => {
	const live = review({ stage: "in_progress", state: "running" });
	const release = card({ stage: "in_progress", state: "idle" });
	expect(holdFor(release, [live, release])).toBeNull();
	const done = card({ stage: "done", state: "idle" });
	expect(holdFor(done, [live, done])).toBeNull();
});

test("holdFor names a queued lead's validation wait over its dependencies", () => {
	// Wire rows (TaskCard) ship no prompt: the taskView sandboxLead stamp decides.
	const lead = card({
		id: "l1",
		title: "Lead",
		validatedAt: null,
		followUpOf: "r1",
		sandboxLead: true,
	});
	expect(holdFor(lead, [])).toBe(
		"Waits for a validation run of review r1; a work turn has no sandbox_run.",
	);
	// The hold outranks a dependency hold: no work turn can ever take the lead.
	const dep = card({ id: "d1", title: "Dep", stage: "in_progress" });
	expect(holdFor({ ...lead, dependsOn: ["d1"] }, [dep, lead])).toBe(
		"Waits for a validation run of review r1; a work turn has no sandbox_run.",
	);
	// A lead card without the stamp (a deployment-fact lead, or any other card)
	// shows no hold.
	expect(holdFor({ ...lead, sandboxLead: undefined }, [])).toBeNull();
	// The designed states stay quiet: a validated lead carries no stamp (taskView
	// stamps only a never-validated lead), so the stamp must go with it.
	expect(
		holdFor({ ...lead, validatedAt: 5, sandboxLead: undefined }, []),
	).toBeNull();
	expect(holdFor({ ...lead, stage: "backlog" }, [])).toBeNull();
	expect(holdFor({ ...lead, state: "idle" }, [])).toBeNull();
	expect(holdFor({ ...lead, cancelledAt: 9 }, [])).toBeNull();
});

test("holdFor names a foreign dependency through the cross-project lookup", () => {
	const follower = card({ id: "f1", title: "Follower", dependsOn: ["AD-5"] });
	const foreignCard = card({
		id: "AD-5",
		title: "Over there",
		stage: "in_progress",
		state: "running",
	});
	const own: DepProject = { name: "p1", prefix: "P1", getTask: () => null };
	const foreign: DepProject = {
		name: "ad",
		prefix: "AD",
		getTask: (id) => (id === foreignCard.id ? foreignCard : null),
	};
	const foreignDeps: DepIndex = (id) => findDep(id, [own, foreign], own);
	expect(holdFor(follower, [follower], foreignDeps)).toBe(
		"waiting for #AD-5 Over there",
	);
	// A done foreign dependency holds nothing, and an id no project has counts as done
	// (validation is the settle block's job).
	foreignCard.stage = "done";
	expect(holdFor(follower, [follower], foreignDeps)).toBeNull();
	const lost = card({ id: "f2", title: "Other", dependsOn: ["NOPE-1"] });
	expect(holdFor(lost, [follower], foreignDeps)).toBeNull();
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

test("a proposal waits: no needs mark, outside every alarm group", () => {
	const reason =
		'Retro proposal from t3 ("Fix the widget"). Accept starts it. Edit task changes the prompt first. Cancel task declines it.';
	const proposal = card({ id: "p1", state: "needs_you", needsReason: reason });
	const blocker = card({
		id: "p2",
		state: "needs_you",
		needsReason: "hit a blocker",
	});
	expect(cardMark(proposal)).toBe("queued");
	expect(cardMark(blocker)).toBe("needs");
	// A cancelled proposal keeps the cancelled mark.
	expect(cardMark({ ...proposal, cancelledAt: 5 })).toBe("cancelled");
	const split = splitAlarms([proposal, blocker]);
	expect(split.needs.map((x) => x.id)).toEqual(["p2"]);
	expect(split.asks).toEqual([]);
	expect(split.running).toEqual([]);
});

test("alarmLabel singular, plural, and empty", () => {
	expect(alarmLabel(1, 0)).toBe("1 task needs action");
	expect(alarmLabel(2, 1)).toBe("2 tasks need action · 1 question asked");
	expect(alarmLabel(0, 2)).toBe("2 questions asked");
	expect(alarmLabel(0, 0)).toBe("");
});

test("alarmLabel PR review segment", () => {
	expect(alarmLabel(1, 0, 0)).toBe("1 task needs action");
	expect(alarmLabel(0, 0, 1)).toBe("1 PR review has activity");
	expect(alarmLabel(0, 0, 2)).toBe("2 PR reviews have activity");
	expect(alarmLabel(1, 1, 1)).toBe(
		"1 task needs action · 1 question asked · 1 PR review has activity",
	);
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
	expect(reviewProgress(buildCardIndex([r, done1, open, gone]), r)).toBe(
		"2 of 3 findings done",
	);
	// A release card runs the same review: it counts too.
	const rel = release({ state: "running", stage: "in_progress", doneAt: null });
	expect(reviewProgress(buildCardIndex([rel, done1, open]), rel)).toBe(
		"1 of 2 findings done",
	);
	// Not running, not a review, or no finding yet: null, the plain words stay.
	expect(
		reviewProgress(
			buildCardIndex([r, done1, open]),
			review({ stage: "in_progress" }),
		),
	).toBeNull();
	expect(
		reviewProgress(
			buildCardIndex([r, done1, open]),
			review({ stage: "in_progress", state: "idle" }),
		),
	).toBeNull();
	expect(reviewProgress(buildCardIndex([r]), r)).toBeNull();
	// Through statusLine the count replaces "running" on the card; progress outranks it.
	expect(
		statusLine(
			r,
			true,
			null,
			false,
			undefined,
			undefined,
			undefined,
			buildCardIndex([r, done1, open, gone]),
		),
	).toBe("2 of 3 findings done");
	expect(statusLine(r, true, null, false)).toBe("running");
	expect(
		statusLine(
			{ ...r, progress: "Stryker 5% · 1/10" },
			true,
			null,
			false,
			undefined,
			undefined,
			undefined,
			buildCardIndex([r, done1]),
		),
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

// OTTR-1255 send-back regressions: the hold gates read the complete project graph
// from the card index, so a settled card outside the Done window neither fakes a
// hold nor hides behind the window cut.

import type { CardRef } from "../types.ts";
import { projectGraph } from "./status.ts";

const ref = (
	over: Partial<CardRef> & { id: string; project: string },
): CardRef => ({
	sessionTitle: `Title of ${over.id}`,
	kind: "work",
	stage: "done",
	state: "idle",
	cancelledAt: null,
	createdAt: 1_000,
	updatedAt: 2_000,
	queuedAt: null,
	doneAt: 1_500,
	followUpOf: null,
	followUpOfProject: null,
	asked: null,
	dependsOn: [],
	commits: 3,
	releaseVersion: null,
	leadAtDone: false,
	...over,
});

test("a merging descendant behind a hidden done finding stays held while its review runs", () => {
	// Review R (open) filed F, F is done and outside the Done window, and F's
	// child D sits in merging. The windowed list lost F, so its closure lost D
	// and the merge ran while the review was open. The graph sees the chain and
	// holds D behind the review exactly as it would with F in the window.
	const rows: CardRef[] = [
		ref({
			id: "R-1",
			project: "p",
			kind: "review",
			stage: "in_progress",
			state: "running",
			doneAt: null,
		}),
		ref({
			id: "F-1",
			project: "p",
			followUpOf: "R-1",
			followUpOfProject: "p",
			doneAt: 900,
		}),
		ref({
			id: "D-1",
			project: "p",
			stage: "merging",
			state: "queued",
			doneAt: null,
			followUpOf: "F-1",
			followUpOfProject: "p",
		}),
	];
	const index = buildCardIndex(rows);
	const graph = projectGraph(index, "p");
	// Complete data: D is a finding of the open review through the hidden F, so
	// reviewHoldFor exempts it (a finding merges while its review runs).
	expect(
		holdFor(
			{
				id: "D-1",
				stage: "merging",
				state: "queued",
				dependsOn: [],
				pushRetries: 0,
				pendingBy: null,
				validatedAt: null,
				followUpOf: null,
				cancelledAt: null,
			},
			graph,
		),
	).toBe(null);
	// The windowed list the old code used lost F, so it lost D's exemption and
	// held the descendant behind the review — the fixed bug.
	const windowed = projectGraph(
		buildCardIndex(rows.filter((r) => r.id !== "F-1")),
		"p",
	);
	expect(
		holdFor(
			{
				id: "D-1",
				stage: "merging",
				state: "queued",
				dependsOn: [],
				pushRetries: 0,
				pendingBy: null,
				validatedAt: null,
				followUpOf: null,
				cancelledAt: null,
			},
			windowed,
		),
	).toBe("waiting for the review to finish");
	// With the review done, its done finding holds nothing: the descendant frees.
	const doneReview = rows.map((r) =>
		r.id === "R-1"
			? { ...r, stage: "done" as const, state: "idle" as const, doneAt: 950 }
			: r,
	);
	const doneGraph = projectGraph(buildCardIndex(doneReview), "p");
	expect(
		holdFor(
			{
				id: "D-1",
				stage: "merging",
				state: "queued",
				dependsOn: [],
				pushRetries: 0,
				pendingBy: null,
				validatedAt: null,
				followUpOf: null,
				cancelledAt: null,
			},
			doneGraph,
		),
	).toBe(null);
});

test("a done dep outside the window satisfies the dependency", () => {
	const rows: CardRef[] = [
		ref({ id: "A-1", project: "p", doneAt: 900 }),
		ref({
			id: "B-1",
			project: "p",
			stage: "todo",
			state: "queued",
			doneAt: null,
		}),
	];
	const graph = projectGraph(buildCardIndex(rows), "p");
	expect(
		holdFor(
			{
				id: "B-1",
				stage: "todo",
				state: "queued",
				dependsOn: ["A-1"],
				pushRetries: 0,
				pendingBy: null,
				validatedAt: null,
				followUpOf: null,
				cancelledAt: null,
			},
			graph,
		),
	).toBe(null);
});

test("reReleaseOf counts a hidden done finding's open child", () => {
	// Release card with held merges; its finding F is done and outside the window,
	// but F's child K is open. Windowed data saw zero findings and offered the
	// re-release; the graph sees K and refuses.
	const rows: CardRef[] = [
		ref({
			id: "REL-1",
			project: "p",
			kind: "review",
			releaseVersion: "1.2.0",
			stage: "todo",
			state: "needs_you",
			doneAt: null,
		}),
		ref({
			id: "F-1",
			project: "p",
			followUpOf: "REL-1",
			followUpOfProject: "p",
			doneAt: 900,
		}),
		ref({
			id: "K-1",
			project: "p",
			stage: "todo",
			state: "queued",
			doneAt: null,
			followUpOf: "F-1",
			followUpOfProject: "p",
		}),
	];
	const graph = projectGraph(buildCardIndex(rows), "p");
	const release = {
		id: "REL-1",
		project: "p",
		cancelledAt: null,
		releaseVersion: "1.2.0" as string | null,
		stage: "todo" as const,
		state: "needs_you" as const,
		heldMerges: ["M-1", "M-2"],
		kind: "review" as const,
		doneAt: null,
		sessionTitle: "Release 1.2.0",
		promptAuthor: "user",
	} as TaskCard;
	expect(reReleaseOf(release, graph)).toBe(null);
	// And with K done too, the offer returns with both findings counted.
	const doneK = ref({
		id: "K-1",
		project: "p",
		followUpOf: "F-1",
		followUpOfProject: "p",
	});
	const all = projectGraph(
		buildCardIndex([...rows.filter((r) => r.id !== "K-1"), doneK]),
		"p",
	);
	expect(reReleaseOf(release, all)).toEqual({
		ids: ["M-1", "M-2"],
		findings: 2,
	});
});

test("the index resolver keeps a local hidden done dep ahead of a foreign twin", () => {
	// Local p has a done X-7 hidden by the window; foreign q has an OPEN X-7 and
	// the id handle X. The real resolver (indexDepIndex -> resolveDep) must read
	// the local done card first: no hold. Without the local row it resolves the
	// foreign open twin through the prefix and names the hold — that direction
	// is the OTTR-708 contract, unchanged.
	const rows: CardRef[] = [
		ref({ id: "X-7", project: "p", doneAt: 900 }),
		ref({
			id: "X-7",
			project: "q",
			stage: "in_progress",
			state: "running",
			doneAt: null,
		}),
		ref({
			id: "B-1",
			project: "p",
			stage: "todo",
			state: "queued",
			doneAt: null,
		}),
	];
	const projects = [
		{ name: "p", prefix: "P" },
		{ name: "q", prefix: "X" },
	];
	const full = buildCardIndex(rows);
	const fullDeps = indexDepIndex(full, projects, "p");
	const graph = projectGraph(full, "p");
	const merge = {
		id: "B-1",
		stage: "todo" as const,
		state: "queued" as const,
		dependsOn: ["X-7"],
		pushRetries: 0,
		pendingBy: null,
		validatedAt: null,
		followUpOf: null,
		cancelledAt: null,
	};
	// The own project holds the id, so the prefix walk never runs: the hidden
	// done local card satisfies the dependency.
	expect(holdFor(merge, graph, fullDeps ?? undefined)).toBe(null);
	// Windowed: the local row left the window, so the resolver walks the prefix
	// and finds the foreign open twin — the hold names it.
	const windowed = buildCardIndex(
		rows.filter((r) => !(r.project === "p" && r.id === "X-7")),
	);
	const windowedDeps = indexDepIndex(windowed, projects, "p");
	expect(
		holdFor(merge, projectGraph(windowed, "p"), windowedDeps ?? undefined),
	).toBe("waiting for #X-7 Title of X-7");
	// The resolver itself answers both directions, not just through holdFor.
	expect(fullDeps?.("X-7")?.project).toBe("p");
	expect(windowedDeps?.("X-7")?.project).toBe("q");
});

test("reviewProgress counts findings the window dropped", () => {
	const rows: CardRef[] = [
		ref({
			id: "R-9",
			project: "p",
			kind: "review",
			stage: "in_progress",
			state: "running",
			doneAt: null,
		}),
		ref({
			id: "F-1",
			project: "p",
			followUpOf: "R-9",
			followUpOfProject: "p",
			doneAt: 900,
		}),
		ref({
			id: "F-2",
			project: "p",
			followUpOf: "R-9",
			followUpOfProject: "p",
			stage: "todo",
			state: "queued",
			doneAt: null,
		}),
	];
	expect(
		reviewProgress(buildCardIndex(rows), {
			id: "R-9",
			project: "p",
			kind: "review",
			releaseVersion: null,
			doneAt: null,
			state: "running",
		}),
	).toBe("1 of 2 findings done");
});
