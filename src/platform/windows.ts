// Windows implementation of the Platform contract (see index.ts).
import { spawnSync } from "node:child_process";
import type { Platform, ProcessInfo } from "./index.ts";

// One parsed JSON entry -> ProcessInfo, or null when the entry is not a real user process.
function toProcess(e: unknown): ProcessInfo | null {
	if (typeof e !== "object" || e === null) return null;
	if (!("ProcessId" in e) || !("CommandLine" in e)) return null;
	const o = e as Record<string, unknown> & {
		ProcessId: unknown;
		CommandLine: unknown;
	};
	const pid = Number(o.ProcessId);
	const cmd = o.CommandLine;
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (typeof cmd !== "string" || cmd === "") return null;
	const started = Date.parse(typeof o.Started === "string" ? o.Started : "");
	return { pid, cmd, started: Number.isNaN(started) ? 0 : started };
}

function parseProcessList(parsed: unknown): ProcessInfo[] {
	// ConvertTo-Json emits a single object (not an array) for one result, so guard for both shapes.
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const out: ProcessInfo[] = [];
	for (const e of entries) {
		const p = toProcess(e);
		if (p) out.push(p);
	}
	return out;
}

function runProcessScan(run: typeof spawnSync) {
	return run(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			"@(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,@{n='Started';e={if ($_.CreationDate) {$_.CreationDate.ToString('o')}}}) | ConvertTo-Json -Compress",
		],
		{ windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
}

export const windows = {
	killTree(pid: number, run: typeof spawnSync = spawnSync): void {
		if (pid <= 0) return;
		try {
			// /T walks the child tree, /F force-kills; a missing taskkill or a dead pid is fine.
			run("taskkill", ["/PID", String(pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
			});
		} catch {
			// killTree never throws
		}
	},

	// One snapshot of every process: id, command line, ISO start time. System processes expose a
	// null CommandLine and are skipped.
	listProcesses(run: typeof spawnSync = spawnSync): ProcessInfo[] {
		const ps = runProcessScan(run);
		const problem = ps.error ?? (ps.status !== 0 ? `exit ${ps.status}` : null);
		if (problem) throw new Error(`process scan failed: ${problem}`);
		return parseProcessList(JSON.parse(String(ps.stdout)));
	},

	samePath(a: string, b: string): boolean {
		return a.toLowerCase() === b.toLowerCase();
	},
} satisfies Platform;
