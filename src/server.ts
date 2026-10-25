// Ottr: HTTP API + board + per-project turn scheduling.
// Startup and wiring only: routes live in createApp() (src/app.ts), the turn
// engine lives in createTurnLoop() (src/turn.ts). This file binds them.

import { constants } from "node:os";
import { delimiter, resolve } from "node:path";
import type { Server } from "bun";
import { createApp, storedProjectPaths } from "./app.ts";
import { ensureProjectPackages } from "./apt.ts";
import { newSecret } from "./auth.ts";
import { logError, trapCrashes } from "./crash.ts";
import { pidAlive, StoreLockedError } from "./dblock.ts";
import { defaultSshDir } from "./gitHosts.ts";
import { GlobalStore } from "./globalStore.ts";
import { orphanPids } from "./orphans.ts";
import { platform } from "./platform/index.ts";
import {
	highestTag,
	latestImage,
	ownerRepo,
	publishRelease,
	runGh,
	runReleaseCommand,
} from "./release.ts";
import { publicHosts } from "./requestGuards.ts";
import { startRun, workerFromEnv } from "./runner.ts";
import { lastReviewBase, reviewBlocked } from "./scheduler.ts";
import {
	type AdoptResult,
	adoptSharedProjectData,
	discoverProjects,
	ProjectStore,
} from "./store.ts";
import { createSupervisor } from "./supervisor.ts";
import {
	appendLog,
	createTurnLoop,
	type TurnProject as Entry,
	getSettingsLogged,
	parseReleaseVersion,
	type TurnLoop,
} from "./turn.ts";
import type { LatestImage } from "./types.ts";
import {
	archReviewDelta,
	archReviewDue,
	branchMergedOrGone,
	changedFiles,
	commitsAhead,
	createWorktree,
	diffStat,
	diffText,
	git,
	githubUrl,
	hasRules,
	headVersion,
	ignoreInMain,
	isClean,
	isGitRepoWithCommit,
	isIntegrated,
	quarantineUntracked,
	remoteUrl,
	removeWorktree,
	resolveTarget,
	serverMergePush,
	statusFiles,
	statusRows,
	targetCommits,
	trackedFiles,
	unsavedWork,
	worktreeHusk,
	worktreeLinked,
} from "./worktree.ts";

const PORT = Number(process.env.PORT ?? 4747);
/** Bind address; set OMP_TRACKER_HOST (e.g. 0.0.0.0) to serve beyond loopback. */
const HOST = process.env.OMP_TRACKER_HOST ?? "127.0.0.1";
/** Parsed once at startup: env is static for the life of the process. */
const PUBLIC_HOSTS = publicHosts();
/** Production mode: the board is static (no WebSocket); UI bundles/minifies via Bun. */
const PROD = process.env.NODE_ENV === "production";
const EXTENSION = resolve(import.meta.dir, "..", "extension", "tracker.ts");
const ROOTS = process.env.OMP_TRACKER_ROOTS
	? process.env.OMP_TRACKER_ROOTS.split(delimiter)
			.map((s) => s.trim())
			.filter(Boolean)
	: [resolve(import.meta.dir, "..", "..")];
// Scratch tests and dev boards set OTTR_STATE_DIR so the global kv store never
// opens (and locks) the checkout's own tracker.db.
const STATE_DIR = process.env.OTTR_STATE_DIR ?? resolve(import.meta.dir, "..");
const gstore = GlobalStore.open(STATE_DIR);

// Mutable settings shared with createApp: /api/settings writes them, the scheduler and
// discovery read them. The persisted project lists load here, before boot discovery: a
// removed project must stay off the board after a restart.
const shared: {
	maxTotalRuns: number | null;
	/** True when a review's findings are checked by a second model before they become cards. */
	reviewCheck: boolean;
	/** True when a finished work card is checked by a second model before it enters the merge queue. */
	workCheck: boolean;
	removedPaths: string[]; // projects removed from the board; discovery must not re-find them
	projectPaths: string[]; // explicitly added projects; discovery finds these even outside the roots
} = {
	// "none" starts the board with no global cap, like the Settings choice.
	maxTotalRuns:
		process.env.OMP_TRACKER_MAX_TOTAL === "none"
			? null
			: Number(process.env.OMP_TRACKER_MAX_TOTAL ?? 3),
	reviewCheck: true,
	workCheck: true,
	...storedProjectPaths(gstore),
};

