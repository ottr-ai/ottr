// The agent-data sync gate (docs/specs/agent-data-sync-gate.md): the board runs
// alate's sync.mjs against an immutable archive of the card branch's HEAD with
// its own rights, because the turn uid cannot read the alate checkout (OTTR-994)
// and must not be able to steer the installed bytes from the worktree disk. The
// record lands in the store before the turn sees it, so a report cites tracked
// data it cannot forge.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { SyncGateFileHash, SyncGateRun, SyncGateSkip } from "./types.ts";
import { GIT_CONFIG_PINS, NO_EXT_DIFF } from "./worktree.ts";

/** The only project whose cards may run the gate: the data repo the sync installs. */
export const SYNC_GATE_PROJECT = "agent-data";

/** Hard cap on one gate run: a hung sync.mjs must not hold the route forever. */
export const GATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Output cap per run; the tail beyond it is lost and `truncated` says so. */
export const GATE_OUTPUT_CAP = 8192;

/** The task log keeps the newest runs only, like the work check log. */
export const SYNC_GATE_LOG_CAP = 20;

/** Cap on the caller-requested extra hash set (sandbox_run's collect cap). */
export const SYNC_GATE_FILES_CAP = 16;

/** The skip reason when the gate declines to install stale bytes (OTTR-1305):
 *  the branch never changed the path and the installed twin carries fresher
 *  bytes than the branch's snapshot. */
export const STALE_SOURCE_SKIP_REASON =
	"stale source: unchanged in branch, twin differs";

/** The gate target the route composes from its own deps: no path or name is
 *  hardcoded, so tests point every member at temp fixtures. */
export interface SyncGateTarget {
	/** The calling run's own project (must be `agent-data`). */
	project: string;
	/** The card's absolute worktree path (only the git object store is read). */
	worktree: string;
	/** The alate project checkout (holds sync.mjs). */
	alateDir: string;
	/** The workspace root: the parent of the project checkouts (installed twins). */
	workspaceRoot: string;
	/** The home the gate's child runs with: the base of the user-file and rules
	 *  twins. In production this is the server's own HOME (the shared worker home). */
	home: string;
	/** The card branch's fork-point sha; null skips nothing — the changed set comes
	 *  from the archive's commit, but the diff needs the fork point. */
	base: string | null;
	/** Caller-requested data-repo-relative paths to hash in addition to the branch's
	 *  changed files (validated by syncGateFilesError before the run). */
	extraFiles?: string[];
}

/** The installed twin of one data-repo file, per the documented agent-data
 *  install contract (projects/<name>/<file> to the project checkout, user/<path>
 *  below the home, and a root <name>.md rule into .omp/agent/rules). Null when
 *  the data repo's contract maps the path nowhere — the gate then never hashes
 *  it, because there is no installed location to compare against. */
export function installedTwin(
	path: string,
	workspaceRoot: string,
	home: string,
): string | null {
	if (path.startsWith("projects/")) {
		const rest = path.slice("projects/".length);
		if (rest === "") return null;
		return join(workspaceRoot, rest);
	}
	if (path.startsWith("user/")) {
		const rest = path.slice("user/".length);
		if (rest === "") return null;
		return join(home, rest);
	}
	// A root <name>.md file is a global rule: the data repo ships one .md file per
	// rule name (agent-data AGENTS.md, "a global rule ... the root *.md file with
	// the same name").
	if (/^[^/]+\.md$/.test(path))
		return join(home, ".omp", "agent", "rules", path);
	return null;
}

/** Validates the caller-requested extra hash set: present, capped, plain relative
 *  paths (no traversal, no absolute), each mapped by the install contract. Route
 *  level: a bad entry refuses the request before any record exists. */
export function syncGateFilesError(files: unknown): string | null {
	if (files === undefined) return null;
	if (!Array.isArray(files))
		return "files must be a list of data-repo-relative paths";
	if (files.length > SYNC_GATE_FILES_CAP)
		return `files carries at most ${SYNC_GATE_FILES_CAP} paths`;
	for (const entry of files) {
		if (typeof entry !== "string" || entry.trim() === "")
			return "every files entry must be a non-empty string";
		const path = entry.trim();
		if (isAbsolute(path) || path.split(/[/\\]/).includes(".."))
			return `files entry must not traverse: ${path}`;
		if (path.startsWith("projects/") || path.startsWith("user/")) continue;
		if (!/^[^/]+\.md$/.test(path))
			return `files entry maps to no installed location: ${path}`;
	}
	return null;
}

