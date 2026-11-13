/**
 * seed.ts — build the board data for one exported tree run.
 *
 * Layout: <board>/projects/<proj-01..proj-20>/.tasks/{tasks.db,logs/*.log}
 *   (ProjectStore defaults, no OTTR_DATA_DIR / OTTR_SERVER_DATA_DIR in the env.)
 *
 * Asserted counts (default totals across all projects):
 *   tasks:    10,000 task rows in the tasks table        (500 per project)
 *   turns:    27,000 turn rows in the turns table        (1,350 per project)
 *   events:  150,000 lifecycle rows in the events table  (7,500 per project)
 *   logLines:150,000 lines in .tasks/logs/<task>.log     (15 lines per task)
 *
 * The third count maps to the events table (the store's lifecycle event feed,
 * the third big row store next to tasks and turns). The same 150,000 is also
 * written as log lines, so both readings hold.
 *
 * Usage: bun seed.ts --tree <tree dir> --board <board dir> [--prompt-chars 1800]
 * Runs env-scrubbed; prints the asserted counts and the seed duration.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}
function num(name: string, dflt: number): number {
	const v = arg(name);
	return v === undefined ? dflt : Number(v);
}

const tree = resolve(arg("--tree") ?? "");
if (tree === undefined || tree.length === 0)
	throw new Error("missing --tree <dir>");
const board = arg("--board");
if (board === undefined) throw new Error("missing --board <dir>");
const PROJECTS = num("--projects", 20);
const TASKS = num("--tasks", 10_000);
const TURNS = num("--turns", 27_000);
const EVENTS = num("--events", 150_000);
const LOG_LINES = num("--log-lines", 150_000);
const PROMPT_CHARS = num("--prompt-chars", 1550);
const UNIQUE_CHARS = num("--unique-chars", 740);

if (process.env.OTTR_DATA_DIR || process.env.OTTR_SERVER_DATA_DIR)
	throw new Error("OTTR_DATA_DIR/OTTR_SERVER_DATA_DIR must not be set");

// Deterministic PRNG: identical board content for every tree.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(884);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

// ~2,400 distinct pronounceable tokens: unique per-card prose so the gzip
// ratio of the state frame matches real board content instead of one
// repeated sentence compressing 40:1.
const SYL = [
	"re",
	"port",
	"gate",
	"state",
	"turn",
	"card",
	"log",
	"task",
	"board",
	"clock",
	"frame",
	"chunk",
	"zip",
	"cache",
	"store",
	"queue",
	"patch",
	"branch",
	"load",
	"byte",
	"path",
	"node",
	"wire",
	"probe",
	"batch",
	"slice",
	"yield",
	"drain",
	"flush",
	"seal",
	"token",
	"lease",
	"quota",
	"model",
	"agent",
	"skill",
	"rule",
	"work",
	"flow",
	"run",
	"merge",
	"guard",
	"check",
	"scan",
	"watch",
	"seed",
	"keep",
	"hold",
	"push",
	"poll",
	"tick",
	"wake",
	"sleep",
	"draft",
	"stage",
	"ship",
	"audit",
];
const VOCAB: string[] = [];
{
	const seen = new Set<string>();
	while (VOCAB.length < 2400) {
		const n = 2 + Math.floor(rand() * 2);
		let w = "";
		for (let i = 0; i < n; i++) w += SYL[Math.floor(rand() * SYL.length)]!;
		if (!seen.has(w)) {
			seen.add(w);
			VOCAB.push(w);
		}
	}
}
/** One unique word-salad sentence, `words` long, deterministic per call order. */
function uniqueSentence(words: number): string {
	const out: string[] = [];
	for (let i = 0; i < words; i++)
		out.push(VOCAB[Math.floor(rand() * VOCAB.length)]!);
	return out.join(" ");
}

const NOW = Date.now();
const DAY = 86_400_000;
const MODELS = ["zai/glm-5.3-flash", "anthropic/claude-sonnet-4.5", null, null];
const TOPICS = ["performance", "release", "worker", "settings"];
const VERBS = ["Fix", "Migrate", "Profile", "Harden", "Document", "Refactor"];
const SUBJECTS = [
	"the release gate path",
	"the state frame build",
	"the worker sign-in loop",
	"the backup retention sweep",
	"the board diff tick",
	"the turn scheduler queue",
];

/** Unique-then-boilerplate prompt: UNIQUE_CHARS of per-card word-salad prose
 * (sets the gzip entropy), padded to PROMPT_CHARS with one shared filler
 * sentence every card repeats (raw size, compresses away). */
function makePrompt(
	chars: number,
	uniqueChars: number,
	name: string,
	i: number,
): string {
	const head = `# Goal\nTask ${i} for ${name}: keep one measured board path inside its budget.\n\n`;
	const unique: string[] = [];
	let len = head.length;
	let k = 0;
	while (len < uniqueChars) {
		k++;
		const s = `Step ${k}: ${uniqueSentence(12)} (${name} run ${i}.${k}). `;
		unique.push(s);
		len += s.length;
	}
	const filler = `Keep the release gate report updated with the measured p50 and p95 for this pass, and compare the numbers against the budget before you close the card. `;
	const parts: string[] = [head, ...unique];
	while (len < chars) {
		parts.push(filler);
		len += filler.length;
	}
	return parts.join("").slice(0, chars);
}

