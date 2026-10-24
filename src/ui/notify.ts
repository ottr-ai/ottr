import type { TaskCard } from "../types.ts";
import icon from "./icon-192.png";

/** localStorage switch for desktop notifications; present = the user turned them on. */
export const NOTIFY_KEY = "ottr.notify";

/** localStorage array of answered task ids the user has opened; the unread badge reads its absence. */
export const SEEN_KEY = "ottr.seen.answers";

export function loadSeenAnswers(): Set<string> {
	try {
		return new Set(
			JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[],
		);
	} catch {
		return new Set();
	}
}

/** localStorage map of unsent ask answers per task id; survives drawer close and reload. */
export const ASK_DRAFTS_KEY = "ottr.ask.drafts";

export interface AskDraft {
	/** Fingerprint of the questions (newline-joined texts); a mismatching draft is ignored. */
	fp: string;
	answers: Record<number, string>;
}

export function loadAskDrafts(): Record<string, AskDraft> {
	try {
		return JSON.parse(localStorage.getItem(ASK_DRAFTS_KEY) ?? "{}") as Record<
			string,
			AskDraft
		>;
	} catch {
		return {};
	}
}

export function saveAskDraft(taskId: string, draft: AskDraft): void {
	const drafts = loadAskDrafts();
	drafts[taskId] = draft;
	localStorage.setItem(ASK_DRAFTS_KEY, JSON.stringify(drafts));
}

export function clearAskDraft(taskId: string): void {
	const drafts = loadAskDrafts();
	if (!(taskId in drafts)) return;
	delete drafts[taskId];
	localStorage.setItem(ASK_DRAFTS_KEY, JSON.stringify(drafts));
}

/** Drops drafts for tasks without an outstanding ask; call on each state frame. */
export function pruneAskDrafts(alive: ReadonlySet<string>): void {
	const drafts = loadAskDrafts();
	const kept = Object.keys(drafts).filter((id) => alive.has(id));
	if (kept.length === Object.keys(drafts).length) return;
	localStorage.setItem(
		ASK_DRAFTS_KEY,
		JSON.stringify(Object.fromEntries(kept.map((id) => [id, drafts[id]!]))),
	);
}

/** localStorage map of unsent compose drafts per dialog key (new task, backlog draft, follow-up);
 * a failed send (server down, offline) keeps the text here, so it survives close and reload. */
export const COMPOSE_DRAFTS_KEY = "ottr.compose.drafts";

export interface ComposeDraft {
	text: string;
	model: string;
}

function readComposeDrafts(): Record<string, ComposeDraft> {
	try {
		return JSON.parse(
			localStorage.getItem(COMPOSE_DRAFTS_KEY) ?? "{}",
		) as Record<string, ComposeDraft>;
	} catch {
		return {};
	}
}

/** The cached draft for one dialog key, else null; a corrupt store or junk shape reads as absent. */
export function loadComposeDraft(key: string): ComposeDraft | null {
	const d = readComposeDrafts()[key];
	if (typeof d?.text !== "string") return null;
	return {
		text: d.text,
		model: typeof d.model === "string" ? d.model : "",
	};
}

/** Mirrors a compose dialog into the cache; empty text removes the entry. Quota errors drop the
 * cache write silently — the in-memory draft still submits. */
export function saveComposeDraft(key: string, draft: ComposeDraft): void {
	const drafts = readComposeDrafts();
	if (draft.text.trim() === "") {
		if (!(key in drafts)) return;
		delete drafts[key];
	} else {
		drafts[key] = draft;
	}
	try {
		localStorage.setItem(COMPOSE_DRAFTS_KEY, JSON.stringify(drafts));
	} catch {
		// Quota full: the cache is best-effort; the dialog keeps its own copy.
	}
}

/** Drops the cached draft after a successful send; an absent key writes nothing. */
export function clearComposeDraft(key: string): void {
	const drafts = readComposeDrafts();
	if (!(key in drafts)) return;
	delete drafts[key];
	localStorage.setItem(COMPOSE_DRAFTS_KEY, JSON.stringify(drafts));
}

