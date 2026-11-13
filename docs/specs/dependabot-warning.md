# Dependabot warning: the project page warns when Dependabot alerts are off

Status: accepted (OTTR-928).

## Goal

The board's GitHub alert features read Dependabot alerts from the repo. A repo with
Dependabot alerts disabled on GitHub sends no alerts, so the board's alert view stays
blindly empty. The project page warns the user with a link to GitHub's settings page,
and a project setting turns the warning off.

## Decisions (OTTR-928)

- "Enabled" means the repo answers GitHub's Dependabot alerts status endpoint:
  `GET /repos/{owner}/{repo}/vulnerability-alerts` returns 2xx when enabled and 404
  when disabled.
- The setting controls only the warning, not the probe targets of other features.
- A 403 (the token may not read the status) means no warning; the probe logs one line.
- The warning shows on the project page, with the other repo advisories.

## Setting

- `dependabotWarn: boolean`, default `true` (`src/types.ts`, `DEFAULT_SETTINGS`, the
  settings validator map in `src/store.ts`). The settings table is key/value, so no
  schema change.
- `POST /api/projects/:project/settings` accepts `dependabotWarn`. A value that is not
  a boolean returns 400 `dependabotWarn must be a boolean`.
- The settings form shows a check row "Dependabot warning" in the Watches card; it is
  disabled while the project has no GitHub remote.

## Probe

- `src/dependabot.ts` exports `dependabotAlertsState(gh, id)` returning
  `"enabled" | "disabled" | "unknown"`. It runs `gh api repos/{owner}/{repo}/vulnerability-alerts`
  on the board's gh transport, so host and tokens follow every other GitHub feature.
  gh exit 0 means enabled; gh's `... (HTTP 404)` error line means disabled; 403, any
  other status, a transport failure, or a repo id outside `owner/name` means unknown.
- The server probes at boot and every hour (`src/server.ts`). Per project: the probe
  runs when the setting is on and the project has a GitHub remote; the state is cached
  in memory for one hour. Setting off, gitless, or no GitHub remote drops the cached
  entry. Entries of projects that left the board are dropped.
- Saving `dependabotWarn: true` probes that project once before the settings response,
  so the response carries the fresh state. Boot and the hourly tick cover the rest.

## Warning

- `ProjectView` gains `dependabotOff: boolean`: true only when the cached state is
  `"disabled"` and `dependabotWarn` is on.
- The project page renders the advisory with the other repo advisories: text, an
  "Enable on GitHub" link to
  `https://<host>/<owner>/<repo>/settings/security_analysis`, and a jump to the
  setting under Settings → Watches.

## Error cases

- 403: one `[dependabot]` log line, no warning, state stays unknown.
- Any other failure: no warning, state stays unknown; the next tick retries after the
  cache TTL.
- The probe never blocks or fails a request path; it only fills the advisory cache.

## Acceptance checks

- Unit (`src/dependabot.test.ts`): the fake gh asserts the exact request
  `["api", "repos/acme/widget/vulnerability-alerts"]`; 204 means enabled, 404 means
  disabled, 403 means unknown; a non-`owner/name` id sends no request.
- App (`src/app.test.ts`): a 404 fake makes the view carry `dependabotOff: true` while
  the setting is on; the setting off clears it; 204 and 403 keep it false; saving
  `dependabotWarn: true` probes inline.
- UI (`src/ui/app.test.tsx`): the advisory and the enable link render only when
  `dependabotOff` is true.

## Non-goals

- No enabling on the user's behalf; the link only opens GitHub's page.
- No warning for code-scanning or secret-scanning feature status.
- No card filing and no push notification.
