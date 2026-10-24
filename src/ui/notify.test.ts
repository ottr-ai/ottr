import { describe, expect, test } from "bun:test";
import type { TaskCard } from "../types.ts";
import { payloadsFor } from "../webpush.ts";
import icon from "./icon-192.png";
import type { InboxEntry, InboxLevel } from "./notify.ts";
import {
	ALATE_PENDING_AFTER_MS,
	ASK_DRAFTS_KEY,
	alatePendingEntry,
	alertBody,
	alertNotices,
	alertTitle,
	COMPOSE_DRAFTS_KEY,
	clearAskDraft,
	clearComposeDraft,
	freshAlerts,
	INBOX_SEEN_KEY,
	inboxView,
	loadAskDrafts,
	loadComposeDraft,
	loadInboxSeen,
	NOTIFY_KEY,
	pruneAskDrafts,
	pruneSeen,
	saveAskDraft,
	saveComposeDraft,
	saveInboxSeen,
	showAlerts,
	taskEntryKey,
} from "./notify.ts";

function card(over: Partial<TaskCard>): TaskCard {
	return {
		id: "t1",
		kind: "work",
		project: "proj",
		title: "short title",
		state: "running",
		stage: "in_progress",
		needsReason: null,
		asked: null,
		sessionTitle: null,
		answered: false,
		...over,
	} as TaskCard;
}

test("freshAlerts", () => {
	const running = card({});
	const needs = card({ state: "needs_you", needsReason: "turn ended" });
	const asked = card({
		state: "needs_you",
		asked: [
			{ question: "Which way?", options: [], multi: false, recommended: null },
		],
	});
	// First frame after load: never alerts for the backlog.
	expect(freshAlerts(null, [needs, asked])).toEqual([]);
	// Entering needs_you alerts; running alongside stays quiet.
	expect(freshAlerts([running], [needs, running])).toEqual([needs]);
	// A fresh ask on a task that stays needs_you alerts again.
	expect(freshAlerts([needs], [asked])).toEqual([asked]);
	// Unchanged needs_you frames stay quiet.
	expect(freshAlerts([asked], [asked])).toEqual([]);
	// Resolution clears; the same task alerting again later is a new alert.
	expect(freshAlerts([asked], [running])).toEqual([]);
	expect(freshAlerts([running], [needs, running])).toEqual([needs]);
});

test("freshAlerts: an answered question task alerts once", () => {
	const running = card({});
	const answered = card({
		state: "idle",
		stage: "done",
		answered: true,
		summary: "Yes, it works",
	});
	// Entering done with an answer alerts; first frame never does.
	expect(freshAlerts(null, [answered])).toEqual([]);
	expect(freshAlerts([running], [answered])).toEqual([answered]);
	// Staying answered stays quiet.
	expect(freshAlerts([answered], [answered])).toEqual([]);
	// A follow-up that turns the answered card into a fresh ask alerts again.
	const asked = card({ state: "needs_you", asked: [], answered: false });
	expect(freshAlerts([answered], [asked])).toEqual([asked]);
});

test("freshAlerts: entering done alerts", () => {
	const running = card({});
	const done = card({ stage: "done", state: "idle" });
	// Entering done from a non-done stage alerts; first frame never does.
	expect(freshAlerts([running], [done])).toEqual([done]);
	// Staying done is silent.
	expect(freshAlerts([done], [done])).toEqual([]);
	// Re-entering done after rework alerts again.
	const rework = card({ stage: "in_progress", state: "idle" });
	expect(freshAlerts([done], [rework])).toEqual([]);
	expect(freshAlerts([rework], [done])).toEqual([done]);
	// Backlog rule: a done card in the first frame is silent.
	expect(freshAlerts(null, [done])).toEqual([]);
});

