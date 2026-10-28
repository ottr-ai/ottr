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
4. Below the margin or expired: let omp refresh (see below), then read the row
   again. When the new `expires - now` is above the margin, lend the new
   `access`.
5. omp does not refresh (non-zero exit, time-out, or the row is still below
   the margin): lend nothing. The turn starts without a lent token, and the
   card log shows one line with the cause (omp's own error text). The board
   never fakes a token. The next turn tries again.

Merge, release and retro turns run on the board against the board store and
need no lending; they get the env too, which is harmless.

### Refresh: omp refreshes, Ottr does not

Ottr has no OAuth refresh code: no request to a provider token endpoint, no
client id, no write to `auth_credentials` or to the lease table. omp owns the
refresh.

The board runs `omp token <provider> --force-refresh` with:

- `PI_CODING_AGENT_DIR` = the board agent dir (the directory of the board
  store), never a worker-writable directory (R5-1);
- `HOME` = `boardOmpHome()` (`boardOmpEnv`), as for every omp the board runs;
- stdout ignored (the command prints the token; the board does not take it
  from there), stderr kept for the cause;
- a time-out of 60 seconds.

Why this command: it costs no model request. omp makes one call to the
provider's token endpoint and writes the new tokens into the board store with
its own lease and refresh-token rotation. `--force-refresh` is necessary
because omp itself refreshes only 60 seconds before the expiry
(`OAUTH_REFRESH_SKEW_MS`), and the board wants more life than that for a turn.
The other candidates refresh later or cost more: `omp usage` refreshes only
inside the 60-second window and can answer from its cache; a print-mode turn
(`omp -p`) costs a model request.

The board reads the token only from the store row after the command. The
command can print an env API key when the refresh fails (omp's key cascade
falls through to env), so its stdout is not proof of a refresh.

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

### Provenance (the item-5 hard stop)

The card's gate — "stop and ask the user before you write Ottr's own OAuth
code or write rows into omp's store" — was asked on 2026-10-28. The user
chose: no Ottr OAuth code, omp refreshes. The sign-in is omp's own flow with
the paste fallback. The only board writes to an omp store are the
`disabled_cause` strings of supersede and sign-out.

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
- omp does not refresh (`invalid_grant`, network, 5xx, time-out, a missing
  `omp`): lend nothing for this turn. The card log names the cause. omp keeps
  or disables the row by its own rules. A provider after `invalid_grant` needs
  a new sign-in.
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
- A test: a token below the margin makes the board run
  `omp token <provider> --force-refresh` against the board agent dir, then the
  turn env carries the new access from the store.
- A test: when omp fails, or omp exits 0 but the row is still below the
  margin, nothing is lent and the cause comes back for the card log.
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
- With two or more OAuth accounts of one provider, `--force-refresh`
  re-mints omp's first candidate. When that is not the board's newest row,
  the row stays stale and the turn gets no lent token (the card log says so).
  Upgrade path: `omp token <provider> --account <n>` once the board maps rows
  to omp's account order.
- Each refresh starts one omp process (about one second). It runs only when
  the token has less than 30 minutes left, so at most a few times a day.
