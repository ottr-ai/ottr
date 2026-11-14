# Development

The commands are the same in bash and PowerShell:

```sh
bun run check          # tsc, biome, boot smoke, license allowlist, scratch-image guard, agent-data sync guard, UI-screenshot reminder
bun test
bun run test:mutation  # StrykerJS, five configs with break thresholds
bun run audit:quality  # duplicate and dead code
bun run dev            # UI-only demo board on port 5747
```

A mutation run stays inside the host CPU and the worker's free memory. Each config takes the concurrency from the CPU: half of `os.availableParallelism()`, at least 1, capped at the config's measured maximum. At run start the sizing also reads the cgroup v2 limit (`/sys/fs/cgroup/memory.max` and `memory.current`) and lowers the value to what the free memory allows: 400 MiB per slot with a 1 GiB reserve, never below 1 slot, so a run cannot push a shared worker into an OOM kill. With no cgroup limit (Windows, `memory.max` = `max`) the CPU rule decides alone, and `STRYKER_CONCURRENCY` overrides every rule when set. Each run logs one line with the chosen slot count, the free memory and the rule that decided. A worker runs one mutation run at a time: each run holds a host-global lock file (`tmpdir()/ott-stryker.lock`). A second run waits and logs that it waits. A run removes a lock whose holder died. Each checkout gets its own Stryker sandbox parent (`tmpdir()/ott-stryker-<hash of its root>`) and wipes it at run start, so a killed run's leftover sandbox can never reach another run. Each config keeps its own incremental cache (`reports/stryker-incremental-<config>.json`, gitignored): a rerun re-tests only the mutants whose code or covering tests changed, and the release delta gate passes `--force` so a release always measures fresh (ARCH-REVIEWS.md "Delta gate").

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

## PostgreSQL test infrastructure

Card C adds PostgreSQL test infrastructure only.
Ottr still uses SQLite for product state.
This service does not add a PostgreSQL product backend or a supported local backend setup.
See the [backend specification](specs/postgres-backend.md) and [ADR 0013](adr/0013-postgresql-backend-and-async-stores.md).
The README remains accurate for SQLite.

The specification selects PostgreSQL 18 as the minimum and test target major.
Compose and the CI `check` job use this exact image:

```text
docker.io/library/postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636
```

The digest comes from the [official Docker Hub tag API for `library/postgres:18.4`](https://hub.docker.com/v2/repositories/library/postgres/tags/18.4).
The tag API records its last push as 2026-08-06.
Card F must reuse this exact digest for its optional production service.
The production service does not exist on card C.

### Isolated service and operator action

The compose service `postgres-test` uses profile `pgtest` and the default compose network.
The server and workers reach it by its service name.
It publishes no host port.
PostgreSQL 18 stores its data under `/var/lib/postgresql`, which this service mounts as tmpfs.
Data does not survive a service recreation.

Trust authentication without a password is an explicit exception for this isolated, disposable test service.
Any container on the default network can access its test data.
Never put production data or credentials in this service.
Never use this configuration as a production example.
The checked-in test URL contains no password or secret.
Keep `OTTR_DATABASE_URL` out of workers and settings.
The two test variables are separate from production backend selection.

After merge, the operator must add `pgtest` to the existing `COMPOSE_PROFILES` list in the compose environment file.
Keep any profiles that the stack already needs.
Set both test variables in that file:

```dotenv
OTTR_TEST_PG_URL=postgres://postgres@postgres-test:5432/postgres
OTTR_REQUIRE_PG_TESTS=1
```

Recreate the stack so the server and workers receive both variables:

```sh
docker compose up -d --force-recreate
```

Do not use `127.0.0.1` for the test URL inside the compose stack.
Loopback refers to each container itself.
The CI job runs directly on `ubuntu-latest`, so it uses `127.0.0.1` and the ephemeral host port from `job.services.postgres-test.ports[5432]`.
The `bun test` step's environment passes both variables to the test processes and their children.
GitHub does not allow the `job` context in the job-level environment, so the step environment is the only valid place for the URL expression.
CI uses the same trust exception and tmpfs data.

### Per-file database fixture

Import `readPostgresTestConfig` and `createPostgresFixture` from `src/test/postgres.ts`.
Read the configuration once per test file.
Create one fixture in that file's `beforeAll` hook.
Await `fixture.close()` in its `afterAll` hook.
If the configuration is absent, use `test.skip` for that file's PostgreSQL tests.
Do not share one fixture across test files.

The helper creates a random database through the isolated service's `postgres` database.
It refuses a test URL whose normalized host, port, and database match the production URL.
It treats an omitted default port as port 5432.
The returned `sql` connection supports real queries against the file's database.
The returned `url` identifies only that database.

Register additional connections or store owners with `fixture.register(owner)`.
The owner must expose an async `close()` method.
The fixture closes these owners before it drops only its own database.
Pass `fixture.subprocessEnv()` as the environment for a real subprocess fixture.
It sets the normal `OTTR_DATABASE_URL` to the file's database URL.
This test-only subprocess use does not permit production URL propagation to workers.
Do not print either URL, credentials, or nested driver errors.

### Proof boundary

The fixture follows these rules:

- If `OTTR_TEST_PG_URL` is absent and `OTTR_REQUIRE_PG_TESTS=1`, the test fails.
- If both variables are absent, PostgreSQL tests skip with an explicit notice.
- If a test URL is present, the test must connect and execute a real query.
- If a URL is invalid or unreachable, the test fails with a safe error.

Card C's work-turn proof covers required-without-URL failure and optional-without-URL skip.
The live service is unavailable until merge and stack recreation.
Do not claim a live PostgreSQL pass from the work turn.
The compose and CI shape tests check configuration only.
Post-merge CI must prove the real connection and query test.
Card D must prove that same live test as its first action, before backend work.
