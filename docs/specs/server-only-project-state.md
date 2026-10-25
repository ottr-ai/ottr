# Server-only project state (OTTR-180)

## Problem

In compose, every worker mounts the `ottr-data` volume (`/data`) read-write. Before this
change, the board kept each project's `tasks.db` there (`/data/<project>/tasks.db`). The
board trusts that database:

- Project settings hold `releaseCommand`. `src/release.ts runReleaseCommand` runs it in the
  server process, with the server env (GH_TOKEN, per-host git tokens).
- Task rows hold `worktree`, `branch` and `base`. The board uses them as paths and refs for
  git, quarantine and worktree removal.

The fork mirror cache (`/data/<project>/forks/<id>.git`) was on the same volume. Its git
config (fetch config, `core.*`, credential helpers) was thus worker-writable, and the
board runs `git fetch` in it. The neutral cwd of the fork `ls-remote` call was the same
worker-writable dir, so a planted `.git` there could also give config to that call.

## Behavior

1. New env setting `OTTR_SERVER_DATA_DIR`: the root of the server-only project state.
   Compose sets it to `/app/.tasks/projects`, on the `ottr-state` volume, which no worker
   mounts.
2. `serverDirFor(projectPath)` in `src/store.ts`:
   - `OTTR_SERVER_DATA_DIR` set: `<OTTR_SERVER_DATA_DIR>/<folder name>`.
   - Not set: `tasksDirFor(projectPath)` (the layout before this change).
3. `ProjectStore.serverDir` holds that path. These files live there:
   - `tasks.db` (all tasks, turns, settings and fork rows), with its `-wal` and `-shm`.
   - The fork mirror cache: `<serverDir>/forks/<fork id>.git`.
   - The cwd of the fork `ls-remote` call (`listBranchHeads`).
4. `ProjectStore.tasksDir` (`tasksDirFor`) keeps the data that workers need or that the
   board only shows: `sessions/`, `logs/`, `images/`, `handoffs/`, `quarantine/`,
   `release-<task>.md` and the project icon. No change there.
5. `discoverProjects` finds a project only when `<serverDir>/tasks.db` exists. A
   `tasks.db` that a worker writes below `OTTR_DATA_DIR` makes no project.
6. `childEnv` (src/runner.ts) removes `OTTR_SERVER_DATA_DIR` from every turn env, as it
   removes `OTTR_DATA_DIR`.
7. Boot (src/server.ts): when `OTTR_DATA_DIR` is set and `OTTR_SERVER_DATA_DIR` is not,
   the board logs one warning: the task DB stays on the shared volume.

## One-time adoption of existing databases

`adoptSharedProjectData(dataDir, serverDataDir)` in `src/store.ts`. `src/server.ts` calls
it at boot before `discoverProjects`, only when both `OTTR_DATA_DIR` and
`OTTR_SERVER_DATA_DIR` are set.

1. When the marker file `<serverDataDir>/.adopted` exists, do nothing. Return no results.
2. Else, for each entry `<name>` in `dataDir`:
   - Skip it unless `lstat` shows a real directory (not a symlink), and
     `<dataDir>/<name>/tasks.db` is a regular file (`lstat`, not a symlink).
   - Skip it when `<serverDataDir>/<name>/tasks.db` exists already.
   - Open the old DB with `openLocked`. A `StoreLockedError` goes up to the caller: a
     second live board must stop the boot, as for `ProjectStore.open`.
   - `VACUUM INTO <serverDataDir>/<name>/tasks.db.adopting` (remove an old temp file
     first).
   - Compare `COUNT(*)` of `tasks` and `turns` in the old DB and in the copy. A mismatch
     is a failure.
   - Rename the copy to `tasks.db` (same volume: atomic).
   - Close the old DB with `closeLocked`, then rename it to
     `tasks.db.moved-to-server`. The board never reads this file again. The code
     deletes no tracker data. The operator can delete the file.
3. One failure (corrupt DB, count mismatch, I/O error) does not stop the others. The
   result names each project as `adopted` or `failed` with the error text. The boot
   logs each result.
4. After the loop, write the marker, also when a project failed. Thus a `tasks.db` that a
   worker writes later is never adopted. A failed project stays off the board, and the
   log names it. The operator moves it by hand (see docs/WORKERS.md).

## Boundaries and error cases

- No `OTTR_SERVER_DATA_DIR` (native start, scratch boards, tests): layout as before.
  Local turns run as the board user, so a shared volume does not exist there.
- `OTTR_SERVER_DATA_DIR` without `OTTR_DATA_DIR`: the DB goes to the server dir. No
  adoption (no shared data dir to read).
- Old fork caches at `/data/<project>/forks/` stay unused. The next fork run makes a new
  cache in the server dir.
- The adoption copies the old DB as it is. A value that a worker wrote before the
  upgrade comes with it. The docs tell the operator to check `releaseCommand`.

## Acceptance checks

- With both env settings set, a store keeps `tasks.db` below `OTTR_SERVER_DATA_DIR`.
  Logs and sessions stay below `OTTR_DATA_DIR`.
- A worker that writes a `tasks.db` with a `releaseCommand` into
  `/data/<project>/tasks.db` (or rewrites every file below the data dir) does not change
  the `releaseCommand` that a reopened store returns.
- A planted `/data/<name>/tasks.db` with a checkout `<root>/<name>` gives no discovered
  project.
- Adoption moves a legacy DB with its settings, renames the old file, and writes the
  marker. A second call after a new plant adopts nothing.
- The fork cache path and the `ls-remote` cwd are below `store.serverDir`.
- `childEnv` removes `OTTR_SERVER_DATA_DIR`.
- docs/WORKERS.md describes the boundary.

## Non-goals

- Symlink-safe server writes below the shared data dir (logs, handoffs, quarantine,
  release notes, icons). OTTR-172 covers them.
- Trust in session files. omp writes them on workers, and later turns resume them. This
  is by design: a merge turn takes in the work turn's output.
- A read-only `/data` mount for workers. omp on a worker must write sessions there.
