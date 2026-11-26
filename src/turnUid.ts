import { createHash, randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	appendFileSync,
	chmodSync,
	chownSync,
	closeSync,
	constants,
	cpSync,
	existsSync,
	fchmodSync,
	fstatSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
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
import { type HeldLock, holdLock } from "./layerLeaseLock.ts";

/**
 * Per-project turn identity for classic workers (OTTR-994,
 * docs/specs/worker-turn-uid-isolation.md): every turn drops to its project's
 * uid/gid, writes only its per-project turn home, and reads the flat shared
 * home only through the pin's links. A turn of project A can no longer read
 * /proc/<pid>/environ of a running turn of project B, and its plant surface
 * stops at its own project's home.
 *
 * Soundness rule for everything root touches here: root never creates, chowns
 * or follows a path whose parent a turn uid can mutate. The project level of
 * the turn home stays root-owned; recursive chowns pin every entry with an
 * O_PATH|O_NOFOLLOW fd and fchown the inode, so a same-uid rename or symlink
 * swap during the walk cannot redirect the chown outside the tree.
 */

/** Turn uids start above nobody (65534); the space is 2^24 names wide. */
export const TURN_UID_BASE = 65536;
export const TURN_UID_SPACE = 1 << 24;

/** Layer links retargeted into the per-project turn home: caches, not state. */
export const RETARGET_LINKS = [".cache", ".npm", ".bun", ".local"] as const;

/** Flat-home links an unpinned turn's HOME carries (the legacy identity). */
const FLAT_LINK_ALWAYS = [".omp"] as const;
const FLAT_LINK_IF_EXISTS = [
	".gitconfig",
	".config",
	".ssh",
	".claude",
] as const;

export interface TurnIdentity {
	uid: number;
	gid: number;
}

/** Deterministic uid/gid for one project name; gid equals uid. */
export function projectTurnUid(name: string): TurnIdentity {
	const digest = createHash("sha256").update(name, "utf8").digest();
	const offset = Number(digest.readBigUInt64BE(0) % BigInt(TURN_UID_SPACE));
	const uid = TURN_UID_BASE + offset;
	return { uid, gid: uid };
}

// One uid per name for this container's lifetime; a second name on a taken uid
// shares that trust boundary until one project is renamed. The note rides the
// run's install notes so the card log shows it.
const uidOwners = new Map<number, string>();

export function uidCollisionNote(
	name: string,
	ids: TurnIdentity,
): string | null {
	const owner = uidOwners.get(ids.uid);
	if (owner === undefined) {
		uidOwners.set(ids.uid, name);
		return null;
	}
	if (owner === name) return null;
	return `turn-uid: projects ${owner} and ${name} share uid ${ids.uid}; rename one project to restore the boundary`;
}

/** True only when the daemon can drop privileges (root on Linux). */
export function isolationEnabled(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Turn-home root: OTTR_TURN_HOMES or /turn-homes (the compose volume mount). */
export function turnHomesRoot(): string {
	return process.env.OTTR_TURN_HOMES || "/turn-homes";
}

/** Project names are single path segments with no field separators; anything
 * else is refused (fail closed). The colon and line breaks keep request names
 * out of the structured files root writes: passwd/group lines and the pinned
 * gitconfig (OTTR-1184). */
export function assertProjectSegment(name: string): void {
	if (
		name === "" ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		name.includes(":") ||
		name.includes("\n") ||
		name.includes("\r")
	)
		throw new Error(`turn-uid: refusing project name ${JSON.stringify(name)}`);
}

/** The per-project turn home: a root-owned shell with one uid-owned HOME. */
export interface TurnHome {
	/** `<root>/<project>`: root-owned 0755; the uid never mutates this level. */
	root: string;
	/** The uid's writable HOME: `<root>/home`, owned by the project uid, 0700. */
	home: string;
	/** Root-owned per-project layer copies: `<root>/layers`. */
	layers: string;
	/** Root-owned provisioning target (tools, venv, PATH dirs): `<root>/ottr`. */
	provision: string;
}

/**
 * `<root>/<project>` and its fixed layout, created once. The project level and
 * the `layers` and `ottr` dirs stay root-owned, so a turn uid can never
 * create, rename or symlink-swap anything the daemon chowns or copies there;
 * only `home` is handed to the uid.
 */
export function prepareTurnHome(
	root: string,
	project: string,
	ids: TurnIdentity,
): TurnHome {
	assertProjectSegment(project);
	mkdirSync(root, { recursive: true });
	const dir = join(root, project);
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o755);
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	chownSync(home, ids.uid, ids.gid);
	chmodSync(home, 0o700);
	const layers = join(dir, "layers");
	mkdirSync(layers, { recursive: true });
	chmodSync(layers, 0o755);
	const provision = join(dir, "ottr");
	mkdirSync(provision, { recursive: true });
	chmodSync(provision, 0o755);
	return { root: dir, home, layers, provision };
}

/**
 * The pinned layer dir a request env names, or null when the path is not
 * `<workerHome>/.alate/layers/<id>` after realpath (planted-pointer refuse,
 * same shape check as pinTarget in src/layers.ts). Throws when the layer
 * vanished between dispatch and /run.
 */
export function resolvePinnedLayer(
	workerHome: string,
	home: unknown,
): string | null {
	const layersRoot = join(workerHome, ".alate", "layers");
	if (typeof home !== "string" || !home.startsWith(`${layersRoot}/`))
		return null;
	// Lexical shape first, without touching the fs: `..` or a nested path is a
	// plant (the callers fall back to the unpinned home), not a vanished layer.
	if (dirname(resolve(home)) !== layersRoot) return null;
	let dir: string;
	try {
		dir = realpathSync(home);
	} catch {
		throw new Error(
			`turn-uid: agent layer ${basename(home)} vanished before the run`,
		);
	}
	// A symlink inside the layers tree may still point out of it: refuse too.
	if (dirname(dir) !== layersRoot) return null;
	return dir;
}

/** Stale window shared by the layer temp dirs and the in-use markers: a day,
 * matching the temp-dir rule and far longer than any turn on the volume. */
const LAYER_STALE_MS = 24 * 60 * 60 * 1000;

/** In-use marker beside a layer copy (`<id>.inuse`); only its mtime is read,
 * so the name is a contract between the workers on the shared volume. */
const LAYER_INUSE_SUFFIX = ".inuse";

/** The decision lock beside the copies: the marker refresh, the prune's
 * read-decide-delete and the reuse check all hold it, so a start on one
 * worker never interleaves with a deletion on the other. The same SQLite
 * POSIX lock the lease ledger uses; the kernel drops it when a holder dies. */
const LAYERS_LOCK_NAME = "in-use.lock";

/** How long a start waits for the other worker's decision section before it
 * fails closed. The sections hold only stats and rm's; only a wedged volume
 * exhausts this. */
const LAYERS_LOCK_WAIT_MS = 10_000;

/**
 * Mark one layer id in use for the stale window: the marker beside the copy
 * (`<id>.inuse`) gains one `<token> <iso>` line per live run, and its fresh
 * mtime keeps the copy's prune away while a started turn runs on it. The
 * marker lives in the root-owned layers dir, so a turn uid can neither forge
 * nor drop it. Throws when the marker cannot be written: an unprotected turn
 * must not start, because the next prune could delete its live copy
 * (OTTR-1179).
 */
function markLayerInUse(layersDir: string, id: string, token: string): void {
	appendFileSync(
		join(layersDir, id + LAYER_INUSE_SUFFIX),
		`${token} ${new Date().toISOString()}\n`,
	);
}

/** Per-run holder token for one marker line; unique across the workers. */
export function newLayerToken(): string {
	return randomBytes(8).toString("hex");
}

/**
 * The run's release of its marker line (OTTR-1179): when the child closes,
 * the line goes, and the marker file goes when no live line remains, so a
 * copy nothing runs on loses its protection at once. The mutation runs under
 * the same decision lock as the mark and the prune. Never throws: a failed
 * release keeps the marker, and the copy stays protected until the marker
 * ages out after the stale window — the same bound a dead holder's line
 * already carries.
 */
export function releaseLayerCopyUse(
	layersDir: string,
	id: string,
	token: string,
): void {
	const marker = join(layersDir, id + LAYER_INUSE_SUFFIX);
	let lock: HeldLock | null = null;
	try {
		lock = holdLock(
			join(realpathSync(layersDir), LAYERS_LOCK_NAME),
			LAYERS_LOCK_WAIT_MS,
		);
		const st = statOf(marker);
		if (st === null || !st.isFile()) return;
		const lines = readFileSync(marker, "utf8")
			.split("\n")
			.filter((line) => line !== "");
		const rest = lines.filter((line) => !line.startsWith(`${token} `));
		if (rest.length === lines.length) return; // A legacy marker names no holder: it ages out.
		if (rest.length === 0) rmSync(marker, { force: true });
		else writeFileSync(marker, `${rest.join("\n")}\n`);
	} catch {
		// The marker stays and keeps protecting the copy until it ages out.
	} finally {
		lock?.release();
	}
}

/**
 * One per-project copy of the pinned layer under `<turnHome>/layers/<id>`:
 * cp into a temp dir beside the final name, retarget the cache links, chown,
 * then one atomic rename. The parent stays root-owned, so the uid cannot
 * touch the temp or the final dir; symlinks are copied as links, so the
 * shared-state links keep pointing at the flat shared home. An existing
 * final dir is reused (a layer id is never rewritten), including the
 * concurrent-winner case where our own rename loses the race.
 *
 * Every start first takes the per-project decision lock (`in-use.lock`,
 * `lockWaitMs` budget), then marks its id in use, prunes, and checks for a
 * reusable copy inside that section, so a start on one worker can never
 * interleave with a deletion decision on the other (OTTR-1179; both workers
 * share this volume). A marker that cannot be written, or a lock that stays
 * busy, fails the start closed before anything is deleted — the same rule as
 * a lease acquisition failure. The layer cp runs outside the
 * section; its rename race stays safe on its own. The caller passes the run's
 * holder token and releases it with `releaseLayerCopyUse` when the child
 * closes, so a finished run stops protecting its copy.
 */
export function ensureLayerCopy(
	layerDir: string,
	turnHome: TurnHome,
	workerHome: string,
	ids: TurnIdentity,
	lockWaitMs: number = LAYERS_LOCK_WAIT_MS,
	token: string = newLayerToken(),
): string {
	const id = basename(layerDir);
	const final = join(turnHome.layers, id);
	const lock = holdLock(
		join(realpathSync(turnHome.layers), LAYERS_LOCK_NAME),
		lockWaitMs,
	);
	try {
		markLayerInUse(turnHome.layers, id, token);
		pruneLayerCopies(layerDir, turnHome);
		if (existsSync(final)) return final;
	} finally {
		lock.release();
	}
	const tmp = join(
		turnHome.layers,
		`.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
	);
	try {
		cpSync(layerDir, tmp, { recursive: true });
		retargetCacheLinks(tmp, turnHome.home, workerHome);
		chownTree(tmp, ids);
		chmodSync(tmp, 0o700);
		renameSync(tmp, final);
	} catch (err) {
		// A concurrent run of the same project won the rename: both copied the
		// same immutable source, so its final dir is this run's copy too.
		if (existsSync(final)) return final;
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// The stale sweep removes it on a later run.
		}
		throw err;
	}
	return final;
}

/**
 * Layer copy retention: temp dirs older than a day go, and a final copy goes
 * at once unless it is the current pin or its in-use marker is fresh (a
 * started turn still runs on it; OTTR-1179) — independent of the copy's age
 * and of whether alate still holds the source layer. Markers whose holders
 * are gone age out the same way. Runs inside the caller's decision lock, so
 * every read-decide-delete below is atomic across the workers and re-reads
 * the current marker state. Best effort.
 */
function pruneLayerCopies(layerDir: string, turnHome: TurnHome): void {
	const staleCutoff = Date.now() - LAYER_STALE_MS;
	let entries: Dirent[];
	try {
		entries = readdirSync(turnHome.layers, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(turnHome.layers, entry.name);
		if (entry.name === LAYERS_LOCK_NAME) continue;
		if (entry.name.startsWith(".tmp-")) {
			try {
				const st = statOf(path);
				if (st !== null && st.mtimeMs < staleCutoff)
					rmSync(path, { recursive: true, force: true });
			} catch {
				// The rename below either happened or a later run prunes it.
			}
			continue;
		}
		if (entry.name.endsWith(LAYER_INUSE_SUFFIX)) {
			// A marker outlives its copy only for the stale window: a fresh one
			// may precede its rename or guard a copy another worker's live turn
			// runs on; an aged one names nothing and goes.
			try {
				const st = statOf(path);
				if (st !== null && st.mtimeMs < staleCutoff)
					rmSync(path, { force: true });
			} catch {
				// A later run retries.
			}
			continue;
		}
		if (entry.name === basename(layerDir)) continue;
		const markerPath = join(turnHome.layers, entry.name + LAYER_INUSE_SUFFIX);
		const marker = statOf(markerPath);
		if (marker !== null && marker.mtimeMs >= staleCutoff) continue;
		try {
			rmSync(path, { recursive: true, force: true });
			if (marker !== null) rmSync(markerPath, { force: true });
		} catch {
			// Best effort; the next copy for the project retries.
		}
	}
}

function statOf(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/**
 * Inside a fresh layer copy, links into the flat shared home for the
 * per-project cache entries (`.cache`, `.npm`, `.bun`, `.local`) are pointed
 * at the turn home's writable home instead. The cache dirs themselves the
 * turn creates through those links, as its own uid: root never writes below
 * the uid-owned home. State links (agent.db, sessions, oauth, logs) keep
 * their flat targets, and a missing or non-link entry stays layer content.
 */
export function retargetCacheLinks(
	copyDir: string,
	homeDir: string,
	workerHome: string,
): void {
	for (const rel of RETARGET_LINKS) {
		const linkPath = join(copyDir, rel);
		const st = statOf(linkPath);
		if (st === null || !st.isSymbolicLink()) continue;
		let target: string;
		try {
			target = readlinkSync(linkPath);
		} catch {
			continue;
		}
		// Only absolute links into the shared home are retargeted; a relative or
		// foreign link stays as the layer shipped it.
		if (resolve(copyDir, target) !== target) continue;
		if (!target.startsWith(`${workerHome}/`)) continue;
		unlinkSync(linkPath);
		symlinkSync(join(homeDir, rel), linkPath);
	}
}

/** bun-types (and Bun's runtime constants) omit Linux's O_PATH; the value is a
 * stable Linux ABI constant (asm-generic/fcntl.h: O_PATH 010000000). A kernel
 * without it fails the opens below and the run fails closed. */
const fsConstants = constants;
const fsConstantsEx = fsConstants as typeof fsConstants & { O_PATH?: number };
const oPath =
	typeof fsConstantsEx.O_PATH === "number" ? fsConstantsEx.O_PATH : 0o10000000;
const oNoFollow = fsConstants.O_NOFOLLOW;

/** Pin a path with O_PATH|O_NOFOLLOW (the walk's root open). Exposed for the
 * rename-race test seam; the returned fd must be closed by the caller. */
export function openPinned(path: string): number {
	return openSync(path, oPath | oNoFollow);
}

/**
 * chown every entry of a tree, race-free against the tree's owning uid.
 * The root is opened once (atomic path resolution, O_NOFOLLOW on the final
 * part); every listing, open and chown below it then goes through the
 * `/proc/self/fd/N` magic link of a pinned descriptor, which the kernel
 * resolves to the exact inode the fd holds. A same-uid rename or symlink
 * swap during the walk therefore cannot redirect a chown or a descent to a
 * file outside the tree: renames cannot change what a pinned fd points at,
 * and O_NOFOLLOW refuses a symlink as the final part of each anchored child
 * path. A symlink entry is lchowned through its pinned parent (the link
 * itself, never the target) and never descended through.
 */
export function chownTree(root: string, ids: TurnIdentity): void {
	const rootFd = openPinned(root);
	try {
		// O_PATH|O_NOFOLLOW on a trailing symlink can return the link's fd: refuse
		// a symlink root before any chown (its magic link would resolve to the
		// target), and chown a plain file root without a walk.
		const rootSt = fstatSync(rootFd);
		if (rootSt.isSymbolicLink())
			throw new Error(`turn-uid: ${root} is a symlink; refusing to chown it`);
		// The pinned root inode is chowned through its magic link; chownTreeFd
		// handles everything below it.
		chownSync(`/proc/self/fd/${rootFd}`, ids.uid, ids.gid);
		if (rootSt.isDirectory()) chownTreeFd(rootFd, ids);
	} finally {
		closeSync(rootFd);
	}
}

/** chown every entry below an already-pinned directory fd, race-free by the
 * same /proc/self/fd anchoring; the pinned inode itself is the caller's (the
 * test seam for the rename race: the caller can rename the root mid-flight
 * and prove the walk follows the inode, not the path). `listDir` is the test
 * seam for a directory unlinked mid-walk; the default lists the pinned fd's
 * magic link exactly as production does. */
export function chownTreeFd(
	rootFd: number,
	ids: TurnIdentity,
	listDir: (viaDir: string) => string[] = (p) => readdirSync(p),
): void {
	// A dir fd stays open until its listing pass is done: each child path is
	// `/proc/self/fd/<parentFd>/<entry>`, so the parent must live until every
	// child is opened. Child dir fds are closed after their own pass.
	const dirs: number[] = [rootFd];
	while (dirs.length > 0) {
		const dirFd = dirs.pop();
		if (dirFd === undefined) break;
		const viaDir = `/proc/self/fd/${dirFd}`;
		let entries: string[];
		try {
			entries = listDir(viaDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			// A directory unlinked mid-walk reads ENOENT on its magic link: the
			// listing is gone and with it everything below, like the child-open
			// ENOENT branch. The walk goes on; the caller's root fd stays open
			// (chownTree closes it), and only fds this walk opened close here.
			if (dirFd !== rootFd) closeSync(dirFd);
			continue;
		}
		for (const entry of entries) {
			const child = `${viaDir}/${entry}`;
			let fd: number;
			try {
				fd = openSync(child, oPath | oNoFollow);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ELOOP") {
					// A symlink entry (kernel refused the no-follow open): own the
					// link itself — lchown does not follow the final part, and the
					// parent is the pinned magic link — and never descend.
					lchownSync(child, ids.uid, ids.gid);
					continue;
				}
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // unlinked mid-walk: nothing left to chown
				throw err;
			}
			try {
				const st = fstatSync(fd);
				if (st.isSymbolicLink()) {
					// O_PATH|O_NOFOLLOW can return the link's fd instead of failing:
					// lchown it through the pinned parent (never the target) and do
					// not descend.
					closeSync(fd);
					lchownSync(child, ids.uid, ids.gid);
					continue;
				}
				// The magic link of a non-symlink fd resolves to the pinned inode:
				// chown through it instead of any path a rename could move.
				chownSync(`/proc/self/fd/${fd}`, ids.uid, ids.gid);
				if (st.isDirectory()) dirs.push(fd);
				else closeSync(fd);
			} catch (err) {
				closeSync(fd);
				throw err;
			}
		}
		// The root fd belongs to the caller (chownTree closes it in its finally);
		// only the fds this walk opened itself are closed here.
		if (dirFd !== rootFd) closeSync(dirFd);
	}
}

/**
 * Per-run workspace handoff: the run's cwd tree and the project's git dir
 * become the project uid's, and their top dirs go to mode 0700, so a turn of
 * another project cannot traverse into this project's checkout. Every path
 * below the workspace root is resolved per component from a pinned root fd
 * with O_NOFOLLOW|O_DIRECTORY: after a project's first run its project dir is
 * uid-owned, so the uid could rename an intermediate dir (`.worktrees`) and
 * plant a symlink whose middle part a plain-path open would follow — handing
 * the root-privileged chown another project's tree. A symlink or non-dir
 * component below the workspace root fails the run instead. The git dir is
 * derived structurally (`<workspaceRoot>/<project>/.git`, the board's own
 * layout), never from the worktree's planted `.git` pointer. Any step that
 * cannot be proven fails the run.
 */
export function prepareRunWorkspace(
	cwd: string,
	ids: TurnIdentity,
	workspaceRoot: string,
	project?: string,
): void {
	const rel = relative(workspaceRoot, cwd);
	if (rel === "" || isAbsolute(rel) || rel.startsWith(".."))
		throw new Error(
			`turn-uid: run cwd ${cwd} is not under the workspace root ${workspaceRoot}`,
		);
	const segments = rel.split(sep);
	const firstSegment = segments[0];
	if (
		firstSegment === undefined ||
		firstSegment === "" ||
		firstSegment === "." ||
		firstSegment === ".."
	)
		throw new Error(
			`turn-uid: run cwd ${cwd} does not name a project under ${workspaceRoot}`,
		);
	// The identity comes from the request's project; a mismatched cwd/project
	// pair would hand one project's chown to the other's uid. Hardening: the
	// board always sends the matching pair (uids hold no /run token).
	if (project !== undefined && firstSegment !== project)
		throw new Error(
			`turn-uid: run cwd ${cwd} does not belong to project ${project}`,
		);
	const rootFd = openPinned(workspaceRoot);
	try {
		// The cwd tree, resolved component by component below the pinned root:
		// a planted symlink or a non-dir at any level fails the run before any
		// chown happens.
		const cwdFd = pinUnder(rootFd, segments);
		try {
			chownSync(`/proc/self/fd/${cwdFd}`, ids.uid, ids.gid);
			chownTreeFd(cwdFd, ids);
			chmodSync(`/proc/self/fd/${cwdFd}`, 0o700);
		} finally {
			closeSync(cwdFd);
		}
		// The project dir and its git dir, anchored the same way (the git dir
		// must be a real directory; a planted `.git` symlink is refused).
		const projectFd = pinUnder(rootFd, [firstSegment]);
		try {
			const gitFd = pinUnder(projectFd, [".git"]);
			try {
				chownSync(`/proc/self/fd/${gitFd}`, ids.uid, ids.gid);
				chownTreeFd(gitFd, ids);
				chmodSync(`/proc/self/fd/${gitFd}`, 0o700);
			} finally {
				closeSync(gitFd);
			}
			chownSync(`/proc/self/fd/${projectFd}`, ids.uid, ids.gid);
			chmodSync(`/proc/self/fd/${projectFd}`, 0o700);
		} finally {
			closeSync(projectFd);
		}
	} finally {
		closeSync(rootFd);
	}
}

/** Open `name` below a pinned directory fd as a real directory, refusing
 * symlinks and non-dirs (the anchored per-component resolve). */
function pinChild(parentFd: number, name: string): number {
	try {
		return openSync(
			`/proc/self/fd/${parentFd}/${name}`,
			oPath | oNoFollow | fsConstants.O_DIRECTORY,
		);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "ENOTDIR")
			throw new Error(
				`turn-uid: refusing planted entry "${name}" below the pinned workspace path (${code})`,
			);
		if (code === "ENOENT")
			throw new Error(`turn-uid: missing workspace entry "${name}"`);
		throw err;
	}
}

/** Pin the directory at `segments` below a pinned root fd, per component. */
function pinUnder(rootFd: number, segments: readonly string[]): number {
	let fd = rootFd;
	for (const name of segments) {
		const child = pinChild(fd, name);
		if (fd !== rootFd) closeSync(fd);
		fd = child;
	}
	return fd;
}

/** chownTree anchored to the exact dir entry the caller stat'ed: a swap of the
 * entry between the walk's open and its end changes the inode on the path, and
 * the run fails instead of chowning an impostor. */
function chownSameDir(dir: string, ids: TurnIdentity): void {
	const before = statOf(dir);
	if (before === null || !before.isDirectory() || before.isSymbolicLink())
		throw new Error(`turn-uid: ${dir} is not a directory`);
	chownTree(dir, ids);
	const after = statOf(dir);
	if (after === null || after.ino !== before.ino || after.dev !== before.dev)
		throw new Error(`turn-uid: ${dir} was swapped during the chown; refusing`);
}

/**
 * Per-run close of one project's dir under a shared root (/data/<project>):
 * the whole tree becomes the project uid's, so the turn's session writes
 * beside the server's files succeed, and other projects cannot read it.
 * The dir entry itself sits in a root-owned parent, so the uid cannot swap
 * it during the walk.
 */
export function closeProjectDir(dir: string, ids: TurnIdentity): void {
	const st = statOf(dir);
	if (st === null) return; // Nothing here yet (a fresh project): nothing to close.
	if (!st.isDirectory() || st.isSymbolicLink()) return;
	chownSameDir(dir, ids);
	chownSync(dir, ids.uid, ids.gid);
	chmodSync(dir, 0o700);
}

/**
 * The env a turn runs with: HOME moves to the per-project layer copy when the
 * request pins a layer, else to the turn home's writable home with the flat
 * identity links. PI_CODING_AGENT_DIR follows the copy. Mutates `env` in
 * place; returns the resolved home for tests.
 */
export function applyTurnHomeEnv(
	env: Record<string, string | undefined>,
	ctx: {
		workerHome: string;
		turnHome: TurnHome;
		ids: TurnIdentity;
		copyLayer?: (layerDir: string) => string;
		resolveLayer?: (home: unknown) => string | null;
		/** The run's holder token for the copy's marker line (OTTR-1179). */
		copyToken?: string;
	},
): { pinned: boolean; home: string } {
	const copyLayer =
		ctx.copyLayer ??
		((layerDir) =>
			ensureLayerCopy(
				layerDir,
				ctx.turnHome,
				ctx.workerHome,
				ctx.ids,
				undefined,
				ctx.copyToken,
			));
	const resolveLayer =
		ctx.resolveLayer ??
		((home: unknown) => resolvePinnedLayer(ctx.workerHome, home));
	const layerDir = resolveLayer(env.HOME);
	if (layerDir === null) {
		linkFlatHome(ctx.turnHome.home, ctx.workerHome);
		env.HOME = ctx.turnHome.home;
		return { pinned: false, home: ctx.turnHome.home };
	}
	const copy = copyLayer(layerDir);
	env.HOME = copy;
	const agentDir = env.PI_CODING_AGENT_DIR;
	env.PI_CODING_AGENT_DIR =
		typeof agentDir === "string" && agentDir.startsWith(layerDir)
			? copy + agentDir.slice(layerDir.length)
			: join(copy, ".omp", "agent");
	return { pinned: true, home: copy };
}

/**
 * An unpinned turn keeps the legacy flat identity through links in its
 * writable home: `.omp` (config, agent dir, store, plugins, logs) always,
 * the flat git, gh and ssh state when the flat home has it. Root creates a
 * link only when the entry is missing; an entry a turn planted stays, and a
 * planted link only redirects the turn's own reads.
 */
function linkFlatHome(homeDir: string, workerHome: string): void {
	for (const rel of FLAT_LINK_ALWAYS)
		linkIfMissing(homeDir, rel, workerHome, rel);
	for (const rel of FLAT_LINK_IF_EXISTS) {
		if (existsSync(join(workerHome, rel)))
			linkIfMissing(homeDir, rel, workerHome, rel);
	}
}

function linkIfMissing(
	homeDir: string,
	rel: string,
	workerHome: string,
	sourceRel: string,
): void {
	const linkPath = join(homeDir, rel);
	const st = statOf(linkPath);
	if (st !== null) return;
	try {
		symlinkSync(join(workerHome, sourceRel), linkPath);
	} catch {
		// Best effort, like the pin's prepare: a failed link degrades to the
		// turn-home-local path, never fails the run.
	}
}

/**
 * Shared-home store access modes (OTTR-1291): the flat worker home stays
 * traversable for turn uids, the store's dir stays sticky-writable so sqlite
 * can create its journal beside the store, and the store file stays writable
 * by every uid. bootTurnIsolation sets these once at boot;
 * ensureTurnStoreAccess restores them before each turn, because a root omp
 * run between turns resets them (dir 0700, db 0600).
 */
const WORKER_HOME_MODE = 0o711;
const AGENT_DIR_MODE = 0o1777;
const STORE_FILE_MODE = 0o666;

/**
 * Boot preparation, root-only: the shared home becomes traversable-but-not-
 * listable for turn uids, the flat state dirs omp writes through the pin's
 * links become sticky write-only-for-others (each uid keeps its entries
 * private), the store's dir turns sticky-writable so sqlite can create its
 * journal beside a mounted store, and every project dir under the shared
 * roots gets its project uid and mode 0700. Returns log lines; a non-root
 * daemon gets exactly the off note and changes nothing.
 */
export function bootTurnIsolation(
	workerHome: string,
	roots: string[],
	deps: {
		isMounted?: (path: string) => boolean;
		/** Only for tests: fires before each store chmod, so a test can swap
		 * the entry mid-check (the stat-to-open race) deterministically. */
		beforeChmod?: () => void;
	} = {},
): string[] {
	if (!isolationEnabled())
		return [
			"off: the worker daemon is not root, turns keep the legacy identity",
		];
	const notes: string[] = [];
	try {
		chmodSync(workerHome, WORKER_HOME_MODE);
	} catch (err) {
		notes.push(`home chmod failed: ${String(err)}`);
	}
	// 1733: write-and-traverse for every uid, no listing of others' entries,
	// sticky so a uid cannot remove another uid's files.
	for (const [rel, mode] of [
		[".omp/agent", AGENT_DIR_MODE],
		[".omp/agent/sessions", 0o1733],
		[".omp/logs", 0o1733],
	] as const) {
		try {
			mkdirSync(join(workerHome, rel), { recursive: true });
			chmodSync(join(workerHome, rel), mode);
		} catch (err) {
			notes.push(`${rel} prepare failed: ${String(err)}`);
		}
	}
	const db = join(workerHome, ".omp", "agent", "agent.db");
	const mounted = deps.isMounted ?? pathIsMounted;
	if (existsSync(db)) {
		// The store and the journal siblings sqlite creates beside it all need
		// the turn uids' write bit. Each entry carries its own checks: any of
		// the three can be its own bind mount, and a chmod through one would
		// change that host file's mode (the compose store mounts agent.db).
		// The sticky 1777 dir lets a turn plant a non-plain entry, and the
		// pinned open validates the descriptor, so a FIFO swapped in between
		// the stat and the open cannot block boot (OTTR-1291 review).
		for (const file of [db, `${db}-wal`, `${db}-shm`]) {
			const st = statOf(file);
			if (st === null) continue;
			if (!st.isFile()) {
				notes.push(
					`${basename(file)} is not a plain file; store mode left as it is`,
				);
				continue;
			}
			if (mounted(file)) {
				notes.push(`${basename(file)} is a mount; store mode left to the host`);
				continue;
			}
			try {
				deps.beforeChmod?.();
				chmodPinned(file, STORE_FILE_MODE, false);
			} catch (err) {
				notes.push(`${basename(file)} chmod failed: ${String(err)}`);
			}
		}
	}
	// BuildKit client material is root-0400 in the image ("workers run as
	// root"); turn uids need a read to build when the build profile is on.
	for (const cert of [
		"/certs/buildkit/client/key.pem",
		"/certs/buildkit/client/cert.pem",
		"/certs/buildkit/ca/ca.pem",
	]) {
		try {
			if (existsSync(cert)) chmodSync(cert, 0o644);
		} catch (err) {
			notes.push(`${cert} chmod failed: ${String(err)}`);
		}
	}
	for (const root of roots) notes.push(...closeRootProjectDirs(root));
	return notes;
}

/** True when the path is a mount point of this container (bind mounts included). */
function pathIsMounted(path: string): boolean {
	let mounts: string;
	try {
		mounts = readFileSync("/proc/self/mountinfo", "utf8");
	} catch {
		return false;
	}
	// mountinfo escapes space, tab and newline in the mount point field.
	const escaped = path
		.replaceAll(" ", "\\040")
		.replaceAll("\t", "\\011")
		.replaceAll("\n", "\\012");
	for (const line of mounts.split("\n")) {
		const fields = line.split(" ");
		if (fields[4] === escaped) return true;
	}
	return false;
}

/** Refusal head for a drifted store entry that sits on a mount (OTTR-1291). */
export const STORE_MOUNT_BLOCKED =
	"the shared omp store is a mount the turn uid cannot open";

/**
 * chmod a store inode through a pinned descriptor. A path chmod reads the
 * directory entry again, and the store dir is sticky-writable for every uid
 * (boot sets 1777 so sqlite can create its journals): a same-uid swap of the
 * entry between the stat and the chmod would redirect the chmod to another
 * inode. `open` with O_NOFOLLOW (plus O_DIRECTORY for dirs) binds the fd to
 * the exact inode the stat saw, and `fchmodSync` through the fd can never
 * follow a link planted afterwards (OTTR-1291 review).
 *
 * O_NONBLOCK keeps the open itself from blocking: the swap can also land a
 * FIFO on the entry, and a plain O_RDONLY open of a FIFO would hang the
 * daemon. The pinned descriptor is then the truth, not the path: fstat it
 * and refuse anything the stat-based checks never approved (OTTR-1291
 * review, race blockers).
 */
function chmodPinned(path: string, mode: number, dir: boolean): void {
	const fd = openSync(
		path,
		fsConstants.O_RDONLY |
			fsConstants.O_NONBLOCK |
			oNoFollow |
			(dir ? fsConstants.O_DIRECTORY : 0),
	);
	try {
		const st = fstatSync(fd);
		const plain = dir ? st.isDirectory() : st.isFile();
		if (!plain)
			throw new Error(
				`turn-uid: refusing store chmod of ${path} (pinned entry is not a plain ${dir ? "directory" : "file"})`,
			);
		fchmodSync(fd, mode);
	} finally {
		closeSync(fd);
	}
}

/**
 * The turn's store path must name the trusted shared store. A pinned layer
 * copy is uid-owned content, so its `agent.db` state link is a uid-mutable
 * pointer: a turn can retarget it anywhere, and a chmod that followed it
 * would hand root's chmod to an arbitrary file. Resolving a path is only a
 * read, so the check resolves the turn's path and refuses any target that
 * is not the flat store — the planted-pointer refuse the rest of the module
 * uses. A dangling link must name the store lexically, or it is a plant too.
 */
function requireTrustedStore(storePath: string, trustedDb: string): void {
	let resolved: string | null = null;
	try {
		resolved = realpathSync(storePath);
	} catch {
		// The path is absent or the link dangles.
	}
	if (resolved !== null) {
		let trustedReal: string | null = null;
		try {
			trustedReal = realpathSync(trustedDb);
		} catch {
			// The trusted store is absent: any resolvable foreign target is a plant.
		}
		if (trustedReal === null || resolved !== trustedReal)
			throw new Error(
				`turn-uid: refusing planted store link ${storePath} -> ${resolved}; the turn's store must resolve to ${trustedDb}`,
			);
		return;
	}
	const st = statOf(storePath);
	if (st === null || !st.isSymbolicLink()) return;
	let target = "";
	try {
		target = readlinkSync(storePath);
	} catch {
		// Unreadable link content: the compare below refuses it.
	}
	if (resolve(dirname(storePath), target) !== trustedDb)
		throw new Error(
			`turn-uid: refusing planted store link ${storePath} -> ${target}; the turn's store must resolve to ${trustedDb}`,
		);
}

