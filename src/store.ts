import type { Dirent } from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { mkdirBelow, writeBelow } from "./confine.ts";
import {
	closeLocked,
	openLocked,
	StoreLockedError,
	vacuumInto,
} from "./dblock.ts";
import type { PerfFacts } from "./perf.ts";
import { platform } from "./platform/index.ts";
import { derivedTaskPrefix } from "./prefix.ts";
import {
	ARCH_REVIEW_MARKER,
	FORK_PROPOSED_REASON_PREFIX,
	forkProposedReason,
	LEGACY_FORK_PROPOSED_REASON_PREFIX,
	LEGACY_PROPOSED_REASON_PREFIX,
	PROPOSED_REASON_PREFIX,
	proposedReason,
	RETRO_MARKER,
	RULES_INTERVIEW_MARKER,
	shortTitle,
} from "./prompts.ts";
import { sumUsageIn, type UsageSum } from "./retro.ts";
import { queueOrder } from "./scheduler.ts";
import {
	cleanTitle,
	firstSessionTitle,
	firstWorkTitle,
	readTranscript,
	sessionContext,
} from "./session.ts";
import { type SQLiteDatabase, sqliteNumber } from "./sqliteDriver.ts";
import { StoreQueue } from "./storeQueue.ts";
import { assignTopics } from "./topics.ts";
import type {
	AskQuestion,
	DiffFileStat,
	ForkBranchState,
	ForkHoldState,
	GateAssumption,
	ListedTask,
	OutcomeStatus,
	ProjectSettings,
	PromptGateState,
	ProposalSummary,
	PrReviewRow,
	PrState,
	RecordedFinding,
	RunState,
	Stage,
	Task,
	TaskKind,
	TrendingVerdict,
	TrendingVerdictKind,
	Turn,
	TurnKind,
	WorkCheckBlocker,
	WorkCheckRun,
} from "./types.ts";
import { askQuestions, PR_REVIEW_WAITING } from "./types.ts";

export const DEFAULT_SETTINGS: ProjectSettings = {
	// No per-project cap: the board-wide runner cap is the one limit by default.
	maxParallel: null,
	copyExtra: [],
	displayName: null,
	iconText: null,
	releaseCommand: null,
	archReviewCap: 150,
	maxImages: 8,
	keptWorktreeDays: 7,
	autoTend: false,
	autoTendLimit: 12,
	tendChurnGlobs: [],
	holdUpdateMerges: false,
	forkMergeHold: true,
	retroSince: null,
	retroFilter: true,
	forkResearch: false,
	trendingScout: false,
	prReviews: false,
	prReviewNotify: true,
	prReviewApprove: false,
	prMode: false,
	issueWatch: false,
	issueWatchSince: null,
	ompWatch: false,
	microVm: false,
	setupChecklist: false,
	targetBranch: null,
	originUrl: null,
	pushSyncCommits: false,
	taskIdPrefix: null,
	jiraConnection: null,
	jiraLastJql: null,
};

/** The tasks table DDL, kept separate so the CHECK migration below reuses the exact shape. */
const TASKS_DDL = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT,
  prompt TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('todo','in_progress','merging','done','backlog')),
  state TEXT NOT NULL CHECK (state IN ('queued','preparing','running','needs_you','idle')),
  needs_reason TEXT,
  pending_prompt TEXT,
  branch TEXT,
  base TEXT,
  worktree TEXT,
  session_id TEXT,
  summary TEXT,
  details TEXT,
  report TEXT,
  research INTEGER NOT NULL DEFAULT 0,
  research_steps TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  queued_at INTEGER,
  cancelled_at INTEGER,
  images TEXT NOT NULL DEFAULT '[]',
  pending_images TEXT NOT NULL DEFAULT '[]',
  shots TEXT NOT NULL DEFAULT '[]',
  release_version TEXT,
  release_notes TEXT,
  session_title TEXT,
  asked TEXT,
  gate TEXT,
  prompt_author TEXT NOT NULL DEFAULT 'user',
  model TEXT,
  kept_files TEXT NOT NULL DEFAULT '[]',
  follow_up_of TEXT,
  push_sha TEXT,
  update_ids TEXT NOT NULL DEFAULT '[]',
  update_merge_approved INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1
)`;
/** The pr_review_runs table DDL, kept separate so the shape migration below reuses the exact shape. */
const PR_REVIEW_RUNS_DDL = `CREATE TABLE IF NOT EXISTS pr_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  head TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  blocking INTEGER NOT NULL DEFAULT 1
)`;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
${TASKS_DDL};
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work','merge')),
  prompt TEXT NOT NULL,
  input TEXT,
  input_by TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  pid INTEGER,
  exit_code INTEGER,
  outcome TEXT,
  summary TEXT,
  details TEXT,
  question TEXT,
  error TEXT,
  model TEXT,
  -- The --model selector the run was dispatched with, stored only when the run served a
  -- different model (the provider-error fallback); null when dispatch and served agree.
  dispatched_model TEXT,
  layer TEXT,
  ran_on TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  cost REAL,
  log_offset INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns_task_id ON turns (task_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('create','stage','state','error')),
  from_value TEXT,
  to_value TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events (task_id);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at);
CREATE TABLE IF NOT EXISTS fork_branch (
  fork_id INTEGER NOT NULL,
  branch_hash TEXT NOT NULL,
  branch TEXT NOT NULL,
  head TEXT,
  analyzed_head TEXT,
  first_pending_at INTEGER,
  last_run_at INTEGER,
  last_error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  hold_prs TEXT,
  hold_base TEXT,
  PRIMARY KEY (fork_id, branch_hash)
);
CREATE TABLE IF NOT EXISTS fork_runs (
  started_at INTEGER NOT NULL,
  fork_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fork_runs_at ON fork_runs (started_at);
CREATE TABLE IF NOT EXISTS fork_hold (
  fork_id INTEGER NOT NULL,
  branch_hash TEXT NOT NULL,
  sha TEXT NOT NULL,
  pr INTEGER NOT NULL,
  pr_head TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0,1)),
  PRIMARY KEY (fork_id, branch_hash, sha)
);
CREATE TABLE IF NOT EXISTS pr_review (
  number INTEGER PRIMARY KEY,
  task_id TEXT,
  head TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  reviewed_head TEXT,
  posted_head TEXT,
  posted_url TEXT,
  posted_login TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
  draft INTEGER NOT NULL,
  title TEXT NOT NULL,
  post_error TEXT,
  comments_at INTEGER,
  comments_unseen INTEGER NOT NULL DEFAULT 0
);
${PR_REVIEW_RUNS_DDL};
CREATE INDEX IF NOT EXISTS idx_pr_review_runs_at ON pr_review_runs (started_at);
CREATE TABLE IF NOT EXISTS trending_verdict (
  repo TEXT PRIMARY KEY,
  verdict TEXT NOT NULL CHECK (verdict IN ('filed','no_fit','deferred')),
  reason TEXT NOT NULL,
  rejected_by_user INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  judged_at INTEGER NOT NULL,
  scout_card_id TEXT,
  proposal_card_id TEXT
);
CREATE TABLE IF NOT EXISTS issue_watch (
  number INTEGER PRIMARY KEY,
  task_id TEXT,
  labelled INTEGER NOT NULL DEFAULT 0,
  filed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_watch_filed_at ON issue_watch (filed_at);
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  rank INTEGER,
  security TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(card_id, prompt)
);
CREATE TABLE IF NOT EXISTS jira_imports (
  site TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  filed_at INTEGER NOT NULL,
  PRIMARY KEY (site, issue_key)
);
-- Retired and unused: review conventions live in the project's AGENTS.md.
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  glob TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  from_task_id TEXT,
  created_at INTEGER NOT NULL
);
`;

interface TaskRow {
	id: string;
	title: string | null;
	prompt: string | null;
	stage: string;
	state: string;
	needs_reason: string | null;
	pending_prompt: string | null;
	pending_by: string | null;
	push_retries: number;
	branch: string | null;
	base: string | null;
	worktree: string | null;
	session_id: string | null;
	summary: string | null;
	details: string | null;
	report: string | null;
	research: number;
	research_steps: string;
	starred: number;
	created_at: number;
	updated_at: number;
	revision: number;
	queued_at: number | null;
	done_at: number | null;
	cancelled_at: number | null;
	commits: number | null;
	merge_head: string | null;
	images: string;
	pending_images: string;
	shots: string;
	release_version: string | null;
	release_notes: string | null;
	asked: string | null;
	gate: string | null;
	prompt_author: string;
	model: string | null;
	kept_files: string;
	follow_up_of: string | null;
	follow_up_of_project: string | null;
	push_sha: string | null;
	pr_number: number | null;
	pr_url: string | null;
	pr_head_sha: string | null;
	pr_watch_at: number | null;
	pending_feedback: number;
	source_pr_number: number | null;
	source_pr_url: string | null;
	source_pr_head_ref: string | null;
	source_pr_head_sha: string | null;
	source_pr_cross_repo: number;
	source_pr_dependabot: number;
	follow_up_pr_number: number | null;
	follow_up_pr_url: string | null;
	topic: string | null;
	depends_on: string;
	update_ids: string;
	update_merge_head: string | null;
	fork_merge_head: string | null;
	hold_head: string | null;
	diff_files: string | null;
	diff_text: string | null;
	uncommitted_files: string;
	work_check_log: string;
	work_check_sendbacks: number;
	work_check_head: string | null;
	work_check_report: string | null;
	priority: string | null;
	close_candidate: string | null;
	hold_until: number | null;
	hold_provider: string | null;
	hold_window: string | null;
	hold_attempts: number;
	hold_set_at: number | null;
	proposal_summary: string | null;
	findings_checked_at: number | null;
	kind: string;
}

/** One fork_branch row. */
interface ForkBranchRow {
	fork_id: number;
	branch_hash: string;
	branch: string;
	head: string | null;
	analyzed_head: string | null;
	first_pending_at: number | null;
	last_run_at: number | null;
	last_error: string | null;
	retries: number;
	// Retired cursor-hold columns, superseded by fork_hold; read once by the open
	// migration, then cleared. Never written again.
	hold_prs: string | null;
	hold_base: string | null;
}

/** Legacy hold list: a JSON array of `{ n, head }` entries; anything else reads as none.
 * The per-commit model replaced the cursor hold; this parser only feeds the one-time
 * migration in ProjectStore.open. */
