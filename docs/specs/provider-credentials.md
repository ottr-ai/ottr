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

`LENT_ENV` in `src/login.ts` maps omp's stored provider id to the env name
omp reads the OAuth access token from:

- `anthropic` → `ANTHROPIC_OAUTH_TOKEN` (wins over `ANTHROPIC_API_KEY`)
- `openai-codex` → `OPENAI_CODEX_OAUTH_TOKEN`
- `zai` → `ZAI_API_KEY` (the zai OAuth access token never expires; the same
  bearer slot takes it, `env "ZAI_API_KEY"` in the provider rule)

**Login moment.** omp keeps more than one active row per provider: an
API-key login inserts its row beside an active OAuth row, and only an OAuth
login marks the provider's API-key rows `replaced by oauth login` (pi-ai
`upsertAuthCredential`). So the board dates each active row by the moment the
user signed it in:

- an `oauth` row: `authorizedAt` in its data (omp stamps it at login, and a
  refresh keeps it); a row without it: `created_at`;
- an `api_key` row: `updated_at` (only a login changes such a row), taken as
  the end of its second.

**Current credential.** The provider's active row with the newest login
moment (ties: the higher id). The lend rule: the board lends a provider only
when its current credential is an `oauth` row of a provider in `LENT_ENV`.
An older OAuth row beside a newer API key is never lent.
`GET /api/provider-login` shows each provider's current credential with a
`lent` flag, and Settings shows "Lent to workers" or "Not lent to workers" on
each active row.

**What a sign-in does to the workers** follows the credential this login
wrote, never the provider's combined state. The rows this login wrote are the
active rows whose login moment is at or after the start of the sign-in. This
finds a new row and also a row that omp updated in place (the same account
signs in again; the id stays). For each such row:

- `oauth` of a `LENT_ENV` provider: the board marks the provider's worker rows
  superseded (see "Precedence").
- anything else (an API key, for example the `zai` login, or an OAuth
  provider outside `LENT_ENV`, for example `cursor` or `github-copilot`): the
  worker store does not change. The workers keep their own credential: their
  own store row, or the provider's env key under Settings, Env. The sign-in
  output says so in one line.

### Provider matrix

Every provider that Settings offers (omp 18.12.3 `/login` list, generated from
the `pi-catalog` rules `auth/<id>.kdl` and `providers/<stored id>.kdl`). "Env
names omp reads" are the names a worker turn can get from Settings, Env when
the board does not lend the provider. Settings shows "Not lent to workers" for
every row marked "no".

