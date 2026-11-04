/** Turn-section slicing for the drawer's Work steps log: an expanded turn shows its own
 * output, not the whole card log. "Full log" is the escape hatch that shows everything. */

/** One `== work turn <ISO>` / `== merge turn <ISO>` header line, exactly as runTurn writes
 * it (line start, nothing before or after, millisecond ISO timestamp). */
const TURN_HEADER =
	/^== (?:work|merge) turn (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/gm;

/**
 * Character index where the named turn's own section starts in its card log text, or null
 * when the log holds no header of that turn. runTurn writes the header just before the
 * turn row lands, so this turn's header is the last one dated no later than startedAt;
 * the next turn's header is always dated after this turn's startedAt. Board lines written
 * before that header stay in the earlier section; everything from the header on belongs
 * to this turn, including the supervisor lines written while it runs.
 */
export function turnLogStart(text: string, startedAt: number): number | null {
	let at: number | null = null;
	for (const m of text.matchAll(TURN_HEADER)) {
		const stamp = m[1];
		if (stamp === undefined) continue;
		const ts = Date.parse(stamp);
		if (!Number.isNaN(ts) && ts <= startedAt) at = m.index;
	}
	return at;
}
