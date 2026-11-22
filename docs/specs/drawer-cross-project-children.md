# Drawer lineage: children the state frames dropped

Show in a card's Lineage rail every card that names the card as its
`followUpOf` source, also when the state list does not carry the child:
an older done child outside the Done window, or a child filed into
another project's board (OTTR-1198).

## Background

- The state list (`boardCards`, src/app.ts) carries every project's open
  cards plus each project's Done window (the newest `DONE_PAGE` settled
  cards, pinned, or unread). A card's drawer receives the cross-project
  frame filtered by AppDrawer; the `Drawer` child lookup filters that
  list by `followUpOf === row.id`, so a dropped child never renders.
- OTTR-1158 fixed the same gap for parents and retro sources: the row
  carries the parent id (`followUpOf`), so the drawer fetches each
  missing card from `/api/projects/<project>/tasks/<id>` and renders
  loading / link / "Card not found" (404 only) / "Could not load card"
  (with Retry) rows. A child direction has no client-side id, so the
  same shape needs the server to name the children.

## Behavior

- The single-card detail route (`GET /api/projects/:project/tasks/:id`)
  serves `children` on the `TaskView`: every task across all registered
  projects whose `followUpOf` names the card, as refs
  `{ project, id, createdAt }`, oldest first. The scan reads only public
  card fields and mutates nothing.
- One store that fails contributes no refs from that project and logs
  through `logStoreError`; the response stays 200 and the other
  projects' refs still ship (degraded, like the state build).
- The drawer fetches its own detail already; it renders each ref that
  the frame's child list (`kids`) does not already carry:
  - `Loading…` row while the fetch runs, in the same three-column row
    shape as OTTR-1158 (no layout shift).
  - A landed fetch renders the normal `LineageCardLink` (live state
    span, project tag for a foreign card, same href rules), tagged
    `retro` when the child's kind is retro.
  - A 404 renders "Card not found" with the child id. Any other error
    renders "Could not load card" with the id and a Retry button that
    refetches. The child never disappears silently.
- Refs merge with the state children into one Follow-ups branch, oldest
  first by `createdAt`; a state row wins a tie.
- The Lineage section renders when the card has a parent, a state
  child, or a fetched child ref; it may appear once the detail lands.

## Boundaries and error cases

- An older server serves no `children` field; the drawer renders as
  before (no refs, no extra rows).
- The ref fetch reuses the OTTR-1158 guard: only an entry armed as
  loading takes the answer, so a response that lands after the drawer
  moved on or after a retry writes nothing stale.
- A refetch of the detail (the row changed while open) must not reset
  rows that already resolved: the drawer arms each ref once per drawer
  mount and only the Retry button re-arms a row.
- Cross-project hrefs and the per-child fetches follow the existing
  public card routes; no permission change.

## Acceptance checks

1. A child in its own project's Done window renders in the source
   card's Lineage as a real link to its own project's path.
2. A cross-project child outside every window renders from its ref:
   loading row, then the link to `/projects/<child project>/tasks/<id>`.
3. A ref whose fetch 404s renders "Card not found" with the id.
4. The server detail of a parent serves a foreign child and a local
   child as refs, oldest first; a failing store degrades without a 5xx.
5. `bun run check` and `bun test` pass.

## Non-goals

- No store schema change, no change to how cards are filed.
- No proposal nesting under fetched children (the proposals map stays
  state-driven); no retro-report content in the rail.
- No cross-project permission change; the scan reads only `followUpOf`,
  `id`, `createdAt`.
- No cross-project retros, no changes to Work steps, notifications, or
  the Done window sizes.

## Alternatives considered

- Parse the work turn summaries for filed card ids: rejected — a
  summary can quote an id it did not file, and agent text is not a data
  source.
- Page every project's done history from the client: rejected —
  unbounded requests per drawer open.
- Attach full child cards to the detail: rejected — refs reuse the
  OTTR-1158 fetch-and-link rows and keep the response small.

## Risks

- The scan runs one `listTasks` per registered project per detail GET;
  the drawer polls the route while open. Mitigation: refs only, no
  wide fields, same order of work as the state build's per-project
  loops.
- A fetched child's state span can go stale until the next detail
  refetch; the parent rows from OTTR-1158 share the limit.
