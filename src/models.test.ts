import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFallbacks, modelRoles } from "./models.ts";

const dir = join(tmpdir(), `ottr-modelroles-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function config(body: string): string {
	const p = join(dir, `${Math.random().toString(36).slice(2)}.yml`);
	writeFileSync(p, body);
	return p;
}

describe("modelRoles", () => {
	test("parses every role, keeping thinking suffixes, stripping quotes", () => {
		expect(
			modelRoles(
				config(`modelRoles:
  default: zai/glm-5.3-flash:max
  smol: "openai-codex/gpt-6-luna"
  slow: anthropic/claude-opus-5-5:low
  empty:

cycleOrder:
  - smol
`),
			),
		).toEqual({
			default: "zai/glm-5.3-flash:max",
			smol: "openai-codex/gpt-6-luna",
			slow: "anthropic/claude-opus-5-5:low",
		});
	});

	test("stops at the dedent and skips comments", () => {
		expect(
			modelRoles(
				config(`# config
modelRoles:
  # a comment
  tiny: a/b

  smol: c/d
other:
  x: y
`),
			),
		).toEqual({ tiny: "a/b", smol: "c/d" });
	});

	test("parses inline comments and flow maps like real YAML", () => {
		expect(
			modelRoles(
				config(`modelRoles:
  default: zai/glm-5.3-flash:max  # daily driver
  smol: "a/b" # cheap
other: {x: "y"}
`),
			),
		).toEqual({ default: "zai/glm-5.3-flash:max", smol: "a/b" });
		expect(
			modelRoles(config("modelRoles: {default: a/b, smol: c/d}\n")),
		).toEqual({
			default: "a/b",
			smol: "c/d",
		});
	});

	test("keeps only nonempty string values", () => {
		expect(
			modelRoles(config('modelRoles: {n: 120, b: true, e: "", k: v}\n')),
		).toEqual({ k: "v" });
	});

	test("returns {} for a missing file, missing block, or empty model", () => {
		expect(modelRoles(join(dir, "missing.yml"))).toEqual({});
		expect(modelRoles(config("symbolPreset: unicode\n"))).toEqual({});
		expect(modelRoles(config("modelRoles:\n  tiny:\n"))).toEqual({});
	});
});

describe("modelFallbacks", () => {
	test("parses string lists in file order and drops other values", () => {
		const chains = modelFallbacks(
			config(`retry:
  fallbackChains:
    plan:
      - openai-codex/gpt-6.1-sol
    none: []
    # Exact-model key comment
    openai-codex/gpt-6.1-sol:
      - zai/glm-5.3:max
    scalar: a/b
    mixed: [a/b, 3]
cycleOrder:
  - smol
`),
		);
		expect(Object.entries(chains)).toEqual([
			["plan", ["openai-codex/gpt-6.1-sol"]],
			["none", []],
			["openai-codex/gpt-6.1-sol", ["zai/glm-5.3:max"]],
		]);
	});

	test("yields {} without a file, retry, or chains", () => {
		expect(modelFallbacks(join(dir, "missing.yml"))).toEqual({});
		expect(modelFallbacks(config("modelRoles: {default: a/b}\n"))).toEqual({});
		expect(modelFallbacks(config("retry:\n  fallbackChains:\n"))).toEqual({});
	});
});

describe("arch-review changed-line coverage", () => {
	test("a null modelRoles block yields {}", () => {
		expect(modelRoles(config("modelRoles:\ncycleOrder:\n  - smol\n"))).toEqual(
			{},
		);
	});
	test("a non-object modelRoles block yields {}", () => {
		expect(modelRoles(config("modelRoles: just-a-string\n"))).toEqual({});
		expect(modelRoles(config("modelRoles: 42\n"))).toEqual({});
	});
});

describe("default config path", () => {
	test("without an argument, the board's pinned agent dir is read (R5-1)", () => {
		const pinned = join(tmpdir(), `ottr-modelroles-pin-${process.pid}`);
		mkdirSync(pinned, { recursive: true });
		writeFileSync(join(pinned, "config.yml"), "modelRoles: {default: pin/m}\n");
		// Layer-following read (docs/specs/agent-layer-switch.md): the board home's
		// current layer answers before the pin, so pin the board home to an empty dir
		// and the fallback path — the R5-1 pin — is what this test reads.
		const savedBoard = process.env.OTTR_BOARD_OMP_HOME;
		const savedPin = process.env.PI_CODING_AGENT_DIR;
		const home = join(dir, `flat-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(home, { recursive: true });
		process.env.OTTR_BOARD_OMP_HOME = home;
		process.env.PI_CODING_AGENT_DIR = pinned;
		try {
			expect(modelRoles()).toEqual({ default: "pin/m" });
		} finally {
			if (savedBoard === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = savedBoard;
			if (savedPin === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedPin;
		}
		rmSync(pinned, { recursive: true, force: true });
	});

	test("the default path follows the board home's current agent layer", () => {
		// Layer-following read (docs/specs/agent-layer-switch.md): the layer's copy
		// answers when the board home resolves one; read-only, so the flat file and the
		// links stay untouched. Without a link, the flat agent dir answers as today.
		const savedBoard = process.env.OTTR_BOARD_OMP_HOME;
		const savedPin = process.env.PI_CODING_AGENT_DIR;
		const h = join(dir, `layered-${Math.random().toString(36).slice(2, 8)}`);
		const layer = join(h, ".alate", "layers", "lay1");
		mkdirSync(join(layer, ".omp", "agent"), { recursive: true });
		symlinkSync(join("layers", "lay1"), join(h, ".alate", "current"));
		writeFileSync(
			join(layer, ".omp", "agent", "config.yml"),
			"modelRoles: {default: layer/model}\n",
		);
		mkdirSync(join(h, ".omp", "agent"), { recursive: true });
		writeFileSync(
			join(h, ".omp", "agent", "config.yml"),
			"modelRoles: {default: flat/model}\n",
		);
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.OTTR_BOARD_OMP_HOME = h;
		try {
			expect(modelRoles()).toEqual({ default: "layer/model" });
			rmSync(join(h, ".alate", "current"));
			expect(modelRoles()).toEqual({ default: "flat/model" });
		} finally {
			if (savedBoard === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = savedBoard;
			if (savedPin === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedPin;
		}
	});
});
