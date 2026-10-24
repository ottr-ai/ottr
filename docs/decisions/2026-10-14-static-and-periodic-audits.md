# Static and periodic audits (2026-10-14)

**Decision:** Ottr gets its static and periodic checks from installed tools and from pinned scanners
in GitHub Actions, not from a SonarQube server. Fast offline checks run in every turn and stop the
merge. Scanners that need the network or an image build run in CI on each push and once a week.
Checks that need judgment run in every review, and the review files each finding as a card.

The research card of 2026-10-13 (task 6f5e9acd) compared the tools. Its report stays on that card.
The owner decided the open points on 2026-10-14 (D1 to D6 below). Ottr and Alate go public soon, so
this record treats the repo as a public repo.

## What runs where

| When | Command or workflow | Checks | Stops a merge |
|---|---|---|---|
| Every turn, every review, CI | `bun run check` | tsc, Biome (recommended rules plus the rules below), boot smoke, license allowlist (`scripts/licenses.ts`) | Yes |
| Every `bun add` and `bun update` | `bunfig.toml` | A package version must be 7 or more days old (G21) | It stops the install |
| Each push to `main`, each pull request | `.github/workflows/ci.yml`, job `check` | `bun audit --audit-level=high`, `bun run check`, `bun test`, e2e | No. The supervisor files a card when it fails |
| Each push to `main`, each pull request | `.github/workflows/ci.yml`, job `scan` | gitleaks over the full history, zizmor over `.github` | No. The supervisor files a card when it fails |
| Each week, and by hand | `.github/workflows/audit.yml` | `bun audit` (new advisories for the same lockfile), Docker build checks and Trivy for the worker image, OWASP ZAP baseline scan of a throwaway board | No. GitHub sends a mail when it fails |
| Each week | `.github/dependabot.yml` | Version updates for `bun` and `github-actions`, 7-day cooldown | The supervisor files one card for each pull request |
| Every review | `docs/ARCH-REVIEWS.md`, recipe steps 3 and 4 | `bun audit`, `bun run audit:quality` (jscpd, knip), the complexity count, open GitHub alerts, the newest `Audit` run | The review files cards |

Biome rules at `error`: `noFloatingPromises`, `noMisusedPromises`, `noImportCycles`,
`noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters`. The cognitive complexity rule
(`noExcessiveCognitiveComplexity`, limit 15) stays at `info` (D3).

## Pins

Each tool is the newest release that was 7 or more days old on 2026-10-14. Each downloaded binary
has its SHA-256 in the workflow, and `sha256sum -c` checks it before the run. Each action has a
full commit SHA with its version as a comment.

| Item | Version (published) | Checked against |
|---|---|---|
| `actions/checkout` | v5.1.0, `fbc6f399…` | The tag v5 points to the same commit |
| `oven-sh/setup-bun` | v2.2.0, `0c5077e5…` | The tag v2 points to the same commit |
| gitleaks | 8.30.1 (2026-03-21) | The release checksums file and the GitHub asset digest |
| zizmor | 1.30.1 (2026-09-09) | The GitHub asset digest (immutable release). The release has no checksums file |
| Trivy | 0.75.0 (2026-10-01) | The release checksums file. GHSA-69fq-xp46-6x23 affects only 0.69.4 |
| ZAP image | 2.17.0 (2025-12-15), by digest | The registry digest. Later images are weekly pre-releases |
| knip, jscpd | 6.40.0 (2026-10-06), 5.4.0 (2026-09-30) | `bun.lock`. Their dependencies add no new license key |

A security fix younger than 7 days needs an exception: add the package to
`minimumReleaseAgeExcludes` in `bunfig.toml` for that one update, and name the advisory in the
commit.

## Owner decisions (2026-10-14)

1. D1: knip (ISC) and jscpd (MIT) are approved devDependencies.
2. D2: the review prompt runs the audit, license and scanner gates that each project's `AGENTS.md`
   names. It names no Bun command for all projects.
3. D3: no `biome-ignore` baseline. The complexity rule stays at `info`, and each review counts the
   findings and files a card for the worst function.
4. D4: Dependabot, and the supervisor owns its pull requests. Once an hour, the supervisor files
   one card for each new open Dependabot pull request (README, "How a task moves"). The card merges
   through the merge queue. A cancelled card skips that update.
5. D5: every action is pinned to a full commit SHA with its version as a comment. Enable
   Dependabot alerts (owner step 1).
6. D6: SCANOSS is open. Nothing sends code fingerprints until the owner allows it (section
   "Before the repo goes public").

