// ompStats contract tests: transcript scanning, record strictness, merge, report build.
// Fixtures are synthetic transcript files in the shape tracker turns write.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildOmpStatsReport,
	mergeOmpStats,
	type OmpStats,
	type OmpStatsSource,
	type OmpUsageTotals,
	scanSessionUsage,
} from "./ompStats.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-omp-stats-"));

/** The all-zero totals block every partial fixture starts from: parseable, no rates. */
const BASE: OmpUsageTotals = {
	totalRequests: 0,
	successfulRequests: 0,
	failedRequests: 0,
	errorRate: null,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheWriteTokens: 0,
	cacheRate: null,
	cacheSavings: null,
	totalCost: 0,
	unpricedRequests: 0,
	totalPremiumRequests: 0,
	avgDuration: null,
	avgTtft: null,
	avgTokensPerSecond: null,
	firstTimestamp: null,
	lastTimestamp: null,
};

/** One assistant usage record line in a tracker transcript. */
const usageLine = (o: {
	model?: string;
	timestamp?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}) =>
	JSON.stringify({
		type: "message",
		timestamp: o.timestamp ?? "2026-11-07T12:00:00.000Z",
		message: {
			role: "assistant",
			model: o.model ?? "zai/glm-5.3-flash",
			provider: "zai",
			usage: {
				input: o.input ?? 10,
				output: o.output ?? 5,
				cacheRead: o.cacheRead ?? 100,
				cacheWrite: o.cacheWrite ?? 20,
				cost: { total: o.cost ?? 0.01 },
			},
		},
	});

const stats = (
	overall: Partial<OmpUsageTotals>,
	byModel: OmpStats["byModel"] = [],
): OmpStats => ({
	overall: { ...BASE, ...overall },
	byModel,
});

describe("scanSessionUsage", () => {
	test("sums main and subagent transcripts of one dir", () => {
		const root = join(dir, "scan-ok");
		const sessions = join(root, "sessions");
		const sub = join(sessions, "1_sess-1");
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(sessions, "1_sess-1.jsonl"),
			[
				usageLine({ input: 10, output: 5, cost: 0.25 }),
				'{"type":"session"}',
				"",
			].join("\n"),
		);
		writeFileSync(
			join(sub, "sub-1.jsonl"),
			usageLine({ model: "claude-opus-5-5", input: 99, output: 9, cost: 0.75 }),
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(2);
		expect(answer.stats?.overall.totalInputTokens).toBe(109);
		expect(answer.stats?.overall.totalOutputTokens).toBe(14);
		expect(answer.stats?.overall.totalCost).toBeCloseTo(1);
		expect(answer.stats?.overall.cacheRate).toBeCloseTo(200 / 309);
		expect(answer.stats?.overall.firstTimestamp).toBe(
			Date.parse("2026-11-07T12:00:00.000Z"),
		);
		expect(answer.stats?.byModel.map((m) => m.model)).toEqual([
			"claude-opus-5-5",
			"zai/glm-5.3-flash",
		]);
	});

	test("a missing dir answers the zero totals as a fresh project", () => {
		const answer = scanSessionUsage(join(dir, "no-such-dir", "sessions"));
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall).toEqual(BASE);
		expect(answer.stats?.byModel).toEqual([]);
	});

	test("a malformed record voids the store instead of under-reporting", () => {
		const root = join(dir, "scan-bad");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_sess-2.jsonl"),
			`${usageLine({ cost: 9 })}\n{broken\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.stats).toBeNull();
		expect(answer.error).toContain("not a JSON object");
		expect(answer.error).toContain("1_sess-2.jsonl");
	});

	test("a non-jsonl file is not a transcript and is ignored", () => {
		const root = join(dir, "scan-mixed");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "notes.txt"), "not a transcript");
		writeFileSync(join(sessions, "1_sess-3.jsonl"), usageLine({ cost: 0.5 }));
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
	});

	test("records without a model or price count as unknown and unpriced", () => {
		const root = join(dir, "scan-unknown");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_sess-4.jsonl"),
			[
				JSON.stringify({
					type: "message",
					timestamp: "2026-11-07T13:00:00.000Z",
					message: { role: "assistant", usage: { input: 1, output: 1 } },
				}),
			].join("\n"),
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.stats?.byModel[0]?.model).toBe("unknown");
		expect(answer.stats?.overall.unpricedRequests).toBe(1);
	});
});

describe("mergeOmpStats", () => {
	const row = (
		model: string,
		cost: number,
		requests = 1,
	): OmpStats["byModel"][number] => ({
		...BASE,
		model,
		totalRequests: requests,
		totalCost: cost,
	});

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

	test("folds byModel by model, sorted by cost first", () => {
		const m = mergeOmpStats([
			stats({}, [row("m", 1), row("other", 4)]),
			stats({}, [row("m", 2)]),
		]);
		expect(m.byModel[0]).toMatchObject({ model: "other", totalCost: 4 });
		expect(m.byModel[1]).toMatchObject({ model: "m", totalCost: 3 });
	});

	test("an empty merge answers the zero totals with no rows", () => {
		const m = mergeOmpStats([]);
		expect(m.overall).toEqual(BASE);
		expect(m.byModel).toEqual([]);
	});
});

describe("buildOmpStatsReport", () => {
	test("merges across stores; every source keeps its own answer", () => {
		const board = stats({ totalRequests: 3, totalCost: 3 });
		const project = stats({ totalRequests: 7, totalCost: 7 });
		const sources: OmpStatsSource[] = [
			{ name: "board store", answer: { stats: board, error: null } },
			{ name: "lumen", answer: { stats: project, error: null } },
			{ name: "worker-gone", answer: { stats: null, error: "down" } },
		];
		const report = buildOmpStatsReport(sources, 1234);
		expect(report.at).toBe(1234);
		expect(report.sources).toHaveLength(3);
		expect(report.overall.totalRequests).toBe(10);
		expect(report.overall.totalCost).toBe(10);
	});
});
