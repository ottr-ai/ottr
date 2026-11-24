import { createHash } from "node:crypto";
import { retitleBareLeadTitles } from "./auditLeads.ts";
import {
	getPostgresDatabase,
	type PostgresDatabase,
} from "./postgresDriver.ts";

export function projectSchemaName(name: string): string {
	const stem = name
		.toLowerCase()
		.replace(/[^a-z0-9_]/gu, "_")
		.slice(0, 48);
	const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
	return `p_${stem}_${hash}`;
}

function quotedSchema(schema: string): string {
	if (
		schema.length > 63 ||
		/[^a-z0-9_]/.test(schema) ||
		(schema !== "ottr_global" &&
			!/^p_[a-z0-9_]{0,48}_[a-f0-9]{12}$/.test(schema))
	)
		throw new Error("Invalid PostgreSQL schema identifier");
	return `"${schema}"`;
}

export type PostgresMigration = (db: PostgresDatabase) => Promise<void>;

/** Each step and its version record share one retry-safe transaction. */
export async function applyPostgresMigrations(
	db: PostgresDatabase,
	steps: readonly PostgresMigration[],
): Promise<void> {
	quotedSchema(db.schema);
	const queue = db.createQueue();
	await queue.transaction(async () => {
		await db.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY)",
		);
	});
	for (let index = 0; index < steps.length; index++) {
		const version = index + 1;
		await queue.transaction(async () => {
			const applied = await db
				.query<{ version: number }, [number]>(
					"SELECT version FROM schema_migrations WHERE version = ?",
				)
				.get(version);
			if (applied !== null) return;
			await steps[index]!(db);
			await db.run("INSERT INTO schema_migrations (version) VALUES (?)", [
				version,
			]);
		});
	}
}

/** Import calls this after explicit IDs, before ordinary generated inserts. */
export async function reseedPostgresIdentities(
	db: PostgresDatabase,
): Promise<void> {
	const schema = quotedSchema(db.schema);
	await db.createQueue().transaction(async () => {
		for (const table of [
			"turns",
			"events",
			"pr_review_runs",
			"review_findings",
		]) {
			const maximum = await db
				.query<{ id: number | bigint | null }, []>(
					`SELECT MAX(id) AS id FROM ${schema}."${table}"`,
				)
				.get();
			const id = maximum?.id == null ? 0n : BigInt(maximum.id);
			await db
				.query(
					"SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence(?, 'id'), ?, ?)",
				)
				.get(`${db.schema}.${table}`, id > 0n ? id : 1n, id > 0n);
		}
	});
}

const globalMigrations: readonly PostgresMigration[] = [
	async (db) => {
		await db.exec(
			"CREATE TABLE kv (key text PRIMARY KEY, value text NOT NULL)",
		);
		await db.exec(
			"CREATE TABLE project_registry (project_name text PRIMARY KEY, schema_name text NOT NULL UNIQUE)",
		);
	},
];

export async function initializeGlobalSchema(
	db: PostgresDatabase,
): Promise<void> {
	if (db.schema !== "ottr_global")
		throw new Error("Invalid global PostgreSQL schema");
	await db.createQueue().transaction(async () => {
		await db.exec('CREATE SCHEMA IF NOT EXISTS "ottr_global"');
	});
	await applyPostgresMigrations(db, globalMigrations);
}

export async function initializeProjectSchema(
	db: PostgresDatabase,
	exactProjectName: string,
): Promise<void> {
	const schema = projectSchemaName(exactProjectName);
	if (schema !== db.schema)
		throw new Error("PostgreSQL project schema identity mismatch");
	const identifier = quotedSchema(schema);
	const global = await getPostgresDatabase("ottr_global");
	try {
		await initializeGlobalSchema(global);
		await db.createQueue().transaction(async () => {
			const registrations = await global
				.query<{ project_name: string; schema_name: string }, [string, string]>(
					"SELECT project_name, schema_name FROM project_registry WHERE project_name = ? OR schema_name = ?",
				)
				.all(exactProjectName, schema);
			if (
				registrations.some(
					(row) =>
						row.project_name !== exactProjectName || row.schema_name !== schema,
				)
			)
				throw new Error("PostgreSQL project registry conflict");
			const existing = await db
				.query<{ nspname: string }, [string]>(
					"SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ?",
				)
				.get(schema);
			if (registrations.length === 0) {
				if (existing !== null)
					throw new Error("PostgreSQL project schema has no registry identity");
				await global.run(
					"INSERT INTO project_registry (project_name, schema_name) VALUES (?, ?)",
					[exactProjectName, schema],
				);
				await db.exec(`CREATE SCHEMA ${identifier}`);
			} else if (existing === null) {
				throw new Error("PostgreSQL registered project schema is absent");
			}
		});
	} finally {
		await global.close();
	}
	await applyPostgresMigrations(db, projectMigrations);
}

