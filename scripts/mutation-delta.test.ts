// Tests for the delta mutation gate: real git fixtures for the diff extraction,
// fakes for Stryker and the config loader, so no run ever imports a real config
// or spawns Stryker (docs/specs/mutation-delta.md, section 1).
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "../src/test/properties.ts";
import { gitExe } from "../src/worktree.ts";
import {
	addedRanges,
	configsFor,
	type DeltaDeps,
	type DeltaRange,
	type DeltaReport,
	loadConfigs,
	main,
	owns,
	type SpawnOpts,
	type SpawnResult,
	type StrykerConfig,
	verdict,
} from "./mutation-delta.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-mutation-delta-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	// The fakes write exactly these report files into the shared temp dir.
	for (const name of ["stryker.fixturewide", "stryker.junk"])
		rmSync(join(tmpdir(), `ott-delta-${name}.json`), { force: true });
});

/** git for fixtures with a throwaway identity — never a main() spawn. */
function must(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(
		[
			gitExe(),
			"-c",
			"user.name=ott",
			"-c",
			"user.email=ott@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

const FOO_V1 = Array.from(
	{ length: 10 },
	(_, i) => `export const v${i + 1} = ${i + 1};\n`,
).join("");

let fixtures = 0;
/** A git repo with a base commit, then a head commit built by `head`. */
function repo(head: (dir: string) => void): {
	dir: string;
	base: string;
	head: string;
} {
	const dir = join(root, String(fixtures++));
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "src", "foo.ts"), FOO_V1);
	writeFileSync(join(dir, "src", "foo.test.ts"), 'test("v1", () => {});\n');
	writeFileSync(join(dir, "docs", "note.md"), "note v1\n");
	must(dir, "init", "-q", "-b", "main");
	must(dir, "add", ".");
	must(dir, "commit", "-q", "-m", "base");
	const base = must(dir, "rev-parse", "HEAD");
	head(dir);
	must(dir, "add", ".");
	must(dir, "commit", "-q", "-m", "head");
	return { dir, base, head: must(dir, "rev-parse", "HEAD") };
}

/** The head commit under test: known lines of src/foo.ts plus a new file. */
function codeHead(dir: string): void {
	const lines = FOO_V1.split("\n").filter((l) => l !== "");
	lines.splice(2, 2, "const three = 3;", "const four = 4;", "const five = 5;");
	writeFileSync(join(dir, "src", "foo.ts"), `${lines.join("\n")}\n`);
	writeFileSync(join(dir, "src", "foo.test.ts"), 'test("v2", () => {});\n');
	writeFileSync(
		join(dir, "src", "new.ts"),
		"export const a = 1;\nexport const b = 2;\n",
	);
}

/** Docs and test files only: nothing a Stryker config owns. */
function docsHead(dir: string): void {
	writeFileSync(join(dir, "docs", "note.md"), "note v2\n");
	writeFileSync(join(dir, "src", "foo.test.ts"), 'test("v2", () => {});\n');
}

const codeRepo = repo(codeHead);
const docsOnly = repo(docsHead);

const wide: StrykerConfig = {
	path: "/cfg/stryker.fixturewide.config.mjs",
	name: "stryker.fixturewide",
	mutate: ["src/**/*.ts", "!**/*.test.ts"],
};
const scope: StrykerConfig = {
	path: "/cfg/stryker.fixturescope.config.mjs",
	name: "stryker.fixturescope",
	mutate: ["src/turn.ts"],
};

const reportPath = (configName: string): string =>
	join(tmpdir(), `ott-delta-${configName}.json`);

/** Records a stryker spawn and answers with `body` written to its report path. The run
 * goes through the wrapper config (cmd[2]), whose name names the report file. */
function writeReport(cmd: string[], body: unknown, exitCode = 1): SpawnResult {
	const name = basename(cmd[2] ?? "")
		.replace(/^ott-delta-/, "")
		.replace(/\.config\.mjs$/, "");
	if (name === "") throw new Error("no wrapper config in stryker argv");
	const path = reportPath(name);
	// A string body lands in the file as-is, so a test can plant invalid JSON.
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return { exitCode, stdout: "", stderr: "" };
}

interface StrykerCall {
	cmd: string[];
	opts?: SpawnOpts;
}

/** Real git inside `fixture`; Stryker calls are recorded, never executed. */
function fakeDeps(
	fixture: string,
	configs: StrykerConfig[],
	onStryker: (cmd: string[]) => SpawnResult,
	clock: number[] = [1000, 7500],
): { deps: DeltaDeps; stryker: StrykerCall[] } {
	const stryker: StrykerCall[] = [];
	let tick = 0;
	return {
		stryker,
		deps: {
			spawn: (cmd, opts) => {
				if (cmd[0] === "git") {
					const r = Bun.spawnSync(cmd, {
						cwd: fixture,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						windowsHide: true,
					});
					return {
						exitCode: r.exitCode,
						stdout: r.stdout.toString(),
						stderr: r.stderr.toString(),
					};
				}
				stryker.push({ cmd, opts });
				return onStryker(cmd);
			},
			loadConfigs: async () => configs,
			now: () => clock[Math.min(tick++, clock.length - 1)] ?? 0,
		},
	};
}

/** Runs main with stdout/stderr captured; tests in a file run sequentially. */
async function captured(
	run: () => Promise<number>,
): Promise<{ code: number; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
	console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
	try {
		const code = await run();
		return { code, out, err };
	} finally {
		console.log = log;
		console.error = error;
	}
}

const repoRoot = resolve(import.meta.dir, "..");

describe("addedRanges", () => {
	test("parses the exact ranges of a real base..head diff", () => {
		const diff = must(
			codeRepo.dir,
			"diff",
			"-U0",
			"--no-renames",
			`${codeRepo.base}..${codeRepo.head}`,
		);
		expect(addedRanges(diff)).toEqual([
			{ file: "src/foo.test.ts", start: 1, end: 1 },
			{ file: "src/foo.ts", start: 3, end: 5 },
			{ file: "src/new.ts", start: 1, end: 2 },
		]);
	});

	test("parses hunk edge cases", () => {
		// Multiple hunks in one file, one with an omitted count.
		expect(
			addedRanges(
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"index 1111111..2222222 100644",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -1 +1,2 @@",
					"const a = 1;",
					"const b = 2;",
					"@@ -9,2 +10,3 @@",
					"x",
					"y",
					"z",
				].join("\n"),
			),
		).toEqual([
			{ file: "src/a.ts", start: 1, end: 2 },
			{ file: "src/a.ts", start: 10, end: 12 },
		]);
		// A deletion-only hunk adds nothing.
		expect(
			addedRanges(
				[
					"diff --git a/src/d.ts b/src/d.ts",
					"--- a/src/d.ts",
					"+++ b/src/d.ts",
					"@@ -5,3 +4,0 @@",
					"-old1",
					"-old2",
					"-old3",
				].join("\n"),
			),
		).toEqual([]);
		// A new file starts at line 1; /dev/null hides a deleted file.
		expect(
			addedRanges(
				[
					"diff --git a/src/new.ts b/src/new.ts",
					"new file mode 100644",
					"index 0000000..3333333",
					"--- /dev/null",
					"+++ b/src/new.ts",
					"@@ -0,0 +1,3 @@",
					"+const a = 1;",
					"+const b = 2;",
					"+const c = 3;",
				].join("\n"),
			),
		).toEqual([{ file: "src/new.ts", start: 1, end: 3 }]);
		// Binary markers never yield ranges.
		expect(
			addedRanges(
				[
					"diff --git a/img.png b/img.png",
					"index 1111111..2222222 100644",
					"Binary files a/img.png and b/img.png differ",
					"diff --git a/other.bin b/other.bin",
					"GIT binary patch",
				].join("\n"),
			),
		).toEqual([]);
		// git C-quotes names with spaces; the quotes are output, not the path.
		expect(
			addedRanges(
				[
					'diff --git "a/src/a b.ts" "b/src/a b.ts"',
					'--- "a/src/a b.ts"',
					'+++ "b/src/a b.ts"',
					"@@ -1 +1,2 @@",
					"x",
				].join("\n"),
			),
		).toEqual([{ file: "src/a b.ts", start: 1, end: 2 }]);
		// A hunk's added line reading "+++ b/evil.ts" is content, not a header.
		expect(
			addedRanges(
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -1 +1,2 @@",
					"const a = 1;",
					"+++ b/evil.ts",
					"@@ -9,1 +9,2 @@",
					"const b = 2;",
				].join("\n"),
			),
		).toEqual([
			{ file: "src/a.ts", start: 1, end: 2 },
			{ file: "src/a.ts", start: 9, end: 10 },
		]);
	});

	test("keeps ranges well formed on arbitrary diff text", () => {
		const line = fc.oneof(
			fc.constant("diff --git a/src/a.ts b/src/a.ts"),
			fc.constant("index 1111111..2222222 100644"),
			fc.constant("--- a/src/a.ts"),
			fc.constant("+++ b/src/a.ts"),
			fc.constant("+++ /dev/null"),
			fc.constant("Binary files a/bin and b/bin differ"),
			fc.constant("@@ -3,2 +3,3 @@"),
			fc.constant("@@ -5 +5 @@"),
			fc.string({ maxLength: 30 }).map((s) => ` ${s}`),
			fc.string({ maxLength: 30 }).map((s) => `+${s}`),
			fc.string({ maxLength: 30 }).map((s) => `-${s}`),
		);
		fc.assert(
			fc.property(fc.array(line, { maxLength: 80 }), (lines) => {
				for (const r of addedRanges(lines.join("\n"))) {
					expect(r.start).toBeGreaterThanOrEqual(1);
					expect(r.end).toBeGreaterThanOrEqual(r.start);
				}
			}),
		);
	});
});

