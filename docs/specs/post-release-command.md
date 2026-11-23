# Post-release command

## Problem

After a release, some projects must refresh artifacts from the released tag.
Velvarr's landing page links the latest release, so its screenshots must come
from that release. Today a person must remember this step after each release.

## Behavior

1. New project setting `postReleaseCommand` (one line, at most 300 characters,
   null when absent), next to `releaseCommand` in `ProjectSettings`. The same
   validation as `releaseCommand`: trim, empty becomes null, reject more than
   300 characters, reject control characters. Same settings UI: a second field
   in the Releases settings card.
2. After a release succeeds (the tag and the GitHub release exist; the project
   command path verifies the same claim), the board runs this command once, in
   a clean detached worktree of the repository at the target branch's head
   (the tag's commit when the target does not resolve). The command gets
   `OTTR_RELEASE_TAG` (`vX.Y.Z`) and the same env hygiene as `releaseCommand`
   (`releaseEnv`: hosted secret stripped, repo-relocating git vars stripped,
   database env). Output streams to the release card's log.
3. Two project settings decide what happens to tracked changes (gitignore
   respected; `git add -A`):
   - `postReleaseLanding`: `"card"` (default) or `"commit-push"`. The route
     accepts only those two values. Anything else stored reads as `"card"`.
   - `postReleasePaths`: repo-relative path prefixes, one per line in the UI;
     each trimmed, 1 to 200 characters, no control characters, not absolute
     (`/...`), no `..` segment. It must not be empty when `postReleaseLanding`
     is `"commit-push"` (the settings route refuses that combination).
   A file matches a prefix segment-wise: equal to the prefix or under
   `prefix/`.
4. Landing `"card"` (default), or `"commit-push"` with any changed file
   outside `postReleasePaths`: the changes land as one `chore:` commit with
   the board's default identity, the board creates a normal card on a branch
   at that commit in the project's worktrees dir, and queues it at
   `merging`/`queued`. The card runs the normal path: the merge turn rebases,
   runs the gates and merges; only the merge turn pushes. The command never
   pushes by itself.
5. Landing `"commit-push"` with every changed file under `postReleasePaths`:
   the board puts its commit on a temporary branch and runs the merge turn's
   own push step (`serverMergePush` with a fast-forward of the local target
   and a push by the pinned origin URL, the board's own credentials, LFS
   objects first, redacted output). No card is filed. The commit subject is
   fixed: `chore: refresh landing site for <tag>`. A moved origin rejects the
   push; a rejected or failed push does not undo the release: it parks the
   release card with the push error and a reply reruns the command.
6. When the command changes nothing, the board logs that and files no card.
7. A failed command does not undo the release. The release card parks at
   `needs_you` with `Post-release command failed: <reason>. Fix it, then
   reply to retry.`, the command output stays on the card log, and a reply
   reruns the publish (idempotent) and the command.

## Environment variables

- `OTTR_RELEASE_TAG`: the released tag, for example `v1.2.3`.
- `OTTR_RELEASE_VERSION` and `OTTR_RELEASE_COMMIT` (the released tag's commit)
  come from the shared `releaseEnv`. `OTTR_RELEASE_NOTES_FILE` is not set for
  this command (the release is already published; there is no notes file).

## Boundaries and errors

- The scratch worktree lives in a temp dir, is detached (no branch name
  conflicts), and is removed after the run; a failed removal is logged, not
  thrown.
- The card's `base` is the commit's parent (the worktree base); its branch tip
  is the command's commit. A failure after the card row is created cancels the
  partial card best-effort and parks the release card.
- The commit-push branch (`ott/post-release/<task id>`) is temporary: the push
  step removes it again; a failed removal is logged, not thrown. No hold gate
  rides this push (`leaseTip` null): the only commit it carries is the board's
  own landing refresh, and a moved origin still rejects it.
- The `publishing` claim stays held while the command runs, so a cancel cannot
  interleave; this matches the release command's behavior.
- No timeout: the command may install and build, like `releaseCommand`.
- The command runs project code with the board's trust, in the same process
  context and with the same secret rules as `releaseCommand` (the release
  card's turn, `releaseEnv`, output redaction unchanged).

## Decisions

- The Segoe UI question (Velvarr's screenshots on Linux workers) is resolved
  for now by accepting `--allow-font-fallback` in Velvarr's command; no fonts
  go into the worker image.
- The release-creation 409 guard (`release settings changed`) still compares
  only `originUrl`, `targetBranch` and `releaseCommand`: the post-release
  settings do not change the release plan, and the publish reads settings
  fresh.
- `releaseBlocked` keeps its `releaseCommand` argument; the post-release
  settings do not block a release on running merges.
- `postReleasePaths` applies to `commit-push` only; `"card"` landing ignores
  it. A stored `postReleaseLanding` that is not `"commit-push"` reads as
  `"card"`.
- The commit-push push reuses `serverMergePush` (the merge turn's own server
  push: local target fast-forward, LFS objects first, pinned-origin push with
  redacted output). One attempt; a rejection parks the release card, and the
  reply rerun makes a fresh commit.

## Acceptance checks

- The settings save, validate and show; unit tests cover the 400 messages, the
  trim, empty to null, the two landing values, the prefix rules, and the
  commit-push-with-empty-paths refusal.
- A release with a post-release command runs it once at the new tag; the real
  repo test reads `OTTR_RELEASE_TAG` and counts one run.
- A failing command leaves the release intact and parks the release card with
  the failure; a reply reruns it.
- Card landing: changed files file one normal card at `merging`/`queued` on a
  branch whose tip is the command's commit; no changes file no card.
- Commit-push landing: changed files under the paths end with one new pushed
  commit on the target branch and no card; a change outside the paths creates
  a card instead; a failed push parks the release card.
- Gates: `bun run check`, `bun test`.

## Non-goals

- No worker-image font installs; no Windows runner.
- No dry-run line for the post-release command in the release dialog.
- No timeout or output cap for the command beyond what `releaseCommand` has.
- No changes to `releaseCommand` semantics or to `src/prompts.ts`.
