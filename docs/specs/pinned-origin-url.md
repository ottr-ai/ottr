# Pinned origin URL (OTTR-348)

## Problem

The board's merge push ran `git push origin …` in the main checkout. The remote
name `origin` resolves through the checkout's `.git/config`, which a work turn
can write (R5-1: the worker mounts the workspace read-write). A work turn can
therefore plant `remote.origin.url` (or `remote.origin.pushurl`) pointing at a
bare repo it owns, with a `hooks/pre-receive` script. At the next merge push the
board's own git runs that hook in the server container, as root, while the call
holds `GH_TOKEN`, every stored git-host token, and sight of `/app/.tasks` and
`/etc/ottr`. Commit 81d4147 closed the run-4 `core.gitProxy` variant only; the
`--receive-pack=git-receive-pack` pin fixes the program name, not the repo, and
the `-c core.hooksPath=/dev/null` pin does not reach the local `receive-pack`
child of a `file://` push. `GIT_ALLOW_PROTOCOL=https:ssh:file` lets the planted
`file://` URL through.

Every board fetch of the integration target had the same shape: `resolveTarget`
fetched the branch's upstream remote by name, and `mergeHoldMismatch` fetched
the gate refspec from `origin` by name. `planRelease`, `publishRelease` and
`runReleaseCommand` fetched tags, listed remote tags and pushed the release tag
from `origin` by name.

## Behavior

1. Project settings gain `originUrl: string | null` (default `null`). The
   setting lives in `tasks.db` under `serverDirFor` — the server-only state
   (OTTR-180), not the worker-shared volumes.
2. The server pins the URL once per project, before any turn of that boot can
   run:
   - at boot, for every discovered non-gitless project;
   - in `addProject`, right after the clone or init.
   The pin reads `git remote get-url origin` and stores it verbatim. It never
   refreshes while the board runs. A re-pin happens through a remove/re-add or
   the settings API (`POST /api/projects/:project/settings` accepts the key).
3. Board network git never takes a remote name for the merge, release and
   target-refresh paths. It names the pinned URL instead:
   - `serverMergePush` pushes `<originUrl> refs/heads/<branch>:refs/heads/<branch>`;
   - `mergeHoldMismatch` fetches `<originUrl> +refs/heads/<branch>:refs/ottr/gate/<branch>`;
   - `resolveTarget(…, fetch=true)` fetches `<originUrl> +<remoteRef>:refs/remotes/origin/<short>`
     when the upstream remote is `origin`, so the configured (plantable)
     refspecs stay irrelevant;
   - `planRelease` fetches `--tags <originUrl>`;
   - `publishRelease` pushes the tag to `<originUrl>`;
   - `runReleaseCommand` ls-remotes and fetches tags from `<originUrl>`.
4. `serverMergePush` and the release paths fail with a clear error when the pin
   is `null` while an origin remote exists (fail closed). `mergeHoldMismatch`
   fails closed (mismatch). `resolveTarget` skips the fetch with its warning
   (same as a failed fetch today). `planRelease` skips the tag fetch.
5. `checkPinnedRemote` guards every pinned call, in the repo, before git runs:
   - a local pin (plain path, Windows drive/UNC path, or `file://` URL whose
     authority is empty or `localhost`) must resolve outside every
     worker-writable root. The roots are the project roots
     (`OMP_TRACKER_ROOTS`) and `OTTR_DATA_DIR`, set at boot when
     `OTTR_DATA_DIR` is configured — that is, when a worker boundary exists at
     all. Native single-user boards (no `OTTR_DATA_DIR`) check nothing, as
     before.
   - no `url.<base>.insteadOf` entry from any config scope may match the pin
     (prefix match, git's own rule, over-approximated to fail closed). A
     rewrite would redirect the push or fetch to a repo the pin never named.
6. `GIT_ALLOW_PROTOCOL` stays `https:ssh:file`. After this change a `file`
   transport can only be reached through the pinned URL (clone only accepts
   https/ssh URLs from the admin), and a local pin under a worker-writable root
   is refused, so a planted or rewritten local URL fails closed.

## Boundaries and error cases

- A pin is captured from the same worker-writable `.git/config` once, at boot
  or add time. A plant that already sits there before the first post-upgrade
  boot can be adopted — but the worker-root check refuses the workspace-local
  form of the attack at every use, and a planted https URL carries no matching
  credential, so the push fails closed. The residual window is no wider than
  the pre-fix state and closes after the first capture.
- `url.<base>.insteadOf` rewriting to a foreign https host stays possible for
  fetches of public repos; no token matches the rewritten host. The code it
  could feed the board is code the worker already holds.
- Residuals documented before this change stand: a planted `http.<url>.proxy`
  with `sslVerify=false` can see a token; board git never recurses into
  submodules.
- A settings row with a corrupt `originUrl` (wrong shape) keeps the default
  `null`, which fails closed at the next push.

## Acceptance checks

- A worktree test plants a `file://` origin (url and pushurl) with a
  `pre-receive` hook and a marker, runs `serverMergePush` with the real bare
  repo pinned, and asserts the push landed on the real bare and the marker does
  not exist. A control run proves plain git runs the hook.
- The same plant against `mergeHoldMismatch` audits the real bare's tip.
- A planted `url.<evil>.insteadOf` entry matching the pin fails the push and
  the gate fetch closed, with the entry named in the error.
- A pin under a configured worker root fails closed; with no roots configured
  the same pin works (native behavior unchanged).
- A planted `remote.origin.fetch` refspec is ignored by the pinned
  `resolveTarget` fetch: the tracking ref moves to the pinned repo's tip.
- `getSettings`/`setSettings` round-trip `originUrl`; a wrong shape keeps the
  default.
- Boot pins the URL before the turn loop starts; `addProject` pins right after
  the clone.

## Non-goals

- No UI for the pin; the settings API and re-adding the project are the paths.
- No change to `remoteUrl`/`githubUrl` (display-only reads) or to the fork
  mirror (already explicit URLs into the server-only dir, OTTR-180).
- No change to clone: the admin's URL is validated by `parseGitUrl`
  (https/ssh only).
