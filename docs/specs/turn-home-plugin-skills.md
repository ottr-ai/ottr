# Turn home plugin skills: board turns load provisioned plugin skills, never worktree code

Status: draft (OTTR-786 P1). Evidence: OTTC-30 (2026-11-10 architecture review) reported
"The ponytail-audit skill is not on this runner. I used only the codebase-design lens"
while the skill ships on both workers at
`/root/.omp/plugins/node_modules/@dietrichgebert/ponytail/skills/ponytail-audit`,
enabled in `/root/.omp/plugins/omp-plugins.lock.json`.

## Problem

Since d7cab13 (2026-11-02), `buildOmpArgs` in `src/runner.ts` passes `--no-extensions`
to every board-spawned run. omp reads the flag as "disable extension discovery": no
plugin loads, so a plugin's skills do not load either. Every review loses the
ponytail-audit lens that `src/prompts.ts` (`reviewBody`) names, and the other home
plugins' skills (pix-skills, caveman, pix-optimizer, context-mode) stay dark in every
turn. The review prompt tells the agent to note a missing lens skill and continue, so
the loss is visible in review reports only after a review already ran short.

## Goal

A board-spawned turn loads the skills of the plugins that its home has enabled in the
plugin lock, read-only, while every d7cab13 guarantee stays: no extension code from the
worktree, no extension code from the home plugins, no LSP, no project MCP config.

## Trust model (why home plugins may speak and worktree files may not)

- Alate installs a plugin into the shared home only after SkillSpector scanned it
  (docs/specs/agent-layer-switch.md, non-goals: "No change to the SkillSpector gate").
  The lock and the plugin packages are provisioned content, the same trust level as the
  home's own `.omp/agent/skills`, which turns already load.
- The run's cwd is a worker-writable worktree. A worker turn can plant `.omp/` or
  `.agents/` content there before the next board-side run reads it (the d7cab13 audit
  vector). Nothing from the worktree may steer a run.
- Loading a skill means omp reads `SKILL.md` markdown into the system prompt. It runs
  no plugin code: the extension entry points (`pi.extensions`, `main`) stay closed
  under `--no-extensions`.

## Mechanism (chosen and verified on omp 18.15.0)

omp's `skills.customDirectories` config key: an array of directories whose direct
children (each a folder with a `SKILL.md`) load as skills with source `custom:user`,
independent of extension discovery. Verified live on this stack (2026-11-10, omp
18.15.0, cwd a temp dir, `--no-extensions --no-lsp`, overlay with only the custom
directory):

- `skill://ponytail-audit` resolves and reads (the run quoted the skill body).

The same live probe found a d7cab13 gap requirement 2 has to close: a planted
`<cwd>/.agents/skills/planted-probe2/SKILL.md` **did** load under `--no-extensions`
(omp's `.agent(s)/skills` project provider is on by default), while
`<cwd>/.omp/agent/skills/planted-probe/SKILL.md` did not (that provider is off by
default on this omp version). The overlay therefore also pins the three project-level
skill enables off — `skills.enableAgentsProject`, `skills.enableClaudeProject`,
`skills.enablePiProject` — so the worktree stays inert by the board's own config, not
by omp's defaults. The user levels stay untouched, so the home's own skills keep
loading. Re-verified after the change: both planted skills answer not-found through the
shipped argv.

Rejected alternatives:

- `--skills <globs>` filters discovered skills by name; it loads no directory.
- `--plugin-dir` loads plugin code, exactly what `--no-extensions` must keep out.

### Scan semantics the board relies on

- A listed directory's own `SKILL.md` does not load (omp scans children only), so the
  overlay lists each plugin's declared skill directory, not the plugin package.
- A plugin may declare `pi.skills` entries in `package.json`. The board reads only that
  declaration; entries resolve relative to the plugin package directory under
  `<home>/.omp/plugins/node_modules/<plugin-name>`.
- Custom skills lose name clashes to standard discovery and each other deterministically
  (omp sorts); a plugin skill never displaces a shipped home skill of the same name.
- omp requires a `description` in the frontmatter of a custom-directory skill
  (`requireDescription`), the same gate the plugin loader applies.

## Design

### Enumeration (`src/pluginSkills.ts`)

`pluginSkillDirs(home)` reads, fail-soft (any missing piece yields no entry, never an
error, same contract as `tools.ts readUserLayer`):

1. `<home>/.omp/plugins/omp-plugins.lock.json`, key `plugins`.
2. Entries with `enabled === true` only.
3. For each: `<home>/.omp/plugins/node_modules/<name>/package.json`, key
   `pi.skills`, an array of strings; other shapes skip the plugin.
4. Each entry resolves against the plugin package directory; the result enters the
   list only when it stays inside that package directory and exists as a directory.
   A plugin name that escapes the package root (`..` segments, empty segments) skips
   the plugin.
5. Output: absolute paths, deduplicated, sorted — byte-stable overlay content for a
   given home.

Both homes carry the lock: the flat shared home (`/root/.omp/plugins`) and every agent
layer (the layer allowlist holds `.omp/plugins`, docs/specs/agent-layer-switch.md). The
board home (`OTTR_BOARD_OMP_HOME`, compose `/etc/ottr/home`) carries its own plugins
too: the board seed provisions it with the same allowlist, and the merge review's
second-model check found its lock enabling five plugins with the ponytail skills
installed (2026-11-10; this shell runs in a worker container, which mounts no
board-config volume, so the finding is recorded from that check plus the seed
contract, not read here directly). Every run therefore enumerates its own home:
Most board-side runs read the board home or its current layer.
An isolated merge agent reads a fresh, protected copy of the board's trusted
home or layer ([Merge turn project uid](merge-turn-uid.md)).
VM runs read their own home. Each run reads only its own home's lock.

### Per-project scoping (alate bundles)

Alate can provision per-project skill bundles into a turn home `H` — the same root the
overlay reads, the pinned agent layer's dir or the flat home (alate repo,
specs/bundles.md):