test("freshAlerts: retro cards never alert; brand-new needs_you alerts", () => {
	const retroDone = card({ state: "idle", stage: "done", kind: "retro" });
	const retroNeeds = card({ state: "needs_you", kind: "retro" });
	const prev = [card({}), card({ state: "idle", stage: "merging" })];
	// Retro done and needs_you transitions are housekeeping, never alerts.
	expect(
		freshAlerts(prev, [
			retroDone,
			retroNeeds,
			card({ state: "running" }),
			card({ state: "idle", stage: "merging" }),
		]),
	).toEqual([]);
	// A brand-new held card (a retro proposal) alerts; other new states are silent.
	const proposal = card({ id: "n1", state: "needs_you", prompt: "Fix bugs" });
	expect(freshAlerts([], [proposal])).toEqual([proposal]);
	expect(
		freshAlerts([], [card({ id: "q1", state: "queued", prompt: "Ship it" })]),
	).toEqual([]);
	expect(
		freshAlerts([], [card({ id: "d1", stage: "done", state: "idle" })]),
	).toEqual([]);
});

test("freshAlerts: a done card entering needs_you alerts with the reason body", () => {
	const done = card({ stage: "done", state: "idle" });
	const review = card({
		stage: "done",
		state: "needs_you",
		needsReason: "release review waiting",
	});
	expect(freshAlerts([done], [review])).toEqual([review]);
	// The done card in needs_you keeps the needsReason body, not the done text.
	expect(alertBody(review)).toBe("release review waiting");
});

test("alertNotices groups same-channel alerts, keeps lone detail", () => {
	const needs1 = card({ id: "a", state: "needs_you", needsReason: "one" });
	const needs2 = card({ id: "b", state: "needs_you", asked: [] });
	const done1 = card({ id: "c", stage: "done" });
	const done2 = card({ id: "d", stage: "done", sessionTitle: "Ship" });
	const answered = card({ id: "e", answered: true, summary: "yes" });
	// Lone alerts keep their detail; done says "<task title> was done".
	expect(alertNotices([needs1])).toEqual([
		{ title: "proj: short title", body: "one", tag: "needs_you" },
	]);
	expect(alertNotices([done1])).toEqual([
		{
			title: "proj: short title",
			body: "short title was done",
			tag: "done",
		},
	]);
	// Multiple same-channel alerts collapse into one counted notice.
	expect(alertNotices([needs1, needs2])).toEqual([
		{ title: "Ottr", body: "2 tasks need your attention", tag: "needs_you" },
	]);
	expect(alertNotices([done1, done2])).toEqual([
		{ title: "Ottr", body: "2 tasks finished", tag: "done" },
	]);
	// Different channels push separately; answered reports stay per-card.
	expect(alertNotices([answered, needs1, done1])).toEqual([
		{ title: "proj: short title", body: "yes", tag: "ottr:e" },
		{ title: "proj: short title", body: "one", tag: "needs_you" },
		{
			title: "proj: short title",
			body: "short title was done",
			tag: "done",
		},
	]);
});

test("tab notices share the web push channel tags, so the device never doubles an alert", () => {
	const needs = card({ id: "a", state: "needs_you", needsReason: "one" });
	const done = card({ id: "c", stage: "done" });
	const toAlert = (t: TaskCard) => ({
		title: t.title,
		state: t.state,
		needsReason: t.needsReason,
		sessionTitle: t.sessionTitle,
		project: t.project,
	});
	expect(alertNotices([needs])[0]!.tag).toBe(
		payloadsFor([toAlert(needs)], 1, 0)[0]!.tag,
	);
	expect(alertNotices([done])[0]!.tag).toBe(
		payloadsFor([toAlert(done)], 0, 1)[0]!.tag,
	);
});

test("alertBody for an answered card prefers the summary", () => {
	expect(alertBody(card({ answered: true, summary: "Yes, it works" }))).toBe(
		"Yes, it works",
	);
	expect(alertBody(card({ answered: true, summary: null }))).toBe(
		"Answered; open the card to read it",
	);
});

