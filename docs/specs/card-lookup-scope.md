# Card lookup scope: every lookup sees every card

OTTR-1255. Status: implemented against this spec. The spec is the source of truth;
the card prompt stays the summary.

## Behavior

`/api/state` ships one new field, `allCards: CardRef[]`: a compact index of every
card of every project the board serves, done and cancelled cards included, with no
window. `CardRef` carries the fields a lookup, link, count or decision needs:

```ts
export type CardRef = Pick<
  Task,
  | "id" | "project" | "sessionTitle" | "kind" | "stage" | "state"
  | "cancelledAt" | "createdAt" | "updatedAt" | "doneAt"
  | "followUpOf" | "followUpOfProject" | "asked" | "dependsOn"
  | "commits" | "releaseVersion" | "queuedAt"
> & { prOccurrence?: TaskCard["prOccurrence"]; lead?: TaskCard["lead"] };
```

Ids are unique per project, not across projects, so the UI index keys buckets by
id (`src/ui/cardIndex.ts`):

- `buildCardIndex(allCards: CardRef[]): CardIndex` — id to entries map.
- `lookupCardIn(index, id, project)` — the one entry with this id and project,
  else null.
- `lookupCard(index, id)` — the first entry with this id in any project, else
  null.

A caller that today searches same-project first keeps that order by composing:
`lookupCardIn(index, id, self) ?? lookupCard(index, id)`.

The board's card lists keep the window. The lanes, the Done lane with its
"Show more" paging and search (OTTR-1135), the Triage and alarm lists, the rail
rows, `reuseCards`, `boardFlipSig`, the FLIP effect, and `slotUse` all read
`state.tasks` exactly as before. `allCards` never feeds a rendered list.

### "Card not found"

A context that renders a row or shell for one card renders
`Card not found: <id>` when the id exists in no project. This already exists for
the drawer shell (`DrawerPending`) and the lineage `goneRow`; after this change
the lineage row takes it from an index miss with no fetch. Inline linkify
contexts (`ProposalReasonLink`, `CardIdLinks`) keep showing the raw id text on a
miss: the id stays visible, so nothing is silent.

## Boundaries and error cases

- A card missing from `allCards` looks up as a miss; the render rules above hold.
- The drawer fallback fetch stays: opening a deep link to an out-of-window card
  needs the wide `TaskCard` (prompt, report), which the index does not carry. It
  keeps its 404 to `DrawerPending` path.
- `loadLineage` (the per-ref `GET /api/projects/<p>/tasks/<id>` fetch for
  lineage rows, OTTR-1158) is removed with its retry wiring. Lineage parents,
  retro sources and children resolve from the index.
- The OTTR-1198 child refs (the drawer detail's `children` field, the server's
  `childRefsOf` scan over every board, and the per-child fetch) are removed. The
  descendant tree with folding and the depth cap (OTTR-1198, OTTR-1258) reads
  `childMap(cardIndex)`, so children the Done window dropped and children filed
  into another project render with no fetch.
- The hold gates read one complete graph per project: `wideGraph` in
  `src/ui/app.tsx` is `projectGraph` with each loaded wide row in place of its
  ref. The lane facts, the drawer's "Waiting for" banner (the dependency list and
  the review-hold cards) and the OTTR-1321 dependency hold contexts
  (`depHoldContexts`) all take it. `depIndexOf` hands back the loaded wide row
  for a resolved open card, so a foreign dependency's usage-limit countdown and
  push hold reach the dependency line.
- The lead-validation button (OTTR-1247) resolves the lead's review from the
  index, not from a lineage fetch.
- A store that fails to list tasks fails the state build exactly as before this
  change: `currentOrphanScan` reads the same store's `listTasks` unprotected
  (pre-existing), so the frame answers an error, never a partial state.
  `allCards` therefore always carries the same cards `tasks` carries; the
  `boardCards` catch only covers stores that fail elsewhere.
- `reuseCards` compares `allCards` by reference only when both frames carry the
  same array instance is impossible over JSON, so it carries `next.allCards`
  through unchanged; the App rebuilds its `CardIndex` map per frame (about
  1 ms at 2100 cards, measured below) and no memoized component takes the map
  as a prop.

## Measurements

The live tracker's store lives in its own container and is not reachable from a
work container, so the baseline and the after-measurement use one synthetic
project at the stated ottr scale, booted from this repo's real app
(`createApp`), 2100 cards: 40 open, 2000 done (follow-up chains), 60 cancelled.

Baseline (2026-11-24, origin/main 0f258c58, this machine):

