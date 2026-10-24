// Single-instance guard for the tracker's SQLite files: exactly one live opener
// per db file. Incident 2026-10-06: three `bun src/server.ts` processes shared
// one tasks.db for days and two schedulers raced the same tasks. Shape:
// `PRAGMA locking_mode = EXCLUSIVE` — SQLite itself holds the file until the
// connection closes, and the OS drops the lock even on SIGKILL, so a crashed
// server never blocks the next boot and no pid/hostname bookkeeping is needed.

import { Database } from "bun:sqlite";

/** Thrown when a live holder already owns the db file. The holder pid is
 * unknowable under the exclusive lock; find it with lsof/fuser on the file. */
export class StoreLockedError extends Error {
	constructor(
		readonly dbPath: string,
		cause: unknown,
	) {
		super(
			`${dbPath} is held by another live instance; refusing to open a second instance (${String(cause)})`,
			{ cause },
		);
		this.name = "StoreLockedError";
	}
}

/** True when `pid` names a live process; callers act only on proven-dead pids. EPERM (a foreign
 * process signal 0 may not touch) counts as alive. ponytail: no Windows pid-reuse guard — a reused
 * pid can mask a loss until the real exit surfaces; per-tick process start-time lookups only pay
 * if that race ever bites in practice. */
export function pidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

// First try + 3 retries: a simultaneous cold boot on a fresh db can deadlock
// both racers' journal-mode upgrade (measured: busy_timeout alone loses both);
// a retry breaks the symmetry, and once a winner holds the file the remaining
// attempts refuse through StoreLockedError.
const OPEN_ATTEMPTS = 4;

/**
 * Open `dbPath` as the file's only connection (R2-9 shared sequence, R2-10
 * mechanism). EXCLUSIVE locking mode takes the lock at `journal_mode = WAL` and
 * SQLite holds it until close, so a second opener fails fast with
 * StoreLockedError instead of racing a scheduler. This supersedes the old
 * instance_lock row and its pid/hostname/namespace takeover: the OS drops the
 * lock when the holder dies, whatever it was. Trade (accepted 2026-10-12):
 * while held, nothing else can open the file — no sqlite3 CLI, no readonly
 * peek — and the lock-taking write itself fails with SQLITE_BUSY while a
 * holder lives, which is exactly the refusal signal.
 */
export function openLocked(dbPath: string): Database {
	for (let attempt = 0; ; attempt++) {
		const db = new Database(dbPath);
		try {
			// Short timeout during acquisition: a live holder must refuse in
			// ~200 ms, not sit out the operational timeout set below.
			db.exec("PRAGMA busy_timeout = 200");
			db.exec("PRAGMA locking_mode = EXCLUSIVE");
			// The lock-taking write: SQLITE_BUSY while a live holder exists.
			db.exec("PRAGMA journal_mode = WAL");
			// WAL + NORMAL: commits skip the per-commit fsync (Windows ~14 ms each), safe against
			// process crashes; only an OS crash can lose commits since the last checkpoint.
			db.exec("PRAGMA synchronous = NORMAL");
			db.exec("DROP TABLE IF EXISTS instance_lock"); // retired pid-lock row
			db.exec("PRAGMA busy_timeout = 5000");
			return db;
		} catch (err) {
			db.close(); // a refused opener must not leak its handle (rmSync EBUSY in tests)
			const isErr = err instanceof Error;
			const code = isErr && "code" in err ? err.code : undefined;
			const busy =
				code === "SQLITE_BUSY" || (isErr && /locked/i.test(err.message));
			if (!busy) throw err;
			if (attempt === OPEN_ATTEMPTS - 1)
				throw new StoreLockedError(dbPath, err);
			Bun.sleepSync(50 * (attempt + 1) + Math.floor(Math.random() * 50));
		}
	}
}

/** Shared close sequence (R2-9): nothing to release — the OS drops an exclusive
 * lock at close; this exists so both stores keep one named close path. */
export function closeLocked(db: Database): void {
	db.close();
}
