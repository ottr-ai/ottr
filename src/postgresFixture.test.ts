import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	createPostgresFixture,
	type NormalizedPostgresUrl,
	normalizePostgresUrl,
	type PostgresConnection,
	type PostgresFixture,
	postgresSkipNotice,
	readPostgresTestConfig,
} from "./test/postgres";
import fc from "./test/properties";

const adminUrl = "postgres://postgres@fixture.invalid/postgres";
const databaseName = `ottr_test_${"a".repeat(32)}`;
const identifier = `"${databaseName}"`;

function errorText(error: unknown): string {
	if (!(error instanceof Error)) return "not an Error";
	return [
		error.message,
		error.stack,
		error.cause === undefined ? "" : errorText(error.cause),
		...(error instanceof AggregateError ? error.errors.map(errorText) : []),
	].join("\n");
}

async function failure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("Expected an Error instance.");
	}
	throw new Error("Expected the operation to fail.");
}

function fakeDriver(failures: string[] = []) {
	const events: string[] = [];
	const urls: string[] = [];
	const leak = crypto.randomUUID();
	function step(event: string) {
		events.push(event);
		if (failures.includes(event))
			throw new Error(leak, { cause: new Error(leak) });
	}
	return {
		events,
		urls,
		leak,
		connect(url: string): PostgresConnection {
			const role = urls.length === 0 ? "admin" : "test";
			urls.push(url);
			step(`${role}:new`);
			return {
				async connect() {
					step(`${role}:connect`);
				},
				async unsafe<T>(statement: string): Promise<T> {
					step(statement);
					return [] as T;
				},
				async close() {
					step(`${role}:close`);
				},
			};
		},
	};
}

function options(driver: { connect(url: string): PostgresConnection }) {
	return { connect: driver.connect, databaseName: () => databaseName, env: {} };
}

function expectSafe(error: Error, secret: string) {
	expect(errorText(error)).not.toContain(secret);
	expect(errorText(error)).not.toContain(adminUrl);
	expect(error.cause).toBeUndefined();
}

