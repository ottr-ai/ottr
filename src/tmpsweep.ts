import {
	lstatSync,
	readdirSync,
	readlinkSync,
	rmSync,
	type Stats,
	statfsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGE_MS = 24 * 60 * 60 * 1000;

export interface SweptTmpEntry {
	name: string;
	bytes: number;
}

export interface TmpDiskSpace {
	freeBytes: number;
	totalBytes: number;
}

// OTTR-754: self-reported /tmp space for the board's disk gate. null when statfs fails.
export function tmpDiskSpace(path: string = "/tmp"): TmpDiskSpace | null {
	try {
		const s = statfsSync(path);
		return { freeBytes: s.bavail * s.frsize, totalBytes: s.blocks * s.frsize };
	} catch {
		return null;
	}
}

/** Human units B..PiB, one decimal below 100, no deps: 536870912 -> "512 MiB". */
export function formatBytes(n: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
	let v = n;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	const shown = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
	return `${shown} ${units[u]}`;
}

/** Newest mtime inside the entry, recursive over lstat (never follows symlinks).
 * A plain file or symlink entry counts with its own mtime; null when unreadable. */
function newestMtime(entryPath: string): number | null {
	let st: Stats;
	try {
		st = lstatSync(entryPath);
	} catch {
		return null;
	}
	let newest: number | null = st.mtimeMs;
	if (!st.isDirectory()) return newest;
	let entries: string[];
	try {
		entries = readdirSync(entryPath);
	} catch {
		return newest;
	}
	for (const name of entries) {
		const p = join(entryPath, name);
		let inner: Stats;
		try {
			inner = lstatSync(p);
		} catch {
			continue; // vanished mid-walk
		}
		const nested = inner.isDirectory() ? newestMtime(p) : inner.mtimeMs;
		if (nested !== null && nested > newest) newest = nested;
	}
	return newest;
}

// OTTR-754: paths a live process holds open via /proc, read-only — the sweep never signals.
function liveHeldPaths(procRoot: string): Set<string> {
	const held = new Set<string>();
	let pids: string[];
	try {
		pids = readdirSync(procRoot);
	} catch {
		return held;
	}
	for (const name of pids) {
		if (!/^\d+$/.test(name)) continue;
		collectFdLinks(join(procRoot, name), held);
		collectCwdLink(join(procRoot, name), held);
	}
	return held;
}

/** The readlink targets of one pid's open fds; unreadable fd dir: skip silently. */
function collectFdLinks(pidDir: string, held: Set<string>): void {
	let fds: string[];
	try {
		fds = readdirSync(join(pidDir, "fd"));
	} catch {
		return;
	}
	for (const fd of fds) {
		const target = readDeletedLink(join(pidDir, "fd", fd));
		if (target !== null) held.add(target);
	}
}

/** One pid's cwd readlink target; unreadable cwd: skip silently. */
function collectCwdLink(pidDir: string, held: Set<string>): void {
	const target = readDeletedLink(join(pidDir, "cwd"));
	if (target !== null) held.add(target);
}

/** A readlink target with the kernel's " (deleted)" marker stripped; null when unreadable. */
function readDeletedLink(link: string): string | null {
	const DELETED = " (deleted)";
	try {
		let target = readlinkSync(link);
		if (target.endsWith(DELETED)) target = target.slice(0, -DELETED.length);
		return target;
	} catch {
		return null;
	}
}

/**
 * OTTR-754: uniform rule for every top-level entry of root (no prefix list — prefixed
 * entries are just entries). Removes an entry only when its newest inner mtime is at
 * least AGE_MS old, no live process holds a link into it, and no live turn of this
 * worker started at or before that mtime. Returns what was removed with its byte sum.
 */
export function sweepTmpDirs(
	root: string = tmpdir(),
	opts?: { procRoot?: string; liveTurnStarts?: readonly number[] },
): SweptTmpEntry[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const held = [...liveHeldPaths(opts?.procRoot ?? "/proc")];
	const starts = opts?.liveTurnStarts ?? [];
	const swept: SweptTmpEntry[] = [];
	for (const name of entries) {
		if (name === "." || name === "..") continue;
		try {
			const sweptEntry = sweepEntry(root, name, held, starts);
			if (sweptEntry !== null) swept.push(sweptEntry);
		} catch {
			// Busy or vanished entry: leave it for the next sweep.
		}
	}
	return swept;
}

/** The sweep decision for one top-level entry; null when it stays. rmSync runs here. */
function sweepEntry(
	root: string,
	name: string,
	held: readonly string[],
	starts: readonly number[],
): SweptTmpEntry | null {
	const entryPath = join(root, name);
	const newest = newestMtime(entryPath);
	if (newest === null || Date.now() - newest < AGE_MS) return null;
	if (starts.some((start) => start <= newest)) return null;
	if (held.some((h) => h === entryPath || h.startsWith(`${entryPath}/`)))
		return null;
	const bytes = sumFileBytes(entryPath);
	rmSync(entryPath, { recursive: true, force: true });
	return { name, bytes };
}

/** Sum of lstat sizes of all regular files under the entry (walk before deleting). */
function sumFileBytes(entryPath: string): number {
	let bytes = 0;
	let st: Stats;
	try {
		st = lstatSync(entryPath);
	} catch {
		return 0;
	}
	if (st.isFile()) return st.size;
	let entries: string[];
	try {
		entries = readdirSync(entryPath);
	} catch {
		return 0;
	}
	for (const name of entries) {
		const p = join(entryPath, name);
		try {
			const s = lstatSync(p);
			if (s.isFile()) bytes += s.size;
			else if (s.isDirectory()) bytes += sumFileBytes(p);
		} catch {
			// vanished mid-walk
		}
	}
	return bytes;
}
