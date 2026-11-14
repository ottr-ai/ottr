# Ask drafts on the server

## Behavior

An ask with two or more questions collects answers before one reply sends them all. The panel keeps the selected answers as a draft. Before this change, the draft lived only in the browser's `localStorage` (`ottr.ask.drafts`). Now the server keeps the draft too, so a fresh browser or a second device shows the same selections.

- Each change of a selection (pick, typed answer, cleared answer) writes the draft to `localStorage` at once and sends it to the server after a 500 ms debounce. Closing the panel (drawer close, unmount) sends a pending save at once.
- A draft carries `at`, the client time in milliseconds of the change. A new `at` is always larger than the `at` of the draft on screen, so a server draft from a device with a clock that runs ahead cannot make the next local change look older.
- When the panel opens, it shows the local draft at once and then reads the server draft. The draft with the larger `at` wins. A draft whose fingerprint `fp` (the newline-joined question texts) does not match the current ask is ignored.
- `localStorage` stays as the offline cache: a failed save keeps the local draft. The next change sends the full draft again. When the panel opens and the local draft is newer than the server draft, the panel sends the local draft to the server.
- A successful reply deletes the server draft. The client also drops the local draft and cancels a pending save.
- A one-question ask sends on the first answer and keeps no draft (unchanged).

## API

- `GET /api/projects/:project/tasks/:id/ask-draft` returns `200 { draft: { fp, answers, at } | null }`.
- `POST /api/projects/:project/tasks/:id/ask-draft` with body `{ fp: string, answers: { [index]: string }, at: number }` upserts the draft and returns `200 { draft }` with the stored row. When the stored row has the same `fp` and a larger `at`, the request changes nothing. The response then carries the stored (newer) draft. A stored row with a different `fp` comes from an earlier ask round, and the request always replaces it.
- Errors:
  - unknown project or task: 404, bad task id: 400 (same as the other task routes, `resolveTask`).
  - the task has no outstanding ask (`asked === null` or state is not `needs_you`), or the task is cancelled: 409.
  - the body `fp` is not the fingerprint of the task's current ask (a delayed save from an earlier round): 409.
  - The store checks the task (open ask, state, cancel, fingerprint) in the same queued write step as the draft write. An ask change that commits before the save therefore refuses the save.
  - bad body: 400. `fp` is a string of at most 20000 characters. `answers` is an object of at most 50 entries. Each key is a non-negative integer index in decimal form. Each value is a string of at most 20000 characters. `at` is a positive safe integer.
- `POST /api/projects/:project/tasks/:id/reply` deletes the draft row after a 2xx response.

## Storage

Per-project table, created by `SCHEMA` at open (an existing database gains it without a migration step):

```sql
CREATE TABLE IF NOT EXISTS ask_drafts (
  task_id TEXT PRIMARY KEY,
  fp TEXT NOT NULL,
  answers TEXT NOT NULL,
  at INTEGER NOT NULL
);
```

`answers` holds the JSON object. Within one `fp`, the upsert keeps the row with the larger `at`.

The client caps a new `at` at `Number.MAX_SAFE_INTEGER`. A local draft from an older build has no `at`, and the client reads it as `at: 1`. It then wins over an absent server draft and gets uploaded.

## Acceptance checks

- Select answers without sending, open the board in a fresh browser: the selections come back from the server.
- The save request reaches `POST .../ask-draft`, and `ask_drafts` holds the row.
- A successful reply leaves no `ask_drafts` row for the task.
- `bun test` covers the store round trip, the older-`at` rule, the API validation and 409 cases, the delete on reply, and the panel's load and save path.

## Non-goals

- No per-user drafts: the draft belongs to the task, like the read marks.
- No live push of draft changes to other open tabs: a panel reads the server draft when it opens.
- No cleanup of a draft row when a task is cancelled or its ask changes. The fingerprint hides a stale row, and the next save replaces it.
