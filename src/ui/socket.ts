import type {
	MachineStats,
	QuotaState,
	ServerMessage,
	StateResponse,
} from "../types.ts";

/** Handlers the App passes to its one live socket. */
interface LiveHandlers {
	onState(state: StateResponse): void;
	onUpdate(behind: number, commits: string[]): void;
	onOnline(): void;
	onOffline(): void;
}

/** Narrow one text frame; null for anything the guards reject, so a bad frame never reaches the UI. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
	if (typeof raw !== "string") return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const m = data as Record<string, unknown>; // shape checked field by field below
	if (typeof m.type !== "string") return null;
	switch (m.type) {
		case "state": {
			const s = m.state;
			if (typeof s !== "object" || s === null) return null;
			const st = s as Record<string, unknown>;
			if (
				!Array.isArray(st.tasks) ||
				!Array.isArray(st.projects) ||
				typeof st.serverVersion !== "string"
			)
				return null;
			return { type: "state", state: st as unknown as StateResponse }; // server-produced frame; the fields the UI dereferences first are checked above
		}
		case "stats": {
			const s = m.stats;
			if (typeof s !== "object" || s === null) return null;
			const st = s as Record<string, unknown>;
			if (
				typeof st.cpu !== "number" ||
				typeof st.ram !== "object" ||
				st.ram === null
			)
				return null;
			const ram = st.ram as Record<string, unknown>;
			if (typeof ram.pct !== "number") return null;
			return { type: "stats", stats: st as unknown as MachineStats }; // server-produced frame; the fields the UI dereferences first are checked above
		}
		case "update":
			if (
				typeof m.behind !== "number" ||
				!Number.isFinite(m.behind) ||
				!Array.isArray(m.commits) ||
				!m.commits.every((c) => typeof c === "string")
			)
				return null;
			return { type: "update", behind: m.behind, commits: m.commits };
		case "log":
			if (typeof m.project !== "string" || typeof m.id !== "string")
				return null;
			return { type: "log", project: m.project, id: m.id };
		case "ping":
			return { type: "ping" };
		default:
			return null;
	}
}

/** Exponential backoff with a 5 s ceiling: 500, 1000, 2000, 4000, then 5000 forever. */
export function reconnectDelay(attempt: number): number {
	return Math.min(5000, 500 * 2 ** attempt);
}

/** Events the socket fans out to components that don't hold the handlers (stats meters, log views, resync). */
export const liveEvents = new EventTarget();

let lastStats: MachineStats | null = null;

/** The last pushed stats, so a component mounting between frames renders immediately. */
export function latestStats(): MachineStats | null {
	return lastStats;
}

let lastQuota: QuotaState | null = null;

/** The last pushed usage quota (rides every state push), so a mounting picker renders immediately. */
export function latestQuota(): QuotaState | null {
	return lastQuota;
}

