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
  - the ask card: `stage` in_progress, `state` needs_you, an `asked` round
    whose question and options carry long unbroken tokens (API paths, jq
    filters) the drawer must wrap.
- Boots `bun src/server.ts` in production asset mode on a free port with
  `OTTR_DEMO=1`, the fresh root, state dir, and workers home.
- Drives headless Chrome over CDP (1440x900, dark, `en-US`) to each requested
  view and writes `shots/<view>.png` in the worktree:
  - `card`: the parked PR card's drawer at
    `/projects/lumen/tasks/<prId>`.
  - `done`: the contrast done card's drawer.
  - `ask`: the ask card's drawer; the question's long tokens must wrap
    inside the panel. Writes the dark `ask.png`, then stores the light
    theme and navigates fresh (a reload's style-only repaint can miss the
    headless surface) to write `ask-light.png`.
  - `board`: the Lumen project face.
  - `settings-hindsight`: `/settings`, scrolled to the Hindsight card. The
    board env strips the host's Hindsight endpoint and pins
    `OTTR_BOARD_OMP_HOME` to `/proc/nonexistent`, so the memory probe fails
    deterministically and the card renders its no-memory warning line; the
    run refuses when the line is missing. No network dependency.
  `--view` may repeat; the default view is `card`.
- Prints the planted card ids before the board boots.
- Bounds every wait: an overall 90 s watchdog plus a deadline on each CDP
  call, the Chrome endpoint line, the readiness poll, and each page load.
- Gives Chrome its own writable HOME: its caches and crash database die on a
  read-only one before any endpoint line. The sandbox stays on: only a root
  run drops it, and a boot that dies before the endpoint line fails the run.
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

- Other card fixtures than the three planted ones (add a view when a card
  needs one). Settings views stay single-purpose: a view that
  needs a warning line drives its own env and asserts the line.
- Screenshots of system pages.
- Visual-regression goldens or pixel-diff gates.
