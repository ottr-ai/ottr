import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loginProviders,
	providerLogin,
	redirectUri,
	shareProviderCredentials,
	signIns,
	signOut,
} from "./login.ts";

// A stand-in for `omp login <provider>`: the same output shape (sign-in URL with its loopback
// redirect_uri, then a prompt without a newline), one line of input per question, omp's error
// lines on stderr. It accepts the code itself or the full redirect address, as omp does.
const dir = mkdtempSync(join(tmpdir(), "ottr-login-"));
const fake = join(dir, "fake-omp.ts");
const CALLBACK = "http://localhost:54545/callback?code=good&state=s1";
writeFileSync(
	fake,
	`const provider = process.argv.at(-1);
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

const logins = (o: { ttlMs?: number; startMs?: number } = {}) =>
	providerLogin({ command: [process.execPath, fake], quietMs: 150, ...o });

/** The fake's pid; it writes the file as it starts, which can trail a fast `start`. */
async function pidOf(provider: string): Promise<number> {
	const file = join(dir, `${provider}.pid`);
	// 12 s: the fake's spawn can stall seconds under concurrent machine load; 5 s flaked.
	for (let i = 0; i < 240 && !existsSync(file); i++) await Bun.sleep(50);
	return Number(readFileSync(file, "utf8"));
}

async function gone(pid: number): Promise<boolean> {
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

describe("providerLogin", () => {
	test("start shows the sign-in URL and the prompt, without terminal escapes", async () => {
		const l = logins();
		const v = await l.start("anthropic", BOARD);
		expect(v.ok).toBeNull();
		expect(v.output).toContain("https://example.test/auth?p=anthropic");
		expect(v.output.endsWith("Paste the authorization code: ")).toBe(true);
		expect(v.output).not.toContain("\x1b");
		l.cancel();
	});

	test("the right code signs in; omp's success line comes back", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const v = await l.answer("good");
		expect(v?.ok).toBe(true);
		expect(v?.output).toContain("Logged in to anthropic");
	});

	test("a rejected code fails with omp's error", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const v = await l.answer("bad");
		expect(v?.ok).toBe(false);
		expect(v?.output).toContain("Login failed: invalid_grant");
	});

	test("a second question returns before omp exits, and its answer goes to the same omp", async () => {
		const l = logins();
		await l.start("openai-codex", BOARD);
		const asked = await l.answer("two-step");
		expect(asked?.ok).toBeNull();
		expect(asked?.output.endsWith("Organization id: ")).toBe(true);
		const v = await l.answer("good");
		expect(v?.ok).toBe(true);
		expect(v?.output).toContain("Logged in to openai-codex");
	});

	test("an unknown provider fails at start", async () => {
		const v = await logins().start("unknown", BOARD);
		expect(v.ok).toBe(false);
		expect(v.output).toContain("Unknown OAuth provider");
	});

	test("an empty answer after omp exited returns the verdict without writing", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		await l.answer("good");
		const v = await l.answer("");
		expect(v?.ok).toBe(true);
		expect(l.pending()?.ok).toBe(true);
	});

	test("the provider's redirect hands its address to omp and sends the browser back to Settings", async () => {
		const l = logins();
		await l.start("anthropic", BOARD);
		const res = await l.callback(browserTo(CALLBACK));
		expect(res?.status).toBe(303);
		expect(res?.headers.get("location")).toBe(`${BOARD}/#settings`);
		expect(l.pending()?.ok).toBe(true);
		expect(l.pending()?.output).toContain("Logged in to anthropic");
	});

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
	});

	test("a new start kills the pending sign-in and answers go to the new one", async () => {
		const l = logins();
		await l.start("first", BOARD);
		await l.start("second", BOARD);
		expect(await gone(await pidOf("first"))).toBe(true);
		const v = await l.answer("good");
		expect(v?.output).toContain("Logged in to second");
	});

	test("cancel kills the pending sign-in; later answers find none", async () => {
		const l = logins();
		await l.start("cancelled", BOARD);
		const pid = await pidOf("cancelled");
		l.cancel();
		expect(await gone(pid)).toBe(true);
		expect(await l.answer("good")).toBeNull();
		expect(l.pending()).toBeNull();
	});

	test("an abandoned sign-in is killed after its ttl", async () => {
		// The ttl must outlast the fake's spawn (bun boot can take seconds under concurrent
		// machine load — Stryker sandboxes see this), or the kill fires before the pid exists.
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
		expect(Date.now() - t).toBeLessThan(5000);
		expect(v).toEqual({
			provider: "silent",
			output: "",
			ok: null,
			syncError: null,
		});
		const pid = await pidOf("silent");
		l.cancel();
		expect(await gone(pid)).toBe(true);
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
			{ provider: "anthropic", kind: "oauth", active: true },
			{ provider: "deepseek", kind: "api_key", active: true },
			{ provider: "kimi-code", kind: "oauth", active: false },
		]);
	});

	test("sign-out removes the provider, failed rows included, and leaves the others", () => {
		const path = store();
		expect(signOut("anthropic", path)).toBe(2);
		expect(signOut("kimi-code", path)).toBe(1);
		expect(signIns(path)).toEqual([
			{ provider: "deepseek", kind: "api_key", active: true },
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

	test("the write-through carries the provider's rows and replaces the shared store's rows for it", () => {
		const pinned = store();
		const shared = store();
		// The shared store "logged out" while the pinned one re-signed in.
		signOut("anthropic", shared);
		expect(shareProviderCredentials("anthropic", pinned, shared)).toBeNull();
		expect(signIns(shared)).toEqual([
			{ provider: "anthropic", kind: "oauth", active: true },
			{ provider: "deepseek", kind: "api_key", active: true },
			{ provider: "kimi-code", kind: "oauth", active: false },
		]);
	});

	test("a sign-out reaches the workers through the same copy", () => {
		const pinned = store();
		const shared = store();
		signOut("anthropic", pinned);
		expect(shareProviderCredentials("anthropic", pinned, shared)).toBeNull();
		expect(signIns(shared)).toEqual([
			{ provider: "deepseek", kind: "api_key", active: true },
			{ provider: "kimi-code", kind: "oauth", active: false },
		]);
	});

	test("a missing store is an error message, not a silent skip and not a created file", () => {
		const pinned = store();
		const missing = join(dir, `absent-${crypto.randomUUID()}.db`);
		expect(shareProviderCredentials("anthropic", pinned, missing)).toContain(
			"missing",
		);
		expect(existsSync(missing)).toBe(false);
	});

	test("one store on disk (no pin) skips the copy", () => {
		const only = store();
		expect(shareProviderCredentials("anthropic", only, only)).toBeNull();
	});
});

describe("loginProviders", () => {
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
	});

	test("no omp, or a catalog that is not the expected layout, gives an empty list", () => {
		expect(loginProviders(join(dir, "absent-omp"))).toEqual([]);
		expect(loginProviders(ompInstall({}))).toEqual([]);
		expect(loginProviders(ompInstall("{broken"))).toEqual([]);
	});
});
