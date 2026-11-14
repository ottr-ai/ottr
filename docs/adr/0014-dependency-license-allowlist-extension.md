# 0014. The dependency license allowlist covers the mermaid tree

Date: 2026-11-14

## Status

accepted

## Context

ADR-0006 froze the allowlist at the dependency tree of 2026-10-04 and said the
list grows only by an explicit decision. mermaid 12.3.0 entered the
`dependencies` of package.json after that date. On 2026-11-14, `bun pm
licenses` lists five keys outside the frozen list, and every one of them comes
from mermaid's dependency subtree:

- `BSD-2-Clause` — entities 7.0.1 (a dependency of marked 16.4.2)
- `EPL-2.0 OR GPL-3.0-or-later` — elkjs 0.12.1
- `(MPL-2.0 OR Apache-2.0)` — dompurify 3.4.17
- `Unlicense` — robust-predicates 3.0.3 (a dependency of dagre-d3-es 7.0.14)
- `Unknown` — khroma 2.1.0. Its package.json names no license. The package
  ships a `license` file with the MIT text (Copyright (c) 2019-present
  Fabio Spampinato, Andrew Maney).

Mermaid is a real feature of the board. src/mermaid.ts serves its prebuilt
bundle at a versioned path. src/app.ts renders mermaid code fences in
markdown. A mermaid removal deletes a feature, so the allowlist must grow
instead. Three of the new keys are no stricter than licenses the list already
admits: BSD-2-Clause asks less than BSD-3-Clause, Unlicense asks nothing, and
`(MPL-2.0 OR Apache-2.0)` offers a choice the list already admits as MPL-2.0.
`EPL-2.0 OR GPL-3.0-or-later` permits the choice of EPL-2.0, a weak copyleft
license in the same family as MPL-2.0.

## Decision

The allowlist grows to the dependency tree of 2026-11-14. Next to the
ADR-0006 list, these license keys are allowed: `BSD-2-Clause`,
`EPL-2.0 OR GPL-3.0-or-later`, `(MPL-2.0 OR Apache-2.0)`, `Unlicense`. The
single `Unknown` entry is khroma 2.1.0, allowed by its MIT license file.
Every other `Unknown` package still fails. scripts/licenses.ts enforces
exactly this list, and AGENTS.md (Review section) holds the same list. A
change to one list is a change to both, and it needs a superseding ADR.

## Consequences

- A dependency bump that adds a license key outside this list fails the
  release review until a superseding ADR admits it.
- The `Unknown` exception is pinned to the package name khroma. A package
  that loses its license field elsewhere still fails.
- scripts/licenses.ts no longer admits the bare `EPL-2.0` key. The old gate
  script allowed it with no package behind it. The script now enforces the
  recorded list and nothing more.
