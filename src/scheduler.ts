import { statSync } from "node:fs";
import { validationResult } from "./auditLeads.ts";
import { splitLevel } from "./levels.ts";
import { WORK_CHECK_MAX_SENDBACKS } from "./prompts.ts";
import type {
	ArchReview,
	AskQuestion,
	CheckRoutingSetting,
	ListedTask,
	RecordedFinding,
	Task,
	TaskKind,
	WorkCheckBlocker,
	WorkCheckRun,
} from "./types.ts";
import { modelVendor } from "./vendor.ts";

/** A live turn whose card log has not grown for this long may wait on a hung command (ALAT-23
 * sat 25 h on a hung Stryker run with its omp process alive). The card warns; the board never kills. */
export const SILENT_LOG_MS = 2 * 60 * 60_000;

/** The hold an open prompt edit claims: pickRunnable defers any card with
 * `holdUntil > now`, and this value never arrives, so the card waits for exactly as
 * long as some drawer has the editor open. There is no heartbeat on purpose — browsers
 * throttle background-tab timers (Chrome runs chained timers about once a minute once
 * a tab has been hidden for five minutes), so a renewing TTL would lapse mid-edit.
 * Release paths are explicit instead: the save clears the hold in the same write as
 * the prompt, every editor close posts edit/stop (a keepalive call on pagehide covers
 * the tab closing), and every route that queues a card clears the hold, so a user
 * action always overrides a hold whose editor died without saying goodbye. */
export const PROMPT_EDIT_HELD = Number.MAX_SAFE_INTEGER;

/** Last activity of a preparing or running card once it has been silent past SILENT_LOG_MS;
 * null for other states, fresher activity, or no activity yet. Activity is the later of the
 * log's last write and the running turn's last live-progress movement (`progressAt`, set by
 * turn.ts when the progress numbers change — a Stryker run whose tested count no longer moves
 * does not count, so a hung run still warns, ALAT-23). A log past the runner's 2 MiB cap keeps
 * its mtime current while output arrives (createRunSink), so the same rule covers it.
 * Floored so the 1 s state diff stays still. */
export function silentSince(
	t: Pick<Task, "state">,
	logPath: string,
	now: number,
	progressAt?: number,
): number | null {
	if (t.state !== "running" && t.state !== "preparing") return null;
	let at = statSync(logPath, { throwIfNoEntry: false })?.mtimeMs;
	if (progressAt !== undefined && (at === undefined || progressAt > at))
		at = progressAt;
	if (at === undefined || now - at <= SILENT_LOG_MS) return null;
	return Math.floor(at);
}

/** True for a retro card (kind 'retro', set by the trusted retro route). */
export function isRetro(t: Pick<Task, "kind">): boolean {
	return t.kind === "retro";
}

/** Queued, non-cancelled tasks in run order: queuedAt (falling back to createdAt) asc, then createdAt asc. */
export function queueOrder<
	T extends Pick<Task, "cancelledAt" | "state" | "queuedAt" | "createdAt">,
