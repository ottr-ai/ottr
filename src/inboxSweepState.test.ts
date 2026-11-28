import { expect, test } from "bun:test";
import {
	newSweepState,
	parseSweepState,
	type SweepState,
} from "./inboxSweepState.ts";
import fc from "./test/properties.ts";

const verdict = fc.record({
	cardId: fc.integer({ min: 1, max: 10000 }).map((n) => `P-${n}`),
	verdict: fc.constantFrom(
		"done" as const,
		"partial" as const,
		"none" as const,
		"info" as const,
	),
	evidence: fc.string(),
	drafts: fc.array(fc.string(), { maxLength: 4 }),
});

test("saved sweep state preserves batch, verdict data, and receipt delivery across a round trip", () => {
	fc.assert(
		fc.property(
			fc.uniqueArray(verdict, { selector: (v) => v.cardId, maxLength: 10 }),
			fc.boolean(),
			(verdicts, delivered) => {
				const state: SweepState = {
					batch: verdicts.map((v) => v.cardId),
					verdicts,
					filedDrafts: [...new Set(verdicts.flatMap((v) => v.drafts))],
					applications: verdicts.map((v) => ({
						card: v.cardId,
						action: "implement",
						doneAt: 123,
						delivered,
					})),
				};
				expect(parseSweepState(JSON.stringify(state))).toEqual(state);
			},
		),
	);
});

test("invalid persisted state cannot become an empty batch or an approval", () => {
	fc.assert(
		fc.property(fc.jsonValue(), (value) => {
			const invalid = {
				...newSweepState(["P-1"]),
				applications: [
					{
						card: "P-2",
						action: "clear",
						completionKey: "P-2@1",
						delivered: value,
					},
				],
			};
			expect(() => parseSweepState(JSON.stringify(invalid))).toThrow(
				"Invalid inbox sweep application",
			);
		}),
	);
	const state = newSweepState(["P-1"]);
	state.verdicts = [
		{ cardId: "P-2", verdict: "done", evidence: "foreign card", drafts: [] },
	];
	expect(() => parseSweepState(JSON.stringify(state))).toThrow(
		"Invalid inbox sweep verdict",
	);
	for (const text of [
		"null",
		"{}",
		'{"batch":[],"filedDrafts":[],"verdicts":[],"applications":false}',
	])
		expect(() => parseSweepState(text)).toThrow("Invalid inbox sweep state");
});

test("a persisted receipt cannot supply another card's completion key", () => {
	const state = newSweepState(["P-1"]);
	state.verdicts = [
		{
			cardId: "P-1",
			verdict: "done",
			evidence: "The child is done.",
			drafts: [],
		},
	];
	const text = JSON.stringify({
		...state,
		applications: [
			{
				card: "P-1",
				action: "clear",
				completionKey: "P-2@123",
				delivered: false,
			},
		],
	});
	expect(() => parseSweepState(text)).toThrow(
		"Invalid inbox sweep application",
	);
});
