import { describe, expect, test } from "bun:test";
import { mergeProjectOrder, orderBy, rankInOrder } from "./projectOrder.ts";
import fc from "./test/properties.ts";

describe("orderBy", () => {
	test("a known order applies", () => {
		expect(orderBy(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});

	test("names missing from the order follow the known ones in input order", () => {
		expect(orderBy(["x", "a", "y", "b"], ["b", "a"])).toEqual([
			"b",
			"a",
			"x",
			"y",
		]);
	});

	test("an empty order returns the input unchanged", () => {
		expect(orderBy(["b", "a"], [])).toEqual(["b", "a"]);
	});

	test("always a permutation of the input, and idempotent under its own order", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string()),
				fc.array(fc.string()),
				(names, order) => {
					const out = orderBy(names, order);
					expect([...out].sort()).toEqual([...names].sort());
					expect(orderBy(out, order)).toEqual(out);
				},
			),
		);
	});
});

describe("mergeProjectOrder", () => {
	test("a full order comes back unchanged", () => {
		expect(mergeProjectOrder(["b", "c", "a"], ["a", "b", "c"])).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	test("registered names missing from the order append in their own order", () => {
		expect(mergeProjectOrder(["c"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
	});

	test("an empty order falls back to the known order", () => {
		expect(mergeProjectOrder([], ["a", "b"])).toEqual(["a", "b"]);
	});

	test("always a permutation of the known names that starts with exactly the order", () => {
		fc.assert(
			fc.property(
				fc.shuffledSubarray(["a", "b", "c", "d"], {
					minLength: 0,
					maxLength: 4,
				}),
				(order) => {
					const known = ["a", "b", "c", "d"];
					const out = mergeProjectOrder(order, known);
					expect([...out].sort()).toEqual(known);
					expect(out.slice(0, order.length)).toEqual(order);
				},
			),
		);
	});
});

describe("rankInOrder", () => {
	test("a listed name ranks at its index", () => {
		expect(rankInOrder("b", ["a", "b"])).toBe(1);
	});

	test("an unlisted name ranks after every listed one", () => {
		expect(rankInOrder("x", ["a", "b"])).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("sorting by the rank is the same reorder orderBy produces", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string()),
				fc.array(fc.string()),
				(names, order) => {
					const byRank = [...names].sort(
						(a, b) => rankInOrder(a, order) - rankInOrder(b, order),
					);
					expect(byRank).toEqual(orderBy(names, order));
				},
			),
		);
	});
});
