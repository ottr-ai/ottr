import { expect, test } from "bun:test";
import {
	type PendingCreate,
	pairCreates,
	placeholderFlights,
	placeholderTitle,
	projectPlaceholders,
	settledKeys,
} from "./pending.ts";

const create = (over: Partial<PendingCreate>): PendingCreate => ({
	key: "p1",
	project: "alpha",
	text: "Fix the login redirect",
	model: "",
	images: [],
	files: [],
	id: null,
	failed: false,
	from: null,
	...over,
});

// The default title matches the default create's prompt: pairing must ignore titles.
const task = (
	id: string,
	project = "alpha",
	createdAt = 0,
	title = "Fix the login redirect",
) => ({
	id,
	project,
	createdAt,
	title,
});
const at = (left: number, top: number) => ({ left, top });

// --- placeholderTitle -------------------------------------------------------

test("placeholderTitle takes the first non-empty line, trimmed", () => {
	expect(placeholderTitle("\n   \n  Fix the login  \nsecond line")).toBe(
		"Fix the login",
	);
	expect(placeholderTitle("only line")).toBe("only line");
});

test("placeholderTitle of blank text is empty", () => {
	expect(placeholderTitle("")).toBe("");
	expect(placeholderTitle(" \n\t\n ")).toBe("");
});

test("placeholderTitle cuts a long line to max characters ending in …", () => {
	expect(placeholderTitle("abcdefghij", 5)).toBe("abcd…");
	// Exactly max stays whole.
	expect(placeholderTitle("abcde", 5)).toBe("abcde");
	// The default cut is 140 characters.
	const long = "x".repeat(141);
	const cut = placeholderTitle(long);
	expect(cut.length).toBe(140);
	expect(cut).toBe(`${"x".repeat(139)}…`);
	expect(placeholderTitle("x".repeat(140))).toBe("x".repeat(140));
});

test("placeholderTitle measures the trimmed line, not the padding", () => {
	expect(placeholderTitle("   abcde   ", 5)).toBe("abcde");
});

// --- pairCreates ------------------------------------------------------------

test("pairCreates pairs an answered create only once the state carries its id", () => {
	const p = create({ id: "AL-9" });
	expect(pairCreates([p], [task("AL-1")])).toEqual(new Map());
	expect(pairCreates([p], [task("AL-1"), task("AL-9")])).toEqual(
		new Map([["p1", "AL-9"]]),
	);
});

test("pairCreates pairs an answered create with its own id, never with another new card", () => {
	const p = create({ id: "AL-10" });
	expect(pairCreates([p], [task("AL-1"), task("AL-9", "alpha", 5)])).toEqual(
		new Map(),
	);
});

test("pairCreates never pairs an unanswered create, even with a new card titled as its prompt", () => {
	// Another tab's card of the same project, new since submit, titled exactly as this
	// prompt's first line: only the create's own answer may pair it.
	const p = create({ text: "Ship the lane\nwith the details below" });
	expect(
		pairCreates(
			[p],
			[
				task("AL-1"),
				task("AL-7", "alpha", 3, "Ship the lane"),
				task("AL-9", "alpha", 10, "Ship the lane"),
			],
		),
	).toEqual(new Map());
});

test("pairCreates pairs two creates that share a first line only with their own answered ids", () => {
	const a = create({ key: "a", text: "Ship the lane\nfirst body", id: "AL-9" });
	const b = create({ key: "b", text: "Ship the lane\nsecond body" });
	const tasks = [
		task("AL-1"),
		task("AL-9", "alpha", 5, "Ship the lane"),
		task("AL-10", "alpha", 6, "Ship the lane"),
	];
	expect(pairCreates([a, b], tasks)).toEqual(new Map([["a", "AL-9"]]));
	// Submit order does not matter either.
	expect(pairCreates([b, a], tasks)).toEqual(new Map([["a", "AL-9"]]));
});

test("pairCreates never pairs a failed create", () => {
	const failed = create({ key: "f", failed: true });
	expect(
		pairCreates([failed], [task("AL-1"), task("AL-9", "alpha", 5)]),
	).toEqual(new Map());
});

test("pairCreates is empty with no creates", () => {
	expect(pairCreates([], [task("AL-1"), task("AL-9")])).toEqual(new Map());
});

