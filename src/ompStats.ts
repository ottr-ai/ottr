// omp usage: the board sums the usage records of omp session transcripts itself. omp's
// `stats` command only syncs the default session store under ~/.omp/agent/sessions, while
// tracker turns write their transcripts to each project's sessions dir (--session-dir), so
// the CLI sees almost none of the fleet's usage. The board scans every project dir it
// mounts plus the default stores and aggregates the same per-message records omp's rollups
// use: assistant messages carrying usage (input/output/cacheRead/cacheWrite/cost/model).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** One omp usage total block: the rollup fields the Settings card shows. Rates and
 *  averages that transcripts cannot prove (request failures, durations, omp's cost-model
 *  savings) stay null — a null is "no basis", never a fabricated zero. Durations would be
 *  milliseconds; timestamps are epoch ms. */
export interface OmpUsageTotals {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** cacheRead / (input + cacheRead), omp's own formula; null without a denominator. */
	cacheRate: number | null;
	/** Not derivable from transcripts: null. */
	cacheSavings: number | null;
	totalCost: number;
	/** Requests whose model priced nothing while tokens moved. */
	unpricedRequests: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number | null;
	lastTimestamp: number | null;
}

/** One model's totals in the report's byModel list. */
export interface OmpModelUsage extends OmpUsageTotals {
	model: string;
}

/** The aggregated usage of one store: overall totals plus one row per model. */
export interface OmpStats {
	overall: OmpUsageTotals;
	byModel: OmpModelUsage[];
}

/** What one store's scan answers: parsed numbers, or the reason there are none. Always a
 *  200-shaped answer — a failed read is data, not a failed request. */
export interface OmpStatsAnswer {
	stats: OmpStats | null;
	error: string | null;
}

/** One scanned store for the report: the board's or the workers' default omp store, or a
 *  project's turn-session dir (name = the project). */
export interface OmpStatsSource {
	name: string;
	answer: OmpStatsAnswer;
}

/** The Settings card payload: every source's answer plus totals + per-model rows merged
 *  across the stores. */
export interface OmpStatsReport {
	at: number;
	sources: OmpStatsSource[];
	overall: OmpUsageTotals;
	byModel: OmpModelUsage[];
}

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

const isRate = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

/** Epoch ms of an ISO timestamp; null when the record carries none omp would window by. */
function ts(v: unknown): number | null {
	if (typeof v !== "string") return null;
	const at = Date.parse(v);
	return Number.isNaN(at) ? null : at;
}

