import { describe, expect, test } from "bun:test";
import {
	ALL_CLASSES_ON,
	type AlertCardInput,
	type AlertEvent,
	clearedAlerts,
	deliverable,
	diffEvents,
	isApplePush,
	type LiveAlert,
	normalizeSeen,
	PAYLOAD_KEYS_MAX,
	PRESENCE_WINDOW_MS,
	payloadsFor,
	presenceHolds,
	rekeyErrorAlerts,
	shortKey,
	tagsToClear,
	taskEntryKey,
} from "./notifications.ts";
import type { AskQuestion } from "./types.ts";

const card = (
	id: string,
	over: Partial<AlertCardInput> = {},
): AlertCardInput => ({
	id,
	project: "ottr",
	title: `title ${id}`,
	sessionTitle: null,
	state: "running",
	stage: "in_progress",
	prDraft: null,
	prComments: null,
	asked: null,
	answered: false,
	needsReason: null,
	summary: null,
	errorTurn: null,
	errorText: null,
	cancelled: false,
	...over,
});

const ask = (question: string): AskQuestion[] => [
	{ question, options: [], multi: false } as unknown as AskQuestion,
];

const zero = { request: [], error: [], complete: [] };

describe("taskEntryKey", () => {
	test("needs vs asked rounds", () => {
		expect(taskEntryKey({ id: "A", asked: null })).toBe("task:A:needs");
		const q = ask("which?");
		expect(taskEntryKey({ id: "A", asked: q })).toMatch(
			/^task:A:ask-[0-9a-z]+$/,
		);
	});
});

