// Scheduled snapshots of the board's SQLite files and the restore of one snapshot
// (docs/specs/db-backup.md). No import of src/store.ts: the caller passes the sources.

import { Database } from "bun:sqlite";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { closeLocked, openLocked, StoreLockedError } from "./dblock.ts";

/** A snapshot is due when the newest one is this old or older. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_KEEP = 7;
const PARTIAL = ".partial";
const TRACKER_FILE = "tracker.db";
/** The record of one snapshot: which databases it holds and which copies failed. */
export const SNAPSHOT_MANIFEST = "snapshot.json";
const PROJECTS_DIR = "projects";
const PROJECT_DB = "tasks.db";
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export type BackupSource = {
	file: string;
	backupTo: (dest: string) => Promise<void>;
};

type Failure = { file: string; error: string };

export type Manifest = { copied: string[]; failed: Failure[] };

export type BackupResult = {
	stamp: string | null;
	copied: string[];
	failed: Failure[];
	pruned: string[];
};

const errorText = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

// lstat: a symlink is never a real dir or file, so no step follows a planted link.
const isRealDir = (path: string): boolean =>
	lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
const isRealFile = (path: string): boolean =>
	lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
const present = (path: string): boolean =>
	lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** UTC `YYYYMMDDTHHMMSSZ`; the fixed width makes the text order equal to the time order. */
