# PostgreSQL backend and async stores

## Status and source baseline

This specification defines an experimental PostgreSQL backend for compose and hosted mode. SQLite remains the default backend. PostgreSQL support does not ship with this specification card.

OTTR-805 changes documents only. Product source code stays unchanged on this card. The README continues to describe the shipped SQLite backend until delivery card F.

[ADR 0013](../adr/0013-postgresql-backend-and-async-stores.md) records the design decision. ADR 0003 retains its accepted SQLite policy.

The source inventory uses revision `38b6504e42c960b45bb2897a174b98e53a0c5cae`. Paths and lines below refer to that revision. Each implementation card must refresh the relevant inventory before it changes code. A line reference is evidence of current behavior, not a permanent interface.

## Behavior and boundaries

- Support SQLite and PostgreSQL through the built-in `Bun.SQL` driver.
- Keep one shared implementation of store SQL and store methods.
- Limit backend differences to small dialect, connection, migration, lock, and lifecycle helpers.
- Make all `GlobalStore` and `ProjectStore` methods async. Await every caller, including startup, shutdown, backup, tests, and subprocess fixtures.
- Preserve task, turn, event, settings, watcher, quota, and review behavior.
- Extract each current synchronous caller read/write group into one store operation with one transaction.
- Serialize transactions through a queue for each store.
- Keep task logs, sessions, images, and handoff files on the filesystem.
- Do not permit a runtime backend change.
- Do not claim support for multiple servers against one tenant database.
- Do not expose a stable external SQL interface.
- Add no destructive production operation. Keep project schemas and source SQLite data.
- Do not rewrite the wording of `src/prompts.ts`.
- Ask before any new npm dependency or destructive schema operation.

Database transactions cover database work only. They do not make Git, filesystem, process, model, or network effects atomic. Preserve the guards that connect an external result to its source database state.

### Backend selection

| `OTTR_DATABASE_URL` | Result |
| --- | --- |
| Absent or empty | Open the existing SQLite files. |
| `postgres://` or `postgresql://` URL | Open PostgreSQL. |
| Any other scheme or an invalid URL | Refuse startup with a safe error and a nonzero exit. |

SQLite keeps its current live paths, file format, lock behavior, PRAGMAs, convergence rules, snapshots, and restore flow. `GlobalStore.open` currently uses `.tasks/tracker.db`. `ProjectStore.open` resolves the project `tasks.db` through the existing data-root rules.

The backend selection applies to tracker state, not every SQLite file used by Ottr. The exclusions below remain SQLite-specific.

## Configuration and secret boundary

`OTTR_DATABASE_URL` comes from the server environment only. Do not store it in configuration rows, project settings, task data, API responses, or checked-in files.

The production URL must not enter worker environments or turn environments. Apply the same filter to local server-run turns and worker services. A server environment may contain the URL because the server owns the database connection.

Never print the full URL, user, password, query string, or credentials. Sanitize driver errors and nested causes before any log or error response. Test URL parsing errors and connection errors for the same boundary.

The boot line identifies the backend and safe host/database fields only. Treat those fields as untrusted log data. Never interpolate raw URL components without safe parsing and log encoding.

Use the URL TLS settings. Do not add an insecure TLS override. ADR 0011 field sealing and key policy remain in force.

The only public environment additions in this design are:

- `OTTR_DATABASE_URL`: server backend selection and import target.
- `OTTR_PG_ALLOW_EMPTY=1`: explicit acceptance of an empty PostgreSQL backend despite live SQLite files.
- `OTTR_TEST_PG_URL`: isolated test service URL.
- `OTTR_REQUIRE_PG_TESTS`: required PostgreSQL test mode.

Do not introduce another public backend option, retry environment variable, or driver dependency. Test service URL propagation is separate from production URL filtering.

No credentials belong in source code. Production compose uses required environment substitution for its password. This rule prevents source history and child processes from exposing database access.

## PostgreSQL database layout

Use one PostgreSQL database for each Ottr server or tenant. Do not create one database for each project.

The global schema is `ottr_global`. It contains:

- The existing `kv` table, with unchanged key/value text behavior.
- A project registry that maps the exact project folder name to its schema name.
- The global migration version record.

Each project gets one schema. Its identity remains the current folder name, not a display title, repository URL, or numeric identifier.

### Project schema names

Construct the schema name as follows:

1. Preserve the exact folder name for the registry key and hash input.
2. Convert the folder name to lower case.
3. Replace each character outside `[a-z0-9_]` with `_`.
4. Truncate this ASCII stem to at most 48 bytes.
5. Prefix the stem with `p_`.
6. Append `_` and the first 12 lower-case hexadecimal SHA-256 characters of the exact folder name.

The result has at most 63 ASCII bytes. The fixed prefix and suffix occupy 15 bytes. Hash the exact original name, including its case and Unicode bytes.

Quote and validate generated SQL identifiers. Bind values separately. Do not derive a SQL identifier from a raw URL, request field, or unvalidated folder name.

Register the folder/schema pair atomically with schema creation. If a schema name belongs to a different original folder, refuse the open. Do not adopt the existing schema or silently choose another name.

For startup and import, “Ottr schema exists” means that `ottr_global` exists. Unrelated target objects do not satisfy that condition.

## Schema contract

The fresh, fully converged SQLite database from the same source revision defines the application table and column sets. `SCHEMA` alone is not the full schema because `ProjectStore.open` adds columns.

Preserve existing names, primary keys, unique keys, defaults, nullability, CHECK value sets, and index behavior. Do not add native PostgreSQL booleans, JSONB, timestamp columns, or foreign-key behavior as part of this work.

### Exact type mapping

