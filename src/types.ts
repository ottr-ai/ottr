// Shared contract for omp-task-tracker. Every module imports its types from here.

import type { TokenUsage } from "./hosted.ts";
import type { DeadSignIn } from "./login.ts";
import type { VmRunnerHealth } from "./vmState.ts";
import type { VmOutcome } from "./workers.ts";

/** Board column. `backlog` parks ideas that are not refined enough to run: the board shows the
 * list under the todo lane below a divider, the scheduler never picks it, and a kicked card runs
 * a grilling session (no worktree) until the user promotes it to `todo`. */
export type Stage = "todo" | "in_progress" | "merging" | "done" | "backlog";
/** Run state within a column. `preparing` = claimed by the scheduler; worktree copy and omp startup
 * are in flight while the stage stays unchanged. `needs_you` renders as the "!" badge. `idle` means
 * not running and not waiting for you: done, cancelled, or a parked card (e.g. a release card in
 * stage `merging`) — it may occur with any stage, not only `done`. */
export type RunState =
	| "queued"
	| "preparing"
	| "running"
	| "needs_you"
	| "idle";
/** Turn 1 (and its replies) is `work`; the integrate turn (and its replies) is `merge`. */
export type TurnKind = "work" | "merge";
export type OutcomeStatus = "ready" | "answered" | "integrated" | "needs_you";

/** The fixed reply text that approves a parked merge hold; the drawer's approve button sends it. */
export const APPROVE_REPLY = "approved";

export const OUTCOME_STATUSES: readonly OutcomeStatus[] = [
	"ready",
	"answered",
	"integrated",
	"needs_you",
];

/** One choice of an agent ask question. Used only inside this module. */
interface AskOption {
	label: string;
	description?: string;
}

/** The five decision facts a retro proposal carries next to its prompt; the drawer's
 * decision panel renders them as fixed labels. Absent on proposals filed before the
 * panel existed (the drawer falls back to the prompt's first paragraph). */
export interface ProposalSummary {
	/** The file or setting and the edit, in one sentence. */
	whatChanges: string;
	/** The cause and the evidence, with the card ids. */
	why: string;
	/** The measured or estimated time or cost the change saves. */
	gain: string;
	/** What can break, or "none found". */
	risk: string;
	/** How the result is verified. */
	check: string;
}

/** One question of the agent's outstanding `ask` call; the UI renders options as click-to-answer buttons. */
export interface AskQuestion {
	question: string;
	options: AskOption[];
	multi: boolean;
	/** Zero-based recommended option index; null when the agent gave none. */
	recommended: number | null;
}

/** Normalizes an ask tool call's `{ questions: [...] }` args; null when no usable question is inside. */
export function askQuestions(args: unknown): AskQuestion[] | null {
	if (typeof args !== "object" || args === null || !("questions" in args))
		return null;
	const raw: unknown = args.questions;
	if (!Array.isArray(raw)) return null;
	const out: AskQuestion[] = [];
	for (const item of raw) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("question" in item) ||
			!("options" in item)
		)
			continue;
		const { question, options: rawOptions } = item;
		const multi = "multi" in item ? item.multi : undefined;
		const recommended = "recommended" in item ? item.recommended : undefined;
		if (typeof question !== "string" || !Array.isArray(rawOptions)) continue;
		const options: AskOption[] = [];
		const keptRaw: number[] = [];
		for (const [rawIdx, entry] of rawOptions.entries()) {
			if (typeof entry !== "object" || entry === null || !("label" in entry))
				continue;
			const { label } = entry;
			const description =
				"description" in entry ? entry.description : undefined;
			if (typeof label !== "string") continue;
			options.push(
				typeof description === "string" ? { label, description } : { label },
			);
			keptRaw.push(rawIdx);
		}
		// recommended is a raw index; map it onto the kept options or null when that
		// option was dropped. indexOf rejects non-integers/out-of-range for free.
		const at =
			typeof recommended === "number" ? keptRaw.indexOf(recommended) : -1;
		out.push({
			question,
			options,
			multi: multi === true,
			recommended: at === -1 ? null : at,
		});
	}
	return out.length > 0 ? out : null;
}

/** Arguments of the agent's successful `report_outcome` tool call. */
export interface Outcome {
	status: OutcomeStatus;
	summary: string;
	details?: string;
	question?: string;
	/** Paths of UI screenshots the agent saved in the worktree. */
	shots?: string[];
	/** Cards this turn waits for (report_outcome dependsOn): the tracker restarts the card when each is done or cancelled. */
	dependsOn?: string[];
}

/** Repo facts for the onboarding fork panel; built by forkSummary (src/forks.ts). */
export interface GithubFacts {
	repo: string;
	forks: number;
	/** Forks pushed within the last 90 days. */
	active: number;
	/** Up to five forks with the newest pushedAt; null pushedAt excluded. */
	recent: { owner: string; name: string; pushedAt: number }[];
}

export interface ProjectSettings {
	/** Running omp processes per project (work + merge turns); null = no cap. */
	maxParallel: number | null;
	/** Extra relative paths copied into each new worktree (besides untracked AGENTS.md and .omp/). */
	copyExtra: string[];
	/** Name the board shows instead of the folder name; null = folder name. The folder name stays the project's id. */
	displayName: string | null;
	/**
	 * Short text (at most 4 characters) shown on the project tag's plate instead of any
	 * icon — the upload, the owner avatar or the host favicon; null = icons show.
	 * docs/specs/project-icon-text.md
	 */
	iconText: string | null;
	/**
	 * Runs after a release review approves, instead of Ottr's tag, push and GitHub release; null = those
	 * built-in steps. Split on spaces (double quotes group), no shell; gets OTTR_RELEASE_VERSION,
	 * OTTR_RELEASE_COMMIT, OTTR_RELEASE_NOTES_FILE and OTTR_ARCH_REVIEW (commits since the last
	 * review).
	 */
	releaseCommand: string | null;
	/** Commits on the integration target before an architecture review is due. */
	archReviewCap: number;
	/** Images allowed per message (prompt, reply, follow-up, steer). */
	maxImages: number;
	/** Days a kept-worktree card may sit before the supervisor quarantines it. */
	keptWorktreeDays: number;
	/** Supervisor auto-tend: deterministic replies to stuck cards whose needs_reason matches the tend rules. */
	autoTend: boolean;
	/** Max tend replies the supervisor sends per project per hour. */
	autoTendLimit: number;
	/** Bun.Glob patterns for generated-file paths (e.g. Godot .import churn) whose uncommitted changes the supervisor may auto-restore; empty disables that rule. */
	tendChurnGlobs: string[];
	/** Update cards park at needs_you when a work turn ends ready; a reply approves the merge (U7). */
	holdUpdateMerges: boolean;
	/** Fork-born cards park at needs_you before their merge; a reply approves the parked head. Default on; turning it off does not release already parked cards. */
	forkMergeHold: boolean;
	/** Supervisor files a retro card for each task done at or after this timestamp; null disables retros. */
	retroSince: number | null;
	/** Skip the retro of a smooth, cheap task (the friction filter); false gives every task a retro. */
	retroFilter: boolean;
	/** Hourly fork watch: analyze new fork-only commits with a tool-free model call and file held proposals (off by default). */
	forkResearch: boolean;
	/** Hourly PR watch: file or requeue a read-only review card for each settled open PR (off by default). */
	prReviews: boolean;
	/** Per-project PR mode: integration pushes the card branch and opens a GitHub pull request instead of merging into the target branch (off by default). */
	prMode: boolean;
	/** Run work turns in a Firecracker microVM via vm-runner instead of a worker container (off by default; docs/adr/0009-microvm-workers.md). */
	microVm: boolean;
	/** Weekly trending scout: file a read-only scout card for this project at each GitHub trending scan (off by default). */
	trendingScout: boolean;
	/** Hourly issue watch: file each new open GitHub issue as a backlog card and label it ottr-tracked (off by default). */
	issueWatch: boolean;
	/** When issueWatch last turned on (epoch ms); null while never enabled. */
	issueWatchSince: number | null;
	/** Board shows the "Finish setting up" checklist while true; set on add, cleared by dismiss/wizard-done. */
	setupChecklist: boolean;
	/**
	 * The branch on origin that task branches merge into, without the `origin/` prefix
	 * (docs/specs/merge-target-branch.md); null = the repo's default branch (origin/HEAD),
	 * else the main checkout's upstream, as before.
	 */
	targetBranch: string | null;
	/**
	 * The origin URL the board's own network git pushes and fetches (docs/specs/pinned-origin-url.md).
	 * Pinned once by the server from the origin remote, at boot or add time; a work turn can
	 * rewrite `.git/config` (R5-1), so fetch and push never take the remote name. null fails
	 * closed at the next push until the server pins again.
	 */
	originUrl: string | null;
	/**
	 * Standing approval for the board to push the main checkout's target branch to the pinned
	 * origin when the tick finds local commits origin lacks (OTTR-531 sync commits); false
	 * needs the one click on the board's push button instead. Without it nothing pushes.
	 */
	pushSyncCommits: boolean;
	/** Task id handle like OTTR; null = derived from the folder name. Uppercase letters and digits, at most 8. */
	taskIdPrefix: string | null;
}

