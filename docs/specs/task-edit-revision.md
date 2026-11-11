# Spec: Task edit revision (optimistic locking for card edits)

Card OTTR-795 (P2), from the OTTR-736 engineering audit (topics 36 "Optimistic
Locking" and 39 "Race Conditions"), recommended step 6. Filed by OTTR-790.

## Problem

`ProjectStore.updateTask` (`src/store.ts`) matches on `id` only. A board edit
reads the card, then writes a patch. Two browser tabs (or the board and an API
client) that edit the same card overwrite each other with no warning: the last
write wins.

## Decision: a monotonic `revision` column

The card says to prefer `updated_at` as the revision only if every write
changes it and same-millisecond writes are safe. Both fail: `updated_at` is a
millisecond `Date.now()`, so two writes in the same millisecond produce the
same value, and a stale-edit check could pass across an intervening write.
The store therefore adds a per-row counter.

One exception keeps the editor honest: the prompt-edit hold claim
(`/edit/start`) and its release (`/edit/stop`) are contentless bookkeeping and
never move the revision. The claim itself accepts an optional guarded
`revision` (same rules as the five edit routes), so a content edit that lands
between the editor's load and the claim refuses the claim — a stale draft
never arms with a fresh revision. The editor keeps Save disabled until its
claim lands, and a failed claim disarms the save.

- `TASKS_DDL` gains `revision INTEGER NOT NULL DEFAULT 1` (last column, after
  `update_merge_approved`).
- `ProjectStore.open` gains the matching additive migration next to the other
  `tasks` column migrations. `addColumn` converges a database whose `tasks`
  table lacks the column; read the `shots` column precedent and the
  `work_check_log` comment about the state-CHECK rebuild before choosing the
  exact placement. Requirements: an old database without the column converges
  on open with no duplicate-column error, and no CHECK rebuild re-queues the
  ALTER on the next open.
- `Task` and `TaskRow` gain `revision: number`; `toListedTask` maps it;
  `TASK_LIST_COLUMNS` gains `"revision"` (list rows must carry it so the board
  can send it back).
- `TaskPatch` omits `revision`: callers can never set it directly.
- `createTask` needs no change: the INSERT omits the column, so new rows start
  at the default 1.

## Store API (`src/store.ts`)

```ts
export type RevisionResult =
	| { ok: true; task: Task }
	| { ok: false; task: Task };

// Signature unchanged for every internal writer; the write bumps revision
// (`revision = revision + 1` in the same UPDATE) — except the prompt-edit hold
// claim and release below, which are contentless and never move it.
updateTask(id: string, patch: TaskPatch): Task;

// Rewrites the prompt like today (title re-derives, prompt-edit hold clears in
// the same write). With expectedRevision the write only lands when the row's
// current revision still equals it.
editTask(id: string, prompt: string, expectedRevision?: number): RevisionResult;

// Optimistic write for user edits from routes.
updateTaskIfCurrent(id: string, patch: TaskPatch, expectedRevision: number): RevisionResult;

// The prompt-edit hold: guarded (when expectedRevision is given) and contentless
// (never moves the revision); release clears it unconditionally, also contentless.
claimPromptHold(id: string, holdUntil: number, expectedRevision: number | null): RevisionResult;
releasePromptHold(id: string): void;
```

Rules:

- One atomic statement. The compare and the write are a single
  `UPDATE tasks SET updated_at = ?, revision = revision + 1, ... WHERE id = ?
  AND revision = ?`, never a read followed by a conditional write. Conflict
  detection uses the statement's `changes` count (`bun:sqlite` run result, or
  `SELECT changes()`).
- With the expected revision current: the write lands, `revision` moves to
  `expectedRevision + 1`, stage/state transitions record events as today, and
  the result is `{ ok: true, task }`.
- With a stale revision: nothing is written (the first writer's values
  survive, including `updated_at` and `revision`), no events are recorded, and
  the result is `{ ok: false, task }` where `task` is the row as it stands now
  (the route answers 409 with it).
- Unknown id: still throws `unknown task: <id>` like `updateTask`, before any
  write.
- Without an expected revision (`updateTask`, `editTask` without the third
  argument): today's unconditional write, `{ ok: true, task }` from `editTask`.
  Internal writers (scheduler, turn loop, watchers, quota sweep, release
  flow) never pass a revision and never fail on one.

## Route contract (`src/app.ts`)

Request bodies of the guarded routes accept an optional `revision` field:

- Absent: today's behavior. Browser extension and API-key clients keep
  working.
- Present but not a positive integer: `400` `{ "error": "revision must be a
  positive integer" }`.
- Present and stale: `409` with the current card in the body:
  `{ "error": "card changed since it was loaded", "task": <current TaskView> }`.

Shared helper, used by the guarded routes:

```ts
/** Applies a user card edit guarded by the revision the client loaded. */
function applyUserEdit(e: Entry, task: Task, patch: TaskPatch, body: Record<string, unknown>): Response | Task
```

The `/edit` route keeps using `editTask` (the prompt patch — title re-derive
and hold clears — stays in the store) and passes the revision through it.

### Route inventory: every `updateTask`/`editTask` caller in `src/app.ts`

