import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boardOmpHome } from "./login.ts";
import fc from "./test/properties.ts";
import { lentProviderEnv } from "./tokens.ts";

// A stand-in for the board store (omp's auth_credentials) and for `omp token <provider>
// --force-refresh`. The fake logs each run's argv and env, then acts by the mode file in its
// agent dir: "ok" re-mints the provider's newest active row the way omp does, "fail" prints
// omp's error and exits 1, "stdout-only" prints a key and exits 0 without a store write (omp's
// key cascade can do that after a failed refresh). Every credential holds fake values only.
const dir = mkdtempSync(join(tmpdir(), "ottr-tokens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fake = join(dir, "fake-omp-token.ts");
const RUNS = join(dir, "runs.log");
writeFileSync(
	fake,
	`import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
appendFileSync(${JSON.stringify(RUNS)}, JSON.stringify({ args, agentDir, home: process.env.HOME }) + "\\n");
const modeFile = agentDir + "/fake-mode.json";
const { mode, expires } = existsSync(modeFile) ? JSON.parse(readFileSync(modeFile, "utf8")) : { mode: "fail" };
if (mode === "fail") {
	console.error("\\x1b[31mError: token refresh failed: 400 invalid_grant\\x1b[0m");
	process.exit(1);
}
if (mode === "stdout-only") {
	console.log("sk-ant-api-fake-env-key");
	process.exit(0);
}
const db = new Database(agentDir + "/agent.db");
const row = db.query("SELECT id, data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL ORDER BY id DESC LIMIT 1").get(args[0]);
db.query("UPDATE auth_credentials SET data = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.data), access: "access-new", refresh: "refresh-new", expires }), row.id);
db.close();
console.log("access-new");
`,
);

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const command = [process.execPath, fake];

/** A fresh board agent dir holding an omp store; returns the store path. */
function store(): string {
	const agent = mkdtempSync(join(dir, "agent-"));
	const path = join(agent, "agent.db");
	const db = new Database(path);
	db.exec(
		"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)",
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

function rowData(path: string, id: number): unknown {
	const db = new Database(path, { readonly: true });
	const row = db
		.query("SELECT data FROM auth_credentials WHERE id = ?")
		.get(id) as { data: string };
	db.close();
	return JSON.parse(row.data);
}

/** Sets what the fake omp does for the store at `path`. */
const omp = (path: string, mode: string, expires = NOW + 8 * HOUR) =>
	writeFileSync(
		join(dirname(path), "fake-mode.json"),
		JSON.stringify({ mode, expires }),
	);

/** The fake's runs against the store at `path`. */
const runs = (
	path: string,
): Array<{ args: string[]; agentDir: string; home: string }> =>
	(existsSync(RUNS) ? readFileSync(RUNS, "utf8") : "")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line))
		.filter((r) => r.agentDir === dirname(path));

const lend = (model: string, path: string) =>
	lentProviderEnv(model, { dbPath: path, now: NOW, command });

describe("lentProviderEnv", () => {
	test("a fresh row lends its access token without running omp", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 8 * HOUR,
		});
		expect(await lend("anthropic/claude-opus-5-5", path)).toEqual({
			env: { ANTHROPIC_OAUTH_TOKEN: "access-1" },
			error: null,
		});
		expect(runs(path)).toEqual([]);
	});

	test("a token near its expiry makes omp refresh it in the board store, then lends the new one", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		omp(path, "ok");
		expect(await lend("anthropic/claude-opus-5-5", path)).toEqual({
			env: { ANTHROPIC_OAUTH_TOKEN: "access-new" },
			error: null,
		});
		// One omp run, against the board agent dir and the board's own omp home.
		expect(runs(path)).toEqual([
			{
				args: ["anthropic", "--force-refresh"],
				agentDir: dirname(path),
				home: boardOmpHome(),
			},
		]);
	});

	test("an expired codex token is refreshed by omp and lent under omp's codex env name", async () => {
		const path = store();
		addRow(path, "openai-codex", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW - 1000,
		});
		omp(path, "ok");
		expect(await lend("openai-codex/gpt-6", path)).toEqual({
			env: { OPENAI_CODEX_OAUTH_TOKEN: "access-new" },
			error: null,
		});
		expect(runs(path).map((r) => r.args)).toEqual([
			["openai-codex", "--force-refresh"],
		]);
	});

	test("a failed omp refresh lends nothing, names omp's cause, and leaves the row alone", async () => {
		const path = store();
		const id = addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		const before = rowData(path, id);
		omp(path, "fail");
		const lent = await lend("anthropic/claude-opus-5-5", path);
		expect(lent.env).toEqual({});
		expect(lent.error).toBe(
			"omp did not refresh the board's anthropic sign-in: Error: token refresh failed: 400 invalid_grant",
		);
		expect(rowData(path, id)).toEqual(before);
	});

	test("omp's stdout is never lent: exit 0 without a store refresh lends nothing", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		omp(path, "stdout-only");
		const lent = await lend("anthropic/claude-opus-5-5", path);
		expect(lent.env).toEqual({});
		expect(lent.error).toContain("still near its expiry after omp ran");
	});

	test("a refresh that leaves too little life is not lent", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		omp(path, "ok", NOW + 10 * 60_000);
		expect((await lend("anthropic/claude-opus-5-5", path)).env).toEqual({});
	});

	test("omp that cannot start lends nothing and says so", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "access-1",
			refresh: "refresh-1",
			expires: NOW + 60_000,
		});
		const lent = await lentProviderEnv("anthropic/claude-opus-5-5", {
			dbPath: path,
			now: NOW,
			command: [join(dir, "no-such-omp")],
		});
		expect(lent.env).toEqual({});
		expect(lent.error).toContain("cannot run omp token");
	});

	test("an API key signed in after the OAuth row is the current credential: nothing is lent", async () => {
		const path = store();
		addRow(path, "zai", {
			access: "zai-old-oauth",
			expires: 8640000000000000,
			authorizedAt: NOW - HOUR,
		});
		// omp's API-key login: a new row beside the OAuth one, stamped with the login's second.
		const db = new Database(path);
		db.query(
			"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES ('zai', 'api_key', ?, ?, ?)",
		).run(
			JSON.stringify({ key: "key-1", source: "login" }),
			NOW / 1000,
			NOW / 1000,
		);
		db.close();
		expect(await lend("zai/glm-5.3", path)).toEqual({ env: {}, error: null });
		expect(runs(path)).toEqual([]);
	});

	test("a zai row with the sentinel expiry lends the key without running omp", async () => {
		const path = store();
		addRow(path, "zai", { access: "access-1", expires: 8640000000000000 });
		expect(await lend("zai/glm-5.3-flash:max", path)).toEqual({
			env: { ZAI_API_KEY: "access-1" },
			error: null,
		});
		expect(runs(path)).toEqual([]);
	});

	test("a provider the board does not lend, or a local run, lends nothing and is no error", async () => {
		const path = store();
		const none = { env: {}, error: null };
		expect(await lend("foo/bar", path)).toEqual(none);
		expect(await lentProviderEnv(null, { dbPath: path })).toEqual(none);
		expect(runs(path)).toEqual([]);
	});

	// Fail closed: for a provider the board lends, anything short of a usable token is an error
	// with its cause, and the worker turn does not start.
	test("a missing board sign-in is an error", async () => {
		const path = store();
		expect(await lend("anthropic/claude-opus-5-5", path)).toEqual({
			env: {},
			error: "the board has no anthropic sign-in",
		});
		const missing = join(dir, "absent", "agent.db");
		expect((await lend("anthropic/claude-opus-5-5", missing)).error).toBe(
			`the board store ${missing} does not exist`,
		);
		expect(existsSync(missing)).toBe(false);
		expect(runs(path)).toEqual([]);
	});

	test("a disabled board sign-in is an error that names omp's cause", async () => {
		const path = store();
		const db = new Database(path);
		db.query(
			"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES ('anthropic', 'oauth', ?, 'oauth refresh failed: invalid_grant', 1, 1)",
		).run(
			JSON.stringify({
				access: "access-1",
				refresh: "refresh-1",
				expires: NOW + 8 * HOUR,
			}),
		);
		db.close();
		expect(await lend("anthropic/claude-opus-5-5", path)).toEqual({
			env: {},
			error:
				"the board's anthropic sign-in is disabled (oauth refresh failed: invalid_grant)",
		});
		expect(runs(path)).toEqual([]);
	});

	test("an empty access token is an error, never a lent token", async () => {
		const path = store();
		addRow(path, "anthropic", {
			access: "",
			refresh: "refresh-1",
			expires: NOW + 8 * HOUR,
		});
		expect(await lend("anthropic/claude-opus-5-5", path)).toEqual({
			env: {},
			error: "the board's anthropic sign-in has no access token",
		});
	});

	test("an absent expiry is an error, not an endless token", async () => {
		const path = store();
		addRow(path, "anthropic", { access: "access-1", refresh: "refresh-1" });
		expect(await lend("anthropic/claude-opus-5-5", path)).toEqual({
			env: {},
			error: "the board's anthropic sign-in has no valid expiry",
		});
	});

	test("a string expiry is an error, not an endless token", async () => {
		const path = store();
		addRow(path, "openai-codex", {
			access: "access-1",
			refresh: "refresh-1",
			expires: String(NOW + 8 * HOUR),
		});
		expect(await lend("openai-codex/gpt-6", path)).toEqual({
			env: {},
			error: "the board's openai-codex sign-in has no valid expiry",
		});
	});

	test("a model that names no provider is an error", async () => {
		const path = store();
		expect(await lend("claude-opus-5-5", path)).toEqual({
			env: {},
			error:
				"the model claude-opus-5-5 names no provider (expected provider/model)",
		});
	});

	// The data column is omp's; any junk in it must never throw into the turn's env seeding, never
	// lend anything but a non-empty string token, and fail closed: no token means an error.
	test("any junk in the data column lends a usable token or returns an error", async () => {
		const path = store();
		const id = addRow(path, "anthropic", { access: "access-1" });
		const db = new Database(path);
		// Each run rewrites the row: with fsync on, 200 writes took 18 s on a loaded host.
		// The store is throwaway, so skip fsync; readers still see each write.
		db.exec("PRAGMA synchronous = OFF");
		const set = db.query("UPDATE auth_credentials SET data = ? WHERE id = ?");
		await fc.assert(
			fc.asyncProperty(fc.json(), async (junk) => {
				set.run(junk, id);
				const lent = await lentProviderEnv("anthropic/claude-opus-5-5", {
					dbPath: path,
					now: NOW,
					command: [join(dir, "no-such-omp")],
				});
				const keys = Object.keys(lent.env);
				expect(keys.length <= 1).toBe(true);
				if (keys.length === 1) {
					expect(keys[0]).toBe("ANTHROPIC_OAUTH_TOKEN");
					expect(lent.env.ANTHROPIC_OAUTH_TOKEN).toBeString();
					expect(lent.env.ANTHROPIC_OAUTH_TOKEN!.trim()).not.toBe("");
					expect(lent.error).toBeNull();
				} else expect(lent.error).toBeString();
			}),
		);
		db.close();
	});
});
