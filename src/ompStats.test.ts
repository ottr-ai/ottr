// ompStats contract tests: parse, merge, dedupe, and the two reads (spawn + fetch).
// The spawn tests run fixture scripts instead of omp, so the suite stays hermetic.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildOmpStatsReport,
	distinctOmpStats,
	fetchWorkerOmpStats,
	mergeOmpStats,
	type OmpStats,
	type OmpStatsSource,
	type OmpUsageTotals,
	parseOmpStats,
	runOmpStats,
} from "./ompStats.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-omp-stats-"));

/** A fixture shaped like omp 18.14.0's `omp stats --json`, with an extra unknown key to
 *  prove future fields never block a read. */
const FIXTURE = {
	overall: {
		totalRequests: 13,
		successfulRequests: 13,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 34,
		totalOutputTokens: 2631,
		totalCacheReadTokens: 234064,
		totalCacheWriteTokens: 48742,
		cacheRate: 0.9998547616810054,
		cacheSavings: 0.6138410408711639,
		totalCost: 0.4895,
		unpricedRequests: 0,
		totalPremiumRequests: 0,
		avgDuration: 3819.79,
		avgTtft: 1906.4,
		avgTokensPerSecond: 58.31,
		firstTimestamp: 1794051235670,
		lastTimestamp: 1794073633743,
		unknownFutureField: "ignored",
	},
	byModel: [
		{
			model: "claude-opus-5-5",
			provider: "anthropic",
			totalRequests: 13,
			totalCost: 0.4895,
		},
	],
	unknownTopLevel: [],
};

/** The all-zero totals block every partial fixture starts from: parseable, no rates. */
const BASE: OmpUsageTotals = parseOmpStats({
	overall: { totalRequests: 0 },
})!.overall;

const stats = (
	overall: Partial<OmpUsageTotals>,
	byModel: OmpStats["byModel"] = [],
): OmpStats => ({
	overall: { ...BASE, ...overall },
	byModel,
});

