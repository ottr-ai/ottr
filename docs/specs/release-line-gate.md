# Release line gate: wait for a release line to settle before taking it

Status: accepted (OTTR-909). The user decided every point below in a grill session on
2026-11-13.

## Goal

Every 7-day release age gate (G21) takes the newest version that is 7 or more days old.
When newer releases of the same line are still young, the gate takes an outdated version
that has known fixes. Example: v1.2.0 is 8 days old, v1.2.1 to v1.2.5 are younger than
7 days; the gate takes v1.2.0. Bun (`bunfig.toml` `minimumReleaseAge`, `Dockerfile.worker`
`--minimum-release-age`) and Dependabot (`.github/dependabot.yml` `cooldown`) apply one
age to each version and cannot express the rule. The board can.

## Decisions (from the user)

1. Settled-line rule (normative below).
2. A 14-day cap ends the wait and falls back to today's pick.
3. Only stable, published, non-deprecated releases count.
4. One pure function holds the rule. `bumpTarget` in `src/ompWatch.ts` uses it.
5. A script checks `bun.lock`. It runs in `bun run check` only when `bun.lock` differs
   from `origin/main`, and in CI for PRs. Without a lock change it makes no network call.
6. Unchanged: `minimumReleaseAge`, the Dependabot cooldown, GitHub Actions and the Docker
   base image. Dependabot still takes the newest version that is 7 days old for Actions
   and Docker.
7. This spec is the source of truth. No ADR.
8. `GLOSSARY.md` gains the terms "release age gate" and "release line".
9. No new dependency. `fetch` for the registry; `compareVersions` for version order.

## Rule (normative)

Input: the registry releases of one package, each `{ version, publishedAt, deprecated? }`;
`now`; `ageMs` (7 days in production); `capMs` (14 days in production).

A release **counts** when all hold:

- `version` matches `^\d+\.\d+\.\d+$` (stable; anything else is a prerelease and does not
  count),
- `deprecated` is not `true`,
- the registry still lists it (removed versions never enter the input).

A **release line** is all counted releases whose versions share the same major.minor.

A counted release is a **target** when:

- **age**: `now - publishedAt >= ageMs`, and
- **settled**: its line holds no counted release above it (greater by version order) that
  is younger than `ageMs`.

**Pick**: the newest target. When no target exists and the cap is not reached, the gate
keeps the current version (result `null`). The newest settled version of an older line can
still be the pick when the newest line is unsettled.

**Cap**: a line **waits** when it holds at least one aged counted release and at least one
counted release younger than `ageMs`. A line's **wait** is `now - publishedAt` of the
oldest aged counted release **at or above the line's candidate floor** (a counted release
of that line whose version is `>= floor`). With no aged counted release at or above the
floor the wait has not started and the cap is not reached. When any waited line's wait
exceeds `capMs`, the pick falls back to today's behavior: the newest counted release with
age `>= ageMs`, or `null` when none. `settledLineTarget` has no explicit floor: its input
is the candidate list itself (for `bumpTarget`, the releases above the pin).
`lineCapReached` floors at `version` (for the script, the installed version), so a line
that started long ago below the installed version never lifts the wait.

`maxVersion` (used by `bumpTarget` only, optional parameter): candidates are limited to
versions `<= maxVersion`; the settled check and the cap still read the whole input.

### Module contract: `src/releaseLine.ts`

```ts
export type RegistryRelease = {
	version: string; // registry version string; stable is exactly x.y.z
	publishedAt: number; // publish time, ms epoch
	deprecated?: boolean;
};

/** Numeric x.y.z order; both sides must be stable x.y.z. Moved here from src/ompWatch.ts. */
export function compareVersions(a: string, b: string): number;

/** The rule above; result is the pick's version string or null (keep the current). */
export function settledLineTarget(
	releases: RegistryRelease[],
	now: number,
	ageMs: number,
	capMs: number,
	maxVersion?: string,
): string | null;

/** The newest counted release above `version` in its line that is younger than ageMs,
 * or null when the line is settled above `version`. The script's report names it. */
export function unsettledBlocker(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
): RegistryRelease | null;

/** True when `version`'s line's wait exceeds capMs, measured from the oldest aged counted
 * release at or above `version` in that line (the cap definition above; `version` is the
 * candidate floor, for the script the installed version). */
export function lineCapReached(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): boolean;
```

