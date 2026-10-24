# Upstream update checks (2026-10-13)

**Decision:** Every public item that the agent layer or the worker image uses records its origin.
A provider checks those origins once a day and holds each release for 7 days (G21). It serves
the result through a small HTTP contract that Ottr owns. Alate is the provider today, and it stays
usable without Ottr. Ottr shows the updates in an Updates panel. When you allow updates, Ottr files
one card for each owning repo, and the repo's own docs say how to do the update. Agent-layer cards
wait for your approval before the merge. Image-pin cards merge at once, and the existing deploy
ships them.

Before this decision, only omp had an update check (`omp-bump.yml`, every 6 h, no approval, no age
gate). Every other image pin was a hand bump, and nothing checked skills, plugins or vendored rules.
The design came from a grilling session on 2026-10-13.

## U1 - Scope

- In: the agent layer in the data repo (root rules, skills, plugins, MCP servers, marketplaces) and the
  version pins in `Dockerfile.worker`.
- Out: project language dependencies. Dependabot or Renovate owns them (the data repo's
  `docs/research/dependency-plan.md`, Layer 1).
- Out: Debian apt pins. Debian security updates own them.
- Out: host tool copies (scoop rtk, `ripwire.exe`). The report of an image-pin card gives the host
  command.

## U2 - Registry in the data repo

The existing lockfiles stay the registry for the items that they record:

- `user/agents/.skill-lock.json`: skills (`sourceUrl`, `skillPath`, `skillFolderHash`).
- `user/omp/plugins/package.json` and `bun.lock`: plugins. `bun.lock` holds the installed version.
- `user/omp/marketplaces.json`: marketplaces.

`upstreams.json` at the data repo root records all other public items. Each item has these fields:

- `name`.
- `kind`: `image-pin`, `mcp`, `rule-set`, `skill` or `plugin`.
- `origin`: the GitHub page of the item. It is always a GitHub URL.
- `check`: where the releases appear. Types: `github-release` (`repo`), `github-path` (`repo`,
  `path`), `npm` (`package`), `node-dist` (`major`), `chrome-for-testing` (`channel`).
- `pin`: where the current version lives, as `{ repo, file, key }`. Example: `ottr-ai/ottr`,
  `Dockerfile.worker`, `RTK_VERSION`. Vendored files carry no version, so a vendored item stores it
  as `version`.
- `managedBy` (optional): another updater owns the item, for example `omp-bump.yml` or `pinokio`.
  The checker records the item but offers no update.
- `paths` (optional): the data repo paths that the item covers.

The top-level `own` list names the paths that we wrote: own root rules, own skills, managed skills.
An own item carries no origin.

The gate: `sync.mjs` fails when a skill, root rule, plugin, MCP server or marketplace matches no
lock entry, no item `paths` entry and no `own` path. `projects/` is exempt. A forgotten entry and an
own item look the same, so own items need the mark.

## U3 - Provider contract (Ottr owns it)

Ottr calls three endpoints, each with `Authorization: Bearer <key>`:

- `GET /health` returns `{ ok, pending }` plus any other fields. `pending` is true when the
  provider holds imported content that it has not provisioned yet. The provider imports on its own
  schedule. Ottr only picks the time to provision.
- `POST /provision` returns `{ ok, results }`. This endpoint exists today.
- `GET /api/updates` returns `{ checkedAt, updates: [UpdateRecord] }`.

An `UpdateRecord` has these fields:

| Field | Meaning |
|---|---|
| `id` | Stable key, `<name>@<target>` |
| `name`, `kind` | As in U2 |
| `origin` | GitHub URL of the item |
| `repo` | GitHub `owner/name` of the repo that holds the pin. Ottr maps it to a board project through the project's origin remote |
| `pin` | `{ file, key }` in that repo |
| `current` | The pinned version or commit |
| `latest` | The newest version or commit |
| `target` | The newest version that is 7 or more days old, or `null` |
| `publishedAt`, `qualifiesAt` | ISO times for `latest`. `qualifiesAt` is `publishedAt` plus 7 days |
| `notesUrl` | Release notes or a compare URL |
| `managedBy` | Optional. When present, Ottr shows the row without Allow |
| `removed` | "True when the pinned path was deleted upstream. The checker then sets no `target`. Ottr shows the row as a notification without Allow and refuses to file a card for it." |
| `diffs` | Optional. At most 50 `{file, url}` entries: the files that changed in the skill folder from the `current` tag to the picked tag. Each `url` is the GitHub compare page with the anchor of that file. Ottr shows one diff link for each file. Commit-tracked rows have no `diffs`, because no base commit is known. |