/**
 * Per-turn store access (OTTR-1291): a root omp run between turns resets the
 * shared-home store modes (dir 0700, db 0600), and the next turn-uid turn
 * then dies opening the store. Before every spawn, verify the store chain's
 * entries and restore the boot modes. The check acts only on the trusted
 * flat chain (worker home, `.omp`, `.omp/agent`, the store files): the
 * turn-facing path is resolved and compared first, a store entry that is a
 * symlink or not a plain file refuses the run (a turn can plant its own
 * `-wal`/`-shm` entry in the sticky 1777 dir), and every chmod goes through
 * a pinned inode (chmodPinned). Mode bits only: the db is never opened for
 * reading, so the check stays fast enough to sit before each spawn.
 *
 * A drifted entry that sits on a mount is refused instead of chmodded: a
 * chmod through the mount would change the host file's mode, so the host
 * fixes the mode first. The refusal throws before any chmod, so a refused
 * turn never changes a mode. Returns the one-line drift note, or null on a
 * clean tree.
 */
export function ensureTurnStoreAccess(
	workerHome: string,
	storePath: string,
	ids: TurnIdentity,
	deps: {
		isMounted?: (path: string) => boolean;
		/** Only for tests: fires before each store chmod, so a test can swap
		 * the entry mid-check (the stat-to-open race) deterministically. */
		beforeChmod?: () => void;
	} = {},
): string | null {
	const agentDir = join(workerHome, ".omp", "agent");
	const dbFile = join(agentDir, "agent.db");
	requireTrustedStore(storePath, dbFile);
	const mounted = deps.isMounted ?? pathIsMounted;
	// The chain dirs carry no table mode of their own except the two the boot
	// table owns; a symlink or non-dir at any of them is a plant. `.omp` has
	// no table mode (boot never sets one), so it is only verified.
	for (const [path, name] of [
		[workerHome, "."],
		[join(workerHome, ".omp"), ".omp"],
		[agentDir, ".omp/agent"],
	] as const) {
		const st = statOf(path);
		if (st !== null && st.isDirectory() && !st.isSymbolicLink()) continue;
		throw new Error(
			`turn-uid: refusing planted store dir ${path} (${name} is ${
				st === null
					? "missing"
					: st.isSymbolicLink()
						? "a symlink"
						: "not a directory"
			})`,
		);
	}
	// One entry per path the turn opens: the worker home itself (every uid
	// traverses it), the store's dir (every uid creates the journal beside
	// the store), and the store with its sqlite siblings (every uid reads
	// and writes them). Names ride the drift note; the store files keep
	// their sqlite names.
	const entries: {
		path: string;
		name: string;
		need: number;
		mode: number;
		dir: boolean;
	}[] = [
		{
			path: workerHome,
			name: ".",
			need: 0o001,
			mode: WORKER_HOME_MODE,
			dir: true,
		},
		{
			path: agentDir,
			name: ".omp/agent",
			need: 0o003,
			mode: AGENT_DIR_MODE,
			dir: true,
		},
	];
	for (const suffix of ["", "-wal", "-shm"] as const) {
		const file = dbFile + suffix;
		entries.push({
			path: file,
			name: basename(file),
			need: 0o006,
			mode: STORE_FILE_MODE,
			dir: false,
		});
	}
	const blocked: { path: string; mode: number }[] = [];
	const drifted: {
		path: string;
		name: string;
		mode: number;
		from: number;
		dir: boolean;
	}[] = [];
	for (const entry of entries) {
		const st = statOf(entry.path);
		if (st === null) continue; // A missing entry (no db yet) carries no mode bits.
		const plain = entry.dir ? st.isDirectory() : st.isFile();
		if (!plain || st.isSymbolicLink())
			throw new Error(
				`turn-uid: refusing planted store entry ${entry.path} (${
					entry.name
				} is ${
					st.isSymbolicLink()
						? "a symlink"
						: `not a plain ${entry.dir ? "directory" : "file"}`
				})`,
			);
		if ((st.mode & entry.need) === entry.need) continue; // Healthy.
		if (mounted(entry.path)) {
			blocked.push({ path: entry.path, mode: st.mode });
			continue;
		}
		drifted.push({
			path: entry.path,
			name: entry.name,
			mode: entry.mode,
			from: st.mode & 0o7777,
			dir: entry.dir,
		});
	}
	if (blocked.length > 0) {
		const first = blocked[0]!;
		throw new Error(
			`${STORE_MOUNT_BLOCKED}: ${first.path} (mode ${(first.mode & 0o777).toString(8)}); chmod through the mount would change the host file - fix the mode on the host (a+rw on the store file, a+rwx on its folder), then reply`,
		);
	}
	if (drifted.length === 0) return null;
	for (const entry of drifted) {
		deps.beforeChmod?.();
		chmodPinned(entry.path, entry.mode, entry.dir);
	}
	const restored = drifted
		.map(
			(entry) =>
				`${entry.name} ${entry.from.toString(8)}->${entry.mode.toString(8)}`,
		)
		.join(", ");
	return `turn-uid: shared store modes drifted for uid ${ids.uid}; restored ${restored}`;
}

