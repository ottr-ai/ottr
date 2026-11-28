# Merge turn project uid

## Behavior

A merge turn stays on the board host, as ADR 0002 requires. On Linux, a root board starts its merge agent with the project's `projectTurnUid` uid and gid. It never starts the merge agent as root after a preparation error.

The agent uses the project's writable turn home, cache, scratch, and Git identity. The agent reads the shared agent layer, as a work turn does. The board's private home and store keep their access limits. The board retains its own uid for Git integration and push operations.

A non-root development board retains its current process identity. Worker and microVM routes keep their current behavior. Other local agent kinds keep their current behavior.

## Boundaries and errors

Reuse the existing uid and filesystem helpers. Prepare the workspace and project data before the spawn. Preserve layer leases until the child stops. Preserve the project's configured Git identity. Preparation errors prevent the spawn, with the cause visible to the caller.

The root board reads package lists from its trusted list home. It installs merge tools and Python packages directly into the project's daemon-owned provision directory. The merge agent's PATH names that directory. It never copies a Python environment from the board home, because script paths can retain that private location.

If the shared agent home equals the board's private home, then identity preparation refuses the merge. It never opens the private home to the project uid.

The root board must make the agent's scratch writable by the project uid. It must not grant that uid write access to the board's private home, store, or trusted package lists.

Root-only tests use their own uid and traversable fixture parents. Tests that require an unprivileged caller state that requirement with an explicit skip under root. No test removes a uid-isolation assertion to accept root access.

Git environment tests do not assume that the caller lacks `GIT_CONFIG_COUNT`. Retain the fixture repairs that origin/main already contains.

## Assumptions

- The board retains server-side integration and push authority.
- `projectTurnUid` defines one uid for all classic turns of a project.
- The root board can prepare its existing workspace and turn-home roots.
- A root runner can have a private `TMPDIR`. A child uid must reach each ancestor of its own test fixture.
- OTTR-1339 owns the general omp run-directory change. This task does not replace that work.

## Acceptance checks

- A test drives the merge dispatch path and asserts that the spawn uses the project's nonzero uid and gid.
- A real child test reads its uid through the local runner when the host permits a uid drop.
- A failed identity preparation starts no agent.
- `bun test scripts/board-report.test.ts src/syncGate.test.ts src/tmpsweep.test.ts src/turnUid.test.ts src/workers.test.ts src/worktree.test.ts` exits 0.
- `bun run check` and the full `bun test` gate exit 0.
- A root-run check retains the cross-uid denial assertions and does not report the eight listed failures.

## Non-goals

- No change to merge location, integration order, or push authority.
- No new dependency, schema, prompt wording, or visible UI.
- No weaker filesystem or uid-isolation checks.
- No change to other local agent kinds or the general omp run-directory design.
