# Research inbox: pin research cards until acted on (OTTR-488)

Research cards whose report recommends steps land in the done lane and get lost. The
design is settled and user-approved by grilling (OTTR-477, 2026-11-04). This spec is
the source of truth; the card prompt is the summary.

## Decisions (approved — do not revisit)

1. Detection: structured heading + regex fallback. The research prompt requires steps
   under a `## Recommended steps` heading (none when no steps); the server parses the
   heading at harvest into a new task column. Legacy reports fall back to the existing
   regex (`recommendsSteps`).
2. Pin clearing: ONLY the drawer buttons clear a steps report from the pinned group.
   Opening the drawer does not.
3. Dismissal state: reuse the existing read-mark set (no new dismissed flag). The
   drawer's "Mark unread" is the undo.
4. Pure-info research reports (no steps): pin until the drawer is opened (like
   answers), no buttons.
5. The pinned group renames from "Unread" to "Inbox".
6. Legacy resurfacing is steps-only: unmatched legacy reports stay quiet.
7. Buttons live in the drawer CTA row only; no card-face actions.

## Semantics per card

Resolution of stored `steps` + regex fallback (`researchSteps` helper):

| Stored `steps` | Report regex | Resolves to | Board behavior |
| --- | --- | --- | --- |
| `yes` | — | `yes` | Pinned in Inbox until "Implement steps" or "No further steps"; both buttons visible |
| `no` | — | `no` | Pinned in Inbox until the drawer is opened; no buttons |
| `unknown` | match | `yes` | Same as `yes` (legacy resurfacing) |
| `unknown` | miss, or no report | `quiet` | No pin, no buttons |

## Design

### Storage (src/store.ts)

- Additive column `research_steps TEXT NOT NULL DEFAULT 'unknown'`, values
  `'yes' | 'no' | 'unknown'`. Three landing points, all in one commit:
  1. the CREATE TABLE text (DDL, after `research`),
  2. the migration in `ProjectStore.open` following the report/research ALTER pattern
     (`CREATE TABLE IF NOT EXISTS` never updates a live database),
  3. the stage-rebuild `names` column list — the rebuild copies named columns, so a
     DDL column missing from that list would reset harvested steps to the default on
     databases that go through the rebuild.
- Never rebuild or drop anything (AGENTS.md hard stop). Row mapping parses
  defensively to `'unknown'`; camelCase column-map entry `steps: "research_steps"`;
  `createTask` never sets the column (the default fills).

### Types (src/types.ts)

- `export type ResearchSteps = "yes" | "no" | "unknown"`.
- `Task` gains `steps: ResearchSteps` (harvested at settle; `'unknown'` = never
  harvested). `TaskCard` and `TaskView` inherit through their Omit types.
- `recommendsSteps` moves from src/ui/app.tsx to src/types.ts (same module as
  `answeredCard`: both server and client import it). src/ui/app.tsx re-exports it so
  existing imports keep working.

### Harvest (src/turn.ts settle path)

When the settle's `report` value is final: `reportText !== null` stores
`steps: /^##\s+recommended steps\b/im.test(reportText) ? "yes" : "no"` in the SAME
`updateTask` patch that writes `report`; `null` writes nothing (undefined keeps the
column). Cards without a harvested report keep `'unknown'`. Merge, release, review,
interview, and grill turns never read the report file, so they never write steps. A
demoted card (report cleared, real commits) gets no steps write; `research` flips to
false, so it can neither pin nor show buttons.

### Prompt contract (src/prompts.ts research hatch)

Add exactly one sentence: "When the report recommends steps, put them under a
`## Recommended steps` heading; when it recommends none, write no such heading."
(Approved wording from the OTTR-477 grilling — the AGENTS.md prompts hard stop is
satisfied.) Change nothing else in the prompts.

### View resolution ("read time")

TaskCard ships no `report` text (payload cap: the drawer fetches it per task), so the
board cannot regex legacy rows client-side. The server resolves at view build — no
row rewrite:

- src/app.ts `viewSteps(t: Pick<Task, "steps" | "report">): Task["steps"]`: stored
  `'yes'`/`'no'` pass through; `'unknown'` + `report !== null` +
  `recommendsSteps(report)` → `'yes'`; else `'unknown'`.
