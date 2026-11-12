/**
 * load.ts — one closed-loop load run against one harness server.
 *
 * Five viewers; each holds ONE WebSocket (Origin header set, per the server's
 * upgrade wall) and runs a continuous loop of GET /api/state with
 * Connection: close and Accept-Encoding: gzip, measuring per-request wall time
 * and the gzip bytes each response carried. Phases: 10 s warm-up (recorded,
 * excluded from the percentiles) then a 30 s measurement window. After the
 * window the harness samples GET /harness/lag inside the server process and
 * performs one uncompressed GET to record the raw state size.
 *
 * Server CPU %: /proc/<server-pid>/stat utime+stime delta across the window
 * divided by the wall time between the two reads (CLK_TCK from getconf, 100).
 *
 * Usage:
 *   bun load.ts --url http://127.0.0.1:<port> --out records.json \
 *     [--server-pid <pid>] [--warmup-ms 10000] [--window-ms 30000] [--viewers 5]
 *
 * Every response records {viewer, phase, ms, bytes, status, enc}; records.json
 * holds them all plus lag, raw size, CPU, and error counts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}
function numArg(name: string, dflt: number): number {
	const v = arg(name);
	return v === undefined ? dflt : Number(v);
}

const url = arg("--url");
if (url === undefined) throw new Error("missing --url");
const out = arg("--out");
if (out === undefined) throw new Error("missing --out");
const serverPid = arg("--server-pid");
const warmupMs = numArg("--warmup-ms", 10_000);
const windowMs = numArg("--window-ms", 30_000);
const viewers = numArg("--viewers", 5);

const parsed = new URL(url);
const origin = parsed.origin;
const wsUrl = `ws://${parsed.host}/api/ws`;

interface Rec {
	viewer: number;
	phase: "warm" | "window" | "tail";
	ms: number;
	bytes: number;
	status: number;
	enc: string | null;
	error?: string;
}

const records: Rec[] = [];
let httpErrors = 0;
let wsFrames = 0;
let wsBytes = 0;

/** One GET with Connection: close; gzip=true adds Accept-Encoding: gzip. The
 * body bytes are counted as received, so a gzip response reports gzipped size. */
function getOnce(
	path: string,
	gzip: boolean,
): Promise<Omit<Rec, "viewer" | "phase">> {
	const { promise, resolve } =
		Promise.withResolvers<Omit<Rec, "viewer" | "phase">>();
	const t0 = performance.now();
	const headers: Record<string, string> = { connection: "close" };
	if (gzip) headers["accept-encoding"] = "gzip";
	const req = http.request(
		{
			hostname: parsed.hostname,
			port: parsed.port,
			path,
			method: "GET",
			headers,
		},
		(res) => {
			let bytes = 0;
			res.on("data", (c: Buffer) => {
				bytes += c.length;
			});
			res.on("end", () => {
				resolve({
					ms: performance.now() - t0,
					bytes,
					status: res.statusCode ?? 0,
					enc: res.headers["content-encoding"] ?? null,
				});
			});
			res.on("error", (err: Error) => {
				resolve({
					ms: performance.now() - t0,
					bytes,
					status: res.statusCode ?? 0,
					enc: null,
					error: `read: ${err.message}`,
				});
			});
		},
	);
	req.on("error", (err: Error) => {
		resolve({
			ms: performance.now() - t0,
			bytes: 0,
			status: 0,
			enc: null,
			error: `request: ${err.message}`,
		});
	});
	req.end();
	return promise;
}

/** Open one viewer WebSocket; Bun's client accepts extra handshake headers. */
function openSocket(id: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	// Bun's client accepts the handshake headers object; the DOM lib types this
	// slot as the protocols string[] list, so the shape crosses through unknown.
	const ws = new WebSocket(wsUrl, {
		headers: { Origin: origin },
	} as unknown as string[]);
	ws.binaryType = "arraybuffer";
	ws.onopen = () => resolve(ws);
	ws.onerror = () =>
		reject(new Error(`viewer ${id}: websocket handshake failed`));
	ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
		wsFrames++;
		wsBytes +=
			typeof ev.data === "string" ? ev.data.length : ev.data.byteLength;
	};
	return promise;
}

interface CpuTicks {
	utime: number;
	stime: number;
}
function readCpuTicks(): CpuTicks | null {
	if (serverPid === undefined) return null;
	try {
		const stat = readFileSync(`/proc/${serverPid}/stat`, "utf8");
		const rest = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
		return { utime: Number(rest[11]), stime: Number(rest[12]) };
	} catch {
		return null;
	}
}

let clkTck = 100;
try {
	clkTck =
		Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim()) ||
		100;
} catch {}

const windowStart = performance.now() + warmupMs;
const deadline = windowStart + windowMs;

// Sample again at the window boundary, so the CPU % covers the 30 s window
// (not the warm-up). Wall time uses the actual fire time, so a late timer
// under a blocked loop stays consistent with its tick delta.
const atWindowStart = Promise.withResolvers<{
	cpu: CpuTicks | null;
	at: number;
}>();
setTimeout(() => {
	atWindowStart.resolve({ cpu: readCpuTicks(), at: performance.now() });
}, warmupMs);

const sockets = await Promise.all(
	Array.from({ length: viewers }, (_, v) => openSocket(v)),
);

// Closed loop per viewer: the next request starts when the previous ends.
// A straggler response after the deadline still lands in its phase bucket;
// load.ts never abandons an in-flight request, so the window is exact.
const viewerLoops = sockets.map(async (_ws, v) => {
	while (performance.now() < deadline) {
		const phase = performance.now() < windowStart ? "warm" : "window";
		const r = await getOnce("/api/state", true);
		if (r.error !== undefined || r.status !== 200) httpErrors++;
		records.push({ viewer: v, phase, ...r });
	}
});
await Promise.all(viewerLoops);

const wallAfter = performance.now();
const cpuAfter = readCpuTicks();
const windowCpu = await atWindowStart.promise;

const lagRes = await fetch(`${origin}/harness/lag`);
const lag = (await lagRes.json()) as {
	windowMs: number;
	samples: number;
	current: number;
	mean: number;
	p99: number;
	max: number;
};

const raw = await getOnce("/api/state", false);
records.push({ viewer: -1, phase: "tail", ...raw });
for (const ws of sockets) ws.close();

// CPU % over the measurement window: tick delta between the window-start
// sample and the window-end sample over the wall time between them.
const wallMs = wallAfter - windowCpu.at;
const cpuTicks =
	windowCpu.cpu && cpuAfter
		? cpuAfter.utime +
			cpuAfter.stime -
			(windowCpu.cpu.utime + windowCpu.cpu.stime)
		: null;
const cpuPct =
	cpuTicks === null ? null : (cpuTicks / clkTck / (wallMs / 1000)) * 100;

const summary = {
	url: origin,
	warmupMs,
	windowMs,
	viewers,
	serverPid: serverPid ?? null,
	requests: records.length,
	httpErrors,
	wsFrames,
	wsBytes,
	lag,
	rawBytes: raw.bytes,
	rawMs: raw.ms,
	rawError: raw.error ?? null,
	cpu: { pct: cpuPct, wallMs, ticks: cpuTicks, clkTck },
	records,
};
writeFileSync(out, JSON.stringify(summary));
console.log(
	`LOAD_DONE requests=${records.length} httpErrors=${httpErrors} rawBytes=${raw.bytes} cpuPct=${cpuPct?.toFixed(1) ?? "n/a"}`,
);
