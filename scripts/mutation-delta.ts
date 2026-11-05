#!/usr/bin/env bun
// Delta mutation gate: runs Stryker only over the lines a commit range adds.
// Usage: bun run test:mutation:delta <base> [head] (docs/specs/mutation-delta.md, section 1).
// Exit 0 pass or no owned ranges; 1 a mutant survived or has no coverage on a changed
// line; 2 environment failure (bad args, git, config load, Stryker without a report).
// Stryker's own exit code is ignored when its report exists: a threshold break must not
// mask the gate's verdict.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One added-line hunk in the head tree; `end` is inclusive, Stryker range style. */
export interface DeltaRange {
	file: string;
	start: number;
	end: number;
}

/** A Stryker config at the repo root, read from its default export. */
export interface StrykerConfig {
	path: string;
	/** Base file name without .config.mjs, e.g. "stryker.release". */
	name: string;
	mutate: string[];
}

/** One mutant in the JSON report; only the fields the gate reads. */
export interface ReportMutant {
	status?: string;
	mutatorName?: string;
	replacement?: string;
	location?: { start?: { line?: number } };
}

/** The mutation-testing-elements report one Stryker run leaves. */
export interface DeltaReport {
	files?: Record<string, { mutants?: ReportMutant[] }>;
}

/** A mutant the gate fails on: on a changed line and Survived or NoCoverage. */
export interface Survivor {
	file: string;
	line: number;
	mutatorName: string;
	replacement: string;
	status: string;
}

export interface SpawnOpts {
	cwd?: string;
	stdio?: "pipe" | "inherit";
}

export interface SpawnResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface DeltaDeps {
	spawn: (cmd: string[], opts?: SpawnOpts) => SpawnResult;
	loadConfigs: (repoRoot: string) => Promise<StrykerConfig[]>;
	now: () => number;
}

export type ExitCode = 0 | 1 | 2;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** The repo path of a `+++ ` header, null for /dev/null (a deleted file). */
function addedPath(line: string): string | null {
	let name = line.slice(4).replace(/\r$/, "");
	// git C-quotes names with spaces or special chars; the quotes are output.
	if (name.startsWith('"') && name.endsWith('"'))
		name = name.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	if (name === "/dev/null") return null;
	return name.startsWith("b/") ? name.slice(2) : name;
}

/** Turns `git diff -U0 --no-renames` output into one range per added hunk. */
export function addedRanges(diff: string): DeltaRange[] {
	const ranges: DeltaRange[] = [];
	let file: string | null = null;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			file = null;
			inHunk = false;
			continue;
		}
		const hunk = HUNK.exec(line);
		if (hunk !== null) {
			inHunk = true;
			const start = Number(hunk[1]);
			// count 0: a deletion-only hunk adds nothing to mutate.
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			if (file !== null && count > 0)
				ranges.push({ file, start, end: start + count - 1 });
			continue;
		}
		// File headers only outside hunks: a hunk's added line can read "+++ b/x" itself.
		if (!inHunk && line.startsWith("+++ ")) file = addedPath(line);
	}
	return ranges;
}

/** Stryker ownership: ordered match, `!` excludes, the last matching pattern wins. */
export function owns(mutate: string[], file: string): boolean {
	let owned: boolean | null = null;
	for (const pattern of mutate) {
		const exclude = pattern.startsWith("!");
		if (new Bun.Glob(exclude ? pattern.slice(1) : pattern).match(file))
			owned = !exclude;
	}
	return owned === true;
}

/** The ranges each config runs; one changed file may feed several configs. */
export function configsFor(
	configs: StrykerConfig[],
	ranges: DeltaRange[],
): { config: StrykerConfig; ranges: DeltaRange[] }[] {
	const perFile = new Map<string, DeltaRange[]>();
	for (const r of ranges) {
		const list = perFile.get(r.file) ?? [];
		list.push(r);
		perFile.set(r.file, list);
	}
	const groups: { config: StrykerConfig; ranges: DeltaRange[] }[] = [];
	for (const config of configs) {
		const owned: DeltaRange[] = [];
		for (const [file, rs] of perFile)
			if (owns(config.mutate, file)) owned.push(...rs);
		if (owned.length > 0) groups.push({ config, ranges: owned });
	}
	return groups;
}

