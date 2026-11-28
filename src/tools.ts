// Standalone tools a project's turns can call (fetching a pinned binary, an ffmpeg build, ...).
// The list lives in the data repo as workers/<project>/tools.json (sha256-pinned https URLs);
// alate provisions it, with the env.txt name list, into the shared home volume. A worker or turn
// container installs every entry it still lacks into ~/.ottr/tools/<sha256>/ and puts the names
// on PATH through a link dir, one per distinct tool set.
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT, workerProjectsAsync } from "./apt.ts";
import { childDatabaseEnv } from "./childEnv.ts";
import { resolveAgentLayer } from "./layers.ts";
import { boardOmpHome, turnListHome } from "./login.ts";
import { pluginSkillDirs } from "./pluginSkills.ts";

/**
 * The home a board list read targets: the current agent layer's dir when `<home>/.alate/current`
 * resolves, else the flat home (docs/specs/agent-layer-switch.md, "Layer-following reads").
 * Alate installs the `.ottr/workers` lists into every new layer and may prune the flat ones, so
 * a read follows the layer at read time; a missing or broken link reads the flat home as today.
 */
export function layerHome(home: string): string {
	return resolveAgentLayer(home)?.dir ?? home;
}

/** Skill folders of an agent home; `.agents/skills` mirrors `.omp/agent/skills` (the bridge), so names dedupe. */
const USER_SKILL_DIRS = [
	".omp/agent/skills",
	".omp/agent/managed-skills",
	".agents/skills",
];

function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const objectKeys = (value: unknown): string[] =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.keys(value)
		: [];

/** The user layer a provisioned home holds: names, sorted. Each piece reads fail-soft:
 *  alate installs an item only when the data repo has it, so a missing dir or file is an
 *  empty list, never an error. A skill is a folder with a SKILL.md; plugins come from
 *  omp-plugins.lock.json's `plugins` map; MCP servers from mcp.json's `mcpServers`; rules
 *  are the .md files in .omp/agent/rules (dot-prefixed files stay out). Skills also
 *  come from the enabled plugins' `pi.skills` directories (pluginSkillDirs): a
 *  plugin-shipped skill folder with a SKILL.md counts, so a worker that has the
 *  skill only through a plugin does not report it missing. */
/** One skill folder entry: the name and its SKILL.md path; the first dir that holds
 *  the name wins (the `.agents/skills` bridge mirrors `.omp/agent/skills`). */
interface SkillDir {
	name: string;
	skillMd: string;
}

/** The agent home's skill folders, sorted by name: the three user dirs plus the
 *  enabled plugins' `pi.skills` dirs (pluginSkillDirs). */
