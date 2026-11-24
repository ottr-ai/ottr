// Shared contract for omp-task-tracker. Every module imports its types from here.

import type { CommitIdentity } from "./gitIdentity.ts";
import type { TokenUsage } from "./hosted.ts";
import type { DeadSignIn } from "./login.ts";
import type { UpdateCycleView } from "./updateCycle.ts";
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
export type OutcomeStatus =
	| "ready"
	| "answered"
	| "integrated"
	| "needs_you"
	| "superseded";

/** The fixed reply text that approves a parked merge hold; the drawer's approve button sends it. */
export const APPROVE_REPLY = "approved";

export const OUTCOME_STATUSES: readonly OutcomeStatus[] = [
	"ready",
	"answered",
	"integrated",
	"needs_you",
	"superseded",
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
	/** The question the user must answer before the task can start; absent when none. A
	 *  proposal with a decision always waits for Accept (docs/specs/retro-auto-start.md). */
	decision?: string;
}

/** One question of the agent's outstanding `ask` call; the UI renders options as click-to-answer
 * buttons, and a text question (`text`, no options) as a single-line typed answer. */
export interface AskQuestion {
	question: string;
	options: AskOption[];
	multi: boolean;
	/** Zero-based recommended option index; null when the agent gave none. */
	recommended: number | null;
	/** Free-text question: true exactly when `options` is empty; `multi` is then false and
	 * `recommended` null. */
	text: boolean;
}

/** One gate question the gate itself answered with the default it would build with (OTTR-904). */
export interface GateAssumption {
	/** The gate's question, verbatim. */
	question: string;
	/** The default the gate would build with; never null here (a null-default question blocks instead). */
	answer: string;
}

/** The comprehension gate's persisted state for one card (OTTR-823, JSON in the DB). */
export interface PromptGateState {
	/** sha256 hex of the compared effective text this gate passed (or the user started anyway); null = never passed. */
	hash: string | null;
	/** Every user text the gate has seen so far, "\n\n"-joined; each pass and each Start anyway appends the newest queued text (a "." marker never counts). Keeps the skip rule stable across consumption and never drops earlier answers. */
	seen: string | null;
	/** Consecutive failed gate evaluations with the same failure signature. */
	fails: number;
	/** The last park's failure signature: the blocking question texts joined, or "error". */
	sig: string | null;
	/** True while the card sits in a gate park; the drawer shows Start anyway. */
	parked: boolean;
	/** The gate's non-blocking questions with the answers it would build with (OTTR-904); absent when none. Rides to the work turn as the Gate assumptions block. */
	assumptions?: GateAssumption[];
	/** The outside check the gate adopted when the prompt text carried none (OTTR-904); absent when the text carried one. */
	check?: string;
	/** The parked "Open questions" section's context lines that are not questions and not
	 * agent instructions (OTTR-1160); absent when none. The drawer renders them once above the ask questions. */
	context?: string[];
	/** The duplicate-work gate's stamp (OTTR-941); absent = the gate never ran on this card. */
	dup?: DupGateStamp;
}

/** The duplicate-work gate's outcome on one card (OTTR-941); "error" = the gate failed open. */
export interface DupGateStamp {
	verdict: "duplicate" | "partial" | "new" | "error";
	/** The overlap note (partial) or the close reason (duplicate). */
	note?: string;
}

/** Normalizes an ask tool call's `{ questions: [...] }` args; null when no usable question is inside. */
export function askQuestions(args: unknown): AskQuestion[] | null {
	if (typeof args !== "object" || args === null || !("questions" in args))
		return null;
	const raw: unknown = args.questions;
	if (!Array.isArray(raw)) return null;
	const out: AskQuestion[] = [];
	for (const item of raw) {
		const q = askQuestionOf(item);
		if (q !== null) out.push(q);
	}
	return out.length > 0 ? out : null;
}

/** The drawer's ask-answer wire line: AskPanel sends one per answered question, and the
 * board-side parsers (the review question card's reply route) read the same format back. */
export function askAnswerLine(question: string, answer: string): string {
	return `For "${question}": ${answer}`;
}

/** The separator between an ask answer's pick and the optional note the drawer's note
 * field adds (OTTR-1281). The note never holds a newline (askAnswerWithNote folds them),
 * so the last separator is always the note's own: no pick text (an option label, an
 * Other answer) can be split by mistake. */
const ASK_NOTE_SEP = "\nNote: ";

/** An ask answer with the user's optional note on its own line behind the pick. A blank
 * note adds nothing, unless the pick itself holds the separator text: then an empty note
 * line keeps askAnswerParts from splitting the pick. */
export function askAnswerWithNote(answer: string, note: string): string {
	const n = note.replace(/\n/g, " ").trim();
	return n === "" && !answer.includes(ASK_NOTE_SEP)
		? answer
		: `${answer}${ASK_NOTE_SEP}${n}`;
}

/** Splits an ask answer into its pick and its note (empty when it carries none): the
 * inverse of askAnswerWithNote. */
export function askAnswerParts(answer: string): { pick: string; note: string } {
	const at = answer.lastIndexOf(ASK_NOTE_SEP);
	return at === -1
		? { pick: answer, note: "" }
		: {
				pick: answer.slice(0, at),
				note: answer.slice(at + ASK_NOTE_SEP.length),
			};
}

/** One normalized ask question, or null when its question text is unusable; unusable or
 * missing options degrade to a text question instead of null. */
function askQuestionOf(item: unknown): AskQuestion | null {
	if (typeof item !== "object" || item === null || !("question" in item))
		return null;
	const { question } = item;
	if (typeof question !== "string") return null;
	// No options (absent or not an array): the user answers by typing one line.
	const rawOptions = "options" in item ? item.options : null;
	if (!Array.isArray(rawOptions))
		return {
			question,
			options: [],
			multi: false,
			recommended: null,
			text: true,
		};
	const multi = "multi" in item ? item.multi : undefined;
	const recommended = "recommended" in item ? item.recommended : undefined;
	const options: AskOption[] = [];
	const keptRaw: number[] = [];
	for (const [rawIdx, entry] of rawOptions.entries()) {
		const option = askOptionOf(entry);
		if (option === null) continue;
		options.push(option);
		keptRaw.push(rawIdx);
	}
	// No usable option survived (including an empty options array): the text form
	// wins over multi/recommended, which have nothing to point at.
	if (options.length === 0)
		return {
			question,
			options: [],
			multi: false,
			recommended: null,
			text: true,
		};
	// recommended is a raw index; map it onto the kept options or null when that
	// option was dropped. indexOf rejects non-integers/out-of-range for free.
	const at =
		typeof recommended === "number" ? keptRaw.indexOf(recommended) : -1;
	return {
		question,
		options,
		multi: multi === true,
		recommended: at === -1 ? null : at,
		text: false,
	};
}

