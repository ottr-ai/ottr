import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { uidFixtureDir } from "./test/uidFixture.ts";
import {
	formatBytes,
	runMarkerPath,
	SWEEP_CLOCK_SKEW_MS,
	sweepTmpDirs,
	sweepTmpDirsLogged,
	touchRunMarker,
	touchRunMarkers,
} from "./tmpsweep.ts";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const rootTest = isRoot ? test : test.skip;

describe("sweepTmpDirs", () => {
	const root = mkdtempSync(join(tmpdir(), "sweeptest-"));
	const procRoot = mkdtempSync(join(tmpdir(), "sweepproc-"));
	const old = Date.now() / 1000 - 25 * 60 * 60;
	const oldMs = old * 1000;

	/** One old top-level entry under the fixture root, fresh entries left alone. */
	const make = (name: string, inner?: string, innerAge?: number): string => {
		const p = join(root, name);
		mkdirSync(p, { recursive: true });
		if (inner !== undefined) writeFileSync(join(p, inner), "x");
		utimesSync(p, old, old);
		if (inner !== undefined && innerAge !== undefined) {
			const t = (Date.now() - innerAge) / 1000;
			utimesSync(join(p, inner), t, t);
		}
		return p;
	};

	test("removes old entries, prefixed or not; keeps fresh entries", () => {
		mkdirSync(join(root, "turn-old"));
		writeFileSync(join(root, "turn-oldfile"), "x");
		mkdirSync(join(root, "turn-new"));
		for (const name of ["turn-old", "turn-oldfile"]) {
			utimesSync(join(root, name), old, old);
		}
		// OTTR-754: unprefixed entries are just entries — the uniform rule removes them too.
		const removed = sweepTmpDirs(root, { procRoot });
		const names = removed.map((e) => e.name);
		expect(names).toContain("turn-old");
		expect(names).toContain("turn-oldfile");
		expect(existsSync(join(root, "turn-old"))).toBe(false);
		expect(existsSync(join(root, "turn-oldfile"))).toBe(false);
		expect(existsSync(join(root, "turn-new"))).toBe(true);
	});

	test("removes old unprefixed dir and file, keeps fresh entry", () => {
		const dir = make("plain-dir");
		const file = join(root, "plain-file");
		writeFileSync(file, "y");
		utimesSync(file, old, old);
		mkdirSync(join(root, "fresh-dir")); // Genuinely fresh: make() would age it.
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).toContain("plain-dir");
		expect(removed).toContain("plain-file");
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(join(root, "fresh-dir"))).toBe(true);
	});

	test("newest-mtime rule: inner mtime decides, not the entry's own", () => {
		// Old dir holding a fresh inner file: kept.
		make("old-outer-fresh-inner", "fresh.txt", 0);
		// Fresh dir holding an old inner file: kept (fresh outer still wins).
		const freshOuter = join(root, "fresh-outer");
		mkdirSync(freshOuter);
		writeFileSync(join(freshOuter, "old.txt"), "x");
		utimesSync(join(freshOuter, "old.txt"), old, old);
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).not.toContain("old-outer-fresh-inner");
		expect(removed).not.toContain("fresh-outer");
		expect(existsSync(join(root, "old-outer-fresh-inner"))).toBe(true);
		expect(existsSync(freshOuter)).toBe(true);
	});

	test("skips an entry a live process holds via /proc fd or cwd", () => {
		const held = make("held-by-proc");
		const pid = join(procRoot, "4242");
		mkdirSync(join(pid, "fd"), { recursive: true });
		symlinkSync(`${held}/scratch.txt`, join(pid, "fd", "3"));
		symlinkSync(held, join(pid, "cwd"));
		// A deleted suffix on the link target matches too (matchSweepTarget's marker).
		const heldDeleted = make("held-deleted");
		mkdirSync(join(procRoot, "4243", "fd"), { recursive: true });
		symlinkSync(`${heldDeleted} (deleted)`, join(procRoot, "4243", "fd", "3"));
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).not.toContain("held-by-proc");
		expect(removed).not.toContain("held-deleted");
		expect(existsSync(held)).toBe(true);
		expect(existsSync(heldDeleted)).toBe(true);
	});

	test("skips an aged entry a live process names in argv or exe", () => {
		const heldArgv = make("held-by-argv");
		const pid = join(procRoot, "4244");
		mkdirSync(pid, { recursive: true });
		// NUL-separated argv like the kernel writes it; one absolute path into the
		// entry holds it, the flag arg never matches anything.
		writeFileSync(
			join(pid, "cmdline"),
			Buffer.from(`${heldArgv}/bin/tool\0--flag\0`),
		);
		const heldExe = make("held-by-exe");
		mkdirSync(join(procRoot, "4245"), { recursive: true });
		symlinkSync(`${heldExe}/bin/tool`, join(procRoot, "4245", "exe"));
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).not.toContain("held-by-argv");
		expect(removed).not.toContain("held-by-exe");
		expect(existsSync(heldArgv)).toBe(true);
		expect(existsSync(heldExe)).toBe(true);
	});

	test("keeps an aged entry a real child process holds as cwd; the sweep never signals", async () => {
		// The acceptance drill: the hold comes from a live child this test created and
		// the sweep reads the real /proc. sweepTmpDirs never signals — it only reads
		// links and cmdlines; the test itself reaps the child it spawned.
		const held = make("held-by-child-cwd");
		const child = Bun.spawn(["sleep", "30"], { cwd: held });
		try {
			const removed = sweepTmpDirs(root).map((e) => e.name);
			expect(removed).not.toContain("held-by-child-cwd");
			expect(existsSync(held)).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	}, 15000);

	test("sweepTmpDirsLogged logs each removal with its size and returns it", () => {
		make("logged-away", "f.txt", 25 * 60 * 60 * 1000); // aged entry, 1-byte file inside
		const lines: string[] = [];
		const realLog = console.log;
		console.log = (msg: unknown) => lines.push(String(msg));
		let swept: { name: string; bytes: number }[];
		try {
			swept = sweepTmpDirsLogged(root, { procRoot });
		} finally {
			console.log = realLog;
		}
		expect(swept.map((e) => e.name)).toContain("logged-away");
		expect(lines).toContain("sweep: removed logged-away (1 B)");
	});

	test("liveTurnStarts: start <= newest mtime keeps the entry, newer starts do not", () => {
		make("turn-owned");
		expect(
			sweepTmpDirs(root, {
				procRoot,
				liveTurnStarts: [oldMs - 1000],
			}).map((e) => e.name),
		).not.toContain("turn-owned");
		expect(existsSync(join(root, "turn-owned"))).toBe(true);
		expect(
			sweepTmpDirs(root, {
				procRoot,
				liveTurnStarts: [Date.now()],
			}).map((e) => e.name),
		).toContain("turn-owned");
		expect(existsSync(join(root, "turn-owned"))).toBe(false);
	});

	test("a start within the clock skew keeps an entry born just before it", () => {
		// The kernel may stamp an inode a few ms behind Date.now(): a scratch created
		// right at its run's birth then reads older than the start. The guard's skew
		// slack keeps it; a start beyond the skew does not.
		make("born-under-start");
		const startMs = oldMs + 4; // the entry reads 4 ms older than the run's start
		expect(
			sweepTmpDirs(root, {
				procRoot,
				liveTurnStarts: [startMs],
				now: oldMs + 25 * 60 * 60 * 1000,
			}).map((e) => e.name),
		).not.toContain("born-under-start");
		expect(existsSync(join(root, "born-under-start"))).toBe(true);
		const beyondSkew = oldMs + SWEEP_CLOCK_SKEW_MS + 60_000;
		expect(
			sweepTmpDirs(root, {
				procRoot,
				liveTurnStarts: [beyondSkew],
				now: oldMs + 25 * 60 * 60 * 1000,
			}).map((e) => e.name),
		).toContain("born-under-start");
		expect(existsSync(join(root, "born-under-start"))).toBe(false);
	});

	test("removes an old prefixed entry (regression)", () => {
		make("ottr-legacy");
		expect(sweepTmpDirs(root, { procRoot }).map((e) => e.name)).toContain(
			"ottr-legacy",
		);
		expect(existsSync(join(root, "ottr-legacy"))).toBe(false);
	});

	test("bytes equal the sum of removed file sizes", () => {
		const dir = join(root, "sized");
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "a.bin"), "12345");
		writeFileSync(join(dir, "nested", "b.bin"), "123");
		const file = join(root, "sized-file");
		writeFileSync(file, "12");
		// The whole tree is 25 h old: the newest-inner rule sweeps it only then.
		for (const p of [
			dir,
			join(dir, "nested"),
			join(dir, "a.bin"),
			join(dir, "nested", "b.bin"),
			file,
		]) {
			utimesSync(p, old, old);
		}
		const byName = new Map(
			sweepTmpDirs(root, { procRoot }).map((e) => [e.name, e.bytes]),
		);
		expect(byName.get("sized")).toBe(8);
		expect(byName.get("sized-file")).toBe(2);
	});

	test("formatBytes uses human units", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(999)).toBe("999 B");
		expect(formatBytes(1024)).toBe("1 KiB");
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(1024 * 1024)).toBe("1 MiB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GiB");
		expect(formatBytes(5 * 1024 * 1024 * 1024 * 1024)).toBe("5 TiB");
	});

	afterAll(() => {
		for (const p of [root, procRoot])
			rmSync(p, { recursive: true, force: true });
	});
});

