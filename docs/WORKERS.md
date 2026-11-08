# Workers

Work turns run inside disposable containers built from `Dockerfile.worker`
omp, bun, node, git, git-lfs, gh, procps (`ps`), curl, rtk, ripwire, Chrome for Testing and
the language servers for omp's `lsp` tool (TypeScript 7's `tsc`, typescript-language-server, pyright)
are pinned at build time, so a turn's toolchain is a property of the image, not the host.
Chrome sits at `/opt/google/chrome/chrome`, where the agent layer's chrome-devtools MCP
server looks for it. Tools a project pins beyond the image (e.g. Godot) come from the data
repo at runtime (see "System packages per project" below). The agent layer (rules,
config, skills, plugins) is not in the image: alate
provisions it from its data repo snapshot into the shared home volume (`/root`) as
layers under `/root/.alate` ([The agent layers](#the-agent-layers)), and runs
chrome-devtools there headless, isolated and without Chrome's sandbox (workers run as
root). Skill folders are statically scanned for prompt injection, exfiltration,
credential harvesting, and supply-chain risk (NVIDIA SkillSpector, static mode) before
Alate provisions them from your data repo. Release reviews need the `security-audit` and `ui-ux-check` skills of this layer. On a runner without
a skill, the review stops with needs_you. curl serves the impeccable skill of this layer:
its launcher downloads the engine that a skill update needs. Every Node process preloads
`src/stryker-tap.cjs` (`NODE_OPTIONS`): in a `stryker run`, it copies the output to
`/tmp/ottr-stryker-<pid>.log`, so the running card shows the progress of a mutation run
even when the agent's command sends the output into a pipe (rtk). The build needs no credentials:

```sh
docker compose build
docker compose up -d
```

The board also provisions on its own: every 5 minutes it reads the alate server's
`GET /health`, and when the server reports an unprovisioned import (`pending`), it calls
the same provisioning API as **Settings → Alate → Provision**. When the server reports
agent-layer support (`layers: true`), the install lands in a new layer and the switch is
one atomic rename, so the tick provisions while turns run
(docs/specs/agent-layer-switch.md). On an older alate without that flag, the install
writes the flat home, so the tick keeps the old gate and waits until no turn is preparing
or running. A failed attempt waits an hour before it tries
again; the error shows in the Alate settings section.

At run time git authenticates with the board's GitHub token (asked for at
onboarding, replaced under **Settings → Git hosts → GitHub token**): the server exports it as
`GH_TOKEN`, and the image's git credential helper hands it to git for
github.com remotes.

The UI is port-mapped to the host on the same port the tracker listens on
(`OTTR_PORT`, default 8080), so the tracker's host and Origin allowlists —
which accept its own port — accept it. The mapping binds `127.0.0.1` only:
the allowlists read the Host header, which any client on the LAN can fake.
Unlike desktop loopback, the board asks for the admin login (or the API key)
there: the published port arrives from the Docker gateway, not loopback, and
worker turns reach it too (`host.docker.internal`). Only processes in the
board's own container (merge turns, `docker compose exec server ...`) keep
zero-auth access.

Each container keeps at most 30 MB of logs: the `local` log driver keeps 3 files of 10 MB.
Each container also has a RAM limit. The default is `8g` for the server and for each
worker, and `4g` for the `board-seed` one-off. The values are estimates. Measure the peak
with `docker stats` under load, then set about 2x the peak in the compose env file:
`OTTR_SERVER_MEM_LIMIT`, `OTTR_WORKER_MEM_LIMIT`, and `OTTR_SEED_MEM_LIMIT`. When a container gets to its limit,
the kernel stops a process in that container (OOM kill), not a process on the whole host.
The board's **System** view (`/system`) shows each container's CPU, memory against its limit,
memory limit hits and OOM kills from its own cgroup (workers report theirs on `GET /stats`),
plus the Docker VM's CPU, load and free memory, over the last hour. `GET /stats` also lists the
memory (sum of Pss) and CPU time of each live turn's process tree, so the view shows which turn
uses the container.

## Updates

omp is the main tool and gets a new release almost every day, so the image follows the
newest omp that is 7 or more days old: workers run about one week behind npm, so a
broken or yanked release has a week to surface before it ships. The server and the
workers run this one image, so the board, merge
turns and work turns all get the new omp. Two parts do the work:

1. The workflow `.github/workflows/omp-bump.yml` runs every 6 hours on GitHub. When npm
   has an omp that is 7 or more days old and newer than `OMP_VERSION` in
   `Dockerfile.worker`, it starts that omp on
   the image's bun, then pushes `chore: bump omp to <version>` to `main`. It pushes
   over SSH with a write deploy key (Actions secret `OMP_BUMP_DEPLOY_KEY`), because
   the ruleset on `main` lets only admins and deploy keys bypass it. It is the
   only place that moves the pin. The pin sits above the omp layer, near the end of
   the file, so a bump rebuilds only the last layers.
2. Each host that runs the stack deploys `main` with `scripts/update-image.ts`, from
   a clean `main` checkout — this rolling flow serves only that deployment. A
   deployment that runs a published release image (`OTTR_IMAGE=ghcr.io/ottr-ai/ottr:<tag>`,
   README quick start) updates by moving its image tag: the script never runs
   there (`scripts/` is not copied into the image), so it needs no per-runner
   drain and no part of this flow. It fast-forwards `main` and builds the image, then it
   rolls the stack one runner at a time. A runner is a worker (its hostname, the
   compose service name) or the server itself (`local`). It stops when the
   checkout has uncommitted changes or commits that origin lacks, when
   `docker compose ps` fails, or when it cannot compare the server's image with
   the build. A worker whose image cannot be compared is skipped with one log
   line. It never pushes: a host needs read access to the repo only. The last
   step prunes the worker images no container runs, so even a run that leaves a
   worker stuck never takes the image that its container runs.

   Workers roll first, one at a time, in `compose ps` order, and only a worker whose
   image changed:

   - The script holds that one worker's new turns (`POST /api/drain` with
     `runner`). The worker finishes its running turns while every other worker and
     the server keep working, and no hold shows in the **Notices**.
   - The script polls every 30 s until that worker runs no turn and nothing is
     preparing. A hold lasts at most 1 hour. If the worker still runs a turn then,
     the script ends its hold (`DELETE /api/drain?runner=`), the worker stays on
     the old image, and a later run tries again. The roll goes on with the next
     worker, and the run exits 0. The roll also waits for detached runs a
     previous server restart left on that worker (the board cannot see them); a
     worker that answers no `/detached` route reads as having none.
   - When the worker is idle, the script recreates only its container
     (`up -d --no-deps --wait <service>`). The worker's compose healthcheck probes
     its own `GET /healthz`, so the `--wait` fails when the new container never
     turns healthy. A failed recreate stops the roll at once (exit 1): the workers
     that did not roll yet stay on the old image, and the server does not restart.
   - Healthy is not connected: the script then waits, from the server, until it
     reaches the worker's `/healthz` again (at most 5 minutes). A failure here
     stops the roll like a failed health check.
   - Connected: the script releases the worker's hold, and the next worker rolls.
     A worker hostname that no runner lists (not in `OTTR_WORKER_URLS`, so no turn
     can reach it) recreates without a hold and without the turns wait.

   The server rolls last, only when no worker is stuck, and with no board-wide
   hold: the workers hold per runner for the seconds of the restart window, and
   a busy worker keeps its turn alive by detaching it, so worker turns survive
   the restart:

   - When the server's image changed or a fresh seed waits, the script holds
     `local` (`POST /api/drain` with `runner: local`). The server's own turns
     (merge turns, retro, the board check, the release publish) are children of
     the server process and cannot survive the restart, so they finish first,
     while work turns on the workers keep starting and running. The script polls
     every 30 s and renews the hold each time. The hold lasts at most 1 hour; if
     a local turn still runs then, the script ends the holds (DELETE
     `?runner=` for `local` and every worker), so the queued cards start, and a
     later run tries the restart again. If the board refuses a renewal, the
     script stops waiting the same way. While it waits, the scheduled task
     starts no second run (`-MultipleInstances IgnoreNew` below), so the
     restart uses the image that this run built, and a later run deploys newer
     commits.
   - The script then holds every worker runner. The holds stop new dispatches
     for the seconds of the restart window; the cards stay queued, and no
     board-wide notice shows, because these are per-runner holds.
   - Every busy worker detaches its running turn: the script runs, inside that
     worker's own container, a `bun -e` snippet that calls its token-gated
     `POST /detach`. The worker then releases the `/run` stream and keeps its
     `omp` child running. An idle worker skips the detach call.
   - A busy worker that cannot detach (an old worker image that has not rolled
     yet answers 404) blocks the restart: the script releases every hold, logs
     that the server step waits for a later run, and exits 0. No turn is
     killed — the update is not worth killing that worker's turn.
   - Finally the script recreates the server (`up -d --no-deps --wait server`)
     when its image changed, or restarts it (`restart server`) when only the
     seed moved. The server's death drops only the detached streams; the
     workers' `omp` children keep running, and the new server's boot recovery
     re-binds them to their open turns, so no turn is lost and nothing is
     requeued for the restart. The recreate or restart clears every in-memory
     hold, so no undrain is needed. When the server's image is unchanged and no
     seed waits, no server step runs.
   - When the server step defers (a local turn that will not end, or a worker
     that cannot detach), the run skips the final whole-stack up, leaves the
     seed record unwritten, and a later run seeds and records again. A deferred
     restart also surfaces on the board: after 6 h of waiting the bell shows a
     notice with both commits, the waiting cards, and the exact restart
     command — the recreate the server step itself runs,
     `docker compose <your compose arguments> up -d --no-deps --wait server`,
     which stops the named turns; the notice clears once the server runs the
     image commit.

   The last step runs `up -d --wait` for the whole stack: it starts a service
   that is not running and waits for the server's health; it recreates nothing.

   Versions can mix only as old server with new worker, during a roll and after a
   stopped roll. The worker HTTP API (`GET /healthz`, `POST /run`, `POST /sweep`, `GET /signins`, `GET /stats`)
   stays compatible for one version in this direction. New server with old worker
   never persists: the server rolls after every worker rolled, and the per-runner
   holds and the detach before the server step mean no undetached turn runs on an
   old worker while the new server boots.

   When the board is too old for the runner API (`GET /api/drain` answers
   nothing), the script keeps the old whole-board rule: it holds new turns on the
   whole board, waits for at most 1 hour, and restarts the stack at once with
   `up -d --wait` when no turn runs. A board too old for the hold keeps the old
   containers until a later run. When no board runs at all, it starts the stack
   without counting turns.

