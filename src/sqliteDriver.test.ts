import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabase, sqliteNumber } from "./sqliteDriver.ts";
import fc from "./test/properties.ts";

const root = mkdtempSync(join(tmpdir(), "sqlite-driver-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const decoded = (value: bigint): number | bigint =>
	value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value;

describe("SQLiteDatabase real files", () => {
	test("signed int64 binding and decoding preserve exact values across both drivers", async () => {
		const file = join(root, "integer-boundaries.db");
		const values = [
			MIN_I64,
			-MAX_SAFE - 1n,
			-MAX_SAFE,
			-1n,
			0n,
			1n,
			MAX_SAFE,
			MAX_SAFE + 1n,
			MAX_I64,
		];
		const db = new SQLiteDatabase(file);
		try {
			await db.exec(
				"CREATE TABLE numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER NOT NULL)",
			);
			for (const value of values) {
				const inserted = await db
					.query("INSERT INTO numbers (value) VALUES (?)")
					.run(value);
				expect(inserted.changes).toBe(1);
				expect(
					await db
						.query(
							"SELECT value, CAST(value AS TEXT) AS literal, typeof(value) AS storage FROM numbers WHERE id = ?",
						)
						.get(inserted.lastInsertRowid),
				).toEqual({
					value: decoded(value),
					literal: value.toString(),
					storage: "integer",
				});
			}
		} finally {
			await db.close();
		}
		const oldReader = new Database(file, { readonly: true });
		try {
			expect(
				oldReader
					.query<{ literal: string }, []>(
						"SELECT CAST(value AS TEXT) AS literal FROM numbers ORDER BY id",
					)
					.all()
					.map((row) => row.literal),
			).toEqual(values.map(String));
		} finally {
			oldReader.close();
		}
		const reopened = new SQLiteDatabase(file);
		try {
			expect(
				await reopened.query("SELECT value FROM numbers ORDER BY id").all(),
			).toEqual(values.map((value) => ({ value: decoded(value) })));
		} finally {
			await reopened.close();
		}
	});

	test("fixed-seed signed int64 values retain integer storage and exact decimal text", async () => {
		const db = new SQLiteDatabase(join(root, "integer-property.db"));
		try {
			await db.exec(
				"CREATE TABLE numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER NOT NULL)",
			);
			// The boundary test checks persistence across both readers.
			await db.exec("BEGIN");
			await fc.assert(
				fc.asyncProperty(
					fc.bigInt({ min: MIN_I64, max: MAX_I64 }),
					async (value) => {
						const result = await db.run(
							"INSERT INTO numbers (value) VALUES (?)",
							[value],
						);
						const row = await db
							.query<{
								value: number | bigint;
								literal: string;
								storage: string;
							}>(
								"SELECT value, CAST(value AS TEXT) AS literal, typeof(value) AS storage FROM numbers WHERE id = ?",
							)
							.get(result.lastInsertRowid);
						expect(row).toEqual({
							value: decoded(value),
							literal: value.toString(),
							storage: "integer",
						});
					},
				),
			);
			await db.exec("COMMIT");
		} finally {
			await db.close();
		}
	});

	test("statement metadata distinguishes inserts, duplicate claims, and revision conflicts", async () => {
		const db = new SQLiteDatabase(join(root, "affected-rows.db"));
		try {
			await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
				CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id INTEGER);
				INSERT INTO audit (id) VALUES (100);
				CREATE TRIGGER claim_audit AFTER INSERT ON claims BEGIN INSERT INTO audit (claim_id) VALUES (new.id); END;`);
			const inserted = await db.run("INSERT INTO claims (name) VALUES (?)", [
				"O'Brien λ",
			]);
			expect(inserted).toEqual({ changes: 1, lastInsertRowid: 1 });
			expect(
				await db
					.query("SELECT id, claim_id FROM audit WHERE claim_id IS NOT NULL")
					.all(),
			).toEqual([{ id: 101, claim_id: 1 }]);
			const claim = db.query(
				"INSERT INTO claims (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
			);
			expect((await claim.run("O'Brien λ")).changes).toBe(0);
			const update = db.query(
				"UPDATE claims SET revision = revision + 1 WHERE id = ? AND revision = ?",
			);
			expect((await update.run(1, 1)).changes).toBe(1);
			expect((await update.run(1, 1)).changes).toBe(0);
			expect(
				await db.query("SELECT id, name, revision FROM claims").get(),
			).toEqual({ id: 1, name: "O'Brien λ", revision: 2 });
			expect(
				await db.query("SELECT id FROM claims WHERE id = ?").get(999),
			).toBeNull();
			expect(
				await db.query("SELECT id FROM claims WHERE id = ?").all(999),
			).toEqual([]);
			await expect(
				db.run("INSERT INTO claims (name) VALUES (?)", [null]),
			).rejects.toThrow(/NOT NULL/);
		} finally {
			await db.close();
		}
	});

	test("generated row IDs above the safe number range remain exact bigint metadata", async () => {
		const db = new SQLiteDatabase(join(root, "large-generated-id.db"));
		try {
			await db.exec(
				"CREATE TABLE ids (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)",
			);
			const first = MAX_SAFE + 17n;
			expect(
				await db.run("INSERT INTO ids (id, value) VALUES (?, ?)", [
					first,
					"imported",
				]),
			).toEqual({ changes: 1, lastInsertRowid: first });
			expect(
				await db.run("INSERT INTO ids (value) VALUES (?)", ["generated"]),
			).toEqual({ changes: 1, lastInsertRowid: first + 1n });
			expect(await db.query("SELECT id FROM ids ORDER BY id").all()).toEqual([
				{ id: first },
				{ id: first + 1n },
			]);
		} finally {
			await db.close();
		}
	});

	test("NULL, text, integer flags, large milliseconds, and REAL costs do not change type", async () => {
		const db = new SQLiteDatabase(join(root, "scalar-types.db"));
		try {
			await db.exec(
				"CREATE TABLE scalars (text TEXT, missing TEXT, flag INTEGER, millis INTEGER, cost REAL)",
			);
			const row = {
				text: '["O\'Brien","λ"]',
				missing: null,
				flag: 1,
				millis: 4_294_967_296_123,
				cost: 0.123456789012345,
			};
			await db.run(
				"INSERT INTO scalars VALUES (?, ?, ?, ?, ?)",
				Object.values(row),
			);
			expect(await db.query("SELECT * FROM scalars").get()).toEqual(row);
		} finally {
			await db.close();
		}
	});

	test("rollback restores file data, permits self-rollback, and rejects a closed connection", async () => {
		const db = new SQLiteDatabase(join(root, "rollback.db"));
		try {
			await db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
				INSERT INTO items VALUES (1, 'original');
				CREATE TRIGGER doomed BEFORE INSERT ON items WHEN NEW.value = 'doomed' BEGIN SELECT RAISE(ROLLBACK, 'driver doom'); END;`);
			await db.exec("BEGIN");
			await db.run("UPDATE items SET value = ? WHERE id = ?", ["changed", 1]);
			await db.rollback();
			expect(await db.query("SELECT * FROM items").all()).toEqual([
				{ id: 1, value: "original" },
			]);
			await db.exec("BEGIN");
			await db.run("UPDATE items SET value = ? WHERE id = ?", [
				"changed again",
				1,
			]);
			await expect(
				db.run("INSERT INTO items VALUES (?, ?)", [2, "doomed"]),
			).rejects.toThrow("driver doom");
			await db.rollback();
			expect(await db.query("SELECT * FROM items").all()).toEqual([
				{ id: 1, value: "original" },
			]);
			await db.exec("BEGIN; COMMIT;");
		} finally {
			await db.close();
		}
		await expect(db.rollback()).rejects.toThrow();
	});
});

test("public numeric IDs accept only exact safe integers", () => {
	for (const value of [-MAX_SAFE, -1n, 0n, 1n, MAX_SAFE]) {
		expect(sqliteNumber(value)).toBe(Number(value));
		expect(sqliteNumber(Number(value))).toBe(Number(value));
	}
	for (const value of [
		MIN_I64,
		-MAX_SAFE - 1n,
		MAX_SAFE + 1n,
		MAX_I64,
		NaN,
		Infinity,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])
		expect(() => sqliteNumber(value)).toThrow(RangeError);
});
