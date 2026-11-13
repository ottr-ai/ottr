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

### 4. "Needs validation" findings file as backlog cards sorted by their blocker

A lead waits on one of two things: a deployment fact only the user knows, or a run
of the target code in an OS-enforced sandbox this board does not have. The review
prompt tells the reviewer to start lead prompts with the tag `Needs validation`,
rank them below confirmed findings, leave security out, and end each lead prompt
with exactly one blocker line:

- `Blocker: deployment fact: <question>` — a fact only the user knows decides the
  risk; the question asks for that fact.
- `Blocker: sandbox run: <missing control>` — the proof waits on controls this
  runner lacks; the text names the missing control.

(The prompt wording is not part of this change: its exact text ships in the ready
report for the user's approval — hard stop 3 — and lands in `src/prompts.ts` in a
later change, only after approval. Until it lands, no lead carries the line, so
every lead sorts as a sandbox-run lead and no question card files.)

Code partitions the stored set by the `Needs validation` prefix, then sorts leads
with one strict pattern, `/^[^\S\n]*Blocker: (deployment fact|sandbox run): (.+)$/`
per line, first match wins. A lead without a matching line counts as a sandbox-run
lead.

- Confirmed findings: `selectFindings` picks the cap-10 selection plus confirmed
  high/critical security findings, as today; the second model checks them; kept
  ones file as queued cards; below-cap ones stay logged, not filed.
