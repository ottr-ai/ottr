# Delta mutation gate and idle reviews (OTTR-366)

Approved design, 2026-11-03. This spec is the source of truth. The prompt wording change
in `src/prompts.ts` is approved (AGENTS.md hard stop 3). No new npm dependency.

## Why

Full mutation runs (5 configs, 14964 mutants in the main config alone) failed or broke in the
last three release reviews (OTTR-213, OTTR-314, OTTR-345; each took 3 to 4.5 hours). A release
changes about 330 of about 31400 non-test source lines. Releases and work turns run a delta
gate over changed lines only. The Review button keeps the full run. When the board is idle and
a project shows Review due, the supervisor files the full review card itself.

## 1. The delta gate script

Package script: `"test:mutation:delta": "bun scripts/mutation-delta.ts"`.
Usage: `bun run test:mutation:delta <base> [head]`.

- `<base>` required; `[head]` optional, default `HEAD`. The script resolves
  `git merge-base <base> <head>` first, so a moving branch name works as a base.
- Read `git diff -U0 --no-renames <mergeBase>..<head>`. Turn each hunk's added lines into
  `file:start-end` entries: the `+` side start line through start+count-1 (inclusive). A hunk
  with `+0` count (deletion only) gives no range. Deleted files (`+++ /dev/null`) give nothing.
- Ownership: list `stryker*.config.mjs` at the repo root, dynamic-import each, read its
  `mutate` array. Match each changed file against the patterns in order with `Bun.Glob`; a
  pattern starting with `!` excludes; the last matching pattern wins (Stryker semantics).
  A file may belong to more than one config; every owner runs.
- Entries per config: `<file>:<start>-<end>` per hunk. Stryker's range syntax is line based and
  end inclusive (`MUTATION_RANGE_REGEX`, node_modules/@stryker-mutator/core/dist/src/fs/
  mutate-pattern-constants.js: "src/app.js:1-11" mutates lines 1 through 11).
- No entries at all: print `no ranges: no changed file is mutated by a Stryker config` and
  exit 0 without starting Stryker.
- Run the owning configs one at a time, sequentially (the mutation lock in
  `scripts/stryker-load.mjs` is held until process exit, so one Stryker process at a time):

  ```
  <repo>/node_modules/.bin/stryker run <wrapperConfig>
    --mutate <entry>,<entry>,...
  ```

  `--mutate` is a single-valued CLI option with a comma `list` splitter (stryker-cli.js), so
  repeated flags overwrite each other: the entries go into one comma-joined value. The JSON
  report path has no CLI form (commander registers no `--jsonReporter` flags), so the script
  writes a wrapper config next to the real one, runs it, and removes it afterwards:

  ```js
  import base from "<real config as a file URL>";
  export default {
    ...base,
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: "<osTempDir>/ott-delta-<configName>.json" },
  };
  ```

  The report is the mutation-testing-elements schema: parse `files[<path>].mutants`, each
  with `status`, `mutatorName`, `replacement` and `location.start.line`.
- Gate verdict per mutant: its start line lies inside one of that config's ranges and its
  status is `Survived` or `NoCoverage` → failure. `Timeout` counts as detected, like today.
  The main configs run `coverageAnalysis: "off"`, so `NoCoverage` normally never appears; the
  gate keeps the check for configs that enable coverage.
- Exit codes: `0` pass or no ranges; `1` gate failure (any survivor or no-coverage mutant);
  `2` environment failure (bad arguments, git failure, config load failure, Stryker crash or
  a missing report file). Stryker's own exit code is ignored when a report file exists: a
  threshold break must not mask the gate's own verdict.
- Stdout report, stable for agents to quote:
  - failure: `mutation delta gate: FAILED (N survivors)` then one line per mutant:
    `file:line [mutatorName] replacement (status)`.
  - pass: `mutation delta gate: passed (M mutants tested in changed lines, 0 survivors)`.

## 2. Work turns

Run `bun run test:mutation:delta <card base>`, where `<card base>` is the branch's merge-base
with `origin/main`. A survivor gets a test that kills it, or a one-line reason in the turn
report why it cannot change behavior. No ranges means the gate is a no-op (exit 0).

## 3. Release reviews

Replace the full mutation run with `bun run test:mutation:delta <last release tag>` (the tag
the release updates, `git describe --tags --abbrev=0 --match 'v*'`; the repo's first commit
when no tag exists). A survivor without a reason is a finding. Timed-out mutants count as
detected, the same as the full run.

## 4. Full reviews

The Review button and the idle-started review keep the full run (`bun run test:mutation`) and
the break thresholds. Nothing here lowers or removes a threshold or shrinks a mutate set.

## 5. Prompts

`reviewBody` (src/prompts.ts) gains a `kind: "release" | "review"` parameter.

- `kind: "review"` (reviewPrompt: the Review button and the idle-started review): the
  mutation sentence stays as today (full run).
