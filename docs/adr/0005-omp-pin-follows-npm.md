# 0005. The omp pin follows npm automatically

Date: 2026-11-05

## Status

accepted

## Context

omp is the main tool of every turn and ships almost daily, so the image pin needs constant movement that no one should do by hand. The scheduled workflow `.github/workflows/omp-bump.yml` (cron every 6 hours, plus manual dispatch) moves `OMP_VERSION` in `Dockerfile.worker` to the newest omp release that is 7 or more days old: workers run about one week behind npm, so a broken or yanked release has a week to surface before it ships (workflow header comment; docs/WORKERS.md "Updates"). This job is the only place that moves `OMP_VERSION`. Before pushing it smoke-tests the new omp on the image's bun — catching an omp that needs a newer bun than the image's base — then pushes `chore: bump omp to <version>` to main over SSH with a deploy key, the only pushes outside the merge turn (workflow file; AGENTS.md "omp version"). Each host deploys main with `scripts/update-image.ts` and never pushes (docs/WORKERS.md "Updates"). Only omp has automation; every other pin in `Dockerfile.worker` is a hand bump (docs/WORKERS.md "Updates"; AGENTS.md "omp version": do not pin omp by hand; to stay on an older omp, disable the workflow first). The original decision date is not recorded in the repo.

## Decision

- No human moves `OMP_VERSION`; the scheduled omp-bump workflow owns it, tracking npm's newest release at least 7 days old (`.github/workflows/omp-bump.yml`).
- Holding back a version means disabling the workflow first, not pinning by hand (AGENTS.md "omp version"; docs/WORKERS.md "Updates").

## Consequences

- The image trails npm by about a week by design (workflow header comment).
- A bump ships only after the image's bun can start the new omp (workflow smoke-test step).
- Every other tool pin is a hand bump and out of this ADR's scope (docs/WORKERS.md "Updates").
- A future change to this rule requires a new ADR that supersedes this one.
