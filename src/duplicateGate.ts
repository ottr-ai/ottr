import { runGateway, type SpawnFn } from "./forkAnalysis.ts";
import { stripFence } from "./promptGate.ts";
import {
	DUPLICATE_REASON,
	dupTermsPrompt,
	dupTermsSystem,
	dupVerdictPrompt,
	dupVerdictSystem,
} from "./prompts.ts";
import type { ListedTask, Task } from "./types.ts";
import { git } from "./worktree.ts";

/** Most candidate tasks the verdict call sees (docs/specs/duplicate-gate.md). */
export const DUP_CANDIDATE_CAP = 30;

/** The data the verdict model sees for one candidate task. */
export interface DupCandidate {
	id: string;
	status: "in progress" | "merging" | "done research";
	title: string;
	prompt: string;
	summary: string | null;
	/** Done research only; null for every other status. */
	report: string | null;
}

export type DupMatch =
	| { kind: "code"; ref: string }
	| { kind: "task"; ref: string };

/** The validated verdict: every task ref is a candidate id, every code ref a hit path. */
export interface DupVerdict {
	verdict: "duplicate" | "partial" | "new";
	matches: DupMatch[];
	reason: string;
}

/** One code search hit on the target ref; `line` null = the file path holds the term. */
export interface CodeHit {
	path: string;
	line: number | null;
	text: string;
}

/** True when an uncancelled task on the same board continues the given card. */
function hasFollowUp(id: string, tasks: ListedTask[]): boolean {
	return tasks.some(
		(t) =>
			t.cancelledAt === null &&
			t.followUpOf === id &&
			t.followUpOfProject === null,
	);
}

/** The same project's tasks the new card can repeat: in progress, merging, or done
 * research without a follow-up; never self, nor the card self continues. A child on
 * another board is not in the list, so its parent counts as "without a follow-up".
 * Newest updatedAt first, at most DUP_CANDIDATE_CAP. */
export function dupCandidateTasks(
	self: ListedTask,
	tasks: ListedTask[],
): ListedTask[] {
	const parent = self.followUpOfProject === null ? self.followUpOf : null;
	return tasks
		.filter(
			(t) =>
				t.cancelledAt === null &&
				t.id !== self.id &&
				t.id !== parent &&
				(t.stage === "in_progress" ||
					t.stage === "merging" ||
					(t.stage === "done" && t.research && !hasFollowUp(t.id, tasks))),
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, DUP_CANDIDATE_CAP);
}

/** Maps one selected task to the capped data the model sees. A stage outside the
 * candidate rules throws RangeError: dupCandidateTasks never selects one. */
export function dupCandidate(task: Task): DupCandidate {
	let status: DupCandidate["status"];
	if (task.stage === "in_progress") status = "in progress";
	else if (task.stage === "merging") status = "merging";
	else if (task.stage === "done" && task.research) status = "done research";
	else
		throw new RangeError(
			`task ${task.id} is not a duplicate candidate (stage ${task.stage}, research ${task.research})`,
		);
	return {
		id: task.id,
		status,
		title: task.title,
		prompt: task.prompt.slice(0, 1200),
		summary: task.summary?.slice(0, 400) ?? null,
		report:
			status === "done research" ? (task.report?.slice(0, 1500) ?? null) : null,
	};
}

