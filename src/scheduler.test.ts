import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCH_REVIEW_MARKER, RULES_INTERVIEW_MARKER } from "./prompts.ts";
import {
	applyCheckVerdicts,
	archReviewView,
	blockingReview,
	checkModelWarning,
	checkRoleFor,
	checkRoutingNote,
	cyclicDepIds,
	type DepCard,
	type DepIndex,
	type DepProject,
	demoteUnquoted,
	depHold,
	FINDINGS_HOLD,
	findDep,
	findingsHold,
	findingsSettledAt,
	isRetro,
	isReview,
	LEAD_APPLIES_OPTION,
	LEAD_APPLIES_OPTION_LEGACY,
	LEAD_NOT_APPLY_OPTION,
	LEAD_NOT_APPLY_OPTION_LEGACY,
	LEAD_QUESTIONS_PROMPT_PREFIX,
	LEAD_UNSURE_OPTION,
	lastFullReview,
	lastFullReviewBase,
	lastReviewBase,
	leadBlocker,
	leadValidationHold,
	leadValidationStartRefusal,
	leadValidationOutcome,
	legacyLeadWaits,
	liveCard,
	liveCardOf,
	mergeAnywayPatch,
	mergeHold,
	openWorkBlockers,
	overrideWorkBlockers,
	PUSH_HOLD,
	parseCheckVerdicts,
	parseWorkCheck,
	pickLowPriority,
	pickRunnable,
	pushHold,
	queueOrder,
	REVIEW_HOLD_MAX_MS,
	type ReviewHoldDetail,
	releaseHeldMerges,
	repeatedBugClasses,
	resolveDep,
	reviewBlocked,
	reviewFindings,
	reviewHoldsFor,
	SILENT_LOG_MS,
	selectFindings,
	silentSince,
	validatableReview,
	waitingOn,
	workCheckAccountingError,
	workCheckBlockerCounts,
	workCheckCountsDiverged,
	workCheckDivergeAsk,
	workCheckDiverged,
	workCheckDivergeReason,
} from "./scheduler.ts";
import { type NewCodeScanAlert, ProjectStore } from "./store.ts";
import fc from "./test/properties.ts";
import type { CardRef, Task, WorkCheckRun } from "./types.ts";
import { buildCardIndex } from "./ui/cardIndex.ts";
import { projectGraph } from "./ui/status.ts";
import { modelVendor } from "./vendor.ts";