/** Appends one run to a task's log, keeping the newest SYNC_GATE_LOG_CAP records. */
export function appendSyncGateRun(
	log: readonly SyncGateRun[],
	run: SyncGateRun,
): SyncGateRun[] {
	const runs = [...log, run];
	return runs.length <= SYNC_GATE_LOG_CAP
		? runs
		: runs.slice(-SYNC_GATE_LOG_CAP);
}

/** sha256 of a file's bytes; null when it is missing or unreadable. */
export function sha256File(path: string): Promise<string | null> {
	return readFile(path)
		.then((bytes) => createHash("sha256").update(bytes).digest("hex"))
		.catch(() => null);
}

/** The env the gate and git children run with: an allowlist picked from the
 *  server's own env. The server env carries credentials (ALATE_API_KEY), and the
 *  gate's output lands in the store, so nothing else may ride along. HOME comes
 *  from the target so the child's install target equals the twin base. Proxy
 *  vars pass through: a sync.mjs that fetches must reach the board's egress. */
function gateEnv(alateDir: string, home: string): NodeJS.ProcessEnv {
	const passThrough = [
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	] as const;
	const env: NodeJS.ProcessEnv = {
		ALATE_HOME: alateDir,
		HOME: home,
		PATH: process.env.PATH ?? "",
	};
	for (const key of passThrough) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** One pinned-env git query in the worktree: stdout, or null when git fails
 *  (no repo, unknown ref). Null never fails the gate step that tolerates it. */
function gitOut(
	cwd: string,
	args: string[],
	alateDir: string,
	home: string,
): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	// The R5-1 pins ride every spawn: the worktree's .git/config is turn-writable,
	// and an unpinned `git status` here would execute a planted fsmonitor command
	// as the server uid (the board's own git pins the same list, src/worktree.ts).
	const child = spawn("git", [...GIT_CONFIG_PINS, ...args], {
		cwd,
		env: gateEnv(alateDir, home),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.on("error", () => resolve(null));
	child.on("close", (code) => resolve(code === 0 ? out : null));
	return promise;
}

/** Guards that run before the gate spawns. `status` carries `git status --porcelain`
 *  output when the tree is dirty, so the error names what the turn must commit. */
export type SyncGateGuard =
	| { ok: true }
	| { ok: false; error: string; status?: string };

/** Checks the worktree is a clean git tree: the evidence must describe the commit
 *  the run installs, and a dirty tree means the turn has not committed its work.
 *  The bytes themselves never come from this tree — the run installs an archive
 *  of HEAD — so index tricks (assume-unchanged edits, ignored files) cannot
 *  smuggle content past this guard into the install. */
export async function checkCleanWorktree(
	worktree: string,
	alateDir: string,
	home: string,
): Promise<SyncGateGuard> {
	const out = await gitOut(worktree, ["status", "--porcelain"], alateDir, home);
	if (out === null) return { ok: false, error: "not a git worktree" };
	const status = out
		.split("\n")
		.filter((l) => l.trim() !== "")
		.join("\n");
	if (status !== "")
		return { ok: false, error: "worktree not committed", status };
	return { ok: true };
}

/** Extracts an immutable snapshot of one commit into a fresh root-owned 0700
 *  temp dir: `git archive <sha>` piped into `tar -x`. The worktree's disk bytes
 *  never reach the snapshot, so assume-unchanged edits and ignored files cannot
 *  change what sync installs. The caller removes the dir. */
async function extractSnapshot(
	worktree: string,
	head: string,
	alateDir: string,
	home: string,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ottr-syncgate-snap-"));
	await new Promise<void>((resolve, reject) => {
		const archive = spawn("git", [...GIT_CONFIG_PINS, "archive", head], {
			cwd: worktree,
			env: gateEnv(alateDir, home),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const tar = spawn("tar", ["-x", "-C", dir], {
			stdio: ["pipe", "ignore", "pipe"],
		});
		let tarErr = "";
		tar.stderr?.on("data", (chunk: Buffer) => {
			tarErr += chunk.toString();
		});
		archive.stdout?.pipe(tar.stdin!);
		let archiveCode: number | null = null;
		let tarCode: number | null = null;
		let failed = false;
		const settle = (): void => {
			if (failed) return;
			if (archiveCode === null || tarCode === null) return;
			if (archiveCode !== 0)
				reject(new Error(`git archive exited ${archiveCode}`));
			else if (tarCode !== 0)
				reject(new Error(`tar exited ${tarCode}: ${tarErr.trim()}`));
			else resolve();
		};
		archive.on("error", (err) => {
			failed = true;
			reject(err);
		});
		tar.on("error", (err) => {
			failed = true;
			reject(err);
		});
		archive.on("close", (code) => {
			archiveCode = code;
			settle();
		});
		tar.on("close", (code) => {
			tarCode = code;
			settle();
		});
	});
	return dir;
}

/** sha256 comparison for each requested data-repo path: the snapshot source
 *  against its installed twin. A path the install contract maps nowhere yields
 *  null twins and match false — the record shows why the evidence is missing. */
async function fileHashes(
	target: SyncGateTarget,
	snapshot: string,
	paths: readonly string[],
): Promise<SyncGateFileHash[]> {
	return Promise.all(
		paths.map(async (path) => {
			const twin = installedTwin(path, target.workspaceRoot, target.home);
			const [sourceSha256, installedSha256] = await Promise.all([
				sha256File(join(snapshot, path)),
				twin === null ? Promise.resolve(null) : sha256File(twin),
			]);
			return {
				path,
				sourceSha256,
				installedSha256,
				match:
					sourceSha256 !== null &&
					installedSha256 !== null &&
					sourceSha256 === installedSha256,
			};
		}),
	);
}

/** Runs one bounded child and captures its combined output under the cap. */
function runChild(
	cwd: string,
	argv: string[],
	env: NodeJS.ProcessEnv,
): Promise<{
	code: number | null;
	output: string;
	truncated: boolean;
	spawnError?: string;
}> {
	const { promise, resolve } = Promise.withResolvers<{
		code: number | null;
		output: string;
		truncated: boolean;
		spawnError?: string;
	}>();
	let output = "";
	let truncated = false;
	let spawnError: string | undefined;
	const argv0 = argv[0];
	if (argv0 === undefined) {
		resolve({
			code: null,
			output: "",
			truncated: false,
			spawnError: "gate argv is empty",
		});
		return promise;
	}
	const child = spawn(argv0, argv.slice(1), {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const collect = (chunk: Buffer): void => {
		if (output.length >= GATE_OUTPUT_CAP) {
			truncated = true;
			return;
		}
		output += chunk.toString();
		if (output.length > GATE_OUTPUT_CAP) {
			output = output.slice(0, GATE_OUTPUT_CAP);
			truncated = true;
		}
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
	}, GATE_TIMEOUT_MS);
	child.on("error", (err) => {
		clearTimeout(timer);
		spawnError = err.message;
		resolve({ code: null, output, truncated, spawnError });
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		resolve({ code, output, truncated });
	});
	return promise;
}

/** The branch's changed files: the diff from the fork point to HEAD, full tree —
 *  the hash set filters by the install contract's mappings afterwards. */
async function changedFiles(target: SyncGateTarget): Promise<string[]> {
	if (target.base === null) return [];
	const out = await gitOut(
		target.worktree,
		["diff", ...NO_EXT_DIFF, "--name-only", `${target.base}...HEAD`],
		target.alateDir,
		target.home,
	);
	if (out === null) return [];
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
}

/** Every projects/ file the snapshot carries: the staleness guard's candidate
 *  set, independent of the branch's changed files. */
async function snapshotProjectPaths(snapshot: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (rel: string): Promise<void> => {
		const entries = await readdir(join(snapshot, rel), { withFileTypes: true });
		for (const entry of entries) {
			const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile() && child.startsWith("projects/")) out.push(child);
		}
	};
	await walk("");
	return out;
}

/** One gate step: guards, an immutable HEAD snapshot, the sync.mjs run inside it,
 *  the per-file hashes against the installed twins, and the tracked record.
 *  Refusals record too, so every attempt is store data. */
export async function runSyncGate(
	target: SyncGateTarget,
): Promise<SyncGateRun> {
	const startedAt = Date.now();
	const record = (
		run: Omit<SyncGateRun, "at" | "durationMs">,
	): SyncGateRun => ({
		...run,
		at: startedAt,
		durationMs: Date.now() - startedAt,
	});
	if (target.project !== SYNC_GATE_PROJECT)
		return record({
			code: null,
			output: "",
			truncated: false,
			files: [],
			error: `sync_gate runs only on ${SYNC_GATE_PROJECT} cards`,
		});
	const syncMjs = join(target.alateDir, "sync.mjs");
	if (!existsSync(syncMjs))
		return record({
			code: null,
			output: "",
			truncated: false,
			files: [],
			error: `no sync.mjs at ${syncMjs}; register the alate project first`,
		});
	const clean = await checkCleanWorktree(
		target.worktree,
		target.alateDir,
		target.home,
	);
	if (!clean.ok)
		return record({
			code: null,
			output: "",
			truncated: false,
			files: [],
			error: clean.status ? `${clean.error}:\n${clean.status}` : clean.error,
		});
	const headOut = await gitOut(
		target.worktree,
		["rev-parse", "HEAD"],
		target.alateDir,
		target.home,
	);
	const head = headOut?.trim().split("\n")[0]?.trim() ?? "";
	if (!/^[0-9a-f]{40}$/.test(head))
		return record({
			code: null,
			output: "",
			truncated: false,
			files: [],
			error: "cannot resolve the branch head; no snapshot to install",
		});
	const snapshot = await extractSnapshot(
		target.worktree,
		head,
		target.alateDir,
		target.home,
	);
	try {
		// The branch's changed set before the child runs: the staleness guard
		// needs it, and the post-run hash set reuses it.
		const changed = new Set(await changedFiles(target));
		// The staleness guard (OTTR-1305): a branch forked before a mapped
		// projects/ file gained its current content carries stale bytes at HEAD,
		// and sync would install them over the fresher installed twin. For each
		// unchanged path whose snapshot bytes differ from its twin, the gate
		// replaces the snapshot bytes with the twin's own bytes, so the child
		// cannot install anything stale at that path — at worst it rewrites the
		// twin's own bytes. user/ files and root rules keep the plain behavior.
		const skipped: SyncGateSkip[] = [];
		const skipFiles: SyncGateFileHash[] = [];
		for (const path of await snapshotProjectPaths(snapshot)) {
			if (changed.has(path)) continue;
			const twin = installedTwin(path, target.workspaceRoot, target.home);
			if (twin === null) continue;
			const [sourceSha256, installedSha256] = await Promise.all([
				sha256File(join(snapshot, path)),
				sha256File(twin),
			]);
			if (
				sourceSha256 === null ||
				installedSha256 === null ||
				sourceSha256 === installedSha256
			)
				continue;
			skipped.push({ path, reason: STALE_SOURCE_SKIP_REASON });
			skipFiles.push({ path, sourceSha256, installedSha256, match: false });
			await copyFile(twin, join(snapshot, path));
		}
		// The child runs `--data .` at the snapshot: the documented command, pointed
		// at immutable archive bytes instead of the worktree's disk.
		const result = await runChild(
			snapshot,
			["node", syncMjs, "--data", "."],
			gateEnv(target.alateDir, target.home),
		);
		const paths = new Set<string>();
		for (const path of changed) {
			if (installedTwin(path, target.workspaceRoot, target.home) !== null)
				paths.add(path);
		}
		for (const path of target.extraFiles ?? []) paths.add(path.trim());
		// A skipped path's files entry is already recorded with the pre-run hashes
		// (the stale source against the twin), so the child run must not re-hash it.
		for (const skip of skipped) paths.delete(skip.path);
		const files = [
			...skipFiles,
			...(await fileHashes(target, snapshot, [...paths])),
		];
		return record({
			head,
			code: result.code,
			output: result.output,
			truncated: result.truncated,
			files,
			...(skipped.length > 0 ? { skipped } : {}),
			...(result.spawnError !== undefined ? { error: result.spawnError } : {}),
		});
	} finally {
		await rm(snapshot, { recursive: true, force: true }).catch(() => {});
	}
}

/** Gate runs serialize per project: sync.mjs installs into live state, so two
 *  concurrent runs for one project would race its manifests. In-process only;
 *  the board is one server process. */
const chains = new Map<string, Promise<unknown>>();

/** Serialized entry point: queues this run behind the project's previous one. */
export function runSyncGateQueued(
	target: SyncGateTarget,
): Promise<SyncGateRun> {
	const previous = chains.get(target.project) ?? Promise.resolve();
	const next = previous.then(
		() => runSyncGate(target),
		() => runSyncGate(target),
	);
	chains.set(
		target.project,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

/** The workspace root for a registered project checkout: its parent dir. */
export function workspaceRootFor(projectPath: string): string {
	return dirname(projectPath);
}
