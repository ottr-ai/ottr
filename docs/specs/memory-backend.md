# Memory backend choice moves to the board (OTTR-453)

## Problem

The memory backend lives in the agent layer's `config.yml` (`memory.backend`).
docker/ottr-entry.sh patches that line to `hindsight` with sed at container start
when `HINDSIGHT_API_URL` is set. The patch is one-way (a volume that once got
hindsight never goes back) and breaks when the agent layer folder moves
(OTTR-451). A backend that needs a running Hindsight server is a deployment
setting, not agent layer content.

## Decision

The board computes the memory backend from the deployment and hands it to every
omp it starts as a `--config` overlay. The agent layer's `config.yml` stops
being the switch.

Verified fact (omp v18.13.2): `memory.backend` has no env override, but a
`--config` overlay wins over `config.yml` for real runs. Proof on a host whose
config.yml held the stale `backend: hindsight`: a run with a `mnemopi` overlay
retained into `$HOME/.omp/agent/memories/mnemopi/mnemopi.db` (mtime bumped);
the same run without the overlay stored nothing (hindsight default URL
`http://localhost:8888`, nothing listened).

## Rule

`memoryBackendFromEnv(env)` in the new `src/memory.ts`:

- `HINDSIGHT_API_URL` non-empty (trimmed) -> `hindsight`, carrying
  `HINDSIGHT_API_TOKEN ?? ""`. A Settings-saved URL/token reaches this through
  `applyHindsight`, which keeps writing the saved values into `process.env`, so
  a saved URL still beats the env seed.
- Otherwise -> `mnemopi` (omp's own default). The board never picks `off`.

The backend choice is always explicit: every spawn gets the overlay, so a
stale `backend: hindsight` line in any `config.yml` has no effect.

## Overlay

- Content: `memory:\n  backend: <mnemopi|hindsight>\n`.
- Path: `$OTTR_DATA_DIR/omp-memory.yml`, falling back to
  `os.tmpdir()/ottr-omp-memory.yml` when `OTTR_DATA_DIR` is unset (direct
  installs). In compose, `OTTR_DATA_DIR=/data` is mounted by server and
  workers, so the worker daemon resolves the argv path in its own container.
- `ensureMemoryOverlay(env)` writes the file when its content differs
  (idempotent, cheap re-run per spawn). A write failure fails the run loudly —
  the same data dir holds the run log, so a broken data dir already breaks
  runs.
- `buildOmpArgs` gains an optional `memoryConfig` path; when set, it appends
  `--config <path>` after `NO_DISCOVERY_CONFIG` (later overlays win per key;
  the memory key exists only in this overlay). `startRun` computes it per
  spawn; tests may pass an explicit path. Every omp run the board starts —
  worker turns, board-owned merge/release/review/retro turns, review checks —
  carries the overlay. `omp login` (sign-in, credentials only) does not.

## Health check and warning

`src/memory.ts` exports `checkMemoryHealth(choice)` returning
`{backend, ok, reason, checkedAt}`:

- hindsight: `GET <url>/v1/default/banks` with `Bearer <token>`, 5 s timeout.
  2xx ok. 401/403 -> "Hindsight at <url> rejected the key (HTTP <code>)".
  Other status -> "Hindsight at <url> answered HTTP <code>". Transport error
  -> "Hindsight at <url> did not answer: <err>".
- mnemopi: the store dir `$HOME/.omp/agent/memories/mnemopi` must accept a
  probe file (write + delete). Checked for the shared home and, when different
  and set, the board home (`OTTR_BOARD_OMP_HOME`). Failure -> "mnemopi store
  not writable: <path>".

The server checks at boot (after `applyHindsight`) and every 60 s
(`app.memoryHealthTick`, wired in `src/server.ts` next to the other ticks) —
never per turn. When `reason` is non-null, the state frame appends
`omp runs with no memory: <reason>` to the existing `warnings` list, so the
header warning lines and the "N warnings" count show it with no new UI
plumbing. `GET/POST /api/settings/hindsight` views gain
`{backend, memoryReason}`; the Settings Hindsight section renders the same
sentence when `memoryReason` is non-null and names the active backend. A save
triggers one immediate re-check.

## Removals

- The sed patch block in `docker/ottr-entry.sh` (D8) goes away.
- `hindsightBackendFlip()` and its config.yml patching in `src/app.ts` go
  away; `applyHindsight` keeps only the env seeding.
- Compose comments and docs stop describing the flip.

## Alate (separate board)

Alate strips the `memory:` backend line from captured `config.yml` (card on
the alate board). Until it does, the captured line is inert: the board's
overlay wins.

## Non-goals

- No change to memory data; no migration between mnemopi and hindsight stores.
- No env override for `memory.backend` in omp itself.
- No per-project backend choice; the deployment picks one backend.

## Acceptance

1. `memoryBackendFromEnv`: URL set -> hindsight; unset -> mnemopi (unit tests).
2. `ensureMemoryOverlay` writes/covers stale content; `buildOmpArgs` appends
   the overlay arg; a `startRun` dispatch (fake launcher) carries it.
3. `checkMemoryHealth`: unreachable URL -> reason; refused key -> reason;
   writable mnemopi store -> ok (unit tests with a local server / temp dirs).
4. Boot + interval check produce the warning string in the state frame and in
   the hindsight view (app tests).
5. `bun run check`, `bun test`, delta mutation gate pass.
6. Smoke evidence that omp runs with the chosen backend, with and without
   `HINDSIGHT_API_URL` (compose unavailable in this environment: the local
   equivalent — real omp runs against a stub Hindsight logger and against the
   mnemopi store — recorded in the turn report).
