// Clocks and stamps for card faces and the drawer. All inputs are epoch milliseconds.

/** Relative age, rounding down to the largest unit (Atlassian date-time guidance). */
export function age(ms: number, now: number = Date.now()): string {
	const min = (now - ms) / 60000;
	if (min < 1) return "just now";
	if (min < 60) return `${Math.floor(min)}m ago`;
	if (min < 1440) return `${Math.floor(min / 60)}h ago`;
	return `${Math.floor(min / 1440)}d ago`;
}

/** Time left until a future stamp, two units at most: "now", "42m", "3h 12m", "2d 5h". */
export function until(ms: number, now: number = Date.now()): string {
	const min = Math.floor((ms - now) / 60000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	if (min < 1440) return `${Math.floor(min / 60)}h ${min % 60}m`;
	return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

/** Done cards: relative age for the first week, then a short locale date stamp. */
export function landed(ms: number, now: number = Date.now()): string {
	if (now - ms < 7 * 86400000) return age(ms, now);
	const d = new Date(ms);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return d.toLocaleDateString(
		undefined,
		sameYear
			? { month: "short", day: "numeric" }
			: { year: "numeric", month: "short", day: "numeric" },
	);
}

/** Elapsed duration, two units at most: "42s", "59m", "3h 12m", "2d 5h". */
export function duration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min}m`;
	if (min < 1440) return `${Math.floor(min / 60)}h ${min % 60}m`;
	return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

/** Drawer turn chip: the same duration format, or "running" while the turn is live. */
export function turnDuration(t: {
	startedAt: number;
	endedAt: number | null;
}): string {
	if (t.endedAt === null) return "running";
	return duration(Math.max(0, t.endedAt - t.startedAt));
}

/** Short exact stamp for the drawer chips, e.g. "28 Sep, 15:04". */
export function stamp(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
}
