// Stale turn recovery (OTTR-1261, docs/specs/stale-turn-recovery.md): a running turn that
// waits on state that can no longer change — a lock naming a dead pid, or a timeout-0
// watcher loop — holds its card and slot for hours. This module holds the shared contract:
// the tick helpers, the pure string parsers over untrusted session/command text, the
// read-only diagnosis verdict, the allowlisted-fix steer wording, and the ask wording the
// reply route recognises. The supervisor pass, the worker probe, and the app reply route
// all call into here; session and command text only select what to read, never what to run.

import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename } from "node:path";
import { pidAlive } from "./dblock.ts";

/** Log or session unchanged for this long starts the suspect check (30 min). */
export const STALE_IDLE_MS = 30 * 60_000;
/** Tick delta over the check window that marks a busy child (5 ticks = 50 ms). */
export const BUSY_MIN_TICKS = 5;
/** A persistent stuck situation re-files the ask at most once per 4 h. */
export const STALE_REASK_MS = 4 * 60 * 60_000;
/** needsReason marker the reply route recognises. */
export const STALE_ASK_MARKER = "Stuck turn:";

/** Queued by the reply route when the owner answers "Apply the fix" (the responder has
 * no probe); the pass's fix-pending branch appends the specific staleSteerText(fix)
 * when it re-diagnoses and acts, so the agent still gets the concrete facts. */
export const STALE_FIX_PENDING_STEER =
	"Supervisor: the card owner approved the stale-turn fix. The next supervisor tick re-diagnoses the card and applies the allowlisted fix (stale lock removal or hung child stop) with the facts in a follow-up steer.";

export const STALE_OPTIONS = [
	"Apply the fix",
	"Stop the turn and restart",
	"Wait",
] as const;

export type StaleAnswerKind = "fix" | "stop" | "wait";

export interface ProcSample {
	pid: number;
	ppid: number;
	ticks: number;
	command: string;
}

export interface LastTool {
	tool: string;
	command: string;
	timeout: number | null;
}

export interface LockFact {
	path: string;
	exists: boolean;
	pid: number | null;
	alive: boolean | null;
}

export interface StaleProbe {
	pid: number | null;
	alive: boolean;
	procs: ProcSample[];
	sessionAt: number | null;
	lastTool: LastTool | null;
	locks: LockFact[];
}

export type StaleFix =
	| { kind: "stale-lock"; path: string; pid: number }
	| { kind: "hung-child"; pid: number; command: string }
	| { kind: "unsure"; reason: string };

/** pid → ticks, the supervisor's per-card baseline between probes (memory only). */
export function tickMap(procs: readonly ProcSample[]): Map<number, number> {
	return new Map(procs.map((p) => [p.pid, p.ticks]));
}

/** Descendants of rootPid in BFS order, shallowest first, never the root itself (the omp
 * pid's own event loop must never count as a busy child). Ties sort by ascending pid, so
 * the order is stable across readdir order. */
function descendantsInOrder(
	procs: readonly ProcSample[],
	rootPid: number,
): ProcSample[] {
	const byPid = new Map<number, ProcSample>();
	const children = new Map<number, number[]>();
	for (const p of procs) {
		byPid.set(p.pid, p);
		const list = children.get(p.ppid);
		if (list === undefined) children.set(p.ppid, [p.pid]);
		else list.push(p.pid);
	}
	for (const list of children.values()) list.sort((a, b) => a - b);
	const out: ProcSample[] = [];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.shift();
		if (pid === undefined) break;
		for (const child of children.get(pid) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			const p = byPid.get(child);
			if (p === undefined) continue;
			out.push(p);
			queue.push(child);
		}
	}
	return out;
}

/** First descendant of the run pid whose tick delta since the previous probe is
 * >= BUSY_MIN_TICKS; null when anything is unknown (no baseline, no run pid) or no
 * descendant is busy. A pid missing from the baseline reads delta 0: it appeared since
 * the last probe, and an unknown pid must never count as busy (OTTR-1261). */