function skillDirs(home: string): SkillDir[] {
	const skills = new Map<string, string>();
	const addSkillNames = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const skillMd = join(dir, name, "SKILL.md");
			if (!existsSync(skillMd)) continue;
			if (!skills.has(name)) skills.set(name, skillMd);
		}
	};
	for (const dir of USER_SKILL_DIRS) addSkillNames(join(home, dir));
	for (const dir of pluginSkillDirs(home)) addSkillNames(dir);
	return [...skills]
		.map(([name, skillMd]) => ({ name, skillMd }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readUserLayer(home: string): {
	skills: string[];
	plugins: string[];
	mcp: string[];
	rules: string[];
} {
	const lock = readJsonObject(
		join(home, ".omp", "plugins", "omp-plugins.lock.json"),
	);
	const mcpFile = readJsonObject(join(home, ".omp", "agent", "mcp.json"));
	let ruleFiles: string[];
	try {
		ruleFiles = readdirSync(join(home, ".omp", "agent", "rules"));
	} catch {
		ruleFiles = [];
	}
	const rules = ruleFiles
		.filter((name) => !name.startsWith(".") && name.endsWith(".md"))
		.sort();
	return {
		skills: skillDirs(home).map((s) => s.name),
		plugins: objectKeys(lock?.plugins).sort(),
		mcp: objectKeys(mcpFile?.mcpServers).sort(),
		rules,
	};
}

/** One skill a worker turn can load: its folder name and the `description:` line of
 *  its SKILL.md frontmatter ("" when the file holds no parseable one). */
export interface SkillEntry {
	name: string;
	description: string;
}

/** The SKILL.md frontmatter's `description:` value, trimmed, one outer pair of quotes
 *  stripped; no frontmatter, a block scalar (`|`, `>`), or an unreadable file reads as "". */
function skillDescription(skillMd: string): string {
	let text: string;
	try {
		text = readFileSync(skillMd, "utf8");
	} catch {
		return "";
	}
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return "";
	const end = lines.indexOf("---", 1);
	if (end === -1) return "";
	for (let i = 1; i < end; i++) {
		const m = /^description:[ \t]*(.*)$/.exec(lines[i]!);
		if (m === null) continue;
		let value = m[1]!.trim();
		if (value === "|" || value === ">") return "";
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		)
			value = value.slice(1, -1);
		return value;
	}
	return "";
}

/** The skills a worker turn of the project can load, sorted by name, each with its
 *  SKILL.md frontmatter description: the same skill read the board's "Missing on
 *  workers" check uses (readUserLayer), plus descriptions for the prompt gate's
 *  skill block (OTTR-1068). The home defaults to the workers' list home
 *  (turnListHome), the same resolution the provisioning endpoint's user layer uses. */
export function skillCatalog(home: string = turnListHome()): SkillEntry[] {
	return skillDirs(layerHome(home)).map((s) => ({
		name: s.name,
		description: skillDescription(s.skillMd),
	}));
}

// PATH command names, unique within one file; a list entry can never escape its target dir.
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNPACK: Record<string, true> = { zip: true, "tar.gz": true, none: true };
// env.txt holds names only, never values; a turn fills them from ottr settings.
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface ToolEntry {
	name: string;
	url: string;
	sha256: string;
	unpack: "zip" | "tar.gz" | "none";
	bin?: string;
}

/** One validated entry; throws a readable error on the first broken rule. */
function parseToolEntry(raw: unknown, seen: Set<string>): ToolEntry {
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
		throw new Error(`tools: ${name}: unpack must be "zip", "tar.gz" or "none"`);
	const bin = parseBin(e, name);
	return {
		name,
		url: e.url,
		sha256: e.sha256,
		unpack: e.unpack as ToolEntry["unpack"],
		...(bin === undefined ? {} : { bin }),
	};
}

/** The entry's `bin` field, checked against the unpack mode; undefined when absent. */
function parseBin(
	e: Record<string, unknown>,
	name: string,
): string | undefined {
	const bin = e.bin;
	let valid: string | undefined;
	if (e.unpack === "none") {
		if (bin !== undefined)
			throw new Error(`tools: ${name}: unpack "none" takes no bin`);
	} else {
		if (
			typeof bin !== "string" ||
			bin === "" ||
			bin.startsWith("/") ||
			bin.split("/").includes("..")
		)
			throw new Error(
				`tools: ${name}: bin must be a relative path inside the archive`,
			);
		valid = bin;
	}
	const known = new Set(["name", "url", "sha256", "unpack"]);
	if (valid !== undefined) known.add("bin");
	for (const key of Object.keys(e))
		if (!known.has(key)) throw new Error(`tools: ${name}: unknown key: ${key}`);
	return valid;
}

/** tools.json: an array of pinned entries; throws on the first broken rule. */
export function parseToolsJson(text: string): ToolEntry[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("tools: not a JSON array");
	const entries: ToolEntry[] = [];
	const seen = new Set<string>();
	for (const raw of parsed) entries.push(parseToolEntry(raw, seen));
	return entries;
}

/**
 * Where alate provisions a project's tool list, resolved for a board read: under the home's
 * current agent layer when one exists, else the flat home. The installs themselves (the
 * `.ottr/tools` content) stay in the flat home; only the list read follows the layer.
 */
export function toolsListPath(project: string, home = homedir()): string {
	if (!PROJECT.test(project))
		throw new Error(`tools: unsafe project name ${JSON.stringify(project)}`);
	return join(layerHome(home), ".ottr", "workers", project, "tools.json");
}

/** One env.txt entry: the name, and whether its value is plain (not a secret). */
export type EnvEntry = { name: string; plain: boolean };

/**
 * env.txt: one env var name per line, optionally followed by `plain` (the value is not a
 * secret, e.g. a host); `#` comments and blank lines are ignored. A name listed twice is
 * plain only when both lines say so: a secret listing wins (docs/specs/env-plain-values.md).
 */
export function parseEnvTxt(text: string): EnvEntry[] {
	const lines = text
		.split("\n")
		.map((l) => l.replace(/#.*/, "").trim())
		.filter((l) => l !== "");
	const bad: string[] = [];
	const byName = new Map<string, boolean>();
	for (const line of lines) {
		const [name = "", kind, ...rest] = line.split(/\s+/);
		if (
			!ENV_NAME.test(name) ||
			(kind !== undefined && kind !== "plain") ||
			rest.length > 0
		) {
			bad.push(line);
			continue;
		}
		byName.set(name, (byName.get(name) ?? true) && kind === "plain");
	}
	if (bad.length > 0)
		throw new Error(`env: not an env var name: ${bad.join(", ")}`);
	return [...byName].map(([name, plain]) => ({ name, plain }));
}

/**
 * Where the board reads a project's env var name list, resolved for a read: under the home's
 * current agent layer when one exists, else the flat home. R5-1: the names decide which saved
 * secrets a turn gets, so the default is the board's server-only home (compose: the
 * board-seed copy under OTTR_BOARD_OMP_HOME), never the shared home that turns can write —
 * and the layer inside that board home, not its flat content.
 */
export function envListPath(project: string, home = boardOmpHome()): string {
	if (!PROJECT.test(project))
		throw new Error(`env: unsafe project name ${JSON.stringify(project)}`);
	return join(layerHome(home), ".ottr", "workers", project, "env.txt");
}

/** The entries a project's env.txt lists (envListPath resolves the layer); a missing file lists nothing. */
function readEnvNames(project: string, home = boardOmpHome()): EnvEntry[] {
	const file = envListPath(project, home);
	if (!existsSync(file)) return [];
	return parseEnvTxt(readFileSync(file, "utf8"));
}

/** The async twin of readEnvNames for the request path (OTTR-1088): the reads wait on
 *  the mounted workers home, so a turn's env lookup must not hold the event loop. */
async function readEnvNamesAsync(
	project: string,
	home = boardOmpHome(),
): Promise<EnvEntry[]> {
	const file = envListPath(project, home);
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		// Only a file that does not exist means the project lists nothing.
		if (err instanceof Error && "code" in err && err.code === "ENOENT")
			return [];
		throw err;
	}
	return parseEnvTxt(text);
}

/**
 * Every name provisioned for any project, with the projects that list it and its kind: plain
 * only when every listing says `plain`. A malformed env.txt is logged and skipped, so one bad
 * list does not hide every other project's names.
 */
export async function listedEnvNames(
	home = boardOmpHome(),
): Promise<{ name: string; projects: string[]; plain: boolean }[]> {
	const byName = new Map<string, { projects: string[]; plain: boolean }>();
	// One resolve for the folder list and the reads: workerProjectsAsync has no layer
	// resolution of its own (apt.ts), and a switch mid-read must not mix two layers.
	home = layerHome(home);
	for (const project of await workerProjectsAsync(home)) {
		let entries: EnvEntry[];
		try {
			entries = await readEnvNamesAsync(project, home);
		} catch (err) {
			console.warn(
				`env: ${project}: ${err instanceof Error ? err.message : err}`,
			);
			continue;
		}
		for (const { name, plain } of entries) {
			const row = byName.get(name) ?? { projects: [], plain: true };
			row.projects.push(project);
			row.plain &&= plain;
			byName.set(name, row);
		}
	}
	return [...byName.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, row]) => ({ name, ...row }));
}

