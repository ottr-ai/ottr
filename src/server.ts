// Ottr: HTTP API + board + per-project turn scheduling.
// Startup and wiring only: routes live in createApp() (src/app.ts), the turn
// engine lives in createTurnLoop() (src/turn.ts). This file binds them.

import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import type { Server } from "bun";
import {
	type App,
	createApp,
	ompSessionStores,
	storedProjectPaths,
} from "./app.ts";
import { ensureProjectPackages } from "./apt.ts";
import { newSecret } from "./auth.ts";
import {
	backupSources,
	backupTick,
	POSTGRES_BACKUP_NOTICE,
	resolveBackup,
} from "./backup.ts";
import {
	CACHE_SWEEP_INTERVAL_MS,
	projectCacheRoots,
	serverTurnCacheRoot,
	sweepCacheRootsLog,
} from "./cachesweep.ts";
import { logError, trapCrashes } from "./crash.ts";
import { pidAlive, StoreLockedError } from "./dblock.ts";
import { devNullGuard } from "./devNullGuard.ts";
import { errmsg } from "./errmsg.ts";
import { defaultSshDir } from "./gitHosts.ts";
import { syncWorktreeTo } from "./gitHttp.ts";
import { githubHost } from "./githubHost.ts";
import type { CommitIdentity } from "./gitIdentity.ts";
import { GlobalStore } from "./globalStore.ts";
import {
	type CreditBalance,
	controlPlaneHooks,
	type Hosted,
	scrubProcEnviron,
	takeHostedConfig,
} from "./hosted.ts";
import { startLlmGateway } from "./llmGateway.ts";
import { agentDir, boardOmpEnv, boardOmpHome, turnListHome } from "./login.ts";
import {
	createOmpStatsDashboard,
	parseOmpStatsPort,
} from "./ompStatsDashboard.ts";
import { orphanPids } from "./orphans.ts";
import { platform } from "./platform/index.ts";
import { initializeDatabaseConfig } from "./postgresConfig.ts";
import { closePostgresBackend, getPostgresDatabase } from "./postgresDriver.ts";
import { replayGateParks } from "./promptGate.ts";
import {
	commentOnPullRequest,
	listPulls,
	openPrsView,
	openPullRequest,
} from "./prs.ts";
import { fetchQuota } from "./quota.ts";
import {
	landPostReleaseCommand,
	latestImage,
	ownerRepo,
	publishRelease,
	releaseChip,
	runGh,
	runPostReleaseCommand,
	runReleaseCommand,
} from "./release.ts";
import { cachedRepoHomepage } from "./repoHomepage.ts";
import { publicHosts } from "./requestGuards.ts";
import { startRun, vmRunnerFromEnv, workerFromEnv } from "./runner.ts";
import { RunTokens } from "./runTokens.ts";
import { archReviewView, blockingReview, lastFullReview } from "./scheduler.ts";
import { loadSecretBox, type SecretBox } from "./secretBox.ts";
import { sessionFile } from "./session.ts";
import {
	extractInlinePids,
	extractLockPaths,
	extractPidPaths,
	extractPorts,
	lastToolCall,
	lockFacts,
	pidFileFacts,
	portListeners,
	readTree,
	type StaleFix,
	type StaleProbe,
	staleKillLocal,
	staleUnlockLocal,
} from "./staleTurn.ts";
import {
	type AdoptResult,
	adoptSharedProjectData,
	discoverProjects,
	ProjectStore,
} from "./store.ts";
import { createSupervisor } from "./supervisor.ts";
import { sweepSeenOps } from "./sweepSeen.ts";
import { sweepTmpDirsLogged } from "./tmpsweep.ts";
import { turnEnv } from "./tokens.ts";
import { envValuesByKind, listedEnvNames } from "./tools.ts";
import {
	appendLog,
	createTurnLoop,
	type TurnProject as Entry,
	getSettingsLogged,
	parseReleaseVersion,
	type TurnLoop,
} from "./turn.ts";
import { prepareTurnPackages } from "./turnPackages.ts";
import type { CheckRoutingSetting, LatestImage, OpenPrsView } from "./types.ts";
import { probeVmRunner } from "./vmHealth.ts";
import { VmTokens } from "./vmTokens.ts";
import {
	detachedRuns as detachedRunsRequest,
	killDetached as killDetachedRequest,
	probeRun as probeRunRequest,
	staleFix as staleFixRequest,
	sweepWorker as sweepWorkerRequest,
	type WorkerTarget,
} from "./workers.ts";
import {
	archReviewDelta,
	branchMergedOrGone,
	branchUnpushed,
	changedFiles,
	checkedOutBranch,
	checkoutState,
	cleanMergeTree,
	commitFileOnBranch,
	commitsAhead,
	createWorktree,
	deleteRemoteBranch,
	describeVersion,
	diffStat,
	diffText,
	fetchOriginBranch,
	fetchPrHead,
	git,
	githubUrlFromPin,
	hasRules,
	ignoreInMain,
	integrationSha,
	isClean,
	isGitRepoWithCommit,
	isIntegrated,
	mergeHoldLanded,
	mergeHoldMismatch,
	originRemoteUrl,
	prIntegrated,
	pushBranch,
	quarantineUntracked,
	rebaseTargetBranch,
	remoteUrl,
	removeWorktree,
	resetBranchTo,
	resolveTarget,
	revListCount,
	runMergeGates,
	saveDoneFiles,
	serverMergePush,
	setWorkerRoots,
	statusFiles,
	statusRows,
	targetCommits,
	targetContains,
	targetTracksRules,
	trackedFiles,
	treesEqual,
	unsavedWork,
	worktreeHusk,
	worktreeLinked,
} from "./worktree.ts";

const DATABASE = initializeDatabaseConfig();

const PORT = Number(process.env.PORT ?? 4747);
/** Bind address; set OMP_TRACKER_HOST (e.g. 0.0.0.0) to serve beyond loopback. */
const HOST = process.env.OMP_TRACKER_HOST ?? "127.0.0.1";
/** Parsed once at startup: env is static for the life of the process. */
const PUBLIC_HOSTS = publicHosts();
/**
 * Hosted mode (docs/specs/hosted-mode.md): null on every self-hosted board, and then no hosted hook
 * exists. A half-set hosted env throws here and stops the boot.
 */
const HOSTED = takeHostedConfig();
/** The credits cell the credit gate records into, and the state payload reads per frame. */
const creditBalance: CreditBalance = { balance: null };
const hosted: Hosted | undefined =
	HOSTED === null
		? undefined
		: {
				config: HOSTED,
				hooks: controlPlaneHooks(HOSTED, { credit: creditBalance }),
				creditBalance,
			};
/** Production mode: the board is static (no WebSocket); UI bundles/minifies via Bun. */
const PROD = process.env.NODE_ENV === "production";
// Refuse an invalid OTTR_GITHUB_HOST at boot: every GitHub feature would otherwise aim at
// the wrong host. githubHost() throws the same message at every later use.
githubHost();
const EXTENSION = resolve(import.meta.dir, "..", "extension", "tracker.ts");
const ROOTS = process.env.OMP_TRACKER_ROOTS
	? process.env.OMP_TRACKER_ROOTS.split(delimiter)
			.map((s) => s.trim())
			.filter(Boolean)
	: [resolve(import.meta.dir, "..", "..")];
// Scratch tests and dev boards set OTTR_STATE_DIR so the global kv store never
// opens (and locks) the checkout's own tracker.db.
const STATE_DIR = process.env.OTTR_STATE_DIR ?? resolve(import.meta.dir, "..");
if (DATABASE.backend === "postgres") {
	console.log(
		`database: postgres host=${JSON.stringify(DATABASE.host)} database=${JSON.stringify(DATABASE.database)}`,
	);
} else {
	console.log("database: sqlite");
}

