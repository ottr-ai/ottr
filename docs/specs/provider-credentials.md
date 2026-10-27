# Provider credentials: one sign-in, lent tokens

Status: accepted (OTTR-189). This spec replaces the two-login design of
OTTR-183 (69e8401).

## Problem

OTTR-183 gave the board store and the worker store one sign-in each. That costs
two authorizations per provider, and it cannot work from a phone: Anthropic's
OAuth client can only redirect to `localhost`, so a phone browser ends on an
error page and the user had to finish the second sign-in from the board's
machine.

## Design

The board owns the sign-in and lends tokens. Only the board store
(`PI_CODING_AGENT_DIR`, compose: `/etc/ottr/home/.omp/agent/agent.db`) holds a
credential and its refresh token. Before each turn that a worker runs, the board
puts the provider's short-lived access token into the turn env. The worker store
keeps no credential that the board manages.

Code flows first: Settings offers only flows that need no localhost return
address to complete from any device (see "Sign-in flows").

## Sign-in flows

A sign-in runs one `omp login <provider>` against the board store, as before.
One authorization per provider.

Per provider (omp 18.12.3 rules, `pi-catalog` `rules/auth/*.kdl`):

| provider id | stores as | flow | localhost needed | env omp reads |
|---|---|---|---|---|
| `anthropic` | `anthropic` | OAuth code, callback port 54545 | yes, with paste fallback | `ANTHROPIC_OAUTH_TOKEN` |
| `openai-codex-device` | `openai-codex` | device code (auth.openai.com) | no | `OPENAI_CODEX_OAUTH_TOKEN` |
| `zai-coding-plan` | `zai` | manual code (paste), `manual-only` | no | `ZAI_API_KEY` |

- Anthropic: omp's rule has no redirect-uri option; Anthropic allowlists only
  the loopback URI. omp's own instructions cover the phone: "If the browser
  cannot reach this machine, paste the final redirect URL or authorization code
  when prompted." The user completes the authorize page on the phone, copies the
  failed `http://localhost:54545/callback?code=...` address (or the code), and
  pastes it into the Settings field. The board pipes it to omp's stdin; omp
  exchanges the code. No localhost listener on the phone, no Ottr OAuth code.
  Ottr writes no rows into omp's store beyond the board's own.
- Codex: Settings offers `openai-codex-device` (stores as `openai-codex`). The
  user opens the verification URL, enters the code, done. No callback.
- Z.AI: the flow is manual-only by omp's rule (Z.AI rejects loopback
  redirects); the user pastes the final redirect URL or code, as for Anthropic.
- Every other OAuth provider: the existing flow stays, with the paste-address
  fallback in the same field.

Settings shows one state per provider again: signed in, API key stored, or
sign-in expired. The two-step UI, the per-store labels, and the scratch-dir
machinery are gone.

## Token lending

`src/tokens.ts` maps provider id to the env name omp reads:

- `anthropic` → `ANTHROPIC_OAUTH_TOKEN` (wins over `ANTHROPIC_API_KEY`)
- `openai-codex` → `OPENAI_CODEX_OAUTH_TOKEN`
- `zai` → `ZAI_API_KEY` (the zai OAuth access token never expires; the same
  bearer slot takes it, `env "ZAI_API_KEY"` in the provider rule)

Providers not in the map get no lent env. The spec lists none today among the
providers Settings pushes (the three above are wired); a future provider needs
one constant.

