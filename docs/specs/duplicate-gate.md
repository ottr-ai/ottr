# Spec: Duplicate-work gate (OTTR-941)

## Goal

A new task must not repeat work that already exists. Before the first work turn of a card
starts, the duplicate-work gate checks if the work that the task asks for is:

1. already in the code on the integration target (main), or
2. already in another task of the same project that is in progress, is merging, or is a
   done research task without a follow-up.

When the whole work is covered, the gate names the reason and closes (cancels) the new
task. When only a part is covered, the task continues with a note that points at the
overlap.

## Decisions (gate assumptions of the card)

- The verdict is a model judgment. The model gets the task text, code search results from
  the target, and the candidate tasks. It returns a verdict with a reason.
- Only a full match closes the task. A partial match passes and adds an overlap note.
- The close reason goes into the existing `needsReason` field of the cancelled card (the
  same pattern as the lead cancel in `src/app.ts`). It names the matched task ids and the
  matched file paths. `DUPLICATE_REASON` lives in `src/prompts.ts`, so the UI can import
  it. The drawer's needs-reason line renders the task ids of a reason that starts with
  `DUPLICATE_REASON` as card links (`CardIdLinks` in `src/ui/app.tsx`).
- When the gate fails (model error, timeout, bad JSON, git error), the task passes (fail
  open) and the turn log records the error.

## Scope

The gate runs in `runTurn` (`src/turn.ts`) after the turn header and the session identity,
before the prompt gate (`promptGateTurnStart`) and before the worktree. It runs when all
of these are true:

- the turn kind is `work`;
- no identity flag is set (interview, grill, scout, retro, review, release, board check);
- `task.sourcePrNumber === null` and `task.kind !== "pr_review"`;
- this is the card's first implementation start, proven by lifecycle evidence: `stage` is
  `todo`, and the card has no omp session (`sessionId === null`), no `branch`, no
  `worktree`, and no turn row (`store.listTurns(id)` is empty). A null `sessionId` alone
  is no proof: the restart-session route clears it but keeps the turns, the branch and the
  worktree, and cards from before this gate carry no `dup` stamp;
- the card's gate state carries no `dup` stamp: the gate never ran on this card.

Research cards and board-written prompts are in scope. A research card can ask a question
that a done research card already answers.

## Candidate tasks

`dupCandidateTasks(self, tasks)` selects from the same project's task list:

- `cancelledAt === null`, `id !== self.id`;
- `kind === "work"` and `sourcePrNumber === null`: a PR-review card waits `in_progress`
  with the outside PR author's title in its title and prompt, and a source-PR card carries
  outside PR text too. An outsider could word such text to claim every new card as its
  duplicate, so these cards are never candidates;
- not the task that `self` continues (`self.followUpOf` when `self.followUpOfProject` is
  null);
- `stage === "in_progress"`, or `stage === "merging"`, or `stage === "done"` with
  `research === true` and no uncancelled task in the list whose `followUpOf` is its id and
  whose `followUpOfProject` is null;
- newest `updatedAt` first, at most `DUP_CANDIDATE_CAP` (30).

A child on another project's board cannot be seen from this list. Such a research card
counts as "without a follow-up". A todo or backlog card is never a candidate.

`dupCandidate(task)` maps one full `Task` to the data the model sees: `id`, `status`
(`"in progress"`, `"merging"` or `"done research"`), `title`, `prompt` (cap 1200 chars),
`summary` (cap 400) and, for done research only, `report` (cap 1500).

## Model calls (`src/duplicateGate.ts`, prompts in `src/prompts.ts`)

Both calls are tool-free `runGateway` calls on the `@plan` selector, 120 s timeout each,
like the prompt gate. The model never gets a file tool, so it cannot read files outside
the search results.

1. Terms call: `dupTermsSystem` + `dupTermsPrompt(prompt)`. Answer `{"terms":["..."]}`.
   `parseDupTerms` keeps strings 3 to 80 chars after trim, drops duplicates (case
   insensitive), keeps at most 8. Bad JSON or a non-array `terms` throws `RangeError`.
2. Code search: `searchCode({ cwd, ref, terms })` runs read-only git in the project's main
   checkout against the turn header's target ref:
   - `git grep -n -I -i -F --max-count=3 -e <term> <ref> --` (exit 1 = no match, empty);
     at most 20 hits for each term; the `<ref>:` prefix is removed;
   - `git ls-tree -r --name-only <ref>` once, and for each term at most 10 paths that hold
     the term (case insensitive), with `line: null`;
   - hits are deduplicated, line text is capped at 200 chars, at most 120 hits in total;
   - any other non-zero git exit throws an `Error` that names git's stderr.
3. Verdict call: `dupVerdictSystem` + `dupVerdictPrompt(prompt, hits, candidates)`. The
   task, the hits and the candidates are labelled untrusted data blocks. Answer:

   ```json
   {"verdict":"duplicate"|"partial"|"new","matches":[{"kind":"code"|"task","ref":"<file:line or task id>"}],"reason":"<one line>"}
   ```

   `parseDupVerdict(raw, { taskIds, paths })` accepts one markdown fence, then checks:
   `verdict` is one of the three values; `reason` is a non-empty string (cap 500);
   `matches` is an array (at most 10 kept, refs capped at 200); each `task` ref is in
   `taskIds`; each `code` ref is `<path>` or `<path>:<line>` with `<path>` in `paths` (the
   paths of the search hits); `duplicate` and `partial` carry at least one match; `new`
   carries none. Any violation throws `RangeError`, so the gate fails open.

