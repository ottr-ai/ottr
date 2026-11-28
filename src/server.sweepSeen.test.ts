// The real server must exclude both a read completion and an unseen completion
// before the saved baseline. The recent unseen completion is the only candidate.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedDemo } from "../scripts/demo-data.ts";
import { ProjectStore } from "./store.ts";
import { doneReadKey } from "./types.ts";

const REPO = resolve(import.meta.dir, "..");
const MIN = 60_000;
const HOUR = 60 * MIN;

// The spawned board is an external child process: the readiness poll below
// awaits its HTTP port on the real clock at a fixed interval with a deadline —
// no in-process fake timer can drive another process's listen.
describe("server sweep seen wiring (OTTR-1259)", () => {
	const root = mkdtempSync(join(tmpdir(), "ottr-sweep-wiring-"));
	const stateDir = join(root, "state");
	// The planted card ids, captured at plant time (the state route omits the
	// titles the test matches on).
	const plantedIds: Record<string, string> = {};

	afterAll(() => rmSync(root, { recursive: true }));

	test("the route excludes seen and pre-baseline cards through both production callbacks", async () => {
		await seedDemo(root, false, stateDir);
		const now = Date.now();
		const seenKeys: string[] = [];
		{
			// Plant-then-boot: the store opens and closes before the board takes
			// the lock (the same rule card-shot's plants follow).
			const store = await ProjectStore.open(join(root, "lumen"));
			try {
				for (const [title, steps, isSeen] of [
					["Seen rate limit card", "# R\n## Recommended steps\n- a", true],
					["Unseen retry card", "# R\n## Recommended steps\n- b", false],
					["Old unseen card", "# R\n## Recommended steps\n- c", false],
				] as const) {
					const t = await store.createTask(title);
					await store.updateTask(t.id, {
						research: true,
						report: steps,
						steps: "yes",
						stage: "done",
						state: "idle",
					});
					const full = await store.getTask(t.id);
					if (full === null) throw new Error("the planted card vanished");
					plantedIds[title] = full.id;
					if (isSeen && full.doneAt !== null)
						seenKeys.push(doneReadKey({ id: full.id, doneAt: full.doneAt }));
				}
			} finally {
				await store.close();
			}
			// The old card has no read key. Only seenSince can exclude it.
			const pdb = new Database(join(root, "lumen", ".tasks", "tasks.db"));
			pdb
				.query(
					"UPDATE tasks SET created_at = ?, done_at = ?, updated_at = ? WHERE id = ?",
				)
				.run(
					now - 72 * HOUR,
					now - 48 * HOUR,
					now - 48 * HOUR,
					plantedIds["Old unseen card"]!,
				);
			pdb.close();
			// The seen marks and the baseline: a direct write into the global
			// store the board opens below.
			const gdb = new Database(join(stateDir, ".tasks", "tracker.db"));
			gdb
				.query(
					"INSERT INTO kv (key, value) VALUES ('seen_answers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(JSON.stringify(seenKeys));
			gdb
				.query(
					"INSERT INTO kv (key, value) VALUES ('seen_done_since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(JSON.stringify(now - 24 * HOUR));
			gdb.close();
		}

		const port = 50000 + (process.pid % 10000);
		const env = { ...process.env };
		delete env.OTTR_VM_RUNNER_URL;
		delete env.OTTR_VM_RUNNER_TOKEN;
		delete env.OTTR_WORKER_TOKEN;
		const board = Bun.spawn(["bun", "src/server.ts"], {
			cwd: REPO,
			env: {
				...env,
				PORT: String(port),
				NODE_ENV: "production",
				OTTR_DEMO: "1",
				OMP_TRACKER_ROOTS: root,
				OTTR_STATE_DIR: stateDir,
				OTTR_WORKERS_HOME: join(root, "workers-home"),
				OMP_TRACKER_MAX_TOTAL: "none",
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			let ready = false;
			for (let waited = 0; waited < 30_000; waited += 250) {
				if (board.exitCode !== null)
					throw new Error(`the board exited early (code ${board.exitCode})`);
				try {
					const res = await fetch(`http://127.0.0.1:${port}/`, {
						signal: AbortSignal.timeout(1_000),
					});
					await res.body?.cancel();
					if (res.ok) {
						ready = true;
						break;
					}
				} catch {
					// not listening yet
				}
				await Bun.sleep(250);
			}
			if (!ready) throw new Error("the board did not become ready within 30 s");

			// Mutations pass the Origin wall: the origin must match the loopback
			// host and port the board serves on. The POST runs the production
			// filing: server.ts's loop ops -> createTurnLoop -> the sweep's
			// filePendingSweepRun reading the seen seam.
			const res = await fetch(
				`http://127.0.0.1:${port}/api/projects/lumen/inbox/sweep`,
				{
					method: "POST",
					headers: { origin: `http://127.0.0.1:${port}` },
					signal: AbortSignal.timeout(30_000),
				},
			);
			expect(res.status).toBe(200);
			// The route answers the filed card's view, prompt included.
			const view = (await res.json()) as { id: string; prompt: string };
			// Either lost callback admits one excluded card into the real batch.
			expect(view.prompt).toContain(`id="#${plantedIds["Unseen retry card"]}"`);
			expect(view.prompt).not.toContain(
				`id="#${plantedIds["Seen rate limit card"]}"`,
			);
			expect(view.prompt).not.toContain(
				`id="#${plantedIds["Old unseen card"]}"`,
			);
		} finally {
			board.kill();
			await board.exited;
		}
	}, 120_000);
});
