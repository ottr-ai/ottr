// omp stats: reads and aggregation for Settings -> omp usage. The worker answers
// GET /omp-stats with its own `omp stats --json` (its container's omp store); the board
// runs the same command for its own board store (boardOmpEnv home) and fetches every
// worker's answer, then renders totals + per-model rows over the distinct stores.
// Pure module: no store state; the spawn is injectable for tests (bin).
import { type ChildProcess, spawn } from "node:child_process";

/** One omp stats total block: omp's `overall` field and each byModel row share this shape.
 *  Rates and averages are null when omp has no basis for them (no requests yet). Durations
 *  are milliseconds; timestamps are epoch ms. */
export interface OmpUsageTotals {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	/** failedRequests / totalRequests, null when omp reports no total. */
	errorRate: number | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** cacheRead / (input + cacheRead), null without a denominator. */
	cacheRate: number | null;
	/** omp's cost-based estimate; request-weighted when sources merge. */
	cacheSavings: number | null;
	totalCost: number;
	unpricedRequests: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number | null;
	lastTimestamp: number | null;
}

/** One model's totals in omp's `byModel` list. */
export interface OmpModelUsage extends OmpUsageTotals {
	model: string;
	provider: string | null;
}

/** The parsed `omp stats --json` payload: overall totals plus one row per model. */
export interface OmpStats {
	overall: OmpUsageTotals;
	byModel: OmpModelUsage[];
}

/** What a stats read answers: parsed numbers, or the reason there are none. Always a
 *  200-shaped answer — a failed read is data, not a failed request. */
export interface OmpStatsAnswer {
	stats: OmpStats | null;
	error: string | null;
}

/** One container's answer for the report: the board store ("server", board: true) or a
 *  worker's store (name = the worker hostname). */
export interface OmpStatsSource {
	name: string;
	board: boolean;
	answer: OmpStatsAnswer;
}

/** The Settings card payload: every source's answer plus totals + per-model rows merged
 *  over the distinct stores (workers share one home, so identical answers count once). */
export interface OmpStatsReport {
	at: number;
	sources: OmpStatsSource[];
	overall: OmpUsageTotals;
	byModel: OmpModelUsage[];
}

type Unchecked<T> = { [K in keyof T]?: unknown };

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A number omp fills when it has a basis for it; absent or null means "no basis". */
const isRate = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

/** Reads one totals block: counts default to 0 when absent (older omp), rates and
 *  averages to null. Not a validator of everything omp may add — extra keys pass through
 *  untouched, and unknown future fields never block a read. */
function readTotals(b: Unchecked<OmpUsageTotals>): OmpUsageTotals {
	const count = (v: unknown): number => (isCount(v) ? v : 0);
	const rate = (v: unknown): number | null => (isRate(v) ? v : null);
	return {
		totalRequests: count(b.totalRequests),
		successfulRequests: count(b.successfulRequests),
		failedRequests: count(b.failedRequests),
		errorRate: rate(b.errorRate),
		totalInputTokens: count(b.totalInputTokens),
		totalOutputTokens: count(b.totalOutputTokens),
		totalCacheReadTokens: count(b.totalCacheReadTokens),
		totalCacheWriteTokens: count(b.totalCacheWriteTokens),
		cacheRate: rate(b.cacheRate),
		cacheSavings: rate(b.cacheSavings),
		totalCost: count(b.totalCost),
		unpricedRequests: count(b.unpricedRequests),
		totalPremiumRequests: count(b.totalPremiumRequests),
		avgDuration: rate(b.avgDuration),
		avgTtft: rate(b.avgTtft),
		avgTokensPerSecond: rate(b.avgTokensPerSecond),
		firstTimestamp: rate(b.firstTimestamp),
		lastTimestamp: rate(b.lastTimestamp),
	};
}

/** Parses an `omp stats --json` body; null when it names no overall block (not omp's
 *  shape, an error page, or an empty body). byModel may be absent on a fresh store. */
