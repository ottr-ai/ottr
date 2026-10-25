import { Database } from "bun:sqlite";
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
import { closeLocked, openLocked, StoreLockedError } from "./dblock.ts";
import type { PerfFacts } from "./perf.ts";
import { platform } from "./platform/index.ts";
import {
	ARCH_REVIEW_MARKER,
	RETRO_MARKER,
	RULES_INTERVIEW_MARKER,
} from "./prompts.ts";
import { sumUsageIn, type UsageSum } from "./retro.ts";
import { queueOrder } from "./scheduler.ts";
import { firstSessionTitle, readTranscript } from "./session.ts";
import { assignTopics } from "./topics.ts";
import type {
	AskQuestion,
	DiffFileStat,
	ForkBranchState,
	Learning,
	OutcomeStatus,
	ProjectSettings,
	RunState,
	Stage,
	Task,
	TaskKind,
	Turn,
	TurnKind,
	WorkCheckBlocker,
	WorkCheckRun,
} from "./types.ts";
import { askQuestions } from "./types.ts";

export const DEFAULT_SETTINGS: ProjectSettings = {
	maxParallel: 2,
	copyExtra: [],
	displayName: null,
	releaseCommand: null,
	archReviewCap: 150,
	maxImages: 8,
	keptWorktreeDays: 7,
	autoTend: false,
	autoTendLimit: 12,
	tendChurnGlobs: [],
	holdUpdateMerges: false,
	retroSince: null,
	retroFilter: true,
	forkResearch: false,
	setupChecklist: false,
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
  model TEXT,
  kept_files TEXT NOT NULL DEFAULT '[]',
  follow_up_of TEXT,
  push_sha TEXT,
  update_ids TEXT NOT NULL DEFAULT '[]',
  update_merge_approved INTEGER NOT NULL DEFAULT 0
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
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  cost REAL
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
  PRIMARY KEY (fork_id, branch_hash)
);
CREATE TABLE IF NOT EXISTS fork_runs (
  started_at INTEGER NOT NULL,
  fork_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fork_runs_at ON fork_runs (started_at);
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
	branch: string | null;
	base: string | null;
	worktree: string | null;
	session_id: string | null;
	summary: string | null;
	details: string | null;
	report: string | null;
	research: number;
	created_at: number;
	updated_at: number;
	queued_at: number | null;
	done_at: number | null;
	cancelled_at: number | null;
	commits: number | null;
	images: string;
	pending_images: string;
	shots: string;
	release_version: string | null;
	release_notes: string | null;
	asked: string | null;
	model: string | null;
	kept_files: string;
	follow_up_of: string | null;
	push_sha: string | null;
	topic: string | null;
	depends_on: string;
	update_ids: string;
	update_merge_approved: number;
	fork_merge_approved: number;
	diff_files: string | null;
	diff_text: string | null;
	work_check_log: string;
	work_check_sendbacks: number;
	work_check_head: string | null;
	priority: string | null;
	close_candidate: string | null;
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

interface TurnRow {
	id: number;
	task_id: string;
	kind: string;
	prompt: string;
	input: string | null;
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
}

/** One learnings row. */
interface LearningRow {
	id: number;
	text: string;
	glob: string | null;
	usage_count: number;
	last_used_at: number | null;
	from_task_id: string | null;
	created_at: number;
}

function toLearning(r: LearningRow): Learning {
	return {
		id: r.id,
		text: r.text,
		glob: r.glob,
		usageCount: r.usage_count,
		lastUsedAt: r.last_used_at,
		fromTaskId: r.from_task_id,
		createdAt: r.created_at,
	};
}

function toTask(project: string, r: TaskRow): Task {
	return {
		id: r.id,
		project,
		title: r.title ?? "",
		prompt: r.prompt ?? "",
		stage: r.stage as Stage,
		state: r.state as RunState,
		needsReason: r.needs_reason,
		pendingPrompt: r.pending_prompt,
		branch: r.branch,
		base: r.base,
		worktree: r.worktree,
		sessionId: r.session_id,
		summary: r.summary,
		details: r.details,
		report: r.report,
		research: r.research === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
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
		model: r.model,
		keptFiles: parseStringList(r.kept_files),
		followUpOf: r.follow_up_of,
		pushSha: r.push_sha,
		topic: r.topic,
		dependsOn: parseStringList(r.depends_on),
		updateIds: parseStringList(r.update_ids),
		updateMergeApproved: r.update_merge_approved === 1,
		forkMergeApproved: r.fork_merge_approved === 1,
		diffFiles: parseDiffFiles(r.diff_files),
		diffText: r.diff_text,
		workCheckLog: parseWorkCheckLog(r.work_check_log),
		workCheckSendbacks: r.work_check_sendbacks,
		workCheckHead: r.work_check_head,
		priority: (r.priority as Task["priority"]) ?? null,
		closeCandidate: r.close_candidate,
		kind: r.kind as TaskKind,
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
			if (typeof entry !== "object" || entry === null) return null;
			const { file, plus, minus } = entry as Record<string, unknown>;
			if (typeof file !== "string") return null;
			if (plus !== null && typeof plus !== "number") return null;
			if (minus !== null && typeof minus !== "number") return null;
			files.push({
				file,
				plus: typeof plus === "number" ? plus : null,
				minus: typeof minus === "number" ? minus : null,
			});
		}
		return files;
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

function parseStringList(raw: string): string[] {
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return [];
		return value.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
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
		if (typeof entry !== "object" || entry === null) continue;
		const r = entry as Record<string, unknown>;
		if (
			typeof r.at !== "number" ||
			(r.outcome !== "pass" &&
				r.outcome !== "blockers" &&
				r.outcome !== "error") ||
			!Array.isArray(r.blockers) ||
			!Array.isArray(r.notes)
		)
			continue;
		const blockers: WorkCheckBlocker[] = [];
		for (const b of r.blockers) {
			if (typeof b !== "object" || b === null) continue;
			const blocker = b as Record<string, unknown>;
			if (typeof blocker.finding !== "string") continue;
			blockers.push({
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
			});
		}
		runs.push({
			at: r.at,
			model: typeof r.model === "string" ? r.model : null,
			outcome: r.outcome,
			blockers,
			notes: r.notes.filter((n): n is string => typeof n === "string"),
			durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
			error: typeof r.error === "string" ? r.error : undefined,
		});
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
	};
}

// Column names for dynamic UPDATEs are this hardcoded whitelist only — values always bind via `?`.
// Keyed by the patch fields (R4-8): a new Task/Turn field extends TaskPatch/TurnPatch, so a
// missing column mapping here is a compile error instead of a silently dropped write.
export type TaskPatch = Partial<
	// kind stays out of TaskPatch: it is set once by createTask and never patched.
	Omit<Task, "id" | "project" | "createdAt" | "updatedAt" | "doneAt" | "kind">
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
	branch: "branch",
	base: "base",
	worktree: "worktree",
	sessionId: "session_id",
	summary: "summary",
	details: "details",
	report: "report",
	research: "research",
	queuedAt: "queued_at",
	cancelledAt: "cancelled_at",
	commits: "commits",
	images: "images",
	pendingImages: "pending_images",
	shots: "shots",
	releaseVersion: "release_version",
	releaseNotes: "release_notes",
	asked: "asked",
	model: "model",
	keptFiles: "kept_files",
	followUpOf: "follow_up_of",
	pushSha: "push_sha",
	topic: "topic",
	dependsOn: "depends_on",
	updateIds: "update_ids",
	updateMergeApproved: "update_merge_approved",
	forkMergeApproved: "fork_merge_approved",
	diffFiles: "diff_files",
	diffText: "diff_text",
	workCheckLog: "work_check_log",
	workCheckSendbacks: "work_check_sendbacks",
	workCheckHead: "work_check_head",
	priority: "priority",
	closeCandidate: "close_candidate",
};

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
	input: "input",
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
export function serverDirFor(projectPath: string): string {
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

/**
 * One-time move of the task DBs that older boards kept on the worker-shared data dir into
 * the server-only dir. The marker makes it one-time: a tasks.db a worker plants later is
 * never adopted. A StoreLockedError (a live board holds the DB) goes up to stop the boot.
 */
export function adoptSharedProjectData(
	dataDir: string,
	serverDataDir: string,
): AdoptResult[] {
	const marker = join(serverDataDir, ".adopted");
	if (existsSync(marker)) return [];
	const results: AdoptResult[] = [];
	const names = existsSync(dataDir) ? readdirSync(dataDir) : [];
	for (const name of names) {
		const oldDir = join(dataDir, name);
		const oldDb = join(oldDir, "tasks.db");
		try {
			if (!lstatSync(oldDir).isDirectory()) continue;
			if (!lstatSync(oldDb).isFile()) continue;
		} catch {
			continue; // no tasks.db in this dir
		}
		const newDir = join(serverDataDir, name);
		const newDb = join(newDir, "tasks.db");
		if (existsSync(newDb)) continue;
		let db: Database;
		try {
			db = openLocked(oldDb);
		} catch (err) {
			if (err instanceof StoreLockedError) throw err;
			results.push({
				name,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		let open = true;
		try {
			mkdirSync(newDir, { recursive: true });
			const tmp = join(newDir, "tasks.db.adopting");
			rmSync(tmp, { force: true });
			db.query("VACUUM INTO ?").run(tmp);
			const copy = new Database(tmp);
			try {
				for (const table of ["tasks", "turns"]) {
					const sql = `SELECT COUNT(*) AS n FROM ${table}`;
					const a = db.query<{ n: number }, []>(sql).get()?.n;
					const b = copy.query<{ n: number }, []>(sql).get()?.n;
					if (a !== b)
						throw new Error(`${table} count mismatch: ${a} vs ${b} in copy`);
				}
			} finally {
				copy.close();
			}
			renameSync(tmp, newDb);
			open = false;
			closeLocked(db);
			renameSync(oldDb, join(oldDir, "tasks.db.moved-to-server"));
			results.push({ name, status: "adopted" });
		} catch (err) {
			if (open) closeLocked(db);
			results.push({
				name,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	mkdirSync(serverDataDir, { recursive: true });
	writeFileSync(marker, `${new Date().toISOString()}\n`);
	return results;
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
 * so a heading like "# Set up agent rules" becomes the bare text. No code matches on the
 * title text (card kind is a trusted, server-set field, never derived from prompt text),
 * so this is safe to change.
 */
function deriveTitle(prompt: string): string {
	const lines = prompt.split("\n").map((line) => line.trim());
	const isSectionLabel = (line: string) => /^#{1,6}\s+\S+$/.test(line);
	const line =
		lines.find((line) => line.length > 0 && !isSectionLabel(line)) ??
		lines.find((line) => line.length > 0) ??
		"";
	return line.replace(/^#+\s*/, "").slice(0, 80);
}

/**
 * Short board-card name cut from the prompt line at a word boundary. The stopgap a card shows
 * before omp or the agent titles the session; never persisted, so the real title still wins.
 */
export function shortTitle(title: string, max = 48): string {
	if (title.length <= max) return title;
	const cut = title.lastIndexOf(" ", max);
	const base = (cut <= 0 ? title.slice(0, max) : title.slice(0, cut)).trimEnd();
	return `${base}…`;
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
	releaseCommand: "string",
	archReviewCap: "number",
	maxImages: "number",
	keptWorktreeDays: "number",
	autoTend: "boolean",
	autoTendLimit: "number",
	tendChurnGlobs: "string[]",
	holdUpdateMerges: "boolean",
	retroSince: "number",
	retroFilter: "boolean",
	forkResearch: "boolean",
	setupChecklist: "boolean",
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
	if (typeof value !== shape) return undefined;
	return value as ProjectSettings[keyof ProjectSettings];
}

/** Turns of one task still missing their captured cost, oldest first. */
interface CostBackfillTurn {
	id: number;
	started_at: number;
	ended_at: number;
}

/** Writes one turn's five cost columns from a usage sum. */
function writeTurnCost(db: Database, turnId: number, sum: UsageSum): void {
	db.run(
		"UPDATE turns SET tokens_in = ?, tokens_out = ?, cache_read = ?, cache_write = ?, cost = ? WHERE id = ?",
		[
			sum.tokensIn,
			sum.tokensOut,
			sum.cacheRead,
			sum.cacheWrite,
			sum.cost,
			turnId,
		],
	);
}

/**
 * Backfills the cost columns of finished turns that have none (runs once per open, after the
 * migrations): groups the pending turns by task so each task's transcript is read once, then
 * fills each turn from its `[started_at, ended_at]` window. A turn the transcript cannot prove
 * (no transcript, a malformed record, or a turn of an earlier session) keeps NULL so a later
 * open can retry; an owned window without usage writes zeros. Best-effort by contract — the
 * caller wraps this so a failure never blocks the open.
 */
function backfillTurnCosts(db: Database, sessionsDir: string): void {
	const tasks = db
		.query<{ id: string; session_id: string | null }, []>(
			`SELECT DISTINCT tasks.id, tasks.session_id FROM tasks
			 JOIN turns ON turns.task_id = tasks.id
			 WHERE turns.ended_at IS NOT NULL AND turns.cost IS NULL`,
		)
		.all();
	for (const task of tasks) {
		if (task.session_id === null) continue;
		const texts = readTranscript(sessionsDir, task.session_id);
		const turns = db
			.query<CostBackfillTurn, [string]>(
				"SELECT id, started_at, ended_at FROM turns WHERE task_id = ? AND ended_at IS NOT NULL AND cost IS NULL ORDER BY id",
			)
			.all(task.id);
		for (const turn of turns) {
			const sum = sumUsageIn(texts, turn.started_at, turn.ended_at);
			if (sum !== null) writeTurnCost(db, turn.id, sum);
		}
	}
}

export class ProjectStore {
	readonly path: string;
	readonly name: string;
	readonly tasksDir: string;
	/** Server-only dir (serverDirFor): tasks.db and the fork cache. */
	readonly serverDir: string;
	readonly sessionsDir: string;
	readonly worktreesDir: string;
	private readonly db: Database;
	/** Set by close(): a second close must not run the lock release on a dead handle. */
	private closed = false;

	private constructor(projectPath: string, db: Database) {
		this.path = projectPath;
		this.name = basename(projectPath);
		this.tasksDir = tasksDirFor(projectPath);
		this.serverDir = serverDirFor(projectPath);
		this.sessionsDir = join(this.tasksDir, "sessions");
		this.worktreesDir = join(projectPath, ".worktrees");
		this.db = db;
	}

	static init(projectPath: string): ProjectStore {
		const root = resolve(projectPath);
		const tasksDir = tasksDirFor(root);
		mkdirSync(join(tasksDir, "logs"), { recursive: true });
		mkdirSync(join(tasksDir, "sessions"), { recursive: true });
		const taskIgnore = join(tasksDir, ".gitignore");
		if (!existsSync(taskIgnore)) writeFileSync(taskIgnore, "*\n");
		mkdirSync(join(root, ".worktrees"), { recursive: true });
		const wtIgnore = join(root, ".worktrees", ".gitignore");
		if (!existsSync(wtIgnore)) writeFileSync(wtIgnore, "*\n");
		return ProjectStore.open(root);
	}

	static open(projectPath: string): ProjectStore {
		const root = resolve(projectPath);
		const tasksDir = tasksDirFor(root);
		mkdirSync(tasksDir, { recursive: true });
		const serverDir = serverDirFor(root);
		mkdirSync(serverDir, { recursive: true });
		const dbPath = join(serverDir, "tasks.db");
		// Shared PRAGMA + instance-lock sequence (R2-9): one live opener per db file
		// (incident 2026-10-06); a refused opener throws with the holder named, handle closed.
		const db = openLocked(dbPath);
		db.exec(SCHEMA);
		const cols = db
			.query<{ name: string }, []>("PRAGMA table_info(tasks)")
			.all()
			.map((c) => c.name);
		if (!cols.includes("images"))
			db.exec("ALTER TABLE tasks ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
		if (!cols.includes("pending_images"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN pending_images TEXT NOT NULL DEFAULT '[]'",
			);
		if (!cols.includes("shots"))
			db.exec("ALTER TABLE tasks ADD COLUMN shots TEXT NOT NULL DEFAULT '[]'");
		if (!cols.includes("session_title"))
			db.exec("ALTER TABLE tasks ADD COLUMN session_title TEXT");
		if (!cols.includes("commits"))
			db.exec("ALTER TABLE tasks ADD COLUMN commits INTEGER");
		if (!cols.includes("release_version"))
			db.exec("ALTER TABLE tasks ADD COLUMN release_version TEXT");
		if (!cols.includes("release_notes"))
			db.exec("ALTER TABLE tasks ADD COLUMN release_notes TEXT");
		if (!cols.includes("asked"))
			db.exec("ALTER TABLE tasks ADD COLUMN asked TEXT");
		if (!cols.includes("model"))
			db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
		if (!cols.includes("kept_files"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN kept_files TEXT NOT NULL DEFAULT '[]'",
			);
		if (!cols.includes("follow_up_of"))
			db.exec("ALTER TABLE tasks ADD COLUMN follow_up_of TEXT");
		if (!cols.includes("done_at"))
			db.exec("ALTER TABLE tasks ADD COLUMN done_at INTEGER");
		if (!cols.includes("push_sha"))
			db.exec("ALTER TABLE tasks ADD COLUMN push_sha TEXT");
		if (!cols.includes("report"))
			db.exec("ALTER TABLE tasks ADD COLUMN report TEXT");
		if (!cols.includes("research"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN research INTEGER NOT NULL DEFAULT 0",
			);
		if (!cols.includes("update_ids"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN update_ids TEXT NOT NULL DEFAULT '[]'",
			);
		if (!cols.includes("update_merge_approved"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN update_merge_approved INTEGER NOT NULL DEFAULT 0",
			);
		// Backfill runs on every open and is idempotent (only null rows): a process stop
		// between the ALTER above and the UPDATE converges here on the next open instead
		// of leaving done cards unstamped forever (includedTasks drops them from releases).
		db.exec(
			"UPDATE tasks SET done_at = (SELECT ended_at FROM turns WHERE turns.task_id = tasks.id ORDER BY turns.id DESC LIMIT 1) WHERE stage = 'done' AND done_at IS NULL",
		);
		// A CHECK constraint can only change by rebuilding the table: databases created before
		// `preparing` carry the old state list, and the scheduler writes 'preparing' on every
		// claim. Runs after the column backfills so old and new shapes have the same named
		// columns; copies rows explicitly (legacy column ORDER can differ), verifies the count,
		// then swaps — all in one transaction, so a failure leaves the old table untouched.
		const tasksSql =
			db
				.query<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
				)
				.get()?.sql ?? "";
		if (tasksSql.includes("state IN ('queued','running','needs_you','idle')")) {
			const count = (table: string): number =>
				db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()
					?.n ?? 0;
			const before = count("tasks");
			db.exec("BEGIN");
			try {
				db.exec(
					TASKS_DDL.replace(
						"CREATE TABLE IF NOT EXISTS tasks",
						"CREATE TABLE tasks_migrating",
					),
				);
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN commits INTEGER");
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN done_at INTEGER");
				const names = `id, title, prompt, stage, state, needs_reason, pending_prompt,
					branch, base, worktree, session_id, summary, details, created_at, updated_at,
					queued_at, cancelled_at, images, pending_images, release_version, release_notes,
					session_title, asked, model, kept_files, follow_up_of, commits, done_at`;
				db.exec(
					`INSERT INTO tasks_migrating (${names}) SELECT ${names} FROM tasks`,
				);
				const after = count("tasks_migrating");
				if (after !== before)
					throw Error(`state migration would lose rows: ${before} -> ${after}`);
				db.exec("DROP TABLE tasks");
				db.exec("ALTER TABLE tasks_migrating RENAME TO tasks");
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		}
		// topic lands after the state-CHECK rebuild above on purpose: that migration copies
		// named columns only, so a column added before it would be dropped together with the
		// freshly backfilled labels. Same idempotent pattern as done_at: only null rows.
		if (!cols.includes("topic"))
			db.exec("ALTER TABLE tasks ADD COLUMN topic TEXT");
		const untopic = db
			.query<
				{ id: string; title: string | null; session_title: string | null },
				[]
			>(
				"SELECT id, title, session_title FROM tasks WHERE stage = 'done' AND topic IS NULL",
			)
			.all();
		if (untopic.length > 0) {
			const topics = assignTopics(
				untopic.map((r) => ({
					id: r.id,
					title: r.title ?? "",
					sessionTitle: r.session_title,
				})),
			);
			for (const [id, topic] of topics)
				db.run("UPDATE tasks SET topic = ? WHERE id = ?", [topic, id]);
		}
		if (!cols.includes("depends_on"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
			);
		// Diff capture columns: null on every pre-existing row (never captured), so plain ADD COLUMN
		// converges; placed after the state-CHECK rebuild like topic, whose named-column copy would
		// drop them otherwise.
		if (!cols.includes("diff_files"))
			db.exec("ALTER TABLE tasks ADD COLUMN diff_files TEXT");
		if (!cols.includes("diff_text"))
			db.exec("ALTER TABLE tasks ADD COLUMN diff_text TEXT");
		// Work-check columns: absent from TASKS_DDL on purpose — the state-CHECK
		// rebuild recreates the table from that DDL, so a column living in both would dupe
		// here on the stale column list (same reason topic and the diff columns live here).
		if (!cols.includes("work_check_log"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN work_check_log TEXT NOT NULL DEFAULT '[]'",
			);
		if (!cols.includes("work_check_sendbacks"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN work_check_sendbacks INTEGER NOT NULL DEFAULT 0",
			);
		if (!cols.includes("work_check_head"))
			db.exec("ALTER TABLE tasks ADD COLUMN work_check_head TEXT");
		// fork_merge_approved lives after the state-CHECK rebuild on purpose (like topic and the
		// diff columns): it is ALTER-only, so a rebuild before its backfill would drop the
		// column and the stale `cols` list would never re-add it.
		if (!cols.includes("fork_merge_approved"))
			db.exec(
				"ALTER TABLE tasks ADD COLUMN fork_merge_approved INTEGER NOT NULL DEFAULT 0",
			);
		// A CHECK constraint can only change by rebuilding the table: databases created before
		// `backlog` carry the old stage list, and a parked card writes 'backlog'. Same pattern as
		// the state-CHECK rebuild above: runs after every column backfill (named-column copy),
		// copies rows explicitly, verifies the count, swaps in one transaction.
		if (tasksSql.includes("stage IN ('todo','in_progress','merging','done')")) {
			const count = (table: string): number =>
				db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()
					?.n ?? 0;
			const before = count("tasks");
			db.exec("BEGIN");
			try {
				db.exec(
					TASKS_DDL.replace(
						"CREATE TABLE IF NOT EXISTS tasks",
						"CREATE TABLE tasks_migrating",
					),
				);
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN commits INTEGER");
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN done_at INTEGER");
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN topic TEXT");
				db.exec(
					"ALTER TABLE tasks_migrating ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
				);
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN diff_files TEXT");
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN diff_text TEXT");
				db.exec(
					"ALTER TABLE tasks_migrating ADD COLUMN work_check_log TEXT NOT NULL DEFAULT '[]'",
				);
				db.exec(
					"ALTER TABLE tasks_migrating ADD COLUMN work_check_sendbacks INTEGER NOT NULL DEFAULT 0",
				);
				db.exec("ALTER TABLE tasks_migrating ADD COLUMN work_check_head TEXT");
				db.exec(
					"ALTER TABLE tasks_migrating ADD COLUMN fork_merge_approved INTEGER NOT NULL DEFAULT 0",
				);
				const names = `id, title, prompt, stage, state, needs_reason, pending_prompt,
					branch, base, worktree, session_id, summary, details, report, research,
					created_at, updated_at, queued_at, cancelled_at, images, pending_images,
					release_version, release_notes, session_title, asked, model, kept_files,
					follow_up_of, push_sha, update_ids, update_merge_approved, fork_merge_approved,
					commits, done_at, topic, depends_on, diff_files, diff_text, work_check_log,
					work_check_sendbacks, work_check_head`;
				db.exec(
					`INSERT INTO tasks_migrating (${names}) SELECT ${names} FROM tasks`,
				);
				const after = count("tasks_migrating");
				if (after !== before)
					throw Error(`stage migration would lose rows: ${before} -> ${after}`);
				db.exec("DROP TABLE tasks");
				db.exec("ALTER TABLE tasks_migrating RENAME TO tasks");
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		}
		// Triage columns: ALTER-only and placed after both CHECK rebuilds on
		// purpose — the rebuilds copy named columns, so a column living in TASKS_DDL too
		// would dupe here on the stale column list (same reason topic and the diff columns).
		if (!cols.includes("priority"))
			db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT");
		if (!cols.includes("close_candidate"))
			db.exec("ALTER TABLE tasks ADD COLUMN close_candidate TEXT");
		const turnCols = db
			.query<{ name: string }, []>("PRAGMA table_info(turns)")
			.all()
			.map((c) => c.name);
		if (!turnCols.includes("model"))
			db.exec("ALTER TABLE turns ADD COLUMN model TEXT");
		if (!turnCols.includes("input"))
			db.exec("ALTER TABLE turns ADD COLUMN input TEXT");
		// Cost capture columns: nullable, so plain ADD COLUMN converges like the
		// tasks columns above; the backfill below fills what the transcripts still allow.
		for (const col of [
			"tokens_in",
			"tokens_out",
			"cache_read",
			"cache_write",
		]) {
			if (!turnCols.includes(col))
				db.exec(`ALTER TABLE turns ADD COLUMN ${col} INTEGER`);
		}
		if (!turnCols.includes("cost"))
			db.exec("ALTER TABLE turns ADD COLUMN cost REAL");
		// One-time-per-open cost backfill: finished turns without captured cost read their
		// task's transcript once per task and fill each turn by its timestamp window. Never
		// throws (spec): a failure or a missing transcript leaves the columns NULL and the
		// next open tries again.
		try {
			backfillTurnCosts(db, join(tasksDir, "sessions"));
		} catch {
			/* backfill is best-effort; the next open retries */
		}
		// kind: trusted, server-set card kind. ALTER-only and placed after both
		// table-rebuild blocks on purpose (like topic/fork_merge_approved): those copy rows by
		// an explicit name list and would reset kind to 'work'. The one-time backfill maps
		// pre-existing privileged cards to their kind: they were all created by the trusted
		// routes whose prompt builders emit these prefixes, so a LIKE on the marker constants
		// is exact here. After this backfill no code derives kind from prompt text again.
		if (!cols.includes("kind")) {
			db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'");
			db.run("UPDATE tasks SET kind = 'retro' WHERE prompt LIKE ? || '%'", [
				RETRO_MARKER,
			]);
			db.run("UPDATE tasks SET kind = 'interview' WHERE prompt LIKE ? || '%'", [
				RULES_INTERVIEW_MARKER,
			]);
			db.run(
				"UPDATE tasks SET kind = 'review' WHERE release_version IS NULL AND prompt LIKE ? || '%'",
				[ARCH_REVIEW_MARKER],
			);
		}
		return new ProjectStore(root, db);
	}

	logPath(taskId: string): string {
		return join(this.tasksDir, "logs", `${taskId}.log`);
	}

	imagesDir(taskId: string): string {
		return join(this.tasksDir, "images", taskId);
	}

	/** The task's own session title: the stored one, or the first title in the session
	 * transcript; null when neither exists yet. */
	sessionTitle(task: Task): string | null {
		const row = this.db
			.query<{ session_title: string | null }, [string]>(
				"SELECT session_title FROM tasks WHERE id = ?",
			)
			.get(task.id);
		if (row?.session_title) return row.session_title;
		return firstSessionTitle(this.sessionsDir, task.sessionId);
	}

	/** Persists a title once: `IS NULL` keeps the first name authoritative even if two writes race. */
	nameTask(id: string, title: string): void {
		this.db.run(
			"UPDATE tasks SET session_title = ? WHERE id = ? AND session_title IS NULL",
			[title, id],
		);
	}

	/**
	 * Card title: the first title of the task's own session, stored once and never overwritten, so
	 * later re-titles (merge turn, resume, New session) can't rename the card. A follow-up is a new
	 * task with a fresh session, so it gets that session's title. Until a title exists (omp, the
	 * run's rename, or the tracker's prepare-phase generation), the card shows a short cut of the
	 * prompt line — recomputed each call, never persisted.
	 */
	frozenTitle(task: Task): string {
		const title = this.sessionTitle(task);
		if (title !== null) {
			this.nameTask(task.id, title);
			return title;
		}
		return shortTitle(task.title);
	}

	getSettings(): ProjectSettings {
		// A deep copy: callers own the arrays (copyExtra, tendChurnGlobs), never the defaults'.
		const out = structuredClone(DEFAULT_SETTINGS);
		for (const row of this.db
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
	}

	setSettings(patch: Partial<ProjectSettings>): ProjectSettings {
		for (const [key, value] of Object.entries(patch)) {
			// Unknown keys can only arrive from a hand-built JSON body; ignore them.
			if (value === undefined || !(key in DEFAULT_SETTINGS)) continue;
			// A reset stores JSON null instead of deleting the row: tracker data is never deleted.
			this.db.run(
				"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[key, JSON.stringify(value)],
			);
		}
		return this.getSettings();
	}

	/** The card the Check the board button filed last (POST /api/projects/:project/board-check).
	 * Only that route writes the mark, so no prompt an agent writes can make a card a board
	 * check, which runs in the server's own container. Stored next to next-task-num, outside
	 * the project settings that the Settings route edits. */
	boardCheckId(): string | null {
		const row = this.db
			.query<{ value: string }, []>(
				"SELECT value FROM settings WHERE key = 'board-check'",
			)
			.get();
		return row === null ? null : (JSON.parse(row.value) as string);
	}

	setBoardCheckId(id: string): void {
		this.db.run(
			"INSERT INTO settings (key, value) VALUES ('board-check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			[JSON.stringify(id)],
		);
	}

	/** Pids of turns that never ended: the orphan scan must not kill live processes. */
	runningPids(): number[] {
		return this.db
			.query<{ pid: number }, []>(
				"SELECT DISTINCT pid FROM turns WHERE pid IS NOT NULL AND ended_at IS NULL",
			)
			.all()
			.map((r) => r.pid);
	}

	// ---- Fork research watch state ----

	/** Branch watch rows of one fork, branch name ascending. */
	listForkBranches(forkId: number): ForkBranchState[] {
		return this.db
			.query<ForkBranchRow, [number]>(
				"SELECT * FROM fork_branch WHERE fork_id = ? ORDER BY branch",
			)
			.all(forkId)
			.map(toForkBranch);
	}

	/** Every branch watch row (the gates scan the whole watch). */
	listAllForkBranches(): ForkBranchState[] {
		return this.db
			.query<ForkBranchRow, []>("SELECT * FROM fork_branch")
			.all()
			.map(toForkBranch);
	}

	/** Upserts one branch watch row. */
	saveForkBranch(s: ForkBranchState): void {
		this.db.run(
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
	}

	/** Analysis attempts started since `since` (project daily-rate gate). */
	forkRunsSince(since: number): number {
		return (
			this.db
				.query<{ n: number }, [number]>(
					"SELECT COUNT(*) AS n FROM fork_runs WHERE started_at >= ?",
				)
				.get(since)?.n ?? 0
		);
	}

	recordForkRun(forkId: number, at: number): void {
		this.db.run("INSERT INTO fork_runs (started_at, fork_id) VALUES (?, ?)", [
			at,
			forkId,
		]);
	}

	/** Drops watch rows of forks absent from the latest scan; an empty list clears the watch. */
	deleteForkBranchesNotIn(ids: number[]): void {
		if (ids.length === 0) {
			this.db.run("DELETE FROM fork_branch");
			return;
		}
		const ph = ids.map(() => "?").join(", ");
		this.db.run(`DELETE FROM fork_branch WHERE fork_id NOT IN (${ph})`, ids);
	}

	/**
	 * Creates a server-generated fork research result card with its held proposals and marks the
	 * analyzed branches — one transaction, so a restart cannot file the same result twice.
	 */
	createForkResult(o: {
		prompt: string;
		title: string;
		report: string;
		topic: string;
		proposals: Array<{
			prompt: string;
			needsReason: string;
			model: string | null;
		}>;
		analyzed: Array<{
			forkId: number;
			branchHash: string;
			head: string;
			at: number;
		}>;
	}): Task {
		let cardId = "";
		const tx = this.db.transaction(() => {
			const card = this.createTask(o.prompt);
			cardId = card.id;
			this.updateTask(card.id, {
				title: o.title,
				research: true,
				stage: "done",
				state: "idle",
				report: o.report,
				topic: o.topic,
			});
			for (const p of o.proposals) {
				const child = this.createTask(p.prompt);
				this.updateTask(child.id, {
					followUpOf: card.id,
					state: "needs_you",
					needsReason: p.needsReason,
					model: p.model,
				});
			}
			for (const a of o.analyzed) {
				this.db.run(
					"UPDATE fork_branch SET analyzed_head = ?, first_pending_at = NULL, last_run_at = ?, last_error = NULL, retries = 0 WHERE fork_id = ? AND branch_hash = ?",
					[a.head, a.at, a.forkId, a.branchHash],
				);
			}
		});
		tx();
		const card = this.getTask(cardId);
		if (!card) throw new Error(`fork result card vanished: ${cardId}`);
		return card;
	}

	/** Uppercase alphanumeric project prefix, max 4 chars, from the store folder name. */
	private taskPrefix(): string {
		const p = this.name
			.replaceAll(/[^A-Za-z0-9]/g, "")
			.toUpperCase()
			.slice(0, 4);
		return p === "" ? "TASK" : p;
	}

	/** Next `PREFIX-n` id; the per-store counter only ever increments (no reuse). */
	private nextTaskId(): string {
		const row = this.db
			.query<{ value: string }, []>(
				"SELECT value FROM settings WHERE key = 'next-task-num'",
			)
			.get();
		const n = row ? parseInt(row.value, 10) : NaN;
		const current = Number.isInteger(n) && n >= 1 ? n : 1;
		this.db.run(
			"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			["next-task-num", JSON.stringify(current + 1)],
		);
		return `${this.taskPrefix()}-${current}`;
	}

	createTask(
		prompt: string,
		model: string | null = null,
		kind: TaskKind = "work",
	): Task {
		const now = Date.now();
		const title = deriveTitle(prompt);
		let id = this.nextTaskId();
		while (this.getTask(id) !== null) {
			// Each retry consumes the next counter value: no reuse, guaranteed termination.
			id = this.nextTaskId();
		}
		this.db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at, queued_at, model, kind) VALUES (?, ?, ?, 'todo', 'queued', ?, ?, ?, ?, ?)",
			[id, title, prompt, now, now, now, model, kind],
		);
		this.recordEvent("create", id, null, "todo", null);
		this.recordEvent("state", id, null, "queued", null);
		// Read the row back instead of hand-building the literal (R4-9): defaults and the
		// toTask normalizer stay in one place, so the returned Task can't drift from the DB.
		const task = this.getTask(id);
		if (!task) throw new Error(`unknown task: ${id}`);
		return task;
	}

	/** Rewrites an unstarted task's prompt; the title re-derives like on create. */
	editTask(id: string, prompt: string): Task {
		return this.updateTask(id, { prompt, title: deriveTitle(prompt) });
	}

	getTask(id: string): Task | null {
		const row = this.db
			.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?")
			.get(id);
		return row ? toTask(this.name, row) : null;
	}

	listTasks(): Task[] {
		return this.db
			.query<TaskRow, []>(
				"SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC",
			)
			.all()
			.map((row) => toTask(this.name, row));
	}

	updateTask(id: string, patch: TaskPatch): Task {
		const before = this.getTask(id);
		if (before === null) throw new Error(`unknown task: ${id}`);
		const sets: string[] = ["updated_at = ?"];
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
				// ponytail: Array.isArray covers exactly the JSON array columns (images, pendingImages, shots, asked, keptFiles); more need a column->serializer map
				values.push(
					Array.isArray(value)
						? JSON.stringify(value)
						: typeof value === "boolean"
							? value
								? 1
								: 0
							: (value as string | number | null),
				);
			}
		}
		values.push(id);
		this.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, values);
		const task = this.getTask(id);
		if (!task) throw new Error(`unknown task: ${id}`);
		// Every stage/state write funnels through here, so this is the one place transitions get recorded.
		if (patch.stage !== undefined && patch.stage !== before.stage)
			this.recordEvent("stage", id, before.stage, patch.stage, null);
		if (patch.state !== undefined && patch.state !== before.state)
			this.recordEvent("state", id, before.state, patch.state, null);
		return task;
	}

	queueIds(): string[] {
		return queueOrder(this.listTasks()).map((t) => t.id);
	}

	/** Learnings oldest first, so a prompt section lists them in the order the user stated them. */
	listLearnings(): Learning[] {
		return this.db
			.query<LearningRow, []>("SELECT * FROM learnings ORDER BY created_at ASC")
			.all()
			.map(toLearning);
	}

	addLearning(o: {
		text: string;
		glob?: string | null;
		fromTaskId?: string | null;
	}): Learning {
		const now = Date.now();
		const res = this.db.run(
			"INSERT INTO learnings (text, glob, usage_count, from_task_id, created_at) VALUES (?, ?, 0, ?, ?)",
			[o.text, o.glob ?? null, o.fromTaskId ?? null, now],
		);
		return {
			id: Number(res.lastInsertRowid),
			text: o.text,
			glob: o.glob ?? null,
			usageCount: 0,
			lastUsedAt: null,
			fromTaskId: o.fromTaskId ?? null,
			createdAt: now,
		};
	}

	deleteLearning(id: number): void {
		this.db.run("DELETE FROM learnings WHERE id = ?", [id]);
	}

	/** Marks learnings as applied by a review card: bumps the count and stamps the time; a no-op on []. */
	touchLearnings(ids: number[]): void {
		if (ids.length === 0) return;
		const marks = ids.map(() => "?").join(", ");
		this.db.run(
			`UPDATE learnings SET usage_count = usage_count + 1, last_used_at = ? WHERE id IN (${marks})`,
			[Date.now(), ...ids],
		);
	}

	/** True iff `order` is an exact permutation of the current queue; then moves each task by writing future queuedAt. */
	reorderQueue(order: string[]): boolean {
		const current = this.queueIds();
		if (order.length !== current.length || new Set(order).size !== order.length)
			return false;
		const currentSet = new Set(current);
		if (order.some((id) => !currentSet.has(id))) return false;
		const now = Date.now();
		for (const [i, id] of order.entries())
			this.updateTask(id, { queuedAt: now + i });
		return true;
	}

	startTurn(
		taskId: string,
		kind: TurnKind,
		prompt: string,
		pid: number | null,
		input: string | null = null,
	): Turn {
		const now = Date.now();
		const { lastInsertRowid } = this.db.run(
			"INSERT INTO turns (task_id, kind, prompt, input, started_at, pid) VALUES (?, ?, ?, ?, ?, ?)",
			[taskId, kind, prompt, input, now, pid],
		);
		// Read back (R4-9) so the returned Turn always matches the stored row and toTurn.
		const row = this.db
			.query<TurnRow, [number]>("SELECT * FROM turns WHERE id = ?")
			.get(Number(lastInsertRowid));
		if (!row) throw new Error(`unknown turn: ${lastInsertRowid}`);
		return toTurn(row);
	}

	finishTurn(turnId: number, patch: TurnPatch): Turn {
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
			this.db.run(`UPDATE turns SET ${sets.join(", ")} WHERE id = ?`, values);
		}
		const row = this.db
			.query<TurnRow, [number]>("SELECT * FROM turns WHERE id = ?")
			.get(turnId);
		if (!row) throw new Error(`unknown turn: ${turnId}`);
		// Cost capture: a finished turn owns its transcript window's usage; a
		// missing or unreadable transcript leaves the columns NULL and never fails the turn.
		if (patch.endedAt !== undefined && row.ended_at !== null)
			this.captureTurnCost(row.task_id, turnId, row.started_at, row.ended_at);
		// A failed turn is an error event; a deliberate Cancel is not. `task_id` is NOT NULL in turns.
		if (
			patch.error !== undefined &&
			patch.error !== null &&
			patch.error !== "cancelled"
		)
			this.recordEvent("error", row.task_id, null, null, patch.error);
		return toTurn(row);
	}

	/**
	 * Fills one finished turn's token/cost columns from the task's transcript: only the
	 * transcript read and parse sit inside the guards (spec), so a store error still
	 * surfaces. No transcript on disk leaves the columns NULL.
	 */
	private captureTurnCost(
		taskId: string,
		turnId: number,
		startedAt: number,
		endedAt: number,
	): void {
		const sessionId =
			this.db
				.query<{ session_id: string | null }, [string]>(
					"SELECT session_id FROM tasks WHERE id = ?",
				)
				.get(taskId)?.session_id ?? null;
		if (sessionId === null) return;
		let sum: UsageSum | null;
		try {
			sum = sumUsageIn(
				readTranscript(this.sessionsDir, sessionId),
				startedAt,
				endedAt,
			);
		} catch {
			return; // unreadable transcript: the columns stay NULL
		}
		// Null: no transcript, a malformed record, or not this session's turn. Stays NULL.
		if (sum !== null) writeTurnCost(this.db, turnId, sum);
	}

	listTurns(taskId: string): Turn[] {
		return this.db
			.query<TurnRow, [string]>(
				"SELECT * FROM turns WHERE task_id = ? ORDER BY id",
			)
			.all(taskId)
			.map(toTurn);
	}

	/** Appends one lifecycle event; every stat derives from this log plus the tasks and turns tables. */
	private recordEvent(
		kind: StatEvent["kind"],
		taskId: string | null,
		from: string | null,
		to: string | null,
		detail: string | null,
	): void {
		this.db.run(
			"INSERT INTO events (at, task_id, kind, from_value, to_value, detail) VALUES (?, ?, ?, ?, ?, ?)",
			[Date.now(), taskId, kind, from, to, detail],
		);
	}

	/** All lifecycle events, oldest first: the raw feed a stats dashboard reads. */
	events(): StatEvent[] {
		return this.db
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
			.map((r) => ({
				at: r.at,
				taskId: r.task_id,
				kind: r.kind,
				from: r.from_value,
				to: r.to_value,
				detail: r.detail,
			}));
	}

	/**
	 * The Overview performance facts of this project: flat task
	 * and turn rows for the pure perfMetrics. A few aggregates, no N+1: a task's done
	 * time is its latest stage→done event, the first-pass penalty any needs_you state
	 * event, and a turn fails on a real error or a non-zero exit (SQL semantics: a NULL
	 * exit_code is not `<> 0`).
	 */
	perfFacts(): PerfFacts {
		const tasks = this.db
			.query<
				{ id: string; created_at: number; cancelled_at: number | null },
				[]
			>("SELECT id, created_at, cancelled_at FROM tasks")
			.all();
		const doneAt = new Map(
			this.db
				.query<{ task_id: string; at: number }, []>(
					"SELECT task_id, MAX(at) AS at FROM events WHERE kind = 'stage' AND to_value = 'done' GROUP BY task_id",
				)
				.all()
				.map((r): [string, number] => [r.task_id, r.at]),
		);
		const needsYou = new Set(
			this.db
				.query<{ task_id: string }, []>(
					"SELECT DISTINCT task_id FROM events WHERE kind = 'state' AND to_value = 'needs_you' AND task_id IS NOT NULL",
				)
				.all()
				.map((r) => r.task_id),
		);
		const workTurns = new Map(
			this.db
				.query<{ task_id: string; n: number }, []>(
					"SELECT task_id, COUNT(*) AS n FROM turns WHERE kind = 'work' GROUP BY task_id",
				)
				.all()
				.map((r): [string, number] => [r.task_id, r.n]),
		);
		const turns = this.db
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
				createdAt: t.created_at,
				doneAt: doneAt.get(t.id) ?? null,
				cancelled: t.cancelled_at !== null,
				workTurns: workTurns.get(t.id) ?? 0,
				hadNeedsYou: needsYou.has(t.id),
			})),
			turns: turns.map((t) => ({
				endedAt: t.ended_at,
				failed:
					(t.error !== null && t.error !== "cancelled") ||
					(t.exit_code !== null && t.exit_code !== 0),
				cost: t.cost,
			})),
		};
	}

	close(): void {
		if (!this.closed) closeLocked(this.db);
		this.closed = true;
	}
}
