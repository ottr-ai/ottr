import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "../test/properties.ts";
import {
	connectLive,
	connectPolling,
	liveEvents,
	parseServerMessage,
	reconnectDelay,
	refreshState,
} from "./socket.ts";

describe("parseServerMessage", () => {
	test("accepts one valid frame of each type", () => {
		expect(
			parseServerMessage(
				JSON.stringify({
					type: "state",
					state: {
						tasks: [],
						projects: [],
						maxTotal: 3,
						reviewCheck: true,
						workCheck: true,
						serverVersion: "v1",
						quota: null,
						onboarding: false,
						user: null,
						seenAnswers: [],
						orphans: [],
						orphansError: null,
						keptWorktrees: { held: 0, stale: 0 },
						drainUntil: null,
						drainCommits: null,
						updates: null,
						alatePendingSince: null,
						deadSignIns: [],
					},
				}),
			),
		).toEqual({
			type: "state",
			state: {
				tasks: [],
				projects: [],
				maxTotal: 3,
				reviewCheck: true,
				workCheck: true,
				serverVersion: "v1",
				quota: null,
				onboarding: false,
				user: null,
				seenAnswers: [],
				orphans: [],
				orphansError: null,
				keptWorktrees: { held: 0, stale: 0 },
				drainUntil: null,
				drainCommits: null,
				updates: null,
				alatePendingSince: null,
				deadSignIns: [],
			},
		});
		expect(
			parseServerMessage(
				JSON.stringify({
					type: "stats",
					stats: {
						cpu: 3,
						ram: { usedGiB: 1, totalGiB: 2, pct: 50 },
					},
				}),
			),
		).toEqual({
			type: "stats",
			stats: {
				cpu: 3,
				ram: { usedGiB: 1, totalGiB: 2, pct: 50 },
			},
		});
		expect(
			parseServerMessage(
				JSON.stringify({ type: "update", behind: 2, commits: ["feat: a"] }),
			),
		).toEqual({ type: "update", behind: 2, commits: ["feat: a"] });
		expect(
			parseServerMessage(
				JSON.stringify({ type: "log", project: "p", id: "t1" }),
			),
		).toEqual({ type: "log", project: "p", id: "t1" });
		expect(parseServerMessage(JSON.stringify({ type: "ping" }))).toEqual({
			type: "ping",
		});
	});

	test("returns null for invalid JSON and a non-string", () => {
		expect(parseServerMessage("{not json")).toBeNull();
		expect(parseServerMessage(42)).toBeNull();
	});

	test("returns null for a non-object", () => {
		expect(parseServerMessage(JSON.stringify("hi"))).toBeNull();
	});

	test("returns null for an unknown type", () => {
		expect(parseServerMessage(JSON.stringify({ type: "nope" }))).toBeNull();
	});

	test("returns null for a state without tasks", () => {
		expect(
			parseServerMessage(
				JSON.stringify({
					type: "state",
					state: { projects: [], serverVersion: "v1" },
				}),
			),
		).toBeNull();
	});

	test("returns null for an update with a string behind", () => {
		expect(
			parseServerMessage(JSON.stringify({ type: "update", behind: "2" })),
		).toBeNull();
	});

	test("returns null for an update without commits or with a non-string commit", () => {
		expect(
			parseServerMessage(JSON.stringify({ type: "update", behind: 2 })),
		).toBeNull();
		expect(
			parseServerMessage(
				JSON.stringify({ type: "update", behind: 2, commits: [2] }),
			),
		).toBeNull();
	});

	test("returns null for a log without id", () => {
		expect(
			parseServerMessage(JSON.stringify({ type: "log", project: "p" })),
		).toBeNull();
	});

	test("never throws; returns null or a ServerMessage shape (property)", () => {
		// Mirrors the guards in parseServerMessage: null, or one of the five shapes it returns.
		const matches = (r: unknown): boolean => {
			if (r === null) return true;
			if (typeof r !== "object") return false;
			const m = r as Record<string, unknown>;
			switch (m.type) {
				case "state": {
					const s = m.state;
					return (
						typeof s === "object" &&
						s !== null &&
						Array.isArray((s as Record<string, unknown>).tasks) &&
						Array.isArray((s as Record<string, unknown>).projects) &&
						typeof (s as Record<string, unknown>).serverVersion === "string"
					);
				}
				case "stats": {
					const s = m.stats as Record<string, unknown>;
					return (
						typeof s === "object" &&
						s !== null &&
						typeof s.cpu === "number" &&
						typeof s.ram === "object" &&
						s.ram !== null &&
						typeof (s.ram as Record<string, unknown>).pct === "number"
					);
				}
				case "update":
					return (
						typeof m.behind === "number" &&
						Number.isFinite(m.behind) &&
						Array.isArray(m.commits) &&
						m.commits.every((c) => typeof c === "string")
					);
				case "log":
					return typeof m.project === "string" && typeof m.id === "string";
				case "ping":
					return true;
				default:
					return false;
			}
		};
		const frame = fc.oneof(
			fc.string(),
			fc.jsonValue().map((v) => JSON.stringify(v)),
		);
		fc.assert(
			fc.property(frame, (raw) => {
				const out = parseServerMessage(raw);
				expect(out === null || matches(out)).toBe(true);
			}),
			{ examples: [["{not json"], ['{"type":"ping"}']] },
		);
	});
});

