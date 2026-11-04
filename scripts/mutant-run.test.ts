import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Stryker's instrumenter (installed transitively with @stryker-mutator/core).
import { Instrumenter } from "@stryker-mutator/instrumenter";
import {
	buildImportMap,
	discoverTestFiles,
	findMutatedFile,
	run,
} from "./mutant-run.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-mutant-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

// Fixture: a.test.ts -> b.ts, c.ts; b.ts -> c.ts; c.test.ts -> c.ts; lonely.ts unused.
function write(rel: string, code: string): void {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, code);
}
write(
	"src/a.test.ts",
	`import { c } from "./b.ts";\nimport { c as c2 } from "./c.ts";\n`,
);
write("src/b.ts", `import { c } from "./c.ts";\nexport const b = c;\n`);
write("src/c.ts", "export const c = 1;\n");
write("src/c.test.ts", `import { c } from "./c.ts";\n`);
write("src/lonely.ts", "export const lonely = 2;\n");
write("src/ext.test.ts", `import { c } from "./c";\n`);
write("src/marked.ts", `export const m = 0; // stryMutAct_9fa48("42")\n`);
write("src/marked-big.ts", `export const m = 0; // stryMutAct_9fa48("156")\n`);

describe("discoverTestFiles", () => {
	test("finds only the fixture test files, sorted", () => {
		expect(discoverTestFiles(root)).toEqual([
			"src/a.test.ts",
			"src/c.test.ts",
			"src/ext.test.ts",
		]);
	});
});

describe("buildImportMap", () => {
	const map = buildImportMap(root);

	test("c.ts is covered by both its importers", () => {
		expect(map.get("src/c.ts")).toEqual([
			"src/a.test.ts",
			"src/c.test.ts",
			"src/ext.test.ts",
		]);
	});
	test("b.ts is covered by a.test.ts only", () => {
		expect(map.get("src/b.ts")).toEqual(["src/a.test.ts"]);
	});
	test("uncovered file is absent", () => {
		expect(map.get("src/lonely.ts")).toBeUndefined();
	});
	test("EXTRA_CLOSURE merges without fixture files existing", () => {
		expect(map.get("src/worker.ts")).toEqual(["src/workers.test.ts"]);
	});
	test('keys stay repo-relative when root is the default "."', () => {
		const cwd = process.cwd();
		process.chdir(root);
		try {
			const map = buildImportMap(".");
			expect(map.get("src/b.ts")).toEqual(["src/a.test.ts"]);
		} finally {
			process.chdir(cwd);
		}
	});
});

describe("run", () => {
	const runRoot = mkdtempSync(join(tmpdir(), "ottr-mutant-run-run-"));
	afterAll(() =>
		rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }),
	);

	function leftOver(): string[] {
		return readdirSync(runRoot).filter((f) => f.startsWith("ott-mutant-run-"));
	}

	test("success: child sees fresh TMPDIR and the dir is removed", async () => {
		const code = await run(
			[
				"bun",
				"-e",
				`await require("node:fs/promises").writeFile(
					require("node:path").join(process.env.TMPDIR!, "out.txt"),
					"x",
				);`,
			],
			runRoot,
		);
		expect(code).toBe(0);
		expect(leftOver()).toEqual([]);
	});

	test("failure: dir is removed after a non-zero exit", async () => {
		const code = await run(["bun", "-e", "process.exit(3)"], runRoot);
		expect(code).toBe(3);
		expect(leftOver()).toEqual([]);
	});

	test("killed: dir is removed after SIGKILL death", async () => {
		const code = await run(
			["bun", "-e", "process.kill(process.pid, 'SIGKILL')"],
			runRoot,
		);
		expect(code).not.toBe(0);
		expect(leftOver()).toEqual([]);
	});

	test("command mode: an isolated config's test command gets a private TMPDIR, its exit code, no leftover", () => {
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "mutant-run.ts"),
				"bun",
				"-e",
				"console.log(process.env.TMPDIR); process.exit(3)",
			],
			{ env: { ...process.env, TMPDIR: runRoot }, stdout: "pipe" },
		);
		expect(r.exitCode).toBe(3);
		const seen = r.stdout.toString().trim();
		expect(seen.startsWith(join(runRoot, "ott-mutant-run-"))).toBe(true);
		expect(leftOver()).toEqual([]);
	});
});

