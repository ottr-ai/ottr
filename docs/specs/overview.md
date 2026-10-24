# Overview page overhaul

Source of truth for the Overview rework. The grilling decisions are in the "Decisions" section. The chosen layout is the stacked console with the full triage list.

## Decisions (grilling, 2026-10-21)

1. The page puts triage first and health second.
2. Metrics: throughput, lead time, first-pass rate, failure rate, spend in range.
3. Each metric shows its value, a delta against the previous equal range, and a sparkline.
4. The task captures token and cost data per turn.
5. The per-project performance numbers show in one compact table.
6. Cost on the page: spend in range only.
7. Old turns get backfilled from the session transcripts that are still on disk.
8. The triage block lists the cards that need you and the project warnings.
9. The default range is `all`.
10. The live project table and the performance table stay two tables.
11. In range `all`, the delta is hidden. Other ranges compare with the previous equal range.
12. Layout: Option A, Stacked console. One column: triage list, KPI strip, live table, performance table.
13. Triage form: the full list, one row per card and per warning.

## Page order

1. Triage block.
   - Cards in `needs_you` and cards with an open ask, across all projects, oldest wait first. Each row: state mark, project tag, card title, wait time. A click opens the card.
   - Project warnings: no `AGENTS.md`, uncommitted changes, no git repo. One row per project and warning.
   - With nothing to list, the block shows one grey line "Nothing needs you." and no amber.
2. KPI strip with range buttons (`1h 24h 7d 30d 90d All`, default `All`).
3. Live project table: project, action required, stage counts, last activity, New task. Same content as today.
4. Performance table: one row per project, columns for the five metrics, inline bars.

The old stage-mix columns and the two bar panels go away.

## Metric definitions

All windows use `[since, now)`. The previous range is `[since - span, since)`.

| Metric | Definition |
|---|---|
| Throughput | Count of non-cancelled tasks whose latest `events` row `kind = 'stage'`, `to_value = 'done'` falls in the window. That event time is the task's done time. |
| Lead time | For those done cards: done time minus task `created_at`. Show median and p90 (nearest-rank). |
| First-pass rate | Share of those done cards with exactly one `work` turn and no `events` row `kind = 'state'`, `to_value = 'needs_you'`. Value is a fraction 0..1. |
| Failure rate | Finished turns in the window (`ended_at` in window) with (`error IS NOT NULL` and `error <> 'cancelled'`) or `exit_code <> 0`, divided by all finished turns in the window. Fraction 0..1. |
| Spend | Sum of `turns.cost` for turns with `ended_at` in the window. Turns with `cost IS NULL` count as "no data" (`missing`), and the tile says how many. |

Sparkline buckets: `1h` 12 x 5 min, `24h` 24 x 1 h, `7d` 7 x 1 d, `30d` 30 x 1 d, `90d` 13 x 7 d, `all` 7 d each from the first task `created_at` (30 d each when that gives more than 52 buckets; one bucket when there are no tasks). Buckets end at `now`, and the window span is the bucket count times the bucket size (so `90d` covers 91 days). Series values per bucket: throughput count, lead median, first-pass fraction, failure fraction, spend sum. A bucket without input is `null`, except throughput and spend, which are `0`.

## Cost capture

- Schema: add nullable columns to `turns`: `tokens_in`, `tokens_out`, `cache_read`, `cache_write` (INTEGER), `cost` (REAL). Additive, with the column-backfill pattern in `ProjectStore.open`. Add them to the `CREATE TABLE` text too.
- Source: the omp session transcript of the task's current `session_id` plus its subagent files (the `readTranscript` shape in `src/supervisor.ts`). `src/retro.ts` already parses `usage` per assistant message.
- A session spans several turns. The turn owns only the assistant messages whose record `timestamp` is in `[started_at, ended_at]`.
- Ownership check: the current session transcript must hold at least one record stamped inside the turn window. A turn of an older, replaced session finds none and stays `NULL`.
- Valid source check: every non-blank line of the session and subagent files must be a JSON object, and every subagent source must be readable. A malformed record, an unreadable subagent file, or a subagent folder path that exists but cannot be listed keeps the columns `NULL`, so a later read can fill them. Only a subagent folder that does not exist means "no subagents".
- Fill at turn end. A missing, unreadable or malformed transcript leaves the columns `NULL`. It never fails the turn. An owned window without usage writes zeros.
- Backfill: once per store open, for finished turns with `cost IS NULL` that pass both checks. Other turns stay `NULL` until a later open.

## API

`GET /api/performance?range=<PerfRange>` returns:

```ts
interface PerfStat { value: number | null; prev: number | null; series: (number | null)[] }
interface PerfMetrics {
  throughput: PerfStat; leadMedianMs: PerfStat; leadP90Ms: PerfStat;
  firstPass: PerfStat; failure: PerfStat; spend: PerfStat;
  done: number; firstPassDone: number; turns: number; failedTurns: number; costMissing: number;
}
interface PerfResponse {
  range: PerfRange; bucketMs: number; seriesStart: number;
  fleet: PerfMetrics; projects: (PerfMetrics & { name: string })[];
}
```

`prev` is `null` for range `all`. `value` is `null` when the metric has no input (for example, lead time with zero done cards). `fleet` is computed over the union of all project facts, not averaged from project values. The counts (`done`, `turns`, ...) belong to the current window.

## Errors and edge cases

- Unknown `range` returns 400, as today.
- A missing `range` means `all`.
- Rates with a zero denominator are `null` and render as "–".

## Accessibility

- Deltas carry an arrow shape and signed text. Colour never carries the direction.
- Each sparkline is `aria-hidden`. The tile text carries the value, delta and range.
- Tables keep `scope` headers. Triage rows are links.

## Non-goals

- Tokens, cost per card, cache share, spend by model on the page (data is captured, not shown).
- Time waiting on you as a metric.
- Stalled-card detection and quota warnings in the triage block.
- Live auto-refresh of the performance data.

## Acceptance checks

- `bun run check` and `bun test` exit 0.
- Unit tests of the pure metric function cover each metric definition, the previous-window delta, `all` without `prev`, and the bucket counts.
- A store test covers the turn cost fill from a transcript fixture, the timestamp window across two turns of one session, and the backfill of an old turn.
- A migration test opens a database without the new columns and gets them.
- The rendered Overview matches the picked mockup option in a screenshot.
