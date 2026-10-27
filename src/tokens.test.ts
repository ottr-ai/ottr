import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "./test/properties.ts";
import { lentProviderEnv } from "./tokens.ts";

// A stand-in for the board store: omp's auth_credentials plus the lease table the refresher
// coordinates through. Every credential holds fake values only.
const dir = mkdtempSync(join(tmpdir(), "ottr-tokens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function store(options: { leases?: boolean } = {}): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `agent-${crypto.randomUUID()}.db`);
	const db = new Database(path);
	db.exec(
		"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
	);
	if (options.leases)
		db.exec(
			"CREATE TABLE auth_credential_refresh_leases (credential_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
	db.close();
	return path;
}

function addRow(
	path: string,
	provider: string,
	data: Record<string, unknown>,
): number {
	const db = new Database(path);
	const row = db
		.query(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, 'oauth', ?, 'acct-1', 1, 1) RETURNING id",
		)
		.get(provider, JSON.stringify(data)) as { id: number };
	db.close();
	return row.id;
}

function rowData(path: string, id: number): Record<string, unknown> {
	const db = new Database(path, { readonly: true });
	const row = db
		.query(
			"SELECT data, identity_key, created_at, updated_at FROM auth_credentials WHERE id = ?",
		)
		.get(id) as {
		data: string;
		identity_key: string;
		created_at: number;
		updated_at: number;
	};
	db.close();
	return {
		...JSON.parse(row.data),
		identity_key: row.identity_key,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

const NOW = 1_700_000_000_000;

/** A fetch that answers omp's refresh shape and records every call. */
function fetchFake(
	calls: { url: string; init: RequestInit }[],
	status = 200,
): typeof fetch {
	return (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(
			JSON.stringify({
				access_token: "access-new",
				refresh_token: "refresh-new",
				expires_in: 3600,
			}),
			{ status },
		);
	}) as typeof fetch;
}

const opts = (path: string, calls: { url: string; init: RequestInit }[]) => ({
	dbPath: path,
	now: NOW,
	fetchImpl: fetchFake(calls),
});

describe("lentProviderEnv", () => {
	test("a fresh row lends its access token without any request", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 8 * 3_600_000,
		});
		const calls: { url: string; init: RequestInit }[] = [];
		expect(
			await lentProviderEnv("anthropic/claude-opus-5-5", opts(path, calls)),
		).toEqual({
			ANTHROPIC_OAUTH_TOKEN: "access-1",
		});
		expect(calls).toHaveLength(0);
	});

	test("a stale anthropic row refreshes over JSON, writes back, releases the lease", async () => {
		const path = store({ leases: true });
		const id = addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		const calls: { url: string; init: RequestInit }[] = [];
		expect(
			await lentProviderEnv("anthropic/claude-opus-5-5", opts(path, calls)),
		).toEqual({
			ANTHROPIC_OAUTH_TOKEN: "access-new",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/oauth/token");
		expect(calls[0]!.init.headers).toMatchObject({
			"anthropic-beta": "oauth-2025-04-20",
		});
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
			grant_type: "refresh_token",
			client_id: "9d1c250a-e61b-44d9-88ed-594fedd48592",
			refresh_token: "refresh-1",
		});
		const written = rowData(path, id);
		expect(written.access).toBe("access-new");
		expect(written.refresh).toBe("refresh-new");
		// 3600s minus the 5-minute skew, in ms since the fixed now.
		expect(written.expires).toBe(NOW + (3600 - 300) * 1000);
		expect(written.identity_key).toBe("acct-1");
		expect(written.created_at).toBe(1);
		expect(written.updated_at).toBe(Math.floor(NOW / 1000));
		const db = new Database(path, { readonly: true });
		expect(
			db.query("SELECT * FROM auth_credential_refresh_leases").all(),
		).toEqual([]);
		db.close();
	});

	test("an expired codex row refreshes over a form body", async () => {
		const path = store();
		addRow(path, "openai-codex", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW - 1000,
		});
		const calls: { url: string; init: RequestInit }[] = [];
		expect(
			await lentProviderEnv("openai-codex/gpt-6", opts(path, calls)),
		).toEqual({
			OPENAI_CODEX_OAUTH_TOKEN: "access-new",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://auth.openai.com/oauth/token");
		const body = new URLSearchParams(String(calls[0]!.init.body));
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("refresh-1");
		expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
	});

	test("a zai row with the sentinel expiry lends the key without a refresh", async () => {
		const path = store();
		addRow(path, "zai", { access: "access-1", expires: 8640000000000000 });
		const calls: { url: string; init: RequestInit }[] = [];
		expect(
			await lentProviderEnv("zai/glm-5.3-flash", opts(path, calls)),
		).toEqual({
			ZAI_API_KEY: "access-1",
		});
		expect(calls).toHaveLength(0);
	});

	test("a failed refresh lends nothing and leaves the row untouched", async () => {
		const path = store();
		const id = addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		const before = rowData(path, id);
		const calls: { url: string; init: RequestInit }[] = [];
		const failing = opts(path, calls);
		failing.fetchImpl = fetchFake(calls, 400);
		expect(await lentProviderEnv("anthropic/claude-opus-5-5", failing)).toEqual(
			{},
		);
		expect(rowData(path, id)).toEqual(before);
	});

	test("an unknown provider, or a missing db, lends nothing", async () => {
		const path = store();
		const calls: { url: string; init: RequestInit }[] = [];
		expect(await lentProviderEnv("foo/bar", opts(path, calls))).toEqual({});
		expect(
			await lentProviderEnv("anthropic/claude-opus-5-5", {
				dbPath: join(dir, "nope.db"),
				now: NOW,
				fetchImpl: fetchFake(calls),
			}),
		).toEqual({});
		expect(calls).toHaveLength(0);
	});

	test("a live lease by another owner: fresh row lends, stale row lends nothing", async () => {
		const path = store({ leases: true });
		const fresh = addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			// Beyond the refresh margin, so the row is fresh on its own.
			expires: NOW + 2 * 3_600_000,
		});
		const db = new Database(path);
		db.query(
			"INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at) VALUES (?, 'other', ?, 1)",
		).run(fresh, NOW + 600_000);
		db.close();
		const calls: { url: string; init: RequestInit }[] = [];
		expect(
			await lentProviderEnv("anthropic/claude-opus-5-5", opts(path, calls)),
		).toEqual({
			ANTHROPIC_OAUTH_TOKEN: "access-1",
		});
		expect(calls).toHaveLength(0);

		const stale = addRow(path, "openai-codex", {
			access: "access-2",
			refresh: "refresh-2",
			expires: NOW - 1000,
		});
		const db2 = new Database(path);
		db2
			.query(
				"INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at) VALUES (?, 'other', ?, 1)",
			)
			.run(stale, NOW + 600_000);
		db2.close();
		expect(
			await lentProviderEnv("openai-codex/gpt-6", opts(path, calls)),
		).toEqual({});
		expect(calls).toHaveLength(0);
	});

	test("a :level suffix in the model does not break the provider extraction", async () => {
		const path = store();
		addRow(path, "zai", { access: "access-1", expires: 8640000000000000 });
		const calls: { url: string; init: RequestInit }[] = [];
		expect(
			await lentProviderEnv("zai/glm-5.3-flash:max", opts(path, calls)),
		).toEqual({ ZAI_API_KEY: "access-1" });
		expect(calls).toHaveLength(0);
	});

	// The store's data column is omp's; any junk in it must degrade to a shaped
	// result, never throw into the turn's env seeding.
	test("any junk in the data column lends a shaped result or nothing", async () => {
		const path = store({ leases: true });
		const id = addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW - 1,
		});
		const db = new Database(path);
		const set = db.query("UPDATE auth_credentials SET data = ? WHERE id = ?");
		await fc.assert(
			fc.asyncProperty(fc.json(), async (junk) => {
				set.run(typeof junk === "string" ? junk : JSON.stringify(junk), id);
				const out = await lentProviderEnv("anthropic/claude-opus-5-5", {
					dbPath: path,
					now: NOW,
					fetchImpl: fetchFake([]),
				});
				const keys = Object.keys(out);
				expect(keys.length <= 1).toBe(true);
				if (keys.length === 1) {
					expect(keys[0]).toBe("ANTHROPIC_OAUTH_TOKEN");
					expect(typeof out[keys[0]!]).toBe("string");
				}
			}),
		);
		db.close();
	});
});