export function busyDescendant(
	prev: ReadonlyMap<number, number> | null,
	procs: readonly ProcSample[],
	rootPid: number | null,
): number | null {
	if (prev === null || rootPid === null) return null;
	for (const p of descendantsInOrder(procs, rootPid)) {
		if (p.ticks - (prev.get(p.pid) ?? p.ticks) >= BUSY_MIN_TICKS) return p.pid;
	}
	return null;
}

/** Strict lock-content parse: JSON must yield an object whose `pid` is a positive safe
 * integer; extra keys are tolerated, everything else refuses. */
export function parseLockPid(text: string): number | null {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const pid = (v as Record<string, unknown>).pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
		return null;
	return pid;
}

/** The trailing digit run of a worktree basename: "OTTR-1191" → "1191",
 * "1234" → "1234", "main" → null. */
export function cardNumOf(worktreeBasename: string): string | null {
	const m = /(\d+)$/.exec(worktreeBasename);
	const digits = m?.[1];
	return digits === undefined ? null : digits;
}

/**
 * String-level confinement pre-check for lock reads and fixes (the act-time fix
 * re-checks with realpath). Allowed: the card's own worktree, or a worker temp root
 * (/tmp, /var/tmp) whose one segment carries the card number as a -/_/.-delimited
 * token — "gate-1191" carries "1191", "gate-11912" and "gate-1244" do not, and
 * without a card number nothing under a temp root is allowed.
 */
export function lockPathAllowed(
	path: string,
	worktree: string,
	cardNum: string | null,
): boolean {
	if (path === worktree || path.startsWith(`${worktree}/`)) return true;
	if (!path.startsWith("/tmp/") && !path.startsWith("/var/tmp/")) return false;
	if (cardNum === null) return false;
	return path.split("/").some((seg) => seg.split(/[-_.]/).includes(cardNum));
}

// Path-like token: "/" or "./" then non-space, non-shell-structure chars. The char
// class drops the shell metacharacters that would otherwise glue "]" or ";" onto a
// path, and the boundary class keeps mid-word slashes ("dir/x.lock") out.
const LOCK_TOKEN_RE = /(?:^|[^/.\w])((?:\.\/|\/)[^\s"'`()[\]{}&|<>;,]+)/g;

const LOCK_PATH_CAP = 5;
// Both the lock-path cap and the command-normalize cap are 300 chars (spec).
const CAP_300 = 300;

/** Lock-candidate paths a command text names, order preserved, deduped, at most
 * `LOCK_PATH_CAP`, each at most `CAP_300` chars. Untrusted text: regex only. */
export function extractLockPaths(command: string): string[] {
	const out: string[] = [];
	for (const m of command.matchAll(LOCK_TOKEN_RE)) {
		const path = (m[1] ?? "").slice(0, CAP_300);
		if (!basename(path).endsWith(".lock")) continue;
		if (!out.includes(path)) out.push(path);
		if (out.length >= LOCK_PATH_CAP) break;
	}
	return out;
}

/** The last tool_execution_start in newline-delimited JSON session text (callers cap
 * the read; this function never touches the disk). Bad lines are skipped, not fatal:
 * the tail may end mid-write. */
export function lastToolCall(sessionText: string): LastTool | null {
	let found: LastTool | null = null;
	for (const line of sessionText.split("\n")) {
		const t = line.trim();
		if (t === "") continue;
		let obj: unknown;
		try {
			obj = JSON.parse(t);
		} catch {
			continue;
		}
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) continue;
		const rec = obj as Record<string, unknown>;
		if (rec.type !== "tool_execution_start") continue;
		const args = rec.arguments ?? rec.args ?? rec.input;
		const a: Record<string, unknown> =
			typeof args === "object" && args !== null && !Array.isArray(args)
				? (args as Record<string, unknown>)
				: {};
		found = {
			tool: String(rec.toolName ?? rec.tool ?? ""),
			command: String(a.command ?? a.Command ?? ""),
			timeout: typeof a.timeout === "number" ? a.timeout : null,
		};
	}
	return found;
}

/** argv and session text compare equal only in this shape: whitespace runs collapse to
 * one space, trimmed, capped. */
function normalizeCmd(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, CAP_300);
}

