# 0008. PR mode is a per-project choice

Date: 2026-11-06

## Status

accepted

## Context

ADR 0002 fixes one integration shape: the merge turn rebases the card branch
onto the target and fast-forwards the local target branch, and `serverMergePush`
pushes the target with the server's credentials. A team whose main branch is
protected with required reviews cannot take that push — GitHub refuses it — so
they had to point `targetBranch` at an integration branch and open the pull
request to main by hand. PR mode removes that hand step
(docs/specs/pr-mode.md, Problem).

## Decision

The integration shape is a per-project choice. The default stays ADR 0002:
rebase, `git merge --ff-only` into the local target, and the server pushes the
target. A project that opts in sets `prMode`: the server pushes the card branch
(`--force-with-lease`, server credentials) and opens a pull request to the
resolved target via `gh` on the configured GitHub host; GitHub merges under the
repo's protection rules, and the card waits in Merging until the PR merges
(docs/specs/pr-mode.md, Decision). Agents still never push and never call gh;
the server remains the only writer of origin.

## Consequences

- Protected mains integrate without a hand-opened PR; the card tracks the PR
  from Merging to done.
- The merge-hold machinery guarding the local target branch (`mergeHoldMismatch`,
  the hold-tip lease, branch resets, the `mainUnpushed` hold) does not apply to
  PR-mode cards: nothing local is pushed to the target.
- A PR-mode card occupies no merge slot, so a project may hold several open PRs
  at once.
- Ottr never merges, closes, approves or comments on a PR; humans merge under
  the repo's protection rules.
- ADR 0002 stays authoritative for the default path and for "only the server
  pushes"; this ADR supersedes it only for projects that opt in.