/** Parses the fence-stripped text as JSON; a parse failure throws RangeError naming the answer. */
function parseJson(raw: string, what: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch (err) {
		throw new RangeError(
			`${what} is not valid JSON: ${(err as Error).message}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new RangeError(`${what} is not a JSON object`);
	return parsed as Record<string, unknown>;
}

/** Parses the terms answer: strings of 3 to 80 chars after trim, deduplicated case
 * insensitive, at most 8. Other entries drop; bad JSON or a non-array throws RangeError. */
export function parseDupTerms(raw: string): string[] {
	const o = parseJson(raw, "duplicate terms answer");
	if (!Array.isArray(o.terms))
		throw new RangeError('duplicate terms answer "terms" is not an array');
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const t of o.terms) {
		if (typeof t !== "string") continue;
		const term = t.trim();
		const key = term.toLowerCase();
		if (term.length < 3 || term.length > 80 || seen.has(key)) continue;
		seen.add(key);
		terms.push(term);
		if (terms.length === 8) break;
	}
	return terms;
}

/** Caps of the code search (docs/specs/duplicate-gate.md). */
const GREP_HITS_PER_TERM = 20;
const PATH_HITS_PER_TERM = 10;
const HIT_TEXT_CAP = 200;
const HITS_CAP = 120;

/** `path:line:text` of one git grep line after the `<ref>:` prefix; the lazy path
 * stops at the first `:<digits>:`. */
const GREP_LINE = /^(.+?):(\d+):(.*)$/;

/** Read-only code search on `ref`: `git grep` content hits (at most 20 for each term,
 * 3 per file) and path-name hits from one `git ls-tree` (at most 10 for each term, line
 * null). Hits are deduplicated, texts capped at 200 chars, at most 120 hits. A git exit
 * other than 0 (or 1 = no grep match) throws an Error naming git's stderr. */
export async function searchCode(o: {
	cwd: string;
	ref: string;
	terms: string[];
	git?: typeof git;
}): Promise<CodeHit[]> {
	if (o.terms.length === 0) return [];
	const run = o.git ?? git;
	const tree = await run(["ls-tree", "-r", "--name-only", o.ref], o.cwd);
	if (tree.code !== 0)
		throw new Error(
			`git ls-tree ${o.ref} failed (exit ${tree.code}): ${tree.stderr.trim()}`,
		);
	const files = tree.stdout.split("\n").filter((l) => l !== "");
	const prefix = `${o.ref}:`;
	const hits: CodeHit[] = [];
	const seen = new Set<string>();
	const add = (hit: CodeHit): void => {
		const key = `${hit.path}\0${hit.line}`;
		if (seen.has(key) || hits.length >= HITS_CAP) return;
		seen.add(key);
		hits.push(hit);
	};
	for (const term of o.terms) {
		const r = await run(
			[
				"grep",
				"-n",
				"-I",
				"-i",
				"-F",
				"--max-count=3",
				"-e",
				term,
				o.ref,
				"--",
			],
			o.cwd,
		);
		if (r.code !== 0 && r.code !== 1)
			throw new Error(
				`git grep on ${o.ref} failed (exit ${r.code}): ${r.stderr.trim()}`,
			);
		let n = 0;
		for (const line of r.code === 0 ? r.stdout.split("\n") : []) {
			if (n === GREP_HITS_PER_TERM) break;
			const m = GREP_LINE.exec(
				line.startsWith(prefix) ? line.slice(prefix.length) : line,
			);
			if (m === null) continue;
			add({
				path: m[1] as string,
				line: Number(m[2]),
				text: (m[3] as string).trim().slice(0, HIT_TEXT_CAP),
			});
			n++;
		}
		const needle = term.toLowerCase();
		for (const path of files
			.filter((f) => f.toLowerCase().includes(needle))
			.slice(0, PATH_HITS_PER_TERM))
			add({ path, line: null, text: "" });
	}
	return hits;
}

/** True when a code ref is `<path>` or `<path>:<line>` with `<path>` a hit path. */
function knownCodeRef(ref: string, paths: ReadonlySet<string>): boolean {
	if (paths.has(ref)) return true;
	const m = /^(.+):\d+$/.exec(ref);
	return m !== null && paths.has(m[1] as string);
}

/** Parses and validates the verdict answer (one optional markdown fence). Task refs must
 * be candidate ids and code refs hit paths, so a hallucinated match fails the gate open.
 * Refs are trimmed and capped at 200 before the check, the reason at 500, matches at 10
 * kept. Any violation throws RangeError naming it. */
export function parseDupVerdict(
	raw: string,
	o: { taskIds: ReadonlySet<string>; paths: ReadonlySet<string> },
): DupVerdict {
	const v = parseJson(raw, "duplicate verdict");
	if (
		v.verdict !== "duplicate" &&
		v.verdict !== "partial" &&
		v.verdict !== "new"
	)
		throw new RangeError(
			`duplicate verdict "verdict" must be duplicate, partial or new, got ${JSON.stringify(v.verdict) ?? "undefined"}`,
		);
	const verdict: DupVerdict["verdict"] = v.verdict;
	if (typeof v.reason !== "string" || v.reason.trim() === "")
		throw new RangeError('duplicate verdict "reason" is missing or empty');
	if (!Array.isArray(v.matches))
		throw new RangeError('duplicate verdict "matches" is not an array');
	const matches = v.matches.map((m, i): DupMatch => {
		if (typeof m !== "object" || m === null)
			throw new RangeError(`duplicate verdict matches[${i}] is not an object`);
		const mo = m as Record<string, unknown>;
		if (typeof mo.ref !== "string")
			throw new RangeError(
				`duplicate verdict matches[${i}].ref is not a string`,
			);
		const ref = mo.ref.trim().slice(0, 200);
		if (mo.kind === "task") {
			if (!o.taskIds.has(ref))
				throw new RangeError(
					`duplicate verdict matches[${i}] names an unknown task id: ${ref}`,
				);
			return { kind: "task", ref };
		}
		if (mo.kind === "code") {
			if (!knownCodeRef(ref, o.paths))
				throw new RangeError(
					`duplicate verdict matches[${i}] names a path outside the search hits: ${ref}`,
				);
			return { kind: "code", ref };
		}
		throw new RangeError(
			`duplicate verdict matches[${i}].kind must be code or task`,
		);
	});
	if (verdict === "new" && matches.length > 0)
		throw new RangeError('duplicate verdict "new" carries matches');
	if (verdict !== "new" && matches.length === 0)
		throw new RangeError(`duplicate verdict "${verdict}" carries no match`);
	return {
		verdict,
		matches: matches.slice(0, 10),
		reason: v.reason.trim().slice(0, 500),
	};
}

/** The gate's two tool-free model calls around the code search: search terms, then
 * the verdict over the task, the hits and the candidates. No terms = no search; the
 * verdict call still runs. */
export async function duplicateCheck(o: {
	prompt: string;
	candidates: DupCandidate[];
	cwd: string;
	ref: string;
	spawn?: SpawnFn;
	git?: typeof git;
	timeoutMs?: number;
}): Promise<DupVerdict> {
	const timeoutMs = o.timeoutMs ?? 120_000;
	const terms = parseDupTerms(
		await runGateway(
			[
				{ role: "system", content: dupTermsSystem },
				{ role: "user", content: dupTermsPrompt(o.prompt) },
			],
			o.spawn,
			timeoutMs,
			"@plan",
		),
	);
	const hits =
		terms.length === 0
			? []
			: await searchCode({ cwd: o.cwd, ref: o.ref, terms, git: o.git });
	const raw = await runGateway(
		[
			{ role: "system", content: dupVerdictSystem },
			{ role: "user", content: dupVerdictPrompt(o.prompt, hits, o.candidates) },
		],
		o.spawn,
		timeoutMs,
		"@plan",
	);
	return parseDupVerdict(raw, {
		taskIds: new Set(o.candidates.map((c) => c.id)),
		paths: new Set(hits.map((h) => h.path)),
	});
}

/** The matches as one comma-separated line: a task as `<id> (<status>)`, code as its ref. */
export function dupMatchText(
	v: DupVerdict,
	candidates: DupCandidate[],
): string {
	return v.matches
		.map((m) => {
			if (m.kind === "code") return m.ref;
			const c = candidates.find((x) => x.id === m.ref);
			return c === undefined ? m.ref : `${m.ref} (${c.status})`;
		})
		.join(", ");
}

/** The needsReason of a card the gate closes. */
export function dupCloseReason(
	v: DupVerdict,
	candidates: DupCandidate[],
): string {
	return `${DUPLICATE_REASON}${dupOverlapNote(v, candidates)}`;
}

/** The overlap note a partial verdict stamps on the card. */
export function dupOverlapNote(
	v: DupVerdict,
	candidates: DupCandidate[],
): string {
	return `${v.reason} Matches: ${dupMatchText(v, candidates)}`;
}
