import { describe, expect, test } from "bun:test";
import {
	type Card,
	type Facts,
	verdict,
} from "../.agents/skills/check-ottr-board/scripts/board-report.ts";

// OTTR-1252: a lead parked for its review's validation run (waitsValidation)
// reads "waits for validation" in the board report instead of "queued with no
// hold found"; a plain queued card keeps the old verdict. The script is safe to
// import here: its only top-level statement is the import.meta.main guard
// around main(), and report()/resolveMergeHold() run only when called.
const facts: Facts = {
	now: 1_000_000,
	logAgeS: null,
	hold: null,
	depsOpen: [],
	drain: false,
	capFull: false,
	cards: [],
};

function card(extra: Partial<Card>): Card {
	return {
		id: "t1",
		project: "ottr",
		stage: "todo",
		state: "queued",
		...extra,
	};
}

describe("verdict waitsValidation", () => {
	test("a waiting lead reads waits for validation with its review", () => {
		expect(
			verdict(card({ waitsValidation: true, followUpOf: "r1" }), facts),
		).toEqual({
			verdict: "waits",
			note: "waits for validation (review #r1)",
		});
	});

	test("a waiting lead without a review link names it with ?", () => {
		expect(
			verdict(card({ waitsValidation: true, followUpOf: null }), facts),
		).toEqual({
			verdict: "waits",
			note: "waits for validation (review #?)",
		});
	});

	test("a plain queued card still reads queued with no hold found", () => {
		expect(verdict(card({ followUpOf: "r1" }), facts)).toEqual({
			verdict: "check",
			note: "queued with no hold found",
		});
	});
});