>(tasks: readonly T[]): T[] {
	return tasks
		.filter((t) => t.cancelledAt === null && t.state === "queued")
		.sort(
			(a, b) =>
				(a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
				a.createdAt - b.createdAt,
		);
}

/** The non-cancelled task of `kind` that has not reached done, or null: the one card of the
 * kind the one-live-card-per-kind rule keeps (rules interview, retro). kind is a trusted,
 * server-set field, so this is the single place that derives "a card of this kind is live"
 * (R1-14). Reviews use reviewBlocked instead. */
export function liveCardOf<
	T extends Pick<Task, "kind" | "cancelledAt" | "stage">,
>(tasks: readonly T[], kind: TaskKind): T | null {
	return (
		tasks.find(
			(t) => t.kind === kind && t.cancelledAt === null && t.stage !== "done",
		) ?? null
	);
}

/** True when liveCardOf finds a card: the boolean form for guards that only ask yes/no. */
export function liveCard(
	tasks: readonly Pick<Task, "kind" | "cancelledAt" | "stage">[],
	kind: TaskKind,
): boolean {
	return liveCardOf(tasks, kind) !== null;
}

/** How a card says it is a review lead: a store row by its prompt, a board card (no
 * prompt) by its `lead` mark. */
export type LeadMark = Pick<Task, "prompt"> | { lead?: true };

/** The fields the review policies read. */
export type ReviewTask = Pick<
	Task,
	| "id"
	| "kind"
	| "releaseVersion"
	| "cancelledAt"
	| "stage"
	| "createdAt"
	| "doneAt"
	| "leadAtDone"
	| "dependsOn"
	| "followUpOf"
> &
	LeadMark;

/** A review card: a release card, or the Review button's card. Both run the same review
 * (prompts.ts reviewBody); a release publishes after it. */
export function isReview(t: Pick<Task, "kind" | "releaseVersion">): boolean {
	return t.releaseVersion !== null || t.kind === "review";
}

/** The follow-up children created before `end`, by the parent they link to. */
function followUpsByParent<T extends ReviewTask>(
	tasks: readonly T[],
	end: number,
): Map<string, T[]> {
	const kids = new Map<string, T[]>();
	for (const t of tasks) {
		if (t.followUpOf === null || t.createdAt > end) continue;
		const list = kids.get(t.followUpOf);
		if (list === undefined) kids.set(t.followUpOf, [t]);
		else list.push(t);
	}
	return kids;
}

/** Adds `t` when it is new and not terminal: a retro card (R7) and its follow-ups never join. */
function addIfNew<T extends ReviewTask>(
	t: T | undefined,
	seen: Set<string>,
	found: T[],
): void {
	if (t === undefined || seen.has(t.id) || isRetro(t)) return;
	seen.add(t.id);
	found.push(t);
}

/** The review's findings: the cards it filed (create_task links each one to the review as
 * followUpOf), the cards those filed in turn, and every card a finding depends on, so a finding's
 * prerequisite is never held behind the review. Only cards created before the review was done
 * count: a later follow-up of an old finding does not reopen a finished review. */
export function reviewFindings<T extends ReviewTask>(
	tasks: readonly T[],
	review: Pick<Task, "id" | "doneAt">,
): T[] {
	const end = review.doneAt ?? Number.POSITIVE_INFINITY;
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const kids = followUpsByParent(tasks, end);
	const seen = new Set([review.id]);
	const found: T[] = [];
	for (const k of kids.get(review.id) ?? []) addIfNew(k, seen, found);
	// Both loops visit the cards they append: the follow-up chain first, then the dependency closure.
	for (const f of found)
		for (const k of kids.get(f.id) ?? []) addIfNew(k, seen, found);
	for (const f of found)
		for (const d of f.dependsOn) addIfNew(byId.get(d), seen, found);
	return found;
}

/** True while a finding is not done: a cancelled finding counts as done, and a
 * child in `backlog` stage (an unverified lead filed without a check verdict) is
 * optional work, not a commitment, so it never holds the review's Done. A lead (the
 * "Needs validation" tag) and a batch validation run never hold it in any stage
 * (OTTR-1128): a promoted lead and its review would otherwise wait on each other.
 * Shared by findingsOpen and reviewHoldDetail so the two open rules cannot drift. */
function findingOpen(
	f: Pick<Task, "cancelledAt" | "stage" | "kind"> & LeadMark,
): boolean {
	return (
		f.cancelledAt === null &&
		f.stage !== "done" &&
		f.stage !== "backlog" &&
		!isLead(f) &&
		f.kind !== "validation"
	);
}

/** The findings the findings hold counts for review `r`: findingOpen, minus a lead the
 * store flagged as a parked backlog lead at the review's doneAt (OTTR-963). Shared by
 * reviewHoldDetail and the drawer's hold banner (OTTR-1258), so the banner cannot name a
 * card the hold does not count. */
export function reviewOpenFindings<T extends ReviewTask>(
	findings: readonly T[],
	r: Pick<Task, "stage">,
): T[] {
	return findings.filter(
		(f) => findingOpen(f) && (r.stage !== "done" || !f.leadAtDone),
	);
}

function findingsOpen(
	tasks: readonly ReviewTask[],
	review: Pick<Task, "id" | "doneAt">,
): boolean {
	return reviewFindings(tasks, review).some(findingOpen);
}

/** OTTR-506: why the push hold parks a queued merge while the project's local target branch
 * has commits origin lacks (a rejected server push left it ahead), else null. The rejected
 * card's own rebase retry (pushRetries > 0, queued at merging) stays runnable: it rebases
 * main onto origin, re-runs the gates, and its server push ends the hold. So does a card the
 * user replied to (pendingBy "user"): a push that failed without being rejected (auth,
 * network), a rejected push whose origin re-check failed, and a rejected hold-approved push
 * all park needs_you with pushRetries still 0 — if the user's reply could not run, the hold
 * would lock out the only card that can push main (ALAT-60 recovered exactly this way).
 * Every other automatically scheduled merge waits, so one rejection cannot pile merges onto
 * an unpushed main. Pure: `mainUnpushed` is the git fact (worktree.ts branchUnpushed),
 * passed in because the scheduler stays git-free. */
export const PUSH_HOLD = "waiting for main to reach origin/main";

export function pushHold(
	mainUnpushed: boolean,
	t: Pick<Task, "stage" | "state" | "pushRetries" | "pendingBy">,
): string | null {
	if (!mainUnpushed || t.stage !== "merging" || t.state !== "queued")
		return null;
	return t.pushRetries > 0 || t.pendingBy === "user" ? null : PUSH_HOLD;
}

/** One live review's findings plus every finding id in the array, for mergeHold and
 * reviewHoldsFor. Cached per tasks array (OTTR-940): the state build's release stamps
 * and stall warnings call mergeHold once per task per release on one array, and
 * reviewFindings walks every card per review — uncached that repeats the whole walk
 * per call. The array is read-only while cached: every call site passes a fresh store
 * read or a filter result and never mutates it. */
const reviewClosures = new WeakMap<
	readonly ReviewTask[],
	{ byReview: Map<string, ReviewTask[]>; anyFinding: Set<string> }
>();

function reviewClosure(tasks: readonly ReviewTask[]): {
	byReview: Map<string, ReviewTask[]>;
	anyFinding: Set<string>;
} {
	let c = reviewClosures.get(tasks);
	if (c === undefined) {
		const byReview = new Map<string, ReviewTask[]>();
		const anyFinding = new Set<string>();
		for (const r of tasks) {
			if (r.cancelledAt !== null || !isReview(r)) continue;
			const fs = reviewFindings(tasks, r);
			byReview.set(r.id, fs);
			for (const f of fs) anyFinding.add(f.id);
		}
		c = { byReview, anyFinding };
		reviewClosures.set(tasks, c);
	}
	return c;
}

/** The bound after which the review-running and findings holds stop gating a queued merge
 * (docs/specs/review-hold-throughput.md, OTTR-1253): a review, its findings, and its gates
 * must never hold every other merge for days. The release hold stays uncapped. */
export const REVIEW_HOLD_MAX_MS = 48 * 60 * 60_000;

/** One review hold on a queued merge, with the facts the board report names: the review
 * that holds, the anchor the hold counts from, and when the cap frees the merge (null for
 * the uncapped release hold, or when the anchor is not a finite timestamp). */
export type ReviewHoldDetail = {
	reviewId: string;
	hold: string;
	since: number;
	capAt: number | null;
};

/** Builds one hold under the cap, or null once `now` is past it. A `now` of undefined
 * keeps the hold: every caller without `now` keeps the uncapped legacy behavior. A
 * non-finite anchor (a card without createdAt, as in report fixtures) never expires. */
function cappedHold(
	reviewId: string,
	hold: string,
	since: number,
	now: number | undefined,
): ReviewHoldDetail | null {
	const capAt = since + REVIEW_HOLD_MAX_MS;
	if (!Number.isFinite(capAt)) return { reviewId, hold, since: 0, capAt: null };
	if (now !== undefined && now >= capAt) return null;
	return { reviewId, hold, since, capAt };
}

/** The holds the open reviews put on `merge`, in review order — the first one gates. Each
 * carries its review id, anchor, and cap time. Pure. `now` turns the 48 h cap on
 * (OTTR-1253); without it the holds never expire, so existing callers keep their behavior. */
export function reviewHoldsFor(
	tasks: readonly ReviewTask[],
	merge: Pick<Task, "id">,
	now?: number,
): ReviewHoldDetail[] {
	const { byReview, anyFinding } = reviewClosure(tasks);
	const out: ReviewHoldDetail[] = [];
	for (const r of tasks) {
		if (r.id === merge.id || r.cancelledAt !== null || !isReview(r)) continue;
		const held = reviewHoldDetail(
			byReview.get(r.id) ?? [],
			r,
			merge.id,
			anyFinding.has(merge.id),
			now,
		);
		if (held !== null) out.push(held);
	}
	return out;
}

/** The hold the open review `r` puts on `merge`, else null when `merge` is exempt: it is
 * `r` itself, one of `r`'s findings, or — OTTR-1253 — a finding of some other review. A
 * finding never waits for a review to finish or for that review's findings, so a review
 * whose gate needs a finding's fix cannot hold the fix it needs (OTTR-940 broke this cycle
 * for the findings hold; the exemption now also covers the running hold). `findings` is
 * `r`'s findings from the shared reviewClosure; `mergeIsFinding` says `mergeId` is a
 * finding of some review, not necessarily `r`. */
function reviewHoldDetail(
	findings: readonly ReviewTask[],
	r: ReviewTask,
	mergeId: string,
	mergeIsFinding: boolean,
	now: number | undefined,
): ReviewHoldDetail | null {
	if (findings.some((f) => f.id === mergeId)) return null;
	if (r.releaseVersion !== null && r.stage !== "done")
		return {
			reviewId: r.id,
			hold: `waiting for release ${r.releaseVersion}`,
			since: r.createdAt,
			capAt: null,
		};
	if (mergeIsFinding) return null;
	if (r.stage === "todo" || r.stage === "in_progress")
		return cappedHold(r.id, REVIEW_RUN_HOLD, r.createdAt, now);
	// Parked at merging until its findings are done (findingsHold); a done review reaches
	// this with open findings only through a finding that was a commitment when it
	// finished. A finding the store flagged as a parked backlog lead at doneAt never
	// takes the hold (OTTR-963), also after it leaves the backlog: leads are optional
	// work (their backlog stage already exempted them, OTTR-889), so a lead the user
	// promotes later must not park every merge the review's done had freed. The flag is
	// the store's record of the stage at doneAt (runTaskUpdate stamps it when the review
	// lands done; the migration backfills it from the stage history), so a re-queue
	// cannot blur it the way the queuedAt stamp would.
	if (r.stage === "merging" || reviewOpenFindings(findings, r).length > 0)
		return cappedHold(r.id, FINDINGS_HOLD, r.doneAt ?? r.createdAt, now);
	return null;
}

/** Why the tracker holds a queued merge, else null. While a review runs, and until its
 * findings are done, only findings merge; every other card waits in merging. OTTR-1253
 * bounds the two review holds: past `REVIEW_HOLD_MAX_MS` from the review's anchor (the
 * card's createdAt for the running hold, its doneAt for the findings hold) the hold stops
 * gating, so a review whose gate cannot pass never stalls the project for days. A finding
 * of any live review never takes either hold (OTTR-940, OTTR-1253): a review that needs a
 * finding's fix cannot hold that fix. The release hold stays uncapped, and a done review
 * holds other merges only behind findings that were commitments when it finished: a
 * finding that was still a parked backlog lead at doneAt stays optional work after the
 * user promotes it and never holds (OTTR-963). While local main has commits origin lacks
 * (a rejected server push, `o.mainUnpushed`), every queued merge but the rejected card's
 * rebase retry waits too (pushHold). With `o.prMode`, main is never written locally, so
 * that hold is inert. `o.now` turns the cap on; without it the holds never expire. */
export function mergeHold(
	tasks: readonly ReviewTask[],
	merge: Pick<Task, "id" | "stage" | "state" | "pushRetries" | "pendingBy">,
	o: {
		now?: number;
		mainUnpushed?: boolean;
		prMode?: boolean;
	} = {},
): string | null {
	const held = reviewHoldsFor(tasks, merge, o.now)[0]?.hold ?? null;
	if (held !== null) return held;
	if (o.mainUnpushed === true && o.prMode !== true) {
		const held = pushHold(true, merge);
		if (held !== null) return held;
	}
	return null;
}

/** The hold a running review parks merges under. */
export const REVIEW_RUN_HOLD = "waiting for the review to finish";

/** Why an approved review card waits in merging instead of done, else null: a review is done
 * only once the findings it filed are done, and a release publishes only then. */
export const FINDINGS_HOLD =
	"waiting for the review's findings to be implemented";

/** The cards a card's review hold waits for, else empty (OTTR-1258). It reads the first
 * hold reviewHoldsFor returns — the one mergeHold reports, under the same `now` cap — so
 * the drawer's hold banner names exactly the cards the hold counts: the open findings of
 * the review whose findings hold parks `t` (reviewOpenFindings), or the review itself
 * while it runs or holds a release. Empty when no review holds `t`, or the hold names no
 * card (a parked merging review with no open findings left). */
export function holdWaitCards<T extends ReviewTask>(
	tasks: readonly T[],
	t: Pick<Task, "id">,
	now?: number,
): T[] {
	const held = reviewHoldsFor(tasks, t, now)[0];
	if (held === undefined) return [];
	const r = tasks.find((c) => c.id === held.reviewId);
	if (r === undefined) return [];
	if (held.hold === FINDINGS_HOLD)
		// reviewClosure stores the caller's own task objects, so the cast keeps the
		// exact T references the board handed in.
		return reviewOpenFindings(
			(reviewClosure(tasks).byReview.get(r.id) ?? []) as T[],
			r,
		);
	return [r];
}

/** Why a review card parks while its stored findings were never run through the
 * second-model check: the findings exist on the card but no check stamp covers them. */
export const UNCHECKED_FINDINGS_HOLD =
	"waiting for the review's stored findings to be checked";

export function findingsHold(
	tasks: readonly ReviewTask[],
	review: Pick<Task, "id" | "doneAt">,
): string | null {
	return findingsOpen(tasks, review) ? FINDINGS_HOLD : null;
}

/** The queued merges mergeHold parks behind the open release `review` ("waiting for release
 * <version>"): the cards its hold names, its own findings excluded (they merge while it runs).
 * A done or cancelled review, and the Review button's card (no releaseVersion), holds nothing. */
export function releaseHeldMerges<
	T extends ReviewTask &
		Pick<Task, "state" | "stage" | "pushRetries" | "pendingBy">,
>(tasks: readonly T[], review: ReviewTask & Pick<Task, "state">): T[] {
	if (
		review.cancelledAt !== null ||
		review.releaseVersion === null ||
		review.stage === "done"
	)
		return [];
	const hold = `waiting for release ${review.releaseVersion}`;
	return tasks.filter(
		(t) =>
			t.id !== review.id &&
			t.cancelledAt === null &&
			t.state === "queued" &&
			mergeHold(tasks, t) === hold,
	);
}

/** When the release's findings last reached done or cancelled, else null while one is still open
 * or the review has not finished (it may still file findings): the anchor for "the release holds
 * merges with nothing left to do". */
export function findingsSettledAt(
	tasks: readonly ReviewTask[],
	review: Pick<Task, "id" | "doneAt">,
): number | null {
	const findings = reviewFindings(tasks, review);
	if (findingsOpen(tasks, review)) return null;
	// The review's own doneAt is only the fallback: a review that filed findings settles
	// when its last finding did, not when the review itself finished.
	let at: number | null = null;
	for (const f of findings) {
		const end = f.cancelledAt ?? f.doneAt;
		if (end !== null && (at === null || end > at)) at = end;
	}
	return at ?? review.doneAt;
}

/** The review card that stops a new review (Review button or Create release), with the reason,
 * else null. One review at a time, and a review stays open until its findings are done: two open
 * reviews would hold each other's findings and deadlock. */
export function blockingReview(
	tasks: readonly ReviewTask[],
): { id: string; reason: string } | null {
	for (const r of tasks) {
		if (r.cancelledAt !== null || !isReview(r)) continue;
		if (r.releaseVersion !== null && r.stage !== "done")
			return { id: r.id, reason: "A release is already in progress." };
		if (r.stage === "todo" || r.stage === "in_progress")
			return { id: r.id, reason: "A review is already in progress." };
		if (r.stage === "merging" || findingsOpen(tasks, r))
			return {
				id: r.id,
				reason: "The last review's findings are not done yet.",
			};
	}
	return null;
}

/** Why a new review cannot start, else null; see blockingReview. */
export function reviewBlocked(tasks: readonly ReviewTask[]): string | null {
	return blockingReview(tasks)?.reason ?? null;
}

/** The commit the newest finished review saw (its frozen base), else null: the watermark that the
 * next review's range and the due badge count from. */
export function lastReviewBase(
	tasks: readonly Pick<
		Task,
		"kind" | "releaseVersion" | "cancelledAt" | "stage" | "doneAt" | "base"
	>[],
): string | null {
	let best: { at: number; base: string } | null = null;
	for (const t of tasks) {
		if (t.cancelledAt !== null || t.stage !== "done" || t.base === null)
			continue;
		if (!isReview(t)) continue;
		const at = t.doneAt ?? 0;
		if (best === null || at > best.at) best = { at, base: t.base };
	}
	return best?.base ?? null;
}

/** The newest done full review as the Review-due counter's anchor: its frozen base and the
 * card that froze it, else null. `lastFullReviewBase` is the base-only view of this. */
export function lastFullReview(
	tasks: readonly Pick<
		Task,
		| "id"
		| "kind"
		| "releaseVersion"
		| "cancelledAt"
		| "stage"
		| "doneAt"
		| "base"
	>[],
): { id: string; base: string } | null {
	let best: { at: number; id: string; base: string } | null = null;
	for (const t of tasks) {
		if (t.cancelledAt !== null || t.stage !== "done" || t.base === null)
			continue;
		if (!isReview(t) || t.releaseVersion !== null) continue;
		const at = t.doneAt ?? 0;
		if (best === null || at > best.at) best = { at, id: t.id, base: t.base };
	}
	return best === null ? null : { id: best.id, base: best.base };
}

/** The base the Review-due counter counts from: like lastReviewBase, but only a full review (the
 * Review button's card) counts — a release keeps the counter going, so releases are gated by the
 * delta mutation run, not a new full one. lastReviewBase stays for the review-context and
 * OTTR_ARCH_REVIEW call sites. */
export function lastFullReviewBase(
	tasks: readonly Pick<
		Task,
		| "id"
		| "kind"
		| "releaseVersion"
		| "cancelledAt"
		| "stage"
		| "doneAt"
		| "base"
	>[],
): string | null {
	return lastFullReview(tasks)?.base ?? null;
}

/** A review is due once the delta reaches the cap; a project with no watermark yet is always due.
 * Pure, and kept here (not in worktree.ts) so the UI's scheduler imports stay git-free. */
export function archReviewDue(
	delta: number,
	cap: number,
	reviewed: boolean,
): boolean {
	return !reviewed || delta >= cap;
}

/** The ArchReview view the project ships: the base the delta counts from and the card that set
 * it, both from the anchor `archReviewDelta` counted with, so the view cannot disagree with the
 * count. `last` is the newest done full review whose base fed the delta call; an anchor that is
 * not that base is a newer baseline `docs(arch-review):` commit — a count no card set. */
export function archReviewView(
	last: { id: string; base: string } | null,
	a: { delta: number; reviewed: boolean; anchor: string },
	cap: number,
	runningCardId: string | null,
): ArchReview {
	return {
		delta: a.delta,
		reviewed: a.reviewed,
		base: a.anchor === "" ? null : a.anchor,
		reviewCardId: last !== null && last.base === a.anchor ? last.id : null,
		cap,
		due: archReviewDue(a.delta, cap, a.reviewed),
		running: runningCardId !== null,
		runningCardId,
	};
}

/** One dependency card a hold names: the facts `waitingOn` needs, own project or foreign
 * (OTTR-708). */
export type DepCard = Pick<Task, "id" | "title" | "stage" | "cancelledAt">;

/** Looks a dependsOn id up across every project's store; null when no project has the
 * card (an unresolvable dep counts as satisfied, like one missing from the own list). */
export type DepIndex = (id: string) => DepCard | null;

/** One project the cross-project dependsOn resolver sees: the board's project name, its
 * id handle (settings.taskIdPrefix or the folder-derived default), and the task lookup. */
export interface DepProject {
	name: string;
	prefix: string;
	getTask(id: string): DepCard | null;
}

/** Why one dependsOn id names no card across the board:
 * - "own": no own card and no `PREFIX-n` shape (legacy hex, retro child, malformed);
 * - "project": the prefix names no registered project;
 * - "ambiguous": several registered projects share the prefix;
 * - "task": the prefix's project has no such card. */
export type DepMiss =
	| { why: "own"; id: string }
	| { why: "project"; id: string; prefix: string }
	| { why: "ambiguous"; id: string; prefix: string; projects: string[] }
	| { why: "task"; id: string; project: string };

/** One dependsOn id resolved across projects: the card with its project, else DepMiss. */
export type DepResolution = { task: DepCard; project: string } | DepMiss;

/** The `PREFIX-n` shape a foreign dependsOn id can carry: the letter-and-digit handle the
 * id settings accept (at most 8, like app.ts TASK_ID_RE). Legacy hex and retro children
 * never match; own `PREFIX-n` ids are the own-store hit's job. */
const DEP_PREFIX_RE = /^([A-Z0-9]{1,8})-(\d+)$/;

/** Resolves one dependsOn id across the board's projects (OTTR-708). A card in the own
 * project wins whatever the id looks like; otherwise the `PREFIX-n` prefix maps to a
 * project by its id handle. Pure. */
export function resolveDep(
	id: string,
	projects: Iterable<DepProject>,
	own: DepProject,
): DepResolution {
	const local = own.getTask(id);
	if (local !== null) return { task: local, project: own.name };
	const m = DEP_PREFIX_RE.exec(id);
	if (m === null) return { why: "own", id };
	const prefix = m[1] ?? "";
	const hits = [...projects].filter((p) => p.prefix === prefix);
	if (hits.length === 0) return { why: "project", id, prefix };
	if (hits.length > 1)
		return { why: "ambiguous", id, prefix, projects: hits.map((p) => p.name) };
	const [foreign] = hits;
	if (foreign === undefined) return { why: "project", id, prefix };
	const task = foreign.getTask(id);
	if (task === null) return { why: "task", id, project: foreign.name };
	return { task, project: foreign.name };
}

/** resolveDep flattened for the hold paths: the dep card, or null when the id names no
 * card anywhere (satisfied at scheduling; validation is the create route's and the
 * settle block's job). */
export function findDep(
	id: string,
	projects: Iterable<DepProject>,
	own: DepProject,
): DepCard | null {
	const r = resolveDep(id, projects, own);
	return "task" in r ? r.task : null;
}

/** The resolver's view of one project store: name, id handle, task lookup. */
export async function depProjectOf(store: {
	name: string;
	taskPrefix(): Promise<string>;
	listTasks(): Promise<DepCard[]>;
	transaction<T>(work: () => T | Promise<T>): Promise<T>;
}): Promise<DepProject> {
	return store.transaction(async () => {
		const prefix = await store.taskPrefix();
		const tasks = await store.listTasks();
		const byId = new Map(tasks.map((task) => [task.id, task]));
		return {
			name: store.name,
			prefix,
			getTask: (id: string) => byId.get(id) ?? null,
		};
	});
}

/** The resolver's view of the board's projects; entries only need a store. */
export async function depProjectsOf(
	projects: Iterable<{
		store: {
			name: string;
			taskPrefix(): Promise<string>;
			listTasks(): Promise<DepCard[]>;
			transaction<T>(work: () => T | Promise<T>): Promise<T>;
		};
	}>,
): Promise<DepProject[]> {
	return Promise.all([...projects].map((e) => depProjectOf(e.store)));
}

/** The needs_you reason a settle block shows for a report_outcome dependsOn id that
 * names no card (OTTR-708). `own` decides "this project" vs naming the foreign project. */
export function depMissReason(id: string, miss: DepMiss, own: string): string {
	const tail = "Reply to continue, or cancel the card.";
	switch (miss.why) {
		case "project":
			return `report_outcome's dependsOn names #${id}, but no project ${miss.prefix} exists on the board. ${tail}`;
		case "ambiguous":
			return `report_outcome's dependsOn names #${id}, but more than one project uses the ${miss.prefix} id handle (${miss.projects.join(", ")}). ${tail}`;
		case "task":
			return miss.project === own
				? `report_outcome's dependsOn names #${id}, which is not a card in this project. ${tail}`
				: `report_outcome's dependsOn names #${id}, which is not a card in project ${miss.project}. ${tail}`;
		default:
			return `report_outcome's dependsOn names #${id}, which is not a card in this project. ${tail}`;
	}
}

/** The first report_outcome dependsOn id the settle block must reject — the card itself,
 * or an id naming no card across the board — with its needs_you reason; null records the
 * ids and holds (OTTR-708). */
export function badDep(
	deps: readonly string[],
	projects: Iterable<DepProject>,
	own: DepProject,
	self: string,
): { id: string; reason: string } | null {
	for (const id of deps) {
		if (id === self)
			return {
				id,
				reason: `report_outcome's dependsOn names #${id}, which is this card itself. Reply to continue, or cancel the card.`,
			};
		const r = resolveDep(id, projects, own);
		if (!("task" in r)) return { id, reason: depMissReason(id, r, own.name) };
	}
	return null;
}

/** The unfinished dependency cards `t` waits for, in its dependsOn order. A cancelled dependency
 * counts as satisfied: cancelling M1 must not strand M2 in the queue forever. `tasks` must be the
 * whole project: a dependency missing from it counts as done. `foreign` (OTTR-708) looks an id
 * up across the board's projects; one it cannot resolve counts as done too. */
export function waitingOn<
	T extends Pick<Task, "id" | "stage" | "cancelledAt">,
	F extends DepCard = never,
>(
	tasks: readonly T[],
	t: Pick<Task, "dependsOn">,
	foreign?: (id: string) => F | null,
): (T | F)[] {
	if (t.dependsOn.length === 0) return [];
	const byId = new Map(tasks.map((d) => [d.id, d]));
	return t.dependsOn.flatMap((id) => {
		const d = byId.get(id) ?? foreign?.(id) ?? null;
		return d !== null && d.cancelledAt === null && d.stage !== "done"
			? [d]
			: [];
	});
}

/** Why the queued card may not start yet — unfinished dependencies — else null. */
export function depHold(
	tasks: readonly DepCard[],
	t: Pick<Task, "dependsOn">,
	foreign?: DepIndex,
): string | null {
	const waiting = waitingOn(tasks, t, foreign);
	return waiting.length === 0
		? null
		: `waiting for ${waiting.map((d) => `#${d.id} ${d.title}`).join(", ")}`;
}

/** The dependency writers' in-process lock (OTTR-1318): the depends-on route and the
 * settle block's reported-deps write serialize their cycle validation with their write,
 * so two writers in one process cannot each validate against the other's pre-write
 * snapshot. Writers in different processes coordinate by validating their own final
 * list against fresh snapshots and dropping the edges that close a cycle; a cross-process
 * interleave that still lands a cycle is the documented residual (spec Risks). */
let depWriteTail: Promise<unknown> = Promise.resolve();
export function withDepWriteLock<T>(work: () => Promise<T>): Promise<T> {
	const run = depWriteTail.then(work, work);
	depWriteTail = run.catch(() => undefined);
	return run;
}

/** The ids in `candidate` whose inclusion closes a dependency cycle through the card:
 * from each id, following the committed dependsOn links of every resolvable card in the
 * project whose card names it (the hold's own resolution rule) must never reach the card
 * again. `depsOf` reads a card's committed list in its project; an id the resolver
 * cannot reach stops that walk the same way the satisfied rule stops a hold. Pure. */
export function cyclicDepIds(
	candidate: readonly string[],
	ownId: string,
	ownProject: string,
	projects: Iterable<DepProject>,
	depsOf: (project: string, id: string) => readonly string[] | undefined,
): string[] {
	const all = [...projects];
	const cyclic: string[] = [];
	for (const id of candidate) {
		const frontier: { id: string; project: string }[] = [
			{ id, project: ownProject },
		];
		const walked = new Set<string>();
		let closes = false;
		while (frontier.length > 0) {
			const step = frontier.pop();
			if (step === undefined) break;
			const own = all.find((p) => p.name === step.project);
			if (own === undefined) continue;
			const dep = resolveDep(step.id, all, own);
			if (!("task" in dep)) continue;
			const key = `${dep.project}/${dep.task.id}`;
			if (key === `${ownProject}/${ownId}`) {
				closes = true;
				break;
			}
			if (walked.has(key)) continue;
			walked.add(key);
			const links = depsOf(dep.project, dep.task.id);
			if (links !== undefined)
				frontier.push(
					...links.map((next) => ({ id: next, project: dep.project })),
				);
		}
		if (closes) cyclic.push(id);
	}
	return cyclic;
}

/** Options of the per-project pickers (pickRunnable, pickLowPriority). */
export interface PickOptions {
	/** Null = no cap: as many runs as queued cards need. */
	maxParallel: number | null;
	hasRules: boolean;
	/** Set during an update's hold: only this queued card may start, and null lets none start.
	 * The other cards still take their slots and hold their dependents. */
	only?: string | null;
	/** A queued card waits until its holdUntil, e.g. a check held until a usage limit resets. */
	now?: number;
	/** OTTR-506: true while the project's local target branch has commits origin lacks (a
	 * rejected server push). Every queued merge but the rejected card's rebase retry waits
	 * (pushHold); the retry runs first, and its push ends the hold. */
	mainUnpushed?: boolean;
	/** True while the project merges via PR: a queued card re-runs its merge turn even with
	 * an open PR (OTTR-799), and mainUnpushed's hold is inert (mergeHold). */
	prMode?: boolean;
	/** OTTR-708: looks a dependsOn id up across every project's store (findDep); null
	 * counts the dependency as satisfied, like one missing from the own list. */
	crossDeps?: DepIndex;
}

/** The oldest queued merge that no open review holds and whose dependencies are done; null
 * when a merge turn already runs or nothing qualifies. A queued merge re-runs even while the
 * card carries an open PR (OTTR-799's re-ship); an idle PR card never qualifies because it
 * is not queued. */
function mergeSlot(
	live: ListedTask[],
	running: ListedTask[],
	queued: ListedTask[],
	o: PickOptions,
): ListedTask | null {
	if (running.some((t) => t.stage === "merging")) return null;
	return (
		queued.find(
			(t) =>
				t.stage === "merging" &&
				mergeHold(live, t, {
					// Same default as pickRunnable's holdUntil check: the cap runs on real
					// time unless the caller pins a clock.
					now: o.now ?? Date.now(),
					mainUnpushed: o.mainUnpushed === true,
					prMode: o.prMode === true,
				}) === null &&
				depHold(live, t, o.crossDeps) === null,
		) ?? null
	);
}

/** The queued grill card when no grill runs and a slot is free; null otherwise. A drain
 * (`only` set) has already narrowed `queued` to that one card. */
function grillSlot(
	live: ListedTask[],
	queued: ListedTask[],
	free: number,
): ListedTask | null {
	const grilling = live.some(
		(t) =>
			t.stage === "backlog" &&
			(t.state === "running" || t.state === "preparing"),
	);
	if (grilling || free <= 0) return null;
	return queued.find((t) => t.stage === "backlog") ?? null;
}

/** A queued card fills a work slot when it is not a trending scout, its stage needs no rules
 * file it lacks, and its dependencies are done. */
function workSlotReady(
	live: ListedTask[],
	t: ListedTask,
	o: PickOptions,
): boolean {
	// A trending scout only fills a slot nothing else wanted: pickLowPriority, after every project.
	if (t.kind === "trending") return false;
	// Work slots only: todo and in_progress (replies). Needs a rules file before a fresh todo starts.
	// A lead that waits for a sandbox never runs as a work turn (OTTR-1128): it has no sandbox_run.
	// A lead waiting for its review's validation run never runs as a work turn, also when
	// validatedAt is set (OTTR-1252): a "still blocked" result keeps the wait. pendingSandboxLead
	// stays for legacy backlog leads.
	if (pendingSandboxLead(t) || t.waitsValidation) return false;
	if (t.stage === "todo" && !o.hasRules && t.kind !== "interview") return false;
	// A queued card waits until every dependency is done (a cancelled dependency counts as
	// done, waitingOn); merging cards wait in the merge slot above.
	if (
		(t.stage === "todo" || t.stage === "in_progress") &&
		depHold(live, t, o.crossDeps) !== null
	)
		return false;
	return t.stage === "todo" || t.stage === "in_progress";
}

/** Fills the work slots (todo, and in_progress replies) with the queued cards that pass the
 * holds, up to `free` slots; appends to `picked`. */
function pickWorkSlots(
	live: ListedTask[],
	queued: ListedTask[],
	picked: ListedTask[],
	o: PickOptions,
	free: number,
): void {
	let slots = free;
	for (const t of queued) {
		if (picked.includes(t)) continue;
		if (slots <= 0) break;
		if (!workSlotReady(live, t, o)) continue;
		picked.push(t);
		slots -= 1;
	}
}

/** Pick the tasks that may start an omp run right now. Pure; `tasks` is one project's tasks.
 * A trending scout card never takes a normal slot: pickLowPriority offers it afterwards. */
export function pickRunnable(
	tasks: ListedTask[],
	o: PickOptions,
): ListedTask[] {
	const live = tasks.filter((t) => t.cancelledAt === null);
	const running = live.filter(
		(t) => t.state === "running" || t.state === "preparing",
	);
	let free = (o.maxParallel ?? Infinity) - running.length;
	if (free <= 0) return [];

	const now = o.now ?? Date.now();
	const queued = queueOrder(tasks).filter(
		(t) =>
			(o.only === undefined || t.id === o.only) &&
			(t.holdUntil === null || t.holdUntil <= now),
	);

	const picked: ListedTask[] = [];

	// The merge slot: only if no merge turn is already running, take the oldest queued merge that no
	// open review holds. An open release holds every merge but its findings', so no merge can race
	// its publish (mergeHold).
	// While local main has commits origin lacks, only the rejected card's rebase retry may
	// start (pushHold), so the retry repairs main before anything merges — except in PR mode,
	// where main is never written locally.
	const merge = mergeSlot(live, running, queued, o);
	if (merge !== null) {
		picked.push(merge);
		free -= 1;
	}

	// The grill slot: a backlog card runs only when the user kicks it (state queued), and at
	// most one grill runs at a time — every grill asks questions, so two at once just double
	// the bells. A drain (`only` set) has already narrowed `queued` to that one card.
	const grill = grillSlot(live, queued, free);
	if (grill !== null) {
		picked.push(grill);
		free -= 1;
	}

	pickWorkSlots(live, queued, picked, o, free);
	return picked;
}

/** The low-priority slot: the oldest queued trending scout card, when the project still has
 * a free slot. schedule() offers it only after every project's pickRunnable picks, so a scout
 * never delays a normal card. Same holds as a work card (drain `only`, holdUntil,
 * dependencies). Pure; `tasks` is one project's tasks. */
export function pickLowPriority(
	tasks: ListedTask[],
	o: PickOptions,
): ListedTask | null {
	const live = tasks.filter((t) => t.cancelledAt === null);
	const running = live.filter(
		(t) => t.state === "running" || t.state === "preparing",
	);
	if ((o.maxParallel ?? Infinity) - running.length <= 0) return null;
	const now = o.now ?? Date.now();
	return (
		queueOrder(tasks).find(
			(t) =>
				t.kind === "trending" &&
				(o.only === undefined || t.id === o.only) &&
				(t.holdUntil === null || t.holdUntil <= now) &&
				(t.stage === "todo" || t.stage === "in_progress") &&
				depHold(live, t, o.crossDeps) === null,
		) ?? null
	);
}

/** The findings that go to the check run (or straight to cards with the check off): the `cap`
 * best-ranked findings, plus every confirmed high or critical security finding beyond the cap.
 * A finding recorded without a rank sorts last; ties keep the record order. Pure. */
export function selectFindings(
	recorded: readonly RecordedFinding[],
	cap = 10,
): RecordedFinding[] {
	const order = recorded
		.map((f, i) => ({ f, i }))
		.sort((a, b) => {
			const ra = a.f.rank ?? Number.POSITIVE_INFINITY;
			const rb = b.f.rank ?? Number.POSITIVE_INFINITY;
			return ra === rb ? a.i - b.i : ra - rb;
		})
		.map((x) => x.f);
	const picked = order.slice(0, cap);
	for (const f of order.slice(cap))
		if (f.security === "critical" || f.security === "high") picked.push(f);
	return picked;
}

/** The check run's model role for a work model: the user-set vendor rules first
 *  (checkRoutingSetting), else the built-in default rule below. The vendor comes from the
 *  model id, not the provider prefix (modelVendor), so Claude through another provider is
 *  still an Anthropic model. Never fails: every path returns a role name. */
export function checkRoleFor(
	settings: CheckRoutingSetting | null,
	roles: Record<string, string>,
	reviewModel: string | null,
): string {
	return routeCheck(settings, roles, reviewModel).role;
}

/** Why the routing fell back from a user rule or the user fallback to the default rule,
 *  as one card-log line; null when the route needs no explanation (no setting, a matched
 *  rule whose role has a configured model, or a fallback with one). Pure. */
export function checkRoutingNote(
	settings: CheckRoutingSetting | null,
	roles: Record<string, string>,
	reviewModel: string | null,
): string | null {
	return routeCheck(settings, roles, reviewModel).note;
}

/** The two exports above share this one resolution (docs/specs/check-role-routing.md).
 *  `roles` is the omp config role map (role -> selector, file order); a null vendor
 *  (no known token in the model id) counts as the vendor "unknown". Pure. */
function routeCheck(
	settings: CheckRoutingSetting | null,
	roles: Record<string, string>,
	reviewModel: string | null,
): { role: string; note: string | null } {
	const workVendor = modelVendor(reviewModel ?? "");
	const def = defaultCheckRole(roles, workVendor);
	if (settings === null) return { role: def, note: null };
	const vendor = workVendor ?? "unknown";
	const rule = settings.rules.find((r) => r.vendor === vendor);
	if (rule !== undefined) {
		// hasOwn, not a bare member read: a rule may name "constructor", which must
		// stay an unconfigured role (default rule + note), not Object.prototype's.
		if (Object.hasOwn(roles, rule.role)) return { role: rule.role, note: null };
		return {
			role: def,
			note: `check routing: rule ${rule.vendor} -> ${rule.role} names no configured role, using the default rule`,
		};
	}
	if (settings.fallback !== "") {
		if (Object.hasOwn(roles, settings.fallback))
			return { role: settings.fallback, note: null };
		return {
			role: def,
			note: `check routing: fallback ${settings.fallback} names no configured role, using the default rule`,
		};
	}
	return { role: def, note: null };
}

/** The built-in routing, also the fallback of every failed user rule: the first configured
 *  candidate role (critic, adversary, then every other role in config order, except default)
 *  whose model's vendor differs from the work model's; when none differs, today's rule — an
 *  Anthropic work model checks with critic, everything else with adversary. Pure. */
function defaultCheckRole(
	roles: Record<string, string>,
	workVendor: string | null,
): string {
	const candidates = ["critic", "adversary"];
	for (const role of Object.keys(roles))
		if (role !== "default" && role !== "critic" && role !== "adversary")
			candidates.push(role);
	for (const role of candidates) {
		const vendor = modelVendor(roles[role] ?? "");
		if (vendor !== null && vendor !== workVendor) return role;
	}
	return workVendor === "anthropic" ? "critic" : "adversary";
}

/** Why the check cannot give a second-model opinion: "same model" when the check model is the
 *  checked run's own model (thinking level apart at most), "same vendor" when it is at least
 *  the same vendor — Claude checking Claude through another provider. Null when either model
 *  is unknown (null = omp's default, which no role names here) or the vendors differ. Pure. */
export function checkModelWarning(
	workModel: string | null,
	checkModel: string | null,
): "same model" | "same vendor" | null {
	if (workModel === null || checkModel === null) return null;
	if (splitLevel(workModel)[0] === splitLevel(checkModel)[0])
		return "same model";
	const vendor = modelVendor(workModel);
	return vendor !== null && vendor === modelVendor(checkModel)
		? "same vendor"
		: null;
}

/** One verdict of the check run, keyed by the finding id the check prompt assigned (1-based). */
export interface CheckVerdict {
	id: number;
	keep: boolean;
	/** Drop evidence, e.g. "handled at src/x.ts:42"; the prompt demands it for every drop. */
	reason: string;
}

/** Parses the check run's final message into verdicts; null when the text holds no JSON array at
 * all (the run failed and retries). Malformed entries are skipped: they surface per finding as
 * "the check gave no verdict" instead of failing the whole run. */
export function parseCheckVerdicts(text: string): CheckVerdict[] | null {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const out: CheckVerdict[] = [];
	for (const v of parsed) {
		if (typeof v !== "object" || v === null) continue;
		const r = v as Record<string, unknown>;
		if (
			typeof r.id !== "number" ||
			!Number.isInteger(r.id) ||
			typeof r.keep !== "boolean" ||
			typeof r.reason !== "string"
		)
			continue;
		out.push({ id: r.id, keep: r.keep, reason: r.reason.trim() });
	}
	return out;
}

/** Splits the selected findings into kept and dropped by the check's verdicts. A finding the
 * check gave no verdict for drops with an explicit reason; a drop without evidence keeps the
 * reason "no reason given" so the review card never shows a silent drop. Pure. */
export function applyCheckVerdicts(
	selected: readonly RecordedFinding[],
	verdicts: readonly CheckVerdict[],
): {
	kept: { id: number; finding: RecordedFinding }[];
	dropped: { id: number; finding: RecordedFinding; reason: string }[];
} {
	const byId = new Map(verdicts.map((v) => [v.id, v]));
	const kept: { id: number; finding: RecordedFinding }[] = [];
	const dropped: { id: number; finding: RecordedFinding; reason: string }[] =
		[];
	selected.forEach((finding, i) => {
		const id = i + 1;
		const v = byId.get(id);
		if (v?.keep === true) kept.push({ id, finding });
		else
			dropped.push({
				id,
				finding,
				reason:
					v === undefined
						? "the check gave no verdict"
						: v.reason === ""
							? "no reason given"
							: v.reason,
			});
	});
	return { kept, dropped };
}

/** One parsed verdict of a work-card check: the blockers it raises, its non-blocking notes,
 * the earlier blockers it confirms fixed (by the id the check prompt assigned), and the
 * earlier blockers it reports as still open, each with fresh evidence. */
export interface WorkCheckVerdict {
	blockers: {
		finding: string;
		quote: string;
		severity?: WorkCheckBlocker["severity"];
		bugClass?: string;
	}[];
	notes: string[];
	fixed: { id: number; reason: string }[];
	stillOpen: { id: number; quote: string; reason: string }[];
}

export interface WorkCheckSplit {
	blockers: WorkCheckBlocker[];
	notes: string[];
}

/** The verdict's blockers; null when `r.blockers` exists but is malformed (the run retries). */
function parseWorkBlockers(
	r: Record<string, unknown>,
): WorkCheckVerdict["blockers"] | null {
	if (r.blockers === undefined) return [];
	if (!Array.isArray(r.blockers)) return null;
	const blockers: WorkCheckVerdict["blockers"] = [];
	for (const b of r.blockers) {
		if (typeof b !== "object" || b === null) continue;
		const e = b as Record<string, unknown>;
		if (typeof e.finding !== "string" || typeof e.quote !== "string") continue;
		const severity =
			e.severity === "important" ||
			e.severity === "nit" ||
			e.severity === "pre-existing"
				? e.severity
				: undefined;
		blockers.push({
			finding: e.finding,
			quote: e.quote,
			severity,
			bugClass:
				typeof e.bugClass === "string" && e.bugClass.trim() !== ""
					? e.bugClass.trim()
					: undefined,
		});
	}
	return blockers;
}

/** The verdict's notes; null when `r.notes` exists but is malformed (the run retries). */
function parseWorkNotes(r: Record<string, unknown>): string[] | null {
	if (r.notes === undefined) return [];
	if (!Array.isArray(r.notes)) return null;
	const notes: string[] = [];
	for (const n of r.notes)
		if (typeof n === "string" && n.trim() !== "") notes.push(n);
	return notes;
}

/** The verdict's confirmed fixes; null when `r.fixed` exists but is malformed (the run retries). */
function parseWorkFixed(
	r: Record<string, unknown>,
): { id: number; reason: string }[] | null {
	if (r.fixed === undefined) return [];
	if (!Array.isArray(r.fixed)) return null;
	const fixed: { id: number; reason: string }[] = [];
	for (const f of r.fixed) {
		if (typeof f !== "object" || f === null) continue;
		const e = f as Record<string, unknown>;
		if (
			typeof e.id !== "number" ||
			!Number.isInteger(e.id) ||
			typeof e.reason !== "string"
		)
			continue;
		fixed.push({ id: e.id, reason: e.reason.trim() });
	}
	return fixed;
}

/** The verdict's still-open references; null when `r.stillOpen` exists but is malformed
 * (the run retries). Malformed entries are skipped, never fatal. Pure. */
function parseWorkStillOpen(
	r: Record<string, unknown>,
): WorkCheckVerdict["stillOpen"] | null {
	if (r.stillOpen === undefined) return [];
	if (!Array.isArray(r.stillOpen)) return null;
	const stillOpen: WorkCheckVerdict["stillOpen"] = [];
	for (const s of r.stillOpen) {
		if (typeof s !== "object" || s === null) continue;
		const e = s as Record<string, unknown>;
		if (
			typeof e.id !== "number" ||
			!Number.isInteger(e.id) ||
			typeof e.quote !== "string" ||
			typeof e.reason !== "string"
		)
			continue;
		stillOpen.push({ id: e.id, quote: e.quote, reason: e.reason.trim() });
	}
	return stillOpen;
}

/** Parses the work check's final message; null when the text holds no JSON object at all (the
 * run failed and retries). Malformed entries are skipped, never fatal. Pure. */
export function parseWorkCheck(text: string): WorkCheckVerdict | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const r = parsed as Record<string, unknown>;
	const blockers = parseWorkBlockers(r);
	if (blockers === null) return null;
	const notes = parseWorkNotes(r);
	if (notes === null) return null;
	const fixed = parseWorkFixed(r);
	if (fixed === null) return null;
	const stillOpen = parseWorkStillOpen(r);
	if (stillOpen === null) return null;
	return { blockers, notes, fixed, stillOpen };
}

