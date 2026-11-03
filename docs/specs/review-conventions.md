# Review conventions live in the project's AGENTS.md

Removes the Review learnings feature (card OTTR-385). Review conventions are rules
about one codebase, so they belong in that project's `AGENTS.md`: versioned in its
repo, or provisioned by Alate from agent-data. `createWorktree` (`src/worktree.ts`)
copies a local-only `AGENTS.md` into each worktree, so review turns read it in both
cases. Stored learnings had none of that: they lived only in `.tasks/tasks.db`, with
no version history, no propagation to other machines, and they were lost with
`.tasks`.

## Behavior

- A review card's prompt no longer carries stored learnings. No prompt text mentions
  them.
- The settings page has no Review learnings card, and the settings map has no such
  entry.
- The HTTP API exposes no learnings routes.
- The store exposes no learning methods, row type, or `Learning` type.

## Boundaries and error cases

- No data migration. On 2026-11-03 no project on the board had a learning. Existing
  `tasks.db` files keep their `learnings` table and any rows in it, untouched.
  Nothing reads or writes the table.
- No DROP and no destructive ALTER (AGENTS.md hard stop 2). `learnings` stays in the
  `CREATE TABLE` text, so fresh databases and existing databases converge on the
  same schema.

## Acceptance checks

- No UI, route, store method, or prompt text reads or writes learnings; a search for
  learning references finds only the retired `CREATE TABLE` text and its comment.
- A fresh database and an old-shape database both have the `learnings` table after
  `ProjectStore.open` (store test).
- The rendered settings page has no `#project-learnings-section` element and no
  "Review learnings" text anywhere on it (settings test).
- `bun run check` and `bun test` pass.

## Non-goals

- No new sentence in the review prompt (for example about following AGENTS.md
  conventions): prompt wording is an AGENTS.md hard stop, and none was approved.
- No removal of the retired table or its rows.
- No change to any other prompt text, schema, or route.