- Sandbox-run leads file as today: backlog card, `createTask(prompt)`, then
  `updateTask` with `followUpOf` (the review), `model`, `stage: "backlog"`,
  `state: "idle"`, `queuedAt: null` (the existing backlog creators' shape), and the
  unverified details note plus ` Waits for a validation sandbox.`
- Deployment-fact leads file the same backlog card, without the sandbox note. When
  the pass filed at least one and the review has no open question card yet, the
  review also files ONE question card: `createTask` with a prompt that starts with
  the fixed prefix `Needs-validation lead questions from review #`, then
  `updateTask` with `followUpOf` (the review), `stage: "backlog"`,
  `state: "needs_you"`, `queuedAt: null`, and `asked` holding one question per
  deployment-fact lead of this pass: question text `<question> (card #<lead id>)`,
  options `Yes, the risk applies` and `No, it does not apply` (free text rides the
  drawer's Other field), `multi: false`, `recommended: null`.
- The question card holds nothing: `findingsOpen` ignores `backlog`-stage children,
  so the review's Done never waits for the answer. A review whose leads are all
  sandbox-run leads files no question card.

The reply route applies the answers (`src/app.ts`). A reply to a card whose prompt
starts with the question-card prefix and whose `asked` is set parses one answer per
question — from the drawer's wire line `For "<question>": <answer>` (shared helper
`askAnswerLine`), or, on a single-question card, from the whole reply text (that
drawer sends the raw answer without the wire line) — applies it to the question's
lead card, records free text no question consumed on the unanswered open leads, and
lands the question card Done (`stage: "done"`, `state: "idle"`, `asked: null`,
`doneAt` set by the store's Done stamp):

- `Yes, the risk applies`: an idle backlog lead moves to `stage: "todo"`,
  `state: "queued"`, `queuedAt` set, and the answer appends to its prompt. A lead
  the user already started (any other stage or state) only records the answer in
  its details — no run state is overwritten.
- `No, it does not apply`: an idle backlog lead cancels with the direct patch
  (`cancelledAt` set, `state: "idle"`) and the answer as its `needsReason`. A
  started lead cancels through the sanctioned `cancel()` (it stops the run,
  disposes the worktree, deletes the branch) and then carries the answer as its
  `needsReason`; a cancel that kept work records that fact in the details.
- Any other text, an empty answer, or no answer line: the lead keeps its state;
  non-empty text appends to its details. Free text the reply carried but no
  question consumed appends to the details of every open lead that got no
  per-question answer.
- Answers only touch lead cards of the same review (`followUpOf` match) that are
  still open (not cancelled, not done). The question card lands Done inside the
  same reply, so a second reply is refused (409, not needs_you).

No schema change: the question card reuses the existing `asked` column and its
`AskQuestion` normalization.

#### Lead fingerprint dedupe

Each audit run carries its open leads into the next audit (docs/specs/security-audit-harness.md
"Review behavior": every `needs_validation` record has a fingerprint, and a proposal
preserves it). Until OTTR-870 every lead filed a new backlog card, so each release
review of a project refiled the same leads (run-7 carried 51 of 59 leads over
unchanged).

- The lead prompt carries the record's fingerprint on one fixed line:
  `Fingerprint: <value>`. The board reads it with one strict pattern: a line that
  starts with the exact prefix `Fingerprint: `, value = the trimmed rest of that
  line. A lead without the line falls back to the title dedupe below.
- Before the board files a lead, it looks in the same project's cards for one
  whose prompt carries the same fingerprint value. Among several matches the
  lowest card id decides, with priority: open (not done, not cancelled), then
  cancelled, then done.
  - Open card: no new card. The board appends one line to that card's details:
    `Seen again in review <review id> on <YYYY-MM-DD>.` The review card's
    Findings trail counts the lead as `- already open: #<card id> (<prompt
    head>)` and the log says so too; the lead counts as not filed.
  - Cancelled card: no new card, because the user declined the lead. The Findings
    trail notes it (`- not filed: the user cancelled the same lead before,
    card #<card id>`); the lead counts as not filed.
  - Done card: the lead files as today, and the new card's details name the old
    card (`The same fingerprint was already on done card #<card id>; the lead
    came back.`).
- A card filed for a lead joins the fingerprint index for the rest of the same
  pass, so two leads with one fingerprint file once.

The review prompt does not yet tell the reviewer to write the fixed line
(`src/prompts.ts` wording changes need the user's approval). Until the wording
lands, most leads carry no line, and the title dedupe below applies to them.

#### Lead title dedupe

A lead with no fingerprint match must not file a second card for a topic that an
open lead card already holds (OTTR-929).

- Title key: the first line of the prompt, lower case, each run of whitespace
  changed to one space, trimmed.
- The index holds only open cards (not done, not cancelled) whose title key
  starts with `needs validation`. Done and cancelled cards never block a lead
  by title.
- The board uses the title index when the fingerprint lookup finds no open or
  cancelled card. A title match counts only when the lead or the matched card
  carries no `Fingerprint:` line: two different fingerprints are two records.
  The board removes the cards that do not count first. Then the lowest card id
  of the cards that stay decides.
- A title match acts like an open fingerprint match: no new card, the
  `Seen again in review <review id> on <YYYY-MM-DD>.` line on the open card, and
  `- already open: #<card id> (<prompt head>)` on the review's Findings trail.
- A card filed for a lead joins the title index for the rest of the same pass,
  so two leads with one title file once.

### 5. research-report.md survives the worktree

The report harvest (`readReportFile` -> `archiveReport` -> `task.report`) runs
only for research cards today. It also runs for review cards when the file
exists in the worktree, before `stampDoneCard` removes the Done worktree. The
"report missing" needs_you guard stays research-only: a review without the file
still reaches Done. If a review card already has a stored `report`, a later
harvest keeps the existing text (first capture wins).

Since OTTR-826 (docs/specs/saved-files.md), the report is no longer the only
survivor: every uncommitted file of a done card is kept under
`.tasks/quarantine/<id>` and listed as Saved files in the done drawer; the
report also stays in `task.report`.

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
6. turn (OTTR-870): a lead whose `Fingerprint:` line matches an open card files
   no new card, and that card's details gain `Seen again in review <id> on
   <date>.`; a cancelled match files nothing; a done match files a new card
   whose details name the old card; a lead without the line falls back to the
   title dedupe.
6a. turn (OTTR-929): a lead without a fingerprint whose title key matches an
   open lead card files no new card, and the task count stays the same; a done
   or cancelled title match files the lead; two leads with one title file once;
   a same-title open card with another fingerprint does not block a
   fingerprinted lead.
7. turn: a review with two deployment-fact leads and one sandbox-run lead files
   three backlog cards and one question card with two questions; the sandbox
   card's details say it waits for a validation sandbox; each question text ends
   with its lead card's id.
8. reply route: the answers "applies" and "does not apply" queue the first lead
   card with the answer in its prompt and cancel the second with the answer as
   its reason; the question card goes Done. Free text leaves the lead card in
   backlog with the answer in its details. A one-question card takes the
   drawer's raw answer text; a started lead cancels through the sanctioned
   cancel and never loses its run to the bare patch.
9. turn: a review with only sandbox-run leads (one without the blocker line)
   files no question card.

## Non-goals

- No UI changes (no `src/ui/**` edits beyond the AskPanel's move onto the shared
  `askAnswerLine` wire-format helper, which keeps its output byte-identical; the
  Findings trail text update is card data, not UI code).
- No `src/prompts.ts` change in this task: the blocker-line wording ships in the
  ready report for approval (hard stop 3) and lands in a later change after
  approval; until then the sorting machinery stays dormant.
- No validation sandbox; sandbox-run leads keep waiting for one.
- No change to leads that already exist (OTTR-929 adds the title dedupe of new
  leads against open lead cards).
- No recovery of findings lost before this change; no parsing of omp session
  files.
- No unverified marker column or UI badge; the mark is the card's details text.
- No structured per-finding check verdict storage beyond the stamp; the card
  summary/details trail stays the check's record.
- No dedupe of confirmed findings and no repair of the duplicate lead cards
  filed before OTTR-870; the fixed line dedupes leads only, from its first
  appearance in a lead prompt onward.