/** One task's touched file with its +/- line counts; null counts mark a binary file. */
export interface DiffFileStat {
	file: string;
	plus: number | null;
	minus: number | null;
}

export type TaskKind =
	| "work"
	| "retro"
	| "review"
	| "interview"
	| "pr_review"
	| "trending";

/** A trending scout's judgement of one repo for one project: filed and no_fit are final; deferred is offered again next scan. */
export type TrendingVerdictKind = "filed" | "no_fit" | "deferred";

/** One row of a project's trending verdict store, keyed by the lowercase `owner/repo`. */
export interface TrendingVerdict {
	/** Lowercase `owner/repo`. */
	repo: string;
	verdict: TrendingVerdictKind;
	/** One-line reason: the scout's, or the user's cancel note when rejectedByUser. */
	reason: string;
	/** True when the user cancelled the filed proposal; later scans get the reason as a hint. */
	rejectedByUser: boolean;
	/** Epoch ms the repo was first judged for this project. */
	firstSeenAt: number;
	/** Epoch ms of the latest verdict. */
	judgedAt: number;
	/** The scout card that judged it; null when unknown. */
	scoutCardId: string | null;
	/** The backlog proposal card filed for it (verdict filed, or no_fit after a rejection). */
	proposalCardId: string | null;
}

/** Board-wide state of the weekly GitHub trending scan, shipped in /api/state. */
export interface TrendingStatus {
	/** Epoch ms of the last successful scan (weekly or manual); null before the first. */
	lastRunAt: number | null;
	/** Last failed scan's reason and time; cleared by a successful scan. */
	lastError: { reason: string; at: number } | null;
	/** True while a scan fetches GitHub or a scout card is live on any project. */
	running: boolean;
}

/** U7: an update card parked by holdUpdateMerges; the reply recognizes it by this reason. Shared by the turn loop and the drawer's hold action bar. */
export const UPDATE_HOLD_REASON =
	"Update card: read the summary, then reply to approve the merge.";

/** A fork-born task parked for merge approval; the reply recognizes it by this reason. */
export const FORK_HOLD_REASON =
	"Fork-research-born task: the merge is held. Reply to approve the merge, or cancel the card.";

/** OTTR-274: a merge turn added changes beyond an approved hold head; the reply approves the exact parked push head. */
export const MERGE_HOLD_MISMATCH_REASON =
	"The merge added changes beyond the approved head. Read the diff, then reply to approve the merge, or cancel the card.";

export type PrState = "open" | "closed" | "merged";

/** The registered GitHub App as the Settings git-hosts view shows it — never the key. */
export interface GitHubAppView {
	id: string;
	/** `SHA256:` + unpadded base64 over the public key's SPKI DER digest. */
	fingerprint: string;
	/** The last name + install check; null before the first check finishes. */
	check: AppCheck | null;
}

/** What the board knows about the configured app: its name and the board repos it cannot see. */
export type AppCheck = {
	at: number;
	name: string | null;
	/** The app's GitHub page; its install link is `${url}/installations/new`. */
	url: string | null;
	/** Board repos ("owner/repo") checked. */
	repos: string[];
	/** Board repos without an installation of the app (lookup 404). */
	missing: string[];
	/** Board repos without an installation that the app cannot see as public (private or gone); they get no outside pull requests, so no warning names them. */
	private: string[];
	/** Board repos whose own lookup failed — a status other than 200 or 404, or a network error — as repo + why; the check went on to the next repo. A failed app lookup lands in error instead. */
	failed: { repo: string; detail: string }[];
	/** Why the whole check failed: the app lookup answered a failure status or its transport threw; never holds the key. */
	error: string | null;
};

/** One pr_review row: the watch state of one PR of the project's GitHub repo. */
export interface PrReviewRow {
	number: number;
	/** The PR's review card; null before the first review starts. */
	taskId: string | null;
	head: string;
	firstSeenAt: number;
	reviewedHead: string | null;
	postedHead: string | null;
	/** html_url of the posted review; null until a Post succeeds. */
	postedUrl: string | null;
	/** GitHub login the review was posted as (app bot or person); null when unknown. */
	postedLogin: string | null;
	state: PrState;
	draft: boolean;
	title: string;
	postError: string | null;
}

/** The PR facts a pr_review card's drawer shows. */
export interface PrReviewView {
	number: number;
	url: string;
	state: PrState;
	reviewedHead: string | null;
	postedHead: string | null;
	/** html_url of the posted review; null until a Post succeeds. */
	postedUrl: string | null;
	/** GitHub login the review was posted as (app bot or person); null when unknown. */
	postedLogin: string | null;
	postError: string | null;
}