describe("diffEvents", () => {
	test("running → needs_you is one request with the card url and title", () => {
		const evs = diffEvents(
			[card("A")],
			[
				card("A", {
					state: "needs_you",
					needsReason: "review",
					sessionTitle: "S",
				}),
			],
		);
		expect(evs).toEqual([
			{
				key: "task:A:needs",
				class: "request",
				project: "ottr",
				taskId: "A",
				title: "ottr: S",
				body: "review",
				url: "/projects/ottr/tasks/A",
				tag: "request",
			},
		]);
	});
	test("a new ask on a needs_you card is a request; the same ask again is silent", () => {
		const a1 = card("A", { state: "needs_you", asked: ask("one") });
		const a2 = card("A", { state: "needs_you", asked: ask("two") });
		const evs = diffEvents([a1], [a2]);
		expect(evs.map((e) => [e.class, e.key, e.body])).toEqual([
			["request", taskEntryKey(a2), "two"],
		]);
		expect(diffEvents([a2], [a2])).toEqual([]);
	});
	test("error + needs_you in one frame is one error keyed by the entry key, no request", () => {
		const t = card("A", {
			state: "needs_you",
			errorTurn: "t1",
			errorText: "boom\nstack",
		});
		const evs = diffEvents([card("A")], [t]);
		expect(evs.map((e) => [e.class, e.key, e.body])).toEqual([
			["error", taskEntryKey(t), "boom"],
		]);
	});
	test("error without needs_you keys error:<id>:<turn>; same turn later is silent", () => {
		const t = card("A", { state: "idle", errorTurn: "t9", errorText: null });
		const evs = diffEvents([card("A")], [t]);
		expect(evs.map((e) => [e.class, e.key, e.body])).toEqual([
			["error", "error:A:t9", "A turn failed"],
		]);
		expect(diffEvents([t], [t])).toEqual([]);
	});
	test("needs_you a frame after the error, same failed turn, is no request; a new ask still is", () => {
		const failed = card("A", { state: "queued", errorTurn: "t1" });
		expect(diffEvents([card("A")], [failed]).map((e) => e.class)).toEqual([
			"error",
		]);
		const needs = card("A", { state: "needs_you", errorTurn: "t1" });
		expect(diffEvents([failed], [needs])).toEqual([]);
		const asked = card("A", {
			state: "needs_you",
			errorTurn: "t1",
			asked: ask("which?"),
		});
		expect(diffEvents([needs], [asked]).map((e) => e.class)).toEqual([
			"request",
		]);
	});
	test("error body is capped at 200 chars", () => {
		const t = card("A", { errorTurn: "t", errorText: "x".repeat(500) });
		expect(diffEvents([card("A")], [t])[0]?.body).toHaveLength(200);
	});
	test("entering done is complete", () => {
		const evs = diffEvents(
			[card("A", { stage: "merging" })],
			[card("A", { state: "idle", stage: "done" })],
		);
		expect(evs.map((e) => [e.class, e.key, e.body])).toEqual([
			["complete", "done:A", "title A was done"],
		]);
	});
	test("an answered question-only card is complete with its summary", () => {
		const evs = diffEvents(
			[card("A")],
			[card("A", { state: "idle", answered: true, summary: "42" })],
		);
		expect(evs.map((e) => [e.class, e.key, e.body])).toEqual([
			["complete", "done:A", "42"],
		]);
		const fallback = diffEvents([card("A")], [card("A", { answered: true })]);
		expect(fallback[0]?.body).toBe("Answered; open the card to read it");
	});
	test("retro cards never produce events", () => {
		const evs = diffEvents(
			[card("R", { kind: "retro" })],
			[
				card("R", {
					kind: "retro",
					state: "needs_you",
					stage: "done",
					errorTurn: "t",
				}),
			],
		);
		expect(evs).toEqual([]);
	});
	test("null prev (first frame) produces nothing", () => {
		expect(
			diffEvents(null, [card("A", { state: "needs_you", errorTurn: "t" })]),
		).toEqual([]);
	});
	test("a brand-new needs_you card is a request; other new cards are silent", () => {
		const evs = diffEvents(
			[],
			[
				card("N", { state: "needs_you" }),
				card("D", { state: "idle", stage: "done" }),
				card("Q", { state: "queued" }),
			],
		);
		expect(evs.map((e) => [e.class, e.taskId])).toEqual([["request", "N"]]);
	});
	test("asked questions join into the body", () => {
		const q = [...ask("a"), ...ask("b")];
		const evs = diffEvents(
			[card("A")],
			[card("A", { state: "needs_you", asked: q })],
		);
		expect(evs[0]?.body).toBe("a · b");
	});
});

const ev = (cls: AlertEvent["class"], id: string): AlertEvent => ({
	key: `${cls}:${id}`,
	class: cls,
	project: "my proj",
	taskId: id,
	title: `t ${id}`,
	body: `b ${id}`,
	url: `/projects/my%20proj/tasks/${id}`,
	tag: cls,
});

describe("payloadsFor", () => {
	test("two requests group into one payload", () => {
		expect(payloadsFor([ev("request", "A"), ev("request", "B")], zero)).toEqual(
			[
				{
					type: "alert",
					title: "Ottr",
					body: "2 tasks need your attention",
					tag: "request",
					url: "/",
					keys: ["request:A", "request:B"],
					partial: false,
					seq: 0,
					clear: [],
					upTo: {},
				},
			],
		);
	});
	test("one request keeps the card's own payload", () => {
		expect(payloadsFor([ev("request", "A")], zero)).toEqual([
			{
				type: "alert",
				title: "t A",
				body: "b A",
				tag: "request",
				url: "/projects/my%20proj/tasks/A",
				keys: ["request:A"],
				partial: false,
				seq: 0,
				clear: [],
				upTo: {},
			},
		]);
	});
	test("the payload stands for every live alert of its class: count covers them all", () => {
		const out = payloadsFor(
			[
				ev("error", "A"),
				ev("error", "B"),
				ev("complete", "C"),
				ev("complete", "D"),
			],
			{ request: [], error: ["error:U", "error:A"], complete: [] },
		);
		expect(out.map((p) => [p.tag, p.body, p.keys])).toEqual([
			["error", "3 tasks failed", ["error:A", "error:B", "error:U"]],
			["complete", "2 tasks finished", ["complete:C", "complete:D"]],
		]);
		// One new alert beside an unread one groups too, so the unread one stays represented.
		const [lone] = payloadsFor([ev("request", "B")], {
			request: ["request:A"],
			error: [],
			complete: [],
		});
		expect([lone?.body, lone?.keys]).toEqual([
			"2 tasks need your attention",
			["request:B", "request:A"],
		]);
	});
	test("the wire stays bounded: keys cap at PAYLOAD_KEYS_MAX and the rest is marked partial", () => {
		const many = Array.from({ length: 500 }, (_, i) => `done:card-${i}`);
		const [p] = payloadsFor([ev("complete", "N")], {
			request: [],
			error: [],
			complete: many,
		});
		expect(p?.body).toBe("501 tasks finished");
		expect(p?.keys.length).toBe(PAYLOAD_KEYS_MAX);
		expect(p?.keys[0]).toBe("complete:N");
		expect(p?.partial).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(
			3993,
		);
	});
});

