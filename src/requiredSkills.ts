/** The skills and rules the board's prompts name (fix list #45). A prompt that names
 * one must stop with needs_you when its runner lacks it; the board compares each
 * worker's installed list with this set and shows the missing entries in
 * Settings → Alate and on the buttons whose prompts need them. */

/** Which prompt or button needs the entry; the UI maps these to the controls. */
export type SkillUse =
	| "review"
	| "merge"
	| "diagrams"
	| "board-check"
	| "retro";

export interface RequiredSkill {
	/** Skill folder name in an agent home; kind "rules" matches a rule-file prefix. */
	name: string;
	kind: "skill" | "rules";
	/** Which prompt or button names it. */
	usedBy: SkillUse;
	/** True when this repo ships the text under skills/<name>/. */
	shipped: boolean;
	/** Public repo that holds the text, or "private data repo" when none is public. */
	source: string;
	/** Other folder names that satisfy the entry (substitute skills, upstream naming). */
	aliases?: string[];
}

export const REQUIRED_SKILLS: RequiredSkill[] = [
	{
		name: "security-audit",
		kind: "skill",
		usedBy: "review",
		shipped: false,
		source: "cloudflare/security-audit-skill",
		// Ottr's AGENTS.md substitutes its security-audit-harness skill.
		aliases: ["security-audit-harness"],
	},
	{
		name: "codeguard",
		kind: "rules",
		usedBy: "review",
		shipped: false,
		source: "cosai-oasis/project-codeguard",
	},
	{
		name: "codebase-design",
		kind: "skill",
		usedBy: "review",
		shipped: false,
		source: "mattpocock/skills",
	},
	{
		name: "ponytail-audit",
		kind: "skill",
		usedBy: "review",
		shipped: false,
		source: "DietrichGebert/ponytail",
		// The prompt says "ponytail-audit"; the upstream skill installs as "ponytail".
		aliases: ["ponytail"],
	},
	{
		name: "ui-ux-check",
		kind: "skill",
		usedBy: "review",
		shipped: true,
		source: "skills/ui-ux-check (this repo)",
	},
	{
		name: "diff-security-review",
		kind: "skill",
		usedBy: "merge",
		shipped: true,
		source:
			"skills/diff-security-review (this repo; ported from anthropics/claude-code-security-review, MIT)",
	},
	{
		name: "explain-project",
		kind: "skill",
		usedBy: "diagrams",
		shipped: true,
		source: "skills/explain-project (this repo)",
	},
	{
		name: "check-ottr-board",
		kind: "skill",
		usedBy: "board-check",
		shipped: true,
		source: "skills/check-ottr-board (this repo)",
	},
	{
		name: "retro",
		kind: "skill",
		usedBy: "retro",
		shipped: false,
		source: "private data repo",
	},
];

/** The entries a worker home lacks: a skill is present when an installed folder
 * equals its name or one of its aliases; the rules entry is present when an
 * installed rule file name starts with its name. */
export function missingRequired(installed: {
	skills: string[];
	rules: string[];
}): RequiredSkill[] {
	return REQUIRED_SKILLS.filter((entry) => {
		if (entry.kind === "rules")
			return !installed.rules.some((r) => r.startsWith(`${entry.name}-`));
		const names = [entry.name, ...(entry.aliases ?? [])];
		return !installed.skills.some((s) => names.includes(s));
	});
}

/** Missing entries grouped by the control that needs them, so a button can name
 * its own gaps. Controls with no button (merge, retro) surface in Settings only. */
export function missingByUse(installed: {
	skills: string[];
	rules: string[];
}): Record<SkillUse, string[]> {
	const groups: Record<SkillUse, string[]> = {
		review: [],
		merge: [],
		diagrams: [],
		"board-check": [],
		retro: [],
	};
	for (const entry of missingRequired(installed))
		groups[entry.usedBy].push(entry.name);
	return groups;
}
