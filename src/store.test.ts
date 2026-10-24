import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreLockedError } from "./dblock.ts";
import {
	ARCH_REVIEW_MARKER,
	RETRO_MARKER,
	RULES_INTERVIEW_MARKER,
} from "./prompts.ts";
import {
	DEFAULT_SETTINGS,
	discoverProjects,
	ProjectStore,
	shortTitle,
	tasksDirFor,
} from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "store-model-"));
const opened: ProjectStore[] = [];
/** Track every store so teardown closes them: an open SQLite file makes rmSync EBUSY on Windows. */
const open = (dbPath: string) => {
	const store = ProjectStore.open(dbPath);
	opened.push(store);
	return store;
};
afterAll(() => {
	for (const store of opened) store.close(); // double close is a no-op
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("reorderQueue", () => {
	test("exact permutation moves a task to the front as queueIds reports", () => {
		const store = open(join(root, "reorder"));
		const a = store.createTask("a");
		const b = store.createTask("b");
		const c = store.createTask("c");
		// Distinct queuedAt so the initial order cannot depend on same-millisecond ties.
		store.updateTask(a.id, { queuedAt: 1 });
		store.updateTask(b.id, { queuedAt: 2 });
		store.updateTask(c.id, { queuedAt: 3 });
		expect(store.queueIds()).toEqual([a.id, b.id, c.id]);
		expect(store.reorderQueue([c.id, a.id, b.id])).toBe(true);
		expect(store.queueIds()).toEqual([c.id, a.id, b.id]);
		store.close();
	});

	test("wrong length, duplicate id, and unknown id each return false without writing", () => {
		const store = open(join(root, "reorder-bad"));
		const a = store.createTask("a");
		const b = store.createTask("b");
		store.updateTask(a.id, { queuedAt: 1 });
		store.updateTask(b.id, { queuedAt: 2 });
		const before = store.queueIds();
		expect(store.reorderQueue([a.id])).toBe(false);
		expect(store.reorderQueue([a.id, a.id])).toBe(false);
		expect(store.reorderQueue([a.id, "nope"])).toBe(false);
		expect(store.queueIds()).toEqual(before);
		expect(store.reorderQueue([a.id, b.id])).toBe(true);
		store.close();
	});
});

describe("turn model", () => {
	test("finishTurn stores the model and listTurns returns it", () => {
		const store = open(join(root, "fresh"));
		const task = store.createTask("do things");
		const turn = store.startTurn(task.id, "work", "do things", null);
		expect(turn.model).toBeNull();
		store.finishTurn(turn.id, {
			endedAt: Date.now(),
			model: "zai/glm-5.3-flash",
		});
		expect(store.listTurns(task.id)[0]?.model).toBe("zai/glm-5.3-flash");
		store.close();
	});

	test("open backfills turns.model on a pre-existing database", () => {
		const dir = join(root, "legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the model column existed.
		db.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT)",
		);
		db.close();
		const store = open(dir);
		const task = store.createTask("legacy");
		const turn = store.startTurn(task.id, "work", "legacy", null);
		store.finishTurn(turn.id, { model: "openai/gpt-5" });
		expect(store.listTurns(task.id)[0]?.model).toBe("openai/gpt-5");
		store.close();
	});
});

describe("editTask", () => {
	test("replaces the prompt and re-derives the title from the new first line", () => {
		const store = open(join(root, "editable"));
		const task = store.createTask("first line\nsecond line");
		expect(task.title).toBe("first line");
		const edited = store.editTask(task.id, "renamed lead\nnew body");
		expect(edited.prompt).toBe("renamed lead\nnew body");
		expect(edited.title).toBe("renamed lead");
		expect(edited.stage).toBe("todo");
		store.close();
	});
});

describe("deriveTitle", () => {
	test("skips section labels and strips heading marks", () => {
		const store = open(join(root, "derive-title"));
		const cases: Array<[string, string]> = [
			["# Goal\n\nFix the login redirect\nmore", "Fix the login redirect"],
			["# Set up agent rules for demo\nbody", "Set up agent rules for demo"],
			["first line\nsecond line", "first line"],
			["# Goal", "Goal"],
		];
		for (const [prompt, title] of cases)
			expect(store.createTask(prompt).title).toBe(title);
		store.close();
	});

	test("edited cards re-derive with section labels skipped", () => {
		const store = open(join(root, "derive-title-edit"));
		const task = store.createTask("# Goal\nfirst title");
		expect(task.title).toBe("first title");
		const edited = store.editTask(task.id, "# Goal\nsecond title");
		expect(edited.title).toBe("second title");
		store.close();
	});
});

describe("asked", () => {
	const ask = [
		{
			question: "Which way?",
			options: [{ label: "A", description: "faster" }, { label: "B" }],
			multi: false,
			recommended: 1,
		},
	];

	test("updateTask stores the ask and getTask parses it back", () => {
		const store = open(join(root, "asked"));
		const task = store.createTask("do things");
		expect(store.getTask(task.id)?.asked).toBeNull();
		store.updateTask(task.id, { asked: ask });
		expect(store.getTask(task.id)?.asked).toEqual(ask);
		store.close();
	});

	test("null clears and corrupt JSON parses back as null instead of throwing", () => {
		const store = open(join(root, "asked-bad"));
		const task = store.createTask("do things");
		store.updateTask(task.id, { asked: "{not json" as unknown as typeof ask });
		expect(store.getTask(task.id)?.asked).toBeNull();
		store.updateTask(task.id, { asked: null });
		expect(store.getTask(task.id)?.asked).toBeNull();
		store.close();
	});
});

describe("frozenTitle", () => {
	test("persists the session's first title once; a later rewrite cannot rename the card", () => {
		const store = open(join(root, "frozen-title"));
		const sid = "bbbb0000-0000-0000-0000-000000000101";
		const task = store.updateTask(store.createTask("still untitled").id, {
			sessionId: sid,
		});
		expect(store.frozenTitle(task)).toBe(shortTitle("still untitled")); // no session file yet: prompt-line fallback
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"Persisted"}\n{"type":"session"}\n{"type":"title_change","title":"Persisted"}\n',
		);
		expect(store.frozenTitle(task)).toBe("Persisted");
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"Renamed"}\n{"type":"session"}\n{"type":"title_change","title":"Renamed"}\n',
		);
		expect(store.frozenTitle(task)).toBe("Persisted"); // the first write stays authoritative
		store.close();
	});
});

describe("shortTitle", () => {
	test("short lines pass through, long lines cut at a word boundary", () => {
		expect(shortTitle("Fix the login bug")).toBe("Fix the login bug");
		const long =
			"Fix the login bug when the session cookie expires mid request";
		const named = shortTitle(long);
		expect(named.endsWith("…")).toBe(true);
		expect(named.length).toBeLessThanOrEqual(49);
		expect(named).toBe("Fix the login bug when the session cookie…");
		expect(shortTitle("a".repeat(80))).toBe(`${"a".repeat(48)}…`); // no space: hard cut
	});
});

describe("settings", () => {
	test("displayName and releaseCommand survive a reopen, reset to null, and leave the other settings alone", () => {
		const dir = join(root, "settings-name");
		let store = open(dir);
		expect(store.getSettings().displayName).toBeNull();
		expect(store.getSettings().releaseCommand).toBeNull();
		store.setSettings({ maxParallel: 3 });
		store.setSettings({ displayName: "Ottr" });
		store.setSettings({ releaseCommand: "node scripts/release.mjs --ottr" });
		store.setSettings({
			archReviewCap: 80,
			maxImages: 4,
		});
		store.close();
		store = open(dir);
		expect(store.getSettings()).toEqual({
			maxParallel: 3,
			copyExtra: [],
			displayName: "Ottr",
			releaseCommand: "node scripts/release.mjs --ottr",
			archReviewCap: 80,
			maxImages: 4,
			keptWorktreeDays: 7,
			autoTend: false,
			autoTendLimit: 12,
			tendChurnGlobs: [],
			holdUpdateMerges: false,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			setupChecklist: false,
		});
		store.setSettings({ displayName: null, releaseCommand: null });
		expect(store.getSettings()).toEqual({
			maxParallel: 3,
			copyExtra: [],
			displayName: null,
			releaseCommand: null,
			archReviewCap: 80,
			maxImages: 4,
			keptWorktreeDays: 7,
			autoTend: false,
			autoTendLimit: 12,
			tendChurnGlobs: [],
			holdUpdateMerges: false,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			setupChecklist: false,
		});
		store.close();
	});

	test("numeric knobs keep the defaults when unset and persist overrides", () => {
		const dir = join(root, "settings-numbers");
		const probe = open(dir);
		expect(probe.getSettings()).toMatchObject({
			archReviewCap: 150,
			maxImages: 8,
			keptWorktreeDays: 7,
		});
		probe.close();
		const store = open(dir);
		store.setSettings({ archReviewCap: 300 });
		expect(store.getSettings().archReviewCap).toBe(300);
		expect(store.getSettings().maxImages).toBe(8);
		store.close();
	});

	test("keptWorktreeDays defaults to 7 and survives setSettings plus a reopen", () => {
		const dir = join(root, "settings-kept-days");
		let store = open(dir);
		expect(store.getSettings().keptWorktreeDays).toBe(7);
		store.setSettings({ keptWorktreeDays: 3 });
		store.close();
		store = open(dir);
		expect(store.getSettings().keptWorktreeDays).toBe(3);
		store.close();
	});

	test("retro settings default off+filtered, persist across reopen, and reset to null", () => {
		const dir = join(root, "settings-retro");
		let store = open(dir);
		expect(store.getSettings().retroSince).toBeNull();
		expect(store.getSettings().retroFilter).toBe(true);
		const since = 1_700_000_000_000;
		store.setSettings({ retroSince: since, retroFilter: false });
		store.close();
		store = open(dir);
		// retroSince is an epoch number, so the settings key-value read path keeps it
		// exactly; no column or migration involved.
		expect(store.getSettings().retroSince).toBe(since);
		expect(store.getSettings().retroFilter).toBe(false);
		// Off again: the row resets to null instead of being deleted.
		store.setSettings({ retroSince: null });
		expect(store.getSettings().retroSince).toBeNull();
		store.close();
	});

	test("runningPids lists only pids of turns that never ended", () => {
		const store = open(join(root, "running-pids"));
		const t = store.createTask("w");
		const live = store.startTurn(t.id, "work", "p", 4242);
		const ended = store.startTurn(t.id, "work", "p", 5151);
		const noPid = store.startTurn(t.id, "work", "p", null);
		store.finishTurn(ended.id, { endedAt: Date.now(), exitCode: 0 });
		expect(store.runningPids()).toEqual([4242]);
		store.finishTurn(live.id, { endedAt: Date.now(), exitCode: 0 });
		expect(store.runningPids()).toEqual([]);
		store.finishTurn(noPid.id, { exitCode: 0 });
		store.close();
	});

	test("auto-tend settings keep the defaults, persist across reopen, and fall back on a corrupt row", () => {
		const dir = join(root, "settings-auto-tend");
		const probe = open(dir);
		expect(probe.getSettings()).toMatchObject({
			autoTend: false,
			autoTendLimit: 12,
			tendChurnGlobs: [],
		});
		probe.setSettings({
			autoTend: true,
			autoTendLimit: 5,
			tendChurnGlobs: ["**/*.import"],
		});
		probe.close();
		// Corrupt the tendChurnGlobs row directly: parse failure must keep the default.
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.run("UPDATE settings SET value = '{oops' WHERE key = 'tendChurnGlobs'");
		raw.close();
		const store = open(dir);
		expect(store.getSettings()).toMatchObject({
			autoTend: true,
			autoTendLimit: 5,
			tendChurnGlobs: [],
		});
		store.close();
	});

	test("settings arrays belong to the caller, never to the shared defaults", () => {
		const store = open(join(root, "settings-own-arrays"));
		const first = store.getSettings();
		first.tendChurnGlobs.push("**/*.import");
		first.copyExtra.push(".env");
		expect(store.getSettings()).toMatchObject({
			tendChurnGlobs: [],
			copyExtra: [],
		});
		store.close();
	});
});

