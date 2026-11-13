# Development

The commands are the same in bash and PowerShell:

```sh
bun run check          # tsc, biome, boot smoke, license allowlist, scratch-image guard, agent-data sync guard, UI-screenshot reminder
bun test
bun run test:mutation  # StrykerJS, five configs with break thresholds
bun run audit:quality  # duplicate and dead code
bun run dev            # UI-only demo board on port 5747
```

A mutation run stays inside the host CPU. Each config takes the concurrency from the CPU: half of `os.availableParallelism()`, at least 1, capped at the config's measured maximum. `STRYKER_CONCURRENCY` overrides this value when set. A worker runs one mutation run at a time: each run holds a host-global lock file (`tmpdir()/ott-stryker.lock`). A second run waits and logs that it waits. A run removes a lock whose holder died. Each checkout gets its own Stryker sandbox parent (`tmpdir()/ott-stryker-<hash of its root>`) and wipes it at run start, so a killed run's leftover sandbox can never reach another run. Each config keeps its own incremental cache (`reports/stryker-incremental-<config>.json`, gitignored): a rerun re-tests only the mutants whose code or covering tests changed, and the release delta gate passes `--force` so a release always measures fresh (ARCH-REVIEWS.md "Delta gate").

A running card shows a live **Mutation testing** meter when the card's progress line matches the card format `<tool> <pct>% · <tested>/<total>[ · <stats tail>]`. The tail splits on ` · `, and a part like `38 survived (0.9%)`, `2 timed out`, `~2h 59m elapsed` or `~1h 23m left` becomes a labelled row while any other part shows raw. Ottr builds that line today from two tools only, in `src/stryker.ts`: a Stryker run (Node, read from the run's output through the `stryker-tap.cjs` copy when stdout is a pipe) and a Python `mutate.py` runner. Another tool needs no parser. Let the turn print one event line on the run's stdout stream, `{"type":"ottr_progress","text":"cargo-mutants 42% · 100/240 · 3 survived (1.2%)"}`, and the runner stores the `text` as the card's progress (`PROGRESS_EVENT` in `src/stryker.ts`, read in `src/runner.ts`). The meter's label stays `Mutation testing` whatever tool prints the line.

CI runs check, tests, dependency audit, e2e, gitleaks and zizmor on every push; weekly workflows add Docker build checks, Trivy, a warn-only Opengrep SAST scan over `src/` and an OWASP ZAP baseline scan. Package versions stay 7 days back (`bunfig.toml`), and every action pins a full commit SHA.

For UI work use `bun run dev`: it seeds five demo projects in `.dev/` (a fresh root per start), starts no agents, and never touches a real board. A board whose pinned `OTTR_DEV_ROOT` is held by another board seeds its own root `.dev-<PORT>/` and prints a warning, so set a free `PORT` for it. It also backs `bun run readme-screenshot`, the one-command way to refresh the board screenshot under `.github/assets/`.

Coarse-pointer controls keep a 44×44 CSS px minimum, including the meter button, Add draft, Help, and Done tools. Fine-pointer layouts keep their compact sizes. Check these controls at 320px and 375px in both themes. Exercise adjacent actions to check for overlap.

### Screenshot proofs for UI cards

A UI change needs a picture of the new surface. `bun run dev` serves the demo board on port 5747 and touches no real board. Each start seeds its own fresh scratch root under `.dev/` (unless `OTTR_DEV_ROOT` pins it), so two boards in one checkout never share a seeded database.