export interface Task {
	/** Trusted, server-set card kind set once by the route that created the card; never derived from prompt text. */
	kind: TaskKind;
	/** Legacy 8 lowercase hex chars, or a `PREFIX-n` speaking key (uppercase alphanumeric prefix, max 4 chars, per-project monotonic number). */
	id: string;
	/** Project name = folder name of the main checkout. */
	project: string;
	/** First non-empty line of the prompt, max 80 chars. */
	title: string;
	/** The user's task text. */
	prompt: string;
	stage: Stage;
	state: RunState;
	/** Why the task needs you (shown with the "!" badge). */
	needsReason: string | null;
	/** Retro proposals only: the five decision facts the propose_task call carried; null on
	 * older proposals (the drawer falls back to the prompt's first paragraph). */
	proposalSummary: ProposalSummary | null;
	/** Reply text waiting to be sent with the next turn. */
	pendingPrompt: string | null;
	/** Who authored pendingPrompt: "user" (steer/reply routes) or "supervisor" (tracker-parked:
	 * holds, check send-backs, auto-resumes, tend replies). null behaves as "user". */
	pendingBy: "user" | "supervisor" | null;
	/** Image file names (in the task's images folder) pasted with the original prompt; sent with every work turn that sends the original prompt. */
	images: string[];
	/** Image file names pasted with the pending reply; sent with the next turn only. */
	pendingImages: string[];
	/** UI screenshot file names (in the task's images folder) copied from the worktree at settle. */
	shots: string[];
	branch: string | null;
	/** Commit sha the worktree branched from. */
	base: string | null;
	/** Absolute worktree path. */
	worktree: string | null;
	sessionId: string | null;
	/** Latest outcome summary (1-3 lines). */
	summary: string | null;
	/** Latest outcome details (full report). */
	details: string | null;
	/** Research cards only: the report markdown harvested from the worktree's research-report.md; null otherwise. */
	report: string | null;
	/** Research card: answers a question instead of changing code; ends answered with a report file, never integrates. */
	research: boolean;
	/** OTTR-488: harvested at settle — 'yes' when the report carries a `## Recommended steps` heading, 'no' when a harvested report carries none, 'unknown' when no report was harvested (legacy rows). Views resolve 'unknown' against the stored report at read time (app.ts viewSteps, ui/queue.ts researchSteps). */
	steps: ResearchSteps;
	/** Pinned by the user on a done research card so its report stays findable; UI-only, no pipeline effect. */
	starred: boolean;
	/** Epoch milliseconds. */
	createdAt: number;
	updatedAt: number;
	/** When the task last entered state `queued`; scheduling order. */
	queuedAt: number | null;
	/** When the task last entered stage `done`; backfilled from the last turn's end for pre-existing cards. */
	doneAt: number | null;
	cancelledAt: number | null;
	/** Commits on the integration target when the task finished; null when unmeasured. The progress increment for projects without releases. */
	commits: number | null;
	/** Release cards only: the version the card releases, e.g. "v0.4.0"; null for every other task. */
	releaseVersion: string | null;
	/** Release cards only: the GitHub release notes (markdown), fixed when the card is created. */
	releaseNotes: string | null;
	/** Outstanding agent ask (JSON in the DB): the "?" badge and the clickable choices in the drawer. */
	asked: AskQuestion[] | null;
	/** Model every turn of this task runs with, e.g. "openai/gpt-5.2"; null = omp default. */
	model: string | null;
	/** Worktree files (repo-relative) the delete check kept; [] once a later check passed or the card is resolved. */
	keptFiles: string[];
	/** Task id this card continues (set by the Follow up flow); null for a from-scratch task. Children are tasks whose followUpOf is this id. */
	followUpOf: string | null;
	/** The parent's project when followUpOf names a card on another project's board (create_task's project parameter); null for a parent on this project's board. */
	followUpOfProject: string | null;
	/** CI watch: sha of the merge push whose GitHub Actions verdict the supervisor awaits; null once checked, skipped, or given up on. */
	pushSha: string | null;
	/** PR mode: open PR-mode pull request; null outside PR mode. */
	prNumber: number | null;
	prUrl: string | null;
	prHeadSha: string | null;
	/** OTTR-394: automatic rebase retries a rejected server push has spent (budget 2 per card). */
	pushRetries: number;
	/** Integration target head when the task finished (stamped with `commits`); the anchor that attributes a release's late commits to the card that merged them. null when unmeasured or not done. */
	mergeHead: string | null;
	/** Coarse board topic: the last turn report's `topic:` line (max 40 chars), else a keyword label backfilled for done cards; null = unclassified. */
	topic: string | null;
	/** Task ids this card waits for: the scheduler starts it only when each is stage done (cancelled counts as satisfied). */
	dependsOn: string[];
	/** Update-card only: record ids (`<name>@<target>`) this card updates; [] for every other task. */
	updateIds: string[];
	/** Update card on a hold-update-merges project: the head the admin approved by a reply to the hold; the merge goes on only while HEAD equals it. */
	updateMergeHead: string | null;
	/** Task born from fork research (a proposal or a follow-up of a fork research card): the head the admin approved by a reply to the hold. */
	forkMergeHead: string | null;
	/** Server-set HEAD when a settle parked the card for a merge hold: the worktree HEAD for a work-settle hold, the local target HEAD for a merge-hold mismatch park (OTTR-274); null otherwise. A reply approves this head, never one an agent names. */
	holdHead: string | null;
	/** Per-file +/- counts of the branch's diff, captured at merge-turn start (after the ff-merge lands, the branch is indistinguishable from the target); null when never captured. */
	diffFiles: DiffFileStat[] | null;
	/** The unified diff captured with diffFiles, capped; null when never captured. */
	diffText: string | null;
	/** Uncommitted worktree files captured when the card settled done (the worktree is removed right after); [] while open and for rows settled before the capture existed. */
	uncommittedFiles: string[];
	/** Second-model checks of this work card, oldest first, capped at the newest 20 runs. */
	workCheckLog: WorkCheckRun[];
	/** Work-check send-backs to the work agent so far; once WORK_CHECK_MAX_SENDBACKS have run, every failing check asks the user (send it back, merge anyway, or cancel) before another send-back. */
	workCheckSendbacks: number;
	/** Branch head the last completed check saw; a ready report at the same head does not re-check. */
	workCheckHead: string | null;
	/** Epoch ms before which the queued card must not start (a check held until a provider usage
	 * limit resets); null = no hold. Kept apart from queuedAt: a queue reorder rewrites that. */
	holdUntil: number | null;
	/** Which provider's usage limit this hold waits for ("zai"); null = the hold is not a usage
	 * hold (an open prompt edit, a hosted credit retry). Set with holdUntil by the usage-hold
	 * writers; the quota refresh releases holds whose provider reports free again (OTTR-688). */
	holdProvider: string | null;
	/** omp window id ("5h", "7d") of the blocking usage window when the reset named one; null when
	 * the window is unnamed or the hold is not a usage hold. */
	holdWindow: string | null;
	/** Manual triage rank; null = unrated. Overview triage sorts P0 first, unrated last. */
	priority: Priority | null;
	/** Close-candidate nomination: the reason this card is a duplicate, superseded, or drifted; null = not nominated. */
	closeCandidate: string | null;
}

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** One blocker the second-model work check raised; an empty quote demotes it to a note. */
export interface WorkCheckBlocker {
	/** What is wrong, one to three sentences. */
	finding: string;
	/** A verbatim part of the diff or of the work transcript that shows the problem. */
	quote: string;
	/** The check's classification; missing on old records means important. Only important
	 * findings block the merge: nits and pre-existing bugs demote to notes. */
	severity?: "important" | "nit" | "pre-existing";
	/** Short bug-class name the check assigned, so one send-back fixes every instance. */
	bugClass?: string;
	/** Set once resolved: "fixed" = a later check confirmed the fix, "overridden" = Merge anyway with a reason. */
	status?: "fixed" | "overridden";
	/** Why it resolved: the confirming check's reason, or the Merge-anyway reason. */
	statusReason?: string;
}

/** One run of the second-model check of a work card. */
export interface WorkCheckRun {
	/** Epoch milliseconds when the check run started. */
	at: number;
	/** Model selector the check ran with: the critic or adversary role's model, else the
	 *  board's default role (omp's fallback when a model is unset); null = omp's own default
	 *  (no role names it, so the card shows "default model"). */
	model: string | null;
	/** pass = nothing blocks, blockers = real problems found, error = the run itself failed after a retry. */
	outcome: "pass" | "blockers" | "error";
	blockers: WorkCheckBlocker[];
	/** Non-blocking findings: no quote, or the quote matched nothing in the diff or transcript. */
	notes: string[];
	durationMs: number;
	/** The failed-run reason when outcome is "error". */
	error?: string;
	/** Why the check gives no second-model opinion: it ran on the checked run's own model
	 *  or at least its vendor (checkModelWarning). Absent when the check differs in vendor. */
	warn?: string;
}

/** What to do with one kept worktree file when finishing the card without an agent turn. */
export type KeptChoice = "move" | "ignore" | "delete";

export interface Turn {
	id: number;
	taskId: string;
	kind: TurnKind;
	prompt: string;
	/** User text this turn delivered (reply or steering); null for turns started from the task prompt. */
	input: string | null;
	/** Who authored input: "user" or "supervisor" (tracker-parked text the turn delivered). null behaves as "user". */
	inputBy: "user" | "supervisor" | null;
	startedAt: number;
	endedAt: number | null;
	pid: number | null;
	exitCode: number | null;
	outcome: OutcomeStatus | null;
	summary: string | null;
	details: string | null;
	question: string | null;
	error: string | null;
	/** Model that served the run's assistant messages, e.g. "zai/glm-5.3-flash"; null when unseen. */
	model: string | null;
	/** The --model selector the run was dispatched with, stored only when the run served a
	 *  different model: the provider errored and omp's retry chain fell back (the timeline
	 *  notes the swap on the turn). Null when dispatch and served model agree. */
	dispatchedModel: string | null;
	/** Agent layer id (the `.alate/layers/<id>` folder name) this turn's omp run pinned; null when the run stayed on the flat home or the row predates the field. */
	layer: string | null;
	/** Where the run executed, recorded at settle: `worker <url hostname> (<container hostname>)`
	 * for a worker dispatch, `board (<server hostname>)` for a local spawn; null when unrecorded
	 * (the run is still going, a lost worker never started, or the row predates the column). */
	ranOn: string | null;
}

