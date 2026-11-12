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

## Detection: the board suggests PR mode (OTTR-675)

Where the GitHub remote resolves (project add, git init, a settings save that
refreshes remotes), the board probes the target branch's repository rules:
`GET <apiBase>/repos/{o}/{r}/rules/branches/{branch}` with the board's GitHub
token for that host (per-host git token, else `GH_TOKEN` on the configured
host). The probe is advisory and total:

- A `pull_request` rule on the target with PR mode off turns on the project
  header advisory; its "Turn on PR mode" action saves `{ prMode: true }`.
- A failed or 404 probe, a missing token, a non-GitHub remote, or PR mode
  already on shows nothing. The probe never blocks a route.

When a merge turn's server push is refused by a branch rule (git carries
GitHub's "protected branch" / "repository rule violations" wording), the
card's `needs_you` reason names PR mode as the fix.

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
    over. An idle card takes no merge slot, so a project may hold several
    open PRs at once; only a queued card merges again (see below).
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

### Stranded merge safeguard (OTTR-860)

The PR ship records its PR number before normal settlement writes
`merging`/`idle`. A non-cancelled PR-mode card must not wait in
`merging`/`idle` without a PR number. This state has no PR for the
supervisor to watch.

- When kept-worktree hygiene reaches a non-cancelled `merging` card without
  `prNumber`, it parks the card at `needs_you` with a clear recovery reason.
  It preserves the branch, worktree, kept files, and PR fields before cleanup.
- At restart, `recoverRestarted` parks an existing non-cancelled PR-mode
  `merging`/`idle` card without `prNumber` as stranded. The reason states
  that no PR is recorded and asks for a reply to retry the merge turn.
  The branch, worktree, and PR fields stay unchanged.
- Neither safeguard ships the branch, rebases it, opens a PR, or queues a turn.
  A user reply remains the recovery path.
- Cancelled cards, non-PR projects, and idle cards with a PR number keep
  their existing behavior.

Acceptance: restart and hygiene regression tests fail without the safeguards.
After the fix, each affected card reads `merging`/`needs_you` with a recovery
reason and retains its branch, worktree, and PR fields. Tests also prove that
cancelled cards, non-PR projects, and valid idle PR cards keep their behavior.

### Cancel during the PR ship (OTTR-842)

The ship reads the current card from `ProjectStore` before each next outbound
ship action and before each PR metadata write. It continues only when
`cancelledAt` is null and the current state is `running` or `preparing`.
The captured task does not grant permission to continue after an await.

Cancel owns the card after either the cancelled/`idle` result or the
cancel-kept `needs_you` result. The latter can clear `cancelledAt`, so that
field alone does not prove that the turn still owns the card. The ship must
not start a later push, PR request, source PR adoption, or PR-state write
after cancel takes ownership. This also protects the kept reason and files.

An already-started push or GitHub request can still finish. A later state
read cannot undo that external action. The remote card-branch delete rules
below stay unchanged, including the target-branch and source-PR-head
exclusions and the cancel-kept exception.

### The second merge turn (OTTR-799)

A PR-carrying card merges again like any other card. The merge slot takes
a queued `merging` card whether or not it carries a PR (`mergeSlot` gates
on the queued state only, never on `prNumber`); an idle card is never
picked, because it is not queued. The `integrated` settle re-runs the ship
step: the server pushes the branch (`--force-with-lease`) and
`openPullRequest` (src/prs.ts) adopts the open PR of the head, else creates
one. The card stores the PR number and URL the step returned, and
`prHeadSha` and `pushSha` pin the new branch tip, so the CI watch follows
the new head.

The paths that reach the second merge turn (each was stuck before
OTTR-799):

- CI failed on the PR head: the `ciPrHeadReply` requeue runs a work turn,
  then the merge turn re-ships; the push updates the same PR.
- PR closed without merge: the reply's merge turn pushes the branch and
  opens a fresh PR; the card stores the new number, and `prPass` watches
  only the new PR.
