# Spec: Review holds must not stall the project

One review, its findings, and its gates must never stop every other merge for
days. This spec records the measured stall of 2026-11-22 to 2026-11-24, the
rules that caused it, the designs compared, and the chosen fix.

## Measured history (live board, 2026-11-24)

Reachable sources from this work container: the card logs under
`/data/ottr/logs` (2 102 files, 2026-10-14 to 2026-11-24) and a task-store
snapshot from 2026-10-26 (`/data/ottr/tasks.db.moved-to-server`, ids only up to
OTTR-185, so it predates OTTR-943 and gives no numbers for the asked range).
The live store moved to the server volume, and its HTTP API accepts direct
loopback only, so per-card stage history (the `events` table) was not
readable. Findings filed per week is therefore not measurable here; a finding
card's log starts at its first turn, not at its filing. The numbers below cite
their source.

Merge turns executed per ISO week (log headers `== merge turn`, whole board):

| Week | Merge turns |
|---|---|
| 2026-W39 | 51 |
| 2026-W40 | 286 |
| 2026-W41 | 59 |
| 2026-W42 | 113 |
| 2026-W43 | 67 |
| 2026-W44 | 122 |
| 2026-W45 | 255 |
| 2026-W46 | 263 |
| 2026-W47 | 150 |
| 2026-W48 (Nov 23-24) | 1 |

The W48 collapse is the stall, measured. Work-turn headers overcount starts
(37 cards of the "Needs validation" batch carry 500 to 1 059 repeated headers
each), so they are not a queue-size signal and are not tabulated.

The current stall timeline:

- 2026-11-22 12:20:41 UTC: the architecture review OTTR-1186's turn starts
  (first log header; base `d60e96dd24ebb91bd93ddc9422a755566d5026e55`).
- 2026-11-22 13:52:18 UTC: the mutation gate card OTTR-1191's turn starts
  (first log header). Its log shows the full-mutation chain planning, per-test
  timeouts for heavy tests, and repeated kills ("the previous kills came from
  turn/session lifecycles", that is, host restarts); it measured 79 percent
  after 15 h 27 min against a break threshold of 90 (operator measurement,
  2026-11-24).
- 2026-11-22 14:55 UTC: the oldest of the 67 queued or merging cards started
  waiting (operator measurement, live board 2026-11-24 13:50 UTC). At that
  moment: 93 open cards; all 67 merges held by OTTR-1186's
  "waiting for the review to finish" hold; 43 of the 67 are findings of
  earlier reviews (37 open children of OTTR-969 alone); the held cards include
  the repairs the board needs (OTTR-1245 check loop, OTTR-1225 nproc limit,
  OTTR-1216 phantom runs).
- The review had recorded 30 findings that become cards only when its turn
  ends; finishing it would move it to merging and re-hold the 67 merges under
  the findings hold.

## Why one review held every merge

The scheduler holds a queued merge while any live review gates the target
(`mergeHold`, `reviewHoldFor` in `src/scheduler.ts`). Three rules produce a
hold, in this order:

1. Release hold: a review with a `releaseVersion` that has not reached done
   holds every merge except the review's own findings
   (`waiting for release <version>`). Uncapped.
2. Review-running hold: a review in `todo` or `in_progress` holds every merge
   except the review's own findings (`waiting for the review to finish`).
   Uncapped. A finding of another review waits here too.
3. Findings hold: a review parked at `merging`, or done with open committed
   findings, holds every merge except its own findings
   (`waiting for the review's findings to be implemented`). Uncapped.

`releaseHeldMerges` and the UI re-derive the same holds. The board report
(`.agents/skills/check-ottr-board/scripts/board-report.ts`) prints the hold
string, but it names no review and no duration.

The OTTR-940 fix (2026-11) exempts a finding of another review from rule 3
only. The comment records why: that hold edge was the only one that closed a
wait cycle through a finding. Rule 2 closes one too.

## How a review cannot finish

| Stall path | Bounded today | Evidence |
|---|---|---|
| A review gate cannot pass (a full mutation run scores below the break threshold and retries for days) | No: the review stays `in_progress` and rule 2 holds every merge | OTTR-1186: architecture review `in_progress` since 2026-11-22; its gate card OTTR-1191 measured 79 percent after 15 h 27 min against a break threshold of 90 |
| A review parked at `needs_you` waits for the user | No: rule 2 keeps holding | OTTR-1186 sat `needs_you` while 67 merges queued |
| A review's findings wait for that review | Partly: OTTR-940 exempts a finding from rule 3, not from rule 2 | OTTR-969's 37 open children queued behind OTTR-1186's rule 2 hold |
| Findings describe code the queued merges change | No bound exists, and none is added; a finding's work turn rebases on current main and its check gates the result | `planMergeHolds`, `workCheck` |
| A release waits for its findings | The review card parks (`FINDINGS_HOLD`); the release publish waits for the same findings | `parkReviewDone`, `findingsHold` |

On 2026-11-24 13:50 UTC the ottr project had 93 open cards; 67 queued or
merging cards waited on OTTR-1186's rule 2 hold. 43 of the 67 were findings of
earlier reviews, so rules 2 and 3 also held the fixes the board needed:
OTTR-1245 (check loop), OTTR-1225 (nproc limit), OTTR-1216 (phantom runs).

## Designs compared

1. File-scoped holds: a review holds only merges that touch the files of its
   findings. Rejected: finding cards record no files today, so the design adds
   structured file tracking to every finding path for a benefit the chosen
   design delivers with less state; a broad refactor lands across the store,
   the prompts, and the check paths.
2. A failed review gate becomes a finding card, and the review finishes.
   Rejected as the primary fix: it does not bound rule 3, so the 30 findings
   of OTTR-1186 would still hold every merge after the review finished. It
   also changes the review turn flow (the largest path in `src/turn.ts`) for a
   stall the cap fixes at the scheduler alone. The board already files gate
   failures as cards by hand (OTTR-1191 exists).
3. Reviews run against a frozen ref and never hold merges; findings rebase
   later. Rejected: it drops the release guarantee (a release ships reviewed
   work plus its fixes) with no bound that says when a merge may pass a
   running review, and it removes the sequencing the Review-due counter
   depends on.
4. Cap the count of open findings before a new review starts. Rejected as the
   primary fix: it prevents a future pile-up but does not bound any hold that
   exists today; the 67-card stall survives it.
5. Time-capped review holds, and a finding never waits for a review (chosen).
   Smallest diff: one constant, one exemption, one structured helper. It
   bounds every unbounded stall path in the table above.

## The choice

`src/scheduler.ts` gains two rules; the release hold stays as it is.

1. Time cap. The review-running hold and the findings hold stop gating a
   queued merge once they have held longer than `REVIEW_HOLD_MAX_MS`
   (48 hours). Each hold counts from its review's own anchor: the
   review-running hold from the review card's `createdAt`, the findings hold
   from the review's `doneAt` (its `createdAt` while the review has not
   finished). The anchors overstate the hold age where a card waited in
   `todo` first, so the cap frees a merge no later than the bound.