/** Inspect paths only. Never open or converge the SQLite files during PostgreSQL startup. */
function hasLiveSqliteState(): boolean {
	const present = (path: string): boolean =>
		lstatSync(path, { throwIfNoEntry: false }) !== undefined;
	const children = (path: string): string[] => {
		try {
			return readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(path, entry.name));
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" ||
				(error as NodeJS.ErrnoException).code === "ENOTDIR"
			)
				return [];
			throw error;
		}
	};
	try {
		if (present(join(resolve(STATE_DIR), ".tasks", "tracker.db"))) return true;
		for (const root of ROOTS) {
			for (const project of [resolve(root), ...children(root)]) {
				if (present(join(project, ".tasks", "tasks.db"))) return true;
			}
		}
		for (const root of [
			process.env.OTTR_DATA_DIR,
			process.env.OTTR_SERVER_DATA_DIR,
		]) {
			if (!root) continue;
			for (const project of children(resolve(root))) {
				if (present(join(project, "tasks.db"))) return true;
			}
		}
		return false;
	} catch {
		throw new Error(
			"Cannot inspect existing SQLite state before PostgreSQL startup.",
		);
	}
}

async function openGlobalStore(): Promise<GlobalStore> {
	if (DATABASE.backend === "sqlite") return GlobalStore.open(STATE_DIR);
	try {
		// Keep this reference through initialization so ownership has no gap after inspection.
		const guard = await getPostgresDatabase("ottr_global");
		try {
			const global = await guard.serialize(() =>
				guard
					.query<{ present: number }, [string]>(
						"SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname = ?",
					)
					.get("ottr_global"),
			);
			if (
				global === null &&
				process.env.OTTR_PG_ALLOW_EMPTY !== "1" &&
				hasLiveSqliteState()
			) {
				throw new Error(
					"PostgreSQL has no ottr_global schema, but live SQLite state exists. Run bun src/import-sqlite-to-postgres.ts first, or set OTTR_PG_ALLOW_EMPTY=1 to accept an empty backend.",
				);
			}
			return await GlobalStore.open(STATE_DIR);
		} finally {
			await guard.close();
		}
	} catch (error) {
		await closePostgresBackend();
		throw error;
	}
}

const gstore = await openGlobalStore();
/** Jira token sealing (docs/specs/jira-import.md section 1): the key file sits next to tracker.db.
 * A malformed key never stops the boot: the Jira routes answer 503 until it is fixed. */
let secretBox: SecretBox | undefined;
try {
	secretBox = loadSecretBox({ dir: join(resolve(STATE_DIR), ".tasks") });
} catch (err) {
	console.error(`jira: secret key: ${errmsg(err)}; Jira routes are off`);
}
// The catch above is for key-resolution failures only. A scrub refusal (the key
// is still readable in /proc/<pid>/environ) escapes loadSecretBox's finally into
// that catch, so it must refuse the boot here: a no-op when the scrub succeeded,
// a module-level throw when the entry survives.
scrubProcEnviron("OTTR_SECRET_KEY");

// Mutable settings shared with createApp: /api/settings writes them, the scheduler and
// discovery read them. The persisted project lists load here, before boot discovery: a
// removed project must stay off the board after a restart.
const shared: {
	maxTotalRuns: number | null;
	/** True when a review's findings are checked by a second model before they become cards. */
	reviewCheck: boolean;
	/** True when a finished work card is checked by a second model before it enters the merge queue. */
	workCheck: boolean;
	/** Default on; POST /api/settings writes it, the idle review tick reads it. */
	idleReviews: boolean;
	/** Default on; POST /api/settings writes it, the weekly trending tick reads it. */
	trendingScan: boolean;
	/** OTTR-693: the commit identity Settings names for board and turn commits; null keeps the built-in Ottr default. */
	commitIdentity: CommitIdentity | null;
	/** OTTR-1116: the user-set vendor routing for the check run's role; null = automatic. */
	checkRouting: CheckRoutingSetting | null;
	removedPaths: string[]; // projects removed from the board; discovery must not re-find them
	projectPaths: string[]; // explicitly added projects; discovery finds these even outside the roots
	/** Project names in board order, persisted via /api/projects/order. */
	projectOrder: string[];
	/** /api/settings/env writes saved values here; the loop reads them per turn. */
	envValues: Record<string, string>;
	/** Plain (not secret) env values, one per env.txt name marked `plain`; never redacted. */
	envPlain: Record<string, string>;
} = {
	// "none" starts the board with no global cap, like the Settings choice.
	maxTotalRuns:
		process.env.OMP_TRACKER_MAX_TOTAL === "none"
			? null
			: Number(process.env.OMP_TRACKER_MAX_TOTAL ?? 20),
	reviewCheck: true,
	workCheck: true,
	idleReviews: true,
	trendingScan: true,
	commitIdentity: null,
	checkRouting: null,
	envValues: {},
	envPlain: {},
	...(await storedProjectPaths(gstore)),
};

const projects = new Map<string, Entry>();
let shuttingDown = false;
const timers: Timer[] = [];
const activeWork = new Set<Promise<unknown>>();
const serverRef: { current: Server<undefined> | undefined } = {
	current: undefined,
};
let statsServer: Server<undefined> | undefined;
let backupWork: Promise<void> | undefined;

function runWork(work: () => void | Promise<unknown>): void {
	if (shuttingDown) return;
	const pending = Promise.resolve().then(() => {
		if (!shuttingDown) return work();
	});
	activeWork.add(pending);
	void pending
		.catch((err) => logError("background work failed", err))
		.finally(() => {
			activeWork.delete(pending);
		});
}

function every(work: () => void | Promise<unknown>, ms: number): void {
	timers.push(setInterval(() => runWork(work), ms));
}
/** Set once createTurnLoop returns; a signal during boot finds no live turns and skips the kill sweep. */
let loopRef: TurnLoop | undefined;
let appRef: App | undefined;
/** Stop new work, settle active callbacks, and release all locks before exit. */
export async function shutdown(exitCode: number): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const timer of timers) clearInterval(timer);
	let failed = false;
	for (const h of loopRef?.running.values() ?? []) {
		if (h.pid === null) continue;
		try {
			platform.killTree(h.pid);
		} catch (err) {
			failed = true;
			logError("shutdown: could not stop a turn", err);
		}
	}
	const stopped = await Promise.allSettled([
		serverRef.current?.stop(true),
		statsServer?.stop(true),
		...activeWork,
		backupWork,
	]);
	for (const result of stopped) {
		if (result.status !== "rejected") continue;
		failed = true;
		logError("shutdown: active work failed", result.reason);
	}
	try {
		await appRef?.close();
	} catch (err) {
		failed = true;
		logError("shutdown: could not close the app", err);
	}
	for (const e of projects.values()) {
		try {
			await e.store.close();
		} catch (err) {
			failed = true;
			logError(`shutdown: could not close ${e.name}`, err);
		}
	}
	try {
		await gstore.close();
	} catch (err) {
		failed = true;
		logError("shutdown: could not close the global store", err);
	}
	try {
		await closePostgresBackend();
	} catch (err) {
		failed = true;
		logError("shutdown: could not close the PostgreSQL backend", err);
	}
	process.exit(exitCode === 0 && failed ? 1 : exitCode);
}
// omp must not outlive the tracker: when the server goes down, the turns it
// was running go with it (and store closes drop the databases' exclusive lock).
process.on("exit", () => {
	for (const h of loopRef?.running.values() ?? [])
		if (h.pid !== null) platform.killTree(h.pid);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => void shutdown(128 + constants.signals[signal]));
}
// A bug in a timer tick or a fire-and-forget must log and keep the board up, not kill the server:
// every loop here re-runs on its own schedule, so the failing tick heals itself on the next pass.
trapCrashes();

// Image chips re-probe ghcr.io at most this often; an image published without a matching tag
// waits out the TTL.
const IMAGE_TTL = 15 * 60_000;
const imageChips = new Map<string, { at: number; value: LatestImage | null }>();

