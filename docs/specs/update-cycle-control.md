# Update cycle control

## Scope and assumptions

OTTR-752 adds a host control path for the existing source-based Compose deployment.
The user approved host control and a complete update cycle when the board is idle.
The action fetches commits, builds the image, and uses the existing safe deployment flow.
It does not only restart an image.

The host owns the schedule. The board cannot infer a cron or Task Scheduler time.
A new persistent host command owns an hourly schedule and reports its actual next cycle.
The existing one-shot `scripts/update-image.ts` command stays available.
Hosts must enable the persistent command to obtain the countdown and immediate action.

## Contract

### Shared state

`src/updateCycle.ts` defines the protocol and its validation.
`StateResponse.updateCycle` is optional for older frames and null without a live host controller.
A live view has these fields:

- `nextCycleAt`: the host's next scheduled cycle, as integer epoch milliseconds.
- `phase`: `idle`, `requested`, or `running`.
- `canStart`: true only when the host is idle and no turn runs or prepares in any project.
- `error`: a bounded, redacted failure message, or null.

The bell uses the existing board clock. It never derives a schedule from the browser clock or the last commit.
An overdue cycle shows a due state, not a negative duration.
A stale controller gives no countdown and no immediate action.

### Board routes

`POST /api/update` requests the complete cycle through the existing API guards.
The request has no command, path, arguments, or URL.
A busy board, an absent controller, or a cycle already in progress returns a conflict.
The handler checks the live turn counts and all project task states.
An unreadable idle state refuses the request.
The idle check and request assignment form one synchronous operation.
The accepted request blocks new turns on all runners, including local board checks.
It does not replace or clear an existing drain.

`POST /api/update/host` accepts host heartbeats through the existing API guards.
Only direct loopback inside the server may use this route.
Public hosts, forwarded requests, worker tokens, and remote sessions cannot register a controller.
The host uses `docker compose exec -T server bun -e` and the existing loopback Origin pattern.
The board never accepts shell commands from this route.

Heartbeat fields:

- `controller`: an opaque instance id.
- `nextCycleAt`: the next scheduled cycle.
- `phase`: `idle` or `running`.
- `requestId`: the manual request id during that cycle, else null.
- `error`: a bounded failure message, else null.
- `available`: a valid `{ behind, commits }` result from real host git reads, else null.

The response returns `requestId` and `runningCommit`.
The board keeps a pending id until the host acknowledges it with a running heartbeat.
Repeated heartbeats cannot create a second request.
A pending manual request takes precedence over a scheduled cycle.
A running heartbeat with a null id receives the pending id but does not acknowledge it.
The host must acknowledge that id before it starts the cycle.
A different controller cannot replace a live controller.
The lease lasts 45 seconds. Heartbeats renew it every 5 seconds.
A stale lease releases only the manual request's hold.
After a server restart, a running heartbeat restores the same request and its hold.
An idle heartbeat after a completed cycle clears that request and its hold.

The host can report pending commits for a container without a git checkout.
The board supplies its recorded build commit, or a valid commit version when no record exists.
The host fetches `origin/main` and counts commits after that running commit.
Commit subjects remain bounded plain text.
The existing `/api/update` and update WebSocket frame retain their shapes.
Their pending commit values use a live host result when one exists.

### Host command

`scripts/update-host.ts` owns the hourly schedule and polls the board every 5 seconds.
Its first scheduled cycle starts one hour after the command starts.
A manual cycle does not move the hourly schedule.
A long cycle advances the next time to the first future hourly slot.
No cycles overlap. Missed slots do not create a queue of cycles.

The host takes an exclusive local lock per checkout before any deployment.
The lock uses the existing SQLite lock helper and a file outside the checkout.
A duplicate controller exits with an error. It never replaces another process.
After a host restart, the command allows one lease period for the previous board lease to expire.
It keeps the local lock during that wait and never starts a cycle after a conflict.
A renewed conflicting lease still makes the new command exit.
The command passes the operator's Compose arguments as an argument array.
It spawns the current one-shot updater for each cycle, so a later cycle uses new source code.
The controller starts no new network listener and stores no credential.
It continues heartbeats while the updater runs.
The manual cycle starts only after the board acknowledges its running state.
Scheduled cycles retain the existing updater's safety rules and can recover a stopped board.
If a scheduled fallback already runs when the host receives a pending manual id, it adopts that id for the current cycle.
It acknowledges the id and does not start a second cycle for that request.
A child exit does not complete the controller cycle.
The host retains the cycle until the board accepts an idle heartbeat.
If a scheduled slot follows the child exit, the host completes that handshake before it starts the due cycle.
The wait for that handshake does not consume a due slot.
A failed cycle appears as a failure, not a success.

## Bell behavior

The new-version notice shows the time until the next cycle when host control is live.
The short action is `Update`, in the existing secondary button style.
It starts the complete update cycle only when `canStart` is true.
A busy board shows why the action is unavailable.
A requested or running cycle shows its state and prevents a duplicate action.
A failed request shows an error beside the action.
The control also appears with the deferred-restart notice when no new-version row exists.
It does not add a second notification entry or change acknowledgement keys.
Hosted mode keeps host notices hidden.
Without host control, the existing manual instructions remain.

## Acceptance checks

- A real host git fixture supplies the pending commit count and subjects.
- The host transport exercises its real Docker command reader against a local fixture.
- A manual request starts exactly one full cycle before its scheduled time.
- A manual cycle leaves the next hourly slot unchanged.
- A busy or preparing turn prevents a manual request.
- A request prevents a queued local or worker turn from starting.
- A repeated poll or a lost response cannot run the same manual request twice.
- Lease expiry, completion, and server recovery preserve the hold rules.
- Remote callers and cross-origin requests cannot control the host protocol.
- Invalid heartbeat input cannot mutate controller state. Add fixed-seed properties.
- The bell shows the countdown, busy state, cycle state, and request error.
- Desktop and phone views keep the action reachable in both themes.
- Run `bun run check`, then `bun test`. Save the full test output outside the checkout.
- Run the Impeccable detector, the blind visual check, and `bun run readme-screenshot`.
- Commit only the task branch. Do not deploy, merge, push, or run mutation tests.

## Non-goals

- No Docker socket in the board.
- No public host control service or new credential path.
- No forced restart, cancelled turn, or process termination.
- No change to the existing rolling deployment safety rules.
- No change to release-image updates, the omp pin, or upstream skill updates.
- No automatic host service installation or modification of a live scheduler.
- No tracker database migration.