/** One finding a review recorded with propose_task. Ottr checks the best-ranked ones with a
 * second model after the run and files the kept ones as cards linked to the review. */
export interface RecordedFinding {
	/** Self-contained finding text: what is wrong, the evidence, the effect, the suggested fix. */
	prompt: string;
	/** Model override carried onto the filed card; null runs the default role. */
	model: string | null;
	/** The reviewer's importance rank, 1 = highest; null when recorded without one. */
	rank: number | null;
	/** Confirmed security severity the reviewer declared; null when not a security finding. */
	security: "critical" | "high" | null;
}

/** What one omp process run produced. */
export interface RunResult {
	exitCode: number | null;
	sessionId: string | null;
	/** Model of the last assistant message_start event, or null. */
	model: string | null;
	/** Last successful `report_outcome` call, or null. */
	outcome: Outcome | null;
	/** The agent's outstanding `ask` call (last one seen), or null. */
	asked: AskQuestion[] | null;
	/** A retro run's first valid `propose_task` call (proposal held for approval), or null.
	 * summary holds the five decision fields the call carried, or null when it sent none. */
	proposed: {
		prompt: string;
		model: string | null;
		summary: ProposalSummary | null;
	} | null;
	/** Every valid `propose_task` call of the run, in order: a retro records at most one (the
	 * extension refuses a second), a review records one per finding. */
	recorded: RecordedFinding[];
	/** A tool call was refused because it needed approval and -p has no UI. */
	approvalRefused: boolean;
	/** An `agent_end` event with `isTerminal !== false` was seen. */
	sawTerminalEnd: boolean;
	/** Text of the last assistant message of the last terminal `agent_end`. */
	finalText: string;
	/** The tracker killed the process (Cancel). */
	killed: boolean;
	/** Last 4000 chars of stderr. */
	stderrTail: string;
	/** Where the run executed: `worker <url hostname> (<container hostname>)` for a worker dispatch
	 * (the container hostname rides the worker's done sentinel), `board (<server hostname>)` for a
	 * local spawn. Absent when the run never started (lost worker, dispatch failure). */
	ranOn?: string;
	/** Last assistant provider error; a later successful message clears it. */
	providerError?: string | null;
	/** How the run was dispatched: mode (local / worker URL), argv
	 * length, cwd basename, pid when one existed, wall duration. classify shows it when a death
	 * has no stderr, so the board answers "why did my turn die" in one glance. */
	dispatch?: string;
	/** Set by the worker client when the worker stream ended without a result and the run was not client-killed; classify turns it into an automatic resume. */
	workerLost?: boolean;
	/** Set when vm-runner answered the dispatch busy (all OTTR_VM_MAX microVMs taken): the turn
	 * never started, so settle puts the card back to queued exactly as before the claim. */
	workerBusy?: boolean;
	/** The microVM's end state of the task branch (head it pushed, dirty files); present only
	 * for a turn that ran in a microVM and reported its sentinel. */
	vm?: VmOutcome;
	/** Tokens and cost summed over the run's assistant messages (hosted metering); absent while
	 * omp reported none. */
	usage?: TokenUsage;
}

/** Git checks the tracker runs in the worktree after a turn. */
export interface GitFacts {
	/** Commits on HEAD not in the task's base commit. */
	commitsAhead: number;
	/** `git status --porcelain --untracked-files=all` is empty. */
	clean: boolean;
	/** HEAD is an ancestor of (or equal to) the integration target. */
	integrated: boolean;
}

/** Where a task goes after a turn. */
export interface Next {
	stage: Stage;
	state: RunState;
	/** Why the card needs you; on a queued card, why the tracker queued it again (the board shows "resuming"). */
	needsReason: string | null;
	/** Automatic continue, sent as the next turn's reply. */
	pendingPrompt?: string;
	/** Epoch ms before which the scheduler must not start the queued card: a usage-limit
	 * continue waiting for the provider's reset. Absent keeps the column. */
	holdUntil?: number;
	/** Which provider's usage limit holdUntil waits for, and its window id when the reset named
	 * one; set whenever holdUntil is set. Absent keeps the columns. */
	holdProvider?: string;
	holdWindow?: string | null;
	/** Who authored pendingPrompt; defaults to "supervisor" when the settle writes it. */
	pendingBy?: "user" | "supervisor" | null;
	/** Outstanding agent ask to store on the task (the "?" state); absent/undefined clears nothing by itself. */
	asked?: AskQuestion[];
	/** The turn died in the provider-rejects-images shape: the caller moves the attached files to
	 * .tasks/quarantine/<task>/ and the queued state retries text-only. */
	quarantineImages?: boolean;
}

// ---- Fork research ----

/** One watched fork, keyed by its GitHub repository id (a rename must not reset its history). */
export interface ForkInfo {
	/** GitHub repository id; positive integer. */
	id: number;
	owner: string;
	name: string;
	defaultBranch: string | null;
	/** Last push GitHub reports (epoch ms); null when the API gave none. */
	pushedAt: number | null;
	/** GitHub's size estimate in KB; null when unknown. */
	sizeKb: number | null;
}

/** Watch state for one fork branch; the row key is a hash of the branch name (branch names stay data, never ref components). */
export interface ForkBranchState {
	forkId: number;
	/** First 16 hex chars of sha256(branch): the local ref name and the row key. */
	branchHash: string;
	branch: string;
	/** Last observed head. */
	head: string | null;
	/** Head of the last fully analyzed run; null = never analyzed. */
	analyzedHead: string | null;
	/** When the current head first differed from analyzedHead (epoch ms); null when nothing is pending. */
	firstPendingAt: number | null;
	/** Start of the last analysis attempt for this fork (epoch ms); gate: one run per fork per day. */
	lastRunAt: number | null;
	lastError: string | null;
	/** Consecutive failed analysis attempts; at 3 the range pauses until a manual check succeeds. */
	retries: number;
}

/** One fork commit selected for analysis. */
export interface ForkCommit {
	sha: string;
	subject: string;
	files: number;
	plus: number;
	minus: number;
	/** Unified patch (`--no-textconv --no-ext-diff`), invisible characters already stripped. */
	patch: string;
	/** Branch names whose head reaches this commit. */
	branches: string[];
}

/** Everything one analysis call receives about one fork's new work. */
export interface ForkRange {
	fork: ForkInfo;
	commits: ForkCommit[];
	/** Fork-only merge commits as remerge diffs (zero non-merge commits does not imply zero new behavior). */
	merges: ForkCommit[];
	/** Upstream commits since the common base, one `sha subject` line each. */
	upstreamCommits: string[];
	/** Upstream file paths at the current head. */
	upstreamFiles: string[];
	/** Upstream README and license text, capped by the server. */
	upstreamDocs: string;
	/** The analyzed head per branch in this range. */
	heads: Array<{ branchHash: string; branch: string; head: string }>;
}

/** Model verdict on one feature found in a range, validated by the server. */
export interface ForkFeature {
	name: string;
	commits: string[];
	/** Present, solved differently, removed upstream, or genuinely missing. */
	comparison: string;
	/** Relevant upstream modules, conflicts, dependencies, configuration, migration needs, tests. */
	feasibility: string;
	value: string;
	risk: string;
	verdict: "propose" | "skip" | "unknown";
	reason: string;
	effort: "S" | "M" | "L";
}