test("alertTitle and alertBody", () => {
	const t = card({
		sessionTitle: "Add search",
		needsReason: "Report failed the git checks",
		asked: [
			{ question: "Which way?", options: [], multi: false, recommended: null },
			{ question: "Why?", options: [], multi: false, recommended: null },
		],
	});
	expect(alertTitle(t)).toBe("proj: Add search");
	expect(alertBody(t)).toBe("Which way? · Why?");
	// Falls back through session title, then the needs reason.
	expect(alertTitle(card({}))).toBe("proj: short title");
	expect(alertBody(card({ state: "needs_you" }))).toBe("Action required");
	expect(
		alertBody(card({ state: "needs_you", needsReason: "hit a blocker" })),
	).toBe("hit a blocker");
});

// bun:test has no DOM; the pure tests only need a localStorage stand-in.
const store = new Map<string, string>();
globalThis.localStorage ??= {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string): void => void store.set(k, v),
	removeItem: (k: string): void => void store.delete(k),
} as Storage;

test("ask drafts round-trip per task and drop on mismatching fingerprint", () => {
	localStorage.removeItem(ASK_DRAFTS_KEY);
	saveAskDraft("t1", { fp: "a\nb", answers: { 0: "one" } });
	saveAskDraft("t2", { fp: "x", answers: { 0: "two", 1: "three" } });
	expect(loadAskDrafts()["t1"]).toEqual({ fp: "a\nb", answers: { 0: "one" } });
	// Overwriting one task leaves the other's draft alone.
	saveAskDraft("t1", { fp: "a\nb", answers: { 0: "one", 1: "uno" } });
	expect(loadAskDrafts()["t2"]?.answers[0]).toBe("two");
	clearAskDraft("t1");
	expect(loadAskDrafts()["t1"]).toBeUndefined();
	expect(loadAskDrafts()["t2"]).toBeDefined();
	// A changed ask round (fingerprint miss) is the caller's signal to start empty.
	expect(loadAskDrafts()["t1"]?.fp === "a\nb").toBe(false);
});

test("compose drafts round-trip per dialog key and drop on empty text", () => {
	localStorage.removeItem(COMPOSE_DRAFTS_KEY);
	expect(loadComposeDraft("new:proj")).toBeNull();
	saveComposeDraft("new:proj", { text: "Fix the bug", model: "m1" });
	expect(loadComposeDraft("new:proj")).toEqual({
		text: "Fix the bug",
		model: "m1",
	});
	// A model-only change rewrites the same entry; other keys stay untouched.
	saveComposeDraft("new:proj", { text: "Fix the bug", model: "m2" });
	expect(loadComposeDraft("new:proj")?.model).toBe("m2");
	saveComposeDraft("backlog:proj", { text: "Idea", model: "" });
	expect(loadComposeDraft("backlog:proj")).toEqual({ text: "Idea", model: "" });
	// Whitespace-only text removes the entry instead of caching it.
	saveComposeDraft("new:proj", { text: "   ", model: "m2" });
	expect(loadComposeDraft("new:proj")).toBeNull();
	// A corrupt store or junk shape reads as absent.
	localStorage.setItem(COMPOSE_DRAFTS_KEY, "{not json");
	expect(loadComposeDraft("backlog:proj")).toBeNull();
	localStorage.setItem(
		COMPOSE_DRAFTS_KEY,
		JSON.stringify({ "x:1": { text: 5 } }),
	);
	expect(loadComposeDraft("x:1")).toBeNull();
});

test("clearComposeDraft drops one key and ignores absent keys without writing", () => {
	localStorage.removeItem(COMPOSE_DRAFTS_KEY);
	clearComposeDraft("followup:t1");
	expect(localStorage.getItem(COMPOSE_DRAFTS_KEY)).toBeNull();
	saveComposeDraft("followup:t1", { text: "one", model: "" });
	saveComposeDraft("followup:t2", { text: "two", model: "" });
	clearComposeDraft("followup:t1");
	expect(loadComposeDraft("followup:t1")).toBeNull();
	expect(loadComposeDraft("followup:t2")).toEqual({ text: "two", model: "" });
});