describe("silentSince", () => {
	test("flags a preparing or running log silent past SILENT_LOG_MS, floored; else null", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-silent-"));
		try {
			const log = join(dir, "card.log");
			writeFileSync(log, "x");
			// A sub-millisecond part (where the filesystem keeps it) shows the floor.
			utimesSync(log, 1_700_000_000.0007, 1_700_000_000.0007);
			const at = statSync(log).mtimeMs;
			const late = at + SILENT_LOG_MS + 1;
			expect(SILENT_LOG_MS).toBe(7_200_000);
			expect(silentSince({ state: "running" }, log, late)).toBe(Math.floor(at));
			expect(silentSince({ state: "preparing" }, log, late)).toBe(
				Math.floor(at),
			);
			// Exactly the limit is not yet silent (<=).
			expect(silentSince({ state: "running" }, log, at + SILENT_LOG_MS)).toBe(
				null,
			);
			expect(silentSince({ state: "running" }, log, at + 1000)).toBe(null);
			for (const state of ["needs_you", "queued", "idle"] as const)
				expect(silentSince({ state }, log, late)).toBe(null);
			expect(silentSince({ state: "running" }, join(dir, "none"), late)).toBe(
				null,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("live progress movement counts as activity beside the log mtime", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-silent-"));
		try {
			const log = join(dir, "card.log");
			writeFileSync(log, "x");
			const now = 1_800_000_000_000;
			const setAt = (at: number): number => {
				utimesSync(log, at / 1000, at / 1000);
				return statSync(log).mtimeMs;
			};
			// Log silent past the limit, meter moved a minute ago: no warning (OTTR-448).
			const logAt = setAt(now - SILENT_LOG_MS - 60_000);
			expect(silentSince({ state: "running" }, log, now, now - 60_000)).toBe(
				null,
			);
			// The silence dates from the later activity: here the log, the last progress
			// movement being older.
			const oldMove = setAt(now - SILENT_LOG_MS - 120_000);
			expect(silentSince({ state: "running" }, log, now, logAt)).toBe(
				Math.floor(logAt),
			);
			// A meter frozen past the limit (ALAT-23: elapsed ticks, tested count still)
			// warns from its own last movement even with the log older still.
			const frozen = setAt(now - SILENT_LOG_MS - 60_000);
			utimesSync(log, (frozen - 120_000) / 1000, (frozen - 120_000) / 1000);
			expect(silentSince({ state: "running" }, log, now, frozen)).toBe(
				Math.floor(frozen),
			);
			// No movement recorded (no progress at all, or the demo board's static line):
			// the log-only rule.
			expect(silentSince({ state: "running" }, log, now)).toBe(
				Math.floor(statSync(log).mtimeMs),
			);
			expect(oldMove).toBeLessThan(logAt); // the mixed case above really mixed
			// A past movement warns with no log file yet (a preparing card).
			const stale = now - SILENT_LOG_MS - 1000;
			expect(
				silentSince({ state: "running" }, join(dir, "none"), now, stale),
			).toBe(stale);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mergeAnywayPatch", () => {
	test("overrides open blockers and queues the merge with cleared prompts", () => {
		const log: WorkCheckRun[] = [
			{
				at: 1,
				model: null,
				outcome: "blockers",
				blockers: [
					{ finding: "f", quote: "q" },
					{
						finding: "fixed",
						quote: "q2",
						status: "fixed",
						statusReason: "the code now rejects it",
					},
					{
						finding: "overridden",
						quote: "q3",
						status: "overridden",
						statusReason: "the user accepted this risk",
					},
				],
				notes: [],
				durationMs: 0,
			},
		];
		const completed = structuredClone(log[0]!.blockers.slice(1));
		const before = Date.now();
		const patch = mergeAnywayPatch({ workCheckLog: log }, "why");
		const after = Date.now();
		expect(patch.queuedAt).toBeGreaterThanOrEqual(before);
		expect(patch.queuedAt).toBeLessThanOrEqual(after);
		expect(patch).toEqual({
			workCheckLog: overrideWorkBlockers(log, "why"),
			stage: "merging",
			state: "queued",
			queuedAt: patch.queuedAt,
			pendingPrompt: null,
			pendingBy: null,
			pendingFeedback: false,
			needsReason: null,
			asked: null,
		});
		expect(patch.workCheckLog[0]?.blockers[0]?.statusReason).toBe("why");
		expect(patch.workCheckLog[0]?.blockers.slice(1)).toEqual(completed);
		expect(log[0]?.blockers[0]?.status).toBeUndefined();
	});
});

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
		proposalSummary: null,
		stage: "todo",
		state: "queued",
		needsReason: null,
		pendingPrompt: null,
		pendingBy: null,
		promptAuthor: "user",
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
		findingsCheckedAt: null,
		validatedAt: null,
		leadAtDone: false,
		waitsValidation: false,
		research: false,
		steps: "unknown",
		starred: false,
		createdAt: now,
		updatedAt: now,
		revision: p.revision ?? 1,
		queuedAt: now,
		holdUntil: null,
		holdProvider: null,
		holdWindow: null,
		holdAttempts: 0,
		holdSetAt: null,
		doneAt: null,
		cancelledAt: null,
		commits: null,
		releaseVersion: null,
		releaseNotes: null,
		asked: null,
		model: null,
		keptFiles: [],
		followUpOf: null,
		followUpOfProject: null,
		prNumber: null,
		prUrl: null,
		prHeadSha: null,
		prWatchAt: null,
		ciPrAnsweredKey: null,
		ciPrAnsweredInfo: null,
		pendingFeedback: false,
		sourcePrNumber: null,
		sourcePrUrl: null,
		sourcePrHeadRef: null,
		sourcePrHeadSha: null,
		sourcePrCrossRepo: false,
		sourcePrDependabot: false,
		sourcePrSuperseded: false,
		sourceIssue: null,
		followUpPrNumber: null,
		followUpPrUrl: null,
		pushSha: null,
		pushRetries: 0,
		mergeHead: null,
		topic: null,
		dependsOn: [],
		updateIds: [],
		updateMergeHead: null,
		forkMergeHead: null,
		holdHead: null,
		diffFiles: null,
		diffText: null,
		uncommittedFiles: [],
		workCheckLog: [],
		syncGateLog: [],
		workCheckSendbacks: 0,
		workCheckHead: null,
		workCheckReport: null,
		priority: null,
		closeCandidate: null,
		kind: "work",
		gate: null,
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

	test("liveCardOf returns the live card itself, else null", () => {
		const live = task({ id: "p1-3", kind: "interview", stage: "in_progress" });
		const done = task({ id: "p1-1", kind: "interview", stage: "done" });
		expect(liveCardOf([done, live], "interview")).toBe(live);
		expect(liveCardOf([done], "interview")).toBeNull();
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

describe("push hold (OTTR-506)", () => {
	const opts = { maxParallel: 8, hasRules: true };

	test("while main is unpushed the merge slot takes only the rebase retry card", () => {
		// Card b queued first, the rejected card's retry second: queue order alone would
		// start b and pile its merge onto the unpushed main. The hold inverts the order.
		const held = task({ stage: "merging", queuedAt: 100 });
		const retry = task({ stage: "merging", queuedAt: 200, pushRetries: 1 });
		expect(
			pickRunnable([held, retry], { ...opts, mainUnpushed: true }),
		).toEqual([retry]);
		// Once main reached origin, the hold lifts and the queued merge starts.
		expect(pickRunnable([held, retry], opts)).toEqual([held]);
	});

	test("main unpushed with no retry card holds every merge; work still starts", () => {
		// The post-mortem state: the retry budget is spent (the repair card parked at
		// needs_you) or main was left unpushed by hand — no merge may start until the
		// user repairs main, and the hold must not touch non-merge slots.
		const heldA = task({ stage: "merging", queuedAt: 100 });
		const heldB = task({ stage: "merging", queuedAt: 200 });
		const todo = task({ queuedAt: 300 });
		expect(
			pickRunnable([heldA, heldB, todo], { ...opts, mainUnpushed: true }),
		).toEqual([todo]);
		// A card the user replied to still runs: a push failure parked it needs_you with
		// pushRetries 0, and the reply is the only way its merge turn can push main.
		const replied = task({ stage: "merging", queuedAt: 50, pendingBy: "user" });
		expect(
			pickRunnable([replied, heldA, todo], { ...opts, mainUnpushed: true }),
		).toEqual([replied, todo]);
	});

	test("prMode bypasses the unpushed-main hold and picks a queued merge", () => {
		// PR mode never writes local main, so "waiting for main to reach origin" is inert.
		const held = task({ stage: "merging", queuedAt: 100 });
		expect(
			mergeHold([held], held, { mainUnpushed: true, prMode: true }),
		).toBeNull();
		// Without prMode the PUSH_HOLD still applies.
		expect(mergeHold([held], held, { mainUnpushed: true })).toBe(PUSH_HOLD);
		const todo = task({ queuedAt: 300 });
		expect(
			pickRunnable([held, todo], { ...opts, mainUnpushed: true, prMode: true }),
		).toEqual([held, todo]);
	});

	test("a queued merging card re-merges even with an open PR; an idle one never does", () => {
		// OTTR-799: the merge slot gates on the queued state only, never on
		// prNumber — a PR-carrying card queued for a second merge turn (a CI
		// fix, a reply on a closed PR) must not strand in the queue.
		const withPr = task({ stage: "merging", queuedAt: 100, prNumber: 42 });
		const noPr = task({ stage: "merging", queuedAt: 200 });
		expect(pickRunnable([withPr, noPr], { ...opts, prMode: true })).toEqual([
			withPr,
		]);
		// No prMode condition: the rule is the merge slot's alone.
		expect(pickRunnable([withPr], opts)).toEqual([withPr]);
		// An idle PR card is not queued, so it never takes the slot; the
		// queued card behind it still merges.
		const idle = task({
			stage: "merging",
			state: "idle",
			queuedAt: 300,
			prNumber: 42,
		});
		expect(pickRunnable([idle, noPr], { ...opts, prMode: true })).toEqual([
			noPr,
		]);
	});

	test("pushHold: queued merges wait, the retry card and every other stage run", () => {
		const merging = {
			stage: "merging",
			state: "queued",
			pushRetries: 0,
			pendingBy: null,
		} as const;
		expect(pushHold(true, merging)).toBe(PUSH_HOLD);
		expect(pushHold(true, { ...merging, pushRetries: 2 })).toBeNull();
		// A user reply on a card parked needs_you (pushRetries 0) must still run — see
		// the doc comment: without this the hold deadlocks the repair.
		expect(pushHold(true, { ...merging, pendingBy: "user" })).toBeNull();
		expect(pushHold(true, { ...merging, pendingBy: "supervisor" })).toBe(
			PUSH_HOLD,
		);
		expect(pushHold(true, { ...merging, state: "needs_you" })).toBeNull();
		expect(pushHold(true, { ...merging, state: "idle" })).toBeNull();
		expect(
			pushHold(true, {
				stage: "todo",
				state: "queued",
				pushRetries: 0,
				pendingBy: null,
			}),
		).toBeNull();
		expect(pushHold(false, merging)).toBeNull();
	});

	test("mergeHold reports the push hold, behind a review hold", () => {
		const release = task({
			stage: "merging",
			state: "idle",
			releaseVersion: "v1.0.0",
			base: "abc",
		});
		const merge = task({ stage: "merging" });
		expect(mergeHold([release, merge], merge, { mainUnpushed: true })).toBe(
			"waiting for release v1.0.0",
		);
		expect(mergeHold([merge], merge, { mainUnpushed: true })).toBe(PUSH_HOLD);
		// The git fact is the caller's input: without it the hold stays silent.
		expect(mergeHold([merge], merge)).toBeNull();
	});
});

describe("pickRunnable", () => {
	test("a queued card waits until its holdUntil, whatever its queue position", () => {
		const held = task({ stage: "in_progress", queuedAt: 1, holdUntil: 5_000 });
		expect(pickRunnable([held], { ...opts, now: 4_999 })).toEqual([]);
		expect(pickRunnable([held], { ...opts, now: 5_000 })).toEqual([held]);
	});

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

	test("a posted PR review card parked at in_progress/idle never starts a turn", () => {
		const pr = task({ kind: "pr_review", stage: "in_progress", state: "idle" });
		expect(pickRunnable([pr], opts)).toEqual([]);
		expect(pickLowPriority([pr], opts)).toBeNull();
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

	test("a queued trending scout never takes a normal slot, however old", () => {
		const scout = task({ kind: "trending", queuedAt: 1 });
		const todo = task({ queuedAt: 200 });
		expect(pickRunnable([scout, todo], opts)).toEqual([todo]);
		expect(pickRunnable([scout], { ...opts, maxParallel: null })).toEqual([]);
		const reply = task({ kind: "trending", stage: "in_progress" });
		expect(pickRunnable([reply], opts)).toEqual([]);
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

	test("a cancelled review holds no merge, however open it looks", () => {
		const cancelledReview = task({
			kind: "review",
			stage: "in_progress",
			state: "running",
			cancelledAt: 5,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		// The open review above holds `other`; its cancelled twin must not.
		expect(mergeHold([cancelledReview, other], other)).toBeNull();
		expect(pickRunnable([cancelledReview, other], opts)).toEqual([other]);
	});

	test("a review with only a cancelled finding holds no merge", () => {
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const finding = task({
			followUpOf: review.id,
			createdAt: 300,
			stage: "merging",
			queuedAt: 600,
			cancelledAt: 700,
		});
		const byHand = task({ createdAt: 300, stage: "merging", queuedAt: 800 });
		expect(mergeHold([review, finding, byHand], byHand)).toBeNull();
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
		// The pick runs on the real clock (mergeSlot), so pin one inside the 48 h bound.
		expect(
			pickRunnable([review, other, finding], {
				...opts,
				now: review.createdAt + 60_000,
			}),
		).toEqual([finding]);
	});

	test("an architecture review whose gate never passes frees unrelated merges past the cap (OTTR-1253)", () => {
		// The OTTR-1186 stall: the review sits in_progress (needs_you on a mutation run that
		// cannot pass) while every queued merge waits. Inside the bound the hold still gates;
		// past it the unrelated merge lands (fails before the fix: the hold never expired).
		const review = task({
			kind: "review",
			stage: "in_progress",
			state: "needs_you",
			createdAt: 1_000,
		});
		const waiting = task({ stage: "merging", queuedAt: 2_000 });
		const now = 1_000 + REVIEW_HOLD_MAX_MS;
		expect(mergeHold([review, waiting], waiting, { now: now - 1 })).toBe(
			"waiting for the review to finish",
		);
		expect(mergeHold([review, waiting], waiting, { now })).toBeNull();
		expect(pickRunnable([review, waiting], { ...opts, now })).toEqual([
			waiting,
		]);
	});

	test("a done review's open findings stop holding merges past the cap (OTTR-1253)", () => {
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 900,
			doneAt: 1_000,
		});
		const finding = task({ followUpOf: review.id, createdAt: 950 });
		const waiting = task({ stage: "merging", queuedAt: 100 });
		const now = 1_000 + REVIEW_HOLD_MAX_MS;
		expect(mergeHold([review, finding, waiting], waiting)).toBe(
			"waiting for the review's findings to be implemented",
		);
		expect(mergeHold([review, finding, waiting], waiting, { now })).toBeNull();
	});

	test("a done review's finding is not held by another review's running hold (OTTR-1253, OTTR-940 class)", () => {
		// The observed cycle: review R runs a gate whose score needs finding F's fix, and R's
		// running hold kept F from merging. F is the older review's finding, so it must stay
		// schedulable (fails before the fix: "waiting for the review to finish").
		const done = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const finding = task({
			followUpOf: done.id,
			createdAt: 300,
			stage: "merging",
			queuedAt: 600,
		});
		const running = task({
			kind: "review",
			stage: "in_progress",
			state: "running",
			createdAt: 400,
		});
		expect(mergeHold([done, finding, running], finding)).toBeNull();
		expect(pickRunnable([done, finding, running], opts)).toEqual([finding]);
		// The running review still holds work that is nobody's finding (it gates first
		// when it comes first, and a bare mergeHold call never expires its holds).
		const unrelated = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([running, done, finding, unrelated], unrelated)).toBe(
			"waiting for the review to finish",
		);
	});

	test("a finding still waits for an open release past the cap (OTTR-1253 keeps the release hold)", () => {
		const release = task({
			stage: "merging",
			state: "needs_you",
			releaseVersion: "v1.2.0",
			createdAt: 100,
		});
		const done = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 200,
			doneAt: 300,
		});
		const finding = task({
			followUpOf: done.id,
			createdAt: 250,
			stage: "merging",
			queuedAt: 400,
		});
		const now = 100 + REVIEW_HOLD_MAX_MS;
		expect(mergeHold([release, done, finding], finding, { now })).toBe(
			"waiting for release v1.2.0",
		);
	});

	test("reviewHoldsFor names the review, the anchor and the cap of each hold (OTTR-1253)", () => {
		const review = task({
			id: "OTTR-1186",
			kind: "review",
			stage: "in_progress",
			state: "needs_you",
			createdAt: 1_000,
		});
		const release = task({
			id: "OTTR-2",
			stage: "merging",
			state: "needs_you",
			releaseVersion: "v3.0.0",
			createdAt: 2_000,
		});
		const waiting = task({ stage: "merging", queuedAt: 100 });
		const holds = reviewHoldsFor([review, release, waiting], waiting, 3_000);
		const running = holds.find(
			(h) => h.hold === "waiting for the review to finish",
		);
		const rel = holds.find((h) => h.hold === "waiting for release v3.0.0");
		expect((running as ReviewHoldDetail).reviewId).toBe("OTTR-1186");
		expect((running as ReviewHoldDetail).since).toBe(1_000);
		expect((running as ReviewHoldDetail).capAt).toBe(
			1_000 + REVIEW_HOLD_MAX_MS,
		);
		expect((rel as ReviewHoldDetail).reviewId).toBe("OTTR-2");
		expect((rel as ReviewHoldDetail).capAt).toBeNull();
		// Past the cap the running hold is gone; the uncapped release hold stays.
		expect(
			reviewHoldsFor(
				[review, release, waiting],
				waiting,
				1_000 + REVIEW_HOLD_MAX_MS,
			).map((h) => h.hold),
		).toEqual(["waiting for release v3.0.0"]);
		// A card without a finite createdAt never expires (report fixtures).
		const stampless = task({
			id: "OTTR-3",
			kind: "review",
			stage: "in_progress",
			state: "running",
			createdAt: Number.NaN,
		});
		expect(
			reviewHoldsFor(
				[stampless, waiting],
				waiting,
				Number.MAX_SAFE_INTEGER,
			).map((h) => h.hold),
		).toEqual(["waiting for the review to finish"]);
	});

	test("releaseHeldMerges names the queued merges an open release holds", () => {
		const release = task({
			stage: "merging",
			state: "needs_you",
			releaseVersion: "v0.3.0",
			base: "abc",
			doneAt: 900,
		});
		const held = task({ stage: "merging", queuedAt: 100 });
		const finding = task({
			followUpOf: release.id,
			createdAt: 800,
			stage: "merging",
			queuedAt: 200,
		});
		const cancelled = task({
			stage: "merging",
			queuedAt: 300,
			cancelledAt: 400,
		});
		expect(
			releaseHeldMerges([release, held, finding, cancelled], release),
		).toEqual([held]);
	});

	test("releaseHeldMerges holds nothing for a done or cancelled release or a plain review", () => {
		const held = task({ stage: "merging", queuedAt: 100 });
		const done = task({
			stage: "done",
			state: "idle",
			releaseVersion: "v0.3.0",
			doneAt: 500,
		});
		const cancelled = task({
			stage: "merging",
			releaseVersion: "v0.3.0",
			cancelledAt: 10,
		});
		const button = task({ kind: "review", stage: "in_progress" });
		expect(releaseHeldMerges([done, held], done)).toEqual([]);
		expect(releaseHeldMerges([cancelled, held], cancelled)).toEqual([]);
		expect(releaseHeldMerges([button, held], button)).toEqual([]);
	});

	test("findingsSettledAt is the latest finding end, else the review's doneAt", () => {
		const release = task({
			stage: "done",
			state: "idle",
			doneAt: 500,
		});
		const first = task({
			followUpOf: release.id,
			createdAt: 100,
			stage: "done",
			state: "idle",
			doneAt: 100,
		});
		const second = task({
			followUpOf: release.id,
			createdAt: 150,
			stage: "done",
			state: "idle",
			doneAt: 200,
		});
		expect(findingsSettledAt([release, first, second], release)).toBe(200);
		// A cancelled finding settles at its cancelledAt, past every doneAt here.
		const lateCancelled = task({
			followUpOf: release.id,
			createdAt: 150,
			stage: "merging",
			doneAt: 250,
			cancelledAt: 300,
		});
		expect(
			findingsSettledAt([release, first, second, lateCancelled], release),
		).toBe(300);
	});

	test("findingsSettledAt waits for an open finding and falls back to doneAt", () => {
		const release = task({ stage: "merging", doneAt: 400 });
		const open = task({
			followUpOf: release.id,
			createdAt: 100,
			stage: "todo",
			doneAt: 100,
		});
		expect(findingsSettledAt([release, open], release)).toBeNull();
		expect(findingsSettledAt([release], release)).toBe(400);
		expect(
			findingsSettledAt([release], { ...release, doneAt: null }),
		).toBeNull();
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
		expect(
			pickRunnable([review, finding, other], {
				...opts,
				now: review.createdAt + 60_000,
			}),
		).toEqual([finding]);
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

	test("a done review's backlog lead never holds another merge (OTTR-889)", () => {
		// VELV-122: a settled release review's unverified lead filed as a backlog
		// card parked every later merge of the project forever.
		const review = task({
			kind: "review",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const fixed = task({
			followUpOf: review.id,
			createdAt: 300,
			stage: "done",
			state: "idle",
			doneAt: 600,
		});
		const lead = task({
			followUpOf: review.id,
			createdAt: 310,
			stage: "backlog",
			state: "idle",
			queuedAt: null,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([review, fixed, lead, other], other)).toBeNull();
		// The parked lead stays parked; the queued merge runs.
		expect(pickRunnable([review, fixed, lead, other], opts)).toEqual([other]);
	});

	test("a done release's promoted lead never holds another merge (OTTR-963)", () => {
		// ALAT and velvarr 2026-11-15: the lead sat in the backlog when the release
		// finished (OTTR-889's exemption), the user promoted it, and findingOpen then
		// counted it again — every other merge of the project parked for hours. The
		// store stamped leadAtDone when the release settled (store.test.ts runs the
		// real write); the flag is the recorded stage at doneAt and survives the
		// promotion and any later re-queue.
		const review = task({
			kind: "review",
			releaseVersion: "v0.4.0",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const lead = task({
			followUpOf: review.id,
			createdAt: 310,
			stage: "in_progress",
			state: "running",
			queuedAt: 700,
			leadAtDone: true,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([review, lead, other], other)).toBeNull();
		expect(pickRunnable([review, lead, other], opts)).toEqual([other]);
		// The same lead waiting to merge holds nothing either, and a re-queue that
		// rewrote its queuedAt after doneAt changes nothing.
		const ready = {
			...lead,
			stage: "merging" as const,
			state: "queued" as const,
			queuedAt: 900,
		};
		expect(mergeHold([review, ready, other], other)).toBeNull();
	});

	test("the board's card graph keeps leadAtDone, so a promoted lead holds nothing (OTTR-1255 send-back 13)", () => {
		// The board's hold gates read projectGraph rows built from the state
		// frame's CardRef list. The adapter must carry the store's leadAtDone
		// flag verbatim: inventing false re-held every merge behind a promoted
		// lead once its review had finished (OTTR-963's exact incident, through
		// the new path).
		const cref = (p: Partial<CardRef>): CardRef => ({
			id: "x",
			project: "p",
			sessionTitle: "t",
			kind: "work",
			stage: "done",
			state: "idle",
			cancelledAt: null,
			createdAt: 100,
			updatedAt: 200,
			doneAt: null,
			followUpOf: null,
			followUpOfProject: null,
			asked: null,
			dependsOn: [],
			commits: 0,
			releaseVersion: null,
			queuedAt: null,
			leadAtDone: false,
			...p,
		});
		const review = cref({
			id: "R-1",
			kind: "review",
			releaseVersion: "v0.4.0",
			stage: "done",
			doneAt: 500,
		});
		const promoted = cref({
			id: "F-1",
			followUpOf: "R-1",
			followUpOfProject: "p",
			stage: "in_progress",
			state: "running",
			createdAt: 310,
			doneAt: null,
			leadAtDone: true,
		});
		const other = cref({ id: "M-1", stage: "merging" });
		const index = buildCardIndex([review, promoted, other]);
		const graph = projectGraph(index, "p");
		// The flag survives the adapter verbatim.
		expect(graph.find((r) => r.id === "F-1")?.leadAtDone).toBe(true);
		const mergeRow = {
			id: "M-1",
			stage: "merging" as const,
			state: "queued" as const,
			pushRetries: 0,
			pendingBy: null,
		};
		expect(mergeHold(graph, mergeRow)).toBeNull();
		// The negative control: an open finding that was NOT a lead at doneAt
		// still holds the merge, so the flag is read, not merely absent.
		const commitment = cref({
			id: "F-1",
			followUpOf: "R-1",
			followUpOfProject: "p",
			stage: "in_progress",
			state: "running",
			createdAt: 310,
			doneAt: null,
			leadAtDone: false,
		});
		const holding = projectGraph(
			buildCardIndex([review, commitment, other]),
			"p",
		);
		expect(mergeHold(holding, mergeRow)).toBe(
			"waiting for the review's findings to be implemented",
		);
	});

	test("a done release's open non-lead finding still holds other merges (OTTR-963)", () => {
		const review = task({
			kind: "review",
			releaseVersion: "v0.4.0",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		// A commitment when the review finished: no lead flag, and it holds even when
		// a reply re-queued it after doneAt (queuedAt 700 is after doneAt 500).
		const finding = task({
			followUpOf: review.id,
			createdAt: 300,
			stage: "merging",
			queuedAt: 700,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([review, finding, other], other)).toBe(FINDINGS_HOLD);
		expect(
			pickRunnable([review, finding, other], {
				...opts,
				now: (review.doneAt ?? review.createdAt) + 60_000,
			}),
		).toEqual([finding]);
	});

	test("an older release's finding does not wait for a newer open release's findings (OTTR-940)", () => {
		// velvarr 2026-11-13: every merge parked in a hold cycle. The done release's
		// finding waited for the open release, the open release waited for its own
		// finding, and that finding waited for the done release's findings.
		const older = task({
			kind: "review",
			releaseVersion: "v0.41.0",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const f1 = task({
			followUpOf: older.id,
			createdAt: 300,
			stage: "merging",
			queuedAt: 600,
		});
		const newer = task({
			kind: "review",
			releaseVersion: "v0.42.0",
			base: "def",
			stage: "merging",
			state: "idle",
			needsReason: FINDINGS_HOLD,
			createdAt: 700,
		});
		const f2 = task({
			followUpOf: newer.id,
			createdAt: 800,
			stage: "merging",
			queuedAt: 900,
		});
		// F2 is a finding, so the older review's findings never hold it: the cycle
		// opens and the queue runs. F1 still waits for the open release itself.
		expect(mergeHold([older, f1, newer, f2], f2)).toBeNull();
		expect(mergeHold([older, f1, newer, f2], f1)).toBe(
			"waiting for release v0.42.0",
		);
		expect(pickRunnable([older, f1, newer, f2], opts)).toEqual([f2]);
		// A normal card still waits: for the older review's findings and for the
		// open release.
		const normal = task({ stage: "merging", queuedAt: 650 });
		expect(mergeHold([older, f1, newer, f2, normal], normal)).toBe(
			"waiting for the review's findings to be implemented",
		);
		const f1done = {
			...f1,
			stage: "done" as const,
			state: "idle" as const,
			doneAt: 940,
		};
		expect(mergeHold([older, f1done, newer, f2, normal], normal)).toBe(
			"waiting for release v0.42.0",
		);
		// The queue drains F2, the newer release settles on its findings, and then
		// F1 merges too: every card reaches done.
		const f2done = {
			...f2,
			stage: "done" as const,
			state: "idle" as const,
			doneAt: 950,
		};
		expect(mergeHold([older, f1, newer, f2done], f1)).toBe(
			"waiting for release v0.42.0",
		);
		const newerDone = {
			...newer,
			stage: "done" as const,
			state: "idle" as const,
			needsReason: null,
			doneAt: 960,
		};
		expect(mergeHold([older, f1, newerDone, f2done], f1)).toBeNull();
		expect(pickRunnable([older, f1, newerDone, f2done, normal], opts)).toEqual([
			f1,
		]);
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

describe("pickLowPriority", () => {
	test("returns the oldest queued trending scout while the project has a free slot", () => {
		const newer = task({ kind: "trending", queuedAt: 300 });
		const older = task({ kind: "trending", queuedAt: 100 });
		const todo = task({ queuedAt: 50 });
		expect(pickLowPriority([newer, older, todo], opts)).toBe(older);
		// A reply to a scout requeues it in_progress: still the low-priority slot.
		const reply = task({ kind: "trending", stage: "in_progress" });
		expect(pickLowPriority([reply], opts)).toBe(reply);
		// No scout queued: nothing.
		expect(pickLowPriority([todo], opts)).toBeNull();
	});

	test("returns null when every slot is taken", () => {
		const scout = task({ kind: "trending" });
		const r1 = task({ state: "running" });
		const r2 = task({ state: "preparing" });
		expect(pickLowPriority([r1, r2, scout], opts)).toBeNull();
		expect(pickLowPriority([r1, scout], opts)).toBe(scout);
		// A null maxParallel never runs out of slots.
		expect(
			pickLowPriority([r1, r2, scout], { ...opts, maxParallel: null }),
		).toBe(scout);
	});

	test("skips cancelled, held and non-queued scouts; a drain lets none start", () => {
		const cancelled = task({ kind: "trending", cancelledAt: 500 });
		const idle = task({ kind: "trending", state: "needs_you" });
		const held = task({ kind: "trending", holdUntil: 5_000 });
		expect(
			pickLowPriority([cancelled, idle, held], { ...opts, now: 4_999 }),
		).toBeNull();
		expect(pickLowPriority([held], { ...opts, now: 5_000 })).toBe(held);
		const scout = task({ kind: "trending" });
		expect(pickLowPriority([scout], { ...opts, only: null })).toBeNull();
		expect(pickLowPriority([scout], { ...opts, only: scout.id })).toBe(scout);
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

describe("cross-project dependencies (OTTR-708)", () => {
	/** One resolver-side project: a prefix handle and its cards, addressable by id. */
	const side = (
		prefix: string,
		cards: Task[],
		name = prefix.toLowerCase(),
	): DepProject => ({
		name,
		prefix,
		getTask: (id) => cards.find((t) => t.id === id) ?? null,
	});

	test("resolveDep prefers the own project's card whatever the id looks like", () => {
		const own = side("P1", [task({ id: "AD-1", title: "local twin" })]);
		const other = side("AD", [task({ id: "AD-1", title: "foreign twin" })]);
		expect(resolveDep("AD-1", [own, other], own)).toEqual({
			task: own.getTask("AD-1")!,
			project: "p1",
		});
	});

	test("a foreign PREFIX-n id resolves through the id handle", () => {
		const own = side("P1", []);
		const other = side("AD", [task({ id: "AD-5", title: "over there" })]);
		expect(resolveDep("AD-5", [own, other], own)).toEqual({
			task: other.getTask("AD-5")!,
			project: "ad",
		});
	});

	test("an unknown prefix, a shared prefix, and a missing card are misses", () => {
		const own = side("P1", []);
		const other = side("AD", []);
		expect(resolveDep("NOPE-1", [own, other], own)).toEqual({
			why: "project",
			id: "NOPE-1",
			prefix: "NOPE",
		});
		const twin = side("AD", [task({ id: "AD-5" })], "ad2");
		expect(resolveDep("AD-5", [own, other, twin], own)).toEqual({
			why: "ambiguous",
			id: "AD-5",
			prefix: "AD",
			projects: ["ad", "ad2"],
		});
		expect(resolveDep("AD-9", [own, other], own)).toEqual({
			why: "task",
			id: "AD-9",
			project: "ad",
		});
	});

	test("a cross-project dependency holds until the foreign card is done or cancelled", () => {
		const dep = task({ id: "AD-5", title: "over there", stage: "in_progress" });
		const t = task({ dependsOn: ["AD-5"] });
		const own = side("P1", []);
		const other = side("AD", [dep]);
		const crossDeps: DepIndex = (id) => findDep(id, [own, other], own);
		expect(pickRunnable([t], { ...opts, crossDeps })).toEqual([]);
		expect(depHold([t], t, crossDeps)).toBe("waiting for #AD-5 over there");
		// Done or cancelled: satisfied, like a local dependency.
		dep.stage = "done";
		expect(pickRunnable([t], { ...opts, crossDeps })).toEqual([t]);
		dep.stage = "in_progress";
		dep.cancelledAt = 5;
		expect(pickRunnable([t], { ...opts, crossDeps })).toEqual([t]);
	});

	test("an unresolvable foreign id never holds; validation is the settle block's job", () => {
		const t = task({ dependsOn: ["NOPE-5", "AD-404"] });
		const own = side("P1", []);
		const other = side("AD", []);
		const crossDeps: DepIndex = (id) => findDep(id, [own, other], own);
		expect(pickRunnable([t], { ...opts, crossDeps })).toEqual([t]);
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

describe("the doneAt cutoff is inclusive at the same millisecond (CI 43875479904)", () => {
	test("a validation run filed in the review's done millisecond never holds; a work follow-up does", () => {
		// OTTR-1047's one CI failure, deterministic: the board files a validation
		// run as a followUpOf child of the done review. When the filing lands in
		// the SAME millisecond as the review's done stamp (a fast runner),
		// `createdAt <= doneAt` counts it as a finding. OTTR-1128 changed the rule:
		// a validation run (kind "validation") never holds a merge in any stage, so
		// it cannot hold the queued merge any more. The inclusive cutoff still
		// holds for an untagged work follow-up filed in the same millisecond: it is
		// stage todo, an open finding whose leadAtDone is false (it did not exist
		// when the review landed done, OTTR-963), so a queued merge waits.
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 5_000,
		});
		const validation = task({
			kind: "validation",
			followUpOf: review.id,
			createdAt: 5_000,
		});
		const merge = task({ stage: "merging", state: "queued" });
		expect(mergeHold([review, validation, merge], merge)).toBeNull();
		const work = task({ followUpOf: review.id, createdAt: 5_000 });
		expect(mergeHold([review, work, merge], merge)).toBe(FINDINGS_HOLD);
	});

	test("a lead filed in the same millisecond never holds: backlog is not open", () => {
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 5_000,
		});
		const lead = task({
			followUpOf: review.id,
			createdAt: 5_000,
			stage: "backlog",
			state: "idle",
			queuedAt: null,
		});
		const merge = task({ stage: "merging", state: "queued" });
		expect(mergeHold([review, lead, merge], merge)).toBeNull();
	});

	test("a child filed after the done millisecond is no finding at all", () => {
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 5_000,
		});
		const validation = task({
			kind: "validation",
			followUpOf: review.id,
			createdAt: 5_001,
		});
		const merge = task({ stage: "merging", state: "queued" });
		expect(mergeHold([review, validation, merge], merge)).toBeNull();
	});
});

describe("OTTR-1128: a lead never runs as a work turn and never holds its review", () => {
	/** The board card form of `t`: no prompt, plus the `lead` mark for a lead. */
	const boardCard = (t: Task, lead: boolean) => {
		const { prompt: _prompt, ...rest } = t;
		return lead ? { ...rest, lead: true as const } : rest;
	};
	const leadsOf = (review: Task) => [
		task({
			prompt: "Needs validation: a todo lead",
			followUpOf: review.id,
			createdAt: 150,
		}),
		task({
			prompt: "Needs validation: an in_progress lead",
			followUpOf: review.id,
			createdAt: 160,
			stage: "in_progress",
			state: "needs_you",
		}),
	];

	test("a release at merging whose only open findings are leads is free to finish", () => {
		const release = task({
			releaseVersion: "v9.9.9",
			stage: "merging",
			state: "idle",
			createdAt: 100,
		});
		const leads = leadsOf(release);
		const merge = task({ stage: "merging", state: "queued" });
		const tasks = [release, ...leads, merge];
		expect(findingsHold(tasks, release)).toBeNull();
		// The unrelated merge still waits for the release to ship, never for the leads.
		expect(mergeHold(tasks, merge)).toBe("waiting for release v9.9.9");
		// The board card form: no prompt, the `lead` mark instead.
		const board = [
			boardCard(release, false),
			...leads.map((l) => boardCard(l, true)),
		];
		expect(findingsHold(board, release)).toBeNull();
		expect(mergeHold([...board, merge], merge)).toBe(
			"waiting for release v9.9.9",
		);
	});

	test("the Review button's review at merging is free once only leads are open", () => {
		const review = task({
			kind: "review",
			stage: "merging",
			state: "idle",
			createdAt: 100,
		});
		const leads = leadsOf(review);
		expect(findingsHold([review, ...leads], review)).toBeNull();
		const board = [
			boardCard(review, false),
			...leads.map((l) => boardCard(l, true)),
		];
		expect(findingsHold(board, review)).toBeNull();
	});

	test("a done review's promoted leads and its validation run never hold a merge", () => {
		// leadAtDone false: the leads were not parked backlog leads at doneAt, so only
		// the OTTR-1128 lead rule frees the merge.
		const review = task({
			kind: "review",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 5_000,
		});
		const leads = leadsOf(review);
		const validation = task({
			kind: "validation",
			followUpOf: review.id,
			createdAt: 170,
			stage: "in_progress",
		});
		const merge = task({ stage: "merging", state: "queued" });
		expect(mergeHold([review, ...leads, validation, merge], merge)).toBeNull();
		const board = [
			boardCard(review, false),
			...leads.map((l) => boardCard(l, true)),
			boardCard(validation, false),
		];
		expect(mergeHold([...board, merge], merge)).toBeNull();
	});

	test("a non-lead finding in todo still holds (control)", () => {
		const release = task({
			releaseVersion: "v9.9.8",
			stage: "merging",
			state: "idle",
			createdAt: 100,
		});
		const finding = task({
			prompt: "Fix the rate limiter",
			followUpOf: release.id,
			createdAt: 150,
		});
		const tasks = [release, ...leadsOf(release), finding];
		expect(findingsHold(tasks, release)).toBe(FINDINGS_HOLD);
		// The board form of the same finding (no lead mark) holds too.
		expect(
			findingsHold(
				tasks.map((t) => boardCard(t, t !== finding && t !== release)),
				release,
			),
		).toBe(FINDINGS_HOLD);
		// The review's question card is no lead: its hyphenated prefix holds.
		const question = task({
			prompt: `${LEAD_QUESTIONS_PROMPT_PREFIX} x`,
			followUpOf: release.id,
			createdAt: 150,
		});
		expect(findingsHold([release, question], release)).toBe(FINDINGS_HOLD);
	});

	test("pickRunnable never starts a lead that waits for a sandbox", () => {
		const many = { ...opts, maxParallel: 10 };
		const todoLead = task({ prompt: "Needs validation: rate limiter" });
		const startedLead = task({
			prompt: "Needs validation: retry\nBlocker: sandbox run: no network deny",
			stage: "in_progress",
		});
		expect(pickRunnable([todoLead, startedLead], many)).toEqual([]);
		const validated = task({
			prompt: "Needs validation: proven",
			validatedAt: 5,
		});
		const deployment = task({
			prompt:
				"Needs validation: proxy\nBlocker: deployment fact: Does a trusted proxy set X-Forwarded-For?",
		});
		const normal = task();
		expect(
			pickRunnable(
				[todoLead, startedLead, validated, deployment, normal],
				many,
			),
		).toEqual([validated, deployment, normal]);
	});

	test("leadValidationHold names the review for a queued sandbox lead only", () => {
		const lead = task({
			prompt: "Needs validation: retry\nBlocker: sandbox run: no network deny",
			followUpOf: "id00001",
		});
		expect(leadValidationHold(lead)).toBe(
			"Waits for a validation run of review id00001; a work turn has no sandbox_run.",
		);
		// Without a linked review the wait names no id (the routing tick parks the
		// lead with LEAD_NO_REVIEW_REASON on the next pass).
		expect(leadValidationHold({ ...lead, followUpOf: null })).toBe(
			"Waits for a validation run; a work turn has no sandbox_run.",
		);
		// A wire row (TaskCard) ships no prompt: the taskView stamp decides instead.
		expect(
			leadValidationHold({ ...lead, prompt: undefined, sandboxLead: true }),
		).toBe(
			"Waits for a validation run of review id00001; a work turn has no sandbox_run.",
		);
		// A wire row of a deployment-fact lead carries no stamp and shows no hold.
		expect(
			leadValidationHold({
				prompt: undefined,
				validatedAt: null,
				followUpOf: "id00001",
				stage: "todo",
				state: "queued",
				cancelledAt: null,
			}),
		).toBeNull();
		// The designed states stay quiet.
		expect(leadValidationHold({ ...lead, stage: "backlog" })).toBeNull();
		expect(leadValidationHold({ ...lead, validatedAt: 5 })).toBeNull();
		expect(leadValidationHold({ ...lead, cancelledAt: 9 })).toBeNull();
		expect(
			leadValidationHold(
				task({
					prompt:
						"Needs validation: proxy\nBlocker: deployment fact: Does a trusted proxy set X-Forwarded-For?",
					followUpOf: "id00001",
				}),
			),
		).toBeNull();
		expect(leadValidationHold(task())).toBeNull();
	});

	test("leadValidationStartRefusal mirrors the start's gates on both sides", () => {
		const lead = task({
			prompt: "Needs validation: parked\nBlocker: sandbox run: sx",
			followUpOf: "id00001",
		});
		expect(leadValidationStartRefusal(lead, "id00001")).toBeNull();
		expect(leadValidationStartRefusal(lead, "other")).toBe("mismatch");
		expect(
			leadValidationStartRefusal({ ...lead, cancelledAt: 1 }, "id00001"),
		).toBe("unknown");
		// A store row without the lead tag, and a deployment-fact lead, are no batch.
		expect(
			leadValidationStartRefusal({ ...lead, prompt: "plain work" }, "id00001"),
		).toBe("not-lead");
		expect(
			leadValidationStartRefusal(
				task({
					prompt:
						"Needs validation: proxy\nBlocker: deployment fact: Which proxy?",
					followUpOf: "id00001",
				}),
				"id00001",
			),
		).toBe("not-lead");
		// A wire row carries the stamp instead of the prompt.
		expect(
			leadValidationStartRefusal(
				{ ...lead, prompt: undefined, sandboxLead: true },
				"id00001",
			),
		).toBeNull();
		// The state gates: a steer's queued reply, a started lead, a backlog lead.
		expect(
			leadValidationStartRefusal(
				{ ...lead, pendingPrompt: "steer" },
				"id00001",
			),
		).toBe("state");
		expect(
			leadValidationStartRefusal({ ...lead, worktree: "/w" }, "id00001"),
		).toBe("state");
		expect(
			leadValidationStartRefusal({ ...lead, stage: "backlog" }, "id00001"),
		).toBe("state");
		expect(
			leadValidationStartRefusal({ ...lead, state: "idle" }, "id00001"),
		).toBe("state");
	});

	test("validatableReview: a done review, or one idle at merging", () => {
		const review = (p: Partial<Task>) =>
			validatableReview(task({ kind: "review", ...p }));
		expect(review({ stage: "done", state: "idle" })).toBe(true);
		expect(review({ stage: "merging", state: "idle" })).toBe(true);
		expect(
			validatableReview(
				task({ releaseVersion: "v1.0.0", stage: "merging", state: "idle" }),
			),
		).toBe(true);
		expect(review({ stage: "merging", state: "queued" })).toBe(false);
		expect(review({ stage: "merging", state: "running" })).toBe(false);
		expect(review({ stage: "in_progress", state: "idle" })).toBe(false);
		expect(review({ stage: "done", state: "idle", cancelledAt: 9 })).toBe(
			false,
		);
		expect(validatableReview(task({ stage: "done", state: "idle" }))).toBe(
			false,
		);
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
		// The chip links to the review card, not the finding, while findings keep it open.
		expect(blockingReview([review, finding])?.id).toBe(review.id);
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

describe("lastFullReviewBase", () => {
	test("a done release does not move the base, a done full review does", () => {
		const review = task({
			kind: "review",
			base: "aaa",
			stage: "done",
			state: "idle",
			doneAt: 100,
		});
		const release = task({
			releaseVersion: "v1.0.0",
			base: "bbb",
			stage: "done",
			state: "idle",
			doneAt: 300,
		});
		// The release ran after the full review, but only a full review resets the counter.
		expect(lastFullReviewBase([review, release])).toBe("aaa");
		const laterReview = task({
			kind: "review",
			base: "ccc",
			stage: "done",
			state: "idle",
			doneAt: 500,
		});
		expect(lastFullReviewBase([review, release, laterReview])).toBe("ccc");
		const open = task({
			releaseVersion: "v1.1.0",
			base: "ddd",
			stage: "merging",
			state: "idle",
		});
		const cancelled = task({
			kind: "review",
			base: "eee",
			stage: "done",
			doneAt: 600,
			cancelledAt: 600,
		});
		const work = task({
			base: "fff",
			stage: "done",
			state: "idle",
			doneAt: 700,
		});
		// Open, cancelled and work cards do not move it either.
		expect(lastFullReviewBase([review, release, open, cancelled, work])).toBe(
			"aaa",
		);
		expect(lastFullReviewBase([work])).toBeNull();
	});
});

describe("archReviewView", () => {
	test("a done full review names its base and card; a later release leaves both in place", () => {
		const review = task({
			kind: "review",
			base: "aaa",
			stage: "done",
			state: "idle",
			doneAt: 100,
		});
		// The delta stub returns the anchor the real archReviewDelta would: the base it was
		// given, so the view reads the same commit the count starts from.
		const delta = (anchor: string) => ({
			delta: 12,
			reviewed: anchor !== "",
			anchor,
		});
		expect(
			archReviewView(lastFullReview([review]), delta("aaa"), 30, null),
		).toEqual({
			delta: 12,
			reviewed: true,
			base: "aaa",
			reviewCardId: review.id,
			cap: 30,
			due: false,
			running: false,
			runningCardId: null,
		});
		// The release ran after the full review, so it froze a newer base — but only a full
		// review resets the counter: base and card id still name the full review.
		const release = task({
			kind: "review",
			releaseVersion: "v1.0.0",
			base: "bbb",
			stage: "done",
			state: "idle",
			doneAt: 300,
		});
		const view = archReviewView(
			lastFullReview([review, release]),
			delta("aaa"),
			30,
			null,
		);
		expect(view.base).toBe("aaa");
		expect(view.reviewCardId).toBe(review.id);
	});

	test("a newer baseline docs commit moves the base and drops the card id", () => {
		const review = task({
			kind: "review",
			base: "aaa",
			stage: "done",
			state: "idle",
			doneAt: 100,
		});
		// archReviewDelta anchors on the newer docs(arch-review): commit: no card set that base.
		expect(
			archReviewView(
				lastFullReview([review]),
				{ delta: 1, reviewed: true, anchor: "zzz" },
				30,
				null,
			),
		).toEqual({
			delta: 1,
			reviewed: true,
			base: "zzz",
			reviewCardId: null,
			cap: 30,
			due: false,
			running: false,
			runningCardId: null,
		});
	});

	test("no full review yet: the base is null and the whole history counts", () => {
		expect(
			archReviewView(
				lastFullReview([]),
				{ delta: 9, reviewed: false, anchor: "" },
				30,
				null,
			),
		).toEqual({
			delta: 9,
			reviewed: false,
			base: null,
			reviewCardId: null,
			cap: 30,
			// An un-reviewed project is always due, whatever its history size.
			due: true,
			running: false,
			runningCardId: null,
		});
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

	test("checkRoleFor keeps today's roles for Claude and GPT runs on today's board", () => {
		// Today's setup: critic = an OpenAI model, adversary = an Anthropic model.
		const roles = {
			critic: "openai/gpt-6",
			adversary: "anthropic/claude-opus-5-5",
		};
		// Claude through another provider is still Anthropic: the critic role checks it.
		expect(checkRoleFor(null, roles, "anthropic/claude-opus-5-5")).toBe(
			"critic",
		);
		expect(checkRoleFor(null, roles, "github-copilot/claude-sonnet-4-5")).toBe(
			"critic",
		);
		expect(
			checkRoleFor(null, roles, "openrouter/anthropic/claude-opus-4-1"),
		).toBe("critic");
		expect(
			checkRoleFor(null, roles, "bedrock/us.anthropic.claude-sonnet-4-5"),
		).toBe("critic");
		// A GPT run gets the Anthropic adversary.
		expect(checkRoleFor(null, roles, "openai/gpt-6.1")).toBe("adversary");
		expect(checkRoleFor(null, roles, "openai-codex/gpt-5.6-luna")).toBe(
			"adversary",
		);
		// A third vendor gets the OpenAI critic: a real second vendor's opinion, the
		// routing this change introduces (the old rule sent it to the adversary too).
		expect(checkRoleFor(null, roles, "zai/glm-5.3-flash")).toBe("critic");
		// An unknown or unset work model: the OpenAI critic differs from its unknown vendor.
		expect(checkRoleFor(null, roles, "fake/default-model")).toBe("critic");
		expect(checkRoleFor(null, roles, null)).toBe("critic");
	});

	test("checkRoleFor routes an only-Chinese board across vendors with no setting", () => {
		const roles = {
			adversary: "zai/glm-5.3-flash",
			critic: "qwen/qwen-max",
		};
		expect(checkRoleFor(null, roles, "zai/glm-5.3-flash")).toBe("critic");
		expect(checkRoleFor(null, roles, "qwen/qwen-max")).toBe("adversary");
	});

	test("a user rule routes the vendor to its role, else the fallback applies", () => {
		const roles = {
			critic: "openai/gpt-6",
			adversary: "anthropic/claude-opus-5-5",
			reviewer: "moonshot/kimi-k2",
		};
		const settings = {
			rules: [{ vendor: "zai", role: "reviewer" }],
			fallback: "",
		};
		expect(checkRoleFor(settings, roles, "zai/glm-5.3-flash")).toBe("reviewer");
		expect(checkRoutingNote(settings, roles, "zai/glm-5.3-flash")).toBeNull();
		// The first matching rule wins; later duplicates never run.
		const dup = {
			rules: [
				{ vendor: "zai", role: "reviewer" },
				{ vendor: "zai", role: "critic" },
			],
			fallback: "",
		};
		expect(checkRoleFor(dup, roles, "zai/glm-5.3-flash")).toBe("reviewer");
		// A model no rule names takes a configured fallback role.
		const fb = {
			rules: [{ vendor: "zai", role: "reviewer" }],
			fallback: "reviewer",
		};
		expect(checkRoleFor(fb, roles, "anthropic/claude-opus-5-5")).toBe(
			"reviewer",
		);
		expect(checkRoutingNote(fb, roles, "anthropic/claude-opus-5-5")).toBeNull();
		// An empty fallback and no match: the default rule, with no note.
		expect(checkRoleFor(settings, roles, "anthropic/claude-opus-5-5")).toBe(
			"critic",
		);
		expect(checkRoutingNote(settings, roles, "anthropic/claude-opus-5-5")).toBe(
			null,
		);
	});

	test("a rule or fallback to a missing role falls back to the default rule and logs one line", () => {
		const roles = {
			critic: "openai/gpt-6",
			adversary: "anthropic/claude-opus-5-5",
		};
		const settings = {
			rules: [{ vendor: "zai", role: "reviewer" }],
			fallback: "",
		};
		expect(checkRoleFor(settings, roles, "zai/glm-5.3-flash")).toBe("critic");
		expect(checkRoutingNote(settings, roles, "zai/glm-5.3-flash")).toBe(
			"check routing: rule zai -> reviewer names no configured role, using the default rule",
		);
		// The same for a nonempty fallback whose role has no configured model.
		const fb = { rules: [], fallback: "reviewer" };
		expect(checkRoleFor(fb, roles, "anthropic/claude-opus-5-5")).toBe("critic");
		expect(checkRoutingNote(fb, roles, "anthropic/claude-opus-5-5")).toBe(
			"check routing: fallback reviewer names no configured role, using the default rule",
		);
		// hasOwn, not a bare member read: a rule naming an inherited member
		// ("constructor") stays an unconfigured role — default rule + note.
		const trap = {
			rules: [{ vendor: "zai", role: "constructor" }],
			fallback: "",
		};
		expect(checkRoleFor(trap, roles, "zai/glm-5.3-flash")).toBe("critic");
		expect(checkRoutingNote(trap, roles, "zai/glm-5.3-flash")).toBe(
			"check routing: rule zai -> constructor names no configured role, using the default rule",
		);
	});

	test("the unknown vendor rule matches a model with no known vendor", () => {
		const roles = {
			critic: "openai/gpt-6",
			adversary: "anthropic/claude-opus-5-5",
		};
		const settings = {
			rules: [{ vendor: "unknown", role: "adversary" }],
			fallback: "critic",
		};
		expect(checkRoleFor(settings, roles, "fake/default-model")).toBe(
			"adversary",
		);
		expect(checkRoleFor(settings, roles, null)).toBe("adversary");
		// A known vendor never matches the unknown rule: the fallback applies.
		expect(checkRoleFor(settings, roles, "zai/glm-5.3-flash")).toBe("critic");
	});

	test("modelVendor reads the vendor from the model id after the provider prefix", () => {
		expect(modelVendor("anthropic/claude-opus-5-5")).toBe("anthropic");
		expect(modelVendor("github-copilot/claude-x")).toBe("anthropic");
		expect(modelVendor("openrouter/anthropic/claude-x")).toBe("anthropic");
		// Bedrock's dotted qualifiers and region prefixes do not hide the vendor.
		expect(modelVendor("bedrock/us.anthropic.claude-sonnet-4-5")).toBe(
			"anthropic",
		);
		expect(modelVendor("openai/gpt-6.1")).toBe("openai");
		expect(modelVendor("azure/o4-mini")).toBe("openai");
		expect(modelVendor("google/gemini-3-pro")).toBe("google");
		expect(modelVendor("zai/glm-5.3-flash")).toBe("zai");
		// The thinking suffix is ignored; the vendor path counts.
		expect(modelVendor("zai/glm-5.3-flash:high")).toBe("zai");
		expect(modelVendor("moonshotai/kimi-k2")).toBe("moonshot");
		expect(modelVendor("mistral/mistral-large-2")).toBe("mistral");
		expect(modelVendor("openrouter/qwen/qwen-2.5-72b-instruct")).toBe("qwen");
		expect(modelVendor("amazon/nova-2")).toBe("amazon");
		// No known token: unknown vendor, never a bare Object.prototype member read.
		expect(modelVendor("fake/default-model")).toBeNull();
		expect(modelVendor("provider/constructor")).toBeNull();
		expect(modelVendor("provider/")).toBeNull();
	});

	test("checkModelWarning flags a check on the checked run's own model or vendor", () => {
		// Same model: the thinking level apart at most.
		expect(
			checkModelWarning("zai/glm-5.3-flash", "zai/glm-5.3-flash:medium"),
		).toBe("same model");
		// Same vendor, another model.
		expect(checkModelWarning("zai/glm-5.3-flash", "zai/glm-5")).toBe(
			"same vendor",
		);
		// Claude checking Claude through another provider.
		expect(
			checkModelWarning(
				"github-copilot/claude-sonnet-4-5",
				"anthropic/claude-opus-5-5",
			),
		).toBe("same vendor");
		// A second vendor gives no warning.
		expect(
			checkModelWarning("anthropic/claude-opus-5-5", "openai-codex/gpt-6.1"),
		).toBeNull();
		// Unknown vendors cannot be claimed the same.
		expect(
			checkModelWarning("fake/default-model", "fake/other-model"),
		).toBeNull();
		expect(checkModelWarning(null, "zai/glm")).toBeNull();
		expect(checkModelWarning("zai/glm", null)).toBeNull();
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
		stillOpen: [],
	};

	test("parseWorkCheck reads the strict JSON object and skips malformed entries", () => {
		const parsed = parseWorkCheck(
			'noise {"blockers":[{"finding":"a","quote":"b"},{"finding":3}],"fixed":[{"id":1,"reason":" ok "}],"notes":["n",7]} done',
		);
		expect(parsed).toEqual({
			blockers: [{ finding: "a", quote: "b" }],
			fixed: [{ id: 1, reason: "ok" }],
			notes: ["n"],
			stillOpen: [],
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
				stillOpen: [],
			},
			"const x = 1;",
			"",
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

	test("demoteUnquoted keeps only quotes the diff, report, or transcript contains, demotions first", () => {
		const { blockers, notes } = demoteUnquoted(
			verdict,
			"diff --git a/x.ts const x = 1;",
			"",
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
			"",
			"transcript NOT IN THE SOURCES",
		);
		expect(blockers).toEqual([
			{ finding: "fabricated", quote: "NOT IN THE SOURCES" },
		]);
		expect(notes).toHaveLength(3); // two demotions plus the plain note
	});

	test("demoteUnquoted grounds a quote in the ready report when it is in neither diff nor transcript", () => {
		const { blockers, notes } = demoteUnquoted(
			verdict,
			"",
			"report NOT IN THE SOURCES",
			"",
		);
		expect(blockers).toEqual([
			{ finding: "fabricated", quote: "NOT IN THE SOURCES" },
		]);
		expect(notes).toHaveLength(3); // two demotions plus the plain note
	});

	describe("workCheckAccountingError", () => {
		const open = [
			{ finding: "first", quote: "first quote" },
			{ finding: "second", quote: "second quote" },
		];
		const fixed = [
			{ id: 1, reason: "the code now rejects it" },
			{ id: 2, reason: "the regression test covers it" },
		];

		test("accepts complete fixes, with no account needed when no blockers precede the check", () => {
			expect(
				workCheckAccountingError(
					{ blockers: [], notes: [], fixed, stillOpen: [] },
					open,
					[],
				),
			).toBeNull();
			expect(
				workCheckAccountingError(
					{ blockers: [], notes: [], fixed: [], stillOpen: [] },
					[],
					[],
				),
			).toBeNull();
			expect(
				workCheckAccountingError(
					{
						blockers: [],
						notes: [],
						fixed: [{ id: 1, reason: " \tfix\n" }],
						stillOpen: [],
					},
					open.slice(0, 1),
					[],
				),
			).toBeNull();
		});

		test.each([
			["empty account", []],
			["partial account", fixed.slice(0, 1)],
			...[-1, 0, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(
				(id) =>
					[`invalid ID ${id}`, [...fixed, { id, reason: "fix" }]] as const,
			),
			...["", " \t\n"].map(
				(reason) => ["empty reason", [...fixed, { id: 1, reason }]] as const,
			),
		] as const)("rejects %s", (_name, account) => {
			expect(
				workCheckAccountingError(
					{ blockers: [], notes: [], fixed: [...account], stillOpen: [] },
					open,
					[],
				),
			).not.toBeNull();
		});

		test.each([
			null,
			7,
			{ id: "2", reason: "fix" },
			{ id: 2.5, reason: "fix" },
			{ id: 2, reason: 7 },
			{ reason: "fix" },
		])(
			"a malformed parsed fix cannot account for the second blocker: %j",
			(bad) => {
				const parsed = parseWorkCheck(
					JSON.stringify({ blockers: [], fixed: [fixed[0], bad], notes: [] }),
				);
				expect(parsed).not.toBeNull();
				expect(workCheckAccountingError(parsed!, open, [])).not.toBeNull();
			},
		);

		test("accepts an exact grounded recurrence with a fix for the other blocker", () => {
			const parsed = parseWorkCheck(
				JSON.stringify({
					blockers: [{ finding: "a new description", quote: open[1]!.quote }],
					fixed: [fixed[0]],
				}),
			)!;
			for (const sources of [
				["second quote", "", ""],
				["", "second quote", ""],
				["", "", "second quote"],
			] as const) {
				const { blockers } = demoteUnquoted(
					parsed,
					sources[0],
					sources[1],
					sources[2],
				);
				expect(workCheckAccountingError(parsed, open, blockers)).toBeNull();
			}
		});

		test("accepts a still-open reference with a fresh quote and a reason, and keeps the blocker open", () => {
			const parsed = parseWorkCheck(
				JSON.stringify({
					blockers: [],
					fixed: [fixed[0]],
					stillOpen: [
						{
							id: 2,
							quote: "const retry = backoff(attempt);",
							reason: "the retry loop still drops the last attempt",
						},
					],
					notes: [],
				}),
			)!;
			// The parser carries the still-open references through.
			expect(parsed.stillOpen).toEqual([
				{
					id: 2,
					quote: "const retry = backoff(attempt);",
					reason: "the retry loop still drops the last attempt",
				},
			]);
			// Blocker 2 is neither fixed nor re-quoted: the check passes, and the
			// blocker stays open (applyWorkCheckVerdict stamps only fixed ids).
			expect(workCheckAccountingError(parsed, open, [])).toBeNull();
			expect(parsed.fixed.map((f) => f.id)).toEqual([1]);
		});

		test("still rejects a verdict that leaves an earlier blocker out", () => {
			const parsed = parseWorkCheck(
				JSON.stringify({
					blockers: [],
					fixed: [],
					stillOpen: [
						{ id: 1, quote: "fresh evidence", reason: "still broken" },
					],
				}),
			)!;
			expect(workCheckAccountingError(parsed, open, [])).toBe(
				"the work check did not account for earlier blocker 2",
			);
		});

		test.each([
			["an out-of-range id", { id: 3, quote: "q", reason: "r" }],
			["an empty quote", { id: 2, quote: "  ", reason: "r" }],
			["an empty reason", { id: 2, quote: "q", reason: " \t\n" }],
		] as const)("rejects a still-open reference with %s", (_name, bad) => {
			const parsed = parseWorkCheck(
				JSON.stringify({ blockers: [], fixed: [fixed[0]], stillOpen: [bad] }),
			)!;
			expect(parsed.stillOpen).toHaveLength(1);
			expect(workCheckAccountingError(parsed, open, [])).not.toBeNull();
		});

		test.each([
			null,
			7,
			{ id: "2", quote: "q", reason: "r" },
			{ id: 2, quote: 7, reason: "r" },
			{ id: 2, quote: "q" },
			{ id: 2, reason: "r" },
		])(
			"a malformed parsed still-open entry cannot account for the second blocker: %j",
			(bad) => {
				const parsed = parseWorkCheck(
					JSON.stringify({ blockers: [], fixed: [], stillOpen: [bad] }),
				);
				expect(parsed).not.toBeNull();
				expect(parsed!.stillOpen).toHaveLength(0); // skipped, like a malformed fix
				expect(workCheckAccountingError(parsed!, open, [])).not.toBeNull();
			},
		);

		test.each([
			["second quote", undefined, ""],
			["second quote", "nit", "second quote"],
			["second quote", "pre-existing", "second quote"],
			["second", undefined, "second quote"],
			["", undefined, "second quote"],
		] as const)(
			"rejects an ungrounded, demoted, or changed recurrence: %s %s",
			(quote, severity, source) => {
				const parsed = parseWorkCheck(
					JSON.stringify({
						blockers: [{ finding: "still open", quote, severity }],
						fixed: [fixed[0]],
					}),
				)!;
				const { blockers } = demoteUnquoted(parsed, source, "", "");
				expect(workCheckAccountingError(parsed, open, blockers)).not.toBeNull();
			},
		);

		test("property: a no-blocker verdict passes only with a reason for every earlier blocker", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							include: fc.boolean(),
							reason: fc.oneof(
								fc.string(),
								fc.constant("fixed"),
								fc.constant(" \t"),
							),
						}),
						{ maxLength: 8 },
					),
					(accounts) => {
						const earlier = accounts.map((_, i) => ({
							finding: `finding ${i}`,
							quote: `quote ${i}`,
						}));
						const parsed = parseWorkCheck(
							JSON.stringify({
								blockers: [],
								fixed: accounts.flatMap((account, i) =>
									account.include
										? [{ id: i + 1, reason: account.reason }]
										: [],
								),
							}),
						)!;
						expect(workCheckAccountingError(parsed, earlier, []) === null).toBe(
							accounts.every(
								(account) => account.include && account.reason.trim() !== "",
							),
						);
					},
				),
			);
		});

		test("property: an omitted or malformed fix cannot close an earlier blocker", () => {
			fc.assert(
				fc.property(
					fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
					fc.nat(),
					fc.constantFrom("omitted", "type", "fraction", "range", "reason"),
					(reasons, index, kind) => {
						const missing = index % reasons.length;
						const earlier = reasons.map((_, i) => ({
							finding: `finding ${i}`,
							quote: `quote ${i}`,
						}));
						const bad = {
							omitted: null,
							type: { id: String(missing + 1), reason: "fix" },
							fraction: { id: missing + 1.5, reason: "fix" },
							range: { id: reasons.length + 1, reason: "fix" },
							reason: { id: missing + 1, reason: " \t\n" },
						}[kind];
						const parsed = parseWorkCheck(
							JSON.stringify({
								blockers: [],
								fixed: reasons.map((reason, i) =>
									i === missing ? bad : { id: i + 1, reason: `Fix: ${reason}` },
								),
							}),
						)!;
						expect(
							workCheckAccountingError(parsed, earlier, []),
						).not.toBeNull();
					},
				),
			);
		});
		test("property: a still-open reference accounts for a blocker only with a quote and a reason", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							mode: fc.constantFrom("fixed", "requote", "stillOpen", "none"),
							ok: fc.boolean(),
						}),
						{ minLength: 1, maxLength: 8 },
					),
					(modes) => {
						const earlier = modes.map((_, i) => ({
							finding: `finding ${i}`,
							quote: `quote ${i}`,
						}));
						const fixed: { id: number; reason: string }[] = [];
						const stillOpen: { id: number; quote: string; reason: string }[] =
							[];
						const blockers: { finding: string; quote: string }[] = [];
						modes.forEach((m, i) => {
							if (m.mode === "fixed")
								fixed.push({ id: i + 1, reason: m.ok ? "real fix" : "  \n" });
							else if (m.mode === "stillOpen")
								stillOpen.push({
									id: i + 1,
									quote: m.ok ? `fresh ${i + 1}` : " ",
									reason: m.ok ? "still there" : "",
								});
							else if (m.mode === "requote")
								blockers.push({ finding: "again", quote: `quote ${i}` });
						});
						const parsed = parseWorkCheck(
							JSON.stringify({ blockers, fixed, stillOpen }),
						)!;
						const accounted = modes.every((m) =>
							m.mode === "fixed"
								? m.ok
								: m.mode === "stillOpen"
									? m.ok
									: m.mode === "requote",
						);
						expect(
							workCheckAccountingError(parsed, earlier, parsed.blockers) ===
								null,
						).toBe(accounted);
					},
				),
			);
		});
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

describe("work-check divergence trend", () => {
	const blockersRun = (n: number, classes?: string[]) => ({
		at: 1,
		model: null,
		outcome: "blockers" as const,
		blockers: Array.from({ length: n }, (_, i) => ({
			finding: `f${i}`,
			quote: `q${i}`,
			...(classes?.[i] !== undefined ? { bugClass: classes[i] } : {}),
		})),
		notes: [],
		durationMs: 1,
	});
	const otherRun = (outcome: "pass" | "error") => ({
		at: 1,
		model: null,
		outcome,
		blockers: [],
		notes: [],
		durationMs: 1,
		...(outcome === "error" ? { error: "quota" } : {}),
	});

	test("flat counts 1,2,2 diverge", () => {
		const log = [blockersRun(1), blockersRun(2), blockersRun(2)];
		expect(workCheckDiverged(log)).toBe(true);
	});

	test("dropping counts 3,2,1 do not diverge", () => {
		const log = [blockersRun(3), blockersRun(2), blockersRun(1)];
		expect(workCheckDiverged(log)).toBe(false);
	});

	test("the same bugClass in two consecutive checks diverges even with dropping counts", () => {
		const log = [
			blockersRun(1, ["off-by-one"]),
			blockersRun(1, ["off-by-one"]),
		];
		expect(workCheckDiverged(log)).toBe(true);
	});

	test("a new class each round never diverges; that loop parks on the cap instead", () => {
		const log = [
			blockersRun(2, ["r1a", "r1b"]),
			blockersRun(1, ["r2"]),
			blockersRun(2, ["r3a", "r3b"]),
			blockersRun(1, ["r4"]),
			blockersRun(2, ["r5a", "r5b"]),
		];
		expect(workCheckDiverged(log)).toBe(false);
	});

	test("workCheckBlockerCounts skips pass and error runs", () => {
		const log = [
			otherRun("error"),
			blockersRun(2),
			otherRun("pass"),
			blockersRun(2),
		];
		expect(workCheckBlockerCounts(log)).toEqual([2, 2]);
	});

	test("repeatedBugClasses lists the latest run's first-occurrence order, deduped", () => {
		const log = [blockersRun(2, ["x", "y"]), blockersRun(3, ["y", "x", "y"])];
		expect(repeatedBugClasses(log)).toEqual(["y", "x"]);
	});

	test("repeatedBugClasses never repeats a blocker without a bugClass", () => {
		const log = [blockersRun(1), blockersRun(1)];
		expect(repeatedBugClasses(log)).toEqual([]);
	});

	test("workCheckDivergeReason names the counts, the repeated class and the finding, and invites a reply", () => {
		const log = [
			blockersRun(1),
			blockersRun(2, ["lossy-patch-compare", "lossy-patch-compare"]),
			{
				...blockersRun(2, ["lossy-patch-compare", "lossy-patch-compare"]),
				blockers: [
					{
						finding: "patch compare loses hunks",
						quote: "q0",
						bugClass: "lossy-patch-compare",
					},
					{
						finding: "patch compare drops hunks",
						quote: "q1",
						bugClass: "lossy-patch-compare",
					},
				],
			},
		];
		const reason = workCheckDivergeReason(log);
		expect(
			reason.startsWith(
				"The work-check loop is diverging (blockers per check: 1, 2, 2)",
			),
		).toBe(true);
		expect(reason).toContain(
			': the blocker count did not drop over the last send-backs. It also re-raises the bug class "lossy-patch-compare": 1. patch compare loses hunks',
		);
		expect(
			reason.endsWith(
				". Reply with a new direction to send the card back with it, or click Merge anyway or Cancel.",
			),
		).toBe(true);
	});

	test("the reason names the class rule alone when the counts dropped", () => {
		const log = [
			{
				...blockersRun(3, ["off-by-one", "off-by-one", "off-by-one"]),
				blockers: [
					{
						finding: "off by one in the loop",
						quote: "q0",
						bugClass: "off-by-one",
					},
					{
						finding: "off by one in the loop",
						quote: "q1",
						bugClass: "off-by-one",
					},
					{
						finding: "off by one in the loop",
						quote: "q2",
						bugClass: "off-by-one",
					},
				],
			},
			{
				...blockersRun(1, ["off-by-one"]),
				blockers: [
					{
						finding: "off by one again",
						quote: "q0",
						bugClass: "off-by-one",
					},
				],
			},
		];
		expect(workCheckCountsDiverged(log)).toBe(false);
		expect(workCheckDiverged(log)).toBe(true);
		const reason = workCheckDivergeReason(log);
		expect(reason).toContain("(blockers per check: 3, 1)");
		expect(reason).toContain(
			': it re-raises the bug class "off-by-one": 1. off by one again',
		);
		expect(reason).not.toContain("did not drop");
	});

	test("the counts clause needs three blocking checks", () => {
		const log = [blockersRun(1, ["x"]), blockersRun(2, ["x", "y"])];
		expect(workCheckCountsDiverged(log)).toBe(false);
		expect(workCheckDiverged(log)).toBe(true);
		const reason = workCheckDivergeReason(log);
		expect(reason).toContain('it re-raises the bug class "x"');
		expect(reason).not.toContain("did not drop");
	});

	test("workCheckDivergeAsk asks one question with the three options, new approach recommended", () => {
		const ask = workCheckDivergeAsk([blockersRun(1), blockersRun(2)]);
		expect(ask).toHaveLength(1);
		expect(ask[0]!.options.map((o) => o.label)).toEqual([
			"Send back with a new approach",
			"Merge anyway",
			"Cancel",
		]);
		expect(ask[0]!.recommended).toBe(0);
		expect(ask[0]!.options[0]!.description).toBe(
			"Send the blockers back once more; the send-back asks the agent to rethink the approach instead of fixing one more instance, and names the repeated class when there is one.",
		);
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

describe("pickRunnable code scanning cards", () => {
	const dirs: string[] = [];
	const stores: ProjectStore[] = [];
	const newStore = async (): Promise<ProjectStore> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-pick-codescan-"));
		dirs.push(dir);
		const store = await ProjectStore.open(dir);
		stores.push(store);
		return store;
	};
	afterEach(async () => {
		for (const store of stores.splice(0)) await store.close(); // double close is a no-op
	});
	afterAll(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	});

	/** Deterministic alert for the fixture card; only the number varies. */
	const alert = (number: number): NewCodeScanAlert => ({
		number,
		rule: "js/x",
		severity: "high",
		path: "src/a.ts",
		line: 1,
		url: `https://github.com/o/r/security/code-scanning/${number}`,
		message: "m",
	});
	const item = {
		rule: "js/x",
		title: "Code scanning: js/x (3 alerts)",
		prompt: "p",
		alerts: [alert(1), alert(2), alert(3)],
	};
	const pickOpts = (now: number) => ({
		maxParallel: 2,
		hasRules: true,
		now,
	});

	test("an auto-started code scanning card is picked", async () => {
		const store = await newStore();
		await store.setSettings({ codeScanAutoStart: true });
		const now = 1_700_000_000_000;
		const [card] = await store.fileCodeScanCards({
			items: [item],
			now,
			start: true,
		});
		expect(card!.stage).toBe("todo");
		expect(card!.state).toBe("queued");
		expect(card!.queuedAt).not.toBeNull();
		expect(
			pickRunnable(await store.listTasks(), pickOpts(now)).map(
				(picked) => picked.id,
			),
		).toEqual([card!.id]);
	});

	test("a backlog code scanning card is not picked", async () => {
		const store = await newStore();
		const now = 1_700_000_000_000;
		const [card] = await store.fileCodeScanCards({ items: [item], now });
		expect(card!.stage).toBe("backlog");
		expect(card!.state).toBe("idle");
		expect(card!.queuedAt).toBeNull();
		expect(
			pickRunnable(await store.listTasks(), pickOpts(now)).map(
				(picked) => picked.id,
			),
		).toEqual([]);
	});
});

describe("leadBlocker", () => {
	test("reads both fixed blocker lines with their payload", () => {
		expect(
			leadBlocker(
				"Needs validation: rate limiter bug\nBlocker: deployment fact: Does a trusted proxy set X-Forwarded-For?",
			),
		).toEqual({
			kind: "deployment",
			question: "Does a trusted proxy set X-Forwarded-For?",
		});
		expect(leadBlocker("x\nBlocker: sandbox run: no network deny")).toEqual({
			kind: "sandbox",
			control: "no network deny",
		});
	});

	test("the first blocker line wins and leading spaces are allowed", () => {
		expect(
			leadBlocker("Blocker: sandbox run: a\n  Blocker: deployment fact: q"),
		).toEqual({ kind: "sandbox", control: "a" });
		expect(
			leadBlocker("Blocker: deployment fact:  spaced question  \nrest"),
		).toEqual({ kind: "deployment", question: "spaced question" });
	});

	test("a missing or malformed line counts as a sandbox run", () => {
		expect(leadBlocker("Needs validation: flaky retry")).toEqual({
			kind: "sandbox",
			control: null,
		});
		expect(leadBlocker("Blocker: deployment-fact: q")).toEqual({
			kind: "sandbox",
			control: null,
		});
		expect(leadBlocker("Blocker: deployment fact without a colon")).toEqual({
			kind: "sandbox",
			control: null,
		});
		expect(leadBlocker("Blocker: deployment fact:")).toEqual({
			kind: "sandbox",
			control: null,
		});
		expect(leadBlocker("Inline Blocker: deployment fact: not a line")).toEqual({
			kind: "sandbox",
			control: null,
		});
	});

	test("the fixed option labels and question-card prefix hold their wording", () => {
		expect(LEAD_APPLIES_OPTION).toBe("Applies");
		expect(LEAD_NOT_APPLY_OPTION).toBe("Does not apply");
		expect(LEAD_UNSURE_OPTION).toBe("Not sure");
		// The labels the first question cards shipped with stay matched by the
		// reply route, so stored `asked` on open cards keeps working (OTTR-1227).
		expect(LEAD_APPLIES_OPTION_LEGACY).toBe("Yes, the risk applies");
		expect(LEAD_NOT_APPLY_OPTION_LEGACY).toBe("No, it does not apply");
		expect(LEAD_QUESTIONS_PROMPT_PREFIX).toBe(
			"Needs-validation lead questions from review #",
		);
	});

	test("cyclicDepIds flags the id that closes a birth-window cycle", () => {
		// The created card and the blocker of one project; the created card's list is
		// the birth write (OTTR-1318): an edit that validated B→[A] against the window
		// before the list landed must be flagged once A→[B] is on the row.
		const created: DepCard = {
			id: "P-2",
			title: "created",
			stage: "todo",
			cancelledAt: null,
		};
		const blocker: DepCard = {
			id: "P-1",
			title: "blocker",
			stage: "todo",
			cancelledAt: null,
		};
		const projects: DepProject[] = [
			{
				name: "p",
				prefix: "P",
				getTask: (id) =>
					id === created.id ? created : id === blocker.id ? blocker : null,
			},
		];
		// The created card's committed list is the birth write under test.
		expect(
			cyclicDepIds(["P-2"], "P-1", "p", projects, (project, id) =>
				project === "p" && id === created.id ? ["P-1"] : undefined,
			),
		).toEqual(["P-2"]);
		// An id that closes no path back to the card stays out of the drop list.
		expect(
			cyclicDepIds(["P-9"], "P-1", "p", projects, (project, id) =>
				project === "p" && id === created.id ? ["P-1"] : undefined,
			),
		).toEqual([]);
	});
});

describe("OTTR-1252: a lead waiting for its review's validation never runs and never holds", () => {
	// The deployment-fact blocker keeps pendingSandboxLead false, so the waitsValidation
	// marker alone must stop the pick; a sandbox-blocker lead is already caught by
	// OTTR-1128's guard.
	const waitingLead = (p: Partial<Task> = {}) =>
		task({
			followUpOf: "rev0",
			prompt:
				"Needs validation: proxy\nBlocker: deployment fact: Does a trusted proxy set X-Forwarded-For?",
			stage: "todo",
			state: "queued",
			queuedAt: 700,
			waitsValidation: true,
			...p,
		});

	test("pickRunnable never returns a lead waiting for validation, also with validatedAt set (OTTR-1252)", () => {
		const many = { ...opts, maxParallel: 10 };
		const unvalidated = waitingLead();
		// A "still blocked" result keeps the marker: validatedAt set alone never makes
		// the lead runnable.
		const blocked = waitingLead({
			validatedAt: 800,
			details:
				"\nValidated by validation run #id9000 on 2026-11-24: still blocked — no proxy.",
		});
		expect(pickRunnable([unvalidated, blocked], many)).toEqual([]);
		// The confirmed form: the marker cleared, the lead is normal queued work.
		const confirmed = waitingLead({ validatedAt: 800, waitsValidation: false });
		expect(pickRunnable([confirmed], many)).toEqual([confirmed]);
	});

	test("a waiting lead takes neither the grill slot nor a work slot (OTTR-1252)", () => {
		// A todo lead is never stage backlog, so grillSlot ignores it; the kicked
		// backlog card keeps the grill slot and the waiting lead stays unpicked.
		const kicked = task({ stage: "backlog" });
		expect(
			pickRunnable([waitingLead(), kicked], { ...opts, maxParallel: 10 }),
		).toEqual([kicked]);
	});

	test("a done release review with a waiting lead holds no merge and no findings (OTTR-1252)", () => {
		const review = task({
			kind: "review",
			releaseVersion: "v0.4.0",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const lead = waitingLead({
			followUpOf: review.id,
			createdAt: 310,
			leadAtDone: false,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([review, lead, other], other)).toBeNull();
		expect(findingsHold([review, lead], review)).toBeNull();
	});

	test("a committed finding in the same shape still holds, a confirmed lead never does (OTTR-1252)", () => {
		// Control for the exemption above: a committed non-lead finding in todo holds
		// the merge. A confirmed lead keeps its "Needs validation" prompt tag, so isLead
		// still exempts it in any stage (OTTR-1128) — the cleared marker is not what
		// frees it, the lead tag is.
		const review = task({
			kind: "review",
			releaseVersion: "v0.4.0",
			base: "abc",
			stage: "done",
			state: "idle",
			createdAt: 100,
			doneAt: 500,
		});
		const committed = task({
			followUpOf: review.id,
			createdAt: 310,
			stage: "todo",
			queuedAt: 700,
			waitsValidation: false,
		});
		const confirmedLead = waitingLead({
			followUpOf: review.id,
			createdAt: 310,
			validatedAt: 800,
			waitsValidation: false,
			leadAtDone: false,
		});
		const other = task({ stage: "merging", queuedAt: 100 });
		expect(mergeHold([review, committed, other], other)).toBe(FINDINGS_HOLD);
		expect(mergeHold([review, confirmedLead, other], other)).toBeNull();
	});
});

describe("OTTR-1252: the legacy-lead convergence decision reads the newest outcome", () => {
	const BLOCKED =
		"\nValidated by validation run #10 on 2026-11-21: still blocked — no retry control.";
	const CONFIRMED =
		"\nValidated by validation run #9 on 2026-11-20: confirmed.";
	const DEPLOYMENT =
		"\nValidated by validation run #11 on 2026-11-22: deployment — Which proxy terminates TLS?";
	const CONFIRMED_WITH_EVIDENCE =
		"\nValidated by #12 on 2026-11-23: confirmed. The job reproduces the race.";

	test("leadValidationOutcome reads the newest segment, newest wins", () => {
		expect(leadValidationOutcome(null)).toBeNull();
		expect(leadValidationOutcome("no marker at all")).toBeNull();
		expect(leadValidationOutcome(`unverified.${BLOCKED}`)).toBe(
			"still blocked",
		);
		// An older blocked segment under a newer confirmed one: confirmed rules.
		expect(
			leadValidationOutcome(
				`unverified.${BLOCKED}\nValidated by validation run #11 on 2026-11-22: confirmed.`,
			),
		).toBe("confirmed");
		// The confirmed branch writes the evidence right after the outcome word.
		expect(leadValidationOutcome(`unverified.${CONFIRMED_WITH_EVIDENCE}`)).toBe(
			"confirmed",
		);
		expect(leadValidationOutcome(`unverified.${DEPLOYMENT}`)).toBe(
			"deployment",
		);
	});

	test("legacyLeadWaits waits for undecided rows and keeps decided rows", () => {
		const prompt = "Needs validation: suspicious retry loop";
		// Undecided: never validated, still blocked, unanswered deployment.
		expect(legacyLeadWaits(prompt, null, null, null)).toBe(true);
		expect(legacyLeadWaits(prompt, 950, `unverified.${BLOCKED}`, null)).toBe(
			true,
		);
		expect(legacyLeadWaits(prompt, 960, `unverified.${DEPLOYMENT}`, null)).toBe(
			true,
		);
		// Decided: confirmed work, a refuted lead, and the operator's applies
		// answer (its marker rides the prompt, set by the reply route).
		expect(legacyLeadWaits(prompt, 900, `unverified.${CONFIRMED}`, null)).toBe(
			false,
		);
		expect(
			legacyLeadWaits(
				prompt,
				900,
				`unverified.${CONFIRMED_WITH_EVIDENCE}`,
				null,
			),
		).toBe(false);
		expect(
			legacyLeadWaits(
				`${prompt}\n\nThe user answered the review's question: Applies`,
				null,
				null,
				null,
			),
		).toBe(false);
		// The finding record is authoritative and survives a later grill's
		// details wipe: a grilled lead whose finding says blocked waits again,
		// and a finding confirmed keeps the row decided even when the details
		// segment still reads blocked.
		expect(
			legacyLeadWaits(prompt, 950, "Grilled definition of ready", "blocked"),
		).toBe(true);
		expect(
			legacyLeadWaits(prompt, 900, "Grilled definition of ready", "confirmed"),
		).toBe(false);
		expect(
			legacyLeadWaits(prompt, 900, `unverified.${BLOCKED}`, "confirmed"),
		).toBe(false);
		// A validatedAt with no readable record anywhere is decided: the outcome
		// was recorded through the started-lead branch, which keeps no findings,
		// and a later grill wiped the segment — re-locking the row would strand
		// work no route can unlock (batching needs validatedAt null, the reset
		// needs a blocked segment).
		expect(
			legacyLeadWaits(prompt, 900, "Grilled definition of ready", null),
		).toBe(false);
		// Not a lead: the question cards' prefix carries the hyphen.
		expect(
			legacyLeadWaits(
				"Needs-validation lead questions from rev1: reply",
				null,
				null,
				null,
			),
		).toBe(false);
	});
});
