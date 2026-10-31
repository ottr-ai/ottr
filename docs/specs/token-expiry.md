# Spec: GitHub token expiry display and reminders (OTTR-273)

The user sees when each GitHub token expires (Settings), and gets reminders early
enough to renew it. This change alters the API shape of the settings views.

Tokens in scope:

1. The board seed token: `GH_TOKEN` in the compose env file (`ALATE_DATA_REPO`,
   docs/WORKERS.md). Only `scripts/update-image.ts` on the host reads it; the board
   never sees the token itself.
2. The board's own GitHub token: Settings, `/api/settings/github-token` (`tokenSet`).

GitHub sends the response header `github-authentication-token-expiration` on REST
calls made with an expiring token, for example `"2027-10-30 00:00:00 UTC"`. A token
with no expiry sends no header.

## Non-goals

Tokens of other git hosts, automatic renewal, and any new npm dependency.

## Shared rules

- **Date format.** Every stored and served expiry is ISO 8601 UTC from
  `Date.toISOString()`, for example `2027-10-30T00:00:00.000Z`. The GitHub header
  form `YYYY-MM-DD HH:MM:SS UTC` is parsed with
  `new Date(h.replace(" ", "T").replace(/ UTC$/, "Z"))`.
- **Day math.** `daysLeft(expiresAt, now)` counts whole UTC days:
  `Math.floor((Date.UTC midnight of expiresAt − Date.UTC midnight of now) / 86_400_000)`.
  On the expiry date itself `daysLeft` is 0; one day after it is `-1` (expired).
- **Expiry unknown** (`null`) means: no header, file absent, or probe not run. It
  renders as "No expiry". It never warns and never pushes.
- **Secrets.** No token is ever written to a log line, a response body, or a file
  other than the stores that already hold tokens. Only the date crosses.

## 1. Seed token probe — `scripts/update-image.ts`

In the `ALATE_DATA_REPO` branch of `seedSource`, after the `git ls-remote` succeeds
and only when `GH_TOKEN` is set: one REST call
`GET https://api.github.com/repos/<owner/name>` with
`authorization: Bearer <GH_TOKEN>`. Read the header. The result is
`"none"` (header absent) or the ISO date.

- `Deps` gains an optional `githubApi?: (path: string, token: string) => Promise<Response>`
  seam; the default prefixes `https://api.github.com`. Tests inject a fake `Response`.
- A failed or non-OK call logs `board seed token expiry check failed` (no token, no
  URL carrying the token), writes nothing, and never fails the run (advisory only).
- The value is written like `seed-commit`, after `compose up -d --wait`, through
  `docker compose … exec -T server sh -c "printf %s '<value>' > /etc/ottr/seed-token-expires"`.
  `<value>` is the ISO date or `none` (both shell-safe). Write it on every run that
  probed, so a renewed token updates the file even when the data repo did not move.
- Log one line: `board seed token expires <date|none>`.
- With no `GH_TOKEN`, or the `ALATE_DATA` local-checkout path, no probe and no write.
- docs/WORKERS.md gains one sentence naming `seed-token-expires` next to the
  `seed-commit` description.

## 2. Board token probe — `src/app.ts`, `src/server.ts`

- `AppDeps` gains `githubTokenExpiry?: (token: string) => Promise<string | null>`
  (ISO date or `null`); the default probes
  `GET https://api.github.com/repos/ottr-ai/ottr` with the token and reads the same
  header (same parsing). A failed probe keeps the stored value and logs; it retries
  on the next tick.
- Probes run at server start, once a day, and after each successful
  `POST /api/settings/github-token` (so a pasted token shows its real date at once).
- `src/server.ts` wires `void app.tokenReminderTick()` once at boot and
  `setInterval(() => void app.tokenReminderTick(), 86_400_000)`, in the style of the
  other ticks (crash-trapped, never kills the board).

## 3. Reminder state — board config, not SQLite

One file `token-reminders.json` next to `seed-commit`
(`join(dirname(boardOmpHome()), "token-reminders.json")`):

```json
{ "board": { "expiresAt": "2027-10-30T00:00:00.000Z", "lastPushDay": "2026-10-01" },
  "seed":  { "expiresAt": null, "lastPushDay": null } }
```

