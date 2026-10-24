import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	closeLocked,
	openLocked,
	pidAlive,
	StoreLockedError,
} from "./dblock.ts";

describe("pidAlive", () => {
	test("pid 0 and negatives are dead without probing", () => {
		expect(pidAlive(0)).toBe(false);
		expect(pidAlive(-1)).toBe(false);
		expect(pidAlive(-12345)).toBe(false);
	});

	test("pid 1 is alive", () => {
		expect(pidAlive(1)).toBe(true);
	});

	test("a very large dead pid is false", () => {
		expect(pidAlive(999_999_999)).toBe(false);
	});

	test("a live child pid is true", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			expect(pidAlive(child.pid)).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});

describe("StoreLockedError", () => {
	test("names itself, carries the db path and the cause", () => {
		const cause = new Error("database is locked");
		const err = new StoreLockedError("/tmp/some/tasks.db", cause);
		expect(err.name).toBe("StoreLockedError");
		expect(err.dbPath).toBe("/tmp/some/tasks.db");
		expect(err.cause).toBe(cause);
		expect(err.message).toContain("/tmp/some/tasks.db");
		expect(err.message).toContain("database is locked");
	});
});

describe("openLocked", () => {
	test("a second opener refuses with StoreLockedError while the first keeps working", () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-test-"));
		const dbPath = join(dir, "tasks.db");
		const first = openLocked(dbPath);
		try {
			let err: unknown;
			try {
				openLocked(dbPath);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(StoreLockedError);
			const locked = err as StoreLockedError;
			expect(locked.name).toBe("StoreLockedError");
			expect(locked.dbPath).toBe(dbPath);
			// The cause names the lock-taking write's refusal, not a bare failure.
			expect(String(locked.cause)).toMatch(/locked|busy/i);
			// The first holder is untouched: reads and writes still work.
			first.run("CREATE TABLE IF NOT EXISTS t (v)");
			first.run("INSERT INTO t VALUES (1)");
			expect(first.query("SELECT count(*) AS n FROM t").get()).toEqual({
				n: 1,
			});
		} finally {
			closeLocked(first);
		}
	});
});
