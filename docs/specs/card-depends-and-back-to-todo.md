# Card dependsOn editing and Back to todo

Status: implemented (OTTR-1318). The operator can change which cards an existing
card waits for, and can move a parked in-progress card back to the todo lane,
without cancelling the card and filing it again.

## Background

`dependsOn` was create-time only (`validateDependsOn` at create; OTTR-34/708).
A card that waited for another card and also parked at `needs_you` could not be
rewired: the operator had to cancel the card and file a new one, losing the id,
the turn history and the lineage. `POST …/backlog` moved cards only between
`backlog` and `todo`.

## Behavior

### 1. Edit dependsOn — `POST /api/projects/:project/tasks/:id/depends-on`

Body: `{ "dependsOn": string[] }`. The list replaces the card's `dependsOn`
(deduplicated, order preserved). An empty list removes all dependencies.

- Reuses `validateDependsOn` (`src/app.ts`): same-project ids and `PREFIX-n`
  handles, existence across the board's projects. In this route its 404 for an
  unknown id is answered as **400** — the card exists, the body names bad
  dependencies.
- Rejects with **400**: a non-array or non-string entry (shape), an id that
  names this card itself, and a cycle — the new list must not let the card
  reach itself through `dependsOn` links of resolvable cards on any project.
  A cycle through a cancelled or done card is still rejected: the edit keeps
  the dependency graph acyclic.
- Allowed for every card that is not `done`, not cancelled, and whose run is
  not `running` or `preparing`. Refusals: cancelled → 404 (`task is
  cancelled`), stage `done` → 409, state `running`/`preparing` → 409. A
  `queued` card (including a usage-limit hold) may edit its list.
- Success answers the task view with the stored list. The scheduler reads the
  new list on its next tick: a queued card with an open dependency keeps
  waiting (`depHold` in `src/scheduler.ts`); a held card with every dependency
  satisfied starts.

### 2. Back to todo — `POST /api/projects/:project/tasks/:id/backlog` with `{ "to": "todo" }`

The existing route gains a second source: a stage `in_progress` card in state
`needs_you` or `idle` moves back to `todo`/`queued`.

- Allowed only when the card holds no work: the worktree, if one exists, must
  be clean (`git status` empty) and hold no commits past its base/target
  (`unsavedWork` in `src/worktree.ts`). Otherwise the route answers **409**
  with the reason (uncommitted changes, N commits not on target, or the
  unreadable-tree reason), and the card keeps its worktree — cancel stays the
  path for cards with work.
- Before any state write the route refuses 409 when a reply or steer is still
  queued (`pendingPrompt`), or when the state is `queued`, `preparing`, or
  `running`.
- On success the route removes the clean worktree and its branch
  (`removeWorktree`), then writes: stage `todo`, state `queued`, `queuedAt`
  set, `holdUntil` null, `needsReason` null, `asked` null, `sessionId` null,
  `worktree` null, `branch` null, `keptFiles` empty, work-check send-back
  counter and head/report cleared — so the next start is a fresh work turn in
  a fresh session. Kept: id, prompt, turn history, lineage
  (`followUpOf`/`followUpOfProject`/`updateIds`), `starred`, `dependsOn`,
  model, priority, notes, and the check log. The card then starts as a fresh
  work turn when its dependencies are done.
- `backlog → todo` (promote) keeps its current behavior; `todo → backlog`
  (park) keeps its current behavior; `merging`/`done` cards stay ineligible.

### 3. UI (drawer)

- A dependsOn editor: the card's ids, each removable; an input adds an id;
  save posts the new list to the depends-on route; validation errors render
  inline next to the field. Shown for cards that are not done and not
  cancelled.
- A **Back to todo** action in the drawer actions row for eligible cards
  (stage `in_progress`, state `needs_you` or `idle`), with a short hint that
  it is available only when the card holds no work. A 409 (the card holds
  work) surfaces as an inline error; the card stays untouched.
- Both keyboard- and screen-reader-accessible (WCAG 2.1 AA, `DESIGN.md`).

## Non-goals

- No change to dependency resolution or scheduler ordering.
- No back to todo for cards with commits or uncommitted files.
- No schema change (the fields used exist).
- No new npm dependency. No new `src/prompts.ts` wording.

## Acceptance checks

1. Route test: setting `dependsOn` on an in-progress/needs-you card stores the
   list; an unknown id, a self reference and a cycle answer 400; a running
   card answers 409. Fails before the change (no route).
2. Sequence test: a card moved back to todo whose `dependsOn` names an open
   card stays queued, and starts after that card is done.
3. Route test: back to todo on a clean needs-you card gives `todo`/`queued`
   with the same id and no worktree; a card with a commit or an uncommitted
   file answers 409 and keeps its worktree.
4. UI test and screenshots (light and dark) of the drawer editor and the
   action.

## Alternatives considered

- A separate `POST …/tasks/:id/todo` route for back to todo: rejected — the
  backlog route already owns the `to` movement vocabulary and its
  validation.
- Reporting unknown dependsOn ids as 404 like the create route: rejected —
  the edited card exists, so the list content is invalid input (400), which
  is also the shape the acceptance check pins.

## Risks

- A cross-project cycle can only be detected while both cards' projects are on
  the board; an id the resolver cannot reach counts as satisfied at
  scheduling, so the walk treats it the same way (no cycle through it).
- `unsavedWork` reads the worktree live; a run that starts between the check
  and the state write could dirty the tree. The eligible states
  (`needs_you`, `idle`) have no live run, and the state write re-checks the
  snapshot (`withTask`), so the window is the check's own read span.
