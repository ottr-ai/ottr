# Leads wait for validation in todo

A needs-validation lead is a card whose prompt carries the "Needs validation" tag
(`isLead`, src/scheduler.ts). Today a review files each lead in stage `backlog`; an
operator move to todo starts it as a plain work turn once `validatedAt` is set.
This change files every new lead in `todo` under a wait marker the scheduler reads
as "waits for validation". Only a confirmed validation result or the operator's
"applies" answer makes the lead a normal work card.

## The waiting form

A lead waits when `waitsValidation` is true. The full form:

- stage `todo`, state `queued`, `queuedAt` set, `needsReason` null, `asked` null
- `waitsValidation: true` (store column `waits_validation`, INTEGER/BIGINT NOT NULL DEFAULT 0)
- `prompt` still starts with "Needs validation", `followUpOf` names the review

The marker never depends on `validatedAt`: a lead with a "still blocked" result
keeps waiting. `pendingSandboxLead` (validatedAt null, sandbox blocker) keeps its
meaning; the marker is the scheduler's hold for both null and set `validatedAt`.

## Store (src/types.ts, src/store.ts, src/postgresSchema.ts)

1. `Task.waitsValidation: boolean` next to `leadAtDone`. Caller-settable: join
   `TASK_COLUMNS` as `waits_validation` so list rows carry it (the `lead_at_done`
   precedent keeps `leadAtDone` out; this one must be writable by update patches).
2. SQLite: `ProjectStore.open` adds the column with the additive `addCol` pattern
   (`ALTER TABLE tasks ADD COLUMN waits_validation INTEGER NOT NULL DEFAULT 0`),
   then converges per row, idempotent on every open:

   ```sql
   -- APPLIED_VALIDATION_OUTCOME_ROWS_SQL (postgresSchema.ts), run by
   -- selectAppliedValidationOutcomeRows for both engines:
   SELECT f.prompt AS prompt, f.id AS finding_order, f.card_id AS card_id,
     c.created_at AS created_at, c.kind AS kind,
     c.follow_up_of AS follow_up_of
   FROM review_findings f
   JOIN tasks c ON c.id = f.card_id
   WHERE f.prompt LIKE 'Validation: #%'
     AND c.kind = 'validation' AND c.stage = 'done'
     AND c.cancelled_at IS NULL;
   -- per legacy row, grouped by its review:
   SELECT id, prompt, details, validated_at, follow_up_of FROM tasks
   WHERE stage = 'backlog' AND cancelled_at IS NULL
     AND prompt LIKE 'Needs validation%';
   -- per row: UPDATE tasks SET stage = 'todo', state = 'queued',
   --   waits_validation = 1, queued_at = updated_at WHERE id = ?
   ```

   `legacyLeadWaits` decides which leads wait. A confirmed or refuted result keeps
   its decision. The operator's applies answer also keeps its decision.
   A never-validated, blocked, or unanswered deployment lead waits.
   A details segment supplies the legacy result when no applied finding exists.
   The scoped reset reads the same legacy result, so Validate now can clear a blocked stamp.
   When `validatedAt` exists without a readable result, the row keeps its decision.
   The per-row decision uses TypeScript, not SQL `LIKE`, to preserve the result order.
   The query does not exclude quoted answer text. `legacyLeadWaits` alone checks the answer marker.
   `Needs-validation lead questions...` does not match the lead prefix because it contains a hyphen.
3. PostgreSQL: the column lives only in a numbered step, never in
   `projectStepOne` — the steps run on fresh databases too, so a stepOne
   column plus the step's ALTER fails with duplicate_column (the
   `source_issue` and `posted_via` precedent). The step runs the same ALTER
   and the same per-row decision as SQLite (`legacyLeadWaits`), one
   transaction with its version record (`CONVERGE_LEAD_WAIT_SQL` is the
   shared per-row write).
4. No new enum value: the stage and state CHECK lists stay untouched, so no
   table rebuild happens.
5. The shared fresh-SQLite vs fresh-PostgreSQL schema comparison test stays green.

## Outcome authority

The bug class is premature outcome authority. Raw findings can exist before transaction commit or validation settlement.
Raw findings must not decide retries, drawer actions, resets, or migration results.

- `onRecorded` stores candidate findings. It does not apply a result to a lead.
- Settlement consumes its own candidate findings through `validationOutcomes`.
- Persisted readers use `selectAppliedValidationOutcomeRows`.
  Its single query admits only non-cancelled validation cards in `done`.
- `ProjectStore.appliedValidationOutcomes(reviewId)` owns the runtime read.
  It uses `this.queue.run` around the query and selection.
  Unrelated reads wait for transaction commit or rollback.
- The route, `taskView`, and reset use this store method.
  SQLite convergence and the PostgreSQL step use the same query before the store admits callers.
- Selection still uses the lead's review, newest run first, and first result per lead within a run.
- The API field `appliedValidationOutcome` contains only this applied result.
  Details retain the legacy result fallback.