`src/releaseLine.ts` imports nothing from `src/ompWatch.ts` (the script must not pull the
watcher's dependency chain). `src/ompWatch.ts` re-exports `compareVersions` from it so
existing imports keep working.

## omp watch integration (`src/ompWatch.ts`)

- `OMP_WATCH_GATES` gains `capDays: 14`.
- `bumpTarget` keeps its verdict walk unchanged (stop at the first version without a
  verdict or with a fail whose card is not cleared). It calls `settledLineTarget` once
  with the full release list and `maxVersion` set to the highest walked version, so a
  pick above the walk (an unreviewed release, or one held by an open fail card) can
  never bless a walked release below it; the target is the highest walked release that
  is aged, not deprecated, and `<= pick` (a deprecated release never counts, so it is
  never the target). No pick, no target.
- `parsePackument` keeps `time` entries only for versions the packument still lists in its
  `versions` map (removed versions drop out) and carries `deprecated: typeof
  versions[v]?.deprecated === "string"` on each release. The `OmpRelease` type gains
  `deprecated?: boolean`.
- `docs/specs/omp-watch.md` "Bump target" section references this spec instead of stating
  the old age-only rule.

## Script: `scripts/check-release-lines.ts`

Trigger, in order:

1. `git rev-parse --verify origin/main` must succeed; a failure exits 1 with
   `release line check: cannot resolve origin/main; run git fetch origin`.
2. `git diff --quiet origin/main -- bun.lock`: exit 0 means unchanged — exit 0, no output,
   no network call. Exit 1 means changed — scan. Any other exit is an error, exit 1.

Scan:

- Parse the `packages` map of the worktree `./bun.lock` and of
  `git show origin/main:bun.lock` (a base without the file means an empty base map).
  An entry is a registry package when its first tuple element matches
  `^(.+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$`; everything else (`workspace:`, `link:`,
  `git:`, `file:`, tarballs) is skipped. Entries are keyed by their `packages` map key,
  never by the resolved package name: a nested lock key like `d3-dsv/commander` can
  resolve a package named `commander` beside the top-level `commander`, and the two
  must not collapse into one slot. Changed = a key that is added, or whose resolved
  name or version differs; identical changed `(name, version)` pairs scan once.
- Direct dependency = the name is a key of `dependencies`, `devDependencies` or
  `optionalDependencies` in `./package.json`. Everything else is transitive.
- Skip changed packages whose installed version is not stable.
- For each remaining package, ascending by name: `GET {registry}/{name}` with `/` encoded
  as `%2F` and `@` kept (the `OMP_PACKAGE_URL` style), header `user-agent: ottr`,
  `AbortSignal.timeout(20000)`. Registry base comes from env `OTTR_NPM_REGISTRY`
  (default `https://registry.npmjs.org`); only tests set it. The response is a packument:
  releases are its `time` entries for versions present in its `versions` map, with
  `deprecated` as above. A missing time map, a non-OK status, a network error or a broken
  body is a registry error.
- Registry error: print `release line check failed: <pkg>: <message>` and exit 1
  immediately. The script never passes without data.
- `unsettledBlocker` finds the blocker; `lineCapReached` lifts it. Blocker and no cap:
  - direct: collect the failure line
    `release line not settled: <pkg> <version>, <newer> is <n> days old`
    (`<n>` = whole days, floored); after the loop print each and exit 1.
  - transitive: print the warning line
    `warning: release line not settled: <pkg> <version>, <newer> is <n> days old (transitive)`
    and keep going; the exit stays 0.

## Wiring

- `package.json` `check`: insert `bun scripts/check-release-lines.ts` after
  `bun scripts/agent-data-sync.ts`.
- `.github/workflows/ci.yml` check job: the checkout step gains `fetch-depth: 0` with a
  comment (a PR build needs `origin/main` for the trigger; a push build diffs empty and
  the script no-ops without network).

## Error cases and boundaries

- `origin/main` missing: exit 1 with the resolve message (never silently pass).
- Installed prerelease: skipped, no output.
- Non-registry lock entries: skipped.
- Registry outage: the check fails (by decision). Re-run `bun run check` later.
- `bun.lock` `lockfileVersion` other than the entry shape pinned here: the parser must be
  revisited before trusting the result.

## Acceptance checks

Function (`src/releaseLine.test.ts`, fixed registry data; each fails before the change):

1. v1.2.0 aged 8 days plus v1.2.5 aged 2 days: no target in 1.2.x (null).
2. v1.2.0 aged 30 days plus v1.2.5 aged exactly 7 days: target v1.2.5.
3. The cap: v1.2.0 aged 15 days plus v1.2.5 aged 2 days: target v1.2.0; at exactly 14
   days the cap is not reached (null).
4. A younger prerelease does not block: v1.2.5 aged 7 days plus v1.2.6-beta.1 aged 1 day:
   target v1.2.5.
5. An older settled line is still a target: v1.1.9 aged 30 days, v1.2.0 aged 8 days,
   v1.2.5 aged 2 days: target v1.1.9.
6. A deprecated release does not count: v1.2.5 aged 2 days and deprecated does not stop
   v1.2.0 aged 8 days.
7. A property test: for arbitrary inputs the result is always a counted, aged release or
   null, and with `capMs` infinite the result is never a blocked release.

`bumpTarget` (`src/ompWatch.test.ts`):

8. v1.2.0 aged 8 days and v1.2.5 aged 2 days, both passed: `bumpTarget` returns null
   (today it returns v1.2.0).
9. Same with v1.2.0 aged 15 days: returns v1.2.0 (cap).
10. v1.1.9 aged 30 days, v1.2.0 aged 8 days, v1.2.5 aged 2 days, all passed: returns
    v1.1.9.

Script (`scripts/check-release-lines.test.ts`, live spawn against a scratch git repo and a
local registry listener, fixture lock derived from the real `bun.lock`):

11. Unsettled direct dependency: exit 1 with the exact failure line.
12. Unsettled transitive package: exit 0 with the exact warning line.
13. Registry error (listener answers 500): exit 1 with the error line.
14. No lock change: exit 0 and the listener request count stays 0 (registry base seeded to
    `http://localhost.:<port>`).
15. The request test asserts method `GET` and the exact encoded path, not a substring.
16. A deprecated walked release is never the target: v1.2.0 aged 10 days passed, v1.2.1
    aged 9 days passed and deprecated, v1.2.2 aged 8 days unreviewed: the target is
    v1.2.0.
17. A changed nested lock key scans even when a top-level key of the same package name
    is unchanged: the fixture derives the real bun.lock's `d3-dsv/commander` nested
    entry beside a top-level `commander`; changing only the nested entry's version
    produces the registry call and the report for that nested version.
18. A pick above the walk does not bless a walked release: v1.2.0 aged 8 days passed,
    v1.2.5 aged 2 days passed, v1.3.0 aged 8 days unreviewed: the target is null (the
    walk holds 1.2.0 and 1.2.5, the pick is 1.3.0, and 1.2.0's line is unsettled). The
    same fixture with v1.3.0 failed under an open fail card returns null too.
19. The cap wait counts from the oldest aged counted release at or above the installed
    version: a line holding x.y.0 aged 2 years, x.y.20 aged 10 days (installed) and
    x.y.21 aged 2 days reports the unsettled release; `lineCapReached` is false at the
    installed version and true at x.y.0.

Gates: `bun run check` and `bun test` exit 0.

## Non-goals

- G21 and the other projects (later, after this works).
- GitHub Actions, Docker base image, Dependabot behavior, the 7-day age.
- No new dependency; no ADR.

## Alternatives considered

- `Bun.semver` for ordering: rejected; the repo already has the numeric
  `compareVersions`, and semver ordering alone gives no line logic.
- Teaching Bun or Dependabot the rule: rejected; their configs cannot express it
  (decision 6 records the cooldown stays).
- A per-package threshold configuration: rejected; one rule with fixed 7 and 14 days.

## Risks

- Registry outage fails the check by decision. Mitigation: the error names the package;
  re-running `bun run check` retries.
- npm changes the lockfile entry shape or the packument envelope: the parser skips what
  it cannot read, so a silent under-check is possible; the fixture tests pin today's
  shape and the spec names the revisit trigger.
- The cap can take an unsettled-line version after 14 days of waiting; that is the
  decided tradeoff against waiting forever.
