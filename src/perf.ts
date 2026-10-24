// Pure Overview performance metrics: windows, buckets, and the
// metric table over plain facts. No store or I/O here — the store shapes the facts
// (ProjectStore.perfFacts) and the route aligns the fleet and per-project layouts.
import type { PerfMetrics, PerfRange, PerfStat } from "./types.ts";

/** One task, flattened to what the metric table needs. `doneAt` is the latest
 * stage→done event time; `workTurns` counts every work turn ever; `hadNeedsYou` is
 * any state→needs_you event (the first-pass penalty). */
export interface PerfFacts {
	tasks: {
		createdAt: number;
		doneAt: number | null;
		cancelled: boolean;
		workTurns: number;
		hadNeedsYou: boolean;
	}[];
	/** Finished turns only (ended_at not null), each with its SQL-semantics failure flag. */
	turns: { endedAt: number; failed: boolean; cost: number | null }[];
}

const WEEK = 604_800_000;
const MONTH = 2_592_000_000;

/** Bucket layout per fixed range (spec table); the span is buckets × bucketMs, so the
 * 90d window is 13 × 7 d = 91 d — the buckets, not the label, are the source of truth. */
const RANGE_SHAPE: Record<
	Exclude<PerfRange, "all">,
	{ buckets: number; bucketMs: number }
> = {
	"1h": { buckets: 12, bucketMs: 300_000 },
	"24h": { buckets: 24, bucketMs: 3_600_000 },
	"7d": { buckets: 7, bucketMs: 86_400_000 },
	"30d": { buckets: 30, bucketMs: 86_400_000 },
	"90d": { buckets: 13, bucketMs: WEEK },
};

/** One window's raw inputs: the done cards (for lead time and first pass) and the
 * finished turns (for failure rate and spend) whose timestamps fall in [w0, w1). */
interface Slice {
	done: { leadMs: number; firstPass: boolean }[];
	turns: { failed: boolean; cost: number | null }[];
}

function slice(facts: PerfFacts, w0: number, w1: number): Slice {
	return {
		done: facts.tasks.flatMap((t) =>
			t.cancelled || t.doneAt === null || t.doneAt < w0 || t.doneAt >= w1
				? []
				: [
						{
							leadMs: t.doneAt - t.createdAt,
							firstPass: t.workTurns === 1 && !t.hadNeedsYou,
						},
					],
		),
		turns: facts.turns.filter((t) => t.endedAt >= w0 && t.endedAt < w1),
	};
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile: ceil(p·n)-th smallest, 1-indexed. */
function nearestRank(xs: number[], p: number): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.ceil(p * s.length) - 1]!;
}

/**
 * Metrics for `range` over `facts`, with the sparkline buckets ending at `now`.
 * Windows are [since, now) and the previous equal range [since − span, since); `prev`
 * is null for "all". For "all" the series starts at the earliest task passed in, or at
 * the caller's `start` — the route passes the fleet's start so every project series
 * aligns with the fleet series. Buckets switch from 7 d to 30 d past 52 buckets, and
 * collapse to one bucket when there are no tasks at all.
 */
export function perfMetrics(
	facts: PerfFacts,
	range: PerfRange,
	now: number,
	start?: number,
): { bucketMs: number; seriesStart: number; metrics: PerfMetrics } {
	let bucketMs: number;
	let seriesStart: number;
	let buckets: number;
	if (range === "all") {
		seriesStart = start ?? minCreatedAt(facts) ?? now - WEEK;
		// Derived from (seriesStart, now) only, so a project call with the fleet's start
		// lands on the same bucketMs as the fleet call.
		bucketMs = Math.ceil((now - seriesStart) / WEEK) > 52 ? MONTH : WEEK;
		buckets = Math.max(1, Math.ceil((now - seriesStart) / bucketMs));
	} else {
		const shape = RANGE_SHAPE[range];
		bucketMs = shape.bucketMs;
		buckets = shape.buckets;
		seriesStart = now - buckets * bucketMs;
	}
	const since = seriesStart;
	const cur = slice(facts, since, now);
	// The previous window only exists for a fixed range; the slice is computed once and
	// reused by every metric's prev.
	const prevWindow =
		range === "all" ? null : slice(facts, since - (now - since), since);
	const stat = (derive: (s: Slice) => number | null): PerfStat => ({
		value: derive(cur),
		prev: prevWindow === null ? null : derive(prevWindow),
		series: Array.from({ length: buckets }, (_, i) =>
			derive(
				slice(
					facts,
					seriesStart + i * bucketMs,
					Math.min(seriesStart + (i + 1) * bucketMs, now),
				),
			),
		),
	});
	const firstPassCount = cur.done.filter((d) => d.firstPass).length;
	return {
		bucketMs,
		seriesStart,
		metrics: {
			throughput: stat((s) => s.done.length),
			leadMedianMs: stat((s) => median(s.done.map((d) => d.leadMs))),
			leadP90Ms: stat((s) =>
				nearestRank(
					s.done.map((d) => d.leadMs),
					0.9,
				),
			),
			firstPass: stat((s) =>
				s.done.length === 0
					? null
					: s.done.filter((d) => d.firstPass).length / s.done.length,
			),
			failure: stat((s) =>
				s.turns.length === 0
					? null
					: s.turns.filter((t) => t.failed).length / s.turns.length,
			),
			spend: stat((s) => s.turns.reduce((sum, t) => sum + (t.cost ?? 0), 0)),
			done: cur.done.length,
			firstPassDone: firstPassCount,
			turns: cur.turns.length,
			failedTurns: cur.turns.filter((t) => t.failed).length,
			costMissing: cur.turns.filter((t) => t.cost === null).length,
		},
	};
}

function minCreatedAt(facts: PerfFacts): number | null {
	let min: number | null = null;
	for (const t of facts.tasks)
		if (min === null || t.createdAt < min) min = t.createdAt;
	return min;
}
