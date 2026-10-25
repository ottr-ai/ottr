import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "..", "docker", "ottr-entry.sh");
const root = mkdtempSync(join(tmpdir(), "ottr-entry-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const IDENTITY = "[user]\n\tname = Ottr\n\temail = ottr@localhost\n";
const MNEMOPI = "memory:\n  backend: mnemopi\n";
const HINDSIGHT = "memory:\n  backend: hindsight\n";
const PLANT = "[credential]\n\thelper = !touch planted\n";
const CUSTOM = "[user]\n\tname = Custom\n";

let cases = 0;
/** A fresh shared home and a separate /etc/ottr stand-in for one case. */
function fixture(): {
	home: string;
	gitconfig: string;
	gh: string;
	agent: string;
} {
	const dir = join(root, String(cases++));
	const home = join(dir, "home");
	const etc = join(dir, "etc-ottr");
	mkdirSync(home, { recursive: true });
	return {
		home,
		gitconfig: join(etc, "gitconfig"),
		gh: join(etc, "gh"),
		agent: join(etc, "home", ".omp", "agent"),
	};
}

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** Runs the entry script with a minimal env: PATH plus exactly what the case passes. */
function run(env: Record<string, string>, ...cmd: string[]) {
	const r = Bun.spawnSync(["sh", script, ...cmd], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: r.exitCode,
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
	};
}

describe.skipIf(process.platform === "win32")("ottr-entry.sh", () => {
	test("a planted shared home seeds nothing into absent pins", () => {
		const f = fixture();
		write(join(f.home, ".gitconfig"), PLANT);
		write(join(f.home, ".omp", "agent", "config.yml"), MNEMOPI);
		write(join(f.home, ".omp", "agent", "skills", "x", "SKILL.md"), "plant\n");
		const r = run(
			{
				HOME: f.home,
				GIT_CONFIG_GLOBAL: f.gitconfig,
				GH_CONFIG_DIR: f.gh,
				PI_CODING_AGENT_DIR: f.agent,
			},
			"echo",
			"ran",
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("ran\n");
		expect(readFileSync(f.gitconfig, "utf8")).toBe(IDENTITY);
		expect(readdirSync(f.agent)).toEqual([]);
		expect(readdirSync(f.gh)).toEqual([]);
		expect(r.stderr).toContain(
			`ottr-entry: R5-1: refused to seed ${f.gitconfig} from ${f.home}/.gitconfig`,
		);
		expect(r.stderr).toContain(`ottr-entry: R5-1: ${f.agent} is not seeded`);
	});

	test("without a shared .gitconfig the identity is written silently", () => {
		const f = fixture();
		const r = run(
			{ HOME: f.home, GIT_CONFIG_GLOBAL: f.gitconfig },
			"echo",
			"ran",
		);
		expect(r.code).toBe(0);
		expect(readFileSync(f.gitconfig, "utf8")).toBe(IDENTITY);
		expect(r.stderr).toBe("");
	});

	test("existing pins are kept and both configs get the flip", () => {
		const f = fixture();
		write(f.gitconfig, CUSTOM);
		write(join(f.agent, "config.yml"), MNEMOPI);
		write(join(f.home, ".omp", "agent", "config.yml"), MNEMOPI);
		write(join(f.home, ".gitconfig"), PLANT);
		const r = run(
			{
				HOME: f.home,
				GIT_CONFIG_GLOBAL: f.gitconfig,
				GH_CONFIG_DIR: f.gh,
				PI_CODING_AGENT_DIR: f.agent,
				HINDSIGHT_API_URL: "http://h",
			},
			"echo",
			"ran",
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("ran\n");
		expect(readFileSync(f.gitconfig, "utf8")).toBe(CUSTOM);
		expect(readFileSync(join(f.agent, "config.yml"), "utf8")).toBe(HINDSIGHT);
		expect(
			readFileSync(join(f.home, ".omp", "agent", "config.yml"), "utf8"),
		).toBe(HINDSIGHT);
		expect(readdirSync(f.agent)).toEqual(["config.yml"]);
		expect(r.stderr).not.toContain("R5-1");
	});

	test("without HINDSIGHT_API_URL neither config.yml changes", () => {
		const f = fixture();
		write(join(f.agent, "config.yml"), MNEMOPI);
		write(join(f.home, ".omp", "agent", "config.yml"), MNEMOPI);
		const r = run(
			{ HOME: f.home, PI_CODING_AGENT_DIR: f.agent },
			"echo",
			"ran",
		);
		expect(r.code).toBe(0);
		expect(readFileSync(join(f.agent, "config.yml"), "utf8")).toBe(MNEMOPI);
		expect(
			readFileSync(join(f.home, ".omp", "agent", "config.yml"), "utf8"),
		).toBe(MNEMOPI);
	});

	test("a pin inside the shared home refuses to start before any write", () => {
		const f = fixture();
		const inside = join(f.home, ".omp", "agent");
		write(join(inside, "config.yml"), MNEMOPI);
		const r = run(
			{
				HOME: f.home,
				GIT_CONFIG_GLOBAL: f.gitconfig,
				PI_CODING_AGENT_DIR: inside,
			},
			"echo",
			"ran",
		);
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(
			`ottr-entry: R5-1: PI_CODING_AGENT_DIR=${inside} lies in the shared home ${f.home}; refusing to start`,
		);
		expect(existsSync(f.gitconfig)).toBe(false);
	});

	test("a pin equal to the shared home refuses to start", () => {
		const f = fixture();
		const r = run({ HOME: f.home, GH_CONFIG_DIR: f.home }, "echo", "ran");
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("GH_CONFIG_DIR=");
		expect(r.stderr).toContain("refusing to start");
	});

	test("a sibling path that only shares the home prefix is allowed", () => {
		const f = fixture();
		const sibling = `${f.home}-other/gitconfig`;
		const r = run({ HOME: f.home, GIT_CONFIG_GLOBAL: sibling }, "echo", "ran");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("ran\n");
		expect(readFileSync(sibling, "utf8")).toBe(IDENTITY);
	});
});
