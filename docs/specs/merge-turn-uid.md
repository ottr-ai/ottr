# Merge turn project uid

## Behavior

A merge turn stays on the board host, as ADR 0002 requires. On Linux, a root board starts its merge agent with the project's `projectTurnUid` uid and gid. It never starts the merge agent as root after a preparation error.

The agent uses a fresh configuration view from the board's trusted home or its pinned layer. The board owns the view. The project uid cannot change its code-bearing files or directories. Merge agents never reuse a worker turn home or a project layer copy.

The project uid owns the merge agent's cache, scratch, and operational state. These writable paths do not supply configuration, plugins, extensions, skills, or Git configuration. The board retains its own uid for Git integration and push operations.

A non-root development board retains its current process identity. Worker and microVM routes keep their current behavior. Other local agent kinds keep their current behavior.

## Boundaries and errors

Reuse the existing uid and filesystem helpers. Prepare the workspace and project data before the spawn. Preserve layer leases until the child stops. Preserve the configured Git identity as values, not as a link to worker configuration. Preparation errors prevent the spawn, with the cause visible to the caller.

The root board reads package lists from its trusted list home. It installs merge tools and Python packages directly into the project's daemon-owned provision directory. The merge agent's PATH names that directory. It never copies a Python environment from the board home, because script paths can retain that private location.

The configuration source must come from the board's trusted home. Code-bearing links must not lead into worker-writable paths. Copy operational state into per-run writable paths when omp requires it. Never expose the private board store through a writable configuration directory.

A private daemon umask does not change the project's read and traverse access to the protected view or its overlays.

The root board must make the agent's scratch writable by the project uid. It must not grant that uid write access to the board's private home, store, or trusted package lists.

Per-run state copies live on server-local storage. They never enter worker-shared volumes. They exclude stored provider credentials.

The existing board auth broker supplies provider access and retains OAuth refresh state in the private board store. Merge agents use this broker through explicit connection settings. Per-run state never replaces the board's provider credentials.

Startup failure and board exit stop the service's own daemons, even before readiness.

The isolated merge child receives no inherited board GitHub token. The server retains push credentials. An explicitly granted read-only GitHub token can reach the child through the existing turn-read-token path.

The protected view excludes dotenv files. Provider env and the board auth broker supply model access. Home and configuration override variables cannot redirect discovery into worker-writable paths. An isolated merge parks every dotenv file that Bun can load from its worktree before omp starts: `.env`, `.env.local`, and the development, production, and test files with their `.local` variants. Bun chooses a mode from BUN_ENV or NODE_ENV, so the park does not depend on either variable. The run restores the files when it ends.

Root-only tests use their own uid and traversable fixture parents. Tests that require an unprivileged caller state that requirement with an explicit skip under root. No test removes a uid-isolation assertion to accept root access.

Git environment tests do not assume that the caller lacks `GIT_CONFIG_COUNT`. Retain the fixture repairs that origin/main already contains.

## Assumptions

- The board retains server-side integration and push authority.
- `projectTurnUid` defines one uid for all classic turns of a project.
- The root board can prepare its existing workspace and turn-home roots.
- A root runner can have a private `TMPDIR`. A child uid must reach each ancestor of its own test fixture.
- OTTR-1339 owns the general omp run-directory change. This task does not replace that work.
- A work turn can plant or change any file under its project's worker home and layer copies.
- The board's private home and pinned layers remain trusted configuration sources.
- GitHub push authority stays in the server, not in the merge agent.

## Acceptance checks

- A test drives the merge dispatch path and asserts that the spawn uses the project's nonzero uid and gid.
- A real child test reads its uid through the local runner when the host permits a uid drop.
- A failed identity preparation starts no agent.
- `bun test scripts/board-report.test.ts src/syncGate.test.ts src/tmpsweep.test.ts src/turnUid.test.ts src/workers.test.ts src/worktree.test.ts` exits 0.
- `bun run check` and the full `bun test` gate exit 0.
- A root-run check retains the cross-uid denial assertions and does not report the eight listed failures.
- Keep stored provider credentials and OAuth refresh state in the private board store. The per-run database contains no copied provider credential rows.
- A missing or failed auth broker prevents the isolated merge agent's start.
- Preserve model selection and provider coverage through the existing broker. Do not limit merges to the token-lending provider set.
- Plant Git configuration, omp extensions, plugins, and skills in both a worker home and an existing project layer copy. Neither plant reaches the merge configuration view.
- Start two merge runs in sequence. The second run does not reuse mutable state from the first run as configuration.
- Keep the configuration view and its code-bearing directories read-only for the project uid. Keep required operational state writable.
- Assert that inherited GitHub credentials do not reach the merge child, including through explicit env objects. Preserve the approved read-only token path.
- Plant every Bun dotenv name in the merge worktree. In every mode, the real child loads none of them, and the run restores all of them.
- The merge agent's PATH link directory stays readable and searchable for the project uid. This includes a directory that an older build created with mode `0700`.

## Non-goals

- No change to merge location, integration order, or push authority.
- No new dependency, schema, prompt wording, or visible UI.
- No weaker filesystem or uid-isolation checks.
- No change to other local agent kinds or the general omp run-directory design.

## Known limits

- A worktree `bunfig.toml` still loads in the merge agent and its gates. The agent runs the branch's own gates, and they need that file. The park limits configuration discovery. It does not limit the worktree code that the gates run.
