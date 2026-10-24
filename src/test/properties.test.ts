import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The harness (properties.ts) configures fast-check from FC_RUNS at import time.
// bun caches the module, so each probe runs a fresh interpreter that imports it
// and prints the resulting global config as `numRuns/seed`. The child script's
// await import is the boundary under test: a static import in THIS file would
// execute properties.ts once in this process and could never observe the env
// gate in a fresh one.
const mod = join(import.meta.dir, "properties.ts");
const probe = `const m = await import(${JSON.stringify(mod)});
const fc = m.default;
const g = typeof fc.readConfigureGlobal === "function"
	? fc.readConfigureGlobal()
	: fc.globalConfig;
console.log(JSON.stringify(g.numRuns) + "/" + JSON.stringify(g.seed));`;

async function run(
	env: Record<string, string>,
): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn([process.execPath, "-e", probe], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, out: out + err };
}

describe("fast-check harness gate", () => {
	test("a non-numeric FC_RUNS refuses with the bad value named", async () => {
		const r = await run({ FC_RUNS: "abc" });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("bad FC_RUNS: abc");
	});

	test("FC_RUNS 1 is a valid deep tier", async () => {
		const r = await run({ FC_RUNS: "1" });
		expect(r.code).toBe(0);
		expect(r.out).toBe("1/undefined\n");
	});

	test("the default gate is 200 runs on the fixed seed", async () => {
		const r = await run({});
		expect(r.code).toBe(0);
		expect(r.out).toBe("200/42\n");
	});
});
