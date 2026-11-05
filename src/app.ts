// Ottr: request-serving half of the tracker — HTTP routes, board state push, stats.
// All mutable request state lives in createApp's closure, so two instances never share state.
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Serve, Server, ServerWebSocket } from "bun";
import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import {
	alateHealth,
	commitConfigYml,
	loadConfigYml,
	noRedirectFetch,
	refreshAlateSnapshot,
} from "./alate.ts";
import { aptListPath, workerProjects } from "./apt.ts";
import {
	addSession,
	clearSessionCookie,
	dropSession,
	hashPassword,
	LoginLimiter,
	newSecret,
	newSessionId,
	parseCookies,
	SESSION_COOKIE,
	SESSION_MS,
	type SessionEntry,
	secretsEqual,
	sessionCookie,
	sessionLabel,
	signSession,
	verifyAdminLogin,
	verifySession,
} from "./auth.ts";
import { openRegular, unlinkBelow, writeBelow } from "./confine.ts";
import { logError } from "./crash.ts";
import { deepenDraft } from "./deepen.ts";
import { errmsg } from "./errmsg.ts";
import type { SpawnFn } from "./forkAnalysis.ts";
import {
	createForkWatcher,
	forkSummary,
	type GhFn,
	listForks,
} from "./forks.ts";
import {
	checkHostKey,
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
	setGitSecrets,
	sshPaths,
	type TrustNeeded,
	testRemote,
} from "./gitHosts.ts";
import {
	AppTokenSource,
	appCheckWarning,
	checkAppInstalls,
	parseAppPem,
	validateAppCredentials,
} from "./githubApp.ts";
import {
	DEFAULT_GITHUB_HOST,
	GITHUB_HOST_ENV,
	githubHost,
	parseGithubHost,
} from "./githubHost.ts";
import type { GlobalStore } from "./globalStore.ts";
import {
	decodeImages,
	MAX_IMAGE_BYTES,
	saveImages,
	sniffImage,
} from "./images.ts";
import { rebuildLayerUse } from "./layers.ts";
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
import { STATS_KEEP_MS, type StatsSample, statsFrame } from "./machineStats.ts";
import {
	checkMemoryHealth,
	type MemoryHealth,
	memoryBackendFromEnv,
} from "./memory.ts";
import {
	commitMessage,
	editModelRoles,
	RolesLayoutError,
	readRoles,
	validateRoles,
} from "./modelRoles.ts";
import { type ModelOption, modelList, modelRoles } from "./models.ts";
import {
	type OrphanProject,
	orphanCache,
	orphanView,
	summarizeCmd,
} from "./orphans.ts";
import { perfMetrics } from "./perf.ts";
import { type ProcessInfo, platform } from "./platform/index.ts";
import { mergeProjectOrder, rankInOrder } from "./projectOrder.ts";
import {
	BOARD_CHECK_PROMPT,
	followUpPrompt,
	handoffMarkdown,
	LOST_SESSION,
	releasePrompt,
	reviewPrompt,
	rulesInterviewPrompt,
	workCheckSendBack,
} from "./prompts.ts";
import { createPrWatcher, prUrl } from "./prs.ts";
import { requirementsListPath } from "./python.ts";
import { fetchQuota } from "./quota.ts";
import {
	includedTasks,
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
	findingsSettledAt,
	isRetro,
	isReview,
	lastReviewBase,
	liveCard,
	mergeAnywayPatch,
	openWorkBlockers,
	type ReviewTask,
	releaseHeldMerges,
	reviewBlocked,
	reviewFindings,
	silentSince,
	WORK_CHECK_ASK_MERGE,
	WORK_CHECK_ASK_SEND_BACK,
	WORK_CHECK_THIRD_BLOCK,
} from "./scheduler.ts";
import { sessionContext } from "./session.ts";
import { derivedTaskPrefix, ProjectStore } from "./store.ts";
import {
	ENV_NAME,
	envListPath,
	layerHome,
	listedEnvNames,
	toolsListPath,
} from "./tools.ts";
import {
	type CancelOutcome,
	type FinishKeptOutcome,
	FORK_HOLD_REASON,
	isKeptReason,
	logStoreError,
	MERGE_HOLD_MISMATCH_REASON,
	type StopOutcome,
	type TurnProject,
	UPDATE_HOLD_REASON,
} from "./turn.ts";
import {
	APPROVE_REPLY,
	type AppCheck,
	answeredCard,
	type MachineStats,
	type OrphanProcess,
	type PerfRange,
	PRIORITIES,
	type Priority,
	type ProjectSettings,
	type ProjectView,
	type ProvisioningResponse,
	type QuotaState,
	REVIEW_BODY_MAX,
	REVIEW_FOOTER,
	recommendsSteps,
	type ServerMessage,
	type StateResponse,
	type Task,
	type TaskCard,
	type TaskView,
	type UpdateRecord,
	type UpdatesView,
	VERSION_RE,
} from "./types.ts";
import board from "./ui/index.html";
import {
	addSkip,
	loadSkips,
	mapRepo,
	migratePendingToSkips,
	planUpdatesPush,
	removePrompt,
	type UpdatesPushState,
	updatePrompt,
	validateUpdates,
} from "./updates.ts";
import {
	diffAlerts,
	loadSubs,
	PUSH_SUBJECT,
	payloadsFor,
	pruneSubs,
	saveSubs,
	sendAll,
} from "./webpush.ts";
import {
	archReviewDelta,
	diffStat,
	diffText,
	git,
	githubUrl,
	hasRules,
	isGitRepoWithCommit,
	originRemoteUrl,
	remoteUrl,
	resolveTarget,
	setNetworkGitAuth,
	statusFiles,
	validateCopyPath,
} from "./worktree.ts";

const MAX_BODY_BYTES = 65536;

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
 * with a retro child suffix `-retro[-k]`. One constant, so resolveTask and /api/seen cannot
 * drift apart. */
const TASK_ID_RE =
	/^(?:[0-9a-f]{8}|[A-Z0-9]{1,8}-[0-9]+)(?:-retro(?:-[0-9]+)?)?$/;
/** How long one POST /api/drain holds new turns. scripts/update-image.ts renews it every 30 s
 * while it waits, so a hold that the script stops renewing lapses on its own. DELETE ends it
 * at once: the script does that when its 1 h limit ends the wait. */
const DRAIN_MS = 30 * 60_000;

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

