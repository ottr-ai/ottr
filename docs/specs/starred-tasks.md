# Spec: Starred tasks

A user wants to "remember" a specific done research report. A **star** pins the
card so it stays findable, and a **Starred** section in the done lane lists the
pinned cards above the normal done cards.

## Behavior

- Every done **research** card shows a star toggle on the card (in the tags row,
  next to the release pill) and a **Star / Starred** button in the drawer next to
  **Mark unread**. Non-research cards show neither.
- The star state is server-persisted (`tasks.starred`), so it follows the card
  across devices and reloads. Toggling posts once and lets the socket frame
  refresh the card; the UI keeps no local copy.
- The done lane renders, top to bottom:
  1. **Unread** (unchanged; a card that is both unread and starred stays here),
  2. **Starred** — collapsible section, like the topic sections: a head button
     with a chevron, the label `Starred`, and a count. Renders only when at
     least one starred card exists. Collapse state joins the existing
     collapsed-record persistence under the key `starred`.
  3. the normal done cards, then **Show more**, then Backlog.
- Pagination (`donePage`) never hides a starred card behind the cut, the same
  rule unread answers already follow. Grouped (topic) view partitions starred
  cards out of the topic pages into the Starred section.

## Storage and API

- Additive column: `tasks.starred INTEGER NOT NULL DEFAULT 0`, migrated in
  `ProjectStore.open` with the ALTER-only backfills that run after both
  CHECK-rebuild blocks (the rebuilds copy named columns; `starred` must not
  enter `TASKS_DDL`). Existing rows default to unstarred.
- `Task.starred: boolean` (mapped from the column in `toTask`); `TaskCard` and
  `TaskView` pick it up through their existing `Omit<Task, …>` shapes.
- `POST /api/projects/:project/tasks/:id/star`, JSON body
  `{"starred": <boolean>}` → `200 { task: TaskView }`; a non-boolean body is a
  400, like sibling routes. The route is generic (any task), the UI only offers
  it on done research cards.

## Error cases

- Starring an unknown task or project → existing 404 resolution.
- Malformed body → 400. A failed post surfaces the board's error notice; the
  card state stays unchanged until a socket frame confirms.

## Acceptance checks

- `bun run check`, `bun test` exit 0.
- Store test: round-trip `updateTask({ starred: true })`; fresh task defaults
  false; an old-schema database converges to the new column on open.
- Route test: star → 200 and the flag reads back true; `"starred": "yes"` → 400.
- Queue test: `donePage` grows the cut to cover a starred card beyond the limit.
- UI tests: star button only on done research cards with the right
  `aria-pressed`; Starred section renders between Unread and the normal done
  cards only when a starred card exists; the head toggles collapse.
- UI change ships a rendered screenshot proof under `shots/`.

## Non-goals

- No starring of live (non-done) or non-research cards in the UI; the flag
  exists on all rows only so the column is generic.
- No per-device star state, no star counts, no sorting inside the Starred
  section beyond the lane's landing order.
