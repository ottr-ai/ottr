// The agent-data sync gate (docs/specs/agent-data-sync-gate.md): the board runs
// alate's sync.mjs in a card worktree with its own rights, because the turn uid
// cannot read the alate checkout (OTTR-994). The record lands in the store before
// the turn sees it, so a report cites tracked data it cannot forge.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SyncGateFileHash, SyncGateRun } from "./types.ts";

/** The only project whose cards may run the gate: the data repo the sync installs. */
export const SYNC_GATE_PROJECT = "agent-data";

/** Hard cap on one gate run: a hung sync.mjs must not hold the route forever. */
export const GATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Output cap per run; the tail beyond it is lost and `truncated` says so. */
export const GATE_OUTPUT_CAP = 8192;

/** The task log keeps the newest runs only, like the work check log. */
export const SYNC_GATE_LOG_CAP = 20;

/** The gate target the route composes from its own deps: no path or name is
 *  hardcoded, so tests point every member at temp fixtures. */
export interface SyncGateTarget {
	/** The calling run's own project (must be `agent-data`). */
	project: string;
	/** The card's absolute worktree path. */
	worktree: string;
	/** The alate project checkout (holds sync.mjs). */
	alateDir: string;
	/** The workspace root: the parent of the project checkouts (installed twins). */
	workspaceRoot: string;
	/** The card branch's fork-point sha; null skips the changed-file hashes. */
	base: string | null;
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

/** One pinned-env git query in the worktree: stdout lines, or null when git fails
 *  (no repo, unknown ref). Null never fails the gate; hashes are auxiliary evidence. */
function gitLines(worktree: string, args: string[]): Promise<string[] | null> {
	const { promise, resolve } = Promise.withResolvers<string[] | null>();
	const child = spawn("git", args, {
		cwd: worktree,
		env: gateEnv(""),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.on("error", () => resolve(null));
	child.on("close", (code) => resolve(code === 0 ? out.split("\n") : null));
	return promise;
}

/** The env every gate and git child runs with: an allowlist picked from the
 *  server's own env. The server env carries credentials (ALATE_API_KEY), and the
 *  gate's output lands in the store, so nothing else may ride along. The git
 *  config pins pass through unchanged, so the gate's git runs see exactly what
 *  the board's own git runs see. Proxy vars pass through: a sync.mjs that fetches
 *  must reach the same egress the board uses. */
function gateEnv(alateDir: string): NodeJS.ProcessEnv {
	const passThrough = [
		"PATH",
		"HOME",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	] as const;
	const env: NodeJS.ProcessEnv = { ALATE_HOME: alateDir };
	for (const key of passThrough) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Guards that run before the gate spawns. `status` carries `git status --porcelain`
 *  output when the tree is dirty, so the error names what the turn must commit. */
export type SyncGateGuard =
	| { ok: true }
	| { ok: false; error: string; status?: string };

/** Checks the worktree is a clean git tree: the operator runs the gate on committed
 *  state, and a dirty tree would sync uncommitted content. */
export async function checkCleanWorktree(
	worktree: string,
): Promise<SyncGateGuard> {
	const lines = await gitLines(worktree, ["status", "--porcelain"]);
	if (lines === null) return { ok: false, error: "not a git worktree" };
	const status = lines.filter((l) => l.trim() !== "").join("\n");
	if (status !== "")
		return { ok: false, error: "worktree not committed", status };
	return { ok: true };
}

/** The card's changed files under `projects/`, from the branch diff against its
 *  fork point (three-dot: a rebased branch diffs against its new fork point). */
async function changedProjectsFiles(target: SyncGateTarget): Promise<string[]> {
	if (target.base === null) return [];
	const lines = await gitLines(target.worktree, [
		"diff",
		"--name-only",
		`${target.base}...HEAD`,
		"--",
		"projects/",
	]);
	if (lines === null) return [];
	return lines
		.filter((l) => l.startsWith("projects/") && l.trim() !== "")
		.map((l) => l.trim());
}

/** sha256 comparison for each changed `projects/<p>/<rest>` file: the worktree
 *  source against its installed twin at the workspace root. */
async function fileHashes(target: SyncGateTarget): Promise<SyncGateFileHash[]> {
	const paths = await changedProjectsFiles(target);
	return Promise.all(
		paths.map(async (path) => {
			const rest = path.slice("projects/".length);
			const [sourceSha256, installedSha256] = await Promise.all([
				sha256File(join(target.worktree, path)),
				sha256File(join(target.workspaceRoot, rest)),
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

/** One gate step: guards, the sync.mjs run in the worktree, the per-file hashes,
 *  and the tracked record. Refusals record too, so every attempt is store data. */
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
	const clean = await checkCleanWorktree(target.worktree);
	if (!clean.ok)
		return record({
			code: null,
			output: "",
			truncated: false,
			files: [],
			error: clean.status ? `${clean.error}:\n${clean.status}` : clean.error,
		});
	const result = await runChild(
		target.worktree,
		["node", syncMjs, "--data", "."],
		gateEnv(target.alateDir),
	);
	const files = await fileHashes(target);
	return record({
		code: result.code,
		output: result.output,
		truncated: result.truncated,
		files,
		...(result.spawnError !== undefined ? { error: result.spawnError } : {}),
	});
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
