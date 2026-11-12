# Rust decision gates (OTTR-865)

## Decision this spec serves

ADR-0012 (`docs/adr/0012-ottr-keeps-typescript-and-bun.md`) keeps Ottr on
TypeScript and Bun and keeps Alate on Node. Rust returns to consideration
only through the four decision gates in this spec. The ADR calls its gate
table proposed; this spec holds the confirmed workloads and thresholds, and
the numbers here are the source of truth. The ADR stays unchanged, because
accepted ADRs are immutable.

These numbers are decision gates for a new Rust discussion. They are not
product requirements. They set no service-level target, no alert limit, and
no hosting budget. A failed gate permits one bounded-component prototype
comparison. It never approves a rewrite by itself. A passed gate keeps the
current stacks.

A threshold change edits this spec. It does not reopen ADR-0012.

## Confirmed workload

The owner confirmed this workload on 2026-11-12:

| System | Confirmed workload |
| --- | --- |
| Ottr, per board | 10,000 retained tasks, 20 projects, five concurrent viewers |
| Ottr, hosting target | the self-hosted Docker Compose deployment in use today |
| Alate, per instance | about 1 GB snapshots, up to three concurrent imports or provisions |

## The four gates

### Ottr 1 — state latency and timer lag

- Measure: representative history, project, and viewer loads after the
  design work of ADR-0012: narrow board projections, bounded state and
  query work, git refresh coalescing, and blocking reads out of the
  request loop. Record latency, main-thread CPU, timer lag, bytes, and
  peaks.
- Workload: 10,000 retained tasks, 20 projects, five concurrent viewers.
- Gate: Rust reopens when state p95 reaches 250 ms or more, or timer-lag
  p99 reaches 50 ms or more, and portable application CPU dominates the
  cost. If improved TypeScript still fails and portable CPU dominates,
  consider one native projection prototype.

### Ottr 2 — hosting memory and CPU

- Measure: complete tenant duty cycles on the intended hosting: wake, real
  turns, and steady idle. Measure worker and server memory separately. The
  run covers real turn and merge processes; the OTTR-807 app-process RSS
  numbers do not qualify.
- Hosting target: the self-hosted Docker Compose deployment (8 GiB memory
  cap), confirmed on 2026-11-12.
- Gate: a measured smaller memory tier or a CPU cut reopens Rust only when
  it stays a material net saving after review and migration costs. The
  monetary threshold comes from actual bills, not from the OTTR-807 cost
  model.

### Alate 1 — provision cost

- Measure: real cold and warm provisions with the trusted scanner,
  plugins, and network steps, always on the same safe inputs. Split the
  time into scanner, package install, network, snapshot, file guards, and
  own CPU.
- Workload: snapshot sizes of about 1 GB.
- Gate: when own CPU stays above one second and above 30% of repeated
  provision wall time after the safe design changes, Rust reopens for one
  native planning comparison. Scanner and security behavior stay equal.

### Alate 2 — responsiveness during import and provision

- Measure: HTTP responsiveness and memory and CPU peaks during imports and
  provisions, after work isolation.
- Workload: about 1 GB snapshots, up to three concurrent imports or
  provisions.
- Gate: Rust reopens when health p99 reaches 100 ms or more, or when a run
  breaches the host limits. If bounded Node isolation still fails because
  application CPU or memory dominates, compare one Rust worker.

## Measurement rules

- Each decision run alternates the configurations and repeats each of them
  on an isolated host.
- The run separates client limits, warm and cold caches, and work drain.
- A failed gate permits a prototype discussion. It does not approve a full
  rewrite.
- The measurement runs and any Rust work belong to later cards, not to
  OTTR-865.

## Acceptance checks

- This file holds the confirmed workloads and the four confirmed
  thresholds, and it names ADR-0012 as the decision it serves.
- `bun run check` and `bun test` exit 0 from the worktree root.

## Non-goals

- No application code, no Rust prototype, and no measurement run in this
  task.
- No product service-level targets: the thresholds do not become alert or
  dashboard limits.
- No change to ADR-0012 and no hosting change.
