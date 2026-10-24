# Concept: done lane grouped by topic

Status: concept for approval — not implemented. Companion mockup:
`docs/design/task-topics-mockup.html` (self-contained, static snapshot of the real
ottr board, desktop + 390px verified; collapse, collapse-all, and search interplay
work in the mockup).

## Problem

The Done column is an endless recency list — 216 tasks on the ottr board today.
Finding "that research task from last week" means scrolling or guessing search
words. The user needs the done lane to work as an index, not a log.

## Concept in one line

Derive a small set of topics from task text and render the Done lane as
collapsible topic sections under sticky dim headers — no new colors, no manual
tagging, no schema change in the first tier.

## Technical design

### Tier A — derived keyword clusters (proposed now)

- Input: fields `/api/state` already ships — `sessionTitle` (clean AI title,
  weighted ×2), `title`. The agent `summary` is excluded on purpose: it is
  integration-report language ("rebased", "ff-merged", "gates green") and it
  hijacked every early clustering attempt.
- Where: new `src/ui/topics.ts` (pure functions + tests in
  `src/ui/topics.test.ts`), consumed by the done-lane render in `src/ui/app.tsx`.
  Memoized on the done set (ids + titles), recomputed only when a card lands.
- Algorithm (deterministic, prototyped against the live board):
  1. Tokenize on non-`[a-z0-9+#-]`, lowercase, strip plural `s` (len > 4).
  2. Two-tier stoplist: English function words + task-UI words, plus pipeline
     and positional words (fix/add/push/merge-queue-jargon/top/left/...).
  3. Document frequency over done tasks; candidate topics = terms with df ≥ 3.
  4. Each task joins its highest-df matching candidate (general topic wins;
     rare noise terms cannot steal cards).
  5. Keep the 10 largest groups (≥ 3 members); everything else is
     "Everything else", always last. Order: member count desc, recency tiebreak.
- No store/schema/API changes, no new dependency, no prompts.ts touch. Works
  immediately on all existing done tasks.

Measured on the live ottr board (2026-10-02, 216 done tasks): 10 topics covering
~90 cards — merge 15, detail 13, follow-up 11, setting 8, impeccable 8, test 7,
bar 7, model 7, menu 6, look 5 — "Everything else" 129. Head coverage ≈ 42%.

Known ceiling (`ponytail:`): single-word clusters + stoplist quality bound tier A
to roughly 40–45% head coverage; the tail is honest but large. Upgrade path is
tier B, not more stoplist tuning — five tuning rounds already hit diminishing
returns.

### Tier B — model-labeled topic column (optional, later, needs approvals)

- Additive migration: `ALTER TABLE tasks ADD COLUMN topic TEXT` +
  idempotent backfill in `ProjectStore.open` (existing column-backfill pattern).
- Label stamped when a task lands (outcome report gains a `topic` field —
  prompts.ts wording change, hard stop) or by a one-shot board task that labels
  the 216 existing rows through omp.
- Better names and ~90% coverage; costs a schema stop, a prompt stop, and
  non-deterministic labels. Tier A ships without any of that and remains the
  fallback labeler for unlabeled rows.

## Visual design (IS4-101 contract holds)

- Topics are **structure, not color**: no new hue, no category badges. Sections
  use the existing grammar — `lane-label` small caps (11px/600/0.08em, --dim),
  `lane-divider` lines, `.count` tabular badges, recessed done-card stock.
- Section head: full-width button — chevron (12px, rotates -90° collapsed) +
  topic label + dim tabular count. `position: sticky` at the lane top so the
  active topic reads while scrolling the endless list.
- Stage head gains two quiet text controls: Collapse / Expand all. Count badge
  unchanged (total done).
- Unread grouping untouched: pinned answers stay above the topic sections with
  their existing divider and `{n} new` badge.
- Search interplay: active query flattens to today's matched list (sections with
  hits auto-expand, empty sections hide); clearing restores grouping.
- Motion: 160ms collapse (grid-template-rows + padding on --ease), chevron
  rotate; `prefers-reduced-motion: reduce` disables both. No arrival animation
  changes; card flights keep working.
- Accessibility (WCAG 2.1 AA): section heads are named buttons with
  `aria-expanded`/`aria-controls`; keyboard operable natively; steel
  focus-visible ring; dim-on-done-bg contrast ≥ 4.5:1; counts are text, not
  color-only signals.
- Breakpoints: sections live inside the lane, so the 4→2→1 column tiers and
  mobile stage tabs are unaffected (verified at 390px in the mockup).

## Alternatives considered

- **Topic rail / chip filter** (sketched in the mockup's aside): lighter, but a
  second control surface that hides structure by default; the grouped lane
  answers "what is in Done" at a glance without a click.
- **Dedicated archive view**: a whole new surface for a problem the lane itself
  can solve; revisit only if topics outgrow the lane.
- **Manual tags**: the 216-task backlog would never get tagged by hand — the
  exact reason this concept derives topics automatically.

## Open decisions

1. Ship tier A now, tier B later (recommended) — or start with tier B and accept
   the two hard stops (schema + prompts wording).
2. Grouped lane (recommended) vs topic rail.
3. Topic ordering: member count desc (recommended) vs most-recent-topic-first.
