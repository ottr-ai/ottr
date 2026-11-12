/**
 * patch-serve.ts — copy a tree's src/server.ts verbatim and apply exactly three deltas:
 *   delta 1: the server listens on a pre-picked port and prints HARNESS_PORT=<port>
 *            once it is listening (the existing boot banner line, plus our line after it).
 *   delta 2: a 10 ms timer-lag probe inside the server process (rolling 45 s window,
 *            which covers the 30 s measurement window), exposed at GET /harness/lag
 *            as JSON { windowMs, samples, current, mean, p99, max } (all milliseconds).
 *   delta 3: idleReviews and trendingScan forced false so no background board work
 *            pollutes the measurement window.
 * Everything else in the file stays byte-identical to the tree's server.ts.
 *
 * Usage: bun patch-serve.ts --tree <dir> --port <port>
 * Output: <tree>/src/server.harness.ts (run it with bun instead of src/server.ts).
 * Stop the server with SIGTERM only: server.ts installs the shutdown handler.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string {
	const i = process.argv.indexOf(name);
	if (i === -1 || i + 1 >= process.argv.length)
		throw new Error(`missing ${name} <value>`);
	return process.argv[i + 1]!;
}

const tree = arg("--tree");
const port = Number(arg("--port"));
if (!Number.isInteger(port) || port <= 0 || port > 65535)
	throw new Error(`bad --port ${port}`);

const srcPath = join(tree, "src", "server.ts");
const outPath = join(tree, "src", "server.harness.ts");
let text = readFileSync(srcPath, "utf8");

function replaceOnce(label: string, oldText: string, newText: string): void {
	const first = text.indexOf(oldText);
	if (first === -1) throw new Error(`patch anchor not found: ${label}`);
	const second = text.indexOf(oldText, first + 1);
	if (second !== -1) throw new Error(`patch anchor not unique: ${label}`);
	text = text.slice(0, first) + newText + text.slice(first + oldText.length);
}

// --- delta 1a: pre-picked port -------------------------------------------------
replaceOnce(
	"delta 1a: PORT const",
	"const PORT = Number(process.env.PORT ?? 4747);",
	`/** HARNESS delta 1: the harness pre-picked this ephemeral port for the run. */
const HARNESS_PORT = ${port};
const PORT = HARNESS_PORT;`,
);

// --- delta 1b: HARNESS_PORT banner once listening ------------------------------
// The Ottr banner prints only after Bun.serve() bound the socket, so a line
// printed after it means the server is listening.
replaceOnce(
	"delta 1b: boot banner",
	"console.log(`Ottr on http://127.0.0.1:${PORT}`);",
	`console.log(\`Ottr on http://127.0.0.1:\${PORT}\`);
console.log(\`HARNESS_PORT=\${PORT}\`);`,
);

// --- delta 2: timer-lag probe + HTTP endpoint ----------------------------------
const probeBlock = `
// === HARNESS delta 2: 10 ms timer-lag probe, 45 s rolling window ==============
// Every 10 ms tick records how far the call ran past its scheduled interval.
// The window (45 s) always covers the 30 s measurement window that load.ts runs.
const HARNESS_WINDOW_MS = 45_000;
const harnessLag: Array<{ at: number; lag: number }> = [];
let harnessLastTick = BigInt(Bun.nanoseconds());
setInterval(() => {
	const now = BigInt(Bun.nanoseconds());
	const lagMs = Number(now - harnessLastTick - 10_000_000n) / 1e6;
	harnessLastTick = now;
	harnessLag.push({ at: Date.now(), lag: lagMs });
	while (
		harnessLag.length > 0 &&
		harnessLag[0] !== undefined &&
		Date.now() - harnessLag[0].at > HARNESS_WINDOW_MS
	)
		harnessLag.shift();
}, 10);

/** GET /harness/lag: current, mean, p99, max lag in ms over the rolling window. */
function harnessLagResponse(): Response {
	const now = Date.now();
	const lags = harnessLag
		.filter((s) => now - s.at <= HARNESS_WINDOW_MS)
		.map((s) => s.lag)
		.sort((a, b) => a - b);
	const n = lags.length;
	const mean = n === 0 ? 0 : lags.reduce((a, b) => a + b, 0) / n;
	const p99 = n === 0 ? 0 : lags[Math.max(0, Math.ceil(0.99 * n) - 1)]!;
	const max = n === 0 ? 0 : lags[n - 1]!;
	const current = n === 0 ? 0 : harnessLag[harnessLag.length - 1]!.lag;
	return Response.json({
		windowMs: HARNESS_WINDOW_MS,
		samples: n,
		current,
		mean,
		p99,
		max,
	});
}
// === end HARNESS delta 2 =======================================================

`;
replaceOnce(
	"delta 2: serve call anchor",
	"serverRef.current = Bun.serve({",
	`${probeBlock}serverRef.current = Bun.serve({`,
);
replaceOnce(
	"delta 2: lag route",
	"	...app.serveOptions,\n});",
	`	...app.serveOptions,
	routes: {
		...app.serveOptions.routes,
		"/harness/lag": () => harnessLagResponse(),
	},
});`,
);

// --- delta 3: idle background scans off ----------------------------------------
replaceOnce(
	"delta 3: idleReviews",
	"	idleReviews: true,",
	"	idleReviews: false, // HARNESS delta 3",
);
replaceOnce(
	"delta 3: trendingScan",
	"	trendingScan: true,",
	"	trendingScan: false, // HARNESS delta 3",
);

if (existsSync(outPath)) rmSync(outPath);
writeFileSync(outPath, text);
console.log(
	`patched ${srcPath} -> ${outPath} (3 deltas applied, port ${port})`,
);
