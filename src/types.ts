// Shared contract for omp-task-tracker. Every module imports its types from here.

import type { DeadSignIn } from "./login.ts";

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
	/** Supervisor files a retro card for each task done at or after this timestamp; null disables retros. */
	retroSince: number | null;
	/** Skip the retro of a smooth, cheap task (the friction filter); false gives every task a retro. */
	retroFilter: boolean;
	/** Hourly fork watch: analyze new fork-only commits with a tool-free model call and file held proposals (off by default). */
	forkResearch: boolean;
	/** Board shows the "Finish setting up" checklist while true; set on add, cleared by dismiss/wizard-done. */
	setupChecklist: boolean;
}

/** One task's touched file with its +/- line counts; null counts mark a binary file. */
export interface DiffFileStat {
	file: string;
	plus: number | null;
	minus: number | null;
}

export type TaskKind = "work" | "retro" | "review" | "interview";

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
	/** Reply text waiting to be sent with the next turn. */
	pendingPrompt: string | null;
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
	/** CI watch: sha of the merge push whose GitHub Actions verdict the supervisor awaits; null once checked, skipped, or given up on. */
	pushSha: string | null;
	/** Coarse board topic: the last turn report's `topic:` line (max 40 chars), else a keyword label backfilled for done cards; null = unclassified. */
	topic: string | null;
	/** Task ids this card waits for: the scheduler starts it only when each is stage done (cancelled counts as satisfied). */
	dependsOn: string[];
	/** Update-card only: record ids (`<name>@<target>`) this card updates; [] for every other task. */
	updateIds: string[];
	/** Update card on a hold-update-merges project: a reply to the hold reason approved the merge; the next ready work turn integrates. */
	updateMergeApproved: boolean;
	/** Task born from fork research (a proposal or a follow-up of a fork research card): a reply to the hold reason approved the merge. */
	forkMergeApproved: boolean;
	/** Per-file +/- counts of the branch's diff, captured at merge-turn start (after the ff-merge lands, the branch is indistinguishable from the target); null when never captured. */
	diffFiles: DiffFileStat[] | null;
	/** The unified diff captured with diffFiles, capped; null when never captured. */
	diffText: string | null;
	/** Second-model checks of this work card, oldest first, capped at the newest 20 runs. */
	workCheckLog: WorkCheckRun[];
	/** Work-check send-backs to the work agent so far; the third failing check parks the card on needs_you. */
	workCheckSendbacks: number;
	/** Branch head the last completed check saw; a ready report at the same head does not re-check. */
	workCheckHead: string | null;
	/** Manual triage rank; null = unrated. Overview triage sorts P0 first, unrated last. */
	priority: Priority | null;
	/** Close-candidate nomination: the reason this card is a duplicate, superseded, or drifted; null = not nominated. */
	closeCandidate: string | null;
}

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** One review learning: a standing convention injected into every review prompt. */
export interface Learning {
	id: number;
	/** The convention, one rule per row, phrased as a review instruction. */
	text: string;
	/** Advisory path glob; null = the whole repo. The reviewer, not the store, matches it. */
	glob: string | null;
	usageCount: number;
	lastUsedAt: number | null;
	/** Card that produced the learning (a finding card the user declined), or null when typed by hand. */
	fromTaskId: string | null;
	createdAt: number;
}

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
	/** Model selector the check ran with (the adversary or critic role's model); null = omp default. */
	model: string | null;
	/** pass = nothing blocks, blockers = real problems found, error = the run itself failed after a retry. */
	outcome: "pass" | "blockers" | "error";
	blockers: WorkCheckBlocker[];
	/** Non-blocking findings: no quote, or the quote matched nothing in the diff or transcript. */
	notes: string[];
	durationMs: number;
	/** The failed-run reason when outcome is "error". */
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
	/** A retro run's first valid `propose_task` call (proposal held for approval), or null. */
	proposed: { prompt: string; model: string | null } | null;
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
	/** Last assistant provider error; a later successful message clears it. */
	providerError?: string | null;
	/** How the run was dispatched: mode (local / worker URL / local fallback + worker error), argv
	 * length, cwd basename, pid when one existed, wall duration. classify shows it when a death
	 * has no stderr, so the board answers "why did my turn die" in one glance. */
	dispatch?: string;
	/** Set by the worker client when the worker stream ended without a result and the run was not client-killed; classify turns it into an automatic resume. */
	workerLost?: boolean;
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
	/** HTTPS URL of the project's GitHub remote (origin preferred); null when it has none. */
	github: string | null;
	/** Highest vX.Y.Z tag merged into the target; null until the first scan or with no tags. */
	latestRelease: string | null;
	/** Public ghcr.io image of the repo; probed on a TTL by the scheduler, null without a public image. */
	latestImage: LatestImage | null;
	/** Since the last arch review on the target; null with no target, before the first scan, or when git fails. */
	archReview: ArchReview | null;
	settings: ProjectSettings;
}

