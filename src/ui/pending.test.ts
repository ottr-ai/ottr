import { expect, test } from "bun:test";
import { deriveTitle } from "../title.ts";
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
	before: new Set(["AL-1"]),
	id: null,
	failed: false,
	from: null,
	...over,
});

// The default title is the one the server gives the default create's text, so a
// test that only varies ids, projects or ages keeps every card a title match.
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
	expect(pairCreates([p], [task("AL-1")], new Set())).toEqual(new Map());
	expect(pairCreates([p], [task("AL-1"), task("AL-9")], new Set())).toEqual(
		new Map([["p1", "AL-9"]]),
	);
});

test("pairCreates pairs an answered create with its own id, never with another new card", () => {
	const p = create({ id: "AL-10" });
	expect(
		pairCreates([p], [task("AL-1"), task("AL-9", "alpha", 5)], new Set()),
	).toEqual(new Map());
});

test("pairCreates pairs an unanswered create with the oldest new card of its own project", () => {
	const p = create({});
	const pairs = pairCreates(
		[p],
		[
			task("AL-1"),
			task("AL-12", "alpha", 30),
			task("BE-5", "beta", 5),
			task("AL-9", "alpha", 10),
		],
		new Set(),
	);
	expect(pairs).toEqual(new Map([["p1", "AL-9"]]));
});

test("pairCreates never pairs an unanswered create with a new card titled for another prompt", () => {
	// Another tab's task lands while this create runs: same project, new since
	// submit, unclaimed, but not this prompt's card.
	const p = create({});
	expect(
		pairCreates(
			[p],
			[task("AL-1"), task("AL-7", "alpha", 3, "Another tab's task")],
			new Set(),
		),
	).toEqual(new Map());
});

test("pairCreates pairs an unanswered create with its title match even when an unrelated card is older", () => {
	const p = create({});
	expect(
		pairCreates(
			[p],
			[
				task("AL-1"),
				task("AL-7", "alpha", 3, "Another tab's task"),
				task("AL-9", "alpha", 10),
			],
			new Set(),
		),
	).toEqual(new Map([["p1", "AL-9"]]));
});

test("pairCreates matches the title the server derives from a multi-line or headed prompt", () => {
	const multiLine = "\n  Ship the lane  \nwith the details below";
	const headed =
		"# Goal\nMove the retry button into the drawer\n\n# Acceptance\nIt shows";
	for (const text of [multiLine, headed]) {
		// Older decoys titled with the whole prompt and with its raw first line: only the
		// server's own title for this prompt pairs.
		const trimmed = text.trim();
		expect(
			pairCreates(
				[create({ text })],
				[
					task("AL-1"),
					task("AL-7", "alpha", 2, trimmed),
					task("AL-8", "alpha", 3, trimmed.split("\n")[0]),
					task("AL-9", "alpha", 10, deriveTitle(trimmed)),
				],
				new Set(),
			),
		).toEqual(new Map([["p1", "AL-9"]]));
	}
});

test("pairCreates never pairs a card that was on the board at submit", () => {
	const p = create({ before: new Set(["AL-1", "AL-9"]) });
	expect(
		pairCreates([p], [task("AL-1"), task("AL-9", "alpha", 5)], new Set()),
	).toEqual(new Map());
});

test("pairCreates never pairs a card that another create's id claims", () => {
	// The answered create comes later in submit order: its claim still holds.
	const running = create({ key: "a" });
	const answered = create({ key: "b", id: "AL-9" });
	expect(
		pairCreates(
			[running, answered],
			[task("AL-1"), task("AL-9", "alpha", 5)],
			new Set(),
		),
	).toEqual(new Map([["b", "AL-9"]]));
	// The running create skips the older card the later answered create claims.
	expect(
		pairCreates(
			[running, create({ key: "b", id: "AL-10" })],
			[task("AL-1"), task("AL-10", "alpha", 5), task("AL-11", "alpha", 9)],
			new Set(),
		),
	).toEqual(
		new Map([
			["b", "AL-10"],
			["a", "AL-11"],
		]),
	);
});

test("pairCreates never pairs a card of a settled create", () => {
	const p = create({});
	expect(
		pairCreates(
			[p],
			[task("AL-1"), task("AL-9", "alpha", 5)],
			new Set(["AL-9"]),
		),
	).toEqual(new Map());
});

test("pairCreates never pairs a card of another project", () => {
	const p = create({});
	expect(
		pairCreates([p], [task("AL-1"), task("BE-5", "beta", 5)], new Set()),
	).toEqual(new Map());
});

test("pairCreates pairs two unanswered creates with two different cards in submit order", () => {
	const a = create({ key: "a" });
	const b = create({ key: "b" });
	expect(
		pairCreates(
			[a, b],
			[task("AL-1"), task("AL-10", "alpha", 20), task("AL-9", "alpha", 10)],
			new Set(),
		),
	).toEqual(
		new Map([
			["a", "AL-9"],
			["b", "AL-10"],
		]),
	);
	// One new card: only the first create pairs.
	expect(
		pairCreates([a, b], [task("AL-1"), task("AL-9", "alpha", 10)], new Set()),
	).toEqual(new Map([["a", "AL-9"]]));
});

test("pairCreates never pairs a failed create, and the failed create claims nothing", () => {
	const failed = create({ key: "f", failed: true });
	expect(
		pairCreates([failed], [task("AL-1"), task("AL-9", "alpha", 5)], new Set()),
	).toEqual(new Map());
	expect(
		pairCreates(
			[failed, create({ key: "r" })],
			[task("AL-1"), task("AL-9", "alpha", 5)],
			new Set(),
		),
	).toEqual(new Map([["r", "AL-9"]]));
});

test("pairCreates keeps a settled create's card from the next unanswered create", () => {
	// Create A answered AL-9, its card landed and A dropped; create B still runs and
	// its snapshot predates AL-9. AL-9 is A's card, so B keeps its placeholder.
	const b = create({ key: "b", before: new Set(["AL-1"]) });
	const taken = new Set(["AL-9"]);
	expect(
		pairCreates([b], [task("AL-1"), task("AL-9", "alpha", 5)], taken),
	).toEqual(new Map());
	// B's own card can still pair once a frame carries it.
	expect(
		pairCreates(
			[b],
			[task("AL-1"), task("AL-9", "alpha", 5), task("AL-10", "alpha", 9)],
			taken,
		),
	).toEqual(new Map([["b", "AL-10"]]));
});

test("pairCreates is empty with no creates", () => {
	expect(pairCreates([], [task("AL-1"), task("AL-9")], new Set())).toEqual(
		new Map(),
	);
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