/** One normalized ask option, or null when the entry has no usable label. */
function askOptionOf(entry: unknown): AskOption | null {
	if (typeof entry !== "object" || entry === null || !("label" in entry))
		return null;
	const { label } = entry;
	const description = "description" in entry ? entry.description : undefined;
	if (typeof label !== "string") return null;
	return typeof description === "string" ? { label, description } : { label };
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
	/** PR mode only: the pull request body the merge turn wrote for the PR the server opens; missing or blank = the PR body falls back to the report text. */
	prBody?: string;
	/** Superseded merge turns only: the id of the follow-up card this turn filed with create_task for the gap main's flow left. A superseded report without a linked follow-up parks instead of closing. */
	followUp?: string;
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
	/** Extra env var names the release command keeps from the server env, whitespace-separated
	 * and stored deduped; null = only PATH, HOME, LANG, TERM and the safe PostgreSQL test env.
	 * Names only: the values always come from the server env at spawn time, never from this
	 * setting. */
	releaseEnv: string | null;
	/**
	 * Runs once after a release succeeds, in a clean worktree at the released tag, with
	 * OTTR_RELEASE_TAG in the env; null = no post-release step. Split on spaces (double
	 * quotes group), no shell.
	 * docs/specs/post-release-command.md
	 */
	postReleaseCommand: string | null;
	/**
	 * What happens to the post-release command's tracked changes: "card" files a normal
	 * merge card, "commit-push" pushes changes under postReleasePaths straight to the
	 * target branch.
	 * docs/specs/post-release-command.md
	 */
	postReleaseLanding: "card" | "commit-push";
	/**
	 * Repo-relative path prefixes (segment-wise, gitignore respected) that the
	 * "commit-push" landing may push directly; the "card" landing ignores them.
	 * docs/specs/post-release-command.md
	 */
	postReleasePaths: string[];
	/** Commits on the integration target before an architecture review is due. */
	archReviewCap: number;
	/** Leads one validation run (OTTR-1047) validates per run; a stored value below 1 behaves as 1. */
	validationBatchSize: number;
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
	/**
	 * Bun.Glob patterns for repository paths that are not the product (a landing page, the
	 * marketing site, root docs, CI, agent or board files), extending the built-in defaults.
	 * Commits and cards that touch only these paths stay out of the consolidated release
	 * notes.
	 */
	nonProductPaths: string[];
	/** Update cards park at needs_you when a work turn ends ready; a reply approves the merge (U7). */
	holdUpdateMerges: boolean;
	/** Fork-born cards park at needs_you before their merge; a reply approves the parked head. Default on; turning it off does not release already parked cards. */
	forkMergeHold: boolean;
	/** Supervisor files a retro card for each task done at or after this timestamp; null disables retros. */
	retroSince: number | null;
	/** Skip the retro of a smooth, cheap task (the friction filter); false gives every task a retro. */
	retroFilter: boolean;
	/** A retro proposal with no decision starts as a queued card instead of waiting for Accept (docs/specs/retro-auto-start.md). */
	retroAutoStart: boolean;
	/** Hourly fork watch: analyze new fork-only commits with a tool-free model call and file held proposals (off by default). */
	forkResearch: boolean;
	/** Hourly PR watch: file or requeue a read-only review card for each settled open PR (off by default). */
	prReviews: boolean;
	/** Bell entry and Web Push for PR review drafts, draft updates and new comments after a posted review; off keeps the badges and lanes only. */
	prReviewNotify: boolean;
	/** Post also approves the PR when the run found no blocking findings; off by default. */
	prReviewApprove: boolean;
	/** Post requests changes when the run found blocking findings; off by default. */
	prReviewRequestChanges: boolean;
	/** Only a Post click posts a review draft; off lets the board post each finished draft by itself (docs/specs/pr-review-auto-post.md). */
	prReviewManualPost: boolean;
	/** Per-project PR mode: integration pushes the card branch and opens a GitHub pull request instead of merging into the target branch (off by default). */
	prMode: boolean;
	/** Run work turns in a Firecracker microVM via vm-runner instead of a worker container (off by default; docs/adr/0009-microvm-workers.md). */
	microVm: boolean;
	/** Weekly trending scout: file a read-only scout card for this project at each GitHub trending scan (off by default). */
	trendingScout: boolean;
	/** Hourly issue watch: file each new open GitHub issue as a backlog card and label it ottr-tracked (off by default). */
	issueWatch: boolean;
	/** Hourly code scanning watch: file each open CodeQL alert rule as a backlog card, grouped by rule (off by default; docs/specs/code-scanning-watch.md). */
	codeScanWatch: boolean;
	/** Start code-scanning cards automatically: on, the code scanning watch files each new consolidated rule card in Todo (queued) instead of Backlog; existing cards never move (off by default; docs/specs/code-scanning-watch.md). */
	codeScanAutoStart: boolean;
	/** When issueWatch last turned on (epoch ms); null while never enabled. */
	issueWatchSince: number | null;
	/** Hourly omp release watch: a model reviews each new omp release; fail and bump cards (off by default; docs/specs/omp-watch.md). */
	ompWatch: boolean;
	/** Warn on the project page when Dependabot alerts are off for the repo on GitHub, with a link to enable them (on by default; docs/specs/dependabot-warning.md). */
	dependabotWarn: boolean;
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
	/** Task id handle like OTTR; null = derived from the folder name. Uppercase letters and digits, at most 8. */
	taskIdPrefix: string | null;
	/** Name of the board-level Jira connection this project imports from; null = none. */
	jiraConnection: string | null;
	/** The last JQL query that searched successfully, restored in the import dialog; null = none yet. */
	jiraLastJql: string | null;
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
	| "trending"
	| "validation";

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
	/** True when the scan can send a github.com token (GH_TOKEN, or a stored github.com
	 *  token under Settings -> Git hosts); false means its api.github.com requests share
	 *  the network IP's unauthenticated 60-per-hour limit. */
	tokenPresent: boolean;
}