/**
 * The values a turn may use: each listed name takes the value of its current kind (a plain
 * name its plain value, a secret name its secret), so a kind change never leaks the other
 * store's value. Unlisted names keep their secret, as before.
 */
export function envValuesByKind(
	secret: Record<string, string>,
	plain: Record<string, string>,
	listed: readonly { name: string; plain: boolean }[],
): Record<string, string> {
	const out = { ...secret };
	for (const row of listed) {
		if (!row.plain) continue;
		delete out[row.name];
		const v = plain[row.name];
		if (v !== undefined) out[row.name] = v;
	}
	return out;
}

let queue: Promise<unknown> = Promise.resolve();

/** Reads one project's tools.json (toolsListPath resolves the layer); a missing file lists nothing. */
export function readToolsList(project: string, home = homedir()): ToolEntry[] {
	const file = toolsListPath(project, home);
	if (!existsSync(file)) return [];
	return parseToolsJson(readFileSync(file, "utf8"));
}

/**
 * Installs the listed entries this machine lacks, before a turn runs here, and checks every
 * archive tool it already has against its pin; the caller passes them in install order (the
 * "_all" entries first, then the project's own — the server wrapper below, the /run request on
 * a worker, docs/specs/worker-list-isolation.md). Returns lines for the turn log (none when
 * nothing was missing); throws on the first failure, so the turn stops.
 */
