# Git hosts other than GitHub

Status: accepted 2026-10-22 (card ottr-108). Source of truth for the implementation.

## Behavior

Ottr clones, fetches, merges and pushes a project on any git host: GitHub, GitLab,
self-hosted servers, and any other git URL. Only plain git runs against a non-GitHub host.
The GitHub extras (releases, CI and Dependabot, fork research, GHCR, `gh repo create`,
image-pin) stay GitHub-only. They hide for other hosts, as before.

### 1. Clone URL intake (trust boundary)

`parseGitUrl(raw)` in `src/gitHosts.ts` accepts:

- `https://host[:port]/group[/sub...]/repo[.git][/]` (nested groups allowed)
- scp-style `user@host:group[/sub...]/repo[.git]`
- `ssh://[user@]host[:port]/group[/sub...]/repo[.git][/]`

It rejects, with the error `url must be a git repository URL (https://…, git@host:…, ssh://…)`:

- credentials in an https URL (`user:pass@` or `user@`)
- the schemes `file://`, `ext::`, `git://`, `http://`, and any other scheme
- plain or local paths
- any value that starts with `-`
- control characters or whitespace inside the value (outer whitespace is trimmed)
- a path segment that starts with `.` or holds a character outside `[A-Za-z0-9_.-]`
  (a leading `-` is allowed, as for GitHub: the URL reaches git after `--`)
- a host outside `[A-Za-z0-9.-]` (bracketed IPv6 is not supported), a port outside 1..65535

Private-network and LAN hosts are allowed. `git clone` always gets the URL after `--`.

The proposed project name is the last path segment without `.git`
(`https://git.example.com/a/b/c/repo.git` gives `repo`). The add form shows it in an
editable field. `POST /api/projects` accepts `{ url, name? }`. The proposed name and a given
`name` must both pass the New tab's folder-name rule, unchanged from before: one path
segment, never `.` or `..` (a leading `-` is safe, because the destination follows `--`). A taken name gives the existing 409. A folder that exists gives the existing 400.

The add-project tab and the error texts say "Git URL", not "GitHub". GitHub URLs work as
before, and `githubUrl()` still finds a GitHub remote for the GitHub extras.

### 2. HTTPS auth: tokens per host

- `githubToken`, `GH_TOKEN` and all `gh` behavior stay unchanged.
- The global `config` row gets `gitTokens: { host, username, token }[]`. `host` is the
  lowercase host, with `:port` when the URL names a port. `username` defaults to `oauth2`.
  Storage is plaintext, at the same trust level as `githubToken`.
- Git gets the token through a credential helper that git scopes to that host. The helper
  comes from env: `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<i>` =
  `credential.https://<host>.helper`, `GIT_CONFIG_VALUE_<i>` = a shell helper that prints
  `username=$OTTR_GIT_USER_<i>` and `password=$OTTR_GIT_TOKEN_<i>` on `get`. The token is
  never in a URL, in argv, or in `.git/config`.
- Token rule: 8..512 printable characters, no whitespace. Username rule: `[A-Za-z0-9_.@-]{1,100}`.

### 3. SSH auth: keys on the server only

- One global key, plus an optional key per project. A project key wins over the global key.
  Removing a project key makes the project use the global key.
