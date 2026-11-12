# Spec: worker OOM kill continues the turn once

## Behavior

A worker turn dies when the worker container's memory cgroup kills a process
(the kernel OOM killer). The run then ends with no exit code, and the board
parks the card with "omp exited with code unknown before finishing". This
change names the cause and lets the card continue once by itself.

### Worker side (src/workers.ts)

- `serveWorker` reads the container's cgroup v2 files before it spawns omp and
  after the child closes. It reads them with the existing `readCgroup` reader
  from `src/systemStats.ts`, under the same `cgroupRoot` seam that
  `GET /stats` uses (default `/sys/fs/cgroup`).
- The snapshot records the `memory.events` `oom_kill` count and the
  `memory.max` byte limit. A missing or unreadable file records null. The
  reader never throws.
- When the child ends with no exit code (a signal) and the `oom_kill` count
  grew during the run, the result says so:
  - the done sentinel (`xdevWorkerDone`) carries `oomKilled: true` and
    `memoryLimitBytes: <bytes or null>`;
  - the detached run result (`DetachedRun.result`) carries the same fields.
- When the child ends with an exit code, or the `oom_kill` count did not grow,
  or a snapshot is null, the fields stay absent and the result keeps today's
  shape.
- `parseSentinel` accepts the two fields only when they have the right types
  (`oomKilled` boolean, `memoryLimitBytes` null or a non-negative integer).
  `settleSentinel` maps them onto `RunResult`.

### Board side (src/runner.ts, src/turn.ts)

- `RunResult` gains optional `oomKilled` and `memoryLimitBytes` (src/types.ts;
  added with this spec).
- A new rule runs first inside `deathRule`: when `result.oomKilled` is true,
  the reason sentence is
  `The worker ran out of memory (OOM kill, limit <N>)`, where `<N>` is
  `formatBytes(memoryLimitBytes)` (example `8 GiB`). Without a byte limit the
  sentence is `The worker ran out of memory (OOM kill)`.
- First OOM death of a card (the previous turn's error does not start with
  `The worker ran out of memory (OOM kill`): the card goes back to `queued`
  with `pendingPrompt: "."`, the same automatic continue the usage-limit rule
  uses. The needsReason is `<sentence> - continuing automatically. Cancel to
  stop it instead.`
- Second OOM death of the same card (the previous turn's error starts with the
  sentence): the card parks `needs_you` with `<sentence> again after the
  automatic continue. Free memory or raise the worker limit, then reply.`
- The settle writes one card-log line with the worker name:
  `<settled needsReason> (worker <url hostname>)`. The worker name comes from
  the dispatch URL hostname (`worker-b` in `http://worker-b:8787`).

## Boundaries and error cases

- Unreadable or missing cgroup files (cgroup v1 host, non-Linux): both
  snapshots null, no flag, today's behavior.
- A run that ends with an exit code never flags OOM, even when the count grew.
- A canceled run (`killed: true`) still parks as "Stopped by the tracker":
  `killedRule` runs before the death block.
- A lost worker (no sentinel, `workerLost: true`) keeps the worker-lost rule.
- The cgroup counters belong to the whole worker container: a concurrent
  run's OOM in the same container can set the flag on this run's signal
  death. The flag still names the real limit and the continue is safe, so
  this stays.
- A board restart during a detached run keeps today's recovery: it queues a
  generic restart resume and does not carry the OOM fields.

## Acceptance checks

1. Fake worker result with no exit code and `oomKilled: true`: the settle
   queues the card again once, and the card log holds the OOM line with the
   worker name. Before the change, the same result parks with
   "omp exited with code unknown".
2. A second OOM death parks `needs_you` with the OOM reason.
3. A signal death with no `oom_kill` growth keeps today's generic reason.
4. Worker tests run the real `readCgroup` reader over a temporary cgroup
   directory while a real child dies by its own SIGKILL.
5. `bun run check` and `bun test` exit 0.

## Non-goals

- The memory limits themselves: the workers get 12 GiB at the next recreate.
- Chrome process cleanup in the agent tools.
- The microVM runner: no OOM fields there.
- OOM carry across a board restart of a detached run.

## Alternatives considered

- The board polls the worker's `GET /stats` after a death: rejected — the
  counter window races with other runs, and the worker may be gone.
- A continue-once flag column on the task row: rejected — the
  previous-turn-error streak pattern already exists, is crash-safe, and every
  death rule uses it.
- The reason rides the stderr tail: rejected — a signal death has no stderr.

## Risks

- A false OOM flag (another run's kill attributed to this run's signal death)
  parks the card with a wrong-but-clear reason and one safe continue. Low
  cost, accepted.
- Hosts without cgroup v2 keep today's behavior; the counter read degrades to
  null.
