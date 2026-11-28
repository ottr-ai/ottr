# Worker turn uid isolation: one project, one uid, one turn home

Status: accepted (OTTR-994).

## Problem

On the classic compose pool every turn of every project ran as the worker
daemon's own root uid. All turns shared the container, the pid namespace, the
shared home volume (`home:/root`), `/workspace` and `/data`. `runChildEnv`
gives each turn its project's Settings env values and, for lent providers,
the provider access token. Round-robin dispatch mixes projects in one
container.

A turn of project A could therefore read `/proc/<pid>/environ` and reopen
`/proc/<pid>/fd/1` of a running turn of project B, and could plant files into
the shared home that a later turn of project B loads. The plant vector via
tools link dirs is closed (OTTR-953); the same-uid process and shared-home
surface stayed open. ADR 0009 records the sharing as the classic-pool
limitation that microVM mode removes; this spec shrinks it for deployments
that stay on the classic pool.

## Design

The worker daemon drops each classic turn to a per-project identity. Project
names map to uid/gid pairs deterministically, so every worker of the pool and
every restart computes the same identity for a project. Round-robin dispatch
stays unchanged.

### Identity

- `projectTurnUid(name)`: first 8 bytes of the SHA-256 of the name, mapped
  into `[65536, 65536 + 2^24)`. `gid` equals `uid` (user-private group
  convention). The range starts above `nobody` (65534) so no fixed account
  collides; files on the volumes show these numbers on the host.
- The daemon keeps a name-to-uid map for the container's lifetime. When two
  different names map to one uid, the run logs an error line: those two
  projects share a trust boundary until one is renamed. The 2^24 space makes
  collision unlikely (about 0.003% at 100 projects).
- At turn start the daemon provisions a passwd and group entry for the
  project uid (OTTR-1184): name `ottr-<uid>`, home = the turn home, shell
  `/bin/false`, gecos names the project. Idempotent, fail closed. Project
  names refuse the field separators (`:`, line breaks), so a request name
  cannot shape the appended lines or the pinned gitconfig.

### Soundness rule: root never touches a uid-mutable path

Everything the daemon (root) does below the turn homes stays out of reach of
the turn uid by construction:

- The project level `<root>/<project>` is a root-owned shell holding three
  fixed dirs: `home/` (the only uid-owned, uid-writable subtree, mode 0700),
  `layers/` (root-owned per-project layer copies) and `ottr/` (root-owned
  provisioning target for tools, venv and PATH link dirs). The uid can never
  create, rename or symlink-swap an entry the daemon then chowns, copies or
  follows: a rename would need write permission on the root-owned parent.
- Recursive chowns anchor every operation to a pinned descriptor: the walk
  opens the root once with `O_PATH|O_NOFOLLOW` (atomic path resolution) and
  then lists, opens and chowns strictly through the kernel's
  `/proc/self/fd/N` magic links of the pinned descriptors. The kernel
  resolves a magic link to the exact inode the fd holds, so a same-uid
  rename during the walk cannot redirect a chown or a descent to a file
  outside the tree, and `O_NOFOLLOW` (plus an `fstat` symlink check on each
  opened entry) refuses a symlink as any path part the walk controls. A
  symlink entry is lchowned through its pinned parent (the link itself,
  never the target) and never descended through. Bun omits `O_PATH` from
  its constants, so the walk uses the stable Linux ABI value
  (`010000000`); a kernel without it fails the opens and the run fails
  closed. There is no path-based fallback branch.
- The daemon creates no file below the uid-owned `home` after handoff. The
  per-project cache dirs the layer copy's links name (`<home>/.cache` and
  friends) the turn creates itself, through the link, as its own uid.
