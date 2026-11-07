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
// What the fake fetch of /api/inbox/seen does: a keys array, or "fail".
let seenResponse = [];
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
	if (seenResponse === "fail") throw new Error("offline");
	return { ok: true, json: async () => ({ keys: seenResponse }) };
};

globalThis.self = {
	addEventListener: (type, handler) => {
		listeners[type] = handler;
	},
	registration: {
		showNotification: async (title, options) => {
			calls.notifications.push({ title, options });
			tray.push({ tag: options.tag, title, data: options.data });
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
	seenResponse = [];
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
				data: { url: "/tasks/1", keys: [] },
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
				data: { url: "/", keys: [] },
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
	clear: [],
};

test("clear push closes matching notifications and shows nothing", async () => {
	tray.push(
		{ tag: "request", title: "a" },
		{ tag: "error", title: "b" },
		{ tag: "complete", title: "c" },
	);
	await push({ type: "clear", tags: ["request", "complete"] });
	expect(calls.notifications).toEqual([]);
	expect(calls.trayClosed.sort()).toEqual(["a", "c"]);
	expect(tray.map((n) => n.title)).toEqual(["b"]);
	expect(calls.fetches).toEqual([]);
});

test("alert push closes its clear tags first, then shows", async () => {
	tray.push({ tag: "error", title: "old error" });
	await push({ ...alert, clear: ["error"] });
	expect(calls.trayClosed).toEqual(["old error"]);
	expect(calls.fetches).toEqual([
		{ url: "/api/inbox/seen", credentials: "same-origin" },
	]);
	expect(calls.notifications).toEqual([
		{
			title: "p: card",
			options: {
				body: "needs you",
				tag: "request",
				renotify: true,
				icon: "/icon-192.png",
				data: { url: "/projects/p/tasks/1", keys: ["task:1:needs"] },
			},
		},
	]);
	expect(tray.map((n) => n.title)).toEqual(["p: card"]);
});

test("alert push whose keys are all acknowledged shows nothing", async () => {
	seenResponse = ["task:1:needs", "other"];
	await push(alert);
	expect(calls.notifications).toEqual([]);
	expect(tray).toEqual([]);
});

test("acknowledged alert closes same-tag notifications that are all acknowledged, keeps unread ones", async () => {
	seenResponse = ["task:1:needs", "task:0:needs"];
	tray.push(
		{ tag: "request", title: "stale", data: { keys: ["task:0:needs"] } },
		{ tag: "request", title: "unread", data: { keys: ["task:9:needs"] } },
	);
	await push(alert);
	expect(calls.notifications).toEqual([]);
	expect(tray.map((n) => n.title)).toEqual(["unread"]);
});

test("acknowledged alert with replace closes its class tag (the retraction it stood in for)", async () => {
	seenResponse = ["task:1:needs"];
	tray.push({
		tag: "request",
		title: "resolved",
		data: { keys: ["task:7:needs"] },
	});
	await push({ ...alert, replace: true });
	expect(calls.notifications).toEqual([]);
	expect(tray).toEqual([]);
});

test("alert push with some keys unacknowledged stays shown", async () => {
	seenResponse = ["task:1:needs"];
	await push({ ...alert, keys: ["task:1:needs", "task:2:needs"] });
	expect(tray.map((n) => n.title)).toEqual(["p: card"]);
});

test("alert push still shows when the seen fetch fails", async () => {
	seenResponse = "fail";
	await push(alert);
	expect(calls.notifications.length).toBe(1);
	expect(calls.trayClosed).toEqual([]);
	expect(tray.map((n) => n.title)).toEqual(["p: card"]);
});

test("untyped push shows without consulting the server", async () => {
	await push({ title: "Test", body: "hi" });
	expect(calls.notifications[0].title).toBe("Test");
	expect(calls.fetches).toEqual([]);
});
