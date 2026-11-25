# Turn caches and per-card scratch (OTTR-1211)

A turn's caches and scratch must never be global and never live in the capped
`/tmp` forever. The image's `BUN_INSTALL=/usr/local/bun` makes the default bun
cache root-owned and unwritable for turn uids, so agents copied 520 to 640 MB
bun caches into per-card `/tmp/bun-cache-<id>` dirs. The 24h aged `/tmp` sweep
(OTTR-754) stays as the safety net only.

## Layout

Per project `P` (name guarded by `assertProjectSegment`):

- Worker: `<turnHomesRoot>/P/cache/` with the subdirs `xdg`, `bun`, `pip`,
  `uv`, `npm`, and `<turnHomesRoot>/P/tmp/` for per-card scratch. The project
  level stays root-owned 0755 like the rest of the turn home. The cache tree
  is project-private (0700, uid-owned when the daemon runs isolated, else
  daemon-owned — its artifacts are the same class `closeProjectDir`
  protects), and the scratch parent is 0711: another uid reaches its own
  run's dir by name but cannot list the siblings. Each scratch dir is 0700.
- Server (worker-less fallback, server-local runs): the same layout under
  `serverTurnCacheRoot()` — `OTTR_TURN_CACHE_ROOT` or
  `<homedir()>/.cache/ottr-turns`. The provision guard is not tripped: it
  audits manifest-tracked files and the rules dir only, never `.cache`.

## Turn env

Every turn with a project gets, set after every other env source:

- `XDG_CACHE_HOME=<cache>/xdg`
- `BUN_INSTALL_CACHE_DIR=<cache>/bun`
- `PIP_CACHE_DIR=<cache>/pip`
- `UV_CACHE_DIR=<cache>/uv`
- `npm_config_cache=<cache>/npm`
- `TMPDIR=<turnHomesRoot>/P/tmp/run-<sanitized run id>-<random>` (worker runs;
  server-local runs keep the `/tmp/ottr-run-*` dir and the hourly net)
- `OTTR_TMP_ROOT=<daemon tmpdir()>` unchanged: the mutation lock stays
  host-global under the redirected TMPDIR.

All cards of one project share one cache; two projects never share one. A run
without a project, or a failed prep, keeps the default env: cache setup is
best effort and never fails a run. Scratch is deleted when the run's child
closes — a normal end and a cancel (kill) both pass through close — and the
worker's daily tick sweeps per-card tmp dirs orphaned by a worker restart with
the live-run-starts guard.

## Scratch liveness markers (OTTR-1295)

The keep-guards of the sweeps (live-run starts, `/proc` holds) are
per-container. On the compose deployment several workers share the
`turn-homes` volume and each runs the daily tick over every project's
`tmp/`, so one worker can delete another worker's live run scratch whose
temp files stayed quiet for 24h. The daemon therefore writes one liveness
marker per run beside the scratch:

- Path: `<scratch>.live` (for example
  `<turnHomesRoot>/P/tmp/run-<sanitized id>-<random>.live`), a plain file in
  the root-owned 0711 scratch parent. The daemon writes it right after the
  scratch's `mkdtemp`, before the scratch's chown, and never chowns it: the
  marker stays daemon-owned, and the turn uid has no write bit on the parent,
  so it can neither create, touch, nor delete the marker.
- Content: the scratch's basename, for forensics only. The mtime is the
  signal, never the content.
- Creation and deletion are best effort and never fail the run; a failed
  marker leaves the run with exactly the pre-OTTR-1295 guards. The marker is
  removed in the same close path that removes the scratch.

Sweep rule (`sweepTmpDirs`, so every sweep pass on every root obeys it): a
top-level entry named `run-*` whose sibling `<entry>.live` marker exists and
whose marker mtime is younger than the 24h age is never removed. Markers are
ordinary entries otherwise: a stale marker (older than 24h — its owner died
or stopped refreshing) is removed by the uniform age rule, and with the
marker gone its scratch loses the guard and goes at the same pass when its
own quiet age has also passed 24h.

Each daemon refreshes (`utimes`) the markers of its own live runs — active
and detached, exposed next to `runStarts()` as `runScratches()` — at the
start of every sweep tick, hourly on the worker and at boot. A live run's
marker is therefore never more than roughly one hour old, and the 24h
freshness window has ample slack against timer lag. A crashed worker's
markers stop refreshing and expire within 24h, so its leftover scratches are
swept at a later tick (bounded leak of at most about 48h after the last temp
write); the refresh is per run and best effort.

No OTTR-1179-style decision lock guards the marker: every daemon touches
only markers of its own runs (from its own `runScratches()`), foreign daemons
only read markers, each marker is one root-only path with no
read-modify-write, and the worst overlap (one daemon's stale-marker prune
racing the dead owner's refresh) recovers at the next tick. There is no
shared claim to serialize, unlike the layer-copy pin where two servers must
not copy or prune the same layer.

## Cache sweep

A timer inside each worker and the server, at boot and every 24h, sweeps every
project cache root it can see (`<turnHomesRoot>/*` on the worker, the server
root on the server):

1. TTL: remove a top-level entry whose newest file atime is at least
   `CACHE_TTL_MS` (14 days) old. Directory atimes are ignored — the sweep's
   own readdir refreshes them under relatime. A missing or unreadable atime
   falls back to mtime; an entry with no readable freshness stays.
2. Cap: while the root holds more than `CACHE_ROOT_MAX_BYTES` (5 GiB), evict
   the top-level entry with the oldest freshness, until the root fits.
3. An entry a live process holds (cwd, open fd, argv, exe) is never removed,
   and an entry whose newest mtime sits within `SWEEP_CLOCK_SKEW_MS` (5 s)
   before a live run's start is never removed: the run's start is stamped
   before its scratch dir is created, but the kernel may assign the inode's
   birth mtime a few ms behind the sweeping process's clock, and the guard
   must hold for a scratch that never sees a write. The walk only lstats, so
   it never refreshes file atimes.
4. One log line per root per run names the root and the freed size.

Constants are named; per-entry failures skip the entry for the next sweep.

## Acceptance

- Two cards of one project share the cache dirs; two projects do not.
- Ending and cancelling a card both delete its scratch.
- Fixture tests prove TTL removal, cap eviction order, and that a live-held
  entry survives. A sweep test never signals or touches a process it did not
  create.
- Two sweep invocations with disjoint run-start sets on one fixture tmp
  parent prove the OTTR-1295 rule: an aged quiet scratch with a fresh marker
  survives the foreign sweep; an unmarked aged scratch goes; a stale marker
  stops guarding and is removed, and its scratch follows within the tick
  bound. A run with a turn uid cannot create, touch, or delete its marker
  (root-owned parent, 0711), and its marker stays daemon-owned after the
  scratch chown.

## Non-goals

No change to the worker `/tmp` caps, the turn-home layer copies
(OTTR-1209's card), or the hourly `/tmp` safety net.