/** chown+close every project dir directly under one shared root; per-entry failures note. */
function closeRootProjectDirs(root: string): string[] {
	const notes: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return notes; // A root this worker does not mount (compose contract).
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		try {
			const dir = join(root, entry.name);
			const ids = projectTurnUid(entry.name);
			chownSync(dir, ids.uid, ids.gid);
			chmodSync(dir, 0o700);
		} catch (err) {
			notes.push(`${join(root, entry.name)} close failed: ${String(err)}`);
		}
	}
	return notes;
}

// ---------------------------------------------------------------------------
// Project identity provisioning (OTTR-1184)
// ---------------------------------------------------------------------------

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

/** Where the passwd and group snapshots live; tests point these at temp files. */
export interface ProvisionPaths {
	/** Default /etc/passwd. */
	passwd?: string;
	/** Default /etc/group. */
	group?: string;
}

/** One line's colon-separated fields; field 3 is the numeric id. */
function numericIdInLine(line: string): number | null {
	const fields = line.split(":");
	const id = Number(fields[2]);
	return fields.length >= 3 && Number.isInteger(id) ? id : null;
}

function firstFieldName(line: string): string {
	return line.split(":")[0] ?? "";
}

/** The entry names this project's own passwd/group record may carry. */
function ownIdentityNames(id: number): string[] {
	return [`ottr-${id}`, `ottr-${id}-r2`, `ottr-${id}-r3`, `ottr-${id}-r4`];
}