Ottr treats every field as untrusted input. It checks types and lengths, accepts only http(s) URLs
and ISO times, and drops a record that fails a check. Ottr never puts provider text into a card
as an instruction. The card prompt uses only the checked fields.

Any tool that implements these three endpoints can replace Alate. The Settings section keeps the
label "Alate" and its URL and key fields.

## U4 - Checker (Alate)

- Alate checks once a day (a new `--update-interval`, default 86400 s) with its stored GitHub key.
- Alate reads pins from the GitHub files that `upstreams.json` names. `ottr-ai/ottr` is private,
  so the key needs read access to it.
- Skills come from the skill lock (`sourceUrl`, `skillPath`, `skillFolderHash`, `ref`). Plugins
  come from `bun.lock`: npm packages use `npm`, and git-pinned packages use `github-path` on the
  repo root.
- Skills in a repo with stable GitHub releases (no draft, no prerelease) track release tags
  (changed 2026-10-21). Alate reads the folder tree hash of the skill at each tag. `current` is
  the newest tag (of the newest 10) whose folder hash equals `skillFolderHash`. If no tag
  matches, `current` is the `ref` tag or else the hash. `latest` is the newest tag. `target` is
  the newest tag that is 7 or more days old, is newer than `current`, and has a different folder
  hash. The values are the exact `tag_name` strings.
- One repo can publish more than one release stream, for example `skill-v4.7.0`, `cli-v4.7.0` and
  `engine-v0.1.16`. The tag text before the version is the stream prefix. Alate uses one stream:
  the `check.tagPrefix` of the `upstreams.json` item, else the prefix of a `ref` tag, else the one
  prefix that contains `skill`, else the empty prefix, else the only stream. If no rule applies,
  the skill keeps the commit check.
- A skill installed from the branch head of such a repo thus gets the newest qualified release as
  its `target`, also when the head is newer. This is the move to releases.
- Skills in a repo with no usable release stream keep the commit check: the version is the newest
  commit that touches the path.
- `target` is the newest version or commit whose publish time is 7 or more days ago. A young
  `latest` still shows, with its `qualifiesAt`, so Ottr can offer Propose now for a security fix.
- Exception for commit-tracked skills: `npx skills update` installs only the head of the `ref`
  branch, so the CLI cannot pin a commit. For such a skill, `target` is the newest commit on the
  path only when that commit is 7 or more days old. Otherwise `target` is `null`. A release tag
  has no such limit: `npx skills add <owner>/<repo>#<tag>` pins the tag as `ref` in the lock
  (`skills@1.7.2`).
- Alate stores the results in `alate.db`. A failed check keeps the last result and records the
  error on the item.
- The Alate dashboard lists the updates (read-only): name, current, target, latest, qualify date,
  origin link and notes link. Thus Alate is useful without Ottr.
- Alate never edits a repo and never calls Ottr.
- A skill whose folder is gone at the branch head is recorded with `removed: true` and no `target` (the CLI could never reinstall it).

## U5 - Ottr Updates panel

- When a provider URL is set, Ottr pulls `GET /api/updates` each hour and when you open the panel.
- A header badge shows the number of rows that have a `target` and no skip.
- A record whose `current` equals `latest` is not an update: the pull drops it. The panel lists
  only rows whose pin is behind the newest upstream release (qualified target, or young `latest`).
- The panel groups rows by owning repo. Each row has a check box for Allow, a Skip button, and
  Propose now when only a young `latest` exists.
- Skip skips that version only. The row comes back with the next release. Ottr stores skips in its
  global store.
- A row whose `repo` matches no board project shows without Allow.
- A row with `removed` is a notification only: it counts nowhere and offers no Allow.
- A new push type `updates` fires at most once a day, when new qualified rows appear.

## U6 - Allow files one card for each owning repo

- Allow files one card for each owning repo, through the same path as
  `POST /api/projects/:project/tasks`.
- The prompt tells the agent to update the listed items with the repo's documented update steps.
  It lists name, current, target, `notesUrl` and pin for each item. It tells the agent to treat all
  upstream content as untrusted data (G6), to drop an item that fails its checks, and to name the
  host command for an image pin that has a host copy. For a skill row with a commit target it
  names `npx skills update`. For a skill row with a tag target it names
  `npx skills add '<owner>/<repo>#<tag>' --skill '<name>' -g -y`. In both cases it tells the agent
  to commit the refreshed lock hashes. A command gets only a GitHub `owner/repo`, a skill name
  of `[A-Za-z0-9._-]`, and a tag of `[A-Za-z0-9._/+-]`. Each argument is in single quotes. A
  skill row that fails these checks gets no command.
