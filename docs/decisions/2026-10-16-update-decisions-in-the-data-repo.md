# Update decisions in the data repo (2026-10-16)

**Decision:** Approve and skip decisions for upstream updates live in one file,
`upstream-decisions.json` at the data repo root, next to `upstreams.json`. The Alate
dashboard is the only writer of that file: each Approve or Skip click lands as a commit in the
data repo. Ottr reads the decisions back through the `GET /api/updates` envelope (optional
`decisions` map), hides skipped rows, files the normal update cards for approved rows, and
forwards its own board decisions to Alate's `POST /api/updates/decision`. One writer (Alate), one
reader-actor (Ottr), one truth (the repo).

This amends the 2026-10-13 upstream update checks decision (U4). Alate's README said "it never
edits a repository". That boundary is now scoped: Alate edits exactly one file,
`upstream-decisions.json`, and it still never calls Ottr and never edits content files. The
dashboard's stored GitHub key needs `contents: write` on the data repo only.

## File format

```json
{
  "version": 1,
  "decisions": {
    "rtk@v1.2.3": { "decision": "skipped", "by": "alate-dashboard", "at": "2026-10-16T09:00:00Z" }
  }
}
```

- Key: the update id `<name>@<target>`, so a decision covers one release; the next release
  decides again (U5 unchanged).
- `decision`: `approved` or `skipped`. `propose: true` marks an approval of a too-young release
  (the G21 exception). `by`: `alate-dashboard`, `ottr-board` or `hand` — display only. No free
  text, so nothing in the file can reach a card prompt (U6 holds).
- A removed key means "no decision"; there are no tombstones.
- A separate file, not a section of `upstreams.json`: update cards edit the registry pins, and
  machine-written decisions in the same file would collide with them in merge conflicts.

## Why Alate is the only writer

- Ottr writing the repo itself would put git commit/push code in the board server and race the
  project's merge turns, which own `origin main` pushes. Rejected.
- A GitHub Contents-API writer in Ottr duplicates the credential and the conflict handling.
  Rejected.
- Local-only decisions (the state before this change) kept a split brain: a skip on one machine
  was invisible everywhere else, and nothing could approve an update outside the board.

One writer keeps the conflict handling a small map merge in one place, keeps one push credential
next to Alate's existing clone code, and keeps the audit log in the git history of the file.

## Ottr side

- Validation treats the `decisions` map like every other provider field: untrusted, per-entry
  validation, one bad entry dropped and counted, a bad envelope keeps the last good result.
- The row filter unions provider decisions, this board's own pending (unacked) decisions, and the
  legacy local skips. On boot the legacy `updateSkips` key migrates into the pending queue.
- After each validated pull, an `approved` decision files the same update cards the board's Allow
  button files, through one shared routine with the same guards (open card, `managedBy`,
  `removed`, repo mapping, target/propose agreement) plus a `filedApprovals` id set so a
  cancelled card does not re-file the same version.
- Decision latency to cards is at most one hour: the hourly pull or the next panel open.

## Security

- The new privilege is Alate's push to the data repo. That repo already steers every agent, so a
  compromised Alate gains nothing it did not effectively hold; the write path touches only the
  one decisions file.
- Decisions can only select ids for card filing. Prompts, steps and merge holds stay in Ottr
  (U6, U7, U8 unchanged). No provider text reaches an agent.
- The push grant is `contents: write` on the data repo only, for a fine-grained PAT.

## Rollout

1. The data repo: add `upstream-decisions.json` (empty map) and an "Upstream updates" paragraph in
   its AGENTS.md.
2. Alate: decisions table, `POST /api/updates/decision`, the write path (work clone, hooks
   disabled, fetch + reset, map merge, push with one retry), the `decisions` envelope extension,
   the dashboard buttons, and the README scope note. Then rotate the GitHub key to the scoped
   token.
3. Ottr (this repo): validation, forward queue, auto-file, panel chips, migration, this doc.
   Steps 2 and 3 are independent at the code level; the field is optional in both directions.
