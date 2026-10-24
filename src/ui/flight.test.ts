import { expect, test } from "bun:test";
import type { CardPos } from "./flight.ts";
import { freshTaskIds, listSlides, stageFlights } from "./flight.ts";

const pos = (stage: string, left = 0, top = 0): CardPos => ({
	stage,
	left,
	top,
});

test("stageFlights flies only cards whose stage changed", () => {
	const prev = new Map([
		["a", pos("todo", 100, 200)],
		["b", pos("in_progress", 300, 200)],
	]);
	const next = new Map([
		["a", pos("in_progress", 400, 200)], // moved right one column
		["b", pos("in_progress", 300, 200)], // untouched
	]);
	expect(stageFlights(prev, next)).toEqual(
		new Map([["a", { dx: -300, dy: 0 }]]),
	);
});

test("stageFlights skips cards with no previous position and zero-distance changes", () => {
	const prev = new Map([["a", pos("todo", 100, 200)]]);
	const next = new Map([
		["a", pos("done", 100, 200)], // stage changed but same spot (e.g. hidden page)
		["b", pos("todo", 0, 0)], // brand new card: rise handles it
	]);
	expect(stageFlights(prev, next)).toEqual(new Map());
});

test("freshTaskIds reports ids never seen and ignores known ones", () => {
	const seen = new Set(["a", "b"]);
	expect(freshTaskIds(seen, [{ id: "b" }, { id: "c" }])).toEqual(
		new Set(["c"]),
	);
});

test("freshTaskIds on first sight animates nothing", () => {
	expect(freshTaskIds(null, [{ id: "a" }, { id: "b" }])).toEqual(new Set());
});

test("listSlides slides every card whose place in the column changed", () => {
	const prev = new Map([
		["a", 0],
		["b", 60],
		["c", 120],
	]);
	const next = new Map([
		["c", 0], // dropped at the top
		["a", 60],
		["b", 120],
	]);
	expect(listSlides(prev, next)).toEqual(
		new Map([
			["c", 120],
			["a", -60],
			["b", -60],
		]),
	);
});

test("listSlides keeps still when only the layout moved", () => {
	// Same order, shifted by the drag gap or a resize.
	const prev = new Map([
		["a", 0],
		["b", 60],
	]);
	const next = new Map([
		["a", 0],
		["b", 70],
	]);
	expect(listSlides(prev, next)).toEqual(new Map());
});

test("listSlides skips new cards and sub-pixel moves", () => {
	const prev = new Map([
		["a", 0],
		["b", 60],
	]);
	const next = new Map([
		["a", 0.4],
		["c", 60], // new card: nothing to slide from
		["b", 120],
	]);
	expect(listSlides(prev, next)).toEqual(new Map([["b", -60]]));
});