// --- projectPlaceholders ----------------------------------------------------

test("projectPlaceholders keeps the project's unpaired creates, failed ones included", () => {
	const matched = create({ key: "a" });
	const running = create({ key: "b" });
	const beta = create({ key: "c", project: "beta" });
	const failed = create({ key: "d", failed: true });
	expect(
		projectPlaceholders(
			[matched, running, beta, failed],
			"alpha",
			new Map([["a", "AL-9"]]),
		),
	).toEqual([running, failed]);
	expect(
		projectPlaceholders([matched, running, beta, failed], "beta", new Map()),
	).toEqual([beta]);
	expect(projectPlaceholders([], "alpha", new Map())).toEqual([]);
});

// --- settledKeys ------------------------------------------------------------

test("settledKeys names only creates whose id the state carries", () => {
	const keys = settledKeys(
		[
			create({ key: "landed", id: "AL-9" }),
			create({ key: "running", id: null }),
			create({ key: "answered", id: "AL-10" }),
			create({ key: "failed", id: null, failed: true }),
		],
		new Set(["AL-1", "AL-9"]),
	);
	expect(keys).toEqual(new Set(["landed"]));
});

test("settledKeys is empty for an empty state", () => {
	expect(settledKeys([create({ id: "AL-9" })], new Set())).toEqual(new Set());
});

// --- placeholderFlights -----------------------------------------------------

const paired = new Map([["p1", "AL-9"]]);

test("placeholderFlights gives the offset from the real card back to the placeholder", () => {
	const flights = placeholderFlights(
		paired,
		new Map([["p1", at(100, 400)]]),
		new Map([["AL-9", at(40, 100)]]),
	);
	expect(flights).toEqual(new Map([["AL-9", { dx: 60, dy: 300 }]]));
	// The sign follows the direction back to the placeholder.
	expect(
		placeholderFlights(
			paired,
			new Map([["p1", at(40, 100)]]),
			new Map([["AL-9", at(100, 400)]]),
		),
	).toEqual(new Map([["AL-9", { dx: -60, dy: -300 }]]));
});

test("placeholderFlights lists an in-place swap with a zero offset", () => {
	const flights = placeholderFlights(
		paired,
		new Map([["p1", at(20, 30)]]),
		new Map([["AL-9", at(20, 30)]]),
	);
	expect(flights).toEqual(new Map([["AL-9", { dx: 0, dy: 0 }]]));
});

test("placeholderFlights skips a create with no paired card", () => {
	expect(
		placeholderFlights(
			new Map(),
			new Map([["p1", at(0, 0)]]),
			new Map([["AL-9", at(10, 10)]]),
		),
	).toEqual(new Map());
});

test("placeholderFlights skips a create whose placeholder was never measured", () => {
	expect(
		placeholderFlights(
			paired,
			new Map([["other", at(0, 0)]]),
			new Map([["AL-9", at(10, 10)]]),
		),
	).toEqual(new Map());
});

test("placeholderFlights skips a create whose real card is not rendered yet", () => {
	expect(
		placeholderFlights(
			paired,
			new Map([["p1", at(0, 0)]]),
			new Map([["AL-1", at(10, 10)]]),
		),
	).toEqual(new Map());
});

test("placeholderFlights skips a create whose placeholder is still on screen", () => {
	expect(
		placeholderFlights(
			paired,
			new Map([["p1", at(0, 0)]]),
			new Map([
				["p1", at(0, 0)],
				["AL-9", at(10, 10)],
			]),
		),
	).toEqual(new Map());
});

test("placeholderFlights flies each paired card from its own placeholder", () => {
	const flights = placeholderFlights(
		new Map([
			["p1", "AL-9"],
			["p2", "AL-10"],
		]),
		new Map([
			["p1", at(0, 100)],
			["p2", at(0, 200)],
			["p3", at(0, 300)],
		]),
		new Map([
			["AL-9", at(0, 150)],
			["AL-10", at(300, 200)],
		]),
	);
	expect(flights).toEqual(
		new Map([
			["AL-9", { dx: 0, dy: -50 }],
			["AL-10", { dx: -300, dy: 0 }],
		]),
	);
});
