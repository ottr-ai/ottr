// Demo data for UI design work (impeccable live, `bun src/dev.ts`): an invented pool of five
// demo projects with tasks, turns and lifecycle events, so charts, tables and cards carry
// realistic, work-like shapes. All text is deterministic — no randomness in the data — while
// live clocks refresh on every boot: open turns and running/preparing cards move forward so a
// running card never looks hours stale. The pool reseeds only when POOL_VERSION changes or you
// pass --force; otherwise existing projects are refreshed in place. An admin login is
// bootstrapped into the global store if (and only if) the board has none.
// Only ever writes under the root it is given; never point it at a real checkout.
import { Database } from "bun:sqlite";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashPassword, newSecret } from "../src/auth.ts";
import { GlobalStore } from "../src/globalStore.ts";
import { ARCH_REVIEW_MARKER } from "../src/prompts.ts";
import { ProjectStore } from "../src/store.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const POOL_VERSION = 3;

type Stage = "todo" | "in_progress" | "merging" | "done";
type RunState = "queued" | "preparing" | "running" | "needs_you" | "idle";

interface Spec {
	/** Prompt override; review cards use the architecture-review marker. */
	prompt?: string;
	title: string;
	stage: Stage;
	state: RunState;
	/** Days ago the task was created. */
	age: number;
	/** Work turn length in minutes; undefined for a todo or review card. */
	work?: number;
	/** Merge turn length in minutes; a done card without one was integrated directly. */
	merge?: number;
	needs?: string;
	crashed?: boolean;
	cancelled?: boolean;
	/** pending_prompt text: a queued reply waiting to be sent. */
	pending?: string;
	/** Indices of tasks this queued card depends on (same project). */
	deps?: number[];
	/** Index of the done task this follow-up continues. */
	followUpOf?: number;
	/** Open question shown on the card; stored as the ask tool's JSON shape. */
	asked?: { q: string; options: string[] };
	research?: boolean;
	release?: { version: string; notes: string };
	/** Sets the trusted review kind on the card; the ARCH_REVIEW_MARKER prompt stays for realism. */
	review?: boolean;
}

interface ProjectSpec {
	name: string;
	displayName: string;
	rules: boolean;
	tasks: Spec[];
}

