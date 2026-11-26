import { isProposalReason } from "../prompts.ts";
import {
	type DepCard,
	type DepIndex,
	depHold,
	isReview,
	leadValidationHold,
	mergeHold,
	PUSH_HOLD,
	queueOrder,
	type ReviewTask,
	reviewFindings,
	waitingOn,
} from "../scheduler.ts";
import type { ProjectView, Task, TaskCard } from "../types.ts";
import { duration, until } from "./time.ts";

/** "about X left" for a live turn against its project/kind/model median turn length, in the
 * mutation-run style. null once the median is used up (elapsed time alone from there) — and
 * the card renders no estimate at all without etaMs (thin history; perf.ts ETA_MIN_HISTORY). */
export function etaLeft(
	etaMs: number,
	startedAt: number,
	now: number = Date.now(),
): string | null {
	const left = etaMs - Math.max(0, now - startedAt);
	if (left <= 0) return null;
	return `about ${duration(left)} left`;
}

/** Split a live Stryker or Python mutate.py progress line into its parts; format produced by src/stryker.ts.
 * Returns null for text with no numbers (including "mutate.py running"). `rest` is the tail after `n/total`. */
export function strykerProgress(text: string | null | undefined): {
	tool: string;
	pct: number;
	tested: number;
	total: number;
	rest: string;
} | null {
	const m = /^(\S+) (\d+)% · (\d+)\/(\d+)(?: · (.+))?$/.exec(
		(text ?? "").trim(),
	);
	if (m === null || m[1] === undefined) return null;
	return {
		tool: m[1],
		pct: Number(m[2]),
		tested: Number(m[3]),
		total: Number(m[4]),
		rest: m[5] ?? "",
	};
}

/** The stats tail of a Stryker progress line as readout rows for the drawer's mutation
 * section: "38 survived (0.9%) · ~2h 59m elapsed · ~1h 23m left" becomes label/value
 * pairs. A part the format does not name yet keeps its raw text, unlabelled. */
export function strykerStats(rest: string): Array<{
	label: string;
	value: string;
}> {
	if (rest === "") return [];
	return rest.split(" · ").map((part) => {
		if (part.endsWith(" elapsed"))
			return { label: "Elapsed", value: part.slice(0, -" elapsed".length) };
		if (part.endsWith(" left"))
			return { label: "Left", value: part.slice(0, -" left".length) };
		const survived = /^(\d+) survived \(([\d.]+%)\)$/.exec(part);
		if (survived !== null)
			return { label: "Survived", value: `${survived[1]} (${survived[2]})` };
		const timedOut = /^(\d+) timed out$/.exec(part);
		if (timedOut !== null && timedOut[1] !== undefined)
			return { label: "Timed out", value: timedOut[1] };
		return { label: "", value: part };
	});
}

/** "k of N findings done" while a review or release card runs: counts how many of the
 * review's findings (reviewFindings) have already landed (done) or been cancelled. null
 * when t is not a running review or no finding is filed yet — the plain "running" stays. */
export function reviewProgress(
	tasks: readonly (ReviewTask & Pick<Task, "title">)[],
	t: Pick<Task, "id" | "kind" | "releaseVersion" | "doneAt" | "state">,
): string | null {
	if (t.state !== "running" || !isReview(t)) return null;
	const findings = reviewFindings(tasks, t);
	const n = findings.length;
	if (n === 0) return null;
	const done = findings.filter(
		(f) => f.stage === "done" || f.cancelledAt !== null,
	).length;
	return `${done} of ${n} findings done`;
}

/** "#2 in queue" for a queued card: its position in queueOrder, the order the tracker and
 * the column render. null when t is not queued or not in the list — the plain words stay. */
export function queuePosition(
	tasks: readonly (ReviewTask & Pick<Task, "title" | "state" | "queuedAt">)[],
	t: Pick<Task, "id" | "state" | "cancelledAt">,
): string | null {
	if (t.state !== "queued" || t.cancelledAt !== null) return null;
	const n = queueOrder(tasks).findIndex((q) => q.id === t.id) + 1;
	return n > 0 ? `#${n} in queue` : null;
}

/** "held · 12m left" for a card the tracker parked until a future holdUntil (a usage
 * limit): the countdown replaces the raw reset stamp the reason names. The board writes
 * the reason itself ("The <provider> usage limit is reached. ..."), so a match names the
 * holder: "held · zai limit · 12m left". The last minute reads "<1m", since until()
 * floors and would say "now" while the hold still stands. null once past. */
