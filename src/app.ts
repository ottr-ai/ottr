// Ottr: request-serving half of the tracker — HTTP routes, board state push, stats.
// All mutable request state lives in createApp's closure, so two instances never share state.

import { AsyncLocalStorage } from "node:async_hooks";
import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, gzipSync } from "node:zlib";
import type { BunRequest, Serve, Server, ServerWebSocket } from "bun";
import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import {
	type AlateOut,
	alateHealth,
	alateRotateKey,
	alateUrlError,
	commitConfigYml,
	loadConfigYml,
	noRedirectFetch,
	readOnlyMountError,
	refreshAlateSnapshot,
	saveConfigYml,
} from "./alate.ts";
import { aptListPath, workerProjects } from "./apt.ts";
import {
	addSession,
	clearSessionCookie,
	dropSession,
	hashPassword,
	IDENTITY_HEADER,
	LoginLimiter,
	NonceCache,
	newSecret,
	newSessionId,
	parseCookies,
	RequestLimiter,
	SESSION_COOKIE,
	SESSION_MS,
	type SessionEntry,
	secretsEqual,
	sessionCookie,
	sessionLabel,
	signSession,
	verifyAdminLogin,
	verifyIdentity,
	verifySession,
} from "./auth.ts";
import { acceptsGzip, boardBundle, bundleResponse } from "./boardBundle.ts";
import { lookupBranchRules } from "./branchRules.ts";
import {
	openRegular,
	readBelow,
	unlinkBelow,
	withDir,
	writeBelow,
} from "./confine.ts";
import { logError } from "./crash.ts";
import { checkDeepened, type DeepenCheck, deepenDraft } from "./deepen.ts";
import { errmsg, requestFailed } from "./errmsg.ts";
import type { SpawnFn } from "./forkAnalysis.ts";
import {
	createForkWatcher,
	forkSummary,
	type GhFn,
	listForks,
} from "./forks.ts";
import {
	checkHostKey,
	createHostedGitAuth,
	defaultSshDir,
	GIT_URL_ERROR,
	type GitRemote,
	type GitToken,
	generatePendingKey,
	gitAuthEnv,
	gitSecrets,
	importPendingKey,
	type Keyscan,
	keyInfo,
	parseGitToken,
	parseGitUrl,
	promoteKey,
	pushAuthKind,
	readAmbientHelpers,
	realKeyscan,
	redact,
	removeKey,
	type SshPaths,
	setGitSecrets,
	sshPaths,
	type TrustNeeded,
	testRemote,
} from "./gitHosts.ts";
import { handleGit } from "./gitHttp.ts";
import { githubAlertSummary } from "./githubAlerts.ts";
import {
	AppTokenSource,
	appCheckWarning,
	checkAppInstalls,
	parseAppPem,
	validateAppCredentials,
} from "./githubApp.ts";
import { GIT_HTTP_AUTH_STATUS, githubAuthHint } from "./githubAuthHint.ts";
import {
	configuredGithubHostname,
	DEFAULT_GITHUB_HOST,
	GITHUB_HOST_ENV,
	type GithubHost,
	gheNoticeHost,
	githubHost,
	hostMatcher,
	parseGithubHost,
} from "./githubHost.ts";
import { withGithubRetry } from "./githubRetry.ts";
import {
	type CommitIdentity,
	identityArgs,
	parseCommitField,
} from "./gitIdentity.ts";
import type { GlobalStore } from "./globalStore.ts";
import type { Hosted } from "./hosted.ts";
import { DeliveryCache, eventRepository, githubEventWatch } from "./hosted.ts";
import {
	type DecodedImage,
	decodeImages,
	MAX_IMAGE_BYTES,
	saveImages,
	sniffImage,
} from "./images.ts";
import { createIssueWatcher } from "./issues.ts";
import type { JiraNet } from "./jira.ts";
import { createJiraRoutes } from "./jiraRoutes.ts";
import { rebuildLayerUse } from "./layers.ts";
import { handleHindsight, handleLlm } from "./llmProxy.ts";
import {
	agentDir,
	boardOmpEnv,
	boardOmpHome,
	boardSignIns,
	deadSignIns,
	loginProviders,
	PROVIDER_ID,
	providerLogin,
	type SignIn,
	signIns,
	signOutEverywhere,
} from "./login.ts";
import {
	checkMemoryHealth,
	type MemoryHealth,
	memoryBackendFromEnv,
} from "./memory.ts";
import { mermaidSrc } from "./mermaidVersion.ts";
import {
	commitMessage,
	editModelRoles,
	type Fallbacks,
	RolesLayoutError,
	readFallbacks,
	readRoles,
	validateRoles,
} from "./modelRoles.ts";
import {
	cardModelError,
	type ModelOption,
	modelFallbacks,
	modelList,
	modelRoles,
} from "./models.ts";
import {
	ALERT_CLASSES,
	ALL_CLASSES_ON,
	type AlertCardInput,
	type AlertClass,
	type AlertEvent,
	type AlertPayload,
	ackKeys,
	type ClassPrefs,
	type ClearBound,
	type ClearPayload,
	clearedAlerts,
	deliverable,
	diffEvents,
	isApplePush,
	type LiveAlert,
	normalizeSeen,
	payloadsFor,
	presenceHolds,
	rekeyErrorAlerts,
	SEEN_KEY_MAX,
	tagsToClear,
	taskEntryKey,
} from "./notifications.ts";
import {
	buildOmpStatsReport,
	type OmpStatsAnswer,
	type OmpStatsReport,
	type OmpStatsSource,
	scanSessionUsage,
} from "./ompStats.ts";
import {
	forwardToDashboard,
	type OmpStatsDashboard,
	type OmpStatsDashboardInfo,
	startingPage,
} from "./ompStatsDashboard.ts";
import { type MirrorSource, mirrorFolderName } from "./ompStatsMirror.ts";
import { createOmpWatcher } from "./ompWatch.ts";
import {
	type OrphanProject,
	orphanCache,
	orphanView,
	summarizeCmd,
} from "./orphans.ts";
import { perfMetrics, turnMedianKey, turnMedians } from "./perf.ts";
import { type ProcessInfo, platform } from "./platform/index.ts";
import { derivedTaskPrefix } from "./prefix.ts";
import {
	type ParsedReview,
	parseReviewDraft,
	reviewPayloadComments,
} from "./prInline.ts";
import { mergeProjectOrder, rankInOrder } from "./projectOrder.ts";
import {
	gateCompareText,
	gateFingerprint,
	gateHandoff,
	gateJudgedPrompt,
	gateUserText,
	isStartAnywayReply,
} from "./promptGate.ts";
import {
	BOARD_CHECK_PROMPT,
	followUpPrompt,
	handoffMarkdown,
	IMPLEMENT_RECOMMENDATIONS,
	isProposalReason,
	LOST_SESSION,
	releasePrompt,
	reviewPrompt,
	rulesInterviewPrompt,
	WORK_CHECK_MAX_SENDBACKS,
	workCheckSendBack,
	workCheckSendBackDirection,
} from "./prompts.ts";
import { createPrWatcher, PR_GATES, prUrl } from "./prs.ts";
import { requirementsListPath } from "./python.ts";
import { fetchQuota, forProvider, providerBlocked } from "./quota.ts";
import {
	cachedLatestGhRelease,
	includedTasks,
	type LatestGhRelease,
	lateCommits,
	ownerRepo,
	planRelease,
	releaseBlocked,
	runGh,
} from "./release.ts";
import { summarizeRelease } from "./releaseSummary.ts";
import {
	directLoopback,
	hostMatches,
	hostRefusal,
	keyedThrottle,
	loopbackIp,
	originRefusal,
	upgradeRefusal,
} from "./requestGuards.ts";
import {
	archReviewDue,
	type DepResolution,
	depProjectOf,
	depProjectsOf,
	findingsSettledAt,
	isRetro,
	isReview,
	LEAD_APPLIES_OPTION,
	LEAD_NOT_APPLY_OPTION,
	LEAD_QUESTIONS_PROMPT_PREFIX,
	lastReviewBase,
	liveCardOf,
	mergeAnywayPatch,
	openWorkBlockers,
	PROMPT_EDIT_HELD,
	pushHold,
	queueOrder,
	type ReviewTask,
	releaseHeldMerges,
	repeatedBugClasses,
	resolveDep,
	reviewBlocked,
	reviewFindings,
	silentSince,
	WORK_CHECK_ASK_BLOCK,
	WORK_CHECK_ASK_CANCEL,
	WORK_CHECK_ASK_DIVERGE,
	WORK_CHECK_ASK_MERGE,
	WORK_CHECK_ASK_NEW_APPROACH,
	WORK_CHECK_ASK_SEND_BACK,
	workCheckBlockerCounts,
} from "./scheduler.ts";
import { migrateSealedConfig, sealStoredConfigRow } from "./sealedConfig.ts";
import { isSealed, type SecretBox } from "./secretBox.ts";
import { sessionContext } from "./session.ts";
import { type BoardTurnFacts, ProjectStore, type TaskPatch } from "./store.ts";
import { createSystemSampleLog } from "./systemSampleLog.ts";
import {
	createSystemSampler,
	fetchWorkerStats,
	type LiveRun,
	type RunnerReading,
	readCgroup,
	readVm,
} from "./systemStats.ts";
import { formatBytes, type TmpDiskSpace, tmpDiskSpace } from "./tmpsweep.ts";
import {
	ENV_NAME,
	envListPath,
	layerHome,
	listedEnvNames,
	readUserLayer,
	toolsListPath,
} from "./tools.ts";
import {
	createTrendingScanner,
	EMPTY_TRENDING_STATE,
	TRENDING_CAP,
	type TrendingState,
} from "./trending.ts";
import {
	type CancelOutcome,
	type FinishKeptOutcome,
	FORK_HOLD_REASON,
	isKeptReason,
	logStoreError,
	MERGE_HOLD_MISMATCH_REASON,
	queuedReply,
	replyPatch,
	type StopOutcome,
	type TurnProject,
	UPDATE_HOLD_REASON,
} from "./turn.ts";
import { checkTurnToken } from "./turnGithubToken.ts";
import {
	APPROVE_REPLY,
	type AppCheck,
	answeredCard,
	askAnswerLine,
	doneReadKey,
	type ListedTask,
	type OrphanProcess,
	type PerfRange,
	PRIORITIES,
	type Priority,
	type ProjectSettings,
	type ProjectView,
	type ProvisioningResponse,
	type PrReviewRow,
	type QuotaState,
	REVIEW_BODY_MAX,
	REVIEW_FOOTER,
	type ReleasePlan,
	type RestartWaitView,
	recommendsSteps,
	type SeedFailedView,
	type ServerMessage,
	type StateResponse,
	type SystemHolds,
	type Task,
	type TaskCard,
	type TaskView,
	type UpdateRecord,
	type UpdatesView,
	VERSION_RE,
} from "./types.ts";
import board from "./ui/index.html";
import { SLOT_STAGES, slotUse } from "./ui/queue.ts";
import {
	isUpdateCommit,
	parseUpdateHostHeartbeat,
	UpdateCycleController,
	type UpdateCycleView,
	type UpdateHostHeartbeat,
	type UpdateHostReply,
} from "./updateCycle.ts";
import {
	addSkip,
	loadSkips,
	mapRepo,
	migratePendingToSkips,
	removePrompt,
	updatePrompt,
	validateUpdates,
} from "./updates.ts";
import { vmHoldFor, vmState } from "./vmState.ts";
import { type VmTokens, vmTokenOf } from "./vmTokens.ts";
import {
	loadSubs,
	PUSH_SUBJECT,
	type PushSub,
	pruneSubs,
	saveSubs,
	sendAll,
} from "./webpush.ts";
import type { WorkerTarget } from "./workers.ts";
import {
	archReviewDelta,
	diffStat,
	diffText,
	git,
	githubUrl,
	hasRules,
	hostedGitAuth,
	httpsRemote,
	isGitRepoWithCommit,
	originRemoteUrl,
	remoteUrl,
	resolveTarget,
	serverMergePush,
	setHostedGitAuth,
	setNetworkGitAuth,
	statusFiles,
	validateCopyPath,
} from "./worktree.ts";

const MAX_BODY_BYTES = 65536;
/** GitHub's documented webhook payload ceiling: the control plane forwards the payload as it arrived. */
const MAX_EVENT_BODY_BYTES = 25 * 1024 * 1024;
/** Timeout for the re-run-failed-jobs GitHub API call, mirroring the trending scan. */
const RERUN_TIMEOUT_MS = 20_000;
/** Ceiling for the default token-expiry probe fetch, so a hung remote cannot stall a tick. */
const TOKEN_PROBE_TIMEOUT_MS = 20_000;

/** A posted list of strings within the route's entry cap. */
function isStringList(v: unknown, max: number): v is string[] {
	return (
		Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string")
	);
}

const ICON_EXTS = ["png", "jpg", "gif", "webp"] as const;

/** Path of the stored icon in the project's data dir, or null when none exists. */
function iconFile(tasksDir: string): string | null {
	for (const ext of ICON_EXTS) {
		const file = join(tasksDir, `icon.${ext}`);
		if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
	}
	return null;
}

/** Deletes every icon.<ext> variant; missing files are fine. */
function removeIcons(root: string, tasksDir: string): void {
	for (const ext of ICON_EXTS) {
		try {
			unlinkBelow(root, join(tasksDir, `icon.${ext}`));
		} catch (err) {
			// Missing file: nothing to remove.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
}

const IMAGE_BODY_BYTES = 32 * 1024 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;
/** A route param that names a task: legacy 8-hex or the project's `PREFIX-n` handle, either
 * with a retro child suffix `-retro[-k]`. resolveTask reads it; SEEN_ID_RE below repeats it
 * with the optional completion suffix, so change both together. */
const TASK_ID_RE =
	/^(?:[0-9a-f]{8}|[A-Z0-9]{1,8}-[0-9]+)(?:-retro(?:-[0-9]+)?)?$/;
/** A /api/seen mark: a task id (TASK_ID_RE), or (OTTR-566) one completion's `doneReadKey`, `<id>@<doneAt>`. */
const SEEN_ID_RE =
	/^(?:[0-9a-f]{8}|[A-Z0-9]{1,8}-[0-9]+)(?:-retro(?:-[0-9]+)?)?(?:@[0-9]+)?$/;
/** How long one POST /api/drain holds new turns. scripts/update-image.ts renews it every 30 s
 * while it waits, so a hold that the script stops renewing lapses on its own. DELETE ends it
 * at once: the script does that when its 1 h limit ends the wait. */
const DRAIN_MS = 30 * 60_000;
/** How long a deferred server restart waits before the board shows the bell notice; the
 * update script has its own warn constant — they must not share one. */
const RESTART_WAIT_NOTICE_MS = 6 * 60 * 60_000;

/** The New tab's folder-name rule (unchanged from before git hosts), shared with the clone
 * name: one path segment, never "." or "..". A leading "-" is safe because git clone gets the
 * destination after "--". */
function isFolderName(name: string): boolean {
	return (
		name !== "" && name !== "." && name !== ".." && !/[:*?"<>|\\/]/.test(name)
	);
}

/** The per-project row the board and the turn loop share; defined by the turn module. */
export type Entry = TurnProject;

/** OTTR-688: release usage-limit holds early. For every provider that still holds cards, when
 * the fresh quota report no longer shows a blocking window (a window 100% used with a future
 * reset), the provider's holds clear on every project and the scheduler picks the cards up;
 * holdUntil stays the upper bound when the report is silent for that provider. Only usage holds
 * go: a hold without holdProvider (an open prompt edit, a hosted credit retry) and holds whose
 * time already passed (the scheduler runs them anyway) stay. One pass per refresh releases a
 * provider at most once, and logs one line per freed provider; a re-hold after a release was
 * stamped from a full report, so the next refresh with that report keeps it. Returns the
 * released card count. */
export function releaseUsageHolds(
	q: QuotaState,
	projects: Iterable<{ store: ProjectStore }>,
	now: number,
): number {
	const held = new Map<string, { store: ProjectStore; id: string }[]>();
	for (const p of projects)
		for (const t of p.store.listTasks()) {
			if (
				t.cancelledAt !== null ||
				t.holdUntil === null ||
				t.holdUntil <= now ||
				t.holdProvider === null
			)
				continue;
			const list = held.get(t.holdProvider) ?? [];
			list.push({ store: p.store, id: t.id });
			held.set(t.holdProvider, list);
		}
	let released = 0;
	for (const [provider, cards] of held) {
		const rows = forProvider(q.limits, provider);
		// No data for the provider (a failed usage check included): holdUntil stays the bound.
		if (rows.length === 0 || providerBlocked(rows, provider, now) !== null)
			continue;
		for (const c of cards)
			c.store.updateTask(c.id, {
				holdUntil: null,
				holdProvider: null,
				holdWindow: null,
			});
		released += cards.length;
		console.log(
			`[quota] released ${cards.length} cards held for ${provider}: the limit reports free again`,
		);
	}
	return released;
}

interface AppDeps {
	gstore: GlobalStore;
	/** gh CLI seam; defaults to runGh. Tests inject a stub for the /github route. */
	gh?: GhFn;
	/** Latest GitHub release seam; defaults to the cached probe in release.ts. Tests inject
	 * a stub for the release chip and the Create release routes. */
	latestRelease?: (repo: string) => Promise<LatestGhRelease | null>;
	/** Deepen seam for the composer route; defaults to deepenDraft (one gateway call). Tests inject a stub so no spawn happens. */
	deepen?: (prompt: string, model: string | null) => Promise<string>;
	/** Deepen check seam; defaults to checkDeepened (one gateway call judging draft vs rewrite against the five deepen points). Tests inject a stub so no spawn happens. */
	deepenCheck?: (
		draft: string,
		rewrite: string,
		model: string | null,
	) => Promise<DeepenCheck>;
	/** Server-side projects root (compose: /workspace via OMP_TRACKER_ROOTS[0]); Add project clones/creates under it. */
	defaultDir: string;
	projects: Map<string, Entry>;
	cancel(e: Entry, id: string, force: boolean): Promise<CancelOutcome>;
	stopTurn(e: Entry, id: string): Promise<StopOutcome>;
	finishKept(
		e: Entry,
		id: string,
		choices: unknown,
	): Promise<FinishKeptOutcome>;
	claimedPids(): Set<number>;
	/** Live progress of the task's running turn (TaskCard.progress) and when its moving part
	 * last changed (silentSince's activity, absent until the first numbered status); absent in tests. */
	progressOf?(
		project: string,
		id: string,
	): { text: string; at?: number } | null;
	schedule: () => void;
	/** Node env style clock for the idle-review logic only; tests inject a fixed clock.
	 * Defaults to Date.now. */
	now?: () => number;
	serverVersion: string;
	port: number;
	publicHosts: string[];
	shared: {
		/** Null = no cap: start as many runs as projects need. */
		maxTotalRuns: number | null;
		reviewCheck: boolean;
		workCheck: boolean;
		/** Default on; POST /api/settings writes it, the idle review tick reads it. */
		idleReviews: boolean;
		/** Default on; POST /api/settings writes it, the weekly trending tick reads it. */
		trendingScan: boolean;
		/** OTTR-693: the commit identity Settings names; null keeps the built-in Ottr default. */
		commitIdentity: CommitIdentity | null;
		removedPaths: string[];
		projectPaths: string[];
		/** Project names in board order; names not listed keep discovery order after them. */
		projectOrder: string[];
		/** Secret env values from Settings, one per env.txt name; the only copy. Stored plaintext
		 * in the config file like githubToken (same trust level), never served back after save.
		 * The turn loop reads it for redaction and env seeding. */
		envValues: Record<string, string>;
		/** Plain env values, one per env.txt name marked `plain`: stored as plain text, served
		 *  back to Settings and never redacted (docs/specs/env-plain-values.md). */
		envPlain: Record<string, string>;
	};
	serverRef: { current: Server<undefined> | undefined };
	/** NODE_ENV=production: the board serves the static bundle and refuses live updates. */
	prod?: boolean;
	/**
	 * Where task sessions reach the board (OTTR_BOARD_URL) and the boot token they carry. A URL
	 * that no allowlist covers (compose: http://ottr:<port>) opens that host to card filing
	 * with the token, and to nothing else (see api()).
	 */
	board?: { url: string; token: string };
	/** Orphan process snapshot source; injectable for tests. Defaults to platform.listProcesses. */
	listProcesses?: () => ProcessInfo[];
	/** Orphan stop seam; injectable for tests. Defaults to platform.killTree. */
	killTree?: (pid: number) => void;
	/** OTTR-454: every runner (worker hostnames from OTTR_WORKER_URLS, then local); absent = only local. */
	runners?: { id: string; url: string | null }[];
	/** OTTR-454: live runs per runner plus the preparing count, from the turn loop; absent counts zero. */
	runnerTurns?: () => {
		local: number;
		workers: Record<string, number>;
		preparing: number;
	};
	/** OTTR-763: the cross-project checkout guard's ambiguous-change bell notices (one per
	 * change; names the commit and the running cards); absent = none. */
	checkoutNotices?: () => string[];
	/** The board's live runs (project, id, runner hostname or "server", Stryker progress), so the
	 * /system view can name the runs waiting on a runner's mutation lock; absent = none. */
	liveRuns?: () => LiveRun[];
	/** OTTR-548: the worker dispatch target parsed from OTTR_WORKER_URLS; workerSignInTick probes its
	 * urls' GET /signins for the worker sign-in warnings. Null, absent or empty = no workers to probe. */
	workerTarget?: WorkerTarget | null;
	/** Only for tests: the transcript usage scan GET /api/settings/omp-stats runs instead of
	 * scanSessionUsage, so a test can count reads and serve fixture stores. */
	scanSessionUsage?: (sessionsDir: string) => OmpStatsAnswer;
	/**
	 * Settings -> omp usage -> Launch omp stats dashboard (docs/specs/omp-stats-dashboard.md):
	 * the proxy listener's port (null + error when disabled) and the on-demand dashboard that
	 * ompStatsFetch forwards to. Absent = no dashboard; the info endpoint says so.
	 */
	ompStats?: { info: OmpStatsDashboardInfo; dashboard: OmpStatsDashboard };
	/** Server-only ssh key + known_hosts dir; no worker mounts it. */
	sshDir?: string;
	/** Base home of the env.txt name lists (<home>/.ottr/workers); defaults to boardOmpHome() (R5-1). */
	workersHome?: string;
	/** ssh-keyscan seam for the host-key check; defaults to realKeyscan. Tests inject a stub. */
	keyscan?: Keyscan;
	/**
	 * Fetch/timeout seam for the git 401/403 GitHub-API probe (githubAuthHint); defaults
	 * to fetch with a 5 s ceiling. Tests inject a stub or a shorter ceiling.
	 */
	githubAuthProbe?: {
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		timeoutMs?: number;
	};
	/** Fetch seam for the branch-rules probe (OTTR-675, src/branchRules.ts); defaults to fetch. Tests inject a stub. */
	branchRulesFetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Model catalog seam for the model roles editor; defaults to modelList. */
	models?: () => Promise<ModelOption[]>;
	/**
	 * GitHub token expiry probe seam; defaults to GET https://api.github.com/repos/ottr-ai/ottr
	 * on the default host, or GET <apiBase>/user on another host, with the token, reading
	 * `github-authentication-token-expiration`. ISO date or null (no expiry). A throw keeps
	 * the stored value (advisory; retried on the next tick).
	 */
	githubTokenExpiry?: (token: string) => Promise<string | null>;
	/**
	 * Ceiling for the default token-expiry probe fetch in ms; default TOKEN_PROBE_TIMEOUT_MS.
	 * Tests inject a short one.
	 */
	githubTokenExpiryTimeoutMs?: number;
	/**
	 * Sleep seam for the default token-expiry probe's retry waits (OTTR-792); tests inject
	 * a no-op so a stubbed rate-limited or 5xx answer does not wait.
	 */
	githubTokenExpirySleep?: (ms: number) => Promise<void>;
	/**
	 * Fetch seam for the GitHub App installation-token mint and the direct review post;
	 * defaults to noRedirectFetch. Tests inject a stub.
	 */
	githubAppFetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Gateway spawn seam for the release-summary model call; defaults to the real spawn. Tests inject a stub. */
	releaseSummarySpawn?: SpawnFn;
	/** Gateway spawn seam for the PR-review model call; defaults to the real spawn. Tests inject a stub. */
	prReviewSpawn?: SpawnFn;
	/** Fetch seam for the weekly trending scan (GitHub pages and REST API); defaults to fetch. Tests inject a stub. */
	trendingFetch?: typeof fetch;
	/** Fetch seam for the re-run-failed-jobs GitHub API call; defaults to fetch. Tests inject a stub. */
	rerunFetch?: typeof fetch;
	/** Fetch seam for the turn read-token check (checkTurnToken); defaults to fetch. Tests inject a stub. */
	turnTokenFetch?: typeof fetch;
	/** OTTR-532: the per-turn microVM tokens (git endpoint, /llm, /hindsight, card filing); absent = no VM turns. */
	vmTokens?: VmTokens;
	/** OTTR-532: the local auth-gateway the /llm proxy forwards to; null while it is not running. */
	llmGateway?: () => { url: string; token: string } | null;
	/** Hosted mode (docs/specs/hosted-mode.md); undefined on every self-hosted board, and then no hosted path runs. */
	hosted?: Hosted;
	/**
	 * Hosted mode's credit stop (POST /api/hosted/stop, docs/specs/hosted-mode.md section 5): stops
	 * every running turn as stopTurn does and parks its card with the credit reason; resolves to
	 * the number of turns stopped.
	 */
	creditStop?: () => Promise<number>;
	/**
	 * Hosted mode's credit release (POST /api/hosted/release, docs/specs/hosted-mode.md section
	 * 5): after a top-up, clears the credit hold and queues each card the credit stop or gate
	 * parked, like an owner Resume; resolves to the number of cards queued.
	 */
	creditRelease?: () => Promise<number>;
	/**
	 * Hosted forwarded GitHub events (POST /api/hosted/github-event, docs/specs/hosted-mode.md
	 * section 8): kicks the CI-watch supervisor's tick for one project. server.ts binds it after
	 * createSupervisor; a hosted board without it throws like the missing creditStop.
	 */
	ciWatchTick?: (opts?: { manual?: string }) => Promise<void>;
	/**
	 * OTTR-715: a guarded handler that runs at least this long logs one line
	 * (`api slow: <method> <route pattern> took <ms>ms`) via console.warn, so a slow
	 * endpoint shows up in the board log without ids or query values. Tests inject 0
	 * (always log) or a large value (never log). Defaults to 500.
	 */
	slowApiMs?: number;
	/**
	 * Seals the Jira connection tokens (docs/specs/jira-import.md section 1); server.ts loads it
	 * at boot. Undefined (a malformed OTTR_SECRET_KEY) = every Jira route answers 503.
	 */
	secretBox?: SecretBox;
	/** Jira request seams (fetch, DNS lookup, timeout, hosted); tests inject a stub. Default
	 * hosted = deps.hosted is set. */
	jiraNet?: Partial<JiraNet>;
}

/** How far the checkout at `dir` is behind origin/main, for the update banner. The banner is a
 *  development tool: only a checkout on branch main sees it. A release tag (detached HEAD), any
 *  other branch, or a folder without git (the Docker image) reports 0, so a release never offers
 *  to move to main. */
export async function behindMain(
	dir: string,
): Promise<{ behind: number; commits: string[] }> {
	const none = { behind: 0, commits: [] };
	const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
	if (branch.code !== 0 || branch.stdout.trim() !== "main") return none;
	if ((await git(["fetch", "origin", "main"], dir)).code !== 0) return none;
	const c = await git(["rev-list", "--count", "HEAD..origin/main"], dir);
	if (c.code !== 0) return none;
	// Subjects for the banner's bullet list. ponytail: capped at 50 so a long
	// divergence cannot blow up the WS frame; the count above stays authoritative.
	const l = await git(
		["log", "--format=%s", "-n", "50", "HEAD..origin/main"],
		dir,
	);
	return {
		behind: Number(c.stdout.trim()) || 0,
		commits: l.code === 0 ? l.stdout.trim().split("\n").filter(Boolean) : [],
	};
}

/** The persisted removed/added project paths and display order; boot discovery needs them
 * before createApp runs. */
export function storedProjectPaths(gstore: GlobalStore): {
	removedPaths: string[];
	projectPaths: string[];
	projectOrder: string[];
} {
	const c = gstore.get<{
		removed?: unknown;
		projects?: unknown;
		projectOrder?: unknown;
	}>("config");
	const strs = (v: unknown) =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	return {
		removedPaths: strs(c?.removed).map((p) => resolve(p)),
		projectPaths: strs(c?.projects).map((p) => resolve(p)),
		projectOrder: strs(c?.projectOrder),
	};
}

/** One transcript store of the board, named for the omp usage card. */
export interface OmpSessionStore extends MirrorSource {
	name: string;
}

/**
 * Every session transcript store of the board: the board's own default store, the workers'
 * default store when it is another dir, and each project's sessions dir. The omp usage card
 * and the stats dashboard mirror both read this one list, so they cannot drift apart.
 * Stores keep their folder layout (folder null); a flat project dir maps to its own folder.
 */
export function ompSessionStores(
	projects: ReadonlyMap<string, Entry>,
): OmpSessionStore[] {
	const board = join(boardOmpHome(), ".omp", "agent", "sessions");
	const stores: OmpSessionStore[] = [
		{ name: "board store", dir: board, folder: null },
	];
	// The workers' shared home default store, when it is another directory (compose:
	// home:/root is shared, the board home is server-only). Its sessions are the
	// manual and stray runs; turn usage lives in the project dirs below.
	const workerStore = join(homedir(), ".omp", "agent", "sessions");
	if (resolve(workerStore) !== resolve(board))
		stores.push({ name: "workers' store", dir: workerStore, folder: null });
	for (const [name, e] of projects)
		stores.push({
			name,
			dir: e.store.sessionsDir,
			folder: mirrorFolderName(name),
		});
	return stores;
}

// OTTR-719: mermaid's prebuilt bundle is ~5.5 MB raw and ~1.2 MB brotli (OTTR-662 tips 9 and
// 27). It is served at a versioned path (src/mermaidVersion.ts) with an immutable year cache,
// so a browser downloads it once per version. Compression runs once per process, on zlib's
// threadpool: the first createApp kicks it off at boot, and a request that arrives earlier
// just awaits the result.
const mermaidRawPath = Bun.resolveSync(
	"mermaid/dist/mermaid.min.js",
	import.meta.dir,
);
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
let mermaidBodies: Promise<{
	br: Uint8Array<ArrayBuffer>;
	gzip: Uint8Array<ArrayBuffer>;
}> | null = null;
const mermaidCompressed = () =>
	(mermaidBodies ??= (async () => {
		const raw = new Uint8Array(await Bun.file(mermaidRawPath).arrayBuffer());
		const [br, gz] = await Promise.all([
			brotliAsync(raw),
			// gzip -9, as measured in OTTR-662 (1,568,811 bytes on this bundle).
			gzipAsync(raw, { level: 9 }),
		]);
		// Copy out of zlib's possibly pooled Buffer: the copies are the one-time compressed
		// bodies served for the process lifetime, and Response bodies need a plain view.
		return { br: new Uint8Array(br), gzip: new Uint8Array(gz) };
	})());

/** Weight per token of an Accept-Encoding header (q= values, default 1). */
function acceptEncodingWeights(header: string): Map<string, number> {
	const q = new Map<string, number>();
	for (const part of header.split(",")) {
		const segments = part.trim().split(";");
		const name = segments[0]?.trim().toLowerCase();
		let value = 1;
		for (const p of segments.slice(1)) {
			const m = /^q=([\d.]+)$/i.exec(p.trim());
			if (m) value = Number.parseFloat(m[1] ?? "") || 0;
		}
		if (name !== undefined && name !== "") q.set(name, value);
	}
	return q;
}

/** Whether the weights allow `encoding` (a "*" entry covers everything else). */
function acceptsWeight(q: Map<string, number>, encoding: string): boolean {
	const v = q.get(encoding);
	if (v !== undefined) return v > 0;
	const star = q.get("*");
	return star !== undefined && star > 0;
}

/** Best of br and gzip that the weights allow; a tie keeps br first (candidates are in
 *  preference order). */
function pickFromWeights(q: Map<string, number>): "br" | "gzip" | "identity" {
	let best: "br" | "gzip" | null = null;
	for (const encoding of (["br", "gzip"] as const).filter((e) =>
		acceptsWeight(q, e),
	))
		if (best === null || (q.get(encoding) ?? 0) > (q.get(best) ?? 0))
			best = encoding;
	return best ?? "identity";
}

/** Best of br and gzip that the request's Accept-Encoding allows; "identity" when neither is.
 *  Unknown tokens (zstd, *) never select a compression this server did not make. Exported for
 *  the parser tests; the HTTP tests prove only the header-visible picks. */
export function pickEncoding(
	header: string | null,
): "br" | "gzip" | "identity" {
	if (header === null) return "identity";
	return pickFromWeights(acceptEncodingWeights(header));
}

/**
 * Bun infers the route-key union R from the literal's keys and maps each to `BunRequest<Path>`,
 * so handlers keep exact `req.params` typing without a hand-maintained route list (R1-15).
 */
const defineRoutes = <R extends string>(
	r: Serve.RoutesWithUpgrade<undefined, R>,
) => r;

/** GitHub's `github-authentication-token-expiration` header ("2027-10-30 00:00:00 UTC") as ISO 8601 UTC; null when absent or unparsable. */
function parseGithubExpiry(h: string | null): string | null {
	if (h === null) return null;
	const d = new Date(h.replace(" ", "T").replace(/ UTC$/, "Z"));
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Whole UTC days from today to the expiry date: 0 on the expiry day itself, negative after. */
function tokenDaysLeft(expiresAt: string, now: Date): number {
	const midnight = (t: number) => {
		const d = new Date(t);
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	};
	const target = midnight(new Date(expiresAt).getTime());
	if (Number.isNaN(target)) return Number.NaN;
	return Math.floor((target - midnight(now.getTime())) / 86_400_000);
}

/** Per-token reminder state next to seed-commit (board config, not SQLite; spec 3). */
type TokenReminder = {
	expiresAt: string | null;
	lastPushDay: string | null;
};
export type ReminderState = { board: TokenReminder; seed: TokenReminder };
export type TokenExpiryView = {
	board: { tokenSet: boolean; expiresAt: string | null };
	seed: { seeded: boolean; expiresAt: string | null };
};
const emptyReminder = (): TokenReminder => ({
	expiresAt: null,
	lastPushDay: null,
});

/** token-reminders.json lives next to the board omp home (like seed-commit). */
function tokenRemindersPath(): string {
	return join(dirname(boardOmpHome()), "token-reminders.json");
}
/** The compose-side probe writes the seed token's expiry here (spec 1). */
function seedTokenExpiresPath(): string {
	return join(dirname(boardOmpHome()), "seed-token-expires");
}
function readSeedTokenExpires(): string | null {
	try {
		const v = readFileSync(seedTokenExpiresPath(), "utf8").trim();
		return v === "none" || v === "" ? null : v;
	} catch {
		return null;
	}
}
/** Missing or corrupt file: defaults, no error. */
function loadReminders(): ReminderState {
	try {
		const p = JSON.parse(readFileSync(tokenRemindersPath(), "utf8")) as {
			board?: Partial<TokenReminder>;
			seed?: Partial<TokenReminder>;
		};
		return {
			board: { ...emptyReminder(), ...p.board },
			seed: { ...emptyReminder(), ...p.seed },
		};
	} catch {
		return { board: emptyReminder(), seed: emptyReminder() };
	}
}
function saveReminders(s: ReminderState): void {
	mkdirSync(dirname(tokenRemindersPath()), { recursive: true });
	writeFileSync(tokenRemindersPath(), `${JSON.stringify(s, null, "\t")}\n`);
}
/** The stateless view the warnings and the UI derive from: files + env, no token crosses. */
function tokenExpiryView(
	env: Record<string, string | undefined> = process.env,
): TokenExpiryView {
	return {
		board: {
			tokenSet: !!env.GH_TOKEN?.trim(),
			expiresAt: loadReminders().board.expiresAt,
		},
		seed: {
			seeded: !!env.OTTR_BOARD_OMP_HOME?.trim(),
			expiresAt: readSeedTokenExpires(),
		},
	};
}
/** The active (or expired-effect) warning for one token; null when none is due. */
function tokenExpiryWarning(
	kind: "board" | "seed",
	expiresAt: string | null,
	now: Date,
): string | null {
	if (expiresAt === null) return null;
	const days = tokenDaysLeft(expiresAt, now);
	if (Number.isNaN(days) || days > 30) return null;
	const date = expiresAt.slice(0, 10);
	const renew =
		"Renew it at https://github.com/settings/personal-access-tokens.";
	if (days < 0)
		return kind === "board"
			? `The board's GitHub token expired on ${date}. GitHub calls from the board fail. ${renew}`
			: `The board seed token expired on ${date}. The board seed stops. ${renew}`;
	return kind === "board"
		? `The board's GitHub token expires on ${date} (in ${days} days). ${renew}`
		: `The board seed token expires on ${date} (in ${days} days). ${renew}`;
}

/** The task facts the warning loops read. */
type WarnTask = ReviewTask &
	Pick<Task, "state" | "project" | "stage" | "pushRetries" | "pendingBy">;

/** Warnings for model roles whose provider has no active sign-in and no env key. Providers in
 *  `named` are skipped and get added: several roles sharing one warn once (the first names it). */
function missingProviderWarnings(
	roles: Readonly<Record<string, string>>,
	active: ReadonlySet<string>,
	named: Set<string>,
	env: Record<string, string | undefined>,
): string[] {
	const out: string[] = [];
	for (const [role, selector] of Object.entries(roles)) {
		// Selectors without a provider prefix name no provider to check.
		const i = selector.indexOf("/");
		if (i <= 0) continue;
		const provider = selector.slice(0, i).toLowerCase();
		// Several roles may share a provider — the first role names it.
		if (named.has(provider)) continue;
		named.add(provider);
		// openai-codex rides the OpenAI key.
		const envKey =
			env[`${provider.replaceAll("-", "_").toUpperCase()}_API_KEY`] ??
			(provider.startsWith("openai") ? env.OPENAI_API_KEY : undefined);
		if (active.has(provider) || (envKey !== undefined && envKey !== ""))
			continue;
		out.push(
			`No active sign-in for ${provider} (role ${role}): sign in under Settings - Provider sign-in, or set its API key in the environment.`,
		);
	}
	return out;
}

/** The release warnings of one project group: every release parked on settled findings for over
 *  an hour, so the next step stays visible on the board. */
function stalledReleaseWarnings(
	group: readonly WarnTask[],
	now: number,
): string[] {
	const out: string[] = [];
	for (const r of group) {
		if (
			r.cancelledAt !== null ||
			r.releaseVersion === null ||
			r.stage === "done"
		)
			continue;
		const held = releaseHeldMerges(group, r);
		if (held.length === 0) continue;
		const settled = findingsSettledAt(group, r);
		if (settled === null || now - settled <= 3_600_000) continue;
		out.push(
			`Release ${r.releaseVersion} holds ${held.length} merge${held.length === 1 ? "" : "s"} with every finding done (over an hour now): cancel the release card and create the release again so the fixes get reviewed.`,
		);
	}
	return out;
}

/** Release-stall warnings, per project: mergeHold compares versions within one project, so the
 *  loop runs per project, never on the flat cross-project list. */
function releaseStallWarnings(
	tasks: readonly WarnTask[],
	now: number,
): string[] {
	const out: string[] = [];
	const byProject = new Map<string, WarnTask[]>();
	for (const t of tasks) {
		const group = byProject.get(t.project);
		if (group === undefined) byProject.set(t.project, [t]);
		else group.push(t);
	}
	for (const group of byProject.values())
		out.push(...stalledReleaseWarnings(group, now));
	return out;
}

/**
 * Warnings the board must show the user (not only log): an unseeded agent layer, and a model
 * role whose provider has no active sign-in in the board store and no provider env key. Advisory
 * only; the state recomputes them on every poll, so a warning disappears by itself once fixed.
 * A provider that deadSignIns reports is skipped: its sign-in advisory already names the cause.
 */
export function boardWarnings(
	list: readonly SignIn[],
	roles: Readonly<Record<string, string>>,
	env: Record<string, string | undefined> = process.env,
	expiry: TokenExpiryView = tokenExpiryView(env),
	tasks: readonly WarnTask[] = [],
	now: number = Date.now(),
): string[] {
	if (!existsSync(join(agentDir(), "config.yml")))
		return [
			'The board\'s agent layer is not seeded: the board runs without rules and config.yml until a seed fills /etc/ottr/home (docs/WORKERS.md, "Seed the board config").',
		];
	// Roles are unreadable without config.yml, so the unseeded warning replaces the rest.
	const active = new Set(list.filter((s) => s.active).map((s) => s.provider));
	const named = new Set(deadSignIns(list, roles).map((d) => d.provider));
	const out = missingProviderWarnings(roles, active, named, env);
	// A release parked on finished findings still holds every other merge (mergeHold): warn
	// once the stall passes an hour, so the next step stays visible on the board.
	out.push(...releaseStallWarnings(tasks, now));
	// Token warnings come last; a token that is not in effect (not set / board unseeded) never warns.
	const tokenNow = new Date(now);
	for (const w of [
		tokenExpiryWarning(
			"board",
			expiry.board.tokenSet ? expiry.board.expiresAt : null,
			tokenNow,
		),
		tokenExpiryWarning(
			"seed",
			expiry.seed.seeded ? expiry.seed.expiresAt : null,
			tokenNow,
		),
	])
		if (w !== null) out.push(w);
	return out;
}

/** One worker's last sign-in self-report from the tick: its store's sign-ins, or error when the
 * store is missing or unreadable; `at` stamps the tick that fetched the report. */
export interface WorkerSignInReport {
	signIns: SignIn[] | null;
	error: string | null;
	at: number;
	/** OTTR-754: the worker's self-reported /tmp space; null when the worker omitted it (an
	 *  old worker) or statfs failed on its side. */
	tmp: TmpDiskSpace | null;
}

/** One worker's per-role warnings: the worker's store lacks a sign-in a model role uses, the
 *  board does not lend the provider, and no env key is set. */
function workerProviderWarnings(
	id: string,
	roles: Readonly<Record<string, string>>,
	active: ReadonlySet<string>,
	lent: ReadonlySet<string>,
	env: Record<string, string | undefined>,
): string[] {
	const out: string[] = [];
	const named = new Set<string>();
	for (const [role, selector] of Object.entries(roles)) {
		// Selectors without a provider prefix name no provider to check.
		const i = selector.indexOf("/");
		if (i <= 0) continue;
		const provider = selector.slice(0, i).toLowerCase();
		// Several roles may share a provider — the first names it.
		if (named.has(provider)) continue;
		named.add(provider);
		if (active.has(provider) || lent.has(provider)) continue;
		// openai-codex rides the OpenAI key.
		const envKey =
			env[`${provider.replaceAll("-", "_").toUpperCase()}_API_KEY`] ??
			(provider.startsWith("openai") ? env.OPENAI_API_KEY : undefined);
		if (envKey !== undefined && envKey !== "") continue;
		out.push(
			`Worker ${id} has no active sign-in for ${provider} (role ${role}): the workers' store (OTTR_AGENT_DB) lacks it, the board does not lend this provider, and no env key is set; seed the store from a host db that has the sign-in, or set its API key in the environment.`,
		);
	}
	return out;
}

/**
 * OTTR-548: warnings for workers whose own credential store lacks a sign-in a model role uses.
 * The board cannot see the worker store (R5-1), so each worker self-reports on GET /signins and
 * workerSignInTick caches the report; this reads only that cache. A report of `null` (an old
 * worker's 404, a failed fetch, a non-JSON answer) warns nothing — advisory, fail-soft. A report
 * with `signIns: null` (an unreadable store, the wrong-host-path OTTR_AGENT_DB mount) gets one
 * warning per worker, not one per provider. Otherwise the exemptions mirror boardWarnings: the
 * worker's own active row, a board sign-in lent for the provider (the lent env token covers
 * worker turns), or the provider's env key; several roles sharing a provider — the first names it.
 */
export function workerSignInWarnings(
	reports: ReadonlyMap<string, WorkerSignInReport | null>,
	boardList: readonly SignIn[],
	roles: Readonly<Record<string, string>>,
	env: Record<string, string | undefined> = process.env,
): string[] {
	const lent = new Set(
		boardList.filter((s) => s.active && s.lent).map((s) => s.provider),
	);
	const out: string[] = [];
	for (const [id, report] of reports) {
		if (report === null) continue; // Unknown worker state warns nothing.
		if (report.signIns === null) {
			out.push(
				`Worker ${id} has no readable credential store (${report.error}); worker turns keep their own credential, so sign-ins that the board does not lend are missing (OTTR_AGENT_DB; docs/WORKERS.md, Provider sign-in).`,
			);
			continue;
		}
		const active = new Set(
			report.signIns.filter((s) => s.active).map((s) => s.provider),
		);
		out.push(...workerProviderWarnings(id, roles, active, lent, env));
	}
	return out;
}

// OTTR-754: the /tmp free-space rule in one place. A runner whose /tmp holds less than
// 1 GiB or less than 5% of its size is too full for a new turn: apt, mktemp, and the
// run scripts all write /tmp, and a disk-full failure names none of this.
export const TMP_MIN_FREE_BYTES = 1024 ** 3;
export const TMP_MIN_FREE_RATIO = 0.05;

/** True when /tmp is below the free-space limit: under the byte floor OR under the ratio. */
export function tmpFull(freeBytes: number, totalBytes: number): boolean {
	return (
		freeBytes < TMP_MIN_FREE_BYTES ||
		freeBytes / totalBytes < TMP_MIN_FREE_RATIO
	);
}

/**
 * OTTR-754: one bell warning per runner whose /tmp is below the free-space limit — worker
 * hostnames from the sign-ins tick's cache, the local runner from a statfs probe. Advisory:
 * recompute per poll, so the warning disappears by itself once space returns. A report of
 * null (an old worker, a failed fetch) warns nothing, like workerSignInWarnings.
 */
export function workerTmpWarnings(
	reports: ReadonlyMap<string, WorkerSignInReport | null>,
	localSpace: TmpDiskSpace | null,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const [host, report] of reports) {
		if (!report?.tmp) continue; // Unknown /tmp space warns nothing.
		if (!tmpFull(report.tmp.freeBytes, report.tmp.totalBytes)) continue;
		const line = `/tmp of ${host} is full (${formatBytes(report.tmp.freeBytes)})`;
		if (!seen.has(line)) {
			seen.add(line);
			out.push(line);
		}
	}
	if (
		localSpace !== null &&
		tmpFull(localSpace.freeBytes, localSpace.totalBytes)
	) {
		const line = `/tmp of local is full (${formatBytes(localSpace.freeBytes)})`;
		if (!seen.has(line)) out.push(line);
	}
	return out;
}
/**
 * Boot reconcile of the layer in-use registries (docs/specs/agent-layer-switch.md, "Record"):
 * rebuilds each home's `<home>/.alate/in-use.json` from `openLayers`, the layer ids the stores'
 * open turns still pin. A home keeps only the ids whose layer folder exists there: alate's
 * clean-up never deletes a layer a crashed-but-live turn reads, and an id whose folder is
 * already gone stops blocking it. Never throws: `rebuildLayerUse` is best-effort, and a home
 * without a `.alate` dir (no layer was ever installed) is left alone.
 */
export function reconcileLayerUse(
	openLayers: string[],
	// process.env.HOME first (loginStores() pattern): os.homedir() caches under Bun, so a
	// retargeted $HOME would never reach the reconcile — in tests and in a future shell.
	homes: readonly string[] = [
		process.env.HOME?.trim() ? resolve(process.env.HOME) : homedir(),
		boardOmpHome(),
	],
): void {
	for (const home of new Set(homes)) {
		if (!existsSync(join(home, ".alate"))) continue;
		const ids = openLayers.filter(
			(id) =>
				basename(id) === id &&
				id !== "." &&
				id !== ".." &&
				existsSync(join(home, ".alate", "layers", id)),
		);
		rebuildLayerUse(home, ids);
	}
}

/** Why an updates row cannot file a card (U5/U6), or the row that can. */
type UpdateFiling =
	| { rec: UpdateRecord; blocked: null }
	| { rec: null; blocked: { status: number; error: string } };

/** Shared guards for filing a card from an updates row: no updates loaded, unknown id, row
 *  class mismatch (`removed` selects: update cards refuse removed rows, remove cards refuse
 *  everything else), foreign updater. */
function updateFiling(
	loaded: {
		checkedAt: string;
		updates: UpdateRecord[];
	} | null,
	id: string,
	removed: boolean,
): UpdateFiling {
	if (loaded === null)
		return { rec: null, blocked: { status: 409, error: "no updates loaded" } };
	const rec = loaded.updates.find((u) => u.id === id);
	if (rec === undefined)
		return {
			rec: null,
			blocked: { status: 400, error: `unknown update id: ${id}` },
		};
	if ((rec.removed === true) !== removed)
		return {
			rec: null,
			blocked: {
				status: 400,
				error: removed
					? `not a removed update: ${id}`
					: `removed update files no card: ${id}`,
			},
		};
	// Another updater owns this item; the panel offers no actions on it (U5).
	if (rec.managedBy !== undefined)
		return {
			rec: null,
			blocked: { status: 400, error: `${id} is managed by ${rec.managedBy}` },
		};
	return { rec, blocked: null };
}

/** A trimmed board-home file, or null when unreadable. */
function readBoardHomeFile(name: string): string | null {
	try {
		return readFileSync(join(dirname(boardOmpHome()), name), "utf8").trim();
	} catch {
		return null;
	}
}

/** The sanitized restart-wait record fields, or null when any field fails. */
function sanitizeRestartWait(record: unknown): {
	commit: string;
	since: number;
	commits: number;
	turns: string[];
} | null {
	if (record === null || typeof record !== "object") return null;
	const r = record as Record<string, unknown>;
	const commit = r.commit;
	const since = r.since;
	const commits = r.commits;
	const rawTurns = r.turns;
	if (
		typeof commit !== "string" ||
		!/^[0-9a-f]{7,40}$/.test(commit) ||
		typeof since !== "number" ||
		!Number.isInteger(since) ||
		since <= 0 ||
		typeof commits !== "number" ||
		!Number.isInteger(commits) ||
		commits < 0 ||
		commits > 1_000_000 ||
		!Array.isArray(rawTurns) ||
		rawTurns.length > 20
	)
		return null;
	const turns: string[] = [];
	for (const t of rawTurns) {
		if (typeof t !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(t))
			continue;
		turns.push(t);
	}
	return { commit, since, commits, turns };
}

/** The recreate command the notice names: the recorded one when it sanitizes, else the plain
 *  form (a checkout with the default compose file and .env). Host-written file content, so it
 *  never reaches the UI with control characters or an unbounded length. */
function restartWaitCommand(r: Record<string, unknown>): string {
	const rawCommand = typeof r.command === "string" ? r.command.trim() : "";
	return rawCommand !== "" &&
		rawCommand.length <= 300 &&
		!/[\p{Cc}]/u.test(rawCommand)
		? rawCommand
		: "docker compose up -d --no-deps --wait server";
}

/**
 * Validates every project-setting field in the body into a patch of only the present keys;
 * a 400 Response on the first bad one. Pure: the caller decides when (and on which store)
 * the patch lands.
 */
function parseSettingsPatch(
	body: Record<string, unknown>,
): Partial<ProjectSettings> | Response {
	const patch: Partial<ProjectSettings> = {};
	// The parsers run in the field order the manual validation had; the first bad field answers.
	for (const parse of settingParsers) {
		const bad = parse(body, patch);
		if (bad !== null) return bad;
	}
	return patch;
}

/** One settings field's validator: appends present keys to the patch, or a 400 Response. */
type FieldParser = (
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
) => Response | null;

/** Module-level JSON response for the settings field parsers. Their error bodies are tiny
 * (one line of text), so createApp's gzip path can never trigger for them; the headers stay
 * the same. createApp declares its own richer json() that shadows this one inside it. */
function json(
	v: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(v), {
		status,
		headers: {
			"Content-Type": "application/json",
			Vary: "Accept-Encoding",
			Connection: "close",
			...headers,
		},
	});
}

function parseMaxParallel(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const mp = body.maxParallel;
	if (mp === undefined) return null;
	if (
		mp !== null &&
		(typeof mp !== "number" || !Number.isInteger(mp) || mp < 1)
	) {
		return json(
			{ error: "maxParallel must be a positive integer or null" },
			400,
		);
	}
	patch.maxParallel = mp;
	return null;
}

function parseCopyExtra(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const ce = body.copyExtra;
	if (ce === undefined) return null;
	if (!Array.isArray(ce) || ce.length > 20)
		return json(
			{ error: "copyExtra must be an array of at most 20 paths" },
			400,
		);
	const extra: string[] = [];
	for (const item of ce) {
		if (typeof item !== "string")
			return json({ error: "copyExtra entries must be strings" }, 400);
		const reason = validateCopyPath(item);
		if (reason) return json({ error: reason }, 400);
		extra.push(item);
	}
	patch.copyExtra = extra;
	return null;
}

function parseDisplayName(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const dn = body.displayName;
	if (dn === undefined) return null;
	if (dn !== null && typeof dn !== "string")
		return json({ error: "displayName must be a string or null" }, 400);
	const name = typeof dn === "string" ? dn.trim() : "";
	if (name.length > 60 || /[\p{Cc}]/u.test(name)) {
		return json(
			{ error: "displayName must be one line of at most 60 characters" },
			400,
		);
	}
	patch.displayName = name === "" ? null : name;
	return null;
}

function parseIconText(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const ix = body.iconText;
	if (ix === undefined) return null;
	if (ix !== null && typeof ix !== "string")
		return json({ error: "iconText must be a string or null" }, 400);
	const marker = typeof ix === "string" ? ix.trim() : "";
	if (marker.length > 4 || /[\p{Cc}]/u.test(marker)) {
		return json({ error: "iconText must be at most 4 characters" }, 400);
	}
	patch.iconText = marker === "" ? null : marker;
	return null;
}

function parseTaskIdPrefix(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const tp = body.taskIdPrefix;
	if (tp === undefined) return null;
	if (tp !== null && typeof tp !== "string")
		return json({ error: "taskIdPrefix must be a string or null" }, 400);
	const prefix = typeof tp === "string" ? tp.trim().toUpperCase() : "";
	if (prefix !== "" && !/^[A-Z0-9]{1,8}$/.test(prefix)) {
		return json(
			{ error: "taskIdPrefix must be 1 to 8 letters and digits" },
			400,
		);
	}
	patch.taskIdPrefix = prefix === "" ? null : prefix;
	return null;
}

/** Shape only: whether the named connection exists is checked by the settings route. */
function parseJiraSettings(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const c = body.jiraConnection;
	if (c !== undefined) {
		if (c !== null && (typeof c !== "string" || c === "" || c.length > 100))
			return json(
				{ error: "jiraConnection must be a connection name or null" },
				400,
			);
		patch.jiraConnection = c;
	}
	const q = body.jiraLastJql;
	if (q !== undefined) {
		if (q !== null && (typeof q !== "string" || q.length > 2000))
			return json(
				{
					error:
						"jiraLastJql must be a string of at most 2000 characters or null",
				},
				400,
			);
		patch.jiraLastJql = q;
	}
	return null;
}

function parseReleaseCommand(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const rc = body.releaseCommand;
	if (rc === undefined) return null;
	if (rc !== null && typeof rc !== "string")
		return json({ error: "releaseCommand must be a string or null" }, 400);
	const command = typeof rc === "string" ? rc.trim() : "";
	if (command.length > 300 || /[\p{Cc}]/u.test(command)) {
		return json(
			{
				error: "releaseCommand must be one line of at most 300 characters",
			},
			400,
		);
	}
	patch.releaseCommand = command === "" ? null : command;
	return null;
}

function parseTargetBranch(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const tb = body.targetBranch;
	if (tb === undefined) return null;
	if (tb !== null && typeof tb !== "string")
		return json({ error: "targetBranch must be a string or null" }, 400);
	const branch = typeof tb === "string" ? tb.trim() : "";
	if (
		branch.length > 200 ||
		/[\p{Cc}\s]/u.test(branch) ||
		branch.startsWith("-") ||
		branch.includes("..") ||
		branch.startsWith("origin/")
	) {
		return json(
			{
				error:
					"targetBranch must be a bare git branch name of at most 200 characters",
			},
			400,
		);
	}
	patch.targetBranch = branch === "" ? null : branch;
	return null;
}

function parseArchReviewCap(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const cap = body.archReviewCap;
	if (cap === undefined) return null;
	if (
		typeof cap !== "number" ||
		!Number.isInteger(cap) ||
		cap < 1 ||
		cap > 10000
	) {
		return json(
			{ error: "archReviewCap must be an integer between 1 and 10000" },
			400,
		);
	}
	patch.archReviewCap = cap;
	return null;
}

function parseMaxImages(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const mi = body.maxImages;
	if (mi === undefined) return null;
	if (typeof mi !== "number" || !Number.isInteger(mi) || mi < 1) {
		return json({ error: "maxImages must be an integer of at least 1" }, 400);
	}
	patch.maxImages = mi;
	return null;
}

function parseKeptWorktreeDays(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const kwd = body.keptWorktreeDays;
	if (kwd === undefined) return null;
	if (
		typeof kwd !== "number" ||
		!Number.isInteger(kwd) ||
		kwd < 0 ||
		kwd > 365
	) {
		return json(
			{ error: "keptWorktreeDays must be an integer between 0 and 365" },
			400,
		);
	}
	patch.keptWorktreeDays = kwd;
	return null;
}

/** The boolean settings, in field order. U7 parks merge commits of update cards until a
 *  reply approves them (holdUpdateMerges); OTTR-689 holds fork-born cards the same way
 *  (forkMergeHold). */
const BOOLEAN_SETTING_FIELDS = [
	"autoTend",
	"holdUpdateMerges",
	"forkMergeHold",
	"retroFilter",
	"forkResearch",
	"trendingScout",
	"prReviews",
	"prReviewNotify",
	"prReviewApprove",
	"prMode",
	"issueWatch",
	"ompWatch",
	"microVm",
	"pushSyncCommits",
	"setupChecklist",
] as const;

function parseBooleanSettings(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	for (const key of BOOLEAN_SETTING_FIELDS) {
		const v = body[key];
		if (v === undefined) continue;
		if (typeof v !== "boolean")
			return json({ error: `${key} must be a boolean` }, 400);
		patch[key] = v;
	}
	// retro is not a stored setting: the route maps it onto retroSince against the
	// CURRENT stored value (re-saving while on must not move the mark). Validate only.
	if (body.retro !== undefined && typeof body.retro !== "boolean")
		return json({ error: "retro must be a boolean" }, 400);
	return null;
}

function parseAutoTendLimit(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const atl = body.autoTendLimit;
	if (atl === undefined) return null;
	if (
		typeof atl !== "number" ||
		!Number.isInteger(atl) ||
		atl < 0 ||
		atl > 1000
	) {
		return json(
			{
				error: "autoTendLimit must be an integer between 0 and 1000",
			},
			400,
		);
	}
	patch.autoTendLimit = atl;
	return null;
}

function parseTendChurnGlobs(
	body: Record<string, unknown>,
	patch: Partial<ProjectSettings>,
): Response | null {
	const tcg = body.tendChurnGlobs;
	if (tcg === undefined) return null;
	if (!Array.isArray(tcg) || tcg.length > 50)
		return json(
			{ error: "tendChurnGlobs must be an array of at most 50 glob patterns" },
			400,
		);
	const globs: string[] = [];
	for (const item of tcg) {
		if (
			typeof item !== "string" ||
			item.length < 1 ||
			item.length > 200 ||
			/[\p{Cc}]/u.test(item)
		)
			return json(
				{
					error: "tendChurnGlobs must be an array of at most 50 glob patterns",
				},
				400,
			);
		globs.push(item);
	}
	patch.tendChurnGlobs = globs;
	return null;
}

const settingParsers: FieldParser[] = [
	parseMaxParallel,
	parseCopyExtra,
	parseDisplayName,
	parseIconText,
	parseTaskIdPrefix,
	parseReleaseCommand,
	parseTargetBranch,
	parseArchReviewCap,
	parseMaxImages,
	parseKeptWorktreeDays,
	parseBooleanSettings,
	parseAutoTendLimit,
	parseTendChurnGlobs,
	parseJiraSettings,
];

/** The serve options createApp hands to Bun.serve; the shape tests spread into their own servers. */
export type AppServeOptions = ReturnType<typeof createApp>["serveOptions"];

/** OTTR-488: card-view steps — the stored value, except legacy 'unknown' rows resolve against the stored report at read time (no row rewrite). 'unknown' in a view means quiet. */
function viewSteps(t: Pick<Task, "steps" | "report">): Task["steps"] {
	return t.steps !== "unknown"
		? t.steps
		: t.report !== null && recommendsSteps(t.report)
			? "yes"
			: "unknown";
}

/** OTTR-566: epoch ms before which every done card counts as read (module-level helper; see createApp). A missing/corrupt row restamps and persists the fresh stamp. */
function initialSeenDoneSince(deps: AppDeps): number {
	const storedDoneSince: unknown = deps.gstore.get<unknown>("seen_done_since");
	const seenDoneSince =
		typeof storedDoneSince === "number" && Number.isFinite(storedDoneSince)
			? storedDoneSince
			: Date.now();
	if (seenDoneSince !== storedDoneSince)
		deps.gstore.set("seen_done_since", seenDoneSince);
	return seenDoneSince;
}

/** Sorted task ids marked as read; missing/corrupt row = empty. */
function loadSeenFrom(deps: AppDeps): string[] {
	const parsed: unknown = deps.gstore.get<unknown>("seen_answers");
	if (!Array.isArray(parsed)) return [];
	return [
		...new Set(parsed.filter((s): s is string => typeof s === "string")),
	].sort();
}

function saveSeenTo(deps: AppDeps, ids: string[]): void {
	deps.gstore.set("seen_answers", [...new Set(ids)].sort());
}

/** Dependency seams used by createApp, with their production defaults; one object so the
 * destructuring at createApp stays a single line. */
function createAppNetworkDefaults(deps: AppDeps): {
	gh: GhFn;
	latestReleaseOf: (repo: string) => Promise<LatestGhRelease | null>;
	githubAppFetch: (url: string, init?: RequestInit) => Promise<Response>;
	rerunFetch: typeof fetch;
} {
	return {
		gh: deps.gh ?? runGh,
		// The chip's and the release dialog's latest-GitHub-release fact; the seam keeps tests off gh.
		latestReleaseOf: deps.latestRelease ?? cachedLatestGhRelease,
		// GitHub App mint and review post; the seam keeps both off the real network in tests.
		// Wrapped with the bounded GitHub retry: the mint's GETs retry a 429/5xx, the
		// review POST passes through untouched (a POST that creates something never retries).
		githubAppFetch: withGithubRetry(deps.githubAppFetch ?? noRedirectFetch),
		// Re-run-failed-jobs GitHub API call; the seam keeps tests off the real network.
		rerunFetch: deps.rerunFetch ?? fetch,
	};
}

/** Clock and logging seams for createApp, with their production defaults. */
function createAppClockDefaults(deps: AppDeps): {
	now: () => number;
	slowApiMs: number;
} {
	return {
		// Idle clock (docs/specs/mutation-delta.md §7): only the idle-review logic reads it,
		// and tests inject a fixed clock. It initializes at createApp, so a board restart
		// counts as input and never starts a review right after boot.
		now: deps.now ?? Date.now,
		// OTTR-715: the slow-request log ceiling (see api()).
		slowApiMs: deps.slowApiMs ?? 500,
	};
}

/** Path and ssh seams for createApp, with their production defaults. */
function createAppPathDefaults(deps: AppDeps): {
	sshDir: string;
	workersHome: string;
	keyscan: Keyscan;
} {
	return {
		// Server-only ssh material: a data dir outside every checkout.
		sshDir: deps.sshDir ?? defaultSshDir(),
		// Base home whose .ottr/workers folders hold the env.txt name lists: the board's
		// server-only home, never the turn-writable shared one (R5-1; tests inject it).
		workersHome: deps.workersHome ?? boardOmpHome(),
		keyscan: deps.keyscan ?? realKeyscan,
	};
}

/** Boot reconcile (docs/specs/agent-layer-switch.md, "Record"): the stores' open turns
 * (turn rows without ended_at) decide which layer folders stay registered as in use,
 * so alate's clean-up never deletes a layer a crashed-but-live turn reads. Fail-soft:
 * a broken store or registry only degrades clean-up, it never breaks the boot. */
function bootReconcileLayers(deps: AppDeps): void {
	try {
		reconcileLayerUse(
			[...deps.projects.values()].flatMap((e) => e.store.listOpenTurnLayers()),
		);
	} catch (err) {
		console.warn(`layers: in-use reconcile failed: ${errmsg(err)}`);
	}
}

/** OTTR-781: head-line prefix of a Dependabot card prompt, e.g.
 * `Dependabot PR #58 (https://github.com/acme/repo/pull/58)`, else null: the first line
 * must match the exact format with a positive safe integer n written without leading
 * zeros. Prompt text is untrusted; the prefix is only ever compared against other
 * cards' first lines, never fetched. Pure. */
export function dependabotHeadPrefix(line: string): string | null {
	const m = /^Dependabot PR #(\d+) \(([^)\s]+)\)/.exec(line);
	if (m === null) return null;
	const digits = m[1];
	const n = Number(digits);
	if (!Number.isSafeInteger(n) || n < 1 || digits !== String(n) || m[2] === "")
		return null;
	return `Dependabot PR #${n} (${m[2]})`;
}

export function createApp(deps: AppDeps) {
	const { gh, latestReleaseOf, githubAppFetch, rerunFetch } =
		createAppNetworkDefaults(deps);
	const { now, slowApiMs } = createAppClockDefaults(deps);
	let lastInputAt = now();
	const prod = deps.prod === true;
	const { sshDir, workersHome, keyscan } = createAppPathDefaults(deps);
	const ambientHelpers = readAmbientHelpers();
	// Boot reconcile (docs/specs/agent-layer-switch.md, "Record"): the stores' open turns
	// (turn rows without ended_at) decide which layer folders stay registered as in use,
	// so alate's clean-up never deletes a layer a crashed-but-live turn reads. Fail-soft:
	// a broken store or registry only degrades clean-up, it never breaks the boot.
	bootReconcileLayers(deps);
	// Sorted task ids marked as read; missing/corrupt row = empty. The bodies live at
	// module level (loadSeenFrom/saveSeenTo): the store is the only state they touch.
	const loadSeen = (): string[] => loadSeenFrom(deps);
	const saveSeen = (ids: string[]): void => saveSeenTo(deps, ids);

	const seenDoneSince = initialSeenDoneSince(deps);

	/** Read-mark keys a mark can stick to right now, by the same rule the state frame
	 * ships (stateResponse): plain ids of question-only answered cards, pr_review cards and
	 * done research cards whose report resolves to a steps value, plus (OTTR-566, the rail's
	 * unread-done dot) a per-completion key `<id>@<doneAt>` for every non-retro card done after
	 * the seenDoneSince baseline — a re-done card gets a new key, so its old one decays. Marks a
	 * client sends for anything else are stale — a pre-server-sync tab imported marks for cards
	 * it merely had open — so /api/seen drops them and the store decays instead of poisoning the board. */
	/** Whether a card's plain id is a read-mark key right now: pr_review, question-only answered,
	 *  or done research whose report resolves to a steps value (see seenableIds). */
	function cardSeenable(t: ListedTask, e: Entry): boolean {
		return (
			t.cancelledAt === null &&
			(t.kind === "pr_review" ||
				(t.stage === "done" &&
					!isRetro(t) &&
					answeredCard(e.store.listTurns(t.id))) ||
				(t.research &&
					t.stage === "done" &&
					t.report !== null &&
					viewSteps(t) !== "unknown"))
		);
	}

	/** The rail's unread-done key for a card done after the seenDoneSince baseline, else null
	 *  (see seenableIds). */
	function doneKeyOf(t: ListedTask): string | null {
		if (
			t.cancelledAt !== null ||
			t.stage !== "done" ||
			isRetro(t) ||
			t.doneAt === null ||
			t.doneAt <= seenDoneSince
		)
			return null;
		return doneReadKey({ id: t.id, doneAt: t.doneAt });
	}

	/** Adds one store's read-mark keys (see seenableIds); throws so the caller's fail-soft
	 *  catch can skip a sick store. */
	function addStoreSeenable(ids: Set<string>, e: Entry): void {
		for (const t of e.store.listTasks()) {
			if (cardSeenable(t, e)) ids.add(t.id);
			const k = doneKeyOf(t);
			if (k !== null) ids.add(k);
		}
	}

	function seenableIds(): Set<string> {
		const ids = new Set<string>();
		for (const e of deps.projects.values()) {
			try {
				addStoreSeenable(ids, e);
			} catch (err) {
				// A sick store contributes nothing, like in stateResponse.
				logStoreError(e.store.name, err);
			}
		}
		return ids;
	}
	/** Existing VAPID keys, generating and persisting them on the first push path (never at boot). */
	let vapidApplied = false;
	function ensureVapid(): {
		publicKey: string;
		privateKey: string;
		subject: string;
	} {
		if (vapid === null) {
			const keys = generateVAPIDKeys();
			vapid = { ...keys, subject: PUSH_SUBJECT };
			// ADR-0011 recovery: rebind, never delete. After a pair change every
			// pre-existing subscription binds to the outgoing key — bound subs by
			// their stamp, legacy subs because they could only have been created
			// while the previous pair was current. Rebinding keeps the per-sub
			// stale rule covering both and never deletes the evidence a
			// recovering device needs.
			const previous =
				deps.gstore.get<string | null>("push_vapid_key") ??
				previousVapidPublicKey;
			const subs = loadSubs(deps.gstore);
			if (
				previous !== null &&
				previous !== vapid.publicKey &&
				subs.some((s) => s.vapidPublicKey === undefined)
			)
				saveSubs(
					deps.gstore,
					subs.map((s) =>
						s.vapidPublicKey === undefined
							? { ...s, vapidPublicKey: previous }
							: s,
					),
				);
			saveConfig();
		}
		// Recording the load path too: an upgraded board's first ensure records the
		// stored pair's key, so a later recovery can rebind subs created before
		// the upgrade.
		if (deps.gstore.get<string | null>("push_vapid_key") !== vapid.publicKey)
			deps.gstore.set("push_vapid_key", vapid.publicKey);
		// Keys loaded from config at boot skip the branch above, but web-push's module state
		// is per-process: without this, sends go out unsigned and FCM answers 401. The
		// constant subject, not the stored one, heals configs saved before R2-3 (Apple
		// answers 403 BadJwtToken for mailto:...@localhost); the subject is not bound to subs.
		if (!vapidApplied) {
			setVapidDetails(PUSH_SUBJECT, vapid.publicKey, vapid.privateKey);
			vapidApplied = true;
		}
		return vapid;
	}
	// --- Alert push (OTTR-494): the server decides every OS-level event, Web Push delivers it ---
	/** Card facts of the last published frame: the event diff's baseline. Null until the first
	 * publish, which alerts nothing (a restart must not replay the whole board). */
	let lastAlertInputs: AlertCardInput[] | null = null;
	/** Alerts pushed and not yet retracted: what a cleared cause or an ack closes on the devices.
	 * Persisted (GlobalStore `notify_live_alerts`) so a restart can still retract what the
	 * devices show; the first frame after boot clears what resolved while the board was down. */
	const ALERT_STATE_KEY = "notify_live_alerts";
	/** Apple endpoint → retraction bounds that wait for the next alert push to that device:
	 * Apple never receives a data-only clear (see isApplePush). Persisted with the registry. */
	let appleClear = new Map<string, ClearBound>();
	/** Endpoint → per-class sequence number of the last alert payload sent to that device. A
	 * retraction carries the number current when it was decided, so it can only ever close
	 * notifications shown before it, never a later alert that overtook it. Persisted. */
	let alertSeqs = new Map<string, Record<AlertClass, number>>();
	let liveAlerts: LiveAlert[] = [];

	/** A valid alert class name. */
	const isClass = (c: unknown): c is AlertClass =>
		typeof c === "string" && (ALERT_CLASSES as readonly string[]).includes(c);
	/** A {class: number} object with only valid entries. */
	const bounds = (v: unknown): ClearBound => {
		const out: ClearBound = {};
		if (typeof v !== "object" || v === null) return out;
		for (const [c, n] of Object.entries(v))
			if (isClass(c) && typeof n === "number") out[c] = n;
		return out;
	};
	loadAlertState();
	/** The stored push endpoints of one live alert; a malformed row contributes nothing. */
	function endpointList(v: unknown): string[] {
		return Array.isArray(v)
			? v.filter((e): e is string => typeof e === "string")
			: [];
	}
	/** One stored live alert, or nothing when the row is malformed. */
	function liveAlertOf(a: unknown): LiveAlert[] {
		if (typeof a !== "object" || a === null) return [];
		const x = a as Record<string, unknown>;
		return typeof x.key === "string" &&
			isClass(x.class) &&
			typeof x.taskId === "string" &&
			typeof x.project === "string"
			? [
					{
						key: x.key,
						sent: typeof x.sent === "string" ? x.sent : x.key,
						class: x.class,
						taskId: x.taskId,
						project: x.project,
						to: endpointList(x.to),
					},
				]
			: [];
	}
	/** Restores the pending Apple clears; entries with no valid bound are skipped. */
	function restoreAppleClear(v: unknown): void {
		if (typeof v !== "object" || v === null) return;
		for (const [endpoint, b] of Object.entries(v)) {
			const parsed = bounds(b);
			if (Object.keys(parsed).length > 0) appleClear.set(endpoint, parsed);
		}
	}
	/** Restores the per-endpoint sequence numbers; unknown classes start at 0. */
	function restoreSeqs(v: unknown): void {
		if (typeof v !== "object" || v === null) return;
		for (const [endpoint, s] of Object.entries(v))
			alertSeqs.set(endpoint, {
				request: 0,
				error: 0,
				complete: 0,
				...bounds(s),
			});
	}
	/** Restores the registries from one stored alert-state row. */
	function restoreAlertRow(raw: unknown): void {
		if (typeof raw !== "object" || raw === null) return;
		const r = raw as {
			alerts?: unknown;
			appleClear?: unknown;
			seqs?: unknown;
		};
		if (Array.isArray(r.alerts)) liveAlerts = r.alerts.flatMap(liveAlertOf);
		restoreAppleClear(r.appleClear);
		restoreSeqs(r.seqs);
	}
	/** Restores the live-alert registry, the pending Apple clears and the sequence numbers from the stored row; malformed rows contribute nothing. */
	function loadAlertState(): void {
		restoreAlertRow(deps.gstore.get<unknown>(ALERT_STATE_KEY));
	}
	/** Writes the registry, the pending Apple clears and the sequence numbers; drops entries of
	 * gone devices. */
	function saveAlertState(): void {
		const endpoints = new Set(loadSubs(deps.gstore).map((s) => s.endpoint));
		appleClear = new Map(
			[...appleClear].filter(
				([e, b]) => endpoints.has(e) && Object.keys(b).length > 0,
			),
		);
		alertSeqs = new Map([...alertSeqs].filter(([e]) => endpoints.has(e)));
		deps.gstore.set(ALERT_STATE_KEY, {
			alerts: liveAlerts,
			appleClear: Object.fromEntries(appleClear),
			seqs: Object.fromEntries(alertSeqs),
		});
	}
	/** Board tab id → epoch ms of its last focus heartbeat (POST /api/presence). Map order is
	 * recency (a heartbeat re-inserts), so the cap drops the stalest tab first. */
	const focusAt = new Map<string, number>();
	const PRESENCE_TABS_MAX = 200;

	/** Acknowledged inbox keys: shared by every browser, read by the service worker. */
	function loadInboxSeen(): string[] {
		return normalizeSeen(deps.gstore.get<unknown>("inbox_seen"));
	}

	/** Projects whose alerts never push (the bell still lights); missing/corrupt row = none. */
	function loadMuted(): string[] {
		const raw: unknown = deps.gstore.get<unknown>("notify_muted_projects");
		if (!Array.isArray(raw)) return [];
		return [...new Set(raw.filter((s): s is string => typeof s === "string"))];
	}

	/** The card's newest settled turn as Error facts: one indexed row per card and frame, so a
	 * turn that starts and fails between two frames is never missed. A turn failed by the
	 * runner's own rule (runner.ts classify): a bad exit, unless the run reported a terminal
	 * outcome (ready, answered, integrated) — a needs_you report followed by a crash still
	 * failed. A clean reported hold stores its reason in turns.error too (turn.ts finishTurn);
	 * that is a Request, not an Error. A deliberate cancel (error "cancelled", see
	 * ProjectStore.finishTurn) is no failure either. A sick store keeps `fallback`. */
	function latestTurnError(
		project: string,
		id: string,
		fallback: Pick<AlertCardInput, "errorTurn" | "errorText"> | undefined,
	): Pick<AlertCardInput, "errorTurn" | "errorText"> {
		const none = { errorTurn: null, errorText: null };
		const e = deps.projects.get(project);
		if (e === undefined) return none;
		try {
			const turn = e.store.lastSettledTurn(id);
			const failed =
				turn !== null &&
				turn.error !== null &&
				turn.error !== "cancelled" &&
				turn.exitCode !== 0 &&
				(turn.outcome === null || turn.outcome === "needs_you");
			return failed
				? { errorTurn: String(turn.id), errorText: turn.error }
				: none;
		} catch (err) {
			logStoreError(e.store.name, err);
			return fallback ?? none;
		}
	}

	/** The event diff's view of the frame's cards. */
	function alertInputs(
		tasks: readonly TaskCard[],
		prev: readonly AlertCardInput[] | null,
	): AlertCardInput[] {
		const before = new Map((prev ?? []).map((p) => [p.id, p]));
		return tasks.map((t) => {
			const err = latestTurnError(t.project, t.id, before.get(t.id));
			return {
				id: t.id,
				project: t.project,
				title: t.title,
				sessionTitle: t.sessionTitle,
				state: t.state,
				stage: t.stage,
				kind: t.kind,
				asked: t.asked,
				answered: t.answered,
				needsReason: t.needsReason,
				summary: t.summary,
				errorTurn: err.errorTurn,
				errorText: err.errorText,
				prDraft: t.prOccurrence?.draft ?? null,
				prComments: t.prOccurrence?.comments ?? null,
				cancelled: t.cancelledAt !== null,
			};
		});
	}

	/** Drops task-derived seen keys whose occurrence is over: a `task:` key no card's current
	 * needs_you entry carries, `done:<id>` of a card gone or out of done, `error:<id>:<turn>` of a
	 * card gone or past that turn, and a `pr:<id>:<stamp>` key whose stamp is read or whose card
	 * is gone. Notice and crit keys stay; the client drops those itself. */
	function pruneInboxSeen(
		seen: readonly string[],
		inputs: readonly AlertCardInput[],
	): string[] {
		const byId = new Map<string, AlertCardInput>();
		const entryKeys = new Set<string>();
		for (const c of inputs) {
			byId.set(c.id, c);
			if (c.state === "needs_you") entryKeys.add(taskEntryKey(c));
		}
		/** Whether a `pr:<id>:<stamp>` key's stamp is still the card's unseen comment wave. */
		function prKeyLive(k: string): boolean {
			const rest = k.slice("pr:".length);
			const cut = rest.lastIndexOf(":");
			const c = cut > 0 ? byId.get(rest.slice(0, cut)) : undefined;
			return (
				c !== undefined &&
				c.prComments !== null &&
				k === `pr:${c.id}:${c.prComments}`
			);
		}
		/** Whether a seen key still has its occurrence live: a `task:` key a current needs_you
		 * entry carries, `done:<id>` of a card in done, `error:<id>:<turn>` of a card on that
		 * turn. Notice and crit keys stay; the client drops those itself. */
		function inboxKeyLive(k: string): boolean {
			if (k.startsWith("task:")) return entryKeys.has(k);
			if (k.startsWith("done:"))
				return byId.get(k.slice("done:".length))?.stage === "done";
			if (k.startsWith("error:")) {
				const rest = k.slice("error:".length);
				const cut = rest.lastIndexOf(":");
				return (
					cut > 0 &&
					byId.get(rest.slice(0, cut))?.errorTurn === rest.slice(cut + 1)
				);
			}
			if (k.startsWith("pr:")) return prKeyLive(k);
			return true;
		}
		return seen.filter(inboxKeyLive);
	}

	/** Takes `removed` out of the live registry and returns it; tagsToClear turns it into each
	 * device's class tags. */
	function retire(removed: readonly LiveAlert[]): readonly LiveAlert[] {
		if (removed.length === 0) return removed;
		const keys = new Set(removed.map((a) => a.key));
		liveAlerts = liveAlerts.filter((a) => !keys.has(a.key));
		return removed;
	}

	/** The data-only retraction for a device with no live alerts; an empty list when nothing
	 *  to clear. Apple's push service never gets a data-only push, so its bounds wait in
	 *  `appleClear` (merged by maximum) and ride on the next alert sent to that device. */
	function clearPayloadFor(
		sub: PushSub,
		apple: boolean,
		tags: AlertClass[],
		upTo: ClearBound,
	): Array<AlertPayload | ClearPayload> {
		if (tags.length === 0) return [];
		if (!apple) return [{ type: "clear", tags, upTo }];
		appleClear.set(sub.endpoint, upTo);
		return [];
	}

	/** One device's payloads for a pass: its alerts (each numbered and carrying the
	 * retraction), else a data-only retraction. Each retracted class is bounded by the device's
	 * sequence number at decision time, so the service worker closes only notifications shown
	 * before it: a retraction riding on a delayed payload never closes a newer alert. */
	function batchFor(
		sub: PushSub,
		alerts: readonly AlertPayload[],
		clear: readonly AlertClass[],
	): Array<AlertPayload | ClearPayload> {
		const apple = isApplePush(sub.endpoint);
		const seqs = alertSeqs.get(sub.endpoint) ?? {
			request: 0,
			error: 0,
			complete: 0,
		};
		const upTo: ClearBound = apple
			? { ...(appleClear.get(sub.endpoint) ?? {}) }
			: {};
		for (const c of clear) upTo[c] = Math.max(upTo[c] ?? 0, seqs[c]);
		const tags = ALERT_CLASSES.filter((c) => upTo[c] !== undefined);
		if (alerts.length === 0) return clearPayloadFor(sub, apple, tags, upTo);
		if (apple) appleClear.delete(sub.endpoint);
		const out = alerts.map((a) => {
			const cls = a.tag as AlertClass;
			seqs[cls]++;
			return { ...a, seq: seqs[cls], clear: tags, upTo };
		});
		alertSeqs.set(sub.endpoint, seqs);
		return out;
	}

	/** Fire-and-forget: every payload to its device; prunes 404/410 endpoints. Never throws into the caller's path. */
	function sendPushes(
		batches: ReadonlyArray<{
			sub: PushSub;
			payloads: ReadonlyArray<AlertPayload | ClearPayload>;
		}>,
	): void {
		if (batches.every((b) => b.payloads.length === 0)) return;
		ensureVapid();
		void Promise.all(
			batches.flatMap(({ sub, payloads }) =>
				payloads.map((p) =>
					sendAll([sub], JSON.stringify(p), (s, body) =>
						sendNotification(s, body),
					),
				),
			),
		)
			.then((reports) => {
				// Prune gone endpoints against a fresh read (R2-7): the pre-send snapshot is
				// stale by the time the network answers, and writing it back would drop or
				// resurrect subscriptions that changed during the sends.
				const gone = new Set<string>();
				for (const r of reports) for (const g of r.gone) gone.add(g);
				pruneSubs(deps.gstore, gone);
			})
			.catch((err) => logError("push failed", err));
	}

	/** One frame's push pass: retract alerts whose cause cleared or that were acked, then deliver
	 * the frame's new events per device (class switches, project mute). A focused board tab holds
	 * the new events — dropped, never sent later; they still sit in the inbox — but never the retraction. */
	function pushAlerts(
		inputs: readonly AlertCardInput[],
		events: readonly AlertEvent[],
		seen: ReadonlySet<string>,
	): void {
		const rekeyed = rekeyAlerts(inputs);
		const removed = retire(clearedAlerts(liveAlerts, inputs, seen));
		const fresh = presenceHolds(focusAt, now())
			? []
			: events.filter((e) => !seen.has(e.key));
		if (fresh.length === 0 && removed.length === 0) {
			if (rekeyed) saveAlertState();
			return;
		}
		const subs = loadSubs(deps.gstore);
		const muted = new Set(loadMuted());
		const toOf = new Map(
			fresh.map((e) => [
				e.key,
				subs
					.filter((s) => deliverable(s.classes, muted, e))
					.map((s) => s.endpoint),
			]),
		);
		// An alert no device got needs no retraction, so it never enters the registry.
		const sent = fresh.filter((e) => (toOf.get(e.key)?.length ?? 0) > 0);
		if (sent.length > 0) {
			const keys = new Set(sent.map((e) => e.key));
			liveAlerts = [
				...liveAlerts.filter((a) => !keys.has(a.key)),
				...sent.map((e) => ({
					key: e.key,
					sent: e.key,
					class: e.class,
					taskId: e.taskId,
					project: e.project,
					to: toOf.get(e.key) ?? [],
				})),
			];
		}
		const batches = subs.map((sub) => {
			const mine = liveAlerts.filter((a) => a.to.includes(sub.endpoint));
			// The class notification stands for every alert of the class this device still
			// shows, so its keys (and a grouped count) cover all of them, not just this frame.
			const liveKeys: Record<AlertClass, string[]> = {
				request: [],
				error: [],
				complete: [],
			};
			for (const a of mine) liveKeys[a.class].push(a.key);
			const clear = tagsToClear(removed, mine, sub.endpoint);
			return {
				sub,
				payloads: batchFor(
					sub,
					payloadsFor(
						sent.filter((e) => toOf.get(e.key)?.includes(sub.endpoint)),
						liveKeys,
					),
					clear,
				),
			};
		});
		saveAlertState();
		sendPushes(batches);
	}

	/** Applies rekeyErrorAlerts to the registry; true when a key changed. */
	function rekeyAlerts(inputs: readonly AlertCardInput[]): boolean {
		const next = rekeyErrorAlerts(liveAlerts, inputs);
		const changed = next.some((a, i) => a.key !== liveAlerts[i]?.key);
		liveAlerts = next;
		return changed;
	}

	/** Retraction right after an ack (POST /api/inbox/seen), so the devices close the acked alerts
	 * at once instead of at the next card change. */
	function retractAcked(): void {
		if (lastAlertInputs === null || liveAlerts.length === 0) return;
		const rekeyed = rekeyAlerts(lastAlertInputs);
		const removed = retire(
			clearedAlerts(liveAlerts, lastAlertInputs, new Set(loadInboxSeen())),
		);
		if (removed.length === 0) {
			if (rekeyed) saveAlertState();
			return;
		}
		const batches = loadSubs(deps.gstore).map((sub) => ({
			sub,
			payloads: batchFor(
				sub,
				[],
				tagsToClear(removed, liveAlerts, sub.endpoint),
			),
		}));
		saveAlertState();
		sendPushes(batches);
	}

	/** Single admin (set by /api/setup): null means the board is in onboarding. Loopback never checks it. */
	let admin: { name: string; passHash: string } | null = null;
	let apiKey: string | null = null;
	let sessionSecret: string | null = null;
	/** Login registry; one entry per signed-in browser, see docs/specs/session-registry.md. */
	let sessions: SessionEntry[] = [];
	// Login failures: 10 per source, 100 global, sliding 15 min window.
	const loginLimiter = new LoginLimiter(15 * 60 * 1000, 10, 100);
	// Costly routes (docs/specs/public-api-request-limit.md): public-host requests that
	// start a model call, a git operation or card creation share one bucket per source.
	const costlyLimiter = new RequestLimiter(10 * 60 * 1000, 60, 600);
	/** VAPID keys for Web Push; generated lazily on the first push path so boot stays silent. */
	let vapid: { publicKey: string; privateKey: string; subject: string } | null =
		null;
	/** Outgoing public key recovered from a stored vapid row whose private key is unreadable
	 * (ADR-0011 recovery): covers upgraded/restored boards that predate the push_vapid_key kv. */
	let previousVapidPublicKey: string | null = null;
	/** Alate server settings; key is sealed at rest like apiKey (ADR-0011). */
	let alate: { url: string | null; key: string | null } = {
		url: null,
		key: null,
	};
	/** GitHub token from onboarding or Settings; sealed at rest like apiKey (ADR-0011). */
	let githubToken: string | null = null;
	/**
	 * GitHub host saved in Settings; null = nothing saved, so the env decides. The app
	 * remembers the env value it booted with: a clear restores it, or removes the variable
	 * when the env had none.
	 */
	let savedGithubHost: string | null = null;
	const bootGithubHostEnv = process.env[GITHUB_HOST_ENV];
	/**
	 * Per-host HTTPS tokens for every git host; stored sealed like githubToken (ADR-0011).
	 * One entry per host; the token is handed to git through a credential helper env, never
	 * through a URL or .git/config. `unreadable` marks a stored sealed token this boot's box
	 * cannot open: the row stays in the list (kept blob re-stored by saveConfig) but its
	 * empty token is never used as a credential.
	 */
	type StoredGitToken = GitToken & { unreadable?: true };
	let gitTokens: StoredGitToken[] = [];
	/**
	 * Read-only GitHub tokens for turns (docs/specs/turn-read-token.md), one row per GitHub
	 * host; stored sealed like gitTokens (ADR-0011). The board checks a saved token with the
	 * GitHub API once per save/re-check and stores the verdict; only a readable `ok` row, or
	 * a `write` row the operator confirmed, is served to turns.
	 */
	type TurnReadTokenRow = {
		/** "github.com" or the configured GitHub host, lowercased. */
		host: string;
		/** Runtime plaintext; null while the stored blob is absent or unreadable this boot. */
		token: string | null;
		status: "ok" | "write" | "error";
		detail: string;
		/** The operator accepted a write-capable token; every check resets it. */
		confirmed: boolean;
	};
	let turnReadTokens: TurnReadTokenRow[] = [];
	/**
	 * GitHub App for PR review posts; stored sealed in the config file like githubToken
	 * (ADR-0011), never served back after save. The key joins the git secret set.
	 * `unreadable` marks a stored sealed key this boot cannot open: fingerprint null, no
	 * token mint, never a credential; re-entering the pair replaces it.
	 */
	let githubApp = null as {
		id: string;
		key: string;
		fingerprint: string | null;
		unreadable?: true;
	} | null;
	/** Installation-token mint for githubApp; null whenever the app is unset. Memory only. */
	let appTokens = null as AppTokenSource | null;
	/** Last app name + install check; null while no app is set or before the first check. */
	let appCheck: AppCheck | null = null;
	let checkingApp = false;
	/**
	 let githubApp = null as {
	 	 id: string;
	 	 key: string;
	 	 fingerprint: string;
	 } | null;
	 * Server-side git, gh and merge turns read the token from GH_TOKEN; the worker image's git
	 * credential helper hands it to git. Work turns never get it: runner strips it from the env
	 * it forwards to workers, and serveWorker strips it from the worker's own env (D6).
	 */
	function applyGithubToken(): void {
		if (githubToken !== null) process.env.GH_TOKEN = githubToken;
	}
	/**
	 * Apply the saved GitHub host by writing the env var, the same pattern as
	 * applyGithubToken writing GH_TOKEN: every caller reads it through githubHost().
	 */
	function applyGithubHost(): void {
		if (savedGithubHost !== null)
			process.env[GITHUB_HOST_ENV] = savedGithubHost;
		else if (bootGithubHostEnv === undefined)
			delete process.env[GITHUB_HOST_ENV];
		else process.env[GITHUB_HOST_ENV] = bootGithubHostEnv;
	}
	/** Default probe: the board's own repo answers with the expiry header when the token expires. */
	const githubExpiryFetch = withGithubRetry(noRedirectFetch, {
		sleep: deps.githubTokenExpirySleep,
	});
	const githubTokenExpiry =
		deps.githubTokenExpiry ??
		(async (token: string): Promise<string | null> => {
			const h = githubHost();
			const res = await githubExpiryFetch(
				h.isDefault
					? "https://api.github.com/repos/ottr-ai/ottr"
					: `${h.apiBase}/user`,
				{
					headers: {
						authorization: `Bearer ${token}`,
						accept: "application/vnd.github+json",
					},
					signal: AbortSignal.timeout(
						deps.githubTokenExpiryTimeoutMs ?? TOKEN_PROBE_TIMEOUT_MS,
					),
				},
			);
			// A 401/403/5xx has no expiration header; null would wrongly clear the stored date.
			if (!res.ok)
				throw new Error(
					requestFailed(
						`the token expiry probe of ${h.isDefault ? "api.github.com" : `${h.apiBase}/user`}`,
						res.status,
						"check or renew the board token; the stored expiry stays until a probe succeeds",
					),
				);
			return parseGithubExpiry(
				res.headers.get("github-authentication-token-expiration"),
			);
		});
	/**
	 * Probe the board token and refresh the reminder file: a failed probe keeps the stored value
	 * (log, retry next tick); a differing date is a renewed token and resets that day's throttle.
	 * Returns the stored board expiry after the refresh.
	 */
	async function refreshBoardExpiry(): Promise<string | null> {
		const state = loadReminders();
		const seed = readSeedTokenExpires();
		if (state.seed.expiresAt !== seed)
			state.seed = { expiresAt: seed, lastPushDay: null };
		if (githubToken !== null) {
			try {
				const probed = await githubTokenExpiry(githubToken);
				if (probed !== state.board.expiresAt)
					state.board = { expiresAt: probed, lastPushDay: null };
			} catch (err) {
				logError("github token expiry probe failed", err);
			}
		}
		saveReminders(state);
		return state.board.expiresAt;
	}
	/** One kind's daily reminder push. A null expiry or an already-pushed day sends nothing; a
	 * held focus leaves the day unmarked, so the next tick tries again. */
	async function pushTokenReminder(
		kind: "board" | "seed",
		state: ReminderState,
		today: string,
		at: Date,
	): Promise<void> {
		const r = state[kind];
		if (r.expiresAt === null || r.lastPushDay === today) return;
		const body = tokenExpiryWarning(kind, r.expiresAt, at);
		const days = tokenDaysLeft(r.expiresAt, at);
		if (body === null || !(days === 30 || (days >= 0 && days <= 14))) return;
		if (presenceHolds(focusAt, now())) return;
		try {
			const subs = loadSubs(deps.gstore).filter((s) => s.classes.request);
			if (subs.length > 0) {
				ensureVapid();
				await sendAll(
					subs,
					JSON.stringify({
						title: "Ottr",
						body,
						tag: "token-expiry",
						url: "/",
					}),
					(sub, p) => sendNotification(sub, p),
				);
			}
		} catch (err) {
			logError("token expiry push failed", err);
		} finally {
			// One attempt per UTC day even when sends failed (same rule as the alert channel).
			r.lastPushDay = today;
			saveReminders(state);
		}
	}
	/** Daily reminder: one push per UTC day per token, at 30 days out and through the last two weeks.
	 * It follows the alert rules: Request class (the user must renew the token; no project, so
	 * project mutes never apply), and a focused board tab holds it — the bell's token warning is
	 * on screen then. A held reminder leaves the day unmarked, so the next tick tries again. */
	async function tokenReminderTick(): Promise<void> {
		await refreshBoardExpiry();
		const state = loadReminders();
		const at = new Date();
		const today = at.toISOString().slice(0, 10);
		for (const kind of ["board", "seed"] as const)
			await pushTokenReminder(kind, state, today, at);
	}
	/** One token-shaped word (ghp_, github_pat_, gho_, legacy hex) or null; keeps the credential helper's password line single. */
	function githubTokenParam(v: unknown): string | null {
		if (typeof v !== "string") return null;
		const t = v.trim();
		return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null;
	}
	const GITHUB_TOKEN_ERROR =
		"a GitHub token is required (ghp_… or github_pat_…, with repo access)";
	/**
	 * Hindsight server URL and API key from Settings; the key is sealed at rest like apiKey
	 * (ADR-0011, same trust level). omp reads HINDSIGHT_API_URL and HINDSIGHT_API_TOKEN over the env, and the runner
	 * forwards the board's env to workers, so saved values reach every new turn and beat the
	 * compose env that seeds them. Without either, the board leaves the env alone: its turns keep
	 * omp's settings.
	 */
	let hindsightToken: string | null = null;
	let hindsightUrl: string | null = null;
	/** The board derives the memory backend from the env at spawn time (src/memory.ts) and passes
	 *  a --config overlay (src/runner.ts); config.yml no longer matters (a stale backend line is
	 *  inert). Health of the backend in effect, refreshed on boot, on save, and on a 60 s tick. */
	let memoryHealth: MemoryHealth | null = null;
	async function memoryHealthTick(): Promise<void> {
		try {
			memoryHealth = await checkMemoryHealth(memoryBackendFromEnv(process.env));
		} catch (err) {
			// checkMemoryHealth reports reasons instead of throwing; a throw is a bug in the
			// plumbing, and it must never take the board down.
			logError("memory health check", err);
		}
	}
	// OTTR-548: the workers' last sign-in self-reports, by runner id (the url's hostname, the
	// id /api/drain lists). null = unknown: the fetch failed, an old worker answered 404, or a
	// non-JSON body — workerSignInWarnings warns nothing for those, never a failed state.
	const workerSignInReports = new Map<string, WorkerSignInReport | null>();
	/** One worker url's sign-in self-report; null when unreachable, old, or the body is not
	 *  a report (workerSignInWarnings warns nothing for those, never a failed state). */
	async function probeWorkerSignIns(
		url: string,
		token: string | undefined,
	): Promise<WorkerSignInReport | null> {
		try {
			const res = await fetch(`${url}/signins`, {
				headers: {
					...(token ? { "x-otwr-token": token } : {}),
				},
				// redirect: "manual": the worker token must never follow a redirect off-host.
				redirect: "manual",
				signal: AbortSignal.timeout(5_000),
			});
			if (res.status !== 200)
				throw new Error(
					requestFailed(
						`the sign-in report probe of ${url}/signins`,
						res.status,
						"check that the worker is reachable; the board warns nothing while its report is unknown",
					),
				);
			const body = (await res.json()) as {
				signIns?: unknown;
				error?: unknown;
				tmp?: unknown;
			};
			// OTTR-754: a worker that omits tmp (an old worker) or sends a malformed
			// object reports unknown space — the gate then never blocks on it. Parsed
			// before the branches: the worker reports its space on both answer shapes.
			const tmp =
				body.tmp &&
				typeof body.tmp === "object" &&
				typeof (body.tmp as TmpDiskSpace).freeBytes === "number" &&
				typeof (body.tmp as TmpDiskSpace).totalBytes === "number"
					? {
							freeBytes: (body.tmp as TmpDiskSpace).freeBytes,
							totalBytes: (body.tmp as TmpDiskSpace).totalBytes,
						}
					: null;
			if (typeof body.error === "string")
				return { signIns: null, error: body.error, at: Date.now(), tmp };
			if (Array.isArray(body.signIns))
				return {
					signIns: body.signIns as SignIn[],
					error: null,
					at: Date.now(),
					tmp,
				};
			throw new Error("sent a body without signIns");
		} catch {
			return null; // An unreachable or old worker warns nothing.
		}
	}
	/** Files one worker's report under its configured url's hostname. */
	function storeWorkerReport(
		url: string,
		report: WorkerSignInReport | null,
	): void {
		try {
			workerSignInReports.set(new URL(url).hostname, report);
		} catch {
			// A malformed configured url never warns.
		}
	}
	async function workerSignInTick(): Promise<void> {
		const target = deps.workerTarget;
		if (!target || target.urls.length === 0) return;
		await Promise.all(
			target.urls.map(async (url) =>
				storeWorkerReport(url, await probeWorkerSignIns(url, target.token)),
			),
		);
	}
	function applyHindsight(): void {
		if (hindsightUrl !== null) process.env.HINDSIGHT_API_URL = hindsightUrl;
		if (hindsightToken !== null && process.env.HINDSIGHT_API_URL)
			process.env.HINDSIGHT_API_TOKEN = hindsightToken;
	}
	function hindsightView() {
		// The flags read the stored/runtime token, not just the env: a kept-unreadable
		// token counts as set with tokenReadable false, and an env-only token (stored
		// wins over env, like applyHindsight) counts as set and readable (ADR-0011).
		const kept = keptUnreadable.has("hindsightToken");
		const envToken =
			process.env.HINDSIGHT_API_TOKEN !== undefined &&
			process.env.HINDSIGHT_API_TOKEN !== "";
		return {
			url: process.env.HINDSIGHT_API_URL || null,
			tokenSet: hindsightToken !== null || kept || envToken,
			tokenReadable: hindsightToken !== null || (!kept && envToken),
			backend: memoryBackendFromEnv(process.env).backend,
			memoryReason: memoryHealth?.reason ?? null,
		};
	}
	let provisioning = false;
	/** Last failed automatic provision attempt (U9); cleared by any successful provision. */
	let alateProvisionError: string | null = null;
	/** Epoch ms before which the automatic provision trigger stays silent after a failure. */
	let alateBackoffUntil = 0;
	/** Epoch ms when the provider's current pending episode was first seen; cleared when it reports
	 *  pending false. Health-check errors keep the last known value, so the advisory survives a blip. */
	let alatePendingSince: number | null = null;
	/** Last good upstream pull (U5); loaded once at boot, replaced only by a validated refresh. */
	let updates: {
		checkedAt: string;
		updates: UpdateRecord[];
	} | null = (() => {
		const v = deps.gstore.get<unknown>("updates");
		if (typeof v !== "object" || v === null) return null;
		const r = v as Record<string, unknown>;
		return typeof r.checkedAt === "string" && Array.isArray(r.updates)
			? {
					checkedAt: r.checkedAt,
					updates: r.updates,
				}
			: null;
	})();
	let updatesInFlight: Promise<void> | null = null;
	// Pending decisions from the dropped forward design become local skips.
	migratePendingToSkips(deps.gstore);

	/** State-frame view: repo→project mapping and decision/skip filtering run against live projects. */
	function updatesView(): UpdatesView | null {
		if (updates === null) return null;
		const hidden = new Set(loadSkips(deps.gstore));
		return {
			checkedAt: updates.checkedAt,
			rows: updates.updates
				.filter((rec) => !hidden.has(rec.id))
				.map((rec) => ({
					...rec,
					project: mapRepo(rec.repo, deps.projects.values()),
				})),
		};
	}

	// Fork research watcher: Entry already exposes
	// {name, path, store, github}; the factory re-iterates the live Map on every tick.
	const forkWatcher = createForkWatcher({
		projects: () => deps.projects.values(),
		log: (msg: string) => console.log(`[fork] ${msg}`),
	});

	// Weekly GitHub trending scanner: same live project Map as the fork watcher; its weekly
	// slot and last outcome persist under the gstore key "trending", apart from the config.
	const trendingScanner = createTrendingScanner({
		projects: () => deps.projects.values(),
		enabled: () => deps.shared.trendingScan,
		load: loadTrendingState,
		save: (s: TrendingState) => deps.gstore.set("trending", s),
		token: () => process.env.GH_TOKEN,
		apiBase: () => githubHost().apiBase,
		fetch: deps.trendingFetch,
		now,
		log: (msg: string) => console.log(`[trending] ${msg}`),
		schedule: deps.schedule,
	});

	/** The stored TrendingState; missing or malformed = EMPTY_TRENDING_STATE (a malformed
	 * field alone falls back to its empty value). */
	function loadTrendingState(): TrendingState {
		const s = deps.gstore.get<Record<string, unknown>>("trending");
		if (typeof s !== "object" || s === null || Array.isArray(s))
			return { ...EMPTY_TRENDING_STATE };
		const num = (v: unknown): number | null =>
			typeof v === "number" && Number.isFinite(v) ? v : null;
		const err = s.lastError as { reason?: unknown; at?: unknown } | null;
		return {
			lastWeek: typeof s.lastWeek === "string" ? s.lastWeek : null,
			lastRunAt: num(s.lastRunAt),
			lastError:
				typeof err === "object" &&
				err !== null &&
				typeof err.reason === "string" &&
				num(err.at) !== null
					? { reason: err.reason, at: err.at as number }
					: null,
			firstFailAt: num(s.firstFailAt),
		};
	}

	// PR review watcher: same live project Map as the fork watcher; tests fake `gh`.
	const prWatcher = createPrWatcher({
		projects: () => deps.projects.values(),
		log: (msg: string) => console.log(`[pr] ${msg}`),
		gh,
		spawn: deps.prReviewSpawn,
		// A re-review rewrites a draft the user may have read: the mark must go,
		// or the updated card never wears the unread badge again. OTTR-827: the
		// completion key goes with the plain id, or a done card's rail mark would
		// outlive the badge the new comments earn.
		forgetSeen: (taskId) =>
			saveSeen(
				loadSeen().filter(
					(id) => id !== taskId && !id.startsWith(`${taskId}@`),
				),
			),
	});

	// Issue watcher: same live project Map; files new open GitHub issues as backlog cards.
	const issueWatcher = createIssueWatcher({
		projects: () => deps.projects.values(),
		log: (msg: string) => console.log(`[issues] ${msg}`),
		gh,
	});

	// omp watch: reviews new omp releases per opted-in project; state lives in gstore.
	const ompWatcher = createOmpWatcher({
		projects: () => deps.projects.values(),
		load: (p) => deps.gstore.get(`ompWatch:${p}`),
		save: (p, s) => deps.gstore.set(`ompWatch:${p}`, s),
		log: (m) => console.log(`[omp-watch] ${m}`),
		schedule: deps.schedule,
	});

	/**
	 * Shared guards for filing a card from an updates row: unknown id, foreign updater,
	 * unmapped repo, gitless project. `removed` selects the row class: update cards refuse
	 * removed rows, remove cards refuse everything else. Throws the route's `{status, error}`
	 * json responses as errors.
	 */
	function fileableUpdate(
		id: string,
		removed: boolean,
	): { rec: UpdateRecord; e: Entry } {
		const fail = (status: number, error: string): never => {
			throw { status, error };
		};
		const { rec, blocked } = updateFiling(updates, id, removed);
		if (blocked !== null) return fail(blocked.status, blocked.error);
		const projectName = mapRepo(rec.repo, deps.projects.values());
		if (projectName === null)
			return fail(400, `no board project maps ${rec.repo}`);
		const e = deps.projects.get(projectName);
		if (e === undefined) return fail(400, `no board project maps ${rec.repo}`);
		if (e.gitless) return fail(409, "init a git repository first");
		return { rec, e };
	}

	/** Whether an open (not done, not cancelled) card already covers the update id. */
	function updateCardExists(id: string): boolean {
		for (const pe of deps.projects.values())
			if (
				pe.store
					.listTasks()
					.some(
						(t) =>
							t.cancelledAt === null &&
							t.stage !== "done" &&
							t.updateIds.includes(id),
					)
			)
				return true;
		return false;
	}

	/** The rows that may file now (U6): each id's filable row, target-checked, not already
	 *  covered by an open card. Throws the route's `{status, error}` json responses. */
	function pickedUpdates(
		ids: string[],
		propose: boolean,
	): Array<{ rec: UpdateRecord; e: Entry }> {
		const fail = (status: number, error: string): never => {
			throw { status, error };
		};
		const picked: Array<{ rec: UpdateRecord; e: Entry }> = [];
		for (const id of ids) {
			const { rec, e } = fileableUpdate(id, false);
			// Allow waits for a qualified target; propose picks the too-young latest.
			if (propose && rec.target !== null)
				return fail(400, `${id} already has a target`);
			if (!propose && rec.target === null)
				return fail(400, `${id} has no qualified target yet`);
			if (updateCardExists(id))
				return fail(409, `${id} is already covered by an open update card`);
			picked.push({ rec, e });
		}
		return picked;
	}

	/** Creates one card per project group, same pattern as followUpOf in
	 *  POST /api/projects/:project/tasks, then schedules the board. */
	function createUpdateCards(
		picked: ReadonlyArray<{ rec: UpdateRecord; e: Entry }>,
		propose: boolean,
	): Array<{ project: string; id: string }> {
		const groups: Array<{ e: Entry; recs: UpdateRecord[] }> = [];
		for (const { rec, e } of picked) {
			const g = groups.find((g) => g.e.name === e.name);
			if (g) g.recs.push(rec);
			else groups.push({ e, recs: [rec] });
		}
		const created: Array<{ project: string; id: string }> = [];
		for (const { e, recs } of groups) {
			const prompt = updatePrompt(recs, propose);
			const t = e.store.createTask(prompt);
			e.store.updateTask(t.id, {
				promptAuthor: "board",
				updateIds: recs.map((r) => r.id),
			});
			created.push({ project: e.name, id: t.id });
		}
		deps.schedule();
		return created;
	}

	/**
	 * File update cards now instead of waiting for the daily push window (U6). Throws the
	 * route's `{status, error}` json responses as errors; the endpoint turns them back.
	 */
	async function fileUpdateCards(
		ids: string[],
		propose: boolean,
	): Promise<Array<{ project: string; id: string }>> {
		const fail = (status: number, error: string): never => {
			throw { status, error };
		};
		if (updates === null) return fail(409, "no updates loaded");
		return createUpdateCards(pickedUpdates(ids, propose), propose);
	}

	/** Files one card that removes an upstream-deleted row (U5): the mapped project's agent
	 *  drops the installed copy, the pin and every reference. One id, one card. */
	async function fileRemoveCard(
		id: string,
	): Promise<Array<{ project: string; id: string }>> {
		const { rec, e } = fileableUpdate(id, true);
		if (updateCardExists(id))
			throw {
				status: 409,
				error: `${id} is already covered by an open update card`,
			};
		const t = e.store.createTask(removePrompt([rec]));
		e.store.updateTask(t.id, { promptAuthor: "board", updateIds: [id] });
		deps.schedule();
		return [{ project: e.name, id: t.id }];
	}

	/** Single-flight pull from the alate provider; failure keeps the last good result. */
	function refreshUpdates(): Promise<void> {
		if (updatesInFlight !== null) return updatesInFlight;
		if (alate.url === null || alate.key === null) return Promise.resolve();
		const refused = alateUrlError(alate.url);
		if (refused !== null) {
			logError("updates pull", new Error(refused));
			return Promise.resolve();
		}
		updatesInFlight = (async () => {
			try {
				let res: Response;
				try {
					res = await noRedirectFetch(
						`${alate.url}/api/updates`,
						{
							headers: { authorization: `Bearer ${alate.key}` },
							// Bounded like provision: a hung alate must not hold the pull open.
							signal: AbortSignal.timeout(10_000),
						},
						{ proxyHint: true },
					);
				} catch (err) {
					logError("updates pull failed", err);
					return;
				}
				if (!res.ok) {
					logError(
						"updates pull failed",
						new Error(
							requestFailed(
								`the alate updates pull of ${alate.url}/api/updates`,
								res.status,
								"the board keeps the last good list and retries on the next tick",
							),
						),
					);
					return;
				}
				const body: unknown = await res.json().catch(() => null);
				const good = validateUpdates(body);
				if (good === null) {
					logError(
						"updates pull",
						new Error("invalid envelope, keeping last good result"),
					);
					return;
				}
				// A pin already at the newest upstream release, or already at its
				// qualified target (applied; only a young `latest` remains, whose id is
				// unchanged), is not an available update: drop it, so the panel lists
				// only outdated rows (target, or young latest).
				updates = {
					checkedAt: good.checkedAt,
					updates: good.updates.filter(
						(r) => r.current !== r.latest && r.current !== r.target,
					),
				};
				deps.gstore.set("updates", updates);
				if (good.dropped > 0)
					console.log(
						`updates: dropped ${good.dropped} invalid record(s) from alate`,
					);
				publishSoon();
			} finally {
				updatesInFlight = null;
			}
		})();
		return updatesInFlight;
	}
	function alateView() {
		return {
			url: alate.url,
			// A kept-unreadable key still counts as set; keyReadable says this boot can use
			// it (ADR-0011).
			keySet: alate.key !== null || keptUnreadable.has("alateKey"),
			keyReadable: alate.key !== null,
			lastProvisionError: alateProvisionError,
		};
	}
	/** Maps the provision POST's transport timeout. A TimeoutError alone does not prove
	 *  delivery: a hung DNS lookup, TCP connect or TLS handshake rejects the same way.
	 *  So ask alate once; only a health report of a running provision means "still running". */
	async function provisionTimedOut(): Promise<{
		ok: false;
		status: number;
		error: string;
		running?: true;
	}> {
		const h = await alateHealth(alate);
		if (h.ok && h.body.running === true)
			return {
				ok: false,
				status: 202,
				error: "provision still running on alate",
				running: true,
			};
		return {
			ok: false,
			status: 504,
			error: `alate did not answer the provision request within 110 s${h.ok ? " and reports no running provision" : `: ${h.error}`}`,
		};
	}
	/** One transport attempt of POST <alate.url>/provision; the in-flight guard stays with
	 *  provisionNow. A TimeoutError alone does not prove delivery: a hung DNS lookup, TCP
	 *  connect or TLS handshake rejects the same way, so it asks alate once (provisionTimedOut). */
	async function provisionRequest(): Promise<
		| { ok: true; body: unknown }
		| { ok: false; status: number; error: string; running?: true }
	> {
		let res: Response;
		try {
			res = await noRedirectFetch(
				`${alate.url}/provision`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${alate.key}` },
					// Bounded under serveOptions.idleTimeout (120 s) together with the 5 s
					// health probe in provisionTimedOut: a hung alate must fail the
					// request, not hold the connection until the idle cut kills it.
					signal: AbortSignal.timeout(110_000),
				},
				{ proxyHint: true },
			);
		} catch (err) {
			// Awaited so the in-flight guard holds until the probe answers.
			if ((err as Error).name === "TimeoutError")
				return await provisionTimedOut();
			return {
				ok: false,
				status: 502,
				error: `cannot reach alate server: ${(err as Error).message}`,
			};
		}
		const body = (await res.json().catch(() => null)) as {
			error?: unknown;
		} | null;
		if (!res.ok) {
			const msg =
				typeof body?.error === "string"
					? body.error
					: requestFailed(
							"The alate provision request",
							res.status,
							"check that the alate server is up, then run Provision again",
						);
			return { ok: false, status: res.status, error: msg };
		}
		return { ok: true, body };
	}
	/** POST <alate.url>/provision shared by the route and the U9 trigger, with its in-flight guard.
	 *  `running: true` marks a provision that outlived the transport bound and that alate's
	 *  health still reports as running — never a failure. */
	async function provisionNow(): Promise<
		| { ok: true; body: unknown }
		| { ok: false; status: number; error: string; running?: true }
	> {
		if (alate.url === null)
			return {
				ok: false,
				status: 400,
				error: "alate server url is not configured",
			};
		if (alate.key === null)
			return {
				ok: false,
				status: 400,
				error: "alate api key is not configured",
			};
		const refused = alateUrlError(alate.url);
		if (refused !== null) return { ok: false, status: 400, error: refused };
		if (provisioning)
			return { ok: false, status: 409, error: "provisioning already running" };
		provisioning = true;
		try {
			return await provisionRequest();
		} finally {
			provisioning = false;
		}
	}
	/** Compose seeds the board's omp copy hourly and records the commit next to its home.
	 *  `roles` is the board copy's modelRoles and `fallbacks` its retry.fallbackChains: the UI
	 *  compares them with the saved values. */
	function seedView(): {
		needed: boolean;
		commit: string | null;
		roles: Record<string, string> | null;
		fallbacks: Record<string, string[]> | null;
		expiresAt: string | null;
	} {
		const needed = !!process.env.OTTR_BOARD_OMP_HOME?.trim();
		if (!needed)
			return {
				needed,
				commit: null,
				roles: null,
				fallbacks: null,
				expiresAt: null,
			};
		const roles = modelRoles();
		const fallbacks = modelFallbacks();
		const expiresAt = readSeedTokenExpires();
		try {
			const commit = readFileSync(
				join(dirname(boardOmpHome()), "seed-commit"),
				"utf8",
			).trim();
			return { needed, commit: commit || null, roles, fallbacks, expiresAt };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { needed, commit: null, roles, fallbacks, expiresAt };
		}
	}
	/** The deferred server restart the update script records next to the board home: a notice
	 *  only once every field sanitizes, the server runs an older commit than the image, and
	 *  the wait passed the threshold; any read or parse failure stays advisory null. */
	function restartWaitView(): RestartWaitView | null {
		const build = readBoardHomeFile("build-commit");
		// The script records %h (the short form), like its deploy record has always done.
		if (build === null || !/^[0-9a-f]{7,40}$/.test(build)) return null;
		let record: unknown;
		try {
			record = JSON.parse(readBoardHomeFile("restart-wait") ?? "");
		} catch {
			return null;
		}
		const fields = sanitizeRestartWait(record);
		if (fields === null) return null;
		const { commit, since, commits, turns } = fields;
		if (build === commit || Date.now() - since < RESTART_WAIT_NOTICE_MS)
			return null;
		return {
			running: build,
			commit,
			commits,
			since,
			turns,
			command: restartWaitCommand(record as Record<string, unknown>),
		};
	}
	/** The failed board seed the update script records next to the board home: a notice
	 *  only once every field sanitizes; any read or parse failure stays advisory null.
	 *  Host-written file content, so the text never reaches the UI with control
	 *  characters or an unbounded length, and a stored secret redacts out anyway. */
	function seedFailedView(): SeedFailedView | null {
		let record: unknown;
		try {
			record = JSON.parse(readBoardHomeFile("seed-failed") ?? "");
		} catch {
			return null;
		}
		if (record === null || typeof record !== "object") return null;
		const r = record as Record<string, unknown>;
		const since = r.since;
		const rawCommit = r.commit;
		const rawText = r.text;
		if (
			typeof since !== "number" ||
			!Number.isInteger(since) ||
			since <= 0 ||
			typeof rawText !== "string" ||
			rawText.length > 1200 ||
			/[\p{Cc}]/u.test(rawText)
		)
			return null;
		const commit =
			typeof rawCommit === "string" && /^[0-9a-f]{7,40}$/.test(rawCommit)
				? rawCommit
				: "";
		const text = redact(rawText.trim(), gitSecrets());
		return { since, commit, text };
	}
	/** Maps an editor layout refusal to 422; anything else stays a 500 in api(). */
	async function layout422(fn: () => Promise<Response>): Promise<Response> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof RolesLayoutError)
				return json({ error: err.message }, 422);
			throw err;
		}
	}
	/** Same idle gate scripts/update-image.ts deploys behind: a preparing or running turn anywhere. */
	function anyTurnActive(): boolean {
		return [...deps.projects.values()].some((e) =>
			e.store
				.listTasks()
				.some((t) => t.state === "preparing" || t.state === "running"),
		);
	}
	/**
	 * U9 background provision trigger, run every 5 minutes (src/server.ts): when the
	 * provider holds an unprovisioned import, run the manual provision path. With alate's
	 * agent-layer support (health `layers`) the provision never waits: running turns keep
	 * the layer they started with. Without the flag, alate writes the flat home, so the
	 * old "no turn runs" gate stays for that attempt. A success leaves pending false, so
	 * the provider flag ends the loop; a failed attempt waits an hour and surfaces in
	 * alateView for the settings section.
	 */
	/** The U9 health poll's bookkeeping: the bell's pending-episode tracking, and dating any
	 *  recorded attempt failure when the import is gone (a completed provision, here by the
	 *  manual button or from alate's own dashboard). */
	function applyProvisionHealth(h: {
		ok: true;
		body: Record<string, unknown>;
	}): void {
		alatePendingSince =
			h.body.pending === true ? (alatePendingSince ?? Date.now()) : null;
		if (h.body.pending !== true) alateProvisionError = null;
	}
	/** Whether the U9 tick must skip its provision attempt, recording alate's failure state
	 *  when the health probe failed. Caller just returns (docs/specs/agent-layer-switch.md). */
	function provisionGateBlocks(
		h:
			| {
					ok: true;
					body: Record<string, unknown>;
			  }
			| {
					ok: false;
					status: number;
					error: string;
			  },
	): boolean {
		if (alate.key === null) return true;
		if (Date.now() < alateBackoffUntil) return true;
		// With agent-layer support (alate health layers:true) a provision installs a new
		// layer and switches a symlink: running turns keep the layer they started with,
		// so the provision never waits for an idle board. Without the flag — or when the
		// health probe failed and says nothing — alate may write the flat home under
		// running turns, so the old idle gate stays for that attempt.
		if ((h.ok ? h.body.layers : undefined) !== true && anyTurnActive())
			return true;
		if (!h.ok) {
			alateProvisionError = h.error;
			alateBackoffUntil = Date.now() + 60 * 60_000;
			return true;
		}
		// alate single-flights provisions: one still executing means an earlier
		// attempt (whose wait may have timed out) is mid-flight — wait it out instead
		// of recording its 409 as a failure.
		if (h.body.pending !== true) return true;
		return h.body.running === true;
	}
	async function alateProvisionTick(): Promise<void> {
		if (alate.url === null) return;
		// The health poll runs before the gates so the bell's pending-episode tracking keeps
		// working on a busy board — when the provision gates below would defer the attempt.
		const h = await alateHealth(alate);
		if (h.ok) applyProvisionHealth(h);
		if (provisionGateBlocks(h)) return;
		const r = await provisionNow();
		if (!r.ok && r.running) return; // still running on alate; the outcome arrives via health
		alateProvisionError = r.ok ? null : r.error;
		if (!r.ok) alateBackoffUntil = Date.now() + 60 * 60_000;
	}

	/** Files one architecture-review card; shared by the manual route and the idle auto-start
	 * tick (docs/specs/mutation-delta.md §7). Keeps the R1-8 ordering: resolveTarget and
	 * archReviewDelta run BEFORE the reviewBlocked guard, so the guard and createTask sit in
	 * one synchronous block and two overlapping calls cannot both pass it. With
	 * opts.requireDue (the tick only) the review must also be due right now:
	 * archReviewDue(delta, cap, reviewed). Returns the filed card or the route's json error. */
	async function fileArchReview(
		e: Entry,
		model: string | null,
		opts: { requireDue: boolean },
	): Promise<
		{ ok: true; task: Task } | { ok: false; status: number; error: string }
	> {
		if (e.gitless)
			return { ok: false, status: 409, error: "init a git repository first" };
		if (e.target === null)
			return {
				ok: false,
				status: 409,
				error: "project has no integration target",
			};
		// The review freezes the target's current head, like a release card.
		let resolved: { target: string; sha: string };
		try {
			resolved = await resolveTarget(
				e.path,
				true,
				e.store.getSettings().originUrl,
				e.store.getSettings().targetBranch,
			);
		} catch (err) {
			return { ok: false, status: 409, error: errmsg(err) };
		}
		const delta = await archReviewDelta(
			e.path,
			resolved.target,
			lastReviewBase(e.store.listTasks()),
		).catch(() => null);
		// Network before the guard, like the git spawns, so the guard and createTask below
		// stay one synchronous block (R1-8). Never throws: a failed fetch lands in the
		// prompt as a per-type unavailable line or "alerts unavailable: <reason>".
		const alerts = await githubAlertSummary({ repo: e.github, gh });
		// The git spawns run BEFORE the guard, so the guard and createTask below sit in one
		// synchronous block: two overlapping requests cannot both pass it (R1-8).
		const blocked = reviewBlocked(e.store.listTasks());
		if (blocked !== null) return { ok: false, status: 409, error: blocked };
		if (delta === null)
			return {
				ok: false,
				status: 409,
				error: "could not read the git history",
			};
		if (
			opts.requireDue &&
			!archReviewDue(
				delta.delta,
				e.store.getSettings().archReviewCap,
				delta.reviewed,
			)
		)
			return { ok: false, status: 409, error: "review is not due" };
		const t = e.store.createTask(
			reviewPrompt({
				target: resolved.target,
				sha: resolved.sha,
				from: delta.reviewed ? delta.anchor : null,
				commits: delta.delta,
				alerts,
			}),
			model,
			"review",
		);
		// Synchronous with createTask: the scheduler must never see a review card without its base.
		const updated = e.store.updateTask(t.id, {
			promptAuthor: "board",
			base: resolved.sha,
		});
		deps.schedule();
		return { ok: true, task: updated };
	}

	/** Card id the idle auto-start filed last (in-memory only): while that card exists and is
	 * neither done nor cancelled, the tick files nothing new. A restart forgets it. */
	let idleReviewCardId: string | null = null;

	/** Idle auto-start of the full review, run every 5 minutes (src/server.ts): with the
	 * setting on, after two hours without input and with no turn preparing or running
	 * anywhere, file the first due project's architecture-review card, in project map
	 * order. Silent when nothing qualifies (docs/specs/mutation-delta.md §7). */
	/** Whether the tick's remembered idle-review card is still open somewhere on the board. */
	function idleCardStillLive(id: string): boolean {
		return [...deps.projects.values()].some((pe) => {
			const t = pe.store.getTask(id);
			return t !== null && t.cancelledAt === null && t.stage !== "done";
		});
	}
	/** Files the first due project's architecture-review card, in project map order; null
	 *  when none qualifies (reviewBlocked and the due recompute live in the helper). */
	async function fileFirstDueArchReview(): Promise<string | null> {
		for (const e of deps.projects.values()) {
			// Cheap pre-filter from the refreshed entry; reviewBlocked and the due recompute
			// live inside the helper.
			if (e.archReview === null || !e.archReview.due || e.archReview.running)
				continue;
			const filed = await fileArchReview(e, null, { requireDue: true });
			if (filed.ok) return filed.task.id;
			// Not due any more, blocked, or git failed: the tick stays silent.
		}
		return null;
	}
	async function idleReviewTick(): Promise<void> {
		if (!deps.shared.idleReviews) return;
		if (now() - lastInputAt < 2 * 60 * 60_000) return;
		if (anyTurnActive()) return;
		// The remembered card finished or its project left the board: filing may start again.
		if (idleReviewCardId !== null && idleCardStillLive(idleReviewCardId))
			return;
		idleReviewCardId = null;
		const filedId = await fileFirstDueArchReview();
		if (filedId !== null) idleReviewCardId = filedId;
	}
	function saveConfig(): void {
		// ADR-0011: runtime plaintext goes into the row as-is; sealForStore swaps a null
		// runtime value back to the kept blob when this boot cannot open the stored one, so
		// an unrelated save never deletes a credential it cannot read. The walker below is
		// the only place that produces sealed strings; with no box every secret spot comes
		// from the stored row instead (writes of plaintext are refused at the routes), so an
		// allowed save can neither write plaintext over a sealed blob nor drop one.
		const stored = deps.gstore.get<Record<string, unknown> | null>("config");
		const storedSpot = (field: string, plain: string | null): string | null => {
			if (deps.secretBox !== undefined) return sealForStore(field, plain);
			if (clearedSecrets.has(field)) return null;
			return (
				(keptUnreadable.get(field) as string | undefined) ??
				(stored?.[field] as string | undefined) ??
				null
			);
		};
		const row: Record<string, unknown> = {
			maxTotal: deps.shared.maxTotalRuns,
			reviewCheck: deps.shared.reviewCheck,
			workCheck: deps.shared.workCheck,
			idleReviews: deps.shared.idleReviews,
			trendingScan: deps.shared.trendingScan,
			commitIdentity: deps.shared.commitIdentity,
			removed: deps.shared.removedPaths,
			projects: deps.shared.projectPaths,
			projectOrder: deps.shared.projectOrder,
			admin,
			apiKey: storedSpot("apiKey", apiKey),
			sessionSecret: storedSpot("sessionSecret", sessionSecret),
			sessions,
			vapid:
				deps.secretBox === undefined
					? // ADR-0011: no box keeps the stored spot verbatim. A generated pair
						// stays in memory only (pushes still work this boot; the next good
						// boot seals it), and a legacy plaintext row writes its own value
						// back byte-identical — no plaintext private key is ever created.
						(stored?.vapid ?? null)
					: // ADR-0011 recovery: a null runtime pair with an unreadable stored
						// row keeps the stored object (sealed private key + plaintext public
						// key) so a save does not erase the outgoing key before ensureVapid()
						// regenerates; a regenerated pair writes the fresh sealed pair.
						vapid === null
						? (keptUnreadable.get("vapidKey") ?? null)
						: {
								...vapid,
								privateKey: sealForStore("vapidKey", vapid.privateKey),
							},
			alate:
				deps.secretBox !== undefined
					? { url: alate.url, key: sealForStore("alateKey", alate.key) }
					: (() => {
							const storedAlate = stored?.alate;
							const storedKey =
								typeof storedAlate === "object" &&
								storedAlate !== null &&
								"key" in storedAlate &&
								typeof storedAlate.key === "string"
									? storedAlate.key
									: null;
							return {
								url: alate.url,
								key: clearedSecrets.has("alateKey")
									? null
									: ((keptUnreadable.get("alateKey") as string | undefined) ??
										storedKey),
							};
						})(),
			githubToken: storedSpot("githubToken", githubToken),
			githubHost: savedGithubHost,
			gitTokens:
				deps.secretBox !== undefined
					? gitTokens.map((t) =>
							t.unreadable === true
								? {
										host: t.host,
										username: t.username,
										token: keptUnreadable.get(`git:${t.host}`) ?? t.token,
									}
								: { ...t, token: sealForStore(`git:${t.host}`, t.token) },
						)
					: // Runtime token additions are impossible (guarded routes): the stored
						// rows pass through verbatim, minus the hosts cleared this boot.
						(() => {
							const storedTokens = stored?.gitTokens;
							if (!Array.isArray(storedTokens)) return [];
							return storedTokens.filter((t) => {
								if (typeof t !== "object" || t === null) return false;
								if (!("host" in t) || typeof t.host !== "string") return false;
								return !clearedSecrets.has(`git:${t.host}`);
							});
						})(),
			turnReadTokens:
				deps.secretBox !== undefined
					? turnReadTokens.map((t) => ({
							host: t.host,
							status: t.status,
							detail: t.detail,
							confirmed: t.confirmed,
							// A null runtime token (unreadable stored blob) writes the kept
							// blob back, so an unrelated save never deletes a credential
							// this boot cannot read.
							token: sealForStore(`turnRead:${t.host}`, t.token),
						}))
					: // Runtime row additions are impossible (guarded routes): the stored
						// rows pass through verbatim, minus the hosts cleared this boot.
						(() => {
							const storedRows = stored?.turnReadTokens;
							if (!Array.isArray(storedRows)) return [];
							return storedRows.filter((t) => {
								if (typeof t !== "object" || t === null) return false;
								if (!("host" in t) || typeof t.host !== "string") return false;
								return !clearedSecrets.has(`turnRead:${t.host}`);
							});
						})(),
			githubApp:
				deps.secretBox === undefined
					? clearedSecrets.has("githubAppKey")
						? null
						: (stored?.githubApp ?? null)
					: githubApp === null
						? null
						: githubApp.unreadable === true
							? { id: githubApp.id, key: keptUnreadable.get("githubAppKey") }
							: {
									id: githubApp.id,
									key: sealForStore("githubAppKey", githubApp.key),
								},
			envValues: (() => {
				if (deps.secretBox === undefined) {
					// Kept-unreadable env blobs go back first; with no box the stored values
					// pass through verbatim, minus names cleared this boot.
					const storedEnv = stored?.envValues;
					const vals: Record<string, unknown> = {};
					for (const [key, blob] of keptUnreadable)
						if (key.startsWith("env:")) vals[key.slice(4)] = blob;
					if (typeof storedEnv === "object" && storedEnv !== null)
						for (const [name, value] of Object.entries(storedEnv))
							if (!clearedSecrets.has(`env:${name}`)) vals[name] = value;
					return vals;
				}
				// Kept-unreadable env blobs go back first: an unrelated save must not delete
				// a value this boot cannot read. A re-entered value then overwrites its blob.
				const vals: Record<string, unknown> = {};
				for (const [key, blob] of keptUnreadable)
					if (key.startsWith("env:")) vals[key.slice(4)] = blob;
				for (const [name, value] of Object.entries(deps.shared.envValues))
					vals[name] = sealForStore(`env:${name}`, value);
				return vals;
			})(),
			// Plain values are not secrets: stored as plain text, never sealed.
			envPlain: deps.shared.envPlain,
			hindsightToken: storedSpot("hindsightToken", hindsightToken),
			hindsightUrl,
		};
		const out =
			deps.secretBox === undefined
				? { row: row as unknown, changed: false }
				: sealStoredConfigRow(row, deps.secretBox);
		deps.gstore.set("config", out.row);
	}
	// ADR-0011 kept-unreadable bookkeeping: when this boot's box cannot open a stored sealed
	// blob lands here keyed by field, and saveConfig puts it back so nothing is
	// deleted. Keys: githubToken, apiKey, sessionSecret, hindsightToken, alateKey,
	// githubAppKey, git:<host>, turnRead:<host>, env:<name>.
	const keptUnreadable = new Map<string, unknown>();
	/** Runtime plaintext of a stored value, or null when absent or unreadable; an unreadable sealed blob is kept in keptUnreadable. Legacy plaintext passes through unsealed. */
	function loadSecret(field: string, stored: unknown): string | null {
		if (typeof stored !== "string" || stored === "") return null;
		if (!isSealed(stored)) return stored;
		const plain =
			deps.secretBox === undefined ? null : deps.secretBox.open(stored);
		if (plain === null) {
			keptUnreadable.set(field, stored);
			return null;
		}
		return plain;
	}
	/** Stored value for saveConfig: the runtime plaintext, or the kept blob when the runtime value is null because this boot cannot read it. Never seals — the walker does. */
	function sealForStore(field: string, plain: string | null): string | null {
		if (plain !== null) {
			keptUnreadable.delete(field);
			return plain;
		}
		return (keptUnreadable.get(field) as string | undefined) ?? null;
	}
	// ADR-0011: an explicit clear must win over a kept blob, or an unreadable-key boot
	// would resurrect a credential the operator deleted.
	const clearedSecrets = new Set<string>();
	function clearSecret(field: string): void {
		keptUnreadable.delete(field);
		clearedSecrets.add(field);
	}
	// ADR-0011: with no box a credential write would land as plaintext, so it is refused
	// with the same body as Jira's degraded-mode answer; clears and non-secret saves stay allowed.
	function sealGuard(): Response | null {
		return deps.secretBox === undefined
			? json({ error: "OTTR_SECRET_KEY is invalid" }, 503)
			: null;
	}
	// ADR-0011 boot migration: seal every plaintext spot of the stored row before the
	// restore below reads it. Converge, never destructive; a no-box boot skips it.
	migrateSealedConfig(deps.gstore, deps.secretBox);
	loadStoredConfig();
	// Board-generated secrets this boot could not read are regenerated once: the kept blob
	// proved a real board wrote them, so a fresh board (no kept blob) keeps onboarding's
	// "generate on first save" behavior unchanged.
	if (apiKey === null && keptUnreadable.has("apiKey")) apiKey = newSecret();
	if (sessionSecret === null && keptUnreadable.has("sessionSecret"))
		sessionSecret = newSecret();

	/** Shape of the stored "config" row; every field is re-validated at boot. */
	type StoredConfig = {
		maxTotal?: unknown;
		reviewCheck?: unknown;
		workCheck?: unknown;
		idleReviews?: unknown;
		trendingScan?: unknown;
		commitIdentity?: unknown;
		removed?: unknown;
		projects?: unknown;
		admin?: unknown;
		apiKey?: unknown;
		sessionSecret?: unknown;
		sessions?: unknown;
		vapid?: unknown;
		alate?: unknown;
		githubToken?: unknown;
		githubHost?: unknown;
		gitTokens?: unknown;
		turnReadTokens?: unknown;
		githubApp?: unknown;
		envValues?: unknown;
		envPlain?: unknown;
		hindsightToken?: unknown;
		hindsightUrl?: unknown;
	};
	/** Restores the run cap and the check toggles; a wrong type keeps the default. */
	function restoreRunConfig(p: StoredConfig): void {
		if (
			p.maxTotal === null ||
			(typeof p.maxTotal === "number" &&
				Number.isInteger(p.maxTotal) &&
				p.maxTotal >= 1)
		) {
			deps.shared.maxTotalRuns = p.maxTotal;
		}
		// Only a real boolean is accepted; anything else keeps the default (true).
		if (typeof p.reviewCheck === "boolean") {
			deps.shared.reviewCheck = p.reviewCheck;
		}
		if (typeof p.workCheck === "boolean") {
			deps.shared.workCheck = p.workCheck;
		}
		if (typeof p.idleReviews === "boolean") {
			deps.shared.idleReviews = p.idleReviews;
		}
		if (typeof p.trendingScan === "boolean") {
			deps.shared.trendingScan = p.trendingScan;
		}
	}
	/** Restores the commit identity; null keeps the built-in Ottr identity and a bad
	 * mapping keeps the default (null). */
	function restoreCommitIdentity(v: unknown): void {
		if (v === null) {
			deps.shared.commitIdentity = null;
		} else if (
			typeof v === "object" &&
			v !== null &&
			"name" in v &&
			"email" in v
		) {
			const name = parseCommitField(v.name, "commitName");
			const email = parseCommitField(v.email, "commitEmail");
			if (
				name.ok &&
				email.ok &&
				typeof name.value === "string" &&
				typeof email.value === "string"
			) {
				deps.shared.commitIdentity = { name: name.value, email: email.value };
			}
		}
	}
	/** Restores the session list; only well-formed entries survive a restore. */
	function restoreSessions(v: unknown): void {
		if (!Array.isArray(v)) return;
		sessions = v.filter(
			(s): s is SessionEntry =>
				typeof s === "object" &&
				s !== null &&
				typeof (s as SessionEntry).id === "string" &&
				(s as SessionEntry).id !== "" &&
				typeof (s as SessionEntry).label === "string" &&
				Number.isFinite((s as SessionEntry).createdAt) &&
				Number.isFinite((s as SessionEntry).lastSeen) &&
				Number.isFinite((s as SessionEntry).exp),
		);
	}
	/** Restores the admin pair, the api key, the session secret, the VAPID keys and the Alate pair. */
	function restoreSecrets(p: StoredConfig): void {
		if (
			typeof p.admin === "object" &&
			p.admin !== null &&
			"name" in p.admin &&
			"passHash" in p.admin &&
			typeof p.admin.name === "string" &&
			typeof p.admin.passHash === "string"
		) {
			admin = { name: p.admin.name, passHash: p.admin.passHash };
		}
		if (typeof p.apiKey === "string") apiKey = loadSecret("apiKey", p.apiKey);
		if (typeof p.sessionSecret === "string")
			sessionSecret = loadSecret("sessionSecret", p.sessionSecret);
		if (
			typeof p.vapid === "object" &&
			p.vapid !== null &&
			"publicKey" in p.vapid &&
			"privateKey" in p.vapid &&
			"subject" in p.vapid &&
			typeof p.vapid.publicKey === "string" &&
			typeof p.vapid.privateKey === "string" &&
			typeof p.vapid.subject === "string"
		) {
			// An unreadable private key leaves vapid null: ensureVapid() regenerates the
			// board-generated pair on the first push path (ADR-0011).
			const privateKey = loadSecret("vapidKey", p.vapid.privateKey);
			if (privateKey !== null) {
				vapid = {
					publicKey: p.vapid.publicKey,
					privateKey,
					subject: p.vapid.subject,
				};
			} else {
				// ADR-0011 recovery: keep the whole stored object (sealed private key +
				// plaintext public key) so a config save writes it back instead of
				// erasing the row, and persist the outgoing key immediately — the kv
				// must exist before any config save can drop the row.
				keptUnreadable.set("vapidKey", p.vapid);
				previousVapidPublicKey = p.vapid.publicKey;
				if (deps.gstore.get<string | null>("push_vapid_key") == null)
					deps.gstore.set("push_vapid_key", previousVapidPublicKey);
			}
		}
		if (typeof p.alate === "object" && p.alate !== null) {
			const a = p.alate as Record<string, unknown>;
			const str = (v: unknown): string | null =>
				typeof v === "string" ? v : null;
			alate = { url: str(a.url), key: loadSecret("alateKey", a.key) };
		}
	}
	/** Restores the git token rows; a malformed row is dropped, a kept-unreadable sealed token stays as an unusable row (ADR-0011). */
	function restoreGitTokens(v: unknown): void {
		if (!Array.isArray(v)) return;
		const toks: StoredGitToken[] = [];
		for (const row of v) {
			if (typeof row !== "object" || row === null) continue;
			const raw = (row as Record<string, unknown>).token;
			if (typeof raw === "string" && isSealed(raw)) {
				// A sealed blob fails parseGitToken's printable 8-512 rule for longer tokens,
				// so the shape check runs on a placeholder and the real token opens below.
				const t = parseGitToken({
					...(row as Record<string, unknown>),
					token: "00000000",
				});
				if ("error" in t) continue;
				const token = loadSecret(`git:${t.host}`, raw);
				toks.push(
					token === null
						? { ...t, token: "", unreadable: true }
						: { ...t, token },
				);
				continue;
			}
			const t = parseGitToken(row as Record<string, unknown>);
			if ("error" in t) continue;
			toks.push(t);
		}
		gitTokens = toks;
	}
	/** Restores the turn read-token rows; a malformed row is dropped, an unreadable stored blob stays as an unusable row (ADR-0011). */
	function restoreTurnReadTokens(v: unknown): void {
		if (!Array.isArray(v)) return;
		const rows: TurnReadTokenRow[] = [];
		for (const row of v) {
			if (typeof row !== "object" || row === null) continue;
			const r = row as Record<string, unknown>;
			if (typeof r.host !== "string" || r.host === "") continue;
			const status: TurnReadTokenRow["status"] =
				r.status === "ok" || r.status === "write" || r.status === "error"
					? r.status
					: // An unknown stored verdict never serves: it reads as an error until
						// the next check re-runs.
						"error";
			rows.push({
				host: r.host,
				token: loadSecret(`turnRead:${r.host}`, r.token),
				status,
				detail: typeof r.detail === "string" ? r.detail : "",
				confirmed: r.confirmed === true,
			});
		}
		turnReadTokens = rows;
	}
	/** Restores the GitHub token, host and the app pair. */
	function restoreGithub(p: StoredConfig): void {
		if (typeof p.githubToken === "string")
			githubToken = loadSecret("githubToken", p.githubToken);
		if (typeof p.githubHost === "string") savedGithubHost = p.githubHost;
		restoreGitTokens(p.gitTokens);
		restoreTurnReadTokens(p.turnReadTokens);
		if (
			typeof p.githubApp === "object" &&
			p.githubApp !== null &&
			"id" in p.githubApp &&
			"key" in p.githubApp
		) {
			const stored = p.githubApp as { id: unknown; key: unknown };
			if (typeof stored.key === "string" && isSealed(stored.key)) {
				// Sealed key: open it, then validate the plaintext like a legacy pair. A key
				// this boot cannot open stays as an unreadable row (ADR-0011): the view keeps
				// the id with a null fingerprint, no token mint is built, and saveConfig
				// re-stores the kept blob until the pair is re-entered.
				const plain = loadSecret("githubAppKey", stored.key);
				if (plain === null) {
					if (typeof stored.id === "string" && /^\d{1,32}$/.test(stored.id))
						githubApp = {
							id: stored.id,
							key: "",
							fingerprint: null,
							unreadable: true,
						};
				} else {
					const v = validateAppCredentials({ ...stored, key: plain });
					if ("error" in v)
						logError(
							"dropping stored GitHub App credentials",
							new Error(v.error),
						);
					else githubApp = v;
				}
				return;
			}
			// A saved pair re-runs validateAppCredentials; a key that no longer parses is
			// dropped like a malformed git token row. The log names the drop, never the key.
			const v = validateAppCredentials(p.githubApp);
			if ("error" in v) {
				logError("dropping stored GitHub App credentials", new Error(v.error));
			} else {
				githubApp = v;
			}
		}
	}
	/** Restores the env values: secrets (a corrupt entry is dropped, a kept-unreadable value is
	 *  skipped, ADR-0011) and plain values (a name off the A_Z format or a non-string value is
	 *  dropped). */
	function restoreEnvValues(p: StoredConfig): void {
		if (typeof p.envValues === "object" && p.envValues !== null) {
			const vals: Record<string, string> = {};
			for (const [name, value] of Object.entries(p.envValues)) {
				if (!ENV_NAME.test(name)) continue;
				const v = loadSecret(`env:${name}`, value);
				if (v !== null) vals[name] = v;
			}
			deps.shared.envValues = vals;
		}
		if (typeof p.envPlain === "object" && p.envPlain !== null) {
			const plain: Record<string, string> = {};
			for (const [name, value] of Object.entries(p.envPlain))
				if (ENV_NAME.test(name) && typeof value === "string")
					plain[name] = value;
			deps.shared.envPlain = plain;
		}
	}
	/** Restores the memory token and URL; a wrong type keeps the default. */
	function restoreHindsight(p: StoredConfig): void {
		if (typeof p.hindsightToken === "string")
			hindsightToken = loadSecret("hindsightToken", p.hindsightToken);
		if (typeof p.hindsightUrl === "string") hindsightUrl = p.hindsightUrl;
	}
	/** Boot config load: reads the stored "config" row, validates every field (a wrong type keeps the default), seeds the Alate URL/key from the compose env, and re-applies the GitHub token/host. */
	function loadStoredConfig(): void {
		const parsed = deps.gstore.get<StoredConfig>("config");
		if (parsed !== null) {
			restoreRunConfig(parsed);
			restoreCommitIdentity(parsed.commitIdentity);
			restoreSessions(parsed.sessions);
			restoreSecrets(parsed);
			restoreGithub(parsed);
			restoreEnvValues(parsed);
			restoreHindsight(parsed);
		}
		// Compose pairing (docker-compose.yml, the `alate` profile): with empty Settings the
		// boot seeds the Alate URL and key from ALATE_URL and ALATE_API_KEY, the way
		// HINDSIGHT_API_URL seeds the memory backend. A value saved under Settings -> Alate
		// wins at every boot, and a saved null clears the seed until the next boot. The key
		// never reaches a log or a view: alateView reports keySet only; GET /api/settings/alate-key
		// is the one route that returns it. A seed that alateUrlError refuses is dropped and logged.
		if (alate.url === null) {
			const seedUrl = process.env.ALATE_URL?.trim();
			if (seedUrl) {
				const stripped = seedUrl.replace(/\/+$/, "");
				const refused = alateUrlError(stripped);
				if (refused === null) alate.url = stripped;
				else console.warn(`alate: refusing the ALATE_URL seed: ${refused}`);
			}
		}
		// A kept-unreadable alate key blob means the saved value wins over the env seed
		// until it is re-entered (ADR-0011): seeding here would silently overwrite the
		// saved pairing the board cannot read this boot.
		if (alate.key === null && !keptUnreadable.has("alateKey")) {
			const seedKey = process.env.ALATE_API_KEY?.trim();
			if (seedKey) alate.key = seedKey;
		}
		applyGithubToken();
		// A saved host wins over the env at every boot; a clear restored the boot value already.
		applyGithubHost();
		// Every git/ssh/env output the board logs or shows passes redact() with these: the stored
		// tokens, the ssh dir (which holds every key path, in both slash forms, since
	}
	// GIT_SSH_COMMAND names it with forward slashes) and the secret env values. Kept in sync
	// on each token or env change.
	function applyGitSecrets(): void {
		// Kept-unreadable rows contribute nothing: an empty token and no app key are never
		// credentials (ADR-0011).
		setGitSecrets([
			...gitTokens.filter((t) => t.unreadable !== true).map((t) => t.token),
			// The app's PEM key redacts out of every git/gh log line and error text.
			...(githubApp === null || githubApp.unreadable === true
				? []
				: [githubApp.key]),
			...Object.values(deps.shared.envValues),
			sshDir,
			sshDir.replaceAll("\\", "/"),
		]);
	}
	applyGitSecrets();
	// A boot-adopted app pair gets its token mint here; a route save/reset rebuilds it.
	// An unreadable stored key builds none: parseAppPem would reject the empty key, and
	// the mint must never run on a credential this boot cannot read.
	if (githubApp !== null && githubApp.unreadable !== true) {
		const pem = parseAppPem(githubApp.key);
		if (pem !== null)
			appTokens = new AppTokenSource({
				appId: githubApp.id,
				keyObject: pem.keyObject,
				fetchImpl: githubAppFetch,
			});
	}
	// OTTR-875: the board token also serves server-side git on the configured GitHub host
	// when Settings → Other git hosts has no token for it, so a GitHub Enterprise board
	// needs one token, not two. A stored token for the host wins, github.com keeps its
	// GH_TOKEN helper path (the image pins that one), and no other host ever sees the
	// token: gitAuthEnv scopes the helper to credential.https://<host>, so only a git
	// call to that host reads it. Kept-unreadable stored rows are no credential, so the
	// board token still covers the host when only those remain (ADR-0011).
	function boardGitToken(): GitToken | null {
		const h = githubHost();
		if (h.isDefault || githubToken === null) return null;
		if (gitTokens.some((t) => t.host === h.host && t.unreadable !== true))
			return null;
		const cand = parseGitToken({ host: h.host, token: githubToken });
		return "error" in cand ? null : cand;
	}
	/** The credential rows for one https git call: the readable stored tokens, plus the
	 * board token when it covers the configured host. One builder for the resolver (D6)
	 * and the Add-project clone (hostedCloneEnv), so the clone gets exactly the list the
	 * resolver promises. Kept-unreadable rows stay out (ADR-0011): their helper would
	 * answer with an empty password, and git stops at the first helper that answers, so
	 * it would shadow a board-token helper for the same host. */
	function networkGitTokens(): GitToken[] {
		const board = boardGitToken();
		return [
			...gitTokens.filter((t) => t.unreadable !== true),
			...(board === null ? [] : [board]),
		];
	}
	// D6: every network git call (clone/fetch/ls-remote/pull/push, merge turns included) picks
	// up the auth of the project that owns cwd. Workers get none of these names: the runner
	// strips them from the env it forwards (GIT_AUTH_ENV_RE in src/worktree.ts).
	setNetworkGitAuth((cwd) => {
		const paths = sshPaths(sshDir);
		let key = existsSync(paths.global) ? paths.global : null;
		for (const e of deps.projects.values()) {
			if (cwd === e.path || cwd.startsWith(e.path + sep)) {
				// A project key beats the global one; a project without one falls back.
				const own = projectKeyPath(e.name);
				if (own !== "" && existsSync(own)) key = own;
				break;
			}
		}
		return gitAuthEnv({
			ambientHelpers,
			tokens: networkGitTokens(),
			key,
			knownHosts: paths.knownHosts,
		});
	});
	// Hosted mode (docs/specs/hosted-mode.md section 6): network git takes the token the control
	// plane mints for the project that owns cwd, in place of the resolver above. Always set, so
	// a self-hosted app never keeps the hosted auth of an earlier app in the same process.
	setHostedGitAuth(
		deps.hosted === undefined
			? null
			: createHostedGitAuth({
					gitToken: deps.hosted.hooks.gitToken.bind(deps.hosted.hooks),
					projectFor: (cwd) => {
						for (const e of deps.projects.values())
							if (cwd === e.path || cwd.startsWith(e.path + sep))
								return {
									name: e.name,
									originUrl: e.store.getSettings().originUrl,
								};
						return null;
					},
					knownHosts: sshPaths(sshDir).knownHosts,
					log: logError,
				}),
	);
	try {
		applyHindsight();
	} catch (err) {
		// The saved URL and key stay in effect over the env; only the seeding failed.
		logError("hindsight env seed", err);
	}
	// Boot + interval (src/server.ts), never per turn (docs/specs/memory-backend.md).
	void memoryHealthTick();
	// OTTR-548: the workers' sign-in self-reports boot + interval (src/server.ts), advisory only.
	void workerSignInTick();
	const logins = providerLogin();

	// NODE_ENV=development keeps Bun's HTML dev server (HMR, /_bun/… paths); every other
	// value serves the boot-built bundle from memory with precompressed variants
	// (docs/specs/compressed-serving.md). bun test runs with NODE_ENV unset and gets the
	// bundle path, so the serving behavior is integration-tested.
	const devUi = process.env.NODE_ENV === "development";
	// Warm the build while the rest of createApp runs; the routes await the same memoized promise.
	if (!devUi)
		boardBundle().catch((err) =>
			console.error(`[boot] ui bundle failed: ${errmsg(err)}`),
		);
	// json() needs the request's Accept-Encoding but its ~200 call sites pass none, so
	// api() plants it here per request; concurrent requests cannot cross encodings.
	const requestEnc = new AsyncLocalStorage<{ enc: string | null }>();

	/** Static asset extensions: a view-route path ending in one is a wrong asset
	 *  URL, not a client view (OTTR-756) — it must 404 visibly, not serve the app
	 *  HTML as an image. */
	const ASSET_PATH =
		/\.(?:png|jpe?g|gif|webp|avif|svg|ico|js|mjs|css|map|woff2?|ttf|otf|eot|json|txt|xml|webmanifest)$/i;

	/** The board HTML from the memory bundle, 304-aware; build failure answers 500 (spec "Error cases").
	 *  An asset-like path that lands on a view route answers 404 instead. */
	async function boardHtml(req: Request): Promise<Response> {
		if (ASSET_PATH.test(new URL(req.url).pathname))
			return json({ error: "not found" }, 404);
		try {
			return bundleResponse((await boardBundle()).html, req);
		} catch (err) {
			return new Response(`ui bundle failed: ${errmsg(err)}`, {
				status: 500,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}
	}

	/** A hashed bundle output by URL path, or null when the path is not one (dev mode: always null). */
	async function boardAsset(req: Request): Promise<Response | null> {
		if (devUi) return null;
		try {
			const asset = (await boardBundle()).assets.get(new URL(req.url).pathname);
			return asset === undefined ? null : bundleResponse(asset, req);
		} catch (err) {
			return new Response(`ui bundle failed: ${errmsg(err)}`, {
				status: 500,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}
	}

	function json(
		v: unknown,
		status = 200,
		extra: Record<string, string> = {},
	): Response {
		// Connection: close works around a Bun 1.3.14 Windows bug: while an agent turn runs, a request
		// that arrives on a reused keep-alive connection is not dispatched until the agent's process
		// exits, so the "Add task" spinner spins for the length of a turn. Fresh connections dispatch
		// fine, so the browser must never reuse one. The WebSocket is unaffected.
		const text = JSON.stringify(v);
		const headers: Record<string, string> = {
			...extra,
			"Content-Type": "application/json",
			// Encodings differ per request even below the threshold, where the same URL
			// can cross the size line later: caches must key on Accept-Encoding.
			Vary: "Accept-Encoding",
			Connection: "close",
		};
		if (
			Buffer.byteLength(text, "utf8") >= 32 * 1024 &&
			acceptsGzip(requestEnc.getStore()?.enc ?? null)
		) {
			return new Response(gzipSync(Buffer.from(text, "utf8")), {
				status,
				headers: { ...headers, "Content-Encoding": "gzip" },
			});
		}
		return new Response(text, { status, headers });
	}

	/** Like json(), but with Cache-Control: no-store — for responses that carry a secret. */
	function secretJson(v: unknown, status = 200): Response {
		return new Response(JSON.stringify(v), {
			status,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				Connection: "close",
			},
		});
	}

	/** Optional `model` from a task-creating body: trimmed selector or null; a 400 Response when it is not a string. */
	function modelParam(body: Record<string, unknown>): string | null | Response {
		const m = body.model;
		if (m === undefined || m === null) return null;
		if (typeof m !== "string")
			return json({ error: "model must be a string" }, 400);
		return m.trim().slice(0, 200) || null;
	}

	/** 400 for a card model that would park the card's first turn, or null when it may file.
	 *  cardModelError holds the rule (shape plus catalog, src/models.ts); an empty catalog
	 *  (omp missing) still refuses a selector that names no provider. */
	async function cardModelResponse(
		model: string | null,
	): Promise<Response | null> {
		if (model === null) return null;
		const catalog = new Set(
			(await (deps.models ?? modelList)()).map((m) => m.selector),
		);
		const why = cardModelError(model, catalog);
		return why === null ? null : json({ error: why }, 400);
	}

	// PWA statics: the manifest lists icons by URL, and Bun's HTML bundler would hash those away,
	// so they are served at stable root paths straight from the ui directory. The icons change
	// only with a new name in the manifest, so they cache for a day (OTTR-662 tip 27); the
	// manifest itself can change at any deploy, so it keeps no cache header.
	const PWA_FILES: Record<string, [string, string, string | null]> = {
		"/manifest.webmanifest": [
			"manifest.webmanifest",
			"application/manifest+json",
			null,
		],
		"/icon-192.png": ["icon-192.png", "image/png", "public, max-age=86400"],
		"/icon-512.png": ["icon-512.png", "image/png", "public, max-age=86400"],
		"/icon-512-maskable.png": [
			"icon-512-maskable.png",
			"image/png",
			"public, max-age=86400",
		],
	};
	function pwaFile(url: string): Response {
		const hit = PWA_FILES[url];
		if (hit === undefined) return json({ error: "not found" }, 404);
		const [name, type, cache] = hit;
		return new Response(Bun.file(join(import.meta.dir, "ui", name)), {
			headers: {
				"Content-Type": type,
				...(cache !== null && { "Cache-Control": cache }),
			},
		});
	}

	// The workflow overview diagrams that the drawer's Workflow modal embeds (the README shows
	// them too). They sit in src/ui like the PWA files: the image copies only src and extension.
	// Their names are stable, so they cache for a day like the PWA icons (OTTR-662 tip 27).
	const WORKFLOW_FILES: Record<string, string> = {
		"/workflow-task.svg": "workflow-task.svg",
		"/workflow-review.svg": "workflow-review.svg",
		"/workflow-release.svg": "workflow-release.svg",
	};
	function workflowFile(url: string): Response {
		const name = WORKFLOW_FILES[url];
		if (name === undefined) return json({ error: "not found" }, 404);
		return new Response(Bun.file(join(import.meta.dir, "ui", name)), {
			headers: {
				"Content-Type": "image/svg+xml",
				"Cache-Control": "public, max-age=86400",
			},
		});
	}

	// OTTR-719: the versioned mermaid bundle (see mermaidCompressed above). Identity requests
	// stream the dist file from disk; br and gzip requests await the one-time compression and
	// serve the in-memory bytes. Old-path clients get a permanent redirect so tabs still
	// running the pre-rename board bundle keep loading diagrams after a deploy; the redirect
	// itself stays cacheable for a day, so a future path change propagates within a day.
	const mermaidHeaders = {
		"Content-Type": "text/javascript; charset=utf-8",
		"Cache-Control": "public, max-age=31536000, immutable",
		Vary: "Accept-Encoding",
	};
	function mermaidResponse(req: Request): Promise<Response> {
		const encoding = pickEncoding(req.headers.get("accept-encoding"));
		if (encoding === "identity")
			return Promise.resolve(
				new Response(Bun.file(mermaidRawPath), { headers: mermaidHeaders }),
			);
		return mermaidCompressed().then(
			(bodies) =>
				new Response(encoding === "br" ? bodies.br : bodies.gzip, {
					headers: { ...mermaidHeaders, "Content-Encoding": encoding },
				}),
		);
	}
	// Compression runs once per process (memoized at module scope); kick it off at boot so the
	// first Diagrams open never waits for brotli.
	void mermaidCompressed();

	/**
	 * The board's address for turns when no allowlist covers it (compose: ottr:<port>); null on
	 * loopback and public hosts, where turns reach the board through the normal guards.
	 */
	const agent = (() => {
		if (deps.board === undefined) return null;
		const u = new URL(deps.board.url);
		if (hostRefusal(u.host, deps.port, deps.publicHosts) === null) return null;
		return { host: u.host, origin: u.origin, token: deps.board.token };
	})();

	/** True when the request arrived under the turns' own host (see agent). */
	function viaAgentHost(req: Request): boolean {
		const host = req.headers.get("host");
		return agent !== null && host !== null && hostMatches(host, [agent.host]);
	}

	/**
	 * A card starts an agent run, so the turns' host files cards (and the trending scout's
	 * verdicts, which file proposal cards) and nothing else, and only with the boot token every
	 * task session carries (OTTR_BOARD_TOKEN): anyone else who reaches the port gets 401. A
	 * microVM turn (OTTR-532) holds no boot token: its live per-turn VM token files cards in
	 * its own project only, and no trending verdicts. Hosted mode passes the boot token itself:
	 * there the token, not the Host, routes a turn here (see hostedRefusal).
	 */
	function agentRefusal(
		req: Request,
		bootToken: string | undefined = agent?.token,
	): Response | null {
		const token = req.headers.get("x-board-token");
		const boot =
			bootToken !== undefined &&
			token !== null &&
			secretsEqual(token, bootToken);
		const vm = boot ? null : (deps.vmTokens?.check(token) ?? null);
		if (!boot && vm === null) return json({ error: "unauthorized" }, 401);
		const path = new URL(req.url).pathname;
		const m = /^\/api\/projects\/([^/]+)\/(tasks|trending\/verdicts)$/.exec(
			path,
		);
		if (req.method !== "POST" || m === null)
			return json({ error: "this host only files cards" }, 403);
		if (vm !== null) {
			const refused = vmCardRefusal(m, vm.project);
			if (refused !== null) return refused;
		}
		return null;
	}
	/** A live VM token files cards in its own project only; null lets the request pass. */
	function vmCardRefusal(
		m: RegExpExecArray,
		vmProject: string,
	): Response | null {
		let project: string | null = null;
		try {
			project = decodeURIComponent(m[1] ?? "");
		} catch {
			// a malformed escape names no project
		}
		if (m[2] !== "tasks" || project !== vmProject)
			return json(
				{ error: "this token files cards only in its own project" },
				403,
			);
		return null;
	}

	/** OTTR-850: true when the request carries a live board or VM token, so the card it
	 * files is agent-written (the extension's create_task), never the user's New task
	 * form. The server reads the token itself; no client flag decides authorship. */
	function agentCardRequest(req: Request): boolean {
		const token = req.headers.get("x-board-token");
		if (token === null) return false;
		if (deps.board !== undefined && secretsEqual(token, deps.board.token))
			return true;
		return (deps.vmTokens?.check(token) ?? null) !== null;
	}

	/**
	 * OTTR-532: microVM turns reach git, their provider gateway and memory with their per-turn
	 * VM token, outside api() (no session, no host allowlist): each handler refuses any other
	 * caller. A live token lifts Bun's idle cut for its request, since clones, pushes and model
	 * streams can stay quiet past 120 s.
	 */
	function vmRoute(
		req: Request,
		server: Server<undefined>,
		fn: (tokens: VmTokens) => Promise<Response>,
	): Promise<Response> {
		const tokens = deps.vmTokens;
		if (tokens === undefined)
			return Promise.resolve(json({ error: "not found" }, 404));
		if (tokens.check(vmTokenOf(req)) !== null) server.timeout(req, 0);
		return fn(tokens).catch((err) => {
			logError(`vm ${req.method} ${new URL(req.url).pathname}`, err);
			return json({ error: "internal error" }, 500);
		});
	}

	/** The non-hosted walls for one /api request: the agent-host token wall, the host
	 *  allowlist, and the auth wall (session or API key). Null lets the request pass. */
	function wallRefusal(req: Request, host: string | null): Response | null {
		if (viaAgentHost(req)) return agentRefusal(req);
		const refusal = hostRefusal(host, deps.port, deps.publicHosts);
		if (refusal !== null) return json({ error: refusal }, 403);
		// The auth wall: public hosts, and any peer whose connection is not direct loopback
		// (see walled). Desktop loopback and the board's own container stay zero-auth: local
		// agent processes talk over loopback, so they never present a session or key.
		if (walled(req)) {
			const path = new URL(req.url).pathname;
			const open =
				path === "/api/boot" ||
				path === "/api/setup" ||
				path === "/api/login" ||
				path === "/api/logout";
			if (!open && !authorized(req))
				return json({ error: "unauthorized" }, 401);
		}
		return null;
	}

	/** Guards every /api request (host allowlist + auth wall); wraps handlers so unexpected errors become 500. */
	function api(
		req: Request,
		fn: () => Promise<Response>,
		opts: { costly?: boolean } = {},
	): Promise<Response> {
		// OTTR-715: a handler that runs at least slowApiMs logs one line with its route
		// pattern (`api slow: GET /api/projects/:project/tasks/:id/log took 612ms`), so a
		// slow endpoint shows up in the board log without ids or query values. The wall
		// refusals below run no handler and stay untimed; guarded's own catch/finally
		// (error 500, publishSoon) is chained onto unchanged.
		const timed = () => {
			const started = performance.now();
			return guarded(req, fn).finally(() => {
				const ms = performance.now() - started;
				if (ms >= slowApiMs)
					console.warn(
						`api slow: ${req.method} ${routePattern(new URL(req.url).pathname)} took ${Math.round(ms)}ms`,
					);
			});
		};
		if (deps.hosted !== undefined) {
			const refused = hostedRefusal(deps.hosted, req);
			return refused !== null ? Promise.resolve(refused) : timed();
		}
		// Mutations pass the Origin wall first (R1-2): a cross-site POST must never reach a
		// handler, and a request that fails both checks answers "forbidden origin".
		if (req.method !== "GET") {
			const originRefused = originWall(req);
			if (originRefused !== null) return Promise.resolve(originRefused);
		}
		const wall = wallRefusal(req, req.headers.get("host"));
		if (wall !== null) return Promise.resolve(wall);
		// The costly-route cap runs after every wall: unauthorized or wrong-origin traffic
		// burns nothing, and a blocked request never reaches the handler.
		if (opts.costly === true) {
			const limited = costlyRefusal(req);
			if (limited !== null) return Promise.resolve(limited);
		}
		return timed();
	}

	/**
	 * The per-source cap for the costly routes (docs/specs/public-api-request-limit.md):
	 * public-host requests only — loopback desktop use stays unlimited, and hosted mode
	 * walls it off entirely (every tenant arrives from the proxy peer, so one key would
	 * bucket tenants together). Runs after the walls, before the handler.
	 */
	function costlyRefusal(req: Request): Response | null {
		if (!viaPublicHost(req)) return null;
		const source = requestSource(req, deps.serverRef.current);
		const verdict = costlyLimiter.admit(source);
		if (verdict.ok) return null;
		console.warn(
			`api limit: ${req.method} ${routePattern(new URL(req.url).pathname)} is over the costly-route cap (Retry-After ${verdict.retryAfterS}s)`,
		);
		return json({ error: "too many costly requests, try again later" }, 429, {
			"Retry-After": String(verdict.retryAfterS),
		});
	}

	/** Runs a handler whose request passed the walls (see api()); unexpected errors become 500. */
	function guarded(
		req: Request,
		fn: () => Promise<Response>,
	): Promise<Response> {
		// Every mutation that reaches a handler counts as input for the idle clock
		// (docs/specs/mutation-delta.md §7): the walls passed, so the request is real.
		if (req.method !== "GET") lastInputAt = now();
		return requestEnc.run({ enc: req.headers.get("accept-encoding") }, () =>
			fn()
				.catch((err) => {
					logError(`api ${req.method} ${new URL(req.url).pathname}`, err);
					return json({ error: "internal error" }, 500);
				})
				// Mutations (POST/PUT/DELETE) may change the board: push a state diff after the response.
				.finally(() => {
					if (req.method !== "GET") publishSoon();
				}),
		);
	}

	/** Routes hosted mode answers 404 for, whoever asks (docs/specs/hosted-mode.md section 3): the
	 *  proxy owns sign-in, so the board's own login, API key, session registry and provider
	 *  sign-ins are off. */
	const HOSTED_OFF_ROUTE =
		/^\/api\/(setup|login|logout|settings\/(api-key|session-secret|sessions(\/[^/]*)?)|provider-login(\/.*)?)$/;

	/** Hosted mode's one nonce cache: a replayed X-Ottr-Identity header never passes twice. */
	const identityNonces = new NonceCache();

	/** Hosted forwarded GitHub events: bounded dedupe of X-GitHub-Delivery ids (section 8). */
	const deliveries = new DeliveryCache();

	/** Hosted mode's turn-token path (no signed identity, a board token present): the agent
	 *  rules — the Origin wall for mutations, then the boot/VM token wall. */
	function hostedAgentRefusal(req: Request): Response | null {
		if (req.method !== "GET") {
			const originRefused = originWall(req);
			if (originRefused !== null) return originRefused;
		}
		return agentRefusal(req, deps.board?.token);
	}

	/**
	 * Hosted mode's whole wall (docs/specs/hosted-mode.md section 3), in place of the host
	 * allowlist, Origin wall and auth wall: the control-plane proxy checks Host, Origin and the
	 * SSO session before it signs. Only a signed identity or a turn's token passes; the loopback
	 * bypass, session cookies and X-API-Key grant nothing. null lets the request through.
	 */
	function hostedRefusal(hosted: Hosted, req: Request): Response | null {
		const header = req.headers.get(IDENTITY_HEADER);
		// A turn holds no identity, only its boot or VM token: the agent rules of today apply.
		if (header === null && req.headers.get("x-board-token") !== null)
			return hostedAgentRefusal(req);
		const id = verifyIdentity(header, {
			secret: hosted.config.secret,
			tenant: hosted.config.tenant,
			nonces: identityNonces,
		});
		if (!id.ok) return json({ error: "unauthorized" }, 401);
		const path = new URL(req.url).pathname;
		if (HOSTED_OFF_ROUTE.test(path)) return json({ error: "not found" }, 404);
		// tenant signs this board's own calls out and is never valid inbound; control reaches
		// only its /api/hosted/ routes, and owner everything else.
		const control = path.startsWith("/api/hosted/");
		if (id.role === "tenant" || (id.role === "control") !== control)
			return json({ error: "forbidden" }, 403);
		return null;
	}

	/** Valid session cookie or matching X-API-Key; checked only behind the auth wall (see api()). */
	function authorized(req: Request): boolean {
		const key = req.headers.get("x-api-key");
		if (key !== null && apiKey !== null && secretsEqual(key, apiKey))
			return true;
		if (sessionSecret === null) return false;
		const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
		if (token === undefined) return false;
		const v = verifySession(sessionSecret, token);
		if (v === null) return false;
		// Legacy tokens carry no id and stay valid until natural expiry. A signed id must
		// still have its registry entry; coarse lastSeen persists at most once per minute.
		if (v.id === null) return true;
		const entry = sessions.find((s) => s.id === v.id);
		if (entry === undefined) return false;
		const now = Date.now();
		if (now - entry.lastSeen >= 60_000) {
			entry.lastSeen = now;
			saveConfig();
		}
		return true;
	}

	/** True when the request arrived under a public host (HTTPS via tailscale serve). */
	function viaPublicHost(req: Request): boolean {
		const host = req.headers.get("host");
		return host !== null && hostMatches(host, deps.publicHosts);
	}

	/**
	 * The one auth-wall rule (api() and the /api/ws upgrade share it, R2-8): public hosts are
	 * walled, and so is any peer whose connection is not direct loopback. tailscale serve
	 * forwards from 127.0.0.1 with X-Forwarded-For/-Host set (R2-1), and compose's published
	 * port arrives from the Docker gateway, so neither counts as loopback, whatever Host header
	 * it sends. An unknown peer counts as remote. `server` is the listener the request came
	 * in on: the omp stats proxy port passes its own, since requestIP knows only its own sockets.
	 */
	function walled(
		req: Request,
		server: Server<undefined> | undefined = deps.serverRef.current,
	): boolean {
		return (
			viaPublicHost(req) ||
			!directLoopback(server?.requestIP(req)?.address, req.headers)
		);
	}

	/**
	 * The CSRF wall for mutations (R1-2): a cross-site `fetch(u, {method:"POST", mode:"no-cors"})`
	 * is a simple request that ships no preflight, and loopback has no auth to stop it, so the
	 * Origin allowlist is the only defense. api() checks it once for every non-GET /api request,
	 * so a future POST without a body cannot forget it. The turns' own host answers its own
	 * origin: there the boot token, not the Origin, authenticates.
	 */
	function originWall(req: Request): Response | null {
		const origin = req.headers.get("origin");
		const agentOrigin =
			viaAgentHost(req) && origin?.toLowerCase() === agent?.origin;
		if (
			!agentOrigin &&
			originRefusal(origin, deps.port, deps.publicHosts) !== null
		)
			return json({ error: "forbidden origin" }, 403);
		return null;
	}

	/** JSON response with the session cookie attached. */
	function withCookie(res: Response, cookie: string): Response {
		res.headers.append("Set-Cookie", cookie);
		return res;
	}

	/** Reads the whole body stream, cancelling the source past `maxBytes`. */
	async function readBody(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		maxBytes: number,
	): Promise<{ chunks: Uint8Array[]; size: number } | { error: Response }> {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return { error: json({ error: "body too large" }, 413) };
			}
			chunks.push(value);
		}
		return { chunks, size };
	}

	/** Reads a body with a streamed byte cap; readJson parses on top of it. `req.text()` would
	 * buffer a chunked (no Content-Length) body unbounded before the size check, so an
	 * unauthenticated client can exhaust memory (R1-2). Cancel the source at the cap. */
	async function readBytes(
		req: Request,
		maxBytes: number,
	): Promise<{ bytes: Uint8Array } | { error: Response }> {
		const declared = Number(req.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes)
			return { error: json({ error: "body too large" }, 413) };
		const reader = req.body?.getReader();
		if (reader === undefined) return { bytes: new Uint8Array(0) };
		const read = await readBody(reader, maxBytes);
		if ("error" in read) return read;
		const out = new Uint8Array(read.size);
		let at = 0;
		for (const c of read.chunks) {
			out.set(c, at);
			at += c.byteLength;
		}
		return { bytes: out };
	}

	type JsonBody = { body: Record<string, unknown> } | { error: Response };

	/** Validates a POST request per the security contract and parses its JSON body.
	 *  `emptyAsAbsent` reads a zero-length body as `{}` for the optional-body routes:
	 *  body-less callers may send the JSON header with no bytes at all, and that is an
	 *  absent body, not a malformed one. */
	async function readJson(
		req: Request,
		maxBytes = MAX_BODY_BYTES,
		emptyAsAbsent = false,
	): Promise<JsonBody> {
		const ct = req.headers.get("content-type") ?? "";
		if (!ct.startsWith("application/json"))
			return {
				error: json({ error: "content-type must be application/json" }, 415),
			};
		// The Origin check lives in api() (originWall): it must cover POSTs that never call
		// readJson too (R1-2).
		const read = await readBytes(req, maxBytes);
		if ("error" in read) return read;
		if (emptyAsAbsent && read.bytes.length === 0) return { body: {} };
		const text = new TextDecoder().decode(read.bytes);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { error: json({ error: "invalid JSON body" }, 400) };
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { error: json({ error: "body must be a JSON object" }, 400) };
		}
		return { body: parsed as Record<string, unknown> };
	}

	/** Body of a POST whose JSON body is optional: an absent body (no bytes at all,
	 * whatever the headers say) reads as an empty body, so body-less callers (the
	 * extension's steer cancel) keep today's behavior. An arriving body still goes
	 * through the full parse-and-size contract: malformed or oversized bytes surface
	 * the parser's error instead of degrading to an unconditional write. */
	async function readOptionalJson(
		req: Request,
	): Promise<{ body: Record<string, unknown> } | { error: Response }> {
		if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
			return { body: {} };
		return readJson(req, MAX_BODY_BYTES, true);
	}

	function projectView(e: Entry): ProjectView {
		const file = iconFile(e.store.tasksDir);
		const icon = file
			? statSync(file, { throwIfNoEntry: false })?.mtimeMs
			: undefined;
		const settings = e.store.getSettings();
		return {
			name: e.store.name,
			icon: icon ?? null,
			path: e.path,
			sessionsDir: e.store.sessionsDir,
			hasRules: hasRules(e.path, e.targetRules === true),
			target: e.target,
			gitless: e.gitless,
			dirty: e.dirty,
			mainBranch: e.mainBranch,
			mainUnpushed: e.mainUnpushed,
			github: e.github,
			vmRunner: vmState.health,
			githubHostNotice: gheNoticeHost(e.remote, configuredGithubHostname()),
			prModeSuggestion: e.protectedTarget === true && settings.prMode !== true,
			remote: e.remote,
			latestRelease: e.latestRelease,
			latestReleaseUrl: e.latestReleaseUrl ?? null,
			latestImage: e.latestImage,
			archReview: e.archReview,
			openPrs: e.openPrs ?? null,
			settings,
			taskPrefix: settings.taskIdPrefix ?? derivedTaskPrefix(e.name),
		};
	}

	/** One cache per app instance: two trackers (or two test apps) never share a snapshot. */
	const orphanSnapshot = orphanCache();

	/** Why Create release is off for a repo whose latest GitHub release is not vX.Y.Z: Ottr's
	 * release flow only speaks vX.Y.Z, so no version is computed and no release card starts. */
	const nonSemVerBlock = (name: string): string =>
		`Latest GitHub release "${name}" is not vX.Y.Z; Ottr cannot create the next release for this repo.`;

	/** Agent processes no live turn claims, cached for a few minutes; advisory only, never killed. */
	function currentOrphanScan(): {
		orphans: OrphanProcess[];
		error: string | null;
	} {
		const scan = orphanSnapshot(
			() => (deps.listProcesses ?? (() => platform.listProcesses()))(),
			() => {
				const claimed = new Set<number>();
				for (const pid of deps.claimedPids()) claimed.add(pid);
				return claimed;
			},
			Date.now(),
		);
		const projects: OrphanProject[] = [...deps.projects.values()].map((e) => ({
			name: e.name,
			path: e.path,
			sessionsDir: e.store.sessionsDir,
		}));
		return {
			orphans: scan.orphans.map((p) =>
				orphanView(
					p,
					platform.cwdOf(p.pid),
					projects,
					platform.samePath,
					// A worktree card id counts only when that store still has the card.
					(project, card) => {
						const e = project === null ? undefined : deps.projects.get(project);
						return e !== undefined && e.store.getTask(card) !== null;
					},
				),
			),
			error: scan.error,
		};
	}

	/** Until when an update holds new turns (POST /api/drain); 0 or past means no hold. */
	let drainUntil = 0;
	/** Sanitized commit subjects the pending update brings; valid only while drainUntil holds. */
	let drainCommits: string[] = [];
	/** OTTR-454 per-runner holds (worker hostname or "local") from POST /api/drain {runner};
	 * in-memory like drainUntil, no commit subjects, never shown in the notice bar. */
	const runnerDrains = new Map<string, number>();
	const updateCycle = new UpdateCycleController();

	/** A failed reader is not proof that the board is idle. */
	function updateCycleIdle(): boolean {
		try {
			const turns = deps.runnerTurns?.();
			if (turns === undefined) return false;
			const counts = [
				turns.local,
				turns.preparing,
				...Object.values(turns.workers),
			];
			if (!counts.every((count) => Number.isSafeInteger(count) && count === 0))
				return false;
			for (const e of deps.projects.values())
				if (
					e.store
						.listTasks()
						.some(
							(task) => task.state === "running" || task.state === "preparing",
						)
				)
					return false;
			return true;
		} catch {
			return false;
		}
	}

	function updateCycleView(now: number): UpdateCycleView | null {
		if (deps.hosted !== undefined) return null;
		const cycle = updateCycle.view(now, false);
		if (cycle?.phase === "idle") cycle.canStart = updateCycleIdle();
		return cycle;
	}

	/** The trending scout's open proposals: proposal card id → repo (one map per project, not
	 *  a lookup per card). */
	function trendingReposOf(e: Entry): Map<string, string> {
		const repos = new Map<string, string>();
		for (const v of e.store.listTrendingVerdicts())
			if (v.verdict === "filed" && v.proposalCardId !== null)
				repos.set(v.proposalCardId, v.repo);
		return repos;
	}
	/** The kept-worktree counters one needs_you card adds (see boardCards). */
	function keptCounts(
		t: ListedTask,
		now: number,
		days: number,
	): { held: number; stale: number } {
		if (
			t.state !== "needs_you" ||
			!isKeptReason(t.needsReason) ||
			t.worktree === null
		)
			return { held: 0, stale: 0 };
		return {
			held: 1,
			stale: now - t.updatedAt > days * 86_400_000 ? 1 : 0,
		};
	}
	/** A running card's live turn facts: run start and the median-based eta. Between finish
	 * and the next poll no turn is open: neither ships. */
	function runStartedOf(
		t: ListedTask,
		tf: BoardTurnFacts | undefined,
		medians: Map<string, number>,
	): Pick<TaskCard, "runStartedAt" | "etaMs"> {
		const extra: Pick<TaskCard, "runStartedAt" | "etaMs"> = {};
		if (t.state !== "running") return extra;
		const live = tf?.openTurn ?? undefined;
		if (live === undefined) return extra;
		extra.runStartedAt = live.startedAt;
		const ms = medians.get(turnMedianKey(live.kind, live.model));
		if (ms !== undefined) extra.etaMs = ms;
		return extra;
	}
	/** One card's TaskCard: per-task turn facts and stored titles batched by the caller
	 * (two queries per project instead of three statements and a no-op UPDATE per card,
	 * OTTR-721). */
	function taskCardOf(
		e: Entry,
		t: ListedTask,
		ctx: {
			facts: {
				turns: Map<string, BoardTurnFacts>;
				titles: Map<string, string | null>;
				pr: Map<string, { draft: number | null; comments: number | null }>;
			};
			medians: Map<string, number>;
			trendingRepos: Map<string, string>;
			settings: ProjectSettings;
		},
		now: number,
	): TaskCard {
		const {
			details: _details,
			report: _report,
			diffFiles: _diffFiles,
			...card
		} = t;
		const progress = deps.progressOf?.(e.store.name, t.id);
		const silent = silentSince(
			t,
			e.store.logPath(t.id),
			now,
			// Live progress movement counts as activity like a log write: a Stryker
			// run whose meter moves keeps a silent log from warning (OTTR-448).
			progress?.at,
		);
		const tf = ctx.facts.turns.get(t.id);
		return {
			...card,
			steps: viewSteps(t),
			sessionTitle: e.store.frozenTitleFrom(
				t,
				ctx.facts.titles.get(t.id) ?? null,
			),
			answered:
				t.stage === "done" && !isRetro(t) && tf?.lastWorkOutcome === "answered",
			// A default card pins no model; the chip states what the last run actually used.
			...(t.model === null ? { lastModel: tf?.lastModel ?? null } : {}),
			...(progress ? { progress: progress.text } : {}),
			...(silent !== null ? { silentSince: silent } : {}),
			...runStartedOf(t, tf, ctx.medians),
			...(ctx.trendingRepos.has(t.id)
				? { trendingRepo: ctx.trendingRepos.get(t.id) }
				: {}),
			// PR review occurrence stamp: the bell and the event diff read it. A project
			// with notifications off ships no stamp, so no pr event raises at all.
			...(t.kind === "pr_review" &&
			ctx.settings.prReviewNotify === true &&
			ctx.facts.pr.has(t.id)
				? { prOccurrence: ctx.facts.pr.get(t.id) }
				: {}),
		};
	}
	/** Names the queued merges each open release holds on the release card, so the board
	 * can link held cards to it and offer the re-release once the findings are done. */
	function stampReleaseHolds(cards: TaskCard[]): void {
		for (const card of cards) {
			if (card.releaseVersion === null || card.cancelledAt !== null) continue;
			const held = releaseHeldMerges(cards, card);
			if (held.length > 0) card.heldMerges = held.map((h) => h.id);
		}
	}
	/** OTTR-506: stamp the queued merges the push hold parks (local main has commits
	 * origin lacks), so the board names the hold — the browser gets no git. PR mode
	 * never writes the local target branch (OTTR-552), so the hold names nothing there. */
	function stampPushHolds(e: Entry, cards: TaskCard[]): void {
		if (e.mainUnpushed !== true || e.store.getSettings().prMode === true)
			return;
		for (const card of cards) {
			if (card.cancelledAt === null && pushHold(true, card) !== null)
				card.pushHold = true;
		}
	}
	/** A microVM-mode project's queued cards wait on vm-runner (unreachable or busy); stamp
	 * the reason so the board names the hold instead of a silent queue. */
	function stampVmHolds(e: Entry, cards: TaskCard[]): void {
		const microVm = e.store.getSettings().microVm;
		for (const card of cards) {
			if (card.state !== "queued" || card.cancelledAt !== null) continue;
			const held = vmHoldFor(microVm, e.store.name, card.id);
			if (held !== null) card.vmHold = held;
		}
	}

	/** Every project's cards, newest first, plus the kept-worktree counts: the card slice of
	 * stateResponse, shared with the /system holds so both count the same cards. */
	function boardCards(now: number): {
		tasks: TaskCard[];
		keptHeld: number;
		keptStale: number;
		keptCards: string[];
	} {
		const tasks: TaskCard[] = [];
		let keptHeld = 0;
		let keptStale = 0;
		const keptCards: string[] = [];
		for (const e of deps.projects.values()) {
			try {
				const settings = e.store.getSettings();
				const days = settings.keptWorktreeDays;
				const facts = e.store.boardCardFacts();
				const medians = turnMedians(e.store.turnDurations());
				const trendingRepos = trendingReposOf(e);
				const cards: TaskCard[] = [];
				for (const t of e.store.listTasks()) {
					const kept = keptCounts(t, now, days);
					keptHeld += kept.held;
					keptStale += kept.stale;
					// One kept card is one held worktree (keptCounts), so its id names the advisory's link.
					if (kept.held === 1) keptCards.push(t.id);
					// Cancelled cards ride in the list too: the done lane shows them with a
					// "Cancelled" chip. Every counter (slots, alarms, holds, coverage) either
					// filters cancelledAt or reads state/stage facts a cancelled card no longer has.
					cards.push(
						taskCardOf(e, t, { facts, medians, trendingRepos, settings }, now),
					);
				}
				stampReleaseHolds(cards);
				stampPushHolds(e, cards);
				stampVmHolds(e, cards);
				tasks.push(...cards);
			} catch (err) {
				// A sick store skips its own cards; the rest of the board still renders.
				logStoreError(e.store.name, err);
			}
		}
		tasks.sort((a, b) => b.createdAt - a.createdAt);
		return { tasks, keptHeld, keptStale, keptCards };
	}

	/** The /system holds, from the same drain values and cards the state frame ships. */
	function systemHolds(now: number): SystemHolds {
		const { tasks } = boardCards(now);
		const slots = slotUse(tasks);
		const queue = queueOrder(tasks);
		const first = queue[0];
		return {
			drainUntil: drainUntil > now ? drainUntil : null,
			drainCommits: drainUntil > now ? drainCommits : null,
			maxTotal: deps.shared.maxTotalRuns,
			running: SLOT_STAGES.reduce((sum, s) => sum + slots[s], 0),
			queued: queue.length,
			oldestQueuedAt:
				first === undefined ? null : (first.queuedAt ?? first.createdAt),
		};
	}

	function stateResponse(): StateResponse {
		const now = Date.now();
		const cycle = updateCycleView(now);
		const { tasks, keptHeld, keptStale, keptCards } = boardCards(now);
		const scan = currentOrphanScan();
		// Advisory only: a sick credential store yields no sign-in advisories, not a failed state.
		let list: SignIn[] = [];
		try {
			list = signIns();
		} catch {
			// An unreadable or missing store counts as no active sign-in.
		}
		const roles = modelRoles();
		const dead = deadSignIns(list, roles);
		const projects = [...deps.projects.values()]
			.flatMap((e) => {
				try {
					return [projectView(e)];
				} catch (err) {
					logStoreError(e.store.name, err);
					return [];
				}
			})
			.sort(
				(a, b) =>
					rankInOrder(a.name, deps.shared.projectOrder) -
					rankInOrder(b.name, deps.shared.projectOrder),
			);
		return {
			projects,
			tasks,
			maxTotal: deps.shared.maxTotalRuns,
			reviewCheck: deps.shared.reviewCheck,
			workCheck: deps.shared.workCheck,
			idleReviews: deps.shared.idleReviews,
			trendingScan: deps.shared.trendingScan,
			commitIdentity: deps.shared.commitIdentity,
			trendingStatus: trendingScanner.status(),
			serverVersion: deps.serverVersion,
			quota,
			// Absent on self-hosted boards, so their payload stays as before.
			...(deps.hosted !== undefined && { hosted: true }),
			// Hosted mode has no admin login: the proxy authenticates, so setup never opens.
			onboarding: deps.hosted === undefined && admin === null,
			user: admin?.name ?? null,
			seenAnswers: loadSeen(),
			seenDoneSince,
			inboxSeen: loadInboxSeen(),
			orphans: scan.orphans,
			orphansError: scan.error,
			keptWorktrees: { held: keptHeld, stale: keptStale, cards: keptCards },
			drainUntil: drainUntil > now ? drainUntil : null,
			drainCommits: drainUntil > now ? drainCommits : null,
			warnings: [
				...boardWarnings(list, roles, undefined, undefined, tasks, now),
				// OTTR-548: the workers' self-reported sign-ins; reads only the tick's cache.
				...workerSignInWarnings(workerSignInReports, list, roles),
				// OTTR-754: one bell warning per runner whose /tmp is below the free-space
				// limit; recomputed per poll, so it disappears when space returns.
				...workerTmpWarnings(workerSignInReports, tmpDiskSpace()),
				// OTTR-763: the checkout guard's ambiguous-change notices; one per change,
				// naming the commit and the running cards; bounded and expiring in the loop.
				...(deps.checkoutNotices?.() ?? []),
				...(githubApp === null ? [] : [appCheckWarning(appCheck)]).filter(
					(w) => w !== null,
				),
				...(memoryHealth?.reason !== null && memoryHealth !== null
					? [`omp runs with no memory: ${memoryHealth.reason}`]
					: []),
			],
			updates: updatesView(),
			alatePendingSince,
			alateProvisionError,
			deadSignIns: dead,
			restartWait: restartWaitView(),
			seedFailed: seedFailedView(),
			updateCycle: cycle,
		};
	}

	/** Applies a user card edit guarded by the revision the client loaded. */
	function applyUserEdit(
		e: Entry,
		task: Task,
		patch: TaskPatch,
		body: Record<string, unknown>,
	): Response | Task {
		const revision = body.revision;
		// Absent keeps today's behavior: extension and API-key clients do not send it.
		if (revision === undefined) return e.store.updateTask(task.id, patch);
		if (
			typeof revision !== "number" ||
			!Number.isInteger(revision) ||
			revision < 1
		)
			return json({ error: "revision must be a positive integer" }, 400);
		const res = e.store.updateTaskIfCurrent(task.id, patch, revision);
		if (!res.ok)
			return json(
				{
					error: "card changed since it was loaded",
					task: taskView(e, res.task),
				},
				409,
			);
		return res.task;
	}

	/** The stale-edit precheck for routes whose state preconditions must not shadow a
	 * stale revision: answers 400 for a malformed revision and 409 with the current
	 * card when the revision is stale, so the drawer's conflict flow keeps the draft
	 * even when the newer state would refuse the edit on its own. Null when the
	 * revision is absent or current: the task was read synchronously and is written
	 * synchronously below, so the preconditions after this check run on the row the
	 * revision was checked against. */
	function staleEditResponse(
		e: Entry,
		task: Task,
		body: Record<string, unknown>,
	): Response | null {
		const rev = body.revision;
		if (rev === undefined) return null;
		if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1)
			return json({ error: "revision must be a positive integer" }, 400);
		if (rev !== task.revision)
			return json(
				{ error: "card changed since it was loaded", task: taskView(e, task) },
				409,
			);
		return null;
	}

	/** One task with its turns for the drawer; turns ship without the prompt text and the raw
	 * diff ships only from its own endpoint, so opening a drawer never carries the cap-sized text. */
	function taskView(e: Entry, t: Task): TaskView {
		const { diffText: _diffText, ...task } = t;
		const pr = t.kind === "pr_review" ? e.store.getPrReviewByTask(t.id) : null;
		// listTasks orders newest first, so find takes the newest retro of this card.
		const retro =
			t.kind === "retro"
				? undefined
				: e.store
						.listTasks()
						.find(
							(c) =>
								c.kind === "retro" &&
								c.followUpOf === t.id &&
								c.followUpOfProject === null,
						);
		const proposal = e.store.trendingVerdictByProposal(t.id);
		return {
			...task,
			steps: viewSteps(t),
			turns: e.store
				.listTurns(t.id)
				.map(({ prompt: _prompt, ...turn }) => turn),
			sessionTitle: e.store.frozenTitle(t),
			...(proposal?.verdict === "filed" ? { trendingRepo: proposal.repo } : {}),
			...(pr !== null && e.github !== null
				? {
						prReview: {
							number: pr.number,
							url: prUrl(
								ownerRepo(`https://github.com/${e.github}.git`) ?? e.github,
								pr.number,
							),
							state: pr.state,
							reviewedHead: pr.reviewedHead,
							postedHead: pr.postedHead,
							postedUrl: pr.postedUrl,
							postedLogin: pr.postedLogin,
							postError: pr.postError,
						},
					}
				: {}),
			...(retro
				? {
						retro: {
							id: retro.id,
							state: retro.state,
							stage: retro.stage,
							cancelledAt: retro.cancelledAt,
							needsReason: retro.needsReason,
							asked: retro.asked,
							turns: e.store
								.listTurns(retro.id)
								.map(({ prompt: _prompt, ...turn }) => turn),
						},
					}
				: {}),
			...(isReview(t)
				? {
						findings: reviewFindings(e.store.listTasks(), t)
							.sort((a, b) => a.createdAt - b.createdAt)
							.map((f) => ({
								id: f.id,
								title: f.title,
								state: f.state,
								stage: f.stage,
								cancelledAt: f.cancelledAt,
								createdAt: f.createdAt,
								turns: e.store
									.listTurns(f.id)
									.map(({ prompt: _prompt, ...turn }) => turn),
							})),
					}
				: {}),
		};
	}

	/**
	 * Renders a row a handler just created or updated. The 404 arm exists only for the
	 * `Task | null` type: createTask/updateTask throw on a missing id and tasks are never
	 * deleted, so a route that wrote through this store always finds the row (R1-11h).
	 */
	function taskResponse(e: Entry, id: string): Response {
		const t = e.store.getTask(id);
		return t === null
			? json({ error: "unknown task" }, 404)
			: json(taskView(e, t));
	}

	/** Route params: registered project (404), task id — legacy 8-hex or new `PREFIX-n` key (400) that exists (404). */
	function resolveTask(
		project: string,
		id: string,
	): { e: Entry; task: Task } | Response {
		const e = deps.projects.get(project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		if (!TASK_ID_RE.test(id)) return json({ error: "bad task id" }, 400);
		const task = e.store.getTask(id);
		if (!task) return json({ error: "unknown task" }, 404);
		return { e, task };
	}

	/** Queues the rules interview as a card; idempotent while one is live. "not-needed" when rules exist, unless fix asks for an alignment pass over them. The id names the card the answer talks about: the new one when queued, the live one when running, so the UI can open it. */
	function startInterview(
		e: Entry,
		fix = false,
	): {
		interview: string;
		id: string | null;
	} {
		const has = hasRules(e.path, e.targetRules === true);
		if (has && !fix) return { interview: "not-needed", id: null };
		const live = liveCardOf(e.store.listTasks(), "interview");
		if (live !== null) return { interview: "running", id: live.id };
		const t = e.store.createTask(
			rulesInterviewPrompt({ projectName: e.store.name, existing: has }),
			null,
			"interview",
		);
		e.store.updateTask(t.id, { promptAuthor: "board" });
		return { interview: "queued", id: t.id };
	}

	/** Project ssh key file; "" when the board name cannot name one (a separator or a leading dot). */
	function projectKeyPath(name: string): string {
		try {
			return sshPaths(sshDir).project(name);
		} catch {
			return "";
		}
	}

	/** The configured GitHub host for the view; null when the setting is invalid. */
	function githubHostView(): string | null {
		const raw = process.env[GITHUB_HOST_ENV];
		if (raw === undefined || raw.trim() === "") return DEFAULT_GITHUB_HOST;
		const parsed = parseGithubHost(raw);
		return "error" in parsed ? null : parsed.host;
	}

	/** The Settings git-hosts view: per-host token flags and the global key — never a secret itself. */
	async function gitHostsView() {
		return {
			tokens: gitTokens.map((t) => ({
				host: t.host,
				username: t.username,
				tokenSet: true,
				// False when the stored sealed token is kept unreadable this boot (ADR-0011).
				tokenReadable: t.unreadable !== true,
			})),
			// Whether the board itself has a GitHub token, so Settings can offer the click
			// that stores it as the git-host entry for the configured host. A kept-unreadable
			// token still counts as set; tokenReadable says this boot can actually use it.
			githubTokenSet: githubToken !== null || keptUnreadable.has("githubToken"),
			githubTokenReadable: githubToken !== null,
			globalKey: await keyInfo(sshPaths(sshDir).global),
			// Never the key: the fingerprint is what the user compares against GitHub's.
			// A kept-unreadable stored key reports fingerprint null and keyReadable false.
			githubApp:
				githubApp === null
					? null
					: {
							id: githubApp.id,
							fingerprint: githubApp.fingerprint,
							check: appCheck,
							keyReadable: githubApp.unreadable !== true,
						},
			githubHost: githubHostView(),
		};
	}

	/** The Settings read-only-turn-token view (docs/specs/turn-read-token.md): per-host flags and verdicts — never a token value. */
	function turnReadTokenView() {
		return {
			host: githubHostView(),
			tokens: turnReadTokens.map((r) => ({
				host: r.host,
				tokenSet: true,
				// False when the stored sealed token is kept unreadable this boot (ADR-0011).
				tokenReadable: r.token !== null,
				status: r.status,
				detail: r.detail,
				confirmed: r.confirmed,
			})),
		};
	}

	/** The read-only GitHub token a turn may hold, or null: the configured host's row with a
	 * readable token and the verdict `ok`, or `write` the operator confirmed. This is the
	 * only function turns read (docs/specs/turn-read-token.md). */
	function turnReadToken(): { host: string; token: string } | null {
		const configured = githubHostView();
		if (configured === null) return null;
		const row = turnReadTokens.find(
			(r) => r.host === configured && r.token !== null,
		);
		if (row === undefined || row.token === null) return null;
		if (row.status !== "ok" && !(row.status === "write" && row.confirmed))
			return null;
		return { host: row.host, token: row.token };
	}

	/** Every project repo ("owner/repo") whose origin remote sits on the host; deduped, sorted.
	 * The origin may be https, ssh:// or scp-style ssh ("git@host:owner/repo.git"): the shared
	 * remote parser normalizes all three before owner/repo extraction, so an scp-style origin
	 * gets the same push-permission check as an https one. */
	function reposOnHost(host: string): string[] {
		const onHost = hostMatcher(host);
		const out = new Set<string>();
		for (const e of deps.projects.values()) {
			const url = e.store.getSettings().originUrl;
			if (url === null || !onHost.test(url)) continue;
			const https = httpsRemote(url);
			const repo = https === null ? null : ownerRepo(https);
			if (repo !== null) out.add(repo);
		}
		return [...out].sort();
	}

	/** Probe a candidate git-host token live and, only then, save it as the host's entry. */
	async function saveGitToken(
		cand: GitToken,
		testUrl: unknown,
	): Promise<Response> {
		// A token may only take effect for its own host: the test must be an https
		// URL there, or the save stops here.
		const remote = parseGitUrl(testUrl);
		if (
			"error" in remote ||
			remote.scheme !== "https" ||
			remote.hostKey !== cand.host
		)
			return json(
				{ error: "testUrl must be an https URL on the token's host" },
				400,
			);
		const t = await testRemote(
			String(testUrl).trim(),
			gitAuthEnv({
				ambientHelpers,
				tokens: [cand],
				key: null,
				knownHosts: sshPaths(sshDir).knownHosts,
			}),
			// Only the candidate: an unsaved token must never enter the global secret set.
			[cand.token],
		);
		if ("error" in t) {
			// Same hint as the clone: the bare 403 on the token test names the SAML cause.
			if (GIT_HTTP_AUTH_STATUS.test(t.error)) {
				const hint = await githubAuthHint(String(testUrl).trim(), {
					configuredHost: githubHost().host,
					tokens: [cand],
					envToken: null,
					secrets: [...gitSecrets(), cand.token],
					fetchImpl: deps.githubAuthProbe?.fetchImpl,
					timeoutMs: deps.githubAuthProbe?.timeoutMs,
				});
				if (hint !== null) return json({ error: t.error + hint }, 400);
			}
			return json({ error: t.error }, 400);
		}
		// One token per host: a re-save replaces the host's old entry.
		gitTokens = [...gitTokens.filter((x) => x.host !== cand.host), cand];
		saveConfig();
		applyGitSecrets();
		return json(await gitHostsView());
	}

	const NO_GLOBAL_KEY =
		"no global SSH key: add one in Settings → Git identity → SSH key, or pick a new key for this project";
	/** Key file for a test selector ("global", "pending:<id>", "project:<name>"); a string error for a 400. */
	function resolveTestKey(sel: unknown): { key: string } | { error: string } {
		const paths = sshPaths(sshDir);
		if (sel === undefined || sel === "global")
			// No global key is an error: without an Ottr key, ssh would skip the confirmed
			// known_hosts and run on the server's ambient defaults.
			return existsSync(paths.global)
				? { key: paths.global }
				: { error: NO_GLOBAL_KEY };
		if (typeof sel !== "string")
			return {
				error: 'key must be "global", "pending:<id>" or "project:<name>"',
			};
		return pendingOrProjectKey(sel, paths);
	}

	/** Key result for a "pending:<id>"/"project:<name>" selector; sshPaths throws on a malformed id or an unusable project name. */
	function pendingOrProjectKey(
		sel: string,
		paths: SshPaths,
	): { key: string } | { error: string } {
		try {
			const f = sel.startsWith("pending:")
				? paths.pending(sel.slice("pending:".length))
				: sel.startsWith("project:")
					? paths.project(sel.slice("project:".length))
					: null;
			if (f === null)
				return {
					error: 'key must be "global", "pending:<id>" or "project:<name>"',
				};
			return existsSync(f) ? { key: f } : { error: "no such key" };
		} catch {
			return { error: "no such key" };
		}
	}

	/** Shared save flow for a key (global or per project): pending selector, ssh testUrl, host-key confirm, ls-remote, promote (a key is stored only when the test exits 0). */
	async function saveKeyFlow(
		body: Record<string, unknown>,
		to: string,
	): Promise<Response> {
		const paths = sshPaths(sshDir);
		const sel = body.pending;
		let from = "";
		if (typeof sel === "string" && sel.startsWith("pending:")) {
			try {
				from = paths.pending(sel.slice("pending:".length));
			} catch {
				return json({ error: "no such key" }, 400);
			}
		}
		if (from === "" || !existsSync(from))
			return json({ error: "no such key" }, 400);
		const testError = await sshKeyTestError(paths, from, body);
		if (testError !== null) return testError;
		promoteKey(from, to);
		return json(await keyInfo(to));
	}

	/** Error Response when the key cannot serve `body.testUrl` over ssh (URL scheme, host-key trust, or test run); null when the test passes. */
	async function sshKeyTestError(
		paths: SshPaths,
		from: string,
		body: Record<string, unknown>,
	): Promise<Response | null> {
		const remote = parseGitUrl(body.testUrl);
		// The key only takes effect over ssh, so the test must run an ssh URL.
		if ("error" in remote || remote.scheme !== "ssh")
			return json(
				{ error: "testUrl must be an ssh git URL (git@host:… or ssh://…)" },
				400,
			);
		const host = await checkHostKey(paths.dir, remote, body.trust, keyscan);
		if (host !== null) {
			if ("needsTrust" in host) return json(host, 409);
			return json({ error: redact(host.error, gitSecrets()) }, 400);
		}
		const t = await testRemote(
			String(body.testUrl).trim(),
			gitAuthEnv({
				ambientHelpers,
				tokens: gitTokens,
				key: from,
				knownHosts: paths.knownHosts,
			}),
			// The ssh stderr names the key file: redact its path too.
			[...gitSecrets(), from],
		);
		if ("error" in t) return json({ error: t.error }, 400);
		return null;
	}

	/** Host-agnostic clone; `{ p }` on success, `{ error, needsToken? }` for a 400, `{ trust }` for a 409. */
	async function cloneGit(
		url: string,
		body: Record<string, unknown>,
		remote: GitRemote,
		name: string,
		dest: string,
		workspace: string,
	): Promise<
		| { p: string }
		| { error: string; needsToken?: string }
		| { trust: TrustNeeded }
	> {
		if (existsSync(dest))
			return { error: `clone destination already exists: ${dest}` };
		const paths = sshPaths(sshDir);
		const guard = await cloneSshKeyGuard(url, body, remote, paths);
		if ("error" in guard) return guard;
		if ("trust" in guard) return guard;
		const { key, pending } = guard;
		const { authEnv, hostedSecrets } = await hostedCloneEnv(
			name,
			url,
			remote,
			key,
			paths,
		);
		// A large repository can outlive git()'s 10-minute default ceiling (R5-4); the URL
		// always runs after "--" so an option-looking value cannot leak into git's argv.
		const r = await git(
			["clone", "--", url, dest],
			workspace,
			60 * 60_000,
			authEnv,
		).catch((err: unknown) => ({
			code: -1,
			stdout: "",
			stderr: errmsg(err),
		}));
		if (r.code !== 0)
			return cloneFailure(url, r, remote, authEnv, hostedSecrets);
		// A pending key that cloned cleanly becomes the project key.
		if (pending !== null) promoteKey(pending, paths.project(name));
		return { p: dest };
	}

	/** Picks the ssh key a clone uses; a null result means the sshKey value was neither form. */
	function selectCloneKey(
		sel: unknown,
		paths: SshPaths,
	): { key: string; pending: string | null } | { error: string } | null {
		if (sel === "global") {
			if (!existsSync(paths.global)) return { error: NO_GLOBAL_KEY };
			return { key: paths.global, pending: null };
		}
		if (typeof sel === "string" && sel.startsWith("pending:")) {
			let f = "";
			try {
				f = paths.pending(sel.slice("pending:".length));
			} catch {
				return { error: "no such key" };
			}
			if (!existsSync(f)) return { error: "no such key" };
			return { key: f, pending: f };
		}
		return null;
	}
	/** Checks the host key and probes the remote; a null result means both passed. */
	async function verifyCloneHost(
		url: string,
		remote: GitRemote,
		body: Record<string, unknown>,
		key: string | null,
		paths: SshPaths,
	): Promise<{ trust: TrustNeeded } | { error: string } | null> {
		const host = await checkHostKey(paths.dir, remote, body.trust, keyscan);
		if (host !== null) {
			if ("needsTrust" in host) return { trust: host };
			return { error: redact(host.error, gitSecrets()) };
		}
		const t = await testRemote(
			url,
			gitAuthEnv({
				ambientHelpers,
				tokens: gitTokens,
				key,
				knownHosts: paths.knownHosts,
			}),
			key === null ? gitSecrets() : [...gitSecrets(), key],
		);
		if ("error" in t) return { error: t.error };
		return null;
	}
	/** Resolve the ssh key for a clone before any network run: unknown or missing files are a 400. */
	async function cloneSshKeyGuard(
		url: string,
		body: Record<string, unknown>,
		remote: GitRemote,
		paths: SshPaths,
	): Promise<
		| { key: string | null; pending: string | null }
		| { error: string; needsToken?: string }
		| { trust: TrustNeeded }
	> {
		let key: string | null = null;
		let pending: string | null = null;
		if (remote.scheme !== "ssh") return { key, pending };
		const sel = body.sshKey === undefined ? "global" : body.sshKey;
		const picked = selectCloneKey(sel, paths);
		if (picked === null)
			return { error: 'sshKey must be "global" or "pending:<id>"' };
		if ("error" in picked) return picked;
		key = picked.key;
		pending = picked.pending;
		const ok = await verifyCloneHost(url, remote, body, key, paths);
		if (ok !== null) return ok;
		return { key, pending };
	}

	/** Auth env for a clone: board keys, plus the hosted hook token for an https remote in hosted mode (docs/specs/hosted-mode.md section 6). */
	async function hostedCloneEnv(
		name: string,
		url: string,
		remote: GitRemote,
		key: string | null,
		paths: SshPaths,
	): Promise<{
		authEnv: Record<string, string>;
		hostedSecrets: readonly string[];
	}> {
		let authEnv = gitAuthEnv({
			ambientHelpers,
			tokens: networkGitTokens(),
			key,
			knownHosts: paths.knownHosts,
		});
		let hostedSecrets: readonly string[] = [];
		if (deps.hosted !== undefined && remote.scheme === "https") {
			const auth = hostedGitAuth();
			if (auth !== null) {
				const a = await auth.pending(name, url);
				authEnv = a.env;
				hostedSecrets = a.secrets;
			}
		}
		return { authEnv, hostedSecrets };
	}

	/** Build the clone-failure error: last stderr line, redacted; an https auth failure adds GitHub's auth hint and offers the token step (needsToken). */
	async function cloneFailure(
		url: string,
		r: { code: number; stderr: string },
		remote: GitRemote,
		authEnv: Record<string, string>,
		hostedSecrets: readonly string[],
	): Promise<{ error: string; needsToken?: string }> {
		const line =
			r.stderr.trim().split("\n").filter(Boolean).pop() ?? "git clone failed";
		let error = `git clone failed: ${redact(line, [
			...gitSecrets(),
			...hostedSecrets,
		]).slice(0, 300)}`;
		// A bare 401/403 from a GitHub host hides the real cause (SAML enforcement, an IP
		// allow list, a token policy); the REST API names it under the git error. The probe
		// uses the board-global tokens, which hosted mode never uses, so hosted skips it.
		if (
			deps.hosted === undefined &&
			remote.scheme === "https" &&
			GIT_HTTP_AUTH_STATUS.test(r.stderr)
		)
			error +=
				(await githubAuthHint(url, {
					configuredHost: githubHost().host,
					tokens: gitTokens,
					envToken: process.env.GH_TOKEN ?? null,
					secrets: [...gitSecrets(), ...hostedSecrets],
					fetchImpl: deps.githubAuthProbe?.fetchImpl,
					timeoutMs: deps.githubAuthProbe?.timeoutMs,
				})) ?? "";
		// Classify the failure only after a failed clone: an auth answer has the form offer
		// the token step for that host (spec: needsToken).
		if (remote.scheme === "https") {
			const t = await testRemote(url, authEnv, [
				...gitSecrets(),
				...hostedSecrets,
			]);
			if ("error" in t && t.auth) return { error, needsToken: remote.hostKey };
		}
		return { error };
	}

	/** git-init with an initial commit (Ottr identity fallback); an error string for a 400, or null.
	 * The commit doubles as the arch-review watermark (docs/ARCH-REVIEWS.md "Baseline"): a repo
	 * Ottr itself created starts reviewed at that head with delta 0, so it never shows
	 * "Un-reviewed — review due" before any work exists; commits after it count toward the cap.
	 * An imported repo keeps its history and stays un-reviewed until a real review. */
	async function gitInitWithCommit(p: string): Promise<string | null> {
		const r = await git(["init", "-q", "-b", "main"], p);
		if (r.code !== 0) return `git init failed: ${r.stderr.trim()}`;
		// Identity precedence on the watermark: a Settings identity wins over every host
		// git config level (a bare commit would take the host's), Settings null keeps
		// the host's own resolution, and a host with no identity at all falls to the
		// built-in Ottr identity on the retry rather than failing the add.
		let c = await git(
			[
				...(deps.shared.commitIdentity
					? identityArgs(deps.shared.commitIdentity)
					: ["-c", "user.useConfigOnly=true"]),
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"docs(arch-review): initial commit",
			],
			p,
			10 * 60_000,
		);
		if (c.code !== 0)
			// No usable identity on this host: retry with the Settings identity, null
			// keeping the built-in Ottr identity.
			c = await git(
				[
					...identityArgs(deps.shared.commitIdentity),
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"docs(arch-review): initial commit",
				],
				p,
			);
		if (c.code !== 0) return `initial commit failed: ${c.stderr.trim()}`;
		return null;
	}

	/** Create and git-init a fresh repo for the New tab; `{ p }` on success, `{ error }` for a 400. */
	async function initNewProject(
		name: string,
		parent: string,
	): Promise<{ p: string } | { error: string }> {
		if (!isFolderName(name))
			return { error: "name must be a folder name without path separators" };
		const p = join(parent, name);
		if (existsSync(p)) return { error: "path already exists" };
		try {
			mkdirSync(p);
		} catch (err) {
			// ponytail: Windows device names (CON, NUL, …) surface here as raw mkdir errors
			return { error: `cannot create ${p}: ${errmsg(err)}` };
		}
		const err = await gitInitWithCommit(p);
		if (err !== null) return { error: err };
		return { p };
	}

	/** The cloned directory, or the response for a failed or trust-blocked clone. */
	function cloneResult(
		c:
			| { p: string }
			| { error: string; needsToken?: string }
			| { trust: TrustNeeded },
	): Response | { p: string } {
		if ("trust" in c) return json(c.trust, 409);
		if ("error" in c) {
			return json(
				c.needsToken === undefined
					? { error: c.error }
					: { error: c.error, needsToken: c.needsToken },
				400,
			);
		}
		return { p: c.p };
	}
	/** Adds a project from a git URL: validate, precheck the folder name, clone. */
	async function addFromUrl(
		rawUrl: string,
		body: Record<string, unknown>,
		ws: string,
		nameTaken: (dest: string) => Response | null,
	): Promise<Response | { p: string }> {
		if (!existsSync(ws) || !statSync(ws).isDirectory())
			return json({ error: "projects directory does not exist" }, 400);
		// Trust boundary: parse before anything touches the disk, and git
		// only ever sees the URL after "--".
		const remote = parseGitUrl(rawUrl);
		if ("error" in remote) return json({ error: GIT_URL_ERROR }, 400);
		// An explicit name passes the New tab's folder rule; the default proposes the
		// remote's last path segment.
		let name = remote.name;
		if (typeof body.name === "string") name = body.name.trim();
		// The proposed name passes the same folder rule as an override.
		if (!isFolderName(name))
			return json(
				{ error: "name must be a folder name without path separators" },
				400,
			);
		const dest = join(ws, name);
		// R1-5: the 409 fires before any clone leaves a repo on disk with no board entry.
		const taken = nameTaken(dest);
		if (taken !== null) return taken;
		const c = await cloneGit(rawUrl.trim(), body, remote, name, dest, ws);
		return cloneResult(c);
	}
	/** Adds a project from a local folder name: validate, precheck, git init, optional gh create. */
	async function addFromName(
		rawName: string,
		body: Record<string, unknown>,
		ws: string,
		nameTaken: (dest: string) => Response | null,
	): Promise<Response | { p: string }> {
		const parent = ws;
		if (!existsSync(parent) || !statSync(parent).isDirectory())
			return json({ error: "projects directory does not exist" }, 400);
		// Input validation precedes the R1-5 precheck: an ambiguous request (dest on disk
		// AND name taken) keeps its 400 "path already exists"; the 409 still fires before
		// any clone or git init leaves a repo on disk with no board entry.
		const name = rawName.trim();
		const dest = join(parent, name);
		if (existsSync(dest)) return json({ error: "path already exists" }, 400);
		const taken = nameTaken(dest);
		if (taken !== null) return taken;
		const n = await initNewProject(name, parent);
		if ("error" in n) return json({ error: n.error }, 400);
		if (body.github === true) {
			// gh creates the repo under the authenticated user, wires origin, and pushes.
			const g = await runGh([
				"repo",
				"create",
				name,
				"--private",
				"--source",
				n.p,
				"--remote",
				"origin",
				"--push",
			]).catch((err: unknown) => ({
				code: -1,
				stdout: "",
				stderr: errmsg(err),
			}));
			if (g.code !== 0) {
				const line =
					g.stderr.trim().split("\n").filter(Boolean).pop() ?? "gh failed";
				return json(
					{
						error: `local repo created at ${n.p}, but creating the GitHub repo failed: ${line.slice(0, 300)}`,
					},
					400,
				);
			}
		}
		return { p: n.p };
	}
	/** Registers the finished project directory on the board: store entry, persistence, remote refresh, origin pin. */
	async function registerProject(p: string, prefix: string): Promise<Response> {
		const gitless = !(await isGitRepoWithCommit(p));
		const key = basename(p);

		const store = ProjectStore.init(p);
		const e: Entry = {
			store,
			name: key,
			path: p,
			target: null,
			gitless,
			github: null,
			protectedTarget: false,
			remote: null,
			dirty: false,
			mainUnpushed: false,
			mainBranch: null,
			latestRelease: null,
			latestImage: null,
			archReview: null,
		};
		deps.projects.set(key, e);
		// Explicitly added paths persist so boot finds them again even outside the scan roots.
		if (!deps.shared.projectPaths.includes(p)) {
			deps.shared.projectPaths = [...deps.shared.projectPaths, p];
			saveConfig();
		}
		if (deps.shared.removedPaths.includes(p)) {
			// Re-adding lifts the removal: the board shows the project's stored tasks again.
			deps.shared.removedPaths = deps.shared.removedPaths.filter(
				(x) => x !== p,
			);
			saveConfig();
		}
		await refreshRemote(e);

		// R5-1 (docs/specs/pinned-origin-url.md): pin the origin URL before the project can
		// dispatch a turn — the board's fetch and push name this server-owned URL, never the
		// remote name the worker-writable .git/config resolves. Never refreshed while the
		// board runs; a re-add or the settings API re-pins.
		const pin = await originRemoteUrl(p);
		if (pin !== null && e.store.getSettings().originUrl === null)
			e.store.setSettings({ originUrl: pin });

		// The wizard/checklist opens for every newly added project; a set prefix must land
		// before the interview so its first tasks already use it.
		e.store.setSettings({
			setupChecklist: true,
			taskIdPrefix: prefix === "" ? null : prefix,
		});
		// A gitless project has no HEAD to create a worktree from; the turn machinery would
		// crash, so the rules interview waits for POST /init.
		if (e.gitless)
			return json({ project: projectView(e), interview: "gitless", id: null });
		const interview = startInterview(e);
		return json({ project: projectView(e), ...interview });
	}

	async function addProject(body: Record<string, unknown>): Promise<Response> {
		// Same validation as the settings PATCH: a bad prefix must 400 before any
		// disk write (R1-5), and an empty one keeps the folder-derived default.
		const tp = body.taskIdPrefix;
		if (tp !== undefined && tp !== null && typeof tp !== "string")
			return json({ error: "taskIdPrefix must be a string or null" }, 400);
		const prefix = typeof tp === "string" ? tp.trim().toUpperCase() : "";
		if (prefix !== "" && !/^[A-Z0-9]{1,8}$/.test(prefix))
			return json(
				{ error: "taskIdPrefix must be 1 to 8 letters and digits" },
				400,
			);
		// One folder name per board entry (it keys deps.projects and, under OTTR_DATA_DIR, the
		// data dir): a taken basename must 409 BEFORE any clone or git init leaves a repo on
		// disk with no board entry (R1-5).
		const nameTaken = (dest: string): Response | null =>
			deps.projects.has(basename(dest))
				? json({ error: "another project already has that folder name" }, 409)
				: null;
		const ws = resolve(deps.defaultDir);
		let added: Response | { p: string };
		if (typeof body.url === "string") {
			added = await addFromUrl(body.url, body, ws, nameTaken);
		} else if (typeof body.name === "string") {
			added = await addFromName(body.name, body, ws, nameTaken);
		} else {
			return json({ error: "provide a git URL or a project name" }, 400);
		}
		if (!("p" in added)) return added;
		return registerProject(added.p, prefix);
	}

	/** 409 while any task is queued/preparing/running — removing or re-homing the project's
	 * store would strand them; null when the project is quiet. */
	function activeRefusal(e: Entry): Response | null {
		const active = e.store
			.listTasks()
			.filter(
				(t) =>
					t.state === "queued" ||
					t.state === "preparing" ||
					t.state === "running",
			);
		if (active.length === 0) return null;
		const titles = active.map((t) => `"${t.title}"`).join(", ");
		return json(
			{
				error: `cancel the queued/running task${active.length === 1 ? "" : "s"} first: ${titles}`,
			},
			409,
		);
	}

	/** Re-reads the integration target and the origin remotes after the folder's git state changed. */
	async function refreshRemote(e: Entry): Promise<void> {
		try {
			const r = await resolveTarget(
				e.path,
				false,
				null,
				e.store.getSettings().targetBranch,
			);
			e.target = r.target;
			// OTTR-605: an origin that has no branch for the local branch yet (a repo awaiting
			// its first push) resolves aspirationally; the board must show the target and the
			// "Push to origin" advisory at once, not after the next tick's branchUnpushed
			// refresh (which keeps the flag true from here on).
			if (r.unpushed === true) e.mainUnpushed = true;
		} catch {
			// The target is unknowable now: report none, never a stale one.
			e.target = null;
		}
		e.github = await githubUrl(e.path).catch(() => null);
		e.remote = await remoteUrl(e.path).catch(() => null);
		await refreshBranchRules(e);
	}

	/** A token for the remote's GitHub host: the matching stored git token, else GH_TOKEN on the board host. */
	function branchRulesToken(host: string, hostKey: string): string | null {
		return (
			gitTokens.find((t) => t.host === hostKey && t.unreadable !== true)
				?.token ??
			(host === githubHost().host ? (process.env.GH_TOKEN ?? null) : null)
		);
	}
	/** The probe facts for a branch-rules lookup; null when the entry cannot be probed. */
	function branchRulesTarget(
		e: Entry,
	): { repo: string; slash: number; branch: string; remote: GitRemote } | null {
		const repo = e.github === null ? null : ownerRepo(e.github);
		const slash = repo === null ? -1 : repo.indexOf("/");
		const remote = parseGitUrl(e.github ?? "");
		if (
			repo === null ||
			slash <= 0 ||
			e.target === null ||
			!e.target.startsWith("origin/") ||
			"error" in remote
		)
			return null;
		return {
			repo,
			slash,
			branch: e.target.slice("origin/".length),
			remote,
		};
	}
	/** OTTR-675: probes the target branch's repository rules where the GitHub remote
	 * resolves (refreshRemote). Advisory: a failed or 404 probe and a missing token keep
	 * the field false, so nothing shows. */
	async function refreshBranchRules(e: Entry): Promise<void> {
		e.protectedTarget = false;
		if (e.store.getSettings().prMode === true) return;
		const t = branchRulesTarget(e);
		if (t === null) return;
		const { repo, slash, branch, remote } = t;
		const token = branchRulesToken(remote.host, remote.hostKey);
		if (token === null || token === "") return;
		const parsed = parseGithubHost(remote.host);
		if ("error" in parsed) return;
		const r = await lookupBranchRules({
			apiBase: parsed.apiBase,
			owner: repo.slice(0, slash),
			repo: repo.slice(slash + 1),
			branch,
			token,
			fetchImpl: deps.branchRulesFetch,
		});
		e.protectedTarget = r.ok && r.pullRequest;
	}

	/**
	 * Drops the project from the board; its folder, repo, and `.tasks` data (tasks, turns, sessions,
	 * logs, worktrees) stay untouched, and re-adding the path shows them again. Config keeps the path
	 * so boot discovery cannot re-find it. Refuses while a turn process is running; a killed-store
	 * writer would corrupt state.
	 */
	function removeProject(name: string): Response {
		const e = deps.projects.get(name);
		if (e === undefined) return json({ error: "unknown project" }, 404);
		const refused = activeRefusal(e);
		if (refused !== null) return refused;
		deps.projects.delete(name);
		e.store.close();
		deps.shared.removedPaths = [...deps.shared.removedPaths, e.path];
		deps.shared.projectPaths = deps.shared.projectPaths.filter(
			(x) => x !== e.path,
		);
		saveConfig();
		deps.schedule();
		return json({ ok: true });
	}

	// The /system view's sampler: per-container cgroup readings (server, then each worker) and
	// the Docker VM, one point per 30 s tick over the last hour.
	const system = createSystemSampler();

	/** One tick's readings: the server's cgroup, every worker's GET /stats in parallel, the VM. */
	async function measureSystem(): Promise<void> {
		const reading = readCgroup();
		const target = deps.workerTarget;
		const workers = await Promise.all(
			(target?.urls ?? []).flatMap((url) => {
				let name: string;
				try {
					name = new URL(url).hostname;
				} catch {
					return []; // A malformed url names no row.
				}
				return [
					fetchWorkerStats(url, target?.token).then(
						(r): RunnerReading => ({ name, reading: r }),
					),
				];
			}),
		);
		system.record([{ name: "server", reading }, ...workers], readVm());
	}

	// The Settings -> omp usage report. omp's own `stats` command only syncs the default
	// session store, while tracker turns write their transcripts to each project's
	// sessions dir (--session-dir) — on the shared volume the server mounts — so the
	// board sums the transcripts itself: every project's dir plus both default stores.
	let ompStatsCache: { at: number; report: OmpStatsReport } | null = null;
	let ompStatsRead: Promise<OmpStatsReport> | null = null;
	/** One report on demand. The 30 s cache + single-flight keep concurrent Settings
	 *  tabs from re-walking every transcript at once. */
	async function ompStatsReportNow(): Promise<OmpStatsReport> {
		if (ompStatsRead !== null) return ompStatsRead;
		if (ompStatsCache !== null && Date.now() - ompStatsCache.at < 30_000)
			return ompStatsCache.report;
		const build = (async () => {
			const scan = deps.scanSessionUsage ?? scanSessionUsage;
			const sources: OmpStatsSource[] = ompSessionStores(deps.projects).map(
				(s) => ({ name: s.name, answer: scan(s.dir) }),
			);
			const report = buildOmpStatsReport(sources, Date.now());
			ompStatsCache = { at: report.at, report };
			return report;
		})();
		ompStatsRead = build.finally(() => {
			ompStatsRead = null;
		});
		return ompStatsRead;
	}

	// Settings -> omp usage -> Launch omp stats dashboard (docs/specs/omp-stats-dashboard.md).
	// The proxy listener's port as the server bound it; setOmpStatsListener corrects it after
	// a bind failure, so the info endpoint never offers a port that nothing serves.
	// Hosted mode never serves it: the hosted wall (hostedRefusal) has no loopback or cookie
	// grant, and this port would offer both (docs/specs/hosted-mode.md §3).
	let ompStatsListener: OmpStatsDashboardInfo =
		deps.hosted !== undefined
			? { port: null, error: "not available in hosted mode" }
			: (deps.ompStats?.info ?? {
					port: null,
					error: "the omp stats dashboard is not configured",
				});
	/**
	 * Every request on the omp stats proxy port. The same walls as /api run first (Host, auth
	 * wall with the proxy server's own peer address, Origin on mutations), and only a request
	 * past them starts the dashboard or counts as activity for its idle clock.
	 */
	/** The per-port sign-in page: the board's session cookie is per host, not per port. */
	function ompSignInPage(req: Request): Response {
		const url = new URL(req.url);
		const signIn = Bun.escapeHTML(`http://${url.hostname}:${deps.port}/`);
		return new Response(
			`<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Sign in to the board first: <a href="${signIn}">${signIn}</a>. Then reload this page.</p>`,
			{
				status: 401,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			},
		);
	}
	/** The Origin wall for state-changing requests on the proxy port; null lets the request pass. */
	function ompOriginRefusal(req: Request, port: number): Response | null {
		if (
			req.method !== "GET" &&
			req.method !== "HEAD" &&
			originRefusal(req.headers.get("origin"), port, []) !== null
		)
			return json({ error: "forbidden origin" }, 403);
		return null;
	}
	async function ompStatsFetch(
		req: Request,
		server: Server<undefined>,
	): Promise<Response> {
		const port = ompStatsListener.port;
		const dashboard = deps.ompStats?.dashboard;
		if (port === null || dashboard === undefined)
			return json({ error: "not found" }, 404);
		const refusal = hostRefusal(req.headers.get("host"), port, []);
		if (refusal !== null) return json({ error: refusal }, 403);
		const url = new URL(req.url);
		if (walled(req, server) && !authorized(req)) return ompSignInPage(req);
		const origin = ompOriginRefusal(req, port);
		if (origin !== null) return origin;
		const st = dashboard.ensure();
		if (st.phase !== "running" || st.port === null) return startingPage(st);
		// Server-sent events stay open for as long as the page does.
		if (url.pathname === "/api/events") server.timeout(req, 0);
		return forwardToDashboard(req, st.port);
	}
	let behind = 0;
	let behindCommits: string[] = [];
	let behindAt = 0;
	function effectiveUpdate(): { behind: number; commits: string[] } {
		return (
			updateCycle.available(Date.now()) ?? { behind, commits: behindCommits }
		);
	}

	let lastUpdateJson = "";
	function publishUpdate(): void {
		const message = {
			type: "update",
			...effectiveUpdate(),
		} satisfies ServerMessage;
		const text = JSON.stringify(message);
		if (text === lastUpdateJson) return;
		lastUpdateJson = text;
		publish(message);
	}
	let quota: QuotaState | null = null;
	let refreshingQuota = false;

	// Push layer: one WebSocket topic per board tab. Null until the port is bound; every publish
	// path below must be a no-op before that (boot-time schedule() runs first).
	let sockets = 0;
	let lastStateJson = "";
	/** The last "system" frame, replayed to a socket on open so the view renders before the next tick. */
	let lastSystemJson: string | null = null;
	let sampling = false; // one 30 s system sample in flight (worker fetches can take seconds)
	// OTTR-793: failed samples log to stderr, rate-limited in src/systemSampleLog.ts.
	const sampleLog = createSystemSampleLog(
		() => Date.now(),
		(line) => console.error(line),
	);
	let refreshingBehind = false;

	function publish(msg: ServerMessage): void {
		if (deps.serverRef.current === undefined || sockets === 0) return;
		deps.serverRef.current.publish("board", JSON.stringify(msg));
	}

	/** Prunes acknowledged inbox keys that no longer map to an alert input; persists the pruned list. */
	function pruneSeen(state: StateResponse, inputs: AlertCardInput[]): void {
		try {
			const pruned = pruneInboxSeen(state.inboxSeen, inputs);
			if (pruned.length !== state.inboxSeen.length) {
				deps.gstore.set("inbox_seen", pruned);
				state.inboxSeen = pruned;
			}
		} catch (err) {
			logError("inbox seen prune", err);
		}
	}

	function publishState(): boolean {
		if (deps.serverRef.current === undefined) return false;
		const consumers = sockets > 0 || loadSubs(deps.gstore).length > 0;
		// Without a consumer the frame exists only for the seen prune below; skip the state
		// build (this runs every second) when no task-derived key is acknowledged.
		if (
			!consumers &&
			!loadInboxSeen().some((k) => /^(task|done|error):/.test(k))
		)
			return false;
		const state = stateResponse();
		// The inputs come first: the seen prune reads them, and this frame must carry the pruned list.
		const inputs = alertInputs(state.tasks, lastAlertInputs);
		// The prune runs on every publish, consumers or not: a card that leaves needs_you and
		// comes back with the same key must light the bell again, also on a board polled over
		// /api/state with no socket and no push device (NODE_ENV=production disables /api/ws).
		pruneSeen(state, inputs);
		// Push works without a board tab (R1-1): skip the frame only when nothing can consume
		// it — no open socket AND no push subscriber. The baseline still moves, so a device
		// that subscribes later is never alerted for changes from before it existed.
		if (!consumers) {
			lastAlertInputs = inputs;
			return false;
		}
		const text = JSON.stringify({
			type: "state",
			state,
		} satisfies ServerMessage);
		if (text === lastStateJson) {
			publishUpdate();
			return false;
		}
		// Diff the cards against the kept baseline and push out-of-band (closed phone app).
		// Fire-and-forget: a push failure never breaks the publish.
		try {
			// A project with prReviewNotify off alerts nothing: strip its pr events before the
			// push (also the first needs_you request event) — the diff never sees the quiet set.
			const quiet = new Set(
				inputs
					.filter(
						(t) =>
							t.kind === "pr_review" &&
							deps.projects.get(t.project)?.store.getSettings()
								.prReviewNotify !== true,
					)
					.map((t) => t.id),
			);
			pushAlerts(
				inputs,
				diffEvents(lastAlertInputs, inputs).filter((e) => !quiet.has(e.taskId)),
				new Set(state.inboxSeen),
			);
		} catch (err) {
			logError("push diff", err);
		}
		lastAlertInputs = inputs;
		lastStateJson = text;
		if (sockets > 0 && deps.serverRef.current !== undefined)
			deps.serverRef.current.publish("board", text);
		publishUpdate();
		return true;
	}

	// Coalesce publish requests within one event-loop turn: a mutating request touches the store
	// several times before its response, and the board should ship one state frame, not five.
	let stateQueued = false;
	function publishSoon(): void {
		if (stateQueued) return;
		stateQueued = true;
		setTimeout(() => {
			stateQueued = false;
			publishState();
		}, 0);
	}

	const logThrottle = keyedThrottle<{ project: string; id: string }>(250, (a) =>
		publish({ type: "log", ...a }),
	);
	function notifyLog(project: string, id: string): void {
		logThrottle(`${project}/${id}`, { project, id });
	}

	async function refreshBehind(): Promise<void> {
		// Stamped on every attempt, failures included: a checkout without upstream must not re-run
		// `git fetch` on every check.
		behindAt = Date.now();
		({ behind, commits: behindCommits } = await behindMain(
			resolve(import.meta.dir, ".."),
		));
	}

	/** Board repos ("owner/repo") the app install check covers, sorted. */
	function boardRepos(): string[] {
		const out = new Set<string>();
		for (const e of deps.projects.values()) {
			const r = e.github === null ? null : ownerRepo(e.github);
			if (r !== null) out.add(r);
		}
		return [...out].sort();
	}

	/** Read the app's name and its installs on the board repos; drops a result for a replaced pair. */
	async function refreshAppCheck(): Promise<void> {
		const app = githubApp;
		if (app === null) {
			appCheck = null;
			return;
		}
		const pem = parseAppPem(app.key);
		if (pem === null) {
			appCheck = null;
			return;
		}
		const check = await checkAppInstalls({
			appId: app.id,
			keyObject: pem.keyObject,
			repos: boardRepos(),
			fetchImpl: githubAppFetch,
		});
		if (githubApp === app) appCheck = check;
	}

	function sampleStats(): void {
		if (sampling) return;
		sampling = true;
		void measureSystem()
			.then(() => {
				const now = Date.now();
				const snap = system.snapshot(
					deps.liveRuns?.() ?? [],
					systemHolds(now),
					now,
				);
				const msg = { type: "system", system: snap } satisfies ServerMessage;
				lastSystemJson = JSON.stringify(msg);
				// Publish every sample: publish() no-ops with 0 sockets, and /api/system in
				// polling mode builds a fresh snapshot.
				publish(msg);
				// Last, so a failed snapshot/publish counts as a failed tick (OTTR-793).
				sampleLog.success();
			})
			.catch((err) => {
				// OTTR-793: a failed sample logs one rate-limited stderr line instead of
				// dropping silently; it still skips one tick.
				sampleLog.failure(err);
			})
			.finally(() => {
				sampling = false;
			});
		if (
			updateCycle.available(Date.now()) === null &&
			Date.now() - behindAt > 300_000 &&
			!refreshingBehind
		) {
			refreshingBehind = true;
			const previous = JSON.stringify(effectiveUpdate());
			void refreshBehind()
				.then(() => {
					if (JSON.stringify(effectiveUpdate()) !== previous) publishUpdate();
				})
				.catch(() => {
					// Failed refresh: keep the last value; the next 5 min window retries.
				})
				.finally(() => {
					refreshingBehind = false;
				});
		}
		// Ten minutes, or at once when the board repos changed: 1 + one call per repo each time.
		if (
			githubApp !== null &&
			!checkingApp &&
			(appCheck === null ||
				Date.now() - appCheck.at > 600_000 ||
				appCheck.repos.join() !== boardRepos().join())
		) {
			checkingApp = true;
			void refreshAppCheck()
				.then(publishState)
				.finally(() => {
					checkingApp = false;
				});
		}
		// Five minutes, like omp's own per-account usage cache; the 1 s state diff ships the result.
		if (
			(quota === null || Date.now() - quota.at > 300_000) &&
			!refreshingQuota
		) {
			refreshingQuota = true;
			void fetchQuota(boardOmpEnv())
				.then((q) => {
					quota = q;
					// OTTR-688: holds of providers the fresh report shows free start now,
					// not at their stored reset; nothing scheduled when nothing released.
					try {
						if (releaseUsageHolds(q, deps.projects.values(), Date.now()) > 0) {
							deps.schedule();
							publishSoon();
						}
					} catch (err) {
						console.log(`[quota] hold release failed: ${errmsg(err)}`);
					}
					publishState();
				})
				.finally(() => {
					refreshingQuota = false;
				});
		}
	}

	// U6: file update cards now instead of waiting for the daily push window.
	async function allowUpdates(req: Request): Promise<Response> {
		let created: Array<{ project: string; id: string }>;
		try {
			const r = await readJson(req);
			if ("error" in r) return r.error;
			const body = r.body as Record<string, unknown>;
			if (
				!Array.isArray(body.ids) ||
				body.ids.length === 0 ||
				body.ids.some((x) => typeof x !== "string")
			)
				return json({ error: "ids must be a non-empty array of strings" }, 400);
			// A repeated id would list its item twice on one card.
			const ids = [...new Set(body.ids as string[])];
			if (body.propose !== undefined && typeof body.propose !== "boolean")
				return json({ error: "propose must be a boolean" }, 400);
			created = await fileUpdateCards(ids, body.propose === true);
			publishSoon();
		} catch (err) {
			const e = err as { status?: unknown; error?: unknown };
			if (
				typeof e === "object" &&
				e !== null &&
				typeof e.status === "number" &&
				typeof e.error === "string"
			)
				return json({ error: e.error }, e.status);
			throw err;
		}
		return json({ tasks: created });
	}

	async function setup(req: Request): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		// Re-checked with the body already read: readJson can hold the request open
		// across the whole onboarding, and an admin created in between must win
		// (R2-4). No await separates this check from the assignments below.
		if (admin !== null) return json({ error: "admin already exists" }, 400);
		const name = typeof r.body.name === "string" ? r.body.name.trim() : "";
		const password = typeof r.body.password === "string" ? r.body.password : "";
		if (name === "" || password.length < 8)
			return json(
				{
					error: "name is required and the password needs 8+ characters",
				},
				400,
			);
		const token = githubTokenParam(r.body.githubToken);
		if (token === null) return json({ error: GITHUB_TOKEN_ERROR }, 400);
		admin = { name, passHash: hashPassword(password) };
		sessionSecret = newSecret();
		apiKey = newSecret();
		githubToken = token;
		const now = Date.now();
		const id = newSessionId();
		sessions = addSession(sessions, {
			id,
			label: sessionLabel(req.headers.get("user-agent")),
			createdAt: now,
			lastSeen: now,
			exp: now + SESSION_MS,
		});
		saveConfig();
		applyGithubToken();
		const secure = viaPublicHost(req);
		return withCookie(
			json({ ok: true, apiKey }),
			sessionCookie(signSession(sessionSecret, name, SESSION_MS, id), secure),
		);
	}

	/** Rate-limit key for a request: the first XFF hop only from a loopback peer, else the peer address. */
	function requestSource(
		req: Request,
		server:
			| { requestIP(req: Request): { address: string } | null }
			| undefined
			| null,
	): string {
		const xff = req.headers.get("x-forwarded-for");
		const peer = server?.requestIP(req)?.address;
		return (
			(loopbackIp(peer) && xff?.split(",")[0]?.trim()) || peer || "unknown"
		);
	}

	async function login(
		req: Request,
		server: { requestIP(req: Request): { address: string } | null },
	): Promise<Response> {
		// X-Forwarded-For is trusted only from a direct-loopback peer (tailscale serve
		// forwards from 127.0.0.1 and sets it); any other peer can fake a fresh XFF
		// per attempt and get a fresh bucket (R2-5).
		const source = requestSource(req, server);
		const r = await readJson(req);
		if ("error" in r) return r.error;
		// Checked after the body is read, so the check, scrypt and recordFailed run in
		// one synchronous block: K bodies held back cannot all pass `allowed` and
		// cash their guesses after the gate opens. A blocked source still never
		// reaches scrypt.
		if (!loginLimiter.allowed(source))
			return json({ error: "too many attempts, try again later" }, 429);
		const name = typeof r.body.name === "string" ? r.body.name.trim() : "";
		const password = typeof r.body.password === "string" ? r.body.password : "";
		const remember =
			typeof r.body.remember === "boolean" ? r.body.remember : true;
		if (admin === null || sessionSecret === null)
			return json({ error: "invalid name or password" }, 401);
		if (!verifyAdminLogin(name, password, admin)) {
			loginLimiter.recordFailed(source);
			return json({ error: "invalid name or password" }, 401);
		}
		const now = Date.now();
		const id = newSessionId();
		sessions = addSession(sessions, {
			id,
			label: sessionLabel(req.headers.get("user-agent")),
			createdAt: now,
			lastSeen: now,
			exp: now + SESSION_MS,
		});
		saveConfig();
		return withCookie(
			json({ ok: true }),
			sessionCookie(
				signSession(sessionSecret, name, SESSION_MS, id),
				viaPublicHost(req),
				remember,
			),
		);
	}

	async function logout(req: Request): Promise<Response> {
		const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
		if (sessionSecret !== null && token !== undefined) {
			const v = verifySession(sessionSecret, token);
			if (v !== null && v.id !== null && sessions.some((s) => s.id === v.id)) {
				sessions = dropSession(sessions, v.id);
				saveConfig();
			}
		}
		return withCookie(
			json({ ok: true }),
			clearSessionCookie(viaPublicHost(req)),
		);
	}

	async function sshHostCheck(
		paths: SshPaths,
		remote: GitRemote,
		trust: unknown,
	): Promise<Response | null> {
		const host = await checkHostKey(paths.dir, remote, trust, keyscan);
		if (host === null) return null;
		if ("needsTrust" in host) return json(host, 409);
		return json({ error: redact(host.error, gitSecrets()) }, 400);
	}

	async function testSshKey(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const remote = parseGitUrl(r.body.url);
		if ("error" in remote) return json({ error: GIT_URL_ERROR }, 400);
		if (remote.scheme !== "ssh")
			return json(
				{ error: "url must be an ssh git URL (git@host:… or ssh://…)" },
				400,
			);
		const k = resolveTestKey(r.body.key);
		if ("error" in k) return json({ error: k.error }, 400);
		const paths = sshPaths(sshDir);
		const host = await sshHostCheck(paths, remote, r.body.trust);
		if (host !== null) return host;
		const t = await testRemote(
			String(r.body.url).trim(),
			gitAuthEnv({
				ambientHelpers,
				tokens: gitTokens,
				key: k.key,
				knownHosts: paths.knownHosts,
			}),
			k.key === null ? gitSecrets() : [...gitSecrets(), k.key],
		);
		if ("error" in t) return json({ error: t.error }, 400);
		return json({ ok: true });
	}

	/** Probes a Hindsight bank list with a candidate key; a number is the HTTP status, a string is the fetch failure (errmsg). */
	async function hindsightProbe(
		url: string,
		token: string,
	): Promise<number | string> {
		try {
			const res = await noRedirectFetch(`${url}/v1/default/banks`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(5000),
			});
			return res.status;
		} catch (err) {
			return errmsg(err);
		}
	}

	/** Resolves the Hindsight base URL from the request or env; a Response rejects the save. */
	function hindsightUrlTarget(
		body: Record<string, unknown>,
	): { error: Response } | { url: string; raw: string } {
		const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
		if (rawUrl !== "") {
			try {
				const u = new URL(rawUrl.replace(/\/+$/, ""));
				if (u.protocol !== "http:" && u.protocol !== "https:") throw 0;
			} catch {
				return {
					error: json(
						{
							error:
								"the server URL must be an http(s) address like http://hindsight.local:8888",
						},
						400,
					),
				};
			}
		}
		const target = rawUrl !== "" ? rawUrl : process.env.HINDSIGHT_API_URL;
		if (!target)
			return {
				error: json(
					{
						error:
							"HINDSIGHT_API_URL is not set: this board's turns use omp's own memory settings",
					},
					400,
				),
			};
		return { url: target.replace(/\/+$/, ""), raw: rawUrl };
	}

	/** A request without a key keeps the key in effect; a pasted key must be one word of printable characters, at most 500. */
	function hindsightTokenOf(body: Record<string, unknown>): {
		token: string;
		provided: boolean;
	} {
		const provided = typeof body.token === "string";
		return {
			provided,
			token:
				typeof body.token === "string"
					? body.token.trim()
					: (process.env.HINDSIGHT_API_TOKEN ?? ""),
		};
	}

	/** Runs the pre-save key check: a number is the accepted HTTP status, a Response rejects the save. */
	async function hindsightGate(
		url: string,
		token: string,
	): Promise<number | Response> {
		const probed = await hindsightProbe(url, token);
		if (typeof probed === "string")
			return json(
				{ error: `Hindsight at ${url} did not answer: ${probed}` },
				502,
			);
		if (probed === 401 || probed === 403)
			return json(
				{ error: `Hindsight at ${url} rejected the key (HTTP ${probed})` },
				400,
			);
		if (probed < 200 || probed > 299)
			return json(
				{ error: `Hindsight at ${url} answered HTTP ${probed}` },
				502,
			);
		return probed;
	}

	async function saveHindsight(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const picked = hindsightUrlTarget(r.body);
		if ("error" in picked) return picked.error;
		// A wrong key fails every turn's memory without a sign (dev-token did for two
		// days), so the server must accept the key before the board keeps it.
		const { token, provided } = hindsightTokenOf(r.body);
		if (provided) {
			// A url-only save writes no secret and stays allowed.
			const noBox = sealGuard();
			if (noBox !== null) return noBox;
		}
		if (provided && !/^[\x21-\x7E]{1,500}$/.test(token))
			return json(
				{
					error:
						"the key must be one word of printable characters, at most 500",
				},
				400,
			);
		const status = await hindsightGate(picked.url, token);
		if (typeof status !== "number") return status;
		if (picked.raw !== "") hindsightUrl = picked.url;
		if (provided) hindsightToken = token;
		saveConfig();
		// applyHindsight only seeds the env now, so it cannot throw by a flip;
		// the fresh check makes the returned view report the new backend at once.
		applyHindsight();
		await memoryHealthTick();
		return json(hindsightView());
	}

	async function notificationPrefs(req: Request): Promise<Response> {
		const endpoint = new URL(req.url).searchParams.get("endpoint");
		const mutedProjects = loadMuted();
		if (endpoint === null) return json({ classes: null, mutedProjects });
		const sub = loadSubs(deps.gstore).find((s) => s.endpoint === endpoint);
		return sub === undefined
			? json({ error: "unknown endpoint" }, 404)
			: json({ classes: sub.classes, mutedProjects });
	}

	async function saveNotificationPrefs(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const b = r.body;
		if ("endpoint" in b) {
			// parsed JSON boundary: trusted only after the per-class boolean check
			const raw = b.classes as Partial<Record<AlertClass, unknown>> | null;
			if (
				typeof b.endpoint !== "string" ||
				typeof raw !== "object" ||
				raw === null ||
				ALERT_CLASSES.some((c) => typeof raw[c] !== "boolean")
			)
				return json({ error: "invalid prefs" }, 400);
			const subs = loadSubs(deps.gstore);
			const sub = subs.find((s) => s.endpoint === b.endpoint);
			if (sub === undefined) return json({ error: "unknown endpoint" }, 404);
			// A fresh object of the three switches: extra posted keys never reach the store.
			const classes: ClassPrefs = {
				request: raw.request === true,
				error: raw.error === true,
				complete: raw.complete === true,
			};
			saveSubs(
				deps.gstore,
				subs.map((s) => (s === sub ? { ...s, classes } : s)),
			);
			return json({ ok: true });
		}
		if (!isStringList(b.mutedProjects, 500))
			return json({ error: "invalid prefs" }, 400);
		deps.gstore.set("notify_muted_projects", [...new Set(b.mutedProjects)]);
		return json({ ok: true });
	}

	async function presence(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const { tab, focused } = r.body;
		if (
			typeof tab !== "string" ||
			tab.length === 0 ||
			tab.length > 100 ||
			typeof focused !== "boolean"
		)
			return json({ error: "invalid presence" }, 400);
		// Delete first either way: a heartbeat re-inserts at the end, keeping map order = recency.
		focusAt.delete(tab);
		if (focused) {
			focusAt.set(tab, now());
			for (const stale of focusAt.keys()) {
				if (focusAt.size <= PRESENCE_TABS_MAX) break;
				focusAt.delete(stale);
			}
		}
		return json({ ok: true });
	}

	/** Acks one PR review card: clears an unseen comment wave and acks its stamp key, so the
	 * bell row and the live alert retract like a read. The next wave is new again. Returns
	 * whether the wave was cleared, so the caller publishes the cleared stamp. */
	function ackPrReview(e: Entry, t: Task, added: string[]): boolean {
		const row = e.store.getPrReviewByTask(t.id);
		let cleared = false;
		if (row !== null) {
			if (row.commentsUnseen) {
				e.store.setPrComments(row.number, row.commentsAt ?? Date.now(), false);
				cleared = true;
			}
			if (row.commentsAt !== null) added.push(`pr:${t.id}:${row.commentsAt}`);
		}
		added.push(
			taskEntryKey({
				id: t.id,
				asked: t.asked,
				kind: t.kind,
				prOccurrence: {
					draft: row !== null ? e.store.lastPrRun(row.number) : null,
				},
			}),
		);
		return cleared;
	}
	/** One acked task's keys: a PR review card's stamp keys, or its needs_you entry. Returns
	 * whether an unseen PR comment wave was cleared. */
	function ackTaskKeys(e: Entry, t: Task, added: string[]): boolean {
		if (t.kind === "pr_review") return ackPrReview(e, t, added);
		if (t.state === "needs_you") added.push(taskEntryKey(t));
		return false;
	}
	/** One project's acked ids' keys. Returns whether an unseen PR comment wave was cleared. */
	function ackProjectKeys(
		e: Entry,
		ids: Set<string>,
		added: string[],
	): boolean {
		let cleared = false;
		for (const id of ids) {
			try {
				const t = e.store.getTask(id);
				if (t === null) continue;
				if (ackTaskKeys(e, t, added)) cleared = true;
			} catch (err) {
				logStoreError(e.store.name, err);
			}
		}
		return cleared;
	}
	/** The keys a card ack adds: its needs_you entry plus every alert it has live on the devices.
	 * prFlagCleared says an unseen PR comment wave was read, so the frame must publish even when
	 * the seen list did not change. */
	function cardAckAdded(ids: Set<string>): {
		added: string[];
		prFlagCleared: boolean;
	} {
		const added = liveAlerts.filter((a) => ids.has(a.taskId)).map((a) => a.key);
		let prFlagCleared = false;
		for (const e of deps.projects.values()) {
			if (ackProjectKeys(e, ids, added)) prFlagCleared = true;
		}
		return { added, prFlagCleared };
	}
	/** The single keys/taskIds/drop list of a seen request, or null when the body is malformed. */
	function seenList(
		body: Record<string, unknown>,
	): { list: string[]; field: "keys" | "taskIds" | "drop" } | null {
		const { keys, taskIds, drop } = body as {
			keys?: unknown;
			taskIds?: unknown;
			drop?: unknown;
		};
		const given = [keys, taskIds, drop].filter((v) => v !== undefined);
		const list = given[0];
		// An over-long key is refused, never stored short or dropped: a silent drop
		// would answer 200 and leave the entry unread.
		if (
			given.length !== 1 ||
			!isStringList(list, 5000) ||
			list.some((k) => k.length > SEEN_KEY_MAX)
		)
			return null;
		const field =
			keys !== undefined ? "keys" : drop !== undefined ? "drop" : "taskIds";
		return { list, field };
	}
	/** Stores the new seen list and retracts pushed alerts when it changed. */
	function persistInboxSeen(before: string[], after: string[]): void {
		if (
			after.length !== before.length ||
			after.some((k, i) => k !== before[i])
		) {
			deps.gstore.set("inbox_seen", after);
			try {
				retractAcked();
			} catch (err) {
				logError("push retraction", err);
			}
			publishSoon();
		}
	}
	async function inboxSeen(req: Request): Promise<Response> {
		// Task keys embed the ask JSON, so a "Mark all as read" list outgrows the default cap.
		const r = await readJson(req, 4 * 1024 * 1024);
		if ("error" in r) return r.error;
		const picked = seenList(r.body);
		if (picked === null) return json({ error: "invalid seen list" }, 400);
		const { list } = picked;
		const before = loadInboxSeen();
		let next: string[];
		if (picked.field === "keys")
			next = [...before, ...ackKeys(list, liveAlerts)];
		else if (picked.field === "drop") {
			const gone = new Set(list);
			next = before.filter((k) => !gone.has(k));
		} else {
			// A card ack: its current needs_you entry plus every alert it has live on the devices.
			const ids = new Set(list);
			const ack = cardAckAdded(ids);
			next = [...before, ...ackKeys(ack.added, liveAlerts)];
			// The cleared comment stamp must reach the frame even when the seen list
			// did not change: the bell row and the live alert read the occurrence.
			if (ack.prFlagCleared) publishSoon();
		}
		persistInboxSeen(before, normalizeSeen(next));
		return json({ ok: true });
	}

	async function tickGithubWatchers(
		matches: Array<{ name: string }>,
		kind: string | null,
	): Promise<Response> {
		for (const { name } of matches) {
			if (kind === "ci") {
				if (deps.ciWatchTick === undefined)
					throw new Error("hosted mode without a ciWatchTick");
				await deps.ciWatchTick({ manual: name });
			} else if (kind === "prReviews") {
				await prWatcher.tick({ manual: name });
			} else {
				await issueWatcher.tick({ manual: name });
			}
		}
		return json({ ok: true });
	}

	async function hostedGithubEvent(req: Request): Promise<Response> {
		const delivery = req.headers.get("x-github-delivery");
		if (delivery === null || delivery === "")
			return json({ error: "x-github-delivery header required" }, 400);
		const r = await readJson(req, MAX_EVENT_BODY_BYTES);
		if ("error" in r) return r.error;
		// Recorded only after the body parses: a malformed retry must not burn the id.
		if (!deliveries.add(delivery)) return json({ ok: true, deduped: true });
		const kind = githubEventWatch(req.headers.get("x-github-event"));
		const repo = eventRepository(r.body);
		if (kind === null || repo === null) return json({ ok: true });
		const matches = [...deps.projects.values()].filter(
			(e) => e.github !== null && ownerRepo(e.github) === repo,
		);
		if (matches.length === 0) return json({ ok: true });
		return tickGithubWatchers(matches, kind);
	}

	/** Returns the socket-wall response for a non-hosted request, or null to continue. */
	function wsWall(req: Request): Response | null {
		const refusal = upgradeRefusal(
			req.headers.get("host"),
			req.headers.get("origin"),
			deps.port,
			deps.publicHosts,
			!walled(req) || authorized(req),
		);
		if (refusal)
			return json({ error: refusal }, refusal === "unauthorized" ? 401 : 403);
		return null;
	}

	function wsUpgrade(
		req: Request,
		srv: { upgrade(req: Request): boolean },
	): Response | undefined {
		if (prod)
			return json(
				{ error: "live updates are disabled in production mode" },
				404,
			);
		// Hosted mode: the same wall as api(), so only a signed owner opens the socket.
		if (deps.hosted !== undefined) {
			const refused = hostedRefusal(deps.hosted, req);
			if (refused !== null) return refused;
			if (srv.upgrade(req)) return;
			return json({ error: "websocket upgrade required" }, 400);
		}
		// Same wall rule as api(): walled hosts need a live session or the API key (browsers
		// send cookies on the handshake); direct loopback with a loopback Host stays open.
		const wall = wsWall(req);
		if (wall !== null) return wall;
		if (srv.upgrade(req)) return;
		return json({ error: "websocket upgrade required" }, 400);
	}

	async function handleGETProjectsGithubVisibilityByProject(
		req: BunRequest<"/api/projects/:project/github/visibility">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.github === null)
			return json({ error: "project has no GitHub remote" }, 409);
		const repo = ownerRepo(`https://github.com/${e.github}.git`) ?? e.github;
		try {
			const r = await gh(["api", `repos/${repo}`], 30_000);
			if (r.code !== 0)
				return json(
					{
						error: `gh api repos/${repo} failed: ${r.stderr.trim().slice(0, 300)}`,
					},
					502,
				);
			const body = JSON.parse(r.stdout) as { private?: unknown };
			if (typeof body.private !== "boolean")
				return json({ error: "GitHub repo answer has no private field" }, 502);
			return json({ private: body.private });
		} catch (err) {
			return json({ error: errmsg(err) }, 502);
		}
	}

	async function handlePOSTProjectsTasksCancelByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/cancel">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		// Optional: why the user turned the card down; a trending proposal keeps it.
		const rawReason = r.body.reason;
		if (rawReason !== undefined && typeof rawReason !== "string")
			return json({ error: "reason must be a string" }, 400);
		const reason = rawReason?.trim() || null;
		if (reason !== null && reason.length > 1000)
			return json({ error: "reason must be at most 1000 characters" }, 400);
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const out = await deps.cancel(
			found.e,
			found.task.id,
			r.body.force === true,
		);
		if ("error" in out) return json({ error: out.error }, out.status);
		if ("kept" in out) return json({ ok: false, kept: out.kept });
		// A cancelled trending proposal turns its repo into a user-rejected no_fit;
		// any other card is a no-op here.
		found.e.store.rejectTrendingProposal(found.task.id, reason);
		return json({ ok: true });
	}

	async function handlePOSTProjectsTasksRefileByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/refile">,
	): Promise<Response> {
		// No body: this route takes no options (api()'s Origin wall still covers the POST).
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt === null)
			return json({ error: "only a cancelled card can be refiled" }, 409);
		// OTTR-781: a cancelled Dependabot card blocks its PR in the supervisor's dedupe;
		// refile files a fresh card with the same prompt and source-PR fields so the ship
		// step adopts the PR instead of opening a duplicate.
		const prefix = dependabotHeadPrefix(task.prompt.split("\n", 1)[0] ?? "");
		if (prefix === null) return json({ error: "not a Dependabot card" }, 400);
		// Any non-cancelled card covering the same PR blocks the refile: the refiled card
		// while it runs, and a done card too (the update already landed). The cancelled
		// source card never blocks (it is cancelled).
		const blocker = e.store
			.listTasks()
			.find(
				(t) =>
					(t.prompt.split("\n", 1)[0] ?? "").startsWith(prefix) &&
					t.cancelledAt === null,
			);
		if (blocker !== undefined)
			return json(
				{ error: `${blocker.id} already covers this Dependabot PR` },
				409,
			);
		const child = e.store.createTask(task.prompt);
		e.store.updateTask(child.id, {
			promptAuthor: "board",
			sourcePrNumber: task.sourcePrNumber,
			sourcePrUrl: task.sourcePrUrl,
			sourcePrHeadRef: task.sourcePrHeadRef,
			sourcePrHeadSha: task.sourcePrHeadSha,
			sourcePrCrossRepo: task.sourcePrCrossRepo,
			sourcePrDependabot: task.sourcePrDependabot,
		});
		deps.schedule();
		return json({ ok: true, id: child.id });
	}

	async function handlePOSTProjectsTasksModelByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/model">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		// The revision guard outranks the state refusal below: a stale pick answers
		// 409 with the current card instead of a bare precondition error.
		const stale = staleEditResponse(e, task, r.body);
		if (stale !== null) return stale;
		if (
			task.state !== "running" &&
			task.state !== "preparing" &&
			task.state !== "queued" &&
			task.state !== "needs_you"
		)
			return json(
				{
					error:
						"only a running, preparing, queued, or needs-you task can switch model",
				},
				409,
			);
		if (r.body.model === undefined)
			return json({ error: "model must be a string" }, 400);
		// Same landing rule as steering: the row is the queue, and runTurn re-reads it
		// per turn, so the switch takes effect with the agent's next turn. A needs-you
		// card has no live run: the pick pre-stages the model its reply turn spawns with.
		const model = modelParam(r.body);
		if (model instanceof Response) return model;
		const res = applyUserEdit(e, task, { model }, r.body);
		if (res instanceof Response) return res;
		return json(taskView(e, res));
	}

	async function handlePOSTProjectsTasksSteerEditByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/steer/edit">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		// The revision guard outranks the state preconditions below: a stale edit
		// answers 409 with the current card, so the drawer's conflict flow keeps the
		// draft even when the newer state would refuse the edit on its own.
		const stale = staleEditResponse(e, task, r.body);
		if (stale !== null) return stale;
		if (task.pendingPrompt === null)
			return json({ error: "no steering is queued" }, 409);
		// "." is the auto-resume marker, not user steering; rewriting it would
		// strand a task the turn loop would otherwise heal.
		if (task.pendingPrompt.trim() === ".")
			return json(
				{ error: "the queued turn is an automatic resume, not steering" },
				409,
			);
		const text = r.body.text;
		if (typeof text !== "string" || text.trim().length === 0)
			return json({ error: "text must be a non-empty string" }, 400);
		// Check and write are sync, so the scheduler (same event loop) cannot start a
		// turn in between: the queued text never changes after the pre-edit read.
		// Queued images stay; this edits the words. A human rewrote the text, so it is
		// no longer the supervisor's park even when the queue carried one.
		const res = applyUserEdit(
			e,
			task,
			{
				pendingPrompt: text.trim(),
				pendingBy: "user",
			},
			r.body,
		);
		if (res instanceof Response) return res;
		return json(taskView(e, res));
	}

	async function handlePOSTProjectsTasksSteerCancelByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/steer/cancel">,
	): Promise<Response> {
		// The body read finishes before the task is resolved: a body that pauses
		// mid-read must not let the turn loop's queued→running flip hide behind the
		// earlier snapshot, so the checks and the guarded write below stay one sync
		// block, like every other user-edit route.
		const body = await readOptionalJson(req);
		if ("error" in body) return body.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		// The revision guard outranks the state preconditions below: a stale discard
		// answers 409 with the current card, so the drawer's conflict flow keeps the
		// draft even when the newer state would refuse the cancel on its own.
		const stale = staleEditResponse(e, task, body.body);
		if (stale !== null) return stale;
		if (task.pendingPrompt === null)
			return json({ error: "no steering is queued" }, 409);
		// "." is the auto-resume marker, not user steering; canceling it would
		// strand a task the turn loop would otherwise heal.
		if (task.pendingPrompt.trim() === ".")
			return json(
				{ error: "the queued turn is an automatic resume, not steering" },
				409,
			);
		// The row is the queue: clearing the pending text withdraws the steer. A
		// follow-up turn queued at turn end existed only to deliver it — settle the
		// card, or runTurn would re-send the whole task prompt as a fresh turn.
		const queuedOnlyForTheSteer =
			task.state === "queued" && task.stage !== "todo";
		const res = applyUserEdit(
			e,
			task,
			{
				pendingPrompt: null,
				pendingBy: null,
				pendingImages: [],
				...(queuedOnlyForTheSteer
					? {
							state: "needs_you",
							needsReason:
								"Steering canceled before the agent saw it. Reply to continue, or cancel the card.",
						}
					: {}),
			},
			body.body,
		);
		if (res instanceof Response) return res;
		return json(taskView(e, res));
	}

	async function handleGETProjectsTasksLogByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/log">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const rawFrom = new URL(req.url).searchParams.get("from");
		if (rawFrom !== null && !/^\d+$/.test(rawFrom))
			return json({ error: "from must be a non-negative integer" }, 400);
		const from = rawFrom === null ? 0 : Number(rawFrom);
		const file = found.e.store.logPath(found.task.id);
		let fd: number;
		try {
			fd = openRegular(file);
		} catch {
			return new Response("", {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"X-Log-Size": "0",
					Connection: "close",
				},
			});
		}
		try {
			const size = fstatSync(fd).size;
			const len = Math.max(0, Math.min(LOG_CHUNK_BYTES, size - from));
			const buf = Buffer.alloc(len);
			if (len > 0) readSync(fd, buf, 0, len, from);
			return new Response(buf, {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"X-Log-Size": String(size),
					Connection: "close",
				},
			});
		} finally {
			closeSync(fd);
		}
	}

	async function handleGETProjectsTasksDiffByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/diff">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		// Same source rule as the drawer's diffFiles: captured text for finished cards,
		// the live branch diff for open ones. Git output only — no path reaches the fs.
		// A merge-hold mismatch park also serves the captured text: it holds the exact
		// push-side delta the gate flagged, which the live worktree diff cannot show
		// once the branch is integrated.
		const text =
			task.stage === "done" ||
			task.cancelledAt !== null ||
			task.needsReason === MERGE_HOLD_MISMATCH_REASON
				? task.diffText
				: task.worktree === null || e.target === null
					? null
					: await diffText(task.worktree, task.base ?? "HEAD", e.target).catch(
							() => null,
						);
		if (text === null || text === "") return json({ error: "no diff" }, 404);
		return new Response(text, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Security-Policy": "sandbox",
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
				Connection: "close",
			},
		});
	}

	async function handleGETProjectsTasksFilesByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/files">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { task } = found;
		const rel = new URL(req.url).searchParams.get("path") ?? "";
		if (!rel || rel.split(/[\\/]/).includes("..") || isAbsolute(rel)) {
			return json({ error: "bad path" }, 400);
		}
		if (task.worktree === null) return json({ error: "unknown task" }, 404);
		const file = join(task.worktree, rel);
		if (!resolve(file).startsWith(resolve(task.worktree) + sep))
			return json({ error: "bad path" }, 404);
		const f = Bun.file(file);
		if (!(await f.exists())) return json({ error: "unknown file" }, 404);
		return new Response(f, {
			headers: {
				"Content-Type": f.type || "application/octet-stream",
				"Content-Security-Policy": "sandbox allow-scripts",
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
				Connection: "close",
			},
		});
	}

	async function handleGETProjectsTasksSavedFilesByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/saved-files">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const rel = new URL(req.url).searchParams.get("path") ?? "";
		if (!rel || rel.split(/[\\/]/).includes("..") || isAbsolute(rel)) {
			return json({ error: "bad path" }, 400);
		}
		const dir = join(e.store.tasksDir, "quarantine", task.id);
		const file = join(dir, rel);
		if (!resolve(file).startsWith(resolve(dir) + sep))
			return json({ error: "bad path" }, 400);
		// readBelow anchors at the trusted data root (no worker can replace it) and
		// refuses a symlink at EVERY component below it with O_NOFOLLOW, so a
		// worker-planted link at the card folder or below cannot widen the read. The
		// cap only bounds the buffer: saveDoneFiles caps new saves at 4 MiB, but the
		// quarantine also holds older uncapped entries (scratch, image retries).
		let bytes: Buffer | null;
		try {
			bytes = readBelow(e.store.dataRoot, file, 64 * 1024 * 1024);
		} catch {
			// refused: a symlink at any component, a non-regular entry, or oversize
			return json({ error: "unknown file" }, 404);
		}
		if (bytes === null) return json({ error: "unknown file" }, 404);
		const f = Bun.file(file); // extension-based Content-Type only; no disk access
		// readBelow returns a subarray view; BodyInit wants a standalone buffer.
		return new Response(new Uint8Array(bytes), {
			headers: {
				"Content-Type": f.type || "application/octet-stream",
				"Content-Security-Policy": "sandbox allow-scripts",
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
				Connection: "close",
			},
		});
	}

	async function handlePOSTProjectsQueueByProject(
		req: BunRequest<"/api/projects/:project/queue">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		const order = r.body.order;
		if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
			return json({ error: "order must be an array of task ids" }, 400);
		}
		if (!e.store.reorderQueue(order))
			return json({ error: "order does not match the current queue" }, 409);
		deps.schedule();
		return json({ ok: true });
	}

	async function handlePOSTProjectsReleaseSummaryByProject(
		req: BunRequest<"/api/projects/:project/release-summary">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const sha = r.body.sha;
		if (typeof sha !== "string" || /^[0-9a-f]{7,40}$/.test(sha) === false)
			return json({ error: "sha must be a 7-40 character hex string" }, 400);
		let resolved: { target: string; sha: string };
		try {
			resolved = await resolveTarget(
				e.path,
				true,
				e.store.getSettings().originUrl,
				e.store.getSettings().targetBranch,
			);
		} catch (err) {
			return json({ error: errmsg(err) }, 409);
		}
		const plan = await planRelease({
			mainPath: e.path,
			target: resolved.target,
			sha,
			originUrl: e.store.getSettings().originUrl,
		}).catch((err) => json({ error: errmsg(err) }, 409));
		if (plan instanceof Response) return plan;
		// Before the first release there is nothing to consolidate: the dialog
		// shows the deterministic notes and skips the model call.
		if (plan.from === null) return json({ summary: null, reason: null });
		// Window start: the last release tag's commit time; merges are serialized, so a
		// task is in from..sha exactly when it finished after that commit landed.
		const since =
			Number(
				(
					await git(["log", "-1", "--format=%ct", plan.from], e.path)
				).stdout.trim(),
			) * 1000;
		const all = e.store.listTasks();
		const tasks = includedTasks(all, since);
		const cards = tasks.map((t) => {
			// The release notes are the card's own ready report: the latest settled
			// turn with outcome ready. Task.details is the wrong source — every
			// settled turn overwrites it (turn.ts), so it holds the merge turn's
			// integration output, not the notes.
			const ready = e.store
				.listTurns(t.id)
				.filter((turn) => turn.outcome === "ready")
				.at(-1);
			return {
				id: t.id,
				title: t.title,
				details: ready?.details ?? null,
			};
		});
		const result = await summarizeRelease({
			notes: plan.notes,
			cards,
			spawn: deps.releaseSummarySpawn,
		});
		// The fallback is a normal outcome, not an error status.
		return json(result);
	}

	async function handleGETProvisioning(): Promise<Response> {
		let server: ProvisioningResponse["server"] = null;
		if (alate.url !== null) {
			const h = await alateHealth(alate);
			const upd = h.ok ? h.body.update : undefined;
			server = {
				url: alate.url,
				keySet: alate.key !== null,
				lastError: alateProvisionError,
				health: h.ok
					? {
							state: "ok",
							version:
								typeof h.body.version === "string" ? h.body.version : null,
							behind:
								typeof upd === "object" &&
								upd !== null &&
								"behind" in upd &&
								upd.behind === true,
							pending: h.body.pending === true,
							running: h.body.running === true,
						}
					: { state: "down" },
			};
		}
		// One home, the same one the env routes read: the shared workers home
		// when the deploy passes one, else the board's own home (R5-1: never a
		// worker-writable directory for the env list).
		const workers = workerProjects(layerHome(workersHome)).map((name) => ({
			name,
			apt: existsSync(aptListPath(name, workersHome)),
			tools: existsSync(toolsListPath(name, workersHome)),
			requirements: existsSync(requirementsListPath(name, workersHome)),
			env: existsSync(envListPath(name, workersHome)),
		}));
		return json({
			server,
			workers,
			userLayer: readUserLayer(layerHome(workersHome)),
		} satisfies ProvisioningResponse);
	}

	async function handlePOSTProjectsOrder(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const body = r.body as { order?: unknown };
		if (
			!Array.isArray(body.order) ||
			body.order.some((n) => typeof n !== "string")
		) {
			return json({ error: "order must be an array of project names" }, 400);
		}
		const order = body.order as string[];
		if (new Set(order).size !== order.length) {
			return json({ error: "order has duplicate names" }, 400);
		}
		for (const name of order) {
			if (!deps.projects.has(name)) {
				return json({ error: `unknown project: ${name}` }, 400);
			}
		}
		deps.shared.projectOrder = mergeProjectOrder(order, [
			...deps.projects.keys(),
		]);
		saveConfig();
		deps.schedule();
		return json({ ok: true });
	}

	async function handlePOSTProjectsTasksUnmarkByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/unmark-research">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		// The in-flight turn holds its own task snapshot, so clearing mid-run
		// cannot change the settle that is about to happen anyway.
		if (task.state === "running")
			return json(
				{ error: "a running task cannot be unmarked as research" },
				409,
			);
		// Clears only the flag: turns, commits and the harvested report stay;
		// the next settle classifies from the branch like any other card.
		return json(taskView(e, e.store.updateTask(task.id, { research: false })));
	}

	async function handleGETProjectsGithubByProject(
		req: BunRequest<"/api/projects/:project/github">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.github === null)
			return json({ error: "project has no GitHub remote" }, 409);
		// Same repo id the fork watcher derives from the remote.
		const repo = ownerRepo(`https://github.com/${e.github}.git`) ?? e.github;
		try {
			const forks = await listForks(repo, gh);
			return json({ repo, ...forkSummary(forks, Date.now()) });
		} catch (err) {
			return json({ error: errmsg(err) }, 502);
		}
	}

	async function handlePOSTProjectsPrsCheckByProject(
		req: BunRequest<"/api/projects/:project/prs/check">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.github === null)
			return json({ error: "project has no GitHub remote" }, 409);
		// Body optional: a manual run of the same watch the hourly poll uses.
		await prWatcher.tick({ manual: req.params.project });
		return json({ ok: true });
	}

	async function handlePOSTProjectsForksCheckByProject(
		req: BunRequest<"/api/projects/:project/forks/check">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.github === null)
			return json({ error: "project has no GitHub remote" }, 409);
		// Body optional: a manual run of the same watch the hourly poll uses.
		await forkWatcher.tick({ manual: req.params.project });
		return json({ ok: true });
	}

	async function handlePOSTProjectsTasksFinishByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/finish-kept">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const out = await deps.finishKept(found.e, found.task.id, r.body.choices);
		return "error" in out
			? json({ error: out.error }, out.status)
			: json({ ok: true });
	}

	async function handlePOSTProjectsTasksStopByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/stop">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const out = await deps.stopTurn(found.e, found.task.id);
		return "error" in out
			? json({ error: out.error }, out.status)
			: json({ ok: true });
	}

	async function handlePOSTProjectsTasksRestartByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/restart-session">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.state !== "needs_you")
			return json(
				{ error: "only needs-you tasks can restart their session" },
				409,
			);
		if (task.sessionId === null)
			return json({ error: "task has no session to restart" }, 409);
		e.store.updateTask(task.id, {
			sessionId: null,
			pendingImages: [],
			asked: null, // a fresh session knows nothing of the old ask
			pendingPrompt: LOST_SESSION,
			pendingBy: "supervisor",
			state: "queued",
			holdUntil: null,
			queuedAt: Date.now(),
			needsReason: null,
		});
		deps.schedule();
		return json({ ok: true });
	}

	async function handlePOSTProjectsTasksStarByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/star">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (typeof r.body.starred !== "boolean")
			return json({ error: "starred must be a boolean" }, 400);
		return json(
			taskView(e, e.store.updateTask(task.id, { starred: r.body.starred })),
		);
	}

	async function handleGETProjectsTasksContextByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/context">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		return json({
			context: sessionContext(found.e.store.sessionsDir, found.task.sessionId),
		});
	}

	async function handlePOSTProjectsTasksEditStopByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/edit/stop">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		// Idempotent, and guard-free on purpose: the drawer posts it on every editor
		// close (a save already cleared the hold), and clearing can only let a card
		// start sooner — it never stalls one. Contentless: it never moves the revision.
		e.store.releasePromptHold(task.id);
		return json({ ok: true });
	}

	async function handlePOSTProjectsTasksEditStartByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/edit/start">,
	): Promise<Response> {
		// Body before the task, like every guarded user-edit route: a slow body must
		// not hide the card's state behind an older snapshot.
		const body = await readOptionalJson(req);
		if ("error" in body) return body.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		// The revision guard outranks the state refusal below: a stale claim answers
		// 409 with the current card, so the editor can show the current version
		// through the conflict flow instead of a bare precondition error.
		const stale = staleEditResponse(e, task, body.body);
		if (stale !== null) return stale;
		// Same rule as /edit: only a queued todo card, a parked backlog card, or a held
		// proposal parked needs_you has a prompt worth guarding — and a hold on a started
		// card could stall a later reply turn.
		if (
			!(
				(task.stage === "todo" && task.state === "queued") ||
				(task.stage === "backlog" && task.state === "idle") ||
				(task.stage === "todo" &&
					task.state === "needs_you" &&
					isProposalReason(task.needsReason))
			) ||
			task.cancelledAt !== null ||
			e.store.listTurns(task.id).length > 0
		)
			return json(
				{
					error:
						"only a queued todo task or a parked backlog task can be edited",
				},
				409,
			);
		// The hold is contentless bookkeeping (it never moves the revision), and with a
		// revision the claim itself is guarded: a content edit that landed between the
		// editor's load and this claim refuses the claim, so the editor never arms a
		// stale draft with a fresh revision. Body-less callers keep the unconditional
		// claim, like every guarded route's no-revision path. staleEditResponse has
		// already validated the revision, so only absence reaches the null path.
		const rev = body.body.revision;
		const res = e.store.claimPromptHold(
			task.id,
			PROMPT_EDIT_HELD,
			typeof rev === "number" ? rev : null,
		);
		if (!res.ok)
			return json(
				{
					error: "card changed since it was loaded",
					task: taskView(e, res.task),
				},
				409,
			);
		return json({ ok: true, revision: res.task.revision });
	}

	async function handleGETProjectsTasksImagesByProjectAndIdAndName(
		req: BunRequest<"/api/projects/:project/tasks/:id/images/:name">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const name = req.params.name;
		// Name is joined into a path: require the exact pattern plus membership in the task's image lists.
		if (
			!/^\d+\.(png|jpg|gif|webp)$/.test(name) ||
			!(
				task.images.includes(name) ||
				task.pendingImages.includes(name) ||
				task.shots.includes(name)
			)
		) {
			return json({ error: "unknown image" }, 404);
		}
		const file = join(e.store.imagesDir(task.id), name);
		const st = statSync(file, { throwIfNoEntry: false });
		if (!st?.isFile()) return json({ error: "unknown image" }, 404);
		const f = Bun.file(file);
		return new Response(f, {
			headers: {
				"Content-Type": f.type,
				"Cache-Control": "private, max-age=31536000, immutable",
				Connection: "close",
			},
		});
	}

	async function handlePOSTProjectsBoardByProject(
		req: BunRequest<"/api/projects/:project/board-check">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		// One live check: a second click opens it instead of starting a parallel check.
		const lastId = e.store.boardCheckId();
		const last = lastId === null ? null : e.store.getTask(lastId);
		if (last && last.cancelledAt === null && last.stage !== "done")
			return taskResponse(e, last.id);
		const t = e.store.createTask(BOARD_CHECK_PROMPT);
		// Synchronous with createTask: the scheduler must never start the card unmarked.
		e.store.updateTask(t.id, { promptAuthor: "board" });
		e.store.setBoardCheckId(t.id);
		deps.schedule();
		return taskResponse(e, t.id);
	}

	async function handlePOSTProjectsArchByProject(
		req: BunRequest<"/api/projects/:project/arch-review">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		const model = modelParam(r.body);
		if (model instanceof Response) return model;
		const badModel = await cardModelResponse(model);
		if (badModel !== null) return badModel;
		// The helper keeps the R1-8 ordering (git spawns before the guard; guard
		// and createTask in one synchronous block); the manual route files
		// without a due check, as today.
		const filed = await fileArchReview(e, model, { requireDue: false });
		if (!filed.ok) return json({ error: filed.error }, filed.status);
		return json({ ...filed.task, turns: [] });
	}

	async function handleGETProjectsHowByProject(
		req: BunRequest<"/api/projects/:project/how-it-works">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.target === null) return json({ error: "no target" }, 404);
		const r = await git(["show", `${e.target}:docs/how-it-works.md`], e.path);
		if (r.code !== 0) return json({ error: "no docs/how-it-works.md" }, 404);
		return new Response(r.stdout, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Security-Policy": "sandbox",
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
			},
		});
	}

	async function handlePOSTProjectsPushByProject(
		req: BunRequest<"/api/projects/:project/push-main">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		if (e.target === null || !e.target.startsWith("origin/"))
			return json({ error: "no resolved target" }, 409);
		const result = await serverMergePush(
			e.path,
			e.path,
			e.target,
			"",
			null,
			e.store.getSettings().originUrl,
		).catch((err) => ({ status: "failed" as const, error: errmsg(err) }));
		if (result.status === "pushed") {
			e.mainUnpushed = false;
			// OTTR-605: the first push (plus the upstream serverMergePush set) turns
			// the aspirational origin/<branch> into a resolved one; re-read so the
			// view carries the canonical target and the advisory is gone at once.
			await refreshRemote(e);
		}
		return json(result);
	}

	async function handleDELETEProjectsIconByProject(
		req: BunRequest<"/api/projects/:project/icon">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		removeIcons(e.store.dataRoot, e.store.tasksDir);
		return json(projectView(e));
	}

	async function handlePOSTProjectsIconByProject(
		req: BunRequest<"/api/projects/:project/icon">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		const r = await readBytes(req, MAX_IMAGE_BYTES);
		if ("error" in r) return r.error;
		const ext = sniffImage(r.bytes);
		if (ext === null)
			return json({ error: "icon must be a PNG, JPEG, GIF or WebP file" }, 400);
		removeIcons(e.store.dataRoot, e.store.tasksDir);
		writeBelow(
			e.store.dataRoot,
			join(e.store.tasksDir, `icon.${ext}`),
			r.bytes,
		);
		return json(projectView(e));
	}

	async function handleGETProjectsIconByProject(
		req: BunRequest<"/api/projects/:project/icon">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		const file = iconFile(e.store.tasksDir);
		if (file === null) return json({ error: "no icon" }, 404);
		const f = Bun.file(file);
		return new Response(f, {
			headers: {
				"Content-Type": f.type,
				"Cache-Control": "private, max-age=31536000, immutable",
				Connection: "close",
			},
		});
	}

	async function handleGETUpdate(): Promise<Response> {
		// A live host reads git for containers without a checkout.
		if (
			updateCycle.available(Date.now()) === null &&
			Date.now() - behindAt > 300_000
		)
			await refreshBehind();
		return json(effectiveUpdate());
	}

	async function handlePOSTUpdate(req: Request): Promise<Response> {
		if (deps.hosted !== undefined) return json({ error: "not found" }, 404);
		const read = await readJson(req, 1_024);
		if ("error" in read) return read.error;
		if (Object.keys(read.body).length !== 0)
			return json(
				{ error: "The update request must be an empty object." },
				400,
			);
		// No await can let a turn claim a runner between this check and the hold.
		const idle = updateCycleIdle();
		const result = updateCycle.request(Date.now(), idle);
		return json(result, "error" in result ? 409 : 202);
	}

	function eligibleUpdateHost(req: Request): boolean {
		return (
			!walled(req) &&
			!["x-board-token", "x-api-key", "cookie"].some((name) =>
				req.headers.has(name),
			)
		);
	}

	function redactUpdateHeartbeat(heartbeat: UpdateHostHeartbeat): void {
		const secrets = gitSecrets();
		if (heartbeat.error !== null)
			heartbeat.error = redact(heartbeat.error, secrets).slice(0, 1_200);
		if (heartbeat.available !== null)
			heartbeat.available.commits = heartbeat.available.commits.map((subject) =>
				redact(subject, secrets).slice(0, 200),
			);
	}

	async function handlePOSTUpdateHost(req: Request): Promise<Response> {
		if (deps.hosted !== undefined) return json({ error: "not found" }, 404);
		if (!eligibleUpdateHost(req))
			return json({ error: "The update host requires direct loopback." }, 403);
		const read = await readJson(req);
		if ("error" in read) return read.error;
		const heartbeat = parseUpdateHostHeartbeat(read.body);
		if (heartbeat === null)
			return json({ error: "Invalid update host heartbeat." }, 400);
		redactUpdateHeartbeat(heartbeat);
		const result = updateCycle.heartbeat(heartbeat, Date.now());
		if ("error" in result) return json(result, 409);
		const build = readBoardHomeFile("build-commit");
		const version = isUpdateCommit(build) ? build : deps.serverVersion;
		return json({
			requestId: result.requestId,
			runningCommit: isUpdateCommit(version) ? version : null,
		} satisfies UpdateHostReply);
	}

	async function handlePOSTProviderLogout(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const provider = r.body.provider;
		if (typeof provider !== "string" || !PROVIDER_ID.test(provider))
			return json(
				{ error: "provider must be an omp provider id, e.g. anthropic" },
				400,
			);
		// One sign-in serves the board and the workers; a logout removes it everywhere.
		return json({ removed: await signOutEverywhere(provider) });
	}

	async function handlePOSTProviderCancel(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		logins.cancel();
		return json({ ok: true });
	}

	async function handlePOSTProviderAnswer(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const line = r.body.line;
		if (typeof line !== "string" || line.length > 8192)
			return json({ error: "line must be a string (max 8192 chars)" }, 400);
		const answer = line.trim();
		if (/[\p{Cc}]/u.test(answer))
			return json({ error: "line must be a single line" }, 400);
		const v = await logins.answer(answer);
		return v === null
			? json({ error: "no sign-in is running; start one first" }, 409)
			: json(v);
	}

	async function handlePOSTProvider(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const provider = r.body.provider;
		if (typeof provider !== "string" || !PROVIDER_ID.test(provider))
			return json(
				{ error: "provider must be an omp provider id, e.g. anthropic" },
				400,
			);
		// readJson accepted this Origin: the provider's callback sends the browser back there.
		const board = req.headers.get("origin") ?? "";
		return json(await logins.start(provider, board));
	}

	async function handleGETProvider(): Promise<Response> {
		return json({
			...boardSignIns(),
			pending: logins.pending(),
			providers: loginProviders(),
		});
	}

	async function handlePOSTUpdatesRemove(req: Request): Promise<Response> {
		// U5: the card removes the upstream-deleted item instead of updating it.
		let created: Array<{ project: string; id: string }>;
		try {
			const r = await readJson(req);
			if ("error" in r) return r.error;
			const id = (r.body as Record<string, unknown>).id;
			if (typeof id !== "string")
				return json({ error: "id must be a string" }, 400);
			created = await fileRemoveCard(id);
			publishSoon();
		} catch (err) {
			const e = err as { status?: unknown; error?: unknown };
			if (
				typeof e === "object" &&
				e !== null &&
				typeof e.status === "number" &&
				typeof e.error === "string"
			)
				return json({ error: e.error }, e.status);
			throw err;
		}
		return json({ tasks: created });
	}

	async function handlePOSTUpdatesSkip(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const id = (r.body as Record<string, unknown>).id;
		if (typeof id !== "string")
			return json({ error: "id must be a string" }, 400);
		if (!updates?.updates.some((rec) => rec.id === id))
			return json({ error: "unknown update id" }, 400);
		addSkip(deps.gstore, id);
		publishSoon();
		return json(updatesView());
	}

	async function handlePOSTUpdatesRefresh(): Promise<Response> {
		await refreshUpdates();
		return json(updatesView());
	}

	async function handlePOSTAlateProvision(): Promise<Response> {
		const r = await provisionNow();
		// A manual success means the provider no longer holds the import, so a
		// recorded trigger failure is stale.
		if (r.ok) alateProvisionError = null;
		// Past the transport bound with alate's health reporting the run: 202
		// Accepted, not an error — the health poll delivers the outcome.
		if (!r.ok && r.running) return json({ running: true }, 202);
		// A real failure lands in the bell state like the trigger's own failures
		// (applyProvisionHealth clears it once alate reports no pending import).
		if (!r.ok) {
			alateProvisionError = r.error;
			publishSoon();
		}
		return r.ok ? json(r.body, 200) : json({ error: r.error }, r.status);
	}

	async function handleGETAlateHealth(): Promise<Response> {
		const h = await alateHealth(alate);
		return h.ok ? json(h.body, 200) : json({ error: h.error }, h.status);
	}

	async function handleDELETEDrain(req: Request): Promise<Response> {
		// OTTR-454: ?runner=<id> clears that runner's hold only; without it,
		// today's board-wide clear.
		const runner = new URL(req.url).searchParams.get("runner");
		if (runner !== null) {
			runnerDrains.delete(runner);
			return json({ until: null });
		}
		drainUntil = 0;
		drainCommits = [];
		return json({ drainUntil: null });
	}

	async function handleGETDrain(): Promise<Response> {
		const turns = deps.runnerTurns?.() ?? {
			local: 0,
			workers: {},
			preparing: 0,
		};
		const now = Date.now();
		return json({
			drainUntil: drainUntil > now ? drainUntil : null,
			drainCommits: drainUntil > now ? drainCommits : null,
			preparing: turns.preparing,
			runners: (deps.runners ?? [{ id: "local", url: null }]).map((r) => {
				const drained = runnerDrains.get(r.id) ?? 0;
				return {
					id: r.id,
					url: r.url,
					until: drained > now ? drained : null,
					turns: r.id === "local" ? turns.local : (turns.workers[r.id] ?? 0),
				};
			}),
		});
	}

	async function handlePOSTTrendingScan(): Promise<Response> {
		const out = await trendingScanner.scanNow();
		return out.ok
			? json({ ok: true, filed: out.filed })
			: json({ error: out.error }, out.status);
	}

	async function handlePOSTProjectsRemoveByProject(
		req: BunRequest<"/api/projects/:project/remove">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		return removeProject(req.params.project);
	}

	async function handlePOSTProjectsInterviewByProject(
		req: BunRequest<"/api/projects/:project/interview">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		const r = await readJson(req);
		if ("error" in r) return r.error;
		// parsed JSON boundary: shape is only trusted after the === true check
		const b = r.body as { fix?: unknown };
		return json(startInterview(e, b.fix === true));
	}

	async function handlePOSTProjectsInitByProject(
		req: BunRequest<"/api/projects/:project/init">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		if (!e.gitless) return json({ error: "already a git repository" }, 409);
		const err = await gitInitWithCommit(e.path);
		if (err !== null) return json({ error: err }, 400);
		e.gitless = false;
		await refreshRemote(e);
		const interview = startInterview(e);
		return json({ project: projectView(e), ...interview });
	}

	async function handlePOSTProjects(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		return addProject(r.body);
	}

	async function handleGETGh(req: Request): Promise<Response> {
		const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
		// Add project's New tab polls this: once for the auth hint, debounced per
		// name for the availability check. 15s bounds a hung gh so the form never
		// waits on it.
		const u = await gh(["api", "user", "--jq", ".login"], 15_000).catch(() => ({
			code: -1,
			stdout: "",
			stderr: "",
		}));
		const dir = resolve(deps.defaultDir);
		const host = githubHostView();
		if (u.code !== 0)
			return json({ authed: false, user: null, free: null, dir, host });
		const user = u.stdout.trim();
		// GitHub repo-name charset; anything else stays unchecked and waits for
		// the submit-time validation instead of a misleading answer.
		if (name === "" || /[^A-Za-z0-9_.-]/.test(name))
			return json({ authed: true, user, free: null, dir, host });
		// Exit 0 = the repo exists (taken); gh's not-found line = free; anything
		// else (network down, rate limit) stays unknown rather than guessed.
		const v = await gh(["repo", "view", `${user}/${name}`], 15_000).catch(
			() => ({ code: -1, stdout: "", stderr: "" }),
		);
		const free =
			v.code === 0
				? false
				: /Could not resolve to a Repository/.test(v.stderr)
					? true
					: null;
		return json({ authed: true, user, free, dir, host });
	}

	async function handleGETPerformance(req: Request): Promise<Response> {
		const range = new URL(req.url).searchParams.get("range");
		if (range !== null && range !== "all") {
			const ms: Record<Exclude<PerfRange, "all">, number> = {
				"1h": 3_600_000,
				"24h": 86_400_000,
				"7d": 604_800_000,
				"30d": 2_592_000_000,
				"90d": 7_776_000_000,
			};
			// hasOwn, not `in`: "constructor" would otherwise pass as a range.
			if (!Object.hasOwn(ms, range))
				return json({ error: "invalid range" }, 400);
		}
		const kind = (range ?? "all") as PerfRange;
		const now = Date.now();
		const stores = [...deps.projects.values()];
		// Fleet first: its facts union fixes the series start so every
		// project's series aligns.
		const facts = stores.map((e) => e.store.perfFacts());
		const fleet = perfMetrics(
			{
				tasks: facts.flatMap((f) => f.tasks),
				turns: facts.flatMap((f) => f.turns),
			},
			kind,
			now,
		);
		return json({
			range: kind,
			bucketMs: fleet.bucketMs,
			seriesStart: fleet.seriesStart,
			fleet: fleet.metrics,
			projects: stores.flatMap((e, i) => {
				const fact = facts[i];
				if (fact === undefined) return [];
				return [
					{
						name: e.store.name,
						...perfMetrics(fact, kind, now, fleet.seriesStart).metrics,
					},
				];
			}),
		});
	}

	async function handleGETSystem(): Promise<Response> {
		const now = Date.now();
		return json(
			system.snapshot(deps.liveRuns?.() ?? [], systemHolds(now), now),
		);
	}

	async function handleGETOrphans(): Promise<Response> {
		const scan = currentOrphanScan();
		return json({ orphans: scan.orphans, orphansError: scan.error });
	}

	async function handlePOSTSeen(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const b = r.body as { ids?: unknown; unread?: unknown };
		const ids = b.ids;
		if (
			!Array.isArray(ids) ||
			ids.length > 10000 ||
			ids.some((id) => typeof id !== "string" || !SEEN_ID_RE.test(id))
		)
			return json({ error: "invalid ids" }, 400);
		// unread: true makes a read result unread again; unmentioned ids leave the
		// set too when they are stale, so the store decays here as on the read path.
		if (b.unread === true) {
			// ponytail: ids here hold one id; includes beats a Set at this size.
			saveSeen(loadSeen().filter((id) => !ids.includes(id)));
			return json({ ok: true });
		}
		// seen ⇒ a card that can carry the mark right now: drop anything else
		// (stale clients, dead ids).
		const live = seenableIds();
		saveSeen([...loadSeen(), ...ids].filter((id) => live.has(id)));
		return json({ ok: true });
	}

	async function handleGETNotificationsLive(req: Request): Promise<Response> {
		const endpoint = new URL(req.url).searchParams.get("endpoint");
		if (
			endpoint === null ||
			!loadSubs(deps.gstore).some((s) => s.endpoint === endpoint)
		)
			return json({ error: "unknown endpoint" }, 404);
		const seqs = alertSeqs.get(endpoint);
		const live: Record<AlertClass, { live: number; seq: number }> = {
			request: { live: 0, seq: seqs?.request ?? 0 },
			error: { live: 0, seq: seqs?.error ?? 0 },
			complete: { live: 0, seq: seqs?.complete ?? 0 },
		};
		for (const a of liveAlerts)
			if (a.to.includes(endpoint)) live[a.class].live++;
		return json(live);
	}

	async function handlePOSTPushTest(): Promise<Response> {
		const subs = loadSubs(deps.gstore);
		if (subs.length === 0) return json({ error: "no subscribed device" }, 400);
		ensureVapid();
		const report = await sendAll(
			subs,
			JSON.stringify({
				title: "Ottr",
				body: "Test push — real needs-you alerts look like this.",
				tag: "ottr-test",
				url: "/",
			}),
			(sub, payload) => sendNotification(sub, payload),
		);
		pruneSubs(deps.gstore, report.gone);
		// A 403 (rejected VAPID subject) is not a send: Settings must see it failed
		// (R2-3), not a green `{ ok: true, sent }` that counted the failures.
		return report.failed > 0
			? json(
					{
						ok: false,
						sent: report.sent,
						failed: report.failed,
						status: report.status,
					},
					502,
				)
			: json({ ok: true, sent: report.sent });
	}

	async function handlePOSTPushUnsubscribe(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		if (typeof r.body.endpoint !== "string")
			return json({ error: "endpoint required" }, 400);
		saveSubs(
			deps.gstore,
			loadSubs(deps.gstore).filter((s) => s.endpoint !== r.body.endpoint),
		);
		return json({ ok: true });
	}

	async function handlePOSTPushSubscribe(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const b = r.body as {
			endpoint?: unknown;
			keys?: { p256dh?: unknown; auth?: unknown };
			classes?: unknown;
		};
		if (
			typeof b?.endpoint !== "string" ||
			typeof b?.keys?.p256dh !== "string" ||
			typeof b?.keys?.auth !== "string"
		)
			return json({ error: "invalid subscription" }, 400);
		// ADR-0011 recovery: the re-subscribe can carry the old row's classes so the
		// fresh row is created with them in one atomic call. Any other shape is a 400.
		let carriedClasses: ClassPrefs | undefined;
		if (b.classes !== undefined) {
			if (typeof b.classes !== "object" || b.classes === null)
				return json({ error: "invalid classes" }, 400);
			const c = b.classes as Record<string, unknown>;
			for (const key of Object.keys(c)) {
				if (
					!(ALERT_CLASSES as readonly string[]).includes(key) ||
					typeof c[key] !== "boolean"
				)
					return json({ error: "invalid classes" }, 400);
			}
			carriedClasses = c as ClassPrefs;
		}
		const subs = loadSubs(deps.gstore);
		// A re-subscribe (key rotation, permission re-grant) keeps the device's class
		// switches; a new device starts with every class on. Carried classes win:
		// the recovery read the old row and must override the endpoint-match default.
		const classes =
			carriedClasses ??
			subs.find((s) => s.endpoint === b.endpoint)?.classes ??
			ALL_CLASSES_ON;
		saveSubs(deps.gstore, [
			...subs.filter((s) => s.endpoint !== b.endpoint),
			{
				endpoint: b.endpoint,
				keys: { p256dh: b.keys.p256dh, auth: b.keys.auth },
				addedAt: Date.now(),
				classes: { ...classes },
				// ADR-0011: the sub only receives under the key it was created with.
				vapidPublicKey: ensureVapid().publicKey,
			},
		]);
		return json({ ok: true });
	}

	async function handleGETPushConfig(req: Request): Promise<Response> {
		// Lazy: the first push path pays the VAPID keygen, boot stays silent.
		const v = ensureVapid();
		// An endpoint whose stored sub carries a bound key differing from the current one
		// is stale: Settings recovers it by re-subscribing (ADR-0011 recovery).
		const endpoint = new URL(req.url).searchParams.get("endpoint");
		const sub =
			endpoint === null
				? undefined
				: loadSubs(deps.gstore).find((s) => s.endpoint === endpoint);
		const stale =
			sub !== undefined &&
			sub.vapidPublicKey !== undefined &&
			sub.vapidPublicKey !== v.publicKey;
		return json({ publicKey: v.publicKey, stale });
	}

	async function handleDELETEProjectsSshByProject(
		req: BunRequest<"/api/projects/:project/ssh-key">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		// Removal falls the project back to the global key.
		const f = projectKeyPath(e.name);
		if (f !== "") removeKey(f);
		return json({ own: null });
	}

	async function handlePUTProjectsSshByProject(
		req: BunRequest<"/api/projects/:project/ssh-key">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const f = projectKeyPath(e.name);
		if (f === "") return json({ error: "no such key" }, 400);
		return saveKeyFlow(r.body, f);
	}

	async function handleGETProjectsSshByProject(
		req: BunRequest<"/api/projects/:project/ssh-key">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		const f = projectKeyPath(e.name);
		return json({ own: f === "" ? null : await keyInfo(f) });
	}

	async function handleDELETEGitGithub(): Promise<Response> {
		clearSecret("githubAppKey");
		githubApp = null;
		appTokens = null;
		appCheck = null;
		saveConfig();
		applyGitSecrets();
		return json(await gitHostsView());
	}

	async function handlePOSTGitGithub(req: Request): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const v = validateAppCredentials(r.body);
		if ("error" in v) return json({ error: v.error }, 400);
		const pem = parseAppPem(v.key);
		if (pem === null)
			return json(
				{ error: "the private key must be a PEM RSA private key" },
				400,
			);
		githubApp = v;
		saveConfig();
		// A fresh pair invalidates any cached installation token for the old one.
		appTokens = new AppTokenSource({
			appId: v.id,
			keyObject: pem.keyObject,
			fetchImpl: githubAppFetch,
		});
		applyGitSecrets();
		// The answer shows the app name and installs at once; the check never throws.
		await refreshAppCheck();
		return json(await gitHostsView());
	}

	async function handleDELETEGitSshGlobal(): Promise<Response> {
		removeKey(sshPaths(sshDir).global);
		return json({ ok: true });
	}

	async function handlePUTGitSshGlobal(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		return saveKeyFlow(r.body, sshPaths(sshDir).global);
	}

	async function handlePOSTGitSshPending(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		// Both ways land as a pending key first: generate or paste.
		const gen =
			typeof r.body.privateKey === "string"
				? await importPendingKey(sshDir, r.body.privateKey)
				: await generatePendingKey(sshDir);
		if ("error" in gen) return json({ error: gen.error }, 400);
		return json({
			id: gen.id,
			publicKey: gen.publicKey,
			fingerprint: gen.fingerprint,
		});
	}

	async function handleDELETEGitTokensByHost(
		req: BunRequest<"/api/git-hosts/tokens/:host">,
	): Promise<Response> {
		// Same normalized form the rows and the kept map use, so the kept blob drops too.
		clearSecret(`git:${req.params.host}`);
		gitTokens = gitTokens.filter((x) => x.host !== req.params.host);
		saveConfig();
		applyGitSecrets();
		return json(await gitHostsView());
	}

	async function handlePOSTGitGithub2(req: Request): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		if (githubToken === null)
			return json({ error: "the board has no GitHub token to reuse" }, 400);
		const host = githubHostView();
		if (host === null)
			return json(
				{ error: `${GITHUB_HOST_ENV}: the configured host is invalid` },
				400,
			);
		// No username on purpose: parseGitToken's per-host default lands
		// x-access-token for a GitHub host.
		const cand = parseGitToken({ host, token: githubToken });
		if ("error" in cand) return json({ error: cand.error }, 400);
		return saveGitToken(cand, r.body.testUrl);
	}

	async function handlePOSTGitTokens(req: Request): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const cand = parseGitToken(r.body);
		if ("error" in cand) return json({ error: cand.error }, 400);
		return saveGitToken(cand, r.body.testUrl);
	}

	async function handlePOSTSettingsEnv(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const name = r.body.name;
		const value = r.body.value;
		// Listed names already passed parseEnvTxt's ENV_NAME check.
		const row = listedEnvNames(workersHome).find((row) => row.name === name);
		if (
			typeof name !== "string" ||
			row === undefined ||
			typeof value !== "string" ||
			value === ""
		)
			return json(
				{
					error:
						"name must be listed in an env.txt (A_Z format) and value must be non-empty",
				},
				400,
			);
		// A plain value is not a secret: no secret box, no redaction (env-plain-values.md).
		if (row.plain) {
			deps.shared.envPlain[name] = value;
			saveConfig();
			return json({ ok: true });
		}
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		deps.shared.envValues[name] = value;
		saveConfig();
		applyGitSecrets();
		return json({ ok: true });
	}

	async function handlePOSTSettingsGithub(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const raw = r.body.host;
		if (typeof raw !== "string")
			return json({ error: "host must be a string" }, 400);
		const host = raw.trim();
		if (host === "") {
			savedGithubHost = null;
		} else {
			const parsed = parseGithubHost(host);
			if ("error" in parsed) return json({ error: parsed.error }, 400);
			savedGithubHost = parsed.host;
		}
		saveConfig();
		applyGithubHost();
		const expiresAt = await refreshBoardExpiry();
		return json({ host: githubHostView(), expiresAt });
	}

	async function handlePOSTSettingsGithub2(req: Request): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const token = githubTokenParam(r.body.token);
		if (token === null) return json({ error: GITHUB_TOKEN_ERROR }, 400);
		githubToken = token;
		saveConfig();
		applyGithubToken();
		// Immediate probe: a pasted token shows its real date at once.
		const expiresAt = await refreshBoardExpiry();
		return json({ tokenSet: true, expiresAt });
	}

	/** Parsed request host, or the 400 response; only github.com and the configured GitHub host are accepted. */
	function turnTokenHost(
		raw: unknown,
	): { gh: GithubHost } | { error: Response } {
		if (typeof raw !== "string")
			return { error: json({ error: "host must be a string" }, 400) };
		const parsed = parseGithubHost(raw);
		if ("error" in parsed) return { error: json({ error: parsed.error }, 400) };
		const configured = githubHostView();
		if (parsed.host !== DEFAULT_GITHUB_HOST && parsed.host !== configured)
			return {
				error: json(
					{ error: "host must be github.com or the configured GitHub host" },
					400,
				),
			};
		return { gh: parsed };
	}

	/** Runs the API check and lands the verdict on the row; every check resets confirmed. */
	async function checkAndStoreTurnToken(
		row: TurnReadTokenRow,
		token: string,
		apiBase: string,
	): Promise<void> {
		const check = await checkTurnToken({
			apiBase,
			token,
			repos: reposOnHost(row.host),
			fetch: deps.turnTokenFetch,
		});
		row.status = check.verdict;
		row.detail = check.detail;
		row.confirmed = false;
	}

	async function handlePOSTSettingsTurnToken(req: Request): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const h = turnTokenHost(r.body.host);
		if ("error" in h) return h.error;
		const host = h.gh.host;
		const token = r.body.token;
		if (typeof token !== "string")
			return json({ error: "token must be a string" }, 400);
		// An empty token clears: the stored blob drops with the row.
		if (token === "") {
			clearSecret(`turnRead:${host}`);
			turnReadTokens = turnReadTokens.filter((x) => x.host !== host);
			saveConfig();
			return json(turnReadTokenView());
		}
		// One row per host: a re-save replaces the host's old entry, unconfirmed.
		const row: TurnReadTokenRow = {
			host,
			token,
			status: "error",
			detail: "",
			confirmed: false,
		};
		await checkAndStoreTurnToken(row, token, h.gh.apiBase);
		turnReadTokens = [...turnReadTokens.filter((x) => x.host !== host), row];
		saveConfig();
		return json(turnReadTokenView());
	}

	async function handlePOSTSettingsTurnTokenConfirm(
		req: Request,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const h = turnTokenHost(r.body.host);
		if ("error" in h) return h.error;
		const row = turnReadTokens.find((x) => x.host === h.gh.host);
		if (row === undefined || row.status !== "write")
			return json(
				{ error: "only a write-capable token can be confirmed" },
				400,
			);
		row.confirmed = true;
		saveConfig();
		return json(turnReadTokenView());
	}

	async function handlePOSTSettingsTurnTokenRecheck(
		req: Request,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const h = turnTokenHost(r.body.host);
		if ("error" in h) return h.error;
		const row = turnReadTokens.find((x) => x.host === h.gh.host);
		if (row === undefined || row.token === null)
			return json({ error: "no stored readable token for this host" }, 400);
		await checkAndStoreTurnToken(row, row.token, h.gh.apiBase);
		saveConfig();
		return json(turnReadTokenView());
	}

	async function handleDELETESettingsSessionsById(
		req: BunRequest<"/api/settings/sessions/:id">,
	): Promise<Response> {
		if (!sessions.some((s) => s.id === req.params.id))
			return json({ error: "no such session" }, 404);
		sessions = dropSession(sessions, req.params.id);
		saveConfig();
		return json({ ok: true });
	}

	async function handleGETSettingsSessions(req: Request): Promise<Response> {
		const now = Date.now();
		const live = sessions.filter((s) => s.exp > now);
		// Lazy pruning: persist only when serving the list actually dropped entries.
		if (live.length !== sessions.length) {
			sessions = live;
			saveConfig();
		}
		const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
		const currentId =
			sessionSecret !== null && token !== undefined
				? (verifySession(sessionSecret, token)?.id ?? null)
				: null;
		return json({
			sessions: [...live]
				.sort((a, b) => b.lastSeen - a.lastSeen)
				.map((s) => ({
					id: s.id,
					label: s.label,
					createdAt: s.createdAt,
					lastSeen: s.lastSeen,
					current: s.id === currentId,
				})),
		});
	}

	async function handlePOSTSettingsSession(): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		if (sessionSecret === null)
			return json({ error: "no admin configured" }, 400);
		sessionSecret = newSecret();
		// The registry dies with the secret: no ghost rows survive the rotation.
		sessions = [];
		saveConfig();
		return json({ ok: true });
	}

	async function handlePOSTSettingsAlate(): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		if (alate.url === null)
			return json({ error: "alate server url is not configured" }, 400);
		if (alate.key === null)
			return json({ error: "alate api key is not configured" }, 400);
		const r = await alateRotateKey(alate);
		if (!r.ok) return json({ error: r.error }, r.status);
		const prev = alate;
		try {
			alate = { url: alate.url, key: r.body.key };
			saveConfig();
		} catch (err) {
			// The assignment mutated the closure before saveConfig read it, so a failed
			// save must restore the old value: store and live config stay equal. The
			// 500 still hands the new key back so the user can paste it.
			alate = prev;
			return secretJson(
				{
					error: `alate rotated the key, but the board could not save it (${(err as Error).message}). The key in apiKey is the new one: paste it into the Alate API key field and save.`,
					apiKey: r.body.key,
				},
				500,
			);
		}
		return secretJson({ apiKey: r.body.key });
	}

	async function handlePOSTSettingsApi(): Promise<Response> {
		const noBox = sealGuard();
		if (noBox !== null) return noBox;
		if (apiKey === null) return json({ error: "no admin configured" }, 400);
		apiKey = newSecret();
		saveConfig();
		return json({ apiKey });
	}

	async function handlePOSTHostedRelease(): Promise<Response> {
		if (deps.creditRelease === undefined)
			throw new Error("hosted mode without a creditRelease");
		return json({ released: await deps.creditRelease() });
	}

	async function handlePOSTHostedStop(): Promise<Response> {
		if (deps.creditStop === undefined)
			throw new Error("hosted mode without a creditStop");
		return json({ stopped: await deps.creditStop() });
	}

	/** The refusal for editing a card's release notes, or null when the card may be edited. */
	function releaseNotesRefusal(task: Task): Response | null {
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		if (task.releaseVersion === null)
			return json({ error: "only release cards have release notes" }, 409);
		if (task.state !== "idle" && task.state !== "needs_you")
			return json(
				{
					error:
						"only an idle or needs-you release card can edit release notes",
				},
				409,
			);
		return null;
	}
	async function handlePOSTProjectsTasksReleaseByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/release-notes">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		// The revision guard outranks the refusal below: a stale notes edit answers
		// 409 with the current card instead of a bare precondition error.
		const stale = staleEditResponse(e, task, r.body);
		if (stale !== null) return stale;
		const refusal = releaseNotesRefusal(task);
		if (refusal !== null) return refusal;
		if (typeof r.body.notes !== "string")
			return json({ error: "notes must be a string" }, 400);
		const trimmed = r.body.notes.trim();
		if (!trimmed || trimmed.length > 20000)
			return json({ error: "notes must be 1-20000 characters" }, 400);
		const res = applyUserEdit(e, task, { releaseNotes: r.body.notes }, r.body);
		if (res instanceof Response) return res;
		return json(taskView(e, res));
	}

	/** Posts the review as the GitHub App through an installation token; null when no app or no installation, so the board token path runs. */
	async function postReviewViaApp(
		e: Entry,
		row: PrReviewRow,
		head: string,
		prev: string | null,
		repo: string | null,
		repoName: string,
		owner: string,
		draft: ParsedReview,
		comments: Record<string, unknown>,
		event: "COMMENT" | "APPROVE",
	): Promise<
		{ via: "app"; stdout: string; approveSkipped?: string } | Response | null
	> {
		if (githubApp === null || appTokens === null) return null;
		const appSecrets = [...gitSecrets()];
		let tok: string | null = null;
		try {
			tok = await appTokens.tokenFor(owner, repoName);
		} catch (err) {
			const error = redact(errmsg(err), appSecrets).trim().slice(0, 300);
			e.store.releasePrPost(row.number, head, prev, error);
			return json({ error }, 502);
		}
		if (tok === null) return null;
		// Direct fetch, no gh: the review posts as the app, not the board token.
		const url = `${githubHost().apiBase}/repos/${repo}/pulls/${row.number}/reviews`;
		const headers = {
			authorization: `Bearer ${tok}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "Ottr",
		};
		const postOnce = (ev: "COMMENT" | "APPROVE") =>
			githubAppFetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					event: ev,
					// No footer: the review posts as the app, so GitHub's Bot badge
					// already says who posted it.
					body: draft.body,
					commit_id: head,
					...comments,
				}),
			});
		try {
			let res = await postOnce(event);
			let text = await res.text();
			if (!res.ok && event === "APPROVE" && res.status === 422) {
				// GitHub refuses an APPROVE review when the posting identity opened
				// the PR (HTTP 422), so the same draft goes out as a comment and the
				// response notes the skip. Any other failure stays a 502: a 5xx or a
				// rate limit must never trade the approval of this head away.
				const refused = res.status;
				res = await postOnce("COMMENT");
				text = await res.text();
				if (res.ok)
					return {
						via: "app",
						stdout: text,
						approveSkipped: `GitHub refused the approve review (HTTP ${refused}); posted it as a comment instead`,
					};
			}
			if (!res.ok) {
				const error =
					redact(text.trim().slice(0, 300), appSecrets) ||
					requestFailed(
						`The review post to ${repo}#${row.number}`,
						res.status,
						"check the app's or token's permissions, then post the review again",
					);
				e.store.releasePrPost(row.number, head, prev, error);
				return json({ error }, 502);
			}
			return { via: "app", stdout: text };
		} catch (err) {
			const error = redact(errmsg(err), appSecrets).trim().slice(0, 300);
			e.store.releasePrPost(row.number, head, prev, error);
			return json({ error }, 502);
		}
	}
	/** Posts the review with gh under the board token: argv array, no shell; the payload goes in a private temp file, so body, comments and head never reach a command line parser. */
	async function postReviewViaGh(
		e: Entry,
		row: PrReviewRow,
		head: string,
		prev: string | null,
		repo: string | null,
		draft: ParsedReview,
		comments: Record<string, unknown>,
		event: "COMMENT" | "APPROVE",
	): Promise<{ stdout: string; approveSkipped?: string } | Response> {
		const payload = {
			event,
			body: `${draft.body}${REVIEW_FOOTER}`,
			commit_id: head,
			...comments,
		};
		let res: { code: number; stdout: string; stderr: string };
		let dir: string | null = null;
		try {
			dir = await mkdtemp(join(tmpdir(), "ottr-review-"));
			// A fresh payload per attempt: the retry must send COMMENT, not the
			// refused APPROVE.
			const callGh = async (ev: "COMMENT" | "APPROVE", at: string) => {
				const file = join(at, "review.json");
				await writeFile(file, JSON.stringify({ ...payload, event: ev }), {
					mode: 0o600,
				});
				return gh([
					"api",
					`repos/${repo}/pulls/${row.number}/reviews`,
					"-X",
					"POST",
					"--input",
					file,
				]);
			};
			res = await callGh(event, dir);
			if (
				res.code !== 0 &&
				event === "APPROVE" &&
				/\b422\b|Can not approve your own pull request/i.test(res.stderr)
			) {
				// GitHub refuses an APPROVE review when the posting identity opened
				// the PR; gh prints the refusal body to stderr. Only that signature
				// downsizes to a comment — any other exit stays a 502, so a 5xx or a
				// rate limit never trades the approval of this head away.
				const refused = res.code;
				res = await callGh("COMMENT", dir);
				if (res.code === 0)
					return {
						stdout: res.stdout,
						approveSkipped: `GitHub refused the approve review (gh exit ${refused}); posted it as a comment instead`,
					};
			}
		} catch (err) {
			// A spawn or temp file failure (e.g. gh missing) sent nothing: free the claim, or the head reads as posted.
			res = { code: -1, stdout: "", stderr: errmsg(err) };
		} finally {
			if (dir !== null) await rm(dir, { recursive: true, force: true });
		}
		if (res.code !== 0) {
			const error = res.stderr.trim().slice(0, 300) || `gh exited ${res.code}`;
			e.store.releasePrPost(row.number, head, prev, error);
			return json({ error }, 502);
		}
		return { stdout: res.stdout };
	}
	/** True when u is an https URL on the configured GitHub host. */
	function isHostedHttpsUrl(u: string): boolean {
		try {
			const parsed = new URL(u);
			return (
				parsed.protocol === "https:" && parsed.hostname === githubHost().host
			);
		} catch {
			return false;
		}
	}
	/** The drawer link and login GitHub names in its response body: untrusted, so only an https URL on the configured host and a plausible login pass. */
	function parsePrPostResult(stdout: string): {
		url: string | null;
		login: string | null;
	} {
		let url: string | null = null;
		let login: string | null = null;
		try {
			const body: unknown = JSON.parse(stdout);
			if (typeof body !== "object" || body === null) return { url, login };
			if (
				"html_url" in body &&
				typeof body.html_url === "string" &&
				isHostedHttpsUrl(body.html_url)
			)
				url = body.html_url;
			const l =
				"user" in body &&
				typeof body.user === "object" &&
				body.user !== null &&
				"login" in body.user
					? body.user.login
					: null;
			if (typeof l === "string" && l.length >= 1 && l.length <= 100) login = l;
		} catch {
			// No parseable body: the drawer just shows the posted head without a link.
		}
		return { url, login };
	}
	/** Reads and validates a review post body; a Response is the refusal. */
	async function readPrPostDraft(
		req: BunRequest<"/api/projects/:project/tasks/:id/pr-review/post">,
	): Promise<{ draft: ParsedReview; rawHead: unknown } | Response> {
		// 65536 chars may take up to 4 bytes each in UTF-8.
		const r = await readJson(req, 4 * 65536 + 1024);
		if ("error" in r) return r.error;
		const body = r.body.body;
		if (typeof body !== "string" || body.trim() === "")
			return json({ error: "body must be a non-empty string" }, 400);
		if (body.length > REVIEW_BODY_MAX)
			return json({ error: "body is too long" }, 400);
		const draft = parseReviewDraft(body);
		if (draft.comments.length > 0 && draft.body === "")
			return json({ error: "write a summary above the inline comments" }, 400);
		return { draft, rawHead: r.body.head };
	}
	/** The posted-head checks; null lets the post continue. */
	function prHeadRefusal(row: PrReviewRow, rawHead: unknown): string | null {
		// The client names the head its draft belongs to: a newer draft may have replaced it meanwhile.
		if (typeof rawHead !== "string" || rawHead !== row.reviewedHead)
			return "the draft changed";
		if (row.postedHead === rawHead) return "already posted for this head";
		return null;
	}
	/** Refusals for posting from a card's current state; null lets the post continue. */
	function prPostStateRefusal(task: Task, row: PrReviewRow): Response | null {
		// The watcher saves each draft as the card's details; a cancelled card has none to post.
		if (task.cancelledAt !== null || task.details === null)
			return json({ error: "no draft to post" }, 409);
		if (row.state !== "open") return json({ error: `PR is ${row.state}` }, 409);
		return null;
	}
	function claimPrPostCard(
		e: Entry,
		task: Task,
		rawHead: unknown,
	): Response | { row: PrReviewRow; head: string; prev: string | null } {
		const row =
			task.kind === "pr_review" ? e.store.getPrReviewByTask(task.id) : null;
		const storedGithub = e.github;
		if (row === null || storedGithub === null)
			return json({ error: "not a PR review card" }, 409);
		const stateRefused = prPostStateRefusal(task, row);
		if (stateRefused !== null) return stateRefused;
		const headRefused = prHeadRefusal(row, rawHead);
		if (headRefused !== null) return json({ error: headRefused }, 409);
		if (typeof rawHead !== "string")
			return json({ error: "the draft changed" }, 409);
		// Claim before the await: a concurrent Post of the same head loses here.
		const prev = e.store.claimPrPost(row.number, rawHead);
		if (prev === undefined)
			return json({ error: "already posted for this head" }, 409);
		return { row, head: rawHead, prev };
	}
	async function preparePrPost(
		req: BunRequest<"/api/projects/:project/tasks/:id/pr-review/post">,
	): Promise<
		| Response
		| {
				e: Entry;
				task: Task;
				row: PrReviewRow;
				head: string;
				prev: string | null;
				draft: ParsedReview;
				github: string;
		  }
	> {
		const picked = await readPrPostDraft(req);
		if (picked instanceof Response) return picked;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const claimed = claimPrPostCard(e, task, picked.rawHead);
		if (claimed instanceof Response) return claimed;
		const storedGithub = e.github;
		if (storedGithub === null)
			return json({ error: "not a PR review card" }, 409);
		return {
			e,
			task,
			row: claimed.row,
			head: claimed.head,
			prev: claimed.prev,
			draft: picked.draft,
			github: storedGithub,
		};
	}
	async function handlePOSTProjectsTasksPrPostByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/pr-review/post">,
	): Promise<Response> {
		const prep = await preparePrPost(req);
		if (prep instanceof Response) return prep;
		const { e, row, head, prev, draft, github } = prep;
		const repo = ownerRepo(github) ?? github;
		const slash = repo.indexOf("/");
		const owner = repo.slice(0, slash);
		const repoName = repo.slice(slash + 1);
		const comments =
			draft.comments.length > 0
				? { comments: reviewPayloadComments(draft.comments) }
				: {};
		// APPROVE only when the project opted in and this draft's own run found no blocking
		// findings; an unknown verdict posts a plain comment.
		const event =
			e.store.getSettings().prReviewApprove === true &&
			!e.store.lastPrRunBlocking(row.number)
				? ("APPROVE" as const)
				: ("COMMENT" as const);
		const app = await postReviewViaApp(
			e,
			row,
			head,
			prev,
			repo,
			repoName,
			owner,
			draft,
			comments,
			event,
		);
		if (app instanceof Response) return app;
		let via: "app" | "token" = "token";
		let stdout: string;
		let approveSkipped: string | undefined;
		if (app !== null) {
			stdout = app.stdout;
			via = "app";
			approveSkipped = app.approveSkipped;
		} else {
			const posted = await postReviewViaGh(
				e,
				row,
				head,
				prev,
				repo,
				draft,
				comments,
				event,
			);
			if (posted instanceof Response) return posted;
			stdout = posted.stdout;
			approveSkipped = posted.approveSkipped;
		}
		// GitHub's response body is untrusted: only an https URL on the configured
		// host becomes the drawer link, and only a plausible login names the
		// posting identity.
		const { url, login } = parsePrPostResult(stdout);
		e.store.setPrPostedUrl(row.number, url, login);
		// The posted review's own comments must never alert: the baseline is the post time.
		e.store.setPrComments(row.number, Date.now(), false);
		// The head is posted: the card leaves needs_you for done/idle.
		e.store.syncPrCard(row.number);
		return json({
			ok: true,
			login,
			via,
			inline: draft.comments.length,
			...(approveSkipped !== undefined ? { approveSkipped } : {}),
		});
	}

	/** The latest finished grill report's details, or null when none finished. */
	function latestGrillDetails(e: Entry, taskId: string): string | null {
		const turns = e.store.listTurns(taskId);
		for (let i = turns.length - 1; i >= 0; i--) {
			const turn = turns[i];
			const out = turn?.outcome;
			if (
				(out === "ready" || out === "answered") &&
				typeof turn?.details === "string" &&
				turn.details.trim() !== ""
			)
				return turn.details;
		}
		return null;
	}
	/** Moves a backlog task to todo: validates the grill state, folds the latest grilled definition of ready into the prompt, queues it. */
	function backlogToTodo(
		e: Entry,
		task: Task,
		body: Record<string, unknown>,
	): Response {
		if (task.stage !== "backlog")
			return json({ error: "only a backlog task can move to todo" }, 409);
		if (task.state !== "idle")
			return json(
				{
					error:
						"the grill is still queued or running — stop or answer it first",
				},
				409,
			);
		if (task.pendingPrompt !== null)
			return json({ error: "a reply is still queued" }, 409);
		const model = modelParam(body);
		if (model instanceof Response) return model;
		// The latest finished grill report carries the refinement; fold it into the prompt.
		const details = latestGrillDetails(e, task.id);
		const refined =
			details !== null
				? `${task.prompt}\n\n## Definition of ready (grilled)\n\n${details}`
				: null;
		e.store.updateTask(task.id, {
			...(refined !== null ? { prompt: refined } : {}),
			...(model !== null ? { model } : {}),
			stage: "todo",
			state: "queued",
			holdUntil: null,
			queuedAt: Date.now(),
			needsReason: null,
			asked: null,
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}
	/** Parks a todo task back into the backlog. */
	function backlogToPark(e: Entry, task: Task): Response {
		if (task.stage !== "todo")
			return json({ error: "only a todo task can be parked" }, 409);
		if (task.state !== "queued")
			return json(
				{
					error: "a running, preparing, or needs-you task cannot be parked",
				},
				409,
			);
		if (task.pendingPrompt !== null)
			return json({ error: "a reply or steer is still queued" }, 409);
		e.store.updateTask(task.id, {
			stage: "backlog",
			state: "idle",
			queuedAt: null,
			needsReason: null,
			holdUntil: null,
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}
	async function handlePOSTProjectsTasksBacklogByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/backlog">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		const to = r.body.to;
		if (to !== "todo" && to !== "backlog")
			return json({ error: `to must be "todo" or "backlog"` }, 400);
		if (to === "todo") return backlogToTodo(e, task, r.body);
		return backlogToPark(e, task);
	}

	/** Refusals that gate starting a grill; null lets it start. */
	function grillStartRefusal(task: Task): Response | null {
		if (task.stage !== "backlog")
			return json({ error: "only a backlog task can be grilled" }, 409);
		if (task.state !== "idle")
			return json({ error: "the grill is already queued or running" }, 409);
		if (task.pendingPrompt !== null)
			return json({ error: "a reply is still queued" }, 409);
		return null;
	}
	async function handlePOSTProjectsTasksGrillByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/grill">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		const gated = grillStartRefusal(task);
		if (gated !== null) return gated;
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const model = modelParam(r.body);
		if (model instanceof Response) return model;
		e.store.updateTask(task.id, {
			state: "queued",
			holdUntil: null,
			...(model !== null ? { model } : {}),
			queuedAt: Date.now(),
			needsReason: null,
			asked: null,
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}

	/** The steering refusal for a card not in flight; null lets the steer queue. */
	function steerStateRefusal(task: Task): Response | null {
		if (
			task.state !== "running" &&
			task.state !== "preparing" &&
			task.state !== "queued"
		)
			return json(
				{
					error: "only a running, preparing, or queued task can be steered",
				},
				409,
			);
		return null;
	}
	/** Saves decoded steer images into the card's image dir; a Response is the 500. */
	function steerImages(
		e: Entry,
		taskId: string,
		images: DecodedImage[],
	): string[] | Response {
		try {
			return saveImages(e.store.dataRoot, e.store.imagesDir(taskId), images);
		} catch (err) {
			return json({ error: `could not save images: ${errmsg(err)}` }, 500);
		}
	}
	/** Queues the steering text and images; runTurn delivers them with the next turn. */
	function applySteer(
		e: Entry,
		task: Task,
		prompt: string,
		names: string[],
	): void {
		e.store.updateTask(task.id, {
			pendingPrompt:
				task.pendingPrompt === null
					? prompt
					: `${task.pendingPrompt}\n\n${prompt}`,
			// A message on a card held for a usage limit runs it now: user authorship
			// plus the cleared holdUntil is the run-now signal the turn loop's start
			// gate reads. A combined park is only titled as supervisor when no hold
			// was involved (the tracker's own "." resume under it stays tracker text).
			pendingBy:
				task.holdUntil !== null
					? "user"
					: task.pendingBy === "supervisor"
						? "supervisor"
						: "user",
			pendingImages: [...task.pendingImages, ...names],
			holdUntil: null,
		});
		deps.schedule();
	}
	/** The steer text; a Response is the 400 for a non-string. */
	function steerText(v: unknown): string | Response {
		return typeof v === "string"
			? v
			: json({ error: "text must be a non-empty string" }, 400);
	}
	/** The decoded steer images under the project's cap; a Response is the 400. */
	function steerDecoded(e: Entry, v: unknown): DecodedImage[] | Response {
		const decoded = decodeImages(v, e.store.getSettings().maxImages);
		if ("error" in decoded) return json({ error: decoded.error }, 400);
		return decoded.images;
	}
	/** The steer prompt and images; a Response is the 400. */
	function steerPayload(
		e: Entry,
		body: Record<string, unknown>,
	): { prompt: string; images: DecodedImage[] } | Response {
		const text = steerText(body.text);
		if (text instanceof Response) return text;
		const images = steerDecoded(e, body.images);
		if (images instanceof Response) return images;
		// Picture-only steer: "." keeps pendingPrompt non-null so runTurn queues a turn that carries the images.
		if (text.trim().length === 0 && images.length === 0)
			return json({ error: "text must be a non-empty string" }, 400);
		return { prompt: text.trim() || ".", images };
	}
	async function handlePOSTProjectsTasksSteerByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/steer">,
	): Promise<Response> {
		const r = await readJson(req, IMAGE_BODY_BYTES);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		const gated = steerStateRefusal(task);
		if (gated !== null) return gated;
		const payload = steerPayload(e, r.body);
		if (payload instanceof Response) return payload;
		const names = steerImages(e, task.id, payload.images);
		if (names instanceof Response) return names;
		applySteer(e, task, payload.prompt, names);
		return taskResponse(e, task.id);
	}

	/** The board a follow-up card lands in; the same project keeps the source board. */
	function followUpTarget(
		e: Entry,
		want: unknown,
		reqProject: string,
	): { target: Entry; followUpOfProject: string | null } | Response {
		if (want === undefined || want === null || want === reqProject)
			return { target: e, followUpOfProject: null };
		if (typeof want !== "string")
			return json({ error: "project must be a project name" }, 400);
		const te = deps.projects.get(want);
		if (!te) return json({ error: "unknown project" }, 404);
		if (te.gitless) return json({ error: "init a git repository first" }, 409);
		return { target: te, followUpOfProject: reqProject };
	}
	/** Saves the follow-up's images; on failure the fresh card is cancelled and a 500 returns. */
	function followUpImages(
		target: Entry,
		taskId: string,
		images: DecodedImage[],
	): string[] | Response {
		if (images.length === 0) return [];
		try {
			return saveImages(
				target.store.dataRoot,
				target.store.imagesDir(taskId),
				images,
			);
		} catch (err) {
			target.store.updateTask(taskId, {
				cancelledAt: Date.now(),
				state: "idle",
			});
			return json({ error: `could not save images: ${errmsg(err)}` }, 500);
		}
	}
	/** Writes the handoff and stamps the follow-up links; on failure the fresh card is cancelled and a 500 returns. */
	function followUpHandoff(
		target: Entry,
		source: Entry,
		sourceTask: Task,
		newTaskId: string,
		trimmed: string,
		followUpOfProject: string | null,
		names: string[],
	): Response | null {
		try {
			const handoffPath = join(
				target.store.tasksDir,
				"handoffs",
				`${newTaskId}.md`,
			);
			// The kept-files folder, when the finished card has one (done cards only).
			const savedDir = join(source.store.tasksDir, "quarantine", sourceTask.id);
			writeBelow(
				target.store.dataRoot,
				handoffPath,
				handoffMarkdown({
					task: sourceTask,
					turns: source.store.listTurns(sourceTask.id),
					sessionsDir: source.store.sessionsDir,
					savedDir: existsSync(savedDir) ? savedDir : null,
				}),
			);
			target.store.updateTask(newTaskId, {
				followUpOf: sourceTask.id,
				followUpOfProject,
				prompt: followUpPrompt({
					text: trimmed,
					title: source.store.frozenTitle(sourceTask),
					handoffPath,
				}),
				images: names,
				// OTTR-850: the posted text is board-written only when it is the exact
				// "Implement steps" template; any edit makes it user-authored, so the
				// gate judges it. The server compares, never trusting a client flag.
				promptAuthor: trimmed === IMPLEMENT_RECOMMENDATIONS ? "board" : "user",
			});
			return null;
		} catch (err) {
			target.store.updateTask(newTaskId, {
				cancelledAt: Date.now(),
				state: "idle",
			});
			return json(
				{ error: `could not write the handoff: ${errmsg(err)}` },
				500,
			);
		}
	}
	/** The follow-up text; a Response is the 400. */
	function followUpText(v: unknown): string | Response {
		if (typeof v !== "string")
			return json({ error: "text must be a string" }, 400);
		const trimmed = v.trim();
		if (!trimmed || trimmed.length > 20000)
			return json({ error: "text must be 1-20000 characters" }, 400);
		return trimmed;
	}
	/** The follow-up refusals for a card that is cancelled or not done; null continues. */
	function followUpRefusal(task: Task): Response | null {
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		if (task.stage !== "done")
			return json({ error: "only done tasks can be followed up" }, 409);
		return null;
	}
	/** The follow-up request facts; a Response is a refusal. */
	function followUpFacts(
		task: Task,
		body: Record<string, unknown>,
	): { trimmed: string; model: string | null } | Response {
		const refused = followUpRefusal(task);
		if (refused !== null) return refused;
		const trimmed = followUpText(body.text);
		if (trimmed instanceof Response) return trimmed;
		const model = modelParam(body);
		if (model instanceof Response) return model;
		return { trimmed, model };
	}
	/** Creates the follow-up card and saves its images; a Response cancels the fresh card. */
	function createFollowUp(
		target: Entry,
		trimmed: string,
		model: string | null,
		images: DecodedImage[],
	): { id: string; names: string[] } | Response {
		// Sync from createTask through updateTask: the 5 s schedule timer must never see the task
		// without its final prompt (no await in between, so no timer can interleave).
		const t = target.store.createTask(trimmed, model);
		const names = followUpImages(target, t.id, images);
		if (names instanceof Response) return names;
		return { id: t.id, names };
	}
	/** Lands the follow-up card on its target board; a Response is a refusal or failure. */
	function landFollowUp(
		e: Entry,
		task: Task,
		reqProject: string,
		body: Record<string, unknown>,
		trimmed: string,
		model: string | null,
	): Response | { target: Entry; id: string } {
		// Optional target board: the card lands there, linked back across the border.
		const picked = followUpTarget(e, body.project, reqProject);
		if (picked instanceof Response) return picked;
		const target = picked.target;
		const images = steerDecoded(target, body.images);
		if (images instanceof Response) return images;
		const made = createFollowUp(target, trimmed, model, images);
		if (made instanceof Response) return made;
		const failed = followUpHandoff(
			target,
			e,
			task,
			made.id,
			trimmed,
			picked.followUpOfProject,
			made.names,
		);
		if (failed !== null) return failed;
		return { target, id: made.id };
	}
	async function handlePOSTProjectsTasksFollowByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/follow-up">,
	): Promise<Response> {
		const r = await readJson(req, IMAGE_BODY_BYTES);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const facts = followUpFacts(task, r.body);
		if (facts instanceof Response) return facts;
		const badModel = await cardModelResponse(facts.model);
		if (badModel !== null) return badModel;
		const landed = landFollowUp(
			e,
			task,
			req.params.project,
			r.body,
			facts.trimmed,
			facts.model,
		);
		if (landed instanceof Response) return landed;
		deps.schedule();
		return taskResponse(landed.target, landed.id);
	}

	/** Asks GitHub to re-run the failed jobs of one run; a Response is the 502 or the API error. */
	async function rerunApiCall(
		token: string,
		match: RegExpMatchArray,
	): Promise<Response> {
		const base = githubHost().apiBase.replace(/\/+$/, "");
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"user-agent": "ottr",
			authorization: `Bearer ${token}`,
		};
		let res: Response;
		try {
			res = await rerunFetch(
				`${base}/repos/${match[1]}/${match[2]}/actions/runs/${match[3]}/rerun-failed-jobs`,
				{
					method: "POST",
					headers,
					redirect: "manual",
					signal: AbortSignal.timeout(RERUN_TIMEOUT_MS),
				},
			);
		} catch (err) {
			return json(
				{
					error: `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`,
				},
				502,
			);
		}
		if (!res.ok) {
			const error =
				res.status === 403 || res.status === 404
					? `GitHub refused the re-run (HTTP ${res.status}): the board's token lacks the actions:write scope for ${match[1]}/${match[2]}`
					: requestFailed(
							`The re-run of failed jobs for ${match[1]}/${match[2]} run ${match[3]}`,
							res.status,
							"check the board's token access, then run the re-run again",
						);
			return json({ error }, res.status);
		}
		return json({ ok: true }, 200);
	}
	async function handlePOSTProjectsTasksRerunByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/rerun-failed-jobs">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { task } = found;
		const token = process.env.GH_TOKEN;
		if (!token)
			return json(
				{ error: "the board has no GitHub token to re-run with" },
				400,
			);
		const text = [
			task.prompt,
			task.needsReason ?? "",
			task.summary ?? "",
			task.details ?? "",
			task.report ?? "",
		].join("\n");
		const match = text.match(
			/https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/(\d+)/,
		);
		if (!match)
			return json({ error: "no GitHub Actions run link on this card" }, 400);
		const url = `https://github.com/${match[1]}/${match[2]}/actions/runs/${match[3]}`;
		const done = await rerunApiCall(token, match);
		if (done.status !== 200) return done;
		return json({ ok: true, url }, 200);
	}

	/** The merge-anyway refusals; null lets the merge run. */
	function mergeAnywayRefusal(
		task: Task,
		reason: unknown,
	): Response | { trimmed: string } {
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		if (
			typeof reason !== "string" ||
			!reason.trim() ||
			reason.trim().length > 2000
		)
			return json({ error: "reason must be 1-2000 characters" }, 400);
		if (task.state === "running" || task.state === "preparing")
			return json({ error: "the work turn is still running" }, 409);
		if (task.stage !== "in_progress")
			return json({ error: "only a work card can merge anyway" }, 409);
		if (openWorkBlockers(task.workCheckLog).length === 0)
			return json({ error: "no outstanding work-check blockers" }, 409);
		return { trimmed: reason.trim() };
	}
	async function handlePOSTProjectsTasksMergeByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/merge-anyway">,
	): Promise<Response> {
		const r = await readJson(req, MAX_BODY_BYTES);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const allowed = mergeAnywayRefusal(task, r.body.reason);
		if (allowed instanceof Response) return allowed;
		e.store.updateTask(task.id, mergeAnywayPatch(task, allowed.trimmed));
		deps.schedule();
		return taskResponse(e, task.id);
	}

	/** A reply on a PR review card: a note for the reviewer that runs a new draft for the current head. */
	function prReviewReply(
		e: Entry,
		task: Task,
		text: string,
		body: Record<string, unknown>,
	): Response {
		const row = e.store.getPrReviewByTask(task.id);
		if (row === null || e.github === null)
			return json({ error: "not a PR review card" }, 409);
		if (row.state !== "open") return json({ error: `PR is ${row.state}` }, 409);
		const note = text.trim();
		if (note === "" || note.length > 20000)
			return json({ error: "text must be 1-20000 characters" }, 400);
		if (Array.isArray(body.images) && body.images.length > 0)
			return json({ error: "PR review notes are text-only" }, 400);
		if (
			e.store.prReviewRunsSince(Date.now() - PR_GATES.DAY_MS) >=
			PR_GATES.PROJECT_DAILY_RUNS
		)
			return json(
				{
					error: `daily cap of ${PR_GATES.PROJECT_DAILY_RUNS} reviews reached`,
				},
				429,
			);
		// reviewNow never rejects; the catch only guards against a stray throw.
		void prWatcher
			.reviewNow({ project: e.name, number: row.number, note })
			.catch(() => {});
		return taskResponse(e, task.id);
	}
	/** Queues the work-check send-back under any pending steer. A null direction
	 * is a plain send-back; on a diverging park, any other text is the user's new
	 * direction and goes out with it. On a diverging park a click without text
	 * attaches the board's rethink direction, so the send-back always pushes the
	 * rethink. The direction goes out with the send-back for the agent and into
	 * the log for the next check. */
	function applyWorkCheckSendBack(
		e: Entry,
		task: Task,
		open: ReturnType<typeof openWorkBlockers>,
		direction: string | null = null,
	): Response {
		const n = task.workCheckSendbacks + 1;
		const repeated = repeatedBugClasses(task.workCheckLog);
		const divergePark =
			task.needsReason?.startsWith(WORK_CHECK_ASK_DIVERGE) === true;
		const rethink = `The blocker count did not drop over the last send-backs (blockers per check: ${workCheckBlockerCounts(task.workCheckLog).join(", ")}), so the fixes share a wrong premise. Before you fix one more instance: write down the premise that your fixes share, test the premise against the blockers above, and replace the approach when the premise is wrong.`;
		const directionSection =
			direction !== null
				? workCheckSendBackDirection(direction)
				: divergePark && repeated.length === 0
					? workCheckSendBackDirection(rethink)
					: null;
		// The direction goes out with the send-back for the work agent and into the log
		// for the next check: it stamps the send-back round's entry so the check reads it
		// out of band, never by parsing the sent-back text (a copy, so the store's change
		// detection sees the update).
		const lastIdx = task.workCheckLog.findLastIndex(
			(r) => r.outcome === "blockers",
		);
		const stampedLog =
			directionSection === null || lastIdx === -1
				? null
				: task.workCheckLog.map((r, i) =>
						i === lastIdx
							? {
									...r,
									direction: direction !== null ? direction : rethink,
								}
							: r,
					);
		const text = workCheckSendBack({
			blockers: open,
			attempt: n,
			max: WORK_CHECK_MAX_SENDBACKS,
			repeatedClasses: repeated,
		});
		e.store.updateTask(task.id, {
			// A steer queued before the stop stays: the send-back goes under it.
			pendingPrompt: queuedReply(
				task.pendingPrompt,
				directionSection === null ? text : `${text}\n${directionSection}`,
			),
			...(stampedLog === null ? {} : { workCheckLog: stampedLog }),
			pendingBy: "supervisor",
			workCheckSendbacks: n,
			state: "queued",
			holdUntil: null,
			queuedAt: Date.now(),
			needsReason: null,
			asked: null,
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}
	/** A click on the cap-exceeded work-check block's ask: the send-back or the merge. On a
	 * diverging park, a click does the chosen action; any other text is the user's new
	 * direction and sends the card back with it. Null is a plain reply. */
	async function workCheckAskReply(
		e: Entry,
		task: Task,
		trimmed: string,
		open: ReturnType<typeof openWorkBlockers>,
		hasImages: boolean,
	): Promise<Response | null> {
		const capPark = task.needsReason?.startsWith(WORK_CHECK_ASK_BLOCK) === true;
		const divergePark =
			task.needsReason?.startsWith(WORK_CHECK_ASK_DIVERGE) === true;
		if (
			!(capPark || divergePark) ||
			task.asked === null ||
			open.length === 0 ||
			hasImages
		)
			return null;
		if (trimmed === WORK_CHECK_ASK_MERGE) {
			e.store.updateTask(
				task.id,
				mergeAnywayPatch(task, "Merge anyway, chosen in the work-check ask"),
			);
			deps.schedule();
			return taskResponse(e, task.id);
		}
		if (capPark && trimmed === WORK_CHECK_ASK_SEND_BACK)
			return applyWorkCheckSendBack(e, task, open);
		if (divergePark) {
			if (trimmed === WORK_CHECK_ASK_CANCEL) {
				const out = await deps.cancel(e, task.id, false);
				if ("error" in out) return json({ error: out.error }, out.status);
				if ("kept" in out) return json({ ok: false, kept: out.kept });
				return taskResponse(e, task.id);
			}
			const direction =
				trimmed === WORK_CHECK_ASK_NEW_APPROACH ? null : trimmed;
			return applyWorkCheckSendBack(e, task, open, direction);
		}
		return null;
	}
	/** Which parked merge holds the card carries: update, fork, or none. */
	function holdKinds(task: Task): {
		approveHold: boolean;
		approveForkHold: boolean;
	} {
		const parked = task.holdHead;
		const mismatchHold =
			parked !== null && task.needsReason === MERGE_HOLD_MISMATCH_REASON;
		return {
			approveHold:
				parked !== null &&
				task.updateIds.length > 0 &&
				(task.needsReason === UPDATE_HOLD_REASON || mismatchHold),
			approveForkHold:
				parked !== null &&
				(task.needsReason === FORK_HOLD_REASON ||
					(mismatchHold && task.updateIds.length === 0)),
		};
	}
	function holdApprovalReply(
		e: Entry,
		task: Task,
		trimmed: string,
		hasImages: boolean,
	): Response | null {
		// U7: the approval reply on a parked update card approves its merge hold for the
		// head the settle parked (undefined keeps the column) and queues the normal merge
		// turn, so the server push happens. Same for a fork-born card parked by the fork
		// merge hold, and for a merge-hold mismatch park (OTTR-274: the parked head is the
		// exact local target head, so the next merge turn pushes it sha-equal). An agent can
		// write the hold text as its own question, but only a settle sets holdHead, so that
		// reply approves nothing. AGEN-33: only APPROVE_REPLY approves, and an approval
		// never queues a work turn.
		const { approveHold, approveForkHold } = holdKinds(task);
		const parked = task.holdHead;
		if (
			(approveHold || approveForkHold) &&
			trimmed === APPROVE_REPLY &&
			hasImages === false
		) {
			e.store.updateTask(task.id, {
				stage: "merging",
				state: "queued",
				holdUntil: null,
				queuedAt: Date.now(),
				needsReason: null,
				asked: null, // the answer to a "?" ask is queued; the badge goes back to plain needs-you flow
				updateMergeHead: approveHold ? parked : undefined,
				forkMergeHead: approveForkHold ? parked : undefined,
				holdHead: null,
			});
			deps.schedule();
			return taskResponse(e, task.id);
		}
		return null;
	}
	/** The gate park's Start anyway reply (docs/specs/prompt-gate.md): it approves the parked
	 * prompt without a gate pass, so the next start skips the gate for this exact text. Any
	 * other reply falls through to the queue and the gate re-runs on the next start. The
	 * fingerprint covers the judged prompt (the handoff the prompt names included,
	 * OTTR-844) plus any pending steer, so a queued user text still gates. */
	function gateStartReply(
		e: Entry,
		task: Task,
		trimmed: string,
		hasImages: boolean,
	): Response | null {
		const gate = task.gate;
		if (gate?.parked !== true || !isStartAnywayReply(trimmed) || hasImages)
			return null;
		const handoff = gateHandoff({
			prompt: task.prompt,
			handoffsDir: join(e.store.tasksDir, "handoffs"),
		});
		e.store.updateTask(task.id, {
			state: "queued",
			queuedAt: Date.now(),
			needsReason: null,
			asked: null, // the answer to a "?" ask is queued; the badge goes back to plain needs-you flow
			gate: {
				hash: gateFingerprint(
					gateCompareText(
						gateJudgedPrompt(task.prompt, handoff),
						task.pendingPrompt,
						gate.seen,
					),
				),
				seen: gateUserText(task.pendingPrompt, gate.seen),
				fails: 0,
				sig: null,
				parked: false,
			},
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}
	/** A reply to a review's lead-question card (OTTR-869): the drawer sends one
	 * `For "<question>": <answer>` line per question and each answer applies to that
	 * question's lead card — "Yes, the risk applies" queues the lead with the answer in
	 * its prompt, "No, it does not apply" cancels it with the answer as its reason, and
	 * free text appends to its details so the lead stays in backlog. The question card
	 * lands Done either way, so a second reply is refused. Null is a plain reply. */
	function reviewLeadAskReply(
		e: Entry,
		task: Task,
		text: string,
	): Response | null {
		if (
			task.asked === null ||
			!task.prompt.startsWith(LEAD_QUESTIONS_PROMPT_PREFIX)
		)
			return null;
		const tasks = e.store.listTasks();
		for (const q of task.asked) {
			const marker = askAnswerLine(q.question, "");
			const at = text.indexOf(marker);
			// No answer line (or an empty answer) for this question: its lead stays as it is.
			if (at === -1) continue;
			const rest = text.slice(at + marker.length);
			const stop = rest.indexOf('\nFor "');
			const answer = (stop === -1 ? rest : rest.slice(0, stop)).trim();
			if (answer === "") continue;
			// The question text carries its lead card: `... (card #<lead id>)`.
			const leadId = /\(card #([^)]+)\)$/.exec(q.question)?.[1];
			const lead =
				leadId === undefined
					? undefined
					: tasks.find(
							(t) => t.id === leadId && t.followUpOf === task.followUpOf,
						);
			// A stale question (its lead was cancelled or done) applies nothing.
			if (
				lead === undefined ||
				lead.cancelledAt !== null ||
				lead.stage === "done"
			)
				continue;
			if (answer === LEAD_APPLIES_OPTION) {
				const cur = e.store.getTask(lead.id);
				if (cur === null) continue;
				e.store.updateTask(lead.id, {
					stage: "todo",
					state: "queued",
					queuedAt: Date.now(),
					prompt: `${cur.prompt}\n\nThe user answered the review's question: ${answer}`,
				});
			} else if (answer === LEAD_NOT_APPLY_OPTION) {
				e.store.updateTask(lead.id, {
					cancelledAt: Date.now(),
					state: "idle",
					needsReason: `Cancelled by the user's answer to the review's question: ${answer}`,
				});
			} else {
				// Free text from the drawer's Other field: the lead stays in backlog.
				const cur = e.store.getTask(lead.id);
				if (cur === null) continue;
				e.store.updateTask(lead.id, {
					details: `${cur.details ?? ""}\n\nThe user answered the review's question: ${answer}`,
				});
			}
		}
		e.store.updateTask(task.id, {
			stage: "done",
			state: "idle",
			asked: null,
			needsReason: null,
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}
	/** The reply payload refusals: not needs-you, bad images, or text over the cap. */
	function replyRefusal(
		e: Entry,
		task: Task,
		text: string,
		rawImages: unknown,
	): { trimmed: string; images: DecodedImage[] } | Response {
		if (task.state !== "needs_you")
			return json({ error: "task is not waiting for you" }, 409);
		const images = steerDecoded(e, rawImages);
		if (images instanceof Response) return images;
		// Same rule as steer/follow-up (R1-9): an empty reply would re-send the whole
		// task prompt as the next turn, and an unbounded one can blow the session.
		const trimmed = text.trim();
		if (trimmed.length > 20000 || (trimmed === "" && images.length === 0))
			return json({ error: "text must be 1-20000 characters" }, 400);
		return { trimmed, images };
	}
	/** The reply's task and text; a Response is a refusal, a PR review card routes onward. */
	async function replyTarget(
		req: BunRequest<"/api/projects/:project/tasks/:id/reply">,
	): Promise<
		| Response
		| { e: Entry; task: Task; text: string; body: Record<string, unknown> }
	> {
		const r = await readJson(req, IMAGE_BODY_BYTES);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const text = r.body.text;
		if (typeof text !== "string")
			return json({ error: "text must be a string" }, 400);
		const { e, task } = found;
		if (task.cancelledAt !== null)
			return json({ error: "task is cancelled" }, 404);
		// A pr_review card never replays its prompt as a turn: the reply is a note for
		// the reviewer, which runs a new draft for the current head and counts against
		// the daily cap like a watcher run.
		if (task.kind === "pr_review") return prReviewReply(e, task, text, r.body);
		return { e, task, text, body: r.body };
	}
	async function handlePOSTProjectsTasksReplyByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/reply">,
	): Promise<Response> {
		const picked = await replyTarget(req);
		if (picked instanceof Response) return picked;
		const { e, task, text, body } = picked;
		const payload = replyRefusal(e, task, text, body.images);
		if (payload instanceof Response) return payload;
		const { trimmed, images } = payload;
		// A click on the cap-exceeded work-check block's ask, or on a diverging
		// work-check park: the chosen action, done here. Any other text, or a
		// picture, is a plain reply to the agent below.
		const open = openWorkBlockers(task.workCheckLog);
		const ask = await workCheckAskReply(
			e,
			task,
			trimmed,
			open,
			images.length > 0,
		);
		if (ask !== null) return ask;
		// A review's lead-question card (OTTR-869): the reply carries one answer per
		// question, each applied to its lead card, and the card lands Done here.
		const leadAsk = reviewLeadAskReply(e, task, trimmed);
		if (leadAsk !== null) return leadAsk;
		const names =
			images.length > 0
				? saveImages(e.store.dataRoot, e.store.imagesDir(task.id), images)
				: [];
		const approval = holdApprovalReply(e, task, trimmed, images.length > 0);
		if (approval !== null) return approval;
		const start = gateStartReply(e, task, trimmed, images.length > 0);
		if (start !== null) return start;
		e.store.updateTask(task.id, {
			// "." keeps pendingPrompt non-null for a picture-only reply (see steer). A steer
			// queued before the stop stays: the reply goes under it, and Resume (".") sends it alone.
			...replyPatch(task, trimmed || ".", names),
			// A non-approval reply never spends the parked head: the hold stays, and the
			// settle re-parks the card after the work turn.
		});
		deps.schedule();
		return taskResponse(e, task.id);
	}

	/** The validated triage priority; a Response is the 400. */
	function triagePriority(
		body: Record<string, unknown>,
	): Priority | null | undefined | Response {
		const { priority } = body;
		if (
			priority !== undefined &&
			priority !== null &&
			(typeof priority !== "string" ||
				!(PRIORITIES as readonly string[]).includes(priority))
		)
			return json(
				{ error: "priority must be null or one of P0, P1, P2, P3" },
				400,
			);
		return priority as Priority | null | undefined;
	}
	/** The trimmed close reason; a Response is the 400. */
	function triageCloseReason(v: unknown): string | null | Response {
		if (v === undefined || v === null) return null;
		if (typeof v !== "string")
			return json({ error: "closeCandidate must be a string" }, 400);
		const reason = v.trim();
		if (!reason || reason.length > 200)
			return json({ error: "closeCandidate must be 1-200 characters" }, 400);
		return reason;
	}
	/** The triage patch fields; a Response is the 400. */
	function triagePatch(body: Record<string, unknown>):
		| Response
		| {
				patch: {
					priority?: Priority | null;
					closeCandidate?: string | null;
				};
		  } {
		const { priority, closeCandidate } = body;
		if (priority === undefined && closeCandidate === undefined)
			return json({ error: "set priority, closeCandidate, or both" }, 400);
		const p = triagePriority(body);
		if (p instanceof Response) return p;
		const reason = triageCloseReason(closeCandidate);
		if (reason instanceof Response) return reason;
		const patch: {
			priority?: Priority | null;
			closeCandidate?: string | null;
		} = {};
		if (p !== undefined) patch.priority = p;
		if (closeCandidate !== undefined) patch.closeCandidate = reason;
		return { patch };
	}
	async function handlePOSTProjectsTasksTriageByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/triage">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const made = triagePatch(r.body);
		if (made instanceof Response) return made;
		const updated = e.store.updateTask(task.id, made.patch);
		return json(taskView(e, updated));
	}

	/** The prompt-edit gate: only an unclaimed queued/parked card with no turns may edit. */
	function editPromptRefusal(
		e: Entry,
		task: Task,
		prompt: unknown,
	): Response | { trimmed: string } {
		if (typeof prompt !== "string")
			return json({ error: "prompt must be a string" }, 400);
		const trimmed = prompt.trim();
		if (!trimmed || trimmed.length > 20000)
			return json({ error: "prompt must be 1-20000 characters" }, 400);
		// Editable only while the card still waits unclaimed: a todo card as queued, a
		// backlog card parked idle, or a held proposal parked needs_you (its drawer
		// edits the prompt before the user accepts). A preparing claim has already
		// consumed the prompt (its turn row only appears at startRun, after the git and
		// worktree preparation), so a rewrite there would never reach the run. The check
		// and the write are sync, so the scheduler (same event loop) cannot start a turn
		// in between.
		if (
			!(
				(task.stage === "todo" && task.state === "queued") ||
				(task.stage === "backlog" && task.state === "idle") ||
				(task.stage === "todo" &&
					task.state === "needs_you" &&
					isProposalReason(task.needsReason))
			) ||
			task.cancelledAt !== null ||
			e.store.listTurns(task.id).length > 0
		)
			return json(
				{
					error:
						"only a queued todo task or a parked backlog task can be edited",
				},
				409,
			);
		return { trimmed };
	}
	async function handlePOSTProjectsTasksEditByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id/edit">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		// The revision guard outranks the refusal below: a stale prompt edit answers
		// 409 with the current card instead of a bare precondition error.
		const stale = staleEditResponse(e, task, r.body);
		if (stale !== null) return stale;
		const edit = editPromptRefusal(e, task, r.body.prompt);
		if (edit instanceof Response) return edit;
		// Same shape rule as applyUserEdit: an absent revision keeps today's behavior.
		const revision = r.body.revision;
		if (
			revision !== undefined &&
			(typeof revision !== "number" ||
				!Number.isInteger(revision) ||
				revision < 1)
		)
			return json({ error: "revision must be a positive integer" }, 400);
		const t = e.store.editTask(task.id, edit.trimmed, revision);
		if (!t.ok)
			return json(
				{
					error: "card changed since it was loaded",
					task: taskView(e, t.task),
				},
				409,
			);
		return json(taskView(e, t.task));
	}

	/** Fills the release card's late-commit list: the commits the publish ships past the reviewed commit, with the review's finding merges marked. */
	async function attachLateCommits(e: Entry, task: Task, view: TaskView) {
		if (
			task.releaseVersion === null ||
			task.state !== "needs_you" ||
			task.cancelledAt !== null ||
			task.base === null ||
			e.target === null
		)
			return;
		// The commits the publish will ship past the reviewed commit, with the review's finding
		// merges marked: the anchors are the mergeHeads the finding cards stamped at Done.
		const findings = reviewFindings(e.store.listTasks(), task)
			.filter((f) => f.cancelledAt === null)
			.sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
			.flatMap((f) => (f.mergeHead === null ? [] : [f.mergeHead]));
		const head = await resolveTarget(
			e.path,
			false,
			null,
			e.store.getSettings().targetBranch,
		)
			.then((r) => r.sha)
			.catch(() => null);
		if (head === null) return;
		const marked = await lateCommits(e.path, task.base, head, findings).catch(
			() => null,
		);
		if (marked === null) return;
		view.lateCommits = marked.map(({ sha, subject, reviewed }) => ({
			sha,
			subject,
			reviewed,
		}));
	}
	// Repo-relative files kept under quarantine/<id> when the worktree was removed.
	// The walk anchors at the trusted data root and opens every component with
	// O_NOFOLLOW (withDir), so a worker-planted link at the card folder or below lists
	// nothing instead of the link target; sizes come from fd-based lstat, never
	// following the entry itself. Regular files only; [] when absent or refused.
	const savedDirFiles = (
		anchor: string,
		dirRel: string,
	): { name: string; size: number }[] => {
		const out: { name: string; size: number }[] = [];
		// confine's parts() resolves `dir` against the process cwd, so the walk passes
		// absolute paths and keeps each one below the anchor itself.
		const walk = (rel: string, prefix: string): void => {
			const abs = resolve(anchor, rel);
			if (relative(anchor, abs).startsWith(`..${sep}`)) return;
			try {
				withDir(anchor, abs, {}, (d) => {
					for (const name of d.list()) {
						const relName = prefix ? `${prefix}/${name}` : name;
						let st: Stats;
						try {
							st = lstatSync(d.at(name));
						} catch {
							continue; // vanished between list and lstat
						}
						if (st.isDirectory()) walk(join(rel, name), relName);
						else if (st.isFile()) out.push({ name: relName, size: st.size });
					}
				});
			} catch {
				// refused (a symlink at any component) or missing: nothing to list
			}
		};
		walk(dirRel, "");
		return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	};
	async function handleGETProjectsTasksByProjectAndId(
		req: BunRequest<"/api/projects/:project/tasks/:id">,
	): Promise<Response> {
		const found = resolveTask(req.params.project, req.params.id);
		if (found instanceof Response) return found;
		const { e, task } = found;
		const view = taskView(e, task);
		// Done cards serve the list captured at settle (the worktree is gone, so the
		// live read would always be []); open cards read the worktree live.
		view.worktreeFiles =
			task.stage === "done"
				? task.uncommittedFiles
				: task.worktree === null
					? []
					: await statusFiles(task.worktree);
		if (task.stage === "done") {
			const rel = relative(
				e.store.dataRoot,
				join(e.store.tasksDir, "quarantine", task.id),
			);
			if (rel !== "" && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
				view.savedFiles = savedDirFiles(e.store.dataRoot, rel);
		}
		// Finished cards read the stat captured at merge start (the worktree and branch are
		// gone); open cards read the branch live, uncommitted edits included. A merge-hold
		// mismatch park also serves the stored stat: it is the push-side numstat the gate
		// flagged, which the live worktree diff cannot show once the branch is integrated.
		view.diffFiles =
			task.stage === "done" ||
			task.cancelledAt !== null ||
			task.needsReason === MERGE_HOLD_MISMATCH_REASON
				? task.diffFiles
				: task.worktree === null || e.target === null
					? null
					: await diffStat(task.worktree, task.base ?? "HEAD", e.target).catch(
							() => null,
						);
		await attachLateCommits(e, task, view);
		return json(view);
	}

	function validateTrendingVerdict(body: Record<string, unknown>):
		| {
				scoutId: string;
				repo: string;
				verdict: "filed" | "no_fit" | "deferred";
				reason: string;
		  }
		| Response {
		const { scoutId, repo, verdict, reason } = body;
		if (typeof scoutId !== "string" || scoutId === "")
			return json({ error: "scoutId must be a task id" }, 400);
		if (typeof repo !== "string" || repo.trim() === "")
			return json({ error: "repo must be owner/repo" }, 400);
		if (verdict !== "filed" && verdict !== "no_fit" && verdict !== "deferred")
			return json({ error: "verdict must be filed, no_fit or deferred" }, 400);
		if (typeof reason !== "string")
			return json({ error: "reason must be a string" }, 400);
		const why = reason.trim();
		if (!why || why.length > 500)
			return json({ error: "reason must be 1-500 characters" }, 400);
		return { scoutId, repo: repo.trim(), verdict, reason: why };
	}

	function validateTrendingPrompt(
		body: Record<string, unknown>,
	): { prompt: string; title?: string } | Response {
		const { prompt, title } = body;
		if (typeof prompt !== "string")
			return json({ error: "prompt must be a string" }, 400);
		const text = prompt.trim();
		if (!text || text.length > 20000)
			return json({ error: "prompt must be 1-20000 characters" }, 400);
		if (title !== undefined && title !== null && typeof title !== "string")
			return json({ error: "title must be a string" }, 400);
		const name = typeof title === "string" ? title.trim() : "";
		if (name.length > 200)
			return json({ error: "title must be at most 200 characters" }, 400);
		return { prompt: text, ...(name !== "" ? { title: name } : {}) };
	}

	function judgeTrending(
		e: Entry,
		v: {
			scoutId: string;
			repo: string;
			verdict: "filed" | "no_fit" | "deferred";
			reason: string;
		},
	): Response {
		const { scoutId, repo, reason } = v;
		const verdict = v.verdict === "filed" ? null : v.verdict;
		if (!verdict) return json({ error: "not a judgment verdict" }, 400);
		const out = e.store.judgeTrendingRepo({
			scoutId,
			repo,
			verdict,
			reason,
		});
		return out.ok ? json({ ok: true }) : json({ error: out.error }, 409);
	}

	function fileTrending(
		e: Entry,
		v: { scoutId: string; repo: string },
		p: { prompt: string; title?: string },
	): Response {
		const out = e.store.fileTrendingProposal({
			scoutId: v.scoutId,
			repo: v.repo,
			prompt: p.prompt,
			...(p.title !== undefined ? { title: p.title } : {}),
			cap: TRENDING_CAP,
		});
		return out.ok
			? json({ ok: true, id: out.task.id })
			: json({ error: out.error }, 409);
	}

	async function handlePOSTProjectsTrendingVerdictsByProject(
		req: BunRequest<"/api/projects/:project/trending/verdicts">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		const v = validateTrendingVerdict(r.body);
		if (v instanceof Response) return v;
		if (v.verdict !== "filed") return judgeTrending(e, v);
		const p = validateTrendingPrompt(r.body);
		if (p instanceof Response) return p;
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		return fileTrending(e, v, p);
	}

	function resolveFollowUpOf(
		project: string,
		value: unknown,
	):
		| {
				followUpOf: string;
				followUpOfProject: string | null;
				updateIds: string[];
		  }
		| Response {
		if (typeof value !== "string")
			return json({ error: "followUpOf must be a task id" }, 400);
		const parentId: string = value;
		const parent = resolveTask(project, parentId);
		if (!(parent instanceof Response)) {
			// A child of an update card inherits its merge hold: split-off update work needs the same approval.
			return {
				followUpOf: parent.task.id,
				followUpOfProject: null,
				updateIds: parent.task.updateIds,
			};
		}
		if (parent.status !== 404) return parent;
		// Not on this project's board: create_task can file the work into
		// another project, so scan the fleet for the parent. A 404 here means
		// the id shape is valid (resolveTask answers 400 for a bad shape
		// first). Ids are unique per project, not across projects: exactly
		// one foreign match links and stores the parent's project, several
		// are ambiguous, and the merge hold never crosses a project border.
		const hits = [...deps.projects.values()]
			.filter((p) => p.name !== project)
			.flatMap((p) => {
				const task = p.store.getTask(parentId);
				return task === null ? [] : [{ project: p.name, task }];
			});
		const hit = hits[0];
		if (hit === undefined)
			return json({ error: "unknown followUpOf task" }, 404);
		if (hits.length > 1)
			return json(
				{
					error: `followUpOf names cards in several projects: ${hits.map((h) => h.project).join(", ")}`,
				},
				409,
			);
		return {
			followUpOf: hit.task.id,
			followUpOfProject: hit.project,
			updateIds: [],
		};
	}

	/** The 404 Response a dependsOn id that names no card must get; null when the id resolves. */
	function depResolveError(id: string, dep: DepResolution): Response | null {
		if ("task" in dep) return null;
		if (dep.why === "project")
			return json(
				{ error: `unknown project ${dep.prefix} in dependsOn task: ${id}` },
				404,
			);
		if (dep.why === "ambiguous")
			return json(
				{
					error: `ambiguous id prefix ${dep.prefix} in dependsOn task: ${id} (${dep.projects.join(", ")})`,
				},
				404,
			);
		return json({ error: `unknown dependsOn task: ${id}` }, 404);
	}

	function validateDependsOn(e: Entry, value: unknown): string[] | Response {
		if (
			!Array.isArray(value) ||
			value.some((x) => typeof x !== "string" || x.trim() === "")
		)
			return json({ error: "dependsOn must be an array of task ids" }, 400);
		const ids = [...new Set(value as string[])];
		// OTTR-708: a card of this project, or by its PREFIX-n handle a card of any
		// registered project. An unknown handle names the project in the error.
		const depProjects = depProjectsOf(deps.projects.values());
		const ownDep = depProjectOf(e.store);
		for (const id of ids) {
			if (ownDep.getTask(id) !== null) continue;
			const bad = depResolveError(id, resolveDep(id, depProjects, ownDep));
			if (bad !== null) return bad;
		}
		return ids;
	}

	function validateTaskPrompt(
		body: Record<string, unknown>,
	): string | Response {
		const prompt = body.prompt;
		if (typeof prompt !== "string")
			return json({ error: "prompt must be a string" }, 400);
		const trimmed = prompt.trim();
		if (!trimmed || trimmed.length > 20000)
			return json({ error: "prompt must be 1-20000 characters" }, 400);
		return trimmed;
	}

	function saveTaskImages(
		e: Entry,
		t: { id: string },
		decoded: { images: DecodedImage[] },
	): Response | null {
		try {
			if (decoded.images.length > 0) {
				const names = saveImages(
					e.store.dataRoot,
					e.store.imagesDir(t.id),
					decoded.images,
				);
				// Synchronous with createTask so the 5 s schedule timer never sees the task without its images.
				e.store.updateTask(t.id, { images: names });
			}
		} catch (err) {
			e.store.updateTask(t.id, {
				cancelledAt: Date.now(),
				state: "idle",
			});
			return json({ error: `could not save images: ${errmsg(err)}` }, 500);
		}
		return null;
	}

	async function validateTaskCreate(
		e: Entry,
		body: Record<string, unknown>,
	): Promise<
		| {
				prompt: string;
				followUpOf: string | null;
				followUpOfProject: string | null;
				updateIds: string[];
				dependsOn: string[];
				model: string | null;
		  }
		| Response
	> {
		const promptRes = validateTaskPrompt(body);
		if (promptRes instanceof Response) return promptRes;
		// Agents filing cards from another task's run pass that task here; the link renders in both drawers.
		let followUpOf: string | null = null;
		let followUpOfProject: string | null = null;
		let updateIds: string[] = [];
		if (body.followUpOf != null) {
			const linked = resolveFollowUpOf(e.store.name, body.followUpOf);
			if (linked instanceof Response) return linked;
			followUpOf = linked.followUpOf;
			followUpOfProject = linked.followUpOfProject;
			updateIds = linked.updateIds;
		}
		let dependsOn: string[] = [];
		if (body.dependsOn != null) {
			const depIds = validateDependsOn(e, body.dependsOn);
			if (depIds instanceof Response) return depIds;
			dependsOn = depIds;
		}
		const model = modelParam(body);
		if (model instanceof Response) return model;
		const badModel = await cardModelResponse(model);
		if (badModel !== null) return badModel;
		return {
			prompt: promptRes,
			followUpOf,
			followUpOfProject,
			updateIds,
			dependsOn,
			model,
		};
	}

	function applyTaskCreateExtras(
		e: Entry,
		t: { id: string },
		prep: {
			followUpOf: string | null;
			followUpOfProject: string | null;
			updateIds: string[];
			dependsOn: string[];
		},
		backlog: unknown,
	): void {
		if (prep.followUpOf !== null)
			e.store.updateTask(t.id, {
				followUpOf: prep.followUpOf,
				followUpOfProject: prep.followUpOfProject,
				updateIds: prep.updateIds,
			});
		if (prep.dependsOn.length > 0)
			e.store.updateTask(t.id, { dependsOn: prep.dependsOn });
		if (backlog === true)
			e.store.updateTask(t.id, {
				stage: "backlog",
				state: "idle",
				queuedAt: null,
			});
	}

	async function handlePOSTProjectsTasksByProject(
		req: BunRequest<"/api/projects/:project/tasks">,
	): Promise<Response> {
		const r = await readJson(req, IMAGE_BODY_BYTES);
		if ("error" in r) return r.error;
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		const prep = await validateTaskCreate(e, r.body);
		if (prep instanceof Response) return prep;
		const decoded = decodeImages(
			r.body.images,
			e.store.getSettings().maxImages,
		);
		if ("error" in decoded) return json({ error: decoded.error }, 400);
		const t = e.store.createTask(prep.prompt, prep.model);
		// OTTR-850: an agent's create_task files board-written prompts (the token decides,
		// never a client flag); the user's New task form stays user-authored.
		if (agentCardRequest(req))
			e.store.updateTask(t.id, { promptAuthor: "board" });
		const saved = saveTaskImages(e, t, decoded);
		if (saved instanceof Response) return saved;
		applyTaskCreateExtras(e, t, prep, r.body.backlog);
		// schedule() may start a turn that mutates the row: re-read, don't trust the create return.
		deps.schedule();
		return taskResponse(e, t.id);
	}

	async function handlePOSTProjectsDeepenByProject(
		req: BunRequest<"/api/projects/:project/deepen">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		const trimmedRes = validateTaskPrompt(r.body);
		if (trimmedRes instanceof Response) return trimmedRes;
		const model = modelParam(r.body);
		if (model instanceof Response) return model;
		try {
			const deepened = await (
				deps.deepen ?? ((prompt, model) => deepenDraft({ prompt, model }))
			)(trimmedRes, model);
			let check: DeepenCheck | null = null;
			let checkError: string | null = null;
			try {
				check = await (
					deps.deepenCheck ??
					((draft, rewrite, m) => checkDeepened({ draft, rewrite, model: m }))
				)(trimmedRes, deepened, model);
			} catch (err) {
				// A failed or malformed check never blocks the rewrite.
				checkError = err instanceof Error ? err.message : "unknown error";
				if (checkError.length > 500) checkError = checkError.slice(0, 500);
			}
			return json({ deepened, check, checkError });
		} catch (err) {
			logError("deepen", err);
			return json(
				{
					error: `the model call failed: ${
						err instanceof Error ? err.message : "unknown error"
					}`,
				},
				502,
			);
		}
	}

	function validateReleaseSha(
		body: Record<string, unknown>,
	): string | Response {
		const sha = body.sha;
		if (typeof sha !== "string" || /^[0-9a-f]{7,40}$/.test(sha) === false)
			return json({ error: "sha must be a 7-40 character hex string" }, 400);
		return sha;
	}

	function validateReleaseVersion(
		body: Record<string, unknown>,
	): string | undefined | Response {
		const override = body.version;
		if (
			override !== undefined &&
			(typeof override !== "string" || !VERSION_RE.test(override))
		)
			return json({ error: "version must match vX.Y.Z (e.g. v1.2.3)" }, 400);
		return typeof override === "string" ? override : undefined;
	}

	function validateReleaseNotes(
		body: Record<string, unknown>,
	): string | undefined | Response {
		const overrideNotes = body.notes;
		if (
			overrideNotes !== undefined &&
			(typeof overrideNotes !== "string" ||
				overrideNotes.trim().length < 1 ||
				overrideNotes.length > 20_000)
		)
			return json(
				{ error: "notes must be a string of 1-20000 characters" },
				400,
			);
		return typeof overrideNotes === "string" ? overrideNotes : undefined;
	}

	async function releaseTagClash(
		e: Entry,
		version: string,
		planVersion: string,
	): Promise<Response | null> {
		if (version === planVersion) return null;
		const found = await git(
			["rev-parse", "--verify", "--quiet", `refs/tags/${version}`],
			e.path,
		);
		return found.code === 0
			? json({ error: `Tag ${version} already exists.` }, 409)
			: null;
	}

	async function checkReleaseSemver(e: Entry): Promise<Response | null> {
		// Same gate as the GET: a repo releasing under other names gets no Ottr release.
		const repo = e.github === null ? null : ownerRepo(e.github);
		const ghLatest = repo === null ? null : await latestReleaseOf(repo);
		return ghLatest !== null && !ghLatest.semver
			? json({ error: nonSemVerBlock(ghLatest.name) }, 409)
			: null;
	}

	// The dialog may override the agent's semver pick; validate the shape and
	// re-check the tag collision planRelease only ran for its own version.
	async function resolveReleaseOverrides(
		e: Entry,
		plan: Omit<ReleasePlan, "tasks">,
		body: Record<string, unknown>,
	): Promise<
		{ version: string; notes: string; model: string | null } | Response
	> {
		const versionRes = validateReleaseVersion(body);
		if (versionRes instanceof Response) return versionRes;
		const version = versionRes ?? plan.version;
		const tagClash = await releaseTagClash(e, version, plan.version);
		if (tagClash instanceof Response) return tagClash;
		// No await between the guard and createTask below: two overlapping requests cannot
		// both pass the check and create two release cards (R1-8).
		const blocked =
			releaseBlocked(
				e.store.listTasks(),
				e.store.getSettings().releaseCommand,
			) ?? plan.blocked;
		if (blocked !== null) return json({ error: blocked }, 409);
		// Optional user edit of the planned notes (the dialog's textarea).
		const notesRes = validateReleaseNotes(body);
		if (notesRes instanceof Response) return notesRes;
		const model = modelParam(body);
		if (model instanceof Response) return model;
		return { version, notes: notesRes ?? plan.notes, model };
	}

	async function handlePOSTProjectsReleaseByProject(
		req: BunRequest<"/api/projects/:project/release">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const sha = validateReleaseSha(r.body);
		if (sha instanceof Response) return sha;
		const planned = await planFromRepo(e, sha);
		if (planned instanceof Response) return planned;
		const semverGate = await checkReleaseSemver(e);
		if (semverGate instanceof Response) return semverGate;
		// Network before the guard: resolveReleaseOverrides keeps the R1-8 ordering with no
		// await between the guard and createTask. Never throws: a failed fetch lands in the
		// prompt as a per-type unavailable line or "alerts unavailable: <reason>".
		const alerts = await githubAlertSummary({ repo: e.github, gh });
		const overrides = await resolveReleaseOverrides(e, planned.plan, r.body);
		if (overrides instanceof Response) return overrides;
		return createReleaseCard(
			e,
			planned.plan,
			overrides.version,
			overrides.notes,
			overrides.model,
			alerts,
		);
	}

	function createReleaseCard(
		e: Entry,
		plan: Omit<ReleasePlan, "tasks">,
		version: string,
		notes: string,
		model: string | null,
		alerts: string,
	) {
		const t = e.store.createTask(
			releasePrompt({
				version,
				from: plan.from,
				sha: plan.sha,
				commits: plan.commits,
				notes,
				alerts,
			}),
			model,
		);
		// Synchronous with createTask: the scheduler must never see a half-made release card.
		const updated = e.store.updateTask(t.id, {
			promptAuthor: "board",
			base: plan.sha,
			releaseVersion: version,
			releaseNotes: notes,
		});
		deps.schedule();
		return json({ ...updated, turns: [] });
	}

	async function releaseWindowStart(
		e: Entry,
		from: string | null,
	): Promise<number> {
		if (from === null) return 0;
		return (
			Number(
				(await git(["log", "-1", "--format=%ct", from], e.path)).stdout.trim(),
			) * 1000
		);
	}

	async function planFromRepo(
		e: Entry,
		sha: string | null,
	): Promise<
		{ target: string; sha: string; plan: Omit<ReleasePlan, "tasks"> } | Response
	> {
		let resolved: { target: string; sha: string };
		try {
			resolved = await resolveTarget(
				e.path,
				true,
				e.store.getSettings().originUrl,
				e.store.getSettings().targetBranch,
			);
		} catch (err) {
			return json({ error: errmsg(err) }, 409);
		}
		const plan = await planRelease({
			mainPath: e.path,
			target: resolved.target,
			sha: sha ?? resolved.sha,
			originUrl: e.store.getSettings().originUrl,
		}).catch((err) => json({ error: errmsg(err) }, 409));
		if (plan instanceof Response) return plan;
		return { target: resolved.target, sha: resolved.sha, plan };
	}

	async function handleGETProjectsReleaseByProject(
		req: BunRequest<"/api/projects/:project/release">,
	): Promise<Response> {
		const e = deps.projects.get(req.params.project);
		if (e === undefined) return json({ error: "project not found" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		const planned = await planFromRepo(e, null);
		if (planned instanceof Response) return planned;
		const plan = planned.plan;
		// The repo's latest GitHub release decides whether a version may be computed:
		// a repo releasing under other names (a non-vX.Y.Z latest release) must not see
		// a merged vX.Y.Z tag pose as the current release, so the plan carries nothing
		// computed and the dialog can only show why.
		const repo = e.github === null ? null : ownerRepo(e.github);
		const ghLatest = repo === null ? null : await latestReleaseOf(repo);
		if (ghLatest !== null && !ghLatest.semver)
			return json({
				...plan,
				from: null,
				version: "",
				notes: "",
				commits: 0,
				blocked: nonSemVerBlock(ghLatest.name),
				tasks: [],
			});
		// Window start: the last release tag's commit time; merges are serialized, so a
		// task is in from..sha exactly when it finished after that commit landed.
		const since = await releaseWindowStart(e, plan.from);
		const all = e.store.listTasks();
		const tasks = includedTasks(all, since);
		const blocked = releaseBlocked(all, e.store.getSettings().releaseCommand);
		return json(
			blocked === null ? { ...plan, tasks } : { ...plan, tasks, blocked },
		);
	}

	function checkSettingsGuards(
		e: Entry,
		patch: Record<string, unknown>,
	): Response | null {
		// PR mode needs a GitHub host: the merge flow pushes the branch and opens
		// a PR there (same fact the prs/check route 409s on).
		if (patch.prMode === true && e.github === null)
			return json(
				{ error: "prMode needs a GitHub remote on the configured host" },
				400,
			);
		// microVM mode dispatches every work turn to vm-runner: turning it on while
		// the runner is unreachable would park every queued card. Off always saves.
		if (patch.microVm === true && !vmState.health.ok)
			return json(
				{
					error: `microVm needs a reachable vm-runner: ${vmState.health.reason ?? "not reachable"}`,
				},
				400,
			);
		return null;
	}

	// retro -> retroSince: on keeps the existing mark (a re-save must not move
	// it), off clears it. Validated as a boolean by parseSettingsPatch.
	function applyRetroSince(
		e: Entry,
		patch: Record<string, unknown>,
		retro: unknown,
	): void {
		if (typeof retro !== "boolean") return;
		patch.retroSince = retro
			? (e.store.getSettings().retroSince ?? Date.now())
			: null;
	}

	// A new targetBranch must move e.target at once: the board, the supervisor,
	// the diffs and the gates read it until the next turn. A save that does not
	// touch the target leaves it alone. The save proves the branch resolves
	// before it lands: an unresolvable one is a 409 with the resolve error and
	// nothing is applied, so the board never reports the old target under the
	// new setting.
	async function resolveSettingsTarget(
		e: Entry,
		patch: Record<string, unknown>,
	): Promise<Response | null> {
		if (patch.targetBranch === undefined) return null;
		const targetBranch: string | null =
			typeof patch.targetBranch === "string" ? patch.targetBranch : null;
		try {
			await resolveTarget(e.path, false, null, targetBranch);
		} catch (err) {
			return json({ error: errmsg(err) }, 409);
		}
		return null;
	}

	// issueWatch off -> on moves issueWatchSince to now: only issues opened after the
	// (re-)enable file cards. Saving true while on keeps the mark; off leaves it. Set
	// after every await above, from the live setting, so the mark is the moment the
	// watch actually turns on.
	function stampIssueWatch(e: Entry, patch: Record<string, unknown>): void {
		if (patch.issueWatch === true && e.store.getSettings().issueWatch !== true)
			patch.issueWatchSince = Date.now();
	}

	/** Jira connections, search and import (src/jiraRoutes.ts). */
	const jira = createJiraRoutes({
		gstore: deps.gstore,
		projects: deps.projects,
		box: deps.secretBox,
		net: { hosted: deps.hosted !== undefined, ...deps.jiraNet },
		schedule: deps.schedule,
		now,
		json,
	});

	/** Reads the JSON body, then runs a Jira handler on it. */
	async function jiraPost(
		req: Request,
		fn: (body: Record<string, unknown>) => Promise<Response>,
	): Promise<Response> {
		const r = await readJson(req);
		return "error" in r ? r.error : fn(r.body);
	}

	async function handlePOSTProjectsSettingsByProject(
		req: BunRequest<"/api/projects/:project/settings">,
	): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const e = deps.projects.get(req.params.project);
		if (!e) return json({ error: "unknown project" }, 404);
		if (e.gitless) return json({ error: "init a git repository first" }, 409);
		// Every field validates before the patch lands: parseSettingsPatch is pure,
		// so a 400 never leaves a half-applied settings save behind.
		const patch = parseSettingsPatch(r.body);
		if (patch instanceof Response) return patch;
		const guard =
			jira.settingsRefusal(patch.jiraConnection) ??
			checkSettingsGuards(e, patch);
		if (guard instanceof Response) return guard;
		applyRetroSince(e, patch, r.body.retro);
		const resolved = await resolveSettingsTarget(e, patch);
		if (resolved instanceof Response) return resolved;
		stampIssueWatch(e, patch);
		e.store.setSettings(patch);
		if (patch.targetBranch !== undefined) await refreshRemote(e);
		return json(projectView(e));
	}

	function validateAlateUrl(trimmed: string): string | Response {
		const refused = alateUrlError(trimmed);
		return refused === null
			? trimmed.replace(/\/+$/, "")
			: json({ error: refused }, 400);
	}

	function validateAlateValue(
		key: "url" | "key",
		v: unknown,
	): string | null | Response {
		if (v === null || v === "") return null;
		if (typeof v !== "string")
			return json({ error: `${key} must be a string or null` }, 400);
		const trimmed = v.trim();
		if (trimmed.length > 500)
			return json({ error: `${key} is too long (max 500 chars)` }, 400);
		if (/[\p{Cc}]/u.test(trimmed))
			return json({ error: `${key} contains control characters` }, 400);
		return key === "url" ? validateAlateUrl(trimmed) : trimmed;
	}

	async function handlePOSTAlate(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const body = r.body as Record<string, unknown>;
		// A non-empty key would land as plaintext with no box; an explicit null clear
		// stays allowed (ADR-0011).
		if (typeof body.key === "string" && body.key !== "") {
			const noBox = sealGuard();
			if (noBox !== null) return noBox;
		}
		// Validate into a copy (R1-10): a bad later key must not leave the earlier
		// key live — health, provision and the turns read the old config until the
		// whole body validates.
		const next = { ...alate };
		for (const key of ["url", "key"] as const) {
			const v = body[key];
			if (v === undefined) continue;
			const valid = validateAlateValue(key, v);
			if (valid instanceof Response) return valid;
			next[key] = valid;
		}
		// The body carried the key: a value that normalizes to null (an explicit
		// null or an empty string) is an operator clear, and it must win over a
		// kept-unreadable blob (ADR-0011).
		if (next.key === null && body.key !== undefined) clearSecret("alateKey");
		alate = next;
		saveConfig();
		return json(alateView());
	}

	function drainRunner(body: Record<string, unknown>): Response | null {
		// A per-runner hold: validate the id and hold only that runner; the
		// board-wide state stays untouched.
		const runner = body.runner;
		if (typeof runner !== "string")
			return json({ error: "runner must be a string" }, 400);
		const known = (deps.runners ?? [{ id: "local", url: null }]).some(
			(x) => x.id === runner,
		);
		if (!known) return json({ error: `unknown runner ${runner}` }, 400);
		const until = Date.now() + DRAIN_MS;
		runnerDrains.set(runner, until);
		return json({ until });
	}

	function sanitizeDrainCommits(value: unknown): Response | null {
		// The update script ships the pending commit subjects; untrusted input, so
		// sanitize like the settings routes before anything reads them back.
		if (!Array.isArray(value) || value.some((c) => typeof c !== "string"))
			return json({ error: "commits must be an array of strings" }, 400);
		drainCommits = (value as string[])
			.map((c) => c.trim())
			.filter((c) => c.length > 0 && !/[\p{Cc}]/u.test(c))
			.map((c) => (c.length > 200 ? c.slice(0, 200) : c))
			.slice(0, 50);
		return null;
	}

	async function handlePOSTDrain(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		if (r.body.runner !== undefined) {
			const held = drainRunner(r.body);
			if (held !== null) return held;
		} else if (r.body.commits !== undefined) {
			const clean = sanitizeDrainCommits(r.body.commits);
			if (clean instanceof Response) return clean;
		} else {
			drainCommits = [];
		}
		drainUntil = Date.now() + DRAIN_MS;
		return json({ drainUntil });
	}

	function boolSetting(
		body: Record<string, unknown>,
		key: "reviewCheck" | "workCheck" | "idleReviews" | "trendingScan",
	): boolean | undefined | Response {
		const v = body[key];
		if (v === undefined) return undefined;
		if (typeof v !== "boolean")
			return json({ error: `${key} must be a boolean` }, 400);
		return v;
	}

	function commitIdentitySetting(
		body: Record<string, unknown>,
	): { name: string; email: string } | null | Response | undefined {
		if (body.commitName === undefined && body.commitEmail === undefined)
			return undefined;
		// The pair saves together: one field without the other is a 400 before
		// any value lands in shared.
		if (body.commitName === undefined || body.commitEmail === undefined) {
			return json(
				{ error: "commitName and commitEmail must be saved together" },
				400,
			);
		}
		const name = parseCommitField(body.commitName, "commitName");
		if (!name.ok) return json({ error: name.error }, 400);
		const email = parseCommitField(body.commitEmail, "commitEmail");
		if (!email.ok) return json({ error: email.error }, 400);
		if ((name.value === null) !== (email.value === null)) {
			return json(
				{ error: "commitName and commitEmail must be saved together" },
				400,
			);
		}
		// Past the 400s both values are a string or null (undefined cannot
		// occur: both fields were required above), so the pair is complete.
		return typeof name.value === "string" && typeof email.value === "string"
			? { name: name.value, email: email.value }
			: null;
	}

	function maxTotalSetting(
		body: Record<string, unknown>,
	): number | null | undefined | Response {
		const v = body.maxTotal;
		if (v === undefined) return undefined;
		if (
			v !== null &&
			(typeof v !== "number" || !Number.isInteger(v) || v < 1)
		) {
			return json(
				{ error: "maxTotal must be a positive integer or null" },
				400,
			);
		}
		return v as number | null;
	}

	function applyBoolSettings(body: Record<string, unknown>): Response | null {
		for (const key of [
			"reviewCheck",
			"workCheck",
			"idleReviews",
			"trendingScan",
		] as const) {
			const v = boolSetting(body, key);
			if (v instanceof Response) return v;
			if (v !== undefined)
				(deps.shared as unknown as Record<string, boolean | undefined>)[key] =
					v;
		}
		return null;
	}

	async function handlePOSTSettings(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const body = r.body as Record<string, unknown>;
		const maxTotal = maxTotalSetting(body);
		if (maxTotal instanceof Response) return maxTotal;
		if (maxTotal !== undefined) deps.shared.maxTotalRuns = maxTotal;
		const flags = applyBoolSettings(body);
		if (flags instanceof Response) return flags;
		const identity = commitIdentitySetting(body);
		if (identity instanceof Response) return identity;
		if (identity !== undefined) deps.shared.commitIdentity = identity;
		saveConfig();
		deps.schedule();
		return json({
			maxTotal: deps.shared.maxTotalRuns,
			reviewCheck: deps.shared.reviewCheck,
			workCheck: deps.shared.workCheck,
			idleReviews: deps.shared.idleReviews,
			trendingScan: deps.shared.trendingScan,
			commitIdentity: deps.shared.commitIdentity,
		});
	}

	function validateOrphansStopBody(
		body: Record<string, unknown>,
	): { pid: number; started: number; cmd: string } | Response {
		const { pid, started, cmd } = body;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
			return json({ error: "invalid pid" }, 400);
		if (typeof cmd !== "string" || cmd === "")
			return json({ error: "invalid cmd" }, 400);
		if (typeof started !== "number" || started < 0)
			return json({ error: "invalid started" }, 400);
		return { pid, started, cmd };
	}

	// Advisory stays advisory: kill only what the last scan reported, and only
	// when the live process table still names the same command. Any drift
	// (pid reuse, restart, a now-claimed turn) refuses, so the operator decides.
	function checkOrphansStop(
		pid: number,
		started: number,
		cmd: string,
	): Response | null {
		if (pid === process.pid)
			return json({ error: "refusing to stop the tracker itself" }, 409);
		const claimed = deps.claimedPids();
		if (claimed.has(pid))
			return json({ error: "a live turn claims this pid" }, 409);
		const fresh = (deps.listProcesses ?? (() => platform.listProcesses()))();
		const live = fresh.find((p) => p.pid === pid);
		if (live === undefined) return json({ error: "process is gone" }, 409);
		// The state carries the summarized command, so compare shapes, not bytes:
		// the start-time guard below is what pins the pid against reuse.
		if (summarizeCmd(live.cmd) !== cmd)
			return json({ error: "command differs" }, 409);
		if (Math.abs(live.started - started) > 30_000)
			return json({ error: "start time drifted" }, 409);
		return null;
	}

	async function handlePOSTOrphansStop(req: Request): Promise<Response> {
		const r = await readJson(req);
		if ("error" in r) return r.error;
		const parsed = validateOrphansStopBody(r.body);
		if (parsed instanceof Response) return parsed;
		const refused = checkOrphansStop(parsed.pid, parsed.started, parsed.cmd);
		if (refused instanceof Response) return refused;
		(deps.killTree ?? ((p) => platform.killTree(p)))(parsed.pid);
		return json({ ok: true });
	}

	function validateModelRolesBody(
		body: Record<string, unknown>,
	):
		| { base: unknown; hash: unknown; roles: unknown; fallbacks: unknown }
		| Response {
		const { base, hash, roles, fallbacks } = body;
		if (
			(typeof base !== "string" && base !== null) ||
			typeof hash !== "string" ||
			typeof roles !== "object" ||
			roles === null ||
			Array.isArray(roles) ||
			(fallbacks !== undefined &&
				(typeof fallbacks !== "object" ||
					fallbacks === null ||
					Array.isArray(fallbacks)))
		)
			return json(
				{
					error:
						"body must be { base: string | null, hash: string, roles: object, fallbacks?: object }",
				},
				400,
			);
		return { base, hash, roles, fallbacks };
	}

	type RolesSource = Extract<
		AlateOut<{
			content: string;
			hash: string;
			base: string | null;
			repo: { name: string; ref: string } | null;
			path: string | null;
		}>,
		{ ok: true }
	>["body"];

	// A folder source saves through alate's editor PUT: alate checks `base`
	// (the sha256 the editor loaded) against the folder before writing.
	// Alate's state and health carry no git-ness or writability field for a
	// folder, so the board learns "cannot save" only from a refused save.
	// The verdicts below remember that per folder path, in memory: they
	// survive page reloads and clear at a server restart, so a mount that
	// becomes writable re-arms Save instead of staying locked forever.
	const folderSaveVerdicts = new Map<string, "plain" | "mount">();
	function folderSaveVerdict(
		path: string | null,
	): { path: string; cause: "plain" | "mount" } | null {
		if (path === null) return null;
		const cause = folderSaveVerdicts.get(path);
		return cause ? { path, cause } : null;
	}
	async function saveRolesFolder(
		f: RolesSource,
		content: string,
		message: string,
	): Promise<Response> {
		const { path } = f;
		const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
		const w = await saveConfigYml(alate, content, f.hash, message);
		if (!w.ok) {
			// A read-only mount fails alate's PUT before any byte: alate
			// answers its raw fs error (EROFS/EACCES). Map it to the
			// read-only answer with the mount cause, so the editor locks
			// with the mount hint instead of showing the raw code, and
			// remember the verdict: the next GET locks the editor before
			// any edit.
			if (readOnlyMountError(w.error)) {
				if (path !== null) folderSaveVerdicts.set(path, "mount");
				return json(
					{
						error: "read-only: folder source",
						path,
						cause: "mount",
					},
					400,
				);
			}
			return json({ error: w.error }, w.status);
		}
		if (w.body.commit === "") {
			// Plain folder: alate wrote the bytes without a commit. Read-only
			// must not leave an uncommitted write in an unversioned folder, so
			// undo byte for byte with the hash the PUT gave us, and remember
			// the verdict for the next GET.
			folderSaveVerdicts.set(path ?? "", "plain");
			const back = await saveConfigYml(
				alate,
				f.content,
				hash,
				"chore: revert the uncommitted model roles save",
			);
			if (back.ok)
				return json({ error: "read-only: folder source", path }, 400);
			return json(
				{
					error: `read-only: folder source${path ? ` ${path}` : ""}: the save wrote the file without a commit and the undo failed (${back.error}), so the file holds the attempted roles`,
				},
				400,
			);
		}
		// A git folder saved: clear a stale verdict, so a folder that became
		// writable (or was never refused) keeps Save armed.
		if (path !== null) folderSaveVerdicts.delete(path);
		// No refresh here: alate imported the new file inside its PUT. `base`
		// stays null — a path source reports importedSha "" forever, so a
		// commit as base would 409 every later save.
		return json({
			commit: w.body.commit,
			base: null,
			hash,
			roles: readRoles(content),
			fallbacks: readFallbacks(content),
			seed: seedView(),
		});
	}

	// The commit's parent is the commit the user loaded, and the branch moves only
	// as a fast-forward: a commit on main at any time since the read gives 409.
	// Never retried: a refused write goes back to the user.
	async function saveRolesRepo(
		f: RolesSource,
		content: string,
		message: string,
	): Promise<Response> {
		const { repo, base: parent } = f;
		const w = await commitConfigYml(
			gh,
			repo as { name: string; ref: string },
			parent as string,
			content,
			message,
		);
		if (!w.ok) {
			if (w.status !== 409) return json({ error: w.error }, w.status);
			// The data repo moved: show the user its current roles.
			const again = await loadConfigYml(alate, true);
			if (!again.ok) return json({ error: again.error }, again.status);
			return json(
				{
					error:
						"the data repo changed while the roles saved; check the current roles and save again",
					base: again.body.base,
					hash: again.body.hash,
					roles: readRoles(again.body.content),
					fallbacks: readFallbacks(again.body.content),
				},
				409,
			);
		}
		const sha = w.body.commit;
		// The provision installs alate's snapshot, so alate must import the new commit.
		const imported = await refreshAlateSnapshot(alate);
		if (!imported.ok)
			return json(
				{
					error: `committed ${sha.slice(0, 7)} to the data repo, but alate did not import it: ${imported.error}`,
				},
				502,
			);
		// The answer describes the commit this save created, never the imported head:
		// a commit that lands on main after ours must reach the user as a conflict
		// on the next save, not as roles and a base that this save never wrote.
		return json({
			commit: sha,
			base: sha,
			hash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
			roles: readRoles(content),
			fallbacks: readFallbacks(content),
			seed: seedView(),
		});
	}

	async function prepareRolesSave(
		body: Record<string, unknown>,
	): Promise<
		{ content: string; message: string; source: RolesSource } | Response
	> {
		const parsed = validateModelRolesBody(body);
		if (parsed instanceof Response) return parsed;
		const { base, hash, roles, fallbacks } = parsed;
		// Re-import first: `base` must be the branch head, so any commit on main
		// since the read is a conflict. The check runs before validation, so a
		// stale form sees the current roles even when they already hold its values.
		const f = await loadConfigYml(alate, true);
		if (!f.ok) return json({ error: f.error }, f.status);
		const current = readRoles(f.body.content);
		const currentFallbacks = readFallbacks(f.body.content);
		if (f.body.base !== base || f.body.hash !== hash)
			return json(
				{
					error:
						"the data repo changed since you loaded the roles; check the current roles and save again",
					base: f.body.base,
					hash: f.body.hash,
					roles: current,
					fallbacks: currentFallbacks,
				},
				409,
			);
		const catalog = new Set(
			(await (deps.models ?? modelList)()).map((m) => m.selector),
		);
		// Without `fallbacks`, each requested role keeps its current chain.
		const fb: Record<string, unknown> =
			fallbacks === undefined
				? Object.fromEntries(
						Object.keys(roles as Record<string, unknown>)
							.filter((k) => Object.hasOwn(currentFallbacks, k))
							.map((k) => [k, currentFallbacks[k]]),
					)
				: (fallbacks as Record<string, unknown>);
		const bad = validateRoles(
			roles as Record<string, unknown>,
			current,
			catalog,
			fb,
			currentFallbacks,
		);
		if (bad !== null) return json(bad, 400);
		const next = roles as Record<string, string>;
		const nextFallbacks = fb as Fallbacks;
		const content = editModelRoles(f.body.content, next, nextFallbacks);
		const message = commitMessage(
			current,
			next,
			currentFallbacks,
			nextFallbacks,
		);
		return { content, message, source: f.body };
	}

	const routes = defineRoutes({
		// Dev: Bun's HTML dev server (import route, HMR). Prod: the boot-built bundle
		// from memory (docs/specs/compressed-serving.md). The fixed-path views serve the
		// same board HTML; the client routes on location.pathname.
		"/": devUi ? board : (req) => boardHtml(req),
		"/projects/:project": devUi ? board : (req) => boardHtml(req),
		"/projects/:project/tasks/:id": devUi ? board : (req) => boardHtml(req),
		"/settings": devUi ? board : (req) => boardHtml(req),
		"/system": devUi ? board : (req) => boardHtml(req),
		"/settings/:project": devUi ? board : (req) => boardHtml(req),
		// --- Web Push (begin): service worker for notifications; the sibling PWA branch adds its static routes here too ---
		"/sw.js": () =>
			new Response(Bun.file(resolve(import.meta.dir, "ui", "sw.js")), {
				headers: {
					"Content-Type": "application/javascript",
					// The worker re-registers per deploy and the browser must always re-check it.
					"Cache-Control": "no-cache",
				},
			}),
		// --- Web Push (end) ---
		"/manifest.webmanifest": {
			GET: () => pwaFile("/manifest.webmanifest"),
		},
		"/icon-192.png": { GET: () => pwaFile("/icon-192.png") },
		"/icon-512.png": { GET: () => pwaFile("/icon-512.png") },
		"/icon-512-maskable.png": {
			GET: () => pwaFile("/icon-512-maskable.png"),
		},
		"/workflow-task.svg": { GET: () => workflowFile("/workflow-task.svg") },
		"/workflow-review.svg": {
			GET: () => workflowFile("/workflow-review.svg"),
		},
		"/workflow-release.svg": {
			GET: () => workflowFile("/workflow-release.svg"),
		},
		"/git/*": (req, server) =>
			vmRoute(req, server, (tokens) =>
				handleGit(req, { tokens, log: (l) => console.log(`[vm-git] ${l}`) }),
			),
		"/llm/*": (req, server) =>
			vmRoute(req, server, (tokens) =>
				handleLlm(req, { tokens, gateway: deps.llmGateway?.() ?? null }),
			),
		// Read per request: Settings can change the Hindsight URL and key while the board runs.
		"/hindsight/*": (req, server) =>
			vmRoute(req, server, (tokens) =>
				handleHindsight(req, {
					tokens,
					url: process.env.HINDSIGHT_API_URL?.trim(),
					token: process.env.HINDSIGHT_API_TOKEN,
				}),
			),
		// The Diagrams modal loads mermaid's prebuilt bundle (~5.5 MB raw, ~1.2 MB brotli) on
		// first open, so the board's own bundle stays small: Bun's HTML bundler does not split a
		// dynamic import into a chunk. The bundle is content at a versioned path (its exact key
		// comes from src/mermaidVersion.ts; Bun's router has no mid-segment wildcard), so it
		// caches immutably for a year. The old unversioned path redirects (see mermaidResponse).
		[mermaidSrc]: {
			GET: (req: Request) => mermaidResponse(req),
		},
		"/mermaid.min.js": {
			GET: () =>
				new Response(null, {
					status: 301,
					headers: {
						Location: mermaidSrc,
						"Cache-Control": "public, max-age=86400",
					},
				}),
		},
		"/api/ws": (req, srv) => wsUpgrade(req, srv),
		"/api/boot": {
			// Through api() like every other route (R2-11): the Host allowlist must cover it, so
			// a DNS-rebinding page cannot read the version or whether onboarding is open.
			GET: (req) =>
				api(req, async () =>
					json({
						onboarding: deps.hosted === undefined && admin === null,
						version: deps.serverVersion,
						live: !prod,
						...(deps.hosted !== undefined && { hosted: true }),
					}),
				),
		},
		// Hosted credit stop (docs/specs/hosted-mode.md section 5): the control plane's call when the
		// tenant runs out of credit. hostedRefusal lets only a signed control identity reach it.
		"/api/hosted/stop": {
			POST: (req) => {
				if (deps.hosted === undefined)
					return Promise.resolve(json({ error: "not found" }, 404));
				return api(req, () => handlePOSTHostedStop());
			},
		},
		// Hosted credit release (docs/specs/hosted-mode.md section 5): the control plane's call after
		// a top-up. Same wall rule as stop: only a signed control identity reaches it.
		"/api/hosted/release": {
			POST: (req) => {
				if (deps.hosted === undefined)
					return Promise.resolve(json({ error: "not found" }, 404));
				return api(req, () => handlePOSTHostedRelease());
			},
		},
		// Hosted forwarded GitHub events (docs/specs/hosted-mode.md section 8): the control plane
		// verified GitHub's signature and forwards the event here, so the watches that would poll
		// GitHub on a self-hosted board kick only for the repo the event names. Same wall rule as
		// stop: hostedRefusal lets only a signed control identity reach it.
		"/api/hosted/github-event": {
			POST: (req) => {
				if (deps.hosted === undefined)
					return Promise.resolve(json({ error: "not found" }, 404));
				return api(req, () => hostedGithubEvent(req));
			},
		},
		"/api/setup": {
			POST: (req) => api(req, () => setup(req)),
		},
		"/api/login": {
			POST: (req, server) => api(req, () => login(req, server)),
		},
		"/api/logout": {
			// Open route: without a valid cookie it only clears the cookie, as before.
			POST: (req) => api(req, () => logout(req)),
		},
		"/api/settings/api-key": {
			GET: (req) => api(req, async () => json({ apiKey })),
			POST: (req) => api(req, () => handlePOSTSettingsApi()),
		},
		// Alate key reveal/rotate: GET hands back the stored key, POST asks alate to rotate
		// it (alate kills the old key immediately, so a failed save must hand the new key back).
		"/api/settings/alate-key": {
			GET: (req) => api(req, async () => secretJson({ apiKey: alate.key })),
			POST: (req) => api(req, () => handlePOSTSettingsAlate()),
		},
		// Rotation invalidates every signed session at once: the lost-device kill switch
		// (the plain logout below clears only the calling browser's cookie).
		"/api/settings/session-secret": {
			POST: (req) => api(req, () => handlePOSTSettingsSession()),
		},
		"/api/settings/sessions": {
			GET: (req) => api(req, () => handleGETSettingsSessions(req)),
		},
		"/api/settings/sessions/:id": {
			DELETE: (req) => api(req, () => handleDELETESettingsSessionsById(req)),
		},
		"/api/settings/github-token": {
			GET: (req) =>
				api(req, async () =>
					json({
						tokenSet: githubToken !== null || keptUnreadable.has("githubToken"),
						tokenReadable: githubToken !== null,
						expiresAt: loadReminders().board.expiresAt,
					}),
				),
			POST: (req) => api(req, () => handlePOSTSettingsGithub2(req)),
		},
		// Settings → GitHub → GitHub host. An empty host is the reset: the boot env value
		// comes back, or github.com when the env had none. A save re-probes the token so the
		// expiry notice follows the new host at once.
		"/api/settings/github-host": {
			POST: (req) => api(req, () => handlePOSTSettingsGithub(req)),
		},
		// Read-only GitHub tokens for turns (docs/specs/turn-read-token.md). No answer ever
		// holds a token value; a save runs the API check and stores its verdict, and only a
		// checked row (or a confirmed write-capable one) is served to turns.
		"/api/settings/turn-github-token": {
			GET: (req) => api(req, async () => json(turnReadTokenView())),
			POST: (req) => api(req, () => handlePOSTSettingsTurnToken(req)),
		},
		"/api/settings/turn-github-token/confirm": {
			POST: (req) => api(req, () => handlePOSTSettingsTurnTokenConfirm(req)),
		},
		"/api/settings/turn-github-token/recheck": {
			POST: (req) => api(req, () => handlePOSTSettingsTurnTokenRecheck(req)),
		},
		// Env values, one per env.txt name. A secret answer never holds its value; a plain
		// name (env.txt `plain`) answers with it. A re-save replaces it (no delete).
		"/api/settings/env": {
			GET: (req) =>
				api(req, async () =>
					json({
						names: listedEnvNames(workersHome).map((row) =>
							row.plain
								? {
										...row,
										set: deps.shared.envPlain[row.name] !== undefined,
										readable: true,
										value: deps.shared.envPlain[row.name] ?? null,
									}
								: {
										...row,
										set:
											deps.shared.envValues[row.name] !== undefined ||
											keptUnreadable.has(`env:${row.name}`),
										readable: deps.shared.envValues[row.name] !== undefined,
									},
						),
					}),
				),
			POST: (req) => api(req, () => handlePOSTSettingsEnv(req)),
		},
		// Per-host git tokens (any host, GitHub included). No answer ever holds a token
		// or a private key; every saved credential passed a live test first.
		"/api/git-hosts": {
			GET: (req) => api(req, async () => json(await gitHostsView())),
		},
		"/api/git-hosts/tokens": {
			POST: (req) => api(req, () => handlePOSTGitTokens(req)),
		},
		// The board GitHub token only becomes a git-host entry through this explicit
		// endpoint — never reused for git without the click.
		"/api/git-hosts/github-token": {
			POST: (req) => api(req, () => handlePOSTGitGithub2(req)),
		},
		"/api/git-hosts/tokens/:host": {
			DELETE: (req) => api(req, () => handleDELETEGitTokensByHost(req)),
		},
		"/api/git-hosts/ssh/pending": {
			POST: (req) => api(req, () => handlePOSTGitSshPending(req)),
		},
		"/api/git-hosts/ssh/test": {
			POST: (req) => api(req, () => testSshKey(req)),
		},
		"/api/git-hosts/ssh/global": {
			PUT: (req) => api(req, () => handlePUTGitSshGlobal(req)),
			DELETE: (req) => api(req, () => handleDELETEGitSshGlobal()),
		},
		// The GitHub App that posts PR reviews as ottr[bot]. No answer holds the key.
		"/api/git-hosts/github-app": {
			POST: (req) => api(req, () => handlePOSTGitGithub(req)),
			DELETE: (req) => api(req, () => handleDELETEGitGithub()),
		},
		"/api/projects/:project/ssh-key": {
			GET: (req) => api(req, () => handleGETProjectsSshByProject(req)),
			PUT: (req) => api(req, () => handlePUTProjectsSshByProject(req)),
			DELETE: (req) => api(req, () => handleDELETEProjectsSshByProject(req)),
		},
		"/api/settings/omp-stats": {
			GET: (req) => api(req, async () => json(await ompStatsReportNow())),
		},
		"/api/settings/omp-stats/dashboard": {
			GET: (req) => api(req, async () => json(ompStatsListener)),
		},
		"/api/settings/hindsight": {
			GET: (req) => api(req, async () => json(hindsightView())),
			POST: (req) => api(req, () => saveHindsight(req)),
		},
		// --- Web Push (begin) ---
		"/api/push/config": {
			GET: (req) => api(req, () => handleGETPushConfig(req)),
		},
		"/api/push/subscribe": {
			POST: (req) => api(req, () => handlePOSTPushSubscribe(req)),
		},
		"/api/push/unsubscribe": {
			POST: (req) => api(req, () => handlePOSTPushUnsubscribe(req)),
		},
		"/api/push/test": {
			POST: (req) => api(req, () => handlePOSTPushTest()),
		},
		// --- Web Push (end) ---
		// The service worker's authority before it shows or keeps a notification: per class,
		// how many alerts this device still has live (unanswered, unacknowledged) and the
		// sequence number of the last alert sent to it. A delayed, resolved or superseded
		// payload reads as stale here, however the pushes were ordered.
		"/api/notifications/live": {
			GET: (req) => api(req, () => handleGETNotificationsLive(req)),
		},
		"/api/notifications/prefs": {
			GET: (req) => api(req, () => notificationPrefs(req)),
			POST: (req) => api(req, () => saveNotificationPrefs(req)),
		},
		"/api/presence": {
			POST: (req) => api(req, () => presence(req)),
		},
		"/api/inbox/seen": {
			GET: (req) => api(req, async () => json({ keys: loadInboxSeen() })),
			POST: (req) => api(req, () => inboxSeen(req)),
		},
		"/api/seen": {
			POST: (req) => api(req, () => handlePOSTSeen(req)),
		},
		"/api/models": {
			GET: (req) =>
				api(req, async () =>
					json({ models: await modelList(), roles: modelRoles() }),
				),
		},
		"/api/state": {
			GET: (req) => api(req, async () => json(stateResponse())),
		},
		"/api/orphans": {
			GET: (req) => api(req, () => handleGETOrphans()),
		},
		"/api/orphans/stop": {
			POST: (req) => api(req, () => handlePOSTOrphansStop(req)),
		},
		"/api/system": {
			GET: (req) => api(req, () => handleGETSystem()),
		},
		"/api/performance": {
			GET: (req) => api(req, () => handleGETPerformance(req)),
		},
		"/api/gh-status": {
			GET: (req) => api(req, () => handleGETGh(req)),
		},
		"/api/projects/order": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsOrder(req), { costly: true }),
		},
		"/api/projects": {
			// OTTR-715: a clone-on-add request runs a real `git clone` that can stay quiet
			// past the 120 s idle cut (see vmRoute): lift it for this request before readJson.
			POST: (req, server) => {
				server.timeout(req, 0);
				return api(req, () => handlePOSTProjects(req), { costly: true });
			},
		},
		"/api/projects/:project/init": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsInitByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/interview": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsInterviewByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/remove": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsRemoveByProject(req), {
					costly: true,
				}),
		},
		"/api/settings": {
			POST: (req) => api(req, () => handlePOSTSettings(req)),
		},
		// Settings → "Scan trending now": the weekly trending scan, run at once. Body optional.
		"/api/trending/scan": {
			POST: (req) => api(req, () => handlePOSTTrendingScan(), { costly: true }),
		},
		// The update script holds new turns here while a new image waits, so the running turns
		// finish and the restart finds the board idle (docs/WORKERS.md, "Updates").
		// OTTR-454 adds per-runner holds on the same route: the script rolls one runner at a
		// time and the others keep working. A per-runner hold never touches the board-wide
		// state or the notice bar.
		"/api/drain": {
			GET: (req) => api(req, () => handleGETDrain()),
			POST: (req) => api(req, () => handlePOSTDrain(req)),
			DELETE: (req) => api(req, () => handleDELETEDrain(req)),
		},
		"/api/alate": {
			GET: (req) => api(req, async () => json(alateView())),
			POST: (req) => api(req, () => handlePOSTAlate(req)),
		},
		"/api/alate/health": {
			GET: (req) => api(req, () => handleGETAlateHealth()),
		},
		"/api/alate/provision": {
			POST: (req) => api(req, () => handlePOSTAlateProvision()),
		},
		// Read-only view of the alate integration and the workers' provisioned lists.
		"/api/provisioning": {
			GET: (req) => api(req, () => handleGETProvisioning()),
		},
		"/api/model-roles": {
			GET: (req) =>
				api(req, () =>
					layout422(async () => {
						const f = await loadConfigYml(alate, false);
						if (!f.ok) return json({ error: f.error }, f.status);
						return json({
							base: f.body.base,
							hash: f.body.hash,
							roles: readRoles(f.body.content),
							fallbacks: readFallbacks(f.body.content),
							// The data source: repo for Alate's GitHub source, path for a
							// local folder.
							repo: f.body.repo,
							path: f.body.path,
							// A folder the board saw refuse a save locks the editor on
							// load, before any edit; null until such a save.
							ro: folderSaveVerdict(f.body.path),
							// One sign-in, on the board (docs/specs/provider-credentials.md): the
							// board store's active providers; null when it cannot be read.
							signIns: (() => {
								try {
									return signIns()
										.filter((a) => a.active)
										.map((a) => a.provider);
								} catch {
									return null;
								}
							})(),
							seed: seedView(),
						});
					}),
				),
			POST: (req) =>
				api(req, () =>
					layout422(async () => {
						const r = await readJson(req);
						if ("error" in r) return r.error;
						const prep = await prepareRolesSave(r.body);
						if (prep instanceof Response) return prep;
						if (prep.source.repo === null || prep.source.base === null)
							return saveRolesFolder(prep.source, prep.content, prep.message);
						return saveRolesRepo(prep.source, prep.content, prep.message);
					}),
				),
		},
		"/api/updates/refresh": {
			POST: (req) => api(req, () => handlePOSTUpdatesRefresh()),
		},
		"/api/updates/skip": {
			POST: (req) => api(req, () => handlePOSTUpdatesSkip(req)),
		},
		"/api/updates/allow": {
			POST: (req) => api(req, () => allowUpdates(req)),
		},
		"/api/updates/remove": {
			POST: (req) => api(req, () => handlePOSTUpdatesRemove(req)),
		},
		"/api/provider-login": {
			GET: (req) => api(req, () => handleGETProvider()),
			POST: (req) => api(req, () => handlePOSTProvider(req)),
		},
		"/api/provider-login/answer": {
			POST: (req) => api(req, () => handlePOSTProviderAnswer(req)),
		},
		"/api/provider-login/cancel": {
			POST: (req) => api(req, () => handlePOSTProviderCancel(req)),
		},
		"/api/provider-login/logout": {
			POST: (req) => api(req, () => handlePOSTProviderLogout(req)),
		},
		"/api/update": {
			GET: (req) => api(req, () => handleGETUpdate()),
			POST: (req) => api(req, () => handlePOSTUpdate(req)),
		},
		"/api/update/host": {
			POST: (req) => api(req, () => handlePOSTUpdateHost(req)),
		},
		"/api/projects/:project/icon": {
			GET: (req) => api(req, () => handleGETProjectsIconByProject(req)),
			POST: (req) => api(req, () => handlePOSTProjectsIconByProject(req)),
			DELETE: (req) => api(req, () => handleDELETEProjectsIconByProject(req)),
		},
		"/api/projects/:project/settings": {
			POST: (req) => api(req, () => handlePOSTProjectsSettingsByProject(req)),
		},
		"/api/jira/connections": {
			GET: (req) => api(req, () => jira.list()),
			POST: (req) => api(req, () => jiraPost(req, jira.save)),
		},
		"/api/jira/connections/:name": {
			DELETE: (req) => api(req, () => jira.remove(req.params.name)),
		},
		"/api/jira/connections/:name/test": {
			POST: (req) => api(req, () => jira.test(req.params.name)),
		},
		"/api/jira/detect": {
			POST: (req) => api(req, () => jiraPost(req, jira.detect)),
		},
		"/api/jira/search": {
			POST: (req) => api(req, () => jiraPost(req, jira.boardSearch)),
		},
		"/api/jira/import": {
			POST: (req) =>
				api(req, () => jiraPost(req, jira.boardImport), {
					costly: true,
				}),
		},
		"/api/projects/:project/jira/search": {
			POST: (req) =>
				api(req, () =>
					jiraPost(req, (b) => jira.search(req.params.project, b)),
				),
		},
		"/api/projects/:project/jira/import": {
			POST: (req) =>
				api(
					req,
					() => jiraPost(req, (b) => jira.importIssues(req.params.project, b)),
					{ costly: true },
				),
		},
		// Board "Push to origin" (OTTR-531): the standing-approval push, the exact
		// authenticated path the merge flow uses. Moves refs/heads/<target> on origin only;
		// never depends on the checked-out branch, never forces.
		"/api/projects/:project/push-main": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsPushByProject(req), {
					costly: true,
				}),
		},
		// The board's Diagrams button: docs/how-it-works.md as committed on the target branch.
		"/api/projects/:project/how-it-works": {
			GET: (req) => api(req, () => handleGETProjectsHowByProject(req)),
		},
		"/api/projects/:project/release": {
			GET: (req) => api(req, () => handleGETProjectsReleaseByProject(req)),
			POST: (req) =>
				api(req, () => handlePOSTProjectsReleaseByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/release-summary": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsReleaseSummaryByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/arch-review": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsArchByProject(req), {
					costly: true,
				}),
		},
		// The dev-only Check the board button: files the card that runs the check-ottr-board
		// skill in the server's own container (turn.ts keeps it off the workers).
		"/api/projects/:project/board-check": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsBoardByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/queue": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsQueueByProject(req), {
					costly: true,
				}),
		},
		// The composer's opt-in Deepen: a model rewrites the draft; the user accepts before anything runs.
		"/api/projects/:project/deepen": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsDeepenByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksByProject(req), {
					costly: true,
				}),
		},
		// The trending scout's two tools (extension/tracker.ts): "filed" files a backlog proposal
		// card (at most TRENDING_CAP per scan, the store enforces it), no_fit and deferred record
		// the verdict. The turns' host reaches it with the board token like card filing (agentRefusal).
		"/api/projects/:project/trending/verdicts": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTrendingVerdictsByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id": {
			GET: (req) => api(req, () => handleGETProjectsTasksByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/files": {
			GET: (req) =>
				api(req, () => handleGETProjectsTasksFilesByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/saved-files": {
			GET: (req) =>
				api(req, () => handleGETProjectsTasksSavedFilesByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/diff": {
			GET: (req) =>
				api(req, () => handleGETProjectsTasksDiffByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/images/:name": {
			GET: (req) =>
				api(req, () => handleGETProjectsTasksImagesByProjectAndIdAndName(req)),
		},
		"/api/projects/:project/tasks/:id/edit": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksEditByProjectAndId(req)),
		},
		// The prompt-edit hold: while a drawer has the editor open, the card must not start —
		// a scheduler tick would run the saved prompt and strand the unsaved draft (a started
		// card can never be edited again). start claims PROMPT_EDIT_HELD (no heartbeat: hidden
		// tabs throttle timers); every editor close posts stop, a save clears the hold in the
		// store's editTask, and every queue write below clears it, so a user action never
		// stalls behind a hold whose editor died silently.
		"/api/projects/:project/tasks/:id/edit/start": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksEditStartByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/edit/stop": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksEditStopByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/triage": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksTriageByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/log": {
			GET: (req) =>
				api(req, () => handleGETProjectsTasksLogByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/context": {
			GET: (req) =>
				api(req, () => handleGETProjectsTasksContextByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/reply": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksReplyByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/merge-anyway": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksMergeByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/rerun-failed-jobs": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksRerunByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/follow-up": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksFollowByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/steer": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksSteerByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/steer/cancel": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksSteerCancelByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/steer/edit": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksSteerEditByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/model": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksModelByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/star": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksStarByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/restart-session": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksRestartByProjectAndId(req), {
					costly: true,
				}),
		},
		// Parked backlog cards: a grill session refines the prompt, promote moves it to todo.
		"/api/projects/:project/tasks/:id/grill": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksGrillByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/backlog": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksBacklogByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/cancel": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksCancelByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/refile": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksRefileByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/stop": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksStopByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/finish-kept": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksFinishByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/forks/check": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsForksCheckByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/prs/check": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsPrsCheckByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/tasks/:id/pr-review/post": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksPrPostByProjectAndId(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/github": {
			GET: (req) =>
				api(req, () => handleGETProjectsGithubByProject(req), {
					costly: true,
				}),
		},
		"/api/projects/:project/github/visibility": {
			GET: (req) =>
				api(req, () => handleGETProjectsGithubVisibilityByProject(req)),
		},
		"/api/projects/:project/tasks/:id/unmark-research": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksUnmarkByProjectAndId(req)),
		},
		"/api/projects/:project/tasks/:id/release-notes": {
			POST: (req) =>
				api(req, () => handlePOSTProjectsTasksReleaseByProjectAndId(req)),
		},
	});

	/**
	 * OTTR-715: the route pattern matching a request path (`/api/p/x/tasks/7` ->
	 * `/api/p/:project/tasks/:id`), for the slow-request log: patterns keep ids and query
	 * values out of the board log. A pattern matches on equal segment counts, a `:` segment
	 * matching any non-empty segment and the rest literally; the pattern with the most
	 * literal segments wins (ties: first in routes order); none matches keeps the raw
	 * pathname. Callers pass pathname only, so a query string never enters here.
	 */
	function patternMatches(pattern: string, parts: string[]): number | null {
		const segments = pattern.split("/");
		if (segments.length !== parts.length) return null;
		let literals = 0;
		for (const [i, segment] of segments.entries()) {
			const part = parts[i];
			if (segment.startsWith(":")) {
				// A param segment matches any non-empty path segment.
				if (part === "") return null;
			} else if (segment === part) {
				literals++;
			} else {
				return null;
			}
		}
		return literals;
	}

	function routePattern(pathname: string): string {
		const parts = pathname.split("/");
		let best: string | null = null;
		let bestLiterals = -1;
		for (const pattern of Object.keys(routes)) {
			const literals = patternMatches(pattern, parts) ?? -1;
			// Strict > keeps the earlier pattern on a literal-count tie.
			if (literals > bestLiterals) {
				best = pattern;
				bestLiterals = literals;
			}
		}
		return best ?? pathname;
	}

	return {
		serveOptions: {
			routes,
			// Bun closes an idle connection after 10 s — in-flight requests included — so a
			// route that waits on a person or a slow spawn (alate provision,
			// clone, cancel) died with a connection reset past 10 s. Every json() response
			// sends Connection: close, so the raised ceiling holds no keep-alive sockets open.
			idleTimeout: 120,
			// A provider's sign-in redirect to localhost:<port> lands here when compose publishes that
			// port to the board; anything else stays a 404.
			fetch: async (req: Request) =>
				(await logins.callback(req)) ??
				(await boardAsset(req)) ??
				json({ error: "not found" }, 404),
			websocket: {
				open(ws: ServerWebSocket<undefined>) {
					// Increment BEFORE publishState so this socket is either in the publish or sent the frame.
					sockets++;
					ws.subscribe("board");
					if (!publishState()) ws.send(lastStateJson);
					ws.send(
						JSON.stringify({
							type: "update",
							...effectiveUpdate(),
						} satisfies ServerMessage),
					);
					if (lastSystemJson !== null) ws.send(lastSystemJson);
				},
				// Push-only: inbound frames are never parsed.
				message() {},
				close() {
					sockets--;
				},
			},
		},
		serverRef: deps.serverRef,
		ompStatsFetch,
		/** The proxy listener's bind result; a failed bind passes { port: null, error }. */
		setOmpStatsListener: (info: OmpStatsDashboardInfo): void => {
			ompStatsListener = info;
		},
		publish,
		publishState,
		publishSoon,
		notifyLog,
		drained: () =>
			Date.now() < Math.max(drainUntil, updateCycle.holdUntil(Date.now())),
		// OTTR-465: the credential kinds the server's git can use for a push to a URL, for the
		// card log; never a value. A missing App installation on a repo shows as a permission
		// failure, and this line is what names the installation token the push went out with.
		// Hosted mode: git goes out with the per-project token the control plane mints, never
		// a board-global token, helper or key; hooks.gitToken may answer none, so the line
		// names that credential only where the project has one.
		pushAuthKind: (url: string): string | null => {
			if (deps.hosted === undefined)
				return pushAuthKind(url, {
					tokens: gitTokens,
					ambientHelpers,
					key: existsSync(sshPaths(sshDir).global),
					envToken: process.env.GH_TOKEN ?? null,
					githubHost: githubHost().host,
					boardTokenHost: boardGitToken()?.host ?? null,
				});
			const remote = parseGitUrl(url);
			if ("error" in remote) return null;
			return remote.scheme === "https"
				? "the control-plane token for the project, when it has one"
				: "no credential the board knows of";
		},
		// The git 401/403 hint for the merge push and the origin fetches on the card: same
		// inputs as pushAuthKind, one line under git's error, never a value. Hosted mode has no
		// board-global token to probe with, so it gives no hint and makes no request.
		githubAuthHint: (url: string): Promise<string | null> =>
			deps.hosted !== undefined
				? Promise.resolve(null)
				: githubAuthHint(url, {
						configuredHost: githubHost().host,
						tokens: gitTokens,
						envToken: process.env.GH_TOKEN ?? null,
						secrets: gitSecrets(),
						fetchImpl: deps.githubAuthProbe?.fetchImpl,
						timeoutMs: deps.githubAuthProbe?.timeoutMs,
					}),
		// OTTR-454: a per-runner hold gates new turns on one runner only.
		drainedRunner: (id: string) =>
			Date.now() <
			Math.max(runnerDrains.get(id) ?? 0, updateCycle.holdUntil(Date.now())),
		// OTTR-876: the read-only GitHub token a turn may hold, or null — the served rule
		// (docs/specs/turn-read-token.md); the turn loop asks it at every turn start.
		turnReadToken,
		// OTTR-754: the /tmp free-space warning phrase for this runner ("local" or a worker
		// hostname), or null when space is fine or unknown; the turn start gate holds on it.
		tmpFullLine: (runner: string): string | null => {
			const space =
				runner === "local"
					? tmpDiskSpace()
					: (workerSignInReports.get(runner)?.tmp ?? null);
			if (space === null || !tmpFull(space.freeBytes, space.totalBytes))
				return null;
			return `/tmp of ${runner} is full (${formatBytes(space.freeBytes)})`;
		},
		// OTTR-754: the free space itself, for an apt disk-failure reason; known space
		// always reports, so a recovered sweep still explains the failure it caused.
		tmpSpaceLine: (runner: string): string | null => {
			const space =
				runner === "local"
					? tmpDiskSpace()
					: (workerSignInReports.get(runner)?.tmp ?? null);
			return space === null
				? null
				: `/tmp of ${runner} has ${formatBytes(space.freeBytes)} free`;
		},
		socketCount: () => sockets,
		sampleStats,
		alateProvisionTick,
		idleReviewTick,
		trendingTick: () => trendingScanner.tick(),
		memoryHealthTick,
		workerSignInTick,
		refreshUpdates,
		tokenReminderTick,
		forkResearchTick: (opts?: { manual?: string }) => forkWatcher.tick(opts),
		prReviewTick: (opts?: { manual?: string }) => prWatcher.tick(opts),
		prReviewIdle: () => prWatcher.reviewIdle(),
		issueWatchTick: (opts?: { manual?: string }) => issueWatcher.tick(opts),
		ompWatchTick: () => ompWatcher.tick(),
	};
}
