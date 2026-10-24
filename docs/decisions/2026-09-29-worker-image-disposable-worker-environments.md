# Worker image: disposable worker environments for agent turns, server-side git (2026-09-29)

**Decision:** Work turns (stages `todo` and `in_progress`) run one omp process inside a disposable
worker environment — a container built from a versioned image — instead of a process spawned on the
server host. Everything git stays server-side: worktree create/remove, the merge turn, the release
fast-forward, `git push origin main`. The worker is an execution shell for exactly the command the
server already runs today (`startRun` → `spawn("omp", buildOmpArgs(...), { cwd: worktree })`);
it owns no state and leaves nothing behind.

## D1 — Two-layer image: baked deterministic, mounted stateful

**Baked into the image (deterministic, changes only by image rebuild):**

- `omp` at a pinned version, the plugins it loads, `bun` and `git` at pinned versions.
- Global agent rules (`~/.omp/agent/rules`, generated from the `agent-rules` repo) and managed
  skills. These change deliberately; a bump is a new image tag, so a turn's toolchain is a property
  of the image, not of the machine it happens to land on.

**Mounted at run time (stateful, never baked):**

- Credentials: LLM provider auth, git pull credentials for private remotes. Secrets in layers leak
  on every `docker save`/registry pull; mounts keep them out of the image entirely.
- `HOME` (user-level omp state) and the project tree: the main checkout with `.tasks/` (DB,
  `sessions/`, `logs/`, `images/`, handoffs) and `.worktrees/`.

Why the split: a turn must be reproducible from (image tag, mounted state). Today the toolchain
drifts with the host — a Stryker score or a `bun run check` failure can depend on which machine ran
the turn. Baking the deterministic layer makes that a build error to fix, not a mystery. Mounting
the stateful layer means a credential rotation or session write needs no rebuild.

**Agent layer moved out of the image (2026-10-09):** rules, config, skills and plugins no longer
bake at build time. alate keeps the data repo snapshot in its database and provisions the files
into the shared home volume, so the agent layer has one source and the build needs no GitHub
token. A turn is now reproducible from (image tag, alate snapshot, mounted state). The image still
pins omp, bun, git and rtk. Task data moved out of the checkouts on the same day: it lives on the
`ottr-data` volume (`OTTR_DATA_DIR`), the checkouts keep only code and `.worktrees/`.

**RTK coverage gap (noted 2026-10-05):** the image bakes the `rtk` binary (pinned 0.43.0) so the
pix-optimizer bash rewrite is active. That rewrite matches a **hardcoded** command list inside the
plugin (git, gh, cargo, npm, pnpm, docker, kubectl, ls, grep, bun, ...) — `pix-optimizer@1.2.0`
exposes no env or config hook for it, so the list is not extended here (no node_modules patches).
Covered by the built-in list: `bun` and plain `docker` (first-word match). Not rewritten: `bunx`,
`powershell`, and full-path `docker.exe` — the latter two are Windows-isms that do not exist in the
Linux worker; `bunx` runs raw. If `bunx` coverage ever matters, it belongs upstream in the plugin,
not in a fork.

## D2 — Repos at identical absolute paths on server and workers

The DB stores absolute paths: `Project.path` (`src/types.ts`), `Task.worktree`, `Task.branch`,
`Task.base`. `startRun` runs omp with `cwd: worktree` and passes attachments as absolute
`@<path>` arguments; `sessionDir` is `<project>/.tasks/sessions`; log path is absolute. `git
worktree` links also embed absolute paths (the worktree's `.git` file points into the main
checkout).

Decision: every worker mounts the project tree (and the tracker installation, so `EXTENSION`
resolves) at the same absolute path the server uses. No path translation layer, no relative-path
migration of the DB.

Why not relative paths: `toTask`/UI/`runner` all pass these strings around untouched; a rewrite
would touch store, runner, UI and every `@path` attach for zero behavior gain. Identical paths also
satisfy git's worktree links for free.