`duplicateCheck(o)` runs the three steps and returns the `DupVerdict`. The turn loop calls
it through the `ops.duplicateCheck` seam, so tests never spawn a gateway.

The judged text (`prompt` of the seam) is `gateEffectiveText(task.prompt, pending)`: the
task text plus the queued `pendingPrompt` when `pendingBy` is not `"supervisor"`. A steer
before the first start can add requirements, so the gate must judge it too.

## Outcomes

`dupMatchText(verdict, candidates)` joins the matches: a task as `<id> (<status>)`, code as
its ref, comma-separated.

| Verdict | Card write (one transaction; only while `state === "preparing"` and uncancelled) | Log line | Turn |
|---|---|---|---|
| `duplicate` | `cancelledAt: now`, `state: "idle"`, `needsReason: dupCloseReason(...)`, gate `dup: { verdict: "duplicate", note }` | `! <reason>` | stops |
| `partial` | gate `dup: { verdict: "partial", note: dupOverlapNote(...) }` | `+ duplicate gate: partial overlap: <note>` | continues |
| `new` | gate `dup: { verdict: "new" }` | `+ duplicate gate: no duplicate found` | continues |
| error | gate `dup: { verdict: "error" }` | `! duplicate gate: <cause>` | continues (fail open) |
| `duplicate`, stale | gate `dup: { verdict: "error", note: <why> }` | `! duplicate gate: verdict dropped: <why>` | continues (fail open) |

A `duplicate` verdict holds only for the text and the task list that the model saw. The
transaction that closes the card re-reads both and drops the verdict ("stale") when:

- `prompt`, `pendingPrompt` or `pendingBy` changed since the gate read them
  (`the task text changed during the check`), or
- `staleDupMatches(current, verdict, candidates, await store.listTasks())` names a task
  match that is gone, is no candidate anymore (cancelled, left the candidate stages, or a
  done research card that gained a follow-up), or has another status than the model saw
  (`matched tasks changed during the check: <ids>`).

- `dupCloseReason` = `Duplicate work gate: <reason> Matches: <dupMatchText>`.
- `dupOverlapNote` = `<reason> Matches: <dupMatchText>`.
- A stamp write that finds the card cancelled or no longer preparing stops the turn.
- The card has no worktree and no branch yet, so the close needs no cleanup.

## Gate state (`src/types.ts`, `src/store.ts`)

`PromptGateState` gains one optional field, stored in the existing `gate` JSON column (no
schema change):

```ts
/** The duplicate-work gate's stamp (OTTR-941); absent = the gate never ran on this card. */
dup?: DupGateStamp;

export interface DupGateStamp {
  verdict: "duplicate" | "partial" | "new" | "error";
  /** The overlap note (partial) or the close reason (duplicate). */
  note?: string;
}
```

`parseGate` keeps a valid `dup` and drops an invalid one. A card with no gate state gets
`{ hash: null, seen: null, fails: 0, sig: null, parked: false, dup }`.

Every writer that replaces the gate object keeps the current `dup` stamp: the prompt gate
pass, `parkGate`, the Start anyway reply in `src/app.ts`, and `replayGateParks`. Without
this, a prompt gate park would drop the stamp and the gate would run again.

## Work turn note

`gateAssumptionsBlock(gate)` adds this line when `gate.dup.verdict === "partial"`:

`The duplicate-work gate found a partial overlap with existing work: <note>`

The block keeps its untrusted-data header. The closing line ("List in your ready report
the gate assumptions you used.") is added only when the block holds assumptions or an
adopted check, so the existing block text stays byte-identical.

## Acceptance checks

`src/turn.test.ts`, through the `ops.duplicateCheck` seam:

1. A verdict `duplicate` with a code match closes the new card: `cancelledAt` is set,
   `state` is `idle`, `needsReason` starts with `Duplicate work gate: ` and names the path;
   no worktree and no omp run.
2. A verdict `duplicate` with a task match on an in-progress card closes the new card, and
   the reason names that task id with `(in progress)`.
3. A verdict `new` lets the card through untouched: the turn runs, `cancelledAt` stays
   null, and `needsReason` stays null.
4. A done research card that has a follow-up is not in the candidates that the seam gets.
   A done research card without a follow-up, an in-progress card and a merging card are.
5. A thrown seam error lets the card through (fail open) and logs `! duplicate gate:`.
6. A partial verdict lets the card through, and the work prompt carries the overlap note.
7. A card with a `dup` stamp, or with a session, never calls the seam again. A card that
   restart-session reset (in progress, a turn row, a worktree, no session, no stamp) and a
   todo card with an earlier turn row never call the seam.

`src/duplicateGate.test.ts`: candidate selection, `parseDupTerms`, `parseDupVerdict`
(examples and one fast-check property: no input throws anything but `RangeError`, and an
accepted verdict only names known task ids and known paths), and `searchCode` against a
real git repository fixture (the live git reader, not a stub).

## Non-goals

- No other UI change: the drawer already shows `needsReason` of a cancelled card; only the
  card-id links of the duplicate reason are new.
- No re-check of a card that already has a session, and no re-check after a prompt edit.
- No search in other projects' boards or in todo or backlog cards.
- No automatic merge of the new task's text into the matched task.

## Risks

- A candidate's text can try to steer the verdict (prompt injection). Mitigations: the
  model has no tools, the inputs are labelled untrusted data, a task match must name a
  real candidate id, a code match must name a path from the search hits, and only a full
  match closes. The cancelled card keeps its prompt, so the user can file it again.
- A false `duplicate` closes a wanted task. The reason names the matches, so the user can
  check them.
- Cost: two extra model calls for each new card.
