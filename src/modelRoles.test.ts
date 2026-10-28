import { describe, expect, test } from "bun:test";
import {
	commitMessage,
	editModelRoles,
	RolesLayoutError,
	readRoles,
	validateRoles,
} from "./modelRoles.ts";

// Shaped like the data repo's user/omp/agent/config.yml: other keys before and after the block,
// nested maps and lists, comments in and outside the block, a quoted value, a trailing comment.
const CONFIG = `# omp agent config
theme: dark
providers:
  zai:
    baseUrl: https://api.z.ai/v1
    models: [glm-5.3-flash, glm-5.3]
modelRoles:
  default: zai/glm-5.3-flash:max
  # the planner
  slow: "anthropic/claude-opus-5-5:medium"
  smol: 'zai/glm-5.3-flash'  # cheap one

  commit: zai/glm-5.3-flash
# after the block
extensions:
  - ./check.yml
  - name: memory
    enabled: false
`;

const lines = (text: string) => text.split("\n");

describe("readRoles", () => {
	test("keeps the file order and skips empty values", () => {
		const text = CONFIG.replace("  commit:", "  x2: ''\n  commit:");
		expect(Object.entries(readRoles(text))).toEqual([
			["default", "zai/glm-5.3-flash:max"],
			["slow", "anthropic/claude-opus-5-5:medium"],
			["smol", "zai/glm-5.3-flash"],
			["commit", "zai/glm-5.3-flash"],
		]);
	});
});

describe("editModelRoles", () => {
	test("a changed value replaces only its own value text", () => {
		const roles = readRoles(CONFIG);
		const out = editModelRoles(CONFIG, {
			...roles,
			default: "anthropic/claude-opus-5-5",
			smol: "zai/glm-5.3",
		});
		const want = lines(CONFIG);
		want[7] = "  default: anthropic/claude-opus-5-5";
		want[10] = "  smol: zai/glm-5.3  # cheap one";
		expect(lines(out)).toEqual(want);
	});

	test("unchanged roles keep the text byte for byte", () => {
		expect(editModelRoles(CONFIG, readRoles(CONFIG))).toBe(CONFIG);
	});

	test("a removed role loses its line; a new role follows the last entry", () => {
		const { slow: _, ...rest } = readRoles(CONFIG);
		const out = editModelRoles(CONFIG, { ...rest, plan: "zai/glm 5" });
		const want = lines(CONFIG);
		want.splice(13, 0, '  plan: "zai/glm 5"');
		want.splice(9, 1);
		expect(lines(out)).toEqual(want);
	});

	test("CRLF files keep CRLF, also on an added line", () => {
		const crlf = "a: 1\r\nmodelRoles:\r\n    default: x/y\r\nb: 2\r\n";
		expect(editModelRoles(crlf, { default: "x/y", plan: "p/q:max" })).toBe(
			"a: 1\r\nmodelRoles:\r\n    default: x/y\r\n    plan: p/q:max\r\nb: 2\r\n",
		);
	});

	test("a file without the key gets a block at the end", () => {
		expect(editModelRoles("a: 1\n", { default: "x/y" })).toBe(
			"a: 1\nmodelRoles:\n  default: x/y\n",
		);
		expect(editModelRoles("a: 1", { default: "x/y" })).toBe(
			"a: 1\nmodelRoles:\n  default: x/y",
		);
	});

	test.each([
		["a flow map", "modelRoles: {default: x/y}\n"],
		["a nested key", "modelRoles:\n  default:\n    model: x/y\n"],
		["mixed indents", "modelRoles:\n  default: x/y\n   slow: a/b\n"],
		["a multi-line value", "modelRoles:\n  default: >\n    x/y\n"],
		["an anchor", "modelRoles: &r\n  default: x/y\n"],
		["a flow-style document", "{modelRoles: {default: x/y}}\n"],
	])("%s is refused", (_, text) => {
		expect(() => editModelRoles(text, { default: "a/b" })).toThrow(
			RolesLayoutError,
		);
		expect(() => readRoles(text)).toThrow(RolesLayoutError);
	});
});

describe("validateRoles", () => {
	const catalog = new Set(["zai/glm-5.3-flash", "anthropic/claude-opus-5-5"]);
	const current = { default: "gone/model:max" };

	test("refuses an unknown model, an unknown level and a bad name", () => {
		expect(
			validateRoles(
				{
					default: "gone/model:max",
					slow: "nope/model",
					smol: "zai/glm-5.3-flash:turbo",
					"9bad": "zai/glm-5.3-flash",
				},
				current,
				catalog,
			),
		).toEqual({
			error: "some model roles are not valid",
			fields: {
				slow: "unknown model nope/model",
				smol: "unknown thinking level (use one of off, minimal, low, medium, high, xhigh, max, auto)",
				"9bad":
					"a role name starts with a letter and holds only letters, digits, _ and - (max 64)",
			},
		});
	});

	test("accepts catalog selectors with a level; an unchanged unknown value passes", () => {
		expect(
			validateRoles(
				{ default: "gone/model:max", slow: "anthropic/claude-opus-5-5:medium" },
				current,
				catalog,
			),
		).toBeNull();
	});

	test("an empty map and an unchanged map are refused", () => {
		expect(validateRoles({}, current, catalog)?.error).toBe(
			"roles must hold at least one role",
		);
		expect(validateRoles({ ...current }, current, catalog)?.error).toBe(
			"nothing to save",
		);
	});
	test("a __proto__ role name is refused, not dropped", () => {
		const next = JSON.parse(
			'{"default":"gone/model:max","__proto__":"nope/model"}',
		) as Record<string, unknown>;
		expect(validateRoles(next, current, catalog)?.fields).toHaveProperty(
			"__proto__",
		);
	});
});

describe("commitMessage", () => {
	const cur = { default: "a/b", slow: "c/d" };
	test("one set, one removal, many", () => {
		expect(commitMessage(cur, { ...cur, default: "e/f:max" })).toBe(
			"chore: set the default model role to e/f:max",
		);
		expect(commitMessage(cur, { ...cur, plan: "e/f" })).toBe(
			"chore: set the plan model role to e/f",
		);
		expect(commitMessage(cur, { default: "a/b" })).toBe(
			"chore: remove the slow model role",
		);
		expect(commitMessage(cur, { default: "x/y", plan: "e/f" })).toBe(
			"chore: update the default, plan, slow model roles",
		);
	});
	test("a long list ends in … within 500 characters", () => {
		const next = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [
				`role${i}${"x".repeat(20)}`,
				"a/b",
			]),
		);
		const msg = commitMessage({}, next);
		expect(msg.length).toBeLessThanOrEqual(500);
		expect(msg).toEndWith(", … model roles");
	});
});