Consequence: the path scheme must exist inside the worker. Linux servers mount
`/workspace/ottr` at `/workspace/ottr` — trivial. The current Windows host (`C:\...` paths) cannot
bind-mount into a Linux container at the same path, so the milestone lands Linux-first; the Windows
host keeps the current local spawn until a topology with matching paths exists (see D5).
`runner.startRun` stays the local fallback and the reference implementation of the handoff.

## D3 — One worker per task, disposable per turn

At most one worker runs for a task at any time; a worker's lifetime is one turn. All turn state
already lives outside the process: session files in `.tasks/sessions` (resumed via
`resumePlan`/`--resume`), the DB row, the worktree, the capped log file (`LOG_CAP_BYTES`, 2 MiB).
Nothing lives in worker memory that the next turn needs, so a crashed or OOM-killed worker is
replaced by starting a new one — the same recovery path as a tracker restart today.

Why not one long-lived worker per task: it is a second thing to keep alive with no capability gain;
"disposable" is the feature. Why not several workers per task: turns of one task are sequential by
design, and two omp processes on one session dir race the session file. Task-level concurrency
comes from the scheduler (`maxParallel` work slots), so the worker count a host needs is
`maxParallel`, bounded and known.

## D4 — Worker handoff protocol shape

The protocol is the existing process boundary, made explicit; omp sees no difference.

- **Request** (server → worker): the argv `buildOmpArgs` already produces (`--mode json
  --session-dir … --extension … [--resume id] [--model m] [@image…]`), the cwd (the task's
  worktree), the stdin prompt, and the environment additions (provider keys).
- **Response** (worker → server): the stdout event stream verbatim, plus exit code and stderr
  tail. The server keeps all parsing: `applyEvent` extracts the session id and outcome,
  `classify` routes the next stage, the log file gets `renderEvent` output. `report_outcome`/`ask`
  come from the mounted `extension/tracker.ts`, unchanged.