| Handler / writer (line at writing) | Writes | Gets the check |
| --- | --- | --- |
| quota hold release sweep (504) | hold clears for a provider | No — internal sweep |
| `createUpdateCards` (2828) | update-card link on creation | No — internal sync with create |
| `fileRemoveCard` (2862) | update-card link on creation | No — internal sync with create |
| `fileArchReview` (3287) | review base sha | No — internal sync |
| `handlePOSTProjectsTasksRefileByProjectAndId` (6459) | PR fields on refile child | No — internal sync |
| `handlePOSTProjectsTasksModelByProjectAndId` (6501) `/tasks/:id/model` | model choice | **Yes** |
| `handlePOSTProjectsTasksSteerEditByProjectAndId` (6530) `/tasks/:id/steer/edit` | queued steer text | **Yes** |
| `handlePOSTProjectsTasksSteerCancelByProjectAndId` (6559) `/tasks/:id/steer/cancel` | withdraws queued steer text | **Yes** (same field as steer edit) |
| `handlePOSTProjectsTasksUnmarkByProjectAndId` (6841) | research flag off | No — boolean toggle |
| `handlePOSTProjectsTasksRestartByProjectAndId` (6922) | session reset | No — session management |
| `handlePOSTProjectsTasksStarByProjectAndId` (6948) | star | No — boolean toggle |
| `handlePOSTProjectsTasksEditStopByProjectAndId` (6971) | editor closed, hold clears | No — contentless release |
| `handlePOSTProjectsTasksEditStartByProjectAndId` (7006) | editor opened, hold claimed | **Yes** (optional guard, like the five) |
| `handlePOSTProjectsTasksReleaseByProjectAndId` (7964) `/tasks/:id/release-notes` | release notes | **Yes** |
| `backlogToTodo` (8301) | stage move + server-derived prompt fold | No — stage precondition already rejects the second writer |
| `backlogToPark` (8327) | park to backlog | No — state transition |
| `handlePOSTProjectsTasksGrillByProjectAndId` (8378) | queue grill | No — action, not content |
| `applySteer` (8424) | queues reply/steer | No — merges with `queuedReply`, does not overwrite |
| `followUpImages` (8519, 8551, 8563) | follow-up setup/cancel stamps | No — internal |
| `handlePOSTProjectsTasksMergeByProjectAndId` (8773) | merge-ask answer | No — ask flow |
| `applyWorkCheckSendBack` (8817) | queues send-back | No — ask flow |
| `workCheckAskReply` (8854) | work-check ask answer | No — ask flow |
| `holdApprovalReply` (8905) | hold approval | No — ask flow |
| `handlePOSTProjectsTasksReplyByProjectAndId` (8982) | queues reply | No — merges, does not overwrite |
| `handlePOSTProjectsTasksTriageByProjectAndId` (9054) | applies a triage proposal patch | No — server-derived patch, guarded by card state |
| `handlePOSTProjectsTasksEditByProjectAndId` (9106) `/tasks/:id/edit` | prompt rewrite (via `editTask`) | **Yes** |
| `saveTaskImages` (9386, 9389) | image sync, cancel stamp | No — internal |
| `applyTaskCreateExtras` (9454, 9460, 9462) | create sync | No — internal sync with create |
| `createReleaseCard` (9664) | release card setup | No — internal sync with create |

Guarded routes: prompt edit (`/edit`), steer edit (`/steer/edit`), steer
cancel (`/steer/cancel`), model choice (`/model`), release notes
(`/release-notes`), and the editor's hold claim (`/edit/start`, optional
guard). These are the routes where a person writes card content — or, for the
hold claim, where the write must not slip past a content edit that landed
first.

## Board UI (`src/ui`)

- Every guarded edit request sends `revision: task.revision` — the value the
  card had when the editor loaded it (list rows carry it via
  `TASK_LIST_COLUMNS`). The prompt editor arms from the row it opened on and
  its hold claim carries that same revision; because the hold is contentless,
  the armed revision stays the draft's snapshot until a real content edit
  conflicts.
- The prompt editor's Save stays disabled until its hold claim landed, and a
  failed claim disarms the save: a stale draft never saves silently.
- On a 409 answer the editor stays open with the user's text intact, a visible
  notice says the card changed while the user was editing, and the notice
  shows the board's current version of the edited content (from the 409 body's
  `task`) next to the kept text, so the user can compare and re-apply. The
  notice lives in an `aria-live="polite"` region and meets WCAG 2.1 AA
  (DESIGN.md "Accessibility").
- Other error answers keep today's behavior.

## Acceptance checks

- Store tests (`src/store.test.ts`):
  1. a write with the current revision passes and moves the revision;
  2. a write with an old revision changes nothing and reports the conflict
     (returned task is the current row; first writer's values survive);
  3. internal writes without a revision always pass;
  4. an old-schema database without the column converges on open (fixture
     pattern of the existing migration tests, `src/store.test.ts` "preparing
     migration" / the 4618 convergence test), the row survives, and the first
     write moves the revision.
- Route tests (`src/app.test.ts`):
  1. a stale edit answers `409` with the current card in the body, and the
     stored value is the first writer's value;
  2. an edit without a revision still works;
  3. an edit with the current revision works.
  Cover at least the `/edit` route (the `editTask` path) and one
  `applyUserEdit` route (`/release-notes`).
- A UI proof: a screenshot of the conflict message (README "Screenshot proofs
  for UI cards").
- README (or API docs) names the `revision` field and the 409.

## Non-goals

- Field-level merge of two edits.
- Live collaborative editing.
- A revision check for scheduler or turn-loop writes.
