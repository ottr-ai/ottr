# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One developer (the owner) running omp coding agents on their own git projects, on one machine (Windows or Linux). Nobody else views or operates the board.

## Product Purpose

Ottr (OhMyPi Task Tracker) is a local kanban board that runs omp agents on git projects. The user types a task in plain language; Ottr gives it a git worktree, runs `omp -p` in it, and merges finished work through a per-project merge queue. Success is tasks completing end-to-end with git-verified outcome reports, without flooding the machine or a human babysitting each step.

## Positioning

Ottr enforces only the process: worktrees, merge order, outcome reports, git checks. Quality comes from each project's own `AGENTS.md` rules, not from a human review step — that absence is a deliberate core claim, confirmed by the owner. Everything runs on the local machine; the board binds `127.0.0.1` by default (`OMP_TRACKER_HOST` serves beyond loopback, e.g. for the compose stack or phone access).

## Operating Context

- Windows 10/11 or Linux; Bun, git, and `omp` on `PATH`. Cancel kills the process tree (`taskkill` on Windows, signals on Linux), Browse… uses PowerShell 7 (`pwsh`) on Windows and `zenity` or `kdialog` on Linux. macOS is not supported yet; it will reuse the Linux implementation.
- omp one-shot runs (`omp -p`) cannot answer approval prompts, so omp must run tools without them; the board flags a turn that hit one.
- Projects live in Ottr's parent folder or `OMP_TRACKER_ROOTS` (several separated like `PATH`: `;` on Windows, `:` on Linux); the board discovers every project with a `.tasks/tasks.db`. A project added by path is remembered across restarts wherever it lives, and its path is editable on the project's settings page for renames or moves.
- Releases are per project and on demand: the **Create release** button collects everything merged since the last tag, a review card verifies it (including mutation tests), and Ottr tags the reviewed commit, pushes the tag and creates the GitHub release. Merge turns no longer need to release after every task. A project can set a release command that runs instead of Ottr's tag, push and GitHub release.
- Work on Ottr itself runs on a second clone (`ottr-live`) so tasks never change the code the board runs; updates there are manual (`bun run update`).
- A project without `AGENTS.md` keeps its tasks in Todo until a rules interview writes one.

## Capabilities and Constraints

- Two-turn pipeline per task: work turn (implement, verify, commit, report) then merge turn (rebase, re-verify, integrate, push). One merge turn per project at a time.
- Slots: default 2 running agents per project, 3 total; configurable in Settings (per-project 1–8, global cap; the saved setting wins over env).
- Every outcome report is cross-checked with git: `ready` = commits ahead of base + clean worktree; `answered` = no commits; `integrated` = branch head on upstream.
- Research tasks skip the code path: the agent answers with a `research-report.md` file that Ottr archives on the card and shows in the drawer; they end `answered` and never merge.
- Cards with **!** need the user (question or `needs_you`); the user replies in the drawer and the agent continues in the same session. Steering, cancel, image paste into tasks/replies, and follow-up tasks from Done cards exist. Turns cut off by a restart resume on their own.
- `.tasks/` and `.worktrees/` are self-ignored via their own `.gitignore` files containing `*`; the DB, logs, and omp sessions stay local.
- Terms: "turn" (work/merge), "worktree", "merge queue", "ottr-live", branch prefix `ott/<id>-<slug>`.
- Explicitly undecided (PLAN.md phase 7 "Open" and "Left out"): human review/approval/retry, drag-and-drop or manual moves, Next.js server, gitattributes autofix, task merges. Record new open decisions here rather than inventing them.

## Brand Commitments

Name: Ottr (OhMyPi Task Tracker). Asset: `src/ui/logo.png`. Nothing else binding — no pinned colors, fonts, or mascot rules.

## Evidence on Hand

- `README.md`: user-facing product truth (how a task moves, requirements, configuration).
- `PLAN.md`: design, decisions, verified-on-this-machine log (the live HTTP API is the `routes` object in `src/app.ts`), phase status, "Left out" list.
- `docs/decisions/`, `docs/research/`: decision records and comparisons (paperclip, herdr/pi-herdsman).
- `src/ui/logo.png`: the only brand asset.
- No marketing content, testimonials, or customer evidence exists; future work must not fabricate any.

## Product Principles

1. Local and private: everything on the machine; loopback by default, public exposure only through the explicit `OMP_TRACKER_HOST`/`OMP_TRACKER_PUBLIC_HOSTS` settings (Hindsight may be a LAN/NAS service, e.g. the compose stack).
2. Process over policing: Ottr enforces the pipeline; each project's `AGENTS.md` owns quality.
3. Git is the source of truth: every claimed outcome is checked against git state.
4. Humans act by exception: only **!** cards interrupt; no approval prompts by design. Three named approval mechanisms are the deliberate exceptions, and all hold a card instead of prompting: the update-merge hold (decision 2026-10-13, U7), retro proposals (decision 2026-10-14), and fork research: an hourly watch of the project's GitHub forks files held improvement proposals, and merges of fork-born tasks wait for a reply (decision 2026-10-14).
5. Recoverable by default: restarts resume turns; no destructive database operations.
