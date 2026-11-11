// Ottr: HTTP API + board + per-project turn scheduling.
// Startup and wiring only: routes live in createApp() (src/app.ts), the turn
// engine lives in createTurnLoop() (src/turn.ts). This file binds them.

import { constants, homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp, ompSessionStores, storedProjectPaths } from "./app.ts";
import { ensureProjectPackages } from "./apt.ts";
import { newSecret } from "./auth.ts";
import { backupSources, backupTick, resolveBackup } from "./backup.ts";
import { logError, trapCrashes } from "./crash.ts";
import { pidAlive, StoreLockedError } from "./dblock.ts";
import { errmsg } from "./errmsg.ts";
import { defaultSshDir } from "./gitHosts.ts";
import { syncWorktreeTo } from "./gitHttp.ts";
import { githubHost } from "./githubHost.ts";
import type { CommitIdentity } from "./gitIdentity.ts";
import { GlobalStore } from "./globalStore.ts";
import { controlPlaneHooks, type Hosted, takeHostedConfig } from "./hosted.ts";
import { startLlmGateway } from "./llmGateway.ts";
import { agentDir, boardOmpEnv, boardOmpHome } from "./login.ts";
import {
	createOmpStatsDashboard,
	parseOmpStatsPort,
} from "./ompStatsDashboard.ts";
import { orphanPids } from "./orphans.ts";
import { platform } from "./platform/index.ts";
import {
	commentOnPullRequest,
	listPulls,
	openPrsView,
	openPullRequest,
} from "./prs.ts";
import { ensureProjectPython, pythonPathDir } from "./python.ts";
import { fetchQuota } from "./quota.ts";
import {
	latestImage,
	ownerRepo,
	publishRelease,
	releaseChip,
	runGh,
	runReleaseCommand,
} from "./release.ts";
import { publicHosts } from "./requestGuards.ts";
import { startRun, vmRunnerFromEnv, workerFromEnv } from "./runner.ts";
import { archReviewView, lastFullReview, reviewBlocked } from "./scheduler.ts";
import { loadSecretBox, type SecretBox } from "./secretBox.ts";
import {
	type AdoptResult,
	adoptSharedProjectData,
	discoverProjects,
	ProjectStore,
} from "./store.ts";
import { createSupervisor } from "./supervisor.ts";
import { turnEnv } from "./tokens.ts";
import { buildToolsPath, ensureProjectTools } from "./tools.ts";
import {
	appendLog,
	createTurnLoop,
	type TurnProject as Entry,
	getSettingsLogged,
	parseReleaseVersion,
	type TurnLoop,
} from "./turn.ts";
import type { LatestImage, OpenPrsView } from "./types.ts";
import { VM_UNCONFIGURED, vmState } from "./vmState.ts";
import { VmTokens } from "./vmTokens.ts";
import {
	detachedRuns as detachedRunsRequest,
	killDetached as killDetachedRequest,
	sweepWorker as sweepWorkerRequest,
} from "./workers.ts";
import {
	archReviewDelta,
	branchMergedOrGone,
	branchUnpushed,
	changedFiles,
	checkedOutBranch,
	checkoutState,
	commitsAhead,
	createWorktree,
	deleteRemoteBranch,
	describeVersion,
	diffStat,
	diffText,
	fetchOriginBranch,
	fetchPrHead,
	git,
	githubUrl,
	hasRules,
	ignoreInMain,
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
const hosted: Hosted | undefined =
	HOSTED === null
		? undefined
		: { config: HOSTED, hooks: controlPlaneHooks(HOSTED) };
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
const gstore = GlobalStore.open(STATE_DIR);
/** Jira token sealing (docs/specs/jira-import.md section 1): the key file sits next to tracker.db.
 * A malformed key never stops the boot: the Jira routes answer 503 until it is fixed. */
let secretBox: SecretBox | undefined;
try {
	secretBox = loadSecretBox({ dir: join(resolve(STATE_DIR), ".tasks") });
} catch (err) {
	console.error(`jira: secret key: ${errmsg(err)}; Jira routes are off`);
}

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
	removedPaths: string[]; // projects removed from the board; discovery must not re-find them
	projectPaths: string[]; // explicitly added projects; discovery finds these even outside the roots
	/** Project names in board order, persisted via /api/projects/order. */
	projectOrder: string[];
	/** /api/settings/env writes saved values here; the loop reads them per turn. */
	envValues: Record<string, string>;
} = {
	// "none" starts the board with no global cap, like the Settings choice.
	maxTotalRuns:
		process.env.OMP_TRACKER_MAX_TOTAL === "none"
			? null
			: Number(process.env.OMP_TRACKER_MAX_TOTAL ?? 3),
	reviewCheck: true,
	workCheck: true,
	idleReviews: true,
	trendingScan: true,
	commitIdentity: null,
	envValues: {},
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

/** The chip's latest release: the repo's latest GitHub release when the project has a
 * GitHub remote and GitHub answers, else the highest vX.Y.Z tag merged into the target;
 * null when the target is unknown, like archReview. */
async function refreshRelease(e: Entry): Promise<void> {
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
	refreshImage(e);
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
	const last = lastFullReview(e.store.listTasks());
	const a = await archReviewDelta(
		e.path,
		e.target,
		last === null ? null : last.base,
	).catch(() => null);
	const cap = getSettingsLogged(e).archReviewCap;
	// Running: a review is queued or running, or its findings are still landing.
	const running = reviewBlocked(e.store.listTasks()) !== null;
	e.archReview = a === null ? null : archReviewView(last, a, cap, running);
}

/** Open-PR header chips re-probe gh at most this often; a PR opened between probes waits out the TTL. */
const PR_TTL = 10 * 60_000;
const prChips = new Map<string, { at: number; value: OpenPrsView | null }>();

/** Open-PR chips piggybacking on the release refresh: writes e.openPrs, one gh probe per TTL per repo. */
function refreshOpenPrs(e: Entry): void {
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
			e.openPrs = value;
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

/** Projects whose tasks.db did not open at boot: the backup records each as a failed database,
 * so retention keeps the last good copy (docs/specs/db-backup.md). */
const unopenedProjects: { name: string; error: string }[] = [];
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
		unopenedProjects.push({ name: basename(p), error: errmsg(err) });
		continue;
	}
	const e: Entry = {
		store,
		name: store.name,
		path: p,
		target: null,
		gitless: !(await isGitRepoWithCommit(p)),
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

	// R5-1 (docs/specs/pinned-origin-url.md): pin the origin URL before the loop starts and
	// any turn can run — awaited, so a merge cannot dispatch against an unpinned origin.
	if (!e.gitless) {
		const pin = await originRemoteUrl(p).catch(() => null);
		if (pin !== null && store.getSettings().originUrl === null)
			store.setSettings({ originUrl: pin });
	}

	resolveTarget(p, false, null, store.getSettings().targetBranch)
		.then((r) => {
			e.target = r.target;
			// OTTR-605: a repo whose origin has no branch for the local branch yet (awaiting
			// its first push) resolves aspirationally; show the "Push to origin" advisory
			// from boot, before the first tick's branchUnpushed refresh confirms it.
			if (r.unpushed === true) e.mainUnpushed = true;
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

/** One GET /healthz of the microVM runner into vmState.health; unconfigured stays unconfigured. */
async function probeVmRunner(): Promise<void> {
	if (vmTarget === null) {
		vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
		return;
	}
	const url = vmTarget.urls[0];
	if (url === undefined) {
		vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
		return;
	}
	try {
		const res = await fetch(`${url}/healthz`, {
			headers: vmTarget.token ? { "x-otwr-token": vmTarget.token } : {},
			// The worker token never follows a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(5000),
		});
		// vm-runner's 503 body is its own one-line reason ("vm-runner: /dev/kvm is missing");
		// the UI already names vm-runner, so the prefix and the URL stay out of the text.
		const body = (await res.text())
			.trim()
			.replace(/^vm-runner:\s*/, "")
			.slice(0, 300);
		vmState.health =
			res.status === 200
				? { configured: true, ok: true, reason: null }
				: {
						configured: true,
						ok: false,
						reason: body || `/healthz answered HTTP ${res.status}`,
					};
	} catch (err) {
		vmState.health = {
			configured: true,
			ok: false,
			reason: `no answer from ${url} (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}
// Boot probe without blocking boot: until it answers, microVM cards wait unclaimed.
void probeVmRunner();
setInterval(() => void probeVmRunner(), 30_000);
// Demo board (src/dev.ts): the seeded gate card's meter needs a fabricated progress line,
// because no agent runs and loop.running stays empty. Real boards never set OTTR_DEMO and
// take loop.running only. The import is dynamic: the image ships src/ only, never scripts/,
// so a static import crashes every real board at boot.
const demoProgress =
	process.env.OTTR_DEMO === "1"
		? (await import("../scripts/demo-data.ts")).demoProgressMap(projects)
		: null;

// The loop owns the engine; the request layer calls back into it through deps.schedule, and
// the loop's publish/log plumbing is late-bound to createApp's handles (both exist by boot).
const loop = createTurnLoop(projects, {
	extensionPath: EXTENSION,
	board,
	maxTotalRuns: () => shared.maxTotalRuns,
	reviewCheck: () => shared.reviewCheck,
	workCheck: () => shared.workCheck,
	quota: () => fetchQuota(boardOmpEnv()),
	drained: () => app.drained(),
	drainedRunner: (id) => app.drainedRunner(id),
	publishSoon: () => app.publishSoon(),
	notifyLog: (project, id) => app.notifyLog(project, id),
	refreshRelease,
	refreshArchReview,
	refreshOpenPrs,
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
	branchUnpushed,
	checkedOutBranch,
	checkoutState,
	serverMergePush,
	// OTTR-552 PR mode: the ship step pushes the card branch (server git credentials,
	// force-with-lease) and adopts or opens the PR via gh; the integrated proof is a
	// clean worktree with origin/<target> an ancestor of HEAD.
	pushBranch,
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
	vmTokens,
	syncWorktreeTo,
	startRun,
	// OTTR-454: the restart re-bind asks the workers for their detached runs and kills one on
	// cancel; with no workerTarget configured the loop never probes.
	detachedRuns: (url, token) => detachedRunsRequest(url, token),
	killDetached: (url, token, id) => killDetachedRequest(url, token, id),
	ensurePackages: (project) => ensureProjectPackages(project, workersHome),
	turnEnv: (project, model) =>
		turnEnv(project, model, shared.envValues, {
			home: workersHome,
			// Hosted model access is API keys only: no provider OAuth token is lent to turns.
			lend: hosted === undefined,
		}),
	// R5-1: a server-local turn reads tools.json and requirements.txt and installs under the
	// board's server-only home (the board-seed copy), never the shared home a worker turn can
	// write. The project venv's bin dir joins the tools link dir on the turn PATH, so a merge
	// turn re-runs the gates against the declared package set with no install step and no
	// question (docs/specs/merge-turn-packages.md).
	prepareTurn: async (project) => {
		const home = workersHome ?? boardOmpHome();
		const lines = [
			...(await ensureProjectTools(project, home)),
			...(await ensureProjectPython(project, home)),
		];
		const venvBin = pythonPathDir(project, home);
		if (venvBin !== "")
			lines.push("pip: the project venv's bin dir is on this turn's PATH");
		const pathDir =
			[buildToolsPath(project, home), venvBin].filter(Boolean).join(":") ||
			null;
		return { lines, pathDir };
	},
	publishRelease,
	runReleaseCommand,
	archReviewDelta,
	hosted,
});
// Signals from here on sweep live runs; during boot loopRef stays undefined and
// shutdown only releases the stores opened so far.
loopRef = loop;

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
	},
	workerTarget,
);

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
setInterval(() => void ompStatsDashboard.tick(), 60_000);
const app = createApp({
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
	stopTurn: loop.stopTurn,
	creditStop: loop.creditStop,
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
	runnerTurns: () => loop.runnerTurns(),
	// OTTR-763: the checkout guard's ambiguous-change notices for the bell.
	checkoutNotices: () => loop.checkoutNotices(),
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
	llmGateway: () => llmGateway,
	hosted,
	secretBox,
	ompStats: { info: ompStatsInfo, dashboard: ompStatsDashboard },
});

// Boot recovery is the loop's job now: a restart resurfaces running/preparing
// turns through one code path, so a cancelled card can never be requeued twice.
await loop.recoverRestarted();
loop.schedule();
setInterval(loop.schedule, 5000);

setInterval(() => void supervisor.tick(), 60_000);

// U9: when the alate server holds an unprovisioned import and no turn runs, run the same
// provision path as Settings → Alate → Provision; a failed attempt waits an hour.
setInterval(() => void app.alateProvisionTick(), 5 * 60_000);

// Idle auto-start (docs/specs/mutation-delta.md §7): with the setting on, a board quiet for
// two hours files the first due project's architecture-review card by itself.
setInterval(() => void app.idleReviewTick(), 5 * 60_000);

// Weekly GitHub trending scan (Monday 06:00 server time): the boot call lets a board that
// was down at the slot catch up; the 5-min tick finds the slot.
void app.trendingTick();
setInterval(() => void app.trendingTick(), 5 * 60_000);

// Memory health: boot + interval, never per turn (docs/specs/memory-backend.md).
setInterval(() => void app.memoryHealthTick(), 60_000);

// OTTR-548: worker sign-in self-reports, 60 s tick (the boot call is createApp's, like memory
// health); the state warnings read only the tick's cache — advisory, fail-soft.
setInterval(() => void app.workerSignInTick(), 60_000);

// 1 s diff tick: catches file-driven changes no code path writes (omp session titles, AGENTS.md
// appearing, main-checkout dirtiness). ponytail: replace with fs watchers if the state build ever
// shows in profiles. Every 5th tick a bare liveness ping.
let stateTick = 0;
setInterval(() => {
	if (app.socketCount() === 0) return;
	if (++stateTick % 5 === 0) app.publish({ type: "ping" });
	app.publishState();
}, 1000);

// Backups (docs/specs/db-backup.md): daily snapshot of tracker.db and each tasks.db, hourly
// check; the boot call lets a board that was down catch up.
const backup = resolveBackup(process.env, STATE_DIR, workerRoots);
for (const text of backup.errors) console.error(`backup: ${text}`);
if (backup.keep !== 0) {
	const backupNow = () =>
		backupTick({
			dir: backup.dir,
			keep: backup.keep,
			now: new Date(),
			// A project that opened later (added again from the board) is a live source, not a failure.
			sources: () =>
				backupSources(
					gstore,
					[...projects.values()].map((e) => e.store),
					unopenedProjects.filter((u) => !projects.has(u.name)),
				),
			log: (line) => console.log(line),
		});
	backupNow();
	setInterval(backupNow, 3_600_000);
}

// System sampler, one for all tabs (and for /api/system in polling mode): container and VM
// readings, self-update checks and the usage quota live behind sampleStats() in the request layer.
void app.sampleStats();
setInterval(() => void app.sampleStats(), 30_000);

// Upstream updates: one pull at boot, then hourly.
void app.refreshUpdates();
setInterval(() => void app.refreshUpdates(), 3_600_000);

// Fork research: hourly poll; change-triggered analysis inside the watcher.
void app.forkResearchTick();
setInterval(() => void app.forkResearchTick(), 3_600_000);

// PR reviews: hourly poll; the watcher gates which open PRs start a review turn.
void app.prReviewTick();
setInterval(() => void app.prReviewTick(), 3_600_000);

// Issue watch: hourly poll; files new open GitHub issues as backlog cards, capped per day.
void app.issueWatchTick();
setInterval(() => void app.issueWatchTick(), 3_600_000);

// omp watch: hourly npm poll; a model reviews each new omp release, files fail and bump cards.
void app.ompWatchTick();
setInterval(() => void app.ompWatchTick(), 3_600_000);

// Token expiry: probe at boot and once a day; advisory warnings and reminder pushes inside.
void app.tokenReminderTick();
setInterval(() => void app.tokenReminderTick(), 86_400_000);

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
		Bun.serve({
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
	const claimed = claimedPids();
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

console.log(`Ottr on http://127.0.0.1:${PORT}`);