/**
 * Fail closed on an occupied id (OTTR-1193): when an entry with this numeric
 * id already exists, every such entry must be this project's own record —
 * name `ottr-<id>` or `-r2..-r4`, the id itself and, for passwd, this turn
 * home. An unrelated account at the hashed id would run the project's turns
 * under that principal and let it read the 0700 turn home, so any other
 * entry throws, mirroring provisionName's name-conflict behavior. Returns
 * true only when the id is free and provisioning must add the entry.
 */
function idFreeOrOwn(
	content: string,
	id: number,
	home: string | null,
): boolean {
	let occupied = false;
	for (const line of content.split("\n")) {
		if (numericIdInLine(line) !== id) continue;
		occupied = true;
		const fields = line.split(":");
		const name = fields[0] ?? "";
		if (
			!ownIdentityNames(id).includes(name) ||
			(home !== null && fields[5] !== home)
		) {
			throw new Error(
				`turn-uid: id ${id} is held by an unrelated account ${JSON.stringify(name)}; refusing to share the project identity`,
			);
		}
	}
	return !occupied;
}

/**
 * A passwd/group entry name for the uid: `ottr-<uid>`, falling back to `-r2`
 * through `-r4` when that exact name is already bound to a different id. All
 * four taken fails the run (fail closed): provisioning must never reuse a
 * name that maps to another uid.
 */