/** Open blockers from the latest blockers run. Earlier runs remain as history,
 * so recurring quotes count once. Pure. */
export function openWorkBlockers(
	log: readonly WorkCheckRun[],
): WorkCheckBlocker[] {
	for (let i = log.length - 1; i >= 0; i--) {
		const run = log[i];
		if (run === undefined || run.outcome !== "blockers") continue;
		return run.blockers.filter((b) => b.status === undefined);
	}
	return [];
}

/** Rejects a verdict unless each earlier blocker has an explicit fix, a grounded recurrence,
 * or an explicit still-open reference with fresh evidence. A blocker is never cleared
 * without an explicit fix reason. Pure. */
export function workCheckAccountingError(
	verdict: WorkCheckVerdict,
	open: readonly WorkCheckBlocker[],
	blockers: readonly WorkCheckBlocker[],
): string | null {
	const fixed = new Set<number>();
	for (const f of verdict.fixed) {
		if (
			!Number.isInteger(f.id) ||
			f.id < 1 ||
			f.id > open.length ||
			f.reason.trim() === ""
		)
			return "the work check used an invalid fixed blocker ID or an empty fix reason";
		fixed.add(f.id);
	}
	const still = new Set<number>();
	for (const s of verdict.stillOpen) {
		if (
			!Number.isInteger(s.id) ||
			s.id < 1 ||
			s.id > open.length ||
			s.quote.trim() === "" ||
			s.reason.trim() === ""
		)
			return "the work check used an invalid stillOpen blocker ID or an empty quote or reason";
		still.add(s.id);
	}
	const requoted = new Set(blockers.map((b) => b.quote));
	for (const [i, b] of open.entries()) {
		if (!fixed.has(i + 1) && !requoted.has(b.quote) && !still.has(i + 1))
			return `the work check did not account for earlier blocker ${i + 1}`;
	}
	return null;
}

