# Stale turn recovery (dead lock, hung child)

A turn whose agent process is alive but waits forever on state that can no
longer change holds its card and its slot for hours. The supervisor finds
such turns on its tick, diagnoses the cause read-only, and applies a safe
fix from a fixed allowlist. When no rule matches with all preconditions
true, it parks the card with a question instead. It never touches files
outside the card's own dirs, never kills a process outside the turn's
tree, and never kills the turn's omp process.

Incident of record: OTTR-1191 (2026-11-24). Card running; omp pid 329 on
worker-b alive at ~0.6 % CPU with only the context-mode MCP server as
child; card log and session file unchanged since 10:28:46 UTC (~6 h). The
last session entry was a bash `tool_execution_start` with `timeout 0`: a
while loop sleeping 600 s until `/var/tmp/gate-1191/tmp/ott-stryker.lock`
disappeared. The lock held `{"pid":5229}`; pid 5229 (an orphaned Stryker
run) had died when Docker stopped for disk compaction, so nothing could
ever remove the lock. A steer alone cannot help: it reaches the agent only
after the current tool call ends. The operator steered first, then deleted
the lock after checking it still named pid 5229 and that pid 5229 was
gone; the loop ended by itself.

## Detection (supervisor tick, `staleTurnPass`)

Per non-cancelled card with `state === "running"` and a live run entry
(`ops.liveRun` — the unsuffixed loop entry; absent ops or entry skips the
card; OTTR-1216 owns the no-process case):

- **Log idle**: `now - mtime(store.logPath(id)) >= STALE_IDLE_MS`
  (`STALE_IDLE_MS = 30 * 60_000`, named constant; the existing 30 min
  `maxTime` rule for checks and the 2 h `SILENT_LOG_MS` card warning stay
  unchanged).
- **Session idle**: `now - probe.sessionAt >= STALE_IDLE_MS`. The probe
  reports the newest session `.jsonl` mtime under the run's data dir on
  the host that owns the run (worker runs write the session on the worker
  and copy it out at settle, so the server cannot stat it directly).
  `sessionAt === null` (unreadable) fails the session signal: no suspect.
- **No busy child**: the probe walks the run pid's process tree
  (`/proc/<pid>/stat` utime+stime+cutime+cstime ticks per process, plus
  argv). The pass keeps the previous tick's tick map per card (memory
  only; a restart re-checks once). A descendant pid — never the omp pid
  itself, whose own event loop ticks a few dozen times a minute — whose
  tick delta since the previous probe is `>= BUSY_MIN_TICKS` (5 ticks =
  50 ms) marks a busy child: not a suspect. First probe (no baseline),
  dead run pid, or an unreachable worker: not a suspect, no action.

A card that passes all three is a **suspect**.

## Diagnosis (read-only)

**Session identity.** The run's own session id is known mid-run: the
runner parses it from the run's event stream and `dispatchSessionEntry`
writes it onto the task row (`task.sessionId`) while the run is live.
The probe selects that session file and no other — `sessionFile(dir,
sessionId)` on the server for a local run, the same name pattern under
the run's data dir on the worker. A card whose session id is not yet
known reports `sessionAt: null` (never a suspect on a guessed file).

- `lastTool`: the last `tool_execution_start` in **the run's own session
  file** (bounded tail read, at most 64 KiB): `{tool, command, timeout}`
  with `timeout` the raw number from the tool arguments (`0` = unbounded).
- `locks`: for every lock-candidate path (`.lock`) the command text
  names…
- `pidFiles`: for every pid-file path (`.pid`) the command names, the
  same fact shape — content parsed as `{"pid":N}` or a bare integer.
- `pids`: for every inline pid reference in the command (`--pid N`,
  `kill -0 N`, `kill N`), `{pid, alive}` on that host.
- `ports`: for every port reference (`--port N`, `nc -z host N`,
  `localhost:N`, `127.0.0.1:N`, `0.0.0.0:N`, `PORT=N`), `{port,
  listeners}` where listeners counts `LISTEN` entries for that port in
  the host's `/proc/net/tcp` and `/proc/net/tcp6`.

Candidate reads are bounded (at most 5 per kind, 1 KiB per file,
`O_NOFOLLOW`, regular files only) but **not** confined: the facts feed
the diagnosis and the ask, and the confinement decides only what a fix
may touch. A deletion or a signal is still confined at act time.

Session text and command text are untrusted data: they select which facts
to read, never what to execute.

Confinement (`lockPathAllowed`, string-level pre-check; the fix re-checks
with `realpath` at act time):

- the path is inside the card's own worktree (`worktree/` prefix), or
- the path is under a worker temp root (`/tmp`, `/var/tmp`) **and** one
  path segment carries the card number as a `-`-delimited token
  (`cardNumOf("OTTR-1191") = "1191"`; the segment `gate-1191` matches,
  `gate-11912` and `gate-1244` do not). This covers the OTTR-1191 scratch
  dir `/var/tmp/gate-1191/tmp/ott-stryker.lock`.

