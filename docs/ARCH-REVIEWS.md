# Reviews

Periodic whole-repo reviews for this repo. The project's **Review** button and
**Create release** start the same review (`reviewBody` in `src/prompts.ts`). A
release adds the publish after it. The board enforces the cadence: a project
page shows **Review due (n commits)** when the cap is reached.

## Model

- **Watermark**: the commit that the newest finished review saw, that is, the
  frozen base of the newest done review card (a release card or a Review card).
  Δ = commits on the target since that commit. A legacy `docs(arch-review):`
  commit also counts, and the newer watermark wins. Without either, Δ is the
  whole history. Tags do not count.
- **Trigger A — cap**: Δ ≥ the project's `archReviewCap` → a review is due.
  Default 150; the cap bounds how long a commit waits for a review.
- **Trigger A0 — un-reviewed**: without a watermark (Δ = the whole history), a
  review is due whatever Δ is. A newly added project is therefore un-reviewed.
  Planting a `docs(arch-review): baseline` commit (below) marks the project
  reviewed without a full pass.
- **Trigger B — release**: every release runs the full review, and its card
  becomes the next watermark.
- **One review at a time**: the board refuses a new review or release while a
  review card is open or its findings are not done.
- **Review card**: when the review approves while its findings are still open,
  the card waits in Merging. It is done (and a release publishes) only when
  all its findings are done.
- **Merge hold**: while a review is open, only its findings merge. A finding
  is a card Ottr filed for the review (linked as `followUpOf`), a card that
  such a finding filed, or a card that a finding depends on. Every other card
  waits in Merging until the review card is done. Thus every commit lands in
  exactly one review window, and a release ships only reviewed work and the
  fixes that its review asked for.
- **Check and cap**: the review records its findings with the `propose_task`
  tool (a rank each, plus a confirmed `critical`/`high` security severity) and
  files none itself. After the run, Ottr checks the 10 best-ranked findings —
  plus the confirmed high or critical security findings — with a second model:
  one fresh omp session (never `--resume`, memory off, `read,grep,glob` only,
  role `adversary`, or `critic` when the review ran on Anthropic) re-verifies
  evidence, real effect, duplicates against open cards, and fix size, and
  answers strict JSON verdicts. Only the findings the check keeps become cards.
  The review card's report lists every finding below the cap and every dropped
  finding with its reason, so you can file any of them by hand. A failed check
  run retries once; a second failure parks the review card at needs_you with
  the error. The global **Review check** switch (settings page, default on)
  skips the check run: the top 10 plus the security findings then file
  unchecked. The check run holds a board slot like any other run.

## Recipe (per review)

The review is read-only at its frozen commit and changes no code:

1. Whole-repo review: correctness, security, tests, docs, architecture. It
   starts from the commits since the last review.
2. Each finding is recorded with the `propose_task` tool (rank plus confirmed
   security severity); after the run, Ottr checks the best ones and files the
   kept ones as tracker cards, triaged like any task.
3. Gates, each exit 0: the project's full verification from AGENTS.md (here
   `bun run check`, which includes the license gate `scripts/licenses.ts`,
   `bun test` and `bun run test:mutation`), then the dependency audit gates that
   AGENTS.md names (here `bun audit --audit-level=high`).
   `bun run test:mutation` always re-tests every mutant: there is no incremental
   cache (finding R8-3 — the command runner's cache never notices changed tests, so a
   deleted or weakened killing test kept its stale "Killed" result). Never re-enable
   `incremental`/`incrementalFile`; a gate run can never reuse results from an
   earlier test suite.
4. Quality reports. Each finding becomes a card, and the log entry gives the
   counts:
   - `bun run audit:quality`: duplicate code (jscpd, with the measured baseline
     as its threshold) and dead code (knip).
   - Cognitive complexity: Biome reports each function over the limit of 15 as
     an info, never as an error, and the repo has no ignore comments for it.
     `bunx biome lint --only=complexity/noExcessiveCognitiveComplexity --max-diagnostics=none src scripts extension`
     lists them with their scores. File a card for the worst function.
   - GitHub: the open Dependabot, code scanning and secret scanning alerts
     (`gh api repos/ottr-ai/ottr/dependabot/alerts?state=open`, the same path
     with `code-scanning` and `secret-scanning`) and the newest run of the
     weekly `Audit` workflow (`gh run list --workflow audit.yml --limit 1`).
     File each open alert and each red job as a card.
