# Work check: a fresh check of the work result

Decided 2026-11-09 (OTTR-728). The work check is the second-model gate between a card's
`ready` report and the merge queue (`src/turn.ts`, `workCheckPrompt` in `src/prompts.ts`).

## Behavior

- Each check is one new model session with zero context (never `--resume`), `read,grep,glob`
  only, in the card's worktree. Its input is the work result of the card.
- A ready report at stage `merging` starts a check run when at least one holds:
  - no completed check has seen this head (`workCheckHead` differs from HEAD or is null), or
  - open blockers exist (the last check sent the card back).
- No path resends stored blockers without a check run. A ready report after a send-back always
  gets a fresh check, even with no new commit and no new report text: the update may be new
  evidence (a run the transcript now shows) or a corrected claim, and only a fresh session
  judges it.
- A re-ready after a passing check at an unchanged head starts no check: the last check passed
  and nothing changed.

## Check inputs

The work result is the card's ready report (the `report_outcome` summary and details, else the
run's final message) plus the branch diff.

First check (no completed check yet):

- the card prompt,
- the ready report of the run being checked,
- the full branch diff (`base..HEAD`),
- the transcript path only as evidence to verify claims of runs (the `fabricated-actions`
  class). It is never a source of claims to judge.

Re-check (a completed check exists, `workCheckHead` is set):

- the same original result: the card prompt and the ready report the first completed check
  judged, stored on the task (`work_check_report`, captured once, never overwritten),
- the blockers the last check sent back (numbered, as today),
- the new ready report of the run being checked,
- the diff since the last checked head (`workCheckHead..HEAD`), empty when no commit was added.
  The full branch diff is still read once for quote grounding (`demoteUnquoted`), but the
  prompt shows only the since-diff.

The check judges the card's current state. The prompt labels the original report as historical:
a claim that the new report corrects or takes back is not a blocker.

## Quote grounding

A blocker must quote a verbatim part of the ready report or of the diff. `demoteUnquoted`
keeps only quotes that the diff, the ready report, or the transcript contains (the transcript
still grounds a `fabricated-actions` quote); anything else demotes to a note. Severities,
classes, and the strict-JSON verdict format are unchanged.

## Send-backs and the cap

- A blocked check sends the card back to the work agent with the blockers; the count
  `workCheckSendbacks` increments. `WORK_CHECK_MAX_SENDBACKS` (4) still counts every send-back.
- Past the cap, the card asks the user: **Send it back** (one more send-back, still counted) or
  **Merge anyway** (override with a reason). Unchanged.
- Human replies since the last check still ride along as numbered data; a tracker send-back
  text is not a human reply, full stop — no carve-out. A directed send-back (a typed reply
  on a diverging park, or the board's rethink direction on a counts-only park) carries the
  direction to the work agent in its `New direction for the approach:` section, and the
  board stamps the direction onto the send-back round's entry in `workCheckLog`; the next
  check reads it from there — the sent-back text is never parsed, so a quote cannot forge
  a human direction.
- A diverging loop parks at once when the blocker count did not drop over two consecutive
  send-backs or one bug class repeats in two consecutive checks; the park asks **Send back
  with a new approach** (a typed reply carries the user's direction; the click alone attaches
  the board's rethink direction), **Merge anyway**, or **Cancel**.

## Error cases

- The check run fails or returns no valid JSON twice: the card parks at `needs_you`; no head or
  original-report stamp lands, so the next ready report runs a fresh check as first check.
- A usage-limit hold parks the card until the provider resets (unchanged).
- No transcript file on disk: the check works from the report and the diff.
- `workCheckHead` is null (checks ran but none completed): the run is treated as a first check
  with the full branch diff.

## Non-goals

- No change to blocker classes, severities, or the JSON verdict format.
- No change to the post-cap ask route (`src/app.ts`) or to `workCheckSendBack` wording beyond
  what the cap semantics need.
- No board UI change: the drawer renders `workCheckLog` as data.
- OTTR-726 (park a byte-identical replay) targets the resend path this card removes. At the
  time of writing, OTTR-726 has not merged; its replay park must adapt or drop when it lands.

## Acceptance checks

- A ready report at an unchanged head after a send-back starts a check run (no resend).
- The re-check input holds the original report, the sent-back blockers, the new report, and
  only the new diff (empty at an unchanged head).
- The first check input holds no earlier blockers and no original report.
- The cap still asks the user after `WORK_CHECK_MAX_SENDBACKS` send-backs.
- A retracted claim in an earlier report is not part of the re-check input as a current claim.