The shared worker-wide mutation lock `$(tmpdir)/ott-stryker.lock` is not
the card's own dir: it never auto-fixes. It lands in the ask path.

## Allowlist of automatic fixes

Each fix is steered first (the steer reaches the agent when the stuck
tool call ends — the fix ends it), then applied, then logged. The worker
side re-checks every precondition immediately before acting; a refused
fix changes nothing and the card goes to the ask path.

1. **Stale lock** — preconditions, all checked at act time on the host
   that owns the run: the path passes `realpath` confinement (inside the
   run's real worktree, or inside a temp root with the card-number
   segment); the file is a regular file; its content still parses to
   `{"pid":N}` with `N > 1`; pid `N` does not exist on that host. Then:
   steer, `unlink` the lock file, log
   `supervisor: removed stale lock <path> (pid <N> gone), steered`.
2. **Hung child** — the child is only ever killed with proof that its
   dependency can never clear. The diagnosis grants the kill only when
   the idle timeout-0 child waits on a **dead dependency inside the
   card's own trust domain**: a lock or pid file that passes
   `lockPathAllowed` and still names a pid dead on that host, an inline
   pid reference whose pid is dead on that host, or a port with zero
   listeners. An idle timeout-0 child without such proof — a plain
   sleep, a quiet network request — and any dead dependency outside the
   card's own dirs (another card's lock) never auto-kills: they file the
   ask, and the kill happens only on the owner's Apply-the-fix answer
   through the same re-validated path. Act-time preconditions, all
   re-checked immediately before the signal: the pid is a descendant of
   the run's omp pid in a fresh `/proc` ppid walk; it is not the omp pid
   and not the daemon pid; the session's last tool call is still the
   diagnosed call (`timeout 0`, same normalized command) — the agent has
   not moved on; the child's current argv still matches that command;
   the child gained `< BUSY_MIN_TICKS` ticks since the probe (it has not
   resumed); and the diagnosed dependency is still dead (the file still
   names the same dead pid, the inline pid is still dead, the port still
   has no listener). Then: steer, `SIGTERM` that child only, log
   `supervisor: stopped hung child <pid> (<command>), steered`.

The stale-lock fix re-checks one more fact at act time: the session's
last tool call still names the lock path (the turn still waits on it).

A refused fix logs `supervisor: stale fix refused (<reason>)` and files
the ask.

### Steer delivery

`pendingPrompt` is delivered with the card's next dispatched turn
(`settleSteered`): a steer queued mid-run reaches the agent after the
current run ends, and the queue holds a premature settle from landing —
a partial ready report is never accepted while the steer waits. The
current run's remaining steps may still act on the stuck call's partial
output; the steer text says so honestly (it arrives with the next turn).
A channel that injects into a live run would be new extension prompt
text — a hard stop that needs owner approval before it is built.

### Steer wording (draft; agent-facing prompt text)

The steer is queued as supervisor text on the running card
(`pendingPrompt`, `pendingBy: "supervisor"`):

```
Supervisor: your last tool call was waiting on state that could not
change, and the supervisor applied a fix. This note rides your next
turn.
<facts>
Do not trust partial results from that call. Re-run the step in the
foreground with a bounded timeout, and do not start watcher loops with
timeout 0.
```

Facts for a stale lock:
`The lock file <path> named pid <N>, and that pid is dead on the worker.
The lock could never clear. The supervisor is removing the lock file now.`

Facts for a hung child:
`The child process <pid> (<command>) belongs to that tool call and has
sat idle for the whole check window. The supervisor is stopping that
child so the tool call can end.`

These drafts are prompt text. AGENTS.md makes new agent-facing wording a
hard stop: this spec holds the drafts for approval before any of it moves
into `src/prompts.ts`. The implementation keeps the wording in
`src/staleTurn.ts` next to the existing supervisor-owned prompts
(`prFeedbackPrompt`, `dependabotPrompt` in `src/supervisor.ts`).

## Unsure -> ask

A suspect that matches no allowlist rule with all preconditions true parks
the card `needs_you`:

- `needsReason` starts with the marker `Stuck turn:` (recognised by the
  reply route) and carries the diagnosis (idle minutes, no busy child,
  last tool call, what was checked and what failed) and the proposed fix
  when one exists.
- `asked` carries one question with three options:
  `Apply the fix`, `Stop the turn and restart`, `Wait`. The drawer's ask
  panel sends `For "<question>": <answer>`.
- A log line `supervisor: turn idle <n> min without progress, ask filed`
  records the park.

The ask re-files at most once per `STALE_REASK_MS` (4 h, memory) per card
while the situation persists.

### Reply handling (process still alive)

The reply route intercepts replies on a card whose reason carries the
`Stuck turn:` marker **and** whose run entry is still live:

