import { Database } from "bun:sqlite";
import {
	chmodSync,
	chownSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { TurnIdentity } from "./turnUid.ts";

const CONFIG_ROOTS = [
	".omp/agent",
	".omp/plugins",
	".omp/modules",
	".omp/prompts",
	".omp/skills",
	".ottr/project-skills",
	".ottr/plugins",
	".agents",
	".claude/skills",
	".claude/commands",
	".claude/agents",
	".claude/tools",
	".claude/plugins",
	".codex/skills",
	".pi",
	".gemini",
	".opencode",
];
const DATABASES = [
	"agent.db",
	"history.db",
	"transcripts.db",
	"models.db",
	"skill-descriptions.db",
];
const AGENT_STATE = [
	"sessions",
	"blobs",
	"predict",
	"cache",
	"memories",
	"terminal-sessions",
	"custom-session-files",
];
const ROOT_STATE = ["logs", "oauth", "run", "reports", "update", "security"];
const ROOT_DATABASES = ["stats.db", "autoqa.db"];

/** A private board source cannot import a worker-owned link or writable code. */
export function trustedMergeSource(boardHome: string, path: string): string {
	const root = realpathSync(boardHome);
	const source = realpathSync(path);
	const rel = relative(root, source);
	if (rel === ".." || rel.startsWith("../") || resolve(root, rel) !== source)
		throw new Error(
			`merge turn configuration source escapes the board home: ${path}`,
		);
	let entry = source;
	for (;;) {
		const st = lstatSync(entry);
		if (st.uid !== process.geteuid?.() || (st.mode & 0o022) !== 0)
			throw new Error(
				`merge turn configuration source is writable or not daemon-owned: ${entry}`,
			);
		if (entry === root) break;
		entry = dirname(entry);
	}
	// A protected source inside a replaceable parent is not a protected source.
	for (entry = dirname(root); ; entry = dirname(entry)) {
		const st = lstatSync(entry);
		if (
			(st.uid !== 0 && st.uid !== process.geteuid?.()) ||
			((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)
		)
			throw new Error(
				`merge turn configuration source has an untrusted parent: ${entry}`,
			);
		if (dirname(entry) === entry) break;
	}
	return source;
}

/** The protected parent limits access. The daemon's umask must not hide configuration from the child. */
function configDirectory(path: string): void {
	const first = mkdirSync(path, { recursive: true, mode: 0o755 });
	for (let entry = path; ; entry = dirname(entry)) {
		chmodSync(entry, 0o755);
		if (first === undefined || entry === first) break;
	}
}

/** Copy links as data, never as links to code outside the private board source. */
function copyConfig(
	boardHome: string,
	source: string,
	target: string,
	skip: Set<string>,
	active = new Set<string>(),
): void {
	if (skip.has(target)) return;
	const real = trustedMergeSource(boardHome, source);
	const st = lstatSync(real);
	if (st.isDirectory()) {
		if (active.has(real))
			throw new Error(`merge turn configuration link cycle: ${source}`);
		active.add(real);
		configDirectory(target);
		for (const name of readdirSync(real))
			copyConfig(boardHome, join(real, name), join(target, name), skip, active);
		active.delete(real);
	} else if (st.isFile()) {
		copyFileSync(real, target);
		chmodSync(target, (st.mode & 0o111) !== 0 ? 0o555 : 0o444);
	} else {
		throw new Error(
			`merge turn configuration source is not a file or directory: ${source}`,
		);
	}
}

/** VACUUM includes committed WAL pages without a raw, inconsistent db/WAL copy. */
function snapshotDatabase(
	boardHome: string,
	source: string | undefined,
	target: string,
): void {
	if (
		source === undefined ||
		lstatSync(source, { throwIfNoEntry: false }) === undefined
	) {
		const empty = new Database(target, { create: true });
		empty.close();
		return;
	}
	const db = new Database(trustedMergeSource(boardHome, source), {
		readonly: true,
	});
	try {
		db.query("VACUUM INTO ?").run(target);
	} finally {
		db.close();
	}
	// Only the private broker can refresh provider credentials.
	const snapshot = new Database(target);
	try {
		if (
			snapshot
				.query(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
				)
				.get()
		)
			snapshot.exec(
				"PRAGMA secure_delete=ON; DELETE FROM auth_credentials; VACUUM",
			);
	} finally {
		snapshot.close();
	}
}

/** Configuration stays daemon-owned. Only named, non-discovery state paths are writable. */
export function prepareMergeHome(
	boardHome: string,
	sourceHome: string,
	home: string,
	state: string,
	ids: TurnIdentity,
	env: Record<string, string | undefined>,
): void {
	trustedMergeSource(boardHome, sourceHome);
	configDirectory(home);
	const agent = join(home, ".omp", "agent");
	const sourceAgent = join(sourceHome, ".omp", "agent");
	const skip = new Set<string>();
	for (const name of DATABASES) {
		for (const suffix of ["", "-wal", "-shm", "-journal"])
			skip.add(join(agent, name + suffix));
	}
	for (const name of AGENT_STATE) skip.add(join(agent, name));
	for (const name of ROOT_STATE) skip.add(join(home, ".omp", name));
	for (const name of ROOT_DATABASES)
		for (const suffix of ["", "-wal", "-shm", "-journal"])
			skip.add(join(home, ".omp", name + suffix));
	for (const name of [
		"last-changelog-version",
		"secret-placeholder.key",
		"omp-crash.log",
		"omp-debug.log",
	])
		skip.add(join(agent, name));
	for (const path of [join(home, ".omp", ".env"), join(agent, ".env")])
		skip.add(path);
	// Never duplicate the layer registry, shared caches, Git credentials, or worker homes.
	for (const name of CONFIG_ROOTS) {
		const source = join(sourceHome, name);
		if (lstatSync(source, { throwIfNoEntry: false }) !== undefined) {
			configDirectory(dirname(join(home, name)));
			copyConfig(boardHome, source, join(home, name), skip);
		}
	}
	configDirectory(agent);
	// A protected config file also prevents legacy database settings from supplying config.
	if (
		!existsSync(join(agent, "config.yml")) &&
		!existsSync(join(agent, "config.yaml"))
	) {
		const config = join(agent, "config.yml");
		writeFileSync(config, "{}\n", { mode: 0o444 });
		chmodSync(config, 0o444);
	}
	mkdirSync(state, { mode: 0o700 });
	chownSync(state, ids.uid, ids.gid);
	const stateDir = (name: string): string => {
		const path = join(state, name);
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chownSync(path, ids.uid, ids.gid);
		return path;
	};
	for (const name of DATABASES) {
		const target = join(state, name);
		snapshotDatabase(
			boardHome,
			name === "agent.db" ? join(sourceAgent, name) : undefined,
			target,
		);
		chownSync(target, ids.uid, ids.gid);
		chmodSync(target, 0o600);
		symlinkSync(target, join(agent, name));
	}
	for (const name of ROOT_DATABASES) {
		const target = join(state, name);
		snapshotDatabase(boardHome, undefined, target);
		chownSync(target, ids.uid, ids.gid);
		chmodSync(target, 0o600);
		symlinkSync(target, join(home, ".omp", name));
	}
	for (const name of AGENT_STATE)
		symlinkSync(stateDir(name), join(agent, name));
	for (const name of ROOT_STATE)
		symlinkSync(stateDir(name), join(home, ".omp", name));
	for (const name of [
		"last-changelog-version",
		"secret-placeholder.key",
		"omp-crash.log",
		"omp-debug.log",
	]) {
		const target = join(state, name);
		const source = join(sourceAgent, name);
		if (lstatSync(source, { throwIfNoEntry: false }) !== undefined)
			copyFileSync(trustedMergeSource(boardHome, source), target);
		else writeFileSync(target, "");
		chownSync(target, ids.uid, ids.gid);
		chmodSync(target, 0o600);
		symlinkSync(target, join(agent, name));
	}
	// Identity values cross separately. No board credential helper or include crosses.
	const gitconfig = join(home, ".gitconfig");
	writeFileSync(gitconfig, "", { mode: 0o444 });
	chmodSync(gitconfig, 0o444);
	for (const name of [
		".config",
		".config/gh",
		".config/git",
		".xdg-data",
		".xdg-state",
		".copilot",
	])
		configDirectory(join(home, name));
	env.HOME = home;
	env.PI_CODING_AGENT_DIR = agent;
	env.PI_CONFIG_DIR = ".omp";
	env.XDG_CONFIG_HOME = join(home, ".config");
	env.GH_CONFIG_DIR = join(home, ".config", "gh");
	env.XDG_DATA_HOME = join(home, ".xdg-data");
	env.XDG_STATE_HOME = stateDir("xdg-state");
	env.XDG_CACHE_HOME = stateDir("xdg-cache");
	for (const base of [env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) {
		const path = join(base, "omp");
		mkdirSync(path, { mode: 0o700 });
		chownSync(path, ids.uid, ids.gid);
	}
	env.OMP_DAEMON_DIR = stateDir("daemon");
	env.CLAUDE_CONFIG_DIR = join(home, ".claude");
	env.COPILOT_HOME = join(home, ".copilot");
	env.GLAB_CONFIG_DIR = join(home, ".config", "glab");
	// The image's helper reads the approved turn token. Ambient config cannot replace it.
	env.GIT_CONFIG_SYSTEM = "/etc/gitconfig";
	env.TERN_BLOB_DIR = stateDir("tern-blobs");
	env.OMP_AUTORESEARCH_DB_DIR = stateDir("autoresearch");
	env.PI_CONFIG_FILES = join(
		agent,
		existsSync(join(agent, "config.yml")) ? "config.yml" : "config.yaml",
	);
	env.PI_NATIVES_DIR = stateDir("natives");
	delete env.PI_PACKAGE_DIR;
	delete env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
	delete env.OMP_DAEMON_TCP;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.OMP_WORKTREE_DIR;
	delete env.OTTR_DATABASE_URL;
}