describe("findMutatedFile", () => {
	const dirs = [join(root, "src")];
	test("finds the file holding the mutant marker", async () => {
		expect(await findMutatedFile("42", dirs)).toBe(
			join(root, "src", "marked.ts"),
		);
	});
	test("finds a multi-digit mutant id", async () => {
		expect(await findMutatedFile("156", dirs)).toBe(
			join(root, "src", "marked-big.ts"),
		);
	});
	test("unknown id returns empty string", async () => {
		expect(await findMutatedFile("999", dirs)).toBe("");
	});
	test("non-numeric id returns empty string without spawning", async () => {
		expect(await findMutatedFile("not-a-number", dirs)).toBe("");
	});
});

// For the condition `a === 1 || b === 2` of a ternary, Stryker's
// ConditionalExpression mutator emits THREE distinct "false" mutants: the
// whole disjunction, the left operand and the right operand. The right-operand
// one keeps the original behavior wherever the left operand already decides,
// so only an input that exercises the right operand alone kills it. That
// mutant is what survived at src/memory.ts:85 in OTTR-453: the hindsight test
// sent 401 and 500 but never 403 (case study: docs/specs/mutation-delta.md).
// The harness must locate the instrumented file, run its killing test in
// stage 1, and relay the failure as a non-zero exit for each of the three.
describe("mutant-run kills every false mutant of a ternary condition", () => {
	const ternaryRoot = mkdtempSync(join(tmpdir(), "ottr-mutant-run-ternary-"));
	afterAll(() =>
		rmSync(ternaryRoot, { recursive: true, force: true, maxRetries: 5 }),
	);
	const source = [
		'export const pad = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];',
		"export const pick = (a: number, b: number): string =>",
		'\ta === 1 || b === 2 ? "hit" : "miss";',
		"",
	].join("\n");
	const testSource = [
		'import { expect, test } from "bun:test";',
		'import { pick } from "./gate.ts";',
		'test("pick mirrors the reason branches", () => {',
		'\texpect(pick(1, 0)).toBe("hit");',
		'\texpect(pick(0, 2)).toBe("hit");',
		'\texpect(pick(0, 0)).toBe("miss");',
		'\texpect(pick(2, 3)).toBe("miss");',
		"});",
		"",
	].join("\n");

	let falseMutants: Array<{ id: string; startColumn: number }> = [];
	beforeAll(async () => {
		const instrumenter = new Instrumenter({
			debug() {},
			info() {},
			warn() {},
			error() {},
			trace() {},
			isDebugEnabled: () => false,
			isTraceEnabled: () => false,
		} as never);
		const result = await instrumenter.instrument(
			[{ name: "src/gate.ts", content: source, mutate: true }],
			{ plugins: ["ts"], ignorers: [], excludedMutations: [] } as never,
		);
		mkdirSync(join(ternaryRoot, "src"), { recursive: true });
		// The sandbox always carries both search dirs; findMutatedFile greps
		// both and a missing one turns its exit non-zero.
		mkdirSync(join(ternaryRoot, "extension"));
		writeFileSync(
			join(ternaryRoot, "src", "gate.ts"),
			result.files[0]!.content,
		);
		writeFileSync(join(ternaryRoot, "src", "gate.test.ts"), testSource);
		falseMutants = result.mutants
			.filter(
				(m) =>
					m.mutatorName === "ConditionalExpression" &&
					m.replacement === "false",
			)
			.map((m) => ({ id: m.id, startColumn: m.location.start.column }))
			.sort((a, b) => a.startColumn - b.startColumn);
	});

	test("the ternary condition yields three false mutants, the last inside the right operand", () => {
		expect(falseMutants).toHaveLength(3);
		// The whole test and the left operand start at the same column; the
		// right operand starts strictly inside the expression.
		expect(falseMutants[0]!.startColumn).toBe(falseMutants[1]!.startColumn);
		expect(falseMutants[2]!.startColumn).toBeGreaterThan(
			falseMutants[1]!.startColumn,
		);
	});

	test("the harness kills each false mutant through its stage 1", () => {
		for (const m of falseMutants) {
			const r = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "mutant-run.ts")],
				{
					cwd: ternaryRoot,
					env: { ...process.env, __STRYKER_ACTIVE_MUTANT__: String(m.id) },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(r.exitCode, `mutant ${m.id}`).toBe(1);
			expect(r.stderr.toString(), `mutant ${m.id}`).toContain(
				"[mutant-run] stage 1:",
			);
		}
	});
});
