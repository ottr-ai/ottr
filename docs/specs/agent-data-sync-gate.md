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
  and `OTTR_PROJECT` is `agent-data`. One optional parameter, `files`:
  data-repo-relative paths whose installed twins to hash in addition to
  the branch's changed files (a rules-only card asks for the project
  context file its acceptance names). It POSTs
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
     (the evidence must describe a commit; a dirty tree refuses with the
     status lines in the error). The status check alone does not pin the
     bytes — a drilled bypass showed an assume-unchanged edit and an
     ignored file leave `--porcelain` empty — so the install never reads
     the worktree's disk (step 7).
  6. File hashes: the branch's changed files (the diff from the fork
     point to the archived commit — the captured head sha, never the
     mutable HEAD ref — full tree, NUL-separated raw names so unicode,
     quotes, and whitespace survive) filtered to the paths the
     agent-data install contract maps, plus the caller-requested
     `files` paths.
     Mappings: `projects/<p>/<rest>` to the installed twin
     `<workspace>/<p>/<rest>`; `user/<rest>` below the gate child's home;
     a root `<name>.md` rule to `<home>/.omp/agent/rules/<name>`. Sources
     are read from the snapshot, never from the worktree; each record
     carries path, source sha256, installed sha256, and `match`. The
     workspace root is the parent of the agent-data project's registered
     checkout and the home is the server's own `HOME`, so tests use temp
     roots and the deployment keeps `/workspace` only as data. A `files`
     path the contract maps nowhere refuses the request (HTTP 400) before
     any record exists; the tool accepts at most 16.
  7. The gate installs an immutable snapshot of HEAD: `git rev-parse HEAD`
     pins the commit (recorded as `head`), `git archive <head>` piped into
     `tar -x` fills a fresh root-owned 0700 temp dir the turn uid cannot
     reach, and the gate runs `node <alate checkout>/sync.mjs --data .`
     with cwd at that snapshot. The command is the documented one; the
     data it reads is the archive, so worktree disk tricks cannot change
     what sync installs. Env pinning: the child env takes `ALATE_HOME`
     and `HOME` only from the gate target. It also gets `PATH` and the
     documented pass-through list (`GIT_CONFIG_GLOBAL`,
     `GIT_CONFIG_SYSTEM`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`).
     Nothing else from the server env rides. A probe test pins this
     contract and asserts that server-env secrets (`ALATE_API_KEY`,
     `GH_TOKEN`, `OTTR_WORKER_TOKEN`) never reach the child. The first
     gate version passed the server's real `HOME` through the allowlist,
     and a later fix pinned both variables to the target. The test keeps
     that fix from a silent revert: a leaked `process.env.HOME` fails the
     equality with the target's home, and a gate child would then resolve
     install targets from the server's real home. 10 minute timeout;
     stdout+stderr captured in one bounded output field with a
     `truncated` flag. The snapshot dir is removed after the run.
- The record
  `{at, head, code, output, truncated, files, durationMs, error?}`
  appends to the task's `syncGateLog` (new tracked store column, same
  parse/serialize and keep-last-20 cap as `workCheckLog`) and the
  stored record is the response body. Gate-level refusals (the
  clean-tree guard, a missing sync.mjs, an unresolvable head, a spawn
  failure) append an error record with `code: null`, so every run
  attempt is tracked data; route-level auth and eligibility refusals
  answer 403/400/404/409 before any record exists.
- Stale-source skip (OTTR-1305). Before the child runs, the gate walks
  the snapshot's `projects/<p>/<rest>` files. The guard checks three
  facts for each path: the installed twin exists, its bytes differ from
  the snapshot source, and the branch's diff (fork point to the
  archived commit) does not include the path. When all three hold, the gate declines the
  install for that path: the branch forked before the file gained its
  current content, so its bytes are stale against the fresher live
  checkout. The record gains a `skipped` entry
  `{path, reason: "stale source: unchanged in branch, twin differs"}`,
  and the skipped path keeps its `files` entry with the pre-run hashes
  (`match: false`), so the record shows the stale bytes the gate
  refused. The gate then replaces the snapshot bytes at that path with
  the twin's own bytes, so the child cannot install anything stale; at
  worst it rewrites the twin's bytes. A path the card changed installs
  normally — that is the acceptance evidence the gate exists for. A
  twin that is missing or byte-equal never skips. `user/` paths and
  root rules keep the plain behavior. A run without a known fork point
  treats every unchanged drifted `projects/` path as stale, because the
  changed set is empty and the gate refuses to overwrite live bytes it
  cannot vouch for.
- Operator side (the OTTR-1305 incident). Validation runs use a fixture
  `ALATE_HOME` with isolated install targets. Never run `--data .` from
  a card worktree against the real alate checkout.
- The gate never cleans up, repairs or resets anything. The only
  live-state writes are sync.mjs's own install — the same mutation the
  operator's run makes, now executed by the board. Every other step
  (status check, diff, hashing) is read-only.

## Isolation trade-off

The board runs alate-repo code as the server uid with the data it reads
shaped by an agent-data branch (`--data .` at the HEAD snapshot), and a
successful run installs that content into the live alate home and the
project checkouts before merge review. Compared with today, the human
checkpoint between the agent's ask and the install moves to the card flow
itself: the user filed the card with the sync gate in its acceptance, and
the record (head, code, output, per-file hashes with match flags) is
tracked store data any later check or review reads. Mitigations: the
script source is the alate project checkout, which the agent uid cannot
write; the argv is fixed and carries no agent input; the install reads an
immutable archive of HEAD, so worktree disk state — committed or planted
— cannot change what sync installs; the log cap bounds repeated runs. The
R5-1 residual the docs already record for board git (a
worktree-reachable `.git/config`) applies unchanged, and the snapshot
reads the same shared object store the board's own merge reads.

A limit this repo cannot close from a turn uid: the real sync.mjs lives in
the alate checkout, which is mode 700 for the alate uid (OTTR-994), so the
work-turn environment cannot read it. The acceptance tests therefore
execute the real script where it is readable (the board's root-side check
runs: the tests copy the deployed script into an isolated ALATE_HOME
fixture with isolated install targets) and skip visibly with that reason
everywhere else, instead of proving a replacement's behavior. The
observed contract those runs pin, reported by the review check that read
the deployed script: sync.mjs processes only root rules and rejects rule
files without frontmatter; the mechanics tests (guards, snapshot, argv,
serialization, hashing) use a transparent probe that installs nothing, so
no test can mistake its behavior for the real sync's. The record's raw
output remains the honest evidence of what the deployed script did.

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
