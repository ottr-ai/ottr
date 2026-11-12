import { describe, expect, test } from "bun:test";
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
	checkModelWarning,
	checkRoleFor,
	type DepIndex,
	type DepProject,
	demoteUnquoted,
	depHold,
	findDep,
	findingsHold,
	findingsSettledAt,
	isRetro,
	isReview,
	LEAD_APPLIES_OPTION,
	LEAD_NOT_APPLY_OPTION,
	LEAD_QUESTIONS_PROMPT_PREFIX,
	lastFullReview,
	lastFullReviewBase,
	lastReviewBase,
	leadBlocker,
	liveCard,
	liveCardOf,
	mergeAnywayPatch,
	mergeHold,
	modelVendor,
	openWorkBlockers,
	overrideWorkBlockers,
	PUSH_HOLD,
	parseCheckVerdicts,
	parseWorkCheck,
	pickLowPriority,
	pickRunnable,
	pushHold,
	queueOrder,
	releaseHeldMerges,
	repeatedBugClasses,
	resolveDep,
	reviewBlocked,
	reviewFindings,
	SILENT_LOG_MS,
	selectFindings,
	silentSince,
	waitingOn,
	workCheckBlockerCounts,
	workCheckCountsDiverged,
	workCheckDivergeAsk,
	workCheckDiverged,
	workCheckDivergeReason,
} from "./scheduler.ts";
import type { Task, WorkCheckRun } from "./types.ts";

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
				blockers: [{ finding: "f", quote: "q" }],
				notes: [],
				durationMs: 0,
			},
		];
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
			needsReason: null,
			asked: null,
		});
		expect(patch.workCheckLog[0]?.blockers[0]?.statusReason).toBe("why");
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
		sourcePrNumber: null,
		sourcePrUrl: null,
		sourcePrHeadRef: null,
		sourcePrHeadSha: null,
		sourcePrCrossRepo: false,
		sourcePrDependabot: false,
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
		expect(pickRunnable([review, other, finding], opts)).toEqual([finding]);
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
			archReviewView(lastFullReview([review]), delta("aaa"), 30, false),
		).toEqual({
			delta: 12,
			reviewed: true,
			base: "aaa",
			reviewCardId: review.id,
			cap: 30,
			due: false,
			running: false,
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
			false,
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
				false,
			),
		).toEqual({
			delta: 1,
			reviewed: true,
			base: "zzz",
			reviewCardId: null,
			cap: 30,
			due: false,
			running: false,
		});
	});

	test("no full review yet: the base is null and the whole history counts", () => {
		expect(
			archReviewView(
				lastFullReview([]),
				{ delta: 9, reviewed: false, anchor: "" },
				30,
				false,
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

	test("checkRoleFor picks the role by model vendor, not provider prefix", () => {
		// Claude through another provider is still Anthropic: the critic role checks it.
		expect(checkRoleFor("anthropic/claude-opus-5-5")).toBe("critic");
		expect(checkRoleFor("github-copilot/claude-sonnet-4-5")).toBe("critic");
		expect(checkRoleFor("openrouter/anthropic/claude-opus-4-1")).toBe("critic");
		expect(checkRoleFor("bedrock/us.anthropic.claude-sonnet-4-5")).toBe(
			"critic",
		);
		// Other vendors and unknown ids keep the adversary role.
		expect(checkRoleFor("openai/gpt-6.1")).toBe("adversary");
		expect(checkRoleFor("openai-codex/gpt-5.6-luna")).toBe("adversary");
		expect(checkRoleFor("zai/glm-5.3-flash")).toBe("adversary");
		expect(checkRoleFor("fake/default-model")).toBe("adversary");
		expect(checkRoleFor(null)).toBe("adversary");
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
		expect(LEAD_APPLIES_OPTION).toBe("Yes, the risk applies");
		expect(LEAD_NOT_APPLY_OPTION).toBe("No, it does not apply");
		expect(LEAD_QUESTIONS_PROMPT_PREFIX).toBe(
			"Needs-validation lead questions from review #",
		);
	});
});
