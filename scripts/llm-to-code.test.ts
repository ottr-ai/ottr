import { expect, test } from "bun:test";

// Runs the shipped llm-to-code script through its own --self-test as a
// subprocess, the same way a user runs it. The test lives in scripts/ instead
// of the skill folder: a second TypeScript file in .agents/skills/llm-to-code/
// degrades the SkillSpector scan of the shipped skill (LP3 fires; exit 1).
test("shipped llm-to-code profile-session.ts --self-test passes", () => {
	const r = Bun.spawnSync(
		[
			process.execPath,
			`${import.meta.dir}/../.agents/skills/llm-to-code/scripts/profile-session.ts`,
			"--self-test",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(r.exitCode).toBe(0);
	expect(r.stdout.toString()).toContain("self-test ok");
});
