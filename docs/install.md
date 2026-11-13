# Install and setup

## Requirements

- Windows 10/11 or Linux, with [Bun](https://bun.sh) ≥ 1.4.2, git, and `omp` on `PATH`. (macOS is not supported yet.)
- `gh` ([GitHub CLI](https://cli.github.com)) only for releases, when **Settings** holds no GitHub token.
- omp must run its tools without approval prompts; a one-shot `omp -p` run cannot answer them.
- Ottr seals the token and key fields of `.tasks/tracker.db` at rest with the SecretBox key (`OTTR_SECRET_KEY` env wins, `.tasks/secret.key` next to `tracker.db` is the fallback). The sealed fields are: GitHub token, API key, session secret, per-host git tokens, GitHub App key, Alate key, Hindsight API key, the secret env values, and the Web Push private key. The database snapshots hold the sealed values. Treat that file as a credential store, together with its key, and protect the backup dir the same way. [ADR-0011](adr/0011-sealed-token-fields-encrypted-volumes.md) also records: run the state volume, the backup dir, and the SSH key dir on an encrypted volume.

## Quick start

Docker Compose is the preferred way to run Ottr: the board and its worker containers share one image, so every turn gets the same pinned toolchain, and a restart of the host machine brings the whole stack back. The stack is one file, [`docker-compose.yml`](../docker-compose.yml).

Every turn and the board's own git calls commit with a default identity (`Ottr <ottr@localhost>`) when the project or the home's git config names none. Change it under **Settings → Git and integrations → Git identity → Commit identity**; a configured `~/.gitconfig` identity wins over the default, and the Settings identity wins over the home's git config when the board git-inits a project.
For a new project, the board ignores an identity that Git infers from the OS or hostname.

### Latest release (no clone, no build)

Each GitHub release publishes the image as `ghcr.io/ottr-ai/ottr` (amd64), with the tags `<version>`, `v<version>` and `latest`. The image is public, so the pull needs no login. These lines fetch the compose file of the latest release and run that release's image.

Linux and macOS (bash, zsh):

```sh
mkdir -p ottr && cd ottr
TAG=$(curl -fsSL https://api.github.com/repos/ottr-ai/ottr/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
curl -fsSLo docker-compose.yml "https://raw.githubusercontent.com/ottr-ai/ottr/$TAG/docker-compose.yml"
export OTTR_IMAGE=ghcr.io/ottr-ai/ottr:$TAG             # the image of the same release
export OTTR_WORKER_TOKEN=$(openssl rand -hex 32)   # server-to-worker auth
export OTTR_OAUTH_DIR=~/.omp/oauth                 # provider sign-ins, read-only
mkdir -p "$OTTR_OAUTH_DIR"                         # Podman refuses a missing mount source
export OTTR_AGENT_DB=~/.omp/ottr-agent.db          # the stack's own omp auth db
# Turn Alate on (skip this when an Alate server already runs). The three settings
# go into .env once, so updates and new shells keep the same key.
[ -f .env ] || cat > .env <<EOF
COMPOSE_PROFILES=alate
ALATE_URL=http://alate:4570
ALATE_API_KEY=$(openssl rand -hex 32)
# OTTR_GITHUB_HOST=acme.ghe.com   # set before onboarding when GitHub lives on *.ghe.com
EOF
# Seed it once with a consistent copy of the host db. Never mount the live file.
[ -e "$OTTR_AGENT_DB" ] || bun -e 'new (require("bun:sqlite").Database)(process.argv[1], { readonly: true }).run("VACUUM INTO ?", [process.argv[2]])' ~/.omp/agent/agent.db "$OTTR_AGENT_DB"
docker compose pull
docker compose up -d --no-build
```

Windows (PowerShell 5.1 or 7):

```powershell
New-Item -ItemType Directory -Force ottr | Out-Null; Set-Location ottr
$TAG = (Invoke-RestMethod https://api.github.com/repos/ottr-ai/ottr/releases/latest).tag_name
Invoke-WebRequest -UseBasicParsing -OutFile docker-compose.yml "https://raw.githubusercontent.com/ottr-ai/ottr/$TAG/docker-compose.yml"
$env:OTTR_IMAGE = "ghcr.io/ottr-ai/ottr:$TAG"       # the image of the same release
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$env:OTTR_WORKER_TOKEN = -join ($b | ForEach-Object { $_.ToString('x2') })   # server-to-worker auth
$env:OTTR_OAUTH_DIR = "$HOME\.omp\oauth"            # provider sign-ins, read-only
New-Item -ItemType Directory -Force $env:OTTR_OAUTH_DIR | Out-Null   # Podman refuses a missing mount source
$env:OTTR_AGENT_DB = "$HOME\.omp\ottr-agent.db"     # the stack's own omp auth db
# Turn Alate on (skip this when an Alate server already runs). The three settings
# go into .env once, so updates and new shells keep the same key.
if (-not (Test-Path .env)) {
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $key = 'ALATE_API_KEY=' + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
  @('COMPOSE_PROFILES=alate', 'ALATE_URL=http://alate:4570', $key, '# OTTR_GITHUB_HOST=acme.ghe.com') | Set-Content .env
}
# Seed it once with a consistent copy of the host db. Never mount the live file.
if (-not (Test-Path $env:OTTR_AGENT_DB)) { bun -e 'new (require(''bun:sqlite'').Database)(process.argv[1], { readonly: true }).run(''VACUUM INTO ?'', [process.argv[2]])' "$HOME\.omp\agent\agent.db" $env:OTTR_AGENT_DB }
docker compose pull
docker compose up -d --no-build
```

The compose file and the image come from the same tag, so they always match. To update to a newer release, run the same lines again from the folder above `ottr`. The `[ -e … ]`, `Test-Path`, and `[ -f .env ]` guards keep the existing `agent.db` snapshot and the same Alate key, and the named volumes keep the board data. Set `OTTR_GITHUB_HOST` before onboarding: uncomment the `# OTTR_GITHUB_HOST=acme.ghe.com` line in `.env` and replace the example host with yours (compose ignores the line while it stays commented); otherwise a `*.ghe.com` token is checked against `github.com`, so the expiry probe and the GitHub API calls would aim at the wrong host.

The `export` and `$env:` values live only in the current shell. Compose also reads a `.env` file in the same folder by itself, so put the values there (one `NAME=value` per line, for example `OTTR_WORKER_TOKEN=...`) and a new shell needs no exports. Windows: compose gives the shell environment priority over `.env`, so a stale `OTTR_*` value keeps the old release or the old paths. Remove the old values first. Run `Remove-Item env:OTTR_*` for the current session. A user-level value (set with `setx` or `[Environment]::SetEnvironmentVariable`) survives new shells; remove it the same way, for example `[Environment]::SetEnvironmentVariable('OTTR_IMAGE', $null, 'User')`. The entry script logs the pinned image tag and the two host paths at start, before its refusal checks, so `docker compose logs server` shows the values even when the stack refuses to start. The Alate lines in the quick start already write the three Alate settings there; keep the `ALATE_API_KEY` line, because the board and alate must share one key.

### From source (main branch)

Linux and macOS (bash, zsh):

```sh
git clone git@github.com:ottr-ai/ottr.git ottr
cd ottr
export OTTR_WORKER_TOKEN=$(openssl rand -hex 32)   # server-to-worker auth
export OTTR_OAUTH_DIR=~/.omp/oauth                 # provider sign-ins, read-only
mkdir -p "$OTTR_OAUTH_DIR"                         # Podman refuses a missing mount source
export OTTR_AGENT_DB=~/.omp/ottr-agent.db          # the stack's own omp auth db
# Turn Alate on (skip this when an Alate server already runs). The three settings
# go into .env once, so updates and new shells keep the same key.
[ -f .env ] || cat > .env <<EOF
COMPOSE_PROFILES=alate
ALATE_URL=http://alate:4570
ALATE_API_KEY=$(openssl rand -hex 32)
# OTTR_GITHUB_HOST=acme.ghe.com   # set before onboarding when GitHub lives on *.ghe.com
EOF
# Seed it once with a consistent copy of the host db. Never mount the live file.
[ -e "$OTTR_AGENT_DB" ] || bun -e 'new (require("bun:sqlite").Database)(process.argv[1], { readonly: true }).run("VACUUM INTO ?", [process.argv[2]])' ~/.omp/agent/agent.db "$OTTR_AGENT_DB"
docker compose build
docker compose up -d
```

Windows (PowerShell 5.1 or 7):

```powershell
git clone git@github.com:ottr-ai/ottr.git ottr
Set-Location ottr
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$env:OTTR_WORKER_TOKEN = -join ($b | ForEach-Object { $_.ToString('x2') })   # server-to-worker auth
$env:OTTR_OAUTH_DIR = "$HOME\.omp\oauth"            # provider sign-ins, read-only
New-Item -ItemType Directory -Force $env:OTTR_OAUTH_DIR | Out-Null   # Podman refuses a missing mount source
$env:OTTR_AGENT_DB = "$HOME\.omp\ottr-agent.db"     # the stack's own omp auth db
# Turn Alate on (skip this when an Alate server already runs). The three settings
# go into .env once, so updates and new shells keep the same key.
if (-not (Test-Path .env)) {
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $key = 'ALATE_API_KEY=' + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
  @('COMPOSE_PROFILES=alate', 'ALATE_URL=http://alate:4570', $key, '# OTTR_GITHUB_HOST=acme.ghe.com') | Set-Content .env
}
# Seed it once with a consistent copy of the host db. Never mount the live file.
if (-not (Test-Path $env:OTTR_AGENT_DB)) { bun -e 'new (require(''bun:sqlite'').Database)(process.argv[1], { readonly: true }).run(''VACUUM INTO ?'', [process.argv[2]])' "$HOME\.omp\agent\agent.db" $env:OTTR_AGENT_DB }
docker compose build
docker compose up -d
```

PowerShell 5.1 drops double quotes inside the arguments of native programs, so the PowerShell `bun -e` line uses only single quotes in its JavaScript.

### Podman

Podman runs the stack too. The Windows + podman-compose notes below are as reported by a
user on Windows 11 (Podman 6.1.4, rootful, WSL machine; podman-compose 1.6.0) — the
project has no Windows machine to verify them.

- `podman compose` needs a compose provider. Use Docker Compose v2 (`winget install Docker.DockerCompose`, then `$env:PODMAN_COMPOSE_PROVIDER = "docker-compose"`), or `pip install podman-compose`.
- Podman has no `local` log driver. Set `OTTR_LOG_DRIVER=k8s-file` (env or `.env`).
- Windows + podman-compose cannot take the host paths as written: `C:\...` does not parse in a short volume mount, and a POSIX path like `/mnt/c/Users/<you>/.omp/oauth` goes through Python `abspath`, becomes `C:\mnt\c\...`, and podman mounts `/mnt/c/mnt/c/Users/...`. Rootful podman creates the missing source as an empty folder, so the stack starts with an empty oauth folder and `agent.db` as a folder — provider sign-in then fails. The entry script refuses to start on the `agent.db` folder and warns on the empty oauth folder. Use Docker Compose v2 as the provider, or:
  - use paths relative to the compose folder, which podman-compose resolves there and the podman client translates into machine paths. From `C:\Users\<you>\ottr`: `OTTR_OAUTH_DIR=../../../../Users/<you>/.omp/oauth` and `OTTR_AGENT_DB=../../../../Users/<you>/.omp/ottr-agent.db`;
  - or switch the two mounts in your compose copy to the long bind syntax (`type: bind`, `source:` the Windows path, `target:` the container path), which podman-compose takes as-is.
- An empty oauth folder does not block the start: the entry script warns, then starts, because the host omp can keep every provider sign-in in `agent.db` (seen: GitHub Copilot only). If a sign-in should be there, the host path is wrong — fix it and sign in again. An empty `.keep` file in the folder stops the warning.
- Check the mounts after `up` (podman-compose names the container `ottr_server_1`; Docker Compose v2 `ottr-server-1`):

  ```sh
  podman inspect ottr_server_1 --format "{{range .Mounts}}{{.Source}}{{println}}{{end}}"
  ```

  A source under `/mnt/c/mnt/c/` means the path was mangled.
- Repair a `home` volume that kept an empty `agent.db` folder from a bad mount — the next recreate then fails with `crun: mount ... agent.db: Not a directory`. `rmdir` removes only empty directories, so a populated db survives (the volume is `ottr_home`: compose project `ottr`, volume `home`):

  ```sh
  podman run --rm -v ottr_home:/h busybox rmdir /h/.omp/agent/agent.db
  ```

- From source, build with podman, not compose — `podman compose build` passes the Windows context path to the remote podman and fails — then start without building. Check first that no turn runs, because a restart stops a running turn. podman-compose 1.6 does not recreate a container when only its image changed, so the `--force-recreate` flag is required. After the start, `podman ps --format "{{.ImageID}}"` must list the new image ID for the server and every worker, which share `ottr-worker:local`. Compare the IDs with `podman images ottr-worker:local`:

  ```sh
  podman build -f Dockerfile.worker -t ottr-worker:local .
  podman compose up -d --no-build --force-recreate
  podman ps --format "{{.ImageID}}"
  ```

- A proxy on the host's `localhost` breaks `podman compose build` on macOS (reported on
  a colleague's Mac; not reproduced here): Podman passes the host's `HTTP_PROXY`/`HTTPS_PROXY`
  into the machine and the build, and there `localhost` is the build container, not the Mac.
  The apt step fails with `Could not connect to localhost:3128`, then `Unable to locate
  package` for every package. Two fixes for the build:
  - point the proxy at Podman's host name instead: `HTTP_PROXY=http://host.containers.internal:3128`,
    or use the corporate proxy URL directly;
  - skip the build: set `OTTR_IMAGE=ghcr.io/ottr-ai/ottr:<tag>` and run `podman compose pull`,
    then `podman compose up -d --no-build` (the [latest release](#latest-release-no-clone-no-build) path).
  A separate runtime rule applies whenever a host proxy is set: calls between the stack's
  services must bypass the proxy, so `NO_PROXY` must name the compose services. The stack's
  entry scripts append those names at container start (`docker/no-proxy.sh`); set them
  yourself only for containers you run by hand. That rule fixes the runtime calls only —
  it cannot help the build failure above.

- `board-seed` under podman-compose: `COMPOSE_PROFILES=alate` leaves the `seed` profile off, so `podman compose run --rm board-seed` fails with `missing services [board-seed]`. Activate the profile (Docker Compose v2 starts the service you run without the flag):

  ```sh
  podman compose --profile seed run --rm board-seed --repo OWNER/NAME
  # local checkout of the data repo instead of --repo, same relative-path rule as above:
  podman compose --profile seed run --rm -v ../../../../Users/<you>/agent-data:/data:ro board-seed --data /data
  ```

- Shell variables beat `.env`: an `OTTR_*` value still set with `$env:` in the session wins over the `.env` file, and so does a user-level value from `setx` or `[Environment]::SetEnvironmentVariable` in every new shell. Remove old values: `Remove-Item env:OTTR_*` for the session, and per user-level name `[Environment]::SetEnvironmentVariable('OTTR_IMAGE', $null, 'User')`. The entry script logs the pinned image tag and the two host paths at start, before its refusal checks; check them with `docker compose logs server`.
- Memory: without `HINDSIGHT_API_URL` (or a saved **Settings → Hindsight** URL) the workers keep their own `mnemopi` store in the `home` volume ([Fleet memory](WORKERS.md#fleet-memory-hindsight)). Two options: copy your local mnemopi store into the volume once, or point your local omp and Ottr at the same Hindsight server. Never bind-mount the host mnemopi folder into the volume: SQLite over the WSL file share with concurrent writers can corrupt the store.
- The default Podman machine has 2 GiB of RAM, and the server and each worker may use up to 8 GiB. Raise it: `podman machine stop; podman machine set --memory 16384; podman machine start`.

Podman Desktop shows no containers, or the board times out after you recreate the stack? See [docs/WORKERS.md, Troubleshooting](WORKERS.md#troubleshooting).

### After the first start

The `VACUUM INTO` line copies the host omp `agent.db` only when the snapshot does not exist yet. The server and the workers write to the snapshot, so the host db stays unchanged. Do not copy the host db over the snapshot again: sign the stack in under **Settings → Provider sign-in** ([docs/WORKERS.md](WORKERS.md#env-settings) tells why).

No data repo yet? Alate's `create-data-repo` skill builds a private one from the omp setup on your machine: install it with `npx skills add ottr-ai/alate --skill create-data-repo`, then ask your agent to run it. It scans for secrets first and asks before every step that leaves your machine (see [Alate, Start from your current setup](https://github.com/ottr-ai/alate#start-from-your-current-setup)).

Before the first provision, capture this machine's omp user layer into the data repo. Run this from a checkout of the alate repo (https://github.com/ottr-ai/alate):

```sh
node sync-user.mjs --data /path/to/your-data-repo
```

It copies your omp settings, MCP servers, plugins and skills into the data repo's `user/` tree, and it scans for secrets first. Without this step, the workers get none of your user layer. The `create-data-repo` skill already runs this capture; run the command by hand when you built the data repo another way, or after you change your omp setup. Then provision again under **Settings → Alate** (or in the alate dashboard), so the workers' next install carries your layer.

The Alate lines in the quick start write `COMPOSE_PROFILES`, `ALATE_URL`, and `ALATE_API_KEY` into `.env`, and start the bundled Alate server (compose profile `alate`) together with the board. The board reads `ALATE_URL` and `ALATE_API_KEY` at boot and seeds **Settings → Alate** with them. A value saved under Settings wins over the env at every boot. A user whose Alate server already runs omits the Alate block and pairs the board under **Settings → Alate** instead.

The board never takes its config from the worker-writable home volume. With the Alate profile on, first open the Alate dashboard on <http://127.0.0.1:4570>. The alate container binds every interface, so the dashboard asks for the key: sign in with the `ALATE_API_KEY` value from `.env`. Then set the data repo there, and seed the board's own agent layer from your data repo once (see [Seed the board config](WORKERS.md#seed-the-board-config)). The seed installs a layer and switches it in place, so no restart is needed. Replace `OWNER/NAME` with your data repo. The line is the same in bash and PowerShell:

```sh
docker compose run --rm board-seed --repo OWNER/NAME
```

The hourly deploy repeats the seed by itself when the env file sets `ALATE_DATA` (a local data-repo checkout) or `ALATE_DATA_REPO` (`owner/name`). The board shows a notice while its agent layer is not seeded, or while a model role's provider has no active sign-in.

For a source-based deployment, enable the persistent host command in
[docs/WORKERS.md](WORKERS.md#persistent-host-control).
It owns the hourly schedule and supplies the bell countdown.
The bell's **Update** action requests a complete update cycle only when the board is idle.
The command fetches commits, builds the image, and uses the existing safe deployment flow.
Without this host setup, the legacy one-shot updater gives no countdown or **Update** action.
Published release-image deployments keep their image-tag update flow.

The board is then on <http://127.0.0.1:8080>. Optional: `OTTR_PORT`, `HINDSIGHT_API_URL` for fleet memory, and provider keys pass through from the host shell. [docs/WORKERS.md](WORKERS.md) has the full topology, updates and crash story.

Hindsight is the preferred way to share memory between workers. The board picks the
backend from the deployment: set `HINDSIGHT_API_URL` (or save the URL under
**Settings → Hindsight**), and every worker on every machine reads and writes the same
memory on a [Hindsight](https://github.com/vectorize-io/hindsight) server. Without it,
omp keeps its default `mnemopi` memory: a local store in the shared home volume, so only
containers on the same host see it. That store is separate from your local mnemopi store
on this machine: your existing memories never reach the workers. Two supported paths
close the gap: copy your local mnemopi store into the `home` volume once, as a snapshot,
or point your local omp and Ottr at the same Hindsight server. Never bind-mount the host
mnemopi folder into the volume: SQLite over the WSL file share with concurrent writers
can corrupt the store. The board checks memory at boot and every 60 seconds;
when omp runs with no memory, it warns with the reason. See
[docs/WORKERS.md](WORKERS.md#fleet-memory-hindsight).

### Bare metal

The lines are the same in bash and PowerShell:

```sh
git clone git@github.com:ottr-ai/ottr.git ottr
cd ottr
bun install
bun start
```

Open <http://127.0.0.1:4747>. **Add project** clones any git URL (`https://…`, `git@host:…`, `ssh://host[:port]/…`) or creates a new project, sets up `.tasks/` and `.worktrees/`, and runs a short setup dialog (rules, automation, runners). Projects on hosts other than GitHub work with plain git; the GitHub extras (releases, CI watch, Dependabot cards, fork research, GHCR) stay GitHub-only and hide for other hosts. A project without `AGENTS.md` gets a rules interview card that writes one with you. Keep projects in a project folder: after a restart the board finds projects in Ottr's parent folder or in `OMP_TRACKER_ROOTS`.

## Alate

[Alate](https://github.com/ottr-ai/alate) is the provisioning side of the pair. It installs agent rules, skills, plugins and the omp user layer from a data repo onto this machine and into Ottr's Docker workers, so every agent and worker runs the same setup. Ottr integrates with it under **Settings → Alate**: point it at the alate server URL and API key, and **Provision** (or the automatic check every 5 minutes) installs pending imports; an alate that reports layer support provisions while cards run, and an older alate defers the check while cards run. With the URL set, Ottr also pulls the provider's update list each hour and offers upstream updates through the header bell. When an import waits longer than 30 minutes, the bell also shows "Alate is waiting to provision an import" with a link to the Settings section. The Overview page shows the provisioning state at a glance: the server's version and probe result, and which project lists (packages, tools, env) alate provisioned, under **Provisioning**.

The alate URL carries the API key on every call, so the board refuses a plain `http://` URL for anything the public internet can reach. **Settings → Alate** and the `ALATE_URL` env seed accept `http://` only for loopback (`localhost`, `127.0.0.0/8`, `[::1]`), private-network addresses (RFC 1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`; link-local `169.254.0.0/16` and `fe80::/10`; the CGNAT range `100.64.0.0/10`, which covers Tailscale) and single-label host names (the compose service name `alate`). Every other host — a public DNS name, a public IP, an IPv6 address outside the list — needs `https://`. A URL saved under an older board keeps its stored value, and each alate call answers with the reason instead of sending the key; the fix is to switch the URL to `https://`, or to one of the http-allowed hosts above.

