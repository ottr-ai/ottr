import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	futimesSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
	basename,
	delimiter,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

/*
 * Server-side file operations below a directory that a lower-trust worker can also write.
 * In compose, every worker mounts the task data volume (OTTR_DATA_DIR) and the workspace
 * read-write, so a turn can plant a symlink at any path component there; a plain write
 * follows it into the board's own filesystem (OTTR-172). These helpers walk from a trusted
 * anchor one component at a time with O_NOFOLLOW, through /proc/self/fd, so no symlink
 * below the anchor is followed — the entry itself included — and no lstat-then-write race
 * remains. The anchor and its parents are trusted: pass a path no worker can replace (a
 * mount point such as OTTR_DATA_DIR, a project checkout outside compose, or a directory
 * the caller just opened).
 *
 * Linux only: the compose server always runs there. Without /proc/self/fd (Windows and
 * macOS hosts) the helpers fall back to plain path operations with no symlink guard;
 * those hosts share no volume with lower-trust workers.
 */

const FD_DIR = "/proc/self/fd";
const guarded = process.platform === "linux" && existsSync(FD_DIR);

const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// A FIFO planted as a "file" would block a plain read open until a writer appears.
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } =
	constants;

export type WriteMode = "truncate" | "exclusive" | "append";
const FLAGS: Record<WriteMode, number> = {
	truncate: O_WRONLY | O_CREAT | O_TRUNC,
	// "exclusive" is read-write so a caller can read the fresh copy back through the held fd.
	exclusive: O_RDWR | O_CREAT | O_EXCL,
	append: O_WRONLY | O_CREAT | O_APPEND,
};

/** A directory opened below an anchor. */
export interface Dir {
	/** The lexical path, for messages only. */
	readonly path: string;
	/** The held descriptor on guarded hosts (Linux with /proc/self/fd); undefined in the unguarded fallback. Internal, for openBelow. */
	readonly fd?: number;
	/** A path that names `name` in this directory without re-resolving any parent. */
	at(name: string): string;
	/** Entry names, like readdirSync. */
	list(): string[];
	close(): void;
}

function errCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException).code;
}

