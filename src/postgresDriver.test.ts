import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { sqliteNumber } from "./sqliteDriver.ts";
import { StoreQueue } from "./storeQueue.ts";
import {
	createPostgresFixture,
	type PostgresFixture,
	readPostgresTestConfig,
} from "./test/postgres.ts";
import { createPostgresProxy } from "./test/postgresProxy.ts";
import fc from "./test/properties.ts";

const config = readPostgresTestConfig();
const driverUrl = new URL("./postgresDriver.ts", import.meta.url).href;
// The URL remains in the inherited environment, never source, argv, or protocol output.
const childSource = (retryMilliseconds: number) => `
import { createInterface } from "node:readline";
import { getPostgresDatabase, closePostgresBackend } from ${JSON.stringify(driverUrl)};
const send = (value) => console.log(JSON.stringify(value, (_, value) => typeof value === "bigint" ? { int64: value.toString() } : value));
let db;
try {
 db = await getPostgresDatabase("ottr_global", { retryMilliseconds: ${retryMilliseconds} });
 const queue = db.createQueue();
 send({ ready: true, ...(await db.query("SELECT pg_backend_pid() AS pid").get()) });
 for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line, (_, value) => value && typeof value === "object" && typeof value.int64 === "string" ? BigInt(value.int64) : value);
  if (command.op === "close") break;
  try {
   let value;
   if (command.op === "query") value = await queue.run(() => db.query(command.sql).all(...(command.params ?? [])));
   else if (command.op === "run") value = await queue.run(() => db.run(command.sql, command.params ?? []));
   else if (command.op === "exec") value = await queue.run(() => db.exec(command.sql));
   else if (command.op === "invalidSchema") {
    const reference = await getPostgresDatabase(command.schema);
    await reference.close();
   }
   else if (command.op === "transaction") {
    let attempts = 0;
    value = await queue.transaction(async () => {
     attempts++;
     let result;
     for (const step of command.steps) {
      if (step.op === "throw") throw new Error("application refused");
      if (step.op === "catch") { try { await queue.run(() => db.run(step.sql, step.params ?? [])); } catch {} continue; }
      if (step.op === "query") result = await queue.run(() => db.query(step.sql).all(...(step.params ?? [])));
      else result = await queue.run(() => db.run(step.sql, step.params ?? []));
     }
     return { result, attempts };
    });
   } else if (command.op === "nonreplayable" || command.op === "nestedNonreplayable") {
    value = await queue.transaction(async () => {
     if (command.op === "nestedNonreplayable") {
      const second = await getPostgresDatabase("p_cross_0123456789ab");
      try {
       await second.createQueue().transaction(async () => {
        console.error("external callback effect");
        await second.run("INSERT INTO kv VALUES ('no_replay', 'inner')");
       }, { replay: false });
      } finally { await second.close(); }
     } else console.error("external callback effect");
     await db.run("INSERT INTO kv VALUES ('no_replay', 'outer')");
     await db.run("UPDATE kv SET value = 'never committed' WHERE key = 'no_replay' /* no_replay_loss */");
    }, { replay: command.op === "nestedNonreplayable" });
   } else if (command.op === "crossStore") {
    const second = await getPostgresDatabase("p_cross_0123456789ab");
    const other = second.createQueue();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const trace = [];
    const first = queue.transaction(async () => {
     await db.run("INSERT INTO kv VALUES ('cross_commit', 'outer')");
     entered.resolve(); await release.promise;
     await other.run(() => second.query("SELECT key FROM kv").all());
     await other.transaction(() => second.run("INSERT INTO kv VALUES ('cross_commit', 'inner')"));
     trace.push("nested");
    });
    await entered.promise;
    const pending = other.run(async () => { await second.query("SELECT key FROM kv").all(); trace.push("pending"); });
    release.resolve(); await Promise.all([first, pending]);
    let rollback;
    try {
     await queue.transaction(async () => {
      await db.run("INSERT INTO kv VALUES ('cross_rollback', 'outer')");
      try {
       await other.transaction(async () => {
        await second.run("INSERT INTO kv VALUES ('cross_rollback', 'inner')");
        throw new Error("nested refused");
       });
      } catch {}
     });
    } catch (error) { rollback = error.message; }
    await other.close(() => second.close());
    let closed;
    await queue.run(async () => { try { await other.run(() => 1); } catch (error) { closed = error.message; } });
    value = { trace, rollback, closed };
   } else if (command.op === "isolation") {
    const second = await getPostgresDatabase("ottr_global");
    const other = second.createQueue();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const trace = [];
    const first = queue.transaction(async () => {
     await db.run("INSERT INTO kv(key,value) VALUES ('isolated', 'before')");
     entered.resolve(); await release.promise;
     await queue.transaction(() => db.run("UPDATE kv SET value = 'after' WHERE key = 'isolated'"));
     trace.push("transaction");
    });
    await entered.promise;
    const ordinary = other.run(async () => { const row = await second.query("SELECT value FROM kv WHERE key = 'isolated'").get(); trace.push(row.value); });
    release.resolve(); await Promise.all([first, ordinary]);
    await queue.close(() => db.close());
    value = { trace, afterFirstClose: await other.run(() => second.query("SELECT value FROM kv WHERE key = 'isolated'").get()) };
    await other.close(() => second.close());
    send({ value }); db = undefined; break;
   } else throw new Error("unknown fixture command");
   send({ value });
  } catch (error) { send({ error: { message: error.message, code: error.code } }); }
 }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (db) await db.close(); await closePostgresBackend(); }
`;

