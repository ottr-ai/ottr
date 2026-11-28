import { execFile } from "node:child_process";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { prepareTurnCache } from "./cachesweep.ts";
import { errmsg } from "./errmsg.ts";
import { boardOmpHome } from "./login.ts";
import { runMarkerPath, touchRunMarker } from "./tmpsweep.ts";
import {
	applyTurnHomeEnv,
	closeProjectDir,
	ensureProjectIdentity,
	ensureTurnStoreAccess,
	isolationEnabled,
	newLayerToken,
	type ProvisionPaths,
	prepareRunWorkspace,
	prepareTurnHome,
	projectTurnUid,
	releaseLayerCopyUse,
	resolvePinnedLayer,
	type TurnIdentity,
	turnHomesRoot,
} from "./turnUid.ts";

/** Only the merge dispatcher requests a local project identity. */
export interface LocalMergeIdentity {
	workspaceRoot: string;
	/** Test fixtures replace shared roots and account files, never the uid. */
	homesRoot?: string;
	workerHome?: string;
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
	const workerHome = request.workerHome ?? homedir();
	if (realpathSync(workerHome) === realpathSync(boardOmpHome()))
		throw new Error(
			"merge turn requires a shared home distinct from the private board home",
		);
	const ids = projectTurnUid(project);
	const homesRoot = request.homesRoot ?? turnHomesRoot();
	const turnHome = prepareTurnHome(homesRoot, project, ids);
	let releaseCopy = (): void => {};
	let runtimeDir: string | null = null;
	let scratch: string | null = null;
	let heartbeat: NodeJS.Timeout | undefined;
	const release = (): void => {
		clearInterval(heartbeat);
		try {
			releaseCopy();
		} finally {
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
		}
	};
	try {
		prepareRunWorkspace(cwd, ids, request.workspaceRoot, project);
		await captureGitIdentity(cwd, env);
		const copyToken = newLayerToken();
		const pinnedLayer = resolvePinnedLayer(workerHome, env.HOME);
		if (pinnedLayer !== null)
			releaseCopy = () =>
				releaseLayerCopyUse(turnHome.layers, basename(pinnedLayer), copyToken);
		const home = applyTurnHomeEnv(env, {
			workerHome,
			turnHome,
			ids,
			copyToken,
			resolveLayer: () => pinnedLayer,
		});
		// The board's PI_CODING_AGENT_DIR must never select its private store.
		env.PI_CODING_AGENT_DIR = join(home.home, ".omp", "agent");
		ensureTurnStoreAccess(
			workerHome,
			join(env.PI_CODING_AGENT_DIR, "agent.db"),
			ids,
		);
		ensureProjectIdentity(project, ids, turnHome, request.provisionPaths);
		mkdirSync(sessionDir, { recursive: true });
		closeProjectDir(dirname(sessionDir), ids);
		const cache = prepareTurnCache(homesRoot, project, ids);
		if (cache === null)
			throw new Error(
				`merge turn cache preparation failed: ${join(homesRoot, project, "cache")}`,
			);
		Object.assign(env, cache.cacheEnv);
		scratch = mkdtempSync(join(cache.tmp, "run-merge-"));
		chownSync(scratch, ids.uid, ids.gid);
		env.TMPDIR = scratch;
		// Linux's host-global temp root stays reachable even with a private board TMPDIR.
		env.OTTR_TMP_ROOT = "/tmp";
		runtimeDir = mkdtempSync(join(cache.tmp, "run-merge-config-"));
		chmodSync(runtimeDir, 0o755);
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
