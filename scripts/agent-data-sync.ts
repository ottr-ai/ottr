/**
 * Fails when the agent-data checkout would lose work on the next snapshot
 * sync: a feature branch there parks every agent-data merge behind it
 * (OTTR-516, OTTR-527), and an AGENTS.md edit not captured to agent-data is
 * reverted by the sync (OTTR-492). The machine copy must match the tracked
 * source, and the checkout must sit on main.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AgentDataResult {
	ok: boolean;
	skipped: boolean;
	problems: string[];
}

export function checkAgentData(
	agentRoot: string,
	mainRoot: string,
): AgentDataResult {
	if (!existsSync(join(agentRoot, ".git"))) {
		return { ok: true, skipped: true, problems: [] };
	}
	const problems: string[] = [];
	const branch = Bun.spawnSync(
		["git", "-C", agentRoot, "branch", "--show-current"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const current = branch.stdout.toString().trim();
	if (current !== "main") {
		problems.push(
			`agent-data checkout is on branch "${current}", not main — switch it back to main; never merge or rebase it from here (OTTR-516, OTTR-527)`,
		);
	}
	const machineCopy = join(mainRoot, "AGENTS.md");
	const sourceCopy = join(agentRoot, "projects", "ottr", "AGENTS.md");
	for (const path of [machineCopy, sourceCopy]) {
		if (!existsSync(path)) {
			problems.push(`missing AGENTS.md copy: ${path}`);
		}
	}
	if (problems.length === 0) {
		const machineHash = createHash("sha256")
			.update(readFileSync(machineCopy))
			.digest("hex");
		const sourceHash = createHash("sha256")
			.update(readFileSync(sourceCopy))
			.digest("hex");
		if (machineHash !== sourceHash) {
			problems.push(
				`AGENTS.md differs from its agent-data source — capture the machine copy with alate's sync-projects.mjs or take the agent-data source (${sourceCopy}) (OTTR-492)`,
			);
		}
	}
	return { ok: problems.length === 0, skipped: false, problems };
}

function main(): number {
	const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (gitDir.exitCode !== 0) {
		console.error("agent-data-sync: not a git repository");
		return 1;
	}
	// Worktrees compare the main checkout, the standing invariant.
	const mainRoot = resolve(dirname(gitDir.stdout.toString().trim()));
	const agentRoot =
		process.env.OTTR_AGENT_DATA_ROOT ?? join(mainRoot, "..", "agent-data");
	const result = checkAgentData(agentRoot, mainRoot);
	if (result.skipped) {
		console.log(`agent-data-sync: skipped (${agentRoot} not found)`);
		return 0;
	}
	if (!result.ok) {
		console.error("agent-data-sync problems:");
		for (const problem of result.problems) console.error(" ", problem);
		return 1;
	}
	console.log(
		"agent-data-sync: ok (checkout on main, AGENTS.md matches source)",
	);
	return 0;
}

if (import.meta.main) process.exit(main());
