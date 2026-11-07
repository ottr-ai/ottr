// Alert model shared by the server (event diff, retraction, push delivery) and the browser
// (inbox entry keys). Pure on purpose: no I/O and no node imports, so the UI bundle can import it.
import type { AskQuestion, TaskKind } from "./types.ts";

export type AlertClass = "request" | "error" | "complete";
export const ALERT_CLASSES: readonly AlertClass[] = [
	"request",
	"error",
	"complete",
];
export type ClassPrefs = Record<AlertClass, boolean>;
export const ALL_CLASSES_ON: ClassPrefs = Object.freeze({
	request: true,
	error: true,
	complete: true,
});

/** Short stable hash (cyrb53, base 36) of an ask round: entry keys stay small however long the
 * questions are, so the shared seen set never has to cut or drop one. */
function askHash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Occurrence key of a needs_you card's inbox entry: a new ask round is a new entry. */
export function taskEntryKey(t: {
	id: string;
	asked: AskQuestion[] | null;
}): string {
	return `task:${t.id}:${t.asked === null ? "needs" : `ask-${askHash(JSON.stringify(t.asked))}`}`;
}

/** Card facts the event diff reads. Built by the server from TaskCard + its latest turn. */
export interface AlertCardInput {
	id: string;
	project: string;
	title: string;
	sessionTitle: string | null;
	state: string;
	stage: string;
	kind?: TaskKind;
	asked: AskQuestion[] | null;
	answered: boolean;
	needsReason: string | null;
	summary: string | null;
	/** Id of the card's latest settled turn when that turn ended with an error; else null. */
	errorTurn: string | null;
	/** That turn's error text (redacted as stored); null when errorTurn is null. */
	errorText: string | null;
	/** The card was cancelled: it alerts nothing more and its live alerts retract. */
	cancelled: boolean;
}

export interface AlertEvent {
	key: string;
	class: AlertClass;
	project: string;
	taskId: string;
	title: string;
	body: string;
	url: string;
	tag: AlertClass;
}

const ERROR_BODY_MAX = 200;

function errorBody(text: string | null): string {
	const first = text?.split("\n", 1)[0]?.trim() ?? "";
	return first === "" ? "A turn failed" : first.slice(0, ERROR_BODY_MAX);
}

/**
 * Events for cards that changed between two frames: at most one per card, precedence
 * error > request > complete. An error that leaves the card in needs_you takes the needs_you
 * entry key, so the inbox entry and the push are one occurrence instead of two.
 * null prev = first frame after server start: silent. Retro cards never alert.
 */
export function diffEvents(
	prev: AlertCardInput[] | null,
	next: AlertCardInput[],
): AlertEvent[] {
	if (prev === null) return [];
	const before = new Map(prev.map((t) => [t.id, t]));
	const out: AlertEvent[] = [];
	for (const t of next) {
		if (t.kind === "retro" || t.cancelled) continue;
		const old = before.get(t.id);
		const ev = (cls: AlertClass, key: string, body: string): AlertEvent => ({
			key,
			class: cls,
			project: t.project,
			taskId: t.id,
			title: `${t.project}: ${t.sessionTitle ?? t.title}`,
			body,
			url: `/projects/${encodeURIComponent(t.project)}/tasks/${encodeURIComponent(t.id)}`,
			tag: cls,
		});
		if (t.errorTurn !== null && t.errorTurn !== (old?.errorTurn ?? null)) {
			const key =
				t.state === "needs_you"
					? taskEntryKey(t)
					: `error:${t.id}:${t.errorTurn}`;
			out.push(ev("error", key, errorBody(t.errorText)));
			continue;
		}
		// The failed turn already alerted as an Error in an earlier frame: the needs_you it
		// leads to is part of that alert, not a second Request.
		const errorFollowUp =
			old !== undefined &&
			old.state !== "needs_you" &&
			t.errorTurn !== null &&
			old.errorTurn === t.errorTurn;
		if (
			t.state === "needs_you" &&
			!errorFollowUp &&
			(old === undefined ||
				old.state !== "needs_you" ||
				taskEntryKey(old) !== taskEntryKey(t))
		) {
			const body =
				t.asked !== null && t.asked.length > 0
					? t.asked.map((q) => q.question).join(" · ")
					: (t.needsReason ?? "Action required");
			out.push(ev("request", taskEntryKey(t), body));
			continue;
		}
		if (
			old !== undefined &&
			((t.stage === "done" && old.stage !== "done") ||
				(t.answered && !old.answered))
		) {
			const body = t.answered
				? (t.summary ?? "Answered; open the card to read it")
				: `${t.title} was done`;
			out.push(ev("complete", `done:${t.id}`, body));
		}
	}
	return out;
}

export interface LiveAlert {
	key: string;
	class: AlertClass;
	taskId: string;
	project: string;
	/** Endpoints the alert was pushed to: retraction is per device, so an alert a device never
	 * got (class off, project muted) never keeps that device's class notification open. */
	to: string[];
}

/** An Error pushed before its card reached needs_you carries `error:<id>:<turn>`; once the card
 * waits for the user on that same failed turn, the bell shows the needs_you entry instead. The
 * alert takes that entry's key, so acknowledging or answering the entry retracts it. */