describe("release columns", () => {
	test("open backfills release_version and release_notes on a pre-existing database and they round-trip", () => {
		const dir = join(root, "legacy-release");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the release columns existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]')",
		);
		db.close();
		const store = open(dir);
		const task = store.createTask("release me");
		expect(task.releaseVersion).toBeNull();
		expect(task.releaseNotes).toBeNull();
		store.updateTask(task.id, {
			base: "abc1234",
			releaseVersion: "v0.4.0",
			releaseNotes: "## New features\n- Add the thing.",
		});
		const round = store.getTask(task.id);
		expect(round?.base).toBe("abc1234");
		expect(round?.releaseVersion).toBe("v0.4.0");
		expect(round?.releaseNotes).toBe("## New features\n- Add the thing.");
		store.close();
	});
});

describe("done_at", () => {
	test("entering done stamps done_at; other patches never stamp", () => {
		const store = open(join(root, "done-clock"));
		const task = store.createTask("land me");
		expect(task.doneAt).toBeNull();
		store.updateTask(task.id, { title: "rename only" });
		expect(store.getTask(task.id)?.doneAt).toBeNull();
		store.updateTask(task.id, { stage: "done", state: "idle" });
		expect(store.getTask(task.id)?.doneAt).toBeGreaterThan(0);
		store.close();
	});

	test("re-entering done overwrites the stamp, like a release card that bounced and re-landed", () => {
		const store = open(join(root, "done-reland"));
		const task = store.createTask("bounce");
		store.updateTask(task.id, { stage: "done", state: "idle" });
		const first = store.getTask(task.id)?.doneAt ?? 0;
		while (Date.now() <= first) {} // a later landing must carry a later stamp
		store.updateTask(task.id, { stage: "in_progress", state: "needs_you" });
		store.updateTask(task.id, { stage: "done", state: "idle" });
		expect(store.getTask(task.id)?.doneAt).toBeGreaterThan(first);
		store.close();
	});

	test("open backfills done_at from the last turn's end on a pre-existing database", () => {
		const dir = join(root, "legacy-done");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before done_at existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]')",
		);
		db.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT)",
		);
		const landedAt = 1790683200000;
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('done1', 't', 'p', 'done', 'idle', ?, ?)",
			[landedAt - 3600000, landedAt],
		);
		db.run(
			"INSERT INTO turns (task_id, kind, prompt, started_at, ended_at) VALUES ('done1', 'work', 'p', ?, ?)",
			[landedAt - 3500000, landedAt - 60000],
		);
		db.run(
			"INSERT INTO turns (task_id, kind, prompt, started_at, ended_at) VALUES ('done1', 'merge', 'p', ?, ?)",
			[landedAt - 30000, landedAt],
		);
		db.close();
		const store = open(dir);
		expect(store.getTask("done1")?.doneAt).toBe(landedAt);
		store.close();
	});

	test("open backfills done_at when a prior migration added the column but stopped before the backfill", () => {
		const dir = join(root, "interrupted-done-backfill");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema with done_at already present and legacy done rows unstamped: the state
		// after a process stop between the ALTER and the backfill UPDATE.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', done_at INTEGER)",
		);
		db.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT)",
		);
		const landedAt = 1790683200000;
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at, done_at) VALUES ('done1', 't', 'p', 'done', 'idle', ?, ?, NULL)",
			[landedAt - 3600000, landedAt],
		);
		db.run(
			"INSERT INTO turns (task_id, kind, prompt, started_at, ended_at) VALUES ('done1', 'work', 'p', ?, ?)",
			[landedAt - 3500000, landedAt - 60000],
		);
		db.run(
			"INSERT INTO turns (task_id, kind, prompt, started_at, ended_at) VALUES ('done1', 'merge', 'p', ?, ?)",
			[landedAt - 30000, landedAt],
		);
		db.close();
		const store = open(dir);
		expect(store.getTask("done1")?.doneAt).toBe(landedAt);
		store.close();
	});
});

describe("task model", () => {
	test("createTask stores the model and getTask/listTasks return it", () => {
		const store = open(join(root, "task-model"));
		const task = store.createTask("do things", "openai/gpt-5.2");
		expect(task.model).toBe("openai/gpt-5.2");
		expect(store.getTask(task.id)?.model).toBe("openai/gpt-5.2");
		expect(store.listTasks().find((t) => t.id === task.id)?.model).toBe(
			"openai/gpt-5.2",
		);
		expect(store.createTask("x").model).toBeNull();
		store.close();
	});

	test("open backfills tasks.model on a pre-existing database without it", () => {
		const dir = join(root, "legacy-task-model");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the model column existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT)",
		);
		db.close();
		const store = open(dir);
		const task = store.createTask("modeled", "openai/gpt-5");
		expect(store.getTask(task.id)?.model).toBe("openai/gpt-5");
		store.close();
	});
});

describe("diff capture columns", () => {
	test("stores stat and text, survives a reopen, defaults null", () => {
		const store = open(join(root, "diff-capture"));
		const task = store.createTask("captured");
		expect(task.diffFiles).toBeNull();
		expect(task.diffText).toBeNull();
		store.updateTask(task.id, {
			diffFiles: [
				{ file: "src/app.ts", plus: 12, minus: 3 },
				{ file: "logo.png", plus: null, minus: null },
			],
			diffText: "diff --git a/src/app.ts b/src/app.ts\n…",
		});
		const stored = store.getTask(task.id);
		expect(stored?.diffFiles).toEqual([
			{ file: "src/app.ts", plus: 12, minus: 3 },
			{ file: "logo.png", plus: null, minus: null },
		]);
		expect(stored?.diffText).toContain("diff --git");
		store.close();
		const reopened = open(join(root, "diff-capture"));
		expect(reopened.getTask(task.id)?.diffFiles?.length).toBe(2);
		reopened.close();
	});

	test("a corrupt stored stat list reads as null, not a partial list", () => {
		const store = open(join(root, "diff-corrupt"));
		const task = store.createTask("corrupt");
		store.updateTask(task.id, { diffFiles: [{ file: 5 }] as never });
		expect(store.getTask(task.id)?.diffFiles).toBeNull();
		store.close();
	});

	test("a legacy database without the columns converges on open", () => {
		const dir = join(root, "diff-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the diff columns existed (pre-feature done card).
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', shots TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT, model TEXT, kept_files TEXT NOT NULL DEFAULT '[]', follow_up_of TEXT, commits INTEGER, done_at INTEGER, push_sha TEXT, report TEXT, research INTEGER NOT NULL DEFAULT 0, update_ids TEXT NOT NULL DEFAULT '[]', update_merge_approved INTEGER NOT NULL DEFAULT 0, topic TEXT, depends_on TEXT NOT NULL DEFAULT '[]')",
		);
		db.exec(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('abc12345', 'old', 'p', 'done', 'idle', 1, 1)",
		);
		db.close();
		const store = open(dir);
		const task = store.getTask("abc12345");
		expect(task?.diffFiles).toBeNull();
		expect(task?.diffText).toBeNull();
		store.close();
	});
});

