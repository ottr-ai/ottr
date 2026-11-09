// Task-turn lifecycle: the scheduler and one turn run, with every effectful
// operation (process/git/release) injected so tests can drive the flows with fakes.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ensureProjectPackages } from "./apt.ts";
import {
	copyBelow,
	readBelow,
	readRegular,
	renameBelow,
	trustedAnchor,
	writeBelow,
} from "./confine.ts";
import type { pidAlive } from "./dblock.ts";
import { errmsg } from "./errmsg.ts";
import { runGateway, type SpawnFn } from "./forkAnalysis.ts";
import { BRANCH_RULE_REJECTION, GIT_AUTH_FAILURE } from "./gitHosts.ts";
import { GIT_HTTP_AUTH_STATUS } from "./githubAuthHint.ts";
import type { CommitIdentity } from "./gitIdentity.ts";
import {
	DEFAULT_CREDIT_REASON,
	type Hosted,
	METERING_INTERVAL_MS,
	type MeteringRecord,
	type TokenUsage,
} from "./hosted.ts";
import {
	type DecodedImage,
	MAX_IMAGE_BYTES,
	pngGray16,
	saveImages,
	sniffImage,
	visuallyIdentical,
} from "./images.ts";
import { joinLevel, splitLevel } from "./levels.ts";
import { modelRoles } from "./models.ts";
import {
	DEP_HELD_PROMPT,
	depResumePrompt,
	followUpPrompt,
	grillPrompt,
	handoffMarkdown,
	isRetroProposalReason,
	mergePrompt,
	proposedReason,
	RESEARCH_REPORT,
	rebaseRetryPrompt,
	replyPrompt,
	restartResumePrompt,
	retroReplyPrompt,
	reviewCheckPrompt,
	WORK_CHECK_MAX_SENDBACKS,
	WORK_CHECK_SENDBACK_OPENING,
	workCheckPrompt,
	workCheckSendBack,
	workPrompt,
} from "./prompts.ts";
import { auditProvisioned, rulesDirEntries } from "./provision.ts";
import type { openPullRequest } from "./prs.ts";
import { usageReset } from "./quota.ts";
import type { publishRelease, runReleaseCommand } from "./release.ts";
import { hostedGh, ownerRepo } from "./release.ts";
import type { startRun, WorkerTarget } from "./runner.ts";
import {
	classify,
	deathLine,
	findHttp400Rejection,
	hitUsageLimit,
	MODEL_RESTORE,
	QUOTA_LIMIT,
	rejectedReport,
	resumePlan,
	WORKER_BUSY,
} from "./runner.ts";
import {
	applyCheckVerdicts,
	badDep,
	checkModelWarning,
	checkRoleFor,
	demoteUnquoted,
	depHold,
	depProjectOf,
	depProjectsOf,
	FINDINGS_HOLD,
	findDep,
	findingsHold,
	isRetro,
	isReview,
	lastReviewBase,
	mergeHold,
	openWorkBlockers,
	parseCheckVerdicts,
	parseWorkCheck,
	pickLowPriority,
	pickRunnable,
	reviewFindings,
	selectFindings,
	WORK_CHECK_ASK_BLOCK,
	workCheckAsk,
} from "./scheduler.ts";
import {
	cleanTitle,
	sessionFile,
	sessionHoldsPrompt,
	sessionModel,
} from "./session.ts";
import {
	DEFAULT_SETTINGS,
	type ProjectStore,
	type TaskPatch,
} from "./store.ts";
import { progressKey } from "./stryker.ts";
import type {
	ArchReview,
	DiffFileStat,
	GitFacts,
	LatestImage,
	ListedTask,
	Next,
	OpenPrsView,
	Outcome,
	ProjectSettings,
	QuotaState,
	RecordedFinding,
	RunResult,
	Task,
	Turn,
	TurnKind,
	WorkCheckBlocker,
	WorkCheckRun,
} from "./types.ts";
import {
	FORK_HOLD_REASON,
	MERGE_HOLD_MISMATCH_REASON,
	recommendsSteps,
	UPDATE_HOLD_REASON,
} from "./types.ts";
import { vmState } from "./vmState.ts";
import type { VmTokens } from "./vmTokens.ts";
import type { DetachedRun } from "./workers.ts";

import type {
	ArchReviewDelta,
	branchMergedOrGone,
	branchUnpushed,
	changedFiles,
	checkedOutBranch,
	checkoutState,
	commitsAhead,
	createWorktree,
	diffStat,
	diffText,
	fetchOriginBranch,
	hasRules,
	ignoreInMain,
	isClean,
	isIntegrated,
	mergeHoldLanded,
	mergeHoldMismatch,
	pushBranch,
	rebaseTargetBranch,
	removeWorktree,
	resetBranchTo,
	resolveTarget,
	runMergeGates,
	serverMergePush,
	statusFiles,
	targetContains,
	trackedFiles,
	unsavedWork,
	worktreeHusk,
	worktreeLinked,
} from "./worktree.ts";
import {
	commitSubjects,
	parseKeptChoices,
	planKeptFinish,
	type quarantineUntracked,
	slugify,
	worktreeAnchor,
} from "./worktree.ts";

/** Park reasons the approving reply recognizes and the drawer's hold action bar keys on. */
export { FORK_HOLD_REASON, MERGE_HOLD_MISMATCH_REASON, UPDATE_HOLD_REASON };

/** How long a card whose dispatch vm-runner refused as busy waits before the next try: the
 * busy settle's own schedule() call would otherwise re-dispatch in a tight loop. */
export const VM_BUSY_RETRY_MS = 10_000;

/**
 * OTTR-532: true when the turn runs in a microVM. Only a project with microVM mode on, and
 * only a turn that would reach a worker by today's rules (no merge, retro or board check)
 * whose cwd is the card's own worktree: interview, grill (backlog) and trending turns run in
 * the main checkout, which no VM holds, so they keep the classic pool.
 */
export function microVmTurn(o: {
	microVm: boolean;
	kind: TurnKind;
	retro: boolean;
	boardCheck: boolean;
	task: Pick<Task, "kind" | "stage">;
}): boolean {
	return (
		o.microVm &&
		o.kind !== "merge" &&
		!o.retro &&
		!o.boardCheck &&
		o.task.kind !== "interview" &&
		o.task.kind !== "trending" &&
		o.task.stage !== "backlog"
	);
}

/** Deadline for the prepare-phase titler; surfaced verbatim as the failure cause. */
const TITLE_TIMEOUT_MS = 30_000;
/** Slack on the gateway spawn's kill cap, so the deadline above decides the logged cause. */
const TITLE_TIMEOUT_SLACK_MS = 5_000;

/** Reply heads that mark a model refusal instead of a title (OTTR-538): the titler answered
 * the prompt's content — usually a link — rather than naming the request. Curly apostrophes
 * normalize to straight ones before matching. */
const TITLE_REFUSAL_HEADS = [
	"i can't",
	"i cannot",
	"i can not",
	"i couldn't",
	"i could not",
	"i don't",
	"i do not",
	"i'm unable",
	"i am unable",
	"i'm sorry",
	"i am sorry",
	"sorry",
];

/** Reply heads that name the handoff-reading step instead of the work (OTTR-516, OTTR-570). */
const TITLE_HANDOFF_HEADS = ["read the handoff", "read handoff"];

/** Why a cleaned titler reply is not a title, or null when it is one: at most 8 words, and
 * not a first-person refusal, a file path, or a handoff-reading step. A rejected reply counts
 * as a failure, so the scheduled retry and the run's rename stay the fallback instead of the
 * store freezing a sentence into session_title (nameTask keeps only the first write). */
function titleProblem(title: string): string | null {
	const lower = title.toLowerCase().replace(/[\u2019\u2018]/g, "'");
	if (TITLE_REFUSAL_HEADS.some((head) => lower.startsWith(head)))
		return "refusal reply";
	// OTTR-516: a title that carries a file path names the instruction, not the work.
	if (lower.includes("@/") || lower.includes("/data/") || lower.includes(".md"))
		return "names a file path";
	if (TITLE_HANDOFF_HEADS.some((head) => lower.startsWith(head)))
		return "names the handoff step";
	return title.split(/\s+/).filter(Boolean).length > 8 ? "over 8 words" : null;
}

/** The follow-up tail `followUpPrompt` (src/prompts.ts) appends to a continued task's prompt:
 * the parent title and the handoff path behind the order to read the file. The titler must
 * not see the instruction or the path (OTTR-516): it named cards "Read @/data/…/OTTR-516.md
 * first." instead of naming the work. */
const HANDOFF_TAIL_RE =
	/\n+---\nThis task continues the completed task "(.+?)"\. Read the handoff file first: @\S+\s*$/;

/** Splits the handoff tail off a prompt for titling: `text` is the prompt without the tail,
 * `parentTitle` the continued task's title taken from the tail (null when the prompt is not
 * a follow-up, or the handoff write failed and no tail was appended). */
function splitHandoffTail(prompt: string): {
	text: string;
	parentTitle: string | null;
} {
	const m = HANDOFF_TAIL_RE.exec(prompt);
	if (!m) return { text: prompt, parentTitle: null };
	return {
		text: prompt.slice(0, m.index).trimEnd(),
		parentTitle: m[1] ?? null,
	};
}

/**
 * A short board title for a task prompt, generated by the default model over the auth
 * gateway; null on any failure — the turn then starts unnamed and the run's rename
 * stays the fallback. `onFail` receives the cause (timeout, gateway status, empty reply, a
 * reply that is not a title) for the card log. A follow-up prompt's handoff tail
 * (`followUpPrompt`) is stripped before naming, and the continued task's title rides along as
 * a `Continues:` context line; the handoff path never reaches the model.
 */
