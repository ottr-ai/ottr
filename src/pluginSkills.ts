import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PROJECT } from "./apt.ts";
import { readBelow, writeBelow } from "./confine.ts";
import { overlayDirFor } from "./memory.ts";

/** Skills of the plugins a turn's home has enabled in the plugin lock
 * (docs/specs/turn-home-plugin-skills.md). Since d7cab13 every board-spawned run passes
 * `--no-extensions`, so no plugin loads and a plugin's skills went dark with it
 * (OTTC-30 lost the ponytail-audit lens). This module writes the one hardening overlay
 * every board-side run carries: the enabled plugins' declared skill directories as
 * `skills.customDirectories` — omp reads their SKILL.md files as prompt content and
 * still runs no plugin code — plus the project-level skill enables pinned off, so a
 * worker-planted `.agents` or `.omp` skill in the run's cwd never loads. The home's
 * plugins are provisioned content (alate scans them with SkillSpector before install);
 * the worktree stays untrusted and enters no path here. Alate's per-project bundles
 * scope the list further (docs/specs/turn-home-plugin-skills.md): a board project's
 * own skill folder rides after the plugin dirs, and a board project's plugins list
 * filters them when the home holds one.
 */

type AnyRec = Record<string, unknown>;

function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** True when `dir` is `pkgDir` itself or inside it. */
const withinPkg = (pkgDir: string, dir: string): boolean => {
	const rel = relative(pkgDir, dir);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** One enabled plugin's validated skill dir: the lock name with the absolute dir. */
interface PluginSkillEntry {
	name: string;
	dir: string;
}

/** The enabled plugins' skill dirs as name+dir pairs, in lock order, dirs validated.
 * Fail-soft like `tools.ts readUserLayer`: a missing lock, a disabled plugin, a package
 * without `pi.skills`, a skill dir that is not a directory — each drops its entry, the
 * rest still loads. A plugin name or a `pi.skills` entry that resolves outside the
 * plugin's own package directory skips the plugin; a symlinked skill dir counts as
 * outside when its real path leaves the package. */
function pluginSkillEntries(home: string): PluginSkillEntry[] {
	const entries: PluginSkillEntry[] = [];
	const pluginsDir = join(home, ".omp", "plugins");
	const lock = readJsonObject(join(pluginsDir, "omp-plugins.lock.json"));
	const plugins = lock?.plugins;
	if (typeof plugins !== "object" || plugins === null) return entries;
	for (const [name, entry] of Object.entries(plugins)) {
		if ((entry as AnyRec | null)?.enabled !== true) continue;
		const segments = name.split("/");
		if (name === "" || segments.includes("..") || segments.includes(""))
			continue;
		const pkgDir = join(pluginsDir, "node_modules", ...segments);
		const pkg = readJsonObject(join(pkgDir, "package.json"));
		const pi = pkg?.pi;
		if (typeof pi !== "object" || pi === null) continue;
		const declared = (pi as AnyRec).skills;
		if (!Array.isArray(declared)) continue;
		for (const declaredDir of declared) {
			if (typeof declaredDir !== "string" || declaredDir === "") continue;
			const dir = resolve(pkgDir, declaredDir);
			if (!withinPkg(pkgDir, dir)) continue;
			try {
				if (!statSync(dir).isDirectory()) continue;
				// A symlink inside the package can still point out; the real path is
				// the one that must stay inside the plugin's own folder.
				if (!withinPkg(realpathSync(pkgDir), realpathSync(dir))) continue;
			} catch {
				continue;
			}
			entries.push({ name, dir });
		}
	}
	return entries;
}

/** The enabled plugins' skill directories under `home`, absolute, deduplicated, sorted —
 * the unscoped list, no per-project filter (docs/specs/turn-home-plugin-skills.md). */
export function pluginSkillDirs(home: string): string[] {
	return overlaySkillDirs(home, null);
}

/** The per-project skill folder alate provisions for a board project under its turn
 * home: `<home>/.ottr/project-skills/<P>`, whose immediate children are skill folders
 * (docs/specs/turn-home-plugin-skills.md). Null without a project, an unsafe project
 * name, a missing dir, or a real path that leaves the home — fail-soft, the same
 * contract as the plugin enumeration. The project name passes the same rule the
 * `.ottr/workers/<project>` list paths use. */
function projectSkillDir(
	home: string,
	project: string | null | undefined,
): string | null {
	if (!project || !PROJECT.test(project)) return null;
	const dir = join(home, ".ottr", "project-skills", project);
	try {
		if (!statSync(dir).isDirectory()) return null;
		// A symlink at any path level must still land inside the home's own real
		// path — the same real-vs-real guard the plugin dirs use.
		if (!withinPkg(realpathSync(home), realpathSync(dir))) return null;
	} catch {
		return null;
	}
	return dir;
}

/** The plugin names alate's per-project plugins list for a board project names:
 * `<home>/.ottr/plugins/<P>.txt`, one npm package name per line; `#` starts a
 * comment and blank lines drop out. Null without a project, an unsafe project
 * name, or an unreadable file — an absent file means "no per-project filter",
 * so the unscoped set stays. */
export function projectPluginNames(
	home: string,
	project: string | null | undefined,
): Set<string> | null {
	if (!project || !PROJECT.test(project)) return null;
	let raw: string;
	try {
		raw = readFileSync(
			join(home, ".ottr", "plugins", `${project}.txt`),
			"utf8",
		);
	} catch {
		return null;
	}
	const names = new Set<string>();
	for (const line of raw.split(/\r?\n/)) {
		const hash = line.indexOf("#");
		const name = (hash === -1 ? line : line.slice(0, hash)).trim();
		if (name !== "") names.add(name);
	}
	return names;
}

/** The overlay's `customDirectories` for one run: the enabled plugins' skill dirs —
 * filtered to the names of the project's plugins list when `home` holds one — plus
 * the project's own skill folder appended after them. Without a project, an unsafe
 * project name, or without alate's per-project files this is exactly the unscoped
 * `pluginSkillDirs` list. */
export function overlaySkillDirs(
	home: string,
	project: string | null | undefined,
): string[] {
	let entries = pluginSkillEntries(home);
	const names = projectPluginNames(home, project);
	if (names) entries = entries.filter((entry) => names.has(entry.name));
	const dirs = [...new Set(entries.map((entry) => entry.dir))].sort();
	const custom = projectSkillDir(home, project);
	return custom === null ? dirs : [...dirs, custom];
}

/** The `--config` overlay body. Two jobs (docs/specs/turn-home-plugin-skills.md):
 * 1. `skills.customDirectories` — omp scans each listed directory's direct children for
 *    `SKILL.md` (the directory's own SKILL.md does not load, so the list holds each
 *    plugin's skill directory, never a plugin package).
 * 2. The three project-level skill enables pinned off — a worker-planted
 *    `.agents/skills/<name>/SKILL.md` in the run's cwd otherwise loads into the next
 *    board-side run (verified live on omp 18.15.0, 2026-11-10); the same pin covers
 *    `.omp/agent/skills` and `.claude/skills`, which omp happens to keep off by
 *    default. The user levels stay untouched, so the home's own skills keep loading.
 * Paths are JSON double-quoted scalars, valid YAML on every platform. */
export function pluginSkillsOverlayYaml(dirs: readonly string[]): string {
	const lines = [
		"skills:",
		"  enableAgentsProject: false",
		"  enableClaudeProject: false",
		"  enablePiProject: false",
	];
	if (dirs.length > 0)
		lines.push(
			"  customDirectories:",
			...dirs.map((dir) => `    - ${JSON.stringify(dir)}`),
		);
	return [...lines, ""].join("\n");
}

/** Which container spawns omp for a run; it picks the overlay dir. */
export type PluginSkillsRun =
	| { kind: "board" }
	| { kind: "worker" }
	| { kind: "vm"; sessionDir: string };

/** The overlay dir for one run's dispatch (OTTR-1020 validation). A board-side run
 * spawns omp in the server container, so its overlay lives on the server-only state
 * volume — compose sets OTTR_SERVER_DATA_DIR (/app/.tasks/projects, which no worker
 * mounts); a dev board or scratch run without the env uses its own per-install tmp
 * dir (0700). Never the worker-shared data dir: a classic worker mounts it read-write,
 * and a rename-over between the board's write and omp's read of the path would turn
 * the project-skill pins (and, planted, `mcp.enableProjectConfig`) back on for that
 * run. Worker and VM runs spawn omp in a container that mounts the shared data dir
 * (the VM copy-in mounts only the project dir holding the session dir), so their
 * overlays must stay there; their plant window remains the accepted residual
 * (docs/specs/turn-home-plugin-skills.md). */
export function pluginSkillsOverlayDirFor(
	env: Record<string, string | undefined>,
	run: PluginSkillsRun,
): string {
	if (run.kind === "vm") return resolve(dirname(run.sessionDir));
	if (run.kind === "worker") return overlayDirFor(env);
	const dir = env.OTTR_SERVER_DATA_DIR?.trim();
	return dir ? resolve(dir) : join(tmpdir(), "ottr-board-overlays");
}

/** One file per home and project, named by the sha256 of the home path — plus the
 * project, `\0`-joined, when one is set: a board-side run (board home) and a worker
 * run (shared home or its layer) already sit in different dirs, and even where two
 * runs share an anchor, two projects on one home write two files, so no spawn can
 * overwrite another's directory list between its write and its omp read. A pinned
 * run keeps its own file's content for its whole life
 * (docs/specs/turn-home-plugin-skills.md). */
export function pluginSkillsOverlayPath(
	env: Record<string, string | undefined>,
	home: string,
	project?: string | null,
	run: PluginSkillsRun = { kind: "worker" },
): string {
	const hash = createHash("sha256")
		.update(project ? `${home}\0${project}` : home)
		.digest("hex")
		.slice(0, 16);
	return join(
		pluginSkillsOverlayDirFor(env, run),
		`omp-plugin-skills-${hash}.yml`,
	);
}

/** Writes the overlay only when its content differs. The project-skill pins ride on
 * every run, plugin skills or none, so the worktree stays inert even when the home
 * carries no plugins. `project` is the spawn's `OTTR_PROJECT` value (a run without
 * one passes nothing): alate's per-project files for it under the same `home` scope
 * the directory list (overlaySkillDirs), everything else stays as documented. A
 * worker-shared anchor is worker-writable, so a planted file converges back to the
 * computed content here, before the spawn reads it — the accepted residual the board
 * dispatch leaves behind by writing to the server-only dir. A write failure fails
 * the run loudly. */
export function ensurePluginSkillsOverlay(
	env: Record<string, string | undefined>,
	home: string,
	project?: string | null,
	run: PluginSkillsRun = { kind: "worker" },
): string | null {
	const dirs = overlaySkillDirs(home, project);
	const anchor = pluginSkillsOverlayDirFor(env, run);
	// The board anchors (server-only state dir, per-install tmp) may not exist yet;
	// the worker data dir is a mount point and the VM's anchor holds the session dir,
	// so the recursive mkdir is a no-op there.
	mkdirSync(anchor, { recursive: true, mode: 0o700 });
	const path = pluginSkillsOverlayPath(env, home, project, run);
	const content = pluginSkillsOverlayYaml(dirs);
	try {
		const cur = readBelow(anchor, path, 65536);
		if (cur !== null && cur.toString("utf8") === content) return path;
	} catch {
		// a planted symlink: fall through to the write, which refuses it too
	}
	// R5-1: the data dir and the home volume are worker-writable, so this write must
	// follow no symlink — a plant at the leaf or a parent fails the spawn instead.
	writeBelow(anchor, path, content);
	return path;
}
