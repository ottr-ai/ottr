# Model roles editor

Settings gets a **Model roles** section. The user edits the omp `modelRoles` map from a desktop or a phone. A save commits the data repo's `user/omp/agent/config.yml`. Alate provisions the workers, and the board seed brings the change to the board's own copy.

## Data path

- The source is the data repo file `user/omp/agent/config.yml`. Ottr never edits a local copy (`/etc/ottr/home/.omp/agent/config.yml` or `/root/.omp/agent/config.yml`): Alate refuses to overwrite a file that differs from what it installed last.
- Ottr reads through the Alate server that Settings → Alate configures, with the stored Alate API key as a Bearer token:
  - `GET /api/file?path=user/omp/agent/config.yml` gives `{ content, hash }` from Alate's last import (`hash` is the sha256 of the bytes).
  - `POST /api/import { source, kind }` refreshes Alate's snapshot from the branch head and returns `{ state }`. `state.source` holds `kind`, `name` (`owner/name`), `ref` (the branch, empty for the default branch) and `importedSha` (the head commit). `source` and `kind` come from Alate's `/health` (`repo` or `path`).
  - `GET /api/state` returns the same snapshot state without a new import.
- Ottr writes with the board's GitHub token (Settings → GitHub, through `gh api`), to the repo and branch of Alate's source. Alate's own `PUT /api/file` checks only a file hash, so it cannot hold a save to its loaded parent commit. The write:
  1. `GET repos/<name>/git/commits/<base>` gives the tree of the loaded commit.
  2. `POST repos/<name>/git/trees` with `base_tree` and the new `config.yml` content.
  3. `POST repos/<name>/git/commits` with `parents: [<base>]`.
  4. `PATCH repos/<name>/git/refs/heads/<branch>` with `force: false`. GitHub moves the branch only as a fast-forward. A branch that moved since `<base>` gives "Update is not a fast forward", and Ottr answers 409. Nothing ever force-pushes.
- `name` must match `owner/name`, `base` must be a 40-character hex commit, and the branch must be a plain ref name. Alate's values reach `gh api` paths only after these checks.
- A path source (a local data repo in Alate) cannot be saved: the route returns 400.
- After a commit, Ottr asks Alate to import it (`POST /api/import`), so the provision installs the new commit. The UI then calls the existing `POST /api/alate/provision`.
- The board copy: on compose (`OTTR_BOARD_OMP_HOME` is set), the hourly deploy seeds it (OTTR-188) and records the seeded commit in `<dirname(OTTR_BOARD_OMP_HOME)>/seed-commit` (`/etc/ottr/seed-commit`). Without `OTTR_BOARD_OMP_HOME`, the board reads the copy that the provision installs, and no seed step applies.

## API

### `GET /api/model-roles`

200:

```json
{
  "base": "<data repo commit of Alate's snapshot, or null for a path source>",
  "hash": "<sha256 hex of config.yml>",
  "roles": { "default": "zai/glm-5.3-flash:max", "slow": "anthropic/claude-opus-5-5:medium" },
  "signIns": [{ "store": "board", "active": ["anthropic", "zai"] }],
  "seed": { "needed": true, "commit": "<sha or null>", "roles": { "default": "..." } }
}
```

- `roles` keeps the file order. Only nonempty string values count.
- `signIns`: one entry, the board store (`signIns()`): one sign-in serves the board and the workers (docs/specs/provider-credentials.md). `active` lists the providers with an active sign-in. `active` is null when the store cannot be read.
- `base` comes from `GET /api/state` (no re-import, so the read stays fast). When Alate's snapshot is behind the branch head, the first save gets a conflict and then shows the current values.
- `seed.commit` is the trimmed content of the `seed-commit` file, or null when it is absent. `seed.roles` is the board copy's `modelRoles` (`{}` when the board copy is not seeded). Both are null without `seed.needed`.

Errors (`{ error }`): 400 when the Alate URL or key is not set. 404 when the data repo has no `user/omp/agent/config.yml`. 502 when Alate cannot be reached or gives an error. 422 when the file has a `modelRoles` layout that the editor does not support.

### `POST /api/model-roles`

Body: `{ "base": "<base from the read>", "hash": "<hash from the read>", "roles": { "<role>": "<selector>" } }`. The object order is the order for new roles.