describe("keptFiles", () => {
	test("updateTask stores and clears the list; fresh stores default to empty", () => {
		const store = open(join(root, "kept"));
		const task = store.createTask("keep me");
		expect(task.keptFiles).toEqual([]);
		const withFiles = store.updateTask(task.id, {
			keptFiles: ["out/report.md", "data.log"],
		});
		expect(withFiles.keptFiles).toEqual(["out/report.md", "data.log"]);
		expect(store.getTask(task.id)?.keptFiles).toEqual([
			"out/report.md",
			"data.log",
		]);
		expect(store.updateTask(task.id, { keptFiles: [] }).keptFiles).toEqual([]);
		store.close();
	});

	test("updateTask stores followUpOf and it survives a reopen", () => {
		const store = open(join(root, "follow-up-link"));
		const parent = store.createTask("parent");
		expect(parent.followUpOf).toBe(null);
		const child = store.createTask("follow up");
		const updated = store.updateTask(child.id, { followUpOf: parent.id });
		expect(updated.followUpOf).toBe(parent.id);
		expect(store.getTask(child.id)?.followUpOf).toBe(parent.id);
		store.close();
		const reopened = open(join(root, "follow-up-link"));
		expect(reopened.getTask(child.id)?.followUpOf).toBe(parent.id);
		reopened.close();
	});

	test("updateTask stores dependsOn and it survives a reopen", () => {
		const store = open(join(root, "depends-on-link"));
		const parent = store.createTask("parent");
		expect(parent.dependsOn).toEqual([]);
		const child = store.createTask("depends on parent");
		const updated = store.updateTask(child.id, {
			dependsOn: [parent.id],
		});
		expect(updated.dependsOn).toEqual([parent.id]);
		expect(store.getTask(child.id)?.dependsOn).toEqual([parent.id]);
		store.close();
		const reopened = open(join(root, "depends-on-link"));
		expect(reopened.getTask(child.id)?.dependsOn).toEqual([parent.id]);
		reopened.close();
	});

	test("updateTask stores pushSha and it survives a reopen", () => {
		const store = open(join(root, "push-sha-link"));
		const task = store.createTask("merge me");
		expect(task.pushSha).toBe(null);
		const updated = store.updateTask(task.id, { pushSha: "abc12345" });
		expect(updated.pushSha).toBe("abc12345");
		store.close();
		const reopened = open(join(root, "push-sha-link"));
		expect(reopened.getTask(task.id)?.pushSha).toBe("abc12345");
		expect(reopened.updateTask(task.id, { pushSha: null }).pushSha).toBe(null);
		reopened.close();
	});

	test("updateTask stores research and report and they survive a reopen", () => {
		const store = open(join(root, "research-link"));
		const task = store.createTask("research this");
		expect(task.research).toBe(false);
		expect(task.report).toBe(null);
		const updated = store.updateTask(task.id, {
			research: true,
			report: "# Findings",
		});
		expect(updated.research).toBe(true);
		expect(updated.report).toBe("# Findings");
		store.close();
		const reopened = open(join(root, "research-link"));
		expect(reopened.getTask(task.id)?.research).toBe(true);
		expect(reopened.getTask(task.id)?.report).toBe("# Findings");
		reopened.close();
	});

	test("clearing research survives a reopen and keeps the report", () => {
		const store = open(join(root, "research-unmark"));
		const task = store.createTask("coerced card");
		store.updateTask(task.id, { research: true, report: "# Findings" });
		const cleared = store.updateTask(task.id, { research: false });
		expect(cleared.research).toBe(false);
		store.close();
		const reopened = open(join(root, "research-unmark"));
		expect(reopened.getTask(task.id)?.research).toBe(false);
		expect(reopened.getTask(task.id)?.report).toBe("# Findings");
		reopened.close();
	});

	test("opening a pre-research database backfills the columns", () => {
		const dir = join(root, "research-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		// Schema as it was before report and research existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT, model TEXT, kept_files TEXT NOT NULL DEFAULT '[]', follow_up_of TEXT)",
		);
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('res1', 't', 'p', 'done', 'idle', 1, 1)",
		);
		db.close();
		const store = open(dir);
		const task = store.getTask("res1");
		expect(task?.research).toBe(false);
		expect(task?.report).toBe(null);
		store.close();
	});

	test("opening a pre-kept_files database backfills the column", () => {
		const dir = join(root, "kept-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		// Schema as it was before kept_files existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT)",
		);
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('kept1', 't', 'p', 'in_progress', 'needs_you', 1, 1)",
		);
		db.close();
		const store = open(dir);
		expect(store.getTask("kept1")?.keptFiles).toEqual([]);
		store.close();
	});
});

describe("events", () => {
	test("createTask records a create event and the initial queued state", () => {
		const store = open(join(root, "stats-create"));
		const task = store.createTask("count me");
		const events = store.events();
		expect(events.map((e) => [e.kind, e.taskId, e.to])).toEqual([
			["create", task.id, "todo"],
			["state", task.id, "queued"],
		]);
		store.close();
	});

	test("stage and state transitions record from/to; unchanged or same-value patches record nothing", () => {
		const store = open(join(root, "stats-transitions"));
		const task = store.createTask("move me");
		store.updateTask(task.id, { state: "running", stage: "in_progress" });
		store.updateTask(task.id, { state: "needs_you", needsReason: "ask" });
		store.updateTask(task.id, { state: "queued", pendingPrompt: "." });
		expect(
			store
				.events()
				.filter((e) => e.kind === "stage" || e.kind === "state")
				.map((e) => [e.kind, e.from, e.to]),
		).toEqual([
			["state", null, "queued"],
			["stage", "todo", "in_progress"],
			["state", "queued", "running"],
			["state", "running", "needs_you"],
			["state", "needs_you", "queued"],
		]);
		// Non-transition patch (reorder writes queuedAt) and same-value state: no new events.
		const before = store.events();
		store.updateTask(task.id, { queuedAt: Date.now() });
		store.updateTask(task.id, { state: "queued" });
		expect(store.events()).toEqual(before);
		store.close();
	});

	test("finishTurn records an error event except for deliberate cancels", () => {
		const store = open(join(root, "stats-errors"));
		const task = store.createTask("fail me");
		store.finishTurn(store.startTurn(task.id, "work", "fail me", null).id, {
			endedAt: Date.now(),
			error: "boom",
		});
		store.finishTurn(store.startTurn(task.id, "work", "fail me", null).id, {
			endedAt: Date.now(),
			error: "cancelled",
		});
		const errors = store.events().filter((e) => e.kind === "error");
		expect(errors.map((e) => [e.taskId, e.detail])).toEqual([
			[task.id, "boom"],
		]);
		store.close();
	});
});

