import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdirBelow, writeBelow } from "./confine.ts";
import { platform } from "./platform/index.ts";
import { LOST_SESSION } from "./prompts.ts";
import { PROGRESS_EVENT, watchProgress } from "./stryker.ts";
import type {
	AskQuestion,
	GitFacts,
	Next,
	Outcome,
	RecordedFinding,
	RunResult,
	Turn,
	TurnKind,
} from "./types.ts";
import { askQuestions, OUTCOME_STATUSES } from "./types.ts";
import type { WorkerTarget } from "./workers.ts";
import { runWorker, WorkerConnectError } from "./workers.ts";
import {
	GIT_AUTH_ENV_NAME,
	gitSecrets,
	redact,
	redactingWriter,
} from "./worktree.ts";

export type { WorkerTarget };

const LOG_CAP_BYTES = 2 * 1024 * 1024;
export const APPROVAL_REFUSAL =
	"requires approval but no interactive UI available";

/** Board coordinates a task session's create_task tool reads from its env. */
interface BoardEnv {
	url: string;
	/** The board's boot token; it files cards where the board is not on loopback (compose). */
	token: string;
	project: string;
	taskId: string;
}

/**
 * Child env for a spawned omp: inherited base plus the pinned session name and the board
 * coordinates and token the create_task extension tool reads. An operator-provided
 * OTTR_BOARD_URL (compose worker -> server address) wins over the tracker's own loopback URL;
 * an inherited token never does, since only this board's token opens it. Undefined
 * values are dropped so spawn never sees them. OTTR_DATA_DIR and OTTR_SERVER_DATA_DIR stay behind:
 * a turn that runs ottr's own test suite must not open the live board's task stores, and a turn
 * must not learn the server-only state path. The worker dispatch
 * credentials (OTTR_WORKER_URLS, OTTR_WORKER_TOKEN) are stripped too: a turn that held them
 * could drive any worker (WORKERS.md), so no local child ever inherits them.
 */
export function childEnv(o: {
	sessionName?: string | null;
	board?: BoardEnv | null;
	base?: Record<string, string | undefined>;
	/** Set: a retro run must not inherit the board's coordinates (its proposals file through the tracker, not create_task). */
	stripBoard?: boolean;
}): Record<string, string> {
	const env = { ...(o.base ?? process.env) } as Record<string, string>;
	delete env.OTTR_DATA_DIR;
	delete env.OTTR_SERVER_DATA_DIR;
	delete env.OTTR_WORKER_URLS;
	delete env.OTTR_WORKER_TOKEN;
	if (o.sessionName) env.OTTR_SESSION_NAME = o.sessionName;
	if (o.board) {
		if (!env.OTTR_BOARD_URL) env.OTTR_BOARD_URL = o.board.url;
		env.OTTR_BOARD_TOKEN = o.board.token;
		env.OTTR_PROJECT = o.board.project;
		env.OTTR_TASK_ID = o.board.taskId;
	}
	// After the board block: stripBoard must win even when a board object is passed.
	if (o.stripBoard) {
		delete env.OTTR_BOARD_URL;
		delete env.OTTR_BOARD_TOKEN;
		delete env.OTTR_PROJECT;
		delete env.OTTR_TASK_ID;
	}
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	return env;
}

/** `images` are absolute paths; omp attaches each `@<path>` to the user message of the stdin prompt. */
export function buildOmpArgs(o: {
	sessionDir: string;
	/** The tracker extension; null omits `--extension` (and the `run.yml` overlay next to it): a review check run carries no tools of ours. */
	extensionPath?: string | null;
	resumeId: string | null;
	images?: string[];
	model?: string | null;
	/** Non-empty: pinned tool list (`--tools`), extension config (`--config`) or skill (`--skills`). */
	tools?: string | null;
	config?: string | null;
	skills?: string | null;
	/** Non-empty caps the run's duration (`--max-time`); a hung check run must not hold a board slot forever. */
	maxTime?: string | null;
}): string[] {
	return [
		"-p",
		"--mode",
		"json",
		"--session-dir",
		o.sessionDir,
		// run.yml sits next to the extension: a one-shot run ends with the reply, so a bash
		// command omp auto-backgrounds would die before its result arrives. A retro run
		// passes retro.yml after it (a later --config overlay wins per key).
		...(o.extensionPath
			? [
					"--extension",
					o.extensionPath,
					"--config",
					join(dirname(o.extensionPath), "run.yml"),
				]
			: []),
		...(o.resumeId ? ["--resume", o.resumeId] : []),
		...(o.model ? ["--model", o.model] : []),
		...(o.tools ? ["--tools", o.tools] : []),
		...(o.config ? ["--config", o.config] : []),
		...(o.skills ? ["--skills", o.skills] : []),
		...(o.maxTime ? ["--max-time", o.maxTime] : []),
		...(o.images ?? []).map((p) => `@${p}`),
	];
}

/**
 * What a turn resumes. omp announces a session id when it starts but writes the session file later, so a
 * run killed before that (a tracker restart seconds in) leaves an id that `--resume` always rejects with
 * "Session not found". Such a turn starts a fresh session instead: the lost-session note, then any reply.
 * "." is only the continue marker, so it is dropped.
 */
