// Optimistic task creation (OTTR-1337): the New task dialog closes on submit and a
// placeholder card holds the todo lane until the server's card arrives. Pure helpers,
// so the board wiring in app.tsx stays thin and the rules stay unit-tested.

/** A viewport rect: the dialog the placeholder morphs out of. */
export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** One create request in flight, from submit until its real card renders or the POST fails. */
export interface PendingCreate {
	/** Client key, unique per page load; the placeholder's `data-pending-key`. */
	key: string;
	project: string;
	text: string;
	model: string;
	/** The image data the POST sent. */
	images: string[];
	/** The attached files, so a failed create can restore them into the reopened dialog. */
	files: File[];
	/** The server's id once the POST answered; null while it runs. */
	id: string | null;
	/** The POST failed: the placeholder plays its exit, then drops. */
	failed: boolean;
	/** Where the dialog sat at submit; null skips the morph. */
	from: Rect | null;
}

/** The placeholder's title: the prompt's first non-empty line, cut to the card's length. */
export function placeholderTitle(text: string, max = 140): string {
	const line =
		text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l !== "") ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One card's identity: ids are unique per project only (two projects can derive one
 * prefix, e.g. alpha and alphabet both ALPH), so every match keys on both. */
const cardKey = (project: string, id: string): string => `${project}\n${id}`;

/**
 * Pairs each create with its real card, keyed by the create's client key. A placeholder
 * pairs only through its own request: once the POST answered with an id and the state
 * carries that id in the create's own project. No other card (another tab's, one with the same first line) ever
 * stands in for it, so an unanswered create keeps its placeholder.
 */
export function pairCreates(
	pending: readonly PendingCreate[],
	tasks: readonly { id: string; project: string }[],
): Map<string, string> {
	const cards = new Set(tasks.map((t) => cardKey(t.project, t.id)));
	const pairs = new Map<string, string>();
	for (const p of pending)
		if (p.id !== null && cards.has(cardKey(p.project, p.id)))
			pairs.set(p.key, p.id);
	return pairs;
}

/** The placeholders one project draws: its creates with no paired card yet. A failed one
 * stays while its exit plays. */
export function projectPlaceholders(
	pending: readonly PendingCreate[],
	project: string,
	pairs: ReadonlyMap<string, string>,
): PendingCreate[] {
	return pending.filter((p) => p.project === project && !pairs.has(p.key));
}

/** Keys of the creates whose card the state now carries in their own project: they are
 * done and drop. */
export function settledKeys(
	pending: readonly PendingCreate[],
	tasks: readonly { id: string; project: string }[],
): Set<string> {
	return new Set(pairCreates(pending, tasks).keys());
}

/**
 * The real cards that replace a placeholder in this render, with the offset back to the
 * placeholder's spot (FLIP). A zero offset still lists the card: the swap is in place, so
 * the board must not play the fresh-card entrance on it.
 */
export function placeholderFlights(
	pairs: ReadonlyMap<string, string>,
	prev: ReadonlyMap<string, { left: number; top: number }>,
	next: ReadonlyMap<string, { left: number; top: number }>,
): Map<string, { dx: number; dy: number }> {
	const flights = new Map<string, { dx: number; dy: number }>();
	for (const [key, id] of pairs) {
		const from = prev.get(key);
		const to = next.get(id);
		if (from === undefined || to === undefined || next.has(key)) continue;
		flights.set(id, { dx: from.left - to.left, dy: from.top - to.top });
	}
	return flights;
}