const projects = new Map<string, Entry>();
/** Set once createTurnLoop returns; a signal during boot finds no live turns and skips the kill sweep. */
let loopRef: TurnLoop | undefined;
/** Normal-exit path: best-effort cancel of live turns, then release every instance lock. */
function shutdown(exitCode: number): never {
	for (const h of loopRef?.running.values() ?? [])
		if (h.pid !== null) platform.killTree(h.pid);
	for (const e of projects.values()) {
		try {
			e.store.close();
		} catch {
			// a project that will not close must not block the others' release
		}
	}
	gstore.close();
	process.exit(exitCode);
}
// omp must not outlive the tracker: when the server goes down, the turns it
// was running go with it (and store closes drop the databases' exclusive lock).
process.on("exit", () => {
	for (const h of loopRef?.running.values() ?? [])
		if (h.pid !== null) platform.killTree(h.pid);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => shutdown(128 + constants.signals[signal]));
}
// A bug in a timer tick or a fire-and-forget must log and keep the board up, not kill the server:
// every loop here re-runs on its own schedule, so the failing tick heals itself on the next pass.
trapCrashes();

// Image chips re-probe ghcr.io at most this often; an image published without a matching tag
// waits out the TTL.
const IMAGE_TTL = 15 * 60_000;
const imageChips = new Map<string, { at: number; value: LatestImage | null }>();

/** ghcr.io probe piggybacking on the release refresh: writes e.latestImage, one probe per TTL per repo. */
function refreshImage(e: Entry): void {
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
			e.latestImage = value;
		})
		.catch(() => {}); // ghcr unreachable: keep the null seed until the next TTL
}

/** Highest vX.Y.Z tag merged into the target; null when the target is unknown or the git spawn fails. */
async function refreshRelease(e: Entry): Promise<void> {
	if (e.target === null) {
		e.latestRelease = null;
		return;
	}
	const r = await git(
		["tag", "--list", "v*", "--merged", e.target],
		e.path,
	).catch(() => null);
	e.latestRelease = r?.code === 0 ? highestTag(r.stdout.split("\n")) : null;
	refreshImage(e);
}