- Any reply on a `merging` card with a `prNumber` (for example the conflict
  park of OTTR-789, or a push-failure park): the merge turn re-ships under
  the normal holds.

While a merge turn is live, the supervisor passes stay off the card:
`prPass` and the PR-head CI watch skip a card whose state is
`running`/`preparing`, and the turn's own settle decides. `prPass` also
skips a card in state `queued`: since OTTR-799 that state on a card with a
`prNumber` is exactly a recovery card waiting for its merge dispatch, and
a settle against the old PR (closed, merged, or conflicting) would park
the recovery before the ship can run. The ship step never probes a PR's
state: when GitHub cannot take the ship (for example the PR merged
mid-turn and the branch adds no new commits), the ship fails closed into
the `needs_you` park, and the next `prPass` settles the card by the merged
or closed rule.

### Cards filed from an existing pull request

A Dependabot PR becomes a card that carries the PR as its source (OTTR-760):
`source_pr_number`, `source_pr_url`, the head ref and head sha at filing
time, whether the head lives in a fork, and the Dependabot flag — additive
columns migrated in `ProjectStore.open` like the PR fields above. The ship
step checks the source before it ever opens a PR:

- A clean bump — the card branch holds exactly the source PR's content
  (same tip, or an identical tree after a cherry-pick) — adopts the source
  PR: `pr_number`/`pr_url`/`pr_head_sha` take its values, the card waits in
  `merging`/`idle`, and the PR pass finishes it when GitHub merges. No
  second pull request is ever opened, and `pushSha` stays empty: the board
  watches the PR, not a sha the author can rebase away.
