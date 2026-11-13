import { describe, expect, test } from "bun:test";
import {
	compareVersions,
	lineCapReached,
	type RegistryRelease,
	releaseLineAccepts,
	settledLineTarget,
	unsettledBlocker,
} from "./releaseLine.ts";
import fc from "./test/properties.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const AGE = 7 * DAY;
const CAP = 14 * DAY;

/** A registry release `ageDays` old at NOW; `deprecated` is the packument's flag. */
function rel(
	version: string,
	ageDays: number,
	deprecated?: boolean,
): RegistryRelease {
	return { version, publishedAt: NOW - ageDays * DAY, deprecated };
}

describe("compareVersions", () => {
	test("orders numerically, not as text", () => {
		expect(compareVersions("18.10.0", "18.9.0")).toBeGreaterThan(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});
});

describe("settledLineTarget", () => {
	test("a younger counted release in the line blocks the aged one", () => {
		expect(
			settledLineTarget([rel("1.2.0", 8), rel("1.2.5", 2)], NOW, AGE, CAP),
		).toBeNull();
	});

	test("a release at exactly the age gate settles its line", () => {
		expect(
			settledLineTarget([rel("1.2.0", 30), rel("1.2.5", 7)], NOW, AGE, CAP),
		).toBe("1.2.5");
	});

	test("the cap falls back after 14 days of waiting, not at exactly 14", () => {
		expect(
			settledLineTarget([rel("1.2.0", 15), rel("1.2.5", 2)], NOW, AGE, CAP),
		).toBe("1.2.0");
		expect(
			settledLineTarget([rel("1.2.0", 14), rel("1.2.5", 2)], NOW, AGE, CAP),
		).toBeNull();
	});

	test("a younger prerelease counts nothing and blocks nothing", () => {
		expect(
			settledLineTarget(
				[rel("1.2.5", 7), rel("1.2.6-beta.1", 1)],
				NOW,
				AGE,
				CAP,
			),
		).toBe("1.2.5");
	});

	test("an older settled line is still the target while the newest line waits", () => {
		expect(
			settledLineTarget(
				[rel("1.1.9", 30), rel("1.2.0", 8), rel("1.2.5", 2)],
				NOW,
				AGE,
				CAP,
			),
		).toBe("1.1.9");
	});

	test("a deprecated release counts nothing and blocks nothing", () => {
		expect(
			settledLineTarget(
				[rel("1.2.0", 8), rel("1.2.5", 2, true)],
				NOW,
				AGE,
				CAP,
			),
		).toBe("1.2.0");
	});
});

describe("unsettledBlocker", () => {
	test("names the newest counted release above the version younger than the gate", () => {
		const releases = [rel("1.2.0", 30), rel("1.2.3", 3), rel("1.2.5", 2)];
		expect(unsettledBlocker(releases, "1.2.0", NOW, AGE)).toEqual(
			rel("1.2.5", 2),
		);
	});

	test("a settled line has no blocker; a prerelease above never blocks", () => {
		expect(
			unsettledBlocker([rel("1.2.0", 30), rel("1.2.5", 7)], "1.2.0", NOW, AGE),
		).toBeNull();
		expect(
			unsettledBlocker(
				[rel("1.2.5", 7), rel("1.2.6-beta.1", 1)],
				"1.2.5",
				NOW,
				AGE,
			),
		).toBeNull();
	});
});

describe("lineCapReached", () => {
	test("true only past capMs, and only for a line that waits", () => {
		const releases = [rel("1.2.0", 15), rel("1.2.5", 2)];
		expect(lineCapReached(releases, "1.2.0", NOW, AGE, CAP)).toBe(true);
		expect(lineCapReached(releases, "1.2.0", NOW, AGE, 15 * DAY)).toBe(false);
		// A line with no young counted release waits for nothing.
		expect(
			lineCapReached(
				[rel("1.2.0", 15), rel("1.2.5", 9)],
				"1.2.0",
				NOW,
				AGE,
				CAP,
			),
		).toBe(false);
		// A line with no aged counted release has no wait to measure.
		expect(
			lineCapReached(
				[rel("1.2.0", 6), rel("1.2.5", 2)],
				"1.2.0",
				NOW,
				AGE,
				CAP,
			),
		).toBe(false);
	});

	test("the wait counts from the oldest aged candidate at or above the floor", () => {
		// A line that started years ago below the installed version is not a wait.
		const releases = [rel("1.2.0", 730), rel("1.2.20", 10), rel("1.2.21", 2)];
		expect(lineCapReached(releases, "1.2.20", NOW, AGE, CAP)).toBe(false);
		expect(lineCapReached(releases, "1.2.0", NOW, AGE, CAP)).toBe(true);
		// The unsettled class on the same fixture: the young candidate above the pin.
		expect(unsettledBlocker(releases, "1.2.20", NOW, AGE)).toEqual(
			rel("1.2.21", 2),
		);
	});
});

describe("releaseLineAccepts", () => {
	test("the line-wide cap lifts the whole line's wait or none of it", () => {
		// 20 days of waiting: the cap accepts both aged releases of the line.
		const old = [rel("1.0.1", 20), rel("1.0.2", 9), rel("1.0.3", 2)];
		expect(releaseLineAccepts(old, "1.0.1", NOW, AGE, CAP)).toBe(true);
		expect(releaseLineAccepts(old, "1.0.2", NOW, AGE, CAP)).toBe(true);
		// 12 days: the wait is on, the cap is not reached, both stay blocked.
		const young = [rel("1.0.1", 12), rel("1.0.2", 9), rel("1.0.3", 2)];
		expect(releaseLineAccepts(young, "1.0.1", NOW, AGE, CAP)).toBe(false);
		expect(releaseLineAccepts(young, "1.0.2", NOW, AGE, CAP)).toBe(false);
	});
});

describe("settledLineTarget properties", () => {
	const version = fc.constantFrom(
		"1.1.9",
		"1.2.0",
		"1.2.5",
		"1.2.6-beta.1",
		"1.10.0",
		"2.0.0",
		"2.0.1-rc.1",
		"10.0.3",
	);
	const release = fc.record({
		version,
		publishedAt: fc.integer({ min: 0, max: 10 * DAY }),
		deprecated: fc.option(fc.boolean(), { nil: undefined }),
	});
	const registry = fc.array(release, { maxLength: 12 });
	const now = 10 * DAY;

	test("the pick is always a counted, aged release or null", () => {
		fc.assert(
			fc.property(
				registry,
				fc.integer({ min: 1, max: 5 * DAY }),
				fc.integer({ min: 0, max: 20 * DAY }),
				(releases, ageMs, capMs) => {
					const pick = settledLineTarget(releases, now, ageMs, capMs);
					if (pick === null) return;
					// Duplicates of one version may differ in deprecated, so any match counts.
					const ok = releases.some(
						(r) =>
							r.version === pick &&
							/^\d+\.\d+\.\d+$/.test(r.version) &&
							r.deprecated !== true &&
							now - r.publishedAt >= ageMs,
					);
					expect(ok).toBe(true);
				},
			),
		);
	});

	test("with the cap disabled the pick is never a blocked release", () => {
		fc.assert(
			fc.property(
				registry,
				fc.integer({ min: 1, max: 5 * DAY }),
				(releases, ageMs) => {
					const pick = settledLineTarget(
						releases,
						now,
						ageMs,
						Number.POSITIVE_INFINITY,
					);
					if (pick === null) return;
					const blocked = releases.some(
						(b) =>
							/^\d+\.\d+\.\d+$/.test(b.version) &&
							b.deprecated !== true &&
							b.version.split(".").slice(0, 2).join(".") ===
								pick.split(".").slice(0, 2).join(".") &&
							compareVersions(b.version, pick) > 0 &&
							now - b.publishedAt < ageMs,
					);
					expect(blocked).toBe(false);
				},
			),
		);
	});
});