| metric | value |
|---|---|
| cards per project (synthetic) | 2100 (doneTotal 2060) |
| `/api/state` wire size | 97,739 B uncompressed, 4,372 B gzip |
| cold `GET /api/state` (first build) | 3,697 ms |
| warm `GET /api/state` (cached) | 1 ms |

Method: `/tmp/ottr-bench.ts` boots the app with the store seeded through
`ProjectStore.createTask`, serves on a loopback port, fetches `/api/state`
seven times, reports `Content-Length`, the body length, and cold plus warm
medians. The after-change run uses the same script, seed and machine.

## Alternatives considered

- **On-demand lookup helper that fetches missing ids and caches** (the task's
  option B): rejected. It keeps a per-feature fetch behind every render that
  resolves an id, makes lookups asynchronous mid-render, and re-creates the
  stale-cache class of bug this task removes.
- **Full `TaskCard` for every card**: rejected. The wide text fields (prompt,
  report, diffText, workCheckLog) would grow every frame by megabytes.
- **Per-feature fetches (status quo)**: rejected; it is the bug source
  (OTTR-1158, OTTR-1198, OTTR-1254).
- **A delta protocol for `allCards`** (send once, then stream diffs): rejected
  for now. The frame-dedupe path already suppresses unchanged frames, and a
  delta protocol adds a second source of truth to keep coherent. Recorded as a
  risk below, with the measured numbers that would justify it.

## Risks

- Every changed frame now carries the index bytes. Measured at the synthetic
  scale (2100 cards, same machine, back-to-back runs, final code): the
  uncompressed frame grows from 96,495 B to 825,892 B, gzip from 4,266 B to
  44,044 B, the cold build stays at about 2.5 s, and the warm serve moves from
  1 ms to 3 ms. A board ten times larger would need the delta protocol; these
  numbers go into the ready report.
- A reader moved to the index that really renders a list would widen a list.
  The lane-still-windowed test guards this.

## Detailed Implementation Plan

1. `src/types.ts`: `CardRef`, `StateResponse.allCards`.
2. `src/app.ts`: `boardCards` builds one `CardRef` per card while it builds the
   full cards per project (before the window cut); `stateResponse` serializes
   `allCards` with the same chunk-buffer splice `tasksBufs` uses.
3. `src/ui/cardIndex.ts`: `buildCardIndex`, `lookupCardIn`, `lookupCard`.
4. `src/ui/app.tsx` moves these readers to the index:
   SystemCardLink (1625), overview Last activity (5443), ProposalReasonLink
   (9929), CardIdLinks (9976), followUpParent and retroSource (13712, 13727),
   retroProposals (13741), drawer kids (14105), appViewSelection (16200),
   inbox cardCtx (16648), linkedParent (17590), drawerTasks (17596), openTask
   (17985), pruneAskDrafts input (18232), selectedStateTask (18375), bell
   alarms (18634). Removes `loadLineage` and its retry wiring.
   The send-back reviews (second model) extended this list: `holdFor`,
   `reReleaseOf`, `depIndexOf` and `commitDeltas` read complete data too, and
   `openTask` threads the project each caller knows (a bare-id click must not
   cross projects when two projects share an id); `cardCtx.resolve` and the
   warnings' card links honor an explicit project instead of falling back
   globally. The drawer context keeps the foreign lineage rows (the drawer
   card's foreign parent, that parent's source, foreign children, foreign
   proposals under its retros), now resolved from the index instead of the
   removed fetch; a windowed wide row always wins the adapter, so holds, PR
   facts and reasons survive. The second send-back review fixed the rest:
   every remaining bare-id call site threads its project, `projectGraph` rows
   carry the real `queuedAt` and the `lead` mark without a prompt key (isLead
   reads the prompt first when the key exists), `reviewProgress` scans the
   review's own project, deltas compute per project, RelatedTasks holds each
   blocker behind its own project's graph, and board-report walks the OTTR-708
   prefix for a foreign dependency.
5. `src/ui/status.ts`: `projectGraph(index, project)` builds the whole-project
   row list the hold machinery consumes (`GraphTask`: the index card plus the
   title the hold text names and neutral fills); `reviewProgress`,
   `bellAlarms` and `refRow` take the index. `src/ui/settings.tsx`:
   ReviewCounter card lookup (9126).
6. `scripts/board-report.ts`: `depsOpen` resolves project-qualified against
   `allCards`, and `mergeHold` reads the complete project set from `allCards`
   (a done review with an open finding outside the window still holds its
   merging cards). The foreign fallback walks the projects' CONFIGURED
   `taskPrefix` handles — never a prefix inferred from card ids, which a
   project's older ids would shadow (send-back 3).
7. Tests listed under Acceptance; red-green via stash of the implementation
   files.