2. Finding exemption. A card that is a finding of any live review never takes
   the review-running hold or the findings hold. It still takes the release
   hold. This extends the OTTR-940 exemption to rule 2 and closes the cycle
   where a review's gate needs a finding's fix while the review holds that
   finding.

`mergeHold` keeps its return type; an options field `now` turns the cap on.
Callers that gate scheduling pass `now`: `mergeSlot` (`pickRunnable`),
`claimTurn`, `mergePushInFlight`, the board report, and the UI `holdFor`.
Callers without `now` keep the uncapped behavior, which keeps every existing
caller and test stable. A new pure helper `reviewHoldsFor` returns the holds
with their review id, anchor, and cap time; `mergeHold` uses it, and the board
report renders it.

The board report names the review that holds a queued merge and how long it
has held, and gains an "Open reviews" section that lists each open review with
the merges it holds and whether the cap expired.

## Guarantees kept

- One review at a time: `reviewBlocked` still refuses a new review while one
  is open, with no time bound. Two open reviews would hold each other's
  findings and deadlock; the board report names a stuck review, and the
  operator cancels it. This unbounded rule blocks new reviews, not merges.
- A release ships only after its findings: `FINDINGS_HOLD` and
  `UNCHECKED_FINDINGS_HOLD` park the review card itself, and the release hold
  on merges stays uncapped.
- An open release holds merges without a time cap. The release publish already
  lists commits that landed after the review pin as "(not reviewed)"
  (`docs/specs/late-commits-in-release-approval.md`), but the board keeps
  merges out of that window by default.
- Findings of a review merge while that review runs, before unrelated work
  (they are exempt, and the cap has not freed the rest).
- A done review's parked backlog lead never holds (`OTTR-963`), a promoted
  lead never holds (`leadAtDone`), leads and validation runs never hold
  (`OTTR-1128`).
- A finding of another review never takes the findings hold (`OTTR-940`), now
  also never the review-running hold.

## Guarantees dropped

- The next review counts from exactly the commit it saw: after the cap
  expires, unrelated merges land while the review runs. The Review-due counter
  counts the landed commits, and each finding's work turn rebases on current
  main, so the findings still describe work against the tree they merge into.
- Merges wait until a review's findings are implemented: after the cap,
  unrelated work can land before the findings are fixed. A finding that says
  "main is broken" can be overtaken; its implementation still re-verifies.
- Findings merge before everything only until the cap expires; after it, queue
  order decides.

## Acceptance checks

- A sequence test that fails before the fix: an architecture review stays
  `in_progress` with a gate that never passes, and an unrelated queued merge
  still lands once the cap is past, while a merge inside the bound still
  waits (`src/scheduler.test.ts`, through `pickRunnable`).
- A sequence test for the OTTR-940 class: a done review with an open finding,
  and a second review `in_progress`; the finding stays schedulable, so no
  wait cycle between a review, its findings, and the merges they need.
- The board report names the holding review and the hold duration, and lists
  open reviews with their hold impact (`scripts/board-report.test.ts`).
- `bun run check` and `bun test` pass.

## Non-goals

- No mutation-threshold change (OTTR-1191's gate stays as it is).
- No change to review prompts in `src/prompts.ts`.
- No manual cancel of OTTR-1186; the review keeps running.
- No file-scoped holds, no structured files on findings, no change to the
  release hold.

## Decision record

No ADR records the old review-hold decision; it lived in the `mergeHold` doc
comment and in `docs/specs/review-findings-persistence.md`. This spec records
the new decision, and those two texts change in the same commit.
