# Rolling restart for image updates

Status: draft (OTTR-454). This spec changes the deploy flow of
`scripts/update-image.ts` and the drain API of the board.

## Problem

`scripts/update-image.ts` (`drainRunningBoard`) holds new turns on the whole
board (`POST /api/drain`) and restarts all containers only when no turn runs
anywhere. The hold lasts at most 1 h, then the run gives up until the next
hourly run. On a busy board an update waits for hours: on 2026-11-04 a 9 h
Stryker turn blocked every hourly run all night.

Two workers (`worker-a`, `worker-b`) and the server run turns. The server also
runs turns itself (merge turns, retro, the board check, and the board's own omp
runs: release review, release, and work turns when no worker is configured).

## Goal

One runner at a time: drain it, wait until its turns end, recreate only its
container with the new image, wait until it is healthy and connected, undrain
it, then the next runner. The other runners keep working. An update never
waits for the whole board to be idle.

## Evidence: what a server restart does to turns

- A worker turn dies when the server restarts. The worker runs the turn's
  `omp` child and streams its log over the `POST /run` response; a stream
  cancel or request abort calls `killTree()` on the child
  (`src/workers.ts`, serveWorker abort handler). After a tracker restart,
  `recoverRestarted()` keeps an open turn only when its recorded pid is alive;
  a worker turn has `pid: null`, so it settles as lost and requeues once for a
  worker, and a second loss parks the card at needs_you (`src/turn.ts`,
  `sweepLostTurns`; `src/runner.ts`, the `workerLost` path).
- A server-local turn (merge, release publish) dies with the server process.
- Therefore: the server is the last runner to roll, and it rolls only when no
  turn runs anywhere. Worker rolls happen while the server stays up, so the
  log stream and the cancel path keep working for the turns that run.

## Design

### Runner ids

- A worker's id is the hostname of its entry in `OTTR_WORKER_URLS`
  (`worker-a`, `worker-b`). By compose convention the hostname is the compose
  service name, so the script maps service ↔ runner id without new config.
- The server's own runner id is `local`. Its drain exists so server-local turns
  (merge, retro, board check, release publish, and work turns in local-spawn
  mode) can stop while workers keep working. The update script does not use
  `local` alone: the server step holds the whole board (below), which is
  strictly stronger.

### Drain state (src/app.ts)

Board-wide state stays as it is: `drainUntil`, `drainCommits`, renewed by
`POST /api/drain` for `DRAIN_MS` (30 min), shown in `/api/state` and the
Notices. Nothing here changes.

New: `runnerDrains: Map<string, number>` (id → hold-until epoch ms). A
per-runner hold carries no commit subjects and never shows in the notice bar:
turns keep flowing on the other runners, so the user sees no stall. Like
`drainUntil`, it lives in memory; a server recreate or restart clears it.

### API: `/api/drain` (src/app.ts)

Same route, same guards (`api(req, ...)`: loopback trust, the Origin rule on
POST). Three changes:

- `GET /api/drain` (new): returns
  `{ drainUntil: number|null, drainCommits: string[]|null, preparing: number, runners: [{id: string, url: string|null, until: number|null, turns: number}] }`.
  `runners` lists every worker hostname from `OTTR_WORKER_URLS` plus `local`;
  a worker entry's `url` is its entry from `OTTR_WORKER_URLS` (the health
  probe uses it), `local` has `url: null`.
  `turns` counts the live runs on that runner: a worker's count is the
  `running` entries dispatched to its hostname; `local` counts the live runs
  without a worker url. `preparing` is the global preparing count; it is not
  attributable to one runner, so the script treats `preparing > 0` as "no
  runner is idle".
- `POST /api/drain` body `{ commits?, runner? }`: without `runner` the
  behavior is today's board-wide hold. With `runner` the request validates the
  id against the known runners (400 with `{error}` otherwise) and sets
  `runnerDrains[runner] = now + DRAIN_MS`. Board-wide state stays untouched.
  Response `{ until: number }`.
- `DELETE /api/drain?runner=<id>`: clears that runner's hold, response
  `{ until: null }`. Without `runner`: today's board-wide clear.

### Turn gates (src/turn.ts)

- The board-wide gate (`ops.drained()` in `schedule()`) stays exactly as it
  is, board-check exception included.
- New `ops.drainedRunner(id): boolean` reads `runnerDrains`.
- Work turns with a worker target: `startRun` gets the target's urls filtered
  by `drainedRunner(hostname)`; a drained worker never receives a dispatch.
  Before the synchronous claim, if every url is drained, the turn does not
  start (the card stays queued; the next schedule tick retries).
- Local turns (merge, retro, board check, release publish, work turns with no
  worker target): before the synchronous claim, `drainedRunner("local")`
  defers the start. No board-check exception here: `local` drain is an
  operator action, and the script never sets it alone.

### Live run → runner attribution (src/runner.ts, src/turn.ts)