describe("reconnectDelay", () => {
	test("doubles from 500 ms and caps at 5 s", () => {
		expect(reconnectDelay(0)).toBe(500);
		expect(reconnectDelay(1)).toBe(1000);
		expect(reconnectDelay(2)).toBe(2000);
		expect(reconnectDelay(3)).toBe(4000);
		expect(reconnectDelay(4)).toBe(5000);
		expect(reconnectDelay(10)).toBe(5000);
	});
});

// connectLive only touches browser globals inside its callbacks, so tests swap in a fake
// WebSocket, a fixed origin, and a manual clock: no real 5 s/15 s waits, no network.
class FakeWebSocket {
	static readonly OPEN = 1;
	static created: FakeWebSocket[] = [];
	url: string;
	readyState = 0; // CONNECTING
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	closed = false;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.created.push(this);
	}
	close(): void {
		this.closed = true;
	}
	/** Test-side: the (fake) server accepts the connection. */
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	message(data: string): void {
		this.onmessage?.({ data });
	}
	shut(): void {
		this.onclose?.();
	}
}

/** The nth socket connectLive created; fails loudly when the test's assumption is wrong. */
function socketAt(n: number): FakeWebSocket {
	const s = FakeWebSocket.created[n];
	if (!s)
		throw new Error(
			`no socket #${n}; created: ${FakeWebSocket.created.length}`,
		);
	return s;
}

type Timer = { id: number; at: number; run: () => void };
let timers: Timer[] = [];
let timerSeq = 0;
let clock = 0;

const fakeSetTimeout = (run: () => void, ms?: number): number => {
	const id = ++timerSeq;
	timers.push({ id, at: clock + (ms ?? 0), run });
	return id;
};
const fakeClearTimeout = (id?: unknown): void => {
	timers = timers.filter((t) => t.id !== id);
};

/** Fire every timer due within the next ms in time order; timers scheduled en route run too. */
function advance(ms: number): void {
	const deadline = clock + ms;
	for (;;) {
		const due = timers
			.filter((t) => t.at <= deadline)
			.sort((a, b) => a.at - b.at)[0];
		if (!due) break;
		timers = timers.filter((t) => t.id !== due.id);
		clock = Math.max(clock, due.at);
		due.run();
	}
	clock = deadline;
}