describe("deliverable", () => {
	test("class off or project muted blocks", () => {
		const off = { ...ALL_CLASSES_ON, complete: false };
		expect(
			deliverable(off, new Set(), { class: "complete", project: "p" }),
		).toBe(false);
		expect(
			deliverable(off, new Set(), { class: "request", project: "p" }),
		).toBe(true);
		expect(
			deliverable(ALL_CLASSES_ON, new Set(["p"]), {
				class: "request",
				project: "p",
			}),
		).toBe(false);
	});
});

describe("presenceHolds", () => {
	test("holds strictly inside the window", () => {
		expect(PRESENCE_WINDOW_MS).toBe(60_000);
		expect(presenceHolds(new Map([["t", 0]]), 59_999)).toBe(true);
		expect(presenceHolds(new Map([["t", 0]]), 60_000)).toBe(false);
		expect(presenceHolds(new Map(), 0)).toBe(false);
	});
});

const live = (
	key: string,
	cls: LiveAlert["class"],
	taskId: string,
	to: string[] = ["dev"],
): LiveAlert => ({
	key,
	sent: key,
	class: cls,
	taskId,
	project: "ottr",
	to,
});

describe("clearedAlerts", () => {
	test("answered ask clears its task key", () => {
		const a = live("task:A:needs", "request", "A");
		expect(
			clearedAlerts([a], [card("A", { state: "running" })], new Set()),
		).toEqual([a]);
		expect(
			clearedAlerts([a], [card("A", { state: "needs_you" })], new Set()),
		).toEqual([]);
	});
	test("a new ask replaces the old entry key", () => {
		const a = live("task:A:needs", "request", "A");
		expect(
			clearedAlerts(
				[a],
				[card("A", { state: "needs_you", asked: ask("q") })],
				new Set(),
			),
		).toEqual([a]);
	});
	test("card gone clears every kind", () => {
		const all = [
			live("task:A:needs", "request", "A"),
			live("done:A", "complete", "A"),
			live("error:A:t", "error", "A"),
		];
		expect(clearedAlerts(all, [], new Set())).toEqual(all);
	});
	test("acked key clears", () => {
		const a = live("done:A", "complete", "A");
		const t = card("A", { stage: "done" });
		expect(clearedAlerts([a], [t], new Set())).toEqual([]);
		expect(clearedAlerts([a], [t], new Set(["done:A"]))).toEqual([a]);
	});
	test("done card leaving done clears; errorTurn change clears the error", () => {
		const d = live("done:A", "complete", "A");
		const e = live("error:A:t1", "error", "A");
		expect(
			clearedAlerts(
				[d, e],
				[card("A", { stage: "in_progress", errorTurn: "t1" })],
				new Set(),
			),
		).toEqual([d]);
		expect(
			clearedAlerts([e], [card("A", { errorTurn: "t2" })], new Set()),
		).toEqual([e]);
	});
});