- `stateResponse` (card view) and `taskView` (drawer view) override the spread value
  with `viewSteps(t)`. Views carry resolved values; `'unknown'` in a view means quiet.
- src/ui/queue.ts `researchSteps(t: { steps; report? }): 'yes' | 'no' | 'quiet'`
  implements the table directly (regex branch for direct TaskView reads and for the
  unit-tested table; idempotent on already-resolved views). Cards may omit `report`.

### Pinning

- Client `seenable` (src/ui/queue.ts) gains
  `t.research && t.stage === "done" && t.steps !== "unknown"` alongside
  `answered || pr_review`, still requiring `cancelledAt === null`. Widen the Pick
  types of `seenable`, `isUnread`, and `LaneTask` with `"stage" | "research" | "steps"`.
- Server `seenableIds` (src/app.ts, /api/seen decay) mirrors it on raw rows:
  `t.research && t.stage === "done" && t.report !== null && viewSteps(t) !== "unknown"`.
- The done-lane `fresh` partition and the `donePage` pinned predicate read
  `isUnread`, so pinned research cards land in the Inbox group and never sit behind
  "Show more". No change needed there beyond the label.

### Read marks (src/ui/app.tsx)

- `markSeen` body unchanged. New queue.ts helper
  `autoMarkOnOpen(t) = seenable(t) && researchSteps(t) !== "yes"` guards BOTH call
  sites (openTask and the drawer's onClose): a steps card opening does not mark it
  read; pure-info cards keep auto-mark on open; quiet cards are not seenable anyway.
  "Mark unread" stays the undo for both kinds.

### Drawer CTA row (src/ui/app.tsx)

- "Implement steps" gate becomes `task.research && researchSteps(task) === "yes"`
  (replaces the bare `report !== null && recommendsSteps(report)` gate).
- New "No further steps" BusyButton beside it, same gate, title "Marks the report
  read and clears it from the Inbox", run through a new `onMarkSeen` drawer prop that
  calls the App's `markSeen` (local seen set + POST /api/seen — the proven path).
  After it, the existing "Mark unread" button appears (the read prop flips) — that is
  the undo.

### Rename

- Lane label "Unread" → "Inbox" (app.tsx done lane). Update stale "Unread" wording in
  app.css comments and tests. The `.unread` CSS class name stays.

## Boundaries and error cases

- Cancelled cards never pin (cancelled guard stays).
- Demoted research cards (`research: false`) never pin and never show buttons.
- Cards without a harvested report keep `'unknown'` → quiet.
- A pre-column database converges through the migration on open; the rebuild names
  list carries the column so a rebuild never resets it.
- Legacy rows are never rewritten; the regex applies at every view build.
- A refused report (symlink, oversized) keeps `report` null → no steps write.

## Acceptance checks (worktree root; every command exits 0)

- `bun install --frozen-lockfile`, `bun run check`, `bun test`.
- store.test.ts: fresh and reopened databases carry the column; the pre-research
  backfill fixture covers `research_steps`; steps round-trips a close/reopen.
- turn tests: harvested report with the heading stores `'yes'`, without stores
  `'no'`; a non-research card stays `'unknown'`.
- queue.test.ts: the resolution table (yes/no/unknown × regex ±); the
  autoMarkOnOpen table; seenable includes done research with resolved steps and
  excludes cancelled, not-done, and report-less cards.
- app.test.tsx: a steps card renders both buttons; pure-info and quiet research
  cards render none; a cancelled steps card stays read-only; a steps card in the
  seen set sits below the Inbox divider and re-pins once unseen; the label reads
  "Inbox". Static markup cannot fire events (harness limit), so the open/close
  auto-mark decision is covered by the `autoMarkOnOpen` unit tests and the button
  flow reuses `markSeen`'s proven local+POST path.
- Impeccable detect on changed UI files (primary findings block).
- `bun run readme-screenshot`; commit the new `.github/assets/screenshot.png`.

## Non-goals

No card-face buttons. No dismissed column. No retroactive rewrite of legacy rows.
No change to answers/PR-review pinning. The in-flight OTTR-468 card's gap (button
for every steps report) is absorbed by the CTA gate change.