export function holdLeft(
	holdUntil: number,
	now: number = Date.now(),
	/** The card's needsReason, when the caller has it: a usage-limit sentence names the provider. */
	reason: string | null = null,
): string | null {
	const left = holdUntil - now;
	if (left <= 0) return null;
	const time = left < 60_000 ? "<1m" : until(holdUntil, now);
	const named =
		reason === null ? null : /^The (\S+) usage limit is reached/.exec(reason);
	const holder = named?.[1];
	return `held · ${holder === undefined ? "" : `${holder} limit · `}${time} left`;
}

/** The project cards the queued dependency line reads: a lane list carries the wire
 * card, so the fields a dependency's own hold needs ride along when the caller passes
 * full cards; a list without them keeps the plain dependency wording. */
export type StatusTasks = ReviewTask &
	Pick<
		Task,
		| "title"
		| "state"
		| "queuedAt"
		| "needsReason"
		| "holdUntil"
		| "pushRetries"
		| "pendingBy"
		| "validatedAt"
	> &
	Partial<Pick<TaskCard, "pushHold" | "vmHold" | "sandboxLead">>;

/** The project context a dependency's own hold reads (OTTR-1321 send-back 2): the
 * dependency project's own cards — its merge gate scans its own open reviews, never
 * the follower project's — and its project's resolver, whose `own` is that project,
 * so nested dependsOn ids resolve relative to it. A foreign dependency without a
 * context keeps the plain wording. */
export type DepHoldContext = {
	cards: readonly StatusTasks[];
	index?: DepIndex;
};

/** A dependency card the status line may name: the board's cross-project index hands
 * back the full wire card (depIndexOf keeps every project's TaskCard), so the hold
 * fields may ride along; a narrower index (the scheduler's store lookups) omits them
 * and the segment keeps the plain wording. */
type IndexedDep = DepCard & Partial<TaskCard>;

/** The dependency's own hold, in the order its own card shows it: a live usage-limit
 * countdown first, then holdFor over the dependency's own project context (merge gate,
 * push hold, its own dependencies). The bridge fills only the fields a narrow index
 * card lacks, and every fallback is inert (no retries, no pending merge, no validation
 * wait), so a full wire card reads exactly as its own card would. null with no hold. */
function depOwnHold(
	dep: IndexedDep,
	ctx: DepHoldContext,
	now: number,
): string | null {
	// A dependency names a hold only while it sits queued: a running turn is
	// active — a review can start after its merge starts — and every other
	// state shows its own words, never a hold (OTTR-1321 send-back 2).
	if (dep.state !== undefined && dep.state !== "queued") return null;
	if (dep.holdUntil != null && dep.holdUntil > now) {
		return (
			holdLeft(dep.holdUntil, now, dep.needsReason ?? null) ??
			dep.needsReason ??
			null
		);
	}
	return holdFor(
		{
			id: dep.id,
			stage: dep.stage,
			state: dep.state ?? "queued",
			dependsOn: dep.dependsOn ?? [],
			pushRetries: dep.pushRetries ?? 0,
			pendingBy: dep.pendingBy ?? null,
			validatedAt: dep.validatedAt ?? null,
			followUpOf: dep.followUpOf ?? null,
			cancelledAt: dep.cancelledAt ?? null,
			pushHold: dep.pushHold,
			vmHold: dep.vmHold,
			sandboxLead: dep.sandboxLead,
		},
		ctx.cards,
		ctx.index,
		now,
	);
}

/** The queued card's dependency line (OTTR-1321): "waiting for #<id> <title>" per open
 * dependency, cross-project ids through foreign — an open dependency blocks the
 * dispatch at every stage, so the line outranks the resume words. Each open dependency
 * whose own hold its project's context carries names that hold the way its own card
 * would: "waiting for #d1 schema (held · zai limit · 12m left), #d2 notes". A foreign
 * dependency resolves its hold only through foreignHolds (its project's cards and
 * resolver); without one it keeps the plain wording. null with none open. */