describe("tagsToClear", () => {
	test("only classes left empty", () => {
		const r1 = live("task:A:needs", "request", "A");
		const r2 = live("task:B:needs", "request", "B");
		const c = live("done:C", "complete", "C");
		expect(tagsToClear([r1, c], [r2], "dev")).toEqual(["complete"]);
		expect(tagsToClear([r1], [], "dev")).toEqual(["request"]);
		expect(tagsToClear([], [], "dev")).toEqual([]);
	});
	test("per device: an alert the device never got neither clears nor keeps its tag", () => {
		const delivered = live("task:A:needs", "request", "A", ["phone"]);
		const muted = live("task:B:needs", "request", "B", []);
		expect(tagsToClear([delivered], [muted], "phone")).toEqual(["request"]);
		expect(tagsToClear([muted], [], "phone")).toEqual([]);
	});
});

describe("cancellation and error rekey", () => {
	test("a cancelled card alerts nothing and retracts its Error and Complete alerts", () => {
		const t = card("A", { state: "needs_you", cancelled: true });
		expect(diffEvents([card("A")], [t])).toEqual([]);
		const err = live("error:A:t1", "error", "A");
		const done = live("done:A", "complete", "A");
		const cancelledDone = card("A", {
			stage: "done",
			errorTurn: "t1",
			cancelled: true,
		});
		expect(clearedAlerts([err, done], [cancelledDone], new Set())).toEqual([
			err,
			done,
		]);
	});
	test("an Error that led to needs_you takes the entry key, so acking the entry retracts it", () => {
		const err = live("error:A:t1", "error", "A");
		const needs = card("A", { state: "needs_you", errorTurn: "t1" });
		const rekeyed = rekeyErrorAlerts([err], [needs])[0]!;
		expect(rekeyed.key).toBe(taskEntryKey(needs));
		expect(
			clearedAlerts([rekeyed], [needs], new Set([taskEntryKey(needs)])),
		).toEqual([rekeyed]);
		// Answering the entry (card leaves needs_you on the same turn) retracts it too.
		expect(
			clearedAlerts([rekeyed], [{ ...needs, state: "queued" }], new Set()),
		).toEqual([rekeyed]);
	});
	test("task keys hash the ask: short and distinct per round", () => {
		const long = ask("q".repeat(5000));
		const key = taskEntryKey({ id: "A", asked: long });
		expect(key.length).toBeLessThan(40);
		expect(key).not.toBe(taskEntryKey({ id: "A", asked: ask("other") }));
		expect(key).toBe(taskEntryKey({ id: "A", asked: ask("q".repeat(5000)) }));
	});
});