function provisionName(content: string, uid: number): string {
	for (const name of ownIdentityNames(uid)) {
		const bound = content
			.split("\n")
			.find((line) => firstFieldName(line) === name);
		if (bound === undefined || numericIdInLine(bound) === uid) return name;
	}
	throw new Error(
		`turn-uid: no free passwd/group name for uid ${uid} (ottr-${uid}, -r2..-r4 all taken)`,
	);
}

/**
 * Passwd and group entries for one project uid (OTTR-1184): idempotent,
 * fail closed. Group entry first, then passwd entry, so a passwd entry never
 * names a gid the group file lacks.
 */
export function ensureProjectIdentity(
	project: string,
	ids: TurnIdentity,
	turnHome: TurnHome,
	paths: ProvisionPaths = {},
): void {
	assertProjectSegment(project);
	const uid = String(ids.uid);
	const gid = String(ids.gid);

	const groupPath = paths.group ?? "/etc/group";
	const groupContent = existsSync(groupPath)
		? readFileSync(groupPath, "utf8")
		: "";
	if (idFreeOrOwn(groupContent, ids.gid, null)) {
		const name = provisionName(groupContent, ids.gid);
		appendIdentityLine(groupPath, groupContent, `${name}:x:${gid}:`);
	}

	const passwdPath = paths.passwd ?? "/etc/passwd";
	const passwdContent = existsSync(passwdPath)
		? readFileSync(passwdPath, "utf8")
		: "";
	if (idFreeOrOwn(passwdContent, ids.uid, turnHome.home)) {
		const name = provisionName(passwdContent, ids.uid);
		appendIdentityLine(
			passwdPath,
			passwdContent,
			`${name}:x:${uid}:${gid}:Ottr turn uid for ${project}:${turnHome.home}:/bin/false`,
		);
	}
}