describe("turn cost capture", () => {
	const sid = "cccc0000-0000-0000-0000-000000000201";

	/** One assistant usage record at `at` (the omp transcript message shape). */
	function usageLine(
		at: number,
		usage: { input: number; output: number; cost: number },
	): string {
		return JSON.stringify({
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				model: "m",
				usage: {
					input: usage.input,
					output: usage.output,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: usage.cost },
				},
			},
		});
	}

	function writeTranscript(
		sessionsDir: string,
		sessionId: string,
		lines: string[],
	): void {
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(
			join(sessionsDir, `2026-09-27T10-00-00-000Z_${sessionId}.jsonl`),
			`${lines.join("\n")}\n`,
		);
	}

	test("finishTurn fills cost from the transcript window", () => {
		const dir = join(root, "cost-finish");
		const store = open(dir);
		const t = store.updateTask(store.createTask("costly").id, {
			sessionId: sid,
		});
		const a = store.startTurn(t.id, "work", "a", null);
		// One record inside [started_at, ended_at], one after the turn ended.
		writeTranscript(store.sessionsDir, sid, [
			usageLine(a.startedAt + 1000, { input: 10, output: 1, cost: 0.25 }),
			usageLine(a.startedAt + 5000, { input: 99, output: 9, cost: 9 }),
		]);
		store.finishTurn(a.id, { endedAt: a.startedAt + 2000 });
		store.close();

		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const rows = raw
			.query<
				{
					tokens_in: number;
					tokens_out: number;
					cache_read: number;
					cache_write: number;
					cost: number;
				},
				[]
			>(
				"SELECT tokens_in, tokens_out, cache_read, cache_write, cost FROM turns",
			)
			.all();
		raw.close();
		expect(rows).toEqual([
			{
				tokens_in: 10,
				tokens_out: 1,
				cache_read: 0,
				cache_write: 0,
				cost: 0.25,
			},
		]);
	});

	test("two turns of one session split the transcript by their timestamp windows", () => {
		const dir = join(root, "cost-split");
		const store = open(dir);
		const sessionsDir = store.sessionsDir;
		const t = store.updateTask(store.createTask("costly").id, {
			sessionId: sid,
		});
		const a = store.startTurn(t.id, "work", "a", null);
		const b = store.startTurn(t.id, "work", "b", null);
		store.finishTurn(a.id, { endedAt: a.startedAt + 1000 });
		store.finishTurn(b.id, { endedAt: b.startedAt + 1000 });
		store.close();
		// Pin the two windows apart (raw write: the store is closed) and lay the
		// transcript over them; the backfill owns each message by its record timestamp.
		const T = Date.parse("2026-09-27T10:00:00.000Z");
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.run("UPDATE turns SET started_at = ?, ended_at = ? WHERE id = ?", [
			T,
			T + 600_000,
			a.id,
		]);
		raw.run("UPDATE turns SET started_at = ?, ended_at = ? WHERE id = ?", [
			T + 700_000,
			T + 1_300_000,
			b.id,
		]);
		raw.close();
		writeTranscript(sessionsDir, sid, [
			usageLine(T + 60_000, { input: 10, output: 1, cost: 0.25 }), // A only
			usageLine(T + 760_000, { input: 20, output: 2, cost: 0.5 }), // B only
			usageLine(T + 1_400_000, { input: 99, output: 9, cost: 9 }), // after both
		]);
		// The backfill runs on open and splits the transcript by window.
		const reopened = open(dir);
		expect(
			reopened.perfFacts().turns.sort((x, y) => x.endedAt - y.endedAt),
		).toEqual([
			{ endedAt: T + 600_000, failed: false, cost: 0.25 },
			{ endedAt: T + 1_300_000, failed: false, cost: 0.5 },
		]);
		reopened.close();
		// Backfill persisted the per-window costs.
		const raw2 = new Database(join(dir, ".tasks", "tasks.db"));
		const costs = raw2
			.query<{ cost: number }, []>("SELECT cost FROM turns ORDER BY id")
			.all();
		raw2.close();
		expect(costs).toEqual([{ cost: 0.25 }, { cost: 0.5 }]);
	});

	test("a session without a transcript keeps cost NULL and never fails the turn", () => {
		const dir = join(root, "cost-missing");
		const store = open(dir);
		const t = store.updateTask(store.createTask("no file").id, {
			sessionId: sid,
		});
		const turn = store.startTurn(t.id, "work", "p", null);
		const ended = store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect(ended.endedAt).toBe(turn.startedAt + 1000);
		const orphan = store.startTurn(
			store.createTask("no session").id,
			"work",
			"p",
			null,
		);
		store.finishTurn(orphan.id, { endedAt: orphan.startedAt + 1000 });
		expect(store.perfFacts().turns.every((x) => x.cost === null)).toBe(true);
		store.close();
	});

	test("an owned window without usage writes zeros, not NULL", () => {
		const dir = join(root, "cost-zeros");
		const store = open(dir);
		const t = store.updateTask(store.createTask("quiet").id, {
			sessionId: sid,
		});
		const turn = store.startTurn(t.id, "work", "p", null);
		// The session ran in the window (a user record) but billed nothing there.
		writeTranscript(store.sessionsDir, sid, [
			JSON.stringify({
				type: "message",
				timestamp: new Date(turn.startedAt + 10).toISOString(),
				message: { role: "user", content: "go" },
			}),
		]);
		store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const row = raw
			.query<{ tokens_in: number; cost: number }, []>(
				"SELECT tokens_in, cost FROM turns",
			)
			.get();
		raw.close();
		expect(row).toEqual({ tokens_in: 0, cost: 0 });
	});

	test("a turn of a replaced session keeps cost NULL in the backfill", () => {
		const dir = join(root, "cost-replaced");
		const oldSid = "dddd0000-0000-0000-0000-000000000301";
		const newSid = "dddd0000-0000-0000-0000-000000000302";
		const store = open(dir);
		const t = store.updateTask(store.createTask("restarted").id, {
			sessionId: oldSid,
		});
		const old = store.startTurn(t.id, "work", "p", null);
		store.finishTurn(old.id, { endedAt: old.startedAt + 1000 }); // no file yet: NULL
		// The old session's own transcript bills cost 2 inside the old turn's window...
		writeTranscript(store.sessionsDir, oldSid, [
			usageLine(old.startedAt + 100, { input: 1, output: 1, cost: 2 }),
		]);
		// ...but the task moved to a new session that started after the old turn ended.
		store.updateTask(t.id, { sessionId: newSid });
		const T = old.startedAt + 60_000;
		writeTranscript(store.sessionsDir, newSid, [
			usageLine(T, { input: 5, output: 5, cost: 0.5 }),
		]);
		store.close();
		const reopened = open(dir);
		// Not a confirmed zero: the current transcript cannot speak for that turn.
		expect(reopened.perfFacts().turns[0]?.cost).toBeNull();
		reopened.close();
	});

	test("a malformed transcript keeps cost NULL at turn end, and a repaired one fills on reopen", () => {
		const dir = join(root, "cost-malformed-finish");
		const store = open(dir);
		const t = store.updateTask(store.createTask("garbled").id, {
			sessionId: sid,
		});
		const turn = store.startTurn(t.id, "work", "p", null);
		const good = usageLine(turn.startedAt + 100, {
			input: 3,
			output: 1,
			cost: 0.4,
		});
		writeTranscript(store.sessionsDir, sid, [good, "{broken"]);
		store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect(store.perfFacts().turns[0]?.cost).toBeNull();
		writeTranscript(store.sessionsDir, sid, [good]);
		store.close();
		const reopened = open(dir);
		expect(reopened.perfFacts().turns[0]?.cost).toBe(0.4);
		reopened.close();
	});

	test("a malformed transcript keeps cost NULL in the backfill until repaired", () => {
		const dir = join(root, "cost-malformed-backfill");
		const sid3 = "eeee0000-0000-0000-0000-000000000401";
		const store = open(dir);
		const t = store.updateTask(store.createTask("garbled later").id, {
			sessionId: sid3,
		});
		const turn = store.startTurn(t.id, "work", "p", null);
		store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 }); // no file: NULL
		const good = usageLine(turn.startedAt + 100, {
			input: 3,
			output: 1,
			cost: 0.6,
		});
		writeTranscript(store.sessionsDir, sid3, [good, "not json"]);
		store.close();
		const first = open(dir);
		expect(first.perfFacts().turns[0]?.cost).toBeNull();
		writeTranscript(first.sessionsDir, sid3, [good]);
		first.close();
		const second = open(dir);
		expect(second.perfFacts().turns[0]?.cost).toBe(0.6);
		second.close();
	});

	// The subagent folder sits beside the session file (`<ts>_<sid>/`). Breakages are built
	// without chmod, so they hold under root too: a directory where a .jsonl file belongs
	// (EISDIR on read) and a plain file where the folder belongs (ENOTDIR on list).
	const subBreaks: [string, (subDir: string) => void][] = [
		[
			"an unreadable subagent file",
			(subDir) =>
				mkdirSync(join(subDir, "0-broken.jsonl"), { recursive: true }),
		],
		[
			"a subagent folder path that is not a folder",
			(subDir) => writeFileSync(subDir, "not a folder"),
		],
	];
	for (const [label, breakIt] of subBreaks) {
		test(`${label} keeps cost NULL at turn end and in the backfill until repaired`, () => {
			const dir = join(root, `cost-sub-${label.length}`);
			const sid4 = `ffff0000-0000-0000-0000-00000000050${label.length % 10}`;
			const store = open(dir);
			const t = store.updateTask(store.createTask("subagents").id, {
				sessionId: sid4,
			});
			const turn = store.startTurn(t.id, "work", "p", null);
			const at = turn.startedAt + 100;
			writeTranscript(store.sessionsDir, sid4, [
				usageLine(at, { input: 1, output: 1, cost: 1 }),
			]);
			const subDir = join(
				store.sessionsDir,
				`2026-09-27T10-00-00-000Z_${sid4}`,
			);
			breakIt(subDir);
			store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
			expect(store.perfFacts().turns[0]?.cost).toBeNull(); // turn end
			store.close();
			const first = open(dir);
			expect(first.perfFacts().turns[0]?.cost).toBeNull(); // backfill
			first.close();
			// Repair: a readable folder with one subagent file that bills 2 more.
			rmSync(subDir, { recursive: true, force: true });
			mkdirSync(subDir, { recursive: true });
			writeFileSync(
				join(subDir, "0-sub.jsonl"),
				usageLine(at + 10, { input: 1, output: 1, cost: 2 }),
			);
			const second = open(dir);
			expect(second.perfFacts().turns[0]?.cost).toBe(3);
			second.close();
		});
	}

	test("reopen backfills an old turn's cost once its transcript exists", () => {
		const dir = join(root, "cost-backfill");
		const sid2 = "cccc0000-0000-0000-0000-000000000202";
		const store = open(dir);
		const t = store.updateTask(store.createTask("old work").id, {
			sessionId: sid2,
		});
		const turn = store.startTurn(t.id, "work", "p", null);
		store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect(store.perfFacts().turns[0]?.cost).toBeNull(); // no transcript yet
		writeTranscript(store.sessionsDir, sid2, [
			usageLine(turn.startedAt + 100, { input: 7, output: 3, cost: 0.75 }),
		]);
		store.close();
		// The backfill runs on open, before any caller touches the store.
		const reopened = open(dir);
		expect(reopened.perfFacts().turns).toEqual([
			{ endedAt: turn.startedAt + 1000, failed: false, cost: 0.75 },
		]);
		reopened.close();
		// A second open is idempotent: filled turns are not re-read.
		expect(open(dir).perfFacts().turns).toEqual([
			{ endedAt: turn.startedAt + 1000, failed: false, cost: 0.75 },
		]);
	});

	test("open adds the cost columns to a database created before them", () => {
		const dir = join(root, "cost-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const legacy = new Database(join(dir, ".tasks", "tasks.db"), {
			create: true,
		});
		// The turns schema as it was before cost capture existed.
		legacy.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT)",
		);
		legacy.close();
		const store = open(dir);
		const t = store.createTask("legacy cost");
		const turn = store.startTurn(t.id, "work", "p", null);
		// The capture path runs against the freshly added columns without throwing.
		store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect(store.perfFacts().turns).toHaveLength(1);
		store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const cols = raw
			.query<{ name: string }, []>("PRAGMA table_info(turns)")
			.all()
			.map((c) => c.name);
		raw.close();
		for (const col of [
			"tokens_in",
			"tokens_out",
			"cache_read",
			"cache_write",
			"cost",
		])
			expect(cols).toContain(col);
	});
});

describe("row literals and patch types", () => {
	// Regression for R4-9: createTask/startTurn used to hand-build their return values,
	// which could drift from the stored row and the toTask/toTurn normalizers.
	test("createTask and startTurn return the stored rows, not hand-built literals", () => {
		const dir = join(root, "read-back");
		mkdirSync(dir, { recursive: true });
		// Create the real schema first (ProjectStore.init makes dir and tables), then add
		// the trigger to that live schema so it exists before any row is inserted.
		open(dir).close();
		// A trigger rewrites the stored title behind the store's back; a literal return misses it.
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.exec(
			"CREATE TRIGGER stamp AFTER INSERT ON tasks BEGIN UPDATE tasks SET title = title || '!' WHERE rowid = new.rowid; END",
		);
		raw.close();
		const store = open(dir);
		const task = store.createTask("read me back", "glm");
		expect(task.title).toBe("read me back!");
		expect(store.getTask(task.id)).toEqual(task);
		const turn = store.startTurn(task.id, "work", "read me back", 4242, "in");
		const storedTurn = store.listTurns(task.id)[0];
		expect(storedTurn).toBeDefined();
		expect(storedTurn).toEqual(turn);
		store.close();
	});

	// Regression for R4-8: doneAt used to be accepted by updateTask and silently dropped
	// (TASK_COLUMNS has no mapping). The patch type now rejects it at compile time.
	test("updateTask ignores fields only the store may write", () => {
		const store = open(join(root, "patch-type"));
		const t = store.createTask("typed");
		// @ts-expect-error TaskPatch excludes doneAt: done_at is stamped internally on entering Done
		store.updateTask(t.id, { doneAt: 123 });
		expect(store.getTask(t.id)?.doneAt).toBeNull();
		store.close();
	});
});

