# How Ottr works

Ottr (the omp task tracker) is a local kanban board for one user. The user types a task as a card. Ottr gives the card a git worktree, runs an omp coding agent in it, checks the result, and merges the work through a merge queue for each project. One Bun server (`src/server.ts`) holds the HTTP API, the SQLite stores, the scheduler, and the git work. The React board in the browser shows the cards. Agent turns run as local `omp` child processes, or in Docker workers that the server calls over HTTP.

## Architecture

```mermaid
flowchart LR
  ui["Board UI (React)"]
  app["HTTP API and WebSocket (createApp)"]
  push["Web Push"]
  server["Server bootstrap"]
  supervisor["Supervisor (every 60 s)"]
  turnLoop["Turn loop (createTurnLoop)"]
  scheduler["Queue policy (pickRunnable)"]
  projectStore[("Project store (tasks.db)")]
  globalStore[("Global store (tracker.db)")]
  runner["Run launcher (startRun)"]
  worker["Docker worker (POST /run)"]
  omp["omp agent (omp -p)"]
  ext["Tracker extension (report_outcome)"]
  git["Git and worktrees"]
  remote["Git remote (origin)"]

  ui -->|"HTTP /api/..."| app
  app -->|"board frames over /api/ws"| ui
  app -->|"reads subscriptions"| globalStore
  app -->|"needs you and done alerts"| push
  server -->|"opens"| projectStore
  server -->|"opens"| globalStore
  server -->|"starts, ticks every 5 s"| turnLoop
  server -->|"serves routes of"| app
  server -->|"calls tick"| supervisor
  app -->|"creates tasks, user actions"| projectStore
  app -->|"schedule()"| turnLoop
  turnLoop -->|"queued tasks"| scheduler
  turnLoop -->|"task and turn rows"| projectStore
  turnLoop -->|"worktree add, merge proof"| git
  turnLoop -->|"prompt, worktree, model"| runner
  runner -->|"spawn omp"| omp
  runner -->|"HTTP POST /run"| worker
  worker -->|"spawn omp"| omp
  omp -->|"loads"| ext
  ext -->|"outcome in JSON event stream"| runner
  git -->|"push with server credentials"| remote
  supervisor -->|"CI checks, cleanup, reclassify"| projectStore
```

- **Board UI (React)** — `src/ui/app.tsx`, live updates in `src/ui/socket.ts` (`connectLive` uses `/api/ws`, `connectPolling` reads `/api/state` every 5 s in production)
- **HTTP API and WebSocket (createApp)** — `src/app.ts` (`createApp`), request checks in `src/requestGuards.ts`, login in `src/auth.ts`
- **Web Push** — `src/webpush.ts`
- **Server bootstrap** — `src/server.ts` (`Bun.serve`, project discovery, timers)
- **Supervisor (every 60 s)** — `src/supervisor.ts` (`tick`: worktree cleanup, CI watch, Dependabot cards, `reclassifyPass`, `hygienePass`)
- **Turn loop (createTurnLoop)** — `src/turn.ts` (`schedule`, `runTurn`, `cancel`, `stopTurn`, `settleLostTurn`)
- **Queue policy (pickRunnable)** — `src/scheduler.ts` (`pickRunnable`, `mergeHold`, `parseWorkCheck`)
- **Project store (tasks.db)** — `src/store.ts` (`ProjectStore.open`). One `tasks.db` for each project in `<project>/.tasks/`, or under `OTTR_SERVER_DATA_DIR`. Tables: `settings`, `tasks`, `turns`, `events`, `fork_branch`, `fork_runs`, `pr_review`, `pr_review_runs`, `learnings`.
- **Global store (tracker.db)** — `src/globalStore.ts` (`GlobalStore.open`, table `kv` in `.tasks/tracker.db`)
- **Run launcher (startRun)** — `src/runner.ts` (`startRun`, `buildOmpArgs`, `createRunSink`, `applyEvent`, `classify`, `workerFromEnv`)
- **Docker worker (POST /run)** — `src/workers.ts` (`serveWorker`, `runWorker`), entry point `src/worker.ts`, stack in `docker-compose.yml` and `Dockerfile.worker`, guide in `docs/WORKERS.md`
- **omp agent (omp -p)** — the external `omp` CLI. Prompts come from `src/prompts.ts` (`workPrompt`, `mergePrompt`, `workCheckPrompt`). Transcripts are read by `src/session.ts`.
- **Tracker extension (report_outcome)** — `extension/tracker.ts` (`pi.registerTool({ name: "report_outcome" })`)
- **Git and worktrees** — `src/worktree.ts` (`resolveTarget`, `createWorktree`, `isClean`, `serverMergePush`), host credentials in `src/gitHosts.ts`
- **Git remote (origin)** — the project's upstream repository. Only the server pushes to it (`serverMergePush`).

## A task from card to merge

