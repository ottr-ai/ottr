# Merge turns find a project's declared Python packages

## Problem

A merge turn runs in the server with `HOME=OTTR_BOARD_OMP_HOME` (compose:
`/etc/ottr/home`, docs/WORKERS.md R5-1). A work turn on a worker installs its
Python packages with `pip --user` into the shared home (`/root/.local`). The
merge turn sees none of them: the board must never read or run anything from
the worker-writable shared home (R5-1). ASSE-6 (asset-forge, 2026-11-04)
stopped in its merge turn: numpy, Pillow, hypothesis, ruff and pip were gone,
and the user had to approve a second ad-hoc install of the full pinned set.

## Decision

A project declares its Python packages once; both homes install the same set.

1. The list lives in the data repo as `workers/<project>/requirements.txt`
   (and `workers/_all/requirements.txt` for the fleet), one pinned line per
   package, transitive dependencies included:

       name==version --hash=sha256:<64 hex>

   `#` comments allowed. No options, no `-r`, no `--index-url`, no extras, no
   VCS or URL requirements: PyPI defaults only. Every line carries at least one
   sha256 hash, so pip installs with `--require-hashes` and nothing unpinned
   can slip in, in either home.
2. Alate provisions the file beside `apt.txt` and `tools.json`, and the board
   seed copies it into the board home (same path as tools.json). Until alate
   ships `requirements.txt` in its `WORKER_FILES`, no list reaches a home and
   every ensure call is a no-op.
3. The machine that runs a turn builds a venv under its own home:

       <home>/.ottr/pip/<sha256 of the merged list>/

   The worker builds into the shared home when it starts and before each work
   turn; the server builds into the board home before each server-side turn
   (merge turn, work turn with no worker, retro and board checks). The build is
   `python3 -m venv` plus `pip install --no-cache-dir --require-hashes -r`
   against a staged copy of the merged list. The build runs in a temp dir and
   moves in with one rename, keyed by the hash, so a rerun is a no-op and a
   failed build leaves nothing behind. The project's lines win over `_all`
   lines for the same package name.
4. A server-side turn prepends the venv's bin dir to its PATH, behind the tools
   link dir. A work turn on a worker does not: its ad-hoc `pip --user` flow
   stays untouched (non-goal), and a venv first on PATH would shadow the user
   site it installs into.
5. The turn log names the venv, and a server-side turn's log adds that the
   venv's bin dir is on the PATH. The merge prompt stays unchanged: a
   `src/prompts.ts` wording change needs the user's approval (hard stop 3),
   and the log line carries the hint instead.
6. Dockerfile.worker gains `python3-venv` (platform capability): Debian ships
   no pip without it, and the venv's pip comes from ensurepip.

R5-1 holds: the server reads the list from its own home and builds under it;
nothing from the shared home is read or run in the server.

## Boundaries and errors

- A list that fails to parse fails the turn with a `pip:` error, like a broken
  tools.json does.
- A failed venv build or pip install fails the turn: missing declared packages
  are exactly the ASSE-6 failure mode, so this fails closed.
- No `python3` on the machine: a clear `pip:` error naming the image need.
- The board provisioning endpoint and matrix gain a `requirements` column, so
  an operator sees which projects have a list in the read home.

## Acceptance checks

- Unit: the parser accepts pinned lines, rejects unpinned lines, options, bad
  hashes and duplicate names.
- Unit: ensure builds once (the injected run asserts `--require-hashes`), a
  second call is a no-op, and the project's line wins over `_all`.
- Property: generated valid lines round-trip through the parser; every
  malformed mutation throws (gate: 200 runs, seed 42).
- Smoke: a real pinned idna wheel installs into a venv in a temp home,
  `<venv>/bin/python -c "import idna"` imports, the server-side PATH
  composition resolves `python3` to the venv, and a second ensure is a no-op.
- Gates: `bun run check`, `bun test`.

## Non-goals

- No change to how work turns install packages today: their PATH and their
  ad-hoc user-site flow stay as they are.
- No change to review turns: they dispatch to workers and keep the worker-side
  flow.
- No prompts.ts wording change.
- Alate's `WORKER_FILES`, its requirements validation, and the provisioning
  booleans on the alate side are a separate card in the alate repo.

## Projects that need a list (report)

- asset-forge: yes — the ASSE-6 ad-hoc set (numpy, Pillow, hypothesis, ruff,
  torch) becomes `workers/asset-forge/requirements.txt`.
- clipshelf: optional — its apt.txt already installs python3-venv and its
  AGENTS.md builds a throwaway lock-only venv from the repo's own pins; a
  declared list would remove that per-turn step, but nothing breaks without it.
- velvarr, career-ops, mystic-realms, ottr, alate: no evidence of Python
  user-site packages (ottr and alate are Bun/Node, mystic-realms is Godot).
  A list belongs here only when a turn actually installs Python packages.
