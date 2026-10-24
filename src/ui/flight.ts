/** Measured position of one rendered card, keyed by task id. */
export interface CardPos {
	stage: string;
	left: number;
	top: number;
}

interface Flight {
	dx: number;
	dy: number;
}

/** Cards whose stage changed between two board renders, with the offset back to their old spot (FLIP). */
export function stageFlights(
	prev: Map<string, CardPos>,
	next: Map<string, CardPos>,
): Map<string, Flight> {
	const flights = new Map<string, Flight>();
	for (const [id, pos] of next) {
		const old = prev.get(id);
		if (old === undefined || old.stage === pos.stage) continue;
		const dx = old.left - pos.left;
		const dy = old.top - pos.top;
		if (dx !== 0 || dy !== 0) flights.set(id, { dx, dy });
	}
	return flights;
}

/** Task ids absent from the seen set; null seen (first render) animates nothing, so a page load stays still. */
export function freshTaskIds(
	seen: ReadonlySet<string> | null,
	tasks: readonly { id: string }[],
): Set<string> {
	const fresh = new Set<string>();
	if (seen === null) return fresh;
	for (const t of tasks) if (!seen.has(t.id)) fresh.add(t.id);
	return fresh;
}

/**
 * Cards that changed place inside one column's list, with the vertical offset back to their old
 * spot (FLIP). Empty unless the order changed: layout-only shifts (the drag gap, a resize) keep the
 * order and must not slide.
 */
export function listSlides(
	prev: Map<string, number>,
	next: Map<string, number>,
): Map<string, number> {
	const slides = new Map<string, number>();
	if ([...prev.keys()].join(" ") === [...next.keys()].join(" ")) return slides;
	for (const [id, top] of next) {
		const before = prev.get(id);
		if (before === undefined) continue;
		const dy = before - top;
		if (Math.abs(dy) >= 1) slides.set(id, dy);
	}
	return slides;
}