/** Stable alert identity per task: a new ask (or leaving and re-entering needs_you) changes it. */
function alertKey(t: TaskCard): string {
	if (t.answered) return "answered";
	return t.asked === null ? "needs" : `asked:${JSON.stringify(t.asked)}`;
}

/** Tasks that newly need the user (entered needs_you, fresh ask, or brand-new held card), just reported
 * an answer, or finished (entered done); retro cards never alert. */
export function freshAlerts(
	prev: TaskCard[] | null,
	next: TaskCard[],
): TaskCard[] {
	if (prev === null) return []; // first frame after load: the bell already shows the backlog, never re-alert it
	const before = new Map(prev.map((t) => [t.id, t]));
	const out: TaskCard[] = [];
	for (const t of next) {
		if (t.kind === "retro") continue; // retro transitions are expected housekeeping
		const old = before.get(t.id);
		if (old === undefined) {
			// brand-new card: only retro proposals arrive held, so alert only a needs_you arrival
			if (t.state === "needs_you") out.push(t);
			continue;
		}
		const enteredDone = t.stage === "done" && old.stage !== "done";
		if (t.state !== "needs_you" && !t.answered && !enteredDone) continue;
		if (
			enteredDone ||
			old.state !== t.state ||
			old.answered !== t.answered ||
			alertKey(old) !== alertKey(t)
		)
			out.push(t);
	}
	return out;
}

export function alertTitle(t: TaskCard): string {
	return `${t.project}: ${t.sessionTitle ?? t.title}`;
}

/** The ask's questions joined, else the answer summary, else the needs reason. Done cards never reach this. */
export function alertBody(t: TaskCard): string {
	if (t.answered) return t.summary ?? "Answered; open the card to read it";
	if (t.asked !== null) return t.asked.map((q) => q.question).join(" · ");
	return t.needsReason ?? "Action required";
}

export const notificationsSupported = (): boolean =>
	typeof window !== "undefined" && "Notification" in window;

/** On = supported, permission granted, and the user kept the switch on. */
export const notificationsOn = (): boolean =>
	notificationsSupported() &&
	Notification.permission === "granted" &&
	localStorage.getItem(NOTIFY_KEY) === "1";

/** Asks the browser for permission from the click; resolves "granted" or a denial reason. */
export async function requestNotifyPermission(): Promise<
	"granted" | "denied" | "dismissed"
> {
	if (!notificationsSupported()) return "denied";
	return (await Notification.requestPermission()) as
		| "granted"
		| "denied"
		| "dismissed";
}

export interface AlertNotice {
	title: string;
	body: string;
	tag: string;
}

/**
 * Notices for one alert frame: same-channel alerts collapse into one counted message, a lone
 * alert keeps its detail (done says "<task title> was done"), answered reports stay per-card.
 * Channel tags match the server's web-push tags (needs_you/done), so a tab notice and its push
 * twin replace each other instead of doubling; answered reports keep ottr:<id>, the server never pushes those.
 * ponytail: counts are per frame here; the server push path is the one that counts across frames.
 */
export function alertNotices(alerts: TaskCard[]): AlertNotice[] {
	let needs: TaskCard | undefined;
	let done: TaskCard | undefined;
	let needsCount = 0;
	let doneCount = 0;
	const out: AlertNotice[] = [];
	for (const t of alerts) {
		if (t.state === "needs_you") {
			needs ??= t;
			needsCount++;
		} else if (t.stage === "done") {
			done ??= t;
			doneCount++;
		} else {
			// answered reports: keep per-card detail
			out.push({
				title: alertTitle(t),
				body: alertBody(t),
				tag: `ottr:${t.id}`,
			});
		}
	}
	if (needsCount > 1)
		out.push({
			title: "Ottr",
			body: `${needsCount} tasks need your attention`,
			tag: "needs_you",
		});
	else if (needs !== undefined)
		out.push({
			title: alertTitle(needs),
			body: alertBody(needs),
			tag: "needs_you",
		});
	if (doneCount > 1)
		out.push({
			title: "Ottr",
			body: `${doneCount} tasks finished`,
			tag: "done",
		});
	else if (done !== undefined)
		out.push({
			title: alertTitle(done),
			body: `${done.title} was done`,
			tag: "done",
		});
	return out;
}

