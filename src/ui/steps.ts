import type { RetroView, TurnView, WorkCheckRun } from "../types.ts";

/** One entry on a card's Work steps rail: its own turn, a work check run, or a turn of its retro. */
export type Step =
	| { kind: "turn"; at: number; turn: TurnView }
	/** `n` is the 1-based run number in the check log. */
	| { kind: "check"; at: number; run: WorkCheckRun; n: number }
	| { kind: "retro"; at: number; turn: TurnView; retroId: string };

/** Tie order at the same start time: the card's turn first, then the check that read its work, then the retro. */
const RANK: Record<Step["kind"], number> = { turn: 0, check: 1, retro: 2 };

/** The Work steps rail, oldest first by start time. The sort is stable, so equal times keep
 * input order within a kind. A cancelled retro still lists the turns it ran. */
export function workSteps(
	turns: readonly TurnView[],
	checks: readonly WorkCheckRun[],
	retro?: RetroView,
): Step[] {
	const steps: Step[] = [
		...turns.map((turn): Step => ({ kind: "turn", at: turn.startedAt, turn })),
		...checks.map(
			(run, i): Step => ({ kind: "check", at: run.at, run, n: i + 1 }),
		),
		...(retro === undefined
			? []
			: retro.turns.map(
					(turn): Step => ({
						kind: "retro",
						at: turn.startedAt,
						turn,
						retroId: retro.id,
					}),
				)),
	];
	return steps.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
}