/** One project's PR watch poll facts, shipped in the project's view for the Settings
 * Watches card (OTTR-1071). In-memory only: a restart clears the times and the next
 * polls refill them. */
export interface PrWatchStatus {
	/** Clock value when the project's last poll completed; null before the first. */
	lastPollAt: number | null;
	/** The last poll's failure reason; null when it completed clean or never ran. */
	lastError: string | null;
	/** Clock value of the next regular hourly poll (the server's interval grid);
	 * null when the wiring names no grid. */
	nextPollAt: number | null;
}

/** OTTR-1087: the code scanning watch's poll facts, shipped in the project's view for the
 * Settings Watches card. Mirrors PrWatchStatus; in-memory only: a restart clears the
 * times and the next polls refill them. */
export interface CodeScanWatchStatus {
	/** Clock value when the project's last poll completed; null before the first. */
	lastPollAt: number | null;
	/** The last poll's failure reason; null when it completed clean or never ran. */
	lastError: string | null;
	/** Clock value of the next regular hourly poll (the server's interval grid);
	 * null when the wiring names no grid. */
	nextPollAt: number | null;
}

/** U7: an update card parked by holdUpdateMerges; the reply recognizes it by this reason. Shared by the turn loop and the drawer's hold action bar. */
export const UPDATE_HOLD_REASON =
	"Update card: read the summary, then reply to approve the merge.";

/** A fork-born task parked for merge approval; the reply recognizes it by this reason. */
export const FORK_HOLD_REASON =
	"Fork-research-born task: the merge is held. Reply to approve the merge, or cancel the card.";

/** The trending scan's hint for a board with no github.com token: its api.github.com
 *  requests then share the network IP's unauthenticated 60-per-hour limit. */
export const TRENDING_TOKEN_HINT =
	"Add a github.com token under Settings -> Git hosts. Requests without a token share the 60 per hour limit of your network's IP.";

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

/** One earlier inline finding the re-review found fixed, keyed by GitHub's
 * comment id; the Post resolves its review thread (docs/specs/pr-reviews.md
 * "Resolve fixed threads"). */
export interface FixedThread {
	/** GitHub comment id of the board's posted review's inline comment. */
	id: number;
	path: string;
	/** New-file (RIGHT-side) line of the finding. */
	line: number;
}

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
	/** The event the posted review used (REQUEST_CHANGES); null for COMMENT/APPROVE or no post. */
	postedEvent: string | null;
	/** Who posted the current review: "user" for a Post click, "auto" for the board (docs/specs/pr-review-auto-post.md); null for no post or an older post. */
	postedVia: string | null;
	state: PrState;
	draft: boolean;
	title: string;
	postError: string | null;
	/** Earlier inline findings of the reviewed head's re-review that the model found fixed; the Post resolves their threads. Empty for a first review and for older rows. */
	fixedThreads: FixedThread[];
	/** Newest comment time the watcher has surfaced (epoch ms); the comment sweep's cutoff. Null before the first sweep. */
	commentsAt: number | null;
	/** The current comment wave is unseen: the bell row and the `pr:` alert are live. */
	commentsUnseen: boolean;
}

/** The watcher's in-memory record of a PR's last draft run; a restart drops it. */
export interface PrRunState {
	startedAt: number;
	/** null while the run is in flight. */
	endedAt: number | null;
	/** The skip reason or error text; null when the run saved a draft. */
	error: string | null;
	/** The review model the watcher ran: `@plan` on the default path, `custom` when injected. */
	model: string;
}

