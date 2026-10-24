# Workers

Work turns run inside disposable containers built from `Dockerfile.worker`
(decision D1): omp, bun, node, git, git-lfs, gh, procps (`ps`), curl, rtk, ripwire, Chrome for Testing, Godot and
the language servers for omp's `lsp` tool (TypeScript 7's `tsc`, typescript-language-server, pyright)
are pinned at build time, so a turn's toolchain is a property of the image, not the host.
Chrome sits at `/opt/google/chrome/chrome`, where the agent layer's chrome-devtools MCP
server looks for it, and Godot is `godot` on PATH, where Godot projects' turns and their
godot MCP server find it; without a display it starts headless. The agent layer (rules,
config, skills, plugins) is not in the image: alate
provisions it from its data repo snapshot into the shared home volume (`/root`), and runs
chrome-devtools there headless, isolated and without Chrome's sandbox (workers run as
root). Skill folders are statically scanned for prompt injection, exfiltration,
credential harvesting, and supply-chain risk (NVIDIA SkillSpector, static mode) before
Alate provisions them from your data repo. Release reviews need the `security-audit` skill of this layer. On a runner without
the skill, the review stops with needs_you. curl serves the impeccable skill of this layer:
its launcher downloads the engine that a skill update needs. Every Node process preloads
`src/stryker-tap.cjs` (`NODE_OPTIONS`): in a `stryker run`, it copies the output to
`/tmp/ottr-stryker-<pid>.log`, so the running card shows the progress of a mutation run
even when the agent's command sends the output into a pipe (rtk). The build needs no credentials:

```sh
docker compose build
docker compose up -d
```

The board also provisions on its own: every 5 minutes it reads the alate server's
`GET /health`, and when the server reports an unprovisioned import (`pending`) and no
turn is preparing or running, it calls the same provisioning API as
**Settings → Alate → Provision now**. A failed attempt waits an hour before it tries
again; the error shows in the Alate settings section.

At run time git authenticates with the board's GitHub token (asked for at
onboarding, replaced under **Settings → GitHub**): the server exports it as
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

## Updates

omp is the main tool and gets a new release almost every day, so the image follows the
newest omp that is 7 or more days old: workers run about one week behind npm, so a
broken or yanked release has a week to surface before we ship it. The server and the
workers run this one image, so the board, merge
turns and work turns all get the new omp. Two parts do the work:

1. The workflow `.github/workflows/omp-bump.yml` runs every 6 hours on GitHub. When npm
   has an omp that is 7 or more days old and newer than `OMP_VERSION` in
   `Dockerfile.worker`, it starts that omp on
   the image's bun, then pushes `chore: bump omp to <version>` to `main`. It is the
   only place that moves the pin. The pin sits above the omp layer, near the end of
   the file, so a bump rebuilds only the last layers.
2. Each host that runs the stack deploys `main` with `scripts/update-image.ts`, from
   a clean `main` checkout. It fast-forwards `main` and builds the image. When the
   board runs and no turn runs, it restarts the stack (`docker compose up -d --wait`
   recreates only the containers whose image changed, then waits for the `/api/boot`
   healthcheck, so a board that never comes healthy fails the run instead of
   logging success) and removes the old images. When the build gives the server a
   new image, the script first holds new turns on the board (`POST /api/drain`, 30
   minutes per call). The running turns finish, and no new turn, merge or release
   starts. The card of the **Check the board** button is the one exception: it only
   reads the board, so it starts at once, and the restart waits for it like for any
   other turn. The hold carries the subjects of the commits the restart brings, and the
   board lists them under the update notice. The board's **Notices** shows the hold.
   The script counts the turns every 30 s and renews the hold each time. When no turn
   runs, it restarts the stack at once. A hold lasts at most 1 hour. If turns still run
   then, the script ends the hold (`DELETE /api/drain`), so the queued cards start, and
   a later run tries the restart again. Thus a long turn, for example a mutation run of
   several hours, stops new turns for 1 hour at most. While it waits, the scheduled task starts no
   second run (`-MultipleInstances
   IgnoreNew` below), so the restart uses the image that this run built, and a later
   run deploys newer commits. If the board refuses a renewal, the script stops
   waiting, and the hold stops 30 minutes after the last renewal. An unchanged image,
   and a board too old for the hold, keep the old rule: while turns run, the old
   containers stay until a later run. When no board runs at all, it restarts without
   counting turns. It stops when the checkout has uncommitted changes or commits that
   origin lacks, when `docker compose ps` fails, or when it cannot compare the
   server's image with the build. It never pushes: a host needs read access to the
   repo only.

