# Workers

Work turns run inside disposable containers built from `Dockerfile.worker`
omp, bun, node, git, git-lfs, gh, procps (`ps`), curl, rtk, ripwire, Chrome for Testing, Godot and
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
broken or yanked release has a week to surface before it ships. The server and the
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
- Unset `OTTR_WORKER_URLS` = local spawn on the server host (the default and
  fallback; `runner.startRun` stays the reference implementation).
- Provider keys pass through from the host shell, and so do the keys a project's
  MCP servers read from its committed `.omp/mcp.json` (the file adds its servers
  only to that project's turns). OAuth credentials come from
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

Compose turns run omp with `memory.backend: hindsight` against the shared Hindsight server.
The server's address travels
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
its push.

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
`.git/config` cannot run with the tokens. Residual limits: a planted
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

### The config boundary

Work turns share the `workspace` and `home` volumes with the board, so a turn can write
`/root/.gitconfig`, `/root/.config/gh`, or a main checkout's `.git/config` — and the board
runs git in that checkout on every scheduler tick, with the GitHub token in its
environment. The board hardens against all three on two layers.

Code: every board git call overrides `core.fsmonitor=false` and `core.hooksPath=/dev/null`
on the command line (command-line config outranks repo and global config), and `GH_TOKEN`
reaches only the network subcommands (`clone`, `fetch`, `ls-remote`, `pull`, `push`);
local subcommands such as `status` run without it.

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
creates this directory empty and logs an `ottr-entry: R5-1:` line while it is unseeded.
The agent layer comes only from the trusted `board-seed` service, a one-off of the Alate
image (see [Seed the board config](#seed-the-board-config)). At the next start, the entry
script flips `memory.backend` in the seeded `config.yml`. The board's own config readers
(`src/models.ts` model roles, the Settings hindsight flip, the sign-in store in
`src/login.ts`) resolve the same variable. A worker dispatch strips the variable from the
turn env: a worker keeps its shared home, and a turn that ran locally would otherwise hold
the directory the board executes. The board's layer does not follow Alate provisions of
the shared home. After a data-repo change, run `board-seed` again.

omp does not resolve every user path from that variable. It reads plugins from
`$HOME/.omp/plugins` and user skills and context files (`~/.agents`, `~/.claude`, and the
other tool dirs) from `$HOME`. The board's `$HOME` is the shared home. So the compose file
also sets `OTTR_BOARD_OMP_HOME=/etc/ottr/home`, and every omp that the board starts for
itself gets that directory as its `HOME`: merge, release review and release turns, `omp
models`, `omp usage`, `omp login`, and the fork-analysis gateway (`src/login.ts`
`boardOmpEnv`). The agent dir above lies in this directory. The entry script creates the
directory and copies nothing into it, and refuses to start when the variable points into
the shared home. A worker dispatch removes the variable from the turn env, so a work turn
and its local fallback keep the shared home. The board's own reads of the shared home keep
`/root`: the apt lists, the shared credential store, and the shared `config.yml` of the
hindsight flip.

#### Seed the board config

Do these steps once after the first `docker compose up`. Do them again after each
data-repo change that the board's own turns need. The first deploy of this change also
needs them: an existing stack starts with an empty `board-config` volume.

1. Run the seed. For a private data repo, export `GH_TOKEN` first:
   `docker compose run --rm board-seed --repo <owner/name>`.
   To use a local checkout of the data repo, run
   `docker compose run --rm -v <data-repo>:/data:ro board-seed --data /data`.
2. Restart the board: `docker compose restart server`.
3. Sign in once under **Settings → Provider sign-in**. Alternatively, pass provider API
   keys (`ANTHROPIC_API_KEY`, ...) in the env.

The seed uses the same SkillSpector scan as worker provisioning, and a failed scan stops
it. `--force` lets the data repo win over board-local edits. The seed installs the whole
user layer under `/etc/ottr/home`, which is the board's omp home (`OTTR_BOARD_OMP_HOME`,
see above). This includes the plugins in `/etc/ottr/home/.omp/plugins` and the user skills
in `/etc/ottr/home/.agents/skills`.

To verify the seed:

- `docker compose logs server` shows no `ottr-entry: R5-1:` line about an unseeded agent
  dir.
- `docker compose exec server ls /etc/ottr/home/.omp/agent` lists `config.yml`, `rules`
  and `skills`.
- `docker compose exec server env HOME=/etc/ottr/home omp plugin list` lists the data
  repo's plugins.

#### Credentials

Credentials split with the directory: Settings sign-in runs `omp login` against the
pinned store, then `src/login.ts shareProviderCredentials` copies the provider's rows
through to the shared store the workers read; sign-out copies the same rows with omp's
"deleted by user" tombstones. The entry script does not copy the shared `agent.db` into
the pinned store. The board signs in under **Settings → Provider sign-in**, and its store
stays on the `board-config` volume. Refresh-token rotation happens in whichever copy
refreshes first, so the other copy's row can go stale until the next sign-in. omp then
marks the row inactive after a failed refresh, and Settings shows the provider as
needing sign-in. The write-through is never silent: a failed copy reaches the sign-in
view and the logout response as `syncError`.

#### Residuals

What still trusts what: a main checkout's `.git/config` stays worker-writable, by
construction of linked worktrees — worktrees share the common gitdir (per-worktree index
writes, ref updates), so no read-only mount can wall the config off without breaking git
inside the worktrees, and projects are onboarded at run time, so compose cannot pre-mount
each config. The board's network subcommands still read `credential.helper`,
`core.sshCommand` and `url.*.insteadOf` from that file. Turn processes run shell git with
whatever the turn's env holds. Closing the board's repo-config reads fully is code-side
work in `src/worktree.ts` (per-call `-c` overrides), not topology. On the omp side, omp
writes the http-400 dump directory under `$HOME/.omp/logs` of the HOME it runs with,
because its state root does not follow `PI_CODING_AGENT_DIR`. The reader in
`src/runner.ts` thus scans the shared home and the board's omp home. The board reads only
file names there, never the request bodies, so a plant forges a name in one failure message
at worst. Project skills and context files (`.agents/skills`, `AGENTS.md` in the checkout
and its parents) stay worker-writable, the same as the main checkout's `.git/config`.

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
the project checkout. When the git dir or a worktree is outside the checkout, the anchor is
that git dir or the parent dir of that worktree. These writes are:

- The copy of `AGENTS.md`, `.omp` and the copy paths into a new worktree (`createWorktree`).
- The entries that the board adds to `.git/info/exclude` (`createWorktree`, `ignoreInMain`).
- The copy of kept files from a worktree into the main checkout (kept files finish).
- The removal of a worktree directory (`removeWorktree`, and the scratch directory that an
  interrupted `git worktree add` leaves).

A copy writes a symlink as a link and never reads its target. A removal deletes a symlink
itself and never the target. A symlink at a parent below the anchor, for example at
`.worktrees` or `.git/info`, stops the operation with a `refusing <path>` error.

Limits: omp writes its own session files in `sessions/` for turns that the board runs. This
guard does not cover them.

## Crash recovery

A worker's lifetime is one turn and it owns no state: sessions and logs
live on the shared volume, and the DB lives on the server's `ottr-state` volume. If a worker dies, the server detects the lost
connection (`workerLost`) and the card auto-resumes by starting a new turn —
the same recovery path as a tracker restart. `restart: always` revives a
crashed or OOM-killed worker container; note Docker suppresses that policy
after a manual `docker stop`/`docker kill` — `docker start` brings it back.