/** Opening of the needs_you reason the work-check block at the send-back cap sets; the reply
 * route reads the ask answers below only on a card parked with it. The count derives from
 * WORK_CHECK_MAX_SENDBACKS so the wording cannot drift from the cap. */
export const WORK_CHECK_ASK_BLOCK = `The work check blocked the merge ${WORK_CHECK_MAX_SENDBACKS + 1} times`;
export const WORK_CHECK_ASK_SEND_BACK = "Send it back";
export const WORK_CHECK_ASK_MERGE = "Merge anyway";

/** The clickable question the cap-exceeded work-check block puts on the card. The reply route
 * turns a click into the send-back or the merge; any other text is a plain reply to the agent. */
export function workCheckAsk(
	blockers: readonly WorkCheckBlocker[],
): AskQuestion[] {
	return [
		{
			question: `${WORK_CHECK_ASK_BLOCK}: ${blockers.map((b, i) => `${i + 1}. ${b.finding}`).join(" ")}. How do you want to continue?`,
			options: [
				{
					label: WORK_CHECK_ASK_SEND_BACK,
					description:
						"The agent gets the blockers once more, fixes them, and the check runs again.",
				},
				{
					label: WORK_CHECK_ASK_MERGE,
					description:
						"Override the open blockers and queue the merge, for example when a blocker only asks for a human review.",
				},
			],
			multi: false,
			recommended: 0,
			text: false,
		},
	];
}

