import { statSync } from "node:fs";
import type {
	ArchReview,
	AskQuestion,
	RecordedFinding,
	Task,
	TaskKind,
	WorkCheckBlocker,
	WorkCheckRun,
} from "./types.ts";

/** A live turn whose card log has not grown for this long may wait on a hung command (ALAT-23
 * sat 25 h on a hung Stryker run with its omp process alive). The card warns; the board never kills. */
export const SILENT_LOG_MS = 2 * 60 * 60_000;

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

/** True when a non-cancelled task of `kind` has not reached done: the one-live-card-per-kind
 * guard (rules interview, retro). kind is a trusted, server-set field, so this is the single place
 * that derives "a card of this kind is live" (R1-14). Reviews use reviewBlocked instead. */
export function liveCard(
	tasks: readonly Pick<Task, "kind" | "cancelledAt" | "stage">[],
	kind: TaskKind,
): boolean {
	return tasks.some(
		(t) => t.kind === kind && t.cancelledAt === null && t.stage !== "done",
	);
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
	const kids = new Map<string, T[]>();
	for (const t of tasks) {
		if (t.followUpOf === null || t.createdAt > end) continue;
		const list = kids.get(t.followUpOf);
		if (list === undefined) kids.set(t.followUpOf, [t]);
		else list.push(t);
	}
	const seen = new Set([review.id]);
	const found: T[] = [];
	const add = (t: T | undefined): void => {
		// A retro card is terminal (R7): it and its follow-ups never become review findings.
		if (t === undefined || seen.has(t.id) || isRetro(t)) return;
		seen.add(t.id);
		found.push(t);
	};
	for (const k of kids.get(review.id) ?? []) add(k);
	// Both loops visit the cards they append: the follow-up chain first, then the dependency closure.
	for (const f of found) for (const k of kids.get(f.id) ?? []) add(k);
	for (const f of found) for (const d of f.dependsOn) add(byId.get(d));
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

/** Why the tracker holds a queued merge, else null. While a review runs, and until its findings are
 * done, only its findings merge; every other card waits in merging. So the next review counts from
 * exactly the commit this one saw, and a release ships only reviewed work plus the fixes it asked
 * for. Findings themselves never wait: holding one could deadlock the review that waits for it. */
export function mergeHold(
	tasks: readonly ReviewTask[],
	merge: Pick<Task, "id">,
): string | null {
	for (const r of tasks) {
		if (r.id === merge.id || r.cancelledAt !== null || !isReview(r)) continue;
		const findings = reviewFindings(tasks, r);
		if (findings.some((f) => f.id === merge.id)) continue;
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
export function releaseHeldMerges<T extends ReviewTask & Pick<Task, "state">>(
	tasks: readonly T[],
	review: ReviewTask & Pick<Task, "state">,
): T[] {
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

/** The unfinished dependency cards `t` waits for, in its dependsOn order. A cancelled dependency
 * counts as satisfied: cancelling M1 must not strand M2 in the queue forever. `tasks` must be the
 * whole project: a dependency missing from it counts as done. */
export function waitingOn<T extends Pick<Task, "id" | "stage" | "cancelledAt">>(
	tasks: readonly T[],
	t: Pick<Task, "dependsOn">,
): T[] {
	if (t.dependsOn.length === 0) return [];
	const byId = new Map(tasks.map((d) => [d.id, d]));
	return t.dependsOn.flatMap((id) => {
		const d = byId.get(id);
		return d !== undefined && d.cancelledAt === null && d.stage !== "done"
			? [d]
			: [];
	});
}

/** Why the queued card may not start yet — unfinished dependencies — else null. */
export function depHold(
	tasks: readonly Pick<Task, "id" | "title" | "stage" | "cancelledAt">[],
	t: Pick<Task, "dependsOn">,
): string | null {
	const waiting = waitingOn(tasks, t);
	return waiting.length === 0
		? null
		: `waiting for ${waiting.map((d) => `#${d.id} ${d.title}`).join(", ")}`;
}

/** Pick the tasks that may start an omp run right now. Pure; `tasks` is one project's tasks. */
export function pickRunnable(
	tasks: Task[],
	o: {
		/** Null = no cap: as many runs as queued cards need. */
		maxParallel: number | null;
		hasRules: boolean;
		/** Set during an update's hold: only this queued card may start, and null lets none start.
		 * The other cards still take their slots and hold their dependents. */
		only?: string | null;
		/** A queued card waits until its holdUntil, e.g. a check held until a usage limit resets. */
		now?: number;
	},
): Task[] {
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

	const picked: Task[] = [];

	// The merge slot: only if no merge turn is already running, take the oldest queued merge that no
	// open review holds. An open release holds every merge but its findings', so no merge can race
	// its publish (mergeHold).
	if (!running.some((t) => t.stage === "merging")) {
		const merge = queued.find(
			(t) =>
				t.stage === "merging" &&
				mergeHold(live, t) === null &&
				depHold(live, t) === null,
		);
		if (merge) {
			picked.push(merge);
			free -= 1;
		}
	}

	// The grill slot: a backlog card runs only when the user kicks it (state queued), and at
	// most one grill runs at a time — every grill asks questions, so two at once just double
	// the bells. A drain (`only` set) has already narrowed `queued` to that one card.
	const grilling = live.some(
		(t) =>
			t.stage === "backlog" &&
			(t.state === "running" || t.state === "preparing"),
	);
	if (!grilling && free > 0) {
		const grill = queued.find((t) => t.stage === "backlog");
		if (grill) {
			picked.push(grill);
			free -= 1;
		}
	}

	for (const t of queued) {
		if (picked.includes(t)) continue;
		if (free <= 0) break;
		// Work slots only: todo and in_progress (replies). Needs a rules file before a fresh todo starts.
		if (t.stage === "todo" && !o.hasRules && t.kind !== "interview") continue;
		// A queued card waits until every dependency is done (a cancelled dependency counts as
		// done, waitingOn); merging cards wait in the merge slot above.
		if (
			(t.stage === "todo" || t.stage === "in_progress") &&
			depHold(live, t) !== null
		)
			continue;
		if (t.stage !== "todo" && t.stage !== "in_progress") continue;
		picked.push(t);
		free -= 1;
	}
	return picked;
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

/** The check run's model role: a review that ran on Anthropic gets a second vendor's opinion. */
export function checkRoleFor(
	reviewModel: string | null,
): "critic" | "adversary" {
	return reviewModel !== null && reviewModel.startsWith("anthropic/")
		? "critic"
		: "adversary";
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
		if (v !== undefined && v.keep) kept.push({ id, finding });
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
	const blockers: WorkCheckVerdict["blockers"] = [];
	if (r.blockers !== undefined) {
		if (!Array.isArray(r.blockers)) return null;
		for (const b of r.blockers) {
			if (typeof b !== "object" || b === null) continue;
			const e = b as Record<string, unknown>;
			if (typeof e.finding !== "string" || typeof e.quote !== "string")
				continue;
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
	}
	const notes: string[] = [];
	if (r.notes !== undefined) {
		if (!Array.isArray(r.notes)) return null;
		for (const n of r.notes)
			if (typeof n === "string" && n.trim() !== "") notes.push(n);
	}
	const fixed: { id: number; reason: string }[] = [];
	if (r.fixed !== undefined) {
		if (!Array.isArray(r.fixed)) return null;
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
	}
	return { blockers, notes, fixed };
}

/** The blockers a card still owes a fix: those of the last blockers run without a status. Every
 * older run's blockers carry a status by then (turn.ts marks uncited ones fixed when the next
 * check completes), so this never double-counts one problem. Pure. */
export function openWorkBlockers(
	log: readonly WorkCheckRun[],
): WorkCheckBlocker[] {
	for (let i = log.length - 1; i >= 0; i--) {
		const run = log[i]!;
		if (run.outcome !== "blockers") continue;
		return run.blockers.filter((b) => b.status === undefined);
	}
	return [];
}

/** Opening of the needs_you reason a third work-check block sets; the reply route reads the
 * ask answers below only on a card parked with it. */
export const WORK_CHECK_THIRD_BLOCK =
	"The work check blocked the merge a third time";
export const WORK_CHECK_ASK_SEND_BACK = "Send it back";
export const WORK_CHECK_ASK_MERGE = "Merge anyway";

/** The clickable question a third work-check block puts on the card. The reply route turns a
 * click into the send-back or the merge; any other text is a plain reply to the agent. */
export function workCheckAsk(
	blockers: readonly WorkCheckBlocker[],
): AskQuestion[] {
	return [
		{
			question: `${WORK_CHECK_THIRD_BLOCK}: ${blockers.map((b, i) => `${i + 1}. ${b.finding}`).join(" ")}. How do you want to continue?`,
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
 * then the merge queue. Shared by the Merge anyway button and the third block's ask. */
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
 * the diff or of the work transcript (the card's decision 6); an empty quote, or one that
 * matches nothing in either, demotes to a note instead of blocking. A severity of nit or
 * pre-existing demotes too: only important findings (the default when untagged) block. Pure. */
export function demoteUnquoted(
	verdict: WorkCheckVerdict,
	diffText: string,
	transcriptText: string,
): { blockers: WorkCheckBlocker[]; notes: string[] } {
	const blockers: WorkCheckBlocker[] = [];
	const demoted: string[] = [];
	for (const b of verdict.blockers) {
		const quote = b.quote.trim();
		const inDiff = diffText !== "" && diffText.includes(quote);
		const inTranscript =
			transcriptText !== "" && transcriptText.includes(quote);
		if (quote === "" || (!inDiff && !inTranscript)) {
			demoted.push(
				quote === ""
					? `${b.finding} (no quote — not blocking)`
					: `${b.finding} (quote matched nothing in the diff or the transcript — not blocking)`,
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
