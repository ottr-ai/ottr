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

/** Occurrence key of a needs_you card's inbox entry: a new ask round is a new entry, and a
 * new PR review draft (a fresh run id) is one too. Cards carry the stamp on `prOccurrence`;
 * the alert diff's inputs carry it flat as `prDraft`. */
export function taskEntryKey(t: {
	id: string;
	asked: AskQuestion[] | null;
	kind?: TaskKind;
	prOccurrence?: { draft: number | null } | null;
	prDraft?: number | null;
}): string {
	const draft =
		t.kind === "pr_review"
			? (t.prOccurrence?.draft ?? t.prDraft ?? null)
			: null;
	return `task:${t.id}:${t.asked === null ? (draft !== null ? `needs-pr${draft}` : "needs") : `ask-${askHash(JSON.stringify(t.asked))}`}`;
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
	/** Id of the PR's last done review run; null without a saved draft, or when the project
	 * keeps PR review notifications off. Changes on every saved draft, so a rewrite is a new
	 * needs_you occurrence. */
	prDraft: number | null;
	/** The card's unseen comment stamp (`pr_review.comments_at` while the wave is unseen);
	 * null when every comment wave is read or none arrived. A change is one new occurrence. */
	prComments: number | null;
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

/** One alert event for a card state. */
function alertEvent(
	t: AlertCardInput,
	cls: AlertClass,
	key: string,
	body: string,
): AlertEvent {
	return {
		key,
		class: cls,
		project: t.project,
		taskId: t.id,
		title: `${t.project}: ${t.sessionTitle ?? t.title}`,
		body,
		url: `/projects/${encodeURIComponent(t.project)}/tasks/${encodeURIComponent(t.id)}`,
		tag: cls,
	};
}

/** The error event for a card whose failed turn changed; null when there is none. */
function errorEvent(t: AlertCardInput, old: AlertCardInput | undefined) {
	if (t.errorTurn === null || t.errorTurn === (old?.errorTurn ?? null))
		return null;
	// An error that leaves the card in needs_you takes the needs_you entry key, so the
	// inbox entry and the push are one occurrence instead of two.
	const key =
		t.state === "needs_you" ? taskEntryKey(t) : `error:${t.id}:${t.errorTurn}`;
	return alertEvent(t, "error", key, errorBody(t.errorText));
}

/** The needs_you state is a follow-up of an error already alerted on that same turn. */
function isErrorFollowUp(
	old: AlertCardInput | undefined,
	t: AlertCardInput,
): boolean {
	return (
		old !== undefined &&
		old.state !== "needs_you" &&
		t.errorTurn !== null &&
		old.errorTurn === t.errorTurn
	);
}

/** The needs_you body of a PR review card: which draft state the user walks into. */
function prDraftBody(old: AlertCardInput | undefined): string {
	if (old === undefined || (old.prDraft ?? null) === null)
		return "Review draft ready to post";
	return old.state !== "needs_you"
		? "Review draft ready for the new head"
		: "Review draft updated — re-read it before posting";
}

/** The request event when the card newly waits on the user; null when there is none. */
function requestEvent(t: AlertCardInput, old: AlertCardInput | undefined) {
	if (t.state !== "needs_you" || isErrorFollowUp(old, t)) return null;
	// The failed turn already alerted as an Error in an earlier frame: the needs_you it
	// leads to is part of that alert, not a second Request.
	if (
		old !== undefined &&
		old.state === "needs_you" &&
		taskEntryKey(old) === taskEntryKey(t)
	)
		return null;
	const body =
		t.asked !== null && t.asked.length > 0
			? t.asked.map((q) => q.question).join(" · ")
			: t.kind === "pr_review"
				? prDraftBody(old)
				: (t.needsReason ?? "Action required");
	return alertEvent(t, "request", taskEntryKey(t), body);
}

/** The event for a new comment wave on a posted review; null when there is none. A wave
 * clears when the user reads it (the stamp nulls) or a newer wave replaces it, so one live
 * `pr:` alert per card is enough. */
function prCommentsEvent(t: AlertCardInput, old: AlertCardInput | undefined) {
	if (t.prComments === null || t.prComments === (old?.prComments ?? null))
		return null;
	return alertEvent(
		t,
		"request",
		`pr:${t.id}:${t.prComments}`,
		"New comments after your posted review",
	);
}

/** The complete event when the card newly finished or was answered; null when there is none. */
function completeEvent(t: AlertCardInput, old: AlertCardInput | undefined) {
	if (
		old === undefined ||
		!(
			(t.stage === "done" && old.stage !== "done") ||
			(t.answered && !old.answered)
		)
	)
		return null;
	const body = t.answered
		? (t.summary ?? "Answered; open the card to read it")
		: `${t.title} was done`;
	return alertEvent(t, "complete", `done:${t.id}`, body);
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
		const ev =
			errorEvent(t, old) ??
			requestEvent(t, old) ??
			prCommentsEvent(t, old) ??
			completeEvent(t, old);
		if (ev !== null) out.push(ev);
	}
	return out;
}