/** One push-only socket per call; the server ignores inbound frames, so we never send. Returns a disposer. */
export function connectLive(h: LiveHandlers): () => void {
	let ws: WebSocket | null = null;
	let attempt = 0;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let connectTimeout: ReturnType<typeof setTimeout> | undefined;
	let dropped = false; // an error is followed by close; handle the drop once
	let disposed = false;

	/** Detach and close a socket we are done with, so its late events can never reach the handlers. */
	const abandon = (socket: WebSocket): void => {
		socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
		socket.close();
	};

	/** Treat any lost connection uniformly: notify, then reconnect with backoff. */
	const drop = (): void => {
		if (dropped || disposed) return;
		dropped = true;
		clearTimeout(connectTimeout);
		clearTimeout(watchdog);
		h.onOffline();
		reconnect = setTimeout(() => {
			if (!disposed) ws = open();
		}, reconnectDelay(attempt++));
	};

	const armWatchdog = (): void => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			if (ws !== null) abandon(ws); // the silent socket must be closed or it leaks and could revive
			drop();
		}, 15000); // the server pings every 5 s, so silence means death
	};

	const open = (): WebSocket => {
		// Only place touching browser globals, so bun test can import this module.
		const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
		const socket = new WebSocket(url);
		dropped = false;
		// A dead server's port can stay LISTENing on Windows, so a connect can hang instead of failing.
		connectTimeout = setTimeout(() => {
			if (socket.readyState !== WebSocket.OPEN) {
				abandon(socket); // detach first: the late close event must not fire drop() again
				drop();
			}
		}, 5000);
		socket.onopen = () => {
			clearTimeout(connectTimeout);
			attempt = 0;
			armWatchdog();
			h.onOnline();
			liveEvents.dispatchEvent(new Event("open"));
		};
		socket.onmessage = (e) => {
			armWatchdog();
			const msg = parseServerMessage(e.data);
			if (msg === null) return; // unparseable frames are ignored
			switch (msg.type) {
				case "state":
					lastQuota = msg.state.quota;
					liveEvents.dispatchEvent(new Event("quota"));
					h.onState(msg.state);
					break;
				case "update":
					h.onUpdate(msg.behind, msg.commits);
					break;
				case "stats":
					lastStats = msg.stats;
					liveEvents.dispatchEvent(
						new CustomEvent("stats", { detail: msg.stats }),
					);
					break;
				case "log":
					liveEvents.dispatchEvent(
						new CustomEvent("log", {
							detail: { project: msg.project, id: msg.id },
						}),
					);
					break;
				case "ping":
					break; // watchdog already reset above
			}
		};
		// A socket abandoned above must not re-drop once its close event lands late.
		socket.onerror = () => {
			if (socket === ws) drop();
		};
		socket.onclose = () => {
			if (socket === ws) drop();
		};
		return socket;
	};

	ws = open();

	return () => {
		disposed = true;
		clearTimeout(connectTimeout);
		clearTimeout(watchdog);
		clearTimeout(reconnect);
		if (ws !== null) {
			abandon(ws);
			ws = null;
		}
	};
}

const POLL_MS = 5000;
const UPDATE_MS = 300_000;

/** Set only while a polling connection is live; refreshState routes through it. */
let pollNow: (() => void) | null = null;

/** Poll right now after a successful mutation (production mode has no pushed frames). The
 * cadence restarts at the refresh. No-op in live mode and after dispose. */
export function refreshState(): void {
	pollNow?.();
}

/** Prod board polls instead of holding a socket: the server refuses the socket in production mode. */
export function connectPolling(h: LiveHandlers): () => void {
	let disposed = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;

	const poll = (): void => {
		if (disposed) return;
		void fetch("/api/state")
			.then(async (r) => {
				if (!r.ok) {
					h.onOffline();
					return;
				}
				const state = (await r.json()) as StateResponse;
				lastQuota = state.quota;
				liveEvents.dispatchEvent(new Event("quota"));
				h.onState(state);
				h.onOnline();
				liveEvents.dispatchEvent(new Event("open"));
				void fetch("/api/stats")
					.then(async (sr) => {
						if (!sr.ok) return;
						const stats = (await sr.json()) as MachineStats;
						lastStats = stats;
						liveEvents.dispatchEvent(
							new CustomEvent("stats", { detail: stats }),
						);
					})
					.catch(() => {});
			})
			.catch(() => h.onOffline());
		// Reschedule at call time: the cadence stays fixed even when a response is slow.
		// ponytail: no overlap guard — a localhost fetch outliving 5 s means a dead server,
		// and the browser's per-origin connection cap bounds any pile-up. Add a skip flag
		// if a real deployment ever shows stacking requests.
		pollTimer = setTimeout(poll, POLL_MS);
	};

	const pollUpdate = (): void => {
		if (disposed) return;
		updateTimer = setTimeout(() => {
			if (disposed) return;
			void fetch("/api/update")
				.then(async (r) => {
					// trusted same-origin endpoint documented as { behind: number; commits: string[] }
					const body = (await r.json()) as {
						behind: number;
						commits: string[];
					};
					if (r.ok) h.onUpdate(body.behind, body.commits);
				})
				.catch(() => {}); // next window retries
			pollUpdate();
		}, UPDATE_MS);
	};

	pollNow = () => {
		clearTimeout(pollTimer);
		// poll reschedules at call time, so the next timed poll lands POLL_MS after the refresh.
		poll();
	};

	poll();
	pollUpdate();

	return () => {
		disposed = true;
		pollNow = null;
		clearTimeout(pollTimer);
		clearTimeout(updateTimer);
	};
}