describe("owns", () => {
	test("follows Stryker's last-match-wins semantics", () => {
		const mutate = ["src/**/*.ts", "!**/*.test.ts"];
		expect(owns(mutate, "src/foo.ts")).toBe(true);
		expect(owns(mutate, "src/foo.test.ts")).toBe(false);
		expect(owns(["src/turn.ts"], "src/turn.ts")).toBe(true);
		expect(owns(["src/turn.ts"], "src/store.ts")).toBe(false);
		expect(
			owns(["src/**", "!src/ui/**", "src/ui/app.ts"], "src/ui/app.ts"),
		).toBe(true);
		expect(owns(["src/ui/app.ts", "!src/ui/**"], "src/ui/app.ts")).toBe(false);
		expect(owns(["src/**"], "docs/note.md")).toBe(false);
	});
});

describe("configsFor", () => {
	test("maps one file to several configs and drops configs with no range", () => {
		const ranges: DeltaRange[] = [
			{ file: "src/foo.test.ts", start: 1, end: 1 },
			{ file: "src/foo.ts", start: 3, end: 5 },
			{ file: "src/new.ts", start: 1, end: 2 },
		];
		const groups = configsFor([wide, scope], ranges);
		expect(groups).toEqual([
			{
				config: wide,
				ranges: [
					{ file: "src/foo.ts", start: 3, end: 5 },
					{ file: "src/new.ts", start: 1, end: 2 },
				],
			},
		]);
		expect(
			groups.map((g) => g.ranges.map((r) => `${r.file}:${r.start}-${r.end}`)),
		).toEqual([["src/foo.ts:3-5", "src/new.ts:1-2"]]);
	});
});