3. A host-only override can build further services from their own local git checkouts
   (the compose files in this repo name none, so the script discovers them in
   `docker compose config`). A person can work in such a checkout, so the build never
   reads it. Each run builds the service from a fresh worktree of the checkout's
   `origin/main`, with one more compose file that sets only the build context. Files and
   commits in the checkout itself never reach the image. A cached build is cheap, and a
   build that changes the running image restarts that service at once
   (`up -d --no-deps --wait`). Such a restart needs no idle board: no turn calls the
   service — a worker installs the packages the shared home volume already holds, and the
   board's provision trigger lands a layer with one atomic switch, so it needs no idle
   board either (on an alate without layer support it still waits for one). The checkout
   itself
   fast-forwards to `origin/main` only when it is clean and on `main`. Else it stays as it
   is, with one log line.

The deploy also brings new Ottr commits from `main`. The run also seeds the board's agent
layer when the env file sets `ALATE_DATA` or `ALATE_DATA_REPO`
([Seed the board config](#seed-the-board-config)). The seed installs a layer and switches
it with one atomic rename, so it does not wait for turns; only the restart that follows
still drains running turns. The script's arguments go to
every `docker compose` call. Run it every hour. On Windows:

```powershell
$run = 'bun scripts\update-image.ts -f docker-compose.yml -f <override> --env-file <env> >> "%LOCALAPPDATA%\ottr-update-image.log" 2>&1'
Register-ScheduledTask -TaskName 'Ottr image update' `
  -Action (New-ScheduledTaskAction -Execute conhost.exe -Argument "--headless cmd /c $run" -WorkingDirectory <checkout>) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew)
```

On Linux, from the crontab of a user in the `docker` group (cron has a short `PATH`,
so name bun in full):

```sh
0 * * * * cd /srv/ottr && $HOME/.bun/bin/bun scripts/update-image.ts -f docker-compose.yml --env-file <env> >> $HOME/ottr-update-image.log 2>&1
```

The containers take provider keys from the
environment that runs compose, else from the env file. Cron has almost no
environment, so on Linux put them in the env file. To stay on an older omp, disable
the workflow, then revert the bump commit.

Only omp has automation. Every other pin is a hand bump: edit the `ARG <TOOL>_VERSION`
and its `*_SHA256` in `Dockerfile.worker`, commit, and let `update-image.ts` deploy the
build. Each pin's comment names the release asset, where its checksum comes from, and the
host version it mirrors — a host tool upgrade is the reminder to bump the pin. A wrong
pin or sha fails the image build loudly. To update ripwire: take the new version's
`ripwire-<v>-linux-x64.tar.gz` digest from the GitHub release and move both ARGs.

## System packages per project

The image carries no project's system packages, with one exception: git-lfs,
because the server checks LFS files out when it creates a worktree, before any
list installs. A project lists the Debian
packages its turns need in the data repo as `workers/<project>/apt.txt`: one
package per line, `#` comments allowed. For example, a project with UI changes
lists the shared libraries and fonts Chrome needs, so omp's browser tool (it
downloads Chrome into the home volume) can take the screenshot. Alate provisions
the lists to `~/.ottr/workers/<project>/apt.txt` in the home volume. A worker
installs every list when it starts, so a project's first turn there does not wait;
its log (`docker compose logs worker-a`) names what was installed, and a list that
fails does not stop the others. Before a turn starts, the container that runs it
installs the packages it still lacks: a worker for work turns, the server for merge
turns. The turn log names what was installed. Before the install, the container
runs `dpkg --configure -a` and reinstalls the packages that `dpkg --audit` still
names, so an apt run that a container stop interrupted does not block it. An install
that fails stops the turn with apt's error. The packages stay until the container is
recreated.

A tool with no Debian package (Godot, for example) goes into the same data-repo
folder as `tools.json`: a JSON array of pinned downloads, one per tool.

```json
[
  {
    "name": "godot",
    "url": "https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip",
    "sha256": "cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4",
    "unpack": "zip",
    "bin": "Godot_v4.7.2-stable_linux.x86_64"
  }
]
```

`name` is the command name the turn's PATH gets, `sha256` pins the download,
`unpack` is `zip`, `tar.gz` or `none`, and `bin` is the executable inside the
archive (`none` means the download itself is the executable). Alate provisions
the file beside `apt.txt`, and the container that runs a turn installs it the
same moment it installs the apt lists, into `/root/.ottr/tools/<sha256>/` on the
home volume, keyed by hash: every container on the host shares one download, and
a recreated container does not download again. Each turn then gets a link folder
ahead of the image PATH: the project's tools first, then the fleet folder
`workers/_all/tools.json`, and a project's `name` wins over the same `name` in
`_all`. The container PATH itself never changes, so two projects never see each
other's pins. Turns with the same tool set share one link folder,
`~/.ottr/tools/path-<hash>/`, so the folders do not grow with each turn.
A failed download or a hash mismatch stops the turn with the error,
like a failed apt install. The name `godot` gets a small wrapper instead of a
link: without `DISPLAY` or `WAYLAND_DISPLAY` it adds `--headless`, because Godot
exits with "Can't load Xlib" when it finds no display.
Before a turn links a `none` tool, it checks the installed binary against
`sha256` again. A changed binary stops the turn.