/** Blocker counts of the blocking checks, oldest first. The trend datum for the divergence
 * rule below; error and pass runs contribute nothing (a pass ends the loop anyway). Pure. */
export function workCheckBlockerCounts(log: readonly WorkCheckRun[]): number[] {
	return log
		.filter((r) => r.outcome === "blockers")
		.map((r) => r.blockers.length);
}

/** Bug classes present in both of the last two blocking checks, in the latest run's order.
 * Blockers without a class (old records) never repeat. Pure. */
export function repeatedBugClasses(log: readonly WorkCheckRun[]): string[] {
	const runs = log.filter((r) => r.outcome === "blockers");
	const prev = runs.at(-2);
	const last = runs.at(-1);
	if (prev === undefined || last === undefined) return [];
	const classes = new Set(
		prev.blockers
			.map((b) => b.bugClass)
			.filter((c): c is string => c !== undefined),
	);
	const out: string[] = [];
	for (const b of last.blockers) {
		if (
			b.bugClass !== undefined &&
			classes.has(b.bugClass) &&
			!out.includes(b.bugClass)
		)
			out.push(b.bugClass);
	}
	return out;
}

/** The counts clause of workCheckDiverged: the blocker count did not drop across the last
 * two send-backs (three blocking checks, each not lower than the one before). Pure. */