/** One worthwhile change; the server assembles the held proposal task prompt from these fields. */
export interface ForkProposal {
	title: string;
	goal: string;
	comparison: string;
	change: string;
	checks: string;
	risk: string;
	effort: "S" | "M" | "L";
	commits: string[];
}

/** Validated model output for one range. */
export interface ForkAnalysisResult {
	features: ForkFeature[];
	proposals: ForkProposal[];
	/** Model-stated coverage limits; the server rejects coverage beyond the supplied ranges. */
	coverage: string;
	/** Commit ids the report covers (validated subset of the range). */
	commits: string[];
	/** Commits left unanalyzed because the prompt hit its size bound; they stay pending. */
	deferred: string[];
}

// ---- HTTP API views ----

/** Architecture-review pressure on a project's integration target (docs/ARCH-REVIEWS.md). */
export interface ArchReview {
	/** Commits on the target since its newest `docs(arch-review):` commit; the whole history when there is none. */
	delta: number;
	/** False until the target carries an arch-review watermark: a newly added project is un-reviewed, so a review is due whatever the delta. */
	reviewed: boolean;
	/** The commit the delta counts from: the frozen base of the newest done full review or a newer `docs(arch-review):` commit; null when no watermark exists yet. */
	base: string | null;
	/** The review card whose frozen base is `base`; null when a baseline commit set the base or no watermark exists. */
	reviewCardId: string | null;
	/** Process constant: a review is due once delta reaches this many commits. */
	cap: number;
	due: boolean;
	/** A live architecture-review task exists (queued or running): the due chip says so and Start review disables. */
	running: boolean;
}

/** The repo's public ghcr.io container image, as shown in the project header chip. */
export interface LatestImage {
	/** Highest `vX.Y.Z` tag pushed to the image. */
	tag: string;
	/** GitHub package page listing the versions, newest first. */
	url: string;
}

/** One open-pull-request chip in the project header; GitHub data parsed as untrusted
 * (prs.ts's parsePullPage), so only the fields listed here exist. */
export interface OpenPrSummary {
	number: number;
	title: string;
	draft: boolean;
	url: string;
}

/** The project header's open-PR view: the repo's open pull request count plus at most
 * the first three chips in GitHub's order. When `prs` is shorter than `total`, the UI
 * collapses the list into one count link to the repo's pulls page. */
export interface OpenPrsView {
	total: number;
	prs: OpenPrSummary[];
}

export interface ProjectView {
	name: string;
	/** mtime in ms of the project's custom icon file, or null when none is set. */
	icon: number | null;
	/** HTTPS form of the project's origin push remote on any host, or null when it has none.
	 * Icon adoption reads this; github stays the github.com-only view the release flow uses. */
	remote: string | null;
	/** Absolute main checkout path. */
	path: string;
	/** Absolute omp session dir of the project's turns: `<path>/.tasks/sessions`, or under OTTR_DATA_DIR. */
	sessionsDir: string;
	/** AGENTS.md exists in the main checkout (tracked or untracked). */
	hasRules: boolean;
	/** Integration target ref, e.g. "origin/main", or null if unresolved. */
	target: string | null;
	/** Main checkout is not a git repository with a commit yet; every action waits for the init route. */
	gitless: boolean;
	/** Main checkout has uncommitted changes: your own pull/stash will collide with task-made commits. */
	dirty: boolean;
	/** Branch the main checkout has checked out; null when detached, gitless, or git failed (OTTR-531). */
	mainBranch: string | null;
	/** OTTR-531: true while the local target branch has commits origin lacks — the merge hold's git fact. */
	mainUnpushed: boolean;
	/** HTTPS URL of the project's GitHub remote (origin preferred); null when it has none. */
	github: string | null;
	/** Last vm-runner /healthz probe, so the settings form can disable the microVM toggle. */
	vmRunner: VmRunnerHealth;
	/** The origin remote sits on a *.ghe.com tenant the configured GitHub host does not name,
	 * so every GitHub feature stays off: the notice names that tenant, to set under
	 * Settings → Git hosts → GitHub host. Null when the features are on or the origin is
	 * not a ghe.com tenant. */
	githubHostNotice: string | null;
	/** Latest release: the repo's latest GitHub release (its name when the tag is not
	 * `vX.Y.Z`), else the highest `vX.Y.Z` tag merged into the target; null until the first
	 * scan or when both are unknown. */
	latestRelease: string | null;
	/** Web page of the latest GitHub release when the chip shows its name (a non-`vX.Y.Z`
	 * release); absent when the chip shows a tag and links `releases/tag/<tag>`. */
	latestReleaseUrl?: string | null;
	/** Public ghcr.io image of the repo; probed on a TTL by the scheduler, null without a public image. */
	latestImage: LatestImage | null;
	/** Since the last arch review on the target; null with no target, before the first scan, or when git fails. */
	archReview: ArchReview | null;
	/** Open pull requests on the GitHub repo, newest first; null with no GitHub remote,
	 * before the first probe, or when gh fails. */
	openPrs: OpenPrsView | null;
	settings: ProjectSettings;
	/** Effective task id handle: the taskIdPrefix override or the folder-derived default. */
	taskPrefix: string;
}

export interface TaskView extends Omit<Task, "diffText"> {
	/** Turns without the prompt text (the log and the follow-up handoff read it from the DB). */
	turns: TurnView[];
	/** Lowercase `owner/repo` when this card is a trending scout's proposal; the cancel dialog then asks for a reason. */
	trendingRepo?: string;
	/** Card title: the first session title, else the short prompt line — frozenTitle never returns null. */
	sessionTitle: string;
	/** Repo-relative uncommitted worktree files; present on the drawer detail view only. */
	worktreeFiles?: string[];
	/** Set only for kind "pr_review". */
	prReview?: PrReviewView;
	/** Present on the drawer detail of a release card waiting for approval; commits between the reviewed base and the target head. */
	lateCommits?: LateCommit[];
	/** The retro card filed after this card (kind "retro", followUpOf this card); this card's
	 * Work steps show its turns, and the board shows no card for it. Absent without a retro. */
	retro?: RetroView;
	/** Review and release cards only: the cards the review filed (reviewFindings), oldest
	 * first. This card's Work steps show their turns; each finding stays a card of its own.
	 * Absent without findings. */
	findings?: FindingView[];
}

/** A retro card as its source card's drawer shows it: the facts its Work steps entry reads. */
export interface RetroView {
	id: string;
	state: RunState;
	stage: Stage;
	cancelledAt: number | null;
	needsReason: string | null;
	asked: Task["asked"];
	turns: TurnView[];
}

/** One finding of a review or release card, as that card's drawer shows it: the facts its
 * Work steps entries read. The finding itself stays a normal card on the board. */
export interface FindingView {
	id: string;
	title: string;
	state: RunState;
	stage: Stage;
	cancelledAt: number | null;
	/** Epoch ms the review filed the finding; a finding without turns marks this time. */
	createdAt: number;
	turns: TurnView[];
}

/** One commit in a waiting release card's late range, as shown on the drawer. */
export interface LateCommit {
	/** Full commit sha. */
	sha: string;
	/** First line of the commit message. */
	subject: string;
	/** true: the merge of a card the review filed (a finding card). */
	reviewed: boolean;
}

/** A turn as shipped over the API: everything but the prompt text. */
export type TurnView = Omit<Turn, "prompt">;

/** A task as shipped in /api/state: card facts without the full report text (the drawer fetches it per task). */
export type TaskCard = Omit<
	Task,
	"details" | "report" | "diffFiles" | "diffText"
