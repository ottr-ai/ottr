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

A counted release is **accepted** when it meets the age and settled conditions, or when
the cap lifted the wait for its line (the cap paragraph below). Acceptance is evaluated
per release against the full release list, never derived from another release's
acceptance: no version-order relation between two releases implies that one inherits the
other's acceptance.

**Pick**: the newest accepted counted release. When none exists and the cap is not
reached, the gate keeps the current version (result `null`). The newest settled release
of an older line can still be the pick when the newest line is unsettled.

**Cap**: a line **waits** when it holds at least one aged counted release and at least one
counted release younger than `ageMs`. A line's **wait** is `now - publishedAt` of the
oldest aged counted release **at or above the line's candidate floor** (a counted release
of that line whose version is `>= floor`). With no aged counted release at or above the
floor the wait has not started and the cap is not reached. When any waited line's wait
exceeds `capMs`, the pick falls back to today's behavior: the newest counted release with
age `>= ageMs`, or `null` when none. The wait's candidate floor is caller-relative:
`bumpTarget`'s per-release check and `settledLineTarget` count the wait line-wide over
their input (their input is the candidate list itself, the releases above the pin);
`lineCapReached` floors at `version` (for the script, the installed version), so a line
that started long ago below the installed version never lifts the wait. A cap reached on
a line above the bump walk never lifts the wait of a walked line below it: acceptance is
per release, so only the candidate's own line can lift the candidate's own block.

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
): string | null;

/** True when `version` is accepted: counted, aged, its line is settled above it, or the
 * wait for its line (line-wide over `releases`, the candidate list) exceeds capMs. */
export function releaseLineAccepts(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): boolean;

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

/** The earliest epoch ms at which the gate passes for `version`, or null when it is not
 * blocked now: the earlier of the line's settle time and its cap time (OTTR-960). */
export function releaseLineWaitUntil(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): number | null;

/** The stdout marker line the bun.lock check prints when a direct package is blocked
 * (OTTR-960): the script's machine-readable report, after its human failure lines.
 * The board does not parse it; the board computes the same entries from the lock
 * data (OTTR-972). */
export const RELEASE_LINE_MARKER: string;
```

`src/releaseLine.ts` imports nothing from `src/ompWatch.ts` (the script must not pull the
watcher's dependency chain). `src/ompWatch.ts` re-exports `compareVersions` from it so
existing imports keep working.

## omp watch integration (`src/ompWatch.ts`)

- `OMP_WATCH_GATES` gains `capDays: 14`.
- `bumpTarget` keeps its verdict walk unchanged (stop at the first version without a
  verdict or with a fail whose card is not cleared). The target is the highest walked
  release that is counted (not deprecated), aged, and
  `releaseLineAccepts(releases, r.version, now, ageMs, capMs)`: acceptance is evaluated
  for each walked release against the full release list, so no release above the walk —
  settled or cap-lifted — can bless a walked release below it. No walked accepted
  release, no target. One exception outside this rule: a passed release that adds model
  access fast-tracks before the age rules (docs/specs/omp-watch.md, OTTR-1287).
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
- Reads stay bounded (OTTR-1194): the worktree is worker-writable, so the script reads
  `./bun.lock` and `./package.json` through `readRegular` at `LOCK_MAX_BYTES` (4 MiB).
  A bigger file fails the read and the script exits 1 with that refusal.
- Skip changed packages whose installed version is not stable.
- For each remaining package, ascending by name: `GET {registry}/{name}` with `/` encoded
  as `%2F` and `@` kept (the `OMP_PACKAGE_URL` style), header `user-agent: ottr`,
  `AbortSignal.timeout(20000)`. Registry base comes from env `OTTR_NPM_REGISTRY`
  (default `https://registry.npmjs.org`); only tests set it. The body has no byte cap:
  real packuments legitimately reach tens of MiB (measured 2026-11-22: typescript
  15.2 MiB with 3892 versions, vite 37.2 MiB), so the body is parsed as a stream
  (`streamPackument`) and only the versions keys, their `deprecated` string flags, and
  the `time` map stay in memory; a list of more than `MAX_PACKUMENT_VERSIONS`
  (20 000, five times the measured maximum) versions is a registry error, and so are a
  truncated stream and a body nested past 64 levels. The packument's releases are its
  `time` entries for versions present in its `versions` map, with `deprecated` as
  above. A missing time map, a non-OK status, a network error or a broken body is a
  registry error.
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
- Board bounds (OTTR-1194), each fail closed to null: an over-cap worktree file or base
  blob (4 MiB), a packument listing more than 20 000 versions, a truncated or
  over-nested packument stream, a changed set over 500 packages, a scan past its 60 s
  deadline. Each keeps the park.
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
20. A cap reached by a line above the walk does not lift a walked line's wait: v1.2.0
    aged 8 days passed, v1.2.5 aged 2 days passed, v1.3.0 aged 20 days failed under an
    open fail card, v1.3.1 aged 2 days: the target is null (line 1.2 waited 8 days; the
    cap on line 1.3 is above the walk and cannot bless v1.2.0).

