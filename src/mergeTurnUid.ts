import { execFile } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { prepareTurnCache } from "./cachesweep.ts";
import { errmsg } from "./errmsg.ts";
import { boardOmpHome } from "./login.ts";
import { prepareMergeHome, trustedMergeSource } from "./mergeHome.ts";
import { runMarkerPath, touchRunMarker } from "./tmpsweep.ts";
import {
	closeProjectDir,
	ensureProjectIdentity,
	isolationEnabled,
	type ProvisionPaths,
	prepareRunWorkspace,
	prepareTurnHome,
	projectTurnUid,
	type TurnIdentity,
	turnHomesRoot,
} from "./turnUid.ts";

/** Only the merge dispatcher requests a local project identity. */
export interface LocalMergeIdentity {
	workspaceRoot: string;
	/** Test fixtures replace shared roots and account files, never the uid. */
	homesRoot?: string;
	provisionPaths?: ProvisionPaths;
}

export function mergeTurnIsolationEnabled(): boolean {
	return process.platform === "linux" && isolationEnabled();
}

/** Package preparation stays privileged and writes outside the private board home. */
export function mergeTurnProvisionHome(project: string): string {
	return prepareTurnHome(turnHomesRoot(), project, projectTurnUid(project))
		.provision;
}

export interface PreparedLocalMerge {
	ids: TurnIdentity;
	env: Record<string, string | undefined>;
	runtimeDir: string;
	scratch: string;
	release: () => void;
}

const git = promisify(execFile);

/** Carry only identity values across the boundary, not a private config or its credentials. */
async function captureGitIdentity(
	cwd: string,
	env: Record<string, string | undefined>,
): Promise<void> {
	for (const field of ["NAME", "EMAIL"] as const) {
		if (
			env[`GIT_AUTHOR_${field}`] !== undefined &&
			env[`GIT_COMMITTER_${field}`] !== undefined
		)
			continue;
		let value: string;
		try {
			const result = await git(
				"git",
				[
					"-c",
					`safe.directory=${cwd}`,
					"config",
					"--get",
					`user.${field.toLowerCase()}`,
				],
				{ cwd, env },
			);
			value = result.stdout.trim();
		} catch (error) {
			// git config uses exit 1 only for an absent key.
			if (
				error !== null &&
				typeof error === "object" &&
				"code" in error &&
				error.code === 1
			)
				continue;
			throw new Error(
				`merge turn Git identity preparation failed: ${errmsg(error)}`,
				{ cause: error },
			);
		}
		if (value !== "") {
			env[`GIT_AUTHOR_${field}`] ??= value;
			env[`GIT_COMMITTER_${field}`] ??= value;
		}
	}
	env.GIT_CONFIG_GLOBAL = undefined;
}

/** All root filesystem work precedes spawn; every failure keeps the child absent. */
export async function prepareLocalMerge(
	request: LocalMergeIdentity,
	project: string,
	cwd: string,
	sessionDir: string,
	env: Record<string, string | undefined>,
): Promise<PreparedLocalMerge> {
	const boardHome = boardOmpHome();
	const sourceHome = env.HOME ?? boardHome;
	trustedMergeSource(boardHome, sourceHome);
	const ids = projectTurnUid(project);
	const homesRoot = request.homesRoot ?? turnHomesRoot();
	const turnHome = prepareTurnHome(homesRoot, project, ids);
	let runtimeDir: string | null = null;
	let scratch: string | null = null;
	let heartbeat: NodeJS.Timeout | undefined;
	const release = (): void => {
		clearInterval(heartbeat);
		try {
			if (runtimeDir !== null) {
				rmSync(runtimeDir, { recursive: true, force: true });
				rmSync(runMarkerPath(runtimeDir), { force: true });
			}
		} finally {
			if (scratch !== null) {
				rmSync(scratch, { recursive: true, force: true });
				rmSync(runMarkerPath(scratch), { force: true });
			}
		}
	};
	try {
		prepareRunWorkspace(cwd, ids, request.workspaceRoot, project);
		env.GIT_CONFIG_SYSTEM = "/etc/gitconfig";
		env.XDG_CONFIG_HOME = join(sourceHome, ".config");
		if (env.GIT_CONFIG_GLOBAL !== undefined)
			trustedMergeSource(
				env.GIT_CONFIG_GLOBAL === "/etc/ottr/gitconfig"
					? "/etc/ottr"
					: boardHome,
				env.GIT_CONFIG_GLOBAL,
			);
		await captureGitIdentity(cwd, env);
		ensureProjectIdentity(project, ids, turnHome, request.provisionPaths);
		mkdirSync(sessionDir, { recursive: true });
		closeProjectDir(dirname(sessionDir), ids);
		const cache = prepareTurnCache(homesRoot, project, ids);
		if (cache === null)
			throw new Error(
				`merge turn cache preparation failed: ${join(homesRoot, project, "cache")}`,
			);
		Object.assign(env, cache.cacheEnv);
		// Workers mount the turn-home roots. Private board state must stay server-local.
		scratch = mkdtempSync("/tmp/ottr-merge-state-");
		env.TMPDIR = scratch;
		// Linux's host-global temp root stays reachable even with a private board TMPDIR.
		env.OTTR_TMP_ROOT = "/tmp";
		runtimeDir = mkdtempSync("/tmp/ottr-run-merge-config-");
		chownSync(runtimeDir, process.geteuid?.() ?? 0, ids.gid);
		chmodSync(runtimeDir, 0o750);
		prepareMergeHome(
			boardHome,
			sourceHome,
			join(runtimeDir, "home"),
			join(scratch, "omp-state"),
			ids,
			env,
		);
		chownSync(scratch, ids.uid, ids.gid);
		const livePaths = [scratch, runtimeDir];
		const refresh = (): void => {
			for (const path of livePaths) touchRunMarker(path);
		};
		refresh();
		heartbeat = setInterval(refresh, 60_000);
		heartbeat.unref();
		return { ids, env, runtimeDir, scratch, release };
	} catch (error) {
		release();
		throw error;
	}
}
