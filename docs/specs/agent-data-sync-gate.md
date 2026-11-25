# Agent-data sync gate: a turn runs the alate sync acceptance step itself

Status: proposed (OTTR-1267).

## Problem

A work turn on an agent-data card must produce its acceptance evidence: the
exit code and output of the sync gate (`ALATE_HOME=<alate checkout> node
<alate checkout>/sync.mjs --data .`, run from the card worktree), plus the
sha256 of an installed project file. Since the per-project uid isolation
(OTTR-994), `/workspace/alate` is mode 700 for the alate uid and agent-data
turns run as another uid, so the turn cannot run the gate. Every agent-data
card whose acceptance names the sync gate parked at needs_you with
"permission denied" (AGEN-105, AGEN-115, AGEN-127, AGEN-134, AGEN-138,
AGEN-140, AGEN-141, AGEN-143; OTTR-1241 hit the same wall from an ottr
turn). The operator's run is mechanical and exited 0 every time.

## Decision

Board-side gate step (the isolation-preserving option). A new tracker
extension tool `sync_gate` POSTs to a new board route; the board server runs
the fixed gate command in the card's worktree with its own rights, records
the run on the task as tracked state, and returns the stored record to the
turn. The turn uid gains no new filesystem rights; OTTR-994 stays untouched.

The agent process never holds the worker token (childEnv strips it), so the
tool routes through the extension like `sandbox_run`: board token for the
route allowlist, per-run token (`RunTokens`, OTTR-1197) to bind the request
to the calling run's own card and project.

## Behavior

- Extension tool `sync_gate` (extension/tracker.ts), registered only when
  the run is a work run (no `OTTR_REVIEW`/`OTTR_RETRO`/`OTTR_TRENDING`)
  and `OTTR_PROJECT` is `agent-data`. No parameters. It POSTs
  `x-board-token` and `x-run-token` to
  `/api/projects/<project>/sync-gate` and returns the stored record as
  JSON text, or the board's error line.
- Board route `POST /api/projects/:project/sync-gate` (src/app.ts):
  1. The route joins the boot-token POST allowlist next to `sandbox`.
  2. `runTokens.check(x-run-token)` binds the request to the calling run's
     project and card; a mismatch refuses before the store is touched.
  3. The task must exist, be kind `work`, and belong to the grant; the
     route project must equal the grant project and `agent-data`.
  4. The card's worktree (the store's worktrees dir joined with the task
     id, the path dispatch already uses) must exist.
  5. Guards before the run: the alate project must be registered and hold
     `sync.mjs`; `git status --porcelain` in the worktree must be empty
     (the operator runs the gate on committed state; a dirty tree refuses
     with the status lines in the error).
  6. File hashes: the card's changed files under `projects/` (the branch
     diff against its base) map to their installed twins at the workspace
     root (`projects/<p>/<rest>` to `<workspace>/<p>/<rest>`). Each
     record carries path, the worktree source sha256, the installed
     sha256, and `match`. A missing installed file records `match: false`.
     The workspace root is the parent of the agent-data project's
     registered checkout, so tests use temp roots and the deployment keeps
     `/workspace` only as data.
  7. The gate runs `node <alate checkout>/sync.mjs --data .` with cwd at
     the worktree, env `ALATE_HOME=<alate checkout>`,
     `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pinned like the board's own
     git, the server `PATH`, and the server `HOME`. 10 minute timeout;
     stdout+stderr captured in one bounded output field with a
     `truncated` flag.
  8. The record `{at, code, output, truncated, files, durationMs, error?}`
     appends to the task's `syncGateLog` (new tracked store column, same
     parse/serialize and keep-last-20 cap as `workCheckLog`) and the
     stored record is the response body. Gate-level refusals (the clean-tree
     guard, a missing sync.mjs, a spawn failure) append an error record with
     `code: null`, so every run attempt is tracked data; route-level
     auth and eligibility refusals answer 403/400/404/409 before any record
     exists.
- The gate never cleans up, repairs or resets anything. The only
  live-state writes are sync.mjs's own install — the same mutation the
  operator's run makes, now executed by the board. Every other step
  (status check, diff, hashing) is read-only.

## Isolation trade-off

The board runs alate-repo code as the server uid with cwd inside a
uid-writable worktree whose content (`--data .`) the turn shapes, and a
successful run installs that content into the live alate home and the
project checkouts before merge review. Compared with today, the human
checkpoint between the agent's ask and the install moves to the card flow
itself: the user filed the card with the sync gate in its acceptance, and
the record (code, output, per-file hashes with match flags) is tracked
store data any later check or review reads. Mitigations: the script source
is the alate project checkout, which the agent uid cannot write; the argv
is fixed and carries no agent input; the clean-tree guard pins the synced
content to the committed branch; the log cap bounds repeated runs. The R5-1
residual the docs already record for board git (a worktree-reachable
`.git/config`) applies unchanged.

## Alternatives considered

- Grant the agent-data uid read (or write) access to the alate checkout
  (mode/group change): rejected. It weakens the OTTR-994 user-private-group
  model, and the gate's install step would still need write rights on
  another project's home — a direct R5-1 crossing.
- Expose the gate on the worker `/run` surface: rejected. The agent env
  holds no worker token by design; handing it over gives a turn the
  worker's whole root argv surface.
- Dry-run against a copied alate home: rejected. The evidence must
  describe the live install the operator flow produces, and a per-run
  copy of the alate checkout is heavy and drifts from live state.
- Ask the alate server to run sync (its provision flow already returns
  `{script, code, output, truncated}` results): rejected. Alate's
  provision reads its own configured data checkout; no API points it at a
  card worktree.

## Risks

- The board container must ship `node` (Dockerfile.worker pins it,
  checksum-verified; GitHub runners preinstall node). A missing binary
  records an error run, never a fake pass.
- A hung sync.mjs holds the route until the 10 minute timeout; runs
  serialize per project in-process, so a second call waits and records its
  own run after.
- sync.mjs's internal write targets are outside this repo's knowledge; the
  gate reproduces the operator command verbatim and records its raw
  output, so the evidence stays honest whatever the script does.
- Repeated calls during one turn: every run appends a record and the
  keep-last-20 cap bounds the log; each run costs one bounded subprocess.

## Non-goals

- No change to any other project's isolation.
- No new npm dependency.
- No wording change in src/prompts.ts.
- No automatic gate trigger on report_outcome or in the work check; the
  turn decides when to ask.
- No parsing of sync.mjs semantics and no alate server API change.

## Acceptance checks

- A test: an agent-data work run asks for the sync gate and receives the
  real exit code and output of the fixture `sync.mjs` run in the card's
  worktree (real subprocess, captured code/output, stored record).
- A test: the agent-data uid still cannot write to the alate checkout
  (root-only test in the turnUid/workers style: child runs as the
  agent-data uid, write into a mode-700 alate-uid dir fails).
- A test: the gate refuses a dirty worktree, a foreign project/card
  grant, and a non-work card, each with a tracked error record.
- `bun run check` and `bun test` pass.