function depHoldLine(
	t: Pick<Task, "dependsOn">,
	tasks: readonly StatusTasks[] | undefined,
	foreign?: DepIndex,
	foreignHolds?: (id: string) => DepHoldContext | null,
	now: number = Date.now(),
): string | null {
	const list = tasks ?? [];
	const waiting = waitingOn(list, t, foreign);
	if (waiting.length === 0) return null;
	const segments = waiting.map((d) => {
		const base = `#${d.id} ${d.title}`;
		const local = list.find((c) => c.id === d.id);
		// The board's own list and its foreign index both hand back full wire
		// cards, so the dep's hold facts may ride on either; a narrower lookup
		// omits them.
		const dep: IndexedDep | undefined = local ?? foreign?.(d.id) ?? undefined;
		if (dep === undefined) return base;
		// A local dependency shares the follower's context; a foreign one reads
		// its own project's, so its merge gate and nested ids stay in its project.
		const ctx: DepHoldContext | null = local
			? { cards: list, index: foreign }
			: (foreignHolds?.(d.id) ?? null);
		if (ctx === null) return base;
		const own = depOwnHold(dep, ctx, now);
		return own === null ? base : `${base} (${own})`;
	});
	return `waiting for ${segments.join(", ")}`;
}

/** The statusLine words for a queued card: a pending sandbox lead waits for its review's
 *  validation run — no work turn can ever take it, so that hold outranks a queued reply
 *  and the tracker's reason — a re-queued card counts a future hold down, names its open
 *  dependencies (OTTR-1321), or shows the resume words with the reason on record, a
 *  pending reply waits for a slot (for the restart while draining), and the rest wait
 *  for rules, their merge hold, or a free slot. */
function queuedLine(
	t: Pick<
		TaskCard,
		| "cancelledAt"
		| "state"
		| "stage"
		| "needsReason"
		| "pendingPrompt"
		| "holdUntil"
		| "id"
		| "validatedAt"
		| "followUpOf"
		| "dependsOn"
	> & {
		/** The wire stamp (taskView); store rows read the prompt tag instead. */
		sandboxLead?: true;
	},
	hasRules: boolean,
	hold: string | null | undefined,
	drain: boolean,
	tasks: readonly StatusTasks[] | undefined,
	foreign: DepIndex | undefined,
	/** The dependency project's context per foreign id; absent keeps the plain wording. */
	foreignHolds?: (id: string) => DepHoldContext | null,
): string {
	if (t.stage === "backlog") return "grill queued";
	const leadHold = leadValidationHold(t);
	if (leadHold !== null) return leadHold;
	// A future holdUntil holds the card (a usage limit): count down instead of
	// the raw reset stamp the reason carries.
	if (
		t.needsReason !== null &&
		t.holdUntil !== null &&
		t.holdUntil > Date.now()
	)
		return holdLeft(t.holdUntil, Date.now(), t.needsReason) ?? t.needsReason;
	// An open dependency keeps the card parked even with a free slot, so its line
	// names the real blocker before the resume words (OTTR-1321).
	const dep = depHoldLine(t, tasks, foreign, foreignHolds);
	if (dep !== null) return dep;
	// No open dependency and no future hold: the card resumes, the reason on record.
	if (t.needsReason !== null) return "resuming";
	if (t.pendingPrompt !== null)
		return drain
			? "reply queued · waits for the update restart"
			: "reply queued · waits for a free slot";
	if (t.stage === "todo" && !hasRules) return "waiting for rules";
	if (
		(t.stage === "merging" ||
			t.stage === "todo" ||
			t.stage === "in_progress") &&
		hold
	)
		return hold;
	return drain
		? "waiting for the update restart"
		: (queuePosition(tasks ?? [], t) ?? "queued");
}

/** The statusLine words for an idle card: the backlog, the merge wait (never "done" —
 *  fix list #35), or the tracker's reason. */
function idleLine(
	t: Pick<TaskCard, "stage" | "needsReason" | "prNumber" | "pushSha">,
): string {
	if (t.stage === "backlog") return "in backlog";
	// PR mode parks the card here while its pull request waits for review and merge
	// (fix list #35): never "done". pushSha is the CI watch's pin on the PR head, so a
	// set sha names the pending CI verdict; a cleared one leaves the plain merge wait.
	if (t.stage === "merging" && t.prNumber !== null) {
		if (t.needsReason !== null) return t.needsReason;
		return t.pushSha !== null
			? `PR #${t.prNumber} open · waiting for CI`
			: `PR #${t.prNumber} open · waiting for merge`;
	}
	return t.needsReason ?? "done";
}

