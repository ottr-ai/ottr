import { SQL } from "bun";

export interface PostgresTestConfig {
	url: string;
}

export interface NormalizedPostgresUrl extends PostgresTestConfig {
	host: string;
	port: number;
	database: string;
}

export interface PostgresFixture {
	sql: PostgresConnection;
	url: string;
	register<T extends { close(): Promise<void> }>(connection: T): T;
	subprocessEnv(base?: Environment): Environment;
	close(): Promise<void>;
}

export interface PostgresConnection {
	connect(): PromiseLike<unknown>;
	unsafe<T = unknown>(statement: string, values?: unknown[]): PromiseLike<T>;
	close(): Promise<void>;
}

type Environment = Record<string, string | undefined>;

interface FixtureOptions {
	// This seam exercises ownership failures without a running service.
	connect?: (url: string) => PostgresConnection;
	databaseName?: () => string;
	env?: Environment;
}

export const postgresSkipNotice =
	"PostgreSQL tests skipped: OTTR_TEST_PG_URL is absent and OTTR_REQUIRE_PG_TESTS is not 1.";

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

export function normalizePostgresUrl(raw: string): NormalizedPostgresUrl {
	try {
		if (
			!raw ||
			raw.trim() !== raw ||
			raw.includes(" ") ||
			hasControlCharacters(raw)
		)
			throw new Error();
		const source = new URL(raw);
		if (!["postgres:", "postgresql:"].includes(source.protocol) || source.hash)
			throw new Error();
		const decodedHost = decodeURIComponent(source.hostname).toLowerCase();
		if (!decodedHost || /[/\\@?#%\s]/.test(decodedHost)) throw new Error();
		// The HTTP parser also canonicalizes IPv4 shorthand and IPv6 spellings.
		const hostUrl = new URL(`http://${decodedHost}/`);
		if (
			hostUrl.port ||
			hostUrl.username ||
			hostUrl.password ||
			hostUrl.pathname !== "/"
		)
			throw new Error();
		const host = hostUrl.hostname.replace(/\.$/, "");
		if (
			!host ||
			host.endsWith(".") ||
			(!host.startsWith("[") &&
				!host
					.split(".")
					.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
		)
			throw new Error();
		const port = Number(source.port || 5432);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
		const database = decodeURIComponent(source.pathname.slice(1));
		if (
			!source.pathname.startsWith("/") ||
			!database ||
			/[/\\]/.test(database) ||
			hasControlCharacters(database)
		)
			throw new Error();
		const username = decodeURIComponent(source.username);
		const password = decodeURIComponent(source.password);
		if (hasControlCharacters(username) || hasControlCharacters(password))
			throw new Error();
		// Reject every connection override except the driver's TLS mode.
		const parameters = [...source.searchParams];
		if (
			parameters.length > 1 ||
			parameters.some(
				([key, value]) =>
					key !== "sslmode" ||
					![
						"disable",
						"allow",
						"prefer",
						"require",
						"verify-ca",
						"verify-full",
					].includes(value),
			)
		)
			throw new Error();
		const url = new URL(
			`postgres://${host}:${port}/${encodeURIComponent(database)}`,
		);
		url.username = source.username;
		url.password = source.password;
		url.search = source.search;
		return { url: url.href, host, port, database };
	} catch {
		throw new Error(
			"Invalid PostgreSQL URL: require an explicit host and database, with no connection routing parameters.",
		);
	}
}

function validateTestUrl(raw: string, production: string | undefined): string {
	const test = normalizePostgresUrl(raw);
	if (production) {
		let target: NormalizedPostgresUrl;
		try {
			target = normalizePostgresUrl(production);
		} catch {
			throw new Error(
				"Invalid OTTR_DATABASE_URL: PostgreSQL test safety check failed.",
			);
		}
		if (
			test.host === target.host &&
			test.port === target.port &&
			test.database === target.database
		)
			throw new Error(
				"PostgreSQL test target matches the production host, port, and database.",
			);
	}
	return test.url;
}

export function readPostgresTestConfig(
	env: Environment = process.env,
	notice: (message: string) => void = console.info,
): PostgresTestConfig | null {
	if (!env.OTTR_TEST_PG_URL) {
		if (env.OTTR_REQUIRE_PG_TESTS === "1")
			throw new Error(
				"OTTR_TEST_PG_URL is required when OTTR_REQUIRE_PG_TESTS=1.",
			);
		notice(postgresSkipNotice);
		return null;
	}
	return { url: validateTestUrl(env.OTTR_TEST_PG_URL, env.OTTR_DATABASE_URL) };
}

function openPostgresConnection(raw: string): PostgresConnection {
	const target = normalizePostgresUrl(raw);
	const url = new URL(target.url);
	const client = new SQL(target.url, {
		adapter: "postgres",
		hostname: target.host.replace(/^\[|\]$/g, ""),
		port: target.port,
		database: target.database,
		username: decodeURIComponent(url.username) || "postgres",
		password: decodeURIComponent(url.password),
		max: 1,
		connectionTimeout: 5,
	});
	return {
		async connect() {
			try {
				await client.connect();
			} catch {
				throw new Error("PostgreSQL fixture connection failed.");
			}
		},
		async unsafe<T>(statement: string, values?: unknown[]): Promise<T> {
			try {
				return await client.unsafe<T>(statement, values);
			} catch {
				throw new Error("PostgreSQL fixture query failed.");
			}
		},
		async close() {
			try {
				await client.close();
			} catch {
				throw new Error("PostgreSQL fixture connection close failed.");
			}
		},
	};
}

export async function createPostgresFixture(
	config: PostgresTestConfig,
	options: FixtureOptions = {},
): Promise<PostgresFixture> {
	const env = options.env ?? process.env;
	const adminUrl = validateTestUrl(config.url, env.OTTR_DATABASE_URL);
	const name =
		options.databaseName?.() ??
		`ottr_test_${crypto.randomUUID().replaceAll("-", "")}`;
	if (!/^ottr_test_[a-f0-9]{32}$/.test(name))
		throw new Error("Invalid PostgreSQL fixture database identifier.");
	const ownedUrl = new URL(adminUrl);
	ownedUrl.pathname = `/${name}`;
	validateTestUrl(ownedUrl.href, env.OTTR_DATABASE_URL);
	const connect = options.connect ?? openPostgresConnection;
	let admin: PostgresConnection | undefined;
	let owned = false;
	let closed = false;
	const connections = new Set<{ close(): Promise<void> }>();

	async function cleanup(): Promise<Error[]> {
		const errors: Error[] = [];
		for (const connection of connections) {
			try {
				await connection.close();
			} catch {
				errors.push(
					new Error(
						"PostgreSQL fixture connection close failed. Owned database remains untouched.",
					),
				);
			}
		}
		if (owned && errors.length === 0 && admin) {
			try {
				await admin.unsafe(`DROP DATABASE "${name}"`);
				owned = false;
			} catch {
				errors.push(
					new Error("PostgreSQL fixture owned database cleanup failed."),
				);
			}
		}
		if (admin) {
			try {
				await admin.close();
			} catch {
				errors.push(
					new Error(
						"PostgreSQL fixture administrative connection close failed.",
					),
				);
			}
		}
		return errors;
	}

	try {
		admin = connect(adminUrl);
		await admin.connect();
		// Identifiers cannot be parameters. The strict pattern above permits only this generated name.
		await admin.unsafe(`CREATE DATABASE "${name}"`);
		owned = true;
		const sql = connect(ownedUrl.href);
		connections.add(sql);
		await sql.connect();
		return {
			sql,
			url: ownedUrl.href,
			register<T extends { close(): Promise<void> }>(connection: T): T {
				if (closed) throw new Error("PostgreSQL fixture is closed.");
				connections.add(connection);
				return connection;
			},
			subprocessEnv(base: Environment = process.env): Environment {
				if (closed) throw new Error("PostgreSQL fixture is closed.");
				// Explicit driver options in readers must take priority over inherited PGDATABASE.
				return { ...base, OTTR_DATABASE_URL: ownedUrl.href, PGDATABASE: name };
			},
			async close() {
				if (closed) return;
				closed = true;
				const errors = await cleanup();
				if (errors.length)
					throw new AggregateError(
						errors,
						"PostgreSQL fixture cleanup failed.",
					);
			},
		};
	} catch {
		const setup = new Error(
			"PostgreSQL fixture setup failed. Check the isolated test service and CREATE DATABASE permission.",
		);
		const errors = await cleanup();
		throw new AggregateError(
			[setup, ...errors],
			"PostgreSQL fixture setup failed.",
		);
	}
}