> & {
	/** Card title: the first session title, else the short prompt line — frozenTitle never returns null. */
	sessionTitle: string;
	/** A question-only card: the last work turn reported `answered`, so the answer is the deliverable. */
	answered: boolean;
	/** Live progress of a long tool run in the card's running turn (a Stryker run today); absent otherwise. */
	progress?: string;
	/** Model of the card's last run; present only when the card pins no model, so the chip can state what actually ran. */
	lastModel?: string | null;
	/** Epoch ms of the card's last activity (its log's last write, or the running turn's last
	 * live-progress movement), present only while a preparing or running card has been silent past
	 * the board's limit (SILENT_LOG_MS in src/scheduler.ts): the agent may wait on a hung command. */
	silentSince?: number;
	/** Ids of the queued merges mergeHold parks behind this open release ("waiting for release
	 * <version>"); present on release cards only, and only when the list is non-empty. */
	heldMerges?: string[];
	/** OTTR-506: stamped on queued merges the push hold parks while local main has commits
	 * origin lacks (a rejected server push); the board shows the hold reason — the browser
	 * gets no git, so the server derives the fact (pushHold) and stamps it. */
	pushHold?: boolean;
	/** Stamped on queued cards of a microVM-mode project while vm-runner holds them back
	 * (unreachable or busy): the hold text from vmHoldFor. */
	vmHold?: string;
	/** Epoch ms the card's live turn started; present only while a turn is running (state "running"). The card ticks the elapsed time from it. */
	runStartedAt?: number;
	/** Median wall length (ms) of this card's completed same-project/kind/model turns; present only when at least ETA_MIN_HISTORY (src/perf.ts) completed turns back it. The client counts it down as "about X left" and falls back to elapsed only. */
	etaMs?: number;
	/** Lowercase `owner/repo` when this card is a trending scout's proposal; the cancel dialog then asks for a reason. */
	trendingRepo?: string;
};

/** OTTR-488: harvested at settle — 'yes' when the report carries a `## Recommended steps` heading, 'no' when a harvested report carries none, 'unknown' when no report was harvested (legacy rows). Views resolve 'unknown' against the stored report at read time (app.ts viewSteps, ui/queue.ts researchSteps). */
export type ResearchSteps = "yes" | "no" | "unknown";

/** A done card is question-only when the last work turn reported `answered` (a later follow-up replaces it). */
export function answeredCard(
	turns: Array<Pick<Turn, "kind" | "outcome">>,
): boolean {
	for (let i = turns.length - 1; i >= 0; i--) {
		const t = turns[i]!;
		if (t.kind === "work") return t.outcome === "answered";
	}
	return false;
}

/** True when a research report names steps worth implementing. The research
 * prompt asks for a heading named "## Recommended steps", so the exact heading
 * is the first signal; older reports (OTTR-94, OTTR-283) fall back to the same
 * phrases the follow-up prompt searches for, and a heading holding "recommended
 * … steps" with up to three words between catches shapes like OTTR-449's
 * "## Recommended adoption steps". ponytail: the fallbacks are still a phrase
 * heuristic; a report saying "no next steps are needed" still matches them.
 * OTTR-488: the server also resolves stored steps against this regex at view build. */
export const recommendsSteps = (report: string): boolean =>
	// The exact heading the research prompt asks for, any level, case-insensitive.
	/^\s*#{1,6}\s+recommended steps\s*$/im.test(report) ||
	// Old-report phrases, so the button never promises work the agent cannot find.
	/\brecommended steps\b|\bnext steps\b|\baction items\b/i.test(report) ||
	// A heading holding "recommended … steps", up to three words between.
	/^\s*#{1,6}\s+.*\brecommended(?:\s+\S+){0,3}\s+steps\b/im.test(report);

/** OTTR-566: the read mark of one completion, `<id>@<doneAt>`, kept in the same seen set as the
 * plain-id answer marks. Keyed by doneAt so a task that lands in Done again is unread again, and
 * apart from the id mark so the rail dot clears on drawer open while a steps report stays pinned. */
export const doneReadKey = (t: { id: string; doneAt: number }): string =>
	`${t.id}@${t.doneAt}`;

/** One upstream item kind, as the provider contract allows (U3). */
export type UpdateKind = "image-pin" | "mcp" | "rule-set" | "skill" | "plugin";

/** One upstream update as the provider serves it; every field is validated before display (U3). */
export interface UpdateRecord {
	/** Stable key `<name>@<target>`; skips and push dedupe key on it. */
	id: string;
	name: string;
	kind: UpdateKind;
	/** GitHub page of the item. */
	origin: string;
	/** GitHub `owner/name` of the repo that holds the pin. */
	repo: string;
	pin: { file: string; key: string };
	current: string;
	latest: string;
	/** Newest version at least 7 days old, or null while nothing qualifies. */
	target: string | null;
	publishedAt: string;
	qualifiesAt: string;
	notesUrl: string;
	/** Another updater owns the item; the row shows this text and offers no actions. */
	managedBy?: string;
	/** True when the pinned path was deleted upstream; `target` is then always null. Notification row: shown without Allow, and card filing refuses it. */
	removed?: true;
	/** Changed files of the pinned path between `current` and the picked version, each with its upstream diff URL (at most 50). */
	diffs?: { file: string; url: string }[];
}

/** A row as shipped to the UI: the repo resolved to a board project name when one matches (U5). */
export interface UpdateRow extends UpdateRecord {
	/** Board project name, or null when no project's origin remote matches. */
	project: string | null;
}

/** Last good provider pull, kept in the global store so a restart shows it (U5). Skipped rows are removed. */
export interface UpdatesView {
	checkedAt: string;
	rows: UpdateRow[];
}

/** GET /api/provisioning: the agent server's (alate) state and the workers' provisioned lists. */
export interface ProvisioningResponse {
	/** The configured alate integration, or null when no URL is set. */
	server: null | {
		url: string;
		keySet: boolean;
		/** Why the last (manual or automatic) provision attempt failed; null when none is recorded. */
		lastError: string | null;
		/** One live probe; `down` when alate did not answer. */
		health:
			| {
					state: "ok";
					version: string | null;
					behind: boolean;
					pending: boolean;
					running: boolean;
			  }
			| { state: "down" };
	};
	/** Projects alate provisioned lists for, sorted; booleans say which lists exist. */
	workers: {
		name: string;
		apt: boolean;
		tools: boolean;
		requirements: boolean;
		env: boolean;
	}[];
	/** The user layer the provisioned home holds; empty lists mean the data repo carries none of it (Settings → Alate shows it). */
	userLayer: { skills: string[]; plugins: string[]; mcp: string[] };
}

export interface OrphanProcess {
	pid: number;
	/** Process start time as epoch ms; 0 when the platform does not report it. */
	started: number;
	/** Short command summary: leading KEY=value tokens dropped, whitespace collapsed, capped at 160 chars with a "…" suffix. Never env values (ps args hold none). */
	cmd: string;
	/** Project name when the run's cwd or --session-dir resolves to a project; null otherwise. */
	project: string | null;
	/** Card id when the cwd sits in the project's .worktrees/<id> and the card exists in that store; null otherwise. */
	card: string | null;
	/** Run kind when the argv says it: "retro" (retro.yml), "check" (check.yml), "turn" (tracker --extension present); null otherwise. */
	kind: string | null;
}

