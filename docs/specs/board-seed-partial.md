# Board seed partial outcome

The board seed (scripts/update-image.ts, `seedBoard`) installs the agent layer into
`/etc/ottr/home` with Alate's `install-user.mjs`. When the scan gate rejects single
items, or cannot decide them, everything else still installs and the layer switches.
Today such a run counts as failed: no `/etc/ottr/seed-commit` write, a red notice, and
a re-seed of the same commit on every later run.

This spec adds a third outcome, `partial`. A partial seed counts as done for its
commit. The board shows an amber notice with the left-out items. A real failure keeps
today's red notice and behavior.

## The three outcomes

`runSeed` classifies the seed run. The classification reads install-user's structured
results file, never the stdout text.

- `ok` — the seed run exited 0. Today's success path: clear `seed-failed` and
  `seed-partial`, log the success line, `seeded: true`.
- `partial` — the seed run exited non-zero, and the results file parses, and
  `fatal` is `false`, and every item status is a normal status or a left-out status,
  and at least one item is left out. Actions: clear `seed-failed`, write
  `seed-partial`, log the partial line, `seeded: true`, `failed: false`. The run
  exits 0.
- `failed` — anything else: the results file is absent or unparseable, `fatal` is
  `true`, `items` is missing or empty, an item carries an unknown status, or no item
  is left out. Today's failure path: write `seed-failed`, leave `seed-commit` and
  `seed-partial` untouched, `failed: true`, run exits 1.

Normal statuses: `installed`, `unchanged`, `added`, `updated`. Left-out statuses:
`rejected`, `no-origin`, `inconclusive`. `no-origin` counts as left out: the item is
excluded the same way, and a seed that reds forever on a missing origin would never
heal.

Exit 0 decides `ok` on its own. A results file that contradicts exit 0 is logged as a
warning; the exit code stays authoritative, because an old Alate image writes no
results file at all and must keep seeding as `ok`.

## Result contract with install-user

Already implemented in Alate (`specs/provision-item-by-item.md` in the alate repo, the
"Machine-readable results file" section). No Alate change is needed.

- The seed passes the results path with a compose run env flag:
  `docker compose run --rm --no-deps -e ALATE_PROVISION_RESULTS=/etc/ottr/seed-results.json board-seed ...`
  in both `seedSource` arg variants (`--repo` and `--data`).
- install-user writes the file atomically at the end of every run, mode 0600, into the
  `board-config` volume:
  ```json
  {
    "fatal": false,
    "error": null,
    "items": [
      { "item": "user/omp/agent/skills/demo", "status": "unchanged", "rule": null, "at": null },
      { "item": "user/agents/skills/ffmpeg-skill", "status": "rejected",
        "rule": "hidden character U+200D", "at": "SKILL.md:7", "report": "..." },
      { "item": "user/omp/agent/skills/slow", "status": "inconclusive", "rule": null, "at": null,
        "report": "..." }
    ]
  }
  ```
- Layer mode labels `added`/`updated` replace `installed`; the nested `sync.mjs` rules
  run merges its per-item failures into the same `items` array. A nested refusal
  aborts the layer switch and marks the run fatal, so `fatal: false` implies the layer
  switched.
- The seed reads the file back through the same board-seed service, so the read does
  not depend on the server container or on uid coupling:
  `docker compose run --rm --no-deps --entrypoint sh board-seed -c 'cat /etc/ottr/seed-results.json'`.
  The read runs inside `runSeed`'s `ALATE_IMAGE` discovery window. An unreadable or
  unparseable read classifies the run as `failed` when the seed exited non-zero, and
  as `ok` when it exited 0.

## Records

All records live next to the board home in the `board-config` volume. The seed is
their only writer.

`/etc/ottr/seed-commit` — unchanged format. A partial seed sets `seeded: true`, so the
existing writers record it: `recordSeed` after the board took the deploy, and
`seedOnlyUpdate` immediately. The next run's `readSeedRecord` comparison then skips
the same commit.

`/etc/ottr/seed-partial` — new, written only for a partial outcome:

```json
{
  "commit": "<full sha, or \"\" when the run had none>",
  "since": 1763975520000,
  "count": 3,
  "items": [
    { "name": "user/agents/skills/ffmpeg-skill", "rule": "hidden character U+200D" },
    { "name": "user/agents/skills/shorts", "rule": "incomplete dependency coverage" },
    { "name": "user/omp/agent/skills/ghost-editor", "rule": "inconclusive" }
  ]
}
```

- `name` is the install-user item key. `rule` is the item's `rule` when it is a
  non-empty string, else the status word (`rejected`, `no origin`, `inconclusive`).
- Bounds: at most 20 items (the first 20), `count` is the true left-out total before
  the cap, each string at most 200 characters.