| Current SQLite representation | PostgreSQL representation and rule |
| --- | --- |
| `TEXT` | `text`, with the same content, nullability, and defaults. |
| `INTEGER` | Signed 64-bit `bigint`, including milliseconds, counters, revisions, IDs, offsets, and flags. Do not narrow to 32-bit integers. |
| `REAL` | `double precision`, not PostgreSQL `real`. Preserve SQLite double-precision cost semantics. |
| JSON in `TEXT` | Keep text serialization and the existing JSON decode behavior. Do not normalize or recode it as JSONB. |
| Boolean-like integer | Keep numeric `0`/`1` representation and current constraints. Do not return native boolean values to current row mappers. |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint` identity primary key, with explicit-ID import support and a next value above the imported maximum. |

Preserve exact integer values through driver binding, import, and result decoding. Do not coerce a 64-bit value through a lossy JavaScript number conversion. Preserve existing public number behavior for values within its supported exact range. Test millisecond values above the 32-bit range and integer boundaries at the adapter boundary.

### Table and column inventory

The source baseline defines the schema through these authoritative declarations and convergence paths. Do not maintain a second DDL inventory in this specification.

| Schema source | Authoritative range at the source baseline |
| --- | --- |
| Global `kv` declarations | `src/globalStore.ts:16-29` |
| Project base tables, columns, keys, defaults, CHECK constraints, and indexes | `src/store.ts:104-281` |
| Additional `tasks` columns from convergence | `src/store.ts:1548-1902,1984-2091` |
| Convergence for existing `turns`, `fork_branch`, and `pr_review` columns | `src/store.ts:1903-1974,2093-2169` |

Preserve every declaration through the type mapping above, including `turns.cost` precision. Do not invent CHECK constraints for numeric flags or `tasks.kind`.

The retired `learnings` table stays in SQLite convergence. PostgreSQL does not create or copy it. This is an explicit exception, not permission to omit another application table.

The required registry, migration records, and insertion ordinal are future additions, not source baseline facts. Only the named backend metadata and `learnings` qualify as comparison exceptions.

### Persistent insertion order

`listTasks` currently uses `ORDER BY created_at DESC, rowid DESC` (`src/store.ts:3205-3211`). Lexical task-ID order is not equivalent.

Add a persistent, unique insertion ordinal to `tasks` in both backends on card D. Use signed 64-bit storage. Backfill existing SQLite tasks in ascending old `rowid` order before ANY D-era table rebuild. Preserve that ordinal through every rebuild and import.

Allocate later ordinals monotonically within the task-creation transaction. New tasks sort after old tasks when `created_at` ties. Use `ORDER BY created_at DESC, insertion_ordinal DESC` in both backends. Never recompute order from task IDs, timestamps alone, or PostgreSQL physical row locations.

The ordinal is a shared application column, not a schema-comparison exception. Include it in fresh-schema comparison once its migration ships.

### Migrations and comparison

SQLite keeps its current convergence model, including `learnings`. Preserve ordered migration dependencies and legacy fixtures. Make new async migration groups transaction-safe or retry-safe without parallel execution.

PostgreSQL uses numbered migration steps with a version record in each schema. Step 1 creates the current converged application schema, without `learnings`, plus the shared insertion ordinal.

Apply each missing step in its own transaction when the schema opens. Record that version in the same transaction. A failed step leaves neither its DDL/data changes nor its version record committed. Existing data survives supported later steps.

Every later schema change needs both a SQLite convergence change and a PostgreSQL numbered step. A shared test compares the table and column sets of fresh, fully opened databases.

Explicit comparison exceptions cover only:

- PostgreSQL metadata: the project registry and migration version records.
- Retired SQLite `learnings`.

Database-engine system catalogs and SQLite sequence bookkeeping are not application tables. Do not use a broad prefix exclusion that can hide a missing application table. Keep the exception list explicit and test it.

## Async operations and transactions

Every store method returns a promise. Callers must await results before they branch, emit events, start work, write a manifest, or exit.

Each store has a serial transaction queue. A transaction keeps one connection from `BEGIN` through `COMMIT` or `ROLLBACK`. Await every statement and callback result. A yielded callback does not let another transaction enter that store's transaction context.

Existing transaction callbacks call ordinary store methods. Preserve that composition without a second queued transaction, deadlock, or accidental independent commit. Use an internal transaction context for work already inside a transaction. Do not create a second full store implementation for each backend.

An ordinary operation must not execute inside another operation's open transaction by accident. Keep nontransactional access separate or route it through the appropriate serialized store context.

The queue continues after a definite rolled-back application error. Connection loss follows the retry and ownership rules below. Shutdown stops new work, settles permitted queued work, closes stores, and releases the lifetime lock before process exit.

Card A adds `App.close(): Promise<void>` for the same shutdown boundary.
It stops new background work and publication timers, then awaits accepted work and queued publications.
Server shutdown and test fixtures await this method before they close stores.
An accepted background error remains visible. Store closure must not cause a detached database read.

### Current store-internal read/write inventory

This inventory records synchronous groups that can interleave after an async conversion. It also records existing transactions and grouped writes that require a preserved boundary.

| Current symbol and source | Current group | Required boundary |
| --- | --- | --- |
| `nextTaskId`, `createTask`, `src/store.ts:3126-3180` | Read/update the ID counter, check an ID, insert the task, write two events, and read the task. | One task-creation operation and transaction. Include ordinal allocation. Reuse the outer context when a transactional caller creates a task. |
| `runTaskUpdate`, `src/store.ts:3266-3314` | Read the prior task, perform a guarded or unguarded update, read the result, and write stage/state events. | One transaction. Preserve revision conflict behavior and event source values. |
| `reorderQueue`, `src/store.ts:3317-3326` | Read and validate the queue permutation, then write each queued time. | One transaction. Revalidate against the same queue state and prevent partial order changes. |
| `syncPrCard`, `src/store.ts:3086-3110` | Read PR/task state, derive card state, and update the task. | One operation and transaction. Reuse `savePrDraft`'s context when it calls this operation. |
| `finishTurn`, `src/store.ts:3368-3402` | Update/read the turn, capture optional transcript-derived data, and record an error event. | Keep the core turn change, result read, and required error event in one transaction. Separate filesystem capture as described below. |
| `captureTurnCost`, `writeTurnCost`, `src/store.ts:1163-1175,3409-3434` | Read the task session, read/parse a transcript, and write cost fields. | Read files outside the transaction. Apply the result in a guarded store transaction against the same session and turn window. |
| `captureTaskContext`, `src/store.ts:3441-3453` | Read the session, read its transcript, and update task context. | Read files outside the transaction. Apply the result only while the task still identifies that session. |
| `storedTitle`, `resolveTitle`, `nameTask`, `src/store.ts:2220-2261` | Read the saved title/transcript, conditionally save a title, and return a title. | Preserve first-winner semantics. Apply and read the winning saved title in one operation after external work. Do not return a losing candidate as the saved title. |
| `setSettings`, `src/store.ts:2303-2315` | Upsert multiple keys and read the settings result. | One patch transaction and consistent result. This currently lacks a transaction. |
| `deleteForkBranchesNotIn`, `src/store.ts:2464-2475` | Delete obsolete branch rows and hold rows in separate statements. | One operation and transaction. This is a grouped write, not a read-driven write. |
| `startTurn`, `src/store.ts:3329-3366` | Insert a turn and read it through `lastInsertRowid`. | Return the inserted row through the generated-key adapter within the operation's transaction. |
| `ProjectStore.rebuildTasksOnCheck`, `src/store.ts:1326-1363` | Count, create a replacement, copy named columns, compare counts, and swap tables. | Preserve rollback and count checks. Keep the precondition/count and database changes in the serialized migration operation. Preserve insertion ordinals. |
| `ProjectStore.rebuildPrReviewRuns`, `src/store.ts:1487-1529` | Inspect shape, count/copy supported old rows, compare counts, and swap tables. | Preserve existing legacy migration behavior and rollback. Do not parallelize it with column convergence. |
| `ProjectStore.open`, `src/store.ts:1533-2181` | Inspect metadata and execute ordered DDL/data convergence. | Keep schema open serialized. Preserve rebuild dependencies and retry-safe backfills. PostgreSQL uses numbered transactional steps instead. |
| `backfillTopics`, `src/store.ts:1366-1385`, called at `1716` | Read eligible tasks, assign topics, and update each row. | One database operation and transaction for each assignment pass. Do not expose a partial assignment set. |
| `convergeProposalReasons`, `src/store.ts:1422-1482`, called at `2092` | Execute text rewrites, read candidate/parent rows, and update reasons. | One serialized transactional convergence operation. Preserve its idempotent selection rules. |
| Task `kind` migration, `src/store.ts:1990-2007` | Add `kind` and apply three marker updates only when the column was absent. | Make the addition and marker updates atomic or retry-safe. A failed first open must not leave permanent default kinds. |
| `backfillTurnCosts`, `src/store.ts:1185-1206`, called at `1980` | Read pending task/turn windows, read transcripts, and update missing costs. | Read files outside transactions. Guard each apply against the same session/window and missing-value condition. Preserve best-effort retry on later open. |
| `backfillDoneContext`, `src/store.ts:1214-1228`, called at `2063` | Read done tasks, read transcripts, and write missing context. | Guard the database apply against the same session, done state, and missing context. Preserve best-effort missing-file behavior. |
| Legacy fork-hold migration, `src/store.ts:2124-2147` | Read legacy JSON, insert hold rows, and clear the old value. | Preserve its existing transaction. Do not clear the external expansion checkpoint here. |
| `setForkHolds`, `src/store.ts:2375-2398` | Delete one branch's holds and insert replacements. | Preserve one transaction for the replacement set. |
| `createForkResult`, `src/store.ts:2479-2545` | Create result/child cards, advance cursors, and remove consumed holds. | Preserve one transaction and shared inner task-creation context. |
| `fileTrendingProposal`, `src/store.ts:2619-2671` | Check scout/verdict/cap state, create a task, and save its verdict. | Preserve one transaction, including the cap decision. |
| `judgeTrendingRepo`, `src/store.ts:2674-2711` | Check and save a verdict. | Preserve one transaction. |
| `fileIssueCard`, `src/store.ts:2778-2811` | Create a task and its unique issue-watch row. | Preserve one transaction. Caller-side batch cap decisions also need an atomic store operation. |
| `fileJiraCards`, `src/store.ts:2819-2865` | Read imports, create missing cards, and record imported keys. | Preserve one transaction and duplicate-key semantics. |
| `claimPrPost`, `src/store.ts:2960-2972` | Read the prior posted head and conditionally claim a new head. | Preserve one transaction and its affected-row result. |
| `startPrRun`, `src/store.ts:3025-3031` | Insert a review run and obtain its generated ID. | Preserve the inserted ID and caller quota boundary through the shared adapter. |
| `savePrDraft`, `src/store.ts:3040-3078` | Update the task, PR, run, and synchronized card state. | Preserve one transaction. |
| `appendReviewFinding`, `src/store.ts:3766-3787` | Insert a new unique finding and clear the review stamp only after insertion. | Preserve one transaction and duplicate-only no-op behavior. |
| `GlobalStore.get`, `GlobalStore.set`, `src/globalStore.ts:34-53` | A read or one upsert, with no internal read/write pair. | Await the read inside its existing JSON-decode guard. Apply fatal backend failures before compatibility fallbacks. Extract caller get/set groups into atomic operations. |

`done_at` and conflict-reason backfills use single atomic updates (`src/store.ts:1667-1681`). They need awaited execution, not an invented read/write transaction.

For transcript capture, preserve the distinction between an unavailable transcript and a database failure. Missing or unreadable files retain current best-effort behavior. A database failure must not become a successful missing-value result.

`legacyForkHoldBase` and `clearLegacyForkHoldBase` are separate methods (`src/store.ts:2404-2418`). Their caller performs Git work before hold replacement (`src/forks.ts:882-1006`). Preserve the base until replacement succeeds. Guard the final database apply against the original branch/base state. Never hold a database transaction across the Git work.

Caller quota examples also cross external work: fork runs (`src/forks.ts:1037-1139`), PR runs (`src/prs.ts:896-900,1000-1092`), and issue batches (`src/issues.ts:281-305`). Extract atomic quota claims or guarded final decisions. Do not claim a database transaction covers the external scan or review preparation.

### Card A assumptions and refreshed store inventory

Card A uses revision `e2cfc28`. It keeps `bun:sqlite`, existing schemas, lifetime locks, migrations, paths, and event values. Card D alone adds the insertion ordinal.

Integration also covers revision `4c809e1`: usage-hold stamps and attempt counts, quota recovery evidence, and lead-question replies. Lead replies keep each database-only section atomic around an external cancellation.

All store methods return promises. Properties and exported free filesystem helpers remain plain. Each store serializes database operations through one queue.

SQLite can end a failed transaction itself. Execute `ROLLBACK` only when the connection still reports an active transaction. Preserve the original error and admit later operations after definite rollback. Reject further work in a failed transaction, even if its callback catches the error.

After a lead cancellation, persist its result before other question-card guards. A concurrent metadata change must not discard its note or the remaining answers. A rejected persistence callback must not prevent stop cleanup or replace the requested stop reason. Keep the callback error in the log and turn record.

Legacy bases without unreleased hold rows do not block analysis. Valid legacy holds keep their checkpoints until a successful guarded hold replacement.

The current `src/store.ts` groups are:

| Current source | Group and boundary |
| --- | --- |
| `1214-1279` | Cost writes and transcript backfills. Read files outside transactions. Guard session, turn window, state, and missing values on apply. |
| `1351-2275` | Init and ordered open convergence. Preserve named-column copy, row counts, rollback, kind markers, topics, reasons, and legacy hold checkpoints. |
| `2277-2373` | Path and title helpers. Preserve title holds and the first saved title. Guard transcript title applies against the same session. |
| `2375-2407` | Settings patch and result. Use one transaction. |
| `2468-2490,2557-2631` | Fork holds, obsolete branches, result cards, children, cursors, and consumed holds. Use one transaction for each operation. |
| `2687-2799` | Trending judgments, caps, task creation, and verdicts. Preserve one transaction. |
| `2874-2962` | Issue and Jira imports. Preserve task, watch, and duplicate-key boundaries. |
| `3072-3084,3137-3226` | PR claims, generated run IDs, drafts, and synchronized cards. Preserve transactional results. |
| `3243-3430` | Task counters, creation, revision guards, and events. Use one transaction for each operation. |
| `3432-3522` | Queue reorder and turn writes. Keep error events with turn writes. Separate transcript capture. |
| `3529-3574` | Cost and context capture. Guard final applies after file reads. |
| `3621-3725,3813-3881` | Board and performance facts. Serialize each grouped read. |
| `3886-3907` | Finding insertion and stamp reset. Preserve duplicate-only no-op behavior. |
| `3933-3940` | Serialize snapshots without `BEGIN`. Stop admission before close, drain accepted work, and release the lifetime lock. |
| `src/globalStore.ts:16-65` | Global open, key reads and upserts, snapshots, and close. Serialize access. Add atomic `update` for caller get/modify/set groups. Keep JSON errors separate from database errors. |

`claimTurn` reads the current task, settings, tasks, and board-check marker in one transaction. Its caller supplies database-only or memory-only gates. It returns the original task after a successful preparing claim. It applies a blocked reason only when that reason changes.
The caller reads the current global cap and project membership inside the claim callback. The cap getter reads memory without I/O.

`finishTurnState` exposes database-only turn completion for caller settlement transactions. `captureTurnData` reads files after those transactions commit. `finishTurn` composes both methods for independent callers.

Caller groups include routes, turn dispatch and settlement, supervisors, watchers, startup, backup, restore, scripts, and real SQLite tests. Each caller must await results before effects. No cross-store transaction or external effect belongs inside a store transaction.

The ProjectStore inventory precedes source edits. Ripwire reports 26 direct importers and 85 affected test files. Its ambiguous and unresolved edges prevent a complete caller proof.

#### Refreshed caller inventory

This inventory uses the same card A baseline. The listed modules own these database groups.
Each module keeps external effects separate from its final guarded transaction.

| Module | Groups and retained boundaries |
| --- | --- |
| `src/turn.ts`, `src/scheduler.ts` | Advisory selection, authoritative claims, credit results, lost turns, boot recovery, preparation, reports, research, outcomes, rebase replies, checks, findings, cancellation, and finish-kept. |
| `src/supervisor.ts` | Stale guards, reclassification, hygiene, auto-tend, retro children, CI replies and children, Dependabot deduplication, and PR settlement. |
| `src/app.ts` | Resolution, edits, refile, reorder, restart, steering, replies, approval, promotion, parking, release creation, settings, project removal, and global lists. |
| `src/jiraRoutes.ts` | Connection updates after host checks, removal validation, query stamps, and one import transaction for each project. |
| `src/issues.ts` | Watch settings, batch caps, duplicate claims, and label stamps after GitHub effects. |
| `src/forks.ts` | Branch snapshots, hold replacement, legacy expansion checkpoints, quota claims, result cards, cursors, failure applies, and remaining proposal capacity. |
| `src/prs.ts` | Fetched rows, closure, quota claims, drafts, comments, cutoffs, and source identity guards. |
| `src/ompWatch.ts`, `src/trending.ts` | Settings and verdict guards, duplicate scouts, card creation and titles, and separate final global state. Bundle files remain external. |
| `src/webpush.ts`, `src/updates.ts` | Atomic subscription and update lists. Push cleanup compares the attempted subscription before removal. |
| `src/sealedConfig.ts` | Atomic config migration. The sealing walker and key policy remain unchanged. |
| `src/server.ts` | Awaited open, origin pins, guarded release stamps, recovery, timer admission, active callbacks, snapshots, and close before exit. |
| `src/backup.ts`, `src/restore.ts` | Awaited snapshots before manifests, rename, retention, and reports. Raw SQLite restore and integrity readers retain their current file boundaries. |
| `src/runner.ts`, `src/workers.ts` | Ordered session and finding callbacks. Run completion awaits callback drain and reports persistence failures. |
| `src/worktree.ts`, `src/release.ts` | Awaited task log callbacks before dependent effects or completion. |
| `scripts/demo-data.ts`, `src/dev.ts`, `scripts/card-shot.ts` | Awaited store initialization, demo state, progress snapshots, and close. Raw demo and screenshot SQL remains SQLite-specific. |
| Store, route, watcher, lifecycle, backup, and hosted tests | Awaited fixtures, old-schema opens, subprocess readiness, snapshots, and close before reuse. Concurrency assertions check state and required events. |

`src/dblock.ts`, the independent `agent.db`, Mnemopi, and the update-host lock retain their SQLite interfaces.
The pure dependency resolvers retain synchronous snapshot lookups for UI consumers. Card A adds no UI change.

### Card B conversion and refreshed driver inventory

Card B retains card A's async store API and `StoreQueue`. It changes the tracker SQLite driver to `Bun.SQL`.
Each store retains one SQLite connection. The queue serializes ordinary operations, transactions, snapshots, and close.
The schema, retired `learnings` table, data paths, and `rowid` tie order stay unchanged. Card D owns the insertion ordinal.

The driver uses exact integer results. It converts safe integers to JavaScript numbers and retains larger integers as `bigint`.
Number-only generated-ID methods reject an unsafe ID before commit. They never infer an ID from a later maximum.
File paths use file URLs so literal question marks and hashes do not become SQLite connection options.
Only SQLite's exact no-active-transaction error permits a redundant rollback. Other database errors propagate.

| File or symbol | Card B boundary |
| --- | --- |
| `src/sqliteDriver.ts` | One connection, bound values, exact integer decode, statement metadata, async execution, and rollback. |
| `openLocked`, `closeLocked`, `vacuumInto` | Async SQLite helpers. Preserve exclusive ownership, timeouts, WAL, normal synchronous mode, and snapshot checks. |
| `ProjectStore`, `GlobalStore` | Shared store SQL and existing queues. Keep ordered convergence and nested transaction context. |
| `adoptSharedProjectData`, `src/server.ts` | Await each copy and close before file moves and startup completion. |
| `restoreSnapshot`, `runRestore` | Await target lock checks before file changes. Await errors before the CLI reports its result. |
| `scripts/update-host.ts` | Await the shared helper. Its independent lock database remains SQLite-specific. |

The refreshed search found no other shared-helper callers in `src` or `scripts`.
Ripwire reports 89 affected tests for `store.ts` and 88 each for `globalStore.ts` and `dblock.ts`.
Its graph has ambiguous and unresolved edges. The caller search and full suite supplement that evidence.

Permanent tests use actual files from `bun:sqlite` and the new tracker path.
They cover legacy convergence, rollback after a table swap, precise values, generated IDs, affected rows, queue isolation, and snapshots.
Subprocess tests cover exclusive refusal, PRAGMAs, close, and natural exit. Fixed-seed properties cover signed 64-bit values and snapshot identifiers.
The README remains correct because SQLite stays the only shipped backend. This card adds no PostgreSQL selection or support claim.


### SQL dialect inventory and target behavior

| Surface and current evidence | Required target behavior |
| --- | --- |
| SQLite `?` values, `src/store.ts:2308-2311,3141-3175,3345-3363`; `src/globalStore.ts:36-52` | Bind values through Bun.SQL and a small placeholder helper. Keep identifiers separate. Preserve `TASK_COLUMNS` as the dynamic update allowlist (`src/store.ts:730-830`). |
| `ON CONFLICT ... DO UPDATE`, `src/store.ts:2308-2311,2375-2477,2545-2733,2880-2940` | Preserve keys, updates, `excluded` values, and affected-row meaning with shared SQL. |
| `INSERT OR IGNORE`, `src/store.ts:2138-2140,3768-3779` | Use a duplicate-key conflict action. Do not suppress unrelated constraints or connection errors. |
| `INSERT OR REPLACE`, `src/store.ts:2845-2848` | Preserve replacement of the Jira `(site, issue_key)` task/time values through an explicit upsert. Do not assume PostgreSQL supports SQLite replace syntax. |
| Hidden `rowid` sort, `src/store.ts:3205-3211` | Use the persistent insertion ordinal and preserve tie order. |
| Autoincrement DDL, `src/store.ts:141-152,182,256,274`; generated IDs at `3025-3031,3345-3364` | Replace active generated keys with identity/helper return values. `learnings` remains SQLite-only. Do not reuse an imported ID. |
| Numeric/text row mapping, `src/store.ts:329-445,1240-1274`; settings/global JSON at `2303-2315`, `src/globalStore.ts:34-53` | Preserve 64-bit storage, double-precision costs, text JSON, and numeric flags. Prove driver decode behavior with real backend tests. |
| `PRAGMA table_info` and `sqlite_master`, `src/store.ts:1544-1547,1687-1692,1903-1906,2095-2109,2176-2180` | Keep SQLite convergence metadata reads. Use PostgreSQL catalogs and numbered per-schema versions for PostgreSQL. |
| DDL/rebuilds, `src/store.ts:1326-1363,1487-1529,1533-2181` | Preserve named-column copy, row-count checks, rollback, and ordered dependencies. Use backend-specific migration execution, not duplicated store methods. |
| `busy_timeout`, exclusive lock, WAL, normal synchronous mode, `src/dblock.ts:56-84` | Preserve SQLite settings and natural lock release. PostgreSQL uses the dedicated advisory session below. |
| `VACUUM INTO ?`, count checks, integrity check, `src/dblock.ts:97-119` | Preserve SQLite snapshot behavior. Do not substitute a PostgreSQL snapshot implementation. |
| `.changes`, `src/store.ts:2716-2717,2968-2970,3290-3302,3768-3782` | Normalize driver results to the same zero/one/positive meaning. Test revision conflicts and duplicate claims. |
| `.lastInsertRowid`, `src/store.ts:3025-3031,3345-3364` | Return the correct inserted ID through a small generated-key adapter. Do not infer it from a later maximum. |
| Transaction callbacks, `src/store.ts:2124-2147,2375-2398,2479-2545,2619-2711,2778-2865,2960-2972,3040-3078,3766-3787` | Await callbacks on a pinned connection and preserve rollback. Reuse transaction context for inner methods. |

## Lock, retry, and unknown-result rules

### Lifetime ownership

PostgreSQL holds one database-wide session advisory lock with a fixed key. Reserve one dedicated connection for that lock throughout the server lifetime. Do not return it to the ordinary query pool.

Acquire the lock before schema changes or state writes. A second server against the same database exits nonzero. Use a nonblocking lock attempt rather than an indefinite startup wait.

Require a direct PostgreSQL connection. Transaction-mode poolers are unsupported because they do not preserve advisory session ownership.

If the lock connection fails, stop state writes. Never resume them without proof that the server owns the advisory lock on its replacement reserved connection. If another server owns it, or ownership cannot be established within the permitted runtime recovery, exit nonzero.

A PostgreSQL connection failure at startup causes an immediate nonzero exit. Do not apply the runtime retry window to startup.

### Runtime failure matrix

The internal runtime retry duration defaults to 30 seconds. Tests may supply a shorter internal duration. Do not expose a retry duration environment variable.

| Observed failure | Action |
| --- | --- |
| Connection establishment failure or failed read, with no possible state change | Reconnect and retry within the fixed window. Prove lock ownership before any later state write. |
| Explicit transaction failure before the client sends `COMMIT` | Roll back or abandon the failed connection. Replay the whole transaction on a new connection within the window. |
| Application or constraint error with a definite transaction rollback | Return the error. Do not treat it as a connection retry. |
| Connection loss after a single-write autocommit could reach the server | Treat the outcome as unknown. Never replay the write. Log a safe cause and exit nonzero. |
| Sent `COMMIT` with no reliable reply | Treat the outcome as unknown. Never replay the transaction. Log a safe cause and exit nonzero. |
| Retry window exhausted | Log a safe cause and exit nonzero. |
| Advisory lock ownership cannot be reestablished | Exit nonzero. Never continue state writes. |

Replay only complete transactions, not individual failed statements. A transaction eligible for replay must contain database work only. External effects must not repeat because of a database retry.

Track whether `COMMIT` was sent. An error message alone cannot prove that a write did not commit. If the driver cannot prove a safe replay boundary, classify the result as unknown and exit.

## Empty-target import guard

If PostgreSQL has no `ottr_global`, inspect the existing live SQLite paths before normal initialization. If a live `tracker.db` or project `tasks.db` exists, refuse startup and show the import command.

`OTTR_PG_ALLOW_EMPTY=1` explicitly overrides this guard. It does not copy, delete, or modify SQLite files. It does not permit a runtime backend change.

An existing `ottr_global` selects the existing PostgreSQL state. Do not merge live SQLite state into it during server startup.

## One-way SQLite import

Provide a CLI under `src`, using the restore tool entry pattern and the same live data-root rules. Use `bun src/import-sqlite-to-postgres.ts` as the documented entry command. Obtain the target URL from `OTTR_DATABASE_URL`, not a command argument.

The operator must stop the server before import. The CLI must also refuse any source SQLite file with a held lock. An operator statement alone does not prove an unlocked source.

Import global state and every project into one PostgreSQL transaction. Create the global schema, registry, project schemas, migration records, and copied application rows within that transaction. Acquire target ownership before any target change.

Refuse these conditions with a nonzero exit:

- A missing, invalid, or non-PostgreSQL target URL.
- Pre-existing `ottr_global`.
- Any held source SQLite lock.
- Any source application table/column set that differs from a fresh, fully converged database from the same code.
- A registry conflict, PostgreSQL constraint rejection, copied-row failure, count mismatch, or incomplete source item.

The schema check compares table and column sets, not SQLite CHECK source text. Do not reject a compatible source because its SQL text differs. If a copied row violates a PostgreSQL constraint, roll back the whole import.

Do not migrate source files in place. Do not change source bytes, journals, or persistent metadata. Use source access that proves lock refusal without a mutating open/convergence path. Test original byte equality on success and every failure path.

Ignore `learnings`. If it contains rows, print an explicit notice with its skipped row count. Do not silently omit another table.

For every copied table in every database, print the source and target row counts. Include empty tables. Count the global `kv` table and every project application table. Backend metadata is not a copied source table.

Preserve IDs, nulls, text, numeric values, and persistent insertion ordinals. Copy the source ordinal unchanged. Do not bypass the source schema check for a missing ordinal column. Set each target identity's next key above its imported maximum.

Exit zero only after every table agrees and the transaction commits with a known result. A refusal, incomplete item, count mismatch, or error exits nonzero.

Every definite pre-commit refusal or failure leaves no import-created objects or rows. Preserve all pre-existing target data and source bytes.

A lost COMMIT reply follows the unknown-result rule. Exit nonzero without success or replay. The target may contain the COMPLETE import. The operator must inspect the target before another attempt. Do not promise an empty target when the commit outcome is unknown.

## Backup, restore, and hosted operation

SQLite retains its current snapshot and restore behavior. Await each async snapshot before manifest creation, directory rename, retention, or error reporting (`src/backup.ts:212-313`). Await store close before server exit (`src/server.ts:198-211`).

In PostgreSQL mode, the server does not schedule SQLite snapshots. Emit one boot log that identifies operator-owned PostgreSQL backup. The SQLite restore CLI refuses PostgreSQL mode with a nonzero exit before file changes.

Ship backup exclusion and restore refusal code in card D. Do not defer safety code to the final documentation card.

The operator owns PostgreSQL backup and restore. Card F documents a `pg_dump` example such as `pg_dump --dbname="$OTTR_DATABASE_URL" --format=custom --file=ottr.dump`. Keep credentials out of checked-in examples and logs. Explain the operator's secret-handling duty when a command exposes a URL to process inspection.

Hosted support is a documentation contract only: one tenant database and a direct URL in the tenant server environment. This work does not change `ottr-cloud`, tenant provisioning, or deployment automation.

## PostgreSQL 18 test and compose contract

PostgreSQL 18 is the minimum and tested major. Card C selects and records a PostgreSQL 18 image digest. Card F reuses that exact digest for the optional production service. Tests and CI use the same digest.

### Isolated test service

Add `postgres-test` under compose profile `pgtest`. Use tmpfs data, trust authentication, no published host port, and connectivity from the server and workers.

Trust authentication is an explicit exception for the isolated internal test network. It is not a production example. Test URLs must not contain production credentials.

Add a PostgreSQL service to GitHub CI with the same digest. Card C chooses the existing CI network pattern. Host-runner jobs need an ephemeral mapped service port. Job-container execution may use its service network instead.

`OTTR_TEST_PG_URL` must reach PostgreSQL from each CI test process. The compose no-host-port rule does not apply to CI. Pass `OTTR_TEST_PG_URL` and `OTTR_REQUIRE_PG_TESTS` to server and worker test environments.

Each test file creates a random database through `CREATE DATABASE`. It drops only databases that it created and owns. Do not share one mutable database between test files.

Real subprocess fixtures receive their file's database through normal `OTTR_DATABASE_URL`. Do not add a test-only product selection variable.

Before tests connect, compare the normalized host, port, and database against the production URL. Treat omitted default ports consistently. Refuse the test URL if that tuple matches production.

- If the URL is absent and `OTTR_REQUIRE_PG_TESTS=1`, fail.
- If both are absent, skip PostgreSQL tests with an explicit notice.
- If the URL exists, execute the real connection test and backend tests that apply to the card.

Use a test-owned TCP proxy for connection loss and lost-reply injection. Use a closed port for unreachable-startup tests. Never break a shared service or touch a live tenant database.

### Optional production compose service

Card F adds the optional `postgres` profile with a named data volume and no published host port. Require the production password through environment substitution. Do not include a literal password or trust authentication.

The compose service and server URL remain operator choices. SQLite remains the default when no URL selects PostgreSQL.

## Bun.SQL SQLite prerequisite proof

The parent executed this temporary proof with synthetic file-based SQLite data:

```sh
bun /tmp/ottr-805-driver-QZU8jo/proof.ts
```

- Bun version: `1.4.4`.
- Script: `/tmp/ottr-805-driver-QZU8jo/proof.ts`.
- Script SHA-256: `570fdf2dda4496619418755582d13a5ef7ff547e9874178cdcfc53deec12f296`.
- Captured stdout and exit receipt: `/tmp/ottr-805-driver-QZU8jo/proof.log`.
- Log SHA-256: `ebb79bf391680524e7564f9ce330ccaf79ff978a8d818970a3661655c51b3e81`.
- Observed process result: `EXIT_CODE=0`.

The exact five-pass summary is:

```json
{"label":"summary","value":[{"requirement":"a: exclusive lock across processes and natural release","status":"PASS"},{"requirement":"b: WAL persistence","status":"PASS"},{"requirement":"c: parameterized VACUUM INTO","status":"PASS"},{"requirement":"d: schema migration and failed rebuild rollback","status":"PASS"},{"requirement":"e: transaction callback throw rollback","status":"PASS"}]}
```

Key observed receipts follow:

```json
{"label":"holder ready","value":{"busy_timeout":[{"timeout":5000}],"locking_mode":[{"locking_mode":"exclusive"}],"journal_mode":[{"journal_mode":"wal"}],"synchronous":[{"synchronous":1}]}}
{"label":"contender process","value":{"code":0,"signal":null,"stdout":"{\"label\":\"contender read\",\"value\":{\"elapsedMs\":201.37955,\"error\":{\"name\":\"SQLiteError\",\"message\":\"database is locked\",\"code\":\"SQLITE_BUSY\"}}}\n","stderr":""}}
{"label":"access after natural exit","value":[{"id":1,"value":"holder row"}]}
{"label":"persisted WAL","value":{"mode":[{"journal_mode":"wal"}],"rows":[{"id":7}]}}
{"label":"successful rebuild counts","value":{"before":2,"after":2}}
{"label":"failed rebuild counts before throw","value":{"before":2,"after":2}}
{"label":"transaction rollback","value":{"error":{"name":"Error","message":"intentional transaction callback failure"},"before":[{"id":1,"value":"original"}],"after":[{"id":1,"value":"original"}]}}
```

Requirement a also observed acquisition `busy_timeout=200`, followed by operational `busy_timeout=5000`. The holder exited naturally with code 0. The contender observed `SQLITE_BUSY` after `201.37955` milliseconds. Reopen returned the same holder row.

Requirement b reopened the file with `journal_mode=wal` and preserved row ID `7`.

Requirement c used parameterized `VACUUM INTO` with a quote-bearing destination: `/tmp/ottr-805-driver-QZU8jo/run-8pwfbY/copy with ' quote.sqlite`. Source and copy both contained three rows. Both empty-table counts were zero. The rows preserved `O'Brien`, `Unicode: λ`, NULL, and signed integers `-7`, `0`, `99`. `integrity_check` returned `ok`.

Requirement d observed `table_info` before and after `ADD COLUMN`. The new `extra` column was `TEXT NOT NULL DEFAULT '[]'`. The explicit-column rebuild preserved two rows. An intentional error after the table swap restored the exact prior schema, DDL, and rows. The receipt reported `leftovers: []`.

Requirement e threw after an UPDATE and INSERT. Rollback restored exactly `[ { "id": 1, "value": "original" } ]`.

This proof covers only Bun.SQL SQLite files and synthetic data. It does not prove the complete store conversion, old live databases, PostgreSQL, reserved advisory sessions, or PostgreSQL failure handling.

The script stays outside the repository. This proof ships no permanent feature or test. Card B must add real old-driver compatibility coverage. Before implementation claims, card D must prove reserved advisory connection ownership, schema-qualified SQL, and transactions against live PostgreSQL.

## Six-card delivery plan

All six card prompts reference `docs/specs/postgres-backend.md`. Each card first checks that the specification exists on `origin/main`. If absent, report `needs_you` with dependency `OTTR-805` and wait for the merged specification.

OTTR-805 writes this specification and ADR 0013, then files all six build cards through `create_task`. It implements no backend code.

Dependencies are:

```text
OTTR-805 -> A -> B -> D -> E -> F
OTTR-805 -> C ------> D -----> F
```

The explicit dependencies are: A and C depend on OTTR-805, B depends on A, D depends on B and C, E depends on D, and F depends on D and E.

### A: Async stores and atomic caller operations

Keep `bun:sqlite` for this card. Convert all store methods and callers to async. Add per-store transaction queues and extract all inventoried caller read/write groups into atomic store operations.

Acceptance:

- Existing tests and old fixtures retain their behavior.
- A transaction callback that yields cannot interleave with another transaction on that store.
- Nested store work uses the current transaction without a deadlock or independent commit.
- Concurrent operations match a permitted serial result for each inventory group.
- Task updates and creation retain their required events and revision semantics.
- External work remains outside transactions, with guards on its final database apply.
- Startup, shutdown, backup, and real subprocess fixtures await the new methods.

### B: Bun.SQL SQLite conversion

Replace `bun:sqlite` in tracker stores and `openLocked` with Bun.SQL. Keep the shared async store implementation and SQLite-only exclusions.

Acceptance:

- Real files from the old driver open without a format change or lost data.
- Exclusive cross-process locks, acquisition/operational timeouts, WAL, and normal synchronous mode retain their behavior.
- Natural process exit releases the SQLite lock.
- Legacy schema fixtures converge in the same required order.
- Named-column rebuild failure restores prior schema and rows.
- Backup and restore retain count/integrity checks and their documented file behavior.

### C: PostgreSQL 18 test service and fixtures

Select the pinned PostgreSQL 18 digest. Add the isolated compose test profile, CI service, environment propagation, per-file database fixture helper, and real connection/query test.

Acceptance:

- Server and worker tests receive both test variables.
- Required-without-URL fails. Optional-without-URL skips with a notice.
- The helper refuses a normalized production tuple and cleans only its owned database.
- Real subprocess fixtures receive their per-file database URL.
- Compose and CI use the same digest. Compose publishes no test host port.
- CI supplies a reachable `OTTR_TEST_PG_URL` through an ephemeral mapped port or a job-container service network.

Card C work verifies only required-URL failure and absent-URL skip. A live connection pass is not available before its service change merges. This is an accepted verification limit, not a live-pass claim.

Tell the operator to enable `pgtest`, set both test variables, and recreate the stack after merge. Post-merge CI and card D's first action must prove the live connection test.

### D: PostgreSQL backend and lifecycle safety

Before code changes, require `OTTR_TEST_PG_URL` and a passing C connection test. If either prerequisite is absent, report `needs_you` rather than substitute mocks or SQLite.

Implement backend selection, schema layout, registry, numbered migrations, ownership lock, safe logging, retry rules, unknown-result exit, and the empty-target guard. Prove Bun.SQL reserved sessions, qualified SQL, and live PostgreSQL transactions first.

Ship PostgreSQL backup exclusion and restore refusal code on this card. Update AGENTS hard-stop 2 through its agent-data source in the same turn. If the cross-project rule applies, file the agent-data card instead of editing another project inline.

Acceptance:

- Shared real-driver store suites pass for SQLite and PostgreSQL.
- A second server refuses the same PostgreSQL database.
- Unreachable startup exits nonzero without the runtime retry loop.
- Runtime retry succeeds only for safe classes and stops at its internal duration.
- Lost autocommit or COMMIT replies cause a nonzero exit without replay.
- Lock loss blocks state writes until ownership proof, or causes a nonzero exit.
- URL secrets never enter logs, API output, stores, or worker/local-turn environments.
- Empty-target guard and `OTTR_PG_ALLOW_EMPTY=1` behave as specified.
- Shared schema comparison detects a missing application table or column.
- A numbered migration commits its version atomically and retains existing data.
- Backfill old SQLite `rowid` order before ANY D-era table rebuild. Preserve persistent insertion ordinals through rebuild, reopen, and tied task creation.
- Preserve those ordinals unchanged through the card E import contract.
- PostgreSQL backup scheduler exclusion emits one boot log. Restore refuses before file changes.
- Fixed-seed fast-check properties cover schema naming and URL/error redaction.
- New code files enter the mutation set. The work turn skips Stryker explicitly.

### E: One-way import CLI

Implement the real CLI with temporary SQLite files and the live per-file PostgreSQL fixture. Use the same code revision for fresh-schema comparison and source validation.

Acceptance:

- Actual CLI tests import global data and multiple projects in one target transaction.
- Every copied table reports source and target counts, including empty tables.
- IDs, integer range, double-precision costs, text/JSON, NULL values, flags, and insertion order survive.
- The next generated key exceeds each imported maximum.
- A nonempty `learnings` table produces the skipped-row notice.
- Locked sources, stale schemas, existing `ottr_global`, constraints, incomplete items, and count mismatches refuse with nonzero exits.
- Every definite pre-commit refusal or failure leaves no import-created schemas or rows and preserves all pre-existing target data.
- Source bytes remain equal after success, refusal, and injected failure.
- A lost COMMIT reply causes a nonzero exit without replay or a false success report.
- An unknown outcome may leave the COMPLETE import. Require operator inspection instead of an empty-target promise.

### F: Production compose and operator documentation

Add the optional production `postgres` profile with C's exact digest. Update README, WORKERS, backup documentation, and hosted-mode documentation.

Explain experimental status, setup, import, `pg_dump`, the direct-connection requirement, pooler limits, and secret boundaries. Keep SQLite as the default documented path.

Acceptance:

- A live PostgreSQL server boot and API smoke use the implemented backend.
- `compose.test.ts` text tests verify profiles, digest, required password substitution, named volume, and no host port.
- Test and production PostgreSQL services use the same chosen digest.
- Documentation names PostgreSQL 18 as minimum and tested major.
- Hosted text defines one tenant database and environment-only direct URL without an `ottr-cloud` change.
- The card states that work cannot run `docker compose` where that limit applies. It does not claim a compose runtime pass.
- No screenshot or permanent board UI change occurs.

Each work card runs its assigned focused checks and normal project gates under the current project rules. Work turns skip mutation execution explicitly. Do not run optional architecture review as part of this documents-only card.

OTTR-805 acceptance requires the frozen dependency install, `bun run check`, and the full `bun test` suite with a retained log. Record their actual results separately from the temporary proof. Skip mutation execution for this work turn. These document changes do not constitute an architecture-review run.

This card also requires the proof receipt, the ADR 0003 note, the ADR index entry, and six cards with these dependencies.

## Non-goals and exclusions

- No backend implementation on OTTR-805.
- No stable external SQL schema or third-party SQL API.
- No multiple-server scale-out, replicas, sharding, or automatic failover design.
- No runtime backend change, bidirectional sync, automatic import, or SQLite mirror.
- No PostgreSQL-to-SQLite export or zero-downtime migration.
- No numbered SQLite migrations or support for PostgreSQL versions below 18.
- No PostgreSQL storage for task logs, sessions, images, or handoffs.
- No Ottr-managed PostgreSQL backup scheduler or restore engine.
- No `ottr-cloud` code change or tenant provisioning change.
- No new npm database driver or public retry configuration.
- No permanent board UI or screenshot change.
- No documented, tested, or supported local-checkout PostgreSQL run. Do not add a deliberate block to it.

These paths remain SQLite-specific:

- `demo-data.ts` and `card-shot.ts`.
- The README screenshot flow.
- `src/login.ts` access to omp `agent.db`.
- Mnemopi database access.
- The update-host lock.
- Read-only copy-integrity readers in backup code, which may retain `bun:sqlite`.

## Alternatives considered

1. **SQLite mirror.** Reject it because two writable state copies need synchronization and conflict rules. PostgreSQL must own its selected backend state directly.
2. **In-memory working copy with write-behind.** Reject it because deferred persistence changes crash, transaction, and backup behavior. It also creates a second state authority.
3. **Blocking worker bridge.** Reject it because a synchronous facade hides asynchronous failures and adds blocking IPC. Use async stores and explicit awaited callers.
4. **Shared tables with a project key.** Reject it because every query and key must carry tenant/project scope. Per-project schemas preserve current project boundaries.
5. **One PostgreSQL database per project.** Reject it because it multiplies provisioning and connection work. It also prevents one import transaction across global and project state.
6. **Separate full store implementations.** Reject them because behavior and schema changes can diverge. Share store methods and SQL with small dialect helpers.
7. **Thin layer that retains `bun:sqlite` for tracker stores.** Reject it because two driver models preserve two transaction/result paths. Move both tracker backends to Bun.SQL.
8. **npm `pg` or `postgres` driver.** Reject it because Bun.SQL supplies the selected built-in interface. Do not add a driver dependency.
9. **Ottr invokes `pg_dump`.** Reject it because PostgreSQL backup belongs to the operator. Document the tool without a new Ottr backup subsystem.
10. **Heartbeat lease.** Reject it because expiry and clock rules can admit concurrent owners. A dedicated PostgreSQL session advisory lock gives database-owned lifetime exclusion.

## Risks and mitigations

| Risk | Mitigation and evidence requirement |
| --- | --- |
| Async conversion creates interleaving that synchronous calls prevented. | Refresh the complete inventory. Extract atomic store operations. Compare concurrent results with serial results. |
| A transaction callback uses another connection or deadlocks through the queue. | Keep a pinned transaction context. Test yielded callbacks and inner store calls with real drivers. |
| Connection loss causes a duplicate task, event, quota claim, or import. | Replay only a proven pre-COMMIT transaction. Exit on an unknown autocommit or COMMIT result. Test lost replies through a test-owned proxy. |
| Lock connection loss permits a second owner while the first server writes. | Stop state writes on loss. Require new reserved-session ownership proof before any resumption. Test second-server and lock-loss behavior. |
| A pooler breaks session advisory ownership. | Require direct connections and document transaction-mode poolers as unsupported. |
| A schema update lands in one backend only. | Compare fresh application table/column sets. Require both SQLite convergence and a PostgreSQL numbered step. Keep exceptions explicit. |
| Hidden row order changes tied task order. | Persist and backfill insertion ordinals from old rowid order. Test rebuild, import, reopen, and tied creation times. |
| PostgreSQL narrows integers or cost precision. | Use signed 64-bit integers and double precision. Test driver decode, exact imports, and large millisecond values. |
| URL or driver errors expose credentials to agents or logs. | Keep environment-only selection, redact causes, filter all child paths, and test redaction properties. Retain ADR 0011. |
| Import partially creates a tenant or modifies its sources. | Definite pre-commit failures roll back all import-created objects. Preserve existing data and source bytes. Test lock refusal, counts, and byte equality. |
| Import loses its COMMIT reply after PostgreSQL commits. | Exit nonzero without replay or success. The target may contain the COMPLETE import. Require operator inspection, not an empty-target promise. |
| External results overwrite newer database state. | Read external data outside transactions. Apply it through guarded store operations against the same source identity/revision/window. |
| Tests damage production or another test file. | Refuse the normalized production tuple. Create random per-file databases and drop only owned databases. Use isolated trust auth without production credentials. |
| Test service setup appears to prove live behavior before merge. | State C's verification limit. Require post-merge CI and D's live connection proof before backend code. |
| Intermediate commits run SQLite backup or restore against PostgreSQL. | Deliver scheduler exclusion and restore refusal in D, before final documentation. |
| A prototype proof becomes an unsupported production claim. | Scope the receipt to synthetic file SQLite. Require real old-driver and live PostgreSQL tests in later cards. |

## Caller read/write inventory

Baseline: `38b6504e42c960b45bb2897a174b98e53a0c5cae`. These intervals describe current callers, not a shipped PostgreSQL backend. Card A must re-inventory callers that change after this baseline.

Current synchronous store calls cannot interleave within a no-await JavaScript section. Async conversion must replace each such read/check/write group with one queued transactional store operation. Existing awaits already permit interleaving. Preserve current guards and snapshot semantics across those awaits. Do not treat a stale snapshot note as a separate bug-fix requirement.

A database transaction covers database work only. Git, network, process, model, and filesystem effects remain outside transactions. Read or claim state first, perform the external effect separately, then apply final state through the required guarded store operation. Preserve existing guard fields and revision checks.

### Scheduler and turn lifecycle

- `src/scheduler.ts:725-930`, especially `725-813,910-930`: `schedule` refreshes flags, reads `listTasks`, selects candidates, and calls `runTurn`. Selection is pure. Keep the claim authoritative, not the selection snapshot.
- `src/turn.ts:3030-3135`: `claimTurn` reads the task and board-check state, checks start gates, and writes `preparing`. The scheduler reaches this claim without an await. Extract one atomic claim operation with all current gates.
- `src/turn.ts:3260-3455,3600-4175,4250-5025`: startup performs credit, Git, filesystem, package, and worker work. At `1722-1810`, the credit hook awaits, then the code re-reads the task before its credit-result write. Preserve that re-read and guarded apply. Keep all external work outside the store transaction.
- `src/turn.ts:2163-2224,1937-2018`: lost-turn sweeps read task lists and open turns, finish rows, and requeue cards. Make each database-only settlement one atomic store operation. `settleLostTurn` reads a card before `await lostResumeReply` and uses that snapshot afterward. Preserve the applicable guards and snapshot semantics during extraction. Keep VM-token revocation separate.
- `src/turn.ts:2090-2155`: boot recovery checks GitHub and Git, writes a turn, reads target facts, and writes completion data. Combine the database-only final apply. Keep filesystem status reads and worktree removal separate.
- `src/turn.ts:4990-5350,6270-6665,7300-7680`: settlement reads a report file and can write `report` or `research` before later awaits. Preserve these intermediate boundaries. Apply final turn/task outcomes atomically after Git, VM sync, push, or rebase effects, with current guards.
  Cancellation does not suppress report capture or the research flag before cleanup.
- `src/turn.ts:6548-7120`: failed-push recovery awaits fetch, rebase, and merge gates. `queueRebaseTurn` then reads the pending prompt and writes the retry count and queued prompt. Make that final read/write group one atomic operation.
- `src/turn.ts:7300-7680,7780-8060,8390-8620`: review and work checks await second-model runs. Make each related findings, child-task, and final-state database group atomic. Preserve the task re-read in `writePostCheckState` before its deferred write.
- `src/turn.ts:8640-9105`: cancel writes `cancelledAt` before worker or process kills. Preserve that early claim. Later task reads, Git checks, file moves, worktree removal, and remote-branch deletion remain separate effects. Guard the final state apply. Stop awaits process effects. Finish-kept copies or ignores files and removes the worktree before its atomic completion apply.
- `src/turn.ts:7350-7510,8390-8620`: completed reports, retry outcomes, and follow-up filing use multiple writes. Combine adjacent database-only groups. Handoff-file writes between child creation and follow-up updates remain separate, with guarded final updates.
- The broader turn intervals `src/turn.ts:2580-2765,4700-5025,6270-7120` also belong to this caller review. Preserve their claim, run-report, and settlement boundaries under the same rules.

### Supervisor

- `src/supervisor.ts:142-220`, especially `142-150`: `wentStale` re-reads task state after slow work. Preserve its state, reason, cancellation, and queued-prompt guards inside each final store apply.
- `src/supervisor.ts:660-750`: stale-card reclassification awaits Git checks, reads turns to match the prior result, then uses `wentStale`. Combine the final guard and task update atomically.
- `src/supervisor.ts:800-930`: hygiene reads settings and cards, checks Git, quarantines files, and removes worktrees. Preserve state checks before and after filesystem effects. Each check/write group needs its own atomic boundary.
- `src/supervisor.ts:1080-1258`: auto-tend reads turn history and task state before it queues a reply. Make that read/check/write group atomic. Retro filing reads tasks and turns, writes a handoff file, creates a child, and links it. Keep the file effect separate and combine each adjacent database group.
- `src/supervisor.ts:1350-1520`: CI checks await GitHub and log reads, then recheck state before task updates. Preserve the guarded final apply. CI follow-up creation, handoff-file write, and child update retain separate effect boundaries.
- `src/supervisor.ts:1540-1795`, especially `1540-1650`: Dependabot reads `listTasks` for deduplication, then awaits PR-head fetch and Git reads before card creation and update. Preserve deduplication semantics and guards across that await. Combine the final database-only creation/update group.
- `src/supervisor.ts:1680-1795,1880-2134`: PR settlement awaits GitHub and Git before task writes. Preserve `wentStale` guards in final atomic applies. Worktree-status reads and remote-branch removal remain external effects.

### HTTP, task, settings, and Jira routes

- `src/app.ts:4653-4710,4795-4825`: task resolution and edits use task snapshots. `resolveTask` returns the snapshot that handlers use for guards. Preserve those guards in atomic route operations after async conversion.
- `src/app.ts:6552-6655`: cancel delegates to the early cancel mark and external cleanup flow. Refile reads `listTasks` for duplicates, then synchronously creates and updates a replacement. Extract one atomic refile operation.
- `src/app.ts:6660-6735,9302-9375`: steer edits, steer cancel, and prompt edits read state and write without an await after the request body completes. Preserve revision checks through `updateTaskIfCurrent` or `editTask` in one atomic operation.
- `src/app.ts:6860-6900`: `reorderQueue` owns queue validation and mutation. Keep both within that atomic store operation. The handler does not first read the queue.
- `src/app.ts:7069-7225`: finish-kept delegates to external Git/filesystem work. Restart-session reads a needs-you task, then synchronously writes its restart prompt and queued state. Make that one atomic operation. Preserve task-state checks for star and edit-start writes.
- `src/app.ts:8481-8590`: promotion reads the latest grill turn and updates the task. Parking checks and updates task state. Each group needs one atomic operation. Grill reads the task before `await readJson`, then writes from the earlier snapshot. Preserve its current snapshot and guard semantics across that await.
- `src/app.ts:8676-8845,9168-9250`: steering and replies save images before task updates. Follow-up creation can place image and handoff-file writes between child creation and the final update. Keep those effects separate. Make approval, send-back, ordinary reply, and adjacent child database groups atomic with their current guards.
- `src/app.ts:9810-10100`, especially `9920-10010`: task creation reads image limits, creates a task, writes image files, and applies metadata before scheduling. Preserve these effect boundaries and the cancellation write on image failure. Combine adjacent database-only groups.
- `src/app.ts:9900-10010`: release planning performs Git/GitHub work before final task checks and creation. Make the final synchronous card creation/update group atomic, not the earlier external work.
- `src/app.ts:10061-10100`: settings validates a patch, reads settings, awaits target resolution, then stamps issue-watch state and writes settings. Preserve current guards and snapshot semantics in the final apply. Remote refresh after the write remains separate.
- `src/app.ts:5556-5580`: project removal refuses active work, removes the in-memory project, closes its store, updates saved paths, and writes global config. Preserve the active-work guard and atomic global config update. Store closure and memory changes are not a cross-store transaction. Project files remain intact.
- `src/jiraRoutes.ts:310-360,390-425,510-590` within the broader `390-615` route interval: Jira search awaits Jira before its last-query write. Jira import awaits Jira before card filing. Preserve per-project board import as one store operation whose transaction rechecks its conditions. Do not combine Jira calls or different project imports into one transaction.

### Watchers and global state

- `src/issues.ts:194-355`: scans read settings and issue rows, await GitHub, and recheck watch settings before filing. Preserve that recheck in the atomic filing apply. GitHub label actions and later label-state writes remain separate.
- `src/forks.ts:640-750,780-1018,1100-1241`: scans read tasks, settings, branch rows, and holds, with GitHub, Git, and model awaits between reads and writes. Combine each database-only branch/hold group and preserve final guards. External analysis remains separate.
- `src/prs.ts:780-975`, especially `780-870,890-975`, and `1080-1269`: PR row sync applies fetched GitHub data. Close checks await GitHub before PR-state writes. Drafts and comments follow external/model work. Preserve daily-cap checks and final guards in store operations without a transaction across review calls.
- `src/ompWatch.ts:330-625`: release review uses npm, GitHub, and model calls before card filing. Combine current synchronous card creation/title updates. Preserve the later global watcher-state write as a separate operation.
- `src/trending.ts:200-390,379-573,550-671`, especially `550-650`: scans read verdicts/settings before remote fetches. Bundle-file creation, task creation/update, and final global scan-state persistence retain distinct effect boundaries. Combine adjacent task database writes and preserve final guards.
- `src/jiraRoutes.ts:150-360`, especially `150-283`: connection save awaits host checks, then reloads current connections and writes the list. Make that post-await reload/update atomic to preserve concurrent saves. Removal reads project settings before the global list write. Preserve that validation without a cross-project/global transaction.
- `src/app.ts:733-750,1733-1755,2026-2059,2709-2764,2946-2947,3361-3362,3561-3565,5730-5732,6295-6296,6415-6418`: global calls cover project paths, seen cards, alerts, subscriptions, trending, OMP-watch, updates, config, and muted projects. Convert each current no-await read/modify/write group into one atomic GlobalStore operation.
- `src/webpush.ts:20-95,145-195`: subscriptions use GlobalStore. Make subscription read/modify/write groups atomic. Network delivery precedes some updates and remains separate, with guarded final subscription changes.
- `src/server.ts:145-250,350-513`: boot opens stores, pins origin after Git reads, and repairs release-version stamps after tag checks. Combine each database-only repair group and preserve post-effect guards. Store open, backup, and snapshot filesystem work remain separate.

### Raw SQL and fixture callers

- `src/backup.ts:1-35,250-395,420-490`; `src/restore.ts:1-125`: snapshots, integrity reads, restore file moves, and store locks require adapter-aware callers. File operations are not task-store transactions. SQLite copy-integrity readers may retain `bun:sqlite`. PostgreSQL backup skip and restore refusal ship in card D.
- `scripts/boot-smoke.ts:225-250,310-330`: raw SQLite PRAGMAs probe lock release. Convert source-database adapters and lock fixtures as required by the driver change. Keep the observable SQLite lock assertions.
- Test-only raw SQL appears in `src/store.test.ts`, `src/login.test.ts`, `src/jiraRoutes.test.ts`, `src/globalStore.test.ts`, `src/backup.test.ts`, `src/restore.test.ts`, `src/dblock.test.ts`, `src/app.test.ts`, and `scripts/demo-data.test.ts`. Convert test-only source adapters and fixtures where they exercise the changed stores. This list does not claim an exhaustive analysis of each fixture's database behavior.
- `src/login.ts:457-515,645-678` accesses omp's independent `agent.db`. It remains SQLite and lies outside ProjectStore/GlobalStore conversion.
- `scripts/update-host.ts:1-55` uses `openLocked` for an independent update-host lock database. It remains SQLite.
- `scripts/compose-memory-proof.ts:175-225` reads the independent Mnemopi database. It remains SQLite.
- `scripts/demo-data.ts:390-430,700-875` directly seeds SQLite tasks/events, sets counters, and repairs timestamps outside a live store lock. This demo source remains SQLite.
- `scripts/card-shot.ts:80-145,280-385` reads task IDs and writes screenshot fixtures with raw SQLite. This source remains SQLite. The README screenshot flow also remains SQLite.

This appendix covers caller-side groups in the cited source and script paths. Store implementation internals, `dblock.ts` internals, and read-only UI consumers need their separate implementation review. No production hard-delete caller appeared in this inventory. Task cancellation changes state. Project removal closes the store and removes its board entry, but retains files and data.
