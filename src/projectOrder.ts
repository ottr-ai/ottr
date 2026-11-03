/** Project display order: pure policy behind POST /api/projects/order and the /api/state
 *  project sort. Own module because the mutate set keeps the route wiring in src/app.ts and
 *  the .tsx render trees out of mutation; policy lives in a tested, mutated module instead
 *  (stryker.config.mjs "Not mutated, on purpose"). */

/** Stable reorder of `names` by index in `order`; names missing from `order` keep their
 *  input relative order after all known ones (the server appends unknown names the same way). */
export function orderBy(
	names: readonly string[],
	order: readonly string[],
): string[] {
	const rank = new Map<string, number>();
	for (const [i, name] of order.entries()) rank.set(name, i);
	const known: string[] = [];
	const unknown: string[] = [];
	for (const name of names) (rank.has(name) ? known : unknown).push(name);
	const last = order.length;
	known.sort((a, b) => (rank.get(a) ?? last) - (rank.get(b) ?? last));
	return [...known, ...unknown];
}

/** The stored order merged over every registered name: the saved order first, registered
 *  names missing from it appended in their own order. `order` must be duplicate-free and
 *  hold only known names — the route validates that; mergeProjectOrder stays total. */
export function mergeProjectOrder(
	order: readonly string[],
	known: readonly string[],
): string[] {
	return orderBy(known, order);
}

/** Sort rank for one name: its index in `order`, else after every listed name. */
export function rankInOrder(name: string, order: readonly string[]): number {
	const i = order.indexOf(name);
	return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