describe("verdict", () => {
	test("counts tested mutants and picks survivors inside the ranges", () => {
		const ranges: DeltaRange[] = [
			{ file: "src/foo.ts", start: 3, end: 5 },
			{ file: "src/new.ts", start: 1, end: 2 },
		];
		const report: DeltaReport = {
			files: {
				"src/foo.ts": {
					mutants: [
						{
							status: "Survived",
							mutatorName: "StringLiteral",
							replacement: '"x"',
							location: { start: { line: 3 } },
						},
						{
							status: "Timeout",
							mutatorName: "MethodExpression",
							replacement: "suspended()",
							location: { start: { line: 4 } },
						},
						{
							status: "Survived",
							mutatorName: "StringLiteral",
							replacement: '"outside"',
							location: { start: { line: 1 } },
						},
						{
							status: "Killed",
							mutatorName: "StringLiteral",
							replacement: '"z"',
							location: { start: { line: 5 } },
						},
					],
				},
				"src/new.ts": {
					mutants: [
						{
							status: "NoCoverage",
							mutatorName: "Block",
							replacement: "{}",
							location: { start: { line: 2 } },
						},
					],
				},
				"src/untouched.ts": {
					mutants: [
						{
							status: "Survived",
							mutatorName: "Block",
							replacement: "{}",
							location: { start: { line: 3 } },
						},
					],
				},
			},
		};
		const v = verdict(report, ranges);
		expect(v.tested).toBe(4);
		expect(v.survivors).toEqual([
			{
				file: "src/foo.ts",
				line: 3,
				mutatorName: "StringLiteral",
				replacement: '"x"',
				status: "Survived",
			},
			{
				file: "src/new.ts",
				line: 2,
				mutatorName: "Block",
				replacement: "{}",
				status: "NoCoverage",
			},
		]);
	});
});

