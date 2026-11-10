import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	BACKUP_INTERVAL_MS,
	type BackupSource,
	backupDue,
	backupSources,
	backupTick,
	formatStamp,
	listSnapshots,
	parseStamp,
	resolveBackup,
	restoreSnapshot,
	runBackup,
} from "./backup.ts";
import { closeLocked, openLocked, StoreLockedError } from "./dblock.ts";
import { GlobalStore } from "./globalStore.ts";
import fc from "./test/properties.ts";

// docs/specs/db-backup.md. Each test passes `now`: no test reads the clock.

const root = mkdtempSync(join(tmpdir(), "ottr-backup-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

let made = 0;
/** A new empty dir below the test root. */
const tmp = (label: string): string => {
	const dir = join(root, `${label}-${made++}`);
	mkdirSync(dir);
	return dir;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-10T03:15:00Z");
const S0 = "20261110T031500Z";
const S1 = "20261111T031500Z";
const S2 = "20261112T031500Z";
const after = (ms: number): Date => new Date(T0.getTime() + ms);

const good = (file: string, body = "copy"): BackupSource => ({
	file,
	backupTo: (dest) => writeFileSync(dest, body),
});
const bad = (file: string, error: string): BackupSource => ({
	file,
	backupTo: () => {
		throw new Error(error);
	},
});

/** A closed SQLite file with one row. */
const sqliteFile = (path: string, value: string): void => {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.exec("CREATE TABLE t (v TEXT NOT NULL)");
	db.query("INSERT INTO t (v) VALUES (?)").run(value);
	db.close();
};
const rowIn = (path: string): string | undefined => {
	const db = new Database(path);
	try {
		return db.query<{ v: string }, []>("SELECT v FROM t").get()?.v;
	} finally {
		db.close();
	}
};

describe("formatStamp and parseStamp", () => {
	test("a stamp is the UTC time in whole seconds", () => {
		expect(formatStamp(T0)).toBe(S0);
		expect(formatStamp(new Date("2026-11-10T03:15:00.999Z"))).toBe(S0);
		expect(formatStamp(new Date("2026-01-02T03:04:05+02:00"))).toBe(
			"20260102T010405Z",
		);
		expect(parseStamp(S0)?.getTime()).toBe(T0.getTime());
		expect(parseStamp("20240229T235959Z")?.toISOString()).toBe(
			"2024-02-29T23:59:59.000Z",
		);
	});

	test("a name that is not a canonical stamp gives null", () => {
		for (const name of [
			"",
			"20261340T000000Z",
			"20260230T000000Z",
			"20230229T000000Z",
			"20261110T240000Z",
			"20261110T036000Z",
			"20261110T031560Z",
			"20261110t031500z",
			"20261110T031500",
			"2026-11-10T03:15:00Z",
			" 20261110T031500Z",
			"20261110T031500Z\n",
			"20261110T031500Z.partial",
			"x20261110T031500Z",
			"notes.txt",
		])
			expect(parseStamp(name)).toBeNull();
	});

	test("property: a formatted time parses to the same whole second", () => {
		const max = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
		fc.assert(
			fc.property(fc.integer({ min: 0, max }), (ms) => {
				const parsed = parseStamp(formatStamp(new Date(ms)));
				expect(parsed?.getTime()).toBe(Math.floor(ms / 1000) * 1000);
			}),
		);
	});

	const pad = (n: number, width: number): string =>
		String(n).padStart(width, "0");
	/** Stamp-shaped names; the fields go a little past their valid ranges. */
	const shapedArb = fc
		.tuple(
			fc.integer({ min: 1970, max: 9999 }),
			fc.integer({ min: 0, max: 14 }),
			fc.integer({ min: 0, max: 33 }),
			fc.integer({ min: 0, max: 25 }),
			fc.integer({ min: 0, max: 61 }),
			fc.integer({ min: 0, max: 61 }),
		)
		.map(([y, mo, d, h, mi, s]) => ({
			name: `${pad(y, 4)}${pad(mo, 2)}${pad(d, 2)}T${pad(h, 2)}${pad(mi, 2)}${pad(s, 2)}Z`,
			y,
			mo,
			d,
			h,
			mi,
			s,
		}));

	test("property: each accepted name formats to itself", () => {
		const nameArb = fc.oneof(
			fc.string(),
			shapedArb.map((shaped) => shaped.name),
		);
		fc.assert(
			fc.property(nameArb, (name) => {
				const parsed = parseStamp(name);
				if (parsed !== null) expect(formatStamp(parsed)).toBe(name);
			}),
		);
	});

	test("property: parseStamp accepts exactly the real calendar times", () => {
		fc.assert(
			fc.property(shapedArb, ({ name, y, mo, d, h, mi, s }) => {
				const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
				const real =
					mo >= 1 &&
					mo <= 12 &&
					d >= 1 &&
					d <= lastDay &&
					h <= 23 &&
					mi <= 59 &&
					s <= 59;
				const expected = real ? Date.UTC(y, mo - 1, d, h, mi, s) : null;
				expect(parseStamp(name)?.getTime() ?? null).toBe(expected);
			}),
		);
	});
});

describe("listSnapshots", () => {
	test("a missing dir has no snapshots", () => {
		expect(listSnapshots(join(tmp("missing"), "nope"))).toEqual([]);
	});

	test("only real directories with a canonical stamp count, newest first", () => {
		const dir = tmp("list");
		mkdirSync(join(dir, S0));
		mkdirSync(join(dir, S2));
		mkdirSync(join(dir, S1));
		mkdirSync(join(dir, "20261113T031500Z.partial"));
		mkdirSync(join(dir, "20261340T000000Z"));
		mkdirSync(join(dir, "manual-copy"));
		writeFileSync(join(dir, "20261114T031500Z"), "a file, not a snapshot");
		expect(listSnapshots(dir)).toEqual([S2, S1, S0]);
	});

	test.skipIf(process.platform === "win32")(
		"a symlink with a stamp name is not a snapshot",
		() => {
			const dir = tmp("list-link");
			const outside = tmp("list-outside");
			mkdirSync(join(dir, S0));
			symlinkSync(outside, join(dir, S1));
			expect(listSnapshots(dir)).toEqual([S0]);
		},
	);
});

describe("resolveBackup", () => {
	const composeRoots = ["/workspace", "/data", "/root"];

	test("the default dir is next to tracker.db", () => {
		expect(resolveBackup({}, "/srv/ottr", [])).toEqual({
			dir: join(resolve("/srv/ottr"), ".tasks", "backups"),
			keep: 7,
			errors: [],
		});
		expect(resolveBackup({ OTTR_BACKUP_DIR: "" }, "state", []).dir).toBe(
			join(resolve("state"), ".tasks", "backups"),
		);
	});

	test("OTTR_BACKUP_DIR names the dir", () => {
		const env = { OTTR_BACKUP_DIR: "/mnt/disk2/ottr" };
		expect(resolveBackup(env, "/srv/ottr", [])).toEqual({
			dir: resolve("/mnt/disk2/ottr"),
			keep: 7,
			errors: [],
		});
		expect(resolveBackup({ OTTR_BACKUP_DIR: "rel" }, "/srv", []).dir).toBe(
			resolve("rel"),
		);
	});

	test("OTTR_BACKUP_KEEP: digits give the count, an empty value the default", () => {
		const keepOf = (value: string) =>
			resolveBackup({ OTTR_BACKUP_KEEP: value }, "/srv/ottr", []);
		expect(keepOf("")).toMatchObject({ keep: 7, errors: [] });
		expect(keepOf("0")).toMatchObject({ keep: 0, errors: [] });
		expect(keepOf("3")).toMatchObject({ keep: 3, errors: [] });
		expect(keepOf("12")).toMatchObject({ keep: 12, errors: [] });
	});

	test("OTTR_BACKUP_KEEP: each other value is an error and gives the default", () => {
		for (const value of ["-1", "x", "1.5", " 3", "3\n", "3x", "+3"]) {
			const result = resolveBackup(
				{ OTTR_BACKUP_KEEP: value },
				"/srv/ottr",
				[],
			);
			expect(result.keep).toBe(7);
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain("OTTR_BACKUP_KEEP");
			expect(result.errors[0]).toContain(value);
		}
	});

	test("a dir equal to or below a worker root makes no backups", () => {
		for (const dir of ["/data", "/data/backups", "/root/a/b", "/data/..x"]) {
			const result = resolveBackup(
				{ OTTR_BACKUP_DIR: dir },
				"/app",
				composeRoots,
			);
			expect(result.dir).toBe(resolve(dir));
			expect(result.keep).toBe(0);
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain(resolve(dir));
			expect(result.errors[0]).toContain(resolve(`/${dir.split("/")[1]}`));
		}
	});

	test("the compose layout and dirs next to or above a root are accepted", () => {
		for (const dir of ["/backup", "/data-backup", "/dat", "/"]) {
			const env = { OTTR_BACKUP_DIR: dir, OTTR_BACKUP_KEEP: "3" };
			expect(resolveBackup(env, "/app", composeRoots)).toEqual({
				dir: resolve(dir),
				keep: 3,
				errors: [],
			});
		}
	});

	test("the default dir is never refused, also below a worker root", () => {
		expect(resolveBackup({}, "/workspace/ottr", composeRoots)).toEqual({
			dir: join(resolve("/workspace/ottr"), ".tasks", "backups"),
			keep: 7,
			errors: [],
		});
	});

	test("a bad keep value and an unsafe dir give two errors", () => {
		const env = { OTTR_BACKUP_DIR: "/data/b", OTTR_BACKUP_KEEP: "many" };
		const result = resolveBackup(env, "/app", composeRoots);
		expect(result.keep).toBe(0);
		expect(result.errors.length).toBe(2);
	});
});

describe("backupSources", () => {
	test("gives the snapshot layout and copies through each store", () => {
		const calls: string[] = [];
		const store = (name: string) => ({
			name,
			backupTo: (dest: string) => calls.push(`${name} -> ${dest}`),
		});
		const projects = new Set([store("alpha"), store("beta")]);
		const sources = backupSources(store("tracker"), projects);
		expect(sources.map((source) => source.file)).toEqual([
			"tracker.db",
			"projects/alpha/tasks.db",
			"projects/beta/tasks.db",
		]);
		for (const source of sources) source.backupTo(`/x/${source.file}`);
		expect(calls).toEqual([
			"tracker -> /x/tracker.db",
			"alpha -> /x/projects/alpha/tasks.db",
			"beta -> /x/projects/beta/tasks.db",
		]);
	});
});

describe("backupDue and backupTick", () => {
	const ticker = (
		dir: string,
		sources: () => BackupSource[] = () => [good("tracker.db")],
	) => {
		const lines: string[] = [];
		let asked = 0;
		const tick = (now: Date, keep = 7): void =>
			backupTick({
				dir,
				keep,
				now,
				sources: () => {
					asked++;
					return sources();
				},
				log: (line) => lines.push(line),
			});
		return { lines, tick, asked: () => asked };
	};

	test("the first tick makes a snapshot, the next one is due at exactly 24 hours", () => {
		const dir = join(tmp("tick"), "backups");
		const t = ticker(dir);
		expect(BACKUP_INTERVAL_MS).toBe(DAY);
		expect(backupDue(dir, T0)).toBe(true);
		t.tick(T0);
		expect(listSnapshots(dir)).toEqual([S0]);
		expect(readdirSync(join(dir, S0))).toEqual(["tracker.db"]);
		expect(t.lines).toEqual([
			`backup: snapshot ${S0}: 1 databases, removed 0 old snapshots`,
		]);

		const early = after(DAY - 1000);
		expect(backupDue(dir, early)).toBe(false);
		t.tick(after(HOUR));
		t.tick(early);
		t.tick(after(DAY - 1));
		expect(listSnapshots(dir)).toEqual([S0]);
		expect(t.asked()).toBe(1);
		expect(t.lines.length).toBe(1);

		expect(backupDue(dir, after(DAY))).toBe(true);
		t.tick(after(DAY));
		expect(listSnapshots(dir)).toEqual([S1, S0]);
		expect(t.asked()).toBe(2);
	});

	test("a dir with only a partial snapshot is due", () => {
		const dir = tmp("due-partial");
		mkdirSync(join(dir, `${S0}.partial`));
		expect(backupDue(dir, after(HOUR))).toBe(true);
	});

	test("keep 0 makes no snapshot and asks for no sources", () => {
		const dir = join(tmp("tick-off"), "backups");
		const t = ticker(dir);
		t.tick(T0, 0);
		t.tick(T0, -1);
		expect(existsSync(dir)).toBe(false);
		expect(t.asked()).toBe(0);
		expect(t.lines).toEqual([]);
	});

	test("the tick reports the number of removed snapshots", () => {
		const dir = tmp("tick-prune");
		const t = ticker(dir);
		t.tick(T0, 1);
		t.tick(after(DAY), 1);
		expect(listSnapshots(dir)).toEqual([S1]);
		expect(t.lines[1]).toBe(
			`backup: snapshot ${S1}: 1 databases, removed 1 old snapshots`,
		);
	});

	test("a throwing sources() is logged and does not throw", () => {
		const dir = tmp("tick-throw");
		const t = ticker(dir, () => {
			throw new Error("boom");
		});
		t.tick(T0);
		expect(t.lines).toEqual(["backup: failed: boom"]);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("each failed database gets a log line with its file and error", () => {
		const dir = tmp("tick-fail");
		const t = ticker(dir, () => [
			good("tracker.db"),
			bad("projects/p/tasks.db", "disk full"),
		]);
		t.tick(T0);
		expect(t.lines).toEqual([
			`backup: snapshot ${S0}: 1 databases, removed 0 old snapshots`,
			"backup: projects/p/tasks.db failed: disk full",
		]);
	});

	test("a tick in which all databases fail keeps no snapshot, and the next tick tries again", () => {
		const dir = tmp("tick-all-fail");
		let broken = true;
		const t = ticker(dir, () =>
			broken
				? [bad("tracker.db", "locked"), bad("projects/p/tasks.db", "gone")]
				: [good("tracker.db")],
		);
		t.tick(T0);
		expect(t.lines).toEqual([
			"backup: no snapshot: all 2 databases failed",
			"backup: tracker.db failed: locked",
			"backup: projects/p/tasks.db failed: gone",
		]);
		expect(readdirSync(dir)).toEqual([]);
		broken = false;
		t.tick(after(HOUR));
		expect(listSnapshots(dir)).toEqual(["20261110T041500Z"]);
	});

	test("a backup dir that cannot be made is logged, and the tick does not throw", () => {
		const file = join(tmp("tick-nodir"), "a-file");
		writeFileSync(file, "in the way");
		const t = ticker(join(file, "backups"));
		t.tick(T0);
		expect(t.lines.length).toBe(1);
		expect(t.lines[0]).toStartWith("backup: failed: ");
	});
});

describe("runBackup", () => {
	const run = (
		dir: string,
		now: Date,
		keep: number,
		sources: BackupSource[] = [good("tracker.db")],
	) => runBackup({ dir, keep, now, sources });

	test("keep 2: the third good snapshot removes the oldest, foreign entries stay", () => {
		const dir = tmp("keep");
		writeFileSync(join(dir, "notes.txt"), "mine");
		mkdirSync(join(dir, "manual-copy"));
		writeFileSync(join(dir, "manual-copy", "tracker.db"), "by hand");
		expect(run(dir, T0, 2).pruned).toEqual([]);
		expect(run(dir, after(DAY), 2).pruned).toEqual([]);
		expect(run(dir, after(2 * DAY), 2)).toEqual({
			stamp: S2,
			copied: ["tracker.db"],
			failed: [],
			pruned: [S0],
		});
		expect(readdirSync(dir).sort()).toEqual([
			S1,
			S2,
			"manual-copy",
			"notes.txt",
		]);
		expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine");
		expect(readFileSync(join(dir, "manual-copy", "tracker.db"), "utf8")).toBe(
			"by hand",
		);
		expect(readFileSync(join(dir, S2, "tracker.db"), "utf8")).toBe("copy");
	});

	test("retention removes only real directories with a canonical stamp name", () => {
		const dir = tmp("keep-foreign");
		const foreignDirs = ["20261340T000000Z", "20200101T000000Z.bak", "old"];
		for (const name of foreignDirs) mkdirSync(join(dir, name));
		writeFileSync(join(dir, "20200101T000000Z"), "a file with a stamp name");
		mkdirSync(join(dir, "20200102T000000Z"));
		const result = run(dir, T0, 1);
		expect(result.pruned).toEqual(["20200102T000000Z"]);
		expect(readdirSync(dir).sort()).toEqual(
			[...foreignDirs, "20200101T000000Z", S0].sort(),
		);
	});

	test("keep below 1 never removes the snapshot of the run itself", () => {
		const dir = tmp("keep-zero");
		run(dir, T0, 1);
		expect(run(dir, after(DAY), 0).pruned).toEqual([S0]);
		expect(listSnapshots(dir)).toEqual([S1]);
	});

	test("a failed source removes nothing, and the snapshot holds the copies that passed", () => {
		const dir = tmp("one-fails");
		run(dir, T0, 1);
		const halfWritten: BackupSource = {
			file: "projects/half/tasks.db",
			backupTo: (dest) => {
				writeFileSync(dest, "half a copy");
				throw new Error("tasks count mismatch: 3 vs 2 in copy");
			},
		};
		const result = run(dir, after(DAY), 1, [
			good("tracker.db", "tracker"),
			bad("projects/down/tasks.db", "disk full"),
			halfWritten,
			good("projects/up/tasks.db", "up"),
		]);
		expect(result).toEqual({
			stamp: S1,
			copied: ["tracker.db", "projects/up/tasks.db"],
			failed: [
				{ file: "projects/down/tasks.db", error: "disk full" },
				{
					file: "projects/half/tasks.db",
					error: "tasks count mismatch: 3 vs 2 in copy",
				},
			],
			pruned: [],
		});
		expect(listSnapshots(dir)).toEqual([S1, S0]);
		const snap = join(dir, S1);
		expect(readFileSync(join(snap, "tracker.db"), "utf8")).toBe("tracker");
		expect(readFileSync(join(snap, "projects/up/tasks.db"), "utf8")).toBe("up");
		expect(existsSync(join(snap, "projects/down/tasks.db"))).toBe(false);
		expect(existsSync(join(snap, "projects/half/tasks.db"))).toBe(false);

		// The next run in which all sources pass applies retention again.
		expect(run(dir, after(2 * DAY), 1).pruned).toEqual([S1, S0]);
		expect(listSnapshots(dir)).toEqual([S2]);
	});

	test("a run in which all sources fail leaves no new dir", () => {
		const dir = tmp("all-fail");
		run(dir, T0, 1);
		const result = run(dir, after(DAY), 1, [
			bad("tracker.db", "locked"),
			bad("projects/p/tasks.db", "gone"),
		]);
		expect(result).toEqual({
			stamp: null,
			copied: [],
			failed: [
				{ file: "tracker.db", error: "locked" },
				{ file: "projects/p/tasks.db", error: "gone" },
			],
			pruned: [],
		});
		expect(readdirSync(dir)).toEqual([S0]);
	});

	test("a run removes a leftover partial snapshot and no other entry", () => {
		const dir = tmp("partial");
		const stale = `${S0}.partial`;
		const foreign = ["x.partial", "20261340T000000Z.partial", "partial"];
		mkdirSync(join(dir, stale, "projects", "p"), { recursive: true });
		writeFileSync(join(dir, stale, "tracker.db"), "half a snapshot");
		for (const name of foreign) mkdirSync(join(dir, name));
		expect(run(dir, after(DAY), 7).stamp).toBe(S1);
		expect(readdirSync(dir).sort()).toEqual([...foreign, S1].sort());
	});

	test("a source file that is not a relative path inside the snapshot fails", () => {
		const dir = join(tmp("unsafe"), "backups");
		const called: string[] = [];
		const source = (file: string): BackupSource => ({
			file,
			backupTo: (dest) => {
				called.push(file);
				writeFileSync(dest, "copy");
			},
		});
		const unsafe = [
			"../escape.db",
			"projects/../../escape.db",
			"projects\\..\\escape.db",
			join(dirname(dir), "absolute.db"),
			"",
		];
		const result = run(dir, T0, 7, [
			...unsafe.map(source),
			source("tracker.db"),
		]);
		expect(result.copied).toEqual(["tracker.db"]);
		expect(result.failed.map((failure) => failure.file)).toEqual(unsafe);
		expect(called).toEqual(["tracker.db"]);
		expect(readdirSync(dirname(dir))).toEqual(["backups"]);
		expect(readdirSync(dir)).toEqual([S0]);
		expect(readdirSync(join(dir, S0))).toEqual(["tracker.db"]);
	});

	test("a second source for one file fails and keeps the first copy", () => {
		const dir = tmp("twice");
		const result = run(dir, T0, 7, [
			good("tracker.db", "first"),
			good("tracker.db", "second"),
		]);
		expect(result.copied).toEqual(["tracker.db"]);
		expect(result.failed.map((failure) => failure.file)).toEqual([
			"tracker.db",
		]);
		expect(readFileSync(join(dir, S0, "tracker.db"), "utf8")).toBe("first");
	});

	test("a second run with the same time throws, and the first snapshot still opens", () => {
		const dir = tmp("same-second");
		const gstore = GlobalStore.open(tmp("same-second-state"));
		try {
			gstore.set("k", "first");
			const sources = () => backupSources(gstore, []);
			expect(run(dir, T0, 7, sources()).stamp).toBe(S0);
			gstore.set("k", "second");
			expect(() => run(dir, T0, 7, sources())).toThrow(S0);
		} finally {
			gstore.close();
		}
		expect(readdirSync(dir)).toEqual([S0]);
		const copy = new Database(join(dir, S0, "tracker.db"));
		try {
			const row = copy
				.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'k'")
				.get();
			expect(row?.value).toBe('"first"');
		} finally {
			copy.close();
		}
	});

	test("property: retention keeps each foreign entry and exactly the newest snapshots", () => {
		const base = tmp("retention-property");
		const now = new Date("2040-01-01T00:00:00Z");
		const stampArb = fc
			.integer({
				min: Date.UTC(2000, 0, 1) / 1000,
				max: Date.UTC(2030, 0, 1) / 1000,
			})
			.map((seconds) => formatStamp(new Date(seconds * 1000)));
		// Lowercase only: a foreign name can never be a stamp or a stale partial dir.
		const foreignArb = fc.oneof(
			fc
				.array(fc.constantFrom(..."abcxyz019_-".split("")), {
					minLength: 1,
					maxLength: 10,
				})
				.map((chars) => chars.join("")),
			fc.constantFrom(
				"notes.txt",
				"20261340T000000Z",
				"20200101T000000Z.bak",
				"x.partial",
			),
		);
		let runs = 0;
		fc.assert(
			fc.property(
				fc.uniqueArray(stampArb, { maxLength: 8 }),
				fc.uniqueArray(fc.tuple(foreignArb, fc.boolean()), {
					maxLength: 5,
					selector: ([name]) => name,
				}),
				fc.integer({ min: 1, max: 5 }),
				(stamps, foreign, keep) => {
					const dir = join(base, String(runs++));
					mkdirSync(dir);
					for (const stamp of stamps) mkdirSync(join(dir, stamp));
					for (const [name, asDir] of foreign) {
						if (asDir) mkdirSync(join(dir, name));
						else writeFileSync(join(dir, name), "foreign");
					}
					const result = run(dir, now, keep);
					const all = [...stamps, formatStamp(now)].sort().reverse();
					expect(listSnapshots(dir)).toEqual(all.slice(0, keep));
					expect(result.pruned).toEqual(all.slice(keep));
					const names = foreign.map(([name]) => name);
					expect(readdirSync(dir).sort()).toEqual(
						[...all.slice(0, keep), ...names].sort(),
					);
				},
			),
		);
	});
});

describe("restoreSnapshot", () => {
	const RESTORE_AT = new Date("2026-11-12T08:00:00.250Z");
	const ASIDE = ".before-restore-20261112T080000Z";

	/** The snapshot S0 with tracker.db and one project, and the restore targets below a new dir. */
	const fixture = () => {
		const base = tmp("restore");
		const dir = join(base, "backups");
		const snap = join(dir, S0);
		sqliteFile(join(snap, "tracker.db"), "snap-tracker");
		sqliteFile(join(snap, "projects", "proj", "tasks.db"), "snap-proj");
		const trackerDb = join(base, "state", ".tasks", "tracker.db");
		const projDb = join(base, "server", "proj", "tasks.db");
		const marker = join(base, "server", ".adopted");
		const restore = (
			change: Partial<Parameters<typeof restoreSnapshot>[0]> = {},
		) =>
			restoreSnapshot({
				dir,
				stamp: S0,
				now: RESTORE_AT,
				trackerDb,
				projectDbFor: (name) => join(base, "server", name, "tasks.db"),
				adoptedMarker: marker,
				...change,
			});
		return { base, dir, snap, trackerDb, projDb, marker, restore };
	};

	test("each snapshot file goes to its target, and the marker is written", () => {
		const f = fixture();
		expect(f.restore()).toEqual({
			restored: [
				{ file: "tracker.db", to: f.trackerDb },
				{ file: "projects/proj/tasks.db", to: f.projDb },
			],
			manual: [],
			failed: [],
			movedAside: [],
		});
		expect(readdirSync(dirname(f.trackerDb))).toEqual(["tracker.db"]);
		expect(readdirSync(dirname(f.projDb))).toEqual(["tasks.db"]);
		expect(rowIn(f.trackerDb)).toBe("snap-tracker");
		expect(rowIn(f.projDb)).toBe("snap-proj");
		expect(readFileSync(f.marker, "utf8")).toBe("2026-11-12T08:00:00.250Z\n");
	});

	test("an existing marker stays, and a null marker writes none", () => {
		const kept = fixture();
		mkdirSync(dirname(kept.marker), { recursive: true });
		writeFileSync(kept.marker, "earlier\n");
		kept.restore();
		expect(readFileSync(kept.marker, "utf8")).toBe("earlier\n");

		const none = fixture();
		none.restore({ adoptedMarker: null });
		expect(readdirSync(join(none.base, "server"))).toEqual(["proj"]);
	});

	test("a live holder of a target stops the restore before each change", () => {
		const f = fixture();
		mkdirSync(dirname(f.projDb), { recursive: true });
		const holder = openLocked(f.projDb);
		try {
			holder.exec("CREATE TABLE t (v TEXT NOT NULL)");
			holder.query("INSERT INTO t (v) VALUES (?)").run("live");
			expect(() => f.restore()).toThrow(StoreLockedError);
			const row = holder.query<{ v: string }, []>("SELECT v FROM t").get();
			expect(row?.v).toBe("live");
			// tracker.db is the first file of the snapshot: it must not be there either.
			expect(existsSync(join(f.base, "state"))).toBe(false);
			expect(existsSync(f.marker)).toBe(false);
			const touched = readdirSync(dirname(f.projDb)).filter((name) =>
				name.includes("restor"),
			);
			expect(touched).toEqual([]);
		} finally {
			closeLocked(holder);
		}

		// With the holder gone, the same restore runs and keeps the live data aside.
		const result = f.restore();
		expect(result.failed).toEqual([]);
		expect(result.movedAside).toEqual([`${f.projDb}${ASIDE}`]);
		expect(rowIn(`${f.projDb}${ASIDE}`)).toBe("live");
		expect(rowIn(f.projDb)).toBe("snap-proj");
	});

	test("an existing target is renamed aside, and its old content still opens there", () => {
		const f = fixture();
		sqliteFile(f.trackerDb, "old");
		const result = f.restore();
		expect(result.failed).toEqual([]);
		expect(result.movedAside).toEqual([`${f.trackerDb}${ASIDE}`]);
		expect(readdirSync(dirname(f.trackerDb)).sort()).toEqual([
			"tracker.db",
			`tracker.db${ASIDE}`,
		]);
		expect(rowIn(`${f.trackerDb}${ASIDE}`)).toBe("old");
		expect(rowIn(f.trackerDb)).toBe("snap-tracker");
	});

	test("stale -wal and -shm files of a target are renamed aside too", () => {
		const f = fixture();
		mkdirSync(dirname(f.trackerDb), { recursive: true });
		writeFileSync(`${f.trackerDb}-wal`, "stale wal");
		writeFileSync(`${f.trackerDb}-shm`, "stale shm");
		const result = f.restore();
		expect(result.movedAside).toEqual([
			`${f.trackerDb}-wal${ASIDE}`,
			`${f.trackerDb}-shm${ASIDE}`,
		]);
		expect(readdirSync(dirname(f.trackerDb)).sort()).toEqual([
			"tracker.db",
			`tracker.db-shm${ASIDE}`,
			`tracker.db-wal${ASIDE}`,
		]);
		expect(readFileSync(`${f.trackerDb}-wal${ASIDE}`, "utf8")).toBe(
			"stale wal",
		);
		expect(readFileSync(`${f.trackerDb}-shm${ASIDE}`, "utf8")).toBe(
			"stale shm",
		);
		expect(rowIn(f.trackerDb)).toBe("snap-tracker");
	});

	test("a corrupt target does not stop the restore and is kept aside", () => {
		const f = fixture();
		mkdirSync(dirname(f.trackerDb), { recursive: true });
		writeFileSync(f.trackerDb, "not a sqlite file at all");
		const result = f.restore();
		expect(result.failed).toEqual([]);
		expect(result.movedAside).toEqual([`${f.trackerDb}${ASIDE}`]);
		expect(readFileSync(`${f.trackerDb}${ASIDE}`, "utf8")).toBe(
			"not a sqlite file at all",
		);
		expect(rowIn(f.trackerDb)).toBe("snap-tracker");
	});

	test("a snapshot file that is not a SQLite database fails, and its target stays", () => {
		const f = fixture();
		writeFileSync(join(f.snap, "tracker.db"), "not a sqlite file at all");
		sqliteFile(f.trackerDb, "old");
		const result = f.restore();
		expect(result.failed.map((failure) => failure.file)).toEqual([
			"tracker.db",
		]);
		expect(result.failed[0]?.error).not.toBe("");
		expect(result.restored).toEqual([
			{ file: "projects/proj/tasks.db", to: f.projDb },
		]);
		expect(result.movedAside).toEqual([]);
		expect(readdirSync(dirname(f.trackerDb))).toEqual(["tracker.db"]);
		expect(rowIn(f.trackerDb)).toBe("old");
	});

	test("a leftover .restoring file is replaced", () => {
		const f = fixture();
		mkdirSync(dirname(f.trackerDb), { recursive: true });
		writeFileSync(`${f.trackerDb}.restoring`, "half a copy");
		expect(f.restore().failed).toEqual([]);
		expect(readdirSync(dirname(f.trackerDb))).toEqual(["tracker.db"]);
		expect(rowIn(f.trackerDb)).toBe("snap-tracker");
	});

	test("a second restore in the same second deletes no kept file", () => {
		const f = fixture();
		sqliteFile(f.trackerDb, "old");
		f.restore();
		const second = f.restore();
		expect(second.failed.map((failure) => failure.file)).toEqual([
			"tracker.db",
		]);
		expect(second.failed[0]?.error).toContain(`${f.trackerDb}${ASIDE}`);
		expect(rowIn(`${f.trackerDb}${ASIDE}`)).toBe("old");
		expect(rowIn(f.trackerDb)).toBe("snap-tracker");
	});

	test("a project with no known target gives a manual entry", () => {
		const f = fixture();
		const result = f.restore({
			projectDbFor: () => null,
			adoptedMarker: null,
		});
		expect(result).toEqual({
			restored: [{ file: "tracker.db", to: f.trackerDb }],
			manual: [
				{
					file: "projects/proj/tasks.db",
					from: join(f.snap, "projects", "proj", "tasks.db"),
				},
			],
			failed: [],
			movedAside: [],
		});
		expect(existsSync(join(f.base, "server"))).toBe(false);
	});

	test("a stamp that is not a snapshot throws and changes nothing", () => {
		const f = fixture();
		const partial = "20261111T031500Z.partial";
		sqliteFile(join(f.dir, partial, "tracker.db"), "half a snapshot");
		for (const stamp of ["20260101T000000Z", partial, "..", "", "latest"])
			expect(() => f.restore({ stamp })).toThrow("no snapshot");
		expect(readdirSync(f.base)).toEqual(["backups"]);
	});

	test.skipIf(process.platform === "win32")(
		"a symlink in the snapshot is not restored",
		() => {
			const f = fixture();
			const outside = join(f.base, "outside");
			sqliteFile(join(outside, "tasks.db"), "planted");
			symlinkSync(outside, join(f.snap, "projects", "linked-dir"));
			mkdirSync(join(f.snap, "projects", "linked-file"));
			symlinkSync(
				join(outside, "tasks.db"),
				join(f.snap, "projects", "linked-file", "tasks.db"),
			);
			const result = f.restore();
			expect(result.restored.map((entry) => entry.file)).toEqual([
				"tracker.db",
				"projects/proj/tasks.db",
			]);
			expect(result.manual).toEqual([]);
			expect(readdirSync(join(f.base, "server")).sort()).toEqual([
				".adopted",
				"proj",
			]);
		},
	);
});
