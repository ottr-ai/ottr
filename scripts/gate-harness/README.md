# Ottr 1 gate harness

Measures the Ottr 1 decision gate from `docs/specs/rust-decision-gates.md`:
10,000 retained tasks, 20 projects, five concurrent viewers; pass means
state p95 below 250 ms and timer-lag p99 below 50 ms. OTTR-884 rebuilt the
OTTR-807-style harness; this copy replaces the volatile `/tmp` versions.

## Pieces

- `patch-serve.ts` — copies a tree's `src/server.ts` verbatim and applies
  exactly three deltas: a pre-picked ephemeral port printed as
  `HARNESS_PORT=<port>` once Bun.serve binds; a 10 ms in-process timer-lag
  drift probe with a 45 s rolling window served at `GET /harness/lag`;
  `idleReviews` and `trendingScan` forced false.
- `seed.ts` — builds one run's board data (20 projects, 10,000 tasks,
  27,000 turns, 150,000 events, 150,000 log lines) through the tree's own
  `src/store.ts`, so the schema always matches the measured tree. Asserts
  and prints every count; exits 1 on a mismatch. `--prompt-chars` and
  `--unique-chars` calibrate raw and gzip sizes to a real board.
- `load.ts` — five closed-loop viewers, each one WebSocket with an Origin
  header plus continuous `GET /api/state` with `Connection: close` and
  gzip. 10 s warm-up (recorded, excluded), 30 s window. Samples the lag
  endpoint and one uncompressed GET for the raw size; reads
  `/proc/<pid>/stat` for server CPU.
- `summarize.ts` — state p50/p95, lag p99, CPU %, bytes per response.
- `runpair.sh` — seeds and runs two tree dirs once per pair (base first),
  N pairs, env-scrubbed server start (`env -i`, `OTTR_BACKUP_KEEP=0`),
  SIGTERM shutdown only.

## Running a gate

1. Export each commit under test to a plain dir (no `.git` needed) and link
   node_modules from a worktree with the same lockfile:

   ```sh
   git archive <sha> | tar -x -C /tmp/tree-<name>
   ln -s "$PWD/node_modules" /tmp/tree-<name>/node_modules
   ```

2. Run the pairs:

   ```sh
   scripts/gate-harness/runpair.sh --base /tmp/tree-base --final /tmp/tree-final --pairs 5
   ```

   Run outputs go to `${TMPDIR:-/tmp}/ottr-gate-runs`; each run prints one
   summary block. 0 HTTP errors is a validity precondition for the numbers.

## Host caveat

Wall-time numbers scale with the host's single-core speed and SQLite
latency: the same tree measured 2.9-3.1 s state p95 on one WSL2 box and
4,149.5 ms on the OTTR-866 gate machine. Compare trees within one gate run
on one host; quote absolute numbers with the host named.
