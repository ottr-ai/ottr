import { describe, expect, test } from "bun:test";
import { type PerfFacts, perfMetrics } from "./perf.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Fixed "now" so every window and bucket index is deterministic.
const NOW = 1_800_000_000_000;

function task(
	p: Partial<PerfFacts["tasks"][number]> = {},
): PerfFacts["tasks"][number] {
	return {
		createdAt: NOW - DAY,
		doneAt: null,
		cancelled: false,
		workTurns: 1,
		hadNeedsYou: false,
		...p,
	};
}

function turn(
	p: Partial<PerfFacts["turns"][number]> = {},
): PerfFacts["turns"][number] {
	return { endedAt: NOW - HOUR, failed: false, cost: 0, ...p };
}

describe("throughput", () => {
	test("counts non-cancelled tasks done inside the window only", () => {
		const facts: PerfFacts = {
			tasks: [
				task({ doneAt: NOW - 30 * MIN }),
				task({ doneAt: NOW - 2 * DAY }), // previous window, not this one
				task({ createdAt: NOW - 3 * DAY }), // never done
			],
			turns: [],
		};
		const m = perfMetrics(facts, "24h", NOW).metrics;
		expect(m.throughput.value).toBe(1);
		expect(m.done).toBe(1);
	});

	test("excludes cancelled cards even when a done event exists", () => {
		const facts: PerfFacts = {
			tasks: [task({ doneAt: NOW - 30 * MIN, cancelled: true })],
			turns: [],
		};
		const m = perfMetrics(facts, "24h", NOW).metrics;
		expect(m.throughput.value).toBe(0);
		expect(m.done).toBe(0);
	});
});

describe("lead time", () => {
	test("median averages the two middle values, p90 is nearest-rank", () => {
		const facts: PerfFacts = {
			tasks: [
				task({ createdAt: NOW - 11 * HOUR, doneAt: NOW - 10 * HOUR }),
				task({ createdAt: NOW - 12 * HOUR, doneAt: NOW - 10 * HOUR }), // lead 2h
				task({ createdAt: NOW - 14 * HOUR, doneAt: NOW - 10 * HOUR }), // lead 4h
			],
			turns: [],
		};
		const m = perfMetrics(facts, "24h", NOW).metrics;
		expect(m.leadMedianMs.value).toBe(2 * HOUR);
		expect(m.leadP90Ms.value).toBe(4 * HOUR); // ceil(0.9·3) = 3rd of [1h,2h,4h]
	});

	test("ten samples put p90 on the 9th smallest", () => {
		const tasks = Array.from({ length: 10 }, (_, i) =>
			task({ createdAt: NOW - (i + 1) * HOUR - HOUR, doneAt: NOW - HOUR }),
		);
		const m = perfMetrics({ tasks, turns: [] }, "24h", NOW).metrics;
		expect(m.leadP90Ms.value).toBe(9 * HOUR);
	});

	test("no done cards give null lead values and null first pass", () => {
		const m = perfMetrics({ tasks: [task()], turns: [] }, "24h", NOW).metrics;
		expect(m.leadMedianMs.value).toBeNull();
		expect(m.leadP90Ms.value).toBeNull();
		expect(m.leadMedianMs.series[0]).toBeNull();
	});
});

describe("first pass", () => {
	test("exactly one work turn and no needs_you episode", () => {
		const facts: PerfFacts = {
			tasks: [
				task({ doneAt: NOW - HOUR }),
				task({ doneAt: NOW - HOUR, workTurns: 2 }),
				task({ doneAt: NOW - HOUR, hadNeedsYou: true }),
			],
			turns: [],
		};
		const m = perfMetrics(facts, "24h", NOW).metrics;
		expect(m.firstPass.value).toBe(1 / 3);
		expect(m.firstPassDone).toBe(1);
	});

	test("zero done cards give a null fraction, not zero", () => {
		const m = perfMetrics({ tasks: [], turns: [] }, "24h", NOW).metrics;
		expect(m.firstPass.value).toBeNull();
		expect(m.firstPass.series[0]).toBeNull();
	});
});

describe("failure rate", () => {
	test("failed finished turns over all finished turns in the window", () => {
		const facts: PerfFacts = {
			tasks: [],
			turns: [
				turn({ failed: true }),
				turn({ failed: false }),
				turn({ failed: false, endedAt: NOW - 2 * DAY }), // previous window
			],
		};
		const m = perfMetrics(facts, "24h", NOW).metrics;
		expect(m.failure.value).toBe(1 / 2);
		expect(m.failure.prev).toBe(0);
		expect(m.turns).toBe(2);
		expect(m.failedTurns).toBe(1);
	});

	test("no finished turns give a null rate", () => {
		const m = perfMetrics({ tasks: [], turns: [] }, "24h", NOW).metrics;
		expect(m.failure.value).toBeNull();
		expect(m.failure.series[0]).toBeNull();
	});
});

describe("spend", () => {
	test("sums captured cost; null cost counts as missing and adds nothing", () => {
		const facts: PerfFacts = {
			tasks: [],
			turns: [turn({ cost: 0.25 }), turn({ cost: null }), turn({ cost: 1 })],
		};
		const m = perfMetrics(facts, "24h", NOW).metrics;
		expect(m.spend.value).toBe(1.25);
		expect(m.costMissing).toBe(1);
	});

	test("empty buckets are 0 for throughput and spend, not null", () => {
		const m = perfMetrics({ tasks: [], turns: [] }, "24h", NOW).metrics;
		expect(m.throughput.series).toHaveLength(24);
		expect(m.throughput.series.every((v) => v === 0)).toBe(true);
		expect(m.spend.series.every((v) => v === 0)).toBe(true);
	});
});