- The drawer derives the open run from current board rows on each render.
  Its test changes rows through one React root without another detail fetch.

Assumptions: settlement marks a successful validation card `done`.
Cancelled, stopped, queued, running, and needs-you cards supply no applied findings.
No schema change or validation prompt change is necessary.


## Turn loop (src/turn.ts)

- Filing (the review settle's lead child): the existing update patch gains
  `waitsValidation: true`, `stage: "todo"`, `state: "queued"`, `queuedAt: now`,
  `needsReason: null`. The `createTask` call stays default (todo/queued), so the
  create-to-update window shows a runnable card for milliseconds at worst; the
  OTTR-1128 routing pass stays the safety net.
- `batchableOf` in `filePendingValidationRun`: a lead is batchable when
  `pendingSandboxLead(t)` and (`stage === "backlog"` or `waitsValidation`) and
  not cancelled. `again` widens to `{ before: number; lead?: string }`;
  `resetValidatedLeads` restricts to that lead when set. Its stage gate becomes
  (`stage === "backlog"` or `waitsValidation`).
- `settleValidationResults`: the started-lead branch (details-only recording)
  fires only for a lead that is NOT waiting and sits beyond backlog/idle. A
  waiting lead takes the normal branches; confirmed additionally clears
  `waitsValidation` (false). Refuted and "does not apply" still cancel (the
  OTTR-1227 shapes). Blocked and deployment outcomes keep the marker.
- `routeStartedLeads`: the started filter excludes marker leads; the move-back
  writes the waiting form (todo/queued/queuedAt/marker) instead of backlog, one
  patch, with the same details line and the same file-with-lead-first call.

## Scheduler (src/scheduler.ts)

- `workSlotReady` returns false for `t.waitsValidation` (next to the
  `pendingSandboxLead` check). This guards `pickRunnable` and `pickLowPriority`.
- Leads never hold a review's Done or a release merge: `findingOpen` already
  exempts every lead in any stage (`!isLead`, OTTR-1128) and `reviewHoldFor`
  builds on it. The store's done stamp (`runTaskUpdate`) freezes the same set:
  it stamps open backlog children and waiting todo leads (`stage = 'todo' AND
  waits_validation = 1`) at doneAt, so a confirmed lead whose prompt later
  loses the tag stays exempt like a promoted backlog lead (OTTR-963's rule,
  extended to the todo form). Pinned with sequence tests through the real
  store write.

## Routes (src/app.ts, src/server.ts)

- `POST /api/projects/:project/tasks/:id/validate` gains a lead path: the id
  resolves to a waiting lead, `followUpOf` names a validatable review, and the
  call files with `first = {lead id}` and `again = { before: now + 1, lead: id }`
  (resets only this lead, only a blocked outcome). A deployment decision
  refuses with 409 before the review lookup — the blocker line rides the
  prompt (`deployment fact`), or a recorded deployment outcome overruled a
  sandbox blocker line (newest `Validated by ` segment, `leadValidationOutcome`);
  either way no run can take the lead — its review's question card decides it.
  An open validation run in the project answers 409 with
  `{ error, id: <open run id> }`. Response: the filed run's view plus `reset`.
- `deps.validateLeads` (app.ts) and the server.ts wiring gain the widened
  `again` and an optional `first` parameter, passed to `filePendingValidationRun`.
- The backlog route refuses a waiting lead in both directions (409).
- The steer route refuses a waiting lead (409): a reply must not start a work turn.
- The prompt-edit route refuses a waiting lead (409): an edit that drops the tag
  would strand the marker.
- The review route's legacy `{ lead }` park action refuses marked leads.
  Marked leads use their own Validate now route and retain the todo form.
- The lead answer flow: "applies" clears `waitsValidation` and queues the lead
  (todo/queued/queuedAt, answer appended to the prompt); "does not apply"
  cancels it. The old backlog+idle shape keeps working where it still exists.
- `taskView` adds optional `appliedValidationOutcome` from the serialized store lookup.
  A cancelled or unfinished run cannot supply this value.

## Uncertain deployment answers (OTTR-1350)

The operator selected this flow on 2026-11-28: keep the question open.
An uncertain answer includes "Not sure" and free text.
The reply records the answer in the lead's details but keeps its question in `asked`.
The question card stays at `needs_you` until each live lead receives a definitive answer.
A mixed reply removes only resolved questions and keeps the remaining questions in order.
The existing reply route accepts a later "Applies" or "Does not apply" answer.
"Applies" clears `waitsValidation` and queues work.
"Does not apply" cancels the lead.
Uncertain answers never clear the marker or queue a work turn.

The lead detail response adds optional `deploymentQuestionId: string | null`.
It identifies an open question card in the same project and review whose `asked` includes that lead.
The drawer links directly to that question with "Answer the deployment question".
It does not offer Ask again or link to the review as the decision action.
If no question exists, the drawer states that the question is unavailable.

Assumptions: the lead retains its review link and its blocker or applied deployment result.
Both backends run recovery in the shared `ProjectStore.finishOpen` path after schema initialization.
Recovery preserves the marker and restores questions for unresolved deployment leads.
It reuses an existing open question card, or restores the review's closed question card.
If no question card exists, it creates one with the existing deployment-answer options.
Recovery uses the blocker question or applied result evidence.
If old data loses that text, the question names the lead's risk from its title.
Recovery does not reopen questions for confirmed, refuted, cancelled, done, or applies-answered leads.
It does not change ordinary review cards, sandbox leads, or validation prompts.
Recovery runs in a transaction and remains idempotent after a second store open.
This change needs no schema column or new migration.

Acceptance:

- Real reply-route regressions cover "Not sure" and free text.
- After each uncertain reply, `pickRunnable` never returns the lead.
- A later reply to the same card releases the marker on Applies or cancels on Does not apply.
- A mixed reply retains only unresolved deployment questions.
- SQLite and PostgreSQL store-open tests restore closed legacy questions and cover repeated open.
- The detail response identifies the restored question through the real store reader.
- The drawer link opens that question card and describes this reachable action.
- UI proof includes a screenshot of the lead and its open question.
- `bun run check` and `bun test` both exit 0.

## UI (src/ui/app.tsx)

For a waiting lead the drawer renders:

- a sandbox-blocker lead: exactly two actions, "Cancel task" (existing) and
  "Validate now" (new, posts the lead validate route). "Validate now" is
  disabled with the open run's card id in its title while the current board rows contain an open validation run;
- a deployment decision (blocker line `deployment fact`, or a recorded
  deployment outcome overruling a sandbox blocker line): only "Cancel task".
  No run can take the lead, so there is no Validate now button;
- one hint line under the actions: a sandbox lead links to its review and
  reads "The review #<id> starts this lead's validation run by itself.
  Validate now starts it at once."; a deployment lead links to its open question
  with "Answer the deployment question";
  plus the last validation result and date when `validatedAt` exists.
  An applied finding supplies the result when the details lack a result segment;
- no Move-to-backlog/park button, no Merge anyway, no prompt edit, no reply or
  steer composer, no Start. Gated on `task.waitsValidation`.

## Board report (.agents/skills/check-ottr-board/scripts/board-report.ts)

`Card` gains `waitsValidation?: boolean`; the queued branch returns
`{ verdict: "waits", note: "waits for validation (review #<followUpOf>)" }` for a
waiting lead instead of "queued with no hold found".

## Acceptance (each fails before the fix)

1. A review files its lead in todo with the marker; `pickRunnable` returns it
   neither with `validatedAt` null nor with a blocked result.
2. A confirmed result clears the marker; `pickRunnable` returns the lead.
3. An old-schema database converges its undecided backlog leads to the
   waiting form on open, on SQLite and PostgreSQL: never-validated, still
   blocked, and unanswered deployment leads take the marker; a parked
   confirmed lead, a refuted lead, and an applies-answered lead keep their
   stage and marker; the shared schema comparison stays green. The
   PostgreSQL column lives outside `projectStepOne`, so fresh databases
   initialize without a duplicate column.
4. The validate-now route files with the lead first, answers 409 with the open
   run's id when a run is open — including when the request loses the race and
   the transactional filing refuses, whose 409 carries the same id — resets
   only this lead's `validatedAt` when its newest outcome was blocked (both
   blocked stamps sit before the cutoff, so losing the scope fails the test),
   and refuses a deployment decision — from the prompt's blocker line or from
   a recorded deployment outcome.