/** The report verdict: `tested` mutants on changed lines, `survivors` the failing ones. */
export function verdict(
	report: DeltaReport,
	ranges: DeltaRange[],
): { tested: number; survivors: Survivor[] } {
	let tested = 0;
	const survivors: Survivor[] = [];
	for (const [file, fileResult] of Object.entries(report.files ?? {})) {
		for (const m of fileResult.mutants ?? []) {
			const line = m.location?.start?.line;
			if (typeof line !== "number") continue;
			const inside = ranges.some(
				(r) => r.file === file && line >= r.start && line <= r.end,
			);
			if (!inside) continue;
			tested++;
			if (
				m.status !== undefined &&
				(m.status === "Survived" || m.status === "NoCoverage")
			)
				survivors.push({
					file,
					line,
					mutatorName: m.mutatorName ?? "unknown",
					replacement: m.replacement ?? "unknown",
					status: m.status,
				});
		}
	}
	return { tested, survivors };
}

/** Reads every stryker*.config.mjs at the repo root; throws when one has no mutate array. */
export async function loadConfigs(repoRoot: string): Promise<StrykerConfig[]> {
	const names = readdirSync(repoRoot)
		.filter((f) => /^stryker.*\.config\.mjs$/.test(f))
		.sort();
	const configs: StrykerConfig[] = [];
	for (const name of names) {
		const path = join(repoRoot, name);
		// Dynamic import: the config files exist only after readdirSync, so a static
		// import cannot name them at author time (runtime registry exception).
		const mod = (await import(path)) as { default?: { mutate?: unknown } };
		const mutate = mod.default?.mutate;
		if (!Array.isArray(mutate))
			throw new Error(`${name}: default export has no mutate array`);
		configs.push({
			path,
			name: name.replace(/\.config\.mjs$/, ""),
			mutate: mutate.map(String),
		});
	}
	return configs;
}

