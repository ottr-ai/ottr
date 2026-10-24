// Standalone tools a project's turns can call (fetching a pinned binary, an ffmpeg build, ...).
// The list lives in the data repo as workers/<project>/tools.json (sha256-pinned https URLs);
// alate provisions it, with the env.txt name list, into the shared home volume. A worker or turn
// container installs every entry it still lacks into ~/.ottr/tools/<sha256>/ and puts the names
// on PATH through a fresh link dir.
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT } from "./apt.ts";

// PATH command names, unique within one file; a list entry can never escape its target dir.
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNPACK: Record<string, true> = { zip: true, "tar.gz": true, none: true };
// env.txt holds names only, never values; a turn fills them from ottr settings.
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface ToolEntry {
	name: string;
	url: string;
	sha256: string;
	unpack: "zip" | "tar.gz" | "none";
	bin?: string;
}

/** tools.json: an array of pinned entries; throws on the first broken rule. */
export function parseToolsJson(text: string): ToolEntry[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("tools: not a JSON array");
	const entries: ToolEntry[] = [];
	const seen = new Set<string>();
	for (const raw of parsed) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw))
			throw new Error("tools: entry is not an object");
		const e = raw as Record<string, unknown>;
		const name = e.name;
		if (typeof name !== "string" || !NAME.test(name))
			throw new Error(`tools: not a tool name: ${JSON.stringify(name)}`);
		if (seen.has(name)) throw new Error(`tools: duplicate tool name: ${name}`);
		seen.add(name);
		if (typeof e.url !== "string" || !e.url.startsWith("https://"))
			throw new Error(`tools: ${name}: not an https:// url`);
		if (typeof e.sha256 !== "string" || !SHA256.test(e.sha256))
			throw new Error(
				`tools: ${name}: not a sha256: ${JSON.stringify(e.sha256)}`,
			);
		if (typeof e.unpack !== "string" || !UNPACK[e.unpack])
			throw new Error(
				`tools: ${name}: unpack must be "zip", "tar.gz" or "none"`,
			);
		const bin = e.bin;
		if (e.unpack === "none") {
			if (bin !== undefined)
				throw new Error(`tools: ${name}: unpack "none" takes no bin`);
		} else if (
			typeof bin !== "string" ||
			bin === "" ||
			bin.startsWith("/") ||
			bin.split("/").includes("..")
		)
			throw new Error(
				`tools: ${name}: bin must be a relative path inside the archive`,
			);
		const known = new Set(["name", "url", "sha256", "unpack"]);
		if (bin !== undefined) known.add("bin");
		for (const key of Object.keys(e))
			if (!known.has(key))
				throw new Error(`tools: ${name}: unknown key: ${key}`);
		entries.push(
			bin === undefined
				? {
						name,
						url: e.url,
						sha256: e.sha256,
						unpack: e.unpack as ToolEntry["unpack"],
					}
				: {
						name,
						url: e.url,
						sha256: e.sha256,
						unpack: e.unpack as ToolEntry["unpack"],
						bin,
					},
		);
	}
	return entries;
}

/** Where alate provisions a project's tool list. */
export function toolsListPath(project: string, home = homedir()): string {
	if (!PROJECT.test(project))
		throw new Error(`tools: unsafe project name ${JSON.stringify(project)}`);
	return join(home, ".ottr", "workers", project, "tools.json");
}

