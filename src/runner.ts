import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirBelow, touchBelow, writeBelow } from "./confine.ts";
import {
	type CommitIdentity,
	commitIdentityEnv,
	DEFAULT_COMMIT_EMAIL,
	DEFAULT_COMMIT_NAME,
	type IdentProbeEnv,
	probeGitIdent,
} from "./gitIdentity.ts";
import type { TokenUsage } from "./hosted.ts";
import {
	addLayerUse,
	pinnedAgentLayer,
	removeLayerUse,
	resolveAgentLayer,
} from "./layers.ts";
import {
	agentDir,
	boardOmpEnv,
	boardOmpHome,
	LENT_ENV,
	signIns,
} from "./login.ts";
import { ensureMemoryOverlay, memoryBackendFromEnv } from "./memory.ts";
import { platform } from "./platform/index.ts";
import { ensurePluginSkillsOverlay } from "./pluginSkills.ts";
import { LOST_SESSION } from "./prompts.ts";
import { PROGRESS_EVENT, watchProgress } from "./stryker.ts";
import { formatBytes } from "./tmpsweep.ts";
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
import type { VmGrant, VmTokens } from "./vmTokens.ts";
import type { VmSpec, WorkerTarget } from "./workers.ts";
import { runWorker, WorkerBusyError, WorkerConnectError } from "./workers.ts";
import {
	GIT_AUTH_ENV_NAME,
	gitSecrets,
	redact,
	redactingWriter,
	stripProxyCredentials,
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
 * must not learn the server-only state path. OTTR_BACKUP_DIR stays behind too: a turn that
 * starts a scratch board (ottr's own tests, the boot smoke) must not write into the live
 * backup dir or remove live snapshots. The worker dispatch
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
	delete env.OTTR_BACKUP_DIR;
	delete env.OTTR_WORKER_URLS;
	delete env.OTTR_WORKER_TOKEN;
	// The alate bearer key drives provisioning of the agent layer every turn executes;
	// no turn ever calls alate (only the board's server-side client does), so a turn
	// that held it could rewrite the fleet's rules, skills and plugins (R5-1 class).
	delete env.ALATE_API_KEY;
	// The hosted identity-signing key: a holder forges owner/control/tenant headers.
	delete env.OTTR_HOSTED_SECRET;
	// Same strip in serveWorker: a corporate proxy URL with credentials
	// (http://user:pass@proxy:8080) must not sit in a turn's env; the host and
	// port stay, so the proxy still routes the turn's network calls.
	stripProxyCredentials(env);
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

/**
 * Overlay that turns off project MCP config for every run: the run's cwd is a
 * worker-writable worktree, so nothing in it may steer the run. Rides in the extension
 * dir, so the path resolves identically inside a worker container.
 */
export const NO_DISCOVERY_CONFIG = resolve(
	import.meta.dir,
	"..",
	"extension",
	"no-discovery.yml",
);

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
	/** Memory backend overlay path; null/omitted omits the `--config` pair (tests pin exact argv without it). */
	memoryConfig?: string | null;
	/** Plugin-skills overlay path (docs/specs/turn-home-plugin-skills.md); null omits the pair (tests pin exact argv without it). Production runs always carry it: the home's plugin skill dirs plus the project-level skill enables pinned off. */
	pluginSkillsConfig?: string | null;
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
		// Every run's cwd is a worker-writable worktree, so nothing in that tree may steer
		// the run (audit ottr.board-runs.worktree-omp-extensions-execute-in-server):
		// no discovered extensions/plugins, no LSP servers, no project MCP config. The
		// explicit tracker extension (--extension) still loads under --no-extensions.
		"--no-extensions",
		"--no-lsp",
		"--config",
		NO_DISCOVERY_CONFIG,
		// The plugin-skills overlay (docs/specs/turn-home-plugin-skills.md): the run home's
		// enabled plugins' SKILL.md dirs, no plugin code. Its key is unique to this overlay,
		// so the per-key overlay order cannot clash; the memory overlay stays last.
		...(o.pluginSkillsConfig ? ["--config", o.pluginSkillsConfig] : []),
		// The memory overlay rides last among the configs: later overlays win per key, so the
		// board's backend choice beats any stale `memory:` line in the extension's run.yml.
		...(o.memoryConfig ? ["--config", o.memoryConfig] : []),
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

/** The message_update variants the log renders; everything else is noise. */
function renderMessageUpdate(e: AnyRec): string {
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

function renderMessageEnd(e: AnyRec): string {
	const m = e.message;
	if (typeof m !== "object" || m === null || (m as AnyRec).role !== "assistant")
		return "";
	const error = providerError(m as AnyRec);
	return error ? `\n! provider: ${error}\n` : "\n";
}

/** The ask tool's questions, or null when the args carry no usable questions. */
function renderAsk(args: unknown): string | null {
	const qs = askQuestions(args);
	if (qs === null) return null;
	return `\n▸ ask\n${qs
		.map(
			(q) =>
				`  ? ${q.question}\n${q.options.map((o) => `    • ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`,
		)
		.join("\n")}\n`;
}

function renderToolStart(e: AnyRec): string {
	const name = e.toolName;
	if (typeof name !== "string") return "";
	const args =
		typeof e.args === "object" && e.args !== null ? (e.args as AnyRec) : {};
	if (name.endsWith("report_outcome"))
		return `\n▸ report_outcome: ${String(args.status ?? "?")} — ${String(args.summary ?? "")}\n`;
	if (ASK_TOOL.test(name)) {
		const ask = renderAsk(e.args);
		if (ask !== null) return ask;
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

function renderToolEnd(e: AnyRec): string {
	if (e.isError !== true) return "";
	const result =
		typeof e.result === "object" && e.result !== null
			? (e.result as AnyRec)
			: {};
	const flat = textParts(result.content).replace(/\r?\n/g, " ⏎ ");
	return `  ✗ ${flat.length > 500 ? `${flat.slice(0, 500)}…` : flat}\n`;
}

/** Pure: one omp JSON event -> text appended to the task log. Malformed/unknown -> "". */
export function renderEvent(ev: unknown): string {
	if (typeof ev !== "object" || ev === null) return "";
	const e = ev as AnyRec;
	switch (e.type) {
		case "session":
			return typeof e.id === "string" ? `[omp session ${e.id}]\n` : "";
		case "message_update":
			return renderMessageUpdate(e);
		case "message_end":
			return renderMessageEnd(e);
		case "tool_execution_start":
			return renderToolStart(e);
		case "tool_execution_end":
			return renderToolEnd(e);
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

/** Opens the model-restore reason; classify and runTurn match it in the previous turn's error. */
export const MODEL_RESTORE = "This board cannot load the session's model";

/** Opens the usage-limit continue reason; classify matches it in the previous turn's error. */
export const QUOTA_LIMIT = "The run stopped at the provider's usage limit";

/** Opens the worker OOM kill reason; classify matches it in the previous turn's error, and
 * the settle log in turn.ts matches it to add the worker name. */
export const OOM_KILL = "The worker ran out of memory (OOM kill";

/**
 * omp writes one JSON file per rejected HTTP 400 request under its state root:
 * $HOME/.omp/logs/http-400-requests/<millis>-<id>.json. R5-1: that root stays under the HOME omp
 * runs with even when PI_CODING_AGENT_DIR pins the agent dir — omp skips the XDG state-root probe
 * under the override. Worker turns write to the shared home, the
 * board's own turns to boardOmpHome(), so the reader scans both; a pinned turn writes into its
 * layer's shared-state `.omp/logs` link, so the reader also scans each home's current layer
 * (moment-in-time, no pin). All of these resolve to the same flat logs through the link while
 * a layer lives; the Set dedups them. The shared one is
 * worker-writable, but only the file name (never the body) is read; a plant can forge a file
 * name at worst.
 */
const http400Dirs = (): string[] => {
	const homes = [homedir(), boardOmpHome()];
	const roots = [...homes];
	for (const h of homes) {
		const layer = resolveAgentLayer(h);
		if (layer !== null) roots.push(layer.dir);
	}
	return [
		...new Set(roots.map((h) => join(h, ".omp", "logs", "http-400-requests"))),
	];
};

/** Newest omp HTTP-400 log entry whose timestamp falls inside [from, to], as the file name,
 * or null. Best-effort: a missing or unreadable log is no evidence, the caller falls back to
 * the generic failure message. Only the file name carries the timestamp, so the (large)
 * request bodies are never read. */
export function findHttp400Rejection(o: {
	from: number;
	to: number;
	/** Override for tests; defaults to http400Dirs(). */
	dir?: string;
}): string | null {
	let best: { ts: number; file: string } | null = null;
	for (const dir of o.dir ? [o.dir] : http400Dirs()) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const ts = Number(/^(\d+)-[A-Za-z0-9_-]+\.json$/.exec(name)?.[1]);
			if (
				Number.isFinite(ts) &&
				ts >= o.from &&
				ts <= o.to &&
				(best === null || ts > best.ts)
			)
				best = { ts, file: name };
		}
	}
	return best?.file ?? null;
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

/** True when the run stopped at the provider's usage or quota limit: a retry before the
 * reset fails the same way. Covers omp's usage_limit_reached, the human "usage limit"
 * wording, the gateways' "quota exhausted" / "quota exceeded" / "no quota" /
 * insufficient_quota forms, and ZAI's "Weekly/Monthly Limit Exhausted" (OTTR-670). Rate
 * limits stay out: rateLimitWaitMs below reads their retry-after waits (OTTR-847). Shared
 * with the check runs' hold logic in turn.ts. */
export function hitUsageLimit(r: RunResult): boolean {
	return /usage_limit_reached|usage limit|limit exhausted|quota exhausted|quota exceeded|no quota|insufficient_quota/i.test(
		`${r.stderrTail}\n${r.providerError ?? ""}`,
	);
}

/** The wait a provider rate-limit rejection asks for, in ms: `retry-after-ms` counts
 * milliseconds, a `Retry-After` value counts seconds (HTTP). Null when the failure is not
 * a rate limit (a 429 or rate-limit wording) or names no wait. The check runs' hold logic
 * in turn.ts holds through a long wait instead of a retry that fails the same way
 * (OTTR-847). */
export function rateLimitWaitMs(r: RunResult): number | null {
	const text = `${r.stderrTail}\n${r.providerError ?? ""}`;
	if (!/\b429\b|rate[-_ ]?limit/i.test(text)) return null;
	const ms = /retry-after-ms["']?\s*[:=]\s*"?(\d+)/i.exec(text);
	if (ms !== null) return Number(ms[1]);
	const seconds = /retry-after(?!-ms)["']?\s*[:=]\s*"?(\d+)/i.exec(text);
	return seconds === null ? null : Number(seconds[1]) * 1000;
}

/** The reset instant a usage-limit error names ("will reset at 2026-11-16 19:45:04"),
 * epoch ms; null when the text names none or names it without an explicit zone. A zoneless
 * time stays unused (Z.AI writes Beijing time): the board never guesses a zone, it probes
 * instead (OTTR-880). Accepted zones: UTC, GMT, Z, a numeric offset. Shared with the check
 * runs' hold logic in turn.ts. */
export function usageLimitResetMs(r: RunResult): number | null {
	const text = `${r.stderrTail}\n${r.providerError ?? ""}`;
	const m = /will reset at ([^\n()]+)/i.exec(text);
	const raw = (m?.[1] ?? "").trim().replace(/[.,;]+$/, "");
	if (raw === "") return null;
	if (!/(?:\s(?:UTC|GMT)|[+-]\d{2}:\d{2}|Z)$/i.test(raw)) return null;
	const norm = raw.replace(/\s+(?:UTC|GMT)$/i, "Z").replace(" ", "T");
	const ms = Date.parse(norm);
	return Number.isFinite(ms) ? ms : null;
}

/** The inputs classify reads. */
interface ClassifyInput {
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
	/** A microVM turn's end-of-run `git status --porcelain` lines (VmOutcome.dirty); null when
	 * the VM could not report. Undefined for every other run. Only the ready refusal reads it. */
	vmDirty?: string[] | null;
}

/** One classify rule: the first non-null result wins. */
type ClassifyRule = (o: ClassifyInput, stage: Next["stage"]) => Next | null;

const needsAt = (stage: Next["stage"], reason: string): Next => ({
	stage,
	state: "needs_you",
	needsReason: reason,
});

/** The provision guard outweighs every other rule: a run that left the alate-provisioned
 * agent layer drifts parks even on a received receipt — the next provision refuses or
 * overwrites the changed files, and the only fix is a data-repo commit
 * (docs/specs/turn-provision-guard.md). */
const provisionRule: ClassifyRule = (o, stage) => {
	const { result } = o;
	if (!result.provisionDrift?.length) return null;
	const shown = result.provisionDrift.slice(0, 4);
	const more = result.provisionDrift.length - shown.length;
	return needsAt(
		stage,
		`A turn changed the alate-provisioned agent layer: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. The next provision refuses or overwrites these files — do not edit the installed copies; change it in agent-data, then reply.`,
	);
};

const killedRule: ClassifyRule = (o, stage) =>
	o.result.killed ? needsAt(stage, "Stopped by the tracker.") : null;

/** One-shot omp runs exit 0 when the agent ends its reply on a pending wait/background call
 * (nothing is alive to deliver the result and wake it). The session survives, so the corrective
 * continue re-checks. ponytail: one automatic continue per streak; if the previous turn already ended this
 * way, a human decides. Count streaks if agents often need a second one. */
const backgroundWaitRule: ClassifyRule = (o, stage) => {
	const { result, previousError } = o;
	if (!(result.exitCode === 0 && !result.sawTerminalEnd)) return null;
	return previousError?.startsWith(BACKGROUND_WAIT)
		? needsAt(
				stage,
				`${BACKGROUND_WAIT} again; a one-shot omp run exits instead of being woken. Reply "." to let it re-check, or use New session.`,
			)
		: {
				stage,
				state: "queued",
				needsReason: `${BACKGROUND_WAIT} - the run exited and the background job died with it; resuming automatically. Cancel to stop it instead.`,
				pendingPrompt:
					"Your previous turn ended while a background job ran; the run exits and kills the job. Continue the task and run slow gates in the foreground.",
			};
};

/** A lost worker is not the turn's fault: a fresh worker runs the same reply. Same
 * one-auto-resume-per-streak pattern as the background-wait rule above. */
const workerLostRule: ClassifyRule = (o, stage) => {
	if (o.result.workerLost !== true) return null;
	return o.previousError?.startsWith(WORKER_LOST)
		? needsAt(
				stage,
				`${WORKER_LOST} again; a fresh worker runs the reply. Cancel to stop it instead.`,
			)
		: {
				stage,
				state: "queued",
				needsReason: `${WORKER_LOST} - resuming automatically. Cancel to stop it instead.`,
				pendingPrompt: ".",
			};
};

/** The turn's death context: stderr, then the provider's structured error. */
function deathContext(o: ClassifyInput): string | null | undefined {
	return deathLine(o.result.stderrTail) ?? o.result.providerError;
}

/** A turn that died before its first event with empty stderr is the provider answering
 * with an HTTP 400 (e.g. a content filter). With attached images it rejected the
 * image input: re-attaching the same images would loop forever, so the caller
 * quarantines the files and this requeues text-only. The text-only retry carries
 * images 0, so a second failure takes one of the rules below. */
const providerRejectionRule: ClassifyRule = (o, stage) => {
	const { result } = o;
	if (
		!(
			result.sessionId === null &&
			result.outcome === null &&
			result.stderrTail.trim() === "" &&
			!result.providerError
		)
	)
		return null;
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
		return needsAt(
			stage,
			`The provider rejects this prompt's content - reword the task (evidence: ~/.omp/logs/http-400-requests/${evidence}).`,
		);
	return null;
};

/** omp restores a resumed session's saved model unless --model is given; a model whose
 * provider has no sign-in here kills the run. runTurn retries once with the board's
 * default role. A failure after that retry needs a human. */
const modelRestoreRule: ClassifyRule = (o, stage) => {
	const last = deathContext(o);
	if (o.previousError?.startsWith(MODEL_RESTORE))
		return needsAt(
			stage,
			`${MODEL_RESTORE}, and the retry with the board's default model role failed too${last ? `: ${last}` : ""}. Sign in to a provider under Settings, set a default model role, or switch the card's model, then reply.`,
		);
	const lost = last && /Could not restore model (\S+)/.exec(last)?.[1];
	if (lost)
		return {
			stage,
			state: "queued",
			needsReason: `${MODEL_RESTORE} ${lost} (no sign-in for its provider here) - retrying with the board's default model role. Cancel to stop it instead.`,
		};
	return null;
};

/** The run died at the provider's usage or quota limit: a retry before the reset fails
 * the same way, so every death queues again (never parks) and the settle in turn.ts
 * stamps the hold: the provider's reported reset, else the error's own reset time when
 * it names a zone, else a probe wait that grows with the card's consecutive usage holds
 * (OTTR-880). The scheduler starts the continue when the hold ends. */
const usageLimitRule: ClassifyRule = (o, stage) => {
	if (!hitUsageLimit(o.result)) return null;
	return {
		stage,
		state: "queued",
		needsReason: `${QUOTA_LIMIT} - continuing automatically. Cancel to stop it instead.`,
		pendingPrompt: ".",
	};
};

/** The worker container's memory limit killed the run (kernel OOM): the run ended with no
 * exit code while the cgroup's oom_kill count grew. Same one-auto-continue-per-streak
 * pattern as the usage-limit rule; the settle log names the worker. */
const oomRule: ClassifyRule = (o, stage) => {
	if (o.result.oomKilled !== true) return null;
	const bytes = o.result.memoryLimitBytes;
	const sentence =
		bytes === null || bytes === undefined
			? `${OOM_KILL})`
			: `${OOM_KILL}, limit ${formatBytes(bytes)})`;
	return o.previousError?.startsWith(OOM_KILL)
		? needsAt(
				stage,
				`${sentence} again after the automatic continue. Free memory or raise the worker limit, then reply.`,
			)
		: {
				stage,
				state: "queued",
				needsReason: `${sentence} - continuing automatically. Cancel to stop it instead.`,
				pendingPrompt: ".",
			};
};

/** The death block: omp exited without a terminal report; every sub-rule shares the
 * `last` context for the final generic failure. */
function deathRule(o: ClassifyInput, stage: Next["stage"]): Next | null {
	const { result } = o;
	if (
		!(
			(result.exitCode !== 0 || !result.sawTerminalEnd) &&
			(result.outcome === null || result.outcome.status === "needs_you")
		)
	)
		return null;
	const oom = oomRule(o, stage);
	if (oom !== null) return oom;
	const reject = providerRejectionRule(o, stage);
	if (reject !== null) return reject;
	const restore = modelRestoreRule(o, stage);
	if (restore !== null) return restore;
	const usage = usageLimitRule(o, stage);
	if (usage !== null) return usage;
	// Prefer stderr, then the provider's structured error, then dispatch context.
	const last = deathContext(o);
	const ctx = last
		? `: ${last}`
		: result.dispatch
			? ` (dispatch ${result.dispatch}, no stderr)`
			: "";
	return needsAt(
		stage,
		`omp exited with code ${result.exitCode ?? "unknown"} before finishing${ctx}.`,
	);
}

const approvalRefusedRule: ClassifyRule = (o, stage) =>
	o.result.approvalRefused
		? needsAt(
				stage,
				"A tool call needed approval, which tracker runs can't answer. Allow the tool in omp's config or continue in a terminal (see the card).",
			)
		: null;

/** The agent asked the user a question via the ask tool and paused: surface it as the "?" state.
 * If it went on to finish the turn on its own (ready/answered/integrated), the ask is moot. */
const askedRule: ClassifyRule = (o, stage) => {
	const { result } = o;
	if (result.asked === null) return null;
	if (result.outcome !== null && result.outcome.status !== "needs_you")
		return null;
	const asked = result.asked;
	const first = asked[0];
	if (first === undefined) return null;
	const q = first.question;
	return {
		stage,
		state: "needs_you",
		needsReason: `Wants your answer: ${q.length > 160 ? `${q.slice(0, 160)}…` : q}${asked.length > 1 ? ` (+${asked.length - 1} more)` : ""}`,
		asked,
	};
};

/** A grill turn never leaves the backlog column: a received ready or answered report marks
 * the item grilled — parked at idle until the user promotes it. Everything upstream (deaths,
 * background waits, open asks) keeps the generic flows, now with stage=backlog. */
const grillIdleRule: ClassifyRule = (o, stage) => {
	if (o.grill !== true) return null;
	const oc = o.result.outcome;
	if (oc === null) return null;
	if (oc.status === "needs_you" || oc.status === "integrated") return null;
	return { stage, state: "idle", needsReason: null };
};

/** The receipt path can be down (e.g. the tracker extension failed to load) while the turn
 * itself finished fine. Prove what it completed from git, by the same predicates a receipt
 * is validated against below; anything unprovable still asks for a human. Turns that
 * aborted (crash, refusal, pending background job) never reach this branch.
 * A research card's deliverable is the report file, not a receipt: exit 0 with the report
 * present settles done. Before the commits rule: research never merges. */
function receiptFallback(o: ClassifyInput, stage: Next["stage"]): Next {
	const { kind, git } = o;
	if (kind === "work" && o.research === true && o.hasReport === true)
		return { stage: "done", state: "idle", needsReason: null };
	if (kind === "work" && o.grill !== true && git.commitsAhead > 0 && git.clean)
		return { stage: "merging", state: "queued", needsReason: null };
	if (kind === "merge" && git.integrated)
		return { stage: "done", state: "idle", needsReason: null };
	return needsAt(stage, "The agent finished without calling report_outcome.");
}

/** Only a merge turn may report integrated: merging is the merge turn's job (rebase, gates,
 * server push). A work turn that integrated by hand is rejected once with the reason; the
 * reply that resumes the card carries it (rejectedReport), so the agent re-reports ready
 * and the normal merge turn pushes (AGEN-33 landed without a server push this way). */
const integratedRule: ClassifyRule = (o, stage) => {
	const { kind, git, target } = o;
	const oc = o.result.outcome;
	if (oc === null || oc.status !== "integrated") return null;
	if (kind === "work") {
		// OTTR-766: a head already on the target is an out-of-turn merge — the park
		// names it (and that a work turn never merges) instead of the generic text, so
		// the rejection note the resumed turn reads says what actually happened.
		if (git.integrated)
			return needsAt(
				stage,
				`Out-of-turn merge: the branch head is already on ${target ?? "the integration target"}. A work turn never merges; report ready.`,
			);
		return needsAt(stage, "Work turns do not merge; report ready.");
	}
	if (git.integrated)
		return { stage: "done", state: "idle", needsReason: null };
	return needsAt(
		stage,
		`Reported integrated, but HEAD is not on ${target ?? "the integration target"}.`,
	);
};

/** A work turn's ready report: mergeable trees queue for merging, a sibling's already-integrated fix settles done, the rest is a ready refusal. */
function workReadyNext(
	o: ClassifyInput,
	stage: Next["stage"],
	git: GitFacts,
): Next {
	if (o.grill !== true && git.commitsAhead > 0 && git.clean)
		return { stage: "merging", state: "queued", needsReason: null };
	// A sibling card already merged the same fix: nothing left to merge, the ready report is complete.
	if (git.commitsAhead === 0 && git.integrated)
		return { stage: "done", state: "idle", needsReason: null };
	return needsAt(
		stage,
		`Reported ready, but git shows ${git.commitsAhead} commit(s) ahead of the base${git.clean ? "" : vmDirtyText(o.vmDirty)}.`,
	);
}

/** A work turn's answered report: no commits settle done, an integrable branch still merges (never research), the rest is a refusal. */
function workAnsweredNext(
	o: ClassifyInput,
	stage: Next["stage"],
	git: GitFacts,
): Next {
	if (git.commitsAhead === 0)
		return { stage: "done", state: "idle", needsReason: null };
	// The agent misfiled answered while landable commits sit on the branch; git proves work to
	// integrate. Research cards must not merge, so only non-research turns take this path.
	if (git.clean && o.research !== true)
		return { stage: "merging", state: "queued", needsReason: null };
	return needsAt(
		stage,
		`Reported answered, but the branch has ${git.commitsAhead} commit(s) that were never integrated.`,
	);
}

const workOutcomeRule: ClassifyRule = (o, stage) => {
	if (o.kind !== "work") return null;
	const oc = o.result.outcome;
	if (oc === null) return null;
	if (oc.status === "ready") return workReadyNext(o, stage, o.git);
	if (oc.status === "answered") return workAnsweredNext(o, stage, o.git);
	return null;
};

const mergeOutcomeRule: ClassifyRule = (o, stage) => {
	if (o.kind === "work") return null;
	const oc = o.result.outcome;
	if (oc === null) return null;
	if (oc.status === "ready" || oc.status === "answered")
		return needsAt(stage, `Unexpected outcome "${oc.status}" in a merge turn.`);
	return null;
};

/** First matching rule wins. */
const CLASSIFY_RULES: ClassifyRule[] = [
	provisionRule,
	killedRule,
	backgroundWaitRule,
	workerLostRule,
	deathRule,
	approvalRefusedRule,
	askedRule,
	grillIdleRule,
	integratedRule,
	workOutcomeRule,
	mergeOutcomeRule,
];

/** Pure: decide where a task goes after a turn. First matching rule wins.
 * `research` marks a research card: research must not merge, so only the answered-with-commits
 * mapping checks it. */
export function classify(o: ClassifyInput): Next {
	const stage: Next["stage"] =
		o.grill === true
			? "backlog"
			: o.kind === "work"
				? "in_progress"
				: "merging";
	for (const rule of CLASSIFY_RULES) {
		const next = rule(o, stage);
		if (next !== null) return next;
	}
	const oc = o.result.outcome;
	if (oc === null) return receiptFallback(o, stage);
	return needsAt(stage, oc.question?.trim() ? oc.question.trim() : oc.summary);
}

/** The ready refusal's tail for an unclean tree: a microVM's tree is gone after the run, so
 * the reason names its files (the first 20) instead of pointing at a worktree to inspect. */
function vmDirtyText(dirty: string[] | null | undefined): string {
	if (dirty === undefined || (dirty !== null && dirty.length === 0))
		return " and uncommitted changes";
	if (dirty === null)
		return " and uncommitted changes (the microVM could not report its tree state)";
	return ` and uncommitted changes in the microVM: ${dirty.slice(0, 20).join(", ")}${dirty.length > 20 ? ` (+${dirty.length - 20} more)` : ""}`;
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
	/** toolCallId -> args of report_outcome and propose_task calls awaiting their tool_execution_end. */
	remembered: Map<string, unknown>;
	/** The agent's last ask call, normalized; null while none. */
	asked: AskQuestion[] | null;
	/** First succeeded `propose_task` call of a retro run; null while none (the extension
	 * refuses a second, and a refused call never records — the retry counts). */
	proposed: {
		prompt: string;
		model: string | null;
		summary: {
			whatChanges: string;
			why: string;
			gain: string;
			risk: string;
			check: string;
		} | null;
		/** The board project the card files on; null files on the retro's own project. */
		project: string | null;
	} | null;
	/** Every succeeded `propose_task` call, in order: a retro records at most one, a review one per finding. */
	recorded: RecordedFinding[];
	/** Token usage summed over the assistant message_end events; null until one carried usage. */
	usage: TokenUsage | null;
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
		usage: null,
	};
}

function applyMessageStart(state: EventState, e: AnyRec): void {
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
}

function applyMessageEnd(state: EventState, e: AnyRec, meter: boolean): void {
	const m = e.message;
	if (
		typeof m === "object" &&
		m !== null &&
		(m as AnyRec).role === "assistant"
	) {
		state.providerError = providerError(m as AnyRec);
		if (meter) addUsage(state, (m as AnyRec).usage);
	}
}

function applyAsk(state: EventState, e: AnyRec): void {
	const qs = askQuestions(e.args);
	// The extension allows one ask per turn and refuses later ones: the first usable ask
	// is the durable state, a refused second ask must not replace it on the card.
	if (qs !== null && state.asked === null) state.asked = qs;
}

/** The proposal's summary fields; null when a required field is missing or empty. */
function proposedSummary(
	args: AnyRec,
): NonNullable<EventState["proposed"]>["summary"] {
	const part = (key: string): string | null => {
		if (typeof args[key] !== "string") return null;
		const value = (args[key] as string).trim();
		if (value === "") return null;
		return value.length > 400 ? `${value.slice(0, 399)}…` : value;
	};
	const whatChanges = part("whatChanges");
	const why = part("why");
	const gain = part("gain");
	const check = part("check");
	if (whatChanges === null || why === null || gain === null || check === null)
		return null;
	// Summary policy: whatChanges/why/gain/check are required, risk optional and defaults
	// to "none found"; each field is capped at 400 characters (slice to 399 + "…").
	return { whatChanges, why, gain, risk: part("risk") ?? "none found", check };
}

/** A propose_task call's args wait on the shared remembered map until the end event
 * decides the call: a refused call (the extension answers refusals as "Error: " text,
 * never a throw) must not land in recorded or become the proposal — the agent's
 * retry after a refused project is the call that counts (OTTR-787). */
function applyProposeStart(state: EventState, e: AnyRec): void {
	const id = typeof e.toolCallId === "string" ? e.toolCallId : null;
	if (id === null) return;
	state.remembered.set(
		id,
		typeof e.args === "object" && e.args !== null ? e.args : {},
	);
}

/** The recorded facts of one succeeded propose_task call: the review finding, and —
 * retro semantics — the first succeeded call as the proposal. */
function recordProposal(state: EventState, args: AnyRec): void {
	if (typeof args.prompt !== "string" || args.prompt === "") return;
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
	// Retro semantics: the first succeeded call is the proposal (the extension
	// refuses a second, and a refused call never records).
	if (state.proposed === null)
		state.proposed = {
			prompt: call.prompt,
			model: call.model,
			summary: proposedSummary(args),
			project:
				typeof args.project === "string" && args.project.trim() !== ""
					? args.project.trim()
					: null,
		};
}

/** The end of one propose_task call: record only a succeeded one. The extension's
 * refusals ride as "Error: " text in a normal result, so the text decides with the
 * isError flag. */
function applyProposeEnd(state: EventState, e: AnyRec): void {
	const id = typeof e.toolCallId === "string" ? e.toolCallId : null;
	if (id === null || !state.remembered.has(id)) return;
	const args = state.remembered.get(id) as AnyRec;
	state.remembered.delete(id);
	const result =
		typeof e.result === "object" && e.result !== null
			? (e.result as AnyRec)
			: {};
	if (e.isError !== true && !textParts(result.content).startsWith("Error: "))
		recordProposal(state, args);
}

function applyReportStart(state: EventState, e: AnyRec): void {
	const id = typeof e.toolCallId === "string" ? e.toolCallId : null;
	if (id !== null)
		state.remembered.set(
			id,
			typeof e.args === "object" && e.args !== null ? e.args : {},
		);
}

/** The report_outcome outcome an xd:// device's end event carried, or null. omp can mount
 * report_outcome as an xd:// device: the agent then calls `write xd://report_outcome`,
 * and only the end event's details name the tool and carry its parsed args. */
function xdevOutcome(result: AnyRec): Outcome | null {
	const details =
		typeof result.details === "object" && result.details !== null
			? (result.details as AnyRec)
			: {};
	const xdev =
		typeof details.xdev === "object" && details.xdev !== null
			? (details.xdev as AnyRec)
			: {};
	if (
		typeof xdev.tool === "string" &&
		xdev.tool.endsWith("report_outcome") &&
		isOutcome(xdev.args)
	)
		return xdev.args;
	return null;
}

function applyToolEnd(state: EventState, e: AnyRec): void {
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
	if (e.toolName === "propose_task") {
		applyProposeEnd(state, e);
		return;
	}
	const id = typeof e.toolCallId === "string" ? e.toolCallId : null;
	if (id !== null && state.remembered.has(id)) {
		const args = state.remembered.get(id);
		state.remembered.delete(id);
		if (e.isError === false && isOutcome(args)) state.outcome = args; // latest valid wins
	}
	if (e.isError === false) {
		const xd = xdevOutcome(result);
		if (xd !== null) state.outcome = xd;
	}
}

function applyAgentEnd(state: EventState, e: AnyRec): void {
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

/** tool_execution_start: the ask, propose_task and report_outcome bookkeeping. */
function applyToolStart(state: EventState, e: AnyRec): void {
	if (typeof e.toolName !== "string") return;
	if (ASK_TOOL.test(e.toolName)) applyAsk(state, e);
	else if (e.toolName === "propose_task") applyProposeStart(state, e);
	else if (e.toolName.endsWith("report_outcome")) applyReportStart(state, e);
}

/** Pure: apply one omp JSON event to state. Returns the session id when it is first seen. */
export function applyEvent(
	state: EventState,
	ev: unknown,
	/** Hosted metering on: sum assistant usage into state.usage; off leaves it null. */
	meter = false,
): { sessionStarted?: string } {
	if (typeof ev !== "object" || ev === null) return {};
	const e = ev as AnyRec;
	switch (e.type) {
		case "session": {
			if (typeof e.id !== "string" || state.sessionId !== null) return {};
			state.sessionId = e.id;
			return { sessionStarted: e.id };
		}
		case "message_start":
			applyMessageStart(state, e);
			return {};
		case "message_end":
			applyMessageEnd(state, e, meter);
			return {};
		case "tool_execution_start":
			applyToolStart(state, e);
			return {};
		case "tool_execution_end":
			applyToolEnd(state, e);
			return {};
		case "agent_end":
			if (e.isTerminal !== false) applyAgentEnd(state, e);
			return {};
		default:
			return {};
	}
}

/** A token count or cost omp reported; anything missing, negative or not finite counts 0. */
function usageNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Adds one assistant message's omp `usage` ({input, output, cacheRead, cacheWrite, cost: {total}}). */
function addUsage(state: EventState, raw: unknown): void {
	if (typeof raw !== "object" || raw === null) return;
	const u = raw as AnyRec;
	const cost =
		typeof u.cost === "object" && u.cost !== null
			? usageNumber((u.cost as AnyRec).total)
			: 0;
	const sum = state.usage ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	state.usage = {
		input: sum.input + usageNumber(u.input),
		output: sum.output + usageNumber(u.output),
		cacheRead: sum.cacheRead + usageNumber(u.cacheRead),
		cacheWrite: sum.cacheWrite + usageNumber(u.cacheWrite),
		cost: sum.cost + cost,
	};
}

/** True when two usage sums are equal; null (no usage yet) equals all zeros. */
function sameUsage(a: TokenUsage | null, b: TokenUsage): boolean {
	return (
		(a?.input ?? 0) === b.input &&
		(a?.output ?? 0) === b.output &&
		(a?.cacheRead ?? 0) === b.cacheRead &&
		(a?.cacheWrite ?? 0) === b.cacheWrite &&
		(a?.cost ?? 0) === b.cost
	);
}

interface RunHandle {
	pid: number | null;
	/** OTTR-454: the dispatched worker's url; absent for a local run. The turn engine
	 * buckets live runs by it for GET /api/drain. */
	url?: string;
	/** The worker run id (WorkerRequest.id) the System view keys a turn's usage by; absent for
	 * local and microVM runs. */
	runId?: string;
	done: Promise<RunResult>;
	kill(): Promise<void>;
	/** Id of the agent layer the run pinned at start; null when it ran the flat home. */
	layerId?: string | null;
	/** A microVM run only: true once vm-runner took the dispatch, false when it never started
	 * (busy, refused, unreachable). runTurn waits for it before it records the turn, so a busy
	 * answer leaves no turn row and no consumed reply behind. */
	accepted?: Promise<boolean>;
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

/** One complete stdout line: a progress event updates the card, anything else renders into
 * the log and advances the event state (session, interim usage). */
function handleEventLine(
	raw: string,
	o: {
		onSession?: (sessionId: string) => void;
		/** A progress event (stryker.ts): never logged; null text clears the card's progress. */
		onProgress?: (text: string | null) => void;
		/** Hosted metering on: sum assistant usage into state.usage; off leaves it null. */
		meter?: boolean;
		/** Hosted mode only (needs `meter`): interim usage of the active run. */
		onUsage?: (usage: TokenUsage, model: string | null) => void;
		/** Fired once per newly parsed propose_task finding, in arrival order. */
		onRecorded?: (finding: RecordedFinding) => void;
	},
	es: EventState,
	log: { write(text: string): void },
): void {
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
	const before = es.usage;
	const recordedBefore = es.recorded.length;
	const { sessionStarted } = applyEvent(es, ev, o.meter === true);
	if (sessionStarted !== undefined) o.onSession?.(sessionStarted);
	for (let i = recordedBefore; i < es.recorded.length; i++)
		o.onRecorded?.(es.recorded[i]!);
	if (es.usage !== null && !sameUsage(before, es.usage))
		o.onUsage?.({ ...es.usage }, es.model);
}

export function createRunSink(o: {
	logPath: string;
	/** Anchor for the log write (src/confine.ts). */
	dataRoot: string;
	onLog?: () => void;
	onSession?: (sessionId: string) => void;
	/** A progress event (stryker.ts): never logged; null text clears the card's progress. */
	onProgress?: (text: string | null) => void;
	/** Extra values redacted like the git secrets: the run's lent provider token. */
	secrets?: readonly string[];
	/** Hosted mode only: capture token usage into the result; default off keeps the self-hosted result shape. */
	meter?: boolean;
	/** Hosted mode only (needs `meter`): the run's cumulative usage and model after each assistant
	 * message_end that changed the usage; turn.ts sends the interim metering records from it. */
	onUsage?: (usage: TokenUsage, model: string | null) => void;
	/** Fired once per newly parsed propose_task finding, in arrival order, before the run resolves. */
	onRecorded?: (finding: RecordedFinding) => void;
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
		// Past the cap the bytes are dropped, but the mtime still moves: the board reads it as
		// the run's last output (SILENT_LOG_MS in src/scheduler.ts), so a busy capped run never looks hung.
		if (truncated) {
			touchBelow(o.dataRoot, o.logPath);
			return;
		}
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
	// Merge turns carry git host tokens (D6) and every worker turn a lent provider token: a
	// remote or provider may echo one into an error, so no stored token or key path reaches the
	// worker-shared task log raw, also when it spans two rendered events (the writer holds back
	// a possible secret start until the next write). The run's own snapshot, taken when the run
	// starts, joined with the current list: a token rotated or removed mid-run stays redacted in
	// this run's log until the run ends.
	const runSecrets = [...gitSecrets(), ...(o.secrets ?? [])];
	const liveSecrets = () => [...runSecrets, ...gitSecrets()];
	const log = redactingWriter(appendLog, liveSecrets);

	const handleLine = (raw: string): void => handleEventLine(raw, o, es, log);

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
				// Only once omp reported usage: a run without it keeps the result shape it had.
				...(es.usage !== null ? { usage: { ...es.usage } } : {}),
				...r,
				// After the spread: a caller's raw tail (a worker's sentinel) is redacted too.
				stderrTail: redact(r.stderrTail, liveSecrets()),
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

/** Opens the busy reason; classify never sees it (runTurn requeues a busy dispatch first). */
export const WORKER_BUSY = "every microVM was busy";

/**
 * Env names no microVM turn may carry (docs/adr/0009-microvm-workers.md): provider keys and
 * lent OAuth tokens (providers go through the board's /llm proxy), GitHub tokens, and the
 * memory backend's credentials (memory goes through the board's /hindsight proxy).
 */
const VM_DENIED_ENV = /^(ANTHROPIC_|OPENAI_|GH_|GITHUB_|HINDSIGHT_)/;

/** True when the env entry must not reach a microVM guest: denied names, lent names, git
 * auth names, secret values, the guest's own PATH/home/agent dir, the board-config pointer
 * the guest mounts no file for (OTTR-693), and OTTR_ names outside the turn flags. */
function vmEnvDenied(
	k: string,
	v: string | undefined,
	secrets: Set<string>,
	lent: Set<string>,
): boolean {
	if (typeof v !== "string") return true;
	if (VM_DENIED_ENV.test(k) || lent.has(k) || GIT_AUTH_ENV_NAME.test(k))
		return true;
	if (secrets.has(v)) return true;
	// The guest owns its PATH, home and agent dir; the board's are meaningless inside.
	if (k === "PATH" || k === "HOME" || k === "PI_CODING_AGENT_DIR") return true;
	// OTTR-693: the guest mounts no board-config, so the board's GIT_CONFIG_GLOBAL
	// pointer would name a missing file there; git would then skip the global scope
	// entirely and never see an identity the VM image ships in its own home.
	if (k === "GIT_CONFIG_GLOBAL") return true;
	if (k.startsWith("OTTR_") && !/^OTTR_(RETRO|REVIEW|TRENDING)$/.test(k))
		return true;
	return false;
}

/**
 * The microVM turn's env, built as an allowlist instead of from process.env: the run's own
 * values (env.txt values, the retro/review/trending flags) minus every denied name and every
 * redacted secret, then the board coordinates with the per-turn VM token (never the boot
 * token) and the shared-home layer pin. Nothing of the board process's env rides along.
 */
export function vmEnv(o: {
	env?: Record<string, string>;
	secrets?: readonly string[];
	sessionName?: string | null;
	board?: BoardEnv | null;
	stripBoard?: boolean;
	boardUrl: string;
	token: string;
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null;
}): Record<string, string> {
	const secrets = new Set(o.secrets ?? []);
	const lent = new Set(Object.values(LENT_ENV));
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(o.env ?? {}))
		if (!vmEnvDenied(k, v, secrets, lent)) env[k] = v;
	if (o.sessionName) env.OTTR_SESSION_NAME = o.sessionName;
	if (o.board && !o.stripBoard) {
		env.OTTR_BOARD_URL = o.boardUrl;
		env.OTTR_BOARD_TOKEN = o.token;
		env.OTTR_PROJECT = o.board.project;
		env.OTTR_TASK_ID = o.board.taskId;
	}
	if (o.layerEnv !== null) Object.assign(env, o.layerEnv);
	return env;
}

/**
 * Provider ids a microVM turn routes through the board's /llm proxy: the board store's active
 * sign-ins, the providers of the board's env API keys, and always the turn model's provider.
 * An unreadable store (null) still yields the env keys and the model's provider.
 */
export function vmProviders(
	model: string | null | undefined,
	stored: readonly { provider: string; active: boolean }[] | null,
	env: Record<string, string | undefined> = process.env,
): string[] {
	const out = new Set<string>();
	for (const s of stored ?? []) if (s.active) out.add(s.provider);
	if (env.ANTHROPIC_API_KEY) out.add("anthropic");
	if (env.OPENAI_API_KEY) out.add("openai");
	const slash = model?.indexOf("/") ?? -1;
	if (model && slash > 0) out.add(model.slice(0, slash));
	return [...out].sort();
}

/** The saved session's files (`<ts>_<id>.jsonl` and its artifact dir) a microVM resume needs. */
function sessionPaths(sessionDir: string, resumeId: string | null): string[] {
	if (resumeId === null) return [];
	try {
		return readdirSync(sessionDir)
			.filter(
				(n) => n.endsWith(`_${resumeId}.jsonl`) || n.endsWith(`_${resumeId}`),
			)
			.map((n) => join(sessionDir, n));
	} catch {
		return []; // no sessions dir yet: a fresh session
	}
}

/** The inputs startRun reads. */
interface StartOptions {
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
	/** Set: run the turn in a fresh microVM on vm-runner (docs/adr/0009-microvm-workers.md);
	 * wins over `worker`. The run issues the card's VM token at dispatch and revokes it when
	 * `done` settles. A busy vm-runner settles `workerBusy`, never a lost worker. */
	vm?: {
		target: WorkerTarget;
		tokens: VmTokens;
		grant: VmGrant;
		/** task.base: the ref or sha the branch forked from. */
		base: string;
		/** The board URL the VM reaches (OTTR_BOARD_URL). */
		boardUrl: string;
		/** Tests only; default vmProviders over the board store, env keys and the model. */
		providers?: string[];
		/** Tests only; default: the deployment's memory backend is hindsight. */
		hindsight?: boolean;
	} | null;
	/** Extra env merged into the child's base (a retro run's OTTR_RETRO=1). */
	env?: Record<string, string>;
	/** Values redacted from the log, stderr tail and provider error (the lent provider token). */
	secrets?: readonly string[];
	/** Set: strip the board coordinates from the child env (a retro run). */
	stripBoard?: boolean;
	/** The confirmed read-only GitHub token env for worker and microVM turns
	 * (docs/specs/turn-read-token.md); applied after every strip. A local run ignores it. */
	githubReadEnv?: Record<string, string>;
	/** Set: a local child runs without the board's GitHub token (GH_TOKEN, GITHUB_TOKEN), as a
	 * worker child always does. A run that reads third-party text (the trending scout) sets it. */
	stripGithubToken?: boolean;
	/** OTTR-693: the Settings commit identity for this turn; null keeps the built-in Ottr default (src/gitIdentity.ts). */
	commitIdentity?: CommitIdentity | null;
	/** Test seam: replaces the git config probe (src/gitIdentity.ts IdentProbeEnv). */
	gitProbe?: (o: IdentProbeEnv) => { name: boolean; email: boolean };
	/** Pinned tool list / extension config / skill, passed to buildOmpArgs (a retro run). */
	tools?: string | null;
	config?: string | null;
	skills?: string | null;
	/** Non-empty caps the run's duration (`--max-time`); a review check run sets it so a hung
	 * check cannot hold a board slot forever. */
	maxTime?: string | null;
	/** Memory overlay path; computed from the deployment env when omitted (null skips the overlay — tests only). */
	memoryConfigPath?: string | null;
	/** Test seam: the home the plugin-skills overlay reads (docs/specs/turn-home-plugin-skills.md);
	 * unset derives the run's pinned home (layerEnv.HOME, else the flat layer home). */
	pluginSkillsHome?: string;
	/** Hosted mode only: capture token usage for metering (createRunSink). */
	meter?: boolean;
	/** Post-run guard (docs/specs/turn-provision-guard.md): audits the shared home's provisioned
	 * agent layer against alate's manifest when a local run settles, so a turn that edited it
	 * settles with provisionDrift. Undefined skips the audit (tests); production passes it. */
	auditProvisioned?: (
		sinceMs: number,
		rulesAtStart?: readonly string[],
	) => readonly string[];
	/** Captured when a local run spawns, before omp starts: the rules dir entries the
	 * audit's untracked scan compares against, so only entries the run added are
	 * findings. Undefined keeps the scan off (tests); production passes it. */
	rulesAtStart?: () => readonly string[];
	/** Hosted mode only: interim usage of the active run (createRunSink). */
	onUsage?: (usage: TokenUsage, model: string | null) => void;
	/** Fired once per newly parsed propose_task finding (createRunSink); a review card's
	 * main run stores each finding at parse time. */
	onRecorded?: (finding: RecordedFinding) => void;
}

/** Shared state the local, worker and microVM dispatch paths read. */
interface RunStart {
	o: StartOptions;
	sink: RunSink;
	args: string[];
	memoryConfig: string | null;
	/** The plugin-skills overlay path; startRun always sets it (the project-skill pins ride on every run). */
	pluginSkillsConfig: string | null;
	startedAt: number;
	/** Shared-state overrides a pinned run carries on top of its dispatch's base env. */
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null;
	/** The layer dir the VM gets as layerDir (null when the run is unpinned). */
	layerDir: string | null;
	layerId: string | null;
	unregisterLayer: () => void;
	identityEnv: Record<string, string>;
}

/** The plugin-skills overlay for one run: the enabled plugins of the run's home
 * (docs/specs/turn-home-plugin-skills.md). A VM run scopes the overlay dir to the
 * project data dir, the only tree vm-runner copies in (resolveMemoryConfig). */
function pluginSkillsConfigFor(
	o: StartOptions,
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null,
	layerHome: string,
): string | null {
	const home = o.pluginSkillsHome ?? layerEnv?.HOME ?? layerHome;
	return ensurePluginSkillsOverlay(
		o.vm
			? { ...process.env, OTTR_DATA_DIR: dirname(o.sessionDir) }
			: process.env,
		home,
	);
}

/** Context a no-stderr death reports (classify folds it into the failure reason): how the
 * run was dispatched, how much it was asked to do, where, under which pid, for how long. */
function resolveMemoryConfig(o: StartOptions): string | null {
	if (o.memoryConfigPath !== undefined) return o.memoryConfigPath;
	if (o.vm)
		// vm-runner copies in only paths under /data/<project>/ (the dir holding the
		// sessions dir), so a VM turn's overlay lives there, not at the shared root.
		return ensureMemoryOverlay({
			...process.env,
			OTTR_DATA_DIR: dirname(o.sessionDir),
		});
	return ensureMemoryOverlay();
}

/** Pin the agent layer once per call, before any spawn: the env carries the resolved layer
 * directory, so a later atomic switch of `.alate/current` never touches a live run. Worker
 * runs resolve the shared home (alate provisions it), the board's own runs the board home. */
function resolveLayerPin(
	layerHome: string,
	sink: RunSink,
): {
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null;
	layerDir: string | null;
	layerId: string | null;
	unregisterLayer: () => void;
} {
	const pin = pinnedAgentLayer(layerHome);
	if (!pin.ok && pin.reason !== "none")
		sink.logMark(
			`! agent layer pin failed (${pin.reason}); running the flat home\n`,
		);
	let unregistered = false;
	const unregisterLayer = (): void => {
		if (!pin.ok || unregistered) return;
		unregistered = true;
		removeLayerUse(layerHome, pin.layer.id);
	};
	if (pin.ok) addLayerUse(layerHome, pin.layer.id);
	return {
		layerEnv: pin.ok
			? { HOME: pin.layer.dir, PI_CODING_AGENT_DIR: pin.agentDir }
			: null,
		layerDir: pin.ok ? pin.layer.dir : null,
		layerId: pin.ok ? pin.layer.id : null,
		unregisterLayer,
	};
}

/** OTTR-693: the ident env beats every git config scope, so the probe must mirror the
 * turn's git exactly: same worktree (repo-local config and includeIf rules count), same
 * HOME (the layer pin moves it), same GIT_CONFIG_GLOBAL. Worker dispatch strips the
 * pointer below: the worker mounts no board-config, so a pinned path would name a
 * missing file there and hide the shared home's ~/.gitconfig — the exact "no author
 * identity" failure this fixes. A VM guest owns its home and seeds the clone's own
 * config (src/vmGuest.ts; vmEnv drops the pointer too), so only an explicit Settings
 * identity rides the VM env, never the automatic default. */
function resolveIdentityEnv(
	o: StartOptions,
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null,
): Record<string, string> {
	const identBaseEnv = withoutGitAuth({ ...process.env, ...o.env });
	if (o.vm) {
		return o.commitIdentity != null
			? commitIdentityEnv(o.commitIdentity, { name: false, email: false })
			: {};
	}
	const identity = o.commitIdentity ?? {
		name: DEFAULT_COMMIT_NAME,
		email: DEFAULT_COMMIT_EMAIL,
	};
	const probe = (o.gitProbe ?? probeGitIdent)({
		cwd: o.cwd,
		home: layerEnv?.HOME ?? process.env.HOME ?? null,
		gitConfigGlobal:
			o.worker != null ? null : (identBaseEnv.GIT_CONFIG_GLOBAL ?? null),
		baseEnv: identBaseEnv,
	});
	return commitIdentityEnv(identity, probe);
}

/** The local dispatch: omp spawns on this host and streams its events into the sink. */
function startLocalRun(s: RunStart): RunHandle {
	const {
		o,
		sink,
		args,
		startedAt,
		layerEnv,
		identityEnv,
		layerId,
		unregisterLayer,
	} = s;
	// Every local child gets an explicit env so worker credentials never reach a turn (R3-6/D6).
	const launch: RunLauncher = o.launcher ?? spawn;
	// The provision guard's untracked scan compares against the rules dir as it
	// stood before omp started (docs/specs/turn-provision-guard.md).
	const rulesAtStart = o.rulesAtStart ? o.rulesAtStart() : undefined;
	const base = boardOmpEnv(
		withoutGitAuth({
			...process.env,
			...o.env,
			...(o.stripGithubToken
				? { GH_TOKEN: undefined, GITHUB_TOKEN: undefined }
				: {}),
		}),
	);
	if (layerEnv !== null) Object.assign(base, layerEnv);
	Object.assign(base, identityEnv);
	const child = launch("omp", args, {
		cwd: o.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: childEnv({
			sessionName: o.sessionName,
			board: o.board ?? null,
			// A run's extra env (OTTR_RETRO, OTTR_REVIEW) rides on top of the inherited base:
			// replacing it would strip PATH and the provider auth the child needs. HOME moves
			// to the board's own omp home (R5-1): omp reads plugins and user skills from it.
			base,
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
		unregisterLayer();
		// The provision guard fires after the run's writes are final; drift fails the
		// run through classify (docs/specs/turn-provision-guard.md).
		const drift = o.auditProvisioned?.(startedAt, rulesAtStart) ?? [];
		resolveDone(
			sink.result({
				exitCode: code,
				killed,
				stderrTail: sink.tail(),
				ranOn: `board (${hostname()})`,
				dispatch: `local, argv ${args.length}, cwd ${basename(o.cwd)}${child.pid !== undefined ? `, pid ${child.pid}` : ""}, ${Math.round((Date.now() - startedAt) / 1000)}s`,
				...(drift.length ? { provisionDrift: [...drift] } : {}),
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
		layerId,
	};
}

/** The microVM dispatch: vm-runner runs the turn in a fresh VM; busy and connect failures
 * settle as workerBusy / workerLost results instead of throwing. */
function startVmRun(
	s: RunStart,
	vm: NonNullable<StartOptions["vm"]>,
	token: string,
): RunHandle {
	const {
		o,
		sink,
		args,
		memoryConfig,
		startedAt,
		layerEnv,
		identityEnv,
		layerDir,
		layerId,
		unregisterLayer,
	} = s;
	let stored: { provider: string; active: boolean }[] | null = null;
	if (vm.providers === undefined)
		try {
			stored = signIns(join(agentDir(), "agent.db"));
		} catch (err) {
			// An unreadable store still routes the turn model's provider and the env keys.
			sink.logMark(
				`! microVM: cannot read the board's sign-ins (${err instanceof Error ? err.message : err})\n`,
			);
		}
	const spec: VmSpec = {
		project: vm.grant.project,
		taskId: vm.grant.taskId,
		branch: vm.grant.branch,
		base: vm.base,
		boardUrl: vm.boardUrl,
		token,
		providers: vm.providers ?? vmProviders(o.model, stored),
		hindsight:
			vm.hindsight ?? memoryBackendFromEnv(process.env).backend === "hindsight",
		layerDir,
		copyIn: [
			...sessionPaths(o.sessionDir, o.resumeId),
			...(o.images ?? []),
			...(memoryConfig ? [memoryConfig] : []),
		],
		copyOut: [o.sessionDir],
	};
	const vmHandle = runWorker(
		{
			id: crypto.randomUUID(),
			argv: args,
			cwd: o.cwd,
			stdin: o.prompt,
			env: vmEnv({
				env: { ...o.env, ...identityEnv },
				secrets: o.secrets,
				sessionName: o.sessionName,
				board: o.board ?? null,
				stripBoard: o.stripBoard,
				boardUrl: vm.boardUrl,
				token,
				layerEnv,
			}),
			// Not merged into env here: the vm-runner merges it after its guestEnv strip.
			githubReadEnv: o.githubReadEnv,
			vm: spec,
		},
		vm.target,
		sink,
	);
	const vmDispatch = (): string =>
		`vm ${vmHandle.url}, argv ${args.length}, cwd ${basename(o.cwd)}, ${Math.round((Date.now() - startedAt) / 1000)}s`;
	const settle = (): void => {
		unregisterLayer();
		// The run is over (any outcome): the VM must not push or reach /llm any more. A
		// board restart never gets here, so a detached run keeps its token for the re-bind.
		vm.tokens.revoke(token);
	};
	return {
		pid: null,
		url: vmHandle.url,
		done: vmHandle.done
			.then((r) => {
				settle();
				return { ...r, dispatch: vmDispatch() };
			})
			.catch((err) => {
				settle();
				if (err instanceof WorkerBusyError) {
					// Nothing ran: runTurn puts the card back to queued as it was.
					sink.logMark(`- ${WORKER_BUSY}: ${err.message}\n`);
					return sink.result({
						exitCode: null,
						killed: false,
						stderrTail: sink.tail(),
						workerBusy: true,
						dispatch: vmDispatch(),
					});
				}
				if (!(err instanceof WorkerConnectError)) throw err;
				// Same fail-closed rule as a classic worker: never the classic pool, never
				// the server. Classify requeues a lost VM once, then parks it.
				sink.logMark(`! microVM dispatch failed: ${err.message}\n`);
				return sink.result({
					exitCode: null,
					killed: false,
					stderrTail: `${sink.tail()}\nworker dispatch failed: ${err.message}`,
					workerLost: true,
					dispatch: vmDispatch(),
				});
			}),
		kill: async () => vmHandle.kill(),
		accepted: vmHandle.accepted,
		layerId,
	};
}

/** The classic worker dispatch: the worker container runs omp; a connect failure settles as
 * a lost worker, never a local fallback. */
function startWorkerRun(s: RunStart, worker: WorkerTarget): RunHandle {
	const {
		o,
		sink,
		args,
		memoryConfig,
		pluginSkillsConfig,
		startedAt,
		layerEnv,
		identityEnv,
		layerId,
		unregisterLayer,
	} = s;
	// The worker runs omp itself; the tracker env is forwarded so a pinned session
	// name and the board coordinates still reach the extension, but the worker's own
	// credentials do not (childEnv strips them), and neither does the board's GitHub
	// token: work turns only commit locally, push credentials never leave the server (D6).
	// serveWorker also strips every git host token from the worker container's own env.
	// The board's pinned PI_CODING_AGENT_DIR and OTTR_BOARD_OMP_HOME stay out (R5-1): a turn
	// that ran the board's own agent dir or home could rewrite the config, skills and plugins
	// the board's privileged turns execute, and a worker without its own shared store would
	// find no credentials. When the shared home holds an agent layer, the pin replaces the
	// strip only with layer paths inside the shared home (HOME moves to the resolved layer,
	// PI_CODING_AGENT_DIR to its agent dir); the board's private pins stay stripped.
	const workerBase = withoutGitAuth({
		...process.env,
		...o.env,
		GH_TOKEN: undefined,
		GITHUB_TOKEN: undefined,
		GH_ENTERPRISE_TOKEN: undefined,
		GITHUB_ENTERPRISE_TOKEN: undefined,
		PI_CODING_AGENT_DIR: undefined,
		OTTR_BOARD_OMP_HOME: undefined,
	});
	// OTTR-693: the worker mounts no board-config, so the board's GIT_CONFIG_GLOBAL
	// pointer would name a missing file there; git would then skip the global scope
	// entirely and never read the shared home's ~/.gitconfig (the CMIS-1 "no author
	// identity" failure). The probe above strips the pointer for the same reason.
	delete workerBase.GIT_CONFIG_GLOBAL;
	if (layerEnv !== null) Object.assign(workerBase, layerEnv);
	Object.assign(workerBase, identityEnv);
	const env = childEnv({
		sessionName: o.sessionName,
		board: o.board ?? null,
		base: workerBase,
		stripBoard: o.stripBoard,
	});
	// One id for the request and the handle: the worker's GET /stats reports usage by it.
	const runId = crypto.randomUUID();
	const workerHandle = runWorker(
		{
			id: runId,
			argv: buildOmpArgs({ ...o, memoryConfig, pluginSkillsConfig }),
			cwd: o.cwd,
			stdin: o.prompt,
			env,
			githubReadEnv: o.githubReadEnv,
		},
		worker,
		sink,
	);
	const dispatch = (): string =>
		`worker ${workerHandle.url}, argv ${args.length}, cwd ${basename(o.cwd)}, ${Math.round((Date.now() - startedAt) / 1000)}s`;
	return {
		// pid is null while omp lives in the worker container's namespace; sweepLostTurns
		// treats an open pid-null row without a live entry as lost after a tracker restart.
		pid: null,
		// OTTR-454: the turn engine buckets live runs by this url for GET /api/drain.
		url: workerHandle.url,
		runId,
		done: workerHandle.done
			// The worker's own pid is in its container namespace; only the wall duration is local.
			.then((r) => {
				unregisterLayer();
				return { ...r, dispatch: dispatch() };
			})
			.catch((err) => {
				unregisterLayer();
				if (!(err instanceof WorkerConnectError)) throw err;
				// Fail closed: never run a worker turn in the server, which mounts server-only
				// volumes (board config, tracker state, tokens, ssh keys). Settle as a lost worker:
				// classify requeues it once for a worker, then parks it for a human.
				sink.logMark(`! worker dispatch failed: ${err.message}\n`);
				return sink.result({
					exitCode: null,
					killed: false,
					stderrTail: `${sink.tail()}\nworker dispatch failed: ${err.message}`,
					workerLost: true,
					dispatch: dispatch(),
				});
			}),
		kill: async () => workerHandle.kill(),
		layerId,
	};
}

export function startRun(o: StartOptions): RunHandle {
	// Issued before the sink exists so the log redacts the raw token like any other secret.
	// The grant carries the spec's base so the git endpoint keeps that ref fetchable.
	const vmToken = o.vm
		? o.vm.tokens.issue({ ...o.vm.grant, base: o.vm.base })
		: null;
	const sink = createRunSink({
		logPath: o.logPath,
		dataRoot: o.dataRoot,
		onLog: o.onLog,
		onSession: o.onSession,
		onProgress: o.onProgress,
		secrets: vmToken === null ? o.secrets : [...(o.secrets ?? []), vmToken],
		meter: o.meter,
		onUsage: o.onUsage,
		onRecorded: o.onRecorded,
	});
	const startedAt = Date.now();
	// Pin the agent layer once per call, before any spawn: the env carries the resolved layer
	// directory, so a later atomic switch of `.alate/current` never touches a live run. Worker
	// runs resolve the shared home (alate provisions it), the board's own runs the board home.
	const layerHome = o.worker || o.vm ? homedir() : boardOmpHome();
	const layerPin = resolveLayerPin(layerHome, sink);
	const memoryConfig = resolveMemoryConfig(o);
	// The plugin-skills overlay reads the run's pinned home, so a layer run gets its own
	// layer's plugins (docs/specs/turn-home-plugin-skills.md).
	const pluginSkillsConfig = pluginSkillsConfigFor(
		o,
		layerPin.layerEnv,
		layerHome,
	);
	const args = buildOmpArgs({ ...o, memoryConfig, pluginSkillsConfig });
	const identityEnv = resolveIdentityEnv(o, layerPin.layerEnv);
	const s: RunStart = {
		o,
		sink,
		args,
		memoryConfig,
		pluginSkillsConfig,
		startedAt,
		...layerPin,
		identityEnv,
	};
	if (o.vm && vmToken !== null) return startVmRun(s, o.vm, vmToken);
	if (!o.worker) return startLocalRun(s);
	return startWorkerRun(s, o.worker);
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

/** The microVM runner from the tracker env (OTTR_VM_RUNNER_URL, one url); null when unset. */
export function vmRunnerFromEnv(
	env: Record<string, string | undefined> = process.env,
): WorkerTarget | null {
	const url = env.OTTR_VM_RUNNER_URL?.trim().replace(/\/+$/, "");
	if (!url) return null;
	// Same fail-closed rule as the worker pool: vm-runner speaks the worker protocol.
	const token = env.OTTR_WORKER_TOKEN;
	if (!token)
		throw new Error(
			"OTTR_VM_RUNNER_URL is set but OTTR_WORKER_TOKEN is unset; the microVM runner requires a token",
		);
	return { urls: [url], token };
}