export type ApplicationSchema = ReadonlyMap<string, readonly string[]>;
const comparisonExceptions: Record<string, true> = {
	learnings: true,
	sqlite_sequence: true,
	project_registry: true,
	schema_migrations: true,
};

/** Compare exact application names, never prefixes that can hide new tables. */
export function applicationSchemaDifferences(
	expected: ApplicationSchema,
	actual: ApplicationSchema,
): string[] {
	const differences: string[] = [];
	const tables = new Set([...expected.keys(), ...actual.keys()]);
	for (const table of [...tables].sort()) {
		if (Object.hasOwn(comparisonExceptions, table)) continue;
		const wanted = expected.get(table);
		const found = actual.get(table);
		if (wanted === undefined || found === undefined) {
			differences.push(
				`${table}: ${wanted === undefined ? "unexpected" : "missing"} table`,
			);
			continue;
		}
		for (const column of new Set([...wanted, ...found])) {
			if (!wanted.includes(column))
				differences.push(`${table}.${column}: unexpected column`);
			if (!found.includes(column))
				differences.push(`${table}.${column}: missing column`);
		}
	}
	return differences;
}

/** The project schema's numbered steps, in order; version = index + 1. Exported for
 *  src/postgresSchema.test.ts, which runs them against a recording stub. */