- Sanitization at write, per string, the `seedFailRecord` recipe: redact the env's
  secret-shaped values, control characters become spaces, single quotes drop, trim.
  The JSON reaches the file through `printf %s '<json>'`, so no single quote may
  survive.
- Write failures are advisory: one log line, the run keeps its outcome. A lost record
  only loses the notice.
- A partial write replaces any earlier `seed-partial`. An `ok` seed removes it with
  `seed-failed` in one `rm`. A `failed` seed leaves it: the layer is still at the old
  partial commit, so the amber notice stays true.

## Board notices

The server reads `seed-partial` next to the board home, the same way `seedFailedView`
reads `seed-failed`. New state field `seedPartial` on `/api/state`, new type
`SeedPartialView`:

```ts
interface SeedPartialView {
  /** The data-repo sha the partial seed recorded; "" when absent. */
  commit: string;
  /** Epoch ms of the partial seed. */
  since: number;
  /** Left-out item total before the 20-item list cap. */
  count: number;
  /** The capped, sanitized item list. */
  items: { name: string; rule: string }[];
}
```

`seedPartialView()` returns null on any read, parse, shape, size, or control-character
failure, like `seedFailedView()`. Bounds: whole file at most 12000 characters,
`since` a positive integer, `count` an integer 0..100000, at most 20 items, `name` and
`rule` at most 200 characters each, commit matching `^[0-9a-f]{7,40}$` or empty.
`name` and `rule` redact through `redact(..., gitSecrets())` at view time.

The board renders an amber notice line (`mark-warn`, the seed-failed line's component
pattern):

- Headline: `Agent layer at <commit.slice(0,12)>: <count> skill left out` with plural
  `skills` for counts above 1.
- A details disclosure lists one line per item: `<name> — <rule>`.
- `role="note"`, inbox key `seed-partial:<since>`, fresh-on-first-view like the
  seed-failed line, dropped in hosted mode like the seed-failed line.
- The red "seed failed" notice stays bound to `seed-failed` only.

## Acceptance checks (tests that fail before the change)

1. Host, partial: a seed run that exits non-zero with a results file of 3 rejected or
   inconclusive items and the rest unchanged writes `/etc/ottr/seed-commit` and
   `/etc/ottr/seed-partial`, removes `/etc/ottr/seed-failed`, and exits 0. A next run
   whose `seed-commit` read equals the commit does not run install-user again.
2. Host, failed: a seed run with an install error (non-zero exit, no results file)
   writes `seed-failed`, leaves `seed-commit` unwritten, exits 1.
3. Host: an unparseable or missing results file on a non-zero exit counts as failed.
4. Host: `fatal: true` counts as failed; an unknown item status counts as failed; a
   `no-origin` item counts as left out.
5. Host: an `ok` seed removes both `seed-failed` and `seed-partial`.
6. Host: an old Alate image (exit 0, no results file) stays `ok` with no records.
7. Host: a failed `seed-partial` write stays advisory and keeps the outcome.
8. Board: the state carries `seedPartial` only for a well-formed record; malformed,
   oversized, and control-character records give null; a stored secret redacts out.
9. Board UI: the amber partial notice renders the headline and the item list; the red
   notice still renders only for `seed-failed`; hosted mode drops both. UI test plus a
   screenshot of the amber notice.

## Non-goals

- No change to the scan gate, its rules, or the SkillSpector pin.
- No change to Alate's own dashboard outcome or its load-dependent verdicts (ALAT-203).
- No change to `install-user.mjs`, `sync.mjs`, or the compose file; the env flag rides
  on the existing `docker compose run` arguments.

## Alternatives considered

- Server reads `seed-results.json` directly. Rejected: it couples the board server to
  install-user's schema and adds a second reader of a root-owned 0600 file; the
  record files are the board's own contract.
- Classify from install-user's stdout text. Rejected by the task: text is locale and
  wording dependent, and a quoted failure line can forge a classification.
- Read the results file through `compose exec server cat`. Rejected: it fails when the
  server is down and couples the read to the server container's uid; the seed-service
  one-off reads its own volume file as the same image user.

## Risks

- An Alate image older than the results-file feature writes no file: a non-zero seed
  stays `failed` (today's behavior), an exit-0 seed stays `ok`. No regression window.
- `fatal: false` as the layer-switched signal is a contract fact from Alate's
  provision-item-by-item spec, not something the seed observes. If Alate ever breaks
  it, the amber notice can show for an unswitched layer; the next run still re-seeds,
  because `seed-commit` was written — the same trade a full `ok` already accepts.
- A partial record written while the server is down cannot reach the board until the
  next server start; the write is advisory and the record survives in the volume.
