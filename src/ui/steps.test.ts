import { expect, test } from "bun:test";
import type { RetroView, TurnKind, TurnView, WorkCheckRun } from "../types.ts";
import { type Step, workSteps } from "./steps.ts";

const turn = (id: number, kind: TurnKind, startedAt: number): TurnView => ({
	id,
	taskId: "OTTR-1",
	kind,
	input: null,
	inputBy: null,
	startedAt,
	endedAt: startedAt + 60_000,
	pid: null,
	exitCode: 0,
	outcome: "ready",
	summary: null,
	details: null,
	question: null,
	error: null,
	model: null,
});

const check = (at: number): WorkCheckRun => ({
	at,
	model: null,
	outcome: "pass",
	blockers: [],
	notes: [],
	durationMs: 1000,
});

const retro = (
	turns: TurnView[],
	cancelledAt: number | null = null,
): RetroView => ({
	id: "OTTR-2",
	state: "idle",
	stage: "done",
	cancelledAt,
	needsReason: null,
	asked: null,
	turns,
});

/** What the rail reads, in order: the step kind plus the turn kind or run number. */
const labels = (steps: Step[]): string[] =>
	steps.map((s) =>
		s.kind === "check" ? `check#${s.n}` : `${s.kind}:${s.turn.kind}`,
	);

test("workSteps lists turns, checks and the retro by start time, oldest first", () => {
	const at = (h: number, m: number) => Date.UTC(2026, 10, 3, h, m);
	const steps = workSteps(
		[turn(1, "work", at(19, 16)), turn(2, "merge", at(19, 50))],
		[check(at(19, 35))],
		retro([turn(9, "work", at(19, 53))]),
	);
	expect(labels(steps)).toEqual([
		"turn:work",
		"check#1",
		"turn:merge",
		"retro:work",
	]);
	const last = steps.at(-1);
	expect(last?.kind === "retro" && last.retroId).toBe("OTTR-2");
});

test("workSteps interleaves every kind and numbers the checks in log order", () => {
	const steps = workSteps(
		[turn(1, "work", 10), turn(2, "work", 30), turn(3, "merge", 50)],
		[check(20), check(40)],
		retro([turn(7, "work", 5), turn(8, "work", 45)]),
	);
	expect(steps.map((s) => s.at)).toEqual([5, 10, 20, 30, 40, 45, 50]);
	expect(labels(steps)).toEqual([
		"retro:work",
		"turn:work",
		"check#1",
		"turn:work",
		"check#2",
		"retro:work",
		"turn:merge",
	]);
});

test("workSteps puts a turn before a check before the retro at the same start time", () => {
	const steps = workSteps(
		[turn(1, "work", 100)],
		[check(100)],
		retro([turn(9, "work", 100)]),
	);
	expect(labels(steps)).toEqual(["turn:work", "check#1", "retro:work"]);
});

test("workSteps keeps input order for equal times within one kind", () => {
	const steps = workSteps(
		[turn(1, "work", 100), turn(2, "merge", 100)],
		[check(100), check(100)],
	);
	expect(labels(steps)).toEqual([
		"turn:work",
		"turn:merge",
		"check#1",
		"check#2",
	]);
});

test("workSteps still lists the turns of a cancelled retro", () => {
	const steps = workSteps([], [], retro([turn(9, "work", 100)], 200));
	expect(labels(steps)).toEqual(["retro:work"]);
});

test("workSteps gives an empty rail for empty inputs", () => {
	expect(workSteps([], [])).toEqual([]);
	expect(workSteps([], [], retro([]))).toEqual([]);
});
