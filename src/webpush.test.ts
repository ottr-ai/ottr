import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalStore } from "./globalStore.ts";
import {
	diffAlerts,
	loadSubs,
	PUSH_SUBJECT,
	type PushSub,
	payloadFor,
	payloadsFor,
	pruneSubs,
	saveSubs,
	sendAll,
} from "./webpush.ts";

const card = (id: string, state: string, stage = "in_progress") => ({
	id,
	state,
	stage,
});

describe("diffAlerts", () => {
	test("fires on a transition into needs_you", () => {
		const prev = [card("a", "running"), card("b", "needs_you")];
		const next = [card("a", "needs_you"), card("b", "needs_you")];
		expect(diffAlerts(prev, next)).toEqual([card("a", "needs_you")]);
	});
	test("first load (null prev) is silent", () => {
		expect(diffAlerts(null, [card("a", "needs_you")])).toEqual([]);
	});
	test("answered/queued transitions are silent", () => {
		const prev = [card("a", "needs_you"), card("b", "queued")];
		const next = [card("a", "queued"), card("b", "running")];
		expect(diffAlerts(prev, next)).toEqual([]);
	});
	test("fires on a merging-to-done stage transition with idle state", () => {
		const prev = [card("a", "idle", "merging")];
		const next = [card("a", "idle", "done")];
		expect(diffAlerts(prev, next)).toEqual([card("a", "idle", "done")]);
	});
	test("staying in done across frames is silent", () => {
		const prev = [card("a", "idle", "done")];
		const next = [card("a", "idle", "done")];
		expect(diffAlerts(prev, next)).toEqual([]);
	});
	test("re-entering done fires again", () => {
		const leaving = [card("a", "idle", "in_progress")];
		expect(diffAlerts([card("a", "idle", "done")], leaving)).toEqual([]);
		expect(diffAlerts(leaving, [card("a", "idle", "done")])).toEqual([
			card("a", "idle", "done"),
		]);
	});
	test("null prev with a done card is silent", () => {
		expect(diffAlerts(null, [card("a", "idle", "done")])).toEqual([]);
	});
	test("entering done while already needs_you fires once; unknown ids stay silent", () => {
		const prev = [card("a", "needs_you", "merging"), card("zzz", "idle")];
		const next = [card("a", "needs_you", "done"), card("q", "idle", "done")];
		expect(diffAlerts(prev, next)).toEqual([card("a", "needs_you", "done")]);
	});
	test("payloadFor keeps the needs reason on a needs_you done card", () => {
		const p = payloadFor({
			title: "do a thing",
			needsReason: "Release review waiting",
			sessionTitle: null,
			project: "ottr",
		});
		expect(p.body).toBe("Release review waiting");
	});
	test("a retro card never alerts, even entering done or needs_you", () => {
		const prev = [card("r", "running"), card("s", "idle", "merging")];
		const next = [
			{ ...card("r", "needs_you"), kind: "retro" as const },
			{ ...card("s", "idle", "done"), kind: "retro" as const },
		];
		expect(diffAlerts(prev, next)).toEqual([]);
	});
	test("a brand-new needs_you card alerts; retro proposals and other new states are silent", () => {
		const proposal = card("n", "needs_you");
		expect(diffAlerts([], [proposal])).toEqual([proposal]);
		expect(
			diffAlerts([], [{ ...card("n2", "needs_you"), kind: "retro" as const }]),
		).toEqual([]);
		expect(diffAlerts([], [card("q", "queued")])).toEqual([]);
		expect(diffAlerts([], [card("d", "idle", "done")])).toEqual([]);
	});
	test("items without a prompt keep the state/stage rules", () => {
		const prev = [card("a", "running")];
		expect(diffAlerts(prev, [card("a", "needs_you")])).toEqual([
			card("a", "needs_you"),
		]);
		expect(diffAlerts(prev, [card("a", "idle", "done")])).toEqual([
			card("a", "idle", "done"),
		]);
	});
});

