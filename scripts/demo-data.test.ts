// Coverage test for the demo pool: seeds once into a temp root, then checks every display
// shape the board must show, clean git status, the admin bootstrap, refresh, and force reseed.
import { Database } from "bun:sqlite";
import { afterAll, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalStore } from "../src/globalStore.ts";
import { RETRO_MARKER } from "../src/prompts.ts";
import { mergeHold } from "../src/scheduler.ts";
import { ProjectStore } from "../src/store.ts";
import type { RunState, Stage, TaskKind } from "../src/types.ts";
import { strykerProgress } from "../src/ui/status.ts";
import {
	demoProgressMap,
	heldDb,
	insertTaskRow,
	type ProjectSpec,
	seedDemo,
} from "./demo-data.ts";

// The columns of tasks, turns, and events this file reads, with the schema's types.
type TaskRow = {
	id: string;
	kind: TaskKind;
	stage: Stage;
	state: RunState;
	title: string;
	created_at: number;
	done_at: number | null;
	cancelled_at: number | null;
	needs_reason: string | null;
	pending_prompt: string | null;
	pending_by: "user" | "supervisor" | null;
	asked: string | null;
	depends_on: string;
	follow_up_of: string | null;
	release_version: string | null;
	release_notes: string | null;
	commits: string | null;
	push_retries: number;
	research: number;
} & Record<string, unknown>;
type TurnRow = {
	kind: string;
	task_id: string;
	ended_at: number | null;
	pid: number | null;
	prompt: string;
	question: string;
} & Record<string, unknown>;
type EventRow = {
	kind: string;
	to_value: string;
	task_id: string;
} & Record<string, unknown>;
interface ProjectData {
	tasks: TaskRow[];
	turns: TurnRow[];
	events: EventRow[];
}
type Board = Record<string, ProjectData>;
// The shape the demo seed writes under the "config" global key.
type GlobalConfig = {
	admin: { name: string; passHash: string };
	githubToken?: unknown;
};