/** ghcr.io probe piggybacking on the release refresh: writes e.latestImage, one probe per TTL per repo. */
function refreshImage(e: Entry, publish?: () => void): void {
	const repo = e.github === null ? null : ownerRepo(e.github);
	if (repo === null) return;
	const cached = imageChips.get(repo);
	if (cached !== undefined && Date.now() - cached.at < IMAGE_TTL) {
		e.latestImage = cached.value;
		return;
	}
	// Seed before fetching so a hung probe cannot stack one request per scheduler tick.
	imageChips.set(repo, { at: Date.now(), value: null });
	latestImage(repo)
		.then((value) => {
			imageChips.set(repo, { at: Date.now(), value });
			// OTTR-884: this write lands outside the refresh cycle's awaited window, so the
			// probe detects its own flag edge — a changed chip republishes, an unchanged
			// one leaves the single-flight state cache alone.
			const prev = e.latestImage;
			e.latestImage = value;
			// The view's field order is fixed by its builder, so a stringify compare
			// is a faithful value compare here.
			if (JSON.stringify(prev) !== JSON.stringify(value)) publish?.();
		})
		.catch(() => {}); // ghcr unreachable: keep the null seed until the next TTL
}

/** The chip's latest release: the repo's latest GitHub release when the project has a
 * GitHub remote and GitHub answers, else the highest vX.Y.Z tag merged into the target;
 * null when the target is unknown, like archReview. */
async function refreshRelease(e: Entry, publish?: () => void): Promise<void> {
	if (e.target === null) {
		e.latestRelease = null;
		e.latestReleaseUrl = null;
		return;
	}
	const chip = await releaseChip({
		repo: e.github === null ? null : ownerRepo(e.github),
		mainPath: e.path,
		target: e.target,
	});
	e.latestRelease = chip.release;
	e.latestReleaseUrl = chip.url;
	refreshImage(e, publish);
}

/** Commits since the last review on the target; null with no target or when git fails, like latestRelease. */
async function refreshArchReview(e: Entry): Promise<void> {
	if (e.target === null) {
		e.archReview = null;
		return;
	}
	// One anchor for the count and the view: the delta counts from the newest done full
	// review's base (a release card must not reset it, docs/specs/mutation-delta.md §6), and
	// archReviewView reads the same base, so Settings cannot disagree with the count.
	const last = lastFullReview(await e.store.listTasks());
	const a = await archReviewDelta(
		e.path,
		e.target,
		last === null ? null : last.base,
	).catch(() => null);
	const { cap, runningCardId } = await e.store.transaction(async () => ({
		cap: (await getSettingsLogged(e)).archReviewCap,
		// Running: a review is queued or running, or its findings are still landing.
		runningCardId: blockingReview(await e.store.listTasks())?.id ?? null,
	}));
	e.archReview =
		a === null ? null : archReviewView(last, a, cap, runningCardId);
}

/** Open-PR header chips re-probe gh at most this often; a PR opened between probes waits out the TTL. */
const PR_TTL = 10 * 60_000;
const prChips = new Map<string, { at: number; value: OpenPrsView | null }>();

/** Homepage links piggyback on the project metadata poll, with repo-scoped cached probes. */
function refreshHomepage(e: Entry, publish?: () => void): void {
	const repo = e.github === null ? null : ownerRepo(e.github);
	if (repo === null) {
		const previous = e.homepage;
		e.homepage = null;
		e.homepageRepo = null;
		if (previous != null) publish?.();
		return;
	}
	if (e.homepageRepo !== repo) {
		const previous = e.homepage;
		e.homepageRepo = repo;
		e.homepage = null;
		if (previous != null) publish?.();
	}
	void cachedRepoHomepage(repo).then((value) => {
		if (
			e.homepageRepo !== repo ||
			e.github === null ||
			ownerRepo(e.github) !== repo
		)
			return;
		const previous = e.homepage;
		e.homepage = value;
		if (JSON.stringify(previous) !== JSON.stringify(value)) publish?.();
	});
}

/** Open-PR chips piggybacking on the release refresh: writes e.openPrs, one gh probe per TTL per repo. */
function refreshOpenPrs(e: Entry, publish?: () => void): void {
	refreshHomepage(e, publish);
	const repo = e.github === null ? null : ownerRepo(e.github);
	if (repo === null) {
		e.openPrs = null;
		return;
	}
	const cached = prChips.get(repo);
	if (cached !== undefined && Date.now() - cached.at < PR_TTL) {
		e.openPrs = cached.value;
		return;
	}
	// Seed before fetching so a hung probe cannot stack one request per scheduler tick.
	prChips.set(repo, { at: Date.now(), value: null });
	listPulls(repo, runGh)
		.then((pulls) => {
			const value = openPrsView(pulls, repo);
			prChips.set(repo, { at: Date.now(), value });
			// OTTR-884: this write lands outside the refresh cycle's awaited window, so the
			// probe detects its own flag edge — a changed chip republishes, an unchanged
			// one leaves the single-flight state cache alone.
			const prev = e.openPrs;
			e.openPrs = value;
			// The view's field order is fixed by its builder, so a stringify compare
			// is a faithful value compare here.
			if (JSON.stringify(prev) !== JSON.stringify(value)) publish?.();
		})
		.catch(() => {}); // gh unreachable: keep the null seed until the next TTL
}

/** Local tip of a ref, else null (quiet rev-parse): the push-sha capture compares local and pushed. */
async function targetSha(
	mainPath: string,
	ref: string,
): Promise<string | null> {
	const r = await git(
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		mainPath,
	).catch(() => null);
	return r && r.code === 0 ? r.stdout.trim() || null : null;
}

// The server's own checkout; in the stable deployment this is the live clone.
const SELF_ROOT = resolve(import.meta.dir, "..");

/** Shipped on every /api/state; stale tabs compare it against the first version they saw and reload once.
 * The image's OTTR_VERSION stamp, else the release tag HEAD carries, else short sha on dev, else boot time. */
const serverVersion = await describeVersion(SELF_ROOT);

if (
	DATABASE.backend === "sqlite" &&
	process.env.OTTR_DATA_DIR &&
	process.env.OTTR_SERVER_DATA_DIR
) {
	let adopted: AdoptResult[] = [];
	try {
		adopted = await adoptSharedProjectData(
			process.env.OTTR_DATA_DIR,
			process.env.OTTR_SERVER_DATA_DIR,
		);
	} catch (err) {
		// Same as the open loop below: a live board holding an old DB must stop this boot.
		if (err instanceof StoreLockedError) {
			logError("refusing to start", err);
			await shutdown(1);
		}
		throw err;
	}
	for (const r of adopted) {
		if (r.status === "adopted")
			console.log(`moved project database ${r.name} to the server data dir`);
		else
			console.error(
				`could not move project database ${r.name} to the server data dir (${r.error}); move it by hand, see docs/WORKERS.md`,
			);
	}
} else if (DATABASE.backend === "sqlite" && process.env.OTTR_DATA_DIR) {
	console.warn(
		"OTTR_SERVER_DATA_DIR is not set: project databases stay on the worker-shared data dir (OTTR_DATA_DIR)",
	);
}

// R5-1 (docs/specs/pinned-origin-url.md): when a worker boundary exists (OTTR_DATA_DIR is
// the shared volume the workers mount read-write), a local pinned origin under a
// worker-writable root would let the board push into a repo a work turn can rewrite. The
// roots are the project roots, the data dir, and the server's own home — compose mounts the
// shared `home` volume at /root into the server and every worker (docker-compose.yml). The
// pinned-URL check refuses those pins at every use. Native single-user boards (no
// OTTR_DATA_DIR) check nothing, as before.
const workerRoots = process.env.OTTR_DATA_DIR
	? [...ROOTS, resolve(process.env.OTTR_DATA_DIR), homedir()]
	: [];
if (process.env.OTTR_DATA_DIR) setWorkerRoots(workerRoots);

let registeredProjects: string[] | undefined;
if (DATABASE.backend === "postgres") {
	try {
		const registry = await getPostgresDatabase("ottr_global");
		try {
			registeredProjects = await registry.serialize(async () =>
				(
					await registry
						.query<{ project_name: string }, []>(
							'SELECT project_name FROM "ottr_global"."project_registry"',
						)
						.all()
				).map((row) => row.project_name),
			);
		} finally {
			await registry.close();
		}
	} catch (err) {
		logError("refusing to read the PostgreSQL project registry", err);
		await shutdown(1);
	}
}

/** Projects whose tasks.db did not open at boot: the backup records each as a failed database,
 * so retention keeps the last good copy (docs/specs/db-backup.md). */
