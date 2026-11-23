import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	rmSync,
	type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatBytes, liveHeldPaths, sumFileBytes } from "./tmpsweep.ts";
import {
	assertProjectSegment,
	chownTree,
	type TurnIdentity,
} from "./turnUid.ts";

/** OTTR-1211: a cache entry a card has not read for this long is dead. */
export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** OTTR-1211: one project's cache root evicts oldest-first beyond this size. */
export const CACHE_ROOT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** The server's per-project cache root for its own (worker-less) runs. Tests point
 * OTTR_TURN_CACHE_ROOT at a fixture dir, like OTTR_TURN_HOMES on the worker. */
export function serverTurnCacheRoot(): string {
	return (
		process.env.OTTR_TURN_CACHE_ROOT || join(homedir(), ".cache", "ottr-turns")
	);
}

export interface TurnCacheDirs {
	/** The five cache env values, all subdirs of `<root>/<project>/cache`. */
	cacheEnv: Record<string, string>;
	/** `<root>/<project>/tmp`: the parent of the per-card scratch dirs. */
	tmp: string;
}

const CACHE_SUBDIRS = ["xdg", "bun", "pip", "uv", "npm"] as const;

/**
 * OTTR-1211: `<root>/<project>/cache` with one subdir per tool family, plus the
 * project's per-card scratch parent. All cards of the project share the cache; two
 * projects never do. The subdirs and the cache dir belong to the project uid when
 * the daemon runs isolated (`ids`), else to the daemon user. Best effort: null on
 * any failure or a missing project — the caller keeps the default env rather than
 * failing the run.
 */
export function prepareTurnCache(
	root: string,
	project: string | undefined,
	ids: TurnIdentity | null,
): TurnCacheDirs | null {
	if (typeof project !== "string" || project === "") return null;
	try {
		assertProjectSegment(project);
		const dir = join(root, project);
		const cache = join(dir, "cache");
		for (const sub of CACHE_SUBDIRS)
			mkdirSync(join(cache, sub), { recursive: true });
		const tmp = join(dir, "tmp");
		mkdirSync(tmp, { recursive: true });
		// The project level stays root-owned like the rest of the turn home, so a
		// turn uid can never rename or swap the dirs the daemon chowns and sweeps.
		chmodSync(dir, 0o755);
		chmodSync(cache, 0o755);
		chmodSync(tmp, 0o755);
		if (ids !== null) chownTree(cache, ids);
		return {
			cacheEnv: {
				XDG_CACHE_HOME: join(cache, "xdg"),
				BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
				PIP_CACHE_DIR: join(cache, "pip"),
				UV_CACHE_DIR: join(cache, "uv"),
				npm_config_cache: join(cache, "npm"),
			},
			tmp,
		};
	} catch {
		return null;
	}
}

/** OTTR-1211: the cache sweep's cadence: at boot and once a day, in each worker
 * and the server. The /tmp safety net stays hourly. */
export const CACHE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The project dirs under parent whose `<project>/<leaf>` exists; the sweepers'
 * input. An unreadable parent yields nothing. */
export function projectSubDirs(parent: string, leaf: string): string[] {
	let projects: string[];
	try {
		projects = readdirSync(parent);
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const name of projects) {
		const dir = join(parent, name, leaf);
		if (existsSync(dir)) dirs.push(dir);
	}
	return dirs;
}

/** The project dirs under parent whose cache root exists; the sweepers' input. */
export function projectCacheRoots(parent: string): string[] {
	return projectSubDirs(parent, "cache");
}

export interface SweptCacheRoot {
	root: string;
	freedBytes: number;
	ttlRemoved: number;
	evicted: number;
}

/** Newest atime of any regular file inside the entry, recursive over lstat (never
 * reads content, so file atimes stay honest). Directory atimes are ignored on
 * purpose: the sweep's own readdir refreshes them under relatime, so they can
 * never age. A file with an unreadable (epoch) atime falls back to its mtime;
 * an entry with no readable freshness returns null and stays. */
