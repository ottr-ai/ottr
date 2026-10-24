# herdr and pi-herdsman: evaluation and what we took from them (2026-09-26)

Sources: [github.com/herdrdev/herdr](https://github.com/herdrdev/herdr) (40.8k stars, Rust, Apache-2.0, stable `v0.9.1`), [herdr.dev/docs/windows-beta](https://herdr.dev/docs/windows-beta/) ("Windows support is generally available", with a long caveat list), [github.com/boadij/pi-herdsman](https://github.com/boadij/pi-herdsman) (65 stars, TypeScript, Apache-2.0, npm `pi-herdsman`). Status here: **herdr 0.9.1 installed** (audited `install.ps1`: manifest + SHA-256 verified download, user-PATH only, no elevation, no services) and proven end-to-end with a headless server, a CLI-created workspace, and a managed `--kind omp` agent that answered a prompt (GLM-5.3-Flash).

## What they are

- **herdr**: an agent-aware terminal multiplexer. A background server keeps agent terminals alive across disconnects; panes are tagged `working / blocked / idle`; agents drive it via CLI/socket API (`herdr pane …`, `herdr agent …`); plugins; single binary. Owns *where agents live*.
- **pi-herdsman**: a **Pi** (not omp) extension for async subagent orchestration on top of herdr: lead Pi session delegates to background Pi agents, nested "herds", `/agents` surface, `/chief` supervision across leads, `ask_owner` question routing. Owns *who talks to whom*.

## Fit with the tracker

Different layers, almost no overlap: the tracker runs **headless** `omp -p --mode json` (structured outcomes, cross-checked with git) and owns queue, worktrees, merge and releases. herdr supervises **interactive** agent terminals. omp is a first-class herdr agent kind on Windows (`distribution/agent-detection/omp.toml`, `herdr agent start --kind omp`).

Measured during the trial:

| Observation | Consequence for us |
|---|---|
| herdr's `idle` state can flip a beat before omp's spinner actually stops (seen twice) | our `--mode json` + `report_outcome` + git cross-checks are the more precise completion signal; keep them as the source of truth |
| herdr exposes the same primitives we already built in | one-assignment-per-agent, exact session id as the only continuation handle, question routing to the exact owner — the tracker already does all three (task = one assignment, `session_id` + `--resume`, `needs_you` + `needs_reason`) |
| a rules interview opened as a detached `wt.exe` window can land off-screen and look like nothing happened | the gap that bit us was "no way to reopen an interview for an already-added project" → `POST /api/projects/:project/interview` + a topbar button on rule-less projects (`openInterview` reused from `addProject`) |
| pi-herdsman's docs (supervision, recovery, handoffs, lifecycle) | best free design reading for future tracker work: startup reconcile of orphaned runs exists here ("tracker restarted" → "!"), their recovery docs are the next-level reference |

## Verdicts

- **herdr**: keep as the supervision layer for *interactive* omp sessions and rules interviews; the tracker stays the orchestration brain. Possible later: surface tracker state inside a herdr pane (`herdr pane report-metadata` / a plugin); a web dashboard for phones stays the tracker's job.
- **pi-herdsman**: not usable here (drives Pi sessions, not omp), but its architecture notes are worth rereading before any multi-agent tracker work.
- **Windows caveats to remember**: no live server handoff, no direct terminal attach, plugins preview, ConPTY cursor flicker; binaries unsigned (SmartScreen warns).
