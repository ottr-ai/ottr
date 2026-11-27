# omp watch: a changelog review gates each omp bump

Status: accepted (OTTR-672). Supersedes the push half of ADR 0005, see ADR 0010.
Superseded-pending: `docs/specs/omp-channel.md` (ADR 0016, proposed) replaces this
spec; this file describes the shipped watch until that spec's build cards land.

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
- A release that adds model access files its bump card at once, at priority P1 (OTTR-1287;
  the user approved this second exception to the 7-day rule on 2026-11-25).
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

## Model sets and the model fast track (OTTR-1287)

The 7-day release age gate is the general rule. The global dependency rule knows one
exception: a security fix. The user approved a second exception on 2026-11-25 (OTTR-1287):
a release that adds model access files its bump card at once, at priority P1. Motivation:
omp 19.1.1 (2026-11-23) added gpt-6.2-sol and gpt-6.2-astra for openai-codex, and the age
gate would have held the board's access to them until 2026-11-30. The operator filed the
bump card by hand (OTTR-1286). A static search of the package text finds no model ids, so
the model set comes from running omp itself. On 2026-11-27 the user decided the probe may
run only inside the VM isolation the vm-runner provides (below): a same-UID run on the
server host is not an acceptable boundary for unapproved code.

### The model set of one version

- The user decided on 2026-11-27 (OTTR-1287 security review): the candidate is unapproved
  code, so it never executes on the server host. The probe runs only through
  `deps.probeTransport`, and production wires the vm-runner's validation channel
  (docs/specs/microvm-validation-mode.md): a fresh microVM holds none of the board's
  mounts, the job env is exactly PATH, HOME and LANG, the job runs as an unprivileged
  guest user, and the result drive is written by the guest's init after the job exits.
  The candidate is unapproved code, so its install tree never exists on the server
  either. The server's share is bytes and metadata only: it pins the candidate's npm
  tarball against the packument's integrity, reads the candidate's manifest member out
  of the tarball to stdout, resolves the dependency graph metadata-only (`bun install
  --lockfile-only` — bun writes the lockfile, never a node_modules tree), and ships
  every resolved package as an integrity-verified tarball beside a generated
  `file:`-dependency manifest. The credential copy comes from the board's own agent
  store — `agentDir()`, the same file `signIns()` reads — and holds the signed-in
  providers with every data key shape and the identity keys, each value a placeholder,
  so the candidate lists the board's providers' catalogs without holding one secret or
  one piece of board identity data (verified against the real CLI). The guest does the
  rest: it installs the payload offline (`bun install --prefer-offline --ignore-scripts
  --production`, dying with the VM), stamps the copy into the job HOME, and runs the
  candidate under the three-name env. The payload's trusted wrapper caps the
  candidate's stdout at 2 MiB and re-emits compact provider/id records under a byte
  budget that fits the guest's 64 KiB stdout tail: catalogs beyond the budget lose
  their tail entries (bounded, parseable) instead of failing the whole parse.
  `modelsTimeoutMs` arms before any preparation: past it the transport aborts, which
  kills the VM, the preparation runner kills its subprocesses, and every killed step
  surfaces as the one timeout error — the deadline stays armed through the response
  body. A transport that fails or returns unusable output only loses the fast track
  (below), and the failure is a warning, never a `lastError`.
- When a review ends with `pass`, the watcher asks the transport for that version's model
  list and stores the set. The transport runs `omp models --json` for that exact version.
  A failed review never probes: a failed version can never be the target.
- The output is untrusted data. `parseModelSet` accepts only a JSON object whose `models`
  value is an array. Each entry needs a provider id that matches `PROVIDER_ID`
  (`src/login.ts`) and a model id in the strict segment grammar: 1 to 3 non-empty
  segments join with `/` (compatible-provider prefixes exist, for example Baseten's
  `openai/gpt-oss-120b`), and each segment starts alphanumeric and continues with `.`,
  `_`, `:`, `-` or alphanumerics, at most 64 characters. One bad entry rejects the whole
  run. So does a run with more than `modelsMaxEntries` (1000) entries or `modelsMaxChars`
  (1 000 000) characters. The stored set is the sorted unique `provider/model` ids.
- A failed or rejected run stores nothing. The tick logs a warning. The version keeps
  today's rule: it can still become the target through the age gate, never through the
  fast track. The backfill below retries the run on a later tick.