describe("PostgreSQL test configuration", () => {
	test("optional absence emits an explicit skip notice", () => {
		const notices: string[] = [];
		expect(
			readPostgresTestConfig({}, (message) => notices.push(message)),
		).toBeNull();
		expect(notices).toEqual([postgresSkipNotice]);
	});

	test("required absence or an empty URL fails without a skip notice", () => {
		for (const value of [undefined, ""]) {
			const notices: string[] = [];
			expect(() =>
				readPostgresTestConfig(
					{
						OTTR_REQUIRE_PG_TESTS: "1",
						OTTR_TEST_PG_URL: value,
					},
					(message) => notices.push(message),
				),
			).toThrow("OTTR_TEST_PG_URL is required when OTTR_REQUIRE_PG_TESTS=1.");
			expect(notices).toEqual([]);
		}
	});

	test("a configured malformed URL fails in optional and required modes", () => {
		for (const required of [undefined, "1"]) {
			const notices: string[] = [];
			expect(() =>
				readPostgresTestConfig(
					{
						OTTR_TEST_PG_URL: "not a URL",
						OTTR_REQUIRE_PG_TESTS: required,
					},
					(message) => notices.push(message),
				),
			).toThrow("Invalid PostgreSQL URL");
			expect(notices).toEqual([]);
		}
	});

	test("a malformed production URL fails safely", () => {
		const secret = crypto.randomUUID();
		expect(() =>
			readPostgresTestConfig({
				OTTR_TEST_PG_URL: adminUrl,
				OTTR_DATABASE_URL: secret,
			}),
		).toThrow(
			"Invalid OTTR_DATABASE_URL: PostgreSQL test safety check failed.",
		);
	});

	test.each([
		["postgres://PG.EXAMPLE./%64ata", "postgresql://pg.example:5432/data"],
		["postgres://%70g.example/data", "postgresql://pg.example:5432/%64ata"],
		["postgres://127.1/data", "postgres://127.0.0.1:5432/data"],
		["postgres://0x7f000001/data", "postgres://127.0.0.1/data"],
		["postgres://[0:0:0:0:0:0:0:1]/data", "postgresql://[::1]:5432/data"],
		["postgres://[::ffff:127.0.0.1]/data", "postgres://[::ffff:7f00:1]/data"],
	])(
		"equivalent endpoint spellings refuse production: %s",
		(testUrl, production) => {
			expect(() =>
				readPostgresTestConfig({
					OTTR_TEST_PG_URL: testUrl,
					OTTR_DATABASE_URL: production,
				}),
			).toThrow("matches the production host, port, and database");
		},
	);

	test("encoded credential characters keep their exact decoded values", () => {
		const credential = `${crypto.randomUUID()}%:@`;
		const source = new URL("postgres://pg.example/data");
		source.username = encodeURIComponent(credential);
		source.password = encodeURIComponent(credential);
		const target = new URL(normalizePostgresUrl(source.href).url);
		expect(decodeURIComponent(target.username) === credential).toBe(true);
		expect(decodeURIComponent(target.password) === credential).toBe(true);
		expect(normalizePostgresUrl(target.href).url === target.href).toBe(true);
	});

	test("credentials and TLS settings cannot distinguish a production target", () => {
		const first = new URL("postgres://pg.example/data?sslmode=require");
		first.username = crypto.randomUUID();
		first.password = crypto.randomUUID();
		const second = new URL("postgresql://pg.example.:5432/%64ata");
		second.username = crypto.randomUUID();
		expect(() =>
			readPostgresTestConfig({
				OTTR_TEST_PG_URL: first.href,
				OTTR_DATABASE_URL: second.href,
			}),
		).toThrow("matches the production host, port, and database");
	});

	test.each([
		"postgres://other.example/data",
		"postgres://pg.example:5433/data",
		"postgres://pg.example/other",
		"postgres://pg.example/Data",
	])("a distinct host, port, or exact database is accepted: %s", (url) => {
		expect(
			readPostgresTestConfig({
				OTTR_TEST_PG_URL: url,
				OTTR_DATABASE_URL: "postgres://pg.example/data",
			}),
		).not.toBeNull();
	});

	test.each([
		"host",
		"hostname",
		"hostaddr",
		"port",
		"database",
		"dbname",
		"db",
		"user",
		"username",
		"password",
		"path",
		"socket",
		"options",
		"service",
		"target_session_attrs",
		"ssl",
		"Host",
		"sslmode",
	])(
		"routing and unsupported parameters fail before a connection: %s",
		async (key) => {
			const driver = fakeDriver();
			const url = new URL(adminUrl);
			url.searchParams.set(key, key === "sslmode" ? "unknown" : "destination");
			const error = await failure(
				createPostgresFixture({ url: url.href }, options(driver)),
			);
			expect(error.message).toContain("Invalid PostgreSQL URL");
			expect(driver.events).toEqual([]);
		},
	);

	test("duplicate TLS parameters and production routing overrides fail", () => {
		expect(() =>
			normalizePostgresUrl(`${adminUrl}?sslmode=require&sslmode=disable`),
		).toThrow();
		expect(() =>
			readPostgresTestConfig({
				OTTR_TEST_PG_URL: adminUrl,
				OTTR_DATABASE_URL:
					"postgres://production.invalid/data?host=fixture.invalid",
			}),
		).toThrow("Invalid OTTR_DATABASE_URL");
	});

	test.each([
		"sqlite://data.db",
		"http://pg.example/data",
		"postgres:///data",
		"postgres://pg.example",
		"postgres://pg.example/",
		"postgres://pg.example/data#fragment",
		"postgres://pg.example:0/data",
		"postgres://pg.example:65536/data",
		"postgres://pg.example/data/extra",
		"postgres://pg.example/%00",
		"postgres://pg.example/%GG",
		"postgres://pg..example/data",
		" postgres://pg.example/data",
		"postgres://pg.example/%0a",
		"postgres://pg.example%2Fother/data",
		"postgres://pg.example/data?%68ost=other",
	])("invalid or ambiguous URL is rejected: %s", (url) => {
		expect(() => normalizePostgresUrl(url)).toThrow("Invalid PostgreSQL URL");
	});

	test("normalization keeps TLS mode, decoded database, and explicit default port", () => {
		const target = normalizePostgresUrl(
			"postgresql://PG.EXAMPLE./data%20set?sslmode=verify-full",
		);
		expect(target).toEqual({
			host: "pg.example",
			port: 5432,
			database: "data set",
			url: "postgres://pg.example:5432/data%20set?sslmode=verify-full",
		});
	});

	test("arbitrary input either normalizes idempotently or gives a safe error", () => {
		fc.assert(
			fc.property(fc.string(), (raw) => {
				let target: NormalizedPostgresUrl;
				try {
					target = normalizePostgresUrl(raw);
				} catch (error) {
					expect((error as Error).message).toBe(
						"Invalid PostgreSQL URL: require an explicit host and database, with no connection routing parameters.",
					);
					return;
				}
				expect(normalizePostgresUrl(target.url)).toEqual(target);
			}),
		);
	});

	const word = fc
		.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
			minLength: 1,
			maxLength: 16,
		})
		.map((letters) => letters.join(""));
	test("equivalent encoded production targets always fail", () => {
		fc.assert(
			fc.property(word, word, (host, database) => {
				const encodedDatabase = [...database]
					.map((letter) => `%${letter.charCodeAt(0).toString(16)}`)
					.join("");
				expect(() =>
					readPostgresTestConfig({
						OTTR_TEST_PG_URL: `postgresql://${host.toUpperCase()}.invalid./${encodedDatabase}`,
						OTTR_DATABASE_URL: `postgres://${host}.invalid:5432/${database}`,
					}),
				).toThrow("matches the production host, port, and database");
			}),
		);
	});

	test("generated valid URLs normalize idempotently and preserve the destination", () => {
		fc.assert(
			fc.property(
				word,
				word,
				fc.integer({ min: 1, max: 65535 }),
				(host, database, port) => {
					const target = normalizePostgresUrl(
						`postgresql://${host.toUpperCase()}.invalid.:${port}/${database}`,
					);
					expect(target.host).toBe(`${host}.invalid`);
					expect(target.port).toBe(port);
					expect(target.database).toBe(database);
					expect(normalizePostgresUrl(target.url)).toEqual(target);
				},
			),
		);
	});

	test("arbitrary query override values never alter the destination", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const url = new URL(adminUrl);
				url.searchParams.set("host", value);
				expect(() => normalizePostgresUrl(url.href)).toThrow(
					"Invalid PostgreSQL URL",
				);
			}),
		);
	});
});