export interface StateResponse {
	projects: ProjectView[];
	/** Non-cancelled tasks of all projects, newest first. */
	tasks: TaskCard[];
	/** Global cap of concurrently running omp processes; null = no cap. */
	maxTotal: number | null;
	/** True when a review's findings are checked by a second model before they become cards. */
	reviewCheck: boolean;
	/** True when a finished work card is checked by a second model before it enters the merge queue. */
	workCheck: boolean;
	/** True when the board files a due architecture review card by itself after two hours without input. */
	idleReviews: boolean;
	/** True when the board scans GitHub trending weekly (Monday 06:00 server time) for projects with trendingScout on. */
	trendingScan: boolean;
	/** Weekly trending scan state for the Settings notice and the "Scan trending now" button. */
	trendingStatus: TrendingStatus;
	/** Version stamp of the running server (image stamp OTTR_VERSION, release tag `vX.Y.Z`, short sha on dev, else boot time); stale tabs reload once when it changes. */
	serverVersion: string;
	/** Provider usage limits from `omp usage --json`; null until the first check. */
	quota: QuotaState | null;
	/** Hosted mode (docs/specs/hosted-mode.md): the UI hides host-level panels and identity surfaces. Absent or false on every self-hosted board. */
	hosted?: boolean;
	/** True until the single admin exists (/api/setup); the UI shows the setup dialog then. */
	onboarding: boolean;
	/** Admin name for the top-bar user chip; null until /api/setup. */
	user: string | null;
	/** Task ids the user has read; global, server-persisted. */
	seenAnswers: string[];
	/** Epoch ms baseline, stamped once server-side: done tasks with doneAt at or before it count as read. */
	seenDoneSince: number;
	/** Acknowledged inbox entry keys (`task:`, `done:`, `error:`, notice keys); global, server-persisted
	 * (GlobalStore `inbox_seen`) so every browser and the service worker share one ack state. */
	inboxSeen: string[];
	/** Advisory: agent-launcher processes no running turn claims (machine-global); the tracker never kills them. */
	orphans: OrphanProcess[];
	/** Error from the last orphan process scan; null when the scan succeeded. Advisory only. */
	orphansError: string | null;
	/** Cancelled cards still holding a kept worktree: held total, stale past the keptWorktreeDays threshold. */
	keptWorktrees: { held: number; stale: number };
	/** While an update holds new turns (POST /api/drain): when the hold lapses unless the update renews it; null otherwise. */
	drainUntil: number | null;
	/** Commit subjects the pending update brings (POST /api/drain), sanitized; null when no hold. */
	drainCommits: string[] | null;
	/** Advisory: the agent layer is unseeded, or a model role's provider has no active sign-in
	 *  and no provider env key. Recomputed per poll; the UI shows them in the notice bar. */
	warnings: string[];
	/** Last good upstream update pull; null until a provider url and key are set and one pull succeeds. */
	updates: UpdatesView | null;
	/** Epoch ms when the connected alate server first reported pending true in this episode; null when
	 *  it reports none or has not answered yet. Advisory only: the bell waits out the threshold. */
	alatePendingSince: number | null;
	/** Advisory: providers a configured model role uses whose stored sign-in omp disabled, with the
	 *  disabled cause and the role names; empty when none or the store is unreadable. */
	deadSignIns: DeadSignIn[];
	/** Advisory: the server restart waits for an image ahead of the running commit (a deferred
	 *  update); null when nothing waits, the server already runs the image commit, or the
	 *  wait is younger than the notice threshold. */
	restartWait: RestartWaitView | null;
}

/** A deferred server restart the board surfaces after the notice threshold (OTTR-625). */
export interface RestartWaitView {
	/** The sha the running server holds (/etc/ottr/build-commit; the script records the short %h form). */
	running: string;
	/** The sha the built image holds (the record's commit; short %h form). */
	commit: string;
	/** Commits the image is ahead (running..commit on main); 0 when uncountable. */
	commits: number;
	/** Epoch ms when the wait began (the first deferral). */
	since: number;
	/** Card ids that held the restart at the last deferral. */
	turns: string[];
	/** The exact command that restarts the server now (the recreate the update
	 *  script's server step runs, with the deployment's own compose arguments);
	 *  the canonical plain form when the record names none. */
	command: string;
}

/** One provider usage window, e.g. Anthropic's 5-hour or 7-day limit. */
export interface QuotaLimit {
	/** omp provider id, e.g. "anthropic". */
	provider: string;
	/** omp's window label, e.g. "Claude 5 Hour". */
	label: string;
	/** omp's short window id, e.g. "5h" or "7d"; null when omp names no window. */
	window: string | null;
	/** omp's window label, e.g. "Monthly"; null when the window has no label. */
	windowLabel?: string | null;
	/** The account's plan from omp's metadata, e.g. "plus"; null when omp reports none. */
	plan: string | null;
	usedPct: number;
	/** Epoch ms when the window resets; null when omp reports none. */
	resetsAt: number | null;
}

export interface QuotaState {
	limits: QuotaLimit[];
	/** Why the last check failed; limits are empty then. */
	error: string | null;
	/** Epoch ms of the last check. */
	at: number;
}

/** Context-window reading from a task's omp session transcript; null = no session data. */
export interface SessionContext {
	/** Prompt tokens of the session's last assistant message (its contextSnapshot.promptTokens). */
	promptTokens: number;
	/** provider/model that wrote it, e.g. "zai/glm-5.3-flash"; null when unnamed. */
	model: string | null;
	/** How often the session was compacted (contextSnapshot.compactionEpoch). */
	compactions: number;
	/** When that assistant message completed (epoch ms; 0 when unparseable). */
	at: number;
}

export interface AddProjectResponse {
	project: ProjectView;
	/** "queued" | "not-needed" | "gitless" */
	interview: string;
	/** The rules interview card's id when the answer queued one; null when no card exists
	 * ("not-needed", "gitless"). The setup wizard turns it into an "Open rules task" action. */
	id: string | null;
}

/** GET /api/gh-status: gh auth facts for the Add project form's New tab. */
export interface GhStatus {
	/** false when gh is missing, unauthenticated, or unreachable; the form then warns instead of promising a repo. */
	authed: boolean;
	/** Login the repo would be created under; null when not authed. */
	user: string | null;
	/** Repo-name check: true = free, false = taken, null = not checked (no/invalid name or gh failure). */
	free: boolean | null;
	/** Server-side projects root; an unchecked box creates the local repo in here. */
	dir: string;
	/** The configured GitHub host (github.com or an Enterprise host) gh creates the repo on; null when the setting is invalid. */
	host: string | null;
}

/** `vX.Y.Z`: the release tag format, shared by the server (validation) and the dialog (input check). */
export const VERSION_RE = /^v\d+\.\d+\.\d+$/;

/** What "Create release" would release right now (GET /api/projects/:project/release). */
export interface ReleasePlan {
	/** The commit the release tags, frozen when the plan is made. */
	sha: string;
	/** Latest release tag contained in `sha` (highest vX.Y.Z); null before the first release
	 * or when the repo's latest GitHub release is not vX.Y.Z (nothing is computed then). */
	from: string | null;
	/** Next version per semver from the conventional commits since `from`; "v0.1.0" for the first
	 * release; "" when the repo's latest GitHub release is not vX.Y.Z (blocked below). */
	version: string;
	/** GitHub release notes (markdown): one bullet per feature, fix or change. */
	notes: string;
	/** Commits (without merges) in from..sha. */
	commits: number;
	/** Done tasks whose work is in from..sha, oldest first; question-only and no-op cards are dropped. */
	tasks: { id: string; title: string }[];
	/** Why the release can't start now; null when it can. Also set when the repo's latest
	 * GitHub release is not vX.Y.Z. */
	blocked: string | null;
}

/** One container's own cgroup v2 numbers plus its mutation lock, as read inside that container
 *  (worker GET /stats, and the server reading itself). Any unreadable field is null. */
export interface CgroupReading {
	/** Epoch ms of the read. */
	at: number;
	/** cpu.stat usage_usec: CPU time used since the container started. */
	cpuUsageUsec: number | null;
	/** cpu.max: the quota per period in microseconds, or "max" (no quota). */
	cpuMax: { quotaUsec: number; periodUsec: number } | "max" | null;
	/** memory.current in bytes (page cache included: the kernel counts it against memory.max). */
	memoryCurrent: number | null;
	/** memory.max in bytes, or "max" (no limit). */
	memoryMax: number | "max" | null;
	/** memory.events counters since the container started. */
	memoryEvents: { max: number; oom: number; oomKill: number } | null;
	/** `<os.tmpdir()>/ott-stryker.lock`: exists, the pid it holds (null when unparsable), and
	 *  whether that pid is alive (EPERM counts as alive). */
	lock: { exists: boolean; pid: number | null; alive: boolean };
	/** The live turns of this container by their worker run id (WorkerRequest.id), one entry per
	 *  run whose process tree /proc could read. The server reads no turns of its own: [] there. */
	runs: RunUsage[];
}

