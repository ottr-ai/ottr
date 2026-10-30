import { describe, expect, test } from "bun:test";
import { commitDeltas } from "./progress.ts";
import type { Task } from "./types.ts";

function done(id: string, project: string, commits: number | null): Task {
	return {
		id,
		project,
		title: "",
		prompt: "",
		kind: "work",
		stage: "done",
		state: "idle",
		needsReason: null,
		pendingPrompt: null,
		images: [],
		pendingImages: [],
		shots: [],
		branch: null,
		base: null,
		worktree: null,
		sessionId: null,
		summary: null,
		details: null,
		report: null,
		research: false,
		createdAt: 0,
		updatedAt: 0,
		queuedAt: null,
		doneAt: null,
		cancelledAt: null,
		commits,
		releaseVersion: null,
		releaseNotes: null,
		asked: null,
		model: null,
		keptFiles: [],
		followUpOf: null,
		pushSha: null,
		topic: null,
		dependsOn: [],
		updateIds: [],
		updateMergeHead: null,
		forkMergeHead: null,
		holdHead: null,
		diffFiles: null,
		diffText: null,
		workCheckLog: [],
		workCheckSendbacks: 0,
		workCheckHead: null,
		priority: null,
		closeCandidate: null,
	};
}

describe("commitDeltas", () => {
	test("delta is the gap to the previous count, independent of input order", () => {
		const d = commitDeltas([
			done("c", "p", 13),
			done("a", "p", 20),
			done("b", "p", 10),
		]);
		expect(d.get("a")).toBe(7);
		expect(d.get("c")).toBe(3);
		expect(d.has("b")).toBe(false);
	});

	test("projects are isolated; uncounted and flat tasks get no delta", () => {
		const d = commitDeltas([
			done("a", "p", 10),
			done("b", "q", 1),
			done("c", "q", 1),
			done("d", "p", null),
			done("e", "p", 12),
		]);
		expect(d.get("a")).toBeUndefined();
		expect(d.get("b")).toBeUndefined();
		expect(d.get("c")).toBeUndefined();
		expect(d.has("d")).toBe(false);
		expect(d.get("e")).toBe(2);
	});

	test("non-done tasks never appear", () => {
		// A lower non-done count must not become the baseline for the first done task.
		const running = { ...done("x", "p", 5), stage: "in_progress" as const };
		const d = commitDeltas([running, done("a", "p", 10)]);
		expect(d.has("a")).toBe(false);
		expect(d.has("x")).toBe(false);
	});
});
