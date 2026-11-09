# 0010. The omp bump follows a changelog review

Date: 2026-11-09

## Status

accepted

## Context

ADR 0005 gave the omp pin to the scheduled workflow `.github/workflows/omp-bump.yml`. Every 6 hours, it moved `OMP_VERSION` in `Dockerfile.worker` to the newest omp that was 7 or more days old. Then it pushed the bump to main with a deploy key. The workflow checked only that the new omp starts on the image's bun. It did not check if the release changes the omp surface that Ottr uses. An omp update can thus break Ottr turns.

In OTTR-672, the user asked for no failing tasks after an omp update. The user set these points:

- A model reviews the changelog of each release.
- The review runs in the Ottr server.
- On a failed review, the server holds the pin and files a card.
- The server owns the bump.
- The 7-day release age gate stays.

The spec is `docs/specs/omp-watch.md`.

## Decision

- The Ottr server's omp watch owns the bump. It is the project setting `ompWatch` (default off). Turn it on only for the project that holds Ottr.
- Every hour, the watch reads the npm releases of omp above the pin. A model reads the GitHub release notes of each version and replies `PASS` or `FAIL`.
- A failed version gets a fail card `omp <version>: compatibility review failed`. The fail card holds the pin.
- A failed version blocks itself and every later version until its card is cleared. A card is cleared when it is done or cancelled, or when it no longer exists.
- The 7-day release age gate stays. Only a version that passed and is 7 or more days old can be the bump target.
- The bump goes through a normal card `Bump omp to <version>`. The merge turn of that card pushes `chore: bump omp to <version>`. No other path moves the pin.
- `.github/workflows/omp-bump.yml` becomes a check only. On a push to main that changes `Dockerfile.worker`, and on manual dispatch, it starts the pinned omp on the image's bun. It holds no deploy key and pushes nothing.
- This ADR supersedes ADR 0005. The omp-bump push is no longer an exception to ADR 0002: only the server's merge turn pushes to main.

## Consequences

- The pin moves only when `ompWatch` is on for the Ottr project. When the setting is off, the pin stays where it is.
- Each bump is a card, so it takes a merge slot like every other card.
- The review reads only the release notes. It runs no agent turn and no test against the new omp. A breaking change that the notes do not mention can still ship.
- A release without notes fails the review after one day, so a human must look at it.
- The Actions secret `OMP_BUMP_DEPLOY_KEY` and its write deploy key are unused. The user can remove them.
- A future change to this rule requires a new ADR that supersedes this one.
