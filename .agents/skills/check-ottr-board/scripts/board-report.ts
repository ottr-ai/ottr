// check-ottr-board steps 2-3 as code: list the open cards, apply the verdict table, read
// the holds, the log ages, the asked questions and the main checkouts. Prints markdown.
// Board mode: bun <skill-dir>/scripts/board-report.ts (inside ottr-server-1). Host mode:
//   docker exec -i ottr-server-1 bun - < <skill-dir>/scripts/board-report.ts
// Read-only: only GET requests, stat and git status. SKILL.md step 3 holds the verdict
// table this file implements — change both in the same commit.
import { existsSync, statSync } from "node:fs";

export type Asked = {
	question: string;
	/** Carried by every real AskQuestion (src/types.ts); the report prints options only. */
	multi?: boolean;
	options?: { label?: string }[];
	recommended?: number | null;
};

export type Card = {
	id: string;
	project: string;
	title?: string;
	stage: string;
	state: string;
	needsReason?: string | null;
	asked?: Asked[] | null;
	dependsOn?: string[];
	holdUntil?: number | null;
	cancelledAt?: number | null;
	followUpOf?: string | null;
	updatedAt?: number;
	/** Carried by real TaskCard rows (src/types.ts); mergeHold's isReview reads them. */
	kind?: string;
	releaseVersion?: string | null;
};

export type Project = { name: string; path: string; gitless?: boolean };

/** The fields of GET /api/state the report reads; the real answer carries more. */
export type BoardState = {
	tasks: Card[];
	projects: Project[];
	maxTotal: number | null;
	drainUntil: number | null;
};

export type Facts = {
	now: number;
	logAgeS: number | null;
	hold: string | null;
	depsOpen: string[];
	drain: boolean;
	capFull: boolean;
	/** The board's cards. The queued merge scans them for a merge turn of the same
	 * project that runs or prepares: the scheduler runs one merge per project. */
	cards: Card[];
};

const IDLE_LIMIT_S = 20 * 60; // skill step 3: a run is stuck when its log does not grow for 20 minutes
const APPROVAL = [
	/^Update card:/,
	/^Fork-research-born task:/,
	/Accept to start it, edit the prompt first, or cancel to decline\.?$/,
	/Accept starts it\. Edit task changes the prompt first\. Cancel task declines it\.?$/,
];
// A park that names its own resume condition waits by design (for example a release-line date or two reviews).
const WAITS = [
	/^Please resume .* after /,
	/^Please resume .* when /,
	/^Re-run this card's .* after /,
];
const FINDINGS = /waiting for the review's findings/;
// A posted PR review parks its card at in_progress/idle while the pull request stays open.
const PR_POSTED = /^Review posted; /;
const AHEAD = /ahead \d+/;

// Skill step 4 "Sign -> Cause -> Fix" as data: the first match gives the hint.
const SIGNS: [RegExp, string][] = [
	[
		/Reported answered, but the branch has \d+ commit/,
		"research card with commits: POST /unmark-research if the commits are the card's work",
	],
	[
		/Reported ready, but git shows|Kept the worktree: uncommitted/,
		"uncommitted files: read git status, reply to move scratch out and commit",
	],
	[
		/finished without calling report_outcome/,
		'early stop: read the log end, reply "Continue the task, then call report_outcome."',
	],
	[
		/^Tracker error:/,
		"board exception: read the message and docker logs --since 2h ottr-server-1",
	],
	[
		/^Release failed:/,
		"release command failed: read its output in the log, fix, reply to retry",
	],
	[
		/work check failed twice|review check failed twice/,
		"check model failed: read the check lines; when the provider works, reply to run it again",
	],
	[
		/work check blocked the merge a third time|diverging/i,
		"repeated blockers: read them; a review-only blocker after approval -> merge-anyway, else ask the user",
	],
	[
		/usage limit|rate limit|429/i,
		"provider limit: check for a hold until the reset",
	],
	[/out of memory|OOM/i, "worker OOM: reply to continue once"],
	[/^Prompt gate:/, "prompt gate: collect the questions for the user"],
];

/** A verdict table cell: the verdict word and its note. */
type Verdict = { verdict: string; note: string };

/** True when t runs or prepares, the two live states of a turn. */
const runsOrPrepares = (t: Card) =>
	t.state === "running" || t.state === "preparing";

/** The needs_you branch: question when the card asks, decision on the APPROVAL table,
 * waits on the WAITS table, stuck with the first matching SIGNS hint otherwise. */
function needsYouVerdict(c: Card, r: string): Verdict {
	if ((c.asked?.length ?? 0) > 0) return { verdict: "question", note: "" };
	if (APPROVAL.some((re) => re.test(r)))
		return { verdict: "decision", note: "" };
	if (WAITS.some((re) => re.test(r)))
		return {
			verdict: "waits",
			note: "resumes on the condition in its reason",
		};
	return {
		verdict: "stuck",
		note: SIGNS.find(([re]) => re.test(r))?.[1] ?? "unknown sign: diagnose",
	};
}