describe("preparing migration", () => {
	// A database from before `preparing` existed: full post-backfill column set, old state CHECK.
	const OLD_TASKS_DDL = `CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT,
		prompt TEXT,
		stage TEXT NOT NULL CHECK (stage IN ('todo','in_progress','merging','done')),
		state TEXT NOT NULL CHECK (state IN ('queued','running','needs_you','idle')),
		needs_reason TEXT,
		pending_prompt TEXT,
		branch TEXT,
		base TEXT,
		worktree TEXT,
		session_id TEXT,
		summary TEXT,
		details TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		queued_at INTEGER,
		cancelled_at INTEGER,
		images TEXT NOT NULL DEFAULT '[]',
		pending_images TEXT NOT NULL DEFAULT '[]',
		release_version TEXT,
		release_notes TEXT,
		session_title TEXT,
		asked TEXT,
		model TEXT,
		kept_files TEXT NOT NULL DEFAULT '[]',
		follow_up_of TEXT,
		commits INTEGER,
		done_at INTEGER
	)`;

	test("open rebuilds the old state CHECK without losing rows and accepts preparing", () => {
		const dir = join(root, "preparing-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'seeded', 'in_progress', 'running', 1, 1)",
		);
		db.close();

		const store = open(dir);
		expect(store.getTask("seed1")?.title).toBe("seeded");
		expect(store.getTask("seed1")?.state).toBe("running");
		// The old CHECK rejected exactly this write — the crash from the screenshot.
		store.updateTask("seed1", { state: "preparing" });
		expect(store.getTask("seed1")?.state).toBe("preparing");
		const fresh = store.createTask("after migration");
		expect(store.getTask(fresh.id)?.state).toBe("queued");
		store.close();

		// The constraint change is durable across a reopen.
		const reopened = open(dir);
		expect(reopened.getTask("seed1")?.state).toBe("preparing");
		reopened.close();
	});

	test("open rebuilds the old stage CHECK without losing rows and accepts backlog", () => {
		const dir = join(root, "backlog-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// The current column set with the pre-backlog stage list: what open() must rebuild.
		const ref = open(join(root, "backlog-schema-ref"));
		ref.close();
		const refDb = new Database(
			join(root, "backlog-schema-ref", ".tasks", "tasks.db"),
		);
		const ddl =
			refDb
				.query<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
				)
				.get()?.sql ?? "";
		refDb.close();
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(
			ddl.replace(
				"stage IN ('todo','in_progress','merging','done','backlog')",
				"stage IN ('todo','in_progress','merging','done')",
			),
		);
		db.exec(
			`INSERT INTO tasks (id, title, stage, state, created_at, updated_at, topic, work_check_log, queued_at)
				VALUES ('seed1', 'parked idea', 'todo', 'queued', 1, 1, 'auth', '[]', 5)`,
		);
		db.close();

		const store = open(dir);
		// The named-column copy kept the values the DDL's tail columns hold.
		expect(store.getTask("seed1")?.topic).toBe("auth");
		expect(store.getTask("seed1")?.queuedAt).toBe(5);
		expect(store.getTask("seed1")?.workCheckLog).toEqual([]);
		// The old CHECK rejected exactly this write.
		store.updateTask("seed1", { stage: "backlog", state: "idle" });
		expect(store.getTask("seed1")?.stage).toBe("backlog");
		store.close();

		// The constraint change is durable across a reopen.
		const reopened = open(dir);
		expect(reopened.getTask("seed1")?.stage).toBe("backlog");
		reopened.close();
	});

	test("open adds the topic column and backfills done rows in one pass", () => {
		const dir = join(root, "topic-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL); // no topic column, old state CHECK
		db.exec(
			`INSERT INTO tasks (id, title, session_title, stage, state, created_at, updated_at, done_at) VALUES
				('t1', 'Fix login redirect bug', 'auth: fix the login redirect', 'done', 'idle', 1, 1, 100),
				('t2', 'Add login rate limit', 'auth: add login rate limit', 'done', 'idle', 2, 2, 200),
				('t3', 'Harden token refresh', 'retry: harden token refresh', 'done', 'idle', 3, 3, 300),
				('t4', 'Fix signup crash on the settings page', NULL, 'done', 'idle', 4, 4, 400),
				('t5', 'Polish the readme', NULL, 'todo', 'queued', 5, 5, NULL)`,
		);
		db.close();

		// One open converges: the column lands after the state-CHECK rebuild, so the
		// rebuild's named-column copy cannot drop the freshly backfilled labels.
		const store = open(dir);
		expect(store.getTask("t1")?.topic).toBe("login"); // df 6 beats auth's 4
		expect(store.getTask("t2")?.topic).toBe("login");
		expect(store.getTask("t3")?.topic).toBe("harden"); // highest-df pick: harden 5 beats retry 4
		expect(store.getTask("t4")?.topic).toBeNull(); // no term reaches df 3
		expect(store.getTask("t5")?.topic).toBeNull(); // never done, never backfilled
		store.close();

		// Idempotent: labels survive a reopen unchanged.
		const reopened = open(dir);
		expect(reopened.getTask("t1")?.topic).toBe("login");
		reopened.close();
	});

	test("open adds the kind column and backfills pre-kind marker cards", () => {
		const dir = join(root, "kind-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL); // no kind column
		db.exec(
			`INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at, release_version) VALUES
				('r1', 'retro', '${RETRO_MARKER}the card', 'done', 'idle', 1, 1, NULL),
				('r2', 'interview', '${RULES_INTERVIEW_MARKER}proj', 'done', 'idle', 2, 2, NULL),
				('r3', 'review', '${ARCH_REVIEW_MARKER}x', 'done', 'idle', 3, 3, NULL),
				('r4', 'release', '${ARCH_REVIEW_MARKER}the release', 'done', 'idle', 4, 4, 'v1.0.0'),
				('r5', 'plain', 'fix the bug', 'todo', 'queued', 5, 5, NULL)`,
		);
		db.close();

		const store = open(dir);
		expect(store.getTask("r1")?.kind).toBe("retro");
		expect(store.getTask("r2")?.kind).toBe("interview");
		expect(store.getTask("r3")?.kind).toBe("review");
		// A released card keeps kind 'work': it is a release, not a review.
		expect(store.getTask("r4")?.kind).toBe("work");
		expect(store.getTask("r5")?.kind).toBe("work");
		store.close();

		// Idempotent across a reopen.
		const reopened = open(dir);
		expect(reopened.getTask("r1")?.kind).toBe("retro");
		expect(reopened.getTask("r4")?.kind).toBe("work");
		reopened.close();
	});

	test("createTask with a marker prompt and no kind arg returns kind work", () => {
		const store = open(join(root, "kind-fresh"));
		for (const prompt of [
			`${RETRO_MARKER}x`,
			`${ARCH_REVIEW_MARKER}x`,
			`${RULES_INTERVIEW_MARKER}x`,
			"fix the bug",
		]) {
			expect(store.createTask(prompt).kind).toBe("work");
		}
		store.close();
	});

	test("fresh databases: new tasks carry a null topic and updateTask can set it", () => {
		const store = open(join(root, "topic-fresh"));
		const task = store.createTask("brand new");
		// toBeNull fails on undefined: proves the field is present, not just falsy.
		expect(task.topic).toBeNull();
		expect(store.updateTask(task.id, { topic: "auth" }).topic).toBe("auth");
		expect(store.updateTask(task.id, { topic: null }).topic).toBeNull();
		store.close();
	});

	test("an older database without shots converges on open and persists task shots", () => {
		const dir = join(root, "shots-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL); // no shots column
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'old', 'todo', 'queued', 1, 1)",
		);
		db.close();

		const store = open(dir);
		expect(store.getTask("seed1")?.shots).toEqual([]);
		const task = store.createTask("after migration");
		expect(store.updateTask(task.id, { shots: ["1.png"] }).shots).toEqual([
			"1.png",
		]);
		store.close();

		const reopened = open(dir);
		expect(reopened.getTask(task.id)?.shots).toEqual(["1.png"]);
		reopened.close();
	});

	// Regression for R4-4: one open must converge the oldest shapes to the current schema.
	// Deleting any ALTER in ProjectStore.open makes a write here fail with "no such column".
	test("a legacy database converges: every current column exists, is writable, and survives a reopen", () => {
		const dir = join(root, "legacy-convergence");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL); // oldest tasks shape (no report/research/shots/push_sha/topic/depends_on)
		// Turns as they were before the model and input columns existed.
		db.exec(`CREATE TABLE turns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('work','merge')),
			prompt TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			ended_at INTEGER,
			pid INTEGER,
			exit_code INTEGER,
			outcome TEXT,
			summary TEXT,
			details TEXT,
			question TEXT,
			error TEXT
		)`);
		db.exec(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('leg1', 'legacy', 'legacy prompt', 'todo', 'queued', 1, 1)",
		);
		db.close();

		const store = open(dir);
		store.updateTask("leg1", { pushSha: "abc", dependsOn: ["x"] });
		store.startTurn("leg1", "work", "legacy turn", null, "turn input");
		store.finishTurn(store.listTurns("leg1")[0]!.id, { model: "glm" });
		store.close();

		const reopened = open(dir);
		expect(reopened.getTask("leg1")?.pushSha).toBe("abc");
		expect(reopened.getTask("leg1")?.dependsOn).toEqual(["x"]);
		expect(reopened.listTurns("leg1")[0]?.model).toBe("glm");
		expect(reopened.listTurns("leg1")[0]?.input).toBe("turn input");
		reopened.close();

		// Column convergence: the upgraded schema must match a fresh schema exactly.
		// A new Task/Turn field lands in both automatically; a missing live migration fails here.
		const probe = new Database(join(dir, ".tasks", "tasks.db"));
		const fresh = open(join(root, "migration-fresh"));
		const freshDb = new Database(
			join(root, "migration-fresh", ".tasks", "tasks.db"),
		);
		fresh.close();
		for (const table of ["tasks", "turns"]) {
			const cols = (db: Database) =>
				db
					.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
					.all()
					.map((c) => c.name)
					.sort();
			expect(cols(probe)).toEqual(cols(freshDb));
		}
		probe.close();
		freshDb.close();
	});
});

