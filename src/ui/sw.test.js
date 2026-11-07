// Tests for the service worker's push/notificationclick policy. sw.js talks to the
// worker-global `self`, so the tests install a fake `self` and then import the worker
// once, and each test drives the captured event handlers. Plain JS because sw.js is
// untyped (no allowJs in tsconfig, so a .test.ts could not import it).
import { afterAll, beforeEach, expect, test } from "bun:test";

const controlled = [];
const uncontrolled = [];
const calls = {
	notifications: [],
	focused: [],
	opened: [],
	closed: 0,
	trayClosed: [],
	fetches: [],
};
// Notifications currently shown, as { tag, title, data }.
const tray = [];
// What the fake /api/notifications/live answers: a per-class state object, or "fail".
let liveResponse = "fail";
// When set, the live fetch waits for this promise first (to interleave two handlers).
let liveGate = null;
const listeners = {};

const previousSelf = globalThis.self;
afterAll(() => {
	globalThis.self = previousSelf;
});

const previousFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = previousFetch;
});
globalThis.fetch = async (url, init) => {
	calls.fetches.push({ url, credentials: init?.credentials });
	// Captured per call, so two interleaved handlers can see different answers and gates.
	const answer = liveResponse;
	const gate = liveGate;
	if (gate !== null) await gate;
	if (answer === "fail") throw new Error("offline");
	return { ok: true, json: async () => answer };
};

/** Live state where `tag` has `live` alerts and its last sent alert is #`seq`. */
const liveOf = (tag, live, seq) => ({
	request: { live: 0, seq: 0 },
	error: { live: 0, seq: 0 },
	complete: { live: 0, seq: 0 },
	[tag]: { live, seq },
});

// Cache API stand-in: the worker's persisted history lives here, across worker restarts.
const cacheStore = new Map();
const previousCaches = globalThis.caches;
afterAll(() => {
	globalThis.caches = previousCaches;
});
globalThis.caches = {
	open: async () => ({
		match: async (url) =>
			cacheStore.has(url) ? new Response(cacheStore.get(url)) : undefined,
		put: async (url, res) => {
			cacheStore.set(url, await res.text());
		},
	}),
};
let endpoint = "https://push.example/me";

globalThis.self = {
	addEventListener: (type, handler) => {
		listeners[type] = handler;
	},
	registration: {
		showNotification: async (title, options) => {
			calls.notifications.push({ title, options });
			// Same tag replaces, as in browsers.
			if (options.tag !== undefined)
				for (let i = tray.length - 1; i >= 0; i--)
					if (tray[i].tag === options.tag) tray.splice(i, 1);
			tray.push({ tag: options.tag, title, data: options.data });
		},
		pushManager: {
			getSubscription: async () => ({ endpoint }),
		},
		getNotifications: async ({ tag }) =>
			tray
				.filter((n) => n.tag === tag)
				.map((n) => ({
					...n,
					close: () => {
						tray.splice(tray.indexOf(n), 1);
						calls.trayClosed.push(n.title);
					},
				})),
	},
	clients: {
		matchAll: async (options) => {
			if (options.type !== "window") return [];
			return options.includeUncontrolled
				? [...controlled, ...uncontrolled]
				: [...controlled];
		},
		openWindow: async (url) => {
			calls.opened.push(url);
		},
	},
};

// The ?ottr-test query gives this import its own module instance: sw.js registers its
// handlers on `self` at module scope, and Stryker's bun runner eagerly imports every
// mutated file first, so a plain import here would return the already-evaluated module
// whose handlers went to the real test-process self instead of this fake.
await import("./sw.js?ottr-test");

beforeEach(() => {
	calls.notifications.length = 0;
	calls.focused.length = 0;
	calls.opened.length = 0;
	calls.closed = 0;
	calls.trayClosed.length = 0;
	calls.fetches.length = 0;
	tray.length = 0;
	liveResponse = "fail";
	liveGate = null;
	cacheStore.clear();
	endpoint = "https://push.example/me";
	controlled.length = 0;
	uncontrolled.length = 0;
});

function client(url, focusable) {
	const c = { url };
	if (focusable) c.focus = async () => calls.focused.push(c);
	return c;
}

async function push(data) {
	const waits = [];
	listeners.push({
		data: data === undefined ? null : { json: () => data },
		waitUntil: (promise) => waits.push(promise),
	});
	await Promise.all(waits);
}

