// Unix (Linux today, macOS later) implementation of the Platform contract (see index.ts).
import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { CwdProcess, Platform, ProcessInfo } from "./index.ts";

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

/** Fields of /proc/<pid>/stat after "comm)": state, ppid, pgrp, session, tty_nr, ... */
function statTail(pid: number): string[] | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	} catch {
		return null;
	}
}

/** True when the process holds a controlling terminal (interactive shells, editors) — or when
 * its stat is unreadable: a sweep must spare what it cannot read, never guess. */
function holdsTty(pid: number): boolean {
	const fields = statTail(pid);
	if (fields === null) return true;
	return Number(fields[4]) !== 0;
}

/** Full command line; comm fallback; "(unknown)" when the kernel reports neither. */
function commandOf(pid: number): string {
	try {
		const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		const cmd = argv.replaceAll("\0", " ").trim();
		if (cmd !== "") return cmd;
	} catch {
		// fall through to comm
	}
	try {
		const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
		if (comm !== "") return comm;
	} catch {
		// vanished mid-sweep
	}
	return "(unknown)";
}

const underRoot = (cwd: string, root: string): boolean => {
	const base = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
	return cwd === base || cwd.startsWith(`${base}/`);
};

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

	// /proc/<pid>/cwd is a symlink to the process working dir; a gone or unreadable pid yields "".
	cwdOf(pid: number): string {
		try {
			return readlinkSync(`/proc/${pid}/cwd`);
		} catch {
			return "";
		}
	},

	// OTTR-697 (worktrunk's wt remove --reap discovery): one read-only /proc walk. A process
	// that reparented to init escapes killTree's ps snapshot, so a leftover dev server with
	// its cwd under a worktree is named here instead. Linux only: readdir("/proc") fails
	// elsewhere and yields [].
	processesWithCwdUnder(
		root: string,
		// Injectable for tests, like killTree's kill: null when the own-tree walk fails.
		ownTree: number[] | null = descendants(process.pid),
	): CwdProcess[] {
		// Fail closed like holdsTty: when the tree cannot be listed, the sweep cannot tell a
		// leftover from the tracker's own turn child, so it names nothing at all.
		if (ownTree === null) return [];
		let entries: Dirent[];
		try {
			entries = readdirSync("/proc", { withFileTypes: true });
		} catch {
			return [];
		}
		// Never name the tracker's own turn tree: the calling process and everything it spawned.
		const own = new Set<number>([process.pid, ...ownTree]);
		const out: CwdProcess[] = [];
		for (const entry of entries) {
			const pid = Number(entry.name);
			if (!entry.isDirectory() || !Number.isInteger(pid) || pid <= 0) continue;
			if (own.has(pid)) continue;
			let cwd: string;
			try {
				cwd = readlinkSync(`/proc/${pid}/cwd`);
			} catch {
				continue; // gone or kernel-internal
			}
			if (!underRoot(cwd, root)) continue;
			if (holdsTty(pid)) continue;
			out.push({ pid, cmd: commandOf(pid) });
		}
		return out;
	},
} satisfies Platform;
