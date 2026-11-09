# Turn guard on the provisioned agent layer

Status: accepted (OTTR-686).

## Problem

A turn can write the agent layer that alate provisions in the shared home
(`/root` in compose): skills, rules, managed skills, config.yml. OTTR-667
copied a skill file there. The next provision refused the file: it held
neither the data-repo snapshot nor what alate last installed. The only path
for layer changes must stay agent-data -> import -> provision.

## Decision: post-turn audit

A read-only turn (option A) is not implementable from this repo today:

- The stack runs on Docker and rootful Podman (README). A named-volume mount
  at a nested target resolves to the volume root without subpath support, and
  subpath mounts are not portable across both hosts, so compose cannot mount
  `home:/root/.omp/agent/skills:ro`. `config.yml` is a single file that does
  not exist before the first provision, so no mount target can cover it.
- Turns run as root in the worker container. Ownership and modes do not bind
  root, and the immutable flag needs a capability no container holds.
- The layer system (OTTR-451) protects pinned turns once alate provisions in
  layer mode, but a deployment can still provision the flat home.

So each run is audited when it settles: every provisioned file must match
alate's own manifest, `<home>/.alate/installed.json`. Drift fails the turn.

## Behavior

- Audit points: the local spawn's settle in `startRun` (src/runner.ts) and the
  worker daemon's `/run` close handler (src/workers.ts). Each container audits
  its own shared home (`homedir()`); a microVM home is read-only and audits
  clean.
- Compared content: manifest entry `<rel>` maps to `<home>/.<rel>`. The
  fingerprint is sha256 over CRLF-normalized text; `omp/agent/config.yml`
  compares without its top-level `hindsight:`/`alate:` deployment blocks, and
  `omp/marketplaces.json` without the `updatedAt` key. This matches alate's
  `install-user.mjs` record check; verified against this deployment's real
  manifest (469 entries, 0 false drift).
- Drift lines: `<path> changed`, `<path> missing`, `<path> unreadable`, and
  `<path> untracked` for the rules dir only. The audit compares manifest
  entries only; files the manifest never records elsewhere are machine state
  (agent.db, sessions, node_modules) or unrecorded extras; they make no
  finding, because an added file neither changes what alate provisions nor
  makes the next provision refuse. Verified against the real home: a
  structural untracked-file check over all trees flagged `agent.db`,
  `sessions` and plugin `node_modules`, so it does not ship.
- Rules audit through their own record: sync.mjs installs the rules into
  `.omp/agent/rules/` and writes `.omp/agent/rules/.alate-installed.json`,
  one flat rule name per sha256 fingerprint, with the same alate
  fingerprint formula. Every recorded rule must exist and match; the
  install-user manifest holds no rule keys. The rules dir can also hold
  unrecorded rules an older alate installed: sync keeps those by design
  ("Not from the data repo, left in place"), so they are deployment state,
  not drift. The audit flags an unrecorded entry only when the run itself
  added it: each run captures the rules dir's entries when it spawns and
  the audit compares against that capture; without a capture the scan
  stays off, like the manifest audit, which never flags an added file.
  The next provision overwrites snapshot-covered rules, keeps an edited
  dropped rule, deletes a dropped rule nobody edited, and rewrites the
  record from the snapshot, so a record tamper self-heals. Residual: a run
  that edits a rule and the record in the same breath escapes until that
  rewrite.
- Extensions stay outside the audit: nothing records them (no manifest
  keys, no per-dir record), so a turn that edits an installed extension
  produces no finding today.
- The list caps at 40 lines, then one `… +N more` line.
- Skips (the audit returns no drift, never throws):
  - no manifest or an unparsable one: no install-user baseline for those
    files; the rules record still audits on its own (and the mirror case:
    no rules record or an unreadable one skips the rules only);
  - an `.alate/current` entry exists (layer mode): pinned turns write their
    own layer by design, and alate no longer maintains the flat trees —
    this skip covers both sources;
  - a record's mtime sits inside the run's window: a manual provision or
    sync rewrote that source mid-run, and its writes are not this run's
    drift. The two sources skip independently.
- Failure: the run result carries `provisionDrift`; `classify` parks the card
  at needs_you before every other rule. The reason names the files and says
  to change it in agent-data. A turn that reported ready still parks: drift
  defeats the receipt. The next provision refuses install-user-manifest
  files, and overwrites or keeps rules; either way a hand edit never reaches
  the layer through a turn.

## Error cases

- Concurrent runs share one home. Drift written by a run that is still live
  can be attributed to a run that settles first. Detection stays correct;
  the named card can be innocent. The fix (change it in agent-data) is the
  same either way.
- A non-container home audits by the same rule: hand edits there are drift
  by the same definition.
- Compatibility: the `WORKER_DONE` field is optional on both sides. An old
  worker sends no field and an old board ignores it.

## Non-goals

- No boot-time audit, no repair of the flat home, no blocking of the write
  itself.
- No change to the SkillSpector gate or the provision flow.
- No change to src/prompts.ts.

## Acceptance checks

- A test changes a provisioned file's bytes and proves the run settles with
  `provisionDrift` naming it, and `classify` returns needs_you with the file
  name and "change it in agent-data".
- A test edits a rule and proves the audit flags it through the rules dir's
  `.alate-installed.json` record, and a planted rule file flags untracked.
- A test proves the skips: layer mode, no manifest, mid-run provision, for
  both the manifest and the rules record.
- A test proves a clean home audits empty, machine state included
  (agent.db, sessions, node_modules produce no finding).
- `bun run check` and `bun test` pass.