const unopenedProjects: { name: string; error: string }[] = [];
for (const p of discoverProjects(
	ROOTS,
	shared.projectPaths,
	shared.removedPaths,
	registeredProjects,
)) {
	let store: ProjectStore;
	try {
		store = await ProjectStore.open(p);
	} catch (err) {
		if (err instanceof StoreLockedError || DATABASE.backend === "postgres") {
			// A second server must refuse startup and release all stores it opened.
			logError("refusing to start", err);
			await shutdown(1);
		}
		// One unreadable project database must not keep the whole board from booting.
		console.error(`skipping project ${p}:`, err);
		unopenedProjects.push({ name: basename(p), error: errmsg(err) });
		continue;
	}
	if (shuttingDown) {
		await store.close();
		break;
	}
	const e: Entry = {
		store,
		name: store.name,
		path: p,
		target: null,
		gitless: true,
		github: null,
		protectedTarget: false,
		remote: null,
		dirty: false,
		mainUnpushed: false,
		mainBranch: null,
		latestRelease: null,
		latestImage: null,
		archReview: null,
		openPrs: null,
	};
	projects.set(store.name, e);
	e.gitless = !(await isGitRepoWithCommit(p));

	// R5-1 (docs/specs/pinned-origin-url.md): pin the origin URL before the loop starts and
	// any turn can run — awaited, so a merge cannot dispatch against an unpinned origin.
	if (!e.gitless) {
		const pin = await originRemoteUrl(p).catch(() => null);
		if (pin !== null)
			await store.transaction(async () => {
				if ((await store.getSettings()).originUrl === null)
					await store.setSettings({ originUrl: pin });
			});
	}

	await resolveTarget(p, false, null, (await store.getSettings()).targetBranch)
		.then((r) => {
			e.target = r.target;
			// OTTR-605: a repo whose origin has no branch for the local branch yet (awaiting
			// its first push) resolves aspirationally; show the "Push to origin" advisory
			// from boot, before the first tick's branchUnpushed refresh confirms it.
			if (r.unpushed === true) e.mainUnpushed = true;
		})
		.catch(() => {});
	e.github = githubUrlFromPin((await store.getSettings()).originUrl);
	await remoteUrl(p)
		.then((u) => {
			e.remote = u;
		})
		.catch(() => {});
	// Stamp versions for tasks merged before the tracker kept them on the row (one scan per
	// boot); the same pass re-checks stamped non-release cards, because only a real tag
	// anchors a release pill — prose that merely names a version must not keep one. A version
	// a release card already owns is claimed twice: the prose stamp loses.
	const { tasks, releaseOwned } = await store.transaction(async () => {
		const tasks = await store.listTasks();
		const releaseOwned = new Set<string>();
		for (const t of tasks)
			if (t.base !== null && t.releaseVersion !== null)
				releaseOwned.add(t.releaseVersion);
		return { tasks, releaseOwned };
	});
	for (const t of tasks) {
		if (t.stage !== "done" || t.base !== null || t.cancelledAt !== null)
			continue;
		const last = (await store.listTurns(t.id)).at(-1);
		const version =
			t.releaseVersion ??
			(last?.kind === "merge" && last.outcome === "integrated"
				? parseReleaseVersion(`${last.summary ?? ""}\n${last.details ?? ""}`)
				: null);
		if (version === null) continue;
		const probe = await git(
			["rev-parse", "--verify", "--quiet", `refs/tags/${version}^{commit}`],
			p,
		).catch(() => null);
		if (probe === null) continue; // git spawn failed: change nothing
		const anchored = probe.code === 0 && probe.stdout.trim() !== "";
		await store.transaction(async () => {
			const current = await store.getTask(t.id);
			if (
				current === null ||
				current.revision !== t.revision ||
				current.stage !== t.stage ||
				current.base !== t.base ||
				current.cancelledAt !== t.cancelledAt ||
				current.releaseVersion !== t.releaseVersion
			)
				return;
			if (anchored && !releaseOwned.has(version)) {
				if (t.releaseVersion === null)
					await store.updateTask(t.id, { releaseVersion: version });
			} else if (t.releaseVersion !== null) {
				// ponytail: an old merge-cut stamp whose tag exists but predates release cards cannot
				// be told apart from a kept release — it stays anchored and keeps its pill.
				await store.updateTask(t.id, { releaseVersion: null });
			}
		});
	}
}

// Task sessions' create_task tool talks to the tracker over loopback; an operator-provided
// OTTR_BOARD_URL (compose worker -> server address) wins. Off loopback the board files a card
// only with this token, new on every boot, which the runner hands each task session.
const board = {
	url: process.env.OTTR_BOARD_URL ?? `http://127.0.0.1:${PORT}`,
	token: newSecret(),
};

// Override for the worker folders (env.txt, tools.json, apt.txt): Settings and turns share
// it, so they never disagree. Unset = each reader's default (boardOmpHome() for env.txt and
// tools.json, R5-1; homedir() for apt.txt); the dev board pins a fixture so demo names stay
// off the real home.
const workersHome = process.env.OTTR_WORKERS_HOME;
const workerTarget = workerFromEnv();
// OTTR-532: the microVM runner (vm-runner) is no member of the worker pool: only microVM
// projects' eligible turns reach it, and the worker sign-in, /stats and /sweep loops (which
// walk workerTarget) never call it.
const vmTarget = vmRunnerFromEnv();
// One token store for the whole board: the turn loop issues and revokes, the /git, /llm and
// /hindsight routes check. Server-only dir, never the worker-shared data dir: the file lets
// a re-bound VM turn keep pushing after a board restart. No server dir = memory only.
const vmTokens = new VmTokens({
	file: process.env.OTTR_SERVER_DATA_DIR
		? join(resolve(process.env.OTTR_SERVER_DATA_DIR), "vm-tokens.json")
		: null,
});
// OTTR-1197: one credential per classic run for the sandbox endpoint, issued at
// dispatch and bound to the run's project and card. Memory only: a run's env
// dies with the run, and a board restart rotates the boot token too.
const runTokens = new RunTokens();
/** The board's provider gateway for VM turns' /llm proxy; null until it started. */
let llmGateway: { url: string; token: string; stop(): void } | null = null;
if (vmTarget !== null)
	startLlmGateway({
		agentDir: agentDir(),
		home: boardOmpHome(),
		log: (l) => console.log(l),
	})
		.then((g) => {
			llmGateway = g;
			// Its auth-broker and auth-gateway children must not outlive the board.
			process.on("exit", () => g.stop());
		})
		.catch((err) =>
			logError("the microVM provider gateway did not start", err),
		);

// Boot probe without blocking boot: until it answers, microVM cards wait unclaimed.
runWork(() => probeVmRunner(vmTarget));
every(() => probeVmRunner(vmTarget), 30_000);
// Demo board (src/dev.ts): the seeded gate card's meter needs a fabricated progress line,
// because no agent runs and loop.running stays empty. Real boards never set OTTR_DEMO and
// take loop.running only. The import is dynamic: the image ships src/ only, never scripts/,
// so a static import crashes every real board at boot. The demo board's slotsUsed comes
// from demoSlotsUsed for the same reason (OTTR-1143).
const demoData =
	process.env.OTTR_DEMO === "1"
		? await import("../scripts/demo-data.ts")
		: null;
const demoProgress = demoData ? await demoData.demoProgressMap(projects) : null;

// The loop owns the engine; the request layer calls back into it through deps.schedule, and
// the loop's publish/log plumbing is late-bound to createApp's handles (both exist by boot).

