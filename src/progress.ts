import type { Task } from "./types.ts";

/**
 * Per-task commit delta vs the previous done task of the same project: the progress increment.
 * Counts are monotonic per project (the merge slot is serial), so sorting by count orders them.
 * Done tasks without a count, flat counts, and non-done tasks get no delta.
 */
export function commitDeltas(
	tasks: Pick<Task, "id" | "project" | "stage" | "commits">[],
): Map<string, number> {
	const prev = new Map<string, number>();
	const out = new Map<string, number>();
	const done = tasks
		.flatMap((t) =>
			t.stage === "done" && t.commits !== null
				? [{ ...t, commits: t.commits }]
				: [],
		)
		.sort((a, b) => a.commits - b.commits);
	for (const t of done) {
		// `p !== undefined` is load-bearing, not redundant with the comparison: `n > undefined` is always
		// false, so dropping it is an equivalent mutant (the first count per project emits no delta either way).
		const p = prev.get(t.project);
		if (p !== undefined && t.commits > p) out.set(t.id, t.commits - p);
		prev.set(t.project, t.commits);
	}
	return out;
}