`startRun`'s worker path returns the handle without the worker url today; it
adds `url` (the dispatched worker's url) to the returned handle. Local handles
carry no `url`. The turn engine counts `running` entries by
`new URL(entry.url).hostname` and exposes the counts to the routes:

- New engine function `runnerTurns()`:
  `{ local: number, workers: Record<string, number>, preparing: number }`.

### Compose: worker healthcheck (docker-compose.yml)

Workers get a healthcheck like the server's, probing the worker's own
`GET /healthz` (`src/workers.ts`): `bun -e` fetch of
`http://127.0.0.1:${WORKER_PORT:-8787}/healthz`, interval 30s, timeout 10s,
retries 3, start_period 30s. This makes `docker compose up -d --no-deps --wait
<worker>` wait for a healthy worker, which the script relies on.

### Rolling flow (scripts/update-image.ts)

`preflightAndRead`, `buildAndSidecars`, `runningServices`, `seedBoard`,
`recordSeed`, and the sidecar deploys stay as they are. The drain/restart
block becomes:

1. Probe support: `GET /api/drain` through the server exec. If the board does
   not answer it (a board one version older), run the legacy whole-board flow:
   today's `drainRunningBoard` + `up -d --wait` unchanged. This is the
   script-vs-server mixed-version fallback.
   A running worker service whose hostname no runner lists (not in
   `OTTR_WORKER_URLS`, so no turn can reach it) recreates without a drain and
   without the turns wait; the script logs this.
2. Worker roll, one at a time, in `compose ps` order, for each running worker
   service whose image changed (`imageChanged`):
   - `POST /api/drain {runner}`; poll `GET /api/drain` every `POLL_MS` until
     the runner's `turns === 0` and `preparing === 0`.
   - Still busy after `HOLD_LIMIT_MS` (1 h): `DELETE ?runner`, log that the
     runner keeps a turn and its restart waits for a later run, mark it stuck,
     and go on with the next runner.
   - Idle: `docker compose up -d --no-deps --wait <service>`. A non-zero exit
     stops the roll at once (exit 1): no further runner rolls, the server does
     not restart, the not-yet-rolled containers stay on the old image.
   - Wait until connected: poll through the server exec a fetch of
     `http://<hostname>:8787/healthz` until it answers ok (short limit, `POLL_MS`
     steps). A failure here stops the roll like a failed health check.
   - `DELETE ?runner` (undrain), then the next worker.
   - The wait renews the runner hold each poll (one POST holds `DRAIN_MS`, the
     wait can reach `HOLD_LIMIT_MS`); a refused renewal ends the wait and the
     runner lands in the stuck path below.
3. Server roll, only when no runner is stuck:
   - Server image changed or a fresh seed waits: board-wide hold
     (`POST /api/drain` with the commit subjects, as today), poll the turn
     count to zero with the 1 h limit and the existing `releaseHold` behavior,
     then `up -d --no-deps --wait server` (image changed) or
     `compose restart server` (seed only, image unchanged). The recreate or
     restart clears every in-memory drain, so no undrain is needed.
   - Not stuck but nothing to do for the server: no server step.
   - Any stuck runner: no server step; the server restart waits for a later
     run, because a server restart kills the stuck worker's turn.
4. Final `up -d --wait` (no `--no-deps`): starts a service that is not running
   and waits for the server's health, as today. It recreates nothing (all
   changed containers were rolled per service), and it never runs on a run
   with a stuck runner: `compose up` would recreate the stuck worker and the
   server, and that kills the stuck turn.
5. A run that rolled at least one worker but left another stuck exits 0 (like
   today's "waits for a later run"); a run whose seed failed exits 1 as today.

### Mixed versions

Workers roll first, the server last. The only mixed pairs are:

- old server ↔ new worker: transient during the roll, and persistent after a
  stopped roll (a worker passed health, a later one failed). Compatibility
  rule: the worker HTTP API (`GET /healthz`, `POST /run`, `POST /sweep`) and
  the server's requests to it stay compatible for one version in this
  direction; the worker API gains only optional response fields.
- new server ↔ old worker: never persists. The server rolls after every worker
  rolled, and the board-wide hold before the server step means no turn runs on
  an old worker while the new server boots.

Tests pin the order (worker recreate and health steps happen before any server
`up`/`restart`; a worker health failure stops before the server step) and the
fallback (a board without `GET /api/drain` keeps the legacy whole-board flow).

### Limits

- Per runner: the same `HOLD_LIMIT_MS` (1 h). A runner that does not drain is
  released (undrained), left on the old image, and retried by the next hourly
  run. The roll continues with the other runners.
- The server step keeps today's whole-board hold limit and release behavior.

## Acceptance checks

1. `scripts/update-image.test.ts`: the roll order (drain one worker, recreate
   one, wait health+connected, undrain, next worker, server last); a stuck
   runner (roll continues, server step deferred, stuck runner undrained); a
   failed health check (roll stops, remaining containers untouched, exit 1);
   the legacy fallback on a board without the runner API.
2. `src/app.test.ts` (or the turn tests): per-runner drain gates — a drained
   worker gets no dispatch while others work; all workers drained defers the
   turn start; `local` drain defers server-local turns; `GET`/`POST`/`DELETE`
   `runner` behavior including the 400 for an unknown runner.
3. Gates: `bun run check`, `bun test`, `bun run test:mutation:delta` over the
   changed lines.
4. Smoke run on the compose stack (if a docker host is available in the
   environment): start the stack, run a turn on worker-a, run the update; the
   roll finishes worker-a's drain only after its turn ends, worker-b keeps
   working, no failed turn, no board-wide hold during the worker roll.

## Non-goals

- No change to how the image is built (OTTR-451/ALAT-63 own the agent layer).
- No UI change: per-runner holds do not show in the notice bar.
- No change to the board-wide drain semantics, the notice, or `DRAIN_MS`.
- No multi-host rolling deploy: one compose stack per host, as today.
