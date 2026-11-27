// OTTR-1259 inbox sweep: the strict readers and pure helpers the sweep's filing,
// settle and routes share. The recorded prompt's contract is the spec's
// (docs/specs/inbox-sweep.md "Verdicts and the recorded shape"): the first line
// carries the verdict, `--- card draft ---` lines open draft blocks. Report text,
// evidence and titles are untrusted data: nothing here parses instructions from
// them into behavior, and a verdict whose first line is not exact reads as null.

import type { ListedTask, ResearchSteps, Task } from "./types.ts";
import { doneReadKey, recommendsSteps } from "./types.ts";

/** The board's cheap model role plans the batch; this is its card cap (module
 * constant by the spec, no new setting in v1). */
export const SWEEP_BATCH_SIZE = 10;

/** A line that contains exactly this opens one draft block; the block's lines
 * are the draft's self-contained card prompt. */
export const SWEEP_DRAFT_SEP = "--- card draft ---";

/** One sweep verdict the run recorded with propose_task; the shape
 * `sweepResult` parses a recorded prompt into. */
export type SweepRecord = {
	/** The pinned research card the verdict names (`#<id>` on the first line). */
	cardId: string;
	verdict: "done" | "partial" | "none" | "info";
	/** The prompt text between the first line and the first draft block, trimmed. */
	evidence: string;
	/** One draft card prompt per block after a separator line, trimmed. */
	drafts: string[];
};

/** A sweep run's per-card verdict, read from the recorded prompt's exact first
 * line `Sweep: #<card id> <verdict>` (OTTR-1259). Strict like `validationResult`
 * (src/auditLeads.ts): only the first line decides, the verdict word is matched
 * case-sensitively, and a `Sweep:` line inside evidence or a draft never wins.
 * Null: any other shape — no recorded verdict. Never throws. */
export function sweepResult(prompt: string): SweepRecord | null {
	const lines = prompt.split("\n");
	const match = /^Sweep: #(\S+) (done|partial|none|info)$/.exec(lines[0] ?? "");
	if (match === null) return null;
	const cardId = match[1];
	const verdict = match[2];
	if (cardId === undefined || verdict === undefined) return null;
	// A draft opens at the first line that contains exactly the separator; the
	// lines before it are the evidence, the lines after each separator are one
	// draft's self-contained card prompt.
	const head: string[] = [];
	const blocks: string[][] = [];
	let open: string[] | null = null;
	for (const line of lines.slice(1)) {
		if (line === SWEEP_DRAFT_SEP) {
			if (open !== null) blocks.push(open);
			open = [];
		} else if (open === null) head.push(line);
		else open.push(line);
	}
	if (open !== null) blocks.push(open);
	return {
		cardId,
		verdict: verdict as SweepRecord["verdict"],
		evidence: head.join("\n").trim(),
		drafts: blocks.map((b) => b.join("\n").trim()),
	};
}

/** OTTR-488 steps resolution for the sweep's candidate filter: the stored value,
 * except legacy 'unknown' rows resolve against the stored report (the app.ts
 * viewSteps rule; a copy because the turn loop cannot import app.ts). */
export function sweepSteps(
	t: Pick<Task, "steps"> & { report?: string | null },
): ResearchSteps {
	return t.steps !== "unknown"
		? t.steps
		: t.report != null && recommendsSteps(t.report)
			? "yes"
			: "unknown";
}

/** The steps evidence one card block carries: from the `## Recommended steps`
 * heading line to the next `## ` heading, capped at 2000 characters. A
 * steps-resolved card without the heading (a legacy regex match, or a pure-info
 * report) contributes the report's first 2000 characters. */