describe("discoverProjects", () => {
	test("extra paths outside the roots are found; dups collapse; missing dirs skip", () => {
		const rootA = join(root, "disc-root");
		const inRoot = join(rootA, "inside");
		const outside = join(root, "disc-outside");
		for (const dir of [inRoot, outside]) open(dir);
		mkdirSync(join(root, "disc-empty"), { recursive: true });
		const found = discoverProjects(
			[rootA],
			[outside, outside, join(root, "disc-empty"), join(root, "disc-missing")],
		);
		expect(found).toContain(inRoot);
		expect(found).toContain(outside);
		expect(found.filter((p) => p === outside)).toHaveLength(1);
		expect(found).not.toContain(join(root, "disc-empty"));
	});

	// Regression for R4-3: the board keys projects (and their OTTR_DATA_DIR data dirs) by
	// basename, so discovery must never return two paths with the same folder name.
	test("a basename collision keeps one path; the explicit extra path wins", () => {
		const rootA = join(root, "collide-a", "app");
		const rootB = join(root, "collide-b", "app");
		const explicit = join(root, "collide-extra", "app");
		for (const dir of [rootA, rootB, explicit]) open(dir);
		expect(
			discoverProjects(
				[join(root, "collide-a"), join(root, "collide-b")],
				[explicit],
			),
		).toEqual([explicit]);
		// Root scans alone also collapse: the first root's hit wins deterministically.
		expect(
			discoverProjects([join(root, "collide-b"), join(root, "collide-a")]),
		).toEqual([rootB]);
	});

	// Regression: a removed project must drop out before the basename dedupe, or it claims
	// the folder name and hides a wanted same-name project in another root.
	test("a removed path cannot mask a wanted duplicate elsewhere", () => {
		const rootA = join(root, "mask-a", "app");
		const rootB = join(root, "mask-b", "app");
		for (const dir of [rootA, rootB]) open(dir);
		expect(
			discoverProjects(
				[join(root, "mask-a"), join(root, "mask-b")],
				[],
				[rootA],
			),
		).toEqual([rootB]);
	});
});

describe("OTTR_DATA_DIR", () => {
	test("task data lives in the data dir, where discovery and a reopen find it", () => {
		const data = join(root, "data-dir");
		const parent = join(root, "data-root");
		const proj = join(parent, "proj");
		mkdirSync(proj, { recursive: true });
		const saved = process.env.OTTR_DATA_DIR;
		process.env.OTTR_DATA_DIR = data;
		try {
			const store = ProjectStore.init(proj);
			opened.push(store);
			const t = store.createTask("kept outside the checkout");
			expect(existsSync(join(data, "proj", "tasks.db"))).toBe(true);
			expect(store.logPath(t.id)).toBe(
				join(data, "proj", "logs", `${t.id}.log`),
			);
			expect(store.sessionsDir).toBe(join(data, "proj", "sessions"));
			expect(existsSync(join(proj, ".tasks"))).toBe(false);
			expect(existsSync(join(proj, ".worktrees"))).toBe(true); // worktrees stay in the clone
			expect(discoverProjects([parent])).toEqual([proj]);
			store.close();
			expect(open(proj).getTask(t.id)?.prompt).toBe(
				"kept outside the checkout",
			);
		} finally {
			if (saved === undefined) delete process.env.OTTR_DATA_DIR;
			else process.env.OTTR_DATA_DIR = saved;
		}
		// Without the setting the checkout holds no store, so discovery skips it.
		expect(discoverProjects([parent])).toEqual([]);
	});
});

describe("release notes persistence", () => {
	test("edited release notes survive a store reopen", () => {
		const dir = join(root, "release-notes-reopen");
		const store = open(dir);
		const t = store.createTask("release me");
		store.updateTask(t.id, {
			releaseNotes: "persist me",
			releaseVersion: "v1.0.0",
		});
		store.close();
		const reopened = open(dir);
		expect(reopened.getTask(t.id)!.releaseNotes).toBe("persist me");
		reopened.close();
	});
});

describe("instance lock", () => {
	/** Spawns a real holder process keeping `dir`'s db locked until killed, and awaits readiness. */
	async function spawnHolder(dir: string): Promise<Bun.Subprocess> {
		mkdirSync(dir, { recursive: true }); // the watcher below needs it to exist
		const readyFile = join(dir, ".holder-ready");
		const child = Bun.spawn({
			cmd: [
				"bun",
				"-e",
				`import { ProjectStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
				 ProjectStore.open(process.env.LOCK_DIR);
				 await Bun.write(process.env.READY_FILE, "1");
				 await new Promise(() => {});`,
			],
			env: { ...process.env, LOCK_DIR: dir, READY_FILE: readyFile },
		});
		// The holder is a real OS process, so its readiness exists only on the
		// platform clock (fake timers cannot drive it). Await the ready-file
		// creation event; the 5 s cap is a failure bound, not a duration guess.
		// Stdio stays inherited so a boot failure prints itself.
		if (!existsSync(readyFile)) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const w = watch(dir, (_event, file) => {
				if (file === ".holder-ready") resolve();
			});
			if (existsSync(readyFile)) resolve(); // landed before the watcher attached
			const cap = setTimeout(
				() =>
					reject(
						new Error(`lock holder failed to start (exit ${child.exitCode})`),
					),
				5000,
			);
			try {
				await promise;
			} finally {
				clearTimeout(cap);
				w.close();
			}
		}
		return child;
	}

	test("a second live opener is refused with StoreLockedError", async () => {
		const dir = join(root, "lock-refused");
		const child = await spawnHolder(dir);
		try {
			let err: unknown;
			try {
				ProjectStore.open(dir);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(StoreLockedError);
			if (err instanceof StoreLockedError) {
				expect(err.message).toContain(dir);
			}
		} finally {
			child.kill();
			await child.exited;
		}
	});

	test("a SIGKILLed holder's lock is free for the next boot", async () => {
		const dir = join(root, "lock-sigkill");
		const child = await spawnHolder(dir);
		child.kill(9); // no clean close: no release code runs, the OS drops the lock
		await child.exited;
		const second = open(dir); // whatever pid or hostname the dead holder named
		expect(second.listTasks()).toEqual([]);
		second.close();
	});
});