type Message = {
	ready?: boolean;
	pid?: number;
	value?: unknown;
	error?: { message: string; code?: string };
};
type Command = {
	op: string;
	sql?: string;
	schema?: string;
	params?: unknown[];
	steps?: Command[];
};
interface MessageWaiter {
	promise: Promise<Message>;
	resolve(value: Message): void;
	reject(error: Error): void;
}
interface ProcessResult {
	code: number;
	stderr: string;
}
interface DriverProcess {
	next(): Promise<Message>;
	request(command: Command): Promise<Message>;
	exit(): Promise<ProcessResult>;
	close(): Promise<void>;
}

function startChild(
	fixture: PostgresFixture,
	url = fixture.url,
	overrides: Record<string, string> = {},
	retryMilliseconds = 300,
): DriverProcess {
	const env = fixture.subprocessEnv();
	const child = Bun.spawn(
		[process.execPath, "--eval", childSource(retryMilliseconds)],
		{
			env: { ...env, OTTR_DATABASE_URL: url, ...overrides },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const messages: Message[] = [];
	const waiting: MessageWaiter[] = [];
	const output = new Response(child.stderr).text();
	let ended = false;
	const pump = (async () => {
		const reader = child.stdout.getReader();
		const input = Readable.from(
			(async function* () {
				try {
					for (;;) {
						const result = await reader.read();
						if (result.done) return;
						yield result.value;
					}
				} finally {
					reader.releaseLock();
				}
			})(),
		);
		const lines = createInterface({ input });
		for await (const line of lines) {
			const message = JSON.parse(line) as Message;
			const waiter = waiting.shift();
			if (waiter) waiter.resolve(message);
			else messages.push(message);
		}
		ended = true;
		for (const waiter of waiting.splice(0))
			waiter.reject(
				new Error("PostgreSQL fixture exited before its response."),
			);
	})();
	let finished = false;
	const fixtureChild = {
		async next(): Promise<Message> {
			const message = messages.shift();
			if (message) return message;
			if (finished || ended)
				throw new Error("PostgreSQL fixture already exited.");
			const waiter = Promise.withResolvers<Message>();
			waiting.push(waiter);
			return waiter.promise;
		},
		async request(command: Command): Promise<Message> {
			child.stdin.write(
				`${JSON.stringify(command, (_, value) => (typeof value === "bigint" ? { int64: value.toString() } : value))}\n`,
			);
			await child.stdin.flush();
			return this.next();
		},
		async exit(): Promise<{ code: number; stderr: string }> {
			child.stdin.end();
			const code = await child.exited;
			finished = true;
			await pump;
			return { code, stderr: await output };
		},
		async close() {
			if (finished) return;
			// EOF ends the command iterator naturally, including an already-exiting
			// child. Do not race a final protocol write against its closed pipe.
			await this.exit();
		},
	};
	fixture.register(fixtureChild);
	return fixtureChild;
}

async function fatalCommand(
	child: DriverProcess,
	command: Command,
): Promise<ProcessResult> {
	const response = child.request(command).then(
		// A faulty implementation may reply instead of exiting. End it naturally.
		() => child.close(),
		() => {},
	);
	const result = await child.exit();
	await response;
	return result;
}

function value<T>(message: Message): T {
	if (message.error)
		throw new Error(
			`PostgreSQL fixture operation refused: ${message.error.message}`,
		);
	return message.value as T;
}

test("a caught rollback failure blocks later work in the same admitted scope", async () => {
	const rollbackError = new Error("rollback refused");
	let laterCalls = 0;
	const queue = new StoreQueue({
		begin() {},
		commit() {},
		rollback() {
			throw rollbackError;
		},
	});
	await queue.run(async () => {
		await expect(
			queue.transaction(() => {
				throw new Error("application refused");
			}),
		).rejects.toBe(rollbackError);
		await expect(
			queue.run(() => {
				laterCalls++;
			}),
		).rejects.toBe(rollbackError);
	});
	expect(laterCalls).toBe(0);
	await expect(
		queue.run(() => {
			laterCalls++;
		}),
	).rejects.toBe(rollbackError);
	expect(laterCalls).toBe(0);
});

// Register nothing without a fixture config: bun 1.4.5's inspector drops a
// variable slice of a burst of skip events (OTTR-1191 probe: three identical
// runs delivered 20, 26 and 30 of 32 skips, while streamed per-test results
// never dropped), and the mutation dry run's completeness gate rightly refuses
// summary and inspector counts that disagree. readPostgresTestConfig already
// notices why; with a config every test below registers and runs as before.
describe("PostgreSQL reserved driver and lifecycle", () => {
	if (!config) return;
	let fixture: PostgresFixture;
	beforeAll(async () => {
		if (!config) throw new Error("PostgreSQL fixture configuration is absent.");
		fixture = await createPostgresFixture(config);
		await fixture.sql.unsafe("CREATE SCHEMA ottr_global");
		await fixture.sql.unsafe(
			"CREATE TABLE ottr_global.kv (key text PRIMARY KEY, value text NOT NULL)",
		);
		await fixture.sql.unsafe(
			"CREATE TABLE ottr_global.events (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, value text NOT NULL)",
		);
		await fixture.sql.unsafe("CREATE SCHEMA p_cross_0123456789ab");
		await fixture.sql.unsafe(
			"CREATE TABLE p_cross_0123456789ab.kv (key text PRIMARY KEY, value text NOT NULL)",
		);
	});
	afterAll(async () => {
		if (fixture) await fixture.close();
	});

	test("a second server refuses ownership, and final close releases the reserved session", async () => {
		const first = startChild(fixture);
		expect((await first.next()).ready).toBe(true);
		const second = startChild(fixture);
		const refusal = await second.exit();
		expect(refusal.code).not.toBe(0);
		expect(refusal.stderr.includes(fixture.url)).toBe(false);
		await first.close();
		const replacement = startChild(fixture);
		expect((await replacement.next()).ready).toBe(true);
		await replacement.close();
	});

	test("an unreachable startup refuses without the runtime recovery loop", async () => {
		const portOwner = createServer();
		const listening = Promise.withResolvers<void>();
		portOwner.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = portOwner.address();
		if (!address || typeof address === "string")
			throw new Error("Closed-port fixture did not reserve a port.");
		const closed = Promise.withResolvers<void>();
		portOwner.close(() => closed.resolve());
		await closed.promise;
		const url = new URL(fixture.url);
		url.hostname = "127.0.0.1";
		url.port = String(address.port);
		const start = Date.now();
		const child = startChild(fixture, url.href);
		const result = await child.exit();
		expect(result.code).not.toBe(0);
		expect(Date.now() - start).toBeLessThan(5_000);
		expect(result.stderr.includes(url.href)).toBe(false);
	});

	test("internal recovery duration can only shorten the fixed thirty-second window", async () => {
		for (const milliseconds of [0, -1, 30_001, Infinity, NaN]) {
			const child = startChild(fixture, fixture.url, {}, milliseconds);
			const result = await child.exit();
			expect(result.code).not.toBe(0);
			expect(result.stderr.includes(fixture.url)).toBe(false);
		}
	});

	test("schema identifiers reject terminal controls, injection, and excess bytes", async () => {
		const child = startChild(fixture);
		await child.next();
		try {
			for (const schema of [
				"ottr_global\n",
				"ottr_global\r",
				'ottr_global"; SELECT 1; --',
				`p_${"a".repeat(49)}_0123456789ab`,
			]) {
				const response = await child.request({ op: "invalidSchema", schema });
				expect(response.error?.message).toBe(
					"Invalid PostgreSQL schema identifier.",
				);
			}
			expect(
				value(await child.request({ op: "query", sql: "SELECT 1 AS intact" })),
			).toEqual([{ intact: 1 }]);
		} finally {
			await child.close();
		}
	});

	test("explicit URL routing ignores an inherited PGDATABASE and PGUSER", async () => {
		const child = startChild(fixture, fixture.url, {
			PGDATABASE: "ottr_wrong_database",
			PGUSER: "ottr_wrong_user",
		});
		await child.next();
		try {
			value(
				await child.request({
					op: "run",
					sql: "INSERT INTO kv VALUES ('url_routing', 'selected')",
				}),
			);
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT value FROM ottr_global.kv WHERE key = 'url_routing'",
				)),
			]).toEqual([{ value: "selected" }]);
			const rows = value<{ database: string }[]>(
				await child.request({
					op: "query",
					sql: "SELECT current_database() AS database",
				}),
			);
			const row = rows[0];
			if (!row) throw new Error("Database routing query returned no row.");
			expect(row.database).toBe(
				decodeURIComponent(new URL(fixture.url).pathname.slice(1)),
			);
		} finally {
			await child.close();
		}
	});

	test("bound values, exact int64, actual generated IDs, and affected rows survive the real adapter", async () => {
		const child = startChild(fixture);
		await child.next();
		try {
			const inserted = value<{ changes: number; lastInsertRowid: number }>(
				await child.request({
					op: "run",
					sql: "INSERT INTO events (value) VALUES (?)",
					params: ["O'Brien ? λ"],
				}),
			);
			expect(inserted.changes).toBe(1);
			expect(inserted.lastInsertRowid).toBeGreaterThan(0);
			expect(
				value(
					await child.request({
						op: "query",
						sql: "SELECT value FROM events WHERE id = ?",
						params: [inserted.lastInsertRowid],
					}),
				),
			).toEqual([{ value: "O'Brien ? λ" }]);
			expect(
				value(
					await child.request({
						op: "run",
						sql: "UPDATE events SET value = ? WHERE id = ?",
						params: ["changed", inserted.lastInsertRowid],
					}),
				),
			).toMatchObject({ changes: 1 });
			expect(
				value(
					await child.request({
						op: "run",
						sql: "UPDATE events SET value = ? WHERE id = ?",
						params: ["none", -1],
					}),
				),
			).toMatchObject({ changes: 0 });
			expect(
				value(
					await child.request({
						op: "query",
						sql: "SELECT '?' AS question, $$? FROM kv$$ AS body, ?::text AS bound /* ? FROM kv */",
						params: ['quoted " ?'],
					}),
				),
			).toEqual([{ question: "?", body: "? FROM kv", bound: 'quoted " ?' }]);
			expect(
				value(
					await child.request({
						op: "query",
						sql: "SELECT ?::text AS missing, ?::bigint AS flag, ?::bigint AS milliseconds, ?::double precision AS cost",
						params: [null, 1, 4_294_967_296, 0.123456789012345],
					}),
				),
			).toEqual([
				{
					missing: null,
					flag: 1,
					milliseconds: 4_294_967_296,
					cost: 0.123456789012345,
				},
			]);
			expect(
				value(
					await child.request({
						op: "run",
						sql: "INSERT INTO events(id, value) VALUES (?, ?)",
						params: [9_007_199_254_740_993n, "explicit int64"],
					}),
				),
			).toEqual({ changes: 1, lastInsertRowid: { int64: "9007199254740993" } });
			const afterExplicit = value<{ lastInsertRowid: number }>(
				await child.request({
					op: "run",
					sql: "INSERT INTO events(value) VALUES (?)",
					params: ["generated after explicit"],
				}),
			);
			expect(
				value(
					await child.request({
						op: "query",
						sql: "SELECT value FROM events WHERE id = ?",
						params: [afterExplicit.lastInsertRowid],
					}),
				),
			).toEqual([{ value: "generated after explicit" }]);
			await fc.assert(
				fc.asyncProperty(
					fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n }),
					async (integer) => {
						const result = value<
							{ integer: number | { int64: string }; decimal: string }[]
						>(
							await child.request({
								op: "query",
								sql: "SELECT ?::bigint AS integer, ?::bigint::text AS decimal",
								params: [integer, integer],
							}),
						)[0];
						if (!result) throw new Error("Integer query returned no row.");
						expect(result.decimal).toBe(integer.toString());
						expect(result.integer).toEqual(
							integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
								integer <= BigInt(Number.MAX_SAFE_INTEGER)
								? Number(integer)
								: { int64: integer.toString() },
						);
					},
				),
				{
					seed: 896,
					numRuns: 100,
					examples: [
						[-(1n << 63n)],
						[(1n << 63n) - 1n],
						[2_147_483_648n],
						[9_007_199_254_740_991n],
					],
				},
			);
			await fc.assert(
				fc.asyncProperty(
					fc.string({ maxLength: 80 }).filter((text) => !text.includes("\0")),
					async (text) => {
						expect(
							value(
								await child.request({
									op: "query",
									sql: "SELECT ?::text AS value, '?' AS literal",
									params: [text],
								}),
							),
						).toEqual([{ value: text, literal: "?" }]);
					},
				),
				{
					seed: 896,
					numRuns: 100,
					examples: [
						["O'Brien ? λ"],
						['"schema"."table" -- ?'],
						["$$?$$ /*?*/"],
					],
				},
			);
			expect(sqliteNumber(2_147_483_648n)).toBe(2_147_483_648);
			expect(() => sqliteNumber((1n << 63n) - 1n)).toThrow(RangeError);
		} finally {
			await child.close();
		}
	});

	test("tenant serialization preserves yielded nested work and references across store close", async () => {
		const child = startChild(fixture);
		await child.next();
		expect(value(await child.request({ op: "isolation" }))).toEqual({
			trace: ["transaction", "after"],
			afterFirstClose: { value: "after" },
		});
		expect((await child.exit()).code).toBe(0);
	});

	test("cross-schema queues avoid pending-read deadlock and share commit and poison boundaries", async () => {
		const child = startChild(fixture);
		await child.next();
		try {
			expect(value(await child.request({ op: "crossStore" }))).toEqual({
				trace: ["nested", "pending"],
				rollback: "nested refused",
				closed: "Store is closed",
			});
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT key FROM ottr_global.kv WHERE key LIKE 'cross_%' ORDER BY key",
				)),
			]).toEqual([{ key: "cross_commit" }]);
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT key FROM p_cross_0123456789ab.kv WHERE key LIKE 'cross_%' ORDER BY key",
				)),
			]).toEqual([{ key: "cross_commit" }]);
		} finally {
			await child.close();
		}
	});

	test("application and caught constraint errors roll back without reconnect or replay", async () => {
		const child = startChild(fixture);
		const ready = await child.next();
		try {
			const application = await child.request({
				op: "transaction",
				steps: [
					{ op: "run", sql: "INSERT INTO kv VALUES ('application', 'no')" },
					{ op: "throw" },
				],
			});
			expect(application.error?.message).toBe("application refused");
			const constraint = await child.request({
				op: "transaction",
				steps: [
					{ op: "run", sql: "INSERT INTO kv VALUES ('constraint', 'first')" },
					{
						op: "catch",
						sql: "INSERT INTO kv VALUES ('constraint', 'duplicate')",
					},
				],
			});
			expect(constraint.error).toBeDefined();
			expect(
				value(
					await child.request({
						op: "query",
						sql: "SELECT key FROM kv WHERE key IN ('application', 'constraint')",
					}),
				),
			).toEqual([]);
			expect(
				value(
					await child.request({
						op: "run",
						sql: "INSERT INTO kv VALUES ('after_rollback', 'accepted')",
					}),
				),
			).toMatchObject({ changes: 1 });
			expect(
				value(
					await child.request({
						op: "query",
						sql: "SELECT value FROM kv WHERE key = 'after_rollback'",
					}),
				),
			).toEqual([{ value: "accepted" }]);
			const rows = value<{ pid: number }[]>(
				await child.request({
					op: "query",
					sql: "SELECT pg_backend_pid() AS pid",
				}),
			);
			const row = rows[0];
			if (!row) throw new Error("Backend PID query returned no row.");
			if (ready.pid === undefined)
				throw new Error("Ready response omitted the owned backend PID.");
			expect(row.pid).toBe(ready.pid);
		} finally {
			await child.close();
		}
	});

	test("a failed read replaces the session, proves ownership, and resumes writes", async () => {
		const proxy = fixture.register(await createPostgresProxy(fixture.url));
		const child = startChild(fixture, proxy.url);
		const ready = await child.next();
		try {
			proxy.inject("recover_read", "before");
			const rows = value<{ pid: number }[]>(
				await child.request({
					op: "query",
					sql: "SELECT pg_backend_pid() AS pid /* recover_read */",
				}),
			);
			const row = rows[0];
			if (!row) throw new Error("Recovered backend query returned no row.");
			expect(row.pid).not.toBe(ready.pid);
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT pid FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = $1 AND classid = $2::oid AND objid = $3::oid AND objsubid = 2 AND granted",
					[row.pid, 0x4f545452, 0x50474244],
				)),
			]).toEqual([{ pid: row.pid }]);
			value(
				await child.request({
					op: "run",
					sql: "INSERT INTO kv VALUES ('recovered', 'yes')",
				}),
			);
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT value FROM ottr_global.kv WHERE key = 'recovered'",
				)),
			]).toEqual([{ value: "yes" }]);
		} finally {
			await child.close();
			await proxy.close();
		}
	});

	for (const scenario of [
		{
			name: "a quoted pg_catalog.nextval call",
			marker: "quoted_sequence_loss",
			sequence: "quoted_sequence",
			sql: `SELECT "pg_catalog"."nextval"('ottr_global.quoted_sequence'::regclass) AS value`,
		},
		{
			name: "an unknown volatile function",
			marker: "volatile_function_loss",
			sequence: "volatile_sequence",
			sql: "SELECT ottr_global.advance_owned_sequence() AS value",
		},
	])
		test(`${scenario.name} with a lost completed reply exits without replay`, async () => {
			await fixture.sql.unsafe(
				`CREATE SEQUENCE ottr_global.${scenario.sequence}`,
			);
			if (scenario.sequence === "volatile_sequence")
				await fixture.sql.unsafe(
					"CREATE FUNCTION ottr_global.advance_owned_sequence() RETURNS bigint LANGUAGE SQL VOLATILE AS $$ SELECT pg_catalog.nextval('ottr_global.volatile_sequence'::regclass) $$",
				);
			const proxy = fixture.register(await createPostgresProxy(fixture.url));
			const child = startChild(fixture, proxy.url);
			try {
				await child.next();
				proxy.inject(scenario.marker, "reply");
				const result = await fatalCommand(child, {
					op: "query",
					sql: `${scenario.sql} /* ${scenario.marker} */`,
				});
				const queries = proxy.queries.filter((query) =>
					query.includes(scenario.marker),
				);
				const sequence = [
					...(await fixture.sql.unsafe<unknown[]>(
						`SELECT last_value::text AS value, is_called FROM ottr_global.${scenario.sequence}`,
					)),
				];
				expect({
					exitedNonzero: result.code !== 0,
					queries: queries.length,
					sequence,
				}).toEqual({
					exitedNonzero: true,
					queries: 1,
					sequence: [{ value: "1", is_called: true }],
				});
				expect(result.stderr).toContain("unknown result");
			} finally {
				await child.close();
				await proxy.close();
			}
		});

	for (const sql of [
		"SELECT 1; SELECT 2",
		"SHOW server_version; SELECT 2",
		"SELECT 1 INTO ottr_global.unreplayable_select",
	])
		test(`${sql} is not replayed after connection loss`, async () => {
			const proxy = fixture.register(await createPostgresProxy(fixture.url));
			const child = startChild(fixture, proxy.url);
			const marker = "unsafe_read_form";
			try {
				await child.next();
				// Do not depend on Bun accepting multiple prepared statements. The
				// classifier must refuse replay before any uncertain form is retried.
				proxy.inject(marker, "before");
				const result = await fatalCommand(child, {
					op: "query",
					sql: `${sql} /* ${marker} */`,
				});
				expect(result.code).not.toBe(0);
				expect(result.stderr).toContain("unknown result");
				expect(
					proxy.queries.filter((query) => query.includes(marker)),
				).toHaveLength(1);
			} finally {
				await child.close();
				await proxy.close();
			}
		});

	for (const sql of [
		"SELECT 1 AS value",
		`SELECT "pg_catalog"."pg_backend_pid"() AS pid, COUNT(*) AS count, MAX(value) AS maximum FROM kv WHERE key IN ('recovered')`,
		"SELECT relname FROM pg_catalog.pg_class WHERE relname = 'kv'",
		"SHOW server_version",
	])
		test(`${sql} remains replayable after a lost completed reply`, async () => {
			const proxy = fixture.register(await createPostgresProxy(fixture.url));
			const child = startChild(fixture, proxy.url);
			const marker = "pure_read_form";
			try {
				await child.next();
				proxy.inject(marker, "reply");
				const rows = value<unknown[]>(
					await child.request({
						op: "query",
						sql: `${sql}; /* ${marker} */`,
					}),
				);
				expect(rows.length).toBeGreaterThan(0);
				expect(
					proxy.queries.filter((query) => query.includes(marker)),
				).toHaveLength(2);
			} finally {
				await child.close();
				await proxy.close();
			}
		});

	test("a pre-COMMIT connection loss replays only the complete transaction", async () => {
		const proxy = fixture.register(await createPostgresProxy(fixture.url));
		const child = startChild(fixture, proxy.url);
		await child.next();
		try {
			proxy.inject("transaction_loss", "reply");
			const result = value<{ attempts: number }>(
				await child.request({
					op: "transaction",
					steps: [
						{
							op: "run",
							sql: "INSERT INTO kv VALUES ('whole_transaction', 'first')",
						},
						{
							op: "run",
							sql: "UPDATE kv SET value = 'complete' WHERE key = 'whole_transaction' /* transaction_loss */",
						},
					],
				}),
			);
			expect(result.attempts).toBe(2);
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT value FROM ottr_global.kv WHERE key = 'whole_transaction'",
				)),
			]).toEqual([{ value: "complete" }]);
		} finally {
			await child.close();
			await proxy.close();
		}
	});

	for (const op of ["nonreplayable", "nestedNonreplayable"])
		test(`${op} callbacks never repeat an external effect`, async () => {
			const proxy = fixture.register(await createPostgresProxy(fixture.url));
			const child = startChild(fixture, proxy.url);
			await child.next();
			proxy.inject("no_replay_loss", "reply");
			const result = await fatalCommand(child, { op });
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("transaction interrupted");
			expect(result.stderr.split("external callback effect").length - 1).toBe(
				1,
			);
			expect(
				await fixture.sql.unsafe(
					"SELECT key FROM ottr_global.kv WHERE key = 'no_replay'",
				),
			).toHaveLength(0);
			expect(
				await fixture.sql.unsafe(
					"SELECT key FROM p_cross_0123456789ab.kv WHERE key = 'no_replay'",
				),
			).toHaveLength(0);
			await proxy.close();
		});

	test("a failed ROLLBACK poisons the queue instead of reconnecting", async () => {
		const proxy = fixture.register(await createPostgresProxy(fixture.url));
		const child = startChild(fixture, proxy.url);
		await child.next();
		proxy.inject("ROLLBACK", "reply");
		const result = await fatalCommand(child, {
			op: "transaction",
			steps: [
				{
					op: "run",
					sql: "INSERT INTO kv VALUES ('rollback_failure', 'forbidden')",
				},
				{ op: "throw" },
			],
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("rollback");
		expect(
			await fixture.sql.unsafe(
				"SELECT key FROM ottr_global.kv WHERE key = 'rollback_failure'",
			),
		).toHaveLength(0);
		expect(
			proxy.queries.filter((query) => query.includes("rollback_failure")),
		).toHaveLength(1);
		await proxy.close();
	});

	test("runtime recovery exhaustion exits nonzero within its internal duration", async () => {
		const proxy = fixture.register(await createPostgresProxy(fixture.url));
		const child = startChild(fixture, proxy.url);
		await child.next();
		proxy.refuseConnections(true);
		proxy.dropConnections();
		const start = Date.now();
		const result = await fatalCommand(child, { op: "query", sql: "SELECT 1" });
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("retry exhausted");
		// Include cleanup: refused startup sockets must not keep the listener open.
		await proxy.close();
		expect(Date.now() - start).toBeLessThan(3_000);
	});

	test("a replacement session cannot write while another session owns the advisory lock", async () => {
		const proxy = fixture.register(await createPostgresProxy(fixture.url));
		const child = startChild(fixture, proxy.url);
		await child.next();
		proxy.dropConnections();
		let owned = false;
		await fixture.sql.unsafe("SET lock_timeout = '2s'");
		try {
			// PostgreSQL signals old-session release, without a guessed polling delay.
			await fixture.sql.unsafe(
				"SELECT pg_advisory_lock($1::integer, $2::integer)",
				[0x4f545452, 0x50474244],
			);
			owned = true;
			expect(
				(
					await fatalCommand(child, {
						op: "run",
						sql: "INSERT INTO kv VALUES ('replacement_unowned', 'forbidden')",
					})
				).code,
			).not.toBe(0);
			expect(
				await fixture.sql.unsafe(
					"SELECT key FROM ottr_global.kv WHERE key = 'replacement_unowned'",
				),
			).toHaveLength(0);
			expect(
				proxy.queries.some((query) => query.includes("replacement_unowned")),
			).toBe(false);
		} finally {
			if (owned)
				await fixture.sql.unsafe(
					"SELECT pg_advisory_unlock($1::integer, $2::integer)",
					[0x4f545452, 0x50474244],
				);
			await fixture.sql.unsafe("RESET lock_timeout");
			await child.close();
			await proxy.close();
		}
	});

	test("loss of advisory ownership cannot admit an unowned write", async () => {
		const child = startChild(fixture);
		await child.next();
		value(
			await child.request({
				op: "query",
				sql: "SELECT pg_advisory_unlock_all()",
			}),
		);
		const acquired = await fixture.sql.unsafe<{ owned: boolean }[]>(
			"SELECT pg_try_advisory_lock($1::integer, $2::integer) AS owned",
			[0x4f545452, 0x50474244],
		);
		const row = acquired[0];
		if (!row) throw new Error("Advisory lock query returned no row.");
		expect(row.owned).toBe(true);
		try {
			const result = await fatalCommand(child, {
				op: "run",
				sql: "INSERT INTO kv VALUES ('unowned', 'forbidden')",
			});
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("ownership");
			expect(
				await fixture.sql.unsafe(
					"SELECT key FROM ottr_global.kv WHERE key = 'unowned'",
				),
			).toHaveLength(0);
		} finally {
			await fixture.sql.unsafe(
				"SELECT pg_advisory_unlock($1::integer, $2::integer)",
				[0x4f545452, 0x50474244],
			);
		}
	});

	for (const scenario of [
		{ commit: false, reply: "reply" },
		{ commit: true, reply: "reply" },
		{ commit: false, reply: "malformed" },
		{ commit: true, reply: "malformed" },
	] as const)
		test(`${scenario.reply === "reply" ? "lost" : "malformed"} ${scenario.commit ? "COMMIT" : "autocommit"} reply exits without replay`, async () => {
			const { commit, reply } = scenario;
			const proxy = fixture.register(await createPostgresProxy(fixture.url));
			const child = startChild(fixture, proxy.url);
			await child.next();
			const marker = `${reply === "reply" ? "lost" : "malformed"}_${commit ? "commit" : "autocommit"}`;
			proxy.inject(commit ? "COMMIT" : marker, reply);
			const sql = `INSERT INTO events(value) VALUES ('${marker}') /* ${marker} */`;
			const result = await fatalCommand(
				child,
				commit
					? { op: "transaction", steps: [{ op: "run", sql }] }
					: { op: "run", sql },
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("unknown result");
			expect(
				proxy.queries.filter((query) => query.includes(marker)),
			).toHaveLength(1);
			expect([
				...(await fixture.sql.unsafe<unknown[]>(
					"SELECT value FROM ottr_global.events WHERE value = $1",
					[marker],
				)),
			]).toEqual([{ value: marker }]);
			await proxy.close();
		});
});