const POOL: ProjectSpec[] = [
	{
		name: "lumen",
		displayName: "Lumen",
		rules: true,
		tasks: [
			{
				title: "Add a room presence heatmap to the dashboard",
				stage: "done",
				state: "idle",
				age: 9,
				work: 18,
				merge: 4,
			},
			{
				title: "Cut the 1.4 release with the new device pairing flow",
				stage: "done",
				state: "idle",
				age: 5,
				work: 26,
				merge: 6,
				release: {
					version: "1.4.0",
					notes:
						"Device pairing flow, presence heatmap, faster sensor polling.",
				},
			},
			{
				title: "Review the new thermostat schedule editor",
				prompt: `${ARCH_REVIEW_MARKER}the new thermostat schedule editor`,
				review: true,
				stage: "in_progress",
				state: "queued",
				age: 0.3,
			},
			{
				title: "Batch-editing rooms breaks their device assignments",
				stage: "merging",
				state: "queued",
				age: 0.25,
				work: 12,
			},
			{
				title: "Polling the Zigbee coordinator leaks sockets on disconnect",
				stage: "in_progress",
				state: "running",
				age: 0.2,
				work: 0,
			},
			{
				title: "Pairing flow times out on the second access point",
				stage: "in_progress",
				state: "needs_you",
				age: 0.4,
				work: 16,
				needs:
					"esphome build exited 1: ninja: build stopped: subcommand failed.",
				crashed: true,
			},
			{
				title: "Thermostat control needs an auth decision",
				stage: "in_progress",
				state: "needs_you",
				age: 0.6,
				work: 12,
				needs:
					"Wants your answer: keep the local-only token or move to the OAuth device flow?",
				asked: {
					q: "Which auth flow should the dashboard use for thermostat control?",
					options: ["A local-only token", "The OAuth device flow"],
				},
			},
			{
				title: "Draft the weekly energy usage digest email",
				stage: "in_progress",
				state: "queued",
				age: 0.5,
				pending:
					"Drafting the digest — comparing chart rendering options for the email body.",
			},
			{
				title: "Add a device-health badge to the rooms page",
				stage: "todo",
				state: "queued",
				age: 1,
				deps: [4],
			},
			{
				title: "Replace the charting library with a lighter one",
				stage: "done",
				state: "idle",
				age: 7,
				work: 9,
				merge: 2,
				cancelled: true,
			},
			{
				title: "Fix the heatmap legend contrast the review flagged",
				stage: "done",
				state: "idle",
				age: 2,
				work: 7,
				merge: 2,
				followUpOf: 0,
			},
		],
	},
	{
		name: "hollowpine",
		displayName: "Hollowpine",
		rules: true,
		tasks: [
			{
				title: "Save games lose inventory state on restore",
				stage: "done",
				state: "idle",
				age: 8,
				work: 15,
				merge: 3,
			},
			{
				title: "Compare scripting DSL options for room logic",
				stage: "done",
				state: "idle",
				age: 6,
				work: 22,
				merge: 4,
				research: true,
			},
			{
				title: "Typing during cutscenes skips the next dialogue line",
				stage: "merging",
				state: "queued",
				age: 0.4,
				work: 14,
			},
			{
				title: "Add a transcript export to plain text",
				stage: "in_progress",
				state: "preparing",
				age: 0.1,
				work: 0,
			},
			{
				title: "Colors bleed in the HTML renderer on dark themes",
				stage: "todo",
				state: "queued",
				age: 2,
			},
			{
				title: "Parser rewrite stalls on alias conflicts",
				stage: "merging",
				state: "needs_you",
				age: 0.7,
				work: 10,
				needs:
					"Merge conflict in parser.rs needs your call: keep the alias table or the new match arms?",
			},
		],
	},
	{
		name: "tidetrek",
		displayName: "Tidetrek",
		rules: true,
		tasks: [
			{
				title: "Cache station forecast responses for offline reads",
				stage: "done",
				state: "idle",
				age: 10,
				work: 17,
				merge: 4,
			},
			{
				title: "Add a moon-phase strip to the daily view",
				stage: "done",
				state: "idle",
				age: 4,
				work: 12,
				merge: 3,
			},
			{
				title: "Publish the installable PWA manifest v2",
				stage: "merging",
				state: "running",
				age: 0.3,
				work: 11,
			},
			{
				title: "Tide height axis should switch between meters and feet",
				stage: "in_progress",
				state: "needs_you",
				age: 0.5,
				work: 14,
				needs:
					"Waiting on you: pick the default unit for the EU launch — meters only or a toggle?",
			},
			{
				title: "Storm surge warnings as push notifications",
				stage: "todo",
				state: "queued",
				age: 1,
			},
		],
	},
	{
		name: "paperkrane",
		displayName: "Paperkrane",
		rules: false,
		tasks: [
			{
				title: "OCR receipts on upload and store the vendor total",
				stage: "done",
				state: "idle",
				age: 9,
				work: 19,
				merge: 5,
			},
			{
				title: "Monthly totals chart per expense category",
				stage: "done",
				state: "idle",
				age: 5,
				work: 11,
				merge: 2,
			},
			{
				title: "Export a CSV the accountant can import",
				stage: "todo",
				state: "queued",
				age: 2,
			},
		],
	},
	{
		name: "copperline",
		displayName: "Copperline",
		rules: true,
		tasks: [
			{
				title: "Ingest delay announcements from the operator feed",
				stage: "done",
				state: "idle",
				age: 11,
				work: 16,
				merge: 4,
			},
			{
				title: "Delay history graph flattens after midnight UTC",
				stage: "in_progress",
				state: "running",
				age: 0.2,
				work: 0,
			},
			{
				title: "Bookmark frequent routes on the home screen",
				stage: "todo",
				state: "queued",
				age: 3,
			},
		],
	},
];

const POOL_NAMES: Record<string, true> = Object.fromEntries(
	POOL.map((p) => [p.name, true as const]),
);
const STALE_ERROR =
	"Session persistence is still failing at shutdown: Session file changed before rewrite.";

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", ...args], { cwd });
	if (!r.success)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** Lifecycle event row; the specialized inserts below keep the original SQL literals. */