/** Append one entry, guarding a missing trailing newline on the snapshot. */
function appendIdentityLine(path: string, content: string, line: string): void {
	const prefix = content !== "" && !content.endsWith("\n") ? "\n" : "";
	appendFileSync(path, `${prefix}${line}\n`);
}

/**
 * Strip inherited git identity env overrides and pin the project identity
 * through GIT_CONFIG_GLOBAL (OTTR-1184): env ident vars beat every git config
 * scope, so a turn's own env must never carry them; the project identity
 * rides a daemon-owned config file whose [user] is only the fallback — the
 * included turn-home gitconfig (OTTR-693) and repo-local config still win.
 */
export function applyTurnGitEnv(
	env: Record<string, string | undefined>,
	project: string,
	turnHome: TurnHome,
): void {
	delete env.GIT_AUTHOR_NAME;
	delete env.GIT_AUTHOR_EMAIL;
	delete env.GIT_COMMITTER_NAME;
	delete env.GIT_COMMITTER_EMAIL;

	// Git uses the ident verbatim in commits; the display name keeps only
	// printable, non-bracket characters, the email only a safe local-part slug.
	const name = `${project
		.replace(/[\p{Cc}<>]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()} turn`.slice(0, 100);
	const slug =
		project.replace(/[^\p{L}\p{N}._-]/gu, "-").slice(0, 64) || "project";
	const email = `ottr+${slug}@localhost`;

	const homePath =
		typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : turnHome.home;
	const gitconfigPath = join(turnHome.provision, "gitconfig");
	writeFileSync(
		gitconfigPath,
		`# Project turn identity (OTTR-1184): classic isolated turns point GIT_CONFIG_GLOBAL
# here. The [user] section below is only the fallback for a turn home without
# its own git identity: the include comes after it, so keys in the turn home's
# .gitconfig win (OTTR-693), and repo-local config wins over both.
[user]
	name = ${name}
	email = ${email}

[include]
	path = ${homePath}/.gitconfig
`,
	);
	env.GIT_CONFIG_GLOBAL = gitconfigPath;
}

