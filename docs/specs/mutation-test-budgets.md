# Mutation test budgets

## Behavior

The mutation runner passes a 60-second Bun timeout to the dry run.
Real Git and SQLite fixtures that exceed Bun's five-second default use an explicit 60-second test budget.
This change covers the legacy fork checkpoint cases and the six integration tests from the failed full run.
Other tests retain their current budgets.

If an asynchronous application teardown hook has no explicit budget, give it a 60-second budget.
Keep existing explicit teardown budgets.

A timeout remains a failure.
Preserve the asserted behavior and property run counts.
Keep production behavior unchanged.
The registration fixture uses a unique host label and a fixture-local Git `insteadOf` rule, independent of TMPDIR.
The report fixture supplies `createdAt` and checks the review and merge identifiers.
The Git fixture checks ambient configuration separately from the explicit auth environment.

## Boundaries

Bun 1.4.5 ignores `[test].timeout` in `bunfig.toml`.
A two-file probe shows that `setDefaultTimeout` in a preload affects only the first file.
A `beforeEach` probe does not change the timeout of the current test.
Use the existing per-test timeout argument instead of a global workaround.

Give fresh test-parent directories traversal permission for the fixture UIDs.
Keep the liveness markers and per-project private directories protected.

Do not change the mutation thresholds, mutation targets, test selection, or property run counts.
Do not add retries.
Do not replace real Git and SQLite readers with stubs.

## Acceptance

1. Run `bun run check` from the worktree root as a foreground command.
2. Run `bun test` from the worktree root as a separate foreground command.
3. Save each complete log in `/tmp`.
4. Both commands must exit 0 after the last source edit.
5. Run the affected integration tests through their existing real fixtures.
6. Commit the change.
7. Confirm that the working tree is clean.

The operator waives the full mutation run for this work turn.
Do not run `bun run test:mutation`.
Do not claim a mutation score.

## Non-goals

- Change production deadlines or host I/O behavior.
- Change the global Bun timeout or add a test API wrapper.
- Change schemas, dependencies, UI behavior, or notification policy.
