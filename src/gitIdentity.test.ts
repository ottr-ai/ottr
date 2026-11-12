import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitIdentityEnv,
	DEFAULT_COMMIT_EMAIL,
	DEFAULT_COMMIT_NAME,
	identityArgs,
	parseCommitField,
	probeGitIdent,
} from "./gitIdentity.ts";

describe("identityArgs", () => {
	test("null keeps the built-in Ottr identity", () => {
		expect(identityArgs(null)).toEqual([
			"-c",
			`user.name=${DEFAULT_COMMIT_NAME}`,
			"-c",
			`user.email=${DEFAULT_COMMIT_EMAIL}`,
		]);
	});

	test("a custom identity pins its own values", () => {
		expect(identityArgs({ name: "Acme", email: "ci@acme.dev" })).toEqual([
			"-c",
			"user.name=Acme",
			"-c",
			"user.email=ci@acme.dev",
		]);
	});
});

describe("commitIdentityEnv", () => {
	const id = { name: "Ottr", email: "ottr@localhost" };

	test("nothing configured sets all four vars", () => {
		expect(commitIdentityEnv(id, { name: false, email: false })).toEqual({
			GIT_AUTHOR_NAME: "Ottr",
			GIT_COMMITTER_NAME: "Ottr",
			GIT_AUTHOR_EMAIL: "ottr@localhost",
			GIT_COMMITTER_EMAIL: "ottr@localhost",
		});
	});

	test("both configured sets nothing", () => {
		expect(commitIdentityEnv(id, { name: true, email: true })).toEqual({});
	});

	test("only the name configured sets the email pair", () => {
		expect(commitIdentityEnv(id, { name: true, email: false })).toEqual({
			GIT_AUTHOR_EMAIL: "ottr@localhost",
			GIT_COMMITTER_EMAIL: "ottr@localhost",
		});
	});

	test("only the email configured sets the name pair", () => {
		expect(commitIdentityEnv(id, { name: false, email: true })).toEqual({
			GIT_AUTHOR_NAME: "Ottr",
			GIT_COMMITTER_NAME: "Ottr",
		});
	});
});

describe("parseCommitField", () => {
	test("valid names pass through trimmed", () => {
		expect(parseCommitField("Ottr", "commitName")).toEqual({
			ok: true,
			value: "Ottr",
		});
		expect(parseCommitField(" Ottr Agent ", "commitName")).toEqual({
			ok: true,
			value: "Ottr Agent",
		});
		expect(parseCommitField("a".repeat(100), "commitName")).toEqual({
			ok: true,
			value: "a".repeat(100),
		});
	});

	test("valid emails pass through trimmed", () => {
		expect(parseCommitField("ottr@localhost", "commitEmail")).toEqual({
			ok: true,
			value: "ottr@localhost",
		});
		expect(parseCommitField("a.b+c@sub.example.com", "commitEmail")).toEqual({
			ok: true,
			value: "a.b+c@sub.example.com",
		});
	});

	test("invalid values carry their 400 text", () => {
		for (const [v, field] of [
			[42, "commitName"],
			[{}, "commitEmail"],
			["A<B", "commitName"],
			["bad\u0000name", "commitName"],
			["bad\nname", "commitName"],
			["a".repeat(101), "commitName"],
			["no-at-sign", "commitEmail"],
			["has space@example.com", "commitEmail"],
			["a".repeat(201), "commitEmail"],
		] as [unknown, "commitName" | "commitEmail"][]) {
			expect(parseCommitField(v, field).ok).toBe(false);
		}
	});

	test("whitespace-only resets, undefined keeps, null resets", () => {
		expect(parseCommitField("   ", "commitName")).toEqual({
			ok: true,
			value: null,
		});
		expect(parseCommitField(undefined, "commitEmail")).toEqual({
			ok: true,
			value: undefined,
		});
		expect(parseCommitField(null, "commitName")).toEqual({
			ok: true,
			value: null,
		});
	});
});

