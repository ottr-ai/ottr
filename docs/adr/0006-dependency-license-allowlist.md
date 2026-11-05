# 0006. Dependency licenses are allowlisted

Date: 2026-11-05

## Status

accepted

## Context

Release reviews must pass two dependency gates: `bun audit --audit-level=high`
must exit 0, and `bun pm licenses` may list only a fixed set of licenses
(AGENTS.md, Review section). The allowlist is 0BSD, Apache-2.0, BlueOak-1.0.0,
BSD-3-Clause, CC-BY-4.0, ISC, MIT, MIT OR Apache-2.0, MPL-2.0 — described
there as the tree as of 2026-10-04. Until now this rule has lived only in the
local-only AGENTS.md: it had no versioned record, and no rationale beyond the
as-of date is recorded in the repo. This ADR is the decision's first versioned
home.

## Decision

A release review blocks when `bun pm licenses` lists any license outside the
allowlist (AGENTS.md, Review section). The allowlist is the frozen dependency
tree as of 2026-10-04. Admitting a new license is a deliberate change to this
decision — a superseding ADR — never a silent pass.

## Consequences

- A dependency addition carrying an unlisted license fails the release review.
- `bun audit --audit-level=high` must also exit 0; every review command must
  exit 0 (AGENTS.md, Review section).
- The list grows only by explicit decision; until then it stays frozen at the
  2026-10-04 tree.
