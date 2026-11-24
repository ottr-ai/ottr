// Guard for AGENTS.md hard stop 2's second half: a schema change that converges on
// SQLite must also land on the PostgreSQL migration surface, and the numbered steps
// must actually execute. The PG parity test (src/postgresStore.test.ts) needs a real
// server and skips without a fixture, so a SQLite-only column once passed every local
// gate; this file reads the two schemas' DDL as data and runs the real
// applyPostgresMigrations over a recording database stub, in any container.
import { describe, expect, test } from "bun:test";
import type { PostgresDatabase } from "./postgresDriver.ts";
import {
	applyPostgresMigrations,
	projectMigrationCount,
	projectMigrations,
	projectStepFour,
	projectStepOne,
	projectStepTwo,
} from "./postgresSchema.ts";
import { SCHEMA } from "./store.ts";

/** Column names of one CREATE TABLE body, in order: the first token of each
 *  depth-0 comma group, constraint groups dropped. */
function columnsOfDdl(ddl: string): string[] {
	const body = ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")"));
	const groups: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of body) {
		if (ch === "(") depth += 1;
		if (ch === ")") depth -= 1;
		if (ch === "," && depth === 0) {
			groups.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	groups.push(current);
	return groups
		.map((group) => group.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
		.filter(
			(name) =>
				name !== "" &&
				!["primary", "check", "foreign", "unique", "constraint"].includes(name),
		);
}

function tableColumns(ddl: string, create: string): string[] {
	const start = ddl.indexOf(create);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = ddl.indexOf(");", start);
	return columnsOfDdl(ddl.slice(start, end + 2));
}

/** The pr_review column surface of the numbered steps: the step 1 CREATE TABLE plus
 *  every ALTER TABLE pr_review ADD COLUMN of the later pure-SQL steps. A later step
 *  with only template SQL (schema-qualified functions) must extend this list or the
 *  convergence test below. */
function migratedColumns(): Set<string> {
	const columns = new Set<string>();
	const create = projectStepOne.find((statement) =>
		statement.startsWith("CREATE TABLE pr_review"),
	);
	expect(create).toBeDefined();
	for (const column of columnsOfDdl(create!)) columns.add(column);
	for (const statement of projectStepTwo) {
		const match = statement.match(
			/^ALTER TABLE pr_review ADD COLUMN (?:IF NOT EXISTS )?(\w+)/i,
		);
		if (match !== null) columns.add(match[1]!.toLowerCase());
	}
	// The fixed_threads step's ALTER runs as a single inline exec (no
	// statement list to scan); the step-execution test below proves it
	// really runs.
	columns.add("fixed_threads");
	return columns;
}

/** Index definitions of code_scan_alert in a DDL corpus: index name → sorted
 *  column list, parsed from every CREATE [UNIQUE] INDEX statement. */
function codeScanAlertIndexes(
	corpus: readonly string[],
): Map<string, string[]> {
	const indexes = new Map<string, string[]>();
	for (const match of corpus
		.join("\n")
		.matchAll(
			/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+) ON code_scan_alert \(([^)]+)\)/g,
		))
		indexes.set(
			match[1]!,
			match[2]!
				.split(",")
				.map((column) => column.trim().toLowerCase())
				.sort(),
		);
	return indexes;
}

/** A recording database: applyPostgresMigrations runs its real control flow against
 *  this stub, so the test exercises the migration path, not only the DDL data. */
class MigrationProbeDb {
	readonly schema = "p_probe_000000000000";
	readonly executed: string[] = [];
	readonly applied = new Set<number>();

	/** The stub's indexdef state for the card_filed index, null when absent.
	 *  The default plays the OTTR-1331 wrong-shape state (the card_filed index
	 *  created on (task_id)) as an already-migrated database carries it. exec
	 *  tracks the repair statements, so a test can read the definition the
	 *  migration run leaves behind. */
	cardFiledIndexdef: string | null;

