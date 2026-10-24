import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GitRemote } from "./gitHosts.ts";
import {
	checkHostKey,
	defaultSshDir,
	GIT_AUTH_ENV_RE,
	GIT_URL_ERROR,
	generatePendingKey,
	gitAuthEnv,
	gitSecrets,
	importPendingKey,
	keyInfo,
	parseGitToken,
	parseGitUrl,
	promoteKey,
	redact,
	removeKey,
	setGitSecrets,
	sshPaths,
} from "./gitHosts.ts";
import fc from "./test/properties.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-gh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasKeygen = Bun.which("ssh-keygen") !== null;

/** One ssh-keygen run for a test fixture; throws its stderr on failure. */
function runKeygen(args: string[]): void {
	const r = Bun.spawnSync(["ssh-keygen", ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

describe("parseGitUrl", () => {
	test("accepts the four remote forms", () => {
		expect(parseGitUrl("https://gitlab.com/g/sub/repo.git")).toEqual({
			scheme: "https",
			host: "gitlab.com",
			port: null,
			hostKey: "gitlab.com",
			name: "repo",
		});
		expect(parseGitUrl(" https://git.example.com:8443/a/b/c/repo ")).toEqual({
			scheme: "https",
			host: "git.example.com",
			port: 8443,
			hostKey: "git.example.com:8443",
			name: "repo",
		});
		expect(parseGitUrl("git@git.example.com:a/repo.git")).toEqual({
			scheme: "ssh",
			host: "git.example.com",
			port: null,
			hostKey: "git.example.com",
			name: "repo",
		});
		expect(parseGitUrl("ssh://git@git.example.com:2222/a/repo.git")).toEqual({
			scheme: "ssh",
			host: "git.example.com",
			port: 2222,
			hostKey: "git.example.com:2222",
			name: "repo",
		});
		expect(parseGitUrl("https://github.com/o/r")).toEqual({
			scheme: "https",
			host: "github.com",
			port: null,
			hostKey: "github.com",
			name: "r",
		});
	});

	test("a GitHub path segment may start with '-', as githubRepoName accepts", () => {
		expect(parseGitUrl("https://github.com/owner/-repo.git")).toEqual({
			scheme: "https",
			host: "github.com",
			port: null,
			hostKey: "github.com",
			name: "-repo",
		});
	});

	test("rejects every listed class with the shared error", () => {
		const bad = [
			"https://u:p@h/a/r",
			"https://u@h/a/r",
			"file:///tmp/r",
			"ext::sh -c x",
			"git://h/a/r",
			"http://h/a/r",
			"/tmp/r",
			"../r",
			"-uhttps://h/a/r",
			"https://h/a/r x",
			"https://h/a/\nr",
			"https://h/a/.r",
		];
		for (const b of bad)
			expect(parseGitUrl(b)).toEqual({ error: GIT_URL_ERROR });
	});

	test("rejects bad ports and non-strings", () => {
		for (const b of [
			"https://h:0/a/r",
			"https://h:70000/a/r",
			"ssh://h:0/a/r",
			"ssh://h:70000/a/r",
			42,
			null,
			undefined,
			{},
			[],
		])
			expect(parseGitUrl(b)).toEqual({ error: GIT_URL_ERROR });
	});

	test("property: total on any input, and every accepted URL is clean", () => {
		const seg = fc
			.string({ minLength: 1, maxLength: 8 })
			.filter((s) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(s));
		const urlish = fc
			.tuple(
				fc.constantFrom("git.example.com", "gitlab.com", "h1.invalid"),
				fc.array(seg, { minLength: 1, maxLength: 3 }),
				fc.option(fc.integer({ min: 1, max: 65535 }), { nil: null }),
				fc.constantFrom("https", "ssh", "scp"),
			)
			.map(([h, segs, port, kind]) => {
				const path = segs.join("/");
				if (kind === "scp") return `otter@${h}:${path}`;
				const auth = port === null ? h : `${h}:${port}`;
				return kind === "https"
					? `https://${auth}/${path}`
					: `ssh://git@${auth}/${path}`;
			});
		fc.assert(
			fc.property(fc.oneof(fc.string(), fc.webUrl(), urlish), (input) => {
				const r = parseGitUrl(input);
				if ("error" in r) return;
				expect(r.scheme === "https" || r.scheme === "ssh").toBe(true);
				expect(input.startsWith("-")).toBe(false);
				// Spec section 1: [A-Za-z0-9_.-] only, never a leading "." (no "..", no dotfile).
				expect(r.name).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
				if (r.scheme === "https") {
					const s = input.trim().toLowerCase();
					expect(s.startsWith("https://")).toBe(true);
					expect(s.slice(8).split("/")[0]?.includes("@")).toBe(false);
				}
			}),
		);
	});
});

describe("parseGitToken", () => {
	function tokenError(body: Record<string, unknown>): string {
		const r = parseGitToken(body);
		return "error" in r ? r.error : "no error";
	}

	test("defaults the username and keeps the hostKey form", () => {
		expect(
			parseGitToken({ host: " Git.Example.COM:8443 ", token: "glpat-abc" }),
		).toEqual({
			host: "git.example.com:8443",
			username: "oauth2",
			token: "glpat-abc",
		});
	});

	test("rejects bad host, username and token", () => {
		expect(tokenError({})).toContain("host");
		expect(tokenError({ host: "h/a", token: "t" })).toContain("host");
		expect(tokenError({ host: "h:70000", token: "t" })).toContain("host");
		expect(tokenError({ host: "h", token: "a b" })).toContain("token");
		expect(tokenError({ host: "h", token: "" })).toContain("token");
		expect(tokenError({ host: "h", token: "short7x" })).toContain("token");
		expect(tokenError({ host: "h", token: "eight8xx" })).toBe("no error");
		expect(
			tokenError({ host: "h", token: "t", username: "bad user!" }),
		).toContain("username");
	});
});

describe("sshPaths", () => {
	test("fixed paths; project and pending validators refuse escapes", () => {
		const p = sshPaths("/state/ssh");
		expect(p.dir).toBe("/state/ssh");
		expect(p.global).toBe("/state/ssh/global");
		expect(p.knownHosts).toBe("/state/ssh/known_hosts");
		expect(p.project("app")).toBe(join("/state/ssh", "projects", "app"));
		expect(p.pending("a".repeat(32))).toBe(
			join("/state/ssh", "pending", "a".repeat(32)),
		);
		expect(() => p.project("a/b")).toThrow();
		expect(() => p.project("a\\b")).toThrow();
		expect(() => p.project(".hide")).toThrow();
		expect(() => p.project("")).toThrow();
		// A project key path reaches GIT_SSH_COMMAND: shell characters never name one.
		for (const bad of ["x';id;'", "a b", "$(id)", "a`b"])
			expect(() => p.project(bad)).toThrow();
		expect(() => p.pending("xyz")).toThrow();
		expect(() => p.pending("A".repeat(32))).toThrow();
	});
});

describe("gitAuthEnv credential helper", () => {
	const token = "ottr-test-token-0123";
	const env = gitAuthEnv({
		tokens: [{ host: "git.example.com:8443", username: "bob", token }],
		key: null,
		knownHosts: "/x/known_hosts",
	});

	async function credentialFill(host: string): Promise<string> {
		const proc = Bun.spawn(["git", "credential", "fill"], {
			// Isolate from any developer/CI global git config: only our env helper answers.
			env: {
				...process.env,
				...env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.stdin.write(`protocol=https\nhost=${host}\n\n`);
		proc.stdin.end();
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return stdout;
	}

	test("answers the exact host:port with the token", async () => {
		const out = await credentialFill("git.example.com:8443");
		expect(out).toContain("username=bob");
		expect(out).toContain(`password=${token}`);
	});

	test("answers nothing for the port-less host or another host", async () => {
		for (const host of ["git.example.com", "other.example.com:8443"])
			expect(await credentialFill(host)).not.toContain("password=");
	});

	test("a token with a backslash and quotes reaches git unchanged", async () => {
		const odd = 'to\\k"en\\n-01';
		const e2 = gitAuthEnv({
			tokens: [{ host: "odd.example.com", username: "u", token: odd }],
			key: null,
			knownHosts: "/x",
		});
		const proc = Bun.spawn(["git", "credential", "fill"], {
			env: {
				...process.env,
				...e2,
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.stdin.write("protocol=https\nhost=odd.example.com\n\n");
		proc.stdin.end();
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out).toContain(`password=${odd}\n`);
	});

	test("a helper planted in the repo config never runs while the tokens are in env", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-gh-"));
		try {
			const marker = join(dir, "stolen");
			Bun.spawnSync(["git", "init", "-q", dir]);
			Bun.spawnSync([
				"git",
				"-C",
				dir,
				"config",
				"credential.helper",
				`!f() { env > '${marker}'; }; f`,
			]);
			const proc = Bun.spawn(["git", "credential", "fill"], {
				cwd: dir,
				env: {
					...process.env,
					...env,
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			proc.stdin.write("protocol=https\nhost=git.example.com:8443\n\n");
			proc.stdin.end();
			const out = await new Response(proc.stdout).text();
			await proc.exited;
			expect(out).toContain(`password=${token}`);
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ambient global/system helpers come back after the reset", () => {
		const e2 = gitAuthEnv({
			tokens: [
				{ host: "h.example.com", username: "u", token: "tok-ambient-1" },
			],
			key: null,
			knownHosts: "/x",
			ambientHelpers: [["credential.https://github.com.helper", "!gh-helper"]],
		});
		const pairs = Object.entries(e2)
			.filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
			.map(([k, v]) => [v, e2[k.replace("KEY", "VALUE")]]);
		const reset = pairs.findIndex(
			([k, v]) => k === "credential.helper" && v === "",
		);
		const gh = pairs.findIndex(
			([k]) => k === "credential.https://github.com.helper",
		);
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(gh).toBeGreaterThan(reset);
	});

	test("keeps the token out of GIT_CONFIG_VALUE_*", () => {
		for (const [k, v] of Object.entries(env))
			if (k.startsWith("GIT_CONFIG_VALUE_")) expect(v).not.toContain(token);
	});
});

describe("generatePendingKey", () => {
	test.skipIf(!hasKeygen)(
		"makes a 0600 ed25519 key with a SHA256 fingerprint",
		async () => {
			const dir = join(root, "gen");
			const r = await generatePendingKey(dir);
			expect(r.id).toMatch(/^[0-9a-f]{32}$/);
			expect(r.publicKey).toStartWith("ssh-ed25519 ");
			expect(r.fingerprint).toStartWith("SHA256:");
			const p = sshPaths(dir).pending(r.id);
			expect(existsSync(p)).toBe(true);
			if (process.platform !== "win32") {
				expect(statSync(p).mode & 0o777).toBe(0o600);
				expect(statSync(`${p}.pub`).mode & 0o777).toBe(0o600);
			}
		},
	);

	test("keyInfo is null when no file exists", async () => {
		expect(await keyInfo(join(root, "absent-key"))).toBeNull();
	});
});

describe("importPendingKey", () => {
	test.skipIf(!hasKeygen)(
		"rejects a passphrase-protected key and leaves no file",
		async () => {
			const dir = join(root, "imp");
			const enc = join(root, "enc");
			runKeygen([
				"-q",
				"-t",
				"ed25519",
				"-N",
				"secretpass",
				"-C",
				"test",
				"-f",
				enc,
			]);
			const r = await importPendingKey(dir, readFileSync(enc, "utf8"));
			expect("error" in r && r.error).toContain("passphrase");
			expect(readdirSync(join(dir, "pending"))).toEqual([]);
		},
	);

	test("rejects garbage text", async () => {
		const r = await importPendingKey(
			join(root, "imp-garbage"),
			"hello world\n",
		);
		expect("error" in r).toBe(true);
	});

	test.skipIf(!hasKeygen)(
		"accepts an unencrypted key with the fingerprint of ssh-keygen -l, CRLF included",
		async () => {
			const dir = join(root, "imp-plain");
			const plain = join(root, "plain");
			runKeygen(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", plain]);
			const r = await importPendingKey(dir, readFileSync(plain, "utf8"));
			expect("id" in r).toBe(true);
			if (!("id" in r)) return;
			const ref = Bun.spawnSync([
				"ssh-keygen",
				"-l",
				"-E",
				"sha256",
				"-f",
				`${plain}.pub`,
			]).stdout.toString();
			expect(r.fingerprint).toBe(/SHA256:[A-Za-z0-9+/=]+/.exec(ref)?.[0] ?? "");
			const crlf = await importPendingKey(
				dir,
				readFileSync(plain, "utf8").replaceAll("\n", "\r\n"),
			);
			expect("fingerprint" in crlf && crlf.fingerprint === r.fingerprint).toBe(
				true,
			);
		},
	);
});

describe("checkHostKey", () => {
	test.skipIf(!hasKeygen)(
		"asks for trust, writes on matching trust, then accepts; a changed key re-asks",
		async () => {
			const dir = join(root, "chk");
			runKeygen([
				"-q",
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				"test",
				"-f",
				join(root, "hk1"),
			]);
			runKeygen([
				"-q",
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				"test",
				"-f",
				join(root, "hk2"),
			]);
			const key1 = readFileSync(join(root, "hk1.pub"), "utf8")
				.trim()
				.split(/\s+/)[1];
			const key2 = readFileSync(join(root, "hk2.pub"), "utf8")
				.trim()
				.split(/\s+/)[1];
			const line1 = `[git.example.com]:2222 ssh-ed25519 ${key1}`;
			const line2 = `[git.example.com]:2222 ssh-ed25519 ${key2}`;
			const remote: GitRemote = {
				scheme: "ssh",
				host: "git.example.com",
				port: 2222,
				hostKey: "git.example.com:2222",
				name: "repo",
			};
			const kh = sshPaths(dir).knownHosts;

			const first = await checkHostKey(dir, remote, undefined, async () => [
				line1,
			]);
			if (first === null || !("needsTrust" in first))
				throw new Error("expected TrustNeeded");
			expect(first.host).toBe("git.example.com:2222");
			expect(first.changed).toBe(false);
			expect(first.fingerprints[0] ?? "").toStartWith("SHA256:");
			expect(existsSync(kh)).toBe(false);

			expect(
				await checkHostKey(dir, remote, first.fingerprints, async () => [
					line1,
				]),
			).toBeNull();
			expect(readFileSync(kh, "utf8")).toContain(
				`[git.example.com]:2222 ssh-ed25519 ${key1}`,
			);

			expect(
				await checkHostKey(dir, remote, undefined, async () => [line1]),
			).toBeNull();

			const changed = await checkHostKey(dir, remote, undefined, async () => [
				line2,
			]);
			if (changed === null || !("needsTrust" in changed))
				throw new Error("expected TrustNeeded");
			expect(changed.changed).toBe(true);
			expect(readFileSync(kh, "utf8")).not.toContain(key2 ?? "");

			// Known keys short-circuit to null whatever the trust; only unknown keys read it.
			expect(
				await checkHostKey(dir, remote, ["SHA256:nope"], async () => [line1]),
			).toBeNull();
			const wrong = await checkHostKey(
				dir,
				remote,
				["SHA256:nope"],
				async () => [line2],
			);
			if (wrong === null || !("needsTrust" in wrong))
				throw new Error("expected TrustNeeded");
			expect(readFileSync(kh, "utf8")).not.toContain(key2 ?? "");

			expect(
				await checkHostKey(dir, remote, changed.fingerprints, async () => [
					line2,
				]),
			).toBeNull();
			const txt = readFileSync(kh, "utf8");
			expect(txt).toContain(key2 ?? "");
			expect(txt).not.toContain(key1 ?? "");
		},
	);
});

describe("gitAuthEnv", () => {
	const env = gitAuthEnv({
		tokens: [{ host: "git.example.com:8443", username: "bob", token: "tok-1" }],
		key: "/state/ssh/global",
		knownHosts: "/state/ssh/known_hosts",
	});

	test("sets the helper config, the token env and the ssh command", () => {
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		const keys = Object.entries(env)
			.filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
			.map(([, v]) => v);
		expect(keys.length).toBe(Number(env.GIT_CONFIG_COUNT));
		expect(keys).toContain("credential.https://git.example.com:8443.helper");
		expect(env.OTTR_GIT_USER_0).toBe("bob");
		expect(env.OTTR_GIT_TOKEN_0).toBe("tok-1");
		expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
		expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
		expect(env.GIT_SSH_COMMAND).toContain("'/state/ssh/global'");
		expect(env.GIT_SSH_COMMAND).toContain("'/state/ssh/known_hosts'");
	});

	// Changed on purpose (merge security review): GIT_SSH_COMMAND is always set so a
	// core.sshCommand planted in the repo config never runs with the tokens in env.
	test("no key and no known_hosts still sets a plain batch ssh command", () => {
		const noKey = gitAuthEnv({ tokens: [], key: null, knownHosts: "/x" });
		expect(noKey.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
	});

	test("a quote in a key path cannot end the shell word", () => {
		const e = gitAuthEnv({ tokens: [], key: "/k/it's", knownHosts: "/x" });
		expect(e.GIT_SSH_COMMAND).toContain("-i '/k/it'\\''s'");
	});

	test("no key keeps the strict host controls once Ottr has a known_hosts", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-gh-"));
		try {
			const kh = join(dir, "known_hosts");
			writeFileSync(kh, "git.example.com ssh-ed25519 AAAA\n");
			const env = gitAuthEnv({ tokens: [], key: null, knownHosts: kh });
			expect(env.GIT_SSH_COMMAND).toContain(`UserKnownHostsFile='${kh}'`);
			expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
			expect(env.GIT_SSH_COMMAND).not.toContain(" -i ");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every produced name matches GIT_AUTH_ENV_RE except GIT_TERMINAL_PROMPT", () => {
		for (const k of Object.keys(env))
			expect(GIT_AUTH_ENV_RE.test(k) || k === "GIT_TERMINAL_PROMPT").toBe(true);
	});
});

describe("promoteKey and removeKey", () => {
	test.skipIf(!hasKeygen)(
		"promote moves key + .pub at 0600; remove clears both and repeats as a no-op",
		async () => {
			const dir = join(root, "prom");
			const gen = await generatePendingKey(dir);
			const from = sshPaths(dir).pending(gen.id);
			const to = join(dir, "projects", "app");
			promoteKey(from, to);
			expect(existsSync(from)).toBe(false);
			expect(existsSync(`${from}.pub`)).toBe(false);
			expect(existsSync(to)).toBe(true);
			expect(existsSync(`${to}.pub`)).toBe(true);
			if (process.platform !== "win32")
				expect(statSync(to).mode & 0o777).toBe(0o600);
			removeKey(to);
			expect(existsSync(to)).toBe(false);
			expect(existsSync(`${to}.pub`)).toBe(false);
			removeKey(to);
		},
	);
});

describe("redact and git secrets", () => {
	test("replaces every non-empty secret", () => {
		expect(
			redact("ssh -i /a/global failed for tok-1 and tok-2", [
				"tok-1",
				"tok-2",
				"",
			]),
		).toBe("ssh -i /a/global failed for [REDACTED] and [REDACTED]");
	});

	test("setGitSecrets/gitSecrets store and return the list", () => {
		setGitSecrets(["s1", "s2"]);
		expect(gitSecrets()).toEqual(["s1", "s2"]);
		setGitSecrets([]);
	});
});

describe("defaultSshDir", () => {
	// The Ottr checkout this test runs from, and a projects root as OMP_TRACKER_ROOTS names it.
	const repo = resolve(import.meta.dir, "..");
	const inside = (p: string, root: string) => {
		const r = relative(root, p);
		return r === "" || (!r.startsWith("..") && !isAbsolute(r));
	};

	test("a native start keeps keys outside the Ottr checkout and every project root", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-home-"));
		try {
			const roots = [repo, join(home, "workspace"), resolve(repo, "..")];
			for (const [env, platform] of [
				[{}, "linux"],
				[{ XDG_DATA_HOME: join(home, "data") }, "linux"],
				[{ LOCALAPPDATA: join(home, "AppData", "Local") }, "win32"],
				[{}, "win32"],
			] as const) {
				const dir = defaultSshDir(env, platform, home);
				for (const root of roots) expect(inside(dir, root)).toBe(false);
				expect(inside(dir, home)).toBe(true);
			}
			// The real process defaults (this machine) never land in this checkout either.
			expect(inside(defaultSshDir({}), repo)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("OTTR_STATE_DIR (a dev board) keeps the keys in that state dir", () => {
		expect(
			defaultSshDir({ OTTR_STATE_DIR: "/w/ottr/.dev/state" }, "linux", "/root"),
		).toBe(join(resolve("/w/ottr/.dev/state"), "ssh"));
		expect(
			defaultSshDir(
				{ OTTR_SSH_DIR: "/srv/ssh", OTTR_STATE_DIR: "/w/state" },
				"linux",
				"/root",
			),
		).toBe(resolve("/srv/ssh"));
	});

	test("OTTR_SSH_DIR wins (compose: the ottr-state volume)", () => {
		expect(
			defaultSshDir({ OTTR_SSH_DIR: "/app/.tasks/ssh" }, "linux", "/root"),
		).toBe(resolve("/app/.tasks/ssh"));
	});
});
