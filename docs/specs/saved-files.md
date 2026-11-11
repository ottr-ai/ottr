# Saved files for done cards (OTTR-826 P2)

A card that produced a report or other output must not lose it when the card finishes and
its worktree is removed. Today only `research-report.md` (as `task.report` text) and adopted
shots survive; every other uncommitted file is deleted (`removeDoneWorktree` runs
`git worktree remove --force`). Work cards' untracked files already move to
`<tasksDir>/quarantine/<id>` (turn settle and supervisor reclassify), but nothing shows them.

## Behavior

### Folder
- One folder per card, the existing quarantine store: `join(store.tasksDir, "quarantine", id)`.
  No new directory kind, no new store column.
- The user-facing name is "Saved files"; the folder name stays `quarantine`.

### Save at done (turn.ts)
- `removeDoneWorktree` saves files BEFORE `ops.removeWorktree`, after the
  `uncommittedFiles` capture. Applies to every card that passes the
  interview/grill/scout guard (research cards are the target; merge/work done cards
  with leftovers benefit identically).
- New op `saveDoneFiles(worktreePath, saveDir, dataRoot, maxBytes)` in `src/worktree.ts`:
  - every non-ignored untracked file MOVES into `saveDir` (repo-relative paths preserved,
    exactly `quarantineUntracked`'s semantics and containment: `trustedAnchor` worktree side,
    `dataRoot` anchor on the save side, `moveBelow`, no symlink followed, symlinked parent
    throws "refusing <path>"), symlinks move as links;
  - every tracked file with staged or unstaged content changes (`git status --porcelain`
    XY with M/A/T/R/C/U, not pure D) COPIES its current worktree content into `saveDir`
    (`readBelow` + `writeBelow` bytes; a symlink entry copies as a link via `copyBelow`).
    Tracked files are copied, never moved.
  - Cap: a regular file larger than `maxBytes` is NOT saved; its repo-relative path is
    returned in `tooLarge`. The chosen cap is `REPORT_MAX_BYTES` (4 MiB, `src/turn.ts`),
    the existing report-reader cap. Note: `quarantineUntracked` itself applies no size
    cap today; this cap is new and applies only to the done-save path.
  - A missing worktree directory (a merged card keeps its worktree path after the
    directory is gone) saves nothing and returns empty — no failure log.
  - An untracked entry that is not a regular file (a nested repository, which git lists
    as `dir/`; git never lists FIFOs or sockets) moves whole when the move succeeds and
    lands in `failed` with a reason when it cannot (a directory cannot cross a mount
    point: compose keeps the worktree on `/workspace` and the save folder on `/data`).
    A tracked gitlink (a submodule) is skipped — the submodule pins its own content.
    Either way the save continues, so entries after them are still saved.
  - Vanished paths (deleted between status and save) are skipped.
  - Returns `{ moved, copied, tooLarge, failed }` (repo-relative, forward slashes);
    the caller logs each `failed` entry as `<path>: not kept (<reason>)`.
- `removeDoneWorktree` logs, mirroring `quarantineUntrackedFiles`' style, and never lets a
  save failure block the removal:
  - `saved <n> file(s) to .tasks/quarantine/<id>: <up to 20 names>` (n = moved + copied)
  - one line per refused file: `<path>: too large, not kept`
  - on a thrown error: `saving done files failed: <err>`
- `research-report.md` is saved like any other file (no special case) AND stays captured in
  `task.report` as today.
- Kept-worktree cards (`finishKept`) are out of scope: the user already chose per-file
  move/ignore/delete there.

### Serve + list (app.ts)
- Detail view (`GET /api/projects/:project/tasks/:id`) gains `savedFiles`:
  `{ name: string; size: number }[]` for `stage === "done"` cards, walking
  `quarantine/<id>` recursively (repo-relative names, regular files only — symlink entries
  are not listed), sorted by name; `[]` when the folder is absent. Absent on open cards.
