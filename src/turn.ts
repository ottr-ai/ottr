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
import { githubHost } from "./githubHost.ts";
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
import { modelList, modelRoles } from "./models.ts";
import type { GateCheck } from "./promptGate.ts";
import {
	GATE_REASON,
	gateAskQuestions,
	gateCompareText,
	gateFingerprint,
	gateUserText,
	hasOpenQuestionsSection,
	missingCheckQuestion,
	openQuestionsLines,
	promptGateCheck,
	startAnywayQuestion,
} from "./promptGate.ts";
import {
	DEEPEN_POINTS,
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
import type { commentOnPullRequest, openPullRequest } from "./prs.ts";
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
import type { DepProject, WorkCheckVerdict } from "./scheduler.ts";
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
	repeatedBugClasses,
	reviewFindings,
	selectFindings,
	UNCHECKED_FINDINGS_HOLD,
	WORK_CHECK_ASK_BLOCK,
	workCheckAsk,
	workCheckBlockerCounts,
	workCheckCountsDiverged,
	workCheckDivergeAsk,
	workCheckDiverged,
	workCheckDivergeReason,
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
	AskQuestion,
	DiffFileStat,
	GitFacts,
	LatestImage,
	ListedTask,
	Next,
	OpenPrsView,
	Outcome,
	ProjectSettings,
	PromptGateState,
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
import type { DetachedRun, VmOutcome } from "./workers.ts";

import type {
	ArchReviewDelta,
	branchMergedOrGone,
	branchUnpushed,
	changedFiles,
	checkedOutBranch,
	checkoutState,
	commitsAhead,
	createWorktree,
	deleteRemoteBranch,
	diffStat,
	diffText,
	fetchOriginBranch,
	fetchPrHead,
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
	treesEqual,
	unsavedWork,
	worktreeHusk,
	worktreeLinked,
} from "./worktree.ts";
import {
	commitMeta,
	commitSubjects,
	PUSH_LANDED_BEFORE_ATTEMPT,
	parseKeptChoices,
	planKeptFinish,
	type quarantineUntracked,
	slugify,
	targetTracksRules,
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

/** OTTR-763: one commit the guard saw land in another project's main checkout. */
type GuardCommit = {
	sha: string;
	subject: string;
	/** Committer time (ms); the fact that attributes the commit to a turn window. */
	time: number;
	/** Repo-relative files the commit touched. */
	files: string[];
};

/** OTTR-763: one change another project's main checkout shows against its before
 * snapshot. Null: nothing to report — nothing changed, or a HEAD advance the board's
 * own merge machinery recorded. */
type GuardChange = {
	/** The new commits with their metadata; empty when only the tree changed. */
	commits: GuardCommit[];
	/** The status-diff files (modified or untracked), repo-relative. */
	files: string[];
	/** The needs_you display parts, worded exactly as before OTTR-763. */
	parts: string[];
};

/** OTTR-763: one bell notice for a change whose blame is ambiguous. No card parks. */
type GuardNotice = { at: number; text: string };

/** OTTR-763: how long a bell notice for an ambiguous cross-checkout change stays. */
const GUARD_NOTICE_TTL_MS = 24 * 60 * 60_000;
/** OTTR-763: most bell notices the guard keeps; a burst of ambiguous changes cannot flood the bell. */
const GUARD_NOTICE_MAX = 20;

/** OTTR-763: the unrecorded new commits between the guard's before head and now, with
 * metadata. Empty when either head is unreadable; a HEAD advance the board recorded
 * never contributes commits: its own machinery made that change. An unwired ops member
 * resolves to the real reader (the commitSubjects pattern): production always reads
 * real commit times and file lists, and only tests may stub the member. */
async function guardNewCommits(
	ops: TurnOps,
	other: TurnProject,
	was: { head: string | null },
	now: { head: string | null },
): Promise<GuardCommit[]> {
	if (now.head === null || was.head === null) return [];
	return (ops.commitMeta ?? commitMeta)(other.path, was.head, now.head).catch(
		() => [] as GuardCommit[],
	);
}

/** OTTR-708/OTTR-763: the change one other project's checkout shows against its before
 * snapshot. Null: nothing to report — nothing changed, or a HEAD advance the board's
 * own merge machinery recorded. */
async function checkoutGuardChangeParts(
	other: TurnProject,
	ops: TurnOps,
	boardPushedHeads: Map<string, string>,
	was: { head: string | null; status: string },
	now: { head: string | null; status: string },
): Promise<GuardChange | null> {
	const head = now.head;
	const headMoved = head !== null && head !== was.head;
	const recorded = headMoved && boardPushedHeads.get(other.name) === head;
	const files =
		now.status !== was.status
			? now.status
					.split("\n")
					.map((l) => l.slice(3).trim())
					.filter((l) => l !== "")
			: [];
	if (files.length === 0 && (!headMoved || recorded)) return null;
	const commits =
		headMoved && !recorded ? await guardNewCommits(ops, other, was, now) : [];
	const parts: string[] = [];
	if (headMoved && !recorded)
		parts.push(
			commits.length > 0
				? `new commits ${listed(commits.map((c) => `${c.sha} ${c.subject}`))}`
				: `HEAD moved to ${head.slice(0, 7)}`,
		);
	if (files.length > 0) parts.push(`changed files ${listed(files)}`);
	if (parts.length === 0) return null;
	return { commits, files, parts };
}

/** OTTR-763: every other turn whose window can hold the change, as `project#task`.
 * The settling turn's own window always holds the change (its before snapshot read the
 * old state), so the candidates that matter are the other turns. The evidence interval
 * is the commit times when the change carries commits, the settling turn's whole guard
 * window otherwise (a file-only change carries no timestamp). A turn whose window ended
 * before the guard window start is never a candidate. */
function blameCandidates(
	projects: Map<string, TurnProject>,
	st: TurnSettle,
	change: GuardChange,
): string[] {
	const windowStart = st.dispatch.runStartedAt;
	const windowEnd = st.now;
	const times = change.commits.map((c) => c.time);
	const evStart = times.length > 0 ? Math.min(...times) : windowStart;
	const evEnd = times.length > 0 ? Math.max(...times) : windowEnd;
	const others: string[] = [];
	for (const p of projects.values()) {
		for (const t of p.store.openOrRecentTurns(windowStart)) {
			if (p.name === st.name && t.id === st.dispatch.turn.id) continue;
			const end = t.endedAt ?? Number.POSITIVE_INFINITY;
			if (t.startedAt <= evEnd && end >= evStart)
				others.push(`${p.name}#${t.taskId}`);
		}
	}
	return others;
}

/** OTTR-763: one other project's checkout-guard verdict. */
type GuardVerdict =
	| { kind: "none" }
	| { kind: "park"; reason: string }
	| { kind: "notice"; key: string; notice: GuardNotice };

/** OTTR-708/OTTR-763: one other project's checkout read and verdict. Skips the project
 * (its own merge turn is mid-flight, no before snapshot, an unreadable checkout) or
 * answers "none" when nothing changed, the AGENTS.md sync rule's file set changed, or
 * the change's blame is not ambiguous (that verdict parks instead). */
async function checkoutGuardProjectVerdict(
	projects: Map<string, TurnProject>,
	ops: TurnOps,
	boardPushedHeads: Map<string, string>,
	st: TurnSettle,
	other: TurnProject,
): Promise<GuardVerdict> {
	// The other project's own merge turn is mid-flight: its agent fast-forwards its
	// main checkout legitimately, and the settle records the head it advanced. Skip
	// the project until that turn is over.
	const mergingInFlight = other.store
		.listTasks()
		.some((t) => t.stage === "merging" && t.state === "running");
	if (mergingInFlight) return { kind: "none" };
	const before = st.mx.guardBefore;
	const was = before?.get(other.name);
	if (was === undefined) return { kind: "none" };
	const now = await ops.checkoutState(other.path).catch(() => null);
	if (now === null) return { kind: "none" };
	const change = await checkoutGuardChangeParts(
		other,
		ops,
		boardPushedHeads,
		was,
		now,
	);
	if (change === null) return { kind: "none" };
	const allFiles = [
		...new Set([...change.commits.flatMap((c) => c.files), ...change.files]),
	];
	// OTTR-763: the AGENTS.md sync rule tells a work turn to commit its own project's
	// provisioned copies (projects/<project>/) to the agent-data main checkout in the
	// same turn. Every file under that prefix is that commit.
	if (
		allFiles.length > 0 &&
		allFiles.every(
			(f) =>
				f === `projects/${st.name}` || f.startsWith(`projects/${st.name}/`),
		)
	) {
		console.log(
			`checkout guard: ${other.name} change is ${st.name}'s provisioned-copy sync (${listed(allFiles)}) — allowed by the AGENTS.md sync rule`,
		);
		return { kind: "none" };
	}
	const others = blameCandidates(projects, st, change);
	if (others.length === 0)
		return {
			kind: "park",
			reason: `The ${other.name} main checkout changed while this turn ran (${change.parts.join("; ")}). Those changes do not belong to this card: file a card in ${other.name} (create_task with its project parameter) and move the commits and files there, then reply to resume this card.`,
		};
	// OTTR-763: two or more turns overlap the change, so the guard cannot say which
	// turn made it: park neither card; log the change and ring one notice that names
	// the commit and the running cards.
	const cards = [`${st.name}#${st.id}`, ...others].join(", ");
	console.log(
		`checkout guard: ${other.name} changed during overlapping turns (${cards}); parked no card: ${change.parts.join("; ")}`,
	);
	return {
		kind: "notice",
		key: `${other.name}|${now.head ?? ""}|${allFiles.join(",")}`,
		notice: {
			at: Date.now(),
			text: `${other.name} main checkout changed while several cards were running (${cards}): ${change.parts.join("; ")}. No card was parked.`,
		},
	};
}

/** OTTR-708: the cross-project checkout guard. Compares the before/after main-checkout
 * snapshots of the other projects: a new commit the board did not make, or a status change,
 * is a change made outside this turn's own worktree. A HEAD advance the board's own merge
 * machinery made is discounted with a clean tree: the merge settle records the head it left
 * behind whatever path it took (pushed, failed, rejected, skipped, refused, hold park with
 * a branch reset), and a project whose own merge turn is in flight is skipped outright —
 * its main checkout belongs to that turn right now. Merges of other projects run
 * concurrently with work turns by design.
 * OTTR-763: the guard blames a change only when this turn's window alone overlaps it. A
 * change that also sits inside another turn's window is ambiguous: no card parks, the
 * board logs the change once and rings one bell notice that names the commit and the
 * running cards. A change whose files all sit under projects/<this project>/ is the
 * AGENTS.md sync rule's provisioned-copy commit and is allowed outright. Returns the
 * needs_you reason, null when every other checkout reads unchanged or no change is
 * this turn's alone. */
async function checkoutGuardReason(
	projects: Map<string, TurnProject>,
	ops: TurnOps,
	boardPushedHeads: Map<string, string>,
	st: TurnSettle,
	recordNotice: (key: string, notice: GuardNotice) => void,
): Promise<string | null> {
	if (st.mx.guardBefore === null) return null;
	for (const other of projects.values()) {
		if (other.name === st.name || other.gitless) continue;
		const verdict = await checkoutGuardProjectVerdict(
			projects,
			ops,
			boardPushedHeads,
			st,
			other,
		);
		if (verdict.kind === "park") return verdict.reason;
		if (verdict.kind === "notice") recordNotice(verdict.key, verdict.notice);
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
	/** OTTR-768: true when the target ref tracks AGENTS.md. Refreshed by the scheduler tick
	 * like dirty and mainUnpushed (a failed check keeps the last value); hasRules reads it. */
	targetRules?: boolean;
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
	/** The chat catalog a retro or review run's propose_task checks a model against; overridable for tests. */
	modelList?: typeof modelList;
	/** Prepare-phase title generator; overridable for tests. */
	genTitle?: (
		prompt: string,
		spawn?: SpawnFn,
		onFail?: (cause: string) => void,
	) => Promise<string | null>;
	/** Delay before the single retry of a failed title generation (OTTR-486); overridable for tests. */
	titleRetryDelayMs?: number;
	/** OTTR-823 preparation gate: the comprehension check model call; overridable for tests so none spawns a gateway. */
	gateCheck?: typeof promptGateCheck;
	/** Commit subjects on the target since a base, for the check run's input; overridable for tests. */
	commitSubjects?: typeof commitSubjects;
	/** OTTR-763: per-commit metadata (sha, subject, committer time, changed files) the
	 * cross-project checkout guard uses to attribute a change to a turn window and to
	 * exempt the AGENTS.md sync rule's provisioned-copy commits by their file set.
	 * Optional like commitSubjects: the guard resolves an absent member to the real
	 * reader, so production reads real metadata; only tests stub it. */
	commitMeta?: typeof commitMeta;
	/** True while an update holds new turns (POST /api/drain): running turns finish, nothing new starts. */
	drained(): boolean;
	/** OTTR-454: true while a per-runner hold covers this runner id (a worker hostname or "local"). */
	drainedRunner(id: string): boolean;
	/** OTTR-754: the /tmp free-space warning phrase for this runner (a worker hostname or
	 *  "local"), null when space is fine or unknown. Absent in test fakes: the gate never
	 *  blocks on it, matching an old board. */
	tmpFullLine?: (runner: string) => string | null;
	/** OTTR-754: the /tmp free-space line for this runner, always reported when the space
	 *  is known (an apt disk failure must name the runner's free space even after the
	 *  sweep recovered it); null when unknown. Absent in test fakes appends nothing. */
	tmpSpaceLine?: (runner: string) => string | null;
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
	/** True when the target ref's tree holds AGENTS.md (hasRules's git fact); absent = the real read. */
	targetTracksRules?: typeof targetTracksRules;
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
	/** OTTR-800: deletes the pushed remote card branch when a PR-mode card ends (git() adds the host auth). */
	deleteRemoteBranch?: typeof deleteRemoteBranch;
	/** PR mode: adopts or opens the pull request for the card branch (gh via runGh). */
	openPr?: typeof openPullRequest;
	/** PR mode: the integrated proof — clean worktree tree and origin/<target> an ancestor of HEAD. */
	prIntegrated?: (
		mainPath: string,
		worktreePath: string,
		target: string,
	) => Promise<boolean>;
	/** OTTR-760: true when two commits hold identical trees — the card branch carries exactly the source PR's content. */
	treesEqual?: typeof treesEqual;
	/** OTTR-760: posts one comment on a pull request (gh via runGh); the "@dependabot rebase" handoff and the fixes note. */
	prComment?: typeof commentOnPullRequest;
	/** OTTR-781: fetches a legacy Dependabot card's source PR head into refs/ottr/pr/N at ship time. */
	fetchPrHead?: typeof fetchPrHead;
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
		/** The model named no provider: the fix is switching the model on the card. */
		badModel?: string;
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
 * The card's reason for a credential-stopped turn: a model that names no provider is not a
 * sign-in fault, so the reason names the model and the card's switch; a busy store names the
 * retry; any other credential fault says to sign in again.
 */
function signInNeedsReason(
	credentialError: string | null | undefined,
	busy: boolean,
	badModel?: string,
): string {
	if (badModel !== undefined && badModel !== "")
		return `Model: ${badModel} names no provider (expected provider/model). The turn did not start. Switch the model on the card (provider/model), then reply to retry.`;
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

/**
 * OTTR-754: append the runner's /tmp warning phrase to a failed run's reason when the
 * reason carries one of apt's disk-failure signatures (OTTR-753's evidence: "is not
 * signed" or "Splitting up" from a full /tmp during apt). The runner comes from the
 * dispatch record — never parsed out of the reason text, whose stderr path carries no
 * dispatch token. Null runner = local. No phrase (space fine or unknown): the reason
 * stays as it is. Exported so tests hit the matcher and the append directly.
 */
export function tmpEnrichNeedsReason(
	needsReason: string,
	runner: string | null,
	tmpFullLine: ((runner: string) => string | null) | undefined,
): string {
	const APT_DISK_SIGNATURES = ["is not signed", "Splitting up"];
	if (!APT_DISK_SIGNATURES.some((s) => needsReason.includes(s)))
		return needsReason;
	const line = tmpFullLine?.(runner ?? "local");
	return line === null || line === undefined
		? needsReason
		: `${needsReason}; ${line}`;
}

/**
 * OTTR-754: stamps the runner's /tmp warning onto a settled reason. The runner comes from
 * the dispatch record's url (undefined = a local run); a reason without an apt disk-failure
 * signature, or a runner with unknown or fine space, stays as it is.
 */
function enrichTmpReason(
	settled: Next,
	url: string | undefined,
	tmpSpaceLine: ((runner: string) => string | null) | undefined,
): Next {
	if (settled.needsReason === null) return settled;
	const runner = url === undefined ? null : new URL(url).hostname;
	const line = tmpEnrichNeedsReason(settled.needsReason, runner, tmpSpaceLine);
	return line === settled.needsReason
		? settled
		: { ...settled, needsReason: line };
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

/** First line prefix of a Dependabot card prompt; also the dedupe key, so #1 never matches #12. Pure. */
export function dependabotHead(n: number, repo: string): string {
	return `Dependabot PR #${n} (${githubHost().webBase}/${repo}/pull/${n})`;
}

/** PR number parsed from a Dependabot card's first line, else null: the line must start
 * with dependabotHead(n, repo) for THIS repo, with n a positive safe integer written
 * without leading zeros (the prompt is untrusted text; the URL comes from the configured
 * repo, never from the line). Pure. */
export function parseDependabotHeadLine(
	line: string,
	repo: string,
): number | null {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`^Dependabot PR #(\\d+) \\(${esc(githubHost().webBase)}/${esc(repo)}/pull/(\\d+)\\)`,
	);
	const m = re.exec(line);
	if (m === null || m[1] !== m[2]) return null;
	const n = Number(m[1]);
	if (!Number.isSafeInteger(n) || n <= 0 || m[1] !== String(n)) return null;
	return n;
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
	/** OTTR-763: the cross-project checkout guard's ambiguous-change notices for the bell
	 * (one per change; names the commit and the running cards), oldest first. */
	checkoutNotices(): string[];
	/** Boot restart sweep: settle open rows left by a dead tracker process and requeue. */
	recoverRestarted(): Promise<void>;
}

/** Values prepareTurnHeader fixes for the rest of the turn: the settings snapshot, the
 * fetch target with its head, the turn's base, and the card-log byte offset of the
 * turn's own section. */
type TurnHeader = {
	settings: ProjectSettings;
	target: string;
	sha: string;
	base: string;
	turnLogOffset: number;
};

/** The per-card kind flags turnIdentityFlags reads off the task row once. */
type TurnIdentityFlags = {
	releaseCard: boolean;
	reviewCard: boolean;
	retroCard: boolean;
	boardCheck: boolean;
	interview: boolean;
	grill: boolean;
	scout: boolean;
};

/** The flags plus the session name resolveTurnIdentity fixed before the run. */
type TurnIdentity = TurnIdentityFlags & { sessionName: string | null };

/** Where the turn runs, with `branch` proven only for worktree cards: interview, grill
 * and trending-scout cards run in the main checkout and never read a branch name. */
type RunLocation =
	| { special: true; wt: string }
	| { special: false; wt: string; branch: string };

/** Mutable run state a phase helper writes and runTurn's catch and finally read. */
type TurnRunShared = {
	/** This run's slot in `running`; null until startRun returns (the catch/finally may run early). */
	entry: RunEntry | null;
	turn: Turn | null;
	/** Set when sweepLostTurns took over a hung check of this run: the finally must then
	 * leave the preparing claim alone (it may belong to a replacement run already). */
	checkTakenOver: boolean;
	/** OTTR-708: the other projects' main-checkout snapshots taken just before the run
	 * started; null when this turn kind is not guarded. The settle re-checks them. */
	guardBefore: Map<string, { head: string | null; status: string }> | null;
};

/** The agent run one turn dispatches (ops.startRun's handle). */
type TurnRunHandle = ReturnType<TurnOps["startRun"]>;

/** The metering handle openMeter returns for one agent run (null on a self-hosted board). */
type OpenRunMeter = (
	role: string,
	main?: boolean,
) => {
	onUsage: InterimMeter["onUsage"];
	settle(result: RunResult): void;
} | null;

/** What a turn resumes (resumePlan): the session id to --resume, and the note folded into
 * the prompt when the saved session is lost (or the pending reply when none exists). */
type TurnPlan = { resumeId: string | null; note: string | null };

/** The pending reply state and the prompt the run carries, read as late as startRun. */
type TurnInput = {
	live: Task;
	raw: string | null;
	pending: string | null;
	plan: TurnPlan;
	prompt: string;
	turnImages: string[];
	imagePaths: string[];
};

/** The worker target the run dispatches to, with drained runners dropped. */
type TurnLiveWorker = Pick<WorkerTarget, "urls" | "token">;

/** The env values the board lends the run (ops.turnEnv; a fixed empty shape in tests). */
type TurnEnvValues = Awaited<ReturnType<NonNullable<TurnOps["turnEnv"]>>>;

/** The tools/PATH prep a local run gets (ops.prepareTurn; null for a worker run). */
type TurnPrep = Awaited<ReturnType<NonNullable<TurnOps["prepareTurn"]>>> | null;

/** Where and how the run executes, fixed by routeTurnRun. */
type TurnRoute = {
	vmTurn: boolean;
	worker: WorkerTarget | null;
	liveWorker: TurnLiveWorker | null;
	local: boolean;
	prep: TurnPrep;
	execModel: string | null;
	runModel: string | null;
	restoreFailed: boolean;
	turnEnv: TurnEnvValues;
};

/** The started run plus its metering handle, the HTTP-400 correlation window start, and the
 * recorded turn row (also on mx.turn for runTurn's catch and finally). */
type TurnDispatch = {
	handle: TurnRunHandle;
	runMeter: ReturnType<OpenRunMeter>;
	runStartedAt: number;
	turn: Turn;
};

/** One turn's settle pass: the context the prepare and dispatch phases fixed, plus the
 * mutable state each settle helper reads and writes. Fields follow runTurn's original
 * locals; every helper keeps the statement order of its original block. */
type TurnSettle = {
	name: string;
	id: string;
	key: string;
	kind: TurnKind;
	e: TurnProject;
	store: ProjectStore;
	task: Task;
	header: TurnHeader;
	idn: TurnIdentity;
	loc: RunLocation;
	input: TurnInput;
	route: TurnRoute;
	dispatch: TurnDispatch;
	mx: TurnRunShared;
	openMeter: OpenRunMeter;
	creditBlocked: () => boolean;
	log: (line: string) => void;
	// run facts
	result: RunResult;
	vmOut: VmOutcome | null;
	runEndedAt: number;
	reportText: string | null;
	reportError: string | null;
	wasResearch: boolean;
	demoteCandidate: boolean;
	fromMain: boolean;
	finishedCleanly: boolean;
	shots: string[] | undefined;
	// merge ship state
	pushError: string | null;
	pushRejected: boolean;
	pushOutput: string | null;
	recheckError: string | null;
	holdHead: string | null;
	holdMismatch: string | null;
	holdDiff: string | null;
	holdFiles: DiffFileStat[] | null;
	holdTip: string | null;
	remoteLanded: boolean;
	refused: string | null;
	prNext: Next | null;
	// classify and post-classify state
	research: boolean;
	steered: boolean;
	/** Settle timestamp: the row's endedAt and the queued write's queuedAt share it. */
	now: number;
	// settle writes
	unsaved: string | null;
	report: string | null | undefined;
	steps: "yes" | "no" | undefined;
	commits: number | null | undefined;
	mergeHead: string | null | undefined;
	keptFiles: string[] | undefined;
	holdReason: string | null;
	/** OTTR-766: a merge-hold park deferred until the work check passed (planMergeHolds). */
	holdPark: Next | null;
	// checks
	workCard: boolean;
	reviewFindings: RecordedFinding[];
	checkWillRun: boolean;
};

/** The source PR facts a ship needs (OTTR-760 stored on the row; OTTR-781 resolved for a
 * legacy Dependabot card at ship time): null headRef/url mean "not known yet". */
interface SourcePrRef {
	headSha: string | null;
	headRef: string | null;
	url: string | null;
	crossRepo: boolean;
	dependabot: boolean;
}

/** The five stored source-PR fields off the task row (OTTR-760). */
function storedSourcePr(st: TurnSettle): SourcePrRef {
	return {
		headSha: st.task.sourcePrHeadSha,
		headRef: st.task.sourcePrHeadRef,
		url: st.task.sourcePrUrl,
		crossRepo: st.task.sourcePrCrossRepo === true,
		dependabot: st.task.sourcePrDependabot === true,
	};
}

/** First line of a finding, for logs and the card report (the body can be long). */
function findingHead(f: RecordedFinding): string {
	return f.prompt.split("\n")[0]?.slice(0, 120) ?? "";
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
	// OTTR-763: the ambiguous cross-checkout changes the guard saw (no card parked):
	// the bell shows one notice per change, deduped by the change key, bounded and
	// expiring. The state response reads them through checkoutNotices().
	const guardNotices: Array<{ at: number; text: string; key: string }> = [];
	function recordGuardNotice(key: string, notice: GuardNotice): void {
		if (guardNotices.some((n) => n.key === key)) return;
		for (;;) {
			const oldest = guardNotices[0];
			if (
				oldest === undefined ||
				(notice.at - oldest.at <= GUARD_NOTICE_TTL_MS &&
					guardNotices.length < GUARD_NOTICE_MAX)
			)
				break;
			guardNotices.shift();
		}
		guardNotices.push({ ...notice, key });
	}
	/** The bell's notice lines for the guard's ambiguous changes, oldest first. */
	function checkoutNotices(): string[] {
		return guardNotices.map((n) => n.text);
	}
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

	/** The resume reply for a requeued lost turn: the omp session and worktree survive, so queue
	 * a continue reply; a never-saved session starts fresh via resumePlan on the next start.
	 * restartResumePrompt itself collapses dirty and unknown trees back to ".". */
	async function lostResumeReply(cur: ListedTask): Promise<string> {
		if (cur.worktree === null) return ".";
		const sha = await ops.targetSha(cur.worktree, "HEAD").catch(() => null);
		if (sha === null) return ".";
		return restartResumePrompt({
			sha,
			clean: await ops.isClean(cur.worktree).catch(() => false),
		});
	}

	/** The interrupted turn's prompt rides again when its omp session never saved it: a restart
	 * seconds into a turn otherwise resumes the saved session with only the note, and the agent
	 * never sees what the turn was asked to do. A missing session file needs no resend — that
	 * turn starts a fresh session, whose start re-sends the card's instructions. */
	function lostResumePrompt(
		store: ProjectStore,
		cur: ListedTask,
		lost: Turn | null,
		base: string,
	): string {
		return lost !== null &&
			cur.sessionId !== null &&
			sessionFile(store.sessionsDir, cur.sessionId) !== null &&
			!sessionHoldsPrompt(store.sessionsDir, cur.sessionId, lost.prompt)
			? `${lost.prompt}\n\n${base}`
			: base;
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
		const resume = await lostResumeReply(cur);
		const lost =
			turnId === null
				? null
				: (store.listTurns(t.id).find((row) => row.id === turnId) ?? null);
		const base = cur.pendingPrompt ?? resume;
		store.updateTask(t.id, {
			state: "queued",
			needsReason,
			pendingPrompt: lostResumePrompt(store, cur, lost, base),
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

	/** OTTR-454, boot side: a pid-null row is a worker run the update detached instead of losing.
	 * Ask the workers before settling it lost: a still-running match keeps the row open and
	 * registers a watcher the sweep polls; a finished one settles through the resume route with
	 * the restart reason. No match (or an unreachable worker) keeps the lost settle to the caller.
	 * ponytail: matchDetached re-guards ops.detachedRuns, so this first conjunct is redundant;
	 * the remaining conjuncts are pinned by the re-bind tests. */
	async function rebindDetachedRestart(
		e: TurnProject,
		t: ListedTask,
		turn: Turn | undefined,
	): Promise<boolean> {
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
					return true;
				}
				await settleDetached(e, t, turn.id);
				return true;
			}
		}
		return false;
	}

	/** True when this sweep pass finished a merge card whose push already landed. The
	 * crash window between the server merge push and the settle's SQLite writes leaves
	 * the card at merging/running with its commits already on origin: the requeue below
	 * would spend a full resume merge turn on work the pushed target holds. The proof
	 * fetches the pinned origin branch first — the tracker can die before the push
	 * helper's recordLandedPush writes the tracking ref, so the cached ref can lag the
	 * remote — and then uses the ancestor read the settle's own integration proof uses:
	 * the card branch's head contained in the pushed target's remote-tracking ref. A
	 * merge that never pushed fails the proof and keeps the requeue. The writes mirror
	 * the integrated settle: the row outcome, the done/idle state, the Done metadata
	 * measureSettleGit stamps (target commit count, merge head), the push-sha pin (same
	 * local-tip-equals-pushed-tip condition as the CI-watch pin), and the worktree
	 * removal. Idempotent: the pass writes done/idle, so a second pass skips the card
	 * at the state filter. Never pushes. */
	async function finishPushedMergeAtBoot(
		e: TurnProject,
		t: ListedTask,
		turn: Turn | undefined,
	): Promise<boolean> {
		if (t.stage !== "merging" || t.cancelledAt !== null) return false;
		// A worker run's push state is not provable from the main checkout's refs.
		if (!t.branch || !t.worktree || turn === undefined || turn.pid === null)
			return false;
		const settings = e.store.getSettings();
		const resolved = await ops
			.resolveTarget(e.path, false, settings.originUrl, settings.targetBranch)
			.catch(() => null);
		const target = resolved?.target ?? null;
		if (target === null || !target.startsWith("origin/")) return false;
		const short = target.slice("origin/".length);
		const pushedRef = `refs/remotes/origin/${short}`;
		// The proof reads origin itself, never only the cached tracking ref: the tracker
		// can die in the interval between the push landing on origin and the push
		// helper's recordLandedPush writing the tracking ref, so the cached ref can lag
		// the remote. This is the same pinned-URL re-check the push retry runs; a fetch
		// failure fails closed into the normal requeue.
		if (settings.originUrl === null) return false;
		const fetchError = await ops
			.fetchOriginBranch(e.path, short, settings.originUrl)
			.catch(() => "fetch failed");
		if (fetchError !== null) return false;
		const branchTip = await ops
			.targetSha(e.path, `refs/heads/${t.branch}`)
			.catch(() => null);
		const pushedTip = await ops.targetSha(e.path, pushedRef).catch(() => null);
		if (
			branchTip === null ||
			pushedTip === null ||
			!(await ops
				.targetContains(e.path, branchTip, pushedRef)
				.catch(() => false))
		)
			return false;
		const store = e.store;
		appendLog(
			store,
			t.id,
			`- ${target} already holds ${t.branch} on origin: the merge push landed before the restart; finishing the card integrated`,
		);
		if (turn.endedAt === null)
			store.finishTurn(turn.id, {
				endedAt: Date.now(),
				exitCode: null,
				outcome: "integrated",
				error: null,
			});
		const localTargetTip = await ops
			.targetSha(e.path, `refs/heads/${short}`)
			.catch(() => null);
		store.updateTask(t.id, {
			stage: "done",
			state: "idle",
			needsReason: null,
			// The Done metadata measureSettleGit stamps: the target commit count and the
			// target head anchor the release's late-commit attribution to this merge.
			commits: await ops.targetCommits(e.path, target),
			mergeHead: await ops.targetSha(e.path, target).catch(() => null),
			...(localTargetTip !== null && localTargetTip === pushedTip
				? { pushSha: pushedTip }
				: {}),
		});
		// Same done cleanup as the settle's stampDoneCard: capture what the run left
		// uncommitted, then remove the worktree and its branch (best effort there too).
		store.updateTask(t.id, {
			uncommittedFiles: await ops.statusFiles(t.worktree).catch(() => []),
		});
		try {
			await ops.removeWorktree({
				mainPath: e.path,
				worktreePath: t.worktree,
				branch: t.branch,
				log: (line) => appendLog(store, t.id, line),
			});
			appendLog(store, t.id, "- worktree removed");
		} catch (err) {
			appendLog(store, t.id, `! removeWorktree: ${errmsg(err)}`);
		}
		return true;
	}

	/** One card of the boot restart sweep: settle the open row of a card whose run died with
	 * the tracker and requeue it through the resume route. */
	async function restartSweepTask(
		e: TurnProject,
		t: ListedTask,
	): Promise<void> {
		if (t.state !== "running" && t.state !== "preparing") return;
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
			return;
		}
		if (await rebindDetachedRestart(e, t, turn)) return;
		// A merge card the crash window left unrecorded (the push landed after the
		// tracker died, the settle write never ran) finishes integrated here instead
		// of spending a resume turn on commits origin already holds.
		try {
			if (await finishPushedMergeAtBoot(e, t, turn)) return;
		} catch (err) {
			logStoreError(e.store.name, err);
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
			for (const t of tasks) await restartSweepTask(e, t);
		}
	}

	/** One lost open row found by the sweep, with its settle arguments. */
	interface LostRun {
		e: TurnProject;
		id: string;
		turnId: number;
		pid: number | null;
	}

	/** One lost second-model check found by the sweep, with its settle arguments. */
	interface LostCheckRun {
		e: TurnProject;
		id: string;
		checkKey: string;
		pid: number | null;
	}

	/** One watcher of the poll: settle-and-drop a finished detached run, keep the watcher for
	 * an unreachable worker (the next tick retries the settle through the same route). */
	async function settleDetachedWatcher(
		key: string,
		watch: { url: string; runId: string },
		probe: NonNullable<TurnOps["detachedRuns"]>,
	): Promise<void> {
		// ponytail: a watcher exists only because workerTarget answered at recovery, so
		// the optional chain cannot see null, and ?? equals || for string|undefined.
		const runs = await probe(watch.url, runnerToken(watch.url) ?? "").catch(
			() => null,
		);
		// Probe failure is not proof of a loss: leave the row open and retry next tick.
		if (runs === null) return;
		if (runs.find((r) => r.id === watch.runId)?.running) return;
		const sep = key.indexOf("/");
		const e = projects.get(key.slice(0, sep));
		const t = e?.store.getTask(key.slice(sep + 1));
		const turn = t && e ? e.store.listTurns(t.id).at(-1) : null;
		// ponytail: the t && e lookup above turns a missing project or task into a null
		// turn, so !e and !t are backstopped by !turn.
		if (!e || !t || !turn || turn.endedAt !== null) {
			detached.delete(key);
			return;
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

	/** OTTR-454: poll every re-bound detached run first. Still running: leave its row to the
	 * scan below untouched this tick. Finished or gone: settle through the restart-resume
	 * route and drop the watcher (only after the settle write, so a concurrent tick's scan
	 * cannot double-settle the row). An unreachable worker keeps the watcher and the row. */
	async function pollDetachedWatchers(): Promise<void> {
		for (const [key, watch] of [...detached]) {
			const probe = ops.detachedRuns;
			if (probe === undefined) break;
			await settleDetachedWatcher(key, watch, probe);
		}
	}

	/** d774111 keeps the card running while a second-model check runs, with the run's own row
	 * already closed: the row path below never sees that phase. A check entry whose pid is dead
	 * or absent hangs the card in running forever — a grandchild can hold the check's stdio
	 * pipes past maxTime — and holds two cap units (its entry plus the run's preparing claim).
	 * Sweep it like any lost run; a live check (own pid alive) is never swept. True when the
	 * card holds a check entry, dead or alive. */
	function collectLostCheck(
		e: TurnProject,
		t: ListedTask,
		key: string,
		lostChecks: LostCheckRun[],
	): boolean {
		const check = running.get(`${key}:check`);
		if (check !== undefined) {
			pushLostCheck(e, t, `${key}:check`, check, lostChecks);
			return true;
		}
		const workCheck = running.get(`${key}:workcheck`);
		if (workCheck === undefined) return false;
		pushLostCheck(e, t, `${key}:workcheck`, workCheck, lostChecks);
		return true;
	}

	function pushLostCheck(
		e: TurnProject,
		t: ListedTask,
		checkKey: string,
		entry: RunEntry,
		lostChecks: LostCheckRun[],
	): void {
		const pid = entry.pid;
		if (pid === null || !ops.pidAlive(pid))
			lostChecks.push({ e, id: t.id, checkKey, pid });
	}

	/** Worker-run liveness for an open pid-null row: a re-bound detached run is its own proof
	 * (the watcher poll settles it when it ends) and so is a live stream in `running`. */
	function lostWorkerRow(key: string): boolean {
		if (detached.has(key)) return false;
		if (running.get(key)?.pid === null) return false;
		return true;
	}

	/** Frees the cap slot of a run whose pid died with the row still open: a late `done` finds
	 * the entry abandoned. The abandoned run's finally never runs while `done` hangs, so its
	 * preparing claim would hold a cap slot forever; the resumed turn re-adds its own. */
	function abandonDeadEntry(key: string, turn: Turn): void {
		const entry = running.get(key);
		if (entry === undefined || entry.pid !== turn.pid) return;
		running.delete(key);
		entry.abandoned = true;
		preparing.delete(key);
	}

	/** One card's open turn row: classify it lost (worker run with no live proof, or a dead
	 * pid) and record the settle arguments. */
	function collectLostRow(
		e: TurnProject,
		t: ListedTask,
		key: string,
		lost: LostRun[],
	): void {
		const turn = e.store.listTurns(t.id).at(-1);
		if (!turn || turn.endedAt !== null) return;
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
			return;
		if (turn.pid === null) {
			// Worker run: the live stream in `running` is the liveness proof. A local spawn failure
			// stores pid null too but settles its row in runTurn's catch; and running.set precedes
			// store.startTurn synchronously, so a sweep can never see an open pid-null row for a
			// live local run. A pid-null lost row therefore has no live entry to abandon by
			// construction — the abandonment block below is pid-path only.
			if (lostWorkerRow(key))
				lost.push({ e, id: t.id, turnId: turn.id, pid: null });
			return;
		}
		if (ops.pidAlive(turn.pid)) return;
		abandonDeadEntry(key, turn);
		lost.push({ e, id: t.id, turnId: turn.id, pid: turn.pid });
	}

	/** One card of the lost-run scan. */
	function collectLostRun(
		e: TurnProject,
		t: ListedTask,
		lost: LostRun[],
		lostChecks: LostCheckRun[],
	): void {
		// Only in-flight cards can hold an open turn row (same filter as the boot restart sweep).
		if (t.state !== "running" && t.state !== "preparing") return;
		const key = `${e.name}/${t.id}`;
		if (collectLostCheck(e, t, key, lostChecks)) return;
		collectLostRow(e, t, key, lost);
	}

	/** The scan half of the sweep: every project's in-flight cards, one sick store isolated. */
	function collectLostRuns(lost: LostRun[], lostChecks: LostCheckRun[]): void {
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
			for (const t of tasks) collectLostRun(e, t, lost, lostChecks);
		}
	}

	async function settleLostRows(lost: LostRun[]): Promise<void> {
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
	}

	async function settleLostChecks(lostChecks: LostCheckRun[]): Promise<void> {
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
		await pollDetachedWatchers();
		// Synchronous scan: claimed entries leave `running` before the first await, so a re-entrant
		// schedule() cannot double-settle a row.
		const lost: LostRun[] = [];
		const lostChecks: LostCheckRun[] = [];
		collectLostRuns(lost, lostChecks);
		await settleLostRows(lost);
		await settleLostChecks(lostChecks);
	}

	/** One project's sync-commit hygiene findings; empty when none apply. */
	async function syncCommitFinding(e: TurnProject): Promise<string[]> {
		const lines: string[] = [];
		if (e.gitless) return lines;
		const target = e.target;
		if (target === null || !target.startsWith("origin/")) return lines;
		const short = target.slice("origin/".length);
		const branch = await ops.checkedOutBranch(e.path).catch(() => null);
		if (branch !== null && branch !== short)
			lines.push(
				`Board: ${e.name}'s main checkout is on branch ${branch}, not ${short}.`,
			);
		if (await ops.branchUnpushed(e.path, short))
			lines.push(`Board: ${e.name}'s local ${short} has commits origin lacks.`);
		return lines;
	}

	/** OTTR-531: one line per sync-commit hygiene finding, appended to a settled turn's
	 * outcome details. Git failures add no line (the tick refreshes the flags instead). */
	async function syncCommitFindings(): Promise<string[]> {
		const lines: string[] = [];
		for (const e of projects.values())
			lines.push(...(await syncCommitFinding(e)));
		return lines;
	}

	/** OTTR-531: on the false→true edge of an unpushed main, a standing pushSyncCommits
	 * approval pushes the local target ref once — no edge (a failed push leaves the flag true)
	 * means no retry storm. */
	function syncUnpushedMain(
		e: TurnProject,
		branch: string,
		unpushed: boolean,
	): void {
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
	}

	/** Per-project flag refresh of the schedule tick: dirty, mainUnpushed (with the standing
	 * pushSyncCommits approval above), mainBranch, release/arch-review/PR flags. */
	function refreshProjectFlags(e: TurnProject): void {
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
			e.target?.startsWith("origin/") === true
				? (e.target?.slice("origin/".length) ?? null)
				: null;
		if (branch !== null)
			void ops
				.branchUnpushed(e.path, branch)
				.then((unpushed) => syncUnpushedMain(e, branch, unpushed))
				.catch(() => {
					// git failed: keep the last mainUnpushed flag; the next tick retries.
				});
		// OTTR-531: the off-default finding's git fact, refreshed like the dirty flag —
		// a failed check keeps the last mainBranch; the next tick retries.
		void ops
			.checkedOutBranch(e.path)
			.then((b) => {
				e.mainBranch = b;
			})
			.catch(() => {
				// git failed: keep the last mainBranch; the next tick retries.
			});
		// OTTR-768: the rules gate's git fact — does the target track AGENTS.md? A failed
		// check keeps the last targetRules flag; the next tick retries (like mainBranch).
		void (ops.targetTracksRules ?? targetTracksRules)(e.path, e.target)
			.then((tracks) => {
				e.targetRules = tracks;
			})
			.catch(() => {
				// git failed: keep the last targetRules flag; the next tick retries.
			});
		void ops.refreshRelease(e);
		void ops.refreshArchReview(e);
		void ops.refreshOpenPrs?.(e);
	}

	/** One project's dispatch: pick runnable cards and start a turn for each. True when the
	 * tick must stop (the global cap bit). */
	function dispatchRunnable(
		e: TurnProject,
		drained: boolean,
		cap: number | null,
		active: () => number,
		depProjects: DepProject[],
	): boolean {
		const settings = getSettingsLogged(e);
		const runnable = pickRunnable(e.store.listTasks(), {
			maxParallel: settings.maxParallel,
			hasRules: ops.hasRules(e.path, e.targetRules === true),
			only: drained ? e.store.boardCheckId() : undefined,
			mainUnpushed: e.mainUnpushed === true,
			prMode: settings.prMode === true,
			crossDeps: (did) => findDep(did, depProjects, depProjectOf(e.store)),
		});
		for (const t of runnable) {
			if (cap !== null && active() >= cap) return true;
			void runTurn(e.store.name, t.id);
		}
		// The release command's process takes a cap slot too: do not overbook the tick.
		return cap !== null && active() >= cap;
	}

	/** One project of the dispatch loop: start its runnable turns, then settle review cards
	 * unless an update drain holds the board. True when the tick must stop (the cap bit). */
	function dispatchProject(
		e: TurnProject,
		drained: boolean,
		cap: number | null,
		active: () => number,
		depProjects: DepProject[],
	): boolean {
		try {
			if (dispatchRunnable(e, drained, cap, active, depProjects)) return true;
			if (!drained) void settleReviews(e.store.name);
			return false;
		} catch (err) {
			// One sick store (locked file, missing table) must not stop the other projects'
			// schedule or turn the write that triggered this tick into a 500.
			logStoreError(e.store.name, err);
			return false;
		}
	}

	/** One project's low-priority pick. A trending scout already running stops the whole tick. */
	function pickProjectScout(
		e: TurnProject,
		drained: boolean,
		scout: { name: string; id: string } | null,
		depProjects: DepProject[],
	): { name: string; id: string } | { stop: true } | null {
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
				return { stop: true };
			if (scout !== null) return null;
			const t = pickLowPriority(tasks, {
				maxParallel: getSettingsLogged(e).maxParallel,
				hasRules: ops.hasRules(e.path, e.targetRules === true),
				only: drained ? e.store.boardCheckId() : undefined,
				mainUnpushed: e.mainUnpushed === true,
				crossDeps: (did) => findDep(did, depProjects, depProjectOf(e.store)),
			});
			return t === null ? null : { name: e.store.name, id: t.id };
		} catch (err) {
			logStoreError(e.store.name, err);
			return null;
		}
	}

	/** The low-priority slot: a trending scout starts only after every project's picks above
	 * left a free slot, in project order, at most one per call and one running board-wide.
	 * Returns the scout to start, or a stop mark when one already runs (the tick ends). */
	function pickScout(
		drained: boolean,
		cap: number | null,
		active: () => number,
		depProjects: DepProject[],
	): { name: string; id: string } | { stop: true } | null {
		if (cap !== null && active() >= cap) return { stop: true };
		let scout: { name: string; id: string } | null = null;
		for (const e of projects.values()) {
			const found = pickProjectScout(e, drained, scout, depProjects);
			if (found !== null) {
				if ("stop" in found) return found;
				scout = found;
			}
		}
		return scout;
	}

	function schedule(): void {
		ops.publishSoon(); // board diffs from dirty/release flags and new turns ship without polling
		void sweepLostTurns(); // before the cap check: a vanished run must free its slot this tick
		// Refresh every project first: a full cap must not skip the later projects' dirty and
		// release flags (they gate the board and the merge queue).
		for (const e of projects.values()) refreshProjectFlags(e);
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
			if (dispatchProject(e, drained, cap, active, depProjects)) return;
		}
		const scouted = pickScout(drained, cap, active, depProjects);
		if (scouted !== null && !("stop" in scouted))
			void runTurn(scouted.name, scouted.id);
	}

	/** The finding cards' mergeHeads, in done order: the anchors that mark which late
	 * commits are review fixes in the published notes. */
	function releaseFindingHeads(
		store: ProjectStore,
		task: ListedTask,
	): string[] {
		return reviewFindings(store.listTasks(), task)
			.filter(
				(f): f is ListedTask & { mergeHead: string } =>
					f.cancelledAt === null && f.mergeHead !== null,
			)
			.sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
			.map((f) => f.mergeHead);
	}

	/** The default publish: tag the target's head — the review's fixes landed there after the
	 * reviewed commit, and settleReviews waited for them (publishRelease refuses a head
	 * without that commit). Returns the release line, or null when a cancel won the claim. */
	async function publishTaggedRelease(
		e: TurnProject,
		task: ListedTask,
		releaseVersion: string,
		base: string,
		settings: ProjectSettings,
		archReview: { delta: number } | null,
		findings: string[],
		claimPublish: () => boolean,
		log: (line: string) => void,
	): Promise<string | null> {
		const head = await ops.resolveTarget(
			e.path,
			true,
			settings.originUrl,
			settings.targetBranch,
		);
		if (head.warning !== null) log(head.warning);
		if (!claimPublish()) return null;
		return ops.publishRelease({
			mainPath: e.path,
			reviewed: base,
			sha: head.sha,
			version: releaseVersion,
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
	}

	/** The project's own release command; the command may refuse a dirty tree. Returns the
	 * release line, or null when a cancel won the claim. */
	async function runReleaseCommandPublish(
		e: TurnProject,
		task: ListedTask,
		releaseVersion: string,
		wt: string,
		target: string,
		base: string,
		releaseCommand: string,
		originUrl: string | null,
		archReview: { delta: number } | null,
		claimPublish: () => boolean,
		log: (line: string) => void,
	): Promise<string | null> {
		const store = e.store;
		// Outside the worktree: the command may refuse a dirty tree.
		const notesFile = join(store.tasksDir, `release-${task.id}.md`);
		writeBelow(store.dataRoot, notesFile, task.releaseNotes ?? "");
		log(`$ ${releaseCommand}`);
		if (!claimPublish()) return null;
		const key = `${store.name}/${task.id}`;
		let releaseEntry: RunEntry | null = null;
		try {
			return await ops.runReleaseCommand({
				command: releaseCommand,
				cwd: wt,
				mainPath: e.path,
				originUrl,
				target,
				sha: base,
				version: releaseVersion,
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

	/** Publish one approved release card: Ottr's tag/push/GitHub release, or the project's release
	 * command. Returns null on success, else a needs_you reason. Runs at the end of the review turn
	 * (runTurn) or later from settleReviews once the review's findings have landed. A cancel that
	 * lands before the publish step skips it and also returns null: the cancel owns the card, so
	 * callers re-read the card before they write. On publish, the card's key enters `publishing`;
	 * the caller deletes it after its final card write. */
	async function publishReleaseCard(
		e: TurnProject,
		task: ListedTask,
		releaseVersion: string,
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
			const findings = releaseFindingHeads(store, task);
			const line =
				settings.releaseCommand === null
					? await publishTaggedRelease(
							e,
							task,
							releaseVersion,
							base,
							settings,
							archReview,
							findings,
							claimPublish,
							log,
						)
					: await runReleaseCommandPublish(
							e,
							task,
							releaseVersion,
							wt,
							target,
							base,
							settings.releaseCommand,
							settings.originUrl,
							archReview,
							claimPublish,
							log,
						);
			if (line === null) return null;
			log(line);
			return null;
		} catch (err) {
			return `Release failed: ${errmsg(err)}. Fix it, then reply to retry.`;
		}
	}

	/** The exact state runTurn parks a held review card in; needsReason doubles as the held marker. */
	function heldReviewCard(t: ListedTask): t is ListedTask & { base: string } {
		return (
			t.stage === "merging" &&
			t.state === "idle" &&
			t.needsReason !== null &&
			isReview(t) &&
			t.base !== null &&
			t.cancelledAt === null
		);
	}

	/** True while a merge that may push runs: one active, or a queued one no review holds. */
	function mergePushInFlight(live: ListedTask[]): boolean {
		return live.some(
			(t) =>
				t.stage === "merging" &&
				(t.state === "running" ||
					t.state === "preparing" ||
					(t.state === "queued" && mergeHold(live, t) === null)),
		);
	}

	/** A release card whose findings are done: publish, park on a failure, or land done with
	 * the release summary. */
	async function settleReleaseCard(
		e: TurnProject,
		t: ListedTask,
		releaseVersion: string,
		base: string,
		target: string,
		cancelled: () => boolean,
	): Promise<void> {
		// Stored findings the review check never covered refuse the done write.
		const cur = e.store.getTask(t.id);
		if (
			cur !== null &&
			e.store.listReviewFindings(t.id).length > 0 &&
			cur.findingsCheckedAt === null
		) {
			e.store.updateTask(t.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: UNCHECKED_FINDINGS_HOLD,
			});
			return;
		}
		// A release publishes from its worktree.
		if (t.worktree === null) return;
		const err = await publishReleaseCard(
			e,
			t,
			releaseVersion,
			base,
			t.worktree,
			target,
		);
		if (cancelled()) return;
		if (err !== null) {
			e.store.updateTask(t.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: err,
			});
			return;
		}
		const commits = await ops.targetCommits(e.path, target);
		const mergeHead = await ops.targetSha(e.path, target).catch(() => null);
		// Same capture rule as the plain review done above.
		const uncommitted =
			t.worktree !== null && existsSync(t.worktree)
				? await ops.statusFiles(t.worktree)
				: [];
		if (cancelled()) return;
		e.store.updateTask(t.id, {
			stage: "done",
			state: "idle",
			needsReason: null,
			summary: `Released ${releaseVersion}`,
			uncommittedFiles: uncommitted,
			commits,
			mergeHead,
		});
	}

	/** One review card whose findings are done: the Review button's card lands done, a release
	 * publishes. A cancel that lands in the awaits leaves the card alone. */
	async function settleReviewCard(
		e: TurnProject,
		t: ListedTask,
		base: string,
		target: string,
		cancelled: () => boolean,
	): Promise<void> {
		if (findingsHold(e.store.listTasks(), t) !== null) return;
		// Stored findings the review check never covered refuse the done write: park for
		// a human; a reply resumes the review and the next settle runs the check.
		const cur = e.store.getTask(t.id);
		if (
			cur !== null &&
			e.store.listReviewFindings(t.id).length > 0 &&
			cur.findingsCheckedAt === null
		) {
			e.store.updateTask(t.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: UNCHECKED_FINDINGS_HOLD,
			});
			return;
		}
		if (t.releaseVersion === null) {
			// The Review button's card has nothing to publish.
			const commits = await ops.targetCommits(e.path, target);
			const mergeHead = await ops.targetSha(e.path, target).catch(() => null);
			// The review's worktree holds its generated report files; capture them
			// before cleanupPass removes the tree, like the turn settle does.
			const uncommitted =
				t.worktree !== null && existsSync(t.worktree)
					? await ops.statusFiles(t.worktree)
					: [];
			if (cancelled()) return;
			e.store.updateTask(t.id, {
				stage: "done",
				state: "idle",
				needsReason: null,
				uncommittedFiles: uncommitted,
				commits,
				mergeHead,
			});
			return;
		}
		await settleReleaseCard(e, t, t.releaseVersion, base, target, cancelled);
	}

	/** One held review card of the tick: claim the settle, run it, release the claims. */
	async function settleHeldReview(
		e: TurnProject,
		t: ListedTask & { base: string },
		target: string,
	): Promise<void> {
		const key = `${e.store.name}/${t.id}`;
		if (settling.has(key)) return;
		settling.add(key);
		// A release command's process takes a global cap slot: claim it before the first
		// await, or every project in the same schedule() tick sees the slot free (R3-5).
		preparing.add(key);
		// `tasks` is this tick's snapshot and every await below may let a cancel in: re-read
		// before each write, and leave a cancelled card to cancel.
		const cancelled = () => e.store.getTask(t.id)?.cancelledAt !== null;
		try {
			await settleReviewCard(e, t, t.base, target, cancelled);
		} finally {
			settling.delete(key);
			preparing.delete(key);
			publishing.delete(key);
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
			if (mergePushInFlight(live)) return;
			for (const t of tasks) {
				if (!heldReviewCard(t)) continue;
				await settleHeldReview(e, t, target);
			}
		} catch (err) {
			// Voided by schedule(): a locked store must reject into the log, not unhandled.
			logStoreError(name, err);
		}
	}

	async function runTurn(name: string, id: string): Promise<void> {
		const claim = claimTurn(name, id);
		if (claim === null) return;
		const { e, store, task, key, kind } = claim;
		const log = (line: string) => appendLog(store, id, line);
		/** Mutable run state the catch and finally read after a phase helper wrote it. */
		const mx: TurnRunShared = {
			entry: null,
			turn: null,
			checkTakenOver: false,
			guardBefore: null,
		};
		/** Hosted metering: one entry for each settled agent run of this turn, reported in the finally. */
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
					mx.turn === null
						? null
						: {
								project: name,
								taskId: id,
								turnId: mx.turn.id,
								kind,
								role,
								run,
							},
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
		const creditBlocked = () => creditBlockedRun(store, id, key, log);
		try {
			const header = await prepareTurnHeader(e, store, id, task, kind, log);
			if (header === null) return;
			const flags = turnIdentityFlags(store, id, task);
			const idn = await resolveTurnIdentity(store, id, task, key, flags, log);
			if (idn === null) return;
			if (!(await promptGateTurnStart(store, id, task, kind, idn, log))) return;
			const loc = await prepareTurnWorktree(
				e,
				store,
				id,
				task,
				header,
				idn,
				log,
			);
			if (loc === null) return;
			const wt = loc.wt;

			await captureMergeDiff(store, id, kind, wt, header, idn.interview, log);
			const input = buildTurnInput(
				store,
				id,
				task,
				kind,
				header,
				idn,
				loc,
				log,
			);

			const route = await routeTurnRun(
				name,
				e,
				store,
				id,
				task,
				kind,
				header,
				idn,
				loc,
				input,
				creditBlocked,
				log,
			);
			if (route === null) return;

			const dispatch = await dispatchTurnRun(
				name,
				e,
				store,
				id,
				task,
				key,
				kind,
				header,
				idn,
				loc,
				input,
				route,
				mx,
				openMeter,
				log,
			);
			if (dispatch === null) return;

			// True stops (a cancel, a taken-over check, a credit stop) have written their
			// parks; nothing follows the settle in this try, so only the finally remains.
			await settleTurnRun(
				name,
				e,
				id,
				task,
				key,
				kind,
				header,
				idn,
				loc,
				input,
				route,
				dispatch,
				mx,
				openMeter,
				creditBlocked,
			);
		} catch (err) {
			settleTurnError(name, store, id, mx, log, err);
		} finally {
			releaseRunClaim(name, e, id, task, key, kind, mx, interims, metered);
		}
	}

	/** The turn died in the tracker: log the error, close the row when it exists, park the
	 * card, and revoke any VM token of this card (startRun revokes its own token when its run
	 * settles; this covers a throw in between). */
	function settleTurnError(
		name: string,
		store: ProjectStore,
		id: string,
		mx: TurnRunShared,
		log: (line: string) => void,
		err: unknown,
	): void {
		const msg = errmsg(err);
		try {
			log(`! ${msg}`);
		} catch {
			// logging must not mask the error path
		}
		if (mx.turn)
			store.finishTurn(mx.turn.id, { endedAt: Date.now(), error: msg });
		store.updateTask(id, {
			state: "needs_you",
			needsReason: `Tracker error: ${msg}`,
		});
		ops.vmTokens?.revokeTask(name, id);
	}

	/** Releases one finished run's claims and reports its metering: the running slot (only
	 * when the sweep has not replaced it), the stop mark, the preparing claim and credit-stop
	 * mark (an abandoned run's claim was already deleted by the sweep and may belong to the
	 * resumed replacement now — deleting it here would free the replacement's cap slot; a
	 * taken-over check is the same case), the publishing claim, and each run's usage report
	 * (also of a stopped or failed run; no interim record goes out after this point, also for
	 * a run whose result never came). */
	/** The board-visible outcome this settle ships with the metering record (M10): the
	 * settled turn row's outcome, with a parked card reading needs_you even when the run
	 * reported none, and a card the settle requeues (a dependency hold, steering, a queued
	 * rebase retry) reading "queued" — the control plane would otherwise email the owner
	 * about a card nobody must act on. A value outside /^[a-z_]{1,40}$/ (null included)
	 * sends nothing. */
	function settledOutcome(
		row: string | null,
		settledTask: Task | null | undefined,
	): string | null {
		const rowOutcome = row !== null && /^[a-z_]{1,40}$/.test(row) ? row : null;
		if (settledTask?.state === "needs_you") return "needs_you";
		if (settledTask?.state === "queued" && rowOutcome === "needs_you")
			return "queued";
		return rowOutcome;
	}

	/** The card prompt's first line, trimmed and cut to 200 characters; an empty line
	 * sends nothing. */
	function meteringTitle(task: Task): string | null {
		const firstLine = task.prompt.split("\n")[0]?.trim() ?? "";
		return firstLine === "" ? null : firstLine.slice(0, 200);
	}

	/** The final metering record of each metered run of one finished run: the outcome and
	 * the title ride the main run's record only. */
	function reportRunMetering(
		hosted: Hosted,
		turn: Turn,
		name: string,
		id: string,
		kind: TurnKind,
		task: Task,
		e: TurnProject,
		metered: MeteredRun[],
	): void {
		const settledTask = e.store.getTask(id);
		const row = e.store.listTurns(id).at(-1)?.outcome ?? null;
		const outcome = settledOutcome(row, settledTask);
		const title = meteringTitle(task);
		for (const entry of metered) {
			const { main, ...r } = entry;
			sendMetering(hosted, {
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

	function releaseRunClaim(
		name: string,
		e: TurnProject,
		id: string,
		task: Task,
		key: string,
		kind: TurnKind,
		mx: TurnRunShared,
		interims: Set<InterimMeter>,
		metered: MeteredRun[],
	): void {
		// The sweep may have replaced this entry: only drop the map slot this run still owns.
		if (mx.entry && running.get(key) === mx.entry) running.delete(key);
		// A stop that raced a natural finish leaves no mark behind.
		stopping.delete(key);
		if (!mx.entry?.abandoned && !mx.checkTakenOver) {
			preparing.delete(key);
			creditStopped.delete(key);
		}
		publishing.delete(key);
		for (const interim of interims) interim.close();
		if (ops.hosted !== undefined && mx.turn !== null) {
			// M10: the outcome is the state the board shows after this settle; see
			// settledOutcome for the parked and requeued cases.
			reportRunMetering(ops.hosted, mx.turn, name, id, kind, task, e, metered);
		}
		schedule();
	}

	/** True when the comprehension gate runs on this turn (OTTR-823 scope): plain work turns only —
	 * no identity flag set, no research card, no PR adopt, no pr_review kind. Every skip is silent. */
	function gateApplies(
		kind: TurnKind,
		flags: TurnIdentityFlags,
		task: Task,
	): boolean {
		if (kind !== "work") return false;
		if (
			flags.interview ||
			flags.grill ||
			flags.scout ||
			flags.retroCard ||
			flags.reviewCard ||
			flags.releaseCard ||
			flags.boardCheck
		)
			return false;
		if (task.research) return false;
		if (task.sourcePrNumber !== null) return false;
		if (task.kind === "pr_review") return false;
		return true;
	}

	/** The synchronous claim of one queued turn: re-entrancy and drain gates, the preparing
	 * write, and the run identity. Null: the card is not startable this tick. Runs before the
	 * first await so a re-entrant schedule() cannot double-start. */
	function claimTurn(
		name: string,
		id: string,
	): {
		e: TurnProject;
		store: ProjectStore;
		task: Task;
		key: string;
		kind: TurnKind;
	} | null {
		const e = projects.get(name);
		if (!e) return null;
		const store = e.store;
		const task = store.getTask(id);
		const key = `${name}/${id}`;
		if (
			task?.state !== "queued" ||
			task.cancelledAt !== null ||
			running.has(key)
		)
			return null;
		const kind: TurnKind = task.stage === "merging" ? "merge" : "work";
		const preRetro = isRetro(task);
		const preBoardCheck = store.boardCheckId() === id;
		if (startGatesHold(e, task, key, kind, preRetro, preBoardCheck)) {
			// OTTR-754: a /tmp hold names the runner and its free space on the queued card,
			// so the card shows why it waits. A drain-only hold keeps its silent surface
			// (the board's drain view carries that cause). One write per text change: the
			// phrase is stable across schedule ticks while the space stays below the limit.
			const tmpReason = startGateTmpReason(
				e,
				task,
				kind,
				preRetro,
				preBoardCheck,
			);
			if (tmpReason !== null && task.needsReason !== tmpReason)
				store.updateTask(id, { needsReason: tmpReason });
			return null;
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
		return { e, store, task, key, kind };
	}

	/** OTTR-454 per-runner drain: a hold on every worker (or on "local") defers the start,
	 * the card stays queued, and the next schedule tick retries. The board-wide gate
	 * (ops.drained() in schedule()) is unchanged; its board-check exception does not apply
	 * here — a "local" hold stops board checks too. Flags read before the claim: they are
	 * the same ones the worker decision in routeTurnRun makes.
	 * OTTR-532: an eligible turn of a microVM project goes to vm-runner only. A runner
	 * that is down, unconfigured or drained, or a card whose last dispatch it refused as
	 * busy moments ago, leaves the card queued and unclaimed (the board shows vmHoldFor);
	 * it never falls back to the classic pool or the server. */
	function startGatesHold(
		e: TurnProject,
		task: Task,
		key: string,
		kind: TurnKind,
		preRetro: boolean,
		preBoardCheck: boolean,
	): boolean {
		if (
			microVmTurn({
				microVm: getSettingsLogged(e).microVm === true,
				kind,
				retro: preRetro,
				boardCheck: preBoardCheck,
				task,
			})
		)
			return vmStartGateHolds(key);
		return poolStartGateHolds(kind, preRetro, preBoardCheck);
	}

	/** The microVM start gate: a down or unconfigured runner, a drain, or a recent busy
	 * refusal leaves the card queued and unclaimed. */
	function vmStartGateHolds(key: string): boolean {
		const vmTarget = ops.vmTarget ?? null;
		if (vmTarget === null || !vmState.health.ok) return true;
		if (vmTarget.urls.every((u) => ops.drainedRunner(new URL(u).hostname)))
			return true;
		const busyAt = vmBusyAt.get(key);
		if (busyAt !== undefined && Date.now() - busyAt < VM_BUSY_RETRY_MS)
			return true;
		return false;
	}

	/** The classic-pool start gate: the runner the card would go to is drained. */
	function poolStartGateHolds(
		kind: TurnKind,
		preRetro: boolean,
		preBoardCheck: boolean,
	): boolean {
		// ponytail: `target !== null` appears here and in the ternary below; either
		// `true`-replacement alone cannot change the branch (the other check re-derives
		// it), so Stryker's two equivalent mutants of the pair stay without a killer test.
		const target = ops.workerTarget ?? null;
		const toWorker =
			kind !== "merge" && !preRetro && !preBoardCheck && target !== null;
		// OTTR-754: a runner whose /tmp is below the free-space limit holds like a drain.
		// The microVM gate (vmStartGateHolds) stays untouched: a vm turn runs in a fresh VM.
		const runnerDrained =
			toWorker && target !== null
				? target.urls.every(
						(u) =>
							ops.drainedRunner(new URL(u).hostname) ||
							ops.tmpFullLine?.(new URL(u).hostname) != null,
					)
				: ops.drainedRunner("local") || ops.tmpFullLine?.("local") != null;
		return runnerDrained;
	}

	/** OTTR-754: the /tmp part of the same hold poolStartGateHolds answers, null when no
	 * runner's /tmp is below the limit (a drain-only hold carries no card reason; the
	 * board's drain view and the update notice carry that cause). A microVM hold keeps
	 * the vmHoldFor surface. Each line is the tmpFullLine phrase, so the card reason
	 * names the runner and its free space exactly like the bell notice. */
	function startGateTmpReason(
		e: TurnProject,
		task: Task,
		kind: TurnKind,
		preRetro: boolean,
		preBoardCheck: boolean,
	): string | null {
		if (
			microVmTurn({
				microVm: getSettingsLogged(e).microVm === true,
				kind,
				retro: preRetro,
				boardCheck: preBoardCheck,
				task,
			})
		)
			return null;
		const target = ops.workerTarget ?? null;
		const toWorker =
			kind !== "merge" && !preRetro && !preBoardCheck && target !== null;
		const urls = toWorker && target !== null ? target.urls : null;
		if (urls === null) return ops.tmpFullLine?.("local") ?? null;
		const full = urls
			.map((u) => ops.tmpFullLine?.(new URL(u).hostname) ?? null)
			.filter((line) => line !== null);
		return full.length === 0 ? null : full.join("; ");
	}

	/** Hosted credit stop (docs/specs/hosted-mode.md section 5): true when the loop's credit
	 * hold or this turn's creditStop mark forbids the next model run. The card then parks
	 * needs_you with the credit reason, unless a cancel or another park already owns it. */
	function creditBlockedRun(
		store: ProjectStore,
		id: string,
		key: string,
		log: (line: string) => void,
	): boolean {
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
	}

	/** Writes the card-log section header and resolves the fetch target the turn runs against
	 * (a new worktree starts from a freshly fetched target; an existing one keeps its base).
	 * Hosted: the credit gate runs first, before anything spends a model token. */
	async function prepareTurnHeader(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		kind: TurnKind,
		log: (line: string) => void,
	): Promise<TurnHeader | null> {
		if (
			ops.hosted !== undefined &&
			!(await creditGate(ops.hosted, store, task, log))
		)
			return null;
		const settings = store.getSettings();
		// Capture must stay adjacent to the header write: the offset is the header's byte
		// position in the card log. A missing file is a fresh card, so the header starts at 0.
		const turnLogOffset =
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
		// A review card reviews the frozen sha it was created with, not the current target head.
		// A review card's base is always its frozen sha, so `?? sha` only fires for normal tasks.
		return { settings, target, sha, base: task.base ?? sha, turnLogOffset };
	}

	/** The per-card kind flags: read once from the task row and reused by every phase. */
	function turnIdentityFlags(
		store: ProjectStore,
		id: string,
		task: Task,
	): TurnIdentityFlags {
		return {
			releaseCard: task.releaseVersion !== null && task.base !== null,
			// The Review button's card runs the same read-only review at its frozen base, minus the publish.
			reviewCard: isReview(task) && task.base !== null,
			retroCard: isRetro(task),
			// The Check the board button's card: only its route sets the mark, never the prompt text.
			boardCheck: store.boardCheckId() === id,
			interview: task.kind === "interview",
			// A backlog card only ever runs grill turns: worktree-less, in the main checkout.
			grill: task.stage === "backlog",
			// The weekly trending scout: read-only in the main checkout, with only the read tools
			// and its two verdict tools (propose_repo, judge_repo) on the board env. It reads
			// third-party text, so it runs on a worker when one exists (D6) and never holds the
			// board's GitHub token, also on a local run.
			scout: task.kind === "trending",
		};
	}

	/** OTTR-823 comprehension gate, phase before the worktree: false parks the card needs_you
	 * (no worktree, no file change, no omp spawn); true proceeds. Runs only on gated work turns. */
	async function promptGateTurnStart(
		store: ProjectStore,
		id: string,
		task: Task,
		kind: TurnKind,
		idn: TurnIdentity,
		log: (line: string) => void,
	): Promise<boolean> {
		if (!gateApplies(kind, idn, task)) return true;
		const live = store.getTask(id) ?? task;
		const pending =
			live.pendingPrompt !== null && live.pendingPrompt !== "."
				? live.pendingPrompt
				: null;
		const seen = live.gate?.seen ?? null;
		// Skip rule: the gate passed for exactly this compared text.
		if (
			live.gate?.hash ===
			gateFingerprint(gateCompareText(live.prompt, pending, seen))
		) {
			log("+ prompt gate: passed earlier for this text");
			return true;
		}
		// Deterministic park: the Deepen rewrite left an Open questions section and no user
		// answers exist yet. No model call; the section's lines become the ask questions.
		if (
			pending === null &&
			seen === null &&
			hasOpenQuestionsSection(live.prompt)
		) {
			const lines = openQuestionsLines(live.prompt);
			const asked = lines.map((question) => ({
				question,
				options: [],
				multi: false,
				recommended: null,
			}));
			const sig = lines.join("\n");
			const fails = live.gate?.sig === sig ? live.gate.fails + 1 : 1;
			parkGate(
				store,
				id,
				{
					needsReason: `${GATE_REASON}the prompt still carries an Open questions section`,
					asked,
					gate: { hash: null, seen, fails, sig, parked: true },
				},
				log,
			);
			return false;
		}
		// Model evaluation; one immediate retry on any failure.
		let check: GateCheck | null = null;
		let err: Error | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				check = await (ops.gateCheck ?? promptGateCheck)({
					prompt: live.prompt,
					userMessages: gateUserText(pending, seen),
				});
				err = null;
				break;
			} catch (e) {
				err = e as Error;
			}
		}
		if (err !== null || check === null) {
			const cause = err?.message ?? "unknown failure";
			log(`! prompt gate: ${cause}`);
			parkGate(
				store,
				id,
				{
					needsReason: `${GATE_REASON}${cause}`,
					asked: null,
					gate: {
						hash: null,
						seen,
						fails: live.gate?.sig === "error" ? live.gate.fails + 1 : 1,
						sig: "error",
						parked: true,
					},
				},
				log,
			);
			return false;
		}
		const missing = !check.points[4]?.covered;
		if (check.questions.length === 0 && !missing) {
			// Pass: restate what the gate understood, stamp the fingerprint, start.
			log(`+ prompt gate: would build: ${check.builds}`);
			log(`+ prompt gate: check: ${check.checks}`);
			const missingPoints = check.points
				.map((p, i) => ({ p, i }))
				.filter(({ p }) => !p.covered);
			if (missingPoints.length === 0)
				log("+ prompt gate: all five points covered");
			for (const { p, i } of missingPoints)
				log(`+ prompt gate: missing: ${DEEPEN_POINTS[i]} — ${p.reason}`);
			store.updateTask(id, {
				gate: {
					hash: gateFingerprint(gateCompareText(live.prompt, pending, seen)),
					seen: gateUserText(pending, seen),
					fails: 0,
					sig: null,
					parked: false,
				},
			});
			return true;
		}
		// Park with the gate's questions (and a missing outside check, named).
		const modelQs = gateAskQuestions(check);
		const sig = check.questions.map((q) => q.question).join("\n");
		const fails = live.gate?.sig === sig ? live.gate.fails + 1 : 1;
		let asked = modelQs;
		if (missing) asked = [...asked, missingCheckQuestion()];
		if (fails >= 3 && live.gate?.sig === sig) asked = [startAnywayQuestion()];
		else if (fails >= 2) asked = [...asked.slice(0, 4), startAnywayQuestion()];
		const cause =
			missing && modelQs.length === 0
				? "the prompt names no outside check"
				: "the gate still has open questions";
		parkGate(
			store,
			id,
			{
				needsReason: `${GATE_REASON}${cause}`,
				asked,
				gate: { hash: null, seen, fails, sig, parked: true },
			},
			log,
		);
		return false;
	}

	/** The one gate park write: needs_you with the reason, the ask questions and the gate state. */
	function parkGate(
		store: ProjectStore,
		id: string,
		write: {
			needsReason: string;
			asked: AskQuestion[] | null;
			gate: PromptGateState;
		},
		log: (line: string) => void,
	): void {
		log(`! ${write.needsReason}`);
		store.updateTask(id, {
			state: "needs_you",
			needsReason: write.needsReason,
			asked: write.asked,
			gate: write.gate,
		});
	}

	/** Fixes the session name before the run: the fixed name of a release-review, review or
	 * board-check card, else a tracker-generated title (persisted before the run and pinned on
	 * the session, so the board never waits for the run's rename — omp's auto titler can take
	 * ~30 minutes or never fire). Null: a credit stop owns the card, the turn stops. */
	async function resolveTurnIdentity(
		store: ProjectStore,
		id: string,
		task: Task,
		key: string,
		flags: TurnIdentityFlags,
		log: (line: string) => void,
	): Promise<TurnIdentity | null> {
		// Review sessions get one fixed name, applied by the extension before the agent runs,
		// so the board never depends on the agent inventing a title.
		const sessionName = fixedSessionName(flags);
		if (sessionName !== null) return { ...flags, sessionName };
		const named = await resolveSessionTitle(store, id, task, key, log);
		if (named.stopped) return null;
		return { ...flags, sessionName: named.name };
	}

	/** The fixed session name of the board-driven cards; every other card gets its title
	 * from the stored or generated session title below. */
	function fixedSessionName(flags: TurnIdentityFlags): string | null {
		return flags.releaseCard
			? "Release review"
			: flags.reviewCard
				? "Review"
				: flags.boardCheck
					? "Board check"
					: null;
	}

	/** The stored session title, else one generated title attempt. A stored title wins so a
	 * rename the user edited stays; a generated one is a model call a credit stop can veto. */
	async function resolveSessionTitle(
		store: ProjectStore,
		id: string,
		task: Task,
		key: string,
		log: (line: string) => void,
	): Promise<{ name: string | null; stopped: boolean }> {
		const named = store.sessionTitle(task);
		if (named !== null) return { name: named, stopped: false };
		// The title is a model call: a credit stop in the prepare above ends the turn.
		if (creditBlockedRun(store, id, key, log))
			return { name: null, stopped: true };
		return {
			name: await generateSessionTitle(store, id, task, key, log),
			stopped: false,
		};
	}

	/** One title attempt: names the card and clears any pending retry, or logs the failure and
	 * schedules the one retry an earlier turn may have promised (hosted: skipped under a
	 * credit stop, docs/specs/hosted-mode.md section 5). */
	async function generateSessionTitle(
		store: ProjectStore,
		id: string,
		task: Task,
		key: string,
		log: (line: string) => void,
	): Promise<string | null> {
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
			log(`+ title: ${gen}`);
			return gen;
		}
		log(
			`! title generation failed (${cause}); the card shows the prompt cut until the run names itself`,
		);
		if (store.titleHold(id)) {
			// This failed attempt was the one retry an earlier turn scheduled:
			// give up, so the run's own transcript title can name the card.
			store.releaseTitleHold(id);
		} else {
			scheduleTitleRetry(
				store,
				id,
				task.prompt,
				log,
				ops,
				() =>
					ops.hosted !== undefined && (creditHold || creditStopped.has(key)),
			);
		}
		return null;
	}

	/** Fixes where the turn runs: the main checkout for a worktree-less card, the card's
	 * worktree otherwise — created fresh when missing, rebuilt when a husk holds a branch
	 * whose work never landed (OTTR-341/347). Null: a cancel or a husk park owns the card,
	 * the turn stops. */
	async function prepareTurnWorktree(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		header: TurnHeader,
		flags: TurnIdentity,
		log: (line: string) => void,
	): Promise<RunLocation | null> {
		const special = flags.interview || flags.grill || flags.scout;
		// A card run always holds a branch name here: task.branch, or the one the
		// worktree step below creates. Worktree-less cards (interview, grill, scout)
		// never read it — every branch read below sits behind a !special or
		// wt !== e.path guard — so "" is an unobserved placeholder for them.
		let branch: string = task.branch ?? "";
		let wt = task.worktree;
		if (special) {
			wt = e.path;
		} else if (!wt || !branch) {
			const fresh = await createTurnWorktree(
				e,
				store,
				id,
				task,
				header,
				flags.releaseCard,
				log,
			);
			if (fresh === null) return null;
			wt = fresh.wt;
			branch = fresh.branch;
		}
		if (
			await settleHuskWorktree(
				e,
				store,
				id,
				task,
				wt,
				branch,
				header,
				special,
				log,
			)
		)
			return null;
		return special ? { special: true, wt } : { special: false, wt, branch };
	}

	/** Creates the card worktree and stamps the card row with it. Null: a cancel landed
	 * during the create; the fresh worktree is removed again (the agent never ran, so there
	 * is nothing to lose) and the turn stops. */
	async function createTurnWorktree(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		header: TurnHeader,
		releaseCard: boolean,
		log: (line: string) => void,
	): Promise<{ wt: string; branch: string } | null> {
		const branch = `ott/${id.toLowerCase()}-${slugify(task.title)}`;
		const wt = join(store.worktreesDir, id);
		log(
			`+ worktree ${branch} from ${header.target} at ${header.base}${releaseCard ? " (frozen release base)" : ""}`,
		);
		await ops.createWorktree({
			mainPath: e.path,
			worktreePath: wt,
			branch,
			base: header.base,
			copyExtra: header.settings.copyExtra,
			log,
		});
		store.updateTask(id, { branch, base: header.base, worktree: wt });
		if (store.getTask(id)?.cancelledAt) {
			// fresh worktree: the agent never ran, so there is nothing to lose
			await ops
				.removeWorktree({
					mainPath: e.path,
					worktreePath: wt,
					branch,
					log,
				})
				.catch((err) => log(`! removeWorktree: ${errmsg(err)}`));
			return null;
		}
		return { wt, branch };
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
	async function settleHuskWorktree(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		wt: string,
		branch: string,
		header: TurnHeader,
		special: boolean,
		log: (line: string) => void,
	): Promise<boolean> {
		if (
			special ||
			wt !== task.worktree ||
			!(await ops.worktreeHusk(wt).catch(() => false))
		)
			return false;
		const facts = await huskLandedFacts(
			e,
			store,
			id,
			task,
			branch,
			header.base,
			header.target,
		);
		// A cancel that landed while the git reads ran owns the card; never write over it.
		if (facts === null) return true;
		if (facts.landed)
			return settleLandedHusk(e, store, id, header.target, facts.head, log);
		if (facts.branchHead !== null && facts.branchHead !== header.base)
			return rebuildHuskAtBranch(
				e,
				store,
				id,
				wt,
				branch,
				facts.branchHead,
				header,
				log,
			);
		if (facts.head !== null && facts.head !== header.base) {
			parkHuskWorktree(store, id, header.target, log);
			return true;
		}
		return rebuildHuskAtBase(e, store, id, wt, branch, header, log);
	}

	/** The husk's git facts: the head the approved hold or the branch names and whether the
	 * target already contains it. Null: a cancel landed while the git reads ran and owns
	 * the card. */
	async function huskLandedFacts(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		branch: string,
		base: string,
		target: string,
	): Promise<{
		head: string | null;
		landed: boolean;
		branchHead: string | null;
	} | null> {
		const approvedHead = task.updateMergeHead ?? task.forkMergeHead;
		const branchHead = await ops
			.targetSha(e.path, `refs/heads/${branch}`)
			.catch(() => null);
		const head = approvedHead ?? branchHead;
		const landed =
			head !== null &&
			head !== base &&
			(await ops.targetContains(e.path, head, target).catch(() => false));
		const cur = store.getTask(id);
		if (cur === null || cur.cancelledAt !== null) return null;
		return { head, landed, branchHead };
	}

	/** The husk's branch already landed on the target: settle the card done. The turn never
	 * ran, so there is no row to finish and its queued reply is consumed unread. */
	async function settleLandedHusk(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		target: string,
		head: string | null,
		log: (line: string) => void,
	): Promise<boolean> {
		log(
			`- worktree is gone; head ${head} is already on ${target}: the card settles done`,
		);
		// Same end state as the hold settle for a landed approval.
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
		return true;
	}

	// OTTR-347: the branch holds commits the target never got; rebuild the
	// worktree from its tip so the turn resumes the branch's work.
	async function rebuildHuskAtBranch(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		wt: string,
		branch: string,
		branchHead: string,
		header: TurnHeader,
		log: (line: string) => void,
	): Promise<boolean> {
		log(`+ worktree is gone; recreating ${branch} at its head ${branchHead}`);
		await ops.createWorktree({
			mainPath: e.path,
			worktreePath: wt,
			branch,
			base: branchHead,
			copyExtra: header.settings.copyExtra,
			log,
		});
		// A cancel that landed while the worktree was rebuilt owns the card; the
		// branch holds the work, so nothing is deleted here.
		if (store.getTask(id)?.cancelledAt) return true;
		return false;
	}

	/** Nothing approved and nothing committed past base: a husk holds no checkout, so rebuild
	 * the worktree on the same branch (createWorktree reuses the branch at its tip) and let
	 * the turn run from base. */
	async function rebuildHuskAtBase(
		e: TurnProject,
		store: ProjectStore,
		id: string,
		wt: string,
		branch: string,
		header: TurnHeader,
		log: (line: string) => void,
	): Promise<boolean> {
		log(
			`- worktree is gone; ${branch} has no commits past ${header.base}: recreating the worktree`,
		);
		await ops.createWorktree({
			mainPath: e.path,
			worktreePath: wt,
			branch,
			base: header.base,
			copyExtra: header.settings.copyExtra,
			log,
		});
		store.updateTask(id, { branch, base: header.base, worktree: wt });
		if (store.getTask(id)?.cancelledAt) {
			// fresh worktree: the agent never ran, so there is nothing to lose
			await ops
				.removeWorktree({
					mainPath: e.path,
					worktreePath: wt,
					branch,
					log,
				})
				.catch((err) => log(`! removeWorktree: ${errmsg(err)}`));
			return true;
		}
		return false;
	}

	/** The husk's work is not on the target: park the card for the user. */
	function parkHuskWorktree(
		store: ProjectStore,
		id: string,
		target: string,
		log: (line: string) => void,
	): void {
		log(`! worktree is gone; its work is not on ${target}`);
		store.updateTask(id, {
			state: "needs_you",
			needsReason: `The card's worktree is gone; its work is not on ${target}. Cancel the card or recreate the work.`,
		});
	}

	/** Capture the card's diff now: once the ff-merge lands, the branch tip sits on the target
	 * and no later git view can separate this branch's files from its siblings'. Skipped when
	 * the branch is already integrated (a retried merge turn): the first capture stands. */
	async function captureMergeDiff(
		store: ProjectStore,
		id: string,
		kind: TurnKind,
		wt: string,
		header: TurnHeader,
		interview: boolean,
		log: (line: string) => void,
	): Promise<void> {
		if (
			kind === "merge" &&
			!interview &&
			(await ops.commitsAhead(wt, header.target).catch(() => 0)) > 0
		) {
			const files = await ops
				.diffStat(wt, header.base, header.target)
				.catch(() => null);
			const text = await ops
				.diffText(wt, header.base, header.target)
				.catch(() => null);
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
	}

	/** Builds the run's prompt, reply state, and image list: the fresh pending read (steering
	 * can land between the pick and the omp spawn), the resume plan, the reply/raw prompt with
	 * hosted wording appended, and the images the run carries. */
	function buildTurnInput(
		store: ProjectStore,
		id: string,
		task: Task,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		log: (line: string) => void,
	): TurnInput {
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
		const pending = resumePendingPrompt(store, live, raw);
		const plan = resumePlan(
			live.sessionId,
			sessionFile(store.sessionsDir, live.sessionId) !== null,
			pending,
		);
		if (plan.resumeId !== live.sessionId)
			log(
				`! omp never saved session ${live.sessionId}; starting a fresh session`,
			);
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
		const ownPrompt = turnPrompt(
			task,
			kind,
			header,
			idn,
			loc,
			pending,
			plan,
			siblings,
			replyRejected,
		);
		// Hosted wording (docs/specs/hosted-mode.md section 1) rides after the prompt, so
		// prompts.ts stays untouched: the resume text on a reply into a session, else by kind.
		const suffix = hostedWordingSuffix(pending, plan, kind);
		const prompt = suffix === "" ? ownPrompt : `${ownPrompt}\n\n${suffix}`;
		const turnImages = turnRunImages(kind, live, pending, plan);
		const imagePaths = turnImages.map((n) => join(store.imagesDir(id), n));
		logTurnImages(imagePaths, log);
		return { live, raw, pending, plan, prompt, turnImages, imagePaths };
	}

	/** A dep-held card parks the marker; the real reply names each dependency and its end
	 * state, known only at restart (the scheduler starts the card only once they are done
	 * or cancelled — a dependency missing from the project counts as done). */
	function resumePendingPrompt(
		store: ProjectStore,
		live: Task,
		raw: string | null,
	): string | null {
		if (raw !== DEP_HELD_PROMPT) return raw;
		const all = store.listTasks();
		// OTTR-708: a foreign dependency's title comes from its project's
		// store; this runs once, on the dep-held restart only.
		const depProjects = depProjectsOf(projects.values());
		const ownDep = depProjectOf(store);
		return depResumePrompt({
			deps: live.dependsOn.map((did) => {
				const d =
					all.find((t) => t.id === did) ?? findDep(did, depProjects, ownDep);
				return {
					id: did,
					title: d?.title ?? did,
					done: d === undefined || d === null || d.stage === "done",
				};
			}),
		});
	}

	/** The run's own prompt: a reply into the session, the raw release/interview/retro/check
	 * prompt with the resume note appended, or the work/merge prompt. A fresh session
	 * (resumePlan folds the reply into its note) must not swallow a pending reply: workPrompt
	 * carries the note inside its text; the raw prompts and mergePrompt get it appended.
	 * prompts.ts wording is untouched. */
	function turnPrompt(
		task: Task,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		pending: string | null,
		plan: TurnPlan,
		siblings: { title: string; stage: Task["stage"]; branch: string | null }[],
		replyRejected: string | null,
	): string {
		return pending && plan.resumeId
			? replyTurnPrompt(kind, idn, pending, replyRejected)
			: rawTurnPrompt(task, kind, header, idn, loc, plan, siblings);
	}

	/** The reply into a resumed session: a retro's verdict-aware reply, else the plain reply. */
	function replyTurnPrompt(
		kind: TurnKind,
		idn: TurnIdentity,
		pending: string,
		replyRejected: string | null,
	): string {
		return idn.retroCard
			? retroReplyPrompt({
					text: pending,
					rejected: replyRejected,
				})
			: replyPrompt({
					text: pending,
					kind,
					release: idn.releaseCard,
					rejected: replyRejected,
				});
	}

	/** The no-reply prompt: a fresh session (resumePlan folds the reply into its note) must
	 * not swallow a pending reply — workPrompt carries the note inside its text; the raw
	 * release/interview prompt and mergePrompt get it appended. prompts.ts wording is
	 * untouched. */
	function rawTurnPrompt(
		task: Task,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		plan: TurnPlan,
		siblings: { title: string; stage: Task["stage"]; branch: string | null }[],
	): string {
		// A fresh session (resumePlan folds the reply into its note) must not swallow a pending
		// reply: workPrompt carries the note inside its text; the raw release/interview prompt
		// and mergePrompt get it appended. prompts.ts wording is untouched.
		const withNote = (base: string) =>
			plan.note === null ? base : `${base}\n\n${plan.note}`;
		return idn.releaseCard || loc.special || idn.retroCard || idn.boardCheck
			? withNote(idn.grill ? grillPrompt(task.prompt) : task.prompt)
			: kind === "work"
				? workPrompt({
						text: task.prompt,
						branch: loc.branch, // loc.special is false here, so branch holds the card's branch
						siblings,
						note: plan.note,
					})
				: withNote(
						mergePrompt({
							branch: loc.branch,
							target: header.target,
							pr: header.settings.prMode === true,
						}),
					);
	}

	/** Hosted wording (docs/specs/hosted-mode.md section 1) rides after the prompt, so
	 * prompts.ts stays untouched: the resume text on a reply into a session, else by kind. */
	function hostedWordingSuffix(
		pending: string | null,
		plan: TurnPlan,
		kind: TurnKind,
	): string {
		const wording = ops.hosted?.config.wording;
		if (wording === undefined) return "";
		return pending && plan.resumeId
			? wording.resumeSuffix
			: kind === "work"
				? wording.workSuffix
				: wording.mergeSuffix;
	}

	/** Reply turn: only the reply's images. Work turn: original prompt is re-sent, so its images
	 * plus any not-yet-sent reply images (a reply note before the first omp session). Merge turns
	 * get none. */
	function turnRunImages(
		kind: TurnKind,
		live: Task,
		pending: string | null,
		plan: TurnPlan,
	): string[] {
		return pending && plan.resumeId
			? live.pendingImages
			: kind === "work"
				? [...live.images, ...live.pendingImages]
				: [];
	}

	/** Logs every image the run carries, with its size; a missing file says so. */
	function logTurnImages(
		imagePaths: string[],
		log: (line: string) => void,
	): void {
		for (const p of imagePaths) {
			const st = statSync(p, { throwIfNoEntry: false });
			log(
				st
					? `attached image ${p} (${st.size} bytes)`
					: `attached image ${p} (missing)`,
			);
		}
	}

	/** Routes and gates the run: where it executes (vm-runner, worker pool, server), the
	 * execution model, the env, and every start park (drained runners, no model, credential
	 * fault, a cancel that landed in the prepare awaits, a usage-limit hold). Null: the turn
	 * stopped before its run. */
	async function routeTurnRun(
		name: string,
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		input: TurnInput,
		creditBlocked: () => boolean,
		log: (line: string) => void,
	): Promise<TurnRoute | null> {
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
		const picked = pickTurnWorker(e, kind, header, idn, loc, task);
		const prep = await prepareTurnPackages(name, picked.local, log);
		const execModel = resolveExecModel(
			store,
			input.live,
			input.plan,
			picked.worker,
		);
		const start = await gateTurnStart(
			store,
			id,
			picked.vmTurn,
			picked.worker,
			execModel,
			log,
		);
		if (start === null) return null;
		const liveWorker = start.liveWorker;
		const turnEnv = await gateTurnEnv(
			name,
			store,
			id,
			picked.vmTurn,
			execModel,
			log,
		);
		if (turnEnv === null) return null;
		// A cancel landing inside the prepare awaits (resolveTarget, an apt install — minutes on
		// a merge turn) already owns the card: its kept path wrote the final state. Starting the
		// run now would drive omp behind a "kept the worktree" card.
		const preRun = store.getTask(id);
		if (!preRun || preRun.cancelledAt !== null || preRun.state !== "preparing")
			return null;
		const { restoreFailed, runModel } = resolveRunModel(
			store,
			id,
			input.live,
			input.plan,
			picked.worker,
			execModel,
			log,
		);
		if (
			await gateUsageStart(
				store,
				id,
				kind,
				input.live,
				runModel,
				creditBlocked,
				log,
			)
		)
			return null;
		return {
			vmTurn: picked.vmTurn,
			worker: picked.worker,
			liveWorker,
			local: picked.local,
			prep,
			execModel,
			runModel,
			restoreFailed,
			turnEnv,
		};
	}

	/** Decides where the run executes: vm-runner for a microVM project's eligible turn, the
	 * classic worker pool for a plain work turn, the server itself for merges, retros, board
	 * checks and read-only scouts (D6, OTTR-454, OTTR-532). */
	function pickTurnWorker(
		e: TurnProject,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		task: Task,
	): { vmTurn: boolean; worker: WorkerTarget | null; local: boolean } {
		const vmTurn =
			loc.wt !== e.path &&
			!loc.special &&
			microVmTurn({
				microVm: header.settings.microVm === true,
				kind,
				retro: idn.retroCard,
				boardCheck: idn.boardCheck,
				task,
			});
		const worker = vmTurn
			? (ops.vmTarget ?? null)
			: idn.retroCard || idn.boardCheck || kind === "merge"
				? null
				: (ops.workerTarget ?? null);
		// A worker installs the project's packages into its own container (vm-runner bakes them
		// into the project layer); a local run does it here.
		return { vmTurn, worker, local: !worker && !vmTurn };
	}

	/** A worker installs the project's packages into its own container (vm-runner bakes them
	 * into the project layer); a local run does it here. */
	async function prepareTurnPackages(
		name: string,
		local: boolean,
		log: (line: string) => void,
	): Promise<TurnPrep | null> {
		if (local) for (const line of await ops.ensurePackages(name)) log(line);
		const prep = local && ops.prepareTurn ? await ops.prepareTurn(name) : null;
		for (const l of prep?.lines ?? []) log(l);
		return prep;
	}

	/** One rule for worker turns: the board lends a token for the model omp runs, and omp runs
	 * that model through an explicit --model, also on a resume. The execution model is the
	 * card's model; else, on a resume, the saved session's model; else the board's default
	 * role. A local run (merge, retro, board check) uses the board store itself: no lending,
	 * and the card's model as before. */
	function resolveExecModel(
		store: ProjectStore,
		live: Task,
		plan: TurnPlan,
		worker: WorkerTarget | null,
	): string | null {
		return worker === null
			? null
			: live.model?.trim() ||
					(plan.resumeId !== null
						? sessionModel(store.sessionsDir, plan.resumeId)
						: null) ||
					(ops.modelRoles ?? modelRoles)().default?.trim() ||
					null;
	}

	/** Parks the card with the cause instead of starting omp; a cancel that landed in the
	 * prepare awaits already owns the card (same rule as the preRun check below). */
	function parkBeforeRun(
		store: ProjectStore,
		id: string,
		reason: string,
		log: (line: string) => void,
	): void {
		log(`! ${reason}`);
		const cur = store.getTask(id);
		if (!cur || cur.cancelledAt !== null || cur.state !== "preparing") return;
		store.updateTask(id, { state: "needs_you", needsReason: reason });
	}

	/** OTTR-754: one cause line per unavailable worker url; the tmpFullLine phrase already
	 * carries the runner name and its free space, a drain names the image update. */
	function unavailableWorkerCauses(worker: WorkerTarget | null): string[] {
		const causes: string[] = [];
		for (const u of worker?.urls ?? []) {
			const host = new URL(u).hostname;
			if (ops.drainedRunner(host))
				causes.push(`${host} is drained for an image update`);
			const tmpLine = ops.tmpFullLine?.(host);
			if (tmpLine !== null && tmpLine !== undefined) causes.push(tmpLine);
		}
		return causes;
	}

	/** OTTR-754: a runner url is usable when it is not drained and its /tmp is not below
	 * the free-space limit; the limit keeps new turns off a runner that cannot hold the
	 * run's temp writes. */
	function workerUrlUsable(u: string): boolean {
		return (
			!ops.drainedRunner(new URL(u).hostname) &&
			ops.tmpFullLine?.(new URL(u).hostname) == null
		);
	}

	/** The prepared turn's workers all dropped out (drained, or /tmp below the free-space
	 * limit): park for a human instead of dispatching to a dead pool or falling back to the
	 * server. A hold that lands after this point cannot strand the turn: the update script
	 * counts every live run on the runner (the entry's url) before it recreates.
	 * True when the card parked. */
	function parkUnavailableWorkers(
		store: ProjectStore,
		id: string,
		vmTurn: boolean,
		worker: WorkerTarget | null,
		log: (line: string) => void,
	): boolean {
		if (worker === null || worker.urls.some(workerUrlUsable)) return false;
		if (vmTurn) {
			parkBeforeRun(
				store,
				id,
				"The microVM runner is drained for an image update, so the turn did not start. The update undrains it when its roll ends; reply to retry.",
				log,
			);
			return true;
		}
		// OTTR-754: the park names each runner's cause, so the card reports the
		// space problem itself instead of a generic "unavailable".
		const causes = unavailableWorkerCauses(worker);
		const why =
			causes.length > 0 ? causes.join("; ") : "no runner is available";
		parkBeforeRun(
			store,
			id,
			`Every worker is unavailable, so the turn did not start: ${why}. The update undrains a drained worker when its roll ends, and the /tmp warning clears when space returns; reply to retry.`,
			log,
		);
		return true;
	}

	/** The worker target with drained runners dropped; fail closed on an empty list
	 * (a drain landed while the turn prepared): park instead of dispatching to a drained
	 * worker or falling back to the server. Null: the turn stopped. Null `liveWorker`:
	 * a local run, the turn goes on. */
	async function gateTurnStart(
		store: ProjectStore,
		id: string,
		vmTurn: boolean,
		worker: WorkerTarget | null,
		execModel: string | null,
		log: (line: string) => void,
	): Promise<{ liveWorker: TurnLiveWorker | null } | null> {
		if (vmTurn && (worker === null || ops.vmTokens === undefined)) {
			// Fail closed: never the classic pool or the server for a microVM turn.
			parkBeforeRun(
				store,
				id,
				"MicroVM mode is on for this project, but the board has no microVM runner (OTTR_VM_RUNNER_URL). Set it, or turn microVM mode off, then reply to retry.",
				log,
			);
			return null;
		}
		if (parkUnavailableWorkers(store, id, vmTurn, worker, log)) return null;
		const liveWorker =
			worker === null
				? null
				: {
						urls: worker.urls.filter(workerUrlUsable),
						token: worker.token,
					};
		if (worker !== null && execModel === null) {
			parkBeforeRun(
				store,
				id,
				"Sign-in: no model for this worker turn. The card sets none, the saved session names none, and the board's config.yml has no default role. Pick a model on the card, or set modelRoles.default, then reply to retry.",
				log,
			);
			return null;
		}
		return { liveWorker };
	}

	/** The env values ride the run env into a worker too (the runner forwards them with the
	 * rest of the child env), so every turn gets them and every card log names a listed name
	 * that has no value. A microVM turn is lent nothing: its providers go through the board's
	 * /llm proxy, so no provider token may ride its env (a null model lends none). Null: a
	 * credential fault parked the card — fail closed, an empty error message included. */
	async function gateTurnEnv(
		name: string,
		store: ProjectStore,
		id: string,
		vmTurn: boolean,
		execModel: string | null,
		log: (line: string) => void,
	): Promise<TurnEnvValues | null> {
		const turnEnv = (await ops.turnEnv?.(name, vmTurn ? null : execModel)) ?? {
			env: {},
			missing: [],
		};
		if (turnEnv.missing.length > 0)
			log(
				`env: no value for ${turnEnv.missing.join(", ")} (set it under Settings, Env)`,
			);
		if (
			turnEnv.credentialError !== undefined &&
			turnEnv.credentialError !== null
		) {
			parkBeforeRun(
				store,
				id,
				signInNeedsReason(
					turnEnv.credentialError,
					turnEnv.busy === true,
					turnEnv.badModel,
				),
				log,
			);
			return null;
		}
		return turnEnv;
	}

	/** The previous turn died because omp could not restore the session's saved model (its
	 * provider has no sign-in on the board): an explicit --model skips that restore, so a
	 * board turn on the default role reruns with the board's default role. The card's model
	 * stays. The model that runs (and that the turn row records): a worker turn's execution
	 * model, else the restore fallback or the card's model of a local run. */
	function resolveRunModel(
		store: ProjectStore,
		id: string,
		live: Task,
		plan: TurnPlan,
		worker: WorkerTarget | null,
		execModel: string | null,
		log: (line: string) => void,
	): { restoreFailed: boolean; runModel: string | null } {
		const restoreFailed =
			live.model === null &&
			worker === null &&
			plan.resumeId !== null &&
			store.listTurns(id).at(-1)?.error?.startsWith(MODEL_RESTORE) === true;
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
		return { restoreFailed, runModel };
	}

	/** Start gate: the dispatched model's provider is out of quota with a known reset.
	 * Starting now would die at the provider's first answer, so requeue with the reset
	 * as holdUntil — the scheduler starts the card when the limit resets. A reply or
	 * steer queued meanwhile stays pending: this start consumed nothing. A cancel
	 * landing during the quota await owns the card; only a still-claimed card requeues.
	 * A queued user message is the override the hold's text promises ("Send a message
	 * to run it now"): the steer and reply routes cleared holdUntil, so only this gate
	 * would re-hold — stale quota data must not trap the user's message until the
	 * reset. Supervisor-authored pending text (a park's own instruction) waits.
	 * The last await before the spawn: a credit stop that landed in any prepare await parks
	 * the card here, before the usage-limit hold could requeue it or omp could start.
	 * True: the turn stopped. */
	async function gateUsageStart(
		store: ProjectStore,
		id: string,
		kind: TurnKind,
		live: Task,
		runModel: string | null,
		creditBlocked: () => boolean,
		log: (line: string) => void,
	): Promise<boolean> {
		const userOverride =
			live.pendingPrompt !== null && live.pendingBy !== "supervisor";
		const startHold = userOverride
			? null
			: await usageResetFor(
					runModel ?? (ops.modelRoles ?? modelRoles)().default ?? null,
				);
		if (creditBlocked()) return true;
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
			return true;
		}
		return false;
	}

	/** The microVM grant a vm-runner dispatch carries (null for every other run): the lent
	 * worker target and tokens, the card branch (vmTurn requires a branch), the repo and
	 * worktree paths, the base, and the board URL. */
	function vmGrantFor(
		name: string,
		e: TurnProject,
		id: string,
		header: TurnHeader,
		loc: RunLocation,
		route: TurnRoute,
	): {
		target: TurnLiveWorker;
		tokens: VmTokens;
		grant: {
			project: string;
			taskId: string;
			branch: string;
			repoPath: string;
			worktree: string;
		};
		base: string;
		boardUrl: string;
	} | null {
		return route.vmTurn &&
			route.liveWorker !== null &&
			ops.vmTokens !== undefined
			? {
					target: route.liveWorker,
					tokens: ops.vmTokens,
					grant: {
						project: name,
						taskId: id,
						branch: loc.special ? "" : loc.branch, // vmTurn requires a branch
						repoPath: e.path,
						worktree: loc.wt,
					},
					base: header.base,
					boardUrl: ops.board.url,
				}
			: null;
	}

	/** The options object one turn's agent run starts with: identity, location, prompt and
	 * images, routing, metering, and the live progress/session entries. */
	function turnRunStartOptions(
		ops: TurnOps,
		runMeter: ReturnType<OpenRunMeter>,
		name: string,
		e: TurnProject,
		id: string,
		header: TurnHeader,
		loc: RunLocation,
		input: TurnInput,
		route: TurnRoute,
		idn: TurnIdentity,
		store: ProjectStore,
		kind: TurnKind,
		mx: TurnRunShared,
		marks: Record<string, string>,
	): Parameters<TurnOps["startRun"]>[0] {
		return {
			meter: ops.hosted !== undefined,
			auditProvisioned: (sinceMs, rulesAtStart) =>
				auditProvisioned(homedir(), sinceMs, rulesAtStart),
			rulesAtStart: () => rulesDirEntries(homedir()),
			...(runMeter !== null && { onUsage: runMeter.onUsage }),
			cwd: loc.wt,
			prompt: input.prompt,
			images: input.imagePaths,
			// OTTR-693: the identity this turn's git commits with when its home config names none.
			commitIdentity: ops.commitIdentity?.() ?? null,
			sessionDir: store.sessionsDir,
			extensionPath: ops.extensionPath,
			board: idn.retroCard ? null : { ...ops.board, project: name, taskId: id },
			resumeId: input.plan.resumeId,
			model: route.runModel,
			sessionName: idn.sessionName,
			worker: route.vmTurn ? null : route.liveWorker,
			vm: vmGrantFor(name, e, id, header, loc, route),
			secrets: route.turnEnv.secrets,
			// Retro flags: the retro.yml config sits next to the tracker extension, the
			// skill is pinned, and the board env is stripped (the proposal files here).
			// A review run gets OTTR_REVIEW=1: the extension then registers propose_task,
			// and the findings are recorded, not filed — Ottr files them after the run.
			env: {
				...route.turnEnv.env,
				...marks,
				// PATH last, so an env.txt value can never shadow the tools link dir.
				...(route.prep?.pathDir
					? { PATH: `${route.prep.pathDir}:${process.env.PATH ?? ""}` }
					: {}),
				// No git host auth for any agent, merge turns included (D6): the server
				// pushes non-GitHub merges itself after the turn.
			},
			stripBoard: idn.retroCard,
			stripGithubToken: idn.scout,
			...turnRunTools(idn),
			dataRoot: store.dataRoot,
			logPath: store.logPath(id),
			onLog: () => ops.notifyLog(name, id),
			onProgress: (text) => dispatchProgressEntry(mx, ops, text),
			onSession: (sid) => dispatchSessionEntry(store, id, kind, sid),
			// A review run stores each finding the moment the runner parses it (the
			// spec's arrival persistence); other cards store nothing.
			...(idn.reviewCard && {
				onRecorded: (finding: RecordedFinding) => {
					store.appendReviewFinding(id, finding);
				},
			}),
		};
	}

	/** OTTR-708: work turns that receive workPrompt (work and research cards; the
	 * interview, grill, scout, board-check, release, and retro variants take other
	 * prompts) snapshot every other project's main checkout and re-check it at settle:
	 * the agent must not touch another project's checkout. */
	function checkoutGuardApplies(kind: TurnKind, idn: TurnIdentity): boolean {
		return (
			kind === "work" &&
			!idn.releaseCard &&
			!idn.interview &&
			!idn.retroCard &&
			!idn.boardCheck &&
			!idn.grill &&
			!idn.scout
		);
	}

	/** The run's live progress entry: only a movement of the numbers is live activity; a
	 * repeated line (elapsed ticks of a frozen run, a lock wait) proves nothing and must not
	 * reset the silent-log clock (ALAT-23). */
	function dispatchProgressEntry(
		mx: TurnRunShared,
		ops: TurnOps,
		text: string | null,
	): void {
		if (mx.entry === null) return;
		const key = text === null ? null : progressKey(text);
		if (key !== null && key !== mx.entry.progressKey)
			mx.entry.progressAt = Date.now();
		mx.entry.progressKey = key ?? undefined;
		mx.entry.progress = text ?? undefined;
		ops.publishSoon();
	}

	/** The run's session entry: a session id only lands while the card still reads preparing
	 * and uncancelled; the first work run of a todo card moves the stage. */
	function dispatchSessionEntry(
		store: ProjectStore,
		id: string,
		kind: TurnKind,
		sid: string,
	): void {
		const cur = store.getTask(id);
		if (cur?.state !== "preparing" || cur.cancelledAt !== null) return;
		store.updateTask(id, {
			sessionId: sid,
			state: "running",
			...(kind === "work" && cur.stage === "todo"
				? { stage: "in_progress" }
				: {}),
		});
	}

	/** Starts the agent run (startRun), claims its slot in `running`, waits out a microVM
	 * busy answer, consumes this turn's pending text and images, and records the turn row.
	 * Null: vm-runner answered busy — the card went back to the queue untouched. */
	async function dispatchTurnRun(
		name: string,
		e: TurnProject,
		store: ProjectStore,
		id: string,
		task: Task,
		key: string,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		input: TurnInput,
		route: TurnRoute,
		mx: TurnRunShared,
		openMeter: OpenRunMeter,
		log: (line: string) => void,
	): Promise<TurnDispatch | null> {
		// The HTTP-400 correlation window: from just before the omp spawn to the run's end.
		const runStartedAt = Date.now();
		// OTTR-708: work turns that receive workPrompt (work and research cards; the
		// interview, grill, scout, board-check, release, and retro variants take other
		// prompts) snapshot every other project's main checkout and re-check it at settle:
		// the agent must not touch another project's checkout.
		const checkoutGuard = checkoutGuardApplies(kind, idn);
		if (checkoutGuard)
			mx.guardBefore = await snapshotOtherCheckouts(projects, ops, name);
		// The work or merge run resolves its model from the default role, also when the card
		// or session names its own model (docs/specs/hosted-mode.md section 4). It is the
		// turn's main run: its final record carries the card outcome and title (M10).
		const runMeter = openMeter("default", true);
		// A retro, review or scout run carries its env marks (a retro or review adds
		// OTTR_MODELS: its proposal files past the card-filing routes' catalog check,
		// so propose_task must check at record time). Awaited only for these rare
		// turns; a work turn's spawn path stays synchronous.
		const marks =
			idn.retroCard || idn.reviewCard || idn.scout
				? await retroEnvMarks(idn)
				: {};
		const handle = ops.startRun(
			turnRunStartOptions(
				ops,
				runMeter,
				name,
				e,
				id,
				header,
				loc,
				input,
				route,
				idn,
				store,
				kind,
				mx,
				marks,
			),
		);
		mx.entry = handle;
		running.set(key, mx.entry);
		// Awaited only where the original awaited (a microVM dispatch): the sync path must
		// not yield, so a pid that fills in a later microtask is still null at startTurn.
		if (route.vmTurn && handle.accepted !== undefined) {
			const ok = await vmAcceptance(store, id, task, key, handle, log);
			if (!ok) return null;
		}
		consumeTurnPending(store, id, input);
		const turn = recordTurnRow(
			store,
			id,
			kind,
			input,
			route,
			mx,
			handle,
			header,
			runStartedAt,
		);
		return { handle, runMeter, runStartedAt, turn };
	}

	/** Waits for vm-runner to take a microVM turn before anything records it: a busy answer
	 * must leave the card exactly as it was before the claim (no turn row, the reply still
	 * pending, no lost-worker count). Any other non-start (refused, unreachable, killed) falls
	 * through and settles like today's worker dispatch. False: busy — the caller stops. */
	async function vmAcceptance(
		store: ProjectStore,
		id: string,
		task: Task,
		key: string,
		handle: TurnRunHandle,
		log: (line: string) => void,
	): Promise<boolean> {
		if (handle.accepted === undefined) return true;
		const started = await handle.accepted;
		const early = started ? null : ((await handle.done) as RunResult);
		if (early?.workerBusy !== true) {
			vmState.busy.delete(key);
			vmBusyAt.delete(key);
			return true;
		}
		running.delete(key);
		vmState.busy.add(key);
		vmBusyAt.set(key, Date.now());
		log(`- ${WORKER_BUSY}; the card waits in the queue for a free microVM`);
		const cur = store.getTask(id);
		// A cancel or stop that landed meanwhile owns the card.
		if (cur && cur.cancelledAt === null && cur.state === "preparing")
			store.updateTask(id, {
				state: "queued",
				needsReason: task.needsReason,
				asked: task.asked,
			});
		ops.publishSoon();
		return false;
	}

	/** Consumes only what this turn sends; steering that landed since the build stays queued
	 * for the next one. The column holds the raw parked text (raw, e.g. the dep-hold marker);
	 * pending may be the dispatcher's swap of it, so strip by raw — a mismatched strip would
	 * re-steer forever. The steer route appends with "\n\n", so only raw itself or raw plus
	 * that separator is this turn's text: a cancelled steer replaced by one that merely starts
	 * with raw stays whole. Same prefix rule for images: a steer landing since the build
	 * appends, so drop only what this turn sends. */
	function consumeTurnPending(
		store: ProjectStore,
		id: string,
		input: TurnInput,
	): void {
		const fresh = store.getTask(id);
		let rest = fresh?.pendingPrompt ?? null;
		if (input.raw !== null && input.pending !== null && rest !== null) {
			if (rest === input.raw) rest = null;
			else if (rest.startsWith(`${input.raw}\n\n`))
				rest = rest.slice(input.raw.length + 2) || null;
		}
		const restImages = stripConsumedImages(fresh, input);
		store.updateTask(id, {
			pendingPrompt: rest,
			pendingImages: restImages,
			// rest holds only steering that landed mid-run (user); a full consume clears.
			pendingBy: rest === null ? null : "user",
		});
	}

	/** Same prefix rule for images as for the prompt text: a steer landing since the build
	 * appends, so drop only what this turn sends. */
	function stripConsumedImages(fresh: Task | null, input: TurnInput): string[] {
		let restImages = fresh?.pendingImages ?? [];
		if (
			restImages.length >= input.live.pendingImages.length &&
			input.live.pendingImages.every((n, i) => restImages[i] === n)
		)
			restImages = restImages.slice(input.live.pendingImages.length);
		return restImages;
	}

	/** Records the turn row: the user text this turn delivered (steer or reply — the timeline
	 * shows it on the turn; a fresh session that folded the reply into its prompt records it
	 * here too; the "." continue marker is not user text), the dispatch snapshot of the
	 * --model, the pending text's authorship, the layer this run pinned at start, and the
	 * card-log byte offset captured with the header write. */
	function recordTurnRow(
		store: ProjectStore,
		id: string,
		kind: TurnKind,
		input: TurnInput,
		route: TurnRoute,
		mx: TurnRunShared,
		handle: TurnRunHandle,
		header: TurnHeader,
		runStartedAt: number,
	): Turn {
		const turnInput =
			input.pending &&
			(input.plan.resumeId !== null ||
				(input.plan.note !== null && input.pending !== "."))
				? input.pending
				: null;
		const turn = store.startTurn(
			id,
			kind,
			input.prompt,
			handle.pid,
			// The user text this turn delivered (steer or reply) — the timeline shows it on the turn.
			// A fresh session that folded the reply into its prompt records it here too; the "."
			// continue marker is not user text.
			turnInput,
			// The dispatch snapshot: the --model this turn starts with, so the card states the
			// selected model while it runs; the settled row keeps what the stream served.
			route.runModel,
			// live was read with raw, so its pendingBy is raw's authorship (a mid-run steer
			// lands after this read and rides the next turn).
			turnInput !== null ? input.live.pendingBy : null,
			// The layer this run pinned at start (null = flat home); a record only, clean-up reads in-use.json.
			handle.layerId ?? null,
			// The card-log byte offset captured with the header write; the drawer fetches the turn's section from it.
			header.turnLogOffset,
			// The row's window starts at the dispatch start: the guard attributes a change to
			// every turn whose true run window holds it, and startRun's caller may commit
			// before this row is written (OTTR-772).
			runStartedAt,
		);
		mx.turn = turn;
		return turn;
	}

	/** The env marks a retro, review or scout run carries (the extension registers its
	 * per-kind tools from them; the board env is stripped for a retro, whose proposal
	 * files here). A retro also carries the board's project names: the proposal's
	 * project check must fail the call with the list, not the settle (OTTR-787). A
	 * retro and a review carry the board's model catalog (OTTR_MODELS): their
	 * proposals file after the run, past the card-filing routes' catalog check, so
	 * propose_task must apply the full model rule at record time. */
	async function retroEnvMarks(
		idn: TurnIdentity,
	): Promise<Record<string, string>> {
		if (idn.retroCard)
			return {
				OTTR_RETRO: "1",
				OTTR_PROJECTS: [...projects.keys()].join("\n"),
				...(await retroModelsEnv()),
			};
		if (idn.reviewCard)
			return { OTTR_REVIEW: "1", ...(await retroModelsEnv()) };
		if (idn.scout) return { OTTR_TRENDING: "1" };
		return {};
	}

	/** OTTR_MODELS for a retro or review run: the catalog selectors, newline
	 *  separated. Absent when the board cannot read the catalog (an empty list):
	 *  propose_task then checks the selector's shape only. */
	async function retroModelsEnv(): Promise<Record<string, string>> {
		const list = await (ops.modelList ?? modelList)();
		return list.length === 0
			? {}
			: { OTTR_MODELS: list.map((m) => m.selector).join("\n") };
	}

	/** The pinned per-kind run config: the retro skill and yml, the scout's two verdict
	 * tools and yml, else the run keeps the default tools and no config. */
	function turnRunTools(idn: TurnIdentity): {
		tools?: string;
		config?: string;
		skills?: string;
	} {
		if (idn.retroCard)
			return {
				tools: "read,grep,glob,report_outcome,propose_task",
				config: join(dirname(ops.extensionPath), "retro.yml"),
				skills: "retro",
			};
		if (idn.scout)
			return {
				tools: "read,grep,glob,report_outcome,propose_repo,judge_repo",
				config: join(dirname(ops.extensionPath), "trending.yml"),
			};
		return {};
	}

	/** Settles the finished run: outcome sync, report read, tree analysis, shot adoption,
	 * merge ship, classify, hold parks, card writes, and the two second-model checks. True:
	 * the turn stopped early (a cancel, a taken-over check, a credit stop) — runTurn returns. */
	async function settleTurnRun(
		name: string,
		e: TurnProject,
		id: string,
		task: Task,
		key: string,
		kind: TurnKind,
		header: TurnHeader,
		idn: TurnIdentity,
		loc: RunLocation,
		input: TurnInput,
		route: TurnRoute,
		dispatch: TurnDispatch,
		mx: TurnRunShared,
		openMeter: OpenRunMeter,
		creditBlocked: () => boolean,
	): Promise<boolean> {
		// RunEntry.done is Promise<unknown> for test fakes; the real handle resolves a RunResult.
		const result0 = (await dispatch.handle.done) as RunResult;
		const st: TurnSettle = {
			name,
			id,
			key,
			kind,
			e,
			store: e.store,
			task,
			header,
			idn,
			loc,
			input,
			route,
			dispatch,
			mx,
			openMeter,
			creditBlocked,
			log: (line) => appendLog(e.store, id, line),
			result: result0,
			vmOut: null,
			runEndedAt: 0,
			reportText: null,
			reportError: null,
			wasResearch: false,
			demoteCandidate: false,
			fromMain: false,
			finishedCleanly: false,
			shots: undefined,
			pushError: null,
			pushRejected: false,
			pushOutput: null,
			recheckError: null,
			holdHead: null,
			holdMismatch: null,
			holdDiff: null,
			holdFiles: null,
			holdTip: null,
			remoteLanded: false,
			refused: null,
			prNext: null,
			research: false,
			steered: false,
			now: 0,
			unsaved: null,
			report: undefined,
			steps: undefined,
			commits: undefined,
			mergeHead: undefined,
			keptFiles: undefined,
			holdReason: null,
			holdPark: null,
			workCard: false,
			reviewFindings: [],
			checkWillRun: false,
		};
		if (await readTurnOutcome(st, result0)) return true;
		readRunReport(st, result0);
		running.delete(key);
		if (await settleKilledRun(st)) return true;
		await analyzeTurnTree(st);
		await adoptTurnShots(st);
		await quarantineUntrackedFiles(st);
		await shipMergeTurn(st);
		const { facts, next } = await classifyTurnEnd(st);
		const recovered = await recoverMergePush(st, next);
		const stabilized = await stabilizeNext(st, facts, recovered);
		const guarded = await guardUiShot(st, stabilized);
		const planned = await planSettleWrite(st, guarded);
		await recordSyncFindings(st);
		if (await finishTurnRow(st, planned)) return true;
		planTurnChecks(st, planned);
		writeSettledCard(st, planned);
		await fileRetroProposal(st, planned);
		if (await runReviewCheck(st)) return true;
		if (await runWorkCheck(st, planned)) return true;
		writePostCheckState(st, planned);
		await stampDoneCard(st, planned);
		return false;
	}

	/** Awaits the run's result, settles its metering, and syncs a microVM's tree state into
	 * the server worktree. True: a late resolution after sweepLostTurns took over — the sweep
	 * owns the card, the turn stops. */
	async function readTurnOutcome(
		st: TurnSettle,
		result0: RunResult,
	): Promise<boolean> {
		st.dispatch.runMeter?.settle(result0);
		st.runEndedAt = Date.now();
		// sweepLostTurns proved the pid dead and settled this turn's row; a late resolution must
		// not settle again or clobber the card the sweep requeued.
		if (st.mx.entry?.abandoned) return true;
		await syncVmWorktree(st, result0);
		return false;
	}

	/** OTTR-532: a microVM turn's tree lives in the VM. The server worktree follows the branch
	 * tip in the main checkout (the git endpoint already syncs every push; this covers a push
	 * whose sync failed), and the tree state comes from the VM's own report. The head the VM
	 * reports is a claim, never a reset target: the worktree only ever moves to the real tip
	 * of the card's branch. Uncommitted files the turn leaves for the board (the research
	 * report, shots) never ride a push: the sentinel carries them, before the report read. */
	async function syncVmWorktree(
		st: TurnSettle,
		result0: RunResult,
	): Promise<void> {
		const vmOut = st.route.vmTurn ? (result0.vm ?? null) : null;
		st.vmOut = vmOut;
		if (vmOut === null) return;
		if (vmOut.pushError !== null)
			st.log(`! microVM push failed: ${vmOut.pushError}`);
		// The card run always holds a branch name here: vmTurn requires a non-special card.
		const branch = st.loc.special ? (st.task.branch ?? "") : st.loc.branch;
		await syncVmTip(st, branch, vmOut);
		// Uncommitted files the turn leaves for the board (the research report, shots)
		// never ride a push: the sentinel carries them, before the report read below.
		if (vmOut.files) writeVmFiles(st.loc.wt, vmOut.files, st.log);
	}

	/** The branch-tip read a microVM settle syncs against: log a reported head that is not the
	 * tip, and move the server worktree to the real tip when it lags. */
	async function syncVmTip(
		st: TurnSettle,
		branch: string,
		vmOut: VmOutcome,
	): Promise<void> {
		const tip =
			branch === null
				? null
				: await ops
						.targetSha(st.e.path, `refs/heads/${branch}`)
						.catch(() => null);
		if (vmOut.head !== null && tip !== null && vmOut.head !== tip)
			st.log(
				`! microVM: reported head ${vmOut.head} is not the branch tip ${tip}`,
			);
		if (tip === null)
			st.log(
				`! microVM: branch ${branch ?? "(none)"} does not resolve; the worktree is not synced`,
			);
		else if (ops.syncWorktreeTo) {
			const syncTo = ops.syncWorktreeTo;
			const current = await ops.targetSha(st.loc.wt, "HEAD").catch(() => null);
			if (current !== tip)
				await syncTo(st.loc.wt, tip).catch((err: unknown) =>
					st.log(
						`! microVM: syncing the worktree to ${tip} failed: ${errmsg(err)}`,
					),
				);
		}
	}

	/** The agent self-declares research by writing the report file; its presence at settle flips
	 * the card. Sync read: settle must stay within one microtask flush (tests await runTurn or
	 * flush microtasks only). No symlink is followed: a worker could point the file at a
	 * server-only secret (OTTR-233). */
	function readRunReport(st: TurnSettle, result0: RunResult): void {
		const report = readReportFile(st);
		// First capture wins: persist the report the moment it is read, so any settle that
		// can read the file keeps its text even when the turn parks before the card write.
		if (report.text !== null && st.task.report === null)
			st.store.updateTask(st.id, { report: report.text });
		const autoResearch =
			!st.idn.releaseCard && !st.task.research && report.text !== null;
		if (autoResearch) st.store.updateTask(st.id, { research: true });
		const wasResearch = st.task.research || autoResearch;
		// A research card's later turn can do real work: a ready outcome, landable clean
		// commits, and no report file (it cleared the file it once self-declared with). The
		// demotion needs the git facts below, so the rewrite waits for that case.
		st.demoteCandidate =
			wasResearch &&
			!st.idn.interview &&
			!st.idn.grill &&
			!st.idn.releaseCard &&
			report.text === null &&
			report.error === null &&
			result0.outcome?.status === "ready";
		// An interview or trending scout card has nothing to integrate, and agents mix up
		// statuses: a ready outcome settles done.
		// A research card has nothing to integrate either: its deliverable is the report file.
		st.result =
			(st.idn.interview || st.idn.scout || wasResearch) &&
			!st.demoteCandidate &&
			result0.outcome?.status === "ready"
				? {
						...result0,
						outcome: { ...result0.outcome, status: "answered" as const },
					}
				: result0;
		st.reportText = report.text;
		st.reportError = report.error;
		st.wasResearch = wasResearch;
	}

	/** Reads the research report file out of the worktree (work cards only). A refused report
	 * (symlink, not a file, too big) holds the card: no quarantine, no removal. */
	function readReportFile(st: TurnSettle): {
		text: string | null;
		error: string | null;
	} {
		if (
			!(
				st.kind === "work" &&
				!st.idn.interview &&
				!st.idn.grill &&
				!st.idn.scout
			)
		)
			return { text: null, error: null };
		try {
			return {
				text:
					readBelow(
						worktreeAnchor(st.e.path, st.loc.wt),
						join(st.loc.wt, RESEARCH_REPORT),
						REPORT_MAX_BYTES,
					)?.toString("utf8") ?? null,
				error: null,
			};
		} catch (err) {
			const error = errmsg(err);
			st.log(`! ${RESEARCH_REPORT}: ${error}`);
			return { text: null, error };
		}
	}

	/** A stop-turn request owns this kill: end the row as stopped and park the card like Esc —
	 * worktree, branch and session stay, the user replies. True: the turn stops. */
	async function settleKilledRun(st: TurnSettle): Promise<boolean> {
		if (!st.result.killed && !st.store.getTask(st.id)?.cancelledAt)
			return false;
		const stopReason = stopping.get(st.key);
		stopping.delete(st.key);
		st.store.finishTurn(st.dispatch.turn.id, {
			endedAt: Date.now(),
			exitCode: st.result.exitCode,
			error: stopReason !== undefined ? "stopped" : "cancelled",
		});
		// A cancel that landed meanwhile owns the card: cancelTask writes its kept
		// or idle state after the kill, so only mark the card when no cancel ran.
		const cur = st.store.getTask(st.id);
		if (stopReason !== undefined && cur && cur.cancelledAt === null)
			st.store.updateTask(st.id, {
				state: "needs_you",
				needsReason: stopReason,
			});
		return true;
	}

	/** ponytail: after an agent removes its worktree, an empty folder can stay (omp's cwd holds
	 * it on Windows), and git there reads the main checkout: another card's unpushed merge
	 * fails `integrated`, and base..HEAD counts main's commits. Upgrade: read the task branch
	 * from the main repo when `<worktree>/.git` is gone. A husk (unlinked, no checkout) cannot
	 * speak for HEAD at all: when the branch is also gone or already contained in the target,
	 * "integrated" is provable from the main repo alone. */
	async function analyzeTurnTree(st: TurnSettle): Promise<void> {
		const husk =
			st.idn.interview || st.idn.grill || st.idn.scout
				? false
				: await ops.worktreeHusk(st.loc.wt).catch(() => false);
		// A deregistered worktree can lose its `.git` file while keeping the checkout: then neither
		// worktreeLinked (git climbs out) nor worktreeHusk's `.git`-file test fires. isIntegrated
		// returns false unconditionally there, so a merged card would bounce forever; the branch
		// inside the main repo is the proof (branchMergedOrGone).
		const unlinked =
			!st.idn.interview &&
			!st.idn.grill &&
			!st.idn.scout &&
			!husk &&
			!(await ops.worktreeLinked(st.loc.wt).catch(() => false));
		st.fromMain = husk || unlinked;
		st.finishedCleanly =
			st.result.exitCode === 0 &&
			st.result.sawTerminalEnd &&
			!st.result.killed &&
			!st.result.approvalRefused &&
			st.result.asked === null &&
			st.result.outcome?.status !== "needs_you";
	}

	/** Copy agent-reported UI screenshots into the task's images dir, before the
	 * untracked-file quarantine and unsavedWork touch the worktree. Until 2026-10-09 the
	 * tracker extension's report_outcome schema had no shots field, so the harness
	 * dropped every reported shot; a plain work turn whose outcome carries no shots
	 * still adopts the conventional shots/ directory. Never fails the turn. The copy
	 * only reads the worktree: sources stay put, so committed shots keep the tree clean
	 * for the ready gate's isClean read below (deleting them turned tracked files into
	 * ` D` rows and bounced the turn). Adoption skips git-tracked shots: a committed
	 * shot rides every fresh worktree, so adopting it pinned a leftover image on cards
	 * whose agents never captured anything (the 2026-10-14 incident). Scratch shots
	 * under the gitignored /shots/ and root /*.png paths stay on disk unseen (worktree
	 * removal GCs them); other untracked scratch shots are swept afterwards by the
	 * quarantine.
	 * Dedup by content: agents re-report the same screenshots (the same path twice in one
	 * outcome, or again on a later turn of the same card), and each copy used to land as a
	 * fresh numbered file. Seed with what the card has. */
	async function adoptTurnShots(st: TurnSettle): Promise<void> {
		if (!st.result.outcome) return;
		const seen = new Set<string>();
		const stored: { name: string; gray: Uint8Array }[] = [];
		seedStoredShots(st, seen, stored);
		const reported = st.result.outcome.shots ?? [];
		const copied: DecodedImage[] = [];
		// Grays of this run's new copies: a second capture of the same new screen
		// in one outcome skips too, instead of landing as a fresh numbered file.
		const batch: Uint8Array[] = [];
		for (const [shot, p] of await shotCandidates(st, reported)) {
			try {
				await adoptShot(st, seen, stored, batch, copied, shot, p);
			} catch (err) {
				st.log(`! shot ${shot}: ${err instanceof Error ? err.message : err}`);
			}
		}
		if (copied.length > 0) {
			const names = saveImages(
				st.store.dataRoot,
				st.store.imagesDir(st.id),
				copied,
			);
			st.shots = [...st.task.shots, ...names].slice(-8); // cap 8, keep newest
		}
	}

	/** Seeds the dedup state with what the card already stores; pruned or absent shots
	 * contribute nothing. */
	function seedStoredShots(
		st: TurnSettle,
		seen: Set<string>,
		stored: { name: string; gray: Uint8Array }[],
	): void {
		for (const name of st.task.shots) {
			try {
				const bytes = readRegular(join(st.store.imagesDir(st.id), name));
				seen.add(createHash("sha256").update(bytes).digest("hex"));
				const gray = pngGray16(bytes);
				if (gray !== null) stored.push({ name, gray });
			} catch {
				// pruned or absent: nothing to dedup against
			}
		}
	}

	/** The shot paths to adopt: the outcome's reported shots, else (a plain work turn) the
	 * untracked files under the gitignored shots/ directory. */
	async function shotCandidates(
		st: TurnSettle,
		reported: string[],
	): Promise<[string, string][]> {
		if (reported.length > 0)
			return reported.map((shot) => [shot, resolve(st.loc.wt, shot)]);
		if (
			st.kind === "work" &&
			!st.idn.interview &&
			!st.idn.grill &&
			!st.idn.scout &&
			!st.wasResearch &&
			!st.idn.releaseCard &&
			existsSync(join(st.loc.wt, "shots"))
		) {
			const tracked = new Set(await ops.trackedFiles(st.loc.wt, "shots"));
			return readdirSync(join(st.loc.wt, "shots"), { withFileTypes: true })
				.filter((d) => d.isFile() && !tracked.has(`shots/${d.name}`))
				.map((d) => [`shots/${d.name}`, join(st.loc.wt, "shots", d.name)]);
		}
		return [];
	}

	/** Adopts one candidate shot: path-escape and sniff checks, byte-exact dedup against the
	 * card's stored shots, and the visual-twin check below. Throws on an unreadable file —
	 * the caller's catch logs it and keeps the turn green. */
	async function adoptShot(
		st: TurnSettle,
		seen: Set<string>,
		stored: { name: string; gray: Uint8Array }[],
		batch: Uint8Array[],
		copied: DecodedImage[],
		shot: string,
		p: string,
	): Promise<void> {
		if (!p.startsWith(resolve(st.loc.wt) + sep)) {
			st.log(
				`! shot ${shot}: path escapes the worktree — keep the path inside the worktree, for example shots/<name>.png (shots/ is gitignored)`,
			);
			return;
		}
		const bytes = readBelow(
			worktreeAnchor(st.e.path, st.loc.wt),
			p,
			MAX_IMAGE_BYTES,
		);
		if (bytes === null) throw new Error("no such file");
		const ext = sniffImage(bytes);
		if (ext === null) {
			st.log(`! shot ${shot}: not a recognized image`);
			return;
		}
		const hash = createHash("sha256").update(bytes).digest("hex");
		if (seen.has(hash)) {
			st.log(`! shot ${shot}: duplicate of an existing screenshot`);
			return;
		}
		const gray = pngGray16(bytes);
		if (gray === null) {
			// Undecodable (jpg, webp, exotic png): byte-exact dedup only.
			seen.add(hash);
			copied.push({ bytes, ext });
			return;
		}
		if (adoptVisualTwin(st, stored, batch, gray, bytes, shot)) return;
		seen.add(hash);
		copied.push({ bytes, ext });
		batch.push(gray);
	}

	/** A re-capture of an unchanged screen (new bytes, same pixels) matches an existing shot
	 * visually and replaces it, so a check send-back round does not double every screenshot on
	 * the card. True: the shot was a twin (stored, or saved this turn) — nothing to copy. */
	function adoptVisualTwin(
		st: TurnSettle,
		stored: { name: string; gray: Uint8Array }[],
		batch: Uint8Array[],
		gray: Uint8Array,
		bytes: Uint8Array,
		shot: string,
	): boolean {
		const twin = stored.findIndex((s) => visuallyIdentical(s.gray, gray));
		const twinShot = stored[twin];
		const batchTwin =
			twinShot === undefined
				? batch.findIndex((g) => visuallyIdentical(g, gray))
				: -1;
		if (twinShot !== undefined) {
			// Same screen, new bytes: refresh the stored shot in place
			// instead of appending a second copy of it.
			writeBelow(
				st.store.dataRoot,
				join(st.store.imagesDir(st.id), twinShot.name),
				bytes,
				"truncate",
			);
			stored[twin] = { name: twinShot.name, gray };
			st.log(
				`! shot ${shot}: visually identical to ${twinShot.name} — replaced it`,
			);
			return true;
		}
		if (batchTwin !== -1) {
			st.log(`! shot ${shot}: visually identical to a shot saved this turn`);
			return true;
		}
		return false;
	}

	/** Sweeps untracked scratch files a clean work turn leaves behind (never for a research,
	 * release or special card, and only after a clean finish with a readable report). */
	async function quarantineUntrackedFiles(st: TurnSettle): Promise<void> {
		if (
			!(
				st.kind === "work" &&
				!st.idn.interview &&
				!st.idn.grill &&
				!st.idn.scout &&
				!st.wasResearch &&
				!st.idn.releaseCard &&
				st.finishedCleanly &&
				st.reportError === null
			)
		)
			return;
		try {
			const moved = await ops.quarantineUntracked(
				st.loc.wt,
				join(st.store.tasksDir, "quarantine", st.id),
				st.store.dataRoot,
			);
			if (moved.length > 0)
				appendLog(
					st.store,
					st.id,
					`quarantined ${moved.length} untracked file(s) to .tasks/quarantine/${st.id}: ${moved.slice(0, 20).join(", ")}${moved.length > 20 ? " …" : ""}`,
				);
		} catch (err) {
			appendLog(st.store, st.id, `quarantine failed: ${errmsg(err)}`);
		}
	}

	/** Per-host git credentials never enter an agent, so the server pushes a merge itself.
	 * It runs before the integration facts: the check reads origin's tip, which only this
	 * push moves. It is gated on proof of the local merge in the main repo, never on what
	 * the agent reported. A removed worktree (fromMain) still pushes: its merge is on the
	 * local branch, and only this push moves it to origin. */
	async function shipMergeTurn(st: TurnSettle): Promise<void> {
		if (
			st.kind !== "merge" ||
			st.idn.interview ||
			st.idn.grill ||
			st.idn.releaseCard
		)
			return;
		if (st.header.settings.prMode === true) await shipPrCard(st);
		else await auditMergeHold(st);
	}

	/** Appends the GitHub-API hint under a bare 401/403; the git error stands alone
	 * when the probe cannot say more. Never throws. */
	async function withAuthHint(url: string, error: string): Promise<string> {
		if (!GIT_HTTP_AUTH_STATUS.test(error)) return error;
		try {
			return error + ((await ops.githubAuthHint(url)) ?? "");
		} catch {
			return error;
		}
	}

	/** The merge push and the OTTR-510 automatic rebase retry push through the same helper.
	 * `refused` stays null for every non-merge turn: only a merge settle pays for the hold-tip
	 * read. */
	async function serverPush(
		st: TurnSettle,
	): Promise<
		| { status: "skipped" }
		| { status: "pushed"; output: string }
		| { status: "failed" | "rejected"; error: string; output?: string }
	> {
		return st.refused !== null
			? Promise.resolve({
					status: "failed" as const,
					error: st.refused,
				})
			: ops
					.serverMergePush(
						st.e.path,
						st.loc.wt,
						st.header.target,
						st.task.branch ?? "",
						st.holdTip,
						st.header.settings.originUrl,
					)
					.then(async (p) =>
						(p.status === "failed" || p.status === "rejected") &&
						typeof st.header.settings.originUrl === "string" &&
						st.header.settings.originUrl !== ""
							? {
									...p,
									error: await withAuthHint(
										st.header.settings.originUrl,
										p.error,
									),
								}
							: p,
					)
					.catch((err: unknown) => ({
						status: "failed" as const,
						error: errmsg(err),
					}));
	}

	/** PR mode ships the card branch itself: the server pushes the branch and opens the
	 * pull request, so nothing local is ever pushed to the target — the merge-hold
	 * machinery and serverMergePush of the target must not run for these cards.
	 * The ship step settles an integrated report and nothing else: the PR prompt
	 * rebases before the gates and the security review, so a clean rebased tree
	 * alone proves nothing about their verdict. A needs_you report (a blocking
	 * finding, a failed gate) must reach classify and park with the agent's
	 * question — prNext stays null so classify decides. A queued merge turn on a
	 * PR-carrying card re-ships (OTTR-799): the branch push updates the same PR or
	 * opens a fresh one after a close, and the stored PR fields and pushSha pin
	 * the new head. */
	async function shipPrCard(st: TurnSettle): Promise<void> {
		const outcome = st.result.outcome;
		if (outcome?.status !== "integrated") {
			if (outcome === null)
				// A lost receipt must not land via classify's git-integrated done
				// path: nothing was merged, so ask for a human instead.
				st.prNext = {
					stage: "merging",
					state: "needs_you",
					needsReason: "The agent finished without calling report_outcome.",
				};
			return;
		}
		if (st.task.sourcePrNumber !== null) {
			// OTTR-760: a card filed from an existing pull request never opens a
			// second one; the source PR is the card's PR of record.
			await shipSourcePrCard(st, st.task.sourcePrNumber, storedSourcePr(st));
			return;
		}
		// OTTR-781: a Dependabot card filed before the source PR fields existed names
		// its PR in the prompt's first line; adopt that PR instead of opening a
		// duplicate one at ship time.
		const legacy = await resolveLegacyDependabotPr(st);
		if (legacy.kind === "parked") return;
		if (legacy.kind === "match") {
			await shipSourcePrCard(st, legacy.n, legacy.src);
			return;
		}
		// "none": not a legacy Dependabot card for this repo — fall through to openPullRequest.
		const pushBranch = ops.pushBranch;
		const openPr = ops.openPr;
		if (pushBranch === undefined || openPr === undefined) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason:
					"PR mode is on but the server's ship step is not wired; restart the board",
			};
			return;
		}
		await openPullRequest(st, pushBranch, openPr);
	}

	/** Ships a card filed from an existing pull request (OTTR-760): the card never opens a
	 * second PR. A clean bump — the branch holds exactly the source PR's content — adopts
	 * the source PR (prNumber/prUrl take its values) and the tracker waits on GitHub like
	 * on any PR-mode card. Fixes beyond the PR head must land on the PR's own head branch;
	 * a push happens only when that branch lives on origin and Dependabot does not own it
	 * (the bot abandons a PR once someone else pushes to it) — else the ship comments on
	 * the PR and parks the card with the reason. */
	async function shipSourcePrCard(
		st: TurnSettle,
		n: number,
		src: SourcePrRef,
	): Promise<void> {
		const prBranch = st.task.branch ?? "";
		const head = src.headSha;
		if (head === null) {
			// Filing always writes the head sha with the number; null is a corrupt row.
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `Source PR #${n} has no head sha on the card; file the card again`,
			};
			return;
		}
		const tip = await ops
			.targetSha(st.e.path, `refs/heads/${prBranch}`)
			.catch(() => null);
		if (tip === null || prBranch === "") {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `PR mode could not read the branch tip for ${prBranch || "(no branch)"}`,
			};
			return;
		}
		const sameTree =
			tip === head || ((await ops.treesEqual?.(st.e.path, head, tip)) ?? false);
		if (sameTree) {
			adoptSourcePr(st, n, head, src.url);
			return;
		}
		// The branch holds work beyond the PR head: fixes on top, or a cherry-pick that
		// resolved conflicts against a moved base.
		const onHead = await ops
			.targetContains(st.e.path, head, tip)
			.catch(() => false);
		const pushable =
			onHead && src.crossRepo !== true && src.dependabot !== true;
		if (pushable) {
			await pushToSourcePr(st, n, src, prBranch, tip);
			return;
		}
		await parkOnSourcePr(st, n, src);
	}

	/** OTTR-781: resolves a legacy Dependabot card (filed before the source-PR fields
	 * existed) to the PR its prompt's first line names, fetching the head at ship time.
	 * A match never falls through to openPullRequest — opening a second PR is exactly
	 * the duplicate-PR bug; an unresolvable ship parks with the reason instead. */
	async function resolveLegacyDependabotPr(
		st: TurnSettle,
	): Promise<
		| { kind: "none" }
		| { kind: "parked" }
		| { kind: "match"; n: number; src: SourcePrRef }
	> {
		const repo = st.e.github === null ? null : ownerRepo(st.e.github);
		if (repo === null) return { kind: "none" };
		const n = parseDependabotHeadLine(
			st.task.prompt.split("\n")[0] ?? "",
			repo,
		);
		if (n === null) return { kind: "none" };
		if (ops.fetchPrHead === undefined) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `Source PR #${n} needs its head fetched, but the server's ship step is not wired; restart the board`,
			};
			return { kind: "parked" };
		}
		const fetchErr = await ops
			.fetchPrHead(st.e.path, n, `${githubHost().webBase}/${repo}.git`)
			.catch((err: unknown) => errmsg(err));
		if (fetchErr !== null) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `Source PR #${n} head fetch failed: ${fetchErr.slice(0, 200)}`,
			};
			return { kind: "parked" };
		}
		const sha = await ops
			.targetSha(st.e.path, `refs/ottr/pr/${n}`)
			.catch(() => null);
		if (sha === null) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `Source PR #${n} head sha unreadable; file the card again`,
			};
			return { kind: "parked" };
		}
		// dependabot: true keeps shipSourcePrCard's push path off (a Dependabot PR
		// must never get a board push) and makes parkOnSourcePr comment "@dependabot rebase".
		return {
			kind: "match",
			n,
			src: {
				headSha: sha,
				headRef: null,
				url: `${githubHost().webBase}/${repo}/pull/${n}`,
				crossRepo: false,
				dependabot: true,
			},
		};
	}

	/** Stamps the source PR as the card's PR (merging/idle): the supervisor's merge watch
	 * finishes the card when GitHub merges it, and the drawer's PR badge links the original
	 * PR. pushSha stays null — the PR's CI runs on a head the author can rebase any time,
	 * so the board watches the PR, never a pinned sha. */
	function adoptSourcePr(
		st: TurnSettle,
		n: number,
		prHeadSha: string,
		url: string | null,
	): void {
		st.store.updateTask(st.id, {
			stage: "merging",
			state: "idle",
			needsReason: null,
			prNumber: n,
			prUrl: url,
			prHeadSha,
		});
		appendLog(
			st.store,
			st.id,
			`- source PR #${n} stays the card's PR; the tracker waits for GitHub to merge it`,
		);
		st.prNext = { stage: "merging", state: "idle", needsReason: null };
	}

	/** Pushes the card branch (the source PR's head plus the turn's fixes, a fast-forward
	 * by the ancestor check) to the source PR's head branch on origin, then adopts the PR. */
	async function pushToSourcePr(
		st: TurnSettle,
		n: number,
		src: SourcePrRef,
		prBranch: string,
		tip: string,
	): Promise<void> {
		const dst = src.headRef;
		const pushBranch = ops.pushBranch;
		if (pushBranch === undefined || dst === null) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `Source PR #${n} needs the card's fixes, but the ship step cannot push to its head branch; restart the board`,
			};
			return;
		}
		// openPullRequest parked on a null origin before this call, so the pinned URL is set.
		const originUrl = st.header.settings.originUrl;
		if (originUrl === null) return;
		const pr = await pushBranch(st.e.path, prBranch, originUrl, dst).catch(
			(err: unknown) => ({
				status: "failed" as const,
				error: errmsg(err),
			}),
		);
		if (pr.status !== "pushed") {
			logPrPushFailure(st, dst, pr);
			return;
		}
		st.log(`- pushed the card's fixes to ${dst} (source PR #${n})`);
		adoptSourcePr(st, n, tip, src.url);
	}

	/** Comments on the source PR and parks the card with the reason: the turn's work must
	 * not become a second PR and cannot ride a push. A Dependabot PR gets the
	 * "@dependabot rebase" command — the bot refreshes its own branch and would abandon
	 * the PR if the board pushed to it; any other PR gets a note about the parked fixes. */
	async function parkOnSourcePr(
		st: TurnSettle,
		n: number,
		src: SourcePrRef,
	): Promise<void> {
		await commentSourcePr(st, n, src.dependabot);
		const dependabot = src.dependabot;
		st.prNext = {
			stage: "merging",
			state: "needs_you",
			needsReason: `Fixes beyond source PR #${n} (${src.url ?? "URL unknown"}) sit on the card branch and were not pushed${dependabot ? "; the board asked @dependabot to rebase instead" : ""}. Carry them onto the PR by hand.`,
		};
	}

	/** Posts the park's comment on the source PR: the "@dependabot rebase" command for a
	 * Dependabot PR (the bot refreshes its own branch and would abandon the PR if the board
	 * pushed to it), else a note about the parked fixes. Best-effort — a failed comment
	 * logs and the park reason still lands. */
	async function commentSourcePr(
		st: TurnSettle,
		n: number,
		dependabot: boolean,
	): Promise<void> {
		const comment = ops.prComment;
		const repo = st.e.github === null ? null : ownerRepo(st.e.github);
		if (comment === undefined || repo === null) return;
		const res = await comment({
			repo,
			number: n,
			body: dependabot
				? "@dependabot rebase"
				: `The board's card for this pull request finished with fixes on branch \`${st.task.branch ?? "(gone)"}\`; they are not on this PR. Please carry them over by hand.`,
			...(ops.hosted !== undefined && {
				gh: await hostedGh(st.e.path, st.header.settings.originUrl),
			}),
		}).catch((err: unknown) => ({
			ok: false as const,
			error: errmsg(err),
		}));
		if (!res.ok) st.log(`! commenting on source PR #${n} failed: ${res.error}`);
	}

	/** Ships a proven integration: the same proof classify reads (clean tree, origin/<target>
	 * an ancestor of HEAD). An unproven integrated report ships nothing — classify takes the
	 * not-on-target park. */
	async function openPullRequest(
		st: TurnSettle,
		pushBranch: NonNullable<TurnOps["pushBranch"]>,
		openPr: NonNullable<TurnOps["openPr"]>,
	): Promise<void> {
		const proof = await ops
			.prIntegrated?.(st.e.path, st.loc.wt, st.header.target)
			.catch(() => false);
		const prBranch = st.task.branch ?? "";
		const tip =
			proof === true
				? await ops
						.targetSha(st.e.path, `refs/heads/${prBranch}`)
						.catch(() => null)
				: null;
		if (proof !== true) {
			// No ship: classify parks the integrated report as not-on-target.
			return;
		}
		if (tip === null || prBranch === "") {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `PR mode could not read the branch tip for ${prBranch || "(no branch)"}`,
			};
			return;
		}
		if (st.header.settings.originUrl === null) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason:
					"no pinned origin URL; restart the board (or set it in project settings) so the server pins the origin remote before pushing the branch",
			};
			return;
		}
		await pushPrBranch(st, prBranch, tip, pushBranch, openPr);
	}

	/** Pushes the card branch from the server and opens the pull request when it lands. */
	async function pushPrBranch(
		st: TurnSettle,
		prBranch: string,
		tip: string,
		pushBranch: NonNullable<TurnOps["pushBranch"]>,
		openPr: NonNullable<TurnOps["openPr"]>,
	): Promise<void> {
		// openPullRequest parked on a null origin before this call, so the pinned URL is set.
		const originUrl = st.header.settings.originUrl;
		if (originUrl === null) return;
		const pr = await pushBranch(st.e.path, prBranch, originUrl).catch(
			(err: unknown) => ({
				status: "failed" as const,
				error: errmsg(err),
			}),
		);
		if (pr.status === "pushed") {
			st.log(`- pushed ${prBranch} from the server`);
		} else {
			logPrPushFailure(st, prBranch, pr);
		}
		if (pr.status === "pushed") {
			// The PR needs a GitHub remote: PR mode without one is not a state
			// the board holds, but the setting can drift — fail closed here.
			await openPrCard(st, prBranch, tip, openPr);
		}
	}

	/** Logs a failed server branch push with git's full output and the credential kinds the
	 * push could use, and parks the card with the reason. */
	function logPrPushFailure(
		st: TurnSettle,
		prBranch: string,
		pr: { status: "failed" | "rejected"; error: string; output?: string },
	): void {
		st.log(
			`! server push of ${prBranch} ${pr.status === "rejected" ? "rejected" : "failed"}: ${pr.error}`,
		);
		const pushOut = "output" in pr ? (pr.output ?? null) : null;
		if (pushOut !== null) st.log(`git's full push output:\n${pushOut}`);
		const kindAuth =
			st.header.settings.originUrl === null
				? null
				: (ops.pushAuthKind?.(st.header.settings.originUrl) ?? null);
		if (kindAuth !== null) st.log(`- push auth: ${kindAuth}`);
		st.prNext = {
			stage: "merging",
			state: "needs_you",
			needsReason: `Server push to origin failed: ${pr.error}`,
		};
	}

	/** Opens the pull request for a pushed branch and stores it on the card (merging/idle). */
	async function openPrCard(
		st: TurnSettle,
		prBranch: string,
		tip: string,
		openPr: NonNullable<TurnOps["openPr"]>,
	): Promise<void> {
		const repo = st.e.github === null ? null : ownerRepo(st.e.github);
		if (repo === null) {
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason:
					"PR mode requires a GitHub remote on the project; disable PR mode or add the remote",
			};
			return;
		}
		const slash = repo.indexOf("/");
		const opened = await openPr({
			repo,
			owner: repo.slice(0, slash),
			branch: prBranch,
			base: st.header.target.replace(/^origin\//, ""),
			title: st.task.title,
			body: prBody(st.task, st.result.outcome),
			// Hosted: gh takes the project's minted token, never GH_TOKEN.
			...(ops.hosted !== undefined && {
				gh: await hostedGh(st.e.path, st.header.settings.originUrl),
			}),
		}).catch((err: unknown) => ({
			ok: false as const,
			error: errmsg(err),
		}));
		if (!opened.ok) {
			st.log(`! opening the pull request failed: ${opened.error}`);
			st.prNext = {
				stage: "merging",
				state: "needs_you",
				needsReason: `Opening the pull request failed: ${opened.error}`,
			};
			return;
		}
		st.store.updateTask(st.id, {
			stage: "merging",
			state: "idle",
			needsReason: null,
			prNumber: opened.pr.number,
			prUrl: opened.pr.url,
			prHeadSha: tip,
			pushSha: tip,
		});
		appendLog(
			st.store,
			st.id,
			`- PR #${opened.pr.number} opened (base ${st.header.target.replace(/^origin\//, "")})`,
		);
		st.prNext = {
			stage: "merging",
			state: "idle",
			needsReason: null,
		};
	}

	/** An approved merge hold fixes what may ship. The merge turn resumes the same agent
	 * session and could commit beyond the approved head, so the push set
	 * (target..refs/heads/<branch>) must carry exactly the approved patches
	 * (base..approvedHead). Fails closed: git trouble parks the card. A reply to the
	 * mismatch park approves the exact parked head, so a sha-equal re-merge pushes. */
	async function auditMergeHold(st: TurnSettle): Promise<void> {
		const approvedHeads = [
			st.task.updateMergeHead,
			st.task.forkMergeHead,
		].filter((h) => h !== null);
		const branch = st.header.target.startsWith("origin/")
			? st.header.target.slice("origin/".length)
			: null;
		const localHead =
			branch === null || approvedHeads.length === 0
				? null
				: await ops
						.targetSha(st.e.path, `refs/heads/${branch}`)
						.catch(() => null);
		if (branch !== null && approvedHeads.length > 0)
			await holdApprovedHead(st, approvedHeads, branch, localHead);
		// OTTR-326: a park whose branch reset could not run leaves the held patches as the
		// local tip; no other card may push the branch while that head sits there.
		st.refused = await heldMergeOnBranchTip(
			st.store,
			st.id,
			st.e.path,
			branch,
			ops,
		);
		// A landed merge has nothing to push: the remote target already holds every
		// approved patch, and pushing the stale local branch would only fight it.
		if (st.holdMismatch === null && !st.remoteLanded)
			await pushMergeTarget(st, branch);
	}

	/** The approved hold heads vs the push set: exact head match judges nothing new; VELV-89
	 * probes the fetched remote target first — the merge can land through a project rule that
	 * pushes the target from the worktree and never moves the main checkout's local branch, so
	 * the gate below would judge a stale push set and park a landed card. Every approved head
	 * already contained in it and no patches beyond the approval means the merge landed —
	 * settle it. False on git trouble or extra patches: the gate below judges the push set,
	 * and it still fails closed into the park. */
	async function holdApprovedHead(
		st: TurnSettle,
		approvedHeads: string[],
		branch: string,
		localHead: string | null,
	): Promise<void> {
		if (localHead !== null && approvedHeads.includes(localHead)) {
			// the exact head a reply approved: nothing new to judge
			return;
		}
		const landed = await ops
			.mergeHoldLanded(
				st.e.path,
				st.header.target,
				st.header.base,
				approvedHeads,
				st.header.settings.originUrl,
			)
			.catch(() => false);
		if (landed) {
			st.remoteLanded = true;
			st.log(
				`- approved head already on ${st.header.target}: the merge landed without the local branch moving`,
			);
			return;
		}
		for (const ah of approvedHeads) {
			const { mismatch, pushDiff, auditedTip } = await ops
				.mergeHoldMismatch(
					st.e.path,
					st.header.target,
					st.header.base,
					ah,
					st.header.settings.originUrl,
				)
				.catch(() => ({
					mismatch: true,
					pushDiff: null,
					auditedTip: null,
				}));
			if (mismatch) {
				await parkHeldMismatch(st, branch, localHead, pushDiff, auditedTip);
				break;
			}
			st.holdTip = auditedTip;
		}
	}

	/** The audited push set carries patches beyond the approved head: park the card for the
	 * reviewer with the exact push-side delta, and reset the branch to the gate's audited tip
	 * so the held patches cannot ship with a later card's un-gated push (OTTR-326). Without an
	 * audited tip (gate fetch failed) there is no trusted tip to reset to, and the push refusal
	 * below keeps the branch pinned instead. */
	async function parkHeldMismatch(
		st: TurnSettle,
		branch: string,
		localHead: string | null,
		pushDiff: string | null,
		auditedTip: string | null,
	): Promise<void> {
		st.holdMismatch = MERGE_HOLD_MISMATCH_REASON;
		st.holdHead = localHead;
		// Same cap as the merge-start capture: bigger diffs keep their numstat.
		st.holdDiff =
			pushDiff === null
				? null
				: pushDiff.length > 200_000
					? `${pushDiff.slice(0, 200_000)}\n… diff truncated at 200 KB`
					: pushDiff;
		st.holdFiles =
			st.holdDiff === null
				? null
				: await ops
						.diffStat(st.e.path, st.header.target, `refs/heads/${branch}`)
						.catch(() => null);
		st.log("! held merge carries patches beyond the approved head");
		const reset =
			auditedTip !== null &&
			(await ops
				.resetBranchTo(st.e.path, branch, auditedTip)
				.catch(() => false));
		if (!reset)
			st.log(
				"! merge-hold park kept the held patches on the local target branch; resolve it by hand before any merge",
			);
	}

	/** The server push of the target with the OTTR-465 origin re-check and the one retry.
	 * A push can fail while origin never moved (a dropped connection, a token-refresh
	 * hiccup): ALAT-60 landed unchanged on a later merge turn. One retry, when a fetch
	 * proves the push should still be a fast-forward — origin's tip still sits at the base
	 * the merge started from, or the local head is a fast-forward of it. A rejected push
	 * (origin moved) takes the OTTR-394 rebase path below instead. */
	async function pushMergeTarget(
		st: TurnSettle,
		branch: string | null,
	): Promise<void> {
		let p = await serverPush(st);
		let authLogged = false;
		for (let attempt = 1; ; attempt++) {
			if (p.status === "skipped") break;
			if (p.status === "pushed") {
				markPushedRun(st, p);
				break;
			}
			await logPushFailure(st, p);
			if (!authLogged) {
				authLogged = true;
				logPushAuthKind(st);
			}
			if (!(await retryFailedPush(st, branch, attempt))) break;
			p = await serverPush(st);
		}
	}

	/** A retry that landed erases the earlier failure: the card lands instead of parking on an
	 * error the second push already resolved. OTTR-506: the push put the target on origin, so
	 * the merge hold lifts at once instead of waiting for the tick's branchUnpushed refresh.
	 * The agent's own push has no credentials (D6). A merge agent that stopped at needs_you on
	 * that authentication failure did integrate: the server push landed it, so the report
	 * becomes integrated with the push output in details. */
	function markPushedRun(
		st: TurnSettle,
		p: { status: "pushed"; output: string },
	): void {
		st.pushError = null;
		st.pushOutput = null;
		st.pushRejected = false;
		st.e.mainUnpushed = false;
		st.log(`- pushed ${st.header.target} from the server`);
		// OTTR-743: a "cannot lock ref" failure whose head the remote already
		// holds lands as pushed; name the recovery in the card log.
		if (p.output.startsWith(PUSH_LANDED_BEFORE_ATTEMPT))
			st.log(`- ${p.output}`);
		const o = st.result.outcome;
		const text = `${o?.summary ?? ""}\n${o?.details ?? ""}\n${o?.question ?? ""}`;
		if (o?.status === "needs_you" && GIT_AUTH_FAILURE.test(text)) {
			st.result = {
				...st.result,
				asked: null,
				outcome: {
					...o,
					status: "integrated",
					question: undefined,
					details: `${o.details ?? o.summary}\n\nServer push of ${st.header.target}:\n${p.output || "(no output)"}`,
				},
			};
			st.log(
				"- needs_you on a push authentication failure resolved: the server pushed",
			);
		}
	}

	/** Logs a failed server push with git's complete output, so the cause a permission
	 * failure points at (a missing App installation, a token scope) stays visible (OTTR-465). */
	async function logPushFailure(
		st: TurnSettle,
		p: { status: "failed" | "rejected"; error: string; output?: string },
	): Promise<void> {
		st.pushRejected = p.status === "rejected";
		st.pushError = p.error;
		st.pushOutput = p.output ?? null;
		st.log(
			`! server push of ${st.header.target} ${st.pushRejected ? "rejected" : "failed"}: ${p.error}`,
		);
		if (st.pushOutput !== null)
			st.log(`git's full push output:\n${st.pushOutput}`);
	}

	/** One line naming the credential kinds the push could use (OTTR-465). */
	function logPushAuthKind(st: TurnSettle): void {
		const kind =
			st.header.settings.originUrl === null
				? null
				: (ops.pushAuthKind?.(st.header.settings.originUrl) ?? null);
		if (kind !== null) st.log(`- push auth: ${kind}`);
	}

	/** The OTTR-465 retry decision after a failed server push. True: the fetch proved the
	 * push should still be a fast-forward and the caller retries once. */
	async function retryFailedPush(
		st: TurnSettle,
		branch: string | null,
		attempt: number,
	): Promise<boolean> {
		if (
			st.pushRejected ||
			st.refused !== null ||
			branch === null ||
			attempt > 1
		)
			return false;
		if (st.header.settings.originUrl === null) {
			st.log(
				"! no pinned origin URL; cannot re-check origin's tip before a push retry",
			);
			return false;
		}
		const originUrl = st.header.settings.originUrl;
		const fetchError = await ops
			.fetchOriginBranch(st.e.path, branch, originUrl)
			.then(() => null)
			.catch((err: unknown) => withAuthHint(originUrl, errmsg(err)));
		if (fetchError !== null) {
			// The re-check's own reason (a network error, a token-refresh failure)
			// rides the park reason; the retry stays off without a proven origin tip.
			st.recheckError = fetchError;
			st.log(`! origin re-check before a push retry failed: ${fetchError}`);
			return false;
		}
		if (!(await originStillFastForward(st, branch))) {
			st.log("! origin moved or its tip is unreadable; not retrying the push");
			return false;
		}
		const waitMs = ops.pushRetryDelayMs ?? MERGE_PUSH_RETRY_WAIT_MS;
		st.log(
			`- origin did not move; retrying the server push once in ${Math.round(waitMs / 1000)} s`,
		);
		await new Promise<void>((r) => setTimeout(r, waitMs));
		return true;
	}

	/** True when a fetch proves the failed push should still be a fast-forward: origin's
	 * tip still sits at the base the merge started from, or the local head is a
	 * fast-forward of it. */
	async function originStillFastForward(
		st: TurnSettle,
		branch: string,
	): Promise<boolean> {
		const originTip = await ops
			.targetSha(st.e.path, `refs/remotes/origin/${branch}`)
			.catch(() => null);
		const localTip = await ops
			.targetSha(st.e.path, `refs/heads/${branch}`)
			.catch(() => null);
		return (
			originTip !== null &&
			localTip !== null &&
			(await ops
				.targetContains(st.e.path, originTip, localTip)
				.catch(() => false))
		);
	}

	/** The settle git facts, the research demotion, and classify's verdict. The PR-mode ship
	 * step owns the card's next state: it never lands, so the done write below (pushSha
	 * pinning, worktree removal, release stamping) is skipped. A run the provider stopped at
	 * its usage limit continues automatically (classify's queued continue): stamp the
	 * provider's reset as the hold, so the continue fires after the reset instead of against
	 * the still-exhausted window. Without a known reset the retry starts at once; classify's
	 * streak rule parks the next identical death for a human. */
	async function classifyTurnEnd(
		st: TurnSettle,
	): Promise<{ facts: GitFacts; next: Next }> {
		// PR mode proves the rebase instead of the merge: origin/<target> an ancestor of the
		// worktree HEAD on a clean tree — the branch is rebased and ready for the server's
		// mechanical steps. Every other project keeps today's targetContains proof.
		const prModeFacts =
			st.kind === "merge" &&
			!st.idn.interview &&
			!st.idn.grill &&
			!st.fromMain &&
			!st.idn.releaseCard &&
			st.header.settings.prMode === true;
		const facts: GitFacts = await settleGitFacts(st, prModeFacts);
		// Landable clean commits with the report file gone: the card did real work after its
		// research mark. Clear the flag and classify like any other work turn — the ready
		// outcome was held unrewritten, so classify's ready branch sends it to merging.
		const demoted = st.demoteCandidate && facts.commitsAhead > 0 && facts.clean;
		if (demoted) st.store.updateTask(st.id, { research: false });
		st.research = st.wasResearch && !demoted;
		// listTurns ends with this turn; the one before it tells classify whether this exit repeats.
		let next = classify({
			kind: st.kind,
			result: st.result,
			git: facts,
			research: st.research,
			hasReport: st.reportText !== null,
			grill: st.idn.grill,
			target: st.header.target,
			previousError: st.store.listTurns(st.id).at(-2)?.error ?? null,
			...(st.vmOut !== null ? { vmDirty: st.vmOut.dirty } : {}),
			images: st.input.imagePaths.length,
			http400: () =>
				findHttp400Rejection({
					from: st.dispatch.runStartedAt,
					to: st.runEndedAt,
					dir: ops.http400Dir,
				}),
		});
		// The PR-mode ship step owns the card's next state: it never lands, so the done
		// write below (pushSha pinning, worktree removal, release stamping) is skipped.
		if (st.prNext !== null) next = st.prNext;
		return { facts, next: await stampUsageHold(st, next) };
	}

	/** A run the provider stopped at its usage limit continues automatically (classify's
	 * queued continue): stamp the provider's reset as the hold, so the continue fires
	 * after the reset instead of against the still-exhausted window. Without a known
	 * reset the retry starts at once; classify's streak rule parks the next identical
	 * death for a human. */
	async function stampUsageHold(st: TurnSettle, next: Next): Promise<Next> {
		if (
			!(
				next.state === "queued" &&
				next.pendingPrompt !== undefined &&
				hitUsageLimit(st.result)
			)
		)
			return next;
		const hit = await usageResetFor(
			st.result.model ?? st.route.runModel ?? null,
		);
		if (hit === null) return next;
		const at = new Date(hit.resetsAt)
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");
		return {
			...next,
			holdUntil: hit.resetsAt,
			holdProvider: hit.provider,
			holdWindow: hit.window,
			needsReason: `${QUOTA_LIMIT} - the board continues the task after the ${hit.provider} limit resets at ${at} UTC. Cancel to stop it instead.`,
		};
	}

	/** The settle git facts: the commits-ahead gate (interview, scout and main-checkout
	 * cards exempt), the cleanliness read, and the integration proof. */
	async function settleGitFacts(
		st: TurnSettle,
		prModeFacts: boolean,
	): Promise<GitFacts> {
		return {
			// An interview card runs in the main checkout with no base branch: the commits-ahead
			// gate would count its own AGENTS.md commit and trap the card, so it stays exempt.
			// A trending scout runs there too: the checkout's own commits are never its work.
			// A husk or unlinked dir would make git speak for the enclosing checkout instead,
			// so the main-repo proof stands in for all three facts there.
			commitsAhead:
				st.idn.interview || st.idn.grill || st.idn.scout || st.fromMain
					? 0
					: await ops.commitsAhead(st.loc.wt, st.header.base).catch(() => 0),
			// A microVM's tree is gone with the VM: its end-of-run status report decides,
			// and a VM that could not report (null) is never clean.
			clean: st.fromMain
				? true
				: st.vmOut !== null
					? st.vmOut.dirty !== null && st.vmOut.dirty.length === 0
					: await ops.isClean(st.loc.wt).catch(() => false),
			integrated: await integrationProof(st, prModeFacts),
		};
	}

	/** The integration proof: VELV-89's hold probe (the fetched remote target holds the
	 * approved merge; the stale worktree proof cannot see it), else the main-repo proof for
	 * a lost worktree link, the PR-mode rebase proof, or the worktree's isIntegrated. */
	async function integrationProof(
		st: TurnSettle,
		prModeFacts: boolean,
	): Promise<boolean> {
		return (
			st.remoteLanded ||
			(st.fromMain
				? await ops
						.branchMergedOrGone(
							st.e.path,
							st.task.branch ?? "",
							st.header.target,
						)
						.catch(() => false)
				: prModeFacts
					? ((await ops
							.prIntegrated?.(st.e.path, st.loc.wt, st.header.target)
							.catch(() => false)) ?? false)
					: await ops
							.isIntegrated(st.loc.wt, st.header.target)
							.catch(() => false))
		);
	}

	/** A failed server push keeps the card at merging with git's reason: the worktree stays.
	 * OTTR-394: a rejected non-fast-forward means origin moved while the merge ran. The
	 * server fetches origin with its own credentials, then — OTTR-510 — rebases the
	 * target branch onto the fetched tip, runs the merge gates, and pushes again. The
	 * recovery merge turn goes out only when the automatic retry cannot converge: a
	 * rebase conflict, failed gates, or a still-rejected retry push. The guards are
	 * unchanged: the retry budget (2 automatic retries per card), a hold-approved push
	 * whose lease pins one exact head (OTTR-274), and the pinned origin URL all still
	 * take today's needs_you with git's reason. */
	async function recoverMergePush(st: TurnSettle, next: Next): Promise<Next> {
		if (st.pushError === null) return next;
		// OTTR-506: the rejection left local main with commits origin lacks, so the
		// merge hold must gate the very next tick, not wait for the refresh.
		if (st.pushRejected) st.e.mainUnpushed = true;
		const branch = st.header.target.startsWith("origin/")
			? st.header.target.slice("origin/".length)
			: null;
		const retries = st.store.getTask(st.id)?.pushRetries ?? 0;
		const ruleHint = BRANCH_RULE_REJECTION.test(st.pushError)
			? "\nThis push was refused by a GitHub branch rule: the target branch requires pull requests. Project PR mode ships cards as pull requests instead; turn it on under the project's settings."
			: "";
		if (
			st.pushRejected &&
			st.holdTip === null &&
			branch !== null &&
			retries < MERGE_PUSH_RETRIES
		)
			return rebaseRecoveredPush(st, branch, retries, ruleHint, next);
		return parkFailedPush(st, ruleHint);
	}

	/** The card keeps git's push failure: merging with the reason (the re-check failure's own
	 * reason rides along when the OTTR-465 re-check failed). */
	function parkFailedPush(st: TurnSettle, ruleHint: string): Next {
		return {
			stage: "merging",
			state: "needs_you",
			needsReason: `Server push to origin failed: ${st.pushError}${st.recheckError === null ? "" : `\norigin re-check failed: ${st.recheckError}`}${ruleHint}`,
		};
	}

	/** The OTTR-394/510 automatic recovery: fetch the moved tip, rebase the target branch
	 * onto it, run the merge gates, and push again. */
	async function rebaseRecoveredPush(
		st: TurnSettle,
		branch: string,
		retries: number,
		ruleHint: string,
		next: Next,
	): Promise<Next> {
		const fetchError =
			st.header.settings.originUrl === null
				? "no pinned origin URL to fetch the moved tip from"
				: await ops
						.fetchOriginBranch(st.e.path, branch, st.header.settings.originUrl)
						.then(() => null)
						.catch((err: unknown) =>
							withAuthHint(st.header.settings.originUrl ?? "", errmsg(err)),
						);
		if (fetchError !== null)
			return {
				stage: "merging",
				state: "needs_you",
				needsReason: `Server push to origin failed: ${st.pushError}${ruleHint}`,
			};
		st.log(
			`- push rejected and origin moved: trying the automatic rebase of ${branch} onto the fetched tip first`,
		);
		const rb = await ops
			.rebaseTargetBranch(st.e.path, branch)
			.catch((err: unknown) => ({
				ok: false as const,
				conflict: false,
				error: errmsg(err),
			}));
		if (!rb.ok && rb.conflict) {
			st.log(
				`! the automatic rebase of ${branch} hit a conflict (the branch stays on its rejected head); queuing the rebase turn (retry ${retries + 1} of ${MERGE_PUSH_RETRIES})`,
			);
			return queueRebaseTurn(st, branch, retries, ruleHint);
		}
		if (!rb.ok) {
			// Fail closed: no turn queued, no retry budget spent.
			st.log(`! the automatic rebase of ${branch} failed: ${rb.error}`);
			return {
				stage: "merging",
				state: "needs_you",
				needsReason: `Server push to origin failed: ${st.pushError}\nthe automatic rebase failed: ${rb.error}${ruleHint}`,
			};
		}
		st.log(
			`- automatic rebase of ${branch} onto the fetched origin tip converged; running the merge gates (bun run check, bun test)`,
		);
		return runRebaseGates(st, branch, retries, ruleHint, next);
	}

	/** Queues the rebase recovery merge turn (OTTR-510). The gates can run minutes: re-fetch
	 * so the prompt's "the server has fetched origin" stays true when the recovery turn
	 * starts. Steering that landed mid-run rides the rebase turn, its authorship leading —
	 * the same rule a hold park follows under queued user text. */
	async function queueRebaseTurn(
		st: TurnSettle,
		branch: string,
		retries: number,
		ruleHint: string,
	): Promise<Next> {
		const refetchError =
			st.header.settings.originUrl === null
				? "no pinned origin URL to fetch the moved tip from"
				: await ops
						.fetchOriginBranch(st.e.path, branch, st.header.settings.originUrl)
						.then(() => null)
						.catch((err: unknown) =>
							withAuthHint(st.header.settings.originUrl ?? "", errmsg(err)),
						);
		if (refetchError !== null) {
			st.log(
				`! origin re-fetch before the recovery turn failed: ${refetchError}`,
			);
			// Fail closed: no turn queued, no retry budget spent.
			return {
				stage: "merging",
				state: "needs_you",
				needsReason: `Server push to origin failed: ${st.pushError}\norigin re-fetch before the recovery turn failed: ${refetchError}${ruleHint}`,
			};
		}
		const prompt = rebaseRetryPrompt({
			branch,
			attempt: retries + 1,
			max: MERGE_PUSH_RETRIES,
		});
		// Steering that landed mid-run rides the rebase turn, its authorship
		// leading — the same rule a hold park follows under queued user text.
		const steer = st.store.getTask(st.id)?.pendingPrompt ?? null;
		st.store.updateTask(st.id, { pushRetries: retries + 1 });
		appendLog(
			st.store,
			st.id,
			`server push rejected: origin moved, merge turn queued to rebase (retry ${retries + 1} of ${MERGE_PUSH_RETRIES})`,
		);
		return {
			stage: "merging",
			state: "queued",
			needsReason: null,
			pendingPrompt: steer === null ? prompt : `${prompt}\n\n${steer}`,
			pendingBy:
				steer === null ? "supervisor" : (st.input.live.pendingBy ?? "user"),
		};
	}

	/** The merge gates on the rebased branch: pass pushes the target again, fail queues the
	 * recovery turn. */
	async function runRebaseGates(
		st: TurnSettle,
		branch: string,
		retries: number,
		ruleHint: string,
		next: Next,
	): Promise<Next> {
		const gates = await ops
			.runMergeGates(st.e.path)
			.catch((err: unknown) => ({ ok: false, output: errmsg(err) }));
		if (!gates.ok) {
			st.log(
				`! merge gates failed on the rebased ${branch}; queuing the rebase turn (retry ${retries + 1} of ${MERGE_PUSH_RETRIES})`,
			);
			if (gates.output !== "") st.log(`! merge gates output:\n${gates.output}`);
			return queueRebaseTurn(st, branch, retries, ruleHint);
		}
		st.log(
			`- merge gates passed on the rebased ${branch}; retrying the server push`,
		);
		const p2 = await serverPush(st);
		if (p2.status === "pushed") {
			st.pushError = null;
			st.pushOutput = null;
			st.pushRejected = false;
			st.log(
				`- pushed ${st.header.target} from the server after the automatic rebase`,
			);
			// OTTR-743: the same recovery reason line rides a retry push.
			if (p2.output.startsWith(PUSH_LANDED_BEFORE_ATTEMPT))
				st.log(`- ${p2.output}`);
		} else if (p2.status === "skipped") {
			st.pushError = null;
			st.pushOutput = null;
			st.pushRejected = false;
			st.log(
				"- server push skipped after the automatic rebase (nothing to push)",
			);
		} else {
			st.log(
				`! the retry push of ${st.header.target} ${p2.status} after the automatic rebase: ${p2.error}`,
			);
			return queueRebaseTurn(st, branch, retries, ruleHint);
		}
		return next;
	}

	/** The verdict fixes after classify and recovery: hold parks, the lost-worktree rewrite,
	 * the dispatch-context log, image quarantine, the model-restore requeue, mid-run steering,
	 * reported dependencies, and the review/scout card parks. */
	/** OTTR-708: records the head the merge machinery left in the project's main checkout,
	 * so the checkout guard of a concurrent work turn in another project discounts the
	 * board's own advance. Merge turns only; the interview, grill, and release variants
	 * touch no merge machinery. */
	async function recordBoardPushedHead(st: TurnSettle): Promise<void> {
		if (
			st.kind !== "merge" ||
			st.idn.interview ||
			st.idn.grill ||
			st.idn.releaseCard
		)
			return;
		const s = await ops.checkoutState(st.e.path).catch(() => null);
		if (s === null || s.head === null) return;
		boardPushedHeads.set(st.name, s.head);
	}

	async function stabilizeNext(
		st: TurnSettle,
		facts: GitFacts,
		next: Next,
	): Promise<Next> {
		let settled = next;
		// OTTR-274: a held merge carries patches beyond the approval: park instead of landing
		// it. holdHead holds the exact local target head the reply can approve.
		if (st.holdMismatch !== null)
			settled = {
				stage: "in_progress",
				state: "needs_you",
				needsReason: st.holdMismatch,
			};
		// OTTR-708: the merge machinery has done all it will do to the main checkout —
		// the merge agent fast-forwarded it before the push, the settle may have reset
		// the branch (resetBranchTo on a hold park), and the push attempt ended pushed,
		// failed, rejected, or skipped, or was refused outright, or never ran. Record
		// the head it left behind, whatever the path took, so the checkout guard of a
		// concurrent work turn in another project discounts the board's own advance.
		await recordBoardPushedHead(st);
		if (
			st.fromMain &&
			!facts.integrated &&
			settled.needsReason?.startsWith("Reported integrated, but HEAD is not on")
		)
			settled = {
				...settled,
				needsReason: "worktree link lost and branch has unreached commits",
			};
		// A no-stderr death carries its dispatch context in the reason; the run log gets the
		// same line so an operator tailing the log sees the answer without opening the board.
		if (
			settled.needsReason?.startsWith("omp exited with code ") &&
			settled.needsReason.includes(" (dispatch ")
		)
			appendLog(st.store, st.id, settled.needsReason);
		// OTTR-754: an apt disk-failure signature names the runner's /tmp free space (the
		// apt error itself never says "no space"); the runner comes from the dispatch
		// record's url, undefined = a local run.
		settled = enrichTmpReason(
			settled,
			st.dispatch.handle.url,
			ops.tmpSpaceLine,
		);
		settled = await quarantineTurnImages(st, settled);
		settled = await requeueModelRestore(st, settled);
		// A run that could not restore its model never delivered this turn's reply: the retry
		// sends it again, with any steering that landed meanwhile.
		const restoreRetry =
			settled.state === "queued" &&
			settled.needsReason?.startsWith(MODEL_RESTORE) === true;
		settled = await settleSteered(st, settled, restoreRetry);
		settled = await settleReportedDeps(st, settled);
		settled = await parkCardKind(st, settled);
		return settled;
	}

	/** A provider that died before any output with the images attached: quarantine the images
	 * and requeue text-only. */
	async function quarantineTurnImages(
		st: TurnSettle,
		next: Next,
	): Promise<Next> {
		if (!next.quarantineImages) return next;
		try {
			const moved = quarantineImageFiles(
				st.store.dataRoot,
				st.store.imagesDir(st.id),
				join(st.store.tasksDir, "quarantine", st.id),
				st.input.turnImages,
			);
			st.store.updateTask(st.id, {
				images: st.input.live.images.filter((n) => !moved.includes(n)),
			});
			appendLog(
				st.store,
				st.id,
				`provider rejected the attached images (died before any output); quarantined ${moved.length} image(s) to .tasks/quarantine/${st.id}: ${moved.slice(0, 20).join(", ")} — retrying text-only`,
			);
		} catch (err) {
			// Never requeue with the images still attached: that is the loop this handles.
			return {
				stage: st.kind === "work" ? "in_progress" : "merging",
				state: "needs_you",
				needsReason: `Image quarantine failed: ${errmsg(err)}.`,
			};
		}
		return next;
	}

	/** A run that could not restore its model never delivered this turn's reply: the retry
	 * sends it again, with any steering that landed meanwhile (raw's authorship leads the
	 * re-park; a null behaves as user). */
	async function requeueModelRestore(
		st: TurnSettle,
		next: Next,
	): Promise<Next> {
		if (
			!(
				next.state === "queued" &&
				next.needsReason?.startsWith(MODEL_RESTORE) === true
			)
		)
			return next;
		const sent = [
			st.input.raw,
			st.store.getTask(st.id)?.pendingPrompt ?? null,
		].filter((p): p is string => p !== null && p !== ".");
		return {
			...next,
			pendingPrompt: sent.join("\n\n") || (st.input.raw ?? undefined),
			// raw's authorship leads the re-park; a null behaves as user.
			pendingBy: st.input.live.pendingBy ?? "user",
		};
	}

	/** Steering queued while the turn ran: deliver it as the next turn instead of settling
	 * (a pendingPrompt at turn end can only have arrived via /steer mid-run). */
	async function settleSteered(
		st: TurnSettle,
		next: Next,
		restoreRetry: boolean,
	): Promise<Next> {
		const steered = (st.store.getTask(st.id)?.pendingPrompt ?? null) !== null;
		st.steered = steered;
		if (!steered || restoreRetry) return next;
		return {
			stage: st.kind === "work" ? "in_progress" : "merging",
			state: "queued",
			needsReason: null,
		};
	}

	/** The agent holds this turn on other cards (report_outcome dependsOn): valid ids are
	 * recorded on the card, and a needs_you outcome requeues it in the current stage instead
	 * of parking at needs_you — the scheduler restarts the turn when every id is done or
	 * cancelled (waitingOn). A bad id — this card itself, an unknown project's handle, a
	 * missing card here or abroad — parks needs_you naming it; the ids are not recorded. */
	async function settleReportedDeps(st: TurnSettle, next: Next): Promise<Next> {
		const outcome = st.result.outcome;
		const reportedDeps = outcome !== null ? outcome.dependsOn : undefined;
		if (reportedDeps === undefined || reportedDeps.length === 0) return next;
		// OTTR-708: ids resolve across the board's projects, this store's own cards first.
		const depProjects = depProjectsOf(projects.values());
		const ownDep = depProjectOf(st.store);
		const bad = badDep(reportedDeps, depProjects, ownDep, st.id);
		if (bad !== null) return parkBadDep(next, bad.reason);
		const merged = [...new Set([...st.task.dependsOn, ...reportedDeps])];
		if (
			merged.length !== st.task.dependsOn.length ||
			reportedDeps.some((d, i) => st.task.dependsOn[i] !== d)
		)
			st.store.updateTask(st.id, { dependsOn: merged });
		return queueDepHold(st, next, outcome, merged, depProjects, ownDep);
	}

	/** A bad id parks needs_you naming it; the ids are not recorded. */
	function parkBadDep(next: Next, reason: string): Next {
		return {
			stage: next.stage,
			state: "needs_you",
			needsReason: reason,
			asked: next.asked,
		};
	}

	/** A needs_you outcome holding on valid ids: requeue in the current stage until every id
	 * is done or cancelled (the scheduler restarts the turn then). */
	function queueDepHold(
		st: TurnSettle,
		next: Next,
		outcome: Outcome | null,
		merged: string[],
		depProjects: DepProject[],
		ownDep: DepProject,
	): Next {
		if (
			!(
				outcome?.status === "needs_you" &&
				next.state === "needs_you" &&
				next.asked === undefined
			)
		)
			return next;
		return {
			stage: next.stage,
			state: "queued",
			needsReason: depHold(
				st.store.listTasks(),
				{
					...st.task,
					dependsOn: merged,
				},
				(did) => findDep(did, depProjects, ownDep),
			),
			pendingPrompt: DEP_HELD_PROMPT,
			pendingBy: "supervisor",
		};
	}

	/** Review cards never integrate: committing fails the review, and a release publishes via
	 * the tracker. A trending scout is read-only: it reads the main checkout and files cards
	 * through the board, so nothing of it may ever reach a merge turn. A review card
	 * classified done parks at merging on its findings (see parkReviewDone). */
	async function parkCardKind(st: TurnSettle, next: Next): Promise<Next> {
		if (st.idn.reviewCard && next.stage === "merging")
			return {
				stage: "in_progress",
				state: "needs_you",
				needsReason: st.idn.releaseCard
					? "A release review must not commit. Cancel this release, or reply to continue."
					: "A review must not commit. Cancel this review, or reply to continue.",
			};
		if (st.idn.scout && next.stage === "merging")
			return {
				stage: "in_progress",
				state: "needs_you",
				needsReason: "A trending scout must not commit.",
			};
		if (st.idn.reviewCard && next.stage === "done")
			return parkReviewDone(st, next);
		return next;
	}

	/** A review card classified done: findings recorded this run hold the card at merging/idle
	 * with FINDINGS_HOLD; stored findings the check never covered hold it with
	 * UNCHECKED_FINDINGS_HOLD. The check below files the kept ones while the card is still
	 * in_progress/running, and only then is the parked state stored: settleReviews never sees
	 * a parked card whose findings are missing. */
	async function parkReviewDone(st: TurnSettle, next: Next): Promise<Next> {
		// Stored findings that have no card yet will be checked this settle (planTurnChecks
		// selects them); if that check never completes, the parked hold keeps them visible.
		// Release reviews hold too: the publish below only runs once the hold is clear.
		const stored = st.store.listReviewFindings(st.id);
		const hold =
			st.task.findingsCheckedAt === null &&
			stored.length > 0 &&
			stored.some(
				(f) =>
					!st.store
						.listTasks()
						.some((x) => x.followUpOf === st.id && x.prompt === f.prompt),
			)
				? UNCHECKED_FINDINGS_HOLD
				: st.result.recorded.length > 0
					? FINDINGS_HOLD
					: findingsHold(st.store.listTasks(), st.task);
		if (hold !== null)
			return { stage: "merging", state: "idle", needsReason: hold };
		if (st.idn.releaseCard && st.task.releaseVersion !== null) {
			const err = await publishReleaseCard(
				st.e,
				st.task,
				st.task.releaseVersion,
				st.header.base,
				st.loc.wt,
				st.header.target,
			);
			if (err !== null)
				return {
					stage: "in_progress",
					state: "needs_you",
					needsReason: err,
				};
		}
		// A cancel before the publish step skips it and is caught by the settle recheck below;
		// from the publish step to the final write, the `publishing` claim refuses a cancel.
		return next;
	}

	/** UI-shot guard: a work turn whose diff touches UI files (uiFiles) but attached no
	 * screenshot warns — the board would otherwise show UI work without visual proof. On a
	 * clean settle it re-prompts: the session resumes with a request to capture the shot.
	 * A second miss parks the card at needs_you instead of letting it settle toward
	 * done: a UI change must not reach done without its screenshot, and only a human
	 * (one more capture attempt, or an explicit cancel) can end the ping-pong. */
	async function guardUiShot(st: TurnSettle, next: Next): Promise<Next> {
		if (
			!(
				st.kind === "work" &&
				!st.idn.interview &&
				!st.idn.grill &&
				!st.idn.scout &&
				!st.research &&
				!st.idn.releaseCard &&
				// This turn's copies count, and so do shots an earlier turn on this card attached:
				// changedFiles is the card's cumulative diff, so without the card's history
				// every later clean turn would re-prompt for a screenshot that already exists.
				!(st.shots ?? st.task.shots).length
			)
		)
			return next;
		const changed = await ops
			.changedFiles(st.loc.wt, st.header.base, st.header.target)
			.catch(() => [] as string[]);
		const ui = uiFiles(changed);
		if (ui.length === 0) return next;
		const priorLog = existsSync(st.store.logPath(st.id))
			? readRegular(st.store.logPath(st.id)).toString("utf8")
			: "";
		appendLog(st.store, st.id, `${UI_SHOT_WARNING}: ${listed(ui)}`);
		if (next.needsReason !== null || st.steered) return next;
		if (!priorLog.includes(UI_SHOT_WARNING))
			return {
				stage: "in_progress",
				state: "queued",
				needsReason:
					"no screenshot attached - resuming automatically to capture one. Cancel to stop it instead.",
				pendingPrompt: uiShotReprompt(ui),
				pendingBy: "supervisor",
			};
		return {
			stage: "in_progress",
			state: "needs_you",
			needsReason: `UI files changed (${listed(ui)}) but still no screenshot was attached. The card cannot finish without one: reply to resume the session and have it capture the shot (report_outcome's shots field), or cancel the card.`,
		};
	}

	/** The unreadable research report holds the card (a release card ships without one, and
	 * a queued continue has not consumed this settle yet). */
	function parkUnreadableReport(st: TurnSettle): Next {
		return {
			stage: "in_progress",
			state: "needs_you",
			needsReason: `The research report file ${RESEARCH_REPORT} cannot be read: ${st.reportError}. Reply to have the agent write it as a regular file, or cancel the card.`,
		};
	}

	/** The delete check: a worktree that still holds changes or unmerged commits is kept, and
	 * the card asks you. A review card's worktree is disposable (mutation runs leave report
	 * files, and a review must not commit), so it skips the check. A research card's worktree
	 * is disposable like a review card's: the report is already harvested. A trending scout's
	 * cwd is the main checkout: what it holds is the user's, never the card's. */
	async function measureUnsavedTree(st: TurnSettle, next: Next): Promise<void> {
		st.unsaved =
			next.stage === "done" &&
			!st.idn.reviewCard &&
			!st.idn.interview &&
			!st.idn.scout &&
			!st.research
				? await ops.unsavedWork(st.loc.wt, st.header.target)
				: null;
	}

	/** The settle writes planned before the row and card land: the unreadable-report park, the
	 * report archive, the delete check, the kept-tree park, and the U7/fork merge holds. */
	async function planSettleWrite(st: TurnSettle, next: Next): Promise<Next> {
		let planned = next;
		if (
			st.reportError !== null &&
			!st.idn.releaseCard &&
			planned.state !== "queued"
		)
			planned = parkUnreadableReport(st);
		await measureUnsavedTree(st, planned);
		planned = await archiveReport(st, planned);
		st.now = Date.now();
		if (st.unsaved)
			planned = {
				stage: st.kind === "work" ? "in_progress" : "merging",
				state: "needs_you",
				needsReason: keptReason(st.unsaved),
			};
		// OTTR-708: the cross-project checkout guard. Only a settle that would otherwise
		// complete asks the question: a card already parked or auto-resumed keeps its own
		// reason. A merging-bound settle (ready with commits) with a violation must park
		// before the merge; a steered requeue (state queued, needsReason null) with a
		// violation also parks, and the pending steering text survives the park.
		// Note: when both a dep hold and a violation apply, the violation reason wins
		// the park — that ordering is acceptable.
		if (
			st.kind === "work" &&
			st.mx.guardBefore !== null &&
			planned.needsReason === null
		) {
			const violation = await checkoutGuardReason(
				projects,
				ops,
				boardPushedHeads,
				st,
				recordGuardNotice,
			);
			if (violation !== null)
				planned = {
					stage: "in_progress",
					state: "needs_you",
					needsReason: violation,
				};
		}
		await measureSettleGit(st, planned);
		return planMergeHolds(st, planned);
	}

	/** A research card's deliverable is the report file: archive it before the worktree goes,
	 * and park a done card whose file never landed. OTTR-488: harvest the steps recommendation
	 * with the report — 'yes' when the report recommends steps by the same detection the drawer
	 * button uses (the exact heading the prompt asks for, or the older shapes OTTR-468 upgraded
	 * the regex to catch, so a stored row can never lose the button a legacy row keeps), 'no'
	 * when a harvested report carries none; no report (or none harvested this settle) writes
	 * nothing. */
	async function archiveReport(st: TurnSettle, next: Next): Promise<Next> {
		if (!(st.research && !st.idn.interview && next.state !== "queued"))
			return next;
		st.report = st.reportText;
		if (next.stage === "done" && st.report === null)
			return {
				stage: "in_progress",
				state: "needs_you",
				needsReason: `The research report file ${RESEARCH_REPORT} is missing from the worktree. Reply to have the agent write it, or cancel the card.`,
			};
		st.steps =
			st.report === null || st.report === undefined
				? undefined
				: recommendsSteps(st.report)
					? ("yes" as const)
					: ("no" as const);
		return next;
	}

	/** The done settle's git reads (the settle reads are slow; a cancel landing inside them
	 * owns the card — its kept path already wrote the final state, and the checks below only
	 * finish the turn row). Kept files ride a kept or release card; a plain done card keeps
	 * none (its worktree goes away). */
	async function measureSettleGit(st: TurnSettle, next: Next): Promise<void> {
		// Stamped with `commits`: the target head at Done anchors the release's late-commit
		// attribution to this card's merge.
		st.commits =
			next.stage === "done"
				? await ops.targetCommits(st.e.path, st.header.target)
				: undefined;
		st.mergeHead =
			next.stage === "done"
				? await ops.targetSha(st.e.path, st.header.target).catch(() => null)
				: undefined;
		st.keptFiles =
			!st.idn.releaseCard && next.stage === "done"
				? []
				: st.unsaved
					? await ops.statusFiles(st.loc.wt)
					: undefined;
	}

	/** True when a card descends from a fork-research card: the parent existing implies the
	 * feature ran, so this is independent of the forkResearch toggle. The hold covers every
	 * descendant: a card an agent files from a fork-born card (create_task) must not merge
	 * without approval either. */
	function isForkBorn(st: TurnSettle): boolean {
		const seen = new Set<string>([st.task.id]);
		let up = st.task.followUpOf;
		let forkBorn = false;
		while (up !== null && !seen.has(up) && !forkBorn) {
			seen.add(up);
			const anc = st.store.getTask(up);
			forkBorn = anc?.topic === "fork research";
			up = anc?.followUpOf ?? null;
		}
		return forkBorn;
	}

	/** U7: an update card on a hold-update-merges project parks for a human approval; the reply
	 * approves the parked head (holdHead), and the next ready work turn integrates only while
	 * HEAD still equals it: a commit after the approval parks the card again. A ready work
	 * settle lands at merging (commits to integrate) or straight done (already integrated).
	 * fork-born tasks (analysis proposals AND manual follow-ups of a fork research card) always
	 * hold their merge for approval. A read-only retro has nothing to merge; holding it blocks
	 * later retros. The forkMergeHold switch gates new holds (OTTR-689): with it off a fork-born
	 * card merges like any work card. A card already parked on a fork hold (a parked head, its
	 * fork approval not spent) stays held with the switch off, so it still needs an approval
	 * at its parked head; only the approving settle lifts that one. */
	async function planMergeHolds(st: TurnSettle, next: Next): Promise<Next> {
		const readyWork =
			st.kind === "work" && (next.stage === "done" || next.stage === "merging");
		const updateHold =
			readyWork &&
			st.task.updateIds.length > 0 &&
			st.store.getSettings().holdUpdateMerges;
		const forkHold =
			readyWork &&
			isForkBorn(st) &&
			!st.idn.retroCard &&
			(st.store.getSettings().forkMergeHold ||
				(st.task.holdHead !== null && st.task.forkMergeHead === null));
		const { head, holdLanded } = await resolveHoldHead(
			st,
			updateHold,
			forkHold,
		);
		// A null head (git failed) never matches: the hold fails closed.
		const holdReason = holdReasonFor(
			st,
			updateHold,
			forkHold,
			head,
			holdLanded,
		);
		if (holdReason === null) return next;
		st.holdHead = head;
		st.holdReason = holdReason;
		st.commits = undefined; // not done: the approving settle re-measures
		// OTTR-766: on a merging-bound settle the work check judges the head before the
		// hold parks the card — the user approves a checked head. The park rides holdPark
		// and lands after the check's verdict (writePostCheckState); a send-back or a
		// failed check wins instead, and the next ready re-settles the hold.
		if (next.stage === "merging" && isWorkCard(st)) {
			st.holdPark = {
				stage: "in_progress",
				state: "needs_you",
				needsReason: holdReason,
			};
			return next;
		}
		return {
			stage: "in_progress",
			state: "needs_you",
			needsReason: holdReason,
		};
	}

	/** The plain work-card predicate planTurnChecks stamps on the settle: a merge-hold park
	 * that a work check must precede (OTTR-766) shares it, so a deferred park happens only
	 * where the check gate fires too. */
	function isWorkCard(st: TurnSettle): boolean {
		return (
			st.kind === "work" &&
			!st.research &&
			!st.idn.reviewCard &&
			!st.idn.releaseCard &&
			!st.idn.interview &&
			!st.idn.grill &&
			!st.idn.scout &&
			!st.idn.retroCard
		);
	}

	/** The HEAD the hold pins and whether the approved merge already landed: AGEN-24 — the
	 * approving turn may integrate by itself (a project's AGENTS.md can tell it to merge) and
	 * remove the worktree before it reports; the HEAD read then returns null and the hold
	 * below parked the approved card again while the work already sat on the target. When the
	 * target already contains the head the reply approved, the merge landed: let the settle
	 * finish instead of parking again. */
	async function resolveHoldHead(
		st: TurnSettle,
		updateHold: boolean,
		forkHold: boolean,
	): Promise<{ head: string | null; holdLanded: boolean }> {
		const head =
			updateHold || forkHold
				? await ops.targetSha(st.loc.wt, "HEAD").catch(() => null)
				: null;
		const approvedHead = updateHold
			? st.task.updateMergeHead
			: forkHold
				? st.task.forkMergeHead
				: null;
		const holdLanded =
			head === null &&
			approvedHead !== null &&
			(await ops
				.targetContains(st.e.path, approvedHead, st.header.target)
				.catch(() => false));
		return { head, holdLanded };
	}

	/** Which hold reason parks the settle, if any: the hold fails closed — a null head (git
	 * failed) never matches, and a head that is not exactly the approved one parks. */
	function holdReasonFor(
		st: TurnSettle,
		updateHold: boolean,
		forkHold: boolean,
		head: string | null,
		holdLanded: boolean,
	): string | null {
		if (holdLanded) return null;
		if (updateHold && (head === null || st.task.updateMergeHead !== head))
			return UPDATE_HOLD_REASON;
		if (forkHold && (head === null || st.task.forkMergeHead !== head))
			return FORK_HOLD_REASON;
		return null;
	}

	/** OTTR-531: sync-commit hygiene findings land on the card before any settle write. */
	async function recordSyncFindings(st: TurnSettle): Promise<void> {
		const outcome = st.result.outcome;
		if (outcome === null) return;
		const lines = await syncCommitFindings();
		if (lines.length === 0) return;
		st.result = {
			...st.result,
			outcome: {
				...outcome,
				details: `${outcome.details ?? ""}${outcome.details ? "\n\n" : ""}${lines.join("\n")}`,
			},
		};
	}

	/** A cancel that landed inside the slow settle git reads owns the card (its kept path
	 * already wrote the final state): finish only the turn row and leave the card alone.
	 * True: the turn stops. */
	function settleCancelled(st: TurnSettle, now: number): boolean {
		const settled = st.store.getTask(st.id);
		if (
			!settled ||
			settled.cancelledAt !== null ||
			(settled.state !== "running" && settled.state !== "preparing")
		) {
			st.store.finishTurn(st.dispatch.turn.id, {
				endedAt: now,
				exitCode: st.result.exitCode,
				error: "cancelled",
			});
			return true;
		}
		return false;
	}

	/** Finishes the turn row: the served model (with the dispatch's thinking level re-attached
	 * when the bases match; and the dispatched selector when the run fell back to another
	 * model), the outcome, and the question (only a tool ask marks the turn as a question: a
	 * needs_you report's free-text question field is often a hold instruction ("re-run after
	 * X"), not a question, so the timeline keeps its alert styling unless the ask tool actually
	 * ran). True: the turn stopped (a cancel owned the card). */
	function finishTurnRow(st: TurnSettle, next: Next): boolean {
		if (settleCancelled(st, st.now)) return true;
		// The model the stream served, with the dispatch's thinking level re-attached when the
		// bases match; and the dispatched selector when the run fell back to another model.
		const served = turnModel(st.result.model, st.route.runModel);
		const swap = modelSwap(st.result.model, st.route.runModel);
		if (swap !== null)
			st.log(
				`! model swap: dispatched ${swap} but the run served ${served}${st.result.providerError ? ` (${st.result.providerError})` : ""} — the card keeps ${swap} for its next turn`,
			);
		st.store.finishTurn(st.dispatch.turn.id, {
			endedAt: st.now,
			exitCode: st.result.exitCode,
			// live is the turn's own snapshot: the selector this run started with (switches land in-between turns).
			// Without a served model (a crash before message_start) the dispatch snapshot stands.
			model: served ?? st.dispatch.turn.model,
			// The fallback proof: the selector the run was dispatched with, kept only when the
			// run served another model's base, so the timeline can name the swap.
			dispatchedModel: swap,
			ranOn: st.result.ranOn ?? null,
			outcome: st.result.outcome?.status ?? null,
			summary: st.result.outcome?.summary ?? null,
			details: st.result.outcome?.details ?? (st.result.finalText || null),
			// Only a tool ask marks the turn as a question: a needs_you report's free-text
			// question field is often a hold instruction ("re-run after X"), not a question,
			// so the timeline keeps its alert styling unless the ask tool actually ran.
			question: st.result.asked?.[0]?.question ?? null,
			error: next.needsReason, // null on success; an automatic continue keeps its reason for the next classify
		});
		return false;
	}

	/** A finished work card gets one second-model check before the merge queue takes it:
	 * a fresh, memory-less session with read/grep/glob verifies the ready report against the
	 * branch diff and the work transcript, and every blocker must quote one of them. Only a
	 * plain work card that classify classified as merging gets here; the check's verdict (or
	 * a skipped check) decides the final stored state. A review that parked needs_you still
	 * files its findings (OTTR-322): a failed gate must not hide them. A later turn of the
	 * same review re-records its findings: skip by prompt text the ones that already have a
	 * card linked to it. A second-model check (review findings, work check) runs below while
	 * the card is still in_progress/running: the final stage/state only lands once the check's
	 * verdict — or a skipped check — is in, so the schedule tick can neither pick the card for
	 * a merge turn nor settle a parked review early. */
	function planTurnChecks(st: TurnSettle, next: Next): void {
		st.workCard = isWorkCard(st);
		st.reviewFindings =
			st.idn.reviewCard &&
			st.task.findingsCheckedAt === null &&
			(next.stage === "merging" || next.state === "needs_you")
				? // The union of the card's stored findings (arrival persistence) and this
					// run's recorded ones, deduped by prompt with the stored entries first;
					// the stored set alone is the source in production, the union keeps
					// run-result delivery working.
					(() => {
						const stored = st.store.listReviewFindings(st.id);
						const seen = new Set(stored.map((f) => f.prompt));
						const all = [...stored];
						for (const f of st.result.recorded)
							if (!seen.has(f.prompt)) {
								seen.add(f.prompt);
								all.push(f);
							}
						return all.filter((f) => {
							const linked = st.store
								.listTasks()
								.some((x) => x.followUpOf === st.id && x.prompt === f.prompt);
							return !linked;
						});
					})()
				: [];
		st.checkWillRun =
			st.reviewFindings.length > 0 || (st.workCard && next.stage === "merging");
	}

	/** The stage/state columns ride the card write only when no second-model check runs: the
	 * check's verdict (or a skipped check) decides the final stored state below. */
	function settledCardState(
		st: TurnSettle,
		next: Next,
	):
		| {
				stage: Next["stage"];
				state: Next["state"];
				needsReason: string | null;
				queuedAt: number | null | undefined;
				holdUntil?: number;
				holdProvider?: string | null;
				holdWindow?: string | null;
		  }
		| Record<string, never> {
		if (st.checkWillRun) return {};
		return {
			stage: next.stage,
			state: next.state,
			needsReason: next.needsReason,
			queuedAt: next.state === "queued" ? st.now : st.task.queuedAt,
			// A usage-limit continue's reset hold; undefined keeps the column.
			// The owner rides with it so the quota refresh can release early.
			...(next.holdUntil !== undefined
				? {
						holdUntil: next.holdUntil,
						holdProvider: next.holdProvider ?? null,
						holdWindow: next.holdWindow ?? null,
					}
				: {}),
		};
	}

	/** The card's summary, details, and the report's own `topic:` line that groups the card on
	 * the board (null -> undefined keeps the column). */
	function settledCardText(
		st: TurnSettle,
		next: Next,
	): {
		summary: string | null;
		details: string | null;
		topic: string | undefined;
	} {
		const body =
			st.result.outcome?.details ?? (st.result.finalText || st.task.details);
		return {
			summary:
				st.idn.releaseCard && next.stage === "done"
					? `Released ${st.task.releaseVersion}`
					: (st.result.outcome?.summary ?? st.task.summary),
			details:
				st.result.outcome?.details ?? (st.result.finalText || st.task.details),
			topic: parseTopicReport(body) ?? undefined,
		};
	}

	/** Stores the settle on the card row: the (deferred) stage/state, shots, the pending
	 * prompt, the ask, text, the git facts, the report, and the hold columns. */
	function writeSettledCard(st: TurnSettle, next: Next): void {
		st.store.updateTask(st.id, {
			...settledCardState(st, next),
			shots: st.shots,
			pendingPrompt: next.pendingPrompt, // undefined keeps the column: only classify's automatic continue sets it
			// Authorship rides only when the prompt is actually written; classify's
			// automatic continue is the board's own voice.
			...(next.pendingPrompt !== undefined
				? { pendingBy: next.pendingBy ?? "supervisor" }
				: {}),
			asked: next.asked ?? null, // updateTask stringifies arrays; null clears — cleared whenever the turn did not end on a fresh ask
			...settledCardText(st, next),
			commits: st.commits,
			mergeHead: st.mergeHead,
			// A research card's write is exact (null clears a report the card cleared
			// itself); any other settle that harvested nothing keeps the stored text.
			report: st.research ? st.report : (st.report ?? undefined),
			steps: st.steps,
			keptFiles: st.keptFiles,
			// Every settle rewrites it: only a hold this settle parked keeps a head to
			// approve. A deferred park (holdPark) writes its head only when the park
			// lands after the check (writePostCheckState); a send-back keeps no head.
			holdHead: st.holdPark === null ? st.holdHead : null,
			// A merge-hold mismatch park serves the reviewer the exact push-side delta it
			// flagged (undefined keeps the column): the live worktree diff no longer speaks
			// for the push set once the branch is integrated.
			diffFiles: st.holdFiles ?? undefined,
			diffText: st.holdDiff ?? undefined,
			// A park spends that hold's approval (undefined keeps the column): a stale approval never
			// carries into a later settle. Only the parked hold's column clears, so an approved
			// update hold survives a fork-hold park of the same card. A deferred park spends
			// nothing here — its park write below does, and only when it lands.
			updateMergeHead:
				st.holdPark === null && st.holdReason === UPDATE_HOLD_REASON
					? null
					: undefined,
			forkMergeHead:
				st.holdPark === null && st.holdReason === FORK_HOLD_REASON
					? null
					: undefined,
		});
	}

	/** A retro's proposal is filed as a held card (needs_you, followUpOf this retro): the
	 * settle recheck above confirmed the card is still ours, so this write is safe.
	 * A proposal whose call named a project files on that project's store (OTTR-787):
	 * a change to rules, skills or AGENTS.md sources targets agent-data, and a card
	 * there edits that checkout without tripping the cross-project checkout guard.
	 * followUpOf keeps pointing at the retro, so the Decide panel works unchanged. */
	async function fileRetroProposal(st: TurnSettle, next: Next): Promise<void> {
		if (
			!(
				st.idn.retroCard &&
				next.stage === "done" &&
				st.result.proposed !== null
			)
		)
			return;
		const targetName = st.result.proposed.project;
		let store = st.store;
		if (targetName !== null && targetName !== st.store.name) {
			const tp = projects.get(targetName);
			if (tp === undefined) {
				st.log(
					`retro: proposal dropped: unknown project "${targetName}" (known projects: ${[...projects.keys()].join(", ")})`,
				);
				return;
			}
			store = tp.store;
		}
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
			st.log("retro: proposal dropped: cap of 3 open proposals reached");
			return;
		}
		const child = store.createTask(st.result.proposed.prompt);
		const handoffPath = join(store.tasksDir, "handoffs", `${child.id}.md`);
		let prompt = followUpPrompt({
			text: st.result.proposed.prompt,
			title: st.task.title,
			handoffPath,
		});
		try {
			writeBelow(
				store.dataRoot,
				handoffPath,
				handoffMarkdown({
					task: st.store.getTask(st.id) ?? st.task,
					turns: st.store.listTurns(st.id),
					sessionsDir: st.store.sessionsDir,
				}),
			);
		} catch (err) {
			// The card is still held; it just starts without the handoff pointer.
			prompt = st.result.proposed.prompt;
			st.log(`! handoff write failed: ${errmsg(err)}`);
		}
		store.updateTask(child.id, {
			prompt,
			followUpOf: st.id,
			// A foreign filing stores the retro's project, so the lineage rail
			// links the parent across the board (null keeps the own project).
			followUpOfProject: store === st.store ? null : st.store.name,
			// A null model means the proposal card runs on the default role.
			model: st.result.proposed.model,
			state: "needs_you",
			// The reason names the retro's source card once; a missing link falls
			// back to naming the retro itself.
			needsReason: proposedReason(
				(st.task.followUpOf !== null
					? st.store.getTask(st.task.followUpOf)
					: null) ?? { id: st.task.id },
			),
			// The drawer's decision panel reads it; older proposals keep null.
			proposalSummary: st.result.proposed.summary,
		});
		st.log(
			store === st.store
				? `- filed proposal ${child.id} (held for approval)`
				: `- filed proposal ${child.id} in project ${store.name} (held for approval)`,
		);
	}

	/** A review's recorded findings: Ottr caps them, checks the selection with a second model
	 * (a fresh session — never --resume, never the review's own — memory off, read/grep/glob
	 * only), and files the kept ones as queued cards linked to the review, the flow
	 * create_task's per-finding calls did inline before. An approved review holds at merging
	 * (FINDINGS_HOLD) and a needs_you review keeps its park: either way the card stays
	 * in_progress/running until the deferred write below stores the final state.
	 * True: the turn stopped (a credit stop or a taken-over check). */
	async function runReviewCheck(st: TurnSettle): Promise<boolean> {
		if (st.reviewFindings.length === 0) return false;
		const checkOn = ops.reviewCheck?.() ?? true;
		// Leads (the prompt's "Needs validation" tag) never enter the selection or the cap:
		// they file as unverified backlog cards without a second-model opinion.
		const confirmed = st.reviewFindings.filter(
			(f) => !f.prompt.startsWith("Needs validation"),
		);
		const leads = st.reviewFindings.filter((f) =>
			f.prompt.startsWith("Needs validation"),
		);
		const selected = selectFindings(confirmed);
		const selectedSet = new Set(selected);
		const belowCap = confirmed.filter((f) => !selectedSet.has(f));
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
			const attempt = await reviewCheckAttempts(st, selected);
			if (attempt === null) return true;
			kept = attempt.kept;
			dropped = attempt.dropped;
			checkMs = attempt.checkMs;
			checkFailed = attempt.checkFailed;
			checkModel = attempt.checkModel;
			checkWarn = attempt.checkWarn;
			await settleReviewCheckFailure(st, attempt);
		} else {
			for (const f of belowCap)
				st.log(`- finding below the cap of 10, not filed: ${findingHead(f)}`);
		}
		fileKeptFindings(st, {
			kept,
			dropped,
			belowCap,
			leads,
			checkOn,
			checkMs,
			checkFailed,
			checkModel,
			checkWarn,
		});
		// Only a completed pass (check on or off, trail written) stamps the set: a failed
		// or stopped attempt leaves the findings unchecked for the next landing.
		if (checkFailed === null)
			st.store.updateTask(st.id, { findingsCheckedAt: Date.now() });
		return false;
	}

	/** Runs the review-check attempts (two, then the user decides: a half-checked review files
	 * no cards). A usage limit skips the retry: it fails the same way until the reset.
	 * Null: a credit stop or a taken-over check stopped the turn. */
	async function reviewCheckAttempts(
		st: TurnSettle,
		selected: RecordedFinding[],
	): Promise<{
		kept: { id: number; finding: RecordedFinding }[];
		dropped: { id: number; finding: RecordedFinding; reason: string }[];
		checkMs: number;
		checkFailed: string | null;
		checkModel: string | null;
		checkWarn: "same model" | "same vendor" | null;
		hold: UsageHold | null;
		limitHit: boolean;
	} | null> {
		const built = await reviewCheckInput(st, selected);
		const loop = await reviewCheckLoop(st, selected, built);
		if (loop === null) return null;
		return {
			kept: loop.kept,
			dropped: loop.dropped,
			checkMs: loop.checkMs,
			checkFailed: loop.checkFailed,
			checkModel: built.checkModel,
			checkWarn: built.checkWarn,
			hold: loop.hold,
			limitHit: loop.limitHit,
		};
	}

	/** The review check's input as data: the findings (numbered from 1), the frozen sha, the
	 * open cards, and the commits main gained since the review — the one git fact a run
	 * without a shell cannot see for itself. Also the model the check resolves to (the role's
	 * selector, else the board's default role — omp's fallback) and why it gives no
	 * second-model opinion, for the card. */
	async function reviewCheckInput(
		st: TurnSettle,
		selected: RecordedFinding[],
	): Promise<{
		input: string;
		checkRole: string;
		selector: string | undefined;
		checkModel: string | null;
		checkWarn: "same model" | "same vendor" | null;
	}> {
		const [openCards, commitsSince] = await Promise.all([
			Promise.resolve(
				st.store
					.listTasks()
					.filter(
						(x) =>
							x.id !== st.id && x.cancelledAt === null && x.stage !== "done",
					)
					.map((x) => ({ id: x.id, title: x.title })),
			),
			st.task.base !== null && st.header.target !== null
				? (ops.commitSubjects ?? commitSubjects)(
						st.e.path,
						st.task.base,
						st.header.target,
					)
				: Promise.resolve([] as string[]),
		]);
		const roles = (ops.modelRoles ?? modelRoles)();
		const checkRole = checkRoleFor(st.result.model);
		const selector = roles[checkRole];
		// A missing role falls back to the board's default role (omp's default
		// model), which is often the reviewed model itself — shown on the card.
		const checkModel = selector ?? roles.default ?? null;
		const checkWarn = checkModelWarning(st.result.model, checkModel);
		const input = reviewCheckPrompt({
			sha: st.task.base ?? "",
			findings: selected.map((f, i) => ({
				id: i + 1,
				rank: f.rank,
				security: f.security ?? "",
				prompt: f.prompt,
			})),
			openCards,
			commitsSince,
		});
		return { input, checkRole, selector, checkModel, checkWarn };
	}

	/** The review check attempts (two, then the user decides: a half-checked review files no
	 * cards). A usage limit skips the retry: it fails the same way until the reset.
	 * Null: a credit stop or a taken-over check stopped the turn. */
	async function reviewCheckLoop(
		st: TurnSettle,
		selected: RecordedFinding[],
		built: {
			input: string;
			checkRole: string;
			selector: string | undefined;
		},
	): Promise<{
		kept: { id: number; finding: RecordedFinding }[];
		dropped: { id: number; finding: RecordedFinding; reason: string }[];
		checkMs: number;
		checkFailed: string | null;
		hold: UsageHold | null;
		limitHit: boolean;
	} | null> {
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
		let hold: UsageHold | null = null;
		let limitHit = false;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const ran = await awaitCheckAttempt(
				st,
				built.input,
				built.selector,
				built.checkRole,
				`${st.key}:check`,
			);
			if (ran === null) return null;
			checkMs += ran.checkMs;
			const out = reviewAttemptOutcome(selected, ran.result);
			if (out.split !== null) {
				kept = out.split.kept;
				dropped = out.split.dropped;
				checkFailed = null; // the retry succeeded
				break;
			}
			checkFailed = out.failed;
			limitHit = out.limitHit;
			st.log(`! review check attempt ${attempt} failed: ${checkFailed}`);
			if (limitHit) {
				hold = await usageHold(ran.result.model ?? built.selector ?? null);
				break;
			}
		}
		return { kept, dropped, checkMs, checkFailed, hold, limitHit };
	}

	/** One review-check attempt's outcome: the kept/dropped split on a valid JSON verdict
	 * (split null on an invalid one), else the failure reason and whether a usage limit
	 * caused it. */
	function reviewAttemptOutcome(
		selected: RecordedFinding[],
		result: RunResult,
	): {
		split: {
			kept: { id: number; finding: RecordedFinding }[];
			dropped: { id: number; finding: RecordedFinding; reason: string }[];
		} | null;
		failed: string;
		limitHit: boolean;
	} {
		const err = checkRunError(result);
		if (err === null) {
			const verdicts = parseCheckVerdicts(result.finalText);
			if (verdicts === null)
				return {
					split: null,
					failed: "the check verdict was not valid JSON",
					limitHit: false,
				};
			return {
				split: applyCheckVerdicts(selected, verdicts),
				failed: "",
				limitHit: false,
			};
		}
		return { split: null, failed: err, limitHit: hitUsageLimit(result) };
	}

	/** One check attempt (shared by the review and work checks): a credit stop before and
	 * after, the meter, the run, and the takeover check. Null: the turn stopped. */
	async function awaitCheckAttempt(
		st: TurnSettle,
		input: string,
		selector: string | undefined,
		checkRole: string,
		checkKey: string,
	): Promise<{ result: RunResult; checkMs: number } | null> {
		// Hosted: no check attempt starts under a credit stop, the retry included.
		if (st.creditBlocked()) return null;
		const startedAt = Date.now();
		const checkMeter = st.openMeter(
			selector === undefined ? "default" : checkRole,
		);
		const handle = startCheckRun(st, input, selector, checkMeter);
		const result = await awaitCheckRun(st, checkKey, handle, checkMeter);
		if (result === null) return null;
		// A creditStop killed this check: park with the credit reason, no retry.
		if (st.creditBlocked()) return null;
		return { result, checkMs: Date.now() - startedAt };
	}

	/** Starts one second-model check run in the card's worktree: a fresh session (never
	 * --resume, never the checked run's own — memory off), read/grep/glob only, the
	 * check.yml config, capped at 30 minutes. The check's transcript lands in the card's
	 * log, next to the run it checks. */
	function startCheckRun(
		st: TurnSettle,
		input: string,
		selector: string | undefined,
		checkMeter: ReturnType<OpenRunMeter>,
	): TurnRunHandle {
		return ops.startRun({
			meter: ops.hosted !== undefined,
			auditProvisioned: (sinceMs, rulesAtStart) =>
				auditProvisioned(homedir(), sinceMs, rulesAtStart),
			rulesAtStart: () => rulesDirEntries(homedir()),
			...(checkMeter !== null && { onUsage: checkMeter.onUsage }),
			cwd: st.loc.wt,
			prompt: input,
			sessionDir: st.store.sessionsDir,
			extensionPath: null,
			resumeId: null,
			model: selector,
			tools: "read,grep,glob",
			config: join(dirname(ops.extensionPath), "check.yml"),
			maxTime: "1800",
			dataRoot: st.store.dataRoot,
			// The check's transcript lands in the card's log, next to the run it checks.
			logPath: st.store.logPath(st.id),
			onLog: () => ops.notifyLog(st.name, st.id),
		});
	}

	/** Awaits one check run. The check holds a board slot like any run: it sits in the loop's
	 * live map, so the global cap sees it until it ends. sweepLostTurns settling a lost check
	 * owns the card: null and checkTakenOver tell the caller to stop. */
	async function awaitCheckRun(
		st: TurnSettle,
		checkKey: string,
		handle: TurnRunHandle,
		checkMeter: ReturnType<OpenRunMeter>,
	): Promise<RunResult | null> {
		running.set(checkKey, handle);
		const checkResult = (await handle.done) as RunResult;
		checkMeter?.settle(checkResult);
		// sweepLostTurns settled a lost check: its outcome owns the card now.
		if (running.get(checkKey) !== handle) {
			st.mx.checkTakenOver = true;
			return null;
		}
		running.delete(checkKey);
		return checkResult;
	}

	/** A failed check: hold the card on the usage reset when one is known, else park needs_you
	 * for a re-run. A passing check logs the dropped findings instead. */
	async function settleReviewCheckFailure(
		st: TurnSettle,
		attempt: NonNullable<Awaited<ReturnType<typeof reviewCheckAttempts>>>,
	): Promise<void> {
		if (attempt.checkFailed === null) {
			for (const d of attempt.dropped)
				st.log(`- dropped finding ${d.id}: ${d.reason}`);
			return;
		}
		if (attempt.hold !== null) {
			parkReviewCheckHold(st, attempt.hold);
			return;
		}
		st.log(`- review check gave up after a retry: ${attempt.checkFailed}`);
		const cur = st.store.getTask(st.id);
		if (cur !== null && cur.cancelledAt === null)
			st.store.updateTask(st.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: `The review check failed${attempt.limitHit ? "" : " twice"}: ${attempt.checkFailed}. Reply to re-run the review, or cancel the card.`,
			});
	}

	/** Holds the review card on the provider's usage reset (the write only lands when the card
	 * is still this run's). */
	function parkReviewCheckHold(st: TurnSettle, hold: UsageHold): void {
		st.log(
			`- review check held until ${new Date(hold.holdUntil).toISOString()}: usage limit`,
		);
		const patch = holdPatch(st.store, st.id, hold);
		if (patch !== null) st.store.updateTask(st.id, patch);
	}

	/** Files the kept findings as queued cards linked to the review (the flow create_task's
	 * per-finding calls did inline before), logs the counts, and writes every unfiled finding
	 * with its reason onto the review card so the user can file any of them by hand. */
	function fileKeptFindings(
		st: TurnSettle,
		args: {
			kept: { id: number; finding: RecordedFinding }[];
			dropped: { id: number; finding: RecordedFinding; reason: string }[];
			belowCap: RecordedFinding[];
			leads: RecordedFinding[];
			checkOn: boolean;
			checkMs: number;
			checkFailed: string | null;
			checkModel: string | null;
			checkWarn: "same model" | "same vendor" | null;
		},
	): void {
		const filed: string[] = [];
		const live = st.store.getTask(st.id);
		if (args.checkFailed === null && live !== null && live.cancelledAt === null)
			for (const k of args.kept) {
				const child = st.store.createTask(k.finding.prompt);
				st.store.updateTask(child.id, {
					followUpOf: st.id,
					// A null model means the finding card runs on the default role.
					model: k.finding.model,
				});
				filed.push(child.id);
			}
		// Leads file with or without a check verdict: they are unverified by definition
		// (the second-model check never ran on them), so they hold no cap slot.
		if (live !== null && live.cancelledAt === null)
			for (const lead of args.leads) {
				const child = st.store.createTask(lead.prompt);
				st.store.updateTask(child.id, {
					followUpOf: st.id,
					model: lead.model,
					stage: "backlog",
					state: "idle",
					queuedAt: null,
					details: `Unverified lead from review ${st.id}: the second-model check did not run on this finding (needs validation).`,
				});
				filed.push(child.id);
				st.log(
					`- filed lead as backlog card #${child.id} (unverified): ${findingHead(lead)}`,
				);
			}
		st.log(
			`- review findings: ${st.reviewFindings.length} recorded, ${filed.length} filed, ${
				args.belowCap.length + args.dropped.length
			} not filed${args.checkOn ? `, check ${(args.checkMs / 1000).toFixed(0)}s` : ", check off"}`,
		);
		// The counts and every unfiled finding with its reason live on the review card: the
		// user can file any of them by hand.
		const cur = st.store.getTask(st.id);
		if (args.checkFailed !== null || cur === null || cur.cancelledAt !== null)
			return;
		const notFiled = [
			...args.belowCap.map((f) => `- below the cap of 10: ${findingHead(f)}`),
			...args.dropped.map(
				(d) => `- dropped: ${findingHead(d.finding)} — ${d.reason}`,
			),
		];
		writeReviewFindingsCard(st, cur, filed, notFiled, args);
	}

	/** Writes the finding counts and every unfiled finding with its reason onto the review
	 * card, so the user can file any of them by hand. */
	function writeReviewFindingsCard(
		st: TurnSettle,
		cur: Task,
		filed: string[],
		notFiled: string[],
		args: {
			checkOn: boolean;
			checkMs: number;
			checkModel: string | null;
			checkWarn: "same model" | "same vendor" | null;
		},
	): void {
		st.store.updateTask(st.id, {
			summary: `${cur.summary ?? "Review finished"}\nFindings: ${st.reviewFindings.length} recorded, ${filed.length} filed, ${notFiled.length} not filed${args.checkOn ? ` (check ${(args.checkMs / 1000).toFixed(0)}s on ${args.checkModel ?? "default model"}${args.checkWarn === null ? "" : ` — ${args.checkWarn} as the review`})` : ""}.`,
			details: `${cur.details ?? ""}\n\n## Findings\n${
				filed.length > 0
					? filed.map((cid) => `- filed as card #${cid}`).join("\n")
					: "- none filed"
			}\n${notFiled.join("\n")}`,
		});
	}

	/** Runs the second-model check on a work card that classify sent to merging. True: the
	 * turn stopped. */
	async function runWorkCheck(st: TurnSettle, next: Next): Promise<boolean> {
		if (!(st.workCard && next.stage === "merging")) return false;
		return prepareWorkCheck(st);
	}

	/** The work-check gate: off by switch, on a cancelled card, or on a card that stopped
	 * running skips the check entirely (the deferred write below stores the classify state). */
	async function prepareWorkCheck(st: TurnSettle): Promise<boolean> {
		const checkOn = ops.workCheck?.() ?? true;
		const head = await ops.targetSha(st.loc.wt, "HEAD").catch(() => null);
		const cur = st.store.getTask(st.id);
		if (!(checkOn && cur !== null && cur.cancelledAt === null)) return false;
		return routeWorkCheck(st, cur, head);
	}

	/** Routes a work card due for its check: every ready report after a send-back gets a
	 * fresh check (new commits, a human word, or just a re-reported ready — the update may
	 * be new evidence or a corrected claim, and only a fresh session judges it); a head
	 * that already passed skips it. */
	async function routeWorkCheck(
		st: TurnSettle,
		cur: Task,
		head: string | null,
	): Promise<boolean> {
		const priorLog = cur.workCheckLog;
		const open = openWorkBlockers(priorLog);
		const seen = head !== null && cur.workCheckHead === head;
		// Human messages since the last check started (a reply approving a hard stop,
		// or steering): they re-open the check at an unchanged head. The tracker's own
		// send-back texts are not human input. ponytail: only the send-back prefix is
		// filtered; a tracker prompt from another flow (rare here) would cost one
		// extra check run, not a wrong verdict.
		const lastRun = priorLog[priorLog.length - 1];
		const lastCheckAt = lastRun === undefined ? 0 : lastRun.at;
		const replies = st.store
			.listTurns(st.id)
			.filter(
				(t) =>
					t.input !== null &&
					t.startedAt > lastCheckAt &&
					!t.input.startsWith(WORK_CHECK_SENDBACK_OPENING),
			)
			.map((t) => t.input as string);
		// A directed send-back (the user's typed direction, or the board's rethink on a
		// counts-only park) rides in the log, out of band — never parsed from the sent-back
		// text, which carries agent-controlled quotes. The last blockers run holds it until a
		// newer run supersedes it, so it reaches exactly the checks that follow that send-back.
		for (let i = priorLog.length - 1; i >= 0; i--) {
			const run = priorLog[i];
			if (run === undefined || run.outcome !== "blockers") continue;
			if (run.direction !== undefined) replies.push(run.direction);
			break;
		}
		// Every ready report after a send-back gets a fresh check, even at an
		// unchanged head with no new report text: the update may be new evidence
		// (a run the transcript now shows) or a corrected claim, and only a fresh
		// session judges it. A re-ready after a passing check at an unchanged head
		// starts nothing: the last check passed and nothing changed.
		if (!seen || open.length > 0)
			return attemptWorkCheck(st, cur, head, priorLog, open, replies);
		// seen with no open blockers: this head already passed a check; the deferred
		// write below stores merging/queued.
		return false;
	}

	/** Send the blockers back to the work agent, or ask the user once the cap is spent: only
	 * a fresh verdict reaches this, and a send-back counts as an attempt against the same
	 * WORK_CHECK_MAX_SENDBACKS cap. A block after the cap asks the user: the reply
	 * route turns a click into the send-back or the merge (no board check skill needed to
	 * unstick it). */
	function sendWorkCheckBack(
		st: TurnSettle,
		cur: Task,
		head: string | null,
		blockers: WorkCheckBlocker[],
		runs: WorkCheckRun[],
	): void {
		const sendbacks = cur.workCheckSendbacks;
		// The ready report of the run being checked: the outcome's summary and
		// details, else the run's final message. The first completed check stamps
		// it on the card as the original result every later re-check gets.
		const readyReport = readyReportText(st.result.outcome, st.result.finalText);
		const reportStamp =
			cur.workCheckReport === null ? { workCheckReport: readyReport } : {};
		// The divergence park precedes the cap: a loop whose counts never drop, or
		// that keeps re-raising one bug class, signals a wrong shared premise
		// (GUARDRAILS 14a), so no further send-back goes out and the user picks the
		// new direction, a merge, or a cancel. The cap stays the outer bound for
		// loops that still improve.
		if (workCheckDiverged(runs)) {
			st.store.updateTask(st.id, {
				stage: "in_progress",
				state: "needs_you",
				needsReason: workCheckDivergeReason(runs),
				asked: workCheckDivergeAsk(runs),
				workCheckLog: runs,
				workCheckHead: head,
				...reportStamp,
			});
			const counts = workCheckBlockerCounts(runs);
			const repeated = repeatedBugClasses(runs);
			const why = [
				workCheckCountsDiverged(runs)
					? `counts ${counts.join(", ")} did not drop`
					: null,
				repeated.length > 0
					? `repeated bug class${repeated.length > 1 ? "es" : ""} ${repeated.map((c) => `"${c}"`).join(", ")}`
					: null,
			].filter((part) => part !== null);
			st.log(`- work check: diverging loop parked (${why.join("; ")})`);
			return;
		}
		if (sendbacks >= WORK_CHECK_MAX_SENDBACKS) {
			st.store.updateTask(st.id, {
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
			return;
		}
		st.store.updateTask(st.id, {
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
		st.log(
			`- work check: sent back to the work agent (${sendbacks + 1} of ${WORK_CHECK_MAX_SENDBACKS})`,
		);
	}

	/** Runs the second-model check on a work card that classify sent to merging (two attempts,
	 * then the user decides: an unchecked card never merges; a usage limit skips the retry: it
	 * fails the same way until the reset). At an unchanged head (a reply- or evidence-driven
	 * re-check) the full diff stays, so the check can re-cite an earlier blocker's quote
	 * verbatim; a re-check after new commits sees only those commits: the checked code was
	 * already reviewed once, and repeat checks mostly re-flag old code. True: the turn stopped. */
	async function attemptWorkCheck(
		st: TurnSettle,
		cur: Task,
		head: string | null,
		priorLog: WorkCheckRun[],
		open: WorkCheckBlocker[],
		replies: string[],
	): Promise<boolean> {
		const built = await workCheckInput(st, cur, head, open, replies);
		const roles = workCheckRoles(st);
		return workCheckAttempts(st, cur, head, open, priorLog, roles, built);
	}

	/** The work check attempts (two, then the user decides: an unchecked card never merges;
	 * a usage limit skips the retry: it fails the same way until the reset).
	 * True: the turn stopped. */
	async function workCheckAttempts(
		st: TurnSettle,
		cur: Task,
		head: string | null,
		open: WorkCheckBlocker[],
		priorLog: WorkCheckRun[],
		roles: Awaited<ReturnType<typeof workCheckRoles>>,
		built: { input: string; diff: string; transcriptText: string },
	): Promise<boolean> {
		const checkStart = Date.now();
		let checkMs = 0;
		let checkFailed: string | null = null;
		let limitHit = false;
		let hold: UsageHold | null = null;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const ran = await awaitWorkCheckAttempt(
				st,
				built.input,
				roles.selector,
				roles.checkRole,
			);
			if (ran === null) return true;
			checkMs += ran.checkMs;
			const out = workAttemptOutcome(ran.result);
			if (out.verdict !== null) {
				applyWorkCheckVerdict(
					st,
					cur,
					head,
					roles.checkModel,
					open,
					priorLog,
					roles.warn,
					checkStart,
					checkMs,
					out.verdict,
					built.diff,
					built.transcriptText,
				);
				return false;
			}
			checkFailed = out.failed;
			limitHit = out.limitHit;
			st.log(`! work check attempt ${attempt} failed: ${checkFailed}`);
			if (limitHit) {
				hold = await usageHold(ran.result.model ?? roles.selector ?? null);
				break;
			}
		}
		if (checkFailed !== null)
			parkFailedWorkCheck(
				st,
				priorLog,
				roles.warn,
				roles.checkModel,
				checkStart,
				checkMs,
				checkFailed,
				limitHit,
				hold,
			);
		return false;
	}

	/** The check's input: at an unchanged head (a reply- or evidence-driven re-check) the full
	 * diff stays, so the check can re-cite an earlier blocker's quote verbatim; a re-check
	 * after new commits sees only those commits: the checked code was already reviewed once,
	 * and repeat checks mostly re-flag old code. The run transcript rides when it is on disk;
	 * without it the check works from the diff alone. */
	async function workCheckInput(
		st: TurnSettle,
		cur: Task,
		head: string | null,
		open: WorkCheckBlocker[],
		replies: string[],
	): Promise<{ input: string; diff: string; transcriptText: string }> {
		const checkBase = st.task.base ?? st.header.target ?? "HEAD";
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
			(await ops.diffText(st.loc.wt, checkBase, "HEAD").catch(() => null)) ??
			"";
		const checkDiff = sincePreviousCheck
			? ((await ops.diffText(st.loc.wt, checkFrom, "HEAD").catch(() => null)) ??
				diff)
			: diff;
		const transcriptPath =
			sessionFile(st.store.sessionsDir, st.result.sessionId) ?? "";
		let transcriptText = "";
		try {
			transcriptText = readRegular(transcriptPath).toString("utf8");
		} catch {
			// No transcript file on disk: the check works from the diff alone.
		}
		// The ready report of the run being checked; on a re-check the report the
		// first completed check judged rides along as the original result.
		const readyReport = readyReportText(st.result.outcome, st.result.finalText);
		const input = workCheckPrompt({
			title: st.task.title,
			prompt: st.task.prompt,
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
		return { input, diff, transcriptText };
	}

	/** The check's model: the role's selector, else the board's default role (omp's fallback).
	 * The check must not be the model it checks — same model or vendor goes on the card as a
	 * warning. */
	function workCheckRoles(st: TurnSettle): {
		selector: string | undefined;
		checkRole: string;
		checkModel: string | null;
		warn: { warn?: string };
	} {
		const roles = (ops.modelRoles ?? modelRoles)();
		const checkRole = checkRoleFor(st.result.model);
		const selector = roles[checkRole];
		const checkModel = selector ?? roles.default ?? null;
		const checkWarn = checkModelWarning(st.result.model, checkModel);
		const warn =
			checkWarn === null
				? {}
				: {
						warn:
							checkWarn === "same model"
								? `The check model ${checkModel} is the same model as the run it checks — no second-model opinion.`
								: `The check model ${checkModel} is from the same vendor as the run it checks — no second-vendor opinion.`,
					};
		return { selector, checkRole, checkModel, warn };
	}

	/** One work-check attempt (the review check shares awaitCheckAttempt): a credit stop
	 * before and after, the meter, the run, and the takeover check. Null: the turn stopped. */
	async function awaitWorkCheckAttempt(
		st: TurnSettle,
		input: string,
		selector: string | undefined,
		checkRole: string,
	): Promise<{ result: RunResult; checkMs: number } | null> {
		return awaitCheckAttempt(
			st,
			input,
			selector,
			checkRole,
			`${st.key}:workcheck`,
		);
	}

	/** Applies a valid work-check verdict: earlier blockers resolve three ways — the verdict's
	 * fixed list (by the prompt's 1-based id) wins; a blocker whose exact quote the new
	 * blockers re-cite stays open; anything else counts as fixed because the re-check dropped
	 * it. Copies, never in place. A pass stamps the card (the deferred write below stores
	 * merging/queued with the check record); blockers go back to the work agent. */
	function applyWorkCheckVerdict(
		st: TurnSettle,
		cur: Task,
		head: string | null,
		checkModel: string | null,
		open: WorkCheckBlocker[],
		priorLog: WorkCheckRun[],
		warn: { warn?: string },
		checkStart: number,
		checkMs: number,
		verdict: WorkCheckVerdict,
		diff: string,
		transcriptText: string,
	): void {
		const readyReport = readyReportText(st.result.outcome, st.result.finalText);
		const split = demoteUnquoted(verdict, diff, readyReport, transcriptText);
		// Earlier blockers resolve three ways: the verdict's fixed list
		// (by the prompt's 1-based id) wins; a blocker whose exact quote
		// the new blockers re-cite stays open; anything else counts as
		// fixed because the re-check dropped it. Copies, never in place.
		const fixedById = new Map(verdict.fixed.map((f) => [f.id, f.reason]));
		const requoted = new Set(split.blockers.map((b) => b.quote));
		const runs = [...priorLog];
		const lastIdx = runs.findLastIndex((r) => r.outcome === "blockers");
		const prev = lastIdx === -1 ? undefined : runs[lastIdx];
		if (prev !== undefined)
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
		st.log(
			`- work check: ${split.blockers.length} blocker(s), ${split.notes.length} note(s), ${(checkMs / 1000).toFixed(0)}s`,
		);
		if (split.blockers.length === 0)
			// Pass: the card stays in its current state; the deferred write
			// below stores merging/queued with the check record stamped.
			st.store.updateTask(st.id, {
				workCheckLog: allRuns,
				workCheckHead: head,
				workCheckSendbacks: cur.workCheckSendbacks,
				...(cur.workCheckReport === null
					? { workCheckReport: readyReport }
					: {}),
			});
		else sendWorkCheckBack(st, cur, head, split.blockers, allRuns);
	}

	/** A work check that failed twice (or hit a usage limit): park needs_you for a re-run, or
	 * hold the card until the provider's reset. No head stamp: the next ready at this head
	 * must run the check again. */
	function parkFailedWorkCheck(
		st: TurnSettle,
		priorLog: WorkCheckRun[],
		warn: { warn?: string },
		checkModel: string | null,
		checkStart: number,
		checkMs: number,
		checkFailed: string,
		limitHit: boolean,
		hold: UsageHold | null,
	): void {
		st.log(
			hold !== null
				? `- work check held until ${new Date(hold.holdUntil).toISOString()}: usage limit`
				: `- work check failed: ${checkFailed}`,
		);
		const patch = hold === null ? null : holdPatch(st.store, st.id, hold);
		st.store.updateTask(st.id, {
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

	/** The hold columns a settle that parked a hold writes: the parked hold's head to
	 * approve, and the approval spend its landing implies. */
	function holdParkColumns(st: TurnSettle): {
		holdHead: string | null;
		updateMergeHead: string | null | undefined;
		forkMergeHead: string | null | undefined;
	} {
		return {
			holdHead: st.holdHead,
			updateMergeHead: st.holdReason === UPDATE_HOLD_REASON ? null : undefined,
			forkMergeHead: st.holdReason === FORK_HOLD_REASON ? null : undefined,
		};
	}

	/** A check block above ran while the card was still in_progress/running: store the final
	 * state now, if the card is still ours. The overrides the checks wrote (send-back,
	 * needs_you, a failed check) moved the state away from running; this write must not
	 * clobber them, so it fires only on the still-running card. The stage and state stay the
	 * planned ones: a review parked at merging lands Done (and a release publishes) through
	 * settleReviewCard on the next tick, which does the full Done bookkeeping — commits,
	 * mergeHead, uncommitted files, worktree removal. Only the reason is recomputed: the
	 * check filed (or logged) the findings above, so the reason comes from the live cards. */
	function writePostCheckState(st: TurnSettle, next: Next): void {
		if (!st.checkWillRun) return;
		// A merge hold deferred for the check (OTTR-766) parks here, after a passed check
		// stamped its head. A send-back or a failed check left the card not running, so
		// the guard below skips the park and their own write stands.
		const final = st.holdPark ?? next;
		const afterCheck = st.store.getTask(st.id);
		const live =
			afterCheck !== null &&
			afterCheck.cancelledAt === null &&
			(afterCheck.state === "running" || afterCheck.state === "preparing");
		if (live)
			st.store.updateTask(st.id, {
				stage: final.stage,
				state: final.state,
				// The check filed (or logged) the findings above: a parked review's reason
				// comes from the live cards — open kept cards hold with FINDINGS_HOLD, and
				// with nothing open the held marker stays so the next tick (a plain review
				// lands done, a release publishes) finishes the card with the full Done
				// bookkeeping. A deferred merge hold keeps its own reason.
				needsReason:
					!st.holdPark && st.idn.reviewCard && final.stage === "merging"
						? (findingsHold(st.store.listTasks(), st.task) ?? FINDINGS_HOLD)
						: final.needsReason,
				queuedAt: final.state === "queued" ? Date.now() : undefined,
				// On a plain check settle these ride as the no-op they always were.
				...holdParkColumns(st),
			});
	}

	/** One work-check attempt's outcome: the parsed verdict on a valid one (null on an
	 * invalid JSON verdict), else the failure reason and whether a usage limit caused it. */
	function workAttemptOutcome(result: RunResult): {
		verdict: WorkCheckVerdict | null;
		failed: string;
		limitHit: boolean;
	} {
		const err = checkRunError(result);
		if (err === null) {
			const verdict = parseWorkCheck(result.finalText);
			return {
				verdict,
				failed:
					verdict === null ? "the work check verdict was not valid JSON" : "",
				limitHit: false,
			};
		}
		return { verdict: null, failed: err, limitHit: hitUsageLimit(result) };
	}

	/** The done card: stamp the released version and remove the worktree. */
	async function stampDoneCard(st: TurnSettle, next: Next): Promise<void> {
		if (next.stage !== "done") return;
		if (!st.idn.releaseCard && st.kind === "merge")
			await stampReleaseVersion(st);
		await removeDoneWorktree(
			st,
			st.loc.special ? (st.task.branch ?? "") : st.loc.branch,
		);
	}

	/** Stamp the version the merge released so state rows can show it without their turns —
	 * but only when a real tag of that name points at the pushed head: a version string in
	 * report prose (a quoted commit message, release notes) must not mint a release pill.
	 * CI watch: pin the pushed sha only when origin's remote-tracking tip equals the local
	 * target tip — a merge turn that skipped its push would otherwise pin an older run to
	 * this card. ponytail: two merges landing between push and capture pin the newer run to
	 * both cards. */
	async function stampReleaseVersion(st: TurnSettle): Promise<void> {
		const version = readReleasedVersion(st);
		const short = st.header.target.replace(/^origin\//, "");
		const [local, pushed] = await Promise.all([
			ops.targetSha(st.e.path, st.header.target).catch(() => null),
			ops
				.targetSha(st.e.path, `refs/remotes/origin/${short}`)
				.catch(() => null),
		]);
		const onOrigin = local !== null && local === pushed;
		const tagged =
			version !== null && onOrigin
				? await ops
						.targetSha(st.e.path, `refs/tags/${version}`)
						.catch(() => null)
				: null;
		if (version !== null) {
			if (onOrigin && tagged === pushed)
				st.store.updateTask(st.id, { releaseVersion: version });
			else
				st.log(`- no release stamp for ${version}: no tag on the pushed head`);
		}
		if (onOrigin) st.store.updateTask(st.id, { pushSha: pushed });
		else st.log("- CI watch skipped: merge push not on origin");
	}

	/** The version this merge turn released, parsed from the settled row's report prose
	 * (null unless the run reported an integrated outcome). */
	function readReleasedVersion(st: TurnSettle): string | null {
		const last = st.store.listTurns(st.id).at(-1);
		return last?.outcome === "integrated"
			? parseReleaseVersion(`${last.summary ?? ""}\n${last.details ?? ""}`)
			: null;
	}

	/** An interview, grill or trending scout card runs in the main checkout: its worktree must
	 * never be removed. A done work card's worktree goes away. */
	async function removeDoneWorktree(
		st: TurnSettle,
		branch: string,
	): Promise<void> {
		if (st.idn.interview || st.idn.grill || st.idn.scout) return;
		// The done drawer keeps naming what the run left uncommitted after the
		// worktree is gone: capture the list before removeWorktree deletes it.
		// statusFiles never rejects (an unreadable tree reads as []).
		st.store.updateTask(st.id, {
			uncommittedFiles: await ops.statusFiles(st.loc.wt),
		});
		try {
			await ops.removeWorktree({
				mainPath: st.e.path,
				worktreePath: st.loc.wt,
				branch,
				log: st.log,
			});
			st.log("- worktree removed");
		} catch (err) {
			st.log(`! removeWorktree: ${errmsg(err)}`);
		}
	}

	/** OTTR-454: a re-bound detached run has no local handle, so Esc kills it on its worker
	 * and settles the row here — the same stopped park a live kill gets from runTurn. */
	async function stopDetachedRun(
		store: ProjectStore,
		id: string,
		reason: string,
		watch: { url: string; runId: string },
	): Promise<StopOutcome> {
		detached.delete(`${store.name}/${id}`);
		try {
			// ponytail: a watcher exists only because workerTarget answered at recovery,
			// so the optional chain on the token cannot see null here.
			await ops.killDetached?.(watch.url, runnerToken(watch.url), watch.runId);
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
		if (watch !== undefined) return stopDetachedRun(store, id, reason, watch);
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

	/** Queues every needs_you card the credit stop or the credit gate parked (its reason is the
	 * credit reason) like an owner Resume ("."): a stopped card resumes its session on the kept
	 * worktree. Each queued turn still passes the credit gate. Resolves to the number queued; a
	 * second call finds no parked card. One sick store must not keep the other projects' cards
	 * parked. */
	function releaseParkedCards(reason: string): number {
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
				logStoreError(e.store.name, err);
			}
		}
		return released;
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
		const released = releaseParkedCards(reason);
		if (released > 0) ops.publishSoon();
		schedule();
		return released;
	}

	/** OTTR-454: a re-bound detached run has no local handle; the worker kills it, and the
	 * cancel flow below settles the card like any cancel without a live run. */
	async function killDetachedWatch(e: TurnProject, id: string): Promise<void> {
		const watch = detached.get(`${e.store.name}/${id}`);
		if (watch === undefined) return;
		detached.delete(`${e.store.name}/${id}`);
		try {
			// ponytail: a watcher exists only because workerTarget answered at recovery,
			// so the optional chain on the token cannot see null here.
			await ops.killDetached?.(watch.url, runnerToken(watch.url), watch.runId);
		} catch (err) {
			appendLog(e.store, id, `! cancel killDetached: ${errmsg(err)}`);
		}
	}

	/** The cancel's worktree verdict: what the tree holds against the target (null = nothing
	 * unsaved) and whether the branch must stay. OTTR-347: a husk holds no checkout, but its
	 * branch can still hold commits the target never got — such a cancel keeps the branch. */
	async function keptWorktreeVerdict(
		e: TurnProject,
		task: ListedTask,
		wt: string,
		force: boolean,
	): Promise<{ unsaved: string | null; keepBranch: boolean }> {
		let unsaved: string | null = null;
		let keepBranch = false;
		// A Done task passed the delete check when its worktree was removed; only its record is left.
		// A release card's worktree is disposable: cancel it like a forced cancel.
		if (!force && task.stage !== "done" && task.releaseVersion === null) {
			const into = e.target ?? task.base;
			if (await ops.worktreeHusk(wt)) {
				// Fail closed: with no target to prove against, the branch stays.
				keepBranch =
					task.branch !== null &&
					!(into && (await ops.branchMergedOrGone(e.path, task.branch, into)));
			} else {
				unsaved = into
					? await ops.unsavedWork(wt, into)
					: "its base commit is unknown";
			}
		}
		return { unsaved, keepBranch };
	}

	/** The worktree a cancelled card holds: kept (a needs_you park with the kept files) when
	 * it holds work the target lacks, else removed. Null when nothing was kept. */
	async function disposeCancelledWorktree(
		e: TurnProject,
		id: string,
		task: ListedTask,
		wt: string,
		force: boolean,
	): Promise<{ kept: string } | null> {
		const store = e.store;
		const { unsaved, keepBranch } = await keptWorktreeVerdict(
			e,
			task,
			wt,
			force,
		);
		if (unsaved !== null) {
			appendLog(store, id, `! cancel kept the worktree: ${unsaved}`);
			store.updateTask(id, {
				cancelledAt: null,
				state: "needs_you",
				// Its own prefix (R5-2): the supervisor's auto-tend matches "Kept the
				// worktree: " and must not answer a card the user just cancelled; the
				// kept counts and finish-kept still cover it via isKeptReason.
				needsReason: cancelKeptReason(unsaved),
				keptFiles: await ops.statusFiles(wt),
			});
			return { kept: unsaved };
		}
		try {
			await ops.removeWorktree({
				mainPath: e.path,
				worktreePath: wt,
				branch: keepBranch ? null : task.branch,
				log: (line) => appendLog(store, id, line),
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
		return null;
	}

	/** OTTR-800: the cancel's remote branch delete. The cancel removed the local branch;
	 * the remote card branch the ship step pushed would stay on origin for ever. Runs only
	 * in PR mode with a pinned origin, names exactly the card's own branch, and the target
	 * branch and an OTTR-760 source-PR head are refused (the card does not own them). A
	 * missing remote ref is success; a failed delete never blocks the cancel — it logs one
	 * line. A cancel that kept the worktree never reaches this: the card did not end. */
	async function deleteCancelledRemoteBranch(
		e: TurnProject,
		id: string,
		task: ListedTask | null | undefined,
	): Promise<void> {
		const branch = task?.branch ?? null;
		const settings = e.store.getSettings();
		const originUrl = settings.originUrl;
		if (
			task === null ||
			task === undefined ||
			branch === null ||
			originUrl === null
		)
			return;
		if (settings.prMode !== true || ops.deleteRemoteBranch === undefined)
			return;
		// The target reads origin/<branch> (resolveTarget); the keep-list refusal compares
		// short branch names, so strip the prefix. The base is a commit sha, never a name.
		const target = (e.target ?? "").replace(/^origin\//, "");
		const keep = [target, task.sourcePrHeadRef].filter(
			(b): b is string => b !== "" && b !== null,
		);
		const err = await ops
			.deleteRemoteBranch(e.path, branch, originUrl, keep)
			.catch((err: unknown) => errmsg(err));
		if (err !== null) {
			appendLog(e.store, id, `! cancel remote branch delete failed: ${err}`);
			return;
		}
		// prNumber alone does not name an open PR on this branch: an adopted source PR keeps
		// its own number (sourcePrNumber), and a PR closed unmerged earlier or a done card
		// keeps theirs after the stage left Merging. Only a card still waiting in Merging on
		// its own PR loses that PR with the branch.
		const prOpen =
			task.stage === "merging" &&
			task.prNumber !== null &&
			task.sourcePrNumber === null;
		appendLog(
			e.store,
			id,
			prOpen
				? `cancel: removed remote branch ${branch}; PR #${task.prNumber} closed with it`
				: `cancel: removed remote branch ${branch}`,
		);
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
		await killDetachedWatch(e, id);
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
			const kept = await disposeCancelledWorktree(
				e,
				id,
				task,
				task.worktree,
				force,
			);
			if (kept !== null) return kept;
		}
		await deleteCancelledRemoteBranch(e, id, task);
		store.updateTask(id, { state: "idle" });
		return { removed: true };
	}

	/** One planned kept-file move onto the main checkout. Returns the 409 outcome on the first
	 * missing or uncopyable file. */
	function moveKeptFiles(
		e: TurnProject,
		wt: string | null,
		planned: { moves: string[]; ignores: string[]; deletes: string[] },
	): { error: string; status: 409 } | null {
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
		return null;
	}

	/** The pre-delete proof for a kept-worktree card: a husk (unlinked, holds no checkout)
	 * disposes when its branch is gone or merged, else the branch names the blocker; a live
	 * worktree must already be integrated. Returns the 409 outcome, or null. */
	async function checkKeptWorktree(
		e: TurnProject,
		task: ListedTask,
		target: string,
	): Promise<{ error: string; status: 409 } | null> {
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
			return null;
		}
		if (!(await ops.isIntegrated(wt, target).catch(() => false)))
			return { error: `HEAD is not integrated into ${target}`, status: 409 };
		return null;
	}

	/** Validates a finish-kept request and plans the file moves: the card's guards, the husk
	 * or integration proof, and the move/ignore/delete plan. Returns the outcome to return,
	 * or the plan with the integration target. */
	async function planKeptFinishRun(
		e: TurnProject,
		id: string,
		task: ListedTask,
		choices: unknown,
	): Promise<
		| Exclude<FinishKeptOutcome, { ok: true }>
		| {
				planned: { moves: string[]; ignores: string[]; deletes: string[] };
				target: string;
		  }
	> {
		if (
			task.state !== "needs_you" ||
			(task.stage !== "merging" && task.stage !== "in_progress") ||
			!isKeptReason(task.needsReason)
		) {
			return { error: "task is not kept on a worktree", status: 409 };
		}
		if (running.has(`${e.store.name}/${id}`))
			return { error: "a turn is running", status: 409 };
		const target = e.target ?? task.base;
		if (target === null) return { error: "no integration target", status: 409 };
		const conflict = await checkKeptWorktree(e, task, target);
		if (conflict !== null) return conflict;
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
		return { planned, target };
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
		const plan = await planKeptFinishRun(e, id, task, choices);
		if ("error" in plan) return plan;
		const failed = moveKeptFiles(e, task.worktree, plan.planned);
		if (failed !== null) return failed;
		for (const rel of plan.planned.ignores) await ops.ignoreInMain(e.path, rel);
		appendLog(
			store,
			id,
			`- finished kept worktree: ${plan.planned.moves.length} moved, ${plan.planned.ignores.length} ignored, ${plan.planned.deletes.length} deleted`,
		);
		try {
			if (task.worktree !== null)
				await ops.removeWorktree({
					mainPath: e.path,
					worktreePath: task.worktree,
					branch: task.branch,
					log: (line) => appendLog(store, id, line),
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
			commits: await ops.targetCommits(e.path, plan.target),
			mergeHead: await ops.targetSha(e.path, plan.target).catch(() => null),
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
		checkoutNotices,
	};
}
