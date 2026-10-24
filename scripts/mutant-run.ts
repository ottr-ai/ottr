// Two-stage test selection for Stryker's command runner.
// Dry run (no __STRYKER_ACTIVE_MUTANT__): full suite, then each test file alone,
// so a file that fails alone cannot cause stage-1 false kills later.
// Mutant run: stage 1 runs only the test files whose import closure contains the
// mutated file; a map miss skips stage 1 and only the full suite runs — slower,
// never wrong. The parent shell runs under `ulimit -d 2097152`; children inherit
// it. Linux-only: relies on POSIX grep and the ulimit.
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const IGNORED = [
	"src/worktree.test.ts",
	"src/release.test.ts",
	"src/turn.test.ts",
	"scripts/dev-updater.test.js",
	"scripts/update-image.test.ts",
];
const TEST_DIRS = ["src", "extension", "scripts"];
const SEARCH_DIRS = ["src", "extension"];
// Tests start these as subprocesses or import them through computed paths;
// a static import scan cannot see the edge.
const EXTRA_CLOSURE: Record<string, string[]> = {
	"src/worker.ts": ["src/workers.test.ts"],
	"src/crash.ts": ["src/crash.test.ts"],
	"src/test/properties.ts": ["src/test/properties.test.ts"],
};

function collectTestFiles(root: string, dir: string, files: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch {
		return; // search dir absent in the sandbox
	}
	for (const e of entries) {
		const rel = join(dir, e.name).split("\\").join("/");
		if (e.isDirectory()) collectTestFiles(root, rel, files);
		else if (/\.test\.(ts|js)$/.test(e.name)) files.push(rel);
	}
}

export function discoverTestFiles(root = "."): string[] {
	const files: string[] = [];
	for (const dir of TEST_DIRS) collectTestFiles(root, dir, files);
	return files.filter((f) => !IGNORED.includes(f)).sort();
}

// Resolve a relative specifier to an existing file, trying common extensions.
function resolveImport(
	root: string,
	fromFile: string,
	spec: string,
): string | null {
	const base = join(root, fromFile, "..", spec);
	const candidates = [
		base,
		spec.endsWith(".js") ? `${base.slice(0, -3)}.ts` : null,
		`${base}.ts`,
		`${base}.tsx`,
		join(base, "index.ts"),
	];
	for (const c of candidates) {
		// relative(), not slicing root's length: join() normalizes a "." root away,
		// so slicing mangled keys when the map was built with the default root.
		// Assets (html, css, json) are not mutated: never map or traverse them,
		// and feeding them to the transpiler crashes it (src/ui/index.html).
		if (c !== null && existsSync(c) && /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(c))
			return relative(root, c).split("\\").join("/");
	}
	return null;
}

function importsOf(root: string, file: string): string[] {
	const transpiler = new Bun.Transpiler({
		loader: file.endsWith(".ts") ? "ts" : "js",
	});
	const code = readFileSync(join(root, file), "utf8");
	const specs: string[] = [];
	// scanImports is typed to return import records; older builds yielded strings.
	type ScannedImports = Array<string | { path: string }>;
	let scanned: ScannedImports;
	try {
		scanned = transpiler.scanImports(code);
	} catch {
		// Content the loader cannot parse: map nothing for this file. The full
		// suite still covers it, so the miss is slower, never wrong.
		return [];
	}
	for (const imp of scanned) {
		// scanImports yields { kind, path } entries; path covers static and dynamic imports.
		const spec = typeof imp === "string" ? imp : imp.path;
		if (spec?.startsWith(".")) specs.push(spec);
	}
	return specs;
}

function pushTests(
	map: Map<string, string[]>,
	src: string,
	testFile: string,
): void {
	const list = map.get(src) ?? [];
	if (!list.includes(testFile)) list.push(testFile);
	map.set(src, list);
}

function mapClosure(
	root: string,
	testFile: string,
	map: Map<string, string[]>,
): void {
	const seen = new Set<string>([testFile]);
	const queue = [testFile];
	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined) break;
		for (const spec of importsOf(root, file)) {
			const resolved = resolveImport(root, file, spec);
			if (resolved === null || seen.has(resolved)) continue;
			seen.add(resolved);
			if (!resolved.includes(".test.")) queue.push(resolved);
			pushTests(map, resolved, testFile);
		}
	}
}

export function buildImportMap(root = "."): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const testFile of discoverTestFiles(root))
		mapClosure(root, testFile, map);
	for (const [src, tests] of Object.entries(EXTRA_CLOSURE)) {
		const list = map.get(src) ?? [];
		list.push(...tests);
		map.set(src, list);
	}
	for (const [k, list] of map) map.set(k, [...new Set(list)].sort());
	return map;
}

export async function findMutatedFile(
	id: string,
	dirs = SEARCH_DIRS,
): Promise<string> {
	// The env value is untrusted input; a miss degrades to "run everything".
	if (!/^\d+$/.test(id)) return "";
	const proc = Bun.spawn(
		["grep", "-rlE", `stryMutAct_[0-9a-f]+\\("${id}"\\)`, ...dirs],
		{
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return "";
	return out.split("\n")[0] ?? "";
}

async function run(cmd: string[]): Promise<number> {
	const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
	return await proc.exited;
}

async function dryRun(flags: string[]): Promise<void> {
	const code = await run(["bun", "test", "--bail", ...flags]);
	if (code !== 0) process.exit(code);
	const failed: string[] = [];
	for (const f of discoverTestFiles()) {
		if ((await run(["bun", "test", "--bail", f])) !== 0) failed.push(f);
	}
	if (failed.length > 0) {
		console.error(
			`[mutant-run] dry run: ${failed.length} test file(s) fail alone`,
		);
		for (const f of failed) console.error(f);
		process.exit(1);
	}
}

async function mutantRun(mutant: string, flags: string[]): Promise<void> {
	const mutated = await findMutatedFile(mutant);
	const tests = mutated === "" ? [] : (buildImportMap().get(mutated) ?? []);
	if (tests.length > 0) {
		console.error(`[mutant-run] stage 1: ${tests.length} test file(s)`);
		const code = await run(["bun", "test", "--bail", ...tests]);
		if (code !== 0) process.exit(code);
	}
	console.error("[mutant-run] stage 2: full suite");
	process.exit(await run(["bun", "test", "--bail", "--parallel=8", ...flags]));
}

export async function main(): Promise<void> {
	const flags = IGNORED.map((f) => `--path-ignore-patterns=${f}`);
	const mutant = process.env.__STRYKER_ACTIVE_MUTANT__;
	if (mutant) await mutantRun(mutant, flags);
	else await dryRun(flags);
}

if (import.meta.main) await main();