- `H/.ottr/project-skills/<P>/` — skill folders for project `P`'s turns only. The
  board adds this directory as one more `skills.customDirectories` entry, after the
  plugin skill dirs (`overlaySkillDirs` in `src/pluginSkills.ts`).
- `H/.ottr/plugins/<P>.txt` — the complete per-project plugin name list, one npm
  package name per line. `#` starts a comment; blank lines drop out. When the file
  exists, the run's plugin-skill set is the enabled plugins whose names appear in
  it; a name that no enabled plugin owns drops out silently (alate validates known
  names at provision time). A comment-only file filters every plugin dir out.

Fallback: no `.ottr/project-skills/<P>`, or no `.ottr/plugins/<P>.txt`, means "no
per-project scoping for `P`" — the overlay stays byte-identical to the unscoped
one. The builder takes the project from the same value that becomes the spawn's
`OTTR_PROJECT` (`o.board.project`); a run without board coordinates (a `stripBoard`
run) never reads the per-project paths.

Path rules: the project name passes the same rule the `.ottr/workers/<project>`
list paths use (`PROJECT` in `src/apt.ts`); an unsafe name scopes nothing. The
project directory enters the list only when it exists, is a directory, and its real
path stays inside the home's real path — the same real-vs-real guard the plugin
dirs use, so a symlink that leaves the home drops out. The list file reads like the
plugin lock: provisioned home content, read directly. The overlay file name includes
the project (one file per home and project), so two projects sharing one home write
different files and one project's spawn can never overwrite another's.

Custom skills lose name clashes to standard discovery and each other
deterministically (omp sorts); a per-project skill never displaces a shipped home
skill of the same name. The skill-name census for the prompt gate (`readUserLayer`
in `src/tools.ts`) stays unscoped: a worker's reported skill list keeps today's
shape.

### Overlay write

`ensurePluginSkillsOverlay(env, home, project, run)` mirrors `ensureMemoryOverlay`
(`src/memory.ts`). `run` names the dispatch: `{ kind: "board" }`, `{ kind: "worker" }`,
or `{ kind: "vm", sessionDir }`.

- Dir (`pluginSkillsOverlayDirFor`): the dispatch picks the anchor. A board-side run
  writes a server-only dir — `OTTR_SERVER_DATA_DIR` when set (compose:
  `/app/.tasks/projects` on the ottr-state volume, which no worker mounts), else the
  board's own per-install tmp dir `tmpdir()/ottr-board-overlays` (0700). A worker run
  writes the data dir (`overlayDirFor`: `OTTR_DATA_DIR`, else `tmpdir()/ottr-omp-memory`),
  which the worker container mounts. A VM run writes the project dir that holds the
  session dir, the only tree vm-runner copies in.
- Path: `<dir>/omp-plugin-skills-<hash>.yml` where the hash is the sha256 of the home
  path — plus the project, `\0`-joined, when one is set — cut to 16 hex chars. One
  file per home and project: two runs that share an anchor never share a file, and
  two projects on one home write two files, so no spawn can overwrite another's
  directory list between its write and its omp read. A pinned run keeps its own
  file's content for its whole life. Stale files of retired layers stay behind (each
  under 400 bytes, written only on content change) — accepted, the anchors already
  hold per-project trees.
- Content (`pluginSkillsOverlayYaml`) — the three project pins ride on every run, the
  plugin directories only when the home has them:

  ```yaml
  skills:
    enableAgentsProject: false
    enableClaudeProject: false
    enablePiProject: false
    customDirectories:
      - "<absolute dir>"
  ```

  Paths are YAML double-quoted scalars (`JSON.stringify` per path), so Windows-style
  paths stay valid.
- Write only when the content differs; writes go through `writeBelow` (no symlink
  follow: the worker-shared data dir is worker-writable, R5-1).
- Every run carries the overlay: a home with no plugin skills gets the pins-only
  file, so the worktree stays inert even there.
