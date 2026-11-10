import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBytes, sweepTmpDirs } from "./tmpsweep.ts";

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
