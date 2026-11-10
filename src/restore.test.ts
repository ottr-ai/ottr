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
const opened: { close(): void }[] = [];
/** Teardown closes each store also when an assertion fails before the close in the test. */
const track = <S extends { close(): void }>(store: S): S => {
	opened.push(store);
	return store;
};
afterAll(() => {
	for (const store of opened) store.close(); // a second close does nothing
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
const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
	const saved = Object.keys(vars).map((key) => ({
		key,
		value: process.env[key],
	}));
	Object.assign(process.env, vars);
	try {
		return fn();
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
const snapshot = (
	dir: string,
	now: Date,
	value: string,
	projects: string[] = [],
): void => {
	const gstore = track(GlobalStore.open(tmp("source-state")));
	gstore.set("k", value);
	const stores = projects.map((name) => ({
		name,
		backupTo: (dest: string) => gstore.backupTo(dest),
	}));
	const sources = backupSources(gstore, stores);
	const result = runBackup({ dir, keep: 7, now, sources });
	gstore.close();
	expect(result.failed).toEqual([]);
};

/** The key `k` of the tracker.db in `stateDir`, read through a real GlobalStore. */
const kIn = (stateDir: string): string | null => {
	const gstore = track(GlobalStore.open(stateDir));
	const value = gstore.get<string>("k");
	gstore.close();
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
	test("a snapshot of the live stores restores into an empty state dir and server data dir", () => {
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
		const before = withEnv(oldDirs, () => {
			const gstore = track(GlobalStore.open(join(base, "state")));
			const store = track(ProjectStore.open(proj));
			gstore.set("config", config);
			gstore.set("seen-answers", [3, 5, 8]);
			store.setSettings({
				releaseCommand: "bun run release",
				displayName: "Demo",
			});
			const first = store.createTask("First card\n\nwith a body");
			store.createTask("Second card");
			const work = store.startTurn(first.id, "work", "First card", null);
			store.finishTurn(work.id, {
				endedAt: 1_800_000_000_000,
				model: "zai/glm-5.3-flash",
			});
			const second = store.startTurn(first.id, "work", "Go on", null);
			store.finishTurn(second.id, { endedAt: 1_800_000_060_000 });
			const result = runBackup({
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
				settings: store.getSettings(),
				tasks: store.listTasks(),
				turns: store.listTurns(first.id),
				firstId: first.id,
			};
			store.close();
			gstore.close();
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
		withEnv(newDirs, () => {
			expect(discoverProjects([parent])).toEqual([]);
		});

		const run = runRestore(["latest"], {
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

		withEnv(newDirs, () => {
			expect(discoverProjects([parent])).toEqual([proj]);
			const gstore = track(GlobalStore.open(state));
			const store = track(ProjectStore.open(proj));
			expect(gstore.get("config")).toEqual(config);
			expect(gstore.get("seen-answers")).toEqual([3, 5, 8]);
			expect(store.getSettings()).toEqual(before.settings);
			expect(store.listTasks()).toEqual(before.tasks);
			expect(store.listTurns(before.firstId)).toEqual(before.turns);
			store.close();
			gstore.close();
		});
	});

	test("no argument lists the snapshots with the size of each file and changes nothing", () => {
		const d = dirs("list");
		expect(runRestore([], d.env)).toEqual({
			code: 0,
			out: [`no snapshots in ${d.dir}`],
			err: [],
		});
		expect(readdirSync(d.base)).toEqual([]);

		snapshot(d.dir, T0, "one");
		snapshot(d.dir, T1, "two", ["demo", "alpha"]);
		const size = (...parts: string[]): number =>
			statSync(join(d.dir, ...parts)).size;
		const tracker = size(S1, "tracker.db");
		const alpha = size(S1, "projects", "alpha", "tasks.db");
		const demo = size(S1, "projects", "demo", "tasks.db");
		expect(tracker).toBeGreaterThan(0);
		expect(runRestore([], d.env)).toEqual({
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

	test("a stamp that is not a snapshot gives code 1 and changes nothing", () => {
		const d = dirs("missing");
		snapshot(d.dir, T0, "one");
		expect(runRestore(["20260101T000000Z"], d.env)).toEqual({
			code: 1,
			out: [],
			err: [`no snapshot 20260101T000000Z in ${d.dir}`],
		});
		const empty = join(d.base, "empty");
		const emptyEnv = { ...d.env, OTTR_BACKUP_DIR: empty };
		expect(runRestore(["latest"], emptyEnv)).toEqual({
			code: 1,
			out: [],
			err: [`no snapshots in ${empty}`],
		});
		expect(readdirSync(d.base)).toEqual(["backup"]);
	});

	test("more than one argument or an option gives code 1 and a usage line", () => {
		const d = dirs("usage");
		snapshot(d.dir, T0, "one");
		for (const args of [["latest", "extra"], ["--help"], ["-f", S0], ["-"]]) {
			const run = runRestore(args, d.env);
			expect(run.code).toBe(1);
			expect(run.out).toEqual([]);
			expect(run.err.length).toBe(1);
			expect(run.err[0]).toStartWith("usage: ");
		}
		expect(readdirSync(d.base)).toEqual(["backup"]);
	});

	test("with no data dir set, a project database gets a line to copy it by hand", () => {
		const d = dirs("manual");
		snapshot(d.dir, T0, "old one");
		snapshot(d.dir, T1, "new one", ["demo"]);

		// A stamp argument restores that snapshot, not the newest one.
		expect(runRestore([S0], d.env)).toEqual({
			code: 0,
			out: [`restored tracker.db -> ${d.trackerDb}`],
			err: [],
		});
		expect(kIn(d.state)).toBe("old one");

		const run = runRestore(["latest"], d.env);
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
		expect(kIn(d.state)).toBe("new one");

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

	test("with only OTTR_DATA_DIR set, a project database goes there and no marker is written", () => {
		const d = dirs("data-dir");
		const data = join(d.base, "data");
		snapshot(d.dir, T0, "one", ["demo"]);
		const run = runRestore(["latest"], { ...d.env, OTTR_DATA_DIR: data });
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

	test("a live store on a target stops the tool with code 1 and no change", () => {
		const d = dirs("held");
		snapshot(d.dir, T0, "from the snapshot");
		const live = track(GlobalStore.open(d.state));
		live.set("k", "live");
		const run = runRestore(["latest"], d.env);
		expect(run.code).toBe(1);
		expect(run.out).toEqual([]);
		expect(run.err.length).toBe(1);
		expect(run.err[0]).toContain("stop the board first");
		expect(run.err[0]).toContain(d.trackerDb);
		expect(live.get<string>("k")).toBe("live");
		const touched = readdirSync(join(d.state, ".tasks")).filter((name) =>
			name.includes("restor"),
		);
		expect(touched).toEqual([]);
		live.close();
		expect(kIn(d.state)).toBe("live");
	});

	test("a snapshot in which a database copy failed gives code 1 and names the newest snapshot with a copy", () => {
		const d = dirs("incomplete");
		const server = join(d.base, "server");
		snapshot(d.dir, T0, "complete", ["demo"]);
		const gstore = track(GlobalStore.open(tmp("source-state")));
		gstore.set("k", "newest");
		const failing = {
			name: "demo",
			backupTo: () => {
				throw new Error("disk full");
			},
		};
		const made = runBackup({
			dir: d.dir,
			keep: 7,
			now: T1,
			sources: backupSources(gstore, [failing]),
		});
		gstore.close();
		expect(made.failed).toEqual([
			{ file: "projects/demo/tasks.db", error: "disk full" },
		]);

		const env = { ...d.env, OTTR_SERVER_DATA_DIR: server };
		const older = join(d.dir, S0, "projects", "demo", "tasks.db");
		expect(runRestore(["latest"], env)).toEqual({
			code: 1,
			out: [`restored tracker.db -> ${d.trackerDb}`],
			err: [
				`projects/demo/tasks.db failed: not in the snapshot ${S1}: the copy failed at backup time (disk full). The newest snapshot with a copy is ${S0}: ${older}`,
			],
		});
		expect(kIn(d.state)).toBe("newest");
		expect(existsSync(join(server, "demo", "tasks.db"))).toBe(false);

		const list = runRestore([], env);
		expect(list.out.length).toBe(2);
		expect(list.out[0]).toEndWith(
			"; incomplete: projects/demo/tasks.db failed",
		);
		expect(list.out[1]).not.toContain("incomplete");
	});

	test("a snapshot file that fails the check gives code 1, and the other files still restore", () => {
		const d = dirs("bad-file");
		const server = join(d.base, "server");
		snapshot(d.dir, T0, "one", ["demo"]);
		writeFileSync(
			join(d.dir, S0, "projects", "demo", "tasks.db"),
			"not a sqlite file at all",
		);
		const run = runRestore(["latest"], {
			...d.env,
			OTTR_SERVER_DATA_DIR: server,
		});
		expect(run.code).toBe(1);
		expect(run.out).toEqual([`restored tracker.db -> ${d.trackerDb}`]);
		expect(run.err.length).toBe(1);
		expect(run.err[0]).toStartWith("projects/demo/tasks.db failed: ");
		expect(readdirSync(join(server, "demo"))).toEqual([]);
		expect(kIn(d.state)).toBe("one");
	});
});
