// omp stats dashboard mirror: `omp stats` reads exactly one sessions dir
// (`<agent dir>/sessions/<folder>/<file>.jsonl`) and skips symlinks, so the board copies every
// transcript it knows into one private tree the dashboard child reads. Transcripts only grow,
// so a refresh appends the new tail instead of copying the whole file again.
// Spec: docs/specs/omp-stats-dashboard.md ("Session transcripts").
import { constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { errmsg } from "./errmsg.ts";

/** One transcript source. `folder` null = a store: each subfolder of `dir` maps to the mirror
 *  folder of the same name. A string = a flat project dir mirrored into that folder. */
export interface MirrorSource {
	dir: string;
	folder: string | null;
}

/** What one mirror run did: files written (full copies + appends) and per-file errors. */
export interface MirrorResult {
	written: number;
	errors: string[];
}

/** Chunk size for copies: transcripts can reach many MB, never hold one whole in memory. */
const CHUNK = 1 << 20;

/** omp's in-progress compaction dirs: half-written copies, never real transcripts. */
const GC_PREFIX = ".omp-gc-compress-";

/** Not on Windows: there `open` cannot refuse a symlink, the Dirent check still does. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The mirror folder of a flat project dir; omp shows `--ottr--<name>` as `/ottr/<name>`. */
export function mirrorFolderName(project: string): string {
	return `--ottr--${project.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

/** A dir entry the walk never enters or copies. */
function skipped(name: string): boolean {
	return name === "." || name === ".." || name.startsWith(GC_PREFIX);
}

function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Copies source bytes [from, to) to the same offsets of `dst`. Stops early when the source
 *  shrank under us (a short read of 0): the next refresh sees the new size. */
async function copyRange(
	src: FileHandle,
	dst: FileHandle,
	from: number,
	to: number,
): Promise<void> {
	const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, to - from)));
	let pos = from;
	while (pos < to) {
		const { bytesRead } = await src.read(
			buf,
			0,
			Math.min(buf.length, to - pos),
			pos,
		);
		if (bytesRead === 0) return;
		let off = 0;
		while (off < bytesRead) {
			const { bytesWritten } = await dst.write(
				buf,
				off,
				bytesRead - off,
				pos + off,
			);
			off += bytesWritten;
		}
		pos += bytesRead;
	}
}

/** Mirrors one transcript by the copy rule; true when it wrote. The source opens with
 *  O_NOFOLLOW and must still be a regular file: a worker that swaps the file for a symlink
 *  after the dir listing cannot make the board copy a file outside the session dirs. */
async function mirrorFile(
	srcPath: string,
	dstDir: string,
	name: string,
): Promise<boolean> {
	const src = await open(srcPath, constants.O_RDONLY | NOFOLLOW);
	try {
		const st = await src.stat();
		if (!st.isFile()) return false;
		const dstPath = join(dstDir, name);
		let dstSize = -1;
		try {
			dstSize = (await lstat(dstPath)).size;
		} catch (err) {
			if (!isMissing(err)) throw err;
		}
		if (dstSize === st.size) return false;
		const append = dstSize >= 0 && dstSize < st.size;
		if (!append) await mkdir(dstDir, { recursive: true, mode: 0o700 });
		const dst = await open(dstPath, append ? "r+" : "w", 0o600);
		try {
			await copyRange(src, dst, append ? dstSize : 0, st.size);
		} finally {
			await dst.close();
		}
		return true;
	} finally {
		await src.close();
	}
}

/** Walks `srcDir` recursively into `dstDir`: subdirs keep their relative path, regular
 *  `.jsonl` files are mirrored, everything else (symlinks, sockets, other files) is skipped. */
async function mirrorTree(
	srcDir: string,
	dstDir: string,
	result: MirrorResult,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(srcDir, { withFileTypes: true });
	} catch (err) {
		if (!isMissing(err)) result.errors.push(`${srcDir}: ${errmsg(err)}`);
		return;
	}
	for (const entry of entries) {
		if (skipped(entry.name)) continue;
		const srcPath = join(srcDir, entry.name);
		if (entry.isDirectory()) {
			await mirrorTree(srcPath, join(dstDir, entry.name), result);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		try {
			if (await mirrorFile(srcPath, dstDir, entry.name)) result.written++;
		} catch (err) {
			result.errors.push(`${srcPath}: ${errmsg(err)}`);
		}
	}
}

/** Brings the mirror at `target` up to date with every source. Never deletes: a transcript
 *  that a source removed stays in the mirror. A missing source dir is skipped silently; a
 *  failing file is recorded in `errors` and the walk goes on. */
export async function mirrorSessions(
	target: string,
	sources: readonly MirrorSource[],
): Promise<MirrorResult> {
	const result: MirrorResult = { written: 0, errors: [] };
	for (const source of sources) {
		if (source.folder !== null) {
			await mirrorTree(source.dir, join(target, source.folder), result);
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(source.dir, { withFileTypes: true });
		} catch (err) {
			if (!isMissing(err)) result.errors.push(`${source.dir}: ${errmsg(err)}`);
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !skipped(entry.name)) {
				await mirrorTree(
					join(source.dir, entry.name),
					join(target, entry.name),
					result,
				);
			}
		}
	}
	return result;
}
