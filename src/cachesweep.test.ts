import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	CACHE_TTL_MS,
	prepareTurnCache,
	projectCacheRoots,
	projectSubDirs,
	serverTurnCacheRoot,
	sweepCacheRoot,
	sweepCacheRootsLog,
} from "./cachesweep.ts";

const DAY = 24 * 60 * 60 * 1000;

/** One top-level cache entry with a file whose atime is ageMs old (an entry
 * untouched for that long has stale atime and mtime alike; the sweeper's lstat
 * never refreshes either). The dir's own times stay fresh: the sweeper's
 * readdir would refresh them under relatime, so only file atimes may decide. */
function entry(
	root: string,
	name: string,
	size: number,
	ageMs: number,
): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "blob.bin");
	writeFileSync(file, "x".repeat(size));
	const t = (Date.now() - ageMs) / 1000;
	utimesSync(file, t, t);
	// The dir's own times stay fresh: the sweeper's readdir would refresh them
	// under relatime, so only file atimes may decide.
	return dir;
}

describe("sweepCacheRoot", () => {
	test("TTL removes entries unused for 14 days, keeps fresh ones", () => {
		const root = mkdtempSync(join(tmpdir(), "cachesweep-"));
		try {
			entry(root, "stale", 10, CACHE_TTL_MS + DAY);
			entry(root, "fresh", 10, DAY);
			// A dir whose own atime is fresh but whose files are stale: the relatime
			// trap — directory atimes must not decide.
			const dirOnly = entry(root, "stale-files", 10, CACHE_TTL_MS + DAY);
			utimesSync(dirOnly, new Date(), new Date());
			const result = sweepCacheRoot(root, { procRoot: join(root, "no-proc") });
			expect(result.ttlRemoved).toBe(2);
			expect(result.evicted).toBe(0);
			expect(existsSync(join(root, "stale"))).toBe(false);
			expect(existsSync(join(root, "stale-files"))).toBe(false);
			expect(existsSync(join(root, "fresh"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("cap evicts oldest freshness first until the root fits", () => {
		const root = mkdtempSync(join(tmpdir(), "cachesweep-cap-"));
		try {
			entry(root, "oldest", 60, 12 * DAY);
			entry(root, "young", 60, 5 * DAY);
			entry(root, "middle", 30, 10 * DAY);
			// All fresh for the TTL; only the cap decides, oldest atime first.
			const result = sweepCacheRoot(root, {
				procRoot: join(root, "no-proc"),
				maxBytes: 100,
			});
			expect(result.ttlRemoved).toBe(0);
			expect(result.evicted).toBe(1);
			expect(result.freedBytes).toBe(60);
			expect(existsSync(join(root, "oldest"))).toBe(false);
			expect(existsSync(join(root, "young"))).toBe(true);
			expect(existsSync(join(root, "middle"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a live-held entry survives both the TTL and the cap pass", () => {
		const root = mkdtempSync(join(tmpdir(), "cachesweep-held-"));
		const procRoot = mkdtempSync(join(tmpdir(), "cachesweep-proc-"));
		try {
			entry(root, "held", 60, CACHE_TTL_MS + DAY);
			entry(root, "spare", 60, CACHE_TTL_MS + DAY);
			const pid = join(procRoot, "4711");
			mkdirSync(join(pid, "fd"), { recursive: true });
			symlinkSync(`${join(root, "held")}/blob.bin`, join(pid, "fd", "3"));
			const result = sweepCacheRoot(root, {
				procRoot,
				maxBytes: 10, // force the cap pass over everything left
			});
			expect(existsSync(join(root, "held"))).toBe(true);
			expect(existsSync(join(root, "spare"))).toBe(false);
			expect(result.ttlRemoved).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(procRoot, { recursive: true, force: true });
		}
	});
});

describe("sweepCacheRootsLog", () => {
	test("logs one line per root with the freed size", () => {
		const root = mkdtempSync(join(tmpdir(), "cachesweep-log-"));
		try {
			entry(root, "gone", 4, CACHE_TTL_MS + DAY);
			const lines: string[] = [];
			const realLog = console.log;
			console.log = (msg: unknown) => lines.push(String(msg));
			let swept: { freedBytes: number }[];
			try {
				swept = sweepCacheRootsLog([root], { procRoot: join(root, "no-proc") });
			} finally {
				console.log = realLog;
			}
			expect(swept[0]!.freedBytes).toBe(4);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(
				`cache-sweep: ${root} freed 4 B (1 aged, 0 evicted)`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("prepareTurnCache", () => {
	test("one cache per project with the five tool subdirs, plus the scratch parent", () => {
		const root = mkdtempSync(join(tmpdir(), "cacheprep-"));
		try {
			const dirs = prepareTurnCache(root, "proj.one-x", null);
			expect(dirs).not.toBeNull();
			expect(dirs!.cacheEnv.XDG_CACHE_HOME).toBe(
				join(root, "proj.one-x", "cache", "xdg"),
			);
			expect(dirs!.cacheEnv.BUN_INSTALL_CACHE_DIR).toBe(
				join(root, "proj.one-x", "cache", "bun"),
			);
			expect(dirs!.cacheEnv.PIP_CACHE_DIR).toBe(
				join(root, "proj.one-x", "cache", "pip"),
			);
			expect(dirs!.cacheEnv.UV_CACHE_DIR).toBe(
				join(root, "proj.one-x", "cache", "uv"),
			);
			expect(dirs!.cacheEnv.npm_config_cache).toBe(
				join(root, "proj.one-x", "cache", "npm"),
			);
			for (const sub of ["xdg", "bun", "pip", "uv", "npm"])
				expect(existsSync(join(root, "proj.one-x", "cache", sub))).toBe(true);
			expect(existsSync(join(root, "proj.one-x", "tmp"))).toBe(true);
			// The second call is the same project, later in time: the same dirs.
			const again = prepareTurnCache(root, "proj.one-x", null);
			expect(again!.cacheEnv).toEqual(dirs!.cacheEnv);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no project or a path-escaping name yields null, creating nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "cacheprep-bad-"));
		try {
			expect(prepareTurnCache(root, undefined, null)).toBeNull();
			expect(prepareTurnCache(root, "", null)).toBeNull();
			expect(prepareTurnCache(root, "../evil", null)).toBeNull();
			expect(prepareTurnCache(root, "a/b", null)).toBeNull();
			expect(existsSync(join(root, "evil"))).toBe(false);
			expect(existsSync(join(root, "a"))).toBe(false);
			expect(projectCacheRoots(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("project roots", () => {
	test("projectSubDirs and projectCacheRoots read only existing leaves", () => {
		const parent = mkdtempSync(join(tmpdir(), "cacheprojects-"));
		try {
			mkdirSync(join(parent, "alpha", "cache", "bun"), { recursive: true });
			mkdirSync(join(parent, "beta", "tmp"), { recursive: true });
			expect(projectCacheRoots(parent)).toEqual([
				join(parent, "alpha", "cache"),
			]);
			expect(projectSubDirs(parent, "tmp")).toEqual([
				join(parent, "beta", "tmp"),
			]);
			expect(projectCacheRoots(join(parent, "missing"))).toEqual([]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("serverTurnCacheRoot defaults to the home cache; the env overrides", () => {
		expect(serverTurnCacheRoot()).toBe(join(homedir(), ".cache", "ottr-turns"));
		const saved = process.env.OTTR_TURN_CACHE_ROOT;
		try {
			process.env.OTTR_TURN_CACHE_ROOT = "/fixtures/cacheroot";
			expect(serverTurnCacheRoot()).toBe("/fixtures/cacheroot");
		} finally {
			if (saved === undefined) delete process.env.OTTR_TURN_CACHE_ROOT;
			else process.env.OTTR_TURN_CACHE_ROOT = saved;
		}
	});
});
