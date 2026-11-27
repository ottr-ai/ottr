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
- `partial` — the seed run exited non-zero, and the main results file and the rules
  sync's own `<results>.rules.json` file both parse, and both hold `fatal` `false`,
  and every item status is a normal status or a left-out status, and at least one
  item is left out. Actions: clear `seed-failed`, write `seed-partial`, log the
  partial line, `seeded: true`, `failed: false`. The run exits 0.
- `failed` — anything else: a results file is absent or unparseable, a `fatal` is
  `true`, `items` is missing or empty, an item carries an unknown status, or no item
  is left out. Today's failure path: write `seed-failed`, leave `seed-commit` and
  `seed-partial` untouched, `failed: true`, run exits 1.

Normal statuses: `unchanged`, `added`, `updated`. Left-out statuses: `rejected`,
`inconclusive`. The card scopes the partial outcome to those two; a `no-origin` item
fails the seed like any other unknown shape, so a missing origin keeps the red notice
— a rejected item next to a `no-origin` one fails too. An `installed` item fails the
seed only on a `user/`-prefixed item other than `user/omp/plugins`: layer mode labels
every snapshot write `added`, `updated`, or `unchanged`, so an `installed` user item
proves a flat run, and a flat run never switched the layer. `installed` on the
plugins item is legitimate in both modes (bun install), and `installed` on rule items
is legitimate because the first layer's nested sync and the external sync run without
`--compare`, so every change labels `installed`. The external file may hold an empty
items list — a data repository with no rules writes one — and it leaves the main
file's verdict standing. The same rule failing in both files (install-user merges the
nested sync's items into the main file, and the external sync reports the rule again)
counts once.

Exit 0 decides `ok` on its own. A results file that contradicts exit 0 is logged as a
warning; the exit code stays authoritative, because an old Alate image writes no
results file at all and must keep seeding as `ok`.

## Result contract with install-user

Already implemented in Alate (`specs/provision-item-by-item.md` in the alate repo, the
"Machine-readable results file" section). No Alate change is needed.

- The seed passes a per-run results path with a compose run env flag:
  `docker compose run --rm --no-deps -e ALATE_PROVISION_RESULTS=/etc/ottr/seed-results-<run>.json board-seed ...`
  in both `seedSource` arg variants (`--repo` and `--data`). The fresh name every run
  means a later run can never read the previous run's file: a clone failure before
  install-user writes leaves the old file in the volume, and a shared path would
  classify that stale file as this run's outcome. The seed removes both files after
  the read, so the volume keeps no file per run.
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
- The seed reads the files back through the same board-seed service, so the read does
  not depend on the server container or on uid coupling:
  `docker compose run --rm --no-deps --entrypoint sh board-seed -c 'cat <path>'`.
  The reads run inside `runSeed`'s `ALATE_IMAGE` discovery window. An unreadable or
  unparseable read classifies the run as `failed` when the seed exited non-zero, and
  as `ok` when it exited 0.

## The complete seed pipeline

The board-seed entrypoint is a compound command:
`install-user.mjs --home /etc/ottr/home --layer`, then
`sync.mjs /etc/ottr/home/.omp/agent/rules` (the flat rules mirror). The `--layer` flag
is required: without it (or `ALATE_LAYER=1`) install-user runs a flat install, and the
partial outcome's required layer switch never happens. install-user's layer mode
installs the layer rules itself through a nested sync and switches the layer, but the
flat mirror needs the second command, and with `&&` a per-item failure (exit 1,
`fatal` `false`) skipped it. The entrypoint now runs the flat sync for every
install-user run whose results file says `fatal: false`, points it at
`<results>.external-rules.json` so its outcome is machine-readable and distinct from
install-user's nested `<results>.rules.json` — an external crash must not borrow the
nested file as its proof — and folds both exit codes into one non-zero exit. The
fatal guard is whitespace-tolerant (`'"fatal": *true'`), because
writeProvisionResults pretty-prints the JSON. A fatal refusal still skips the sync
(nothing was installed), and a run without the results env — a plain manual
`docker compose run board-seed` — keeps the old success-only sequence. The
classification accepts a partial outcome only when the external file proves the sync
ran; a missing or fatal external file fails the seed. The reads order the external
file first: the main read's exec removes all three files, so a main-first order
would always find no external file. The compound command is itself under test: a
stub `node` on PATH runs the real command string from the compose file across the
fatal, per-item, success, and manual scenarios, asserting the layer flag in
install-user's argv, which stages ran, the external file's content, and the folded
exit codes.

