import { describe, expect, test } from "bun:test";
import { age, duration, landed, stamp, turnDuration, until } from "./time.ts";

// Fixed "now": 2026-09-28 12:00:00 UTC.
const NOW = 1790683200000;
const MIN = 60000;
const DAY = 86400000;

describe("age", () => {
	test("steps through just now, minutes, hours, days, rounding down", () => {
		expect(age(NOW - 30 * 1000, NOW)).toBe("just now");
		expect(age(NOW - 17 * MIN, NOW)).toBe("17m ago");
		expect(age(NOW - 90 * MIN, NOW)).toBe("1h ago");
		expect(age(NOW - 26 * 3600000, NOW)).toBe("1d ago");
	});
});

describe("until", () => {
	test("counts down in at most two units, flooring, and says now once due", () => {
		expect(until(NOW + 30 * 1000, NOW)).toBe("now");
		expect(until(NOW - 5 * MIN, NOW)).toBe("now");
		expect(until(NOW + 59 * MIN, NOW)).toBe("59m");
		expect(until(NOW + 60 * MIN, NOW)).toBe("1h 0m");
		expect(until(NOW + 3 * 3600000 + 12 * MIN + 59000, NOW)).toBe("3h 12m");
		expect(until(NOW + DAY - MIN, NOW)).toBe("23h 59m");
		expect(until(NOW + 2 * DAY + 5 * 3600000 + 59 * MIN, NOW)).toBe("2d 5h");
	});
});

describe("landed", () => {
	test("stays relative for the first week", () => {
		expect(landed(NOW - 3 * 3600000, NOW)).toBe("3h ago");
		expect(landed(NOW - 6 * DAY - 23 * 3600000, NOW)).toBe("6d ago");
	});
	test("flips to a date stamp after 7 days, adding the year only when it differs", () => {
		const week = landed(NOW - 7 * DAY, NOW);
		expect(week).not.toMatch(/ago$/);
		expect(week).toMatch(/\d/);
		const lastYear = landed(NOW - 400 * DAY, NOW);
		expect(lastYear).not.toMatch(/ago$/);
		expect(lastYear).toMatch(
			new RegExp(String(new Date(NOW - 400 * DAY).getFullYear())),
		);
	});
});

describe("duration", () => {
	test("renders elapsed time in at most two units, flooring", () => {
		expect(duration(500)).toBe("0s");
		expect(duration(42 * 1000)).toBe("42s");
		expect(duration(3 * MIN + 20000)).toBe("3m");
		expect(duration(3 * 3600000 + 12 * MIN + 59000)).toBe("3h 12m");
		expect(duration(2 * DAY + 5 * 3600000 + 59 * MIN)).toBe("2d 5h");
	});
});

describe("turnDuration", () => {
	test("says running while the turn is live, else the shared duration format", () => {
		expect(turnDuration({ startedAt: NOW, endedAt: null })).toBe("running");
		expect(turnDuration({ startedAt: NOW, endedAt: NOW + 42 * 1000 })).toBe(
			"42s",
		);
		expect(
			turnDuration({
				startedAt: NOW,
				endedAt: NOW + 75 * MIN + 3 * 1000,
			}),
		).toBe("1h 15m");
		// A stamp glitch never renders a negative duration.
		expect(turnDuration({ startedAt: NOW + 1000, endedAt: NOW })).toBe("0s");
	});
});

describe("stamp", () => {
	test("renders a short exact stamp without seconds, in the machine locale", () => {
		const s = stamp(NOW);
		expect(s).toMatch(/\d{1,2}:\d{2}$/); // hour:minute at the end
		expect(s).not.toMatch(/\d{2}:\d{2}:\d{2}/); // no seconds section
		expect(s).toMatch(/\d/); // a day digit is present
	});
});