function parseHoldPrs(
	s: string | null,
): Array<{ n: number; head: string }> | null {
	if (s === null) return null;
	try {
		const v: unknown = JSON.parse(s);
		if (!Array.isArray(v)) return null;
		const out: Array<{ n: number; head: string }> = [];
		for (const e of v) {
			if (typeof e !== "object" || e === null) continue;
			const { n, head } = e as Record<string, unknown>;
			if (
				typeof n === "number" &&
				Number.isInteger(n) &&
				n > 0 &&
				typeof head === "string"
			)
				out.push({ n, head });
		}
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

function toForkBranch(r: ForkBranchRow): ForkBranchState {
	return {
		forkId: r.fork_id,
		branchHash: r.branch_hash,
		branch: r.branch,
		head: r.head,
		analyzedHead: r.analyzed_head,
		firstPendingAt: r.first_pending_at,
		lastRunAt: r.last_run_at,
		lastError: r.last_error,
		retries: r.retries,
	};
}

/** One fork_hold row: a held commit with the PR and head it was judged against. */
interface ForkHoldRow {
	fork_id: number;
	branch_hash: string;
	sha: string;
	pr: number;
	pr_head: string;
	released: number;
}

function toForkHold(r: ForkHoldRow): ForkHoldState {
	return {
		forkId: r.fork_id,
		branchHash: r.branch_hash,
		sha: r.sha,
		pr: r.pr,
		prHead: r.pr_head,
		released: r.released,
	};
}

/** One pr_review row. */
interface PrReviewDbRow {
	number: number;
	task_id: string | null;
	head: string;
	first_seen_at: number;
	reviewed_head: string | null;
	posted_head: string | null;
	posted_url: string | null;
	posted_login: string | null;
	state: string;
	draft: number;
	title: string;
	post_error: string | null;
	comments_at: number | null;
	comments_unseen: number;
}

function toPrReview(r: PrReviewDbRow): PrReviewRow {
	return {
		number: r.number,
		taskId: r.task_id,
		head: r.head,
		firstSeenAt: r.first_seen_at,
		reviewedHead: r.reviewed_head,
		postedHead: r.posted_head,
		postedUrl: r.posted_url,
		postedLogin: r.posted_login,
		state: r.state as PrState,
		draft: r.draft !== 0,
		title: r.title,
		postError: r.post_error,
		commentsAt: r.comments_at,
		commentsUnseen: r.comments_unseen !== 0,
	};
}

interface TurnRow {
	id: number;
	task_id: string;
	kind: string;
	prompt: string;
	input: string | null;
	input_by: string | null;
	started_at: number;
	ended_at: number | null;
	pid: number | null;
	exit_code: number | null;
	outcome: string | null;
	summary: string | null;
	details: string | null;
	question: string | null;
	error: string | null;
	model: string | null;
	dispatched_model: string | null;
	layer: string | null;
	ran_on: string | null;
	log_offset: number | null;
}

function toListedTask(
	project: string,
	r: Omit<TaskRow, "diff_text">,
): ListedTask {
	return {
		id: r.id,
		project,
		title: r.title ?? "",
		prompt: r.prompt ?? "",
		stage: r.stage as Stage,
		state: r.state as RunState,
		needsReason: r.needs_reason,
		pendingPrompt: r.pending_prompt,
		pendingBy: r.pending_by as "user" | "supervisor" | null,
		pushRetries: r.push_retries,
		branch: r.branch,
		base: r.base,
		worktree: r.worktree,
		sessionId: r.session_id,
		summary: r.summary,
		details: r.details,
		report: r.report,
		research: r.research === 1,
		steps:
			r.research_steps === "yes"
				? "yes"
				: r.research_steps === "no"
					? "no"
					: "unknown",
		starred: r.starred === 1,
		mergeHead: r.merge_head,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		revision: r.revision,
		queuedAt: r.queued_at,
		doneAt: r.done_at,
		cancelledAt: r.cancelled_at,
		commits: r.commits,
		images: parseStringList(r.images),
		pendingImages: parseStringList(r.pending_images),
		shots: parseStringList(r.shots),
		releaseVersion: r.release_version,
		releaseNotes: r.release_notes,
		asked: parseAsked(r.asked),
		gate: parseGate(r.gate),
		promptAuthor: r.prompt_author === "board" ? "board" : "user",
		model: r.model,
		keptFiles: parseStringList(r.kept_files),
		followUpOf: r.follow_up_of,
		followUpOfProject: r.follow_up_of_project,
		pushSha: r.push_sha,
		prNumber: r.pr_number,
		prUrl: r.pr_url,
		prHeadSha: r.pr_head_sha,
		prWatchAt: r.pr_watch_at,
		pendingFeedback: r.pending_feedback === 1,
		sourcePrNumber: r.source_pr_number,
		sourcePrUrl: r.source_pr_url,
		sourcePrHeadRef: r.source_pr_head_ref,
		sourcePrHeadSha: r.source_pr_head_sha,
		sourcePrCrossRepo: r.source_pr_cross_repo === 1,
		sourcePrDependabot: r.source_pr_dependabot === 1,
		followUpPrNumber: r.follow_up_pr_number,
		followUpPrUrl: r.follow_up_pr_url,
		topic: r.topic,
		dependsOn: parseStringList(r.depends_on),
		updateIds: parseStringList(r.update_ids),
		updateMergeHead: r.update_merge_head,
		forkMergeHead: r.fork_merge_head,
		holdHead: r.hold_head,
		diffFiles: parseDiffFiles(r.diff_files),
		uncommittedFiles: parseStringList(r.uncommitted_files),
		workCheckLog: parseWorkCheckLog(r.work_check_log),
		workCheckSendbacks: r.work_check_sendbacks,
		workCheckHead: r.work_check_head,
		workCheckReport: r.work_check_report,
		priority: (r.priority as Task["priority"]) ?? null,
		closeCandidate: r.close_candidate,
		kind: r.kind as TaskKind,
		holdUntil: r.hold_until,
		holdProvider: r.hold_provider,
		holdWindow: r.hold_window,
		holdAttempts: r.hold_attempts,
		holdSetAt: r.hold_set_at,
		proposalSummary: parseProposalSummary(r.proposal_summary),
		findingsCheckedAt: r.findings_checked_at,
	};
}

function toTask(project: string, r: TaskRow): Task {
	return { ...toListedTask(project, r), diffText: r.diff_text };
}

/** One parsed diffstat entry, or null when the entry is wrong-shaped. */
function diffFileStat(entry: unknown): DiffFileStat | null {
	if (typeof entry !== "object" || entry === null) return null;
	const { file, plus, minus } = entry as Record<string, unknown>;
	if (typeof file !== "string") return null;
	if (plus !== null && typeof plus !== "number") return null;
	if (minus !== null && typeof minus !== "number") return null;
	return {
		file,
		plus: typeof plus === "number" ? plus : null,
		minus: typeof minus === "number" ? minus : null,
	};
}

/** Parses the stored diffstat JSON; null when absent. A wrong-shaped entry drops the whole list:
 * a half-valid stat list would understate the card's diff. */
function parseDiffFiles(raw: string | null): DiffFileStat[] | null {
	if (raw === null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return null;
		const files: DiffFileStat[] = [];
		for (const entry of value) {
			const stat = diffFileStat(entry);
			if (stat === null) return null;
			files.push(stat);
		}
		return files;
	} catch {
		return null;
	}
}

/** Parses the stored proposal-summary JSON; null when absent. A wrong-shaped entry drops the
 * whole summary: the drawer's decision panel needs all five fields to render. Never throws. */
function parseProposalSummary(raw: string | null): ProposalSummary | null {
	if (raw === null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return null;
		const { whatChanges, why, gain, risk, check } = value as Record<
			string,
			unknown
		>;
		if (
			typeof whatChanges !== "string" ||
			!whatChanges ||
			typeof why !== "string" ||
			!why ||
			typeof gain !== "string" ||
			!gain ||
			typeof risk !== "string" ||
			!risk ||
			typeof check !== "string" ||
			!check
		)
			return null;
		return { whatChanges, why, gain, risk, check };
	} catch {
		return null;
	}
}

/** Parses the stored ask JSON via the shared normalizer; invalid or absent -> null. */
function parseAsked(raw: string | null): AskQuestion[] | null {
	if (raw === null) return null;
	try {
		return askQuestions({ questions: JSON.parse(raw) });
	} catch {
		return null;
	}
}

/** Parses the stored gate JSON (OTTR-823); invalid or absent -> null. */
function parseGate(raw: string | null): PromptGateState | null {
	if (raw === null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return null;
		const g = value as Partial<PromptGateState>;
		const state: PromptGateState = {
			hash: typeof g.hash === "string" ? g.hash : null,
			seen: typeof g.seen === "string" ? g.seen : null,
			fails: typeof g.fails === "number" ? g.fails : 0,
			sig: typeof g.sig === "string" ? g.sig : null,
			parked: g.parked === true,
		};
		// OTTR-904: the gate's assumptions and adopted check ride through when they parse.
		if (Array.isArray(g.assumptions))
			state.assumptions = g.assumptions.filter(
				(a): a is GateAssumption =>
					typeof a === "object" &&
					a !== null &&
					typeof a.question === "string" &&
					typeof a.answer === "string",
			);
		if (typeof g.check === "string" && g.check !== "") state.check = g.check;
		return state;
	} catch {
		return null;
	}
}

function parseStringList(raw: string): string[] {
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return [];
		return value.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

/** One parsed blocker, or null when the entry is wrong-shaped (it drops alone). */
function parseWorkCheckBlocker(b: unknown): WorkCheckBlocker | null {
	if (typeof b !== "object" || b === null) return null;
	const blocker = b as Record<string, unknown>;
	if (typeof blocker.finding !== "string") return null;
	return {
		finding: blocker.finding,
		quote: typeof blocker.quote === "string" ? blocker.quote : "",
		severity:
			blocker.severity === "important" ||
			blocker.severity === "nit" ||
			blocker.severity === "pre-existing"
				? blocker.severity
				: undefined,
		bugClass:
			typeof blocker.bugClass === "string" ? blocker.bugClass : undefined,
		status:
			blocker.status === "fixed" || blocker.status === "overridden"
				? blocker.status
				: undefined,
		statusReason:
			typeof blocker.statusReason === "string"
				? blocker.statusReason
				: undefined,
	};
}

/** One parsed work-check run, or null when the entry is wrong-shaped (it drops alone). */
function parseWorkCheckRun(r: unknown): WorkCheckRun | null {
	if (typeof r !== "object" || r === null) return null;
	const e = r as Record<string, unknown>;
	if (
		typeof e.at !== "number" ||
		(e.outcome !== "pass" &&
			e.outcome !== "blockers" &&
			e.outcome !== "error") ||
		!Array.isArray(e.blockers) ||
		!Array.isArray(e.notes)
	)
		return null;
	const blockers: WorkCheckBlocker[] = [];
	for (const b of e.blockers) {
		const blocker = parseWorkCheckBlocker(b);
		if (blocker !== null) blockers.push(blocker);
	}
	return {
		at: e.at,
		model: typeof e.model === "string" ? e.model : null,
		role: e.role === "critic" || e.role === "adversary" ? e.role : undefined,
		outcome: e.outcome,
		blockers,
		notes: e.notes.filter((n): n is string => typeof n === "string"),
		durationMs: typeof e.durationMs === "number" ? e.durationMs : 0,
		error: typeof e.error === "string" ? e.error : undefined,
		warn: typeof e.warn === "string" ? e.warn : undefined,
		direction: typeof e.direction === "string" ? e.direction : undefined,
	};
}

/** Parses the stored work-check log; a wrong-shaped run or blocker drops that entry only, so
 * one corrupt run never erases the history the card shows. */
function parseWorkCheckLog(raw: string): WorkCheckRun[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const runs: WorkCheckRun[] = [];
	for (const entry of value) {
		const run = parseWorkCheckRun(entry);
		if (run !== null) runs.push(run);
	}
	return runs.slice(-20);
}

function toTurn(r: TurnRow): Turn {
	return {
		id: r.id,
		taskId: r.task_id,
		kind: r.kind as TurnKind,
		prompt: r.prompt,
		input: r.input,
		inputBy: r.input_by as "user" | "supervisor" | null,
		startedAt: r.started_at,
		endedAt: r.ended_at,
		pid: r.pid,
		exitCode: r.exit_code,
		outcome: r.outcome as OutcomeStatus | null,
		summary: r.summary,
		details: r.details,
		question: r.question,
		error: r.error,
		model: r.model,
		dispatchedModel: r.dispatched_model,
		layer: r.layer,
		ranOn: r.ran_on,
		logOffset: r.log_offset,
	};
}

// Column names for dynamic UPDATEs are this hardcoded whitelist only — values always bind via `?`.
// Keyed by the patch fields (R4-8): a new Task/Turn field extends TaskPatch/TurnPatch, so a
// missing column mapping here is a compile error instead of a silently dropped write.
/** Result of a revision-guarded write: ok carries the written task, a conflict
 * carries the row as it stands now (the route answers 409 with it). */
export type RevisionResult =
	| { ok: true; task: Task }
	| { ok: false; task: Task };

export type TaskPatch = Partial<
	// kind stays out of TaskPatch: it is set once by createTask and never patched.
	// revision stays out too: it moves only inside the UPDATE (optimistic-lock counter).
	Omit<
		Task,
		| "id"
		| "project"
		| "createdAt"
		| "updatedAt"
		| "doneAt"
		| "kind"
		| "revision"
	>
>;
export type TurnPatch = Partial<
	Omit<Turn, "id" | "taskId" | "kind" | "prompt" | "startedAt">
>;
const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
	title: "title",
	prompt: "prompt",
	stage: "stage",
	state: "state",
	needsReason: "needs_reason",
	pendingPrompt: "pending_prompt",
	pendingBy: "pending_by",
	pushRetries: "push_retries",
	branch: "branch",
	base: "base",
	worktree: "worktree",
	sessionId: "session_id",
	summary: "summary",
	details: "details",
	report: "report",
	research: "research",
	steps: "research_steps",
	starred: "starred",
	mergeHead: "merge_head",
	queuedAt: "queued_at",
	cancelledAt: "cancelled_at",
	commits: "commits",
	images: "images",
	pendingImages: "pending_images",
	shots: "shots",
	releaseVersion: "release_version",
	releaseNotes: "release_notes",
	asked: "asked",
	gate: "gate",
	promptAuthor: "prompt_author",
	model: "model",
	keptFiles: "kept_files",
	followUpOf: "follow_up_of",
	followUpOfProject: "follow_up_of_project",
	pushSha: "push_sha",
	prNumber: "pr_number",
	prUrl: "pr_url",
	prHeadSha: "pr_head_sha",
	prWatchAt: "pr_watch_at",
	pendingFeedback: "pending_feedback",
	sourcePrNumber: "source_pr_number",
	sourcePrUrl: "source_pr_url",
	sourcePrHeadRef: "source_pr_head_ref",
	sourcePrHeadSha: "source_pr_head_sha",
	sourcePrCrossRepo: "source_pr_cross_repo",
	sourcePrDependabot: "source_pr_dependabot",
	followUpPrNumber: "follow_up_pr_number",
	followUpPrUrl: "follow_up_pr_url",
	topic: "topic",
	dependsOn: "depends_on",
	updateIds: "update_ids",
	updateMergeHead: "update_merge_head",
	forkMergeHead: "fork_merge_head",
	holdHead: "hold_head",
	diffFiles: "diff_files",
	diffText: "diff_text",
	uncommittedFiles: "uncommitted_files",
	workCheckLog: "work_check_log",
	workCheckSendbacks: "work_check_sendbacks",
	workCheckHead: "work_check_head",
	workCheckReport: "work_check_report",
	priority: "priority",
	closeCandidate: "close_candidate",
	holdUntil: "hold_until",
	holdProvider: "hold_provider",
	holdWindow: "hold_window",
	holdAttempts: "hold_attempts",
	holdSetAt: "hold_set_at",
	proposalSummary: "proposal_summary",
	findingsCheckedAt: "findings_checked_at",
};

// listTasks reads every column but the raw diff (up to 200 KB per card): the board, the
// scheduler pass and every other list caller never read it. Derived from TASK_COLUMNS, so a
// new Task field (a compile error there until mapped) joins the list read automatically.
const TASK_LIST_COLUMNS = [
	"id",
	"created_at",
	"updated_at",
	"done_at",
	"kind",
	// revision is not in TASK_COLUMNS (never caller-settable), so the board still gets it
	// on list rows and can send it back with guarded edits.
	"revision",
	...Object.values(TASK_COLUMNS).filter((c) => c !== "diff_text"),
].join(", ");

const TURN_COLUMNS: Record<keyof TurnPatch, string> = {
	endedAt: "ended_at",
	pid: "pid",
	exitCode: "exit_code",
	outcome: "outcome",
	summary: "summary",
	details: "details",
	question: "question",
	error: "error",
	model: "model",
	dispatchedModel: "dispatched_model",
	input: "input",
	inputBy: "input_by",
	layer: "layer",
	ranOn: "ran_on",
	logOffset: "log_offset",
};

/**
 * A project's task data dir (logs, sessions, images, handoffs, quarantine, release notes):
 * `<project>/.tasks`, or `$OTTR_DATA_DIR/<folder name>` when the board keeps its state
 * outside the checkouts (compose: one volume the server and the workers mount at the
 * same path). tasks.db lives here only when OTTR_SERVER_DATA_DIR is unset (serverDirFor).
 * ponytail: keyed by folder name, which the board already uses as the
 * project id; renaming a project folder under OTTR_DATA_DIR needs its data dir renamed too.
 */
export function tasksDirFor(projectPath: string): string {
	const dataDir = process.env.OTTR_DATA_DIR;
	return dataDir
		? join(resolve(dataDir), basename(projectPath))
		: join(projectPath, ".tasks");
}

/**
 * The dir of the state the server trusts (tasks.db: settings incl. the releaseCommand it
 * runs, worktree paths; the fork mirror cache). Workers mount OTTR_DATA_DIR read-write, so
 * this state must not live there: `$OTTR_SERVER_DATA_DIR/<folder name>` on a volume only the
 * server mounts. Unset (native start, tests): the tasks dir, as before.
 */
function serverDirFor(projectPath: string): string {
	const serverDataDir = process.env.OTTR_SERVER_DATA_DIR;
	return serverDataDir
		? join(resolve(serverDataDir), basename(projectPath))
		: tasksDirFor(projectPath);
}

export type AdoptResult = {
	name: string;
	status: "adopted" | "failed";
	error?: string;
};

/** Adopts one old per-task DB into the server dir; null when the dir holds no adoptable
 * tasks.db or the server already has one. A StoreLockedError (a live board holds the DB)
 * propagates; any other failure comes back as a failed AdoptResult. */
async function adoptOne(
	oldDir: string,
	name: string,
	newDir: string,
): Promise<AdoptResult | null> {
	const oldDb = join(oldDir, "tasks.db");
	try {
		if (!lstatSync(oldDir).isDirectory()) return null;
		if (!lstatSync(oldDb).isFile()) return null;
	} catch {
		return null; // no tasks.db in this dir
	}
	const newDb = join(newDir, "tasks.db");
	if (existsSync(newDb)) return null;
	let db: SQLiteDatabase;
	try {
		db = await openLocked(oldDb);
	} catch (err) {
		if (err instanceof StoreLockedError) throw err;
		return {
			name,
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
	let open = true;
	try {
		mkdirSync(newDir, { recursive: true });
		const tmp = join(newDir, "tasks.db.adopting");
		rmSync(tmp, { force: true });
		await vacuumInto(db, tmp, ["tasks", "turns"]);
		renameSync(tmp, newDb);
		open = false;
		await closeLocked(db);
		renameSync(oldDb, join(oldDir, "tasks.db.moved-to-server"));
		return { name, status: "adopted" };
	} catch (err) {
		if (open) await closeLocked(db);
		return {
			name,
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** The adoption marker's file name below OTTR_SERVER_DATA_DIR; the restore tool writes it too. */
export const ADOPTED_MARKER = ".adopted";

/**
 * One-time move of the task DBs that older boards kept on the worker-shared data dir into
 * the server-only dir. The marker makes it one-time: a tasks.db a worker plants later is
 * never adopted. A StoreLockedError (a live board holds the DB) goes up to stop the boot.
 */
export async function adoptSharedProjectData(
	dataDir: string,
	serverDataDir: string,
): Promise<AdoptResult[]> {
	const marker = join(serverDataDir, ADOPTED_MARKER);
	if (existsSync(marker)) return [];
	const results: AdoptResult[] = [];
	const names = existsSync(dataDir) ? readdirSync(dataDir) : [];
	for (const name of names) {
		const result = await adoptOne(
			join(dataDir, name),
			name,
			join(serverDataDir, name),
		);
		if (result !== null) results.push(result);
	}
	mkdirSync(serverDataDir, { recursive: true });
	writeFileSync(marker, `${new Date().toISOString()}\n`);
	return results;
}

/**
 * The trusted root above a project's task data dir: `$OTTR_DATA_DIR` (a mount point no
 * worker can replace), or the project checkout. Server writes below it go through
 * src/confine.ts, so a symlink a worker plants under it is never followed (OTTR-172).
 */
function dataRootFor(projectPath: string): string {
	const dataDir = process.env.OTTR_DATA_DIR;
	return dataDir ? resolve(dataDir) : resolve(projectPath);
}

/** Writes an ignore-everything .gitignore (and its parents) below anchor unless one exists. */
function writeIgnoreAll(anchor: string, file: string): void {
	try {
		writeBelow(anchor, file, "*\n", "exclusive");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
}

export function discoverProjects(
	roots: string[],
	extra: string[] = [],
	removed: string[] = [],
): string[] {
	// One path per basename: the board keys projects (and their OTTR_DATA_DIR data dirs) by
	// folder name, so two roots may not contribute the same name twice. Removed paths drop out
	// before dedupe, or a removed project would claim the name and hide a wanted duplicate.
	// Explicit extra paths go first — an explicit path wins over a root scan — then first root
	// hit wins.
	const byName = new Map<string, string>();
	const add = (dir: string): void => {
		const abs = resolve(dir);
		if (removed.some((r) => platform.samePath(r, abs))) return;
		if (!existsSync(join(serverDirFor(abs), "tasks.db"))) return;
		const name = basename(abs);
		if (!byName.has(name)) byName.set(name, abs);
	};
	for (const p of extra) add(resolve(p));
	for (const root of roots) {
		let entries: Dirent[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			continue; // missing/unreadable root: skip
		}
		for (const entry of entries) {
			if (entry.isDirectory()) add(resolve(root, entry.name));
		}
	}
	return [...byName.values()].sort();
}

/**
 * First non-empty trimmed line of the prompt, max 80 chars — the task's title. Skips section
 * labels (Markdown headings with a single word, e.g. "# Goal") and strips leading `#` marks,
 * so a heading like "# Set up agent rules" becomes the bare text. Overlong lines cut at a
 * word boundary (shortTitle), never mid-word. No code matches on the title text (card kind
 * is a trusted, server-set field, never derived from prompt text), so this is safe to change.
 */
function deriveTitle(prompt: string): string {
	const lines = prompt.split("\n").map((line) => line.trim());
	const isSectionLabel = (line: string) => /^#{1,6}\s+\S+$/.test(line);
	const line =
		lines.find((line) => line.length > 0 && !isSectionLabel(line)) ??
		lines.find((line) => line.length > 0) ??
		"";
	return shortTitle(line.replace(/^#+\s*/, ""), 80);
}

/**
 * Short board-card name cut from the prompt line at a word boundary. The stopgap a card shows
 * before omp or the agent titles the session; never persisted, so the real title still wins.
 *
 * Defined in prompts.ts (the proposal reasons cut source titles with it too); re-exported here
 * for the store's own callers.
 */
export { shortTitle };

/** Per-task turn facts the board card build needs, batched by boardCardFacts: one scan
 * replaces the two listTurns calls and the lastTurnModel query the build ran per card. */
export interface BoardTurnFacts {
	/** The task's first turn without an end, in id order (runStartedAt/etaMs); null when none is open. */
	openTurn: { startedAt: number; kind: TurnKind; model: string | null } | null;
	/** The newest recorded model: lastTurnModel's answer. */
	lastModel: string | null;
	/** The last work-kind turn's outcome, what answeredCard scans; null when no work turn ran. */
	lastWorkOutcome: OutcomeStatus | null;
}

/** One append-only lifecycle record in the `events` table: task created, a stage or state transition, or an error. */
export interface StatEvent {
	at: number;
	taskId: string | null;
	kind: "create" | "stage" | "state" | "error";
	from: string | null;
	to: string | null;
	detail: string | null;
}

// Per-key runtime validation, shared by getSettings; keyed so a new ProjectSettings
// field must declare its shape here or stored values silently keep the default.
const SETTINGS_SHAPES = {
	maxParallel: "number|null",
	copyExtra: "string[]",
	displayName: "string",
	iconText: "string",
	releaseCommand: "string",
	archReviewCap: "number",
	maxImages: "number",
	keptWorktreeDays: "number",
	autoTend: "boolean",
	autoTendLimit: "number",
	tendChurnGlobs: "string[]",
	holdUpdateMerges: "boolean",
	forkMergeHold: "boolean",
	retroSince: "number",
	retroFilter: "boolean",
	forkResearch: "boolean",
	trendingScout: "boolean",
	prReviews: "boolean",
	prReviewNotify: "boolean",
	prReviewApprove: "boolean",
	prMode: "boolean",
	issueWatch: "boolean",
	issueWatchSince: "number",
	ompWatch: "boolean",
	microVm: "boolean",
	setupChecklist: "boolean",
	targetBranch: "string|null",
	originUrl: "string|null",
	pushSyncCommits: "boolean",
	taskIdPrefix: "string|null",
	jiraConnection: "string|null",
	jiraLastJql: "string|null",
} as const satisfies Record<keyof ProjectSettings, string>;

/** Validates one stored settings value; undefined when corrupt or of the wrong shape (keep default). */
function parseSetting(
	key: string,
	value: unknown,
): ProjectSettings[keyof ProjectSettings] | undefined {
	const shape = SETTINGS_SHAPES[key as keyof ProjectSettings];
	if (shape === undefined) return undefined;
	if (shape === "string[]")
		return Array.isArray(value) ? value.map(String) : undefined;
	if (shape === "number|null")
		return value === null || typeof value === "number"
			? (value as ProjectSettings[keyof ProjectSettings])
			: undefined;
	if (shape === "string|null")
		return value === null || typeof value === "string"
			? (value as ProjectSettings[keyof ProjectSettings])
			: undefined;
	if (typeof value !== shape) return undefined;
	return value as ProjectSettings[keyof ProjectSettings];
}

/** A trending verdict's repo: lowercase `owner/repo`. */
const TRENDING_REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

interface TrendingVerdictRow {
	repo: string;
	verdict: TrendingVerdictKind;
	reason: string;
	rejected_by_user: number;
	first_seen_at: number;
	judged_at: number;
	scout_card_id: string | null;
	proposal_card_id: string | null;
}

function rowToTrendingVerdict(r: TrendingVerdictRow): TrendingVerdict {
	return {
		repo: r.repo,
		verdict: r.verdict,
		reason: r.reason,
		rejectedByUser: r.rejected_by_user === 1,
		firstSeenAt: r.first_seen_at,
		judgedAt: r.judged_at,
		scoutCardId: r.scout_card_id,
		proposalCardId: r.proposal_card_id,
	};
}

/** Serializes one task patch value for binding: JSON arrays and objects, booleans as
 * 0/1, scalars pass through. */
function bindTaskValue(
	value: string | number | boolean | object | null,
): string | number | null {
	// ponytail: Array.isArray covers exactly the JSON array columns (images, pendingImages, shots, asked, keptFiles); more need a column->serializer map
	// A plain object (proposalSummary) serializes too; null and the scalars pass through.
	return Array.isArray(value)
		? JSON.stringify(value)
		: typeof value === "boolean"
			? value
				? 1
				: 0
			: value !== null && typeof value === "object"
				? JSON.stringify(value)
				: (value as string | number | null);
}

export class ProjectStore {
	readonly path: string;
	readonly name: string;
	readonly tasksDir: string;
	/** Server-only dir (serverDirFor): tasks.db and the fork cache. */
	readonly serverDir: string;
	/** Anchor for confined writes below tasksDir (dataRootFor). */
	readonly dataRoot: string;
	readonly sessionsDir: string;
	readonly worktreesDir: string;
	private readonly db: SQLiteDatabase;
	private readonly queue: StoreQueue;

	private constructor(projectPath: string, db: SQLiteDatabase) {
		this.path = projectPath;
		this.name = basename(projectPath);
		this.tasksDir = tasksDirFor(projectPath);
		this.serverDir = serverDirFor(projectPath);
		this.dataRoot = dataRootFor(projectPath);
		this.sessionsDir = join(this.tasksDir, "sessions");
		this.worktreesDir = join(projectPath, ".worktrees");
		this.db = db;
		this.queue = new StoreQueue({
			begin: async () => {
				await db.exec("BEGIN");
			},
			commit: async () => {
				await db.exec("COMMIT");
			},
			rollback: () => db.rollback(),
		});
	}

	async transaction<T>(work: () => T | Promise<T>): Promise<T> {
		return this.queue.transaction(work);
	}

	static async init(projectPath: string): Promise<ProjectStore> {
		const root = resolve(projectPath);
		const tasksDir = tasksDirFor(root);
		const dataRoot = dataRootFor(root);
		mkdirBelow(dataRoot, join(tasksDir, "logs"));
		mkdirBelow(dataRoot, join(tasksDir, "sessions"));
		writeIgnoreAll(dataRoot, join(tasksDir, ".gitignore"));
		writeIgnoreAll(root, join(root, ".worktrees", ".gitignore"));
		return await ProjectStore.open(root);
	}

	/** Additive column convergence: adds one column when the (possibly stale) column list lacks it. */
	private static async addColumn(
		db: SQLiteDatabase,
		cols: readonly string[],
		col: string,
		ddl: string,
	): Promise<void> {
		if (cols.includes(col)) return;
		await db.exec(ddl);
	}

	/** Rebuilds the tasks table in one transaction when its stored DDL still carries the
	 * `detect` CHECK list: recreates from TASKS_DDL, adds `addCols`, copies the named
	 * columns explicitly, verifies the count, then swaps — a failure leaves the old
	 * table untouched. Returns the live columns so later convergence cannot use the old shape. */
	private static async rebuildTasksOnCheck(
		db: SQLiteDatabase,
		tasksSql: string,
		detect: string,
		addCols: readonly string[],
		names: string,
		label: string,
	): Promise<string[] | null> {
		if (!tasksSql.includes(detect)) return null;
		const count = async (table: string): Promise<number> =>
			(
				await db
					.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
					.get()
			)?.n ?? 0;
		const before = await count("tasks");
		await db.exec("BEGIN");
		try {
			await db.exec(
				TASKS_DDL.replace(
					"CREATE TABLE IF NOT EXISTS tasks",
					"CREATE TABLE tasks_migrating",
				),
			);
			for (const ddl of addCols) await db.exec(ddl);
			await db.exec(
				`INSERT INTO tasks_migrating (${names}) SELECT ${names} FROM tasks`,
			);
			const after = await count("tasks_migrating");
			if (after !== before)
				throw Error(
					`${label} migration would lose rows: ${before} -> ${after}`,
				);
			await db.exec("DROP TABLE tasks");
			await db.exec("ALTER TABLE tasks_migrating RENAME TO tasks");
			const columns = (
				await db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all()
			).map((column) => column.name);
			await db.exec("COMMIT");
			return columns;
		} catch (err) {
			await db.rollback();
			throw err;
		}
	}

	/** Backfills topics for done cards missing one; idempotent (only null rows). */
	private static async backfillTopics(
		db: SQLiteDatabase,
		queue: StoreQueue,
	): Promise<void> {
		await queue.transaction(async () => {
			const untopic = await db
				.query<
					{ id: string; title: string | null; session_title: string | null },
					[]
				>(
					"SELECT id, title, session_title FROM tasks WHERE stage = 'done' AND topic IS NULL",
				)
				.all();
			if (untopic.length === 0) return;
			const topics = assignTopics(
				untopic.map((r) => ({
					id: r.id,
					title: r.title ?? "",
					sessionTitle: r.session_title,
				})),
			);
			for (const [id, topic] of topics)
				await db.run("UPDATE tasks SET topic = ? WHERE id = ?", [topic, id]);
		});
	}

	/** Consumes each open card's first valid agent rename into a work title (OTTR-912);
	 * idempotent (only rows still marked draft). Done and cancelled cards keep their titles.
	 * Runs inside open's queue.run, so no transaction of its own. */
	private static async backfillWorkTitles(
		db: SQLiteDatabase,
		sessionsDir: string,
	): Promise<void> {
		const drafts = await db
			.query<
				{
					id: string;
					session_id: string | null;
					session_title: string | null;
				},
				[]
			>(
				"SELECT id, session_id, session_title FROM tasks WHERE stage != 'done' AND cancelled_at IS NULL AND session_title IS NOT NULL AND title_source = 'draft'",
			)
			.all();
		for (const row of drafts) {
			const work = firstWorkTitle(
				sessionsDir,
				row.session_id,
				cleanTitle(row.session_title ?? ""),
			);
			if (work === null) continue;
			await db.run(
				"UPDATE tasks SET session_title = ?, title_source = 'work' WHERE id = ? AND title_source = 'draft'",
				[work, row.id],
			);
		}
	}

	/** The converged needs_reason for one legacy proposal row, or null when nothing rewrites it. */
	private static async convergedReason(
		db: SQLiteDatabase,
		row: { needs_reason: string; follow_up_of: string | null },
	): Promise<string | null> {
		const reason = row.needs_reason;
		if (reason.startsWith(LEGACY_PROPOSED_REASON_PREFIX)) {
			const parent = row.follow_up_of
				? await db
						.query<{ follow_up_of: string | null }, [string]>(
							"SELECT follow_up_of FROM tasks WHERE id = ?",
						)
						.get(row.follow_up_of)
				: null;
			const sourceId =
				parent === null ? null : (parent.follow_up_of ?? row.follow_up_of);
			return sourceId !== null ? proposedReason({ id: sourceId }) : null;
		}
		if (reason.startsWith(LEGACY_FORK_PROPOSED_REASON_PREFIX)) {
			return row.follow_up_of !== null
				? forkProposedReason({ id: row.follow_up_of })
				: null;
		}
		const id = /^(?:Retro proposal from |Fork proposal from )(\S+) \("/.exec(
			reason,
		)?.[1];
		if (id === undefined) return null;
		return reason.startsWith(PROPOSED_REASON_PREFIX)
			? proposedReason({ id })
			: forkProposedReason({ id });
	}

	/** Rewrites legacy proposal needs_reason text to the current wording. Display text
	 * only: it never touches titles, prompts or turn rows. A converged row no longer
	 * matches, so the pass stays idempotent on every open. */
	private static async convergeProposalReasons(
		db: SQLiteDatabase,
		queue: StoreQueue,
	): Promise<void> {
		await queue.transaction(async () => {
			// Proposal reasons written before the 2026-11 wording fix double the kind label
			// ("the retro of Retro of …", "the fork research Fork research: …") and describe
			// the actions without naming the drawer buttons. replace() with the exact
			// generated substrings converges held proposals; a converged row no longer
			// matches, so the pass stays idempotent on every open. Display text only: it
			// never touches titles, prompts or turn rows.
			await db.run(
				`UPDATE tasks SET needs_reason = replace(needs_reason, ? || ?, ?)
			 WHERE needs_reason LIKE ? || ? || '%'`,
				[
					LEGACY_PROPOSED_REASON_PREFIX,
					RETRO_MARKER,
					LEGACY_PROPOSED_REASON_PREFIX,
					LEGACY_PROPOSED_REASON_PREFIX,
					RETRO_MARKER,
				],
			);
			await db.run(
				`UPDATE tasks SET needs_reason = replace(needs_reason, ? || 'Fork research: ', ?)
			 WHERE needs_reason LIKE ? || 'Fork research: %'`,
				[
					LEGACY_FORK_PROPOSED_REASON_PREFIX,
					LEGACY_FORK_PROPOSED_REASON_PREFIX,
					LEGACY_FORK_PROPOSED_REASON_PREFIX,
				],
			);
			await db.run(
				`UPDATE tasks SET needs_reason = replace(needs_reason, '. Accept to start it, edit the prompt first, or cancel to decline.', '. Accept starts it. Edit task changes the prompt first. Cancel task declines it.') WHERE needs_reason LIKE '%Accept to start it, edit the prompt first, or cancel to decline.'`,
			);
			// Proposal reasons that quote the source title converge to the id-only text the
			// drawer can link. Legacy prefixes recover the source id through the follow-up
			// chain (a retro proposal names the parent retro's own follow-up, else that retro
			// itself; a fork proposal names the result card); a row whose chain is gone keeps
			// its legacy text — no id, no rewrite. Rows of the 2026-11 wording already carry
			// the id and only drop the quoted title.
			for (const row of await db
				.query<
					{ id: string; needs_reason: string; follow_up_of: string | null },
					[string, string, string, string]
				>(
					`SELECT id, needs_reason, follow_up_of FROM tasks
				 WHERE needs_reason LIKE ? || '%'
				    OR needs_reason LIKE ? || '%'
				    OR (needs_reason LIKE ? || '%' AND needs_reason LIKE '% ("%')
				    OR (needs_reason LIKE ? || '%' AND needs_reason LIKE '% ("%')`,
				)
				.all(
					LEGACY_PROPOSED_REASON_PREFIX,
					LEGACY_FORK_PROPOSED_REASON_PREFIX,
					PROPOSED_REASON_PREFIX,
					FORK_PROPOSED_REASON_PREFIX,
				)) {
				const next = await ProjectStore.convergedReason(db, row);
				if (next !== null)
					await db.run("UPDATE tasks SET needs_reason = ? WHERE id = ?", [
						next,
						row.id,
					]);
			}
		});
	}

	/** Rebuilds pr_review_runs when its stored shape predates the current columns: copies
	 * rows explicitly, verifies the count, swaps — one transaction, so a failure leaves
	 * the old table untouched. */
	private static async rebuildPrReviewRuns(
		db: SQLiteDatabase,
		runCols: string[],
	): Promise<void> {
		if (
			runCols.length === 0 ||
			["id", "number", "started_at", "head", "done"].every((c) =>
				runCols.includes(c),
			)
		)
			return;
		const count = async (table: string): Promise<number> =>
			(
				await db
					.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
					.get()
			)?.n ?? 0;
		const before = await count("pr_review_runs");
		await db.exec("BEGIN");
		try {
			await db.exec(
				PR_REVIEW_RUNS_DDL.replace(
					"CREATE TABLE IF NOT EXISTS pr_review_runs",
					"CREATE TABLE pr_review_runs_migrating",
				),
			);
			if (runCols.includes("head")) {
				// The head-era build wrote each row after its review finished, so done = 1
				// keeps the one-review-per-head gate for heads already reviewed there.
				await db.exec(
					"INSERT INTO pr_review_runs_migrating (number, started_at, head, done) SELECT number, started_at, head, 1 FROM pr_review_runs",
				);
				const after = await count("pr_review_runs_migrating");
				if (after !== before)
					throw Error(
						`pr_review_runs migration would lose rows: ${before} -> ${after}`,
					);
				// The first shape holds no head, so its rows cannot satisfy head NOT NULL
				// and drop: they only carry the daily rate-limit window, never review content.
			}
			await db.exec("DROP TABLE pr_review_runs");
			await db.exec(
				"ALTER TABLE pr_review_runs_migrating RENAME TO pr_review_runs",
			);
			await db.exec(
				"CREATE INDEX IF NOT EXISTS idx_pr_review_runs_at ON pr_review_runs (started_at)",
			);
			await db.exec("COMMIT");
		} catch (err) {
			await db.rollback();
			throw err;
		}
	}

	static async open(projectPath: string): Promise<ProjectStore> {
		const root = resolve(projectPath);
		const tasksDir = tasksDirFor(root);
		mkdirBelow(dataRootFor(root), tasksDir);
		const serverDir = serverDirFor(root);
		mkdirSync(serverDir, { recursive: true });
		const dbPath = join(serverDir, "tasks.db");
		// Shared PRAGMA + instance-lock sequence (R2-9): one live opener per db file
		// (incident 2026-10-06); a refused opener throws with the holder named, handle closed.
		const db = await openLocked(dbPath);
		const store = new ProjectStore(root, db);
		try {
			await store.queue.run(async () => {
				await db.exec(SCHEMA);
				let cols = (
					await db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all()
				).map((c) => c.name);
				await ProjectStore.addColumn(
					db,
					cols,
					"images",
					"ALTER TABLE tasks ADD COLUMN images TEXT NOT NULL DEFAULT '[]'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"pending_images",
					"ALTER TABLE tasks ADD COLUMN pending_images TEXT NOT NULL DEFAULT '[]'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"shots",
					"ALTER TABLE tasks ADD COLUMN shots TEXT NOT NULL DEFAULT '[]'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"session_title",
					"ALTER TABLE tasks ADD COLUMN session_title TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"commits",
					"ALTER TABLE tasks ADD COLUMN commits INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"release_version",
					"ALTER TABLE tasks ADD COLUMN release_version TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"release_notes",
					"ALTER TABLE tasks ADD COLUMN release_notes TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"asked",
					"ALTER TABLE tasks ADD COLUMN asked TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"model",
					"ALTER TABLE tasks ADD COLUMN model TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"kept_files",
					"ALTER TABLE tasks ADD COLUMN kept_files TEXT NOT NULL DEFAULT '[]'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"follow_up_of",
					"ALTER TABLE tasks ADD COLUMN follow_up_of TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"done_at",
					"ALTER TABLE tasks ADD COLUMN done_at INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"push_sha",
					"ALTER TABLE tasks ADD COLUMN push_sha TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"report",
					"ALTER TABLE tasks ADD COLUMN report TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"research",
					"ALTER TABLE tasks ADD COLUMN research INTEGER NOT NULL DEFAULT 0",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"research_steps",
					"ALTER TABLE tasks ADD COLUMN research_steps TEXT NOT NULL DEFAULT 'unknown'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"update_ids",
					"ALTER TABLE tasks ADD COLUMN update_ids TEXT NOT NULL DEFAULT '[]'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"update_merge_approved",
					"ALTER TABLE tasks ADD COLUMN update_merge_approved INTEGER NOT NULL DEFAULT 0",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"gate",
					"ALTER TABLE tasks ADD COLUMN gate TEXT",
				);
				// OTTR-850 prompt authorship: lives in TASKS_DDL, so its ALTER runs here, before
				// the CHECK rebuilds (gate-column precedent). The DEFAULT backfills every existing
				// row to 'user', so old cards keep today's gate behavior.
				await ProjectStore.addColumn(
					db,
					cols,
					"prompt_author",
					"ALTER TABLE tasks ADD COLUMN prompt_author TEXT NOT NULL DEFAULT 'user'",
				);
				// OTTR-795 optimistic-locking revision: lives in TASKS_DDL, so its ALTER runs here,
				// before the CHECK rebuilds, like the shots column. The stale cols list fires the
				// ALTER once on an old database; a rebuild afterwards recreates the table from
				// TASKS_DDL, which already carries the column, so no open re-queues the ALTER
				// (a column living in DDL but migrated after the rebuilds would dupe here instead).
				await ProjectStore.addColumn(
					db,
					cols,
					"revision",
					"ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
				);
				// Backfill runs on every open and is idempotent (only null rows): a process stop
				// between the ALTER above and the UPDATE converges here on the next open instead
				// of leaving done cards unstamped forever (includedTasks drops them from releases).
				await db.exec(
					"UPDATE tasks SET done_at = (SELECT ended_at FROM turns WHERE turns.task_id = tasks.id ORDER BY turns.id DESC LIMIT 1) WHERE stage = 'done' AND done_at IS NULL",
				);
				// OTTR-799: the conflict park's reason text grew the reply recovery, and
				// prConflictVerdict un-parks only on the exact current text. Rewrite stored
				// pre-update parks (the old text ends at "…pull request."), so cards parked
				// before the update take the automatic recovery again. Idempotent: the
				// migrated text no longer ends with the matched literal. Only the supervisor's
				// own park shape matches (the LIKE pins the full literal around the number).
				await db.exec(
					"UPDATE tasks SET needs_reason = REPLACE(needs_reason, 'Resolve the conflict on the pull request.', 'Resolve the conflict on the pull request, or reply to rebase the branch onto the target; the tracker pushes and updates the pull request.') WHERE needs_reason LIKE 'PR #% cannot merge: it conflicts with the target branch. Resolve the conflict on the pull request.'",
				);
				// A CHECK constraint can only change by rebuilding the table: databases created before
				// `preparing` carry the old state list, and the scheduler writes 'preparing' on every
				// claim. Runs after the column backfills so old and new shapes have the same named
				// columns; copies rows explicitly (legacy column ORDER can differ), verifies the count,
				// then swaps — all in one transaction, so a failure leaves the old table untouched.
				const tasksSql =
					(
						await db
							.query<{ sql: string }, []>(
								"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
							)
							.get()
					)?.sql ?? "";
				cols =
					(await ProjectStore.rebuildTasksOnCheck(
						db,
						tasksSql,
						"state IN ('queued','running','needs_you','idle')",
						[
							"ALTER TABLE tasks_migrating ADD COLUMN commits INTEGER",
							"ALTER TABLE tasks_migrating ADD COLUMN done_at INTEGER",
						],
						`id, title, prompt, stage, state, needs_reason, pending_prompt,
					branch, base, worktree, session_id, summary, details, created_at, updated_at,
					queued_at, cancelled_at, images, pending_images, release_version, release_notes,
					session_title, asked, model, kept_files, follow_up_of, commits, done_at`,
						"state",
					)) ?? cols;
				// topic lands after the state-CHECK rebuild above on purpose: that migration copies
				// named columns only, so a column added before it would be dropped together with the
				// freshly backfilled labels. Same idempotent pattern as done_at: only null rows.
				await ProjectStore.addColumn(
					db,
					cols,
					"topic",
					"ALTER TABLE tasks ADD COLUMN topic TEXT",
				);
				await ProjectStore.backfillTopics(db, store.queue);
				await ProjectStore.addColumn(
					db,
					cols,
					"depends_on",
					"ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
				);
				// Diff capture columns: null on every pre-existing row (never captured), so plain ADD COLUMN
				// converges; placed after the state-CHECK rebuild like topic, whose named-column copy would
				// drop them otherwise.
				await ProjectStore.addColumn(
					db,
					cols,
					"diff_files",
					"ALTER TABLE tasks ADD COLUMN diff_files TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"diff_text",
					"ALTER TABLE tasks ADD COLUMN diff_text TEXT",
				);
				// Work-check columns: absent from TASKS_DDL on purpose — the state-CHECK
				// rebuild recreates the table from that DDL, so a column living in both would dupe
				// here on the stale column list (same reason topic and the diff columns live here).
				await ProjectStore.addColumn(
					db,
					cols,
					"work_check_log",
					"ALTER TABLE tasks ADD COLUMN work_check_log TEXT NOT NULL DEFAULT '[]'",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"work_check_sendbacks",
					"ALTER TABLE tasks ADD COLUMN work_check_sendbacks INTEGER NOT NULL DEFAULT 0",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"work_check_head",
					"ALTER TABLE tasks ADD COLUMN work_check_head TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"work_check_report",
					"ALTER TABLE tasks ADD COLUMN work_check_report TEXT",
				);
				// fork_merge_approved lives after the state-CHECK rebuild on purpose (like topic and the
				// diff columns): it is ALTER-only, so a rebuild before its backfill would drop the
				// column and the stale `cols` list would never re-add it.
				await ProjectStore.addColumn(
					db,
					cols,
					"fork_merge_approved",
					"ALTER TABLE tasks ADD COLUMN fork_merge_approved INTEGER NOT NULL DEFAULT 0",
				);
				// A CHECK constraint can only change by rebuilding the table: databases created before
				// `backlog` carry the old stage list, and a parked card writes 'backlog'. Same pattern as
				// the state-CHECK rebuild above: runs after every column backfill (named-column copy),
				// copies rows explicitly, verifies the count, swaps in one transaction.
				cols =
					(await ProjectStore.rebuildTasksOnCheck(
						db,
						tasksSql,
						"stage IN ('todo','in_progress','merging','done')",
						[
							"ALTER TABLE tasks_migrating ADD COLUMN commits INTEGER",
							"ALTER TABLE tasks_migrating ADD COLUMN done_at INTEGER",
							"ALTER TABLE tasks_migrating ADD COLUMN topic TEXT",
							"ALTER TABLE tasks_migrating ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
							"ALTER TABLE tasks_migrating ADD COLUMN diff_files TEXT",
							"ALTER TABLE tasks_migrating ADD COLUMN diff_text TEXT",
							"ALTER TABLE tasks_migrating ADD COLUMN work_check_log TEXT NOT NULL DEFAULT '[]'",
							"ALTER TABLE tasks_migrating ADD COLUMN work_check_sendbacks INTEGER NOT NULL DEFAULT 0",
							"ALTER TABLE tasks_migrating ADD COLUMN work_check_head TEXT",
							"ALTER TABLE tasks_migrating ADD COLUMN work_check_report TEXT",
							"ALTER TABLE tasks_migrating ADD COLUMN fork_merge_approved INTEGER NOT NULL DEFAULT 0",
						],
						`id, title, prompt, stage, state, needs_reason, pending_prompt,
					branch, base, worktree, session_id, summary, details, report, research, research_steps,
					created_at, updated_at, queued_at, cancelled_at, images, pending_images,
					release_version, release_notes, session_title, asked, model, kept_files,
					follow_up_of, push_sha, update_ids, update_merge_approved, fork_merge_approved,
					commits, done_at, topic, depends_on, diff_files, diff_text, work_check_log,
					work_check_sendbacks, work_check_head, work_check_report`,
						"stage",
					)) ?? cols;
				// Triage columns: ALTER-only and placed after both CHECK rebuilds on
				// purpose — the rebuilds copy named columns, so a column living in TASKS_DDL too
				// would dupe here on the stale column list (same reason topic and the diff columns).
				await ProjectStore.addColumn(
					db,
					cols,
					"priority",
					"ALTER TABLE tasks ADD COLUMN priority TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"close_candidate",
					"ALTER TABLE tasks ADD COLUMN close_candidate TEXT",
				);
				// Merge-hold heads (replace the retired update/fork_merge_approved flags, which stay
				// unused in old rows): ALTER-only after the rebuilds, same reason as priority above.
				for (const col of ["update_merge_head", "fork_merge_head", "hold_head"])
					await ProjectStore.addColumn(
						db,
						cols,
						col,
						`ALTER TABLE tasks ADD COLUMN ${col} TEXT`,
					);
				// Who authored pending_prompt ("user" | "supervisor"): ALTER-only after the
				// rebuilds, same reason as priority above; null behaves as "user" on old rows.
				await ProjectStore.addColumn(
					db,
					cols,
					"pending_by",
					"ALTER TABLE tasks ADD COLUMN pending_by TEXT",
				);
				// OTTR-394: how many automatic rebase retries a rejected server push has spent
				// (budget 2 per card). ALTER-only after the rebuilds, like pending_by above.
				await ProjectStore.addColumn(
					db,
					cols,
					"push_retries",
					"ALTER TABLE tasks ADD COLUMN push_retries INTEGER NOT NULL DEFAULT 0",
				);
				// OTTR-552 PR-mode PR fields: ALTER-only after both CHECK rebuilds, same reason as
				// push_retries above — a rebuild's explicit column list would drop them.
				await ProjectStore.addColumn(
					db,
					cols,
					"pr_number",
					"ALTER TABLE tasks ADD COLUMN pr_number INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"pr_url",
					"ALTER TABLE tasks ADD COLUMN pr_url TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"pr_head_sha",
					"ALTER TABLE tasks ADD COLUMN pr_head_sha TEXT",
				);
				// OTTR-760: the pull request a card was filed from (a Dependabot PR). The ship step
				// adopts it instead of opening a second PR. ALTER-only after both CHECK rebuilds,
				// same reason as pr_number above — a rebuild's explicit column list would drop them.
				await ProjectStore.addColumn(
					db,
					cols,
					"source_pr_number",
					"ALTER TABLE tasks ADD COLUMN source_pr_number INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"source_pr_url",
					"ALTER TABLE tasks ADD COLUMN source_pr_url TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"source_pr_head_ref",
					"ALTER TABLE tasks ADD COLUMN source_pr_head_ref TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"source_pr_head_sha",
					"ALTER TABLE tasks ADD COLUMN source_pr_head_sha TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"source_pr_cross_repo",
					"ALTER TABLE tasks ADD COLUMN source_pr_cross_repo INTEGER NOT NULL DEFAULT 0",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"source_pr_dependabot",
					"ALTER TABLE tasks ADD COLUMN source_pr_dependabot INTEGER NOT NULL DEFAULT 0",
				);
				// OTTR-809: the follow-up PR the ship step opened for a Dependabot card's fixes
				// beyond the source PR's head. ALTER-only after both CHECK rebuilds, same reason
				// as pr_number above — a rebuild's explicit column list would drop them.
				await ProjectStore.addColumn(
					db,
					cols,
					"follow_up_pr_number",
					"ALTER TABLE tasks ADD COLUMN follow_up_pr_number INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"follow_up_pr_url",
					"ALTER TABLE tasks ADD COLUMN follow_up_pr_url TEXT",
				);
				// OTTR-877: the review feedback watch's cutoff. Null = never swept. ALTER-only
				// after both CHECK rebuilds, same reason as pr_number above — a rebuild's
				// explicit column list would drop them.
				await ProjectStore.addColumn(
					db,
					cols,
					"pr_watch_at",
					"ALTER TABLE tasks ADD COLUMN pr_watch_at INTEGER",
				);
				// OTTR-877: marks a pending_prompt the feedback watch wrote, so passes settle
				// through it (wentStale ignores it) and moving the card off the park clears it
				// with the prompt. ALTER-only after both CHECK rebuilds, same reason as
				// pr_watch_at above.
				await ProjectStore.addColumn(
					db,
					cols,
					"pending_feedback",
					"ALTER TABLE tasks ADD COLUMN pending_feedback INTEGER NOT NULL DEFAULT 0",
				);
				// OTTR-912 card titles: which source named the card ('draft' | 'work'). ALTER-only
				// after both CHECK rebuilds like the columns above — a rebuild's explicit column
				// list would drop it. The stamp is idempotent on NULL; the backfill then consumes
				// each open card's first valid agent rename once. Both run only when the table
				// already carries session_title and cancelled_at (a pre-title shape stores no
				// titles, so there is nothing to stamp), which keeps minimal old fixtures opening.
				await ProjectStore.addColumn(
					db,
					cols,
					"title_source",
					"ALTER TABLE tasks ADD COLUMN title_source TEXT",
				);
				if (cols.includes("session_title") && cols.includes("cancelled_at")) {
					await db.exec(
						"UPDATE tasks SET title_source = 'draft' WHERE session_title IS NOT NULL AND title_source IS NULL",
					);
					await ProjectStore.backfillWorkTitles(db, store.sessionsDir);
				}
				const turnCols = (
					await db.query<{ name: string }, []>("PRAGMA table_info(turns)").all()
				).map((c) => c.name);
				await ProjectStore.addColumn(
					db,
					turnCols,
					"model",
					"ALTER TABLE turns ADD COLUMN model TEXT",
				);
				// The --model selector a swapped run was dispatched with; null when none served a
				// different model than dispatched. Nullable, so plain ADD COLUMN converges.
				await ProjectStore.addColumn(
					db,
					turnCols,
					"dispatched_model",
					"ALTER TABLE turns ADD COLUMN dispatched_model TEXT",
				);
				// Where the turn's run executed; null for turns recorded before OTTR-503.
				await ProjectStore.addColumn(
					db,
					turnCols,
					"ran_on",
					"ALTER TABLE turns ADD COLUMN ran_on TEXT",
				);
				await ProjectStore.addColumn(
					db,
					turnCols,
					"input",
					"ALTER TABLE turns ADD COLUMN input TEXT",
				);
				// Who authored the delivered input ("user" | "supervisor"); null behaves as "user".
				await ProjectStore.addColumn(
					db,
					turnCols,
					"input_by",
					"ALTER TABLE turns ADD COLUMN input_by TEXT",
				);
				// Byte offset in the card log where the turn's own section starts; null for pre-field rows.
				await ProjectStore.addColumn(
					db,
					turnCols,
					"log_offset",
					"ALTER TABLE turns ADD COLUMN log_offset INTEGER",
				);
				// Cost capture columns: nullable, so plain ADD COLUMN converges like the
				// tasks columns above; the backfill below fills what the transcripts still allow.
				for (const col of [
					"tokens_in",
					"tokens_out",
					"cache_read",
					"cache_write",
				]) {
					await ProjectStore.addColumn(
						db,
						turnCols,
						col,
						`ALTER TABLE turns ADD COLUMN ${col} INTEGER`,
					);
				}
				await ProjectStore.addColumn(
					db,
					turnCols,
					"cost",
					"ALTER TABLE turns ADD COLUMN cost REAL",
				);
				await ProjectStore.addColumn(
					db,
					turnCols,
					"layer",
					"ALTER TABLE turns ADD COLUMN layer TEXT",
				);
				// kind: trusted, server-set card kind. ALTER-only and placed after both
				// table-rebuild blocks on purpose (like topic/fork_merge_approved): those copy rows by
				// an explicit name list and would reset kind to 'work'. The one-time backfill maps
				// pre-existing privileged cards to their kind: they were all created by the trusted
				// routes whose prompt builders emit these prefixes, so a LIKE on the marker constants
				// is exact here. After this backfill no code derives kind from prompt text again.
				if (!cols.includes("kind")) {
					await store.transaction(async () => {
						await ProjectStore.addColumn(
							db,
							cols,
							"kind",
							"ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'",
						);
						await db.run(
							"UPDATE tasks SET kind = 'retro' WHERE prompt LIKE ? || '%'",
							[RETRO_MARKER],
						);
						await db.run(
							"UPDATE tasks SET kind = 'interview' WHERE prompt LIKE ? || '%'",
							[RULES_INTERVIEW_MARKER],
						);
						await db.run(
							"UPDATE tasks SET kind = 'review' WHERE release_version IS NULL AND prompt LIKE ? || '%'",
							[ARCH_REVIEW_MARKER],
						);
					});
				}
				// ALTER-only after every rebuild, like kind: a rebuild's explicit column list would drop it.
				await ProjectStore.addColumn(
					db,
					cols,
					"hold_until",
					"ALTER TABLE tasks ADD COLUMN hold_until INTEGER",
				);
				// OTTR-688: which provider (and window) a usage-limit hold waits for; null on non-usage
				// holds. Nullable TEXT, so plain ADD COLUMN converges; ALTER-only after every rebuild
				// like hold_until above.
				await ProjectStore.addColumn(
					db,
					cols,
					"hold_provider",
					"ALTER TABLE tasks ADD COLUMN hold_provider TEXT",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"hold_window",
					"ALTER TABLE tasks ADD COLUMN hold_window TEXT",
				);
				// OTTR-880: increase the probe wait after each consecutive usage-limit hold.
				await ProjectStore.addColumn(
					db,
					cols,
					"hold_attempts",
					"ALTER TABLE tasks ADD COLUMN hold_attempts INTEGER NOT NULL DEFAULT 0",
				);
				// Only blocked-window sightings after this stamp can release the hold early.
				await ProjectStore.addColumn(
					db,
					cols,
					"hold_set_at",
					"ALTER TABLE tasks ADD COLUMN hold_set_at INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"starred",
					"ALTER TABLE tasks ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
				);
				await ProjectStore.addColumn(
					db,
					cols,
					"merge_head",
					"ALTER TABLE tasks ADD COLUMN merge_head TEXT",
				);
				// The parent's project when follow_up_of names a card on another project's board
				// (create_task's project parameter); null keeps the link on this board. ALTER-only
				// after every rebuild, like the columns above: a rebuild's explicit column list
				// would drop it, and a column living in TASKS_DDL too would dupe here on the
				// stale cols list.
				await ProjectStore.addColumn(
					db,
					cols,
					"follow_up_of_project",
					"ALTER TABLE tasks ADD COLUMN follow_up_of_project TEXT",
				);
				// context_tokens: the task's final context-window size in prompt tokens, captured
				// at turn finish and backfilled for done tasks from their transcripts. ALTER-only
				// after every rebuild, like the columns above.
				await ProjectStore.addColumn(
					db,
					cols,
					"context_tokens",
					"ALTER TABLE tasks ADD COLUMN context_tokens INTEGER",
				);
				// uncommitted_files: the worktree's uncommitted files captured when a card settles
				// done, so the done drawer still names them after removeWorktree deletes the tree.
				// ALTER-only after every rebuild, like the columns above.
				await ProjectStore.addColumn(
					db,
					cols,
					"uncommitted_files",
					"ALTER TABLE tasks ADD COLUMN uncommitted_files TEXT NOT NULL DEFAULT '[]'",
				);
				// OTTR-528: the decision panel's five fields, nullable JSON, ALTER-only after the
				// rebuilds like the columns above.
				await ProjectStore.addColumn(
					db,
					cols,
					"proposal_summary",
					"ALTER TABLE tasks ADD COLUMN proposal_summary TEXT",
				);
				// OTTR-769: the review-check stamp over the card's stored findings. ALTER-only after
				// every rebuild, like the columns above.
				await ProjectStore.addColumn(
					db,
					cols,
					"findings_checked_at",
					"ALTER TABLE tasks ADD COLUMN findings_checked_at INTEGER",
				);
				await ProjectStore.convergeProposalReasons(db, store.queue);
				// posted_url landed after the first pr_review release: CREATE TABLE IF NOT EXISTS never
				// updates a live table, so converge additively like the tasks columns above.
				const prCols = (
					await db
						.query<{ name: string }, []>("PRAGMA table_info(pr_review)")
						.all()
				).map((c) => c.name);
				await ProjectStore.addColumn(
					db,
					prCols,
					"posted_url",
					"ALTER TABLE pr_review ADD COLUMN posted_url TEXT",
				);
				// The open-PR hold columns landed after the first fork_branch release: same additive
				// convergence; null reads as "no hold", the state of every older row.
				const forkCols = (
					await db
						.query<{ name: string }, []>("PRAGMA table_info(fork_branch)")
						.all()
				).map((c) => c.name);
				for (const col of ["hold_prs", "hold_base"])
					await ProjectStore.addColumn(
						db,
						forkCols,
						col,
						`ALTER TABLE fork_branch ADD COLUMN ${col} TEXT`,
					);
				// The retired cursor hold (hold_prs/hold_base, superseded by the per-commit
				// fork_hold rows) converts in two steps, so a live board keeps every held
				// commit: each legacy entry held its PR's head, so the head sha seeds the
				// fork_hold row here; the watcher then expands the PR's other held commits
				// (they live between hold_base and the head, a window only git knows) and
				// clears hold_base. One transaction for this step; a later open is a no-op.
				await store.transaction(async () => {
					const legacy = await db
						.query<
							{ fork_id: number; branch_hash: string; hold_prs: string | null },
							[]
						>(
							"SELECT fork_id, branch_hash, hold_prs FROM fork_branch WHERE hold_prs IS NOT NULL",
						)
						.all();
					for (const row of legacy) {
						const prs = parseHoldPrs(row.hold_prs);
						if (prs !== null) {
							for (const e of prs)
								await db.run(
									"INSERT INTO fork_hold (fork_id, branch_hash, sha, pr, pr_head, released) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(fork_id, branch_hash, sha) DO NOTHING",
									[row.fork_id, row.branch_hash, e.head, e.n, e.head],
								);
						}
						await db.run(
							"UPDATE fork_branch SET hold_prs = NULL WHERE fork_id = ? AND branch_hash = ?",
							[row.fork_id, row.branch_hash],
						);
					}
				});
				// posted_login landed with the GitHub App posts: same additive convergence, so an
				// older database still reads and posts without a rebuild.
				await ProjectStore.addColumn(
					db,
					prCols,
					"posted_login",
					"ALTER TABLE pr_review ADD COLUMN posted_login TEXT",
				);
				// The comment watch landed with the PR review notifications: same additive
				// convergence, so an older database still sweeps and alerts without a rebuild.
				await ProjectStore.addColumn(
					db,
					prCols,
					"comments_at",
					"ALTER TABLE pr_review ADD COLUMN comments_at INTEGER",
				);
				await ProjectStore.addColumn(
					db,
					prCols,
					"comments_unseen",
					"ALTER TABLE pr_review ADD COLUMN comments_unseen INTEGER NOT NULL DEFAULT 0",
				);
				// pr_review_runs changed shape twice inside the first pr_review releases (head, then
				// id/done) and CREATE TABLE IF NOT EXISTS never updates a live table, so startPrRun,
				// prHeadReviewed and the done update then throw "no such column" and the watcher
				// only logs it. NOT NULL and the new primary key have no additive form: rebuild,
				// same pattern as the stage rebuilds above — copy rows explicitly, verify the count,
				// swap, one transaction, so a failure leaves the old table untouched.
				const runCols = (
					await db
						.query<{ name: string }, []>("PRAGMA table_info(pr_review_runs)")
						.all()
				).map((c) => c.name);
				await ProjectStore.rebuildPrReviewRuns(db, runCols);
				// The rebuild recreates from the current DDL (which has blocking); a live table that
				// predates the column converges additively. Default 1 is fail-safe: an old run reads
				// as blocking, so an approval needs a run that recorded a clean verdict.
				await ProjectStore.addColumn(
					db,
					(
						await db
							.query<{ name: string }, []>("PRAGMA table_info(pr_review_runs)")
							.all()
					).map((c) => c.name),
					"blocking",
					"ALTER TABLE pr_review_runs ADD COLUMN blocking INTEGER NOT NULL DEFAULT 1",
				);
			});
			await store.backfillTranscriptData();
			return store;
		} catch (error) {
			await store.close();
			throw error;
		}
	}

	async logPath(taskId: string): Promise<string> {
		return join(this.tasksDir, "logs", `${taskId}.log`);
	}

	async imagesDir(taskId: string): Promise<string> {
		return join(this.tasksDir, "images", taskId);
	}

	/** OTTR-486: tasks with a failed prepare-phase title generation whose single retry has
	 * not settled; the value cancels the scheduled retry. While a hold is live, sessionTitle
	 * keeps the transcript title back, so the retry can still name the card before omp's
	 * card-prefixed transcript title lands. In-memory only: a restart drops the hold and
	 * the retry, and the card falls back to using the transcript title as before. */
	private titleHolds = new Map<string, () => void>();

	/** Holds the task's transcript title back until a pending generation retry settles. */
	async holdTitle(id: string, cancelRetry: () => void): Promise<void> {
		this.titleHolds.get(id)?.();
		this.titleHolds.set(id, cancelRetry);
	}

	/** Ends the hold and cancels the scheduled retry; true when a hold was live. */
	async releaseTitleHold(id: string): Promise<boolean> {
		const cancel = this.titleHolds.get(id);
		if (cancel === undefined) return false;
		this.titleHolds.delete(id);
		cancel();
		return true;
	}

	/** True while a title-generation retry is pending for the task. */
	async titleHold(id: string): Promise<boolean> {
		return this.titleHolds.has(id);
	}

	/** The task's raw stored session title, or null; one indexed read. */
	private async storedTitle(id: string): Promise<string | null> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ session_title: string | null }, [string]>(
							"SELECT session_title FROM tasks WHERE id = ?",
						)
						.get(id)
				)?.session_title ?? null
			);
		});
	}

	/** The task's title-source state, or null when the row is gone. */
	private async titleState(id: string): Promise<{
		source: string | null;
		stage: string;
		cancelledAt: number | null;
	} | null> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<
					{
						title_source: string | null;
						stage: string;
						cancelled_at: number | null;
					},
					[string]
				>("SELECT title_source, stage, cancelled_at FROM tasks WHERE id = ?")
				.get(id);
			if (row === null) return null;
			return {
				source: row.title_source,
				stage: row.stage,
				cancelledAt: row.cancelled_at,
			};
		});
	}

	/** One guarded write of the work title: it wins only while the stored title is still a
	 * draft, so two racing resolves cannot store different renames. */
	private async writeWorkTitle(id: string, title: string): Promise<boolean> {
		return this.queue.run(async () => {
			const res = await this.db.run(
				"UPDATE tasks SET session_title = ?, title_source = 'work' WHERE id = ? AND title_source = 'draft'",
				[title, id],
			);
			return res.changes > 0;
		});
	}

	/** One title ladder for every caller: the stored title first, then the first title in
	 * the session transcript, persisted once when `persist`; null when neither exists yet.
	 * Markdown from the titler and omp's card prefix are stripped on read, so rows written
	 * before the cleaning also display clean. A pending generation retry holds the
	 * transcript title back. A stored draft title (OTTR-912) yields once to the run agent's
	 * first valid rename, written with source `work`; a stored work title (a fixed turn name
	 * or a consumed rename) is final. Done and cancelled cards never yield. */
	private async resolveTitle(
		task: ListedTask,
		storedTitle: string | null,
		persist: boolean,
	): Promise<string | null> {
		if (storedTitle) {
			const cleaned = cleanTitle(storedTitle);
			const state = await this.titleState(task.id);
			if (
				state !== null &&
				state.source === "draft" &&
				state.stage !== "done" &&
				state.cancelledAt === null
			) {
				const work = firstWorkTitle(this.sessionsDir, task.sessionId, cleaned);
				if (work !== null && (await this.writeWorkTitle(task.id, work)))
					return cleanTitle(work);
			}
			return cleaned;
		}
		if (await this.titleHold(task.id)) return null;
		const fromSession = firstSessionTitle(this.sessionsDir, task.sessionId);
		if (fromSession === null) return null;
		const title = cleanTitle(fromSession);
		return this.transaction(async () => {
			const current = await this.getTask(task.id);
			if (current === null) return null;
			const saved = await this.storedTitle(task.id);
			if (saved) return cleanTitle(saved);
			if (current.sessionId !== task.sessionId || this.titleHolds.has(task.id))
				return null;
			if (!persist) return title;
			await this.nameTask(task.id, title);
			const winner = await this.storedTitle(task.id);
			return winner === null ? null : cleanTitle(winner);
		});
	}

	/** The task's own session title: the stored one, or the first title in the session
	 * transcript; null when neither exists yet. */
	async sessionTitle(task: ListedTask): Promise<string | null> {
		return await this.resolveTitle(
			task,
			await this.storedTitle(task.id),
			false,
		);
	}

	/** Persists a title once with its source: `IS NULL` keeps the first name authoritative
	 * even if two writes race. `draft` names a prepare-phase generation or a transcript title;
	 * `work` names a fixed turn name or the run agent's first valid rename (OTTR-912), final. */
	async nameTask(
		id: string,
		title: string,
		source: "draft" | "work" = "draft",
	): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"UPDATE tasks SET session_title = ?, title_source = ? WHERE id = ? AND session_title IS NULL",
				[title, source, id],
			);
		});
	}

	/**
	 * Card title: a draft name (the tracker's prepare-phase generation or the first transcript
	 * title) stored once, then the run agent's first valid rename (OTTR-912) replaces it with
	 * source `work` — after that the title never changes, so later re-titles (merge turn,
	 * resume, New session) can't rename the card. A follow-up is a new task with a fresh
	 * session, so it gets that session's title. Until a title exists (omp, the run's rename,
	 * or the tracker's prepare-phase generation), the card shows a short cut of the prompt
	 * line — recomputed each call, never persisted.
	 */
	async frozenTitle(task: ListedTask): Promise<string> {
		return await this.frozenTitleFrom(task, await this.storedTitle(task.id));
	}

	/** frozenTitle for a batched caller (the board card build): the stored title arrives
	 * from boardCardFacts instead of a per-task SELECT, and the once-only persist runs
	 * only when the title came from the transcript — a stored title needs no write.
	 * Same output as frozenTitle. */
	async frozenTitleFrom(
		task: ListedTask,
		storedTitle: string | null,
	): Promise<string> {
		return (
			(await this.resolveTitle(task, storedTitle, true)) ??
			shortTitle(task.title)
		);
	}

	async getSettings(): Promise<ProjectSettings> {
		return this.queue.run(async () => {
			// A deep copy: callers own the arrays (copyExtra, tendChurnGlobs), never the defaults'.
			const out = structuredClone(DEFAULT_SETTINGS);
			for (const row of await this.db
				.query<{ key: string; value: string }, []>(
					"SELECT key, value FROM settings",
				)
				.all()) {
				try {
					const value = parseSetting(row.key, JSON.parse(row.value) as unknown);
					if (value !== undefined)
						(out as Record<keyof ProjectSettings, unknown>)[
							row.key as keyof ProjectSettings
						] = value;
				} catch {
					// corrupt settings row: keep default
				}
			}
			return out;
		});
	}

	async setSettings(patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
		return this.queue.transaction(async () => {
			for (const [key, value] of Object.entries(patch)) {
				// Unknown keys can only arrive from a hand-built JSON body; ignore them.
				if (value === undefined || !(key in DEFAULT_SETTINGS)) continue;
				// A reset stores JSON null instead of deleting the row: tracker data is never deleted.
				await this.db.run(
					"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					[key, JSON.stringify(value)],
				);
			}
			return await this.getSettings();
		});
	}

	/** The card the Check the board button filed last (POST /api/projects/:project/board-check).
	 * Only that route writes the mark, so no prompt an agent writes can make a card a board
	 * check, which runs in the server's own container. Stored next to next-task-num, outside
	 * the project settings that the Settings route edits. */
	async boardCheckId(): Promise<string | null> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<{ value: string }, []>(
					"SELECT value FROM settings WHERE key = 'board-check'",
				)
				.get();
			return row === null ? null : (JSON.parse(row.value) as string);
		});
	}

	async setBoardCheckId(id: string): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"INSERT INTO settings (key, value) VALUES ('board-check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[JSON.stringify(id)],
			);
		});
	}

	/** Pids of turns that never ended: the orphan scan must not kill live processes. */
	async runningPids(): Promise<number[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<{ pid: number }, []>(
						"SELECT DISTINCT pid FROM turns WHERE pid IS NOT NULL AND ended_at IS NULL",
					)
					.all()
			).map((r) => r.pid);
		});
	}

	// ---- Fork research watch state ----

	/** Branch watch rows of one fork, branch name ascending. */
	async listForkBranches(forkId: number): Promise<ForkBranchState[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<ForkBranchRow, [number]>(
						"SELECT * FROM fork_branch WHERE fork_id = ? ORDER BY branch",
					)
					.all(forkId)
			).map(toForkBranch);
		});
	}

	/** Every branch watch row (the gates scan the whole watch). */
	async listAllForkBranches(): Promise<ForkBranchState[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<ForkBranchRow, []>("SELECT * FROM fork_branch")
					.all()
			).map(toForkBranch);
		});
	}

	/** Per-commit holds of one fork, any order (the watcher merges them per branch). */
	async listForkHolds(forkId: number): Promise<ForkHoldState[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<ForkHoldRow, [number]>(
						"SELECT * FROM fork_hold WHERE fork_id = ?",
					)
					.all(forkId)
			).map(toForkHold);
		});
	}

	/** Replaces ALL per-commit hold rows of one branch in one transaction. */
	async setForkHolds(
		forkId: number,
		branchHash: string,
		rows: Array<{ sha: string; pr: number; prHead: string; released: boolean }>,
	): Promise<void> {
		return this.queue.transaction(async () => {
			for (const r of rows) {
				if (!/^[0-9a-f]{40}$/.test(r.prHead)) {
					throw new Error(`fork_hold: pr_head must be 40-hex, got ${r.prHead}`);
				}
			}
			await this.db.run(
				"DELETE FROM fork_hold WHERE fork_id = ? AND branch_hash = ?",
				[forkId, branchHash],
			);
			for (const r of rows) {
				await this.db.run(
					"INSERT INTO fork_hold (fork_id, branch_hash, sha, pr, pr_head, released) VALUES (?, ?, ?, ?, ?, ?)",
					[forkId, branchHash, r.sha, r.pr, r.prHead, r.released ? 1 : 0],
				);
			}
		});
	}

	/**
	 * The retired cursor-hold base of one branch (null once drained). The watcher reads
	 * it to expand a migrated PR-level hold into per-commit rows, then clears it; a
	 * failed expansion leaves it in place, so the next tick retries the conversion.
	 */
	async legacyForkHoldBase(
		forkId: number,
		branchHash: string,
	): Promise<string | null> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ hold_base: string | null }, [number, string]>(
							"SELECT hold_base FROM fork_branch WHERE fork_id = ? AND branch_hash = ?",
						)
						.get(forkId, branchHash)
				)?.hold_base ?? null
			);
		});
	}

	/** Clears the retired cursor-hold base after a successful legacy conversion. */
	async clearLegacyForkHoldBase(
		forkId: number,
		branchHash: string,
	): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"UPDATE fork_branch SET hold_base = NULL WHERE fork_id = ? AND branch_hash = ?",
				[forkId, branchHash],
			);
		});
	}

	/** Upserts one branch watch row. */
	async saveForkBranch(s: ForkBranchState): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				`INSERT INTO fork_branch (fork_id, branch_hash, branch, head, analyzed_head, first_pending_at, last_run_at, last_error, retries)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(fork_id, branch_hash) DO UPDATE SET
			   branch = excluded.branch, head = excluded.head, analyzed_head = excluded.analyzed_head,
			   first_pending_at = excluded.first_pending_at, last_run_at = excluded.last_run_at,
			   last_error = excluded.last_error, retries = excluded.retries`,
				[
					s.forkId,
					s.branchHash,
					s.branch,
					s.head,
					s.analyzedHead,
					s.firstPendingAt,
					s.lastRunAt,
					s.lastError,
					s.retries,
				],
			);
		});
	}

	/** Analysis attempts started since `since` (project daily-rate gate). */
	async forkRunsSince(since: number): Promise<number> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ n: number }, [number]>(
							"SELECT COUNT(*) AS n FROM fork_runs WHERE started_at >= ?",
						)
						.get(since)
				)?.n ?? 0
			);
		});
	}

	async recordForkRun(forkId: number, at: number): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"INSERT INTO fork_runs (started_at, fork_id) VALUES (?, ?)",
				[at, forkId],
			);
		});
	}

	/** Drops watch rows of forks absent from the latest scan; an empty list clears the watch. */
	async deleteForkBranchesNotIn(ids: number[]): Promise<void> {
		return this.queue.transaction(async () => {
			if (ids.length === 0) {
				await this.db.run("DELETE FROM fork_branch");
				await this.db.run("DELETE FROM fork_hold");
				return;
			}
			const ph = ids.map(() => "?").join(", ");
			await this.db.run(
				`DELETE FROM fork_branch WHERE fork_id NOT IN (${ph})`,
				ids,
			);
			await this.db.run(
				`DELETE FROM fork_hold WHERE fork_id NOT IN (${ph})`,
				ids,
			);
		});
	}

	/**
	 * Creates a server-generated fork research result card with its held proposals and marks the
	 * analyzed branches — one transaction, so a restart cannot file the same result twice.
	 */
	async createForkResult(o: {
		prompt: string;
		title: string;
		report: string;
		topic: string;
		proposals: Array<{
			prompt: string;
			model: string | null;
		}>;
		analyzed: Array<{
			forkId: number;
			branchHash: string;
			head: string;
			at: number;
			/** Per-commit hold shas this run consumed; the rows die with the cursor advance. */
			consumed?: string[];
		}>;
	}): Promise<Task> {
		return this.queue.transaction(async () => {
			let cardId = "";
			{
				const card = await this.createTask(o.prompt);
				cardId = card.id;
				await this.updateTask(card.id, {
					title: o.title,
					promptAuthor: "board",
					research: true,
					stage: "done",
					state: "idle",
					report: o.report,
					topic: o.topic,
				});
				for (const p of o.proposals) {
					const child = await this.createTask(p.prompt);
					await this.updateTask(child.id, {
						followUpOf: card.id,
						promptAuthor: "board",
						state: "needs_you",
						needsReason: forkProposedReason({ id: card.id }),
						model: p.model,
					});
				}
				for (const a of o.analyzed) {
					await this.db.run(
						"UPDATE fork_branch SET analyzed_head = ?, first_pending_at = NULL, last_run_at = ?, last_error = NULL, retries = 0 WHERE fork_id = ? AND branch_hash = ?",
						[a.head, a.at, a.forkId, a.branchHash],
					);
					if (a.consumed && a.consumed.length > 0) {
						const ph = a.consumed.map(() => "?").join(", ");
						await this.db.run(
							`DELETE FROM fork_hold WHERE fork_id = ? AND branch_hash = ? AND sha IN (${ph})`,
							[a.forkId, a.branchHash, ...a.consumed],
						);
					}
				}
			}
			const card = await this.getTask(cardId);
			if (!card) throw new Error(`fork result card vanished: ${cardId}`);
			return card;
		});
	}

	// ---- Trending scout verdicts ----
	// A repo's verdict row is created on first judgement; `filed` and `no_fit` are final,
	// `deferred` is offered to the scout again next scan. The table is created by SCHEMA
	// at open, so existing databases gain it without a migration step.

	async listTrendingVerdicts(): Promise<TrendingVerdict[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<TrendingVerdictRow, []>(
						"SELECT * FROM trending_verdict ORDER BY judged_at DESC, repo",
					)
					.all()
			).map(rowToTrendingVerdict);
		});
	}

	async getTrendingVerdict(repo: string): Promise<TrendingVerdict | null> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<TrendingVerdictRow, [string]>(
					"SELECT * FROM trending_verdict WHERE repo = ?",
				)
				.get(repo.trim().toLowerCase());
			return row ? rowToTrendingVerdict(row) : null;
		});
	}

	/** Upserts by lowercase repo; an existing row keeps its firstSeenAt. */
	async saveTrendingVerdict(v: TrendingVerdict): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				`INSERT INTO trending_verdict (repo, verdict, reason, rejected_by_user, first_seen_at, judged_at, scout_card_id, proposal_card_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(repo) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason,
			   rejected_by_user = excluded.rejected_by_user, judged_at = excluded.judged_at,
			   scout_card_id = excluded.scout_card_id, proposal_card_id = excluded.proposal_card_id`,
				[
					v.repo.trim().toLowerCase(),
					v.verdict,
					v.reason,
					v.rejectedByUser ? 1 : 0,
					v.firstSeenAt,
					v.judgedAt,
					v.scoutCardId,
					v.proposalCardId,
				],
			);
		});
	}

	async trendingVerdictByProposal(
		cardId: string,
	): Promise<TrendingVerdict | null> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<TrendingVerdictRow, [string]>(
					"SELECT * FROM trending_verdict WHERE proposal_card_id = ?",
				)
				.get(cardId);
			return row ? rowToTrendingVerdict(row) : null;
		});
	}

	/** Shared scout + repo checks of the agent's verdict tools; returns the error or the normalized repo. */
	private async checkTrendingJudgement(
		scoutId: string,
		repo: string,
	): Promise<{ ok: true; repo: string } | { ok: false; error: string }> {
		return this.queue.run<
			{ ok: true; repo: string } | { ok: false; error: string }
		>(async () => {
			const scout = await this.getTask(scoutId);
			if (
				scout?.kind !== "trending" ||
				scout.cancelledAt !== null ||
				scout.stage === "done"
			)
				return { ok: false, error: "not an open trending scout card" };
			const norm = repo.trim().toLowerCase();
			if (!TRENDING_REPO_RE.test(norm))
				return {
					ok: false,
					error: `invalid repo: ${repo} (expected owner/repo)`,
				};
			const prev = await this.getTrendingVerdict(norm);
			if (prev && prev.verdict !== "deferred")
				return {
					ok: false,
					error: `${norm} already has a final verdict (${prev.verdict})`,
				};
			return { ok: true, repo: norm };
		});
	}

	/** Files a backlog proposal card for `repo` under the scout card, at most `cap` per scout card. */
	async fileTrendingProposal(o: {
		scoutId: string;
		repo: string;
		prompt: string;
		title?: string;
		cap: number;
		now?: number;
	}): Promise<{ ok: true; task: Task } | { ok: false; error: string }> {
		return this.queue.transaction<
			{ ok: true; task: Task } | { ok: false; error: string }
		>(async () => {
			const now = o.now ?? Date.now();
			const res = await this.transaction(
				async (): Promise<
					{ ok: true; id: string } | { ok: false; error: string }
				> => {
					const check = await this.checkTrendingJudgement(o.scoutId, o.repo);
					if (!check.ok) return check;
					const filed =
						(
							await this.db
								.query<{ n: number }, [string]>(
									"SELECT COUNT(*) AS n FROM trending_verdict WHERE scout_card_id = ? AND proposal_card_id IS NOT NULL",
								)
								.get(o.scoutId)
						)?.n ?? 0;
					if (filed >= o.cap)
						return {
							ok: false,
							error: `cap of ${o.cap} proposals per scan reached: record ${check.repo} as deferred instead`,
						};
					const card = await this.createTask(o.prompt, null);
					const title = o.title?.trim();
					await this.updateTask(card.id, {
						promptAuthor: "board",
						stage: "backlog",
						state: "idle",
						queuedAt: null,
						followUpOf: o.scoutId,
						...(title ? { title } : {}),
					});
					const prev = await this.getTrendingVerdict(check.repo);
					await this.saveTrendingVerdict({
						repo: check.repo,
						verdict: "filed",
						reason: "Filed as a proposal",
						rejectedByUser: false,
						firstSeenAt: prev?.firstSeenAt ?? now,
						judgedAt: now,
						scoutCardId: o.scoutId,
						proposalCardId: card.id,
					});
					return { ok: true, id: card.id };
				},
			);
			if (!res.ok) return res;
			const task = await this.getTask(res.id);
			if (!task) throw new Error(`trending proposal vanished: ${res.id}`);
			return { ok: true, task };
		});
	}

	/** Records `no_fit` (final) or `deferred` (offered again next scan) for a repo the scout judged. */
	async judgeTrendingRepo(o: {
		scoutId: string;
		repo: string;
		verdict: "no_fit" | "deferred";
		reason: string;
		now?: number;
	}): Promise<{ ok: true } | { ok: false; error: string }> {
		return this.queue.transaction<{ ok: true } | { ok: false; error: string }>(
			async () => {
				const now = o.now ?? Date.now();
				const reason = o.reason.trim().slice(0, 500);
				const check = await this.checkTrendingJudgement(o.scoutId, o.repo);
				if (!check.ok) return check;
				if (reason === "") return { ok: false, error: "reason is required" };
				const prev = await this.getTrendingVerdict(check.repo);
				await this.saveTrendingVerdict({
					repo: check.repo,
					verdict: o.verdict,
					reason,
					rejectedByUser: false,
					firstSeenAt: prev?.firstSeenAt ?? now,
					judgedAt: now,
					scoutCardId: o.scoutId,
					proposalCardId: null,
				});
				return { ok: true };
			},
		);
	}

	/** A cancelled proposal card turns its repo into a user-rejected `no_fit`; false when the card is no filed proposal. */
	async rejectTrendingProposal(
		cardId: string,
		reason: string | null,
		now: number = Date.now(),
	): Promise<boolean> {
		return this.queue.run(async () => {
			const note = reason?.trim() || "Rejected by the user (no reason given)";
			const res = await this.db.run(
				`UPDATE trending_verdict SET verdict = 'no_fit', rejected_by_user = 1, reason = ?, judged_at = ?
			 WHERE proposal_card_id = ? AND verdict = 'filed'`,
				[note, now, cardId],
			);
			return res.changes > 0;
		});
	}

	// ---- PR review watch state ----

	async listPrReviews(): Promise<PrReviewRow[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<PrReviewDbRow, []>("SELECT * FROM pr_review ORDER BY number")
					.all()
			).map(toPrReview);
		});
	}

	async getPrReview(number: number): Promise<PrReviewRow | null> {
		return this.queue.run(async () => {
			const r = await this.db
				.query<PrReviewDbRow, [number]>(
					"SELECT * FROM pr_review WHERE number = ?",
				)
				.get(number);
			return r ? toPrReview(r) : null;
		});
	}

	/** One issue_watch row by GitHub issue number, or null. */
	async getIssueWatch(number: number): Promise<{
		number: number;
		taskId: string | null;
		labelled: boolean;
		filedAt: number;
	} | null> {
		return this.queue.run(async () => {
			const r = await this.db
				.query<
					{
						number: number;
						task_id: string | null;
						labelled: number;
						filed_at: number;
					},
					[number]
				>("SELECT * FROM issue_watch WHERE number = ?")
				.get(number);
			return r
				? {
						number: r.number,
						taskId: r.task_id,
						labelled: r.labelled !== 0,
						filedAt: r.filed_at,
					}
				: null;
		});
	}

	/** Count of issue cards filed at or after `since`. */
	async issueCardsFiledSince(since: number): Promise<number> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ n: number }, [number]>(
							"SELECT COUNT(*) AS n FROM issue_watch WHERE filed_at >= ?",
						)
						.get(since)
				)?.n ?? 0
			);
		});
	}

	/** Files a backlog card for an issue and records its watch row in one transaction; throws if the issue was already filed. */
	async fileIssueCard(o: {
		number: number;
		title: string;
		prompt: string;
		now: number;
	}): Promise<Task> {
		return this.queue.transaction(async () => {
			const card = await this.createTask(o.prompt, null, "work");
			await this.updateTask(card.id, {
				title: o.title,
				// The prompt embeds the issue's title and body, which a person wrote, so
				// the card stays user-authored and the prompt gate judges it (OTTR-850).
				topic: "github issue",
				stage: "backlog",
				state: "idle",
				queuedAt: null,
			});
			await this.db.run(
				"INSERT INTO issue_watch (number, task_id, labelled, filed_at) VALUES (?, ?, 0, ?)",
				[o.number, card.id, o.now],
			);
			const id = card.id;
			const task = await this.getTask(id);
			if (task === null) throw new Error(`unknown task: ${id}`);
			return task;
		});
	}

	/** key -> task id for keys already imported from site whose task row still exists (any stage, cancelled too). Rows for missing tasks are ignored. */
	async jiraImported(
		site: string,
		keys: string[],
	): Promise<Map<string, string>> {
		return this.queue.run(async () => {
			const out = new Map<string, string>();
			const q = this.db.query<{ task_id: string }, [string, string]>(
				"SELECT j.task_id FROM jira_imports j JOIN tasks t ON t.id = j.task_id WHERE j.site = ? AND j.issue_key = ?",
			);
			for (const key of keys) {
				const r = await q.get(site, key);
				if (r) out.set(key, r.task_id);
			}
			return out;
		});
	}

	/** Files one card for each Jira issue not yet imported from site, in one transaction; backlog cards wait idle like fileIssueCard, todo cards queue like createTask. */
	async fileJiraCards(o: {
		site: string;
		stage: "backlog" | "todo";
		items: { key: string; title: string; prompt: string }[];
		now: number;
	}): Promise<{ filed: Task[]; skipped: string[] }> {
		return this.queue.transaction(async () => {
			const done = await this.jiraImported(
				o.site,
				o.items.map((i) => i.key),
			);
			const ids: string[] = [];
			const skipped: string[] = [];
			for (const item of o.items) {
				if (done.has(item.key)) {
					skipped.push(item.key);
					continue;
				}
				const card = await this.createTask(item.prompt, null, "work");
				await this.updateTask(card.id, {
					title: item.title,
					// The prompt embeds the ticket's summary, description and comments,
					// which people wrote, so the card stays user-authored and the prompt
					// gate judges it (OTTR-850).
					topic: "jira",
					...(o.stage === "backlog"
						? { stage: "backlog", state: "idle", queuedAt: null }
						: {}),
				});
				await this.db.run(
					"INSERT INTO jira_imports (site, issue_key, task_id, filed_at) VALUES (?, ?, ?, ?) ON CONFLICT(site, issue_key) DO UPDATE SET task_id = excluded.task_id, filed_at = excluded.filed_at",
					[o.site, item.key, card.id, o.now],
				);
				done.set(item.key, card.id);
				ids.push(card.id);
			}
			const filed = await Promise.all(
				ids.map(async (id) => {
					const task = await this.getTask(id);
					if (task === null) throw new Error(`unknown task: ${id}`);
					return task;
				}),
			);
			return { filed, skipped };
		});
	}

	/** Issue numbers filed but not yet labelled on GitHub, ascending. */
	async unlabelledIssues(): Promise<number[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<{ number: number }, []>(
						"SELECT number FROM issue_watch WHERE labelled = 0 ORDER BY number",
					)
					.all()
			).map((r) => r.number);
		});
	}

	/** Marks an issue's tracking label as applied. */
	async markIssueLabelled(number: number): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"UPDATE issue_watch SET labelled = 1 WHERE number = ?",
				[number],
			);
		});
	}

	async getPrReviewByTask(taskId: string): Promise<PrReviewRow | null> {
		return this.queue.run(async () => {
			const r = await this.db
				.query<PrReviewDbRow, [string]>(
					"SELECT * FROM pr_review WHERE task_id = ?",
				)
				.get(taskId);
			return r ? toPrReview(r) : null;
		});
	}

	/** Upserts one PR watch row by PR number. */
	async savePrReview(row: PrReviewRow): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				`INSERT INTO pr_review (number, task_id, head, first_seen_at, reviewed_head, posted_head, posted_url, posted_login, state, draft, title, post_error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(number) DO UPDATE SET
			   task_id = excluded.task_id, head = excluded.head, first_seen_at = excluded.first_seen_at,
			   reviewed_head = excluded.reviewed_head, posted_head = excluded.posted_head, posted_url = excluded.posted_url,
			   posted_login = excluded.posted_login,
			   state = excluded.state, draft = excluded.draft, title = excluded.title, post_error = excluded.post_error`,
				[
					row.number,
					row.taskId,
					row.head,
					row.firstSeenAt,
					row.reviewedHead,
					row.postedHead,
					row.postedUrl,
					row.postedLogin,
					row.state,
					row.draft ? 1 : 0,
					row.title,
					row.postError,
				],
			);
		});
	}

	/** Sets only the PR state, so a write after an await never reverts post fields. */
	async setPrState(number: number, state: PrReviewRow["state"]): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run("UPDATE pr_review SET state = ? WHERE number = ?", [
				state,
				number,
			]);
		});
	}

	/** Stores the posted review's html_url and posting login after a successful Post; null clears both. */
	async setPrPostedUrl(
		number: number,
		url: string | null,
		login: string | null = null,
	): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"UPDATE pr_review SET posted_url = ?, posted_login = ? WHERE number = ?",
				[url, login, number],
			);
		});
	}

	/** Writes the two comment columns only: the sweep's cutoff and the unseen flag. */
	async setPrComments(
		number: number,
		at: number,
		unseen: boolean,
	): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"UPDATE pr_review SET comments_at = ?, comments_unseen = ? WHERE number = ?",
				[at, unseen ? 1 : 0, number],
			);
		});
	}

	/** The PR's newest done review run id: the draft occurrence stamp. Null without a done run. */
	async lastPrRun(number: number): Promise<number | null> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ id: number }, [number]>(
							"SELECT id FROM pr_review_runs WHERE number = ? AND done = 1 ORDER BY id DESC LIMIT 1",
						)
						.get(number)
				)?.id ?? null
			);
		});
	}

	/** Whether the PR's newest done review run found blocking findings. True without a done
	 * run or an unset column, so an unknown verdict never approves a PR. */
	async lastPrRunBlocking(number: number): Promise<boolean> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<{ blocking: number | null }, [number]>(
					"SELECT blocking FROM pr_review_runs WHERE number = ? AND done = 1 ORDER BY id DESC LIMIT 1",
				)
				.get(number);
			return (row?.blocking ?? 1) !== 0;
		});
	}

	/**
	 * Claims the post of `head` in one statement before the GitHub call: only an open PR whose
	 * reviewed head is `head` and not yet posted wins, so two concurrent Posts send one review.
	 * Returns the earlier posted head for releasePrPost, or undefined when the claim lost.
	 */
	async claimPrPost(
		number: number,
		head: string,
	): Promise<string | null | undefined> {
		return this.queue.transaction(async () => {
			const prev = await this.getPrReview(number);
			const res = await this.db.run(
				`UPDATE pr_review SET posted_head = ?, post_error = NULL
				 WHERE number = ? AND state = 'open' AND reviewed_head = ?
				   AND (posted_head IS NULL OR posted_head != ?)`,
				[head, number, head, head],
			);
			return res.changes === 1 ? (prev?.postedHead ?? null) : undefined;
		});
	}

	/** Undoes a failed claim: restores the earlier posted head and stores the error; other fields stay. */
	async releasePrPost(
		number: number,
		head: string,
		prev: string | null,
		error: string,
	): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"UPDATE pr_review SET posted_head = ?, post_error = ? WHERE number = ? AND posted_head = ?",
				[prev, error, number, head],
			);
		});
	}

	/** Review starts since `since` (project daily-rate gate). */
	async prReviewRunsSince(since: number): Promise<number> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ n: number }, [number]>(
							"SELECT COUNT(*) AS n FROM pr_review_runs WHERE started_at >= ?",
						)
						.get(since)
				)?.n ?? 0
			);
		});
	}

	/** One review per PR per head SHA: true once a draft of this PR's `head` was saved. */
	async prHeadReviewed(number: number, head: string): Promise<boolean> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ n: number }, [number, string]>(
							"SELECT COUNT(*) AS n FROM pr_review_runs WHERE number = ? AND head = ? AND done = 1",
						)
						.get(number, head)
				)?.n !== 0
			);
		});
	}

	/**
	 * The latest done run's start for this number+head: a never-posted draft's re-review cutoff.
	 * null when none (a null head was never reviewed); undone runs count as no review yet.
	 */
	async lastPrRunAt(
		number: number,
		head: string | null,
	): Promise<number | null> {
		return this.queue.run(async () => {
			if (head === null) return null;
			return (
				(
					await this.db
						.query<{ started_at: number }, [number, string]>(
							"SELECT started_at FROM pr_review_runs WHERE number = ? AND head = ? AND done = 1 ORDER BY started_at DESC LIMIT 1",
						)
						.get(number, head)
				)?.started_at ?? null
			);
		});
	}

	/** Counts one review attempt (the daily cap) before the model call; returns its run id. */
	async startPrRun(number: number, head: string, at: number): Promise<number> {
		return this.queue.transaction(async () => {
			return sqliteNumber(
				(
					await this.db.run(
						"INSERT INTO pr_review_runs (number, started_at, head) VALUES (?, ?, ?)",
						[number, at, head],
					)
				).lastInsertRowid,
			);
		});
	}

	/**
	 * Saves a review draft in one transaction: files the PR's card with the draft as its
	 * details (or updates the existing card), marks `head` reviewed and the run done, then
	 * lets syncPrCard place the card. It runs after the model call, so it writes only its
	 * own columns of the live row.
	 */
	async savePrDraft(o: {
		run: number;
		number: number;
		head: string;
		draft: string;
		prompt: string;
		blocking: boolean;
	}): Promise<Task> {
		return this.queue.transaction(async () => {
			let cardId = "";
			{
				const row = await this.getPrReview(o.number);
				if (!row) throw new Error(`unknown pr_review: #${o.number}`);
				const summary = `Review draft for head ${o.head.slice(0, 7)}.`;
				const existing =
					row.taskId === null ? null : await this.getTask(row.taskId);
				const card =
					existing ?? (await this.createTask(o.prompt, null, "pr_review"));
				await this.updateTask(card.id, {
					promptAuthor: "board",
					...(existing === null
						? {
								title: `PR review: #${o.number} ${row.title}`,
								topic: "pr review",
							}
						: { prompt: o.prompt }),
					// A new card leaves the queue here; syncPrCard sets its final place below.
					...(existing === null ? { stage: "in_progress", state: "idle" } : {}),
					queuedAt: null,
					summary,
					details: o.draft,
				});
				cardId = card.id;
				await this.db.run(
					"UPDATE pr_review SET task_id = ?, reviewed_head = ?, post_error = NULL WHERE number = ?",
					[card.id, o.head, o.number],
				);
				await this.db.run(
					"UPDATE pr_review_runs SET done = 1, blocking = ? WHERE id = ?",
					[o.blocking ? 1 : 0, o.run],
				);
				await this.syncPrCard(o.number);
			}
			const card = await this.getTask(cardId);
			if (!card) throw new Error(`pr review card vanished: ${cardId}`);
			return card;
		});
	}

	/**
	 * Places a PR review card from its row: an open PR with an unposted draft waits at
	 * needs_you; posted, closed or merged goes to done/idle. A cancelled card or a row without
	 * a card stays. Writes only on a difference, so done_at is not stamped again.
	 */
	async syncPrCard(number: number): Promise<void> {
		return this.queue.transaction(async () => {
			const row = await this.getPrReview(number);
			if (!row || row.taskId === null) return;
			const card = await this.getTask(row.taskId);
			if (!card || card.cancelledAt !== null) return;
			const waiting =
				row.state === "open" &&
				card.details !== null &&
				row.postedHead !== row.reviewedHead;
			const want = waiting
				? ({
						stage: "in_progress",
						state: "needs_you",
						needsReason: PR_REVIEW_WAITING,
					} as const)
				: ({ stage: "done", state: "idle", needsReason: null } as const);
			if (
				card.stage === want.stage &&
				card.state === want.state &&
				card.needsReason === want.needsReason
			)
				return;
			await this.updateTask(card.id, want);
		});
	}

	/**
	 * The project's task id handle: the taskIdPrefix setting or the folder-derived default.
	 * Defensive normalization covers values stored by direct setSettings callers that bypass
	 * the API's validation. Public for the cross-project dependsOn resolver (OTTR-708).
	 */
	async taskPrefix(): Promise<string> {
		return this.queue.run(async () => {
			const p = (await this.getSettings()).taskIdPrefix;
			if (p !== null) {
				const s = p.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase();
				if (s !== "") return s;
			}
			return derivedTaskPrefix(this.name);
		});
	}

	/** Next `PREFIX-n` id; the per-store counter only ever increments (no reuse). */
	private async nextTaskId(): Promise<string> {
		return this.queue.transaction(async () => {
			const row = await this.db
				.query<{ value: string }, []>(
					"SELECT value FROM settings WHERE key = 'next-task-num'",
				)
				.get();
			const n = row ? parseInt(row.value, 10) : NaN;
			const current = Number.isInteger(n) && n >= 1 ? n : 1;
			await this.db.run(
				"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				["next-task-num", JSON.stringify(current + 1)],
			);
			return `${await this.taskPrefix()}-${current}`;
		});
	}

	async createTask(
		prompt: string,
		model: string | null = null,
		kind: TaskKind = "work",
		id?: string,
	): Promise<Task> {
		return this.queue.transaction(async () => {
			const now = Date.now();
			const title = deriveTitle(prompt);
			// An explicit id (a retro child `<source id>-retro`) skips the counter: no number is
			// consumed, so visible cards keep gap-free ids. A taken id gets -2, -3, ...: no id
			// is ever reused and the loop ends because the store holds finitely many ids.
			let usedId: string;
			if (id === undefined) {
				usedId = await this.nextTaskId();
				while ((await this.getTask(usedId)) !== null) {
					// Each retry consumes the next counter value: no reuse, guaranteed termination.
					usedId = await this.nextTaskId();
				}
			} else {
				if (id === "") throw new Error("createTask: an explicit id is empty");
				usedId = id;
				for (let n = 2; (await this.getTask(usedId)) !== null; n++)
					usedId = `${id}-${n}`;
			}
			await this.db.run(
				"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at, queued_at, model, kind) VALUES (?, ?, ?, 'todo', 'queued', ?, ?, ?, ?, ?)",
				[usedId, title, prompt, now, now, now, model, kind],
			);
			await this.recordEvent("create", usedId, null, "todo", null);
			await this.recordEvent("state", usedId, null, "queued", null);
			// Read the row back instead of hand-building the literal (R4-9): defaults and the
			// toTask normalizer stay in one place, so the returned Task can't drift from the DB.
			const task = await this.getTask(usedId);
			if (!task) throw new Error(`unknown task: ${usedId}`);
			return task;
		});
	}

	/** Rewrites an unstarted task's prompt; the title re-derives like on create. Clears the
	 * prompt-edit hold in the same write: the edit finished, so the card may start. With
	 * expectedRevision the write only lands when the row's revision still matches. */
	async editTask(
		id: string,
		prompt: string,
		expectedRevision?: number,
	): Promise<RevisionResult> {
		return this.queue.run(async () => {
			return await this.runTaskUpdate(
				id,
				{
					prompt,
					title: deriveTitle(prompt),
					// OTTR-850: a user edit makes the prompt user-authored again, so the gate
					// judges it even when the card was filed as board-written.
					promptAuthor: "user",
					holdUntil: null,
					holdProvider: null,
					holdWindow: null,
				},
				expectedRevision,
			);
		});
	}

	async getTask(id: string): Promise<Task | null> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?")
				.get(id);
			return row ? toTask(this.name, row) : null;
		});
	}

	async listTasks(): Promise<ListedTask[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<Omit<TaskRow, "diff_text">, []>(
						`SELECT ${TASK_LIST_COLUMNS} FROM tasks ORDER BY created_at DESC, rowid DESC`,
					)
					.all()
			).map((row) => toListedTask(this.name, row));
		});
	}

	async claimTurn(
		id: string,
		gate: (
			task: Task,
			settings: ProjectSettings,
			tasks: ListedTask[],
			boardCheckId: string | null,
		) =>
			| { allow: boolean; needsReason?: string }
			| Promise<{ allow: boolean; needsReason?: string }>,
	): Promise<Task | null> {
		return this.transaction(async () => {
			const task = await this.getTask(id);
			if (task === null || task.state !== "queued" || task.cancelledAt !== null)
				return null;
			const decision = await gate(
				task,
				await this.getSettings(),
				await this.listTasks(),
				await this.boardCheckId(),
			);
			if (!decision.allow) {
				if (
					decision.needsReason !== undefined &&
					decision.needsReason !== task.needsReason
				)
					await this.updateTask(id, { needsReason: decision.needsReason });
				return null;
			}
			await this.updateTask(id, {
				state: "preparing",
				needsReason: null,
				asked: null,
			});
			return task;
		});
	}

	async updateTask(id: string, patch: TaskPatch): Promise<Task> {
		return this.queue.run(async () => {
			// Unguarded: internal writers (scheduler, turn loop, quota sweep) never fail on a
			// revision; the write itself still bumps it.
			return (await this.runTaskUpdate(id, patch)).task;
		});
	}

	/** Optimistic write for user edits from routes: lands only while the row's revision
	 * still equals expectedRevision. On a conflict nothing is written and the current
	 * row comes back for the 409 body. */
	async updateTaskIfCurrent(
		id: string,
		patch: TaskPatch,
		expectedRevision: number,
	): Promise<RevisionResult> {
		return this.queue.run(async () => {
			return await this.runTaskUpdate(id, patch, expectedRevision);
		});
	}

	/** The prompt-edit hold: contentless bookkeeping, so it never moves the revision —
	 * the editor's guarded save must not 409 against its own hold claim. With
	 * expectedRevision the claim lands only while that revision is current, so a
	 * content edit that landed between the editor's load and the claim refuses the
	 * claim (and the stale draft never arms); null claims unconditionally for
	 * body-less compatibility callers. */
	async claimPromptHold(
		id: string,
		holdUntil: number,
		expectedRevision: number | null,
	): Promise<RevisionResult> {
		return this.queue.run(async () => {
			return await this.runTaskUpdate(
				id,
				{ holdUntil, holdProvider: null, holdWindow: null },
				expectedRevision ?? undefined,
				false,
			);
		});
	}

	/** Clears the prompt-edit hold; contentless like the claim, so no revision bump. */
	async releasePromptHold(id: string): Promise<void> {
		return this.queue.run(async () => {
			await this.runTaskUpdate(
				id,
				{ holdUntil: null, holdProvider: null, holdWindow: null },
				undefined,
				false,
			);
		});
	}

	/** The one task UPDATE builder: unconditional for internal writers, and with an
	 * expectedRevision a single atomic `WHERE id = ? AND revision = ?` statement — the
	 * compare and the write never split, so a concurrent writer's bump (revision + 1 in
	 * the same UPDATE) makes this one's changes count 0 and nothing is written.
	 * `bumpRevision: false` is for the prompt-edit hold claim/release only: contentless
	 * bookkeeping must not move the revision the editor's guarded save arms from. */
	private async runTaskUpdate(
		id: string,
		patch: TaskPatch,
		expectedRevision?: number,
		bumpRevision = true,
	): Promise<RevisionResult> {
		return this.queue.transaction<RevisionResult>(async () => {
			const before = await this.getTask(id);
			if (before === null) throw new Error(`unknown task: ${id}`);
			const sets: string[] = ["updated_at = ?"];
			if (bumpRevision) sets.push("revision = revision + 1");
			const values: (string | number | null)[] = [Date.now()];
			// Entering Done stamps done_at; it overwrites, so a release card that bounced to needs_you re-lands with a fresh time.
			if (patch.stage === "done") {
				sets.push("done_at = ?");
				values.push(Date.now());
			}
			for (const key of Object.keys(TASK_COLUMNS) as (keyof TaskPatch)[]) {
				const value = patch[key];
				if (value !== undefined) {
					sets.push(`${TASK_COLUMNS[key]} = ?`);
					values.push(bindTaskValue(value));
				}
			}
			values.push(id);
			const { changes } =
				expectedRevision === undefined
					? await this.db.run(
							`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
							values,
						)
					: await this.db.run(
							`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND revision = ?`,
							[...values, expectedRevision],
						);
			// Guarded and stale: changes 0 means another writer moved the revision first.
			if (expectedRevision !== undefined && changes === 0)
				return { ok: false, task: (await this.getTask(id)) as Task };
			const task = (await this.getTask(id)) as Task;
			// Every stage/state write funnels through here, so this is the one place transitions get recorded — on success only.
			if (patch.stage !== undefined && patch.stage !== before.stage)
				await this.recordEvent("stage", id, before.stage, patch.stage, null);
			if (patch.state !== undefined && patch.state !== before.state)
				await this.recordEvent("state", id, before.state, patch.state, null);
			return { ok: true, task };
		});
	}

	async queueIds(): Promise<string[]> {
		return this.queue.run(async () => {
			return queueOrder(await this.listTasks()).map((t) => t.id);
		});
	}

	/** True iff `order` is an exact permutation of the current queue; then moves each task by writing future queuedAt. */
	async reorderQueue(order: string[]): Promise<boolean> {
		return this.queue.transaction(async () => {
			const current = await this.queueIds();
			if (
				order.length !== current.length ||
				new Set(order).size !== order.length
			)
				return false;
			const currentSet = new Set(current);
			if (order.some((id) => !currentSet.has(id))) return false;
			const now = Date.now();
			for (const [i, id] of order.entries())
				await this.updateTask(id, { queuedAt: now + i });
			return true;
		});
	}

	async startTurn(
		taskId: string,
		kind: TurnKind,
		prompt: string,
		pid: number | null,
		input: string | null = null,
		model: string | null = null,
		inputBy: "user" | "supervisor" | null = null,
		layer: string | null = null,
		logOffset: number | null = null,
		// The run's dispatch start, not the row-write time: the row is written after
		// startRun returns, so the write time can lag the true window start past a commit
		// that landed during startRun — the checkout guard's attribution would then
		// exclude the very turn that made the change (OTTR-772).
		startedAt: number = Date.now(),
	): Promise<Turn> {
		return this.queue.transaction(async () => {
			const { lastInsertRowid } = await this.db.run(
				"INSERT INTO turns (task_id, kind, prompt, input, input_by, started_at, pid, model, layer, log_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					taskId,
					kind,
					prompt,
					input,
					inputBy,
					startedAt,
					pid,
					model,
					layer,
					logOffset,
				],
			);
			// Read back (R4-9) so the returned Turn always matches the stored row and toTurn.
			const row = await this.db
				.query<TurnRow, [number | bigint]>("SELECT * FROM turns WHERE id = ?")
				.get(lastInsertRowid);
			if (!row) throw new Error(`unknown turn: ${lastInsertRowid}`);
			sqliteNumber(lastInsertRowid);
			return toTurn(row);
		});
	}

	async finishTurn(turnId: number, patch: TurnPatch): Promise<Turn> {
		const turn = await this.finishTurnState(turnId, patch);
		if (patch.endedAt !== undefined && turn.endedAt !== null)
			await this.captureTurnData(turnId);
		return turn;
	}

	async finishTurnState(turnId: number, patch: TurnPatch): Promise<Turn> {
		return this.transaction(async () => {
			const sets: string[] = [];
			const values: (string | number | null)[] = [];
			for (const key of Object.keys(TURN_COLUMNS) as (keyof TurnPatch)[]) {
				const value = patch[key];
				if (value !== undefined) {
					sets.push(`${TURN_COLUMNS[key]} = ?`);
					values.push(value as string | number | null);
				}
			}
			if (sets.length > 0) {
				values.push(turnId);
				await this.db.run(
					`UPDATE turns SET ${sets.join(", ")} WHERE id = ?`,
					values,
				);
			}
			const row = await this.db
				.query<TurnRow, [number]>("SELECT * FROM turns WHERE id = ?")
				.get(turnId);
			if (!row) throw new Error(`unknown turn: ${turnId}`);
			// A failed turn is an error event; a deliberate Cancel is not. `task_id` is NOT NULL in turns.
			if (
				patch.error !== undefined &&
				patch.error !== null &&
				patch.error !== "cancelled"
			)
				await this.recordEvent("error", row.task_id, null, null, patch.error);
			return toTurn(row);
		});
	}

	/** Reads transcript data outside the turn completion transaction. */
	async captureTurnData(turnId: number): Promise<void> {
		const { turn, task, contextTokens } = await this.queue.run(async () => {
			const turn = await this.db
				.query<TurnRow, [number]>("SELECT * FROM turns WHERE id = ?")
				.get(turnId);
			if (turn === null) throw new Error(`unknown turn: ${turnId}`);
			const context = await this.db
				.query<{ context_tokens: number | null }, [string]>(
					"SELECT context_tokens FROM tasks WHERE id = ?",
				)
				.get(turn.task_id);
			return {
				turn,
				task: await this.getTask(turn.task_id),
				contextTokens: context?.context_tokens ?? null,
			};
		});
		if (turn.ended_at === null || task === null) return;
		await this.captureTurnCost(
			turn.task_id,
			turnId,
			turn.started_at,
			turn.ended_at,
			task.sessionId,
		);
		await this.captureTaskContext(
			turn.task_id,
			false,
			task.sessionId,
			contextTokens,
		);
	}

	private async captureTurnCost(
		taskId: string,
		turnId: number,
		startedAt: number,
		endedAt: number,
		expectedSessionId?: string | null,
	): Promise<void> {
		const sessionId =
			expectedSessionId === undefined
				? ((await this.getTask(taskId))?.sessionId ?? null)
				: expectedSessionId;
		if (sessionId === null) return;
		let sum: UsageSum | null;
		try {
			sum = sumUsageIn(
				readTranscript(this.sessionsDir, sessionId),
				startedAt,
				endedAt,
			);
		} catch {
			return;
		}
		if (sum === null) return;
		await this.transaction(async () => {
			await this.db.run(
				`UPDATE turns SET tokens_in = ?, tokens_out = ?, cache_read = ?, cache_write = ?, cost = ?
				 WHERE id = ? AND task_id = ? AND started_at = ? AND ended_at = ? AND cost IS NULL
				   AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND session_id = ?)`,
				[
					sum.tokensIn,
					sum.tokensOut,
					sum.cacheRead,
					sum.cacheWrite,
					sum.cost,
					turnId,
					taskId,
					startedAt,
					endedAt,
					taskId,
					sessionId,
				],
			);
		});
	}

	private async captureTaskContext(
		taskId: string,
		doneOnly = false,
		expectedSessionId?: string | null,
		expectedContextTokens?: number | null,
	): Promise<void> {
		const task = await this.queue.run(async () => {
			return await this.db
				.query<
					{
						session_id: string | null;
						context_tokens: number | null;
						stage: string;
					},
					[string]
				>("SELECT session_id, context_tokens, stage FROM tasks WHERE id = ?")
				.get(taskId);
		});
		if (
			task === null ||
			(doneOnly && (task.stage !== "done" || task.context_tokens !== null))
		)
			return;
		if (
			expectedSessionId !== undefined &&
			task.session_id !== expectedSessionId
		)
			return;
		const ctx = sessionContext(this.sessionsDir, task.session_id);
		if (ctx === null) return;
		const previousContext =
			expectedContextTokens === undefined
				? task.context_tokens
				: expectedContextTokens;
		await this.transaction(async () => {
			await this.db.run(
				`UPDATE tasks SET context_tokens = ? WHERE id = ? AND session_id IS ?
				 AND context_tokens IS ?${doneOnly ? " AND stage = 'done' AND context_tokens IS NULL" : ""}`,
				[ctx.promptTokens, taskId, task.session_id, previousContext],
			);
		});
	}

	private async backfillTranscriptData(): Promise<void> {
		const pending = await this.queue.run(async () => {
			return await this.db
				.query<TurnRow, []>(
					"SELECT * FROM turns WHERE ended_at IS NOT NULL AND cost IS NULL ORDER BY id",
				)
				.all();
		});
		for (const turn of pending) {
			if (turn.ended_at !== null)
				await this.captureTurnCost(
					turn.task_id,
					turn.id,
					turn.started_at,
					turn.ended_at,
				);
		}
		const done = await this.queue.run(async () => {
			return await this.db
				.query<{ id: string }, []>(
					"SELECT id FROM tasks WHERE stage = 'done' AND context_tokens IS NULL",
				)
				.all();
		});
		for (const task of done) await this.captureTaskContext(task.id, true);
	}

	async listTurns(taskId: string): Promise<Turn[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<TurnRow, [string]>(
						"SELECT * FROM turns WHERE task_id = ? ORDER BY id",
					)
					.all(taskId)
			).map(toTurn);
		});
	}

	/** Every turn whose window [startedAt, endedAt or open] can overlap `since` or later:
	 * the cross-project checkout guard's attribution candidates (OTTR-763). */
	async openOrRecentTurns(since: number): Promise<Turn[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<TurnRow, [number]>(
						"SELECT * FROM turns WHERE ended_at IS NULL OR ended_at >= ? ORDER BY id",
					)
					.all(since)
			).map(toTurn);
		});
	}

	/** Layers of turns that never ended (boot reconcile source for in-use.json); distinct, null-free. */
	async listOpenTurnLayers(): Promise<string[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<{ layer: string }, []>(
						"SELECT DISTINCT layer FROM turns WHERE ended_at IS NULL AND layer IS NOT NULL",
					)
					.all()
			).map((r) => r.layer);
		});
	}

	/** Model of the task's newest turn that saw one (a run's snapshot); null when no turn recorded a model. */
	async lastTurnModel(taskId: string): Promise<string | null> {
		return this.queue.run(async () => {
			return (
				(
					await this.db
						.query<{ model: string | null }, [string]>(
							"SELECT model FROM turns WHERE task_id = ? AND model IS NOT NULL ORDER BY id DESC LIMIT 1",
						)
						.get(taskId)
				)?.model ?? null
			);
		});
	}

	/** Batched facts for the board card build, two queries per project: per-task turn
	 * facts (first open turn, newest model, last work outcome) and each task's raw stored
	 * session title. Replaces the two listTurns calls, the lastTurnModel query, the
	 * sessionTitle SELECT, and the no-op nameTask UPDATE the build ran per card. */
	async boardCardFacts(): Promise<{
		turns: Map<string, BoardTurnFacts>;
		/** Raw stored session_title per task id; frozenTitleFrom applies the cleaning. */
		titles: Map<string, string | null>;
		/** Per pr_review card: the draft run stamp and the unseen comment stamp. */
		pr: Map<string, { draft: number | null; comments: number | null }>;
	}> {
		return this.queue.run(async () => {
			const turns = await this.boardTurnFacts();
			const titles = await this.boardTitleFacts(turns);
			const pr = await this.boardPrFacts();
			return { turns, titles, pr };
		});
	}

	/** Turn facts per task: first open turn, newest model, last work outcome. */
	private async boardTurnFacts(): Promise<Map<string, BoardTurnFacts>> {
		return this.queue.run(async () => {
			const turns = new Map<string, BoardTurnFacts>();
			const factsFor = (taskId: string): BoardTurnFacts => {
				let f = turns.get(taskId);
				if (f === undefined) {
					f = { openTurn: null, lastModel: null, lastWorkOutcome: null };
					turns.set(taskId, f);
				}
				return f;
			};
			for (const r of await this.db
				.query<
					{
						task_id: string;
						started_at: number;
						ended_at: number | null;
						kind: string;
						model: string | null;
						outcome: string | null;
					},
					[]
				>(
					"SELECT task_id, started_at, ended_at, kind, model, outcome FROM turns ORDER BY id",
				)
				.all()) {
				const f = factsFor(r.task_id);
				// The first open turn in id order is the one listTurns().find() reported.
				if (r.ended_at === null && f.openTurn === null)
					f.openTurn = {
						startedAt: r.started_at,
						kind: r.kind as TurnKind,
						model: r.model,
					};
				// Ascending id: the last non-null write is the newest, like lastTurnModel.
				if (r.model !== null) f.lastModel = r.model;
				if (r.kind === "work")
					f.lastWorkOutcome = r.outcome as OutcomeStatus | null;
			}
			return turns;
		});
	}

	/** Raw stored session_title per task; also seeds an all-null fact row per task,
	 * so a turn-less task reads as all-null, not missing. */
	private async boardTitleFacts(
		turns: Map<string, BoardTurnFacts>,
	): Promise<Map<string, string | null>> {
		return this.queue.run(async () => {
			const titles = new Map<string, string | null>();
			for (const r of await this.db
				.query<{ id: string; session_title: string | null }, []>(
					"SELECT id, session_title FROM tasks",
				)
				.all()) {
				titles.set(r.id, r.session_title);
				// Total over the task rows: a turn-less task reads as all-null, not missing.
				if (!turns.has(r.id))
					turns.set(r.id, {
						openTurn: null,
						lastModel: null,
						lastWorkOutcome: null,
					});
			}
			return titles;
		});
	}

	/** One grouped query and one row scan per project: the occurrence stamps the board
	 * build and the alert diff read for pr_review cards. */
	private async boardPrFacts(): Promise<
		Map<string, { draft: number | null; comments: number | null }>
	> {
		return this.queue.run(async () => {
			const pr = new Map<
				string,
				{ draft: number | null; comments: number | null }
			>();
			const runs = new Map<number, number>();
			for (const r of await this.db
				.query<{ number: number; id: number }, []>(
					"SELECT number, MAX(id) AS id FROM pr_review_runs WHERE done = 1 GROUP BY number",
				)
				.all())
				runs.set(r.number, r.id);
			for (const row of await this.listPrReviews()) {
				if (row.taskId === null) continue;
				pr.set(row.taskId, {
					draft: runs.get(row.number) ?? null,
					comments:
						row.commentsUnseen && row.commentsAt !== null
							? row.commentsAt
							: null,
				});
			}
			return pr;
		});
	}

	/** The task's newest settled turn (id, error, reported outcome, exit code), or null; one
	 * indexed row for the alert diff. */
	async lastSettledTurn(taskId: string): Promise<{
		id: number;
		error: string | null;
		outcome: string | null;
		exitCode: number | null;
	} | null> {
		return this.queue.run(async () => {
			return (
				(await this.db
					.query<
						{
							id: number;
							error: string | null;
							outcome: string | null;
							exitCode: number | null;
						},
						[string]
					>(
						"SELECT id, error, outcome, exit_code AS exitCode FROM turns WHERE task_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1",
					)
					.get(taskId)) ?? null
			);
		});
	}

	/** Appends one lifecycle event; every stat derives from this log plus the tasks and turns tables. */
	private async recordEvent(
		kind: StatEvent["kind"],
		taskId: string | null,
		from: string | null,
		to: string | null,
		detail: string | null,
	): Promise<void> {
		return this.queue.run(async () => {
			await this.db.run(
				"INSERT INTO events (at, task_id, kind, from_value, to_value, detail) VALUES (?, ?, ?, ?, ?, ?)",
				[Date.now(), taskId, kind, from, to, detail],
			);
		});
	}

	/** All lifecycle events, oldest first: the raw feed a stats dashboard reads. */
	async events(): Promise<StatEvent[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<
						{
							at: number;
							task_id: string | null;
							kind: StatEvent["kind"];
							from_value: string | null;
							to_value: string | null;
							detail: string | null;
						},
						[]
					>(
						"SELECT at, task_id, kind, from_value, to_value, detail FROM events ORDER BY id",
					)
					.all()
			).map((r) => ({
				at: r.at,
				taskId: r.task_id,
				kind: r.kind,
				from: r.from_value,
				to: r.to_value,
				detail: r.detail,
			}));
		});
	}

	/**
	 * Raw completed-turn durations for the ETA medians; shapes facts only —
	 * the median and the history threshold live in perf.ts (turnMedians).
	 * `ended_at >= started_at` filters stamp glitches.
	 */
	async turnDurations(): Promise<
		Array<{ kind: TurnKind; model: string | null; ms: number }>
	> {
		return this.queue.run(async () => {
			return await this.db
				.query<{ kind: TurnKind; model: string | null; ms: number }, []>(
					"SELECT kind, model, ended_at - started_at AS ms FROM turns WHERE ended_at IS NOT NULL AND ended_at >= started_at",
				)
				.all();
		});
	}

	/**
	 * The Overview performance facts of this project: flat task
	 * and turn rows for the pure perfMetrics. A few aggregates, no N+1: a task's done
	 * time is its latest stage→done event, the first-pass penalty any needs_you state
	 * event, and a turn fails on a real error or a non-zero exit (SQL semantics: a NULL
	 * exit_code is not `<> 0`).
	 */
	async perfFacts(): Promise<PerfFacts> {
		return this.queue.run(async () => {
			const tasks = await this.db
				.query<
					{
						id: string;
						created_at: number;
						cancelled_at: number | null;
						context_tokens: number | null;
					},
					[]
				>("SELECT id, created_at, cancelled_at, context_tokens FROM tasks")
				.all();
			const doneAt = new Map(
				(
					await this.db
						.query<{ task_id: string; at: number }, []>(
							"SELECT task_id, MAX(at) AS at FROM events WHERE kind = 'stage' AND to_value = 'done' GROUP BY task_id",
						)
						.all()
				).map((r): [string, number] => [r.task_id, r.at]),
			);
			const needsYou = new Set(
				(
					await this.db
						.query<{ task_id: string }, []>(
							"SELECT DISTINCT task_id FROM events WHERE kind = 'state' AND to_value = 'needs_you' AND task_id IS NOT NULL",
						)
						.all()
				).map((r) => r.task_id),
			);
			const workTurns = new Map(
				(
					await this.db
						.query<{ task_id: string; n: number }, []>(
							"SELECT task_id, COUNT(*) AS n FROM turns WHERE kind = 'work' GROUP BY task_id",
						)
						.all()
				).map((r): [string, number] => [r.task_id, r.n]),
			);
			const turns = await this.db
				.query<
					{
						ended_at: number;
						error: string | null;
						exit_code: number | null;
						cost: number | null;
					},
					[]
				>(
					"SELECT ended_at, error, exit_code, cost FROM turns WHERE ended_at IS NOT NULL",
				)
				.all();
			return {
				tasks: tasks.map((t) => ({
					id: t.id,
					project: this.name,
					createdAt: t.created_at,
					doneAt: doneAt.get(t.id) ?? null,
					cancelled: t.cancelled_at !== null,
					workTurns: workTurns.get(t.id) ?? 0,
					hadNeedsYou: needsYou.has(t.id),
					contextTokens: t.context_tokens,
				})),
				turns: turns.map((t) => ({
					endedAt: t.ended_at,
					failed:
						(t.error !== null && t.error !== "cancelled") ||
						(t.exit_code !== null && t.exit_code !== 0),
					cost: t.cost,
				})),
			};
		});
	}

	/** Stores one arrived review finding; returns true when it was new (not a duplicate of a
	 * stored prompt). A new finding clears the card's findingsCheckedAt in the same
	 * transaction, so the next landing re-runs the review check. */
	async appendReviewFinding(
		cardId: string,
		finding: RecordedFinding,
	): Promise<boolean> {
		return this.queue.transaction(async () => {
			const result = await this.db.run(
				"INSERT INTO review_findings (card_id, prompt, model, rank, security, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(card_id, prompt) DO NOTHING",
				[
					cardId,
					finding.prompt,
					finding.model,
					finding.rank,
					finding.security,
					Date.now(),
				],
			);
			if (result.changes === 0) return false;
			await this.db.run(
				"UPDATE tasks SET findings_checked_at = NULL WHERE id = ? AND findings_checked_at IS NOT NULL",
				[cardId],
			);
			return true;
		});
	}

	/** The card's stored review findings in arrival order. */
	async listReviewFindings(cardId: string): Promise<RecordedFinding[]> {
		return this.queue.run(async () => {
			return (
				await this.db
					.query<
						{
							prompt: string;
							model: string | null;
							rank: number | null;
							security: string | null;
						},
						[string]
					>(
						"SELECT prompt, model, rank, security FROM review_findings WHERE card_id = ? ORDER BY id",
					)
					.all(cardId)
			).map((r) => ({
				prompt: r.prompt,
				model: r.model,
				rank: r.rank,
				security: (r.security as RecordedFinding["security"]) ?? null,
			}));
		});
	}

	/** Snapshot copy of tasks.db for the backup (docs/specs/db-backup.md); `dest` must not exist. */
	async backupTo(dest: string): Promise<void> {
		return this.queue.run(async () => {
			await vacuumInto(this.db, dest, ["tasks", "turns"]);
		});
	}

	async close(): Promise<void> {
		await this.queue.close(async () => {
			await closeLocked(this.db);
		});
	}
}