describe("PostgreSQL fixture ownership and cleanup", () => {
	test("production equality prevents every connection, including after config creation", async () => {
		const driver = fakeDriver();
		const config = readPostgresTestConfig({ OTTR_TEST_PG_URL: adminUrl });
		if (!config) throw new Error("Expected a configured fixture.");
		const error = await failure(
			createPostgresFixture(config, {
				...options(driver),
				env: { OTTR_DATABASE_URL: adminUrl },
			}),
		);
		expect(error.message).toContain("matches the production");
		expect(driver.events).toEqual([]);
	});

	test("the generated database is checked against production before admin connection", async () => {
		const driver = fakeDriver();
		const error = await failure(
			createPostgresFixture(
				{ url: adminUrl },
				{
					...options(driver),
					env: {
						OTTR_DATABASE_URL: `postgres://fixture.invalid/${databaseName}`,
					},
				},
			),
		);
		expect(error.message).toContain("matches the production");
		expect(driver.events).toEqual([]);
	});

	test("identifiers reject non-generated characters before any connection", async () => {
		const driver = fakeDriver();
		for (const name of [
			"existing",
			`${databaseName}"; DROP DATABASE postgres`,
			`${databaseName}x`,
			databaseName.toUpperCase(),
		]) {
			const error = await failure(
				createPostgresFixture(
					{ url: adminUrl },
					{
						...options(driver),
						databaseName: () => name,
					},
				),
			);
			expect(error.message).toBe(
				"Invalid PostgreSQL fixture database identifier.",
			);
		}
		expect(driver.events).toEqual([]);
	});

	test("a CREATE collision never adopts or drops the existing database", async () => {
		const driver = fakeDriver([`CREATE DATABASE ${identifier}`]);
		const error = await failure(
			createPostgresFixture({ url: adminUrl }, options(driver)),
		);
		expect(driver.events).toEqual([
			"admin:new",
			"admin:connect",
			`CREATE DATABASE ${identifier}`,
			"admin:close",
		]);
		expectSafe(error, driver.leak);
	});

	test("admin connection failure never creates or drops a database", async () => {
		const driver = fakeDriver(["admin:connect"]);
		const error = await failure(
			createPostgresFixture({ url: adminUrl }, options(driver)),
		);
		expect(driver.events).toEqual([
			"admin:new",
			"admin:connect",
			"admin:close",
		]);
		expectSafe(error, driver.leak);
	});

	test("only successful CREATE permits cleanup after test connection failure", async () => {
		const driver = fakeDriver(["test:connect"]);
		const error = await failure(
			createPostgresFixture({ url: adminUrl }, options(driver)),
		);
		expect(driver.events).toEqual([
			"admin:new",
			"admin:connect",
			`CREATE DATABASE ${identifier}`,
			"test:new",
			"test:connect",
			"test:close",
			`DROP DATABASE ${identifier}`,
			"admin:close",
		]);
		expectSafe(error, driver.leak);
	});

	test("test connection construction failure still cleans its owned database", async () => {
		const driver = fakeDriver(["test:new"]);
		const error = await failure(
			createPostgresFixture({ url: adminUrl }, options(driver)),
		);
		expect(driver.events).toEqual([
			"admin:new",
			"admin:connect",
			`CREATE DATABASE ${identifier}`,
			"test:new",
			`DROP DATABASE ${identifier}`,
			"admin:close",
		]);
		expectSafe(error, driver.leak);
	});

	test("all registered owners close before the exact owned DROP and admin close", async () => {
		const driver = fakeDriver();
		const fixture = await createPostgresFixture(
			{ url: adminUrl },
			options(driver),
		);
		const owner = {
			async close() {
				driver.events.push("owner:close");
			},
		};
		expect(fixture.register(owner)).toBe(owner);
		fixture.register(owner);
		expect(driver.urls).toEqual([
			"postgres://postgres@fixture.invalid:5432/postgres",
			`postgres://postgres@fixture.invalid:5432/${databaseName}`,
		]);
		expect(
			fixture.subprocessEnv({ KEEP: "yes", OTTR_DATABASE_URL: "unused" }),
		).toEqual({
			KEEP: "yes",
			OTTR_DATABASE_URL: fixture.url,
			PGDATABASE: databaseName,
		});
		await fixture.close();
		await fixture.close();
		expect(driver.events).toEqual([
			"admin:new",
			"admin:connect",
			`CREATE DATABASE ${identifier}`,
			"test:new",
			"test:connect",
			"test:close",
			"owner:close",
			`DROP DATABASE ${identifier}`,
			"admin:close",
		]);
		expect(() => fixture.register(owner)).toThrow("fixture is closed");
		expect(() => fixture.subprocessEnv()).toThrow("fixture is closed");
	});

	test("a failed close prevents DROP but still closes all other owners and admin", async () => {
		const driver = fakeDriver(["test:close"]);
		const fixture = await createPostgresFixture(
			{ url: adminUrl },
			options(driver),
		);
		fixture.register({
			async close() {
				driver.events.push("owner:close");
			},
		});
		const error = await failure(fixture.close());
		expect(driver.events.slice(-3)).toEqual([
			"test:close",
			"owner:close",
			"admin:close",
		]);
		expect(driver.events).not.toContain(`DROP DATABASE ${identifier}`);
		expect(errorText(error)).toContain("Owned database remains untouched");
		expectSafe(error, driver.leak);
	});

	test("registered owner close failure also prevents DROP", async () => {
		const driver = fakeDriver();
		const fixture = await createPostgresFixture(
			{ url: adminUrl },
			options(driver),
		);
		fixture.register({
			async close() {
				throw new Error(driver.leak);
			},
		});
		const error = await failure(fixture.close());
		expect(driver.events).not.toContain(`DROP DATABASE ${identifier}`);
		expect(driver.events.at(-1)).toBe("admin:close");
		expectSafe(error, driver.leak);
	});

	test("setup and all cleanup failures remain visible without raw causes", async () => {
		const driver = fakeDriver(["test:connect", "test:close", "admin:close"]);
		const error = await failure(
			createPostgresFixture({ url: adminUrl }, options(driver)),
		);
		expect(error).toBeInstanceOf(AggregateError);
		expect(
			(error as AggregateError).errors.map((item: Error) => item.message),
		).toEqual([
			"PostgreSQL fixture setup failed. Check the isolated test service and CREATE DATABASE permission.",
			"PostgreSQL fixture connection close failed. Owned database remains untouched.",
			"PostgreSQL fixture administrative connection close failed.",
		]);
		expect(driver.events).not.toContain(`DROP DATABASE ${identifier}`);
		expectSafe(error, driver.leak);
	});

	test("DROP and admin close errors both remain visible and sanitized", async () => {
		const driver = fakeDriver([`DROP DATABASE ${identifier}`, "admin:close"]);
		const fixture = await createPostgresFixture(
			{ url: adminUrl },
			options(driver),
		);
		const error = await failure(fixture.close());
		expect(
			(error as AggregateError).errors.map((item: Error) => item.message),
		).toEqual([
			"PostgreSQL fixture owned database cleanup failed.",
			"PostgreSQL fixture administrative connection close failed.",
		]);
		expectSafe(error, driver.leak);
	});

	test("setup and DROP errors both remain visible", async () => {
		const driver = fakeDriver(["test:connect", `DROP DATABASE ${identifier}`]);
		const error = await failure(
			createPostgresFixture({ url: adminUrl }, options(driver)),
		);
		expect(
			(error as AggregateError).errors.map((item: Error) => item.message),
		).toEqual([
			"PostgreSQL fixture setup failed. Check the isolated test service and CREATE DATABASE permission.",
			"PostgreSQL fixture owned database cleanup failed.",
		]);
		expect(driver.events.at(-1)).toBe("admin:close");
		expectSafe(error, driver.leak);
	});

	test("random fixtures never reuse their database names", async () => {
		const first = fakeDriver();
		const second = fakeDriver();
		const one = await createPostgresFixture(
			{ url: adminUrl },
			{ connect: first.connect, env: {} },
		);
		const two = await createPostgresFixture(
			{ url: adminUrl },
			{ connect: second.connect, env: {} },
		);
		try {
			expect(new URL(one.url).pathname).toMatch(/^\/ottr_test_[a-f0-9]{32}$/);
			expect(one.url).not.toBe(two.url);
		} finally {
			await Promise.all([one.close(), two.close()]);
		}
	});

	test("a configured unreachable URL fails instead of a skip", async () => {
		const config = readPostgresTestConfig({
			OTTR_TEST_PG_URL: "postgres://postgres@127.0.0.1:1/postgres",
		});
		if (!config) throw new Error("Expected a configured fixture.");
		const error = await failure(createPostgresFixture(config, { env: {} }));
		expect(error.message).toBe("PostgreSQL fixture setup failed.");
		expect(errorText(error)).not.toContain(config.url);
		expect(errorText(error)).not.toContain("ECONNREFUSED");
	}, 15_000);
});

const liveConfig = readPostgresTestConfig();
let liveFixture: PostgresFixture | undefined;
beforeAll(async () => {
	if (liveConfig) liveFixture = await createPostgresFixture(liveConfig);
}, 15_000);
afterAll(async () => {
	await liveFixture?.close();
}, 15_000);

(liveConfig ? test : test.skip)(
	"live fixture reads its exact owned database through Bun.SQL",
	async () => {
		if (!liveFixture) throw new Error("Expected the live PostgreSQL fixture.");
		const rows = await liveFixture.sql.unsafe<
			{ database: string; registered: boolean }[]
		>(
			"SELECT current_database() AS database, EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database()) AS registered",
		);
		expect(rows).toEqual([
			{
				database: new URL(liveFixture.url).pathname.slice(1),
				registered: true,
			},
		]);
	},
);
