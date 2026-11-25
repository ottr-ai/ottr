import { expect, test } from "bun:test";
import fc from "fast-check";
import {
	answeredCard,
	askAnswerParts,
	askAnswerWithNote,
	askQuestions,
	type OutcomeStatus,
} from "./types.ts";

const turn = (kind: "work" | "merge", outcome: OutcomeStatus | null) => ({
	kind,
	outcome,
});

test("answeredCard: the last work turn decides", () => {
	expect(answeredCard([])).toBe(false);
	expect(answeredCard([turn("work", "answered")])).toBe(true);
	// A merge turn after the answer does not change it.
	expect(answeredCard([turn("work", "answered"), turn("merge", "ready")])).toBe(
		true,
	);
	// A later follow-up work turn replaces the answer.
	expect(answeredCard([turn("work", "answered"), turn("work", "ready")])).toBe(
		false,
	);
	// Still running: no outcome yet.
	expect(answeredCard([turn("work", null)])).toBe(false);
});

test("askQuestions: recommended remaps through dropped invalid options", () => {
	// Invalid entry before the recommended one shifts kept indexes.
	expect(
		askQuestions({
			questions: [
				{
					question: "q",
					options: ["junk", { label: "a" }, { label: "b" }],
					recommended: 2,
				},
			],
		}),
	).toEqual([
		{
			question: "q",
			options: [{ label: "a" }, { label: "b" }],
			multi: false,
			recommended: 1,
			text: false,
		},
	]);
	// Recommended option itself dropped -> null, never a wrong pick.
	expect(
		askQuestions({
			questions: [
				{
					question: "q",
					options: [{ label: "a" }, "junk", { label: "b" }],
					recommended: 1,
				},
			],
		}),
	).toEqual([
		{
			question: "q",
			options: [{ label: "a" }, { label: "b" }],
			multi: false,
			recommended: null,
			text: false,
		},
	]);
	// No invalid options: index passes through unchanged.
	expect(
		askQuestions({
			questions: [
				{
					question: "q",
					options: [{ label: "a" }, { label: "b" }],
					recommended: 1,
				},
			],
		}),
	).toEqual([
		{
			question: "q",
			options: [{ label: "a" }, { label: "b" }],
			multi: false,
			recommended: 1,
			text: false,
		},
	]);
	// Out of range stays null.
	expect(
		askQuestions({
			questions: [{ question: "q", options: [{ label: "a" }], recommended: 5 }],
		}),
	).toEqual([
		{
			question: "q",
			options: [{ label: "a" }],
			multi: false,
			recommended: null,
			text: false,
		},
	]);
	// Negative and missing stay null too.
	expect(
		askQuestions({
			questions: [
				{ question: "q", options: [{ label: "a" }], recommended: -1 },
			],
		}),
	).toEqual([
		{
			question: "q",
			options: [{ label: "a" }],
			multi: false,
			recommended: null,
			text: false,
		},
	]);
	expect(
		askQuestions({ questions: [{ question: "q", options: [{ label: "a" }] }] }),
	).toEqual([
		{
			question: "q",
			options: [{ label: "a" }],
			multi: false,
			recommended: null,
			text: false,
		},
	]);
});

test("askQuestions: a mixed form normalizes choice, multi and text questions", () => {
	expect(
		askQuestions({
			questions: [
				{
					question: "Pick one",
					options: [{ label: "a" }, { label: "b" }],
					recommended: 0,
				},
				{ question: "Pick many", options: [{ label: "x" }], multi: true },
				{ question: "Type it" },
			],
		}),
	).toEqual([
		{
			question: "Pick one",
			options: [{ label: "a" }, { label: "b" }],
			multi: false,
			recommended: 0,
			text: false,
		},
		{
			question: "Pick many",
			options: [{ label: "x" }],
			multi: true,
			recommended: null,
			text: false,
		},
		{
			question: "Type it",
			options: [],
			multi: false,
			recommended: null,
			text: true,
		},
	]);
});

test("askQuestions: options absent or not an array is a text question", () => {
	// multi:true with no options: the text form wins.
	for (const q of [
		{ question: "Type" },
		{ question: "Type", options: "nope" },
		{ question: "Type", options: 42, multi: true },
	]) {
		expect(askQuestions({ questions: [q] })).toEqual([
			{
				question: "Type",
				options: [],
				multi: false,
				recommended: null,
				text: true,
			},
		]);
	}
});