A turn that runs in the server (a merge turn, or a work turn with no worker) does
not use the shared home volume for tools. The server reads `tools.json` and
installs the tools under its own home (`OTTR_BOARD_OMP_HOME`, `/etc/ottr/home` on
compose). The seed installs the lists into the board home's layers
([The agent layers](#the-agent-layers)), and the board reads them from the current
layer at read time. The reason is R5-1: a
worker turn can write the shared home, so a binary there must never run in the
server. Until a seed runs, server-side turns get no tools.

An env var name a project's turns need goes into `env.txt` beside the other two
files: one name per line, `#` comments allowed, never a value. The value is a
secret and lives on the board: save it once under **Settings → Env**, and every
turn of a project whose `env.txt` (or `_all/env.txt`) lists the name receives it.
A listed name with no value does not stop the turn; the card log names it.
The board reads these lists only from its own home (`OTTR_BOARD_OMP_HOME`,
`/etc/ottr/home` on compose), never from the shared home volume. The reason is
R5-1: a turn can write the shared home, and a list there could give the secrets
of project A to project B. The seed installs the lists into the board home's
layers ([The agent layers](#the-agent-layers)); the hourly deploy runs it when
it seeds the board ("Seed the board
config"). Until a seed runs, turns get no env values.

### Python packages per project

Python packages a project's turns need go into `workers/<project>/requirements.txt`,
beside the other lists (`workers/_all/requirements.txt` for the fleet). One line
per package, transitive dependencies included, each pinned and hashed:

    numpy==1.26.4 --hash=sha256:<64 hex>

`#` comments are allowed. No options, no `-r`, no `--index-url`, no extras: pip
installs with `--require-hashes`, so nothing unpinned can slip in, in either home.
Alate provisions the file like `tools.json`, and the board seed copies it into the
board home. The project's lines win over the `_all` lines for the same package
name. The board's provisioning view shows the list as the Python column.

The machine that runs a turn builds a venv under its own home,
`~/.ottr/pip/<sha256 of the merged list>/`, once per list: `python3 -m venv` plus
`pip install --require-hashes`, built in a temp dir and moved in with one rename,
so a rerun is a no-op and a failed build leaves nothing behind. A server-side turn
(a merge turn, or a work turn with no worker) gets the venv's bin dir on its PATH,
behind the tools link dir: a merge turn re-runs the gates against the declared set
with no install step and no question, and its turn log names the venv. A work turn
on a worker keeps its own flow: the venv stays off its PATH, so an ad-hoc
`pip --user` install keeps working. A build or install failure stops the turn,
like a failed apt install. The turn image carries `python3-venv`
(Dockerfile.worker); Debian ships no pip without it. Until alate provisions the
new list (its `WORKER_FILES`), no list reaches a home and every build is a no-op.

## Env settings

- Server: `OTTR_WORKER_URLS` (comma-separated, e.g.
  `http://worker-a:8787,http://worker-b:8787`) selects remote dispatch;
  `OTTR_WORKER_TOKEN` (required, a random secret) authenticates workers. A
  worker strips it from every turn's env, since turns could otherwise drive
  any worker.
- Server: `OTTR_DATA_DIR=/data` keeps the task data that workers need
  (sessions, logs, images, handoffs) on the `ottr-data` volume instead of in
  the clones. Server and workers mount it at `/data`, and the clones at
  `/workspace`, so the absolute paths in a run request resolve the same in
  every container. The task DB is not there.
- Server: `OTTR_SERVER_DATA_DIR=/app/.tasks/projects` keeps the server-only
  project state (each `tasks.db` and the fork mirror caches) on the
  `ottr-state` volume. No worker mounts this volume. Refer to "The data
  boundary" below.
- `OTTR_BOARD_URL` is the address task sessions' `create_task` tool POSTs to;
  the default is `http://127.0.0.1:<port>`, which in a worker container is the
  worker itself, so compose sets `http://ottr:<port>` (`ottr` is the server's
  network alias). No allowlist covers that host, so the board opens it to one
  request only: filing a card with the token it hands every task session
  (`OTTR_BOARD_TOKEN`, new on each board start). Without the token it answers
  401, and every other route there answers 403, even with the token. A turn
  that outlives a board restart holds a stale token: its card filing fails
  with 401.
- Server: `OTTR_GITHUB_HOST` names the GitHub host of the board. The default
  is `github.com`, and an empty value keeps the default. You can also set it
  in Settings → Git hosts → GitHub host; a saved value wins over the env
  until cleared. Compose reads the
  value from the host shell or the compose env file and passes it to the
  server only; workers never use it. Refer to the README row "GitHub host".
- Unset `OTTR_WORKER_URLS` = local spawn on the server host (the default;
  `runner.startRun` stays the reference implementation). When the variable is
  set, a work turn never runs on the server: if a worker is down or answers
  non-200, the board settles the turn as a lost worker and requeues it once for
  a worker. A second failure in a row stops the card with needs_you.
- Provider keys pass through from the host shell, and so do the keys a project's
  MCP servers read from its committed `.omp/mcp.json` (the file adds its servers
  only to that project's turns). The host omp oauth dir is mounted read-only
  into every container via `OTTR_OAUTH_DIR` (required; for example
  `C:/Users/<you>/.omp/oauth`). Provider sign-in is one sign-in per provider,
  done once on the board in **Settings → Provider sign-in**. Do not use
  `docker compose exec server omp login`: it skips the worker-store update and
  runs omp with the worker-writable home. The board store
  (`/etc/ottr/home/.omp/agent/agent.db` on the `board-config` volume) holds the
  credential. `OTTR_AGENT_DB` is the worker store: a file bind-mounted at
  `/root/.omp/agent/agent.db`. Seed it once with a consistent copy of the
  host's (`VACUUM INTO`, never the hot file). The server publishes
  Anthropic's sign-in callback port 54545 and OpenAI Codex's port 1455 on
  `127.0.0.1`, so the provider's redirect reaches the board, which finishes the
  sign-in. Codex's port is fixed: while the stack runs, `omp login
  openai-codex` on the host cannot bind it.
  Before each worker turn, the board puts the provider's short-lived access
  token into the turn env (`ANTHROPIC_OAUTH_TOKEN`, `OPENAI_CODEX_OAUTH_TOKEN`,
  `ZAI_API_KEY`). The worker store keeps no board-managed credential.
  A lent OAuth sign-in marks the provider's worker-store rows `replaced by newer
  credential`, and sign-out clears both stores.
  Never copy the host's file over the board store again. A copied login shares
  its refresh token with the host, and a provider that rotates refresh tokens
  (Anthropic does) accepts only the side that refreshes first: omp disables the
  other side's login (`invalid_grant`), on the host or in the stack.
- The `alate` profile runs a bundled Alate server next to the stack:
  `docker compose --profile alate up -d` (or `COMPOSE_PROFILES=alate` in the
  env file). The service serves its dashboard on `127.0.0.1:4570` on the host
  and `http://alate:4570` on the compose network. Its state lives on the
  `alate-state` volume, and it provisions the workers through the shared
  `home` volume, as layers under `/root/.alate`
  ([The agent layers](#the-agent-layers)). `ALATE_URL` and `ALATE_API_KEY` pair the board with it: the
  board reads the two values only while **Settings -> Alate** holds no URL or
  key, and a value saved there wins at every boot. Set both in the env file,
  for example `ALATE_URL=http://alate:4570` and a random `ALATE_API_KEY` (32
  hex bytes); the alate container itself requires the same key. The board
  never logs the key, and the runner strips it from every turn's env, since
  no turn calls alate. A user whose Alate server already runs on another host
  omits the profile and saves the URL and key under **Settings -> Alate**.

## Scaling

Workers are copy-paste blocks of the `x-worker` anchor in
`docker-compose.yml`: add `worker-c`, then append
`http://worker-c:8787` to `OTTR_WORKER_URLS`. Do not use
`docker compose --scale`: round-robin DNS breaks cancel routing; per-run
addressability needs stable names. Worker containers are never port-mapped
to the host.

## microVM workers

A project can run its work turns in a Firecracker microVM, one VM per turn, instead of on
the classic workers. The decision and the comparison with Kata Containers and gVisor are
in [ADR 0009](adr/0009-microvm-workers.md). The classic pool stays the default, and every
project without the setting keeps it.

**Experimental.** No Firecracker boot has run yet on a Linux host with `/dev/kvm`: the
guest kernel, the overlay root, the iptables rules, the OOM behaviour, session resume and
the restart re-bind are covered only by unit tests with a fake launcher. Treat the mode as
experimental until the KVM acceptance runs and the performance numbers are recorded in
ADR 0009.

Only work turns whose cwd is the card's own worktree go to a VM. Interview, grill and
trending turns of the same project run in the main checkout and stay on the classic pool.
Merge, retro, board check, work and review checks, release publish and fork analysis stay
on the server, as for every project.

### Host requirements

- Linux with `/dev/kvm` (hardware virtualization on, or nested virtualization in a cloud
  VM) and `/dev/net/tun`.
- Docker with the compose plugin. The Firecracker binary and the guest kernel ship in the
  image; nothing else is installed on the host.
- WSL2 without `/dev/kvm` and Podman machines without nested virtualization cannot run
  it; such a host keeps the classic pool.

### Turn it on

1. Start the runner: `docker compose --profile vm up -d` (or add `vm` to
   `COMPOSE_PROFILES` in `.env`, so updates keep it).
2. Set `OTTR_VM_RUNNER_URL=http://vm-runner:8787` on the server (compose env file), then
   recreate the server. The server talks to `vm-runner` with the same
   `OTTR_WORKER_TOKEN` as to the workers. With the URL set, the server also starts its
   own `omp auth-broker serve` and `omp auth-gateway serve` on loopback for the `/llm`
   proxy.
3. In the project's **Settings**, turn on **Run work turns in microVMs**. The checkbox
   stays disabled while `OTTR_VM_RUNNER_URL` is unset or `vm-runner` does not answer its
   `/healthz`, and its text names the reason.

Runner env (on the `vm-runner` service), with defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTTR_VM_MAX` | `2` | VMs that run at once; one more turn gets the busy answer |
| `OTTR_VM_VCPUS` | `2` | vCPUs per VM |
| `OTTR_VM_MEM` | `8g` | guest RAM per VM (`8g`, `8192m` or bytes) |
| `OTTR_VM_DISK` | `20g` | size of each VM's scratch disk, the turn's whole writable space |
| `OTTR_VM_STATE_DIR` | `/var/lib/ottr-vm` | rootfs cache, project layers and scratch disks |
| `OTTR_VM_KERNEL` | `/opt/ottr-vm/vmlinux` | guest kernel |
| `OTTR_VM_FIRECRACKER` | `/usr/local/bin/firecracker` | Firecracker binary |
| `OTTR_VM_BOARD_HOST` | `ottr` | host name of the board; the runner resolves it and lets VMs reach only that address |

`OTTR_WORKER_TOKEN` is required, and `WORKER_PORT` (default `8787`) sets the listen port,
as on a worker. The limits are hard: a VM gets exactly its vCPUs and RAM, and a turn that
fills its scratch disk gets `ENOSPC`. The defaults are not measured yet (see
[Residuals](#microvm-residuals)).

### Extra privileges

`vm-runner` needs more than a classic worker, and nothing else in the stack gets it:

- `/dev/kvm`: Firecracker runs each guest on KVM.
- `/dev/net/tun`: each VM gets its own tap device (`ovm<n>`).
- `NET_ADMIN`: the runner creates the taps and writes the iptables rules that confine
  each VM's traffic (below).

It mounts `ottr-data:/data` read-write, to copy a card's files in and out, and
`home:/root` read-only, for the package lists and the agent layer. It never mounts
`/workspace`, and no VM sees any of these mounts.

### Isolation model

- Code: the VM clones the task branch from the board's git endpoint
  (`<board>/git/<project>.git`) into the same absolute path as the server worktree
  (`/workspace/<project>/.worktrees/<ID>`), so the paths in the turn's arguments stay
  valid. The clone uses a per-turn token. The token reaches only that project's repo; the
  endpoint advertises and serves only the task branch (and the base branch when the base
  is a branch name), and pushes only `refs/heads/<task branch>`; a push to any other ref,
  a delete, or a compressed push body is refused. The VM pushes every 60 s while HEAD
  moves and once at the end; after each push the board resets the server worktree to the
  branch tip, never to a sha the VM reports.
- Provider credentials: none enter the VM. omp in the VM sends each provider through the
  board's `/llm` proxy (`transport: pi-native`, with the per-turn token as the key). The
  board forwards to its own `omp auth-gateway serve`, which resolves OAuth sign-ins and
  API keys from the board's store through `omp auth-broker serve` and refreshes them
  there.
- Memory: with Hindsight configured, the VM calls the board's `/hindsight` proxy with the
  per-turn token; the board adds the Hindsight key.
- Card filing: a turn files cards on the board with the per-turn token, only in its own
  project.
- Network: the runner's iptables rules let a VM reach the board's address and port, drop
  every other private, link-local, CGNAT (100.64.0.0/10) or reserved address (other VMs,
  the workers, compose services, `vm-runner`'s own API), and let the VM reach the internet
  through NAT. DNS goes to public resolvers (1.1.1.1,
  8.8.8.8); the board's name is in the VM's `/etc/hosts`.
- Files: the card's session files and other inputs under `/data/<project>/` are copied
  in at the same paths. At the end of the turn (also for a detached run), regular files
  under the copy-back folders (the project's `sessions/`) that are new or changed since
  the run started are copied back; an existing file the run did not copy in is never
  overwritten, so a VM cannot rewrite another card's session. The pinned agent layer is
  copied in without the shared home's credential and identity state
  (`.omp/agent/agent.db*`, `.omp/oauth`, `.ssh`, `.config/gh`); symlinks are copied as
  links and never followed.
- Residual: the `/hindsight` proxy forwards the whole Hindsight API, so a VM token reaches
  every memory bank of the tenant, as a classic worker's Hindsight key does.

The per-turn token lives until the turn settles. The board keeps only its hash, in a
server-only file, so a token survives a board restart and a re-bound turn keeps pushing.

### Rootfs cache

A VM boots from three disks: a read-only base root filesystem, a read-only project
layer, and a fresh sparse scratch disk of `OTTR_VM_DISK`. The root is an overlay of the
three, so the turn writes only to its scratch disk. Files under `OTTR_VM_STATE_DIR`:

- `base/base-<key>.ext4`: the base, built by `vm-runner` from its own container root
  (the `vm-runner` image with the worker toolchain). The build starts in the background
  when `vm-runner` starts, and a turn waits for it. The key hashes the Ottr version,
  `omp --version` and `package.json`, so a new image builds a new base.
- `layers/<project>-<key>.ext4`: the project layer with the project's system packages,
  tools and Python packages. The runner bakes it in a VM (bake mode, layer writable) from
  the data repo lists (`workers/<project>/apt.txt`, `tools.json`, `requirements.txt`,
  and the `_all` lists; see [System packages per project](#system-packages-per-project)).
  The key hashes the base key and those lists. The layer is rebuilt lazily: the next
  turn of the project after a list or the base changes bakes a new layer, and later
  turns reuse it. Bakes of one project run one at a time. A failed bake ends that turn
  with exit code 1 and the bake's error tail.
- `runs/<run id>/`: the scratch disk, the Firecracker config, its socket and its log.
  The runner removes the dir at run end.

Only the current base and the current layer of each project are kept. At start,
`vm-runner` wipes `runs/` and any leftover `ovm*` taps and iptables chains: a restart has
killed those VMs already.

### Lifecycle

- Full: when `OTTR_VM_MAX` VMs run, `vm-runner` answers the dispatch with a busy `503`.
  The board records a turn only after `vm-runner` accepts it, so a busy answer writes no
  turn, keeps the pending reply, and counts no lost turn. The card stays queued with the
  hold **waiting for a free microVM**, its log gets one line ("every microVM was busy;
  the card waits in the queue for a free microVM"), and the scheduler tries again after
  10 s.
- Down: while `vm-runner` does not answer its health probe, the project's work cards
  stay queued with **waiting for the microVM runner: <reason>**. They never fall back to
  the classic pool.
- Board restart: the runner speaks the worker protocol, so a running VM detaches like a
  worker turn (`/detach`), keeps running, and the new server re-binds it.
- `vm-runner` restart: its Firecracker processes die with the container, so every running
  VM is lost. The board sees a lost worker and resumes the card once with a new turn,
  as for a worker; session changes and files the VM had not pushed are gone.
- Dirty tree: a VM's files die with the VM. When a turn reports ready but the VM ends
  with uncommitted or untracked files, or cannot report its tree, the card parks at
  needs_you with no resume turn. The reason names up to 20 `git status` lines, or says
  that the microVM could not report its tree state. A failed push is written to the card
  log (`! microVM push failed: ...`), and the server worktree stays at the last pushed
  head.
- Board files: at the end of a turn the VM sends back `research-report.md` and the files
  under `shots/` (at most 16 MiB in all), and the board writes them into the server
  worktree before it classifies the turn; it writes no other path the VM sends.

### vm-runner in the update roll

The board lists `vm-runner` as a runner on `GET /api/drain` (id: the host name of
`OTTR_VM_RUNNER_URL`, so `vm-runner`), and its running VMs count as that runner's turns.
`scripts/update-image.ts` therefore rolls it like a worker ([Updates](#updates)): it
holds the runner (`POST /api/drain` with `runner: vm-runner`; the microVM cards stay
queued and unclaimed), waits until no VM runs (at most 1 hour), recreates the service,
waits for its `/healthz`, and releases the hold. Before a server restart, a busy
`vm-runner` detaches its running VMs like a busy worker. A recreate of `vm-runner` with
running VMs would lose them, which is why the roll waits.

### microVM residuals

- A VM crash, or a `vm-runner` restart while VMs run, loses that turn's session changes
  and its unpushed files.
- The project's `env.txt` values enter the VM, as they enter a classic worker turn.
- Internet egress is open.
- The per-turn token is a bearer secret inside the VM: until the turn settles, it can
  push the task branch, call `/llm` and `/hindsight`, and file cards in the project.
- Interview, grill and trending turns of a microVM project run on the classic pool, with
  its shared volumes.
- Turn speed inside 2 vCPUs and 8 GiB is not measured. The feature was written on a WSL2
  host without `/dev/kvm`, so no VM booted there; measure boot time, builds and test runs
  on a KVM host before trusting the defaults.

## Fleet memory (Hindsight)

The board picks the memory backend from the deployment at every omp spawn. A non-empty
`HINDSIGHT_API_URL` selects `hindsight`; an empty or unset value selects omp's default
`mnemopi` (a local store in the shared home volume). docker-compose.yml interpolates the
URL from the environment (`${HINDSIGHT_API_URL:-}`), so set it in the compose env file
(the `--env-file` that `scripts/update-image.ts` passes) or in the shell that runs
compose, for example `HINDSIGHT_API_URL=http://hindsight.local:8888`. **Settings ->
Hindsight** can also save the address; a URL saved there beats the env seed at every boot,
so Settings alone turns fleet memory on or off.
`memory.backend` is not part of the agent layer (OTTR-453): a layer ships the
`config.yml` as the data repo holds it, and the pin never rewrites it
([The agent layers](#the-agent-layers)).

The board does not patch any `config.yml`. At every spawn it writes the choice to
`$OTTR_DATA_DIR/omp-memory.yml` (in compose: `/data/omp-memory.yml`) and appends
`--config <path>` to the omp command. The overlay wins per key, so a stale
`memory: backend: hindsight` line in a seeded `config.yml` has no effect. Alate will
strip the backend line from captured `config.yml`; until then the line is inert and
serves only direct spawns that run without the board. Mnemopi is the default when no
Hindsight config exists. Both server-side runs (merge, release, review turns) and worker
turns get the overlay, so the whole compose topology runs one backend.

The server checks memory health at boot and every 60 seconds. When the check fails, the
board header and the Settings Hindsight section show the sentence
`omp runs with no memory: <reason>` — for example an unreachable Hindsight URL or a
mnemopi store that refuses writes.

The Hindsight server requires its tenant API key on every request. Set it under
**Settings -> Hindsight** (the same place holds the server address): the board saves a
key only after the server at the effective address accepts it (`GET
/v1/default/banks`), stores it in `.tasks/tracker.db` and hands it to every new turn as
`HINDSIGHT_API_TOKEN`, which omp reads over the environment. `HINDSIGHT_API_TOKEN` in the
env file only seeds the key until Settings holds one. Fact extraction runs on the server
and needs LLM balance there.

## Check memory

The memory backend ships inside omp, and its store lives on the home volume (mnemopi) or on
the Hindsight server. To check that turns remember across runs, run this script twice:

```sh
docker compose exec -T server bun - < scripts/compose-memory-proof.ts
```

The first run on a fresh volume only stores a word. Every later run must recall the word of
the run before, or the script exits non-zero. `PROOF_WORKER_URL`, `PROOF_CWD` and
`OTTR_WORKER_TOKEN` override the defaults.

## What stays server-side

Worktree create/remove, the merge turn, the release fast-forward and
`git push origin main` all run in the server container. Workers execute turn
processes only. Push credentials never leave the server:

- `startRun` removes the board's `GH_TOKEN` from the env that it forwards to a worker.
- The worker daemon (`serveWorker`) removes `GH_TOKEN`, `GITHUB_TOKEN` and every git
  host credential name (`GIT_AUTH_ENV_NAME`) from the env of each turn. This covers
  a value in the container env and a value in the request.
- The `x-worker` anchor in `docker-compose.yml` sets no GitHub token.

A local turn (in the server container) keeps `GH_TOKEN`. A merge turn needs it for
its push. The trending scout reads third-party text, so it runs on a worker when one
exists. Its local run (no worker, or a worker fallback) also runs without `GH_TOKEN`
and `GITHUB_TOKEN`.

### Non-GitHub hosts

A project on a git host other than GitHub clones, fetches and pushes with the
same rule: credentials stay on the server. Two credential kinds exist (both
configured under **Settings → Git hosts**):

- HTTPS tokens: stored per host in the global config row. Server-side git
  reaches them through env-scoped credential helpers — `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` name a helper that prints
  `username`/`password` from `OTTR_GIT_USER_*`/`OTTR_GIT_TOKEN_*`. The token is
  never in a URL, in argv, or in a `.git/config`.
- SSH keys: files under `OTTR_SSH_DIR` (mode 0600, directories 0700). Compose sets
  it to `/app/.tasks/ssh` on the ottr-state volume, which no worker mounts. A native
  start uses `<OTTR_STATE_DIR>/ssh` when that is set (dev boards), else the user data dir (`~/.local/share/ottr/ssh`, `%LOCALAPPDATA%\ottr\ssh`). Git runs with
  `GIT_SSH_COMMAND` (key path, `UserKnownHostsFile`, `StrictHostKeyChecking=yes`,
  `BatchMode=yes`) for server-side git only. Every agent run, merge turns
  included, starts without `GIT_SSH_COMMAND` and every `GIT_CONFIG_*`/`OTTR_GIT_*`
  name.

Server-side git is the only holder of these credentials. Each network call also
resets the repo-config credential helpers (then re-adds the global and system
ones), disables `ext::` transport, signed pushes and askpass, and always sets
`GIT_SSH_COMMAND`, so config that a turn plants in a main checkout's
`.git/config` cannot run with the tokens. Each network call also sets
`GIT_ALLOW_PROTOCOL=https:ssh:file` and empties `GIT_PROXY_COMMAND`: a planted
remote URL on any other transport (`git://`, `rsync`, a second `ext::` form)
fails closed, and a planted `core.gitProxy` — which the `git://` transport would
run as a command — never does. Every board git also passes explicit
`--upload-pack`/`--receive-pack` to network subcommands and `--no-ext-diff
--no-textconv` to `diff`, `log` and `show`, so a planted `remote.<name>.uploadpack`,
`receivepack`, `diff.external` or textconv driver does not run. These flags do not reach
the child git of a submodule, so board git also never recurses into submodules
(`--submodule=short`, `--no-recurse-submodules`, `--recurse-submodules=no`). Residual limit: a planted
`http.<url>.proxy` with
`http.<url>.sslVerify=false` can also see a token, because git prefers the most
specific URL match over the env value. No turn's shell sees
them.

The merge push, the merge-hold gate fetch, the target-refresh fetch and the
release fetch/push never take a remote name. They name the origin URL the
server pinned once in the project
settings (`originUrl`, docs/specs/pinned-origin-url.md): the server reads it
from the origin remote at boot or add time, before any turn runs, because a
work turn can re-point a remote name through the worker-writable `.git/config`
— and the pre-receive hook of the repo it names runs in the server's git next
to these tokens (the `core.hooksPath=/dev/null` pin does not reach the local
`receive-pack` child of a `file://` push). Every pinned call also refuses to
run when the repo config holds an `url.<base>.insteadOf` or
`url.<base>.pushInsteadOf` entry that matches the pin (a rewrite would send the
call to a repo the pin never named), when the pin itself is not a URL or path
(a leading `-` would parse as a git option), and when a local pin sits under a
worker-writable root (the project roots, `OTTR_DATA_DIR`, and the server's own
home — compose mounts the shared `home` volume at `/root` into the server and
every worker), set when a worker boundary exists. A local pinned URL outside
those roots keeps working, which is why `file` stays in `GIT_ALLOW_PROTOCOL`.
Residuals: a pin captured at boot can adopt a remote URL that a turn planted
before that boot — the worker-root check refuses any local plant under those
roots at every use, and a planted https URL carries no matching credential, so
such a push fails closed; an `url.<base>.(push)insteadOf` rewrite to a foreign
https host can feed a fetch of a public repo, but no token matches the
rewritten host. For a project without a GitHub remote, the server pushes the
merged target to the pinned origin URL after the merge turn ends.

The card of the dev-only **Check the board** button also runs in the server container.
Only loopback there reaches the full board API. On the turns' host (`OTTR_BOARD_URL`), a
worker's turn can only file cards. The board marks the check card in the project store when
the button files it, so a card that an agent files with the same prompt still runs on a
worker.

### The config boundary

Work turns share the `workspace` and `home` volumes with the board, so a turn can write
`/root/.gitconfig`, `/root/.config/gh`, or a main checkout's `.git/config` — and the board
runs git in that checkout on every scheduler tick, with the GitHub token in its
environment. The board hardens against all three on two layers.

Code: every board git call overrides `core.fsmonitor=false` and `core.hooksPath=/dev/null`
on the command line (command-line config outranks repo and global config), and `GH_TOKEN`
reaches only the network subcommands (`clone`, `fetch`, `ls-remote`, `pull`, `push`);
local subcommands such as `status` run without it. One limit: on a push to a local
(`file://`) repo, the `-c` pins do not reach the local `receive-pack` child, so its
`pre-receive` hook would run in the server's git — the merge push therefore never takes a
remote name, only the server-pinned origin URL (docs/specs/pinned-origin-url.md). Every
board git call also sets
`commit.gpgSign=false` and `tag.gpgSign=false`, and sets `gpg.program`, `gpg.x509.program`
and `gpg.ssh.program` to `false`. Thus a planted signing or `log.showSignature` setting
cannot run a program.

Filter drivers (`filter.<driver>.clean`, `smudge`, `process`) need one more step. The
driver name comes from attributes, so no `-c` can clear the driver. Also, git reads
`$GIT_DIR/info/attributes` above every override. Thus the board reads the files of a
worktree only through a stub gitdir that it writes for each call (`sealedGit` in
`src/worktree.ts`):

- The stub holds HEAD as a sha and no repo config. The calls use the real index and objects
  of the worktree and a copy of the main checkout's `info/exclude`.
- `git status`, `git diff <from> --` and the first checkout of a new worktree use the stub.
  The board runs `git worktree add --no-checkout`, then `git reset --hard` in the stub.
- The tracked `.gitattributes` still apply. They can name only the drivers of the system,
  global or command-line config, for example git-lfs. The stub points `lfs.storage` at the
  main checkout's LFS cache.
- These calls pass `--ignore-submodules=dirty`. A submodule status runs git in the gitdir of
  the submodule, and a work turn can plant that gitdir too. Instead, the board checks each
  checked-out submodule with its own stub. A dirty submodule shows as ` M <path>` in the
  status, in the changed files and in the diff, the same as plain git. When the board cannot
  read a submodule, the worktree is not clean, and `statusRows` fails.
- For a partial clone, the stub gets a copy of the promisor remote (name, `url`,
  `partialclonefilter`). Thus git can still fetch a missing blob. That fetch also reads only
  the stub, and never reads a planted `uploadpack`, `sshCommand` or credential helper.
  The fetch's ssh runs as `ssh -F /dev/null -o BatchMode=yes`. So it never reads the shared
  home's `~/.ssh/config`, and a planted `ProxyCommand` never runs. `GIT_ALLOW_PROTOCOL`
  pins the fetch transports to `https` and `ssh`.

No board git call merges, rebases or cherry-picks in a checkout that a worker can write.
Thus no call reaches a planted `merge.<driver>.driver` or `merge.default`.

Topology: the compose file pins the board service's `GIT_CONFIG_GLOBAL` to
`/etc/ottr/gitconfig` and `GH_CONFIG_DIR` to `/etc/ottr/gh`. These paths are on the
`board-config` volume. Only the `server` service mounts this volume, and no worker mounts
it. The volume survives each container recreate, for example the hourly auto-deploy.
The entry script never copies from the shared home (`/root`). When the git config is
absent, the entry script writes only the fixed Ottr identity (`user.name = Ottr`,
`user.email = ottr@localhost`). gh starts empty on purpose, because gh config can name
commands. When a pinned path is inside `$HOME`, the entry script refuses to start. It
writes each refusal and warning to stderr as a line that starts with `ottr-entry: R5-1:`.
A config planted in the shared home never reaches the board's git or gh. The system-level
credential helper is baked into the image, outside every volume. It answers only for
github.com when `GH_TOKEN` is set.

The same boundary covers the board's own omp agent layer. A worker-plantable
`~/.omp/agent/config.yml` could reassign the `modelRoles` the release review runs on, and
planted skills, extensions or plugins would load into the board's privileged turns (merge,
release review, release). The compose file pins the board's `PI_CODING_AGENT_DIR` to
`/etc/ottr/home/.omp/agent` on the `board-config` volume. omp resolves its agent dir
(config.yml, agent.db, skills, extensions, sessions) from that variable. The entry script
creates this directory empty and logs an `ottr-entry: R5-1:` line while nothing seeds it;
the line stays away when the board home carries a seeded layer
([The agent layers](#the-agent-layers)). The agent layer comes only from the trusted
`board-seed` service, a one-off of the Alate image (see
[Seed the board config](#seed-the-board-config)). The board decides the memory
backend at spawn time, so the seeded `config.yml` needs no `memory:` backend line.
The board's own config readers
(`src/models.ts` model roles, the Settings Hindsight section, the sign-in store in
`src/login.ts`) resolve the same variable. A worker dispatch strips the variable from the
turn env, unless the dispatch pins the worker's own layer: the strip
never carries the board's private agent dir into a turn (R5-1), and a pinned turn instead
gets the layer dir of the shared home. The board's layer does not follow Alate provisions
of the shared home. The hourly deploy seeds the layer again by itself when the env file names
the data repo (see [Seed the board config](#seed-the-board-config)). The layer
layout of both homes, the pinning, the shared-state links, the in-use registry and the
clean-up rule are in [The agent layers](#the-agent-layers). The board shows a
notice while the layer is not seeded, or while a model role's provider has no active
sign-in in the board's store.

omp does not resolve every user path from that variable. It reads plugins from
`$HOME/.omp/plugins` and user skills and context files (`~/.agents`, `~/.claude`, and the
other tool dirs) from `$HOME`. The board's `$HOME` is the shared home. So the compose file
also sets `OTTR_BOARD_OMP_HOME=/etc/ottr/home`, and every omp that the board starts for
itself gets that directory as its `HOME`: merge, release review and release turns, `omp
models`, `omp usage`, `omp login`, `omp token` (the token refresh), and the fork-analysis gateway (`src/login.ts`
`boardOmpEnv`). The agent dir above lies in this directory. The entry script creates the
directory and copies nothing into it, and refuses to start when the variable points into
the shared home. A worker dispatch removes the variable from the turn env, so a work turn
keeps the shared home. The board's own reads of the shared home keep
`/root`: the apt lists, the shared credential store, and the shared `config.yml` (its
memory backend is inert there; the spawn-time overlay decides).

#### The agent layers

Both homes hold the agent layer the same way (docs/specs/agent-layer-switch.md). In a
home `H`, `H/.alate/layers/<id>/` holds one installed layer: exactly what an alate
install writes today — the `.omp/agent` config, rules, skills and extensions,
`.omp/plugins`, `.agents`, and the `.ottr/workers` lists. `H/.alate/current` is a symlink
to one layer, and alate switches it with one atomic rename: before the switch, nothing a
running turn reads changes. The shared home (`/root` on compose) and the board home
(`OTTR_BOARD_OMP_HOME`, `/etc/ottr/home`) each keep their own layers and their own
switch: alate provisions the workers' home, and `board-seed` provisions the board's.

A layer never carries per-run or credential state, and a provision never writes it. That
state stays at its flat path in the home, and at turn start the board links each entry
inside the layer to the flat path (the link exists even when the target does not, so omp
creates the target through the link):

- `.omp/agent/agent.db`: the credential store, one per stack.
- `.omp/agent/sessions`: `--resume` works across switches.
- `.omp/oauth`: the provider token cache.
- `.omp/logs`: the http-400 logs stay in one place.
- `.cache`: test and package caches stay shared.

When the flat home has one of `.gitconfig`, `.config/git`, `.config/gh`, `.ssh`,
`.claude`, `.npm`, `.bun`, `.local`, the layer links it too; a missing one stays missing,
as today. Everything else in the layer is layer content: a turn may write new files into
its own layer home, and they die with the layer at clean-up.

Every omp process the board spawns pins at start: worker and server turns, and the
auxiliary spawns (`omp login`, `omp models`, `omp usage`, the fork-analysis gateway).
The pin resolves `<home>/.alate/current` once with `realpath`, prepares the links, and
runs omp with `HOME` and `PI_CODING_AGENT_DIR` inside the resolved layer directory for
the run's whole life; a later switch never touches a pinned run. `memory.backend` is
not layer content (OTTR-453 moves the pick to the deployment): the pin never rewrites
the layer's `config.yml`. The entry script keeps its boot-time flip of the flat homes
for the no-layer era and for spawns that stay flat.

The board records each pinned layer id in `H/.alate/in-use.json` for the run's life and
removes it when the run settles. Alate deletes a layer folder only when it is not
`current`, not the layer `current` named before the last switch, and absent from
`in-use.json`. A corrupt `in-use.json` never fails a run, and clean-up then still keeps
the last two layers. The bound a pinned run can hit: a turn that outlives two switches
(a 9 h mutation run can) loses its layer, the turn fails, and classification requeues it
once, then parks it for a human.

Error cases: no layer yet (no `current` link, or an alate that still writes flat) runs
the flat home, exactly as before; a broken `current` link falls back to the flat home and
logs a warning into the run log, and the next provision repairs the switch; a shared-state
link that cannot be written falls back the same way, so a run never fails because of
pinning. The provision tick installs a layer whenever the alate server reports layer
support (`layers: true` in `GET /health`), with no idle wait; while it does not, the tick
keeps the old idle gate, because that server writes the flat home under a running turn.

#### Seed the board config

Do these steps once after the first `docker compose up`. The hourly deploy repeats the
seed by itself when the env file names the data repo (below). The first deploy of this
change also needs them: an existing stack starts with an empty `board-config` volume.

1. Run the seed. For a private data repo, export `GH_TOKEN` first:
   `docker compose run --rm board-seed --repo <owner/name>`.
   To use a local checkout of the data repo, run
   `docker compose run --rm -v <data-repo>:/data:ro board-seed --data /data`.
   No restart follows: the seed installs a layer and switches `.alate/current`
   ([The agent layers](#the-agent-layers)), turns pin the current layer at spawn, and
   the board's config readers follow the current layer at read time.
2. Sign in once under **Settings → Provider sign-in**. Alternatively, pass provider API
   keys (`ANTHROPIC_API_KEY`, ...) in the env.

To seed with no hand step, set one of these in the compose env file:

- `ALATE_DATA=<host path>`: a local checkout of the data repo. The updater seeds from its
  `HEAD`.
- `ALATE_DATA_REPO=<owner/name[@ref]>`: a GitHub repo. The ref defaults to `main`. A
  private repo needs `GH_TOKEN` in the env file.

At each hourly run, the updater reads the data repo's head commit and compares it with the
commit recorded at `/etc/ottr/seed-commit` in the `board-config` volume. When they differ,
it runs `board-seed` once, with no idle wait: the seed installs a layer and switches it
with one atomic rename, so running turns keep the layer they pinned at spawn and new
turns pin the new one ([The agent layers](#the-agent-layers)). The seed writes the record
when it switches; a failed seed keeps the recorded commit, and
the run exits non-zero. The restart that the updater may pair with the seed or a new
image keeps the turn hold as before: a container restart ends its turns. The updater
takes the alate image from `ALATE_IMAGE` in the env
file, or from the running alate container. Set `ALATE_IMAGE` when no alate container runs.
When `GH_TOKEN` is set with `ALATE_DATA_REPO`, the updater also probes the token's expiry
and records the date (or `none`) at `/etc/ottr/seed-token-expires` in the same volume.

The seed uses the same SkillSpector scan as worker provisioning, and a failed scan stops
it. `--force` lets the data repo win over board-local edits. The seed installs the whole
user layer as a new layer under `/etc/ottr/home/.alate/layers/<id>` and switches
`/etc/ottr/home/.alate/current` (`OTTR_BOARD_OMP_HOME`, see above). This includes the
plugins and the user skills in the layer, under `.omp/plugins` and `.agents/skills`.

To verify the seed:

- `docker compose exec server readlink /etc/ottr/home/.alate/current` prints a
  `layers/<id>` path.
- `docker compose exec server ls /etc/ottr/home/.alate/current/.omp/agent` lists
  `config.yml`, `rules` and `skills`.
- `docker compose exec server sh -c 'env HOME="$(readlink -f /etc/ottr/home/.alate/current)" omp plugin list'`
  lists the data repo's plugins.
- The boots after the first seed log no new `ottr-entry: R5-1:` line about an unseeded
  agent dir.

#### Credentials

Provider sign-in is one sign-in per provider, done on the board. The spec is
`docs/specs/provider-credentials.md`.

- The board store is `/etc/ottr/home/.omp/agent/agent.db` on the `board-config`
  volume. It holds the provider's credential and its refresh token. The path stays
  flat, and each layer links it ([The agent layers](#the-agent-layers)).
- The worker store is `/root/.omp/agent/agent.db` in the shared home. It keeps
  no credential that the board manages.

A sign-in under **Settings → Provider sign-in** runs one `omp login` against
the board store; you authorize the provider one time. Complete it from any
device: when the provider's browser page cannot reach the board, paste the
failed `http://localhost:...` address (or the code) into the Settings field.
Before each worker turn, the board resolves one model: the card's model, else
(on a resume) the saved session's model, else the `default` role of the
board's `config.yml`. It passes that model to omp as `--model`, and it puts the
short-lived access token of that model's provider into the turn env. Lending
fails closed: when no model resolves, or the board has no usable sign-in for an
Anthropic, Codex or Z.AI model (missing, disabled, unreadable, an empty token,
or no valid expiry), the turn does not start, and the card shows the cause.
The env names are `ANTHROPIC_OAUTH_TOKEN`,
`OPENAI_CODEX_OAUTH_TOKEN` and `ZAI_API_KEY`. When the token has less than 30
minutes left, the board runs
`omp token <provider> --force-refresh` against the board agent dir first: omp
refreshes the token itself, with no model request. Then the board reads the new
token from the board store. Ottr has no OAuth refresh code of its own.

- The board lends only OAuth sign-ins of Anthropic, ChatGPT (Codex) and Z.AI.
  Such a sign-in marks the provider's worker-store rows `replaced by newer
  credential`, and worker turns then resolve the lent env token. Any other
  sign-in (an API key, or another OAuth provider) changes no worker row: the
  workers keep their own credential, or set the provider's key under
  **Settings → Env**. The newest login of a provider decides: an API key
  signed in after an OAuth sign-in stops the lending, also while omp keeps the
  OAuth row. Settings shows "Lent to workers" or "Not lent to workers" on each
  row. The spec lists every provider.
- Sign-out marks the provider's rows `deleted by user` in the board store and
  in the worker store. That removes legacy rows in one step.
- When omp does not refresh, the turn does not start, and the card shows omp's
  cause. The board never lends a token from the command's output. Reply to the
  card to retry. A provider after `invalid_grant` needs a new sign-in.
- The board never runs omp with the shared home as its agent dir or its
  `HOME`, because a turn can plant config, extensions and `!command` keys
  there. The board never reads a credential value from the worker store and
  never resolves or runs a key a worker could plant (R5-1, unchanged). The
  only worker-store write is the cause string above.
- The entry script does not copy the shared `agent.db` into the board store.
- The board's git ssh runs with `-F /dev/null` (`gitAuthEnv` in `src/gitHosts.ts`).
  ssh reads `~/.ssh/config` from the passwd home (`/root`), not from `$HOME`, and
  `/root` is the shared home. Without the flag, a `ProxyCommand` or `Match exec` that a
  worker plants there runs in the board's git fetch or push over ssh (OTTR-264).

#### Residuals

What still trusts what: a main checkout's `.git/config` stays worker-writable, by
construction of linked worktrees — worktrees share the common gitdir (per-worktree index
writes, ref updates), so no read-only mount can wall the config off without breaking git
inside the worktrees, and projects are onboarded at run time, so compose cannot pre-mount
each config. The board's network subcommands still read `credential.helper`,
`core.sshCommand` and `url.*.insteadOf` from that file. Turn processes run shell git with
whatever the turn's env holds. Closing the board's repo-config reads fully is code-side
work in `src/worktree.ts` (per-call `-c` overrides and the `sealedGit` stub gitdir), not
topology. The stub copies only these probed keys from the repo config:
`core.filemode`, `symlinks`, `ignorecase`, `precomposeunicode`, `autocrlf` and `eol`. These
keys control only the builtin conversion of git. For a partial clone, the stub also copies
the promisor remote keys, which only the lazy blob fetch reads (pinned, see above). A new
board call that merges in a worker
checkout must use the stub or pin the merge driver. On the omp side, omp
writes the http-400 dump directory under `$HOME/.omp/logs` of the HOME it runs with,
because its state root does not follow `PI_CODING_AGENT_DIR`. The reader in
`src/runner.ts` thus scans the shared home and the board's omp home, plus each home's
current layer at read time ([The agent layers](#the-agent-layers)). The board reads only
file names there, never the request bodies, so a plant forges a name in one failure message
at worst. Project skills and context files (`.agents/skills`, `AGENTS.md` in the checkout
and its parents) stay worker-writable, the same as the main checkout's `.git/config`.
A worktree's own `.omp` tree is untrusted the same way, so every board-side omp run
(`buildOmpArgs`) passes `--no-extensions --no-lsp` and the
`extension/no-discovery.yml` overlay (`mcp.enableProjectConfig: false`): discovered
extensions, plugins, language servers, and project MCP servers from the worktree never
load, and the explicit tracker extension still does.

### The data boundary

The spec is `docs/specs/server-only-project-state.md`.

Server-only, in `/app/.tasks/projects/<project>/` on the `ottr-state` volume:

- `tasks.db`. It holds the project settings, for example `releaseCommand`, and the task rows, for example worktree paths.
- The fork mirror caches (`forks/<id>.git`).
- The cwd of the fork `ls-remote` call.

Shared, in `/data/<project>/` on the `ottr-data` volume: sessions, logs, images,
handoffs, quarantine, release notes and the project icon.

Why: a worker can write each file on `/data`. With this split, such a worker cannot change
the release command or other settings that the server runs. It cannot change the trusted
paths of a task or the git config of a fork cache.

Project discovery counts only a `tasks.db` in the server dir. A `tasks.db` that a worker
writes below `/data` makes no project.

Upgrade: at the first boot with both `OTTR_DATA_DIR` and `OTTR_SERVER_DATA_DIR`, the board
copies each old `/data/<project>/tasks.db` to the server dir one time:

- After the copy, the board writes the marker `/app/.tasks/projects/.adopted`. It does not copy again.
- The board renames each old file to `tasks.db.moved-to-server`. You can delete it.
- When a copy fails, the boot log names the project. The project stays off the board.
- To move a failed project by hand, do these steps. The image has no `sqlite3`, so use bun:
  1. Repair the cause that the boot log names, for example a corrupt file.
  2. Run `docker compose exec server mkdir -p /app/.tasks/projects/<project>`.
  3. Run `docker compose exec server bun -e 'new (require("bun:sqlite").Database)("/data/<project>/tasks.db").run("VACUUM INTO ?", ["/app/.tasks/projects/<project>/tasks.db"])'`.
  4. Rename the old file to `tasks.db.moved-to-server`.
  5. Restart the board (`docker compose restart server`).

The copy keeps all values as they are. A worker could write a value before the upgrade.
Thus, after the upgrade, examine the Release command setting of each project.

The old caches in `/data/<project>/forks/` stay unused. You can delete them. The next fork
run makes a new cache in the server dir.

Residual risk: session files stay worker-written, and later turns resume them. This is by
design. Without `OTTR_SERVER_DATA_DIR`, the board logs a warning and keeps the old layout.

### Writes on the shared volumes

Workers mount the `ottr-data` volume and the `workspace` volume read-write. Thus a turn can
put a symlink at any path on them, for example at `/data/<project>/quarantine/<task>`. The
board must not follow such a symlink, because the symlink can point into the server
container filesystem, for example to `/app/src` or `/etc/ottr`.

Every board write below a task data dir goes through `src/confine.ts`: task logs, images,
the project icon, handoffs, release notes, the image quarantine, and the quarantine of
untracked worktree files. These helpers start at a trusted anchor (`OTTR_DATA_DIR`, or the
project checkout outside compose) and open one path component at a time with `O_NOFOLLOW`
through `/proc/self/fd`. A symlink at the file or at a parent below the anchor stops the
write with a `refusing <path>` error. There is no check-then-write race. The quarantine
also reads each source this way from the worktree, so a symlink cannot make the board copy
or delete a server file. The guard works only on Linux. The compose server always runs on
Linux.

The board writes on the `workspace` volume go through `src/confine.ts` too. The anchor is
the `OMP_TRACKER_ROOTS` entry that holds the project checkout (in compose, the `/workspace`
mount). Thus the board also refuses a project checkout that a worker replaced with a
symlink. Without such a root, the anchor is the project checkout. When a worktree is outside
the checkout, the anchor is the parent dir of that worktree. These writes are:

- The copy of `AGENTS.md`, `.omp` and the copy paths into a new worktree (`createWorktree`).
- The entries that the board adds to `.git/info/exclude` (`createWorktree`, `ignoreInMain`).
- The copy of kept files from a worktree into the main checkout (kept files finish).
- The removal of a worktree directory (`removeWorktree`, and the scratch directory that an
  interrupted `git worktree add` leaves).

A copy writes a symlink as a link and never reads its target. When a relative link target
is outside the source tree, the copy changes it so that the new link names the same path.
A removal deletes a symlink itself and never the target. A symlink at a parent below the
anchor, for example at `.worktrees` or `.git/info`, stops the operation with a
`refusing <path>` error. A git dir outside the project checkout gets no exclude entry: the
board refuses it, because a worker can point `.git` at any dir.

Limits: omp writes its own session files in `sessions/` for turns that the board runs. This
guard does not cover them.

## Crash recovery

A worker's lifetime is one turn and it owns no state: sessions and logs
live on the shared volume, and the DB lives on the server's `ottr-state` volume. If a worker dies, the server detects the lost
connection (`workerLost`) and the card auto-resumes by starting a new turn —
the same recovery path as a tracker restart. `restart: always` revives a
crashed or OOM-killed worker container; note Docker suppresses that policy
after a manual `docker stop`/`docker kill` — `docker start` brings it back.

## Troubleshooting

### Podman Desktop shows no containers (Windows)

Symptom: `podman ps` lists the stack, but Podman Desktop shows no containers.

Cause: `podman machine start` failed halfway, so the Windows API pipe `\\.\pipe\docker_engine` does not exist and `win-sshproxy.exe` does not run. The start output shows:

```
failed creating the cgroupfs config file: ... /usr/share/containers/containers.conf.d/999-podman-machine-wsl-cgroupfs.conf: No such file or directory
```

The machine image lacks that directory. Fix (PowerShell):

```powershell
wsl -u root -d podman-machine-default mkdir -p /usr/share/containers/containers.conf.d
podman machine stop; podman machine start
```

The start output must then include `API forwarding listening on: npipe:////./pipe/docker_engine`. Keep the CLI default connection on the same side as Podman Desktop: with a rootful machine, use `podman-machine-default-root`.

### The stack starts without provider sign-ins, or recreates fail with `Not a directory`

Two failures from the same cause: `OTTR_OAUTH_DIR` or `OTTR_AGENT_DB` pointing at a
wrong host path. Rootful Podman creates an empty folder for a missing bind source
instead of failing, so the stack starts with broken credential mounts.

Symptom (a): the stack starts, but Settings and turns have no provider sign-in, and
the logs show `ottr-entry:` refusing with the `OTTR_OAUTH_DIR` or `OTTR_AGENT_DB`
message.

Fix: correct the host path in the compose env file and recreate the stack.

Symptom (b): after fixing `OTTR_AGENT_DB`, every `docker compose up` loops with
`crun: mount ... agent.db: Not a directory`. The home volume keeps the empty
`agent.db` folder crun created as the bind mountpoint, and the bind itself is the
thing that fails, so no stack container can reach the folder.

Fix:

```sh
docker compose run --rm home-repair
docker compose up -d
```

The one-off mounts the home volume without the agent.db bind and removes the empty
folder (only an empty one; a real file or a non-empty folder is refused).

### The board times out after the stack was recreated (WSL mirrored networking)

Symptom: after the containers were removed and created again, `http://127.0.0.1:8080` times out, and the network shows `No route to host`.

Cause: with WSL `networkingMode=mirrored`, netavark's nftables DNAT rules for the removed containers survive `podman machine stop`, because the WSL kernel keeps running. The old rule matches `127.0.0.1:8080` first and sends the traffic to a dead container IP.

Fix, one of:

- Stop all WSL distros, which clears the rules: `wsl --shutdown`, then `podman machine start` and start the stack again.
- Delete only the stale rules inside the Podman machine. List them, then delete each stale one by its handle:

  ```sh
  nft -a list chain ip nat NETAVARK-DN-<id>
  nft delete rule ip nat NETAVARK-DN-<id> handle <n>
  ```
