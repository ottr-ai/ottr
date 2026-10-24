# Mutation testing: Stryker's command runner, tsconfig rewrite off for TypeScript 7 (2026-09-25)

**Decision:** StrykerJS 10.0.0 with its built-in command runner (`bun test` per mutant,
`coverageAnalysis: "off"`), and `tsconfigFile` pointed at a missing file.

**Why:**

- **Limit found by running into it:** Stryker 10.0.0 crashed before the dry run with
  `TypeError: ts.parseConfigFileTextToJson is not a function`
  (`TSConfigPreprocessor.rewriteTSConfigFile`). The JS module of `typescript@7.0.2` exports
  only `version` and `versionMajorMinor`. The rewrite only fixes `extends`/`references`/`include`
  paths that leave the sandbox; our `tsconfig.json` has none, so skipping it is safe. Any
  project on TypeScript 7.0.2 will hit the same crash.
- **Command runner is fast enough:** 1424 mutants in 7 files, full run 32 s on 23 workers
  (24 logical cores); the whole suite's dry run takes 264 ms.
- **First score, 38.69% (break threshold 38):** scheduler 88.61, images 83.74, types 60.00,
  runner 57.71, worktree 11.90, store 0, extension 0.
- **Files without tests stay in `mutate`:** store.ts (241 mutants) and extension/tracker.ts (46) cost
  about a fifth of the run and all survive. But `bun test --coverage` lists only files a test loads, so
  no other report shows them, and their survivors are what make a change there come with tests.

**Losing options (don't re-explore without a reason):**

- `@hughescr/stryker-bun-runner` 1.4.0 (supports core ^9 and ^10, published 2026-09-15): **tried
  2026-09-25, fails on Windows.** Its dry run dies with "Failed to get inspector URL": the generated
  preload script imports a Windows path whose backslashes became escape sequences
  (`'C:workspaceomp-task-tracker\node_modules…'`). Retry when a release fixes that.
  `stryker-mutator-bun-runner` 0.4.0 (core ^9 only, last published 2025-07-07): not tried.
- `inPlace: true` also skips the tsconfig rewrite, but it mutates the working tree, and a
  crashed run leaves instrumented code behind.

**Files:** `stryker.config.mjs`, `package.json` (`test:mutation`), `.gitignore` (`.stryker-tmp/`).

## Update, same day: git-backed tests get their own run

**Decision:** `bun run test:mutation` runs Stryker twice. `stryker.config.mjs` mutates everything
but `src/worktree.ts` and skips `src/worktree.test.ts`; `stryker.worktree.config.mjs` mutates only
`src/worktree.ts` with that test file and `timeoutMS: 60000`. Both sandboxes live in
`%TEMP%/ott-stryker`, outside any repo.

**Why:**

- **Measured:** the new `worktree.test.ts` cases drive throwaway git repos: `bun test` went from
  0.2 s to 3.9 s alone, 5.7 s with 8 in parallel and 10.1 s with 23, which is above Stryker's
  default timeout (~11 s at that dry run). One run with the whole suite per mutant never
  finished: after ~6 minutes every worker had hung on a timed-out Windows process and nothing
  moved for 19 more minutes. Split: 29 s for the 1071 other mutants plus 4 min 7 s for the 410 in
  `worktree.ts`, 0 timeouts.
- **No `--bail`:** it cut the `worktree.ts` run to ~3 min, but Bun then exits before `afterAll`
  (and before `process.on("exit")` handlers), so every killed mutant left its fixture repo in
  `%TEMP%`: 425 after three runs.
- **Incident, fixed:** one mutant replaced `git()`'s spawn options with `{}`, dropping `cwd`. The
  test fixtures used that same `git()`, so their `commit`, `push -u`, `checkout -b` and
  `update-ref` ran in the Stryker sandbox, which then sat inside this repo: they added two empty
  commits to `main`, branches `solo`/`task`, and a remote `origin` pointing at a temp dir. All were
  undone by hand (main back to `edfeaba`). Fixes: fixtures spawn git themselves, never through the
  code under test; the sandbox is outside any repo, so a lost `cwd` fails instead of finding one.
- **Scores:** 47.53% without `worktree.ts` (break 47), `worktree.ts` 36.43% (was 11.90%; break 36).
- `windowsHide: true` in `git()` carries a `Stryker disable` comment: its mutant is invisible to
  tests and would flash a console window per git call during a run.

**Losing option:** keeping one run and only raising `timeoutMS` (~11 min at 2.3 suite runs/s).
