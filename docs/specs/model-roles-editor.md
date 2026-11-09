# Model roles editor

Settings gets a **Model roles** section. The user edits the omp `modelRoles` map and the fallback models of each role (`retry.fallbackChains.<role>`) from a desktop or a phone. A save commits the data repo's `user/omp/agent/config.yml`. Alate provisions the workers, and the board seed brings the change to the board's own copy.

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
- A path source (a local folder in Alate) saves through Alate's `PUT /api/file` instead of GitHub: Ottr sends `{ path, content, base, message }` with `base` the file hash from the read. Alate verifies the hash against the folder, writes the bytes and commits them when the folder is a git repo (`commit` is the new sha, "" when it is not, `pushed` false without an upstream); it imports inside the PUT, so the route makes no import call of its own. Success answers 200 `{ commit, base: null, hash, roles, seed }` — `base` stays null because a path source reports `importedSha` "" forever, so a commit as `base` would 409 every later save. Alate's own PUT holds only the file hash, not a commit parent, so nothing force-pushes and nothing conflicts beyond that hash.
- A plain (non-git) folder is read-only. The first save discovers it: Alate's PUT answers `commit` "" after writing the bytes. Ottr undoes the write byte for byte (a second PUT with the hash the first gave back) — a read-only source must not keep an uncommitted write in an unversioned folder — and answers 400 `{ error: "read-only: folder source", path }`. When the undo fails, the 400 carries the undo error and no `path` field. The GET cannot know the folder's git-ness in advance, so the editor locks only after that answer.
- A folder whose mount is read-only fails Alate's PUT before any byte: Alate answers its raw filesystem error (`EROFS` or `EACCES`, an HTTP 500). Ottr maps that error to 400 `{ error: "read-only: folder source", path, cause: "mount" }`. The plain answer carries no `cause`. The editor locks for both causes, and the hint names the fix: make the mount writable, or edit `user/omp/agent/config.yml` in the folder, then run Import and Provision in Alate.
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
  "fallbacks": { "plan": ["openai-codex/gpt-6.1-sol"], "openai-codex/gpt-6.1-sol": ["zai/glm-5.3:max"] },
  "signIns": ["anthropic", "zai"],
  "seed": { "needed": true, "commit": "<sha or null>", "roles": { "default": "..." }, "fallbacks": { "plan": ["..."] } }
}
```

- `roles` keeps the file order. Only nonempty string values count.
- `fallbacks` is `retry.fallbackChains` in file order: every key whose value is a list of nonempty strings (also an empty list). omp keys a chain by a role name or by a model selector. The UI shows only the chains of its role rows.
- `signIns`: the providers with an active sign-in in the board store (`signIns()`): one sign-in serves the board and the workers (docs/specs/provider-credentials.md). `signIns` is null when the store cannot be read.
- `base` comes from `GET /api/state` (no re-import, so the read stays fast). When Alate's snapshot is behind the branch head, the first save gets a conflict and then shows the current values.
- `seed.commit` is the trimmed content of the `seed-commit` file, or null when it is absent. `seed.roles` is the board copy's `modelRoles` (`{}` when the board copy is not seeded), and `seed.fallbacks` is its `retry.fallbackChains` (string lists only, `{}` when absent). All three are null without `seed.needed`.

Errors (`{ error }`): 400 when the Alate URL or key is not set. 404 when the data repo has no `user/omp/agent/config.yml`. 502 when Alate cannot be reached or gives an error. 422 when the file has a `modelRoles` layout that the editor does not support.

### `POST /api/model-roles`

Body: `{ "base": "<base from the read>", "hash": "<hash from the read>", "roles": { "<role>": "<selector>" }, "fallbacks": { "<role>": ["<selector>", "..."] } }`. The object order is the order for new roles.

`fallbacks` is optional. It holds the full chain of each role in `roles` that has a chain. A role in `roles` without a `fallbacks` key gets no chain. An empty list stays an explicit empty chain (omp then uses no fallback for that role). Without `fallbacks`, each role in `roles` keeps its current chain. A removed role loses its chain. A `retry.fallbackChains` key that is not a current or a requested role (for example a model selector key) stays byte for byte.

1. Ottr re-imports Alate's snapshot (`POST /api/import`) and reads the file. When the head commit differs from the body `base`, or the file hash differs from the body `hash`, the route returns 409 `{ error, base, hash, roles, fallbacks }` with the current values, and commits nothing. A commit on main that leaves `config.yml` alone is a conflict too. This check runs before validation, so a stale form gets the current values also when they already hold the requested ones.
2. Validation. On a failure the route returns 400 `{ error, fields, fallbackFields }` and commits nothing. `fields` maps a role name to its message. `fallbackFields` maps a role name to the message for its fallback list.
   - A new role name must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. A name that the file already holds stays editable.
   - `roles` must hold at least one role.
   - Each value must be `<catalog selector>` or `<catalog selector>:<level>`. This applies to every value, also to an unchanged value. The catalog is `omp models --json` (the `/api/models` list). The level is one of `THINKING_LEVELS` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`). A value with a known model and an unknown suffix gets "unknown thinking level".
   - `fallbacks` must be an object. Each key must be a role in `roles`. Each value must be a list. Each entry follows the value rule above, and the message names the entry ("fallback 2: unknown model x/y").
   - A chain must not hold one selector twice, and must not hold the role's own value.
   - A save that changes no role and no chain gives 400 `nothing to save`.