export function formatStamp(at: Date): string {
	return `${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** The time of a canonical stamp; null for each other name (`20261340T000000Z` too). */
export function parseStamp(name: string): Date | null {
	const m = STAMP.exec(name);
	if (m === null) return null;
	const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
	if (Number.isNaN(at.getTime())) return null;
	// Some engines roll a date such as February 30 into March: only a round trip is canonical.
	return formatStamp(at) === name ? at : null;
}

function entryNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

/** The complete snapshots in `dir`, newest first: real directories with a canonical stamp name. */
export function listSnapshots(dir: string): string[] {
	return entryNames(dir)
		.filter((name) => parseStamp(name) !== null && isRealDir(join(dir, name)))
		.sort()
		.reverse();
}

function parseKeep(raw: string | undefined, errors: string[]): number {
	if (raw === undefined || raw === "") return DEFAULT_KEEP;
	if (/^\d+$/.test(raw)) return Number(raw);
	errors.push(
		`OTTR_BACKUP_KEEP=${raw} is not an integer of 0 or more: the default ${DEFAULT_KEEP} applies`,
	);
	return DEFAULT_KEEP;
}

function isAtOrBelow(dir: string, root: string): boolean {
	const rel = relative(resolve(root), dir);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The backup dir and the retention count from the env. `keep: 0` means no backups. Only a
 * dir from OTTR_BACKUP_DIR can be refused: the default dir is next to tracker.db, so a
 * snapshot there is exactly as exposed as tracker.db itself.
 */
export function resolveBackup(
	env: Record<string, string | undefined>,
	stateDir: string,
	workerRoots: readonly string[],
): { dir: string; keep: number; errors: string[] } {
	const errors: string[] = [];
	const keep = parseKeep(env.OTTR_BACKUP_KEEP, errors);
	if (!env.OTTR_BACKUP_DIR)
		return { dir: join(resolve(stateDir), ".tasks", "backups"), keep, errors };
	const dir = resolve(env.OTTR_BACKUP_DIR);
	const root = workerRoots.find((r) => isAtOrBelow(dir, r));
	if (root === undefined) return { dir, keep, errors };
	errors.push(
		`OTTR_BACKUP_DIR ${dir} is equal to or below the worker-mounted root ${resolve(root)}: a worker could read the snapshots, so the board makes no backups`,
	);
	return { dir, keep: 0, errors };
}

const projectFile = (name: string): string =>
	`${PROJECTS_DIR}/${name}/${PROJECT_DB}`;

/**
 * The snapshot layout that restoreSnapshot reads: `tracker.db` and `projects/<name>/tasks.db`.
 * `unopened` names the projects whose database the board could not open: each one is a source
 * that fails, so the snapshot records the failure and retention keeps the last good copy.
 */
export function backupSources(
	tracker: { backupTo(dest: string): Promise<void> },
	projects: Iterable<{ name: string; backupTo(dest: string): Promise<void> }>,
	unopened: Iterable<{ name: string; error: string }> = [],
): BackupSource[] {
	const sources: BackupSource[] = [
		{ file: TRACKER_FILE, backupTo: (dest) => tracker.backupTo(dest) },
	];
	for (const project of projects) {
		sources.push({
			file: projectFile(project.name),
			backupTo: (dest) => project.backupTo(dest),
		});
	}
	for (const project of unopened) {
		sources.push({
			file: projectFile(project.name),
			backupTo: async () => {
				throw new Error(
					`the board did not open this database: ${project.error}`,
				);
			},
		});
	}
	return sources;
}

export function backupDue(dir: string, now: Date): boolean {
	const newest = listSnapshots(dir)[0];
	const at = newest === undefined ? null : parseStamp(newest);
	return at === null || now.getTime() - at.getTime() >= BACKUP_INTERVAL_MS;
}

function removeStalePartials(dir: string): void {
	for (const name of entryNames(dir)) {
		if (!name.endsWith(PARTIAL)) continue;
		if (parseStamp(name.slice(0, -PARTIAL.length)) === null) continue;
		rmSync(join(dir, name), { recursive: true, force: true });
	}
}

function isSafeRelative(file: string): boolean {
	return (
		file !== "" && !isAbsolute(file) && !file.split(/[\\/]/).includes("..")
	);
}

function parseFailure(raw: unknown): Failure | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { file, error } = raw as { file?: unknown; error?: unknown };
	if (typeof file !== "string" || !isSafeRelative(file)) return null;
	return typeof error === "string" ? { file, error } : null;
}

function parseManifest(text: string): Manifest | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null; // not JSON: the caller reports a snapshot that cannot be proven complete
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { copied, failed } = raw as { copied?: unknown; failed?: unknown };
	if (!Array.isArray(copied) || !Array.isArray(failed)) return null;
	const files: string[] = [];
	for (const file of copied) {
		if (typeof file !== "string" || !isSafeRelative(file)) return null;
		files.push(file);
	}
	const failures: Failure[] = [];
	for (const entry of failed) {
		const failure = parseFailure(entry);
		if (failure === null) return null;
		failures.push(failure);
	}
	return { copied: files, failed: failures };
}

/**
 * The manifest that runBackup wrote into the snapshot `stamp`. Null when the file is missing
 * or not valid: such a snapshot cannot be proven complete, and each caller must say so.
 */
export function readManifest(dir: string, stamp: string): Manifest | null {
	const path = join(dir, stamp, SNAPSHOT_MANIFEST);
	return isRealFile(path) ? parseManifest(readFileSync(path, "utf8")) : null;
}

async function copySource(
	partial: string,
	source: BackupSource,
): Promise<void> {
	if (!isSafeRelative(source.file))
		throw new Error(`not a relative path inside the snapshot: ${source.file}`);
	const dest = join(partial, source.file);
	// Checked before the copy: the cleanup below must never remove the copy of an earlier source.
	if (present(dest))
		throw new Error(`a second source for the snapshot file ${source.file}`);
	mkdirSync(dirname(dest), { recursive: true });
	try {
		await source.backupTo(dest);
	} catch (err) {
		// A copy that failed its checks must not stay in the snapshot: restore would use it.
		rmSync(dest, { force: true });
		throw err;
	}
}

function prune(dir: string, keep: number): string[] {
	// At least 1: retention never removes the snapshot that this run made.
	const old = listSnapshots(dir).slice(Math.max(keep, 1));
	for (const name of old) rmSync(join(dir, name), { recursive: true });
	return old;
}

/**
 * Writes one snapshot `<dir>/<stamp>/` through `<stamp>.partial/`, then applies retention when
 * all sources passed. Throws when a snapshot with the same stamp exists already.
 */
export async function runBackup(o: {
	dir: string;
	keep: number;
	now: Date;
	sources: BackupSource[];
}): Promise<BackupResult> {
	mkdirSync(o.dir, { recursive: true });
	removeStalePartials(o.dir);
	const stamp = formatStamp(o.now);
	const final = join(o.dir, stamp);
	if (present(final))
		throw new Error(`the snapshot ${stamp} exists already in ${o.dir}`);
	const partial = join(o.dir, `${stamp}${PARTIAL}`);
	mkdirSync(partial);
	const copied: string[] = [];
	const failed: Failure[] = [];
	for (const source of o.sources) {
		try {
			await copySource(partial, source);
			copied.push(source.file);
		} catch (err) {
			failed.push({ file: source.file, error: errorText(err) });
		}
	}
	if (copied.length === 0) {
		rmSync(partial, { recursive: true, force: true });
		return { stamp: null, copied, failed, pruned: [] };
	}
	// Written before the rename: a snapshot with a stamp name always says what it does not hold.
	const manifest: Manifest = { copied, failed };
	writeFileSync(
		join(partial, SNAPSHOT_MANIFEST),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	renameSync(partial, final);
	const pruned = failed.length === 0 ? prune(o.dir, o.keep) : [];
	return { stamp, copied, failed, pruned };
}

/** One scheduler tick. Never throws: the result and each failure go to `log`. */
export async function backupTick(o: {
	dir: string;
	keep: number;
	now: Date;
	sources: () => BackupSource[];
	log: (line: string) => void;
}): Promise<void> {
	if (o.keep <= 0) return;
	try {
		if (!backupDue(o.dir, o.now)) return;
		const result = await runBackup({
			dir: o.dir,
			keep: o.keep,
			now: o.now,
			sources: o.sources(),
		});
		o.log(
			result.stamp === null
				? `backup: no snapshot: all ${result.failed.length} databases failed`
				: `backup: snapshot ${result.stamp}: ${result.copied.length} databases, removed ${result.pruned.length} old snapshots`,
		);
		for (const f of result.failed)
			o.log(`backup: ${f.file} failed: ${f.error}`);
	} catch (err) {
		o.log(`backup: failed: ${errorText(err)}`);
	}
}

type SnapshotFile = { file: string; from: string; project: string | null };

function restorableFiles(root: string): SnapshotFile[] {
	const files: SnapshotFile[] = [];
	const tracker = join(root, TRACKER_FILE);
	if (isRealFile(tracker))
		files.push({ file: TRACKER_FILE, from: tracker, project: null });
	const projects = join(root, PROJECTS_DIR);
	if (!isRealDir(projects)) return files;
	// readdir gives single path segments, so a name cannot point outside the projects dir.
	for (const name of readdirSync(projects).sort()) {
		const from = join(projects, name, PROJECT_DB);
		if (isRealDir(join(projects, name)) && isRealFile(from))
			files.push({ file: projectFile(name), from, project: name });
	}
	return files;
}

/** Throws StoreLockedError when a live board holds `target`. */
function assertNotHeld(target: string): void {
	if (!present(target)) return;
	let db: Database;
	try {
		db = openLocked(target);
	} catch (err) {
		if (err instanceof StoreLockedError) throw err;
		return; // a corrupt target must not stop a restore: the restore moves it aside
	}
	closeLocked(db);
}

function integrityOf(dbPath: string): string {
	const db = new Database(dbPath);
	try {
		const row = db
			.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
			.get();
		return row?.integrity_check ?? "no result";
	} finally {
		db.close();
	}
}

const sidecars = (dbPath: string): string[] => [
	`${dbPath}-wal`,
	`${dbPath}-shm`,
];

function moveAside(target: string, now: Date, movedAside: string[]): void {
	const suffix = `.before-restore-${formatStamp(now)}`;
	const moves = [target, ...sidecars(target)]
		.filter(present)
		.map((from) => ({ from, aside: `${from}${suffix}` }));
	// A rename onto an existing file deletes that file, and the restore deletes no data.
	const taken = moves.find((m) => present(m.aside));
	if (taken !== undefined) throw new Error(`${taken.aside} exists already`);
	for (const m of moves) {
		renameSync(m.from, m.aside);
		movedAside.push(m.aside);
	}
}

function removeCopy(copy: string): void {
	for (const path of [copy, ...sidecars(copy)]) rmSync(path, { force: true });
}

function restoreOne(
	job: { file: string; from: string; to: string },
	now: Date,
	result: {
		restored: { file: string; to: string }[];
		failed: Failure[];
		movedAside: string[];
	},
): void {
	const copy = `${job.to}.restoring`;
	try {
		mkdirSync(dirname(job.to), { recursive: true });
		removeCopy(copy);
		copyFileSync(job.from, copy);
		const check = integrityOf(copy);
		if (check !== "ok") throw new Error(`integrity check failed: ${check}`);
		moveAside(job.to, now, result.movedAside);
		// The check can leave -wal and -shm files: they must not move next to the target.
		for (const path of sidecars(copy)) rmSync(path, { force: true });
		renameSync(copy, job.to);
		result.restored.push({ file: job.file, to: job.to });
	} catch (err) {
		removeCopy(copy);
		result.failed.push({ file: job.file, error: errorText(err) });
	}
}

function writeMarkerIfMissing(marker: string, now: Date): void {
	if (present(marker)) return;
	mkdirSync(dirname(marker), { recursive: true });
	writeFileSync(marker, `${now.toISOString()}\n`);
}

function copyHint(dir: string, stamp: string, file: string): string {
	const other = listSnapshots(dir).find(
		(s) => s !== stamp && isRealFile(join(dir, s, file)),
	);
	return other === undefined
		? "No other snapshot holds a copy"
		: `The newest snapshot with a copy is ${other}: ${join(dir, other, file)}`;
}

/** The databases that the snapshot should hold but does not, from its manifest. */
function missingFiles(dir: string, stamp: string, found: string[]): Failure[] {
	const manifest = readManifest(dir, stamp);
	if (manifest === null) {
		const error = `missing or not valid: the snapshot ${stamp} cannot be proven complete`;
		return [{ file: SNAPSHOT_MANIFEST, error }];
	}
	const missing: Failure[] = [];
	for (const file of manifest.copied) {
		if (found.includes(file)) continue;
		const error = `not in the snapshot ${stamp}, but its manifest lists it. ${copyHint(dir, stamp, file)}`;
		missing.push({ file, error });
	}
	for (const f of manifest.failed) {
		if (found.includes(f.file)) continue;
		const error = `not in the snapshot ${stamp}: the copy failed at backup time (${f.error}). ${copyHint(dir, stamp, f.file)}`;
		missing.push({ file: f.file, error });
	}
	return missing;
}

/**
 * Restores the snapshot `o.stamp`. Throws when the stamp is not a snapshot in `o.dir`, and
 * throws StoreLockedError, before each change, when a live board holds a target. It deletes
 * no database file: it renames an existing target to `<file>.before-restore-<stamp of now>`.
 * `failed` also holds each database that the snapshot's manifest names but the snapshot does
 * not hold: a restore of an incomplete snapshot is never a clean result.
 */
export function restoreSnapshot(o: {
	dir: string;
	stamp: string;
	now: Date;
	trackerDb: string;
	projectDbFor: (name: string) => string | null;
	adoptedMarker: string | null;
}): {
	restored: { file: string; to: string }[];
	manual: { file: string; from: string }[];
	failed: Failure[];
	movedAside: string[];
} {
	const dir = resolve(o.dir);
	if (!listSnapshots(dir).includes(o.stamp))
		throw new Error(`no snapshot ${o.stamp} in ${o.dir}`);
	const manual: { file: string; from: string }[] = [];
	const jobs: { file: string; from: string; to: string }[] = [];
	const files = restorableFiles(join(dir, o.stamp));
	const missing = missingFiles(
		dir,
		o.stamp,
		files.map((f) => f.file),
	);
	for (const f of files) {
		const to = f.project === null ? o.trackerDb : o.projectDbFor(f.project);
		if (to === null) manual.push({ file: f.file, from: f.from });
		else jobs.push({ file: f.file, from: f.from, to });
	}
	for (const job of jobs) assertNotHeld(job.to);
	const result = {
		restored: [] as { file: string; to: string }[],
		manual,
		failed: [] as Failure[],
		movedAside: [] as string[],
	};
	for (const job of jobs) restoreOne(job, o.now, result);
	result.failed.push(...missing);
	if (o.adoptedMarker !== null) writeMarkerIfMissing(o.adoptedMarker, o.now);
	return result;
}
