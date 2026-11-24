# Spec: Review holds must not stall the project

One review, its findings, and its gates must never stop every other merge for
days. This spec records the measured stall of 2026-11-22 to 2026-11-24, the
rules that caused it, the designs compared, and the chosen fix.

## Measured history (live board, 2026-11-24)

Reachable sources from this work container: the card logs under
`/data/ottr/logs` (2 102 files; the 1 234 display-id logs run 2026-10-14 to
2026-11-24) and the operator's live-board measurements of 2026-11-24 13:50
UTC. The live task store is not readable from here, and the attempts are part
of the record: the store moved to the server volume (`tasks.db.moved-to-server`
is a 2026-10-26 snapshot whose ids stop at OTTR-185, before OTTR-943), the
HTTP API serves task state to direct loopback only, the board token this
container carries files cards (`POST /api/projects/:p/tasks` with
`x-board-token`) and reads nothing, and the read path's `apiKey` sits in the
sealed server settings. Per-card stage rows are therefore not readable; every
number below names the source it came from.

Finding attribution comes from the review logs: when a review turn settles, it
writes one `- filed ... #OTTR-n` summary line per finding card. Three reviews
filed in the log era: OTTR-969 (59 findings, its one turn started
2026-11-15T16:02:20Z), OTTR-943 (5 findings, turns 2026-11-14T14:12:53Z and
21:50:56Z), and OTTR-1186 (2 findings so far, filed in its second turn
2026-11-22T14:52:15Z, among them lead OTTR-1196). Work logs quote these lines
as tool output, so filers are read only from lines that start with `- filed`
in the filing card's own log.

### Findings filed versus finding merges per week, since OTTR-943

OTTR-943's first turn is the range anchor: 2026-11-14, ISO week 2026-W46.
A finding counts as merged in the week of the first `== merge turn` header in
its own log; a finding the log shows neither filed-for-merge nor cancelled
stays in the open column of the net line, so the net is an upper bound on
open (cancellations are store rows this container cannot read; the operator's
live count pins the true open set below).

| Week | Review findings filed | Finding merges seen |
|---|---|---|
| 2026-W46 (Nov 9-15) | 64 (OTTR-969: 59, OTTR-943: 5) | 4 |
| 2026-W47 (Nov 16-22) | 2 (OTTR-1186's two settle filings) | 18 |
| 2026-W48 (Nov 23-24) | 0 | 1 |

Net filed minus merged over the range: 66 − 23 = 43. That matches the
operator's live measurement at 2026-11-24 13:50 UTC: 43 of the 67 held merges
were findings of earlier reviews, 37 of them OTTR-969's open children. Whole
board, merges of any card ran as before, until the stall (log headers
`== merge turn`):

| Week | Merge turns, whole board |
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

Work-turn headers overcount starts (37 cards of the "Needs validation" batch
carry 500 to 1 059 repeated headers each), so they are not tabulated.

### The stall's hold, per merge

One hold edge caused the stall: the review OTTR-1186 in `in_progress` gates
every queued merge under the rule `waiting for the review to finish`. Its
hold began when the review's turn started, 2026-11-22T12:20:41Z (first log
header, base `d60e96dd24ebb91bd93ddc9422a755566d5026e55`); the earliest
observable wait on a held card is OTTR-938's last work turn,
2026-11-22T14:35:01Z, and the operator's oldest queued wait started
2026-11-22 14:55 UTC. At the 2026-11-24 13:50 UTC measurement every card in
the table had waited about 2.0 days on this one hold. The gate card
OTTR-1191 (its own turn started 2026-11-22T13:52:18Z) held the review open:
its log shows the full-mutation chain at 79 percent after 15 h 27 min against
a break threshold of 90, with kills from turn and session lifecycles (host
restarts), and the review had recorded 30 findings that become cards only
when its turn ends, so finishing it would move it to merging and re-hold
these merges under the findings hold.

The 67 held merges (operator's live snapshot; each row: the finding parent
from the review logs' settle lines, the card's last log turn, and the days
its log has sat idle at the 2026-11-24 measurement):

| Card | Finding of | Last turn (UTC) | Idle days |
|---|---|---|---|

