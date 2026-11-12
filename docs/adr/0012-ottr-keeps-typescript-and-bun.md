# 0012. Ottr keeps TypeScript and Bun

Date: 2026-11-12

## Status

accepted

## Context

Task OTTR-807 evaluated a full or partial Rust rewrite of Ottr and Alate for
performance, scalability and reliability. The report measured local synthetic
loads and read the failure history:

- `/api/state` took 121.55 ms median at 1,000 tasks and 1,275.35 ms median at
  10,000 tasks; the raw payload reached 31.6 MB. A wrapper that returned
  cached bytes served 304.69 requests/s at the same concurrency where the real
  endpoint served 0.73. The gap is repeated work, not runtime cost.
- The HTTP profile assigns 40.5% of sampled main-thread time to SQLite host
  calls, 32.7% to synchronous compression and 12.5% to serialization.
- A simulated 100-project git refresh issued 1,200 child processes in 665 ms
  and produced 316.3 ms median timer lag; the refresh calls lack a common
  in-flight guard.
- The commit history holds no GC-pause, runtime-segfault or server-OOM
  incident. The recorded reliability fixes need explicit domain rules, not a
  different language.
- A port must reach parity with about 64,300 non-test backend lines and about
  100,400 test lines, while the UI, the omp hooks and the JS tooling stay
  JavaScript.

The report concludes that the dominant costs follow the amount of work:
whole-history board reads, repeated serialization and compression, and git
process fan-out. A Rust implementation with the same SQL, the same frame
cadence and the same child processes keeps these costs. Design changes remove
them; a language change does not. The same evaluation retained Node for
Alate, whose own repo records that decision.

## Decision

1. Ottr stays on TypeScript and Bun. No Rust prototype starts now. This
   decision changes no application code and no deployment.
2. Design work comes first, along the report's cheaper choices: narrow board
   projections, bounded state and query work, git refresh coalescing with
   bounded concurrency, blocking reads and process probes out of the request
   loop, publication derived from state changes, and prebuilt compressed UI
   assets. Every change preserves state freshness, authorization, git
   isolation, the Windows Bun platform workaround and scheduler ownership.
3. Rust returns to consideration only through the four decision gates below,
   measured after the design work on an isolated host with repeated,
   alternating runs. A failed gate permits one bounded-component prototype
   comparison; it never approves a rewrite by itself.

| Gate | Measurement | What reopens Rust |
| --- | --- | --- |
| Ottr 1 | Representative history, project and viewer loads after the design work | state p95 of 250 ms or more, or timer-lag p99 of 50 ms or more, at 10,000 retained tasks, 20 projects and five viewers, with portable application CPU dominant |
| Ottr 2 | Complete tenant duty cycles and worker and server memory on the intended hosting | a measured smaller memory tier or a CPU cut that stays a material net saving after review and migration costs |
| Alate 1 | Real cold and warm provisions with the trusted scanner, plugins and network | remaining own CPU above one second and above 30% of repeated provision wall time after safe design changes |
| Alate 2 | HTTP responsiveness during import and provision after work isolation | health p99 of 100 ms or more, or a host-limit breach |

## Consequences

- The full-rewrite, FFI and Rust-service options stay rejected until a gate
  fails after the design work.
- A future port must first define a parity contract: versioned HTTP, event,
  CLI, database and crypto formats; recorded-input replay with redacted data;
  one authoritative writer per state domain; an idle cutover with a verified
  backup and reversible data formats.
- A future port must also establish Rust review capacity, compile and gate
  cost, distribution support, a rollback path and the end of coexistence.
- Follow-up tracker cards carry the remaining OTTR-807 steps: the workload
  agreement, the Ottr design work and measurement, the Alate measurement, and
  the conditional prototype and port-approval steps.
- A decision to port any component supersedes this ADR with a new one.