- New route `GET /api/projects/:project/tasks/:id/saved-files?path=<rel>` serves one file
  from `quarantine/<id>` with the exact header pattern of the existing
  `tasks/:id/files` route: `Content-Security-Policy: sandbox allow-scripts`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Connection: close`,
  `Content-Type: Bun.file type || application/octet-stream`. The read anchors at the
  trusted `dataRoot` (a mount point no worker can replace), so a worker-planted symlink
  at the card folder or below is refused with the rest.
- Refusals: empty `path`, `..` segments (either separator), absolute paths → 400
  `{"error":"bad path"}`; resolved path leaving the card's folder → 400; a symlink at
  ANY path component, a non-regular entry, or an over-cap file (readBelow's O_NOFOLLOW
  walk, so an untracked link cannot widen the read) → 404 `{"error":"unknown file"}`;
  missing entry → 404. The read is capped at 64 MiB (bounds the buffer; older quarantine
  entries are uncapped).

### Drawer (ui/app.tsx)
- New `DrawerSec` `id="drawer-saved"` label `Saved files` inside `DrawerFiles`, shown when
  `task.savedFiles?.length`, for research and work cards alike. Each entry: download link
  to the saved-files route (`target="_blank"`) with name and human-readable size
  (new `fmtBytes`: B / kB / MB), capped at 50 rows + "…and N more" like Worktree files.
  The listing walks `quarantine/<id>` through the same trusted-anchor confinement
  (`withDir`, per-component O_NOFOLLOW, fd-based lstat): a worker-planted symlink at the
  card folder or below lists nothing instead of the link target.
- The done-card hint of "Worktree files" changes from "only the names remain" to point at
  Saved files when a saved list exists.

### Follow-up handoff (prompts.ts, app.ts, turn.ts, supervisor.ts)
- `handoffMarkdown` gains optional `savedDir?: string | null`; when set it renders a
  `- Saved files: \`<dir>\`` bullet in the metadata list (the worktree is gone; the folder
  keeps the card's uncommitted files).
- Three call sites pass it when the card's `quarantine/<id>` folder exists:
  the drawer's Follow-up handoff (`followUpHandoff`, `src/app.ts`), the retro proposal
  handoff (`src/turn.ts`), and the CI follow-up (`ciFileFollowUp`,
  `src/supervisor.ts`). A research card's follow-up (the drawer button) therefore names
  the folder.

## Error cases
- Save failure (git failure, refusing symlinked parent): logged, removal proceeds — the
  pre-change behavior (files lost) must never regress into a stuck done settle.
- Serving refuses traversal, absolute paths, and symlinks; the listing never follows or
  exposes links.
- Quarantined LLM image fragments (text-only retry) share the folder; they surface in the
  listing like any other file the task produced. Accepted.

## Acceptance checks
1. turn.test.ts: a research card leaving `research-report.md` + `mockup.html` settles done;
   the worktree is gone, `task.report` holds the report text, and `mockup.html` exists at
   `quarantine/<id>/mockup.html`. This test runs the REAL `saveDoneFiles` against real
   directories (no stub) and asserts the card log names the saved files.
2. worktree.test.ts: `saveDoneFiles` moves nested untracked files, copies tracked-modified
   content, moves a symlink as a link, and lists an oversize file in `tooLarge` without
   saving it.
3. app.test.ts: a done card's detail lists saved files with sizes; the serve route returns
   bytes with the sandbox headers; `..` is refused 400; a symlink entry is refused 404.
4. ui/app.test.tsx: a done card with `savedFiles` renders the `drawer-saved` section with
   links and sizes. Plus puppeteer screenshots of the section (AGENTS.md UI rule).

## Non-goals
- No retention or cleanup job for the quarantine store (noted size: ~21 folders, ~90 MB on
  the ottr board as of 2026-11-11).
- No per-turn report history: `task.report` keeps only the latest report.
- No change to shot adoption, `finishKept`, or `quarantineUntracked` itself.