test("pruneAskDrafts keeps only tasks with an outstanding ask", () => {
	localStorage.removeItem(ASK_DRAFTS_KEY);
	saveAskDraft("live", { fp: "q", answers: { 0: "a" } });
	saveAskDraft("gone", { fp: "q", answers: { 0: "b" } });
	pruneAskDrafts(new Set(["live"]));
	expect(Object.keys(loadAskDrafts())).toEqual(["live"]);
	// No change, no rewrite: an all-alive prune keeps the stored JSON untouched.
	const before = localStorage.getItem(ASK_DRAFTS_KEY);
	pruneAskDrafts(new Set(["live", "other"]));
	expect(localStorage.getItem(ASK_DRAFTS_KEY)).toBe(before);
});

const entry = (key: string, level: InboxLevel): InboxEntry => ({ key, level });

test("inboxView: clear bell", () => {
	expect(inboxView([], new Set())).toEqual({
		total: 0,
		fresh: [],
		lit: false,
		level: null,
	});
});

test("inboxView: all acknowledged shows standing at the most urgent listed level", () => {
	const entries = [entry("a", "needs"), entry("b", "info")];
	const v = inboxView(entries, new Set(["a", "b"]));
	expect(v.lit).toBe(false);
	expect(v.total).toBe(2);
	expect(v.fresh).toEqual([]);
	expect(v.level).toBe("needs");
});

test("inboxView: a new info entry lights beside an acknowledged needs entry", () => {
	const entries = [entry("task:1:needs", "needs"), entry("notice:x", "info")];
	const seen = new Set(["task:1:needs"]);
	const v = inboxView(entries, seen);
	expect(v.lit).toBe(true);
	expect(v.level).toBe("info");
	expect(v.fresh).toEqual([entry("notice:x", "info")]);
});

test("inboxView: fresh entries pick the most urgent level", () => {
	const entries = [
		entry("n", "info"),
		entry("a", "asked"),
		entry("w", "needs"),
		entry("c", "crit"),
	];
	// Least urgent first, so dropping from the end removes the most urgent level each time.
	expect(inboxView(entries, new Set()).level).toBe("crit");
	expect(inboxView(entries.slice(0, 3), new Set()).level).toBe("needs");
	expect(inboxView(entries.slice(0, 2), new Set()).level).toBe("asked");
	expect(inboxView(entries.slice(0, 1), new Set()).level).toBe("info");
});

test("taskEntryKey separates cards and ask rounds", () => {
	const plain = { id: "t1", asked: null };
	const withAsk = {
		id: "t1",
		asked: [{ question: "go?", options: [], multi: false, recommended: null }],
	};
	expect(taskEntryKey(withAsk)).not.toBe(taskEntryKey(plain));
	const round2 = {
		...withAsk,
		asked: [
			...withAsk.asked,
			{ question: "more?", options: [], multi: false, recommended: null },
		],
	};
	expect(taskEntryKey(round2)).not.toBe(taskEntryKey(withAsk));
	expect(taskEntryKey(plain)).toBe(taskEntryKey({ id: "t1", asked: null }));
});

test("pruneSeen drops cleared keys, keeps pending-protected ones, and is identity when nothing drops", () => {
	const seen = new Set(["live", "gone"]);
	const pruned = pruneSeen(seen, new Set(["live"]));
	expect([...pruned]).toEqual(["live"]);
	// pending protects a key whose source has not loaded yet.
	expect([...pruneSeen(seen, new Set(["live"]), (k) => k === "gone")]).toEqual([
		"live",
		"gone",
	]);
	// Nothing to drop: the same object comes back, so a state setter skips the render.
	expect(pruneSeen(seen, new Set(["live", "gone", "x"]))).toBe(seen);
});

test("inbox seen round-trips through localStorage and survives malformed values", () => {
	localStorage.removeItem(INBOX_SEEN_KEY);
	expect(loadInboxSeen()).toEqual(new Set());
	saveInboxSeen(new Set(["a", "b"]));
	expect(loadInboxSeen()).toEqual(new Set(["a", "b"]));
	localStorage.setItem(INBOX_SEEN_KEY, "{not json");
	expect(loadInboxSeen()).toEqual(new Set());
	localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify({ a: 1 }));
	expect(loadInboxSeen()).toEqual(new Set());
	localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify(["ok", 7, null]));
	expect(loadInboxSeen()).toEqual(new Set(["ok"]));
});