- The run's cwd resolves per component from a pinned workspace-root fd with
  `O_NOFOLLOW|O_DIRECTORY`: after a project's first run its project dir is
  uid-owned, so the uid could rename an intermediate dir (`.worktrees`) and
  plant a symlink whose middle part a plain-path open would follow with root
  privilege — handing the root-privileged chown and the run's cwd to another
  project's tree. A symlink or non-dir at any component below the workspace
  root fails the run before any chown; the git dir is anchored the same way.
  Residual: a swap landed after the resolve and before the spawn's `chdir`
  redirects the run only to a directory the uid can already traverse (every
  other project's tree is closed by the same uid and mode rules), so no
  boundary is crossed.
- The pinned layer copy is materialized into a root-owned temp dir beside
  the final name and moved in with one atomic rename, so a half-written or
  attacker-shaped copy can never appear under the final path. The final dir
  is uid-writable in content but its directory entry stays root-owned.

### Per-project turn home

- Root of the turn homes: `OTTR_TURN_HOMES`, default `/turn-homes`. Compose
  mounts the new `turn-homes` volume there so per-project caches survive a
  worker recreation; the daemon creates the dir itself when the volume is
  absent, so the feature works without a mount.
- Provisioning installs into `<root>/<project>/ottr`: tools, the python venv
  and the PATH link dirs. They stay root-owned and world-readable; a turn
  reads and executes them and never writes them (its ad-hoc installs go to
  its own home). Apt packages stay global (root-only install).
- When the request env carries no agent-layer pin, the spawn's `HOME` is
  `<root>/<project>/home`, and the daemon links the flat identity into it:
  `.omp` (config, agent dir, store, plugins, logs) always, plus
  `.gitconfig`, `.config`, `.ssh` and `.claude` when the flat home has them.
  Root creates a link only when the entry is missing; an entry a turn
  planted stays, and a planted link only redirects the turn's own reads.

### Pinned agent layer

The pin (`src/layers.ts`) resolves the shared home's `current` layer and puts
`HOME=<layer dir>` into the request env. One layer serves every project of
the stack, so the layer dir itself cannot be owned by one project's uid.
Instead the daemon materializes a per-project copy:

- At `/run`, when the request env's `HOME` resolves to
  `<shared home>/.alate/layers/<id>` (same shape check as `pinTarget`), the
  daemon copies the layer to `<turn home>/layers/<id>` as above. The copy
  keeps the shared-state links of the pin (`agent.db`, `sessions`, `oauth`,
  `logs`) pointed at their flat shared-home targets.
- The per-project cache links (`.cache`, `.npm`, `.bun`, `.local`) are
  retargeted into `<turn home>/home/<name>` when they exist as links into
  the shared home. Caches therefore stop being a cross-project plant and
  write surface, and the turn's ad-hoc `pip --user` flow (target
  `$HOME/.local`) keeps working under the project uid.
- The copy is chowned recursively to the project uid (fd-pinned, symlinks
  via lchown) and gets mode `0700` on its top dir. The request env's `HOME`
  and `PI_CODING_AGENT_DIR` are rewritten to the copy.
- A pinned layer that vanished between dispatch and `/run` fails the run
  with a clear error. A `HOME` that does not resolve inside the layers tree
  is treated as unpinned (planted-pointer refuse, as `pinTarget` does).
- Every start marks its pinned id in use (`<id>.inuse` beside the copy, in
  the root-owned layers dir; the marker's mtime is the signal both workers
  read on the shared volume). The marker gains one `<token> <iso>` line per
  live run, and the run releases its own line when its child closes: the
  line goes under the same lock, and the marker file goes when no live line
  remains. The mark, the release, the prune's read-decide-delete, and the
  reuse check run under the same shared layers lock the lease ledger
  uses (`in-use.lock`, SQLite POSIX locks, dropped on holder death), so a
  refresh on one worker can never interleave with a deletion on the other.
  The mark is fail closed: a start whose marker cannot be written fails
  before the spawn, and that start deletes nothing. A start that cannot
  take the lock within its budget fails the same way; a release that
  cannot never throws and keeps the copy protected. Copies other than the
  current pin and copies whose marker is fresh are pruned at once on the
  next copy for that project — independent of the copy's age and of
  whether alate still holds the source layer. Temp dirs, and markers whose
  holders are all gone (a dead holder's line stays fresh only until its
  last write ages past the window), age out after a day, so retention
  stays bounded (OTTR-1179).

### Project on the request