function insertEvent(
	db: Database,
	id: string,
	kind: string,
	from: string | null,
	to: string,
	when: number,
): void {
	db.run(
		"INSERT INTO events (at, task_id, kind, from_value, to_value) VALUES (?, ?, ?, ?, ?)",
		[when, id, kind, from, to],
	);
}

// The ask tool's shape (parseAsked → askQuestions): a bare string parses to null.
function askedJson(t: Spec): string | null {
	if (!t.asked) return null;
	return JSON.stringify([
		{
			question: t.asked.q,
			options: t.asked.options.map((label) => ({ label })),
			multi: false,
			recommended: 0,
		},
	]);
}

function taskDoneAt(t: Spec, now: number): number | null {
	if (t.stage !== "done" || t.merge === undefined) return null;
	return now - t.age * DAY + ((t.work ?? 0) + t.merge) * MIN;
}

function taskCommits(t: Spec, i: number): number | null {
	if (t.stage === "done") return 1 + (i % 3);
	if (t.stage === "merging") return 1;
	return null;
}

/** Field set the lifecycle helpers need again after the task row is written. */
interface TaskSeed {
	id: string;
	prompt: string;
	createdAt: number;
	isDone: boolean;
	spec: Spec;
}

function insertTaskRow(
	db: Database,
	project: ProjectSpec,
	t: Spec,
	i: number,
	now: number,
): TaskSeed {
	// Real task keys (store.ts nextTaskId): the task routes answer 400 "bad task id" to anything else.
	const prefix = project.name
		.replaceAll(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
		.slice(0, 4);
	const id = `${prefix}-${i + 1}`;
	const prompt = t.prompt ?? `fix: ${t.title}`;
	const createdAt = now - t.age * DAY - i * 7 * MIN;
	const isDone = t.stage === "done";
	const doneAt = taskDoneAt(t, now);
	const commits = taskCommits(t, i);
	const dependsOn = JSON.stringify(
		(t.deps ?? []).map((d) => `${prefix}-${d + 1}`),
	);
	// queued_at marks cards that sit in a queue right now.
	const queuedAt = t.state === "queued" ? createdAt : null;
	const updatedAt =
		doneAt ?? (t.stage === "todo" ? createdAt : now - HOUR_STALE);
	db.run(
		`INSERT INTO tasks (id, title, prompt, stage, state, needs_reason, pending_prompt,
			 research, asked, release_version, release_notes, follow_up_of, depends_on,
			 created_at, updated_at, queued_at, cancelled_at, done_at, commits,
			 session_id, session_title, kind)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			t.title.slice(0, 80),
			prompt,
			t.stage,
			t.state,
			t.needs ?? null,
			t.pending ?? null,
			t.research ? 1 : 0,
			askedJson(t),
			t.release?.version ?? null,
			t.release?.notes ?? null,
			t.followUpOf !== undefined ? `${prefix}-${t.followUpOf + 1}` : null,
			dependsOn,
			createdAt,
			updatedAt,
			queuedAt,
			t.cancelled ? now - t.age * DAY + 30 * MIN : null,
			doneAt,
			commits,
			`demo-${id}`,
			t.title.slice(0, 60),
			t.review === true ? "review" : "work",
		],
	);
	return { id, prompt, createdAt, isDone, spec: t };
}

function insertWorkTurn(
	db: Database,
	id: string,
	prompt: string,
	wStart: number,
	wEnd: number | null,
	t: Spec,
	isDone: boolean,
): void {
	const open = wEnd === null;
	let exitCode: number | null = null;
	let outcome: string | null = null;
	let summary: string | null = null;
	if (!open) {
		exitCode = t.crashed ? 1 : 0;
		outcome = isDone || t.stage === "merging" ? "ready" : null;
		summary = isDone ? "Implemented and committed." : null;
	}
	db.run(
		`INSERT INTO turns (task_id, kind, prompt, started_at, ended_at, pid, exit_code, outcome, summary, question, error, model)
			 VALUES (?, 'work', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo/seed')`,
		[
			id,
			prompt,
			wStart,
			wEnd,
			t.state === "preparing" ? null : 41000,
			exitCode,
			outcome,
			summary,
			t.asked?.q ?? null,
			t.crashed ? STALE_ERROR : null,
		],
	);
}

function seedNeedsYouEvents(
	db: Database,
	id: string,
	t: Spec,
	wEnd: number,
): void {
	insertEvent(db, id, "state", "running", "needs_you", wEnd);
	if (!t.crashed) return;
	db.run(
		"INSERT INTO events (at, task_id, kind, to_value, detail) VALUES (?, ?, 'error', 'needs_you', ?)",
		[wEnd, id, t.needs ?? "turn failed"],
	);
}

function seedMergeEvents(
	db: Database,
	id: string,
	t: Spec,
	wEnd: number,
	isDone: boolean,
): void {
	const mStart = wEnd + MIN;
	insertEvent(db, id, "state", "running", "queued", mStart);
	insertEvent(db, id, "stage", "in_progress", "merging", mStart);
	if (isDone && t.merge !== undefined && t.merge > 0) {
		const mEnd = mStart + t.merge * MIN;
		db.run(
			`INSERT INTO turns (task_id, kind, prompt, started_at, ended_at, pid, exit_code, outcome, summary, model)
				 VALUES (?, 'merge', ?, ?, ?, 41001, 0, 'integrated', 'Rebased, verified, integrated.', 'demo/seed')`,
			[id, `integrate: ${t.title}`, mStart, mEnd],
		);
		insertEvent(db, id, "stage", "merging", "done", mEnd);
		insertEvent(db, id, "state", "queued", "idle", mEnd);
		return;
	}
	if (t.stage !== "merging") return;
	if (t.state === "running") {
		// A live merge: open merge turn row, like a running work turn.
		db.run(
			`INSERT INTO turns (task_id, kind, prompt, started_at, pid, model)
				 VALUES (?, 'merge', ?, ?, 41001, 'demo/seed')`,
			[id, `integrate: ${t.title}`, mStart],
		);
	} else if (t.state === "needs_you") {
		const mEnd = mStart + 3 * MIN;
		db.run(
			`INSERT INTO turns (task_id, kind, prompt, started_at, ended_at, pid, exit_code, error, model)
				 VALUES (?, 'merge', ?, ?, ?, 41001, 1, ?, 'demo/seed')`,
			[id, `integrate: ${t.title}`, mStart, mEnd, t.needs ?? "merge failed"],
		);
		insertEvent(db, id, "state", "queued", "needs_you", mEnd);
	}
	// plain queued merge: held or waiting for a slot, no merge turn yet
}

function seedTaskEvents(db: Database, seed: TaskSeed): void {
	const { spec: t, id, prompt, createdAt, isDone } = seed;
	insertEvent(db, id, "create", null, "todo", createdAt);
	if (t.work === undefined) return; // todo or review card: nothing ran yet
	const wStart = createdAt + 2 * MIN;
	const workOpen =
		t.stage === "in_progress" &&
		(t.state === "running" || t.state === "preparing");
	// A null end marks an open turn; everything below only runs for closed ones.
	const wEnd: number | null = workOpen ? null : wStart + t.work * MIN;
	insertEvent(
		db,
		id,
		"state",
		"queued",
		t.state === "preparing" ? "preparing" : "running",
		wStart,
	);
	insertEvent(db, id, "stage", "todo", "in_progress", wStart);
	insertWorkTurn(db, id, prompt, wStart, wEnd, t, isDone);
	if (wEnd === null) return; // open work turn: a live card has no downstream events
	if (t.state === "needs_you" && t.stage === "in_progress") {
		seedNeedsYouEvents(db, id, t, wEnd);
		return;
	}
	if (isDone || t.stage === "merging") seedMergeEvents(db, id, t, wEnd, isDone);
}

function seedProject(root: string, spec: ProjectSpec, now: number): void {
	const dir = join(root, spec.name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	if (spec.rules) {
		// Rules live outside version control: the local exclude keeps git status clean.
		writeFileSync(
			join(dir, "AGENTS.md"),
			"# Demo rules\n\nSeeded by scripts/demo-data.ts for board design work.\n",
		);
		appendFileSync(join(dir, ".git", "info", "exclude"), "AGENTS.md\n");
	}
	// init() creates the schema and the self-ignoring .tasks/.worktrees gitignores.
	ProjectStore.init(dir).close();
	git(
		dir,
		"-c",
		"user.name=ottr",
		"-c",
		"user.email=ottr@localhost",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"chore: bootstrap",
	);

	// Raw handle on purpose: pre-boot seeding, no ProjectStore lock held.
	const db = new Database(join(dir, ".tasks", "tasks.db"));
	db.run("INSERT INTO settings (key, value) VALUES ('displayName', ?)", [
		JSON.stringify(spec.displayName),
	]);

	spec.tasks.forEach((t, i) => {
		const seed = insertTaskRow(db, spec, t, i, now);
		seedTaskEvents(db, seed);
	});
	// A task created on the demo board continues the key sequence instead of probing taken ids.
	db.run(
		"INSERT INTO settings (key, value) VALUES ('next-task-num', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[JSON.stringify(spec.tasks.length + 1)],
	);
	db.close();
}

const HOUR_STALE = 60 * 60 * 1000;

/** Directories in root that look like pool projects but are not in the pool. */
function removeStaleProjects(root: string): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name in POOL_NAMES) continue;
		if (existsSync(join(root, entry.name, ".tasks", "tasks.db")))
			rmSync(join(root, entry.name), { recursive: true, force: true });
	}
}

