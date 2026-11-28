import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
	commitMessage,
	editModelRoles,
	type Fallbacks,
	RolesLayoutError,
	readFallbacks,
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

// The real retry block of the data repo: chains keyed by role and by exact model, a comment,
// other retry keys before and after fallbackChains, a top-level key after the block.
const REAL = `modelRoles:
  default: zai/glm-5.3-flash:max
  plan: anthropic/claude-opus-5-5:high
  judge: zai/glm-5.3
  smol: zai/glm-5.3-flash
retry:
  maxRetries: 3
  fallbackChains:
    plan:
      - openai-codex/gpt-6.1-sol
    judge:
      - typesafe/jev-preview
    # Exact-model key comment
    openai-codex/gpt-6.1-sol:
      - zai/glm-5.3:max
  # after the chains
  baseDelayMs: 2000
cycleOrder:
  - smol
`;
const SELECTOR_KEY = "openai-codex/gpt-6.1-sol";
const SELECTOR_BLOCK = `    # Exact-model key comment
    openai-codex/gpt-6.1-sol:
      - zai/glm-5.3:max
`;
const ROLES = readRoles(REAL);
const FB = readFallbacks(REAL);

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
		const out = editModelRoles(
			CONFIG,
			{ ...roles, default: "anthropic/claude-opus-5-5", smol: "zai/glm-5.3" },
			{},
		);
		const want = lines(CONFIG);
		want[7] = "  default: anthropic/claude-opus-5-5";
		want[10] = "  smol: zai/glm-5.3  # cheap one";
		expect(lines(out)).toEqual(want);
	});

	test("unchanged roles keep the text byte for byte", () => {
		expect(editModelRoles(CONFIG, readRoles(CONFIG), {})).toBe(CONFIG);
	});

	test("a removed role loses its line; a new role follows the last entry", () => {
		const { slow: _, ...rest } = readRoles(CONFIG);
		const out = editModelRoles(CONFIG, { ...rest, plan: "zai/glm 5" }, {});
		const want = lines(CONFIG);
		want.splice(13, 0, '  plan: "zai/glm 5"');
		want.splice(9, 1);
		expect(lines(out)).toEqual(want);
	});

	test("CRLF files keep CRLF, also on an added line", () => {
		const crlf = "a: 1\r\nmodelRoles:\r\n    default: x/y\r\nb: 2\r\n";
		expect(editModelRoles(crlf, { default: "x/y", plan: "p/q:max" }, {})).toBe(
			"a: 1\r\nmodelRoles:\r\n    default: x/y\r\n    plan: p/q:max\r\nb: 2\r\n",
		);
	});

	test("a file without the key gets a block at the end", () => {
		expect(editModelRoles("a: 1\n", { default: "x/y" }, {})).toBe(
			"a: 1\nmodelRoles:\n  default: x/y\n",
		);
		expect(editModelRoles("a: 1", { default: "x/y" }, {})).toBe(
			"a: 1\nmodelRoles:\n  default: x/y",
		);
	});

	test("a file without a final newline keeps it open after its last line goes", () => {
		const open = "a: 1\nmodelRoles:\n  default: x/y\n  slow: a/b";
		expect(editModelRoles(open, { default: "x/y" }, {})).toBe(
			"a: 1\nmodelRoles:\n  default: x/y",
		);
		const crlf = "modelRoles:\r\n  default: x/y\r\n  slow: a/b";
		expect(editModelRoles(crlf, { default: "x/y" }, {})).toBe(
			"modelRoles:\r\n  default: x/y",
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
		expect(() => editModelRoles(text, { default: "a/b" }, {})).toThrow(
			RolesLayoutError,
		);
		expect(() => readRoles(text)).toThrow(RolesLayoutError);
	});
});

