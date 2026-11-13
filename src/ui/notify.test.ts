import { describe, expect, test } from "bun:test";
import type { InboxEntry, InboxLevel } from "./notify.ts";
import {
	ALATE_PENDING_AFTER_MS,
	ASK_DRAFTS_KEY,
	alatePendingEntry,
	COMPOSE_DRAFTS_KEY,
	clearAskDraft,
	clearComposeDraft,
	inboxView,
	loadAskDrafts,
	loadComposeDraft,
	pruneAskDrafts,
	pruneSeen,
	saveAskDraft,
	saveComposeDraft,
	seenToDrop,
} from "./notify.ts";

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
	expect(loadAskDrafts().t1).toEqual({ fp: "a\nb", answers: { 0: "one" } });
	// Overwriting one task leaves the other's draft alone.
	saveAskDraft("t1", { fp: "a\nb", answers: { 0: "one", 1: "uno" } });
	expect(loadAskDrafts().t2?.answers[0]).toBe("two");
	clearAskDraft("t1");
	expect(loadAskDrafts().t1).toBeUndefined();
	expect(loadAskDrafts().t2).toBeDefined();
	// A changed ask round (fingerprint miss) is the caller's signal to start empty.
	expect(loadAskDrafts().t1?.fp === "a\nb").toBe(false);
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

test("inboxView: an acknowledged needs entry keeps the bell lit at its level", () => {
	const entries = [entry("a", "needs"), entry("b", "info")];
	const v = inboxView(entries, new Set(["a", "b"]));
	expect(v.lit).toBe(true);
	expect(v.total).toBe(2);
	expect(v.fresh).toEqual([]);
	expect(v.level).toBe("needs");
});

test("inboxView: only read notices leave the bell grey at the info level", () => {
	const entries = [entry("notice:a", "info"), entry("notice:b", "info")];
	const v = inboxView(entries, new Set(["notice:a", "notice:b"]));
	expect(v.lit).toBe(false);
	expect(v.level).toBe("info");
	expect(v.total).toBe(2);
	expect(v.fresh).toEqual([]);
});

test("inboxView: 18 asked entries stay lit after acknowledgement", () => {
	const entries = Array.from({ length: 18 }, (_, n) =>
		entry(`task:a${n}:ask`, "asked"),
	);
	const seen = new Set(entries.map((e) => e.key));
	const v = inboxView(entries, seen);
	expect(v.lit).toBe(true);
	expect(v.level).toBe("asked");
	expect(v.total).toBe(18);
	expect(v.fresh).toEqual([]);
});

test("inboxView: a new info entry lights beside an acknowledged needs entry, at the needs level", () => {
	const entries = [entry("task:1:needs", "needs"), entry("notice:x", "info")];
	const seen = new Set(["task:1:needs"]);
	const v = inboxView(entries, seen);
	expect(v.lit).toBe(true);
	expect(v.level).toBe("needs");
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

test("seenToDrop: another tab's browser-local acknowledgement survives; this tab's own cleared one drops", () => {
	const shownHere = new Set<string>();
	// Tab B never showed tab A's crit entry: it keeps the acknowledgement.
	expect(
		seenToDrop(["crit:boom", "notice:hi"], new Set(), shownHere, true),
	).toEqual([]);
	// This tab showed the crit entry, then it cleared: now it drops.
	expect(
		seenToDrop(["crit:mine"], new Set(["crit:mine"]), shownHere, true),
	).toEqual([]);
	expect(seenToDrop(["crit:mine"], new Set(), shownHere, true)).toEqual([
		"crit:mine",
	]);
	// Shared notice keys drop when cleared; task keys and unloaded behind keys stay.
	expect(
		seenToDrop(
			["drain:1", "task:A:needs", "behind:2"],
			new Set(),
			new Set(),
			false,
		),
	).toEqual(["drain:1"]);
});
