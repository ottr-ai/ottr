import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	deadSignIns,
	type LoginStores,
	loginProviders,
	providerLogin,
	redirectUri,
	signIns,
	signOut,
	signOutEverywhere,
	signOutWorkerStore,
} from "./login.ts";
import { lentProviderEnv } from "./tokens.ts";

// A stand-in for `omp login <provider>`: the same output shape (sign-in URL with its loopback
// redirect_uri, then a prompt without a newline), one line of input per question, omp's error
// lines on stderr. It accepts the code itself or the full redirect address, as omp does. On
// success it stores the credential the way omp's upsertAuthCredential does (pi-ai
// sqlite-credential-store.ts), in omp's real table layout: an OAuth login stamps authorizedAt,
// marks the provider's API-key rows "replaced by oauth login", and updates the same account's
// active OAuth row in place (the id stays) or inserts one; an API-key login inserts a row beside
// any OAuth row. Every run logs its agent dir and HOME, so tests can count the runs.
// omp's own auth_credentials layout (pi-ai sqlite-credential-store.ts #createAuthCredentialsTable).
const OMP_DDL = `CREATE TABLE IF NOT EXISTS auth_credentials (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	provider TEXT NOT NULL,
	credential_type TEXT NOT NULL,
	data TEXT NOT NULL,
	disabled_cause TEXT DEFAULT NULL,
	identity_key TEXT DEFAULT NULL,
	created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
)`;
const dir = mkdtempSync(join(tmpdir(), "ottr-login-"));
const fake = join(dir, "fake-omp.ts");
const RUNS = join(dir, "runs.log");
const CALLBACK = "http://localhost:54545/callback?code=good&state=s1";
writeFileSync(
	fake,
	`import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
const provider = process.argv.at(-1);
const agentDir = process.env.PI_CODING_AGENT_DIR;
appendFileSync(${JSON.stringify(RUNS)}, JSON.stringify({ agentDir, home: process.env.HOME }) + "\\n");
if (provider === "unknown") {
	console.error("Login failed: Unknown OAuth provider 'unknown'.");
	process.exit(1);
}
if (provider === "silent") await Bun.sleep(60_000);
process.stdout.write("Open this URL in your browser:\\nhttps://example.test/auth?p=" + provider + "&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=s1\\n\\x1b[1mPaste the authorization code:\\x1b[0m ");
for await (const line of console) {
	if (line === "two-step") {
		process.stdout.write("\\nOrganization id: ");
		continue;
	}
	if (line === "good" || line === ${JSON.stringify(CALLBACK)}) {
		mkdirSync(agentDir, { recursive: true });
		const db = new Database(agentDir + "/agent.db");
		db.exec(${JSON.stringify(OMP_DDL)});
		// As omp's rules do: zai's login is an API key; openai-codex-device stores as openai-codex.
		const stored = provider === "openai-codex-device" ? "openai-codex" : provider;
		const NOW = "CAST(strftime('%s','now') AS INTEGER)";
		if (provider === "zai") {
			db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'api_key', ?)").run(stored, JSON.stringify({ key: "key-" + crypto.randomUUID(), source: "login" }));
		} else {
			const data = JSON.stringify({ access: "access-" + crypto.randomUUID(), refresh: crypto.randomUUID(), expires: Date.now() + 8 * 3600_000, authorizedAt: Date.now() });
			db.query("UPDATE auth_credentials SET disabled_cause = 'replaced by oauth login', updated_at = " + NOW + " WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL").run(stored);
			const same = db.query("SELECT id FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND identity_key = 'acct-1' AND disabled_cause IS NULL ORDER BY id LIMIT 1").get(stored);
			if (same) db.query("UPDATE auth_credentials SET data = ?, updated_at = " + NOW + " WHERE id = ?").run(data, same.id);
			else db.query("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, 'acct-1')").run(stored, data);
		}
		db.close();
		console.log("Logged in to " + provider);
		process.exit(0);
	}
	console.error("Login failed: invalid_grant");
	process.exit(1);
}
`,
);
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const BOARD = "http://127.0.0.1:4852";

