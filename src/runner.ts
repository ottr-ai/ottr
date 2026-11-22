import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { aptListPath } from "./apt.ts";
import { prepareTurnCache, serverTurnCacheRoot } from "./cachesweep.ts";
import { stripServerChildEnv } from "./childEnv.ts";
import { mkdirBelow, touchBelow, writeBelow } from "./confine.ts";
import { devNullGuard } from "./devNullGuard.ts";
import { errmsg } from "./errmsg.ts";
import {
	type CommitIdentity,
	commitIdentityEnv,
	DEFAULT_COMMIT_EMAIL,
	DEFAULT_COMMIT_NAME,
	type IdentProbeEnv,
	probeGitIdent,
} from "./gitIdentity.ts";
import { stripRepoRelocatingEnv } from "./gitRepoEnv.ts";
import type { TokenUsage } from "./hosted.ts";
import {
	acquireLayerUse,
	pinnedAgentLayer,
	resolveAgentLayer,
} from "./layers.ts";
import {
	agentDir,
	boardOmpEnv,
	boardOmpHome,
	LENT_ENV,
	signIns,
	turnListHome,
} from "./login.ts";
import {
	ensureMemoryOverlay,
	memoryBackendFromEnv,
	memoryTurnEnv,
} from "./memory.ts";
import { platform } from "./platform/index.ts";
import { ensurePluginSkillsOverlay } from "./pluginSkills.ts";
import { LOST_SESSION } from "./prompts.ts";
import { requirementsListPath } from "./python.ts";
import { PROGRESS_EVENT, watchProgress } from "./stryker.ts";
import { formatBytes } from "./tmpsweep.ts";
import { CARD_ENV_NOTE_NAME } from "./tokens.ts";
import { toolsListPath } from "./tools.ts";
import { projectTrustedLists } from "./trustedLists.ts";
import { STORE_MOUNT_BLOCKED } from "./turnUid.ts";
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
import { memoryGrant, type VmGrant, type VmTokens } from "./vmTokens.ts";
import type { VmSpec, WorkerRequest, WorkerTarget } from "./workers.ts";
import {
	feedCappedLines,
	flushCappedLines,
	type LineCapState,
	lineDropNotice,
	runWorker,
	WorkerBusyError,
	WorkerConnectError,
} from "./workers.ts";
import {
	GIT_AUTH_ENV_NAME,
	GIT_GC_PINS,
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
	/** OTTR-1197: this run's own sandbox credential; the board's run-token store issued it at dispatch, bound to project and taskId. */
	runToken?: string | null;
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
	// The per-name reasons for this strip live in childEnv.ts.
	stripServerChildEnv(env);
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
		if (o.board.runToken) env.OTTR_RUN_TOKEN = o.board.runToken;
	}
	// After the board block: stripBoard must win even when a board object is passed.
	if (o.stripBoard) {
		delete env.OTTR_BOARD_URL;
		delete env.OTTR_BOARD_TOKEN;
		delete env.OTTR_PROJECT;
		delete env.OTTR_TASK_ID;
		delete env.OTTR_RUN_TOKEN;
	}
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	return env;
}

/** Keep the server database URL out of the secondary worker environment too. */
function withoutDatabaseUrl(
	env: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!env || !Object.hasOwn(env, "OTTR_DATABASE_URL")) return env;
	const clean = { ...env };
	delete clean.OTTR_DATABASE_URL;
	return clean;
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

/**
 * Overlay that turns off the read tool's URL fetch (OTTR-982): the board's own runs read
 * worker-written content inside the server container, next to the board's zero-auth
 * loopback API, so an injected URL read must not pass the auth wall. startLocalRun
 * appends it; worker and VM runs keep URL reads.
 */