/** The running/preparing branch: stuck when the log is idle past the limit. */
function runningVerdict(logAgeS: number | null): Verdict {
	if (logAgeS !== null && logAgeS > IDLE_LIMIT_S)
		return {
			verdict: "stuck",
			note: `log idle ${Math.round(logAgeS / 60)} min`,
		};
	return {
		verdict: "OK",
		note: logAgeS === null ? "no log yet" : `log ${logAgeS}s old`,
	};
}

/** True when t is another merge turn of c's project that runs or prepares. */
function otherRunningMerge(c: Card, t: Card): boolean {
	return (
		t.id !== c.id &&
		t.cancelledAt === null &&
		t.project === c.project &&
		t.stage === "merging" &&
		runsOrPrepares(t)
	);
}

/** Every hold that keeps the queued card waiting, in note order. An empty list
 * means no hold explains the wait. */
function queuedHolds(c: Card, f: Facts): string[] {
	const hu = c.holdUntil;
	// The scheduler runs one merge per project (mergeSlot returns null while a
	// merge turn runs), so a queued merge waits for it by design.
	const runsMerge =
		c.stage === "merging"
			? f.cards.find((t) => otherRunningMerge(c, t))
			: undefined;
	return [
		f.drain && "drain",
		f.capFull && "cap full",
		f.depsOpen.length > 0 && `waits for ${f.depsOpen.join(",")}`,
		hu !== null &&
			hu !== undefined &&
			hu > f.now &&
			`holdUntil ${new Date(hu).toISOString()}`,
		f.hold,
		runsMerge && `a merge runs: ${runsMerge.id}`,
	].filter((h): h is string => Boolean(h));
}

/** The queued branch: OK with the hold notes when a hold explains the wait, check
 * when none does. */
function queuedVerdict(c: Card, f: Facts): Verdict {
	const holds = queuedHolds(c, f);
	return holds.length > 0
		? { verdict: "OK", note: holds.join("; ") }
		: { verdict: "check", note: "queued with no hold found" };
}

export function verdict(c: Card, f: Facts): { verdict: string; note: string } {
	const r = c.needsReason ?? "";
	if (c.state === "needs_you") return needsYouVerdict(c, r);
	if (runsOrPrepares(c)) return runningVerdict(f.logAgeS);
	if (c.state === "queued") return queuedVerdict(c, f);
	if (
		c.stage === "merging" &&
		c.state === "idle" &&
		FINDINGS.test(r + (f.hold ?? ""))
	)
		return { verdict: "OK", note: "release waits for its findings" };
	if (c.stage === "in_progress" && c.state === "idle" && PR_POSTED.test(r))
		return {
			verdict: "waits",
			note: "posted PR review; waits for the pull request to merge or close",
		};
	if (c.stage === "backlog" && c.state === "idle")
		return { verdict: "OK", note: "backlog" };
	return { verdict: "stuck", note: `state ${c.stage}/${c.state}` };
}

/** The dynamic import is the point: the specifier is runtime-selected — the server image
 * mounts the app at /app, a checkout resolves the repo root relative to this file (and a
 * `bun - < script` stdin run has no file URL to resolve against). A static import can only
 * name one of the two layouts. */
export const SCHEDULER_CANDIDATES: string[] = [
	"/app/src/scheduler.ts",
	new URL("../../../../src/scheduler.ts", import.meta.url).href,
];

/** mergeHold's shape (src/scheduler.ts); the cards here are the report's loose Card view. */
export type MergeHold = (
	tasks: Card[],
	merge: {
		id: string;
		stage: string;
		state: string;
		pushRetries?: number;
		pendingBy?: string | null;
	},
) => string | null;

/** Loads mergeHold from the first candidate that imports; null with the collected errors
 * when none does — report() prints the errors and renders the rest without merge holds. */
export async function resolveMergeHold(
	candidates: readonly string[],
): Promise<{ mergeHold: MergeHold | null; error: string }> {
	const errors: string[] = [];
	for (const c of candidates) {
		try {
			const mod = (await import(c)) as { mergeHold?: unknown };
			if (typeof mod.mergeHold === "function")
				return { mergeHold: mod.mergeHold as MergeHold, error: "" };
			errors.push(`${c}: no mergeHold export`);
		} catch (e) {
			errors.push(`${c}: ${String(e).slice(0, 120)}`);
		}
	}
	return { mergeHold: null, error: errors.join("; ") };
}

const ORDER: Record<string, number> = {
	stuck: 0,
	check: 1,
	question: 2,
	decision: 3,
	waits: 4,
	OK: 5,
};

const cell = (x: string) =>
	x.replaceAll("|", "/").replaceAll("\n", " ").slice(0, 140);

/** One report table row before rendering: the card and its verdict. */
type Row = { c: Card; v: Verdict };

/** The table's sort: verdict order (ORDER, unknown verdicts as OK), then card id. */
const byVerdictThenId = (a: Row, b: Row) =>
	(ORDER[a.v.verdict] ?? 5) - (ORDER[b.v.verdict] ?? 5) ||
	a.c.id.localeCompare(b.c.id);

