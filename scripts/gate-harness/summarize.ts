/**
 * summarize.ts — one summary block per run from a load.ts records.json.
 * Prints state p50/p95 over the measurement window (warm-up excluded),
 * timer-lag p99 (server probe), server CPU %, main-thread CPU % with its
 * share of the process CPU, the per-thread CPU lines, and per-response bytes
 * (gzip average over windowed responses, raw from the tail GET).
 *
 * Usage: bun summarize.ts <records.json> [label]
 */

import { readFileSync } from "node:fs";

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

const file = process.argv[2];
if (file === undefined) throw new Error("missing <records.json>");
const label = process.argv[3] ?? file;
const data = JSON.parse(readFileSync(file, "utf8")) as {
	url: string;
	warmupMs: number;
	windowMs: number;
	viewers: number;
	requests: number;
	httpErrors: number;
	wsFrames: number;
	wsBytes: number;
	lag: {
		windowMs: number;
		samples: number;
		current: number;
		mean: number;
		p99: number;
		max: number;
	};
	rawBytes: number;
	rawMs: number;
	rawError: string | null;
	cpu: {
		pct: number | null;
		wallMs: number;
		ticks: number | null;
		clkTck: number;
	};
	mainCpu: {
		pct: number | null;
		ticks: number | null;
		wallMs: number;
		clkTck: number;
	};
	threads: {
		wallMs: number;
		clkTck: number;
		paired: Array<{
			tid: number;
			comm: string;
			main: boolean;
			ticks: number;
			pct: number;
		}>;
		newThreads: Array<{ tid: number; comm: string; ticks: number }>;
		exitedThreads: number;
	} | null;
	records: Array<{
		viewer: number;
		phase: "warm" | "window" | "tail";
		ms: number;
		bytes: number;
		status: number;
		enc: string | null;
		error?: string;
	}>;
};

const win = data.records.filter((r) => r.phase === "window");
const warm = data.records.filter((r) => r.phase === "warm");
const winMs = win.map((r) => r.ms).sort((a, b) => a - b);
const gzResponses = win.filter((r) => r.enc === "gzip");
const gzBytes = gzResponses.reduce((a, r) => a + r.bytes, 0);
const badEnc = win.filter((r) => r.enc !== "gzip").length;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
console.log(`=== run: ${label} (${data.url}) ===`);
console.log(
	`window requests: ${win.length} (plus ${warm.length} warm-up, excluded) over ${data.windowMs / 1000}s with ${data.viewers} viewers`,
);
console.log(
	`state p50: ${percentile(winMs, 0.5).toFixed(1)} ms | p95: ${percentile(winMs, 0.95).toFixed(1)} ms`,
);
console.log(
	`timer lag p99: ${data.lag.p99.toFixed(1)} ms (mean ${data.lag.mean.toFixed(1)}, max ${data.lag.max.toFixed(1)}, current ${data.lag.current.toFixed(1)}, ${data.lag.samples} samples/${data.lag.windowMs / 1000}s window)`,
);
console.log(
	`server CPU: ${data.cpu.pct?.toFixed(1) ?? "n/a"} % over ${((data.cpu.wallMs ?? 0) / 1000).toFixed(1)} s`,
);
const mainShare =
	data.mainCpu.pct !== null && data.cpu.pct !== null && data.cpu.pct !== 0
		? ` (${((data.mainCpu.pct / data.cpu.pct) * 100).toFixed(1)}% of process CPU)`
		: "";
console.log(
	`main-thread CPU: ${data.mainCpu.pct?.toFixed(1) ?? "n/a"} %${mainShare}`,
);
if (data.threads === null) {
	console.log("threads new: n/a exited: n/a");
} else {
	for (const t of data.threads.paired) {
		console.log(
			`tid ${t.tid} ${t.comm} ${t.main ? "main" : "worker"} ${t.ticks} ticks (${t.pct.toFixed(1)} %)`,
		);
	}
	console.log(
		`threads new: ${data.threads.newThreads.length} exited: ${data.threads.exitedThreads}`,
	);
}
console.log(
	`bytes per response: gz avg ${mb(gzResponses.length === 0 ? 0 : gzBytes / gzResponses.length)} over ${gzResponses.length} gzip responses; raw ${mb(data.rawBytes)} (tail GET ${data.rawMs.toFixed(0)} ms)`,
);
console.log(
	`HTTP errors: ${data.httpErrors} | non-gzip window responses: ${badEnc} | ws frames drained: ${data.wsFrames} (${mb(data.wsBytes)})`,
);
if (data.rawError !== null) console.log(`raw GET error: ${data.rawError}`);
