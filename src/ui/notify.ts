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

/** Inbox entry level, most urgent first: a failed action, a stalled task, an open question, a notice. */
export type InboxLevel = "crit" | "needs" | "asked" | "info";

/** One inbox row. `key` names this occurrence of it, so a recurrence after it cleared is new again. */
export interface InboxEntry {
	key: string;
	level: InboxLevel;
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

/** Keys this tab asks the server to drop from the shared seen set: acknowledgements whose
 *  entry cleared, so a recurrence counts as new. The server prunes task:, done: and error:
 *  keys itself. crit: and notice: entries live in one tab only, so another tab's absence
 *  proves nothing: a tab drops such a key only when it showed the entry itself and lost it.
 *  `localShown` is this tab's memory of the browser-local keys it showed; it is updated here.
 *  behind: keys wait until the update data loaded. */
export function seenToDrop(
	serverSeen: readonly string[],
	current: ReadonlySet<string>,
	localShown: Set<string>,
	updateLoaded: boolean,
): string[] {
	const local = (k: string) => /^(crit|notice):/.test(k);
	for (const k of current) if (local(k)) localShown.add(k);
	const seen = new Set(serverSeen);
	const kept = pruneSeen(
		seen,
		current,
		(k) =>
			/^(task|done|error):/.test(k) ||
			(local(k) && !localShown.has(k)) ||
			(!updateLoaded && k.startsWith("behind:")),
	);
	for (const k of localShown) if (!current.has(k)) localShown.delete(k);
	return kept === seen ? [] : serverSeen.filter((k) => !kept.has(k));
}