5. A full security audit with the `security-audit` skill.
6. The architecture pass: the `codebase-design` and `ponytail-audit` lenses
   over module seams, coupling, naming, test seams and over-engineering.
7. The report details end with a one-line log entry: date, commits covered,
   findings, cards. Since 2026-10-13 that entry stays on the review card,
   because the review changes no code. The log below holds the older reviews.

Baseline: to start counting from a chosen point without a full review first,
commit `docs(arch-review): baseline`. The first real review then covers
everything after it.

## Log

| Date | Commits covered | Findings | Fixed | Cards |
| --- | --- | --- | --- | --- |
| 2026-09-30 | 300 (root → 06a96f6, first review) | 18: 4 bugs (done_at backfill after interrupted migration, ask `recommended` index remap, follow-up image-save error text, boot-smoke hang + unchecked scripts/), 2 security (HTTP origins on public hosts, login enumeration/rate limit), 8 test seams (server routes, turn lifecycle, runner `startRun`, `connectLive`, app.tsx policy, mutation coverage of .tsx/.js, Windows CI, e2e-steer gate), 2 shrink/naming (unused exports + private `firstSessionTitle`, `push.ts` rename), stale docs, mutation gate too slow to finish (~15 h, mass timeouts) | none (report-only run) | e0397e31, 13875246, 02667420, 2efcfb9c, 7a7636f1, 0f066cff, 7f31693f, a57adb2c, ad84cc63, dc0e32bf, 613bf146, a5a0baee, a758d543, 3336a4c0, dfb5bf9a, 3ef97556, 2244d1cf, c2b37741 |
| 2026-10-12 | 212 (efc432c → f4a0344), plus 7 that landed during the run and were merged at rebase: two omp bumps; 73a4e21, folded into the R3-1 sweep guard; f00cac7 (board service named `server` again), dropping the legacy-container check; e712af1 (board under init) and 64266af (its lock takeover), merged with the review's lock release (c2675cf re-dates main's dead-holder fixture, which 64266af left failing on hosts booted after 2026-10-02); e930d93 (held-card links), combined with the per-card merge hold | 119: 61 bugs, 10 security, 11 test seams, 14 delete, 10 shrink, 4 docs, 9 coupling/yagni/stdlib/native/seam. Plus 11 found while fixing: procps missing from the worker image, `ps` output over 1 MiB (ENOBUFS), zombie flood under bun as PID 1 (pid_max 99999), unbounded request-body read, runner cap autosaved on Settings open, restart during a cancel blocked project remove, fixed test ports faking mutation kills, a vacuous idle-timeout test, the base mutation cache keeping out-of-scope results, concurrent first open failing "database is locked", and at merge the board under init refusing its old pid-1 lock rows. 11 regressions of the run's own fixes were caught before commit | 108 of the 119 (R5-14 superseded) and 8 of the 11 new ones (the pid-1 lock rows were fixed on main by 64266af, so the review's own fix was dropped), in 14 commits (c2675cf to eb8102f); the rest of R5-11 and R6-8 moved to cards; 5 small remainders dropped (R1-12 boot remote refresh, R3-14 `WorkerRequest.id`, R4-3 case clash on Windows under `OTTR_DATA_DIR`, R6-12 `get<T>`, R8-15 old `.gitignore` entries). Mutation breaks raised: release 72, turn 76, worktree 60, update-image 73 (new config); base stays 64: the final merge-turn run (no port collisions) measured 75.88, 69.70 without the app.ts/turn.ts results the cache still carries; card 8b55888c sets it | 03e77d60, 3bb048de, f91825ed, 52fb8b2e, bab7c4b3, 829926ca, e3c1cd0c, 30d2981a, dd1fc9ac, fb88016b, e942c695, 4c099eeb, 8b55888c |