export const NO_FETCH_CONFIG = resolve(
	import.meta.dir,
	"..",
	"extension",
	"no-fetch.yml",
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
	/** Server-only read guard overlay (src/checkGuard.ts, OTTR-985); null/omitted omits the pair (tests pin exact argv without it). Board-side check runs always carry it. */
	guardConfig?: string | null;
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
		// The server-only read guard (OTTR-985) rides right after the run's own overlay; the
		// later no-discovery/memory overlays touch other keys, so this cannot be overridden.
		...(o.guardConfig ? ["--config", o.guardConfig] : []),
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
		.map((q) => {
			// A text question has no options: the user types a single-line answer.
			const bullets = q.text
				? "    • <type your answer>"
				: q.options
						.map(
							(o) =>
								`    • ${o.label}${o.description ? ` — ${o.description}` : ""}`,
						)
						.join("\n");
			return `  ? ${q.question}\n${bullets}`;
		})
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

/** The worker refused to start the turn: the shared omp store is a bind mount whose mode blocks
 * the turn uid (OTTR-1291). No retry can fix a host file mode; the operator fixes it. */
const storeMountRule: ClassifyRule = (o, stage) => {
	if (!o.result.stderrTail.includes(STORE_MOUNT_BLOCKED)) return null;
	const file = /cannot open: (\S+)/.exec(o.result.stderrTail)?.[1];
	return needsAt(
		stage,
		`The worker refused to start the turn: ${STORE_MOUNT_BLOCKED}${file ? ` (${file})` : ""}. Fix the store's mode on the host: chmod a+rw on the store file and a+rwx on its folder, then reply.`,
	);
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

/** A work turn's answered report: an integrated head settles done (the tip is on the target),
 * no commits settle done, an integrable branch still merges (never research), the rest is a
 * refusal. */
function workAnsweredNext(
	o: ClassifyInput,
	stage: Next["stage"],
	git: GitFacts,
): Next {
	// Every branch commit is already on the target (VELVET-124: a research card moved its
	// branch to main, 47 commits ahead were all merged): nothing is left to integrate.
	if (git.integrated)
		return { stage: "done", state: "idle", needsReason: null };
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
	// Only a merge turn closes as superseded: a work turn re-reports ready and the
	// normal merge turn decides (the rejection rides the resumed turn's prompt).
	if (oc.status === "superseded")
		return needsAt(
			stage,
			"Work turns do not close as superseded; report ready.",
		);
	return null;
};

const mergeOutcomeRule: ClassifyRule = (o, stage) => {
	if (o.kind === "work") return null;
	const oc = o.result.outcome;
	if (oc === null) return null;
	if (oc.status === "ready" || oc.status === "answered")
		return needsAt(stage, `Unexpected outcome "${oc.status}" in a merge turn.`);
	// OTTR-1182: a merge turn whose branch main already superseded closes done, but
	// only with the follow-up card id it filed for the gap. The settle verifies the
	// link and the target's push state before the cleanup runs (verifySupersededClose);
	// an unproven report parks with the worktree intact.
	if (oc.status === "superseded")
		return oc.followUp !== undefined && oc.followUp.trim() !== ""
			? { stage: "done", state: "idle", needsReason: null }
			: needsAt(
					stage,
					"Reported superseded, but the report carries no follow-up card id. File the gap card with create_task, then reply and pass its id in followUp.",
				);
	return null;
};

/** First matching rule wins. */
const CLASSIFY_RULES: ClassifyRule[] = [
	provisionRule,
	killedRule,
	backgroundWaitRule,
	storeMountRule,
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
				o.dependsOn.every((d: unknown) => typeof d === "string"))) &&
		(o.prBody === undefined || typeof o.prBody === "string") &&
		(o.followUp === undefined || typeof o.followUp === "string")
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
			decision?: string;
		} | null;
		/** The question the user must answer first; null when none. Kept apart from the
		 *  summary, so a decision holds the card even when a summary field is missing. */
		decision?: string | null;
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
	const part = (key: string): string | null => capped(args[key]);
	const whatChanges = part("whatChanges");
	const why = part("why");
	const gain = part("gain");
	const check = part("check");
	if (whatChanges === null || why === null || gain === null || check === null)
		return null;
	// Summary policy: whatChanges/why/gain/check are required, risk optional and defaults
	// to "none found"; each field is capped at 400 characters (slice to 399 + "…").
	const decision = part("decision");
	const summary = {
		whatChanges,
		why,
		gain,
		risk: part("risk") ?? "none found",
		check,
	};
	return decision === null ? summary : { ...summary, decision };
}

/** A trimmed, non-empty tool string capped at 400 characters (399 + "…"); null otherwise. */
function capped(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const value = v.trim();
	if (value === "") return null;
	return value.length > 400 ? `${value.slice(0, 399)}…` : value;
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
	if (state.proposed === null) {
		const decision = capped(args.decision);
		state.proposed = {
			prompt: call.prompt,
			model: call.model,
			summary: proposedSummary(args),
			...(decision === null ? {} : { decision }),
			project:
				typeof args.project === "string" && args.project.trim() !== ""
					? args.project.trim()
					: null,
		};
	}
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

export interface RunHandle {
	pid: number | null;
	/** OTTR-1211: local runs only: when this host spawned the child. The server's /tmp
	 * sweep keeps a live local run's scratch (start at or before the newest mtime);
	 * worker-dispatched and microVM handles omit it (their scratch is not on this host). */
	startedAt?: number;
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
	/** Wait for all session, finding, and usage callbacks, then surface persistence errors. */
	drain(): Promise<void>;
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
		onSession?: (sessionId: string) => void | Promise<void>;
		/** A progress event (stryker.ts): never logged; null text clears the card's progress. */
		onProgress?: (text: string | null) => void;
		/** Hosted metering on: sum assistant usage into state.usage; off leaves it null. */
		meter?: boolean;
		/** Hosted mode only (needs `meter`): interim usage of the active run. */
		onUsage?: (usage: TokenUsage, model: string | null) => void;
		/** Fired once per newly parsed propose_task finding, in arrival order. */
		onRecorded?: (finding: RecordedFinding) => void | Promise<void>;
	},
	es: EventState,
	log: { write(text: string): void },
	notify: (callback: () => void | Promise<void>) => void,
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
	if (sessionStarted !== undefined && o.onSession)
		notify(() => o.onSession!(sessionStarted));
	for (let i = recordedBefore; i < es.recorded.length; i++) {
		const finding = es.recorded[i]!;
		if (o.onRecorded) notify(() => o.onRecorded!(finding));
	}
	if (es.usage !== null && !sameUsage(before, es.usage) && o.onUsage) {
		const usage = { ...es.usage };
		const model = es.model;
		notify(() => o.onUsage!(usage, model));
	}
}

