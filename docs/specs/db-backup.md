# Database backups (OTTR-790)

## Problem

The board keeps all cards, turns, settings and tokens in SQLite files: `.tasks/tracker.db`
(the global store) and one `tasks.db` for each project. In compose, all of them are on the
`ottr-state` volume. No copy exists. A lost volume or a corrupt file loses all cards,
history and settings (OTTR-736, topics 83 and 84).

## Behavior

### Snapshots

1. A snapshot is one directory `<backup dir>/<stamp>/`. `<stamp>` is the UTC time of the
   run as `YYYYMMDDTHHMMSSZ`, for example `20261110T031500Z`. It holds:
   - `tracker.db`: a copy of the global store.
   - `projects/<project name>/tasks.db`: a copy of each project database that the board
     has open.
   - `snapshot.json`: the manifest. It lists the files that the snapshot holds (`copied`)
     and each database whose copy failed, with the error text (`failed`).
2. The board makes each copy with `VACUUM INTO` on its own open connection. The
   connection holds the file with an exclusive lock, so no second process can read it.
   After the copy, the board compares the row counts of the main tables (`kv`, or `tasks`
   and `turns`) and runs `PRAGMA integrity_check` on the copy. A difference is a failure.
3. The board writes a snapshot into `<stamp>.partial/` and renames it to `<stamp>/` after
   the last copy and the manifest. Thus the write of a directory with a stamp name is
   always finished, and its manifest says which databases it does not hold. A run removes
   each `*.partial` directory that an earlier run left.
4. One database that fails does not stop the others. The snapshot then holds the copies
   that passed, and it is incomplete. The board logs each failure with the file name and
   the error text.
5. A project whose `tasks.db` the board did not open at boot (a corrupt file) stays off
   the board. Each backup run counts it as a failed database with the open error, until a
   project with that name is open. Without this rule, the snapshots would omit the
   project with no failure, and retention would remove its last good copy.
6. A snapshot with no good copy is not kept: the board removes its `.partial` directory,
   and the next tick tries again.

### Schedule

1. The board examines the backup dir at boot and then each hour. It makes a snapshot when
   no snapshot exists or when the newest snapshot is 24 hours old or older.
2. `VACUUM INTO` runs in the server process and blocks it for the time of the copy.

### Retention

1. After a snapshot in which all databases passed, the board keeps the newest
   `OTTR_BACKUP_KEEP` snapshots and removes the older ones. The default is 7.
2. A snapshot with a failed database removes nothing. Thus the last good copy of that
   database stays.
3. Retention removes only directories whose name is a valid stamp. All other entries in
   the backup dir stay.
4. `OTTR_BACKUP_KEEP=0` turns the backups off. A value that is not an integer of 0 or more
   is an error: the board logs it and uses the default.

### Location

1. `OTTR_BACKUP_DIR` names the backup dir. When it is not set, the dir is
   `<state dir>/.tasks/backups` (next to `tracker.db`).
2. Compose mounts the volume `ottr-backup` at `/backup` in the server only, and sets
   `OTTR_BACKUP_DIR=/backup`. `OTTR_BACKUP_MOUNT` in the compose env file replaces the
   volume with a host path, for example a path on a second disk.
3. A snapshot holds the same tokens and keys as `tracker.db`. With a worker boundary
   (`OTTR_DATA_DIR` set), the board refuses an `OTTR_BACKUP_DIR` that is equal to or below
   a worker-mounted root (the project roots, `OTTR_DATA_DIR`, the home dir). It logs one
   error at boot and makes no backups. The default dir is next to `tracker.db` and is as
   open as that file, so the board never refuses it.
