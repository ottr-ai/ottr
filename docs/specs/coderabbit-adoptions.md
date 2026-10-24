# Adopting CodeRabbit concepts: review learnings, triage rank, slop lens

Source of truth for the adoption decision ("Adopt as proposed"). It implements the
shortlist of the fork research (CodeRabbit concepts mapped onto ottr):

1. Review learnings (table + review-prompt injection).
2. Manual triage rank (P0-P3) + close-candidate nomination on cards.
3. The slop/over-engineering lens as one review-prompt sentence.
4. The `warning` gate-mode pattern: adopted as policy for the NEXT new gate.
   No code in this task; existing gates are not retrofitted.
5. Per-path review instructions: deferred until review noise is measured. No code.

The user approved the prompt-wording hard stop by assigning "Adopt as
proposed"; the schema changes are additive and follow the `ProjectStore.open`
patterns, so they need no further approval.

## Review learnings

A learning is one natural-language review convention, stored per project and
injected into every review prompt (Review button card and release card, both
embed `reviewBody`), so a convention stated once stops being re-flagged.

### Schema (additive, no CHECK constraints)

```sql
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  glob TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  from_task_id TEXT,
  created_at INTEGER NOT NULL
);
```

### Types (`src/types.ts`)

```ts
export interface Learning {
	id: number;
	/** The convention, one rule per row, phrased as a review instruction. */
	text: string;
	/** Advisory path glob; null = the whole repo. The reviewer, not the store, matches it. */
	glob: string | null;
	usageCount: number;
	lastUsedAt: number | null;
	/** Card that produced the learning (a finding card the user declined), or null when typed by hand. */
	fromTaskId: string | null;
	createdAt: number;
}
```

### Store API (`src/store.ts`)

- `listLearnings(): Learning[]` — oldest first.
- `addLearning(o: { text: string; glob?: string | null; fromTaskId?: string | null }): Learning`
- `deleteLearning(id: number): void`
- `touchLearnings(ids: number[]): void` — `usage_count += 1`, `last_used_at = now`, no-op on an empty list.

### Prompt injection (`src/prompts.ts`)

`reviewBody` gains a learnings parameter. With learnings present it adds one
short section: apply these standing conventions from earlier reviews; a finding
that only restates a learning is noise and is not recorded. Each line shows the
text, the glob when set, and the usage count. `reviewPrompt` and
`releasePrompt` pass it through.

### Wiring (`src/app.ts`)

Both review-card call sites (arch-review route, release route) load the
project's learnings, build the prompt with them, and call `touchLearnings` at
card creation. ponytail: usage counts at creation, not at turn start; a review
card that never runs overcounts by one.

### HTTP API (`src/app.ts`)

- `GET /api/projects/:project/learnings` → `{ learnings: Learning[] }`.
- `POST /api/projects/:project/learnings` `{ text, glob? }` → `{ learning }`.
  Validation: `text` a trimmed 1-500 character string, `glob` an optional
  trimmed 1-200 character string.
- `DELETE /api/projects/:project/learnings/:id` → `{ ok: true }`.

### UI (`src/ui/app.tsx`)

One board list, inside the project settings page: a "Review learnings" section
with the list (text, glob, usage count), a delete button per row, and an add
form (text area plus optional glob input). Errors surface like other settings
errors.

## Triage rank and close candidates

### Schema (additive columns on `tasks`, ALTER-only, after the stage-CHECK rebuild)

- `priority TEXT` — null = unrated, else `P0` | `P1` | `P2` | `P3`.
- `close_candidate TEXT` — null = not nominated, else the stored reason.

They are deliberately absent from `TASKS_DDL` (same reason as `topic` and the
diff columns: the CHECK rebuilds copy named columns, so a column living in
both places would dupe on the stale column list). `TASK_COLUMNS` gains both
mappings, `TaskRow`/`toTask` both fields.

### Types (`src/types.ts`)

```ts
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];
```

`Task` gains:

```ts
/** Manual triage rank; null = unrated. Overview triage sorts P0 first, unrated last. */
priority: Priority | null;
/** Close-candidate nomination: the reason this card is a duplicate, superseded, or drifted; null = not nominated. */
closeCandidate: string | null;
```

### HTTP API (`src/app.ts`)

`POST /api/projects/:project/tasks/:id/triage` `{ priority?, closeCandidate? }`
→ the updated `taskView`. At least one field must be present. `priority` is a
`PRIORITIES` value or null; `closeCandidate` is null or a trimmed 1-200
character string. Works on any card in any stage.

### UI (`src/ui/app.tsx`, `src/ui/app.css`)

- Card drawer: a rank picker (Default, P0-P3) and a close-candidate control
  (set with a reason, clear). Both POST the triage route.
- Overview triage: cards sort by rank first (P0 first, unrated last, wait time
  breaking ties), then the existing wait order within each rank. A rank badge
  shows on triage rows; a close-candidate badge (with the reason as its
  tooltip) shows next to it.
- Board card: the same rank badge and close-candidate badge in the card corner.
- Badges carry a text label (never color alone) and keep WCAG 2.1 AA contrast.

## Slop lens (`src/prompts.ts`)

One sentence in `reviewBody`: every line of this codebase is AI-generated, so
judge it like a senior engineer and flag unneeded abstraction, speculative
scaffolding, dead config, and boilerplate a reviewer would delete, recorded
like any other finding.

## Acceptance checks

1. `bun run check` and `bun test` exit 0 from the worktree root.
2. A database created by the previous schema, opened by the new code, gains the
   `priority` and `close_candidate` columns and the `learnings` table without
   losing rows (store test proves it by opening an old-shape database).
3. A learning created through the API appears in the next Review card's prompt
   text and increments its usage count.
4. The triage route validates its input and rejects an empty patch.
5. The settings page lists, adds, and deletes learnings; the drawer sets and
   clears rank and close candidate; triage rows show the badges and sort by
   rank. Screenshot proof ships with the card.

## Non-goals

- No automatic close of close candidates: the user cancels the card.
- No scoring model, no computed priority.
- No warning/error gate modes in this task.
- No per-path review instruction files.
