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
   - in `addProject`, right after the clone — and the pin read lands before the
     registration's remote refresh, so the repo identity (behavior 7) and the
     branch-rules probe it drives see the pinned URL, not the remotes;
   - for a project the operator git-inits, at the init endpoint, which replaces
     a pin captured while the project was gitless.
   The pin reads `git remote get-url origin` and stores it verbatim. It never
   refreshes while the board runs. A re-pin happens through a remove/re-add or
   that init endpoint.
3. Board network git never takes a remote name for the merge, release and
   target-refresh paths. It names the pinned URL instead:
   - `serverMergePush` pushes `<originUrl> refs/heads/<branch>:refs/heads/<branch>`;
   - `mergeHoldMismatch` fetches `<originUrl> +refs/heads/<branch>:refs/ottr/gate/<branch>`;
   - `resolveTarget(…, fetch=true)` fetches `<originUrl>
     +<remoteRef>:refs/remotes/origin/<short>` for every origin upstream, so the
     configured (plantable) refspecs stay irrelevant; an upstream the pin does
     not cover (a fork remote, a merge ref outside `refs/heads`) skips the
     fetch with a warning — the board never fetches by remote name;
   - `planRelease` fetches `--tags <originUrl>`;
   - `publishRelease` pushes the tag to `<originUrl>`;
   - `runReleaseCommand` ls-remotes and fetches tags from `<originUrl>`;
   - `publishTaggedRelease` refuses to publish a `resolveTarget` result that
     carries a warning (a failed trusted refresh must never choose the release
     commit: the fallback ref is worker-writable and the content gate proves
     only ancestry), and it takes the tag's commit from `git ls-remote
     <originUrl>` of the target ref, never from the tracking ref.
4. `serverMergePush` and the release paths fail with a clear error when the pin
   is `null` while an origin remote exists (fail closed). `mergeHoldMismatch`
   fails closed (mismatch). `resolveTarget` skips the fetch with its warning
   (same as a failed fetch today). `planRelease` skips the tag fetch.
5. `checkPinnedRemote` guards every pinned call, in the repo, before git runs:
   - the pin must look like a URL or path: a value whose first character is `-`
     (it would parse as a git option and could drop the repository argument,
     falling back to the planted default remote) is refused;
   - a local pin must resolve outside every worker-writable root. Local forms:
     a plain absolute path, a Windows drive/UNC path, any `file://` URL (current
     git ignores its authority and serves the path after the first raw `/`
     locally; with no raw `/` it url-decodes the whole remainder as the path),
     and any no-scheme value that git reads as a path (no colon, or
     the first slash before the first colon — `./x:y.git` is a path, `host:path`
     is scp-ssh). The roots are the project
     roots (`OMP_TRACKER_ROOTS`), `OTTR_DATA_DIR`, and the server's own home
     (the compose shared `home` volume at `/root`), set at boot when
     `OTTR_DATA_DIR` is configured — that is, when a worker boundary exists at
     all. Native single-user boards (no `OTTR_DATA_DIR`) check nothing, as
     before.
   - no `url.<base>.insteadOf` or `url.<base>.pushInsteadOf` entry from any
     config scope may match the pin (prefix match, git's own rule,
     over-approximated to fail closed). A rewrite would redirect the push or
     fetch to a repo the pin never named; `pushInsteadOf` rewrites push
     destinations only, so both keys are scanned for every call.
   - no `remote."<pin>".url` or `remote."<pin>".pushurl` entry from any config
     scope may exist. `git fetch <pin>` resolves the repository argument as a
     remote name before it reads the argument as a URL, so a section named
     exactly like the pin (case-sensitive, git's own remote-name lookup) would
     receive the call — and the host-scoped credential — instead of the pinned
     repo.
6. `GIT_ALLOW_PROTOCOL` stays `https:ssh:file`. After this change a `file`
   transport can only be reached through the pinned URL (clone only accepts
   https/ssh URLs from the admin), and a local pin under a worker-writable root
   is refused, so a planted or rewritten local URL fails closed.
7. The board's GitHub repo identity (`Entry.github` — what the issue watch, the
   PR review bot, the Dependabot check, GitHub App token minting and the
   release links act on) derives from the pinned URL (`githubUrlFromPin`),
   never from the checkout's remotes. It is null when the pin is missing or
   names another host. The pin capture sites (boot, addProject, and the git
   init endpoint, which pins too) re-derive it once the pin lands. A planted
   `remote.origin.pushurl` or `url.<x>.pushInsteadOf` entry cannot move the
   identity (OTTR-1004): the checkout's remotes are worker-writable, the pin is
   not.

