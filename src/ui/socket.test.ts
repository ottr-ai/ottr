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
						idleReviews: true,
						trendingScan: true,
						commitIdentity: null,
						trendingStatus: {
							lastRunAt: null,
							lastError: null,
							running: false,
						},
						serverVersion: "v1",
						quota: null,
						onboarding: false,
						user: null,
						seenAnswers: [],
						seenDoneSince: 0,
						inboxSeen: [],
						orphans: [],
						orphansError: null,
						keptWorktrees: { held: 0, stale: 0 },
						drainUntil: null,
						drainCommits: null,
						warnings: [],
						updates: null,
						alatePendingSince: null,
						deadSignIns: [],
						restartWait: null,
						seedFailed: null,
						alateProvisionError: null,
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
				idleReviews: true,
				trendingScan: true,
				commitIdentity: null,
				trendingStatus: { lastRunAt: null, lastError: null, running: false },
				serverVersion: "v1",
				quota: null,
				onboarding: false,
				user: null,
				seenAnswers: [],
				seenDoneSince: 0,
				inboxSeen: [],
				orphans: [],
				orphansError: null,
				keptWorktrees: { held: 0, stale: 0 },
				drainUntil: null,
				drainCommits: null,
				warnings: [],
				updates: null,
				alatePendingSince: null,
				deadSignIns: [],
				restartWait: null,
				seedFailed: null,
				alateProvisionError: null,
			},
		});
		const system = {
			at: 1,
			containers: [],
			vm: {
				cpuPct: null,
				cpus: 4,
				load1: null,
				memAvailable: null,
				memTotal: null,
				history: [],
			},
			holds: {
				drainUntil: null,
				drainCommits: null,
				maxTotal: null,
				running: 0,
				queued: 0,
				oldestQueuedAt: null,
			},
		};
		expect(
			parseServerMessage(JSON.stringify({ type: "system", system })),
		).toEqual({ type: "system", system });
		// A frame without the holds (an older or broken server) is dropped, not half-rendered.
		expect(
			parseServerMessage(
				JSON.stringify({
					type: "system",
					system: { at: 1, containers: [], vm: system.vm },
				}),
			),
		).toBeNull();
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
				case "system": {
					const s = m.system as Record<string, unknown>;
					return (
						typeof s === "object" &&
						s !== null &&
						typeof s.at === "number" &&
						Array.isArray(s.containers) &&
						typeof s.vm === "object" &&
						s.vm !== null &&
						typeof s.holds === "object" &&
						s.holds !== null
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
			for (let i = 0; i < 60; i++) await Promise.resolve();
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

	/** Stub fetch keyed by URL path; handlers return a Response or a promise of one, or throw.
	 * An aborted signal rejects the result even when the handler's promise never settles. */
	let routes: Record<string, () => Response | Promise<Response>>;
	const calls: string[] = [];
	const fakeFetch = (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const path = new URL(String(input), "http://poll.test").pathname;
		calls.push(path);
		const handler = routes[path];
		try {
			// Real fetch rejects instead of throwing, so a missing route rejects too.
			if (!handler) throw new Error(`unexpected fetch: ${path}`);
			const result = Promise.resolve(handler());
			const signal = init?.signal;
			if (!signal) return result;
			return new Promise<Response>((resolve, reject) => {
				if (signal.aborted)
					reject(new DOMException("The operation was aborted.", "AbortError"));
				else
					signal.addEventListener("abort", () =>
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						),
					);
				result.then(resolve, reject);
			});
		} catch (e) {
			return Promise.reject(e);
		}
	};
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), { status: 200 });

	/** Let the poll chains settle: each Response.json() and the abort wiring take
	 * several microtask rounds, so one yield is nowhere near enough. */
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 40; i++) await Promise.resolve();
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
	const SYSTEM = {
		at: 0,
		containers: [],
		vm: {
			cpuPct: null,
			cpus: 1,
			load1: null,
			memAvailable: null,
			memTotal: null,
			history: [],
		},
		holds: {
			drainUntil: null,
			drainCommits: null,
			maxTotal: null,
			running: 0,
			queued: 0,
			oldestQueuedAt: null,
		},
	};
	const makeHandlers = () => {
		const seen: {
			state: unknown;
			behind: number;
			commits: string[];
			online: number;
			offline: number;
			offlineStatus: number | null;
		} = {
			state: null,
			behind: -1,
			commits: [],
			online: 0,
			offline: 0,
			offlineStatus: null,
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
			onOffline: (status?: number) => {
				seen.offline++;
				seen.offlineStatus = status ?? null;
			},
		};
		return { h, seen };
	};

	test("happy path: state poll, system event, and the update poll", async () => {
		routes["/api/state"] = () => ok(STATE);
		routes["/api/system"] = () => ok(SYSTEM);
		routes["/api/update"] = () => ok({ behind: 3, commits: ["feat: a"] });
		const systemEvents: unknown[] = [];
		liveEvents.addEventListener("system", (e: Event) => {
			if (e instanceof CustomEvent) systemEvents.push(e.detail);
		});
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		expect(calls).toEqual(["/api/state", "/api/system"]);
		expect(seen.state).toEqual(STATE);
		expect(seen.online).toBe(1);
		expect(seen.offline).toBe(0);
		expect(systemEvents).toEqual([SYSTEM]);

		// The overlap guard holds each tick's chain open, so every tick drains before
		// the next one fires; 60 ticks at 5 s plus the boot poll make 61 state polls.
		// The first update poll lands at the 300 s mark.
		for (let i = 0; i < 60; i++) {
			advance(5000);
			await drain();
		}
		// every 5 s poll plus the first update poll at the 300 s mark
		expect(calls.filter((p) => p === "/api/state")).toHaveLength(61);
		expect(calls.filter((p) => p === "/api/system")).toHaveLength(61);
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
		// a rejected fetch has no HTTP status: the transport status 0 tells the App
		// this cannot be a session loss, so it never probes /api/state again
		expect(seen.offlineStatus).toBe(0);
		expect(seen.online).toBe(1);
		expect(seen.state).toEqual(STATE);
		dispose();
	});

	test("dispose stops all polling", () => {
		routes["/api/state"] = () => ok(STATE);
		routes["/api/system"] = () => ok(SYSTEM);
		const { h } = makeHandlers();
		const dispose = connectPolling(h);
		// state and system go out together with the boot poll
		expect(calls).toEqual(["/api/state", "/api/system"]);
		dispose();
		advance(5000 * 3);
		expect(calls).toEqual(["/api/state", "/api/system"]);
	});

	test("a refresh during a slow poll marks dirty and runs one follow-up", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		routes["/api/state"] = async () => {
			await gate;
			return ok(STATE);
		};
		routes["/api/system"] = () => ok(SYSTEM);
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		const states = (): number => calls.filter((p) => p === "/api/state").length;
		expect(states()).toBe(1);
		// system went out while the state response still hangs: requested together
		expect(calls.filter((p) => p === "/api/system").length).toBe(1);
		expect(seen.online).toBe(0);

		// A mutation-driven refresh during the flight is guarded: no overlapping request.
		refreshState();
		await drain();
		expect(states()).toBe(1);
		expect(calls.filter((p) => p === "/api/system").length).toBe(1);

		// The flight's end runs exactly one follow-up poll, then restates the cadence.
		release();
		await drain();
		expect(states()).toBe(2);
		// both polls succeeded; the guarded tick never went offline
		expect(seen.online).toBe(2);
		expect(seen.offline).toBe(0);
		advance(4999);
		expect(states()).toBe(2);
		advance(1);
		await drain();
		expect(states()).toBe(3);
		dispose();
	});

	test("a poll that never settles aborts, goes offline, and recovers", async () => {
		let hang = true;
		routes["/api/state"] = () => {
			// The server accepted the connection but never answers.
			if (hang) return new Promise<Response>(() => {});
			return ok(STATE);
		};
		routes["/api/system"] = () => ok(SYSTEM);
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		const states = (): number => calls.filter((p) => p === "/api/state").length;
		expect(states()).toBe(1);
		expect(seen.offline).toBe(0);

		// POLL_MS aborts the hung flight; the same mark's tick only sets dirty.
		// The aborted flight reports offline with the transport status 0, and the
		// follow-up its settle schedules sends a fresh request, which recovers.
		advance(5000);
		hang = false; // the follow-up's own request gets a real answer
		await drain();
		expect(seen.offline).toBe(1);
		expect(seen.offlineStatus).toBe(0);
		expect(states()).toBe(2);
		expect(seen.online).toBe(1);
		dispose();
	});

	test("an offline state response carries its status to onOffline", async () => {
		routes["/api/state"] = () => new Response("{}", { status: 401 });
		routes["/api/system"] = () => ok(SYSTEM);
		const { h, seen } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		expect(seen.offline).toBe(1);
		expect(seen.offlineStatus).toBe(401);
		// system went out in parallel with the failed state poll
		expect(calls).toEqual(["/api/state", "/api/system"]);
		dispose();
	});

	test("refreshState polls at once and restarts the cadence from the refresh", async () => {
		routes["/api/state"] = () => ok(STATE);
		routes["/api/system"] = () => ok(SYSTEM);
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
		routes["/api/system"] = () => ok(SYSTEM);
		const { h } = makeHandlers();
		const dispose = connectPolling(h);
		await drain();
		expect(calls).toEqual(["/api/state", "/api/system"]);
		dispose();
		refreshState();
		await drain();
		advance(5000);
		await drain();
		expect(calls).toEqual(["/api/state", "/api/system"]);
	});
});
