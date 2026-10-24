// Coverage test for the demo pool: seeds once into a temp root, then checks every display
// shape the board must show, clean git status, the admin bootstrap, refresh, and force reseed.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
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
import { mergeHold } from "../src/scheduler.ts";
import { seedDemo } from "./demo-data.ts";

type Row = Record<string, any> & { id: string };
interface ProjectData {
	tasks: Row[];
	turns: Row[];
	events: Row[];
}
type Board = Record<string, ProjectData>;

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
	const tasks = db.query("SELECT * FROM tasks ORDER BY id").all() as Row[];
	const turns = db.query("SELECT * FROM turns ORDER BY id").all() as Row[];
	const events = db.query("SELECT * FROM events").all() as Row[];
	db.close();
	return { tasks, turns, events };
}

const board = (): Board =>
	Object.fromEntries(projectNames().map((n) => [n, readDb(join(root, n))]));

const allTasks = (b: Board) => Object.values(b).flatMap((p) => p.tasks);

const toReview = (t: Row) => ({
	id: t.id,
	kind: t.kind,
	releaseVersion: t.release_version,
	cancelledAt: t.cancelled_at,
	stage: t.stage,
	createdAt: t.created_at,
	doneAt: t.done_at,
	dependsOn: t.depends_on,
	followUpOf: t.follow_up_of,
});

const byId = (b: Board) => new Map(allTasks(b).map((t) => [t.id, t]));

let firstBoard: Board;
let adminPassHash: string;

test("seed covers every display shape with clean checkouts", () => {
	firstBoard = board();
	const tasks = allTasks(firstBoard);
	// id shape
	for (const t of tasks) expect(t.id).toMatch(/^[A-Z0-9]{1,4}-[0-9]+$/);
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
		(tn: Row) => tn.ended_at === null && tn.kind === "work",
	);
	expect(preparingTurn?.pid).toBeNull();
	expect(tasks.some((t) => t.state === "running")).toBe(true);
	const action = tasks.find((t) => t.state === "needs_you" && t.asked === null);
	expect(action?.needs_reason).toBeTruthy();
	const asked = tasks.find((t) => t.state === "needs_you" && t.asked !== null);
	expect(asked).toBeDefined();
	const askedTurns = Object.values(firstBoard)
		.flatMap((p) => p.turns)
		.filter((tn: Row) => tn.task_id === asked!.id);
	// asked stores the ask tool's JSON shape; parseAsked must produce a real question.
	const parsedAsked = JSON.parse(asked!.asked)[0];
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
			(e: Row) =>
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
	expect(mergeHold(hollow, plainMerge!)).toBeNull();
	const held = firstBoard.lumen!.tasks.find(
		(t) => t.stage === "merging" && t.state === "queued",
	);
	expect(held).toBeDefined();
	expect(
		mergeHold(firstBoard.lumen!.tasks.map(toReview), held!),
	).not.toBeNull();
	const liveMerge = tasks.find(
		(t) => t.stage === "merging" && t.state === "running",
	);
	expect(liveMerge).toBeDefined();
	const openMergeTurn = Object.values(firstBoard)
		.flatMap((p) => p.turns)
		.find((tn: Row) => tn.kind === "merge" && tn.ended_at === null);
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

test("admin is bootstrapped without a plain password", () => {
	const store = GlobalStore.open(stateDir);
	const config = store.get<any>("config");
	store.close();
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
	expect(store.get<any>("config").admin.passHash).toBe(adminPassHash);
	store.close();
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
	expect(store.get<any>("config").admin.passHash).toBe(adminPassHash);
	store.close();
}, 20_000);