export interface LiveAlert {
	key: string;
	/** The key the pushed payload carried. It differs from `key` once an Error is rekeyed to its
	 * needs_you entry; acknowledging `key` acknowledges `sent` too, so a push still in flight
	 * finds its own key acknowledged and never shows. */
	sent: string;
	class: AlertClass;
	taskId: string;
	project: string;
	/** Endpoints the alert was pushed to: retraction is per device, so an alert a device never
	 * got (class off, project muted) never keeps that device's class notification open. */
	to: string[];
}

/** An Error pushed before its card reached needs_you carries `error:<id>:<turn>`; once the card
 * waits for the user on that same failed turn, the bell shows the needs_you entry instead. The
 * alert takes that entry's key (keeping `sent`), so acknowledging or answering the entry
 * retracts it. */
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

/** Keys an acknowledgement of `keys` adds: the keys themselves plus the payload keys (`sent`)
 * of live alerts they name. */
export function ackKeys(
	keys: readonly string[],
	live: readonly LiveAlert[],
): string[] {
	const named = new Set(keys);
	return [
		...keys,
		...live
			.filter((a) => named.has(a.key) && a.sent !== a.key)
			.map((a) => a.sent),
	];
}

/** A bell entry key `<prefix>:<body>` that stays short: a body over 200 characters (an error
 * text, an id list) becomes a hash, so no key ever outgrows SEEN_KEY_MAX. */
export function shortKey(prefix: string, body: string): string {
	return body.length <= 200
		? `${prefix}:${body}`
		: `${prefix}:#${askHash(body)}`;
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
		if (a.key.startsWith("pr:")) return a.key !== `pr:${t.id}:${t.prComments}`;
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

/** Per class, the highest notification sequence number a retraction covers: the service worker
 * closes a notification of that tag only when the payload that showed it had a sequence number
 * at or below this bound. A notification shown later (a higher number) never closes, however
 * late the retraction arrives. */
export type ClearBound = Partial<Record<AlertClass, number>>;

/** Most keys a payload names on the wire; past it the payload is `partial`. Keys are short
 * (hashed ask rounds, `error:<id>:<turn>`, `done:<id>`), so this keeps every payload far
 * below Web Push's ~4 KB plaintext budget (RFC 8291 §4). */
export const PAYLOAD_KEYS_MAX = 20;

export interface AlertPayload {
	type: "alert";
	title: string;
	body: string;
	tag: string;
	url: string;
	/** The alerts this notification stands for, capped at PAYLOAD_KEYS_MAX. */
	keys: string[];
	/** More alerts than `keys` names. Informational: the service worker decides read/unread
	 * from the server's live state (GET /api/notifications/live), never from the keys. */
	partial: boolean;
	/** Per-device, per-class sequence number; app.ts batchFor assigns it (0 until then). */
	seq: number;
	/** Classes to retract before this alert, each up to its bound. */
	clear: AlertClass[];
	upTo: ClearBound;
}
export interface ClearPayload {
	type: "clear";
	tags: AlertClass[];
	upTo: ClearBound;
}

const GROUP_BODY: Record<AlertClass, (n: number) => string> = {
	request: (n) => `${n} tasks need your attention`,
	error: (n) => `${n} tasks failed`,
	complete: (n) => `${n} tasks finished`,
};

/** One payload per class among `events` (already filtered for ONE device). Same-class pushes
 * share a tag, so the device replaces that class's notification instead of stacking one per
 * task. The payload stands for every live alert of the class on this device (`liveKeys`, which
 * include this pass's): one → the card's own title/body/url; more → a grouped count of all of
 * them, url "/". The wire names at most PAYLOAD_KEYS_MAX of them, this pass's first, and
 * marks the rest with `partial`. */
export function payloadsFor(
	events: readonly AlertEvent[],
	liveKeys: Readonly<Record<AlertClass, readonly string[]>>,
): AlertPayload[] {
	const out: AlertPayload[] = [];
	for (const cls of ALERT_CLASSES) {
		const of = events.filter((e) => e.class === cls);
		const first = of[0];
		if (first === undefined) continue;
		const all = [...new Set([...of.map((e) => e.key), ...liveKeys[cls]])];
		const wire = {
			keys: all.slice(0, PAYLOAD_KEYS_MAX),
			partial: all.length > PAYLOAD_KEYS_MAX,
			seq: 0,
			clear: [],
			upTo: {},
		};
		out.push(
			all.length === 1
				? {
						type: "alert",
						title: first.title,
						body: first.body,
						tag: cls,
						url: first.url,
						...wire,
					}
				: {
						type: "alert",
						title: "Ottr",
						body: GROUP_BODY[cls](all.length),
						tag: cls,
						url: "/",
						...wire,
					},
		);
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
