import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
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
import {
	basename,
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
	exclusive: O_WRONLY | O_CREAT | O_EXCL,
	append: O_WRONLY | O_CREAT | O_APPEND,
};

/** A directory opened below an anchor. */
export interface Dir {
	/** The lexical path, for messages only. */
	readonly path: string;
	/** A path that names `name` in this directory without re-resolving any parent. */
	at(name: string): string;
	/** Entry names, like readdirSync. */
	list(): string[];
	close(): void;
}

function errCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException).code;
}

/** The path components from anchor down to target; throws when target is not below anchor. */
function parts(anchor: string, target: string): string[] {
	const rel = relative(resolve(anchor), resolve(target));
	if (rel === "") return [];
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error(`${target} is outside ${anchor}`);
	return rel.split(sep);
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
	const held = fd;
	let open = true;
	return {
		path: cur,
		at: (name) => `${FD_DIR}/${held}/${entryName(name)}`,
		list: () => readdirSync(`${FD_DIR}/${held}`),
		close: () => {
			if (open) closeSync(held);
			open = false;
		},
	};
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

/** Opens an entry for writing; a symlink there fails ("refusing"), it is never followed. */
function openEntry(path: string, label: string, mode: WriteMode, perm = 0o666) {
	try {
		return openSync(path, FLAGS[mode] | O_NOFOLLOW, perm);
	} catch (err) {
		if (errCode(err) === "ELOOP")
			throw new Error(`refusing ${label}: a symlink`);
		throw err;
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

/** Copies one entry across mounts: a symlink as a link, a regular file by content. */
function copyEntry(src: string, dst: string, label: string): void {
	try {
		unlinkSync(dst); // replace, like rename would; an exclusive create follows
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
	if (lstatSync(src).isSymbolicLink()) {
		symlinkSync(readlinkSync(src), dst);
		return;
	}
	let sfd: number;
	try {
		sfd = openSync(src, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if (errCode(err) === "ELOOP")
			throw new Error(`refusing ${label}: a symlink`);
		throw err;
	}
	try {
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
 */
export function copyBelow(
	from: { anchor: string; file: string },
	to: { anchor: string; file: string },
): void {
	withDir(from.anchor, dirname(from.file), {}, (src) =>
		withDir(to.anchor, dirname(to.file), { create: true }, (dst) =>
			copyEntry(
				src.at(basename(from.file)),
				dst.at(basename(to.file)),
				from.file,
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
