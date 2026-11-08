// Fixtures for the agent-data sync gate: throwaway git repos under tmpdir,
// built by the test's own spawn helper, never through checkAgentData or a
// real agent-data checkout.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExe } from "../src/worktree.ts";
import { checkAgentData } from "./agent-data-sync.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-agent-data-sync-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** git for fixtures with a throwaway identity — never a gate spawn. */
function must(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(
		[
			gitExe(),
			"-c",
			"user.name=ott",
			"-c",
			"user.email=ott@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

const AGENTS = "# agents rules for the fixture\n";

/** A main-root copy plus an agent-data checkout with the given branch state. */
function fixture(
	branch: "main" | "feature",
	source: string | null,
): {
	agentRoot: string;
	mainRoot: string;
} {
	const dir = join(root, `${branch}-${source}-${fixtures++}`);
	const mainRoot = join(dir, "main");
	const agentRoot = join(dir, "agent-data");
	mkdirSync(mainRoot, { recursive: true });
	mkdirSync(agentRoot, { recursive: true });
	must(mainRoot, "init", "-b", "main");
	must(agentRoot, "init", "-b", branch);
	writeFileSync(join(mainRoot, "AGENTS.md"), AGENTS);
	must(mainRoot, "add", ".");
	must(mainRoot, "commit", "-m", "machine copy");
	if (source !== null) {
		mkdirSync(join(agentRoot, "projects", "ottr"), { recursive: true });
		writeFileSync(join(agentRoot, "projects", "ottr", "AGENTS.md"), source);
		must(agentRoot, "add", ".");
		must(agentRoot, "commit", "-m", "source copy");
	}
	return { agentRoot, mainRoot };
}

let fixtures = 0;

describe("checkAgentData", () => {
	test("feature branch in agent-data fails and names the branch (OTTR-516/527)", () => {
		const f = fixture("feature", AGENTS);
		const r = checkAgentData(f.agentRoot, f.mainRoot);
		expect(r.ok).toBe(false);
		expect(r.skipped).toBe(false);
		expect(r.problems.some((p) => p.includes("feature"))).toBe(true);
	});

	test("AGENTS.md bytes differing from the source fail (OTTR-492)", () => {
		const f = fixture("main", "# captured elsewhere\n");
		const r = checkAgentData(f.agentRoot, f.mainRoot);
		expect(r.ok).toBe(false);
		expect(r.problems.some((p) => p.includes("AGENTS.md differs"))).toBe(true);
	});

	test("byte-identical copies on main pass", () => {
		const f = fixture("main", AGENTS);
		const r = checkAgentData(f.agentRoot, f.mainRoot);
		expect(r).toEqual({ ok: true, skipped: false, problems: [] });
	});

	test("missing agent-data checkout is a designed skip", () => {
		const f = fixture("main", AGENTS);
		const r = checkAgentData(join(f.agentRoot, "absent"), f.mainRoot);
		expect(r.ok).toBe(true);
		expect(r.skipped).toBe(true);
	});

	test("missing source copy fails and names the path", () => {
		const f = fixture("main", null);
		const r = checkAgentData(f.agentRoot, f.mainRoot);
		expect(r.ok).toBe(false);
		expect(
			r.problems.some((p) => p.includes(join("projects", "ottr", "AGENTS.md"))),
		).toBe(true);
	});
});
