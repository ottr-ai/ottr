import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { turnLogStart } from "./turnlog.ts";

const iso = (at: number): string => new Date(at).toISOString();
const header = (kind: "work" | "merge", at: number): string =>
	`== ${kind} turn ${iso(at)}`;

describe("turnLogStart", () => {
	const T1 = Date.UTC(2026, 10, 4, 10, 1, 6, 180);
	const T2 = Date.UTC(2026, 10, 4, 11, 34, 59, 884);
	// The OTTR-466 shape: an earlier work turn the user stopped, then the running turn.
	const twoTurnLog = [
		header("work", T1),
		"- earlier turn line A",
		"- earlier turn line B",
		"supervisor: requeued the card", // between turns: stays in the earlier section
		header("merge", T2),
		"- the running turn's own first line",
		"- the running turn's own second line",
	].join("\n");

	test("a turn started after the second header slices at the second header", () => {
		const at = turnLogStart(twoTurnLog, T2 + 5_000);
		expect(at).toBe(twoTurnLog.indexOf(header("merge", T2)));
		expect(twoTurnLog.slice(at ?? 0)).toBe(
			[
				header("merge", T2),
				"- the running turn's own first line",
				"- the running turn's own second line",
			].join("\n"),
		);
	});

	test("an earlier turn slices at the first header while a later header exists", () => {
		const at = turnLogStart(twoTurnLog, T1 + 1_000);
		expect(at).toBe(twoTurnLog.indexOf(header("work", T1)));
		expect(twoTurnLog.slice(at ?? 0)).toStartWith(header("work", T1));
	});

	test("a header written after startedAt never matches", () => {
		expect(turnLogStart(twoTurnLog, T1 - 1)).toBeNull();
		expect(turnLogStart(header("work", T2), T2 - 1)).toBeNull();
	});

	test("a timestamp equal to startedAt matches", () => {
		expect(turnLogStart(header("work", T2), T2)).toBe(0);
	});

	test("a header line with trailing text is not a header", () => {
		const log = `${header("work", T1)}\n== merge turn ${iso(T1 + 1)} (crashed)`;
		expect(turnLogStart(log, T1 + 5_000)).toBe(0);
	});

	test("a header named mid-line is not a header", () => {
		const log = `supervisor: echoed == work turn ${iso(T1)}\n${header("work", T1 + 1)}`;
		expect(turnLogStart(log, T1 + 5_000)).toBe(
			log.indexOf(header("work", T1 + 1)),
		);
	});

	test("an unparseable timestamp is skipped", () => {
		const log = `== work turn not-a-timestamp\n${header("merge", T2)}`;
		expect(turnLogStart(log, T2 + 1)).toBe(log.indexOf(header("merge", T2)));
	});

	// Reference: walk the lines, accept a header only when its text round-trips through
	// toISOString (rejects trailing junk) and it starts the line (rejects mid-line hits).
	const reference = (text: string, startedAt: number): number | null => {
		const lines = text.split("\n");
		let at: number | null = null;
		let offset = 0;
		for (const line of lines) {
			const m = /^== (?:work|merge) turn (.+)$/.exec(line);
			if (m?.[1] !== undefined) {
				const ts = Date.parse(m[1]);
				if (!Number.isNaN(ts) && iso(ts) === m[1] && ts <= startedAt)
					at = offset;
			}
			offset += line.length + 1;
		}
		return at;
	};

	test("agrees with a line-walking reference on generated logs", () => {
		const junk = fc.constantFrom(
			"- agent output",
			"supervisor: stopped leftover process",
			"",
			`supervisor: echoed == work turn ${iso(T1)}`,
			`== merge turn ${iso(T2)} (crashed)`,
			" == work turn indented",
			"== work turn not-a-timestamp",
		);
		const stamps = fc
			.integer({ min: 0, max: 40 })
			.map((n) => Date.UTC(2026, 10, 4, 12, 0, 0) + n * 60_000);
		const logArb = fc
			.array(
				fc.record({ at: stamps, junk: fc.array(junk, { maxLength: 3 }) }),
				{
					minLength: 0,
					maxLength: 6,
				},
			)
			.map((blocks) =>
				blocks
					.flatMap((b) => [
						header(b.at % 2 === 0 ? "work" : "merge", b.at),
						...b.junk,
					])
					.join("\n"),
			);
		const startedArb = fc.integer({
			min: Date.UTC(2026, 10, 4, 11, 0, 0),
			max: Date.UTC(2026, 10, 4, 13, 0, 0),
		});
		const prop = fc.property(logArb, startedArb, (text, startedAt) => {
			expect(turnLogStart(text, startedAt)).toBe(reference(text, startedAt));
		});
		fc.assert(prop, { seed: 466, numRuns: 150 });
	});
});
