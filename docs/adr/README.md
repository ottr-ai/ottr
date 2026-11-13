# Architecture decision records

An architecture decision record (ADR) captures one architecturally significant
decision and its rationale. This folder is the project's decision log. The concept
comes from Michael Nygard (2011); see https://adr.github.io/ for an overview.

## When to write one

Write an ADR only when all three conditions hold:

1. The decision is hard to reverse.
2. It is surprising to a new reader.
3. It is a real trade-off (another reasonable option existed).

Most changes get none. A spec in `docs/specs/` tells what one change does; an ADR
tells why the system has its shape and stays true after the change ships. A spec may
link to its ADR.

## Template

```markdown
# <NNNN>. <Title>

Date: YYYY-MM-DD

## Status

proposed

## Context

<the forces and the problem that made the decision necessary>

## Decision

<what was decided>

## Consequences

<what follows, good and bad, and what a future change must do>
```

## Numbering

Files are named `NNNN-slug.md`, zero-padded four digits, lowercase-hyphen slug.
Numbers increase monotonically and are never reused. The next ADR takes the highest
existing number plus one.

## Status values

- `proposed` — under discussion, not yet in force.
- `accepted` — in force. An accepted ADR is immutable: to change the decision, write
  a new ADR and flip the old one's status.
- `superseded by ADR-NNNN` — replaced; link to the replacing ADR.

## Index

| Number | Title | Status |
| ------ | ----- | ------ |
| 0001 | Review conventions live in the project's AGENTS.md | accepted |
| 0002 | Integration is ff-only linear history; only the server pushes | accepted |
| 0003 | tasks.db schema changes are additive | accepted |
| 0004 | AGENTS.md is local-only | accepted |
| 0005 | The omp pin follows npm automatically | superseded by ADR-0010 |
| 0006 | Dependency licenses are allowlisted | accepted |
| 0007 | The merge target is a project setting | accepted |
| 0008 | PR mode is a per-project choice | accepted |
| 0009 | Work turns can run in a Firecracker microVM per turn | accepted (experimental) |
| 0010 | The omp bump follows a changelog review | accepted |
| 0011 | Token fields are sealed and deployments use encrypted volumes | accepted |
| 0012 | Ottr keeps TypeScript and Bun | accepted |
| 0013 | PostgreSQL backend and async stores | accepted |