async function click(notification) {
	const waits = [];
	listeners.notificationclick({
		notification: {
			...notification,
			close: () => {
				calls.closed++;
			},
		},
		waitUntil: (promise) => waits.push(promise),
	});
	await Promise.all(waits);
}

test("push shows a notification built from the payload", async () => {
	await push({ title: "Ready", body: "task done", tag: "t1", url: "/tasks/1" });
	expect(calls.notifications).toEqual([
		{
			title: "Ready",
			options: {
				body: "task done",
				tag: "t1",
				renotify: true,
				icon: "/icon-192.png",
				data: { url: "/tasks/1", seq: 0 },
			},
		},
	]);
});

test("push falls back to defaults for missing payload fields", async () => {
	await push({});
	expect(calls.notifications).toEqual([
		{
			title: "Ottr",
			options: {
				body: undefined,
				tag: undefined,
				renotify: false,
				icon: "/icon-192.png",
				data: { url: "/", seq: 0 },
			},
		},
	]);
});

test("push without event data uses the defaults", async () => {
	await push();
	expect(calls.notifications[0].title).toBe("Ottr");
	expect(calls.notifications[0].options.data.url).toBe("/");
});

test("push keeps an empty-string title and url over the fallback", async () => {
	await push({ title: "", url: "" });
	expect(calls.notifications[0].title).toBe("");
	expect(calls.notifications[0].options.data.url).toBe("");
});

test("notificationclick focuses the matching window client", async () => {
	const match = client("http://localhost:3000/tasks/1", true);
	controlled.push(client("http://localhost:3000/other", true), match);
	await click({ data: { url: "/tasks/1" } });
	expect(calls.focused).toEqual([match]);
	expect(calls.opened).toEqual([]);
	expect(calls.closed).toBe(1);
});

test("notificationclick opens a window when no focusable client matches", async () => {
	controlled.push(client("http://localhost:3000/tasks/1", false));
	await click({ data: { url: "/tasks/1" } });
	expect(calls.focused).toEqual([]);
	expect(calls.opened).toEqual(["/tasks/1"]);
});

test("notificationclick also matches uncontrolled clients", async () => {
	const stray = client("http://localhost:3000/tasks/2", true);
	uncontrolled.push(stray);
	await click({ data: { url: "/tasks/2" } });
	expect(calls.focused).toEqual([stray]);
	expect(calls.opened).toEqual([]);
});

test("notificationclick without notification data opens the board root", async () => {
	await click();
	expect(calls.opened).toEqual(["/"]);
	expect(calls.closed).toBe(1);
});

const alert = {
	type: "alert",
	title: "p: card",
	body: "needs you",
	tag: "request",
	url: "/projects/p/tasks/1",
	keys: ["task:1:needs"],
	partial: false,
	seq: 5,
	clear: [],
	upTo: {},
};

test("alert push asks the server for this device's live state, then shows the newest live alert", async () => {
	liveResponse = liveOf("request", 1, 5);
	await push(alert);
	expect(calls.fetches).toEqual([
		{
			url: `/api/notifications/live?endpoint=${encodeURIComponent("https://push.example/me")}`,
			credentials: "same-origin",
		},
	]);
	expect(calls.notifications).toEqual([
		{
			title: "p: card",
			options: {
				body: "needs you",
				tag: "request",
				renotify: true,
				icon: "/icon-192.png",
				data: { url: "/projects/p/tasks/1", seq: 5 },
			},
		},
	]);
});

test("a resolved or acknowledged alert never shows, a partial group included", async () => {
	// Clear first, the delayed alert after: the server reports the class dead.
	liveResponse = liveOf("request", 0, 5);
	await push({ type: "clear", tags: ["request"], upTo: { request: 5 } });
	await push({ ...alert, partial: true });
	expect(calls.notifications).toEqual([]);
	expect(tray).toEqual([]);
});

test("a superseded alert never shows: an older payload arriving late stays hidden", async () => {
	liveResponse = liveOf("request", 2, 6);
	await push({ ...alert, seq: 6, title: "newer" });
	await push(alert); // seq 5, arrives after #6
	expect(tray.map((n) => n.title)).toEqual(["newer"]);
});

test("concurrent handlers run in order: a slow older alert cannot overwrite a newer one", async () => {
	// #5 reads a state where it is still the newest, but its answer is slow; #6 is sent
	// meanwhile. Run in parallel, #6 would show first and #5 would then replace it.
	liveResponse = liveOf("request", 1, 5);
	const gate = Promise.withResolvers();
	liveGate = gate.promise;
	const older = push(alert);
	await Promise.resolve();
	liveResponse = liveOf("request", 2, 6);
	liveGate = null;
	const newer = push({ ...alert, seq: 6, title: "newer" });
	await new Promise((r) => setTimeout(r, 5));
	gate.resolve();
	await Promise.all([older, newer]);
	expect(tray.map((n) => n.title)).toEqual(["newer"]);
});