/** The PR facts a pr_review card's drawer shows. */
export interface PrReviewView {
	number: number;
	url: string;
	state: PrState;
	/** The PR's current head: the head the next draft reviews. */
	head: string;
	/** True once a draft of this head was saved (the store's per-head review history), so a re-review of it runs in full. */
	headReviewed: boolean;
	reviewedHead: string | null;
	postedHead: string | null;
	/** html_url of the posted review; null until a Post succeeds. */
	postedUrl: string | null;
	/** GitHub login the review was posted as (app bot or person); null when unknown. */
	postedLogin: string | null;
	postError: string | null;
	/** The PR's last draft run; null when none ran since the server started. */
	run: PrRunState | null;
	/** Threads the next Post will resolve: the draft's fixed findings, only while a post is pending. */
	willResolve?: FixedThread[];
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
	/** Who wrote the card's prompt (OTTR-850): "user" (New task form, steer, a user edit)
	 * or "board" (a template, or a card an agent filed). The prompt gate skips its model
	 * call for board prompts; every DB row carries the column, defaulted to "user". */
	promptAuthor: "user" | "board";
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
	/** Optimistic-locking counter (OTTR-795): bumps on every store write; guarded edits send the value they loaded and get a 409 with the current card when it moved. Never caller-settable. */
	revision: number;
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
	/** Comprehension-gate state (JSON in the DB, OTTR-823); null = the gate never ran on this card. */
	gate: PromptGateState | null;
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
	/** OTTR-877: the review feedback watch's cutoff (epoch ms); null = never swept, the first sweep initializes silently. */
	prWatchAt: number | null;
	/** OTTR-1056: the answered PR-head CI failure as `<pushSha>:<runId>#<attempt>[,...]`; null = nothing answered on the card. A matching key keeps ciPrHeadReply from replying again to the same head and run. */
	ciPrAnsweredKey: string | null;
	/** OTTR-1056: that failure's failed-check lines (`- name: conclusion - url`, capped at 300 chars); a CI-reply work turn that changes nothing shows them on the card. */
	ciPrAnsweredInfo: string | null;
	/** OTTR-877: true when pending_prompt is supervisor-written reviewer feedback; passes settle through it, replies clear it. */
	pendingFeedback: boolean;
	/** OTTR-760: the pull request this card was filed from (a Dependabot PR); null for every other card. The ship step adopts it instead of opening a second PR. */
	sourcePrNumber: number | null;
	sourcePrUrl: string | null;
	/** The source PR's head branch name at filing time; the push target when the card's fixes land on the PR. */
	sourcePrHeadRef: string | null;
	/** The source PR's head sha at filing time; the base the ship step compares the card branch against. */
	sourcePrHeadSha: string | null;
	/** True when the source PR's head lives in another repository (a fork): the board can never push fixes there. */
	sourcePrCrossRepo: boolean;
	/** True when the source PR came from Dependabot: the bot stops updating a branch someone else pushed to, so the board comments "@dependabot rebase" instead of pushing. */
	sourcePrDependabot: boolean;
	/** OTTR-1063: true when the ship proved the card branch holds nothing beyond the target (an integrated merge turn rebased it onto a moved target). The card waits only on its source PR and finishes done once that PR closes — merged or closed unmerged; the watch never parks it. */
	sourcePrSuperseded: boolean;
	/** OTTR-996: the outside issue or ticket this card was filed from; null for every
	 * other card. The GitHub issue number as text for issue-watch cards, the Jira issue
	 * key for Jira imports. The prompt embeds that author's text, so the duplicate gate
	 * never uses the card as a duplicate candidate. */
	sourceIssue: string | null;
	/** OTTR-809: the follow-up pull request the ship step opened for a Dependabot card's
	 * fixes beyond the source PR's head (base = the Dependabot branch); null otherwise.
	 * The card waits for this PR and the source PR to merge before it finishes. */
	followUpPrNumber: number | null;
	followUpPrUrl: string | null;
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
	/** Agent-data sync gate runs the board executed for this card, oldest first, capped at
	 *  the newest 20 runs (docs/specs/agent-data-sync-gate.md). Empty on every other project. */
	syncGateLog: SyncGateRun[];
	/** Work-check send-backs to the work agent so far; once WORK_CHECK_MAX_SENDBACKS have run, every failing check asks the user (send it back, merge anyway, or cancel) before another send-back. */
	workCheckSendbacks: number;
	/** Branch head the last completed check saw; the re-check's diff starts here (empty when the head did not move). */
	workCheckHead: string | null;
	/** The ready report (summary and details, else the run's final message) the card's first completed work check judged; every re-check gets it as the original result next to the update. Null until a completed check stamps it, never overwritten. */
	workCheckReport: string | null;
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
	/** Consecutive usage-limit holds this card collected (OTTR-880): the probe wait grows with
	 * it (30m → 6h). A settle that runs past the limit clears it back to 0. */
	holdAttempts: number;
	/** When the current hold was stamped (epoch ms); null without a hold. The quota refresh
	 * counts only sightings after it as early-release evidence (OTTR-880). */
	holdSetAt: number | null;
	/** Manual triage rank; null = unrated. Overview triage sorts P0 first, unrated last. */
	priority: Priority | null;
	/** Close-candidate nomination: the reason this card is a duplicate, superseded, or drifted; null = not nominated. */
	closeCandidate: string | null;
	/** The review-check stamp over the card's stored review findings (findingsCheckedAt in the
	 * store): set when a check pass completes over them, cleared when a new finding arrives. */
	findingsCheckedAt: number | null;
	/** OTTR-1047: the card was validated by a validation run (validatedAt in the store). Set
	 * when the validation settle applies a result to this backlog lead; never set for any
	 * other kind. Store column validated_at; the validation settle writes it, nothing else. */
	validatedAt: number | null;
	/** OTTR-963: the card sat in stage `backlog` when its review finished. The store stamps
	 * it when a review card lands done and never changes it afterwards, so it is the
	 * recorded stage at doneAt, not a derivable one. The scheduler exempts flagged findings
	 * of a done review from the findings hold, also after the lead leaves the backlog.
	 * Store column lead_at_done; never caller-settable. */
	leadAtDone: boolean;
	/** OTTR-1252: true while the lead waits for its review's validation run: the
	 * scheduler never starts it as a work turn, also when validatedAt is set.
	 * Cleared by a confirmed result or the user's applies answer. Store column
	 * waits_validation; caller-settable so update patches can set and clear it. */
	waitsValidation: boolean;
}

/** A task from a list read (ProjectStore.listTasks): every field but diffText, details,
 * report and diffFiles, which only getTask loads (wide text the list callers never read).
 * Code that reads list rows takes this type, so a read of any of those four needs getTask;
 * the drawer fetches them per task. */
export type ListedTask = Omit<
	Task,
	"diffText" | "details" | "report" | "diffFiles"
>;

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

/** One user-set vendor rule of the check routing: a work model whose vendor is `vendor`
 *  checks with the model of role `role`. */
export interface CheckRoutingRule {
	/** Lowercase vendor key (modelVendor's keys, or "unknown" for a model with no known vendor). */
	vendor: string;
	/** The model role the check uses; the role needs no configured model at save time. */
	role: string;
}

/** User-set vendor routing for the second-model check (Settings -> Model roles). The first
 *  rule whose vendor matches the work model's vendor names the check role; when no rule
 *  matches, a nonempty fallback names it; otherwise the built-in default rule applies
 *  (checkRoleFor). null = automatic routing, no setting. Board-wide, stored in the
 *  GlobalStore config row. */
export type CheckRoutingSetting = {
	rules: CheckRoutingRule[];
	/** Role for models no rule matches; "" = straight to the default rule. */
	fallback: string;
} | null;

/** One run of the second-model check of a work card. */
export interface WorkCheckRun {
	/** Epoch milliseconds when the check run started. */
	at: number;
	/** Model selector the check ran with: the critic or adversary role's model, else the
	 *  board's default role (omp's fallback when a model is unset); null = omp's own default
	 *  (no role names it, so the card shows "default model"). */
	model: string | null;
	/** The role the check's model came from: the routed check role (checkRoleFor), or
	 *  "default" when that role is unset and the model fell back to the default role.
	 *  Old records carry only "critic", "adversary", or "default".
	 *  Absent on records written before this field existed and on lost runs (settleLostCheck). */
	role?: string;
	/** pass = nothing blocks, blockers = real problems found, error = the run itself failed after a retry. */
	outcome: "pass" | "blockers" | "error";
	blockers: WorkCheckBlocker[];
	/** Non-blocking findings: no quote, or the quote matched nothing in the diff, the report, or the transcript. */
	notes: string[];
	durationMs: number;
	/** The failed-run reason when outcome is "error". */
	error?: string;
	/** Why the check gives no second-model opinion: it ran on the checked run's own model
	 *  or at least its vendor (checkModelWarning). Absent when the check differs in vendor. */
	warn?: string;
	/** The direction this send-back round carries: a user's typed reply, or the board's rethink
	 *  instruction on a counts-only park. Stamped when the send-back queues (app.ts), so the next
	 *  check judges the directed approach without parsing the sent-back text. Absent on plain
	 *  rounds and on old records. */
	direction?: string;
}