/** Commits since the last review on the target; null with no target or when git fails, like latestRelease. */
async function refreshArchReview(e: Entry): Promise<void> {
	if (e.target === null) {
		e.archReview = null;
		return;
	}
	const a = await archReviewDelta(
		e.path,
		e.target,
		lastReviewBase(e.store.listTasks()),
	).catch(() => null);
	const cap = getSettingsLogged(e).archReviewCap;
	// Running: a review is queued or running, or its findings are still landing.
	const running = reviewBlocked(e.store.listTasks()) !== null;
	e.archReview =
		a === null
			? null
			: {
					delta: a.delta,
					reviewed: a.reviewed,
					cap,
					due: archReviewDue(a.delta, cap, a.reviewed),
					running,
				};
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

/** Shipped on every /api/state; stale tabs compare it against the first version they saw and reload once. */
const serverVersion = await headVersion(SELF_ROOT);

if (process.env.OTTR_DATA_DIR && process.env.OTTR_SERVER_DATA_DIR) {
	let adopted: AdoptResult[] = [];
	try {
		adopted = adoptSharedProjectData(
			process.env.OTTR_DATA_DIR,
			process.env.OTTR_SERVER_DATA_DIR,
		);
	} catch (err) {
		// Same as the open loop below: a live board holding an old DB must stop this boot.
		if (err instanceof StoreLockedError) {
			logError("refusing to start", err);
			process.exit(1);
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
} else if (process.env.OTTR_DATA_DIR) {
	console.warn(
		"OTTR_SERVER_DATA_DIR is not set: project databases stay on the worker-shared data dir (OTTR_DATA_DIR)",
	);
}

for (const p of discoverProjects(
	ROOTS,
	shared.projectPaths,
	shared.removedPaths,
)) {
	let store: ProjectStore;
	try {
		store = ProjectStore.open(p);
	} catch (err) {
		if (err instanceof StoreLockedError) {
			// A second server must die naming the holder, not limp along project-less
			// (three servers sharing one db was the 2026-10-06 incident). Exit directly:
			// trapCrashes' net would swallow a throw here and keep a project-less board up.
			logError("refusing to start", err);
			process.exit(1);
		}
		// One unreadable project database must not keep the whole board from booting.
		console.error(`skipping project ${p}:`, err);
		continue;
	}
	const e: Entry = {
		store,
		name: store.name,
		path: p,
		target: null,
		gitless: !(await isGitRepoWithCommit(p)),
		github: null,
		remote: null,
		dirty: false,
		latestRelease: null,
		latestImage: null,
		archReview: null,
	};
	projects.set(store.name, e);

	resolveTarget(p)
		.then((r) => {
			e.target = r.target;
		})
		.catch(() => {});
	githubUrl(p)
		.then((u) => {
			e.github = u;
		})
		.catch(() => {});
	remoteUrl(p)
		.then((u) => {
			e.remote = u;
		})
		.catch(() => {});
	// Stamp versions for tasks merged before the tracker kept them on the row (one scan per
	// boot); the same pass re-checks stamped non-release cards, because only a real tag
	// anchors a release pill — prose that merely names a version must not keep one. A version
	// a release card already owns is claimed twice: the prose stamp loses.
	const releaseOwned = new Set<string>();
	for (const t of store.listTasks())
		if (t.base !== null && t.releaseVersion !== null)
			releaseOwned.add(t.releaseVersion);
	for (const t of store.listTasks()) {
		if (t.stage !== "done" || t.base !== null || t.cancelledAt !== null)
			continue;
		const last = store.listTurns(t.id).at(-1);
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
		if (anchored && !releaseOwned.has(version)) {
			if (t.releaseVersion === null)
				store.updateTask(t.id, { releaseVersion: version });
		} else if (t.releaseVersion !== null) {
			// ponytail: an old merge-cut stamp whose tag exists but predates release cards cannot
			// be told apart from a kept release — it stays anchored and keeps its pill.
			store.updateTask(t.id, { releaseVersion: null });
		}
	}
}

// Task sessions' create_task tool talks to the tracker over loopback; an operator-provided
// OTTR_BOARD_URL (compose worker -> server address) wins. Off loopback the board files a card
// only with this token, new on every boot, which the runner hands each task session.
const board = {
	url: process.env.OTTR_BOARD_URL ?? `http://127.0.0.1:${PORT}`,
	token: newSecret(),
};

// The loop owns the engine; the request layer calls back into it through deps.schedule, and
// the loop's publish/log plumbing is late-bound to createApp's handles (both exist by boot).
const loop = createTurnLoop(projects, {
	extensionPath: EXTENSION,
	board,
	maxTotalRuns: () => shared.maxTotalRuns,
	reviewCheck: () => shared.reviewCheck,
	workCheck: () => shared.workCheck,
	drained: () => app.drained(),
	publishSoon: () => app.publishSoon(),
	notifyLog: (project, id) => app.notifyLog(project, id),
	refreshRelease,
	refreshArchReview,
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
	trackedFiles,
	worktreeHusk,
	worktreeLinked,
	ignoreInMain,
	branchMergedOrGone,
	hasRules,
	targetCommits,
	targetSha,
	serverMergePush,
	pidAlive,
	// OTTR_WORKER_URLS selects worker dispatch for work turns; unset (the default) and any
	// connect failure fall back to the local spawn. Merge turns never dispatch (D6).
	workerTarget: workerFromEnv(),
	startRun,
	ensurePackages: ensureProjectPackages,
	publishRelease,
	runReleaseCommand,
	archReviewDelta,
});
// Signals from here on sweep live runs; during boot loopRef stays undefined and
// shutdown only releases the stores opened so far.
loopRef = loop;

/** Every pid a live turn claim or a store's runningPids() row holds; orphan checks subtract these. */
function claimedPids(): Set<number> {
	const claimed = new Set<number>();
	for (const handle of loop.running.values())
		if (handle.pid !== null) claimed.add(handle.pid);
	for (const e of projects.values())
		for (const pid of e.store.runningPids()) claimed.add(pid);
	return claimed;
}
const serverRef: { current: Server<undefined> | undefined } = {
	current: undefined,
};
const app = createApp({
	gstore,
	defaultDir: resolve(ROOTS[0] ?? resolve(import.meta.dir, "..", "..")),
	// Server-only ssh keys and known_hosts: a data dir outside every
	// checkout, which no worker mounts (compose: OTTR_SSH_DIR on the ottr-state volume).
	sshDir: defaultSshDir(),
	projects,
	cancel: loop.cancel,
	stopTurn: loop.stopTurn,
	finishKept: loop.finishKept,
	claimedPids,
	progressOf: (project, id) =>
		loop.running.get(`${project}/${id}`)?.progress ?? null,
	schedule: loop.schedule,
	serverVersion,
	port: PORT,
	publicHosts: PUBLIC_HOSTS,
	shared,
	serverRef,
	prod: PROD,
	board,
});

// Boot recovery is the loop's job now: a restart resurfaces running/preparing
// turns through one code path, so a cancelled card can never be requeued twice.
await loop.recoverRestarted();
loop.schedule();
setInterval(loop.schedule, 5000);

// Supervisor: retries locked-worktree removal after done/cancel and watches CI for merge pushes.
const supervisor = createSupervisor(projects, {
	appendLog,
	schedule: loop.schedule,
	now: Date.now,
	removeWorktree,
	unsavedWork,
	statusRows,
	gh: runGh,
	commitsAhead,
	isClean,
	isIntegrated,
	worktreeHusk,
	worktreeLinked,
	branchMergedOrGone,
	quarantineUntracked,
	targetCommits,
});
setInterval(() => void supervisor.tick(), 60_000);

// U9: when the alate server holds an unprovisioned import and no turn runs, run the same
// provision path as Settings → Alate → Provision now; a failed attempt waits an hour.
setInterval(() => void app.alateProvisionTick(), 5 * 60_000);

// 1 s diff tick: catches file-driven changes no code path writes (omp session titles, AGENTS.md
// appearing, main-checkout dirtiness). ponytail: replace with fs watchers if the state build ever
// shows in profiles. Every 5th tick a bare liveness ping.
let stateTick = 0;
setInterval(() => {
	if (app.socketCount() === 0) return;
	if (++stateTick % 5 === 0) app.publish({ type: "ping" });
	app.publishState();
}, 1000);

// Stats sampler, one for all tabs (and for /api/stats in polling mode): stats, self-update
// checks and the usage quota live behind sampleStats() in the request layer.
void app.sampleStats();
setInterval(() => void app.sampleStats(), 30_000);

// Upstream updates: one pull at boot, then hourly.
void app.refreshUpdates();
setInterval(() => void app.refreshUpdates(), 3_600_000);

// Fork research: hourly poll; change-triggered analysis inside the watcher.
void app.forkResearchTick();
setInterval(() => void app.forkResearchTick(), 3_600_000);

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

// Advisory boot report: agent-launcher processes no running turn claims. The tracker never
// kills them; the operator decides (also on demand via GET /api/orphans and /api/state).
try {
	const claimed = claimedPids();
	const orphans = orphanPids(platform.listProcesses(), claimed, process.pid);
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

console.log(`Ottr on http://127.0.0.1:${PORT}`);
