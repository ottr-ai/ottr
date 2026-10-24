import { describe, expect, test } from "bun:test";
import { withLiveSlots, workflowKind, workflowLive } from "./workflow.ts";

describe("workflowKind", () => {
	const task = { kind: "work" as const, releaseVersion: null };

	test("a normal card runs the task workflow", () => {
		expect(workflowKind(task)).toBe("task");
	});

	test("the Review button's card runs the review workflow", () => {
		expect(workflowKind({ ...task, kind: "review" })).toBe("review");
	});

	test("a release card runs the release workflow, kind aside", () => {
		expect(workflowKind({ ...task, releaseVersion: "v1.2.3" })).toBe("release");
		expect(workflowKind({ kind: "review", releaseVersion: "v1.2.3" })).toBe(
			"release",
		);
	});
});

describe("withLiveSlots", () => {
	test("swaps the diagram's default slot numbers for the project's live settings", () => {
		expect(
			withLiveSlots(
				'<text x="146" y="152" class="s">2 / project · 3 total</text>',
				4,
				16,
			),
		).toBe('<text x="146" y="152" class="s">4 / project · 16 total</text>');
	});

	test("a changed diagram text degrades to the static copy", () => {
		expect(withLiveSlots("<svg>new wording</svg>", 4, 16)).toBe(
			"<svg>new wording</svg>",
		);
	});

	test("null caps read as no cap", () => {
		expect(
			withLiveSlots(
				'<text x="146" y="152" class="s">2 / project · 3 total</text>',
				null,
				null,
			),
		).toBe(
			'<text x="146" y="152" class="s">no cap / project · no cap total</text>',
		);
	});
});

describe("workflowLive", () => {
	test("reads slot use, queue and caps into one line", () => {
		expect(
			workflowLive({
				label: "Ottr",
				slots: { todo: 0, in_progress: 1, merging: 1 },
				waiting: 2,
				maxParallel: 2,
				maxTotal: 6,
				usedTotal: 3,
				draining: false,
			}),
		).toBe(
			"Ottr: 2 of 2 agents running · 2 queued for a free slot · 1 in a merge turn · 3 of 6 across all projects",
		);
	});

	test("drops empty clauses and flags a draining board", () => {
		expect(
			workflowLive({
				label: "Alate",
				slots: { todo: 1, in_progress: 0, merging: 0 },
				waiting: 0,
				maxParallel: 2,
				maxTotal: 3,
				usedTotal: 1,
				draining: true,
			}),
		).toBe(
			"Alate: 1 of 2 agents running · 1 of 3 across all projects · board drains for an update — queued cards wait",
		);
	});

	test("an idle board shows zero busy slots with no clauses", () => {
		expect(
			workflowLive({
				label: "Ottr",
				slots: { todo: 0, in_progress: 0, merging: 0 },
				waiting: 0,
				maxParallel: 2,
				maxTotal: 3,
				usedTotal: 0,
				draining: false,
			}),
		).toBe("Ottr: 0 of 2 agents running · 0 of 3 across all projects");
	});

	test("null caps read as no cap", () => {
		expect(
			workflowLive({
				label: "Ottr",
				slots: { todo: 0, in_progress: 1, merging: 0 },
				waiting: 0,
				maxParallel: null,
				maxTotal: null,
				usedTotal: 1,
				draining: false,
			}),
		).toBe(
			"Ottr: 1 running (no project cap) · 1 running across all projects (no cap)",
		);
	});
});