/** A sign-in into one store: a fresh board agent dir of its own, never the env's. */
const logins = (o: { ttlMs?: number; startMs?: number } = {}) => {
	const only: LoginStores = {
		boardDir: mkdtempSync(join(dir, "board-")),
		worker: null,
	};
	return providerLogin({
		command: [process.execPath, fake],
		quietMs: 150,
		stores: () => only,
		...o,
	});
};

const browserTo = (url: string) =>
	new Request(url, { headers: { host: new URL(url).host } });

// providerLogin's tests spawn the real `bun` stand-in for omp — the two-step ones twice in a
// row. Child startup is unbounded under concurrent machine load (boot alone has been seen past
// 4 s), so each test carries a 30 s budget: the 5 s default bounds the machine, not the
// assertions, and the two-stores describe below already proved 30 s enough at load 20.
describe("providerLogin", () => {
	test("start shows the sign-in URL and the prompt, without terminal escapes", async () => {
		const l = logins();
		const v = await l.start("anthropic", BOARD);
		expect(v.ok).toBeNull();
		expect(v.output).toContain("https://example.test/auth?p=anthropic");
		expect(v.output.endsWith("Paste the authorization code: ")).toBe(true);
		expect(v.output).not.toContain("\x1b");
		l.cancel();
	}, 30_000);

	test("the right code signs in; omp's success line comes back", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const v = await l.answer("good");
		expect(v?.ok).toBe(true);
		expect(v?.output).toContain("Logged in to anthropic");
	}, 30_000);

	test("a rejected code fails with omp's error", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const v = await l.answer("bad");
		expect(v?.ok).toBe(false);
		expect(v?.output).toContain("Login failed: invalid_grant");
	}, 30_000);

	test("a second question returns before omp exits, and its answer goes to the same omp", async () => {
		const l = logins();
		await l.start("openai-codex", BOARD);
		const asked = await l.answer("two-step");
		expect(asked?.ok).toBeNull();
		expect(asked?.output.endsWith("Organization id: ")).toBe(true);
		const v = await l.answer("good");
		expect(v?.ok).toBe(true);
		expect(v?.output).toContain("Logged in to openai-codex");
	}, 30_000);

	test("an unknown provider fails at start", async () => {
		const v = await logins().start("unknown", BOARD);
		expect(v.ok).toBe(false);
		expect(v.output).toContain("Unknown OAuth provider");
	}, 30_000);

	test("an empty answer after omp exited returns the verdict without writing", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		await l.answer("good");
		const v = await l.answer("");
		expect(v?.ok).toBe(true);
		expect(l.pending()?.ok).toBe(true);
	}, 30_000);

	test("the provider's redirect hands its address to omp and sends the browser back to Settings", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const res = await l.callback(browserTo(CALLBACK));
		expect(res?.status).toBe(303);
		expect(res?.headers.get("location")).toBe(`${BOARD}/#settings`);
		expect(l.pending()?.ok).toBe(true);
		expect(l.pending()?.output).toContain("Logged in to anthropic");
	}, 30_000);

	test("requests that are not the pending sign-in's redirect are left alone", async () => {
		const l = logins();
		expect(await l.callback(browserTo(CALLBACK))).toBeNull(); // nothing pending
		await l.start("anthropic", BOARD);
		// Another path, and the board's own host: not the address omp printed.
		expect(
			await l.callback(browserTo("http://localhost:54545/other?code=good")),
		).toBeNull();
		expect(
			await l.callback(
				new Request(CALLBACK, { headers: { host: "127.0.0.1:4852" } }),
			),
		).toBeNull();
		expect(l.pending()?.ok).toBeNull();
		l.cancel();
	}, 30_000);

	test("a new start kills the pending sign-in and answers go to the new one", async () => {
		const l = logins();
		await l.start("first", BOARD);
		const first = l.child();
		await l.start("second", BOARD);
		// The awaited exit is the event: no pid file, no poll, and a signal proves a kill.
		await first?.exited;
		expect(first?.signalCode).toBe("SIGTERM");
		const v = await l.answer("good");
		expect(v?.output).toContain("Logged in to second");
	}, 30_000);

	test("cancel kills the pending sign-in; later answers find none", async () => {
		const l = logins();
		await l.start("cancelled", BOARD);
		const child = l.child();
		l.cancel();
		await child?.exited;
		expect(child?.signalCode).toBe("SIGTERM");
		expect(await l.answer("good")).toBeNull();
		expect(l.pending()).toBeNull();
	}, 30_000);

	test("an abandoned sign-in is killed after its ttl", async () => {
		// The child handle exists from the spawn on, so the ttl kill is seen even when it lands
		// while bun still boots. SIGTERM tells the kill apart from an early crash of the fake.
		const l = logins({ ttlMs: 4000 });
		await l.start("abandoned", BOARD);
		const child = l.child();
		await child?.exited;
		expect(child?.signalCode).toBe("SIGTERM");
		const v = await l.answer("");
		expect(v?.ok).toBe(false);
	}, 30_000); // The test waits out the ttl; the 5 s default is tighter than the test itself.

	test("start stops waiting when omp stays silent", async () => {
		const l = logins({ startMs: 300 });
		const t = Date.now();
		const v = await l.start("silent", BOARD);
		// start's wait begins at the spawn, not at the fake's first output, so this bound
		// measures only the give-up after startMs, never the fake's boot.
		expect(Date.now() - t).toBeLessThan(5000);
		expect(v).toEqual({
			provider: "silent",
			output: "",
			ok: null,
			returnTo: BOARD,
		});
		const child = l.child();
		l.cancel();
		await child?.exited;
		expect(child?.signalCode).toBe("SIGTERM");
	}, 30_000);
});

