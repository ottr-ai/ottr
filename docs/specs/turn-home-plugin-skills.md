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
board-side runs (merge, retro, board check, the check runs) read the board home or its
current layer, worker and VM runs read the shared home or theirs. Each run reads only
its own home's lock — no cross-home read.

### Overlay write

`ensurePluginSkillsOverlay(env, home)` mirrors `ensureMemoryOverlay` (`src/memory.ts`):

- Path: `<overlayDirFor(env)>/omp-plugin-skills-<sha256(home).slice(0, 16)>.yml`
  (`OTTR_DATA_DIR`, else `tmpdir()/ottr-omp-memory`, dir 0700). One file per home: a
  board-side run and a worker run share the data dir but never share a file, so the
  two homes cannot overwrite each other's directory list, and a pinned run keeps its
  own home's content for its whole life. Stale files of retired layers stay behind
  (each under 400 bytes, written only on content change) — accepted, the data dir
  already holds per-project trees.
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
  follow: the data dir is worker-writable, R5-1).
- Every run carries the overlay: a home with no plugin skills gets the pins-only
  file, so the worktree stays inert even there.
- The data dir is worker-writable, so a worker could plant a file at the computed
  name. The ensure step runs in the spawning process before the spawn: a planted file
  converges back to the freshly computed content before omp reads it, and the plant
  window is the milliseconds between write and read. This is the same accepted
  residual as the memory overlay (`omp-memory.yml`, same dir, same convergence).

The overlay files live in the data dir, which the server, the workers and the VM copy
mount at the same absolute path, so the argv path resolves in every container
(docs/WORKERS.md, "Server: `OTTR_DATA_DIR=/data` …"). Content is deterministic per
home, so concurrent runs of the same home write identical bytes; different homes write
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
  for the board's own runs). The overlay env mirrors `resolveMemoryConfig`: a VM run
  scopes `OTTR_DATA_DIR` to `dirname(sessionDir)` because vm-runner copies in only paths
  under `/data/<project>/`.
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
- The planted-extension and planted-project-MCP real-omp tests from d7cab13 stay green.
