# Spec: Store review findings as they are recorded

Fix list #44 (2026-11-10). A review turn that never settles loses every finding it
recorded: findings live only in the run's in-memory `RunResult.recorded`
(`src/runner.ts:882`) and are checked and filed only when that same turn settles
(`src/turn.ts` `planTurnChecks` and `runReviewCheck`). Real incident: review card
CSE-6 recorded 65 findings, its turn never settled, and the card reached Done with
no finding cards and no check. `research-report.md` was lost when the Done worktree
was removed, because the report harvest only runs for research cards.

## Behavior

### 1. Findings persist as they arrive

Each valid `propose_task` call of a review card's main run is written to the store
at the moment the runner parses it, before the run settles. The parse point is
`handleEventLine`/`applyEvent` (`src/runner.ts`): when `state.recorded` grows, the
run sink fires a new `onRecorded` callback. `startRun` passes it through from its
options; the turn loop wires it only for review-card main runs
(`idn.reviewCard`), calling `store.appendReviewFinding(cardId, finding)`.

- Both run paths wire it: the local child process and the worker stream
  (`startWorkerRun`), because both parse events through the same run sink.
- Check runs (the second-model session) never get `onRecorded`.
- Retro proposals, scout verdicts, and non-review cards store nothing.

### 2. The review check runs on the stored set

`planTurnChecks` sources review findings from `store.listReviewFindings(cardId)`
instead of `st.result.recorded`. Because arrival persistence already stored this
turn's findings, the stored set is a superset of the run's set. The implemented
rule is the union of the stored set and the run's `recorded` findings, deduped
by prompt with the stored entries first, so a turn that delivered nothing still
checks the stored set and run-result delivery keeps working.

- The check runs when the stored set has findings that were never checked, at
  whichever turn the review lands on `merging` (Done hold) or `needs_you` — the
  same landing gate as today.
- Findings whose prompt matches a filed child card (`followUpOf` + prompt, the
  existing dedupe) stay excluded.
- After a completed check pass the card stores a check stamp
  (`findingsCheckedAt`). New findings reset the stamp to null, so the next
  landing re-checks. With the stamp set and no new findings, no re-check runs.

### 3. Done is refused while stored findings are unchecked

Both Done write paths get the guard, release reviews included:

- `parkReviewDone` (live turn): stored unchecked findings park the card at
  `merging`/`idle` with `UNCHECKED_FINDINGS_HOLD` instead of proceeding to
  Done. For a release card this hold precedes the publish, so the release
  publishes only after the check ran and filed its cards.
- `settleReviewCard` and `settleReleaseCard` (scheduled ticks): they refuse to
  write `stage: "done"` when the stored set has unchecked findings; they park
  needs_you with a reason that names the problem. A reply resumes the review and
  the next settle runs the check.

A shared predicate reads the stored findings and the stamp; both paths call it.

The check settle never writes Done directly: a review parked at merging lands
Done (and a release publishes) through `settleReviewCard` on a later tick,
which does the full Done bookkeeping — commits, mergeHead, uncommitted files,
worktree removal. The post-check write keeps the planned stage and state and
recomputes only the parked reason from the live cards.

### 4. "Needs validation" findings file as backlog cards marked unverified

The review prompt already tells the reviewer to start such findings' prompts with
the tag `Needs validation`, rank them below confirmed findings, and leave
security out. No prompt wording changes (hard stop 3 not triggered).

Code partitions the stored set by that prompt prefix:

- Confirmed findings: `selectFindings` picks the cap-10 selection plus confirmed
  high/critical security findings, as today; the second model checks them; kept
  ones file as queued cards; below-cap ones stay logged, not filed.
- Lead findings (prompt starts with `Needs validation`): they never enter the
  selection or the cap. Each files immediately as a backlog card:
  `createTask(prompt)`, then `updateTask` with `followUpOf` (the review),
  `model`, `stage: "backlog"`, `state: "idle"`, `queuedAt: null` (the existing
  backlog creators' shape), and a details note that marks the card unverified:
  the second-model check did not run on it. The review card's Findings trail
  lists them as filed backlog cards.
- Leads do not hold the review's Done: `findingsHold` ignores linked children in
  `backlog` stage (a lead is optional work, not a commitment).

### 5. research-report.md survives the worktree

The report harvest (`readReportFile` -> `archiveReport` -> `task.report`) runs
only for research cards today. It also runs for review cards when the file
exists in the worktree, before `stampDoneCard` removes the Done worktree. The
"report missing" needs_you guard stays research-only: a review without the file
still reaches Done. If a review card already has a stored `report`, a later
harvest keeps the existing text (first capture wins).

## Schema (additive, no destructive change)

New table in `SCHEMA` (created on every open, so existing databases converge;
no CHECK constraints, so no enum migration applies):

```sql
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  rank INTEGER,
  security TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(card_id, prompt)
);
```

New tasks column via the `addColumn` migration in `ProjectStore.open`:

```sql
ALTER TABLE tasks ADD COLUMN findings_checked_at INTEGER
```

`Task` gains `findingsCheckedAt: number | null` (mapped like the other
camelCase fields). The stamp is the review-check entry the Done guards read.

## Store API contract

```ts
/** Stores one arrived finding; returns true when it was new (not a duplicate
 * of a stored prompt). A new finding clears the card's findingsCheckedAt. */
appendReviewFinding(cardId: string, finding: RecordedFinding): boolean;

/** The card's stored findings in arrival order. */
listReviewFindings(cardId: string): RecordedFinding[];
```

`RecordedFinding` stays `{ prompt, model, rank, security }` (`src/types.ts:575`).

## Runner contract

`startRun` options, `createRunSink` options, and `handleEventLine` options gain:

```ts
/** Fired once per newly parsed propose_task finding, in arrival order. */
onRecorded?: (finding: RecordedFinding) => void;
```

`handleEventLine` fires it when `applyEvent` grew `state.recorded`; it fires
before the run resolves.

## Tests (red before the change)

1. store: an old-schema database (pre-change tasks DDL, no `review_findings`
   table, no `findings_checked_at`) converges on open; findings roundtrip; a
   duplicate prompt stores once and resets a set stamp.
2. runner: the real `createRunSink` fires `onRecorded` per `propose_task` start
   event, in order, before the result resolves; malformed calls store nothing.
3. turn: findings delivered through `onRecorded` during a run whose turn never
   settles survive on the card; a later turn that reports nothing recorded and
   answers still runs the check over the stored findings and files them.
4. turn: Done is refused while stored findings are unchecked (live park and the
   scheduled settle path); with the stamp set and no new findings, Done
   proceeds.
5. turn: lead findings file as backlog cards marked unverified, never enter the
   check input or the cap; below-cap confirmed findings stay logged; leads do
   not hold Done.

## Non-goals

- No UI changes (no `src/ui/**` edits; the Findings trail text update is card
  data, not UI code).
- No prompt wording changes (`src/prompts.ts` untouched).
- No recovery of findings lost before this change; no parsing of omp session
  files.
- No unverified marker column or UI badge; the mark is the card's details text.
- No structured per-finding check verdict storage beyond the stamp; the card
  summary/details trail stays the check's record.