1. Ottr re-imports Alate's snapshot (`POST /api/import`) and reads the file. When the head commit differs from the body `base`, or the file hash differs from the body `hash`, the route returns 409 `{ error, base, hash, roles }` with the current values, and commits nothing. A commit on main that leaves `config.yml` alone is a conflict too. This check runs before validation, so a stale form gets the current values also when they already hold the requested ones.
2. Validation. On a failure the route returns 400 `{ error, fields }` and commits nothing. `fields` maps a role name to its message.
   - A new role name must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. A name that the file already holds stays editable.
   - `roles` must hold at least one role.
   - Each value must be `<catalog selector>` or `<catalog selector>:<level>`. This applies to every value, also to an unchanged value. The catalog is `omp models --json` (the `/api/models` list). The level is one of `THINKING_LEVELS` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`). A value with a known model and an unknown suffix gets "unknown thinking level".
   - A save that changes nothing gives 400 `nothing to save`.
3. Ottr writes the new text (see "Text edit") as a GitHub commit with the loaded `base` as its parent (see "Data path").
4. When GitHub refuses the fast-forward, the data repo moved after the re-import. Ottr re-imports, reads the file again, and returns 409 `{ error, base, hash, roles }`. Ottr never retries the write by itself. When the refresh fails, the route returns the refresh error. Other GitHub errors (no write access, no token, gh missing) return 502 with GitHub's message.
5. When Alate cannot import the new commit, the route returns 502 with an error that names the commit. The commit stays in the data repo.
6. Success: 200 `{ commit, base, hash, roles, seed }`. `commit` and `base` are the created commit, `hash` is the sha256 of the written content, and `roles` are the written roles. The answer never takes values from Alate's import after the commit: another commit can land on main in that time. The next save then meets that commit as a 409 conflict. The UI keeps these values for the rows. Its 60 s seed poll takes only `seed`.

The commit message is a Conventional Commit of at most 500 characters:

- One role added or changed: `chore: set the <role> model role to <value>`.
- One role removed: `chore: remove the <role> model role`.
- Other cases: `chore: update the <role>, <role> model roles`. A long list ends in `…` before the 500-character cap.

## Text edit

The edit changes only the `modelRoles` block. Every other byte stays: other keys, comments, order, blank lines, line ends, and the final newline. A file without a final newline keeps its open end, also when the edit removes its last line.

- The block starts at a column-0 line `modelRoles:` (a trailing comment is allowed). It ends before the next column-0 line that is not blank and not a comment.
- Each entry is one line `<indent><role>: <value>` with an optional trailing ` # comment`. The value is a plain scalar or a single-quoted or double-quoted string. All entries share one indent.
- A changed value replaces only the value text. An unchanged entry keeps its line exactly. A removed role loses its line. A new role gets a new line after the last entry, with the block's indent and line end.
- A new value is written plain when it matches `^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$` and holds a `/`. Else it is written as a JSON string (a valid YAML double-quoted string).
- When the file has no `modelRoles` key, the edit appends a block at the end.
- Any other layout (a flow map, a multi-line value, an anchor, a nested key) gives the 422 error. Ottr then edits nothing.
- A check after the edit parses both texts. The new `modelRoles` must equal the requested map, and every other key must equal its old value. A failed check is an error, and nothing is committed.

## UI

- The General Settings page shows **Model roles** after **Provider sign-in**.
- One row for each role: the role name, a model `<select>` with the `/api/models` catalog, and a thinking `<select>` (Default, then each level). A current value that is not in the catalog shows as an extra option "<value> (not in the catalog)".
- A remove button for each row. An add form with a role name, then the new row takes the first catalog model.
- **Save** is off while nothing changed or a save runs. A 400 shows each `fields` message at its row (`aria-describedby`, `aria-invalid`). A 409 with `roles` loads the current values and shows the conflict message. Other errors show in an alert.
- A row warns when its provider (the selector text before `/`) has no active sign-in on the board: "No active sign-in for <provider> on the board". A store with `active: null` gives no warning.
- After a commit, the section shows each step and its result:
  1. "Committed <short sha> to the data repo."
  2. The provision: running, then success, or the failed scripts and their error. A failure keeps the commit and says so.
  3. The board copy: with `seed.needed`, the section compares `seed.roles` (the board copy) with the roles before and after the save. The section reads again each 60 s while it waits.
     - The board copy holds the saved roles: "The board copy has the saved roles".
     - The board copy holds the roles from before the save, or no roles: "Waiting for the hourly deploy to seed <short sha>".
     - The board copy holds other roles: "The board copy has other roles: a later change replaced this save". The wait ends.
     - Without `seed.needed`: "The board reads the provisioned copy."
- The section works at 360 px width and keeps WCAG 2.1 AA (DESIGN.md "Accessibility").

## Acceptance

- A test: a save changes only the `modelRoles` values and keeps every other byte of `config.yml`.
- A test: an unknown model or level is refused, and nothing reaches Alate's `PUT /api/file`.
- A test: a moved data repo gives a 409 conflict with the current roles and no write: a commit on main that leaves `config.yml` alone, a changed `config.yml`, and a move between the re-import and Alate's write (Alate 409, no second write).
- Screenshots of the section at desktop width and at phone width.
- `bun run check` and `bun test` pass.

## Non-goals

- Other `config.yml` keys, and edits of a local `config.yml` copy.
- A board-side git clone of the data repo: Alate reads it, and the GitHub API writes it.
- Saves to a path source in Alate: these need a GitHub repo source.
- A board-triggered seed: the board container cannot run `board-seed`. The hourly deploy does it.
- Provider API keys in the env do not clear the sign-in warning.
- A seed state from git history: the board has no clone of the data repo, so the seed step compares roles, not commits.