- Files live in a server data dir outside every checkout, which no worker mounts
  (`defaultSshDir` in `src/gitHosts.ts`): `OTTR_SSH_DIR` when set (compose:
  `/app/.tasks/ssh` on the ottr-state volume), else `<OTTR_STATE_DIR>/ssh` when a state dir is
  set (a dev board's keys stay in its own state dir), else the user data dir
  (`$XDG_DATA_HOME/ottr/ssh`, default `~/.local/share/ottr/ssh`; `%LOCALAPPDATA%\ottr\ssh` on
  Windows). Inside it: `global`, `projects/<project-name>`, `pending/<id>`, `known_hosts`.
  Files are 0600, directories 0700. `AppDeps.sshDir` overrides the location (tests).
- Add a key in one of two ways. Generate: `ssh-keygen -t ed25519 -N "" -C ottr`. Paste: Ottr
  checks the key with `ssh-keygen -y -P ""` and rejects a passphrase-protected or malformed
  key. Both write a pending key first and return its public key and SHA256 fingerprint.
- Git runs with `GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes -o
  UserKnownHostsFile=<known_hosts> -o StrictHostKeyChecking=yes -o BatchMode=yes'` when a
  key applies. Every SSH flow that Ottr runs (the clone, the key test) needs a key: the
  global key, or a pending or project key. Without one, the request is a 400 before any
  network step, so a host-key confirm always pairs with the strict command above. When no key
  applies but Ottr's `known_hosts` exists (a key was removed later), git still runs
  `ssh -o UserKnownHostsFile=<known_hosts> -o StrictHostKeyChecking=yes -o BatchMode=yes`, so
  a fetch or push never falls back to ambient host trust.
- Host keys: a test runs `ssh-keyscan -p <port> <host>` and compares the result with
  Ottr's `known_hosts`. Unknown keys return the SHA256 fingerprints to the user. Ottr writes
  them only when the request repeats the same fingerprints (`trust`). A changed host key
  answers `changed: true`, and a confirm replaces the old lines of that host.

### 4. Who gets the credentials (D6)

- `src/worktree.ts` `git()` adds the auth env (tokens + `GIT_SSH_COMMAND` of the project
  that holds `cwd`) to network subcommands only (clone, fetch, ls-remote, pull, push).
- No agent run gets these credentials, merge turns included. Every run (local, worker
  dispatch and its local fallback) strips `GIT_SSH_COMMAND`, `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, `OTTR_GIT_USER_*`, `OTTR_GIT_TOKEN_*`. No token
  is ever in a remote URL or a git config file, so a worktree holds none either.
- The server does every merge push (`serverMergePush` in `src/worktree.ts`); the merge
  prompt tells the agent not to push. After the merge turn and before the integration check,
  it runs `git push origin refs/heads/<branch>:refs/heads/<branch>` through `git()` with the
  host auth of the project (`GH_TOKEN` for GitHub). It pushes only when the worktree's HEAD is
  in the local `refs/heads/<branch>` (proof of the local merge) and origin lacks that tip. It
  does not depend on the agent's report. A failed push keeps the card at merging and
  needs_you, with git's last error line as the reason, and the worktree stays. A needs_you
  report on a push authentication failure becomes integrated once the server push lands,
  with the push output in details.
- `git()` fixes its redaction list when it spawns: the stored secrets at that time plus
  the `OTTR_GIT_TOKEN_*` values the call carries. A token rotated or removed while the call
  runs stays redacted in its output. The run log sink keeps a snapshot from the run start
  and joins it with the current list.
- `git()` replaces every stored token and the ssh dir (every key path) with `[REDACTED]` in
  the stdout and stderr of network subcommands, in one pass, so task logs and API errors
  never hold them. The run log sink (`src/runner.ts` `createRunSink`) redacts the same list
  through `redactingWriter`, which holds back a possible secret start until the next write,
  so a token split across two rendered events or two stderr chunks is still one match.
- Defense in depth: omp persists tool results to its session files outside Ottr's sink. The
  tracker extension
  (`extension/tracker.ts`) handles omp's `tool_result` event and replaces the run's
  `OTTR_GIT_TOKEN_*` values and the ssh dir from `GIT_SSH_COMMAND` in the result content and
  details, before omp stores the result or the model reads it. It scans the raw strings,
  never a JSON form, so a token with a quote or a backslash still matches. Fork analysis
  redacts every non-empty stored token in the same one-pass way.

### 5. Save-time test

`testRemote(url, env)` runs `git ls-remote -- <url>` with a 30 s timeout. A token, a key or
a project key is saved only when the test exits 0. A failed test returns the redacted last
stderr line and changes no stored credential.

## HTTP API

All routes sit behind the existing admin/API auth (`api()`). No response holds a token or a
private key.

| Route | Body | Answer |
|---|---|---|
| `GET /api/git-hosts` | - | `{ tokens: [{ host, username, tokenSet: true }], globalKey: KeyInfo \| null }` |
| `POST /api/git-hosts/tokens` | `{ host, username?, token, testUrl }` | the `GET` view; 400 `{ error }` when the input or the test fails |
| `DELETE /api/git-hosts/tokens/:host` | - | the `GET` view |
| `POST /api/git-hosts/ssh/pending` | `{}` (generate) or `{ privateKey }` | `{ id, publicKey, fingerprint }`; 400 for a passphrase or a bad key |
| `POST /api/git-hosts/ssh/test` | `{ url, key, trust? }` | `{ ok: true }`; 409 `TrustNeeded`; 400 `{ error }` |
| `PUT /api/git-hosts/ssh/global` | `{ pending, testUrl, trust? }` | `KeyInfo`; 409 `TrustNeeded`; 400 `{ error }` |
| `DELETE /api/git-hosts/ssh/global` | - | `{ ok: true }` |
| `GET /api/projects/:project/ssh-key` | - | `{ own: KeyInfo \| null }` |
| `PUT /api/projects/:project/ssh-key` | `{ pending, testUrl, trust? }` | `KeyInfo`; 409 `TrustNeeded`; 400 `{ error }` |
| `DELETE /api/projects/:project/ssh-key` | - | `{ own: null }` |
| `POST /api/projects` | `{ url, name?, sshKey?, trust? }` | as before; 409 `TrustNeeded`; 400 `{ error, needsToken?: host }` |

- `KeyInfo` = `{ publicKey, fingerprint }`.
- `TrustNeeded` = `{ error, needsTrust: true, host, fingerprints: string[], changed: boolean }`.
- `key` in the test is `"global"`, `"pending:<id>"` or `"project:<name>"`.
- `sshKey` in `POST /api/projects` is `"global"` (default) or `"pending:<id>"`. An SSH URL
  runs the host-key check and `ls-remote` before the clone. After a clean clone, a pending
  key moves to `ssh/projects/<name>`.
- An https clone runs with the stored token for the host, or without one. When git fails
  with an auth error, the answer holds `needsToken: <host>`, and the form offers the token
  step.

## Acceptance checks

See the card text. In short: the four remote forms clone; a merge turn pushes to a
non-GitHub remote; every rejected URL class gives 400; a fast-check property holds for the
URL parser; the credential helper answers only its exact host:port; worker env holds no git
credential; key files are 0600 outside the checkouts and never in an answer; a passphrase key
is rejected; no `known_hosts` write before confirm; a failed test saves nothing; GitHub
behavior is unchanged.

## Non-goals

GitLab, Gitea or Bitbucket APIs; a provider layer; webhooks; SSH keys on workers, agent
forwarding, passphrase or hardware keys; migration of `githubToken`; more than one key per
host beyond the global/project choice; blocking private-network hosts.
