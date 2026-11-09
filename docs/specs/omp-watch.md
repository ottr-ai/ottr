# omp watch: a changelog review gates each omp bump

Status: accepted (OTTR-672). Supersedes the push half of ADR 0005, see ADR 0010.

## Goal

An omp update must not break Ottr turns. The Ottr server watches npm for new omp releases.
A model reads the changelog of each release and looks for changes that touch the way Ottr
uses omp. Only the server moves the pin, and only to a release that passed the review.

## Decisions (from the user, OTTR-672)

- The check is a changelog review by a model. It runs in the Ottr server.
- On a failed review, the server holds the pin and files a card.
- The server owns the bump. On a pass, it files a "Bump omp to X" card. The merge turn of
  that card pushes the bump. `.github/workflows/omp-bump.yml` no longer pushes.
- The 7-day release age gate stays.
- A failed version blocks itself and every later version until its card is cleared. A card
  is cleared when its stage is `done` (finished or cancelled) or when the card no longer exists.

## Switch

- Project setting `ompWatch: boolean`, default `false` (`src/types.ts`, `DEFAULT_SETTINGS`,
  the settings validator map in `src/store.ts`). The settings table is key/value, so no schema
  change.
- `POST /api/projects/:project/settings` accepts `ompWatch`. A value that is not a boolean
  returns 400 `ompWatch must be a boolean`.
- The project settings form shows a check row "omp watch" next to "Issue watch".
- Turn it on only for the project that holds Ottr itself, the repo with `Dockerfile.worker`.

## Tick

`src/ompWatch.ts` exports `createOmpWatcher(deps)` with `tick(): Promise<void>`. The server
calls it at boot and every hour (`src/server.ts`, as the issue watcher). Ticks are single
flight: a tick that starts while one runs joins it. For each project with `ompWatch` on:

1. Read the pin: the line `ARG OMP_VERSION=<x.y.z>` in `<project root>/Dockerfile.worker`
   (the main checkout, which the merge turn keeps on the merge target). No file or no valid
   line: log one line and skip the project.
2. Read the npm packument `https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent`. Keep the
   versions in `time` that match `^\d+\.\d+\.\d+$` and are newer than the pin, in semver
   order. A fetch or parse failure: log and skip the project for this tick.
3. Review each version without a stored verdict, oldest first, at most 5 for each tick
   (`OMP_WATCH_GATES.reviewsPerTick`). A review starts on publish day, so a fail card has the
   7 days of the age gate to land.
4. Decide the bump target (below). File the bump card when it is due.
5. Save the state.

## Review of one version

- Notes source: the GitHub release `v<version>` of the repo that the packument names in
  `repository.url` (today `can1357/oh-my-pi`), through
  `GET https://api.github.com/repos/<repo>/releases/tags/v<version>`. The upstream is always
  public github.com, also when the board uses an enterprise host (`OTTR_GITHUB_HOST`). The
  request sends `GH_TOKEN` only when the board's host is github.com. An enterprise token never
  goes to github.com. The repo id must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
- No release (404) and the version is younger than one day: no verdict, retry on a later tick.
  No release and older than one day: verdict `fail` with the reason "omp published no release
  notes for <version>": a human must look.
- Other fetch errors: no verdict, log, retry on a later tick.
- The model call is tool free: `runGateway` (`src/forkAnalysis.ts`) on the `@default` role,
  90 s timeout. The system message is `OMP_REVIEW_INSTRUCTIONS` (`src/prompts.ts`). It lists the
  omp surface Ottr depends on. The user message holds the version and the release body, cleaned
  with `clean()` and fenced as a `<<<DATA` / `DATA>>>` block, with fence markers removed and the
  body cut at 30 000 characters.
- Reply contract: the first non-empty line is `PASS` or `FAIL`. For `FAIL`, the next lines are
  the reasons, one bullet each. Any other reply: no verdict, log, retry on a later tick. A
  reply is never taken as a pass by default.

## Fail card

- Filed in the watched project with `createTask(prompt, null, "work")`. Title
  `omp <version>: compatibility review failed`, topic `omp`. The card is queued (todo).
- Prompt (`ompFailCardPrompt` in `src/prompts.ts`): the version, the model's reasons, and the
  release notes as a DATA block. The agent checks each reason against Ottr's code, adapts Ottr
  where the release breaks it, and reports when no change is needed. Finishing or cancelling the
  card clears the hold.
- One card for each failed version. The card id is stored with the verdict.

## Bump target

Walk the reviewed versions above the pin in ascending order:

- Stop at the first version that has no verdict, or that failed and whose card is not cleared.
- A version is a candidate when it passed (or failed with a cleared card) and its npm publish
  time is 7 or more days old.
- The target is the highest candidate before the stop.

File the bump card when a target exists, no earlier bump card is still open (stage not `done`),
and the target is higher than the version of the last bump card. A cancelled bump card is never
filed again for the same version: only a higher target files a new one.

Bump card: `createTask(prompt, null, "work")`, title `Bump omp to <version>`, topic `omp`, queued.
Prompt (`ompBumpCardPrompt`): set `ARG OMP_VERSION=<version>` in `Dockerfile.worker`, change
nothing else, commit `chore: bump omp to <version>`. It names the reviewed versions it covers.
After a card is filed, the watcher calls `deps.schedule()`.

## State

Global store key `ompWatch:<project name>`:

```ts
type OmpWatchState = {
  verdicts: Record<string, { verdict: "pass" | "fail"; reasons: string[]; cardId: string | null; at: number }>;
  bumpCard: { id: string; version: string } | null;
  lastError: { reason: string; at: number } | null;
};
```

A missing or malformed value loads as the empty state. A malformed verdict entry is dropped,
so the version is reviewed again.

## CI

`.github/workflows/omp-bump.yml` becomes a check only. It runs on a push to `main` that
changes `Dockerfile.worker` and on manual dispatch. It starts the pinned omp on the image's
bun (`bun install -g` then `omp --version`). It holds no deploy key and pushes nothing.

## Error cases

- npm, GitHub or model failure: logged with the project name, stored as `lastError`, retried
  on the next tick. No verdict and no card from a failure.
- A pin that is newer than every reviewed version (a hand bump): versions at or below the pin
  are ignored.
- Two projects with `ompWatch` on: each has its own state and cards.

## Acceptance checks (tests in `src/ompWatch.test.ts`)

- A pass on a version that is 7 or more days old files one bump card. A second tick files no
  second card.
- A pass on a version younger than 7 days files no card.
- A fail files one fail card with the reasons. It holds the pin for that version and for a
  later passed version.
- After the fail card reaches `done`, the next tick files the bump card for the later version.
- A reply that is not `PASS`/`FAIL` stores no verdict, and the next tick reviews again.
- No release notes: younger than one day, no verdict. Older, a fail with the "no release notes" reason.
- At most 5 reviews in one tick.
- A cancelled bump card for X files no new card for X. A higher target files one.
- The release body cannot end its DATA block early (fence markers are removed).
- `ompWatch` off: no fetch, no card.

## Non-goals

- No real agent turn or test run against the new omp. The review reads only the changelog.
- No board banner. The cards are the signal.
- No change to how hosts deploy main (`scripts/update-image.ts`).