## Board auto-hold for Dependabot cards (OTTR-960, changed by OTTR-972)

A Dependabot card parks needs_you when its gates fail. When the card's dependency bump
is release-line blocked, the park has no human cause: the board arms a timer and starts
the turn again when the line settles.

### Marker: the script's machine-readable report

`scan()` collects, for every failed direct package, one entry
`{ name, version, waitUntilMs }`. After the human failure lines it prints exactly one
line to stdout:

```
release line blocked: {"blocked":[{"name":"@biomejs/biome","version":"2.6.7","waitUntilMs":1763485440000}]}
```

Transitive warnings never enter: they never fail the check. `waitUntilMs` is the earliest
epoch ms at which the gate passes for that package: the earlier of

- **settle**: the newest young counted release above the installed version turns `ageMs`
  old (`max(publishedAt of young counted releases above) + ageMs`), and
- **cap**: the oldest aged counted release at or above the installed version plus
  `capMs`.

New pure function `releaseLineWaitUntil(releases, version, now, ageMs, capMs)` in
`src/releaseLine.ts`; null when `version` is not blocked now.

### The board's hold (`src/turn.ts`, `src/releaseLineScan.ts`)

OTTR-972: the board no longer runs the card's gates for the hold. A gate run executes
the worktree's own scripts (`bun run check`, `bun run test`) inside the board process
with the server environment. A Dependabot worktree holds work-turn-controlled code, so
that run let a steered turn reach the worker token, the Alate key, provider keys, and
GH_TOKEN (run-8, severity high). The board now reads data only: it spawns no worktree
script for the hold.

At a settle whose classified outcome is needs_you with no ask, on a card with
`sourcePrDependabot true`, turn kind work or merge, and no interview, grill, scout,
review, or release identity, the board derives the block from the card's worktree
(`worktreesDir/<id>`; a missing worktree keeps the park). The derivation goes through a
new optional ops seam `releaseLineBlocked`, whose default (`src/releaseLineScan.ts`)
does:

1. Read `<worktree>/bun.lock` and `<worktree>/package.json` through the bounded readers
   (`readBoundedFile`, OTTR-1194) at `LOCK_MAX_BYTES` (4 MiB). A missing, unreadable,
   symlinked, or over-cap file keeps the park (fail closed).
2. Read the base lock with `git rev-parse --verify origin/main`, then
   `git ls-tree origin/main -- bun.lock` for the file's presence, then
   `git cat-file blob origin/main:bun.lock`, all in the worktree. No origin/main
   keeps the park. Git trouble keeps the park. No bun.lock on origin/main means an
   empty base map. `git cat-file blob` runs no textconv, filter, or hook, so no
   worktree-controlled code runs. A base blob over `LOCK_MAX_BYTES` keeps the park.
3. Compute the changed set like the script: registry entries keyed by their `packages`
   map key; changed when the key is added, or when its resolved name or version
   differs; stable versions only; ascending by name; identical pairs scan once. A
   changed set over `MAX_CHANGED_PACKAGES` (500) stops the scan: fail closed, park
   stays.
