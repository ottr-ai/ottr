/**
 * The release line gate (docs/specs/release-line-gate.md): wait for a release line to settle
 * before taking a version. One pure module holds the rule; the omp watch's bumpTarget and
 * the bun.lock release line check both use it, so nothing here imports the watcher.
 */

export type RegistryRelease = {
	version: string; // registry version string; stable is exactly x.y.z
	publishedAt: number; // publish time, ms epoch
	deprecated?: boolean;
};

const STABLE_RE = /^\d+\.\d+\.\d+$/;

/** Numeric x.y.z order; both sides must be stable x.y.z. Moved here from src/ompWatch.ts. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** A release counts when it is stable and not deprecated. */
const counts = (r: RegistryRelease): boolean =>
	STABLE_RE.test(r.version) && r.deprecated !== true;

const isAged = (r: RegistryRelease, now: number, ageMs: number): boolean =>
	now - r.publishedAt >= ageMs;

const lineKey = (version: string): string =>
	version.split(".").slice(0, 2).join(".");

/** The counted releases grouped by release line, in input order per line. */
function linesOf(releases: RegistryRelease[]): Map<string, RegistryRelease[]> {
	const lines = new Map<string, RegistryRelease[]>();
	for (const r of releases) {
		const line = lines.get(lineKey(r.version)) ?? [];
		line.push(r);
		lines.set(lineKey(r.version), line);
	}
	return lines;
}

/** The oldest counted release of a line's aged ones, by version order. */
const oldestAged = (
	line: RegistryRelease[],
	now: number,
	ageMs: number,
): RegistryRelease =>
	line
		.filter((r) => isAged(r, now, ageMs))
		.reduce((a, b) => (compareVersions(a.version, b.version) < 0 ? a : b));

/** The rule above; result is the pick's version string or null (keep the current). */
export function settledLineTarget(
	releases: RegistryRelease[],
	now: number,
	ageMs: number,
	capMs: number,
	maxVersion?: string,
): string | null {
	const counted = releases.filter(counts);
	const lines = linesOf(counted);
	// The cap: a line waits when it holds an aged counted release and a counted release
	// younger than ageMs. When any waited line's wait exceeds capMs, the pick falls back
	// to today's behavior: the newest aged counted release, or null when none.
	for (const line of lines.values()) {
		const aged = line.filter((r) => isAged(r, now, ageMs));
		if (aged.length === 0 || aged.length === line.length) continue;
		if (now - oldestAged(line, now, ageMs).publishedAt <= capMs) continue;
		const fallback = counted.filter((r) => isAged(r, now, ageMs));
		if (fallback.length === 0) return null;
		const newest = fallback.reduce((a, b) =>
			compareVersions(a.version, b.version) > 0 ? a : b,
		);
		return newest.version;
	}
	// The newest settled candidate; maxVersion bounds the candidates only.
	let pick: RegistryRelease | undefined;
	for (const r of counted) {
		if (maxVersion !== undefined && compareVersions(r.version, maxVersion) > 0)
			continue;
		if (!isAged(r, now, ageMs)) continue;
		const blocked = lines
			.get(lineKey(r.version))!
			.some(
				(b) =>
					compareVersions(b.version, r.version) > 0 && !isAged(b, now, ageMs),
			);
		if (blocked) continue;
		if (pick === undefined || compareVersions(r.version, pick.version) > 0)
			pick = r;
	}
	return pick?.version ?? null;
}

/** The newest counted release above `version` in its line that is younger than ageMs,
 * or null when the line is settled above `version`. The script's report names it. */
export function unsettledBlocker(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
): RegistryRelease | null {
	let blocker: RegistryRelease | null = null;
	for (const r of releases) {
		if (!counts(r)) continue;
		if (lineKey(r.version) !== lineKey(version)) continue;
		if (compareVersions(r.version, version) <= 0) continue;
		if (isAged(r, now, ageMs)) continue;
		if (blocker === null || compareVersions(r.version, blocker.version) > 0)
			blocker = r;
	}
	return blocker;
}

/** True when `version`'s line's wait exceeds capMs, measured from the oldest aged counted
 * release at or above `version` in that line (the cap definition above; `version` is the
 * candidate floor, for the script the installed version). */
export function lineCapReached(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): boolean {
	const line = releases
		.filter(counts)
		.filter(
			(r) =>
				lineKey(r.version) === lineKey(version) &&
				compareVersions(r.version, version) >= 0,
		);
	const aged = line.filter((r) => isAged(r, now, ageMs));
	// No aged counted release at or above the floor: the wait has not started.
	// A line with no young counted release waits for nothing.
	if (aged.length === 0 || aged.length === line.length) return false;
	return now - oldestAged(line, now, ageMs).publishedAt > capMs;
}
