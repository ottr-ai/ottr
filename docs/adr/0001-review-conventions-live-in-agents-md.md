# 0001. Review conventions live in the project's AGENTS.md

Date: 2026-11-05

## Status

accepted

## Context

Review turns used to carry "learnings": review conventions stored in a project's
`.tasks/tasks.db`. Stored learnings had no version history, no propagation to other
machines, and were lost with `.tasks` (commit ee9f330, docs/specs/review-conventions.md).
Review conventions are rules about one codebase, so they belong in that project's
AGENTS.md: versioned in its repo, or provisioned by Alate from agent-data.
`createWorktree` (`src/worktree.ts`) copies a local-only AGENTS.md into each worktree,
so review turns read it in both cases. The decision took effect on 2026-11-03, when
commit ee9f330 removed the learnings routes, store methods, prompts text, and settings
card (no project on the board had a learning, so no data migration was needed).

## Decision

Rules about one codebase live in that codebase's AGENTS.md, never in tasks.db. The
stored-learnings feature does not return.

## Consequences

- The retired `learnings` table stays in the schema, unused: no DROP and no
  destructive ALTER, so fresh and existing databases converge on the same schema
  (docs/specs/review-conventions.md).
- Convention changes are edits to AGENTS.md (or agent-data), reviewed like code.
- Re-introducing rules storage in the db re-litigates this decision and needs a
  superseding ADR.