describe("PR review notifications", () => {
	const pr = (over: Partial<AlertCardInput> = {}): AlertCardInput =>
		card("P", {
			kind: "pr_review",
			title: "PR review: #12 Fix the thing",
			...over,
		});

	test("taskEntryKey carries the draft stamp for pr_review cards only", () => {
		expect(taskEntryKey(pr({ prDraft: 7 }))).toBe("task:P:needs-pr7");
		expect(taskEntryKey(pr({ prDraft: null }))).toBe("task:P:needs");
		expect(taskEntryKey({ id: "A", asked: null })).toBe("task:A:needs");
	});

	test("a first draft entering needs_you says ready to post", () => {
		const t = pr({ state: "needs_you", prDraft: 3 });
		expect(
			diffEvents([card("P")], [t]).map((e) => [e.class, e.key, e.body]),
		).toEqual([["request", "task:P:needs-pr3", "Review draft ready to post"]]);
	});

	test("a rewritten draft on a waiting card is a new occurrence", () => {
		const old = pr({ state: "needs_you", prDraft: 3 });
		const t = pr({ state: "needs_you", prDraft: 4 });
		expect(diffEvents([old], [t]).map((e) => [e.class, e.key, e.body])).toEqual([
			[
				"request",
				"task:P:needs-pr4",
				"Review draft updated — re-read it before posting",
			],
		]);
		expect(diffEvents([t], [t])).toEqual([]);
	});

	test("a new head after a post says ready for the new head", () => {
		const old = pr({ state: "idle", stage: "done", prDraft: 3 });
		const t = pr({ state: "needs_you", prDraft: 4 });
		expect(diffEvents([old], [t]).map((e) => e.body)).toEqual([
			"Review draft ready for the new head",
		]);
	});

	test("a same-head re-draft on a posted card is silent", () => {
		const old = pr({ state: "idle", stage: "done", prDraft: 3 });
		const t = pr({ state: "idle", stage: "done", prDraft: 4 });
		expect(diffEvents([old], [t])).toEqual([]);
	});

	test("a comment wave is one pr: request; reading it is silent", () => {
		const old = pr({ state: "idle", stage: "done", prDraft: 3 });
		const wave = pr({
			state: "idle",
			stage: "done",
			prDraft: 3,
			prComments: 500,
		});
		expect(
			diffEvents([old], [wave]).map((e) => [e.class, e.key, e.body]),
		).toEqual([["request", "pr:P:500", "New comments after your posted review"]]);
		expect(diffEvents([wave], [wave])).toEqual([]);
		const read = pr({ state: "idle", stage: "done", prDraft: 3 });
		expect(diffEvents([wave], [read])).toEqual([]);
	});

	test("a draft rewrite outranks a same-frame comment wave", () => {
		const old = pr({ state: "needs_you", prDraft: 3 });
		const t = pr({ state: "needs_you", prDraft: 4, prComments: 500 });
		expect(diffEvents([old], [t]).map((e) => e.key)).toEqual([
			"task:P:needs-pr4",
		]);
	});

	test("pr: alerts retract on a newer or read wave", () => {
		const a = live("pr:P:500", "request", "P");
		expect(clearedAlerts([a], [pr({ prComments: 600 })], new Set())).toEqual([
			a,
		]);
		expect(clearedAlerts([a], [pr({ prComments: 500 })], new Set())).toEqual([]);
		expect(clearedAlerts([a], [pr()], new Set())).toEqual([a]);
		expect(clearedAlerts([a], [pr({ prComments: 500 })], new Set(["pr:P:500"]))).toEqual([a]);
	});
});

describe("isApplePush", () => {
	test("matches Apple hosts only", () => {
		expect(isApplePush("https://web.push.apple.com/abc")).toBe(true);
		expect(isApplePush("https://fcm.googleapis.com/fcm/send/x")).toBe(false);
		expect(isApplePush("not a url")).toBe(false);
	});
});

describe("normalizeSeen", () => {
	test("strings only, deduped, length-capped, last 5000", () => {
		expect(normalizeSeen("x")).toEqual([]);
		expect(normalizeSeen(["a", 1, "a", "b", "x".repeat(2001), null])).toEqual([
			"a",
			"b",
		]);
		const many = Array.from({ length: 5002 }, (_, i) => `k${i}`);
		const out = normalizeSeen(many);
		expect(out).toHaveLength(5000);
		expect(out[0]).toBe("k2");
		expect(out.at(-1)).toBe("k5001");
	});
});

describe("shortKey", () => {
	test("short bodies stay readable; long ones hash under the seen limit, stable per body", () => {
		expect(shortKey("crit", "boom")).toBe("crit:boom");
		const long = shortKey("crit", "e".repeat(5000));
		expect(long.length).toBeLessThan(40);
		expect(long).toBe(shortKey("crit", "e".repeat(5000)));
		expect(long).not.toBe(shortKey("crit", "f".repeat(5000)));
	});
});