/** The fall-through unsure verdict: the reason names what was checked (idle window,
 * no busy child, last tool) and which precondition failed. */
function unsureFix(probe: StaleProbe, failure: string): StaleFix {
	const tool = probe.lastTool
		? `${probe.lastTool.tool} (${probe.lastTool.command}, timeout ${probe.lastTool.timeout})`
		: "none found";
	return {
		kind: "unsure",
		reason: `idle window reached, no busy child, last tool ${tool}: ${failure}`,
	};
}

/** Shallowest descendant of the run pid whose normalized command contains the last
 * tool call's normalized command and whose ticks stayed under BUSY_MIN_TICKS across
 * the window: the shell of the stuck call, idle, not spinning. */
function idleChildMatching(
	prevTicks: ReadonlyMap<number, number>,
	procs: readonly ProcSample[],
	rootPid: number,
	want: string,
): ProcSample | null {
	for (const p of descendantsInOrder(procs, rootPid)) {
		const delta = p.ticks - (prevTicks.get(p.pid) ?? p.ticks);
		if (delta < BUSY_MIN_TICKS && normalizeCmd(p.command).includes(want))
			return p;
	}
	return null;
}

/**
 * Read-only verdict for a suspect card. Lock rules first (OTTR-1191): exactly one
 * allowed dead-pid lock → stale-lock; a lock naming a live pid, a dead-pid lock
 * outside the card's dirs, or several candidates → unsure. Then the hung-child rule:
 * an unbounded (timeout 0) last tool call whose matching shell child sat idle over
 * the window → hung-child. Anything else → unsure; unsure always parks as an ask,
 * never as a file or process change.
 */
export function diagnoseStale(input: {
	probe: StaleProbe;
	worktree: string;
	prevTicks: ReadonlyMap<number, number> | null;
}): StaleFix {
	const { probe, worktree, prevTicks } = input;
	const cardNum = cardNumOf(basename(worktree));
	const isAllowed = (path: string): boolean =>
		lockPathAllowed(path, worktree, cardNum);
	const dead = probe.locks.filter(
		(l) => l.exists && l.pid !== null && l.pid > 1 && l.alive === false,
	);
	const allowed = dead.filter((l) => isAllowed(l.path));
	const only = allowed.length === 1 ? allowed[0] : undefined;
	if (only !== undefined && only.pid !== null)
		return { kind: "stale-lock", path: only.path, pid: only.pid };
	const live = probe.locks.find(
		(l) => l.exists && l.pid !== null && l.alive === true,
	);
	if (live !== undefined && live.pid !== null)
		return {
			kind: "unsure",
			reason: `lock ${live.path} names live pid ${live.pid}`,
		};
	const outside = dead.find((l) => !isAllowed(l.path));
	if (outside !== undefined && outside.pid !== null)
		return {
			kind: "unsure",
			reason: `lock ${outside.path} names dead pid ${outside.pid} outside the card's own dirs`,
		};
	if (allowed.length > 1) {
		const names = allowed.map((l) => l.path).join(", ");
		return {
			kind: "unsure",
			reason: `several stale lock candidates (${names}), refusing to guess`,
		};
	}
	if (probe.lastTool === null)
		return unsureFix(probe, "no last tool call found");
	if (probe.lastTool.timeout !== 0)
		return unsureFix(
			probe,
			`last tool ${probe.lastTool.tool} ran with timeout ${probe.lastTool.timeout}, not 0`,
		);
	if (prevTicks === null)
		return unsureFix(probe, "no tick baseline (first probe)");
	if (probe.pid === null) return unsureFix(probe, "run pid unknown");
	const want = normalizeCmd(probe.lastTool.command);
	if (want === "") return unsureFix(probe, "last tool command is empty");
	const child = idleChildMatching(prevTicks, probe.procs, probe.pid, want);
	if (child === null)
		return unsureFix(
			probe,
			`no idle child of pid ${probe.pid} matches the last tool call`,
		);
	return { kind: "hung-child", pid: child.pid, command: child.command };
}

