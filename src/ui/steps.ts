import type {
	FindingView,
	RetroView,
	TurnView,
	WorkCheckRun,
} from "../types.ts";

/** One entry on a card's Work steps rail: its own turn, a work check run, a turn of its retro,
 * or the life of one of its review's findings — a `filed` marker for a finding with no turns
 * yet, else one step per finding turn. */
export type Step =
	| { kind: "turn"; at: number; turn: TurnView }
	/** `n` is the 1-based run number in the check log. */
	| { kind: "check"; at: number; run: WorkCheckRun; n: number }
	| { kind: "retro"; at: number; turn: TurnView; retroId: string }
	| { kind: "finding"; at: number; turn: TurnView; finding: FindingView }
	| { kind: "filed"; at: number; finding: FindingView };

/** Tie order at the same start time: the card's turn first, then the check that read its work,
 * then the retro, then the findings the review filed. */
const RANK: Record<Step["kind"], number> = {
	turn: 0,
	check: 1,
	retro: 2,
	filed: 3,
	finding: 4,
};

/** The Work steps rail, oldest first by start time. The sort is stable, so equal times keep
 * input order within a kind. A cancelled retro still lists the turns it ran, and so does a
 * cancelled finding. */
export function workSteps(
	turns: readonly TurnView[],
	checks: readonly WorkCheckRun[],
	retro?: RetroView,
	findings?: readonly FindingView[],
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
		...(findings ?? []).flatMap((finding): Step[] =>
			finding.turns.length === 0
				? [{ kind: "filed", at: finding.createdAt, finding }]
				: finding.turns.map(
						(turn): Step => ({
							kind: "finding",
							at: turn.startedAt,
							turn,
							finding,
						}),
					),
		),
	];
	return steps.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
}