/** The soft RLIMIT_NPROC floor a daemon passes to its children (OTTR-1184). */
const FORK_CAPACITY_FLOOR = 4096;

const RLIMIT_NPROC = 6;
const UNLIMITED = 18446744073709551615n;

/** setrlimit(RLIMIT_NPROC) through libc; loaded once per process. */
let setrlimit: ((resource: number, limits: BigUint64Array) => void) | null =
	null;
function libcSetrlimit(): (resource: number, limits: BigUint64Array) => void {
	if (setrlimit === null) {
		const lib = dlopen(`libc.${suffix}`, {
			setrlimit: {
				args: [FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
		});
		const symbol = lib.symbols.setrlimit;
		setrlimit = (resource, limits) => {
			const rc = symbol(resource, ptr(limits));
			if (rc !== 0) {
				throw new Error(`setrlimit(RLIMIT_NPROC) failed, errno ${rc}`);
			}
		};
	}
	return setrlimit;
}

function parseMaxProcesses(
	content: string,
): { soft: number; hard: number } | null {
	for (const line of content.split("\n")) {
		const fields = line.split(/\s+/);
		if (fields[0] !== "Max" || fields[1] !== "processes") continue;
		const parse = (field: string | undefined): number | null => {
			if (field === "unlimited") return Infinity;
			const value = Number(field);
			return Number.isInteger(value) && value >= 0 ? value : null;
		};
		// 1-based fields: Max(1) processes(2) soft(3) hard(4).
		const soft = parse(fields[2]);
		const hard = parse(fields[3]);
		if (soft === null || hard === null) return null;
		return { soft, hard };
	}
	return null;
}

/**
 * Boot check that the daemon's children can fork (OTTR-1184): raises the soft
 * RLIMIT_NPROC the daemon passes to its children when it sits below the
 * floor. Returns a boot note line, or null when nothing changed.
 */
export function ensureForkCapacity(
	deps: {
		limitsPath?: string;
		setLimit?: (soft: bigint, hard: bigint) => void;
		floor?: number;
	} = {},
): string | null {
	const limitsPath = deps.limitsPath ?? "/proc/self/limits";
	const floor = deps.floor ?? FORK_CAPACITY_FLOOR;
	let parsed: { soft: number; hard: number } | null;
	try {
		parsed = parseMaxProcesses(readFileSync(limitsPath, "utf8"));
	} catch {
		parsed = null;
	}
	if (parsed === null) {
		return `fork capacity: could not read max processes from ${limitsPath}`;
	}
	const { soft, hard } = parsed;
	if (soft === Infinity) return null;
	if (soft >= floor) return null;
	const target = hard === Infinity ? floor : Math.min(floor, hard);
	if (target <= soft) return null;
	try {
		const raise =
			deps.setLimit ??
			((limitSoft, limitHard) =>
				libcSetrlimit()(
					RLIMIT_NPROC,
					new BigUint64Array([BigInt(limitSoft), BigInt(limitHard)]),
				));
		raise(BigInt(target), hard === Infinity ? UNLIMITED : BigInt(hard));
	} catch (cause) {
		return `fork capacity: raise failed: ${String(cause)}`;
	}
	return `fork capacity: max processes soft ${soft} -> ${target}`;
}
