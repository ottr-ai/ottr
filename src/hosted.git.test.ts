import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Entry } from "./app.ts";
import { createHostedGitAuth, HOSTED_TOKEN_MARGIN_MS } from "./gitHosts.ts";
import { GlobalStore } from "./globalStore.ts";
import type { GitToken, Hosted, HostedHooks } from "./hosted.ts";
import { hostedGh } from "./release.ts";
import { ProjectStore } from "./store.ts";
import { VmTokens } from "./vmTokens.ts";
import { git, setHostedGitAuth, setNetworkGitAuth } from "./worktree.ts";

// Hosted mode's per-project git credential (docs/specs/hosted-mode.md section 6).

const root = mkdtempSync(join(tmpdir(), "hosted-git-"));
const stores: { close(): void }[] = [];
afterEach(() => {
	// createApp and the tests install module-wide resolvers: no test leaks one into the next.
	setHostedGitAuth(null);
	setNetworkGitAuth(() => ({}));
});
afterAll(() => {
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const HOUR = 60 * 60_000;
const URL_A = "https://github.com/acme/a.git";
const URL_B = "https://github.com/acme/b.git";
const GLOBAL = "ghp_board_global_token_0123";

/** A fake control plane: records every gitToken call, mints `minted-<project>-<n>`. */
function fakeHooks(
	mint: (
		project: string,
		n: number,
	) => GitToken | null | Promise<GitToken | null> = (project, n) => ({
		token: `minted-${project}-${n}`,
		expiresAt: clock + HOUR,
	}),
) {
	const calls: [string, string][] = [];
	const hooks: HostedHooks = {
		reportUsage: () => {},
		creditOk: async () => true,
		gitToken: async (project, remote) => {
			calls.push([project, remote]);
			return mint(project, calls.length);
		},
	};
	return { hooks, calls };
}

let clock = 0;

function dirs(name: string) {
	const base = join(root, name);
	const a = join(base, "a");
	const b = join(base, "b");
	const c = join(base, "c");
	for (const d of [a, b, c]) mkdirSync(d, { recursive: true });
	return { base, a, b, c };
}

function unitAuth(
	name: string,
	mint?: Parameters<typeof fakeHooks>[0],
	origins: Record<string, string | null> = {
		a: URL_A,
		b: URL_B,
		c: "https://github.com/acme/c.git",
	},
) {
	const d = dirs(name);
	const { hooks, calls } = fakeHooks(mint);
	const logs: string[] = [];
	const auth = createHostedGitAuth({
		gitToken: hooks.gitToken,
		projectFor: (cwd) => {
			for (const p of ["a", "b", "c"] as const) {
				const path = d[p];
				if (cwd === path || cwd.startsWith(`${path}/`))
					return { name: p, originUrl: origins[p] ?? null };
			}
			return null;
		},
		knownHosts: join(d.base, "known_hosts"),
		log: (scope, err) => logs.push(`${scope}: ${String(err)}`),
		now: () => clock,
	});
	return { ...d, auth, calls, logs };
}

/** git's own credential lookup with `env`; `global` is the gitconfig the lookup sees. */
async function credentialFill(
	env: Record<string, string>,
	host: string,
	global = "/dev/null",
): Promise<string> {
	const proc = Bun.spawn(["git", "credential", "fill"], {
		env: {
			...process.env,
			...env,
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: global,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(`protocol=https\nhost=${host}\n\n`);
	proc.stdin.end();
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

const pushArgs = (url: string) => [
	"push",
	"--",
	url,
	"refs/heads/main:refs/heads/main",
];

function withEnv(name: string, value: string | undefined, fn: () => unknown) {
	const saved = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	const restore = () => {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	};
	return Promise.resolve().then(fn).finally(restore);
}

describe("hosted network git credential (createHostedGitAuth)", () => {
	test("project A's cwd gets the token minted for A through the credential helper", async () => {
		clock = 0;
		const t = unitAuth("own");
		const { env } = await t.auth.network(
			join(t.a, ".worktrees", "x"),
			pushArgs(URL_A),
		);
		expect(t.calls).toEqual([["a", URL_A]]);
		const out = await credentialFill(env, "github.com");
		expect(out).toContain("username=x-access-token");
		expect(out).toContain("password=minted-a-1");
		// The helper answers the remote's host only.
		expect(await credentialFill(env, "gitlab.com")).not.toContain("password=");
	});

	test("project B gets B's token and never A's; each redaction list holds its own tokens only", async () => {
		clock = 0;
		const t = unitAuth("scoped");
		const a = await t.auth.network(t.a, pushArgs(URL_A));
		const b = await t.auth.network(t.b, pushArgs(URL_B));
		expect(t.calls).toEqual([
			["a", URL_A],
			["b", URL_B],
		]);
		const outB = await credentialFill(b.env, "github.com");
		expect(outB).toContain("password=minted-b-2");
		expect(outB).not.toContain("minted-a-1");
		expect(Object.values(b.env).join("\n")).not.toContain("minted-a-1");
		expect(a.secrets).toEqual(["minted-a-1"]);
		expect(b.secrets).toEqual(["minted-b-2"]);
	});

	test("a cached token serves every call until 5 minutes before expiresAt, then the hook mints again", async () => {
		clock = 1_000_000;
		const t = unitAuth("cache");
		const fill = async (args: string[]) =>
			credentialFill((await t.auth.network(t.a, args)).env, "github.com");
		expect(await fill(pushArgs(URL_A))).toContain("password=minted-a-1");
		expect(
			await fill([
				"fetch",
				"--no-tags",
				URL_A,
				"+refs/heads/x:refs/remotes/origin/x",
			]),
		).toContain("password=minted-a-1");
		// The gh path shares the (project, remote) cache entry of the push.
		expect(await t.auth.ghToken(t.a, URL_A)).toBe("minted-a-1");
		expect(t.calls).toHaveLength(1);
		const expiresAt = 1_000_000 + HOUR;
		clock = expiresAt - HOSTED_TOKEN_MARGIN_MS - 1;
		expect(await fill(pushArgs(URL_A))).toContain("password=minted-a-1");
		expect(t.calls).toHaveLength(1);
		clock = expiresAt - HOSTED_TOKEN_MARGIN_MS;
		expect(await fill(pushArgs(URL_A))).toContain("password=minted-a-2");
		expect(t.calls).toHaveLength(2);
		// The rotated token stays in A's redaction list.
		const { secrets } = await t.auth.network(t.a, pushArgs(URL_A));
		expect(secrets).toEqual(["minted-a-1", "minted-a-2"]);
	});

	test("concurrent misses for one project and remote share one hook call", async () => {
		clock = 0;
		const gate = Promise.withResolvers<void>();
		const t = unitAuth("flight", async (project, n) => {
			await gate.promise;
			return { token: `minted-${project}-${n}`, expiresAt: clock + HOUR };
		});
		const all = Promise.all(
			[1, 2, 3].map(() => t.auth.network(t.a, pushArgs(URL_A))),
		);
		expect(t.calls).toHaveLength(1);
		gate.resolve();
		const envs = await all;
		for (const { env } of envs)
			expect(await credentialFill(env, "github.com")).toContain(
				"password=minted-a-1",
			);
		expect(t.calls).toHaveLength(1);
	});

	test("the board's GH_TOKEN, the ambient helpers and the ssh key never take part", async () => {
		if (process.platform === "win32") return; // the ambient helper is a sh function
		clock = 0;
		const t = unitAuth("global");
		// An ambient helper (like the image's gh helper) that would answer every host.
		const global = join(t.base, "gitconfig");
		const set = Bun.spawnSync([
			"git",
			"config",
			"--file",
			global,
			"credential.helper",
			`!f() { test "$1" = get || exit 0; printf 'username=amb\\npassword=ambient-helper-${GLOBAL}\\n'; }; f`,
		]);
		expect(set.exitCode).toBe(0);
		// The control: without the hosted env, git asks the ambient helper.
		expect(await credentialFill({}, "github.com", global)).toContain(
			"password=ambient-helper",
		);
		await withEnv("GH_TOKEN", GLOBAL, async () => {
			const own = await t.auth.network(t.a, pushArgs(URL_A));
			const out = await credentialFill(own.env, "github.com", global);
			expect(out).toContain("password=minted-a-1");
			expect(out).not.toContain(GLOBAL);
			expect(own.env.GH_TOKEN).toBe("");
			expect(own.env.GITHUB_TOKEN).toBe("");
			expect(own.env.GIT_SSH_COMMAND).not.toContain(" -i ");
			// A call without a minted token gets no credential at all, not the ambient one.
			const outside = await t.auth.network(
				join(t.base, "elsewhere"),
				pushArgs(URL_A),
			);
			expect(
				await credentialFill(outside.env, "github.com", global),
			).not.toContain("password=");
		});
	});

	test("a null token or a hook error runs the call without a credential", async () => {
		clock = 0;
		const t = unitAuth("none", (project, n) => {
			if (project === "b") throw new Error("control plane down");
			if (project === "c") return null;
			return { token: `minted-${project}-${n}`, expiresAt: clock + HOUR };
		});
		for (const cwd of [t.b, t.c]) {
			const { env, secrets } = await t.auth.network(cwd, ["fetch"]);
			expect(env).not.toHaveProperty("OTTR_GIT_TOKEN_0");
			expect(secrets).toEqual([]);
			expect(await credentialFill(env, "github.com")).not.toContain(
				"password=",
			);
		}
		// `fetch` without a positional argument asks for the project's pinned origin.
		expect(t.calls).toEqual([
			["b", URL_B],
			["c", "https://github.com/acme/c.git"],
		]);
		expect(t.logs).toEqual([
			"hosted git token for b: Error: control plane down",
		]);
		// A null answer is not cached: the next call asks again.
		await t.auth.network(t.c, ["fetch"]);
		expect(t.calls).toHaveLength(3);
	});

	test("an ssh remote, a local path, a remote name or a cwd outside every project never asks the hook", async () => {
		clock = 0;
		const t = unitAuth("skip");
		await t.auth.network(t.a, pushArgs("git@github.com:acme/a.git"));
		await t.auth.network(t.a, ["ls-remote", "--", join(t.base, "bare.git")]);
		await t.auth.network(t.a, ["fetch", "origin", "main"]);
		const outside = await t.auth.network(
			join(t.base, "elsewhere"),
			pushArgs(URL_A),
		);
		expect(outside.secrets).toEqual([]);
		expect(await t.auth.ghToken(join(t.base, "elsewhere"), URL_A)).toBeNull();
		expect(t.calls).toEqual([]);
	});
});

describe("hosted git() and gh", () => {
	test("git() redacts every token minted for the cwd's project from its output", async () => {
		clock = 0;
		const t = unitAuth("redact");
		setHostedGitAuth(t.auth);
		await t.auth.network(t.a, pushArgs(URL_A));
		// A local remote: no hook call, git's error echoes the path, which holds the token.
		const r = await git(["ls-remote", "--", join(t.base, "minted-a-1")], t.a);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("[REDACTED]");
		expect(r.stderr).not.toContain("minted-a-1");
		expect(t.calls).toHaveLength(1);
	}, 30_000);

	test("hostedGh runs gh with the project's minted token, never the board's GH_TOKEN", async () => {
		if (process.platform === "win32") return; // the fake is a sh script
		clock = 0;
		const t = unitAuth("gh");
		setHostedGitAuth(t.auth);
		const bin = join(t.base, "bin");
		mkdirSync(bin);
		const script = join(bin, "gh");
		writeFileSync(
			script,
			'#!/bin/sh\nenv > "$0.env"\necho "bad token $GH_TOKEN" >&2\nexit 1\n',
		);
		chmodSync(script, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${bin}:${savedPath}`;
		try {
			await withEnv("OTTR_GITHUB_HOST", undefined, () =>
				withEnv("GH_TOKEN", GLOBAL, async () => {
					const gh = await hostedGh(t.a, URL_A);
					const r = await gh(["api", "x"]);
					const dumped = readFileSync(`${script}.env`, "utf8");
					expect(dumped).toMatch(/^GH_TOKEN=minted-a-1$/m);
					expect(dumped).not.toContain(GLOBAL);
					expect(r.stderr).toContain("bad token [REDACTED]");
					// No token for B's remote: gh runs bare, still without the board's token.
					const bare = await hostedGh(t.b, null);
					await bare(["api", "x"]);
					const dumpedB = readFileSync(`${script}.env`, "utf8");
					expect(dumpedB).not.toMatch(/^GH_TOKEN=/m);
					expect(dumpedB).not.toContain(GLOBAL);
				}),
			);
		} finally {
			process.env.PATH = savedPath;
		}
		expect(t.calls).toEqual([["a", URL_A]]);
	});
});

const shared = () => ({
	maxTotalRuns: 3,
	reviewCheck: true,
	workCheck: true,
	idleReviews: true,
	trendingScan: true,
	removedPaths: [] as string[],
	envValues: {} as Record<string, string>,
	projectPaths: [] as string[],
	projectOrder: [] as string[],
});

/** A board with project `p` (a git repo whose origin is an ssh fake host) pinned to URL_A. */
function board(
	name: string,
	hosted: Hosted | undefined,
	fetchImpl?: typeof globalThis.fetch,
) {
	const base = join(root, name);
	mkdirSync(base, { recursive: true });
	const g = GlobalStore.open(join(base, "g"));
	stores.push(g);
	// A board-global token for github.com: flag off it rides every https call there.
	g.set("config", {
		gitTokens: [
			{ host: "github.com", username: "x-access-token", token: GLOBAL },
		],
	});
	const dir = join(base, "p");
	mkdirSync(dir);
	for (const args of [
		["init", "-q", "-b", "main"],
		["remote", "add", "origin", "fake-host.example:o/r.git"],
	]) {
		const r = Bun.spawnSync(["git", ...args], { cwd: dir });
		expect(r.exitCode).toBe(0);
	}
	const store = ProjectStore.open(dir);
	stores.push(store);
	store.setSettings({ originUrl: URL_A });
	const projects = new Map<string, Entry>();
	projects.set("p", {
		path: dir,
		name: "p",
		store,
		target: null,
		gitless: false,
		github: null,
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	});
	const app = createApp({
		gstore: g,
		defaultDir: base,
		projects,
		cancel: async () => ({ removed: true }),
		finishKept: async () => ({ ok: true }),
		stopTurn: async () => ({ ok: true }),
		claimedPids: () => new Set<number>(),
		schedule: () => {},
		serverVersion: "test",
		port: 0,
		publicHosts: [],
		shared: shared(),
		serverRef: { current: undefined },
		sshDir: join(base, "ssh"),
		board: { url: "http://ottr:4852", token: "boot-token-git" },
		vmTokens: new VmTokens({ file: null }),
		hosted,
		githubAuthProbe: fetchImpl ? { fetchImpl } : undefined,
	});
	// git runs GIT_SSH_COMMAND for the ssh origin, so the script records the exact env of the
	// network git child. (git drops GIT_CONFIG_COUNT for its ssh child, so the credential
	// lookup itself is proven by the unit tests above.)
	const record = join(base, "child-env.txt");
	const script = join(base, "fake-ssh.sh");
	writeFileSync(script, `#!/bin/sh\nenv > '${record}'\nexit 1\n`, {
		mode: 0o755,
	});
	// `fetch` names no remote: git uses the repo's origin, the hosted resolver the pinned URL.
	const fetch = () =>
		git(["fetch"], dir, 30_000, undefined, { GIT_SSH_COMMAND: script });
	return { app, dir, fetch, childEnv: () => readFileSync(record, "utf8") };
}

describe("createApp network git credential", () => {
	test("hosted: the git child gets the project's minted token, never the board-global one", async () => {
		if (process.platform === "win32") return; // the fake ssh is a sh script
		const { hooks, calls } = fakeHooks((project, n) => ({
			token: `minted-${project}-${n}`,
			expiresAt: Date.now() + HOUR,
		}));
		const b = board("app-hosted", {
			config: {
				tenant: "acme",
				secret: "hosted-secret-".repeat(4),
				controlUrl: "http://127.0.0.1:9",
				wording: {
					workSuffix: "",
					mergeSuffix: "",
					resumeSuffix: "",
					creditReason: "out of credit",
				},
			},
			hooks,
		});
		await withEnv("GH_TOKEN", GLOBAL, async () => {
			await b.fetch();
			const env = b.childEnv();
			expect(calls).toEqual([["p", URL_A]]);
			expect(env).toMatch(/^OTTR_GIT_TOKEN_0=minted-p-1$/m);
			expect(env).toMatch(/^OTTR_GIT_USER_0=x-access-token$/m);
			expect(env).toMatch(
				/^GIT_CONFIG_KEY_\d+=credential\.https:\/\/github\.com\.helper$/m,
			);
			expect(env).toMatch(/^GH_TOKEN=$/m);
			expect(env).not.toContain(GLOBAL);
			expect(env).not.toContain("OTTR_GIT_TOKEN_1=");
			// Redaction follows the project: its minted token never leaves git() raw.
			const r = await git(
				["ls-remote", "--", join(b.dir, "minted-p-1")],
				b.dir,
			);
			expect(r.stderr).toContain("[REDACTED]");
			expect(r.stderr).not.toContain("minted-p-1");
		});
	}, 60_000);

	test("flag off: the board-global token still rides network git", async () => {
		if (process.platform === "win32") return; // the fake ssh is a sh script
		// The hosted resolver stays unset: a self-hosted app clears it.
		setHostedGitAuth(unitAuth("app-self-stale").auth);
		const b = board("app-self", undefined);
		await b.fetch();
		const env = b.childEnv();
		expect(env).toMatch(new RegExp(`^OTTR_GIT_TOKEN_0=${GLOBAL}$`, "m"));
	}, 60_000);
});

const hostedCfg = (hooks: HostedHooks): Hosted => ({
	config: {
		tenant: "acme",
		secret: "hosted-secret-".repeat(4),
		controlUrl: "http://127.0.0.1:9",
		wording: {
			workSuffix: "",
			mergeSuffix: "",
			resumeSuffix: "",
			creditReason: "out of credit",
		},
	},
	hooks,
});

/** A fetch stub that records each request's Authorization header and answers 404. */
function probe() {
	const auths: string[] = [];
	const impl = (async (_url: unknown, init?: RequestInit) => {
		auths.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { impl, auths };
}

describe("hosted push credential line and auth hint", () => {
	test("hosted pushAuthKind names the control-plane token, never the global kinds", async () => {
		const b = board("kind-hosted", hostedCfg(fakeHooks().hooks));
		await withEnv("GH_TOKEN", GLOBAL, async () => {
			const line = b.app.pushAuthKind(URL_A);
			expect(line).toBe(
				"a GitHub App installation token from the control plane",
			);
			expect(line).not.toContain("board-stored");
			expect(line).not.toContain("GH_TOKEN");
			expect(line).not.toContain("credential helper");
			expect(b.app.pushAuthKind("git@github.com:acme/a.git")).toBe(
				"no credential the board knows of",
			);
		});
	});

	test("flag off: pushAuthKind still names the board-stored token", () => {
		const b = board("kind-self", undefined);
		expect(b.app.pushAuthKind(URL_A)).toContain(
			"a board-stored token for github.com (personal access token)",
		);
	});

	test("hosted githubAuthHint makes no request with the global token", async () => {
		const p = probe();
		const b = board("hint-hosted", hostedCfg(fakeHooks().hooks), p.impl);
		await withEnv("GH_TOKEN", GLOBAL, async () => {
			expect(await b.app.githubAuthHint(URL_A)).toBeNull();
		});
		expect(p.auths).toEqual([]);
	});

	test("flag off: githubAuthHint still probes with the board-global token", async () => {
		const p = probe();
		const b = board("hint-self", undefined, p.impl);
		await b.app.githubAuthHint(URL_A);
		expect(p.auths.some((a) => a.includes(GLOBAL))).toBe(true);
	});
});