The run's project rides the `/run` request as `project`, set by the board on
every dispatch from the run's project store. The turn env strips
`OTTR_PROJECT` for retro and proposal runs; the request field keeps their
per-project identity. A request with neither `project` nor `OTTR_PROJECT`
(the direct-API case) keeps the legacy identity and is a documented
exposure, not a silent downgrade of a board dispatch.

### Workspace and task data

- Before the spawn, the daemon chowns the run's cwd tree and the project's
  git dir (`<workspaceRoot>/<project>/.git`, the board's own layout) to the
  project uid, so git writes (index, objects, worktree files) work under the
  uid. The project dir under the workspace root gets the project uid and
  mode `0700`, so a turn of another project cannot traverse into this
  project's checkout or worktrees. The daemon never follows the worktree's
  planted `.git` pointer for the chown: it derives the git dir from the
  board layout, and a cwd outside the workspace root, or a project without a
  git dir, fails the run (fail closed).
- At boot, the daemon walks `/workspace` and `/data` (the compose mount
  points) and gives every project dir the project uid and mode `0700`. Per
  run, `/data/<project>` is chowned as a whole tree, so the turn's session
  writes (`/data/<project>/sessions`) succeed beside the files the server
  wrote as root. The server keeps its root access to both volumes.

### Shared home

The flat shared home stays the stack's credential store and layer tree. The
daemon prepares it once per boot, root-only:

- `chmod 0711` on the shared home: turn uids can traverse to the flat link
  targets but cannot list or create entries there.
- `.omp/agent` becomes sticky `1777` (sqlite creates its journal and wal
  beside the store), and `.omp/agent/sessions` plus `.omp/logs` become
  sticky `1733`: every uid can create its entries, no uid can list or read
  another uid's entries by path, and a sticky dir keeps each uid to its own
  files.
- `.omp/agent/agent.db` gets `a+rw`, but only when it is not a mount point
  (the daemon reads `/proc/self/mountinfo`). The boot also gives `a+rw` to
  the existing `agent.db-wal` and `agent.db-shm` siblings. Each of the
  three entries carries its own checks: any one of them can be its own
  bind mount, and a chmod through one would change that host file's mode.
  Each of these chmods runs through a pinned fd: the boot opens the entry
  with `O_NOFOLLOW|O_NONBLOCK` and runs `fchmodSync` through it, so a swap
  between the check and the chmod cannot redirect the chmod, and a FIFO
  swapped into the entry cannot block the open. The boot fstats the pinned
  descriptor and chmods only a plain file. A store sibling that is not a
  plain file gets no chmod: the boot logs a note and leaves the mode. The
  compose store is a host bind mount, and a chmod through it would change
  the host file's mode; the boot logs a note per mounted entry instead and
  leaves the mode to the host. The residual: a turn-side store write (a
  credential refresh of a non-lent provider) fails on such a deployment
  with the cause omp reports; lent providers and env keys are unaffected.
- Before each turn spawns as the turn uid, the daemon restores the
  shared-store modes (`src/turnUid.ts`). It resolves the turn's store path
  through the layer links. A planted pointer whose resolution does not
  name the trusted shared store `<workerHome>/.omp/agent/agent.db` fails
  the run. The daemon walks the trusted chain and checks the uid access
  bits on each entry. The chain holds the worker home traversal bit, the
  `.omp/agent` dir, and the `agent.db` file with its `agent.db-wal` and
  `agent.db-shm` siblings. A store entry that is a symlink or not a plain
  file fails the run: a turn can plant `agent.db-wal` or `agent.db-shm`
  in the sticky `1777` dir. Before each chmod the daemon pins the entry's
  inode: it opens the entry with `O_NOFOLLOW|O_NONBLOCK` (plus
  `O_DIRECTORY` for a dir), fstats the descriptor, and runs `fchmodSync`
  through the fd only when the pinned inode is a plain file or dir. A
  FIFO swapped into the entry between the stat and the open cannot block
  the open, and a same-uid swap cannot redirect the chmod. A drifted
  entry gets the boot table's mode (home `0711`, agent dir `1777`, store
  files `0666`), and the run logs one `turn-uid:` drift line. The daemon
  chmods only entries of the trusted chain. It never chmods a mounted
  entry that blocks the uid, because a chmod through the mount would
  change the host file. The run refuses to start, and the board parks
  the card `needs_you` with a reason that names the file and the host
  fix.