- **Control**: `run` and `cancel` (forwarded kill — the DB already records the turn's pid today).
- **No inbound channel mid-run.** Steering never enters a running process today: `pendingPrompt`
  is read between pick and spawn and the leftover becomes the next turn's prompt. One-shot stdin,
  stream-out is the whole protocol.

Because the omp layer is byte-identical, a worker is a drop-in behind `startRun`: same call, remote
spawn instead of local.

## D5 — Topologies

**docker-compose (first target, one host):** the server and `maxParallel` worker services share one
bind mount (or named volume) holding the workspace root; identical paths hold by construction.
Workers are stateless replicas; the merge slot, DB and web UI stay in the server container. This
topology already delivers the milestone's benefits: pinned toolchain, clean turns, no agent
processes on the server host.

**Cross-machine (later):** workers on separate hosts require the same absolute path on every
machine, which requires a shared filesystem (NFS/SMB or a replicated mirror) mounted at the same
mount point everywhere. The server alone runs worktree admin (`git worktree add/remove`, gc,
merges); workers only execute turn processes against their own worktree. Git index locks are
per-worktree, but the shared object store makes concurrent gc a real risk: `git gc` stays
server-side, run between merges. `ponytail:` cross-machine adds a network FS to every git call's
latency; ship compose first and let a measured need justify the second topology.

## D6 — Why merge turns never move to workers

The merge turn mutates shared state no worker owns: the main checkout, the integration target, the
worktree deletion, and `git push origin main` — the integration atom the tracker verifies
(origin/main contains the branch head). Moving it would hand push credentials to every worker and
break the one serialization that already exists: `pickRunnable` grants exactly one merge slot per
project and holds merges while a release runs, because a merge landing during the release
fast-forward corrupts it. That guard is server logic over server state; a remote worker can only
weaken it. Work-tree creation also stays server-side for the same reason — the DB row and the
worktree must exist before a worker is born, and `unsavedWork`/kept-file resolution read and move
files in the main checkout.

Net effect: workers need provider keys and read access to the project tree. Push credentials never
leave the server.

## D7 — Agent memory (Mnemopi): one shared store, consolidation in the server container

**Amendment (2026-10-05):** the concurrency, scoping and consolidation verdicts below are
superseded **for the compose topology** by D8 (Hindsight) — compose runs hindsight for
every agent turn. D7 remains the verdict for direct local spawns outside compose — the
host tracker's local-spawn fallback and any non-compose run — where mnemopi stays the
default backend.

Agent memory needs nothing baked. The Mnemopi backend ships inside the omp binary
(`memory.backend: mnemopi` in the captured `config.yml`; there is no plugin package to
install), and the store it writes — `~/.omp/agent/memories/mnemopi/mnemopi.db`, SQLite in
WAL mode — lives under HOME, so it lands on the mounted home volume. Verified against the
built image: the alate user-layer seed carries `config.yml` (with the mnemopi keys) and
excludes `memories/` by design; a worker's first turn creates the store on the volume. The
proof is scripted and repeatable (one worker turn over the real HTTP handoff that retains a
fresh pass word and recalls the previous run's word):

```sh
docker compose exec -T server bun - < scripts/compose-memory-proof.ts
```

Retention writes synchronously to the store's `working_memory` during the turn; the
LLM-driven step that extracts `facts` (and the consolidation that folds working memory into
`consolidated_facts`) runs at session dispose and may lag or skip a turn — the proof asserts
the former and only displays the latter.

**Concurrency verdict: keep one store.** The server and all `maxParallel` workers mount the
same home volume, so every agent process writes one store — the same single store the
single-user host already has. SQLite WAL means readers never block and writers serialize
with bounded waits: the omp binary sets `PRAGMA busy_timeout` (100 ms, 3 s and 5 s variants
are in the bundle). Retains and consolidations are short transactions; a lost race shows up
as one failed tool call in a turn log, not as corruption (WAL is crash-safe). Revisit only
if turn logs show a streak of busy-timeout failures. The real boundary is cross-machine
(D5): WAL does not tolerate a network filesystem, so that topology must route store writes
through a single writer (a server-side memory API) before it can exist.

**Scoping policy: stays global.** Host config pins `mnemopi.scoping: global` — one store
across projects — because cross-project recall (an orchestrator recalling a sibling
session's fact) is the feature, and the machine is single-user. Containers inherit this
unchanged by sharing the home volume; no per-project scoping, no per-worker mount
reshuffling.

**Consolidation placement: server container, never the host, never an image concern.**
Consolidation is omp-internal: working-memory rows fold into `consolidated_facts`, a
session's working memory consolidates on session dispose, and long-lived sessions
consolidate while idle. Per-turn dispose consolidation therefore already runs in the right
place — the worker that ran the turn consolidates its own session into the shared store,
needing no machinery. Idle/periodic consolidation needs a long-lived omp process, and under
compose the only one is the server container (the host runs nothing in this topology;
today's host-side idle consolidation moves there). Worker images stay memory-free at bake:
the capture excludes the store, and bake-time image content never sees a memory.

## D8 — Worker fleet memory backend: Hindsight (2026-10-05)

**Decision:** compose turns run omp with `memory.backend: hindsight` against a
`hindsight` service in docker-compose.yml (`ghcr.io/vectorize-io/hindsight:latest`,
internal port 8888, never port-mapped; embedded Postgres persisted in the
`hindsight-data` volume). omp reads `HINDSIGHT_API_URL` and `HINDSIGHT_API_TOKEN` from the
environment, so the only config change is the backend line: the container entry script
switches `memory.backend` to `hindsight` exactly when `HINDSIGHT_API_URL` is set. Server
and worker containers both carry that env, and because they share the home volume — one
`config.yml` — the whole compose topology converges on hindsight: worker turns and
server-side merge turns alike. Mnemopi remains the default backend for direct spawns
outside compose (the host tracker's local-spawn fallback, any non-compose run). The LLM
extraction key (`HINDSIGHT_API_LLM_API_KEY`, provider `HINDSIGHT_API_LLM_PROVIDER`, with a
fallback to the stack's `OPENAI_API_KEY`) is injected at runtime through compose, never
baked (D1). The service requires bearer-token auth (`HINDSIGHT_API_TENANT_EXTENSION`
API-key tenant, `HINDSIGHT_API_TENANT_API_KEY`) and the token agents present is the same
`HINDSIGHT_API_TOKEN`.

1. **Concurrency is owned by the Hindsight server.** Worker omp stops writing SQLite
   entirely — every retain/recall is an API call the service serializes. The shared-SQLite
   question of D7 (one volume, WAL, busy_timeout) dissolves for the fleet, and with it the
   cross-machine blocker D7 named: clients only need HTTP reachability, so worker hosts no
   longer share a filesystem with the store.
2. **Scoping is hindsight's default per-project-tagged:** project writes land in the
   shared bank under their project's tags (observed: hindsight holds a single `omp` bank),
   and recall combines the project's tagged memories with the untagged global lane — a
   worker never sees another project's tagged memories, while cross-project recall still
   works through the global lane. No per-worker scoping configuration is needed. For
   mnemopi (local mode), its per-project scoping derives banks from the cwd and linked
   worktrees share the primary checkout's name, so no worker-specific scoping machinery
   exists there either (the host today pins `mnemopi.scoping: global`, per D7).
3. **Consolidation is Hindsight's synthesis/mental-models for the fleet:** extraction,
   consolidation and mental-model refresh run inside the service, off every omp process —
   the dispose-time extraction lag D7 observed for mnemopi becomes the service's internal
   concern. The host-side consolidation job stays only for local mnemopi mode, where D7's
   placement (dispose consolidation in the worker that ran the turn, idle consolidation in
   the server container) is unchanged.

Overlap with D7, kept: worker images stay memory-free at bake, workers stay stateless per
turn, and D7's WAL/busy_timeout analysis remains the mnemopi local-mode verdict. Superseded
by this section for compose workers: "keep one shared SQLite store" and "scoping stays
global". The compose memory proof (scripts/compose-memory-proof.ts) asserts whichever
artifact the active backend writes — the local store's working_memory in mnemopi mode, the
turn's session files in hindsight mode.

## Losing options (don't re-explore without a reason)

- **Relative paths in the DB** (see D2): wide rewrite, no behavior gain, still needs the worktree
  `.git` link solved.
- **Long-lived per-task workers**: more liveness code, zero capability; disposable-per-turn is
  simpler and crash-equivalent.
- **Baking credentials or sessions into the image**: secrets in layers and stale sessions; both
  belong on mounts.
- **Merge turns on workers**: breaks the merge-slot/release serialization and spreads push
  credentials (see D6).
- **Worker-pull job queues (worker fetches tasks from the DB):** workers would need DB access and
  duplicate scheduler rules; the server keeps dispatching, workers stay dumb executors.

## Consequences

- New: an image build (Dockerfile + pinned versions, CI-built and tagged), a worker-pool module
  behind `startRun`'s call shape (local spawn stays the fallback), a compose file, and a kill path
  that crosses the boundary.
- Unchanged: prompts, AGENTS.md pipeline, scheduler, store schema, UI, extension. Work turns cannot
  tell they are remote.
- Migration order: compose topology on Linux → identical-path proof on one project → worker pool
  behind a setting → Windows host follows only when a same-path topology exists for it.

## Planned files

`Dockerfile.worker`, `docker-compose.yml` (new), `src/runner.ts` (worker dispatch behind
`startRun`), `src/workers.ts` (new, protocol client), docs updated when the setting lands.
