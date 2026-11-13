import { describe, expect, test } from "bun:test";

import { assignTopics } from "./topics.ts";

const row = (
	id: string,
	title: string,
	sessionTitle: string | null = null,
) => ({
	id,
	title,
	sessionTitle,
});

describe("assignTopics", () => {
	test("a candidate needs df >= 3; plurals normalize into the same term", () => {
		const topics = assignTopics([
			row("a", "alpha beta"),
			row("b", "alpha gamma"),
			row("c", "alphas delta"), // plural folds onto "alpha"
			row("d", "gamma delta"),
		]);
		expect(topics.get("a")).toBe("alpha");
		expect(topics.get("b")).toBe("alpha");
		expect(topics.get("c")).toBe("alpha");
		expect(topics.get("d")).toBeNull(); // gamma and delta only reach df 2
	});

	test("stopwords never become labels", () => {
		const topics = assignTopics([
			row("a", "fix the thing"),
			row("b", "fix the thing"),
			row("c", "fix the other thing"),
		]);
		expect([...topics.values()].every((label) => label === null)).toBe(true);
	});

	// Regression for R4-13: on a Record<string, true> stoplist, STOPLIST["constructor"] hit
	// Object.prototype.constructor, so the real word "constructor" was silently stoplisted.
	test("the word 'constructor' is indexable, not a prototype leak", () => {
		const topics = assignTopics([
			row("a", "constructor injection setup", "constructor injection setup"),
			row("b", "constructor injection tests", "constructor injection tests"),
			row(
				"c",
				"constructor injection cleanup",
				"constructor injection cleanup",
			),
		]);
		// df(constructor) = 9 with session titles, ties "injection" and wins alphabetically.
		expect(topics.get("a")).toBe("constructor");
		expect(topics.get("b")).toBe("constructor");
		expect(topics.get("c")).toBe("constructor");
	});

	test("session titles count twice toward df", () => {
		const topics = assignTopics([
			row("a", "unrelated words here", "sigma"),
			row("b", "different words too", "sigma"),
		]);
		// df(sigma) = 2 + 2 = 4; without the doubling it would be 2 and both stay null.
		expect(topics.get("a")).toBe("sigma");
		expect(topics.get("b")).toBe("sigma");
	});

	test("a row takes its highest-df candidate, ties by term asc", () => {
		const topics = assignTopics([
			row("a", "auth login"),
			row("b", "auth login"),
			row("c", "auth login"),
		]);
		// Both hit df 3; the alphabetical tie puts auth first for every row.
		expect(topics.get("a")).toBe("auth");
		expect(topics.get("b")).toBe("auth");
		expect(topics.get("c")).toBe("auth");
	});

	test("deterministic: row order does not change any label", () => {
		const rows = [
			row("a", "kappa lambda", "kappa"),
			row("b", "kappa sigma"),
			row("c", "lambda sigma", "sigma nu"),
			row("d", "xi omicron"),
		];
		expect(assignTopics(rows)).toEqual(assignTopics([...rows].reverse()));
		expect(assignTopics(rows)).toEqual(
			new Map([
				["a", "kappa"],
				["b", "kappa"],
				["c", "sigma"],
				["d", null],
			]),
		);
	});
});