## Choices in this change

- CodeQL replaces the planned Semgrep job. CodeQL default setup is free for a public repo, needs no
  workflow file, and has more depth.
- The review runs plain `knip`, not `knip --production`. knip 6.40.0 and 6.41.0 do not follow the
  imports of entries that `bun` scripts start in production mode, so that mode reports 46 false
  unused files.
- The image job has no `docker build --check` step. With `--check`, each violation gives a non-zero
  exit, and Trivy then does not run. The normal build shows the same checks as warnings.
- `ci.yml` has no `concurrency` group. A newer push cancels a pending run in the group, and the
  supervisor counts a cancelled run as a failed run.
- `omp-bump.yml` keeps its checkout credentials, because its last step pushes. An inline zizmor
  ignore records the reason.
- No OpenSSF Scorecard workflow. zizmor, the SHA pins and the owner steps cover the checks that need
  action.
- No `REUSE.toml` and no `THIRD-PARTY-NOTICES.md`. The repo holds no third-party code. The source
  repo does not distribute `node_modules` or the worker image.
- No SBOM until the image goes to a registry.

## Baseline (2026-10-14)

- gitleaks: 552 commits (main after the rebase, plus this change), no leaks. One test value (the
  RFC 6455 sample nonce in `src/app.test.ts`) is in `.gitleaksignore` by its fingerprint.
- zizmor: no findings.
- `bun audit --audit-level=high`: no findings in 291 packages. Three moderate advisories are in
  `qs`, a dev-only package.
- Licenses: all 9 keys are in the allowlist.
- Biome: no errors. 100 functions are over the complexity limit.
- jscpd: 2.71 % duplicate lines, measured on main after the rebase. The threshold is the same
  value, so any growth fails the report.
- knip: 6 findings for the next review. The 5 Stryker configs import `@stryker-mutator/api` and
  `@stryker-mutator/command-runner`, which `package.json` does not list. `readImage` and `markKind`
  are unused exports. `TaskMark` and `TurnView` are unused exported types.
- Not measured here, because this machine has no Docker: the image build checks, Trivy and ZAP.
  The first `Audit` run gives their baseline.

## Owner steps (GitHub settings)

1. Now: enable Dependabot alerts (Settings, the security section). For a Bun repo, the alerts see only
   the direct dependencies in `package.json`. `bun audit` covers the full lockfile.
2. After this change is on `main`: Settings, Actions, General: enable "Require actions to be pinned
   to a full-length commit SHA".
3. After this change is on `main`: start the `Audit` workflow by hand. File a card for each red job.
   After that triage, make the Docker checks and the ZAP rules fail the job (comments in
   `audit.yml` and `.zap/rules.tsv`).
4. When the repo is public:
   - Code scanning: CodeQL default setup for JavaScript/TypeScript and GitHub Actions.
   - Secret scanning with push protection.
   - Private vulnerability reporting. `SECURITY.md` tells reporters to use it.
   - Actions: require approval of fork pull request runs for all external contributors.
   - A ruleset on `main` that blocks force pushes and deletion. Do not require pull requests:
     the merge turns and `omp-bump.yml` push to `main`.

## Before the repo goes public

- Done: the gitleaks scan of the full history (above).
- Done: the tracked tree no longer names a private LAN address or a Windows user name. The git
  history keeps the old values, so the first public release is a fresh repository with one
  squashed commit, not this repository made public.
- Open (D6): SCANOSS finds code that somebody copied from open source projects. The CLI
  (`scanoss-py` 1.54.2, MIT) sends no source text. For each file it sends the MD5 hash, the size and
  the path, plus CRC32C snippet hashes with their line numbers. Without an API key, it sends them to
  `api.osskb.org`, which the Software Transparency Foundation in Madrid runs. `--obfuscate` replaces
  the paths with numbers. The terms do not say how long the service keeps the hashes. If you allow
  it, run it once, with `--obfuscate`, before the repo goes public.

## Deferred

| Item | Add it when |
|---|---|
| SBOM, Trivy license scan of the image | The image goes to a registry |
| OSV-Scanner | `bun audit` misses an advisory, or you want malicious-package records |
| Grype with KEV and EPSS | The image scan gives more findings than you can triage |
| oxlint type-aware rules | Biome's promise rules give false positives |
| hadolint | The Docker build checks miss a real Dockerfile problem |
| Betterleaks | gitleaks stops its security releases |
| knip in `bun run check` | knip reports no finding |
