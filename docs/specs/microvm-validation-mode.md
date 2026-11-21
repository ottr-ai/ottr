# Validation mode in the microVM runner

Status: draft for implementation. Builds on [ADR 0009](../adr/0009-microvm-workers.md)
and [ADR 0015](0015-microvm-validation-mode.md). The security-audit harness
records its execution controls in
[security-audit-harness.md](security-audit-harness.md), "Execution limits and errors".

## Problem

The security audit keeps a lead as `needs_validation` when it cannot run the target
code under OS-enforced controls. The controls (security-audit-harness.md:35-37):

- no external network;
- an allowlisted empty environment;
- writes to scratch only;
- a read-only target and toolchain;
- resource limits;
- the skill's safe artifact promotion controls.

"A container or microVM label alone proves none of these controls." This board has
no sandbox that meets them, so most leads stay `needs_validation`.

A normal microVM turn VM fails the controls by design:

- `firecrackerConfig` always writes a `"network-interfaces"` entry (src/vmRunner.ts),
  and `vmNet.ts` lets the VM reach the board and the internet.
- The guest gets the request env (`guestEnv`), holds a bearer token, and clones the
  branch from the board's git endpoint. No secret enters a turn VM, but the token
  and the env are still more than an empty allowlist.
- The overlay root gives the turn writes over the whole toolchain (upper on scratch).

## Goal

A validation mode of the Firecracker runner: one VM runs one validation job under
the controls above. The audit can start a job and read the result and the VM's
self-check output. The job's own evidence (blocked network, read-only target,
read-back env and limits) proves the controls from inside the VM.

## Non-goals

- Automatic validation of backlog leads (OTTR-869 starts those jobs).
- Intel hosts (`kvm_intel`).
- Normal work turns in VMs; the classic pool and the turn mode stay as they are.
- Changes to the `security-audit-harness` skill files (agent-data card).
- Detached or resumable validation jobs. A validation call is synchronous; a board
  restart cancels it and the caller re-runs it.
- The three boot bugs OTTR-887 fixes (a boot error masked as `stopped`, a dirty
  ext4 journal on the baked layer, the plugin-skills overlay missing from
  copy-in). This card owns none of them; a validation run that trips one shows it
  in `resultSource: "absent"` and the serial `logTail`.

## VM layout

One VM per job, mode `validate` (`ottr.mode=validate` on the cmdline). Drives:

| Drive | Content | Writable |
| --- | --- | --- |
| `vda` | base rootfs: the toolchain (the `vm-runner` image root) | no |
| `vdb` | project layer: the project's packages (as a turn VM); omitted when absent | no |
| `vdc` | scratch ext4: `/tmp`, `/home`, `/work`, and the job input `/job/job.json` | yes |
| `vdd` | result medium: raw, 1 MiB, the guest writes the result JSON at offset 0 | guest only, root-only device node |
| `vde` | target ext4: the target checkout, built host-side, mounted read-only at `/target` | no |

- `firecrackerConfig` writes **no `"network-interfaces"` key** in validate mode, and
  the boot args carry no `ip=`, no `ottr.board`, no `ottr.boardhost`, no token.
  With no interface there is no route, no tap traffic, and no guest HTTP surface.
- The overlay root mounts **lower-only** (no upper): the whole tree outside the
  bind mounts below rejects writes with `EROFS`, for root as well.
