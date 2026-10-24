// Tests for the service worker's push/notificationclick policy. sw.js talks to the
// worker-global `self`, so the tests install a fake `self` and then import the worker
// once, and each test drives the captured event handlers. Plain JS because sw.js is
// untyped (no allowJs in tsconfig, so a .test.ts could not import it).
import { afterAll, beforeEach, expect, test } from "bun:test";

const controlled = [];
const uncontrolled = [];
const calls = { notifications: [], focused: [], opened: [], closed: 0 };
const listeners = {};

const previousSelf = globalThis.self;
afterAll(() => {
	globalThis.self = previousSelf;
});

globalThis.self = {
	addEventListener: (type, handler) => {
		listeners[type] = handler;
	},
	registration: {
		showNotification: async (title, options) => {
			calls.notifications.push({ title, options });
		},
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

await import("./sw.js");

beforeEach(() => {
	calls.notifications.length = 0;
	calls.focused.length = 0;
	calls.opened.length = 0;
	calls.closed = 0;
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
				icon: "/icon-192.png",
				data: { url: "/tasks/1" },
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
				icon: "/icon-192.png",
				data: { url: "/" },
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
