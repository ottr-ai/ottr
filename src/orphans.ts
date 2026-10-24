// Pure orphan detection: which running agent processes nobody tracks anymore. Advisory only —
// the tracker never kills anything; it just reports.
import type { ProcessInfo } from "./platform/index.ts";

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

export function orphanPids(
	processes: readonly ProcessInfo[],
	claimed: ReadonlySet<number>,
	ownPid: number,
): ProcessInfo[] {
	return processes.filter(
		(p) =>
			p.pid > 0 &&
			p.pid !== ownPid &&
			!claimed.has(p.pid) &&
			matchAgentLauncher(p.cmd),
	);
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
			value = orphanPids(list(), claimed(), process.pid);
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