3. A host-only override can build further services from their own local git checkouts
   (the compose files in this repo name none, so the script discovers them in
   `docker compose config`). A person can work in such a checkout, so the build never
   reads it. Each run builds the service from a fresh worktree of the checkout's
   `origin/main`, with one more compose file that sets only the build context. Files and
   commits in the checkout itself never reach the image. A cached build is cheap, and a
   build that changes the running image restarts that service at once
   (`up -d --no-deps --wait`). Such a restart needs no idle board: no turn calls the
   service — a worker installs the packages the shared home volume already holds, and the
   board's provision trigger fires only when no turn runs. The checkout itself
   fast-forwards to `origin/main` only when it is clean and on `main`. Else it stays as it
   is, with one log line.

The deploy also brings new Ottr commits from `main`. The script's arguments go to
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

The containers take pass-through keys such as `PIXELLAB_API_KEY` from the
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

The image carries no project's system packages, with two exceptions: git-lfs,
because the server checks LFS files out when it creates a worktree, before any
list installs, and Godot, which has no Debian package. A project lists the Debian
packages its turns need in the data repo as `workers/<project>/apt.txt`: one
package per line, `#` comments allowed. For example, a project with UI changes
lists the shared libraries and fonts Chrome needs, so omp's browser tool (it
downloads Chrome into the home volume) can take the screenshot. Alate provisions
the lists to `~/.ottr/workers/<project>/apt.txt` in the home volume. A worker
installs every list when it starts, so a project's first turn there does not wait;
its log (`docker compose logs worker-a`) names what was installed, and a list that
fails does not stop the others. Before a turn starts, the container that runs it
installs the packages it still lacks: a worker for work turns, the server for merge
turns. The turn log names what was installed. An install that fails stops the turn
with apt's error. The packages stay until the container is recreated.

## Env settings

- Server: `OTTR_WORKER_URLS` (comma-separated, e.g.
  `http://worker-a:8787,http://worker-b:8787`) selects remote dispatch;
  `OTTR_WORKER_TOKEN` (required, a random secret) authenticates workers. A
  worker strips it from every turn's env, since turns could otherwise drive
  any worker.
- Server: `OTTR_DATA_DIR=/data` keeps every project's task data (DB,
  sessions, logs, images, handoffs) on the `ottr-data` volume instead of in
  the clones. Server and workers mount it at `/data`, and the clones at
  `/workspace`, so the absolute paths in a run request resolve the same in
  every container.
- `OTTR_BOARD_URL` is the address task sessions' `create_task` tool POSTs to;
  the default is `http://127.0.0.1:<port>`, which in a worker container is the
  worker itself, so compose sets `http://ottr:<port>` (`ottr` is the server's
  network alias). No allowlist covers that host, so the board opens it to one
  request only: filing a card with the token it hands every task session
  (`OTTR_BOARD_TOKEN`, new on each board start). Without the token it answers
  401, and every other route there answers 403, even with the token. A turn
  that outlives a board restart holds a stale token: its card filing fails
  with 401.
- Unset `OTTR_WORKER_URLS` = local spawn on the server host (the default and
  fallback; `runner.startRun` stays the reference implementation).
- Provider keys pass through from the host shell, and so do the keys a project's
  MCP servers read (`PIXELLAB_API_KEY` for mystic-realms, whose committed
  `.omp/mcp.json` adds its servers only to its own turns). OAuth credentials come from
  the host omp oauth dir, mounted read-only into every container via
  `OTTR_OAUTH_DIR` (required; for example `C:/Users/<you>/.omp/oauth`). omp's provider credentials live in `agent.db`
  (`auth_credentials`). The server and the workers share one such file, bind-mounted
  at `/root/.omp/agent/agent.db` via `OTTR_AGENT_DB`: seed it once with a consistent
  copy of the host's (`VACUUM INTO`, never the hot file), so nothing secret is baked.
  Then log the stack in by itself, once per OAuth provider it uses: **Settings →
  Provider sign-in** on the board, or `docker compose exec server omp login <provider>`.
  The server publishes the sign-in callback ports of Anthropic (54545) and OpenAI
  Codex (1455) on `127.0.0.1`, so the provider's redirect reaches the board, which
  finishes the sign-in. Codex's port is fixed: while the stack runs, `omp login
  openai-codex` on the host cannot bind it.
  Never copy the host's file over it again. A copied login shares its refresh token
  with the host, and a provider that rotates refresh tokens (Anthropic does) accepts
  only the side that refreshes first: omp disables the other side's login
  (`invalid_grant`), on the host or in the stack.

## Scaling

Workers are copy-paste blocks of the `x-worker` anchor in
`docker-compose.yml`: add `worker-c`, then append
`http://worker-c:8787` to `OTTR_WORKER_URLS`. Do not use
`docker compose --scale`: round-robin DNS breaks cancel routing; per-run
addressability needs stable names. Worker containers are never port-mapped
to the host.