export function resumePlan(
	sessionId: string | null,
	saved: boolean,
	pending: string | null,
): { resumeId: string | null; note: string | null } {
	if (sessionId === null || saved)
		return {
			resumeId: sessionId,
			// "." is only the continue marker: a card that never ran must not carry
			// "Note from the user: ." into its first prompt.
			note: pending === "." && sessionId === null ? null : pending,
		};
	return {
		resumeId: null,
		note: [LOST_SESSION, pending].filter((p) => p && p !== ".").join("\n\n"),
	};
}

/**
 * Why the tracker did not accept the agent's last report_outcome, or null. The agent never sees classify's
 * verdict, so a reply without it ("just finish it") tends to get the same rejected report again. An agent's
 * own needs_you also leaves its question as the turn error; that is no rejection.
 */
export function rejectedReport(
	turn: Pick<Turn, "outcome" | "error"> | undefined,
): string | null {
	return turn?.error && turn.outcome !== null && turn.outcome !== "needs_you"
		? turn.error
		: null;
}

type AnyRec = Record<string, unknown>;

/** Joined text of all {type:"text"} parts of an omp content array. */
function textParts(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => {
			const part = p as AnyRec;
			return (
				typeof part === "object" &&
				part !== null &&
				part.type === "text" &&
				typeof part.text === "string"
			);
		})
		.map((p) => (p as AnyRec).text as string)
		.join("");
}

