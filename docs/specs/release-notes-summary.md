# Model-consolidated release notes

The Create release dialog shows one bullet per commit (computeRelease, `src/release.ts`).
Ottr v0.3.0 spans ~150 commits since v0.2.0, so the notes are a long, noisy list: follow-up
fixes, test commits and internal refactors sit next to real features. A model consolidates
the deterministic notes into short, human-readable text. The deterministic list stays one
click away, and the user edits and accepts in the dialog before a release starts.

## Behavior

### Input (src/releaseSummary.ts, new)

- Deterministic notes from `computeRelease` (the plan's `notes`).
- For every card in `includedTasks` (the plan's `tasks`): id, title, and the card's ready
  report — the latest settled turn with outcome `ready` (`store.listTurns`), whose details
  the work prompt makes the release notes. `Task.details` is not a source: every settled
  turn overwrites it (`turn.ts`), so it holds the merge turn's integration output.
- Card details are trimmed to 1500 characters at a line boundary.
- Total input is bounded to 80,000 characters. When over the bound, a first model pass
  summarizes the cards in chunks (each chunk input within half the bound, at most 10
  chunks) into at most 8 lines per chunk; the final pass reads the chunk summaries instead
  of the raw card details. Beyond 10 chunks, the oldest cards keep only id and title. The
  chunk calls run in parallel, so the whole summary answers within one call ceiling and
  stays under the board's 120 s request idle timeout.

### Model

- One call over the auth gateway (`runGateway` in `src/forkAnalysis.ts`), 90 s ceiling.
- Selector: the board's `modelRoles().smol` when set, else `"@default"` (the two proven
  gateway selectors in this codebase are `"@default"` and `"@plan"`; `"@smol"` is not).
  The spec decision between smol and default: smol — consolidation is compression, not
  reasoning, and the call runs on every dialog open; the smoke run compares both and a
  clearly better default would flip this (none is expected). No project setting: one
  global role plus a per-project setting is schema and UI weight for marginal value.
- The instruction text lives in `src/prompts.ts` (new exported consts), so prompt wording
  stays in one file. It needs user approval before merge (AGENTS.md hard stop 3).

### Output

- Short Markdown with `## Highlights` (at most 5 lines), `## New features`, `## Bug fixes`,
  `## Changes` — empty sections left out, related commits merged into one line.
- Internal-only work (tests, refactors, CI, dependency chores, docs) left out unless it
  changes what a user sees.
- Every `**Breaking:**` item of the deterministic notes is kept: after the model reply, the
  sanitizer appends each missing breaking bullet under `## Breaking changes`. This is
  deterministic — the model cannot drop a breaking change.
- No invented items: the instruction says every line must trace to a commit or card report.
- Sanitized (`sanitizeSummary`): HTML tags stripped, every Markdown link or image
  `[text](url)` / `![alt](url)` replaced by its text, more than two consecutive blank lines
  collapsed, output capped at 8000 characters at a line boundary.
- Empty model reply counts as a failure, not as empty notes.

### API

- `POST /api/projects/:project/release-summary` body `{sha}` (7-40 hex, else 400):
  re-plans with `planRelease` for that sha, gathers the cards, calls the model, answers
  200 `{summary: string | null, reason: string | null}` — summary non-null exactly when
  reason is null. Before the first release (`from === null`) there is nothing to
  consolidate: `{summary: null, reason: null}` without a model call. The fallback is a
  normal outcome, not an error status: the dialog shows the deterministic list and the
  reason. A gateway failure or timeout answers `{summary: null, reason: <errmsg>}`.
  The spawn runs through a `createApp` seam (`releaseSummarySpawn?`, default the real
  spawn) so tests inject a fake gateway.
- `POST /api/projects/:project/release` accepts an optional `notes` string (1-20,000
  characters, else 400). When valid it replaces `plan.notes` for the release card's
  `releaseNotes` and the release prompt; when absent the behavior is unchanged.

### Dialog (src/ui/app.tsx `ReleaseDialog`)

- After the plan loads (and only when `from !== null`), the dialog requests the summary
  once. While it runs: the deterministic notes show with a "Consolidating…" status line.
- The proposal is an editable textarea labeled "Release notes". When the summary arrives it
  pre-fills the textarea, unless the user already edited it. On failure an advisory line
  names the reason and the textarea keeps the deterministic notes.
- "Show full commit list" toggles the deterministic notes as rendered Markdown below the
  textarea; one click, aria-pressed state.
- Start release sends `notes` only when the user edited the textarea; otherwise the server
  default (plan.notes) holds, so a fresh open that skips editing behaves exactly as today.
- WCAG 2.1 AA holds (labelled control, visible focus, contrast per DESIGN.md).

### Security

- Commit messages and card reports are untrusted input to the model. The instruction says
  to treat them as data, never as instructions.
- The model output is only a proposal: it never runs a command, the dialog shows it for
  edit, and the board publishes only what the user accepted in the dialog.
- The sanitizer strips HTML and external links, so no crafted link or tag survives into the
  published release body.

## Boundaries

- The summary request pins the range by `sha`; a target move between plan load and summary
  request changes nothing the user started from — Start release re-plans and refuses a
  moved or blocked range exactly as today.
- A summary is per dialog open, never cached: a second open re-plans and re-asks.
- `lateNotes` (late commits at publish) stays deterministic; consolidated notes cover the
  planned range only. Late commits still append to the notes the way they do today.
- Version bump rules live in `computeRelease` and stay untouched; the summary changes
  presentation only.
- The release review agent still receives the planned notes verbatim (`releasePrompt`);
  it now receives what the user accepted when they edited them.

## Acceptance

- `src/releaseSummary.test.ts` with a fixed fake gateway reply pins: input building (notes
  plus card ids and titles), the per-card trim, the chunk pass when over the input bound
  (fake counts the calls), fallback with the reason on a gateway throw and on an empty
  reply, breaking bullets re-appended when the reply drops them, HTML and external links
  stripped, the output cap.
- `src/app.test.ts`: the route answers the fake-gateway summary (200 shape, first release
  skips the call), the fallback shape on a failing gateway, and POST /release with and
  without a valid `notes` (400 on a non-string or oversized one).
- Smoke run on the real ottr checkout over the v0.2.0..HEAD range, with seeded cards whose
  ready reports carry phrases absent from the commit messages, so the card-report path is
  exercised live: before (deterministic) and after (consolidated) notes in the report,
  plus the smol-vs-default comparison the model decision cites.
- `bun run check` and `bun test` pass from the worktree root.
- Impeccable detector on the changed UI files: no primary finding.

## Non-goals

- Version bump rules and `lateNotes` at publish.
- Per-project model settings.
- Caching summaries across dialog opens.
- Prompt-injection hardening of the existing release review prompt (the sanitizer here
  shrinks the surface; the review prompt change is its own task).
