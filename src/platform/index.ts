// Every OS-specific operation the tracker needs sits behind this interface; the rest of the code stays OS-neutral.
import { unix } from "./unix.ts";
import { windows } from "./windows.ts";

export interface ProcessInfo {
	pid: number;
	cmd: string;
	/** Process start time as epoch ms; 0 when the platform does not report it. */
	started: number;
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
	/** True when two absolute, slash-normalized paths name the same folder under the OS's case rules. */
	samePath(a: string, b: string): boolean;
}

// ponytail: macOS runs the unix implementation until it needs its own (Terminal.app, osascript dialog, case-insensitive paths).
export const platform: Platform = process.platform === "win32" ? windows : unix;