- The state holds `modelSets: Record<version, { providers, pairs }>`. `providers` is the
  sorted set of providers that had an active sign-in when omp listed the catalog: omp
  lists only the models its current credentials make available, so a snapshot from a
  different sign-in set says nothing about now. The watcher drops every stored set whose
  `providers` differ from the current sign-in set before any comparison, and re-reads it
  under the current context. A malformed entry loads as missing, and a missing set never
  fast-tracks. Sets below the pin are pruned at save time: the comparison baseline moves
  with the pin.

### The fast track

- The baseline is the live version's set: the model set of the pin. The watcher records
  it through the same transport, under the current credential context, once per pin.
  `backfillModelSets` fills the pin's set and the sets of passed releases above the pin
  that lack one (a review that predates the recording, or a first run that failed). It
  runs at most `modelsPerTick` (5) probes per tick, and none at all while no transport
  is wired.
- In the bump target walk, a passed release is a candidate before the age rules when its
  set adds at least one id for a provider that the board has an active sign-in for
  (`signIns()` in `src/login.ts`; active rows only; an unreadable credential store counts
  as no sign-ins). A deprecated release never fast-tracks. The walk's stop rule is
  unchanged, and the settled-line rule applies to the normal path only.
- The fast-tracked bump card gets priority `P1`. Its prompt names the added models (up to
  40) and says that the release-age wait was skipped for model access.
- No added model for a signed-in provider, or no usable model set: today's rule (7 days,
  normal priority).

## Bump target

Walk the reviewed versions above the pin in ascending order:

- Stop at the first version that has no verdict, or that failed and whose card is not cleared.
- A version is a candidate when it passed (or failed with a cleared card) and it also
  satisfies the settled-line rule of docs/specs/release-line-gate.md; that rule holds the
  7-day age gate and its 14-day cap. A passed version that fast-tracks (see the model fast
  track section) is a candidate before the age rules: only the counted rule (stable, not
  deprecated, still listed) still applies to it.
- The target is the highest candidate before the stop.

File the bump card when a target exists, no earlier bump card is still open (stage not `done`),
and the target is higher than the version of the last bump card. A cancelled bump card is never
filed again for the same version: only a higher target files a new one.

Bump card: `createTask(prompt, null, "work")`, title `Bump omp to <version>`, topic `omp`,
queued. A fast-tracked card also gets priority `P1`; a normal card stays unrated. Prompt
(`ompBumpCardPrompt`): set `ARG OMP_VERSION=<version>` in `Dockerfile.worker`, change
nothing else, commit `chore: bump omp to <version>`. It names the reviewed versions it
covers. A fast-tracked prompt names the added models (up to 40) and says that the
release-age wait was skipped for model access.
After a card is filed, the watcher calls `deps.schedule()`.

## State

Global store key `ompWatch:<project name>`:

```ts
type OmpWatchState = {
  verdicts: Record<string, { verdict: "pass" | "fail"; reasons: string[]; cardId: string | null; at: number }>;
  modelSets: Record<string, { providers: string[]; pairs: string[] }>;
  bumpCard: { id: string; version: string } | null;
  lastError: { reason: string; at: number } | null;
};
```

A missing or malformed value loads as the empty state. A malformed verdict entry is dropped,
so the version is reviewed again. A malformed model set entry is dropped, so the version has
no fast track until a later tick records its set again.

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
- A passed release younger than 7 days that adds a model id for a signed-in provider files
  one P1 bump card at once (OTTR-1287). A second tick files no second card. With no
  transport wired, the same release files no card: no probe runs, no set is stored, and
  the aged release later files a normal unrated card.
- A passed release whose model set adds nothing for a signed-in provider keeps the 7-day wait.
- A models list with junk output, or with more entries than the cap, files no card and logs
  a warning.
- A model id with a compatible-provider prefix (`openai/gpt-oss-120b`) is accepted; a
  model id with an empty, doubled or over-long segment is rejected with the whole run.
- A pin snapshot taken before a provider sign-in is dropped when the sign-in set changes:
  a later release with an identical catalog files no P1 card (sign-in-change regression).
- The release body cannot end its DATA block early (fence markers are removed).
- `ompWatch` off: no fetch, no card.

## Non-goals

- No real agent turn or test run against the new omp. The review reads only the changelog.
- No board banner. The cards are the signal.
- No change to how hosts deploy main (`scripts/update-image.ts`).