| OTTR-938 | - | 2026-11-22T14:35:01 | 2.1 |
| OTTR-1202 | - | 2026-11-22T17:55:25 | 2.0 |
| OTTR-1200 | - | 2026-11-22T17:55:25 | 2.0 |
| OTTR-1198 | - | 2026-11-22T17:55:24 | 2.0 |
| OTTR-1167 | - | 2026-11-22T17:51:04 | 2.0 |
| OTTR-1024 | OTTR-969 | 2026-11-22T17:55:26 | 2.0 |
| OTTR-988 | OTTR-969 | 2026-11-22T17:51:30 | 2.0 |
| OTTR-985 | OTTR-969 | 2026-11-22T17:55:23 | 2.0 |
| OTTR-1205 | - | 2026-11-22T21:07:14 | 1.9 |
| OTTR-1203 | - | 2026-11-22T17:54:52 | 1.9 |
| OTTR-986 | OTTR-969 | 2026-11-22T17:55:26 | 1.9 |
| OTTR-1210 | - | 2026-11-22T22:03:06 | 1.8 |
| OTTR-1217 | - | 2026-11-23T00:54:19 | 1.7 |
| OTTR-1216 | - | 2026-11-22T22:41:18 | 1.7 |
| OTTR-1215 | - | 2026-11-22T22:41:15 | 1.7 |
| OTTR-1214 | - | 2026-11-22T22:29:38 | 1.7 |
| OTTR-1212 | - | 2026-11-23T00:48:09 | 1.7 |
| OTTR-1211 | - | 2026-11-23T00:54:39 | 1.7 |
| OTTR-1209 | - | 2026-11-23T00:16:26 | 1.7 |
| OTTR-1219 | - | 2026-11-23T02:25:16 | 1.6 |
| OTTR-1147 | - | 2026-11-23T11:27:27 | 1.3 |
| OTTR-1224 | - | 2026-11-23T13:37:05 | 1.2 |
| OTTR-1225 | - | 2026-11-23T15:05:51 | 1.1 |
| OTTR-1223 | - | 2026-11-23T15:43:35 | 1.1 |
| OTTR-1156 | - | 2026-11-23T15:14:24 | 1.1 |
| OTTR-1185 | - | 2026-11-23T16:18:23 | 1.0 |
| OTTR-1030 | OTTR-969 | 2026-11-23T17:28:22 | 1.0 |
| OTTR-1025 | OTTR-969 | 2026-11-23T17:00:18 | 1.0 |
| OTTR-1023 | OTTR-969 | 2026-11-23T17:00:16 | 1.0 |
| OTTR-1020 | OTTR-969 | 2026-11-23T17:00:16 | 1.0 |
| OTTR-1016 | OTTR-969 | 2026-11-23T17:00:15 | 1.0 |
| OTTR-1014 | OTTR-969 | 2026-11-23T17:00:13 | 1.0 |
| OTTR-1013 | OTTR-969 | 2026-11-23T18:43:39 | 1.0 |
| OTTR-1011 | OTTR-969 | 2026-11-23T16:40:56 | 1.0 |
| OTTR-1002 | OTTR-969 | 2026-11-23T16:40:53 | 1.0 |
| OTTR-1001 | OTTR-969 | 2026-11-23T16:40:53 | 1.0 |
| OTTR-1240 | - | 2026-11-23T19:45:24 | 0.9 |
| OTTR-1239 | - | 2026-11-23T19:33:45 | 0.9 |
| OTTR-1237 | - | 2026-11-23T18:56:49 | 0.9 |
| OTTR-1233 | - | 2026-11-23T18:20:30 | 0.9 |
| OTTR-1039 | OTTR-969 | 2026-11-23T20:25:11 | 0.9 |
| OTTR-1038 | OTTR-969 | 2026-11-23T20:03:21 | 0.9 |
| OTTR-1037 | OTTR-969 | 2026-11-23T19:19:40 | 0.9 |
| OTTR-1034 | OTTR-969 | 2026-11-23T19:41:35 | 0.9 |
| OTTR-1029 | OTTR-969 | 2026-11-23T16:51:55 | 0.9 |
| OTTR-1027 | OTTR-969 | 2026-11-23T19:41:28 | 0.9 |
| OTTR-1019 | OTTR-969 | 2026-11-23T17:00:15 | 0.9 |
| OTTR-1017 | OTTR-969 | 2026-11-23T21:04:08 | 0.9 |
| OTTR-1015 | OTTR-969 | 2026-11-23T19:27:43 | 0.9 |
| OTTR-1012 | OTTR-969 | 2026-11-23T18:59:45 | 0.9 |
| OTTR-1009 | OTTR-969 | 2026-11-23T19:00:35 | 0.9 |
| OTTR-1006 | OTTR-969 | 2026-11-23T19:00:35 | 0.9 |
| OTTR-1004 | OTTR-969 | 2026-11-23T19:47:17 | 0.9 |
| OTTR-1003 | OTTR-969 | 2026-11-23T19:13:41 | 0.9 |
| OTTR-1000 | OTTR-969 | 2026-11-23T16:40:52 | 0.9 |
| OTTR-1245 | - | 2026-11-23T23:07:25 | 0.8 |
| OTTR-1238 | - | 2026-11-23T21:28:29 | 0.8 |
| OTTR-1227 | - | 2026-11-23T21:04:12 | 0.8 |
| OTTR-1035 | OTTR-969 | 2026-11-23T20:59:39 | 0.8 |
| OTTR-1022 | OTTR-969 | 2026-11-23T20:46:43 | 0.8 |
| OTTR-998 | OTTR-969 | 2026-11-23T21:04:15 | 0.8 |
| OTTR-1246 | - | 2026-11-24T08:47:24 | 0.4 |
| OTTR-1244 | - | 2026-11-24T08:57:35 | 0.4 |
| OTTR-1086 | - | 2026-11-24T08:47:21 | 0.4 |
| OTTR-1026 | OTTR-969 | 2026-11-24T08:47:10 | 0.4 |
| OTTR-1010 | OTTR-969 | 2026-11-24T08:47:08 | 0.4 |
| OTTR-1031 | OTTR-969 | 2026-11-24T09:16:10 | 0.3 |

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
