import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
	adoptSignIn,
	deadSignIns,
	type LoginStores,
	loginProviders,
	providerLogin,
	redirectUri,
	signIns,
	signOut,
	signOutStores,
	storeSignIns,
} from "./login.ts";

// A stand-in for `omp login <provider>`: the same output shape (sign-in URL with its loopback
// redirect_uri, then a prompt without a newline), one line of input per question, omp's error
// lines on stderr. It accepts the code itself or the full redirect address, as omp does. On
// success it stores a credential with a fresh refresh token in its agent dir, as each real
// authorization does. Every run logs its agent dir and HOME, so tests can count the runs.
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
await Bun.write(${JSON.stringify(dir)} + "/" + provider + ".pid", String(process.pid));
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
		db.exec("CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)");
		const add = db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, 'oauth', ?, 'acct-1', 1, 1)");
		add.run(provider, JSON.stringify({ access: "access-" + crypto.randomUUID(), refresh: crypto.randomUUID() }));
		add.finalize();
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

/** The fake's pid; it writes the file as it starts, which can trail a fast `start`. */
async function pidOf(provider: string): Promise<number | null> {
	const file = join(dir, `${provider}.pid`);
	// 12 s: the fake's spawn can stall seconds under concurrent machine load; 5 s flaked.
	// Null when the file never appears: the only way a started fake writes no pid is a kill
	// (ttl, cancel, a newer start) that landed while it was still booting.
	for (let i = 0; i < 240 && !existsSync(file); i++) await Bun.sleep(50);
	return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
}

async function gone(pid: number | null): Promise<boolean> {
	// Null pid: the fake died before it could write its pid, so it is gone.
	if (pid === null) return true;
	// 6 s: must outlast the longest ttl a test arms (the abandoned test kills at 4 s) plus the
	// kill's own latency under load; returns as soon as the process is gone.
	for (let i = 0; i < 120; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(50);
	}
	return false;
}

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
		await l.start("second", BOARD);
		expect(await gone(await pidOf("first"))).toBe(true);
		const v = await l.answer("good");
		expect(v?.output).toContain("Logged in to second");
	}, 30_000);

	test("cancel kills the pending sign-in; later answers find none", async () => {
		const l = logins();
		await l.start("cancelled", BOARD);
		const pid = await pidOf("cancelled");
		l.cancel();
		expect(await gone(pid)).toBe(true);
		expect(await l.answer("good")).toBeNull();
		expect(l.pending()).toBeNull();
	}, 30_000);

	test("an abandoned sign-in is killed after its ttl", async () => {
		// If the fake's boot outruns the ttl (bun boot has been seen past 4 s under load),
		// the kill lands before the pid exists: pidOf then reports null and gone counts the
		// fake as dead, while the verdict below still proves the ttl fired.
		const l = logins({ ttlMs: 4000 });
		await l.start("abandoned", BOARD);
		expect(await gone(await pidOf("abandoned"))).toBe(true);
		const v = await l.answer("");
		expect(v?.ok).toBe(false);
	}, 30_000); // The test waits out the ttl plus the kill poll; the 5 s default is tighter than the test itself.

	test("start stops waiting when omp stays silent", async () => {
		const l = logins({ startMs: 300 });
		const t = Date.now();
		const v = await l.start("silent", BOARD);
		// The bound is start's ~startMs give-up plus the fake's boot, which alone has been
		// seen past 4 s under load; 15 s still proves the early return against the 20 s
		// default startMs and the 60 s the silent fake would run.
		expect(Date.now() - t).toBeLessThan(15_000);
		expect(v).toEqual({
			provider: "silent",
			store: "board",
			step: 1,
			steps: 1,
			output: "",
			ok: null,
		});
		const pid = await pidOf("silent");
		l.cancel();
		expect(await gone(pid)).toBe(true);
	}, 45_000); // Boot (unbounded under load) + the give-up + the pid poll + the kill poll.
});

