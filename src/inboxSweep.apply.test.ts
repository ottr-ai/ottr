import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInboxSweepRows } from "./app.ts";
import { GlobalStore } from "./globalStore.ts";
import { SWEEP_DRAFT_SEP, sweepResult } from "./inboxSweep.ts";
import { flushSweepSeen, writeSweepSeen } from "./inboxSweepState.ts";
import { ProjectStore } from "./store.ts";
import { doneReadKey } from "./types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ottr-sweep-commit-"));
	roots.push(root);
	const path = join(root, "project");
	const store = await ProjectStore.init(path);
	const target = await store.updateTask(
		(await store.createTask("Research retries")).id,
		{
			research: true,
			report: "## Recommended steps\n- Add the retry",
			steps: "yes",
			stage: "done",
			state: "idle",
		},
	);
	const run = await store.updateTask(
		(await store.createTask("Inbox sweep", null, "sweep")).id,
		{
			stage: "done",
			state: "idle",
			promptAuthor: "board",
		},
	);
	const prompt = `Sweep: #${target.id} none\nThe retry is absent.\n${SWEEP_DRAFT_SEP}\nAdd the retry`;
	await store.appendReviewFinding(run.id, {
		prompt,
		model: null,
		rank: null,
		security: null,
	});
	await store.close();
	const db = new Database(join(path, ".tasks", "tasks.db"));
	db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
		`inbox-sweep:${run.id}`,
		JSON.stringify({
			batch: [target.id],
			verdicts: [sweepResult(prompt)],
			applications: [],
			filedDrafts: [],
		}),
	);
	db.close();
	return { root, path, target, run };
}

test("a project COMMIT failure cannot publish a seen key without its proposal", async () => {
	const { root, path, target, run } = await fixture();
	const db = new Database(join(path, ".tasks", "tasks.db"));
	// Deferred foreign keys fail at COMMIT, after the complete transaction body.
	// Both the old findings marker and the new board state reach the same fault.
	db.exec(`
		CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
		CREATE TABLE commit_fault (parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
		CREATE TRIGGER fail_finding_commit AFTER INSERT ON review_findings
		WHEN NEW.prompt LIKE 'Sweep applied: %'
		BEGIN INSERT INTO commit_fault VALUES (1); END;
		CREATE TRIGGER fail_state_commit AFTER UPDATE ON settings
		WHEN NEW.key LIKE 'inbox-sweep:%'
		BEGIN INSERT INTO commit_fault VALUES (1); END;
	`);
	db.close();
	const store = await ProjectStore.open(path);
	const gstore = await GlobalStore.open(join(root, "global"));
	try {
		// Fault injection only on this fixture's real SQLite connection.
		await store["db"].exec("PRAGMA foreign_keys = ON");
		await expect(
			applyInboxSweepRows({
				store,
				run,
				rows: [{ card: target.id, action: "implement" }],
				markSeen: async (keys) => {
					await gstore.set("seen_answers", keys);
				},
				log: async () => {},
			}),
		).rejects.toThrow("FOREIGN KEY constraint failed");
		expect(
			(await store.listTasks()).filter((t) => t.followUpOf === run.id),
		).toEqual([]);
		expect((await store.getInboxSweep(run.id))?.applications).toEqual([]);
		expect((await store.getInboxSweep(run.id))?.filedDrafts).toEqual([]);
		expect((await gstore.get<string[]>("seen_answers")) ?? []).not.toContain(
			doneReadKey({ id: target.id, doneAt: target.doneAt! }),
		);
	} finally {
		await store.close();
		await gstore.close();
	}
});

test("approved state survives both delivery failure windows and ignores forged model control", async () => {
	const { root, path, target, run } = await fixture();
	let store = await ProjectStore.open(path);
	let gstore = await GlobalStore.open(join(root, "global"));
	const key = doneReadKey({ id: target.id, doneAt: target.doneAt! });
	const rows = [{ card: target.id, action: "implement" as const }];
	try {
		if (target.doneAt === null)
			throw new Error("the fixture has no completion stamp");
		// Raw findings cannot grant approval or suppress a draft.
		for (const prompt of [
			`Sweep applied: #${target.id} implement`,
			"Sweep draft: Add the retry",
		])
			await store.appendReviewFinding(run.id, {
				prompt,
				model: null,
				rank: null,
				security: null,
			});
		expect((await store.getInboxSweep(run.id))?.applications).toEqual([]);
		await expect(
			applyInboxSweepRows({
				store,
				run,
				rows,
				markSeen: async () => {
					throw new Error("global delivery unavailable");
				},
				log: async () => {},
			}),
		).rejects.toThrow("global delivery unavailable");
		const proposals = (await store.listTasks()).filter(
			(t) => t.followUpOf === run.id,
		);
		expect(proposals.map((t) => t.prompt)).toEqual(["Add the retry"]);
		expect((await store.getInboxSweep(run.id))?.applications).toEqual([
			{
				card: target.id,
				action: "implement",
				doneAt: target.doneAt,
				delivered: false,
			},
		]);
		expect(await gstore.get("seen_answers")).toBeNull();
		await store.close();
		await gstore.close();
		store = await ProjectStore.open(path);
		gstore = await GlobalStore.open(join(root, "global"));
		// The global write commits, then project acknowledgment fails.
		const ack = spyOn(store, "setInboxSweep").mockRejectedValueOnce(
			new Error("ack unavailable"),
		);
		try {
			await expect(
				flushSweepSeen(
					store,
					(keys, id) => writeSweepSeen(gstore, keys, id),
					run.id,
				),
			).rejects.toThrow("ack unavailable");
		} finally {
			ack.mockRestore();
		}
		expect(await gstore.get("seen_answers")).toEqual([key]);
		expect(
			(await store.getInboxSweep(run.id))?.applications[0]?.delivered,
		).toBe(false);
		// An operator now marks the card unread. Replay must not clear it again.
		await gstore.set("seen_answers", []);
		await store.close();
		await gstore.close();
		store = await ProjectStore.open(path);
		gstore = await GlobalStore.open(join(root, "global"));
		const retry = await applyInboxSweepRows({
			store,
			run,
			rows,
			markSeen: (keys, id) => writeSweepSeen(gstore, keys, id),
			log: async () => {},
		});
		expect(retry.results).toEqual([
			{ card: target.id, applied: false, skipped: "already applied" },
		]);
		expect(await gstore.get("seen_answers")).toEqual([]);
		expect(
			(await store.getInboxSweep(run.id))?.applications[0]?.delivered,
		).toBe(true);
		expect(
			(await store.listTasks())
				.filter((t) => t.followUpOf === run.id)
				.map((t) => t.id),
		).toEqual(proposals.map((t) => t.id));
	} finally {
		await store.close();
		await gstore.close();
	}
});