function realSpawn(cmd: string[], opts?: SpawnOpts): SpawnResult {
	// Literal stdio options keep Bun's SyncSubprocess typed per branch.
	if (opts?.stdio === "inherit") {
		const r = Bun.spawnSync(cmd, {
			cwd: opts.cwd,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			windowsHide: true,
		});
		return { exitCode: r.exitCode, stdout: "", stderr: "" };
	}
	const r = Bun.spawnSync(cmd, {
		cwd: opts?.cwd,
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

const realDeps: DeltaDeps = {
	spawn: realSpawn,
	loadConfigs,
	now: () => Date.now(),
};

/** A wrapper config next to the real one, removed again after the run: the JSON report
 * path has no CLI form (commander registers no --jsonReporter flags), so each run extends
 * the real config with the json reporter and an absolute report path. */
function writeWrapperConfig(
	repoRoot: string,
	config: StrykerConfig,
	reportPath: string,
): string {
	const wrapper = join(repoRoot, `ott-delta-${config.name}.config.mjs`);
	writeFileSync(
		wrapper,
		`import base from ${JSON.stringify(pathToFileURL(config.path).href)};\n` +
			`export default { ...base, reporters: ["clear-text", "json"], jsonReporter: { fileName: ${JSON.stringify(reportPath)} } };\n`,
	);
	return wrapper;
}

/** The report of one run, or why the gate cannot read it. */
function readReport(path: string): { report: DeltaReport } | { error: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { error: `Stryker left no report at ${path}` };
	}
	try {
		return { report: JSON.parse(text) as DeltaReport };
	} catch (e) {
		return {
			error: `cannot parse report ${path}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

export async function main(
	argv: string[] = process.argv.slice(2),
	deps: DeltaDeps = realDeps,
): Promise<ExitCode> {
	if (argv.length < 1 || argv.length > 2) {
		console.error("usage: bun run test:mutation:delta <base> [head]");
		return 2;
	}
	const base = argv[0] ?? "";
	const head = argv[1] ?? "HEAD";
	const repoRoot = resolve(import.meta.dir, "..");
	const started = deps.now();

	const merged = deps.spawn(["git", "merge-base", base, head], {
		cwd: repoRoot,
	});
	if (merged.exitCode !== 0) {
		console.error(
			`mutation delta gate: git merge-base ${base} ${head} failed: ${merged.stderr.trim()}`,
		);
		return 2;
	}
	const mergeBase = merged.stdout.trim();
	const diff = deps.spawn(
		["git", "diff", "-U0", "--no-renames", `${mergeBase}..${head}`],
		{ cwd: repoRoot },
	);
	if (diff.exitCode !== 0) {
		console.error(
			`mutation delta gate: git diff ${mergeBase}..${head} failed: ${diff.stderr.trim()}`,
		);
		return 2;
	}

	let configs: StrykerConfig[];
	try {
		configs = await deps.loadConfigs(repoRoot);
	} catch (e) {
		console.error(
			`mutation delta gate: cannot load Stryker configs: ${e instanceof Error ? e.message : String(e)}`,
		);
		return 2;
	}

	const groups = configsFor(configs, addedRanges(diff.stdout));
	if (groups.length === 0) {
		console.log("no ranges: no changed file is mutated by a Stryker config");
		return 0;
	}

	const survivors: Survivor[] = [];
	let tested = 0;
	for (const { config, ranges } of groups) {
		// tmpdir() is machine-global and the board runs several delta gates in
		// parallel worktrees: a fixed name let one gate read a report another
		// card's run had written in between (OTTR-479). One UUID per config run
		// keeps concurrent gates apart and lets the gate delete its own report.
		const reportPath = join(
			tmpdir(),
			`ott-delta-${config.name}-${randomUUID()}.json`,
		);
		// The CLI's --mutate is a comma list (stryker-cli.js): a repeated flag overwrites.
		// The JSON report path has no CLI form (commander registers no --jsonReporter
		// flags), so each run extends the real config with the json reporter through a
		// wrapper config next to it, removed again after the run. --force keeps a release
		// review honest: the incremental differ cannot see fixture, config, dependency or
		// Stryker-version changes, so a release never reuses a cached verdict.
		const wrapper = writeWrapperConfig(repoRoot, config, reportPath);
		let run: SpawnResult;
		try {
			run = deps.spawn(
				[
					join(repoRoot, "node_modules", ".bin", "stryker"),
					"run",
					wrapper,
					"--mutate",
					ranges.map((r) => `${r.file}:${r.start}-${r.end}`).join(","),
					"--force",
				],
				{ cwd: repoRoot, stdio: "inherit" },
			);
		} finally {
			rmSync(wrapper, { force: true });
		}
		const parsed = readReport(reportPath);
		// The report is one run's tmp state: remove it once read, on a verdict
		// or on an error, so no finished run leaves a report behind.
		rmSync(reportPath, { force: true });
		if ("error" in parsed) {
			console.error(
				`mutation delta gate: ${parsed.error} (exit ${run.exitCode})`,
			);
			return 2;
		}
		const v = verdict(parsed.report, ranges);
		tested += v.tested;
		survivors.push(...v.survivors);
	}

	console.error(
		`mutation delta gate: ${groups.length} config(s) in ${Math.round((deps.now() - started) / 1000)}s`,
	);
	if (survivors.length > 0) {
		console.log(`mutation delta gate: FAILED (${survivors.length} survivors)`);
		for (const s of survivors)
			console.log(
				`${s.file}:${s.line} [${s.mutatorName}] ${s.replacement} (${s.status})`,
			);
		return 1;
	}
	console.log(
		`mutation delta gate: passed (${tested} mutants tested in changed lines, 0 survivors)`,
	);
	return 0;
}

if (import.meta.main) process.exit(await main());