4. For each changed package whose name is direct, fetch the packument from the registry
   (the shared `fetchReleases`; the board makes network calls, never script calls). The
   body is parsed as a stream (`streamPackument`) with no byte cap: only the versions
   keys, their `deprecated` string flags, and the `time` map stay in memory, and a list
   of more than `MAX_PACKUMENT_VERSIONS` (20 000) versions, a truncated stream, or a
   body nested past 64 levels fails the fetch. The whole scan holds a deadline of
   `SCAN_MS` (60 s): when it passes,
   the scan stops before the next fetch. A registry error, a refused packument, or a
   passed deadline keeps the park (fail closed).
5. A direct package whose line is unsettled and not cap-lifted gives one entry
   `{ name, version, waitUntilMs }` (`releaseLineWaitUntil`).

`scanReleaseLines` in the same module holds steps 3 to 5 as one shared core. The script
and the board both call it, so their verdicts match.

**Attribution.** The changed set mirrors the gate's own scan exactly: a direct changed
package with an unsettled line is a package the card's release-line step fails on. The
board proves the gate's data verdict, not the whole check run: the state of the other
gates stays unknown to the hold. A park the board can attribute to another cause keeps
the park without the read: the project's push state is broken (`mainUnpushed`, the
AGENTS.md step-1 failure). An ask-tool question keeps the park. The agent's own park
reason stays on the card, appended after the hold text, so a park whose cause the hold
cannot verify is never lost — a reply runs the card at once.

**Arm.** When the derivation returns at least one entry, the park becomes
`state queued` at the unchanged stage with:

- `holdUntil` = the latest `waitUntilMs` (it must be in the future),
- `holdProvider` null: the quota refresh never releases the hold, because
  `releaseUsageHolds` skips null-provider holds,
- `holdAttempts` unchanged (not a usage hold), `holdSetAt` = the settle time,
- `needsReason` naming the packages and the UTC time,
- `pendingPrompt` = the resume line, authored by the supervisor.

At `holdUntil` the scheduler picks the card and its turn runs again. A user message
still runs the card now: the existing reply and requeue paths write `holdUntil null`.

### Acceptance checks

21. `releaseLineWaitUntil`: unchanged; the pure module tests keep covering it.
22. Script: the unsettled direct dependency fixture still exits 1 with the human line
    and the exact marker line naming the package, version, and the computed
    `waitUntilMs` (`scripts/check-release-lines.test.ts` runs the refactored script
    unchanged).
23. Fake clock (seam stub): a Dependabot card whose derived entries carry clear times
    T1 < T2 parks `state queued` with `holdUntil T2`; `pickRunnable` at `now = T2`
    picks the card, at `T2 - 1` it does not. The card's reason names the packages, the
    time, and the park reason it replaces.
24. Keep-park cases, each with the seam stub: an empty derived set, a null derivation
    (every fail-closed shape), a clear time already passed, a card with a broken push
    state (`mainUnpushed`), and a non-Dependabot card.
25. `releaseUsageHolds` leaves the armed hold (null provider) armed across a quota
    refresh that saw the provider blocked and then free.
26. Live reader (OTTR-972): a fixture worktree with a real git `origin/main`, a
    `bun.lock` derived from this repo's real lock, and a `package.json` whose `check`
    script writes its environment into a canary file; sentinel values for
    `OTTR_WORKER_TOKEN`, `ALATE_API_KEY`, and `GH_TOKEN` sit in the board env; a local
    registry listener answers the packument. The hold arms with the fixture's clear
    time; the listener saw method `GET` and the exact encoded path `/<name>` with `/`
    as `%2F`, not a substring; the canary file does not exist: no server-side spawn
    happened.

