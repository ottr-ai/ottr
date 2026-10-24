import { describe, expect, test } from "bun:test";
import { ARCH_REVIEW_MARKER, RULES_INTERVIEW_MARKER } from "./prompts.ts";
import {
	applyCheckVerdicts,
	checkRoleFor,
	demoteUnquoted,
	depHold,
	findingsHold,
	isRetro,
	isReview,
	lastReviewBase,
	liveCard,
	mergeHold,
	openWorkBlockers,
	parseCheckVerdicts,
	parseWorkCheck,
	pickRunnable,
	queueOrder,
	reviewBlocked,
	reviewFindings,
	selectFindings,
	waitingOn,
} from "./scheduler.ts";
import type { Task } from "./types.ts";

let seq = 0;
/** Deterministic Task with sane defaults; id/title/ids derive from a counter. */
function task(p: Partial<Task> = {}): Task {
	seq += 1;
	const now = 1_000 + seq;
	return {
		id: `id${String(seq).padStart(5, "0")}`,
		project: "proj",
		title: `task ${seq}`,
		prompt: `prompt ${seq}`,
		stage: "todo",
		state: "queued",
		needsReason: null,
		pendingPrompt: null,
		images: [],
		pendingImages: [],
		shots: [],
		branch: null,
		base: null,
		worktree: null,
		sessionId: null,
		summary: null,
		details: null,
		report: null,
		research: false,
		createdAt: now,
		updatedAt: now,
		queuedAt: now,
		doneAt: null,
		cancelledAt: null,
		commits: null,
		releaseVersion: null,
		releaseNotes: null,
		asked: null,
		model: null,
		keptFiles: [],
		followUpOf: null,
		pushSha: null,
		topic: null,
		dependsOn: [],
		updateIds: [],
		updateMergeApproved: false,
		forkMergeApproved: false,
		diffFiles: null,
		diffText: null,
		workCheckLog: [],
		workCheckSendbacks: 0,
		workCheckHead: null,
		priority: null,
		closeCandidate: null,
		kind: "work",
		...p,
	};
}

const opts = { maxParallel: 2, hasRules: true };

describe("liveCard", () => {
	test("a non-done, non-cancelled card of the kind is live", () => {
		const live = task({ kind: "interview", stage: "in_progress" });
		expect(liveCard([live], "interview")).toBe(true);
	});

	test("done and cancelled cards of the kind are not live", () => {
		const done = task({ kind: "review", stage: "done", state: "idle" });
		const cancelled = task({ kind: "review", cancelledAt: 5 });
		expect(liveCard([done, cancelled], "review")).toBe(false);
	});

	test("a card of another kind never matches", () => {
		expect(liveCard([task()], "review")).toBe(false);
	});
});

describe("queueOrder", () => {
	test("orders by queuedAt asc", () => {
		const late = task({ queuedAt: 900 });
		const early = task({ queuedAt: 100 });
		expect(queueOrder([late, early])).toEqual([early, late]);
	});

	test("falls back to createdAt when queuedAt is null", () => {
		const nullLate = task({ queuedAt: null, createdAt: 900 });
		const queued = task({ queuedAt: 500 });
		const nullEarly = task({ queuedAt: null, createdAt: 100 });
		expect(queueOrder([nullLate, queued, nullEarly])).toEqual([
			nullEarly,
			queued,
			nullLate,
		]);
	});

	test("createdAt breaks queuedAt ties", () => {
		const b = task({ queuedAt: 500, createdAt: 200 });
		const a = task({ queuedAt: 500, createdAt: 100 });
		expect(queueOrder([b, a])).toEqual([a, b]);
	});

	test("excludes non-queued and cancelled tasks", () => {
		const queued = task({ queuedAt: 500 });
		const running = task({ state: "running", queuedAt: 100 });
		const cancelled = task({ cancelledAt: 500, queuedAt: 100 });
		expect(queueOrder([running, cancelled, queued])).toEqual([queued]);
	});
});

