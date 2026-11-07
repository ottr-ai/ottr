# Review due

Each project can require a whole-repo review after a number of commits
(**Settings**, per project; default 150). While the review is open, a project
page shows **Review due (n commits)**.

The project's **Settings** page shows the counter next to the cap: commits
since the base, the base commit, and the review card that set the base. The
base commit links to the project's git host when the project has a GitHub
remote; the card id opens the review card. With no full review yet, all
commits count. While a review is open, the line says so.

## When a review starts

- **Cap**: the project has `archReviewCap` or more commits since the last
  finished full review. A newly added project counts as un-reviewed, so a
  review is due at once. A release does not reset this counter; only a full
  review (the Review button's card) does.
- **Release**: **Create release** always runs the full review before it tags
  and publishes. Its review runs the delta mutation gate (see below) instead
  of the full mutation suite.
- **While idle**: with **Run due reviews while idle** on (Settings; default
  on), Ottr files the full review card itself when all of these hold: the
  project shows Review due, no review or release is open in the project, no
  turn runs or prepares on any project, no auto-started review runs on the
  board, and the board has seen no input for 2 hours. Any change through the
  UI or the API resets that clock. A board restart counts as input, so a
  restart never starts a review at once.
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
   audit gates that `AGENTS.md` names. A release review runs the delta
   mutation gate instead of the full mutation suite; a full review runs the
   full suite with its break thresholds.
4. Quality reports: duplicate and dead code, cognitive complexity, and the
   project host's open dependency, code scanning and secret scanning alerts.
   A cleanup sweep records unused exports and files, stale notes, docs that
   disagree with the code, swallowed errors, network calls with no timeout,
   and unbounded in-memory growth.
5. A full security audit with the `security-audit` skill and the
   `codeguard-*` rules that match the files, then an architecture pass over
   module seams, coupling and over-engineering.

Each merge turn also runs the `diff-security-review` skill on the branch diff
before it integrates. A confirmed high or medium finding blocks the merge.

Each kept finding becomes a tracker card, triaged like any task.

## Delta gate

`bun run test:mutation:delta <base>` runs Stryker only on the lines a change
touched. It reads the diff from `<base>` to the current head, gives each
changed line range to the Stryker config that owns the file, and runs those
configs with those ranges. A changed-line mutant that survives or has no
coverage fails the gate; a timed-out mutant counts as detected, as in the full
run. No changed file is mutated by a config: the gate exits 0 without a
Stryker run. Work turns run no mutation gate. Release reviews run it
over the last release tag; a survivor without a reason is a finding. The
Review button and an auto-started review keep the full suite
(`bun run test:mutation`) with its break thresholds.

The gate spawns every Stryker run with `--force`
(scripts/mutation-delta.ts): the configs run with incremental caches
(`reports/stryker-incremental-<config>.json`, gitignored), but the differ
cannot see changes outside the mutated and test files — fixtures, configs,
dependencies, the Stryker version. A release must measure everything, so no
verdict in a release review comes from a cache; only ordinary runs and the
Review button's full suite reuse results.

## Merge hold

While a review is open, only its finding cards merge. Every other card waits
in Merging until the review card is done, so a release ships only reviewed
work and the fixes its review asked for.

## Baseline

To start counting from a chosen point without a full review first, commit
`docs(arch-review): baseline`. The first real review then covers everything
after that commit. A repo Ottr itself creates (the New tab, or the init route
on an empty folder) gets this watermark baked in: its initial commit is
`docs(arch-review): initial commit`, so the project starts reviewed with
delta 0 instead of showing "Un-reviewed — review due" on an empty repo. An
imported repo keeps today's rule: no watermark in its history means the whole
history counts and a review is due.
