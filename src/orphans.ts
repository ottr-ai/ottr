// Pure orphan detection: which running agent processes nobody tracks anymore. Advisory only —
// the tracker never kills anything; it just reports.
import { basename, join, sep } from "node:path";
import type { ProcessInfo } from "./platform/index.ts";
import type { OrphanProcess } from "./types.ts";

/** A process younger than this is starting up or winding down; never report it. */
export const ORPHAN_GRACE_MS = 600_000;

export interface OrphanProject {
	name: string;
	path: string;
	sessionsDir: string;
}

/** Strips quotes, directories and script extensions; lowercases for comparison. */
function tokenBasename(token: string): string {
	let t = token.replace(/^["']|["']$/g, "");
	t = t.replace(/^.*[\\/]/, "");
	return t.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

// ponytail: advisory heuristic, not a sandbox boundary. Matches the tracker's own turn argv
// (buildOmpArgs: `-p --mode json …`) under any launcher — omp is a bun shebang script, so a
// real turn's argv[0] is the runtime, not omp. Bare omp commands (daemon, usage) are not turns.
export function matchAgentLauncher(cmd: string): boolean {
	const tokens = cmd.trim().split(/\s+/).map(tokenBasename);
	if (!tokens.includes("omp")) return false;
	for (let i = 0; i + 2 < tokens.length; i++)
		if (
			tokens[i] === "-p" &&
			tokens[i + 1] === "--mode" &&
			tokens[i + 2] === "json"
		)
			return true;
	return false;
}

/**
 * Agent-launcher pids nobody claims, each older than the grace window. `started === 0` (unknown
 * age) stays reported: an untrackable process is exactly what this scan is for.
 */
export function orphanPids(
	processes: readonly ProcessInfo[],
	claimed: ReadonlySet<number>,
	ownPid: number,
	now: number = Date.now(),
): ProcessInfo[] {
	return processes.filter(
		(p) =>
			p.pid > 0 &&
			p.pid !== ownPid &&
			!claimed.has(p.pid) &&
			matchAgentLauncher(p.cmd) &&
			(p.started === 0 || now - p.started >= ORPHAN_GRACE_MS),
	);
}

/** Values of every `--flag <value>` occurrence; the board passes two --config flags. */
export function argValues(cmd: string, flag: string): string[] {
	const tokens = cmd.trim().split(/\s+/);
	const out: string[] = [];
	for (let i = 0; i + 1 < tokens.length; i++) {
		const v = tokens[i + 1];
		if (tokens[i] === flag && v !== undefined) out.push(v);
	}
	return out;
}

/** "retro" | "check" | "turn" when the argv names the run kind; null when it does not. */
export function runKind(cmd: string): string | null {
	for (const v of argValues(cmd, "--config")) {
		const base = basename(v);
		// no-discovery.yml rides along in every board run; it matches no rule below, so
		// the loop's fall-through already leaves the kind untouched.
		if (base === "retro.yml" || base === "check.yml")
			return base.slice(0, -".yml".length);
	}
	if (argValues(cmd, "--extension").length > 0) return "turn";
	return null;
}

/** First --session-dir value of the argv; null when absent. */
export function sessionDirOf(cmd: string): string | null {
	return argValues(cmd, "--session-dir")[0] ?? null;
}

/** Drops leading KEY=value launcher tokens, collapses whitespace, caps at 160 chars. */
export function summarizeCmd(cmd: string): string {
	let t = cmd.trim();
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
		t = t.split(/\s+/).slice(1).join(" ");
	t = t.replace(/\s+/g, " ");
	return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

const DELETED_SUFFIX = " (deleted)";

/**
 * Resolves one scanned process to its orphan facts. Project and raw card id come from the cwd
 * first (`<project.path>/.worktrees/<cardId>`); the caller validates the card id against the
 * store. Otherwise the --session-dir names the project through `samePath`. All facts are null
 * when nothing matches. Pure: no store or platform access.
 */
/** The project whose `.worktrees` dir holds `cwd`, plus the raw card id; null when no match. */
function cwdProject(
	cwd: string,
	projects: readonly OrphanProject[],
): { project: OrphanProject; card: string } | null {
	if (cwd === "") return null;
	for (const pr of projects) {
		const marker = `${join(pr.path, ".worktrees")}${sep}`;
		if (!cwd.startsWith(marker)) continue;
		const seg = cwd.slice(marker.length).split(sep)[0] ?? "";
		if (seg === "") continue;
		return {
			project: pr,
			card: seg.endsWith(DELETED_SUFFIX)
				? seg.slice(0, -DELETED_SUFFIX.length)
				: seg,
		};
	}
	return null;
}

/** The project whose sessions dir is the process's --session-dir; null when none matches. */
function sessionProject(
	p: ProcessInfo,
	projects: readonly OrphanProject[],
	samePath: (a: string, b: string) => boolean,
): OrphanProject | null {
	const sdir = sessionDirOf(p.cmd);
	if (sdir === null) return null;
	for (const pr of projects) {
		if (samePath(sdir, pr.sessionsDir)) return pr;
	}
	return null;
}

export function resolveOrphan(
	p: ProcessInfo,
	cwd: string,
	projects: readonly OrphanProject[],
	samePath: (a: string, b: string) => boolean,
): OrphanProcess {
	const fromCwd = cwdProject(cwd, projects);
	const project = fromCwd?.project ?? sessionProject(p, projects, samePath);
	return {
		pid: p.pid,
		started: p.started,
		cmd: summarizeCmd(p.cmd),
		project: project === null ? null : project.name,
		card: fromCwd?.card ?? null,
		kind: runKind(p.cmd),
	};
}

/** The store-backed facts the pure resolver cannot see: card existence. */
export function orphanView(
	p: ProcessInfo,
	cwd: string,
	projects: readonly OrphanProject[],
	samePath: (a: string, b: string) => boolean,
	getCard: (project: string | null, card: string) => boolean,
): OrphanProcess {
	const view = resolveOrphan(p, cwd, projects, samePath);
	if (view.card !== null && !getCard(view.project, view.card)) view.card = null;
	return view;
}

interface Cache {
	at: number;
	value: ProcessInfo[];
}

export interface OrphanScan {
	orphans: ProcessInfo[];
	/** Bare failure message of the last scan, or null when the scan succeeded. */
	error: string | null;
}

/**
 * Creates an instance-scoped cached orphan snapshot: `list`/`claimed` are called at most once
 * per TTL. Success is cached and returned with `error: null`; a throwing scan is never cached —
 * it returns an empty list plus the bare error message, and the next call retries. One instance
 * per app (createApp makes its own), so two apps — or two tests — never share a snapshot
 * through module state (R5-15).
 */
export function orphanCache(
	ttlMs = 300_000,
): (
	list: () => ProcessInfo[],
	claimed: () => ReadonlySet<number>,
	now: number,
) => OrphanScan {
	let cache: Cache | null = null;
	return (list, claimed, now) => {
		if (cache && now - cache.at < ttlMs)
			return { orphans: cache.value, error: null };
		let value: ProcessInfo[];
		try {
			value = orphanPids(list(), claimed(), process.pid, now);
		} catch (err) {
			return {
				orphans: [],
				error: err instanceof Error ? err.message : String(err),
			}; // do not cache the failure; the next call retries
		}
		cache = { at: now, value };
		return { orphans: value, error: null };
	};
}
