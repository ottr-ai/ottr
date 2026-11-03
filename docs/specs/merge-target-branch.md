# Merge target branch (OTTR-375)

## Problem

The board's integration target is whatever `resolveTarget` derives from the
main checkout: the upstream of the branch the checkout currently has checked
out, else that branch. The target is therefore state the repo's clone happens
to hold, not a decision the project made. A main checkout parked on another
branch silently re-points every merge, every worktree base, the merge-hold
gate and the release flow at that branch. There is no way to say "this project
merges into `develop`".

## Behavior

1. Project settings gain `targetBranch: string | null` (default `null`). The
   setting lives in the per-project settings JSON in `tasks.db` (server-only
   state), validated per key by `SETTINGS_SHAPES` like `originUrl`. No schema
   migration: `parseSetting` reads a JSON object per key.
2. Every server-side resolution of a project's integration target passes
   `settings.targetBranch` as the fourth `resolveTarget` argument: boot
   discovery and `refreshRemote` (both set `e.target`), the release GET/POST
   routes, the arch-review route (which also passes the pinned origin URL, so
   a configured branch the clone never fetched still resolves), the task
   view's late-commits anchor, and both `turn.ts` call sites (release publish
   and the per-turn worktree/target resolution). A settings save that changes
   `targetBranch` refreshes `e.target` at once through `refreshRemote`; a save
   that does not touch it leaves the target alone.
3. Resolution ladder for `targetBranch === null` (the default):
   - `git symbolic-ref refs/remotes/origin/HEAD` names the repo's default
     branch: target = `origin/<default>`, canonical form;
   - no `origin/HEAD` (a solo repo, a clone without it): today's derivation —
     the canonical `origin/<short>` for an origin upstream of the checked-out
     branch, else the upstream as registered, else the checked-out branch.
   The fetch behavior is unchanged for every outcome the old code produced.
   When `origin/HEAD` wins, the fetch refreshes `refs/heads/<default>` through
   the pinned origin URL with the same refspec shape as an origin upstream —
   not the checked-out branch's upstream, which may name another branch.
4. `targetBranch` set: target = `origin/<targetBranch>` unconditionally; the
   main checkout's checked-out branch and its upstream stay irrelevant. Fetch
   refreshes `refs/heads/<targetBranch>` through the pinned origin URL, with
   the same no-pin / refused-pin / failed-fetch warning behavior as an origin
   upstream. A target that does not resolve fails loudly (`cannot resolve
   origin/<branch>`), never falls back to the checked-out branch.
5. The merge prompt names the target branch, not a literal `main`:
   `mergePrompt` derives the branch from the target
   (`origin/<branch>` → `<branch>`, else the target as is). For every project
   whose target is `origin/main` the prompt text is byte-identical to before.
6. The settings API accepts the key through `parseSettingsPatch`: a trimmed
   string, at most 200 characters, no control characters, no whitespace, no
   leading `-`, no `..` segment, not `origin/…` — a bare branch name; empty
   string stores `null`. The UI shows a "Target branch" row in the project's
   Worktrees card; empty = the repo's default branch.

## Non-goals

- No change to `serverMergePush`, `mergeHoldMismatch`, the release flow or
  the supervisor: they already consume the resolved target string.
- No `git remote set-head` refresh of a stale `origin/HEAD`; a stale pointer
  that stops resolving fails loudly until the setting is set or the clone is
  refreshed.
- No per-task target override.

## Acceptance

- A project with `targetBranch: "develop"` resolves `origin/develop`, bases
  new worktrees on it, fetches it through the pinned origin, and fails loudly
  when `origin/develop` is absent.
- A default project (setting `null`) with `origin/HEAD → main` resolves
  `origin/main` even when the main checkout sits on another branch; a clone
  without `origin/HEAD` keeps the old upstream derivation, including the solo
  (no origin) case.
- The settings API rejects bad branch names with 400; empty string clears to
  `null`.
- `bun run check` and `bun test` pass from the worktree root.