/** The card's log age in seconds, null when the card has no log file yet. */
function logAgeSeconds(c: Card, now: number): number | null {
	const log = `/data/${c.project}/logs/${c.id}.log`;
	return existsSync(log)
		? Math.round((now - statSync(log).mtimeMs) / 1000)
		: null;
}

/** mergeHold's hold for the merging card c, null for other cards or when mergeHold
 * answers null, an error note in place of the hold when mergeHold throws. */
function mergeHoldFor(
	c: Card,
	tasks: Card[],
	mergeHold: MergeHold | null,
): string | null {
	if (mergeHold === null || c.stage !== "merging") return null;
	const sameProject = tasks.filter((t) => t.project === c.project);
	try {
		return mergeHold(sameProject, c);
	} catch (e) {
		return `hold unknown: ${String(e).slice(0, 80)}`;
	}
}

/** The card's dependencies that are neither done nor cancelled, unknown ids included. */
function openDeps(c: Card, byId: Map<string, Card>): string[] {
	return (c.dependsOn ?? []).filter((d) => {
		const t = byId.get(d);
		return t === undefined || (t.stage !== "done" && t.cancelledAt === null);
	});
}

/** One numbered asked question, options rendered as [a | b] with the recommended
 * one starred. */
function askedLine(q: Asked, i: number): string {
	const options = q.options?.length
		? ` [${q.options
				.map((o, j) => (j === q.recommended ? "*" : "") + (o.label ?? ""))
				.join(" | ")}]`
		: "";
	return `${i + 1}. ${q.question}${options}`;
}

/** The checkout line for one project: gitless note, git failure, or branch status. */
function checkoutLine(p: Project): string {
	if (p.gitless) return `- ${p.name}: gitless`;
	const r = Bun.spawnSync([
		"git",
		"-C",
		p.path,
		"status",
		"--porcelain",
		"--branch",
	]);
	if (r.exitCode !== 0)
		return `- ${p.name}: git status failed: ${r.stderr.toString().trim().slice(0, 120)}`;
	const [head, ...files] = r.stdout.toString().trim().split("\n");
	if (head === undefined) return `- ${p.name}: clean`;
	const flag = AHEAD.test(head)
		? " **ahead: check for a failed server push (skill step 4)**"
		: "";
	return `- ${p.name}: ${head}${files.length > 0 ? ` DIRTY: ${files.join(" ; ")}` : " clean"}${flag}`;
}

export async function report(s: BoardState, now: number): Promise<string> {
	const open = s.tasks.filter(
		(t) =>
			t.cancelledAt === null && t.stage !== "done" && t.stage !== "backlog",
	);
	const byId = new Map(s.tasks.map((t) => [t.id, t]));
	const { mergeHold, error } = await resolveMergeHold(SCHEDULER_CANDIDATES);
	const running = open.filter(runsOrPrepares).length;
	const drain = s.drainUntil !== null && s.drainUntil > now;
	const out: string[] = [];
	out.push(
		`Board at ${new Date(now).toISOString()}: ${open.length} open, ${running} running, maxTotal ${s.maxTotal}, drain ${drain ? new Date(s.drainUntil ?? 0).toISOString() : "none"}.`,
	);
	if (mergeHold === null)
		out.push(
			`WARNING: merge holds unknown (scheduler import failed: ${error.slice(0, 120)})`,
		);
	out.push(
		"",
		"| Card | Stage/state | Verdict | Note | Reason |",
		"|---|---|---|---|---|",
	);
	const questions: string[] = [];
	const rows = open
		.map((c) => {
			const v = verdict(c, {
				now,
				logAgeS: logAgeSeconds(c, now),
				hold: mergeHoldFor(c, s.tasks, mergeHold),
				depsOpen: openDeps(c, byId),
				drain,
				capFull: s.maxTotal !== null && running >= s.maxTotal,
				cards: s.tasks,
			});
			if (v.verdict === "question")
				questions.push(
					`### ${c.project}/${c.id}: ${(c.title ?? "").slice(0, 90)}`,
					...(c.asked ?? []).map(askedLine),
				);
			return { c, v };
		})
		.sort(byVerdictThenId);
	for (const { c, v } of rows)
		out.push(
			`| ${c.project}/${c.id} ${cell((c.title ?? "").slice(0, 50))} | ${c.stage}/${c.state} | ${v.verdict} | ${cell(v.note)} | ${cell(c.needsReason ?? "")} |`,
		);
	out.push("", "## Main checkouts");
	for (const p of s.projects) out.push(checkoutLine(p));
	if (questions.length > 0) out.push("", "## Questions", ...questions);
	return out.join("\n");
}

async function main() {
	const port =
		process.env.PORT ??
		(process.env.OTTR_BOARD_URL !== undefined
			? new URL(process.env.OTTR_BOARD_URL).port
			: undefined);
	if (port === undefined || port === "")
		throw new Error("no board to ask: set PORT or OTTR_BOARD_URL");
	const res = await fetch(`http://127.0.0.1:${port}/api/state`);
	if (!res.ok) throw new Error(`GET /api/state answered ${res.status}`);
	const s = (await res.json()) as BoardState;
	console.log(await report(s, Date.now()));
}

if (import.meta.main) await main();
