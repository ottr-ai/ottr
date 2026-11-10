// Every OS-specific operation the tracker needs sits behind this interface; the rest of the code stays OS-neutral.
import { unix } from "./unix.ts";
import { windows } from "./windows.ts";

export interface ProcessInfo {
	pid: number;
	cmd: string;
	/** Process start time as epoch ms; 0 when the platform does not report it. */
	started: number;
}

/** A process whose working directory sits inside a tree a caller is about to destroy (OTTR-697). */
export interface CwdProcess {
	pid: number;
	/** Full command line; the comm name when the kernel reports no argv; "(unknown)" when neither is readable. */
	cmd: string;
}

export interface Platform {
	/**
	 * Kills `pid` and every process descended from it. Synchronous, so it also works inside a process
	 * "exit" handler. Never throws: processes that are already gone are fine. `pid <= 0` is a no-op.
	 */
	killTree(pid: number): void;
	/**
	 * One snapshot of every running process. Throws with a readable Error when the listing fails;
	 * callers must surface that, never treat it as an empty list.
	 */
	listProcesses(): ProcessInfo[];
	/**
	 * Working directory of `pid`, absolute; "" when the platform cannot report it (process gone,
	 * no permission, or the OS exposes no cwd). Advisory input for orphan facts only.
	 */
	cwdOf(pid: number): string;
	/**
	 * Read-only snapshot of every process whose working directory is `root` or below — the
	 * discovery half of a reap before destroying `root` (worktrunk's `wt remove --reap`).
	 * Never names the calling process, its descendants (the tracker's own turn tree), or a
	 * process holding a controlling terminal (interactive shells and editors are never safe
	 * to signal from a sweep). [] on platforms with no read-only foreign-cwd discovery
	 * (Windows, non-Linux unix targets). Never throws.
	 */
	processesWithCwdUnder(root: string): CwdProcess[];
	/** True when two absolute, slash-normalized paths name the same folder under the OS's case rules. */
	samePath(a: string, b: string): boolean;
}

// ponytail: macOS runs the unix implementation until it needs its own (Terminal.app, osascript dialog, case-insensitive paths).
export const platform: Platform = process.platform === "win32" ? windows : unix;
