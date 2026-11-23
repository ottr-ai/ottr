import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ApplicationSchema,
	applicationSchemaDifferences,
	projectSchemaName,
} from "./postgresSchema.ts";
import {
	createPostgresFixture,
	type PostgresFixture,
	readPostgresTestConfig,
} from "./test/postgres.ts";
import fc from "./test/properties.ts";
import { spawnStoreChild } from "./test/storeChild.ts";

const root = mkdtempSync(join(tmpdir(), "postgres-stores-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const imports = `
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
import { GlobalStore } from ${JSON.stringify(new URL("./globalStore.ts", import.meta.url).href)};
import { getPostgresDatabase, closePostgresBackend } from ${JSON.stringify(new URL("./postgresDriver.ts", import.meta.url).href)};
import { applyPostgresMigrations, projectMigrationCount, projectMigrations, projectSchemaName, reseedPostgresIdentities } from ${JSON.stringify(new URL("./postgresSchema.ts", import.meta.url).href)};
`;

// These exact scenarios run in fresh processes for both backend selections.
const scenarios = String.raw`
const project = join(root, 'Mixed CASE λ project');
const global = await GlobalStore.open(root);
let store = await ProjectStore.init(project);
const db = store.db;
try {
  await global.set('unicode', { text: "O'Brien λ\n", flag: false, empty: null });
  assert.deepEqual(await global.get('unicode'), { text: "O'Brien λ\n", flag: false, empty: null });
  await Promise.all(Array.from({ length: 8 }, () => global.update('counter', value => (value ?? 0) + 1)));
  assert.equal(await global.get('counter'), 8);
  await store.setSettings({ displayName: 'λ', maxParallel: 4, copyExtra: ["O'Brien"] });
  await store.setSettings({ displayName: 'changed' });
  assert.equal((await store.getSettings()).displayName, 'changed');
  assert.equal((await store.getSettings()).maxParallel, 4);
  const first = await store.createTask("O'Brien λ\nprompt", null, 'work', 'z-first');
  const second = await store.createTask('second', null, 'work', 'a-second');
  assert.equal(first.id, 'z-first');
  assert.equal(first.prompt, "O'Brien λ\nprompt");
  assert.equal(first.revision, 1);
  await store.updateTask(first.id, {
    images: ['λ.png', "O'Brien.png"], research: true, starred: true,
    queuedAt: null, report: 'committed',
  });
  await store.transaction(() => db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [4294967296123, first.id]));
  const values = await store.getTask(first.id);
  assert.equal(values.createdAt, 4294967296123);
  assert.equal(values.queuedAt, null);
  assert.equal(values.research, true);
  assert.equal(values.starred, true);
  assert.deepEqual(values.images, ['λ.png', "O'Brien.png"]);
  const beforeRevision = values.revision;
  const update = await store.updateTaskIfCurrent(first.id, { state: 'running' }, beforeRevision);
  const conflict = await store.updateTaskIfCurrent(first.id, { state: 'idle' }, beforeRevision);
  assert.equal(update.ok, true);
  assert.equal(conflict.ok, false);
  assert.equal((await store.getTask(first.id)).state, 'running');
  const events = await store.events();
  assert.equal(events.filter(event => event.kind === 'create').length, 2);
  assert.equal(events.filter(event => event.kind === 'state' && event.from === 'queued' && event.to === 'running').length, 1);
  const turn = await store.startTurn(first.id, 'work', 'turn λ', null, null, null, null, null, null, 4294967296124);
  const nextTurn = await store.startTurn(first.id, 'merge', 'next turn', null);
  assert.ok(nextTurn.id > turn.id);
  assert.equal((await store.listTurns(first.id))[0].id, turn.id);
  await store.finishTurnState(turn.id, { endedAt: 4294967296125, exitCode: 0, error: 'synthetic failure' });
  assert.equal((await store.events()).filter(event => event.kind === 'error' && event.detail === 'synthetic failure').length, 1);
  assert.equal((await store.listTurns(first.id))[0].endedAt, 4294967296125);
  assert.equal((await store.lastSettledTurn(first.id)).exitCode, 0);
  const cost = 0.123456789012345;
  await store.transaction(() => db.run('UPDATE turns SET cost = ?, tokens_in = ? WHERE id = ?', [cost, 4294967296123, turn.id]));
  assert.equal((await store.perfFacts()).turns[0].cost, cost);
  const run = await store.startPrRun(12, 'head-λ', 4294967296123);
  assert.ok((await store.startPrRun(12, 'other-head', 4294967296124)) > run);
  const finding = { prompt: 'finding λ', model: null, rank: null, security: null };
  await store.appendReviewFinding(first.id, finding);
  await store.appendReviewFinding(first.id, finding);
  assert.equal((await store.listReviewFindings(first.id)).length, 1);
  const beforeTasks = (await store.listTasks()).length;
  const beforeEvents = (await store.events()).length;
  const rollback = new Error('application rollback');
  await assert.rejects(store.transaction(async () => {
    await store.createTask('must roll back');
    await store.transaction(async () => {
      await store.updateTask(first.id, { report: 'rolled back' });
    });
    throw rollback;
  }), error => error === rollback);
  assert.equal((await store.listTasks()).length, beforeTasks);
  assert.equal((await store.events()).length, beforeEvents);
  assert.equal(await store.getTaskReport(first.id), 'committed');
  await store.transaction(async () => {
    await store.transaction(async () => store.updateTask(first.id, { title: 'nested commit' }));
  });
  assert.equal((await store.getTask(first.id)).title, 'nested commit');
  for (const fail of [false, true]) {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const writer = store.transaction(async () => {
      await store.updateTask(first.id, { report: 'inside' });
      entered.resolve();
      await release.promise;
      if (fail) throw rollback;
    });
    const outcome = writer.catch(error => error);
    await entered.promise;
    let observed = false;
    const outsider = store.getTaskReport(first.id).then(value => { observed = true; return value; });
    const unrelated = store.createTask('outside transaction');
    // Fake timers cannot complete real driver I/O before the held transaction resumes.
    await Bun.sleep(10);
    assert.equal(observed, false);
    release.resolve();
    assert.equal(await outcome, fail ? rollback : undefined);
    assert.equal(await outsider, fail ? 'committed' : 'inside');
    await unrelated;
    await store.updateTask(first.id, { report: 'committed' });
  }
  await assert.rejects(store.transaction(async () => {
    await db.run("INSERT INTO tasks (id, stage, state, created_at, updated_at) VALUES (?, 'invalid', 'queued', 1, 1)", ['invalid-stage']);
  }));
  assert.equal(await store.getTask('invalid-stage'), null);
  const beforeInvalidUpdate = await store.getTask(first.id);
  await assert.rejects(store.transaction(async () => {
    let rejected = false;
    try { await store.updateTask(first.id, { state: 'invalid' }); } catch { rejected = true; }
    assert.equal(rejected, true);
    await store.createTask('must not escape poisoned transaction');
  }));
  assert.equal((await store.getTask(first.id)).revision, beforeInvalidUpdate.revision);
  await store.createTask('usable after definite constraint rollback');
  const tieA = await store.createTask('tie A', null, 'work', 'z-tie-first');
  const tieB = await store.createTask('tie B', null, 'work', 'a-tie-second');
  await store.transaction(async () => {
    await db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [9000000000000, tieA.id]);
    await db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [9000000000000, tieB.id]);
  });
  assert.deepEqual((await store.listTasks()).slice(0, 2).map(task => task.id), [tieB.id, tieA.id]);
  const ordinal = await db.query('SELECT insertion_ordinal FROM tasks WHERE id = ?').get(tieB.id);
  await store.transaction(() => db.run('DELETE FROM tasks WHERE id = ?', [tieB.id]));
  await store.close();
  store = await ProjectStore.open(project);
  assert.equal(await store.getTaskReport(first.id), 'committed');
  assert.equal((await store.listTurns(first.id))[0].id, turn.id);
  const afterDelete = await store.createTask('after deleted maximum', null, 'work', 'b-tie-third');
  await store.transaction(() => store.db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [9000000000000, afterDelete.id]));
  const afterOrdinal = await store.db.query('SELECT insertion_ordinal FROM tasks WHERE id = ?').get(afterDelete.id);
  assert.ok(BigInt(afterOrdinal.insertion_ordinal) > BigInt(ordinal.insertion_ordinal));
  assert.deepEqual((await store.listTasks()).slice(0, 2).map(task => task.id), [afterDelete.id, tieA.id]);
  const schemaRows = backend === 'postgres'
    ? await store.db.query('SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position').all(store.db.schema)
    : await (async () => {
      const tables = await store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      const rows = [];
      for (const table of tables) {
        assert.match(table.name, /^[a-z_]+$/);
        for (const column of await store.db.query('PRAGMA table_info("' + table.name + '")').all())
          rows.push({ table_name: table.name, column_name: column.name, data_type: column.type, is_nullable: column.notnull === 0 && column.pk === 0 ? 'YES' : 'NO', column_default: column.dflt_value });
      }
      return rows;
    })();
  if (backend === 'postgres') {
    const upgradeDb = await getPostgresDatabase(projectSchemaName('legacy migration upgrade'));
    try {
      await upgradeDb.exec('CREATE SCHEMA "' + upgradeDb.schema + '"');
      await applyPostgresMigrations(upgradeDb, projectMigrations.slice(0, 3));
      await upgradeDb.createQueue().transaction(async () => {
        for (const id of ['legacy-issue', 'legacy-jira', 'legacy-plain'])
          await upgradeDb.run("INSERT INTO tasks (id, prompt, stage, state, created_at, updated_at) VALUES (?, 'preserved prompt', 'todo', 'queued', 1, 1)", [id]);
        await upgradeDb.run("INSERT INTO issue_watch (number, task_id, filed_at) VALUES (7, 'legacy-issue', 1)");
        await upgradeDb.run("INSERT INTO jira_imports (site, issue_key, task_id, filed_at) VALUES ('jira.example.com', 'C-1', 'legacy-jira', 1)");
        await upgradeDb.run("INSERT INTO jira_imports (site, issue_key, task_id, filed_at) VALUES ('jira.example.com', 'C-2', 'legacy-issue', 1)");
      });
      await applyPostgresMigrations(upgradeDb, projectMigrations);
      assert.deepEqual(Array.from(await upgradeDb.query('SELECT id, prompt, source_issue FROM tasks ORDER BY id').all()), [
        { id: 'legacy-issue', prompt: 'preserved prompt', source_issue: '7' },
        { id: 'legacy-jira', prompt: 'preserved prompt', source_issue: 'C-1' },
        { id: 'legacy-plain', prompt: 'preserved prompt', source_issue: null },
      ]);
      await upgradeDb.run("UPDATE tasks SET source_issue = 'explicit-source' WHERE id = 'legacy-issue'");
      await applyPostgresMigrations(upgradeDb, projectMigrations);
      assert.equal((await upgradeDb.query("SELECT source_issue FROM tasks WHERE id = 'legacy-issue'").get()).source_issue, 'explicit-source');
      assert.deepEqual(Array.from(await upgradeDb.query('SELECT version FROM schema_migrations ORDER BY version').all()),
        Array.from({ length: projectMigrationCount }, (_, index) => ({ version: index + 1 })));
    } finally { await upgradeDb.close(); }
    const snapshot = join(root, 'must-not-exist', 'backup.db');
    await assert.rejects(store.backupTo(snapshot));
    await assert.rejects(global.backupTo(snapshot));
    assert.equal(existsSync(join(root, 'must-not-exist')), false);
	const projectDb = store.db;
	// The store's own migrations occupy versions 1..projectMigrationCount, so
	// the rollback probes run on the next free version: a probe step whose
	// version is already recorded looks applied and silently skips.
	const probeBase = Array.from({ length: projectMigrationCount }, () => async () => {});
	const probeVersion = projectMigrationCount + 1;
	const failure = new Error('failed migration step');
	await assert.rejects(applyPostgresMigrations(projectDb, [...probeBase, async migrationDb => {
		await migrationDb.exec('CREATE TABLE migration_rollback_probe (id bigint PRIMARY KEY)');
		await migrationDb.run("UPDATE settings SET value = 'changed' WHERE key = 'task-insertion-ordinal'");
		throw failure;
	}]), error => error === failure);
	assert.equal(await projectDb.query('SELECT version FROM schema_migrations WHERE version = ?').get(probeVersion), null);
	assert.equal(await projectDb.query('SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name = ?').get(projectDb.schema, 'migration_rollback_probe'), null);
	assert.equal(await projectDb.query("SELECT value FROM settings WHERE key = 'task-insertion-ordinal'").get().then(row => row.value), String(afterOrdinal.insertion_ordinal));
	await applyPostgresMigrations(projectDb, [...probeBase, async migrationDb => {
		await migrationDb.exec('CREATE TABLE migration_success_probe (id bigint PRIMARY KEY)');
		await migrationDb.run('INSERT INTO migration_success_probe (id) VALUES (?)', [77]);
	}]);
	assert.deepEqual(Array.from(await projectDb.query('SELECT id FROM migration_success_probe').all()), [{ id: 77 }]);
	assert.deepEqual(await projectDb.query('SELECT version FROM schema_migrations WHERE version = ?').get(probeVersion), { version: probeVersion });
	assert.equal((await store.getTask(first.id)).prompt, first.prompt);
	await applyPostgresMigrations(projectDb, Array.from({ length: projectMigrationCount }, (_, index) => async () => { throw new Error('step ' + (index + 1) + ' repeated'); }));
    const globalDb = await getPostgresDatabase('ottr_global');
    try {
      const collisionName = 'registry collision';
      const collisionSchema = projectSchemaName(collisionName);
      await globalDb.run('INSERT INTO project_registry (project_name, schema_name) VALUES (?, ?)', ['different exact project', collisionSchema]);
      await assert.rejects(ProjectStore.open(join(root, collisionName)), /registry conflict/);
      assert.equal(await globalDb.query('SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ?').get(collisionSchema), null);
      const unregisteredName = 'unregistered schema';
      const unregisteredSchema = projectSchemaName(unregisteredName);
      await globalDb.exec('CREATE SCHEMA "' + unregisteredSchema + '"');
      await assert.rejects(ProjectStore.open(join(root, unregisteredName)), /no registry identity/);
      assert.equal(await globalDb.query('SELECT project_name FROM project_registry WHERE project_name = ?').get(unregisteredName), null);
    } finally { await globalDb.close(); }
  }
  const importedDb = store.db;
  await store.transaction(async () => {
    await importedDb.run("INSERT INTO turns (id, task_id, kind, prompt, started_at) VALUES (8001, ?, 'work', 'imported turn', 4294967296123)", [first.id]);
    await importedDb.run("INSERT INTO events (id, at, task_id, kind) VALUES (9001, 4294967296123, ?, 'create')", [first.id]);
    await importedDb.run("INSERT INTO pr_review_runs (id, number, started_at, head) VALUES (7001, 33, 4294967296123, 'imported')");
    await importedDb.run("INSERT INTO review_findings (id, card_id, prompt, created_at) VALUES (6001, ?, 'imported finding', 4294967296123)", [first.id]);
  });
  if (backend === 'postgres') await reseedPostgresIdentities(importedDb);
  assert.ok((await store.startTurn(first.id, 'work', 'after import', null)).id > 8001);
  assert.ok((await store.startPrRun(33, 'new head', 4294967296126)) > 7001);
  await store.createTask('event after imported ID');
  assert.ok((await importedDb.query('SELECT id FROM events ORDER BY id DESC LIMIT 1').get()).id > 9001);
  const findingInsert = await store.transaction(() => importedDb.run(
    "INSERT INTO review_findings (card_id, prompt, created_at) VALUES (?, 'after imported finding', 4294967296124)", [first.id],
  ));
  assert.equal(findingInsert.changes, 1);
  assert.ok(BigInt(findingInsert.lastInsertRowid) > 6001n);
  assert.equal((await importedDb.query("SELECT id FROM review_findings WHERE prompt = 'after imported finding'").get()).id, findingInsert.lastInsertRowid);
  console.log(JSON.stringify({ schemaRows, tasks: (await store.listTasks()).length }));
} finally {
  await store.close();
  await global.close();
  if (backend === 'postgres') await closePostgresBackend();
}
`;

interface SchemaRow {
	table_name: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
}
interface ScenarioResult {
	schemaRows: SchemaRow[];
	tasks: number;
}

async function runScenarios(
	backend: "sqlite" | "postgres",
	fixture?: PostgresFixture,
): Promise<ScenarioResult> {
	const dir = join(root, backend);
	const env = fixture?.subprocessEnv() ?? {
		...process.env,
		OTTR_DATABASE_URL: "",
	};
	env.OTTR_DATA_DIR = "";
	env.OTTR_SERVER_DATA_DIR = "";
	const child = spawnStoreChild({
		script: `${imports}\nconst root = ${JSON.stringify(dir)}; const backend = ${JSON.stringify(backend)};\n${scenarios}`,
		cwd: import.meta.dir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	try {
		const [text, stderr, exit] = await Promise.all([
			new Response(child.child.stdout as ReadableStream<Uint8Array>).text(),
			new Response(child.child.stderr as ReadableStream<Uint8Array>).text(),
			child.exited,
		]);
		stdout = text;
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	} finally {
		child.killGroup(); // best-effort: a mutant hang must not orphan the child
		try {
			await child.exited;
		} catch {}
	}
	const reopened = spawnStoreChild({
		script: `${imports}
		const backend = ${JSON.stringify(backend)};
		const root = ${JSON.stringify(dir)};
		const global = await GlobalStore.open(root);
		const store = await ProjectStore.open(join(root, 'Mixed CASE λ project'));
		try {
			assert.equal(await store.getTaskReport('z-first'), 'committed');
			assert.equal((await store.getTask('z-first')).prompt, "O'Brien λ\\nprompt");
			assert.ok((await store.listTurns('z-first')).length >= 2);
			assert.equal((await store.listTasks())[0].id, 'b-tie-third');
			assert.equal(await global.get('counter'), 8);
			await store.createTask('new process after reopen');
		} finally {
			await store.close();
			await assert.rejects(store.getTaskReport('z-first'), /closed/);
			await global.close();
			if (backend === 'postgres') await closePostgresBackend();
		}`,
		cwd: import.meta.dir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const [reopenOutput, reopenError, reopenExit] = await Promise.all([
			new Response(reopened.child.stdout as ReadableStream<Uint8Array>).text(),
			new Response(reopened.child.stderr as ReadableStream<Uint8Array>).text(),
			reopened.exited,
		]);
		expect({
			exit: reopenExit,
			stdout: reopenOutput,
			stderr: reopenError,
		}).toEqual({
			exit: 0,
			stdout: "",
			stderr: "",
		});
	} finally {
		reopened.killGroup(); // best-effort: a mutant hang must not orphan the child
		try {
			await reopened.exited;
		} catch {}
	}
	return JSON.parse(stdout) as ScenarioResult;
}

function schemaMap(rows: SchemaRow[]): ApplicationSchema {
	const result = new Map<string, string[]>();
	for (const row of rows) {
		const columns = result.get(row.table_name) ?? [];
		columns.push(row.column_name);
		result.set(row.table_name, columns);
	}
	return result;
}

function normalizedDefault(value: string | null): string | null {
	return (
		value
			?.replace(/::(?:text|bigint|double precision)\b/g, "")
			.replace(/^\((.*)\)$/, "$1") ?? null
	);
}

let sqliteResult: Promise<ScenarioResult> | undefined;
function sqliteScenarios(): Promise<ScenarioResult> {
	sqliteResult ??= runScenarios("sqlite");
	return sqliteResult;
}

const config = readPostgresTestConfig();
describe("shared real-driver store behavior", () => {
	test("SQLite preserves the shared behavior", async () => {
		const result = await sqliteScenarios();
		expect(result.tasks).toBeGreaterThan(2);
	}, 30_000);

	(config ? test : test.skip)(
		"PostgreSQL preserves behavior and the fully opened SQLite schema",
		async () => {
			if (config === null)
				throw new Error("PostgreSQL fixture configuration is absent");
			const fixture = await createPostgresFixture(config);
			try {
				const [sqlite, postgres] = await Promise.all([
					sqliteScenarios(),
					runScenarios("postgres", fixture),
				]);
				const expected = schemaMap(sqlite.schemaRows);
				const actual = schemaMap(postgres.schemaRows);
				expect(applicationSchemaDifferences(expected, actual)).toEqual([]);
				for (const column of sqlite.schemaRows) {
					if (
						column.table_name === "learnings" ||
						column.table_name === "sqlite_sequence"
					)
						continue;
					const target = postgres.schemaRows.find(
						(row) =>
							row.table_name === column.table_name &&
							row.column_name === column.column_name,
					);
					expect(
						target,
						`${column.table_name}.${column.column_name}`,
					).toBeDefined();
					const mappedType: Record<string, string> = {
						INTEGER: "bigint",
						REAL: "double precision",
						TEXT: "text",
					};
					const expectedType = mappedType[column.data_type];
					if (expectedType === undefined)
						throw new Error(
							`Unexpected SQLite oracle type: ${column.data_type}`,
						);
					expect(target!.data_type).toBe(expectedType);
					expect(target!.is_nullable).toBe(column.is_nullable);
					expect(normalizedDefault(target!.column_default)).toBe(
						normalizedDefault(column.column_default),
					);
				}
				const schema = projectSchemaName("Mixed CASE λ project");
				const catalogQuery =
					"SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position";
				const beforeDrop = schemaMap(
					await fixture.sql.unsafe<SchemaRow[]>(catalogQuery, [schema]),
				);
				await fixture.sql.unsafe("BEGIN");
				try {
					// The fixture has one connection. The rollback restores these real schema changes.
					await fixture.sql.unsafe(`DROP TABLE "${schema}"."ask_drafts"`);
					await fixture.sql.unsafe(
						`DROP TRIGGER tasks_insertion_ordinal_insert ON "${schema}"."tasks"`,
					);
					await fixture.sql.unsafe(
						`ALTER TABLE "${schema}"."tasks" DROP COLUMN insertion_ordinal`,
					);
					const afterDrop = schemaMap(
						await fixture.sql.unsafe<SchemaRow[]>(catalogQuery, [schema]),
					);
					expect(applicationSchemaDifferences(beforeDrop, afterDrop)).toEqual([
						"ask_drafts: missing table",
						"tasks.insertion_ordinal: missing column",
					]);
				} finally {
					await fixture.sql.unsafe("ROLLBACK");
				}
				expect(
					applicationSchemaDifferences(
						beforeDrop,
						schemaMap(
							await fixture.sql.unsafe<SchemaRow[]>(catalogQuery, [schema]),
						),
					),
				).toEqual([]);
			} finally {
				await fixture.close();
			}
		},
		60_000,
	);
});

describe("application schema comparison", () => {
	test("only named metadata and retired tables are exceptions", () => {
		const expected = new Map([
			["tasks", ["id", "insertion_ordinal"]],
			["schema_future_feature", ["value"]],
			["project_registry_events", ["at"]],
			["learnings", ["text"]],
			["sqlite_sequence", ["name", "seq"]],
		]);
		const actual = new Map([
			["tasks", ["id", "insertion_ordinal"]],
			["schema_migrations", ["version"]],
			["project_registry", ["project_name", "schema_name"]],
		]);
		expect(applicationSchemaDifferences(expected, actual)).toEqual([
			"project_registry_events: missing table",
			"schema_future_feature: missing table",
		]);
		expect(
			applicationSchemaDifferences(
				new Map([["tasks", ["id"]]]),
				new Map([
					["tasks", ["id", "extra"]],
					["new_table", ["id"]],
				]),
			),
		).toEqual([
			"new_table: unexpected table",
			"tasks.extra: unexpected column",
		]);
	});
});

describe("project schema identities", () => {
	test("Unicode, case, long names, and equal stems retain exact identities", () => {
		const names = [
			"Project",
			"project",
			"λ",
			"🚀",
			"a-b",
			"a b",
			"a".repeat(300),
			`${"a".repeat(300)}b`,
		];
		expect(new Set(names.map(projectSchemaName)).size).toBe(names.length);
		fc.assert(
			fc.property(
				fc.array(
					fc
						.integer({ min: 1, max: 0x10ffff })
						.filter((code) => code < 0xd800 || code > 0xdfff),
					{ maxLength: 160 },
				),
				(codes) => {
					const name = String.fromCodePoint(...codes);
					const actual = projectSchemaName(name);
					const stem = [...name.toLowerCase()]
						.map((character) =>
							/^[a-z0-9_]$/.test(character) ? character : "_",
						)
						.join("")
						.slice(0, 48);
					const digest = createHash("sha256")
						.update(name)
						.digest("hex")
						.slice(0, 12);
					expect(actual).toBe(`p_${stem}_${digest}`);
					expect(actual).toMatch(/^p_[a-z0-9_]{0,48}_[a-f0-9]{12}$/);
					expect(Buffer.byteLength(actual)).toBeLessThanOrEqual(63);
					expect(projectSchemaName(`${name}A`)).not.toBe(
						projectSchemaName(`${name}a`),
					);
				},
			),
		);
	});
});