export function statusLine(
	t: Pick<
		TaskCard,
		| "cancelledAt"
		| "state"
		| "stage"
		| "needsReason"
		| "pendingPrompt"
		| "asked"
		| "progress"
		| "holdUntil"
		| "kind"
		| "releaseVersion"
		| "doneAt"
		| "id"
		| "prNumber"
		| "pushSha"
		| "validatedAt"
		| "followUpOf"
		| "dependsOn"
	> & {
		/** The wire stamp (taskView); store rows read the prompt tag instead. */
		sandboxLead?: true;
	},
	hasRules: boolean,
	hold?: string | null,
	/** True while an update holds new turns (POST /api/drain): every queued card waits for the restart. */
	drain = false,
	/** The project's cards, when the caller has them: counts a running review's findings
	 * (reviewProgress), a queued card's position (queuePosition), and a queued card's
	 * dependency line (OTTR-1321). */
	tasks?: readonly StatusTasks[],
	/** OTTR-708's cross-project dependency lookup, when the caller has it: an open
	 * foreign dependency keeps the dep line instead of the resume words. */
	foreign?: DepIndex,
	/** OTTR-1321: the dependency project's context per foreign id — its own cards and
	 * resolver — so a foreign dependency's hold reads its own project. Absent keeps
	 * the plain wording for foreign dependencies. */
	foreignHolds?: (id: string) => DepHoldContext | null,
): string {
	// A cancelled card is final; the card's "Cancelled" chip carries the time.
	if (t.cancelledAt !== null) return "cancelled";
	// A queued card that keeps a reason was queued again by the tracker (restart, background-job exit).
	if (t.state === "queued")
		return queuedLine(t, hasRules, hold, drain, tasks, foreign, foreignHolds);
	if (t.state === "preparing") return "preparing";
	if (t.state === "running")
		return t.progress ?? reviewProgress(tasks ?? [], t) ?? "running";
	if (t.state === "needs_you")
		return t.asked !== null ? "question asked" : "action required";
	// A review card parked while its findings land: the reason is the status.
	if (t.state === "idle") return idleLine(t);
	return "done";
}

/** The card's state mark. A card idle short of done (a review parked while its findings land)
 * waits like a queued one: only a done card earns the check; a cancelled card earns the x. */
export function cardMark(
	t: Pick<Task, "cancelledAt" | "state" | "stage" | "asked" | "needsReason">,
):
	| "needs"
	| "asked"
	| "running"
	| "preparing"
	| "queued"
	| "done"
	| "cancelled" {
	if (t.cancelledAt !== null) return "cancelled";
	// A proposal is a suggestion, not a fault: it waits like a card not started yet.
	if (isProposal(t)) return "queued";
	if (t.state === "needs_you") return t.asked !== null ? "asked" : "needs";
	if (t.state === "running" || t.state === "preparing") return t.state;
	return t.state === "queued" || t.stage !== "done" ? "queued" : "done";
}

/** A retro or fork proposal waiting for the operator's decision: not started, never an alarm. */
export function isProposal(
	t: Pick<Task, "state" | "cancelledAt" | "needsReason">,
): boolean {
	return (
		t.state === "needs_you" &&
		t.cancelledAt === null &&
		isProposalReason(t.needsReason)
	);
}

/** The hold statusLine shows for `t`, over the whole project (`tasks` spans every lane): a
 * queued merge waits on its own mergeHold (an open review, unless the card is one of its
 * findings, as in pickRunnable) or on the push hold the server stamped (`pushHold`, OTTR-506:
 * local main has commits origin lacks; the browser gets no git), then any stage on its
 * unfinished dependencies (one missing from `tasks` counts as done; `foreign` OTTR-708 looks
 * an id up across the board's projects, unresolvable counts as done), a queued pending
 * sandbox lead on its review's validation run (OTTR-1247); a done card is never held. */
