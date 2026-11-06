# PR mode (per project) — OTTR-552

## Problem

Integration today is one shape: the merge turn rebases the card branch onto the
target, fast-forwards the local target branch with `git merge --ff-only`, and
`serverMergePush` pushes the target with the server's credentials (ADR 0002).
A team whose main branch is protected with required reviews cannot use it:
the push is refused, so they must point `targetBranch` at an integration
branch and open the pull request to main by hand.

Context: a Podman 6.1.4 install (Windows 11, WSL, rootful) behind a corporate
proxy, repos on GitHub Enterprise Cloud (`<tenant>.ghe.com`). The pieces this
spec leans on already exist: the configured GitHub host and its gh env
(docs/specs/github-host.md — `<tenant>.ghe.com` gets `GH_HOST` +
`GH_ENTERPRISE_TOKEN` and API base `https://api.<tenant>.ghe.com`), `runGh`
(src/release.ts), the CI watch by `head_sha` (src/supervisor.ts `ciPass`),
the untrusted-PR-parsing pattern (src/prs.ts `parsePullPage`), and the
project-settings boolean pattern (`prReviews`: `DEFAULT_SETTINGS`,
`SETTINGS_SHAPES`, `parseSettingsPatch` 400, `CheckRow` in the project
settings card).

## Decision

A project setting `prMode: boolean`, default `false`. Off: every behavior in
this file is absent and the current merge flow is byte-identical. On: the
card branch is pushed and a pull request opened instead of merging into the
local target branch; the card sits in Merging until GitHub reports the PR
merged. Only the server pushes and only the server calls gh — an agent never
does either (ADR 0002 unchanged on that point).

## Setting

- `ProjectSettings.prMode: boolean` in `src/types.ts`, default `false` in
  `DEFAULT_SETTINGS` (src/store.ts), shape `prMode: "boolean"` in
  `SETTINGS_SHAPES`, accepted by `parseSettingsPatch` with the `prReviews`
  400 pattern (`prMode must be a boolean`). No schema migration: settings are
  a JSON blob validated per key.
- The save is refused with 400 (`prMode needs a GitHub remote on the
  configured host`) when the project has no GitHub remote (`project.github
  === null`). PR mode without a GitHub host is not a state the board holds.
- The PR base is the project's resolved target (the `targetBranch` ladder,
  ADR 0007); the PR head is the card branch. `targetBranch` and `prMode`
  compose: an integration branch as target gives PRs from card branches into
  that branch.
- Project settings UI: a "PR mode" `CheckRow` next to "PR reviews"
  (src/ui/settings.tsx), same `disabled={project.github === null}` gate and
  needs-a-remote description prefix.

## Merge turn (PR variant)

The merge turn stays an agent turn — the rebase, the gates and the
diff-security-review keep a human-accessible failure path. Its target-side
steps change:

- `mergePrompt` (src/prompts.ts) gains a PR-mode variant, selected by the
  project setting. The variant keeps: rebase the card branch onto
  `origin/<target>`, re-run the project's verification, the
  diff-security-review before reporting, and `needs_you` on a blocking
  finding. It removes: the fast-forward of the local target and
  `git merge --ff-only`. It adds: "Do not merge and do not push: after you
  report integrated, the server pushes the branch and opens the pull
  request." This is a wording change to what prompts say — approved with
  this spec.
- The `integrated` proof changes for a PR-mode merge turn only
  (src/turn.ts git facts): `integrated` is "the worktree HEAD is the card
  branch's tip and the tree is clean" — the branch is rebased and verified,
  ready for the server's mechanical steps. For every other project the proof
  stays `targetContains`. `classify` (src/runner.ts) is otherwise unchanged:
  `integrated` still only comes from a merge turn.
- On an `integrated` report from a PR-mode merge turn, the server settles
  with two steps in place of `serverMergePush` of the target:
  1. Push the card branch: `git push --force-with-lease origin
     refs/heads/<branch>` run in the main checkout with the same credential
     plumbing as `serverMergePush` (per-host git tokens via `gitAuthEnv`,
     pinned origin URL). Force-with-lease is safe here: the server is the
     branch's only writer, and a rebase between two pushes rewrites history.
  2. Open the PR: `gh api repos/{repo}/pulls -X POST -f head=<branch>
     -f base=<target> -f title -f body` through `runGh` and `ghEnvFor`. The
     title is the card's title; the body is the report's summary/details
     plus a footer naming Ottr as the opener. Before creating, one
     `gh pr list --head <branch> --state open` adopts an existing open PR
     for the head (a retry after a half-done settle must not open a second
     PR).
  - Success: the card is `merging`/`idle` with the PR number, URL and head
    SHA stored, and `pushSha` pinned to the PR head so the CI watch takes
    over. The card is not pickable while its PR is open (a gate in
    `pickRunnable`), and it occupies no merge slot: a project may hold
    several open PRs at once.
  - Failure: a failed push or a failed gh call parks the card at
    `merging`/`needs_you` with the command output, like today's push-failure
    park. Any user reply re-runs the merge turn; the agent sees a rebased
    branch (the restart hint spares repeated suites) and the server step is
    idempotent (adopt-or-create, force-with-lease).

The merge-hold machinery that audits the local target branch
(`mergeHoldMismatch`, the hold-tip lease, OTTR-326 branch resets) does not
run for PR-mode cards: nothing local is pushed to the target. The
`mainUnpushed` hold (`pushHold` / "waiting for main to reach origin/main")
does not gate PR-mode cards either — the local target branch is never
written.

