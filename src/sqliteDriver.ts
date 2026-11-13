import { pathToFileURL } from "node:url";
import { SQL } from "bun";

export interface SQLiteChanges {
	changes: number;
	lastInsertRowid: number | bigint;
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function exactInteger(value: number | bigint): number | bigint {
	return typeof value === "bigint" &&
		value >= -MAX_SAFE_INTEGER &&
		value <= MAX_SAFE_INTEGER
		? Number(value)
		: value;
}

/** Require an exact integer for public store APIs that return numbers. */
export function sqliteNumber(value: number | bigint): number {
	const exact = exactInteger(value);
	if (typeof exact !== "number" || !Number.isSafeInteger(exact))
		throw new RangeError("SQLite integer exceeds the supported number range");
	return exact;
}

/** One Bun.SQL SQLite connection. StoreQueue owns operation and transaction order. */
export class SQLiteDatabase {
	private readonly sql: SQL;

	constructor(path: string) {
		this.sql = new SQL({
			adapter: "sqlite",
			// A filename is a literal path, not a SQLite URL with query options.
			filename: path === ":memory:" ? path : pathToFileURL(path),
			safeIntegers: true,
		});
	}

	query<Row = Record<string, unknown>, Params extends unknown[] = unknown[]>(
		text: string,
	) {
		return {
			get: async (...params: Params): Promise<Row | null> => {
				const rows = await this.rows<Row>(text, params);
				return rows[0] ?? null;
			},
			all: (...params: Params): Promise<Row[]> => this.rows<Row>(text, params),
			run: (...params: Params): Promise<SQLiteChanges> =>
				this.run(text, params),
		};
	}

	private async rows<Row>(text: string, params: unknown[]): Promise<Row[]> {
		const rows = await this.sql.unsafe<Record<string, unknown>[]>(text, params);
		for (const row of rows) {
			for (const key of Object.keys(row)) {
				const value = row[key];
				if (typeof value === "bigint") row[key] = exactInteger(value);
			}
		}
		return rows as Row[];
	}

	async run(text: string, params: unknown[] = []): Promise<SQLiteChanges> {
		const result = await this.sql.unsafe(text, params);
		const id = result.lastInsertRowid;
		if (id !== null && typeof id !== "number" && typeof id !== "bigint")
			throw new TypeError("SQLite returned an invalid lastInsertRowid");
		return {
			changes: result.affectedRows,
			lastInsertRowid: id === null ? 0 : exactInteger(id),
		};
	}

	async exec(text: string): Promise<void> {
		await this.sql.unsafe(text).simple();
	}

	async rollback(): Promise<void> {
		try {
			await this.exec("ROLLBACK");
		} catch (error) {
			// RAISE(ROLLBACK) and SQLITE_FULL can end the transaction themselves.
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "SQLITE_ERROR" &&
				error.message === "cannot rollback - no transaction is active"
			)
				return;
			throw error;
		}
	}

	async close(): Promise<void> {
		await this.sql.close();
	}
}