	constructor(
		cardFiledIndexdef:
			| string
			| null = 'CREATE INDEX idx_code_scan_alert_card_filed ON "p_probe_000000000000".code_scan_alert USING btree (task_id)',
	) {
		this.cardFiledIndexdef = cardFiledIndexdef;
	}

	exec(statement: string): void {
		this.executed.push(statement);
		// Track the one index the repair step owns so a test can read the
		// definition the migration run leaves behind.
		if (
			statement ===
			`DROP INDEX "${this.schema}"."idx_code_scan_alert_card_filed"`
		)
			this.cardFiledIndexdef = null;
		if (
			statement ===
				"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at)" ||
			statement ===
				"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (task_id)"
		)
			this.cardFiledIndexdef = statement;
	}

	run(statement: string, args?: unknown[]): void {
		this.executed.push(statement);
		if (
			statement.startsWith("INSERT INTO schema_migrations") &&
			typeof args?.[0] === "number"
		)
			this.applied.add(args[0]);
	}

	query(sql: string): {
		get: (...params: unknown[]) => Promise<unknown>;
		all: () => Promise<unknown[]>;
	} {
		return {
			get: async (...params: unknown[]) => {
				// The pg_indexes probe reads the stub's tracked index state: the
				// stub cannot run pg_catalog, so the repair step's reader decision
				// runs against this staged state.
				if (sql.includes("pg_catalog.pg_indexes"))
					return this.cardFiledIndexdef === null
						? null
						: { indexdef: this.cardFiledIndexdef };
				const version = params[0];
				return typeof version === "number" && this.applied.has(version)
					? { version }
					: null;
			},
			all: async () => [],
		};
	}

	createQueue(): {
		transaction: (work: () => Promise<void>) => Promise<void>;
	} {
		return { transaction: (work) => work() };
	}

	asDatabase(): PostgresDatabase {
		return this as unknown as PostgresDatabase;
	}
}