- `Apply the fix`: queue the generic approval steer (`STALE_FIX_PENDING_STEER`
  in `src/staleTurn.ts` — the responder holds no probe, so it cannot build
  the specific text), return the row to `state: "running"`, clear the ask,
  and log `supervisor: stale fix approved by owner, applying`. The
  supervisor's stale pass processes this approval **before the idle-log
  gate** (the approval's own log line resets the log age): it matches the
  exact `STALE_FIX_PENDING_STEER` text on a running card, re-diagnoses at
  once, performs the allowlisted fix, appends the specific
  `staleSteerText(fix)` with the concrete facts, and logs the action. If
  the fix is refused, the ask is filed again with the refusal reason.
- `Stop the turn and restart`: stop the turn through the loop's stop
  path, then queue the resume (`"."` supervisor reply) so a fresh turn
  continues on the same session.
- `Wait`: clear the ask and the reason and return the row to
  `state: "running"`. The pass's log gate resets the tick baseline but
  keeps a pending ask cooldown; when a suspect re-qualifies and the row
  shows the ask cleared (running, no `asked`, no `needsReason`, no
  queued prompt) beside a live cooldown entry, that is the Wait answer:
  the pass refreshes the cooldown from now (`STALE_REASK_MS`) and stays
  quiet. The ask re-files at most once per `STALE_REASK_MS` (4 h,
  memory) per card while the situation persists.
- Any other reply while the process is alive is refused (409) with the
  three options; no row change. When the process is no longer live, the
  ask is cleared and the reply takes the normal path (a plain resume).

The supervisor never deletes files outside the card's own dirs, never
kills a process that is not in the turn's tree, and never kills the omp
process on its own. "Stop the turn and restart" runs only on the owner's
answer, through the same stop path the card's Stop button uses.

## Acceptance (tests that fail before the fix)

1. OTTR-1191 sequence: fixture turn whose last tool call loops on a lock
   file naming a dead pid; after the threshold the supervisor steers,
   removes the lock, logs the action, and the loop ends.
2. Same fixture with a live pid in the lock: no action.
3. A lock outside the card's own dirs, or a suspect matching no rule:
   needs_you ask with the diagnosis, no file or process change.
4. A turn with a busy child at high CPU and a quiet log: not a suspect.
5. Injection: session command text naming another card's lock or a path
   outside the card's dirs never leads to a deletion.

## Non-goals

- No change to how turns start; no change to the checks' 30 min `maxTime`
  rule or the 2 h card warning.
- No handling for a running card with no process at all (OTTR-1216).
- No automatic action on other cards' files or processes; no killing of
  the omp process; no deletion outside the card's own dirs.
- No new wording in `src/prompts.ts` without owner approval (drafts live
  in this spec; implementation keeps them in `src/staleTurn.ts`).

## Detailed Implementation Plan

- `src/staleTurn.ts` (new): constants, `ProcSample`/`StaleProbe`/
  `LockFact`/`LastTool` types, `busyDescendant`, `tickMap`,
  `parseLockPid`, `cardNumOf`, `lockPathAllowed`, `extractLockPaths`,
  `lastToolCall` (JSONL parse over untrusted text), `diagnoseStale`
  (pure verdict: `stale-lock` / `hung-child` / `unsure`), steer and ask
  wording, `isStaleAskReason`, `staleAnswerKind` (parses the drawer wire
  line `For "<question>": <answer>` or a bare option).
- `src/workers.ts`: the daemon stores the run's data dir at spawn;
  `POST /runprobe` (token) returns `{pid, alive, procs, sessionAt,
  lastTool, locks}` for one run id (test seams: proc root, session dir,
  lock reader); `POST /stalefix` (token) applies `unlock` or `kill` with
  the act-time preconditions above. Clients `probeRun`/`staleFix` with
  exact method and URL covered by tests against a real `serveWorker`.
- `src/supervisor.ts`: `SupervisorOps` gains optional `liveRun`,
  `probeStale`, `staleFix` (absent = pass skips, existing test fakes stay
  valid); `staleTurnPass` runs per running card inside `projectPasses`;
  memory maps hold per-card tick baselines and ask cooldowns.
- `src/server.ts`: wires the three ops — `liveRun` from the loop's
  running entry; `probeStale`/`staleFix` dispatch to the worker client
  for worker runs and to local `/proc` + filesystem implementations
  (same `staleTurn.ts` helpers) for server-local runs.
- `src/app.ts`: the reply-route responder and refusal described above.

## Risks

- A worker probe or fix endpoint is new attack surface: both endpoints
  require the worker token, act only on the daemon's own run entries, and
  the fix re-derives confinement from `realpath` at act time — a path the
  session text planted cannot widen either set. Endpoints return refusal
  reasons instead of generic errors so the supervisor's ask carries facts.
- A steer queued on a card whose fix then gets refused leaves the steer
  in place; the steer's text is true either way (the state was stale) and
  the ask tells the owner what happened.
- The scratch-dir rule keys on the card number inside a path segment. A
  card that creates `/tmp/gate-<own number>-shared/` scratch it shares
  with another card's lock could in theory match; the pid must still be
  dead on that host before anything is deleted, and the lock must still
  name that pid at act time.
