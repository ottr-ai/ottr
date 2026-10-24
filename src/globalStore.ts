// Tracker-global key/value store: one SQLite file under .tasks/ replaces the old
// board-global JSON files (config.json, push-subs.json, seen-answers.json).

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeLocked, openLocked } from "./dblock.ts";

export class GlobalStore {
	/** Set by close(): a second close must not run the lock release on a dead handle. */
	private closed = false;

	private constructor(private db: Database) {}

	static open(root: string): GlobalStore {
		const dir = resolve(root);
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// Keep a fresh checkout's boot from leaving an untracked .tasks dir (mirrors ProjectStore.init).
		const taskIgnore = join(dir, ".tasks", ".gitignore");
		if (!existsSync(taskIgnore)) writeFileSync(taskIgnore, "*\n");
		const dbPath = join(dir, ".tasks", "tracker.db");
		// Shared durability/perf and single-instance sequence with ProjectStore.open
		// (R2-9): WAL + busy_timeout + synchronous NORMAL, then the lock, which
		// throws StoreLockedError naming the live holder.
		const db = openLocked(dbPath);
		db.exec(
			"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		const store = new GlobalStore(db);
		return store;
	}

	get<T>(key: string): T | null {
		try {
			const row = this.db
				.query<{ value: string }, [string]>(
					"SELECT value FROM kv WHERE key = ?",
				)
				.get(key);
			if (row === null) return null;
			return JSON.parse(row.value) as T;
		} catch {
			return null; // missing key or corrupt JSON row: degrade to null
		}
	}

	set(key: string, value: unknown): void {
		this.db
			.query(
				"INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, JSON.stringify(value));
	}

	close(): void {
		if (this.closed) return; // a closed handle must never be used twice
		this.closed = true;
		closeLocked(this.db);
	}
}