## Fleet memory (Hindsight)

Compose turns run omp with `memory.backend: hindsight` against the shared Hindsight server
(it replaced the embedded `hindsight` service on 2026-10-08). The server's address travels
as `HINDSIGHT_API_URL`: docker-compose.yml interpolates it from the environment
(`${HINDSIGHT_API_URL:-}`), so set it in the compose env file (the `--env-file` that
`scripts/update-image.ts` passes) or in the shell that runs compose, for example
`HINDSIGHT_API_URL=http://hindsight.local:8888`. **Settings -> Hindsight** can also save
the address; a URL saved there beats the env seed at every boot, and the board switches
the shared `config.yml`'s backend itself when a saved URL comes into effect, so Settings
alone turns fleet memory on. An empty or unset value
keeps omp's
`mnemopi` default: the stack boots without fleet memory, and nothing crashes. The entry
script switches the backend in containers that carry a non-empty `HINDSIGHT_API_URL`, and
since server and workers share the home volume (one
`config.yml`), the whole compose topology runs hindsight — worker turns and server-side
merge turns alike. Mnemopi remains the default backend for direct spawns outside compose
(the host local-spawn fallback).

The server requires its tenant API key on every request. Set it under **Settings ->
Hindsight** (the same place holds the server address): the board saves a key only after
the server at the effective address accepts it (`GET
/v1/default/banks`), stores it in `.tasks/tracker.db` and hands it to every new turn as
`HINDSIGHT_API_TOKEN`, which omp reads over `config.yml`. Worker turns get it through the
env the board forwards. `HINDSIGHT_API_TOKEN` in the env file only seeds the key until
Settings holds one. Fact extraction runs on the server and needs LLM balance there.

## Memory proof

Agent memory needs no image work: the backend ships inside the omp binary, the captured
`config.yml` selects it (`memory.backend: mnemopi`, `scoping: global`), and the store lives
on the mounted home volume — the user-layer capture excludes memories by design (decision
doc, D7). The scripted, repeatable proof drives one worker turn over the real HTTP handoff
(`POST /run`, worker token, tracker argv); the turn retains a fresh pass word and recalls
the previous run's word from the memory backend:

```sh
docker compose exec -T server bun - < scripts/compose-memory-proof.ts
```

First run on a fresh volume only seeds (nothing to recall yet); every later run must recall
the previous run's word or the script exits non-zero. The assertions read artifacts, not
model prose: the retain must appear either in the local store's `working_memory`
(mnemopi mode, queried read-only in the server container, which shares the workers' home
volume) or in this turn's session files (hindsight mode), and the recalled word must appear
in this turn's session files — the prompt carries a per-run round key, never the previous
word, so only the memory backend can supply it. `PROOF_WORKER_URL`, `PROOF_CWD` and
`OTTR_WORKER_TOKEN` override the defaults.

## What stays server-side (D6)

Worktree create/remove, the merge turn, the release fast-forward and
`git push origin main` all run in the server container. Workers execute turn
processes only; push credentials never leave the server: `startRun` strips the
board's `GH_TOKEN` from the env it forwards to a worker.

### Non-GitHub hosts

A project on a git host other than GitHub clones, fetches and pushes with the
same rule: credentials stay on the server. Two credential kinds exist
([docs/specs/git-hosts.md](specs/git-hosts.md)):

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
  name (D6).

Server-side git is the only holder of these credentials. Each network call also
resets the repo-config credential helpers (then re-adds the global and system
ones), disables `ext::` transport, signed pushes and askpass, and always sets
`GIT_SSH_COMMAND`, so config that a turn plants in a main checkout's
`.git/config` cannot run with the tokens. Residual (R5-1): a planted
`remote.<name>.uploadpack` or `receivepack` on a local-path remote still runs,
because git keeps the first value it reads. A planted `http.<url>.proxy` with
`http.<url>.sslVerify=false` can also see a token, because git prefers the most
specific URL match over the env value. No turn's shell sees
them. For a project without a GitHub remote, the server pushes the merged target
to `origin` after the merge turn ends.