3. Ottr writes the new text (see "Text edit") as a GitHub commit with the loaded `base` as its parent (see "Data path").
4. When GitHub refuses the fast-forward, the data repo moved after the re-import. Ottr re-imports, reads the file again, and returns 409 `{ error, base, hash, roles, fallbacks }`. Ottr never retries the write by itself. When the refresh fails, the route returns the refresh error. Other GitHub errors (no write access, no token, gh missing) return 502 with GitHub's message.
5. When Alate cannot import the new commit, the route returns 502 with an error that names the commit. The commit stays in the data repo.
6. Success: 200 `{ commit, base, hash, roles, fallbacks, seed }`. `commit` and `base` are the created commit, `hash` is the sha256 of the written content, and `roles` and `fallbacks` are the written values. The answer never takes values from Alate's import after the commit: another commit can land on main in that time. The next save then meets that commit as a 409 conflict. The UI keeps these values for the rows. Its 60 s seed poll takes only `seed`.

The commit message is a Conventional Commit of at most 500 characters:

- One role added or changed: `chore: set the <role> model role to <value>`.
- One role removed: `chore: remove the <role> model role`.
- Only the chain of one role changed: `chore: set the <role> model role fallbacks to <a>, <b>`, `chore: set the <role> model role fallbacks to none` for an empty list, or `chore: remove the <role> model role fallbacks` when the chain goes.
- Other cases: `chore: update the <role>, <role> model roles`, with each role that has a changed value or chain. A long list ends in `…` before the 500-character cap.

## Text edit

The edit changes only the `modelRoles` block. Every other byte stays: other keys, comments, order, blank lines, line ends, and the final newline. A file without a final newline keeps its open end, also when the edit removes its last line.

- The block starts at a column-0 line `modelRoles:` (a trailing comment is allowed). It ends before the next column-0 line that is not blank and not a comment.
- Each entry is one line `<indent><role>: <value>` with an optional trailing ` # comment`. The value is a plain scalar or a single-quoted or double-quoted string. All entries share one indent.
- A changed value replaces only the value text. An unchanged entry keeps its line exactly. A removed role loses its line. A new role gets a new line after the last entry, with the block's indent and line end.
- A new value is written plain when it matches `^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$` and holds a `/`. Else it is written as a JSON string (a valid YAML double-quoted string).
- When the file has no `modelRoles` key, the edit appends a block at the end.
- Any other layout (a flow map, a multi-line value, an anchor, a nested key) gives the 422 error. Ottr then edits nothing.
- A check after the edit parses both texts. The new `modelRoles` must equal the requested map, and every other key must equal its old value. A failed check is an error, and nothing is committed.

### Fallback chains

The edit changes only the managed keys of `retry.fallbackChains`: the current roles and the requested roles. Every other byte stays, also the other keys of `retry` and the unmanaged chain keys with their comments.

