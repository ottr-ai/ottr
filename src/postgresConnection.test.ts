import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	createPostgresFixture,
	type PostgresFixture,
	readPostgresTestConfig,
} from "./test/postgres";

const config = readPostgresTestConfig();
let fixture: PostgresFixture | undefined;

beforeAll(async () => {
	if (config) fixture = await createPostgresFixture(config);
}, 15_000);

afterAll(async () => {
	await fixture?.close();
}, 15_000);

const liveTest = config ? test : test.skip;

liveTest(
	"Bun.SQL writes and reads exact PostgreSQL values in its owned database",
	async () => {
		if (!fixture) throw new Error("Expected the live PostgreSQL fixture.");
		await fixture.sql.unsafe(
			"CREATE TABLE connection_probe (id integer PRIMARY KEY, label text NOT NULL)",
		);
		await fixture.sql.unsafe(
			"INSERT INTO connection_probe (id, label) VALUES ($1, $2), ($3, $4)",
			[1, "first ' value", 2, "second Unicode: 雪"],
		);
		const rows = await fixture.sql.unsafe<{ id: number; label: string }[]>(
			"SELECT id, label FROM connection_probe ORDER BY id",
		);
		expect(rows).toEqual([
			{ id: 1, label: "first ' value" },
			{ id: 2, label: "second Unicode: 雪" },
		]);
		const version = await fixture.sql.unsafe<{ supported: boolean }[]>(
			"SELECT current_setting('server_version_num')::integer >= 180000 AND current_setting('server_version_num')::integer < 190000 AS supported",
		);
		expect(version).toEqual([{ supported: true }]);
	},
);

liveTest(
	"a real subprocess reads parent data through normal OTTR_DATABASE_URL",
	async () => {
		if (!fixture) throw new Error("Expected the live PostgreSQL fixture.");
		await fixture.sql.unsafe(
			"CREATE TABLE subprocess_probe (id integer PRIMARY KEY, label text NOT NULL)",
		);
		await fixture.sql.unsafe(
			"INSERT INTO subprocess_probe (id, label) VALUES ($1, $2)",
			[7, "parent value"],
		);
		const parser = new URL("./test/postgres.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
		import { SQL } from "bun";
		import { normalizePostgresUrl } from ${JSON.stringify(parser)};
		let client;
		let failed = false;
		let rows;
		try {
			const target = normalizePostgresUrl(process.env.OTTR_DATABASE_URL ?? "");
			const url = new URL(target.url);
			client = new SQL(target.url, {
				adapter: "postgres",
				hostname: target.host.replace(/^\\[|\\]$/g, ""),
				port: target.port,
				database: target.database,
				username: decodeURIComponent(url.username) || "postgres",
				password: decodeURIComponent(url.password),
				max: 1,
				connectionTimeout: 5,
			});
			rows = await client.unsafe("SELECT id, label, current_database() AS database FROM subprocess_probe ORDER BY id");
		} catch {
			failed = true;
		} finally {
			if (client) {
				try { await client.close(); } catch { failed = true; }
			}
		}
		if (failed) {
			console.error("PostgreSQL subprocess query or close failed.");
			process.exitCode = 1;
		} else {
			console.log(JSON.stringify(rows));
		}
		`,
			],
			{
				// Explicit URL options must override the inherited database name.
				env: {
					...fixture.subprocessEnv(),
					PGDATABASE: "not_the_owned_database",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0 || stderr !== "")
			throw new Error(
				"PostgreSQL subprocess acceptance query failed. Driver output remains private.",
			);
		expect(JSON.parse(stdout)).toEqual([
			{
				id: 7,
				label: "parent value",
				database: new URL(fixture.url).pathname.slice(1),
			},
		]);
	},
	15_000,
);

liveTest(
	"real query errors expose no driver cause or database URL",
	async () => {
		if (!fixture) throw new Error("Expected the live PostgreSQL fixture.");
		let failure: unknown;
		try {
			await fixture.sql.unsafe(
				"SELECT * FROM ottr_missing_relation_for_error_test",
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("PostgreSQL fixture query failed.");
		expect((failure as Error).cause).toBeUndefined();
		expect((failure as Error).stack?.includes(fixture.url)).toBe(false);
	},
);