const loop = createTurnLoop(projects, {
	extensionPath: EXTENSION,
	board,
	maxTotalRuns: () => shared.maxTotalRuns,
	reviewCheck: () => shared.reviewCheck,
	workCheck: () => shared.workCheck,
	checkRouting: () => shared.checkRouting ?? null,
	quota: () => fetchQuota(boardOmpEnv()),
	drained: () => shuttingDown || app.drained(),
	stopping: () => shuttingDown,
	drainedRunner: (id) => app.drainedRunner(id),
	publishSoon: () => app.publishSoon(),
	notifyLog: (project, id) => app.notifyLog(project, id),
	// OTTR-884: the late probe writes inside refreshRelease/refreshOpenPrs publish their own
	// flag edges through the same handle, so a quiet board still never rebuilds from the tick.
	refreshRelease: (e) => refreshRelease(e, () => app.publishSoon()),
	refreshArchReview,
	refreshOpenPrs: (e) => refreshOpenPrs(e, () => app.publishSoon()),
	resolveTarget,
	createWorktree,
	removeWorktree,
	commitsAhead,
	changedFiles,
	diffStat,
	diffText,
	isClean,
	isIntegrated,
	unsavedWork,
	statusFiles,
	quarantineUntracked,
	saveDoneFiles,
	trackedFiles,
	worktreeHusk,
	worktreeLinked,
	ignoreInMain,
	branchMergedOrGone,
	hasRules,
	targetTracksRules,
	targetCommits,
	targetSha,
	targetContains,
	treesEqual,
	revListCount,
	cleanMergeTree,
	branchUnpushed,
	checkedOutBranch,
	checkoutState,
	// OTTR-987: the head the server's fast-forward would land; the merge hold audits it.
	integrationHead: integrationSha,
	serverMergePush,
	// OTTR-552 PR mode: the ship step pushes the card branch (server git credentials,
	// force-with-lease) and adopts or opens the PR via gh; the integrated proof is a
	// clean worktree with origin/<target> an ancestor of HEAD.
	pushBranch,
	// OTTR-1064: the rules-interview ship step builds the one-file commit on the card
	// branch itself (the agent was told to never commit on a PR-shipped project).
	commitFileOnBranch,
	openPr: openPullRequest,
	// OTTR-800: when a PR-mode card ends (PR merged, cancel), the server deletes the remote
	// card branch the ship step pushed; the target branch and a source-PR head are refused.
	deleteRemoteBranch,
	// OTTR-760: the ship step comments on a card's source PR ("@dependabot rebase", or the
	// fixes note) when the work cannot ride a push to the PR's head branch.
	prComment: commentOnPullRequest,
	// OTTR-781: the ship step fetches a legacy Dependabot card's source PR head to
	// adopt the PR instead of opening a duplicate one.
	fetchPrHead,
	prIntegrated,
	// OTTR-465: late-bound — app exists below the loop, like drained().
	pushAuthKind: (url) => app.pushAuthKind(url),
	githubAuthHint: (url) => app.githubAuthHint(url),
	fetchOriginBranch,
	rebaseTargetBranch: (mainPath, branch) =>
		rebaseTargetBranch(mainPath, branch, shared.commitIdentity),
	// OTTR-693: the commit identity every turn falls back to when its home names none.
	commitIdentity: () => shared.commitIdentity,
	// OTTR-876: the read-only GitHub token a turn may hold (docs/specs/turn-read-token.md);
	// late-bound like pushAuthKind above — app exists below the loop.
	turnReadToken: () => app.turnReadToken(),
	// OTTR-1259: the board's seen keys and baseline; the inbox sweep's filing
	// reads them per start so its candidates are exactly the unread Inbox
	// (late-bound like turnReadToken — app exists below the loop).
	...sweepSeenOps(() => app),
	// OTTR-882: the release identity (the configured GitHub app's contents-write token, else
	// the GH_TOKEN user token with a warning); late-bound like turnReadToken above.
	releaseIdentity: (owner, repo) => app.releaseIdentity(owner, repo),
	runMergeGates,
	mergeHoldMismatch,
	mergeHoldLanded,
	resetBranchTo,
	pidAlive,
	// OTTR_WORKER_URLS selects worker dispatch for work turns; unset (the default) and any
	// connect failure fall back to the local spawn. Merge turns never dispatch (D6).
	workerTarget,
	// OTTR-532: microVM projects' eligible turns, their token store and the worktree sync.
	vmTarget,
	// OTTR-1142: the settle of an accepted VM run probes the pool before its wake schedule.
	vmProbe: () => probeVmRunner(vmTarget),
	vmTokens,
	runTokens,
	syncWorktreeTo,
	// OTTR-1006: every dispatch carries the board's token store, so a classic run gets a
	// memory token bound to its own project's bank (docs/specs/hindsight-bank-binding.md).
	startRun: (o) => startRun({ ...o, memoryTokens: vmTokens }),
	// OTTR-454: the restart re-bind asks the workers for their detached runs and kills one on
	// cancel; with no workerTarget configured the loop never probes.
	detachedRuns: (url, token) => detachedRunsRequest(url, token),
	killDetached: (url, token, id) => killDetachedRequest(url, token, id),
	// R5-1: the list home is turnListHome() (OTTR_WORKERS_HOME ?? boardOmpHome()), never the
	// process homedir(): on compose that IS the shared home a worker turn can write, so a
	// merge turn must not read a worker-plantable apt.txt from there
	// (docs/specs/worker-list-isolation.md).
	ensurePackages: (project) => ensureProjectPackages(project, turnListHome()),
	turnEnv: async (project, model, opts) =>
		await turnEnv(
			project,
			model,
			envValuesByKind(
				shared.envValues,
				shared.envPlain,
				await listedEnvNames(workersHome),
			),
			{
				home: workersHome,
				// Hosted model access is API keys only: no provider OAuth token is lent to turns.
				lend: hosted === undefined,
				// A scout omits the Settings values (OTTR-1028); every other turn gets them.
				values: opts?.values,
			},
		),
	// Only the board's trusted home supplies lists. A root merge installs into its
	// provision home so the project uid never needs access to the private board home.
	prepareTurn: (project, destinationHome) =>
		prepareTurnPackages(project, turnListHome(), destinationHome),
	publishRelease,
	landPostReleaseCommand,
	runPostReleaseCommand,
	runReleaseCommand,
	archReviewDelta,
	hosted,
});
// Signals from here on sweep live runs; during boot loopRef stays undefined and
// shutdown only releases the stores opened so far.
loopRef = loop;

// OTTR-1261 stale-turn pass (docs/specs/stale-turn-recovery.md): the ops wiring
// below. A worker run probes and fixes on its worker host through the worker
// clients; a server-local run probes and fixes this host in-process. Local runs
// are the dev case, workers are the fleet case.

/** One live run for the stale pass: the supervisor ops run shape plus the
 * project/id it came from, so the server-local branch finds the card's store and
 * worktree. The extra fields ride along the ops contract — the pass passes the run
 * back opaquely — so they stay optional here. */
type StaleRunRef = {
	pid: number | null;
	url?: string;
	runId?: string;
	project?: string;
	id?: string;
};

/** The bounded transcript window the local probe parses: at most the last 64 KiB
 * of the newest session file, never the whole (untrusted) transcript. */
const STALE_TAIL_BYTES = 64 * 1024;

