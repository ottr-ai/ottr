# Card view screenshots (`scripts/card-shot.ts`)

## Problem

Every UI work turn re-derives the screenshot machinery of
`scripts/readme-screenshot.ts` in a throwaway scratch script. The retros list the
same failure class again and again: OTTR-361 (unbounded waits in a shot script,
about 15 minutes lost), OTTR-367 (dead board and stale HMR before shots, 14
minutes), OTTR-391 (three failed throwaway render attempts), OTTR-387 (shot
boards need a free port and their own state dir), OTTR-694 (68 of 101 work-turn
minutes went to the shot phase: SQLITE_BUSY wedges from boards sharing the
worktree `.dev`, a wrong Chrome cache layout, and a 25-minute hang after the
shots were already written).

## Scope

- One command: `bun scripts/card-shot.ts --pr <number> [--view <name>]...`.
- Plant-then-boot: the script plants fixture rows into a fresh state dir with
  direct sqlite before any board boots on it. No write ever hits a live
  board's database, and the worktree `.dev` pool stays untouched.
- Shared machinery lives in `scripts/shot-lib.ts`, extracted from
  `scripts/readme-screenshot.ts`. That script keeps its behavior; it imports
  the extracted helpers.
- No npm dependency: Chrome is driven over CDP with Bun's WebSocket client,
  like `readme-screenshot.ts`.

## Behaviour

- Always creates its own fresh root and `OTTR_STATE_DIR` under the OS temp dir
  (never the worktree `.dev`), seeds the five-project demo pool with
  `seedDemo`, and plants fixture cards into the Lumen project database before
  the board boots:
  - a parked PR-mode card: `stage` merging, `state` idle, `needs_reason`
    NULL, `push_sha` NULL, `pr_number` `<number>`, a GitHub PR URL. The
    status line reads "PR #N open · waiting for merge" and the card carries
    the PR chip.
  - a normal done card next to it, for contrast.
- Boots `bun src/server.ts` in production asset mode on a free port with
  `OTTR_DEMO=1`, the fresh root, state dir, and workers home.
- Drives headless Chrome over CDP (1440x900, dark, `en-US`) to each requested
  view and writes `shots/<view>.png` in the worktree:
  - `card`: the parked PR card's drawer at
    `/projects/lumen/tasks/<prId>`.
  - `done`: the contrast done card's drawer.
  - `board`: the Lumen project face.
  `--view` may repeat; the default view is `card`.
- Prints the planted card ids before the board boots.
- Bounds every wait: an overall 90 s watchdog plus a deadline on each CDP
  call, the Chrome endpoint line, the readiness poll, and each page load.
- Verifies every PNG (signature `89 50 4e 47 0d 0a 1a 0a` and the 1440x900
  IHDR size) after the children are stopped, then calls `process.exit` so the
  script cannot hang after success.
- Stops only the children it spawned (Chrome and the board): SIGTERM, then
  SIGKILL after 5 s. Failures exit non-zero.

## Acceptance

- From a worktree, `timeout 120 bun scripts/card-shot.ts --view card --pr 53`
  exits 0 twice in a row inside the cap. Both runs write a valid-PNG
  `shots/card.png`, print the planted card id, and leave no process listening
  on the script's port afterwards.
- `bun run check` and `bun test` stay green.

## Non-goals

- Other card fixtures than the parked PR card and the done card (add a view
  when a card needs one).
- Screenshots of settings or system pages.
- Visual-regression goldens or pixel-diff gates.
