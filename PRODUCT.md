# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One developer, the operator, runs omp coding agents on several of their own git projects from one machine or a home server. The operator files tasks in plain language and comes back to the board in short glances, often from a second screen or a phone, to answer questions, approve merges, and see what landed.

## Product Purpose

Ottr (OhMyPi Task Tracker) is a local kanban board that runs omp agents on git projects. Each task gets a git worktree, an agent run, a check of the result, and a merge through a per-project queue. Success: the operator delegates work and only steps in when a card truly needs a human decision.

## Positioning

Ottr enforces the process instead of only showing it. Git checks every agent report (`ready`, `answered`, `integrated`). A memory-less second model checks the work before the merge. Merges run one at a time per project under that project's `AGENTS.md`. Reviews and releases are gated and file their findings as cards. The board stays quiet while everything is normal and asks for attention only when the operator is needed.

## Operating Context

- Lanes: Backlog, Todo, In progress, Merging, Done. Cards move between them by themselves. The operator replies, steers, stops, cancels, and starts follow-ups.
- A card with "!" needs the operator. The bell collects everything that needs the operator. Desktop and phone push notifications point there.
- Review and release workflows, update cards for pinned upstream items, Dependabot and CI follow-up cards, research cards with archived reports.
- Settings, Overview, and provisioning views for the board, its workers, and Alate.

## Capabilities and Constraints

- Runs locally, by default bound to 127.0.0.1. Bun server, React 19 UI, TypeScript.
- Used on desktop and on a phone: every surface must work on both.
- Terminology: card, lane, turn (work turn, merge turn), worktree, needs you, held, finding, release.

## Evidence on Hand

- README.md, `.github/assets/screenshot.png`, `.github/assets/banner.png`, `.github/assets/built-with-ottr.png`.
- Workflow diagrams: `src/ui/workflow-task.svg`, `src/ui/workflow-review.svg`, `src/ui/workflow-release.svg`.
- No testimonials, user counts, or benchmarks exist. Do not invent them.

## Product Principles

1. Quiet when normal: attention is spent only on cards that need the operator.
2. Git is the truth: the board shows what git and the checks prove, not what an agent claims.
3. The operator decides: merges past a hold, cancels, and approvals stay human actions.
4. Glanceable: the state of every project reads in a few seconds, on desktop and on a phone.

## Accessibility & Inclusion

WCAG 2.1 AA for every UI surface (`src/ui/**`), as AGENTS.md requires.