export async function installTools(
	entries: ToolEntry[],
	home = homedir(),
): Promise<string[]> {
	if (entries.length === 0) return [];
	// ponytail: one install at a time per process (each container runs one ottr process);
	// the sha256-keyed target dir makes a rerun a no-op anyway.
	const run = queue.then(() => install(entries, home));
	queue = run.catch(() => {});
	return run;
}

/** The server-local wrapper: read both files (the "_all" list first, then the project's), install. */
export async function ensureProjectTools(
	project: string,
	home = homedir(),
): Promise<string[]> {
	return installTools(
		[...readToolsList("_all", home), ...readToolsList(project, home)],
		home,
	);
}

function sha256Hex(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

async function install(entries: ToolEntry[], home: string): Promise<string[]> {
	const root = join(home, ".ottr", "tools");
	const lines: string[] = [];
	for (const e of entries) {
		const target = join(root, e.sha256);
		if (existsSync(target)) {
			// The home is shared: a turn can rewrite an installed tree (OTTR-953). A plain
			// binary is checked at link time (verifyPinnedBinary); an archive's tree here.
			if (e.unpack !== "none") await verifyUnpacked(e, target, root);
			continue;
		}
		await unpackInto(e, target, root);
		lines.push(`tools: installed ${e.name} (${e.sha256.slice(0, 12)})`);
	}
	return lines;
}

async function unpackInto(
	e: ToolEntry,
	target: string,
	root: string,
): Promise<void> {
	mkdirSync(root, { recursive: true });
	// Same filesystem as the target, so the final move is one rename.
	const tmp = mkdtempSync(join(root, "install-"));
	try {
		const dir = await unpack(e, await pinnedBytes(e, root, tmp), tmp);
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

/** Refuses an installed archive tree that differs from a fresh unpack of the pinned archive. */
async function verifyUnpacked(
	e: ToolEntry,
	target: string,
	root: string,
): Promise<void> {
	const tmp = mkdtempSync(join(root, "verify-"));
	try {
		const fresh = await unpack(e, await pinnedBytes(e, root, tmp), tmp);
		const diff = treeDiff(fresh, target);
		if (diff !== null)
			throw new Error(
				`tools: ${e.name}: installed files do not match its sha256 (${diff || "."} differs); remove ${target} to reinstall`,
			);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * The pinned download's bytes. An archive keeps a copy at <root>/<sha256>.<unpack>, so a later
 * check unpacks it without a download; a copy that fails the hash is downloaded again.
 */
async function pinnedBytes(
	e: ToolEntry,
	root: string,
	tmp: string,
): Promise<Buffer> {
	const kept = join(root, `${e.sha256}.${e.unpack}`);
	// lstat: a planted FIFO or link is never read; it is replaced like a failed copy.
	if (
		e.unpack !== "none" &&
		lstatSync(kept, { throwIfNoEntry: false })?.isFile()
	) {
		const bytes = readFileSync(kept);
		if (sha256Hex(bytes) === e.sha256) return bytes;
	}
	// A download that hangs must not hold the install queue (and every later turn) forever.
	const res = await fetch(e.url, { signal: AbortSignal.timeout(600_000) });
	if (!res.ok)
		throw new Error(`tools: ${e.name}: download failed (${res.status})`);
	const bytes = Buffer.from(await res.arrayBuffer());
	const hash = sha256Hex(bytes);
	if (hash !== e.sha256)
		throw new Error(`tools: ${e.name}: sha256 mismatch (${hash.slice(0, 12)})`);
	if (e.unpack !== "none") {
		// One rename: a reader never sees a half-written copy, and a planted link is replaced.
		writeFileSync(join(tmp, "kept"), bytes);
		renameSync(join(tmp, "kept"), kept);
	}
	return bytes;
}

/** Unpacks verified bytes into <tmp>/unpack, executable bin included; returns that dir. */
async function unpack(
	e: ToolEntry,
	bytes: Buffer,
	tmp: string,
): Promise<string> {
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
	chmodSync(join(dir, e.bin ?? e.name), 0o755);
	return dir;
}

/**
 * The first relative path ("" = the root) where `actual` differs from `expected`: entry type,
 * a file's bytes, a symlink's target, or a dir's entry names. Null when the trees match.
 * lstat only, so no link is followed and no special file is read.
 */
function treeDiff(expected: string, actual: string): string | null {
	const stack: string[] = [""];
	for (let rel = stack.pop(); rel !== undefined; rel = stack.pop()) {
		const a = join(expected, rel);
		const b = join(actual, rel);
		const sa = lstatSync(a);
		const sb = lstatSync(b, { throwIfNoEntry: false });
		if (sb === undefined || (sa.mode & 0o170000) !== (sb.mode & 0o170000))
			return rel;
		if (sa.isSymbolicLink()) {
			if (readlinkSync(a) !== readlinkSync(b)) return rel;
		} else if (sa.isDirectory()) {
			const names = readdirSync(a).sort();
			if (names.join("\0") !== readdirSync(b).sort().join("\0")) return rel;
			for (const n of names) stack.push(rel ? `${rel}/${n}` : n);
		} else if (
			sa.isFile() &&
			(sa.size !== sb.size || !readFileSync(a).equals(readFileSync(b)))
		)
			return rel;
	}
	return null;
}

/**
 * Rejects a symlink that points out of the unpacked dir. This is a post-check: tar/unzip
 * already ran, so it cannot stop a write through a symlink during extraction. The trust
 * boundary is the sha256 pin from the data repo; this only keeps an escaping link out of
 * the installed folder. Entry names come from readdirSync, so they never hold "..".
 */
function guardPaths(name: string, dir: string): void {
	const stack: string[] = [""];
	for (let rel = stack.pop(); rel !== undefined; rel = stack.pop()) {
		const full = join(dir, rel);
		if (lstatSync(full).isSymbolicLink()) {
			if (!realpathSync(full).startsWith(`${dir}/`))
				throw new Error(
					`tools: ${name}: archive symlink escapes the dir: ${rel}`,
				);
			continue; // never walk through a symlinked dir
		}
		if (statSync(full).isDirectory())
			for (const child of readdirSync(full))
				stack.push(rel ? `${rel}/${child}` : child);
	}
}

/** stdout; throws with the stderr tail on a non-zero exit. */
async function exec(argv: string[]): Promise<string> {
	const p = Bun.spawn(argv, {
		env: childDatabaseEnv(),
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
 * The PATH dir for a turn: the entries in priority order, the first entry with a name winning
 * (the server passes the project's list first, then "_all"; a worker passes the request's).
 * Links only what is already installed; it never installs anything. The dir is keyed by a
 * hash of its content, so every turn with the same tool set reuses one dir and none leaks.
 */
/** Refuses an installed binary whose bytes no longer match its sha256 pin. */
function verifyPinnedBinary(
	name: string,
	sha256: string,
	target: string,
): void {
	const hash = sha256Hex(readFileSync(target));
	if (hash !== sha256)
		throw new Error(
			`tools: ${name}: installed binary does not match its sha256 (${hash.slice(0, 12)})`,
		);
}

/** The symlink/wrapper layout for the turn's entries: name → target, godot wrapped.
 *  The caller passes the entries in priority order; the first entry with a name wins. */
function linkTargets(
	entries: ToolEntry[],
	root: string,
): Map<string, ToolLink> {
	const links = new Map<string, ToolLink>();
	for (const e of entries) {
		if (links.has(e.name)) continue;
		const target = join(root, e.sha256, e.bin ?? e.name);
		if (!existsSync(target))
			throw new Error(
				`tools: ${e.name}: ${e.sha256.slice(0, 12)} missing from ${root}`,
			);
		// A plain binary must still be the pinned download: a dir someone else wrote under this
		// sha256 is refused. An archive's tree is checked by install (verifyUnpacked).
		if (e.unpack === "none") verifyPinnedBinary(e.name, e.sha256, target);
		links.set(e.name, {
			target,
			wrapper: e.name === "godot" ? headlessWrapper(target) : null,
		});
	}
	return links;
}

/** One symlink/wrapper plan for a tool name. */
type ToolLink = { target: string; wrapper: string | null };

/**
 * Materialises the links dir atomically; a concurrent winner's dir is reused. Each call
 * checks the dir, a reused one too: it is shared home state a turn can write (OTTR-953).
 */
function writeLinksDir(
	root: string,
	key: string,
	links: Map<string, ToolLink>,
): string {
	const dir = join(root, `path-${key}`);
	if (!existsSync(dir)) {
		// Built aside and moved in with one rename, so a reused dir is never half-built.
		const tmp = mkdtempSync(join(root, "path-build-"));
		try {
			for (const [name, { target, wrapper }] of links) {
				if (wrapper !== null)
					writeFileSync(join(tmp, name), wrapper, { mode: 0o755 });
				else symlinkSync(target, join(tmp, name));
			}
			try {
				renameSync(tmp, dir);
			} catch (err) {
				// Two turns build the same set at once: the winner's dir is complete; reuse it.
				if (!existsSync(dir)) throw err;
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	const bad = linksDirDiff(dir, links);
	if (bad !== null)
		throw new Error(
			`tools: link dir does not match the tool set (${bad} differs); remove ${dir} to rebuild`,
		);
	// mkdtemp builds the dir 0700, but the project uid has no rights on this root-owned dir
	// and the provisioning spec keeps it world-readable: every call, a reused dir too, sets 0755.
	chmodSync(dir, 0o755);
	return dir;
}

/** The first name ("." = the dir itself) where the links dir differs from the plan, or null. */
function linksDirDiff(
	dir: string,
	links: Map<string, ToolLink>,
): string | null {
	if (!lstatSync(dir).isDirectory()) return ".";
	if (
		readdirSync(dir).sort().join("\0") !== [...links.keys()].sort().join("\0")
	)
		return ".";
	for (const [name, { target, wrapper }] of links) {
		const path = join(dir, name);
		const s = lstatSync(path);
		const same =
			wrapper === null
				? s.isSymbolicLink() && readlinkSync(path) === target
				: s.isFile() && readFileSync(path, "utf8") === wrapper;
		if (!same) return name;
	}
	return null;
}

export function buildToolsPath(entries: ToolEntry[], home = homedir()): string {
	const root = join(home, ".ottr", "tools");
	const links = linkTargets(entries, root);
	// "" = nothing to prepend: the callers skip the PATH prefix for an empty turn.
	if (links.size === 0) return "";
	const key = sha256Hex(JSON.stringify([...links]));
	return writeLinksDir(root, key, links);
}

/**
 * Without a display Godot exits ("Can't load Xlib"), so `godot` adds --headless when there is
 * none: godot-mcp's run_project then runs the game and reads its output. A display keeps it.
 */
function headlessWrapper(target: string): string {
	const quoted = `'${target.replaceAll("'", `'\\''`)}'`;
	return `#!/bin/sh\n[ -n "\${DISPLAY}\${WAYLAND_DISPLAY}" ] || set -- --headless "$@"\nexec ${quoted} "$@"\n`;
}

/**
 * Fills the env names a project (and "_all") list from the turn's values: `env` carries the
 * listed names that have a value, `missing` the listed ones without, sorted.
 */
export function turnEnvValues(
	project: string,
	values: Record<string, string>,
	home = boardOmpHome(),
): { env: Record<string, string>; missing: string[] } {
	// One resolve for both reads (readEnvNames resolves again, a no-op on a layer dir):
	// a switch mid-read must not mix two layers' name lists.
	home = layerHome(home);
	const names = [
		...new Set(
			[...readEnvNames("_all", home), ...readEnvNames(project, home)].map(
				(e) => e.name,
			),
		),
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
