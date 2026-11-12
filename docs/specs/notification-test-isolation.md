# Notification test isolation and demo reseed

## Behavior

The notification fixture controls each scheduled publish. Real HTTP routes remain in use.
A comment wave sends one Request alert. A drawer acknowledgement clears the wave and retracts its alert.
The fixture checks the stored acknowledgement before the scheduled publish prunes its obsolete PR key.
A quiet project creates no PR occurrence and sends no PR alert.

Demo reseed preserves all project data shapes, task identifiers, lifecycle events, and administrator credentials.
A forced reseed replaces the demo pool and removes stale demo projects, as before.
Measure the reseed path before a performance change. Fix unnecessary work or contention before a timeout change.
Retain the existing test timeout unless measurements prove that correct reseed work exceeds it under full-suite load.

## Boundaries and errors

Timer control applies only to the notification fixture and restores real timers after each test.
Production notification code stays unchanged unless a deterministic reproduction proves a production defect.
Demo changes retain database durability and propagate write errors.
The repair must not leave a project with partially committed seed rows after a write error.

## Acceptance checks

- Reproduce both reported notification failures with explicit publisher order before the fixture repair.
- Preserve all notification assertions and test the queued acknowledgement prune and quiet-project publish.
- Measure demo reseed before and after its repair.
- Run the focused tests and `bun run check` after the final edit.
- Run two complete `bun test` commands. Both commands must exit zero.
- Capture complete stdout and stderr in separate log files.
- Create two commits, one for each issue. Skip mutation gates in this work turn.

## Non-goals

No touch-target, visible UI, schema, dependency, or credential changes.
No weaker assertions, disabled tests, arbitrary sleeps, or lower thresholds.
No merge, push, tag, or release.