| Login id (Settings) | Stored as | Login flow | Env names omp reads | Lent to worker turns |
|---|---|---|---|---|
| `openai-codex` | `openai-codex` | oauth-code | `OPENAI_CODEX_OAUTH_TOKEN` | yes, as `OPENAI_CODEX_OAUTH_TOKEN` |
| `anthropic` | `anthropic` | oauth-code | `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (env hook) | yes, as `ANTHROPIC_OAUTH_TOKEN` |
| `zai` | `zai` | api-key | `ZAI_API_KEY` | no |
| `zai-coding-plan` | `zai` | oauth-code | `ZAI_API_KEY` | yes, as `ZAI_API_KEY` |
| `kimi-code` | `kimi-code` | device-code | `KIMI_API_KEY` | no |
| `openrouter` | `openrouter` | oauth-code | `OPENROUTER_API_KEY` | no |
| `github-copilot` | `github-copilot` | custom | `COPILOT_GITHUB_TOKEN` | no |
| `cursor` | `cursor` | custom | `CURSOR_ACCESS_TOKEN`, `CURSOR_API_KEY` | no |
| `devin` | `devin` | oauth-code | `DEVIN_API_KEY` | no |
| `google-antigravity` | `google-antigravity` | oauth-code | none | no |
| `google-gemini-cli` | `google-gemini-cli` | oauth-code | none | no |
| `openai-codex-device` | `openai-codex` | custom | `OPENAI_CODEX_OAUTH_TOKEN` | yes, as `OPENAI_CODEX_OAUTH_TOKEN` |
| `xai` | `xai` | api-key | `XAI_API_KEY` | no |
| `xai-oauth` | `xai-oauth` | device-code | `XAI_OAUTH_TOKEN`, `XAI_API_KEY` | no |
| `gitlab-duo` | `gitlab-duo` | oauth-code | `GITLAB_TOKEN` | no |
| `gitlab-duo-agent` | `gitlab-duo-agent` | oauth-code | `GITLAB_TOKEN` | no |
| `alibaba-coding-plan` | `alibaba-coding-plan` | custom | `ALIBABA_CODING_PLAN_API_KEY` | no |
| `alibaba-token-plan` | `alibaba-token-plan` | custom | `ALIBABA_TOKEN_PLAN_API_KEY`, `BAILIAN_TOKEN_PLAN_API_KEY` | no |
| `aiand` | `aiand` | api-key | `AIAND_API_KEY` | no |
| `abliteration` | `abliteration` | api-key | `ABLITERATION_API_KEY`, `ABLIT_KEY` | no |
| `zhipu-coding-plan` | `zhipu-coding-plan` | api-key | `ZHIPU_API_KEY` | no |
| `umans` | `umans` | api-key | `UMANS_AI_CODING_PLAN_API_KEY` | no |
| `qwen-portal` | `qwen-portal` | api-key | `QWEN_OAUTH_TOKEN`, `QWEN_PORTAL_API_KEY` | no |
| `sakana` | `sakana` | api-key | `SAKANA_API_KEY`, `FUGU_API_KEY` | no |
| `sambanova` | `sambanova` | api-key | `SAMBANOVA_API_KEY` | no |
| `minimax-code` | `minimax-code` | api-key | `MINIMAX_CODE_API_KEY` | no |
| `minimax-code-cn` | `minimax-code-cn` | api-key | `MINIMAX_CODE_CN_API_KEY` | no |
| `xiaomi` | `xiaomi` | custom | `XIAOMI_API_KEY` | no |
| `xiaomi-token-plan-sgp` | `xiaomi-token-plan-sgp` | api-key | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | no |
| `xiaomi-token-plan-ams` | `xiaomi-token-plan-ams` | api-key | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | no |
| `xiaomi-token-plan-cn` | `xiaomi-token-plan-cn` | api-key | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | no |
| `firepass` | `firepass` | api-key | `FIREPASS_API_KEY` | no |
| `cline-pass` | `cline-pass` | api-key | `CLINE_API_KEY` | no |
| `factory-droid` | `factory-droid` | device-code | none | no |
| `commandcode` | `commandcode` | api-key | `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY` | no |
| `charm-hyper` | `charm-hyper` | api-key | `CHARM_HYPER_API_KEY`, `HYPER_API_KEY` | no |
| `deepseek` | `deepseek` | api-key | `DEEPSEEK_API_KEY` | no |
| `stepfun` | `stepfun` | api-key | `STEPFUN_API_KEY` | no |
| `muse-code` | `muse-code` | device-code | none | no |
| `meta` | `meta` | api-key | `MODEL_API_KEY`, `META_API_KEY` | no |
| `moonshot` | `moonshot` | api-key | `MOONSHOT_API_KEY`, `KIMI_API_KEY` | no |
| `inception` | `inception` | api-key | `INCEPTION_API_KEY` | no |
| `cerebras` | `cerebras` | api-key | `CEREBRAS_API_KEY` | no |
| `baseten` | `baseten` | api-key | `BASETEN_API_KEY` | no |
| `helmcode` | `helmcode` | api-key | `HELMCODE_API_KEY` | no |
| `fireworks` | `fireworks` | api-key | `FIREWORKS_API_KEY` | no |
| `together` | `together` | api-key | `TOGETHER_API_KEY` | no |
| `nvidia` | `nvidia` | api-key | `NVIDIA_API_KEY` | no |
| `novita` | `novita` | api-key | `NOVITA_API_KEY` | no |
| `deepinfra` | `deepinfra` | api-key | `DEEPINFRA_API_KEY` | no |
| `huggingface` | `huggingface` | api-key | `HUGGINGFACE_HUB_TOKEN`, `HF_TOKEN` | no |
| `perplexity` | `perplexity` | custom | `PERPLEXITY_API_KEY` | no |
| `qianfan` | `qianfan` | api-key | `QIANFAN_API_KEY` | no |
| `venice` | `venice` | api-key | `VENICE_API_KEY` | no |
| `siliconflow` | `siliconflow` | api-key | `SILICONFLOW_API_KEY` | no |
| `siliconflow-cn` | `siliconflow-cn` | api-key | `SILICONFLOW_CN_API_KEY` | no |
| `synthetic` | `synthetic` | api-key | `SYNTHETIC_API_KEY` | no |
| `nanogpt` | `nanogpt` | api-key | `NANO_GPT_API_KEY` | no |
| `wafer-serverless` | `wafer-serverless` | api-key | `WAFER_SERVERLESS_API_KEY` | no |
| `coreweave` | `coreweave` | api-key | `COREWEAVE_API_KEY`, `WANDB_API_KEY` | no |
| `vercel-ai-gateway` | `vercel-ai-gateway` | api-key | `AI_GATEWAY_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY` | no |
| `cloudflare-ai-gateway` | `cloudflare-ai-gateway` | custom | `CLOUDFLARE_AI_GATEWAY_API_KEY` | no |
| `cloudflare-workers-ai` | `cloudflare-workers-ai` | custom | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_AUTH_TOKEN` | no |
| `snowflake` | `snowflake` | custom | `SNOWFLAKE_PAT` | no |
| `litellm` | `litellm` | api-key | `LITELLM_API_KEY` | no |
| `kilo` | `kilo` | custom | `KILO_API_KEY` | no |
| `zenmux` | `zenmux` | api-key | `ZENMUX_API_KEY` | no |
| `opencode-zen` | `opencode-zen` | api-key | `OPENCODE_API_KEY` | no |
| `opencode-go` | `opencode-go` | api-key | `OPENCODE_API_KEY` | no |
| `yolo-auto` | `yolo-auto` | api-key | `YOLO_AUTO_API_KEY` | no |
| `tavily` | `tavily` | api-key | `TAVILY_API_KEY` | no |
| `kagi` | `kagi` | api-key | `KAGI_API_KEY` | no |
| `exa` | `exa` | api-key | `EXA_API_KEY` | no |
| `parallel` | `parallel` | api-key | `PARALLEL_API_KEY` | no |
| `typesafe` | `typesafe` | api-key | `TYPESAFE_API_KEY` | no |
| `ollama` | `ollama` | api-key | `OLLAMA_API_KEY` | no |
| `ollama-cloud` | `ollama-cloud` | api-key | `OLLAMA_CLOUD_API_KEY` | no |
| `lm-studio` | `lm-studio` | api-key | `LM_STUDIO_API_KEY` | no |
| `llama.cpp` | `llama.cpp` | api-key | `LLAMA_CPP_API_KEY` | no |
| `vllm` | `vllm` | api-key | `VLLM_API_KEY` | no |
| `gmi-cloud` | `gmi-cloud` | api-key | `GMI_API_KEY` | no |
| `stencil` | `stencil` | oauth-code | `STENCIL_API_KEY` | no |
| `singularityapi-dev` | `singularityapi-dev` | api-key | `SINGULARITYAPI_DEV_API_KEY` | no |
| `singularityapi-tech` | `singularityapi-tech` | api-key | `SINGULARITYAPI_TECH_API_KEY` | no |
| `coralbricks` | `coralbricks` | api-key | `CORAL_API_KEY`, `CORALBRICKS_API_KEY` | no |