/** Last 64 KiB of a text file, or null when unreadable. */
function staleTail(path: string): string | null {
	try {
		const size = statSync(path).size;
		const fd = openSync(path, "r");
		try {
			const start = Math.max(0, size - STALE_TAIL_BYTES);
			const buf = Buffer.alloc(size - start);
			const read = readSync(fd, buf, 0, buf.length, start);
			return buf.subarray(0, read).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** The stale pass's read-only probe for one live run. A worker run (url + runId)
 * probes on its worker host; a server-local run probes this host from /proc and
 * the project store. Null: no usable probe — dead run pid, unreachable worker,
 * unknown run identity — and the pass reads null as "not a suspect, no action". */
async function probeStaleRun(
	projects: ReadonlyMap<string, Entry>,
	workers: WorkerTarget | null,
	run: StaleRunRef,
	sessionId: string | null,
): Promise<StaleProbe | null> {
	if (run.url !== undefined && run.runId !== undefined) {
		if (workers === null) return null;
		try {
			return await probeRunRequest(workers, run.url, run.runId, sessionId);
		} catch {
			// An unreachable worker is not a suspect: no action, no ask.
			return null;
		}
	}
	if (run.project === undefined || run.id === undefined || run.pid === null)
		return null;
	const e = projects.get(run.project);
	if (e === undefined) return null;
	const procs = readTree(run.pid);
	// A dead or unreadable run pid is not a suspect (OTTR-1216 owns the
	// no-process case).
	if (procs === null) return null;
	// OTTR-1261: select the run's own session file, never the project store's
	// newest one — another active card's session must not block this card's
	// detection or feed it a foreign diagnosis. The task row's live sessionId
	// (dispatchSessionEntry writes the run's own id mid-run) picks the file.
	const file = sessionFile(e.store.sessionsDir, sessionId);
	// No known session yet: never a suspect on a guessed file.
	if (file === null)
		return {
			pid: run.pid,
			alive: true,
			procs,
			sessionAt: null,
			lastTool: null,
			locks: [],
			pidFiles: [],
			pids: [],
			ports: [],
		};
	let sessionAt: number | null;
	try {
		sessionAt = statSync(file).mtimeMs;
	} catch {
		// An unreadable session file fails the session signal: no suspect.
		sessionAt = null;
	}
	const tail = staleTail(file);
	const lastTool = tail === null ? null : lastToolCall(tail);
	if (lastTool === null)
		return {
			pid: run.pid,
			alive: true,
			procs,
			sessionAt,
			lastTool: null,
			locks: [],
			pidFiles: [],
			pids: [],
			ports: [],
		};
	// The last tool command is untrusted text: it selects which facts to read,
	// never what to act on. Confinement is a fix-time decision, so the probe
	// reads facts anywhere on this host.
	const { command } = lastTool;
	return {
		pid: run.pid,
		alive: true,
		procs,
		sessionAt,
		lastTool,
		locks: lockFacts(extractLockPaths(command)),
		pidFiles: pidFileFacts(extractPidPaths(command)),
		pids: extractInlinePids(command).map(({ pid }) => ({
			pid,
			alive: pidAlive(pid),
		})),
		ports: extractPorts(command).map(({ port }) => ({
			port,
			listeners: portListeners(port),
		})),
	};
}

/** The stale pass's allowlisted fix for one live run, the act-time preconditions
 * re-checked on the host that owns the run. A worker run delegates to the worker's
 * /stalefix; a server-local run checks and acts here. A refused fix changes
 * nothing and carries the reason, so the re-filed ask carries facts. */
async function applyStaleFix(
	projects: ReadonlyMap<string, Entry>,
	workers: WorkerTarget | null,
	run: StaleRunRef,
	fix: StaleFix,
): Promise<{ ok: boolean; reason?: string }> {
	if (run.url !== undefined && run.runId !== undefined) {
		if (workers === null)
			return { ok: false, reason: "no worker fleet is configured" };
		// OTTR-1261: the expect payload rides to the worker so the act-time
		// recheck compares against the diagnosed facts, not a fresh guess.
		const req =
			fix.kind === "stale-lock"
				? {
						run: run.runId,
						action: "unlock" as const,
						path: fix.path,
						expect: fix.expect,
					}
				: fix.kind === "hung-child"
					? {
							run: run.runId,
							action: "kill" as const,
							pid: fix.pid,
							expect: fix.expect,
						}
					: null;
		if (req === null)
			return {
				ok: false,
				reason: fix.kind === "unsure" ? fix.reason : "unsupported fix kind",
			};
		try {
			// An unusable body is a refusal too: the ask carries facts, not a crash.
			return (
				(await staleFixRequest(workers, run.url, req)) ?? {
					ok: false,
					reason: "worker sent no usable answer",
				}
			);
		} catch (err) {
			return { ok: false, reason: errmsg(err) };
		}
	}
	if (run.project === undefined || run.id === undefined || run.pid === null)
		return { ok: false, reason: "the run is no longer live" };
	const e = projects.get(run.project);
	if (e === undefined)
		return { ok: false, reason: "the run is no longer live" };
	if (fix.kind === "unsure") return { ok: false, reason: fix.reason };
	const task = await e.store.getTask(run.id);
	if (task === null) return { ok: false, reason: "the card row is gone" };
	// The act-time recheck reads the run's own session, the same session
	// identity the probe used: the task row's live sessionId (OTTR-1261).
	const file = sessionFile(e.store.sessionsDir, task.sessionId);
	const tail = file === null ? null : staleTail(file);
	const currentLastTool = tail === null ? null : lastToolCall(tail);
	if (fix.kind === "stale-lock")
		// staleUnlockLocal owns the whole precondition set at act time:
		// realpath confinement, file content, dead pid, and the "turn still
		// waits on this lock" recheck against currentLastTool.
		return staleUnlockLocal(
			task.worktree ?? e.path,
			fix.path,
			fix.expect,
			currentLastTool,
		);
	// Hung child: staleKillLocal revalidates descendant/cmdline/ticks/dependency
	// on a fresh /proc walk before a signal flies; the run's own pid is never a
	// target.
	return staleKillLocal(run.pid, fix.pid, fix.expect, { currentLastTool });
}

// Supervisor: retries locked-worktree removal after done/cancel and watches CI for merge pushes.
// Created before createApp: the hosted GitHub-event route kicks its tick through the bound
// ciWatchTick dep (docs/specs/hosted-mode.md section 8).
const supervisor = createSupervisor(
	projects,
	{
		appendLog,
		schedule: loop.schedule,
		now: Date.now,
		sweepWorker: (url, token) =>
			sweepWorkerRequest({ urls: [url], token }, url),
		removeWorktree,
		unsavedWork,
		statusRows,
		statusFiles,
		gh: runGh,
		commitsAhead,
		isClean,
		isIntegrated,
		worktreeHusk,
		worktreeLinked,
		branchMergedOrGone,
		quarantineUntracked,
		targetCommits,
		targetSha,
		fetchOriginBranch,
		fetchPrHead,
		deleteRemoteBranch,
		// OTTR-1261: the stale pass's liveness check, probe and allowlisted fix.
		liveRun: (project, id) => {
			// The unsuffixed key only: the `:check`/`:workcheck` entries are not
			// the turn the stale pass probes.
			const entry = loop.running.get(`${project}/${id}`);
			if (entry === undefined) return null;
			const run: StaleRunRef = {
				pid: entry.pid,
				...(entry.url !== undefined && { url: entry.url }),
				...(entry.runId !== undefined && { runId: entry.runId }),
				project,
				id,
			};
			return run;
		},
		// The probe fixes the session by run identity — the task row's live
		// sessionId — before the pass reads idle facts from it (OTTR-1261).
		probeStale: (run, sessionId) =>
			probeStaleRun(projects, workerTarget, run, sessionId),
		staleFix: (run, fix) => applyStaleFix(projects, workerTarget, run, fix),
	},
	workerTarget,
);

// OTTR-904: the old gate parks replay once per boot stamp, so the cards the
// old rule parked get the new park rule (defaults ride, only null defaults
// block) on their next turn start. No schedule here: loop.schedule publishes
// through the app, so calling it during module init reads `app` before its
// initialization and crashes the boot (OTTR-904 screenshot run). The
// loop.schedule() after loop.recoverRestarted() below starts the re-queued
// cards. The boot loop above opened every project store, so the pass scans
// each project's parked cards (OTTR-920).
await replayGateParks(projects.values(), {
	kvGet: (key) => gstore.get(key),
	kvSet: (key, value) => gstore.set(key, value),
	log: (line) => console.log(`prompt gate replay: ${line}`),
});

/** Every pid a live turn claim or a store's runningPids() row holds; orphan checks subtract these. */
async function claimedPids(): Promise<Set<number>> {
	const claimed = new Set<number>();
	for (const handle of loop.running.values())
		if (handle.pid !== null) claimed.add(handle.pid);
	for (const e of projects.values())
		for (const pid of await e.store.runningPids()) claimed.add(pid);
	return claimed;
}
// Settings -> omp usage -> Launch omp stats dashboard (docs/specs/omp-stats-dashboard.md):
// omp's own `omp stats` web UI, started on demand and served behind the board's walls on a
// second port. Its transcript mirror reads the same stores as the omp usage card.
// Hosted mode has no proxy: its wall admits only signed control-plane identities, and a
// second loopback port would bypass it (docs/specs/hosted-mode.md §3).
const ompStatsInfo =
	hosted === undefined
		? parseOmpStatsPort(process.env.OTTR_OMP_STATS_PORT)
		: { port: null, error: "not available in hosted mode" };
if (ompStatsInfo.error !== null)
	console.log(`omp stats dashboard proxy: ${ompStatsInfo.error}`);
const ompStatsDashboard = createOmpStatsDashboard({
	baseDir: join(boardOmpHome(), ".omp", "ottr-stats-dashboard"),
	sources: () => ompSessionStores(projects),
	env: () => boardOmpEnv(),
	log: (l) => console.log(`omp stats dashboard: ${l}`),
});
// The child must not outlive the board. SIGINT/SIGTERM/SIGHUP end in shutdown() ->
// process.exit, which runs this handler too.
process.on("exit", () => ompStatsDashboard.stop());
every(() => ompStatsDashboard.tick(), 60_000);
// OTTR-1071: the PR poll grid for the Settings watches row; the hourly wiring
// below moves it forward each regular poll. The boot poll is irregular, so the
// grid starts one hour out.
const prPollGrid = { nextAt: Date.now() + 3_600_000 };
// OTTR-1087: the code-scanning poll grid for the Settings watches row; the
// hourly wiring below moves it forward each regular poll, like the PR grid.
const codeScanPollGrid = { nextAt: Date.now() + 3_600_000 };
const app = await createApp({
	gstore,
	defaultDir: resolve(ROOTS[0] ?? resolve(import.meta.dir, "..", "..")),
	// Server-only ssh keys and known_hosts: a data dir outside every
	// checkout, which no worker mounts (compose: OTTR_SSH_DIR on the ottr-state volume).
	sshDir: defaultSshDir(),
	// Base home whose .ottr/workers folders hold the env.txt name lists (Settings -> Env);
	// unset: the board's server-only home, as for turnEnv (R5-1). The same home the turns
	// read, so both see one list.
	workersHome,
	projects,
	cancel: loop.cancel,
	// OTTR-1047: the manual start is strict — it files for the named review only.
	validateLeads: (e, reviewId, strictReview, again, first, park) =>
		loop.filePendingValidationRun(
			e,
			reviewId,
			strictReview ?? true,
			again,
			first,
			park,
		),
	// OTTR-1259: the inbox sweep's start files through the same loop seam.
	sweepInbox: (e) => loop.filePendingSweepRun(e),
	stopTurn: loop.stopTurn,
	// OTTR-1261: the reply route's stale-ask responder intercepts only while the
	// card's unsuffixed turn entry is live.
	turnLive: (project, id) => loop.running.has(`${project}/${id}`),
	creditStop: loop.creditStop,
	creditHoldActive: loop.creditHoldActive,
	creditRelease: loop.creditRelease,
	ciWatchTick: (opts) => supervisor.tick(opts),
	finishKept: loop.finishKept,
	// OTTR-454: the runners GET /api/drain lists (worker hostnames, then local) and the
	// live per-runner counts from the turn loop.
	runners: [
		...(workerTarget?.urls ?? []).map((u) => ({
			id: new URL(u).hostname,
			url: u,
		})),
		// OTTR-532: the update script holds, waits for and rolls vm-runner like a worker.
		...(vmTarget?.urls ?? []).map((u) => ({
			id: new URL(u).hostname,
			url: u,
		})),
		{ id: "local", url: null },
	],
	// OTTR-548: the /signins tick probes the same urls the loop dispatches work turns to.
	workerTarget,
	// OTTR-1151: the /system view polls the vm-runner's /stats like a worker's and shows
	// the VM fleet on that row.
	vmTarget,
	runnerTurns: () => loop.runnerTurns(),
	// OTTR-1143: the state frame's slotsUsed is the loop's own live slot count — the exact
	// number the claim gate caps. The demo board runs no agents (the loop sets stay empty)
	// while its seeded pool shows running/preparing cards, so there the frame carries the
	// seeded count, like demoProgress does for progress lines.
	slotsUsed:
		demoData !== null
			? () => demoData.demoSlotsUsed(projects)
			: () => loop.slotsUsed(),
	// OTTR-1071: the Settings watches row shows when the next regular PR poll runs.
	prPollNextAt: () => prPollGrid.nextAt,
	// OTTR-1087: the same for the code-scanning watch's next regular poll.
	codeScanPollNextAt: () => codeScanPollGrid.nextAt,
	// OTTR-763: the checkout guard's ambiguous-change notices for the bell.
	checkoutNotices: () => loop.checkoutNotices(),
	// OTTR-1215: the /dev/null guard's repair notices for the bell.
	devNullNotices: () => devNullGuard.notices(),
	// The /system view's live runs: the loop keys entries `${project}/${id}`; split at the first "/".
	liveRuns: () =>
		[...loop.running].map(([key, e]) => {
			const slash = key.indexOf("/");
			return {
				project: key.slice(0, slash),
				id: key.slice(slash + 1),
				runner: e.url ? new URL(e.url).hostname : "server",
				progress: e.progress ?? null,
				runId: e.runId ?? null,
			};
		}),
	claimedPids,
	progressOf: (project, id) => {
		const entry = loop.running.get(`${project}/${id}`);
		const text =
			entry?.progress ?? demoProgress?.get(`${project}/${id}`) ?? null;
		if (text === null) return null;
		// The demo board's fabricated line never moves, so it carries no at: its card keeps
		// the log-only warning rule (silentSince treats a missing at as no activity).
		return entry?.progressAt !== undefined
			? { text, at: entry.progressAt }
			: { text };
	},
	schedule: loop.schedule,
	serverVersion,
	port: PORT,
	publicHosts: PUBLIC_HOSTS,
	shared,
	serverRef,
	prod: PROD,
	board,
	vmTokens,
	runTokens,
	llmGateway: () => llmGateway,
	hosted,
	// No live secret source is approved. Keep internal bindings empty and server-only.
	serviceQuotas:
		hosted === undefined
			? {
					sources: [],
					registry: new Map(),
					resolveCredential: () => undefined,
				}
			: undefined,
	secretBox,
	ompStats: { info: ompStatsInfo, dashboard: ompStatsDashboard },
});
appRef = app;
// OTTR-1088: warm the transcript usage scan once at boot, so the first Settings
// visit answers from the report cache or the single-flight build, never a cold walk.
app.ompStatsWarm();

// Boot recovery is the loop's job now: a restart resurfaces running/preparing
// turns through one code path, so a cancelled card can never be requeued twice.
await loop.recoverRestarted();
await loop.schedule();
every(() => loop.scheduleTick(), 5000);

every(() => supervisor.tick(), 60_000);

// OTTR-1139: the catch-up sweep files the batch validation a done review still
// waits for when its settle event never fired. Same 60 s cadence as the
// supervisor tick; the filing rules live in the loop's filePendingValidationRun.
every(() => loop.validationSweep(), 60_000);

// U9: when the alate server holds an unprovisioned import and no turn runs, run the same
// provision path as Settings → Alate → Provision; a failed attempt waits an hour.
every(() => app.alateProvisionTick(), 5 * 60_000);

// Idle auto-start (docs/specs/mutation-delta.md §7): with the setting on, a board quiet for
// two hours files the first due project's architecture-review card by itself.
every(() => app.idleReviewTick(), 5 * 60_000);

// Weekly GitHub trending scan (Monday 06:00 server time): the boot call lets a board that
// was down at the slot catch up; the 5-min tick finds the slot.
runWork(() => app.trendingTick());
every(() => app.trendingTick(), 5 * 60_000);

// Memory health: boot + interval, never per turn (docs/specs/memory-backend.md).
every(() => app.memoryHealthTick(), 60_000);

// OTTR-548: worker sign-in self-reports, 60 s tick (the boot call is createApp's, like memory
// health); the state warnings read only the tick's cache — advisory, fail-soft.
every(() => app.workerSignInTick(), 60_000);

// 1 s diff tick: catches file-driven changes no code path writes (omp session titles, AGENTS.md
// appearing, main-checkout dirtiness). ponytail: replace with fs watchers if the state build ever
// shows in profiles. Every 5th tick a bare liveness ping.
let stateTick = 0;
every(async () => {
	if (++stateTick % 5 === 0) app.publish({ type: "ping" });

	// OTTR-866: the build is async and single-flight; a failed build logs inside it.
	await app.publishState();
}, 1000);

// Backups (docs/specs/db-backup.md): daily snapshot of tracker.db and each tasks.db, hourly
// check; the boot call lets a board that was down catch up.
if (DATABASE.backend === "postgres") {
	console.log(POSTGRES_BACKUP_NOTICE);
} else {
	const backup = resolveBackup(process.env, STATE_DIR, workerRoots);
	for (const text of backup.errors) console.error(`backup: ${text}`);
	if (backup.keep !== 0) {
		const backupNow = async (): Promise<void> => {
			if (shuttingDown) return;
			if (backupWork !== undefined) return backupWork;
			backupWork = backupTick({
				dir: backup.dir,
				keep: backup.keep,
				now: new Date(),
				refuseBelow: backup.refuseBelow,
				// A project that opened later is a live source, not a failure.
				sources: () =>
					backupSources(
						gstore,
						[...projects.values()].map((e) => e.store),
						unopenedProjects.filter((u) => !projects.has(u.name)),
					),
				log: (line) => console.log(line),
			});
			try {
				await backupWork;
			} finally {
				backupWork = undefined;
			}
		};
		await backupNow();
		every(backupNow, 3_600_000);
	}
}

// Service due checks never wait for statistics or model quota work.
app.checkServiceQuotas();
every(() => app.checkServiceQuotas(), 30_000);
// System sampler, one for all tabs (and for /api/system in polling mode): container and VM
// readings, self-update checks and the usage quota live behind sampleStats() in the request layer.
runWork(() => app.sampleStats());
every(() => app.sampleStats(), 30_000);

// Upstream updates: one pull at boot, then hourly.
runWork(() => app.refreshUpdates());
every(() => app.refreshUpdates(), 3_600_000);

// Fork research: hourly poll; change-triggered analysis inside the watcher.
runWork(() => app.forkResearchTick());
every(() => app.forkResearchTick(), 3_600_000);

// PR reviews: hourly poll; the watcher gates which open PRs start a review turn.
// OTTR-1071: the quiet-time timer starts a review between polls, and the grid
// feeds the state payload's nextPollAt for the Settings watches row.
runWork(() => app.prReviewTick());
every(() => {
	prPollGrid.nextAt = Date.now() + 3_600_000;
	// Returned, not voided: runWork's chain awaits and logs the tick's rejections.
	return app.prReviewTick();
}, 3_600_000);

// Issue watch: hourly poll; files new open GitHub issues as backlog cards, capped per day.
runWork(() => app.issueWatchTick());
every(() => app.issueWatchTick(), 3_600_000);

// Code scanning watch: hourly poll; files GitHub code scanning alerts as backlog cards.
// OTTR-1087: the grid feeds the state payload's nextPollAt for the Settings watches row.
runWork(() => app.codeScanWatchTick());
every(() => {
	codeScanPollGrid.nextAt = Date.now() + 3_600_000;
	// Returned, not voided: runWork's chain awaits and logs the tick's rejections.
	return app.codeScanWatchTick();
}, 3_600_000);

// omp watch: hourly npm poll; a model reviews each new omp release, files fail and bump cards.
runWork(() => app.ompWatchTick());
every(() => app.ompWatchTick(), 3_600_000);

// Dependabot alerts: boot + hourly probe per project with the warning on; the project
// page warns when the repo has them off (docs/specs/dependabot-warning.md).
runWork(() => app.dependabotTick());
every(() => app.dependabotTick(), 3_600_000);

// Token expiry: probe at boot and once a day; advisory warnings and reminder pushes inside.
runWork(() => app.tokenReminderTick());
every(() => app.tokenReminderTick(), 86_400_000);

// OTTR-1211: /tmp age sweep. The server's /tmp has no cap, so the workers' 24h rule
// (src/tmpsweep.ts) bounds it here too, at boot and hourly: a top-level entry goes
// when its newest inner mtime is a day old, no live process holds it (cwd, open fd,
// argv, exe), and no live local run started at or before that mtime — a run's own
// scratch (its per-run TMPDIR) survives a turn that outlasts a day. Worker-dispatched
// and microVM runs hold no scratch on this host: their handles are excluded.
const sweepServerTmp = (): void => {
	const starts = [...(loopRef?.running.values() ?? [])]
		.filter(
			(e) =>
				e.url === undefined &&
				e.pid !== null &&
				typeof e.startedAt === "number",
		)
		.map((e) => e.startedAt as number);
	sweepTmpDirsLogged(tmpdir(), { liveTurnStarts: starts });
};
runWork(() => sweepServerTmp());
every(() => sweepServerTmp(), 3_600_000);

// OTTR-1211: the daily cache sweep over the server's own per-project turn caches
// (a worker-less server runs its turns here): TTL and cap per root, oldest first,
// live holds kept. The hourly /tmp net above stays the safety net.
const sweepServerCaches = (): void => {
	sweepCacheRootsLog(projectCacheRoots(serverTurnCacheRoot()));
};
runWork(() => sweepServerCaches());
every(() => sweepServerCaches(), CACHE_SWEEP_INTERVAL_MS);

// No bind retry: nothing in the repo restarts this process on the same port, so a
// bind failure surfaces as the thrown error from Bun.serve.
serverRef.current = Bun.serve({
	hostname: HOST,
	port: PORT,
	// Only an explicit NODE_ENV=development runs Bun's HTML dev server: it 403s every
	// Host header except loopback, which breaks tailscale serve + OMP_TRACKER_PUBLIC_HOSTS.
	development: process.env.NODE_ENV === "development",
	...app.serveOptions,
});

// The omp stats dashboard proxy: a bind failure leaves the board up, and the info endpoint
// carries the error instead of the port.
if (ompStatsInfo.port !== null) {
	try {
		statsServer = Bun.serve({
			hostname: HOST,
			port: ompStatsInfo.port,
			idleTimeout: 120,
			fetch: app.ompStatsFetch,
		});
		console.log(
			`omp stats dashboard proxy on http://127.0.0.1:${ompStatsInfo.port}`,
		);
	} catch (err) {
		const error = `omp stats dashboard proxy did not bind port ${ompStatsInfo.port}: ${err instanceof Error ? err.message : String(err)}`;
		console.error(error);
		app.setOmpStatsListener({ port: null, error });
	}
}

// Advisory boot report: agent-launcher processes no running turn claims. The tracker never
// kills them; the operator decides (also on demand via GET /api/orphans and /api/state).
try {
	const claimed = await claimedPids();
	const orphans = orphanPids(
		platform.listProcesses(),
		claimed,
		process.pid,
		Date.now(),
	);
	if (orphans.length === 0) console.log("orphans: none");
	else
		for (const o of orphans)
			console.log(
				`orphan pid ${o.pid} started ${o.started ? new Date(o.started).toISOString() : "unknown"}: ${o.cmd.slice(0, 200)}`,
			);
} catch (err) {
	// Advisory scan failed: observable, never treated as "no orphans".
	console.error(
		"orphans: scan failed:",
		err instanceof Error ? err.message : err,
	);
}

// ponytail: the bundled dashboard port is fixed in docker-compose.yml; external
// Alate deployments use their own dashboard URL. Compose passes its profile list.
const alateEnabled = (process.env.COMPOSE_PROFILES ?? "")
	.split(",")
	.some((profile) => ["alate", "*"].includes(profile.trim()));
const startupRows = [
	"Ottr | Startup access",
	"",
	`Ottr on http://127.0.0.1:${serverRef.current.port}`,
	`Alate   ${alateEnabled ? "http://127.0.0.1:4570" : "off"}`,
];
const startupWidth = Math.max(...startupRows.map((row) => row.length));
const startupBorder = `+${"-".repeat(startupWidth + 2)}+`;
console.log(
	[
		"",
		startupBorder,
		...startupRows.map((row) => `| ${row.padEnd(startupWidth)} |`),
		startupBorder,
		HOSTED === null
			? "Ottr login: first visit, complete Create admin; later, use that admin name and password."
			: "Ottr login: use your hosting provider's authenticated URL.",
		...(alateEnabled
			? [
					HOSTED === null
						? "Alate login: use ALATE_API_KEY from your Compose .env file; no username is required."
						: "Alate login: use the key provided by your hosting administrator.",
				]
			: []),
		"After detached startup (-d): docker compose logs --tail 30 server",
	].join("\n"),
);