const root = mkdtempSync(join(tmpdir(), "demo-data-"));
const stateDir = join(root, "state");
seedDemo(root, false, stateDir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function projectNames(): string[] {
	return readdirSync(root, { withFileTypes: true })
		.filter(
			(d) =>
				d.isDirectory() && existsSync(join(root, d.name, ".tasks", "tasks.db")),
		)
		.map((d) => d.name);
}

function readDb(dir: string): ProjectData {
	const db = new Database(join(dir, ".tasks", "tasks.db"));
	const tasks = db.query("SELECT * FROM tasks ORDER BY id").all() as TaskRow[];
	const turns = db.query("SELECT * FROM turns ORDER BY id").all() as TurnRow[];
	const events = db.query("SELECT * FROM events").all() as EventRow[];
	db.close();
	return { tasks, turns, events };
}

const board = (): Board =>
	Object.fromEntries(projectNames().map((n) => [n, readDb(join(root, n))]));

const allTasks = (b: Board) => Object.values(b).flatMap((p) => p.tasks);

const toReview = (t: TaskRow) => ({
	id: t.id,
	kind: t.kind,
	releaseVersion: t.release_version,
	cancelledAt: t.cancelled_at,
	stage: t.stage,
	state: t.state,
	pushRetries: t.push_retries,
	pendingBy: t.pending_by,
	createdAt: t.created_at,
	doneAt: t.done_at,
	dependsOn: JSON.parse(t.depends_on) as string[],
	followUpOf: t.follow_up_of,
});

const byId = (b: Board) => new Map(allTasks(b).map((t) => [t.id, t]));

let firstBoard: Board;
let adminPassHash: string;

test("seed covers every display shape with clean checkouts", () => {
	firstBoard = board();
	const tasks = allTasks(firstBoard);
	// id shape; a retro is its source card's `-retro` child (store.ts createTask)
	for (const t of tasks)
		expect(t.id).toMatch(
			t.kind === "retro"
				? /^[A-Z0-9]{1,4}-[0-9]+-retro$/
				: /^[A-Z0-9]{1,4}-[0-9]+$/,
		);
	// no-AGENTS.md project has a queued todo
	const noRules = "paperkrane";
	expect(existsSync(join(root, noRules, "AGENTS.md"))).toBe(false);
	expect(
		firstBoard[noRules]!.tasks.some(
			(t) => t.stage === "todo" && t.state === "queued",
		),
	).toBe(true);
	// todo coverage: plain queued, dependency-held, pending reply
	expect(
		tasks.some(
			(t) =>
				t.stage === "todo" &&
				t.state === "queued" &&
				t.depends_on === "[]" &&
				t.pending_prompt === null,
		),
	).toBe(true);
	const depCard = tasks.find(
		(t) => t.stage === "todo" && JSON.parse(t.depends_on).length > 0,
	);
	expect(depCard).toBeDefined();
	const depIds = JSON.parse(depCard!.depends_on) as string[];
	expect(depIds.length).toBeGreaterThan(0);
	const lookup = byId(firstBoard);
	const dep = lookup.get(depIds[0]!)!;
	expect(dep.stage !== "done" && dep.cancelled_at === null).toBe(true);
	const pending = tasks.find((t) => t.pending_prompt !== null);
	expect(pending?.stage).toBe("in_progress");
	expect(pending?.state).toBe("queued");
	// in_progress coverage
	expect(tasks.some((t) => t.state === "preparing")).toBe(true);
	const preparingTurn = firstBoard.hollowpine!.turns.find(
		(tn: TurnRow) => tn.ended_at === null && tn.kind === "work",
	);
	expect(preparingTurn?.pid).toBeNull();
	expect(tasks.some((t) => t.state === "running")).toBe(true);
	// the mutation-gate card: in progress and running, its open work turn runs the gate
	const gate = tasks.find((t) => /mutation gate/i.test(t.title));
	expect(gate?.stage).toBe("in_progress");
	expect(gate?.state).toBe("running");
	const gateTurn = Object.values(firstBoard)
		.flatMap((p) => p.turns)
		.find((tn: TurnRow) => tn.task_id === gate!.id && tn.kind === "work");
	expect(gateTurn?.ended_at).toBeNull();
	expect(gateTurn?.prompt).toMatch(/mutation gate/i);
	const action = tasks.find((t) => t.state === "needs_you" && t.asked === null);
	expect(action?.needs_reason).toBeTruthy();
	const asked = tasks.find((t) => t.state === "needs_you" && t.asked !== null);
	expect(asked).toBeDefined();
	const askedTurns = Object.values(firstBoard)
		.flatMap((p) => p.turns)
		.filter((tn: TurnRow) => tn.task_id === asked!.id);
	// asked stores the ask tool's JSON shape; parseAsked must produce a real question.
	const askedJson = asked?.asked;
	if (askedJson === undefined || askedJson === null)
		throw new Error("asked card without an asked payload");
	const parsedAsked = JSON.parse(askedJson)[0];
	expect(parsedAsked.question).toBeTruthy();
	expect(parsedAsked.options.length).toBeGreaterThan(0);
	expect(askedTurns.at(-1)?.question).toBe(parsedAsked.question);
	// crash: needs_you with an error event landing on needs_you
	const crashed = tasks.find(
		(t) => t.state === "needs_you" && t.needs_reason?.includes("exited"),
	);
	expect(crashed).toBeDefined();
	const crashedEvents = Object.values(firstBoard).flatMap((p) => p.events);
	expect(
		crashedEvents.some(
			(e: EventRow) =>
				e.kind === "error" &&
				e.to_value === "needs_you" &&
				e.task_id === crashed!.id,
		),
	).toBe(true);
	// merging coverage
	const hollow = firstBoard.hollowpine!.tasks.map(toReview);
	const plainMerge = firstBoard.hollowpine!.tasks.find(
		(t) => t.stage === "merging" && t.state === "queued",
	);
	expect(plainMerge).toBeDefined();
	expect(mergeHold(hollow, toReview(plainMerge!))).toBeNull();
	const held = firstBoard.lumen!.tasks.find(
		(t) => t.stage === "merging" && t.state === "queued",
	);
	expect(held).toBeDefined();
	expect(
		mergeHold(firstBoard.lumen!.tasks.map(toReview), toReview(held!)),
	).not.toBeNull();
	const liveMerge = tasks.find(
		(t) => t.stage === "merging" && t.state === "running",
	);
	expect(liveMerge).toBeDefined();
	const openMergeTurn = Object.values(firstBoard)
		.flatMap((p) => p.turns)
		.find((tn: TurnRow) => tn.kind === "merge" && tn.ended_at === null);
	expect(openMergeTurn?.task_id).toBe(liveMerge!.id);
	expect(
		tasks.some((t) => t.stage === "merging" && t.state === "needs_you"),
	).toBe(true);
	// done coverage
	expect(tasks.some((t) => t.stage === "done" && t.commits !== null)).toBe(
		true,
	);
	expect(tasks.some((t) => t.stage === "done" && t.cancelled_at !== null)).toBe(
		true,
	);
	const followUp = tasks.find((t) => t.follow_up_of !== null);
	expect(followUp?.stage).toBe("done");
	expect(lookup.get(followUp!.follow_up_of!)?.stage).toBe("done");
	const release = tasks.find((t) => t.release_version !== null);
	expect(release?.release_notes).toBeTruthy();
	expect(release?.stage).toBe("done");
	expect(tasks.some((t) => t.research === 1 && t.stage === "done")).toBe(true);
	// clean checkouts everywhere
	for (const name of projectNames()) {
		const r = Bun.spawnSync([
			"git",
			"-C",
			join(root, name),
			"status",
			"--porcelain",
		]);
		expect(r.stdout.toString()).toBe("");
	}
});

// The pool seeds one retro with a pending proposal: the shapes the lineage rail and the
// proposal box read (store.ts createTask's retro child id, prompts.ts proposedReason).
test("the seeded retro files a proposal that waits for a decision", () => {
	const lookup = byId(firstBoard);
	const lumen = firstBoard.lumen!;
	const source = lumen.tasks.find(
		(t) => t.title === "Fix the heatmap legend contrast the review flagged",
	)!;
	const retro = lookup.get(`${source.id}-retro`)!;
	expect(retro.kind).toBe("retro");
	expect(retro.stage).toBe("done");
	expect(retro.state).toBe("idle");
	expect(retro.follow_up_of).toBe(source.id);
	// The marker rides once over the source title, in the prompt and the title alike
	// (src/prompts.ts retroPrompt): a doubled "Retro of Retro of" is the defect this pins.
	expect(retro.prompt).toBe(`${RETRO_MARKER}${source.title}`);
	expect(retro.title).toBe(`${RETRO_MARKER}${source.title}`);
	expect(retro.done_at).not.toBeNull();
	expect(retro.commits).toBeNull();
	// The source card's Work steps show the retro's turn, so the retro has one.
	const retroTurn = lumen.turns.find((tn: TurnRow) => tn.task_id === retro.id);
	expect(retroTurn?.ended_at).not.toBeNull();
	expect(retroTurn?.outcome).toBe("answered");
	// The retro settled: its timeline carries the stage and state transitions.
	const retroEvents = lumen.events.filter(
		(e: EventRow) => e.task_id === retro.id,
	);
	expect(
		retroEvents.some(
			(e: EventRow) => e.kind === "stage" && e.to_value === "done",
		),
	).toBe(true);
	expect(
		retroEvents.some(
			(e: EventRow) => e.kind === "state" && e.to_value === "idle",
		),
	).toBe(true);

	const proposal = lumen.tasks.find((t) =>
		t.needs_reason?.startsWith("Retro proposal from "),
	)!;
	expect(proposal.kind).toBe("work");
	expect(proposal.stage).toBe("todo");
	expect(proposal.state).toBe("needs_you");
	expect(proposal.cancelled_at).toBeNull();
	expect(proposal.queued_at).toBeNull();
	expect(proposal.follow_up_of).toBe(retro.id);
	expect(proposal.needs_reason).toBe(
		`Retro proposal from ${retro.id}. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
	);
	// A proposal never ran a turn, and the retro consumed no counter value.
	expect(
		lumen.turns.find((tn: TurnRow) => tn.task_id === proposal.id),
	).toBeUndefined();
	const counter = new Database(join(root, "lumen", ".tasks", "tasks.db"))
		.query<{ value: string }, []>(
			"SELECT value FROM settings WHERE key = 'next-task-num'",
		)
		.get()!.value;
	expect(JSON.parse(counter)).toBe(14);
});

// The dev board shows the mutation meter only when progress parses as a Stryker line, so
// the fabricated line must parse, and only the gate card may carry it.
test("demo progress fabricates a parseable Stryker line for the gate card alone", () => {
	const gate = allTasks(firstBoard).find((t) =>
		/mutation gate/i.test(t.title),
	)!;
	const store = ProjectStore.open(join(root, "hollowpine"));
	const lines = demoProgressMap([["hollowpine", { store }]]);
	store.close();
	const line = lines.get(`hollowpine/${gate.id}`);
	expect(line).toBeDefined();
	const parsed = strykerProgress(line!);
	expect(parsed).not.toBeNull();
	expect(parsed!.pct).toBeGreaterThan(0);
	expect(parsed!.tested).toBeLessThan(parsed!.total);
	// no other running card runs the gate, so no other line exists
	expect(lines.size).toBe(1);
});

test("admin is bootstrapped without a plain password", () => {
	const store = GlobalStore.open(stateDir);
	const config = store.get<GlobalConfig>("config");
	store.close();
	if (config === null) throw new Error("config missing after seed");
	expect(typeof config.admin.name).toBe("string");
	expect(typeof config.admin.passHash).toBe("string");
	expect(config.admin.passHash.length).toBeGreaterThan(0);
	// ponytail: scrypt hash format is salt:hash; a plain secret never lands in config
	expect(config.githubToken).toBeUndefined();
	adminPassHash = config.admin.passHash;
});

test("second seed refreshes live clocks and keeps the rest", () => {
	const before = byId(board());
	const running = [...before.values()].find((t) => t.state === "running")!;
	const done = [...before.values()].find(
		(t) => t.stage === "done" && t.state === "idle",
	)!;
	seedDemo(root, false, stateDir);
	const after = byId(board());
	expect(after.get(running.id)!.created_at).toBeGreaterThanOrEqual(
		running.created_at,
	);
	expect(after.get(done.id)!.created_at).toBe(done.created_at);
	const store = GlobalStore.open(stateDir);
	expect(store.get<GlobalConfig>("config")?.admin.passHash).toBe(adminPassHash);
	store.close();
});

test("a project db held by another writer is skipped with a warning, the rest refresh", () => {
	const names = projectNames();
	const runningIn = (name: string) =>
		readDb(join(root, name)).tasks.find((t) => t.state === "running");
	const lockedName = names.find((n) => runningIn(n) !== undefined)!;
	const freeName = names.find(
		(n) => n !== lockedName && runningIn(n) !== undefined,
	)!;
	const lockedPath = join(root, lockedName, ".tasks", "tasks.db");
	// Backdate both so a refresh is observable.
	for (const name of [lockedName, freeName]) {
		const db = new Database(join(root, name, ".tasks", "tasks.db"));
		db.run("UPDATE tasks SET created_at = 1 WHERE state = 'running'");
		db.close();
	}
	const holder = new Database(lockedPath);
	holder.run("BEGIN IMMEDIATE");
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(heldDb(root)).toBe(lockedPath);
		seedDemo(root, false, stateDir);
		const warned = warn.mock.calls.flat().join("\n");
		expect(warned).toContain(lockedPath);
		expect(warned).not.toContain(freeName);
	} finally {
		warn.mockRestore();
		holder.run("ROLLBACK");
		holder.close();
	}
	expect(heldDb(root)).toBeNull();
	expect(runningIn(lockedName)!.created_at).toBe(1);
	expect(runningIn(freeName)!.created_at).toBeGreaterThan(1);
});

test("a failed demo project seed leaves no partial rows", () => {
	const failedRoot = mkdtempSync(join(tmpdir(), "demo-seed-failure-"));
	const projectDir = join(failedRoot, "lumen");
	const dbPath = join(projectDir, ".tasks", "tasks.db");
	const initialize = ProjectStore.init;
	const init = spyOn(ProjectStore, "init").mockImplementation((dir) => {
		const store = initialize(dir);
		if (dir === projectDir) {
			store.close();
			const db = new Database(dbPath);
			try {
				// Abort only after earlier task, turn, and event writes succeed.
				db.run(`CREATE TRIGGER fail_demo_seed BEFORE INSERT ON events
					WHEN (SELECT COUNT(*) FROM tasks) > 1
						AND EXISTS (SELECT 1 FROM turns)
						AND EXISTS (SELECT 1 FROM events)
					BEGIN
						SELECT RAISE(ABORT, 'injected demo seed write failure');
					END`);
			} finally {
				db.close();
			}
		}
		return store;
	});
	let failure: unknown;
	try {
		seedDemo(failedRoot, false, join(failedRoot, "state"));
	} catch (err) {
		failure = err;
	} finally {
		init.mockRestore();
	}
	const db = new Database(dbPath);
	try {
		db.run("DROP TRIGGER fail_demo_seed");
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toHaveProperty(
			"message",
			"injected demo seed write failure",
		);
		expect(db.query("SELECT * FROM tasks").all()).toEqual([]);
		expect(db.query("SELECT * FROM turns").all()).toEqual([]);
		expect(db.query("SELECT * FROM events").all()).toEqual([]);
		expect(
			db.query("SELECT value FROM settings WHERE key = 'displayName'").get(),
		).toBeNull();
	} finally {
		db.close();
	}
});

// Two full seeds exceed bun's 5s default on slow machines; the cap is not the assertion.
test("force reseed replaces the pool and drops stale projects", () => {
	const refreshed = [...byId(board()).values()].find(
		(t) => t.state === "running",
	)!;
	const junk = join(root, "junkbox");
	mkdirSync(join(junk, ".tasks"), { recursive: true });
	new Database(join(junk, ".tasks", "tasks.db")).close();
	seedDemo(root, true, stateDir);
	expect(existsSync(junk)).toBe(false);
	const reseeded = byId(board()).get(refreshed.id)!;
	// every boot leaves a running card freshly restarted, a force reseed included
	expect(reseeded.created_at).toBeGreaterThanOrEqual(Date.now() - 10 * 60_000);
	const store = GlobalStore.open(stateDir);
	expect(store.get<GlobalConfig>("config")?.admin.passHash).toBe(adminPassHash);
	store.close();
}, 20_000);

// plantCards regression (OTTR-776): a fixture spec with an empty tasks array routes
// through seedTaskId's index counting, which cannot see the rows the pool seed wrote
// and derives the same first id for every plant. A plant passes explicit ids instead.
test("insertTaskRow honors an explicit id for fixture plants", () => {
	const dir = mkdtempSync(join(tmpdir(), "demo-plant-"));
	try {
		ProjectStore.init(dir).close();
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		try {
			const lumen: ProjectSpec = {
				name: "lumen",
				displayName: "Lumen",
				rules: true,
				tasks: [],
			};
			const now = Date.now();
			const pr = insertTaskRow(
				db,
				lumen,
				{
					title: "Move the thermostat scheduler to the rules engine",
					stage: "merging",
					state: "queued",
					age: 0.2,
					work: 12,
				},
				12,
				now,
				"LUME-13",
			);
			const done = insertTaskRow(
				db,
				lumen,
				{
					title: "Fix the sensor polling backoff on reconnect",
					stage: "done",
					state: "idle",
					age: 0.3,
					work: 9,
					merge: 2,
				},
				13,
				now,
				"LUME-14",
			);
			expect(pr.id).toBe("LUME-13");
			expect(done.id).toBe("LUME-14");
			// Without an override the id still comes from seedTaskId's index counting.
			const seeded: ProjectSpec = {
				name: "lumen",
				displayName: "Lumen",
				rules: false,
				tasks: [
					{
						title: "Add a room presence heatmap to the dashboard",
						stage: "todo",
						state: "idle",
						age: 1,
					},
				],
			};
			const plain = insertTaskRow(db, seeded, seeded.tasks[0]!, 0, now);
			expect(plain.id).toBe("LUME-1");
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