test("askQuestions: every option unusable falls back to a text question", () => {
	// Invalid entries are still dropped, and with nothing left multi/recommended
	// drop with them: the text form wins.
	expect(
		askQuestions({
			questions: [
				{
					question: "q",
					options: ["junk", 42, {}, { label: 7 }],
					multi: true,
					recommended: 1,
				},
				{ question: "empty", options: [] },
			],
		}),
	).toEqual([
		{ question: "q", options: [], multi: false, recommended: null, text: true },
		{
			question: "empty",
			options: [],
			multi: false,
			recommended: null,
			text: true,
		},
	]);
});

test("askQuestions: no usable question yields null", () => {
	expect(askQuestions({ questions: [] })).toBeNull();
	// A question without a usable string is dropped even when it carries options.
	expect(
		askQuestions({
			questions: [{ options: [{ label: "a" }] }, { question: 42 }],
		}),
	).toBeNull();
	expect(askQuestions({ questions: "nope" })).toBeNull();
	expect(askQuestions({ questions: undefined })).toBeNull();
	expect(askQuestions({})).toBeNull();
	expect(askQuestions(null)).toBeNull();
});

// Gate: 150 runs, fixed seed. fast-check prints the seed and path on failure.
test("property: askQuestions never throws, keeps the text invariant and is idempotent", () => {
	const junkEntry = fc.constantFrom(
		"junk",
		42,
		null,
		{},
		{ noLabel: "x" },
		{ label: 7 },
	);
	const entry = fc.oneof(
		fc.record({ label: fc.string() }),
		fc.record({ label: fc.string(), description: fc.string() }),
		junkEntry,
	);
	const rawQuestion = fc.oneof(
		// choice question, sometimes multi/recommended
		fc.record({
			question: fc.string({ minLength: 1 }),
			options: fc.array(entry, { maxLength: 6 }),
			multi: fc.boolean(),
			recommended: fc.integer({ min: -1, max: 6 }),
		}),
		// text question: options absent
		fc.record({ question: fc.string({ minLength: 1 }) }),
		// malformed shapes: unusable question or unusable options
		fc.record({
			question: fc.constantFrom(42, null, ""),
			options: fc.constantFrom("nope", 3, null),
		}),
	);
	fc.assert(
		fc.property(fc.array(rawQuestion, { maxLength: 5 }), (questions) => {
			const out = askQuestions({ questions });
			if (out === null) return;
			for (const q of out) {
				expect(q.text).toBe(q.options.length === 0);
				if (q.multi) expect(q.text).toBe(false);
				if (q.text) {
					expect(q.multi).toBe(false);
					expect(q.recommended).toBeNull();
				}
			}
			// Idempotence: the normalized form renormalizes to itself.
			expect(askQuestions({ questions: out })).toEqual(out);
		}),
		{ seed: 20261120, numRuns: 150 },
	);
});

test("askAnswerWithNote: a blank note adds nothing, a note rides on its own line", () => {
	expect(askAnswerWithNote("Postgres", "  ")).toBe("Postgres");
	expect(askAnswerWithNote("Postgres", " use v17 ")).toBe(
		"Postgres\nNote: use v17",
	);
	expect(askAnswerParts("Postgres")).toEqual({ pick: "Postgres", note: "" });
	// A pick that holds separator-like text stays whole (OTTR-1281 send-back 2).
	expect(askAnswerParts("A — note: legacy")).toEqual({
		pick: "A — note: legacy",
		note: "",
	});
	expect(askAnswerParts(askAnswerWithNote("A\nNote: x", ""))).toEqual({
		pick: "A\nNote: x",
		note: "",
	});
});

// Gate: 150 runs, fixed seed. fast-check prints the seed and path on failure.
test("property: askAnswerParts splits askAnswerWithNote back into any pick and its folded note", () => {
	const text = fc.oneof(
		fc.string(),
		fc.constantFrom("\nNote: ", "x\nNote: y", " — note: ", "\n"),
	);
	fc.assert(
		fc.property(text, text, (p, n) => {
			const { pick: back, note } = askAnswerParts(askAnswerWithNote(p, n));
			expect(back).toBe(p);
			expect(note).toBe(n.replace(/\n/g, " ").trim());
		}),
		{
			seed: 20261125,
			numRuns: 150,
			examples: [
				["A", "x\nNote: y"],
				["A\nNote: x", ""],
				["A — note: legacy", "z"],
			],
		},
	);
});
