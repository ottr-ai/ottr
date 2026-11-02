// Machine stats frame: CPU and RAM averaged over look-back windows, so a supervisor sizes runner
// caps from slow numbers (and sees a sustained overload), not a live gauge.
import type { MachineStats } from "./types.ts";

export interface StatsSample {
	at: number;
	/** CPU usage in percent over the sample's short measuring window. */
	cpu: number;
	/** RAM in use, in bytes. */
	ramUsed: number;
}

/** Look-back windows in minutes; the first one feeds the top-level cpu and ram fields. */
export const STATS_WINDOWS_MIN = [15, 60, 1440] as const;
/** Samples older than the longest window are dropped. */
export const STATS_KEEP_MS = STATS_WINDOWS_MIN.at(-1)! * 60_000;

const round = (n: number): number => Math.round(n * 10) / 10;
const avg = (xs: readonly number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

/** The frame for `samples` (oldest first) at `now`; `totalBytes` is the live RAM total.
 *  A window covers only the samples it has, so right after a start every window reads the same
 *  short span: coveredMinutes says how much of the window the numbers stand for. */
export function statsFrame(
	samples: readonly StatsSample[],
	now: number,
	totalBytes: number,
): MachineStats {
	const totalGiB = totalBytes / 1024 ** 3;
	const pctOf = (bytes: number): number =>
		totalBytes === 0 ? 0 : (100 * bytes) / totalBytes;
	const oldest = samples[0]?.at ?? now;
	const windows = STATS_WINDOWS_MIN.map((minutes) => {
		const inWin = samples.filter((s) => s.at >= now - minutes * 60_000);
		return {
			minutes,
			coveredMinutes: Math.min(minutes, Math.round((now - oldest) / 60_000)),
			cpu: round(avg(inWin.map((s) => s.cpu))),
			cpuPeak: round(Math.max(0, ...inWin.map((s) => s.cpu))),
			ramPct: round(pctOf(avg(inWin.map((s) => s.ramUsed)))),
		};
	});
	const first = samples.filter(
		(s) => s.at >= now - STATS_WINDOWS_MIN[0] * 60_000,
	);
	const usedGiB = avg(first.map((s) => s.ramUsed)) / 1024 ** 3;
	return {
		cpu: windows[0]!.cpu,
		ram: {
			usedGiB: round(usedGiB),
			totalGiB: round(totalGiB),
			pct: windows[0]!.ramPct,
		},
		windows,
	};
}