/** One turn's process tree (the omp process and every descendant) as /proc shows it now. */
export interface RunUsage {
	/** The worker run id (WorkerRequest.id). */
	id: string;
	/** Sum of Pss (smaps_rollup) in bytes: shared pages are split between the processes that
	 *  map them, so the turns of one container add up instead of counting a page twice. */
	memBytes: number;
	/** CPU time of the tree since the turn started: utime + stime of each live process, plus
	 *  cutime + cstime (the exited children it waited for). */
	cpuUsec: number;
}

/** One 30 s sample of a System row's history; null fields are a gap (unreachable, unreadable). */
export interface SystemPoint {
	at: number;
	/** CPU in percent of one CPU (docker stats style: 1585 is valid). */
	cpu: number | null;
	/** Memory used in bytes. */
	mem: number | null;
}

export interface SystemCard {
	project: string;
	id: string;
}

/** One live turn's share of its container, from RunUsage samples. */
export interface TurnUsage {
	/** Memory now in bytes (RunUsage.memBytes). */
	mem: number;
	/** Highest mem of the 30 s samples since the board first saw this turn. */
	memPeak: number;
	/** CPU in percent of one CPU since the previous sample; null on the first sample. */
	cpuPct: number | null;
	/** CPU time of the turn's process tree since it started, in seconds. */
	cpuSec: number;
}

/** A live turn in the System view. usage null = no sample: a server turn, an unreachable
 *  worker, or a run the worker did not report (yet). */
export interface SystemTurn extends SystemCard {
	usage: TurnUsage | null;
}

/** One container in the System view: the server, then each OTTR_WORKER_URLS worker. */
export interface ContainerRow {
	/** "server", or the worker url's hostname (e.g. "worker-a"). */
	name: string;
	/** False while the worker's GET /stats fails; every reading field is null then. */
	reachable: boolean;
	/** Epoch ms of the first failed poll in the current outage; null while reachable. */
	unreachableSince: number | null;
	/** Latest CPU in percent of one CPU; null without two readings. */
	cpuPct: number | null;
	/** CPUs the container may use: cpu.max quota/period, or the VM CPU count when "max". */
	cpuShare: number | null;
	memUsed: number | null;
	/** memory.max in bytes; null = no limit (or unreadable: see memUsed). */
	memLimit: number | null;
	/** memory.events max and oom_kill since the container started. */
	memMaxHits: number | null;
	oomKills: number | null;
	/** Growth of those counters over the last hour of readings. */
	memMaxHitsHour: number | null;
	oomKillsHour: number | null;
	/** Last hour, oldest first, at most 120 points. */
	history: SystemPoint[];
	/** The board's live runs on this container (merge and local turns count as "server"),
	 *  the largest memory first; turns without usage last, in board order. */
	cards: SystemTurn[];
	/** holderPid null = free (no lock file, or its holder is dead). holderCard: the one live
	 *  run here whose progress is Stryker running, when exactly one is. waiters: live runs
	 *  here whose progress is "Stryker waiting for the mutation lock". */
	lock: {
		holderPid: number | null;
		holderCard: SystemCard | null;
		waiters: SystemCard[];
	};
	/** Warning reasons in plain text ("memory 93 %", "OOM kill in the last hour",
	 *  "CPU at 90 % of its share for 5 min"); empty = ok. */
	warnings: string[];
}

/** The Docker VM as the server's /proc sees it. Never warns. */
export interface VmRow {
	/** CPU busy percent of the whole VM (0..100); null until two /proc/stat reads. */
	cpuPct: number | null;
	cpus: number;
	load1: number | null;
	memAvailable: number | null;
	memTotal: number | null;
	/** Last hour, oldest first, at most 120 points; mem = memTotal - memAvailable. */
	history: SystemPoint[];
}

/** Board-wide holds: the update hold, the global cap, the queue. */
export interface SystemHolds {
	drainUntil: number | null;
	drainCommits: string[] | null;
	maxTotal: number | null;
	/** Running slots (slotUse sum). */
	running: number;
	/** queueOrder length. */
	queued: number;
	/** queuedAt (else createdAt) of the first card in queueOrder; null when nothing queues. */
	oldestQueuedAt: number | null;
}

/** GET /api/system and the socket's "system" frame. */
export interface SystemSnapshot {
	at: number;
	containers: ContainerRow[];
	vm: VmRow;
	holds: SystemHolds;
}

/** Appended to a PR review posted with the board token (the gh path): that review goes out
 *  under the poster's own GitHub identity, so the body itself says that an AI agent drafted
 *  it and a person posted it. A review posted as the GitHub App carries no footer: GitHub's
 *  Bot badge already says who posted it. */
export const REVIEW_FOOTER =
	"\n\n---\n<sub>Drafted by [Ottr](https://github.com/ottr-ai/ottr), an AI coding-agent tracker. A person read the draft and posted it.</sub>";
/** GitHub's limit on a review body (65536 characters) minus the footer: the editable draft's limit. */
export const REVIEW_BODY_MAX = 65536 - REVIEW_FOOTER.length;
/** The card's needsReason while a PR review draft waits for the user to post it. */
export const PR_REVIEW_WAITING =
	"Review the draft, then post it to GitHub or ask for a new draft.";

/** Time ranges the performance dashboard can filter by. */
export const PERF_RANGES = ["1h", "24h", "7d", "30d", "90d", "all"] as const;
export type PerfRange = (typeof PERF_RANGES)[number];

/** One Overview KPI: the window value, the previous equal window (null in
 *  range "all"), and one value per sparkline bucket (null where the bucket has no input). */
export interface PerfStat {
	value: number | null;
	prev: number | null;
	series: (number | null)[];
}

/** Overview performance for one project or the fleet; rates are fractions 0..1, times in ms. */
export interface PerfMetrics {
	throughput: PerfStat;
	leadMedianMs: PerfStat;
	leadP90Ms: PerfStat;
	firstPass: PerfStat;
	failure: PerfStat;
	spend: PerfStat;
	/** Average final context-window size (prompt tokens) over the window's done tasks
	 *  with a captured reading; null when none has one. */
	contextAvgTokens: PerfStat;
	/** Largest final context-window size (prompt tokens) over the window's done tasks
	 *  with a captured reading; null when none has one. Same shape rules as contextAvgTokens. */
	contextMaxTokens: PerfStat;
	/** The done task holding contextMaxTokens.value, named so the board can link to it;
	 *  null whenever the value is null. */
	contextMaxTask: { project: string; id: string } | null;
	/** Counts of the current window. */
	done: number;
	firstPassDone: number;
	turns: number;
	failedTurns: number;
	/** Finished turns in the window without captured cost. */
	costMissing: number;
	/** Done tasks in the window without a captured context reading. */
	contextMissing: number;
}

/** `GET /api/performance?range=`: bucket i covers [seriesStart + i*bucketMs, +bucketMs). */
export interface PerfResponse {
	range: PerfRange;
	bucketMs: number;
	seriesStart: number;
	fleet: PerfMetrics;
	projects: (PerfMetrics & { name: string })[];
}

/**
 * Board socket (`GET /api/ws`): push-only, the server ignores inbound frames. On open it sends
 * `state`, `update` and the latest `system`; afterwards:
 * - `state`: whenever the serialized StateResponse changes (checked after every mutating request,
 *   every scheduler run, and every 1 s while a tab is connected);
 * - `system`: every 30 s, one sampler for all tabs; the containers' and VM's readings and holds;
 * - `update`: when the behind-count changes (refreshed every 5 min while a tab is connected);
 * - `log`: the task's log file grew; at most one per 250 ms per task. Fetch the bytes with
 *   `GET /api/projects/:project/tasks/:id/log?from=N`;
 * - `ping`: every 5 s, liveness only.
 */
export type ServerMessage =
	| { type: "state"; state: StateResponse }
	| { type: "system"; system: SystemSnapshot }
	| { type: "update"; behind: number; commits: string[] }
	| { type: "log"; project: string; id: string }
	| { type: "ping" };
