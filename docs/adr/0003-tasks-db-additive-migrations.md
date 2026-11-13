# 0003. tasks.db schema changes are additive

Date: 2026-11-05

## Status

accepted

Note: [ADR 0013](0013-postgresql-backend-and-async-stores.md) extends this design to PostgreSQL and async stores. This ADR stays accepted for SQLite.

## Context

Each project's state is one SQLite file, `.tasks/tasks.db` (bun:sqlite). Schema changes land in `ProjectStore.open` (`src/store.ts`): plain additions use `ALTER TABLE ADD COLUMN` plus a backfill for existing rows (e.g. `done_at`, `topic`, `fork_merge_approved`, and the transcript cost backfills in `backfillTurnCosts`/`backfillDoneContext`). Constraint changes have no additive form, so the table is rebuilt in one transaction: create `tasks_migrating` from the new DDL, `INSERT ... SELECT` by explicit column names, verify the row count, then swap — a failure leaves the old table untouched ("preparing migration" in `src/store.test.ts` is the reference fixture). `CREATE TABLE IF NOT EXISTS` never updates a live table, and `bun test` runs against fresh databases, so a missing migration is invisible to the gates and crashes the live board at runtime (AGENTS.md, hard stop 2). Tracker data is never dropped or destructively altered; that is a hard stop asking the user first (AGENTS.md, hard stop 2; docs/specs/review-conventions.md). When the learnings feature was removed (commit ee9f330), the retired `learnings` table stayed in the `CREATE TABLE` text so fresh and existing databases converge. The original decision date is not recorded in the repo.

## Decision

- Every schema change lands as additive migration code in `ProjectStore.open`: column add plus backfill.
- CHECK/enum changes rebuild the table in one transaction (`tasks_migrating` swap with a row-count verify).
- Tracker data is never dropped or destructively altered without user approval.
- The retired `learnings` table stays in the `CREATE TABLE` text so fresh and existing databases converge (docs/specs/review-conventions.md, commit ee9f330).

## Consequences

- A schema change without its migration passes the gates but crashes live boards, so both pieces (the `CREATE TABLE` text and the migration) ship in the same commit (AGENTS.md, hard stop 2).
- Every migration needs a backfill test against a pre-existing database (`src/store.test.ts` patterns, e.g. "preparing migration").
- A destructive change is a hard stop: it asks the user first (AGENTS.md, hard stop 2).
- A future change to this rule requires a new ADR that supersedes this one.