- A worker-shared anchor is worker-writable, so a worker could plant a file at the
  computed name there. The ensure step runs in the spawning process before the spawn:
  a planted file converges back to the freshly computed content before omp reads it,
  and the plant window is the milliseconds between write and read. This residual
  stays for worker and VM runs. A board-side run carries it no more: its overlay
  lives on the server-only state volume, which no worker mounts, so a worker cannot
  replace it between the board's write and omp's read (OTTR-1020 validation). The
  memory overlay (`omp-memory.yml`) keeps its data-dir anchor and its residual.

The worker and VM overlay files live in the data dir, which the server, the workers
and the VM copy mount at the same absolute path, so the argv path resolves in those
containers (docs/WORKERS.md, "Server: `OTTR_DATA_DIR=/data` …"). A board-side run
spawns omp in the server container, which reads the state-dir path itself. Content
is deterministic per home and project, so concurrent runs of the same home and
project write identical bytes; different homes and different projects write
different files; `writeBelow` gives the atomicity.

### Spawn wiring (`src/runner.ts`)

- `buildOmpArgs` gains `pluginSkillsConfig?: string | null`; non-null rides as one more
  `--config <path>` pair after `NO_DISCOVERY_CONFIG`, before the memory overlay. The
  `skills.customDirectories` key is unique to this overlay, so per-key overlay order
  cannot clash with `run.yml`, the no-discovery overlay or the memory overlay; the
  memory overlay stays last as documented.
- `startRun` computes, after `resolveLayerPin` (the pin resolves once per run, before
  any spawn): the plugin home is the run's pinned `HOME` — `layerEnv.HOME` when a layer
  pinned, else the flat layer home (`homedir()` for worker and VM runs, `boardOmpHome()`
  for the board's own runs). The overlay dir follows the dispatch
  (`pluginSkillsConfigFor`): `board` for a local run, `worker` for a worker dispatch,
  `vm` with `dirname(sessionDir)` for a microVM run.
- `StartOptions.pluginSkillsHome?: string` overrides the derived home; a test seam like
  `gitProbe` (tests must not read the real home).
- `startWorkerRun` passes the computed overlay path through to `buildOmpArgs`.

### Retro runs

A retro run passes `--skills retro`, omp's include-list filter on skill names, so a
retro run keeps only the retro skill. That is today's behavior, unchanged: a retro run
needs no plugin lens. Nothing in this spec filters normal turns.

### OTTR-770 tie-in

A skill a prompt names and the runner lacks is reported, not silently skipped: the
review prompt already instructs "If this runner lacks a lens skill, note that gap in
your report details and continue without asking" (`src/prompts.ts`, reviewBody), and
the board lists per-worker gaps (`src/requiredSkills.ts`, Settings → Alate). This
change removes the cause (the skill never loaded); the reporting duty stays as is.

## Error cases

- Lock missing, unreadable JSON, plugin not enabled, package or `pi.skills` missing,
  skill dir missing: the entry drops out, the rest still loads. No run fails because
  enumeration came up short.
- Data dir unwritable: `writeBelow` fails the spawn loudly, same as the memory overlay.
- A provision switches layers mid-flight: a live run keeps its pinned layer, so its
  overlay content stays the one computed at spawn.

## Non-goals

- No plugin code loads: no `--plugin-dir`, no extension entry points, no LSP, no MCP.
- No change to `--no-extensions`, `--no-lsp` or the no-discovery overlay.
- No change to either home's R5-1 isolation: each run reads only its own home's plugin
  lock (board-side runs the board home or its layer, worker and VM runs the shared home
  or theirs), and the overlay converges before the spawn reads it.
- No prompt wording change in `reviewBody`; the gap note stays.
- No UI change; Settings → Alate already lists the plugins.

## Acceptance checks

- A board-side run's overlay path stays outside the worker-shared data dir:
  `pluginSkillsConfigFor` picks the server-only state dir for a local dispatch, and
  `src/pluginSkills.test.ts` pins the board anchor against `OTTR_DATA_DIR`.
- A test pins the turn argv and config: with a fixture home holding an enabled plugin
  that declares `pi.skills`, the run's argv carries the overlay path and the overlay
  file pins the three project skills off and lists the plugin's skill directory; a
  worktree `.omp` or `.agents` path appears nowhere in argv or overlay.
- A fixture home without plugins yields the pins-only overlay (no
  `customDirectories` key).
- Two homes sharing the data dir write two distinct overlay files, each listing only
  its own home's directories; neither write changes the other's bytes.
- On the stack, a run with the shipped argv reads `skill://ponytail-audit`, and
  planted `.omp/agent/skills` and `.agents/skills` skills in the run's cwd both stay
  unloaded (command and output in the card report).
- A fixture home with `.ottr/project-skills/<P>` lists that directory in the
  overlay's `customDirectories`, after the plugin dirs; a `.ottr/plugins/<P>.txt`
  present in the same home keeps only the named enabled plugins' dirs.
- Absent per-project files, an unsafe project name, or a run without board
  coordinates leave the overlay byte-identical to the unscoped one.
- The planted-extension and planted-project-MCP real-omp tests from d7cab13 stay green.
