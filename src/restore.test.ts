import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSources, runBackup } from "./backup.ts";
import { GlobalStore } from "./globalStore.ts";
import { runRestore } from "./restore.ts";
import { discoverProjects, ProjectStore } from "./store.ts";

// The restore tool of docs/specs/db-backup.md, with real stores as the sources and the holders.

const root = mkdtempSync(join(tmpdir(), "ottr-restore-"));
const opened: { close(): Promise<void> }[] = [];
/** Teardown closes each store also when an assertion fails before the close in the test. */
const track = <S extends { close(): Promise<void> }>(store: S): S => {
	opened.push(store);
	return store;
};
afterAll(async () => {
	for (const store of opened) await store.close(); // a second close does nothing
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

let made = 0;
const tmp = (label: string): string => {
	const dir = join(root, `${label}-${made++}`);
	mkdirSync(dir);
	return dir;
};

const T0 = new Date("2026-11-10T03:15:00Z");
const S0 = "20261110T031500Z";
const T1 = new Date("2026-11-11T03:15:00Z");
const S1 = "20261111T031500Z";

/** Runs `fn` with `vars` in process.env, where the stores read their dirs, then puts the old values back. */
const withEnv = async <T>(
	vars: Record<string, string>,
	fn: () => T | Promise<T>,
): Promise<T> => {
	const saved = Object.keys(vars).map((key) => ({
		key,
		value: process.env[key],
	}));
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const { key, value } of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

/**
 * Makes the snapshot of `now` in `dir` from a real GlobalStore that holds the key `k`.
 * Each name in `projects` gets a project file that is a copy of the same database.
 */
const snapshot = async (
	dir: string,
	now: Date,
	value: string,
	projects: string[] = [],
): Promise<void> => {
	const gstore = track(await GlobalStore.open(tmp("source-state")));
	await gstore.set("k", value);
	const stores = projects.map((name) => ({
		name,
		backupTo: async (dest: string) => await gstore.backupTo(dest),
	}));
	const sources = backupSources(gstore, stores);
	const result = await runBackup({ dir, keep: 7, now, sources });
	await gstore.close();
	expect(result.failed).toEqual([]);
};

/** The key `k` of the tracker.db in `stateDir`, read through a real GlobalStore. */
const kIn = async (stateDir: string): Promise<string | null> => {
	const gstore = track(await GlobalStore.open(stateDir));
	const value = await gstore.get<string>("k");
	await gstore.close();
	return value;
};

/** The dirs of one test: the backup dir, and a state dir that does not exist yet. */
const dirs = (label: string) => {
	const base = tmp(label);
	const dir = join(base, "backup");
	const state = join(base, "state");
	const trackerDb = join(state, ".tasks", "tracker.db");
	const env = { OTTR_BACKUP_DIR: dir, OTTR_STATE_DIR: state };
	return { base, dir, state, trackerDb, env };
};

describe("runRestore", () => {
	test("a snapshot of the live stores restores into an empty state dir and server data dir", async () => {
		const base = tmp("round-trip");
		const data = join(base, "data");
		const backups = join(base, "backup");
		const parent = join(base, "checkouts");
		const proj = join(parent, "demo");
		mkdirSync(proj, { recursive: true });
		const config = { theme: "dark", roots: ["/workspace"] };

		const oldDirs = {
			OTTR_DATA_DIR: data,
			OTTR_SERVER_DATA_DIR: join(base, "server"),
		};
		const before = await withEnv(oldDirs, async () => {
			const gstore = track(await GlobalStore.open(join(base, "state")));
			const store = track(await ProjectStore.open(proj));
			await gstore.set("config", config);
			await gstore.set("seen-answers", [3, 5, 8]);
			await store.setSettings({
				releaseCommand: "bun run release",
				displayName: "Demo",
			});
			const first = await store.createTask("First card\n\nwith a body");
			await store.createTask("Second card");
			const work = await store.startTurn(first.id, "work", "First card", null);
			await store.finishTurn(work.id, {
				endedAt: 1_800_000_000_000,
				model: "zai/glm-5.3-flash",
			});
			const second = await store.startTurn(first.id, "work", "Go on", null);
			await store.finishTurn(second.id, { endedAt: 1_800_000_060_000 });
			const result = await runBackup({
				dir: backups,
				keep: 7,
				now: T0,
				sources: backupSources(gstore, [store]),
			});
			expect(result).toEqual({
				stamp: S0,
				copied: ["tracker.db", "projects/demo/tasks.db"],
				failed: [],
				pruned: [],
			});
			const values = {
				settings: await store.getSettings(),
				tasks: await store.listTasks(),
				turns: await store.listTurns(first.id),
				firstId: first.id,
			};
			await store.close();
			await gstore.close();
			return values;
		});
		expect(before.settings.releaseCommand).toBe("bun run release");
		expect(before.tasks.length).toBe(2);
		expect(before.turns.length).toBe(2);

		// The lost volume: a new empty state dir and a new empty server data dir.
		const state = join(base, "state-new");
		const server = join(base, "server-new");
		mkdirSync(state);
		mkdirSync(server);
		const newDirs = { OTTR_DATA_DIR: data, OTTR_SERVER_DATA_DIR: server };
		await withEnv(newDirs, () => {
			expect(discoverProjects([parent])).toEqual([]);
		});

		const run = await runRestore(["latest"], {
			...newDirs,
			OTTR_STATE_DIR: state,
			OTTR_BACKUP_DIR: backups,
		});
		expect(run).toEqual({
			code: 0,
			out: [
				`restored tracker.db -> ${join(state, ".tasks", "tracker.db")}`,
				`restored projects/demo/tasks.db -> ${join(server, "demo", "tasks.db")}`,
			],
			err: [],
		});
		expect(existsSync(join(server, ".adopted"))).toBe(true);

		await withEnv(newDirs, async () => {
			expect(discoverProjects([parent])).toEqual([proj]);
			const gstore = track(await GlobalStore.open(state));
			const store = track(await ProjectStore.open(proj));
			expect(await gstore.get("config")).toEqual(config);
			expect(await gstore.get("seen-answers")).toEqual([3, 5, 8]);
			expect(await store.getSettings()).toEqual(before.settings);
			expect(await store.listTasks()).toEqual(before.tasks);
			expect(await store.listTurns(before.firstId)).toEqual(before.turns);
			await store.close();
			await gstore.close();
		});
	});

	test("no argument lists the snapshots with the size of each file and changes nothing", async () => {
		const d = dirs("list");
		expect(await runRestore([], d.env)).toEqual({
			code: 0,
			out: [`no snapshots in ${d.dir}`],
			err: [],
		});
		expect(readdirSync(d.base)).toEqual([]);

		await snapshot(d.dir, T0, "one");
		await snapshot(d.dir, T1, "two", ["demo", "alpha"]);
		const size = (...parts: string[]): number =>
			statSync(join(d.dir, ...parts)).size;
		const tracker = size(S1, "tracker.db");
		const alpha = size(S1, "projects", "alpha", "tasks.db");
		const demo = size(S1, "projects", "demo", "tasks.db");
		expect(tracker).toBeGreaterThan(0);
		expect(await runRestore([], d.env)).toEqual({
			code: 0,
			out: [
				`${S1}  tracker.db (${tracker} bytes), projects/alpha/tasks.db (${alpha} bytes), projects/demo/tasks.db (${demo} bytes)`,
				`${S0}  tracker.db (${size(S0, "tracker.db")} bytes)`,
			],
			err: [],
		});
		expect(readdirSync(d.base)).toEqual(["backup"]);
		expect(readdirSync(d.dir).sort()).toEqual([S0, S1]);
	});

	test("a stamp that is not a snapshot gives code 1 and changes nothing", async () => {
		const d = dirs("missing");
		await snapshot(d.dir, T0, "one");
		expect(await runRestore(["20260101T000000Z"], d.env)).toEqual({
			code: 1,
			out: [],
			err: [`no snapshot 20260101T000000Z in ${d.dir}`],
		});
		const empty = join(d.base, "empty");
		const emptyEnv = { ...d.env, OTTR_BACKUP_DIR: empty };
		expect(await runRestore(["latest"], emptyEnv)).toEqual({
			code: 1,
			out: [],
			err: [`no snapshots in ${empty}`],
		});
		expect(readdirSync(d.base)).toEqual(["backup"]);
	});

	test("more than one argument or an option gives code 1 and a usage line", async () => {
		const d = dirs("usage");
		await snapshot(d.dir, T0, "one");
		for (const args of [["latest", "extra"], ["--help"], ["-f", S0], ["-"]]) {
			const run = await runRestore(args, d.env);
			expect(run.code).toBe(1);
			expect(run.out).toEqual([]);
			expect(run.err.length).toBe(1);
			expect(run.err[0]).toStartWith("usage: ");
		}
		expect(readdirSync(d.base)).toEqual(["backup"]);
	});

	test("with no data dir set, a project database gets a line to copy it by hand", async () => {
		const d = dirs("manual");
		await snapshot(d.dir, T0, "old one");
		await snapshot(d.dir, T1, "new one", ["demo"]);

		// A stamp argument restores that snapshot, not the newest one.
		expect(await runRestore([S0], d.env)).toEqual({
			code: 0,
			out: [`restored tracker.db -> ${d.trackerDb}`],
			err: [],
		});
		expect(await kIn(d.state)).toBe("old one");

		const run = await runRestore(["latest"], d.env);
		const from = join(d.dir, S1, "projects", "demo", "tasks.db");
		const kept = "kept the old file as ";
		expect(run.code).toBe(0);
		expect(run.err).toEqual([]);
		expect(run.out.length).toBe(3);
		expect(run.out[0]).toBe(`restored tracker.db -> ${d.trackerDb}`);
		expect(run.out[1]).toStartWith(`${kept}${d.trackerDb}.before-restore-`);
		expect(run.out[2]).toBe(
			`copy by hand: ${from} -> <checkout>/.tasks/tasks.db`,
		);
		expect(await kIn(d.state)).toBe("new one");

		// The tool renamed the old file: its content still opens at the printed path.
		const old = new Database(run.out[1]!.slice(kept.length));
		try {
			const row = old
				.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'k'")
				.get();
			expect(row?.value).toBe('"old one"');
		} finally {
			old.close();
		}
	});

	test("with only OTTR_DATA_DIR set, a project database goes there and no marker is written", async () => {
		const d = dirs("data-dir");
		const data = join(d.base, "data");
		await snapshot(d.dir, T0, "one", ["demo"]);
		const run = await runRestore(["latest"], { ...d.env, OTTR_DATA_DIR: data });
		expect(run).toEqual({
			code: 0,
			out: [
				`restored tracker.db -> ${d.trackerDb}`,
				`restored projects/demo/tasks.db -> ${join(data, "demo", "tasks.db")}`,
			],
			err: [],
		});
		expect(readdirSync(data)).toEqual(["demo"]);
		expect(readdirSync(join(data, "demo"))).toEqual(["tasks.db"]);
	});

	test("a live store on a target stops the tool with code 1 and no change", async () => {
		const d = dirs("held");
		await snapshot(d.dir, T0, "from the snapshot");
		const live = track(await GlobalStore.open(d.state));
		await live.set("k", "live");
		const run = await runRestore(["latest"], d.env);
		expect(run.code).toBe(1);
		expect(run.out).toEqual([]);
		expect(run.err.length).toBe(1);
		expect(run.err[0]).toContain("stop the board first");
		expect(run.err[0]).toContain(d.trackerDb);
		expect(await live.get<string>("k")).toBe("live");
		const touched = readdirSync(join(d.state, ".tasks")).filter((name) =>
			name.includes("restor"),
		);
		expect(touched).toEqual([]);
		await live.close();
		expect(await kIn(d.state)).toBe("live");
	});

	test("close drains a delayed transaction and snapshot before restore acquires the lock", async () => {
		const d = dirs("close-drain");
		await snapshot(d.dir, T0, "snapshot");
		const live = track(await GlobalStore.open(d.state));
		await live.set("k", "live");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const work = live.transaction(async () => {
			entered.resolve();
			await release.promise;
			await live.set("k", "settled");
		});
		await entered.promise;
		const copyPath = join(d.base, "drained.db");
		const copy = live.backupTo(copyPath);
		let closed = false;
		const closing = live.close().then(() => {
			closed = true;
		});
		try {
			expect(closed).toBe(false);
			const held = await runRestore(["latest"], d.env);
			expect(held.code).toBe(1);
			expect(held.err[0]).toContain("stop the board first");
			expect(existsSync(copyPath)).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([work, copy, closing]);
		}
		expect(closed).toBe(true);
		const drained = new Database(copyPath);
		try {
			expect(
				drained
					.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'k'")
					.get()?.value,
			).toBe('"settled"');
		} finally {
			drained.close();
		}
		const restored = await runRestore(["latest"], d.env);
		expect(restored.code).toBe(0);
		expect(restored.err).toEqual([]);
		expect(await kIn(d.state)).toBe("snapshot");
	});

	test("a snapshot in which a database copy failed gives code 1 and names the newest snapshot with a copy", async () => {
		const d = dirs("incomplete");
		const server = join(d.base, "server");
		await snapshot(d.dir, T0, "complete", ["demo"]);
		const gstore = track(await GlobalStore.open(tmp("source-state")));
		await gstore.set("k", "newest");
		const failing = {
			name: "demo",
			backupTo: async () => {
				throw new Error("disk full");
			},
		};
		const made = await runBackup({
			dir: d.dir,
			keep: 7,
			now: T1,
			sources: backupSources(gstore, [failing]),
		});
		await gstore.close();
		expect(made.failed).toEqual([
			{ file: "projects/demo/tasks.db", error: "disk full" },
		]);

		const env = { ...d.env, OTTR_SERVER_DATA_DIR: server };
		const older = join(d.dir, S0, "projects", "demo", "tasks.db");
		expect(await runRestore(["latest"], env)).toEqual({
			code: 1,
			out: [`restored tracker.db -> ${d.trackerDb}`],
			err: [
				`projects/demo/tasks.db failed: not in the snapshot ${S1}: the copy failed at backup time (disk full). The newest snapshot with a copy is ${S0}: ${older}`,
			],
		});
		expect(await kIn(d.state)).toBe("newest");
		expect(existsSync(join(server, "demo", "tasks.db"))).toBe(false);

		const list = await runRestore([], env);
		expect(list.out.length).toBe(2);
		expect(list.out[0]).toEndWith(
			"; incomplete: projects/demo/tasks.db failed",
		);
		expect(list.out[1]).not.toContain("incomplete");
	});

	test("a snapshot file that fails the check gives code 1, and the other files still restore", async () => {
		const d = dirs("bad-file");
		const server = join(d.base, "server");
		await snapshot(d.dir, T0, "one", ["demo"]);
		writeFileSync(
			join(d.dir, S0, "projects", "demo", "tasks.db"),
			"not a sqlite file at all",
		);
		const run = await runRestore(["latest"], {
			...d.env,
			OTTR_SERVER_DATA_DIR: server,
		});
		expect(run.code).toBe(1);
		expect(run.out).toEqual([`restored tracker.db -> ${d.trackerDb}`]);
		expect(run.err.length).toBe(1);
		expect(run.err[0]).toStartWith("projects/demo/tasks.db failed: ");
		expect(readdirSync(join(server, "demo"))).toEqual([]);
		expect(await kIn(d.state)).toBe("one");
	});
});
