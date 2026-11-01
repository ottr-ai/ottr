# Provisioning state overview

The Overview page gains a "Provisioning" section: the agent server's (alate)
provisioning state and the workers' provisioned lists, at a glance, without
opening Settings.

## Behavior

- `GET /api/provisioning` returns a `ProvisioningResponse` (src/types.ts):
  - `server`: null when no alate URL is configured. Otherwise the config view
    (`url`, `keySet`, `lastError`) plus one live health probe classified as
    `ok` (`version`, `behind`, `pending`, `running`) or `down`, with the same
    untrusted-body guards the Settings section applies.
  - `workers`: one row per project alate provisioned lists for (union of the
    shared home and the board omp home's `.ottr/workers` directories, sorted):
    `apt`, `tools`, `env` booleans for the presence of `apt.txt`, `tools.json`,
    `env.txt`. No file content is read or shipped.
- The endpoint is read-only. It runs a live probe (5 s timeout), so the UI
  polls it every 60 s instead of riding the 1 s state push.
- The Overview section renders between Triage and Performance:
  - Server row: `alateHint(health)` text; "no API key" appended when
    `keySet` is false; `lastError` shown as an alarm when set; "not
    configured" with a link that opens Settings → Alate when `server` is null.
  - Workers rows: one line per project listing the present lists, or "No
    provisioned worker lists" when the directory is empty or missing.
  - Probe error: the row degrades to the error text, the rest of the page
    stays usable.

## Error cases

- alate probe failure → `health: { state: "down" }`, HTTP 200 (the state is
  the payload; the panel shows "server unreachable").
- No probe (not configured) → `server: null`, HTTP 200.
- Missing `.ottr/workers` directories → empty `workers` list.

## Non-goals

- No provisioning trigger from the Overview (Settings → Alate owns it).
- No container-internal install state (the server cannot see inside worker
  containers; list presence is the honest state).
- No change to StateResponse or the socket push cadence.

## Acceptance checks

- `bun run check` and `bun test` pass.
- Route tests cover: not configured, ok probe, down probe, key missing,
  workers rows from a temp home (apt/tools/env presence).
- UI helper tests cover the server-line classification and the worker note.
- Screenshot of the Overview with the new section.