describe("payloadsFor", () => {
	const doneCard = () => ({
		title: "ship it",
		state: "idle",
		needsReason: null,
		sessionTitle: null,
		project: "ottr",
	});
	const needsCard = () => ({
		title: "ask",
		state: "needs_you",
		needsReason: "pick one",
		sessionTitle: "Fix the bug",
		project: "ottr",
	});

	test("a lone done card says it was done", () => {
		expect(payloadsFor([doneCard()], 0, 1)).toEqual([
			{
				title: "ship it",
				body: "ship it was done",
				tag: "done",
				url: "/#ottr",
			},
		]);
	});
	test("done cards group into a count", () => {
		expect(payloadsFor([doneCard(), doneCard()], 0, 5)).toEqual([
			{ title: "Ottr", body: "5 tasks finished", tag: "done", url: "/" },
		]);
	});
	test("a lone needs card keeps the detailed reason", () => {
		expect(payloadsFor([needsCard()], 1, 0)).toEqual([
			{
				title: "Fix the bug",
				body: "pick one",
				tag: "needs_you",
				url: "/#ottr",
			},
		]);
	});
	test("needs cards group into a count of everything pending", () => {
		expect(payloadsFor([needsCard()], 10, 0)).toEqual([
			{
				title: "Ottr",
				body: "10 tasks need your attention",
				tag: "needs_you",
				url: "/",
			},
		]);
	});
	test("both channels in one frame push separately", () => {
		expect(payloadsFor([needsCard(), doneCard()], 2, 1)).toEqual([
			{
				title: "Ottr",
				body: "2 tasks need your attention",
				tag: "needs_you",
				url: "/",
			},
			{
				title: "ship it",
				body: "ship it was done",
				tag: "done",
				url: "/#ottr",
			},
		]);
	});
});

describe("saveSubs/loadSubs", () => {
	test("dedupes by endpoint and round-trips", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		const store = GlobalStore.open(root);
		const sub = (endpoint: string): PushSub => ({
			endpoint,
			keys: { p256dh: "p", auth: "a" },
			addedAt: 1,
		});
		saveSubs(store, [
			sub("https://x/1"),
			sub("https://x/2"),
			sub("https://x/1"),
		]);
		expect(loadSubs(store)).toEqual([sub("https://x/1"), sub("https://x/2")]);
		store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("missing subs load empty", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		const store = GlobalStore.open(root);
		expect(loadSubs(store)).toEqual([]);
		store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("non-array kv row loads empty", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
		const store = GlobalStore.open(root);
		store.set("push_subs", { not: "an array" } as unknown as PushSub[]);
		expect(loadSubs(store)).toEqual([]);
		store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
	test("malformed entries are skipped, good sub kept", () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
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
			},
		]);
		store.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
});

describe("sendAll", () => {
	const sub = (n: number): PushSub => ({
		endpoint: `https://x/${n}`,
		keys: { p256dh: "p", auth: "a" },
		addedAt: 1,
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
	});

	test("prunes against a fresh read, so subs added during the sends survive", async () => {
		const root = mkdtempSync(join(tmpdir(), "ottr-push-"));
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
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	});
});

describe("payloadFor", () => {
	test("shape", () => {
		expect(
			payloadFor({
				title: "do a thing",
				needsReason: "Need a decision",
				sessionTitle: "Fix the bug",
				project: "ottr",
			}),
		).toEqual({
			title: "Fix the bug",
			body: "Need a decision",
			tag: "needs_you",
			url: "/#ottr",
		});
	});
	test("fallback body without a reason", () => {
		const p = payloadFor({
			title: "do a thing",
			needsReason: null,
			sessionTitle: null,
			project: "ottr",
		});
		expect(p.body).toContain("needs you");
		expect(p.title).toBe("do a thing");
	});
});