export function parseOmpStats(body: unknown): OmpStats | null {
	if (typeof body !== "object" || body === null) return null;
	const b = body as Unchecked<OmpStats>;
	const overall = b.overall;
	if (typeof overall !== "object" || overall === null) return null;
	if (!isCount((overall as Unchecked<OmpUsageTotals>).totalRequests))
		return null;
	const byModel: OmpModelUsage[] = Array.isArray(b.byModel)
		? b.byModel.flatMap((row): OmpModelUsage[] => {
				if (typeof row !== "object" || row === null) return [];
				const r = row as Unchecked<OmpModelUsage>;
				if (typeof r.model !== "string" || r.model.length === 0) return [];
				return [
					{
						...readTotals(r),
						model: r.model,
						provider: typeof r.provider === "string" ? r.provider : null,
					},
				];
			})
		: [];
	return { overall: readTotals(overall as Unchecked<OmpUsageTotals>), byModel };
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
 *  summed counts (omp's cacheRate is cacheRead / (input + cacheRead), measured on omp
 *  18.14.0); the request-weighted averages and savings carry over; timestamps span. */
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

/** Merges parsed stats blocks into one: totals sum, byModel rows fold by model+provider
 *  with the same merge rules. Empty input answers the zero totals with no rows. */
export function mergeOmpStats(stats: OmpStats[]): OmpStats {
	const rows = new Map<string, OmpUsageTotals[]>();
	for (const s of stats) {
		for (const m of s.byModel) {
			const key = `${m.provider ?? ""}|${m.model}`;
			const list = rows.get(key) ?? [];
			list.push(m);
			rows.set(key, list);
		}
	}
	return {
		overall: mergeTotals(stats.map((s) => s.overall)),
		byModel: [...rows.entries()]
			.map(([key, list]) => {
				const model = key.slice(key.indexOf("|") + 1);
				const provider = key.slice(0, key.indexOf("|")) || null;
				return { ...mergeTotals(list), model, provider };
			})
			.sort((a, b) =>
				b.totalCost !== a.totalCost
					? b.totalCost - a.totalCost
					: a.model.localeCompare(b.model),
			),
	};
}

/** Drops stats blocks whose whole payload matches an earlier one byte for byte: the
 *  stack's workers share one omp home (docker-compose home:/root), so every worker's
 *  answer repeats the same store and a naive sum would multiply it by the worker count. */
export function distinctOmpStats(stats: OmpStats[]): OmpStats[] {
	const seen = new Set<string>();
	return stats.filter((s) => {
		const key = JSON.stringify(s);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Builds the report: totals and per-model rows merged over the distinct stores; every
 *  source keeps its own answer either way, so the breakdown shows what each reported. */
export function buildOmpStatsReport(
	sources: OmpStatsSource[],
	at: number,
): OmpStatsReport {
	const merged = mergeOmpStats(
		distinctOmpStats(
			sources.flatMap((s) => (s.answer.stats === null ? [] : [s.answer.stats])),
		),
	);
	return { at, sources, overall: merged.overall, byModel: merged.byModel };
}

const STDERR_TAIL = 4000;

/** Runs `omp stats --json` and parses stdout. The sync progress goes to stderr; stdout
 *  must be pure JSON. A spawn failure, non-zero exit, timeout, or non-JSON stdout answers
 *  { stats: null, error } naming the cause (with the stderr tail when omp wrote one). */
export function runOmpStats(opts: {
	/** Test injection: the binary to run instead of `omp` on PATH. */
	bin?: string;
	/** Wall-clock cap; the child is SIGKILLed past it. Default 15 s: the first run syncs
	 *  every session file into the store. */
	timeoutMs?: number;
	/** Env for the child; the board passes boardOmpEnv() to read its own store. */
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}): Promise<OmpStatsAnswer> {
	const bin = opts.bin ?? "omp";
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const { promise, resolve } = Promise.withResolvers<OmpStatsAnswer>();
	let out = "";
	let errTail = "";
	let child: ChildProcess;
	try {
		child = spawn(bin, ["stats", "--json"], {
			env: opts.env,
			cwd: opts.cwd,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			// A stats read needs no stdin; a pipe stops a stray read from hanging.
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		resolve({
			stats: null,
			error: `omp stats failed to start: ${err instanceof Error ? err.message : String(err)}`,
		});
		return promise;
	}
	child.stdout?.on("data", (chunk: Buffer) => {
		// 16 MiB is far past any real stats payload; the cap keeps a broken omp from
		// ballooning the board's memory.
		if (out.length < 16 * 1024 * 1024) out += String(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		errTail = `${errTail}${String(chunk)}`.slice(-STDERR_TAIL);
	});
	child.on("error", (err) => {
		resolve({
			stats: null,
			error: `omp stats failed to start: ${err.message}`,
		});
	});
	child.on("close", (code, signal) => {
		if (signal !== null) {
			resolve({
				stats: null,
				error: `omp stats timed out after ${timeoutMs} ms and was killed`,
			});
			return;
		}
		if (code !== 0) {
			resolve({
				stats: null,
				error: `omp stats exited with code ${code}${errTail ? `: ${errTail.trim()}` : ""}`,
			});
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(out);
		} catch {
			resolve({
				stats: null,
				error: `omp stats printed no valid JSON${errTail ? `: ${errTail.trim()}` : ""}`,
			});
			return;
		}
		const stats = parseOmpStats(parsed);
		resolve(
			stats !== null
				? { stats, error: null }
				: {
						stats: null,
						error: "omp stats printed JSON without an overall block",
					},
		);
	});
	return promise;
}

/** GET `${url}/omp-stats` with x-otwr-token. Any failure (network, non-200, bad body)
 *  answers { stats: null, error } — the report shows the source as failed, not the card. */
export async function fetchWorkerOmpStats(
	url: string,
	token: string | undefined,
	timeoutMs = 20_000,
): Promise<OmpStatsAnswer> {
	try {
		const res = await fetch(`${url}/omp-stats`, {
			headers: token ? { "x-otwr-token": token } : {},
			// redirect: "manual": the worker token must never follow a redirect off-host.
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status !== 200)
			return {
				stats: null,
				error: `GET /omp-stats answered HTTP ${res.status}`,
			};
		const body = (await res.json()) as Unchecked<OmpStatsAnswer>;
		if (typeof body.error === "string" && body.stats === null)
			return { stats: null, error: body.error };
		const stats = parseOmpStats(body.stats);
		return stats !== null
			? { stats, error: null }
			: { stats: null, error: "worker answered no usable omp stats" };
	} catch (err) {
		return {
			stats: null,
			error: `GET /omp-stats failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
