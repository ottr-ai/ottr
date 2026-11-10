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
import { join } from "node:path";
import {
	ensurePluginSkillsOverlay,
	pluginSkillDirs,
	pluginSkillsOverlayYaml,
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
			expect(path).toBe(join(dir, "omp-plugin-skills.yml"));
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
			expect(path).toBe(join(dir, "omp-plugin-skills.yml"));
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
			symlinkSync(target, join(dir, "omp-plugin-skills.yml"));
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