describe("scratch liveness markers (OTTR-1295)", () => {
	const root = mkdtempSync(join(tmpdir(), "sweepmarker-"));
	const procRoot = mkdtempSync(join(tmpdir(), "sweepmarkproc-"));
	const old = Date.now() / 1000 - 25 * 60 * 60;
	const hour = 60 * 60;

	/** One aged scratch dir with an aged inner temp write; returns its path. */
	const makeScratch = (name: string, innerAgeS: number = 25 * hour): string => {
		const p = join(root, name);
		mkdirSync(p);
		writeFileSync(join(p, "used"), "x");
		utimesSync(p, old, old);
		const t = Date.now() / 1000 - innerAgeS;
		utimesSync(join(p, "used"), t, t);
		return p;
	};

	/** The scratch's liveness marker, fresh (1 min) unless aged on purpose. */
	const makeMarker = (scratch: string, ageS: number = 60): string => {
		const m = runMarkerPath(scratch);
		writeFileSync(m, `${basename(scratch)}\n`);
		const t = Date.now() / 1000 - ageS;
		utimesSync(m, t, t);
		return m;
	};

	test("a foreign worker's fresh marker keeps a quiet aged scratch; an unmarked scratch goes", () => {
		const live = makeScratch("run-foreign-live");
		const marker = makeMarker(live);
		makeScratch("run-foreign-dead");
		// Worker B's invocation over the shared volume: its own run starts are
		// disjoint (none here) and its /proc holds nothing in the fixture.
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).toContain("run-foreign-dead");
		expect(removed).not.toContain("run-foreign-live");
		expect(existsSync(live)).toBe(true);
		expect(existsSync(join(root, "run-foreign-dead"))).toBe(false);
		// The fresh marker itself survives like any fresh entry.
		expect(existsSync(marker)).toBe(true);
	});

	test("the owning worker's tick refreshes the marker and keeps its own scratch", () => {
		const live = makeScratch("run-own-live");
		makeMarker(live, 2 * hour); // unrefreshed since the last tick
		touchRunMarkers([live]); // the owner's pass runs first
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).not.toContain("run-own-live");
		expect(existsSync(live)).toBe(true);
	});

	test("a crashed worker's stale marker stops guarding and both go in one pass", () => {
		const crashed = makeScratch("run-crashed");
		makeMarker(crashed, 26 * hour); // the owner died before its last refresh
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).toContain("run-crashed");
		expect(removed).toContain("run-crashed.live");
		expect(existsSync(crashed)).toBe(false);
		expect(existsSync(runMarkerPath(crashed))).toBe(false);
	});

	test("a stale marker goes while a not-yet-quiet scratch waits for the next tick", () => {
		const recent = makeScratch("run-recent", 60); // wrote temp a minute ago
		makeMarker(recent, 26 * hour);
		const removed = sweepTmpDirs(root, { procRoot }).map((e) => e.name);
		expect(removed).toContain("run-recent.live");
		expect(existsSync(runMarkerPath(recent))).toBe(false);
		expect(existsSync(recent)).toBe(true);
	});

	test("touchRunMarker creates a daemon-owned marker naming its scratch", () => {
		const scratch = makeScratch("run-touched");
		touchRunMarker(scratch);
		const m = runMarkerPath(scratch);
		expect(existsSync(m)).toBe(true);
		expect(readFileSync(m, "utf8")).toBe(`${basename(scratch)}\n`);
		if (typeof process.getuid === "function")
			expect(statSync(m).uid).toBe(process.getuid());
	});

	rootTest(
		"a turn uid cannot create, touch, or delete the marker [requires uid 0]",
		() => {
			// The fixture owns this parent outside the caller's private TMPDIR.
			// The daemon owns the 0711 parent and the marker, not the scratch.
			const uidRoot = uidFixtureDir("sweepmarker-uid-");
			try {
				const turnUid = 12345;
				const scratch = join(uidRoot, "run-uid-proof");
				mkdirSync(scratch);
				writeFileSync(join(scratch, "used"), "x");
				chownSync(scratch, turnUid, turnUid);
				touchRunMarker(scratch);
				const m = runMarkerPath(scratch);
				expect(statSync(m).uid).toBe(0);
				// Each attempt reports its result from the same child uid.
				const probe = `(async () => {
					const fs = require("node:fs");
					const out = [];
					const attempt = (name, fn) =>
						out.push(name + ":" + (() => { try { fn(); return "ok"; } catch { return "denied"; } })());
					attempt("delete-marker", () => fs.unlinkSync(${JSON.stringify(m)}));
					attempt("create-marker", () =>
						fs.writeFileSync(${JSON.stringify(join(uidRoot, "run-evil.live"))}, "x"));
					attempt("touch-marker", () => fs.utimesSync(${JSON.stringify(m)}, new Date(), new Date()));
					attempt("delete-own-temp", () => fs.unlinkSync(${JSON.stringify(join(scratch, "used"))}));
					console.log(out.join(" "));
				})()`;
				const run = spawnSync(process.execPath, ["-e", probe], {
					uid: turnUid,
					gid: turnUid,
					encoding: "utf8",
					timeout: 30_000,
				});
				expect(run.status).toBe(0);
				expect(run.stdout.trim().split(" ").sort()).toEqual([
					"create-marker:denied",
					"delete-marker:denied",
					"delete-own-temp:ok",
					"touch-marker:denied",
				]);
			} finally {
				rmSync(uidRoot, { recursive: true, force: true });
			}
		},
	);

	afterAll(() => {
		for (const p of [root, procRoot])
			rmSync(p, { recursive: true, force: true });
	});
});
