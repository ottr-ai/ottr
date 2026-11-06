import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalStore } from "./globalStore.ts";
import { ALL_CLASSES_ON } from "./notifications.ts";
import {
	loadSubs,
	PUSH_SUBJECT,
	type PushSub,
	pruneSubs,
	saveSubs,
	sendAll,
} from "./webpush.ts";

const pushRoots: string[] = [];
afterEach(() => {
	for (const root of pushRoots)
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	pushRoots.length = 0;
});

describe("saveSubs/loadSubs", () => {
	test("dedupes by endpoint and round-trips", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		const sub = (endpoint: string): PushSub => ({
			endpoint,
			keys: { p256dh: "p", auth: "a" },
			addedAt: 1,
			classes: { ...ALL_CLASSES_ON },
		});
		saveSubs(store, [
			sub("https://x/1"),
			sub("https://x/2"),
			sub("https://x/1"),
		]);
		expect(loadSubs(store)).toEqual([sub("https://x/1"), sub("https://x/2")]);
		store.close();
	});
	test("missing subs load empty", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		expect(loadSubs(store)).toEqual([]);
		store.close();
	});
	test("non-array kv row loads empty", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		store.set("push_subs", { not: "an array" } as unknown as PushSub[]);
		expect(loadSubs(store)).toEqual([]);
		store.close();
	});
	test("malformed entries are skipped, good sub kept", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		store.set("push_subs", [
			{ endpoint: 42, keys: { p256dh: "p", auth: "a" } },
			{
				endpoint: "https://x/ok",
				keys: { p256dh: "p", auth: "a" },
				addedAt: 7,
			},
			"garbage",
			{ endpoint: "https://x/bad-keys", keys: null, addedAt: 1 },
		] as unknown as PushSub[]);
		expect(loadSubs(store)).toEqual([
			{
				endpoint: "https://x/ok",
				keys: { p256dh: "p", auth: "a" },
				addedAt: 7,
				classes: ALL_CLASSES_ON,
			},
		]);
		store.close();
	});
	test("a legacy sub without classes, or with invalid classes, reads all on", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		store.set("push_subs", [
			{ endpoint: "https://x/a", keys: { p256dh: "p", auth: "a" }, addedAt: 1 },
			{
				endpoint: "https://x/b",
				keys: { p256dh: "p", auth: "a" },
				addedAt: 1,
				classes: { request: true, error: "no", complete: false },
			},
		] as unknown as PushSub[]);
		expect(loadSubs(store).map((s) => s.classes)).toEqual([
			ALL_CLASSES_ON,
			ALL_CLASSES_ON,
		]);
		store.close();
	});
	test("classes round-trip", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		const classes = { request: false, error: true, complete: false };
		saveSubs(store, [
			{
				endpoint: "https://x/1",
				keys: { p256dh: "p", auth: "a" },
				addedAt: 1,
				classes,
			},
		]);
		expect(loadSubs(store)[0]?.classes).toEqual(classes);
		store.close();
	});
});

describe("sendAll", () => {
	const sub = (n: number): PushSub => ({
		endpoint: `https://x/${n}`,
		keys: { p256dh: "p", auth: "a" },
		addedAt: 1,
		classes: { ...ALL_CLASSES_ON },
	});
	const gone = (code: number) =>
		Object.assign(Error("gone"), { statusCode: code });

	test("PUSH_SUBJECT is a real https URL (Apple rejects @localhost)", () => {
		const subject = new URL(PUSH_SUBJECT);
		expect(subject.protocol).toBe("https:");
		expect(subject.hostname).not.toBe("localhost");
	});

	test("collects 404/410 endpoints as gone, counts the rest as sent", async () => {
		const sent: string[] = [];
		const report = await sendAll(
			[sub(1), sub(2), sub(3), sub(4)],
			"payload",
			async (s) => {
				sent.push(s.endpoint);
				if (s.endpoint.endsWith("/2")) throw gone(404);
				if (s.endpoint.endsWith("/3")) throw gone(410);
			},
		);
		expect(sent).toEqual([
			"https://x/1",
			"https://x/2",
			"https://x/3",
			"https://x/4",
		]);
		expect([...report.gone]).toEqual(["https://x/2", "https://x/3"]);
		expect(report.sent).toBe(2);
	});
	test("a 403 is a failed send, not a success; the sub stays", async () => {
		const report = await sendAll([sub(1)], "payload", async () => {
			throw gone(403);
		});
		expect(report.sent).toBe(0);
		expect(report.failed).toBe(1);
		expect(report.status).toBe(403);
		// 403 is an auth/config failure, not an expired sub: never pruned.
		expect(report.gone.size).toBe(0);
	});
	test("network errors count as failed, not sent", async () => {
		const report = await sendAll([sub(1)], "payload", async () => {
			throw Error("boom");
		});
		expect(report.failed).toBe(1);
		expect(report.sent).toBe(0);
		expect(report.gone.size).toBe(0);
	});
	// Real 20ms deadlines on purpose: the behavior under test is AbortSignal.timeout,
	// which fake timers cannot drive.
	test("a hung endpoint hits the deadline: failed, kept, no status", async () => {
		const report = await sendAll(
			[sub(1)],
			"payload",
			() => new Promise(() => {}), // never settles
			20,
		);
		expect(report.sent).toBe(0);
		expect(report.failed).toBe(1);
		expect(report.status).toBeUndefined();
		expect(report.gone.size).toBe(0);
	});
	test("a send that rejects after the deadline won is not unhandled", async () => {
		const { promise, reject } = Promise.withResolvers<never>();
		const report = await sendAll([sub(1)], "payload", () => promise, 20);
		expect(report.failed).toBe(1);
		// The send loses the race, then rejects late: Promise.race must hold it handled.
		reject(Error("late boom"));
		await Promise.resolve();
		await Promise.resolve();
	});
});

describe("pruneSubs", () => {
	const sub = (n: number): PushSub => ({
		endpoint: `https://x/${n}`,
		keys: { p256dh: "p", auth: "a" },
		addedAt: 1,
		classes: { ...ALL_CLASSES_ON },
	});

	test("prunes against a fresh read, so subs added during the sends survive", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		pushRoots.push(root);
		const store = GlobalStore.open(root);
		saveSubs(store, [sub(1), sub(2)]);
		// Hold sub 1's send while a concurrent subscribe lands, then answer 410.
		let running!: () => void;
		const started = new Promise<void>((r) => (running = r));
		let resume!: () => void;
		const gate = new Promise<void>((r) => (resume = r));
		const report = sendAll([sub(1), sub(2)], "payload", async (s) => {
			if (s.endpoint.endsWith("/1")) {
				running();
				await gate;
				throw Object.assign(Error("gone"), { statusCode: 410 });
			}
		});
		await started;
		// A phone subscribes while the sends are still in flight.
		saveSubs(store, [...loadSubs(store), sub(3)]);
		resume();
		const r = await report;
		pruneSubs(store, r.gone);
		// Saving the pre-send snapshot here would drop the new sub 3.
		expect(loadSubs(store).map((s) => s.endpoint)).toEqual([
			"https://x/2",
			"https://x/3",
		]);
		store.close();
	});
});