At the start of every turn (`ops.turnEnv` in `src/server.ts`, called with the
turn's model), for the model's provider (`provider` is the part before the
first `/` in the model string):

1. Read the provider's active `oauth` row from the board store
   (`auth_credentials`, `disabled_cause IS NULL`). No row: lend nothing.
2. Parse `data` (`{access, refresh, expires, ...}`, `expires` in ms since
   epoch; zai stores a far-future sentinel = never expires).
3. When `expires - now` is above the margin (constant `TOKEN_REFRESH_MARGIN_MS`,
   30 minutes), lend `access` under the provider's env name.
4. Below the margin or expired: refresh first (see below), then lend the new
   `access`.
5. Refresh failure: lend nothing. The turn starts without the token; the turn
   log shows omp's auth error. The row stays untouched. The next turn retries.

Merge, release and retro turns run on the board against the board store and
need no lending; they get the env too, which is harmless.

### Refresh request

The board refreshes itself over HTTPS and writes the new tokens back into the
board store row (same JSON shape, `updated_at` set). No omp process runs. The
requests follow omp's own rules verbatim:

- anthropic: `POST https://api.anthropic.com/v1/oauth/token`, JSON body
  `{grant_type: "refresh_token", client_id: "9d1c250a-e61b-44d9-88ed-594fedd48592", refresh_token}`,
  headers `anthropic-beta: oauth-2025-04-20`,
  `User-Agent: anthropic-sdk-typescript/<version> userOAuthProvider` (constant),
  `Content-Type: application/json`. Response: `access_token`, optional
  `refresh_token` (keep the old one when absent), `expires_in` seconds, minus a
  5-minute skew.
- openai-codex: `POST https://auth.openai.com/oauth/token`, form body
  `grant_type=refresh_token&refresh_token=...&client_id=app_EMoamEEZ73f0CkXaXp7hrann`.
  Response: same fields, no skew.
- zai: never refreshed (tokens do not expire).

### Refresh lease

omp coordinates refreshes between processes with the
`auth_credential_refresh_leases` table (owner, `expires_at_ms`; takeover only
when the current lease expired). The board's refresher takes the same lease
(insert-or-takeover with `expires_at_ms <= now`), releases it after the write.
A lease held by someone else: re-read the row; if it is now fresh enough, lend
it; else lend nothing this turn. This prevents two concurrent refreshes from
rotating the refresh token twice.

### Precedence: why sign-in supersedes worker rows

omp resolves a provider's credential in this order: runtime/config override,
stored OAuth (with its own refresh ladder), stored login API key, then env
variables, then stored static API keys. A stored OAuth row therefore beats a
lent env token. So when a sign-in succeeds, the board marks the worker store's
active rows of that provider `replaced by newer credential` (omp's own cause;
the board writes only this cause string, it reads no value from the worker
store). Worker turns then resolve the lent env token. Rows of other accounts
stay.

Legacy rows from the OTTR-183 era: they hold their own refresh token family
and keep working until the next sign-in or sign-out of that provider. Nothing
is deleted; rows only ever get a cause.

### Logout

Sign-out marks the provider's rows `deleted by user` in the board store and,
when the worker store is a different file and exists, in the worker store too.
That removes the provider's legacy rows with one user step.

## Status and API shape

`GET /api/provider-login` returns `{signIns, pending, providers}` — the board
store's sign-ins, the current sign-in flow (single step), and omp's provider
list. No `stores` array.

`POST /api/provider-login` starts the single sign-in. `.../answer` sends the
pasted line (address or code). `.../cancel` stops. `.../logout` returns
`{removed}` (rows marked in both stores).

## Error cases

- omp login exits non-zero: the flow is `ok: false` with omp's output (unchanged
  from OTTR-183).
- The board store is missing or unreadable: the sign-in fails with omp's error;
  lending lends nothing; `GET` reports what it can read.
- Refresh request fails (network, `invalid_grant`, 5xx): lend nothing for this
  turn, log nothing to the store; the row keeps its old tokens. A provider
  after `invalid_grant` needs a new sign-in (omp marks the row disabled on its
  own next attempt).
- The turn's model names a provider without an active board-store row: no env;
  the turn's own resolution applies (worker store row or omp's auth error).

## Security boundary (R5-1 unchanged)

- The board never runs `omp login` or other omp code with a worker-writable
  directory as its agent dir or `HOME`.
- The board never reads a credential value from the worker store and never
  resolves or runs a key a worker could plant. The only worker-store write is a
  `disabled_cause` string the board composes itself.
- The lent token travels only in the turn env of one run. It is short-lived and
  scoped like the board's own sign-in.

## Acceptance checks

- A test: a worker turn's env carries the board's current access token for the
  model's provider, under omp's env name.
- A test: a token below the margin gets refreshed before the turn, the board
  store row holds the new tokens, and the turn env carries the new access.
- A test: a refresh failure lends nothing and leaves the row unchanged.
- A test: a sign-in writes no credential row into the worker store and marks
  the provider's worker-store rows `replaced by newer credential`.
- A test: the code-flow sign-in path completes by pasting the redirect address
  (no localhost listener involved) — the phone path.
- `bun run check` and `bun test` pass.

## Non-goals

- omp's auth broker (OTTR-171 dropped; a worker could plant a `!command` key).
- A redirect-uri option for Anthropic (Anthropic must allowlist it), an Ottr
  OAuth client, or writing rows into omp's store beyond the board's own.
- Mid-turn token renewal: a turn does not get a new token while it runs.
- New npm dependency, `src/prompts.ts` wording, tracker schema changes.
- Lending API keys stored as `api_key` rows (users pass those via Settings,
  Env).

## Ceilings

- A turn that runs longer than the remaining token life fails with an auth
  error part-way through (anthropic tokens live hours; codex days). The board
  does nothing mid-turn. The next turn refreshes first and resumes the work.
- The board refreshes only when it dispatches a turn that needs the provider.
  A token can sit expired between turns; nothing pre-warms it.
- Two refreshers racing (a board-side omp process and the board's lender) are
  safe by the lease, but a provider that rotates the refresh token on every
  refresh and invalidates the older family on a second concurrent grant could
  still break one side; omp's lease protocol is the mitigation, not a proof.
- The anthropic `User-Agent` constant pins a claude-code version string; if
  Anthropic ever validates it, the constant needs a bump.