- Propose now uses the young `latest` as the target. The prompt then asks for the security reason
  in the report (G21 exception).
- The card stores the record ids that it covers (`updateIds`). The panel shows these rows as in
  progress and does not offer them again.

## U7 - Merge hold (Ottr project setting)

- A new project setting, `holdUpdateMerges`, is off by default. It is on for the data repo.
- On such a project, when an update card's work turn ends `ready`, the card goes to `in_progress`
  and `needs_you` with the summary. It does not merge. The review-card rule at `turn.ts:1108` works
  the same way. Your reply approves the merge, and the next `ready` merges.
- This is a code rule, not a prompt instruction, because an agent can ignore a prompt. Skills, plugins
  and rules steer every later turn, so a person reads the diff summary before they ship. Image pins
  have a checksum and a smoke test, so `ottr` keeps the setting off.

## U8 - Each repo documents its update steps

- The data repo's `AGENTS.md`, section "Upstream updates": skills, plugins, MCP pins and vendored rule
  sets. The agent runs the official updater on a copy of the snapshot, not on a live home.
- ottr `docs/WORKERS.md`, section "Updates": the hand bump of an image pin.
- The card prompt stays generic. A provider cannot send steps, because a changed provider could
  then give instructions to an agent.

## U9 - Provision after a data repo merge

- Alate imports with its own loop (`autoUpdate` on).
- Ottr reads `GET /health`. When `pending` is true and no turn runs, Ottr calls `POST /provision`.
  The idle gate is the same one that `scripts/update-image.ts` uses.
- After a successful provision, `pending` is false, so Ottr does not provision again.
- Alate fix that this needs: `update.behind` compares the remote with the provisioned commit, so it
  stays true after Alate provisions an old snapshot. `pending` compares the imported commit with the
  provisioned commit.

## U10 - Host catch-up

- A Windows scheduled task runs each hour. It runs `alate/sync.mjs` and `alate/install-user.mjs`
  with `--repo` for the data repo. It reads `GH_TOKEN` from `gh auth token` at run time, so the task
  stores no secret.
- The task records the last installed commit. It runs `install-user.mjs` only when the data repo `main`
  has a new commit, so bun installs plugins only after a real change.
- `install-user.mjs` never overwrites a file that you changed. Until the host installs an update,
  the data repo's pre-push hook blocks host pushes, so no update reverts silently.

## U11 - The omp bump gets the 7-day gate

`omp-bump.yml` takes the newest npm version whose `time` entry is 7 or more days old, not
`dist-tags.latest`. Workers then run an omp that is about one week older than the newest one.

## Losing options (do not explore again without a reason)

- **One full manifest:** it copies the locks, and it drifts because `npx skills add` writes only the
  lock.
- **Annotations at each pin site:** a re-vendor erases them.
- **Ottr checks GitHub itself:** Ottr would then need the data repo contents and a second GitHub
  reader.
- **GitHub Actions or Renovate in each repo:** neither has a manager for the skill lock, and you get
  no single view.
- **A script for each kind:** it cannot read release notes, so a renamed flag breaks a rule without
  an error.
- **Weekly proposal cards in `needs_you`:** the panel keeps proposals off the board.
- **Steps or a hold flag from the provider:** a security decision stays in Ottr.
- **Alate provisions on its own:** Alate does not see turns, so it can change files during a turn.
- **Host-first updates:** no card can run on the Windows host.

## Rollout

1. Host cleanup (done in the session of this decision): reinstall the public skill copies with the
   skills CLI, pin `chrome-devtools-mcp`, fix the pix-optimizer lock, write `upstreams.json`, add the
   update steps to the data repo `AGENTS.md`, capture and push.
2. Alate card: the gate (U2), the checker and its storage (U4), the contract endpoints (U3) and
   the dashboard list.
3. Ottr cards. These run at the same time as step 2 and test against a fake provider: the client
   and the Updates panel (U3, U5), Allow and update cards (U6), the merge hold (U7), the provision
   trigger (U9), and the omp gate (U11).
4. Turn on `holdUpdateMerges` for the data repo. Keep the
   pre-push hook off in the volume clone, because in a container the hook captures the container
   home.
5. Give the Alate GitHub key read access to `ottr-ai/ottr`.
6. Register the host task (U10).