- `kind: "release"` (releasePrompt): the sentence names the delta gate instead: run the
  project's full verification from AGENTS.md, but run the delta mutation gate
  (`bun run test:mutation:delta` over the last release tag, as AGENTS.md says) instead of the
  full mutation run; a surviving or uncovered mutant on a changed line is a finding unless the
  report says why it cannot change behavior. The architecture-and-test-quality sentence stays.

`prompts.test.ts` "the Review button and Create release run the same review" now asserts the
shared body plus exactly the one differing sentence.

## 6. Review due counter

`src/scheduler.ts` gains `lastFullReviewBase(tasks)`: the frozen base of the newest done,
non-cancelled review card with `releaseVersion === null` (same `Pick` shape as
`lastReviewBase`; a release card never moves it). `src/server.ts` `refreshArchReview` counts
the due badge from `lastFullReviewBase`. Every other `lastReviewBase` call site stays: the
arch-review route's commit context and the turn's `OTTR_ARCH_REVIEW` delta keep the
release-aware base, so late-commit detection and release notes do not change.

## 7. Idle auto-start

Global setting `idleReviews`, UI label "Run due reviews while idle", default on.

- `src/server.ts` `shared` gains `idleReviews: boolean` initialized `true`. `POST /api/settings`
  accepts `idleReviews`: a boolean, else `400 idleReviews must be a boolean`; it writes
  `shared`, returns it in the response body, and `saveConfig` persists it. Boot parse accepts a
  stored boolean, same pattern as `reviewCheck` (src/app.ts ~1330). The state payload exposes
  it for the UI.
- Input clock: `src/app.ts` keeps `lastInputAt` in memory. `api()` stamps it for every non-GET
  request that reaches a handler, after the walls. It initializes to `Date.now()` at
  `createApp`, so a board restart counts as input and never starts a review at once. The clock
  is injectable for tests (`now` in deps, default `Date.now`), used only by the idle logic.
- `idleReviewTick()` lives in app.ts and joins the returned app handles next to
  `alateProvisionTick`; `src/server.ts` runs it every 5 minutes like the alate tick. It files
  a card when all of these hold:
  1. `deps.shared.idleReviews` is on;
  2. `now - lastInputAt >= 2 hours`;
  3. `anyTurnActive()` is false (no preparing or running turn on any project);
  4. no auto-started review is live: the tick remembers the card id it filed last; while that
     task exists and is not done or cancelled, it files nothing new (in-memory only);
  5. the project shows Review due: entry `archReview.due` true and `archReview.running` false
     (cheap pre-filter from the refreshed entry), and
  6. `reviewBlocked(e.store.listTasks())` is null.
  The first project in map order that passes wins; none passes, the tick returns silently.
- Filing path: extract the body of `POST /api/projects/:project/arch-review` into a helper in
  app.ts shared by the route and the tick. The helper keeps the R1-8 ordering (git spawns
  before the guard; guard and `createTask` in one synchronous block), resolves the target,
  recomputes `archReviewDelta`, and for the tick only files when
  `archReviewDue(delta, cap, reviewed)` holds (`requireDue` option; the manual route files
  without that check, as today). Both call `deps.schedule()`.

## 8. Marker and Review button

Unchanged. `ARCH_REVIEW_MARKER` stays; the manual route behaves as today.

## 9. Docs

- `docs/ARCH-REVIEWS.md`: the "When a review starts" section gains the idle auto-start rule
  and its conditions; the gates item distinguishes release reviews (delta gate over the last
  release tag) from full reviews (full run); a short paragraph names the delta gate script.
- `README.md`: the settings table gains a row for "Run due reviews while idle" (default on)
  with a pointer to docs/ARCH-REVIEWS.md, matching the table's style.
- AGENTS.md is local-only: the work turn reports the new step-3 text and the new Review
  section text for the user to apply.

## Acceptance checks

1. Script test: a fixture git repo with a base commit and a change on known lines yields
   exactly those `file:start-end` entries per config; a change only in test files or docs
   yields no ranges and no Stryker spawn.
2. Real delta run (manual, temp fixture): a planted surviving mutant exits 1 and names file,
   line, mutator, replacement; after a killing test is added, it exits 0.
3. `lastFullReviewBase` test: a done release after a done full review does not move the base;
   a done full review does.
4. Supervisor tests: with the setting on, the review starts only when every condition in 7
   holds; it stays off at 1h59m of silence, with a running turn, with an open review, with
   another auto review live, after a restart, and with the setting off.
5. UI: rendered proof (screenshot) of the new Settings switch.
6. `bun run check` and `bun test` exit 0. The delta gate is measured on `v0.2.0..a6f601f` and
   the time goes in the turn report.

## Non-goals

No threshold changes (they stay on the full run). No changes to `mergeHold` or
`findingsHold`. No release-blockers-as-findings change (OTTR-365). No persistence of the
input clock. No new npm dependencies.