function inside(anchor: string, target: string): boolean {
	const rel = relative(resolve(anchor), resolve(target));
	return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** The path components from anchor down to target; throws when target is not below anchor. */
function parts(anchor: string, target: string): string[] {
	if (!inside(anchor, target))
		throw new Error(`${target} is outside ${anchor}`);
	const rel = relative(resolve(anchor), resolve(target));
	return rel === "" ? [] : rel.split(sep);
}

/**
 * The trusted anchor for path `p` on a shared volume: the OMP_TRACKER_ROOTS entry that holds
 * it (in compose the /workspace mount, which no worker can replace), so the walk also refuses
 * a project checkout that a worker swapped for a symlink. `p` itself when no root holds it.
 */
export function trustedAnchor(p: string): string {
	for (const root of (process.env.OMP_TRACKER_ROOTS ?? "").split(delimiter)) {
		const r = root.trim();
		if (r !== "" && inside(r, p)) return resolve(r);
	}
	return p;
}

function entryName(name: string): string {
	if (name === "" || name === "." || name === ".." || /[\\/]/.test(name))
		throw new Error(`invalid entry name: ${JSON.stringify(name)}`);
	return name;
}

/**
 * One walk step: opens directory `name` inside the directory `fd` without following a
 * symlink there (making it first when `create`); `path` names it in the error.
 */
function openChild(
	fd: number,
	name: string,
	path: string,
	create: boolean,
): number {
	const p = `${FD_DIR}/${fd}/${name}`;
	if (create) {
		try {
			mkdirSync(p);
		} catch (err) {
			if (errCode(err) !== "EEXIST") throw err;
		}
	}
	try {
		return openSync(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	} catch (err) {
		const code = errCode(err);
		if (code === "ELOOP" || code === "ENOTDIR")
			throw new Error(`refusing ${path}: a symlink or not a directory`);
		throw err;
	}
}

/** The Dir on the held descriptor of the guarded walk; at and list resolve through /proc/self/fd. */
function heldDir(fd: number, path: string): Dir {
	let open = true;
	return {
		path,
		fd,
		at: (name) => `${FD_DIR}/${fd}/${entryName(name)}`,
		list: () => readdirSync(`${FD_DIR}/${fd}`),
		close: () => {
			if (open) closeSync(fd);
			open = false;
		},
	};
}

/**
 * Opens `dir` below `anchor` without following any symlink under the anchor; `create`
 * makes the missing components (and the anchor). Throws "refusing <path>" when a component
 * is a symlink or a file. Close the result.
 */
export function openDir(
	anchor: string,
	dir: string,
	opts: { create?: boolean } = {},
): Dir {
	const names = parts(anchor, dir);
	if (!guarded) {
		if (opts.create) mkdirSync(dir, { recursive: true });
		return {
			path: dir,
			at: (name) => join(dir, entryName(name)),
			list: () => readdirSync(dir),
			close: () => {},
		};
	}
	if (opts.create) mkdirSync(anchor, { recursive: true });
	let fd = openSync(anchor, O_RDONLY | O_DIRECTORY);
	let cur = resolve(anchor);
	try {
		for (const name of names) {
			cur = join(cur, name);
			const next = openChild(fd, name, cur, opts.create === true);
			closeSync(fd);
			fd = next;
		}
	} catch (err) {
		closeSync(fd);
		throw err;
	}
	return heldDir(fd, cur);
}

/** Runs `fn` with `dir` opened below `anchor`, then closes it. */
export function withDir<T>(
	anchor: string,
	dir: string,
	opts: { create?: boolean },
	fn: (d: Dir) => T,
): T {
	const d = openDir(anchor, dir, opts);
	try {
		return fn(d);
	} finally {
		d.close();
	}
}

/**
 * Opens the child directory `name` inside the held dir `d`, following no symlink there
 * (same refusals as openDir). Close the result. A caller that keeps the parent open
 * descends at one open per level instead of reopening every component from the anchor.
 */
export function openBelow(d: Dir, name: string): Dir {
	const n = entryName(name);
	const child = join(d.path, n);
	if (!guarded || d.fd === undefined) {
		return {
			path: child,
			at: (c) => join(child, entryName(c)),
			list: () => readdirSync(child),
			close: () => {},
		};
	}
	return heldDir(openChild(d.fd, n, child, false), child);
}

/**
 * Bounded iteration over the entry names of the held dir `d`: each `next()` reads one
 * entry through a small kernel buffer (opendirSync), so a huge directory never
 * materializes its whole name list at once. Close the result when done.
 */
export function scanDir(
	d: Dir,
	bufferSize = 512,
): { next(): string | null; close(): void } {
	const handle = opendirSync(
		guarded && d.fd !== undefined ? `${FD_DIR}/${d.fd}` : d.path,
		{ bufferSize },
	);
	return {
		next: () => handle.readSync()?.name ?? null,
		close: () => handle.closeSync(),
	};
}

/**
 * Opens an entry for writing; a symlink there fails ("refusing"), it is never followed.
 * O_NONBLOCK keeps a planted FIFO from blocking the board's thread (ENXIO without a reader),
 * and anything but a regular file fails with "refusing".
 */
function openEntry(path: string, label: string, mode: WriteMode, perm = 0o666) {
	let fd: number;
	try {
		fd = openSync(path, FLAGS[mode] | O_NOFOLLOW | O_NONBLOCK, perm);
	} catch (err) {
		const code = errCode(err);
		if (code === "ELOOP") throw new Error(`refusing ${label}: a symlink`);
		if (code === "ENXIO") throw new Error(`refusing ${label}: a FIFO`);
		throw err;
	}
	return regularOrClose(fd, label);
}

function regularOrClose(fd: number, label: string): number {
	try {
		if (!fstatSync(fd).isFile())
			throw new Error(`refusing ${label}: not a regular file`);
	} catch (err) {
		closeSync(fd);
		throw err;
	}
	return fd;
}

/**
 * Opens `path` for reading without blocking on a FIFO a worker planted there; anything but
 * a regular file fails with "refusing". Close the result.
 */
export function openRegular(path: string): number {
	return regularOrClose(openSync(path, O_RDONLY | O_NONBLOCK), path);
}

/** A task log can be large; the board never reads a worker-written log whole without bound. */
export const TASK_LOG_MAX_BYTES = 64 * 1024 * 1024;

/** Marks the "larger than N bytes" refusals, so callers can match them without message parsing. */
interface SizeRefusal extends Error {
	sizeRefusal: true;
}

function sizeRefusal(label: string, maxBytes: number): SizeRefusal {
	const err = new Error(
		`refusing ${label}: larger than ${maxBytes} bytes`,
	) as SizeRefusal;
	err.sizeRefusal = true;
	return err;
}

/** True only for the "larger than N bytes" refusals of the bounded readers. */
export function isSizeRefusal(err: unknown): boolean {
	return (
		err instanceof Error && (err as Partial<SizeRefusal>).sizeRefusal === true
	);
}

/** The bounded sync read on an open descriptor: refuses non-regular and over-cap files, and
 * a file that grows while read; never reads unbounded. */
function readBoundedSync(fd: number, label: string, maxBytes: number): Buffer {
	const st = fstatSync(fd);
	if (!st.isFile()) throw new Error(`refusing ${label}: not a regular file`);
	if (st.size > maxBytes) throw sizeRefusal(label, maxBytes);
	// One spare byte catches a file that grew after fstat.
	const buf = Buffer.allocUnsafe(st.size + 1);
	let n = 0;
	while (n < buf.length) {
		const r = readSync(fd, buf, n, buf.length - n, null);
		if (r === 0) break;
		n += r;
	}
	if (n > st.size) throw new Error(`refusing ${label}: it grew while read`);
	return buf.subarray(0, n);
}

/** readFileSync for a path on a worker-writable volume: openRegular's refusals apply, and
 * `maxBytes` refuses an oversized file before any read (worker-writable volumes must not
 * be read whole). */
export function readRegular(path: string, maxBytes: number): Buffer {
	const fd = openRegular(path);
	try {
		return readBoundedSync(fd, path, maxBytes);
	} finally {
		closeSync(fd);
	}
}

/**
 * Bounded async read for a path on a worker-writable volume: opens once with O_NOFOLLOW,
 * refuses a symlink ("refusing <path>: a symlink"), a non-regular file, a file over
 * `maxBytes`, and a file that grew while read. Never reads unbounded.
 */
export async function readBoundedFile(
	path: string,
	maxBytes: number,
): Promise<Buffer> {
	let handle: fsPromises.FileHandle;
	try {
		handle = await fsPromises.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if (errCode(err) === "ELOOP")
			throw new Error(`refusing ${path}: a symlink`);
		throw err;
	}
	try {
		const st = await handle.stat();
		if (!st.isFile()) throw new Error(`refusing ${path}: not a regular file`);
		if (st.size > maxBytes) throw sizeRefusal(path, maxBytes);
		// One spare byte catches a file that grew after stat.
		const buf = Buffer.allocUnsafe(st.size + 1);
		let n = 0;
		while (n < buf.length) {
			const { bytesRead } = await handle.read(buf, n, buf.length - n, null);
			if (bytesRead === 0) break;
			n += bytesRead;
		}
		if (n > st.size) throw new Error(`refusing ${path}: it grew while read`);
		return buf.subarray(0, n);
	} finally {
		await handle.close();
	}
}

/**
 * Bounded async read of the tail [from, size) of a path on a worker-writable volume:
 * opens once with O_NOFOLLOW, refuses a symlink ("refusing <path>: a symlink"), a
 * non-regular file, and a tail over `maxBytes`. A file that ends at or before `from`
 * answers an empty buffer (nothing new to read); a file that grows while read fails
 * with "grew while read". Never reads unbounded.
 */
export async function readTailBounded(
	path: string,
	from: number,
	maxBytes: number,
): Promise<Buffer> {
	let handle: fsPromises.FileHandle;
	try {
		handle = await fsPromises.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if (errCode(err) === "ELOOP")
			throw new Error(`refusing ${path}: a symlink`);
		throw err;
	}
	try {
		const st = await handle.stat();
		if (!st.isFile()) throw new Error(`refusing ${path}: not a regular file`);
		if (st.size <= from) return Buffer.alloc(0);
		const len = st.size - from;
		if (len > maxBytes) throw sizeRefusal(path, maxBytes);
		// One spare byte catches a file that grew after stat.
		const buf = Buffer.allocUnsafe(len + 1);
		let n = 0;
		while (n < buf.length) {
			const { bytesRead } = await handle.read(buf, n, buf.length - n, from + n);
			if (bytesRead === 0) break;
			n += bytesRead;
		}
		if (n > len) throw new Error(`refusing ${path}: it grew while read`);
		return buf.subarray(0, n);
	} finally {
		await handle.close();
	}
}

/** mkdir -p for `dir` below `anchor`, following no symlink under the anchor. */
export function mkdirBelow(anchor: string, dir: string): void {
	openDir(anchor, dir, { create: true }).close();
}

/**
 * Writes `file` below `anchor`, creating its parents. "exclusive" fails with EEXIST on an
 * existing entry, "append" adds to the end. A symlink at the file or at any parent below
 * the anchor fails the write with "refusing <path>".
 */
export function writeBelow(
	anchor: string,
	file: string,
	data: string | Uint8Array,
	mode: WriteMode = "truncate",
): void {
	withDir(anchor, dirname(file), { create: true }, (d) => {
		const fd = openEntry(d.at(basename(file)), file, mode);
		try {
			writeFileSync(fd, data);
		} finally {
			closeSync(fd);
		}
	});
}

/** Sets `file`'s times below `anchor` to now without changing its bytes; same symlink refusal
 * as writeBelow. A zero-byte append would not move the mtime. */
export function touchBelow(anchor: string, file: string): void {
	withDir(anchor, dirname(file), { create: true }, (d) => {
		const fd = openEntry(d.at(basename(file)), file, "append");
		try {
			const now = new Date();
			futimesSync(fd, now, now);
		} finally {
			closeSync(fd);
		}
	});
}

/** Removes `file` below `anchor`; a symlink there is removed itself, never its target. */
export function unlinkBelow(anchor: string, file: string): void {
	withDir(anchor, dirname(file), {}, (d) => unlinkSync(d.at(basename(file))));
}

/** Renames `from` to `to`, both below `anchor`; creates `to`'s parents. */
export function renameBelow(anchor: string, from: string, to: string): void {
	withDir(anchor, dirname(from), {}, (src) =>
		withDir(anchor, dirname(to), { create: true }, (dst) =>
			renameSync(src.at(basename(from)), dst.at(basename(to))),
		),
	);
}

/**
 * Opens `name` in the held dir `d` for writing, created exclusively: an entry already there
 * fails with EEXIST and a symlink there is never followed. Callers hold the fd across the
 * steps that follow (an integrity check, an install rename), so a worker cannot swap the
 * entry in between, and the fd is readable, so the caller can read its own copy back.
 * Close the result.
 */
export function openExclusive(d: Dir, name: string, perm = 0o666): number {
	return openEntry(
		d.at(entryName(name)),
		`${d.path}/${entryName(name)}`,
		"exclusive",
		perm,
	);
}

/**
 * Renames entry `from` to `to` inside the held dir `d` and proves the installed entry is
 * the file `fd` holds. The rename runs through the held dir (d.at), so it resolves no
 * parent again: a parent dir that a worker swapped for a symlink after the walk receives
 * nothing. The ino checks catch a swap of the entry names (the held fd pins our inode,
 * so it cannot be recycled), and an entry that is not ours is removed, never followed.
 */
export function renameProven(
	d: Dir,
	from: string,
	to: string,
	fd: number,
): void {
	const label = `${d.path}/${to}`;
	const mine = fstatSync(fd).ino;
	const pre = lstatSync(d.at(from), { throwIfNoEntry: false });
	if (pre === undefined || pre.ino !== mine)
		throw new Error(`refusing ${label}: the entry changed before the rename`);
	renameSync(d.at(from), d.at(to));
	const post = lstatSync(d.at(to), { throwIfNoEntry: false });
	if (post === undefined || post.ino !== mine) {
		try {
			unlinkSync(d.at(to));
		} catch {
			// the proof failed: report it, and leave no entry of theirs behind when it unlinks
		}
		throw new Error(`refusing ${label}: the entry changed during the rename`);
	}
}

/** Where a copy goes: the lexical paths of source and destination, and the tree holding the source. */
interface Relink {
	from: string;
	to: string;
	fromTree: string;
}

/**
 * Copies one entry across mounts: a symlink as a link, a regular file by content. With
 * `relink`, a relative link target that leaves `relink.fromTree` is rewritten so the copy at
 * `relink.to` names the same path; a target inside the tree stays verbatim, so it names the
 * same relative entry in the destination tree.
 */
/**
 * Resolves the new target for a copied symlink. Null keeps the target verbatim: absolute
 * targets, or any target when no relink applies, name the same entry after the copy.
 */
function relinkTarget(target: string, relink?: Relink): string | null {
	if (!relink || isAbsolute(target)) return null;
	const named = resolve(dirname(resolve(relink.from)), target);
	if (inside(relink.fromTree, named)) return null;
	return relative(dirname(resolve(relink.to)), named);
}

/** Copies a symlink as a link, never as what it points at. */
function copySymlink(src: string, dst: string, relink?: Relink): void {
	const target = readlinkSync(src);
	const named = relinkTarget(target, relink);
	symlinkSync(named ?? target, dst);
}

/** Opens `src` without following a final symlink, failing with "refusing <label>". */
function openRegularFile(src: string, label: string): number {
	try {
		return openSync(src, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if (errCode(err) === "ELOOP")
			throw new Error(`refusing ${label}: a symlink`);
		throw err;
	}
}

/** Copies a regular file's content and mode through two open descriptors. */
function copyFileContent(sfd: number, dst: string, label: string): void {
	const st = fstatSync(sfd);
	if (!st.isFile()) throw new Error(`refusing ${label}: not a regular file`);
	const dfd = openEntry(dst, label, "exclusive", st.mode & 0o777);
	try {
		const buf = Buffer.allocUnsafe(1 << 20);
		for (;;) {
			const n = readSync(sfd, buf, 0, buf.length, null);
			if (n === 0) break;
			for (let off = 0; off < n; ) off += writeSync(dfd, buf, off, n - off);
		}
	} finally {
		closeSync(dfd);
	}
}

function copyEntry(
	src: string,
	dst: string,
	label: string,
	relink?: Relink,
): void {
	try {
		unlinkSync(dst); // replace, like rename would; an exclusive create follows
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
	if (lstatSync(src).isSymbolicLink()) {
		copySymlink(src, dst, relink);
		return;
	}
	const sfd = openRegularFile(src, label);
	try {
		copyFileContent(sfd, dst, label);
	} finally {
		closeSync(sfd);
	}
}

/**
 * Moves one entry from below one anchor to below another, creating the destination's
 * parents and replacing an entry already there. Same mount: rename. Across mounts (EXDEV):
 * copy, then unlink the source. A symlink entry moves as a link and is never followed; a
 * symlinked parent on either side fails the move with "refusing <path>".
 */
export function moveBelow(
	from: { anchor: string; file: string },
	to: { anchor: string; file: string },
): void {
	withDir(from.anchor, dirname(from.file), {}, (src) =>
		withDir(to.anchor, dirname(to.file), { create: true }, (dst) => {
			const s = src.at(basename(from.file));
			const d = dst.at(basename(to.file));
			try {
				renameSync(s, d);
				return;
			} catch (err) {
				if (errCode(err) !== "EXDEV") throw err;
			}
			copyEntry(s, d, from.file);
			unlinkSync(s);
		}),
	);
}

/**
 * Copies one entry from below one anchor to below another, creating the destination's
 * parents and replacing an entry already there. A regular file is copied by content with
 * its mode, a symlink entry as a link that is never followed. A symlinked parent on either
 * side, or any other entry type, fails the copy with "refusing <path>".
 *
 * `sourceTree` names the tree that holds the source, when the destination sits at the same
 * relative path in its own tree (a main checkout and its worktree). A relative link target
 * inside the source tree then stays verbatim; one that leaves it is rewritten so the copy
 * names the same path. Without `sourceTree`, every link target stays verbatim.
 */
export function copyBelow(
	from: { anchor: string; file: string },
	to: { anchor: string; file: string },
	sourceTree?: string,
): void {
	withDir(from.anchor, dirname(from.file), {}, (src) =>
		withDir(to.anchor, dirname(to.file), { create: true }, (dst) =>
			copyEntry(
				src.at(basename(from.file)),
				dst.at(basename(to.file)),
				from.file,
				sourceTree === undefined
					? undefined
					: { from: from.file, to: to.file, fromTree: sourceTree },
			),
		),
	);
}

/**
 * Appends `line` and a newline to `file` below `anchor`, creating the file and its parents.
 * A newline goes first when the file does not end with one. A symlink at the file or at a
 * parent below the anchor, or an entry that is not a regular file, fails with "refusing".
 */
export function appendLineBelow(
	anchor: string,
	file: string,
	line: string,
): void {
	withDir(anchor, dirname(file), { create: true }, (d) => {
		let fd: number;
		try {
			fd = openSync(
				d.at(basename(file)),
				O_RDWR | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK,
				0o666,
			);
		} catch (err) {
			if (errCode(err) === "ELOOP")
				throw new Error(`refusing ${file}: a symlink`);
			throw err;
		}
		try {
			const st = fstatSync(fd);
			if (!st.isFile()) throw new Error(`refusing ${file}: not a regular file`);
			let lead = "";
			if (st.size > 0) {
				const last = Buffer.alloc(1);
				readSync(fd, last, 0, 1, st.size - 1);
				if (last[0] !== 0x0a) lead = "\n";
			}
			writeSync(fd, `${lead}${line}\n`);
		} finally {
			closeSync(fd);
		}
	});
}

/** Reads the open descriptor fully, with the size checks; see readBelow. */
function readRegularFile(d: Dir, file: string, maxBytes: number): Buffer {
	let fd: number;
	try {
		fd = openSync(d.at(basename(file)), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if (errCode(err) === "ELOOP")
			throw new Error(`refusing ${file}: a symlink`);
		throw err;
	}
	try {
		return readBoundedSync(fd, file, maxBytes);
	} finally {
		closeSync(fd);
	}
}

/**
 * Opens `file` below `anchor` for reading without following a symlink at any component
 * below the anchor (the file included); O_NONBLOCK keeps a planted FIFO from blocking
 * the board's thread. Anything but a regular file fails with "refusing". Close the result.
 */
export function openRegularBelow(anchor: string, file: string): number {
	return withDir(anchor, dirname(file), {}, (d) => {
		let fd: number;
		try {
			fd = openSync(d.at(basename(file)), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
		} catch (err) {
			if (errCode(err) === "ELOOP")
				throw new Error(`refusing ${file}: a symlink`);
			throw err;
		}
		return regularOrClose(fd, file);
	});
}

/**
 * Reads the regular file `file` below `anchor`, following no symlink under the anchor (the
 * file included). Null when the file or a parent is missing. A symlink, a non-regular entry,
 * or a file over `maxBytes` fails with "refusing <path>".
 */
export function readBelow(
	anchor: string,
	file: string,
	maxBytes: number,
): Buffer | null {
	try {
		return withDir(anchor, dirname(file), {}, (d) =>
			readRegularFile(d, file, maxBytes),
		);
	} catch (err) {
		if (errCode(err) === "ENOENT") return null;
		throw err;
	}
}

/**
 * Removes the entry at `p`, a path that resolves no parent again (a Dir.at result or a
 * /proc/self/fd path); recurses into real directories only.
 */
function removeEntry(p: string): void {
	let child: number;
	try {
		child = openSync(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		const code = errCode(err);
		if (code === "ENOENT") return;
		if (code !== "ELOOP" && code !== "ENOTDIR") throw err;
		// a file or a symlink: remove the entry itself, never a symlink's target
		try {
			unlinkSync(p);
		} catch (e) {
			if (errCode(e) !== "ENOENT") throw e;
		}
		return;
	}
	try {
		for (const n of readdirSync(`${FD_DIR}/${child}`))
			removeEntry(`${FD_DIR}/${child}/${n}`);
	} finally {
		closeSync(child);
	}
	rmdirSync(p);
}

/**
 * rm -rf for `target` below `anchor`. A symlink at the target or inside the tree is removed
 * itself, never followed; a symlinked parent between anchor and target fails with
 * "refusing <path>". A missing target or parent is no error.
 */
export function removeBelow(anchor: string, target: string): void {
	if (parts(anchor, target).length === 0)
		throw new Error(`refusing to remove the anchor ${anchor}`);
	if (!guarded) {
		rmSync(target, { recursive: true, force: true });
		return;
	}
	try {
		withDir(anchor, dirname(target), {}, (d) =>
			removeEntry(d.at(basename(target))),
		);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}