describe("arch-review changed-line coverage", () => {
	/** Makes `dir` discoverable: a folder with a tasks.db inside its data dir. */
	const fakeProject = (dir: string): string => {
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		writeFileSync(join(dir, ".tasks", "tasks.db"), "");
		return dir;
	};

	describe("discoverProjects", () => {
		test("duplicate basenames keep the first root hit; a missing tasks.db is skipped; results are sorted", () => {
			const rootA = join(root, "ar-disc-a");
			const rootB = join(root, "ar-disc-b");
			mkdirSync(rootA, { recursive: true });
			mkdirSync(rootB, { recursive: true });
			fakeProject(join(rootA, "zeta"));
			fakeProject(join(rootB, "zeta")); // duplicate basename: rootA wins
			mkdirSync(join(rootA, "no-db"), { recursive: true }); // no tasks.db: skipped
			mkdirSync(join(rootA, "empty", ".tasks"), { recursive: true }); // empty data dir: skipped
			fakeProject(join(rootA, "alpha"));
			expect(discoverProjects([rootA, rootB])).toEqual([
				join(rootA, "alpha"),
				join(rootA, "zeta"),
			]);
		});

		test("an explicit extra path shadows a root hit with the same basename", () => {
			const rootA = join(root, "ar-shadow-root");
			const explicit = join(root, "ar-shadow-explicit", "app");
			mkdirSync(rootA, { recursive: true });
			fakeProject(join(rootA, "app"));
			fakeProject(explicit);
			expect(discoverProjects([rootA], [explicit])).toEqual([explicit]);
		});

		test("a removed path drops out before dedupe, even an explicit extra", () => {
			const rootA = join(root, "ar-removed-root");
			const rootB = join(root, "ar-removed-root2");
			mkdirSync(rootA, { recursive: true });
			mkdirSync(rootB, { recursive: true });
			const kept = fakeProject(join(rootA, "keep"));
			const goneA = fakeProject(join(rootA, "gone"));
			const goneB = fakeProject(join(rootB, "gone")); // same basename in a second root
			// Without the removal the first root would claim the name; removing it lets the root scan proceed.
			expect(discoverProjects([rootA], [], [goneA])).toEqual([kept]);
			// The removed root hit cannot mask the second root's same-named project.
			expect(discoverProjects([rootA, rootB], [], [goneA])).toEqual([
				kept,
				goneB,
			]);
			// An explicit extra that is removed is excluded too.
			expect(discoverProjects([rootA], [goneA], [goneA])).toEqual([kept]);
			// Removal matches by path, not basename: other spellings of the name stay.
			expect(discoverProjects([rootA], [kept], [goneA])).toEqual([kept]);
		});

		test("a missing or unreadable root is skipped", () => {
			const rootA = join(root, "ar-skip-root");
			const p = fakeProject(join(rootA, "only"));
			expect(
				discoverProjects([join(root, "ar-does-not-exist"), rootA]),
			).toEqual([p]);
		});
	});

	describe("settings shape validation", () => {
		/** Opens the raw db behind a project dir for direct settings-row writes. */
		const rawDb = (dir: string): Database => {
			const db = new Database(join(dir, ".tasks", "tasks.db"));
			db.exec("PRAGMA busy_timeout = 5000");
			return db;
		};

		test("stored values of the wrong shape keep the default", () => {
			const dir = join(root, "ar-shape");
			const store = open(dir);
			store.close();
			const db = rawDb(dir);
			// number key holding a JSON string; string[] key holding an object
			db.run(
				"INSERT INTO settings (key, value) VALUES ('maxParallel', '\"5\"'), ('copyExtra', '{\"a\":1}'), ('autoTend', 'yes'), ('noSuchKey', '1')",
			);
			db.close();
			const store2 = open(dir);
			const s = store2.getSettings();
			expect(s.maxParallel).toBe(DEFAULT_SETTINGS.maxParallel);
			expect(s.copyExtra).toEqual([]);
			expect(s.autoTend).toBe(DEFAULT_SETTINGS.autoTend);
			// An unknown settings key must not leak its stored value into the result.
			expect("noSuchKey" in s).toBe(false);
			store2.close();
		});

		test("a null maxParallel round-trips as no cap", () => {
			const dir = join(root, "ar-null-parallel");
			const store = open(dir);
			store.setSettings({ maxParallel: null });
			expect(store.getSettings().maxParallel).toBeNull();
			store.close();
			const store2 = open(dir);
			expect(store2.getSettings().maxParallel).toBeNull();
			store2.close();
		});

		test("string[] values map entries through String()", () => {
			const dir = join(root, "ar-stringmap");
			const store = open(dir);
			store.close();
			const db = rawDb(dir);
			db.run(
				"INSERT INTO settings (key, value) VALUES ('copyExtra', '[\"a\", 2, null, true]')",
			);
			db.close();
			const store2 = open(dir);
			expect(store2.getSettings().copyExtra).toEqual([
				"a",
				"2",
				"null",
				"true",
			]);
			store2.close();
		});

		test("corrupt JSON on a number key keeps that key's default only", () => {
			const dir = join(root, "ar-corrupt-num");
			let store = open(dir);
			store.setSettings({ maxParallel: 4, keptWorktreeDays: 2 });
			store.close();
			const db = rawDb(dir);
			db.run("UPDATE settings SET value = '{oops' WHERE key = 'maxParallel'");
			db.close();
			store = open(dir);
			const s = store.getSettings();
			expect(s.maxParallel).toBe(DEFAULT_SETTINGS.maxParallel);
			expect(s.keptWorktreeDays).toBe(2);
			store.close();
		});

		test("returned settings are a deep copy: mutating them touches neither the defaults nor a later read", () => {
			const store = open(join(root, "ar-deepcopy"));
			const first = store.getSettings();
			first.copyExtra.push(".env");
			first.tendChurnGlobs.push("**/*");
			expect(DEFAULT_SETTINGS.copyExtra).toEqual([]);
			expect(DEFAULT_SETTINGS.tendChurnGlobs).toEqual([]);
			const second = store.getSettings();
			expect(second.copyExtra).toEqual([]);
			expect(second.tendChurnGlobs).toEqual([]);
			store.close();
		});

		test("a reset stores JSON null and unknown patch keys are ignored; the return equals getSettings()", () => {
			const dir = join(root, "ar-reset-null");
			const store = open(dir);
			store.setSettings({ displayName: "X", maxParallel: 3 });
			const returned = store.setSettings({
				displayName: null,
				noSuchKey: 99,
			} as unknown as { displayName: string | null });
			expect(returned).toEqual(store.getSettings());
			store.close();
			// Raw reads need the store closed: the board opens its DBs in exclusive locking mode.
			const db = rawDb(dir);
			expect(
				db
					.query<{ value: string }, []>(
						"SELECT value FROM settings WHERE key = 'displayName'",
					)
					.get()?.value,
			).toBe("null");
			// The unknown key never got a row.
			expect(
				db
					.query<{ n: number }, []>(
						"SELECT COUNT(*) AS n FROM settings WHERE key = 'noSuchKey'",
					)
					.get()?.n,
			).toBe(0);
			db.close();
			const reopened = open(dir);
			expect(reopened.getSettings().displayName).toBeNull();
			expect(reopened.getSettings().maxParallel).toBe(3);
			reopened.close();
		});
	});

	describe("task patch mapping", () => {
		test("createTask returns exactly the stored row", () => {
			const store = open(join(root, "ar-create-readback"));
			const task = store.createTask("first line\nsecond line", "m/x");
			expect(task).toEqual(store.getTask(task.id)!);
			expect(task.title).toBe("first line");
			store.close();
		});

		test("updateTask maps patch keys to columns, serializes arrays as JSON, and bumps updated_at", () => {
			const dir = join(root, "ar-patch-cols");
			const store = open(dir);
			const task = store.createTask("patch me");
			const before = store.getTask(task.id)!;
			while (Date.now() <= before.updatedAt) {}
			store.updateTask(task.id, {
				needsReason: "why",
				pendingPrompt: "later",
				sessionId: "sess-1",
				dependsOn: ["t9"],
				images: ["a.png", "b.png"],
				keptFiles: ["k.txt"],
				asked: [],
				releaseVersion: "v9",
			});
			const after = store.getTask(task.id)!;
			expect(after.needsReason).toBe("why");
			expect(after.pendingPrompt).toBe("later");
			expect(after.sessionId).toBe("sess-1");
			expect(after.dependsOn).toEqual(["t9"]);
			expect(after.images).toEqual(["a.png", "b.png"]);
			expect(after.keptFiles).toEqual(["k.txt"]);
			expect(after.asked).toBeNull(); // empty list normalizes to null
			expect(after.releaseVersion).toBe("v9");
			expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
			store.close();
			// Raw reads need the store closed: the board opens its DBs in exclusive locking mode.
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			const row = raw
				.query<{ images: string; session_id: string | null }, [string]>(
					"SELECT images, session_id FROM tasks WHERE id = ?",
				)
				.get(task.id);
			raw.close();
			expect(row?.images).toBe('["a.png","b.png"]');
			expect(row?.session_id).toBe("sess-1");
		});

		test("updateTask with undefined-keyed patch fields skips their columns", () => {
			const dir = join(root, "ar-patch-undef");
			const store = open(dir);
			const task = store.createTask("untouched");
			store.updateTask(task.id, {
				title: undefined,
				branch: undefined,
			} as unknown as { title?: string; branch?: string });
			const after = store.getTask(task.id)!;
			expect(after.title).toBe("untouched");
			expect(after.branch).toBeNull();
			store.close();
		});
	});

	describe("turn lifecycle", () => {
		test("finishTurn maps patch keys, skips undefined ones, and records error events except for a cancelled turn", () => {
			const dir = join(root, "ar-finish-turn");
			const store = open(dir);
			const task = store.createTask("turns");
			const turn = store.startTurn(task.id, "work", "prompt text", 111, "in");
			expect(turn).toEqual(store.listTurns(task.id)[0]!);
			expect(turn.input).toBe("in");
			expect(turn.endedAt).toBeNull();

			const ended = store.finishTurn(turn.id, {
				endedAt: 12345,
				exitCode: 3,
				outcome: "ready",
				summary: "s",
				details: "d",
				error: "boom",
				model: "m1",
				pid: null,
				question: null,
			});
			expect(ended).toEqual(store.listTurns(task.id)[0]!);
			expect(ended.endedAt).toBe(12345);
			expect(ended.exitCode).toBe(3);
			expect(ended.outcome).toBe("ready");
			expect(ended.summary).toBe("s");
			expect(ended.details).toBe("d");
			expect(ended.error).toBe("boom");
			expect(ended.model).toBe("m1");
			expect(ended.pid).toBeNull();
			// The failed turn logged exactly one error event with its detail.
			const errors = store.events().filter((e) => e.kind === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0]!.taskId).toBe(task.id);
			expect(errors[0]!.detail).toBe("boom");

			// A deliberate Cancel is not an error event; an empty patch still reads the row back.
			const cancel = store.startTurn(task.id, "work", "p", 222);
			const done = store.finishTurn(cancel.id, { error: "cancelled" });
			expect(done.error).toBe("cancelled");
			expect(store.events().filter((e) => e.kind === "error")).toHaveLength(1);
			const noop = store.finishTurn(cancel.id, {});
			expect(noop.id).toBe(cancel.id);
			expect(store.listTurns(task.id)).toHaveLength(2);
			store.close();
		});

		test("listTurns returns only the task's turns ordered by id", () => {
			const store = open(join(root, "ar-list-turns"));
			const a = store.createTask("a");
			const b = store.createTask("b");
			const t1 = store.startTurn(a.id, "work", "p", null);
			store.startTurn(b.id, "merge", "q", null);
			const t3 = store.startTurn(a.id, "merge", "r", null);
			expect(store.listTurns(a.id).map((t) => t.id)).toEqual([t1.id, t3.id]);
			store.close();
		});
	});

	describe("perfFacts", () => {
		test("derives done time from the latest done event, plus cancelled, work turns, and needs_you", () => {
			const dir = join(root, "perf-facts");
			const store = open(dir);
			const ok = store.createTask("ok");
			store.updateTask(ok.id, { stage: "in_progress" });
			store.startTurn(ok.id, "work", "p", null);
			store.startTurn(ok.id, "merge", "p", null); // a merge turn is not a work turn
			store.updateTask(ok.id, { stage: "done" });
			const messy = store.createTask("messy");
			store.updateTask(messy.id, { state: "needs_you", needsReason: "ask" });
			store.updateTask(messy.id, { state: "queued", pendingPrompt: "." });
			store.startTurn(messy.id, "work", "p", null);
			store.startTurn(messy.id, "work", "p2", null);
			store.updateTask(messy.id, { stage: "done" });
			const gone = store.createTask("gone");
			store.updateTask(gone.id, { cancelledAt: 123 });
			store.updateTask(gone.id, { stage: "done" });
			store.close();
			const reopened = open(dir);
			const facts = reopened.perfFacts().tasks;
			expect(facts).toHaveLength(3);
			// Identify each card by its fact shape, not by order.
			const okFacts = facts.find((f) => f.workTurns === 1 && !f.cancelled)!;
			expect(okFacts.hadNeedsYou).toBe(false);
			expect(okFacts.doneAt).not.toBeNull();
			const messyFacts = facts.find((f) => f.workTurns === 2)!;
			expect(messyFacts.hadNeedsYou).toBe(true);
			expect(messyFacts.cancelled).toBe(false);
			expect(messyFacts.doneAt).not.toBeNull();
			const goneFacts = facts.find((f) => f.cancelled)!;
			expect(goneFacts.doneAt).not.toBeNull(); // perfMetrics filters it by `cancelled`
			reopened.close();
		});

		test("doneAt is the latest stage→done event, not the first", () => {
			const dir = join(root, "perf-done-at");
			const store = open(dir);
			const t = store.createTask("done twice");
			store.updateTask(t.id, { stage: "in_progress" });
			store.updateTask(t.id, { stage: "done" });
			store.updateTask(t.id, { stage: "in_progress" });
			store.updateTask(t.id, { stage: "done" });
			store.close();
			// The two done events can share one millisecond: pin them apart by rowid.
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run(
				"UPDATE events SET at = 1000 WHERE id = (SELECT MIN(id) FROM events WHERE to_value = 'done')",
			);
			raw.run(
				"UPDATE events SET at = 2000 WHERE id = (SELECT MAX(id) FROM events WHERE to_value = 'done')",
			);
			raw.close();
			const facts = open(dir).perfFacts();
			expect(facts.tasks).toHaveLength(1);
			expect(facts.tasks[0]?.doneAt).toBe(2000);
		});

		test("turn failure flags follow error and exit_code with SQL NULL semantics", () => {
			const dir = join(root, "perf-failed");
			const store = open(dir);
			const t = store.createTask("flags");
			const boom = store.startTurn(t.id, "work", "p", null);
			store.finishTurn(boom.id, { endedAt: 100, error: "boom" });
			const cancel = store.startTurn(t.id, "work", "p", null);
			store.finishTurn(cancel.id, { endedAt: 200, error: "cancelled" });
			const crashed = store.startTurn(t.id, "work", "p", null);
			store.finishTurn(crashed.id, { endedAt: 300, exitCode: 3 });
			const clean = store.startTurn(t.id, "work", "p", null);
			store.finishTurn(clean.id, { endedAt: 400, exitCode: 0 });
			store.close();
			// A finished turn with NULL error and NULL exit_code is not failed either.
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run("UPDATE turns SET exit_code = NULL WHERE ended_at = 400");
			raw.close();
			const turns = open(dir)
				.perfFacts()
				.turns.sort((a, b) => a.endedAt - b.endedAt);
			expect(turns).toEqual([
				{ endedAt: 100, failed: true, cost: null },
				{ endedAt: 200, failed: false, cost: null },
				{ endedAt: 300, failed: true, cost: null },
				{ endedAt: 400, failed: false, cost: null },
			]);
		});
	});

	describe("lifecycle helpers", () => {
		test("tasksDirFor without OTTR_DATA_DIR points into the checkout", () => {
			const saved = process.env.OTTR_DATA_DIR;
			delete process.env.OTTR_DATA_DIR;
			try {
				expect(tasksDirFor("/some/proj")).toBe(join("/some/proj", ".tasks"));
			} finally {
				if (saved !== undefined) process.env.OTTR_DATA_DIR = saved;
			}
		});

		test("a double close is a no-op and the store reopens cleanly", () => {
			const dir = join(root, "ar-double-close");
			const store = open(dir);
			store.close();
			store.close();
			expect(open(dir).listTasks()).toEqual([]);
		});
	});

	describe("task ids", () => {
		test("new ids are PREFIX-n keys derived from the store folder name, consecutive", () => {
			const store = open(join(root, "my_repo"));
			const a = store.createTask("a");
			const b = store.createTask("b");
			expect(a.id).toMatch(/^[A-Z0-9]{1,4}-[0-9]+$/);
			expect(a.id).toBe("MYRE-1");
			expect(b.id).toBe("MYRE-2");
		});

		test("getTask still resolves a legacy 8-hex id", () => {
			const dir = join(root, "legacy-id");
			const store = open(dir);
			const task = store.createTask("legacy");
			store.close();
			const legacyId = "abcdef12";
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run("UPDATE tasks SET id = ? WHERE id = ?", [legacyId, task.id]);
			raw.close();
			expect(open(dir).getTask(legacyId)?.prompt).toBe("legacy");
		});
	});
});

