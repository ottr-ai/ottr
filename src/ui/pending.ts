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
 * Pairs each create with the real card that stands for it, keyed by the create's key.
 * The pairing never hides a real card: it only decides which placeholders still draw.
 * - An answered create pairs with its own id, once the state carries that card.
 * - An unanswered create can meet its card first: a live frame can carry the card before
 *   the POST answers. It then pairs, in submit order, with the oldest card of its project
 *   that is new since its submit and that no other create or settled create claims. A
 *   wrong guess (another tab's card) only hides this placeholder early; the POST answer
 *   corrects it.
 * `taken`: ids of creates that already settled and dropped; they never pair again.
 */
export function pairCreates(
	pending: readonly PendingCreate[],
	tasks: readonly { id: string; project: string; createdAt: number }[],
	taken: ReadonlySet<string>,
): Map<string, string> {
	const ids = new Set(tasks.map((t) => t.id));
	const pairs = new Map<string, string>();
	const claimed = new Set(taken);
	for (const p of pending)
		if (p.id !== null) {
			claimed.add(p.id);
			if (ids.has(p.id)) pairs.set(p.key, p.id);
		}
	const oldest = [...tasks].sort((a, b) => a.createdAt - b.createdAt);
	for (const p of pending) {
		if (p.id !== null || p.failed) continue;
		const hit = oldest.find(
			(t) =>
				t.project === p.project && !p.before.has(t.id) && !claimed.has(t.id),
		);
		if (hit === undefined) continue;
		claimed.add(hit.id);
		pairs.set(p.key, hit.id);
	}
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