interface AppDeps {
	gstore: GlobalStore;
	/** gh CLI seam; defaults to runGh. Tests inject a stub for the /github route. */
	gh?: GhFn;
	/** Deepen seam for the composer route; defaults to deepenDraft (one gateway call). Tests inject a stub so no spawn happens. */
	deepen?: (prompt: string, model: string | null) => Promise<string>;
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
	/** Live progress of the task's running turn (TaskCard.progress); absent in tests. */
	progressOf?(project: string, id: string): string | null;
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
		removedPaths: string[];
		projectPaths: string[];
		/** Project names in board order; names not listed keep discovery order after them. */
		projectOrder: string[];
		/** Secret env values from Settings, one per env.txt name; the only copy. Stored plaintext
		 * in the config file like githubToken (same trust level), never served back after save.
		 * The turn loop reads it for redaction and env seeding. */
		envValues: Record<string, string>;
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
	/** Server-only ssh key + known_hosts dir; no worker mounts it. */
	sshDir?: string;
	/** Base home of the env.txt name lists (<home>/.ottr/workers); defaults to boardOmpHome() (R5-1). */
	workersHome?: string;
	/** ssh-keyscan seam for the host-key check; defaults to realKeyscan. Tests inject a stub. */
	keyscan?: Keyscan;
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
	 * Fetch seam for the GitHub App installation-token mint and the direct review post;
	 * defaults to noRedirectFetch. Tests inject a stub.
	 */
	githubAppFetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Gateway spawn seam for the release-summary model call; defaults to the real spawn. Tests inject a stub. */
	releaseSummarySpawn?: SpawnFn;
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
	tasks: readonly (ReviewTask & Pick<Task, "state" | "project">)[] = [],
	now: number = Date.now(),
): string[] {
	if (!existsSync(join(agentDir(), "config.yml")))
		return [
			'The board\'s agent layer is not seeded: the board runs without rules and config.yml until a seed fills /etc/ottr/home (docs/WORKERS.md, "Seed the board config").',
		];
	// Roles are unreadable without config.yml, so the unseeded warning replaces the rest.
	const active = new Set(list.filter((s) => s.active).map((s) => s.provider));
	const named = new Set(deadSignIns(list, roles).map((d) => d.provider));
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
	// A release parked on finished findings still holds every other merge (mergeHold): warn
	// once the stall passes an hour, so the next step stays visible on the board. mergeHold
	// compares versions within one project, so the loop runs per project, never on the
	// flat cross-project list.
	const byProject = new Map<
		string,
		(ReviewTask & Pick<Task, "state" | "project">)[]
	>();
	for (const t of tasks) {
		const group = byProject.get(t.project);
		if (group === undefined) byProject.set(t.project, [t]);
		else group.push(t);
	}
	for (const group of byProject.values()) {
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
	}
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

export function createApp(deps: AppDeps) {
	const gh = deps.gh ?? runGh;
	// GitHub App mint and review post; the seam keeps both off the real network in tests.
	const githubAppFetch = deps.githubAppFetch ?? noRedirectFetch;
	// Idle clock (docs/specs/mutation-delta.md §7): only the idle-review logic reads it,
	// and tests inject a fixed clock. It initializes at createApp, so a board restart
	// counts as input and never starts a review right after boot.
	const now = deps.now ?? Date.now;
	let lastInputAt = now();
	const prod = deps.prod === true;
	// Server-only ssh material: a data dir outside every checkout.
	const sshDir = deps.sshDir ?? defaultSshDir();
	// Base home whose .ottr/workers folders hold the env.txt name lists: the board's
	// server-only home, never the turn-writable shared one (R5-1; tests inject it).
	const workersHome = deps.workersHome ?? boardOmpHome();
	const keyscan = deps.keyscan ?? realKeyscan;
	const ambientHelpers = readAmbientHelpers();
	// Boot reconcile (docs/specs/agent-layer-switch.md, "Record"): the stores' open turns
	// (turn rows without ended_at) decide which layer folders stay registered as in use,
	// so alate's clean-up never deletes a layer a crashed-but-live turn reads. Fail-soft:
	// a broken store or registry only degrades clean-up, it never breaks the boot.
	try {
		reconcileLayerUse(
			[...deps.projects.values()].flatMap((e) => e.store.listOpenTurnLayers()),
		);
	} catch (err) {
		console.warn(`layers: in-use reconcile failed: ${errmsg(err)}`);
	}
	/** Sorted task ids marked as read; missing/corrupt row = empty. */
	function loadSeen(): string[] {
		const parsed: unknown = deps.gstore.get<unknown>("seen_answers");
		if (!Array.isArray(parsed)) return [];
		return [
			...new Set(parsed.filter((s): s is string => typeof s === "string")),
		].sort();
	}

	function saveSeen(ids: string[]): void {
		deps.gstore.set("seen_answers", [...new Set(ids)].sort());
	}

	/** OTTR-488: card-view steps — the stored value, except legacy 'unknown' rows resolve against the stored report at read time (no row rewrite). 'unknown' in a view means quiet. */
	function viewSteps(t: Pick<Task, "steps" | "report">): Task["steps"] {
		return t.steps !== "unknown"
			? t.steps
			: t.report !== null && recommendsSteps(t.report)
				? "yes"
				: "unknown";
	}

	/** Ids of the cards a read mark can stick to right now, by the same rule the state frame
	 * ships (stateResponse): question-only answered cards, pr_review cards, and done research
	 * cards whose report resolves to a steps value. Marks a client
	 * sends for anything else are stale — a pre-server-sync tab imported marks for cards it merely
	 * had open — so /api/seen drops them and the store decays instead of poisoning the board. */
	function seenableIds(): Set<string> {
		const ids = new Set<string>();
		for (const e of deps.projects.values()) {
			try {
				for (const t of e.store.listTasks()) {
					if (
						t.cancelledAt === null &&
						(t.kind === "pr_review" ||
							(t.stage === "done" &&
								!isRetro(t) &&
								answeredCard(e.store.listTurns(t.id))) ||
							(t.research &&
								t.stage === "done" &&
								t.report !== null &&
								viewSteps(t) !== "unknown"))
					)
						ids.add(t.id);
				}
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
			saveConfig();
		}
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
	/** Fire-and-forget push to every subscriber; prunes 404/410 subs. Never throws into the publish path. */
	/** Done-channel push count; reset when a board tab opens, i.e. the user has looked. */
	let pushDoneCount = 0;
	function pushNeedsYou(
		prev: Array<{
			id: string;
			state: string;
			stage: string;
			prompt?: string;
		}> | null,
		next: Array<{
			id: string;
			state: string;
			stage: string;
			prompt?: string;
			summary: string | null;
			project: string;
			title: string;
			needsReason: string | null;
			sessionTitle: string | null;
		}>,
	): void {
		const fired = diffAlerts(prev, next);
		if (fired.length === 0) return;
		const byId = new Map(next.map((t) => [t.id, t]));
		const cards = fired.flatMap((f) => {
			const c = byId.get(f.id);
			return c ? [c] : [];
		});
		const subs = loadSubs(deps.gstore);
		if (cards.length === 0 || subs.length === 0) return;
		ensureVapid();
		pushDoneCount += cards.filter((c) => c.state !== "needs_you").length;
		const needsYouTotal = next.filter((t) => t.state === "needs_you").length;
		void Promise.all(
			payloadsFor(cards, needsYouTotal, pushDoneCount).map((payload) =>
				sendAll(subs, JSON.stringify(payload), (sub, p) =>
					sendNotification(sub, p),
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

	/** Single admin (set by /api/setup): null means the board is in onboarding. Loopback never checks it. */
	let admin: { name: string; passHash: string } | null = null;
	let apiKey: string | null = null;
	let sessionSecret: string | null = null;
	/** Login registry; one entry per signed-in browser, see docs/specs/session-registry.md. */
	let sessions: SessionEntry[] = [];
	// Login failures: 10 per source, 100 global, sliding 15 min window.
	const loginLimiter = new LoginLimiter(15 * 60 * 1000, 10, 100);
	/** VAPID keys for Web Push; generated lazily on the first push path so boot stays silent. */
	let vapid: { publicKey: string; privateKey: string; subject: string } | null =
		null;
	/** Alate server settings; key is stored plaintext like apiKey (same trust level). */
	let alate: { url: string | null; key: string | null } = {
		url: null,
		key: null,
	};
	/** GitHub token from onboarding or Settings; stored plaintext like apiKey (same trust level). */
	let githubToken: string | null = null;
	/**
	 * GitHub host saved in Settings; null = nothing saved, so the env decides. The app
	 * remembers the env value it booted with: a clear restores it, or removes the variable
	 * when the env had none.
	 */
	let savedGithubHost: string | null = null;
	const bootGithubHostEnv = process.env[GITHUB_HOST_ENV];
	/**
	 * Per-host HTTPS tokens for every git host; stored plaintext like
	 * githubToken (same trust level). One entry per host; the token is handed to git through a
	 * credential helper env, never through a URL or .git/config.
	 */
	let gitTokens: GitToken[] = [];
	/**
	 * GitHub App for PR review posts; stored plaintext in the config file like githubToken
	 * (same trust level), never served back after save. The key joins the git secret set.
	 */
	let githubApp: { id: string; key: string; fingerprint: string } | null = null;
	/** Installation-token mint for githubApp; null whenever the app is unset. Memory only. */
	let appTokens: AppTokenSource | null = null;
	/** Last app name + install check; null while no app is set or before the first check. */
	let appCheck: AppCheck | null = null;
	let checkingApp = false;
	/**
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
	const githubTokenExpiry =
		deps.githubTokenExpiry ??
		(async (token: string): Promise<string | null> => {
			const h = githubHost();
			const res = await noRedirectFetch(
				h.isDefault
					? "https://api.github.com/repos/ottr-ai/ottr"
					: `${h.apiBase}/user`,
				{
					headers: {
						authorization: `Bearer ${token}`,
						accept: "application/vnd.github+json",
					},
				},
			);
			// A 401/403/5xx has no expiration header; null would wrongly clear the stored date.
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
	/** Daily reminder: one push per UTC day per token, at 30 days out and through the last two weeks. */
	async function tokenReminderTick(): Promise<void> {
		await refreshBoardExpiry();
		const state = loadReminders();
		const now = new Date();
		const today = now.toISOString().slice(0, 10);
		for (const kind of ["board", "seed"] as const) {
			const r = state[kind];
			if (r.expiresAt === null || r.lastPushDay === today) continue;
			const body = tokenExpiryWarning(kind, r.expiresAt, now);
			const days = tokenDaysLeft(r.expiresAt, now);
			if (body === null || !(days === 30 || (days >= 0 && days <= 14)))
				continue;
			try {
				ensureVapid();
				await sendAll(
					loadSubs(deps.gstore),
					JSON.stringify({
						title: "Ottr",
						body,
						tag: "token-expiry",
						url: "/",
					}),
					(sub, p) => sendNotification(sub, p),
				);
			} catch (err) {
				logError("token expiry push failed", err);
			} finally {
				// One attempt per UTC day even when sends failed (same rule as the alert channel).
				r.lastPushDay = today;
				saveReminders(state);
			}
		}
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
	 * Hindsight server URL and API key from Settings; stored plaintext like apiKey (same trust
	 * level). omp reads HINDSIGHT_API_URL and HINDSIGHT_API_TOKEN over the env, and the runner
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
	function applyHindsight(): void {
		if (hindsightUrl !== null) process.env.HINDSIGHT_API_URL = hindsightUrl;
		if (hindsightToken !== null && process.env.HINDSIGHT_API_URL)
			process.env.HINDSIGHT_API_TOKEN = hindsightToken;
	}
	function hindsightView() {
		return {
			url: process.env.HINDSIGHT_API_URL || null,
			tokenSet: Boolean(process.env.HINDSIGHT_API_TOKEN),
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

	/** Daily-throttled push: only ids a previous push did not name fire one (U5). */
	async function pushUpdates(): Promise<void> {
		if (updates === null || loadSubs(deps.gstore).length === 0) return;
		const today = new Date().toISOString().slice(0, 10);
		const hidden = new Set(loadSkips(deps.gstore));
		const qualifiedIds = updates.updates
			.filter((r) => r.target !== null && !hidden.has(r.id))
			.map((r) => r.id);
		const plan = planUpdatesPush(
			deps.gstore.get<UpdatesPushState>("updatesPush"),
			qualifiedIds,
			today,
		);
		if (plan === null) return;
		try {
			const gone = new Set<string>();
			const report = await sendAll(
				loadSubs(deps.gstore),
				JSON.stringify({
					title: "Upstream updates",
					body: `${plan.length} upstream update(s) ready`,
					tag: "updates",
					url: "/",
				}),
				(sub, p) => sendNotification(sub, p),
			);
			for (const g of report.gone) gone.add(g);
			pruneSubs(deps.gstore, gone);
		} catch (err) {
			logError("updates push failed", err);
		} finally {
			// The attempt names the ids even when some sends failed: no retry storm.
			deps.gstore.set("updatesPush", { date: today, ids: qualifiedIds });
		}
	}

	// Fork research watcher: Entry already exposes
	// {name, path, store, github}; the factory re-iterates the live Map on every tick.
	const forkWatcher = createForkWatcher({
		projects: () => deps.projects.values(),
		log: (msg: string) => console.log(`[fork] ${msg}`),
	});

	// PR review watcher: same live project Map as the fork watcher; tests fake `gh`.
	const prWatcher = createPrWatcher({
		projects: () => deps.projects.values(),
		log: (msg: string) => console.log(`[pr] ${msg}`),
		gh,
		// A re-review rewrites a draft the user may have read: the mark must go,
		// or the updated card never wears the unread badge again.
		forgetSeen: (taskId) => saveSeen(loadSeen().filter((id) => id !== taskId)),
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
		if (updates === null) return fail(409, "no updates loaded");
		const rec = updates.updates.find((u) => u.id === id);
		if (!rec) return fail(400, `unknown update id: ${id}`);
		if ((rec.removed === true) !== removed)
			return fail(
				400,
				removed
					? `not a removed update: ${id}`
					: `removed update files no card: ${id}`,
			);
		// Another updater owns this item; the panel offers no actions on it (U5).
		if (rec.managedBy !== undefined)
			return fail(400, `${id} is managed by ${rec.managedBy}`);
		const projectName = mapRepo(rec.repo, deps.projects.values());
		if (projectName === null)
			return fail(400, `no board project maps ${rec.repo}`);
		const e = deps.projects.get(projectName)!;
		if (e.gitless) return fail(409, "init a git repository first");
		return { rec, e };
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
		const picked: Array<{ rec: UpdateRecord; e: Entry }> = [];
		for (const id of ids) {
			const { rec, e } = fileableUpdate(id, false);
			// Allow waits for a qualified target; propose picks the too-young latest.
			if (propose && rec.target !== null)
				return fail(400, `${id} already has a target`);
			if (!propose && rec.target === null)
				return fail(400, `${id} has no qualified target yet`);
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
					return fail(409, `${id} is already covered by an open update card`);
			picked.push({ rec, e });
		}
		// One card per project, same pattern as followUpOf in POST /api/projects/:project/tasks.
		const groups: Array<{ project: string; recs: UpdateRecord[] }> = [];
		for (const { rec, e } of picked) {
			const g = groups.find((g) => g.project === e.name);
			if (g) g.recs.push(rec);
			else groups.push({ project: e.name, recs: [rec] });
		}
		const created: Array<{ project: string; id: string }> = [];
		for (const { project, recs } of groups) {
			const e = deps.projects.get(project)!;
			const prompt = updatePrompt(recs, propose);
			const t = e.store.createTask(prompt);
			e.store.updateTask(t.id, { updateIds: recs.map((r) => r.id) });
			created.push({ project, id: t.id });
		}
		deps.schedule();
		return created;
	}

	/** Files one card that removes an upstream-deleted row (U5): the mapped project's agent
	 *  drops the installed copy, the pin and every reference. One id, one card. */
	async function fileRemoveCard(
		id: string,
	): Promise<Array<{ project: string; id: string }>> {
		const { rec, e } = fileableUpdate(id, true);
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
				throw {
					status: 409,
					error: `${id} is already covered by an open update card`,
				};
		const t = e.store.createTask(removePrompt([rec]));
		e.store.updateTask(t.id, { updateIds: [id] });
		deps.schedule();
		return [{ project: e.name, id: t.id }];
	}

	/** Single-flight pull from the alate provider; failure keeps the last good result. */
	function refreshUpdates(): Promise<void> {
		if (updatesInFlight !== null) return updatesInFlight;
		if (alate.url === null || alate.key === null) return Promise.resolve();
		updatesInFlight = (async () => {
			try {
				let res: Response;
				try {
					res = await noRedirectFetch(alate.url + "/api/updates", {
						headers: { authorization: "Bearer " + alate.key },
						// Bounded like provision: a hung alate must not hold the pull open.
						signal: AbortSignal.timeout(10_000),
					});
				} catch (err) {
					logError("updates pull failed", err);
					return;
				}
				if (!res.ok) {
					logError(
						"updates pull failed",
						new Error(`alate returned ${res.status}`),
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
				await pushUpdates();
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
			keySet: alate.key !== null,
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
		if (provisioning)
			return { ok: false, status: 409, error: "provisioning already running" };
		provisioning = true;
		try {
			let res: Response;
			try {
				res = await noRedirectFetch(alate.url + "/provision", {
					method: "POST",
					headers: { authorization: "Bearer " + alate.key },
					// Bounded under serveOptions.idleTimeout (120 s) together with the 5 s
					// health probe in provisionTimedOut: a hung alate must fail the
					// request, not hold the connection until the idle cut kills it.
					signal: AbortSignal.timeout(110_000),
				});
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
						: `alate returned ${res.status}`;
				return { ok: false, status: res.status, error: msg };
			}
			return { ok: true, body };
		} finally {
			provisioning = false;
		}
	}
	/** Compose seeds the board's omp copy hourly and records the commit next to its home.
	 *  `roles` is the board copy's modelRoles: the UI compares them with the saved roles. */
	function seedView(): {
		needed: boolean;
		commit: string | null;
		roles: Record<string, string> | null;
		expiresAt: string | null;
	} {
		const needed = !!process.env.OTTR_BOARD_OMP_HOME?.trim();
		if (!needed) return { needed, commit: null, roles: null, expiresAt: null };
		const roles = modelRoles();
		const expiresAt = readSeedTokenExpires();
		try {
			const commit = readFileSync(
				join(dirname(boardOmpHome()), "seed-commit"),
				"utf8",
			).trim();
			return { needed, commit: commit || null, roles, expiresAt };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { needed, commit: null, roles, expiresAt };
		}
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
	async function alateProvisionTick(): Promise<void> {
		if (alate.url === null) return;
		// The health poll runs before the gates so the bell's pending-episode tracking keeps
		// working on a busy board — when the provision gates below would defer the attempt.
		const h = await alateHealth(alate);
		if (h.ok) {
			alatePendingSince =
				h.body.pending === true ? (alatePendingSince ?? Date.now()) : null;
			// A provision that completed (here, by the manual button, or from alate's
			// own dashboard) dates any recorded attempt failure: the import is gone.
			if (h.body.pending !== true) alateProvisionError = null;
		}
		if (alate.key === null) return;
		if (Date.now() < alateBackoffUntil) return;
		// With agent-layer support (alate health layers:true) a provision installs a new
		// layer and switches a symlink: running turns keep the layer they started with,
		// so the provision never waits for an idle board. Without the flag — or when the
		// health probe failed and says nothing — alate may write the flat home under
		// running turns, so the old idle gate stays for that attempt
		// (docs/specs/agent-layer-switch.md).
		if ((h.ok ? h.body.layers : undefined) !== true && anyTurnActive()) return;
		if (!h.ok) {
			alateProvisionError = h.error;
			alateBackoffUntil = Date.now() + 60 * 60_000;
			return;
		}
		if (h.body.pending !== true) return;
		// alate single-flights provisions: one still executing means an earlier
		// attempt (whose wait may have timed out) is mid-flight — wait it out instead
		// of recording its 409 as a failure.
		if (h.body.running === true) return;
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
			}),
			model,
			"review",
		);
		// Synchronous with createTask: the scheduler must never see a review card without its base.
		const updated = e.store.updateTask(t.id, { base: resolved.sha });
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
	async function idleReviewTick(): Promise<void> {
		if (!deps.shared.idleReviews) return;
		if (now() - lastInputAt < 2 * 60 * 60_000) return;
		if (anyTurnActive()) return;
		if (idleReviewCardId !== null) {
			const id = idleReviewCardId;
			const live = [...deps.projects.values()].some((pe) => {
				const t = pe.store.getTask(id);
				return t !== null && t.cancelledAt === null && t.stage !== "done";
			});
			// The remembered card finished or its project left the board: filing may start again.
			if (live) return;
			idleReviewCardId = null;
		}
		for (const e of deps.projects.values()) {
			// Cheap pre-filter from the refreshed entry; reviewBlocked and the due recompute
			// live inside the helper.
			if (e.archReview === null || !e.archReview.due || e.archReview.running)
				continue;
			const filed = await fileArchReview(e, null, { requireDue: true });
			if (filed.ok) {
				idleReviewCardId = filed.task.id;
				return;
			}
			// Not due any more, blocked, or git failed: the tick stays silent.
		}
	}
	function saveConfig(): void {
		deps.gstore.set("config", {
			maxTotal: deps.shared.maxTotalRuns,
			reviewCheck: deps.shared.reviewCheck,
			workCheck: deps.shared.workCheck,
			idleReviews: deps.shared.idleReviews,
			removed: deps.shared.removedPaths,
			projects: deps.shared.projectPaths,
			projectOrder: deps.shared.projectOrder,
			admin,
			apiKey,
			sessionSecret,
			sessions,
			vapid,
			alate,
			githubToken,
			githubHost: savedGithubHost,
			gitTokens,
			githubApp:
				githubApp === null ? null : { id: githubApp.id, key: githubApp.key },
			envValues: deps.shared.envValues,
			hindsightToken,
			hindsightUrl,
		});
	}
	const parsed = deps.gstore.get<{
		maxTotal?: unknown;
		reviewCheck?: unknown;
		workCheck?: unknown;
		idleReviews?: unknown;
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
		githubApp?: unknown;
		envValues?: unknown;
		hindsightToken?: unknown;
		hindsightUrl?: unknown;
	}>("config");
	if (parsed !== null) {
		if (
			parsed.maxTotal === null ||
			(typeof parsed.maxTotal === "number" &&
				Number.isInteger(parsed.maxTotal) &&
				parsed.maxTotal >= 1)
		) {
			deps.shared.maxTotalRuns = parsed.maxTotal;
		}
		// Only a real boolean is accepted; anything else keeps the default (true).
		if (typeof parsed.reviewCheck === "boolean") {
			deps.shared.reviewCheck = parsed.reviewCheck;
		}
		if (typeof parsed.workCheck === "boolean") {
			deps.shared.workCheck = parsed.workCheck;
		}
		if (typeof parsed.idleReviews === "boolean") {
			deps.shared.idleReviews = parsed.idleReviews;
		}
		if (
			typeof parsed.admin === "object" &&
			parsed.admin !== null &&
			"name" in parsed.admin &&
			"passHash" in parsed.admin &&
			typeof parsed.admin.name === "string" &&
			typeof parsed.admin.passHash === "string"
		) {
			admin = { name: parsed.admin.name, passHash: parsed.admin.passHash };
		}
		if (typeof parsed.apiKey === "string") apiKey = parsed.apiKey;
		if (typeof parsed.sessionSecret === "string")
			sessionSecret = parsed.sessionSecret;
		// Only well-formed entries survive a restore; anything else keeps the default ([]).
		if (Array.isArray(parsed.sessions)) {
			sessions = parsed.sessions.filter(
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
		if (
			typeof parsed.vapid === "object" &&
			parsed.vapid !== null &&
			"publicKey" in parsed.vapid &&
			"privateKey" in parsed.vapid &&
			"subject" in parsed.vapid &&
			typeof parsed.vapid.publicKey === "string" &&
			typeof parsed.vapid.privateKey === "string" &&
			typeof parsed.vapid.subject === "string"
		) {
			vapid = {
				publicKey: parsed.vapid.publicKey,
				privateKey: parsed.vapid.privateKey,
				subject: parsed.vapid.subject,
			};
		}
		if (typeof parsed.alate === "object" && parsed.alate !== null) {
			const a = parsed.alate as Record<string, unknown>;
			const str = (v: unknown): string | null =>
				typeof v === "string" ? v : null;
			alate = { url: str(a.url), key: str(a.key) };
		}
		if (typeof parsed.githubToken === "string")
			githubToken = parsed.githubToken;
		if (typeof parsed.githubHost === "string")
			savedGithubHost = parsed.githubHost;
		if (Array.isArray(parsed.gitTokens)) {
			// Each stored row re-runs the request validation; a malformed row is dropped so a
			// corrupt config can never reach git's credential helper.
			const toks: GitToken[] = [];
			for (const row of parsed.gitTokens) {
				if (typeof row !== "object" || row === null) continue;
				const t = parseGitToken(row as Record<string, unknown>);
				if ("error" in t) continue;
				toks.push(t);
			}
			gitTokens = toks;
		}
		if (
			typeof parsed.githubApp === "object" &&
			parsed.githubApp !== null &&
			"id" in parsed.githubApp &&
			"key" in parsed.githubApp
		) {
			// A saved pair re-runs validateAppCredentials; a key that no longer parses is
			// dropped like a malformed git token row. The log names the drop, never the key.
			const v = validateAppCredentials(parsed.githubApp);
			if ("error" in v) {
				logError("dropping stored GitHub App credentials", new Error(v.error));
			} else {
				githubApp = v;
			}
		}
		if (typeof parsed.hindsightToken === "string")
			hindsightToken = parsed.hindsightToken;
		if (typeof parsed.hindsightUrl === "string")
			hindsightUrl = parsed.hindsightUrl;
		if (typeof parsed.envValues === "object" && parsed.envValues !== null) {
			// Each stored row re-runs the request validation; a corrupt entry is dropped.
			const vals: Record<string, string> = {};
			for (const [name, value] of Object.entries(parsed.envValues)) {
				if (ENV_NAME.test(name) && typeof value === "string")
					vals[name] = value;
			}
			deps.shared.envValues = vals;
		}
	}
	// Compose pairing (docker-compose.yml, the `alate` profile): with empty Settings the
	// boot seeds the Alate URL and key from ALATE_URL and ALATE_API_KEY, the way
	// HINDSIGHT_API_URL seeds the memory backend. A value saved under Settings -> Alate
	// wins at every boot, and a saved null clears the seed until the next boot. The key
	// never reaches a log or a view: alateView reports keySet only.
	if (alate.url === null) {
		const seedUrl = process.env.ALATE_URL?.trim();
		if (seedUrl) alate.url = seedUrl.replace(/\/+$/, "");
	}
	if (alate.key === null) {
		const seedKey = process.env.ALATE_API_KEY?.trim();
		if (seedKey) alate.key = seedKey;
	}
	applyGithubToken();
	// A saved host wins over the env at every boot; a clear restored the boot value already.
	applyGithubHost();
	// Every git/ssh/env output the board logs or shows passes redact() with these: the stored
	// tokens, the ssh dir (which holds every key path, in both slash forms, since
	// GIT_SSH_COMMAND names it with forward slashes) and the secret env values. Kept in sync
	// on each token or env change.
	function applyGitSecrets(): void {
		setGitSecrets([
			...gitTokens.map((t) => t.token),
			// The app's PEM key redacts out of every git/gh log line and error text.
			...(githubApp === null ? [] : [githubApp.key]),
			...Object.values(deps.shared.envValues),
			sshDir,
			sshDir.replaceAll("\\", "/"),
		]);
	}
	applyGitSecrets();
	// A boot-adopted app pair gets its token mint here; a route save/reset rebuilds it.
	if (githubApp !== null) {
		appTokens = new AppTokenSource({
			appId: githubApp.id,
			keyObject: parseAppPem(githubApp.key)!.keyObject,
			fetchImpl: githubAppFetch,
		});
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
			tokens: gitTokens,
			key,
			knownHosts: paths.knownHosts,
		});
	});
	try {
		applyHindsight();
	} catch (err) {
		// The saved URL and key stay in effect over the env; only the seeding failed.
		logError("hindsight env seed", err);
	}
	// Boot + interval (src/server.ts), never per turn (docs/specs/memory-backend.md).
	void memoryHealthTick();
	const logins = providerLogin();

	function json(v: unknown, status = 200): Response {
		// Connection: close works around a Bun 1.3.14 Windows bug: while an agent turn runs, a request
		// that arrives on a reused keep-alive connection is not dispatched until the agent's process
		// exits, so the "Add task" spinner spins for the length of a turn. Fresh connections dispatch
		// fine, so the browser must never reuse one. The WebSocket is unaffected.
		return new Response(JSON.stringify(v), {
			status,
			headers: { "Content-Type": "application/json", Connection: "close" },
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

	// PWA statics: the manifest lists icons by URL, and Bun's HTML bundler would hash those away,
	// so they are served at stable root paths straight from the ui directory.
	const PWA_FILES: Record<string, [string, string]> = {
		"/manifest.webmanifest": [
			"manifest.webmanifest",
			"application/manifest+json",
		],
		"/icon-192.png": ["icon-192.png", "image/png"],
		"/icon-512.png": ["icon-512.png", "image/png"],
		"/icon-512-maskable.png": ["icon-512-maskable.png", "image/png"],
	};
	function pwaFile(url: string): Response {
		const hit = PWA_FILES[url];
		if (hit === undefined) return json({ error: "not found" }, 404);
		const [name, type] = hit;
		return new Response(Bun.file(join(import.meta.dir, "ui", name)), {
			headers: { "Content-Type": type },
		});
	}

	// The workflow overview diagrams that the drawer's Workflow modal embeds (the README shows
	// them too). They sit in src/ui like the PWA files: the image copies only src and extension.
	const WORKFLOW_FILES: Record<string, string> = {
		"/workflow-task.svg": "workflow-task.svg",
		"/workflow-review.svg": "workflow-review.svg",
		"/workflow-release.svg": "workflow-release.svg",
	};
	function workflowFile(url: string): Response {
		const name = WORKFLOW_FILES[url];
		if (name === undefined) return json({ error: "not found" }, 404);
		return new Response(Bun.file(join(import.meta.dir, "ui", name)), {
			headers: { "Content-Type": "image/svg+xml" },
		});
	}

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
	 * A card starts an agent run, so the turns' host files cards and nothing else, and only with
	 * the boot token every task session carries (OTTR_BOARD_TOKEN): anyone else who reaches the
	 * port gets 401.
	 */
	function agentRefusal(req: Request): Response | null {
		const token = req.headers.get("x-board-token");
		if (agent === null || token === null || !secretsEqual(token, agent.token))
			return json({ error: "unauthorized" }, 401);
		const path = new URL(req.url).pathname;
		if (req.method !== "POST" || !/^\/api\/projects\/[^/]+\/tasks$/.test(path))
			return json({ error: "this host only files cards" }, 403);
		return null;
	}

	/** Guards every /api request (host allowlist + auth wall); wraps handlers so unexpected errors become 500. */
	function api(req: Request, fn: () => Promise<Response>): Promise<Response> {
		// Mutations pass the Origin wall first (R1-2): a cross-site POST must never reach a
		// handler, and a request that fails both checks answers "forbidden origin".
		if (req.method !== "GET") {
			const originRefused = originWall(req);
			if (originRefused !== null) return Promise.resolve(originRefused);
		}
		const host = req.headers.get("host");
		if (viaAgentHost(req)) {
			const refused = agentRefusal(req);
			if (refused !== null) return Promise.resolve(refused);
		} else {
			const refusal = hostRefusal(host, deps.port, deps.publicHosts);
			if (refusal !== null)
				return Promise.resolve(json({ error: refusal }, 403));
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
					return Promise.resolve(json({ error: "unauthorized" }, 401));
			}
		}
		// Every mutation that reaches a handler counts as input for the idle clock
		// (docs/specs/mutation-delta.md §7): the walls above passed, so the request is real.
		if (req.method !== "GET") lastInputAt = now();
		return (
			fn()
				.catch((err) => {
					logError(`api ${req.method} ${new URL(req.url).pathname}`, err);
					return json({ error: "internal error" }, 500);
				})
				// Mutations (POST/PUT/DELETE) may change the board: push a state diff after the response.
				.finally(() => {
					if (req.method !== "GET") publishSoon();
				})
		);
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
	 * it sends. An unknown peer counts as remote.
	 */
	function walled(req: Request): boolean {
		return (
			viaPublicHost(req) ||
			!directLoopback(
				deps.serverRef.current?.requestIP(req)?.address,
				req.headers,
			)
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
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = req.body?.getReader();
		if (reader !== undefined) {
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
		}
		const out = new Uint8Array(size);
		let at = 0;
		for (const c of chunks) {
			out.set(c, at);
			at += c.byteLength;
		}
		return { bytes: out };
	}

	type JsonBody = { body: Record<string, unknown> } | { error: Response };

	/** Validates a POST request per the security contract and parses its JSON body. */
	async function readJson(
		req: Request,
		maxBytes = MAX_BODY_BYTES,
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
			hasRules: hasRules(e.path),
			target: e.target,
			gitless: e.gitless,
			dirty: e.dirty,
			github: e.github,
			remote: e.remote,
			latestRelease: e.latestRelease,
			latestImage: e.latestImage,
			archReview: e.archReview,
			settings,
			taskPrefix: settings.taskIdPrefix ?? derivedTaskPrefix(e.name),
		};
	}

	/** One cache per app instance: two trackers (or two test apps) never share a snapshot. */
	const orphanSnapshot = orphanCache();
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

	function stateResponse(): StateResponse {
		const tasks: TaskCard[] = [];
		let keptHeld = 0;
		let keptStale = 0;
		const now = Date.now();
		for (const e of deps.projects.values()) {
			try {
				const days = e.store.getSettings().keptWorktreeDays;
				const cards: TaskCard[] = [];
				for (const t of e.store.listTasks()) {
					if (
						t.state === "needs_you" &&
						isKeptReason(t.needsReason) &&
						t.worktree !== null
					) {
						keptHeld += 1;
						if (now - t.updatedAt > days * 86_400_000) keptStale += 1;
					}
					// Cancelled cards ride in the list too: the done lane shows them with a
					// "Cancelled" chip. Every counter (slots, alarms, holds, coverage) either
					// filters cancelledAt or reads state/stage facts a cancelled card no longer has.
					const {
						details: _details,
						report: _report,
						diffFiles: _diffFiles,
						diffText: _diffText,
						...card
					} = t;
					const progress = deps.progressOf?.(e.store.name, t.id);
					const silent = silentSince(t, e.store.logPath(t.id), now);
					cards.push({
						...card,
						steps: viewSteps(t),
						sessionTitle: e.store.frozenTitle(t),
						answered:
							t.stage === "done" &&
							!isRetro(t) &&
							answeredCard(e.store.listTurns(t.id)),
						// A default card pins no model; the chip states what the last run actually used.
						...(t.model === null
							? { lastModel: e.store.lastTurnModel(t.id) }
							: {}),
						...(progress ? { progress } : {}),
						...(silent !== null ? { silentSince: silent } : {}),
					});
				}
				// Name the queued merges each open release holds on the release card, so the board
				// can link held cards to it and offer the re-release once the findings are done.
				for (const card of cards) {
					if (card.releaseVersion === null || card.cancelledAt !== null)
						continue;
					const held = releaseHeldMerges(cards, card);
					if (held.length > 0) card.heldMerges = held.map((h) => h.id);
				}
				tasks.push(...cards);
			} catch (err) {
				// A sick store skips its own cards; the rest of the board still renders.
				logStoreError(e.store.name, err);
			}
		}
		tasks.sort((a, b) => b.createdAt - a.createdAt);
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
			serverVersion: deps.serverVersion,
			quota,
			onboarding: admin === null,
			user: admin?.name ?? null,
			seenAnswers: loadSeen(),
			orphans: scan.orphans,
			orphansError: scan.error,
			keptWorktrees: { held: keptHeld, stale: keptStale },
			drainUntil: drainUntil > now ? drainUntil : null,
			drainCommits: drainUntil > now ? drainCommits : null,
			warnings: [
				...boardWarnings(list, roles, undefined, undefined, tasks, now),
				...(githubApp === null ? [] : [appCheckWarning(appCheck)]).filter(
					(w) => w !== null,
				),
				...(memoryHealth?.reason !== null && memoryHealth !== null
					? [`omp runs with no memory: ${memoryHealth.reason}`]
					: []),
			],
			updates: updatesView(),
			alatePendingSince,
			deadSignIns: dead,
		};
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
		return {
			...task,
			steps: viewSteps(t),
			turns: e.store
				.listTurns(t.id)
				.map(({ prompt: _prompt, ...turn }) => turn),
			sessionTitle: e.store.frozenTitle(t),
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

	/**
	 * Validates every project-setting field in the body into a patch of only the present keys;
	 * a 400 Response on the first bad one. Pure: the caller decides when (and on which store)
	 * the patch lands.
	 */
	function parseSettingsPatch(
		body: Record<string, unknown>,
	): Partial<ProjectSettings> | Response {
		const patch: Partial<ProjectSettings> = {};
		const mp = body.maxParallel;
		if (mp !== undefined) {
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
		}
		const ce = body.copyExtra;
		if (ce !== undefined) {
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
		}
		const dn = body.displayName;
		if (dn !== undefined) {
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
		}
		const ix = body.iconText;
		if (ix !== undefined) {
			if (ix !== null && typeof ix !== "string")
				return json({ error: "iconText must be a string or null" }, 400);
			const marker = typeof ix === "string" ? ix.trim() : "";
			if (marker.length > 4 || /[\p{Cc}]/u.test(marker)) {
				return json({ error: "iconText must be at most 4 characters" }, 400);
			}
			patch.iconText = marker === "" ? null : marker;
		}
		const tp = body.taskIdPrefix;
		if (tp !== undefined) {
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
		}
		const rc = body.releaseCommand;
		if (rc !== undefined) {
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
		}
		const tb = body.targetBranch;
		if (tb !== undefined) {
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
		}
		const cap = body.archReviewCap;
		if (cap !== undefined) {
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
		}
		const mi = body.maxImages;
		if (mi !== undefined) {
			if (typeof mi !== "number" || !Number.isInteger(mi) || mi < 1) {
				return json(
					{ error: "maxImages must be an integer of at least 1" },
					400,
				);
			}
			patch.maxImages = mi;
		}
		const kwd = body.keptWorktreeDays;
		if (kwd !== undefined) {
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
		}
		const at = body.autoTend;
		if (at !== undefined) {
			if (typeof at !== "boolean")
				return json({ error: "autoTend must be a boolean" }, 400);
			patch.autoTend = at;
		}
		const hum = body.holdUpdateMerges;
		if (hum !== undefined) {
			// U7: park merge commits of update cards until a reply approves them.
			if (typeof hum !== "boolean")
				return json({ error: "holdUpdateMerges must be a boolean" }, 400);
			patch.holdUpdateMerges = hum;
		}
		const rf = body.retroFilter;
		if (rf !== undefined) {
			if (typeof rf !== "boolean")
				return json({ error: "retroFilter must be a boolean" }, 400);
			patch.retroFilter = rf;
		}
		const fr = body.forkResearch;
		if (fr !== undefined) {
			if (typeof fr !== "boolean")
				return json({ error: "forkResearch must be a boolean" }, 400);
			patch.forkResearch = fr;
		}
		const pr = body.prReviews;
		if (pr !== undefined) {
			if (typeof pr !== "boolean")
				return json({ error: "prReviews must be a boolean" }, 400);
			patch.prReviews = pr;
		}
		const sc = body.setupChecklist;
		if (sc !== undefined) {
			if (typeof sc !== "boolean")
				return json({ error: "setupChecklist must be a boolean" }, 400);
			patch.setupChecklist = sc;
		}
		// retro is not a stored setting: the route maps it onto retroSince against the
		// CURRENT stored value (re-saving while on must not move the mark). Validate only.
		if (body.retro !== undefined && typeof body.retro !== "boolean")
			return json({ error: "retro must be a boolean" }, 400);
		const atl = body.autoTendLimit;
		if (atl !== undefined) {
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
		}
		const tcg = body.tendChurnGlobs;
		if (tcg !== undefined) {
			if (!Array.isArray(tcg) || tcg.length > 50)
				return json(
					{
						error:
							"tendChurnGlobs must be an array of at most 50 glob patterns",
					},
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
							error:
								"tendChurnGlobs must be an array of at most 50 glob patterns",
						},
						400,
					);
				globs.push(item);
			}
			patch.tendChurnGlobs = globs;
		}
		return patch;
	}

	/** Queues the rules interview as a card; idempotent while one is live. "not-needed" when rules exist, unless fix asks for an alignment pass over them. */
	function startInterview(e: Entry, fix = false): string {
		const has = hasRules(e.path);
		if (has && !fix) return "not-needed";
		const live = liveCard(e.store.listTasks(), "interview");
		if (!live)
			e.store.createTask(
				rulesInterviewPrompt({ projectName: e.store.name, existing: has }),
				null,
				"interview",
			);
		return "queued";
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
			})),
			globalKey: await keyInfo(sshPaths(sshDir).global),
			// Never the key: the fingerprint is what the user compares against GitHub's.
			githubApp:
				githubApp === null
					? null
					: {
							id: githubApp.id,
							fingerprint: githubApp.fingerprint,
							check: appCheck,
						},
			githubHost: githubHostView(),
		};
	}

	const NO_GLOBAL_KEY =
		"no global SSH key: add one in Settings → Git hosts, or pick a new key for this project";
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
			// sshPaths throws on a malformed id or an unusable project name.
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
		promoteKey(from, to);
		return json(await keyInfo(to));
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
		let key: string | null = null;
		let pending: string | null = null;
		if (remote.scheme === "ssh") {
			// Resolve the key before any network run: unknown or missing files are a 400.
			const sel = body.sshKey === undefined ? "global" : body.sshKey;
			if (sel === "global") {
				if (!existsSync(paths.global)) return { error: NO_GLOBAL_KEY };
				key = paths.global;
			} else if (typeof sel === "string" && sel.startsWith("pending:")) {
				let f = "";
				try {
					f = paths.pending(sel.slice("pending:".length));
				} catch {
					return { error: "no such key" };
				}
				if (!existsSync(f)) return { error: "no such key" };
				pending = f;
				key = f;
			} else {
				return { error: 'sshKey must be "global" or "pending:<id>"' };
			}
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
		}
		const authEnv = gitAuthEnv({
			ambientHelpers,
			tokens: gitTokens,
			key,
			knownHosts: paths.knownHosts,
		});
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
		if (r.code !== 0) {
			const line =
				r.stderr.trim().split("\n").filter(Boolean).pop() ?? "git clone failed";
			const error = `git clone failed: ${redact(line, gitSecrets()).slice(0, 300)}`;
			// Classify the failure only after a failed clone: an auth answer has the form offer
			// the token step for that host (spec: needsToken).
			if (remote.scheme === "https") {
				const t = await testRemote(url, authEnv, gitSecrets());
				if ("error" in t && t.auth)
					return { error, needsToken: remote.hostKey };
			}
			return { error };
		}
		// A pending key that cloned cleanly becomes the project key.
		if (pending !== null) promoteKey(pending, paths.project(name));
		return { p: dest };
	}

	/** git-init with an initial commit (Ottr identity fallback); an error string for a 400, or null. */
	async function gitInitWithCommit(p: string): Promise<string | null> {
		const r = await git(["init", "-q", "-b", "main"], p);
		if (r.code !== 0) return `git init failed: ${r.stderr.trim()}`;
		let c = await git(
			["commit", "-q", "--allow-empty", "-m", "Initial commit"],
			p,
		);
		if (c.code !== 0)
			// No configured git identity: commit once as Ottr rather than failing the add.
			c = await git(
				[
					"-c",
					"user.name=Ottr",
					"-c",
					"user.email=ottr@localhost",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"Initial commit",
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

	async function addProject(body: Record<string, unknown>): Promise<Response> {
		// One folder name per board entry (it keys deps.projects and, under OTTR_DATA_DIR, the
		// data dir): a taken basename must 409 BEFORE any clone or git init leaves a repo on
		// disk with no board entry (R1-5).
		const nameTaken = (dest: string): Response | null =>
			deps.projects.has(basename(dest))
				? json({ error: "another project already has that folder name" }, 409)
				: null;
		let p: string;
		const ws = resolve(deps.defaultDir);
		if (typeof body.url === "string") {
			if (!existsSync(ws) || !statSync(ws).isDirectory())
				return json({ error: "projects directory does not exist" }, 400);
			// Trust boundary: parse before anything touches the disk, and git
			// only ever sees the URL after "--".
			const remote = parseGitUrl(body.url);
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
			const c = await cloneGit(body.url.trim(), body, remote, name, dest, ws);
			if ("trust" in c) return json(c.trust, 409);
			if ("error" in c) {
				return json(
					c.needsToken === undefined
						? { error: c.error }
						: { error: c.error, needsToken: c.needsToken },
					400,
				);
			}
			p = c.p;
		} else if (typeof body.name === "string") {
			const parent = ws;
			if (!existsSync(parent) || !statSync(parent).isDirectory())
				return json({ error: "projects directory does not exist" }, 400);
			// Input validation precedes the R1-5 precheck: an ambiguous request (dest on disk
			// AND name taken) keeps its 400 "path already exists"; the 409 still fires before
			// any clone or git init leaves a repo on disk with no board entry.
			const dest = join(parent, body.name.trim());
			if (existsSync(dest)) return json({ error: "path already exists" }, 400);
			const taken = nameTaken(dest);
			if (taken !== null) return taken;
			const n = await initNewProject(body.name.trim(), parent);
			if ("error" in n) return json({ error: n.error }, 400);
			p = n.p;
			if (body.github === true) {
				// gh creates the repo under the authenticated user, wires origin, and pushes.
				const g = await runGh([
					"repo",
					"create",
					body.name.trim(),
					"--private",
					"--source",
					p,
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
							error: `local repo created at ${p}, but creating the GitHub repo failed: ${line.slice(0, 300)}`,
						},
						400,
					);
				}
			}
		} else {
			return json({ error: "provide a git URL or a project name" }, 400);
		}
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
			remote: null,
			dirty: false,
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

		// The wizard/checklist opens for every newly added project.
		e.store.setSettings({ setupChecklist: true });
		// A gitless project has no HEAD to create a worktree from; the turn machinery would
		// crash, so the rules interview waits for POST /init.
		if (e.gitless)
			return json({ project: projectView(e), interview: "gitless" });
		const interview = startInterview(e);
		return json({ project: projectView(e), interview });
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
			e.target = (
				await resolveTarget(
					e.path,
					false,
					null,
					e.store.getSettings().targetBranch,
				)
			).target;
		} catch {
			// The target is unknowable now: report none, never a stale one.
			e.target = null;
		}
		e.github = await githubUrl(e.path).catch(() => null);
		e.remote = await remoteUrl(e.path).catch(() => null);
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

	// Rolling machine stats: CPU and RAM averaged over 15 min, 1 h and 24 h (statsFrame) so a
	// supervisor sizes runner caps from slow numbers, not a live gauge. RAM total reads live.
	// ponytail: 24 h of 30 s samples in memory (2,880 entries); a restart starts the history over.
	const samples: StatsSample[] = [];
	let lastFrame: MachineStats | null = null;

	async function measureStats(): Promise<void> {
		const before = cpus();
		await Bun.sleep(100);
		const after = cpus();
		let idle = 0;
		let total = 0;
		for (let i = 0; i < before.length; i++) {
			const b = before[i]!;
			const a = after[i]!;
			const d = (k: keyof typeof b.times) => a.times[k] - b.times[k];
			idle += d("idle");
			total += d("user") + d("nice") + d("sys") + d("idle") + d("irq");
		}
		const now = Date.now();
		while (samples.length > 0 && samples[0]!.at < now - STATS_KEEP_MS)
			samples.shift();
		samples.push({
			at: now,
			cpu: total === 0 ? 0 : 100 * (1 - idle / total),
			ramUsed: totalmem() - freemem(),
		});
		lastFrame = statsFrame(samples, now, totalmem());
	}
	let behind = 0;
	let behindCommits: string[] = [];
	let behindAt = 0;
	let quota: QuotaState | null = null;
	let refreshingQuota = false;

	// Push layer: one WebSocket topic per board tab. Null until the port is bound; every publish
	// path below must be a no-op before that (boot-time schedule() runs first).
	let sockets = 0;
	let lastStateJson = "";
	let lastStatsJson: string | null = null;
	/** Card slice of the last state frame: the push diff's baseline (kept in memory, no JSON round-trip). */
	let lastTasks: TaskCard[] | null = null;
	let sampling = false; // one 30 s stats sample in flight (each takes >= 100 ms of CPU window)
	let refreshingBehind = false;

	function publish(msg: ServerMessage): void {
		if (deps.serverRef.current === undefined || sockets === 0) return;
		deps.serverRef.current.publish("board", JSON.stringify(msg));
	}

	function publishState(): boolean {
		// Push works without a board tab (R1-1): skip only when nothing can consume the frame —
		// no open socket AND no push subscriber. This is what makes needs-you alerts reach the
		// phone in NODE_ENV=production, where /api/ws is disabled and sockets is always 0.
		if (
			deps.serverRef.current === undefined ||
			(sockets === 0 && loadSubs(deps.gstore).length === 0)
		)
			return false;
		const state = stateResponse();
		const text = JSON.stringify({
			type: "state",
			state,
		} satisfies ServerMessage);
		if (text === lastStateJson) return false;
		// Diff the new cards against the kept baseline for cards that just hit "!" and alert
		// subscribers out-of-band (closed phone app). Fire-and-forget: never in the publish path.
		try {
			pushNeedsYou(lastTasks, state.tasks);
		} catch (err) {
			logError("push diff", err);
		}
		lastTasks = state.tasks;
		lastStateJson = text;
		if (sockets > 0 && deps.serverRef.current !== undefined)
			deps.serverRef.current.publish("board", text);
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
		const check = await checkAppInstalls({
			appId: app.id,
			keyObject: parseAppPem(app.key)!.keyObject,
			repos: boardRepos(),
			fetchImpl: githubAppFetch,
		});
		if (githubApp === app) appCheck = check;
	}

	function sampleStats(): void {
		if (sampling) return;
		sampling = true;
		void measureStats()
			.then(() => {
				if (lastFrame === null) return;
				const text = JSON.stringify({
					type: "stats",
					stats: lastFrame,
				} satisfies ServerMessage);
				lastStatsJson = text;
				// Publish every sample: publish() no-ops with 0 sockets, and /api/stats in
				// polling mode keeps serving lastFrame.
				publish({ type: "stats", stats: lastFrame });
			})
			.catch(() => {
				// A failed sample skips one tick.
			})
			.finally(() => {
				sampling = false;
			});
		if (Date.now() - behindAt > 300_000 && !refreshingBehind) {
			refreshingBehind = true;
			const prev = behind;
			void refreshBehind()
				.then(() => {
					if (behind !== prev)
						publish({ type: "update", behind, commits: behindCommits });
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
					publishState();
				})
				.finally(() => {
					refreshingQuota = false;
				});
		}
	}

	const routes = defineRoutes({
		"/": board,
		// Fixed-path views serve the same board HTML; the client routes on location.pathname.
		"/projects/:project": board,
		"/projects/:project/tasks/:id": board,
		"/settings": board,
		"/settings/:project": board,
		// --- Web Push (begin): service worker for notifications; the sibling PWA branch adds its static routes here too ---
		"/sw.js": () =>
			new Response(Bun.file(resolve(import.meta.dir, "ui", "sw.js")), {
				headers: { "Content-Type": "application/javascript" },
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
		// The Diagrams modal loads mermaid's prebuilt bundle (3.5 MB) on first open, so the board's
		// own bundle stays small: Bun's HTML bundler does not split a dynamic import into a chunk.
		"/mermaid.min.js": {
			GET: () =>
				new Response(
					Bun.file(
						Bun.resolveSync("mermaid/dist/mermaid.min.js", import.meta.dir),
					),
					{ headers: { "Content-Type": "text/javascript; charset=utf-8" } },
				),
		},
		"/api/ws": (req, srv) => {
			if (prod)
				return json(
					{ error: "live updates are disabled in production mode" },
					404,
				);
			// Same wall rule as api(): walled hosts need a live session or the API key (browsers
			// send cookies on the handshake); direct loopback with a loopback Host stays open.
			const refusal = upgradeRefusal(
				req.headers.get("host"),
				req.headers.get("origin"),
				deps.port,
				deps.publicHosts,
				!walled(req) || authorized(req),
			);
			if (refusal)
				return json({ error: refusal }, refusal === "unauthorized" ? 401 : 403);
			if (srv.upgrade(req)) return;
			return json({ error: "websocket upgrade required" }, 400);
		},
		"/api/boot": {
			// Through api() like every other route (R2-11): the Host allowlist must cover it, so
			// a DNS-rebinding page cannot read the version or whether onboarding is open.
			GET: (req) =>
				api(req, async () =>
					json({
						onboarding: admin === null,
						version: deps.serverVersion,
						live: !prod,
					}),
				),
		},
		"/api/setup": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					// Re-checked with the body already read: readJson can hold the request open
					// across the whole onboarding, and an admin created in between must win
					// (R2-4). No await separates this check from the assignments below.
					if (admin !== null)
						return json({ error: "admin already exists" }, 400);
					const name =
						typeof r.body.name === "string" ? r.body.name.trim() : "";
					const password =
						typeof r.body.password === "string" ? r.body.password : "";
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
						sessionCookie(
							signSession(sessionSecret, name, SESSION_MS, id),
							secure,
						),
					);
				}),
		},
		"/api/login": {
			POST: (req, server) =>
				api(req, async () => {
					// X-Forwarded-For is trusted only from a direct-loopback peer (tailscale serve
					// forwards from 127.0.0.1 and sets it); any other peer can fake a fresh XFF
					// per attempt and get a fresh bucket (R2-5).
					const xff = req.headers.get("x-forwarded-for");
					const peer = server.requestIP(req)?.address;
					const source =
						(loopbackIp(peer) && xff?.split(",")[0]?.trim()) ||
						peer ||
						"unknown";
					const r = await readJson(req);
					if ("error" in r) return r.error;
					// Checked after the body is read, so the check, scrypt and recordFailed run in
					// one synchronous block: K bodies held back cannot all pass `allowed` and
					// cash their guesses after the gate opens. A blocked source still never
					// reaches scrypt.
					if (!loginLimiter.allowed(source))
						return json({ error: "too many attempts, try again later" }, 429);
					const name =
						typeof r.body.name === "string" ? r.body.name.trim() : "";
					const password =
						typeof r.body.password === "string" ? r.body.password : "";
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
				}),
		},
		"/api/logout": {
			// Open route: without a valid cookie it only clears the cookie, as before.
			POST: (req) =>
				api(req, async () => {
					const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
					if (sessionSecret !== null && token !== undefined) {
						const v = verifySession(sessionSecret, token);
						if (
							v !== null &&
							v.id !== null &&
							sessions.some((s) => s.id === v.id)
						) {
							sessions = dropSession(sessions, v.id);
							saveConfig();
						}
					}
					return withCookie(
						json({ ok: true }),
						clearSessionCookie(viaPublicHost(req)),
					);
				}),
		},
		"/api/settings/api-key": {
			GET: (req) => api(req, async () => json({ apiKey })),
			POST: (req) =>
				api(req, async () => {
					if (apiKey === null)
						return json({ error: "no admin configured" }, 400);
					apiKey = newSecret();
					saveConfig();
					return json({ apiKey });
				}),
		},
		// Rotation invalidates every signed session at once: the lost-device kill switch
		// (the plain logout below clears only the calling browser's cookie).
		"/api/settings/session-secret": {
			POST: (req) =>
				api(req, async () => {
					if (sessionSecret === null)
						return json({ error: "no admin configured" }, 400);
					sessionSecret = newSecret();
					// The registry dies with the secret: no ghost rows survive the rotation.
					sessions = [];
					saveConfig();
					return json({ ok: true });
				}),
		},
		"/api/settings/sessions": {
			GET: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/settings/sessions/:id": {
			DELETE: (req) =>
				api(req, async () => {
					if (!sessions.some((s) => s.id === req.params.id))
						return json({ error: "no such session" }, 404);
					sessions = dropSession(sessions, req.params.id);
					saveConfig();
					return json({ ok: true });
				}),
		},
		"/api/settings/github-token": {
			GET: (req) =>
				api(req, async () =>
					json({
						tokenSet: githubToken !== null,
						expiresAt: loadReminders().board.expiresAt,
					}),
				),
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		// Settings → Git hosts → GitHub host. An empty host is the reset: the boot env value
		// comes back, or github.com when the env had none. A save re-probes the token so the
		// expiry notice follows the new host at once.
		"/api/settings/github-host": {
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		// Secret env values, one per env.txt name. No answer ever holds a value; a re-save
		// replaces it (parity with the GitHub token: no delete).
		"/api/settings/env": {
			GET: (req) =>
				api(req, async () =>
					json({
						names: listedEnvNames(workersHome).map((row) => ({
							...row,
							set: deps.shared.envValues[row.name] !== undefined,
						})),
					}),
				),
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const name = r.body.name;
					const value = r.body.value;
					// Listed names already passed parseEnvTxt's ENV_NAME check.
					const listed = listedEnvNames(workersHome).some(
						(row) => row.name === name,
					);
					if (
						typeof name !== "string" ||
						!listed ||
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
					deps.shared.envValues[name] = value;
					saveConfig();
					applyGitSecrets();
					return json({ ok: true });
				}),
		},
		// Git hosts other than GitHub. No answer ever holds a token
		// or a private key; every saved credential passed a live test first.
		"/api/git-hosts": {
			GET: (req) => api(req, async () => json(await gitHostsView())),
		},
		"/api/git-hosts/tokens": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const cand = parseGitToken(r.body);
					if ("error" in cand) return json({ error: cand.error }, 400);
					// A token may only take effect for its own host: the test must be an https
					// URL there, or the save stops here.
					const remote = parseGitUrl(r.body.testUrl);
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
						String(r.body.testUrl).trim(),
						gitAuthEnv({
							ambientHelpers,
							tokens: [cand],
							key: null,
							knownHosts: sshPaths(sshDir).knownHosts,
						}),
						// Only the candidate: an unsaved token must never enter the global secret set.
						[cand.token],
					);
					if ("error" in t) return json({ error: t.error }, 400);
					// One token per host: a re-save replaces the host's old entry.
					gitTokens = [...gitTokens.filter((x) => x.host !== cand.host), cand];
					saveConfig();
					applyGitSecrets();
					return json(await gitHostsView());
				}),
		},
		"/api/git-hosts/tokens/:host": {
			DELETE: (req) =>
				api(req, async () => {
					gitTokens = gitTokens.filter((x) => x.host !== req.params.host);
					saveConfig();
					applyGitSecrets();
					return json(await gitHostsView());
				}),
		},
		"/api/git-hosts/ssh/pending": {
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/git-hosts/ssh/test": {
			POST: (req) =>
				api(req, async () => {
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
					const host = await checkHostKey(
						paths.dir,
						remote,
						r.body.trust,
						keyscan,
					);
					if (host !== null) {
						if ("needsTrust" in host) return json(host, 409);
						return json({ error: redact(host.error, gitSecrets()) }, 400);
					}
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
				}),
		},
		"/api/git-hosts/ssh/global": {
			PUT: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					return saveKeyFlow(r.body, sshPaths(sshDir).global);
				}),
			DELETE: (req) =>
				api(req, async () => {
					removeKey(sshPaths(sshDir).global);
					return json({ ok: true });
				}),
		},
		// The GitHub App that posts PR reviews as ottr[bot]. No answer holds the key.
		"/api/git-hosts/github-app": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const v = validateAppCredentials(r.body);
					if ("error" in v) return json({ error: v.error }, 400);
					githubApp = v;
					saveConfig();
					// A fresh pair invalidates any cached installation token for the old one.
					appTokens = new AppTokenSource({
						appId: v.id,
						keyObject: parseAppPem(v.key)!.keyObject,
						fetchImpl: githubAppFetch,
					});
					applyGitSecrets();
					// The answer shows the app name and installs at once; the check never throws.
					await refreshAppCheck();
					return json(await gitHostsView());
				}),
			DELETE: (req) =>
				api(req, async () => {
					githubApp = null;
					appTokens = null;
					appCheck = null;
					saveConfig();
					applyGitSecrets();
					return json(await gitHostsView());
				}),
		},
		"/api/projects/:project/ssh-key": {
			GET: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					const f = projectKeyPath(e.name);
					return json({ own: f === "" ? null : await keyInfo(f) });
				}),
			PUT: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const f = projectKeyPath(e.name);
					if (f === "") return json({ error: "no such key" }, 400);
					return saveKeyFlow(r.body, f);
				}),
			DELETE: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					// Removal falls the project back to the global key.
					const f = projectKeyPath(e.name);
					if (f !== "") removeKey(f);
					return json({ own: null });
				}),
		},
		"/api/settings/hindsight": {
			GET: (req) => api(req, async () => json(hindsightView())),
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const rawUrl =
						typeof r.body.url === "string" ? r.body.url.trim() : "";
					if (rawUrl !== "") {
						try {
							const u = new URL(rawUrl.replace(/\/+$/, ""));
							if (u.protocol !== "http:" && u.protocol !== "https:") throw 0;
						} catch {
							return json(
								{
									error:
										"the server URL must be an http(s) address like http://hindsight.local:8888",
								},
								400,
							);
						}
					}
					const target = rawUrl !== "" ? rawUrl : process.env.HINDSIGHT_API_URL;
					if (!target)
						return json(
							{
								error:
									"HINDSIGHT_API_URL is not set: this board's turns use omp's own memory settings",
							},
							400,
						);
					const url = target.replace(/\/+$/, "");
					// A request without a key keeps the key in effect; a pasted key must be one
					// word of printable characters, at most 500.
					const provided = typeof r.body.token === "string";
					const token =
						typeof r.body.token === "string"
							? r.body.token.trim()
							: (process.env.HINDSIGHT_API_TOKEN ?? "");
					if (provided && !/^[\x21-\x7E]{1,500}$/.test(token))
						return json(
							{
								error:
									"the key must be one word of printable characters, at most 500",
							},
							400,
						);
					// A wrong key fails every turn's memory without a sign (dev-token did for two
					// days), so the server must accept the key before the board keeps it.
					let status: number;
					try {
						const res = await noRedirectFetch(`${url}/v1/default/banks`, {
							headers: { authorization: `Bearer ${token}` },
							signal: AbortSignal.timeout(5000),
						});
						status = res.status;
					} catch (err) {
						return json(
							{ error: `Hindsight at ${url} did not answer: ${errmsg(err)}` },
							502,
						);
					}
					if (status === 401 || status === 403)
						return json(
							{
								error: `Hindsight at ${url} rejected the key (HTTP ${status})`,
							},
							400,
						);
					if (status < 200 || status > 299)
						return json(
							{ error: `Hindsight at ${url} answered HTTP ${status}` },
							502,
						);
					if (rawUrl !== "") hindsightUrl = rawUrl.replace(/\/+$/, "");
					if (provided) hindsightToken = token;
					saveConfig();
					// applyHindsight only seeds the env now, so it cannot throw by a flip;
					// the fresh check makes the returned view report the new backend at once.
					applyHindsight();
					await memoryHealthTick();
					return json(hindsightView());
				}),
		},
		// --- Web Push (begin) ---
		"/api/push/config": {
			GET: (req) =>
				api(req, async () => {
					// Lazy: the first push path pays the VAPID keygen, boot stays silent.
					const v = ensureVapid();
					return json({ publicKey: v.publicKey });
				}),
		},
		"/api/push/subscribe": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const b = r.body as {
						endpoint?: unknown;
						keys?: { p256dh?: unknown; auth?: unknown };
					};
					if (
						typeof b?.endpoint !== "string" ||
						typeof b?.keys?.p256dh !== "string" ||
						typeof b?.keys?.auth !== "string"
					)
						return json({ error: "invalid subscription" }, 400);
					const subs = loadSubs(deps.gstore).filter(
						(s) => s.endpoint !== b.endpoint,
					);
					subs.push({
						endpoint: b.endpoint,
						keys: { p256dh: b.keys.p256dh, auth: b.keys.auth },
						addedAt: Date.now(),
					});
					saveSubs(deps.gstore, subs);
					return json({ ok: true });
				}),
		},
		"/api/push/unsubscribe": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					if (typeof r.body.endpoint !== "string")
						return json({ error: "endpoint required" }, 400);
					saveSubs(
						deps.gstore,
						loadSubs(deps.gstore).filter((s) => s.endpoint !== r.body.endpoint),
					);
					return json({ ok: true });
				}),
		},
		"/api/push/test": {
			POST: (req) =>
				api(req, async () => {
					const subs = loadSubs(deps.gstore);
					if (subs.length === 0)
						return json({ error: "no subscribed device" }, 400);
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
				}),
		},
		// --- Web Push (end) ---
		"/api/seen": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const b = r.body as { ids?: unknown; unread?: unknown };
					const ids = b.ids;
					if (
						!Array.isArray(ids) ||
						ids.length > 10000 ||
						ids.some((id) => typeof id !== "string" || !TASK_ID_RE.test(id))
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
				}),
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
			GET: (req) =>
				api(req, async () => {
					const scan = currentOrphanScan();
					return json({ orphans: scan.orphans, orphansError: scan.error });
				}),
		},
		"/api/orphans/stop": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const { pid, started, cmd } = r.body as Record<string, unknown>;
					if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
						return json({ error: "invalid pid" }, 400);
					if (typeof cmd !== "string" || cmd === "")
						return json({ error: "invalid cmd" }, 400);
					if (typeof started !== "number" || started < 0)
						return json({ error: "invalid started" }, 400);
					// Advisory stays advisory: kill only what the last scan reported, and only
					// when the live process table still names the same command. Any drift
					// (pid reuse, restart, a now-claimed turn) refuses, so the operator decides.
					if (pid === process.pid)
						return json({ error: "refusing to stop the tracker itself" }, 409);
					const claimed = deps.claimedPids();
					if (claimed.has(pid))
						return json({ error: "a live turn claims this pid" }, 409);
					const fresh = (
						deps.listProcesses ?? (() => platform.listProcesses())
					)();
					const live = fresh.find((p) => p.pid === pid);
					if (live === undefined)
						return json({ error: "process is gone" }, 409);
					// The state carries the summarized command, so compare shapes, not bytes:
					// the start-time guard below is what pins the pid against reuse.
					if (summarizeCmd(live.cmd) !== cmd)
						return json({ error: "command differs" }, 409);
					if (Math.abs(live.started - started) > 30_000)
						return json({ error: "start time drifted" }, 409);
					(deps.killTree ?? ((p) => platform.killTree(p)))(pid);
					return json({ ok: true });
				}),
		},
		"/api/stats": {
			GET: (req) => api(req, async () => json(lastFrame)),
		},
		"/api/performance": {
			GET: (req) =>
				api(req, async () => {
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
						projects: stores.map((e, i) => ({
							name: e.store.name,
							...perfMetrics(facts[i]!, kind, now, fleet.seriesStart).metrics,
						})),
					});
				}),
		},
		"/api/gh-status": {
			GET: (req) =>
				api(req, async () => {
					const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
					// Add project's New tab polls this: once for the auth hint, debounced per
					// name for the availability check. 15s bounds a hung gh so the form never
					// waits on it.
					const u = await gh(["api", "user", "--jq", ".login"], 15_000).catch(
						() => ({ code: -1, stdout: "", stderr: "" }),
					);
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
				}),
		},
		"/api/projects/order": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const body = r.body as { order?: unknown };
					if (
						!Array.isArray(body.order) ||
						body.order.some((n) => typeof n !== "string")
					) {
						return json(
							{ error: "order must be an array of project names" },
							400,
						);
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
				}),
		},
		"/api/projects": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					return addProject(r.body);
				}),
		},
		"/api/projects/:project/init": {
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					if (!e.gitless)
						return json({ error: "already a git repository" }, 409);
					const err = await gitInitWithCommit(e.path);
					if (err !== null) return json({ error: err }, 400);
					e.gitless = false;
					await refreshRemote(e);
					const interview = startInterview(e);
					return json({ project: projectView(e), interview });
				}),
		},
		"/api/projects/:project/interview": {
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					const r = await readJson(req);
					if ("error" in r) return r.error;
					// parsed JSON boundary: shape is only trusted after the === true check
					const b = r.body as { fix?: unknown };
					return json({ interview: startInterview(e, b.fix === true) });
				}),
		},
		"/api/projects/:project/remove": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					return removeProject(req.params.project);
				}),
		},
		"/api/settings": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const body = r.body as {
						maxTotal?: unknown;
						reviewCheck?: unknown;
						workCheck?: unknown;
						idleReviews?: unknown;
					};
					const maxTotal = body.maxTotal;
					if (maxTotal !== undefined) {
						if (
							maxTotal !== null &&
							(typeof maxTotal !== "number" ||
								!Number.isInteger(maxTotal) ||
								maxTotal < 1)
						) {
							return json(
								{ error: "maxTotal must be a positive integer or null" },
								400,
							);
						}
						deps.shared.maxTotalRuns = maxTotal;
					}
					const reviewCheck = body.reviewCheck;
					if (reviewCheck !== undefined) {
						if (typeof reviewCheck !== "boolean") {
							return json({ error: "reviewCheck must be a boolean" }, 400);
						}
						deps.shared.reviewCheck = reviewCheck;
					}
					const workCheck = body.workCheck;
					if (workCheck !== undefined) {
						if (typeof workCheck !== "boolean") {
							return json({ error: "workCheck must be a boolean" }, 400);
						}
						deps.shared.workCheck = workCheck;
					}
					const idleReviews = body.idleReviews;
					if (idleReviews !== undefined) {
						if (typeof idleReviews !== "boolean") {
							return json({ error: "idleReviews must be a boolean" }, 400);
						}
						deps.shared.idleReviews = idleReviews;
					}
					saveConfig();
					deps.schedule();
					return json({
						maxTotal: deps.shared.maxTotalRuns,
						reviewCheck: deps.shared.reviewCheck,
						workCheck: deps.shared.workCheck,
						idleReviews: deps.shared.idleReviews,
					});
				}),
		},
		// The update script holds new turns here while a new image waits, so the running turns
		// finish and the restart finds the board idle (docs/WORKERS.md, "Updates").
		"/api/drain": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					// The update script ships the pending commit subjects; untrusted input, so
					// sanitize like the settings routes before anything reads them back.
					if (r.body.commits !== undefined) {
						const commits = r.body.commits;
						if (
							!Array.isArray(commits) ||
							commits.some((c) => typeof c !== "string")
						)
							return json(
								{ error: "commits must be an array of strings" },
								400,
							);
						drainCommits = (commits as string[])
							.map((c) => c.trim())
							.filter((c) => c.length > 0 && !/[\p{Cc}]/u.test(c))
							.map((c) => (c.length > 200 ? c.slice(0, 200) : c))
							.slice(0, 50);
					} else {
						drainCommits = [];
					}
					drainUntil = Date.now() + DRAIN_MS;
					return json({ drainUntil });
				}),
			DELETE: (req) =>
				api(req, async () => {
					drainUntil = 0;
					drainCommits = [];
					return json({ drainUntil: null });
				}),
		},
		"/api/alate": {
			GET: (req) => api(req, async () => json(alateView())),
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const body = r.body as Record<string, unknown>;
					// Validate into a copy (R1-10): a bad later key must not leave the earlier
					// key live — health, provision and the turns read the old config until the
					// whole body validates.
					const next = { ...alate };
					for (const key of ["url", "key"] as const) {
						const v = body[key];
						if (v === undefined) continue;
						if (v === null || v === "") {
							next[key] = null;
							continue;
						}
						if (typeof v !== "string")
							return json({ error: `${key} must be a string or null` }, 400);
						const trimmed = v.trim();
						if (trimmed.length > 500)
							return json({ error: `${key} is too long (max 500 chars)` }, 400);
						if (/[\p{Cc}]/u.test(trimmed))
							return json({ error: `${key} contains control characters` }, 400);
						if (key === "url") {
							let parsed: URL;
							try {
								parsed = new URL(trimmed);
							} catch {
								return json({ error: "url must be a valid http(s) URL" }, 400);
							}
							if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
								return json({ error: "url must be a valid http(s) URL" }, 400);
							next.url = trimmed.replace(/\/+$/, "");
							continue;
						}
						next[key] = trimmed;
					}
					alate = next;
					saveConfig();
					return json(alateView());
				}),
		},
		"/api/alate/health": {
			GET: (req) =>
				api(req, async () => {
					const h = await alateHealth(alate);
					return h.ok ? json(h.body, 200) : json({ error: h.error }, h.status);
				}),
		},
		"/api/alate/provision": {
			POST: (req) =>
				api(req, async () => {
					const r = await provisionNow();
					// A manual success means the provider no longer holds the import, so a
					// recorded trigger failure is stale.
					if (r.ok) alateProvisionError = null;
					// Past the transport bound with alate's health reporting the run: 202
					// Accepted, not an error — the health poll delivers the outcome.
					if (!r.ok && r.running) return json({ running: true }, 202);
					return r.ok ? json(r.body, 200) : json({ error: r.error }, r.status);
				}),
		},
		// Read-only view of the alate integration and the workers' provisioned lists.
		"/api/provisioning": {
			GET: (req) =>
				api(req, async () => {
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
											typeof h.body.version === "string"
												? h.body.version
												: null,
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
					const workers = workerProjects(layerHome(workersHome)).map(
						(name) => ({
							name,
							apt: existsSync(aptListPath(name, workersHome)),
							tools: existsSync(toolsListPath(name, workersHome)),
							requirements: existsSync(requirementsListPath(name, workersHome)),
							env: existsSync(envListPath(name, workersHome)),
						}),
					);
					return json({ server, workers } satisfies ProvisioningResponse);
				}),
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
						const { base, hash, roles } = r.body;
						if (
							(typeof base !== "string" && base !== null) ||
							typeof hash !== "string" ||
							typeof roles !== "object" ||
							roles === null ||
							Array.isArray(roles)
						)
							return json(
								{
									error:
										"body must be { base: string | null, hash: string, roles: object }",
								},
								400,
							);
						// Re-import first: `base` must be the branch head, so any commit on main
						// since the read is a conflict. The check runs before validation, so a
						// stale form sees the current roles even when they already hold its values.
						const f = await loadConfigYml(alate, true);
						if (!f.ok) return json({ error: f.error }, f.status);
						const current = readRoles(f.body.content);
						if (f.body.base !== base || f.body.hash !== hash)
							return json(
								{
									error:
										"the data repo changed since you loaded the roles; check the current roles and save again",
									base: f.body.base,
									hash: f.body.hash,
									roles: current,
								},
								409,
							);
						const catalog = new Set(
							(await (deps.models ?? modelList)()).map((m) => m.selector),
						);
						const bad = validateRoles(
							roles as Record<string, unknown>,
							current,
							catalog,
						);
						if (bad !== null) return json(bad, 400);
						const next = roles as Record<string, string>;
						const content = editModelRoles(f.body.content, next);
						const { repo, base: parent } = f.body;
						if (repo === null || parent === null)
							return json(
								{
									error:
										"the model roles editor needs a GitHub repo (owner/name) as alate's data source",
								},
								400,
							);
						// The commit's parent is the commit the user loaded, and the branch moves only
						// as a fast-forward: a commit on main at any time since the read gives 409.
						// Never retried: a refused write goes back to the user.
						const w = await commitConfigYml(
							gh,
							repo,
							parent,
							content,
							commitMessage(current, next),
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
							hash: new Bun.CryptoHasher("sha256")
								.update(content)
								.digest("hex"),
							roles: readRoles(content),
							seed: seedView(),
						});
					}),
				),
		},
		"/api/updates/refresh": {
			POST: (req) =>
				api(req, async () => {
					await refreshUpdates();
					return json(updatesView());
				}),
		},
		"/api/updates/skip": {
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/updates/allow": {
			POST: (req) =>
				api(req, async () => {
					// U6: file update cards now instead of waiting for the daily push window.
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
							return json(
								{ error: "ids must be a non-empty array of strings" },
								400,
							);
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
				}),
		},
		"/api/updates/remove": {
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/provider-login": {
			GET: (req) =>
				api(req, async () => {
					return json({
						...boardSignIns(),
						pending: logins.pending(),
						providers: loginProviders(),
					});
				}),
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/provider-login/answer": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const line = r.body.line;
					if (typeof line !== "string" || line.length > 8192)
						return json(
							{ error: "line must be a string (max 8192 chars)" },
							400,
						);
					const answer = line.trim();
					if (/[\p{Cc}]/u.test(answer))
						return json({ error: "line must be a single line" }, 400);
					const v = await logins.answer(answer);
					return v === null
						? json({ error: "no sign-in is running; start one first" }, 409)
						: json(v);
				}),
		},
		"/api/provider-login/cancel": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					logins.cancel();
					return json({ ok: true });
				}),
		},
		"/api/provider-login/logout": {
			POST: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/update": {
			GET: (req) =>
				api(req, async () => {
					// Five minutes: the banner tolerates staleness, and each refresh spawns git + network.
					if (Date.now() - behindAt > 300_000) await refreshBehind();
					return json({ behind, commits: behindCommits });
				}),
		},
		"/api/projects/:project/icon": {
			GET: (req) =>
				api(req, async () => {
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
				}),
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					const r = await readBytes(req, MAX_IMAGE_BYTES);
					if ("error" in r) return r.error;
					const ext = sniffImage(r.bytes);
					if (ext === null)
						return json(
							{ error: "icon must be a PNG, JPEG, GIF or WebP file" },
							400,
						);
					removeIcons(e.store.dataRoot, e.store.tasksDir);
					writeBelow(
						e.store.dataRoot,
						join(e.store.tasksDir, `icon.${ext}`),
						r.bytes,
					);
					return json(projectView(e));
				}),
			DELETE: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					removeIcons(e.store.dataRoot, e.store.tasksDir);
					return json(projectView(e));
				}),
		},
		"/api/projects/:project/settings": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					// Every field validates before the patch lands: parseSettingsPatch is pure,
					// so a 400 never leaves a half-applied settings save behind.
					const patch = parseSettingsPatch(r.body);
					if (patch instanceof Response) return patch;
					// retro -> retroSince: on keeps the existing mark (a re-save must not move
					// it), off clears it. Validated as a boolean by parseSettingsPatch.
					if (typeof r.body.retro === "boolean") {
						patch.retroSince = r.body.retro
							? (e.store.getSettings().retroSince ?? Date.now())
							: null;
					}
					// A new targetBranch must move e.target at once: the board, the supervisor,
					// the diffs and the gates read it until the next turn. A save that does not
					// touch the target leaves it alone. The save proves the branch resolves
					// before it lands: an unresolvable one is a 409 with the resolve error and
					// nothing is applied, so the board never reports the old target under the
					// new setting.
					if (patch.targetBranch !== undefined) {
						try {
							await resolveTarget(e.path, false, null, patch.targetBranch);
						} catch (err) {
							return json({ error: errmsg(err) }, 409);
						}
					}
					e.store.setSettings(patch);
					if (patch.targetBranch !== undefined) await refreshRemote(e);
					return json(projectView(e));
				}),
		},
		// The board's Diagrams button: docs/how-it-works.md as committed on the target branch.
		"/api/projects/:project/how-it-works": {
			GET: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.target === null) return json({ error: "no target" }, 404);
					const r = await git(
						["show", `${e.target}:docs/how-it-works.md`],
						e.path,
					);
					if (r.code !== 0)
						return json({ error: "no docs/how-it-works.md" }, 404);
					return new Response(r.stdout, {
						headers: {
							"Content-Type": "text/plain; charset=utf-8",
							"Content-Security-Policy": "sandbox",
							"X-Content-Type-Options": "nosniff",
							"Cache-Control": "no-store",
						},
					});
				}),
		},
		"/api/projects/:project/release": {
			GET: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
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
						sha: resolved.sha,
						originUrl: e.store.getSettings().originUrl,
					}).catch((err) => json({ error: errmsg(err) }, 409));
					if (plan instanceof Response) return plan;
					// Window start: the last release tag's commit time; merges are serialized, so a
					// task is in from..sha exactly when it finished after that commit landed.
					const since =
						plan.from === null
							? 0
							: Number(
									(
										await git(["log", "-1", "--format=%ct", plan.from], e.path)
									).stdout.trim(),
								) * 1000;
					const all = e.store.listTasks();
					const tasks = includedTasks(all, since);
					const blocked = releaseBlocked(
						all,
						e.store.getSettings().releaseCommand,
					);
					return json(
						blocked === null ? { ...plan, tasks } : { ...plan, tasks, blocked },
					);
				}),
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const sha = r.body.sha;
					if (typeof sha !== "string" || /^[0-9a-f]{7,40}$/.test(sha) === false)
						return json(
							{ error: "sha must be a 7-40 character hex string" },
							400,
						);
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
					// The dialog may override the agent's semver pick; validate the shape and
					// re-check the tag collision planRelease only ran for its own version.
					const override = r.body.version;
					if (
						override !== undefined &&
						(typeof override !== "string" || !VERSION_RE.test(override))
					)
						return json(
							{ error: "version must match vX.Y.Z (e.g. v1.2.3)" },
							400,
						);
					const version =
						typeof override === "string" ? override : plan.version;
					if (
						version !== plan.version &&
						(
							await git(
								["rev-parse", "--verify", "--quiet", `refs/tags/${version}`],
								e.path,
							)
						).code === 0
					)
						return json({ error: `Tag ${version} already exists.` }, 409);
					// No await between the guard and createTask below: two overlapping requests cannot
					// both pass the check and create two release cards (R1-8).
					const blocked =
						releaseBlocked(
							e.store.listTasks(),
							e.store.getSettings().releaseCommand,
						) ?? plan.blocked;
					if (blocked !== null) return json({ error: blocked }, 409);
					// Optional user edit of the planned notes (the dialog's textarea).
					const overrideNotes = r.body.notes;
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
					const notes =
						typeof overrideNotes === "string" ? overrideNotes : plan.notes;
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					const t = e.store.createTask(
						releasePrompt({
							version,
							from: plan.from,
							sha: plan.sha,
							commits: plan.commits,
							notes,
						}),
						model,
					);
					// Synchronous with createTask: the scheduler must never see a half-made release card.
					const updated = e.store.updateTask(t.id, {
						base: plan.sha,
						releaseVersion: version,
						releaseNotes: notes,
					});
					deps.schedule();
					return json({ ...updated, turns: [] });
				}),
		},
		"/api/projects/:project/release-summary": {
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (e === undefined) return json({ error: "project not found" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const sha = r.body.sha;
					if (typeof sha !== "string" || /^[0-9a-f]{7,40}$/.test(sha) === false)
						return json(
							{ error: "sha must be a 7-40 character hex string" },
							400,
						);
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
				}),
		},
		"/api/projects/:project/arch-review": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					// The helper keeps the R1-8 ordering (git spawns before the guard; guard
					// and createTask in one synchronous block); the manual route files
					// without a due check, as today.
					const filed = await fileArchReview(e, model, { requireDue: false });
					if (!filed.ok) return json({ error: filed.error }, filed.status);
					return json({ ...filed.task, turns: [] });
				}),
		},
		// The dev-only Check the board button: files the card that runs the check-ottr-board
		// skill in the server's own container (turn.ts keeps it off the workers).
		"/api/projects/:project/board-check": {
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					// One live check: a second click opens it instead of starting a parallel check.
					const lastId = e.store.boardCheckId();
					const last = lastId === null ? null : e.store.getTask(lastId);
					if (last && last.cancelledAt === null && last.stage !== "done")
						return taskResponse(e, last.id);
					const t = e.store.createTask(BOARD_CHECK_PROMPT);
					// Synchronous with createTask: the scheduler must never start the card unmarked.
					e.store.setBoardCheckId(t.id);
					deps.schedule();
					return taskResponse(e, t.id);
				}),
		},
		"/api/projects/:project/queue": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					const order = r.body.order;
					if (
						!Array.isArray(order) ||
						!order.every((id) => typeof id === "string")
					) {
						return json({ error: "order must be an array of task ids" }, 400);
					}
					if (!e.store.reorderQueue(order))
						return json(
							{ error: "order does not match the current queue" },
							409,
						);
					deps.schedule();
					return json({ ok: true });
				}),
		},
		// The composer's opt-in Deepen: a model rewrites the draft; the user accepts before anything runs.
		"/api/projects/:project/deepen": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					const prompt = r.body.prompt;
					if (typeof prompt !== "string")
						return json({ error: "prompt must be a string" }, 400);
					const trimmed = prompt.trim();
					if (!trimmed || trimmed.length > 20000)
						return json({ error: "prompt must be 1-20000 characters" }, 400);
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					try {
						const deepened = await (
							deps.deepen ?? ((prompt, model) => deepenDraft({ prompt, model }))
						)(trimmed, model);
						return json({ deepened });
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
				}),
		},
		"/api/projects/:project/tasks": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req, IMAGE_BODY_BYTES);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					const prompt = r.body.prompt;
					if (typeof prompt !== "string")
						return json({ error: "prompt must be a string" }, 400);
					const trimmed = prompt.trim();
					if (!trimmed || trimmed.length > 20000)
						return json({ error: "prompt must be 1-20000 characters" }, 400);
					// Agents filing cards from another task's run pass that task here; the link renders in both drawers.
					let followUpOf: string | null = null;
					let followUpOfProject: string | null = null;
					let updateIds: string[] = [];
					if (r.body.followUpOf !== undefined && r.body.followUpOf !== null) {
						if (typeof r.body.followUpOf !== "string")
							return json({ error: "followUpOf must be a task id" }, 400);
						const parentId: string = r.body.followUpOf;
						const parent = resolveTask(req.params.project, parentId);
						if (!(parent instanceof Response)) {
							followUpOf = parent.task.id;
							// A child of an update card inherits its merge hold: split-off update work needs the same approval.
							updateIds = parent.task.updateIds;
						} else if (parent.status === 404) {
							// Not on this project's board: create_task can file the work into
							// another project, so scan the fleet for the parent. A 404 here means
							// the id shape is valid (resolveTask answers 400 for a bad shape
							// first). Ids are unique per project, not across projects: exactly
							// one foreign match links and stores the parent's project, several
							// are ambiguous, and the merge hold never crosses a project border.
							const hits = [...deps.projects.values()]
								.filter((p) => p.name !== req.params.project)
								.flatMap((p) => {
									const task = p.store.getTask(parentId);
									return task === null ? [] : [{ project: p.name, task }];
								});
							if (hits.length === 0)
								return json({ error: "unknown followUpOf task" }, 404);
							if (hits.length > 1)
								return json(
									{
										error: `followUpOf names cards in several projects: ${hits.map((h) => h.project).join(", ")}`,
									},
									409,
								);
							followUpOf = hits[0]!.task.id;
							followUpOfProject = hits[0]!.project;
						} else {
							return parent;
						}
					}
					let dependsOn: string[] = [];
					if (r.body.dependsOn !== undefined && r.body.dependsOn !== null) {
						if (
							!Array.isArray(r.body.dependsOn) ||
							r.body.dependsOn.some(
								(x) => typeof x !== "string" || x.trim() === "",
							)
						)
							return json(
								{ error: "dependsOn must be an array of task ids" },
								400,
							);
						dependsOn = [...new Set(r.body.dependsOn as string[])];
						for (const id of dependsOn) {
							const dep = resolveTask(req.params.project, id);
							if (dep instanceof Response)
								return json({ error: `unknown dependsOn task: ${id}` }, 404);
						}
					}
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					const decoded = decodeImages(
						r.body.images,
						e.store.getSettings().maxImages,
					);
					if ("error" in decoded) return json({ error: decoded.error }, 400);
					const t = e.store.createTask(trimmed, model);
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
						return json(
							{ error: `could not save images: ${errmsg(err)}` },
							500,
						);
					}
					if (followUpOf !== null)
						e.store.updateTask(t.id, {
							followUpOf,
							followUpOfProject,
							updateIds,
						});
					if (dependsOn.length > 0) e.store.updateTask(t.id, { dependsOn });
					if (r.body.backlog === true)
						e.store.updateTask(t.id, {
							stage: "backlog",
							state: "idle",
							queuedAt: null,
						});
					// schedule() may start a turn that mutates the row: re-read, don't trust the create return.
					deps.schedule();
					return taskResponse(e, t.id);
				}),
		},
		"/api/projects/:project/tasks/:id": {
			GET: (req) =>
				api(req, async () => {
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					const view = taskView(e, task);
					view.worktreeFiles =
						task.worktree === null ? [] : await statusFiles(task.worktree);
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
								: await diffStat(
										task.worktree,
										task.base ?? "HEAD",
										e.target,
									).catch(() => null);
					if (
						task.releaseVersion !== null &&
						task.state === "needs_you" &&
						task.cancelledAt === null &&
						task.base !== null &&
						e.target !== null
					) {
						// The commits the publish will ship past the reviewed commit, with the review's finding
						// merges marked: the anchors are the mergeHeads the finding cards stamped at Done.
						const findings = reviewFindings(e.store.listTasks(), task)
							.filter((f) => f.cancelledAt === null && f.mergeHead !== null)
							.sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
							.map((f) => f.mergeHead!);
						const head = await resolveTarget(
							e.path,
							false,
							null,
							e.store.getSettings().targetBranch,
						)
							.then((r) => r.sha)
							.catch(() => null);
						if (head !== null) {
							const marked = await lateCommits(
								e.path,
								task.base,
								head,
								findings,
							).catch(() => null);
							if (marked !== null)
								view.lateCommits = marked.map(({ sha, subject, reviewed }) => ({
									sha,
									subject,
									reviewed,
								}));
						}
					}
					return json(view);
				}),
		},
		"/api/projects/:project/tasks/:id/files": {
			GET: (req) =>
				api(req, async () => {
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { task } = found;
					const rel = new URL(req.url).searchParams.get("path") ?? "";
					if (!rel || rel.split(/[\\/]/).includes("..") || isAbsolute(rel)) {
						return json({ error: "bad path" }, 400);
					}
					if (task.worktree === null)
						return json({ error: "unknown task" }, 404);
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
				}),
		},
		"/api/projects/:project/tasks/:id/diff": {
			GET: (req) =>
				api(req, async () => {
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
								: await diffText(
										task.worktree,
										task.base ?? "HEAD",
										e.target,
									).catch(() => null);
					if (text === null || text === "")
						return json({ error: "no diff" }, 404);
					return new Response(text, {
						headers: {
							"Content-Type": "text/plain; charset=utf-8",
							"Content-Security-Policy": "sandbox",
							"X-Content-Type-Options": "nosniff",
							"Cache-Control": "no-store",
							Connection: "close",
						},
					});
				}),
		},
		"/api/projects/:project/tasks/:id/images/:name": {
			GET: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/projects/:project/tasks/:id/edit": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					const prompt = r.body.prompt;
					if (typeof prompt !== "string")
						return json({ error: "prompt must be a string" }, 400);
					const trimmed = prompt.trim();
					if (!trimmed || trimmed.length > 20000)
						return json({ error: "prompt must be 1-20000 characters" }, 400);
					// Editable only while the card still waits unclaimed: a todo card as queued, a
					// backlog card parked idle. A preparing claim has already consumed the prompt
					// (its turn row only appears at startRun, after the git and worktree
					// preparation), so a rewrite there would never reach the run. The check and the
					// write are sync, so the scheduler (same event loop) cannot start a turn in
					// between.
					if (
						!(
							(task.stage === "todo" && task.state === "queued") ||
							(task.stage === "backlog" && task.state === "idle")
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
					const t = e.store.editTask(task.id, trimmed);
					return json(taskView(e, t));
				}),
		},
		"/api/projects/:project/tasks/:id/triage": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					const { priority, closeCandidate } = r.body;
					if (priority === undefined && closeCandidate === undefined)
						return json(
							{ error: "set priority, closeCandidate, or both" },
							400,
						);
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
					let reason: string | null = null;
					if (closeCandidate !== undefined && closeCandidate !== null) {
						if (typeof closeCandidate !== "string")
							return json({ error: "closeCandidate must be a string" }, 400);
						reason = closeCandidate.trim();
						if (!reason || reason.length > 200)
							return json(
								{ error: "closeCandidate must be 1-200 characters" },
								400,
							);
					}
					const patch: {
						priority?: Priority | null;
						closeCandidate?: string | null;
					} = {};
					if (priority !== undefined)
						// The includes check above already validated the wire value.
						patch.priority = priority as Priority | null;
					if (closeCandidate !== undefined) patch.closeCandidate = reason;
					const updated = e.store.updateTask(task.id, patch);
					return json(taskView(e, updated));
				}),
		},
		"/api/projects/:project/tasks/:id/log": {
			GET: (req) =>
				api(req, async () => {
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
				}),
		},
		"/api/projects/:project/tasks/:id/context": {
			GET: (req) =>
				api(req, async () => {
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					return json({
						context: sessionContext(
							found.e.store.sessionsDir,
							found.task.sessionId,
						),
					});
				}),
		},
		"/api/projects/:project/tasks/:id/reply": {
			POST: (req) =>
				api(req, async () => {
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
					if (task.state !== "needs_you")
						return json({ error: "task is not waiting for you" }, 409);
					const decoded = decodeImages(
						r.body.images,
						e.store.getSettings().maxImages,
					);
					if ("error" in decoded) return json({ error: decoded.error }, 400);
					// Same rule as steer/follow-up (R1-9): an empty reply would re-send the whole
					// task prompt as the next turn, and an unbounded one can blow the session.
					const trimmed = text.trim();
					// A steer queued before the stop stays: the reply goes under it, and Resume (".") sends it alone.
					const queue = (next: string): string =>
						task.pendingPrompt === null
							? next
							: next === "."
								? task.pendingPrompt
								: `${task.pendingPrompt}\n\n${next}`;
					if (
						trimmed.length > 20000 ||
						(trimmed === "" && decoded.images.length === 0)
					)
						return json({ error: "text must be 1-20000 characters" }, 400);
					// A click on the third work-check block's ask: the send-back or the merge, done here.
					// Any other text, or a picture, is a plain reply to the agent below.
					const open = openWorkBlockers(task.workCheckLog);
					if (
						task.asked !== null &&
						task.needsReason?.startsWith(WORK_CHECK_THIRD_BLOCK) === true &&
						open.length > 0 &&
						decoded.images.length === 0
					) {
						if (trimmed === WORK_CHECK_ASK_MERGE) {
							e.store.updateTask(
								task.id,
								mergeAnywayPatch(
									task,
									"Merge anyway, chosen in the ask after the third work-check block",
								),
							);
							deps.schedule();
							return taskResponse(e, task.id);
						}
						if (trimmed === WORK_CHECK_ASK_SEND_BACK) {
							const n = task.workCheckSendbacks + 1;
							e.store.updateTask(task.id, {
								pendingPrompt: queue(
									workCheckSendBack({
										blockers: open,
										attempt: n,
										max: n,
									}),
								),
								pendingBy: "supervisor",
								workCheckSendbacks: n,
								state: "queued",
								queuedAt: Date.now(),
								needsReason: null,
								asked: null,
							});
							deps.schedule();
							return taskResponse(e, task.id);
						}
					}
					const names =
						decoded.images.length > 0
							? saveImages(
									e.store.dataRoot,
									e.store.imagesDir(task.id),
									decoded.images,
								)
							: [];
					// U7: the approval reply on a parked update card approves its merge hold for the
					// head the settle parked (undefined keeps the column) and queues the normal merge
					// turn, so the server push happens. Same for a fork-born card parked by the fork
					// merge hold, and for a merge-hold mismatch park (OTTR-274: the parked head is the
					// exact local target head, so the next merge turn pushes it sha-equal). An agent can
					// write the hold text as its own question, but only a settle sets holdHead, so that
					// reply approves nothing. AGEN-33: only APPROVE_REPLY approves, and an approval
					// never queues a work turn.
					const parked = task.holdHead;
					const mismatchHold =
						parked !== null && task.needsReason === MERGE_HOLD_MISMATCH_REASON;
					const approveHold =
						parked !== null &&
						task.updateIds.length > 0 &&
						(task.needsReason === UPDATE_HOLD_REASON || mismatchHold);
					const approveForkHold =
						parked !== null &&
						(task.needsReason === FORK_HOLD_REASON ||
							(mismatchHold && task.updateIds.length === 0));
					if (
						(approveHold || approveForkHold) &&
						trimmed === APPROVE_REPLY &&
						decoded.images.length === 0
					) {
						e.store.updateTask(task.id, {
							stage: "merging",
							state: "queued",
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
					e.store.updateTask(task.id, {
						// "." keeps pendingPrompt non-null for a picture-only reply (see steer).
						pendingPrompt: queue(trimmed || "."),
						pendingBy:
							task.pendingPrompt !== null && task.pendingBy === "supervisor"
								? "supervisor"
								: "user",
						pendingImages: [...task.pendingImages, ...names],
						state: "queued",
						queuedAt: Date.now(),
						needsReason: null,
						asked: null, // the answer to a "?" ask is queued; the badge goes back to plain needs-you flow
						// A non-approval reply never spends the parked head: the hold stays, and the
						// settle re-parks the card after the work turn.
					});
					deps.schedule();
					return taskResponse(e, task.id);
				}),
		},
		"/api/projects/:project/tasks/:id/merge-anyway": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req, MAX_BODY_BYTES);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
					const reason = r.body.reason;
					if (
						typeof reason !== "string" ||
						!reason.trim() ||
						reason.trim().length > 2000
					)
						return json({ error: "reason must be 1-2000 characters" }, 400);
					const trimmed = reason.trim();
					if (task.state === "running" || task.state === "preparing")
						return json({ error: "the work turn is still running" }, 409);
					if (task.stage !== "in_progress")
						return json({ error: "only a work card can merge anyway" }, 409);
					if (openWorkBlockers(task.workCheckLog).length === 0)
						return json({ error: "no outstanding work-check blockers" }, 409);
					e.store.updateTask(task.id, mergeAnywayPatch(task, trimmed));
					deps.schedule();
					return taskResponse(e, task.id);
				}),
		},
		"/api/projects/:project/tasks/:id/follow-up": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req, IMAGE_BODY_BYTES);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
					if (task.stage !== "done")
						return json({ error: "only done tasks can be followed up" }, 409);
					const text = r.body.text;
					if (typeof text !== "string")
						return json({ error: "text must be a string" }, 400);
					const trimmed = text.trim();
					if (!trimmed || trimmed.length > 20000)
						return json({ error: "text must be 1-20000 characters" }, 400);
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					const decoded = decodeImages(
						r.body.images,
						e.store.getSettings().maxImages,
					);
					if ("error" in decoded) return json({ error: decoded.error }, 400);
					// Sync from createTask through updateTask: the 5 s schedule timer must never see the task
					// without its final prompt (no await in between, so no timer can interleave).
					const t = e.store.createTask(trimmed, model);
					let names: string[];
					try {
						names =
							decoded.images.length > 0
								? saveImages(
										e.store.dataRoot,
										e.store.imagesDir(t.id),
										decoded.images,
									)
								: [];
					} catch (err) {
						e.store.updateTask(t.id, {
							cancelledAt: Date.now(),
							state: "idle",
						});
						return json(
							{ error: `could not save images: ${errmsg(err)}` },
							500,
						);
					}
					try {
						const handoffPath = join(
							e.store.tasksDir,
							"handoffs",
							`${t.id}.md`,
						);
						writeBelow(
							e.store.dataRoot,
							handoffPath,
							handoffMarkdown({
								task,
								turns: e.store.listTurns(task.id),
								sessionsDir: e.store.sessionsDir,
							}),
						);
						e.store.updateTask(t.id, {
							followUpOf: task.id,
							prompt: followUpPrompt({
								text: trimmed,
								title: e.store.frozenTitle(task),
								handoffPath,
							}),
							images: names,
						});
					} catch (err) {
						e.store.updateTask(t.id, {
							cancelledAt: Date.now(),
							state: "idle",
						});
						return json(
							{ error: `could not write the handoff: ${errmsg(err)}` },
							500,
						);
					}
					deps.schedule();
					return taskResponse(e, t.id);
				}),
		},
		"/api/projects/:project/tasks/:id/steer": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req, IMAGE_BODY_BYTES);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const text = r.body.text;
					if (typeof text !== "string")
						return json({ error: "text must be a non-empty string" }, 400);
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
					if (
						task.state !== "running" &&
						task.state !== "preparing" &&
						task.state !== "queued"
					)
						return json(
							{
								error:
									"only a running, preparing, or queued task can be steered",
							},
							409,
						);
					const decoded = decodeImages(
						r.body.images,
						e.store.getSettings().maxImages,
					);
					if ("error" in decoded) return json({ error: decoded.error }, 400);
					// Picture-only steer: "." keeps pendingPrompt non-null so runTurn queues a turn that carries the images.
					if (text.trim().length === 0 && decoded.images.length === 0)
						return json({ error: "text must be a non-empty string" }, 400);
					const prompt = text.trim() || ".";
					let names: string[];
					try {
						names = saveImages(
							e.store.dataRoot,
							e.store.imagesDir(task.id),
							decoded.images,
						);
					} catch (err) {
						return json(
							{ error: `could not save images: ${errmsg(err)}` },
							500,
						);
					}
					// Queue the steering; runTurn delivers it with the next turn (one-shot omp runs can't be steered mid-process).
					e.store.updateTask(task.id, {
						pendingPrompt:
							task.pendingPrompt === null
								? prompt
								: `${task.pendingPrompt}\n\n${prompt}`,
						// ponytail: user text appended under supervisor text keeps "supervisor" —
						// a combined park is never titled as the human's words alone.
						pendingBy: task.pendingBy === "supervisor" ? "supervisor" : "user",
						pendingImages: [...task.pendingImages, ...names],
						// A message on a card held for a usage limit runs it now.
						holdUntil: null,
					});
					deps.schedule();
					return taskResponse(e, task.id);
				}),
		},
		"/api/projects/:project/tasks/:id/steer/cancel": {
			POST: (req) =>
				api(req, async () => {
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
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
					const t = e.store.updateTask(task.id, {
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
					});
					return json(taskView(e, t));
				}),
		},
		"/api/projects/:project/tasks/:id/steer/edit": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
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
					const t = e.store.updateTask(task.id, {
						pendingPrompt: text.trim(),
						pendingBy: "user",
					});
					return json(taskView(e, t));
				}),
		},
		"/api/projects/:project/tasks/:id/model": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
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
					return json(taskView(e, e.store.updateTask(task.id, { model })));
				}),
		},
		"/api/projects/:project/tasks/:id/star": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (typeof r.body.starred !== "boolean")
						return json({ error: "starred must be a boolean" }, 400);
					return json(
						taskView(
							e,
							e.store.updateTask(task.id, { starred: r.body.starred }),
						),
					);
				}),
		},
		"/api/projects/:project/tasks/:id/restart-session": {
			POST: (req) =>
				api(req, async () => {
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
						queuedAt: Date.now(),
						needsReason: null,
					});
					deps.schedule();
					return json({ ok: true });
				}),
		},
		// Parked backlog cards: a grill session refines the prompt, promote moves it to todo.
		"/api/projects/:project/tasks/:id/grill": {
			POST: (req) =>
				api(req, async () => {
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
					if (task.stage !== "backlog")
						return json({ error: "only a backlog task can be grilled" }, 409);
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					if (task.state !== "idle")
						return json(
							{ error: "the grill is already queued or running" },
							409,
						);
					if (task.pendingPrompt !== null)
						return json({ error: "a reply is still queued" }, 409);
					e.store.updateTask(task.id, {
						state: "queued",
						...(model !== null ? { model } : {}),
						queuedAt: Date.now(),
						needsReason: null,
						asked: null,
					});
					deps.schedule();
					return taskResponse(e, task.id);
				}),
		},
		"/api/projects/:project/tasks/:id/backlog": {
			POST: (req) =>
				api(req, async () => {
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
					if (to === "todo") {
						if (task.stage !== "backlog")
							return json(
								{ error: "only a backlog task can move to todo" },
								409,
							);
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
						const model = modelParam(r.body);
						if (model instanceof Response) return model;
						// The latest finished grill report carries the refinement; fold it into the prompt.
						const turns = e.store.listTurns(task.id);
						let details: string | null = null;
						for (let i = turns.length - 1; i >= 0; i--) {
							const turn = turns[i];
							const out = turn?.outcome;
							if (
								(out === "ready" || out === "answered") &&
								typeof turn?.details === "string" &&
								turn.details.trim() !== ""
							) {
								details = turn.details;
								break;
							}
						}
						const refined =
							details !== null
								? `${task.prompt}\n\n## Definition of ready (grilled)\n\n${details}`
								: null;
						e.store.updateTask(task.id, {
							...(refined !== null ? { prompt: refined } : {}),
							...(model !== null ? { model } : {}),
							stage: "todo",
							state: "queued",
							queuedAt: Date.now(),
							needsReason: null,
							asked: null,
						});
						deps.schedule();
						return taskResponse(e, task.id);
					}
					if (task.stage !== "todo")
						return json({ error: "only a todo task can be parked" }, 409);
					if (task.state !== "queued")
						return json(
							{
								error:
									"a running, preparing, or needs-you task cannot be parked",
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
					});
					deps.schedule();
					return taskResponse(e, task.id);
				}),
		},
		"/api/projects/:project/tasks/:id/cancel": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const out = await deps.cancel(
						found.e,
						found.task.id,
						r.body.force === true,
					);
					if ("error" in out) return json({ error: out.error }, out.status);
					return "kept" in out
						? json({ ok: false, kept: out.kept })
						: json({ ok: true });
				}),
		},
		"/api/projects/:project/tasks/:id/stop": {
			POST: (req) =>
				api(req, async () => {
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const out = await deps.stopTurn(found.e, found.task.id);
					return "error" in out
						? json({ error: out.error }, out.status)
						: json({ ok: true });
				}),
		},
		"/api/projects/:project/tasks/:id/finish-kept": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const out = await deps.finishKept(
						found.e,
						found.task.id,
						r.body.choices,
					);
					return "error" in out
						? json({ error: out.error }, out.status)
						: json({ ok: true });
				}),
		},
		"/api/projects/:project/forks/check": {
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.github === null)
						return json({ error: "project has no GitHub remote" }, 409);
					// Body optional: a manual run of the same watch the hourly poll uses.
					await forkWatcher.tick({ manual: req.params.project });
					return json({ ok: true });
				}),
		},
		"/api/projects/:project/prs/check": {
			POST: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.github === null)
						return json({ error: "project has no GitHub remote" }, 409);
					// Body optional: a manual run of the same watch the hourly poll uses.
					await prWatcher.tick({ manual: req.params.project });
					return json({ ok: true });
				}),
		},
		"/api/projects/:project/tasks/:id/pr-review/post": {
			POST: (req) =>
				api(req, async () => {
					// 65536 chars may take up to 4 bytes each in UTF-8.
					const r = await readJson(req, 4 * 65536 + 1024);
					if ("error" in r) return r.error;
					const body = r.body.body;
					if (typeof body !== "string" || body.trim() === "")
						return json({ error: "body must be a non-empty string" }, 400);
					if (body.length > REVIEW_BODY_MAX)
						return json({ error: "body is too long" }, 400);
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					const row =
						task.kind === "pr_review"
							? e.store.getPrReviewByTask(task.id)
							: null;
					if (row === null || e.github === null)
						return json({ error: "not a PR review card" }, 409);
					// The watcher saves each draft as the done card's details.
					if (
						task.stage !== "done" ||
						task.state !== "idle" ||
						task.details === null
					)
						return json({ error: "no draft to post" }, 409);
					if (row.state !== "open")
						return json({ error: `PR is ${row.state}` }, 409);
					// The client names the head its draft belongs to: a newer draft may have replaced it meanwhile.
					const head = r.body.head;
					if (typeof head !== "string" || head !== row.reviewedHead)
						return json({ error: "the draft changed" }, 409);
					if (row.postedHead === head)
						return json({ error: "already posted for this head" }, 409);
					// Claim before the await: a concurrent Post of the same head loses here.
					const prev = e.store.claimPrPost(row.number, head);
					if (prev === undefined)
						return json({ error: "already posted for this head" }, 409);
					const repo = ownerRepo(e.github) ?? e.github;
					const slash = repo.indexOf("/");
					const owner = repo.slice(0, slash);
					const repoName = repo.slice(slash + 1);
					const appSecrets = [...gitSecrets()];
					let via: "app" | "token" = "token";
					let stdout: string | null = null;
					if (githubApp !== null && appTokens !== null) {
						// Mint an installation token; without an installation (null) fall through
						// to the board token. Any other mint failure is a 502, no fallback post.
						let tok: string | null = null;
						try {
							tok = await appTokens.tokenFor(owner, repoName);
						} catch (err) {
							const error = redact(errmsg(err), appSecrets)
								.trim()
								.slice(0, 300);
							e.store.releasePrPost(row.number, head, prev, error);
							return json({ error }, 502);
						}
						if (tok !== null) {
							// Direct fetch, no gh: the review posts as the app, not the board token.
							try {
								const res = await githubAppFetch(
									`${githubHost().apiBase}/repos/${repo}/pulls/${row.number}/reviews`,
									{
										method: "POST",
										headers: {
											authorization: `Bearer ${tok}`,
											accept: "application/vnd.github+json",
											"content-type": "application/json",
											"user-agent": "Ottr",
										},
										body: JSON.stringify({
											event: "COMMENT",
											body: `${body}${REVIEW_FOOTER}`,
											commit_id: head,
										}),
									},
								);
								const text = await res.text();
								if (!res.ok) {
									const error =
										redact(text.trim().slice(0, 300), appSecrets) ||
										`GitHub answered ${res.status}`;
									e.store.releasePrPost(row.number, head, prev, error);
									return json({ error }, 502);
								}
								stdout = text;
								via = "app";
							} catch (err) {
								const error = redact(errmsg(err), appSecrets)
									.trim()
									.slice(0, 300);
								e.store.releasePrPost(row.number, head, prev, error);
								return json({ error }, 502);
							}
						}
					}
					if (stdout === null) {
						// argv array, no shell: body and head never reach a command line parser.
						let res: { code: number; stdout: string; stderr: string };
						try {
							res = await gh([
								"api",
								`repos/${repo}/pulls/${row.number}/reviews`,
								"-X",
								"POST",
								"-f",
								"event=COMMENT",
								"-f",
								`body=${body}${REVIEW_FOOTER}`,
								"-f",
								`commit_id=${head}`,
							]);
						} catch (err) {
							// A spawn failure (e.g. gh missing) sent nothing: free the claim, or the head reads as posted.
							res = { code: -1, stdout: "", stderr: errmsg(err) };
						}
						if (res.code !== 0) {
							const error =
								res.stderr.trim().slice(0, 300) || `gh exited ${res.code}`;
							e.store.releasePrPost(row.number, head, prev, error);
							return json({ error }, 502);
						}
						stdout = res.stdout;
					}
					// GitHub's response body is untrusted: only an https URL on the configured
					// host becomes the drawer link, and only a plausible login names the
					// posting identity.
					let url: string | null = null;
					let login: string | null = null;
					try {
						const body: unknown = JSON.parse(stdout);
						if (typeof body === "object" && body !== null) {
							if ("html_url" in body) {
								const u: unknown = body.html_url;
								if (typeof u === "string") {
									try {
										const parsed = new URL(u);
										if (
											parsed.protocol === "https:" &&
											parsed.hostname === githubHost().host
										)
											url = u;
									} catch {
										// Not a URL: the drawer shows the posted head without a link.
									}
								}
							}
							if ("user" in body) {
								const user: unknown = body.user;
								const l =
									typeof user === "object" && user !== null && "login" in user
										? user.login
										: null;
								if (typeof l === "string" && l.length >= 1 && l.length <= 100)
									login = l;
							}
						}
					} catch {
						// No parseable body: the drawer just shows the posted head without a link.
					}
					e.store.setPrPostedUrl(row.number, url, login);
					return json({ ok: true, login, via });
				}),
		},
		"/api/projects/:project/github": {
			GET: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.github === null)
						return json({ error: "project has no GitHub remote" }, 409);
					// Same repo id the fork watcher derives from the remote.
					const repo =
						ownerRepo(`https://github.com/${e.github}.git`) ?? e.github;
					try {
						const forks = await listForks(repo, gh);
						return json({ repo, ...forkSummary(forks, Date.now()) });
					} catch (err) {
						return json({ error: errmsg(err) }, 502);
					}
				}),
		},
		"/api/projects/:project/tasks/:id/unmark-research": {
			POST: (req) =>
				api(req, async () => {
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
					return json(
						taskView(e, e.store.updateTask(task.id, { research: false })),
					);
				}),
		},
		"/api/projects/:project/tasks/:id/release-notes": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const found = resolveTask(req.params.project, req.params.id);
					if (found instanceof Response) return found;
					const { e, task } = found;
					if (task.cancelledAt !== null)
						return json({ error: "task is cancelled" }, 404);
					if (task.releaseVersion === null)
						return json(
							{ error: "only release cards have release notes" },
							409,
						);
					if (task.state !== "idle" && task.state !== "needs_you")
						return json(
							{
								error:
									"only an idle or needs-you release card can edit release notes",
							},
							409,
						);
					if (typeof r.body.notes !== "string")
						return json({ error: "notes must be a string" }, 400);
					const trimmed = r.body.notes.trim();
					if (!trimmed || trimmed.length > 20000)
						return json({ error: "notes must be 1-20000 characters" }, 400);
					return json(
						taskView(
							e,
							e.store.updateTask(task.id, { releaseNotes: r.body.notes }),
						),
					);
				}),
		},
	});

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
				(await logins.callback(req)) ?? json({ error: "not found" }, 404),
			websocket: {
				open(ws: ServerWebSocket<undefined>) {
					// Increment BEFORE publishState so this socket is either in the publish or sent the frame.
					sockets++;
					pushDoneCount = 0; // the user is looking at the board: done counts restart
					ws.subscribe("board");
					if (!publishState()) ws.send(lastStateJson);
					ws.send(
						JSON.stringify({
							type: "update",
							behind,
							commits: behindCommits,
						} satisfies ServerMessage),
					);
					if (lastStatsJson !== null) ws.send(lastStatsJson);
				},
				// Push-only: inbound frames are never parsed.
				message() {},
				close() {
					sockets--;
				},
			},
		},
		serverRef: deps.serverRef,
		publish,
		publishState,
		publishSoon,
		notifyLog,
		drained: () => Date.now() < drainUntil,
		// OTTR-465: the credential kinds the server's git can use for a push to a URL, for the
		// card log; never a value. A missing App installation on a repo shows as a permission
		// failure, and this line is what names the installation token the push went out with.
		pushAuthKind: (url: string): string | null =>
			pushAuthKind(url, {
				tokens: gitTokens,
				ambientHelpers,
				key: existsSync(sshPaths(sshDir).global),
				envToken: process.env.GH_TOKEN ?? null,
				githubHost: githubHost().host,
			}),
		socketCount: () => sockets,
		sampleStats,
		alateProvisionTick,
		idleReviewTick,
		memoryHealthTick,
		refreshUpdates,
		tokenReminderTick,
		forkResearchTick: (opts?: { manual?: string }) => forkWatcher.tick(opts),
		prReviewTick: (opts?: { manual?: string }) => prWatcher.tick(opts),
	};
}
