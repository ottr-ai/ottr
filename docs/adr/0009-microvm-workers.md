# 0009. Work turns can run in a Firecracker microVM per turn

Date: 2026-11-07

## Status

accepted

## Context

Classic workers are long-lived compose containers that share three volumes with
the server and with each other, all read-write: `/workspace` (every project's main
checkout and worktrees), `/root` (the shared home: agent layer, omp `agent.db`,
oauth dir, mnemopi store) and `/data` (sessions, logs, handoffs). The R5-1
comments in `docker-compose.yml` and docs/WORKERS.md, Residuals, list what that
leaves open: a turn can write a main checkout's `.git/config`, plant files in the
shared home that later turns load, read the provider credentials of the shared
home, and see every other project's checkout. A worker keeps its state between
turns, and the pool size is the number of compose blocks. CPU and RAM limits are
per container, not per turn; disk has no limit.

Card OTTR-532 asks for a sandbox per work turn with four goals:

1. Isolation: a turn sees its own repo and branch, not the other projects, the
   shared home or the board's credentials.
2. Clean state per turn: nothing a turn writes outside its branch reaches the next
   turn.
3. Elastic capacity: sandboxes start per turn up to a cap, not as a fixed pool.
4. Hard per-turn limits on CPU, RAM and disk.

And under these constraints: a Linux host with KVM, the existing compose stack
(no second orchestrator), turns that keep running while the board restarts
(detach and re-bind, as workers do today), and no provider secret inside the
sandbox.

Three backends were compared. The sandbox launcher has to live in compose; Kata
and gVisor start containers, so a launcher for them needs the Docker or containerd
socket, which is root on the host. Firecracker needs only `/dev/kvm`,
`/dev/net/tun` and `NET_ADMIN` in the launcher's container.

| | Firecracker microVM | Kata Containers (Firecracker hypervisor) | gVisor (`runsc`) |
| --- | --- | --- | --- |
| Isolation | own guest kernel behind KVM; small device model (virtio net and block, serial) | own guest kernel behind KVM, same hypervisor | user-space kernel (Sentry) intercepts syscalls, but runs on and shares the host kernel |
| Clean state per turn | boot from a read-only base image plus a fresh scratch disk; the VM is gone after the turn | same, through a container image per turn | a fresh container per turn; state rules are Docker's |
| Elastic capacity | the launcher boots one VM per turn up to a cap | one container per turn; the launcher needs the containerd or Docker socket | one container per turn; the launcher needs the Docker socket |
| Hard CPU/RAM limits | vCPU count and guest memory are fixed at boot | same (VM sizing from the runtime config) | cgroup limits of the container |
| Hard disk limit | the scratch disk is a block device of fixed size | Kata with Firecracker needs containerd's devmapper snapshotter; disk size is the thin-volume size | no block device; the overlay lives in memory or on a host directory, so no real size cap; file IO goes through the gofer and is slower |
| Host setup | `/dev/kvm`, `/dev/net/tun`; binary and kernel ship in the image | containerd, the Kata runtime and the devmapper snapshotter installed on the host, plus a second runtime config next to Docker's | `runsc` installed and registered as a Docker runtime |
| Compose fit | one service (`vm-runner`) with two devices and one capability | a host install outside compose | a host install outside compose |
| Detach across board restarts | the launcher speaks the worker protocol, so `/detach` and re-bind work as today | needs the same launcher work | needs the same launcher work |
| No secret in the sandbox | independent of the backend: the board proxies git, LLM and memory | same | same |

No blocker was found for Firecracker. Kata reaches the same isolation with the
same hypervisor, but adds a containerd/runtime install on the host and a second
runtime configuration to keep in step with Docker's. gVisor narrows the syscall
surface but still shares the host kernel, has no block-device disk cap and has
slower file IO, which matters for builds and test runs.

