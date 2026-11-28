import { Database } from "bun:sqlite";
import { describe, expect, jest, test } from "bun:test";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	chownSync,
	copyFileSync,
	existsSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureGitEnv } from "./gitRepoEnv.ts";
import { readLayerUse } from "./layers.ts";
import type { LocalMergeIdentity } from "./mergeTurnUid.ts";
import { configOverlayPaths, startRun } from "./runner.ts";
import { runMarkerPath } from "./tmpsweep.ts";
import { projectTurnUid } from "./turnUid.ts";

const project = "ottr";
const ids = projectTurnUid(project);
const callerUid = process.getuid?.();
const callerGid = process.getgid?.();
const identityTest =
	process.platform === "linux" &&
	(callerUid === 0 || (callerUid === ids.uid && callerGid === ids.gid))
		? test
		: test.skip;
// A same-uid process cannot prove a daemon/project permission boundary.
const rootTest =
	process.platform === "linux" && callerUid === 0 ? test : test.skip;
const githubKeys = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
] as const;
const githubKeySet: ReadonlySet<string> = new Set(githubKeys);

interface Fixture {
	root: string;
	pinned: boolean;
	boardHome: string;
	privateStore: string;
	sharedHome: string;
	credentialSnapshot: string;
	projectHome: string;
	projectLayer: string;
	sharedRoots: string[];
	bun: string;
	marker: string;
	trustedMarker: string;
	endpoint: string;
	trace: string;
	requests: string[];
	sessionDir: string;
	dotenvPaths: string[];
	dotenvContent: string;
	options: {
		cwd: string;
		project: string;
		prompt: string;
		sessionDir: string;
		resumeId: null;
		extensionPath: null;
		memoryConfigPath: null;
		dataRoot: string;
		logPath: string;
		localMerge: LocalMergeIdentity;
		authBroker: { url: string; token: string };
		env: Record<string, string>;
	};
	cleanup(): Promise<void>;
}

function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function ownTree(path: string) {
	const st = lstatSync(path);
	if (st.isSymbolicLink())
		throw new Error("fixture ownership must not follow links");
	chownSync(path, ids.uid, ids.gid);
	if (st.isDirectory()) {
		for (const entry of readdirSync(path)) ownTree(join(path, entry));
	}
}

