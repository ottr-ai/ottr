# Card titles name the real task (OTTR-912)

## Behavior

- A card title has two sources, in order: the **draft title** and the **work title**.
- The **draft title** comes from the title model over the prompt text (`generateTitle`,
  src/turn.ts), persisted once through `nameTask` with title source `draft`.
  Its system text names the action and the source of content the model cannot see,
  and never guesses that content. A question in the prompt does not become a
  question title. Exact system text:

  > You name tasks. Reply with only a 3-8 word title naming the request, no quotes, no trailing period. You never open links and never need their content: name the action and the source of the content you cannot see (a video, a page, an issue), never the content itself, e.g. "Evaluate check idea from TikTok video". A question in the prompt does not make the title a question. Name the work itself, never the steps of reading a file or a handoff.

- The **work title** is the run agent's first valid rename. The store records the
  title source in a new nullable `tasks.title_source` column (`draft` | `work`).
  Inside `resolveTitle` (src/store.ts), when the stored title source is `draft`
  and the card is open (stage not `done`, `cancelled_at` null), the session file
  is scanned for the first top-level `title_change` whose cleaned title differs
  from the stored title and passes the same title filter as the draft title
  (`titleProblem`: at most 8 words, no refusal, no file path, no handoff step).
  The first such record wins; failing records are skipped. The winner is written
  once with a guarded update (`... WHERE id = ? AND title_source = 'draft'`) and
  source `work`. After that the title stays: later renames change nothing.
  Invalid renames change nothing while they are the only records.
- Fixed session names stay: a release-review, review or board-check turn pins its
  fixed name (`Release review`, `Review`, `Board check`) through `nameTask` with
  source `work` at turn start (the `IS NULL` guard keeps an existing stored
  title), so the rename scan never replaces it.
- The title retry and title hold, the stored-notice labels, and the absence of a
  manual title edit are unchanged.

## Storage and migration

- `title_source` is ALTER-only, placed after both CHECK rebuilds like the other
  post-rebuild columns (`pending_by`, `pr_number`, …); it is not in `TASKS_DDL`,
  so a rebuild's explicit column list cannot drop it.
- `ProjectStore.open` backfills, idempotent on every open: stamp every row that
  has a stored title and no source as `draft`, then for each open card
  (not `done`, not cancelled) with a draft title, take the first valid rename
  from its session and write it with source `work` one time. Done and cancelled
  cards keep their titles. New writes always set the source, so the stamp and
  the pass converge and later opens do no work.

## Boundaries and error cases

- A session with no `title_change` records, or only records equal to the stored
  title or failing the filter, leaves the draft title in place.
- A card whose agent never renames keeps its draft title; the scan cost is one
  session-file read per resolve call, the same order as the pre-freeze scan the
  store already pays for unnamed cards, and it stops at the first consumed
  rename, a fixed-name pin, or the card leaving the open set.
- The comparison and the filter run on `cleanTitle` output on both sides, so a
  transcript echo of the draft title (the session starts named) never counts as
  a rename.
- The guarded update keeps two racing resolves from writing different work
  titles; the loser's read shows the draft until the next poll.

## Acceptance checks

- Store tests (src/store.test.ts), each failing before the change:
  1. draft stored, then an agent rename in the session: the card shows the work
     title and the row's source is `work`.
  2. a second rename changes nothing.
  3. a rename that fails the filter leaves the draft title.
  4. a fixed name pinned with source `work` stays under a rename.
  5. the open-time backfill rewrites an open card's draft title from its session
     and leaves a done card's title alone.
- Turn test (src/turn.test.ts): `generateTitle` sends the new system text.
- One throwaway run of the new title prompt over OTTR-910's prompt
  ("Should we add a check like that https://vm.tiktok.com/ZGdXHRJBg/ ?") returns
  a title that is not a question and names the video as the source.
- `bun run check` and `bun test` exit 0.

## Alternatives considered

- Stopping at the first differing rename even when it fails the filter: rejected.
  omp's own auto titler cuts the prompt into the first record of an unnamed
  session; a question prompt cuts to a question title that fails the 8-word
  filter and would block the agent's rename forever. The task's backfill wording
  ("first valid rename") and the feature's intent both point to skipping
  invalid records.
- Writing the work title from the turn runner instead of inside `resolveTitle`:
  rejected. Only the store knows the title source, and the 2-second board poll
  already drives `resolveTitle`, so the write lands within one poll with no new
  wiring.
- A manual title edit: rejected; the user declined it for this card.

## Risks

- An open card whose agent never renames keeps paying one session-file read per
  resolve until it closes; large transcripts make this the dominant cost of the
  card build for that card. Mitigation if it shows: scan only records appended
  after the stored title's position.
- A done card reopened later keeps source `draft`, so its next session's rename
  can replace the title; this matches the feature's intent for a running card.

## Non-goals

- No manual title edit.
- No prompt-gate change.
- No Deepen change.
- No ADR.