/** Writes an executable fixture script the spawn tests run as the omp binary. */
function script(name: string, body: string): string {
	const path = join(dir, `${name}.sh`);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("parseOmpStats", () => {
	test("parses omp's shape, keeping extra unknown keys harmless", () => {
		const s = parseOmpStats(FIXTURE);
		expect(s).not.toBeNull();
		expect(s?.overall.totalRequests).toBe(13);
		expect(s?.overall.totalCost).toBeCloseTo(0.4895);
		expect(s?.overall.cacheRate).toBeCloseTo(0.99985);
		expect(s?.byModel).toEqual([
			{
				...BASE,
				totalRequests: 13,
				totalCost: 0.4895,
				model: "claude-opus-5-5",
				provider: "anthropic",
			},
		]);
	});

	test("a fresh store: missing byModel answers [], absent rates answer null", () => {
		const s = parseOmpStats({ overall: { totalRequests: 0 } });
		expect(s?.overall.totalRequests).toBe(0);
		expect(s?.overall.errorRate).toBeNull();
		expect(s?.overall.cacheRate).toBeNull();
		expect(s?.overall.firstTimestamp).toBeNull();
		expect(s?.byModel).toEqual([]);
	});

	test("anything without a numeric overall block answers null", () => {
		expect(parseOmpStats(null)).toBeNull();
		expect(parseOmpStats("nope")).toBeNull();
		expect(parseOmpStats([])).toBeNull();
		expect(parseOmpStats({})).toBeNull();
		expect(parseOmpStats({ overall: { totalRequests: "13" } })).toBeNull();
		expect(parseOmpStats({ overall: null })).toBeNull();
	});

	test("byModel rows without a model name drop; provider may be absent", () => {
		const s = parseOmpStats({
			overall: { totalRequests: 1 },
			byModel: [{ totalRequests: 5 }, { model: "m", totalRequests: 2 }],
		});
		expect(s?.byModel).toHaveLength(1);
		expect(s?.byModel[0]?.model).toBe("m");
		expect(s?.byModel[0]?.provider).toBeNull();
	});
});

describe("mergeOmpStats", () => {
	test("sums counts and cost, recomputes the rates, weights the averages", () => {
		const a = stats({
			totalRequests: 100,
			failedRequests: 4,
			totalInputTokens: 1000,
			totalCacheReadTokens: 9000,
			cacheSavings: 0.5,
			avgDuration: 1000,
			totalCost: 1,
			firstTimestamp: 100,
			lastTimestamp: 200,
		});
		const b = stats({
			totalRequests: 10,
			failedRequests: 1,
			totalInputTokens: 1000,
			totalCacheReadTokens: 0,
			cacheSavings: 0.9,
			avgDuration: 2000,
			totalCost: 2,
			firstTimestamp: 50,
			lastTimestamp: 300,
		});
		const m = mergeOmpStats([a, b]);
		expect(m.overall.totalRequests).toBe(110);
		expect(m.overall.failedRequests).toBe(5);
		expect(m.overall.errorRate).toBeCloseTo(5 / 110);
		expect(m.overall.totalInputTokens).toBe(2000);
		expect(m.overall.cacheRate).toBeCloseTo(9000 / 11000);
		// Request-weighted: (0.5*100 + 0.9*10) / 110, not the plain mean.
		expect(m.overall.cacheSavings).toBeCloseTo((0.5 * 100 + 0.9 * 10) / 110);
		expect(m.overall.avgDuration).toBeCloseTo((1000 * 100 + 2000 * 10) / 110);
		expect(m.overall.totalCost).toBe(3);
		expect(m.overall.firstTimestamp).toBe(50);
		expect(m.overall.lastTimestamp).toBe(300);
	});

	test("folds byModel by model+provider; same model under two providers stays two rows", () => {
		const row = (
			model: string,
			provider: string | null,
			cost: number,
		): OmpStats["byModel"][number] => ({
			...BASE,
			model,
			provider,
			totalRequests: 1,
			totalCost: cost,
		});
		const m = mergeOmpStats([
			stats({}, [row("m", "anthropic", 1), row("m", null, 4)]),
			stats({}, [row("m", "anthropic", 2)]),
		]);
		expect(m.byModel).toHaveLength(2);
		// Sorted by cost, highest first.
		expect(m.byModel[0]).toMatchObject({
			model: "m",
			provider: null,
			totalCost: 4,
		});
		expect(m.byModel[1]).toMatchObject({
			model: "m",
			provider: "anthropic",
			totalCost: 3,
		});
	});

	test("an empty merge answers the zero totals with no rows", () => {
		const m = mergeOmpStats([]);
		expect(m.overall).toEqual(BASE);
		expect(m.byModel).toEqual([]);
	});
});

describe("distinctOmpStats", () => {
	test("drops only byte-identical payloads, keeping the first order", () => {
		const a = stats({ totalRequests: 1 });
		const b = stats({ totalRequests: 2 });
		expect(distinctOmpStats([a, b, a, a])).toEqual([a, b]);
	});
});

describe("buildOmpStatsReport", () => {
	test("merges over the distinct stores; every source keeps its own answer", () => {
		const shared = stats({ totalRequests: 7, totalCost: 7 });
		const board = stats({ totalRequests: 3, totalCost: 3 });
		const sources: OmpStatsSource[] = [
			{ name: "server", board: true, answer: { stats: board, error: null } },
			{
				name: "worker-a",
				board: false,
				answer: { stats: shared, error: null },
			},
			{
				name: "worker-b",
				board: false,
				answer: { stats: shared, error: null },
			},
			{
				name: "worker-c",
				board: false,
				answer: { stats: null, error: "down" },
			},
		];
		const report = buildOmpStatsReport(sources, 1234);
		expect(report.at).toBe(1234);
		expect(report.sources).toHaveLength(4);
		// worker-b repeats worker-a's store: counted once, not twice.
		expect(report.overall.totalRequests).toBe(10);
		expect(report.overall.totalCost).toBe(10);
	});
});

describe("runOmpStats", () => {
	test("parses a fixture stdout", async () => {
		const bin = script("ok", `echo '${JSON.stringify(FIXTURE)}'`);
		const answer = await runOmpStats({ bin });
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(13);
	});

	test("a non-zero exit answers the code and the stderr tail", async () => {
		const bin = script("fail", 'echo "sync boom" >&2; exit 2');
		const answer = await runOmpStats({ bin });
		expect(answer.stats).toBeNull();
		expect(answer.error).toContain("exited with code 2");
		expect(answer.error).toContain("sync boom");
	});

	test("garbage stdout answers no valid JSON", async () => {
		const bin = script("garbage", "echo 'not json'");
		const answer = await runOmpStats({ bin });
		expect(answer.stats).toBeNull();
		expect(answer.error).toContain("no valid JSON");
	});

	test("JSON without an overall block answers unusable", async () => {
		const bin = script("hollow", "echo '{\"byModel\":[]}'");
		const answer = await runOmpStats({ bin });
		expect(answer.error).toContain("without an overall block");
	});

	test("a missing binary answers failed to start", async () => {
		const answer = await runOmpStats({ bin: join(dir, "no-such-bin") });
		expect(answer.stats).toBeNull();
		expect(answer.error).toContain("failed to start");
	});

	test("a hung child is killed at the timeout", async () => {
		const bin = script("hung", "sleep 5");
		const answer = await runOmpStats({ bin, timeoutMs: 300 });
		expect(answer.stats).toBeNull();
		expect(answer.error).toContain("timed out");
	}, 10_000);
});

describe("fetchWorkerOmpStats", () => {
	test("returns the worker's parsed stats", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: (req) =>
				req.headers.get("x-otwr-token") !== "tok"
					? new Response("unauthorized", { status: 401 })
					: Response.json({ stats: FIXTURE, error: null }),
		});
		try {
			const answer = await fetchWorkerOmpStats(
				`http://127.0.0.1:${srv.port}`,
				"tok",
			);
			expect(answer.error).toBeNull();
			expect(answer.stats?.overall.totalRequests).toBe(13);
		} finally {
			srv.stop(true);
		}
	});

	test("a worker-side failure passes its error through", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: () => Response.json({ stats: null, error: "omp exploded" }),
		});
		try {
			const answer = await fetchWorkerOmpStats(
				`http://127.0.0.1:${srv.port}`,
				undefined,
			);
			expect(answer.stats).toBeNull();
			expect(answer.error).toBe("omp exploded");
		} finally {
			srv.stop(true);
		}
	});

	test("non-200, junk bodies, and dead ports answer error strings", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: () => new Response("no", { status: 500 }),
		});
		try {
			expect(
				(await fetchWorkerOmpStats(`http://127.0.0.1:${srv.port}`, undefined))
					.error,
			).toContain("HTTP 500");
		} finally {
			srv.stop(true);
		}
		const junk = Bun.serve({
			port: 0,
			fetch: () => Response.json({ stats: "junk" }),
		});
		try {
			expect(
				(await fetchWorkerOmpStats(`http://127.0.0.1:${junk.port}`, undefined))
					.error,
			).toContain("no usable");
		} finally {
			junk.stop(true);
		}
		expect(
			(await fetchWorkerOmpStats("http://127.0.0.1:1", undefined, 500)).error,
		).toContain("GET /omp-stats failed");
	});
});
