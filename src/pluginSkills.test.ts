import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	ensurePluginSkillsOverlay,
	overlaySkillDirs,
	pluginSkillDirs,
	pluginSkillsOverlayPath,
	pluginSkillsOverlayYaml,
	projectPluginNames,
} from "./pluginSkills.ts";

/** A fixture home: one enabled plugin with `pi.skills`, plus whatever the caller adds. */
function writePlugin(home: string, name: string, pkg: object): string {
	const pkgDir = join(
		home,
		".omp",
		"plugins",
		"node_modules",
		...name.split("/"),
	);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
	return pkgDir;
}

function writeLock(home: string, plugins: object): void {
	const dir = join(home, ".omp", "plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "omp-plugins.lock.json"),
		JSON.stringify({ plugins }),
	);
}

describe("pluginSkillDirs", () => {
	test("an enabled plugin's pi.skills entries become absolute sorted dirs", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-plugins-"));
		try {
			const pkgDir = writePlugin(home, "@acme/cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills", "wizard"), { recursive: true });
			writeLock(home, {
				"@acme/cool": {
					version: "1.0.0",
					enabledFeatures: null,
					enabled: true,
				},
			});
			expect(pluginSkillDirs(home)).toEqual([join(pkgDir, "skills")]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a disabled plugin, a plugin without pi.skills and a missing package drop out", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-plugins-"));
		try {
			writePlugin(home, "off", { pi: { skills: ["./skills"] } });
			writePlugin(home, "noskills", {
				pi: { extensions: ["./ext.js"] },
			});
			writeLock(home, {
				off: { version: "1", enabledFeatures: null, enabled: false },
				noskills: { version: "1", enabledFeatures: null, enabled: true },
				ghost: { version: "1", enabledFeatures: null, enabled: true },
			});
			expect(pluginSkillDirs(home)).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a missing skill dir, a plain file entry and a foreign shape drop their entry", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-plugins-"));
		try {
			const pkgDir = writePlugin(home, "mixed", {
				pi: { skills: ["./missing", "./skills", "./loose.md", 42, null] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeFileSync(join(pkgDir, "loose.md"), "x");
			writeLock(home, {
				mixed: { version: "1", enabledFeatures: null, enabled: true },
			});
			expect(pluginSkillDirs(home)).toEqual([join(pkgDir, "skills")]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a name or entry that escapes the plugin package skips the plugin", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-plugins-"));
		try {
			writeLock(home, {
				"../escapee": { version: "1", enabledFeatures: null, enabled: true },
			});
			writePlugin(home, "abs", { pi: { skills: ["/etc"] } });
			expect(pluginSkillDirs(home)).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a pi.skills dir that symlinks out of the plugin package skips", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-plugins-"));
		try {
			const pkgDir = writePlugin(home, "linker", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(home, "outside", "evil"), { recursive: true });
			writeFileSync(join(home, "outside", "evil", "SKILL.md"), "x\n");
			symlinkSync(join(home, "outside"), join(pkgDir, "skills"));
			writeLock(home, {
				linker: { version: "1", enabledFeatures: null, enabled: true },
			});
			expect(pluginSkillDirs(home)).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("no lock or a corrupt lock yields an empty list", () => {
		const home = mkdtempSync(join(tmpdir(), "ottr-plugins-"));
		try {
			expect(pluginSkillDirs(home)).toEqual([]);
			const lockDir = join(home, ".omp", "plugins");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(join(lockDir, "omp-plugins.lock.json"), "{");
			expect(pluginSkillDirs(home)).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("pluginSkillsOverlayYaml", () => {
	const pins =
		"skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false";
	test("paths are JSON double-quoted scalars under skills.customDirectories", () => {
		expect(pluginSkillsOverlayYaml(["/root/x/skills"])).toBe(
			`${pins}\n  customDirectories:\n    - "/root/x/skills"\n`,
		);
	});

	test("no plugin dirs keeps only the project-skill pins", () => {
		expect(pluginSkillsOverlayYaml([])).toBe(`${pins}\n`);
	});
});

describe("ensurePluginSkillsOverlay", () => {
	test("a home without plugin skills writes the pins-only overlay", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-empty-"));
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		try {
			const path = ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home);
			expect(path).toBe(pluginSkillsOverlayPath({ OTTR_DATA_DIR: dir }, home));
			expect(readFileSync(path!, "utf8")).toBe(
				"skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("creates the overlay with the plugin dirs and converges stale content", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-write-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			const path = ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home)!;
			expect(path).toBe(pluginSkillsOverlayPath({ OTTR_DATA_DIR: dir }, home));
			expect(readFileSync(path, "utf8")).toBe(
				`skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n  customDirectories:\n    - ${JSON.stringify(join(pkgDir, "skills"))}\n`,
			);
			// A stale file converges back on the next spawn.
			writeFileSync(path, "skills:\n  customDirectories: []\n");
			expect(ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home)).toBe(
				path,
			);
			expect(readFileSync(path, "utf8")).toBe(
				`skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n  customDirectories:\n    - ${JSON.stringify(join(pkgDir, "skills"))}\n`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("two homes write two files; neither clobbers the other", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-two-"));
		try {
			const boardHome = join(dir, "board-home");
			const sharedHome = join(dir, "shared-home");
			const homes: [string, string][] = [
				[boardHome, "pony"],
				[sharedHome, "cool"],
			];
			for (const [home, plugin] of homes) {
				const pkgDir = writePlugin(home, plugin, {
					pi: { skills: ["./skills"] },
				});
				mkdirSync(join(pkgDir, "skills"), { recursive: true });
				writeLock(home, {
					[plugin]: { version: "1", enabledFeatures: null, enabled: true },
				});
			}
			const boardFile = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dir },
				boardHome,
			)!;
			const sharedFile = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dir },
				sharedHome,
			)!;
			// A board-side run and a worker run share the data dir, not the file.
			expect(boardFile).not.toBe(sharedFile);
			expect(readFileSync(boardFile, "utf8")).toContain("pony");
			expect(readFileSync(boardFile, "utf8")).not.toContain("cool");
			ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, sharedHome);
			expect(readFileSync(boardFile, "utf8")).toContain("pony");
			expect(readFileSync(sharedFile, "utf8")).not.toContain("pony");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a matching overlay is left untouched: no rewrite touches the mtime", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-same-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			const path = ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home)!;
			utimesSync(path, new Date(1000), new Date(1000));
			ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home);
			expect(statSync(path).mtimeMs).toBe(1000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a worker-planted symlink at the overlay path fails the write, never the target", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-plant-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			const target = join(dir, "target.yml");
			writeFileSync(target, "keep me\n");
			symlinkSync(
				target,
				pluginSkillsOverlayPath({ OTTR_DATA_DIR: dir }, home),
			);
			expect(() =>
				ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home),
			).toThrow(/refusing/);
			expect(readFileSync(target, "utf8")).toBe("keep me\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("creates the data dir when missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-mkdir-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			const data = join(dir, "data");
			const path = ensurePluginSkillsOverlay({ OTTR_DATA_DIR: data }, home)!;
			expect(readFileSync(path, "utf8")).toContain("customDirectories");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("per-project scoping", () => {
	function writeProjectSkill(
		home: string,
		project: string,
		skill: string,
	): string {
		const dir = join(home, ".ottr", "project-skills", project, skill);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\ndescription: probe\n---\nbody\n",
		);
		return join(home, ".ottr", "project-skills", project);
	}

	function writePluginsList(home: string, project: string, text: string): void {
		mkdirSync(join(home, ".ottr", "plugins"), { recursive: true });
		writeFileSync(join(home, ".ottr", "plugins", `${project}.txt`), text);
	}

	test("the project's skill folder rides after the plugin dirs in the overlay", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-proj-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			const projectDir = writeProjectSkill(home, "proj", "bundle-skill");
			const path = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dir },
				home,
				"proj",
			)!;
			expect(readFileSync(path, "utf8")).toBe(
				`skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n  customDirectories:\n    - ${JSON.stringify(join(pkgDir, "skills"))}\n    - ${JSON.stringify(projectDir)}\n`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without per-project files the overlay stays byte-identical to the unscoped one", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-noproj-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			const scoped = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dir },
				home,
				"proj",
			)!;
			const unscoped = ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home)!;
			expect(readFileSync(scoped, "utf8")).toBe(readFileSync(unscoped, "utf8"));
			expect(readFileSync(scoped, "utf8")).toBe(
				pluginSkillsOverlayYaml(pluginSkillDirs(home)),
			);
			expect(overlaySkillDirs(home, null)).toEqual(pluginSkillDirs(home));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the plugins list filters the enabled plugins' dirs; unknown names drop silently", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-filter-"));
		const home = join(dir, "home");
		try {
			const coolDir = join(
				writePlugin(home, "cool", { pi: { skills: ["./skills"] } }),
				"skills",
			);
			mkdirSync(coolDir, { recursive: true });
			const ponyDir = join(
				writePlugin(home, "pony", { pi: { skills: ["./skills"] } }),
				"skills",
			);
			mkdirSync(ponyDir, { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
				pony: { version: "1", enabledFeatures: null, enabled: true },
			});
			writePluginsList(home, "proj", "# bundle\n\ncool\nghost\n");
			const projectDir = writeProjectSkill(home, "proj", "bundle-skill");
			const path = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dir },
				home,
				"proj",
			)!;
			const content = readFileSync(path, "utf8");
			expect(content).toContain(JSON.stringify(coolDir));
			expect(content).not.toContain(JSON.stringify(ponyDir));
			expect(content).toContain(JSON.stringify(projectDir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("comments, blank lines and CRLF parse out of the plugins list", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-parse-"));
		const home = join(dir, "home");
		try {
			writePluginsList(
				home,
				"proj",
				"# head\n\n  spaced-name  \ntrailing# note\r\n@scope/pkg\r\n",
			);
			expect(projectPluginNames(home, "proj")).toEqual(
				new Set(["spaced-name", "trailing", "@scope/pkg"]),
			);
			expect(projectPluginNames(home, null)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a comment-only list filters every plugin dir out, the project dir still rides", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-empty-"));
		const home = join(dir, "home");
		try {
			const pkgDir = writePlugin(home, "cool", {
				pi: { skills: ["./skills"] },
			});
			mkdirSync(join(pkgDir, "skills"), { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
			});
			writePluginsList(home, "proj", "# nothing left\n");
			const projectDir = writeProjectSkill(home, "proj", "bundle-skill");
			const path = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dir },
				home,
				"proj",
			)!;
			expect(readFileSync(path, "utf8")).toBe(
				`skills:\n  enableAgentsProject: false\n  enableClaudeProject: false\n  enablePiProject: false\n  customDirectories:\n    - ${JSON.stringify(projectDir)}\n`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an absent list file filters nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-nofilter-"));
		const home = join(dir, "home");
		try {
			const coolDir = join(
				writePlugin(home, "cool", { pi: { skills: ["./skills"] } }),
				"skills",
			);
			mkdirSync(coolDir, { recursive: true });
			const ponyDir = join(
				writePlugin(home, "pony", { pi: { skills: ["./skills"] } }),
				"skills",
			);
			mkdirSync(ponyDir, { recursive: true });
			writeLock(home, {
				cool: { version: "1", enabledFeatures: null, enabled: true },
				pony: { version: "1", enabledFeatures: null, enabled: true },
			});
			const content = readFileSync(
				ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home, "proj")!,
				"utf8",
			);
			expect(content).toContain(JSON.stringify(coolDir));
			expect(content).toContain(JSON.stringify(ponyDir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a project-skills dir that symlinks out of the home drops out", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-escape-"));
		const outside = mkdtempSync(join(tmpdir(), "ottr-plugins-outside-"));
		const home = join(dir, "home");
		try {
			mkdirSync(join(home, ".ottr", "project-skills"), { recursive: true });
			symlinkSync(outside, join(home, ".ottr", "project-skills", "proj"));
			const content = readFileSync(
				ensurePluginSkillsOverlay({ OTTR_DATA_DIR: dir }, home, "proj")!,
				"utf8",
			);
			expect(content).not.toContain("project-skills");
			expect(projectPluginNames(home, "../victim")).toBeNull();
			expect(overlaySkillDirs(home, "../victim")).toEqual(
				pluginSkillDirs(home),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("two projects on one home write two distinct overlay files", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-two-"));
		const home = join(dir, "home");
		try {
			const dirA = writeProjectSkill(home, "a", "skill-a");
			const dirB = writeProjectSkill(home, "b", "skill-b");
			const env = { OTTR_DATA_DIR: dir };
			const pathA = ensurePluginSkillsOverlay(env, home, "a")!;
			const pathB = ensurePluginSkillsOverlay(env, home, "b")!;
			// One file per home and project: B's spawn can never overwrite A's
			// directory list between A's write and A's omp read.
			expect(pathA).not.toBe(pathB);
			const contentA = readFileSync(pathA, "utf8");
			const contentB = readFileSync(pathB, "utf8");
			expect(contentA).toContain(JSON.stringify(dirA));
			expect(contentA).not.toContain(JSON.stringify(dirB));
			expect(contentB).toContain(JSON.stringify(dirB));
			expect(contentB).not.toContain(JSON.stringify(dirA));
			// Stable per home and project: a re-write lands on the same file.
			expect(ensurePluginSkillsOverlay(env, home, "a")).toBe(pathA);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the overlay file name separates projects, the no-project name stays", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-name-"));
		const home = join(dir, "home");
		try {
			const env = { OTTR_DATA_DIR: dir };
			expect(pluginSkillsOverlayPath(env, home, "a")).not.toBe(
				pluginSkillsOverlayPath(env, home, "b"),
			);
			expect(pluginSkillsOverlayPath(env, home, "a")).not.toBe(
				pluginSkillsOverlayPath(env, home),
			);
			// A run without a project keeps today's name: the home path alone.
			expect(pluginSkillsOverlayPath(env, home)).toBe(
				pluginSkillsOverlayPath(env, home, null),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("overlay dir per dispatch", () => {
	test("a board-side run's overlay lands outside the worker-shared data dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-board-"));
		try {
			const dataDir = join(dir, "data");
			const stateDir = join(dir, "server-state");
			mkdirSync(dataDir, { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			const home = join(dir, "home");
			mkdirSync(home, { recursive: true });
			// The server env holds both (compose: /data on the worker-shared
			// volume, OTTR_SERVER_DATA_DIR on ottr-state, which no worker
			// mounts). The board-side overlay must not sit where a classic
			// worker can rename-over it between the board's write and omp's
			// read (OTTR-1020 validation).
			const env = { OTTR_DATA_DIR: dataDir, OTTR_SERVER_DATA_DIR: stateDir };
			const path = ensurePluginSkillsOverlay(env, home, null, {
				kind: "board",
			})!;
			expect(resolve(path).startsWith(resolve(dataDir) + sep)).toBe(false);
			expect(resolve(path).startsWith(resolve(stateDir) + sep)).toBe(true);
			expect(path).toBe(
				pluginSkillsOverlayPath(env, home, null, { kind: "board" }),
			);
			// Same bytes as ever: the dispatch moves the file, not the content.
			expect(readFileSync(path, "utf8")).toBe(pluginSkillsOverlayYaml([]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without OTTR_SERVER_DATA_DIR a board overlay falls back to the board's own tmp dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-boardtmp-"));
		try {
			const dataDir = join(dir, "data");
			mkdirSync(dataDir, { recursive: true });
			const home = join(dir, "home");
			mkdirSync(home, { recursive: true });
			// A dev board or scratch run sets no server state dir; its overlay
			// still stays out of the worker-shared data dir.
			const path = ensurePluginSkillsOverlay(
				{ OTTR_DATA_DIR: dataDir },
				home,
				null,
				{ kind: "board" },
			)!;
			expect(resolve(path).startsWith(resolve(dataDir) + sep)).toBe(false);
			const anchor = join(tmpdir(), "ottr-board-overlays");
			expect(resolve(path).startsWith(anchor + sep)).toBe(true);
			// The tmp anchor is the board's own (0700), like the memory
			// overlay's per-install tmp dir.
			expect(statSync(anchor).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("worker and vm runs keep the shared anchors omp reads in their own container", () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-plugins-wv-"));
		try {
			const dataDir = join(dir, "data");
			mkdirSync(join(dataDir, "proj", "sessions"), { recursive: true });
			const home = join(dir, "home");
			mkdirSync(home, { recursive: true });
			const env = { OTTR_DATA_DIR: dataDir };
			// A worker container mounts /data and reads the path there.
			const worker = ensurePluginSkillsOverlay(env, home, null, {
				kind: "worker",
			})!;
			expect(resolve(worker).startsWith(resolve(dataDir) + sep)).toBe(true);
			// vm-runner copies in only the project dir holding the session dir.
			const vm = ensurePluginSkillsOverlay(env, home, null, {
				kind: "vm",
				sessionDir: join(dataDir, "proj", "sessions"),
			})!;
			expect(vm).toBe(
				pluginSkillsOverlayPath(env, home, null, {
					kind: "vm",
					sessionDir: join(dataDir, "proj", "sessions"),
				}),
			);
			expect(resolve(vm).startsWith(resolve(join(dataDir, "proj")) + sep)).toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