Workers also provide pinned `agent-browser@0.41.1` for shell proofs when MCP is locked.
Chrome-devtools MCP remains primary.
Read the [worker browser workflow](WORKERS.md#browser-cli-in-workers) before first use.
Its direct screenshot command follows the same PNG signature and proof rules below.

1. Create the shots folder and start the demo board from inside the shot script — never as a named background service held across tool calls (registered boards die between calls and the proof phase burns restart loops). Bind every run to a fresh port number — never port 0: the board prints `http://127.0.0.1:${PORT}` straight from its env value, so with PORT=0 the printed URL and step 2's readiness poll name a port nobody bound — and give the run its own `mktemp -d` state directory and its own puppeteer profile (`--user-data-dir`), so parallel boards never collide. Keep `timeout` on the board command, but never trust it to free the port: `timeout` signals `bun run`, and the server child survives it, so `timeout N bun run dev` can outlive N with the board still holding its port — the standing no-kill rule stays intact:

   ```sh
   mkdir -p shots
   port=$(( 50000 + $$ % 10000 ))   # fresh port per run; keep out of 4700-4899, e2e-steer's range
   state=$(mktemp -d)               # own state directory per run
   PORT=$port OTTR_STATE_DIR="$state" timeout 900 bun run dev &
   ```

A shot harness stops its spawned board on every exit path through try/finally with the `stopChildren` pattern of `scripts/readme-screenshot.ts`; `timeout` alone leaves an orphan that holds the seed lock.

Never wait for a leftover board to expire, and never reuse a port while any board still holds it: with this step's fresh port and state directory a leftover board cannot block the run, so switch to a new port and start the new board at once — let the tracker expire the old one.

2. Wait for readiness by polling the port with a bounded loop, not a fixed sleep, and fail the script when the board never comes up:

   ```sh
   for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$port/" >/dev/null && break; sleep 0.5; done
   curl -fsS "http://127.0.0.1:$port/" || exit 1
   ```

3. Open the UI in a browser tab and drive it to the state you want to show.
4. Save each shot in one program step with puppeteer `page.screenshot({ path: 'shots/<name>.png' })`. Never move the image bytes through agent text.
5. Verify each file. The first eight bytes must print `89 50 4e 47 0d 0a 1a 0a`:

   ```sh
   for f in shots/*.png; do echo "$f: $(od -An -tx1 -N8 "$f")"; done
   ```

6. Pass the worktree-relative paths in `report_outcome`'s `shots` field, for example `shots/board.png`. The board rejects a path outside the worktree.

A UI work turn also runs the blind visual check on the finished shots before committing: a fresh subagent whose only input is the shots' file paths — never the diff, the code, `DESIGN.md` or the task text — reports what looks broken or off (layout, spacing, contrast, cut-off text, wrong state); fix what it finds or say in the report why the shot is correct as intended.

`/shots/` and `/*.png` sit in `.gitignore`, so the shots stay out of `git status` and never enter a commit.

The README board screenshot has its own one-command path: `bun run readme-screenshot` starts the demo board, opens the Lumen project in headless Chrome (1440x900, dark theme, `en-US` locale), waits out the entrance animations, and writes `.github/assets/screenshot.png`. Run it in the same work as a `src/ui` change that alters what the board shows; behaviour-only or off-screen changes need no new shot. The script finds Chrome in the puppeteer cache (`~/.cache/puppeteer`, then `/root/.cache/puppeteer` for a service `HOME`) or on `PATH` — `OTTR_SCREENSHOT_CHROME` names a binary directly — and adds no dependency: it drives Chrome over CDP with Bun's WebSocket client. Spec: `docs/specs/readme-screenshot.md`.

Card views have a one-command path too: `bun scripts/card-shot.ts --view card --pr 53`. The script plants a parked PR-mode card (`stage` merging, PR #53 open, never "done") and a normal done card into a fresh demo pool. It boots its own board on a free port and writes the requested views to `shots/`. The views are `card` (the PR card's drawer), `done` (the contrast card), and `board` (the Lumen project face); `--view` can repeat. The script writes its fixture rows with direct sqlite before the board boots, so no write touches a live board's database. It bounds every wait with a watchdog, verifies each PNG signature, and stops only the children it started. It calls `process.exit` once the artifacts verify, so it cannot hang after success. Use it instead of a throwaway shot script. Spec: `docs/specs/card-shot.md`.