4. `childEnv` (src/runner.ts) removes `OTTR_BACKUP_DIR` from each turn env. A turn that
   starts a scratch board (ottr's own test suite, the boot smoke) must not write into the
   live backup dir or remove live snapshots.

### Restore

`bun src/restore.ts` is the restore tool. It is in the image (`/app/src/restore.ts`).

1. With no argument, it lists the snapshots, newest first, with the files of each and
   their sizes in bytes. A line of an incomplete snapshot ends with `; incomplete:` and
   the databases that failed, or `no valid snapshot.json`. It changes nothing.
2. With `latest` or a stamp, it restores that snapshot:
   - `tracker.db` goes to `<state dir>/.tasks/tracker.db`.
   - `projects/<name>/tasks.db` goes to `<OTTR_SERVER_DATA_DIR>/<name>/tasks.db`, or to
     `<OTTR_DATA_DIR>/<name>/tasks.db` when only that is set.
   - With none of the two set, a project database lives in its checkout, and the tool
     cannot find the checkout from the name. It restores `tracker.db` and prints one line
     for each project database with the snapshot file to copy to
     `<checkout>/.tasks/tasks.db`.
3. Before it replaces a file, the tool opens each target that exists with the board's
   exclusive lock. When a live board holds one of them, the tool stops and replaces no
   database. A target that does not open for a different reason (a corrupt file) does not
   stop the restore.
4. For each file, the tool copies the snapshot file to `<target>.restoring` and runs
   `PRAGMA integrity_check` on the copy. A copy that fails the check is an error for
   that file, and the target stays as it was.
5. The tool deletes no data. It renames a target that exists, and its `-wal` and `-shm`
   files, to `<file>.before-restore-<stamp of the restore time>`. Then it renames the
   checked copy to the target.
6. When `OTTR_SERVER_DATA_DIR` is set, the tool writes the adoption marker
   `<OTTR_SERVER_DATA_DIR>/.adopted` if it is missing. Thus the restored board does not
   adopt a `tasks.db` that a worker wrote into the shared data dir
   (docs/specs/server-only-project-state.md).
7. The tool reads the manifest of the snapshot. Each database that the manifest names as
   failed, and each file that the manifest lists but the snapshot does not hold, is a
   failure of the restore. The error line names the newest other snapshot that holds a
   copy and the path of that copy, or says that no snapshot holds one. A snapshot with no
   valid manifest gives one failure: the tool cannot prove that it is complete. In each
   of these cases the tool still restores the files that the snapshot holds.
8. The exit code is 0 when the manifest proves the snapshot complete and all its files
   went to their targets or to a printed manual line. It is 1 for each other result, with
   the reason on stderr.

A snapshot does not hold the SSH keys (`OTTR_SSH_DIR`), the Jira sealing key
(`.tasks/secret.key`, when `OTTR_SECRET_KEY` is not set), the fork mirror caches, or the
task data on the shared volume (sessions, logs, images, handoffs). docs/WORKERS.md tells
the operator what to do for each.

## Code contract

`src/dblock.ts`:

    vacuumInto(db: SQLiteDatabase, dest: string, tables: readonly string[]): Promise<void>

`VACUUM INTO dest`, then the row-count compare for `tables` and `PRAGMA integrity_check`
on the copy. It throws on a difference. `dest` must not exist.

`ProjectStore.backupTo(dest: string): Promise<void>` and `GlobalStore.backupTo(dest: string): Promise<void>`
call it on the store's own connection. Each caller awaits the snapshot before it writes the manifest.

`src/backup.ts` (no import of `src/store.ts`: the caller passes the sources):

    formatStamp(at: Date): string
    parseStamp(name: string): Date | null        // null unless `name` is a canonical stamp
    listSnapshots(dir: string): string[]         // finished snapshots, newest first
    resolveBackup(env, stateDir: string, workerRoots: readonly string[]):
      { dir: string; keep: number; errors: string[] }
    type BackupSource = { file: string; backupTo: (dest: string) => Promise<void> }
    backupSources(tracker: { backupTo(dest: string): Promise<void> },
      projects: Iterable<{ name: string; backupTo(dest: string): Promise<void> }>,
      unopened?: Iterable<{ name: string; error: string }>): BackupSource[]
      // files `tracker.db` and `projects/<name>/tasks.db`: the layout that restore reads.
      // Each `unopened` project is a source that throws with its open error.
    SNAPSHOT_MANIFEST = "snapshot.json"
    type Manifest = { copied: string[]; failed: { file: string; error: string }[] }
    readManifest(dir: string, stamp: string): Manifest | null
      // null when the file is missing or not valid (a file name that is not a relative
      // path inside the snapshot makes the whole manifest not valid)
    backupDue(dir: string, now: Date): boolean
    runBackup(o: { dir: string; keep: number; now: Date; sources: BackupSource[] }):
      Promise<{ stamp: string | null; copied: string[];
        failed: { file: string; error: string }[]; pruned: string[] }>
    backupTick(o: { dir: string; keep: number; now: Date;
      sources: () => BackupSource[]; log: (line: string) => void }): Promise<void>
    restoreSnapshot(o: { dir: string; stamp: string; now: Date; trackerDb: string;
      projectDbFor: (name: string) => string | null; adoptedMarker: string | null }):
      Promise<{ restored: { file: string; to: string }[]; manual: { file: string; from: string }[];
        failed: { file: string; error: string }[]; movedAside: string[] }>

`resolveBackup` returns `keep: 0` and one error when `OTTR_BACKUP_DIR` is not safe. `backupTick`
never throws: it does nothing when `keep` is 0 or no snapshot is due, and it reports the
result and each failure through `log`.

`src/restore.ts` holds `runRestore(args: string[], env): Promise<{ code: number; out: string[];
err: string[] }>` and the `import.meta.main` entry that awaits the result before it prints.

## Boundaries and error cases

- The backup dir is not writable: the tick logs the error and tries again at the next
  hourly tick.
- The board stops during a snapshot: the `.partial` directory stays, and the next run
  removes it. No directory with a stamp name is half written.
- A project that is not on the board any more (the user removed it, or its `tasks.db` is
  missing, so discovery does not find it) gets no new copy and no failure. Retention
  removes its old copies after `OTTR_BACKUP_KEEP` days.
- While a database fails, retention removes nothing, so the backup dir grows by one
  snapshot each day. The server log names the failure at each run.
- Two snapshots in the same second: the second run fails with an error and leaves the
  first snapshot as it is.
- A stamp argument of the restore tool that is not a snapshot in the backup dir: exit
  code 1, no change.
- An empty new board also makes snapshots. After a loss of the state volume, restore
  before `OTTR_BACKUP_KEEP` days go by, or retention removes the good snapshots. When
  the empty board made a snapshot, `latest` is that empty snapshot: the operator gives
  the stamp of an older one. The sizes in the list show which snapshot is empty.
- A backup on the same disk as the state does not protect against a lost disk or host.
  The docs tell the operator to mount a second disk or to copy the backup dir off the
  host.

## Acceptance checks

- A snapshot of a live `ProjectStore` and `GlobalStore`, restored into an empty state dir
  and server data dir with the restore tool, gives the same tasks, turns, project
  settings and global keys when the stores open again, and `discoverProjects` finds the
  project. This test uses the real stores, not a stub.
- A second run inside 24 hours makes no snapshot. A run at 24 hours makes one.
- With `keep` 2, the third good snapshot removes the oldest. A foreign entry in the
  backup dir stays. A snapshot with a failed source removes nothing.
- A real `ProjectStore.open` on a corrupt `tasks.db` throws. With that project as an
  `unopened` source and `keep` 1, the next run reports the database as failed, removes
  nothing, and the last good copy still opens.
- After a complete snapshot and then a snapshot in which a project copy failed, the
  restore tool with `latest` gives exit code 1, names the database and the older snapshot
  with its copy on stderr, and marks the snapshot as incomplete in the list.
- A snapshot with no valid manifest, and a snapshot that does not hold a file of its
  manifest, each give a failure of the restore.
- The restore tool stops with no change while a store holds a target. It renames an
  existing target and never deletes it.
- `resolveBackup` refuses an `OTTR_BACKUP_DIR` below a worker root, accepts the compose
  layout (`/backup` with roots `/workspace`, `/data`, `/root`), and never refuses the
  default dir.
- `childEnv` removes `OTTR_BACKUP_DIR`.
- Property tests: `parseStamp(formatStamp(t))` gives `t` in whole seconds, each name
  that `parseStamp` accepts formats to itself, retention keeps each entry that is
  not a stamp, a valid manifest reads back as written, and arbitrary manifest text never
  throws and never gives an unsafe file name.
- README and docs/WORKERS.md describe the settings, the snapshot layout and the restore
  steps for compose and for a native start.

## Non-goals

- A copy to a remote store (S3, rsync). The operator mounts or copies the backup dir.
- Encryption of the snapshots. They are as plain as `tracker.db` (README, token storage).
- A backup of the SSH keys, the Jira sealing key, the fork caches, or the task data on
  the shared volume.
- A Settings UI for the backups, or a board view of the last snapshot.
- A restore from the board UI.
