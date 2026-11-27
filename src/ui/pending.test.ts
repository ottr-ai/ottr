import { expect, test } from "bun:test";
import {
	type PendingCreate,
	pendingBoard,
	placeholderFlights,
	placeholderTitle,
	settledKeys,
} from "./pending.ts";

const create = (over: Partial<PendingCreate>): PendingCreate => ({
	key: "p1",
	project: "alpha",
	text: "Fix the login redirect",
	model: "",
	images: [],
	files: [],
	before: new Set(["AL-1"]),
	id: null,
	failed: false,
	from: null,
	...over,
});

const task = (id: string, project = "alpha") => ({ id, project });
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

// --- pendingBoard -----------------------------------------------------------

test("pendingBoard draws the placeholder while the POST runs", () => {
	const p = create({});
	const { cards } = pendingBoard([p], "alpha", [task("AL-1")]);
	expect(cards).toEqual([p]);
});

test("pendingBoard still draws an answered create until the state carries its card", () => {
	const p = create({ id: "AL-9" });
	expect(pendingBoard([p], "alpha", [task("AL-1")]).cards).toEqual([p]);
});

test("pendingBoard draws no placeholder once the tasks carry its id", () => {
	const p = create({ id: "AL-9" });
	const { cards, held } = pendingBoard([p], "alpha", [
		task("AL-1"),
		task("AL-9"),
	]);
	expect(cards).toEqual([]);
	// The real card shows: nothing is held back.
	expect(held).toEqual(new Set());
});

test("pendingBoard keeps a failed create in cards while its exit plays", () => {
	const p = create({ failed: true });
	const { cards, held } = pendingBoard([p], "alpha", [
		task("AL-1"),
		task("AL-7"),
	]);
	expect(cards).toEqual([p]);
	// A failed create holds nothing: a new card from elsewhere shows at once.
	expect(held).toEqual(new Set());
});

test("pendingBoard holds a card new since the submit while the create is unanswered", () => {
	const p = create({ before: new Set(["AL-1"]) });
	const { held } = pendingBoard([p], "alpha", [task("AL-1"), task("AL-9")]);
	expect(held).toEqual(new Set(["AL-9"]));
});

test("pendingBoard releases the held card once the create is answered", () => {
	const p = create({ id: "AL-9" });
	expect(pendingBoard([p], "alpha", [task("AL-1"), task("AL-9")]).held).toEqual(
		new Set(),
	);
	// Answered with another id: the stray new card is not held either.
	const q = create({ id: "AL-10" });
	expect(pendingBoard([q], "alpha", [task("AL-1"), task("AL-9")]).held).toEqual(
		new Set(),
	);
});

test("pendingBoard never holds a card that an answered create claims", () => {
	const answered = create({
		key: "a",
		id: "AL-9",
		before: new Set(["AL-1"]),
	});
	const running = create({ key: "b", before: new Set(["AL-1"]) });
	const { cards, held } = pendingBoard([answered, running], "alpha", [
		task("AL-1"),
		task("AL-9"),
		task("AL-10"),
	]);
	// AL-9 belongs to the answered create; AL-10 may be the running one's card.
	expect(held).toEqual(new Set(["AL-10"]));
	expect(cards).toEqual([running]);
});

test("pendingBoard ignores creates of other projects", () => {
	const beta = create({ project: "beta", before: new Set(["BE-1"]) });
	const { cards, held } = pendingBoard([beta], "alpha", [
		task("AL-1"),
		task("AL-9"),
	]);
	expect(cards).toEqual([]);
	expect(held).toEqual(new Set());
});

test("pendingBoard holds only the board's own project's new cards", () => {
	const p = create({ before: new Set(["AL-1"]) });
	const { held } = pendingBoard([p], "alpha", [
		task("AL-1"),
		task("AL-9"),
		task("BE-5", "beta"),
	]);
	expect(held).toEqual(new Set(["AL-9"]));
});

test("pendingBoard draws nothing and holds nothing with no creates", () => {
	expect(pendingBoard([], "alpha", [task("AL-1")])).toEqual({
		cards: [],
		held: new Set(),
	});
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

test("placeholderFlights gives the offset from the real card back to the placeholder", () => {
	const p = create({ key: "p1", id: "AL-9" });
	const flights = placeholderFlights(
		[p],
		new Map([["p1", at(100, 400)]]),
		new Map([["AL-9", at(40, 100)]]),
	);
	expect(flights).toEqual(new Map([["AL-9", { dx: 60, dy: 300 }]]));
});

test("placeholderFlights lists an in-place swap with a zero offset", () => {
	const p = create({ key: "p1", id: "AL-9" });
	const flights = placeholderFlights(
		[p],
		new Map([["p1", at(20, 30)]]),
		new Map([["AL-9", at(20, 30)]]),
	);
	expect(flights).toEqual(new Map([["AL-9", { dx: 0, dy: 0 }]]));
});

test("placeholderFlights skips a create the server has not answered", () => {
	const p = create({ key: "p1", id: null });
	expect(
		placeholderFlights(
			[p],
			new Map([["p1", at(0, 0)]]),
			new Map([["AL-9", at(10, 10)]]),
		),
	).toEqual(new Map());
});

test("placeholderFlights skips a create whose placeholder was never measured", () => {
	const p = create({ key: "p1", id: "AL-9" });
	expect(
		placeholderFlights(
			[p],
			new Map([["other", at(0, 0)]]),
			new Map([["AL-9", at(10, 10)]]),
		),
	).toEqual(new Map());
});

test("placeholderFlights skips a create whose real card is not rendered yet", () => {
	const p = create({ key: "p1", id: "AL-9" });
	expect(
		placeholderFlights(
			[p],
			new Map([["p1", at(0, 0)]]),
			new Map([["AL-1", at(10, 10)]]),
		),
	).toEqual(new Map());
});

test("placeholderFlights skips a create whose placeholder is still on screen", () => {
	const p = create({ key: "p1", id: "AL-9" });
	expect(
		placeholderFlights(
			[p],
			new Map([["p1", at(0, 0)]]),
			new Map([
				["p1", at(0, 0)],
				["AL-9", at(10, 10)],
			]),
		),
	).toEqual(new Map());
});

test("placeholderFlights flies each landed create from its own placeholder", () => {
	const flights = placeholderFlights(
		[
			create({ key: "p1", id: "AL-9" }),
			create({ key: "p2", id: "AL-10" }),
			create({ key: "p3", id: null }),
		],
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
