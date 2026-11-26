# Stryker area configs

Status: draft (OTTR-1275). Supersedes the single base mutate set of `stryker.config.mjs`
as the thing `bun run test:mutation` runs. The four module configs (release, turn,
worktree, update-image) keep their role and their mutate sets.

## Goal

A full mutation run gets restartable progress and small, tracked caches. The base
config's mutants are split into area configs of at most about 10,000 mutants each.
Every source file is mutated by exactly one area config. The incremental caches are
tracked in git, so a fresh card worktree starts warm. No cache is committed by this
card: the operator runs the full suite once after the merge and commits the generated
`reports/stryker-incremental-<area>.json` files.

## Universe and ownership

The universe is the base mutate list of `stryker.config.mjs` (`src/**/*.ts`,
`src/ui/sw.js`, `extension/**/*.ts`, minus `**/*.test.ts` and minus the seven excluded
files `src/app.ts`, `src/turn.ts`, `src/worktree.ts`, `src/server.ts`,
`src/prompts.ts`, `src/release.ts`, `src/vmValidateSmoke.ts`). Every universe file
belongs to exactly one area config. No area config owns a file outside the universe
(test files, the seven excluded files). Pattern matching uses the Stryker rule
(ordered match, `!` excludes, last match wins), the `owns` helper of
`scripts/mutation-delta.ts`. The four module configs and the base config stay outside
the partition: the base config keeps the universe as its reference set and is no
longer run by `bun run test:mutation`.

Each area config exports `areaName` (unique string) so tooling can tell area configs
from module configs without a name list.

## Area list

Estimates are line-count ratios (0.845 mutants per line, from 52,858 mutants over
62,566 mutated lines at the 2026-10-31 measurement). Measured counts are recorded
below after the dry runs.

| Area | Mutate patterns (positive) | Est. mutants |
| --- | --- | --- |
| store | `src/store*.ts`, `src/globalStore.ts`, `src/postgres*.ts`, `src/sqliteDriver.ts`, `src/dblock.ts`, `src/sealedConfig.ts`, `src/test/postgres*.ts` | ~6,500 |
| supervisor | `src/supervisor.ts`, `src/scheduler.ts`, `src/runner.ts` | ~6,300 |
| workers | `src/workers.ts`, `src/turnUid.ts`, `src/turnGithubToken.ts`, `src/confine.ts`, `src/session.ts`, `src/layers.ts`, `src/layerLeaseLock.ts`, `src/worker.ts`, `src/childEnv.ts`, `src/runTokens.ts` | ~4,000 |
| vm | `src/vm*.ts` minus `src/vmValidateSmoke.ts` | ~4,900 |
| git | `src/git*.ts`, `src/github*.ts`, `src/prs.ts`, `src/prInline.ts`, `src/forks.ts`, `src/forkAnalysis.ts`, `src/dependabot.ts`, `src/branchRules.ts`, `src/deepen.ts`, `src/issues.ts`, `src/test/boardRepoGuard.ts` | ~7,200 |
| ui | `src/ui/**`, `src/ui/sw.js` | ~2,500 |
| integrations | `src/jira*.ts`, `src/llm*.ts`, `src/alate.ts`, `src/updates.ts`, `src/webpush.ts`, `src/notifications.ts`, `src/hosted.ts`, `src/pluginSkills.ts`, `src/serviceQuota*.ts`, `src/quota.ts`, `src/topics.ts`, `src/trustedLists.ts`, `src/auditLeads.ts`, `src/repoHomepage.ts` | ~5,000 |
| insights | `src/trending.ts`, `src/retro.ts`, `src/omp*.ts`, `src/codeScanWatch.ts`, `src/duplicateGate.ts`, `src/updateCycle.ts`, `src/orphans.ts`, `src/tmpsweep.ts`, `src/systemStats.ts`, `src/systemSampleLog.ts`, `src/perf*.ts`, `src/stryker.ts` | ~5,300 |
| ops | `src/releaseLine*.ts`, `src/releaseSummary.ts`, `src/backup.ts`, `src/boardBundle.ts`, `src/images.ts`, `src/provision.ts`, `src/python.ts`, `src/apt.ts`, `src/sandboxRun.ts`, `src/platform/**`, `src/dev.ts`, `src/restore.ts`, `src/memory.ts`, `src/vendor.ts`, `src/errmsg.ts`, `src/levels.ts`, `src/progress.ts`, `src/crash.ts`, `src/prefix.ts`, `src/singleFlight.ts`, `src/projectOrder.ts`, `src/test/sshKeygenStub.ts`, `src/test/suiteEnv.ts` | ~5,000 |
| rest | `src/**/*.ts`, `extension/**/*.ts`, minus every pattern above (explicit negations), minus tests and the seven excluded files | ~4,900 |