export function holdFor(
	t: Pick<
		Task,
		| "id"
		| "stage"
		| "state"
		| "dependsOn"
		| "pushRetries"
		| "pendingBy"
		| "validatedAt"
		| "followUpOf"
		| "cancelledAt"
	> & {
		pushHold?: boolean;
		vmHold?: string;
		/** The wire stamp (taskView); store rows read the prompt tag instead. */
		sandboxLead?: true;
	},
	tasks: readonly (ReviewTask & Pick<Task, "title">)[],
	foreign?: DepIndex,
	now?: number,
): string | null {
	if (t.stage === "done") return null;
	if (t.stage === "merging") {
		const held =
			mergeHold(tasks, t, { now }) ?? (t.pushHold === true ? PUSH_HOLD : null);
		if (held !== null) return held;
	}
	// A card waiting on its dependencies would not dispatch even with a free microVM, so the
	// dependency hold names the real blocker first; the server stamps vmHold on queued cards.
	// OTTR-1247: a pending sandbox lead queued in a work lane waits for its review's batch
	// validation — no work turn can ever take it, so that hold outranks the dependency one.
	return (
		leadValidationHold(t) ?? depHold(tasks, t, foreign) ?? t.vmHold ?? null
	);
}

/** The release card's re-release view, else null: parked for the user (needs_you or idle, not
 * cancelled, not done), every finding done or cancelled, and at least one queued merge held
 * (the state names the ids on the release card). */
export function reReleaseOf(
	t: TaskCard,
	tasks: readonly (ReviewTask & Pick<Task, "title">)[],
): { ids: string[]; findings: number } | null {
	if (t.cancelledAt !== null || t.releaseVersion === null || t.stage === "done")
		return null;
	if (t.state !== "needs_you" && t.state !== "idle") return null;
	const ids = t.heldMerges ?? [];
	if (ids.length === 0) return null;
	if (
		reviewFindings(tasks, t).some(
			(f) => f.cancelledAt === null && f.stage !== "done",
		)
	)
		return null;
	return { ids, findings: reviewFindings(tasks, t).length };
}

/** The open release that mergeHold holds `t` behind — the inverse of the state's heldMerges
 * lists; null when no release card names `t`. */
export function releaseHolding(
	t: Pick<Task, "id">,
	tasks: readonly TaskCard[],
): { id: string; version: string | null } | null {
	for (const r of tasks)
		if ((r.heldMerges ?? []).includes(t.id))
			return { id: r.id, version: r.releaseVersion };
	return null;
}

/** The alarm split the overview, the areas nav and the notifications share: plain needs_you
 * cards, needs_you cards with an outstanding ask, and live work (preparing counts as running).
 * A proposal is in none of them: it waits for a decision, it does not need action. */
export function splitAlarms(tasks: readonly TaskCard[]): {
	needs: TaskCard[];
	asks: TaskCard[];
	running: TaskCard[];
} {
	const needs: TaskCard[] = [];
	const asks: TaskCard[] = [];
	const running: TaskCard[] = [];
	for (const t of tasks) {
		if (isProposal(t)) continue;
		if (t.state === "needs_you") (t.asked !== null ? asks : needs).push(t);
		else if (t.state === "running" || t.state === "preparing") running.push(t);
	}
	return { needs, asks, running };
}

/** The bell's rows for PR review cards: plain needs-you cards, unseen comment stamps,
 *  and the board's own posted-review stamps, minus projects whose PR review notifications
 *  are off (docs/specs/pr-review-auto-post.md). `needs` is splitAlarms' needs split, still
 *  to quiet-filter. */
export function bellAlarms(
	tasks: readonly TaskCard[],
	needs: readonly TaskCard[],
	projects: readonly ProjectView[],
): { needsShown: TaskCard[]; activity: TaskCard[]; posted: TaskCard[] } {
	const quiet = (t: TaskCard): boolean =>
		t.kind === "pr_review" &&
		projects.find((p) => p.name === t.project)?.settings.prReviewNotify ===
			false;
	return {
		needsShown: needs.filter((t) => !quiet(t)),
		activity: tasks.filter(
			(t) =>
				t.kind === "pr_review" && t.prOccurrence?.comments != null && !quiet(t),
		),
		posted: tasks.filter(
			(t) =>
				t.kind === "pr_review" && t.prOccurrence?.posted != null && !quiet(t),
		),
	};
}

/** One-line alarm summary for the bell/title; "" when nothing needs attention. */
export function alarmLabel(needs: number, asks: number, pr = 0): string {
	return [
		needs > 0
			? needs === 1
				? "1 task needs action"
				: `${needs} tasks need action`
			: null,
		asks > 0
			? asks === 1
				? "1 question asked"
				: `${asks} questions asked`
			: null,
		pr === 1
			? "1 PR review has activity"
			: pr > 0
				? `${pr} PR reviews have activity`
				: null,
	]
		.filter(Boolean)
		.join(" · ");
}