/** The full agent-facing steer for an allowlisted fix (spec "Steer wording"; drafts
 * pending owner approval, kept here next to the other supervisor prompts). */
export function staleSteerText(
	fix:
		| { kind: "stale-lock"; path: string; pid: number }
		| { kind: "hung-child"; pid: number; command: string },
): string {
	const facts =
		fix.kind === "stale-lock"
			? `The lock file ${fix.path} named pid ${fix.pid}, and that pid is dead on the worker. The lock could never clear. The supervisor is removing the lock file now.`
			: `The child process ${fix.pid} (${fix.command}) belongs to that tool call and has sat idle for the whole check window. The supervisor is stopping that child so the tool call can end.`;
	return `Supervisor: your last tool call was waiting on state that could not change.
${facts}
Do not trust partial results from that call. Re-run the step in the foreground with a bounded timeout, and do not start watcher loops with timeout 0.`;
}

/** needsReason for the ask path: the marker the reply route recognises, the diagnosis,
 * and the three answers. */
export function staleAskReason(diagnosis: string): string {
	return `${STALE_ASK_MARKER} ${diagnosis} Reply "Apply the fix", "Stop the turn and restart", or "Wait".`;
}

/** The ask panel's single question with the three fixed options. */
export function staleAskQuestion(): { question: string; options: string[] } {
	return {
		question:
			"The supervisor found the turn stuck on state that cannot change. What should it do?",
		options: [...STALE_OPTIONS],
	};
}

/** True only for needsReason values the reply route owns. */
export function isStaleAskReason(reason: string | null): boolean {
	return reason !== null && reason.startsWith(STALE_ASK_MARKER);
}

const KIND_BY_OPTION: Record<(typeof STALE_OPTIONS)[number], StaleAnswerKind> =
	{
		"Apply the fix": "fix",
		"Stop the turn and restart": "stop",
		Wait: "wait",
	};

/** The drawer's wire line is `For "<question>": <answer>`; the last `": `
 * separates the parts even when the question text itself holds one. A bare trimmed answer also
 * matches, case- and trailing-period-insensitive. */
export function staleAnswerKind(text: string): StaleAnswerKind | null {
	const sep = text.lastIndexOf('": ');
	const raw = (sep >= 0 ? text.slice(sep + 3) : text)
		.trim()
		.replace(/\.$/, "")
		.toLowerCase();
	for (const option of STALE_OPTIONS)
		if (option.toLowerCase() === raw) return KIND_BY_OPTION[option];
	return null;
}

/** /proc/<pid>/stat fields start after the last ")" (comm can hold spaces and parens):
 * after[1] = ppid, after[11..14] = utime stime cutime cstime. */
function parseProcStat(text: string): { ppid: number; ticks: number } | null {
	const after = text.slice(text.lastIndexOf(")") + 2).split(" ");
	const ppid = Number(after[1]);
	const utime = Number(after[11]);
	const stime = Number(after[12]);
	const cutime = Number(after[13]);
	const cstime = Number(after[14]);
	if (
		!Number.isInteger(ppid) ||
		!Number.isInteger(utime) ||
		!Number.isInteger(stime) ||
		!Number.isInteger(cutime) ||
		!Number.isInteger(cstime)
	)
		return null;
	return { ppid, ticks: utime + stime + cutime + cstime };
}

const CMDLINE_CAP = 300;