The credentials constraint was checked against omp itself. `omp auth-gateway
serve` is a forward proxy backed by `omp auth-broker serve`: the broker holds the
credential store and does the OAuth refreshes, the gateway resolves the
broker-backed credential per request, and its clients hold only a gateway token
(omp docs, auth-broker-gateway.md). A provider override with `transport: pi-native`
sends every model of that provider to a gateway-compatible `baseUrl`, provider-wide,
with `apiKey` as the gateway bearer (omp docs, models.md). This serves OAuth
subscription sign-ins and API-key providers alike, so the hard stop of the grilled
task — a provider whose credential cannot be proxied — does not fire.

## Decision

A project may opt in to run its work turns in a Firecracker microVM, one VM per
turn (project setting "Run work turns in microVMs", `microVm`, default off). The
classic worker pool stays the default and keeps every other turn.

- A compose service `vm-runner` (profile `vm`) boots the VMs. It speaks the worker
  protocol (`/healthz`, `/run`, `/detach`, `/detached`, `/detach/kill`), so the
  board dispatches to it like a worker (`OTTR_VM_RUNNER_URL`). It caps running VMs
  at `OTTR_VM_MAX` and answers a busy `503` above the cap; the card then stays
  queued.
- Only work turns whose cwd is the card's own worktree go to a VM. Interview,
  grill and trending turns of such a project run in the main checkout and stay on
  the classic pool. Merge, retro, checks, release and fork analysis stay on the
  server.
- The VM mounts none of `/workspace`, `/root` or `/data`. It clones the task branch
  from the board's git endpoint with a per-turn token that can fetch only that
  project and push only `refs/heads/<task branch>`. The board resets the server
  worktree to each pushed head.
- No provider secret enters the VM. omp in the VM sends each provider through the
  board's `/llm` proxy (`transport: pi-native`, `apiKey` = the per-turn token); the
  board forwards to its own `omp auth-gateway serve` on loopback, backed by
  `omp auth-broker serve` on the board's credential store. Memory goes through the
  board's `/hindsight` proxy the same way.
- A microVM project never falls back to the classic pool: while the runner is down
  or full, its work cards wait.

## Consequences

- A turn of an opted-in project cannot read other projects, the shared home, the
  board's credentials or another turn's leftovers, and it gets hard vCPU, RAM and
  disk limits (`OTTR_VM_VCPUS`, `OTTR_VM_MEM`, `OTTR_VM_DISK`).
- The host must be Linux with `/dev/kvm` and `/dev/net/tun`. Hosts without KVM
  (WSL2 without nested virtualization, most macOS setups) keep the classic pool.
- `vm-runner` holds `NET_ADMIN` for its taps and iptables rules, a privilege no
  classic worker has.
- The update roll treats `vm-runner` as one more runner: hold, wait, detach,
  recreate.
- Accepted residuals:
  - A VM crash, or a `vm-runner` restart while VMs run, loses that turn's session
    changes and its uncommitted files; only what the VM pushed survives. Pushes
    happen every 60 s while HEAD moves and once at exit; a turn that ends normally
    also sends back `research-report.md` and `shots/`.
  - The values in the project's `env.txt` enter the VM, as they enter a classic
    worker turn.
  - Internet egress from the VM is open (with NAT); only private and compose
    addresses other than the board are dropped.
  - The per-turn VM token is a bearer secret inside the VM. It can push the task
    branch, call `/llm` and `/hindsight`, and file cards in the same project until
    the turn settles; the token file keeps it valid across a board restart, so a
    re-bound turn keeps working, and card filing from the VM goes through the same
    agent-host guard as a worker's.
  - Interview, grill and trending turns of a microVM project still run on the
    classic pool with its shared volumes.
  - Turn performance inside 2 vCPU and 8 GiB is not measured. The design was
    written on a WSL2 host without `/dev/kvm`, so no VM booted there. Boot time,
    build and test speed must be measured on a KVM host before the defaults are
    trusted.
- Moving the default to microVMs, or dropping the classic pool, needs a new ADR.