export function workCheckCountsDiverged(log: readonly WorkCheckRun[]): boolean {
	const counts = workCheckBlockerCounts(log);
	if (counts.length < 3) return false;
	const [a, b, c] = counts.slice(-3);
	return (
		a !== undefined && b !== undefined && c !== undefined && c >= b && b >= a
	);
}

/** A diverging loop: the blocker count did not drop across the last two send-backs, or one
 * bugClass repeats in two consecutive checks. Both signal a shared wrong premise the agent
 * keeps patching around (GUARDRAILS 14a), so the board parks instead of sending back again.
 * Pure. */
export function workCheckDiverged(log: readonly WorkCheckRun[]): boolean {
	return workCheckCountsDiverged(log) || repeatedBugClasses(log).length > 0;
}

/** Opening of the needs_you reason a diverging work-check loop sets; the reply route reads
 * the ask answers below only on a card parked with it. */
export const WORK_CHECK_ASK_DIVERGE = "The work-check loop is diverging";
export const WORK_CHECK_ASK_NEW_APPROACH = "Send back with a new approach";
export const WORK_CHECK_ASK_CANCEL = "Cancel";

/** The three fixed answers a review question card offers per deployment-fact lead;
 * free text rides the drawer's Other field. The first two constants kept their old
 * values (`Yes, the risk applies`, `No, it does not apply`) until OTTR-1227 renamed
 * them; the reply route still matches the old labels on stored `asked`. */