/** Keep live clocks plausible on an existing board: running/preparing cards restarted a
 * moment ago, their open turns with them. Raw handles, no ProjectStore lock. */
function refreshLive(root: string, names: string[]): void {
	const now = Date.now();
	for (const name of names) {
		const dbPath = join(root, name, ".tasks", "tasks.db");
		if (!existsSync(dbPath)) continue;
		const db = new Database(dbPath);
		db.run(
			"UPDATE tasks SET created_at = ?, updated_at = ? WHERE state IN ('running','preparing') AND cancelled_at IS NULL",
			[now - 5 * MIN, now],
		);
		db.run(
			"UPDATE turns SET started_at = ? WHERE ended_at IS NULL AND task_id IN (SELECT id FROM tasks WHERE state IN ('running','preparing'))",
			[now - 3 * MIN],
		);
		db.close();
	}
}

/** Make sure the board has an admin login; an existing one always wins. The plain password
 * exists only long enough to be hashed and is never printed or stored. */
function ensureAdmin(stateDir: string): void {
	const store = GlobalStore.open(stateDir);
	try {
		const config = store.get<Record<string, unknown>>("config");
		const admin = config?.admin as
			| { name?: unknown; passHash?: unknown }
			| undefined;
		if (
			admin &&
			typeof admin.name === "string" &&
			typeof admin.passHash === "string"
		)
			return;
		store.set("config", {
			...config,
			admin: { name: "dev", passHash: hashPassword(newSecret()) },
			sessionSecret: newSecret(),
			apiKey: newSecret(),
		});
	} finally {
		store.close();
	}
}