5. The drawer renders exactly Cancel and Validate now for a sandbox lead with
   no recorded deployment outcome, and only Cancel plus the question-flow hint
   when the blocker line or the newest recorded outcome says deployment, with
   accessible names; a screenshot is attached.
6. A done release review with a waiting lead in todo does not hold the release
   (mergeHold null) and does not hold its review's Done (findingsOpen false).
   The done stamp covers the waiting todo form, so a confirmed lead whose
   prompt later loses the tag stays exempt (sequence test through the real
   store write and mergeHold).
7. The board report shows the waiting lead as "waits for validation".
8. An unrelated outcome read waits for a yielded transaction and observes no result after rollback.
9. A cancelled run's deployment finding does not prevent a lead retry or classify the drawer as deployment.
10. A lifecycle test checks queued, running, needs-you, cancelled, and done validation cards through the real store.
11. One mounted drawer enables Validate now when a run finishes, then disables it when a new run appears.
12. A legacy lead with quoted answer text still takes the waiting form.
13. The legacy park route and filing transaction refuse marked leads without a state change.
14. The review hint and last result appear below the actions and above Meta.
15. Legacy convergence clears the old grill's `needsReason` and `asked` fields.


## Non-goals

No change to the validation run itself, its prompt text, the batch size, the
confirmed/refuted/blocked/deployment outcomes, or review cards that are not
leads. No change to OTTR-1247's moved-lead work; leads moved before this change
keep the routing pass's net.