test("every push closes classes the server reports with no live alert", async () => {
	tray.push(
		{ tag: "error", title: "dead error", data: { seq: 9 } },
		{ tag: "complete", title: "dead done", data: { seq: 1 } },
	);
	liveResponse = liveOf("request", 1, 5);
	await push(alert);
	expect(calls.trayClosed.sort()).toEqual(["dead done", "dead error"]);
	expect(tray.map((n) => n.title)).toEqual(["p: card"]);
	// A clear push with live state keeps a class that still has a live alert.
	await push({ type: "clear", tags: ["request"], upTo: { request: 5 } });
	expect(tray.map((n) => n.title)).toEqual(["p: card"]);
});

test("offline fallback: a clear closes notifications up to each class's bound", async () => {
	tray.push(
		{ tag: "request", title: "a", data: { seq: 3 } },
		{ tag: "error", title: "b", data: { seq: 1 } },
		{ tag: "complete", title: "c" },
	);
	await push({
		type: "clear",
		tags: ["request", "complete"],
		upTo: { request: 3, complete: 0 },
	});
	expect(calls.notifications).toEqual([]);
	expect(calls.trayClosed.sort()).toEqual(["a", "c"]);
	expect(tray.map((n) => n.title)).toEqual(["b"]);
});

test("offline fallback: a late retraction never closes a notification shown after it was decided", async () => {
	tray.push({ tag: "request", title: "newer", data: { seq: 4 } });
	await push({ type: "clear", tags: ["request"], upTo: { request: 3 } });
	expect(tray.map((n) => n.title)).toEqual(["newer"]);
	await push({
		...alert,
		tag: "error",
		seq: 1,
		clear: ["request"],
		upTo: { request: 3 },
	});
	expect(tray.map((n) => n.title).sort()).toEqual(["newer", "p: card"]);
});

test("offline fallback: an older alert never replaces a newer one; a newest one shows", async () => {
	tray.push({ tag: "request", title: "newer", data: { seq: 6 } });
	await push(alert); // seq 5
	expect(calls.notifications).toEqual([]);
	await push({ ...alert, seq: 7, title: "newest" });
	expect(tray.map((n) => n.title)).toEqual(["newest"]);
});

test("offline: a clear's bound outlives the empty tray, so a delayed resolved alert stays hidden", async () => {
	// Online clear first, then the board becomes unreachable and the delayed alert lands.
	liveResponse = liveOf("request", 0, 5);
	await push({ type: "clear", tags: ["request"], upTo: { request: 5 } });
	liveResponse = "fail";
	await push(alert); // #5, empty upTo, empty tray
	expect(calls.notifications).toEqual([]);
	// Offline throughout: the clear's own bound is remembered just the same.
	cacheStore.clear();
	await push({ type: "clear", tags: ["request"], upTo: { request: 5 } });
	await push(alert);
	expect(calls.notifications).toEqual([]);
	// A newer alert still shows.
	await push({ ...alert, seq: 6, title: "newer" });
	expect(tray.map((n) => n.title)).toEqual(["newer"]);
});

test("offline: an alert older than one already shown stays hidden after the newer was dismissed", async () => {
	await push({ ...alert, seq: 6, title: "newer" });
	tray.length = 0; // the user swiped it away
	await push(alert); // #5 arrives late
	expect(calls.notifications.map((n) => n.title)).toEqual(["newer"]);
});

test("the history survives a worker restart; a new subscription starts fresh", async () => {
	await push({ type: "clear", tags: ["request"], upTo: { request: 5 } });
	// A fresh module instance stands for a restarted worker; only the Cache API remains.
	await import("./sw.js?ottr-test-restart");
	await push(alert);
	expect(calls.notifications).toEqual([]);
	// After a re-subscribe the server numbers from 1 again: old history must not hide it.
	endpoint = "https://push.example/resubscribed";
	await push({ ...alert, seq: 1, title: "fresh" });
	expect(tray.map((n) => n.title)).toEqual(["fresh"]);
});

test("untyped push shows without consulting the server", async () => {
	await push({ title: "Test", body: "hi" });
	expect(calls.notifications[0].title).toBe("Test");
	expect(calls.fetches).toEqual([]);
});
