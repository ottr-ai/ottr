# 0007. The merge target is a project setting

Date: 2026-11-05

## Status

accepted

## Context

The board's integration target used to be whatever `resolveTarget` derived
from the main checkout's currently checked-out branch — its upstream, else the
branch itself (docs/specs/merge-target-branch.md, Problem). The target was
therefore clone state, not a project decision: a main checkout parked on
another branch silently re-pointed every merge, every worktree base, the
merge-hold gate and the release flow, and there was no way to say "this
project merges into `develop`". Card OTTR-375 changed this
(docs/specs/merge-target-branch.md). The original decision date is not
recorded in the repo. The mechanism is in the code: `resolveTarget` takes
`targetBranch` as its fourth argument and, when set, resolves
`origin/<targetBranch>` unconditionally because "the checked-out branch and
its upstream are irrelevant" (src/worktree.ts:762-786); the setting is
validated per key by `SETTINGS_SHAPES` (src/store.ts:822) and consumed at
every server-side target resolution (src/turn.ts:1226, src/turn.ts:1441,
src/server.ts:333).

## Decision

A project's integration target is its `targetBranch` setting when set
(default `null`). With the default, resolution follows a ladder: `origin/HEAD`
names the repo's default branch, else the old upstream derivation of the
checked-out branch (docs/specs/merge-target-branch.md, Behavior §3). A set
setting resolves `origin/<branch>` unconditionally, and a target that does
not resolve fails loudly — never a silent fallback to the checked-out branch
(docs/specs/merge-target-branch.md, Behavior §4). Per-task target overrides
are a non-goal (docs/specs/merge-target-branch.md, Non-goals).

## Consequences

- "This project merges into `develop`" is expressible; the main checkout's
  checked-out branch no longer re-points integration.
- A stale `origin/HEAD` that stops resolving fails loudly until the setting is
  set or the clone is refreshed; there is no `git remote set-head` refresh
  (docs/specs/merge-target-branch.md, Non-goals).
- This ADR records the why; docs/specs/merge-target-branch.md keeps the
  behavior and acceptance checks.
- Any change to the resolution order or to the setting's shape requires a new
  ADR that supersedes this one; an accepted ADR's text does not change.