"none" in the env column: omp reads no env for the provider. A worker turn then
needs a sign-in in the worker store itself. The board leaves that store row
alone, because it does not lend these providers.

### The rule: lend for the model that omp runs

The board lends a token for one model, and omp runs exactly that model. For
each worker turn, the board resolves one **execution model**, in this order:

1. the card's model (trimmed; empty counts as none);
2. else, on a resume, the model of the saved session (the `model` of its last
   `model_change` record, `sessionModel` in `src/session.ts`);
3. else the `default` role of the board's `config.yml` (`modelRoles` in
   `src/models.ts`).

The board passes that model to omp as an explicit `--model` on every worker
turn, also on a resume. So the worker's own `config.yml` cannot pick another
model, and a resume runs the resolved model even after the card's model
changed. The board lends the token for that model's provider only.

A local run (merge, release, retro, board check) runs on the board with the
board store itself. It lends nothing and keeps the card's model, as before.

**Lending fails closed.** For a provider in `LENT_ENV`, anything short of a
usable token is an error with its cause. The worker turn does not start, and
the card goes to `needs_you` with the cause in `needsReason` and in the card
log. The turn also stops when no execution model resolves (no card model, no
session model, no `default` role), when the model names no provider (no
`provider/` prefix), and when `turnEnv` returns any error value, an empty one
included.

Two cases are not errors, and the turn starts without a lent token:

- a provider outside `LENT_ENV`: the board does not lend it, and the worker
  uses its own credential (its store row, or the provider's key under
  Settings, Env);
- a `LENT_ENV` provider whose current board credential is an API key: the
  board never lends a key, and the worker keeps its own (see "Login moment").

The board cannot see the worker store (R5-1), so it cannot check the worker's
own credential in these two cases.

Then `ops.turnEnv` in `src/server.ts` runs with the execution model, for its
provider (`provider` is the part before the first `/` in the model string):