describe("main", () => {
	test("runs the owning configs and fails on a planted survivor", async () => {
		let wrapperBody = "";
		const { deps, stryker } = fakeDeps(codeRepo.dir, [wide, scope], (cmd) => {
			wrapperBody = readFileSync(cmd[2] ?? "", "utf8");
			return writeReport(cmd, {
				files: {
					"src/foo.ts": {
						mutants: [
							{
								status: "Survived",
								mutatorName: "StringLiteral",
								replacement: '"changed"',
								location: { start: { line: 3 } },
							},
							{
								status: "Killed",
								mutatorName: "StringLiteral",
								replacement: '"other"',
								location: { start: { line: 4 } },
							},
						],
					},
					"src/new.ts": {
						mutants: [
							{
								status: "Killed",
								mutatorName: "Block",
								replacement: "{}",
								location: { start: { line: 1 } },
							},
						],
					},
				},
			});
		});
		const { code, out, err } = await captured(() =>
			main([codeRepo.base, codeRepo.head], deps),
		);
		expect(code).toBe(1);
		expect(out).toEqual([
			"mutation delta gate: FAILED (1 survivors)",
			'src/foo.ts:3 [StringLiteral] "changed" (Survived)',
		]);
		expect(err).toEqual(["mutation delta gate: 1 config(s) in 7s"]);
		// Only the owning config runs; the run goes through the generated wrapper
		// config, and Stryker's own exit code (1) is ignored.
		const wrapper = join(repoRoot, "ott-delta-stryker.fixturewide.config.mjs");
		expect(stryker).toEqual([
			{
				cmd: [
					join(repoRoot, "node_modules", ".bin", "stryker"),
					"run",
					wrapper,
					"--mutate",
					"src/foo.ts:3-5,src/new.ts:1-2",
				],
				opts: { cwd: repoRoot, stdio: "inherit" },
			},
		]);
		expect(wrapperBody).toBe(
			`import base from ${JSON.stringify(pathToFileURL(wide.path).href)};\n` +
				`export default { ...base, reporters: ["clear-text", "json"], jsonReporter: { fileName: ${JSON.stringify(reportPath("stryker.fixturewide"))} } };\n`,
		);
		expect(existsSync(wrapper)).toBe(false);
	});

	test("counts Timeout inside a range as detected", async () => {
		const { deps, stryker } = fakeDeps(codeRepo.dir, [wide], (cmd) =>
			writeReport(cmd, {
				files: {
					"src/foo.ts": {
						mutants: [
							{
								status: "Timeout",
								mutatorName: "MethodExpression",
								replacement: "suspended()",
								location: { start: { line: 3 } },
							},
							{
								status: "Killed",
								mutatorName: "Block",
								replacement: "{}",
								location: { start: { line: 5 } },
							},
							{
								status: "Killed",
								mutatorName: "Block",
								replacement: "{}",
								location: { start: { line: 1 } },
							},
						],
					},
				},
			}),
		);
		const { code, out } = await captured(() =>
			main([codeRepo.base, codeRepo.head], deps),
		);
		expect(code).toBe(0);
		expect(out).toEqual([
			"mutation delta gate: passed (2 mutants tested in changed lines, 0 survivors)",
		]);
		expect(stryker).toHaveLength(1);
	});

	test("ignores a Survived mutant outside all ranges", async () => {
		const { deps } = fakeDeps(codeRepo.dir, [wide], (cmd) =>
			writeReport(cmd, {
				files: {
					"src/foo.ts": {
						mutants: [
							{
								status: "Survived",
								mutatorName: "StringLiteral",
								replacement: '"before"',
								location: { start: { line: 1 } },
							},
							{
								status: "Killed",
								mutatorName: "StringLiteral",
								replacement: '"other"',
								location: { start: { line: 3 } },
							},
						],
					},
				},
			}),
		);
		const { code, out } = await captured(() =>
			main([codeRepo.base, codeRepo.head], deps),
		);
		expect(code).toBe(0);
		expect(out).toEqual([
			"mutation delta gate: passed (1 mutants tested in changed lines, 0 survivors)",
		]);
	});

	test("runs nothing for docs and test files only", async () => {
		const { deps, stryker } = fakeDeps(docsOnly.dir, [wide, scope], () => {
			throw new Error("must not run Stryker");
		});
		const { code, out } = await captured(() =>
			main([docsOnly.base, docsOnly.head], deps),
		);
		expect(code).toBe(0);
		expect(out).toEqual([
			"no ranges: no changed file is mutated by a Stryker config",
		]);
		expect(stryker).toHaveLength(0);
	});

	test("exits 2 when a report is missing", async () => {
		rmSync(reportPath("stryker.absent"), { force: true });
		const absent: StrykerConfig = { ...wide, name: "stryker.absent" };
		const { deps, stryker } = fakeDeps(codeRepo.dir, [absent], () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const { code, err } = await captured(() =>
			main([codeRepo.base, codeRepo.head], deps),
		);
		expect(code).toBe(2);
		expect(err[0]).toContain(
			`Stryker left no report at ${reportPath("stryker.absent")}`,
		);
		expect(stryker).toHaveLength(1);
	});

	test("exits 2 when a report is unparseable", async () => {
		const { deps } = fakeDeps(codeRepo.dir, [wide], (cmd) =>
			writeReport(cmd, "not json"),
		);
		const { code, err } = await captured(() =>
			main([codeRepo.base, codeRepo.head], deps),
		);
		expect(code).toBe(2);
		expect(err[0]).toContain(
			`cannot parse report ${reportPath("stryker.fixturewide")}`,
		);
	});

	test("exits 2 when the config loader fails", async () => {
		const { deps, stryker } = fakeDeps(codeRepo.dir, [], () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const failing: DeltaDeps = {
			...deps,
			loadConfigs: async () => {
				throw new Error("bad config");
			},
		};
		const { code, err } = await captured(() =>
			main([codeRepo.base, codeRepo.head], failing),
		);
		expect(code).toBe(2);
		expect(err[0]).toContain("cannot load Stryker configs: bad config");
		expect(stryker).toHaveLength(0);
	});

	test("exits 2 on an unknown base and on bad usage", async () => {
		const { deps, stryker } = fakeDeps(codeRepo.dir, [wide], () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const failed = await captured(() => main(["nosuchref"], deps));
		expect(failed.code).toBe(2);
		expect(failed.err[0]).toContain("git merge-base nosuchref HEAD failed:");
		expect(stryker).toHaveLength(0);

		const never: DeltaDeps = {
			spawn: () => {
				throw new Error("must not spawn");
			},
			loadConfigs: async () => {
				throw new Error("must not load");
			},
			now: () => 0,
		};
		expect(await captured(() => main([], never))).toMatchObject({ code: 2 });
		expect(await captured(() => main(["a", "b", "c"], never))).toMatchObject({
			code: 2,
		});
	});
});

describe("loadConfigs", () => {
	test("reads mutate arrays from the stryker*.config.mjs files at a root", async () => {
		const dir = join(root, "configs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "stryker.main.config.mjs"),
			"export default { mutate: ['src/**/*.ts', '!**/*.test.ts'] };\n",
		);
		writeFileSync(
			join(dir, "stryker.turn.config.mjs"),
			"export default { mutate: ['src/turn.ts'] };\n",
		);
		// No stryker prefix: not a config, ignored.
		writeFileSync(join(dir, "other.config.mjs"), "export default {};\n");
		expect(await loadConfigs(dir)).toEqual([
			{
				path: join(dir, "stryker.main.config.mjs"),
				name: "stryker.main",
				mutate: ["src/**/*.ts", "!**/*.test.ts"],
			},
			{
				path: join(dir, "stryker.turn.config.mjs"),
				name: "stryker.turn",
				mutate: ["src/turn.ts"],
			},
		]);
	});

	test("rejects a config without a mutate array", async () => {
		const dir = join(root, "configs-bad");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "stryker.empty.config.mjs"),
			"export default { testRunner: 'command' };\n",
		);
		await expect(loadConfigs(dir)).rejects.toThrow(
			"stryker.empty.config.mjs: default export has no mutate array",
		);
	});
});