export function createRunSink(o: {
	logPath: string;
	/** Anchor for the log write (src/confine.ts). */
	dataRoot: string;
	onLog?: () => void;
	onSession?: (sessionId: string) => void | Promise<void>;
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
	onRecorded?: (finding: RecordedFinding) => void | Promise<void>;
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

	let pending: Promise<void> | null = null;
	let failed = false;
	let failure: unknown;
	const recordFailure = (error: unknown): void => {
		if (!failed) {
			failed = true;
			failure = error;
		}
	};
	const notify = (callback: () => void | Promise<void>): void => {
		const invoke = (): void | Promise<void> => {
			try {
				return callback();
			} catch (error) {
				recordFailure(error);
			}
		};
		if (pending !== null) {
			pending = pending.then(invoke).catch(recordFailure);
		} else {
			const result = invoke();
			if (result !== undefined && typeof result.then === "function")
				pending = result.catch(recordFailure);
		}
	};
	const drain = async (): Promise<void> => {
		let current: Promise<void> | null;
		do {
			current = pending;
			await current;
		} while (current !== pending);
		if (failed) throw failure;
	};
	const handleLine = (raw: string): void =>
		handleEventLine(raw, o, es, log, notify);

	const stdoutCap: LineCapState = { partial: "", dropping: false };
	const stderrCap: LineCapState = { partial: "", dropping: false };
	return {
		state: es,
		drain,
		line: handleLine,
		stdout: (text) => {
			// A drop notice is plain text, so handleEventLine logs it on the same
			// JSON-parse-failure path any non-JSON line takes.
			feedCappedLines(stdoutCap, text, handleLine, () =>
				handleLine(lineDropNotice()),
			);
		},
		stderr: (text) => {
			stderrTail = `${stderrTail}${text}`.replace(/\r\n/g, "\n").slice(-4000);
			// Whole lines only: a chunk boundary inside a line must not split a token with "! ".
			feedCappedLines(
				stderrCap,
				text,
				(l) => {
					const t = l.replace(/\r$/, "");
					if (t.trim()) log.write(`! ${t}\n`);
				},
				() => log.write(`! ${lineDropNotice()}\n`),
			);
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
			flushCappedLines(stdoutCap, handleLine);
			flushCappedLines(stderrCap, (l) =>
				log.write(`! ${l.replace(/\r$/, "")}\n`),
			);
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
 * startRun drops it from the forwarded env, and serveWorker strips it from its own env.
 * Exported for the repo-relocating-env strip test (OTTR-1162). */
export function withoutGitAuth(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out = { ...env };
	for (const k of Object.keys(out))
		if (GIT_AUTH_ENV_NAME.test(k)) delete out[k];
	// OTTR-1162: a session env carrying GIT_DIR (for example a process launched from a git
	// hook) redirects a turn's test run into the foreign gitdir — the drill on this card made
	// fixture writes land in the enclosing repository this way, and the stray board-repo
	// writes of 2026-11-20 matched that shape. A turn's git names its repos with path
	// arguments; the ambient repo-relocating vars never help and only redirect. Guests strip
	// the same set (vmGuest toolEnv).
	stripRepoRelocatingEnv(out);
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
 * the guest mounts no file for (OTTR-693), and OTTR_ names outside the turn flags and the
 * card-env note (OTTR-1099). */
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
	if (
		k.startsWith("OTTR_") &&
		!/^OTTR_(RETRO|REVIEW|TRENDING|TEST_PG_URL|REQUIRE_PG_TESTS)$/.test(k) &&
		k !== CARD_ENV_NOTE_NAME
	)
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
	delete env.OTTR_DATABASE_URL;
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
	/** The run's project name (OTTR-994): rides the worker request even when
	 * `stripBoard` removes OTTR_PROJECT from the env, so retro and proposal
	 * runs keep their per-project turn identity on the worker. */
	project?: string | null;
	logPath: string;
	/** Anchor for the log write (src/confine.ts). */
	dataRoot: string;
	/** Called after every append to the log file; the server turns it into a throttled `log` push. */
	onLog?: () => void;
	onSession?: (sessionId: string) => void | Promise<void>;
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
		/** Board-written card files (e.g. the code scanning alert list) written into the guest's fresh clone after the clone and before omp starts; every path sits inside the run's cwd. Rides the spec to the guest. The /run validation caps the list at 4 entries of at most 1 MB each. */
		cloneFiles?: { path: string; text: string }[];
	} | null;
	/** The board's per-run token store (OTTR-1006, docs/specs/hindsight-bank-binding.md).
	 *  Set on every production dispatch: a classic worker or local run whose project is
	 *  known and whose deployment backend is hindsight gets a short-lived memory token
	 *  that opens only its own project's bank through the board's /hindsight proxy.
	 *  Unset (tests) or a VM dispatch (the VM token already binds memory) keeps the
	 *  HINDSIGHT_* strip that childEnv and vmEnv apply. */
	memoryTokens?: VmTokens | null;
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
	 * worker child always does. A run that reads third-party or worker-written text (the
	 * trending scout, the work and review checks) sets it. */
	stripGithubToken?: boolean;
	/** OTTR-693: the Settings commit identity for this turn; null keeps the built-in Ottr default (src/gitIdentity.ts). */
	commitIdentity?: CommitIdentity | null;
	/** Test seam: replaces the git config probe (src/gitIdentity.ts IdentProbeEnv). */
	gitProbe?: (o: IdentProbeEnv) => Promise<{ name: boolean; email: boolean }>;
	/** Pinned tool list / extension config / skill, passed to buildOmpArgs (a retro run). */
	tools?: string | null;
	config?: string | null;
	/** Server-only read guard overlay path (src/checkGuard.ts); the check runs pass it, other runs leave it unset. */
	guardConfig?: string | null;
	skills?: string | null;
	/** Non-empty caps the run's duration (`--max-time`); a review check run sets it so a hung
	 * check cannot hold a board slot forever. */
	maxTime?: string | null;
	/** Memory overlay path; computed from the deployment env when omitted (null skips the overlay — check runs and tests). */
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
	onRecorded?: (finding: RecordedFinding) => void | Promise<void>;
}

/** Shared state the local, worker and microVM dispatch paths read. */
interface RunStart {
	o: StartOptions;
	sink: RunSink;
	args: string[];
	memoryConfig: string | null;
	/** The run's per-run memory binding: the env object carries the proxy URL, the raw
	 *  token, the project bank id and the scoping pin (docs/specs/hindsight-bank-binding.md).
	 *  The dispatcher Object.assigns it after every strip; settle revokes the token. Null
	 *  on a VM dispatch (the VM token binds memory), a mnemopi deployment and project-less
	 *  runs. */
	memoryEnv: { token: string; env: Record<string, string> } | null;
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
 * (docs/specs/turn-home-plugin-skills.md). The overlay dir follows the dispatch: a
 * board-side run writes the server-only state dir (a worker could otherwise
 * rename-over the file between the board's write and omp's read), a worker run the
 * shared data dir and a VM run the project data dir — the only trees the spawned omp
 * reads the path in. The per-project scoping takes the same value that becomes the
 * spawn's `OTTR_PROJECT` (o.board.project; a stripBoard run carries none). */
function pluginSkillsConfigFor(
	o: StartOptions,
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null,
	layerHome: string,
): string | null {
	const home = o.pluginSkillsHome ?? layerEnv?.HOME ?? layerHome;
	const project = o.board && !o.stripBoard ? o.board.project : null;
	return ensurePluginSkillsOverlay(
		process.env,
		home,
		project,
		o.vm
			? { kind: "vm", sessionDir: o.sessionDir }
			: o.worker
				? { kind: "worker" }
				: { kind: "board" },
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

type RunLayerPin = Pick<
	RunStart,
	"layerEnv" | "layerDir" | "layerId" | "unregisterLayer"
>;

/** Pin the agent layer once per call, before any spawn: the env carries the resolved layer
 * directory, so a later atomic switch of `.alate/current` never touches a live run. Worker
 * runs resolve the shared home (alate provisions it), the board's own runs the board home. */
function resolveLayerPin(layerHome: string, sink: RunSink): RunLayerPin {
	const pin = pinnedAgentLayer(layerHome);
	if (!pin.ok && pin.reason !== "none")
		sink.logMark(
			`! agent layer pin failed (${pin.reason}); running the flat home\n`,
		);
	// OTTR-1132: the lease belongs to this run alone; its release drops only this holder.
	// An acquisition failure throws here, before any spawn reads an unprotected layer.
	const release = pin.ok ? acquireLayerUse(layerHome, pin.layer.id) : null;
	const unregisterLayer = (): void => {
		if (release === null) return;
		// Settlement paths must not throw: a failed release keeps the lease (protection
		// stays on) and is reported in the run log.
		try {
			release();
		} catch (err) {
			sink.logMark(
				`! agent layer lease release failed (${err instanceof Error ? err.message : err})\n`,
			);
		}
	};
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
async function resolveIdentityEnv(
	o: StartOptions,
	layerEnv: { HOME: string; PI_CODING_AGENT_DIR: string } | null,
): Promise<Record<string, string>> {
	const identBaseEnv = withoutGitAuth({ ...process.env, ...o.env });
	delete identBaseEnv.OTTR_DATABASE_URL;
	if (o.vm) {
		return o.commitIdentity != null
			? commitIdentityEnv(o.commitIdentity, { name: false, email: false })
			: {};
	}
	const identity = o.commitIdentity ?? {
		name: DEFAULT_COMMIT_NAME,
		email: DEFAULT_COMMIT_EMAIL,
	};
	const probe = await (o.gitProbe ?? probeGitIdent)({
		cwd: o.cwd,
		home: layerEnv?.HOME ?? process.env.HOME ?? null,
		gitConfigGlobal:
			o.worker != null ? null : (identBaseEnv.GIT_CONFIG_GLOBAL ?? null),
		baseEnv: identBaseEnv,
	});
	return commitIdentityEnv(identity, probe);
}

/**
 * OTTR-990: the run-cwd directories the pinned omp line (18.15.0) scans for project
 * custom tools. omp imports every `.ts`/`.js` module it finds there at session start,
 * before any model call, and no CLI flag or config key turns that off (`--no-extensions`,
 * `--no-lsp` and the no-discovery overlay cover extensions, plugin code, LSP and project
 * MCP only; validation #OTTR-1089 planted `.omp/tools/x.ts` and its top-level code ran in
 * the server process). The plugin dirs matter because a project plugin registry
 * (`.omp/plugins/installed_plugins.json`, the `.claude` analog) adds its plugins' own
 * `tools/` dirs; the foreign dirs come from omp's `claude`/`codex` discovery providers.
 * A work turn plants these dirs in its worktree and commits them, and every board-side
 * run uses that worktree as its cwd, so a local run parks them out of omp's sight.
 */
const CUSTOM_TOOL_DIRS = [
	".omp/tools",
	".omp/plugins",
	".claude/tools",
	".claude/plugins",
	".codex/tools",
] as const;

/** Park suffix. omp's discovery scans the exact dir names `tools` and `plugins` inside
 * each config dir, so the suffixed sibling stays invisible for the run. A crash leftover
 * keeps the content on disk under this name; the next run heals it (restores, then parks
 * it again), so committed content never stays parked. */
const PARK_SUFFIX = ".ottr-boardrun";

/** One parked dir: its discovery path in the run cwd and where it sits until settle. */
interface ParkedDir {
	from: string;
	to: string;
}

/** Park target for `abs`: the stable sibling when free, else numbered siblings when a
 * crash left both the original and the stable park behind. Throws when 63 numbered
 * siblings are taken too: that is fail-closed, the same as every park error below. */
function parkTarget(abs: string): string {
	if (!lstatQuiet(`${abs}${PARK_SUFFIX}`)) return `${abs}${PARK_SUFFIX}`;
	for (let n = 2; n < 64; n++) {
		const candidate = `${abs}${PARK_SUFFIX}-${n}`;
		if (!lstatQuiet(candidate)) return candidate;
	}
	throw new Error(
		`custom-tool park failed for ${basename(abs)}: no free park target`,
	);
}

/** Whether `abs` exists as any entry (a dangling symlink counts): the park moves links
 * like files, so the run's cwd keeps its exact shape across the park. */
function lstatQuiet(abs: string): boolean {
	try {
		lstatSync(abs);
		return true;
	} catch {
		return false;
	}
}

/** Parks every custom-tool source dir in the run cwd out of omp's sight, appending each
 * pair to the caller-owned `parked` (so a throw still leaves every parked dir restorable)
 * and returning it. Renames stay inside the parent dir, so the worktree keeps its content
 * and git only sees the moves while the park holds. Absent dirs are skipped. Fail-closed:
 * an unexpected rename error throws before the spawn, so a run never starts on a cwd
 * whose park is incomplete. */
function parkCustomToolDirs(cwd: string, parked: ParkedDir[]): ParkedDir[] {
	for (const rel of CUSTOM_TOOL_DIRS) {
		const from = join(cwd, rel);
		if (!lstatQuiet(from)) {
			// Nothing to park here — but heal a crash leftover parked at the stable
			// sibling, so committed content never stays parked after a tracker crash.
			const stable = `${from}${PARK_SUFFIX}`;
			if (!lstatQuiet(stable)) continue;
			try {
				renameSync(stable, from);
			} catch (err) {
				throw new Error(
					`custom-tool park heal failed for ${rel}: ${errmsg(err)}`,
				);
			}
		}
		const to = parkTarget(from);
		try {
			renameSync(from, to);
		} catch (err) {
			throw new Error(`custom-tool park failed for ${rel}: ${errmsg(err)}`);
		}
		parked.push({ from, to });
	}
	return parked;
}

/** Restores the parked custom-tool dirs. A failed rename is logged, not thrown: the run
 * already happened, and its result must not turn into a failure by a restore error. The
 * parked content stays on disk at `to`; the next run's heal or the card's untracked
 * quarantine picks it up, and this line names the pair for that cleanup. */
function restoreParkedToolDirs(parked: ParkedDir[], sink: RunSink): void {
	for (const { from, to } of parked.reverse()) {
		try {
			renameSync(to, from);
		} catch (err) {
			sink.line(
				`! custom-tool park restore failed for ${from}: ${errmsg(err)} — content stays at ${to}`,
			);
		}
	}
}

/**
 * Appends the board's gc/maintenance pins as command-scope env config (GIT_CONFIG_COUNT
 * and friends), after any pairs the base already carries. A local run is a root session
 * (merge, release, review turns in the server container) whose own git runs without the
 * board's -c pins: auto gc or maintenance there deletes a worktree admin entry through a
 * symlink a worker turn planted in its project's .git (GIT_GC_PINS), unlinking the link's
 * target as root — in the incident shape, /dev/null itself. Command scope outranks planted
 * repo and global config, so no planted config re-enables either key.
 */
export function appendGitPins(env: Record<string, string | undefined>): void {
	const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
	const at = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
	GIT_GC_PINS.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${at + i}`] = k;
		env[`GIT_CONFIG_VALUE_${at + i}`] = v;
	});
	env.GIT_CONFIG_COUNT = String(at + GIT_GC_PINS.length);
}

/** The local dispatch: omp spawns on this host and streams its events into the sink. */
function startLocalRun(s: RunStart): RunHandle {
	const {
		o,
		sink,
		startedAt,
		layerEnv,
		identityEnv,
		layerId,
		unregisterLayer,
	} = s;
	// The board's own runs (checks, merge turns, retro, the board check; also work turns
	// on a worker-less board) read worker-written content and sit next to the server's
	// zero-auth loopback API, so the read tool must not fetch URLs (OTTR-982): an
	// injected read of a loopback /api URL would otherwise pass the auth wall. The key
	// names no other overlay's key, so the position after the memory overlay cannot clash.
	const args = [...s.args, "--config", NO_FETCH_CONFIG];
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
	// OTTR-1211: the per-project cache (every card of the project shares it, two
	// projects never do), on the server's own cache root — a worker-less server runs
	// its turns here. Same layout and best-effort rule as the worker turn homes.
	const serverCache = prepareTurnCache(
		serverTurnCacheRoot(),
		o.project ?? o.board?.project ?? undefined,
		null,
	);
	if (serverCache !== null) Object.assign(base, serverCache.cacheEnv);
	// OTTR-1211: the run's private scratch: TMPDIR points into a per-run dir, so the
	// card's temp (pip and bun caches, tool temp) dies with the run instead of aging
	// out a day later. OTTR_TMP_ROOT names the host temp root for files that must stay
	// host-global under the redirected TMPDIR — the mutation lock reads it
	// (scripts/stryker-base.mjs), and this process's own tmpdir() is that root.
	const scratch = mkdtempSync(join(tmpdir(), "ottr-run-"));
	base.TMPDIR = scratch;
	base.OTTR_TMP_ROOT = tmpdir();
	appendGitPins(base);
	// OTTR-990: the run cwd is a worker-writable worktree, and omp imports its project
	// custom tools (`.omp/tools`, plugins, foreign `.claude`/`.codex` tool dirs) into
	// this server process at session start. Park them out of discovery for the run and
	// restore them at settle; a park error throws before the spawn (fail-closed), after
	// unwinding the dirs that did park, so the worktree keeps its committed content.
	const parked: ParkedDir[] = [];
	try {
		parkCustomToolDirs(o.cwd, parked);
	} catch (err) {
		restoreParkedToolDirs(parked, sink);
		throw err;
	}
	const env = childEnv({
		sessionName: o.sessionName,
		board: o.board ?? null,
		// A run's extra env (OTTR_RETRO, OTTR_REVIEW) rides on top of the inherited base:
		// replacing it would strip PATH and the provider auth the child needs. HOME moves
		// to the board's own omp home (R5-1): omp reads plugins and user skills from it.
		base,
		stripBoard: o.stripBoard,
	});
	// After every strip: the run's memory binding is the only HINDSIGHT_* env the child
	// holds (docs/specs/hindsight-bank-binding.md). Null on a mnemopi deployment.
	if (s.memoryEnv !== null) Object.assign(env, s.memoryEnv.env);
	const child = launch("omp", args, {
		cwd: o.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env,
	});

	let killed = false;
	// The token dies with the run: any outcome revokes it, so a captured token stops
	// opening the project's bank the moment the turn settles (or the board kills it).
	const releaseMemory = (): void => {
		if (s.memoryEnv !== null) s.o.memoryTokens?.revoke(s.memoryEnv.token);
	};
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
	const {
		promise: done,
		resolve: resolveDone,
		reject: rejectDone,
	} = Promise.withResolvers<RunResult>();
	const settle = (code: number | null): void => {
		if (settled) return;
		settled = true;
		void (async () => {
			try {
				// Restore before the drain, so a restore warning lands in the run log.
				if (parked.length > 0) restoreParkedToolDirs(parked, sink);
				await sink.drain();
				// Audit only after the run's output and persistence callbacks finish.
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
			} catch (error) {
				rejectDone(error);
			} finally {
				unregisterLayer();
				// The run is over: its private scratch goes. A leftover process still
				// holding an entry (a detached dev server's cwd) makes rm fail; the next
				// aged sweep takes the tree when its holds clear (src/tmpsweep.ts).
				try {
					rmSync(scratch, { recursive: true, force: true });
				} catch {
					// the aged sweep is the backstop
				}
				releaseMemory();
			}
		})();
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
		startedAt,
		done,
		kill: () => {
			killed = true;
			if (child.pid !== undefined) platform.killTree(child.pid);
			return Promise.resolve();
		},
		layerId,
	};
}

/** The `--config` overlay paths in an omp argv, in order. */
export function configOverlayPaths(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length - 1; i++)
		if (argv[i] === "--config") out.push(argv[i + 1]!);
	return out;
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
		pluginSkillsConfig,
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
			...(pluginSkillsConfig ? [pluginSkillsConfig] : []),
		],
		copyOut: [o.sessionDir],
		// Absent stays absent: no card files, no empty array on the wire.
		...(vm.cloneFiles === undefined ? {} : { cloneFiles: vm.cloneFiles }),
		// The bake reads the dispatch's trusted texts, never the shared home
		// (docs/specs/vm-list-isolation.md); the read resolves the board home's
		// current layer, like the board's own provisioning reads.
		lists: projectTrustedLists(vm.grant.project),
	};
	// Every --config overlay under the copied-in project data dir must ride copyIn:
	// the guest reads the image's own extension-dir overlays at the same path, but a
	// data-dir overlay exists in the VM only if copyIn carries it, and a missed one
	// fails only after boot with "Config overlay not found" (OTTR-887). Fails loudly,
	// like an overlay write failure does.
	const dataDir = dirname(o.sessionDir);
	const missingOverlays = configOverlayPaths(args).filter(
		(p) => dirname(p) === dataDir && !spec.copyIn.includes(p),
	);
	if (missingOverlays.length)
		throw new Error(
			`config overlays not copied into the VM: ${missingOverlays.join(", ")}`,
		);
	const testEnv: Record<string, string> = {};
	for (const key of ["OTTR_TEST_PG_URL", "OTTR_REQUIRE_PG_TESTS"] as const) {
		const value = process.env[key];
		if (value !== undefined) testEnv[key] = value;
	}
	const vmHandle = runWorker(
		{
			id: crypto.randomUUID(),
			argv: args,
			cwd: o.cwd,
			stdin: o.prompt,
			env: vmEnv({
				env: { ...testEnv, ...o.env, ...identityEnv },
				secrets: o.secrets,
				sessionName: o.sessionName,
				board: o.board ?? null,
				stripBoard: o.stripBoard,
				boardUrl: vm.boardUrl,
				token,
				layerEnv,
			}),
			// Not merged into env here: the vm-runner merges it after its guestEnv strip.
			githubReadEnv: withoutDatabaseUrl(o.githubReadEnv),
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

/**
 * The provisioning lists a classic worker dispatch carries on its /run request: the raw texts
 * of the project's tools.json, apt.txt and requirements.txt plus the fleet (_all) tools and
 * requirements texts, read from the board's list home (turnListHome, R5-1: never the shared
 * home a worker turn can write). A missing file omits its field, and there is no aptAll —
 * turn-time provisioning reads only the project's apt.txt
 * (docs/specs/worker-list-isolation.md).
 */
export function workerTurnLists(
	project: string,
	home = turnListHome(),
): NonNullable<WorkerRequest["lists"]> {
	const read = (file: string): string | undefined =>
		existsSync(file) ? readFileSync(file, "utf8") : undefined;
	const tools = read(toolsListPath(project, home));
	const toolsAll = read(toolsListPath("_all", home));
	const apt = read(aptListPath(project, home));
	const requirements = read(requirementsListPath(project, home));
	const requirementsAll = read(requirementsListPath("_all", home));
	return {
		...(tools === undefined ? {} : { tools }),
		...(toolsAll === undefined ? {} : { toolsAll }),
		...(apt === undefined ? {} : { apt }),
		...(requirements === undefined ? {} : { requirements }),
		...(requirementsAll === undefined ? {} : { requirementsAll }),
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
	// After every strip: the request env is the only source of HINDSIGHT_* on the worker
	// side too (runChildEnv strips the container's own names) — the proxy URL, the per-run
	// token, the bank and the scoping pin (docs/specs/hindsight-bank-binding.md).
	if (s.memoryEnv !== null) Object.assign(env, s.memoryEnv.env);
	// One id for the request and the handle: the worker's GET /stats reports usage by it.
	const runId = crypto.randomUUID();
	// The board's trusted lists ride the request (R5-1): the worker never reads the shared
	// home, so the dispatch carries exactly what a server-local turn would read
	// (docs/specs/worker-list-isolation.md). No OTTR_PROJECT: the worker ignores lists.
	const project = env.OTTR_PROJECT;
	const workerHandle = runWorker(
		{
			id: runId,
			argv: buildOmpArgs({ ...o, memoryConfig, pluginSkillsConfig }),
			cwd: o.cwd,
			stdin: o.prompt,
			env,
			// OTTR-994: the identity key rides the request itself, so a stripBoard
			// run (retro, proposal) keeps its project's turn uid and turn home.
			project:
				o.project ??
				(o.board === null || o.board === undefined
					? undefined
					: o.board.project),
			githubReadEnv: withoutDatabaseUrl(o.githubReadEnv),
			...(project === undefined ? {} : { lists: workerTurnLists(project) }),
		},
		worker,
		sink,
	);
	const dispatch = (): string =>
		`worker ${workerHandle.url}, argv ${args.length}, cwd ${basename(o.cwd)}, ${Math.round((Date.now() - startedAt) / 1000)}s`;
	// The token dies with the run: any outcome revokes it, like a local run's settle.
	const releaseMemory = (): void => {
		if (s.memoryEnv !== null) s.o.memoryTokens?.revoke(s.memoryEnv.token);
	};
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
				releaseMemory();
				return { ...r, dispatch: dispatch() };
			})
			.catch((err) => {
				unregisterLayer();
				releaseMemory();
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

/** The per-run memory binding a classic dispatch carries (docs/specs/hindsight-bank-binding.md).
 *  Null when the run gets none without a note (tests without a store, a VM dispatch whose VM
 *  token already binds memory, a mnemopi deployment). The `skipped` shape marks a hindsight
 *  run whose project or board URL is missing: the run starts without memory and the sink
 *  says why. The raw token must be issued before the sink exists, so it joins the
 *  redaction secrets. */
function resolveMemoryBinding(
	o: StartOptions,
): { token: string; env: Record<string, string> } | { skipped: string } | null {
	if (o.vm || !o.memoryTokens) return null;
	if (memoryBackendFromEnv(process.env).backend !== "hindsight") return null;
	const project = o.project ?? o.board?.project;
	if (!project) return { skipped: "the run has no project" };
	const base = (o.board?.url ?? process.env.OTTR_BOARD_URL ?? "")
		.trim()
		.replace(/\/+$/, "");
	if (!base) return { skipped: "no board URL names the /hindsight proxy" };
	const token = o.memoryTokens.issue(
		memoryGrant(project, o.board?.taskId || "-"),
	);
	return { token, env: memoryTurnEnv(project, `${base}/hindsight`, token) };
}

export async function startRun(o: StartOptions): Promise<RunHandle> {
	// OTTR-1215: every turn and every check session on this host launches through
	// here (local, worker or vm dispatch), so the /dev/null guard runs first: it
	// repairs a device that lost its 1:3 character shape, records one notice, and
	// a device it cannot repair fails the dispatch closed.
	const dn = devNullGuard.check();
	if (dn.broken && !dn.repaired)
		throw new Error(dn.notice ?? "devnull: /dev/null is not the null device");
	if (dn.first) console.error(`devnull: ${dn.notice}`);
	// Issued before the sink exists so the log redacts the raw token like any other secret.
	// The grant carries the spec's base so the git endpoint keeps that ref fetchable.
	const vmToken = o.vm
		? o.vm.tokens.issue({ ...o.vm.grant, base: o.vm.base })
		: null;
	const memory = resolveMemoryBinding(o);
	// Until a handle exists, no settlement releases the lease or revokes the token: every
	// pre-handle error (sink, lease acquisition, setup, dispatch prep) cleans up here.
	let layerPin: RunLayerPin | null = null;
	try {
		const sink = createRunSink({
			logPath: o.logPath,
			dataRoot: o.dataRoot,
			onLog: o.onLog,
			onSession: o.onSession,
			onProgress: o.onProgress,
			secrets: [
				...(o.secrets ?? []),
				...(vmToken === null ? [] : [vmToken]),
				...(memory !== null && !("skipped" in memory) ? [memory.token] : []),
			],
			meter: o.meter,
			onUsage: o.onUsage,
			onRecorded: o.onRecorded,
		});
		const startedAt = Date.now();
		// Pin the agent layer once per call, before any spawn: the env carries the resolved
		// layer directory, so a later atomic switch of `.alate/current` never touches a live
		// run. Worker runs resolve the shared home (alate provisions it), the board's own runs
		// the board home.
		const layerHome = o.worker || o.vm ? homedir() : boardOmpHome();
		layerPin = resolveLayerPin(layerHome, sink);
		return await startPinnedRun(
			o,
			sink,
			startedAt,
			layerHome,
			layerPin,
			vmToken,
			memory,
		);
	} catch (err) {
		layerPin?.unregisterLayer();
		if (o.vm && vmToken !== null) o.vm.tokens.revoke(vmToken);
		if (memory !== null && !("skipped" in memory))
			o.memoryTokens?.revoke(memory.token);
		throw err;
	}
}

/** Everything between the layer pin and the run handle: a throw here releases the pin. */
async function startPinnedRun(
	o: StartOptions,
	sink: RunSink,
	startedAt: number,
	layerHome: string,
	layerPin: RunLayerPin,
	vmToken: string | null,
	memory:
		| { token: string; env: Record<string, string> }
		| { skipped: string }
		| null,
): Promise<RunHandle> {
	if (memory !== null && "skipped" in memory)
		sink.logMark(`! hindsight memory off for this run: ${memory.skipped}\n`);
	const memoryConfig = resolveMemoryConfig(o);
	// The plugin-skills overlay reads the run's pinned home, so a layer run gets its own
	// layer's plugins (docs/specs/turn-home-plugin-skills.md).
	const pluginSkillsConfig = pluginSkillsConfigFor(
		o,
		layerPin.layerEnv,
		layerHome,
	);
	const args = buildOmpArgs({ ...o, memoryConfig, pluginSkillsConfig });
	// Awaited here (after buildOmpArgs, before RunStart): the probe spawns git and must
	// not block the caller's tick, but every dispatch path needs the ident env settled.
	const identityEnv = await resolveIdentityEnv(o, layerPin.layerEnv);
	const s: RunStart = {
		o,
		sink,
		args,
		memoryConfig,
		memoryEnv:
			memory !== null && !("skipped" in memory)
				? { token: memory.token, env: memory.env }
				: null,
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