export async function generateTitle(
	prompt: string,
	spawn?: SpawnFn,
	onFail?: (cause: string) => void,
	timeoutMs: number = TITLE_TIMEOUT_MS,
): Promise<string | null> {
	if (!prompt.trim()) {
		onFail?.("empty prompt");
		return null;
	}
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const timer = setTimeout(
		() => reject(new Error(`timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	const { text, parentTitle } = splitHandoffTail(prompt);
	runGateway(
		[
			{
				role: "system",
				content:
					'You name tasks. Reply with only a 3-8 word title naming the request, no quotes, no trailing period. You never open links and never need their content: name the request as written, e.g. "Check TikTok link for advice". Name the work itself, never the steps of reading a file or a handoff.',
			},
			// ponytail: the first 1000 chars name almost every task; feed more only when titles come back wrong.
			// The parent title rides above the task text, outside its 1000-char budget.
			{
				role: "user",
				content:
					(parentTitle ? `Continues: ${parentTitle}\n\n` : "") +
					text.slice(0, 1000),
			},
		],
		spawn,
		timeoutMs + TITLE_TIMEOUT_SLACK_MS,
	).then(
		(v) => {
			clearTimeout(timer);
			resolve(v);
		},
		(e) => {
			clearTimeout(timer);
			reject(e);
		},
	);
	try {
		const raw = await promise;
		// Same normalization as the extension's rename tool: one line, collapsed, with the
		// Markdown a titler model echoes stripped. The 80-char cap lands after the shape
		// check, so a longer reply cannot be truncated into a passing title.
		const title = cleanTitle(
			(raw.split("\n")[0] ?? "").trim().replace(/^["']+|["']+$/g, ""),
		);
		if (title === "") {
			onFail?.("empty reply");
			return null;
		}
		const problem = titleProblem(title);
		if (problem !== null) {
			onFail?.(`not a title (${problem})`);
			return null;
		}
		return title.slice(0, 80);
	} catch (err) {
		onFail?.(err instanceof Error ? err.message : String(err));
		return null;
	}
}

/** Wait before the single retry of a failed prepare-phase title generation: short against the
 * run's start, long before omp's own auto titler (~30 minutes or never) names the session. */
const TITLE_RETRY_MS = 20_000;

/**
 * Schedules the one retry of a failed prepare-phase title generation (OTTR-486). Until the
 * retry settles, the store holds the task's transcript title back: omp 18.13.x heads session
 * titles with a card prefix, and a transcript title written meanwhile must not name the
 * card. A later turn that generates again claims the retry through releaseTitleHold, which
 * also cancels this timer, so at most one retry runs.
 */
function scheduleTitleRetry(
	store: ProjectStore,
	id: string,
	prompt: string,
	log: (line: string) => void,
	ops: TurnOps,
	creditBlocked: () => boolean = () => false,
): void {
	const timer = setTimeout(() => {
		void (async () => {
			try {
				const task = store.getTask(id);
				if (task === null || task.cancelledAt !== null) return;
				if (creditBlocked()) {
					log("- title retry skipped: the board is out of credit");
					return;
				}
				let cause = "unknown failure";
				const gen = await (ops.genTitle ?? generateTitle)(
					prompt,
					undefined,
					(c) => {
						cause = c;
					},
				);
				if (gen !== null) {
					store.nameTask(id, gen);
					log(`+ title: ${gen} (retry after a failed first attempt)`);
				} else {
					log(
						`! title retry failed (${cause}); the transcript title, once the run writes one, names the card`,
					);
				}
			} catch {
				// The retry is best-effort: the store may already be closed or the card
				// removed mid-flight (tests, card deletion), and there is nothing to name.
				return;
			} finally {
				store.releaseTitleHold(id);
			}
		})();
	}, ops.titleRetryDelayMs ?? TITLE_RETRY_MS);
	timer.unref();
	store.holdTitle(id, () => clearTimeout(timer));
}

/** OTTR-326: refusal text while another live card parks a merge-hold mismatch whose held head is
 * still the local target tip (its park could not reset the branch); null when the push may run. */
async function heldMergeOnBranchTip(
	store: ProjectStore,
	self: string,
	mainPath: string,
	branch: string | null,
	ops: TurnOps,
): Promise<string | null> {
	if (branch === null) return null;
	const tip = await ops
		.targetSha(mainPath, `refs/heads/${branch}`)
		.catch(() => null);
	if (tip === null) return null;
	const parked = store
		.listTasks()
		.find(
			(t) =>
				t.id !== self &&
				t.cancelledAt === null &&
				t.holdHead !== null &&
				t.needsReason === MERGE_HOLD_MISMATCH_REASON &&
				t.holdHead === tip,
		);
	return parked === undefined
		? null
		: `card #${parked.id} parks a held merge that is still the local tip of refs/heads/${branch} (its park could not reset the branch); resolve that card and reset the branch to origin first`;
}

/** PR mode: the pull request body — the integrated report's summary/details (whichever
 * non-empty), the task id, and a footer naming Ottr as the opener. */
function prBody(task: Task, outcome: Outcome | null): string {
	const report = [outcome?.summary ?? "", outcome?.details ?? ""]
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.join("\n\n");
	return `${report !== "" ? report : "Integrated the card branch."}\n\nTask: ${task.id}\n\n---\n<sub>Opened by [Ottr](https://github.com/ottr-ai/ottr), an AI coding-agent tracker.</sub>`;
}

/** The ready report text a work check judges: the outcome's summary and details, else the
 * run's final message when the agent sent no report. Pure. */
function readyReportText(outcome: Outcome | null, finalText: string): string {
	if (outcome === null) return finalText;
	return [outcome.summary, outcome.details ?? ""]
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.join("\n\n");
}

/** Log marker of the UI-shot guard; a second miss is recognized by finding it in the task log. */
export const UI_SHOT_WARNING =
	"! UI files changed but no screenshot was attached — pass one in report_outcome's shots field";
const STYLE_MARKUP_COMPONENT =
	/\.(css|scss|sass|less|html|tsx|jsx|vue|svelte|astro)$/i;
const UI_FOLDER_CODE = /(^|\/)ui\/.+\.(ts|js|mjs)$/i;
const TEST_FILE =
	/(^|\/)(__tests__|__snapshots__|tests?|e2e)\/|\.(test|spec|stories)\.[^./]+$/i;
/**
 * Changed paths a screenshot can prove, in any project: stylesheets, markup and component files,
 * and code in a ui/ folder. Tests, stories and snapshots never count.
 * ponytail: file-type heuristic; add a per-project glob setting when a UI lives in other files.
 */
export function uiFiles(paths: string[]): string[] {
	return paths.filter(
		(p) =>
			!TEST_FILE.test(p) &&
			(STYLE_MARKUP_COMPONENT.test(p) || UI_FOLDER_CODE.test(p)),
	);
}
const listed = (files: string[]): string =>
	`${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}`;
/** Reply the tracker sends to resume the session when the UI-shot guard fires on a clean settle. */
function uiShotReprompt(files: string[]): string {
	return `Your last turn changed UI files (${listed(files)}) but attached no screenshot. Run the project's UI the way its AGENTS.md or README says, capture the changed screen with the browser tool, save the image under shots/ in the worktree, and call report_outcome again with its path in the shots field. A change without a visible effect still needs a screenshot of the screen it belongs to: the card cannot finish without one.`;
}

/** OTTR-708: snapshots every other project's main checkout (HEAD + porcelain status) before a
 * work turn's agent runs. Gitless projects and checkouts whose read fails are skipped. */
async function snapshotOtherCheckouts(
	projects: Map<string, TurnProject>,
	ops: TurnOps,
	self: string,
): Promise<Map<string, { head: string | null; status: string }>> {
	const snap = new Map<string, { head: string | null; status: string }>();
	for (const other of projects.values()) {
		if (other.name === self || other.gitless) continue;
		try {
			snap.set(other.name, await ops.checkoutState(other.path));
		} catch {
			// An unreadable checkout is skipped: the guard reports only what it can prove.
		}
	}
	return snap;
}

/** OTTR-708: the cross-project checkout guard. Compares the before/after main-checkout
 * snapshots of the other projects: a new commit the board did not make, or a status change,
 * is a change made outside this turn's own worktree. A HEAD advance the board's own merge
 * machinery made is discounted with a clean tree: the merge settle records the head it left
 * behind whatever path it took (pushed, failed, rejected, skipped, refused, hold park with
 * a branch reset), and a project whose own merge turn is in flight is skipped outright —
 * its main checkout belongs to that turn right now. Merges of other projects run
 * concurrently with work turns by design. Returns the needs_you reason, null when every
 * other checkout reads unchanged. */
async function checkoutGuardReason(
	projects: Map<string, TurnProject>,
	ops: TurnOps,
	boardPushedHeads: Map<string, string>,
	self: string,
	before: Map<string, { head: string | null; status: string }>,
): Promise<string | null> {
	for (const other of projects.values()) {
		if (other.name === self || other.gitless) continue;
		// The other project's own merge turn is mid-flight: its agent fast-forwards its
		// main checkout legitimately, and the settle records the head it advanced. Skip
		// the project until that turn is over.
		const mergingInFlight = other.store
			.listTasks()
			.some((t) => t.stage === "merging" && t.state === "running");
		if (mergingInFlight) continue;
		const was = before.get(other.name);
		if (was === undefined) continue;
		const now = await ops.checkoutState(other.path).catch(() => null);
		if (now === null) continue;
		const headMoved = now.head !== null && now.head !== was.head;
		const recorded = headMoved && boardPushedHeads.get(other.name) === now.head;
		const files =
			now.status !== was.status
				? now.status
						.split("\n")
						.map((l) => l.slice(3).trim())
						.filter((l) => l !== "")
				: [];
		if (files.length === 0 && (!headMoved || recorded)) continue;
		const commits =
			headMoved && was.head !== null
				? await (ops.commitSubjects ?? commitSubjects)(
						other.path,
						was.head,
						now.head!,
					).catch(() => [] as string[])
				: [];
		const parts: string[] = [];
		if (headMoved && !recorded)
			parts.push(
				commits.length > 0
					? `new commits ${listed(commits)}`
					: `HEAD moved to ${now.head!.slice(0, 7)}`,
			);
		if (files.length > 0) parts.push(`changed files ${listed(files)}`);
		return `The ${other.name} main checkout changed while this turn ran (${parts.join("; ")}). Those changes do not belong to this card: file a card in ${other.name} (create_task with its project parameter) and move the commits and files there, then reply to resume this card.`;
	}
	return null;
}

export interface TurnProject {
	store: ProjectStore;
	/** Project name (the Map key); supervisor log lines and CI watch key off it. */
	name: string;
	path: string;
	target: string | null;
	/** Main checkout is not a git repository with a commit yet; every action waits for init. */
	gitless: boolean;
	/** GitHub remote URL, resolved once at registration; null when the project has none. */
	github: string | null;
	/** OTTR-675: true when the last branch-rules probe of the target found a pull_request
	 * rule (the probe runs where the GitHub remote resolves: add, init, settings save).
	 * Advisory only: the project view folds it with the prMode setting into the PR-mode
	 * suggestion. A failed or 404 probe keeps it false. */
	protectedTarget: boolean;
	/** HTTPS form of the origin push remote on any host, resolved once at registration beside
	 * github; null when the project has none. Icon adoption reads this. */
	remote: string | null;
	/** Main checkout has uncommitted changes; refreshed by the scheduler tick, read-only elsewhere. */
	dirty: boolean;
	/** OTTR-506: true while the local target branch has commits origin lacks — the state a
	 * rejected server push leaves main in. Refreshed by the scheduler tick's branchUnpushed
	 * check like dirty, and set eagerly by the turn that saw the rejection or landed the
	 * repairing push, so the merge hold gates the very next tick. Read-only elsewhere. */
	mainUnpushed: boolean;
	/** OTTR-531: the main checkout's checked-out branch; null when detached, gitless, or git
	 * failed. Refreshed by the scheduler tick like dirty and mainUnpushed (a failed check
	 * keeps the last value); the off-default banner and turn finding read it. */
	mainBranch: string | null;
	/** Latest release: the repo's latest GitHub release (its name when the tag is not
	 * `vX.Y.Z`), else the highest `vX.Y.Z` tag merged into the target; refreshed by the
	 * scheduler tick, read-only elsewhere. */
	latestRelease: string | null;
	/** Web page of the latest GitHub release when the chip shows its name (a non-`vX.Y.Z`
	 * release); null when the chip shows a tag and links `releases/tag/<tag>`. Refreshed
	 * beside latestRelease, read-only elsewhere. */
	latestReleaseUrl?: string | null;
	/** Public ghcr.io image of the repo; probed on a TTL by the scheduler tick, read-only elsewhere. */
	latestImage: LatestImage | null;
	/** Open pull requests on the GitHub repo, newest first; probed on a TTL by the
	 * scheduler tick (server.ts's refreshOpenPrs), read-only elsewhere. null with no
	 * GitHub remote, before the first probe, or when gh fails. */
	openPrs?: OpenPrsView | null;
	/** Commits since the last arch review on the target; refreshed by the scheduler tick, read-only elsewhere. */
	archReview: ArchReview | null;
}

type RunEntry = {
	pid: number | null;
	done: Promise<unknown>;
	kill(): Promise<void>;
	/** Set by sweepLostTurns once the pid proved dead: the turn row is settled, so a late `done`
	 * must return without touching the store. */
	abandoned?: boolean;
	/** Live Stryker progress of the run (stryker.ts); the card shows it while the entry lives. */
	progress?: string;
	/** The moving part (stryker.ts progressKey) of the current progress text; undefined when
	 * the text carries no numbers (a lock wait, bare "Stryker running"). */
	progressKey?: string;
	/** When the progress's moving part (progressKey) last changed: the live activity the
	 * silent-log warning reads beside the log mtime. Undefined until the first numbered status. */
	progressAt?: number;
	/** The dispatched worker's url; absent for a server-local run. runnerTurns() buckets by it. */
	url?: string;
	/** The worker run id; absent for a server-local or microVM run. The System view keys the
	 * turn's memory and CPU (GET /stats `runs`) by it. */
	runId?: string;
};

export interface TurnOps {
	extensionPath: string;
	/** Where the task sessions' create_task tool reaches the board (loopback unless OTTR_BOARD_URL overrides it), and the boot token it presents there. */
	board: { url: string; token: string };
	maxTotalRuns(): number | null;
	/** The board's review-check switch (POST /api/settings); absent counts as on, so test fakes need nothing. */
	reviewCheck?: () => boolean;
	/** The board's work-check switch (POST /api/settings); absent counts as on, so test fakes need nothing. */
	workCheck?: () => boolean;
	/** Role → selector map the check run's model resolves from; overridable for tests. */
	modelRoles?: typeof modelRoles;
	/** Prepare-phase title generator; overridable for tests. */
	genTitle?: (
		prompt: string,
		spawn?: SpawnFn,
		onFail?: (cause: string) => void,
	) => Promise<string | null>;
	/** Delay before the single retry of a failed title generation (OTTR-486); overridable for tests. */
	titleRetryDelayMs?: number;
	/** Commit subjects on the target since a base, for the check run's input; overridable for tests. */
	commitSubjects?: typeof commitSubjects;
	/** True while an update holds new turns (POST /api/drain): running turns finish, nothing new starts. */
	drained(): boolean;
	/** OTTR-454: true while a per-runner hold covers this runner id (a worker hostname or "local"). */
	drainedRunner(id: string): boolean;
	publishSoon(): void;
	notifyLog(project: string, id: string): void;
	refreshRelease(e: TurnProject): Promise<void>;
	refreshArchReview(e: TurnProject): Promise<void>;
	/** OTTR-691: stamps the header's open-PR chips (server.ts, one gh probe per TTL per
	 * repo, fire-and-forget like the image chip); absent in test fakes, so the tick must
	 * call it optional. */
	refreshOpenPrs?(e: TurnProject): void;
	resolveTarget: typeof resolveTarget;
	createWorktree: typeof createWorktree;
	removeWorktree: typeof removeWorktree;
	commitsAhead: typeof commitsAhead;
	changedFiles: typeof changedFiles;
	diffStat: typeof diffStat;
	diffText: typeof diffText;
	isClean: typeof isClean;
	isIntegrated: typeof isIntegrated;
	unsavedWork: typeof unsavedWork;
	statusFiles: typeof statusFiles;
	worktreeHusk: typeof worktreeHusk;
	worktreeLinked: typeof worktreeLinked;
	ignoreInMain: typeof ignoreInMain;
	branchMergedOrGone: typeof branchMergedOrGone;
	quarantineUntracked: typeof quarantineUntracked;
	trackedFiles: typeof trackedFiles;
	hasRules: typeof hasRules;
	targetCommits(
		mainPath: string,
		target: string | null,
	): Promise<number | null>;
	targetSha(mainPath: string, ref: string): Promise<string | null>;
	/** AGEN-24: true when target already contains sha (the approved hold head landed). */
	targetContains: typeof targetContains;
	/** OTTR-506: true while the local target branch has commits origin lacks (the merge hold's git fact). */
	branchUnpushed: typeof branchUnpushed;
	/** OTTR-531: the main checkout's checked-out branch; null on detached HEAD or git failure. */
	checkedOutBranch: typeof checkedOutBranch;
	/** OTTR-708: a main checkout's HEAD sha and porcelain status; the cross-project checkout
	 * guard snapshots it before and after a work turn's agent runs. */
	checkoutState: typeof checkoutState;
	/** Server-side merge push for non-GitHub push remotes (git() adds the host auth, D6). */
	serverMergePush: typeof serverMergePush;
	/** Git 401/403 hint: asks GitHub's API why a GitHub-host push/fetch failed; null when it cannot say more. */
	githubAuthHint: (url: string) => Promise<string | null>;
	/** OTTR-394: fetches the target branch from the pinned origin so a queued rebase turn rebases onto the moved tip (git() adds the host auth). */
	fetchOriginBranch: typeof fetchOriginBranch;
	/** OTTR-510: the automatic push-race retry rebases the local target branch onto the fetched
	 * origin tip and runs the merge gates (bun run check, bun test) in the main checkout before
	 * the server pushes again, so the automatic path skips no gate; a rebase conflict, failed
	 * gates, or a still-rejected retry push is what queues the recovery steer. */
	rebaseTargetBranch: typeof rebaseTargetBranch;
	runMergeGates: typeof runMergeGates;
	/** OTTR-465: the credential kinds the server's git can use for a push to a URL (a card-log line, never a value); null for a non-URL pin. */
	pushAuthKind?: (url: string) => string | null;
	/** PR mode: pushes the card branch to the pinned origin from the main checkout (same plumbing as serverMergePush). */
	pushBranch?: typeof pushBranch;
	/** PR mode: adopts or opens the pull request for the card branch (gh via runGh). */
	openPr?: typeof openPullRequest;
	/** PR mode: the integrated proof — clean worktree tree and origin/<target> an ancestor of HEAD. */
	prIntegrated?: (
		mainPath: string,
		worktreePath: string,
		target: string,
	) => Promise<boolean>;
	/** OTTR-465: wait before the single origin-unchanged push retry (default 30 s); tests pass 0. */
	pushRetryDelayMs?: number;
	/** OTTR-274: true when the push set of a hold-approved merge carries patches beyond the approval. */
	mergeHoldMismatch: typeof mergeHoldMismatch;
	/** VELV-89: true when a hold-approved merge already landed on the fetched remote target and the approval carries no extra patches. */
	mergeHoldLanded: typeof mergeHoldLanded;
	/** OTTR-326: on a mismatch park, moves the main checkout's target branch back to the audited tip. */
	resetBranchTo: typeof resetBranchTo;
	pidAlive: typeof pidAlive;
	/** Parsed once at boot from OTTR_WORKER_URLS; null = local spawn. Merge turns never use it (D6). */
	workerTarget?: WorkerTarget | null;
	/** OTTR-532: parsed once at boot from OTTR_VM_RUNNER_URL; null = no microVM runner. A
	 * microVM project's eligible turns go here only, never to workerTarget or the server. */
	vmTarget?: WorkerTarget | null;
	/** OTTR-532: the board's one per-turn VM token store; startRun issues, settle revokes. */
	vmTokens?: VmTokens;
	/** OTTR-532: resets the server worktree to the head a microVM pushed (src/gitHttp.ts). */
	syncWorktreeTo?: (worktree: string, sha: string) => Promise<void>;
	/** OTTR-454: asks a worker for the runs its restart detached; absent (tests, local spawn) keeps the re-bind off. */
	detachedRuns?: (url: string, token: string) => Promise<DetachedRun[]>;
	/** OTTR-454: kills a detached run on its worker (/detach/kill). */
	killDetached?: (
		url: string,
		token: string | undefined,
		id: string,
	) => Promise<void>;
	startRun: typeof startRun;
	/** OTTR-693: the commit identity Settings names; null keeps the built-in Ottr default. */
	commitIdentity?: () => CommitIdentity | null;
	/** Installs the project's package list (apt.txt from the data repo) on this machine; returns log lines. */
	ensurePackages: typeof ensureProjectPackages;
	/**
	 * The turn's env values and listed-but-valueless names (Settings values + env.txt lists): every
	 * turn, worker dispatched or not. `model` is the worker turn's execution model (null for a
	 * local run): its provider's sign-in token is lent. A `credentialError` stops the turn.
	 */
	turnEnv?: (
		project: string,
		model: string | null,
	) => Promise<{
		env: Record<string, string>;
		missing: string[];
		credentialError?: string | null;
		/** The credential error was a busy board store: a reply retries, no new sign-in. */
		busy?: boolean;
		/** Values the run redacts from its log (the lent provider token). */
		secrets?: string[];
	}>;
	/** Tools install lines and the PATH link dir for local runs only (a worker builds its own). */
	prepareTurn?: (project: string) => Promise<{
		lines: string[];
		pathDir: string | null;
	}>;
	/** Override for tests: where findHttp400Rejection reads omp's HTTP-400 request log. */
	http400Dir?: string;
	publishRelease: typeof publishRelease;
	runReleaseCommand: typeof runReleaseCommand;
	archReviewDelta(
		mainPath: string,
		target: string,
		lastReview: string | null,
	): Promise<ArchReviewDelta | null>;
	/** Provider usage limits (`omp usage`), so a check that hit a limit waits for its reset; absent = unknown. */
	quota?: () => Promise<QuotaState>;
	/** Hosted mode (docs/specs/hosted-mode.md): metering reports, the credit gate and hosted wording; undefined on every self-hosted board. */
	hosted?: Hosted;
	/** Hosted interim metering interval in ms; tests only, default METERING_INTERVAL_MS. */
	meteringIntervalMs?: number;
}

/**
 * The card's reason for a credential-stopped turn: a busy store names the retry (the sign-in is
 * not the cause), any other credential fault says to sign in again.
 */
function signInNeedsReason(
	credentialError: string | null | undefined,
	busy: boolean,
): string {
	const cause = credentialError || "the board cannot lend a credential";
	return busy
		? `Sign-in: ${cause}. The turn did not start. Reply to retry; do not sign in again.`
		: `Sign-in: ${cause}. The turn did not start. Sign in again under Settings, Provider sign-in, then reply to retry.`;
}

// ponytail: module-level notify hook so exported appendLog keeps its 3-arg
// signature for server.ts call sites; one loop per process sets it.
let notifyHook: (project: string, id: string) => void = () => {};

/**
 * OTTR-532: writes a microVM turn's handed-back files into the server worktree. Only
 * `research-report.md` and paths under `shots/` are accepted: relative, no `..` segment, and
 * written through writeBelow, which refuses a symlink at the file or any parent. Anything else
 * is skipped and logged.
 */
export function writeVmFiles(
	worktree: string,
	files: readonly { path: string; b64: string }[],
	log: (line: string) => void,
): void {
	for (const f of files) {
		const segs = f.path.split("/");
		const allowed =
			!f.path.includes("\\") &&
			!segs.some((s) => s === ".." || s === "." || s === "") &&
			(f.path === RESEARCH_REPORT || (segs[0] === "shots" && segs.length > 1));
		if (!allowed) {
			log(`! microVM: refusing handed-back file ${JSON.stringify(f.path)}`);
			continue;
		}
		try {
			writeBelow(
				worktree,
				join(worktree, ...segs),
				Buffer.from(f.b64, "base64"),
			);
		} catch (err) {
			log(`! microVM: writing ${f.path} failed: ${errmsg(err)}`);
		}
	}
}

export function appendLog(store: ProjectStore, id: string, line: string): void {
	writeBelow(store.dataRoot, store.logPath(id), `${line}\n`, "append");
	notifyHook(store.name, id);
}

/** Longest provider error a check failure message shows; a gateway can return a whole JSON body. */
const PROVIDER_ERROR_MAX = 300;

/** Why a review check run failed and must retry, else null: a stopped run, a non-zero exit, or
 * one that ended without a final message to parse. The stderr cause comes from deathLine, so
 * omp's recovery hints lose to the error line; with no stderr line, the provider's redacted
 * error (OTTR-670), cut to one line. Verdict JSON problems surface in runTurn. */
export function checkRunError(r: RunResult): string | null {
	if (r.killed) return "the check run was stopped";
	if (r.exitCode !== 0) {
		const last = deathLine(r.stderrTail) ?? oneLine(r.providerError ?? "");
		const provider = /^No API key found for (.+)$/.exec(last)?.[1];
		if (provider)
			return `the check run exited with code ${r.exitCode}: ${provider} has no usable sign-in. Sign in again under Settings, then reply to re-run the check`;
		if (hitUsageLimit(r))
			return `the check run exited with code ${r.exitCode}: the provider usage limit is reached. Reply after the limit resets to re-run the check`;
		return `the check run exited with code ${r.exitCode}${last ? `: ${last}` : ""}`;
	}
	if (r.finalText.trim() === "")
		return "the check run ended without a final message";
	return null;
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > PROVIDER_ERROR_MAX
		? `${line.slice(0, PROVIDER_ERROR_MAX - 1)}…`
		: line;
}

/** The queued write that holds a check run until its provider's usage limit resets. */
interface UsageHold {
	holdUntil: number;
	needsReason: string;
	pendingPrompt: string;
	/** The provider (and window id) the hold waits for, stored beside holdUntil so the
	 * quota refresh can release the hold early (OTTR-688). */
	provider: string;
	window: string | null;
}

const KEPT_PREFIX = "Kept the worktree: ";
const demoBoard = () => process.env.OTTR_DEMO === "1";
const CANCEL_KEPT_PREFIX = "Cancel kept the worktree: ";
// OTTR-394: automatic rebase retries a card may spend when a merge push is rejected
// because origin moved. Beyond the budget the card parks at needs_you with git's reason.
const MERGE_PUSH_RETRIES = 2;
// OTTR-465: wait before the single origin-unchanged push retry; a transient failure (a
// dropped connection, a token-refresh hiccup) clears in seconds. ALAT-60's failed push
// landed unchanged on a later merge turn.
const MERGE_PUSH_RETRY_WAIT_MS = 30_000;
// ponytail: a fixed cap on the archived research report; raise it when a real report hits it.
const REPORT_MAX_BYTES = 4 * 1024 * 1024;
/** The park reason of a stopped turn (the board's Esc). */
const TURN_STOPPED_REASON =
	"Turn stopped. Reply to continue the session, Resume to rerun it, or cancel the card.";
/** Hosted mode: how long a card waits after the control plane could not answer the credit gate. */
export const CREDIT_RETRY_MS = 60_000;
export const CREDIT_CHECK_FAILED =
	"Could not check the credit balance; retrying in a minute.";
const NO_USAGE: TokenUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
};

/** Hosted metering (docs/specs/hosted-mode.md section 4): sends one record. reportUsage is
 * fire-and-forget; a throw is logged and never fails the run or the settle. */
function sendMetering(
	hosted: Hosted,
	record: Omit<MeteringRecord, "tenant">,
): void {
	try {
		hosted.hooks.reportUsage({ tenant: hosted.config.tenant, ...record });
	} catch (err) {
		console.log(`${record.project}: ! metering report failed: ${errmsg(err)}`);
	}
}

/** The run key of a metering record: everything but the usage, the model and `final`. */
type MeteringKey = Pick<
	MeteringRecord,
	"project" | "taskId" | "turnId" | "kind" | "role" | "run"
>;

/** One settled agent run of a turn, as its final metering record carries it. `main` marks the
 * turn's own work/merge run, whose final record also carries the card outcome and title (M10). */
type MeteredRun = Pick<MeteringRecord, "run" | "role" | "model" | "usage"> & {
	main?: boolean;
};

/** The interim metering of one active run (interimMeter). */
interface InterimMeter {
	/** startRun's onUsage: the run's cumulative usage after a change. */
	onUsage(usage: TokenUsage, model: string | null): void;
	/** The run ended: no interim record goes out after this. */
	close(): void;
}

/**
 * Hosted interim metering (docs/specs/hosted-mode.md section 4) of one active run: the run's
 * cumulative usage as an interim record (final: false), at most one each `intervalMs`. A change
 * inside the interval goes out when the interval ends, with the newest usage. `key` is null
 * while the turn row does not exist yet; the send then waits one more interval. close() at the
 * run's end drops what is pending: the run's final record at settle carries it.
 */
function interimMeter(
	hosted: Hosted,
	key: () => MeteringKey | null,
	intervalMs: number,
): InterimMeter {
	let pending: { usage: TokenUsage; model: string | null } | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const flush = (): void => {
		timer = undefined;
		if (closed || pending === null) return;
		const k = key();
		if (k === null) {
			timer = setTimeout(flush, intervalMs);
			return;
		}
		lastAt = Date.now();
		const { usage, model } = pending;
		pending = null;
		sendMetering(hosted, { ...k, model, usage, final: false });
	};
	return {
		onUsage(usage, model) {
			if (closed) return;
			pending = { usage, model };
			if (timer !== undefined) return;
			const wait = lastAt + intervalMs - Date.now();
			if (wait <= 0) flush();
			else timer = setTimeout(flush, wait);
		},
		close() {
			closed = true;
			pending = null;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** The queue text of an owner reply: under a steer queued before the park; Resume (".")
 * sends that steer alone. */
export function queuedReply(pending: string | null, next: string): string {
	return pending === null
		? next
		: next === "."
			? pending
			: `${pending}\n\n${next}`;
}

/**
 * The queue write of a plain owner reply to a needs_you card (POST .../reply), also of the
 * hosted credit release (docs/specs/hosted-mode.md section 5), which sends Resume ("."). The
 * next turn resumes the card's session with the text. `images`: the reply's saved images.
 * `by`: the author when no text is queued yet; queued text keeps today's author rule. The
 * release passes "supervisor", so its "." is not a user message that overrides the
 * usage-limit start gate.
 */
export function replyPatch(
	task: Pick<Task, "pendingPrompt" | "pendingBy" | "pendingImages">,
	text: string,
	images: readonly string[] = [],
	by: "user" | "supervisor" = "user",
): TaskPatch {
	return {
		pendingPrompt: queuedReply(task.pendingPrompt, text),
		pendingBy:
			task.pendingPrompt === null
				? by
				: task.pendingBy === "supervisor"
					? "supervisor"
					: "user",
		pendingImages: [...task.pendingImages, ...images],
		state: "queued",
		holdUntil: null,
		queuedAt: Date.now(),
		needsReason: null,
		asked: null, // the answer to a "?" ask is queued; the badge goes back to plain needs-you flow
	};
}

export function keptReason(unsaved: string): string {
	return `${KEPT_PREFIX}${unsaved}. Reply to continue, or Cancel to delete it.`;
}

/** The needsReason a cancel writes when it kept the worktree (cancelTask's kept path). */
export function cancelKeptReason(unsaved: string): string {
	return `${CANCEL_KEPT_PREFIX}${unsaved}`;
}

/** True when a card's needsReason came from a keep (a cancel or a finished turn that left files). */
export function isKeptReason(reason: string | null): boolean {
	return (
		reason !== null &&
		(reason.startsWith(KEPT_PREFIX) || reason.startsWith(CANCEL_KEPT_PREFIX))
	);
}

/** Moves the named files from a task's images dir into quarantineDir (never deletes); returns the
 * moved names. root is the trusted anchor for both dirs (see src/confine.ts). */
function quarantineImageFiles(
	root: string,
	imagesDir: string,
	quarantineDir: string,
	names: readonly string[],
): string[] {
	const moved: string[] = [];
	for (const name of names) {
		try {
			renameBelow(root, join(imagesDir, name), join(quarantineDir, name));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		moved.push(name);
	}
	return moved;
}

/** First version string in an integrate report, e.g. "v0.28.2"; null when the report names none. */
export function parseReleaseVersion(text: string): string | null {
	return (
		/\bv\d+(?:\.\d+)+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/.exec(text)?.[0] ??
		null
	);
}

/** Last `topic:` line in a turn report, whitespace-collapsed, trailing period gone, max 40 chars; null when the report names none. */
export function parseTopicReport(
	details: string | null | undefined,
): string | null {
	if (!details) return null;
	const matches = [...details.matchAll(/^topic:\s*(.+)$/gim)];
	if (matches.length === 0) return null;
	const topic = (matches.at(-1)?.[1] ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.$/, "")
		.trim();
	return topic.slice(0, 40).trim() || null;
}

/** The timeline's model cell: the transcript records the bare provider/model, so the
    thinking level is re-attached from the selector the turn ran with — but only when
    the bases match, never onto a model the selector cannot have resolved to. */
export function turnModel(
	model: string | null,
	selector: string | null,
): string | null {
	if (model === null || selector === null) return model;
	const [base, level] = splitLevel(selector);
	return level !== "" && splitLevel(model)[0] === base
		? joinLevel(model, level)
		: model;
}

/** The dispatched selector when the run served a different model's base — the provider-error
 * fallback omp's retry chain performs. A thinking-level difference alone is not a swap (the
 * transcript records the bare model), and an unknown side proves nothing. Null = no swap. */
export function modelSwap(
	served: string | null,
	dispatched: string | null,
): string | null {
	if (served === null || dispatched === null) return null;
	return splitLevel(served)[0] === splitLevel(dispatched)[0]
		? null
		: dispatched;
}

/** Logs a project store's failure at most once per 10 minutes per project: diagnosable, not spam. */
const lastStoreErrorAt = new Map<string, number>();
export function logStoreError(name: string, err: unknown): void {
	const now = Date.now();
	if (now - (lastStoreErrorAt.get(name) ?? 0) < 600_000) return;
	lastStoreErrorAt.set(name, now);
	console.error(`project ${name}:`, err);
}

/**
 * getSettings that cannot take the scheduler down: a store whose database hiccups
 * (locked file, recovering WAL, missing table) logs once per window with the project
 * name and returns defaults, so one sick project never blocks the others.
 */
export function getSettingsLogged(e: TurnProject): ProjectSettings {
	try {
		return e.store.getSettings();
	} catch (err) {
		logStoreError(e.store.name, err);
		return structuredClone(DEFAULT_SETTINGS);
	}
}

export type CancelOutcome =
	| { kept: string }
	| { removed: true }
	| { error: string; status: 409 };
export type StopOutcome = { ok: true } | { error: string; status: 404 | 409 };
export type FinishKeptOutcome =
	| { ok: true }
	| { error: string; status: 400 | 404 | 409 };

/** The engine handle the server binds: scheduler ticks, live-run kills, boot recovery. */
export interface TurnLoop {
	schedule(): void;
	runTurn(name: string, id: string): Promise<void>;
	cancel(e: TurnProject, id: string, force: boolean): Promise<CancelOutcome>;
	/** Stops the running turn without cancelling the task (the board's Esc). */
	stopTurn(e: TurnProject, id: string): Promise<StopOutcome>;
	/** Hosted mode: sets the credit hold and stops every turn in flight (work or merge runs like
	 * stopTurn, check runs, turns before their run), parks each card with the credit reason, and
	 * resolves to the number stopped. */
	creditStop(): Promise<number>;
	/** Hosted mode: the release after a top-up. Clears the credit hold and queues every needs_you
	 * card that the credit stop or gate parked, like an owner Resume ("."); resolves to the number
	 * queued. */
	creditRelease(): Promise<number>;
	finishKept(
		e: TurnProject,
		id: string,
		choices: unknown,
	): Promise<FinishKeptOutcome>;
	readonly running: Map<string, RunEntry>;
	/** OTTR-454: live runs per runner (worker hostname buckets via entry.url, else local) plus the preparing count. */
	runnerTurns(): {
		local: number;
		workers: Record<string, number>;
		preparing: number;
	};
	/** Boot restart sweep: settle open rows left by a dead tracker process and requeue. */
	recoverRestarted(): Promise<void>;
}

export function createTurnLoop(
	projects: Map<string, TurnProject>,
	ops: TurnOps,
): TurnLoop {
	notifyHook = ops.notifyLog;
	const running = new Map<string, RunEntry>();
	// OTTR-708: the main-checkout heads the board's own merge machinery advanced, per
	// project — recorded once at the end of a merge settle, whatever path it took (the
	// merge agent fast-forwards the main checkout before the push; the settle may reset
	// the branch on a hold park; the push can fail, be rejected, be skipped, or be
	// refused by a held merge). The cross-project checkout guard discounts a HEAD change
	// whose new value is recorded here and leaves the tree clean, and skips a project
	// whose own merge turn is in flight: merges of other projects run concurrently with
	// this project's work turns by design.
	const boardPushedHeads = new Map<string, string>();
	/** The queued write for a check that hit a usage limit with a known reset, else null (the caller parks needs_you). */
	async function usageHold(model: string | null): Promise<UsageHold | null> {
		const hit = await usageResetFor(model);
		if (hit === null) return null;
		const at = new Date(hit.resetsAt)
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");
		return {
			holdUntil: hit.resetsAt,
			needsReason: `The check hit the ${hit.provider} usage limit. The board runs it again after the limit resets at ${at} UTC. Send a message to run it now, or cancel the card.`,
			pendingPrompt: `The board's check run stopped at the ${hit.provider} usage limit, and the limit has reset. Report the same outcome again so the board runs the check again. A review records each finding again with propose_task first.`,
			provider: hit.provider,
			window: hit.window,
		};
	}
	/** The dispatched model's provider's exhausted-window reset from the board's quota state
	 * (ops.quota is optional and may be absent in tests): null when nothing is known. */
	async function usageResetFor(model: string | null): Promise<{
		provider: string;
		resetsAt: number;
		window: string | null;
	} | null> {
		const q = await ops.quota?.().catch(() => null);
		return q ? usageReset(q.limits, model, Date.now()) : null;
	}
	/** The write that holds card `id`, or null when the card is no longer this run's: a cancel or
	 * kept-worktree cancel may land during the quota await and owns the state then. Text the user
	 * queued meanwhile stays ahead of the hold's own prompt. */
	function holdPatch(store: ProjectStore, id: string, hold: UsageHold) {
		const cur = store.getTask(id);
		if (
			cur === null ||
			cur.cancelledAt !== null ||
			(cur.state !== "running" && cur.state !== "preparing")
		)
			return null;
		return {
			stage: "in_progress" as const,
			state: "queued" as const,
			queuedAt: Date.now(),
			holdUntil: hold.holdUntil,
			holdProvider: hold.provider,
			holdWindow: hold.window,
			needsReason: hold.needsReason,
			pendingPrompt:
				cur.pendingPrompt === null
					? hold.pendingPrompt
					: `${cur.pendingPrompt}\n\n${hold.pendingPrompt}`,
			// A hold appended under queued user text keeps that text's authorship; a fresh
			// hold park is the board's own voice.
			pendingBy: cur.pendingPrompt === null ? "supervisor" : cur.pendingBy,
		};
	}
	/** Hosted credit gate (docs/specs/hosted-mode.md section 5). runTurn calls it right after its
	 * synchronous claim and before anything spends a model token (title, run, check): an await
	 * before the claim would let one schedule tick pass every queued card through the caps. True:
	 * the turn starts. False: the card parked with the credit reason, or went back to the queue
	 * held for CREDIT_RETRY_MS when the control plane gave no answer, or unheld when a
	 * creditRelease ran during a call that answered no credit. A cancel that landed during
	 * the call owns the card and gets no write. */
	async function creditGate(
		hosted: Hosted,
		store: ProjectStore,
		claimed: Task,
		log: (line: string) => void,
	): Promise<boolean> {
		let ok: boolean;
		// A gate call that started before a creditStop must not clear that stop's hold.
		const stopsBefore = creditStops;
		// A false answer that started before a creditRelease must not park the card: the
		// release skipped it while it was preparing, and no later release comes.
		const releasesBefore = creditReleases;
		let failure: string | null = null;
		try {
			ok = await hosted.hooks.creditOk();
		} catch (err) {
			ok = false;
			failure = errmsg(err);
		}
		if (ok) {
			if (stopsBefore === creditStops) creditHold = false;
			return true;
		}
		const cur = store.getTask(claimed.id);
		if (cur === null || cur.cancelledAt !== null || cur.state !== "preparing")
			return false;
		if (failure !== null) {
			log(`! credit check failed: ${failure}`);
			// Back to the queue as before the claim, held so the scheduler asks again in a minute.
			// Not a usage hold: holdProvider stays null so the quota refresh never releases it.
			store.updateTask(claimed.id, {
				state: "queued",
				holdUntil: Date.now() + CREDIT_RETRY_MS,
				holdProvider: null,
				holdWindow: null,
				needsReason: CREDIT_CHECK_FAILED,
				asked: claimed.asked,
			});
		} else if (releasesBefore !== creditReleases) {
			log("- credit released during the credit check: the card checks again");
			// Back to the queue unheld, so the next schedule tick asks the gate again.
			store.updateTask(claimed.id, {
				state: "queued",
				holdUntil: null,
				holdProvider: null,
				holdWindow: null,
				asked: claimed.asked,
			});
		} else {
			log("- turn not started: the board is out of credit");
			store.updateTask(claimed.id, {
				state: "needs_you",
				needsReason: hosted.config.wording.creditReason,
			});
		}
		return false;
	}

	/** Claimed runs, from the synchronous claim to the settle writes: the key overlaps `running`
	 * once startRun returns, so the cap counts distinct keys, never the two sets' summed sizes.
	 * The claim also covers a run whose `done` resolved while its settle awaits git (row open,
	 * `running` entry gone, pid dead): sweepLostTurns leaves it to runTurn. */
	const preparing = new Set<string>();
	/** Keys a stop-turn request marked, with the park reason: runTurn consumes the mark at
	 * settle, so a kill from stopTurn settles the card as stopped instead of leaving it to
	 * cancelTask. */
	const stopping = new Map<string, string>();
	/** Hosted credit hold (docs/specs/hosted-mode.md section 5): creditStop sets it, and only a
	 * gate's creditOk() call that started after the last creditStop and answered true clears it.
	 * While it is set, no hosted model run starts. */
	let creditHold = false;
	/** The number of creditStop calls, so a gate answer older than a stop keeps the hold. */
	let creditStops = 0;
	/** The number of creditRelease calls, so a false gate answer older than a release does not
	 * park the card that the release skipped while it was preparing. */
	let creditReleases = 0;
	/** Turns ("project/id") that creditStop stopped: a work or merge run, a check run, or a turn
	 * in its prepare or settle awaits. The turn parks with the credit reason at its next model
	 * dispatch point or check settle; the key's next claim clears the mark. */
	const creditStopped = new Set<string>();
	/** Release cards whose irreversible publish has begun, from the fresh no-cancel check in
	 * publishReleaseCard to the caller's final card write: cancel refuses these keys, so a
	 * cancel can neither lose to the tag/push nor be overwritten by "Released". */
	const publishing = new Set<string>();
	/** OTTR-454: worker runs re-bound after a restart, keyed "project/id". The sweep polls each
	 * one and cancel kills it; nothing persists, so a server restart re-registers them from the
	 * workers' answers in recoverRestarted. */
	const detached = new Map<string, { url: string; runId: string }>();
	/** OTTR-532: "project/id" → when vm-runner last refused the card's dispatch as busy; the
	 * pre-claim gate waits VM_BUSY_RETRY_MS before the next try. Cleared by the next dispatch
	 * vm-runner takes (with the card's vmState.busy mark). */
	const vmBusyAt = new Map<string, number>();

	/** The worker token for a runner url: vm-runner's own target when the url is the microVM
	 * runner's, else the worker pool's (compose shares one OTTR_WORKER_TOKEN, but a board with
	 * only a microVM runner has no worker pool to read it from). */
	function runnerToken(url: string): string | undefined {
		return ops.vmTarget?.urls.includes(url)
			? ops.vmTarget.token
			: ops.workerTarget?.token;
	}

	/** Asks every configured worker (and the microVM runner, whose VM turns detach the same way)
	 * for its detached runs and returns the one whose cwd matches the card's worktree, or null:
	 * no ops wiring, no worktree, no match anywhere, or a runner that cannot be reached (a probe
	 * failure is swallowed per runner). */
	async function matchDetached(
		worktree: string | null,
	): Promise<{ run: DetachedRun; url: string } | null> {
		// ponytail: recoverRestarted re-checks ops.detachedRuns before calling, so mutants
		// firing only while the op is absent cannot change the outcome here.
		const urls = [
			...(ops.workerTarget?.urls ?? []),
			...(ops.vmTarget?.urls ?? []),
		];
		if (!ops.detachedRuns || urls.length === 0 || worktree === null)
			return null;
		for (const url of urls) {
			// ponytail: token is string|undefined so ?? equals ||, and the catch's []
			// contents carry no cwd — neither mutant can change which run matches.
			const runs = await ops
				.detachedRuns(url, runnerToken(url) ?? "")
				.catch(() => []);
			const run = runs.find((r) => r.cwd === worktree);
			if (run) return { run, url };
		}
		return null;
	}

	/** Settles a re-bound row whose detached run finished (at recovery or on a later sweep): the
	 * same lost-and-resume route as sweepLostTurns, but the reason names the restart, and a
	 * detached completion is not a worker failure. */
	async function settleDetached(
		e: TurnProject,
		t: ListedTask,
		turnId: number | null,
	): Promise<void> {
		await settleLostTurn(
			e,
			t,
			turnId,
			"the update restarted the board; the turn finished on the worker",
			"The update restarted the board and the turn finished on the worker - resuming automatically. Cancel to stop it instead.",
		);
	}

	/** Shared settle-and-requeue for the lost-run sweep and the boot restart sweep: end the open
	 * row (null turnId: the crash landed before the row existed, or the last row is already
	 * settled — nothing to finish), then queue the continue reply through restartResumePrompt
	 * (a clean tree gets the unchanged-tree hint, an unknown tree collapses to "."). A cancel
	 * that landed meanwhile owns the card: the row is settled, the card is left for cancelTask
	 * to finish. */
	async function settleLostTurn(
		e: TurnProject,
		t: ListedTask,
		turnId: number | null,
		error: string,
		needsReason: string,
	): Promise<void> {
		const store = e.store;
		appendLog(
			store,
			t.id,
			`! ${error}; ${turnId === null ? "requeueing the card" : "settling the turn"}`,
		);
		if (turnId !== null)
			store.finishTurn(turnId, {
				endedAt: Date.now(),
				exitCode: null,
				error,
			});
		// The settle ends the card's microVM turn (lost, or a re-bound detached run that
		// finished): its VM must not push or reach /llm any more. Before the requeue below, so
		// the next turn's fresh token is never caught by this sweep.
		ops.vmTokens?.revokeTask(e.name, t.id);
		// A cancel that landed while the run hung already owns the card's state.
		const cur = store.getTask(t.id);
		if (!cur || cur.cancelledAt !== null) return;
		// Same resume route as a tracker restart: the omp session and worktree survive, so queue a
		// continue reply; a never-saved session starts fresh via resumePlan on the next start.
		// restartResumePrompt itself collapses dirty and unknown trees back to ".".
		let resume = ".";
		if (cur.worktree !== null) {
			const sha = await ops.targetSha(cur.worktree, "HEAD").catch(() => null);
			if (sha !== null)
				resume = restartResumePrompt({
					sha,
					clean: await ops.isClean(cur.worktree).catch(() => false),
				});
		}
		// The interrupted turn's prompt rides again when its omp session never saved it: a restart
		// seconds into a turn otherwise resumes the saved session with only the note, and the agent
		// never sees what the turn was asked to do. A missing session file needs no resend — that
		// turn starts a fresh session, whose start re-sends the card's instructions.
		const lost =
			turnId === null
				? null
				: (store.listTurns(t.id).find((row) => row.id === turnId) ?? null);
		const base = cur.pendingPrompt ?? resume;
		store.updateTask(t.id, {
			state: "queued",
			needsReason,
			pendingPrompt:
				lost !== null &&
				cur.sessionId !== null &&
				sessionFile(store.sessionsDir, cur.sessionId) !== null &&
				!sessionHoldsPrompt(store.sessionsDir, cur.sessionId, lost.prompt)
					? `${lost.prompt}\n\n${base}`
					: base,
			// Queued user text keeps its authorship; the board's own resume text is supervisor.
			pendingBy: cur.pendingPrompt !== null ? cur.pendingBy : "supervisor",
		});
	}

	/** Settles a card whose second-model check run was lost (sweepLostTurns): the check's
	 * agent pid is dead while `done` hangs, so runTurn's post-check writes never run. Park
	 * the card like a failed check (the verdict is unknowable) and record the lost run. */
	async function settleLostCheck(
		e: TurnProject,
		t: ListedTask,
		checkKey: string,
		error: string,
	): Promise<void> {
		const store = e.store;
		appendLog(store, t.id, `! ${error}; parking the card`);
		// A cancel that landed while the check hung already owns the card's state.
		const cur = store.getTask(t.id);
		if (!cur || cur.cancelledAt !== null) return;
		if (checkKey.endsWith(":workcheck"))
			store.updateTask(t.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: `The work check was lost: ${error}. Reply to re-run it, or cancel the card.`,
				workCheckLog: [
					...cur.workCheckLog,
					{
						at: Date.now(),
						model: null,
						outcome: "error",
						blockers: [],
						notes: [],
						durationMs: 0,
						error,
					},
				],
			});
		else
			store.updateTask(t.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: `The review check was lost: ${error}. Reply to re-run the review, or cancel the card.`,
			});
	}

	/** Boot restart sweep: the tracker process died mid-run. Settle each open row whose run is
	 * gone (a still-alive recorded agent pid keeps its card; sweepLostTurns takes it once the
	 * pid dies) as "tracker restarted" and requeue through the same resume route as
	 * sweepLostTurns. server.ts calls this once, before the first schedule(). */
	async function recoverRestarted(): Promise<void> {
		// The dev board (src/dev.ts) seeds fabricated running/preparing cards with no agent
		// processes behind them; the restart sweep must not requeue them.
		if (demoBoard()) return;
		for (const e of projects.values()) {
			let tasks: ListedTask[];
			try {
				tasks = e.store.listTasks();
			} catch (err) {
				logStoreError(e.store.name, err);
				continue;
			}
			for (const t of tasks) {
				if (t.state !== "running" && t.state !== "preparing") continue;
				const turn = e.store.listTurns(t.id).at(-1);
				// An agent process is a child and can outlive the tracker restart: a still-alive
				// recorded pid owns the worktree, so requeueing here would start a second agent
				// on it. Leave the card to sweepLostTurns, which settles and requeues through
				// this same route once the pid dies. A worker row (pid null) has no pid to
				// prove liveness with and keeps the old behavior; a cancelled card falls
				// through to finish its interrupted cancel below.
				if (
					turn &&
					turn.endedAt === null &&
					turn.pid !== null &&
					ops.pidAlive(turn.pid) &&
					t.cancelledAt === null
				) {
					appendLog(
						e.store,
						t.id,
						`agent pid ${turn.pid} survived the tracker restart; leaving the card running`,
					);
					continue;
				}
				// OTTR-454: a pid-null row is a worker run the update detached instead of losing.
				// Ask the workers before settling it lost: a still-running match keeps the row
				// open and registers a watcher the sweep polls; a finished one settles through
				// the resume route with the restart reason. No match (or an unreachable worker)
				// keeps the lost settle below.
				// ponytail: matchDetached re-guards ops.detachedRuns, so this first conjunct
				// is redundant; the remaining conjuncts are pinned by the re-bind tests.
				if (
					ops.detachedRuns &&
					t.cancelledAt === null &&
					turn &&
					turn.endedAt === null &&
					turn.pid === null
				) {
					const match = await matchDetached(t.worktree);
					if (match) {
						if (match.run.running) {
							detached.set(`${e.name}/${t.id}`, {
								url: match.url,
								runId: match.run.id,
							});
							appendLog(
								e.store,
								t.id,
								`- re-bound detached run ${match.run.id} on ${new URL(match.url).host}; the card stays running`,
							);
							continue;
						}
						await settleDetached(e, t, turn.id);
						continue;
					}
				}
				// null turnId: the crash landed before store.startTurn created the row (git/apt
				// preparation), or the last row is already settled — requeue without finishing a row.
				try {
					await settleLostTurn(
						e,
						t,
						turn && turn.endedAt === null ? turn.id : null,
						"tracker restarted",
						"Tracker restarted during this turn - resuming automatically. Cancel to stop it instead.",
					);
					// The cancel that owned this card died with the tracker: redo the decision it
					// was interrupted in — a dirty worktree becomes a kept-worktree needs_you card,
					// a clean one is removed and the card ends idle. No api() wrapper exists at
					// boot, so a failure logs here and the next boot retries.
					if (t.cancelledAt !== null) await cancel(e, t.id, false);
				} catch (err) {
					logStoreError(e.store.name, err);
				}
			}
		}
	}

	/** Settles open turns whose agent process vanished while the tracker stayed up (killed agent,
	 * emulator hang, machine sleep): a spawned grandchild can hold the run's stdio pipes open, the
	 * child's `close` never fires, and without this the turn row stays open forever while the
	 * scheduler's arch-review hold blocks the project's merge queue. Mirrors the boot restart sweep:
	 * settle the row, then requeue through the same resume route. Detection only — nothing is killed
	 * here. Runs from every schedule() tick, so board start (server.ts calls schedule() once at
	 * boot) sweeps stale rows too. */
	async function sweepLostTurns(): Promise<void> {
		// Same fabricated data: the lost-turn sweep runs on every schedule tick.
		if (demoBoard()) return;
		// OTTR-454: poll every re-bound detached run first. Still running: leave its row to the
		// scan below untouched this tick. Finished or gone: settle through the restart-resume
		// route and drop the watcher (only after the settle write, so a concurrent tick's scan
		// cannot double-settle the row). An unreachable worker keeps the watcher and the row.
		for (const [key, watch] of [...detached]) {
			if (!ops.detachedRuns) break;
			// ponytail: a watcher exists only because workerTarget answered at recovery, so
			// the optional chain cannot see null, and ?? equals || for string|undefined.
			const runs = await ops
				.detachedRuns(watch.url, runnerToken(watch.url) ?? "")
				.catch(() => null);
			// Probe failure is not proof of a loss: leave the row open and retry next tick.
			if (runs === null) continue;
			if (runs.find((r) => r.id === watch.runId)?.running) continue;
			const sep = key.indexOf("/");
			const e = projects.get(key.slice(0, sep));
			const t = e?.store.getTask(key.slice(sep + 1));
			const turn = t && e ? e.store.listTurns(t.id).at(-1) : null;
			// ponytail: the t && e lookup above turns a missing project or task into a null
			// turn, so !e and !t are backstopped by !turn.
			if (!e || !t || !turn || turn.endedAt !== null) {
				detached.delete(key);
				continue;
			}
			try {
				await settleDetached(e, t, turn.id);
				detached.delete(key);
			} catch (err) {
				// Keep the watcher: the next tick retries the settle through the same route.
				// ponytail: log-only — the watcher's fate (kept) is decided by the delete
				// that never ran.
				logStoreError(e.store.name, err);
			}
		}
		// Synchronous scan: claimed entries leave `running` before the first await, so a re-entrant
		// schedule() cannot double-settle a row.
		const lost: {
			e: TurnProject;
			id: string;
			turnId: number;
			pid: number | null;
		}[] = [];
		const lostChecks: {
			e: TurnProject;
			id: string;
			checkKey: string;
			pid: number | null;
		}[] = [];
		for (const e of projects.values()) {
			let tasks: ListedTask[];
			try {
				tasks = e.store.listTasks();
			} catch (err) {
				// One sick store must not stop the sweep for the other projects (same isolation as
				// getSettingsLogged).
				logStoreError(e.store.name, err);
				continue;
			}
			for (const t of tasks) {
				// Only in-flight cards can hold an open turn row (same filter as the boot restart sweep).
				if (t.state !== "running" && t.state !== "preparing") continue;
				const key = `${e.name}/${t.id}`;
				// d774111 keeps the card running while a second-model check runs, with the run's
				// own row already closed: the row path below never sees that phase. A check
				// entry whose pid is dead or absent hangs the card in running forever — a
				// grandchild can hold the check's stdio pipes past maxTime — and holds two cap
				// units (its entry plus the run's preparing claim). Sweep it like any lost run;
				// a live check (own pid alive) is never swept.
				const checkKey = running.has(`${key}:check`)
					? `${key}:check`
					: running.has(`${key}:workcheck`)
						? `${key}:workcheck`
						: null;
				if (checkKey !== null) {
					const pid = running.get(checkKey)!.pid;
					if (pid === null || !ops.pidAlive(pid))
						lostChecks.push({ e, id: t.id, checkKey, pid });
					continue;
				}
				const turn = e.store.listTurns(t.id).at(-1);
				if (!turn || turn.endedAt !== null) continue;
				// A live runTurn owns its row from the claim until its settle writes: the omp pid can
				// be dead while slow post-run git work is still in flight (running.delete happened,
				// the preparing claim has not), and settling under it would make runTurn settle the
				// row twice and requeue a finished card. A worker run whose fallback filled the pid
				// after startTurn is owned the same way (its row pid is still null). Only the
				// hung-pipe case still settles here: an entry holding the row's own pid whose `done`
				// will never resolve.
				if (
					preparing.has(key) &&
					!(turn.pid !== null && running.get(key)?.pid === turn.pid)
				)
					continue;
				if (turn.pid === null) {
					// Worker run: the live stream in `running` is the liveness proof. A local spawn failure
					// stores pid null too but settles its row in runTurn's catch; and running.set precedes
					// store.startTurn synchronously, so a sweep can never see an open pid-null row for a
					// live local run. A pid-null lost row therefore has no live entry to abandon by
					// construction — the abandonment block below is pid-path only. A re-bound detached
					// run is its own liveness proof: the watcher poll above settles it when it ends.
					if (detached.has(key)) continue;
					if (running.get(key)?.pid === null) continue;
					lost.push({ e, id: t.id, turnId: turn.id, pid: null });
					continue;
				}
				if (ops.pidAlive(turn.pid)) continue;
				const entry = running.get(key);
				if (entry && entry.pid === turn.pid) {
					running.delete(key); // free the slot now; a late `done` finds the entry abandoned
					entry.abandoned = true;
					// The abandoned run's finally never runs while `done` hangs, so its preparing claim
					// would hold a cap slot forever; the resumed turn re-adds its own.
					preparing.delete(key);
				}
				lost.push({ e, id: t.id, turnId: turn.id, pid: turn.pid });
			}
		}
		for (const { e, id, turnId, pid } of lost) {
			const error =
				pid === null
					? "lost agent process (worker run)"
					: `lost agent process (pid ${pid})`;
			const needsReason =
				pid === null
					? "The worker running this turn disappeared - resuming automatically. Cancel to stop it instead."
					: `The agent process (pid ${pid}) disappeared during this turn - resuming automatically. Cancel to stop it instead.`;
			try {
				const t = e.store.getTask(id);
				if (t) await settleLostTurn(e, t, turnId, error, needsReason);
			} catch (err) {
				// `void`ed by schedule(): a locked store must reject into the log, not unhandled.
				logStoreError(e.store.name, err);
			}
		}
		for (const { e, id, checkKey, pid } of lostChecks) {
			const error =
				pid === null
					? "lost check agent process"
					: `lost check agent process (pid ${pid})`;
			try {
				// Free both cap units the hang holds (active() counts `running` and
				// `preparing`); the awaiting runTurn finds its entry gone and returns
				// without touching the store.
				running.delete(checkKey);
				preparing.delete(`${e.name}/${id}`);
				const t = e.store.getTask(id);
				if (t) await settleLostCheck(e, t, checkKey, error);
			} catch (err) {
				// Same isolation as the lost-row settle: a locked store rejects into the log.
				logStoreError(e.store.name, err);
			}
		}
	}

	/** OTTR-531: one line per sync-commit hygiene finding, appended to a settled turn's
	 * outcome details. Git failures add no line (the tick refreshes the flags instead). */
	async function syncCommitFindings(): Promise<string[]> {
		const lines: string[] = [];
		for (const e of projects.values()) {
			if (e.gitless) continue;
			const target = e.target;
			if (target === null || !target.startsWith("origin/")) continue;
			const short = target.slice("origin/".length);
			const branch = await ops.checkedOutBranch(e.path).catch(() => null);
			if (branch !== null && branch !== short)
				lines.push(
					`Board: ${e.name}'s main checkout is on branch ${branch}, not ${short}.`,
				);
			if (await ops.branchUnpushed(e.path, short))
				lines.push(
					`Board: ${e.name}'s local ${short} has commits origin lacks.`,
				);
		}
		return lines;
	}

	function schedule(): void {
		ops.publishSoon(); // board diffs from dirty/release flags and new turns ship without polling
		void sweepLostTurns(); // before the cap check: a vanished run must free its slot this tick
		// Refresh every project first: a full cap must not skip the later projects' dirty and
		// release flags (they gate the board and the merge queue).
		for (const e of projects.values()) {
			void ops
				.isClean(e.path)
				.then((clean) => {
					e.dirty = !clean;
				})
				.catch(() => {
					// git failed (e.g. the folder vanished): keep the last dirty flag; the next tick retries.
				});
			// OTTR-506: the merge hold's git fact, refreshed like the dirty flag — a failed
			// check keeps the last value and the next tick retries.
			const branch =
				e.target !== null && e.target.startsWith("origin/")
					? e.target.slice("origin/".length)
					: null;
			if (branch !== null)
				void ops
					.branchUnpushed(e.path, branch)
					.then((unpushed) => {
						// OTTR-531: on the false→true edge of an unpushed main, a standing
						// pushSyncCommits approval pushes the local target ref once — no edge
						// (a failed push leaves the flag true) means no retry storm.
						const edge = !e.mainUnpushed && unpushed;
						e.mainUnpushed = unpushed;
						if (!edge || !e.store.getSettings().pushSyncCommits) return;
						const settings = e.store.getSettings();
						void ops
							.serverMergePush(
								e.path,
								e.path,
								`origin/${branch}`,
								"",
								null,
								settings.originUrl,
							)
							.then((p) => {
								if (p.status === "pushed") {
									// The hold lifts at once instead of waiting for the next tick.
									e.mainUnpushed = false;
									// OTTR-708: record the head this board-made push moved the
									// main checkout to, so the checkout guard discounts it.
									void ops
										.checkoutState(e.path)
										.then((s) => {
											if (s.head !== null) boardPushedHeads.set(e.name, s.head);
										})
										.catch(() => {});
									console.log(
										`${e.store.name}: - pushed ${branch} from the server (push sync commits)`,
									);
								} else if (p.status === "skipped") {
									console.log(
										`${e.store.name}: ! sync-commit push of ${branch} skipped`,
									);
								} else {
									console.log(
										`${e.store.name}: ! sync-commit push of ${branch} failed: ${p.error}`,
									);
								}
							})
							.catch((err: unknown) => {
								console.log(
									`${e.store.name}: ! sync-commit push of ${branch} failed: ${errmsg(err)}`,
								);
							});
					})
					.catch(() => {
						// git failed: keep the last mainUnpushed flag; the next tick retries.
					});
			// OTTR-531: the off-default finding's git fact, refreshed like the dirty flag —
			// a failed check keeps the last value and the next tick retries.
			void ops
				.checkedOutBranch(e.path)
				.then((b) => {
					e.mainBranch = b;
				})
				.catch(() => {
					// git failed: keep the last mainBranch; the next tick retries.
				});
			void ops.refreshRelease(e);
			void ops.refreshArchReview(e);
			void ops.refreshOpenPrs?.(e);
		}
		// An update waits for an idle board: the running turns finish, and no new turn, merge or
		// release publish starts until the restart (scripts/update-image.ts). The board check is
		// the one exception: it only reads the board, so it never waits for the update, and the
		// restart waits for it like for any other turn.
		const drained = ops.drained();
		// Global cap across projects: per-project maxParallel alone let one boot start 10 agents.
		// Counted in distinct keys: a live run sat in both `running` and `preparing`, so the old
		// sum counted every run twice and the cap bit at half its number. runTurn claims
		// synchronously, so the count is exact before each start.
		// The dev board's fabricated cards must never start a real agent, whatever the cap says.
		const cap = demoBoard() ? 0 : ops.maxTotalRuns();
		const active = () => new Set([...running.keys(), ...preparing]).size;
		// OTTR-708: the pickers resolve foreign dependsOn ids across the board's projects.
		const depProjects = depProjectsOf(projects.values());
		for (const e of projects.values()) {
			try {
				const settings = getSettingsLogged(e);
				const ownDep = depProjectOf(e.store);
				const runnable = pickRunnable(e.store.listTasks(), {
					maxParallel: settings.maxParallel,
					hasRules: ops.hasRules(e.path),
					only: drained ? e.store.boardCheckId() : undefined,
					mainUnpushed: e.mainUnpushed === true,
					prMode: settings.prMode === true,
					crossDeps: (did) => findDep(did, depProjects, ownDep),
				});
				for (const t of runnable) {
					if (cap !== null && active() >= cap) return;
					void runTurn(e.store.name, t.id);
				}
				// The release command's process takes a cap slot too: do not overbook the tick.
				if (cap !== null && active() >= cap) return;
				if (!drained) void settleReviews(e.store.name);
			} catch (err) {
				// One sick store (locked file, missing table) must not stop the other projects'
				// schedule or turn the write that triggered this tick into a 500.
				logStoreError(e.store.name, err);
			}
		}
		// The low-priority slot: a trending scout starts only after every project's picks above
		// left a free slot, in project order, at most one per call and one running board-wide.
		if (cap !== null && active() >= cap) return;
		let scout: { name: string; id: string } | null = null;
		for (const e of projects.values()) {
			try {
				const tasks = e.store.listTasks();
				if (
					tasks.some(
						(t) =>
							t.kind === "trending" &&
							t.cancelledAt === null &&
							(t.state === "running" || t.state === "preparing"),
					)
				)
					return;
				if (scout !== null) continue;
				const ownDep = depProjectOf(e.store);
				const t = pickLowPriority(tasks, {
					maxParallel: getSettingsLogged(e).maxParallel,
					hasRules: ops.hasRules(e.path),
					only: drained ? e.store.boardCheckId() : undefined,
					mainUnpushed: e.mainUnpushed === true,
					crossDeps: (did) => findDep(did, depProjects, ownDep),
				});
				if (t !== null) scout = { name: e.store.name, id: t.id };
			} catch (err) {
				logStoreError(e.store.name, err);
			}
		}
		if (scout !== null) void runTurn(scout.name, scout.id);
	}

	/** Publish one approved release card: Ottr's tag/push/GitHub release, or the project's release
	 * command. Returns null on success, else a needs_you reason. Runs at the end of the review turn
	 * (runTurn) or later from settleReviews once the review's findings have landed. A cancel that
	 * lands before the publish step skips it and also returns null: the cancel owns the card, so
	 * callers re-read the card before they write. On publish, the card's key enters `publishing`;
	 * the caller deletes it after its final card write. */
	async function publishReleaseCard(
		e: TurnProject,
		task: ListedTask,
		base: string,
		wt: string,
		target: string,
	): Promise<string | null> {
		const store = e.store;
		const log = (line: string) => appendLog(store, task.id, line);
		// Synchronous with the publish call after it: a cancel either lands first (and the publish
		// skips) or finds the claim (and refuses).
		const claimPublish = (): boolean => {
			if (store.getTask(task.id)?.cancelledAt !== null) {
				log("release skipped: the card was cancelled");
				return false;
			}
			publishing.add(`${store.name}/${task.id}`);
			return true;
		};
		try {
			// Read fresh: the settings may have changed during a long review.
			const settings = store.getSettings();
			// The tag message and OTTR_ARCH_REVIEW carry the commits since the previous review.
			const archDelta = await ops
				.archReviewDelta(e.path, target, lastReviewBase(store.listTasks()))
				.catch(() => null);
			const archReview = archDelta !== null ? { delta: archDelta.delta } : null;
			// The finding cards' mergeHeads, in done order: the anchors that mark which late
			// commits are review fixes in the published notes.
			const findings = reviewFindings(store.listTasks(), task)
				.filter((f) => f.cancelledAt === null && f.mergeHead !== null)
				.sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
				.map((f) => f.mergeHead!);
			let line: string;
			if (settings.releaseCommand === null) {
				// Tag the target's head: the review's fixes landed there after the reviewed commit, and
				// settleReviews waited for them. publishRelease refuses a head without that commit.
				const head = await ops.resolveTarget(
					e.path,
					true,
					settings.originUrl,
					settings.targetBranch,
				);
				if (head.warning !== null) log(head.warning);
				if (!claimPublish()) return null;
				line = await ops.publishRelease({
					mainPath: e.path,
					reviewed: base,
					sha: head.sha,
					version: task.releaseVersion!,
					notes: task.releaseNotes ?? "",
					findings,
					github: e.github,
					archReview,
					originUrl: settings.originUrl,
					// Hosted: gh takes the project's minted token, never GH_TOKEN.
					...(ops.hosted !== undefined && {
						gh: await hostedGh(e.path, settings.originUrl),
					}),
				});
			} else {
				// Outside the worktree: the command may refuse a dirty tree.
				const notesFile = join(store.tasksDir, `release-${task.id}.md`);
				writeBelow(store.dataRoot, notesFile, task.releaseNotes ?? "");
				log(`$ ${settings.releaseCommand}`);
				if (!claimPublish()) return null;
				const key = `${store.name}/${task.id}`;
				let releaseEntry: RunEntry | null = null;
				try {
					line = await ops.runReleaseCommand({
						command: settings.releaseCommand,
						cwd: wt,
						mainPath: e.path,
						originUrl: settings.originUrl,
						target,
						sha: base,
						version: task.releaseVersion!,
						notesFile,
						archReview,
						log: (l) => log(`| ${l}`),
						onSpawn: (h) => {
							releaseEntry = h;
							running.set(key, h);
						},
					});
				} finally {
					// The command's process is over: free its cap slot. runTurn's finally misses
					// this entry (it compares against the omp handle), so without this every
					// release-command publish burns one global-cap slot until a restart.
					if (releaseEntry !== null && running.get(key) === releaseEntry)
						running.delete(key);
				}
			}
			log(line);
			return null;
		} catch (err) {
			return `Release failed: ${errmsg(err)}. Fix it, then reply to retry.`;
		}
	}

	/** Settles review cards that runTurn parked at merging while their findings landed: once the
	 * findings are done, a release publishes and the Review button's card is done. Runs on the
	 * schedule tick (5 s), so a card settles within a tick of its last finding. Settling waits out
	 * merge turns that may push: the release command's push must not race one (the same reason
	 * pickRunnable holds merges while a release runs). */
	const settling = new Set<string>();
	async function settleReviews(name: string): Promise<void> {
		const e = projects.get(name);
		if (!e || e.target === null) return;
		try {
			const target = e.target;
			const tasks = e.store.listTasks();
			const live = tasks.filter((t) => t.cancelledAt === null);
			// Wait out a merge that may push: one that runs, or a queued one no review holds. A merge
			// this release holds waits for the publish itself, so waiting for it would deadlock.
			if (
				live.some(
					(t) =>
						t.stage === "merging" &&
						(t.state === "running" ||
							t.state === "preparing" ||
							(t.state === "queued" && mergeHold(live, t) === null)),
				)
			)
				return;
			for (const t of tasks) {
				// The exact state runTurn parks a held review card in; needsReason doubles as the held marker.
				if (
					t.stage !== "merging" ||
					t.state !== "idle" ||
					t.needsReason === null ||
					!isReview(t) ||
					t.base === null ||
					t.cancelledAt !== null
				)
					continue;
				const key = `${name}/${t.id}`;
				if (settling.has(key)) continue;
				settling.add(key);
				// A release command's process takes a global cap slot: claim it before the first
				// await, or every project in the same schedule() tick sees the slot free (R3-5).
				preparing.add(key);
				// `tasks` is this tick's snapshot and every await below may let a cancel in: re-read
				// before each write, and leave a cancelled card to cancel.
				const cancelled = () => e.store.getTask(t.id)?.cancelledAt !== null;
				try {
					if (findingsHold(e.store.listTasks(), t) !== null) continue;
					if (t.releaseVersion === null) {
						// The Review button's card has nothing to publish.
						const commits = await ops.targetCommits(e.path, target);
						const mergeHead = await ops
							.targetSha(e.path, target)
							.catch(() => null);
						// The review's worktree holds its generated report files; capture them
						// before cleanupPass removes the tree, like the turn settle does.
						const uncommitted =
							t.worktree !== null && existsSync(t.worktree)
								? await ops.statusFiles(t.worktree)
								: [];
						if (cancelled()) continue;
						e.store.updateTask(t.id, {
							stage: "done",
							state: "idle",
							needsReason: null,
							uncommittedFiles: uncommitted,
							commits,
							mergeHead,
						});
						continue;
					}
					// A release publishes from its worktree.
					if (t.worktree === null) continue;
					const err = await publishReleaseCard(
						e,
						t,
						t.base,
						t.worktree,
						target,
					);
					if (cancelled()) continue;
					if (err !== null) {
						e.store.updateTask(t.id, {
							stage: "in_progress",
							state: "needs_you",
							needsReason: err,
						});
						continue;
					}
					const commits = await ops.targetCommits(e.path, target);
					const mergeHead = await ops
						.targetSha(e.path, target)
						.catch(() => null);
					// Same capture rule as the plain review done above.
					const uncommitted =
						t.worktree !== null && existsSync(t.worktree)
							? await ops.statusFiles(t.worktree)
							: [];
					if (cancelled()) continue;
					e.store.updateTask(t.id, {
						stage: "done",
						state: "idle",
						needsReason: null,
						summary: `Released ${t.releaseVersion}`,
						uncommittedFiles: uncommitted,
						commits,
						mergeHead,
					});
				} finally {
					settling.delete(key);
					preparing.delete(key);
					publishing.delete(key);
				}
			}
		} catch (err) {
			// Voided by schedule(): a locked store must reject into the log, not unhandled.
			logStoreError(name, err);
		}
	}

	async function runTurn(name: string, id: string): Promise<void> {
		const e = projects.get(name);
		if (!e) return;
		const store = e.store;
		const task = store.getTask(id);
		const key = `${name}/${id}`;
		if (
			!task ||
			task.state !== "queued" ||
			task.cancelledAt !== null ||
			running.has(key)
		)
			return;
		const kind: TurnKind = task.stage === "merging" ? "merge" : "work";
		// Byte offset of this turn's own log section: captured just before the header write
		// and stored on the turn row so the board can fetch only the turn's part of the log.
		let turnLogOffset = 0;
		// OTTR-454 per-runner drain: a hold on every worker (or on "local") defers the start,
		// the card stays queued, and the next schedule tick retries. The board-wide gate
		// (ops.drained() in schedule()) is unchanged; its board-check exception does not apply
		// here — a "local" hold stops board checks too. Flags read before the claim: they are
		// the same ones the worker decision below makes.
		const preRetro = isRetro(task);
		const preBoardCheck = store.boardCheckId() === id;
		const target = ops.workerTarget ?? null;
		// ponytail: `target !== null` appears here and in the ternary below; either
		// `true`-replacement alone cannot change the branch (the other check re-derives
		// it), so Stryker's two equivalent mutants of the pair stay without a killer test.
		// OTTR-532: an eligible turn of a microVM project goes to vm-runner only. A runner
		// that is down, unconfigured or drained, or a card whose last dispatch it refused as
		// busy moments ago, leaves the card queued and unclaimed (the board shows vmHoldFor);
		// it never falls back to the classic pool or the server.
		const preVm = microVmTurn({
			microVm: getSettingsLogged(e).microVm === true,
			kind,
			retro: preRetro,
			boardCheck: preBoardCheck,
			task,
		});
		if (preVm) {
			const vmTarget = ops.vmTarget ?? null;
			if (vmTarget === null || !vmState.health.ok) return;
			if (vmTarget.urls.every((u) => ops.drainedRunner(new URL(u).hostname)))
				return;
			const busyAt = vmBusyAt.get(key);
			if (busyAt !== undefined && Date.now() - busyAt < VM_BUSY_RETRY_MS)
				return;
		} else {
			const toWorker =
				kind !== "merge" && !preRetro && !preBoardCheck && target !== null;
			const runnerDrained =
				toWorker && target !== null
					? target.urls.every((u) => ops.drainedRunner(new URL(u).hostname))
					: ops.drainedRunner("local");
			if (runnerDrained) return;
		}
		// Synchronous claim before the first await so a re-entrant schedule() cannot double-start.
		store.updateTask(id, {
			state: "preparing",
			needsReason: null,
			asked: null,
		});
		preparing.add(key);
		// A credit-stop mark belongs to a run claimed before the stop; this claim starts clean
		// (a stop from now on marks it again, and the hold covers the gap until the gate).
		creditStopped.delete(key);
		const log = (line: string) => appendLog(store, id, line);
		let turn: Turn | null = null;
		/** This run's slot in `running`; null until startRun returns (the catch/finally may run early). */
		let entry: RunEntry | null = null;
		/** Set when sweepLostTurns took over a hung check of this run: the finally must then
		 * leave the preparing claim alone (it may belong to a replacement run already). */
		let checkTakenOver = false;
		/** Hosted metering: one entry for each settled agent run of this turn, reported in the finally.
		 * `main` marks the turn's own work/merge run — the default-role run that carries the
		 * card outcome and title at the settle (check runs, also one that meters as `default`
		 * when no check role is set, never carry them). */
		const metered: MeteredRun[] = [];
		/** Interim metering of this turn's runs that have not settled; the finally closes them. */
		const interims = new Set<InterimMeter>();
		let runs = 0;
		/** Hosted metering of one agent run, opened right before its startRun: the run's index in
		 * the turn, its interim records while it runs (startRun's onUsage), and settle(), which
		 * ends the interim records and queues the final record. Null on a self-hosted board.
		 * `main` marks the turn's own work/merge run: its final record carries the card outcome
		 * and title (ottr-cloud M10); check runs never carry them. */
		const openMeter = (role: string, main = false) => {
			if (ops.hosted === undefined) return null;
			const run = runs++;
			const interim = interimMeter(
				ops.hosted,
				() =>
					turn === null
						? null
						: { project: name, taskId: id, turnId: turn.id, kind, role, run },
				ops.meteringIntervalMs ?? METERING_INTERVAL_MS,
			);
			interims.add(interim);
			return {
				onUsage: interim.onUsage,
				settle(r: RunResult): void {
					interim.close();
					interims.delete(interim);
					metered.push({
						run,
						role,
						model: r.model,
						usage: r.usage ?? NO_USAGE,
						main,
					});
				},
			};
		};
		/** Hosted credit stop (docs/specs/hosted-mode.md section 5): true when the loop's credit
		 * hold or this turn's creditStop mark forbids the next model run. The card then parks
		 * needs_you with the credit reason, unless a cancel or another park already owns it. */
		const creditBlocked = (): boolean => {
			if (ops.hosted === undefined) return false;
			if (!creditHold && !creditStopped.has(key)) return false;
			log("- model run not started: the board is out of credit");
			const cur = store.getTask(id);
			if (
				cur !== null &&
				cur.cancelledAt === null &&
				(cur.state === "preparing" || cur.state === "running")
			)
				store.updateTask(id, {
					state: "needs_you",
					needsReason: ops.hosted.config.wording.creditReason,
				});
			return true;
		};
		try {
			if (
				ops.hosted !== undefined &&
				!(await creditGate(ops.hosted, store, task, log))
			)
				return;
			const settings = store.getSettings();
			// Capture must stay adjacent to the header write: the offset is the header's byte
			// position in the card log. A missing file is a fresh card, so the header starts at 0.
			turnLogOffset =
				statSync(store.logPath(id), { throwIfNoEntry: false })?.size ?? 0;
			log(`== ${kind} turn ${new Date().toISOString()}`);
			// A new worktree starts from a freshly fetched target; an existing one keeps its base.
			const { target, sha, warning } = await ops.resolveTarget(
				e.path,
				!task.worktree || !task.branch,
				settings.originUrl,
				settings.targetBranch,
			);
			if (warning) log(`! ${warning}`);
			e.target = target;

			let wt = task.worktree;
			let branch = task.branch;
			const releaseCard = task.releaseVersion !== null && task.base !== null;
			// The Review button's card runs the same read-only review at its frozen base, minus the publish.
			const reviewCard = isReview(task) && task.base !== null;
			const retroCard = isRetro(task);
			// The Check the board button's card: only its route sets the mark, never the prompt text.
			const boardCheck = store.boardCheckId() === id;
			const interview = task.kind === "interview";
			// A backlog card only ever runs grill turns: worktree-less, in the main checkout.
			const grill = task.stage === "backlog";
			// The weekly trending scout: read-only in the main checkout, with only the read tools
			// and its two verdict tools (propose_repo, judge_repo) on the board env. It reads
			// third-party text, so it runs on a worker when one exists (D6) and never holds the
			// board's GitHub token, also on a local run.
			const scout = task.kind === "trending";
			// Review sessions get one fixed name, applied by the extension before the agent runs,
			// so the board never depends on the agent inventing a title.
			let sessionName = releaseCard
				? "Release review"
				: reviewCard
					? "Review"
					: boardCheck
						? "Board check"
						: null;
			// Every other card gets its title here, in prepare: a tracker-generated name,
			// persisted before the run and pinned on the session, so the board never waits
			// for the run's rename (omp's auto titler can take ~30 minutes or never fire).
			if (sessionName === null) {
				const named = store.sessionTitle(task);
				if (named !== null) sessionName = named;
				else {
					// The title is a model call: a credit stop in the prepare above ends here.
					if (creditBlocked()) return;
					let cause = "unknown failure";
					const gen = await (ops.genTitle ?? generateTitle)(
						task.prompt,
						undefined,
						(c) => {
							cause = c;
						},
					);
					if (gen !== null) {
						store.nameTask(id, gen);
						// Any pending retry is spent either way; clear it before the transcript
						// title can win the race the hold was holding back.
						store.releaseTitleHold(id);
						sessionName = gen;
						log(`+ title: ${gen}`);
					} else {
						log(
							`! title generation failed (${cause}); the card shows the prompt cut until the run names itself`,
						);
						if (store.titleHold(id)) {
							// This failed attempt was the one retry an earlier turn scheduled:
							// give up, so the run's own transcript title can name the card.
							store.releaseTitleHold(id);
						} else {
							// Hosted: the retry is a model call, so a credit stop that lands
							// before it fires skips it (docs/specs/hosted-mode.md section 5).
							scheduleTitleRetry(
								store,
								id,
								task.prompt,
								log,
								ops,
								() =>
									ops.hosted !== undefined &&
									(creditHold || creditStopped.has(key)),
							);
						}
					}
				}
			}
			// A review card reviews the frozen sha it was created with, not the current target head.
			// A review card's base is always its frozen sha, so `?? sha` only fires for normal tasks.
			const base = task.base ?? sha;
			if (interview || grill || scout) {
				wt = e.path;
			} else if (!wt || !branch) {
				branch = `ott/${id.toLowerCase()}-${slugify(task.title)}`;
				wt = join(store.worktreesDir, id);
				log(
					`+ worktree ${branch} from ${target} at ${base}${releaseCard ? " (frozen release base)" : ""}`,
				);
				await ops.createWorktree({
					mainPath: e.path,
					worktreePath: wt,
					branch,
					base,
					copyExtra: settings.copyExtra,
					log,
				});
				store.updateTask(id, { branch, base, worktree: wt });
				if (store.getTask(id)?.cancelledAt) {
					// fresh worktree: the agent never ran, so there is nothing to lose
					await ops
						.removeWorktree({
							mainPath: e.path,
							worktreePath: wt,
							branch,
						})
						.catch((err) => log(`! removeWorktree: ${errmsg(err)}`));
					return;
				}
			}

			// OTTR-341: never dispatch a turn into a missing worktree. A card whose agent merged
			// and removed the worktree (AGEN-24) stays queued at a dead cwd: every worker refuses
			// the turn with a 400 and the card parks on a lost-worker reason forever. When the
			// approved hold head (U7) or the branch head is already an ancestor of the target,
			// the work landed: settle done here, the same containment proof the hold settle
			// accepts for a turn that removed its own worktree. A branch-head proof only counts
			// when the branch has commits past base (OTTR-349): review, release-review and retro
			// cards never commit, and base is always an ancestor of the target, so a tip at base
			// would settle every unrun card done on a vacuous proof. Nothing on the branch is
			// thrown away (OTTR-347): a tip past base rebuilds the worktree from the branch and
			// dispatches, a tip at base rebuilds from base (the husk holds no checkout); only a
			// card whose approved head is not on the target and whose branch cannot speak for
			// the work parks for the user.
			if (
				!interview &&
				!grill &&
				!scout &&
				wt !== null &&
				branch !== null &&
				wt === task.worktree &&
				(await ops.worktreeHusk(wt).catch(() => false))
			) {
				const approvedHead = task.updateMergeHead ?? task.forkMergeHead;
				const branchHead = await ops
					.targetSha(e.path, `refs/heads/${branch}`)
					.catch(() => null);
				const head = approvedHead ?? branchHead;
				const landed =
					head !== null &&
					head !== base &&
					(await ops.targetContains(e.path, head, target).catch(() => false));
				// A cancel that landed while the git reads ran owns the card; never write over it.
				const cur = store.getTask(id);
				if (cur === null || cur.cancelledAt !== null) return;
				if (landed) {
					log(
						`- worktree is gone; head ${head} is already on ${target}: the card settles done`,
					);
					// Same end state as the hold settle for a landed approval; the turn never ran,
					// so there is no row to finish and its queued reply is consumed unread.
					store.updateTask(id, {
						stage: "done",
						state: "idle",
						needsReason: null,
						asked: null,
						pendingPrompt: null,
						pendingImages: [],
						holdHead: null,
						commits: await ops.targetCommits(e.path, target).catch(() => 0),
						mergeHead: await ops.targetSha(e.path, target).catch(() => null),
					});
					return;
				}
				if (branchHead !== null && branchHead !== base) {
					// OTTR-347: the branch holds commits the target never got; rebuild the
					// worktree from its tip so the turn resumes the branch's work.
					log(
						`+ worktree is gone; recreating ${branch} at its head ${branchHead}`,
					);
					await ops.createWorktree({
						mainPath: e.path,
						worktreePath: wt,
						branch,
						base: branchHead,
						copyExtra: settings.copyExtra,
						log,
					});
					// A cancel that landed while the worktree was rebuilt owns the card; the
					// branch holds the work, so nothing is deleted here.
					if (store.getTask(id)?.cancelledAt) return;
				} else if (head === null || head === base) {
					// Nothing approved and nothing committed past base: a husk holds no checkout,
					// so rebuild the worktree on the same branch (createWorktree reuses the branch
					// at its tip) and let the turn run from base.
					log(
						`- worktree is gone; ${branch} has no commits past ${base}: recreating the worktree`,
					);
					await ops.createWorktree({
						mainPath: e.path,
						worktreePath: wt,
						branch,
						base,
						copyExtra: settings.copyExtra,
						log,
					});
					store.updateTask(id, { branch, base, worktree: wt });
					if (store.getTask(id)?.cancelledAt) {
						// fresh worktree: the agent never ran, so there is nothing to lose
						await ops
							.removeWorktree({
								mainPath: e.path,
								worktreePath: wt,
								branch,
							})
							.catch((err) => log(`! removeWorktree: ${errmsg(err)}`));
						return;
					}
				} else {
					log(`! worktree is gone; its work is not on ${target}`);
					store.updateTask(id, {
						state: "needs_you",
						needsReason: `The card's worktree is gone; its work is not on ${target}. Cancel the card or recreate the work.`,
					});
					return;
				}
			}

			// Capture the card's diff now: once the ff-merge lands, the branch tip sits on the target
			// and no later git view can separate this branch's files from its siblings'. Skipped when
			// the branch is already integrated (a retried merge turn): the first capture stands.
			if (
				kind === "merge" &&
				!interview &&
				(await ops.commitsAhead(wt, target).catch(() => 0)) > 0
			) {
				const files = await ops.diffStat(wt, base, target).catch(() => null);
				const text = await ops.diffText(wt, base, target).catch(() => null);
				if (files !== null) {
					store.updateTask(id, {
						diffFiles: files,
						// ponytail: 200 KB cap — bigger diffs keep their numstat, the raw view truncates; raise the cap when a card needs more.
						diffText:
							text === null
								? null
								: text.length > 200_000
									? `${text.slice(0, 200_000)}\n… diff truncated at 200 KB`
									: text,
					});
					log(`- captured diff: ${files.length} file(s)`);
				}
			}

			const siblings = store
				.listTasks()
				.filter(
					(t) => t.id !== id && t.cancelledAt === null && t.stage !== "done",
				)
				.map((t) => ({ title: t.title, stage: t.stage, branch: t.branch }));

			// Fresh read: steering can land between the pick and the omp spawn, so pendingPrompt is read as
			// late as possible and only the consumed prefix is cleared after startRun.
			const live = store.getTask(id) ?? task;
			const raw = live.pendingPrompt;
			// A dep-held card parks the marker; the real reply names each dependency and its end
			// state, known only at restart (the scheduler starts the card only once they are done
			// or cancelled — a dependency missing from the project counts as done).
			const all = store.listTasks();
			const pending =
				raw === DEP_HELD_PROMPT
					? depResumePrompt({
							deps: live.dependsOn.map((did) => {
								// OTTR-708: a foreign dependency's title comes from its project's
								// store; this runs once, on the dep-held restart only.
								const d =
									all.find((t) => t.id === did) ??
									findDep(
										did,
										depProjectsOf(projects.values()),
										depProjectOf(store),
									);
								return {
									id: did,
									title: d?.title ?? did,
									done: d === undefined || d === null || d.stage === "done",
								};
							}),
						})
					: raw;
			const plan = resumePlan(
				live.sessionId,
				sessionFile(store.sessionsDir, live.sessionId) !== null,
				pending,
			);
			if (plan.resumeId !== live.sessionId)
				log(
					`! omp never saved session ${live.sessionId}; starting a fresh session`,
				);
			// A fresh session (resumePlan folds the reply into its note) must not swallow a pending
			// reply: workPrompt carries the note inside its text; the raw release/interview prompt
			// and mergePrompt get it appended. prompts.ts wording is untouched.
			const withNote = (base: string) =>
				plan.note === null ? base : `${base}\n\n${plan.note}`;
			// startTurn runs after startRun, so the last turn here is the one this reply answers.
			// A parked merge hold names its hold text as the turn error, so rejectedReport reads it
			// as a rejected report (AGEN-24): agents read "reply to approve the merge" as an order
			// and merged by themselves. A hold reason is never a rejection; the reply rides alone.
			const rejected = rejectedReport(store.listTurns(id).at(-1));
			const holdRejected =
				rejected === UPDATE_HOLD_REASON ||
				rejected === FORK_HOLD_REASON ||
				rejected === MERGE_HOLD_MISMATCH_REASON;
			const replyRejected = holdRejected ? null : rejected;
			const ownPrompt =
				pending && plan.resumeId
					? retroCard
						? retroReplyPrompt({
								text: pending,
								rejected: replyRejected,
							})
						: replyPrompt({
								text: pending,
								kind,
								release: releaseCard,
								rejected: replyRejected,
							})
					: releaseCard ||
							interview ||
							retroCard ||
							boardCheck ||
							grill ||
							scout
						? withNote(grill ? grillPrompt(task.prompt) : task.prompt)
						: kind === "work"
							? workPrompt({
									text: task.prompt,
									branch: branch!, // interview and retro cards take the raw-prompt branch above, so branch is a string here
									siblings,
									note: plan.note,
								})
							: withNote(
									mergePrompt({
										branch: branch!,
										target,
										pr: settings.prMode === true,
									}),
								);
			// Hosted wording (docs/specs/hosted-mode.md section 1) rides after the prompt, so
			// prompts.ts stays untouched: the resume text on a reply into a session, else by kind.
			const wording = ops.hosted?.config.wording;
			const hostedSuffix =
				wording === undefined
					? ""
					: pending && plan.resumeId
						? wording.resumeSuffix
						: kind === "work"
							? wording.workSuffix
							: wording.mergeSuffix;
			const prompt =
				hostedSuffix === "" ? ownPrompt : `${ownPrompt}\n\n${hostedSuffix}`;
			// Reply turn: only the reply's images. Work turn: original prompt is re-sent, so its images plus any
			// not-yet-sent reply images (a reply note before the first omp session). Merge turns get none.
			const turnImages =
				pending && plan.resumeId
					? live.pendingImages
					: kind === "work"
						? [...live.images, ...live.pendingImages]
						: [];
			const imagePaths = turnImages.map((n) => join(store.imagesDir(id), n));
			for (const p of imagePaths) {
				const st = statSync(p, { throwIfNoEntry: false });
				log(
					st
						? `attached image ${p} (${st.size} bytes)`
						: `attached image ${p} (missing)`,
				);
			}

			// D6: merge turns mutate shared state (main checkout, push) and stay server-side;
			// work turns go to the worker pool when one is configured.
			// ponytail: the worker path cannot strip the board env, and a retro is a small
			// read-only run — a per-run env channel for workers is the upgrade path.
			// A board check stays here as well: only loopback in the server's own container reaches
			// the whole board API, and the turns' host on a worker only files cards.
			// OTTR-454: drop workers under a per-runner drain so the round-robin only
			// sees live workers; the empty-list guard sits after stopBeforeRun below.
			// OTTR-532: a microVM project's eligible turn (its cwd is the card worktree) goes to
			// vm-runner and nowhere else; everything else keeps today's routing.
			const vmTurn =
				wt !== e.path &&
				branch !== null &&
				microVmTurn({
					microVm: settings.microVm === true,
					kind,
					retro: retroCard,
					boardCheck,
					task,
				});
			const worker = vmTurn
				? (ops.vmTarget ?? null)
				: retroCard || boardCheck || kind === "merge"
					? null
					: (ops.workerTarget ?? null);
			// A worker installs the project's packages into its own container (vm-runner bakes them
			// into the project layer); a local run does it here.
			const local = !worker && !vmTurn;
			if (local) for (const line of await ops.ensurePackages(name)) log(line);
			const prep =
				local && ops.prepareTurn ? await ops.prepareTurn(name) : null;
			for (const l of prep?.lines ?? []) log(l);
			// One rule for worker turns: the board lends a token for the model omp runs, and omp runs
			// that model through an explicit --model, also on a resume. The execution model is the
			// card's model; else, on a resume, the saved session's model; else the board's default
			// role. A local run (merge, retro, board check) uses the board store itself: no lending,
			// and the card's model as before.
			const execModel =
				worker === null
					? null
					: live.model?.trim() ||
						(plan.resumeId !== null
							? sessionModel(store.sessionsDir, plan.resumeId)
							: null) ||
						(ops.modelRoles ?? modelRoles)().default?.trim() ||
						null;
			// Parks the card with the cause instead of starting omp; a cancel that landed in the
			// prepare awaits already owns the card (same rule as the preRun check below).
			const stopBeforeRun = (reason: string): void => {
				log(`! ${reason}`);
				const cur = store.getTask(id);
				if (!cur || cur.cancelledAt !== null || cur.state !== "preparing")
					return;
				store.updateTask(id, { state: "needs_you", needsReason: reason });
			};
			// The worker target with drained runners dropped; fail closed on an empty list
			// (a drain landed while the turn prepared): park instead of dispatching to a
			// drained worker or falling back to the server. A drain that lands after this
			// point cannot strand the turn: the update script counts every live run on the
			// runner (the entry's url) before it recreates.
			const liveWorker =
				worker === null
					? null
					: {
							urls: worker.urls.filter(
								(u) => !ops.drainedRunner(new URL(u).hostname),
							),
							token: worker.token,
						};
			if (vmTurn && (worker === null || ops.vmTokens === undefined)) {
				// Fail closed: never the classic pool or the server for a microVM turn.
				stopBeforeRun(
					"MicroVM mode is on for this project, but the board has no microVM runner (OTTR_VM_RUNNER_URL). Set it, or turn microVM mode off, then reply to retry.",
				);
				return;
			}
			if (liveWorker !== null && liveWorker.urls.length === 0) {
				stopBeforeRun(
					vmTurn
						? "The microVM runner is drained for an image update, so the turn did not start. The update undrains it when its roll ends; reply to retry."
						: "Every worker is drained for an image update, so the turn did not start. The update undrains the worker when its roll ends; reply to retry.",
				);
				return;
			}
			if (worker !== null && execModel === null) {
				stopBeforeRun(
					"Sign-in: no model for this worker turn. The card sets none, the saved session names none, and the board's config.yml has no default role. Pick a model on the card, or set modelRoles.default, then reply to retry.",
				);
				return;
			}
			// The env values ride the run env into a worker too (the runner forwards them with
			// the rest of the child env), so every turn gets them and every card log names a
			// listed name that has no value.
			// A microVM turn is lent nothing: its providers go through the board's /llm proxy,
			// so no provider token may ride its env (a null model lends none).
			const turnEnv = (await ops.turnEnv?.(
				name,
				vmTurn ? null : execModel,
			)) ?? {
				env: {},
				missing: [],
			};
			if (turnEnv.missing.length > 0)
				log(
					`env: no value for ${turnEnv.missing.join(", ")} (set it under Settings, Env)`,
				);
			// Fail closed: any error value stops the turn, an empty message included.
			if (
				turnEnv.credentialError !== undefined &&
				turnEnv.credentialError !== null
			) {
				stopBeforeRun(
					signInNeedsReason(turnEnv.credentialError, turnEnv.busy === true),
				);
				return;
			}

			// A cancel landing inside the prepare awaits (resolveTarget, an apt install — minutes on
			// a merge turn) already owns the card: its kept path wrote the final state. Starting the
			// run now would drive omp behind a "kept the worktree" card.
			const preRun = store.getTask(id);
			if (
				!preRun ||
				preRun.cancelledAt !== null ||
				preRun.state !== "preparing"
			)
				return;

			// The previous turn died because omp could not restore the session's saved model (its
			// provider has no sign-in on the board): an explicit --model skips that restore, so a
			// board turn on the default role reruns with the board's default role. The card's model stays.
			const restoreFailed =
				live.model === null &&
				worker === null &&
				plan.resumeId !== null &&
				store.listTurns(id).at(-1)?.error?.startsWith(MODEL_RESTORE) === true;
			// The model that runs (and that the turn row records): a worker turn's execution model,
			// else the restore fallback or the card's model of a local run.
			const runModel =
				worker !== null
					? execModel
					: restoreFailed
						? ((ops.modelRoles ?? modelRoles)().default ?? null)
						: live.model;
			if (restoreFailed)
				log(
					runModel === null
						? "! the board has no default model role to replace the session's model"
						: `- model ${runModel}: the board's default role replaces the session's model`,
				);

			// Start gate: the dispatched model's provider is out of quota with a known reset.
			// Starting now would die at the provider's first answer, so requeue with the reset
			// as holdUntil — the scheduler starts the card when the limit resets. A reply or
			// steer queued meanwhile stays pending: this start consumed nothing. A cancel
			// landing during the quota await owns the card; only a still-claimed card requeues.
			// A queued user message is the override the hold's text promises ("Send a message
			// to run it now"): the steer and reply routes cleared holdUntil, so only this gate
			// would re-hold — stale quota data must not trap the user's message until the
			// reset. Supervisor-authored pending text (a park's own instruction) waits.
			const userOverride =
				live.pendingPrompt !== null && live.pendingBy !== "supervisor";
			const startHold = userOverride
				? null
				: await usageResetFor(
						runModel ?? (ops.modelRoles ?? modelRoles)().default ?? null,
					);
			// The last await before the spawn: a credit stop that landed in any prepare await parks
			// the card here, before the usage-limit hold could requeue it or omp could start.
			if (creditBlocked()) return;
			if (userOverride)
				log("- user message queued: the usage-limit start gate does not hold");
			if (startHold !== null) {
				const at = new Date(startHold.resetsAt)
					.toISOString()
					.slice(0, 16)
					.replace("T", " ");
				log(
					`- ${kind} turn held until ${at} UTC: ${startHold.provider} usage limit`,
				);
				const cur = store.getTask(id);
				if (cur && cur.cancelledAt === null && cur.state === "preparing")
					store.updateTask(id, {
						state: "queued",
						queuedAt: Date.now(),
						holdUntil: startHold.resetsAt,
						holdProvider: startHold.provider,
						holdWindow: startHold.window,
						needsReason: `The ${startHold.provider} usage limit is reached. The board starts the task again after the limit resets at ${at} UTC. Send a message to run it now, or cancel the card.`,
					});
				ops.publishSoon();
				return;
			}

			// The HTTP-400 correlation window: from just before the omp spawn to the run's end.
			// OTTR-708: work turns that receive workPrompt (work and research cards; the
			// interview, grill, scout, board-check, release, and retro variants take other
			// prompts) snapshot every other project's main checkout and re-check it at settle:
			// the agent must not touch another project's checkout.
			const checkoutGuard =
				kind === "work" &&
				!releaseCard &&
				!interview &&
				!retroCard &&
				!boardCheck &&
				!grill &&
				!scout;
			const guardBefore = checkoutGuard
				? await snapshotOtherCheckouts(projects, ops, name)
				: null;
			const runStartedAt = Date.now();
			// The work or merge run resolves its model from the default role, also when the card
			// or session names its own model (docs/specs/hosted-mode.md section 4). It is the
			// turn's main run: its final record carries the card outcome and title (M10).
			const runMeter = openMeter("default", true);
			const handle = ops.startRun({
				meter: ops.hosted !== undefined,
				auditProvisioned: (sinceMs, rulesAtStart) =>
					auditProvisioned(homedir(), sinceMs, rulesAtStart),
				rulesAtStart: () => rulesDirEntries(homedir()),
				...(runMeter !== null && { onUsage: runMeter.onUsage }),
				cwd: wt,
				prompt,
				images: imagePaths,
				// OTTR-693: the identity this turn's git commits with when its home config names none.
				commitIdentity: ops.commitIdentity?.() ?? null,
				sessionDir: store.sessionsDir,
				extensionPath: ops.extensionPath,
				board: retroCard ? null : { ...ops.board, project: name, taskId: id },
				resumeId: plan.resumeId,
				model: runModel,
				sessionName,
				worker: vmTurn ? null : liveWorker,
				vm:
					vmTurn && liveWorker !== null && ops.vmTokens !== undefined
						? {
								target: liveWorker,
								tokens: ops.vmTokens,
								grant: {
									project: name,
									taskId: id,
									branch: branch!, // vmTurn requires a branch
									repoPath: e.path,
									worktree: wt,
								},
								base,
								boardUrl: ops.board.url,
							}
						: null,
				secrets: turnEnv.secrets,
				// Retro flags: the retro.yml config sits next to the tracker extension, the
				// skill is pinned, and the board env is stripped (the proposal files here).
				// A review run gets OTTR_REVIEW=1: the extension then registers propose_task,
				// and the findings are recorded, not filed — Ottr files them after the run.
				env: {
					...turnEnv.env,
					...(retroCard
						? { OTTR_RETRO: "1" }
						: reviewCard
							? { OTTR_REVIEW: "1" }
							: scout
								? { OTTR_TRENDING: "1" }
								: {}),
					// PATH last, so an env.txt value can never shadow the tools link dir.
					...(prep?.pathDir
						? { PATH: `${prep.pathDir}:${process.env.PATH ?? ""}` }
						: {}),
					// No git host auth for any agent, merge turns included (D6): the server
					// pushes non-GitHub merges itself after the turn.
				},
				stripBoard: retroCard,
				stripGithubToken: scout,
				tools: retroCard
					? "read,grep,glob,report_outcome,propose_task"
					: scout
						? "read,grep,glob,report_outcome,propose_repo,judge_repo"
						: undefined,
				config: retroCard
					? join(dirname(ops.extensionPath), "retro.yml")
					: scout
						? join(dirname(ops.extensionPath), "trending.yml")
						: undefined,
				skills: retroCard ? "retro" : undefined,
				dataRoot: store.dataRoot,
				logPath: store.logPath(id),
				onLog: () => ops.notifyLog(name, id),
				onProgress: (text) => {
					if (entry === null) return;
					// Only a movement of the numbers is live activity: a repeated line (elapsed
					// ticks of a frozen run, a lock wait) proves nothing and must not reset the
					// silent-log clock (ALAT-23).
					const key = text === null ? null : progressKey(text);
					if (key !== null && key !== entry.progressKey)
						entry.progressAt = Date.now();
					entry.progressKey = key ?? undefined;
					entry.progress = text ?? undefined;
					ops.publishSoon();
				},
				onSession: (sid) => {
					const cur = store.getTask(id);
					if (!cur || cur.state !== "preparing" || cur.cancelledAt !== null)
						return;
					store.updateTask(id, {
						sessionId: sid,
						state: "running",
						...(kind === "work" && cur.stage === "todo"
							? { stage: "in_progress" }
							: {}),
					});
				},
			});
			entry = handle;
			running.set(key, entry);
			if (vmTurn && handle.accepted !== undefined) {
				// Wait for vm-runner to take the turn before anything records it: a busy answer
				// must leave the card exactly as it was before the claim (no turn row, the reply
				// still pending, no lost-worker count). Any other non-start (refused, unreachable,
				// killed) falls through and settles like today's worker dispatch.
				const started = await handle.accepted;
				const early = started ? null : ((await handle.done) as RunResult);
				if (early?.workerBusy === true) {
					running.delete(key);
					vmState.busy.add(key);
					vmBusyAt.set(key, Date.now());
					log(
						`- ${WORKER_BUSY}; the card waits in the queue for a free microVM`,
					);
					const cur = store.getTask(id);
					// A cancel or stop that landed meanwhile owns the card.
					if (cur && cur.cancelledAt === null && cur.state === "preparing")
						store.updateTask(id, {
							state: "queued",
							needsReason: task.needsReason,
							asked: task.asked,
						});
					ops.publishSoon();
					return;
				}
				vmState.busy.delete(key);
				vmBusyAt.delete(key);
			}
			// Consume only what this turn sends; steering that landed since the build stays queued for the next one.
			// The column holds the raw parked text (raw, e.g. the dep-hold marker); pending may be the
			// dispatcher's swap of it, so strip by raw — a mismatched strip would re-steer forever.
			// The steer route appends with "\n\n", so only raw itself or raw plus that separator is
			// this turn's text: a cancelled steer replaced by one that merely starts with raw stays whole.
			const fresh = store.getTask(id);
			let rest = fresh?.pendingPrompt ?? null;
			if (raw !== null && pending !== null && rest !== null) {
				if (rest === raw) rest = null;
				else if (rest.startsWith(`${raw}\n\n`))
					rest = rest.slice(raw.length + 2) || null;
			}
			// Same prefix rule for images: a steer landing since the build appends, so drop only what this turn sends.
			let restImages = fresh?.pendingImages ?? [];
			if (
				restImages.length >= live.pendingImages.length &&
				live.pendingImages.every((n, i) => restImages[i] === n)
			)
				restImages = restImages.slice(live.pendingImages.length);
			store.updateTask(id, {
				pendingPrompt: rest,
				pendingImages: restImages,
				// rest holds only steering that landed mid-run (user); a full consume clears.
				pendingBy: rest === null ? null : "user",
			});
			const turnInput =
				pending &&
				(plan.resumeId !== null || (plan.note !== null && pending !== "."))
					? pending
					: null;
			turn = store.startTurn(
				id,
				kind,
				prompt,
				handle.pid,
				// The user text this turn delivered (steer or reply) — the timeline shows it on the turn.
				// A fresh session that folded the reply into its prompt records it here too; the "."
				// continue marker is not user text.
				turnInput,
				// The dispatch snapshot: the --model this turn starts with, so the card states the
				// selected model while it runs; the settled row keeps what the stream served.
				runModel,
				// live was read with raw, so its pendingBy is raw's authorship (a mid-run steer
				// lands after this read and rides the next turn).
				turnInput !== null ? live.pendingBy : null,
				// The layer this run pinned at start (null = flat home); a record only, clean-up reads in-use.json.
				handle.layerId ?? null,
				// The card-log byte offset captured with the header write; the drawer fetches the turn's section from it.
				turnLogOffset,
			);

			// RunEntry.done is Promise<unknown> for test fakes; the real handle resolves a RunResult.
			const result0 = (await handle.done) as RunResult;
			runMeter?.settle(result0);
			const runEndedAt = Date.now();
			// sweepLostTurns proved the pid dead and settled this turn's row; a late resolution must
			// not settle again or clobber the card the sweep requeued.
			if (entry?.abandoned) return;
			// OTTR-532: a microVM turn's tree lives in the VM. The server worktree follows the
			// branch tip in the main checkout (the git endpoint already syncs every push; this
			// covers a push whose sync failed), and the tree state comes from the VM's own report
			// below. The head the VM reports is a claim, never a reset target: the worktree only
			// ever moves to the real tip of the card's branch.
			const vmOut = vmTurn ? (result0.vm ?? null) : null;
			if (vmOut !== null) {
				if (vmOut.pushError !== null)
					log(`! microVM push failed: ${vmOut.pushError}`);
				const tip =
					branch === null
						? null
						: await ops
								.targetSha(e.path, `refs/heads/${branch}`)
								.catch(() => null);
				if (vmOut.head !== null && tip !== null && vmOut.head !== tip)
					log(
						`! microVM: reported head ${vmOut.head} is not the branch tip ${tip}`,
					);
				if (tip === null)
					log(
						`! microVM: branch ${branch ?? "(none)"} does not resolve; the worktree is not synced`,
					);
				else if (ops.syncWorktreeTo) {
					const syncTo = ops.syncWorktreeTo;
					const current = await ops.targetSha(wt, "HEAD").catch(() => null);
					if (current !== tip)
						await syncTo(wt, tip).catch((err: unknown) =>
							log(
								`! microVM: syncing the worktree to ${tip} failed: ${errmsg(err)}`,
							),
						);
				}
				// Uncommitted files the turn leaves for the board (the research report, shots)
				// never ride a push: the sentinel carries them, before the report read below.
				if (vmOut.files) writeVmFiles(wt, vmOut.files, log);
			}
			// The agent self-declares research by writing the report file; its presence at settle flips the card.
			// Sync read: settle must stay within one microtask flush (tests await runTurn or flush microtasks only).
			// No symlink is followed: a worker could point the file at a server-only secret (OTTR-233).
			let reportText: string | null = null;
			// A refused report (symlink, not a file, too big) holds the card: no quarantine, no removal.
			let reportError: string | null = null;
			if (kind === "work" && !interview && !grill && !scout) {
				try {
					reportText =
						readBelow(
							worktreeAnchor(e.path, wt),
							join(wt, RESEARCH_REPORT),
							REPORT_MAX_BYTES,
						)?.toString("utf8") ?? null;
				} catch (err) {
					reportError = errmsg(err);
					log(`! ${RESEARCH_REPORT}: ${reportError}`);
				}
			}
			const autoResearch =
				!releaseCard && !task.research && reportText !== null;
			if (autoResearch) store.updateTask(id, { research: true });
			const wasResearch = task.research || autoResearch;
			// A research card's later turn can do real work: a ready outcome, landable clean
			// commits, and no report file (it cleared the file it once self-declared with). The
			// demotion needs the git facts below, so the rewrite waits for that case.
			const demoteCandidate =
				wasResearch &&
				!interview &&
				!grill &&
				!releaseCard &&
				reportText === null &&
				reportError === null &&
				result0.outcome?.status === "ready";
			// An interview or trending scout card has nothing to integrate, and agents mix up
			// statuses: a ready outcome settles done.
			// A research card has nothing to integrate either: its deliverable is the report file.
			let result =
				(interview || scout || wasResearch) &&
				!demoteCandidate &&
				result0.outcome?.status === "ready"
					? {
							...result0,
							outcome: { ...result0.outcome, status: "answered" as const },
						}
					: result0;
			running.delete(key);

			if (result.killed || store.getTask(id)?.cancelledAt) {
				// A stop-turn request owns this kill: end the row as stopped and park the
				// card like Esc — worktree, branch and session stay, the user replies.
				const stopReason = stopping.get(key);
				stopping.delete(key);
				store.finishTurn(turn.id, {
					endedAt: Date.now(),
					exitCode: result.exitCode,
					error: stopReason !== undefined ? "stopped" : "cancelled",
				});
				// A cancel that landed meanwhile owns the card: cancelTask writes its kept
				// or idle state after the kill, so only mark the card when no cancel ran.
				const cur = store.getTask(id);
				if (stopReason !== undefined && cur && cur.cancelledAt === null)
					store.updateTask(id, {
						state: "needs_you",
						needsReason: stopReason,
					});
				return;
			}

			// ponytail: after an agent removes its worktree, an empty folder can stay (omp's cwd holds it on Windows),
			// and git there reads the main checkout: another card's unpushed merge fails `integrated`, and base..HEAD
			// counts main's commits. Upgrade: read the task branch from the main repo when `<worktree>/.git` is gone.
			// A husk (unlinked, no checkout) cannot speak for HEAD at all: when the branch is also gone or
			// already contained in the target, "integrated" is provable from the main repo alone.
			const husk =
				interview || grill || scout
					? false
					: await ops.worktreeHusk(wt).catch(() => false);
			// A deregistered worktree can lose its `.git` file while keeping the checkout: then neither
			// worktreeLinked (git climbs out) nor worktreeHusk's `.git`-file test fires. isIntegrated
			// returns false unconditionally there, so a merged card would bounce forever; the branch
			// inside the main repo is the proof (branchMergedOrGone).
			const unlinked =
				!interview &&
				!grill &&
				!scout &&
				!husk &&
				!(await ops.worktreeLinked(wt).catch(() => false));
			const fromMain = husk || unlinked;
			const finishedCleanly =
				result.exitCode === 0 &&
				result.sawTerminalEnd &&
				!result.killed &&
				!result.approvalRefused &&
				result.asked === null &&
				result.outcome?.status !== "needs_you";
			// Copy agent-reported UI screenshots into the task's images dir, before the
			// untracked-file quarantine and unsavedWork touch the worktree. Until 2026-10-09 the
			// tracker extension's report_outcome schema had no shots field, so the harness
			// dropped every reported shot; a plain work turn whose outcome carries no shots
			// still adopts the conventional shots/ directory. Never fails the turn. The copy
			// only reads the worktree: sources stay put, so committed shots keep the tree clean
			// for the ready gate's isClean read below (deleting them turned tracked files into
			// ` D` rows and bounced the turn). Adoption skips git-tracked shots: a committed
			// shot rides every fresh worktree, so adopting it pinned a leftover image on cards
			// whose agents never captured anything (the 2026-10-14 incident). Scratch shots
			// under the gitignored /shots/ and root /*.png paths stay on disk unseen (worktree
			// removal GCs them); other untracked scratch shots are swept afterwards by the
			// quarantine.
			let shots: string[] | undefined;
			if (result.outcome) {
				// Dedup by content: agents re-report the same screenshots (the same path
				// twice in one outcome, or again on a later turn of the same card), and each
				// copy used to land as a fresh numbered file. Seed with what the card has.
				// Byte-exact copies dedup on the sha256; a re-capture of an unchanged screen
				// (new bytes, same pixels) matches an existing shot visually and replaces it,
				// so a check send-back round does not double every screenshot on the card.
				const seen = new Set<string>();
				const stored: { name: string; gray: Uint8Array }[] = [];
				for (const name of task.shots) {
					try {
						const bytes = readRegular(join(store.imagesDir(id), name));
						seen.add(createHash("sha256").update(bytes).digest("hex"));
						const gray = pngGray16(bytes);
						if (gray !== null) stored.push({ name, gray });
					} catch {
						// pruned or absent: nothing to dedup against
					}
				}
				const reported = result.outcome.shots ?? [];
				let candidates: [string, string][] = [];
				if (reported.length > 0) {
					candidates = reported.map((shot) => [shot, resolve(wt, shot)]);
				} else if (
					kind === "work" &&
					!interview &&
					!grill &&
					!scout &&
					!wasResearch &&
					!releaseCard &&
					existsSync(join(wt, "shots"))
				) {
					const tracked = new Set(await ops.trackedFiles(wt, "shots"));
					candidates = readdirSync(join(wt, "shots"), { withFileTypes: true })
						.filter((d) => d.isFile() && !tracked.has(`shots/${d.name}`))
						.map((d) => [`shots/${d.name}`, join(wt, "shots", d.name)]);
				}
				const copied: DecodedImage[] = [];
				// Grays of this run's new copies: a second capture of the same new screen
				// in one outcome skips too, instead of landing as a fresh numbered file.
				const batch: Uint8Array[] = [];
				for (const [shot, p] of candidates) {
					try {
						if (!p.startsWith(resolve(wt) + sep))
							log(
								`! shot ${shot}: path escapes the worktree — keep the path inside the worktree, for example shots/<name>.png (shots/ is gitignored)`,
							);
						else {
							const bytes = readBelow(
								worktreeAnchor(e.path, wt),
								p,
								MAX_IMAGE_BYTES,
							);
							if (bytes === null) throw new Error("no such file");
							const ext = sniffImage(bytes);
							if (ext === null) log(`! shot ${shot}: not a recognized image`);
							else {
								const hash = createHash("sha256").update(bytes).digest("hex");
								if (seen.has(hash))
									log(`! shot ${shot}: duplicate of an existing screenshot`);
								else {
									const gray = pngGray16(bytes);
									if (gray === null) {
										// Undecodable (jpg, webp, exotic png): byte-exact dedup only.
										seen.add(hash);
										copied.push({ bytes, ext });
									} else {
										const twin = stored.findIndex((s) =>
											visuallyIdentical(s.gray, gray),
										);
										const batchTwin =
											twin === -1
												? batch.findIndex((g) => visuallyIdentical(g, gray))
												: -1;
										if (twin !== -1) {
											// Same screen, new bytes: refresh the stored shot in place
											// instead of appending a second copy of it.
											const name = stored[twin]!.name;
											writeBelow(
												store.dataRoot,
												join(store.imagesDir(id), name),
												bytes,
												"truncate",
											);
											stored[twin] = { name, gray };
											seen.add(hash);
											log(
												`! shot ${shot}: visually identical to ${name} — replaced it`,
											);
										} else if (batchTwin !== -1) {
											seen.add(hash);
											log(
												`! shot ${shot}: visually identical to a shot saved this turn`,
											);
										} else {
											seen.add(hash);
											copied.push({ bytes, ext });
											batch.push(gray);
										}
									}
								}
							}
						}
					} catch (err) {
						log(`! shot ${shot}: ${err instanceof Error ? err.message : err}`);
					}
				}
				if (copied.length > 0) {
					const names = saveImages(store.dataRoot, store.imagesDir(id), copied);
					shots = [...task.shots, ...names].slice(-8); // cap 8, keep newest
				}
			}
			if (
				kind === "work" &&
				!interview &&
				!grill &&
				!scout &&
				!wasResearch &&
				!releaseCard &&
				finishedCleanly &&
				reportError === null
			) {
				try {
					const moved = await ops.quarantineUntracked(
						wt,
						join(store.tasksDir, "quarantine", id),
						store.dataRoot,
					);
					if (moved.length > 0)
						appendLog(
							store,
							id,
							`quarantined ${moved.length} untracked file(s) to .tasks/quarantine/${id}: ${moved.slice(0, 20).join(", ")}${moved.length > 20 ? " …" : ""}`,
						);
				} catch (err) {
					appendLog(store, id, `quarantine failed: ${errmsg(err)}`);
				}
			}
			// Per-host git credentials never enter an agent, so the server pushes a merge itself.
			// It runs before the integration facts: the check reads origin's tip, which only this
			// push moves. It is gated on proof of the local merge in the main repo, never on what
			// the agent reported. A removed worktree (fromMain) still pushes: its merge is on the
			// local branch, and only this push moves it to origin.
			let pushError: string | null = null;
			// OTTR-394: the push failed as a rejected non-fast-forward (origin moved).
			let pushRejected = false;
			// OTTR-465: git's complete push output for the card log, and a failed origin
			// re-check ahead of the retry — both reach the card log and the park reason.
			let pushOutput: string | null = null;
			let recheckError: string | null = null;
			// The head a settle parks for a hold: a work-settle hold parks the worktree HEAD, a
			// merge-hold mismatch park the local target head. A reply approves exactly this head.
			let holdHead: string | null = null;
			// OTTR-274: set when a held merge carries patches beyond the approval; parks the card
			// after classify instead of landing it. holdDiff/holdFiles carry the exact push-side
			// delta for the reviewer: the parked card's drawer serves them instead of the live
			// worktree diff, which no longer speaks for the push set.
			let holdMismatch: string | null = null;
			let holdDiff: string | null = null;
			let holdFiles: DiffFileStat[] | null = null;
			// The origin tip the gate fetched and audited; the push leases against it so a
			// merge agent cannot aim the fetch and the push at different remotes.
			let holdTip: string | null = null;
			// VELV-89: the probe proved the merge already landed on the fetched remote target
			// with no patches beyond the approval. No park, no push: the settle reads it as the
			// integration proof (the worktree and the local branch can both still sit behind
			// origin, so the ordinary git facts cannot prove it).
			let remoteLanded = false;
			// The merge push and the OTTR-510 automatic rebase retry in the pushError handling
			// below push through the same closure. `refused` stays null for every non-merge
			// turn: only a merge settle pays for the hold-tip read.
			let refused: string | null = null;
			// Appends the GitHub-API hint under a bare 401/403; the git error stands alone
			// when the probe cannot say more. Never throws.
			const withAuthHint = async (
				url: string,
				error: string,
			): Promise<string> => {
				if (!GIT_HTTP_AUTH_STATUS.test(error)) return error;
				try {
					return error + ((await ops.githubAuthHint(url)) ?? "");
				} catch {
					return error;
				}
			};
			// PR mode: the settle's ship step decides the card's next state itself (merging/idle
			// with the PR stored, or a needs_you park); it overrides classify's done.
			let prNext: Next | null = null;
			const runPush = (): Promise<
				| { status: "skipped" }
				| { status: "pushed"; output: string }
				| { status: "failed" | "rejected"; error: string; output?: string }
			> =>
				refused !== null
					? Promise.resolve({
							status: "failed" as const,
							error: refused,
						})
					: ops
							.serverMergePush(
								e.path,
								wt,
								target,
								task.branch ?? "",
								holdTip,
								settings.originUrl,
							)
							.then(async (p) =>
								(p.status === "failed" || p.status === "rejected") &&
								typeof settings.originUrl === "string" &&
								settings.originUrl !== ""
									? {
											...p,
											error: await withAuthHint(settings.originUrl, p.error),
										}
									: p,
							)
							.catch((err: unknown) => ({
								status: "failed" as const,
								error: errmsg(err),
							}));
			const mergeMachinery =
				kind === "merge" && !interview && !grill && !releaseCard;
			if (mergeMachinery) {
				// PR mode ships the card branch itself: the server pushes the branch and opens the
				// pull request, so nothing local is ever pushed to the target — the merge-hold
				// machinery and serverMergePush of the target must not run for these cards.
				if (settings.prMode === true) {
					// The ship step settles an integrated report and nothing else: the PR prompt
					// rebases before the gates and the security review, so a clean rebased tree
					// alone proves nothing about their verdict. A needs_you report (a blocking
					// finding, a failed gate) must reach classify and park with the agent's
					// question — prNext stays null so classify decides.
					if (result.outcome?.status !== "integrated") {
						if (result.outcome === null)
							// A lost receipt must not land via classify's git-integrated done
							// path: nothing was merged, so ask for a human instead.
							prNext = {
								stage: "merging",
								state: "needs_you",
								needsReason:
									"The agent finished without calling report_outcome.",
							};
					} else if (task.prNumber !== null) {
						// A card already carrying a PR never re-ships: its PR is open and the
						// tracker waits on GitHub; the card just stays merging/idle.
						prNext = { stage: "merging", state: "idle", needsReason: null };
					} else if (ops.pushBranch === undefined || ops.openPr === undefined) {
						prNext = {
							stage: "merging",
							state: "needs_you",
							needsReason:
								"PR mode is on but the server's ship step is not wired; restart the board",
						};
					} else {
						// Ship a proven integration: the same proof classify reads (clean tree,
						// origin/<target> an ancestor of HEAD). An unproven integrated report
						// ships nothing — classify takes the not-on-target park.
						const proof = await ops
							.prIntegrated?.(e.path, wt, target)
							.catch(() => false);
						const prBranch = task.branch ?? "";
						const tip =
							proof === true
								? await ops
										.targetSha(e.path, `refs/heads/${prBranch}`)
										.catch(() => null)
								: null;
						if (proof !== true) {
							// No ship: classify parks the integrated report as not-on-target.
						} else if (tip === null || prBranch === "") {
							prNext = {
								stage: "merging",
								state: "needs_you",
								needsReason: `PR mode could not read the branch tip for ${prBranch || "(no branch)"}`,
							};
						} else if (settings.originUrl === null) {
							prNext = {
								stage: "merging",
								state: "needs_you",
								needsReason:
									"no pinned origin URL; restart the board (or set it in project settings) so the server pins the origin remote before pushing the branch",
							};
						} else {
							const pr = await ops
								.pushBranch(e.path, prBranch, settings.originUrl)
								.catch((err: unknown) => ({
									status: "failed" as const,
									error: errmsg(err),
								}));
							if (pr.status === "pushed") {
								log(`- pushed ${prBranch} from the server`);
							} else {
								log(
									`! server push of ${prBranch} ${pr.status === "rejected" ? "rejected" : "failed"}: ${pr.error}`,
								);
								const pushOut = "output" in pr ? (pr.output ?? null) : null;
								if (pushOut !== null)
									log(`git's full push output:\n${pushOut}`);
								const kindAuth =
									settings.originUrl === null
										? null
										: (ops.pushAuthKind?.(settings.originUrl) ?? null);
								if (kindAuth !== null) log(`- push auth: ${kindAuth}`);
								prNext = {
									stage: "merging",
									state: "needs_you",
									needsReason: `Server push to origin failed: ${pr.error}`,
								};
							}
							if (pr.status === "pushed") {
								// The PR needs a GitHub remote: PR mode without one is not a state
								// the board holds, but the setting can drift — fail closed here.
								const repo = e.github === null ? null : ownerRepo(e.github);
								if (repo === null) {
									prNext = {
										stage: "merging",
										state: "needs_you",
										needsReason:
											"PR mode requires a GitHub remote on the project; disable PR mode or add the remote",
									};
								} else {
									const slash = repo.indexOf("/");
									const opened = await ops
										.openPr({
											repo,
											owner: repo.slice(0, slash),
											branch: prBranch,
											base: target.replace(/^origin\//, ""),
											title: task.title,
											body: prBody(task, result.outcome),
											// Hosted: gh takes the project's minted token, never GH_TOKEN.
											...(ops.hosted !== undefined && {
												gh: await hostedGh(e.path, settings.originUrl),
											}),
										})
										.catch((err: unknown) => ({
											ok: false as const,
											error: errmsg(err),
										}));
									if (!opened.ok) {
										log(`! opening the pull request failed: ${opened.error}`);
										prNext = {
											stage: "merging",
											state: "needs_you",
											needsReason: `Opening the pull request failed: ${opened.error}`,
										};
									} else {
										store.updateTask(id, {
											stage: "merging",
											state: "idle",
											needsReason: null,
											prNumber: opened.pr.number,
											prUrl: opened.pr.url,
											prHeadSha: tip,
											pushSha: tip,
										});
										appendLog(
											store,
											id,
											`- PR #${opened.pr.number} opened (base ${target.replace(/^origin\//, "")})`,
										);
										prNext = {
											stage: "merging",
											state: "idle",
											needsReason: null,
										};
									}
								}
							}
						}
					}
				} else {
					// An approved merge hold fixes what may ship. The merge turn resumes the same agent
					// session and could commit beyond the approved head, so the push set
					// (target..refs/heads/<branch>) must carry exactly the approved patches
					// (base..approvedHead). Fails closed: git trouble parks the card. A reply to the
					// mismatch park approves the exact parked head, so a sha-equal re-merge pushes.
					const approvedHeads = [
						task.updateMergeHead,
						task.forkMergeHead,
					].filter((h) => h !== null);
					const branch = target.startsWith("origin/")
						? target.slice("origin/".length)
						: null;
					const localHead =
						branch === null || approvedHeads.length === 0
							? null
							: await ops
									.targetSha(e.path, `refs/heads/${branch}`)
									.catch(() => null);
					if (branch !== null && approvedHeads.length > 0) {
						if (localHead !== null && approvedHeads.includes(localHead)) {
							// the exact head a reply approved: nothing new to judge
						} else {
							// VELV-89: the merge can land through a project rule that pushes the target
							// from the worktree and never moves the main checkout's local branch, so
							// the gate below would judge a stale push set and park a landed card. Ask
							// the fetched remote target first: every approved head already contained
							// in it and no patches beyond the approval means the merge landed — settle
							// it. False on git trouble or extra patches: the gate below judges the
							// push set, and it still fails closed into the park.
							const landed = await ops
								.mergeHoldLanded(
									e.path,
									target,
									base,
									approvedHeads,
									settings.originUrl,
								)
								.catch(() => false);
							if (landed) {
								remoteLanded = true;
								log(
									`- approved head already on ${target}: the merge landed without the local branch moving`,
								);
							} else {
								for (const ah of approvedHeads) {
									const { mismatch, pushDiff, auditedTip } = await ops
										.mergeHoldMismatch(
											e.path,
											target,
											base,
											ah,
											settings.originUrl,
										)
										.catch(() => ({
											mismatch: true,
											pushDiff: null,
											auditedTip: null,
										}));
									if (mismatch) {
										holdMismatch = MERGE_HOLD_MISMATCH_REASON;
										holdHead = localHead;
										// Same cap as the merge-start capture: bigger diffs keep their numstat.
										holdDiff =
											pushDiff === null
												? null
												: pushDiff.length > 200_000
													? `${pushDiff.slice(0, 200_000)}\n… diff truncated at 200 KB`
													: pushDiff;
										holdFiles =
											holdDiff === null
												? null
												: await ops
														.diffStat(e.path, target, `refs/heads/${branch}`)
														.catch(() => null);
										log(
											"! held merge carries patches beyond the approved head",
										);
										// OTTR-326: the park resets the branch to the gate's audited tip so the
										// held patches cannot ship with a later card's un-gated push; the
										// reviewer still reads them from holdDiff/holdFiles. Without an audited
										// tip (gate fetch failed) there is no trusted tip to reset to, and the
										// push refusal below keeps the branch pinned instead.
										const reset =
											auditedTip !== null &&
											(await ops
												.resetBranchTo(e.path, branch, auditedTip)
												.catch(() => false));
										if (!reset)
											log(
												"! merge-hold park kept the held patches on the local target branch; resolve it by hand before any merge",
											);
										break;
									}
									holdTip = auditedTip;
								}
							}
						}
					}
					// OTTR-326: a park whose branch reset could not run leaves the held patches as the
					// local tip; no other card may push the branch while that head sits there.
					refused = await heldMergeOnBranchTip(store, id, e.path, branch, ops);
					// A landed merge has nothing to push: the remote target already holds every
					// approved patch, and pushing the stale local branch would only fight it.
					if (holdMismatch === null && !remoteLanded) {
						let p = await runPush();
						let authLogged = false;
						for (let attempt = 1; ; attempt++) {
							if (p.status === "skipped") break;
							if (p.status === "pushed") {
								// A retry that landed erases the earlier failure: the card lands instead
								// of parking on an error the second push already resolved.
								pushError = null;
								pushOutput = null;
								pushRejected = false;
								// OTTR-506: the push put the target on origin, so the merge hold lifts
								// at once instead of waiting for the tick's branchUnpushed refresh.
								e.mainUnpushed = false;
								log(`- pushed ${target} from the server`);
								// The agent's own push has no credentials (D6). A merge agent that stopped at
								// needs_you on that authentication failure did integrate: the server push landed
								// it, so the report becomes integrated with the push output in details.
								const o = result.outcome;
								const text = `${o?.summary ?? ""}\n${o?.details ?? ""}\n${o?.question ?? ""}`;
								if (o?.status === "needs_you" && GIT_AUTH_FAILURE.test(text)) {
									result = {
										...result,
										asked: null,
										outcome: {
											...o,
											status: "integrated",
											question: undefined,
											details: `${o.details ?? o.summary}\n\nServer push of ${target}:\n${p.output || "(no output)"}`,
										},
									};
									log(
										"- needs_you on a push authentication failure resolved: the server pushed",
									);
								}
								break;
							}
							pushRejected = p.status === "rejected";
							pushError = p.error;
							pushOutput = p.output ?? null;
							log(
								`! server push of ${target} ${pushRejected ? "rejected" : "failed"}: ${p.error}`,
							);
							// OTTR-465: the card log keeps git's complete output, so the cause a
							// permission failure points at (a missing App installation, a token scope)
							// stays visible, and one line names the credential kinds the push could use.
							if (pushOutput !== null)
								log(`git's full push output:\n${pushOutput}`);
							if (!authLogged) {
								authLogged = true;
								const kind =
									settings.originUrl === null
										? null
										: (ops.pushAuthKind?.(settings.originUrl) ?? null);
								if (kind !== null) log(`- push auth: ${kind}`);
							}
							// OTTR-465: a push can fail while origin never moved (a dropped connection,
							// a token-refresh hiccup): ALAT-60 landed unchanged on a later merge turn.
							// One retry, when a fetch proves the push should still be a fast-forward —
							// origin's tip still sits at the base the merge started from, or the local
							// head is a fast-forward of it. A rejected push (origin moved) takes the
							// OTTR-394 rebase path below instead.
							if (
								pushRejected ||
								refused !== null ||
								branch === null ||
								attempt > 1
							)
								break;
							if (settings.originUrl === null) {
								log(
									"! no pinned origin URL; cannot re-check origin's tip before a push retry",
								);
								break;
							}
							const fetchError = await ops
								.fetchOriginBranch(e.path, branch, settings.originUrl)
								.then(() => null)
								.catch((err: unknown) =>
									withAuthHint(settings.originUrl ?? "", errmsg(err)),
								);
							if (fetchError !== null) {
								// The re-check's own reason (a network error, a token-refresh failure)
								// rides the park reason; the retry stays off without a proven origin tip.
								recheckError = fetchError;
								log(
									`! origin re-check before a push retry failed: ${fetchError}`,
								);
								break;
							}
							const originTip = await ops
								.targetSha(e.path, `refs/remotes/origin/${branch}`)
								.catch(() => null);
							const localTip = await ops
								.targetSha(e.path, `refs/heads/${branch}`)
								.catch(() => null);
							const fastForward =
								originTip !== null &&
								localTip !== null &&
								(await ops
									.targetContains(e.path, originTip, localTip)
									.catch(() => false));
							if (!fastForward) {
								log(
									"! origin moved or its tip is unreadable; not retrying the push",
								);
								break;
							}
							const waitMs = ops.pushRetryDelayMs ?? MERGE_PUSH_RETRY_WAIT_MS;
							log(
								`- origin did not move; retrying the server push once in ${Math.round(waitMs / 1000)} s`,
							);
							await new Promise<void>((r) => setTimeout(r, waitMs));
							p = await runPush();
						}
					}
				}
			}
			// PR mode proves the rebase instead of the merge: origin/<target> an ancestor of the
			// worktree HEAD on a clean tree — the branch is rebased and ready for the server's
			// mechanical steps. Every other project keeps today's targetContains proof.
			const prModeFacts =
				kind === "merge" &&
				!interview &&
				!grill &&
				!fromMain &&
				!releaseCard &&
				settings.prMode === true;
			const facts: GitFacts = {
				// An interview card runs in the main checkout with no base branch: the commits-ahead
				// gate would count its own AGENTS.md commit and trap the card, so it stays exempt.
				// A trending scout runs there too: the checkout's own commits are never its work.
				// A husk or unlinked dir would make git speak for the enclosing checkout instead,
				// so the main-repo proof stands in for all three facts there.
				commitsAhead:
					interview || grill || scout || fromMain
						? 0
						: await ops.commitsAhead(wt, base).catch(() => 0),
				// A microVM's tree is gone with the VM: its end-of-run status report decides,
				// and a VM that could not report (null) is never clean.
				clean: fromMain
					? true
					: vmOut !== null
						? vmOut.dirty !== null && vmOut.dirty.length === 0
						: await ops.isClean(wt).catch(() => false),
				integrated:
					// VELV-89: the hold probe proved the fetched remote target holds the approved
					// merge; the stale worktree proof cannot see it.
					remoteLanded ||
					(fromMain
						? await ops
								.branchMergedOrGone(e.path, task.branch ?? "", target)
								.catch(() => false)
						: prModeFacts
							? ((await ops
									.prIntegrated?.(e.path, wt, target)
									.catch(() => false)) ?? false)
							: await ops.isIntegrated(wt, target).catch(() => false)),
			};
			// Landable clean commits with the report file gone: the card did real work after its
			// research mark. Clear the flag and classify like any other work turn — the ready
			// outcome was held unrewritten, so classify's ready branch sends it to merging.
			const demoted = demoteCandidate && facts.commitsAhead > 0 && facts.clean;
			if (demoted) store.updateTask(id, { research: false });
			const research = wasResearch && !demoted;
			// listTurns ends with this turn; the one before it tells classify whether this exit repeats.
			let next = classify({
				kind,
				result,
				git: facts,
				research,
				hasReport: reportText !== null,
				grill,
				target,
				previousError: store.listTurns(id).at(-2)?.error ?? null,
				...(vmOut !== null ? { vmDirty: vmOut.dirty } : {}),
				images: imagePaths.length,
				http400: () =>
					findHttp400Rejection({
						from: runStartedAt,
						to: runEndedAt,
						dir: ops.http400Dir,
					}),
			});
			// The PR-mode ship step owns the card's next state: it never lands, so the done
			// write below (pushSha pinning, worktree removal, release stamping) is skipped.
			if (prNext !== null) next = prNext;
			// A run the provider stopped at its usage limit continues automatically (classify's
			// queued continue): stamp the provider's reset as the hold, so the continue fires
			// after the reset instead of against the still-exhausted window. Without a known
			// reset the retry starts at once; classify's streak rule parks the next identical
			// death for a human.
			if (
				next.state === "queued" &&
				next.pendingPrompt !== undefined &&
				hitUsageLimit(result)
			) {
				const hit = await usageResetFor(result.model ?? runModel ?? null);
				if (hit !== null) {
					const at = new Date(hit.resetsAt)
						.toISOString()
						.slice(0, 16)
						.replace("T", " ");
					next = {
						...next,
						holdUntil: hit.resetsAt,
						holdProvider: hit.provider,
						holdWindow: hit.window,
						needsReason: `${QUOTA_LIMIT} - the board continues the task after the ${hit.provider} limit resets at ${at} UTC. Cancel to stop it instead.`,
					};
				}
			}
			// A failed server push keeps the card at merging with git's reason: the worktree stays.
			// OTTR-394: a rejected non-fast-forward means origin moved while the merge ran. The
			// server fetches origin with its own credentials, then — OTTR-510 — rebases the
			// target branch onto the fetched tip, runs the merge gates, and pushes again. The
			// recovery merge turn goes out only when the automatic retry cannot converge: a
			// rebase conflict, failed gates, or a still-rejected retry push. The guards are
			// unchanged: the retry budget (2 automatic retries per card), a hold-approved push
			// whose lease pins one exact head (OTTR-274), and the pinned origin URL all still
			// take today's needs_you with git's reason.
			if (pushError !== null) {
				// OTTR-506: the rejection left local main with commits origin lacks, so the
				// merge hold must gate the very next tick, not wait for the refresh.
				if (pushRejected) e.mainUnpushed = true;
				const branch = target.startsWith("origin/")
					? target.slice("origin/".length)
					: null;
				const retries = store.getTask(id)?.pushRetries ?? 0;
				const ruleHint = BRANCH_RULE_REJECTION.test(pushError)
					? "\nThis push was refused by a GitHub branch rule: the target branch requires pull requests. Project PR mode ships cards as pull requests instead; turn it on under the project's settings."
					: "";
				if (
					pushRejected &&
					holdTip === null &&
					branch !== null &&
					retries < MERGE_PUSH_RETRIES
				) {
					const fetchError =
						settings.originUrl === null
							? "no pinned origin URL to fetch the moved tip from"
							: await ops
									.fetchOriginBranch(e.path, branch, settings.originUrl)
									.then(() => null)
									.catch((err: unknown) =>
										withAuthHint(settings.originUrl ?? "", errmsg(err)),
									);
					if (fetchError !== null) {
						next = {
							stage: "merging",
							state: "needs_you",
							needsReason: `Server push to origin failed: ${pushError}${ruleHint}`,
						};
					} else {
						log(
							`- push rejected and origin moved: trying the automatic rebase of ${branch} onto the fetched tip first`,
						);
						// OTTR-510: the recovery steer is built here but sent only from the paths
						// where the automatic retry cannot converge.
						const queueRebaseTurn = async (): Promise<void> => {
							// The gates can run minutes: re-fetch so the prompt's "the server has
							// fetched origin" stays true when the recovery turn starts.
							const refetchError =
								settings.originUrl === null
									? "no pinned origin URL to fetch the moved tip from"
									: await ops
											.fetchOriginBranch(e.path, branch, settings.originUrl)
											.then(() => null)
											.catch((err: unknown) =>
												withAuthHint(settings.originUrl ?? "", errmsg(err)),
											);
							if (refetchError !== null) {
								log(
									`! origin re-fetch before the recovery turn failed: ${refetchError}`,
								);
								// Fail closed: no turn queued, no retry budget spent.
								next = {
									stage: "merging",
									state: "needs_you",
									needsReason: `Server push to origin failed: ${pushError}\norigin re-fetch before the recovery turn failed: ${refetchError}${ruleHint}`,
								};
								return;
							}
							const prompt = rebaseRetryPrompt({
								branch,
								attempt: retries + 1,
								max: MERGE_PUSH_RETRIES,
							});
							// Steering that landed mid-run rides the rebase turn, its authorship
							// leading — the same rule a hold park follows under queued user text.
							const steer = store.getTask(id)?.pendingPrompt ?? null;
							store.updateTask(id, { pushRetries: retries + 1 });
							appendLog(
								store,
								id,
								`server push rejected: origin moved, merge turn queued to rebase (retry ${retries + 1} of ${MERGE_PUSH_RETRIES})`,
							);
							next = {
								stage: "merging",
								state: "queued",
								needsReason: null,
								pendingPrompt:
									steer === null ? prompt : `${prompt}\n\n${steer}`,
								pendingBy:
									steer === null ? "supervisor" : (live.pendingBy ?? "user"),
							};
						};
						const rb = await ops
							.rebaseTargetBranch(e.path, branch)
							.catch((err: unknown) => ({
								ok: false as const,
								conflict: false,
								error: errmsg(err),
							}));
						if (!rb.ok && rb.conflict) {
							log(
								`! the automatic rebase of ${branch} hit a conflict (the branch stays on its rejected head); queuing the rebase turn (retry ${retries + 1} of ${MERGE_PUSH_RETRIES})`,
							);
							await queueRebaseTurn();
						} else if (!rb.ok) {
							// Fail closed: no turn queued, no retry budget spent.
							log(`! the automatic rebase of ${branch} failed: ${rb.error}`);
							next = {
								stage: "merging",
								state: "needs_you",
								needsReason: `Server push to origin failed: ${pushError}\nthe automatic rebase failed: ${rb.error}${ruleHint}`,
							};
						} else {
							log(
								`- automatic rebase of ${branch} onto the fetched origin tip converged; running the merge gates (bun run check, bun test)`,
							);
							const gates = await ops
								.runMergeGates(e.path)
								.catch((err: unknown) => ({ ok: false, output: errmsg(err) }));
							if (!gates.ok) {
								log(
									`! merge gates failed on the rebased ${branch}; queuing the rebase turn (retry ${retries + 1} of ${MERGE_PUSH_RETRIES})`,
								);
								if (gates.output !== "")
									log(`! merge gates output:\n${gates.output}`);
								await queueRebaseTurn();
							} else {
								log(
									`- merge gates passed on the rebased ${branch}; retrying the server push`,
								);
								const p2 = await runPush();
								if (p2.status === "pushed") {
									pushError = null;
									pushOutput = null;
									pushRejected = false;
									log(
										`- pushed ${target} from the server after the automatic rebase`,
									);
								} else if (p2.status === "skipped") {
									pushError = null;
									pushOutput = null;
									pushRejected = false;
									log(
										"- server push skipped after the automatic rebase (nothing to push)",
									);
								} else {
									log(
										`! the retry push of ${target} ${p2.status} after the automatic rebase: ${p2.error}`,
									);
									await queueRebaseTurn();
								}
							}
						}
					}
				} else {
					next = {
						stage: "merging",
						state: "needs_you",
						needsReason: `Server push to origin failed: ${pushError}${recheckError === null ? "" : `\norigin re-check failed: ${recheckError}`}${ruleHint}`,
					};
				}
			}
			// OTTR-274: a held merge carries patches beyond the approval: park instead of landing
			// it. holdHead holds the exact local target head the reply can approve.
			if (holdMismatch !== null)
				next = {
					stage: "in_progress",
					state: "needs_you",
					needsReason: holdMismatch,
				};
			if (mergeMachinery) {
				// OTTR-708: the merge machinery has done all it will do to the main checkout —
				// the merge agent fast-forwarded it before the push, the settle may have reset
				// the branch (resetBranchTo on a hold park), and the push attempt ended pushed,
				// failed, rejected, or skipped, or was refused outright, or never ran. Record
				// the head it left behind, whatever the path took, so the checkout guard of a
				// concurrent work turn in another project discounts the board's own advance.
				const s = await ops.checkoutState(e.path).catch(() => null);
				if (s !== null && s.head !== null) boardPushedHeads.set(name, s.head);
			}
			if (
				fromMain &&
				!facts.integrated &&
				next.needsReason?.startsWith("Reported integrated, but HEAD is not on")
			)
				next = {
					...next,
					needsReason: "worktree link lost and branch has unreached commits",
				};
			// A no-stderr death carries its dispatch context in the reason; the run log gets the
			// same line so an operator tailing the log sees the answer without opening the board.
			if (
				next.needsReason?.startsWith("omp exited with code ") &&
				next.needsReason.includes(" (dispatch ")
			)
				appendLog(store, id, next.needsReason);
			if (next.quarantineImages) {
				try {
					const moved = quarantineImageFiles(
						store.dataRoot,
						store.imagesDir(id),
						join(store.tasksDir, "quarantine", id),
						turnImages,
					);
					store.updateTask(id, {
						images: live.images.filter((n) => !moved.includes(n)),
					});
					appendLog(
						store,
						id,
						`provider rejected the attached images (died before any output); quarantined ${moved.length} image(s) to .tasks/quarantine/${id}: ${moved.slice(0, 20).join(", ")} — retrying text-only`,
					);
				} catch (err) {
					// Never requeue with the images still attached: that is the loop this handles.
					next = {
						stage: kind === "work" ? "in_progress" : "merging",
						state: "needs_you",
						needsReason: `Image quarantine failed: ${errmsg(err)}.`,
					};
				}
			}
			// A run that could not restore its model never delivered this turn's reply: the retry
			// sends it again, with any steering that landed meanwhile.
			const restoreRetry =
				next.state === "queued" &&
				next.needsReason?.startsWith(MODEL_RESTORE) === true;
			if (restoreRetry) {
				const sent = [raw, store.getTask(id)?.pendingPrompt ?? null].filter(
					(p): p is string => p !== null && p !== ".",
				);
				next = {
					...next,
					pendingPrompt: sent.join("\n\n") || (raw ?? undefined),
					// raw's authorship leads the re-park; a null behaves as user.
					pendingBy: live.pendingBy ?? "user",
				};
			}
			// Steering queued while the turn ran: deliver it as the next turn instead of settling
			// (a pendingPrompt at turn end can only have arrived via /steer mid-run).
			const steered = (store.getTask(id)?.pendingPrompt ?? null) !== null;
			if (steered && !restoreRetry)
				next = {
					stage: kind === "work" ? "in_progress" : "merging",
					state: "queued",
					needsReason: null,
				};
			// The agent holds this turn on other cards (report_outcome dependsOn): valid ids are
			// recorded on the card, and a needs_you outcome requeues it in the current stage instead
			// of parking at needs_you — the scheduler restarts the turn when every id is done or
			// cancelled (waitingOn). A bad id — this card itself, an unknown project's handle, a
			// missing card here or abroad — parks needs_you naming it; the ids are not recorded.
			const outcome = result.outcome;
			const reportedDeps = outcome !== null ? outcome.dependsOn : undefined;
			if (reportedDeps !== undefined && reportedDeps.length > 0) {
				// OTTR-708: ids resolve across the board's projects, this store's own cards first.
				const depProjects = depProjectsOf(projects.values());
				const ownDep = depProjectOf(store);
				const bad = badDep(reportedDeps, depProjects, ownDep, id);
				if (bad !== null)
					next = {
						stage: next.stage,
						state: "needs_you",
						needsReason: bad.reason,
						asked: next.asked,
					};
				else {
					const merged = [...new Set([...task.dependsOn, ...reportedDeps])];
					if (
						merged.length !== task.dependsOn.length ||
						reportedDeps.some((d, i) => task.dependsOn[i] !== d)
					)
						store.updateTask(id, { dependsOn: merged });
					if (
						outcome?.status === "needs_you" &&
						next.state === "needs_you" &&
						next.asked === undefined
					)
						next = {
							stage: next.stage,
							state: "queued",
							needsReason: depHold(
								store.listTasks(),
								{ ...task, dependsOn: merged },
								(did) => findDep(did, depProjects, ownDep),
							),
							pendingPrompt: DEP_HELD_PROMPT,
							pendingBy: "supervisor",
						};
				}
			}
			// Review cards never integrate: committing fails the review, and a release publishes via the tracker.
			if (reviewCard && next.stage === "merging")
				next = {
					stage: "in_progress",
					state: "needs_you",
					needsReason: releaseCard
						? "A release review must not commit. Cancel this release, or reply to continue."
						: "A review must not commit. Cancel this review, or reply to continue.",
				};
			// A trending scout is read-only: it reads the main checkout and files cards through
			// the board, so nothing of it may ever reach a merge turn.
			if (scout && next.stage === "merging")
				next = {
					stage: "in_progress",
					state: "needs_you",
					needsReason: "A trending scout must not commit.",
				};
			if (reviewCard && next.stage === "done") {
				// Findings recorded this run hold the card at merging/idle with FINDINGS_HOLD;
				// the check below files the kept ones while the card is still in_progress/running,
				// and only then is the parked state stored: settleReviews never sees a parked
				// card whose findings are missing.
				const hold =
					result.recorded.length > 0
						? FINDINGS_HOLD
						: findingsHold(store.listTasks(), task);
				if (hold !== null)
					next = { stage: "merging", state: "idle", needsReason: hold };
				else if (releaseCard) {
					const err = await publishReleaseCard(e, task, base, wt, target);
					if (err !== null)
						next = {
							stage: "in_progress",
							state: "needs_you",
							needsReason: err,
						};
				}
				// A cancel before the publish step skips it and is caught by the settle recheck below;
				// from the publish step to the final write, the `publishing` claim refuses a cancel.
			}
			// UI-shot guard: a work turn whose diff touches UI files (uiFiles) but attached no
			// screenshot warns — the board would otherwise show UI work without visual proof. On a
			// clean settle it re-prompts: the session resumes with a request to capture the shot.
			// A second miss parks the card at needs_you instead of letting it settle toward
			// done: a UI change must not reach done without its screenshot, and only a human
			// (one more capture attempt, or an explicit cancel) can end the ping-pong.
			if (
				kind === "work" &&
				!interview &&
				!grill &&
				!scout &&
				!research &&
				!releaseCard &&
				// This turn's copies count, and so do shots an earlier turn on this card attached:
				// changedFiles is the card's cumulative diff, so without the card's history
				// every later clean turn would re-prompt for a screenshot that already exists.
				!(shots ?? task.shots).length
			) {
				const changed = await ops
					.changedFiles(wt, base, target)
					.catch(() => [] as string[]);
				const ui = uiFiles(changed);
				if (ui.length > 0) {
					const priorLog = existsSync(store.logPath(id))
						? readRegular(store.logPath(id)).toString("utf8")
						: "";
					appendLog(store, id, `${UI_SHOT_WARNING}: ${listed(ui)}`);
					if (next.needsReason === null && !steered) {
						if (!priorLog.includes(UI_SHOT_WARNING))
							next = {
								stage: "in_progress",
								state: "queued",
								needsReason:
									"no screenshot attached - resuming automatically to capture one. Cancel to stop it instead.",
								pendingPrompt: uiShotReprompt(ui),
								pendingBy: "supervisor",
							};
						else
							next = {
								stage: "in_progress",
								state: "needs_you",
								needsReason: `UI files changed (${listed(ui)}) but still no screenshot was attached. The card cannot finish without one: reply to resume the session and have it capture the shot (report_outcome's shots field), or cancel the card.`,
							};
					}
				}
			}
			if (reportError !== null && !releaseCard && next.state !== "queued")
				next = {
					stage: "in_progress",
					state: "needs_you",
					needsReason: `The research report file ${RESEARCH_REPORT} cannot be read: ${reportError}. Reply to have the agent write it as a regular file, or cancel the card.`,
				};
			// Delete check: a worktree that still holds changes or unmerged commits is kept, and the card asks you.
			// A review card's worktree is disposable (mutation runs leave report files, and a review
			// must not commit), so it skips the check.
			// A research card's worktree is disposable like a review card's: the report is already harvested.
			// A trending scout's cwd is the main checkout: what it holds is the user's, never the card's.
			const unsaved =
				next.stage === "done" &&
				!reviewCard &&
				!interview &&
				!scout &&
				!research
					? await ops.unsavedWork(wt, target)
					: null;
			// A research card's deliverable is the report file: archive it before the worktree goes.
			let report: string | null | undefined;
			if (research && !interview && next.state !== "queued") {
				report = reportText;
				if (next.stage === "done" && report === null)
					next = {
						stage: "in_progress",
						state: "needs_you",
						needsReason: `The research report file ${RESEARCH_REPORT} is missing from the worktree. Reply to have the agent write it, or cancel the card.`,
					};
			}
			// OTTR-488: harvest the steps recommendation with the report — 'yes' when the report
			// recommends steps by the same detection the drawer button uses (the exact heading
			// the prompt asks for, or the older shapes OTTR-468 upgraded the regex to catch, so
			// a stored row can never lose the button a legacy row keeps), 'no' when a harvested
			// report carries none; no report (or none harvested this settle) writes nothing.
			const steps =
				report === null || report === undefined
					? undefined
					: recommendsSteps(report)
						? ("yes" as const)
						: ("no" as const);
			const now = Date.now();
			if (unsaved)
				next = {
					stage: kind === "work" ? "in_progress" : "merging",
					state: "needs_you",
					needsReason: keptReason(unsaved),
				};
			// OTTR-708: the cross-project checkout guard. Only a settle that would otherwise
			// complete asks the question: a card already parked or auto-resumed keeps its own
			// reason. A merging-bound settle (ready with commits) with a violation must park
			// before the merge; a steered requeue (state queued, needsReason null) with a
			// violation also parks, and the pending steering text survives the park.
			// Note: when both a dep hold and a violation apply, the violation reason wins
			// the park — that ordering is acceptable.
			if (checkoutGuard && guardBefore !== null && next.needsReason === null) {
				const violation = await checkoutGuardReason(
					projects,
					ops,
					boardPushedHeads,
					name,
					guardBefore,
				);
				if (violation !== null)
					next = {
						stage: "in_progress",
						state: "needs_you",
						needsReason: violation,
					};
			}
			// The settle git reads are slow; a cancel landing inside them owns the card (its kept
			// path already wrote the final state). Finish only the turn row and leave the card
			// alone in that case.
			let commits =
				next.stage === "done"
					? await ops.targetCommits(e.path, target)
					: undefined;
			// Stamped with `commits`: the target head at Done anchors the release's late-commit
			// attribution to this card's merge.
			const mergeHead =
				next.stage === "done"
					? await ops.targetSha(e.path, target).catch(() => null)
					: undefined;
			const keptFiles =
				!releaseCard && next.stage === "done"
					? []
					: unsaved
						? await ops.statusFiles(wt)
						: undefined;
			// U7: an update card on a hold-update-merges project parks for a human approval; the reply
			// approves the parked head (holdHead), and the next ready work turn integrates only while
			// HEAD still equals it: a commit after the approval parks the card again. A ready work
			// settle lands at merging (commits to integrate) or straight done (already integrated).
			// fork-born tasks (analysis proposals AND manual follow-ups of a fork research card) always
			// hold their merge for approval; the parent existing implies the feature ran, so this is
			// independent of the forkResearch toggle. The hold covers every descendant: a card an agent
			// files from a fork-born card (create_task) must not merge without approval either.
			const readyWork =
				kind === "work" && (next.stage === "done" || next.stage === "merging");
			const updateHold =
				readyWork &&
				task.updateIds.length > 0 &&
				store.getSettings().holdUpdateMerges;
			let forkBorn = false;
			const seen = new Set<string>([task.id]);
			let up = task.followUpOf;
			while (up !== null && !seen.has(up) && !forkBorn) {
				seen.add(up);
				const anc = store.getTask(up);
				forkBorn = anc?.topic === "fork research";
				up = anc?.followUpOf ?? null;
			}
			// A read-only retro has nothing to merge; holding it blocks later retros. The
			// forkMergeHold switch gates new holds (OTTR-689): with it off a fork-born card merges
			// like any work card. A card already parked on a fork hold (a parked head, its fork
			// approval not spent) stays held with the switch off, so it still needs an approval
			// at its parked head; only the approving settle lifts that one.
			const forkHold =
				readyWork &&
				forkBorn &&
				!retroCard &&
				(store.getSettings().forkMergeHold ||
					(task.holdHead !== null && task.forkMergeHead === null));
			const head =
				updateHold || forkHold
					? await ops.targetSha(wt, "HEAD").catch(() => null)
					: null;
			// AGEN-24: the approving turn may integrate by itself (a project's AGENTS.md can tell it
			// to merge) and remove the worktree before it reports; the HEAD read then returns null
			// and the hold below parked the approved card again while the work already sat on the
			// target. When the target already contains the head the reply approved, the merge
			// landed: let the settle finish instead of parking again.
			const approvedHead = updateHold
				? task.updateMergeHead
				: forkHold
					? task.forkMergeHead
					: null;
			const holdLanded =
				head === null &&
				approvedHead !== null &&
				(await ops
					.targetContains(e.path, approvedHead, target)
					.catch(() => false));
			// A null head (git failed) never matches: the hold fails closed.
			const holdReason = holdLanded
				? null
				: updateHold && (head === null || task.updateMergeHead !== head)
					? UPDATE_HOLD_REASON
					: forkHold && (head === null || task.forkMergeHead !== head)
						? FORK_HOLD_REASON
						: null;
			if (holdReason !== null) {
				next = {
					stage: "in_progress",
					state: "needs_you",
					needsReason: holdReason,
				};
				holdHead = head;
				commits = undefined; // not done: the approving settle re-measures
			}
			// OTTR-531: sync-commit hygiene findings land on the card before any settle write.
			if (result.outcome) {
				const lines = await syncCommitFindings();
				if (lines.length > 0) {
					const o = result.outcome;
					result = {
						...result,
						outcome: {
							...o,
							details: `${o.details ?? ""}${o.details ? "\n\n" : ""}${lines.join("\n")}`,
						},
					};
				}
			}
			const settled = store.getTask(id);
			if (
				!settled ||
				settled.cancelledAt !== null ||
				(settled.state !== "running" && settled.state !== "preparing")
			) {
				store.finishTurn(turn.id, {
					endedAt: now,
					exitCode: result.exitCode,
					error: "cancelled",
				});
				return;
			}
			// The model the stream served, with the dispatch's thinking level re-attached when the
			// bases match; and the dispatched selector when the run fell back to another model.
			const served = turnModel(result.model, runModel);
			const swap = modelSwap(result.model, runModel);
			if (swap !== null)
				log(
					`! model swap: dispatched ${swap} but the run served ${served}${result.providerError ? ` (${result.providerError})` : ""} — the card keeps ${swap} for its next turn`,
				);
			store.finishTurn(turn.id, {
				endedAt: now,
				exitCode: result.exitCode,
				// live is the turn's own snapshot: the selector this run started with (switches land in-between turns).
				// Without a served model (a crash before message_start) the dispatch snapshot stands.
				model: served ?? turn.model,
				// The fallback proof: the selector the run was dispatched with, kept only when the
				// run served another model's base, so the timeline can name the swap.
				dispatchedModel: swap,
				ranOn: result.ranOn ?? null,
				outcome: result.outcome?.status ?? null,
				summary: result.outcome?.summary ?? null,
				details: result.outcome?.details ?? (result.finalText || null),
				// Only a tool ask marks the turn as a question: a needs_you report's free-text
				// question field is often a hold instruction ("re-run after X"), not a question,
				// so the timeline keeps its alert styling unless the ask tool actually ran.
				question: result.asked?.[0]?.question ?? null,
				error: next.needsReason, // null on success; an automatic continue keeps its reason for the next classify
			});
			// A finished work card gets one second-model check before the merge queue takes it:
			// a fresh, memory-less session with read/grep/glob verifies the ready
			// report against the branch diff and the work transcript, and every blocker must
			// quote one of them. Only a plain work card that classify classified as merging gets
			// here; the check's verdict (or a skipped check) decides the final stored state.
			const workCard =
				kind === "work" &&
				!research &&
				!reviewCard &&
				!releaseCard &&
				!interview &&
				!grill &&
				!scout &&
				!retroCard;
			// A review that parked needs_you still files its findings (OTTR-322): a failed
			// gate must not hide them. A later turn of the same review re-records its
			// findings: skip by prompt text the ones that already have a card linked to it.
			const reviewFindings =
				reviewCard &&
				result.recorded.length > 0 &&
				(next.stage === "merging" || next.state === "needs_you")
					? result.recorded.filter((f) => {
							const linked = store
								.listTasks()
								.some((x) => x.followUpOf === id && x.prompt === f.prompt);
							return !linked;
						})
					: [];
			// A second-model check (review findings, work check) runs below while the card is still
			// in_progress/running: the final stage/state only lands once the check's verdict — or a
			// skipped check — is in, so the schedule tick can neither pick the card for a merge turn
			// nor settle a parked review early.
			const checkWillRun =
				reviewFindings.length > 0 || (workCard && next.stage === "merging");
			store.updateTask(id, {
				...(checkWillRun
					? {}
					: {
							stage: next.stage,
							state: next.state,
							needsReason: next.needsReason,
							queuedAt: next.state === "queued" ? now : task.queuedAt,
							// A usage-limit continue's reset hold; undefined keeps the column.
							// The owner rides with it so the quota refresh can release early.
							...(next.holdUntil !== undefined
								? {
										holdUntil: next.holdUntil,
										holdProvider: next.holdProvider ?? null,
										holdWindow: next.holdWindow ?? null,
									}
								: {}),
						}),
				shots,
				pendingPrompt: next.pendingPrompt, // undefined keeps the column: only classify's automatic continue sets it
				// Authorship rides only when the prompt is actually written; classify's
				// automatic continue is the board's own voice.
				...(next.pendingPrompt !== undefined
					? { pendingBy: next.pendingBy ?? "supervisor" }
					: {}),
				asked: next.asked ?? null, // updateTask stringifies arrays; null clears — cleared whenever the turn did not end on a fresh ask
				summary:
					releaseCard && next.stage === "done"
						? `Released ${task.releaseVersion}`
						: (result.outcome?.summary ?? task.summary),
				details: result.outcome?.details ?? (result.finalText || task.details),
				// The report's own `topic:` line groups the card on the board; null -> undefined keeps the column.
				topic:
					parseTopicReport(
						result.outcome?.details ?? (result.finalText || task.details),
					) ?? undefined,
				commits,
				mergeHead,
				report,
				steps,
				keptFiles,
				holdHead, // every settle rewrites it: only a hold this settle parked keeps a head to approve
				// A merge-hold mismatch park serves the reviewer the exact push-side delta it
				// flagged (undefined keeps the column): the live worktree diff no longer speaks
				// for the push set once the branch is integrated.
				diffFiles: holdFiles ?? undefined,
				diffText: holdDiff ?? undefined,
				// A park spends that hold's approval (undefined keeps the column): a stale approval never
				// carries into a later settle. Only the parked hold's column clears, so an approved
				// update hold survives a fork-hold park of the same card.
				updateMergeHead: holdReason === UPDATE_HOLD_REASON ? null : undefined,
				forkMergeHead: holdReason === FORK_HOLD_REASON ? null : undefined,
			});

			// A retro's proposal is filed as a held card (needs_you, followUpOf this retro):
			// the settle recheck above confirmed the card is still ours, so this write is safe.
			if (retroCard && next.stage === "done" && result.proposed !== null) {
				const openProposals = store
					.listTasks()
					.filter(
						(x) =>
							!x.cancelledAt &&
							x.state === "needs_you" &&
							isRetroProposalReason(x.needsReason) &&
							store.listTurns(x.id).length === 0,
					).length;
				if (openProposals >= 3) {
					log("retro: proposal dropped: cap of 3 open proposals reached");
				} else {
					const child = store.createTask(result.proposed.prompt);
					const handoffPath = join(
						store.tasksDir,
						"handoffs",
						`${child.id}.md`,
					);
					let prompt = followUpPrompt({
						text: result.proposed.prompt,
						title: task.title,
						handoffPath,
					});
					try {
						writeBelow(
							store.dataRoot,
							handoffPath,
							handoffMarkdown({
								task: store.getTask(id) ?? task,
								turns: store.listTurns(id),
								sessionsDir: store.sessionsDir,
							}),
						);
					} catch (err) {
						// The card is still held; it just starts without the handoff pointer.
						prompt = result.proposed.prompt;
						log(`! handoff write failed: ${errmsg(err)}`);
					}
					store.updateTask(child.id, {
						prompt,
						followUpOf: id,
						// A null model means the proposal card runs on the default role.
						model: result.proposed.model,
						state: "needs_you",
						// The reason names the retro's source card once; a missing link falls
						// back to naming the retro itself.
						needsReason: proposedReason(
							(task.followUpOf !== null
								? store.getTask(task.followUpOf)
								: null) ?? { id: task.id },
						),
						// The drawer's decision panel reads it; older proposals keep null.
						proposalSummary: result.proposed.summary,
					});
					log(`- filed proposal ${child.id} (held for approval)`);
				}
			}

			// A review's recorded findings: Ottr caps them, checks the selection with a second model
			// (a fresh session — never --resume, never the review's own — memory off, read/grep/glob
			// only), and files the kept ones as queued cards linked to the review, the flow
			// create_task's per-finding calls did inline before. An approved review holds at merging
			// (FINDINGS_HOLD) and a needs_you review keeps its park: either way the card stays
			// in_progress/running until the deferred write below stores the final state.
			if (reviewFindings.length > 0) {
				const checkOn = ops.reviewCheck?.() ?? true;
				const selected = selectFindings(reviewFindings);
				const selectedSet = new Set(selected);
				const belowCap = reviewFindings.filter((f) => !selectedSet.has(f));
				// First line of a finding, for logs and the card report (the body can be long).
				const head = (f: RecordedFinding): string =>
					f.prompt.split("\n")[0]?.slice(0, 120) ?? "";
				let kept: { id: number; finding: RecordedFinding }[] = selected.map(
					(finding, i) => ({ id: i + 1, finding }),
				);
				let dropped: {
					id: number;
					finding: RecordedFinding;
					reason: string;
				}[] = [];
				let checkMs = 0;
				let checkFailed: string | null = null;
				// The model the check resolves to (the role's selector, else the board's default
				// role — omp's fallback) and why it gives no second-model opinion, for the card.
				let checkModel: string | null = null;
				let checkWarn: "same model" | "same vendor" | null = null;
				if (checkOn) {
					// Input as data: the findings (numbered from 1), the frozen sha, the open cards,
					// and the commits main gained since the review — the one git fact a run without
					// a shell cannot see for itself.
					const [openCards, commitsSince] = await Promise.all([
						Promise.resolve(
							store
								.listTasks()
								.filter(
									(x) =>
										x.id !== id && x.cancelledAt === null && x.stage !== "done",
								)
								.map((x) => ({ id: x.id, title: x.title })),
						),
						task.base !== null && target !== null
							? (ops.commitSubjects ?? commitSubjects)(
									e.path,
									task.base,
									target,
								)
							: Promise.resolve([] as string[]),
					]);
					const roles = (ops.modelRoles ?? modelRoles)();
					const checkRole = checkRoleFor(result.model);
					const selector = roles[checkRole];
					// A missing role falls back to the board's default role (omp's default
					// model), which is often the reviewed model itself — shown on the card.
					checkModel = selector ?? roles.default ?? null;
					checkWarn = checkModelWarning(result.model, checkModel);
					const input = reviewCheckPrompt({
						sha: task.base ?? "",
						findings: selected.map((f, i) => ({
							id: i + 1,
							rank: f.rank,
							security: f.security ?? "",
							prompt: f.prompt,
						})),
						openCards,
						commitsSince,
					});
					// Two attempts, then the user decides: a half-checked review files no cards.
					// A usage limit skips the retry: it fails the same way until the reset.
					let hold: UsageHold | null = null;
					let limitHit = false;
					for (let attempt = 1; attempt <= 2; attempt++) {
						// Hosted: no check attempt starts under a credit stop, the retry included.
						if (creditBlocked()) return;
						const startedAt = Date.now();
						const checkMeter = openMeter(
							selector === undefined ? "default" : checkRole,
						);
						const handle = ops.startRun({
							meter: ops.hosted !== undefined,
							auditProvisioned: (sinceMs, rulesAtStart) =>
								auditProvisioned(homedir(), sinceMs, rulesAtStart),
							rulesAtStart: () => rulesDirEntries(homedir()),
							...(checkMeter !== null && { onUsage: checkMeter.onUsage }),
							cwd: wt,
							prompt: input,
							sessionDir: store.sessionsDir,
							extensionPath: null,
							resumeId: null,
							model: selector,
							tools: "read,grep,glob",
							config: join(dirname(ops.extensionPath), "check.yml"),
							maxTime: "1800",
							dataRoot: store.dataRoot,
							// The check's transcript lands in the review card's log, next to the run it checks.
							logPath: store.logPath(id),
							onLog: () => ops.notifyLog(name, id),
						});
						// The check holds a board slot like any run: it sits in the loop's live map,
						// so the global cap sees it until it ends.
						const checkKey = `${key}:check`;
						running.set(checkKey, handle);
						const checkResult = (await handle.done) as RunResult;
						checkMeter?.settle(checkResult);
						// sweepLostTurns settled a lost check: its outcome owns the card now.
						if (running.get(checkKey) !== handle) {
							checkTakenOver = true;
							return;
						}
						running.delete(checkKey);
						// A creditStop killed this check: park with the credit reason, no retry.
						if (creditBlocked()) return;
						checkMs += Date.now() - startedAt;
						const err = checkRunError(checkResult);
						if (err === null) {
							const verdicts = parseCheckVerdicts(checkResult.finalText);
							if (verdicts !== null) {
								const split = applyCheckVerdicts(selected, verdicts);
								kept = split.kept;
								dropped = split.dropped;
								checkFailed = null; // the retry succeeded
								break;
							}
							checkFailed = "the check verdict was not valid JSON";
						} else {
							checkFailed = err;
							limitHit = hitUsageLimit(checkResult);
						}
						log(`! review check attempt ${attempt} failed: ${checkFailed}`);
						if (limitHit) {
							hold = await usageHold(checkResult.model ?? selector ?? null);
							break;
						}
					}
					if (checkFailed !== null) {
						const cur = store.getTask(id);
						if (hold !== null) {
							log(
								`- review check held until ${new Date(hold.holdUntil).toISOString()}: usage limit`,
							);
							const patch = holdPatch(store, id, hold);
							if (patch !== null) store.updateTask(id, patch);
						} else {
							log(`- review check gave up after a retry: ${checkFailed}`);
							if (cur !== null && cur.cancelledAt === null)
								store.updateTask(id, {
									stage: "in_progress",
									state: "needs_you",
									needsReason: `The review check failed${limitHit ? "" : " twice"}: ${checkFailed}. Reply to re-run the review, or cancel the card.`,
								});
						}
					} else
						for (const d of dropped)
							log(`- dropped finding ${d.id}: ${d.reason}`);
				} else {
					for (const f of belowCap)
						log(`- finding below the cap of 10, not filed: ${head(f)}`);
				}
				// File the kept findings as queued cards linked to the review, like create_task did.
				const filed: string[] = [];
				const live = store.getTask(id);
				if (checkFailed === null && live !== null && live.cancelledAt === null)
					for (const k of kept) {
						const child = store.createTask(k.finding.prompt);
						store.updateTask(child.id, {
							followUpOf: id,
							// A null model means the finding card runs on the default role.
							model: k.finding.model,
						});
						filed.push(child.id);
					}
				log(
					`- review findings: ${reviewFindings.length} recorded, ${filed.length} filed, ${
						belowCap.length + dropped.length
					} not filed${checkOn ? `, check ${(checkMs / 1000).toFixed(0)}s` : ", check off"}`,
				);
				// The counts and every unfiled finding with its reason live on the review card: the
				// user can file any of them by hand.
				const cur = store.getTask(id);
				if (checkFailed === null && cur !== null && cur.cancelledAt === null) {
					const notFiled = [
						...belowCap.map((f) => `- below the cap of 10: ${head(f)}`),
						...dropped.map(
							(d) => `- dropped: ${head(d.finding)} — ${d.reason}`,
						),
					];
					store.updateTask(id, {
						summary: `${cur.summary ?? "Review finished"}\nFindings: ${reviewFindings.length} recorded, ${filed.length} filed, ${notFiled.length} not filed${checkOn ? ` (check ${(checkMs / 1000).toFixed(0)}s on ${checkModel ?? "default model"}${checkWarn === null ? "" : ` — ${checkWarn} as the review`})` : ""}.`,
						details: `${cur.details ?? ""}\n\n## Findings\n${
							filed.length > 0
								? filed.map((cid) => `- filed as card #${cid}`).join("\n")
								: "- none filed"
						}\n${notFiled.join("\n")}`,
					});
				}
			}

			if (workCard && next.stage === "merging") {
				const checkOn = ops.workCheck?.() ?? true;
				const head = await ops.targetSha(wt, "HEAD").catch(() => null);
				const cur = store.getTask(id);
				if (checkOn && cur !== null && cur.cancelledAt === null) {
					const priorLog = cur.workCheckLog;
					const open = openWorkBlockers(priorLog);
					const seen = head !== null && cur.workCheckHead === head;
					// Human messages since the last check started (a reply approving a hard stop,
					// or steering): they re-open the check at an unchanged head. The tracker's own
					// send-back texts are not human input. ponytail: only the send-back prefix is
					// filtered; a tracker prompt from another flow (rare here) would cost one
					// extra check run, not a wrong verdict.
					const lastCheckAt =
						priorLog.length > 0 ? priorLog[priorLog.length - 1]!.at : 0;
					const replies = store
						.listTurns(id)
						.filter(
							(t) =>
								t.input !== null &&
								t.startedAt > lastCheckAt &&
								!t.input.startsWith(WORK_CHECK_SENDBACK_OPENING),
						)
						.map((t) => t.input as string);
					// The ready report of the run being checked: the outcome's summary and
					// details, else the run's final message. The first completed check stamps
					// it on the card as the original result every later re-check gets.
					const readyReport = readyReportText(result.outcome, result.finalText);
					// Send the blockers back to the work agent, or ask the user once the cap is
					// spent: only a fresh verdict reaches this, and a send-back counts as an
					// attempt against the same WORK_CHECK_MAX_SENDBACKS cap.
					const sendBack = (
						blockers: WorkCheckBlocker[],
						runs: WorkCheckRun[],
					) => {
						const sendbacks = cur.workCheckSendbacks;
						const reportStamp =
							cur.workCheckReport === null
								? { workCheckReport: readyReport }
								: {};
						// A block after the cap asks the user: the reply route turns a click into the
						// send-back or the merge (no board check skill needed to unstick it).
						if (sendbacks >= WORK_CHECK_MAX_SENDBACKS)
							store.updateTask(id, {
								stage: "in_progress",
								state: "needs_you",
								needsReason: `${WORK_CHECK_ASK_BLOCK}: ${blockers
									.map((b, i) => `${i + 1}. ${b.finding}`)
									.join(
										" ",
									)}. Reply to send it back anyway, run Merge anyway, or cancel the card.`,
								asked: workCheckAsk(blockers),
								workCheckLog: runs,
								workCheckHead: head,
								...reportStamp,
							});
						else {
							store.updateTask(id, {
								stage: "in_progress",
								state: "queued",
								queuedAt: Date.now(),
								pendingPrompt: workCheckSendBack({
									blockers,
									attempt: sendbacks + 1,
									max: WORK_CHECK_MAX_SENDBACKS,
								}),
								pendingBy: "supervisor",
								needsReason: null,
								workCheckLog: runs,
								workCheckHead: head,
								workCheckSendbacks: sendbacks + 1,
								...reportStamp,
							});
							log(
								`- work check: sent back to the work agent (${sendbacks + 1} of ${WORK_CHECK_MAX_SENDBACKS})`,
							);
						}
					};
					// Every ready report after a send-back gets a fresh check, even at an
					// unchanged head with no new report text: the update may be new evidence
					// (a run the transcript now shows) or a corrected claim, and only a fresh
					// session judges it. A re-ready after a passing check at an unchanged head
					// starts nothing: the last check passed and nothing changed.
					if (!seen || open.length > 0) {
						const checkBase = task.base ?? target ?? "HEAD";
						// A re-check sees only the commits since the head the last completed
						// check stamped — empty at an unchanged head, where only the report
						// moved. The checked code was already reviewed once, and repeat checks
						// mostly re-flag old code; the full branch diff is still read below for
						// quote grounding, so a re-cited blocker's quote stays verbatim there.
						const checkFrom =
							head !== null && cur.workCheckHead !== null
								? cur.workCheckHead
								: checkBase;
						const sincePreviousCheck = checkFrom !== checkBase;
						const diff =
							(await ops.diffText(wt, checkBase, "HEAD").catch(() => null)) ??
							"";
						const checkDiff = sincePreviousCheck
							? ((await ops
									.diffText(wt, checkFrom, "HEAD")
									.catch(() => null)) ?? diff)
							: diff;
						const transcriptPath =
							sessionFile(store.sessionsDir, result.sessionId) ?? "";
						let transcriptText = "";
						try {
							transcriptText = readRegular(transcriptPath).toString("utf8");
						} catch {
							// No transcript file on disk: the check works from the diff alone.
						}
						const roles = (ops.modelRoles ?? modelRoles)();
						const checkRole = checkRoleFor(result.model);
						const selector = roles[checkRole];
						// The check must not be the model it checks: a missing role falls back
						// to the board's default role (omp's default model), often the work
						// model itself. Same model or vendor goes on the card as a warning.
						const checkModel = selector ?? roles.default ?? null;
						const checkWarn = checkModelWarning(result.model, checkModel);
						const warn =
							checkWarn === null
								? {}
								: {
										warn:
											checkWarn === "same model"
												? `The check model ${checkModel} is the same model as the run it checks — no second-model opinion.`
												: `The check model ${checkModel} is from the same vendor as the run it checks — no second-vendor opinion.`,
									};
						const input = workCheckPrompt({
							title: task.title,
							prompt: task.prompt,
							base: checkBase,
							head: head ?? "HEAD",
							diff: checkDiff,
							sincePreviousCheck,
							report: readyReport,
							originalReport: cur.workCheckReport ?? undefined,
							transcriptPath,
							earlier: open.map((b, i) => ({
								id: i + 1,
								finding: b.finding,
								quote: b.quote,
							})),
							replies,
						});
						const checkStart = Date.now();
						let checkMs = 0;
						let checkFailed: string | null = null;
						let split: {
							blockers: WorkCheckBlocker[];
							notes: string[];
						} | null = null;
						// Two attempts, then the user decides: an unchecked card never merges.
						// A usage limit skips the retry: it fails the same way until the reset.
						let hold: UsageHold | null = null;
						let limitHit = false;
						for (let attempt = 1; attempt <= 2; attempt++) {
							// Hosted: no check attempt starts under a credit stop, the retry included.
							if (creditBlocked()) return;
							const startedAt = Date.now();
							const checkMeter = openMeter(
								selector === undefined ? "default" : checkRole,
							);
							const handle = ops.startRun({
								meter: ops.hosted !== undefined,
								auditProvisioned: (sinceMs, rulesAtStart) =>
									auditProvisioned(homedir(), sinceMs, rulesAtStart),
								rulesAtStart: () => rulesDirEntries(homedir()),
								...(checkMeter !== null && { onUsage: checkMeter.onUsage }),
								cwd: wt,
								prompt: input,
								sessionDir: store.sessionsDir,
								extensionPath: null,
								resumeId: null,
								model: selector,
								tools: "read,grep,glob",
								config: join(dirname(ops.extensionPath), "check.yml"),
								maxTime: "1800",
								dataRoot: store.dataRoot,
								// The check's transcript lands in the card's log, next to the run it checks.
								logPath: store.logPath(id),
								onLog: () => ops.notifyLog(name, id),
							});
							// The check holds a board slot like any run: it sits in the loop's live map,
							// so the global cap sees it until it ends.
							const checkKey = `${key}:workcheck`;
							running.set(checkKey, handle);
							const checkResult = (await handle.done) as RunResult;
							checkMeter?.settle(checkResult);
							// sweepLostTurns settled a lost check: its outcome owns the card now.
							if (running.get(checkKey) !== handle) {
								checkTakenOver = true;
								return;
							}
							running.delete(checkKey);
							// A creditStop killed this check: park with the credit reason, no retry.
							if (creditBlocked()) return;
							checkMs += Date.now() - startedAt;
							const err = checkRunError(checkResult);
							if (err === null) {
								const verdict = parseWorkCheck(checkResult.finalText);
								if (verdict !== null) {
									split = demoteUnquoted(
										verdict,
										diff,
										readyReport,
										transcriptText,
									);
									checkFailed = null; // the retry succeeded
									// Earlier blockers resolve three ways: the verdict's fixed list
									// (by the prompt's 1-based id) wins; a blocker whose exact quote
									// the new blockers re-cite stays open; anything else counts as
									// fixed because the re-check dropped it. Copies, never in place.
									const fixedById = new Map(
										verdict.fixed.map((f) => [f.id, f.reason]),
									);
									const requoted = new Set(split.blockers.map((b) => b.quote));
									const runs = [...priorLog];
									const lastIdx = runs.findLastIndex(
										(r) => r.outcome === "blockers",
									);
									if (lastIdx >= 0) {
										const prev = runs[lastIdx]!;
										runs[lastIdx] = {
											...prev,
											blockers: prev.blockers.map((b) => {
												const oi = open.indexOf(b);
												if (oi === -1) return b;
												const reason = fixedById.get(oi + 1);
												if (reason !== undefined)
													return {
														...b,
														status: "fixed" as const,
														statusReason: reason,
													};
												if (requoted.has(b.quote)) return b;
												return {
													...b,
													status: "fixed" as const,
													statusReason: "not re-cited by the re-check",
												};
											}),
										};
									}
									const run: WorkCheckRun = {
										at: checkStart,
										// The resolved model, not just the role selector: with the role
										// missing, the card must name the default role it fell back to.
										model: checkModel,
										outcome: split.blockers.length === 0 ? "pass" : "blockers",
										blockers: split.blockers,
										notes: split.notes,
										durationMs: checkMs,
										...warn,
									};
									const allRuns = [...runs, run].slice(-20);
									log(
										`- work check: ${split.blockers.length} blocker(s), ${split.notes.length} note(s), ${(checkMs / 1000).toFixed(0)}s`,
									);
									if (split.blockers.length === 0)
										// Pass: the card stays in its current state; the deferred write
										// below stores merging/queued with the check record stamped.
										store.updateTask(id, {
											workCheckLog: allRuns,
											workCheckHead: head,
											workCheckSendbacks: cur.workCheckSendbacks,
											...(cur.workCheckReport === null
												? { workCheckReport: readyReport }
												: {}),
										});
									else sendBack(split.blockers, allRuns);
									break;
								}
								checkFailed = "the work check verdict was not valid JSON";
							} else {
								checkFailed = err;
								limitHit = hitUsageLimit(checkResult);
							}
							log(`! work check attempt ${attempt} failed: ${checkFailed}`);
							if (limitHit) {
								hold = await usageHold(checkResult.model ?? selector ?? null);
								break;
							}
						}
						if (checkFailed !== null) {
							// No head stamp: the next ready at this head must run the check again.
							log(
								hold !== null
									? `- work check held until ${new Date(hold.holdUntil).toISOString()}: usage limit`
									: `- work check failed: ${checkFailed}`,
							);
							const patch = hold === null ? null : holdPatch(store, id, hold);
							store.updateTask(id, {
								...(hold === null
									? {
											stage: "in_progress" as const,
											state: "needs_you" as const,
											needsReason: `The work check failed${limitHit ? "" : " twice"}: ${checkFailed}. Reply to re-run it, or cancel the card.`,
										}
									: patch),
								workCheckLog: [
									...priorLog,
									{
										at: checkStart,
										model: checkModel,
										outcome: "error",
										blockers: [],
										notes: [],
										durationMs: checkMs,
										...warn,
										error: checkFailed,
									},
								],
							});
						}
					}
					// seen with no open blockers: this head already passed a check; the deferred
					// write below stores merging/queued.
				}
			}

			// A check block above ran while the card was still in_progress/running: store the final
			// state now, if the card is still ours. The overrides the checks wrote (send-back,
			// needs_you, a failed check) moved the state away from running; this write must not
			// clobber them, so it fires only on the still-running card.
			if (checkWillRun) {
				const afterCheck = store.getTask(id);
				if (
					afterCheck &&
					afterCheck.cancelledAt === null &&
					(afterCheck.state === "running" || afterCheck.state === "preparing")
				)
					store.updateTask(id, {
						stage: next.stage,
						state: next.state,
						needsReason: next.needsReason,
						queuedAt: next.state === "queued" ? Date.now() : undefined,
					});
			}

			if (next.stage === "done") {
				// Stamp the version the merge released so state rows can show it without their turns —
				// but only when a real tag of that name points at the pushed head: a version string in
				// report prose (a quoted commit message, release notes) must not mint a release pill.
				if (!releaseCard && kind === "merge") {
					const last = store.listTurns(id).at(-1);
					const version =
						last?.outcome === "integrated"
							? parseReleaseVersion(
									`${last.summary ?? ""}\n${last.details ?? ""}`,
								)
							: null;
					// CI watch: pin the pushed sha only when origin's remote-tracking tip equals the local target
					// tip — a merge turn that skipped its push would otherwise pin an older run to this card.
					// ponytail: two merges landing between push and capture pin the newer run to both cards.
					const short = target.replace(/^origin\//, "");
					const [local, pushed] = await Promise.all([
						ops.targetSha(e.path, target).catch(() => null),
						ops
							.targetSha(e.path, `refs/remotes/origin/${short}`)
							.catch(() => null),
					]);
					const onOrigin = local !== null && local === pushed;
					const tagged =
						version !== null && onOrigin
							? await ops
									.targetSha(e.path, `refs/tags/${version}`)
									.catch(() => null)
							: null;
					if (version !== null) {
						if (onOrigin && tagged === pushed)
							store.updateTask(id, { releaseVersion: version });
						else
							log(
								`- no release stamp for ${version}: no tag on the pushed head`,
							);
					}
					if (onOrigin) store.updateTask(id, { pushSha: pushed });
					else log("- CI watch skipped: merge push not on origin");
				}
				// An interview, grill or trending scout card runs in the main checkout: its wt must
				// never be removed.
				if (!interview && !grill && !scout) {
					// The done drawer keeps naming what the run left uncommitted after the
					// worktree is gone: capture the list before removeWorktree deletes it.
					// statusFiles never rejects (an unreadable tree reads as []).
					store.updateTask(id, { uncommittedFiles: await ops.statusFiles(wt) });
					try {
						await ops.removeWorktree({
							mainPath: e.path,
							worktreePath: wt,
							branch,
						});
						log("- worktree removed");
					} catch (err) {
						log(`! removeWorktree: ${errmsg(err)}`);
					}
				}
			}
		} catch (err) {
			const msg = errmsg(err);
			try {
				log(`! ${msg}`);
			} catch {
				// logging must not mask the error path
			}
			if (turn) store.finishTurn(turn.id, { endedAt: Date.now(), error: msg });
			store.updateTask(id, {
				state: "needs_you",
				needsReason: `Tracker error: ${msg}`,
			});
			// The turn died in the tracker: no VM of this card may keep pushing on its token
			// (startRun revokes its own token when its run settles; this covers a throw in
			// between).
			ops.vmTokens?.revokeTask(name, id);
		} finally {
			// The sweep may have replaced this entry: only drop the map slot this run still owns.
			if (entry && running.get(key) === entry) running.delete(key);
			// A stop that raced a natural finish leaves no mark behind.
			stopping.delete(key);
			// An abandoned run's claim was already deleted by the sweep and may belong to the
			// resumed replacement now; deleting it here would free the replacement's cap slot.
			// A taken-over check is the same case: the sweep deleted this run's claim.
			if (!entry?.abandoned && !checkTakenOver) {
				preparing.delete(key);
				creditStopped.delete(key);
			}
			publishing.delete(key);
			// Settle is done: report each run's usage, also of a stopped or failed run. No interim
			// record goes out after this point, also for a run whose result never came.
			for (const interim of interims) interim.close();
			if (ops.hosted !== undefined && turn !== null) {
				// M10: the outcome is the state the board shows after this settle. A parked card
				// (credit stop, Esc stop, tracker error, check blockers) reads needs_you even when
				// the run reported none, and the reverse holds: a card the settle requeues (a
				// dependency hold, steering, a queued rebase retry) waits on the board's queue, so
				// its needs_you row outcome ships as "queued" — the control plane would otherwise
				// email the owner about a card nobody must act on. Every other settle keeps the
				// settled turn row's outcome (ready, answered, integrated). A value outside
				// /^[a-z_]{1,40}$/ (null included) sends nothing. The title is the card prompt's
				// first line, trimmed and cut to 200 characters; an empty line sends nothing.
				const settledTask = store.getTask(id);
				const row = store.listTurns(id).at(-1)?.outcome ?? null;
				const rowOutcome =
					row !== null && /^[a-z_]{1,40}$/.test(row) ? row : null;
				let outcome: string | null = rowOutcome;
				if (settledTask?.state === "needs_you") outcome = "needs_you";
				else if (settledTask?.state === "queued" && rowOutcome === "needs_you")
					outcome = "queued";
				const firstLine = task.prompt.split("\n")[0]?.trim() ?? "";
				const title = firstLine === "" ? null : firstLine.slice(0, 200);
				for (const entry of metered) {
					const { main, ...r } = entry;
					sendMetering(ops.hosted, {
						project: name,
						taskId: id,
						turnId: turn.id,
						kind,
						...r,
						final: true,
						...(main === true && outcome !== null ? { outcome } : {}),
						...(main === true && title !== null ? { title } : {}),
					});
				}
			}
			schedule();
		}
	}

	/** Stops the running turn without cancelling the task (the board's Esc): kills the agent
	 * process, keeps the worktree, branch and session, and leaves the settle to runTurn, which
	 * parks the card at needs_you with `reason`. Never removes anything. */
	async function stopTurn(
		e: TurnProject,
		id: string,
		reason: string = TURN_STOPPED_REASON,
	): Promise<StopOutcome> {
		const store = e.store;
		const task = store.getTask(id);
		if (task === null) return { error: "unknown task", status: 404 };
		if (task.cancelledAt !== null)
			return { error: "task is cancelled", status: 409 };
		const handle = running.get(`${store.name}/${id}`);
		// OTTR-454: a re-bound detached run has no local handle, so Esc kills it on its worker
		// and settles the row here — the same stopped park a live kill gets from runTurn.
		const watch = detached.get(`${store.name}/${id}`);
		if (!handle && !watch) return { error: "no turn is running", status: 409 };
		if (watch) {
			detached.delete(`${store.name}/${id}`);
			try {
				// ponytail: a watcher exists only because workerTarget answered at recovery,
				// so the optional chain on the token cannot see null here.
				await ops.killDetached?.(
					watch.url,
					runnerToken(watch.url),
					watch.runId,
				);
			} catch (err) {
				appendLog(store, id, `! stop killDetached: ${errmsg(err)}`);
			}
			const turn = store.listTurns(id).at(-1);
			if (turn && turn.endedAt === null)
				store.finishTurn(turn.id, {
					endedAt: Date.now(),
					exitCode: null,
					error: "stopped",
				});
			store.updateTask(id, {
				state: "needs_you",
				needsReason: reason,
			});
			return { ok: true };
		}
		// A watcher row returned above, so handle is set here; the guard keeps TS exact.
		if (!handle) return { error: "no turn is running", status: 409 };
		stopping.set(`${store.name}/${id}`, reason);
		await handle.kill();
		await Promise.race([
			handle.done.then(() => undefined),
			new Promise<void>((r) => setTimeout(r, 15_000)),
		]);
		return { ok: true };
	}

	/** Hosted mode (docs/specs/hosted-mode.md section 5): the control plane's mid-turn stop at
	 * zero credit. It sets the credit hold, then stops in parallel every work or merge run
	 * (stopTurn), every running work or review check, and marks every turn in its prepare or
	 * settle awaits. Each card parks with the credit reason. Resolves to the number stopped. */
	async function creditStop(): Promise<number> {
		const reason =
			ops.hosted?.config.wording.creditReason ?? DEFAULT_CREDIT_REASON;
		// Before any await: from here on, no turn dispatches a model until a fresh gate answer.
		creditHold = true;
		creditStops += 1;
		const stops: Promise<boolean>[] = [];
		for (const e of projects.values()) {
			try {
				for (const t of e.store.listTasks()) {
					const stop = creditStopTurn(e, t.id, reason);
					if (stop !== null) stops.push(stop);
				}
			} catch (err) {
				// One sick store must not keep the other projects' turns running.
				logStoreError(e.store.name, err);
			}
		}
		const outs = await Promise.all(stops);
		return outs.filter(Boolean).length;
	}

	/** creditStop for one card: null when the card has no turn in flight, else resolves true
	 * when the turn stopped. Every stopped turn gets the creditStopped mark. */
	function creditStopTurn(
		e: TurnProject,
		id: string,
		reason: string,
	): Promise<boolean> | null {
		const key = `${e.store.name}/${id}`;
		if (running.has(key) || detached.has(key)) {
			// The mark also covers a kill that raced a natural finish: no check follows.
			creditStopped.add(key);
			return stopTurn(e, id, reason).then((o) => "ok" in o);
		}
		const check =
			running.get(`${key}:check`) ?? running.get(`${key}:workcheck`);
		if (check !== undefined) {
			// stopTurn sees only the unsuffixed key. The mark makes the killed check park the
			// card with the credit reason instead of its second attempt.
			creditStopped.add(key);
			return (async () => {
				await check.kill();
				await Promise.race([
					check.done.then(() => undefined),
					new Promise<void>((r) => setTimeout(r, 15_000)),
				]);
				return true;
			})();
		}
		// No run yet (title, git, packages) or between the run and its check: the turn parks at
		// its next model dispatch point. A release publish (`settling`) starts no model.
		if (!preparing.has(key) || settling.has(key)) return null;
		creditStopped.add(key);
		return Promise.resolve(true);
	}

	/** Hosted mode (docs/specs/hosted-mode.md section 5): the control plane's release after a
	 * top-up. It clears the credit hold, as a fresh true gate answer does, and changes no other
	 * stop state. Then it queues every needs_you card that the credit stop or the credit gate
	 * parked (its reason is the credit reason) like an owner Resume ("."): a stopped card resumes
	 * its session on the kept worktree. Each queued turn still passes the credit gate. Resolves
	 * to the number queued; a second call finds no parked card. */
	async function creditRelease(): Promise<number> {
		if (ops.hosted === undefined) return 0;
		const reason = ops.hosted.config.wording.creditReason;
		creditHold = false;
		creditReleases += 1;
		let released = 0;
		for (const e of projects.values()) {
			try {
				for (const t of e.store.listTasks()) {
					if (
						t.state !== "needs_you" ||
						t.cancelledAt !== null ||
						t.needsReason !== reason
					)
						continue;
					// Nobody typed the release's ".": a queued steer keeps its own author.
					e.store.updateTask(t.id, replyPatch(t, ".", [], "supervisor"));
					released += 1;
				}
			} catch (err) {
				// One sick store must not keep the other projects' cards parked.
				logStoreError(e.store.name, err);
			}
		}
		if (released > 0) ops.publishSoon();
		schedule();
		return released;
	}

	/**
	 * Stops the task and deletes its worktree and branch. Unless forced, work they hold that isn't on the
	 * target is kept and the card asks you instead; returns what was kept.
	 */
	async function cancel(
		e: TurnProject,
		id: string,
		force: boolean,
	): Promise<CancelOutcome> {
		const store = e.store;
		// The tag and push cannot be taken back: a cancel must not claim a card it cannot stop.
		if (publishing.has(`${store.name}/${id}`))
			return { error: "release already publishing", status: 409 };
		store.updateTask(id, { cancelledAt: Date.now() });
		// OTTR-454: a re-bound detached run has no local handle; the worker kills it, and the
		// flow below settles the card like any cancel without a live run.
		const watch = detached.get(`${store.name}/${id}`);
		if (watch) {
			detached.delete(`${store.name}/${id}`);
			try {
				// ponytail: a watcher exists only because workerTarget answered at recovery,
				// so the optional chain on the token cannot see null here.
				await ops.killDetached?.(
					watch.url,
					runnerToken(watch.url),
					watch.runId,
				);
			} catch (err) {
				appendLog(store, id, `! cancel killDetached: ${errmsg(err)}`);
			}
		}
		const handle = running.get(`${store.name}/${id}`);
		if (handle) {
			await handle.kill();
			await Promise.race([
				handle.done.then(() => undefined),
				new Promise<void>((r) => setTimeout(r, 15_000)),
			]);
		}
		const task = store.getTask(id);
		if (task?.worktree) {
			let unsaved: string | null = null;
			// OTTR-347: a husk holds no checkout, but its branch can still hold commits the
			// target never got. Such a cancel keeps the branch instead of deleting it.
			let keepBranch = false;
			// A Done task passed the delete check when its worktree was removed; only its record is left.
			// A release card's worktree is disposable: cancel it like a forced cancel.
			if (!force && task.stage !== "done" && task.releaseVersion === null) {
				const into = e.target ?? task.base;
				if (await ops.worktreeHusk(task.worktree)) {
					// Fail closed: with no target to prove against, the branch stays.
					keepBranch =
						task.branch !== null &&
						!(
							into && (await ops.branchMergedOrGone(e.path, task.branch, into))
						);
				} else {
					unsaved = into
						? await ops.unsavedWork(task.worktree, into)
						: "its base commit is unknown";
				}
			}
			if (unsaved) {
				appendLog(store, id, `! cancel kept the worktree: ${unsaved}`);
				store.updateTask(id, {
					cancelledAt: null,
					state: "needs_you",
					// Its own prefix (R5-2): the supervisor's auto-tend matches "Kept the
					// worktree: " and must not answer a card the user just cancelled; the
					// kept counts and finish-kept still cover it via isKeptReason.
					needsReason: cancelKeptReason(unsaved),
					keptFiles: await ops.statusFiles(task.worktree),
				});
				return { kept: unsaved };
			}
			try {
				await ops.removeWorktree({
					mainPath: e.path,
					worktreePath: task.worktree,
					branch: keepBranch ? null : task.branch,
				});
			} catch (err) {
				appendLog(store, id, `! cancel removeWorktree: ${errmsg(err)}`);
			}
			if (keepBranch && task.branch)
				appendLog(
					store,
					id,
					`! cancel kept the branch ${task.branch}: it holds commits that never reached ${e.target ?? task.base}`,
				);
		}
		store.updateTask(id, { state: "idle" });
		return { removed: true };
	}

	/** Resolves a kept-worktree card: applies move/ignore/delete choices, then removes the worktree. */
	async function finishKept(
		e: TurnProject,
		id: string,
		choices: unknown,
	): Promise<FinishKeptOutcome> {
		const store = e.store;
		const task = store.getTask(id);
		if (task === null) return { error: "unknown task", status: 404 };
		if (
			task.state !== "needs_you" ||
			(task.stage !== "merging" && task.stage !== "in_progress") ||
			!isKeptReason(task.needsReason)
		) {
			return { error: "task is not kept on a worktree", status: 409 };
		}
		if (running.has(`${store.name}/${id}`))
			return { error: "a turn is running", status: 409 };
		const target = e.target ?? task.base;
		if (target === null) return { error: "no integration target", status: 409 };
		// A husk (unlinked, holds no checkout) cannot speak for HEAD: dispose it when nothing
		// recoverable is left (branch gone or merged); otherwise the branch names the blocker.
		const wt = task.worktree;
		const husk = wt === null || (await ops.worktreeHusk(wt));
		if (husk) {
			if (task.branch === null)
				return {
					error: "worktree is missing and no branch to check",
					status: 409,
				};
			if (!(await ops.branchMergedOrGone(e.path, task.branch, target)))
				return {
					error: `branch ${task.branch} has commits that never reached ${target}`,
					status: 409,
				};
		} else if (!(await ops.isIntegrated(wt, target).catch(() => false))) {
			return { error: `HEAD is not integrated into ${target}`, status: 409 };
		}
		const parsed = parseKeptChoices(choices, task.keptFiles);
		if ("error" in parsed) return { error: parsed.error, status: 400 };
		const planned = planKeptFinish(task.keptFiles, parsed.choices, (rel) =>
			existsSync(join(e.path, rel)),
		);
		if ("conflict" in planned)
			return {
				error: `file already exists in the main checkout: ${planned.conflict}`,
				status: 409,
			};
		for (const rel of planned.moves) {
			if (wt === null || !existsSync(join(wt, rel)))
				return { error: `file missing in the worktree: ${rel}`, status: 409 };
			try {
				copyBelow(
					{ anchor: worktreeAnchor(e.path, wt), file: join(wt, rel) },
					{ anchor: trustedAnchor(e.path), file: join(e.path, rel) },
					wt,
				);
			} catch (err) {
				return { error: `cannot move ${rel}: ${errmsg(err)}`, status: 409 };
			}
		}
		for (const rel of planned.ignores) await ops.ignoreInMain(e.path, rel);
		appendLog(
			store,
			id,
			`- finished kept worktree: ${planned.moves.length} moved, ${planned.ignores.length} ignored, ${planned.deletes.length} deleted`,
		);
		try {
			if (wt !== null)
				await ops.removeWorktree({
					mainPath: e.path,
					worktreePath: wt,
					branch: task.branch,
				});
		} catch (err) {
			appendLog(store, id, `! removeWorktree: ${errmsg(err)}`);
		}
		store.updateTask(id, {
			stage: "done",
			state: "idle",
			needsReason: null,
			// The kept list is this run's uncommitted files: the done drawer keeps
			// naming them now that the worktree they lived in is gone.
			uncommittedFiles: task.keptFiles,
			keptFiles: [],
			commits: await ops.targetCommits(e.path, target),
			mergeHead: await ops.targetSha(e.path, target).catch(() => null),
		});
		return { ok: true };
	}

	/** OTTR-454: live runs per runner for GET /api/drain. A worker turn's entry carries the
	 * dispatched worker's url; a local run (merge, retro, board check, local spawn) has none. */
	function runnerTurns(): {
		local: number;
		workers: Record<string, number>;
		preparing: number;
	} {
		const workers: Record<string, number> = {};
		let local = 0;
		for (const entry of running.values()) {
			if (entry.url === undefined) local++;
			else {
				const host = new URL(entry.url).hostname;
				workers[host] = (workers[host] ?? 0) + 1;
			}
		}
		return { local, workers, preparing: preparing.size };
	}

	return {
		schedule,
		runTurn,
		cancel,
		stopTurn,
		creditStop,
		creditRelease,
		finishKept,
		recoverRestarted,
		running,
		runnerTurns,
	};
}