describe("arch-review changed-line coverage", () => {
	// Fake browser surface for showAlerts: Notification, document, window, and the
	// localStorage stand-in already defined above.
	class FakeNotification {
		static permission = "granted";
		title: string;
		opts: { body: string; tag: string; icon: unknown };
		onclick: (() => void) | null = null;
		closeCalls = 0;
		constructor(
			title: string,
			opts: { body: string; tag: string; icon: unknown },
		) {
			this.title = title;
			this.opts = opts;
			created.push(this);
		}
		close(): void {
			this.closeCalls++;
		}
	}
	const created: FakeNotification[] = [];
	const g = globalThis as unknown as Record<string, unknown>;
	let focusCalls = 0;
	const originals = {
		document: g.document,
		window: g.window,
		Notification: g.Notification,
	};

	// Install fakes; restore() puts the originals back.
	function install(hidden: boolean): void {
		focusCalls = 0;
		created.length = 0;
		g.document = { hidden };
		g.window = { Notification: FakeNotification, focus: () => focusCalls++ };
		g.Notification = FakeNotification;
		localStorage.setItem(NOTIFY_KEY, "1");
	}
	function restore(): void {
		g.document = originals.document;
		g.window = originals.window;
		g.Notification = originals.Notification;
		localStorage.removeItem(NOTIFY_KEY);
	}

	test("showAlerts fires with the icon and the channel tag; click focuses and closes", () => {
		install(true);
		try {
			showAlerts([
				card({ id: "a", state: "needs_you", needsReason: "turn ended" }),
			]);
			expect(created).toHaveLength(1);
			expect(created[0]!.title).toBe("proj: short title");
			expect(created[0]!.opts).toEqual({
				body: "turn ended",
				tag: "needs_you",
				icon,
			});
			created[0]!.onclick!();
			expect(focusCalls).toBe(1);
			expect(created[0]!.closeCalls).toBe(1);
		} finally {
			restore();
		}
	});

	test("showAlerts stays silent for an empty list, a visible tab, or the switch off", () => {
		install(true);
		try {
			showAlerts([]);
			expect(created).toHaveLength(0);
			g.document = { hidden: false };
			showAlerts([card({ id: "a", state: "needs_you", needsReason: "x" })]);
			expect(created).toHaveLength(0);
			g.document = { hidden: true };
			localStorage.removeItem(NOTIFY_KEY);
			showAlerts([card({ id: "a", state: "needs_you", needsReason: "x" })]);
			expect(created).toHaveLength(0);
		} finally {
			restore();
		}
	});
});

describe("alatePendingEntry", () => {
	const EPISODE = 1_000_000;

	test("files nothing without an episode or before the threshold", () => {
		expect(alatePendingEntry(null, 0)).toBe(null);
		expect(alatePendingEntry(EPISODE, EPISODE)).toBe(null);
		expect(alatePendingEntry(EPISODE, EPISODE + ALATE_PENDING_AFTER_MS)).toBe(
			null,
		);
	});

	test("files one stable entry per episode once the wait passes the threshold", () => {
		const justPast = EPISODE + ALATE_PENDING_AFTER_MS + 1;
		expect(alatePendingEntry(EPISODE, justPast)).toBe(
			`alate-pending:${EPISODE}`,
		);
		// Same episode keeps the same key, so repeat checks never stack entries.
		expect(alatePendingEntry(EPISODE, justPast + 3_600_000)).toBe(
			`alate-pending:${EPISODE}`,
		);
		// A new episode (fresh since stamp) is a new entry again.
		expect(alatePendingEntry(EPISODE + 1, justPast + 1)).toBe(
			`alate-pending:${EPISODE + 1}`,
		);
	});
});
