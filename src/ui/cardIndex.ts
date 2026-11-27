import type { CardRef } from "../types.ts";

/** Every card of every project, bucketed by card id (OTTR-1255). Ids are unique per
 * project, not across projects, so one id can hold several entries; the lookups pick
 * by project. Built from StateResponse.allCards per frame; never a rendered list. */
export type CardIndex = Map<string, CardRef[]>;

/** Bucket `allCards` by card id, one pass. */
export function buildCardIndex(allCards: CardRef[]): CardIndex {
	const index: CardIndex = new Map();
	for (const c of allCards) {
		const bucket = index.get(c.id);
		if (bucket === undefined) index.set(c.id, [c]);
		else bucket.push(c);
	}
	return index;
}

/** The one entry with this id and project, else null. */
export function lookupCardIn(
	index: CardIndex,
	id: string,
	project: string,
): CardRef | null {
	return index.get(id)?.find((c) => c.project === project) ?? null;
}

/** The first entry with this id in any project, else null. */
export function lookupCard(index: CardIndex, id: string): CardRef | null {
	return index.get(id)?.[0] ?? null;
}