describe("connectLive", () => {
	const g = globalThis as unknown as Record<string, unknown>;
	const originals = {
		location: g.location,
		WebSocket: g.WebSocket,
		setTimeout: g.setTimeout,
		clearTimeout: g.clearTimeout,
	};

	beforeEach(() => {
		timers = [];
		timerSeq = 0;
		clock = 0;
		FakeWebSocket.created = [];
		g.location = { protocol: "http:", host: "tracker.test" };
		g.WebSocket = FakeWebSocket;
		g.setTimeout = fakeSetTimeout;
		g.clearTimeout = fakeClearTimeout;
	});

	afterEach(() => {
		g.location = originals.location;
		g.WebSocket = originals.WebSocket;
		g.setTimeout = originals.setTimeout;
		g.clearTimeout = originals.clearTimeout;
	});

	test("live mode: refreshState never polls", async () => {
		const polled: string[] = [];
		const realFetch = g.fetch;
		g.fetch = (input: string | URL | Request): Promise<Response> => {
			polled.push(new URL(String(input), "http://live.test").pathname);
			return Promise.resolve(new Response("{}", { status: 200 }));
		};
		try {
			const dispose = connectLive(makeHandlers().h);
			refreshState();
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(polled).toEqual([]);
			dispose();
		} finally {
			g.fetch = realFetch;
		}
	});

	const makeHandlers = () => {
		const calls = { state: 0, update: 0, online: 0, offline: 0 };
		const h: Parameters<typeof connectLive>[0] = {
			onState: () => calls.state++,
			onUpdate: () => calls.update++,
			onOnline: () => calls.online++,
			onOffline: () => calls.offline++,
		};
		return { h, calls };
	};

	test("reconnects after close with doubling backoff, reset by a successful open", () => {
		const { h, calls } = makeHandlers();
		const dispose = connectLive(h);
		expect(FakeWebSocket.created).toHaveLength(1);
		expect(socketAt(0).url).toBe("ws://tracker.test/api/ws");
		const first = socketAt(0);
		first.open();
		expect(calls.online).toBe(1);

		// Close after a successful open: the attempt counter was reset, so 500 ms.
		first.shut();
		expect(calls.offline).toBe(1);
		advance(499);
		expect(FakeWebSocket.created).toHaveLength(1);
		advance(1);
		expect(FakeWebSocket.created).toHaveLength(2);

		// Close without a successful open in between: the delay doubles to 1000 ms.
		socketAt(1).shut();
		expect(calls.offline).toBe(2);
		advance(999);
		expect(FakeWebSocket.created).toHaveLength(2);
		advance(1);
		expect(FakeWebSocket.created).toHaveLength(3);

		// A successful open resets the counter: the next delay is 500 ms again.
		socketAt(2).open();
		expect(calls.online).toBe(2);
		socketAt(2).shut();
		advance(499);
		expect(FakeWebSocket.created).toHaveLength(3);
		advance(1);
		expect(FakeWebSocket.created).toHaveLength(4);
		dispose();
	});

	test("watchdog abandons a silent socket and reconnects; frames keep it alive", () => {
		const { h, calls } = makeHandlers();
		const dispose = connectLive(h);
		const first = socketAt(0);
		first.open();
		advance(15000); // no frame for 15 s: the watchdog must kill the socket
		expect(first.onopen).toBeNull(); // abandoned, so its late events cannot re-drop
		expect(first.onclose).toBeNull();
		expect(first.closed).toBe(true);
		expect(calls.offline).toBe(1);
		expect(FakeWebSocket.created).toHaveLength(1); // reconnect waits out the backoff
		advance(500);
		expect(FakeWebSocket.created).toHaveLength(2);
		const second = socketAt(1);
		second.open();
		expect(calls.online).toBe(2);

		// Frames re-arm the watchdog: pings every 5 s keep the socket alive forever.
		advance(5000);
		second.message(JSON.stringify({ type: "ping" }));
		advance(5000);
		second.message(JSON.stringify({ type: "ping" }));
		advance(14999);
		expect(calls.offline).toBe(1); // the 15 s silence was never reached
		expect(FakeWebSocket.created).toHaveLength(2);
		dispose();
	});

	test("dispose detaches the live socket and ignores its late events", () => {
		const { h, calls } = makeHandlers();
		const dispose = connectLive(h);
		const first = socketAt(0);
		first.open();
		dispose();
		expect(first.onopen).toBeNull();
		expect(first.onmessage).toBeNull();
		expect(first.onerror).toBeNull();
		expect(first.onclose).toBeNull();
		expect(first.closed).toBe(true);
		// The abandoned socket's late close must neither notify nor reconnect.
		first.shut();
		expect(calls.offline).toBe(0);
		advance(60000);
		expect(FakeWebSocket.created).toHaveLength(1);
	});

	test("dispose cancels a pending reconnect", () => {
		const { h, calls } = makeHandlers();
		const dispose = connectLive(h);
		socketAt(0).open();
		socketAt(0).shut(); // schedules a reconnect in 500 ms
		expect(calls.offline).toBe(1);
		dispose();
		advance(60000);
		expect(FakeWebSocket.created).toHaveLength(1); // never reconnects after dispose
	});
});

