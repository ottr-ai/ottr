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
	/** A temp home outside the repo; the caller removes it. */
	function tempHome(prefix: string): string {
		return mkdtempSync(join(tmpdir(), prefix));
	}

	test("an empty home resolves nothing", () => {
		const home = tempHome("ottr-probe-empty-");
		try {
			expect(probeGitIdent(home)).toEqual({ name: false, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a .gitconfig identity resolves both fields", () => {
		const home = tempHome("ottr-probe-full-");
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Tester\n\temail = t@example.com\n",
		);
		try {
			expect(probeGitIdent(home)).toEqual({ name: true, email: true });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("only user.name resolves the name alone", () => {
		const home = tempHome("ottr-probe-name-");
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Tester\n");
		try {
			expect(probeGitIdent(home)).toEqual({ name: true, email: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("GIT_CONFIG_GLOBAL must not count: the probe reads the home files only", () => {
		const home = tempHome("ottr-probe-env-");
		const cfg = tempHome("ottr-probe-envcfg-");
		writeFileSync(
			join(cfg, "global.gitconfig"),
			"[user]\n\tname = Env\n\temail = env@example.com\n",
		);
		const saved = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = join(cfg, "global.gitconfig");
		try {
			expect(probeGitIdent(home)).toEqual({ name: false, email: false });
		} finally {
			if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved;
			rmSync(home, { recursive: true, force: true });
			rmSync(cfg, { recursive: true, force: true });
		}
	});

	test("the XDG config also counts", () => {
		const home = tempHome("ottr-probe-xdg-");
		mkdirSync(join(home, ".config", "git"), { recursive: true });
		writeFileSync(
			join(home, ".config", "git", "config"),
			"[user]\n\tname = Xdg\n\temail = xdg@example.com\n",
		);
		try {
			expect(probeGitIdent(home)).toEqual({ name: true, email: true });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