- `retry` is a column-0 block `retry:` (a trailing comment is allowed). `fallbackChains:` is one line at the indent of the first child of `retry`, with an optional trailing comment. Its block holds the lines with a deeper indent, and blank and comment lines.
- Each chain key is one line at one shared indent. A managed key holds `<key>:` with block list items `- <value>` on the next lines (at a deeper indent or at the key's indent), or `<key>: []`. Each item is one plain or quoted scalar with an optional trailing comment. An unmanaged key can have any layout.
- A changed chain replaces the item lines of its key. An unchanged chain keeps its lines exactly. A chain that goes loses its key line and its item lines. A new chain follows the last line of the block, with the key indent and the item indent of the block (or two more spaces). An empty list is written `<key>: []`.
- Without `fallbackChains`, the edit adds it at the end of the `retry` block. Without `retry`, the edit appends a `retry:` block at the end of the file. A chain block that loses its last key keeps its `fallbackChains:` line (YAML null, which omp reads as no chains).
- Item values follow the value rule above (plain or a JSON string).
- Any other layout of `retry` or of a managed key (a flow map, a flow list with entries, a multi-line value, an anchor, two `fallbackChains` keys) gives the 422 error, also on the read.
- The check after the edit also requires: each managed key holds exactly the requested chain (no key when no chain is requested), every unmanaged chain key and every other `retry` key equals its old value.

## UI

- The General Settings page shows **Model roles** after **Provider sign-in**.
- One row for each role: the role name, a model `<select>` with the `/api/models` catalog, and a thinking `<select>` (Default, then each level). A current value that is not in the catalog shows as an extra option "<value> (not in the catalog)".
- Under each row, the role's **Fallbacks** in chain order. Each fallback has the same model and thinking pickers, a **Move up** button (not on the first one) and a remove button. **Add fallback** appends the first catalog model. A new role starts with the chain that the file holds for that key, or with none. A `fallbackFields` message shows at the row's fallback list.
- A remove button for each row. An add form with a role name, then the new row takes the first catalog model.
- **Save** is off while nothing changed or a save runs. A 400 shows each `fields` message at its row (`aria-describedby`, `aria-invalid`). A 409 with `roles` loads the current values and shows the conflict message. Other errors show in an alert. A 400 with exactly the read-only error locks the editor: `cause: "mount"` (the folder sits on a read-only mount) shows the mount hint, the answer without `cause` (a plain folder, not a git repo) keeps the git hint. For a folder source (`base` null), the section's help text says Save writes through Alate's editor, not with the board's GitHub token.
- A row warns when its provider (the selector text before `/`) has no active sign-in on the board: "No active sign-in for <provider> on the board". A store with `active: null` gives no warning.
- The section flags a missing check role: without `critic` (which checks Anthropic models) or `adversary` (which checks the rest), the second-model check falls back to the default model, which is often the model it checks. The flag tracks the edited rows, before any save.
- After a commit, the section shows each step and its result:
  1. "Committed <short sha> to the data repo."
  2. The provision: running, then success, or the failed scripts and their error. A failure keeps the commit and says so.
  3. The board copy: with `seed.needed`, the section keeps `seed.commit` from the save answer. It compares `seed.roles` and the chains of the saved roles in `seed.fallbacks` (the board copy) with the saved values, and the current `seed.commit` with the kept one. The section reads again each 60 s while it waits.
     - The board copy holds the saved roles: "The board copy has the saved roles".
     - `seed.commit` is the same as at the save: "Waiting for the hourly deploy to seed <short sha>". The board copy can hold the roles of an earlier save, because two saves can come before one seed.
     - `seed.commit` changed after the save, and the board copy holds other roles: "The board copy has other roles: a later change replaced this save". The wait ends.
     - Without `seed.needed`: "The board reads the provisioned copy."
- The section works at 360 px width and keeps WCAG 2.1 AA (DESIGN.md "Accessibility").

## Acceptance

- A test: a save changes only the `modelRoles` values and keeps every other byte of `config.yml`.
- A test: a fallback save changes only the managed chain lines and keeps every other byte, also the unmanaged chain keys and their comments.
- A test: an unknown fallback model, a duplicate, and a fallback for a role that is not in `roles` are refused, and no write reaches GitHub.
- A test: an unknown model or level is refused, and no write reaches GitHub (`gh api` git trees, commits, or refs).
- A test: a moved data repo gives a 409 conflict with the current roles and no write: a commit on main that leaves `config.yml` alone, a changed `config.yml`, and a move between the re-import and the ref update (GitHub refuses the fast-forward, no second write).
- Screenshots of the section at desktop width and at phone width.
- `bun run check` and `bun test` pass.

## Non-goals

- Other `config.yml` keys, and edits of a local `config.yml` copy.
- A board-side git clone of the data repo: Alate reads it, and the GitHub API writes it.
- Git-ness of a folder source known before the first save: the GET cannot see it, so the editor locks only after a save learns the folder is plain (the PUT answers `commit` "").
- A read-only mount known before a save: Alate's `/health` carries no writability field, and no route can probe the write without side effects (a probe PUT commits on a git folder and writes bytes on a plain one), so the editor learns the mount from the failed save.
- A board-triggered seed: the board container cannot run `board-seed`. The hourly deploy does it.
- Provider API keys in the env do not clear the sign-in warning.
- A seed state from git history: the board has no clone of the data repo. The seed step compares the roles and the recorded `seed.commit`, not the commit graph.