const ZEROS: OmpUsageTotals = {
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

/** Merges totals blocks: counts and cost sum; errorRate and cacheRate recompute from the
 *  summed counts (cacheRate = cacheRead / (input + cacheRead), omp's formula on 18.14.0);
 *  the request-weighted averages carry over; timestamps span. */
function mergeTotals(rows: OmpUsageTotals[]): OmpUsageTotals {
	if (rows.length === 0) return { ...ZEROS };
	const sum = (pick: (r: OmpUsageTotals) => number): number =>
		rows.reduce((n, r) => n + pick(r), 0);
	const total = sum((r) => r.totalRequests);
	const input = sum((r) => r.totalInputTokens);
	const cacheRead = sum((r) => r.totalCacheReadTokens);
	// Request-weighted: an average over merged stores must weight each store by its
	// request count, not by store count. Stores without a value contribute nothing.
	const weighted = (
		pick: (r: OmpUsageTotals) => number | null,
	): number | null => {
		let acc = 0;
		let weight = 0;
		for (const r of rows) {
			const v = pick(r);
			if (v !== null) {
				acc += v * r.totalRequests;
				weight += r.totalRequests;
			}
		}
		return weight > 0 ? acc / weight : null;
	};
	const first = rows.flatMap((r) =>
		r.firstTimestamp === null ? [] : [r.firstTimestamp],
	);
	const last = rows.flatMap((r) =>
		r.lastTimestamp === null ? [] : [r.lastTimestamp],
	);
	return {
		totalRequests: total,
		successfulRequests: sum((r) => r.successfulRequests),
		failedRequests: sum((r) => r.failedRequests),
		errorRate: total > 0 ? sum((r) => r.failedRequests) / total : null,
		totalInputTokens: input,
		totalOutputTokens: sum((r) => r.totalOutputTokens),
		totalCacheReadTokens: cacheRead,
		totalCacheWriteTokens: sum((r) => r.totalCacheWriteTokens),
		cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
		cacheSavings: weighted((r) => r.cacheSavings),
		totalCost: sum((r) => r.totalCost),
		unpricedRequests: sum((r) => r.unpricedRequests),
		totalPremiumRequests: sum((r) => r.totalPremiumRequests),
		avgDuration: weighted((r) => r.avgDuration),
		avgTtft: weighted((r) => r.avgTtft),
		avgTokensPerSecond: weighted((r) => r.avgTokensPerSecond),
		firstTimestamp: first.length > 0 ? Math.min(...first) : null,
		lastTimestamp: last.length > 0 ? Math.max(...last) : null,
	};
}

/** Folds parsed stats blocks into one: totals sum, byModel rows fold by model with the
 *  same merge rules. Empty input answers the zero totals with no rows. */
export function mergeOmpStats(stats: OmpStats[]): OmpStats {
	const rows = new Map<string, OmpUsageTotals[]>();
	for (const s of stats) {
		for (const m of s.byModel) {
			const list = rows.get(m.model) ?? [];
			list.push(m);
			rows.set(m.model, list);
		}
	}
	return {
		overall: mergeTotals(stats.map((s) => s.overall)),
		byModel: [...rows.entries()]
			.map(([model, list]) => ({ ...mergeTotals(list), model }))
			.sort((a, b) =>
				b.totalCost !== a.totalCost
					? b.totalCost - a.totalCost
					: a.model.localeCompare(b.model),
			),
	};
}

/** Builds the report: totals and per-model rows merged across the stores; every source
 *  keeps its own answer either way, so the breakdown shows what each store reported. */
export function buildOmpStatsReport(
	sources: OmpStatsSource[],
	at: number,
): OmpStatsReport {
	const merged = mergeOmpStats(
		sources.flatMap((s) => (s.answer.stats === null ? [] : [s.answer.stats])),
	);
	return { at, sources, overall: merged.overall, byModel: merged.byModel };
}

/** One usage record: an assistant message's usage (retro.ts reads the same shape). */
interface UsageRecord {
	model: string;
	timestamp: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Collects the usage records of one transcript text. Null when a non-blank line is not a
 *  JSON object: a skipped record could hide usage, so one malformed line voids the file
 *  (the same strictness the turn-cost backfill applies). */
function readUsageRecords(text: string): UsageRecord[] | null {
	const out: UsageRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let d: unknown;
		try {
			d = JSON.parse(line);
		} catch {
			return null;
		}
		if (typeof d !== "object" || d === null) return null;
		if (!("type" in d) || d.type !== "message") continue;
		if (
			!("message" in d) ||
			typeof d.message !== "object" ||
			d.message === null
		)
			continue;
		const m: object = d.message;
		if (!("role" in m) || m.role !== "assistant") continue;
		if (!("usage" in m) || typeof m.usage !== "object" || m.usage === null)
			continue;
		const u: object = m.usage;
		const count = (v: unknown): number => (isCount(v) ? v : 0);
		const model =
			"model" in m && typeof m.model === "string" && m.model.length > 0
				? m.model
				: "unknown";
		let cost = 0;
		if ("cost" in u && typeof u.cost === "object" && u.cost !== null) {
			const c: object = u.cost;
			if ("total" in c && isRate(c.total)) cost = c.total;
		}
		out.push({
			model,
			timestamp: ts("timestamp" in d ? d.timestamp : undefined),
			input: count("input" in u ? u.input : undefined),
			output: count("output" in u ? u.output : undefined),
			cacheRead: count("cacheRead" in u ? u.cacheRead : undefined),
			cacheWrite: count("cacheWrite" in u ? u.cacheWrite : undefined),
			cost,
		});
	}
	return out;
}

/** Aggregates usage records into one store's stats. Each record is one request; failures
 *  leave no assistant message, so they are invisible here and the rates that need them
 *  stay null. */
function aggregate(records: UsageRecord[]): OmpStats {
	const totals = (rows: UsageRecord[]): OmpUsageTotals => {
		if (rows.length === 0) return { ...ZEROS };
		const sum = (pick: (r: UsageRecord) => number): number =>
			rows.reduce((n, r) => n + pick(r), 0);
		const input = sum((r) => r.input);
		const cacheRead = sum((r) => r.cacheRead);
		const first = rows.flatMap((r) =>
			r.timestamp === null ? [] : [r.timestamp],
		);
		const last = rows.flatMap((r) =>
			r.timestamp === null ? [] : [r.timestamp],
		);
		return {
			totalRequests: rows.length,
			successfulRequests: rows.length,
			failedRequests: 0,
			errorRate: null,
			totalInputTokens: input,
			totalOutputTokens: sum((r) => r.output),
			totalCacheReadTokens: cacheRead,
			totalCacheWriteTokens: sum((r) => r.cacheWrite),
			cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
			cacheSavings: null,
			totalCost: sum((r) => r.cost),
			unpricedRequests: rows.filter(
				(r) =>
					r.cost === 0 && r.input + r.output + r.cacheRead + r.cacheWrite > 0,
			).length,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: first.length > 0 ? Math.min(...first) : null,
			lastTimestamp: last.length > 0 ? Math.max(...last) : null,
		};
	};
	const byModelRows = new Map<string, UsageRecord[]>();
	for (const r of records) {
		const list = byModelRows.get(r.model) ?? [];
		list.push(r);
		byModelRows.set(r.model, list);
	}
	return {
		overall: totals(records),
		byModel: [...byModelRows.entries()]
			.map(([model, rows]) => ({ ...totals(rows), model }))
			.sort((a, b) =>
				b.totalCost !== a.totalCost
					? b.totalCost - a.totalCost
					: a.model.localeCompare(b.model),
			),
	};
}

/** Every transcript file under a sessions dir: `<ts>_<id>.jsonl` mains plus the sibling
 *  `<ts>_<id>/` dirs of subagent transcripts, recursively. */
function walkJsonl(dir: string): string[] {
	const out: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (err) {
		// Only a dir that does not exist means "no sessions yet" (a fresh project).
		const absent =
			err instanceof Error && "code" in err && err.code === "ENOENT";
		if (absent) return out;
		throw err;
	}
	for (const name of names) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			out.push(...walkJsonl(path));
			continue;
		}
		if (name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

/** Scans one store's sessions dir and sums its usage records. A missing dir answers the
 *  zero totals (a fresh project); an unreadable dir or file, or a malformed record in one,
 *  answers { stats: null, error } naming the cause — a partial sum would under-report. */
export function scanSessionUsage(sessionsDir: string): OmpStatsAnswer {
	let files: string[];
	try {
		files = walkJsonl(sessionsDir);
	} catch (err) {
		return {
			stats: null,
			error: `${sessionsDir}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const records: UsageRecord[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			return {
				stats: null,
				error: `${file}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const read = readUsageRecords(text);
		if (read === null)
			return {
				stats: null,
				error: `${file}: a record is not a JSON object`,
			};
		records.push(...read);
	}
	return { stats: aggregate(records), error: null };
}