export function rekeyErrorAlerts(
	live: readonly LiveAlert[],
	next: readonly AlertCardInput[],
): LiveAlert[] {
	const cards = new Map(next.map((t) => [t.id, t]));
	return live.map((a) => {
		const t = cards.get(a.taskId);
		return t !== undefined &&
			t.state === "needs_you" &&
			a.key === `error:${t.id}:${t.errorTurn}`
			? { ...a, key: taskEntryKey(t) }
			: a;
	});
}

/** Keys of live alerts whose cause cleared (card gone or cancelled; task: key no longer the card's current needs_you entry key; done: card neither in done nor answered; error:<id>:<turn> card's errorTurn differs) or whose key is in `seen`. */
export function clearedAlerts(
	live: readonly LiveAlert[],
	next: readonly AlertCardInput[],
	seen: ReadonlySet<string>,
): LiveAlert[] {
	const cards = new Map(next.map((t) => [t.id, t]));
	return live.filter((a) => {
		if (seen.has(a.key)) return true;
		const t = cards.get(a.taskId);
		if (t === undefined || t.cancelled) return true;
		if (a.key.startsWith("task:"))
			return t.state !== "needs_you" || taskEntryKey(t) !== a.key;
		if (a.key.startsWith("done:")) {
			// An answered question-only card completes without entering done.
			return t.stage !== "done" && !t.answered;
		}
		if (a.key.startsWith("error:"))
			return a.key !== `error:${t.id}:${t.errorTurn}`;
		return false;
	});
}

/** Class tags one device must retract: classes that lost an alert pushed to `endpoint` and have
 * no alert pushed to it left in `remaining`. */
export function tagsToClear(
	removed: readonly LiveAlert[],
	remaining: readonly LiveAlert[],
	endpoint: string,
): AlertClass[] {
	const lost = new Set(
		removed.filter((a) => a.to.includes(endpoint)).map((a) => a.class),
	);
	const left = new Set(
		remaining.filter((a) => a.to.includes(endpoint)).map((a) => a.class),
	);
	return ALERT_CLASSES.filter((c) => lost.has(c) && !left.has(c));
}

export const PRESENCE_WINDOW_MS = 60_000;

/** True while any tab's last focus heartbeat is younger than PRESENCE_WINDOW_MS. */
export function presenceHolds(
	focusAt: ReadonlyMap<string, number>,
	now: number,
): boolean {
	for (const at of focusAt.values())
		if (now - at < PRESENCE_WINDOW_MS) return true;
	return false;
}

export function deliverable(
	classes: ClassPrefs,
	mutedProjects: ReadonlySet<string>,
	e: { class: AlertClass; project: string },
): boolean {
	return classes[e.class] && !mutedProjects.has(e.project);
}

export interface AlertPayload {
	type: "alert";
	title: string;
	body: string;
	tag: string;
	url: string;
	keys: string[];
	clear: AlertClass[];
	/** This class's own tag was due for retraction before the pass: when the service worker
	 * does not show the alert (every key acknowledged), it closes the tag instead of leaving
	 * the stale notification that the new one would have replaced. */
	replace: boolean;
}
export interface ClearPayload {
	type: "clear";
	tags: AlertClass[];
}

const GROUP_BODY: Record<AlertClass, (n: number) => string> = {
	request: (n) => `${n} tasks need your attention`,
	error: (n) => `${n} tasks failed`,
	complete: (n) => `${n} tasks finished`,
};

/** One payload per class among `events` (already filtered for ONE device). Same-class pushes share a tag, so the device replaces that class's notification instead of stacking one per task. One event → its own title/body/url; n>1 → grouped count, url "/", count = max(n, liveCount[class]). */
export function payloadsFor(
	events: readonly AlertEvent[],
	liveCount: Readonly<Record<AlertClass, number>>,
	clear: readonly AlertClass[],
): AlertPayload[] {
	const out: AlertPayload[] = [];
	for (const cls of ALERT_CLASSES) {
		const of = events.filter((e) => e.class === cls);
		const first = of[0];
		if (first === undefined) continue;
		const keys = of.map((e) => e.key);
		if (of.length === 1) {
			out.push({
				type: "alert",
				title: first.title,
				body: first.body,
				tag: cls,
				url: first.url,
				keys,
				clear: [...clear],
				replace: false,
			});
			continue;
		}
		out.push({
			type: "alert",
			title: "Ottr",
			body: GROUP_BODY[cls](Math.max(of.length, liveCount[cls])),
			tag: cls,
			url: "/",
			keys,
			clear: [...clear],
			replace: false,
		});
	}
	return out;
}

/** Apple's push service revokes subscriptions that receive pushes without a visible notification, so data-only clear pushes skip these endpoints. The server keeps their pending clear tags and sends them in the next alert push to that device (app.ts batchFor). */
export function isApplePush(endpoint: string): boolean {
	try {
		return new URL(endpoint).hostname.endsWith("push.apple.com");
	} catch {
		return false;
	}
}

/** Longest acknowledged key the server stores; the seen route refuses longer ones (400) instead
 * of dropping them. Task keys hash their ask, so real keys stay far below it. */
export const SEEN_KEY_MAX = 2000;
const SEEN_MAX = 5000;

/** Normalizes a stored/posted seen list: strings only, deduped, each ≤ SEEN_KEY_MAX chars, at most the last 5000 kept. */
export function normalizeSeen(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	for (const k of raw)
		if (typeof k === "string" && k.length <= SEEN_KEY_MAX) seen.add(k);
	return [...seen].slice(-SEEN_MAX);
}
