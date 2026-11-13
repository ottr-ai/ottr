# 0013. PostgreSQL backend and async stores

Date: 2026-11-11

## Status

accepted

This ADR accepts the design, not an implemented PostgreSQL backend. Six later cards will implement [the specification](../specs/postgres-backend.md).

## Context

SQLite remains the default database for Ottr. Compose and hosted deployments also need an experimental PostgreSQL option without a second set of store behavior.

The current synchronous store API cannot directly serve PostgreSQL. An async API also introduces race risks where callers read state and then write a result.

[ADR 0003](0003-tasks-db-additive-migrations.md) protects existing SQLite data through additive schema convergence. PostgreSQL needs its own migration history without a change to that SQLite policy.

The design assumes one Ottr server per database. It does not introduce multi-server operation or a stable external SQL contract.

## Decision

- Use built-in `Bun.SQL` for both SQLite and PostgreSQL. Add no npm dependency. Keep one shared set of store methods and SQL, with small dialect helpers.
- Make every `GlobalStore` and `ProjectStore` method async. Update every caller to await its result. Preserve existing observable behavior.
- Move each synchronous caller read-then-write group into one store operation and one transaction. Serialize transactions through a queue in each store.
- Keep external filesystem, network, and process effects outside the database atomicity claim. Preserve guards when a caller applies an external result.
- Select SQLite when `OTTR_DATABASE_URL` is absent or empty. Select PostgreSQL for `postgres://` or `postgresql://`. Refuse other schemes at startup.
- Use one PostgreSQL database per Ottr server or tenant. Use `ottr_global` for global state and the project registry. Give each project its own schema.
- Keep the current project folder name as project identity. Derive its schema name with the bounded hash rule in the specification. Refuse registry conflicts.
- Preserve the SQLite table, column, and CHECK constraint contract, except for the retired `learnings` table. Keep JSON as text and booleans as 0/1.
- Use identity columns instead of `AUTOINCREMENT`. Replace the `listTasks` rowid tie-breaker with an explicit portable order that preserves observable order.
- Use numbered PostgreSQL migrations with a version record in each schema. Apply each missing step in a transaction when the schema opens.
- Keep SQLite additive convergence unchanged, including the retired `learnings` table. Each later schema change needs SQLite convergence and a numbered PostgreSQL step.
- Compare table and column sets across backends in a shared test. Exclude only backend metadata and the retired `learnings` table.
- Reserve one dedicated PostgreSQL connection for a database-wide session advisory lock with a fixed key. Hold the lock for the server lifetime.
- Refuse a second server with a nonzero exit. Require a direct connection. Do not support a transaction-mode pooler or resume state writes without proven lock ownership.
- Fail startup immediately when PostgreSQL is unreachable. At runtime, permit bounded whole-transaction retries only where the specification proves replay safe.
- Do not replay an autocommit write or a sent `COMMIT` after a lost reply. Treat its outcome as unknown, report a safe cause, and exit nonzero.
- Keep the database URL and credentials in the environment only. Never save them in stores or expose them through logs, errors, the API, or turn environments.
- Apply the same child-environment safeguards to local server-run turns and worker services. Use TLS settings from the URL without an insecure override.
- Preserve [ADR 0011](0011-sealed-token-fields-encrypted-volumes.md), including field sealing and encrypted-volume advice. Preserve `OTTR_SECRET_KEY` precedence and the `.tasks/secret.key` fallback. This ADR makes no claim about a released sealing implementation.
- Provide a one-way import tool for a stopped server. Copy global state and all projects in one PostgreSQL transaction. Preserve source files and refuse an existing target global schema.
- Refuse an empty PostgreSQL target when live SQLite files exist, unless the operator explicitly sets `OTTR_PG_ALLOW_EMPTY=1`. Do not switch backends at runtime.
- Keep PostgreSQL backup under operator control with `pg_dump`. Skip the SQLite snapshot scheduler with one boot log. Refuse the SQLite restore CLI on PostgreSQL.

## Consequences

The async API changes every store caller. Transaction extraction must preserve state guards, not merely add `await` to existing call sequences.

One shared implementation limits backend drift. Small dialect helpers still need real-driver tests, and both migration paths must evolve together.

A reserved-session lock preserves single-server ownership without a heartbeat lease. Connection loss requires explicit lock recovery before state writes can resume.

PostgreSQL remains experimental for compose and hosted deployments. PostgreSQL 18 is the minimum and tested major in this design. Local checkout use remains unsupported.

Operators own PostgreSQL backups, direct connections, credentials, and TLS configuration. Database credentials must never reach a turn, even when the server runs that turn locally.

Task logs, sessions, images, and handoffs remain files. PostgreSQL does not replace the state volume or the sealing key backup requirement.

The six implementation cards cover async stores, the SQLite driver, PostgreSQL test infrastructure, the PostgreSQL backend, import, and deployment documentation. None ships in this ADR.

Rejected alternatives keep the design boundary clear:

- A SQLite mirror or an in-memory copy with deferred writes adds two state authorities and recovery rules.
- A synchronous worker bridge hides async I/O behind a second execution model.
- Shared project tables with a project key require pervasive project filters. A database per project adds unnecessary database administration.
- Separate full store implementations duplicate behavior. A thin layer that retains `bun:sqlite` keeps two driver models.
- npm PostgreSQL drivers add a dependency where built-in `Bun.SQL` serves the chosen design.
- Ottr-managed `pg_dump` adds backup orchestration outside this scope. A heartbeat lease adds expiry races instead of session ownership.

The specification defines failure boundaries, retry limits, import checks, and acceptance evidence. [ADR 0003](0003-tasks-db-additive-migrations.md) remains accepted for SQLite.
