# Hindsight memory tokens bind each turn to its own project's bank (OTTR-1006)

## Problem

The board saves one Hindsight key under **Settings -> Hindsight** and
`applyHindsight` writes it into the board process env as
`HINDSIGHT_API_TOKEN`. The worker dispatch base (`startWorkerRun`) and the
local spawn base (`startLocalRun`) forward it to every work turn of every
project and to server-side merge turns. `childEnv` strips fleet-wide
credentials (`ALATE_API_KEY`, `OTTR_HOSTED_SECRET`) but not
`HINDSIGHT_API_TOKEN`, so any turn can talk to the Hindsight server with the
tenant credential.

The Hindsight server's own access model (vectorize-io/hindsight,
`hindsight-api-slim/hindsight_api/extensions/builtin/tenant.py`, read
2026-11-23): the built-in `ApiKeyTenantExtension` compares the presented key
against the single static `HINDSIGHT_API_TENANT_API_KEY` and returns the whole
configured schema — one key opens **every bank, read and write**. The default
extension enforces no auth at all. Bank-scoped API keys exist only in
Hindsight Cloud (`POST /v1/api-keys/scoped`); the open-source server mints
none. The operator's self-hosted server therefore cannot hand out a
bank-scoped key per project.

Impact: a work turn can list, read and retain into another project's bank,
and a merge turn (a privileged server-side run) recalls whatever a lower-trust
work turn retained anywhere in the tenant.

## Decision

The board keeps the tenant key server-side and mints each classic run a
short-lived **memory token** bound to the run's own project bank. Turn memory
traffic goes through the board's `/hindsight` proxy, which forwards to the
Hindsight server with the tenant key but refuses any path outside the
caller's bank — the same shape the microVM dispatch already uses, now with
the bank binding enforced.

### Bank id

`memoryBankId(project)` in `src/memory.ts` returns `ottr-<project>`. One
bank per project; every run of a project uses exactly that bank.

### The env a turn gets

A classic dispatch (worker or local) whose project is known and whose
deployment backend is hindsight strips every ambient `HINDSIGHT_*` name and
sets exactly:

| Variable | Value |
| --- | --- |
| `HINDSIGHT_API_URL` | `<board URL>/hindsight` (the board's proxy route) |
| `HINDSIGHT_API_TOKEN` | the run's memory token (32 random bytes hex) |
| `HINDSIGHT_BANK_ID` | `memoryBankId(project)` |
| `HINDSIGHT_SCOPING` | `global` |

`HINDSIGHT_SCOPING=global` pins omp to one bank: with omp's default
`per-project-tagged` scoping a turn would derive a second `project:<slug>`
bank the proxy would refuse, so the board pins the single project bank and
omp reads `hindsight.bankId` from `HINDSIGHT_BANK_ID` (verified in the
installed omp settings registry: `env:"HINDSIGHT_BANK_ID"`,
`env:"HINDSIGHT_SCOPING"`). All writes and recalls of the run stay in the
project's bank.

The board URL is `o.board.url`, falling back to `OTTR_BOARD_URL` — the same
address turns already use for card filing, so workers can always reach it.

### Proxy binding

`handleHindsight` resolves the caller's grant (`VmTokens.check`), computes
`memoryBankId(grant.project)`, and forwards only paths equal to or under
`/v1/default/banks/<bank>` (the literal `default` segment is the server's
single-tenant org path, the shape omp's client hardcodes). Any other path
answers 403; a missing or revoked token answers 401; an unconfigured Hindsight
answers 503. The proxy replaces the caller's credential with the board's
tenant key, so no turn ever holds it.

### Token lifecycle

`startRun` issues the memory token from the board's `VmTokens` store before
the sink exists (the raw token joins the redaction secrets), hands it to the
dispatch, and revokes it at settlement — the same lifecycle as a VM token.
The grant is `memoryGrant(project, taskId)`: only `project` and `taskId`
carry values; `branch`, `repoPath` and `worktree` hold the sentinel
`memory-token` (grant parsing rejects empty strings). The git endpoint's
project check passes but the git backend resolves `repoPath` to nothing, so
every git operation on the token fails closed; the LFS origin lookup answers
only for the token's own project. `/llm` accepts the token, but the gateway
is null on boards without VMs, and hosted merge turns are server-side anyway.
`server.ts` injects the board's token store into every `startRun` call.

A board crash mid-run leaves the token in the persisted store
(`vm-tokens.json`), so it stays valid until a manual revoke — the accepted
VM-token residual, scoped here to one project's bank.

### microVM turns

Unchanged dispatch: the guest still gets `HINDSIGHT_API_URL=<boardUrl>/hindsight`
and the VM token (`src/vmGuest.ts`). The guest env additionally gains
`HINDSIGHT_BANK_ID` and `HINDSIGHT_SCOPING=global` for the spec's project, so
a VM turn talks to its own bank only — the proxy binding applies to its
token's grant exactly as to a classic run's.

### Deployments without hindsight

A mnemopi deployment (no `HINDSIGHT_API_URL` in the board env) issues no
memory token; the strip leaves no `HINDSIGHT_*` name in any turn env, and the
overlay keeps selecting mnemopi. A run with no project (no board coordinates
and no `project` option) gets no binding and no hindsight memory; the run log
notes it when the deployment backend is hindsight.

## Boundaries

- The board's own server-side processes keep the tenant key for the health
  tick, the Settings save probe and the proxy's upstream hop.
- `runChildEnv` on the worker daemon strips every `HINDSIGHT_*` name from the
  worker container's own env before merging the request env, so a compose
  seed value never re-enters a turn through the daemon.
- The compose `HINDSIGHT_API_TOKEN` seed keeps serving hand-run omp in a
  container; board-dispatched turns never receive it.
- `/llm` tokens are unchanged: the memory token would also pass `vmRoute`'s
  check on `/llm`, but the gateway is null on boards without VMs and hosted
  merge turns are server-side anyway.

## Non-goals

- No migration of existing banks: memories written before this change stay in
  the banks omp's defaults chose (for example the shared `omp` bank); turns
  start on fresh per-project banks.
- No per-project backend choice (OTTR-453 non-goal stands).
- No adoption of Hindsight Cloud bank-scoped keys: the server in this
  deployment is self-hosted and cannot mint them.

## Acceptance

1. `memoryBankId` derives `ottr-<project>`; two projects derive two banks.
2. `childEnv` strips every `HINDSIGHT_*` name; `runChildEnv` strips them from
   the container env while request env survives.
3. A worker dispatch through the real `startRun` (stub daemon) carries the
   proxy URL, a 64-hex run token, the project bank id and `global` scoping,
   and carries no tenant key anywhere in the request env.
4. `handleHindsight` forwards a path under the caller's own bank with the
   board's tenant key upstream, answers 403 for another project's bank and
   for the bare bank list, 401 without a live token.
5. Sequence test: a real worker dispatch, then the captured token through the
   app's `/hindsight` route — own bank forwarded, other bank 403, and 401
   after the run settles (revocation).
6. A VM guest env with hindsight on carries the bank id and `global` scoping.
7. `bun run check` and `bun test` pass.
