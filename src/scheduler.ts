import { statSync } from "node:fs";
import { splitLevel } from "./levels.ts";
import { WORK_CHECK_MAX_SENDBACKS } from "./prompts.ts";
import type {
	ArchReview,
	AskQuestion,
	ListedTask,
	RecordedFinding,
	Task,
	TaskKind,
	WorkCheckBlocker,
	WorkCheckRun,
} from "./types.ts";

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
	| "dependsOn"
	| "followUpOf"
>;

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

/** True while a finding of `review` is not done; a cancelled finding counts as done. */
function findingsOpen(
	tasks: readonly ReviewTask[],
	review: Pick<Task, "id" | "doneAt">,
): boolean {
	return reviewFindings(tasks, review).some(
		(f) => f.cancelledAt === null && f.stage !== "done",
	);
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

/** The hold `merge` waits under while the open review `r` gates the target, else null when
 * `merge` is exempt (it is `r` itself, or one of `r`'s findings — those never wait). */
function reviewHoldFor(
	tasks: readonly ReviewTask[],
	r: ReviewTask,
	mergeId: string,
): string | null {
	const findings = reviewFindings(tasks, r);
	if (findings.some((f) => f.id === mergeId)) return null;
	if (r.releaseVersion !== null && r.stage !== "done")
		return `waiting for release ${r.releaseVersion}`;
	if (r.stage === "todo" || r.stage === "in_progress")
		return "waiting for the review to finish";
	// Parked at merging until its findings are done (findingsHold); a done review only reaches
	// this with open findings when it finished before reviews parked.
	if (
		r.stage === "merging" ||
		findings.some((f) => f.cancelledAt === null && f.stage !== "done")
	)
		return "waiting for the review's findings to be implemented";
	return null;
}

/** Why the tracker holds a queued merge, else null. While a review runs, and until its findings are
 * done, only its findings merge; every other card waits in merging. So the next review counts from
 * exactly the commit this one saw, and a release ships only reviewed work plus the fixes it asked
 * for. Findings themselves never wait: holding one could deadlock the review that waits for it.
 * While local main has commits origin lacks (a rejected server push, `o.mainUnpushed`), every
 * queued merge but the rejected card's rebase retry waits too (pushHold). With `o.prMode`, main
 * is never written locally, so that hold is inert. */
export function mergeHold(
	tasks: readonly ReviewTask[],
	merge: Pick<Task, "id" | "stage" | "state" | "pushRetries" | "pendingBy">,
	o: { mainUnpushed?: boolean; prMode?: boolean } = {},
): string | null {
	for (const r of tasks) {
		if (r.id === merge.id || r.cancelledAt !== null || !isReview(r)) continue;
		const held = reviewHoldFor(tasks, r, merge.id);
		if (held !== null) return held;
	}
	if (o.mainUnpushed === true && o.prMode !== true) {
		const held = pushHold(true, merge);
		if (held !== null) return held;
	}
	return null;
}

/** Why an approved review card waits in merging instead of done, else null: a review is done
 * only once the findings it filed are done, and a release publishes only then. */
export const FINDINGS_HOLD =
	"waiting for the review's findings to be implemented";

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

/** Why a new review (Review button or Create release) cannot start, else null. One review at a
 * time, and a review stays open until its findings are done: two open reviews would hold each
 * other's findings and deadlock. */
export function reviewBlocked(tasks: readonly ReviewTask[]): string | null {
	for (const r of tasks) {
		if (r.cancelledAt !== null || !isReview(r)) continue;
		if (r.releaseVersion !== null && r.stage !== "done")
			return "A release is already in progress.";
		if (r.stage === "todo" || r.stage === "in_progress")
			return "A review is already in progress.";
		if (r.stage === "merging" || findingsOpen(tasks, r))
			return "The last review's findings are not done yet.";
	}
	return null;
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
	running: boolean,
): ArchReview {
	return {
		delta: a.delta,
		reviewed: a.reviewed,
		base: a.anchor === "" ? null : a.anchor,
		reviewCardId: last !== null && last.base === a.anchor ? last.id : null,
		cap,
		due: archReviewDue(a.delta, cap, a.reviewed),
		running,
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
	const prefix = m[1]!;
	const hits = [...projects].filter((p) => p.prefix === prefix);
	if (hits.length === 0) return { why: "project", id, prefix };
	if (hits.length > 1)
		return { why: "ambiguous", id, prefix, projects: hits.map((p) => p.name) };
	const foreign = hits[0]!;
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
export function depProjectOf(store: {
	name: string;
	taskPrefix(): string;
	getTask(id: string): DepCard | null;
}): DepProject {
	return {
		name: store.name,
		prefix: store.taskPrefix(),
		getTask: (id) => store.getTask(id),
	};
}

/** The resolver's view of the board's projects; entries only need a store. */
export function depProjectsOf(
	projects: Iterable<{
		store: {
			name: string;
			taskPrefix(): string;
			getTask(id: string): DepCard | null;
		};
	}>,
): DepProject[] {
	return [...projects].map((e) => depProjectOf(e.store));
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
	/** True while the project merges via PR: a card with an open PR is never picked for
	 * another merge turn, and mainUnpushed's hold is inert (mergeHold). */
	prMode?: boolean;
	/** OTTR-708: looks a dependsOn id up across every project's store (findDep); null
	 * counts the dependency as satisfied, like one missing from the own list. */
	crossDeps?: DepIndex;
}

/** The oldest queued merge that no open review holds and whose dependencies are done; null
 * when a merge turn already runs or nothing qualifies. */
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
				t.prNumber === null &&
				mergeHold(live, t, {
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

/** Model-id tokens that name a vendor, matched after the provider prefix is stripped: Claude
 *  via github-copilot, Bedrock, Vertex, OpenRouter or a gateway is still an Anthropic model.
 *  omp's model catalog cannot say: its entries carry `provider` — the prefix itself, exactly
 *  the signal that misleads — and no vendor field (checked against `omp models --json`). */
const VENDOR_TOKENS: Record<string, string> = {
	anthropic: "anthropic",
	claude: "anthropic",
	openai: "openai",
	gpt: "openai",
	codex: "openai",
	google: "google",
	gemini: "google",
	zai: "zai",
	zhipu: "zai",
	glm: "zai",
	xai: "xai",
	grok: "xai",
	deepseek: "deepseek",
	moonshot: "moonshot",
	kimi: "moonshot",
	meta: "meta",
	llama: "meta",
	mistral: "mistral",
	mixtral: "mistral",
	ministral: "mistral",
	codestral: "mistral",
	magistral: "mistral",
	pixtral: "mistral",
	devstral: "mistral",
	qwen: "qwen",
	alibaba: "qwen",
	tongyi: "qwen",
	cohere: "cohere",
	command: "cohere",
	amazon: "amazon",
	nova: "amazon",
	titan: "amazon",
};
/** OpenAI's o-series ids ("o4-mini"): the family prefix is the bare letter and a number. */
const O_SERIES = /^o\d+$/;

/** The vendor a model selector names, read from the model id after the provider prefix; the
 *  id may carry its own vendor path (OpenRouter's "openrouter/anthropic/claude-x") or dotted
 *  qualifiers (Bedrock's "bedrock/us.anthropic.claude-x"), so every separator-separated token
 *  is tried in order and the first known one decides. Null when no known token shows up.
 *  The `:level` thinking suffix is ignored. Pure. */
export function modelVendor(selector: string): string | null {
	const [base] = splitLevel(selector);
	const slash = base.indexOf("/");
	const id = slash === -1 ? base : base.slice(slash + 1);
	for (const token of id.toLowerCase().split(/[./_-]+/)) {
		if (O_SERIES.test(token)) return "openai";
		// hasOwn, not a bare member read: an id may hold any token, and "constructor"
		// must stay an unknown vendor, not Object.prototype's.
		if (Object.hasOwn(VENDOR_TOKENS, token))
			return VENDOR_TOKENS[token] as string;
	}
	return null;
}

/** The check run's model role: a review that ran on an Anthropic model gets a second vendor's
 *  opinion. The vendor comes from the model id, not the provider prefix (modelVendor), so
 *  Claude through another provider still gets the critic role; unknown and other vendors get
 *  the adversary role. */
export function checkRoleFor(
	reviewModel: string | null,
): "critic" | "adversary" {
	return modelVendor(reviewModel ?? "") === "anthropic"
		? "critic"
		: "adversary";
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
 * and the earlier blockers it confirms fixed (by the id the check prompt assigned). */
export interface WorkCheckVerdict {
	blockers: {
		finding: string;
		quote: string;
		severity?: WorkCheckBlocker["severity"];
		bugClass?: string;
	}[];
	notes: string[];
	fixed: { id: number; reason: string }[];
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
	return { blockers, notes, fixed };
}

/** The blockers a card still owes a fix: those of the last blockers run without a status. Every
 * older run's blockers carry a status by then (turn.ts marks uncited ones fixed when the next
 * check completes), so this never double-counts one problem. Pure. */
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
): { blockers: WorkCheckBlocker[]; notes: string[] } {
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