describe("PostgreSQL migration surface", () => {
	test("every SQLite pr_review column converges on the PostgreSQL steps", () => {
		const expected = tableColumns(
			SCHEMA,
			"CREATE TABLE IF NOT EXISTS pr_review",
		);
		expect(expected).toContain("posted_via");
		expect(expected).toContain("fixed_threads");
		const actual = migratedColumns();
		const missing = expected.filter((column) => !actual.has(column));
		expect(missing).toEqual([]);
	});

	test("code_scan_alert's SQLite indexes converge on the PostgreSQL steps", () => {
		const expected = codeScanAlertIndexes([SCHEMA]);
		const actual = codeScanAlertIndexes([
			...projectStepOne,
			...projectStepTwo,
			...projectStepFour,
		]);
		// The guarded pair itself: the regression created the card_filed index
		// on (task_id), so fresh installs duplicated the task index and lost
		// the card_filed_at one.
		expect(actual.get("idx_code_scan_alert_card_filed")).toEqual([
			"card_filed_at",
		]);
		expect(actual.get("idx_code_scan_alert_task")).toEqual(["task_id"]);
		expect(actual).toEqual(expected);
	});

	test("the numbered steps execute their statements and record their versions", async () => {
		const db = new MigrationProbeDb();
		await applyPostgresMigrations(db.asDatabase(), projectMigrations);
		// Step 2's ALTER really ran: a step that stops consuming its statement
		// list restores the missing-column bug, and this fails.
		expect(db.executed).toContain(
			"ALTER TABLE pr_review ADD COLUMN posted_via text",
		);
		// Step 4's inline ALTER ran the same way: a step that no longer executes
		// its statement restores the missing-column bug, and this fails.
		expect(db.executed).toContain(
			"ALTER TABLE pr_review ADD COLUMN fixed_threads text",
		);
		// Step 4's statement list really ran, and it carries the deployed index
		// shape: an inline step restored wholesale or a re-broken column pair
		// fails this.
		expect(db.executed).toContain(
			"CREATE INDEX idx_code_scan_alert_task ON code_scan_alert (task_id)",
		);
		expect(db.executed).toContain(
			"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at)",
		);
		// A fresh install reaches the repair step with step 4's correct shape
		// already in place: the repair must skip, not rebuild.
		expect(
			db.executed.filter((statement) => statement.startsWith("DROP INDEX")),
		).toEqual([]);
		// Step 1's schema ran ahead of step 2's convergence.
		const alter = db.executed.indexOf(
			"ALTER TABLE pr_review ADD COLUMN posted_via text",
		);
		expect(alter).toBeGreaterThan(0);
		expect(
			db.executed
				.slice(0, alter)
				.some((statement) => statement.startsWith("CREATE TABLE pr_review")),
		).toBe(true);
		// The OTTR-1252 step really ran: the ALTER and the waiting-form UPDATE
		// (step 1 keeps the column on fresh databases, this step converges old
		// schemas; a step that stops consuming its statements fails here).
		expect(db.executed).toContain(
			"ALTER TABLE tasks ADD COLUMN waits_validation bigint NOT NULL DEFAULT 0",
		);
		expect(
			db.executed.some((statement) =>
				statement.includes(
					"WHERE stage = 'backlog' AND cancelled_at IS NULL\n\t\t\tAND validated_at IS NULL",
				),
			),
		).toBe(true);
		// Every step version carries its record; the count derives from the real
		// step list, so a new store step never desyncs the pin.
		expect([...db.applied].sort()).toEqual(
			Array.from({ length: projectMigrationCount }, (_, index) => index + 1),
		);
		// A recorded version skips its step: the re-run only re-ensures the
		// migrations table and executes no step statement.
		db.executed.length = 0;
		await applyPostgresMigrations(db.asDatabase(), projectMigrations);
		expect(
			db.executed.filter((statement) =>
				/ALTER TABLE|CREATE TABLE pr_review|INSERT INTO settings/.test(
					statement,
				),
			),
		).toEqual([]);
	});

	test("the repair skips an already-migrated database whose index is correct or absent", async () => {
		const migrated = (indexdef: string | null) => {
			const db = new MigrationProbeDb(indexdef);
			// Versions 1..6 recorded before the repair step existed: every
			// earlier step skips and only the repair's decision runs.
			for (let version = 1; version < projectMigrationCount; version++)
				db.run("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
			return db;
		};
		const correct = migrated(
			'CREATE INDEX idx_code_scan_alert_card_filed ON "p_probe_000000000000".code_scan_alert USING btree (card_filed_at)',
		);
		await applyPostgresMigrations(correct.asDatabase(), projectMigrations);
		expect(
			correct.executed.filter(
				(statement) =>
					statement.startsWith("DROP INDEX") ||
					statement.startsWith("CREATE INDEX"),
			),
		).toEqual([]);
		const absent = migrated(null);
		await applyPostgresMigrations(absent.asDatabase(), projectMigrations);
		expect(
			absent.executed.filter((statement) => statement.startsWith("DROP INDEX")),
		).toEqual([]);
	});

	test("the repair rebuilds an already-migrated database onto the deployed shape", async () => {
		const db = new MigrationProbeDb(
			'CREATE INDEX idx_code_scan_alert_card_filed ON "p_probe_000000000000".code_scan_alert USING btree (task_id)',
		);
		for (let version = 1; version < projectMigrationCount; version++)
			db.run("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
		// The seeding itself is not part of the migration run under test.
		db.executed.length = 0;
		await applyPostgresMigrations(db.asDatabase(), projectMigrations);
		// Exact run: the migrations table, then the drop, then the deployed
		// definition, then the step's version record. A repair that drops
		// without recreating, recreates the wrong columns, or recreates before
		// the drop, fails this.
		expect(db.executed).toEqual([
			"CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY)",
			`DROP INDEX "${db.schema}"."idx_code_scan_alert_card_filed"`,
			"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at)",
			"INSERT INTO schema_migrations (version) VALUES (?)",
		]);
		expect(db.cardFiledIndexdef).toBe(
			"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at)",
		);
	});
});