export const projectMigrations: readonly PostgresMigration[] = [
	async (db) => {
		for (const statement of projectStepOne) await db.exec(statement);
		await db.run(
			"INSERT INTO settings (key, value) VALUES ('task-insertion-ordinal', '0')",
		);
		const schema = quotedSchema(db.schema);
		await db.exec(`CREATE FUNCTION ${schema}.allocate_task_insertion_ordinal() RETURNS trigger
		LANGUAGE plpgsql AS $ordinal$
		DECLARE current_ordinal bigint;
		BEGIN
			SELECT CAST(value AS bigint) INTO STRICT current_ordinal FROM ${schema}.settings
				WHERE key = 'task-insertion-ordinal' FOR UPDATE;
			IF NEW.insertion_ordinal IS NULL THEN
				IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Invalid task insertion ordinal'; END IF;
				NEW.insertion_ordinal := current_ordinal + 1;
			END IF;
			IF NEW.insertion_ordinal <= 0 THEN RAISE EXCEPTION 'Invalid task insertion ordinal'; END IF;
			IF NEW.insertion_ordinal > current_ordinal THEN
				UPDATE ${schema}.settings SET value = CAST(NEW.insertion_ordinal AS text)
					WHERE key = 'task-insertion-ordinal';
			END IF;
			RETURN NEW;
		END; $ordinal$`);
		await db.exec(`CREATE TRIGGER tasks_insertion_ordinal_insert BEFORE INSERT OR UPDATE OF insertion_ordinal
		ON ${schema}.tasks FOR EACH ROW EXECUTE FUNCTION ${schema}.allocate_task_insertion_ordinal()`);
	},
	// posted_via landed with the board's automatic PR review posts
	// (docs/specs/pr-review-auto-post.md): the same additive convergence the SQLite
	// ProjectStore.addColumn path runs. Step 1 keeps the d4a617f oracle untouched, so a
	// fresh database gets the column from this step too. Null reads as "not posted by
	// this build", the state of every older row.
	async (db) => {
		for (const statement of projectStepTwo) await db.exec(statement);
	},
	// OTTR-1164: retitle open lead cards that still carry the bare "Needs
	// validation" tag as their whole title, from the stored prompt — the same
	// step the SQLite convergence runs in ProjectStore.open. No-op on a fresh
	// database (no rows yet); idempotent afterwards.
	async (db) => {
		await retitleBareLeadTitles(db);
	},
	// Preserve versions 1–3; converge both fresh and existing project schemas with
	// SQLite's outside-issue provenance and code-scanning alert storage. LIMIT 1
	// matches SQLite's scalar lookup when multiple imports reference one card.
	// OTTR-1331: the numbered step carries the deployed index shape —
	// idx_code_scan_alert_task on (task_id) and idx_code_scan_alert_card_filed
	// on (card_filed_at); the repair step at the end of this list rebuilds
	// databases created while the second index was mis-shaped onto (task_id).
	async (db) => {
		for (const statement of projectStepFour) await db.exec(statement);
	},
	// OTTR-1267 agent-data sync gate records (docs/specs/agent-data-sync-gate.md):
	// the same additive convergence the SQLite ProjectStore.addColumn path runs.
	// NOT NULL DEFAULT '[]' so every older row reads as "no gate run yet".
	async (db) => {
		await db.exec(
			"ALTER TABLE tasks ADD COLUMN sync_gate_log text NOT NULL DEFAULT '[]'",
		);
	},
	// fixed_threads landed with the re-review's fixed-finding verdicts
	// (docs/specs/pr-reviews.md "Resolve fixed threads"): the same additive
	// convergence the SQLite ProjectStore.addColumn path runs. Step 1 keeps the
	// d4a617f oracle untouched, so a fresh database gets the column from this step
	// too. Null reads as "no re-review verdicts", the state of every older row.
	async (db) => {
		await db.exec("ALTER TABLE pr_review ADD COLUMN fixed_threads text");
	},
	// OTTR-1331: databases created or upgraded while step 4 mis-shaped
	// idx_code_scan_alert_card_filed onto (task_id) carry the task index twice
	// and lack the card_filed_at index. Rebuild only that wrong shape; deployed
	// databases with the correct definition skip the drop, and fresh installs
	// reach this step with the correct shape already in place.
	async (db) => {
		const wrong = await db
			.query<{ indexdef: string }, [string]>(
				"SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = ? AND indexname = 'idx_code_scan_alert_card_filed'",
			)
			.get(db.schema);
		if (wrong === null || !wrong.indexdef.includes("(task_id)")) return;
		await db.exec(
			`DROP INDEX ${quotedSchema(db.schema)}."idx_code_scan_alert_card_filed"`,
		);
		await db.exec(
			"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at)",
		);
	},
	// OTTR-1252: the lead wait marker — the same convergence the SQLite open runs
	// (docs/specs/lead-waits-validation.md). Step 1 keeps the column on fresh
	// databases; this step adds it to schemas from before waiting leads existed
	// and moves their backlog leads into the waiting form. Idempotent: only
	// stage-backlog rows match, so a converged lead (now todo) and every done or
	// cancelled row never match again, and queued_at is never restamped. The
	// 'Needs-validation lead questions' prefix does not match (the hyphen), so
	// the question cards stay untouched.
	async (db) => {
		await db.exec(
			"ALTER TABLE tasks ADD COLUMN waits_validation bigint NOT NULL DEFAULT 0",
		);
		await db.run(`UPDATE tasks SET stage = 'todo', state = 'queued',
			waits_validation = 1, queued_at = updated_at
		WHERE stage = 'backlog' AND cancelled_at IS NULL
			AND prompt LIKE 'Needs validation%'`);
	},
];

/** How many versioned steps the store's own project migrations carry. The PG
 * tests probe rollback behavior on the next free version, so their probe steps
 * never collide with a version the store already recorded. */
export const projectMigrationCount = projectMigrations.length;

export const projectStepTwo: readonly string[] = [
	"ALTER TABLE pr_review ADD COLUMN posted_via text",
];