- BuildKit client material (`/certs/buildkit/client/*`, the CA) is root-only
  `0400` in the image ("workers run as root"); the boot gives the turn uids
  a read (`0644`), because a build turn needs the client key when the build
  profile is on. The key authorizes image builds, which every turn of the
  pool could run before; the container-internal exposure class is unchanged.

- At boot, when root, the daemon raises its soft RLIMIT_NPROC toward the
  hard cap (floor 4096) so turn uids can fork (OTTR-1184); it logs a
  `turn-uid:` note. An unavailable setrlimit degrades to that note.

### Root cause: root omp re-enforces owner-private modes

The omp binary (`/usr/local/bin/omp`, package
`@oh-my-pi/pi-coding-agent`) enforces owner-private agent dirs. Its bundle
(`/usr/local/bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`)
holds the evidence. Two greps show it:

- `rg -o ".{200}Owner-private dir chmod failed.{80}" <bundle>`: omp runs
  `mkdirSync(dir, {recursive:true, mode:448})` (`448` = `0o700`), fstats
  the dir, and runs `fchmodSync(r,448)` when `(i.mode&511)!==448`. So omp
  chmods an existing dir to `0700` again, and the error log names
  "Owner-private dir chmod failed".
- `rg -o "mkdirSync\(.{0,120}" <bundle> | rg agent`: the store open path
  runs `mkdirSync(NVr.dirname(e),{recursive:!0,mode:448})` directly before
  the sqlite `agent-storage` open. omp writes store-side files there with
  `mode:384` (`0o600`).

So any omp process that opens an agent storage resets its dir to `0700`
and writes new files there with `0600`-class modes.

Proved facts about the callers in this repo:

- The shared home volume `home:/root` (docker-compose.yml line 635 defines
  it) is mounted by the classic workers (line 58), the server (line 178),
  the home-repair repair service (line 554) and alate (line 596, it
  provisions the agent layer). One more mount is read-only
  (`home:/root:ro`, line 498) and cannot change modes.
- The board's own omp calls do not use the shared home. `boardOmpEnv()`
  (src/login.ts:385) sets `HOME` to the pinned agent layer or to
  `boardOmpHome()` (`OTTR_BOARD_OMP_HOME`); docker-compose.yml pins
  `OTTR_BOARD_OMP_HOME` to `/etc/ottr/home` (line 265) and
  `PI_CODING_AGENT_DIR` to `/etc/ottr/home/.omp/agent` (line 255), the
  server-only board store. `omp models`, `omp auth-gateway` and the
  `omp usage` watch probes all take their env from `boardOmpEnv`
  (src/models.ts:30, src/forkAnalysis.ts:347, src/quota.ts). Server-side
  turn spawns use `boardOmpEnv` as their env base too
  (src/runner.ts:2124-2131). The board's flows never reset the shared
  store.
- Turn-side omp runs as the project uid. Its owner-private re-chmod of the
  root-owned shared dirs fails with `EPERM` and cannot reset the modes.
- The repo's automated flows hold no root omp call against the shared
  home. The worker daemon spawns omp only for turns, and each turn spawn
  drops to the project uid. The entry script `docker/ottr-entry.sh` runs
  no omp; its repair mode only removes a wrong `agent.db` folder.
  `GET /signins` reads the store with `bun:sqlite` directly
  (`signIns`, src/login.ts:482).

Inference (not a proved fact): the outage's
`/root/.omp/agent/models.db` mtime `15:56:18 UTC` shows that a root omp
process opened the shared store then. The remaining callers sit outside
the repo's automated paths: an interactive root session in a worker or
server container runs omp. It arrives through `docker exec` or a compose
run with the default `HOME`. Any such run resets the modes, so the per-turn restore
makes the whole caller class harmless.