describe("worker store: supersede on sign-in, sign-out everywhere", () => {
	interface Row {
		id: number;
		provider: string;
		credential_type: string;
		data: string;
		disabled_cause: string | null;
		identity_key: string | null;
	}

	function credStore(
		path: string,
		list: Array<[string, string, object, string | null]>,
	): void {
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path);
		db.exec(OMP_DDL);
		const add = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
		);
		for (const [provider, kind, data, identity] of list)
			add.run(provider, kind, JSON.stringify(data), identity);
		add.finalize(); // an unfinalized statement keeps the file open on Windows
		db.close();
	}

	function rows(db: string): Row[] {
		const d = new Database(db, { readonly: true });
		try {
			return d
				.query(
					"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials ORDER BY id",
				)
				.all() as Row[];
		} finally {
			d.close();
		}
	}

	/**
	 * A board store and a separate worker store under a fresh root, and a sign-in that runs once
	 * against the board's. The worker store holds an older sign-in of the same account, another
	 * account, an API key, another provider, a zai API key, a Codex sign-in, and a Cursor sign-in
	 * (an OAuth provider the board does not lend).
	 */
	function setup(o: { workerDb?: boolean } = {}) {
		const root = mkdtempSync(join(dir, "stores-"));
		const home = join(root, "worker-home");
		const workerDb = join(home, ".omp", "agent", "agent.db");
		if (o.workerDb !== false)
			credStore(workerDb, [
				[
					"anthropic",
					"oauth",
					{ access: "a1", refresh: "worker-r1" },
					"acct-1",
				],
				[
					"anthropic",
					"oauth",
					{ access: "a2", refresh: "worker-r2" },
					"acct-2",
				],
				["anthropic", "api_key", { key: "test-key" }, null],
				["deepseek", "api_key", { key: "test-key-2" }, null],
				["zai", "api_key", { key: "worker-zai-key" }, null],
				[
					"openai-codex",
					"oauth",
					{ access: "c1", refresh: "worker-c1" },
					"acct-1",
				],
				["cursor", "oauth", { access: "u1", refresh: "worker-u1" }, "acct-1"],
			]);
		const boardDir = join(root, "board-home", ".omp", "agent");
		const stores: LoginStores = { boardDir, worker: { home, db: workerDb } };
		const l = providerLogin({
			command: [process.execPath, fake],
			quietMs: 150,
			stores: () => stores,
		});
		return {
			l,
			stores,
			boardDir,
			boardDb: join(boardDir, "agent.db"),
			workerDb,
		};
	}

	test("a successful sign-in marks the provider's worker-store rows replaced and inserts none", async () => {
		const t = setup();
		const before = rows(t.workerDb);
		await t.l.start("anthropic", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		expect(v?.output).not.toContain("Cannot mark");

		const after = rows(t.workerDb);
		expect(after).toHaveLength(before.length); // no row inserted
		expect(
			after
				.filter((r) => r.provider === "anthropic")
				.map((r) => r.disabled_cause),
		).toEqual([
			"replaced by newer credential",
			"replaced by newer credential",
			"replaced by newer credential",
		]);
		// The board never reads the worker store: the rows keep their own data.
		expect(after.map((r) => r.data)).toEqual(before.map((r) => r.data));
		// Another provider's rows are untouched.
		expect(after.filter((r) => r.provider === "deepseek")).toEqual(
			before.filter((r) => r.provider === "deepseek"),
		);
		// The credential itself went only into the board's store.
		expect(
			rows(t.boardDb).filter((r) => r.disabled_cause === null),
		).toHaveLength(1);
	}, 30_000);

	test("a successful sign-in with no worker store file still succeeds and creates none", async () => {
		const t = setup({ workerDb: false });
		await t.l.start("anthropic", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		expect(existsSync(t.workerDb)).toBe(false);
	}, 30_000);

	test("an API-key sign-in is not lent, so the workers keep their own credential", async () => {
		const t = setup();
		const before = rows(t.workerDb);
		await t.l.start("zai", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		// No worker row changes: a zai API key on the board reaches no worker turn.
		expect(rows(t.workerDb)).toEqual(before);
		expect(v?.output).toContain(
			"Worker turns do not get zai from the board: they keep their own sign-in, or set its env key under Settings, Env.",
		);
		expect(signIns(t.boardDb)).toEqual([
			{
				provider: "zai",
				kind: "api_key",
				active: true,
				cause: null,
				lent: false,
			},
		]);
	}, 30_000);

	test("an OAuth sign-in of a provider the board does not lend leaves the workers alone", async () => {
		const t = setup();
		const before = rows(t.workerDb);
		await t.l.start("cursor", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		expect(rows(t.workerDb)).toEqual(before);
		expect(v?.output).toContain(
			"Worker turns do not get cursor from the board",
		);
		expect(signIns(t.boardDb).map((s) => [s.provider, s.lent])).toEqual([
			["cursor", false],
		]);
	}, 30_000);

	test("a login id that stores under another id supersedes the stored provider's worker rows", async () => {
		const t = setup();
		await t.l.start("openai-codex-device", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		expect(v?.output).not.toContain("Worker turns do not get");
		const causes = rows(t.workerDb).map((r) => [r.provider, r.disabled_cause]);
		expect(causes).toContainEqual([
			"openai-codex",
			"replaced by newer credential",
		]);
		// Only the stored provider: the other providers' rows stay active.
		expect(
			causes.filter(([, cause]) => cause !== null).map(([p]) => p),
		).toEqual(["openai-codex"]);
	}, 30_000);

	test("an API-key login beside an older active OAuth row keeps the worker key and lends nothing", async () => {
		const t = setup();
		// The board already holds a zai OAuth sign-in from yesterday; omp keeps it active when an
		// API key comes in (only an OAuth login replaces the other type).
		credStore(t.boardDb, [
			[
				"zai",
				"oauth",
				{
					access: "zai-old-oauth",
					expires: 8640000000000000,
					authorizedAt: Date.now() - 86_400_000,
				},
				"acct-1",
			],
		]);
		const before = rows(t.workerDb);
		await t.l.start("zai", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		// Both board rows stay active, as in omp's store.
		expect(
			rows(t.boardDb)
				.filter((r) => r.disabled_cause === null)
				.map((r) => r.credential_type),
		).toEqual(["oauth", "api_key"]);
		// The login wrote an API key: no worker row changes, the worker key stays usable.
		expect(rows(t.workerDb)).toEqual(before);
		expect(v?.output).toContain("Worker turns do not get zai from the board");
		// The current zai credential is the API key: not lent, and the old OAuth token is not lent.
		expect(signIns(t.boardDb)).toEqual([
			{
				provider: "zai",
				kind: "api_key",
				active: true,
				cause: null,
				lent: false,
			},
		]);
		expect(await lentProviderEnv("zai/glm-5.3", { dbPath: t.boardDb })).toEqual(
			{ env: {}, error: null },
		);
	}, 30_000);

	test("a same-account OAuth login that omp updates in place still replaces the worker copy", async () => {
		const t = setup();
		credStore(t.boardDb, [
			[
				"anthropic",
				"oauth",
				{ access: "old", refresh: "old-r", authorizedAt: 1 },
				"acct-1",
			],
		]);
		const [old] = rows(t.boardDb);
		await t.l.start("anthropic", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(true);
		// omp updated the account's row in place: same id, new tokens, no new row.
		const board = rows(t.boardDb);
		expect(board.map((r) => r.id)).toEqual([old!.id]);
		expect(board[0]!.data).not.toBe(old!.data);
		// The worker copies of the provider are replaced; other providers stay.
		expect(
			rows(t.workerDb)
				.filter((r) => r.disabled_cause !== null)
				.map((r) => [r.provider, r.disabled_cause]),
		).toEqual([
			["anthropic", "replaced by newer credential"],
			["anthropic", "replaced by newer credential"],
			["anthropic", "replaced by newer credential"],
		]);
	}, 30_000);

	test("signOutEverywhere marks both stores deleted by user; a missing worker store counts as none", async () => {
		const t = setup();
		credStore(join(t.boardDir, "agent.db"), [
			["anthropic", "oauth", { refresh: "board-r" }, "acct-1"],
			["deepseek", "api_key", { key: "test-key" }, null],
		]);
		expect(await signOutEverywhere("anthropic", t.stores)).toEqual({
			board: 1,
			workers: 3,
		});
		const causes = (db: string) =>
			rows(db).map((r) => [r.provider, r.disabled_cause]);
		expect(causes(t.workerDb)).toEqual([
			["anthropic", "deleted by user"],
			["anthropic", "deleted by user"],
			["anthropic", "deleted by user"],
			["deepseek", null],
			["zai", null],
			["openai-codex", null],
			["cursor", null],
		]);
		expect(causes(t.boardDb)).toEqual([
			["anthropic", "deleted by user"],
			["deepseek", null],
		]);

		const missing = join(t.boardDir, "..", "absent", "agent.db");
		expect(
			await signOutEverywhere("deepseek", {
				boardDir: t.boardDir,
				worker: { home: dirname(dirname(t.workerDb)), db: missing },
			}),
		).toEqual({ board: 1, workers: 0 });
		expect(existsSync(missing)).toBe(false);
	}, 30_000);

	test("a slow trigger planted in the worker store neither blocks the event loop nor runs past the bound", async () => {
		const t = setup();
		const db = new Database(t.workerDb);
		// A pure-SQL loop: PRAGMA trusted_schema=OFF does not stop it, and nothing ends it.
		db.exec(`CREATE TABLE sink(x); CREATE TRIGGER slow AFTER UPDATE ON auth_credentials BEGIN
			INSERT INTO sink SELECT count(*) FROM (WITH RECURSIVE c(i) AS
				(SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 1000000000000) SELECT i FROM c); END`);
		db.close();
		// A real timer on purpose: the test measures whether the real event loop stays free.
		let ticks = 0;
		const tick = setInterval(() => ticks++, 20);
		const start = Date.now();
		const err = await signOutWorkerStore(
			"anthropic",
			t.workerDb,
			"replaced by newer credential",
			1500,
		).catch((e: Error) => e);
		clearInterval(tick);
		expect(String(err)).toContain("did not end within 1500 ms");
		expect(Date.now() - start).toBeLessThan(5000);
		expect(ticks).toBeGreaterThan(30); // the loop kept running during the write
		// The killed write rolled back: no row changed.
		expect(rows(t.workerDb).every((r) => r.disabled_cause === null)).toBe(true);
	}, 30_000);
});

describe("code-flow paste path (the phone path)", () => {
	test("pasting the full CALLBACK address completes the sign-in with no localhost listener", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const v = await l.answer(CALLBACK);
		expect(v?.ok).toBe(true);
		expect(v?.output).toContain("Logged in to anthropic");
	});
});

describe("redirectUri", () => {
	test("reads the loopback redirect from omp's sign-in URL", () => {
		const out =
			"Open this URL in your browser:\nhttps://claude.ai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=s\n";
		expect(redirectUri(out)?.href).toBe("http://localhost:54545/callback");
	});

	test("no URL, or a redirect that is not plain-http loopback, gives none", () => {
		expect(redirectUri("Paste your API key: ")).toBeNull();
		expect(
			redirectUri(
				"https://x.test/a?redirect_uri=zcode%3A%2F%2Fzai-auth%2Fcallback",
			),
		).toBeNull();
		expect(
			redirectUri(
				"https://x.test/a?redirect_uri=https%3A%2F%2Fevil.test%2Fcallback",
			),
		).toBeNull();
	});
});

describe("signIns and signOut", () => {
	// omp's real auth_credentials layout; the board reads and writes some of its columns.
	function store(): string {
		const path = join(dir, `agent-${crypto.randomUUID()}.db`);
		const db = new Database(path);
		db.exec(OMP_DDL);
		const add = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, updated_at) VALUES (?, ?, '{}', ?, 1)",
		);
		add.run("anthropic", "oauth", "oauth refresh failed: invalid_grant"); // the old, dead login
		add.run("anthropic", "oauth", null); // its replacement
		add.run("kimi-code", "oauth", "oauth refresh failed: invalid_grant");
		add.run("google-antigravity", "oauth", "deleted by user");
		add.run("openrouter", "api_key", "replaced by credential 9");
		add.run("deepseek", "api_key", null);
		add.finalize(); // an unfinalized statement keeps the file open on Windows
		db.close();
		return path;
	}

	test("one entry per provider: active wins, failed shows as inactive, logged-out and replaced stay hidden", () => {
		// Only an active OAuth row of a LENT_ENV provider is lent; an API key and a failed row are not.
		expect(signIns(store())).toEqual([
			{
				provider: "anthropic",
				kind: "oauth",
				active: true,
				cause: null,
				lent: true,
			},
			{
				provider: "deepseek",
				kind: "api_key",
				active: true,
				cause: null,
				lent: false,
			},
			{
				provider: "kimi-code",
				kind: "oauth",
				active: false,
				cause: "oauth refresh failed: invalid_grant",
				lent: false,
			},
		]);
	});

	test("sign-out removes the provider, failed rows included, and leaves the others", () => {
		const path = store();
		expect(signOut("anthropic", path)).toBe(2);
		expect(signOut("kimi-code", path)).toBe(1);
		expect(signIns(path)).toEqual([
			{
				provider: "deepseek",
				kind: "api_key",
				active: true,
				cause: null,
				lent: false,
			},
		]);
		// Already gone: nothing changes, and the stamp is omp's own cause.
		expect(signOut("anthropic", path)).toBe(0);
		const db = new Database(path, { readonly: true });
		const causes = db
			.query(
				"SELECT DISTINCT disabled_cause FROM auth_credentials WHERE provider = 'anthropic'",
			)
			.all();
		db.close();
		expect(causes).toEqual([{ disabled_cause: "deleted by user" }]);
	});

	test("signIns mirrors the disabled cause; an active row has none", () => {
		const list = signIns(store());
		const kimi = list.find((s) => s.provider === "kimi-code");
		expect(kimi?.cause).toBe("oauth refresh failed: invalid_grant");
		expect(list.find((s) => s.provider === "anthropic")?.cause).toBeNull();
	});

	test("deadSignIns reports a disabled provider's role with the cause", () => {
		const dead = deadSignIns(
			[
				{
					provider: "kimi-code",
					kind: "oauth",
					active: false,
					cause: "oauth refresh failed: invalid_grant",
					lent: false,
				},
			],
			{ work: "kimi-code/kimi-k2", review: "anthropic/claude-opus-5-5" },
		);
		expect(dead).toEqual([
			{
				provider: "kimi-code",
				cause: "oauth refresh failed: invalid_grant",
				roles: ["work"],
			},
		]);
	});

	test("deadSignIns lists every role the disabled provider backs", () => {
		const dead = deadSignIns(
			[
				{
					provider: "kimi-code",
					kind: "oauth",
					active: false,
					cause: "oauth refresh failed: invalid_grant",
					lent: false,
				},
			],
			{ work: "kimi-code/kimi-k2", review: "kimi-code/kimi-vision" },
		);
		expect(dead).toEqual([
			{
				provider: "kimi-code",
				cause: "oauth refresh failed: invalid_grant",
				roles: ["work", "review"],
			},
		]);
	});

	test("deadSignIns is empty when every credential is active", () => {
		expect(
			deadSignIns(
				[
					{
						provider: "anthropic",
						kind: "oauth",
						active: true,
						cause: null,
						lent: true,
					},
				],
				{ work: "anthropic/claude-opus-5-5" },
			),
		).toEqual([]);
	});

	test("deadSignIns skips a disabled provider no role uses", () => {
		expect(
			deadSignIns(
				[
					{
						provider: "kimi-code",
						kind: "oauth",
						active: false,
						cause: "oauth refresh failed: invalid_grant",
						lent: false,
					},
					{
						provider: "anthropic",
						kind: "oauth",
						active: true,
						cause: null,
						lent: true,
					},
				],
				{ work: "anthropic/claude-opus-5-5" },
			),
		).toEqual([]);
	});

	test("deadSignIns reports a disabled provider only when a role uses it", () => {
		// kimi-code is disabled and unused; deepseek is disabled and unused by any role either.
		expect(
			deadSignIns(
				[
					{
						provider: "kimi-code",
						kind: "oauth",
						active: false,
						cause: "oauth refresh failed: invalid_grant",
						lent: false,
					},
				],
				{},
			),
		).toEqual([]);
	});
});

describe("loginProviders", () => {
	// Sync file reads, no children: the budget only covers the process being descheduled on a
	// loaded host, where even these tests have tripped the 5 s default. Assertions still fail
	// instantly; only a true hang would need the whole budget.
	// A stand-in for the global omp install: an omp file whose directory anchors module
	// resolution, and a pi-catalog whose exports map serves the compiled `/login` catalog
	// (rules.json) exactly as the real package ships it.
	function ompInstall(rules: unknown): string {
		const root = join(dir, `omp-${crypto.randomUUID()}`);
		const pkg = join(root, "node_modules/@oh-my-pi/pi-catalog");
		mkdirSync(join(pkg, "src/compat"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin/omp"), "");
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "@oh-my-pi/pi-catalog",
				type: "module",
				exports: { "./compat/*": "./src/compat/*.ts" },
			}),
		);
		writeFileSync(join(pkg, "src/compat/auth.ts"), "");
		writeFileSync(
			join(pkg, "src/compat/rules.json"),
			typeof rules === "string" ? rules : JSON.stringify(rules),
		);
		return join(root, "bin/omp");
	}

	test("lists omp's /login providers in catalog order, hiding no-login and hidden entries", () => {
		const bin = ompInstall({
			auth: {
				providers: [
					{
						id: "anthropic",
						name: "Anthropic (Claude Pro/Max)",
						login: { kind: "oauth-code" },
					},
					{ id: "deepseek", name: "DeepSeek" }, // no login flow: /login does not offer it
					{
						id: "kimi-code",
						name: "Kimi Code",
						login: { kind: "paste-code" },
						showInLoginList: false,
					},
					{ id: "zai", name: "Z.AI (GLM Coding Plan)", login: {} },
				],
			},
		});
		expect(loginProviders(bin)).toEqual([
			{ id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
			{ id: "zai", name: "Z.AI (GLM Coding Plan)" },
		]);
		// The read is memoized per omp path: the second call serves the same list.
		expect(loginProviders(bin)).toBe(loginProviders(bin));
	}, 30_000);

	test("no omp, or a catalog that is not the expected layout, gives an empty list", () => {
		expect(loginProviders(join(dir, "absent-omp"))).toEqual([]);
		expect(loginProviders(ompInstall({}))).toEqual([]);
		expect(loginProviders(ompInstall("{broken"))).toEqual([]);
	}, 30_000);
});
