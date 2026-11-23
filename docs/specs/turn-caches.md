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
  level stays root-owned 0755 like the rest of the turn home; the cache
  subdirs and each scratch dir belong to the project uid when the daemon runs
  isolated, else to the daemon user.
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

## Non-goals

No change to the worker `/tmp` caps, the turn-home layer copies
(OTTR-1209's card), or the hourly `/tmp` safety net.