The 2026-11-25 outage showed `.omp/agent` at `0700` root, and `agent.db`
plus `agent.db-wal` at `0600`. The first failing turns started at `15:51`.
This is the same class as the 2026-11-21 outage (OTTR-1179). Hardening at
boot time alone cannot survive the next root omp call. The design
therefore adds the per-turn restore.

### Spawn

`startRun` spawns omp with `uid` and `gid` of the project and the rewritten
env. The feature is active only when the daemon runs as root; otherwise the
daemon keeps today's behavior (dev setups). Any identity step that fails
fails the run with the cause (fail closed): no silent fall-back to a root
turn. The spawn env strips inherited `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
identity vars (OTTR-1184): env ident vars beat every git config scope. The
env points `GIT_CONFIG_GLOBAL` at a daemon-owned gitconfig in the turn
home's provisioning dir whose `[user]` pins the project identity
(`<project> turn` / `ottr+<project>@localhost`, a slug replaces unsafe
chars) as the fallback. The include of the turn home's own `.gitconfig`
sits after that section, so a configured turn-home identity keeps winning
(OTTR-693), and repo-local config wins over both.

### Server side

Merge agents stay on the board host. A root board starts each merge agent
with the same project uid and gid as its work turns. The agent reads a
fresh, protected configuration view from the board's trusted home or layer.
It never loads configuration from worker turn homes or project layer copies.
See [Merge turn project uid](merge-turn-uid.md).

The board's Git operations retain the board uid. On a root board, Git
must accept the project-owned checkout. The entry script's board gitconfig
(`GIT_CONFIG_GLOBAL`, server-only env) therefore keeps `[safe] directory = *`.
Other local agent kinds retain their current identity.

## Error cases

- Daemon not root: identity steps are skipped, one boot log line says so, and
  turns run exactly as today.
- Turn-home root not creatable or not writable: the run fails with the cause.
- Layer copy source missing: the run fails with the layer id in the message.
- Chown or copy failure: the run fails with the cause; the temp copy is
  removed on the next run's stale sweep.
- A mounted store whose mode blocks the turn uid: the run refuses to
  start. The daemon chmods nothing through the mount. The card parks
  `needs_you` with the file name and the host fix in the reason.
- A planted store link, or a store entry that is not a plain file: the run
  refuses to start. The reason names the entry, and nothing is chmodded.
- A run cwd outside the workspace root, or a project dir without a git dir:
  the run fails with the cause.
- Uid collision between two project names: logged per run; both projects
  share a trust boundary until one is renamed.
- An unrelated account already holding the hashed uid or gid (OTTR-1193):
  the run fails closed; the operator frees the id or renames the project.
- Passwd or group write failure, or a gitconfig write failure: the run
  fails with the cause.
- Fork-capacity raise failure: a boot note only; the daemon keeps serving.

## Acceptance checks

- `projectTurnUid` is deterministic and in range; `gid === uid`; distinct
  names hash to distinct values for a fixed example set.
- The env rewrite swaps `HOME`/`PI_CODING_AGENT_DIR` to the per-project
  layer copy, retargets the cache links without creating the cache dirs, and
  sets `HOME` to the turn home (with the flat `.omp` link) when no pin is
  present. Property test: for arbitrary names and homes the mapping is in
  range and deterministic; the rewrite is a no-op on an env without a pinned
  `HOME`.
- A spawn under the feature runs with the project uid (observable with `id
  -u`), and a process of project A's uid cannot read `/proc/<pid>/environ` of
  a process of project B's uid (live smoke).
- After `prepareRunWorkspace`, the cwd, the project git dir and the project
  top dir are owned by the project uid with mode `0700`; a symlink planted
  in the tree is lchowned and its target is untouched; a cwd outside the
  workspace root fails the run.
- The rename race has a regression test in the blocker's order: the root is
  pinned by fd first, then renamed twice with an impostor directory planted
  at each old path before the walk runs; the fd-anchored walk chowns the
  pinned inode's children and never touches either impostor's files, and a
  symlink as the walked root fails the run. A path-based walk (the old
  `readdirSync(path)`/`join` form) fails this test because it chowns the
  first impostor's files.
- A planted `.worktrees` or `.git` symlink below the workspace root fails
  the run before any chown, and a victim tree outside the project stays
  untouched.
- The turn home shell is root-owned; the layer copy reuses an existing final
  dir and prunes copies of deleted layers. A copy whose source is gone from
  the starting worker's home survives when a fresh `<id>.inuse` marker says
  a started turn still runs on it (worker homes disjoint from the pinned
  id), and the copy's omp state stays writable through its link mid-run;
  once the marker ages out a day, the next copy reclaims the copy and its
  marker under the decision lock, so retention stays bounded. A start whose
  marker cannot be written, or whose decision lock stays busy, fails closed
  and deletes nothing.
- A provisioned uid's `id -un` prints the entry name.
- `git var GIT_AUTHOR_IDENT` exits 0 under the project uid with the project
  identity, a fixture's repo-local identity still wins over the turn
  identity, and a configured turn-home `.gitconfig` identity wins over the
  project fallback.
- A child under the project uid forks twelve parallel processes.
- A fixture with a `0700` agent folder and a `0600` store file starts a
  turn, and the turn opens the store. Before the fix, this check fails.
- A mounted store that the uid cannot open refuses the run. The reason
  names the file and the host fix, and omp does not start.
- A planted `agent.db-wal` symlink in the shared agent dir (or a
  turn-retargeted store link) refuses the run, and the link's target keeps
  its mode.
- `bun run check` and `bun test` pass.

## Alternatives considered

- One container per turn (the microVM or a per-turn compose service): the
  ADR 0009 route, strongest isolation, needs KVM or a second orchestrator.
  Out of scope here; this spec only shrinks the classic pool's surface.
- Per-project mount namespace via `unshare -m`: needs `CAP_SYS_ADMIN`, which
  the compose worker deliberately does not hold.
- Group-based separation (per-project gid, shared root uid): leaves the
  same-uid procfs read open, which is the claimed vector.
- chmod hardening of the shared home without uids: root turns read and write
  everything regardless of file modes; no boundary.
- A path-based recursive chown (`chownSync` after `lstat`, `readdirSync` by
  path, or `chown -R`): a same-uid rename or symlink swap between the walk's
  read and the chown could redirect a root chown to a file outside the tree,
  because `O_NOFOLLOW` guards only the last part of a path. Rejected for the
  `/proc/self/fd`-anchored walk above, which pins every directory it lists.

## Risks

- `chownTree` is one `open`/`fchown`/`close` per file, and the copy, chown
  and provision steps run synchronously in the daemon's fetch handler: a
  large checkout or a fresh layer copy blocks the other live streams for
  seconds. Bounded, per run, and visible on the card's dispatch time; an
  async refactor is future work.
- Host-side tooling sees uid numbers on volume files; backups run as root on
  the server and are unaffected.
- The credential store stays one shared file per stack; a turn can still
  read (and, where the store is not a host mount, also write) `agent.db`.
  This matches today's exposure for root turns and is the documented
  classic-pool residual until microVM mode.
- The oauth dir is a read-only host mount; host file modes may deny reads to
  non-root uids. Provider auth in turns rides lent tokens, store rows or
  Settings env keys; a provider that needs the oauth cache mid-turn would
  fail with a clear provider error.
- A same-uid turn of the SAME project can still read its sibling's env: one
  project is one trust domain, by definition here.
- `/tmp` stays shared (sticky); scratch files keep their creator's uid.
- The cache dirs inside a turn home are created by the turn through the
  layer copy's links; a tool that writes a cache file without creating the
  dir first would need the dir seeded (none is known today).

## Non-goals

- No network isolation between turns (separate card).
- No change to the VM runner path: the guest already drops to `nobody`.
- No per-turn containers, no KVM requirement, no new orchestrator.
- No change to the board home (`board-config`) boundary or to the lists
  isolation of OTTR-953.
- No credential store split per project.
- No async (off-event-loop) form of the identity steps.
