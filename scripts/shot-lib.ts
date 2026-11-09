// Shared machinery for the screenshot scripts (readme-screenshot.ts, card-shot.ts):
// Chrome discovery in the puppeteer caches, a minimal CDP client over Bun's WebSocket
// client, bounded waits, the PNG signature, and child cleanup. Adds no npm dependency.
import { readdirSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const PNG_SIGNATURE = "89504e470d0a1a0a";

export type Json = Record<string, unknown>;

export function asJson(value: unknown): Json {
	return typeof value === "object" && value !== null ? (value as Json) : {};
}

/** Print one error line and exit 1; `label` names the calling script. */
export function fail(label: string, message: string): never {
	console.error(`${label}: ${message}`);
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
export function findChrome(label: string): string {
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
		label,
		"no Chrome found; install Chrome or point OTTR_SCREENSHOT_CHROME at a chrome binary",
	);
}

export function freePort(): Promise<number> {
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

export function withTimeout<T>(
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
export class Cdp {
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

/** The process handles Bun.spawn returns; stopChildren only needs this slice. */
export type StoppableChild = {
	exitCode: number | null;
	exited: Promise<number>;
	kill: (signal?: number) => void;
};

/** SIGTERM to the children this script spawned, SIGKILL when a child ignores it. */
export async function stopChildren(
	...children: StoppableChild[]
): Promise<void> {
	for (const proc of children) {
		if (proc.exitCode === null) proc.kill();
		const escalation = setTimeout(() => {
			if (proc.exitCode === null) proc.kill(9);
		}, 5_000);
		await proc.exited;
		clearTimeout(escalation);
	}
}
