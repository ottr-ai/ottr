// Ottr: request-serving half of the tracker — HTTP routes, board state push, stats.
// All mutable request state lives in createApp's closure, so two instances never share state.
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Serve, Server, ServerWebSocket } from "bun";
import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import {
	clearSessionCookie,
	hashPassword,
	LoginLimiter,
	newSecret,
	parseCookies,
	SESSION_COOKIE,
	SESSION_MS,
	secretsEqual,
	sessionCookie,
	signSession,
	verifyAdminLogin,
	verifySession,
} from "./auth.ts";
import { logError } from "./crash.ts";
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
	readAmbientHelpers,
	realKeyscan,
	redact,
	removeKey,
	setGitSecrets,
	sshPaths,
	type TrustNeeded,
	testRemote,
} from "./gitHosts.ts";
import type { GlobalStore } from "./globalStore.ts";
import {
	decodeImages,
	MAX_IMAGE_BYTES,
	saveImages,
	sniffImage,
} from "./images.ts";
import {
	agentDir,
	PROVIDER_ID,
	providerLogin,
	type SignIn,
	shareProviderCredentials,
	signIns,
	signOut,
} from "./login.ts";
import { modelList, modelRoles } from "./models.ts";
import { orphanCache } from "./orphans.ts";
import { perfMetrics } from "./perf.ts";
import { type ProcessInfo, platform } from "./platform/index.ts";
import {
	BOARD_CHECK_PROMPT,
	followUpPrompt,
	handoffMarkdown,
	LOST_SESSION,
	releasePrompt,
	reviewPrompt,
	rulesInterviewPrompt,
} from "./prompts.ts";
import { fetchQuota } from "./quota.ts";
import {
	includedTasks,
	ownerRepo,
	planRelease,
	releaseBlocked,
	runGh,
} from "./release.ts";
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
	isRetro,
	lastReviewBase,
	liveCard,
	openWorkBlockers,
	reviewBlocked,
} from "./scheduler.ts";
import { sessionContext } from "./session.ts";
import { ProjectStore } from "./store.ts";
import {
	type CancelOutcome,
	errmsg,
	type FinishKeptOutcome,
	FORK_HOLD_REASON,
	isKeptReason,
	logStoreError,
	type StopOutcome,
	type TurnProject,
	UPDATE_HOLD_REASON,
} from "./turn.ts";
import {
	answeredCard,
	type MachineStats,
	type PerfRange,
	PRIORITIES,
	type Priority,
	type ProjectSettings,
	type ProjectView,
	type QuotaState,
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
	dropPendingDecisions,
	enqueueDecision,
	hiddenUpdateIds,
	loadFiledApprovals,
	loadPendingDecisions,
	mapRepo,
	migrateSkipsToPending,
	planUpdatesPush,
	type UpdatesPushState,
	updatePrompt,
	type ValidatedDecision,
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
function removeIcons(tasksDir: string): void {
	for (const ext of ICON_EXTS) {
		try {
			unlinkSync(join(tasksDir, `icon.${ext}`));
		} catch {
			// Missing file: nothing to remove.
		}
	}
}

const IMAGE_BODY_BYTES = 32 * 1024 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;
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
	serverVersion: string;
	port: number;
	publicHosts: string[];
	shared: {
		/** Null = no cap: start as many runs as projects need. */
		maxTotalRuns: number | null;
		reviewCheck: boolean;
		workCheck: boolean;
		removedPaths: string[];
		projectPaths: string[];
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
	/** Server-only ssh key + known_hosts dir (docs/specs/git-hosts.md); no worker mounts it. */
	sshDir?: string;
	/** ssh-keyscan seam for the host-key check; defaults to realKeyscan. Tests inject a stub. */
	keyscan?: Keyscan;
}

/** The persisted removed/added project paths; boot discovery needs them before createApp runs. */
export function storedProjectPaths(gstore: GlobalStore): {
	removedPaths: string[];
	projectPaths: string[];
} {
	const c = gstore.get<{ removed?: unknown; projects?: unknown }>("config");
	const paths = (v: unknown): string[] =>
		Array.isArray(v)
			? v
					.filter((x): x is string => typeof x === "string")
					.map((p) => resolve(p))
			: [];
	return { removedPaths: paths(c?.removed), projectPaths: paths(c?.projects) };
}

/**
 * Fetch that never follows a redirect: fetch keeps the Authorization header on a
 * redirect chain, so a redirecting endpoint could bounce the bearer off-host.
 * A 3xx answer is an error with a clear message, never a hop.
 */
async function noRedirectFetch(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, { ...init, redirect: "manual" });
	if (res.status >= 300 && res.status < 400)
		throw new Error(`${url} answered ${res.status} (redirect not followed)`);
	return res;
}

