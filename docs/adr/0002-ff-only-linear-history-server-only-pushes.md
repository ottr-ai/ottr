# 0002. Integration is ff-only linear history; only the server pushes

Date: 2026-11-05

## Status

accepted

## Context

Multiple agents work in parallel worktrees against one upstream repository, so
integration needs one deterministic writer and one predictable history shape. The
merge turn runs local, never on a worker; the agent does not push — `serverMergePush`
pushes with the server's git credentials (`src/worktree.ts`, docs/how-it-works.md).
The merge-turn procedure rebases the task branch onto `origin/main`, then integrates
with `git merge --ff-only`: main gains exactly the task's work commits, never a merge
commit (AGENTS.md, "Turn 2 — Merge turn"). The only other writer of origin's main is
the scheduled omp-bump workflow, which pushes `chore: bump omp to <version>` with a
deploy key (`.github/workflows/omp-bump.yml`). The original decision date is not
recorded in the repo.

## Decision

Integration is rebase onto `origin/main` plus `git merge --ff-only`. The only writers
of origin's main are `serverMergePush` (the server's merge turn) and the omp-bump
workflow's deploy key. Agents never push.

## Consequences

- `git log` on main stays linear, and each work commit maps to one card.
- A local main holding unpushed commits blocks merging: the merge turn checks
  `git merge-base --is-ancestor main origin/main` and stops with `needs_you`
  (AGENTS.md, "Turn 2 — Merge turn").
- A rejected server push means rebase and retry, never force-push.
