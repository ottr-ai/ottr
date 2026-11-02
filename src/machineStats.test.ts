import { describe, expect, test } from "bun:test";
import { statsFrame } from "./machineStats.ts";

const MIN = 60_000;
const GIB = 1024 ** 3;
const now = 100_000 * MIN;
const at = (minAgo: number, cpu: number, ramGiB: number) => ({
	at: now - minAgo * MIN,
	cpu,
	ramUsed: ramGiB * GIB,
});

describe("statsFrame", () => {
	test("each window averages only its own samples; the peak is the highest sample", () => {
		// Oldest first, as the sampler keeps them.
		const f = statsFrame(
			[at(1000, 90, 8), at(50, 60, 4), at(10, 20, 2), at(0, 40, 6)],
			now,
			16 * GIB,
		);
		expect(f.windows.map((w) => w.minutes)).toEqual([15, 60, 1440]);
		expect(f.windows[0]).toEqual({
			minutes: 15,
			coveredMinutes: 15,
			cpu: 30,
			cpuPeak: 40,
			ramPct: 25,
		});
		expect(f.windows[1]).toMatchObject({ cpu: 40, cpuPeak: 60, ramPct: 25 });
		expect(f.windows[2]).toMatchObject({
			cpu: 52.5,
			cpuPeak: 90,
			ramPct: 31.3,
		});
		// The top-level fields stay the 15-minute numbers the app bar meters read.
		expect(f.cpu).toBe(30);
		expect(f.ram).toEqual({ usedGiB: 4, totalGiB: 16, pct: 25 });
	});

	test("a young history reports how much of each window it covers", () => {
		const f = statsFrame([at(30, 10, 1), at(0, 30, 1)], now, 4 * GIB);
		expect(f.windows.map((w) => w.coveredMinutes)).toEqual([15, 30, 30]);
	});

	test("no samples and no RAM total give zeros, never NaN", () => {
		const f = statsFrame([], now, 0);
		expect(f.cpu).toBe(0);
		expect(f.ram.pct).toBe(0);
		for (const w of f.windows)
			expect(w).toMatchObject({
				coveredMinutes: 0,
				cpu: 0,
				cpuPeak: 0,
				ramPct: 0,
			});
	});
});
