# Sync-commit checkout hygiene (OTTR-531)

## Problem

Agent turns sometimes commit to the checkout of another project (today: agent-data from
ottr turns). The rules say "commit on main, do not push", but nothing enforces or shows it:

- A turn can switch another project's main checkout to its own branch (OTTR-516) and leave
  commits on that branch (OTTR-527's commit landed on a foreign branch, not on main).
- A local main ahead of origin holds every merge (the OTTR-506 push hold), but the board
  shows no finding, so the hold sits for hours (AGEN-37 waited in merging/queued).
- Sync commits reach origin only by a manual user push.

## Behavior

### Detection

- `TurnProject` gains `mainBranch: string | null`: the main checkout's checked-out branch;
  null when detached, gitless, or git failed. The scheduler tick refreshes it next to
  `dirty` and `mainUnpushed` (failed checks keep the last value, like the existing flags).
- The default branch is the project's resolved integration target (`target` minus the
  `origin/` prefix). A null target or a gitless project gives no finding.
- Finding "off default": `mainBranch` is a branch and differs from the target branch name.
- Finding "unpushed": `mainUnpushed` (the existing `branchUnpushed` git fact).

### Turn outcome

After a turn settles, the loop checks every project's main checkout (target resolved, not
gitless) and appends one line per finding to the settled outcome's details:

- `Board: <project>'s main checkout is on branch <branch>, not <target>.`
- `Board: <project>'s local <target> has commits origin lacks.`

Findings apply only when the outcome exists; git failures add no line.

### Board banner

A project with a finding shows an advisory line in its column header, next to the dirty
banner. `ProjectView` carries `mainBranch` and `mainUnpushed` for this:

- Off default: "The main checkout is on branch `<branch>`, not `<target>`."
- Unpushed: "Local `<target>` has commits origin lacks. Merges wait until it reaches
  origin." with a "Push to origin" button.

### Approval and push

- `POST /api/projects/:project/push-main` runs
  `serverMergePush(e.path, e.path, target, "", null, originUrl)` — the exact authenticated
  path the merge flow uses: pinned origin URL, host auth from the server's stored token,
  never a force, credential-redacted errors, and the remote-tracking ref update after a
  landed push. A `pushed` result clears `e.mainUnpushed` at once (the hold lifts without
  waiting for the tick). Responses: 404 unknown project; 409 gitless or no target; else
  `{status: "pushed" | "skipped" | "failed" | "rejected", error?}`.
- New project setting `pushSyncCommits` (boolean, default false): standing approval. When
  it is on, the tick pushes once on the false-to-true edge of `mainUnpushed`. No edge (the
  push failed and the state stays unpushed) means no retry storm; the user clicks the
  button or fixes the cause.
- Without the setting or a click nothing pushes.

## Boundaries and error cases

- gitless project, null target, git failure: no finding, no push; the tick keeps the last
  flag values (existing pattern).
- Detached HEAD: `mainBranch` is null, so no off-default finding; the push does not depend
  on HEAD at all (it moves `refs/heads/<target>`).
- A checkout left on a foreign branch never blocks the push: the push moves the target ref,
  not the checked-out branch. The banner names the foreign branch so a human fixes it.
- A failed or rejected push returns the error text to the button and the banner stays until
  the next tick refresh flips `mainUnpushed`.

## Acceptance checks

- A turn that leaves a project's main checkout on a branch: the settled outcome details
  name the branch, and the project banner shows it.
- An approved push moves origin to the local main (fixture: bare origin plus an ahead
  clone; the endpoint moves the bare ref).
- With `pushSyncCommits` on, the tick pushes once on the unpushed edge; with it off,
  nothing pushes.
- `bun run check` and `bun test` exit 0.

## Non-goals

- No change to `src/prompts.ts` wording (hard stop).
- No new merge-hold semantics: the push hold keeps its existing trigger (`mainUnpushed`).
- No auto-push of anything but the local target branch ref; no force pushes.
- No new auth machinery: the board's existing loopback-trust model covers the new route,
  like the settings and drain routes.