describe("connectPolling", () => {
	const g = globalThis as unknown as Record<string, unknown>;
	const originals = {
		setTimeout: g.setTimeout,
		clearTimeout: g.clearTimeout,
		fetch: g.fetch,
	};

	/** Stub fetch keyed by URL path; handlers return Response objects or throw. */
	let routes: Record<string, () => Response>;
	const calls: string[] = [];
	const fakeFetch = (input: string | URL | Request): Promise<Response> => {
		const path = new URL(String(input), "http://poll.test").pathname;
		calls.push(path);
		const handler = routes[path];
		try {
			// Real fetch rejects instead of throwing, so a missing route rejects too.
			if (!handler) throw new Error(`unexpected fetch: ${path}`);
			return Promise.resolve(handler());
		} catch (e) {
			return Promise.reject(e);
		}
	};
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), { status: 200 });

	/** Let the poll chain's microtasks settle; the queue drains fully on one yield. */
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};

	beforeEach(() => {
		timers = [];
		timerSeq = 0;
		clock = 0;
		calls.length = 0;
		routes = {};
		g.setTimeout = fakeSetTimeout;
		g.clearTimeout = fakeClearTimeout;
		g.fetch = fakeFetch;
	});

	afterEach(() => {
		g.setTimeout = originals.setTimeout;
		g.clearTimeout = originals.clearTimeout;
		g.fetch = originals.fetch;
	});

	const STATE = { tasks: [], seenAnswers: [], serverVersion: "v" };
	const STATS = { cpu: 0, ram: { usedGiB: 0, totalGiB: 1, pct: 0 } };
	const makeHandlers = () => {
		const seen: {
			state: unknown;
			behind: number;
			commits: string[];
			online: number;
			offline: number;
		} = {
			state: null,
			behind: -1,
			commits: [],
			online: 0,
			offline: 0,
		};
		const h: Parameters<typeof connectPolling>[0] = {
			onState: (s) => {
				seen.state = s;
			},
			onUpdate: (b, c) => {
				seen.behind = b;
				seen.commits = c;
			},
			onOnline: () => {
				seen.online++;
			},
			onOffline: () => {
				seen.offline++;
			},
		};
		return { h, seen };
	};

	test("happy path: state poll, stats event, and the update poll", async () => {
		routes["/api/state"] = () => ok(STATE);
		routes["/api/stats"] = () => ok(STATS);
		routes["/api/update"] = () => ok({ behind: 3, commits: ["feat: a"] });
		const statsEvents: unknown[] = [];
		liveEvents.addEventListener("stats", (e: Event) => {
			if (e instanceof CustomEvent) statsEvents.push(e.detail);
		});
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		expect(calls).toEqual(["/api/state", "/api/stats"]);
		expect(seen.state).toEqual(STATE);
		expect(seen.online).toBe(1);
		expect(seen.offline).toBe(0);
		expect(statsEvents).toEqual([STATS]);

		advance(300_000);
		await drain();
		// every 5 s poll plus the first update poll at the 300 s mark
		expect(calls.filter((p) => p === "/api/state")).toHaveLength(61);
		expect(calls.filter((p) => p === "/api/stats")).toHaveLength(61);
		expect(calls.filter((p) => p === "/api/update")).toHaveLength(1);
		expect(seen.behind).toBe(3);
		expect(seen.commits).toEqual(["feat: a"]);
		dispose();
	});

	test("failure and recovery: rejected fetch goes offline, next poll recovers", async () => {
		let fail = true;
		routes["/api/state"] = () => {
			if (fail) throw new TypeError("network down");
			return ok(STATE);
		};
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		expect(seen.offline).toBe(1);
		expect(seen.online).toBe(0);

		fail = false;
		advance(5000);
		await drain();
		expect(seen.offline).toBe(1);
		expect(seen.online).toBe(1);
		expect(seen.state).toEqual(STATE);
		dispose();
	});

	test("dispose stops all polling", () => {
		routes["/api/state"] = () => ok(STATE);
		const { h } = makeHandlers();
		const dispose = connectPolling(h);
		expect(calls).toEqual(["/api/state"]);
		dispose();
		advance(5000 * 3);
		expect(calls).toEqual(["/api/state"]);
	});

	test("refreshState polls at once and restarts the cadence from the refresh", async () => {
		routes["/api/state"] = () => ok(STATE);
		routes["/api/stats"] = () => ok(STATS);
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		const states = (): number => calls.filter((p) => p === "/api/state").length;
		expect(states()).toBe(1);

		// The mutation-driven poll lands immediately, not at the next tick.
		refreshState();
		await drain();
		expect(states()).toBe(2);

		// The cadence restarts at the refresh: quiet at 4999 ms, next poll at 5 s.
		advance(4999);
		expect(states()).toBe(2);
		advance(1);
		await drain();
		expect(states()).toBe(3);
		expect(seen.state).toEqual(STATE);
		dispose();
	});

	test("refreshState does nothing after dispose", async () => {
		routes["/api/state"] = () => ok(STATE);
		routes["/api/stats"] = () => ok(STATS);
		const { h } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		expect(calls).toEqual(["/api/state", "/api/stats"]);
		dispose();
		refreshState();
		await drain();
		advance(5000);
		await drain();
		expect(calls).toEqual(["/api/state", "/api/stats"]);
	});
});