/**
 * Chrome notifications per channel, only while the tab is hidden — a visible board already
 * shows the bell and the alarm popover. Same tag replaces, so repeat asks never stack.
 * ponytail: fires only with this tab open; sw.js already delivers the server's pushes to closed tabs.
 */
export function showAlerts(alerts: TaskCard[]): void {
	if (alerts.length === 0 || !document.hidden) return;
	if (!notificationsOn()) return;
	for (const a of alertNotices(alerts)) {
		const n = new Notification(a.title, {
			body: a.body,
			tag: a.tag,
			icon,
		});
		n.onclick = () => {
			window.focus();
			n.close();
		};
	}
}

/** Inbox entry level, most urgent first: a failed action, a stalled task, an open question, a notice. */
export type InboxLevel = "crit" | "needs" | "asked" | "info";

/** One inbox row. `key` names this occurrence of it, so a recurrence after it cleared is new again. */
export interface InboxEntry {
	key: string;
	level: InboxLevel;
}

/** localStorage array of acknowledged inbox entry keys; opening the inbox acknowledges every listed entry. */
export const INBOX_SEEN_KEY = "ottr.inbox.seen";

export function loadInboxSeen(): Set<string> {
	try {
		const raw = JSON.parse(localStorage.getItem(INBOX_SEEN_KEY) ?? "[]");
		return new Set(
			Array.isArray(raw)
				? raw.filter((k): k is string => typeof k === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

export function saveInboxSeen(seen: ReadonlySet<string>): void {
	localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify([...seen]));
}

/** Occurrence key of a needs_you card: a new ask round is a new entry. */
export function taskEntryKey(t: Pick<TaskCard, "id" | "asked">): string {
	return `task:${t.id}:${t.asked === null ? "needs" : JSON.stringify(t.asked)}`;
}

/** The bell only complains once a pending alate import has waited this long. */
export const ALATE_PENDING_AFTER_MS = 30 * 60_000;

/** Inbox key of the pending-import advisory: null while no episode runs or it is inside the
 *  threshold; the since stamp is the episode id, so one episode files exactly one entry. */
export function alatePendingEntry(
	since: number | null,
	now: number,
): string | null {
	return since !== null && now - since > ALATE_PENDING_AFTER_MS
		? `alate-pending:${since}`
		: null;
}

// One place owns the urgency order; inboxView picks the most urgent level from it.
const LEVELS: readonly InboxLevel[] = ["crit", "needs", "asked", "info"];

/** What the bar bell shows. `fresh` = unacknowledged entries; lit while any is fresh; `level` is the
 *  most urgent fresh entry's level when lit, else the most urgent of all; null when there are none. */
export function inboxView(
	entries: readonly InboxEntry[],
	seen: ReadonlySet<string>,
): {
	total: number;
	fresh: InboxEntry[];
	lit: boolean;
	level: InboxLevel | null;
} {
	const fresh = entries.filter((e) => !seen.has(e.key));
	const pool = fresh.length > 0 ? fresh : entries;
	return {
		total: entries.length,
		fresh,
		lit: fresh.length > 0,
		level: LEVELS.find((l) => pool.some((e) => e.level === l)) ?? null,
	};
}

/** Drops acknowledgements whose entry cleared, so a recurrence counts as new again; `pending` keeps
 *  keys whose source has not loaded yet. Returns `seen` itself when nothing drops (no re-render). */
export function pruneSeen(
	seen: ReadonlySet<string>,
	live: ReadonlySet<string>,
	pending: (key: string) => boolean = () => false,
): ReadonlySet<string> {
	const kept = [...seen].filter((k) => live.has(k) || pending(k));
	return kept.length === seen.size ? seen : new Set(kept);
}
