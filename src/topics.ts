// Dependency-free by contract: store.ts imports this, never the reverse.

// A Set, not a plain object: on Record<string, true>, STOPLIST["constructor"] resolves to
// Object.prototype.constructor and silently stoplists the word (R4-13).
const STOPLIST = new Set(
	"a an the and or but if then than that this these those there here it its is are was were be been being am do does did doing have has had having i we you your my our me he she they them their as at by for from in into of on onto to with without within about above below over under again further once not no nor only own same so too very can will just should now also could may might must shall would please make made add added adding use used using fix fixed fixing when what which who whom whose why how all any both each few more most other some such get got set lets let new old via per etc thing things task tasks board card cards column columns view views button buttons icon icons color colors style css ui app apps page pages way ways lot bit small big great good better best nice clean simple work works working need needs needed want wants wanted keep kept change changed update updated show shows shown display try tried move moved split still every two one first second next before after while during through against between out up down off question questions answer answers ask asks asking behaviour behavior current currently possible possibly maybe probably like seem seems integrate integrated implement implemented improve improved replace replaced remove removed open opened click clicking top bottom left right main middle center centre side instead anyway however already yet yes done ottr project make use".split(
		/\s+/,
	),
);

/** Lowercase terms worth indexing: >=3 chars, not a pure number, not stoplisted; one trailing `s` stripped. */
function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9+#-]+/)
		.filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPLIST.has(t))
		.map((t) =>
			t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t,
		);
}

/**
 * Deterministic corpus clustering: each row gets the highest-df term it contains
 * (df >= 3, ties by term asc), or null. A row's term set weights session-title
 * tokens double against the title. ponytail: O(rows x terms), full rescans are
 * fine at board scale; a real corpus pass only pays off past thousands of cards.
 */
export function assignTopics(
	rows: { id: string; title: string; sessionTitle: string | null }[],
): Map<string, string | null> {
	const rowTerms = rows.map((row) => {
		const weights = new Map<string, number>();
		for (const [text, weight] of [
			[row.title, 1],
			[row.sessionTitle, 2],
		] as const) {
			if (text === null) continue;
			for (const term of new Set(tokens(text)))
				weights.set(term, (weights.get(term) ?? 0) + weight);
		}
		return weights;
	});
	const df = new Map<string, number>();
	for (const weights of rowTerms)
		for (const [term, weight] of weights)
			df.set(term, (df.get(term) ?? 0) + weight);
	const rank = new Map(
		[...df.entries()]
			.filter(([, d]) => d >= 3)
			.sort(([a, da], [b, db]) => db - da || (a < b ? -1 : a > b ? 1 : 0))
			.map(([term], i) => [term, i] as const),
	);
	const out = new Map<string, string | null>();
	for (const [i, row] of rows.entries()) {
		let best: string | null = null;
		let bestRank = Infinity;
		for (const term of rowTerms[i]!.keys()) {
			const r = rank.get(term);
			if (r !== undefined && r < bestRank) {
				best = term;
				bestRank = r;
			}
		}
		out.set(row.id, best);
	}
	return out;
}

/** Topic sections for the board: top 10 by member count desc then label asc; the rest plus unclassified rows ride in a final "Everything else" section. */
export function groupTopics<T extends { topic: string | null }>(
	tasks: T[],
): { key: string; label: string; tasks: T[] }[] {
	const byKey = new Map<string, { key: string; label: string; tasks: T[] }>();
	for (const t of tasks) {
		const key = t.topic?.trim().toLowerCase() ?? "";
		if (key === "") continue;
		let section = byKey.get(key);
		if (section === undefined) {
			section = { key, label: t.topic!.trim(), tasks: [] };
			byKey.set(key, section);
		}
		section.tasks.push(t);
	}
	const sorted = [...byKey.values()].sort(
		(a, b) => b.tasks.length - a.tasks.length || (a.label < b.label ? -1 : 1),
	);
	const sections = sorted.slice(0, 10);
	const other = [
		...sorted.slice(10).flatMap((s) => s.tasks),
		...tasks.filter((t) => (t.topic?.trim().toLowerCase() ?? "") === ""),
	];
	if (other.length > 0)
		sections.push({ key: "other", label: "Everything else", tasks: other });
	return sections;
}