1. Find the provider's current credential in the board store (see "Login
   moment"). Errors:
   - the store file does not exist, or the board cannot read it;
   - the provider has no row: "the board has no `<provider>` sign-in";
   - its newest row is disabled: "the board's `<provider>` sign-in is
     disabled (`<omp's cause>`)", which covers a sign-out too.

   An `api_key` row: lend nothing, no error.
2. Parse `data` (`{access, refresh, expires, ...}`). Errors: the data is no
   JSON object; `access` is not a non-empty string ("has no access token");
   `expires` is not a finite positive number in ms since epoch ("has no
   valid expiry"). A missing or non-number expiry is never an endless token.
   Only zai's documented sentinel `8640000000000000` (omp's `expires
   "never"`, the largest Date) means no expiry, and only for `zai`.
3. When `expires - now` is above the margin (constant `TOKEN_REFRESH_MARGIN_MS`,
   30 minutes), lend `access` under the provider's env name.
4. Below the margin or expired: let omp refresh (see below), then read the row
   again with the same checks. When the new `expires - now` is above the
   margin, lend the new `access`.
5. omp does not refresh (non-zero exit, time-out, the row is still below the
   margin, or the new row fails a check): lend nothing and return the cause as
   `error` (`credentialError` of `turnEnv`). The turn does not start. The
   board never fakes a token. A reply retries after a new sign-in.

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
lent env token. So when a lent sign-in succeeds, the board marks the worker
store's active rows of that provider `replaced by newer credential` (omp's own
cause; the board writes only this cause string, it reads no value from the
worker store). Worker turns then resolve the lent env token. A sign-in the
board does not lend changes no worker row.

The provider is omp's stored id, not the login id: `openai-codex-device`
stores as `openai-codex`, `zai-coding-plan` as `zai`. The board takes the
stored id from the rows that the login wrote (login moment at or after the
start of the sign-in) and decides from those rows.

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
store's sign-ins (`{provider, kind, active, cause, lent}`), the current sign-in
flow (single step), and omp's provider list. No `stores` array.

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
- The execution model names a `LENT_ENV` provider, and the board store is
  missing or unreadable, or holds no row, a disabled row, an empty access
  token, or no valid expiry for it: the worker turn does not start;
  `needs_you` with the cause.
- The execution model names no provider (no `provider/` prefix): the worker
  turn does not start; `needs_you` with the cause.
- No execution model (no card model, no session model, no `default` role):
  the worker turn does not start; `needs_you` with the cause.
- The board holds the provider's OAuth sign-in, and omp does not refresh it:
  the worker turn does not start; `needs_you` with omp's cause.

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
- A test: a lent sign-in writes no credential row into the worker store and
  marks the provider's worker-store rows `replaced by newer credential`.
- A test: an API-key sign-in (the `zai` login) and an OAuth sign-in outside
  `LENT_ENV` (`cursor`) change no worker row and say so in the output.
- A test: a login id that stores under another id (`openai-codex-device`)
  supersedes the rows of the stored id.
- A test, with omp's real table layout: an API-key login beside an older
  active OAuth row changes no worker row, and neither the `lent` flag nor the
  turn env lends the old OAuth token.
- A test, with omp's real table layout: a same-account OAuth login that omp
  updates in place (same id) still supersedes the worker rows.
- A test: board and worker default roles differ: a worker turn with no card
  model (and with an empty one) runs the board's `default` role as an
  explicit `--model`, with that provider's board token.
- A test: a resume after the card's model changed: a cleared card model runs
  the saved session's model; a switched card model runs the new model. Each
  gets its own provider's token.
- A test: no execution model, or a credential the board cannot lend, stops
  the worker turn with the cause on the card; an empty error value stops it
  too.
- One test for each fail-closed case of a `LENT_ENV` provider: a missing
  sign-in (and a missing store), a disabled sign-in, an empty access token,
  an absent expiry, a string expiry, and a model with no provider. A test
  keeps zai's sentinel working.
- A property: any junk in the data column lends a non-empty string token or
  returns an error, never neither.
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

- The session model comes from the last `model_change` record of the saved
  session. A worker turn always passes `--model`, so a resume also writes one.
  An older session that omp saved without such a record (none seen in omp
  18.12.3) falls back to the board's `default` role.
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
- An `api_key` row carries only whole seconds (`updated_at`). Two logins of
  one provider inside the same second can order wrong, and an API key that
  another omp process saves while a Settings sign-in runs counts as written
  by that sign-in. Both cases need a person to act twice within seconds.