interface SeedTask {
	id: string;
	stage: string;
	createdAt: number;
	updatedAt: number;
}

// The store module is runtime-selected: --tree names the exported tree whose
// store.ts (schema + migrations) the seed must match, so a static import of a
// fixed path cannot work here.
const { ProjectStore } = await import(
	pathToFileURL(join(tree, "src", "store.ts")).href
);

const perProjectTasks = Math.floor(TASKS / PROJECTS);
const perProjectTurns = Math.floor(TURNS / PROJECTS);
const perProjectEvents = Math.floor(EVENTS / PROJECTS);
const logLinesPerTask = Math.max(1, Math.floor(LOG_LINES / TASKS));

const t0 = Date.now();
const projectsRoot = join(board, "projects");
mkdirSync(join(board, "state"), { recursive: true });
mkdirSync(projectsRoot, { recursive: true });

let taskTotal = 0;
let turnTotal = 0;
let eventTotal = 0;
let logLineTotal = 0;

for (let p = 0; p < PROJECTS; p++) {
	const name = `proj-${String(p + 1).padStart(2, "0")}`;
	const dir = join(projectsRoot, name);

	// The tree's own store creates the schema and runs its migrations, so the
	// seeded db always matches the tree that will serve it.
	const store = ProjectStore.init(dir);
	await store.backfill;
	store.close();

	const dbPath = join(dir, ".tasks", "tasks.db");
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = OFF");

	const taskCols = db
		.query<{ name: string }, []>("PRAGMA table_info(tasks)")
		.all()
		.map((c) => c.name);
	const want = [
		"id",
		"title",
		"prompt",
		"stage",
		"state",
		"created_at",
		"updated_at",
		"done_at",
		"branch",
		"base",
		"session_title",
		"summary",
		"model",
		"topic",
	].filter((c) => taskCols.includes(c));
	const taskInsert = db.prepare(
		`INSERT INTO tasks (${want.join(", ")}) VALUES (${want.map(() => "?").join(", ")})`,
	);

	const tasks: SeedTask[] = [];
	const values: Record<string, string | number | null> = {};
	db.exec("BEGIN");
	for (let i = 0; i < perProjectTasks; i++) {
		const id = `${name}-t${String(i + 1).padStart(4, "0")}`;
		const r = rand();
		const stage =
			r < 0.88
				? "done"
				: r < 0.93
					? "backlog"
					: r < 0.98
						? "todo"
						: "in_progress";
		const createdAt = Math.floor(
			NOW - 90 * DAY + (i / perProjectTasks) * 90 * DAY,
		);
		const updatedAt = createdAt + Math.floor(rand() * 30 * DAY);
		const doneAt = stage === "done" ? updatedAt : null;
		const title = `${pick(VERBS)} ${pick(SUBJECTS)} (${name} card ${i + 1})`;
		const prompt = makePrompt(PROMPT_CHARS, UNIQUE_CHARS, name, i + 1);
		const summary =
			stage === "done"
				? `${uniqueSentence(18)}: measured pass ${i + 1} stayed in budget, p50 and p95 recorded, no errors observed.`
				: null;
		const sessionTitle =
			rand() < 0.6
				? `${pick(VERBS)} ${pick(SUBJECTS)} — ${uniqueSentence(3)}`
				: null;
		const model = pick(MODELS);
		const topic = stage === "done" ? pick(TOPICS) : null;
		const branch = stage === "done" ? `wt/${id}` : null;
		values.id = id;
		values.title = title;
		values.prompt = prompt;
		values.stage = stage;
		values.state = "idle";
		values.created_at = createdAt;
		values.updated_at = updatedAt;
		values.done_at = doneAt;
		values.branch = branch;
		values.base = branch === null ? null : "main";
		values.session_title = sessionTitle;
		values.summary = summary;
		values.model = model;
		values.topic = topic;
		taskInsert.run(...want.map((c) => values[c]!));
		tasks.push({ id, stage, createdAt, updatedAt });
	}
	db.exec("COMMIT");

	const doneIds = tasks.filter((t) => t.stage === "done").map((t) => t.id);
	const turnInsert = db.prepare(
		`INSERT INTO turns (task_id, kind, prompt, input_by, started_at, ended_at, exit_code, outcome, summary, model, cost)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	db.exec("BEGIN");
	for (let i = 0; i < perProjectTurns; i++) {
		const taskId = doneIds[Math.floor(rand() * doneIds.length)]!;
		const kind = rand() < 0.85 ? "work" : "merge";
		const start = Math.floor(NOW - 85 * DAY + rand() * 85 * DAY);
		const dur = Math.floor((3 + rand() * 42) * 60_000);
		const failed = rand() < 0.05;
		const outcome = failed ? "error" : rand() < 0.15 ? "answered" : "done";
		const model = pick(MODELS);
		turnInsert.run(
			taskId,
			kind,
			`Run ${kind} for ${taskId}: ${pick(SUBJECTS)} pass ${i + 1}.`,
			rand() < 0.3 ? "user" : null,
			start,
			start + dur,
			failed ? 1 : 0,
			outcome,
			`${pick(VERBS)} pass finished for ${taskId}.`,
			model,
			Math.round(rand() * 120) / 100,
		);
	}
	db.exec("COMMIT");

	const eventInsert = db.prepare(
		`INSERT INTO events (at, task_id, kind, from_value, to_value, detail)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const eventShapes: Array<[string, string | null, string | null, string]> = [
		["create", null, "todo", "card filed"],
		["stage", "todo", "in_progress", "work started"],
		["state", "queued", "preparing", "turn prepared"],
		["state", "preparing", "running", "turn running"],
		["state", "running", "idle", "turn finished"],
		["stage", "in_progress", "done", "card done"],
		["error", null, null, "probe failed: git exited 128"],
	];
	db.exec("BEGIN");
	for (let i = 0; i < perProjectEvents; i++) {
		const [kind, from, to, detail] = eventShapes[i % eventShapes.length]!;
		eventInsert.run(
			Math.floor(NOW - 90 * DAY + (i / perProjectEvents) * 90 * DAY),
			tasks[Math.floor(rand() * tasks.length)]!.id,
			kind,
			from,
			to,
			detail,
		);
	}
	db.exec("COMMIT");

	// Per-task log files, logLinesPerTask lines each (the 2 MiB cap never binds).
	mkdirSync(join(dir, ".tasks", "logs"), { recursive: true });
	const logLines: string[] = [];
	for (let k = 0; k < logLinesPerTask; k++)
		logLines.push(
			`[agent] step ${k + 1}/${logLinesPerTask}: exercised ${pick(SUBJECTS)} and recorded the measurement.\n`,
		);
	const logText = logLines.join("");
	for (const t of tasks)
		writeFileSync(join(dir, ".tasks", "logs", `${t.id}.log`), logText);

	const count = (table: string): number =>
		db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
	const tc = count("tasks");
	const tn = count("turns");
	const te = count("events");
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();

	taskTotal += tc;
	turnTotal += tn;
	eventTotal += te;
	logLineTotal += perProjectTasks * logLinesPerTask;

	// OTTR-884 send-back: the scheduler tick's real flag path (isClean,
	// branchUnpushed, checkedOutBranch, targetTracksRules, archReviewDelta) must
	// run over live repos during the measurement instead of failing into the
	// keep-last-value catch, so every seeded project is a git repo with a clean
	// main and an origin whose main matches. The origin lives outside the
	// projects root: a bare repo under it would mount as a project itself.
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "seed",
		GIT_AUTHOR_EMAIL: "seed@ottr.local",
		GIT_COMMITTER_NAME: "seed",
		GIT_COMMITTER_EMAIL: "seed@ottr.local",
		GIT_AUTHOR_DATE: "@1731500000 +0000",
		GIT_COMMITTER_DATE: "@1731500000 +0000",
	};
	await Bun.$`git init -q -b main ${dir}`.env(gitEnv).quiet();
	await Bun.write(
		join(dir, "AGENTS.md"),
		`# ${name}\n\nSeeded gate fixture.\n`,
	);
	await Bun.$`git -C ${dir} add -A`.env(gitEnv).quiet();
	await Bun.$`git -C ${dir} commit -qm seed`.env(gitEnv).quiet();
	const origin = join(board, "origins", `${name}.git`);
	await Bun.$`git init -q --bare -b main ${origin}`.env(gitEnv).quiet();
	await Bun.$`git -C ${dir} remote add origin ${origin}`.env(gitEnv).quiet();
	await Bun.$`git -C ${dir} push -q origin main`.env(gitEnv).quiet();
	await Bun.$`git -C ${dir} branch -q --set-upstream-to=origin/main main`
		.env(gitEnv)
		.quiet();
}

const ms = Date.now() - t0;
const expect = {
	tasks: perProjectTasks * PROJECTS,
	turns: perProjectTurns * PROJECTS,
	events: perProjectEvents * PROJECTS,
	logLines: TASKS * logLinesPerTask,
};
const ok =
	taskTotal === expect.tasks &&
	turnTotal === expect.turns &&
	eventTotal === expect.events &&
	logLineTotal === expect.logLines;
console.log(
	`ASSERT tasks=${taskTotal} turns=${turnTotal} events=${eventTotal} logLines=${logLineTotal}`,
);
console.log(
	`EXPECT tasks=${expect.tasks} turns=${expect.turns} events=${expect.events} logLines=${expect.logLines}`,
);
console.log(`SEED_OK=${ok} seedDurationMs=${ms}`);
if (!ok) process.exit(1);
