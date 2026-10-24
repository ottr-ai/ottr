# Review due

Each project can require a whole-repo review after a number of commits
(**Settings**, per project; default 150). While the review is open, a project
page shows **Review due (n commits)**.

## When a review starts

- **Cap**: the project has `archReviewCap` or more commits since the last
  finished review. A newly added project counts as un-reviewed, so a review is
  due at once.
- **Release**: **Create release** always runs the full review before it tags
  and publishes.
- Only one review runs at a time, and a new review or release waits while the
  open review's findings are not done.

## What the review does

The review runs read-only at a frozen commit and changes no code:

1. Whole-repo review: correctness, security, tests, docs and architecture,
   starting from the commits since the last review.
2. It records findings with the `propose_task` tool, each with a rank and a
   confirmed security severity where it applies. A second memory-less model
   re-verifies the best-ranked findings and the confirmed security findings;
   only the findings the check keeps become cards. The review card's report
   lists every dropped finding with its reason, so you can file any of them by
   hand. The check run can be skipped with the global **Review check** switch
   (settings page).
3. Gates: the project's full verification from `AGENTS.md`, then the dependency
   audit gates that `AGENTS.md` names.
4. Quality reports: duplicate and dead code, cognitive complexity, and the
   project host's open dependency, code scanning and secret scanning alerts.
5. A full security audit with the `security-audit` skill, then an architecture
   pass over module seams, coupling and over-engineering.

Each kept finding becomes a tracker card, triaged like any task.

## Merge hold

While a review is open, only its finding cards merge. Every other card waits
in Merging until the review card is done, so a release ships only reviewed
work and the fixes its review asked for.

## Baseline

To start counting from a chosen point without a full review first, commit
`docs(arch-review): baseline`. The first real review then covers everything
after that commit.