// Step 4's convergence statements: outside-issue provenance plus the
// code_scan_alert table with the deployed index shape (OTTR-1331). Kept as
// data so src/postgresSchema.test.ts can scan the surface it converges on.
export const projectStepFour: readonly string[] = [
	`ALTER TABLE tasks ADD COLUMN source_issue text`,
	`UPDATE tasks SET source_issue = (
		SELECT CAST(w.number AS text) FROM issue_watch w WHERE w.task_id = tasks.id
		LIMIT 1
	) WHERE source_issue IS NULL
		AND EXISTS (SELECT 1 FROM issue_watch w WHERE w.task_id = tasks.id)`,
	`UPDATE tasks SET source_issue = (
		SELECT j.issue_key FROM jira_imports j WHERE j.task_id = tasks.id
		LIMIT 1
	) WHERE source_issue IS NULL
		AND EXISTS (SELECT 1 FROM jira_imports j WHERE j.task_id = tasks.id)`,
	`CREATE TABLE code_scan_alert (
		number bigint PRIMARY KEY, rule text NOT NULL, task_id text NOT NULL,
		severity text NOT NULL, path text NOT NULL, line bigint NOT NULL,
		url text NOT NULL, message text NOT NULL,
		skipped bigint NOT NULL DEFAULT 0 CHECK (skipped IN (0,1)),
		filed_at bigint NOT NULL, card_filed_at bigint NOT NULL
	)`,
	"CREATE INDEX idx_code_scan_alert_task ON code_scan_alert (task_id)",
	"CREATE INDEX idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at)",
];