export const LEAD_APPLIES_OPTION = "Applies";
export const LEAD_NOT_APPLY_OPTION = "Does not apply";
export const LEAD_UNSURE_OPTION = "Not sure";
/** The labels the first question cards shipped with, still matched by the reply
 * route so stored `asked` keeps working. */
export const LEAD_APPLIES_OPTION_LEGACY = "Yes, the risk applies";
export const LEAD_NOT_APPLY_OPTION_LEGACY = "No, it does not apply";

/** OTTR-1128: the needs_you reason of a started lead the board cannot move back to the
 * backlog: its branch holds commits from an earlier work turn (or git could not count
 * them). The card stays as it is, so no work is lost; the user decides. */
export const LEAD_COMMITS_REASON =
	"This Needs validation lead holds commits from an earlier work turn, so the board did not move it back to the backlog. A work turn has no sandbox_run: move the card to the backlog to validate it in its review's batch run, or cancel it.";

/** OTTR-1128: the needs_you reason of a started lead with no live review to validate it:
 * no review link, or a missing, cancelled or non-review parent. Only a review's batch
 * validation run can prove a lead, so the board cannot route it; the user decides. */
export const LEAD_NO_REVIEW_REASON =
	"This Needs validation lead has no open review, so no batch validation run can take it, and a work turn has no sandbox_run. Cancel it, or remove the Needs validation tag from its prompt to run it as normal work.";

/** The question card a review files for its deployment-fact leads; the reply route
 * recognizes it by this prompt prefix plus a non-null `asked`. */
export const LEAD_QUESTIONS_PROMPT_PREFIX =
	"Needs-validation lead questions from review #";

/** How a lead prompt names its blocker: one strict line, first match wins. A lead
 * without a matching line waits for a validation sandbox (docs/specs/
 * review-findings-persistence.md §4). Pure. */
const LEAD_BLOCKER_PATTERN =
	/^[^\S\n]*Blocker: (deployment fact|sandbox run): (.+)$/m;

export type LeadBlocker =
	| { kind: "deployment"; question: string }
	| { kind: "sandbox"; control: string | null };

/** Sorts a lead by its blocker line: the exact question a deployment-fact lead asks
 * the user, or the sandbox kind with the named missing control (null when the line
 * is absent or malformed). Pure. */
export function leadBlocker(prompt: string): LeadBlocker {
	const m = LEAD_BLOCKER_PATTERN.exec(prompt);
	if (m === null) return { kind: "sandbox", control: null };
	return m[1] === "deployment fact"
		? { kind: "deployment", question: (m[2] ?? "").trim() }
		: { kind: "sandbox", control: (m[2] ?? "").trim() };
}

/** A review lead: a card whose prompt carries the "Needs validation" tag. The review's
 * question card ("Needs-validation lead questions ...") is not one. Pure. */
export function isLead(t: LeadMark): boolean {
	return "prompt" in t
		? t.prompt.startsWith("Needs validation")
		: t.lead === true;
}

/** OTTR-1128: a lead only a batch validation run can prove — never validated, with a
 * sandbox blocker. A work turn has no sandbox_run, so the scheduler never starts one
 * for it and the routing tick returns it to its review's batch. A deployment-fact
 * lead the user answered and a validated lead stay normal work. Pure. */
export function pendingSandboxLead(
	t: Pick<Task, "prompt" | "validatedAt">,
): boolean {
	return (
		isLead(t) &&
		t.validatedAt === null &&
		leadBlocker(t.prompt).kind === "sandbox"
	);
}

/** OTTR-1247: the wait a pending sandbox lead shows while it sits queued in a work lane
 * (moved to todo, or a started lead whose review still runs): no work turn can take it
 * (pickRunnable skips it, OTTR-1128), and only its review's batch validation run proves
 * it, so the hold names that review. The designed states stay quiet: a backlog lead
 * waits in its batch, a validated lead and a deployment-fact lead run as normal work.
 * Store rows read the prompt tag; wire rows (TaskCard) ship no prompt and read the
 * `sandboxLead` stamp taskView writes instead. Null for any other card or state. Pure. */
export function leadValidationHold(
	t: Pick<
		Task,
		"validatedAt" | "followUpOf" | "stage" | "state" | "cancelledAt"
	> & {
		prompt?: string;
		sandboxLead?: true;
	},
): string | null {
	if (
		t.cancelledAt !== null ||
		t.state !== "queued" ||
		(t.stage !== "todo" && t.stage !== "in_progress")
	)
		return null;
	const pendingSandbox =
		t.sandboxLead === true ||
		(t.prompt !== undefined &&
			pendingSandboxLead({ prompt: t.prompt, validatedAt: t.validatedAt }));
	if (!pendingSandbox) return null;
	return t.followUpOf === null
		? "Waits for a validation run; a work turn has no sandbox_run."
		: `Waits for a validation run of review ${t.followUpOf}; a work turn has no sandbox_run.`;
}

/** OTTR-1247: the coarse refusal of the manual validate start for one lead and its
 * review, or null when the start may file. One predicate for every side: the route
 * maps it to its exact 409s (unchanged texts), the filing transaction gates the park
 * with it, and the drawer renders the action disabled with the reason as its title.
 * Pure. */
export type LeadStartRefusal =
	/** The lead row is cancelled (the route answers 404 before this). */
	| "unknown"
	/** The lead links another card than the review being filed. */
	| "mismatch"
	/** The prompt carries no pending sandbox lead (wrong tag or a deployment fact
	 * answered as normal work). */
	| "not-lead"
	/** The lead has a wait marker or is not a queued todo/in_progress card
	 * without a worktree and without a queued reply. */
	| "state";

export function leadValidationStartRefusal(
	lead: Pick<
		Task,
		| "cancelledAt"
		| "followUpOf"
		| "stage"
		| "state"
		| "pendingPrompt"
		| "worktree"
		| "validatedAt"
		| "waitsValidation"
	> & {
		/** Store rows carry the prompt tag; wire rows ship no prompt and carry the
		 * `sandboxLead` stamp instead. */
		prompt?: string;
		sandboxLead?: true;
	},
	reviewId: string,
): LeadStartRefusal | null {
	if (lead.cancelledAt !== null) return "unknown";
	if (lead.followUpOf !== reviewId) return "mismatch";
	if (
		lead.sandboxLead !== true &&
		!pendingSandboxLead({
			prompt: lead.prompt ?? "",
			validatedAt: lead.validatedAt,
		})
	)
		return "not-lead";
	if (
		// Marked leads use their own Validate now route, never the legacy park.
		lead.waitsValidation ||
		!(
			(lead.stage === "todo" || lead.stage === "in_progress") &&
			lead.state === "queued"
		) ||
		lead.pendingPrompt !== null ||
		lead.worktree !== null
	)
		return "state";
	return null;
}

/** True for a review whose leads a batch validation run may take: a done review, or one
 * held at merging for its findings (OTTR-1128), so a release validates before it ships. */
export function validatableReview(
	t: Pick<Task, "kind" | "releaseVersion" | "cancelledAt" | "stage" | "state">,
): boolean {
	return (
		isReview(t) &&
		t.cancelledAt === null &&
		(t.stage === "done" || (t.stage === "merging" && t.state === "idle"))
	);
}

/** The per-lead outcome vocabulary a details `Validated by ` segment records
 * ("blocked" there reads as "still blocked"). */
export type LeadSegmentOutcome =
	| "confirmed"
	| "refuted"
	| "still blocked"
	| "deployment";

/** The newest recorded validation outcome in a lead's details, else null: the
 * settle and reset paths append one `Validated by ` segment per result, newest
 * last, so the last segment rules. The confirmed branch's segment carries the
 * evidence after the outcome word (`confirmed. <evidence>`), the others split
 * it off with an em dash — a prefix match reads both. Pure. */
export function leadValidationOutcome(
	details: string | null,
): LeadSegmentOutcome | null {
	if (details === null) return null;
	const start = details.lastIndexOf("\nValidated by ");
	if (start === -1) return null;
	const next = details.indexOf("\nValidated by ", start + 1);
	const segment = details.slice(start, next === -1 ? undefined : next);
	const at = segment.indexOf(": ");
	if (at === -1) return null;
	const outcome = segment.slice(at + 2).trim();
	return outcome.startsWith("still blocked")
		? "still blocked"
		: outcome.startsWith("confirmed")
			? "confirmed"
			: outcome.startsWith("deployment")
				? "deployment"
				: outcome.startsWith("refuted")
					? "refuted"
					: null;
}