### Reader inventory (full census, tests excluded)

Legend: class LOOKUP (resolve id to card, link, lineage traversal), DECIDE
(count, gate, existence check), RENDER-LIST (a rendered list). Verdict
MOVE-TO-ALL or KEEP-WINDOW. Line numbers are origin/main 0f258c58. The window
invariant: every open card rides, so open-only readers are window-safe.

MOVE-TO-ALL:

| site | snippet | class | fields used |
|---|---|---|---|
| app.tsx:1625 | SystemCardLink find | LOOKUP | id, project, sessionTitle |
| app.tsx:5443 | overview Last activity max | DECIDE | updatedAt |
| app.tsx:9929 | ProposalReasonLink find | LOOKUP | id, project, sessionTitle |
| app.tsx:9976 | CardIdLinks find per id match | LOOKUP | id, project, sessionTitle |
| app.tsx:13712 | followUpParent find | LOOKUP | followUpOf, followUpOfProject, kind |
| app.tsx:13727 | retroSource find | LOOKUP | followUpOf, followUpOfProject, kind |
| app.tsx:13741 | retroProposals group by followUpOf | LOOKUP | followUpOf, followUpOfProject, kind, createdAt |
| app.tsx:14105 | drawer kids filter | LOOKUP | followUpOf, followUpOfProject, createdAt |
| app.tsx:16200 | appViewSelection find | LOOKUP | id, project |
| app.tsx:16648 | inbox cardCtx find | LOOKUP | id, project |
| app.tsx:17590 | drawer linkedParent find | LOOKUP | followUpOf, followUpOfProject |
| app.tsx:17596 | drawerTasks filter | LOOKUP | followUpOf, followUpOfProject, id |
| app.tsx:17985 | openTask find | LOOKUP | id, project |
| app.tsx:18232 | pruneAskDrafts asked set | DECIDE | asked, id |
| app.tsx:18375 | selectedStateTask find | LOOKUP | id, project |
| app.tsx:18634 | bellAlarms pr rows | DECIDE | kind, prOccurrence, project |
| status.ts:76 | reviewProgress findings count | DECIDE | followUpOf, dependsOn, kind, stage, doneAt |
| status.ts:355,359 | bellAlarms activity/posted | DECIDE | kind, prOccurrence |
| settings.tsx:9126 | ReviewCounter find | LOOKUP | id, doneAt |
| board-report.ts:237 | depsOpen byId over tasks | DECIDE | dependsOn, stage, cancelledAt |

KEEP-WINDOW (with reason):

| site | reason |
|---|---|
| app.tsx:1432, 1909, 5211, 5510, 5557, 6535, 13632, 18625, 18627 | open-only readers; window complete |
| app.tsx:4500 depIndexOf | moved to the index (send-back): local hidden done cards win over foreign same-id cards |
| app.tsx:4686, settings.tsx:10582 | interview card is open |
| app.tsx:4688, queue.ts:201 laneCounts | lane chrome incl. head counts; out of scope ("no change to what the board lists show") |
| app.tsx:4714, 4732, 4748 | Done lane hidden/total math keyed to server doneTotal |
| app.tsx:5056, 5437, 5510, 6548, 6661, 6864, 17494 | rendered lists: lanes, Triage, overview rows, done pins |
| app.tsx:6870 starred pins | server pins starred settled cards (app.ts:5859) |
| app.tsx:7223, 17906 coveredUpdateIds | open carriers only |
| app.tsx:6684 | lane facts hold text rides `projectGraph` (moved, see plan step 5) |
| app.tsx:15430 rail rows | alarms, waiting, unread over open cards; unread pinning contract (OTTR-827 tracks exactness) |
| app.tsx:16032, 16047, 18336, 18343; flight.ts | frame plumbing |
| app.tsx:18232 | moved (listed above) |
| app.tsx:18614 drawerHasFallback | arms the wide-card fallback fetch; stays |
| app.tsx:18621 commitDeltas | moved to the index (send-back): `commits` is a numeric count (src/progress.ts), so carrying it costs bytes, not arrays; the delta loses the +n chip when the preceding done card leaves the window |
| app.tsx:18344 seenIds flights | animation only |
| queue.ts:261, 284; app.tsx:1432 | slotUse/laneOrder over lanes |
| settings.tsx:10437 | removable gate over live (open) cards |
| scripts: dev-updater, update-image, gate-harness/load, e2e-steer, board-report open/mergeHold/verdict | open-only or non-readers |

Fetch helpers today: `loadLineage` (removed), drawer fallback fetch (stays,
wide card), `fetchOlderDone` and `runSearchFetch` (Done lane render, stay).