- Fixes beyond the PR head land on the PR's own head branch only when that
  branch lives on origin and Dependabot does not own it: the push is a plain
  fast-forward (a moved remote branch rejects instead of overwriting the
  author's commits) and the card adopts the PR afterwards.
- Everything else — a fork head, a Dependabot branch (the bot abandons a PR
  once someone else pushes to it), a diverged branch — comments on the
  source PR (`@dependabot rebase` for Dependabot, a note about the parked
  fixes otherwise) and parks the card `merging`/`needs_you` with a reason
  that names the PR and the card branch.

Cards without a source PR keep the adopt-or-create ship step above; the
ff-only merge flow is untouched.

## While the PR is open

- Stage Merging, state idle (no `!` badge). The drawer shows the PR link
  ("PR #N") from new task fields. The worktree stays. The one exception is
  an open PR that conflicts with its target branch: see "Open PR that cannot
  merge".
- No ottr write touches the PR: no merge, close, comment, review event,
  label or reviewer. Humans merge on GitHub under the repo's protection
  rules.

## PR close without merge

The supervisor gains a PR pass (`prPass`, server process, alongside
`ciPass`): one open-PR list call per project per poll window (5 minutes, the
Dependabot cadence pattern), response parsed with the `parsePullPage`
untrusted-data rules; a tracked PR that is not in the open list gets one
per-PR `gh api repos/{repo}/pulls/N` call to read its state. The list is one
page of 100 pull requests, so that read can also say that the PR is open. A
tracked PR that is in the open list gets the same per-PR call when its card
waits `idle` or holds the conflict reason (see "Open PR that cannot
merge").

- `merged_at` set: the tracker fetches the target and finishes the card with
  the today-shaped done write — `pushSha` pinned to the PR's merge commit
  when it is on origin (CI watch then guards the merged target head and
  files follow-ups exactly as today), a release stamp when a tag points at
  that commit, the worktree removed, card `done`/`idle`.
- Closed without merge: the card returns to `in_progress`/`needs_you` with
  reason "PR #N closed without merging". The branch and worktree stay so a
  reply can iterate; `pushSha` clears. A later merge turn pushes the branch
  again and opens a fresh PR (GitHub opens a new PR for a branch whose old
  PR is closed). Cancelling the card ends it as today and deletes the remote
  card branch (the delete section below); with a still-open PR, GitHub closes
  the PR when its head branch goes.

## Remote card-branch delete (OTTR-800)

The ship step pushes the card branch to origin; until now nothing deleted it
again, so every finished PR-mode card left one branch on origin for ever
unless the repo's "Automatically delete head branches" setting cleaned up.
The server now deletes the remote card branch when the card ends:

- PR merged: after the done write (`finishPrMerge`), the server deletes
  `refs/heads/<card branch>` on the pinned origin URL. A ref that is already
  gone (GitHub's auto-delete ran first) counts as success.
- Cancel: the cancel flow deletes the remote card branch after the worktree
  disposal, with an open PR and without one. When the card's pull request is
  still open, deleting its head branch makes GitHub close the pull request —
  the one way an Ottr action ends a PR, and a deliberate exception to the
  "never closes" rule below: no API call closes anything; the card's own
  branch delete does. The card log names the branch, and the PR number when
  the card's own open PR closes with the branch. With
  no PR open (closed unmerged earlier, or the push landed and the PR creation
  failed), the delete runs the same way.
- The delete is the push's mirror (src/worktree.ts, next to `pushBranch`):
  the same pinned-origin-URL guard, the same credential plumbing (`git()`
  adds the host auth), a refspec of exactly `refs/heads/<card branch>`, and
  the stale remote-tracking ref cleaned up. A missing remote ref is success;
  a failed delete never blocks the done write or the cancel — it logs one
  line on the card.
- Never deleted: the project's target branch, and an OTTR-760 source PR's
  head branch (`sourcePrHeadRef`) — the card does not own them; the delete
  refuses them by name and the refusal lands in the card log.
- `prMode` off: no delete ever runs (the non-PR flow pushes no card branch).
  A cancel that kept the worktree (unsaved work) is not a card end: no
  delete. Branches that earlier cards left on origin are not swept.

## Open PR that cannot merge (OTTR-789)

An open PR can conflict with its target branch. GitHub then cannot merge the
PR, and the card must show that it needs a human. The open-PR list carries
no `mergeable` field. Only the per-PR response
(`gh api repos/{repo}/pulls/N`) carries it: `true`, `false`, or `null` while
GitHub still computes the value.

The conflict reason is one fixed text for each PR number:

```
PR #N cannot merge: it conflicts with the target branch. Resolve the conflict on the pull request, or reply to rebase the branch onto the target; the tracker pushes and updates the pull request.
```

In each PR poll window, `prPass` looks at each tracked card whose PR is in
the open list. The supervisor reads the PR once with the per-PR call when
one of these conditions is true:

- The state of the card is `idle`.
- The state of the card is `needs_you` and its reason is exactly the
  conflict reason.

A card in any other state gets no read. The cost is one more read for each
such card in each 5-minute window.

The open list is one page of 100 pull requests. A tracked PR that is not in
the list always gets the per-PR read of "PR close without merge". When that
read says that the PR is open (an older PR beyond the page, or a reopen
since the list), the write rules below apply to it in the same way.

The result of the read decides the write:

- `mergeable` is `false` and the card is `merging`/`idle`: the card goes to
  `merging`/`needs_you` with the conflict reason. The stage, the PR fields,
  `pushSha`, the branch and the worktree stay unchanged. The card log gets
  one line (`supervisor: PR #N has merge conflicts; card parked`).
- `mergeable` is `true` and the card holds exactly the conflict reason: the
  card returns to `merging`/`idle` with `needsReason` null. The card log
  gets one line (`supervisor: PR #N can merge again; card waits on GitHub`).
- `mergeable` is `false` and the card already holds the conflict reason, or
  `mergeable` is `true` and the card is `idle`: no write.
- `mergeable` is `null`, absent, or not a boolean (GitHub still computes
  it, or the body is untrusted): no write. The next window reads again.
- The per-PR read says that the PR is no longer open (it settled between
  the list and the read): no write in this window. The next window settles
  the card through the merged and closed rules of "PR close without merge".
- A read failure or an unparseable body logs and skips, like the settled
  read.

A parked card stays tracked. When its PR merges, the card finishes `done`
through the merged rule of "PR close without merge". When its PR closes
without a merge, the card parks `in_progress`/`needs_you` with the closed
reason. A CI failure on the PR head of a parked card requeues the card as
for an idle card and clears the conflict reason.

Recovery: a reply is the recovery path (OTTR-799). The reply queues the
card, the scheduler picks the queued card for the merge slot, the merge
turn rebases the branch, and the ship step pushes it and updates the same
pull request ("The second merge turn (OTTR-799)"). When GitHub can merge
the PR again without a reply — the human resolved the conflict on GitHub —
the next poll window returns the parked card to `merging`/`idle`. While
the card is `queued` for its recovery merge turn, `prPass` skips it: a
settle against the old PR state would park the recovery before the ship
can run.

The reason text changed with OTTR-799, and the un-park match is exact.
`ProjectStore.open` runs one idempotent migration on every open: a stored
`needs_reason` that matches the pre-update text (`PR #N cannot merge: it
conflicts with the target branch. Resolve the conflict on the pull
request.`) is rewritten to the current text, so cards parked before the
update take the automatic recovery again. The statement is an additive
value backfill in the `ProjectStore.open` pattern; no row is dropped,
deleted or altered in shape.

Non-goals of this section:

- No automatic rebase. The non-goal below stands.
- No reaction to `mergeable_state` values such as `blocked`, `behind`,
  `unstable` or `draft`. Pending reviews and checks are normal waits.
- No write to the pull request.
- No new task column, no UI change and no prompt change.

## CI watch on the PR head

- `ciPass` extends to PR-mode cards in Merging: the same
  `actions/runs?head_sha=<pr head>` poll, the same `CI_WAIT_MS` (2 h) and
  `GH_FAIL_LIMIT` (10) give-ups, the same `ciVerdict`.
- Either give-up clears `pushSha` and leaves the PR card `merging`/`idle`.
  The card log gets exactly one `supervisor: ... CI watch given up` line.
  The board pill then reads `PR #N open · waiting for merge`, as after a
  CI pass. That head has no CI watch until a later ship pins `pushSha`
  again. The re-ship path from OTTR-799 (`ca543f3`) pins the new PR head.
- The no-run wait expires when `now - (doneAt ?? updatedAt)` exceeds
  `CI_WAIT_MS` (2 hours). PR cards have `doneAt` null, so they use the
  movable `updatedAt` as the timer base. Any card write moves that base
  and the no-run deadline. Merge-push cards use `doneAt`, so a later card
  write does not move their deadline.
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
  `pr_head_sha TEXT`, plus the OTTR-760 source-PR columns
  (`source_pr_number`, `source_pr_url`, `source_pr_head_ref`,
  `source_pr_head_sha`, `source_pr_cross_repo`, `source_pr_dependabot`),
  all nullable or defaulting to 0/false — migrated in `ProjectStore.open`
  with the column-backfill pattern in the same commit (ADR 0003). No new
  `stage` or `state` enum value, so no CHECK-constraint rebuild.
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

- Ottr never merges, closes, approves or comments on a pull request through
  the GitHub API. The one exception is mechanical (OTTR-800): cancelling a
  card deletes its own remote branch, and GitHub closes an open PR whose
  head branch disappears.
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
- The rules probe: a pull_request rule with PR mode off sets the suggestion;
  an absent rule, an error or 404, and PR mode on do not (unit tests for the
  parse and the view field). A branch-rule push refusal names PR mode in the
  card's needs_you reason; a plain push failure does not.
- Happy path on a PR-mode project: merge turn runs the PR variant (no
  `git merge --ff-only` prompt text), the server pushes the branch and opens
  the PR, the card sits `merging`/`idle` with the PR link, is not pickable,
  and occupies no merge slot; a second card of the same project can merge in
  parallel.
- A successful PR ship or source PR adoption ends its turn without a
  cancellation error.
- PR merged: card `done`, worktree removed, `pushSha` = the merge commit, a
  failed target CI after that files a follow-up card as today.
- PR closed unmerged: card `in_progress`/`needs_you` with the reason, branch
  and worktree kept; a reply re-merges and opens a new PR.
- CI failure on the PR head: one supervisor reply per head, card requeued;
  the fixed push updates the same PR.
- OTTR-799: a queued `merging` card with a `prNumber` is pickable and
  re-ships — the push updates the same PR (or opens a fresh one after a
  close), and `prHeadSha`/`pushSha` pin the new tip; an idle PR card is
  never picked; a source-PR card's second ship never opens a second PR.
- OTTR-841 extends OTTR-799 without a second ship path. After a PR-head
  CI failure, the fix and merge turns update the same PR. Both
  `prHeadSha` and `pushSha` equal the new branch tip. A failed run on that
  tip queues another fix on the same card, with no separate follow-up card.
  A cleared watch after a give-up also resumes after the next successful
  ship pins a new tip. These checks use the turn loop, the supervisor and
  the same store.
- A failed push or gh call parks `needs_you` with the output; a reply
  retries without opening a second PR.
- Cancel during the PR ship: use `createTurnLoop().runTurn` and `.cancel`
  with the real `ProjectStore` for these checks:
  - Complete cancel while the integrated proof awaits, then release the
    proof. No branch push or PR request starts, and no PR metadata changes.
  - Complete cancel while the branch push awaits, then release the push.
    No PR request starts, and no PR metadata changes, whether the push
    succeeds or fails. The test does not claim to undo the push.
  - Complete cancel while the PR request awaits, then release its success
    or failure. The ship preserves the cancelled/`idle` card and its PR
    metadata. The test does not claim to undo the GitHub request.
  - Complete cancel while a source PR read, tree comparison, or source-head
    push awaits. After that action returns, no later ship request or source
    PR adoption occurs, and no PR metadata changes.
  - Repeat with cancel-kept `needs_you`, where `cancelledAt` is null.
    The ship preserves the state, kept reason, kept files, and PR metadata.
- Open PR with `mergeable: false`: the card is `merging`/`needs_you` with
  the conflict reason. The PR fields, `pushSha`, the branch and the worktree
  stay unchanged, and the card log gets one line. A later window with the
  same answer writes nothing and logs nothing.
- Parked card and `mergeable: true`: the card returns to `merging`/`idle`
  with `needsReason` null, and the card log gets one line.
- `mergeable` `null`, absent or not a boolean, a failed read, and a per-PR
  read that says the PR is no longer open: no write.
- An open PR that is not in the open list (beyond its one page of 100): the
  per-PR read parks the idle card on `mergeable: false` and returns the
  parked card to `idle` on `mergeable: true`.
- A card in any other state (`queued`, `running`, or `needs_you` with a
  different reason) gets no per-PR read while its PR is in the open list,
  and no write for an open PR in any case.
- A parked card stays tracked: a merged PR finishes the card `done`, and a
  PR closed without a merge parks it `in_progress`/`needs_you` with the
  closed reason.
- Remote card-branch delete (OTTR-800): the delete runs real git against a
  bare origin — the branch is gone, a second delete of the same branch
  reports success, a target-branch name or a source-PR head is refused.
  Call-site tests assert the exact git arguments for merged, cancel without
  an open PR, and cancel with an open PR. A failed delete leaves the card
  done (or cancelled) and adds one log line. With `prMode` off, no delete
  runs.
- Fresh and migrated databases converge on the new columns; no CHECK
  migration.
- `bun run check` and `bun test` exit 0 from the worktree root.