function freshAt(entryPath: string): number | null {
	let st: Stats;
	try {
		st = lstatSync(entryPath);
	} catch {
		return null;
	}
	if (!st.isDirectory()) return st.atimeMs > 0 ? st.atimeMs : st.mtimeMs;
	let newest: number | null = null;
	let entries: string[];
	try {
		entries = readdirSync(entryPath);
	} catch {
		return null;
	}
	for (const name of entries) {
		const nested = freshAt(join(entryPath, name));
		if (nested !== null && (newest === null || nested > newest))
			newest = nested;
	}
	return newest;
}

/** The sweep decision for one cache entry; true when it goes. rmSync runs here. */
function evictCacheEntry(entryPath: string, held: readonly string[]): boolean {
	if (held.some((h) => h === entryPath || h.startsWith(`${entryPath}/`)))
		return false;
	rmSync(entryPath, { recursive: true, force: true });
	return true;
}

/**
 * OTTR-1211: one sweep pass over one project's cache root. First the TTL pass
 * (entries unused for CACHE_TTL_MS go), then the cap pass (oldest freshness first,
 * until the root fits CACHE_ROOT_MAX_BYTES). Live-process holds survive both passes.
 * A per-entry failure skips the entry for the next sweep.
 */
export function sweepCacheRoot(
	root: string,
	opts?: {
		procRoot?: string;
		now?: number;
		ttlMs?: number;
		maxBytes?: number;
	},
): SweptCacheRoot {
	const freed: SweptCacheRoot = {
		root,
		freedBytes: 0,
		ttlRemoved: 0,
		evicted: 0,
	};
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return freed;
	}
	const held = [...liveHeldPaths(opts?.procRoot ?? "/proc")];
	const now = opts?.now ?? Date.now();
	const ttl = opts?.ttlMs ?? CACHE_TTL_MS;
	const max = opts?.maxBytes ?? CACHE_ROOT_MAX_BYTES;
	const fresh = new Map<string, number | null>();
	for (const name of entries) {
		const entryPath = join(root, name);
		fresh.set(name, freshAt(entryPath));
	}
	// TTL pass.
	for (const name of entries) {
		const at = fresh.get(name);
		if (at === undefined || at === null) continue;
		if (now - at < ttl) continue;
		const bytes = sumFileBytes(join(root, name));
		if (!evictCacheEntry(join(root, name), held)) continue;
		freed.freedBytes += bytes;
		freed.ttlRemoved++;
	}
	// Cap pass: evict oldest freshness first until the root fits.
	const remaining = entries.filter((name) => existsSync(join(root, name)));
	let total = sumFileBytes(root);
	while (total > max) {
		let oldest: string | null = null;
		let oldestAt = Infinity;
		for (const name of remaining) {
			if (!existsSync(join(root, name))) continue;
			const at = fresh.get(name) ?? null;
			const rank = at ?? Infinity; // unreadable freshness evicts last
			if (rank < oldestAt) {
				oldestAt = rank;
				oldest = name;
			}
		}
		if (oldest === null) break;
		const bytes = sumFileBytes(join(root, oldest));
		if (!evictCacheEntry(join(root, oldest), held)) {
			remaining.splice(remaining.indexOf(oldest), 1);
			continue; // held: try the next oldest on the next loop
		}
		remaining.splice(remaining.indexOf(oldest), 1);
		total -= bytes;
		freed.freedBytes += bytes;
		freed.evicted++;
	}
	return freed;
}

/** One sweep pass over every root, logging each run's freed size. */
export function sweepCacheRootsLog(
	roots: readonly string[],
	opts?: {
		procRoot?: string;
		now?: number;
		ttlMs?: number;
		maxBytes?: number;
	},
): SweptCacheRoot[] {
	const swept: SweptCacheRoot[] = [];
	for (const root of roots) {
		const result = sweepCacheRoot(root, opts);
		swept.push(result);
		console.log(
			`cache-sweep: ${result.root} freed ${formatBytes(result.freedBytes)} (${result.ttlRemoved} aged, ${result.evicted} evicted)`,
		);
	}
	return swept;
}