/** Full argv joined with single spaces, capped; "" when unreadable (kernel threads,
 * exited pids). */
function pidCommand(procRoot: string, pid: number): string {
	try {
		return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8")
			.split("\0")
			.filter((seg) => seg !== "")
			.join(" ")
			.slice(0, CMDLINE_CAP);
	} catch {
		return "";
	}
}

/** One /proc tree sample: the run pid plus every descendant, shallowest first, ties by
 * ascending pid, each with ppid, summed ticks and argv. null when the root stat is
 * unreadable (dead run pid); children that exited between the readdir and their stat
 * are skipped with their subtrees. */
export function readTree(
	rootPid: number,
	procRoot = "/proc",
): ProcSample[] | null {
	const byPid = new Map<number, { ppid: number; ticks: number }>();
	let names: string[];
	try {
		names = readdirSync(procRoot);
	} catch {
		return null;
	}
	for (const name of names) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		try {
			const parsed = parseProcStat(
				readFileSync(`${procRoot}/${pid}/stat`, "utf8"),
			);
			if (parsed !== null) byPid.set(pid, parsed);
		} catch {
			// exited between readdir and stat
		}
	}
	const root = byPid.get(rootPid);
	if (root === undefined) return null;
	const children = new Map<number, number[]>();
	for (const [pid, st] of byPid) {
		const list = children.get(st.ppid);
		if (list === undefined) children.set(st.ppid, [pid]);
		else list.push(pid);
	}
	for (const list of children.values()) list.sort((a, b) => a - b);
	const out: ProcSample[] = [
		{
			pid: rootPid,
			ppid: root.ppid,
			ticks: root.ticks,
			command: pidCommand(procRoot, rootPid),
		},
	];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.shift();
		if (pid === undefined) break;
		for (const child of children.get(pid) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			const st = byPid.get(child);
			if (st === undefined) continue;
			out.push({
				pid: child,
				ppid: st.ppid,
				ticks: st.ticks,
				command: pidCommand(procRoot, child),
			});
			queue.push(child);
		}
	}
	return out;
}

/** The newest `*.jsonl` entry under the run's session dir with mtime not older
 * than `startedAtMs`; null when none qualifies or the dir is unreadable. */
export function newestSessionFile(
	sessionDir: string,
	startedAtMs: number,
): { path: string; at: number } | null {
	try {
		let best: { path: string; at: number } | null = null;
		for (const name of readdirSync(sessionDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const at = statSync(`${sessionDir}/${name}`).mtimeMs;
			if (at < startedAtMs) continue;
			if (best === null || at > best.at)
				best = { path: `${sessionDir}/${name}`, at };
		}
		return best;
	} catch {
		return null;
	}
}

export function newestSessionAt(
	sessionDir: string,
	startedAtMs: number,
): number | null {
	return newestSessionFile(sessionDir, startedAtMs)?.at ?? null;
}

// readRegular (src/confine.ts) opens without O_NOFOLLOW, so a planted symlink to a
// regular file would be followed; lock paths come from untrusted session text, so this
// reader refuses the final symlink itself (OTTR-1261).
const LOCK_FILE_MAX_BYTES = 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const { O_RDONLY } = constants;

/** First 1 KiB of a regular file, final symlink refused; throws so lockFacts can grade
 * the failure. */
function readLockText(path: string): string {
	const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error(`refusing ${path}: not a regular file`);
		const buf = Buffer.allocUnsafe(Math.min(st.size, LOCK_FILE_MAX_BYTES));
		let n = 0;
		while (n < buf.length) {
			const r = readSync(fd, buf, n, buf.length - n, null);
			if (r === 0) break;
			n += r;
		}
		return buf.toString("utf8", 0, n);
	} finally {
		closeSync(fd);
	}
}