describe("fallback chains", () => {
	test("readFallbacks keeps the file order, also for model keys", () => {
		expect(Object.entries(FB)).toEqual([
			["plan", ["openai-codex/gpt-6.1-sol"]],
			["judge", ["typesafe/jev-preview"]],
			[SELECTOR_KEY, ["zai/glm-5.3:max"]],
		]);
		expect(readFallbacks(CONFIG)).toEqual({});
	});

	test("unchanged roles and chains keep the text byte for byte", () => {
		expect(editModelRoles(REAL, ROLES, FB)).toBe(REAL);
		const out = editModelRoles(REAL, { ...ROLES, default: "zai/glm-5.3" }, FB);
		const want = lines(REAL);
		want[1] = "  default: zai/glm-5.3";
		expect(lines(out)).toEqual(want);
	});

	test("a changed chain replaces only its item lines", () => {
		const out = editModelRoles(REAL, ROLES, {
			...FB,
			plan: ["zai/glm-5.3", "typesafe/jev-preview:high"],
		});
		const want = lines(REAL);
		want.splice(
			9,
			1,
			"      - zai/glm-5.3",
			"      - typesafe/jev-preview:high",
		);
		expect(lines(out)).toEqual(want);
		expect(out).toContain(SELECTOR_BLOCK);
	});

	test("a new chain follows the last chain, before the comment of the next retry key", () => {
		const out = editModelRoles(REAL, ROLES, { ...FB, smol: ["zai/glm-5.3"] });
		const want = lines(REAL);
		want.splice(15, 0, "    smol:", "      - zai/glm-5.3");
		expect(lines(out)).toEqual(want);
		expect(readFallbacks(out).smol).toEqual(["zai/glm-5.3"]);
	});

	test("a removed chain loses its key and items; the model key and its comment stay", () => {
		const { judge: _, ...rest } = FB;
		const want = lines(REAL);
		want.splice(10, 2);
		expect(lines(editModelRoles(REAL, ROLES, rest))).toEqual(want);
	});

	test("a removed role loses its chain", () => {
		const { judge: _r, ...roles } = ROLES;
		const { judge: _f, ...chains } = FB;
		const want = lines(REAL);
		want.splice(10, 2);
		want.splice(3, 1);
		expect(lines(editModelRoles(REAL, roles, chains))).toEqual(want);
	});

	test("the bare real-world shape: only the managed chain changes", () => {
		const shape = `retry:
  fallbackChains:
    plan:
      - openai-codex/gpt-6.1-sol
    judge:
      - typesafe/jev-preview
    # Exact-model key comment
    openai-codex/gpt-6.1-sol:
      - zai/glm-5.3:max
cycleOrder:
  - smol
`;
		const out = editModelRoles(
			shape,
			{ plan: "zai/glm-5.3" },
			{ ...readFallbacks(shape), plan: ["zai/glm-5.3:max"] },
		);
		expect(out).toBe(
			`${shape.replace("      - openai-codex/gpt-6.1-sol\n", "      - zai/glm-5.3:max\n")}modelRoles:\n  plan: zai/glm-5.3\n`,
		);
	});

	test("an empty list is written key: [] and reads back as []", () => {
		const out = editModelRoles(REAL, ROLES, { ...FB, plan: [] });
		const want = lines(REAL);
		want.splice(8, 2, "    plan: []");
		expect(lines(out)).toEqual(want);
		expect(readFallbacks(out).plan).toEqual([]);
		expect(editModelRoles(out, ROLES, readFallbacks(out))).toBe(out);
		const back = lines(REAL);
		back[9] = "      - zai/glm-5.3";
		expect(
			lines(editModelRoles(out, ROLES, { ...FB, plan: ["zai/glm-5.3"] })),
		).toEqual(back);
	});

	test("CRLF files keep CRLF on new chain lines", () => {
		const crlf = REAL.replaceAll("\n", "\r\n");
		const want = lines(REAL);
		want.splice(15, 0, "    smol:", "      - zai/glm-5.3");
		expect(
			editModelRoles(crlf, readRoles(crlf), {
				...readFallbacks(crlf),
				smol: ["zai/glm-5.3"],
			}),
		).toBe(want.join("\n").replaceAll("\n", "\r\n"));
	});

	test("a file without retry gets a retry block at the end", () => {
		const text = "modelRoles:\n  default: x/y\n";
		expect(
			editModelRoles(text, { default: "x/y" }, { default: ["a/b", "c/d:max"] }),
		).toBe(
			`${text}retry:\n  fallbackChains:\n    default:\n      - a/b\n      - c/d:max\n`,
		);
		expect(
			editModelRoles(text.trimEnd(), { default: "x/y" }, { default: [] }),
		).toBe(`${text}retry:\n  fallbackChains:\n    default: []`);
	});

	test("a retry block without fallbackChains gets it after its last key", () => {
		const text =
			"modelRoles:\n  default: x/y\nretry:\n    maxRetries: 3  # keep\n\n# next\nb: 1\n";
		expect(editModelRoles(text, { default: "x/y" }, { default: ["a/b"] })).toBe(
			"modelRoles:\n  default: x/y\nretry:\n    maxRetries: 3  # keep\n    fallbackChains:\n      default:\n        - a/b\n\n# next\nb: 1\n",
		);
		expect(
			editModelRoles(
				"retry:\nb: 1\n",
				{ default: "x/y" },
				{ default: ["a/b"] },
			),
		).toBe(
			"retry:\n  fallbackChains:\n    default:\n      - a/b\nb: 1\nmodelRoles:\n  default: x/y\n",
		);
	});

	test("a block that loses its last key keeps the fallbackChains line", () => {
		const text =
			"modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n    default:\n      - a/b\n";
		const out = editModelRoles(text, { default: "x/y" }, {});
		expect(out).toBe(
			"modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n",
		);
		expect(readFallbacks(out)).toEqual({});
		expect(editModelRoles(out, { default: "x/y" }, { default: ["c/d"] })).toBe(
			`${out}    default:\n      - c/d\n`,
		);
	});

	test("items at the key indent, quoted items and comments", () => {
		const text = `modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n    default:  # mine\n    - "a/b"  # first\n    - 'c/d:max'\n`;
		expect(readFallbacks(text)).toEqual({ default: ["a/b", "c/d:max"] });
		expect(editModelRoles(text, { default: "x/y" }, readFallbacks(text))).toBe(
			text,
		);
		const head = "modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n";
		expect(editModelRoles(text, { default: "x/y" }, { default: ["e/f"] })).toBe(
			`${head}    default:  # mine\n    - e/f\n`,
		);
		expect(editModelRoles(text, { default: "x/y" }, { default: [] })).toBe(
			`${head}    default: []  # mine\n`,
		);
	});

	test("[] with a comment becomes a block list", () => {
		const text =
			"modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n    default: [] # c\n";
		expect(readFallbacks(text)).toEqual({ default: [] });
		expect(
			editModelRoles(text, { default: "x/y" }, { default: ["a/b", "c d"] }),
		).toBe(
			'modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n    default: # c\n      - a/b\n      - "c d"\n',
		);
	});

	test("a managed key without items reads as no chain and takes new items", () => {
		const text =
			"modelRoles:\n  default: x/y\nretry:\n  fallbackChains:\n    default:\n";
		expect(readFallbacks(text)).toEqual({});
		expect(editModelRoles(text, { default: "x/y" }, { default: ["a/b"] })).toBe(
			`${text}      - a/b\n`,
		);
	});

	test("unmanaged keys keep any layout byte for byte", () => {
		const text = `modelRoles:
  default: x/y
retry:
  fallbackChains:
    x/y: [a/b, c/d]  # flow
    'q/r':
      nested: 1
    default:
      - a/b
`;
		expect(readFallbacks(text)).toEqual({
			"x/y": ["a/b", "c/d"],
			default: ["a/b"],
		});
		expect(
			editModelRoles(
				text,
				{ default: "x/y" },
				{
					...readFallbacks(text),
					default: ["e/f"],
				},
			),
		).toBe(text.replace("      - a/b\n", "      - e/f\n"));
	});

	const M = "modelRoles:\n  default: x/y\n";
	test.each([
		[
			"a managed flow list with entries",
			`${M}retry:\n  fallbackChains:\n    default: [a/b]\n`,
		],
		[
			"a flow map for fallbackChains",
			`${M}retry:\n  fallbackChains: {default: [a/b]}\n`,
		],
		["a flow map for retry", `${M}retry: {fallbackChains: {}}\n`],
		[
			"an anchor on fallbackChains",
			`${M}retry:\n  fallbackChains: &c\n    default:\n      - a/b\n`,
		],
		[
			"an anchor on a managed chain",
			`${M}retry:\n  fallbackChains:\n    default: &l\n      - a/b\n`,
		],
		[
			"a multi-line item",
			`${M}retry:\n  fallbackChains:\n    default:\n      - a/b\n        c/d\n`,
		],
		[
			"a nested managed item",
			`${M}retry:\n  fallbackChains:\n    default:\n      - model: a/b\n`,
		],
		[
			"two fallbackChains keys",
			`${M}retry:\n  fallbackChains:\n    default:\n      - a/b\n  fallbackChains:\n    x/y: []\n`,
		],
		[
			"a quoted fallbackChains key",
			`${M}retry:\n  "fallbackChains":\n    default: []\n`,
		],
		["a flow-style retry document", "{retry: {fallbackChains: {}}}\n"],
	])("%s is refused", (_, text) => {
		expect(() => readFallbacks(text)).toThrow(RolesLayoutError);
		expect(() => editModelRoles(text, { default: "x/y" }, {})).toThrow(
			RolesLayoutError,
		);
	});

	test("random chains land on the managed keys and leave the rest alone", () => {
		const selectors = [
			"zai/glm-5.3",
			"zai/glm-5.3:max",
			"typesafe/jev-preview",
			"openai-codex/gpt-6.1-sol",
		];
		const chain = fc.uniqueArray(fc.constantFrom(...selectors), {
			maxLength: 3,
		});
		const head = REAL.slice(0, REAL.indexOf("retry:"));
		const tail =
			"  # after the chains\n  baseDelayMs: 2000\ncycleOrder:\n  - smol\n";
		const prop = fc.property(
			fc.record(
				{ default: chain, plan: chain, judge: chain, smol: chain },
				{ requiredKeys: [] },
			),
			(req) => {
				const want: Fallbacks = { [SELECTOR_KEY]: FB[SELECTOR_KEY]!, ...req };
				const out = editModelRoles(REAL, ROLES, want);
				const got = readFallbacks(out);
				for (const role of Object.keys(ROLES)) {
					expect(Object.hasOwn(got, role)).toBe(Object.hasOwn(want, role));
					expect(got[role]).toEqual(want[role]);
				}
				expect(got[SELECTOR_KEY]).toEqual(FB[SELECTOR_KEY]);
				expect(out).toStartWith(`${head}retry:\n  maxRetries: 3\n`);
				expect(out).toContain(SELECTOR_BLOCK);
				expect(out).toEndWith(tail);
				expect(editModelRoles(out, ROLES, want)).toBe(out);
			},
		);
		fc.assert(prop, { seed: 42, numRuns: 150 });
	});

	test("nonrole chain edits and removals affect only their own lines", () => {
		const out = editModelRoles(REAL, ROLES, {
			...FB,
			[SELECTOR_KEY]: ["typesafe/jev-preview"],
			"new/model": ["zai/glm-5.3"],
		});
		expect(out).toBe(
			REAL.replace(
				"      - zai/glm-5.3:max\n",
				"      - typesafe/jev-preview\n",
			).replace(
				"  # after the chains\n",
				'    "new/model":\n      - zai/glm-5.3\n  # after the chains\n',
			),
		);
		const flow = REAL.replace(
			"    openai-codex/gpt-6.1-sol:\n      - zai/glm-5.3:max\n",
			'    "openai-codex/gpt-6.1-sol": ["gone/model:max"] # keep\n',
		);
		const { [SELECTOR_KEY]: _, ...rest } = readFallbacks(flow);
		expect(editModelRoles(flow, ROLES, rest)).toBe(
			flow.replace(
				'    "openai-codex/gpt-6.1-sol": ["gone/model:max"] # keep\n',
				"",
			),
		);
	});

	test("role edits preserve nonrole YAML bytes across quotes, comments and line ends", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("plain", "single", "double"),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(quote, flow, crlf, finalNewline) => {
					const scalar = (s: string) =>
						quote === "single"
							? `'${s}'`
							: quote === "double"
								? JSON.stringify(s)
								: s;
					let text = REAL.replace("  judge: zai/glm-5.3\n", "")
						.replace(
							"    judge:\n      - typesafe/jev-preview\n",
							`    ${scalar("judge")}: # keep judge\n      - ${scalar("gone/judge:max")} # keep item\n`,
						)
						.replace(
							"    openai-codex/gpt-6.1-sol:\n      - zai/glm-5.3:max\n",
							flow
								? `    ${scalar(SELECTOR_KEY)}: [${scalar("gone/model:max")}] # keep flow\n`
								: `    ${scalar(SELECTOR_KEY)}: # keep model\n      - ${scalar("gone/model:max")} # keep item\n`,
						);
					if (!finalNewline) text = text.slice(0, -1);
					if (crlf) text = text.replaceAll("\n", "\r\n");
					const out = editModelRoles(
						text,
						{ ...readRoles(text), default: "zai/glm-5.3" },
						readFallbacks(text),
					);
					expect(out).toBe(
						text.replace(
							"  default: zai/glm-5.3-flash:max",
							"  default: zai/glm-5.3",
						),
					);
				},
			),
			{ seed: 1349, numRuns: 150 },
		);
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
				{},
				{},
			),
		).toEqual({
			error: "some model roles are not valid",
			fields: {
				default: "unknown model gone/model",
				slow: "unknown model nope/model",
				smol: "unknown thinking level (use one of off, minimal, low, medium, high, xhigh, max, auto)",
				"9bad":
					"a role name starts with a letter and holds only letters, digits, _ and - (max 64)",
			},
			fallbackFields: {},
		});
	});

	test("accepts catalog selectors with a level", () => {
		expect(
			validateRoles(
				{
					default: "zai/glm-5.3-flash",
					slow: "anthropic/claude-opus-5-5:medium",
				},
				current,
				catalog,
				{ default: ["anthropic/claude-opus-5-5:high"] },
				{},
			),
		).toBeNull();
	});

	test("an unchanged unknown model or level is refused too", () => {
		const old = { default: "gone/model:max", smol: "zai/glm-5.3-flash:turbo" };
		expect(
			validateRoles(
				{ ...old, slow: "anthropic/claude-opus-5-5" },
				old,
				catalog,
				{},
				{},
			)?.fields,
		).toEqual({
			default: "unknown model gone/model",
			smol: "unknown thinking level (use one of off, minimal, low, medium, high, xhigh, max, auto)",
		});
	});

	test("an empty map and an unchanged map are refused", () => {
		expect(validateRoles({}, current, catalog, {}, {})?.error).toBe(
			"roles must hold at least one role",
		);
		const ok = { default: "zai/glm-5.3-flash" };
		expect(validateRoles({ ...ok }, ok, catalog, {}, {})?.error).toBe(
			"nothing to save",
		);
	});

	test("a __proto__ role name is refused, not dropped", () => {
		const next = JSON.parse(
			'{"default":"gone/model:max","__proto__":"nope/model"}',
		) as Record<string, unknown>;
		expect(
			validateRoles(next, current, catalog, {}, {})?.fields,
		).toHaveProperty("__proto__");
	});

	describe("fallbacks", () => {
		const ok = { default: "zai/glm-5.3-flash" };
		const check = (fallbacks: unknown) =>
			validateRoles(ok, ok, catalog, fallbacks as Record<string, unknown>, {});
		const level =
			"unknown thinking level (use one of off, minimal, low, medium, high, xhigh, max, auto)";

		test.each([
			[
				["anthropic/claude-opus-5-5:high", "x/y"],
				"fallback 2: unknown model x/y",
			],
			[["zai/glm-5.3-flash:turbo"], `fallback 1: ${level}`],
			[[""], "fallback 1: the value must be a model selector"],
			[
				["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"],
				"fallback 2: a duplicate of fallback 1",
			],
			[
				["anthropic/claude-opus-5-5", "zai/glm-5.3-flash"],
				"fallback 2: the role's own value",
			],
			["anthropic/claude-opus-5-5", "the fallbacks must be a list"],
		])("%p is refused with %p", (chain, message) => {
			expect(check({ default: chain })).toEqual({
				error: "some model roles are not valid",
				fields: {},
				fallbackFields: { default: message },
			});
		});

		test("an unknown bare key is refused, also __proto__", () => {
			expect(check({ plan: [] })?.fallbackFields).toEqual({
				plan: "this key is not a known role or model",
			});
			expect(
				check(JSON.parse('{"__proto__":[]}'))?.fallbackFields,
			).toHaveProperty("__proto__", "this key is not a known role or model");
		});

		test("a value that is not an object is refused", () => {
			expect(check([])?.error).toBe("fallbacks must be an object");
			expect(check("a/b")?.error).toBe("fallbacks must be an object");
			expect(check(null)?.error).toBe("fallbacks must be an object");
		});

		test("a changed chain is something to save; absent and [] differ", () => {
			const chain = ["anthropic/claude-opus-5-5"];
			const save = (next: Fallbacks, cur: Fallbacks) =>
				validateRoles(ok, ok, catalog, next, cur);
			expect(save({ default: chain }, { default: chain })?.error).toBe(
				"nothing to save",
			);
			expect(save({ default: [] }, {})).toBeNull();
			expect(save({}, { default: [] })).toBeNull();
			expect(save({ default: chain }, { default: [] })).toBeNull();
		});

		test("known unlisted roles and model keys accept edited lists", () => {
			expect(
				validateRoles(
					ok,
					ok,
					catalog,
					{ judge: ["anthropic/claude-opus-5-5"] },
					{ judge: [] },
				),
			).toBeNull();
			expect(check({ "new/model": ["anthropic/claude-opus-5-5"] })).toBeNull();
			expect(
				validateRoles(
					ok,
					{ ...ok, judge: "anthropic/claude-opus-5-5" },
					catalog,
					{ judge: [] },
					{},
				),
			).toBeNull();
		});

		test("unchanged nonrole chains allow stale selectors but role chains do not", () => {
			const chains = { judge: ["gone/model"], "gone/key": ["gone/fallback"] };
			expect(
				validateRoles(
					{ ...ok, slow: "anthropic/claude-opus-5-5" },
					ok,
					catalog,
					chains,
					chains,
				),
			).toBeNull();
			expect(validateRoles(ok, ok, catalog, chains, chains)?.error).toBe(
				"nothing to save",
			);
			expect(
				validateRoles(
					ok,
					ok,
					catalog,
					{ default: ["gone/model"] },
					{ default: ["gone/model"] },
				)?.fallbackFields,
			).toEqual({ default: "fallback 1: unknown model gone/model" });
			expect(
				validateRoles(ok, ok, catalog, { judge: ["gone/edited"] }, chains)
					?.fallbackFields,
			).toEqual({ judge: "fallback 1: unknown model gone/edited" });
		});

		test("model keys retain list, selector, duplicate and self checks", () => {
			for (const [key, chain, message] of [
				["/model", [], "this key is not a known role or model"],
				["provider/", [], "this key is not a known role or model"],
				["provider /model", [], "this key is not a known role or model"],
				["new/model", "x/y", "the fallbacks must be a list"],
				["new/model", ["gone/model"], "fallback 1: unknown model gone/model"],
				[
					"new/model",
					["anthropic/claude-opus-5-5:turbo"],
					`fallback 1: ${level}`,
				],
				[
					"new/model",
					["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"],
					"fallback 2: a duplicate of fallback 1",
				],
				[
					"anthropic/claude-opus-5-5",
					["anthropic/claude-opus-5-5"],
					"fallback 1: the role's own value",
				],
			] as const) {
				expect(check({ [key]: chain })?.fallbackFields).toEqual({
					[key]: message,
				});
			}
		});

		test("fallback key validation agrees with known names and a split-based model oracle", () => {
			const old = { ...ok, current_role: "anthropic/claude-opus-5-5" };
			const next = { ...ok, "requested-role": "anthropic/claude-opus-5-5" };
			const existing = { judge: ["gone/judge"] };
			const known = ["default", "current_role", "requested-role", "judge"];
			const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
			const key = fc.oneof(
				fc.string({ maxLength: 80 }),
				fc
					.tuple(fc.string({ maxLength: 8 }), fc.string({ maxLength: 12 }))
					.map(([provider, model]) => `${provider}/${model}`),
				fc.constantFrom(...known),
			);
			fc.assert(
				fc.property(key, (name) => {
					const [provider, ...model] = name.split("/");
					const modelKey =
						provider !== "" &&
						model.join("/") !== "" &&
						[...name].every((char) => char.trim() !== "");
					const roleKey =
						name.length > 0 &&
						name.length <= 64 &&
						letters.includes(name.charAt(0)) &&
						[...name].every((char) => `${letters}0123456789_-`.includes(char));
					const valid = known.includes(name) || modelKey;
					const validExisting = valid || roleKey;
					for (const [currentFallbacks, allowed] of [
						[existing, valid],
						[{ ...existing, [name]: [] }, validExisting],
					] as const) {
						const result = validateRoles(
							next,
							old,
							catalog,
							{ ...existing, [name]: [] },
							currentFallbacks,
						);
						if (allowed) expect(result).toBeNull();
						else
							expect(result?.fallbackFields).toEqual({
								[name]: "this key is not a known role or model",
							});
					}
					if (
						validExisting &&
						!Object.hasOwn(old, name) &&
						!Object.hasOwn(next, name)
					) {
						const unchanged = { ...existing, [name]: ["gone/model"] };
						expect(
							validateRoles(next, old, catalog, unchanged, unchanged),
						).toBeNull();
					}
				}),
				{
					seed: 1349,
					numRuns: 150,
					examples: [
						["judge"],
						["provider/model"],
						["default"],
						["current_role"],
						["requested-role"],
						["/model"],
						["provider/"],
						["provider /model"],
						["provider/model/submodel"],
						["__proto__"],
						["provider/model\n"],
						["provider/model\r"],
						["provider/model\u2028"],
						["provider/model\u2029"],
						["judge\n"],
						["judge\r"],
						["judge\u2028"],
						["judge\u2029"],
					],
				},
			);
		});

		test("nonrole-only changes and removals count as saves", () => {
			const chains = { judge: ["anthropic/claude-opus-5-5"], "old/model": [] };
			expect(validateRoles(ok, ok, catalog, {}, chains)).toBeNull();
			expect(
				validateRoles(ok, ok, catalog, { ...chains, "new/model": [] }, chains),
			).toBeNull();
			expect(
				validateRoles(ok, ok, catalog, { ...chains, judge: [] }, chains),
			).toBeNull();
			expect(validateRoles(ok, ok, catalog, { ...chains }, chains)?.error).toBe(
				"nothing to save",
			);
		});
	});
});