## While the PR is open

- Stage Merging, state idle (no `!` badge). The drawer shows the PR link
  ("PR #N") from new task fields. The worktree stays.
- No ottr write touches the PR: no merge, close, comment, review event,
  label or reviewer. Humans merge on GitHub under the repo's protection
  rules.

## PR close without merge

The supervisor gains a PR pass (`prPass`, server process, alongside
`ciPass`): one open-PR list call per project per poll window (5 minutes, the
Dependabot cadence pattern), response parsed with the `parsePullPage`
untrusted-data rules; a tracked PR that left the open list gets one
per-PR `gh api repos/{repo}/pulls/N` call to read its settled state.

- `merged_at` set: the tracker fetches the target and finishes the card with
  the today-shaped done write — `pushSha` pinned to the PR's merge commit
  when it is on origin (CI watch then guards the merged target head and
  files follow-ups exactly as today), a release stamp when a tag points at
  that commit, the worktree removed, card `done`/`idle`.
- Closed without merge: the card returns to `in_progress`/`needs_you` with
  reason "PR #N closed without merging". The branch and worktree stay so a
  reply can iterate; `pushSha` clears. A later merge turn pushes the branch
  again and opens a fresh PR (GitHub opens a new PR for a branch whose old
  PR is closed). Cancelling the card ends it as today.

## CI watch on the PR head

- `ciPass` extends to PR-mode cards in Merging: the same
  `actions/runs?head_sha=<pr head>` poll, the same `CI_WAIT_MS` (2 h) and
  `GH_FAIL_LIMIT` (10) give-ups, the same `ciVerdict`.
- A failed run on the PR head does not file a separate card: the tracker
  replies on the same card with the failed-check list and the
  `gh run view --log-failed --repo <repo>` instruction (the
  "CI failed on the PR head" wording), clears `pushSha`, and requeues the
  card `in_progress`/`queued` — one fix attempt per head SHA, the same
  one-fix-per-push dedupe rule as `ciPass`. The fix lands through the normal
  flow: work turn, merge turn, branch push updates the same PR.
- A failed run on the merged target commit after `done` keeps today's
  follow-up-card flow unchanged.

## Store

- Additive task columns: `pr_number INTEGER`, `pr_url TEXT`,
  `pr_head_sha TEXT`, all nullable — added to the `CREATE TABLE` text in
  src/store.ts and migrated in `ProjectStore.open` with the column-backfill
  pattern in the same commit (ADR 0003). No new `stage` or `state` enum
  value, so no CHECK-constraint rebuild.
- `TaskView` carries the PR fields; the drawer links the PR.

## ADR

Implementation adds `docs/adr/0008-pr-mode-per-project.md`, superseding
ADR 0002: integration shape is a per-project choice — ff-only into the
target stays the default; PR mode pushes the card branch and lets GitHub
merge under the repo's protection rules; agents still never push, and the
server remains the only writer of origin.

## Related work, not in this card

- The branch push and gh calls run behind the install's corporate proxy with
  the same env as every git/gh call today; proxy work is its own P1 card.
- Token documentation (which token needs Pull requests: write on the GHE
  host) belongs with the token-docs card; PR mode only consumes the existing
  board GitHub token (`ghEnvFor`) and per-host git token (`gitAuthEnv`).

## Non-goals

- Ottr never merges, closes, approves or comments on a pull request.
- No GitLab, Bitbucket or other forge; one GitHub host per board
  (docs/specs/github-host.md).
- Same-repo PR heads only — no fork-based PRs.
- No draft PRs, labels, reviewers, assignees or PR-template handling.
- No automatic rebase while the PR is open when the target moves; a reply
  re-runs the merge turn.
- No change to the release flow: releases are still cut from the target
  after GitHub lands the merge.
- No new outcome status: `integrated` keeps its name, only the PR-mode proof
  differs.
- Ottr does not rewrite any project's AGENTS.md; a project that enables PR
  mode updates its own merge-turn section (agent-data repo).
- The `prReviews` watcher keeps its current behavior; PR-mode PRs are normal
  PRs to it.

## Acceptance checks

- `prMode` off: every existing test unchanged and green; prompts, settle and
  CI watch byte-identical.
- The settings route accepts only a boolean and refuses `true` on a project
  without a GitHub remote with 400; the UI row disables like "PR reviews".
- Happy path on a PR-mode project: merge turn runs the PR variant (no
  `git merge --ff-only` prompt text), the server pushes the branch and opens
  the PR, the card sits `merging`/`idle` with the PR link, is not pickable,
  and occupies no merge slot; a second card of the same project can merge in
  parallel.
- PR merged: card `done`, worktree removed, `pushSha` = the merge commit, a
  failed target CI after that files a follow-up card as today.
- PR closed unmerged: card `in_progress`/`needs_you` with the reason, branch
  and worktree kept; a reply re-merges and opens a new PR.
- CI failure on the PR head: one supervisor reply per head, card requeued;
  the fixed push updates the same PR.
- A failed push or gh call parks `needs_you` with the output; a reply
  retries without opening a second PR.
- Fresh and migrated databases converge on the new columns; no CHECK
  migration.
- `bun run check` and `bun test` exit 0 from the worktree root.
