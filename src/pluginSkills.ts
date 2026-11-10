import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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
 * the worktree stays untrusted and enters no path here.
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

/** The enabled plugins' skill directories under `home`, absolute, deduplicated, sorted.
 * Fail-soft like `tools.ts readUserLayer`: a missing lock, a disabled plugin, a package
 * without `pi.skills`, a skill dir that is not a directory — each drops its entry, the
 * rest still loads. A plugin name or a `pi.skills` entry that resolves outside the
 * plugin's own package directory skips the plugin. */
export function pluginSkillDirs(home: string): string[] {
	const pluginsDir = join(home, ".omp", "plugins");
	const lock = readJsonObject(join(pluginsDir, "omp-plugins.lock.json"));
	const plugins = lock?.plugins;
	if (typeof plugins !== "object" || plugins === null) return [];
	const dirs = new Set<string>();
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
			} catch {
				continue;
			}
			dirs.add(dir);
		}
	}
	return [...dirs].sort();
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

/** One file per home, named by the home path's sha256: a board-side run (board home)
 * and a worker run (shared home or its layer) share the data dir but never share a
 * file, so the two homes cannot overwrite each other's directory list and a pinned run
 * keeps its own home's content for its whole life
 * (docs/specs/turn-home-plugin-skills.md). */
export function pluginSkillsOverlayPath(
	env: Record<string, string | undefined>,
	home: string,
): string {
	const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
	return join(overlayDirFor(env), `omp-plugin-skills-${hash}.yml`);
}

/** Writes the overlay only when its content differs. The project-skill pins ride on
 * every run, plugin skills or none, so the worktree stays inert even when the home
 * carries no plugins. The data dir is worker-writable, so a planted file converges
 * back to the computed content here, before the spawn reads it — the same accepted
 * residual as the memory overlay. A write failure fails the run loudly. */
export function ensurePluginSkillsOverlay(
	env: Record<string, string | undefined>,
	home: string,
): string | null {
	const dirs = pluginSkillDirs(home);
	const anchor = overlayDirFor(env);
	// The tmp fallback dir is the board's own (0700); the data dir is a mount point.
	if (!env.OTTR_DATA_DIR) mkdirSync(anchor, { recursive: true, mode: 0o700 });
	const path = pluginSkillsOverlayPath(env, home);
	const content = pluginSkillsOverlayYaml(dirs);
	try {
		const cur = readBelow(anchor, path, 65536);
		if (cur !== null && cur.toString("utf8") === content) return path;
	} catch {
		// a worker-planted symlink: fall through to the write, which refuses it too
	}
	// R5-1: the data dir and the home volume are worker-writable, so this write must
	// follow no symlink — a plant at the leaf or a parent fails the spawn instead.
	writeBelow(anchor, path, content);
	return path;
}