describe("commitMessage", () => {
	const cur = { default: "a/b", slow: "c/d" };
	test("one set, one removal, many", () => {
		expect(commitMessage(cur, { ...cur, default: "e/f:max" }, {}, {})).toBe(
			"chore: set the default model role to e/f:max",
		);
		expect(commitMessage(cur, { ...cur, plan: "e/f" }, {}, {})).toBe(
			"chore: set the plan model role to e/f",
		);
		expect(commitMessage(cur, { default: "a/b" }, {}, {})).toBe(
			"chore: remove the slow model role",
		);
		expect(commitMessage(cur, { default: "x/y", plan: "e/f" }, {}, {})).toBe(
			"chore: update the default, plan, slow model roles",
		);
	});
	test("a change of one chain names the chain", () => {
		expect(commitMessage(cur, cur, {}, { default: ["e/f", "g/h"] })).toBe(
			"chore: set the default model role fallbacks to e/f, g/h",
		);
		expect(commitMessage(cur, cur, {}, { default: [] })).toBe(
			"chore: set the default model role fallbacks to none",
		);
		expect(commitMessage(cur, cur, { default: ["e/f"] }, {})).toBe(
			"chore: remove the default model role fallbacks",
		);
	});
	test("a chain counts as a change of its role", () => {
		expect(
			commitMessage(cur, { ...cur, plan: "e/f" }, {}, { plan: ["a/b"] }),
		).toBe("chore: set the plan model role to e/f");
		expect(
			commitMessage(cur, { ...cur, default: "x/y" }, {}, { slow: ["a/b"] }),
		).toBe("chore: update the default, slow model roles");
		expect(commitMessage(cur, { default: "a/b" }, { slow: ["e/f"] }, {})).toBe(
			"chore: remove the slow model role",
		);
	});
	test("nonrole-only changes name their keys without hiding role removals", () => {
		expect(commitMessage(cur, cur, {}, { "new/model": ["e/f"] })).toBe(
			"chore: set the new/model model role fallbacks to e/f",
		);
		expect(commitMessage(cur, cur, { judge: ["e/f"] }, {})).toBe(
			"chore: remove the judge model role fallbacks",
		);
		expect(
			commitMessage(cur, cur, { "old/model": ["e/f"] }, { "old/model": [] }),
		).toBe("chore: set the old/model model role fallbacks to none");
		expect(
			commitMessage(cur, { default: "a/b" }, { slow: ["e/f"], judge: [] }, {}),
		).toBe("chore: update the judge, slow model roles");
	});
	test("a constructor chain removal uses only own role values", () => {
		const text = REAL.replace(
			"  # after the chains\n",
			"    constructor: []\n  # after the chains\n",
		);
		const current = readRoles(text);
		const next = JSON.parse(JSON.stringify(current)) as Record<string, string>;
		const before = readFallbacks(text);
		const { constructor: _, ...after } = before;
		expect(commitMessage(current, next, before, after)).toBe(
			"chore: remove the constructor model role fallbacks",
		);
	});
	test("an unchanged constructor chain does not enter a role change message", () => {
		const text = REAL.replace(
			"  # after the chains\n",
			"    constructor: []\n  # after the chains\n",
		);
		const current = readRoles(text);
		const next = JSON.parse(
			JSON.stringify({ ...current, default: "zai/glm-5.3" }),
		) as Record<string, string>;
		const fallbacks = readFallbacks(text);
		expect(commitMessage(current, next, fallbacks, fallbacks)).toBe(
			"chore: set the default model role to zai/glm-5.3",
		);
	});
	test("a long list ends in … within 500 characters", () => {
		const next = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [
				`role${i}${"x".repeat(20)}`,
				"a/b",
			]),
		);
		const msg = commitMessage({}, next, {}, {});
		expect(msg.length).toBeLessThanOrEqual(500);
		expect(msg).toEndWith(", … model roles");
	});
});