/** env.txt: one env var name per line; `#` comments and blank lines are ignored. */
export function parseEnvTxt(text: string): string[] {
	const names = text
		.split("\n")
		.map((l) => l.replace(/#.*/, "").trim())
		.filter((l) => l !== "");
	const bad = names.filter((n) => !ENV_NAME.test(n));
	if (bad.length > 0)
		throw new Error(`env: not an env var name: ${bad.join(", ")}`);
	return [...new Set(names)];
}

/** Where alate provisions a project's env var name list. */
export function envListPath(project: string, home = homedir()): string {
	if (!PROJECT.test(project))
		throw new Error(`env: unsafe project name ${JSON.stringify(project)}`);
	return join(home, ".ottr", "workers", project, "env.txt");
}

/** The names a project's env.txt lists; a missing file lists nothing. */
export function readEnvNames(project: string, home = homedir()): string[] {
	const file = envListPath(project, home);
	if (!existsSync(file)) return [];
	return parseEnvTxt(readFileSync(file, "utf8"));
}

/** Every name provisioned for any project, with the projects that list it. */
export function listedEnvNames(
	home = homedir(),
): { name: string; projects: string[] }[] {
	const dir = join(home, ".ottr", "workers");
	const byName = new Map<string, string[]>();
	for (const project of existsSync(dir) ? readdirSync(dir).sort() : []) {
		if (!PROJECT.test(project)) continue;
		for (const name of readEnvNames(project, home)) {
			const projects = byName.get(name) ?? [];
			projects.push(project);
			byName.set(name, projects);
		}
	}
	return [...byName.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, projects]) => ({ name, projects }));
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Installs the listed tools this machine lacks (the "_all" list first, then the project's own),
 * before a turn runs here. Returns lines for the turn log (none when nothing was missing);
 * throws on the first failure, so the turn stops.
 */
export async function ensureProjectTools(
	project: string,
	home = homedir(),
): Promise<string[]> {
	const entries = [...readTools("_all", home), ...readTools(project, home)];
	if (entries.length === 0) return [];
	// ponytail: one install at a time per process (each container runs one ottr process);
	// the sha256-keyed target dir makes a rerun a no-op anyway.
	const run = queue.then(() => install(entries, home));
	queue = run.catch(() => {});
	return run;
}

/**
 * Every provisioned list, when a worker starts, so a project's first turn there does not wait
 * for its tools. A list that fails adds its error line, and the other lists still install.
 */
export async function ensureAllTools(home = homedir()): Promise<string[]> {
	const dir = join(home, ".ottr", "workers");
	const lines: string[] = [];
	for (const project of existsSync(dir) ? readdirSync(dir).sort() : []) {
		if (!PROJECT.test(project)) continue;
		try {
			lines.push(...(await ensureProjectTools(project, home)));
		} catch (err) {
			lines.push(
				`tools: ${project}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	return lines;
}

function readTools(project: string, home: string): ToolEntry[] {
	const file = toolsListPath(project, home);
	if (!existsSync(file)) return [];
	return parseToolsJson(readFileSync(file, "utf8"));
}

async function install(entries: ToolEntry[], home: string): Promise<string[]> {
	const lines: string[] = [];
	for (const e of entries) {
		const target = join(home, ".ottr", "tools", e.sha256);
		if (existsSync(target)) continue;
		await unpackInto(e, target, home);
		lines.push(`tools: installed ${e.name} (${e.sha256.slice(0, 12)})`);
	}
	return lines;
}

async function unpackInto(
	e: ToolEntry,
	target: string,
	home: string,
): Promise<void> {
	const root = join(home, ".ottr", "tools");
	mkdirSync(root, { recursive: true });
	// Same filesystem as the target, so the final move is one rename.
	const tmp = mkdtempSync(join(root, "install-"));
	try {
		// A download that hangs must not hold the install queue (and every later turn) forever.
		const res = await fetch(e.url, { signal: AbortSignal.timeout(600_000) });
		if (!res.ok)
			throw new Error(`tools: ${e.name}: download failed (${res.status})`);
		const bytes = Buffer.from(await res.arrayBuffer());
		const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		if (hash !== e.sha256)
			throw new Error(
				`tools: ${e.name}: sha256 mismatch (${hash.slice(0, 12)})`,
			);
		const dir = join(tmp, "unpack");
		mkdirSync(dir);
		if (e.unpack === "none") {
			writeFileSync(join(dir, e.name), bytes);
		} else {
			const archive = join(
				tmp,
				`download.${e.unpack === "zip" ? "zip" : "tar.gz"}`,
			);
			writeFileSync(archive, bytes);
			await exec(
				e.unpack === "zip"
					? ["unzip", "-q", archive, "-d", dir]
					: ["tar", "-xzf", archive, "-C", dir],
			);
		}
		guardPaths(e.name, dir);
		const bin = join(dir, e.bin ?? e.name);
		chmodSync(bin, 0o755);
		try {
			renameSync(dir, target);
		} catch (err) {
			// Two containers install the same pin at once: the winner's folder is complete
			// (one rename), so the loser reuses it instead of failing the turn.
			if (!existsSync(target)) throw err;
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Rejects any entry that is a symlink out of the unpacked dir or whose path climbs out. */
function guardPaths(name: string, dir: string): void {
	const stack = [""];
	while (stack.length > 0) {
		const rel = stack.pop()!;
		const full = join(dir, rel);
		if (lstatSync(full).isSymbolicLink()) {
			if (!realpathSync(full).startsWith(dir + "/"))
				throw new Error(
					`tools: ${name}: archive symlink escapes the dir: ${rel}`,
				);
			continue; // never walk through a symlinked dir
		}
		if (rel.split("/").includes(".."))
			throw new Error(`tools: ${name}: archive entry climbs out: ${rel}`);
		if (statSync(full).isDirectory())
			for (const child of readdirSync(full))
				stack.push(rel ? `${rel}/${child}` : child);
	}
}

/** stdout; throws with the stderr tail on a non-zero exit. */
async function exec(argv: string[]): Promise<string> {
	const p = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (code !== 0)
		throw new Error(
			`tools: ${argv.slice(0, 2).join(" ")} failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
		);
	return stdout;
}

/**
 * A fresh PATH dir for a turn: the project's tools first, then "_all", a project name winning.
 * Links only what is already installed; it never installs anything.
 */
export function buildToolsPath(project: string, home = homedir()): string {
	const root = join(home, ".ottr", "tools");
	const entries = [...readTools(project, home), ...readTools("_all", home)];
	// "" = nothing to prepend: the callers skip the PATH prefix for an empty turn.
	if (entries.length === 0) return "";
	const dir = join(tmpdir(), "ottr-path-" + crypto.randomUUID());
	mkdirSync(dir);
	const linked = new Set<string>();
	for (const e of entries) {
		if (linked.has(e.name)) continue;
		linked.add(e.name);
		const target = join(root, e.sha256, e.bin ?? e.name);
		if (!existsSync(target))
			throw new Error(
				`tools: ${e.name}: ${e.sha256.slice(0, 12)} missing from ${root}`,
			);
		symlinkSync(target, join(dir, e.name));
	}
	return dir;
}

/**
 * Fills the env names a project (and "_all") list from the turn's values: `env` carries the
 * listed names that have a value, `missing` the listed ones without, sorted.
 */
export function turnEnvValues(
	project: string,
	values: Record<string, string>,
	home = homedir(),
): { env: Record<string, string>; missing: string[] } {
	const names = [
		...new Set([...readEnvNames("_all", home), ...readEnvNames(project, home)]),
	];
	const env: Record<string, string> = {};
	const missing: string[] = [];
	for (const name of names) {
		const value = values[name];
		if (value !== undefined) env[name] = value;
		else missing.push(name);
	}
	missing.sort();
	return { env, missing };
}
