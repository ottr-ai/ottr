import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	closeLocked,
	openLocked,
	pidAlive,
	StoreLockedError,
	vacuumInto,
} from "./dblock.ts";
import { SQLiteDatabase } from "./sqliteDriver.ts";
import fc from "./test/properties.ts";

const lockModule = import.meta.resolve("./dblock.ts");
const driverModule = import.meta.resolve("./sqliteDriver.ts");
// EOF releases each child. The real timer bounds a failed parent without process signals.
const waitForRelease = `
	const { promise, resolve } = Promise.withResolvers();
	const timer = setTimeout(() => { process.stdin.pause(); resolve(); }, 8000);
	process.stdin.once("end", () => { clearTimeout(timer); resolve(); });
	process.stdin.resume();
	await promise;
`;

async function readReady(stream: ReadableStream<Uint8Array>): Promise<unknown> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done)
				throw new Error(`Holder exited before readiness: ${text}`);
			text += decoder.decode(chunk.value, { stream: true });
		}
		return JSON.parse(text.slice(0, text.indexOf("\n")));
	} finally {
		reader.releaseLock();
	}
}

async function startHolder(path: string, close: boolean) {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
			import { openLocked, closeLocked } from ${JSON.stringify(lockModule)};
			const db = await openLocked(${JSON.stringify(path)});
			await db.exec("CREATE TABLE held (v TEXT); INSERT INTO held VALUES ('holder')");
			const ready = {};
			for (const key of ["busy_timeout", "locking_mode", "journal_mode", "synchronous"])
				ready[key] = await db.query("PRAGMA " + key).get();
			console.log(JSON.stringify(ready));
			${waitForRelease}
			${close ? "await closeLocked(db);" : ""}
			`,
		],
		{ cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		return { child, ready: await readReady(child.stdout) };
	} catch (error) {
		await child.stdin.end();
		await child.exited;
		throw error;
	}
}

async function runChild(code: string) {
	const child = Bun.spawn([process.execPath, "--eval", code], {
		cwd: tmpdir(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return JSON.parse(stdout);
}

async function releaseHolder(child: Bun.PipedSubprocess) {
	await child.stdin.end();
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
}

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

	test("a live child pid is true until its natural exit", async () => {
		const child = Bun.spawn([process.execPath, "--eval", waitForRelease], {
			cwd: tmpdir(),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			expect(pidAlive(child.pid)).toBe(true);
		} finally {
			await releaseHolder(child);
		}
		expect(pidAlive(child.pid)).toBe(false);
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
	test("a second opener refuses while the first connection stays usable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-test-"));
		const dbPath = join(dir, "tasks.db");
		const first = await openLocked(dbPath);
		try {
			await expect(openLocked(dbPath)).rejects.toBeInstanceOf(StoreLockedError);
			await first.run("CREATE TABLE t (v)");
			await first.run("INSERT INTO t VALUES (1)");
			expect(await first.query("SELECT count(*) AS n FROM t").get()).toEqual({
				n: 1,
			});
		} finally {
			await closeLocked(first);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("literal file paths retain question marks, hashes, quotes, and spaces", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-path-"));
		const path = join(dir, "literal ? # ' quote.sqlite");
		const db = await openLocked(path);
		try {
			await db.exec(
				"CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('exact path')",
			);
			expect(existsSync(path)).toBe(true);
		} finally {
			await closeLocked(db);
		}
		const reopened = await openLocked(path);
		try {
			expect(await reopened.query("SELECT v FROM t").get()).toEqual({
				v: "exact path",
			});
		} finally {
			await closeLocked(reopened);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing parent propagates the open error instead of a lock error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-open-error-"));
		try {
			let error: unknown;
			try {
				await openLocked(join(dir, "missing", "tasks.db"));
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(StoreLockedError);
			expect(error).toHaveProperty("code", "SQLITE_CANTOPEN");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a real holder retains PRAGMAs and refuses a real contender promptly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-process-"));
		const path = join(dir, "tasks.db");
		const { child, ready } = await startHolder(path, true);
		try {
			expect(ready).toEqual({
				busy_timeout: { timeout: 5000 },
				locking_mode: { locking_mode: "exclusive" },
				journal_mode: { journal_mode: "wal" },
				synchronous: { synchronous: 1 },
			});
			const contender = await runChild(`
				import { openLocked, closeLocked, StoreLockedError } from ${JSON.stringify(lockModule)};
				const start = performance.now();
				try {
					const db = await openLocked(${JSON.stringify(path)});
					await closeLocked(db);
					throw new Error("Contender unexpectedly acquired the lock");
				} catch (error) {
					if (!(error instanceof StoreLockedError)) throw error;
					console.log(JSON.stringify({
						name: error.name, path: error.dbPath,
						cause: String(error.cause), elapsed: performance.now() - start
					}));
				}
			`);
			expect(contender.name).toBe("StoreLockedError");
			expect(contender.path).toBe(path);
			expect(contender.cause).toMatch(/locked|busy/i);
			// Four 200 ms attempts plus finite retry delays, not four 5000 ms waits.
			expect(contender.elapsed).toBeGreaterThanOrEqual(700);
			expect(contender.elapsed).toBeLessThan(4500);
		} finally {
			await releaseHolder(child);
		}
		const reopened = await openLocked(path);
		try {
			expect(await reopened.query("SELECT v FROM held").get()).toEqual({
				v: "holder",
			});
		} finally {
			await closeLocked(reopened);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);

	test("the acquisition timeout is 200 ms on a real contender connection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-timeout-"));
		const path = join(dir, "tasks.db");
		const { child } = await startHolder(path, true);
		try {
			const result = await runChild(`
				import { SQLiteDatabase } from ${JSON.stringify(driverModule)};
				const db = new SQLiteDatabase(${JSON.stringify(path)});
				try {
					await db.exec("PRAGMA busy_timeout = 200");
					const timeout = await db.query("PRAGMA busy_timeout").get();
					const start = performance.now();
					try {
						await db.query("SELECT * FROM held").all();
						throw new Error("Contender unexpectedly read the locked file");
					} catch (error) {
						if (error.code !== "SQLITE_BUSY") throw error;
						console.log(JSON.stringify({ timeout, elapsed: performance.now() - start }));
					}
				} finally { await db.close(); }
			`);
			expect(result.timeout).toEqual({ timeout: 200 });
			expect(result.elapsed).toBeGreaterThanOrEqual(150);
			expect(result.elapsed).toBeLessThan(1500);
		} finally {
			await releaseHolder(child);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);

	test("natural process exit releases the exclusive lock and retains WAL data", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-natural-exit-"));
		const path = join(dir, "tasks.db");
		const { child } = await startHolder(path, false);
		await releaseHolder(child);
		const db = await openLocked(path);
		try {
			expect(await db.query("PRAGMA journal_mode").get()).toEqual({
				journal_mode: "wal",
			});
			expect(await db.query("SELECT v FROM held").get()).toEqual({
				v: "holder",
			});
		} finally {
			await closeLocked(db);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);
});

describe("vacuumInto", () => {
	test("quote-bearing destinations retain rows, empty tables, and integrity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-vacuum-"));
		const dest = join(dir, "copy with ' quote.sqlite");
		const db = await openLocked(join(dir, "source.db"));
		try {
			await db.exec(`
				CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT, extra TEXT);
				CREATE TABLE "select" (value TEXT);
			`);
			await db
				.query("INSERT INTO rows VALUES (?, ?, ?)")
				.run(1, "O'Brien", null);
			await db
				.query("INSERT INTO rows VALUES (?, ?, ?)")
				.run(2, "Unicode: λ", "[]");
			await vacuumInto(db, dest, ["rows", "select"]);
			const copy = new Database(dest, { readonly: true });
			try {
				expect(copy.query("SELECT * FROM rows ORDER BY id").all()).toEqual([
					{ id: 1, value: "O'Brien", extra: null },
					{ id: 2, value: "Unicode: λ", extra: "[]" },
				]);
				expect(copy.query('SELECT count(*) AS n FROM "select"').get()).toEqual({
					n: 0,
				});
				expect(copy.query("PRAGMA integrity_check").get()).toEqual({
					integrity_check: "ok",
				});
			} finally {
				copy.close();
			}
			// The snapshot does not release or replace the live connection.
			await db
				.query("INSERT INTO rows VALUES (?, ?, ?)")
				.run(3, "after copy", null);
			expect(await db.query("SELECT count(*) AS n FROM rows").get()).toEqual({
				n: 3,
			});
		} finally {
			await closeLocked(db);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an existing destination rejects without overwriting its data", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-vacuum-exists-"));
		const dest = join(dir, "copy.db");
		const db = await openLocked(join(dir, "source.db"));
		try {
			await db.exec("CREATE TABLE t (v); INSERT INTO t VALUES (1)");
			await vacuumInto(db, dest, ["t"]);
			await db.exec("INSERT INTO t VALUES (2)");
			await expect(vacuumInto(db, dest, ["t"])).rejects.toThrow();
			const copy = new Database(dest, { readonly: true });
			try {
				expect(copy.query("SELECT v FROM t").all()).toEqual([{ v: 1 }]);
			} finally {
				copy.close();
			}
		} finally {
			await closeLocked(db);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unsafe table identifiers reject before any destination exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dblock-vacuum-identifier-"));
		const dest = join(dir, "copy.db");
		const db = new SQLiteDatabase(join(dir, "source.db"));
		try {
			await db.exec("CREATE TABLE t (v); INSERT INTO t VALUES (7)");
			await fc.assert(
				fc.asyncProperty(
					fc
						.string()
						.filter(
							(name) =>
								!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.endsWith("\n"),
						),
					async (name) => {
						await expect(vacuumInto(db, dest, [name])).rejects.toThrow(
							"Invalid SQLite table identifier",
						);
						expect(existsSync(dest)).toBe(false);
						expect(await db.query("SELECT v FROM t").get()).toEqual({ v: 7 });
					},
				),
				{ examples: [["t\n"], ["t\r"], ["t; DROP TABLE t; --"]] },
			);
		} finally {
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