/** The per-lead outcome vocabulary a validation run records in review_findings
 * (auditLeads.ts validationResult): "blocked" there, "still blocked" in the
 * details segment the settle also writes. */
export type LeadFindingOutcome =
	| "confirmed"
	| "refuted"
	| "blocked"
	| "deployment";

/** The fields one recorded result carries for its reader: the outcome, the
 * evidence lines after the prompt's first line, and the validation card
 * (run) that recorded it. */
export type LeadValidationOutcome = {
	outcome: LeadFindingOutcome;
	evidence: string;
	cardId: string;
};

/** One recorded result row a caller feeds to validationOutcomes: the result
 * prompt, its arrival order inside its run, and the run card's fields. */
export type ValidationOutcomeRow = {
	prompt: string;
	order: number;
	cardId: string;
	cardCreatedAt: number | null;
	cardKind: string;
	cardFollowUpOf: string | null;
};

/** The ONE outcome selector for a review's validation results — the settle,
 * resetValidatedLeads, the SQLite convergence and the PostgreSQL migration
 * step all read through it, so they can never disagree about a lead. Only
 * results of the lead's own review count (a foreign review's run never
 * decides the lead); runs sort newest first (created_at desc, then card id
 * desc); inside a run the first result for the lead rules (order asc) — the
 * same rule the settle has always applied, and the reset since OTTR-1129.
 * Returns the outcome per lead id. Pure. */
export function validationOutcomes(
	leadReviewId: string,
	rows: readonly ValidationOutcomeRow[],
): Map<string, LeadValidationOutcome> {
	const ordered = rows
		.filter(
			(row) =>
				row.cardKind === "validation" && row.cardFollowUpOf === leadReviewId,
		)
		.sort((a, b) => {
			const ca = a.cardCreatedAt ?? 0;
			const cb = b.cardCreatedAt ?? 0;
			if (ca !== cb) return ca > cb ? -1 : 1;
			if (a.cardId !== b.cardId) return a.cardId > b.cardId ? -1 : 1;
			return a.order - b.order;
		});
	const map = new Map<string, LeadValidationOutcome>();
	for (const row of ordered) {
		const parsed = validationResult(row.prompt);
		if (parsed === null || map.has(parsed.leadId)) continue;
		map.set(parsed.leadId, {
			outcome: parsed.outcome,
			evidence: parsed.evidence,
			cardId: row.cardId,
		});
	}
	return map;
}

/** Whether a legacy backlog lead row takes the waiting form on convergence
 * (OTTR-1252). The deciding outcome is the lead's newest review_findings
 * record — the ONE source every reader (settle, resetValidatedLeads, the
 * SQLite convergence and the PostgreSQL step, all through validationOutcomes)
 * reads, so no reader can drift: a confirmed result is normal work the
 * operator may park, a refuted lead stays cancelled, and the operator's
 * applies answer rides its own marker in the prompt (`The user answered the
 * review's question`, written by the reply route), while a never-validated
 * lead, a still-blocked result, or an unanswered deployment result waits.
 * Details segments decide too (falling back behind the finding record):
 * resetValidatedLeads reads them as well (OTTR-1252 send-back 7), so a
 * waiting details-blocked lead stays unlockable by Validate now. A
 * validatedAt with no readable outcome anywhere means the result was
 * recorded through a path that kept no record and the text later went —
 * the row stays decided, because re-locking it would strand work that
 * batching (validatedAt null) and the reset can never unlock; a
 * never-validated row waits: for a lead, starting unvalidated work is the
 * failure mode, and the validate flows can still decide it later. Pure. */
export function legacyLeadWaits(
	prompt: string,
	validatedAt: number | null,
	details: string | null,
	newestFindingOutcome: LeadFindingOutcome | null,
): boolean {
	if (!prompt.startsWith("Needs validation")) return false;
	if (prompt.includes("\nThe user answered the review's question"))
		return false;
	const outcome =
		newestFindingOutcome ?? leadValidationOutcome(details ?? null);
	if (outcome === "confirmed" || outcome === "refuted") return false;
	if (outcome !== null) return true;
	return validatedAt === null;
}

/** The needs_you reason for a diverging loop: the blocker counts per round, then the rule(s)
 * that fired — the did-not-drop claim only when the counts rule fired, plus each repeated
 * bug class with its blockers. Pure. */
export function workCheckDivergeReason(log: readonly WorkCheckRun[]): string {
	const counts = workCheckBlockerCounts(log);
	const repeated = repeatedBugClasses(log);
	const countsDiverged = workCheckCountsDiverged(log);
	let text = `${WORK_CHECK_ASK_DIVERGE} (blockers per check: ${counts.join(", ")})`;
	if (countsDiverged)
		text += ": the blocker count did not drop over the last send-backs";
	if (repeated.length > 0) {
		const runs = log.filter((r) => r.outcome === "blockers");
		const last = runs.at(-1);
		const list = repeated
			.map((cls) => {
				const bs = (last?.blockers ?? []).filter((b) => b.bugClass === cls);
				return `bug class "${cls}": ${bs
					.map((b, i) => `${i + 1}. ${b.finding}`)
					.join(" ")}`;
			})
			.join("; ");
		text += countsDiverged
			? `. It also re-raises the ${list}`
			: `: it re-raises the ${list}`;
	}
	return `${text}. Reply with a new direction to send the card back with it, or click Merge anyway or Cancel.`;
}

/** The clickable question a diverging loop puts on the card. A reply with other text is the
 * user's new direction and sends the card back with it (app.ts). */
export function workCheckDivergeAsk(
	log: readonly WorkCheckRun[],
): AskQuestion[] {
	const repeated = repeatedBugClasses(log);
	return [
		{
			question: `${WORK_CHECK_ASK_DIVERGE} (blockers per check: ${workCheckBlockerCounts(log).join(", ")}${repeated.length > 0 ? `; repeated class${repeated.length > 1 ? "es" : ""}: ${repeated.map((c) => `"${c}"`).join(", ")}` : ""}). Reply with your new direction to send the card back with it, or choose below. How do you want to continue?`,
			options: [
				{
					label: WORK_CHECK_ASK_NEW_APPROACH,
					description:
						"Send the blockers back once more; the send-back asks the agent to rethink the approach instead of fixing one more instance, and names the repeated class when there is one.",
				},
				{
					label: WORK_CHECK_ASK_MERGE,
					description:
						"Override the open blockers and queue the merge, for example when a blocker only asks for a human review.",
				},
				{
					label: WORK_CHECK_ASK_CANCEL,
					description: "Cancel the card; no further work runs.",
				},
			],
			multi: false,
			recommended: 0,
			text: false,
		},
	];
}

/** The log with every open blocker marked overridden with `reason` (Merge anyway). Copies only:
 * the store's change detection needs a new log. Pure. */
export function overrideWorkBlockers(
	log: readonly WorkCheckRun[],
	reason: string,
): WorkCheckRun[] {
	return log.map((run) =>
		run.blockers.some((b) => b.status === undefined)
			? {
					...run,
					blockers: run.blockers.map((b) =>
						b.status === undefined
							? { ...b, status: "overridden" as const, statusReason: reason }
							: b,
					),
				}
			: run,
	);
}

/** Merge anyway: the user's override of the open work-check blockers, with `reason` on each,
 * then the merge queue. Shared by the Merge anyway button and the work-check ask. */
export function mergeAnywayPatch(
	task: Pick<Task, "workCheckLog">,
	reason: string,
) {
	return {
		workCheckLog: overrideWorkBlockers(task.workCheckLog, reason),
		stage: "merging" as const,
		state: "queued" as const,
		queuedAt: Date.now(),
		pendingPrompt: null,
		pendingBy: null,
		// OTTR-877: the prompt goes with its flag — a feedback park's appended blocks are
		// void once the user merges anyway.
		pendingFeedback: false,
		needsReason: null,
		asked: null,
	};
}

/** Splits a check verdict's blockers from its notes. A blocker must quote a verbatim part of
 * the diff, of the ready report, or of the work transcript (the card's decision 6); an empty
 * quote, or one that matches nothing in any of them, demotes to a note instead of blocking.
 * A severity of nit or pre-existing demotes too: only important findings (the default when
 * untagged) block. Pure. */
export function demoteUnquoted(
	verdict: WorkCheckVerdict,
	diffText: string,
	reportText: string,
	transcriptText: string,
): WorkCheckSplit {
	const blockers: WorkCheckBlocker[] = [];
	const demoted: string[] = [];
	for (const b of verdict.blockers) {
		const quote = b.quote.trim();
		const inDiff = diffText !== "" && diffText.includes(quote);
		const inReport = reportText !== "" && reportText.includes(quote);
		const inTranscript =
			transcriptText !== "" && transcriptText.includes(quote);
		if (quote === "" || (!inDiff && !inReport && !inTranscript)) {
			demoted.push(
				quote === ""
					? `${b.finding} (no quote — not blocking)`
					: `${b.finding} (quote matched nothing in the diff, the report, or the transcript — not blocking)`,
			);
			continue;
		}
		if (b.severity === "nit" || b.severity === "pre-existing") {
			demoted.push(`${b.finding} (${b.severity} — recorded, not blocking)`);
			continue;
		}
		blockers.push({
			finding: b.finding,
			quote,
			severity: b.severity,
			bugClass: b.bugClass,
		});
	}
	return { blockers, notes: [...demoted, ...verdict.notes] };
}