describe("probeGitIdent", () => {
	/** A temp dir outside the repo; the caller removes it. */
	function tempDir(prefix: string): string {
		return mkdtempSync(join(tmpdir(), prefix));
	}

	/** A real repo (git init) whose HOME-less env keeps the probe off this machine's config. */
	function tempRepo(prefix: string): string {
		const dir = tempDir(prefix);
		const run = (...args: string[]) => {
			const r = Bun.spawnSync(["git", ...args], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "" },
			});
			if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
		};
		run("init", "-q", "-b", "main");
		return dir;
	}

	test("an empty home outside a repo resolves nothing", async () => {
		const home = tempDir("ottr-probe-empty-");
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: false, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a .gitconfig identity resolves both fields", async () => {
		const home = tempDir("ottr-probe-full-");
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Tester\n\temail = t@example.com\n",
		);
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: true });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("only user.name resolves the name alone", async () => {
		const home = tempDir("ottr-probe-name-");
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Tester\n");
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a kept GIT_CONFIG_GLOBAL pointer wins over the home, like the turn's git", async () => {
		// The board container case: the pinned /etc/ottr/gitconfig replaces the global
		// scope, so the shared home's ~/.gitconfig is never consulted by the turn.
		const home = tempDir("ottr-probe-pin-");
		const cfgDir = tempDir("ottr-probe-pincfg-");
		const cfg = join(cfgDir, "pinned.gitconfig");
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Planted\n\temail = planted@example.com\n",
		);
		writeFileSync(cfg, "[user]\n\tname = Pinned\n\temail = pinned@ottr\n");
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: cfg,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: true });
			// The pinned identity, not the planted home one, is what the probe saw: probe a
			// pinned file without an identity and the planted home must still stay hidden.
			writeFileSync(cfg, "[core]\n\tfsmonitor = false\n");
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: cfg,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: false, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(cfgDir, { recursive: true, force: true });
		}
	});

	test("a stripped pointer (worker mode) reads the home's ~/.gitconfig", async () => {
		const home = tempDir("ottr-probe-worker-");
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Shared\n\temail = shared@example.com\n",
		);
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: true });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("repo-local config counts when the probe cwd is the worktree", async () => {
		const home = tempDir("ottr-probe-repo-home-");
		const repo = tempRepo("ottr-probe-repo-");
		writeFileSync(
			join(repo, ".git", "config"),
			"[core]\n\trepositoryformatversion = 0\n[user]\n\tname = Repo Local\n\temail = repo@example.com\n",
		);
		try {
			expect(
				await probeGitIdent({
					cwd: repo,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: true });
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("an includeIf gitdir identity counts", async () => {
		// The common corporate setup: one identity per checkout path via includeIf.
		const home = tempDir("ottr-probe-if-home-");
		const repo = tempRepo("ottr-probe-if-");
		const ident = tempDir("ottr-probe-if-ident-");
		const identFile = join(ident, "identity.gitconfig");
		writeFileSync(
			identFile,
			"[user]\n\tname = Corp\n\temail = corp@ghe.example\n",
		);
		writeFileSync(
			join(repo, ".git", "config"),
			`[core]\n\trepositoryformatversion = 0\n[includeIf "gitdir:${repo}/"]\n\tpath = ${identFile}\n`,
		);
		try {
			expect(
				await probeGitIdent({
					cwd: repo,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: true });
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
			rmSync(ident, { recursive: true, force: true });
		}
	});

	test("an inherited ident env counts as configured", async () => {
		// The env beats every config scope, so a base env that already carries an author
		// name must suppress the fallback env for that field alone.
		const home = tempDir("ottr-probe-inh-");
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: {
						PATH: process.env.PATH ?? "",
						GIT_AUTHOR_NAME: "Operator",
					},
				}),
			).toEqual({ name: true, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("GIT_CONFIG_COUNT injection cannot steer the probe", async () => {
		// The turn env strips the count form (withoutGitAuth); the probe must not let a
		// leftover one fake a configured identity.
		const home = tempDir("ottr-probe-count-");
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: {
						PATH: process.env.PATH ?? "",
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_1: "user.name",
						GIT_CONFIG_VALUE_1: "Injected",
					},
				}),
			).toEqual({ name: false, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the XDG config also counts", async () => {
		const home = tempDir("ottr-probe-xdg-");
		mkdirSync(join(home, ".config", "git"), { recursive: true });
		writeFileSync(
			join(home, ".config", "git", "config"),
			"[user]\n\tname = Xdg\n\temail = xdg@example.com\n",
		);
		try {
			expect(
				await probeGitIdent({
					cwd: home,
					home,
					gitConfigGlobal: null,
					baseEnv: { PATH: process.env.PATH ?? "" },
				}),
			).toEqual({ name: true, email: true });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