- The board's `expiresAt` is written by the probe. The seed's `expiresAt` is
  refreshed on each read from `seed-token-expires` (`none` → `null`, absent file →
  `null`).
- `lastPushDay` holds the UTC date (`YYYY-MM-DD`) of the last push per token. A
  stored `expiresAt` that differs from the fresh one is a renewed token: reset that
  token's `lastPushDay` to `null` (new schedule starts clean; old reminders stop).
- Missing or corrupt file: defaults, no error.

## 4. API shape changes — `src/app.ts`

- `GET /api/settings/github-token` → `{ tokenSet: boolean, expiresAt: string | null }`.
- `POST /api/settings/github-token` on success → `{ tokenSet: true, expiresAt }`
  from the immediate probe; a rejected token still answers 400 and keeps the old one.
- `seedView()` gains `expiresAt: string | null` (read from `seed-token-expires`;
  `needed === false` → `null`), so `/api/model-roles` GET and POST payloads carry
  `seed.expiresAt`.

## 5. Warnings — `boardWarnings`

`boardWarnings(env = process.env, expiry?)` gains an optional second parameter:

```ts
type TokenExpiryView = {
  board: { tokenSet: boolean; expiresAt: string | null };
  seed: { seeded: boolean; expiresAt: string | null };
};
```

The default reader derives it: `board.tokenSet` from `env.GH_TOKEN` (set by
`applyGithubToken`), `board.expiresAt` from `token-reminders.json`;
`seed.seeded` from `env.OTTR_BOARD_OMP_HOME`, `seed.expiresAt` from
`seed-token-expires`. Token warnings come last, after the provider warnings; the
unseeded early return still replaces everything. With `0 <= daysLeft <= 30`:

- board: `The board's GitHub token expires on <YYYY-MM-DD> (in N days). Renew it at https://github.com/settings/personal-access-tokens.`
- seed: `The board seed token expires on <YYYY-MM-DD> (in N days). Renew it at https://github.com/settings/personal-access-tokens.`

With `daysLeft < 0` the warning says the token expired and names the effect:

- board: `The board's GitHub token expired on <YYYY-MM-DD>. GitHub calls from the board fail. Renew it at https://github.com/settings/personal-access-tokens.`
- seed: `The board seed token expired on <YYYY-MM-DD>. The board seed stops. Renew it at https://github.com/settings/personal-access-tokens.`

Warnings are stateless (derived per poll), so a renewed date clears them by itself.

## 6. Reminder pushes — `app.tokenReminderTick()`

Per token with a known `expiresAt`, a push is due when
`daysLeft === 30 || (0 <= daysLeft <= 14)`. Due means: one push per UTC day, skipped
when `lastPushDay` is today. Send through the existing fan-out
(`sendAll(loadSubs(deps.gstore), payload, (sub, p) => sendNotification(sub, p))`)
with `{ title: "Ottr", body: <the active warning text above>, tag: "token-expiry", url: "/" }`.
After the send (or with no subscribers), record `lastPushDay`. Send failures still
record the day: the next try is tomorrow (same rule as the alert channel).

## 7. UI — `src/ui/app.tsx`

- Shared line builder (same day math): `Expires on <YYYY-MM-DD> (in N days)` or
  `No expiry`.
- `SecretTokenForm` gains an optional prop `expiry?: (cfg: T) => string | null` and
  renders the line next to the set/unset caption. The GitHub token section passes
  `cfg.expiresAt`; the extended type is `{ tokenSet: boolean; expiresAt: string | null }`.
- The model roles seed block renders the seed line from `seed.expiresAt` next to the
  existing seed commit display.

## Acceptance

Tests use a fake clock (`setSystemTime`) and a fake GitHub response; they fail
against the pre-change code by construction (new fields and behavior).

- Board token: one push at 30 days, one at 14 days, and one per day from 13 days
  down to 0; no second push on the same day; an expired token warns with the effect
  text; a token with no expiry header never pushes and never warns; a renewed token
  with a new date stops the old reminders and starts the new schedule.
- `GET /api/settings/github-token` answers the new shape; `seedView` carries
  `expiresAt` from a written `seed-token-expires` file (`none` → `null`).
- update-image: a run with a fake `githubApi` writes `seed-token-expires` with the
  ISO date (and `none` without the header), and no log line contains the token.
