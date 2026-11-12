# Read-only GitHub token for turns

Worker turns hold no GitHub token today. `stripGitAuthEnv` (src/worktree.ts) deletes
`GH_TOKEN` and `GITHUB_TOKEN` from every turn, so agents cannot read PRs, Actions runs,
CI logs or private repos, and unauthenticated GitHub API calls share the egress IP's
60-requests-per-hour budget. The strip misses `GH_ENTERPRISE_TOKEN` and
`GITHUB_ENTERPRISE_TOKEN`: an operator who puts those in `workers/_all/env.txt` leaks the
token into turns by accident. This change gives every turn one supported, operator-managed,
read-only token and strips every GitHub token name otherwise. Write access stays out: the
board's merge turn keeps its own push token (D6), and no turn ever pushes with the read
token's names.

## Strip

`stripGitAuthEnv` deletes four names: `GH_TOKEN`, `GITHUB_TOKEN`,
`GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`. Every caller inherits the two new
deletions: board local git (`gitEnv` local subcommands), the classic worker turn env
(`runChildEnv` in src/workers.ts), the microVM guest env (`guestEnv` in src/vmRunner.ts),
and the provider proxy env (src/llmGateway.ts).

Board-side parity at dispatch: `startWorkerRun`'s `workerBase` also sets the three names it
did not name (`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) to
`undefined` next to `GH_TOKEN`, so a request the board sends never carries a secret the
worker would strip. The microVM dispatch already denies every `GH_`/`GITHUB_` name
(`VM_DENIED_ENV` in src/runner.ts).

## Setting

One stored row per GitHub host in the config row (`.tasks/tracker.db`), field
`turnReadTokens`:

```ts
interface TurnReadTokenRow {
  host: string; // "github.com" or the configured GitHub host, lowercased
  token: string | null; // runtime plaintext; sealed at rest (ADR 0011)
  status: "ok" | "write" | "error";
  detail: string; // human-readable check result
  confirmed: boolean; // user accepted a write-capable token
}
```

- Sealing: the `sealStoredConfigRow` walker seals each row's `token` (same shape as
  `gitTokens[].token`). `saveConfig` mirrors the `gitTokens` branch, with
  `keptUnreadable`/`clearedSecrets` keyed `turnRead:<host>`; the boot load reads rows with
  `loadSecret`. An unreadable stored blob keeps the row with `token: null` and shows
  "unreadable — enter it again"; it is never used.
- Allowed hosts: `github.com` and the configured GitHub host (`githubHostView()`). A save
  for another host answers 400. An empty token save clears the row.
- A plain save refuses when no `SecretBox` exists (`sealGuard`), like every other token
  route (ADR 0011).

### Check and confirm (fail closed)

The board checks a saved token once with the GitHub API through `checkTurnToken`
(below): the scopes header of each response (`X-OAuth-Scopes`, classic tokens) and
`permissions.push` from `GET /repos/{owner}/{repo}` on each project repo hosted there.
Either signal marks the token write-capable. A project origin may be an https URL, an
`ssh://` URL or an scp-style ssh remote (`git@host:owner/repo.git`); the board normalizes
every form through the shared remote parser (`httpsRemote`) before it extracts
owner/repo, so an scp-style origin gets the same push-permission check as an https one.

- `ok`: every repo read succeeded with no push permission and no write-capable scope. The
  token is served to turns.
- `write`: the check found a write signal. The board stores the token but does not use it;
  the UI shows a warning and a confirm button. Confirming sets `confirmed: true` and the
  token is served.
- `error`: the token was rejected (401/403 auth) or the check could not run (network,
  other status). The board stores the token but does not use it; the UI shows an error and
  a "Check again" button until a re-check passes.
- Every check (save or re-check) resets `confirmed` to `false`.
- Zero project repos on the host: the check returns `ok` with "no project repositories on
  this host"; a classic token's write scope then goes unnoticed until a repo exists and a
  re-check runs (accepted limit, see Risks).

A row is served to turns only when its host equals the configured host (case-insensitive,
null configured host serves nothing) and `status === "ok"` or `status === "write" &&
confirmed === true`.

## Delivery

- `StartOptions` (src/runner.ts) gains `githubReadEnv?: Record<string, string>` — the exact
  env names to add to a worker turn.
- The turn engine (src/turn.ts `turnRunStartOptions`) asks a new `TurnOps` callback
  `turnReadToken?: () => {host: string; token: string} | null`, served by app.ts per the
  rule above. When it returns a value, the turn's start options carry
  `githubReadEnv: ghEnvFor(githubHost(), token)` — `GH_TOKEN` for github.com,
  `GH_HOST` + `GH_ENTERPRISE_TOKEN` for an Enterprise host — and the token joins the run's
  `secrets`, so the run log redacts it.
- Classic worker dispatch: the `WorkerRequest` body (src/workers.ts) gains the optional
  field `githubReadEnv`. `startWorkerRun` passes it; `runChildEnv` applies it with
  `Object.assign` after every strip, so the delivered names override any ambient ones and
  survive the strips.
- MicroVM dispatch: `startVmRun` passes the same body field; the vm-runner's /run handler
  merges it after `guestEnv`, the same rule.
- Local dispatch (server-side runs, including merge turns): `githubReadEnv` is ignored.
  Local runs keep today's env — the board's own `GH_TOKEN` stays available to the merge
  turn's push (D6, out of scope below).

The delivered names are the only GitHub token names a turn can hold. Strips cover boot env,
env.txt values, the worker container's own env, and the vm-runner's own env.

## Checker

New module `src/turnGithubToken.ts`:

```ts
export type TurnTokenVerdict = "ok" | "write" | "error";
export interface TurnTokenCheck { verdict: TurnTokenVerdict; detail: string; }
export async function checkTurnToken(o: {
  apiBase: string; // e.g. https://api.github.com or the host's derived API base
  token: string;
  repos: readonly string[]; // "owner/repo"
  fetch?: typeof fetch; // injected; tests stub it
}): Promise<TurnTokenCheck>
```

- One `GET <apiBase>/repos/<owner>/<repo>` per repo, headers `Authorization: Bearer <token>`,
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- Response 200: `permissions.push === true` in the body marks write-capable. The
  `x-oauth-scopes` response header, when present and non-empty, lists classic scopes; a
  scope counts read-only only when it matches `^(read:|user(:|$)|gist|notifications)` —
  every other scope (`repo`, `public_repo`, `workflow`, `delete_repo`, `admin:*`,
  `write:*`, `delete:*`, unknown names) counts write-capable.
- Response 401 or 403: `error` ("token rejected"). 404: the token cannot read the repo;
  the repo adds no signal. Any other status, a malformed body, or a thrown fetch: `error`.
- Precedence over the whole check: any `error` signal wins, then any write signal, else
  `ok`. Duplicate repos are checked once.

## Routes

- `GET /api/settings/turn-github-token` → `{host, tokens}` with `host` =
  `githubHostView()` and rows `{host, tokenSet, tokenReadable, status, detail, confirmed}`.
  No answer ever carries a token value.
- `POST /api/settings/turn-github-token` `{host, token}`: save (sealed) + check; empty
  token clears; returns the row view.
- `POST /api/settings/turn-github-token/confirm` `{host}`: sets `confirmed` on a `write`
  row; 400 otherwise.
- `POST /api/settings/turn-github-token/recheck` `{host}`: re-runs the check on the stored
  token; resets `confirmed`; returns the row view.

## UI

Settings → GitHub, Connection block: a "Read-only GitHub token for turns" entry under the
board token. It renders the current host's row, plus the `github.com` row when the
configured host differs. Password input, Save; the status line shows `ok` ("Turns can use
this token"), `write` (warning + "Use anyway"), `error` (message + "Check again"), and
"unreadable — enter it again" for an unreadable blob. Help text names the fine-grained
read-only recommendation. Hosted mode hides the block (`HOSTED_HIDDEN`).

## README

The "GitHub tokens" section documents: the new field; a fine-grained personal access token
with read-only Repository permissions as the supported shape; that a classic token cannot
be read-only for private repos (the `repo` scope grants write), so the board warns and waits
for confirmation; and that `GH_ENTERPRISE_TOKEN` in env.txt no longer reaches turns — the
setting is the only supported delivery. An Enterprise-host field passes the token to turns
as `GH_HOST` plus `GH_ENTERPRISE_TOKEN`.

## Error cases

- Invalid host in a save: 400, nothing stored.
- No SecretBox: 400 (sealGuard), nothing stored.
- Check network failure: `error` status, stored, not served until a re-check passes.
- Unreadable sealed blob: row kept, `tokenSet` true, `tokenReadable` false, never served.
- Configured host changed or invalid: the stored row simply stops being served; nothing is
  deleted.

## Acceptance

- `stripGitAuthEnv` removes all four names; before the fix `GH_ENTERPRISE_TOKEN` and
  `GITHUB_ENTERPRISE_TOKEN` survive (test).
- With a stored, served token for an Enterprise host, a worker turn's env holds
  `GH_HOST` and `GH_ENTERPRISE_TOKEN` with that value and no other GitHub token name; the
  microVM guest env holds the same names (tests).
- A turn env carrying all four ambient names ends with none of them (worker and VM paths,
  tests).
- The checker asserts the exact method and URL (`GET <apiBase>/repos/<owner>/<repo>`,
  injected fetch, tests) and classifies scopes and `permissions.push` signals (tests).
- A write-capable token is stored with `status: "write"`, is not served, and the confirm
  action enables serving; an `error` status is not served until a re-check passes (tests).
- An scp-style ssh origin (`git@host:owner/repo.git`) on the configured host is checked
  like an https origin: the checker receives its `owner/repo` (test).
- `bun run check` and `bun test` exit 0.

## Non-goals

- Write access for turns. The merge turn's own token (the board's `GH_TOKEN`) stays as it
  is; local server-side runs keep their current env.
- Per-project tokens; one row per host serves every project's turns.
- Git credential use of the token: it serves gh and the REST API only, never the git
  credential helper.
- Hosted-mode turns: the control plane mints per-project tokens there; the setting stays
  self-hosted only (hidden UI).

## Risks

- A classic token with the `repo` scope and zero project repos on the host checks as `ok`
  (no API call observes the scope). Mitigation: the UI help text names it; a re-check after
  adding projects closes the gap.
- A write-capable token the user confirmed rides in worker/VM turns; the strips keep it
  out of every other turn env source, but the turn process itself can read it. That is the
  accepted trade of this feature; the warning flow exists to keep it rare and explicit.
- The VM boundary (ADR 0009) deliberately admits one delivered secret. The delivered names
  ride a dedicated body field applied after the strips, so no ambient name can follow the
  same path.

## Alternatives considered

- Deliver the token inside `env` and carve strip exceptions by name. Rejected: every strip
  site would need name exceptions, and one missed site leaks the ambient token; a dedicated
  field applied after the strips keeps the invariant "strips remove everything".
- Serve the board token to turns and drop write caps. Rejected: the board token pushes; the
  task forbids write access for turns.
- Check scopes only. Rejected: fine-grained tokens send no scopes header; `permissions.push`
  is their only signal.