function gitEnv(home: string): Record<string, string> {
	const env = fixtureGitEnv();
	// A fixture must not inherit command-scope Git configuration from the host.
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_CONFIG_") || githubKeySet.has(key)) delete env[key];
	}
	return {
		...env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		GH_CONFIG_DIR: join(home, ".config", "gh"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function checkedGit(cwd: string, home: string, args: string[]) {
	const child = spawnSync("git", args, {
		cwd,
		env: gitEnv(home),
		encoding: "utf8",
	});
	if (child.error) throw child.error;
	if (child.status !== 0)
		throw new Error(`fixture Git failed (${child.status}): ${child.stderr}`);
	return child.stdout.trim();
}

// Every dotenv name Bun can load from a cwd: BUN_ENV or NODE_ENV picks one mode.
const dotenvNames = [
	".env",
	".env.local",
	...["development", "production", "test"].flatMap((mode) => [
		`.env.${mode}`,
		`.env.${mode}.local`,
	]),
];

function fixture(pinned: boolean): Fixture {
	// Assumptions: only root Linux merges isolate, and all readers use the prepared env.
	// /tmp keeps every ancestor accessible even with a private host TMPDIR.
	const root = mkdtempSync("/tmp/ottr-merge-plant-test-");
	chmodSync(root, 0o755);
	const boardHome = join(root, "board");
	const sharedHome = join(root, "shared");
	const homesRoot = join(root, "turn-homes");
	const projectHome = join(homesRoot, project, "home");
	const layerId = "trusted-merge-fixture";
	const projectLayer = join(homesRoot, project, "layers", layerId);
	const boardLayer = join(boardHome, ".alate", "layers", layerId);
	const workspaceRoot = join(root, "workspace");
	const cwd = join(workspaceRoot, project);
	const dataRoot = join(root, "data");
	const sessionDir = join(dataRoot, project, "sessions");
	const trace = join(root, "plant.trace");
	write(trace, "");
	chmodSync(trace, 0o666);
	const requests: string[] = [];
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(await request.text());
			return new Response("fixture");
		},
	});
	const endpoint = `http://127.0.0.1:${listener.port}/merge-plant`;
	// The probe checks this explicit grant without a provider request.
	const authBroker = {
		url: `http://127.0.0.1:${listener.port}/auth-broker`,
		token: crypto.randomUUID(),
	};
	const marker = `plant-${crypto.randomUUID()}`;
	const trustedMarker = `trusted-${crypto.randomUUID()}`;
	const dotenvPaths = dotenvNames.map((name) => join(cwd, name));
	// A loaded file would add back each override below, and GIT_CONFIG_GLOBAL then
	// reaches the planted credential helper.
	const dotenvContent = [
		"# Synthetic merge fixture",
		...githubKeys.map((key) => `${key}=synthetic-${crypto.randomUUID()}`),
		`XDG_CONFIG_HOME=${join(projectHome, ".config")}`,
		`GH_CONFIG_DIR=${join(projectHome, ".config", "gh")}`,
		`GIT_CONFIG_GLOBAL=${join(projectHome, ".gitconfig")}`,
		`PI_PACKAGE_DIR=${join(projectHome, ".omp")}`,
		"OMP_PROFILE=planted",
		"",
	].join("\n");
	// The host Bun can live below a private root home. Give the dropped probe a real executable.
	const bun = join(root, "probe-bun");
	copyFileSync(realpathSync(process.execPath), bun);
	chmodSync(bun, 0o755);
	const payload = join(root, "plant.mjs");
	write(
		payload,
		`import { appendFileSync } from "node:fs";
export async function plant(kind) {
 appendFileSync(${JSON.stringify(trace)}, kind + "\\n");
 await fetch(${JSON.stringify(endpoint)}, { method: "POST", body: kind });
}
if (process.argv[2]) await plant(process.argv[2]);
`,
	);
	function plant(home: string) {
		const helper = `! '${bun}' '${payload}' '${marker}-git-helper'`;
		const alias = `! '${bun}' '${payload}' '${marker}-git-alias'`;
		write(
			join(home, ".gitconfig"),
			`[user]\n name = Poisoned Merge\n email = poisoned@example.invalid\n[credential]\n helper = ${helper}\n[alias]\n merge-plant = ${alias}\n[core]\n pager = ${bun} ${payload} ${marker}-git-pager\n`,
		);
		write(
			join(home, ".config", "git", "config"),
			`[credential]\n helper = ${helper}\n`,
		);
		write(join(home, ".config", "gh", "config.yml"), `fixture: ${marker}\n`);
		write(join(home, ".omp", "agent", "config.yml"), `fixture: ${marker}\n`);
		write(join(home, ".omp", "config.yml"), `fixture: ${marker}\n`);
		for (const path of [
			join(home, ".omp", "extensions", "plant.mjs"),
			join(home, ".omp", "agent", "extensions", "plant.mjs"),
			join(
				home,
				".omp",
				"plugins",
				"node_modules",
				"fixture-plant",
				"tools",
				"plant.mjs",
			),
		]) {
			write(
				path,
				`import { plant } from ${JSON.stringify(pathToFileURL(payload).href)};\nawait plant(${JSON.stringify(marker)});\n`,
			);
		}
		write(join(home, ".omp", "agent", "skills", "plant", "SKILL.md"), marker);
		write(
			join(home, ".omp", "plugins", "omp-plugins.lock.json"),
			JSON.stringify({ plugins: { "fixture-plant": { enabled: true } } }),
		);
		write(
			join(
				home,
				".omp",
				"plugins",
				"node_modules",
				"fixture-plant",
				"package.json",
			),
			JSON.stringify({ name: "fixture-plant", pi: { skills: ["skills"] } }),
		);
		write(
			join(
				home,
				".omp",
				"plugins",
				"node_modules",
				"fixture-plant",
				"skills",
				"plant",
				"SKILL.md",
			),
			marker,
		);
	}
	for (const home of [sharedHome, projectHome, projectLayer]) {
		plant(home);
		ownTree(home);
	}
	for (const home of [boardHome, ...(pinned ? [boardLayer] : [])]) {
		write(
			join(home, ".gitconfig"),
			"[user]\n name = Trusted Merge\n email = trusted@example.invalid\n",
		);
		write(join(home, ".omp", "auth-broker.token"), crypto.randomUUID());
		write(
			join(home, ".omp", "agent", "config.yml"),
			`fixture: ${trustedMarker}\n`,
		);
		write(
			join(home, ".omp", "agent", "extensions", "trusted.mjs"),
			`export const fixture = ${JSON.stringify(trustedMarker)};\n`,
		);
		write(
			join(home, ".omp", "agent", "skills", "trusted", "SKILL.md"),
			trustedMarker,
		);
		write(
			join(home, ".omp", "plugins", "omp-plugins.lock.json"),
			JSON.stringify({ plugins: { "fixture-trusted": { enabled: true } } }),
		);
		write(
			join(
				home,
				".omp",
				"plugins",
				"node_modules",
				"fixture-trusted",
				"package.json",
			),
			JSON.stringify({ name: "fixture-trusted", pi: { skills: ["skills"] } }),
		);
		write(
			join(
				home,
				".omp",
				"plugins",
				"node_modules",
				"fixture-trusted",
				"tools",
				"trusted.mjs",
			),
			`export const pluginFixture = ${JSON.stringify(trustedMarker)};\n`,
		);
		write(
			join(
				home,
				".omp",
				"plugins",
				"node_modules",
				"fixture-trusted",
				"skills",
				"trusted",
				"SKILL.md",
			),
			trustedMarker,
		);
	}
	const privateStore = join(boardHome, ".omp", "agent", "agent.db");
	const db = new Database(privateStore);
	db.exec("CREATE TABLE fixture_state (value TEXT NOT NULL)");
	db.query("INSERT INTO fixture_state VALUES (?)").run(trustedMarker);
	// Keep this schema aligned with the real omp fixture in login.test.ts.
	db.exec(`CREATE TABLE IF NOT EXISTS auth_credentials (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		provider TEXT NOT NULL,
		credential_type TEXT NOT NULL,
		data TEXT NOT NULL,
		disabled_cause TEXT DEFAULT NULL,
		identity_key TEXT DEFAULT NULL,
		created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
		updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
	)`);
	for (const provider of ["anthropic", "openai-codex"]) {
		db.query(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, 'acct-1')",
		).run(
			provider,
			JSON.stringify({
				access: crypto.randomUUID(),
				refresh: crypto.randomUUID(),
				expires: Date.now() + 8 * 3600_000,
				authorizedAt: Date.now(),
			}),
		);
	}
	const credentialSnapshot = JSON.stringify(
		db.query("SELECT * FROM auth_credentials ORDER BY id").all(),
	);
	db.close();
	chmodSync(privateStore, 0o600);
	chmodSync(boardHome, 0o700);
	// Keep the legacy store path valid so a configuration regression does not fail on an unrelated missing database.
	const sharedStore = join(sharedHome, ".omp", "agent", "agent.db");
	copyFileSync(privateStore, sharedStore);
	chownSync(sharedStore, ids.uid, ids.gid);
	for (const home of [projectHome, projectLayer]) {
		const link = join(home, ".omp", "agent", "agent.db");
		symlinkSync(sharedStore, link);
		lchownSync(link, ids.uid, ids.gid);
	}
	if (pinned) {
		symlinkSync(boardLayer, join(boardHome, ".alate", "current"));
		const sharedLayer = join(sharedHome, ".alate", "layers", layerId);
		plant(sharedLayer);
		ownTree(sharedLayer);
		symlinkSync(sharedLayer, join(sharedHome, ".alate", "current"));
	}
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const provisionPaths = {
		passwd: join(root, "passwd"),
		group: join(root, "group"),
	};
	write(provisionPaths.passwd, "");
	write(provisionPaths.group, "");
	checkedGit(cwd, boardHome, ["init", "-q"]);
	checkedGit(cwd, boardHome, [
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"fixture",
	]);
	for (const path of dotenvPaths) write(path, dotenvContent);
	write(join(boardHome, ".env"), dotenvContent);
	if (pinned) write(join(boardLayer, ".env"), dotenvContent);
	const previous = new Map(
		[
			"OTTR_BOARD_OMP_HOME",
			"OTTR_SERVER_DATA_DIR",
			"OTTR_TURN_CACHE_ROOT",
			"HOME",
			"XDG_CONFIG_HOME",
			"GH_CONFIG_DIR",
			"OMP_AUTH_BROKER_URL",
			"OMP_AUTH_BROKER_TOKEN",
			"GIT_CONFIG_GLOBAL",
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
			...githubKeys,
		].map((key) => [key, process.env[key]]),
	);
	process.env.OTTR_BOARD_OMP_HOME = boardHome;
	process.env.OTTR_SERVER_DATA_DIR = join(root, "overlays");
	process.env.OTTR_TURN_CACHE_ROOT = join(root, "server-cache");
	process.env.HOME = sharedHome;
	process.env.XDG_CONFIG_HOME = join(projectHome, ".config");
	process.env.GH_CONFIG_DIR = join(projectHome, ".config", "gh");
	process.env.OMP_AUTH_BROKER_URL = endpoint;
	process.env.OMP_AUTH_BROKER_TOKEN = crypto.randomUUID();
	for (const key of [
		"GIT_CONFIG_GLOBAL",
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	])
		delete process.env[key];
	for (const key of githubKeys)
		process.env[key] = `synthetic-${crypto.randomUUID()}`;
	// This seam exercises preparation on the deployed project uid without fake child results.
	const rootView =
		callerUid === 0 ? null : jest.spyOn(process, "getuid").mockReturnValue(0);
	return {
		root,
		pinned,
		boardHome,
		privateStore,
		sharedHome,
		projectHome,
		projectLayer,
		bun,
		marker,
		trustedMarker,
		endpoint,
		trace,
		requests,
		sessionDir,
		dotenvPaths,
		dotenvContent,
		credentialSnapshot,
		sharedRoots: [homesRoot, workspaceRoot, dataRoot, sharedHome].map((path) =>
			realpathSync(path),
		),
		options: {
			cwd,
			project,
			prompt: "local security probe",
			sessionDir,
			resumeId: null,
			extensionPath: null,
			memoryConfigPath: null,
			dataRoot,
			logPath: join(dataRoot, project, "security.log"),
			localMerge: { workspaceRoot, homesRoot, provisionPaths },
			authBroker,
			env: {
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
		},
		async cleanup() {
			rootView?.mockRestore();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await listener.stop(true);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function expectDotenvRestored(f: Fixture) {
	for (const path of f.dotenvPaths) {
		expect(readFileSync(path).equals(Buffer.from(f.dotenvContent))).toBe(true);
	}
}

// This child replaces only the model process. Git, SQLite, module imports and filesystem reads stay real.
const probe = String.raw`
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const input = JSON.parse(process.env.MERGE_PROBE_INPUT);
const home = process.env.HOME;
const agent = process.env.PI_CODING_AGENT_DIR;
function files(path) {
 if (!existsSync(path)) return [];
 const st = statSync(path);
 if (!st.isDirectory()) return [path];
 return readdirSync(path).flatMap(name => files(join(path, name)));
}
function git(args, extra = {}) {
 const child = spawnSync("git", args, { cwd: process.cwd(), env: process.env, encoding: "utf8", ...extra });
 if (child.error) throw child.error;
 return { code: child.status, text: child.stdout.trim() };
}
const discovered = [...new Set([
 ...files(join(home, ".omp", "extensions")),
 ...files(join(agent, "extensions")),
 ...files(join(home, ".omp", "plugins")),
 ...files(join(agent, "skills")),
 ...[join(home, ".omp", "config.yml"), join(agent, "config.yml"),
 join(process.env.GH_CONFIG_DIR ?? join(home, ".config", "gh"), "config.yml"),
 ...input.overlays].filter(existsSync),
])];
// The real runner computes plugin skill discovery. Read those emitted paths too.
const overlaySkills = [];
for (const overlay of input.overlays) {
 for (const line of readFileSync(overlay, "utf8").split("\n")) {
  const match = /^    - (".*")$/.exec(line);
  if (match) {
   const paths = files(JSON.parse(match[1]));
   discovered.push(...paths);
   overlaySkills.push(...paths);
  }
 }
}
let planted = false;
let trustedConfig = false;
let trustedModule = false;
let trustedSkill = false;
let trustedPlugin = false;
const trustedPluginSkill = overlaySkills.some(path => path.endsWith("SKILL.md") &&
 readFileSync(path, "utf8").includes(input.trustedMarker));
for (const path of discovered) {
 if (!/\.(?:mjs|js|ts|json|ya?ml|md)$/.test(path)) continue;
 const content = readFileSync(path, "utf8");
 planted ||= content.includes(input.marker);
 trustedConfig ||= path.endsWith("config.yml") && content.includes(input.trustedMarker);
 trustedSkill ||= path.endsWith("SKILL.md") && content.includes(input.trustedMarker);
 if (/\.(?:mjs|js|ts)$/.test(path)) {
  // The fixture selects modules at runtime to test the configuration import boundary.
  const mod = await import(pathToFileURL(path).href);
  trustedModule ||= mod.fixture === input.trustedMarker;
  trustedPlugin ||= mod.pluginFixture === input.trustedMarker;
 }
}
const credential = git(["credential", "fill"], { input: "protocol=http\nhost=" + new URL(input.endpoint).host + "\n\n" });
const helper = git(["config", "--get", "credential.helper"]);
const alias = git(["config", "--get", "alias.merge-plant"]);
const pager = git(["config", "--get", "core.pager"]);
const author = git(["var", "GIT_AUTHOR_IDENT"]);
if (author.code !== 0) throw new Error("real Git author probe failed");
const writes = [];
for (const [name, dir] of [["scratch", process.env.TMPDIR], ["cache", process.env.XDG_CACHE_HOME], ["session", input.sessionDir]]) {
 const path = join(dir, "probe-" + input.run);
 writeFileSync(path, "accessible");
 if (readFileSync(path, "utf8") !== "accessible") throw new Error("writable control failed: " + name);
 writes.push(name);
}
const store = join(agent, "agent.db");
const state = new Database(store);
const trustedStore = state.query("SELECT value FROM fixture_state").get().value === input.trustedMarker;
const credentialsAbsent = state.query("SELECT COUNT(*) AS count FROM auth_credentials").get().count === 0;
state.query("UPDATE fixture_state SET value = ?").run(input.trustedMarker + "-" + input.run);
const writableState = state.query("SELECT value FROM fixture_state").get().value === input.trustedMarker + "-" + input.run;
state.exec("CREATE TABLE IF NOT EXISTS merge_probe (value TEXT NOT NULL)");
state.query("INSERT INTO merge_probe VALUES (?)").run(input.trustedMarker);
const sqlite = writableState && state.query("SELECT value FROM merge_probe ORDER BY rowid DESC LIMIT 1").get().value === input.trustedMarker;
state.close();
const stateDir = dirname(realpathSync(store));
if (input.poisonState) {
 writeFileSync(join(stateDir, "config.yml"), "fixture: " + input.marker + "\n");
 mkdirSync(join(stateDir, "extensions"), { recursive: true });
 writeFileSync(join(stateDir, "extensions", "from-first-run.mjs"), "throw new Error('mutable state became config')");
 writeFileSync(join(process.env.XDG_CACHE_HOME, ".gitconfig"), "[alias]\n merge-plant = !false\n");
}
const denied = [];
if (input.denials) {
 function deny(name, fn) {
  try { fn(); } catch (error) {
   if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
   denied.push(name);
   return;
  }
  throw new Error("project uid changed protected path: " + name);
 }
 // Each denial has an accessible control for the same syscall, under scratch.
 const accessible = join(process.env.TMPDIR, "accessible");
 mkdirSync(accessible);
 writeFileSync(join(accessible, "config.yml"), "control");
 readFileSync(join(accessible, "config.yml"));
 chmodSync(join(accessible, "config.yml"), 0o400);
 chmodSync(join(accessible, "config.yml"), 0o600);
 writeFileSync(join(accessible, "config.yml"), "changed");
 renameSync(accessible, accessible + "-renamed");
 deny("private-store", () => readFileSync(input.privateStore));
 deny("git-config", () => writeFileSync(join(home, ".gitconfig"), "poison"));
 deny("config-file", () => writeFileSync(join(agent, "config.yml"), "poison"));
 deny("extension-file", () => writeFileSync(join(agent, "extensions", "trusted.mjs"), "poison"));
 deny("new-extension", () => writeFileSync(join(agent, "extensions", "plant.mjs"), "poison"));
 for (const [name, path] of [["chmod-home", home], ["chmod-config", join(agent, "config.yml")], ["chmod-extension", join(agent, "extensions", "trusted.mjs")]]) {
  deny(name, () => chmodSync(path, statSync(path).mode | 0o200));
 }
 for (const [name, path] of [["home", home], ["omp-dir", join(home, ".omp")], ["agent-dir", agent], ["extensions-dir", join(agent, "extensions")], ["plugins-dir", join(home, ".omp", "plugins")], ["skills-dir", join(agent, "skills")]]) {
  deny(name, () => renameSync(path, path + "-replaced"));
 }
}
const tokenKeys = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const tokensAbsent = tokenKeys.every(key => process.env[key] === undefined);
const approved = input.approved === null ? false :
 process.env.GH_TOKEN === input.approved && process.env.GITHUB_TOKEN === input.approved &&
 process.env.GH_ENTERPRISE_TOKEN === undefined && process.env.GITHUB_ENTERPRISE_TOKEN === undefined;
const brokerGranted = process.env.OMP_AUTH_BROKER_URL === input.authBroker.url &&
 process.env.OMP_AUTH_BROKER_TOKEN === input.authBroker.token;
const brokerTokenFileAbsent = !existsSync(join(home, ".omp", "auth-broker.token"));
const report = {
 uid: process.getuid(), gid: process.getgid(), home, agent, stateDir, writes, sqlite, trustedStore,
 planted, trustedConfig, trustedModule, trustedSkill, trustedPlugin, trustedPluginSkill, denied, tokensAbsent, approved,
 credentialsAbsent, brokerGranted, brokerTokenFileAbsent,
 helperAbsent: helper.code === 1, aliasAbsent: alias.code === 1, pagerAbsent: pager.code === 1,
	dotenvAbsent: input.dotenvNames.every(name => !existsSync(join(process.cwd(), name))),
	dotenvEnvAbsent: ["GIT_CONFIG_GLOBAL", "PI_PACKAGE_DIR", "OMP_PROFILE"].every(key => process.env[key] === undefined),
	homeDotenvAbsent: !existsSync(join(home, ".env")),
 credentialFailed: credential.code !== 0,
 identity: author.text.startsWith("Trusted Merge <trusted@example.invalid>"),
};
console.log(JSON.stringify({type:"agent_end",isTerminal:true,messages:[{role:"assistant",content:[{type:"text",text:JSON.stringify(report)}]}]}));
`;

interface ProbeReport {
	uid: number;
	gid: number;
	home: string;
	agent: string;
	stateDir: string;
	writes: string[];
	sqlite: boolean;
	trustedStore: boolean;
	credentialsAbsent: boolean;
	brokerGranted: boolean;
	brokerTokenFileAbsent: boolean;
	planted: boolean;
	trustedConfig: boolean;
	trustedModule: boolean;
	trustedSkill: boolean;
	trustedPlugin: boolean;
	trustedPluginSkill: boolean;
	denied: string[];
	tokensAbsent: boolean;
	approved: boolean;
	helperAbsent: boolean;
	aliasAbsent: boolean;
	pagerAbsent: boolean;
	credentialFailed: boolean;
	identity: boolean;
	dotenvAbsent: boolean;
	dotenvEnvAbsent: boolean;
	homeDotenvAbsent: boolean;
}

async function mergeProbe(
	f: Fixture,
	run: number,
	extra: {
		explicitTokens?: boolean;
		approved?: string;
		denials?: boolean;
		env?: Record<string, string | undefined>;
	} = {},
) {
	let launched: SpawnOptions | undefined;
	let scratch = "";
	let runtime = "";
	let stateRoot = "";
	const explicit = extra.explicitTokens
		? Object.fromEntries(
				githubKeys.map((key) => [key, `synthetic-${crypto.randomUUID()}`]),
			)
		: {};
	const handle = await startRun({
		...f.options,
		env: {
			...f.options.env,
			...explicit,
			...(extra.explicitTokens
				? {
						XDG_CONFIG_HOME: join(f.projectLayer, ".config"),
						GH_CONFIG_DIR: join(f.projectLayer, ".config", "gh"),
						OMP_AUTH_BROKER_URL: f.endpoint,
						OMP_AUTH_BROKER_TOKEN: crypto.randomUUID(),
					}
				: {}),
			...extra.env,
		},
		githubReadEnv:
			extra.approved === undefined
				? undefined
				: {
						GH_TOKEN: extra.approved,
						GITHUB_TOKEN: extra.approved,
					},
		launcher: (_command, args, options) => {
			launched = options;
			scratch = String(options.env?.TMPDIR);
			const overlays = configOverlayPaths(args);
			runtime = dirname(String(options.env?.HOME));
			stateRoot = dirname(
				dirname(
					realpathSync(
						join(String(options.env?.PI_CODING_AGENT_DIR), "agent.db"),
					),
				),
			);
			expect(overlays.some((path) => dirname(path) === runtime)).toBe(true);
			expect(existsSync(runMarkerPath(stateRoot))).toBe(true);
			expect(existsSync(runMarkerPath(runtime))).toBe(true);
			return spawn(f.bun, ["-e", probe], {
				...options,
				env: {
					...options.env,
					MERGE_PROBE_INPUT: JSON.stringify({
						run,
						overlays,
						marker: f.marker,
						trustedMarker: f.trustedMarker,
						endpoint: f.endpoint,
						sessionDir: f.sessionDir,
						privateStore: f.privateStore,
						poisonState: run === 1,
						denials: extra.denials ?? false,
						approved: extra.approved ?? null,
						dotenvNames: f.dotenvPaths.map((path) => basename(path)),
						authBroker: f.options.authBroker,
					}),
				},
			});
		},
	});
	if (f.pinned) {
		expect(handle.layerId).toBe("trusted-merge-fixture");
		expect(readLayerUse(f.boardHome)).toEqual([
			{ id: "trusted-merge-fixture", since: expect.any(Number) },
		]);
	}
	expect(readLayerUse(f.sharedHome)).toEqual([]);
	const result = await handle.done;
	expect(result.stderrTail).toBe("");
	expect(result.exitCode).toBe(0);
	const report = JSON.parse(result.finalText) as ProbeReport;
	expect(launched?.uid).toBe(ids.uid);
	expect(launched?.gid).toBe(ids.gid);
	expect(report.uid).toBe(ids.uid);
	expect(report.gid).toBe(ids.gid);
	expect(report.uid).not.toBe(0);
	expect(report.home).not.toBe(f.projectHome);
	expect(report.home).not.toBe(f.projectLayer);
	expect(report.home).not.toBe(f.sharedHome);
	expect(report.dotenvAbsent).toBe(true);
	expect(report.dotenvEnvAbsent).toBe(true);
	expect(report.homeDotenvAbsent).toBe(true);
	expectDotenvRestored(f);
	expect(report.planted).toBe(false);
	expect(report.trustedConfig).toBe(true);
	expect(report.trustedModule).toBe(true);
	expect(report.trustedSkill).toBe(true);
	expect(report.trustedPlugin).toBe(true);
	expect(report.trustedPluginSkill).toBe(true);
	expect(report.helperAbsent).toBe(true);
	expect(report.aliasAbsent).toBe(true);
	expect(report.pagerAbsent).toBe(true);
	expect(report.credentialFailed).toBe(true);
	expect(report.identity).toBe(true);
	expect(report.sqlite).toBe(true);
	expect(report.trustedStore).toBe(true);
	expect(report.credentialsAbsent).toBe(true);
	expect(report.brokerGranted).toBe(true);
	expect(report.brokerTokenFileAbsent).toBe(true);
	// The private snapshot must never enter a volume that a worker can read.
	for (const root of f.sharedRoots) {
		const path = relative(root, report.stateDir);
		expect(
			path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path),
		).toBe(true);
	}
	expect(report.writes).toEqual(["scratch", "cache", "session"]);
	expect(readFileSync(join(f.sessionDir, `probe-${run}`), "utf8")).toBe(
		"accessible",
	);
	expect(existsSync(scratch)).toBe(false);
	expect(existsSync(runtime)).toBe(false);
	expect(existsSync(stateRoot)).toBe(false);
	expect(existsSync(runMarkerPath(stateRoot))).toBe(false);
	expect(existsSync(runMarkerPath(runtime))).toBe(false);
	expect(existsSync(report.home)).toBe(false);
	expect(existsSync(report.stateDir)).toBe(false);
	expect(readLayerUse(f.boardHome)).toEqual([]);
	return report;
}

async function poisonedControl(f: Fixture, home: string) {
	const env = gitEnv(home);
	const control = spawn(
		f.bun,
		[
			"-e",
			`
import { spawnSync } from "node:child_process";
const child = spawnSync("git", ["credential", "fill"], {
 env: process.env, input: ${JSON.stringify(`protocol=http\nhost=${new URL(f.endpoint).host}\n\n`)}, encoding: "utf8"
});
if (child.error) throw child.error;
if (child.status === 0) throw new Error("credential fixture must not supply credentials");
// This import exercises the planted module boundary from the selected fixture home.
await import(${JSON.stringify(pathToFileURL(join(home, ".omp", "agent", "extensions", "plant.mjs")).href)});
`,
		],
		{ cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	const { promise, resolve, reject } = Promise.withResolvers<number | null>();
	control.on("error", reject);
	control.on("close", resolve);
	const exit = await promise;
	expect(exit).toBe(0);
	expect(readFileSync(f.trace, "utf8")).toContain(`${f.marker}-git-helper`);
	expect(f.requests).toContain(`${f.marker}-git-helper`);
	expect(f.requests).toContain(f.marker);
	f.requests.length = 0;
	writeFileSync(f.trace, "");
}

describe("local merge trusted configuration boundary", () => {
	for (const pinned of [false, true]) {
		identityTest(
			`${pinned ? "pinned" : "flat"} board config ignores project home and layer plants across two real runs`,
			async () => {
				const f = fixture(pinned);
				try {
					for (const home of [f.sharedHome, f.projectHome, f.projectLayer])
						await poisonedControl(f, home);
					const first = await mergeProbe(f, 1);
					const second = await mergeProbe(f, 2, { explicitTokens: true });
					expect(first.tokensAbsent).toBe(true);
					expect(second.tokensAbsent).toBe(true);
					expect(second.home).not.toBe(first.home);
					expect(second.agent).not.toBe(first.agent);
					expect(second.stateDir).not.toBe(first.stateDir);
					expect(f.requests).toEqual([]);
					expect(readFileSync(f.trace, "utf8")).toBe("");
					expect(statSync(f.boardHome).mode & 0o777).toBe(0o700);
					expect(statSync(f.privateStore).mode & 0o777).toBe(0o600);
					const privateDb = new Database(f.privateStore, { readonly: true });
					try {
						expect(
							privateDb.query("SELECT value FROM fixture_state").get(),
						).toEqual({ value: f.trustedMarker });
						expect(
							privateDb
								.query(
									"SELECT name FROM sqlite_master WHERE name = 'merge_probe'",
								)
								.get(),
						).toBeNull();
						const credentials = privateDb
							.query("SELECT * FROM auth_credentials ORDER BY id")
							.all();
						expect(credentials.length).toBe(2);
						expect(JSON.stringify(credentials) === f.credentialSnapshot).toBe(
							true,
						);
					} finally {
						privateDb.close();
					}
				} finally {
					await f.cleanup();
				}
			},
			30_000,
		);
	}

	identityTest(
		"approved read-only GitHub env reaches the child only after inherited and explicit token strips",
		async () => {
			const f = fixture(false);
			try {
				const report = await mergeProbe(f, 3, {
					explicitTokens: true,
					approved: `synthetic-${crypto.randomUUID()}`,
				});
				expect(report.approved).toBe(true);
				expect(report.tokensAbsent).toBe(false);
				expect(f.requests).toEqual([]);
				expect(readFileSync(f.trace, "utf8")).toBe("");
			} finally {
				await f.cleanup();
			}
		},
		30_000,
	);

	identityTest(
		"cwd .env returns intact after a launcher error and a nonzero child exit",
		async () => {
			const f = fixture(true);
			let reachedLauncher = false;
			try {
				await expect(
					startRun({
						...f.options,
						launcher: (_command, _args, options) => {
							reachedLauncher = true;
							for (const path of f.dotenvPaths) {
								expect(existsSync(path)).toBe(false);
							}
							expect(existsSync(join(String(options.env?.HOME), ".env"))).toBe(
								false,
							);
							throw new Error("synthetic launcher failure");
						},
					}),
				).rejects.toThrow("synthetic launcher failure");
				expect(reachedLauncher).toBe(true);
				expectDotenvRestored(f);
				const handle = await startRun({
					...f.options,
					launcher: (_command, _args, options) =>
						spawn(
							f.bun,
							[
								"-e",
								`import { existsSync } from "node:fs";
if (${JSON.stringify(f.dotenvPaths)}.some(existsSync)) throw new Error("planted dotenv remains visible");
process.exit(43);`,
							],
							options,
						),
				});
				const result = await handle.done;
				expect(result.stderrTail).toBe("");
				expect(result.exitCode).toBe(43);
				expectDotenvRestored(f);
				expect(readLayerUse(f.boardHome)).toEqual([]);
				expect(f.requests).toEqual([]);
			} finally {
				await f.cleanup();
			}
		},
		30_000,
	);

	identityTest(
		"no Bun dotenv name reaches the child in any mode",
		async () => {
			const f = fixture(false);
			// BUN_ENV outranks NODE_ENV, and an unknown value loads the development files.
			const modes: Record<string, string | undefined>[] = [
				{ NODE_ENV: undefined, BUN_ENV: undefined },
				{ NODE_ENV: "production", BUN_ENV: undefined },
				{ NODE_ENV: "test", BUN_ENV: undefined },
				{ NODE_ENV: "staging", BUN_ENV: undefined },
				{ NODE_ENV: undefined, BUN_ENV: "production" },
				{ NODE_ENV: undefined, BUN_ENV: "test" },
			];
			try {
				// Control: with the files in place, Bun loads the planted override.
				const control = spawnSync(
					f.bun,
					["-e", "console.log(process.env.OMP_PROFILE ?? 'unset')"],
					{
						cwd: f.options.cwd,
						env: { PATH: process.env.PATH, HOME: f.root },
						encoding: "utf8",
					},
				);
				expect(control.stdout.trim()).toBe("planted");
				for (const [index, env] of modes.entries())
					await mergeProbe(f, 10 + index, { env });
				expect(f.requests).toEqual([]);
				expect(readFileSync(f.trace, "utf8")).toBe("");
			} finally {
				await f.cleanup();
			}
		},
		60_000,
	);

	rootTest(
		"[root-only] dropped uid cannot read the private store or change protected config",
		async () => {
			const f = fixture(true);
			try {
				// Root reads the private store first. The child gets same-syscall accessible controls.
				const db = new Database(f.privateStore, { readonly: true });
				try {
					expect(db.query("SELECT value FROM fixture_state").get()).toEqual({
						value: f.trustedMarker,
					});
				} finally {
					db.close();
				}
				const report = await mergeProbe(f, 4, { denials: true });
				expect(report.denied).toEqual([
					"private-store",
					"git-config",
					"config-file",
					"extension-file",
					"new-extension",
					"chmod-home",
					"chmod-config",
					"chmod-extension",
					"home",
					"omp-dir",
					"agent-dir",
					"extensions-dir",
					"plugins-dir",
					"skills-dir",
				]);
				expect(f.requests).toEqual([]);
				expect(readFileSync(f.trace, "utf8")).toBe("");
				expect(statSync(f.boardHome).mode & 0o777).toBe(0o700);
				expect(statSync(f.privateStore).mode & 0o777).toBe(0o600);
			} finally {
				await f.cleanup();
			}
		},
		30_000,
	);
});