// Step 1 maps the fully opened d4a617f SQLite oracle plus insertion_ordinal.
export const projectStepOne: readonly string[] = [
	`CREATE TABLE ask_drafts (
		task_id text PRIMARY KEY, fp text NOT NULL, answers text NOT NULL, at bigint NOT NULL
	)`,
	`CREATE TABLE events (
		id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
		at bigint NOT NULL, task_id text,
		kind text NOT NULL CHECK (kind IN ('create','stage','state','error')),
		from_value text, to_value text, detail text
	)`,
	`CREATE TABLE fork_branch (
		fork_id bigint NOT NULL, branch_hash text NOT NULL, branch text NOT NULL,
		head text, analyzed_head text, first_pending_at bigint, last_run_at bigint,
		last_error text, retries bigint NOT NULL DEFAULT 0, hold_prs text, hold_base text,
		PRIMARY KEY (fork_id, branch_hash)
	)`,
	`CREATE TABLE fork_hold (
		fork_id bigint NOT NULL, branch_hash text NOT NULL, sha text NOT NULL,
		pr bigint NOT NULL, pr_head text NOT NULL,
		released bigint NOT NULL DEFAULT 0 CHECK (released IN (0,1)),
		PRIMARY KEY (fork_id, branch_hash, sha)
	)`,
	`CREATE TABLE fork_runs (started_at bigint NOT NULL, fork_id bigint NOT NULL)`,
	`CREATE TABLE issue_watch (
		number bigint PRIMARY KEY, task_id text,
		labelled bigint NOT NULL DEFAULT 0, filed_at bigint NOT NULL
	)`,
	`CREATE TABLE jira_imports (
		site text NOT NULL, issue_key text NOT NULL, task_id text NOT NULL,
		filed_at bigint NOT NULL, PRIMARY KEY (site, issue_key)
	)`,
	`CREATE TABLE pr_review (
		number bigint PRIMARY KEY, task_id text, head text NOT NULL, first_seen_at bigint NOT NULL,
		reviewed_head text, posted_head text, posted_url text, posted_login text, posted_event text,
		state text NOT NULL CHECK (state IN ('open','closed','merged')),
		draft bigint NOT NULL, title text NOT NULL, post_error text, comments_at bigint,
		comments_unseen bigint NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE pr_review_runs (
		id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
		number bigint NOT NULL, started_at bigint NOT NULL, head text NOT NULL,
		done bigint NOT NULL DEFAULT 0, blocking bigint NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE review_findings (
		id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
		card_id text NOT NULL, prompt text NOT NULL, model text, rank bigint,
		security text, created_at bigint NOT NULL, UNIQUE(card_id, prompt)
	)`,
	`CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL)`,
	`CREATE TABLE tasks (
		id text PRIMARY KEY, title text, prompt text,
		stage text NOT NULL CHECK (stage IN ('todo','in_progress','merging','done','backlog')),
		state text NOT NULL CHECK (state IN ('queued','preparing','running','needs_you','idle')),
		needs_reason text, pending_prompt text, branch text, base text, worktree text,
		session_id text, summary text, details text, report text,
		research bigint NOT NULL DEFAULT 0, research_steps text NOT NULL DEFAULT 'unknown',
		created_at bigint NOT NULL, updated_at bigint NOT NULL, queued_at bigint, cancelled_at bigint,
		images text NOT NULL DEFAULT '[]', pending_images text NOT NULL DEFAULT '[]',
		shots text NOT NULL DEFAULT '[]', release_version text, release_notes text, session_title text,
		asked text, gate text, prompt_author text NOT NULL DEFAULT 'user', model text,
		kept_files text NOT NULL DEFAULT '[]', follow_up_of text, push_sha text,
		update_ids text NOT NULL DEFAULT '[]', update_merge_approved bigint NOT NULL DEFAULT 0,
		revision bigint NOT NULL DEFAULT 1, insertion_ordinal bigint,
		commits bigint, done_at bigint, topic text, depends_on text NOT NULL DEFAULT '[]',
		diff_files text, diff_text text, work_check_log text NOT NULL DEFAULT '[]',
		work_check_sendbacks bigint NOT NULL DEFAULT 0, work_check_head text, work_check_report text,
		fork_merge_approved bigint NOT NULL DEFAULT 0, priority text, close_candidate text,
		update_merge_head text, fork_merge_head text, hold_head text, pending_by text,
		push_retries bigint NOT NULL DEFAULT 0, pr_number bigint, pr_url text, pr_head_sha text,
		source_pr_number bigint, source_pr_url text, source_pr_head_ref text, source_pr_head_sha text,
		source_pr_cross_repo bigint NOT NULL DEFAULT 0, source_pr_dependabot bigint NOT NULL DEFAULT 0,
		source_pr_superseded bigint NOT NULL DEFAULT 0, follow_up_pr_number bigint, follow_up_pr_url text,
		pr_watch_at bigint, pending_feedback bigint NOT NULL DEFAULT 0, title_source text,
		kind text NOT NULL DEFAULT 'work', hold_until bigint, hold_provider text, hold_window text,
		hold_attempts bigint NOT NULL DEFAULT 0, hold_set_at bigint, starred bigint NOT NULL DEFAULT 0,
		merge_head text, follow_up_of_project text, context_tokens bigint,
		uncommitted_files text NOT NULL DEFAULT '[]', proposal_summary text,
		findings_checked_at bigint, lead_at_done bigint, validated_at bigint,
		waits_validation bigint NOT NULL DEFAULT 0,
		ci_pr_answered_key text, ci_pr_answered_info text
	)`,
	`CREATE TABLE trending_verdict (
		repo text PRIMARY KEY,
		verdict text NOT NULL CHECK (verdict IN ('filed','no_fit','deferred')),
		reason text NOT NULL, rejected_by_user bigint NOT NULL DEFAULT 0,
		first_seen_at bigint NOT NULL, judged_at bigint NOT NULL,
		scout_card_id text, proposal_card_id text
	)`,
	`CREATE TABLE turns (
		id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, task_id text NOT NULL,
		kind text NOT NULL CHECK (kind IN ('work','merge')), prompt text NOT NULL,
		input text, input_by text, started_at bigint NOT NULL, ended_at bigint, pid bigint,
		exit_code bigint, outcome text, summary text, details text, question text, error text,
		model text, dispatched_model text, layer text, ran_on text, tokens_in bigint,
		tokens_out bigint, cache_read bigint, cache_write bigint, cost double precision, log_offset bigint
	)`,
	"CREATE INDEX idx_events_at ON events (at)",
	"CREATE INDEX idx_events_task ON events (task_id)",
	"CREATE INDEX idx_fork_runs_at ON fork_runs (started_at)",
	"CREATE INDEX idx_issue_watch_filed_at ON issue_watch (filed_at)",
	"CREATE INDEX idx_pr_review_runs_at ON pr_review_runs (started_at)",
	"CREATE UNIQUE INDEX idx_tasks_insertion_ordinal ON tasks (insertion_ordinal)",
	"CREATE INDEX idx_turns_task_id ON turns (task_id)",
];