export function stepsEvidence(report: string): string {
	const lines = report.split("\n");
	const start = lines.findIndex((l) => /^##\s+recommended steps\b/i.test(l));
	if (start === -1) return report.slice(0, 2000);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n").slice(0, 2000);
}

/** The repo-relative path-looking strings a report names, capped at 20: word
 * characters with at least one inner `/`, no scheme (a URL's path is another
 * card's concern), no `-` or `:` lead, so a token is always a safe git pathspec.
 * Duplicates collapse, order keeps the report's. */
export function reportPathTokens(report: string): string[] {
	const found: string[] = [];
	for (const m of report.matchAll(
		/(?<![\w./:@-])[A-Za-z0-9_][\w.-]*\/[\w.-]+(?:\/[\w.-]+)*(?![\w.-]*:\/\/)/g,
	)) {
		const token = m[0];
		if (!found.includes(token)) found.push(token);
		if (found.length === 20) break;
	}
	return found;
}

/** The board card ids a report names (`CLIP-64`, the TASK_ID_RE handle shape,
 * upper case, word-bounded so `XCLIP-64` never yields `CLIP-64`), capped at 20.
 * The task names ids as evidence sources beside file paths. */
export function reportIdTokens(report: string): string[] {
	const found: string[] = [];
	for (const m of report.matchAll(/\b[A-Z0-9]{1,8}-\d+\b/g)) {
		const token = m[0];
		if (!found.includes(token)) found.push(token);
		if (found.length === 20) break;
	}
	return found;
}

/** Every transitive `followUpOf` child of one card, oldest first (id tiebreak).
 * The store list is complete, so one pass over the rows walks the whole tree;
 * a cycle guard keeps a corrupt chain from looping. */
export function collectDescendants(
	tasks: ReadonlyArray<ListedTask>,
	id: string,
): ListedTask[] {
	const out: ListedTask[] = [];
	const seen = new Set<string>([id]);
	for (;;) {
		const children = tasks.filter(
			(t) => t.followUpOf !== null && seen.has(t.followUpOf) && !seen.has(t.id),
		);
		if (children.length === 0) break;
		for (const c of children) seen.add(c.id);
		out.push(
			...children.sort(
				(a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
			),
		);
	}
	return out.sort(
		(a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
	);
}

/** One evidence line per descendant: id, title, kind, stage, state and the
 * cancelled mark, capped at 30 rows plus one `(+N more)` line. */
export function descendantLines(children: ReadonlyArray<ListedTask>): string[] {
	const line = (t: ListedTask): string =>
		`- #${t.id} ${t.title} — ${t.kind}, ${t.stage}, ${t.state}${t.cancelledAt !== null ? ", cancelled" : ""}`;
	const head = children.slice(0, 30).map(line);
	if (children.length > 30) head.push(`(+${children.length - 30} more)`);
	return head;
}

/** The other cards of the project whose title, prompt or details name one of the
 * report's path tokens, capped at 10 (oldest first, id tiebreak). `detailsOf`
 * reads the wide details column only when the list row's title and prompt miss,
 * so a clean board pays no extra reads. */
export async function relatedByTokens(
	tasks: ReadonlyArray<ListedTask>,
	tokens: ReadonlyArray<string>,
	idTokens: ReadonlyArray<string>,
	targetId: string,
	detailsOf: (id: string) => Promise<string | null>,
): Promise<ListedTask[]> {
	if (tokens.length === 0 && idTokens.length === 0) return [];
	// Path tokens match as substrings (they carry separators); an id token needs
	// its word boundaries, so `CLIP-6` never matches `CLIP-64`.
	const idRe =
		idTokens.length > 0 ? new RegExp(`\\b(?:${idTokens.join("|")})\\b`) : null;
	const names = (t: {
		title: string;
		prompt: string;
		details?: string | null;
	}): boolean =>
		tokens.some(
			(tok) =>
				t.title.includes(tok) ||
				t.prompt.includes(tok) ||
				(t.details ?? "").includes(tok),
		) ||
		(idRe !== null &&
			(idRe.test(t.title) ||
				idRe.test(t.prompt) ||
				idRe.test(t.details ?? "")));
	const others = tasks
		.filter((t) => t.id !== targetId)
		.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
	const hit: ListedTask[] = [];
	for (const t of others) {
		if (hit.length === 10) break;
		if (names(t)) {
			hit.push(t);
			continue;
		}
		const details = await detailsOf(t.id);
		if (
			details !== null &&
			names({ title: t.title, prompt: t.prompt, details })
		)
			hit.push(t);
	}
	return hit;
}

/** One evidence line per related card, capped at 10 rows plus one `(+N more)`
 * line. */
export function relatedLines(cards: ReadonlyArray<ListedTask>): string[] {
	const line = (t: ListedTask): string =>
		`- #${t.id} ${t.title} — ${t.kind}, ${t.stage}, ${t.state}${t.cancelledAt !== null ? ", cancelled" : ""}`;
	const head = cards.slice(0, 10).map(line);
	if (cards.length > 10) head.push(`(+${cards.length - 10} more)`);
	return head;
}

/** The stale rule, computed live against the sweep run's filing stamp T (the
 * run card's immutable `createdAt`; the same rule the view and the apply route
 * run): the target's `updatedAt > T`, or the target is cancelled at `> T`, or
 * any transitive descendant of the target changed after T — its `updatedAt`
 * covers a new child (createdAt ≤ updatedAt always) and an answer, finish or
 * cancellation landing on an existing one. */
export function sweepRowStale(
	target: Pick<ListedTask, "updatedAt" | "cancelledAt">,
	descendants: ReadonlyArray<Pick<ListedTask, "updatedAt">>,
	stamp: number,
): boolean {
	if (target.updatedAt > stamp) return true;
	if (target.cancelledAt !== null && target.cancelledAt > stamp) return true;
	return descendants.some((d) => d.updatedAt > stamp);
}

/** The card ids every live sweep card (kind "sweep", not cancelled) already
 * records a verdict for — a chained or re-started sweep never re-sweeps a
 * covered card, and a cancelled sweep's verdicts cover nothing. */
export async function sweepCoveredCards(
	tasks: ReadonlyArray<Pick<ListedTask, "id" | "kind" | "cancelledAt">>,
	findingsOf: (cardId: string) => Promise<ReadonlyArray<{ prompt: string }>>,
): Promise<Set<string>> {
	const covered = new Set<string>();
	for (const t of tasks) {
		if (t.kind !== "sweep" || t.cancelledAt !== null) continue;
		for (const f of await findingsOf(t.id)) {
			const r = sweepResult(f.prompt);
			if (r !== null) covered.add(r.cardId);
		}
	}
	return covered;
}

/** The sweep's candidate rows: the Inbox's pinned research cards — done, not
 * cancelled, done after the seen baseline, whose completion key is not in the
 * seen set, and that no live sweep covers — oldest `createdAt` first, id
 * tiebreak. The seen rule mirrors the Inbox's own unread rule (queue.ts
 * isUnread, OTTR-566): a done card reads via its `<id>@<doneAt>` completion
 * key only, so a card done again after an older read stays a candidate while
 * every read card outside today's Inbox drops out. The steps resolution
 * (`sweepSteps` or the view's `viewSteps`) filters before this call: rows are
 * full cards there. */
export function sweepCandidateRows<T extends ListedTask>(
	tasks: ReadonlyArray<T>,
	seen: ReadonlySet<string>,
	since: number,
	covered: ReadonlySet<string>,
): T[] {
	return tasks
		.filter(
			(t) =>
				t.research &&
				t.stage === "done" &&
				t.cancelledAt === null &&
				t.doneAt !== null &&
				t.doneAt > since &&
				!seen.has(doneReadKey({ id: t.id, doneAt: t.doneAt })) &&
				!covered.has(t.id),
		)
		.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}