export interface TaskView extends Omit<Task, "diffText"> {
	/** Turns without the prompt text (the log and the follow-up handoff read it from the DB). */
	turns: TurnView[];
	/** Card title: the first session title, else the short prompt line — frozenTitle never returns null. */
	sessionTitle: string;
	/** Repo-relative uncommitted worktree files; present on the drawer detail view only. */
	worktreeFiles?: string[];
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
	/** Epoch ms of the last log write, present only while a preparing or running card's log has been
	 * silent past the board's limit (SILENT_LOG_MS): the agent may wait on a hung command. */
	silentSince?: number;
};

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
	/** Version stamp of the running server (HEAD sha, else boot time); stale tabs reload once when it changes. */
	serverVersion: string;
	/** Provider usage limits from `omp usage --json`; null until the first check. */
	quota: QuotaState | null;
	/** True until the single admin exists (/api/setup); the UI shows the setup dialog then. */
	onboarding: boolean;
	/** Admin name for the top-bar user chip; null until /api/setup. */
	user: string | null;
	/** Task ids the user has read; global, server-persisted. */
	seenAnswers: string[];
	/** Advisory: agent-launcher processes no running turn claims (machine-global); the tracker never kills them. */
	orphans: { pid: number; started: number }[];
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
}

/** One provider usage window, e.g. Anthropic's 5-hour or 7-day limit. */
export interface QuotaLimit {
	/** omp provider id, e.g. "anthropic". */
	provider: string;
	/** omp's window label, e.g. "Claude 5 Hour". */
	label: string;
	/** omp's short window id, e.g. "5h" or "7d"; null when omp names no window. */
	window: string | null;
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
	/** "queued" | "not-needed" */
	interview: string;
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
}

/** `vX.Y.Z`: the release tag format, shared by the server (validation) and the dialog (input check). */
export const VERSION_RE = /^v\d+\.\d+\.\d+$/;

/** What "Create release" would release right now (GET /api/projects/:project/release). */
export interface ReleasePlan {
	/** The commit the release tags, frozen when the plan is made. */
	sha: string;
	/** Latest release tag contained in `sha` (highest vX.Y.Z); null before the first release. */
	from: string | null;
	/** Next version per semver from the conventional commits since `from`; "v0.1.0" for the first release. */
	version: string;
	/** GitHub release notes (markdown): one bullet per feature, fix or change. */
	notes: string;
	/** Commits (without merges) in from..sha. */
	commits: number;
	/** Done tasks whose work is in from..sha, oldest first; question-only and no-op cards are dropped. */
	tasks: { id: string; title: string }[];
	/** Why the release can't start now; null when it can. */
	blocked: string | null;
}

export interface MachineStats {
	/** CPU usage in percent, averaged over the last 15 minutes of samples. */
	cpu: number;
	/** RAM usage; usedGiB and pct are 15-minute averages, totalGiB reads live. */
	ram: { usedGiB: number; totalGiB: number; pct: number };
}

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
	/** Counts of the current window. */
	done: number;
	firstPassDone: number;
	turns: number;
	failedTurns: number;
	/** Finished turns in the window without captured cost. */
	costMissing: number;
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
 * `state`, `update` and the latest `stats`; afterwards:
 * - `state`: whenever the serialized StateResponse changes (checked after every mutating request,
 *   every scheduler run, and every 1 s while a tab is connected);
 * - `stats`: every 30 s, one sampler for all tabs; values are 15-minute averages;
 * - `update`: when the behind-count changes (refreshed every 5 min while a tab is connected);
 * - `log`: the task's log file grew; at most one per 250 ms per task. Fetch the bytes with
 *   `GET /api/projects/:project/tasks/:id/log?from=N`;
 * - `ping`: every 5 s, liveness only.
 */
export type ServerMessage =
	| { type: "state"; state: StateResponse }
	| { type: "stats"; stats: MachineStats }
	| { type: "update"; behind: number; commits: string[] }
	| { type: "log"; project: string; id: string }
	| { type: "ping" };
