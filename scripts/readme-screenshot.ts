// Regenerates the README screenshot (.github/assets/screenshot.png) from the demo board.
// `bun run readme-screenshot` in a work turn refreshes the shot a board-visible src/ui
// change made stale (AGENTS.md work turn). The script drives headless Chrome over CDP
// with Bun's WebSocket client, so it adds no npm dependency. The shared shot machinery
// lives in scripts/shot-lib.ts. Spec: docs/specs/readme-screenshot.md.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	Cdp,
	fail,
	findChrome,
	freePort,
	PNG_SIGNATURE,
	stopChildren,
	withTimeout,
} from "./shot-lib.ts";

const REPO = resolve(import.meta.dir, "..");
const OUT = resolve(REPO, ".github/assets/screenshot.png");
const WIDTH = 1440;
const HEIGHT = 900;
const LOCALE = "en-US";
const SETTLE_MS = 2500;

function verifyPng(png: Buffer): void {
	if (png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
		fail(
			"readme-screenshot",
			`output is not a PNG (first bytes ${png.subarray(0, 8).toString("hex")})`,
		);
	}
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (width !== WIDTH || height !== HEIGHT) {
		fail(
			"readme-screenshot",
			`wrong size ${width}x${height}, expected ${WIDTH}x${HEIGHT}`,
		);
	}
	console.log(
		`readme-screenshot: wrote ${OUT} (${width}x${height}, ${png.length} bytes)`,
	);
}

const chromePath = findChrome("readme-screenshot");
const port = await freePort();
const boardUrl = `http://127.0.0.1:${port}/#lumen`;

// Demo board only: src/dev.ts seeds a unique scratch root under .dev/ per spawn (OTTR_DEV_ROOT pins it) and never touches a real board. Production
// asset mode: the dev-mode HMR server stalls the first request while it bundles the app.
const board = Bun.spawn(["bun", "src/dev.ts"], {
	cwd: REPO,
	env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
	stdout: "ignore",
	stderr: "pipe",
});

const userDir = mkdtempSync(join(tmpdir(), "ottr-shot-"));
const chrome = Bun.spawn(
	[
		chromePath,
		"--headless=new",
		"--remote-debugging-port=0",
		`--user-data-dir=${userDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--hide-scrollbars",
		`--window-size=${WIDTH},${HEIGHT}`,
		...(typeof process.getuid === "function" && process.getuid() === 0
			? ["--no-sandbox"]
			: []),
		"about:blank",
	],
	{ stdout: "ignore", stderr: "pipe" },
);

/** One capture attempt; every await below carries its own deadline. */
async function capture(): Promise<void> {
	// The endpoint line arrives on stderr: "DevTools listening on ws://...".
	const endpoint = await (async () => {
		const reader = chrome.stderr.getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			const hit = text.match(/DevTools listening on (ws:\/\/\S+)/);
			if (hit?.[1]) {
				reader.releaseLock();
				return hit[1];
			}
		}
		throw new Error("chrome printed no DevTools endpoint");
	})();

	const client = new Cdp(new WebSocket(endpoint));
	await withTimeout(client.open(), 10_000, "CDP open");
	client.listen();

	// Ready poll: the server answers the home page once the bundle is served.
	let ready = false;
	for (let waited = 0; waited < 30_000; waited += 250) {
		if (board.exitCode !== null) throw new Error("the demo board exited early");
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(1_000),
			});
			await res.body?.cancel();
			if (res.ok) {
				ready = true;
				break;
			}
		} catch {
			// not listening yet
		}
		await Bun.sleep(250);
	}
	if (!ready)
		throw new Error("the demo board did not become ready within 30 s");

	const created = await withTimeout(
		client.send("Target.createTarget", { url: "about:blank" }),
		10_000,
		"Target.createTarget",
	);
	const attached = await withTimeout(
		client.send("Target.attachToTarget", {
			targetId: created.targetId,
			flatten: true,
		}),
		10_000,
		"Target.attachToTarget",
	);
	const sessionId = attached.sessionId;
	if (typeof sessionId !== "string")
		throw new Error("chrome gave no page session");

	await client.send(
		"Emulation.setDeviceMetricsOverride",
		{ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
		sessionId,
	);
	await client.send(
		"Emulation.setEmulatedMedia",
		{ features: [{ name: "prefers-color-scheme", value: "dark" }] },
		sessionId,
	);
	await client.send(
		"Emulation.setLocaleOverride",
		{ locale: LOCALE },
		sessionId,
	);
	await client.send("Page.enable", undefined, sessionId);
	await withTimeout(
		client.send("Page.navigate", { url: boardUrl }, sessionId),
		15_000,
		"Page.navigate",
	);
	await withTimeout(
		client.waitEvent("Page.loadEventFired", sessionId),
		30_000,
		"page load",
	);
	// Card entrance animations run about 2 s; let them finish before the shot.
	await Bun.sleep(SETTLE_MS);
	const shot = await withTimeout(
		client.send("Page.captureScreenshot", { format: "png" }, sessionId),
		30_000,
		"Page.captureScreenshot",
	);
	if (typeof shot.data !== "string")
		throw new Error("chrome returned no image data");
	const png = Buffer.from(shot.data, "base64");
	mkdirSync(resolve(REPO, ".github/assets"), { recursive: true });
	await Bun.write(OUT, png);
	verifyPng(png);
}

let failure: Error | null = null;
const run = capture();
try {
	// Watchdog: the capture must always end, so the script never hangs a gate.
	const { promise: deadline, reject } = Promise.withResolvers<never>();
	const watchdog = setTimeout(
		() => reject(new Error("the capture gave up after 120 s")),
		120_000,
	);
	watchdog.unref?.();
	deadline.catch(() => {}); // stays handled when capture wins the race
	await Promise.race([run, deadline]);
	clearTimeout(watchdog);
} catch (err) {
	failure = err instanceof Error ? err : new Error(String(err));
} finally {
	await stopChildren(chrome, board);
}
// A deadline win can leave capture() pending; keep its rejection from crashing the exit.
run.catch(() => {});
if (failure) fail("readme-screenshot", failure.message);