The card of the dev-only **Check the board** button also runs in the server container.
Only loopback there reaches the full board API. On the turns' host (`OTTR_BOARD_URL`), a
worker's turn can only file cards. The board marks the check card in the project store when
the button files it, so a card that an agent files with the same prompt still runs on a
worker.

### The config boundary (R5-1)

Work turns share the `workspace` and `home` volumes with the board, so a turn can write
`/root/.gitconfig`, `/root/.config/gh`, or a main checkout's `.git/config` — and the board
runs git in that checkout on every scheduler tick, with the GitHub token in its
environment. The board hardens against all three on two layers.

Code: every board git call overrides `core.fsmonitor=false` and `core.hooksPath=/dev/null`
on the command line (command-line config outranks repo and global config), and `GH_TOKEN`
reaches only the network subcommands (`clone`, `fetch`, `ls-remote`, `pull`, `push`);
local subcommands such as `status` run without it.

Topology: the compose file pins the board service's `GIT_CONFIG_GLOBAL` and
`GH_CONFIG_DIR` to the container filesystem (`/etc/ottr/…`), which no worker mounts. The
entry script seeds the global git config from the provisioned home at every board start
(skipped when something is mounted at that path on purpose), and gh starts empty on
purpose, because gh config can name commands. A config planted in the shared home never
reaches the board's git or gh while the stack runs; re-provisioning plus a board restart
refreshes the seed. The system-level credential helper is baked into the image, outside
every volume, and answers only for github.com when `GH_TOKEN` is set.

The same boundary covers the board's own omp agent layer. A worker-plantable
`~/.omp/agent/config.yml` could reassign the `modelRoles` the release review runs on, and
planted skills, extensions or plugins would load into the board's privileged turns (merge,
release review, release). The compose file pins the board's `PI_CODING_AGENT_DIR` to
`/etc/ottr/omp-agent` — omp resolves its whole agent dir (config.yml, agent.db, skills,
extensions, plugins, sessions) from that variable. The entry script seeds the directory
once from the provisioned home at board start, after the memory-backend flip, so the seed
carries the flipped `memory.backend`. The board's own config readers (`src/models.ts`
model roles, the Settings hindsight flip, the sign-in store in `src/login.ts`) resolve the
same variable, and a worker dispatch strips the variable from the turn env: a worker keeps
its shared home, and a turn that ran locally would otherwise hold the directory the board
executes. A plant made in the shared home after board start reaches neither.

Credentials split with the directory: Settings sign-in runs `omp login` against the
pinned store, then `src/login.ts shareProviderCredentials` copies the provider's rows
through to the shared store the workers read; sign-out copies the same rows with omp's
"deleted by user" tombstones. Two consequences live with this design. Refresh-token
rotation happens in whichever copy refreshes first, so the other copy's row can go stale
until the next sign-in or the next board restart (the seed re-snapshots the shared file);
omp then marks the row inactive after a failed refresh and Settings shows the provider as
needing sign-in. And the write-through is surfaced, never silent: a failed copy reaches
the sign-in view and the logout response as `syncError`.

What still trusts what: a main checkout's `.git/config` stays worker-writable, by
construction of linked worktrees — worktrees share the common gitdir (per-worktree index
writes, ref updates), so no read-only mount can wall the config off without breaking git
inside the worktrees, and projects are onboarded at run time, so compose cannot pre-mount
each config. The board's network subcommands still read `credential.helper`,
`core.sshCommand` and `url.*.insteadOf` from that file, and the seed is a snapshot: a
config written to the shared home before the board started rides along until the next
re-provision and restart. Turn processes run shell git with whatever the turn's env
holds. Closing the board's repo-config reads fully is code-side work in `src/worktree.ts`
(per-call `-c` overrides), not topology. On the omp side, the http-400 dump directory
stays under `$HOME/.omp/logs`: omp's state root does not follow `PI_CODING_AGENT_DIR`, so
the reader in `src/runner.ts` must follow the writer; the board reads only file names
there, never the request bodies, so a plant forges a name in one failure message at
worst.

## Crash story (D3)

A worker's lifetime is one turn and it owns no state: sessions, DB and logs
live on the shared volume. If a worker dies, the server detects the lost
connection (`workerLost`) and the card auto-resumes by starting a new turn —
the same recovery path as a tracker restart. `restart: always` revives a
crashed or OOM-killed worker container; note Docker suppresses that policy
after a manual `docker stop`/`docker kill` — `docker start` brings it back.
