# Agent layer switch: provision with no wait

Status: accepted (OTTR-451). The alate side of this contract is ALAT-63; the
two cards must ship as a pair (see "Migration").

## Problem

Alate provisions the agent layer straight into the shared home volume
(compose: `home:/root`, mounted as `/root` in the server, the workers and
alate). A file change under a running omp can break the turn, so the board
provisions only when no turn runs anywhere (`alateProvisionTick` in
`src/app.ts`, gate `anyTurnActive()`). On a busy board the provision waits for
hours: on 2026-11-04 it waited all night for one 9 h Stryker turn.

## Design

Each provision installs a complete agent layer into a versioned folder and
makes it live with one atomic symlink switch. A turn resolves the switch once,
at its start, and keeps that layer for its whole life. A provision never
waits for an idle board.

### Layout (both homes, same shape)

Two homes exist:

- the shared home: the worker home (`/root` in compose, `$HOME` direct), which
  alate provisions and worker turns read;
- the board home: `OTTR_BOARD_OMP_HOME` (compose: `/etc/ottr/home`), which the
  board-seed one-off fills and the board's own omp spawns read.

In each home `H`:

- `H/.alate/layers/<id>/` holds one installed layer: exactly what alate's
  install writes today (the allowlist: `.omp/agent` config, rules, skills,
  extensions; `.omp/plugins`; `.agents`; the `.ottr/workers` lists).
  `<id>` is the data repo commit plus a counter (alate decides the exact form;
  the board treats it as an opaque directory name).
- `H/.alate/current` is a symlink to `layers/<id>`. Alate switches it with one
  atomic rename: create a temp symlink, `rename()` it over `current`. Before
  the switch, nothing a running turn reads changes.
- `H/.alate/in-use.json` is the board's registry of layers that live runs
  pinned. Shape: `{"layers": [{"id": string, "since": epoch-ms}]}`. The board
  is the only writer; alate only reads it for clean-up.

### State that stays shared (never in a layer)

The layer never carries per-run or credential state. A provision never changes
it. At pin time the board links these entries inside the layer back to their
flat-home paths (create the symlink even when the target does not exist yet,
so omp creates the target through the link):

| Link inside the layer          | Target                     | Why                                  |
| ------------------------------ | -------------------------- | ------------------------------------ |
| `.omp/agent/agent.db`          | `H/.omp/agent/agent.db`    | the credential store (one per stack) |
| `.omp/agent/sessions`          | `H/.omp/agent/sessions`    | `--resume` works across switches     |
| `.omp/oauth`                   | `H/.omp/oauth`             | provider token cache                 |
| `.omp/logs`                    | `H/.omp/logs`              | http-400 logs stay in one place      |
| `.cache`                       | `H/.cache`                 | test and package caches stay shared  |

When the flat home has the entry, the layer also links it (missing target
stays missing, as today):

`.gitconfig`, `.config/git`, `.config/gh`, `.ssh`, `.claude`, `.npm`, `.bun`,
`.local`.

Everything else in the layer is layer content: a turn may write new files into
its own layer home (they die with the layer at clean-up).

### Memory backend: not part of the layer

`config.yml` is mixed content: alate ships the user part, and the
`memory.backend` line is deployment state, not layer content (OTTR-453 moves
the pick to the deployment; `mnemopi` stays the default, and the board warns
when omp runs with no memory). A layer ships whatever `config.yml` the data
repo holds, and the pin never rewrites it — no flip at pin time, and the
entry script's sed patch is not copied into new layers. The entry script's
boot-time flip keeps covering the flat homes (the no-layer era and spawns
that stay flat); how the deployment's backend choice reaches pinned spawns is
OTTR-453's contract.

### Pinning (turn start)

Every omp process the board spawns pins at start. Two entry points, one helper
(`src/layers.ts`):

1. **Turn runs** (`startRun` in `src/runner.ts`, both dispatches): resolve
   `<home>/.alate/current` once with `realpath()` — worker runs resolve under
   the shared home, local (board) runs under `boardOmpHome()`. On a hit:
   prepare the links, then run omp with
   `HOME=<layer-dir>` and `PI_CODING_AGENT_DIR=<layer-dir>/.omp/agent` (both
   absolute, the resolved target, never the `current` link itself). The worker
   dispatch stops stripping `PI_CODING_AGENT_DIR` only when it pins the layer;
   the board's own private pin stays stripped (R5-1). On a miss or a broken
   link: today's env (flat home), plus a warning line in the run log for a
   broken link.
2. **Auxiliary board spawns** (`boardOmpEnv()` in `src/login.ts`: `omp login`,
   `omp models`, `omp usage`, the fork-analysis gateway): `HOME` resolves the
   board home's current layer the same way, with the same prepare. Their
   explicit `PI_CODING_AGENT_DIR` overrides (the sign-in and usage flows)
   keep the flat agent dir, because they touch the credential store.

The pin lives for the run's whole life. A later switch never affects a
pinned run: the env holds the resolved layer directory, not the link.

### Record: which layers are in use

- `startRun` adds the layer id to `H/.alate/in-use.json` before the spawn and
  removes it when the run settles (close, error, or kill). Every board-spawned
  run records: turns, review checks, retro runs.
- Work and merge turns also persist the layer id: the `turns` table gains a
  `layer` column (`startTurn` takes it from the run handle). It is a record,
  not the clean-up source.
