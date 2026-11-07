// Regenerates the README screenshot (.github/assets/screenshot.png) from the demo board.
// `bun run readme-screenshot` in a work turn refreshes the shot a board-visible src/ui
// change made stale (AGENTS.md work turn). The script drives headless Chrome over CDP
// with Bun's WebSocket client, so it adds no npm dependency. Spec: docs/specs/readme-screenshot.md.
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const OUT = resolve(REPO, ".github/assets/screenshot.png");
const WIDTH = 1440;
const HEIGHT = 900;
const LOCALE = "en-US";
const SETTLE_MS = 2500;
const PNG_SIGNATURE = "89504e470d0a1a0a";

type Json = Record<string, unknown>;

function asJson(value: unknown): Json {
	return typeof value === "object" && value !== null ? (value as Json) : {};
}

function fail(message: string): never {
	console.error(`readme-screenshot: ${message}`);
	process.exit(1);
}

/**
 * Chrome builds found in the puppeteer caches, newest version first. The homedir cache comes
 * first, then /root's: a service HOME (/etc/ottr/home) leaves the homedir cache empty. The
 * stable sort keeps the homedir build ahead on a version tie.
 */
function cacheBuilds(): { path: string; version: string }[] {
	const layouts = [
		{ re: /^linux-(\d[\d.]*)$/, exe: "chrome-linux64/chrome" },
		{ re: /^win-(\d[\d.]*)$/, exe: "chrome-win64/chrome.exe" },
	];
	const roots = new Set([
		join(homedir(), ".cache", "puppeteer"),
		join("/root", ".cache", "puppeteer"),
	]);
	const cacheDirs = [...roots].flatMap((root) =>
		["chrome", "chrome-headless-shell"].map((name) => join(root, name)),
	);
	const builds: { path: string; version: string }[] = [];
	for (const cacheDir of cacheDirs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(cacheDir);
		} catch {
			continue; // cache folder absent
		}
		for (const entry of entries) {
			for (const layout of layouts) {
				const hit = entry.match(layout.re);
				if (hit) {
					builds.push({
						path: join(cacheDir, entry, layout.exe),
						version: hit[1] ?? "0",
					});
				}
			}
		}
	}
	return builds.sort((a, b) =>
		b.version.localeCompare(a.version, "en", { numeric: true }),
	);
}

/** Newest Chrome from the puppeteer cache, else PATH; OTTR_SCREENSHOT_CHROME wins up front. */
function findChrome(): string {
	const override = process.env.OTTR_SCREENSHOT_CHROME;
	if (override) return override;
	const newest = cacheBuilds()[0];
	if (newest) return newest.path;
	for (const name of [
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
		"chrome",
	]) {
		const found = Bun.which(name);
		if (found) return found;
	}
	return fail(
		"no Chrome found; install Chrome or point OTTR_SCREENSHOT_CHROME at a chrome binary",
	);
}

function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = net.createServer();
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		if (typeof address !== "object" || address === null) {
			reject(new Error("probe gave no port"));
			return;
		}
		resolve(address.port);
		probe.close();
	});
	probe.on("error", reject);
	return promise;
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	const { promise: timedOut, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => reject(new Error(`${label} timed out after ${ms} ms`)),
		ms,
	);
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

/** Minimal CDP client over Bun's WebSocket: id-matched replies, event waiters. */
class Cdp {
	#ws: WebSocket;
	#nextId = 1;
	#pending = new Map<
		number,
		{ resolve: (value: Json) => void; reject: (error: Error) => void }
	>();
	#events: {
		method: string;
		sessionId: string | undefined;
		resolve: (value: Json) => void;
		reject: (error: Error) => void;
	}[] = [];

	constructor(ws: WebSocket) {
		this.#ws = ws;
	}

	/** Pipes every CDP message into handle(); call once after open(). */
	listen(): void {
		this.#ws.addEventListener("message", (ev) => {
			try {
				this.handle(JSON.parse(String(ev.data)) as unknown);
			} catch {
				// not JSON: nothing to dispatch
			}
		});
	}

	open(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#ws.addEventListener("open", () => resolve(), { once: true });
		this.#ws.addEventListener(
			"error",
			() => reject(new Error("the CDP socket failed to open")),
			{ once: true },
		);
		return promise;
	}

	send(method: string, params?: Json, sessionId?: string): Promise<Json> {
		const { promise, resolve, reject } = Promise.withResolvers<Json>();
		const id = this.#nextId++;
		this.#pending.set(id, { resolve, reject });
		this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
		return promise;
	}

	waitEvent(method: string, sessionId?: string): Promise<Json> {
		const { promise, resolve, reject } = Promise.withResolvers<Json>();
		this.#events.push({ method, sessionId, resolve, reject });
		return promise;
	}

	handle(raw: unknown): void {
		const msg = asJson(raw);
		if (typeof msg.id === "number") {
			const wait = this.#pending.get(msg.id);
			this.#pending.delete(msg.id);
			if (!wait) return;
			if (msg.error !== undefined) {
				wait.reject(
					new Error(
						`CDP error: ${String(asJson(msg.error).message ?? "unknown")}`,
					),
				);
			} else {
				wait.resolve(asJson(msg.result));
			}
			return;
		}
		if (typeof msg.method !== "string") return;
		const sessionId =
			typeof msg.sessionId === "string" ? msg.sessionId : undefined;
		const index = this.#events.findIndex(
			(e) => e.method === msg.method && e.sessionId === sessionId,
		);
		if (index >= 0) {
			const [entry] = this.#events.splice(index, 1);
			entry?.resolve(asJson(msg.params));
		}
	}
}

function verifyPng(png: Buffer): void {
	if (png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
		fail(
			`output is not a PNG (first bytes ${png.subarray(0, 8).toString("hex")})`,
		);
	}
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (width !== WIDTH || height !== HEIGHT) {
		fail(`wrong size ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
	}
	console.log(
		`readme-screenshot: wrote ${OUT} (${width}x${height}, ${png.length} bytes)`,
	);
}

const chromePath = findChrome();
const port = await freePort();
const boardUrl = `http://127.0.0.1:${port}/#lumen`;

// Demo board only: src/dev.ts seeds .dev/ and never touches a real board. Production
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

/** SIGTERM to the children this script spawned, SIGKILL when a child ignores it. */
async function stopChildren(): Promise<void> {
	const stop = async (proc: {
		exitCode: number | null;
		exited: Promise<number>;
		kill: (signal?: number) => void;
	}) => {
		if (proc.exitCode === null) proc.kill();
		const escalation = setTimeout(() => {
			if (proc.exitCode === null) proc.kill(9);
		}, 5_000);
		await proc.exited;
		clearTimeout(escalation);
	};
	await stop(chrome);
	await stop(board);
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
	await stopChildren();
}
// A deadline win can leave capture() pending; keep its rejection from crashing the exit.
run.catch(() => {});
if (failure) fail(failure.message);
