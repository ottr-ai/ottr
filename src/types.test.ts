import { expect, test } from "bun:test";
import { answeredCard, askQuestions, type OutcomeStatus } from "./types.ts";

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
		},
	]);
});