describe("fork research store methods", () => {
	test("saveForkBranch/listForkBranches round-trip and upsert", () => {
		const store = open(join(root, "fork-branch"));
		const row = {
			forkId: 1,
			branchHash: "h1",
			branch: "feature",
			head: "abc",
			analyzedHead: null,
			firstPendingAt: 100,
			lastRunAt: null,
			lastError: null,
			retries: 0,
		};
		store.saveForkBranch(row);
		store.saveForkBranch({
			...row,
			head: "def",
			retries: 2,
			lastError: "boom",
		});
		expect(store.listForkBranches(1)).toEqual([
			{ ...row, head: "def", retries: 2, lastError: "boom" },
		]);
		expect(store.listAllForkBranches()).toHaveLength(1);
	});

	test("forkRunsSince counts recorded runs", () => {
		const store = open(join(root, "fork-runs"));
		store.recordForkRun(1, 1000);
		store.recordForkRun(1, 2000);
		expect(store.forkRunsSince(1500)).toBe(1);
		expect(store.forkRunsSince(0)).toBe(2);
	});

	test("createForkResult files card, proposals, and analyzed heads in one transaction", () => {
		const store = open(join(root, "fork-result"));
		store.saveForkBranch({
			forkId: 7,
			branchHash: "h1",
			branch: "feat-a",
			head: "abc",
			analyzedHead: null,
			firstPendingAt: 5,
			lastRunAt: null,
			lastError: "earlier failure",
			retries: 2,
		});
		const reason = "Proposed by the fork research feat-a. x";
		const card = store.createForkResult({
			prompt: "report prompt",
			title: "Fork research: 2026-10-14",
			report: "# findings",
			topic: "fork research",
			proposals: [
				{ prompt: "do a", needsReason: reason, model: null },
				{ prompt: "do b", needsReason: reason, model: "m" },
			],
			analyzed: [{ forkId: 7, branchHash: "h1", head: "abc", at: 42 }],
		});
		const stored = store.getTask(card.id)!;
		expect(stored.research).toBe(true);
		expect(stored.stage).toBe("done");
		expect(stored.state).toBe("idle");
		expect(stored.topic).toBe("fork research");
		expect(stored.report).toBe("# findings");
		expect(stored.title).toBe("Fork research: 2026-10-14");
		const kids = store
			.listTasks()
			.filter((t) => t.followUpOf === card.id)
			.sort((a, b) => a.prompt.localeCompare(b.prompt));
		expect(kids).toHaveLength(2);
		for (const kid of kids) {
			expect(kid.state).toBe("needs_you");
			expect(kid.needsReason).toBe(reason);
		}
		expect(kids[1]!.model).toBe("m");
		const branch = store.listForkBranches(7)[0]!;
		expect(branch.analyzedHead).toBe("abc");
		expect(branch.firstPendingAt).toBeNull();
		expect(branch.lastRunAt).toBe(42);
		expect(branch.lastError).toBeNull();
		expect(branch.retries).toBe(0);
	});
});

describe("triage columns", () => {
	test("updateTask persists priority and closeCandidate and null clears", () => {
		const store = open(join(root, "triage"));
		const task = store.createTask("rate me");
		expect(task.priority).toBeNull();
		expect(task.closeCandidate).toBeNull();
		store.updateTask(task.id, { priority: "P1", closeCandidate: "dup of X" });
		expect(store.getTask(task.id)?.priority).toBe("P1");
		expect(store.getTask(task.id)?.closeCandidate).toBe("dup of X");
		store.updateTask(task.id, { priority: null, closeCandidate: null });
		expect(store.getTask(task.id)?.priority).toBeNull();
		expect(store.getTask(task.id)?.closeCandidate).toBeNull();
		store.close();

		const reopened = open(join(root, "triage"));
		expect(reopened.getTask(task.id)?.priority).toBeNull();
		reopened.close();
	});
});

describe("learnings", () => {
	test("add/list/delete round trip; touchLearnings bumps counts and is a no-op on []", () => {
		const store = open(join(root, "learnings"));
		expect(store.listLearnings()).toEqual([]);
		const a = store.addLearning({ text: "no default exports" });
		const b = store.addLearning({
			text: "tabs in src/",
			glob: "src/**",
			fromTaskId: "T-1",
		});
		expect(a.usageCount).toBe(0);
		expect(a.lastUsedAt).toBeNull();
		expect(a.fromTaskId).toBeNull();
		expect(b.glob).toBe("src/**");
		expect(b.fromTaskId).toBe("T-1");
		// Oldest first.
		expect(store.listLearnings().map((l) => l.id)).toEqual([a.id, b.id]);

		store.touchLearnings([]);
		expect(store.listLearnings().every((l) => l.usageCount === 0)).toBe(true);
		store.touchLearnings([a.id]);
		const touched = store.listLearnings().find((l) => l.id === a.id)!;
		expect(touched.usageCount).toBe(1);
		expect(touched.lastUsedAt).toBeGreaterThan(0);

		store.deleteLearning(a.id);
		expect(store.listLearnings().map((l) => l.id)).toEqual([b.id]);
		store.close();
	});

	test("an old-shape database gains the triage columns and the learnings table on open", () => {
		const dir = join(root, "learnings-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// Current TASKS_DDL: priority/close_candidate are ALTER-only, so it is already the old shape.
		const ref = open(join(root, "learnings-schema-ref"));
		ref.close();
		const refDb = new Database(
			join(root, "learnings-schema-ref", ".tasks", "tasks.db"),
		);
		const ddl =
			refDb
				.query<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
				)
				.get()?.sql ?? "";
		refDb.close();
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(ddl);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'old card', 'todo', 'queued', 1, 1)",
		);
		db.close();

		const store = open(dir);
		// Rows survive; the new fields read as their null defaults.
		const seed = store.getTask("seed1");
		expect(seed?.title).toBe("old card");
		expect(seed?.priority).toBeNull();
		expect(seed?.closeCandidate).toBeNull();
		// The table exists and works.
		store.addLearning({ text: "converged" });
		expect(store.listLearnings().map((l) => l.text)).toEqual(["converged"]);
		store.close();
	});
});