## Records

All records live next to the board home in the `board-config` volume. The seed is
their only writer.

`/etc/ottr/seed-commit` — unchanged format. A partial seed sets `seeded: true` and
records the commit in the seed phase itself: a deferred restart (a busy runner, turns
past the hold) leaves `recordSeed` unwritten, and an unrecorded commit would make the
next run seed the same commit again, repeating the scans. `recordSeed` rewrites the
same value after the board took the deploy, and `seedOnlyUpdate` records immediately.
The next run's `readSeedRecord` comparison then skips the same commit.

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

The board renders an amber notice line: the amber alarm triangle (`Mark kind="needs"`,
`--alarm`) and the headline text in `--alarm`, the seed-failed line's component
pattern. Details stays normal text.

- Headline: `Agent layer at <commit.slice(0,12)>: <count> skill left out` with plural
  `skills` for counts above 1.
- A details disclosure lists one line per item: `<name> — <rule>`.
- `role="note"`, inbox key `seed-partial:<since>`, fresh-on-first-view like the
  seed-failed line, dropped in hosted mode like the seed-failed line.
- The red "seed failed" notice stays bound to `seed-failed` only.

## Acceptance checks (tests that fail before the change)

1. Host, partial: a seed run that exits non-zero with a main results file of 3
   rejected or inconclusive items, the rest unchanged, and a rules results file with
   `fatal` false writes `/etc/ottr/seed-commit` and `/etc/ottr/seed-partial`, removes
   `/etc/ottr/seed-failed`, and exits 0. A next run whose `seed-commit` read equals
   the commit does not run install-user again.
2. Host, failed: a seed run with an install error (non-zero exit, no results file)
   writes `seed-failed`, leaves `seed-commit` unwritten, exits 1.
3. Host: an unparseable or missing results file on a non-zero exit counts as failed;
   so does a missing or fatal rules results file, because the pipeline then never
   completed.
4. Host: `fatal: true` counts as failed; an unknown item status counts as failed; a
   lone `no-origin` item counts as failed too.
5. Host, stale result: a partial run leaves its results file in the volume, and a
   later run whose install-user never wrote (a clone failure) reads no file for its
   own per-run path — the later run fails with the red notice, records no
   `seed-commit`, and never adopts the stale items. Each run's files are removed
   after the read.
6. Host: the board-seed entrypoint's compound command runs the flat rules sync for
   every install-user outcome whose results file holds `fatal` false, points the sync
   at its own `<results>.rules.json`, skips the sync on a fatal refusal and when no
   results env is set (the old success-only sequence), and folds both exit codes into
   one non-zero exit.
7. Host: an `ok` seed removes both `seed-failed` and `seed-partial`.
8. Host: an old Alate image (exit 0, no results file) stays `ok` with no records.
9. Host: a failed `seed-partial` write stays advisory and keeps the outcome.
10. Host: the partial record redacts secrets, control bytes and quotes, caps at 20
    items, and drops a garbage commit.
11. Board: the state carries `seedPartial` only for a well-formed record; malformed,
    oversized, and control-character records give null; a stored secret redacts out.
12. Board UI: the amber partial notice renders the alarm triangle and the
    `--alarm`-colored headline with the item list; the red notice still renders only
    for `seed-failed`; hosted mode drops both. UI test plus a screenshot of the amber
    notice.

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
- Count `no-origin` items as left out. Rejected in review: the card scopes the partial
  outcome to rejected or inconclusive items, and Alate emits `no-origin` for MCP
  servers and rules too, so the extension would clear the red notice for failures the
  card never approved.
- Accept a partial outcome from install-user's file alone. Rejected in review: the
  compose entrypoint gates the flat rules sync on install-user's exit, so an exit-1
  run proved nothing about the rules half; the classification now requires the rules
  sync's own `<results>.rules.json` file with `fatal` false.

## Risks

- An Alate image older than the results-file feature writes no file: a non-zero seed
  stays `failed` (today's behavior), an exit-0 seed stays `ok`. No regression window.
- `fatal: false` as the layer-switched signal is a contract fact from Alate's
  provision-item-by-item spec, not something the seed observes. If Alate ever breaks
  it, the amber notice can show for an unswitched layer; the next run still re-seeds,
  because `seed-commit` was written — the same trade a full `ok` already accepts.
- A partial record written while the server is down cannot reach the board until the
  next server start; the write is advisory and the record survives in the volume.
