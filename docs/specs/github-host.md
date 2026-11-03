# Configurable GitHub host

One setting names the GitHub host for the whole board. The GitHub features follow it: the
token expiry check, PR reviews, CI watch, Dependabot cards, releases, fork research and the
GitHub App. Plain git needs no setting: it already works on any host (src/gitHosts.ts).

## Setting

One host per board, set in either place; a saved Settings value wins while it exists:

- Settings → Git hosts → **GitHub host**: an input field that shows the host in effect
  (`github.com` when nothing is set). Saving calls `POST /api/settings/github-host` with
  `{host}`; an empty `host` clears the saved value. The answer is
  `{host, expiresAt}`: the host now in effect (`null` only for an invalid env) and the
  token expiry after a fresh probe, so the notice follows the new host at once.
- `OTTR_GITHUB_HOST` (env, default `github.com`): the fallback a saved value overwrites.

Applying a value writes it into `OTTR_GITHUB_HOST` in the server process — the same pattern
as the GitHub token writing `GH_TOKEN`. The app remembers the env value it booted with; a
clear restores that value, or removes the variable when the env had none. A saved value
persists in the config store (`githubHost` field of the `config` row) and the load reapplies
it over the env at every boot. The module `src/githubHost.ts` owns every value derived from
the host and reads only the env, so no caller changes. No other file builds a github.com URL
or picks the gh env.

## Host kinds and derived values

| Host kind | Example | API base | Web base |
|---|---|---|---|
| github.com | `github.com` | `https://api.github.com` | `https://github.com` |
| Enterprise Cloud, data residency | `acme.ghe.com` | `https://api.acme.ghe.com` | `https://acme.ghe.com` |
| Enterprise Server | `ghe.example.com` | `https://ghe.example.com/api/v3` | `https://ghe.example.com` |

Rule: a host that ends in `.ghe.com` is Enterprise Cloud with data residency; `github.com`
is the default; every other host is Enterprise Server.

The gh env (`ghEnvFor`):

- Default host: `GH_TOKEN` (today's behavior; no names when no token is set).
- Other host: `GH_HOST=<host>` and `GH_ENTERPRISE_TOKEN=<token>`; without a token only
  `GH_HOST`. `GH_TOKEN` authenticates github.com only, so it never serves another host.

## Validation

The value must be a bare hostname: letters, digits, dots, hyphens. `parseGithubHost` refuses
a scheme, a path, a port, whitespace, userinfo, a query or fragment, an empty or misplaced
label (`..`, a leading or trailing dot, a leading or trailing hyphen in a label), and
anything longer than 253 characters. Uppercase input is lowercased. `githubHost()` throws on
a refused value, so a bad setting never silently targets github.com; the server repeats the
check at boot.

## Callers

- Token expiry probe (src/app.ts): default host keeps
  `GET https://api.github.com/repos/ottr-ai/ottr`; another host calls `GET <apiBase>/user`,
  which exists on every GitHub host.
- PR review post and the GitHub App token mint (src/app.ts, src/githubApp.ts): `<apiBase>`
  URLs.
- Every gh call (src/release.ts `runGh`; PR watch, CI watch, Dependabot, forks, repo create):
  the env from `ghEnvFor`.
- GitHub-remote detection (src/worktree.ts `githubUrl`): a remote on the configured host
  counts; other hosts do not (`hostMatcher` keeps a look-alike suffix from matching).
- Board-built links (PR URLs, Dependabot card heads, release links, fork links, fork report
  links): `<webBase>`.

## Error cases

- Invalid `OTTR_GITHUB_HOST`: the server refuses to start; `githubHost()` throws the same
  message at every other use. The Settings view reports the host as unknown (`null`) instead
  of a wrong host.
- An invalid saved value cannot exist: the endpoint refuses it with a 400 carrying the
  `parseGithubHost` message and stores nothing. The boot check in `src/server.ts` runs
  before the config loads, so an invalid env refuses the start even when a saved value
  would override it.
- GitHub answers 401/404: unchanged behavior per caller. The probe keeps the stored value;
  the App mint returns null when no installation exists.

## Acceptance

- The module maps `github.com`, `acme.ghe.com` and `ghe.example.com` to the API base, web
  base and gh env above.
- With `OTTR_GITHUB_HOST=acme.ghe.com`, the expiry probe, the PR review post and the App
  token mint call `https://api.acme.ghe.com` (a fake fetch records the URL); gh calls carry
  `GH_HOST` and `GH_ENTERPRISE_TOKEN`.
- Without the setting, every call is unchanged (github.com URLs, `GH_TOKEN` only).
- Property: for every host the module accepts, the derived URLs stay on that host; a host
  with a scheme, path, port or whitespace is refused.
- Saving `bmw.ghe.com` in Settings: the `/api/git-hosts` view names it, the config row holds
  it, a new app on the same store still names it after boot, and the probe calls
  `https://api.bmw.ghe.com`.
- A saved value wins over a different env value; clearing falls back to the env value, or to
  `github.com` without one. An invalid save answers 400 and stores nothing.
- The Settings field shows `github.com` by default; a save posts the endpoint and the view
  updates; a 400 error lands on the section's error line.
- `bun run check` and `bun test` exit 0.

## Non-goals

- More than one GitHub host per board.
- GitLab or another forge gets no GitHub features (unchanged; src/gitHosts.ts stays plain
  git plus ssh).
- Git authentication to the host stays with the Settings → Git hosts tokens and SSH keys;
  `GH_ENTERPRISE_TOKEN` serves gh only. The board's own upstream checks (`ottr-ai/ottr`
  updates) stay on github.com.
- No delete endpoint for the host: an empty save is the reset, as `github.com` in the field
  is the explicit default.
