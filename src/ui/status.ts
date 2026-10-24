import { depHold, mergeHold, type ReviewTask } from "../scheduler.ts";
import type { Task, TaskCard } from "../types.ts";

/** The state mark shapes a task card can carry; "crit" renders elsewhere and never comes from a task. */
export type TaskMark =
	| "needs"
	| "asked"
	| "running"
	| "preparing"
	| "queued"
	| "done";

/** Redundant state coding (ISA-101): the mark shape per task state — alarms only on needs_you,
    the question mark ("asked") while its question is out. */
export function markKind(t: Pick<Task, "state" | "asked">): TaskMark {
	if (t.state === "needs_you") return t.asked !== null ? "asked" : "needs";
	if (t.state === "running" || t.state === "preparing" || t.state === "queued")
		return t.state;
	return "done";
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
	if (m === null) return null;
	return {
		tool: m[1]!,
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
		if (timedOut !== null) return { label: "Timed out", value: timedOut[1]! };
		return { label: "", value: part };
	});
}

export function statusLine(
	t: Pick<
		TaskCard,
		"state" | "stage" | "needsReason" | "pendingPrompt" | "asked" | "progress"
	>,
	hasRules: boolean,
	hold?: string | null,
	/** True while an update holds new turns (POST /api/drain): every queued card waits for the restart. */
	drain = false,
): string {
	// A queued card that keeps a reason was queued again by the tracker (restart, background-job exit).
	if (t.state === "queued")
		return t.stage === "backlog"
			? "grill queued"
			: t.needsReason !== null
				? "resuming"
				: t.pendingPrompt !== null
					? drain
						? "reply queued · waits for the update restart"
						: "reply queued · waits for a free slot"
					: t.stage === "todo" && !hasRules
						? "waiting for rules"
						: (t.stage === "merging" ||
									t.stage === "todo" ||
									t.stage === "in_progress") &&
								hold
							? hold
							: drain
								? "waiting for the update restart"
								: "queued";
	if (t.state === "preparing") return "preparing";
	if (t.state === "running") return t.progress ?? "running";
	if (t.state === "needs_you")
		return t.asked !== null ? "question asked" : "action required";
	// A review card parked while its findings land: the reason is the status.
	if (t.state === "idle")
		return t.stage === "backlog" ? "in backlog" : (t.needsReason ?? "done");
	return "done";
}

/** The card's state mark. A card idle short of done (a review parked while its findings land)
 * waits like a queued one: only a done card earns the check. */
export function cardMark(
	t: Pick<Task, "state" | "stage" | "asked">,
): "needs" | "asked" | "running" | "preparing" | "queued" | "done" {
	if (t.state === "needs_you") return t.asked !== null ? "asked" : "needs";
	if (t.state === "running" || t.state === "preparing") return t.state;
	return t.state === "queued" || t.stage !== "done" ? "queued" : "done";
}

/** The hold statusLine shows for `t`, over the whole project (`tasks` spans every lane): a
 * queued merge waits on its own mergeHold (an open review, unless the card is one of its
 * findings, as in pickRunnable), then any stage on its unfinished dependencies (one missing
 * from `tasks` counts as done); a done card is never held. */
export function holdFor(
	t: Pick<Task, "id" | "stage" | "dependsOn">,
	tasks: readonly (ReviewTask & Pick<Task, "title">)[],
): string | null {
	if (t.stage === "done") return null;
	return (
		(t.stage === "merging" ? mergeHold(tasks, t) : null) ?? depHold(tasks, t)
	);
}

/** The alarm split the overview, the areas nav and the notifications share: plain needs_you
 * cards, needs_you cards with an outstanding ask, and live work (preparing counts as running). */
export function splitAlarms(tasks: readonly TaskCard[]): {
	needs: TaskCard[];
	asks: TaskCard[];
	running: TaskCard[];
} {
	const needs: TaskCard[] = [];
	const asks: TaskCard[] = [];
	const running: TaskCard[] = [];
	for (const t of tasks) {
		if (t.state === "needs_you") (t.asked !== null ? asks : needs).push(t);
		else if (t.state === "running" || t.state === "preparing") running.push(t);
	}
	return { needs, asks, running };
}

/** One-line alarm summary for the bell/title; "" when nothing needs attention. */
export function alarmLabel(needs: number, asks: number): string {
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
	]
		.filter(Boolean)
		.join(" · ");
}