- Bind mounts from `vdc`: `/tmp` (mode 1777), `/home` (job's `HOME`), `/work`.
- The job runs as `nobody` (uid 65534, ships in the Debian base). `/home` and
  `/work` are chowned to it. `/dev/vdd` is `0600 root:root`, so the job cannot
  forge the result. Every process in the frame that writes the result is code the
  image ships, not code the request supplied.
- The kernel cmdline stays `console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro
  init=/usr/local/bin/ottr-vm-init`, plus `ottr.mode=validate`.

## Job environment

The job env is a fixed allowlist of exactly three variables, never the request env:

- `PATH=/usr/local/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
- `HOME=/home/job`
- `LANG=C.UTF-8`

The job spec cannot add, remove, or override entries. This is the harness's
"launch from an empty environment" rule.

## Resource limits

Fixed constants of the validation mode (no request knobs, no runner env):

| Limit | Where enforced | Value |
| --- | --- | --- |
| vCPUs | Firecracker `machine-config` | 1 |
| memory | Firecracker `machine-config` | 2048 MiB |
| disk | the scratch disk is a fixed-size block device | 1 GiB |
| processes | `RLIMIT_NPROC` on the job | 256 |
| core dumps | `RLIMIT_CORE` on the job | 0 |
| file size | `RLIMIT_FSIZE` on the job | 1 GiB |
| time | the guest kills the job at 600 s; the runner kills the VM at 600 s + boot slack (180 s total cap) | 10 minutes |

The 2048 MiB value is a floor, not a control: 512 MiB could not start Chrome
for Testing's renderer (V8 process OOM reserving the CodeRange, then every CDP
command timed out), which left every browser lead blocked without proving
anything (OTTR-1167). The vCPU, process, file-size and time caps stay as the
controls they were.

## Guest flow (`docker/ottr-vm-init`, guest agent)

1. Init parses `ottr.mode=validate` (the shape checks relax: empty token, board and
   boardhost are valid in validate mode).
2. Init mounts `vdc` at a private mount point, `vde` read-only at `/target`, builds a
   short-lived setup overlay (its upper on the scratch) to create the bind mount
   points and the hosts files, unmounts it, and mounts the final root as a
   lower-only overlay whose lowest layer is the setup upper. It binds `/tmp`,
   `/home`, `/work` from `vdc`. It leaves `/dev/vdd` with node `0600 root:root`.
3. Init starts the guest agent (`src/vmGuest.ts`) with `OTTR_VM_MODE=validate`.
   The agent does not serve HTTP in validate mode.
4. The agent reads `/job/job.json`, runs the self-check (below), then the job
   through one spawn path: `env` exactly the allowlist, cwd under `/target`,
   `nobody`, the rlimits, the timeout. It captures stdout and stderr tails
   (64 KiB each).
5. The agent writes the result JSON to `/dev/vdd` (8-byte little-endian length,
   then UTF-8 JSON), then exits. Init kills the tree, syncs, unmounts, powers off
   as today.

### Self-check

The self-check runs before the job, as trusted image code. Each check records
`{ name, ok, detail }`. On the first failure the agent writes the result with
`missingControl` set to the failed control's name, does not run the job, and
powers off. Checks:

| Check | Proof | Missing-control name |
| --- | --- | --- |
| interfaces | `/sys/class/net` lists only `lo` | `network isolation` |
| routes | `ip route` and `ip -6 route` are empty; a TCP connect probe to `1.1.1.1:53` fails within 2 s | `network isolation` |
| env | the built job env keys equal the allowlist; a probe spawn through the job path prints exactly that env | `allowlisted empty environment` |
| target read-only | a write attempt to `/target` fails, as `nobody` and as root | `read-only target` |
| toolchain read-only | a write attempt to `/usr` fails with `EROFS` (lower-only overlay) | `read-only toolchain` |
| scratch writable | a write to `/tmp` succeeds as `nobody`, then unlinks | `scratch-only writes` |
| result medium guarded | a write to `/dev/vdd` fails as `nobody`; the node is `0600 root:root` | `artifact promotion guard` |
| limits read back | a probe prints the `Max processes` soft limit from `/proc/self/limits` equal to `maxProcesses`, `nproc` equal to the vCPU count, `MemTotal` above 0, and the scratch size equal to the configured bytes | `resource limits` |

### Artifact promotion

The job spec carries `collect`: scratch-relative paths with per-file and
cumulative byte caps. After the job's process tree is gone, the agent promotes
each allowlisted file into the result, with the harness's promotion rules:

- reject absolute, empty, `.`, `..`, or symlinked components;
- walk every parent no-follow from the scratch root, reopen by descriptor only;
- leaf open no-follow; `fstat` a regular file with link count 1 inside its caps;
- inline the bytes as base64 in the result JSON, re-checking the caps while reading.

Anything that fails a rule is dropped from the result and named. The result
medium is parent-owned afterwards (`/data/<project>/validate-jobs/<id>/`), which
mirrors the skill's retained `artifacts/` rule: the sandbox never writes it.

## Runner endpoint: `POST /validate`

Authorized like `/run` (`x-otwr-token`). Health gate like `/run`: a host that
cannot boot VMs answers `503` with the reason. Slot accounting shares the
`OTTR_VM_MAX` pool with work turns (residual: a validation can hold a work-turn
slot; a separate cap is future work).

Request:

```json
{
  "id": "val-<hex>",
  "project": "ottr",
  "targetTar": "/data/ottr/validate-jobs/val-<hex>/target.tar",
  "job": {
    "argv": ["bun", "test", "src/parse.ts"],
    "cwd": "/target",
    "collect": ["scratch/poc.txt"]
  }
}
```

Rules:

- `project` passes `PROJECT_NAME`; `targetTar` must sit under
  `<dataRoot>/<project>/` with no link escape (the `checkCopyPaths` rules).
- `argv` is a non-empty string list; `cwd` is absolute, normalized, under
  `/target`; `collect` names stay under the job's writable dirs (`/tmp`,
  `/home`, `/work`) with byte caps; at most 16 names.

Flow: build the target ext4 from the tar into a staging dir (safe unpack: reuse
`readTar`; refuse names outside the staging root, links stored as links, devices
and fifos skipped; normalize modes `a+rX`), build the scratch ext4 with
`mkfs.ext4 -d` from a staging tree (`job.json`, `tmp/`, `home/`, `work/`), create
the 1 MiB sparse result file, boot the VM through the launcher with the validate
spec, wait for exit under the lifetime cap, kill at the cap, read `/dev/vdd`
image bytes, parse the result, and answer JSON:

```json
{
  "id": "val-<hex>",
  "selfCheck": { "ok": true, "checks": [] },
  "missingControl": null,
  "job": { "exitCode": 1, "timedOut": false, "stdoutTail": "...", "stderrTail": "..." },
  "artifacts": [],
  "limits": { "vcpus": 1, "memMiB": 2048, "diskBytes": 1073741824, "maxProcesses": 256, "timeoutSec": 600 },
  "bootMs": 812,
  "totalMs": 9400,
  "logTail": "…last serial output…",
  "resultSource": "guest"
}
```

`resultSource` is `"absent"` with an `error` line when the VM died before writing
a result (killed at the cap, guest crash). The runner writes the response JSON to
`/data/<project>/validate-jobs/<id>/result.json` (parent-owned, outside the VM)
and removes the run dir as today. A lazy layer bake reuses the networked bake VM
unchanged; only then does the run bring its tap and iptables rules up, and the
validate VM itself never gets the network-interfaces entry.

## Board endpoint and tool: `sandbox_run` (src/app.ts, extension/tracker.ts)

One eval-kernel tool for review, validation, and scout runs. The audit calls
it; it is the only way the harness executes target code on this board.

The v0.5.0 review (OTTR-969) showed the direct path cannot work: the tool ran
in the agent's eval kernel, and `childEnv` (src/runner.ts) strips
`OTTR_WORKER_TOKEN` from every agent process on purpose — a turn must never
hold the worker credential, and the strip stays. The tool therefore routes
through the board like `propose_task`:

- Args stay: `project`, `ref` (default `HEAD`), `argv`, `cwd`
  (target-relative), `collect`. The limits are the mode's fixed constants; the
  tool takes none.
- The tool (registered in review and trending-scout runs only, as today)
  validates the args with the shared `sandboxRequestError` check
  (src/sandboxRun.ts), then POSTs them unchanged plus this run's card id to
  the board: `POST <OTTR_BOARD_URL>/api/projects/<OTTR_PROJECT>/sandbox`,
  body `{ taskId, project, ref?, argv, cwd?, collect? }`, the
  `x-board-token` header with `OTTR_BOARD_TOKEN`, the `x-run-token` header
  with `OTTR_RUN_TOKEN` (this run's own credential, below), and the `Origin`
  the mutation wall demands. `runSandboxViaBoard` (src/sandboxRun.ts) is the
  client; the agent env never holds `OTTR_WORKER_TOKEN` or
  `OTTR_VM_RUNNER_URL` at any point on this path.
- The endpoint sits behind the same agent-host wall as card filing
  (`agentRefusal` in src/app.ts): the boot token, POST only; a loopback caller
  from the board's own container needs no token; a microVM turn's per-turn VM
  token stays outside, exactly as for trending verdicts. The boot token alone
  opens nothing here (OTTR-1197): every classic run holds the same one, so the
  endpoint also demands the run's own credential — the `x-run-token` header
  with `OTTR_RUN_TOKEN`, issued at dispatch (src/turn.ts) and bound to the
  run's project and card like a VM token, and stripped with the board
  coordinates for retro and proposal runs (childEnv in src/runner.ts). The
  body's `taskId` and the route's project must match that credential, checked
  before the store is touched. The route lifts the request idle timeout: one
  validation runs up to the 600 s job cap plus boot slack.
- The server refuses before it packs:
  - the request must carry this run's own credential (`x-run-token`) and name
    its own card and project; anything else gets `403` with
    `"sandbox_run needs this run's own credential (OTTR_RUN_TOKEN)"` or
    `"sandbox_run runs only this run's own card in its own project"` — checked
    before the store, so a foreign `taskId` learns nothing;
  - the caller's card must exist and be a review, validation, or
    trending-scout card (the
    body's `taskId`, checked against the store's `kind`); a work, retro,
    interview or pr_review run gets `403` with
    `"sandbox_run runs only in review, validation, or trending scout runs"`,
    and an absent
    or empty `taskId` gets the same class of refusal;
  - the args must pass `sandboxRequestError` (`400` otherwise);
  - a gitless project gets `409`, an unknown project `404`.
- On a pass the server packs and runs the job itself (`runSandboxJob`):
  `git archive <ref>` from the project's registered checkout (`Entry.path`,
  the path the board already tracks), then, when the checkout has an installed
  `node_modules`, the same tar gains that tree (`tar --append
  --hard-dereference`): the sandbox has no network, no package cache, and the
  baked project layer installs apt and pip lists only, so `/target/node_modules`
  is the only way a job resolves a project dependency (OTTR-1167). bun installs
  hard-link files from its cache and the runner's tar reader skips hard-link
  members, so the append dereferences them; the tree comes from the working
  install, so it can skew the packed `ref`. A failed append fails the job, and a
  missing `node_modules` packs the bare tree as before. The tar staged under the
  board's data dir (`OTTR_DATA_DIR`, default `/data`) at
  `/data/<project>/validate-jobs/<id>/target.tar`, then `POST /validate` with
  the server's own `OTTR_WORKER_TOKEN`. The runner request carries that token
  on the wire only, server-side to server-side.
- The endpoint answers `200 {"ok":true,"result":<ValidateResponse>}`, or an
  error JSON whose `error` text is the exact blocker the audit records (the
  runner's health reason, an unreachable runner, a failed archive). The tool
  relays a failure after `Error: ` and returns the result JSON unchanged as
  the tool result; it also stays in `result.json`.

The tool still returns the runner's health reason as its error when the server
cannot reach the runner, which the audit records as the exact blocker of a
`needs_validation` lead.

## Skill integration (documentation here; skill files change in agent-data)

`security-audit-harness` execution gating uses this mode as follows: a lead's
validation plan names `sandbox_run` with its argv; before execution the parent
requires `sandbox_run` to answer with `selfCheck.ok === true`; the job's output
tails and `artifacts` are the observed result; a failed or absent self-check or a
`missingControl` value keeps the lead `needs_validation` with that exact control
named. The skill's own promotion procedure still applies to files the audit
retains from `result.json`.

## Acceptance checks

1. Fake-launcher test: a `POST /validate` builds a VM config with **no
   `"network-interfaces"` entry**, read-only target and toolchain drives, the
   raw result drive, and the fixed limits set (1 vCPU, 2048 MiB, 1 GiB scratch,
   `ottr.mode=validate` on the cmdline).
2. Test: a failed self-check stops the job (no job spawn) and returns the result
   with the missing control named.
3. Real run on the KVM host (not from a turn container): a validation job that
   tries to reach the network, write to the target, and read the environment
   shows each attempt blocked in its result. The ready report states that this
   check needs the host and gives the exact host commands (the
   `scripts/vm-validate-smoke.ts` run).
4. A test runs the tool as an agent process with the stripped env (no
   `OTTR_WORKER_TOKEN`, no `OTTR_VM_RUNNER_URL`) against a booted test board
   and a stubbed runner, and gets the runner's result JSON. Before the fix
   this test fails with the "OTTR_WORKER_TOKEN is not set" error.
5. Test: a work-turn run gets the endpoint refusal (403, the
   review-or-trending-scout message), as does a request without this run's
   task id.
6. Real run on the KVM host (not from a turn container): the board-path smoke
   (`src/vmValidateBoardSmoke.ts`) exercises the endpoint path the tool uses
   and the job's result lands at
   `/data/<project>/validate-jobs/<id>/result.json` with `selfCheck.ok` true.
   The ready report states that this check needs the host and gives the exact
   host commands.
7. `bun run check` and `bun test` exit 0 in the turn container.

## Alternatives considered

- **vsock** for the job/result channel: needs the vsock device in the guest
  kernel config and a host-side listener; the raw result drive needs no new
  kernel feature and no second protocol. Rejected for v1.
- **Serial-console sentinel** for the result: the launcher keeps only a 4000-char
  tail; a structured result on a drive is exact and complete. Rejected.
- **Guest HTTP over the tap** for copy-in and the job: the tap is the external
  network the controls forbid. Rejected.
- **In-VM `git clone`** of the target: needs network and a token in the VM.
  Rejected; the target crosses in as a tar from the server.
- **Job as root**: then the job could write the result medium and every device
  node; the `nobody` user is what makes the promotion guard OS-enforced.
- **Writable overlay over the toolchain** (as turn VMs do): a write to `/usr`
  would succeed through the upper; the lower-only overlay is what proves
  "read-only toolchain" at the kernel level.
- **A separate VM pool for validations**: a different cap per mode needs store
  and settings work; the shared pool is enough for v1. Recorded as future work.

## Risks

- The KVM acceptance runs of ADR 0009 started on 2026-11-12: the kernel and the
  rootfs boot and the guest agent answers `/healthz`; a full turn still fails on
  the three bugs OTTR-887 owns. A layer bake inside a validate run can trip the
  dirty-journal bug; the answer then says `resultSource: "absent"` with that
  tail, which is the honest result, not a mode defect.
- The fixed 512 MiB guest RAM and 1 GiB scratch booted on the host in the
  VELV-230 validation run (VELV-247), but 512 MiB could not run a browser: the
  guest RAM is now 2048 MiB (OTTR-1167), and the 2 GiB figure has one real
  browser run's worth of evidence (the VELV-230 retry).
- `mkfs.ext4 -d` needs e2fsprogs with the `-d` populate option (>= 1.43); verify
  the version in the `vm-runner` image on the host.
- The target ext4 is built from a tar the caller controls: the safe-unpack rules
  above are the boundary; they reuse the proven `readTar` reader.
- A VM killed at the lifetime cap may leave no result: the answer says
  `resultSource: "absent"` instead of a guess.
- A board restart cancels a synchronous validation call; the audit re-runs the
  job. No detach path in v1.
- `nobody` cannot read target files with modes below `a+rX`; the mode
  normalization on the host side prevents that.

## Detailed Implementation Plan

1. `src/vmValidateShared.ts`: the constants (`VM_VALIDATE`) and the request,
   job-spec, self-check and result types both sides share.
2. `src/vmRunner.ts`: the `"validate"` branch in `firecrackerConfig` (no
   `network-interfaces`) and `bootArgs`, the `/validate` endpoint, disk builders
   (target ext4 via `mkfs.ext4 -d`, scratch ext4 with the job input, 1 MiB
   result sparse file), result read-back, lifetime cap. Reuse `readTar`,
   `checkCopyPaths`, slot accounting, the bake path for a missing layer.
3. `src/vmValidate.ts`: the guest validation flow — job spec reader, self-check
   catalog, job spawn path (env allowlist, `nobody`, `prlimit`, timeout, output
   tails), promotion collector, result writer. `src/vmGuest.ts` dispatches to it
   on `OTTR_VM_MODE=validate`.
4. `docker/ottr-vm-init`: the `validate` mode branch (mounts above, relaxed
   cmdline checks, `OTTR_VM_MODE=validate`).
5. `src/sandboxRun.ts`, `src/app.ts`, `extension/tracker.ts`,
   `src/vmValidateSmoke.ts`, `src/vmValidateBoardSmoke.ts`: the `sandbox_run`
   tool (board client, `runSandboxViaBoard`), the board endpoint that checks
   the run kind and packs with `git archive` (`runSandboxJob` with the
   server's own worker token; OTTR-1043), and the two host CLIs (in `src/`,
   because the server image ships `src/`, not `scripts/`).
6. Tests: `src/vmRunner.test.ts` (fake launcher: checks 1-2, absent result),
   `src/vmValidate.test.ts` (guest flow with injected probes), the extension
   tool tests in the extension's test file.
7. Docs: this spec, ADR 0015, ADR 0009 status, `docs/WORKERS.md` microVM
   section, README feature table. The remaining KVM acceptance numbers land in
   ADR 0009 on the host.