/** One sha256 comparison the sync gate recorded: the card's changed `projects/` file
 *  and its installed twin at the workspace root. */
export interface SyncGateFileHash {
	/** The data-repo-relative path, for example `projects/ottr/AGENTS.md`. */
	path: string;
	/** sha256 of the worktree source file; null when the worktree file is missing. */
	sourceSha256: string | null;
	/** sha256 of the installed twin; null when no installed file exists there. */
	installedSha256: string | null;
	/** True only when both hashes exist and are equal. */
	match: boolean;
}

/** One install the sync gate declined (OTTR-1305): the branch never changed the
 *  mapped `projects/` path, but its snapshot bytes differ from the installed
 *  twin, so installing them would overwrite the fresher live bytes with stale
 *  ones from an older fork point. */
export interface SyncGateSkip {
	/** The data-repo-relative path the gate declined to install. */
	path: string;
	/** Why the gate skipped it, for example the stale-source reason. */
	reason: string;
}

/** One run of the agent-data sync gate the board executed for a work card
 *  (docs/specs/agent-data-sync-gate.md). Board-written tracked data: the record
 *  lands in the store before the turn sees it, so a report can cite it without
 *  the agent forging it. */
export interface SyncGateRun {
	/** Epoch milliseconds when the gate run started. */
	at: number;
	/** The commit sha the gate ran against: sync installs an immutable archive of
	 *  HEAD, never the worktree's disk bytes. Absent on refusal records that
	 *  never resolved a head and on records written before this field existed. */
	head?: string;
	/** The gate process's exit code; null when the gate never spawned (a guard or
	 *  spawn refusal — the reason rides in `error`). */
	code: number | null;
	/** Combined stdout+stderr of the gate run, capped. */
	output: string;
	/** True when output hit the cap and lost its tail. */
	truncated: boolean;
	/** Per-file hash comparison for the card's changed `projects/` files. */
	files: SyncGateFileHash[];
	/** The installs the gate declined before the child ran; absent when nothing
	 *  was skipped. A skipped path still carries its files entry, hashed before
	 *  the decline, so the record shows the stale bytes the gate refused. */
	skipped?: SyncGateSkip[];
	/** Wall-clock duration of the whole gate step (guards, run, hashing). */
	durationMs: number;
	/** The refusal reason when the gate never ran or failed to start. */
	error?: string;
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
	/** Byte offset in the card log where this turn's own section starts (the `== turn`
	 *  header line); null for rows recorded before the field or when the offset could not
	 *  be captured. */
	logOffset: number | null;
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
	/** A retro run's first succeeded `propose_task` call (proposal held for approval), or null.
	 * summary holds the five decision fields the call carried, or null when it sent none.
	 * project names the board project the card files on; null files on the retro's own. */
	proposed: {
		prompt: string;
		model: string | null;
		summary: ProposalSummary | null;
		/** The question the user must answer before the card starts; absent or null when none. */
		decision?: string | null;
		project: string | null;
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
	/** Files of the alate-provisioned agent layer that no longer match alate's installed.json
	 * manifest, audited when the run settled (docs/specs/turn-provision-guard.md). Non-empty
	 * fails the turn: the only path for layer changes is agent-data -> import -> provision. */
	provisionDrift?: string[];
	/** True when the worker container's memory limit killed the run: the run ended with
	 * no exit code (a signal) while the cgroup v2 memory.events oom_kill count grew.
	 * Classic workers only; absent otherwise (docs/specs/worker-oom-continue.md). */
	oomKilled?: boolean;
	/** The worker container's memory.max byte limit read beside the oom_kill counters;
	 * null when the container has no limit ("max") or the cgroup files were unreadable. */
	memoryLimitBytes?: number | null;
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
	 * one; set whenever holdUntil is set. Null when the provider is unknown: the quota refresh
	 * can then never release the hold early. Absent keeps the columns. */
	holdProvider?: string | null;
	holdWindow?: string | null;
	/** The consecutive-hold count a usage-limit hold stamps (OTTR-880); it makes the next
	 * probe wait longer. A settle without a hold clears the column to 0. */
	holdAttempts?: number;
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

/** One held fork-branch commit with the PR it was judged against. */
export interface ForkHoldState {
	forkId: number;
	branchHash: string;
	/** 40-hex commit sha. */
	sha: string;
	/** PR number the commit was judged against. */
	pr: number;
	/** PR head the judgment used (40-hex). */
	prHead: string;
	/** 1 = dropped from its PR; rides the next analysis range, then the row is deleted. */
	released: number;
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
	/** The review card that keeps `running` true (queued, running, or with open findings); null when nothing runs. */
	runningCardId: string | null;
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

/** A validated homepage URL and the host shown in the project header. */
export interface ProjectHomepage {
	url: string;
	domain: string;
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
	/** Rules are available: AGENTS.md or .omp/AGENTS.md in the main checkout, or the target tracks AGENTS.md. */
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
	 * Settings → GitHub → GitHub host. Null when the features are on or the origin is
	 * not a ghe.com tenant. */
	githubHostNotice: string | null;
	/** True when the repo's Dependabot alerts are off on GitHub and the dependabotWarn
	 * setting is on; the project header shows the advisory with the enable link
	 * (docs/specs/dependabot-warning.md). */
	dependabotOff: boolean;
	/** OTTR-675: true when the target branch requires pull requests (a pull_request
	 * repository rule) and PR mode is off; the project header shows the advisory with
	 * the turn-on action. */
	prModeSuggestion: boolean;
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
	/** Validated homepage of the GitHub repo, or null when none is available. */
	homepage: ProjectHomepage | null;
	/** OTTR-1071: the PR watch's poll facts (last check, its error, next regular check),
	 * shown by the Settings Watches card's PR reviews row. */
	prWatch: PrWatchStatus;
	/** OTTR-1087: the code scanning watch's poll facts (last check, its error, next
	 * regular check), shown by the Settings Watches card's Code scanning row. */
	codeScanWatch: CodeScanWatchStatus;
	settings: ProjectSettings;
	/** Effective task id handle: the taskIdPrefix override or the folder-derived default. */
	taskPrefix: string;
	/** OTTR-965: the project's done and cancelled card count. The Done lane's first
	 * "Show more" derives the hidden count from it before any page fetch. */
	doneTotal: number;
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
	/** Repo-relative files kept when the worktree was removed; present on the drawer detail view only. */
	savedFiles?: { name: string; size: number }[];
	/** Set when the savedFiles walk hit its depth, entry or byte cap (docs/specs/saved-files.md): the list is a prefix, so "…and more" counts are lower bounds. */
	savedFilesTruncated?: boolean;
	/** Set only for kind "pr_review". */
	prReview?: PrReviewView;
	/** Set only for kind "pr_review" while the project alerts PR reviews: the draft run stamp and the unseen comment stamp that key the bell occurrences, plus the board-posted stamp (docs/specs/pr-review-auto-post.md). The head keys the posted occurrence. */
	prOccurrence?: {
		draft: number | null;
		comments: number | null;
		posted?: { url: string; number: number; head: string } | null;
	};
	/** OTTR-1073: set only for kind "pr_review". The watcher's last draft run; its start and end change the board row, so an open drawer refetches the detail and the composer's run status moves. */
	prRun?: PrRunState | null;
	/** Present on the drawer detail of a release card waiting for approval; commits between the reviewed base and the target head. */
	lateCommits?: LateCommit[];
	/** The retro card filed after this card (kind "retro", followUpOf this card); this card's
	 * Work steps show its turns, and the board shows no card for it. Absent without a retro. */
	retro?: RetroView;
	/** Review and release cards only: the cards the review filed (reviewFindings), oldest
	 * first. This card's Work steps show their turns; each finding stays a card of its own.
	 * Absent without findings. */
	findings?: FindingView[];
	/** Set only for a waiting lead's card view: the project's open validation run's card
	 * id, for the drawer's disabled Validate now. */
	openValidationRun?: string | null;
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

/** A task as shipped in /api/state: the lane facts only (OTTR-965). The wide text fields —
 * prompt, summary, work check log and report, gate, details, report, diff text and files —
 * stay in the store; the drawer fetches them per task from /api/projects/<p>/tasks/<id>.
 * needsReason and asked stay: the lanes and the ask drafts read them. */
export type TaskCard = Omit<
	Task,
	| "prompt"
	| "summary"
	| "details"
	| "report"
	| "diffFiles"
	| "diffText"
	| "workCheckLog"
	| "syncGateLog"
	| "workCheckReport"
	| "gate"
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
	/** OTTR-1128: present (true) on a review lead, a card whose prompt carries the "Needs
	 * validation" tag. The card ships no prompt, so the hold rules (scheduler.ts isLead)
	 * read this mark instead. */
	lead?: true;
	/** OTTR-1247: present (true) on a pending sandbox lead: a never-validated lead whose
	 * blocker is a sandbox run (scheduler.ts pendingSandboxLead). The card ships no
	 * prompt, so holdFor and the check-ottr-board report read this mark instead of the
	 * prompt tag; a deployment-fact lead carries no stamp. */
	sandboxLead?: true;
	/** Set only for kind "pr_review" while the project alerts PR reviews: the draft run stamp and
	 * the unseen comment stamp that key the bell occurrences, plus the board-posted stamp
	 * (docs/specs/pr-review-auto-post.md). The head keys the posted occurrence. */
	prOccurrence?: {
		draft: number | null;
		comments: number | null;
		posted?: { url: string; number: number; head: string } | null;
	};
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

/** The compact card index the state ships next to the windowed tasks (OTTR-1255):
 * every card of every project, done and cancelled included, with no Done window.
 * Lookups, links, counts and decisions read it; it never feeds a rendered list. */
export type CardRef = Pick<
	TaskCard,
	| "id"
	| "project"
	| "sessionTitle"
	| "kind"
	| "stage"
	| "state"
	| "cancelledAt"
	| "createdAt"
	| "updatedAt"
	| "doneAt"
	| "followUpOf"
	| "followUpOfProject"
	| "asked"
	| "dependsOn"
	| "commits"
	| "releaseVersion"
	| "queuedAt"
	| "leadAtDone"
> & { prOccurrence?: TaskCard["prOccurrence"]; lead?: TaskCard["lead"] };

/** OTTR-488: harvested at settle — 'yes' when the report carries a `## Recommended steps` heading, 'no' when a harvested report carries none, 'unknown' when no report was harvested (legacy rows). Views resolve 'unknown' against the stored report at read time (app.ts viewSteps, ui/queue.ts researchSteps). */
export type ResearchSteps = "yes" | "no" | "unknown";

/** Done lane page size (OTTR-965): the cards the state's Done window keeps before "Show
 * more" fetches the next page, and the step each click adds. One number for the server's
 * done window (app.ts) and the UI's fetch step (ui/app.tsx). */
export const DONE_PAGE = 20;

/** Done order: latest landing first. doneAt stamps each entry into Done (the done clock);
 * a cancelled card orders by its cancel time. Shared by the server's Done window and the
 * UI's Done lane sort. */
export function newestLanded(
	a: { cancelledAt: number | null; doneAt: number | null; updatedAt: number },
	b: { cancelledAt: number | null; doneAt: number | null; updatedAt: number },
): number {
	return (
		(b.cancelledAt ?? b.doneAt ?? b.updatedAt) -
		(a.cancelledAt ?? a.doneAt ?? a.updatedAt)
	);
}

/** A done card is question-only when the last work turn reported `answered` (a later follow-up replaces it). */
export function answeredCard(
	turns: Array<Pick<Turn, "kind" | "outcome">>,
): boolean {
	for (let i = turns.length - 1; i >= 0; i--) {
		const t = turns[i];
		if (t === undefined) continue;
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
	userLayer: {
		skills: string[];
		plugins: string[];
		rules: string[];
		mcp: string[];
	};
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

/** Hosted mode's credits chip data (docs/specs/hosted-mode.md section 7): present only in hosted mode. */
export interface HostedCreditsView {
	/** Last balance the credit gate saw, in credits; null until a /credit answer carried one. */
	balance: number | null;
	/** Absolute control-plane account page (the chip's link; at zero it is the top-up path). */
	accountUrl: string;
}

export interface StateResponse {
	projects: ProjectView[];
	/** Every project's open cards plus its Done window (OTTR-965): the newest DONE_PAGE
	 * done and cancelled cards and every pinned one, all projects newest first. Older
	 * settled cards leave the frame; GET /api/projects/<p>/done?page=N serves them. */
	tasks: TaskCard[];
	/** OTTR-1255: the compact index of every card of every project — no Done window,
	 * so lookups see settled cards the tasks window left out. Lookups and decisions
	 * read it; the lanes, the Done lane and search keep reading tasks. */
	allCards: CardRef[];
	/** Global cap of concurrently running omp processes; null = no cap. */
	maxTotal: number | null;
	/** The scheduler's own live slot count at frame assembly: the distinct running and
	 *  preparing run keys the claim gate compares against maxTotal (OTTR-1143). The frame's
	 *  card list is not a snapshot across projects, so its own sum can exceed the cap.
	 *  Absent on frames from an older server; the UI then counts the frame's own cards. */
	slotsUsed?: number;
	/** True when a review's findings are checked by a second model before they become cards. */
	reviewCheck: boolean;
	/** True when a finished work card is checked by a second model before it enters the merge queue. */
	workCheck: boolean;
	/** True when the board files a due architecture review card by itself after two hours without input. */
	idleReviews: boolean;
	/** True when the board scans GitHub trending weekly (Monday 06:00 server time) for projects with trendingScout on. */
	trendingScan: boolean;
	/** OTTR-693: the commit identity Settings names; null keeps the built-in Ottr default. */
	commitIdentity: CommitIdentity | null;
	/** Weekly trending scan state for the Settings notice and the "Scan trending now" button. */
	trendingStatus: TrendingStatus;
	/** Version stamp of the running server (image stamp OTTR_VERSION, release tag `vX.Y.Z`, short sha on dev, else boot time); stale tabs reload once when it changes. */
	serverVersion: string;
	/** Provider usage limits from `omp usage --json`; null until the first check. */
	quota: QuotaState | null;
	serviceQuotas?: readonly ServiceQuotaSourceState[];
	/** Hosted mode (docs/specs/hosted-mode.md): the UI hides host-level panels and identity surfaces. Absent or false on every self-hosted board. */
	hosted?: boolean;
	/** Hosted mode's credits chip data: present only in hosted mode. */
	credits?: HostedCreditsView;
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
	/** Cancelled cards still holding a kept worktree: held total, stale past the keptWorktreeDays threshold,
	 *  cards naming each held card so the advisory can link it (absent on frames from an older server). */
	keptWorktrees: {
		held: number;
		stale: number;
		/** The held cards with their projects, so the advisory's click opens the
		 * right twin when ids repeat across projects (OTTR-1255). */
		cards?: Array<{ id: string; project: string }>;
	};
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
	/** Advisory: the hourly board seed of the agent layer failed (the update script's
	 *  record next to the board home); null when no record exists, the seed succeeded,
	 *  or the record fails to sanitize. */
	seedFailed: SeedFailedView | null;
	/** Advisory: the hourly board seed left scan-gate items out of the agent layer
	 *  (docs/specs/board-seed-partial.md, the update script's record next to the board
	 *  home); null when no record exists, the seed succeeded, or the record fails to
	 *  sanitize. */
	seedPartial: SeedPartialView | null;
	/** Advisory: the last failed alate provision attempt (the U9 trigger or the manual
	 *  button); null after a success, or when alate reports no pending import. */
	alateProvisionError: string | null;
	/** Live host schedule and manual-cycle control; absent on older state frames. */
	updateCycle?: UpdateCycleView | null;
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

/** A failed board seed of the agent layer the update script records next to the board
 *  home (/etc/ottr/seed-failed, OTTR-753). */
export interface SeedFailedView {
	/** Epoch ms of the first failure in this episode; the record keeps it across runs. */
	since: number;
	/** The data-repo sha the seed tried; "" when the run could not read one (a
	 *  ls-remote or data-checkout failure seeds before it knows a sha). */
	commit: string;
	/** The redacted tail of the failure text (the script cuts it to about 1000
	 *  characters); "" when nothing readable survived the cut. */
	text: string;
}

/** A partial board seed of the agent layer: the items the scan gate left out, the
 *  update script's record next to the board home (/etc/ottr/seed-partial,
 *  docs/specs/board-seed-partial.md). */
export interface SeedPartialView {
	/** The data-repo sha the partial seed recorded; "" when absent. */
	commit: string;
	/** Epoch ms of the partial seed. */
	since: number;
	/** Left-out item total before the 20-item list cap. */
	count: number;
	/** The capped, sanitized item list. */
	items: { name: string; rule: string }[];
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

/** One provider's banked rate-limit resets as omp reports them (OpenAI Codex, Anthropic). */
export interface QuotaResetCredits {
	provider: string;
	/** Resets the account can redeem now. */
	available: number;
	/** Epoch ms when the soonest available reset expires; null when omp names none. */
	nextExpiry: number | null;
}

export interface QuotaState {
	limits: QuotaLimit[];
	/** Banked resets per provider that reports them; absent from boards that predate them. */
	resetCredits?: QuotaResetCredits[];
	/** Why the last check failed; limits are empty then. */
	error: string | null;
	/** Epoch ms of the last check. */
	at: number;
}

export type ServiceQuotaUnit =
	| { kind: "currency"; code: string }
	| { kind: "count"; name: string };

export type ServiceQuotaMetric = {
	id: string;
	label: string;
	unit: ServiceQuotaUnit;
} & (
	| {
			kind: "window";
			used: number;
			limit: number;
			startsAt: number | null;
			resetsAt: number | null;
	  }
	| {
			kind: "balance";
			remaining: number;
			reportedTotal: number | null;
			resetsAt: number | null;
			providerStatus: string | null;
			plan: string | null;
	  }
);

export interface ServiceQuotaConfigurationError {
	code: "configuration";
}

export interface ServiceQuotaReadError {
	code:
		| "authentication"
		| "rate_limit"
		| "timeout"
		| "network"
		| "http"
		| "invalid_response"
		| "internal";
	httpStatus: number | null;
	retryAfterAt: number | null;
}

export type ServiceQuotaReadResult =
	| { ok: true; metrics: readonly ServiceQuotaMetric[] }
	| { ok: false; error: ServiceQuotaReadError };

export interface ServiceQuotaReader {
	read(context: { signal: AbortSignal }): Promise<ServiceQuotaReadResult>;
}

export interface ServiceQuotaAdapterDefinition {
	readonly id: string;
	createReader(context: { credential: string }): ServiceQuotaReader;
}

export interface ServiceQuotaSourceConfig {
	id: string;
	adapterId: string;
	label: string;
	credentialEnv: string;
}

export interface ServiceQuotaSample {
	observedAt: number;
	metrics: readonly ServiceQuotaMetric[];
}

export interface ServiceQuotaSourceIdentity {
	id: string;
	adapterId: string;
	label: string;
}

export type ServiceQuotaSourceState = ServiceQuotaSourceIdentity &
	(
		| {
				status: "unconfigured";
				lastAttemptAt: null;
				nextAttemptAt: null;
				sample: null;
				error: ServiceQuotaConfigurationError;
		  }
		| {
				status: "pending";
				lastAttemptAt: null;
				nextAttemptAt: number;
				sample: null;
				error: null;
		  }
		| {
				status: "ok";
				lastAttemptAt: number;
				nextAttemptAt: number;
				sample: ServiceQuotaSample;
				error: null;
		  }
		| {
				status: "stale";
				staleReason: "refresh_error";
				lastAttemptAt: number;
				nextAttemptAt: number | null;
				sample: ServiceQuotaSample;
				error: ServiceQuotaReadError;
		  }
		| {
				status: "stale";
				staleReason: "expired";
				lastAttemptAt: number;
				nextAttemptAt: number;
				sample: ServiceQuotaSample;
				error: null;
		  }
		| {
				status: "error";
				lastAttemptAt: number;
				nextAttemptAt: number | null;
				sample: null;
				error: ServiceQuotaReadError;
		  }
	);

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

/** POST /api/projects and POST /api/projects/:project/init: the fresh project view. The
 *  rules interview starts through POST /api/projects/:project/interview after the wizard's
 *  settings steps (docs/specs/add-project-wizard.md). */
export interface AddProjectResponse {
	project: ProjectView;
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

/** One live VM in the vm-runner's GET /stats body (src/vmRunner.ts) and on the System view. */
export interface SystemVm {
	/** The turn's run id (WorkerRequest.id) or the validate job id. */
	id: string;
	project: string;
	/** The card the dispatch named (VmSpec.taskId, the sandbox job's taskId); null when it carried none. */
	cardId: string | null;
	/** "turn" for a card run, "validate" for a sandbox validation job. */
	mode: "turn" | "validate";
	vcpus: number;
	/** Guest memory in MiB. */
	memMiB: number;
	/** Epoch ms the runner accepted the run. */
	startedAt: number;
	/** Allocated bytes of the run's scratch disk (st_blocks × 512, du semantics — never the
	 *  sparse file's apparent size); null while the runner has not created the disk. */
	scratchBytes: number | null;
}

/** Allocated bytes (st_blocks × 512, du semantics) of the vm-state volume's parts. */
export interface VmStateDisk {
	base: number;
	layers: number;
	runs: number;
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
	/** Set only on the vm-runner row (OTTR_VM_RUNNER_URL set): what the container's
	 *  cgroup numbers cannot say — health, the VM fleet, the vm-state volume's real use. */
	vm?: {
		/** The board's last /healthz probe (src/vmState.ts); ok false carries the reason. */
		health: { ok: boolean; reason: string | null };
		/** OTTR_VM_MAX, as the runner's /stats reported it; null without a reachable reading. */
		max: number | null;
		/** One entry per live VM, the runner's /stats vms list. */
		vms: SystemVm[];
		/** The vm-state volume's allocated bytes per part; null without a reachable reading. */
		disk: VmStateDisk | null;
		/** Cards whose last dispatch vm-runner refused as busy (src/vmState.ts). */
		busy: SystemCard[];
	};
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
/** The card's needsReason while the posted review waits for the PR author or the merge. */
export const PR_REVIEW_POSTED =
	"Review posted; waits for the author or the merge.";

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

export type JiraType = "cloud" | "datacenter";

/** What the API returns for a Jira connection: never the token. */
export interface JiraConnectionView {
	name: string;
	/** Normalized site URL, e.g. "https://acme.atlassian.net" or "https://jira.corp/jira". */
	site: string;
	type: JiraType;
	/** Cloud only. */
	email: string | null;
	/** Custom field ids, e.g. ["customfield_10042"]. */
	customFields: string[];
	tokenSet: boolean;
	/** false => the stored token cannot be decrypted; the user must enter it again. */
	tokenReadable: boolean;
	/** Project names whose settings.jiraConnection names this connection. */
	usedBy: string[];
}

export interface JiraRow {
	key: string;
	/** `${site}/browse/${key}` */
	url: string;
	summary: string;
	issueType: string;
	status: string;
	/** "" when none. */
	priority: string;
	/** Task id of the existing card, or null. */
	importedCard: string | null;
}

export interface JiraSearchResult {
	rows: JiraRow[];
	next: string | null;
	total: number | null;
}

/** filed = task ids filed; skipped = keys already imported; unavailable = keys Jira did not return (gone or no access). */
export interface JiraImportResult {
	filed: string[];
	skipped: string[];
	unavailable: string[];
}

/** One project that holds a card for a key (board-wide search, spec section 6). */
export interface JiraBoardImported {
	/** Project name. */
	project: string;
	/** Task id of the card in that project. */
	task: string;
}

/** One row of the board-wide search: the facts of JiraRow, plus every project holding a card. */
export interface JiraBoardRow {
	key: string;
	/** `${site}/browse/${key}` */
	url: string;
	summary: string;
	issueType: string;
	status: string;
	/** "" when none. */
	priority: string;
	/** Sorted by project name; empty when no project holds a card. */
	importedIn: JiraBoardImported[];
}

export interface JiraBoardSearchResult {
	rows: JiraBoardRow[];
	next: string | null;
	total: number | null;
}

/** One row's deliberate choice (spec section 6): this key files into this project. */
export interface JiraBoardAssignment {
	key: string;
	project: string;
}

/** filed names the project and the new task; skipped = already imported in that project; unavailable = keys Jira did not return (gone or no access). */
export interface JiraBoardImportResult {
	filed: { project: string; key: string; task: string }[];
	skipped: { project: string; key: string }[];
	unavailable: string[];
}