## Boundaries and error cases

- A pin is captured from the same worker-writable `.git/config` once, at boot
  or add time. A plant that already sits there before the first post-upgrade
  boot can be adopted — but the worker-root check refuses any local plant under
  a worker-writable root (workspace, data dir, shared home) at every use, and a
  planted https URL carries no matching credential, so the push fails closed.
  The pin-derived repo identity (behavior 7) inherits the same residual.
  The residual window is no wider than the pre-fix state and closes after the
  first capture.
- `url.<base>.insteadOf` or `url.<base>.pushInsteadOf` rewriting to a foreign
  https host stays possible for fetches of public repos; no token matches the
  rewritten host. The code it could feed the board is code the worker already
  holds.
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
  the gate closed, with the entry named in the error.
- A planted `url.<evil>.pushInsteadOf` entry matching the pin fails the push
  closed.
- A planted `remote."<pin>".url` section aimed at a second scratch repo fails
  the target fetch closed: `resolveTarget` skips the fetch with a warning and
  `refs/remotes/origin/main` keeps the pinned repo's tip. A control fetch by
  plain git proves the plant is live.
- A planted `remote."<pin>".pushurl` entry fails the push and the guard
  closed.
- A pin that starts with `-` (a git option, not a URL) fails closed.
- A relative pin git reads as a local path (`./x:y.git`: first slash before the
  first colon) gets the worker-root check and fails closed under a configured
  root; the same reading without roots pushes a relative bare.
- Every `file://` authority form (`file://host/path`, `file://localhost:9/path`,
  `file://%2Fpath` with all slashes encoded) resolves to the local path git
  reads and gets the worker-root check.
- An upstream the pin does not cover (a fork remote, a merge ref outside
  `refs/heads`) skips the refresh fetch with a warning; no fetch by remote name
  runs.
- A pin under a configured worker root fails closed; with no roots configured
  the same pin works (native behavior unchanged).
- A planted `remote.origin.fetch` refspec is ignored by the pinned
  `resolveTarget` fetch: the tracking ref moves to the pinned repo's tip.
- `getSettings`/`setSettings` round-trip `originUrl`; a wrong shape keeps the
  default.
- A planted `remote.origin.pushurl` naming a second repo leaves the board's
  repo identity on the pinned origin repo (`src/worktree.test.ts`).
- A planted `url.<x>.pushInsteadOf` rewrite does the same.
- A gitless project that gains its origin and commits at the init endpoint
  leaves init with the real origin as its pin, the pin-derived repo identity,
  and a run branch-rules probe (`src/app.test.ts`).
- Boot pins the URL before the turn loop starts; `addProject` pins right after
  the clone.

## Non-goals

- No UI for the pin; the settings API and re-adding the project are the paths.
- No change to `remoteUrl` (display-only icon read) or to the fork
  mirror (already explicit URLs into the server-only dir, OTTR-180).
- No change to clone: the admin's URL is validated by `parseGitUrl`
  (https/ssh only).

Superseded 2026-11-23 (OTTR-1004): the earlier non-goal "No change to
`remoteUrl`/`githubUrl`" held for the push and fetch paths only. `Entry.github`
was a live `githubUrl` read of the worker-writable remotes while issue watch,
PR review, Dependabot, App token minting and releases acted on it, so behavior 7
replaces that read with the pin-derived `githubUrlFromPin`.