/** Only the provider's diagnostic field reaches the card, never the request or message body. */
function providerError(message: AnyRec): string | null {
	if (
		message.stopReason !== "error" ||
		typeof message.errorMessage !== "string"
	)
		return null;
	// ponytail: cap diagnostics at 4,000 chars; raise the cap only if it hides the cause.
	return (
		message.errorMessage
			.slice(0, 4000)
			.replace(/\s+/g, " ")
			.replace(/[\p{Cc}\p{Cf}]/gu, "")
			.replace(
				/\b(authorization|api[-_ ]?key|(?:access[-_ ]?|refresh[-_ ]?)?token|password|secret)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|(?:bearer\s+)?[^\s"',;]+)/gi,
				"$1=[REDACTED]",
			)
			.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
			.replace(/\bbearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
			.replace(
				/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
				"[REDACTED]",
			)
			.trim() || null
	);
}

/** The ask tool by itself or with a mount prefix; `task` and other names merely ending in "ask" do not match. */
const ASK_TOOL = /(?:^|[./:_-])ask$/;

/** Pure: one omp JSON event -> text appended to the task log. Malformed/unknown -> "". */
export function renderEvent(ev: unknown): string {
	if (typeof ev !== "object" || ev === null) return "";
	const e = ev as AnyRec;
	switch (e.type) {
		case "session":
			return typeof e.id === "string" ? `[omp session ${e.id}]\n` : "";
		case "message_update": {
			const a = e.assistantMessageEvent;
			if (typeof a !== "object" || a === null) return "";
			const ame = a as AnyRec;
			// Thinking arrives as thinking_start -> thinking_delta* -> thinking_end, right before text_start.
			if (ame.type === "thinking_start") return "\n⟦thinking⟧ ";
			if (ame.type === "thinking_end") return "\n";
			if (ame.type === "thinking_delta")
				return typeof ame.delta === "string" ? ame.delta : "";
			return ame.type === "text_delta" && typeof ame.delta === "string"
				? ame.delta
				: "";
		}
		case "message_end": {
			const m = e.message;
			if (
				typeof m !== "object" ||
				m === null ||
				(m as AnyRec).role !== "assistant"
			)
				return "";
			const error = providerError(m as AnyRec);
			return error ? `\n! provider: ${error}\n` : "\n";
		}
		case "tool_execution_start": {
			const name = e.toolName;
			if (typeof name !== "string") return "";
			const args =
				typeof e.args === "object" && e.args !== null ? (e.args as AnyRec) : {};
			if (name.endsWith("report_outcome"))
				return `\n▸ report_outcome: ${String(args.status ?? "?")} — ${String(args.summary ?? "")}\n`;
			if (ASK_TOOL.test(name)) {
				const qs = askQuestions(e.args);
				if (qs !== null)
					return `\n▸ ask\n${qs
						.map(
							(q) =>
								`  ? ${q.question}\n${q.options.map((o) => `    • ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`,
						)
						.join("\n")}\n`;
			}
			const s =
				typeof args.command === "string"
					? args.command
					: typeof e.intent === "string" && e.intent !== ""
						? e.intent
						: JSON.stringify(args);
			const flat = s.replace(/\r?\n/g, " ⏎ ");
			return `\n▸ ${name}: ${flat.length > 300 ? `${flat.slice(0, 300)}…` : flat}\n`;
		}
		case "tool_execution_end": {
			if (e.isError !== true) return "";
			const result =
				typeof e.result === "object" && e.result !== null
					? (e.result as AnyRec)
					: {};
			const flat = textParts(result.content).replace(/\r?\n/g, " ⏎ ");
			return `  ✗ ${flat.length > 500 ? `${flat.slice(0, 500)}…` : flat}\n`;
		}
		case "agent_end":
			return "\n";
		default:
			return "";
	}
}

/** Opens every background-wait reason; classify matches it in the previous turn's error. */
const BACKGROUND_WAIT =
	"The agent ended its turn while waiting on a background job";

/** Opens the worker-lost reason; classify matches it in the previous turn's error. */
export const WORKER_LOST = "the worker running this turn died";

/**
 * omp writes one JSON file per rejected HTTP 400 request here: <millis>-<id>.json.
 * R5-1: this path is omp's state root and stays under $HOME/.omp even when
 * PI_CODING_AGENT_DIR pins the agent dir — omp skips the XDG state-root probe under the
 * override — so the reader must follow the writer. Worker-writable, but only the file
 * name (never the body) is read; a plant can forge a file name at worst.
 */
const HTTP400_DIR = join(homedir(), ".omp", "logs", "http-400-requests");

/** Newest omp HTTP-400 log entry whose timestamp falls inside [from, to], as the file name,
 * or null. Best-effort: a missing or unreadable log is no evidence, the caller falls back to
 * the generic failure message. Only the file name carries the timestamp, so the (large)
 * request bodies are never read. */
export function findHttp400Rejection(o: {
	from: number;
	to: number;
	/** Override for tests; defaults to ~/.omp/logs/http-400-requests. */
	dir?: string;
}): string | null {
	try {
		let best: { ts: number; file: string } | null = null;
		for (const name of readdirSync(o.dir ?? HTTP400_DIR)) {
			const ts = Number(/^(\d+)-[A-Za-z0-9_-]+\.json$/.exec(name)?.[1]);
			if (
				Number.isFinite(ts) &&
				ts >= o.from &&
				ts <= o.to &&
				(best === null || ts > best.ts)
			)
				best = { ts, file: name };
		}
		return best?.file ?? null;
	} catch {
		return null;
	}
}

/**
 * The stderr line that says why omp died. Bun prints a crash as source lines, `error: <message>`
 * (or `TypeError: …`) and stack frames, then omp appends its `[Recovery]` resume hints. The last
 * error line wins, else the last line before the hints, else the last line. Shared with
 * check-failure reasons so omp's recovery hints never win.
 */
export function deathLine(stderr: string): string | undefined {
	const all = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const cut = all.lastIndexOf("[Recovery]");
	const lines = cut === -1 ? all : all.slice(0, cut);
	const line =
		lines.findLast((l) => /^(?:error|\w*Error): /.test(l)) ??
		lines.at(-1) ??
		all.at(-1);
	return line?.replace(/^error: /, "").replace(/\.$/, "");
}

/** Pure: decide where a task goes after a turn. First matching rule wins.
 * `research` marks a research card: research must not merge, so only the answered-with-commits
 * mapping checks it. */
export function classify(o: {
	kind: TurnKind;
	result: RunResult;
	git: GitFacts;
	target: string | null;
	/** Error of the task's previous turn, null for none. */
	previousError: string | null;
	/** True for research cards; they never take the answered-with-commits merge path. */
	research?: boolean;
	/** True when the research report file exists in the worktree; only research cards read it. */
	hasReport?: boolean;
	/** True for grill turns on backlog cards; they run worktree-less in the main checkout and
	 * never leave the backlog column. */
	grill?: boolean;
	/** Images attached to this turn's run; only the provider-rejection check reads it. */
	images?: number;
	/** Reads omp's HTTP-400 request log for this turn's window; only called when the turn
	 * died before any output. Null/undefined when there is no entry. */
	http400?: () => string | null;
}): Next {
	const { kind, result, git, target } = o;
	const stage: Next["stage"] =
		o.grill === true ? "backlog" : kind === "work" ? "in_progress" : "merging";
	const needs = (reason: string): Next => ({
		stage,
		state: "needs_you",
		needsReason: reason,
	});

	if (result.killed) return needs("Stopped by the tracker.");

	// One-shot omp runs exit 0 when the agent ends its reply on a pending wait/background call
	// (nothing is alive to deliver the result and wake it). The session survives, so a "." continue
	// re-checks. ponytail: one automatic continue per streak; if the previous turn already ended this
	// way, a human decides. Count streaks if agents often need a second one.
	if (result.exitCode === 0 && !result.sawTerminalEnd)
		return o.previousError?.startsWith(BACKGROUND_WAIT)
			? needs(
					`${BACKGROUND_WAIT} again; a one-shot omp run exits instead of being woken. Reply "." to let it re-check, or use New session.`,
				)
			: {
					stage,
					state: "queued",
					needsReason: `${BACKGROUND_WAIT} - resuming automatically. Cancel to stop it instead.`,
					pendingPrompt: ".",
				};

	// A lost worker is not the turn's fault: a fresh worker runs the same reply. Same
	// one-auto-resume-per-streak pattern as the background-wait rule above.
	if (result.workerLost === true)
		return o.previousError?.startsWith(WORKER_LOST)
			? needs(
					`${WORKER_LOST} again; a fresh worker runs the reply. Cancel to stop it instead.`,
				)
			: {
					stage,
					state: "queued",
					needsReason: `${WORKER_LOST} - resuming automatically. Cancel to stop it instead.`,
					pendingPrompt: ".",
				};

	// omp can crash after report_outcome (e.g. session persistence failing at shutdown):
	// a received ready/answered/integrated is terminal and decides below; the exit code
	// must not override finished work. No report, or an ask, and a bad exit stays a failure.
	if (
		(result.exitCode !== 0 || !result.sawTerminalEnd) &&
		!(result.outcome !== null && result.outcome.status !== "needs_you")
	) {
		// A turn that died before its first event with empty stderr is the provider answering
		// with an HTTP 400 (e.g. a content filter). With attached images it rejected the
		// image input: re-attaching the same images would loop forever, so the caller
		// quarantines the files and this requeues text-only. The text-only retry carries
		// images 0, so a second failure takes one of the rules below.
		if (
			result.sessionId === null &&
			result.outcome === null &&
			result.stderrTail.trim() === "" &&
			!result.providerError
		) {
			if ((o.images ?? 0) > 0)
				return {
					stage,
					state: "queued",
					needsReason:
						"The provider rejected the attached images (the run died before any output). Quarantining them and retrying text-only.",
					quarantineImages: true,
				};
			// Plain text: an HTTP-400 log entry inside this turn's window is the provider
			// rejecting the prompt's content. No retry can fix the wording; a human rewords.
			const evidence = o.http400?.();
			if (evidence)
				return needs(
					`The provider rejects this prompt's content - reword the task (evidence: ~/.omp/logs/http-400-requests/${evidence}).`,
				);
		}
		// Prefer stderr, then the provider's structured error, then dispatch context.
		const last = deathLine(result.stderrTail) ?? result.providerError;
		const ctx = last
			? `: ${last}`
			: result.dispatch
				? ` (dispatch ${result.dispatch}, no stderr)`
				: "";
		return needs(
			`omp exited with code ${result.exitCode ?? "unknown"} before finishing${ctx}.`,
		);
	}

	if (result.approvalRefused)
		return needs(
			"A tool call needed approval, which tracker runs can't answer. Allow the tool in omp's config or continue in a terminal (see the card).",
		);

	// The agent asked the user a question via the ask tool and paused: surface it as the "?" state.
	// If it went on to finish the turn on its own (ready/answered/integrated), the ask is moot.
	if (
		result.asked !== null &&
		(result.outcome === null || result.outcome.status === "needs_you")
	) {
		const q = result.asked[0]!.question;
		return {
			stage,
			state: "needs_you",
			needsReason: `Wants your answer: ${q.length > 160 ? `${q.slice(0, 160)}…` : q}${result.asked.length > 1 ? ` (+${result.asked.length - 1} more)` : ""}`,
			asked: result.asked,
		};
	}

	const oc = result.outcome;
	// A grill turn never leaves the backlog column: a received ready or answered report marks
	// the item grilled — parked at idle until the user promotes it. Everything upstream (deaths,
	// background waits, open asks) keeps the generic flows, now with stage=backlog.
	if (
		o.grill === true &&
		oc !== null &&
		oc.status !== "needs_you" &&
		oc.status !== "integrated"
	)
		return { stage, state: "idle", needsReason: null };
	if (oc === null) {
		// The receipt path can be down (e.g. the tracker extension failed to load) while the turn
		// itself finished fine. Prove what it completed from git, by the same predicates a receipt
		// is validated against below; anything unprovable still asks for a human. Turns that
		// aborted (crash, refusal, pending background job) never reach this branch.
		// A research card's deliverable is the report file, not a receipt: exit 0 with the report
		// present settles done. Before the commits rule: research never merges.
		if (kind === "work" && o.research === true && o.hasReport === true)
			return { stage: "done", state: "idle", needsReason: null };
		if (
			kind === "work" &&
			o.grill !== true &&
			git.commitsAhead > 0 &&
			git.clean
		)
			return { stage: "merging", state: "queued", needsReason: null };
		if (kind === "merge" && git.integrated)
			return { stage: "done", state: "idle", needsReason: null };
		return needs("The agent finished without calling report_outcome.");
	}

	// Any turn can report integrated: an agent may integrate in a work turn anyway (e.g. after a
	// "continue to merging" reply). It can't undo that, so a bounce would trap the card; git decides.
	if (oc.status === "integrated") {
		if (git.integrated)
			return { stage: "done", state: "idle", needsReason: null };
		return needs(
			`Reported integrated, but HEAD is not on ${target ?? "the integration target"}.`,
		);
	}

	if (kind === "work") {
		if (oc.status === "ready") {
			if (o.grill !== true && git.commitsAhead > 0 && git.clean)
				return { stage: "merging", state: "queued", needsReason: null };
			// A sibling card already merged the same fix: nothing left to merge, the ready report is complete.
			if (git.commitsAhead === 0 && git.integrated)
				return { stage: "done", state: "idle", needsReason: null };
			return needs(
				`Reported ready, but git shows ${git.commitsAhead} commit(s) ahead of the base${git.clean ? "" : " and uncommitted changes"}.`,
			);
		}
		if (oc.status === "answered") {
			if (git.commitsAhead === 0)
				return { stage: "done", state: "idle", needsReason: null };
			// The agent misfiled answered while landable commits sit on the branch; git proves work to
			// integrate. Research cards must not merge, so only non-research turns take this path.
			if (git.clean && o.research !== true)
				return { stage: "merging", state: "queued", needsReason: null };
			return needs(
				`Reported answered, but the branch has ${git.commitsAhead} commit(s) that were never integrated.`,
			);
		}
	} else if (oc.status === "ready" || oc.status === "answered")
		return needs(`Unexpected outcome "${oc.status}" in a merge turn.`);

	return needs(oc.question?.trim() ? oc.question.trim() : oc.summary);
}

function isOutcome(v: unknown): v is Outcome {
	if (typeof v !== "object" || v === null) return false;
	const o = v as AnyRec;
	return (
		typeof o.status === "string" &&
		(OUTCOME_STATUSES as readonly string[]).includes(o.status) &&
		typeof o.summary === "string" &&
		(o.details === undefined || typeof o.details === "string") &&
		(o.question === undefined || typeof o.question === "string") &&
		(o.shots === undefined ||
			(Array.isArray(o.shots) &&
				o.shots.every((s: unknown) => typeof s === "string"))) &&
		(o.dependsOn === undefined ||
			(Array.isArray(o.dependsOn) &&
				o.dependsOn.every((d: unknown) => typeof d === "string")))
	);
}

/** Event-driven subset of RunResult, advanced purely by applyEvent. */
export interface EventState {
	sessionId: string | null;
	outcome: Outcome | null;
	/** provider/model of the last assistant message_start, e.g. "zai/glm-5.3-flash". */
	model: string | null;
	approvalRefused: boolean;
	sawTerminalEnd: boolean;
	finalText: string;
	providerError: string | null;
	/** toolCallId -> args of report_outcome calls awaiting their tool_execution_end. */
	remembered: Map<string, unknown>;
	/** The agent's last ask call, normalized; null while none. */
	asked: AskQuestion[] | null;
	/** First valid `propose_task` call of a retro run; null while none (the extension refuses a second). */
	proposed: { prompt: string; model: string | null } | null;
	/** Every valid `propose_task` call, in order: a retro records at most one, a review one per finding. */
	recorded: RecordedFinding[];
}

export function newEventState(): EventState {
	return {
		sessionId: null,
		outcome: null,
		model: null,
		approvalRefused: false,
		sawTerminalEnd: false,
		finalText: "",
		providerError: null,
		remembered: new Map(),
		asked: null,
		proposed: null,
		recorded: [],
	};
}

/** Pure: apply one omp JSON event to state. Returns the session id when it is first seen. */
export function applyEvent(
	state: EventState,
	ev: unknown,
): { sessionStarted?: string } {
	if (typeof ev !== "object" || ev === null) return {};
	const e = ev as AnyRec;
	if (
		e.type === "session" &&
		typeof e.id === "string" &&
		state.sessionId === null
	) {
		state.sessionId = e.id;
		return { sessionStarted: e.id };
	}
	if (e.type === "message_start") {
		const m = e.message;
		if (
			typeof m === "object" &&
			m !== null &&
			(m as AnyRec).role === "assistant"
		) {
			const rec = m as AnyRec;
			if (typeof rec.model === "string" && rec.model !== "") {
				state.model =
					typeof rec.provider === "string" && rec.provider !== ""
						? `${rec.provider}/${rec.model}`
						: rec.model;
			}
		}
		return {};
	}
	if (e.type === "message_end") {
		const m = e.message;
		if (
			typeof m === "object" &&
			m !== null &&
			(m as AnyRec).role === "assistant"
		)
			state.providerError = providerError(m as AnyRec);
		return {};
	}
	if (
		e.type === "tool_execution_start" &&
		typeof e.toolName === "string" &&
		ASK_TOOL.test(e.toolName)
	) {
		const qs = askQuestions(e.args);
		// The extension allows one ask per turn and refuses later ones: the first usable ask
		// is the durable state, a refused second ask must not replace it on the card.
		if (qs !== null && state.asked === null) state.asked = qs;
		return {};
	}
	if (
		e.type === "tool_execution_start" &&
		typeof e.toolName === "string" &&
		e.toolName === "propose_task"
	) {
		const args =
			typeof e.args === "object" && e.args !== null ? (e.args as AnyRec) : {};
		if (typeof args.prompt === "string" && args.prompt !== "") {
			const call: RecordedFinding = {
				prompt: args.prompt,
				model: typeof args.model === "string" && args.model ? args.model : null,
				rank:
					typeof args.rank === "number" &&
					Number.isInteger(args.rank) &&
					args.rank >= 1
						? args.rank
						: null,
				security:
					args.security === "critical" || args.security === "high"
						? args.security
						: null,
			};
			state.recorded.push(call);
			// Retro semantics: the first valid call is the proposal (the extension refuses a second).
			if (state.proposed === null)
				state.proposed = { prompt: call.prompt, model: call.model };
		}
		return {};
	}
	if (
		e.type === "tool_execution_start" &&
		typeof e.toolName === "string" &&
		e.toolName.endsWith("report_outcome")
	) {
		const id = typeof e.toolCallId === "string" ? e.toolCallId : null;
		if (id !== null)
			state.remembered.set(
				id,
				typeof e.args === "object" && e.args !== null ? e.args : {},
			);
		return {};
	}
	if (e.type === "tool_execution_end") {
		const result =
			typeof e.result === "object" && e.result !== null
				? (e.result as AnyRec)
				: {};
		// Refusal can hit any tool, not just report_outcome: flag whenever an errored
		// end carries the approval text.
		if (
			e.isError === true &&
			textParts(result.content).includes(APPROVAL_REFUSAL)
		)
			state.approvalRefused = true;
		const id = typeof e.toolCallId === "string" ? e.toolCallId : null;
		if (id !== null && state.remembered.has(id)) {
			const args = state.remembered.get(id);
			state.remembered.delete(id);
			if (e.isError === false && isOutcome(args)) state.outcome = args; // latest valid wins
		}
		// omp can mount report_outcome as an xd:// device: the agent then calls `write xd://report_outcome`,
		// and only the end event's details name the tool and carry its parsed args.
		const details =
			typeof result.details === "object" && result.details !== null
				? (result.details as AnyRec)
				: {};
		const xdev =
			typeof details.xdev === "object" && details.xdev !== null
				? (details.xdev as AnyRec)
				: {};
		if (
			e.isError === false &&
			typeof xdev.tool === "string" &&
			xdev.tool.endsWith("report_outcome") &&
			isOutcome(xdev.args)
		) {
			state.outcome = xdev.args;
		}
		return {};
	}
	if (e.type === "agent_end" && e.isTerminal !== false) {
		state.sawTerminalEnd = true;
		const messages = Array.isArray(e.messages) ? e.messages : [];
		let lastAssistant: AnyRec | undefined;
		for (const m of messages) {
			const rec = m as AnyRec;
			if (typeof rec === "object" && rec !== null && rec.role === "assistant")
				lastAssistant = rec;
		}
		state.finalText = lastAssistant ? textParts(lastAssistant.content) : "";
	}
	return {};
}

interface RunHandle {
	pid: number | null;
	done: Promise<RunResult>;
	kill(): Promise<void>;
}

/** Narrow seam for tests: anything that can launch a piped child process. */
export type RunLauncher = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/** Shared stdout/stderr -> log/event plumbing for the local spawn and the worker client. */
export interface RunSink {
	/** One complete stdout line: an omp event, or a raw log line. */
	line(raw: string): void;
	/** One stdout chunk; buffers the trailing partial line until flush(). */
	stdout(text: string): void;
	/** One stderr chunk: grows the tail and logs each line as "! ...". */
	stderr(text: string): void;
	/** Log one line already captured in a worker's stderr tail, as "! ...". */
	stderrLine(line: string): void;
	/** A child 'error' event: grows the tail and logs the message. */
	childError(message: string): void;
	/** Raw log write (worker dispatch notes, relayed worker stderr). */
	logMark(text: string): void;
	/** Flush the buffered partial stdout line (end of stream). */
	flush(): void;
	/** EventState advanced by the lines seen so far. */
	state: EventState;
	/** Current stderr tail (last 4000 chars, CRLF normalized). */
	tail(): string;
	/** Snapshot the event state plus the settle-time fields into one RunResult. */
	result(
		r: Pick<RunResult, "exitCode" | "killed" | "stderrTail"> &
			Partial<RunResult>,
	): RunResult;
}

export function createRunSink(o: {
	logPath: string;
	/** Anchor for the log write (src/confine.ts). */
	dataRoot: string;
	onLog?: () => void;
	onSession?: (sessionId: string) => void;
	/** A progress event (stryker.ts): never logged; null text clears the card's progress. */
	onProgress?: (text: string | null) => void;
}): RunSink {
	const es = newEventState();
	let stderrTail = "";

	// Log: appended below dataRoot, capped at LOG_CAP_BYTES counted in UTF-8 bytes.
	mkdirBelow(o.dataRoot, dirname(o.logPath));
	let bytes = 0;
	try {
		bytes = statSync(o.logPath).size;
	} catch {
		// new file
	}
	let truncated = false;
	const appendLog = (s: string): void => {
		if (truncated) return;
		const size = Buffer.byteLength(s, "utf8");
		if (bytes + size > LOG_CAP_BYTES) {
			truncated = true;
			writeBelow(
				o.dataRoot,
				o.logPath,
				"\n[log truncated at 2 MiB; the full transcript is in the omp session]\n",
				"append",
			);
			o.onLog?.();
			return;
		}
		writeBelow(o.dataRoot, o.logPath, s, "append");
		bytes += size;
		o.onLog?.();
	};
	// Merge turns carry git host tokens (D6): a remote may echo one into a failed push, so no
	// stored token or key path reaches the worker-shared task log raw, also when it spans two
	// rendered events (the writer holds back a possible secret start until the next write).
	// The run's own snapshot, taken when the run starts, joined with the current list: a token
	// rotated or removed mid-run stays redacted in this run's log until the run ends.
	const runSecrets = [...gitSecrets()];
	const liveSecrets = () => [...runSecrets, ...gitSecrets()];
	const log = redactingWriter(appendLog, liveSecrets);

	const handleLine = (raw: string): void => {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) return;
		let ev: unknown;
		try {
			ev = JSON.parse(line);
		} catch {
			log.write(`${line}\n`);
			return;
		}
		const e = typeof ev === "object" && ev !== null ? (ev as AnyRec) : null;
		if (e?.type === PROGRESS_EVENT) {
			o.onProgress?.(typeof e.text === "string" ? e.text : null);
			return;
		}
		log.write(renderEvent(ev));
		const { sessionStarted } = applyEvent(es, ev);
		if (sessionStarted !== undefined) o.onSession?.(sessionStarted);
	};

	let partial = "";
	let stderrPartial = "";
	return {
		state: es,
		line: handleLine,
		stdout: (text) => {
			partial += text;
			let idx = partial.indexOf("\n");
			while (idx >= 0) {
				const line = partial.slice(0, idx);
				partial = partial.slice(idx + 1);
				handleLine(line);
				idx = partial.indexOf("\n");
			}
		},
		stderr: (text) => {
			stderrTail = `${stderrTail}${text}`.replace(/\r\n/g, "\n").slice(-4000);
			// Whole lines only: a chunk boundary inside a line must not split a token with "! ".
			stderrPartial += text;
			let idx = stderrPartial.indexOf("\n");
			while (idx >= 0) {
				const l = stderrPartial.slice(0, idx).replace(/\r$/, "");
				stderrPartial = stderrPartial.slice(idx + 1);
				if (l.trim()) log.write(`! ${l}\n`);
				idx = stderrPartial.indexOf("\n");
			}
		},
		childError: (message) => {
			log.write(`! ${message}\n`);
			stderrTail = `${stderrTail}${message}\n`
				.replace(/\r\n/g, "\n")
				.slice(-4000);
		},
		stderrLine: (line) => log.write(`! ${line}\n`),
		logMark: log.write,
		flush: () => {
			if (partial.trim()) handleLine(partial);
			partial = "";
			if (stderrPartial.trim())
				log.write(`! ${stderrPartial.replace(/\r$/, "")}\n`);
			stderrPartial = "";
			log.flush();
		},
		tail: () => redact(stderrTail, liveSecrets()),
		result: (r) => {
			// Every path (local close, worker end, lost worker) settles here: release the held tail.
			log.flush();
			return {
				sessionId: es.sessionId,
				model: es.model,
				outcome: es.outcome,
				asked: es.asked,
				proposed: es.proposed,
				recorded: es.recorded,
				approvalRefused: es.approvalRefused,
				sawTerminalEnd: es.sawTerminalEnd,
				finalText: es.finalText,
				// Patterns miss secrets with no known shape: also strip the values Ottr holds.
				providerError:
					es.providerError && redact(es.providerError, liveSecrets()),
				...r,
			};
		},
	};
}

/** D6: no agent run holds Ottr's ssh command, the env-scoped credential helper or the
 * per-host tokens; the server alone runs that git. GH_TOKEN is not in this set: a local run
 * (a merge turn in the server container) keeps it for its push. Worker turns never get it:
 * startRun drops it from the forwarded env, and serveWorker strips it from its own env. */
function withoutGitAuth(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out = { ...env };
	for (const k of Object.keys(out))
		if (GIT_AUTH_ENV_NAME.test(k)) delete out[k];
	return out;
}

export function startRun(o: {
	cwd: string;
	prompt: string;
	sessionDir: string;
	/** The tracker extension; null omits `--extension` (a review check run carries no tools of ours). */
	extensionPath?: string | null;
	resumeId: string | null;
	images?: string[];
	model?: string | null;
	/** Review turns pin the omp session name; the extension applies it proactively via this env var. */
	sessionName?: string | null;
	/** Set: the run's session can file cards via its create_task tool; injected as OTTR_BOARD_URL/OTTR_BOARD_TOKEN/OTTR_PROJECT/OTTR_TASK_ID. */
	board?: BoardEnv | null;
	logPath: string;
	/** Anchor for the log write (src/confine.ts). */
	dataRoot: string;
	/** Called after every append to the log file; the server turns it into a throttled `log` push. */
	onLog?: () => void;
	onSession?: (sessionId: string) => void;
	/** Live Stryker progress of the run (stryker.ts); null once the run ends. */
	onProgress?: (text: string | null) => void;
	/** Defaults to the real `spawn`; tests inject a fake child. */
	launcher?: RunLauncher;
	/** Set: run the turn in a worker container, falling back to a local spawn on connect failure. */
	worker?: WorkerTarget | null;
	/** Extra env merged into the child's base (a retro run's OTTR_RETRO=1). */
	env?: Record<string, string>;
	/** Set: strip the board coordinates from the child env (a retro run). */
	stripBoard?: boolean;
	/** Pinned tool list / extension config / skill, passed to buildOmpArgs (a retro run). */
	tools?: string | null;
	config?: string | null;
	skills?: string | null;
	/** Non-empty caps the run's duration (`--max-time`); a review check run sets it so a hung
	 * check cannot hold a board slot forever. */
	maxTime?: string | null;
}): RunHandle {
	const sink = createRunSink({
		logPath: o.logPath,
		dataRoot: o.dataRoot,
		onLog: o.onLog,
		onSession: o.onSession,
		onProgress: o.onProgress,
	});

	// Context a no-stderr death reports (classify folds it into the failure reason): how the
	// run was dispatched, how much it was asked to do, where, under which pid, for how long.
	const args = buildOmpArgs(o);
	const startedAt = Date.now();

	// A fallback reuses the caller's (secret-stripped) env; a plain launch derives it. Every
	// local child gets an explicit env so worker credentials never reach a turn (R3-6/D6).
	const startLocal = (
		mode = "local",
		withEnv?: Record<string, string>,
	): RunHandle => {
		const launch: RunLauncher = o.launcher ?? spawn;
		const child = launch("omp", args, {
			cwd: o.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env:
				withEnv ??
				childEnv({
					sessionName: o.sessionName,
					board: o.board ?? null,
					// A run's extra env (OTTR_RETRO, OTTR_REVIEW) rides on top of the inherited base:
					// replacing it would strip PATH and the provider auth the child needs.
					base: withoutGitAuth({ ...process.env, ...o.env }),
					stripBoard: o.stripBoard,
				}),
		});

		let killed = false;
		const stopWatch = watchProgress(child.pid, sink.line);
		child.stdout?.on("data", (chunk: Buffer) =>
			sink.stdout(chunk.toString("utf8")),
		);
		child.stderr?.on("data", (chunk: Buffer) =>
			sink.stderr(chunk.toString("utf8")),
		);

		// omp may die before reading stdin; a bare write would then emit an
		// unhandled EPIPE 'error' and crash the tracker.
		child.stdin?.on("error", () => {});
		child.stdin?.write(o.prompt, "utf8");
		child.stdin?.end();

		let settled = false;
		const { promise: done, resolve: resolveDone } =
			Promise.withResolvers<RunResult>();
		const settle = (code: number | null): void => {
			if (settled) return;
			settled = true;
			resolveDone(
				sink.result({
					exitCode: code,
					killed,
					stderrTail: sink.tail(),
					dispatch: `${mode}, argv ${args.length}, cwd ${basename(o.cwd)}${child.pid !== undefined ? `, pid ${child.pid}` : ""}, ${Math.round((Date.now() - startedAt) / 1000)}s`,
				}),
			);
		};

		child.on("error", (err: Error) => {
			sink.childError(err.message);
			if (child.pid === undefined) settle(null); // failed to spawn (e.g. ENOENT)
		});

		child.on("close", (code) => {
			stopWatch();
			sink.flush();
			settle(code ?? null);
		});

		return {
			pid: child.pid ?? null,
			done,
			kill: () => {
				killed = true;
				if (child.pid !== undefined) platform.killTree(child.pid);
				return Promise.resolve();
			},
		};
	};

	if (!o.worker) return startLocal();

	// The worker runs omp itself; the tracker env is forwarded so a pinned session
	// name and the board coordinates still reach the extension, but the worker's own
	// credentials do not (childEnv strips them), and neither does the board's GitHub
	// token: work turns only commit locally, push credentials never leave the server (D6).
	// serveWorker also strips every git host token from the worker container's own env.
	// The pinned PI_CODING_AGENT_DIR stays out too (R5-1): a turn that ran the board's
	// own agent dir could rewrite the config and skills the board's privileged turns
	// execute, and a worker without its own shared store would find no credentials.
	const env = childEnv({
		sessionName: o.sessionName,
		board: o.board ?? null,
		base: withoutGitAuth({
			...process.env,
			...o.env,
			GH_TOKEN: undefined,
			PI_CODING_AGENT_DIR: undefined,
		}),
		stripBoard: o.stripBoard,
	});
	const workerHandle = runWorker(
		{
			id: crypto.randomUUID(),
			argv: buildOmpArgs(o),
			cwd: o.cwd,
			stdin: o.prompt,
			env,
		},
		o.worker,
		sink,
	);
	let current: RunHandle | null = null;
	return {
		// pid is null while omp lives in the worker container's namespace; sweepLostTurns
		// treats an open pid-null row without a live entry as lost after a tracker restart.
		get pid() {
			return current?.pid ?? null;
		},
		done: workerHandle.done
			.then((r) => ({
				...r,
				// The worker's own pid is in its container namespace; only the wall duration is local.
				dispatch: `worker ${workerHandle.url}, argv ${args.length}, cwd ${basename(o.cwd)}, ${Math.round((Date.now() - startedAt) / 1000)}s`,
			}))
			.catch((err) => {
				if (!(err instanceof WorkerConnectError)) throw err;
				sink.logMark(
					`! worker dispatch failed: ${err.message}; falling back to local spawn\n`,
				);
				current = startLocal(`local fallback (${err.message})`, env);
				return current.done;
			}),
		kill: async () => {
			workerHandle.kill();
			await current?.kill();
		},
	};
}

/** Worker pool from the tracker env; null when no worker is configured. */
export function workerFromEnv(
	env: Record<string, string | undefined> = process.env,
): WorkerTarget | null {
	const urls = (env.OTTR_WORKER_URLS ?? "")
		.split(",")
		.map((u) => u.trim())
		.filter((u) => u !== "");
	if (urls.length === 0) return null;
	// Fail closed: a worker URL without a shared token would drive or serve /run
	// unauthenticated on a 0.0.0.0 port.
	const token = env.OTTR_WORKER_TOKEN;
	if (!token)
		throw new Error(
			"OTTR_WORKER_URLS is set but OTTR_WORKER_TOKEN is unset; workers require a token",
		);
	return { urls, token };
}
