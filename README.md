<p align="center">
  <img alt="Ottr banner" src=".github/assets/banner.png" width="100%"/>
</p>

<h1 align="center">Ottr – The Task Tracker for Oh My Pi</h1>

<p align="center">A local kanban board that runs omp coding agents on your git projects.</p>

<p align="center"><a href="#install">Install</a>&ensp;·&ensp;<a href="#quick-start">Quick start</a>&ensp;·&ensp;<a href="docs/how-it-works.md">Documentation</a>&ensp;·&ensp;<a href="https://github.com/ottr-ai/ottr/releases">Releases</a></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"/></a>
  <a href="https://bun.sh"><img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white"/></a>
  <a href="https://react.dev"><img alt="React version" src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white"/></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript version" src="https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white"/></a>
  <a href="https://github.com/ottr-ai/ottr"><img alt="Repo" src="https://img.shields.io/badge/repo-ottr--ai%2Fottr-181717?logo=github"/></a>
</p>

You type a task in plain language. Ottr gives it a git worktree, runs the agent in it, checks the result, and merges through a per-project queue. It enforces the process; your project's `AGENTS.md` enforces quality. Everything runs on your machine; the board binds `127.0.0.1` by default.

Ottr is mainly built with Ottr itself.

<p align="center">
  <img alt="The Ottr board: tasks move from Todo through In progress and Merging to Done" src=".github/assets/screenshot.png" width="100%"/>
</p>

## Install

Requirements: Windows 10/11 or Linux, with [Bun](https://bun.sh) ≥ 1.4.2, git, and `omp` on `PATH`; see [Requirements](docs/install.md#requirements).

Every full variant — Windows PowerShell, the Alate provisioning block, the agent-db seed, and the Podman notes — is in [docs/install.md](docs/install.md).

### Docker Compose, latest release

The compose file and the image come from the same GitHub release tag; the image is public, so the pull needs no login.

```sh
mkdir -p ottr && cd ottr
TAG=$(curl -fsSL https://api.github.com/repos/ottr-ai/ottr/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
curl -fsSLo docker-compose.yml "https://raw.githubusercontent.com/ottr-ai/ottr/$TAG/docker-compose.yml"
export OTTR_IMAGE=ghcr.io/ottr-ai/ottr:$TAG             # the image of the same release
export OTTR_WORKER_TOKEN=$(openssl rand -hex 32)   # server-to-worker auth
export OTTR_OAUTH_DIR=~/.omp/oauth                 # provider sign-ins, read-only
mkdir -p "$OTTR_OAUTH_DIR"                         # Podman refuses a missing mount source
export OTTR_AGENT_DB=~/.omp/ottr-agent.db          # the stack's own omp auth db
docker compose pull
docker compose up -d --no-build
```

### From source

Builds the image on your machine; the seed and Alate steps are in [docs/install.md](docs/install.md#from-source-main-branch).

```sh
git clone git@github.com:ottr-ai/ottr.git ottr
cd ottr
export OTTR_WORKER_TOKEN=$(openssl rand -hex 32)   # server-to-worker auth
export OTTR_OAUTH_DIR=~/.omp/oauth                 # provider sign-ins, read-only
mkdir -p "$OTTR_OAUTH_DIR"                         # Podman refuses a missing mount source
export OTTR_AGENT_DB=~/.omp/ottr-agent.db          # the stack's own omp auth db
docker compose build
docker compose up -d
```

### Podman

Podman runs the stack too; see the compose provider, log driver and Windows path notes under [Podman](docs/install.md#podman) in docs/install.md.

### Bare metal

No Docker needed.

```sh
git clone git@github.com:ottr-ai/ottr.git ottr
cd ottr
bun install
bun start
```

Open <http://127.0.0.1:4747>.

## Quick start

1. Open the board: <http://127.0.0.1:8080> with Docker Compose, <http://127.0.0.1:4747> on bare metal.
2. **Add project** clones any git URL (`https://…`, `git@host:…`, `ssh://host[:port]/…`) or creates a new project, sets up `.tasks/` and `.worktrees/`, and runs a short setup dialog (rules, automation, runners).
3. A project without `AGENTS.md` gets a rules interview card that writes one with you.
4. Type a task in plain language. The card waits in **Todo** for a free slot: 2 agents per project, 3 in total.
5. **In progress**: Ottr creates `.worktrees/<id>` on branch `ott/<id>-<slug>` and runs `omp -p` in it. The agent finishes with the `report_outcome` tool.
6. **Merging**: a second turn rebases, re-runs the project's checks, and integrates the work. **Done** shows the report.

The full column list, research cards, backlog drafts, the second-model check and the review and release workflows: [How a task moves](docs/how-it-works.md#how-a-task-moves).

## How it works

| Stage | What happens |
| --- | --- |
| Work turn | Ottr creates `.worktrees/<id>` on branch `ott/<id>-<slug>` and runs `omp -p` in it; the agent finishes with the `report_outcome` tool. |
| Merge turn | A second turn rebases, re-runs the project's checks, and integrates the work; one merge turn per project at a time. |
| Review | A read-only card runs the full verification, mutation tests, a security audit and a UI/UX check, and files its findings as task cards. |
| Release | **Create release** runs the review since the last tag, tags the reviewed commit and creates the GitHub release. |

Architecture, the task life cycle and the diagrams: [docs/how-it-works.md](docs/how-it-works.md).

## Learn more

- [Install and setup](docs/install.md): requirements, every install path, the first-start steps, and Alate provisioning.
- [Configuration](docs/configuration.md): every setting with its default, remote access, and card edit conflicts.
- [GitHub tokens](docs/github-tokens.md): the board token, the read-only token for turns, Enterprise hosts, and the GitHub App.
- [Development](docs/development.md): the checks, the tests, CI, UI development, and the screenshot proofs.
- [How Ottr works](docs/how-it-works.md): how Ottr works — architecture, the path of a task, and the task life cycle, with Mermaid diagrams.
- [docs/specs/task-lifecycle.md](docs/specs/task-lifecycle.md): current task stages, states, cancellation latch, transitions, and writer guards.
- [docs/notifications.md](docs/notifications.md): the notification model — alert classes, per-device settings, project mutes, presence and retraction.
- [docs/WORKERS.md](docs/WORKERS.md): the Docker Compose stack — topology, updates, env settings, fleet memory.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): run one host — what "board up" means, the board-down runbook, restore, and the incident template.
- [docs/ARCH-REVIEWS.md](docs/ARCH-REVIEWS.md): the **Review due** feature.
- [docs/adr/](docs/adr/README.md): the decision log — why the system has its shape; an ADR records a decision that is hard to reverse, surprising to a new reader, and a real trade-off.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## Contribute

Run Ottr on your own projects and check the result against [docs/development.md](docs/development.md). Report a vulnerability per [SECURITY.md](SECURITY.md).

## Built with Ottr

Did you build a project with Ottr? Add this badge to its README:

```html
<p align="center">
  <a href="https://github.com/ottr-ai/ottr"><img src="https://raw.githubusercontent.com/ottr-ai/ottr/main/.github/assets/built-with-ottr.png" alt="Built with Ottr"></a>
</p>
```

## License

[MIT](LICENSE)
