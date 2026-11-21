# 0015. The microVM runner has a validation mode for audit target code

Date: 2026-11-12

## Status

accepted as a design; implemented by OTTR-874. Builds on
[ADR 0009](0009-microvm-workers.md). Spec:
[docs/specs/microvm-validation-mode.md](../specs/microvm-validation-mode.md).

## Context

The security-audit harness keeps a lead as `needs_validation` when it cannot run
the target code under OS-enforced controls: no external network, an allowlisted
empty environment, scratch-only writes, a read-only target and toolchain,
resource limits, and the skill's safe artifact promotion controls
(docs/specs/security-audit-harness.md, "Execution limits and errors"). A
container or microVM label alone proves none of them. On this board most audit
leads stay `needs_validation`, because no sandbox meets the controls.

The Firecracker runner of ADR 0009 has the close parts: a guest kernel per VM, a
read-only base rootfs, a read-only project layer, a fixed-size scratch disk, and
hard vCPU and memory caps. A normal turn VM still fails the controls: it gets a
network interface, reaches the board and the internet through the runner's
iptables rules, receives the request env, and holds a bearer token; and its
overlay root lets the turn write over the whole toolchain.

On 2026-11-12 `/dev/kvm` worked on this host (Docker Desktop WSL2 after
`modprobe kvm_amd`; AMD Ryzen 9 5900X). The first Firecracker boots ran on
2026-11-12: the guest kernel and the rootfs boot, and the guest agent answers
`/healthz`. A full turn still fails on three bugs (OTTR-887: a boot error masked
as `stopped`, a dirty ext4 journal on the baked layer, the plugin-skills overlay
missing from copy-in), so the acceptance numbers of ADR 0009 stay open.

## Decision

The runner gains a `validate` mode, specified in
docs/specs/microvm-validation-mode.md. One VM runs one validation job:

- no `network-interfaces` entry in the Firecracker config, no `ip=` and no board
  or token on the cmdline;
- the target checkout crosses in as a tar and lands on a read-only ext4 drive;
  the toolchain stays the read-only base and layer drives;
- the overlay root mounts lower-only, so every write outside the scratch bind
  mounts fails with `EROFS`, and the job runs as `nobody`;
- the job env is a fixed allowlist of three variables (`PATH`, `HOME`, `LANG`),
  never the request env;
- limits are fixed constants: 1 vCPU, 2048 MiB memory, 1 GiB scratch, 256
  processes (`RLIMIT_NPROC`), no core dumps, a 1 GiB file-size rlimit, and a
  10-minute job timeout under a runner-side VM lifetime cap (the memory rose
  from 512 MiB in OTTR-1167: a browser renderer cannot start in 512 MiB; the
  value is a floor computed from that failure envelope, not a control);
- the job spec and its result cross on drives only: the input on the scratch
  ext4, the result on a raw drive whose device node the job cannot write
  (`0600 root:root`). The trusted guest code runs a self-check of every control
  before the job, promotes only allowlisted scratch files into the result with
  the harness's no-follow rules, and powers off. A failed self-check names the
  missing control and the job does not run.
- `POST /validate` on the runner (worker token, health gate, shared slot pool)
  takes the job and answers the result; a board tool `sandbox_run`
  (extension/tracker.ts) is the one audit-facing way to call it. The tool
  routes through the board (OTTR-1043: an agent process never holds the
  worker token), and the board packs the target with `git archive` from the
  project checkout on the server.

## Consequences

- The audit can execute target code with every harness control proven by the
  VM's own self-check and the job's observed attempts; a `needs_validation` lead
  gets its exact missing control from the tool answer instead of a guess.
- Validation VMs share the `OTTR_VM_MAX` slot pool with work turns; a
  validation can hold a work-turn slot. A separate cap is future work.
- A board restart cancels a running validation call; the caller re-runs it.
- The design shares the guest kernel features of the turn mode (overlayfs,
  ext4, devtmpfs), so the pending KVM acceptance runs gate this mode as they
  gate the turn mode; boot time and results belong in ADR 0009.
- The mode adds no new secret channel: no token, no request env, no board
  address enters a validate VM.
