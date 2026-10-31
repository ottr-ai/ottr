import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

describe("findMutatedFile", () => {
	const dirs = [join(root, "src")];
	test("finds the file holding the mutant marker", async () => {
		expect(await findMutatedFile("42", dirs)).toBe(
			join(root, "src", "marked.ts"),
		);
	});
	test("unknown id returns empty string", async () => {
		expect(await findMutatedFile("999", dirs)).toBe("");
	});
	test("non-numeric id returns empty string without spawning", async () => {
		expect(await findMutatedFile("not-a-number", dirs)).toBe("");
	});
});