interface SeedMarker {
	seededAt: number;
	version: number;
	projects: string[];
}

function readMarker(root: string): SeedMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "seeded.json"), "utf8"));
		return parsed as SeedMarker;
	} catch {
		return null; // missing or corrupt marker: treat as never seeded
	}
}

export function seedDemo(
	root: string,
	force = false,
	stateDir: string = process.env.OTTR_STATE_DIR ?? join(root, "state"),
): void {
	mkdirSync(root, { recursive: true });
	const marker = readMarker(root);
	const reseed = force || marker?.version !== POOL_VERSION;
	if (reseed) {
		removeStaleProjects(root);
		const now = Date.now();
		for (const spec of POOL) seedProject(root, spec, now);
		writeFileSync(
			join(root, "seeded.json"),
			JSON.stringify({
				seededAt: now,
				version: POOL_VERSION,
				projects: POOL.map((p) => p.name),
			}),
		);
	}
	// A running card must read as just-restarted on every boot, a fresh seed included.
	refreshLive(root, reseed ? POOL.map((p) => p.name) : marker!.projects);
	ensureAdmin(stateDir);
}

if (import.meta.main) {
	const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
	const root = resolveRoot(positional);
	const force = process.argv.includes("--force");
	seedDemo(root, force);
	console.log(
		`demo data ${force ? "reseeded" : "seeded or refreshed"} in ${root}`,
	);
}

function resolveRoot(arg?: string): string {
	if (arg) return arg;
	// default: this repo's .dev scratch, matching src/dev.ts
	return join(import.meta.dir, "..", ".dev");
}