describe("pickRunnable", () => {
	test("merge picked before an older queued todo", () => {
		const todo = task({ queuedAt: 100 });
		const merge = task({ stage: "merging", queuedAt: 200 });
		expect(pickRunnable([todo, merge], opts)).toEqual([merge, todo]);
	});

	test("only one merge even with free slots and two merges queued", () => {
		const m1 = task({ stage: "merging", queuedAt: 100 });
		const m2 = task({ stage: "merging", queuedAt: 200 });
		expect(pickRunnable([m1, m2], { ...opts, maxParallel: 8 })).toEqual([m1]);
	});

	test("a null maxParallel picks every queued card", () => {
		const a = task({ queuedAt: 100 });
		const b = task({ queuedAt: 200 });
		const merge = task({ stage: "merging", queuedAt: 300 });
		expect(pickRunnable([a, b, merge], { ...opts, maxParallel: null })).toEqual(
			[merge, a, b],
		);
	});

	test("running merge blocks another merge but not work", () => {
		const runningMerge = task({ stage: "merging", state: "running" });
		const queuedMerge = task({ stage: "merging" });
		const todo = task();
		expect(pickRunnable([runningMerge, queuedMerge, todo], opts)).toEqual([
			todo,
		]);
	});

	test("maxParallel respected with running tasks", () => {
		const r1 = task({ state: "running" });
		const r2 = task({ state: "running" });
		const queued = task();
		expect(pickRunnable([r1, r2, queued], opts)).toEqual([]);
		expect(pickRunnable([r1, queued], opts)).toEqual([queued]);
	});

	test("needs_you tasks do not consume slots", () => {
		const waiting = task({ state: "needs_you" });
		const a = task();
		const b = task();
		expect(pickRunnable([waiting, a, b], opts)).toEqual([a, b]);
	});

	test("todo waits without rules while an in_progress reply still runs", () => {
		const reply = task({ stage: "in_progress", state: "running" });
		const todo = task();
		expect(pickRunnable([reply, todo], { ...opts, hasRules: false })).toEqual(
			[],
		);
		const replyQueued = task({ stage: "in_progress" });
		expect(
			pickRunnable([reply, todo, replyQueued], { ...opts, hasRules: false }),
		).toEqual([replyQueued]);
	});

	test("the interview task starts without rules; a normal todo still waits", () => {
		const interview = task({
			kind: "interview",
			prompt: `${RULES_INTERVIEW_MARKER}demo`,
			queuedAt: 100,
		});
		const todo = task({ queuedAt: 200 });
		expect(
			pickRunnable([interview, todo], { ...opts, hasRules: false }),
		).toEqual([interview]);
		// With rules present both run as usual.
		expect(pickRunnable([interview, todo], opts)).toEqual([interview, todo]);
	});

	test("cancelled tasks ignored entirely", () => {
		const cancelledMerge = task({
			stage: "merging",
			cancelledAt: 500,
			queuedAt: 100,
		});
		const cancelledRunning = task({ state: "running", cancelledAt: 500 });
		const todo = task();
		expect(
			pickRunnable([cancelledMerge, cancelledRunning, todo], opts),
		).toEqual([todo]);
	});

	test("queuedAt ordering with null fallback to createdAt", () => {
		const late = task({ queuedAt: 900 });
		const earlyNull = task({ queuedAt: null, createdAt: 100 });
		const mid = task({ queuedAt: 500 });
		expect(
			pickRunnable([late, earlyNull, mid], { ...opts, maxParallel: 3 }),
		).toEqual([earlyNull, mid, late]);
	});

	test("an open release holds every merge but its findings', in any state", () => {
		const merge = task({ stage: "merging", queuedAt: 100 });
		const todo = task({ queuedAt: 200 });
		for (const state of [
			"queued",
			"preparing",
			"running",
			"needs_you",
			"idle",
		] as const) {
			const release = task({
				stage: state === "idle" ? "merging" : "in_progress",
				state,
				releaseVersion: "v1.0.0",
				base: "abc",
			});
			expect(mergeHold([release, merge], merge)).toBe(
				"waiting for release v1.0.0",
			);
			// Work still starts; only the merge waits.
			expect(
				pickRunnable([release, merge, todo], { ...opts, maxParallel: 3 }),
			).not.toContain(merge);
		}
	});

	test("a published or cancelled release holds no merge", () => {
		const merge = task({ stage: "merging" });
		const done = task({
			stage: "done",
			state: "idle",
			releaseVersion: "v0.9.0",
			base: "abc",
			doneAt: 900,
		});
		const cancelled = task({
			stage: "in_progress",
			state: "running",
			releaseVersion: "v1.1.0",
			cancelledAt: 5,
		});
		expect(pickRunnable([done, cancelled, merge], opts)).toEqual([merge]);
	});

	test("an open review holds every merge but its findings'", () => {
		// The Review button's card reviews its frozen base read-only and never merges itself.
		const review = task({
			kind: "review",
			stage: "in_progress",
			state: "running",
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		const finding = task({
			followUpOf: review.id,
			stage: "merging",
			queuedAt: 200,
		});
		expect(mergeHold([review, other, finding], other)).toBe(
			"waiting for the review to finish",
		);
		expect(pickRunnable([review, other, finding], opts)).toEqual([finding]);
	});

	test("a card added by hand during a review is no finding: it waits for the findings", () => {
		// Only create_task's link (followUpOf) makes a finding, not the creation time.
		const review = task({
			kind: "review",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const finding = task({
			followUpOf: review.id,
			createdAt: 300,
			queuedAt: 700,
		});
		const byHand = task({ createdAt: 300, stage: "merging", queuedAt: 600 });
		expect(mergeHold([review, finding, byHand], byHand)).toBe(
			"waiting for the review's findings to be implemented",
		);
		const fixed = {
			...finding,
			stage: "done" as const,
			state: "idle" as const,
			doneAt: 800,
		};
		expect(mergeHold([review, fixed, byHand], byHand)).toBeNull();
	});

	test("a finding merges while the review's other findings are still open", () => {
		const review = task({
			kind: "review",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const open = task({
			followUpOf: review.id,
			createdAt: 300,
			queuedAt: 700,
		});
		const ready = task({
			followUpOf: review.id,
			createdAt: 310,
			stage: "merging",
			queuedAt: 650,
		});
		expect(pickRunnable([review, open, ready], opts)).toEqual([ready, open]);
	});

	test("a review parked while its findings land holds every other merge until it settles", () => {
		// runTurn parks an approved review at merging; settleReviews marks it done after its findings.
		const review = task({
			kind: "review",
			base: "abc",
			stage: "merging",
			state: "idle",
			needsReason: "waiting for the review's findings to be implemented",
		});
		const finding = task({
			followUpOf: review.id,
			stage: "merging",
			queuedAt: 200,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([review, finding, other], other)).toBe(
			"waiting for the review's findings to be implemented",
		);
		expect(pickRunnable([review, finding, other], opts)).toEqual([finding]);
		const fixed = {
			...finding,
			stage: "done" as const,
			state: "idle" as const,
		};
		expect(mergeHold([review, fixed, other], other)).not.toBeNull();
		const settled = {
			...review,
			stage: "done" as const,
			needsReason: null,
			doneAt: 900,
		};
		expect(mergeHold([settled, fixed, other], other)).toBeNull();
	});

	test("a finding's follow-ups and prerequisites merge with it; a later follow-up does not", () => {
		const review = task({
			kind: "review",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		// Incident 2026-10-12: a finding waited on a card the gate held, and no card could start.
		const prereq = task({ createdAt: 50, stage: "merging", queuedAt: 600 });
		const finding = task({
			followUpOf: review.id,
			createdAt: 300,
			queuedAt: 700,
			dependsOn: [prereq.id],
		});
		const sub = task({
			followUpOf: finding.id,
			createdAt: 400,
			stage: "merging",
			queuedAt: 650,
		});
		const later = task({
			followUpOf: finding.id,
			createdAt: 800,
			stage: "merging",
			queuedAt: 660,
		});
		const all = [review, prereq, finding, sub, later];
		expect(mergeHold(all, prereq)).toBeNull();
		expect(mergeHold(all, sub)).toBeNull();
		expect(mergeHold(all, later)).toBe(
			"waiting for the review's findings to be implemented",
		);
	});

	test("a done review whose findings are done or cancelled holds no merge", () => {
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const merged = task({
			followUpOf: review.id,
			createdAt: 300,
			stage: "done",
			state: "idle",
			doneAt: 800,
		});
		const dropped = task({
			followUpOf: review.id,
			createdAt: 400,
			cancelledAt: 900,
		});
		const merge = task({ stage: "merging" });
		expect(pickRunnable([review, merged, dropped, merge], opts)).toEqual([
			merge,
		]);
	});

	test("a cancelled review and its findings hold no merge", () => {
		const review = task({
			kind: "review",
			stage: "in_progress",
			state: "needs_you",
			createdAt: 100,
			cancelledAt: 400,
		});
		const finding = task({ followUpOf: review.id, createdAt: 300 });
		const merge = task({ stage: "merging" });
		expect(pickRunnable([review, finding, merge], opts)).toEqual([
			merge,
			finding,
		]);
	});

	test("todo waits for unfinished dependencies", () => {
		const m1 = task({ queuedAt: 100 });
		const m2 = task({ queuedAt: 200, dependsOn: [m1.id] });
		expect(pickRunnable([m1, m2], opts)).toEqual([m1]);
		const done = { ...m1, stage: "done" as const, state: "idle" as const };
		expect(pickRunnable([done, m2], opts)).toEqual([m2]);
	});

	test("cancelled dependency counts as satisfied", () => {
		const m1 = task({ queuedAt: 100, cancelledAt: 1 });
		const m2 = task({ queuedAt: 200, dependsOn: [m1.id] });
		expect(pickRunnable([m1, m2], opts)).toEqual([m2]);
	});

	test("queued in_progress card waits for unfinished dependencies", () => {
		const depInProgress = task({
			stage: "in_progress",
			state: "queued",
			queuedAt: 100,
		});
		const reply = task({
			stage: "in_progress",
			state: "queued",
			pendingPrompt: "hi",
			queuedAt: 300,
			dependsOn: [depInProgress.id],
		});
		expect(pickRunnable([depInProgress, reply], opts)).toEqual([depInProgress]);
		const done = {
			...depInProgress,
			stage: "done" as const,
			state: "idle" as const,
		};
		expect(pickRunnable([done, reply], opts)).toEqual([reply]);
		const cancelled = { ...depInProgress, cancelledAt: 5 };
		expect(pickRunnable([cancelled, reply], opts)).toEqual([reply]);

		const depMerging = task({ stage: "merging", state: "queued" });
		const reply2 = task({
			stage: "in_progress",
			state: "queued",
			pendingPrompt: "hi",
			dependsOn: [depMerging.id],
		});
		expect(pickRunnable([depMerging, reply2], opts)).toEqual([depMerging]);
	});

	test("a held merging card does not block the merge slot", () => {
		const dep = task({ stage: "in_progress", state: "queued" });
		const held = task({
			stage: "merging",
			state: "queued",
			dependsOn: [dep.id],
		});
		const free = task({ stage: "merging", state: "queued" });
		// held is older (queued earlier) but waits on dep; free takes the merge slot, dep a work slot.
		expect(pickRunnable([dep, held, free], opts)).toEqual([free, dep]);

		const done = { ...dep, stage: "done" as const, state: "idle" as const };
		// held takes the merge slot; free (another merge) still waits — one merge turn at a time.
		expect(pickRunnable([done, held, free], opts)).toEqual([held]);
	});

	test("queued in_progress reply waits for unfinished dependencies", () => {
		const undone = task({ queuedAt: 900 });
		const reply = task({
			stage: "in_progress",
			state: "queued",
			pendingPrompt: "hi",
			dependsOn: [undone.id],
		});
		// hasRules false keeps the undone todo itself unpicked, isolating the reply.
		expect(pickRunnable([undone, reply], { ...opts, hasRules: false })).toEqual(
			[],
		);
		const done = { ...undone, stage: "done" as const, state: "idle" as const };
		expect(pickRunnable([done, reply], { ...opts, hasRules: false })).toEqual([
			reply,
		]);
	});
});

describe("depHold", () => {
	test("null with empty dependencies", () => {
		const t = task();
		expect(depHold([t], t)).toBe(null);
	});

	test("waiting message names the unfinished dependency", () => {
		const dep = task({ queuedAt: 100 });
		const t = task({ dependsOn: [dep.id] });
		expect(depHold([dep, t], t)).toBe(`waiting for #${dep.id} ${dep.title}`);
	});

	test("done, cancelled, and unknown dependencies count as satisfied", () => {
		const done = task({ stage: "done", state: "idle" });
		const cancelled = task({ cancelledAt: 5 });
		const t = task({ dependsOn: [done.id, cancelled.id, "nope"] });
		expect(depHold([done, cancelled, t], t)).toBe(null);
	});
});

describe("findingsHold", () => {
	const release = task({
		releaseVersion: "v1.2.3",
		base: "abc",
		stage: "in_progress",
		state: "running",
		createdAt: 100,
	});

	test("a finding the review filed holds the card, merging or not", () => {
		const finding = task({ followUpOf: release.id, createdAt: 150 });
		expect(findingsHold([release, finding], release)).toBe(
			"waiting for the review's findings to be implemented",
		);
		const merging = task({
			followUpOf: release.id,
			createdAt: 150,
			stage: "merging",
			queuedAt: 150,
		});
		expect(findingsHold([release, merging], release)).not.toBeNull();
	});

	test("findings done or cancelled free the card", () => {
		const done = task({
			followUpOf: release.id,
			createdAt: 150,
			stage: "done",
			state: "idle",
			doneAt: 400,
		});
		const dropped = task({
			followUpOf: release.id,
			createdAt: 200,
			cancelledAt: 300,
		});
		expect(findingsHold([release, done, dropped], release)).toBeNull();
	});

	test("a card without the review's link never holds the card", () => {
		// Added by hand mid-review: it waits in merging until the review is done (mergeHold) instead.
		const byHand = task({ createdAt: 150 });
		expect(findingsHold([release, byHand], release)).toBeNull();
	});

	test("a review with no findings is done at once", () => {
		expect(findingsHold([release], release)).toBeNull();
	});
});

describe("reviewBlocked", () => {
	test("one review at a time: an open review or release blocks a new one", () => {
		const review = task({
			kind: "review",
			stage: "in_progress",
			state: "running",
		});
		expect(reviewBlocked([review])).toBe("A review is already in progress.");
		const release = task({
			releaseVersion: "v1.0.0",
			stage: "merging",
			state: "idle",
		});
		expect(reviewBlocked([release])).toBe("A release is already in progress.");
	});

	test("a review blocks until its findings are done, parked or finished earlier", () => {
		const parked = task({
			kind: "review",
			stage: "merging",
			state: "idle",
			createdAt: 100,
		});
		expect(reviewBlocked([parked])).toBe(
			"The last review's findings are not done yet.",
		);
		// A review that finished before reviews parked: done, with a finding still open.
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const finding = task({ followUpOf: review.id, createdAt: 300 });
		expect(reviewBlocked([review, finding])).toBe(
			"The last review's findings are not done yet.",
		);
		const fixed = {
			...finding,
			stage: "done" as const,
			state: "idle" as const,
		};
		expect(reviewBlocked([review, fixed])).toBeNull();
	});

	test("cancelled reviews and plain cards never block", () => {
		const cancelled = task({
			kind: "review",
			cancelledAt: 5,
		});
		expect(reviewBlocked([cancelled, task()])).toBeNull();
	});
});

describe("lastReviewBase", () => {
	test("the frozen base of the newest finished review, release or not", () => {
		const old = task({
			releaseVersion: "v1.0.0",
			base: "aaa",
			stage: "done",
			state: "idle",
			doneAt: 100,
		});
		const review = task({
			kind: "review",
			base: "bbb",
			stage: "done",
			state: "idle",
			doneAt: 300,
		});
		const open = task({
			releaseVersion: "v1.1.0",
			base: "ccc",
			stage: "merging",
			state: "idle",
		});
		const cancelled = task({
			kind: "review",
			base: "ddd",
			stage: "done",
			doneAt: 400,
			cancelledAt: 400,
		});
		const work = task({
			base: "eee",
			stage: "done",
			state: "idle",
			doneAt: 500,
		});
		expect(lastReviewBase([old, review, open, cancelled, work])).toBe("bbb");
		expect(lastReviewBase([work])).toBeNull();
	});
});

describe("arch-review changed-line coverage", () => {
	test("a work card whose prompt contains the marker text is not live as an interview", () => {
		const t = task({ prompt: `stuff ${RULES_INTERVIEW_MARKER} later` });
		expect(liveCard([t], "interview")).toBe(false);
	});
	test("a cancelled architecture review holds nothing", () => {
		const review = task({
			kind: "review",
			stage: "in_progress",
			cancelledAt: 5,
		});
		const merge = task({ stage: "merging", queuedAt: 200 });
		expect(mergeHold([review, merge], merge)).toBeNull();
	});
	test("a finding exactly at the review's doneAt holds; one ms later does not", () => {
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const merge = task({ stage: "merging", queuedAt: 200 });
		const edge = task({
			createdAt: 500,
			followUpOf: review.id,
			stage: "in_progress",
		});
		expect(mergeHold([review, merge, edge], merge)).toBe(
			"waiting for the review's findings to be implemented",
		);
		const later = task({
			createdAt: 501,
			followUpOf: review.id,
			stage: "in_progress",
		});
		expect(mergeHold([review, merge, later], merge)).toBeNull();
	});
	test("a merging dependency still blocks, and depHold lists deps in dependsOn order", () => {
		const depA = task({ createdAt: 10, stage: "merging" });
		const depB = task({ createdAt: 20, stage: "in_progress" });
		const t = task({ dependsOn: [depA.id, depB.id] });
		expect(waitingOn([depA, depB], t)).toEqual([depA, depB]);
		expect(depHold([depA, depB], t)).toBe(
			`waiting for #${depA.id} ${depA.title}, #${depB.id} ${depB.title}`,
		);
		const reversed = task({ dependsOn: [depB.id, depA.id] });
		expect(waitingOn([depA, depB], reversed)).toEqual([depB, depA]);
	});
	// releaseHold's time-window test was dropped: main removed the function; its replacement
	// releaseBlocked (release.ts) is covered by release.test.ts's guard-edge tests.
});

describe("isRetro", () => {
	test("a retro-kind card is a retro", () => {
		expect(isRetro(task({ kind: "retro" }))).toBe(true);
	});
	test("a work card is not a retro", () => {
		expect(isRetro(task())).toBe(false);
	});
});

describe("markers no longer grant privileges (kind is trusted)", () => {
	test("marker prompts on kind-work cards are not retro, review, or interview", () => {
		const retro = task({ prompt: `Retro of task 1\n...` });
		const review = task({ prompt: `${ARCH_REVIEW_MARKER}x`, base: "abc" });
		const interview = task({ prompt: `${RULES_INTERVIEW_MARKER} rules` });
		expect(isRetro(retro)).toBe(false);
		expect(isReview(review)).toBe(false);
		expect(isReview(interview)).toBe(false);
		const tasks = [retro, review, interview];
		expect(liveCard(tasks, "retro")).toBe(false);
		expect(liveCard(tasks, "interview")).toBe(false);
		expect(liveCard(tasks, "review")).toBe(false);
	});

	test("a kind-work interview-prompt card gets no interview exemption in pickRunnable", () => {
		const marked = task({
			prompt: `${RULES_INTERVIEW_MARKER}demo`,
			queuedAt: 100,
		});
		const todo = task({ queuedAt: 200 });
		expect(pickRunnable([marked, todo], { ...opts, hasRules: false })).toEqual(
			[],
		);
	});
});

describe("reviewFindings stops at retro cards", () => {
	test("a retro follow-up of a finding is not a finding and does not hold the review", () => {
		const review = task({
			kind: "review",
			stage: "done",
			doneAt: 100,
		});
		const finding = task({
			createdAt: 50,
			followUpOf: review.id,
			stage: "done",
		});
		const retro = task({
			kind: "retro",
			createdAt: 60,
			followUpOf: finding.id,
			prompt: `Retro of ${finding.title}\n...`,
		});
		const retroChild = task({ createdAt: 61, followUpOf: retro.id });
		expect(
			reviewFindings([review, finding, retro, retroChild], review),
		).toEqual([finding]);
		expect(
			findingsHold([review, finding, retro, retroChild], review),
		).toBeNull();
	});
	test("a retro follow-up of the review itself is not a finding", () => {
		const review = task({
			kind: "review",
			stage: "done",
			doneAt: 100,
		});
		const retro = task({
			kind: "retro",
			createdAt: 50,
			followUpOf: review.id,
			prompt: `Retro of x\n...`,
		});
		expect(reviewFindings([review, retro], review)).toEqual([]);
	});
});

describe("review check policy", () => {
	const f = (
		prompt: string,
		rank: number | null = null,
		security: "critical" | "high" | null = null,
	) => ({ prompt, model: null, rank, security });

	describe("selectFindings", () => {
		test("takes the cap best-ranked findings", () => {
			const picked = selectFindings(
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((r) => f(`p${r}`, r)),
			);
			expect(picked.map((x) => x.rank)).toEqual([
				1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
			]);
		});

		test("a confirmed security finding goes through beyond the cap", () => {
			const recorded = [
				...Array.from({ length: 12 }, (_, i) => f(`p${i + 1}`, i + 1)),
				f("sec", 13, "high"),
				f("sec2", 14, "critical"),
				f("low-sec", 15, null),
			];
			const picked = selectFindings(recorded);
			expect(picked).toHaveLength(12);
			expect(picked.at(-2)).toMatchObject({ prompt: "sec" });
			expect(picked.at(-1)).toMatchObject({ prompt: "sec2" });
			expect(picked.map((x) => x.prompt)).not.toContain("low-sec");
		});

		test("a finding without a rank sorts last and a short list passes whole", () => {
			const picked = selectFindings([f("b", 2), f("none"), f("a", 1)]);
			expect(picked.map((x) => x.prompt)).toEqual(["a", "b", "none"]);
			expect(selectFindings([f("only", 1)])).toHaveLength(1);
		});

		test("ties keep the record order and an empty list stays empty", () => {
			const tied = [f("x", 1), f("y", 1)];
			expect(selectFindings(tied).map((x) => x.prompt)).toEqual(["x", "y"]);
			expect(selectFindings([])).toEqual([]);
		});
	});

	test("checkRoleFor picks critic for Anthropic reviews, adversary otherwise", () => {
		expect(checkRoleFor("anthropic/claude-opus-5-5")).toBe("critic");
		expect(checkRoleFor("openai/gpt-6.1")).toBe("adversary");
		expect(checkRoleFor(null)).toBe("adversary");
	});

	describe("parseCheckVerdicts", () => {
		test("reads a strict JSON array and trims reasons", () => {
			expect(parseCheckVerdicts('[{"id":1,"keep":true,"reason":""}]')).toEqual([
				{ id: 1, keep: true, reason: "" },
			]);
			expect(
				parseCheckVerdicts(
					'preamble [ {"id":2,"keep":false,"reason":" dup "} ] tail',
				),
			).toEqual([{ id: 2, keep: false, reason: "dup" }]);
		});

		test("skips malformed entries instead of failing the run", () => {
			expect(
				parseCheckVerdicts('[{"id":1,"keep":true,"reason":""},{"bad":1},3]'),
			).toEqual([{ id: 1, keep: true, reason: "" }]);
		});

		test("null without a JSON array, without valid JSON, or with a non-array", () => {
			expect(parseCheckVerdicts("no json here")).toBeNull();
			expect(parseCheckVerdicts("[not json]")).toBeNull();
			expect(parseCheckVerdicts('{"id":1}')).toBeNull();
		});
	});

	describe("applyCheckVerdicts", () => {
		test("splits kept and dropped by id, 1-based on the selection", () => {
			const selected = [f("a"), f("b"), f("c")];
			const { kept, dropped } = applyCheckVerdicts(selected, [
				{ id: 2, keep: false, reason: "duplicate of open card #9" },
				{ id: 3, keep: true, reason: "" },
			]);
			expect(kept).toEqual([{ id: 3, finding: selected[2]! }]);
			expect(dropped).toEqual([
				{ id: 1, finding: selected[0]!, reason: "the check gave no verdict" },
				{
					id: 2,
					finding: selected[1]!,
					reason: "duplicate of open card #9",
				},
			]);
		});

		test("a drop without a reason keeps the explicit no-reason note", () => {
			const { dropped } = applyCheckVerdicts(
				[f("a")],
				[{ id: 1, keep: false, reason: "" }],
			);
			expect(dropped).toEqual([
				{ id: 1, finding: f("a"), reason: "no reason given" },
			]);
		});

		test("verdicts flow through the real parse: trimmed reasons, blank drop reason noted", () => {
			const selected = [f("a"), f("b")];
			const verdicts = parseCheckVerdicts(
				'[{"id":1,"keep":false,"reason":"  "},{"id":2,"keep":true,"reason":" ok "}]',
			);
			const { kept, dropped } = applyCheckVerdicts(selected, verdicts ?? []);
			expect(dropped).toEqual([
				{ id: 1, finding: selected[0]!, reason: "no reason given" },
			]);
			expect(kept).toEqual([{ id: 2, finding: selected[1]! }]);
		});
	});
});

describe("work check helpers", () => {
	const verdict = {
		blockers: [
			{ finding: "tests weakened", quote: "const x = 1;" },
			{ finding: "no evidence", quote: "" },
			{ finding: "fabricated", quote: "NOT IN THE SOURCES" },
		],
		notes: ["small nit"],
		fixed: [],
	};

	test("parseWorkCheck reads the strict JSON object and skips malformed entries", () => {
		const parsed = parseWorkCheck(
			'noise {"blockers":[{"finding":"a","quote":"b"},{"finding":3}],"fixed":[{"id":1,"reason":" ok "}],"notes":["n",7]} done',
		);
		expect(parsed).toEqual({
			blockers: [{ finding: "a", quote: "b" }],
			fixed: [{ id: 1, reason: "ok" }],
			notes: ["n"],
		});
		expect(parseWorkCheck("no json here")).toBeNull();
	});

	test("parseWorkCheck keeps valid severity and bugClass, drops malformed ones", () => {
		const parsed = parseWorkCheck(
			'{"blockers":[{"finding":"a","quote":"b","severity":"nit","bugClass":" off-by-one "},{"finding":"c","quote":"d","severity":"huge","bugClass":7}],"fixed":[],"notes":[]}',
		);
		expect(parsed!.blockers).toEqual([
			{ finding: "a", quote: "b", severity: "nit", bugClass: "off-by-one" },
			{ finding: "c", quote: "d", severity: undefined, bugClass: undefined },
		]);
	});

	test("demoteUnquoted demotes nit and pre-existing severities even when quoted", () => {
		const { blockers, notes } = demoteUnquoted(
			{
				blockers: [
					{ finding: "style", quote: "const x = 1;", severity: "nit" },
					{ finding: "old", quote: "const x = 1;", severity: "pre-existing" },
					{ finding: "real", quote: "const x = 1;", bugClass: "off-by-one" },
				],
				notes: [],
				fixed: [],
			},
			"const x = 1;",
			"",
		);
		expect(blockers).toEqual([
			{
				finding: "real",
				quote: "const x = 1;",
				severity: undefined,
				bugClass: "off-by-one",
			},
		]);
		expect(notes).toEqual([
			"style (nit — recorded, not blocking)",
			"old (pre-existing — recorded, not blocking)",
		]);
	});

	test("demoteUnquoted keeps only quotes the diff or transcript contains, demotions first", () => {
		const { blockers, notes } = demoteUnquoted(
			verdict,
			"diff --git a/x.ts const x = 1;",
			"",
		);
		expect(blockers).toEqual([
			{ finding: "tests weakened", quote: "const x = 1;" },
		]);
		expect(notes[0]).toContain("no evidence");
		expect(notes[0]).toContain("(no quote");
		expect(notes[1]).toContain("fabricated");
		expect(notes[1]).toContain("(quote matched nothing");
		expect(notes[2]).toBe("small nit");
	});

	test("demoteUnquoted falls back to the transcript when the diff is empty", () => {
		const { blockers, notes } = demoteUnquoted(
			verdict,
			"",
			"transcript NOT IN THE SOURCES",
		);
		expect(blockers).toEqual([
			{ finding: "fabricated", quote: "NOT IN THE SOURCES" },
		]);
		expect(notes).toHaveLength(3); // two demotions plus the plain note
	});

	test("openWorkBlockers returns the last blockers run's unresolved entries only", () => {
		const runs = [
			{
				at: 1,
				model: null,
				outcome: "blockers" as const,
				blockers: [{ finding: "old", quote: "q", status: "fixed" as const }],
				notes: [],
				durationMs: 1,
			},
			{
				at: 2,
				model: null,
				outcome: "error" as const,
				blockers: [],
				notes: [],
				durationMs: 1,
				error: "quota",
			},
			{
				at: 3,
				model: null,
				outcome: "blockers" as const,
				blockers: [
					{ finding: "live", quote: "q2" },
					{ finding: "done", quote: "q3", status: "overridden" as const },
				],
				notes: [],
				durationMs: 1,
			},
		];
		expect(openWorkBlockers(runs)).toEqual([{ finding: "live", quote: "q2" }]);
		expect(openWorkBlockers([])).toEqual([]);
	});
});

describe("backlog grill slot", () => {
	test("a parked (idle) backlog card is never picked", () => {
		const parked = task({ stage: "backlog", state: "idle", queuedAt: null });
		expect(pickRunnable([parked], opts)).toEqual([]);
	});

	test("a kicked (queued) backlog card is picked in a work slot, one at a time", () => {
		const first = task({ stage: "backlog" });
		const second = task({ stage: "backlog" });
		expect(pickRunnable([first, second], opts)).toEqual([first]);
		expect(pickRunnable([first, second], { ...opts, maxParallel: 8 })).toEqual([
			first,
		]);
	});

	test("a kicked backlog card and a queued todo share the cap, todo first", () => {
		const grill = task({ stage: "backlog" });
		const todo = task({});
		expect(pickRunnable([grill, todo], opts)).toEqual([grill, todo]);
		expect(pickRunnable([grill, todo], { ...opts, maxParallel: 1 })).toEqual([
			grill,
		]);
	});

	test("a drain (`only` on another card) never picks the grill", () => {
		const grill = task({ stage: "backlog" });
		const check = task({});
		expect(pickRunnable([grill, check], { ...opts, only: check.id })).toEqual([
			check,
		]);
	});

	test("a backlog card blocked behind a running grill waits, then runs", () => {
		const running = task({ stage: "backlog", state: "running" });
		const kicked = task({ stage: "backlog" });
		expect(pickRunnable([running, kicked], opts)).toEqual([]);
	});
});
