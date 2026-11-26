/** OTTR-1252: the outcome cases every validation-outcome reader must decide
 * identically — the validation settle, resetValidatedLeads, the SQLite
 * convergence and the PostgreSQL migration step. Each case seeds validation
 * runs (cards) with recorded results for one lead L of review R; a `foreign`
 * run belongs to review F. The rule under test: only results of the lead's
 * own review count, runs newest first, and inside a run the first result for
 * the lead — so the expected decision is `own`, the newest own run's first
 * result, and `waits` is whether that outcome keeps the lead waiting. */

export type OutcomeRun = {
	/** The run card's created_at; later entries in a case's list are newer. */
	createdAt: number;
	/** true when the run belongs to the foreign review F, not the lead's R. */
	foreign: boolean;
	/** The run's recorded results in arrival order; the first per lead rules. */
	results: ("confirmed" | "refuted" | "blocked" | "deployment")[];
};

export type LeadOutcomeCase = {
	name: string;
	runs: OutcomeRun[];
	/** The newest own run's first recorded result (null: no own run). */
	own: "confirmed" | "refuted" | "blocked" | "deployment" | null;
	/** true when the lead ends up waiting for validation again. */
	waits: boolean;
};

export const leadOutcomeCases: readonly LeadOutcomeCase[] = [
	{
		name: "own blocked then confirmed in one run",
		runs: [
			{ createdAt: 100, foreign: false, results: ["blocked", "confirmed"] },
		],
		own: "blocked",
		waits: true,
	},
	{
		name: "own confirmed then blocked in one run",
		runs: [
			{ createdAt: 100, foreign: false, results: ["confirmed", "blocked"] },
		],
		own: "confirmed",
		waits: false,
	},
	{
		name: "a duplicate result in one run",
		runs: [{ createdAt: 100, foreign: false, results: ["blocked", "blocked"] }],
		own: "blocked",
		waits: true,
	},
	{
		name: "a foreign confirmation over an own blocked result",
		runs: [
			{ createdAt: 100, foreign: false, results: ["blocked"] },
			{ createdAt: 200, foreign: true, results: ["confirmed"] },
		],
		own: "blocked",
		waits: true,
	},
	{
		name: "a foreign blocked result over an own confirmed result",
		runs: [
			{ createdAt: 100, foreign: false, results: ["confirmed"] },
			{ createdAt: 200, foreign: true, results: ["blocked"] },
		],
		own: "confirmed",
		waits: false,
	},
];
