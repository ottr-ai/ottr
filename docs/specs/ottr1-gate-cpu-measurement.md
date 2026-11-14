# Ottr 1 gate: main-thread CPU measurement (OTTR-885)

This report answers the CPU clause of gate Ottr 1
(`docs/specs/rust-decision-gates.md`) with a main-thread measurement. It runs
on the OTTR-884 final tree and re-runs the gate numbers with it.

- Base tree: `fcadf25` (parent of the first OTTR-884 perf commit, `186da75`).
- Final tree: `cd9b747` (origin/main HEAD; the full OTTR-884 repair).
- Host: one WSL2 box, one run, pairs alternate base and final (the gate spec's
  "compare trees within one gate run on one host" rule; absolute numbers are
  host-bound).
- Workload: 10,000 retained tasks, 20 projects, five closed-loop viewers (one
  WebSocket plus continuous `GET /api/state`), 10 s warm-up (excluded), 30 s
  window, 5 pairs. 0 HTTP errors in all 10 runs.
- Tool: `scripts/gate-harness/runpair.sh`; CPU from `/proc/<pid>/stat` (process)
  and `/proc/<pid>/task/<tid>/stat` (threads; the thread whose tid equals the
  server pid is the main thread). Bun 1.4.4 exposes no per-thread CPU hook
  (`performance.eventLoopUtilization` is undefined), so the /proc sampling
  stands, as the gate spec allows.

## Verdict

- Base tree: gate FAILS. State p95 7,735.4 ms pooled (per-run 7,246-7,791 ms;
  threshold 250 ms). Timer-lag p99 10,133-10,650 ms (threshold 50 ms).
- Final tree: gate PASSES. State p95 21.8-24.4 ms per run, 17.0 ms pooled over
  39,267 window samples. Timer-lag p99 18.2-21.1 ms, mean 3.9-4.3 ms.
- CPU clause: not triggered, because the clause applies only to a failed gate.
  On the failed base tree the clause HOLDS: the main thread carries 82-83% of
  process CPU (below), so portable application CPU on the main thread
  dominates.

Decision: the gate stays green after the OTTR-884 repair. No Rust discussion
and no native-projection prototype opens.

## Main-thread split

Process CPU is the sum of all threads. "Main share" is main-thread CPU as a
share of process CPU.

| pair | side | state p50 | state p95 | lag p99 | lag max | proc CPU % | main CPU % | main share % | window reqs |
| - | - | - | - | - | - | - | - | - | - |
| 1 | base | 7,171.1 | 7,392.9 | 10,133.2 | 10,133 | 120.4 | 98.8 | 82.0 | 20 |
| 2 | base | 7,089.1 | 7,246.2 | 10,270.8 | 10,271 | 120.6 | 98.8 | 81.9 | 20 |
| 3 | base | 7,239.6 | 7,372.5 | 10,477.0 | 10,477 | 119.8 | 98.7 | 82.4 | 20 |
| 4 | base | 7,261.3 | 7,445.6 | 10,156.2 | 10,156 | 119.9 | 98.8 | 82.4 | 20 |
| 5 | base | 7,678.0 | 7,790.1 | 10,650.1 | 10,650 | 119.3 | 98.8 | 82.8 | 20 |
| 1 | final | 15.3 | 24.4 | 20.7 | 1,498 | 68.8 | 55.5 | 80.7 | 7,401 |
| 2 | final | 14.0 | 22.6 | 19.7 | 1,476 | 68.5 | 57.0 | 83.1 | 8,120 |
| 3 | final | 13.9 | 21.8 | 21.1 | 1,552 | 68.6 | 57.2 | 83.3 | 8,321 |
| 4 | final | 14.4 | 22.9 | 18.2 | 1,481 | 68.2 | 56.5 | 82.9 | 7,904 |
| 5 | final | 14.9 | 24.0 | 20.5 | 1,504 | 70.9 | 58.5 | 82.5 | 7,521 |

Latency units: ms. Base timer-lag windows hold only 11 probe samples per 45 s
(the loop is too blocked to serve the probe more often); lag p99 equals lag
max there, so the base loop is effectively frozen between rebuilds.

## Per-thread breakdown at window end

Mean % of the 30 s window wall across the 5 pairs, from the top-12 thread
table in `records.json` (`/proc/<pid>/task/*/stat`, tick deltas over the
window):

| kind | base mean % (max) | final mean % (max) |
| - | - | - |
| main thread (`bun`, tid = pid) | 98.8 (98.8) | 56.9 (58.5) |
| Bun threadpool (`Bun Pool`, gzipAsync + file I/O) | 9.3-10.1 across 4 threads | ~0.2 per thread |
| JSC GC/JIT (`mi-scavenger`, `HeapHelper`, `JITWorker`, `JSCWarmUp`) | 1.1 (4.4) | 1.0 (2.2) |

Bytes per response are identical on both sides (gz avg 3.59 MB, raw
31.90 MB), so both trees serve the same state content.

## What the split decides

- On base, gzip does NOT dominate: the Bun threadpool holds ~10% while the
  main thread sits at 98.8% of wall. The cost is main-thread work (SQLite
  reads, JSON assembly, request handling). A native projection would have had
  to target the main thread, not gzip.
- On final, the main thread carries 56.9% of wall (82-83% of process CPU), and
  the Bun threadpool collapses to ~0.2% per thread: gzip now runs once per
  state revision inside the repaired publish path, not once per request. The
  gate passes with this profile, so no further native work is justified by the
  CPU clause.
- Per-request cost fell far more than the CPU totals show: final serves
  ~7,900 window requests per run at 68% process CPU, against base's 20
  requests at 120%.

## Peaks

- Base: the loop stall peaks at the window length itself (lag max 10.1-10.7 s).
- Final: one lag spike of ~1.5 s per window in all 5 pairs (max column), mean
  3.9-4.3 ms. It does not move p99. Cause not profiled (harness-only card);
  recorded as an observation for a later gate run.

## Reproduce

```sh
git archive fcadf25 | tar -x -C /tmp/tree-base
git archive cd9b747 | tar -x -C /tmp/tree-final
ln -s "$PWD/node_modules" /tmp/tree-base/node_modules
ln -s "$PWD/node_modules" /tmp/tree-final/node_modules
scripts/gate-harness/runpair.sh --base /tmp/tree-base --final /tmp/tree-final --pairs 5
```

OTTR-866's earlier base numbers (state p95 4,149.5 ms, process CPU 75%/63%)
came from a different host and day; this run's base-vs-final comparison is the
valid one, per the host caveat in `scripts/gate-harness/README.md`.