describe("windows", () => {
	test("prev is the previous equal window; a delta shows on both sides", () => {
		const facts: PerfFacts = {
			tasks: [task({ doneAt: NOW - 30 * MIN })],
			turns: [turn({ failed: true, endedAt: NOW - 90 * MIN })],
		};
		const m = perfMetrics(facts, "1h", NOW).metrics;
		expect(m.throughput.value).toBe(1);
		expect(m.throughput.prev).toBe(0); // the done card is newer than the previous hour
		expect(m.failure.value).toBeNull(); // the failed turn ended before this window
		expect(m.failure.prev).toBe(1);
	});

	test("range all has no prev and counts from the first task", () => {
		const facts: PerfFacts = {
			tasks: [
				task({ createdAt: NOW - 10 * DAY, doneAt: NOW - 9 * DAY }),
				task({ createdAt: NOW - 3 * DAY, doneAt: NOW - 30 * MIN }),
			],
			turns: [],
		};
		const r = perfMetrics(facts, "all", NOW);
		expect(r.seriesStart).toBe(NOW - 10 * DAY);
		expect(r.metrics.throughput.value).toBe(2);
		expect(r.metrics.throughput.prev).toBeNull();
		expect(r.metrics.failure.prev).toBeNull();
	});

	test("the window excludes an input stamped at now", () => {
		const m = perfMetrics(
			{ tasks: [task({ doneAt: NOW })], turns: [turn({ endedAt: NOW })] },
			"24h",
			NOW,
		).metrics;
		expect(m.done).toBe(0);
		expect(m.turns).toBe(0);
	});
});

describe("buckets", () => {
	test("fixed ranges use the spec bucket table", () => {
		const empty: PerfFacts = { tasks: [], turns: [] };
		const got = (["1h", "24h", "7d", "30d", "90d"] as const).map(
			(range) =>
				perfMetrics(empty, range, NOW).metrics.throughput.series.length,
		);
		expect(got).toEqual([12, 24, 7, 30, 13]);
	});

	test("a done card lands in the bucket holding its done time", () => {
		const facts: PerfFacts = {
			tasks: [
				// 30 min after the window opens: first bucket [now−24h, now−23h).
				task({
					createdAt: NOW - 23 * HOUR - 45 * MIN,
					doneAt: NOW - 23 * HOUR - 30 * MIN,
				}),
				task({ createdAt: NOW - HOUR, doneAt: NOW - 30 * MIN }),
			],
			turns: [],
		};
		const series = perfMetrics(facts, "24h", NOW).metrics.throughput.series;
		expect(series[0]).toBe(1);
		expect(series[23]).toBe(1); // last bucket: [now−1h, now)
		expect(series.reduce((a, b) => a! + b!, 0)).toBe(2);
	});

	test("range all starts at the earliest task with 7-day buckets", () => {
		const facts: PerfFacts = {
			tasks: [task({ createdAt: NOW - 10 * DAY })],
			turns: [],
		};
		const r = perfMetrics(facts, "all", NOW);
		expect(r.bucketMs).toBe(7 * DAY);
		expect(r.seriesStart).toBe(NOW - 10 * DAY);
		expect(r.metrics.throughput.series).toHaveLength(2); // ceil(10/7)
	});

	test("past 52 weekly buckets the series switches to 30-day buckets", () => {
		const facts: PerfFacts = {
			tasks: [task({ createdAt: NOW - 730 * DAY })],
			turns: [],
		};
		const r = perfMetrics(facts, "all", NOW);
		expect(r.bucketMs).toBe(30 * DAY);
		expect(r.metrics.throughput.series).toHaveLength(25); // ceil(730/30)
		expect(r.metrics.throughput.series[0]).toBe(0);
	});

	test("no tasks give one bucket ending at now", () => {
		const r = perfMetrics({ tasks: [], turns: [] }, "all", NOW);
		expect(r.bucketMs).toBe(7 * DAY);
		expect(r.metrics.throughput.series).toHaveLength(1);
		expect(r.seriesStart).toBe(NOW - 7 * DAY);
	});

	test("an explicit start aligns a project series with the fleet series", () => {
		const old: PerfFacts = {
			tasks: [task({ createdAt: NOW - 730 * DAY })],
			turns: [],
		};
		const young: PerfFacts = {
			tasks: [task({ createdAt: NOW - DAY })],
			turns: [],
		};
		const fleet = perfMetrics(old, "all", NOW);
		const project = perfMetrics(young, "all", NOW, fleet.seriesStart);
		expect(project.seriesStart).toBe(fleet.seriesStart);
		expect(project.bucketMs).toBe(fleet.bucketMs);
		expect(project.metrics.throughput.series).toHaveLength(
			fleet.metrics.throughput.series.length,
		);
		// The young project's done card sits in the last fleet-aligned bucket.
		const done = perfMetrics(
			{
				tasks: [task({ createdAt: NOW - DAY, doneAt: NOW - HOUR })],
				turns: [],
			},
			"all",
			NOW,
			fleet.seriesStart,
		);
		const series = done.metrics.throughput.series;
		expect(series[series.length - 1]).toBe(1);
		expect(series.reduce((a, b) => a! + b!, 0)).toBe(1);
	});
});