/**
 * Lock facts for the diagnosis, read-only and never throwing. A path that fails the
 * confinement pre-check reports exists: false without any read — a path planted by
 * session text cannot widen what is read. Anything that is missing reads exists:
 * false; anything present but unreadable (symlink, non-regular, foreign perms) reads
 * exists: true with pid null and the rule never fires.
 */
export function lockFacts(
	paths: readonly string[],
	worktree: string,
	cardNum: string | null,
): LockFact[] {
	return paths.map((path) => {
		if (!lockPathAllowed(path, worktree, cardNum))
			return { path, exists: false, pid: null, alive: null };
		try {
			const pid = parseLockPid(readLockText(path));
			return {
				path,
				exists: true,
				pid,
				alive: pid === null ? null : pidAlive(pid),
			};
		} catch (err) {
			// ENOENT/ENOTDIR: no lock file there. Other refusals: something is at the
			// path but it is not a readable regular lock — present, unusable.
			const code = (err as NodeJS.ErrnoException).code;
			const missing = code === "ENOENT" || code === "ENOTDIR";
			return { path, exists: !missing, pid: null, alive: null };
		}
	});
}

/** The server-local stale-lock fix (OTTR-1261): the act-time preconditions the
 * worker's /stalefix enforces, run in-process for a run the server hosts itself.
 * The lock path is untrusted session text: realpaths on both sides confine it to
 * the card's own worktree or the card-number scratch rule, the file must be a
 * small regular file that still names a pid that is dead on this host, and only
 * then does the unlink run. A refusal changes nothing. */
export function staleUnlockLocal(
	worktree: string,
	lockPath: string,
): { ok: boolean; reason?: string } {
	let real: string;
	let realRoot: string;
	try {
		real = realpathSync(lockPath);
		realRoot = realpathSync(worktree);
	} catch {
		return { ok: false, reason: `the lock file is gone: ${lockPath}` };
	}
	if (!lockPathAllowed(real, realRoot, cardNumOf(basename(realRoot))))
		return {
			ok: false,
			reason: `the lock path is outside the card's own dirs: ${lockPath}`,
		};
	try {
		// A lock names one pid: anything past a few KiB is not one, and an
		// unbounded read would let a worktree-sized file into the server.
		const st = statSync(real);
		if (!st.isFile() || st.size > 4096)
			return {
				ok: false,
				reason: `the lock path is not a small regular file: ${lockPath}`,
			};
		const pid = parseLockPid(readLockText(real));
		if (pid === null || pid <= 1)
			return {
				ok: false,
				reason: `the lock file no longer names a pid: ${lockPath}`,
			};
		if (pidAlive(pid))
			return { ok: false, reason: `the lock pid ${pid} is alive: ${lockPath}` };
		unlinkSync(real);
	} catch (err) {
		return {
			ok: false,
			reason: `the lock fix failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true };
}

/** The server-local hung-child fix (OTTR-1261): SIGTERM one process proven to sit
 * strictly inside the run's tree in a fresh walk, never the run pid itself, the
 * caller's pid, or pid 1. TERM only — the stuck tool call ends, the turn lives. */
export function staleKillLocal(
	runPid: number,
	childPid: number,
	procRoot = "/proc",
	kill: typeof process.kill = process.kill,
): { ok: boolean; reason?: string } {
	if (childPid === 1)
		return { ok: false, reason: "pid 1 is never a fix target" };
	if (childPid === process.pid)
		return { ok: false, reason: "the server's own pid is never a fix target" };
	if (childPid === runPid)
		return { ok: false, reason: "the run's own pid is never a fix target" };
	const procs = readTree(runPid, procRoot);
	if (procs === null) return { ok: false, reason: "the run pid is gone" };
	if (!procs.some((p) => p.pid === childPid))
		return {
			ok: false,
			reason: `pid ${childPid} is not in the turn's process tree`,
		};
	try {
		kill(childPid, "SIGTERM");
	} catch (err) {
		return {
			ok: false,
			reason: `signal failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true };
}
