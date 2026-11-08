# 0004. AGENTS.md is local-only

Date: 2026-11-05

## Status

accepted

## Context

AGENTS.md holds the process rules every agent turn reads: pipeline, gates, hard stops, commit conventions, and the omp version policy. The file itself records that it is local-only by decision (2026-09-26), but the repo records no reasoning behind that decision; this ADR is the decision's first versioned record. The file is kept out of git via `/AGENTS.md` in `.git/info/exclude`, and the instruction if it ever shows as tracked or untracked is to repair the exclude entry, never to commit the file (AGENTS.md, final section "This file"). Worktrees need the rules too: `createWorktree` (`src/worktree.ts`) copies the local-only AGENTS.md into each worktree so every turn reads it (docs/specs/review-conventions.md; commit ee9f330 makes AGENTS.md the home of review conventions, whether versioned in a repo or provisioned by Alate from agent-data).

## Decision

- AGENTS.md stays untracked and is never committed; it is kept out of git via `/AGENTS.md` in `.git/info/exclude` (AGENTS.md, "This file").
- Each worktree receives a copy via `createWorktree` (`src/worktree.ts`).

## Consequences

- The file's content has no git history and does not travel to a new clone.
- Process rules change by editing the file on each machine that holds it, with no review trail.
- A stray tracked or untracked AGENTS.md is a defect: repair the exclude entry, never commit the file (AGENTS.md, "This file").
- A future change to this rule requires a new ADR that supersedes this one.

2026-11-08: the tracked source of AGENTS.md is agent-data `projects/ottr/AGENTS.md`
(AGENTS.md, "This file"). The ottr-local copy stays untracked per this ADR;
`scripts/agent-data-sync.ts` compares the copies.
