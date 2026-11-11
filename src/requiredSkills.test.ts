import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	missingByUse,
	missingRequired,
	REQUIRED_SKILLS,
} from "./requiredSkills.ts";

describe("missingRequired", () => {
	test("a worker with everything reports no gaps", () => {
		const installed = {
			skills: [
				"security-audit",
				"codebase-design",
				"ponytail-audit",
				"ui-ux-check",
				"diff-security-review",
				"explain-project",
				"check-ottr-board",
				"retro",
			],
			rules: ["codeguard-0-input-validation-injection.md"],
		};
		expect(missingRequired(installed)).toEqual([]);
		expect(missingByUse(installed).review).toEqual([]);
	});

	test("a fresh install without the data repo reports every entry", () => {
		const missing = missingRequired({ skills: [], rules: [] });
		expect(missing.map((m) => m.name)).toEqual([
			"security-audit",
			"codeguard",
			"codebase-design",
			"ponytail-audit",
			"ui-ux-check",
			"diff-security-review",
			"explain-project",
			"check-ottr-board",
			"retro",
		]);
	});

	test("aliases satisfy an entry: harness stands in for security-audit", () => {
		const installed = {
			skills: ["security-audit-harness"],
			rules: ["codeguard-0-logging.md"],
		};
		const names = missingRequired(installed).map((m) => m.name);
		expect(names).not.toContain("security-audit");
		expect(names).not.toContain("codeguard");
	});

	test("the ponytail upstream folder satisfies ponytail-audit", () => {
		const installed = { skills: ["ponytail"], rules: [] };
		const names = missingRequired(installed).map((m) => m.name);
		expect(names).not.toContain("ponytail-audit");
	});

	test("rules without a codeguard file keep the codeguard gap", () => {
		const installed = { skills: [], rules: ["spec-first.md"] };
		expect(missingRequired(installed).map((m) => m.name)).toContain(
			"codeguard",
		);
	});

	test("missing entries group by the control that needs them", () => {
		const groups = missingByUse({ skills: [], rules: [] });
		expect(groups.review).toEqual([
			"security-audit",
			"codeguard",
			"codebase-design",
			"ponytail-audit",
			"ui-ux-check",
		]);
		expect(groups.merge).toEqual(["diff-security-review"]);
		expect(groups.diagrams).toEqual(["explain-project"]);
		expect(groups["board-check"]).toEqual(["check-ottr-board"]);
		expect(groups.retro).toEqual(["retro"]);
	});
});

describe("REQUIRED_SKILLS", () => {
	test("shipped entries carry this repo as their source", () => {
		for (const entry of REQUIRED_SKILLS.filter((e) => e.shipped))
			expect(entry.source).toContain("(this repo");
	});

	test("every this-repo source path exists in the repo tree", () => {
		for (const entry of REQUIRED_SKILLS.filter((e) => e.shipped)) {
			const path = entry.source.slice(0, entry.source.indexOf(" ("));
			// The README names .agents/skills/<name>; a bare skills/<name> is stale.
			expect(path.startsWith(".agents/skills/")).toBe(true);
			expect(existsSync(join(import.meta.dir, "..", path, "SKILL.md"))).toBe(
				true,
			);
		}
	});

	test("unshipped entries name where the text lives", () => {
		for (const entry of REQUIRED_SKILLS.filter((e) => !e.shipped))
			expect(entry.source.length).toBeGreaterThan(0);
	});
});