```mermaid
sequenceDiagram
  actor user as User
  participant ui as Board UI
  participant app as HTTP API
  participant store as Project store
  participant turnLoop as Turn loop
  participant git as Git and worktrees
  participant runner as Run launcher
  participant agent as omp agent

  user->>ui: New task, type the prompt
  ui->>app: POST /api/projects/{project}/tasks
  app->>store: createTask (todo, queued)
  app->>turnLoop: schedule()
  turnLoop->>turnLoop: pickRunnable selects the card
  turnLoop->>store: claim card (preparing)
  turnLoop->>git: createWorktree .worktrees/{id} on ott/{id}-{slug}
  turnLoop->>runner: startRun(workPrompt)
  runner->>agent: omp -p (local child or worker POST /run)
  agent-->>runner: session starts
  runner-->>turnLoop: onSession
  turnLoop->>store: in_progress, running
  agent->>agent: plan, edit, run checks, commit
  agent-->>runner: report_outcome ready (JSON event)
  runner-->>turnLoop: RunResult.outcome
  turnLoop->>git: commitsAhead, isClean
  turnLoop->>runner: startRun(workCheckPrompt), read-only check
  runner-->>turnLoop: verdict (parseWorkCheck)
  turnLoop->>store: classify gives merging, queued
  turnLoop->>turnLoop: pickRunnable selects one merge for the project
  turnLoop->>runner: startRun(mergePrompt), merge turn
  runner->>agent: omp -p in the same worktree
  agent->>git: rebase, run checks, git merge --ff-only
  agent-->>runner: report_outcome integrated
  turnLoop->>git: serverMergePush (proof, then push to origin)
  turnLoop->>store: done, idle (done_at)
  app-->>ui: board frame over /api/ws, or the next /api/state poll
```

- **User**, **Board UI** — `src/ui/app.tsx` (`NewTaskDialog`, `ComposeDialog`, `post`)
- **HTTP API** — `src/app.ts` (route `POST /api/projects/<project>/tasks` in `createApp`)
- **Project store** — `src/store.ts` (`createTask`, `updateTask`)
- **Turn loop** — `src/turn.ts` (`schedule`, `runTurn`) with `src/scheduler.ts` (`pickRunnable`, `parseWorkCheck`)
- **Git and worktrees** — `src/worktree.ts` (`createWorktree`, `isClean`, `serverMergePush`)
- **Run launcher** — `src/runner.ts` (`startRun`, `applyEvent`, `classify`), prompts in `src/prompts.ts`
- **omp agent** — the `omp` CLI with `extension/tracker.ts`, rules from the project's `AGENTS.md`

Notes:

- The work check runs inside the same `runTurn`, with a fresh session and only `read,grep,glob`. A blocker sends the card back to the agent. After two send-backs, the card asks the user: **Send it back** or **Merge anyway** (`src/turn.ts`). The reply route does the chosen action (`src/app.ts`). Other reply text goes to the agent.
- Merge turns run local, never on a worker. The agent does not push. `serverMergePush` pushes with the server's git credentials (`src/worktree.ts`).
- A `ready` report needs commits ahead of the base and a clean worktree. An `integrated` report needs the branch head on the upstream branch. Otherwise `classify` parks the card at `needs_you` (`src/runner.ts`).

## Life cycle

A task has two fields. `stage` is the board column. `state` is the run state inside that column. Both are in `src/types.ts` and in the `CHECK` constraints of the `tasks` table in `src/store.ts`.

### Stage

```mermaid
stateDiagram-v2
  [*] --> todo: createTask
  [*] --> backlog: createTask with backlog
  backlog --> todo: POST /backlog (promote)
  todo --> backlog: POST /backlog (park)
  todo --> in_progress: work session starts
  in_progress --> in_progress: work check blocker, user reply
  in_progress --> merging: ready with commits ahead
  in_progress --> done: answered or integrated
  merging --> merging: merge needs_you, open review findings
  merging --> done: integrated with git proof
  merging --> in_progress: failed release publish
  done --> [*]
```

- **todo**, **in_progress**, **merging**, **done**, **backlog** — `Stage` in `src/types.ts`
- `createTask` — `src/store.ts`
- `POST /backlog` — `src/app.ts`
- Work session starts — `runTurn` `onSession` in `src/turn.ts`
- Report checks (`ready`, `answered`, `integrated`) — `classify` in `src/runner.ts`
- Work check blockers — `runTurn` in `src/turn.ts`
- Open review findings and failed release publish — `runTurn` and `settleReviews` in `src/turn.ts`

### Run state

```mermaid
stateDiagram-v2
  [*] --> queued: createTask
  queued --> preparing: pickRunnable, runTurn claims the card
  preparing --> running: omp session starts
  preparing --> needs_you: stopBeforeRun
  running --> queued: next stage, retry, lost turn
  running --> needs_you: needs_you report, failed proof, stopTurn
  running --> idle: done, or review waits for findings
  needs_you --> queued: user reply, restart session, auto-tend
  needs_you --> idle: finishKept, hygienePass
  queued --> idle: cancel
  running --> idle: cancel
  needs_you --> idle: cancel
  idle --> queued: grill or promote a backlog card
```

- **queued**, **preparing**, **running**, **needs_you**, **idle** — `RunState` in `src/types.ts`
- `pickRunnable` — `src/scheduler.ts`. `runTurn`, `stopBeforeRun`, `stopTurn`, `cancel`, `finishKept`, `settleLostTurn` — `src/turn.ts`
- Next stage and retries — `classify` in `src/runner.ts`
- User reply, restart session, grill, promote — `POST /reply`, `POST /restart-session`, `POST /grill`, `POST /backlog` in `src/app.ts`
- Auto-tend, `hygienePass`, `reclassifyPass` — `src/supervisor.ts`
- `needs_you` shows as the `!` badge on the card — `src/ui/status.ts`