describe("two stores: one omp login for each", () => {
	// The columns of omp's auth_credentials a sign-in writes and the board adopts.
	const SCHEMA = `CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY,
		provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
		disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`;

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
		db.exec(SCHEMA);
		const add = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
		);
		for (const [provider, kind, data, identity] of list)
			add.run(provider, kind, JSON.stringify(data), identity);
		add.finalize(); // an unfinalized statement keeps the file open on Windows
		db.close();
	}

	// The worker store as the workers left it: an older sign-in of the same account, another
	// account, an API key a new OAuth sign-in replaces, and another provider.
	const workerStore = (db: string) =>
		credStore(db, [
			["anthropic", "oauth", { access: "a1", refresh: "worker-r1" }, "acct-1"],
			["anthropic", "oauth", { access: "a2", refresh: "worker-r2" }, "acct-2"],
			["anthropic", "api_key", { key: "test-key" }, null],
			["deepseek", "api_key", { key: "test-key-2" }, null],
		]);

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

	function refreshOf(r: Row): string | undefined {
		const d: unknown = JSON.parse(r.data);
		return typeof d === "object" &&
			d !== null &&
			"refresh" in d &&
			typeof d.refresh === "string"
			? d.refresh
			: undefined;
	}

	/** The refresh tokens of the active rows of one provider and account. */
	const activeRefresh = (db: string, identity: string) =>
		rows(db)
			.filter(
				(r) =>
					r.provider === "anthropic" &&
					r.identity_key === identity &&
					r.disabled_cause === null,
			)
			.map(refreshOf);

	/** Simulates omp's token refresh: the active row of the account gets a new refresh token. */
	function rotate(db: string, identity: string): void {
		const d = new Database(db);
		try {
			d.query(
				"UPDATE auth_credentials SET data = ? WHERE provider = 'anthropic' AND identity_key = ? AND disabled_cause IS NULL",
			).run(
				JSON.stringify({ access: "rotated", refresh: crypto.randomUUID() }),
				identity,
			);
		} finally {
			d.close();
		}
	}

	const under = (p: string, d: string) => p === d || p.startsWith(`${d}${sep}`);

	/**
	 * A board store and a separate worker store under a fresh root, and a sign-in that writes
	 * them. `boardInWorkerHome` puts the board agent dir inside the worker home.
	 */
	function setup(o: { workerDb?: boolean; boardInWorkerHome?: boolean } = {}) {
		const root = mkdtempSync(join(dir, "stores-"));
		const home = join(root, "worker-home");
		const workerDb = join(home, ".omp", "agent", "agent.db");
		if (o.workerDb !== false) workerStore(workerDb);
		const boardDir = o.boardInWorkerHome
			? join(home, ".omp", "board-agent")
			: join(root, "board-home", ".omp", "agent");
		const stores: LoginStores = { boardDir, worker: { home, db: workerDb } };
		const l = providerLogin({
			command: [process.execPath, fake],
			quietMs: 150,
			stores: () => stores,
		});
		/** The fake's runs for this setup: agent dir and HOME of each, in order. */
		const runs = (): Array<{ agentDir: string; home: string }> =>
			(existsSync(RUNS) ? readFileSync(RUNS, "utf8") : "")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line))
				.filter((r) => under(r.agentDir, root));
		/** Scratch dirs of step 2 left next to the board agent dir. */
		const scratches = () =>
			existsSync(dirname(boardDir))
				? readdirSync(dirname(boardDir)).filter((n) =>
						n.startsWith(".ottr-login-"),
					)
				: [];
		/** Runs both steps with the right code; returns the final view. */
		async function signInBoth() {
			await l.start("anthropic", BOARD);
			await l.answer("good"); // returns once step 2 printed its sign-in URL
			return l.answer("good");
		}
		return {
			l,
			home,
			boardDir,
			boardDb: join(boardDir, "agent.db"),
			workerDb,
			runs,
			scratches,
			signInBoth,
		};
	}

	test("a sign-in runs omp login once for each store, the second against a board-only scratch dir", async () => {
		const t = setup();
		const one = await t.l.start("anthropic", BOARD);
		expect(one).toMatchObject({ store: "board", step: 1, steps: 2, ok: null });
		const two = await t.l.answer("good");
		expect(two).toMatchObject({
			store: "workers",
			step: 2,
			steps: 2,
			ok: null,
		});
		expect(two?.output).toContain("https://example.test/auth?p=anthropic");
		expect(two?.output.endsWith("Paste the authorization code: ")).toBe(true);
		// Step 2's agent dir exists while its omp waits, board-only (0700).
		const [scratch] = t.scratches();
		expect(scratch).toBeDefined();
		if (process.platform !== "win32")
			expect(
				statSync(join(dirname(t.boardDir), scratch ?? "")).mode & 0o777,
			).toBe(0o700);
		const done = await t.l.answer("good");
		expect(done?.ok).toBe(true);
		expect(done?.output).toContain(`Signed the workers in: ${t.workerDb}`);

		const runs = t.runs();
		expect(runs).toHaveLength(2);
		const [first, second] = runs;
		expect(first?.agentDir).toBe(t.boardDir);
		expect(second?.agentDir).not.toBe(t.boardDir);
		expect(second?.agentDir).not.toBe(dirname(t.workerDb));
		expect(under(second?.agentDir ?? t.home, t.home)).toBe(false);
		expect(dirname(second?.agentDir ?? "")).toBe(dirname(t.boardDir));
		for (const r of runs) {
			expect(r.home).not.toBe(t.home);
			expect(under(r.home, t.home)).toBe(false);
		}
	}, 30_000); // Two real omp stand-ins in a row; bun boot can take seconds under machine load.

	test("the two stores then hold different refresh tokens; the worker store replaces the account's old rows", async () => {
		const t = setup();
		expect((await t.signInBoth())?.ok).toBe(true);
		const [board] = activeRefresh(t.boardDb, "acct-1");
		const [worker] = activeRefresh(t.workerDb, "acct-1");
		expect(board).toBeString();
		expect(worker).toBeString();
		expect(worker).not.toBe(board);
		expect(worker).not.toBe("worker-r1");
		const inBoard = new Set(rows(t.boardDb).map(refreshOf));
		const shared = rows(t.workerDb)
			.map(refreshOf)
			.filter((r) => r !== undefined && inBoard.has(r));
		expect(shared).toEqual([]);

		const causes = rows(t.workerDb).map((r) => [
			r.provider,
			r.credential_type,
			r.identity_key,
			r.disabled_cause,
		]);
		expect(causes).toEqual([
			["anthropic", "oauth", "acct-1", "replaced by newer credential"],
			["anthropic", "oauth", "acct-2", null],
			["anthropic", "api_key", null, "replaced by newer credential"],
			["deepseek", "api_key", null, null],
			["anthropic", "oauth", "acct-1", null],
		]);
	}, 30_000);

	test("a refresh that rotates the token in one store leaves the other store unchanged", async () => {
		const t = setup();
		expect((await t.signInBoth())?.ok).toBe(true);
		const anthropic = (db: string) =>
			rows(db)
				.filter((r) => r.provider === "anthropic")
				.map(({ id, data, disabled_cause }) => ({ id, data, disabled_cause }));
		const [boardToken] = activeRefresh(t.boardDb, "acct-1");

		const workerBefore = anthropic(t.workerDb);
		rotate(t.boardDb, "acct-1");
		expect(activeRefresh(t.boardDb, "acct-1")).not.toEqual([boardToken]);
		expect(anthropic(t.workerDb)).toEqual(workerBefore);
		// The token the board rotated away from (dead at the provider) is not the workers' one.
		expect(activeRefresh(t.workerDb, "acct-1")).not.toContain(boardToken);

		const boardBefore = anthropic(t.boardDb);
		const [workerToken] = activeRefresh(t.workerDb, "acct-1");
		rotate(t.workerDb, "acct-1");
		expect(activeRefresh(t.workerDb, "acct-1")).not.toEqual([workerToken]);
		expect(anthropic(t.boardDb)).toEqual(boardBefore);
		expect(activeRefresh(t.boardDb, "acct-1")).not.toContain(workerToken);
	}, 30_000);

	test("the scratch dir is gone after a successful step 2", async () => {
		const t = setup();
		expect((await t.signInBoth())?.ok).toBe(true);
		expect(t.runs()).toHaveLength(2);
		expect(t.scratches()).toEqual([]);
	}, 30_000);

	test("a failed step 2 fails the flow, removes the scratch dir and leaves the worker store unchanged", async () => {
		const t = setup();
		const before = rows(t.workerDb);
		await t.l.start("anthropic", BOARD);
		await t.l.answer("good");
		expect(t.scratches()).toHaveLength(1);
		const v = await t.l.answer("bad");
		expect(v).toMatchObject({ store: "workers", step: 2, ok: false });
		expect(v?.output).toContain("Login failed: invalid_grant");
		expect(t.runs()).toHaveLength(2);
		expect(t.scratches()).toEqual([]);
		expect(rows(t.workerDb)).toEqual(before);
	}, 30_000);

	test("the redirect of step 1 sends the browser to step 2's sign-in page, the one of step 2 back to Settings", async () => {
		const t = setup();
		await t.l.start("anthropic", BOARD);
		const first = await t.l.callback(browserTo(CALLBACK));
		expect(first?.status).toBe(303);
		expect(first?.headers.get("location")).toStartWith(
			"https://example.test/auth?p=anthropic",
		);
		expect(t.l.pending()).toMatchObject({ step: 2, ok: null });
		const second = await t.l.callback(browserTo(CALLBACK));
		expect(second?.status).toBe(303);
		expect(second?.headers.get("location")).toBe(`${BOARD}/#settings`);
		expect(t.l.pending()?.ok).toBe(true);
		expect(t.runs()).toHaveLength(2);
	}, 30_000);

	test("a missing worker store fails the flow after step 1, names the path, and is not created", async () => {
		const t = setup({ workerDb: false });
		await t.l.start("anthropic", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(false);
		expect(v?.output).toContain(t.workerDb);
		expect(t.runs()).toHaveLength(1);
		expect(existsSync(t.workerDb)).toBe(false);
		expect(t.scratches()).toEqual([]);
	}, 30_000);

	test("a board agent dir inside the worker home refuses step 2 and makes no scratch dir there", async () => {
		const t = setup({ boardInWorkerHome: true });
		const before = rows(t.workerDb);
		await t.l.start("anthropic", BOARD);
		const v = await t.l.answer("good");
		expect(v?.ok).toBe(false);
		expect(v?.output).toContain("worker home");
		expect(t.runs()).toHaveLength(1);
		expect(dirname(t.boardDir).startsWith(t.home)).toBe(true);
		expect(t.scratches()).toEqual([]);
		expect(rows(t.workerDb)).toEqual(before);
	}, 30_000);

	test("a failed step 1 never starts step 2", async () => {
		const t = setup();
		const before = rows(t.workerDb);
		await t.l.start("anthropic", BOARD);
		const v = await t.l.answer("bad");
		expect(v).toMatchObject({ store: "board", step: 1, steps: 2, ok: false });
		expect(t.runs()).toHaveLength(1);
		expect(t.scratches()).toEqual([]);
		expect(rows(t.workerDb)).toEqual(before);
	}, 30_000);

	test("signOutStores clears the provider in both stores; a missing worker store counts as none", () => {
		const root = mkdtempSync(join(dir, "stores-"));
		const boardDir = join(root, "board");
		const home = join(root, "worker-home");
		const db = join(home, ".omp", "agent", "agent.db");
		credStore(join(boardDir, "agent.db"), [
			["anthropic", "oauth", { refresh: "board-r" }, "acct-1"],
			["deepseek", "api_key", { key: "test-key" }, null],
		]);
		workerStore(db);
		const stores: LoginStores = { boardDir, worker: { home, db } };
		expect(signOutStores("anthropic", stores)).toEqual({
			board: 1,
			workers: 3,
		});
		for (const s of storeSignIns(stores))
			expect(s.signIns?.map((x) => x.provider)).toEqual(["deepseek"]);

		const missing = join(root, "absent", "agent.db");
		const noWorkers: LoginStores = { boardDir, worker: { home, db: missing } };
		expect(signOutStores("deepseek", noWorkers)).toEqual({
			board: 1,
			workers: 0,
		});
		expect(existsSync(missing)).toBe(false);
	});

	test("storeSignIns lists the board, then the workers; a missing worker store is an error naming it", () => {
		const root = mkdtempSync(join(dir, "stores-"));
		const boardDir = join(root, "board");
		const home = join(root, "worker-home");
		credStore(join(boardDir, "agent.db"), [
			["anthropic", "oauth", { refresh: "board-r" }, "acct-1"],
		]);
		const db = join(home, ".omp", "agent", "agent.db");
		workerStore(db);
		expect(storeSignIns({ boardDir, worker: { home, db } })).toEqual([
			{
				store: "board",
				signIns: [
					{ provider: "anthropic", kind: "oauth", active: true, cause: null },
				],
				error: null,
			},
			{
				store: "workers",
				signIns: [
					{ provider: "anthropic", kind: "oauth", active: true, cause: null },
					{ provider: "deepseek", kind: "api_key", active: true, cause: null },
				],
				error: null,
			},
		]);
		const missing = join(root, "absent", "agent.db");
		const list = storeSignIns({ boardDir, worker: { home, db: missing } });
		expect(list.map((s) => s.store)).toEqual(["board", "workers"]);
		expect(list[1]).toEqual({
			store: "workers",
			signIns: null,
			error: `cannot read omp's sign-ins: ${missing} does not exist`,
		});
		expect(
			storeSignIns({ boardDir, worker: null }).map((s) => s.store),
		).toEqual(["board"]);
	});

	test("adoptSignIn with a missing or empty scratch store throws and leaves the worker store unchanged", () => {
		const root = mkdtempSync(join(dir, "stores-"));
		const db = join(root, "worker-home", ".omp", "agent", "agent.db");
		workerStore(db);
		const before = rows(db);
		expect(() => adoptSignIn(join(root, "absent", "agent.db"), db)).toThrow(
			"omp stored no credential",
		);
		const empty = join(root, "scratch", "agent.db");
		credStore(empty, [["anthropic", "oauth", { refresh: "x" }, "acct-1"]]);
		const d = new Database(empty);
		d.exec("UPDATE auth_credentials SET disabled_cause = 'deleted by user'");
		d.close();
		expect(() => adoptSignIn(empty, db)).toThrow("omp stored no credential");
		expect(rows(db)).toEqual(before);
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
	// The columns of omp's auth_credentials that the board reads and writes.
	function store(): string {
		const path = join(dir, `agent-${crypto.randomUUID()}.db`);
		const db = new Database(path);
		db.exec(`CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL,
			credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, updated_at INTEGER)`);
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
		expect(signIns(store())).toEqual([
			{ provider: "anthropic", kind: "oauth", active: true, cause: null },
			{ provider: "deepseek", kind: "api_key", active: true, cause: null },
			{
				provider: "kimi-code",
				kind: "oauth",
				active: false,
				cause: "oauth refresh failed: invalid_grant",
			},
		]);
	});

	test("sign-out removes the provider, failed rows included, and leaves the others", () => {
		const path = store();
		expect(signOut("anthropic", path)).toBe(2);
		expect(signOut("kimi-code", path)).toBe(1);
		expect(signIns(path)).toEqual([
			{ provider: "deepseek", kind: "api_key", active: true, cause: null },
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
					},
					{
						provider: "anthropic",
						kind: "oauth",
						active: true,
						cause: null,
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