- On boot the board rebuilds `in-use.json` from `turns` rows that have no
  `ended_at` (their task may still be shown as running after a crash).
  Locally spawned children die with the server process; worker-side children
  are handled by `sweepLostTurns`.

### Clean-up (alate side, ALAT-63)

Alate deletes a layer folder only when all of these hold: it is not
`current`, it is not the layer `current` pointed to before the last switch,
and its id is absent from `in-use.json`. The current layer and the one before
it always stay. Residual risk, accepted: a turn that outlives two switches
(possible for a 9 h Stryker run) can lose its layer; the turn then fails and
classifies requeues it once, then parks it for a human. A corrupt or unwritable
`in-use.json` never fails a run (the board logs a warning); clean-up then
still keeps the last two layers.

### Provision trigger

- `alateProvisionTick` drops the idle gate: no `anyTurnActive()` check. The
  1 h back-off after a failed attempt stays, as do the pending, running and
  back-off checks.
- The tick provisions with no wait only when alate reports agent-layer
  support: the alate health body carries `layers: true` (ALAT-63 adds the
  flag). While it does not, the tick keeps the old idle gate for that attempt:
  an old alate writes the flat home, and a flat write under a running turn is
  exactly the corruption this design removes. The manual provision route keeps
  today's behavior (the user's own action, no gate).
- The board's own provisioning view (`alateView`) and the `/api/provisioning`
  section need no new fields.

### Board seed and hourly deploy

The board seed uses the same switch. `board-seed` (compose one-off of the
alate image, ALAT-63) installs into `/etc/ottr/home/.alate/layers/<id>` and
switches `/etc/ottr/home/.alate/current`; it keeps writing `/etc/ottr/seed-commit`
next to the home, which `seedView` reads. Server-side turns pin at start, so a
seed mid-turn cannot disturb them. The hourly deploy
(`scripts/update-image.ts`) already runs the seed before its turn drain and
holds only the restart — that part stays: a container restart ends its turns
(out of scope here). The R5-1 rules of the board home are unchanged: the
board-config volume stays server-only, the entry script still refuses a pin
inside the shared home, and it never copies from it.

### Layer-following reads

Reads of layer content by the board follow the current layer at read time
(moment-in-time, no pin): `modelRoles()` (config path),
`envListPath`/`readEnvNames`/`listedEnvNames`/`workerProjects` (board home),
`toolsListPath`, `aptListPath` and the `eachWorkerProject` boot installs (the
`.ottr/workers` lists), and `http400Dirs` scans both homes plus their current
layers. `agentDir()` (the credential store path) stays flat by definition.

## Error cases

- **No layer yet** (no `current` link, or alate still flat): every spawn runs
  the flat home, exactly as today. This is the migration state.
- **Broken link** (`current` exists, `realpath` fails): the spawn falls back
  to the flat home and logs a warning. Alate's next provision repairs the
  switch.
- **Layer deleted under a turn**: prevented by the clean-up rule above
  (`in-use.json` plus keep-last-two). The residual risk is stated above.
- **Prepare failure** (a shared-state link cannot be written): the spawn falls
  back to the flat home and logs a warning; the run never fails because of
  pinning.
- **Old alate** (no `layers: true` in health): the tick keeps the idle gate
  for that attempt and the manual route stays available.

## Migration

1. Merge OTTR-451 (this spec and the board side) and ALAT-63 (the alate
   install-into-layer and switch) as a pair.
2. Deploy in either order: the board image (compose) and the alate code (data
   repo provisioning on the host). Between the two, the board sees no
   `layers: true` and keeps the old idle gate, so nothing breaks. The board
   image deploy turns on layer mode in the bundled alate service: set
   `ALATE_LAYER=1` in the `alate` service environment in `docker-compose.yml`
   (the alate activation flag, ALAT-63). Without it, the bundled alate keeps
   provisioning the flat home.
3. After the first layered provision, `current` exists and new turns pin. The
   flat agent-layer files stay in place, unused; alate may prune them later.
   The flat shared state (agent.db, oauth, sessions, caches, git and gh
   config) keeps serving through the links.

## Non-goals

- No change to the R5-1 isolation of the board home (server-only volumes, no
  copies from the shared home).
- No second home volume; the layers live inside the existing homes.
- No change to the SkillSpector gate (alate scans before a switch, as today).
- No change to the restart drain of `scripts/update-image.ts`.
- The alate install, switch and clean-up implementation is ALAT-63.
- No UI change: Settings → Alate already shows `lastProvisionError`.

## Acceptance checks

- A test starts a run on layer A, switches the link to layer B, and proves
  the running run still reads A (its env holds A's resolved directory) while
  a new run reads B.
- A test proves the clean-up contract from the board side: a live run's layer
  is in `in-use.json`, a settled run's layer is gone from it, and a reader
  that follows the rule (keep current, keep previous, skip in-use ids) never
  deletes a layer a live run pinned.
- A test proves a pinned run sees its own layer under the paths it expects:
  `HOME` and `PI_CODING_AGENT_DIR` point into the layer, the shared-state
  links resolve to the flat home, and the layer's config.yml ships byte for
  byte as installed (the pin never rewrites it).
- `bun run check`, `bun test` and the delta mutation gate pass.