Bounds (OTTR-1194, `src/releaseLineScan.test.ts`; each fails on the unbounded tree or
on the first cut's byte-capped tree):

27. The streaming selector agrees with `JSON.parse` on verbatim real registry entries
    (typescript 2.0.3, uuid 0.0.1 with its real deprecated marker) and on 150 seeded
    random packuments served in 7-byte chunks, so tokens and multibyte characters
    straddle chunk boundaries; a truncated stream, a body nested past 64 levels, and a
    packument over the version cap each refuse with the cap named.
28. A valid 5 MiB worktree `bun.lock` whose lines are settled: `releaseLineBlocked`
    returns null (the unbounded tree returned `[]`), and the listener saw no request.
29. A valid 5 MiB base blob: null (the unbounded tree blocked on the young diff).
30. A multi-MB packument of real manifest shapes (about 3 MB, 1202 versions, served in
    97-byte chunks) for a young changed package: the hold arms with the exact clear
    time (the first cut's 64 KiB cap returned null). `fetchReleases` on the same body
    returns all 1202 releases with the deprecated flags.
31. A packument listing 20 001 versions: null with the listener request count at one
    (the fetch refused). A changed set of 501 entries: null with the request count at
    0 (the cap stops the scan before the first fetch). `scanReleaseLines` with
    `maxChangedPackages 2` and a passed `deadlineMs` fail with name `bun.lock` before
    any fetch, and a slow fetch stops part-way at the deadline.

Gates: `bun run check` and `bun test` exit 0.

## Non-goals

- G21 and the other projects (later, after this works).
- GitHub Actions, Docker base image, Dependabot behavior, the 7-day age.
- No new dependency; no ADR.
- The gate's rule, the Dependabot config, and non-Dependabot cards stay unchanged
  (OTTR-960). The hold reads lock data only; no gate runs on the board for the hold
  (OTTR-972).

## Alternatives considered

- `Bun.semver` for ordering: rejected; the repo already has the numeric
  `compareVersions`, and semver ordering alone gives no line logic.
- Teaching Bun or Dependabot the rule: rejected; their configs cannot express it
  (decision 6 records the cooldown stays).
- A per-package threshold configuration: rejected; one rule with fixed 7 and 14 days.
- Parsing the agent's park reason for the wait: rejected; agent text can quote any
  marker, so the board reads only data it derived itself.
- Running the probe as the card's gate scripts in the board process (OTTR-960 as
  shipped): replaced by OTTR-972; the probe executed work-turn-controlled worktree code
  with the server environment (run-8, severity high).
- Dispatching the probe through a worker: rejected for this fix; it keeps script
  execution for the hold and adds a worker round-trip to the settle path.
- Stripping the env at the spawn (`childEnv` + `stripGitAuthEnv`): rejected; worktree
  scripts would still run as the board, only with fewer secrets.
- Proving the whole check run (only the release-line step red, the test gate green):
  dropped with the probe (OTTR-972); the board knows the gate's data verdict, and the
  park reason stays on the card for every other cause.

## Risks

- Registry outage fails the check by decision. Mitigation: the error names the package;
  re-running `bun run check` retries.
- The board-side hold reads the worktree's lock files as untrusted input and makes
  registry GETs; it runs no worktree code. A crafted lock can only shape which packages
  the board asks the registry about; the registry answers with its own data, and the
  rule functions bound the result.
- A park whose cause is not the gate still arms the hold when the bump is
  release-line blocked; the turn resumes at the clear time and parks again. Mitigation:
  the hold text keeps the park reason on the card, and a reply runs the card at once.
- A registry error keeps the park (fail closed), so a Dependabot card behind a registry
  outage waits for a person instead of a timer.
- npm changes the lockfile entry shape or the packument envelope: the parser skips what
  it cannot read, so a silent under-check is possible; the fixture tests pin today's
  shape and the spec names the revisit trigger.
- The cap can take an unsettled-line version after 14 days of waiting; that is the
  decided tradeoff against waiting forever.
- A registry answer can be hostile but the board's exposure stays bounded
  (OTTR-1194): the packument body streams, so memory holds only the selected fields
  (at most 20 000 versions), the request timeout bounds the download, and the 60 s
  scan deadline bounds the whole hold derivation. A hostile or broken answer fails
  closed and keeps the park.
- The 20 000-version retention cap is 5 times the measured real maximum (typescript,
  3892 versions on 2026-11-22). A real package beyond it would fail the board's fetch
  and keep the park, and the work-turn gate would report the refusal; raise
  `MAX_PACKUMENT_VERSIONS` when the registry's real maximum grows near it.
