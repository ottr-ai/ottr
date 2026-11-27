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
	/** Every task id the state held at submit: a card outside it is new since the submit. */
	before: ReadonlySet<string>;
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

/**
 * What one project's board renders for the creates in flight.
 * `cards`: the placeholders to draw, a failed one included while its exit plays; a create
 * whose card the state already carries draws none, so the two never show at once.
 * `held`: the project's cards the board holds back. A live frame can carry the new card
 * before the POST answers with its id; while any create runs unanswered, a card new since
 * its submit stays hidden, unless an answered create already claims it.
 */
export function pendingBoard(
	pending: readonly PendingCreate[],
	project: string,
	tasks: readonly { id: string; project: string }[],
): { cards: PendingCreate[]; held: Set<string> } {
	const ids = new Set(tasks.map((t) => t.id));
	const mine = pending.filter((p) => p.project === project);
	const cards = mine.filter((p) => p.id === null || !ids.has(p.id));
	const claimed = new Set(mine.map((p) => p.id).filter((id) => id !== null));
	const held = new Set<string>();
	for (const p of mine) {
		if (p.id !== null || p.failed) continue;
		for (const t of tasks)
			if (t.project === project && !p.before.has(t.id) && !claimed.has(t.id))
				held.add(t.id);
	}
	return { cards, held };
}

/** Keys of the creates whose card the state now carries: they are done and drop. */
export function settledKeys(
	pending: readonly PendingCreate[],
	taskIds: ReadonlySet<string>,
): Set<string> {
	const keys = new Set<string>();
	for (const p of pending)
		if (p.id !== null && taskIds.has(p.id)) keys.add(p.key);
	return keys;
}

/**
 * The real cards that replace a placeholder in this render, with the offset back to the
 * placeholder's spot (FLIP). A zero offset still lists the card: the swap is in place, so
 * the board must not play the fresh-card entrance on it.
 */
export function placeholderFlights(
	pending: readonly PendingCreate[],
	prev: ReadonlyMap<string, { left: number; top: number }>,
	next: ReadonlyMap<string, { left: number; top: number }>,
): Map<string, { dx: number; dy: number }> {
	const flights = new Map<string, { dx: number; dy: number }>();
	for (const p of pending) {
		if (p.id === null) continue;
		const from = prev.get(p.key);
		const to = next.get(p.id);
		if (from === undefined || to === undefined || next.has(p.key)) continue;
		flights.set(p.id, { dx: from.left - to.left, dy: from.top - to.top });
	}
	return flights;
}