Every area config negates `**/*.test.ts` and the seven excluded files. The rest
config is the catch-all: a new file that no area claims lands there, and the
exactly-once check fails if two configs claim one file.

## Exactly-once check

`bun scripts/stryker-areas.ts`, wired into `bun run check`. It walks `src/` and
`extension/`, expands the base mutate list into the universe, and fails (exit 1,
listing each path) when: a universe file is owned by no area config or by more than
one; an area config owns a file outside the universe; an area config owns no file;
two area configs export the same `areaName`. Tests (`scripts/stryker-areas.test.ts`)
cover the findings function with fixtures: a file in two configs, a file in no
config, an empty area, and a pass case; plus one test over the real configs and the
real tree.

## Run sequence

`bun run test:mutation` runs all fourteen configs in sequence: the ten area configs
(store, supervisor, workers, vm, git, ui, integrations, insights, ops, rest), then
release, turn, worktree, update-image. The delta gate needs no change:
`loadConfigs` discovers every `stryker*.config.mjs`, and a changed file is owned by
exactly one area config (or by its module config for the four overlay files), so
`configsFor` routes each range to one run.

## Thresholds

Each area config starts at `break: 76` — the base config's measured score (76.48%,
2026-10-31 at 16b3326, recorded in `scripts/stryker-base.mjs`) rounded down — and
keeps the base `high: 80`, `low: 60`. The user approved this floor for all ten areas
on 2026-11-26 (OTTR-1275 work-check blockers 2-11): no threshold drops below the
base's measured break, and no area has a measured score yet. The basis lives in
`THRESHOLD_BASIS` (`scripts/stryker-areas.ts`), and the area-threshold test pins each
config's break to its recorded basis.

The full run after the merge queue drains measures each area and sets its own break:
the measured score rounded down, at most 90 (AGENTS.md). That run replaces the
area's `THRESHOLD_BASIS` entry with `{ kind: "measured", score }` and raises the
config's break to match.

Measurement attempt, recorded for the next try: on 2026-11-25 and 2026-11-26 the
container sat at about 96 percent of its 12 GiB cgroup (71 MiB free), so Stryker's
memory rule forced 1 slot and the dry run passed its 20-minute budget. Forcing
concurrency past the memory rule was rejected: the rule protects the shared worker
from OOM kills. Measure on a host with cgroup headroom.

The split keeps the overall mutate set identical to the old base set, so the overall
measured score carries over.

## Concurrency and budgets

Every area config uses the base cap (24) and the base budget (`timeoutMS: 10000`,
`timeoutFactor: 2`, bun timeout 1.2M s). The git-heavy tests of the module configs
kept isolated configs for budget reasons; the git area's own tests (prs, forks,
gitHttp) passed inside the base budget in the completed 2026-10-31 runs. If the git
area's first real run mass-times-out, it gets the module-config budget
(`timeoutMS: 120000`, `timeoutFactor: 3`, cap 8) — a follow-up change, not a
spec change.

## Caches

The `.gitignore` line `stryker-incremental-*.json` is removed. Cache files
(`reports/stryker-incremental-<config>.json`, about 1.45 KB per mutant, so about
7 MB per area) become tracked after the operator's first full run commits them.

## Acceptance

- The exactly-once check fails for a fixture with a file in two configs and a file
  in no config, and passes on the split tree (`bun run check`, `bun test` green).
- A dry run per new config reports at most about 10,000 mutants; this spec records
  each measured count.
- The union of the new configs' mutants equals the old base config's set: the same
  file set (the exactly-once check) and the same total mutant count from Stryker
  dry runs of the ten areas and the base config.
- No `bun run test:mutation` run in the work turn.

## Non-goals

No move of `src/` files into area directories (a later card). No change to the four
module configs' mutate sets. No new npm dependency. No Git LFS. No change to
`scripts/stryker-load.mjs` lock or sizing logic.

## Measured counts (Stryker dry run, 2026-11-25)

Each count is the `Instrumented N source file(s) with M mutant(s)` line of a
`--dryRunOnly` run of the area's own config (test files replaced by a one-test
stand-in file for speed; the instrumenter input is the mutate list, so the count is
identical — the store config also ran a full dry run and reported the same 4,916).
The ten counts sum to 53,667, the base config's own dry-run count: the union of the
area mutants equals the old base set. Every area is below the 10,000 cap.

| Area | Files | Mutants |
| --- | --- | --- |
| store | 11 | 4,916 |
| supervisor | 3 | 6,660 |
| workers | 10 | 3,642 |
| vm | 11 | 4,772 |
| git | 18 | 8,330 |
| ui | 19 | 3,109 |
| integrations | 21 | 6,341 |
| insights | 16 | 5,966 |
| ops | 26 | 4,515 |
| rest | 17 | 5,416 |
| base (reference) | 152 | 53,667 |

