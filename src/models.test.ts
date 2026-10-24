import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRoles } from "./models.ts";

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
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = pinned;
		try {
			expect(modelRoles()).toEqual({ default: "pin/m" });
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
		rmSync(pinned, { recursive: true, force: true });
	});
});
