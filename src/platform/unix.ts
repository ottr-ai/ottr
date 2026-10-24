// Unix (Linux today, macOS later) implementation of the Platform contract (see index.ts).
import { spawnSync } from "node:child_process";
import type { Platform, ProcessInfo } from "./index.ts";

// ponytail: 32 MiB caps the ps snapshots (~1 MiB today under Stryker load, full argv listing >1 MiB).
// Ceiling: a host with a process table beyond 32 MiB of output still fails; upgrade: stream via async spawn.
const PS_MAX_BUFFER = 32 * 1024 * 1024;

/** Every descendant of `pid` (BFS over the parent links of one `ps` snapshot); null when ps fails. */
export function descendants(pid: number): number[] | null {
	const kids = new Map<number, number[]>();
	try {
		const ps = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: PS_MAX_BUFFER,
		});
		if (ps.status !== 0) return null;
		for (const line of ps.stdout.toString().split("\n")) {
			const [p, pp] = line.trim().split(/\s+/);
			const child = Number(p);
			const parent = Number(pp);
			if (Number.isInteger(child) && Number.isInteger(parent) && child > 0) {
				kids.set(parent, [...(kids.get(parent) ?? []), child]);
			}
		}
	} catch {
		return null;
	}
	const out: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		for (const child of kids.get(current) ?? []) {
			out.push(child);
			queue.push(child);
		}
	}
	return out;
}

export const unix = {
	killTree(
		pid: number,
		kill: typeof process.kill = process.kill.bind(process),
	): void {
		if (pid <= 0) return;
		// ponytail: one ps snapshot, so a process that forks after it survives. Upgrade: SIGSTOP the tree, re-walk, then SIGKILL.
		const tree = descendants(pid);
		if (tree === null)
			console.warn(
				`killTree(${pid}): could not list processes, killing only the root pid; descendants may survive`,
			);
		// pid first, then every descendant; a failed snapshot still kills the pid
		for (const target of [pid, ...(tree ?? [])]) {
			if (target === process.pid) continue;
			try {
				kill(target, "SIGKILL");
			} catch {
				// already gone
			}
		}
	},

	// One snapshot of every process: pid, uptime in seconds, full command line; start time is
	// derived from the current clock, so it is approximate.
	listProcesses(run: typeof spawnSync = spawnSync): ProcessInfo[] {
		const ps = run("ps", ["-eo", "pid=,etimes=,args="], {
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: PS_MAX_BUFFER,
		});
		const problem = ps.error ?? (ps.status !== 0 ? `exit ${ps.status}` : null);
		if (problem) throw new Error(`process scan failed: ${problem}`);
		const out: ProcessInfo[] = [];
		const now = Date.now();
		for (const line of ps.stdout.toString().split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s(.+)$/.exec(line);
			if (!m) continue; // header or unparseable line
			const pid = Number(m[1]);
			const etimes = Number(m[2]);
			if (!Number.isInteger(pid) || pid <= 0) continue;
			if (!Number.isFinite(etimes) || etimes < 0) continue;
			const cmd = m[3];
			if (cmd === undefined) continue;
			out.push({ pid, cmd, started: now - etimes * 1000 });
		}
		return out;
	},

	samePath(a: string, b: string): boolean {
		return a === b;
	},
} satisfies Platform;