/**
 * Bun infers the route-key union R from the literal's keys and maps each to `BunRequest<Path>`,
 * so handlers keep exact `req.params` typing without a hand-maintained route list (R1-15).
 */
const defineRoutes = <R extends string>(
	r: Serve.RoutesWithUpgrade<undefined, R>,
) => r;

export function createApp(deps: AppDeps) {
	const gh = deps.gh ?? runGh;
	const prod = deps.prod === true;
	// Server-only ssh material (docs/specs/git-hosts.md): a data dir outside every checkout.
	const sshDir = deps.sshDir ?? defaultSshDir();
	const keyscan = deps.keyscan ?? realKeyscan;
	const ambientHelpers = readAmbientHelpers();
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

	/** Ids of the cards that are question-only right now, by the same rule the state frame
	 * ships (stateResponse): a read mark only means something for them. Marks a client sends
	 * for anything else are stale — a pre-server-sync tab imported marks for cards it merely
	 * had open — so /api/seen drops them and the store decays instead of poisoning the board. */
	function answeredIds(): Set<string> {
		const ids = new Set<string>();
		for (const e of deps.projects.values()) {
			try {
				for (const t of e.store.listTasks()) {
					if (
						t.cancelledAt === null &&
						t.stage === "done" &&
						!isRetro(t) &&
						answeredCard(e.store.listTurns(t.id))
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
	 * Per-host HTTPS tokens for every git host (docs/specs/git-hosts.md); stored plaintext like
	 * githubToken (same trust level). One entry per host; the token is handed to git through a
	 * credential helper env, never through a URL or .git/config.
	 */
	let gitTokens: GitToken[] = [];
	/**
	 * Server-side git, gh and merge turns read the token from GH_TOKEN; the worker image's git
	 * credential helper hands it to git. Work turns never get it: runner strips it from the env
	 * it forwards to workers (D6).
	 */
	function applyGithubToken(): void {
		if (githubToken !== null) process.env.GH_TOKEN = githubToken;
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
	 * level). omp reads HINDSIGHT_API_URL and HINDSIGHT_API_TOKEN over config.yml, and the runner
	 * forwards the board's env to workers, so saved values reach every new turn and beat the
	 * compose env that seeds them. Without either, the board leaves the env alone: its turns keep
	 * omp's settings.
	 */
	let hindsightToken: string | null = null;
	let hindsightUrl: string | null = null;
	/**
	 * docker/ottr-entry.sh flips `memory.backend` once at container start, from the env seed. The
	 * board repeats that flip whenever a Settings-saved URL comes into effect, so a stack seeded
	 * only from Settings still runs omp with memory.backend: hindsight. Two files can be in
	 * play (R5-1): the pinned copy the board's own omp spawns read, and the shared one in the
	 * workers' home that every worker turn reads — patch both when they differ, the one file
	 * when they are the same (a direct install). A missing file is fine (the entry script's
	 * `[ -f … ]`); anything unreadable throws.
	 */
	function hindsightBackendFlip(): void {
		const pinned = join(agentDir(), "config.yml");
		const shared = join(
			process.env.HOME ?? homedir(),
			".omp",
			"agent",
			"config.yml",
		);
		for (const path of pinned === shared ? [pinned] : [pinned, shared]) {
			if (!existsSync(path)) continue;
			const cfg = readFileSync(path, "utf8");
			// The same line the entry script's sed targets; CRLF kept for Windows installs.
			const next = cfg.replace(
				/^([ \t]*)backend: mnemopi([ \t]*\r?)$/m,
				"$1backend: hindsight$2",
			);
			if (next !== cfg) writeFileSync(path, next);
		}
	}
	function applyHindsight(): void {
		if (hindsightUrl !== null) process.env.HINDSIGHT_API_URL = hindsightUrl;
		if (hindsightToken !== null && process.env.HINDSIGHT_API_URL)
			process.env.HINDSIGHT_API_TOKEN = hindsightToken;
		if (process.env.HINDSIGHT_API_URL) hindsightBackendFlip();
	}
	function hindsightView() {
		return {
			url: process.env.HINDSIGHT_API_URL || null,
			tokenSet: Boolean(process.env.HINDSIGHT_API_TOKEN),
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
		decisions: Record<string, ValidatedDecision>;
	} | null = (() => {
		const v = deps.gstore.get<unknown>("updates");
		if (typeof v !== "object" || v === null) return null;
		const r = v as Record<string, unknown>;
		return typeof r.checkedAt === "string" && Array.isArray(r.updates)
			? {
					checkedAt: r.checkedAt,
					updates: r.updates,
					// Lenient like the records: the boot blob predates full re-validation.
					decisions:
						typeof r.decisions === "object" &&
						r.decisions !== null &&
						!Array.isArray(r.decisions)
							? (r.decisions as Record<string, ValidatedDecision>)
							: {},
				}
			: null;
	})();
	let updatesInFlight: Promise<void> | null = null;
	// Legacy skip ids ride the decision queue so alate learns them too.
	migrateSkipsToPending(deps.gstore);

	/** State-frame view: repo→project mapping and decision/skip filtering run against live projects. */
	function updatesView(): UpdatesView | null {
		if (updates === null) return null;
		const hidden = hiddenUpdateIds(deps.gstore, updates.decisions);
		const pendingIds = new Set(
			loadPendingDecisions(deps.gstore).map((d) => d.id),
		);
		return {
			checkedAt: updates.checkedAt,
			rows: updates.updates
				.filter((rec) => !hidden.has(rec.id))
				.map((rec) => {
					const d = updates!.decisions[rec.id];
					return {
						...rec,
						project: mapRepo(rec.repo, deps.projects.values()),
						...(d === undefined ? {} : { decision: d.decision }),
						...(pendingIds.has(rec.id) ? { decisionPending: true } : {}),
					};
				}),
		};
	}

	/** Daily-throttled push: only ids a previous push did not name fire one (U5). */
	async function pushUpdates(): Promise<void> {
		if (updates === null || loadSubs(deps.gstore).length === 0) return;
		const today = new Date().toISOString().slice(0, 10);
		const hidden = hiddenUpdateIds(deps.gstore, updates.decisions);
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

	// Fork research watcher (docs/decisions/2026-10-14-fork-research.md): Entry already exposes
	// {name, path, store, github}; the factory re-iterates the live Map on every tick.
	const forkWatcher = createForkWatcher({
		projects: () => deps.projects.values(),
		log: (msg: string) => console.log(`[fork] ${msg}`),
	});

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
			const rec = updates.updates.find((u) => u.id === id);
			if (!rec) return fail(400, `unknown update id: ${id}`);
			if (rec.removed) return fail(400, `removed update files no card: ${id}`);
			// Another updater owns this item; the panel offers no actions on it (U5).
			if (rec.managedBy !== undefined)
				return fail(400, `${id} is managed by ${rec.managedBy}`);
			const projectName = mapRepo(rec.repo, deps.projects.values());
			if (projectName === null)
				return fail(400, `no board project maps ${rec.repo}`);
			const e = deps.projects.get(projectName)!;
			if (e.gitless) return fail(409, "init a git repository first");
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
		const filedIds: string[] = [];
		for (const { project, recs } of groups) {
			const e = deps.projects.get(project)!;
			const prompt = updatePrompt(recs, propose);
			const t = e.store.createTask(prompt);
			e.store.updateTask(t.id, { updateIds: recs.map((r) => r.id) });
			created.push({ project, id: t.id });
			filedIds.push(...recs.map((r) => r.id));
		}
		// Allow and provider approvals share one filed mark per version: a done or
		// cancelled card, or a stale provider check, must never re-file the version.
		deps.gstore.set("filedApprovals", [
			...new Set([...loadFiledApprovals(deps.gstore), ...filedIds]),
		]);
		deps.schedule();
		return created;
	}

	/** Send queued decisions to alate; a 2xx acks one entry, a network error stops the round. */
	async function flushDecisions(): Promise<void> {
		for (const d of loadPendingDecisions(deps.gstore)) {
			let res: Response;
			try {
				res = await noRedirectFetch(alate.url + "/api/updates/decision", {
					method: "POST",
					headers: {
						authorization: "Bearer " + alate.key,
						"content-type": "application/json",
					},
					body: JSON.stringify(d),
					// Bounded like the pull: a hung alate must not hold the flush open.
					signal: AbortSignal.timeout(10_000),
				});
			} catch (err) {
				logError("updates decision flush failed", err);
				return;
			}
			if (!res.ok)
				logError(
					"updates decision flush",
					new Error(`alate returned ${res.status} for ${d.id}`),
				);
			else dropPendingDecisions(deps.gstore, [d.id]);
		}
	}

	/** Auto-file cards for provider-approved ids that no card covers yet (filedApprovals). */
	async function fileApprovedDecisions(): Promise<void> {
		const filed = new Set(loadFiledApprovals(deps.gstore));
		for (const [id, d] of Object.entries(updates!.decisions)) {
			if (d.decision !== "approved" || filed.has(id)) continue;
			if (!updates!.updates.some((r) => r.id === id)) continue;
			try {
				// fileUpdateCards records the filed mark on success.
				await fileUpdateCards([id], d.propose === true);
			} catch (err) {
				logError(`updates auto-file failed for ${id}`, err);
			}
		}
	}

	/** Single-flight pull from the alate provider; failure keeps the last good result. */
	function refreshUpdates(): Promise<void> {
		if (updatesInFlight !== null) return updatesInFlight;
		if (alate.url === null || alate.key === null) return Promise.resolve();
		updatesInFlight = (async () => {
			try {
				await flushDecisions();
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
					decisions: good.decisions,
				};
				deps.gstore.set("updates", updates);
				if (good.dropped > 0)
					console.log(
						`updates: dropped ${good.dropped} invalid record(s) from alate`,
					);
				if (good.droppedDecisions > 0)
					console.log(
						`updates: dropped ${good.droppedDecisions} invalid decision(s) from alate`,
					);
				await fileApprovedDecisions();
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
	/** GET <alate.url>/health shared by the proxy route and the U9 trigger. */
	async function alateHealth(): Promise<
		| { ok: true; body: Record<string, unknown> }
		| { ok: false; status: number; error: string }
	> {
		if (alate.url === null)
			return {
				ok: false,
				status: 400,
				error: "alate server url is not configured",
			};
		let res: Response;
		try {
			res = await fetch(alate.url + "/health", {
				signal: AbortSignal.timeout(5000),
			});
		} catch (err) {
			return {
				ok: false,
				status: 502,
				error: `cannot reach alate server: ${(err as Error).message}`,
			};
		}
		const body = (await res.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!res.ok) {
			const msg =
				typeof body?.error === "string"
					? body.error
					: `alate returned ${res.status}`;
			return { ok: false, status: res.status, error: msg };
		}
		if (body === null || typeof body !== "object")
			return {
				ok: false,
				status: 502,
				error: "alate returned an invalid health response",
			};
		return { ok: true, body };
	}
	/** POST <alate.url>/provision shared by the route and the U9 trigger, with its in-flight guard.
	 *  `running: true` marks a delivered provision that outlived the transport bound: accepted
	 *  by alate's single-flight guard and still executing there — never a failure. */
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
					// Bounded under serveOptions.idleTimeout: a hung alate must fail the
					// request, not hold the connection until the idle cut kills it.
					signal: AbortSignal.timeout(110_000),
				});
			} catch (err) {
				// AbortSignal.timeout rejects with TimeoutError: the POST was delivered
				// and alate accepted it (single-flight), so the scripts are running —
				// only this client's wait ended. Report that, never failure. A fast
				// connect failure still lands in the 502 below.
				if ((err as Error).name === "TimeoutError")
					return {
						ok: false,
						status: 202,
						error: "provision still running on alate",
						running: true,
					};
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
	 * provider holds an unprovisioned import and no turn runs, run the manual provision
	 * path. A success leaves pending false, so the provider flag ends the loop; a failed
	 * attempt waits an hour and surfaces in alateView for the settings section.
	 */
	async function alateProvisionTick(): Promise<void> {
		if (alate.url === null) return;
		// The health poll runs before the gates so the bell's pending-episode tracking keeps
		// working on a busy board — when the provision gates below would defer the attempt.
		const h = await alateHealth();
		if (h.ok) {
			alatePendingSince =
				h.body.pending === true ? (alatePendingSince ?? Date.now()) : null;
			// A provision that completed (here, by the manual button, or from alate's
			// own dashboard) dates any recorded attempt failure: the import is gone.
			if (h.body.pending !== true) alateProvisionError = null;
		}
		if (alate.key === null) return;
		if (Date.now() < alateBackoffUntil) return;
		if (anyTurnActive()) return;
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
		if (!r.ok && r.running) return; // delivered and accepted; the outcome arrives via health
		alateProvisionError = r.ok ? null : r.error;
		if (!r.ok) alateBackoffUntil = Date.now() + 60 * 60_000;
	}
	function saveConfig(): void {
		deps.gstore.set("config", {
			maxTotal: deps.shared.maxTotalRuns,
			reviewCheck: deps.shared.reviewCheck,
			workCheck: deps.shared.workCheck,
			removed: deps.shared.removedPaths,
			projects: deps.shared.projectPaths,
			admin,
			apiKey,
			sessionSecret,
			vapid,
			alate,
			githubToken,
			gitTokens,
			hindsightToken,
			hindsightUrl,
		});
	}
	const parsed = deps.gstore.get<{
		maxTotal?: unknown;
		reviewCheck?: unknown;
		workCheck?: unknown;
		removed?: unknown;
		projects?: unknown;
		admin?: unknown;
		apiKey?: unknown;
		sessionSecret?: unknown;
		vapid?: unknown;
		alate?: unknown;
		githubToken?: unknown;
		gitTokens?: unknown;
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
		if (typeof parsed.hindsightToken === "string")
			hindsightToken = parsed.hindsightToken;
		if (typeof parsed.hindsightUrl === "string")
			hindsightUrl = parsed.hindsightUrl;
	}
	applyGithubToken();
	// Every git/ssh output the board logs or shows passes redact() with these: the stored
	// tokens and the ssh dir, which holds every key path (in both slash forms, since
	// GIT_SSH_COMMAND names it with forward slashes). Kept in sync on each token change.
	function applyGitSecrets(): void {
		setGitSecrets([
			...gitTokens.map((t) => t.token),
			sshDir,
			sshDir.replaceAll("\\", "/"),
		]);
	}
	applyGitSecrets();
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
		// The saved URL and key stay in effect over the env; only the config.yml flip failed.
		logError("hindsight backend switch", err);
	}
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
		return token !== undefined && verifySession(sessionSecret, token) !== null;
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

	/** Reads a raw (non-JSON) body with the same streamed byte cap as readJson (R1-2). */
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
		const declared = Number(req.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes)
			return { error: json({ error: "body too large" }, 413) };
		// Stream the body with a byte cap: `req.text()` would buffer a chunked (no
		// Content-Length) body unbounded before the size check, so an unauthenticated
		// client can exhaust memory (R1-2). Cancel the source at the cap.
		let size = 0;
		let text = "";
		const decoder = new TextDecoder();
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
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		}
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
			settings: e.store.getSettings(),
		};
	}

	/** One cache per app instance: two trackers (or two test apps) never share a snapshot. */
	const orphanSnapshot = orphanCache();
	/** Agent processes no live turn claims, cached for a few minutes; advisory only, never killed. */
	function currentOrphanScan(): {
		orphans: { pid: number; started: number }[];
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
		return {
			orphans: scan.orphans.map(({ pid, started }) => ({ pid, started })),
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
				for (const t of e.store.listTasks()) {
					if (
						t.state === "needs_you" &&
						isKeptReason(t.needsReason) &&
						t.worktree !== null
					) {
						keptHeld += 1;
						if (now - t.updatedAt > days * 86_400_000) keptStale += 1;
					}
					if (t.cancelledAt === null) {
						const {
							details: _details,
							report: _report,
							diffFiles: _diffFiles,
							diffText: _diffText,
							...card
						} = t;
						const progress = deps.progressOf?.(e.store.name, t.id);
						tasks.push({
							...card,
							sessionTitle: e.store.frozenTitle(t),
							answered:
								t.stage === "done" &&
								!isRetro(t) &&
								answeredCard(e.store.listTurns(t.id)),
							...(progress ? { progress } : {}),
						});
					}
				}
			} catch (err) {
				// A sick store skips its own cards; the rest of the board still renders.
				logStoreError(e.store.name, err);
			}
		}
		tasks.sort((a, b) => b.createdAt - a.createdAt);
		const scan = currentOrphanScan();
		return {
			projects: [...deps.projects.values()].flatMap((e) => {
				try {
					return [projectView(e)];
				} catch (err) {
					logStoreError(e.store.name, err);
					return [];
				}
			}),
			tasks,
			maxTotal: deps.shared.maxTotalRuns,
			reviewCheck: deps.shared.reviewCheck,
			workCheck: deps.shared.workCheck,
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
			updates: updatesView(),
			alatePendingSince,
		};
	}

	/** One task with its turns for the drawer; turns ship without the prompt text and the raw
	 * diff ships only from its own endpoint, so opening a drawer never carries the cap-sized text. */
	function taskView(e: Entry, t: Task): TaskView {
		const { diffText: _diffText, ...task } = t;
		return {
			...task,
			turns: e.store
				.listTurns(t.id)
				.map(({ prompt: _prompt, ...turn }) => turn),
			sessionTitle: e.store.frozenTitle(t),
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
		if (!/^(?:[0-9a-f]{8}|[A-Z0-9]{1,4}-[0-9]+)$/.test(id))
			return json({ error: "bad task id" }, 400);
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

	/** The Settings git-hosts view: per-host token flags and the global key — never a secret itself. */
	async function gitHostsView() {
		return {
			tokens: gitTokens.map((t) => ({
				host: t.host,
				username: t.username,
				tokenSet: true,
			})),
			globalKey: await keyInfo(sshPaths(sshDir).global),
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

	/** Shared save flow for a key (global or per project): pending selector, ssh testUrl, host-key confirm, ls-remote, promote (spec section 5: a key is stored only when the test exits 0). */
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

	/** Host-agnostic clone (docs/specs/git-hosts.md); `{ p }` on success, `{ error, needsToken? }` for a 400, `{ trust }` for a 409. */
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
			// Trust boundary (spec section 1): parse before anything touches the disk, and git
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
			e.target = (await resolveTarget(e.path)).target;
		} catch {
			// unresolved target stays null
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

	// Rolling 15-minute machine stats: CPU and RAM averaged over the window so a supervisor
	// sizes runner caps from a slow number, not a live gauge. RAM total reads live.
	const STATS_WINDOW_MS = 15 * 60_000;
	const samples: { at: number; cpu: number; ramUsed: number }[] = [];
	let lastFrame: MachineStats | null = null;

	const round = (n: number): number => Math.round(n * 10) / 10;

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
		const cutoff = Date.now() - STATS_WINDOW_MS;
		while (samples.length > 0 && samples[0]!.at < cutoff) samples.shift();
		samples.push({
			at: Date.now(),
			cpu: round(total === 0 ? 0 : 100 * (1 - idle / total)),
			ramUsed: totalmem() - freemem(),
		});
		const usedGiB =
			samples.reduce((s, x) => s + x.ramUsed, 0) / samples.length / 1024 ** 3;
		const totalGiB = totalmem() / 1024 ** 3;
		lastFrame = {
			cpu: round(samples.reduce((s, x) => s + x.cpu, 0) / samples.length),
			ram: {
				usedGiB: round(usedGiB),
				totalGiB: round(totalGiB),
				pct: round(totalGiB === 0 ? 0 : (100 * usedGiB) / totalGiB),
			},
		};
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
		const f = await git(
			["fetch", "origin", "main"],
			resolve(import.meta.dir, ".."),
		);
		if (f.code !== 0) {
			behind = 0; // no upstream (dev checkout): the button stays hidden
			behindCommits = [];
			return;
		}
		const c = await git(
			["rev-list", "--count", "HEAD..origin/main"],
			resolve(import.meta.dir, ".."),
		);
		behind = c.code === 0 ? Number(c.stdout.trim()) || 0 : 0;
		// Subjects for the banner's bullet list. ponytail: capped at 50 so a long
		// divergence cannot blow up the WS frame; the count above stays authoritative.
		const l = await git(
			["log", "--format=%s", "-n", "50", "HEAD..origin/main"],
			resolve(import.meta.dir, ".."),
		);
		behindCommits =
			c.code === 0 && l.code === 0
				? l.stdout.trim().split("\n").filter(Boolean)
				: [];
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
		// Five minutes, like omp's own per-account usage cache; the 1 s state diff ships the result.
		if (
			(quota === null || Date.now() - quota.at > 300_000) &&
			!refreshingQuota
		) {
			refreshingQuota = true;
			void fetchQuota()
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
					saveConfig();
					applyGithubToken();
					const secure = viaPublicHost(req);
					return withCookie(
						json({ ok: true, apiKey }),
						sessionCookie(signSession(sessionSecret, name, SESSION_MS), secure),
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
					return withCookie(
						json({ ok: true }),
						sessionCookie(
							signSession(sessionSecret, name, SESSION_MS),
							viaPublicHost(req),
							remember,
						),
					);
				}),
		},
		"/api/logout": {
			POST: (req) =>
				api(req, async () =>
					withCookie(
						json({ ok: true }),
						clearSessionCookie(viaPublicHost(req)),
					),
				),
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
					saveConfig();
					return json({ ok: true });
				}),
		},
		"/api/settings/github-token": {
			GET: (req) =>
				api(req, async () => json({ tokenSet: githubToken !== null })),
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const token = githubTokenParam(r.body.token);
					if (token === null) return json({ error: GITHUB_TOKEN_ERROR }, 400);
					githubToken = token;
					saveConfig();
					applyGithubToken();
					return json({ tokenSet: true });
				}),
		},
		// Git hosts other than GitHub (docs/specs/git-hosts.md). No answer ever holds a token
		// or a private key; every saved credential passed a live test first (spec section 5).
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
					// URL there, or the save stops here (spec section 5).
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
					// Both ways land as a pending key first (spec section 3): generate or paste.
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
					// Removal falls the project back to the global key (spec section 3).
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
					try {
						applyHindsight();
					} catch (err) {
						return json(
							{
								error: `saved, but omp's memory backend did not switch to hindsight: ${errmsg(err)}`,
							},
							502,
						);
					}
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
						ids.some(
							(id) =>
								typeof id !== "string" ||
								!/^(?:[0-9a-f]{8}|[A-Z0-9]{1,4}-[0-9]+)$/.test(id),
						)
					)
						return json({ error: "invalid ids" }, 400);
					// unread: true makes a read result unread again; unmentioned ids leave the
					// set too when they are stale, so the store decays here as on the read path.
					if (b.unread === true) {
						// ponytail: ids here hold one id; includes beats a Set at this size.
						saveSeen(loadSeen().filter((id) => !ids.includes(id)));
						return json({ ok: true });
					}
					// seen ⇒ answered right now: drop anything else (stale clients, dead ids).
					const live = answeredIds();
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
					// Fleet first: its facts union fixes the series start every project
					// series aligns with (docs/specs/overview.md).
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
					if (u.code !== 0)
						return json({ authed: false, user: null, free: null, dir });
					const user = u.stdout.trim();
					// GitHub repo-name charset; anything else stays unchecked and waits for
					// the submit-time validation instead of a misleading answer.
					if (name === "" || /[^A-Za-z0-9_.-]/.test(name))
						return json({ authed: true, user, free: null, dir });
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
					return json({ authed: true, user, free, dir });
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
					saveConfig();
					deps.schedule();
					return json({
						maxTotal: deps.shared.maxTotalRuns,
						reviewCheck: deps.shared.reviewCheck,
						workCheck: deps.shared.workCheck,
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
					const h = await alateHealth();
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
					// Delivered past the transport bound: 202 Accepted, not an error — the
					// health poll delivers the outcome.
					if (!r.ok && r.running) return json({ running: true }, 202);
					return r.ok ? json(r.body, 200) : json({ error: r.error }, r.status);
				}),
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
					// The provider must learn the skip too; the next refresh flushes it.
					enqueueDecision(deps.gstore, { id, decision: "skipped" });
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
						// The provider must learn the approval too; the next refresh flushes it.
						for (const id of ids)
							enqueueDecision(deps.gstore, {
								id,
								decision: "approved",
								...(body.propose === true ? { propose: true } : {}),
							});
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
					let list: SignIn[] | null = null;
					let error: string | null = null;
					try {
						list = signIns();
					} catch (err) {
						error = `cannot read omp's sign-ins: ${errmsg(err)}`;
					}
					return json({ signIns: list, error, pending: logins.pending() });
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
					// The sign-out lands in the board's own store; the copy carries the tombstones to
					// the shared worker store, whose rows a turn authenticates against (R5-1).
					return json({
						removed: signOut(provider),
						signIns: signIns(),
						syncError: shareProviderCredentials(provider),
					});
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
					removeIcons(e.store.tasksDir);
					writeFileSync(join(e.store.tasksDir, `icon.${ext}`), r.bytes);
					return json(projectView(e));
				}),
			DELETE: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					removeIcons(e.store.tasksDir);
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
					e.store.setSettings(patch);
					return json(projectView(e));
				}),
		},
		"/api/projects/:project/learnings": {
			GET: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					return json({ learnings: e.store.listLearnings() });
				}),
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					const { text, glob } = r.body;
					if (typeof text !== "string")
						return json({ error: "text must be a string" }, 400);
					const trimmed = text.trim();
					if (!trimmed || trimmed.length > 500)
						return json({ error: "text must be 1-500 characters" }, 400);
					let g: string | null = null;
					if (glob !== undefined) {
						if (typeof glob !== "string")
							return json({ error: "glob must be a string" }, 400);
						g = glob.trim();
						if (!g || g.length > 200)
							return json({ error: "glob must be 1-200 characters" }, 400);
					}
					return json({
						learning: e.store.addLearning({ text: trimmed, glob: g }),
					});
				}),
		},
		"/api/projects/:project/learnings/:id": {
			DELETE: (req) =>
				api(req, async () => {
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (!/^-?\d+$/.test(req.params.id))
						return json({ error: "bad learning id" }, 400);
					e.store.deleteLearning(Number(req.params.id));
					return json({ ok: true });
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
						resolved = await resolveTarget(e.path, true);
					} catch (err) {
						return json({ error: errmsg(err) }, 409);
					}
					const plan = await planRelease({
						mainPath: e.path,
						target: resolved.target,
						sha: resolved.sha,
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
						resolved = await resolveTarget(e.path, true);
					} catch (err) {
						return json({ error: errmsg(err) }, 409);
					}
					const plan = await planRelease({
						mainPath: e.path,
						target: resolved.target,
						sha,
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
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					const learnings = e.store.listLearnings();
					const t = e.store.createTask(
						releasePrompt({
							version,
							from: plan.from,
							sha: plan.sha,
							commits: plan.commits,
							notes: plan.notes,
							learnings,
						}),
						model,
					);
					// ponytail: usage counted at card creation, not at turn start; a review card that never runs overcounts by one.
					e.store.touchLearnings(learnings.map((l) => l.id));
					// Synchronous with createTask: the scheduler must never see a half-made release card.
					const updated = e.store.updateTask(t.id, {
						base: plan.sha,
						releaseVersion: version,
						releaseNotes: plan.notes,
					});
					deps.schedule();
					return json({ ...updated, turns: [] });
				}),
		},
		"/api/projects/:project/arch-review": {
			POST: (req) =>
				api(req, async () => {
					const r = await readJson(req);
					if ("error" in r) return r.error;
					const e = deps.projects.get(req.params.project);
					if (!e) return json({ error: "unknown project" }, 404);
					if (e.gitless)
						return json({ error: "init a git repository first" }, 409);
					if (e.target === null)
						return json({ error: "project has no integration target" }, 409);
					// The review freezes the target's current head, like a release card.
					let resolved: { target: string; sha: string };
					try {
						resolved = await resolveTarget(e.path, true);
					} catch (err) {
						return json({ error: errmsg(err) }, 409);
					}
					const delta = await archReviewDelta(
						e.path,
						resolved.target,
						lastReviewBase(e.store.listTasks()),
					).catch(() => null);
					// The git spawns run BEFORE the guard, so the guard and createTask below sit in one
					// synchronous block: two overlapping requests cannot both pass it (R1-8).
					const blocked = reviewBlocked(e.store.listTasks());
					if (blocked !== null) return json({ error: blocked }, 409);
					if (delta === null)
						return json({ error: "could not read the git history" }, 409);
					const model = modelParam(r.body);
					if (model instanceof Response) return model;
					const learnings = e.store.listLearnings();
					const t = e.store.createTask(
						reviewPrompt({
							target: resolved.target,
							sha: resolved.sha,
							from: delta.reviewed ? delta.anchor : null,
							commits: delta.delta,
							learnings,
						}),
						model,
						"review",
					);
					// ponytail: usage counted at card creation, not at turn start; a review card that never runs overcounts by one.
					e.store.touchLearnings(learnings.map((l) => l.id));
					// Synchronous with createTask: the scheduler must never see a review card without its base.
					const updated = e.store.updateTask(t.id, { base: resolved.sha });
					deps.schedule();
					return json({ ...updated, turns: [] });
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
					if (r.body.followUpOf !== undefined && r.body.followUpOf !== null) {
						if (typeof r.body.followUpOf !== "string")
							return json({ error: "followUpOf must be a task id" }, 400);
						const parent = resolveTask(req.params.project, r.body.followUpOf);
						if (parent instanceof Response)
							return json({ error: "unknown followUpOf task" }, 404);
						followUpOf = parent.task.id;
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
							const names = saveImages(e.store.imagesDir(t.id), decoded.images);
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
					if (followUpOf !== null) e.store.updateTask(t.id, { followUpOf });
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
					// gone); open cards read the branch live, uncommitted edits included.
					view.diffFiles =
						task.stage === "done" || task.cancelledAt !== null
							? task.diffFiles
							: task.worktree === null || e.target === null
								? null
								: await diffStat(
										task.worktree,
										task.base ?? "HEAD",
										e.target,
									).catch(() => null);
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
					const text =
						task.stage === "done" || task.cancelledAt !== null
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
					// Editable only before the first work turn exists; the check and the write are sync, so the
					// scheduler (same event loop) cannot start a turn in between.
					if (
						(task.stage !== "todo" && task.stage !== "backlog") ||
						task.cancelledAt !== null ||
						e.store.listTurns(task.id).length > 0
					)
						return json(
							{
								error: "only todo tasks that have not started can be edited",
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
						fd = openSync(file, "r");
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
					if (
						trimmed.length > 20000 ||
						(trimmed === "" && decoded.images.length === 0)
					)
						return json({ error: "text must be 1-20000 characters" }, 400);
					const names =
						decoded.images.length > 0
							? saveImages(e.store.imagesDir(task.id), decoded.images)
							: [];
					// U7: a reply on a parked update card approves its merge hold (undefined keeps the column).
					// Same for a fork-born card parked by the fork merge hold.
					const approveHold =
						task.updateIds.length > 0 &&
						task.needsReason === UPDATE_HOLD_REASON;
					const approveForkHold = task.needsReason === FORK_HOLD_REASON;
					e.store.updateTask(task.id, {
						// "." keeps pendingPrompt non-null for a picture-only reply (see steer).
						pendingPrompt: trimmed || ".",
						pendingImages: names,
						state: "queued",
						queuedAt: Date.now(),
						needsReason: null,
						asked: null, // the answer to a "?" ask is queued; the badge goes back to plain needs-you flow
						updateMergeApproved: approveHold || undefined,
						forkMergeApproved: approveForkHold || undefined,
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
					// Merge anyway is the user's override of outstanding work-check blockers; the
					// reason lands on every overridden blocker. Rebuilt immutably so the store's
					// change detection sees the new log.
					const rebuilt = task.workCheckLog.map((run) =>
						run.blockers.some((b) => b.status === undefined)
							? {
									...run,
									blockers: run.blockers.map((b) =>
										b.status === undefined
											? {
													...b,
													status: "overridden" as const,
													statusReason: trimmed,
												}
											: b,
									),
								}
							: run,
					);
					e.store.updateTask(task.id, {
						workCheckLog: rebuilt,
						stage: "merging",
						state: "queued",
						queuedAt: Date.now(),
						pendingPrompt: null,
						needsReason: null,
					});
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
								? saveImages(e.store.imagesDir(t.id), decoded.images)
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
						mkdirSync(dirname(handoffPath), { recursive: true });
						writeFileSync(
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
						names = saveImages(e.store.imagesDir(task.id), decoded.images);
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
						pendingImages: [...task.pendingImages, ...names],
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
		socketCount: () => sockets,
		sampleStats,
		alateProvisionTick,
		refreshUpdates,
		forkResearchTick: (opts?: { manual?: string }) => forkWatcher.tick(opts),
	};
}
