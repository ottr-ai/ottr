# Project onboarding (2026-10-18)

Status: accepted. The chosen design is the wizard and checklist, the Fork research
pre-check, and the Align rules offer with Skip.

## Problem

A new user adds a project and sees an empty board. The features that make Ottr more than
a task runner are off by default and live at the bottom of the project settings page:

- Retro (`retroSince`, default `null`) and its friction filter (`retroFilter`).
- Fork research (`forkResearch`, default `false`).
- Hold merges of update cards (`holdUpdateMerges`).
- Align rules (the **Align rules** button in the project header, `POST /api/projects/:project/interview` with `{fix:true}`).

The live board proves it: 460 cards and no retro or fork proposal ever.
`AddProjectModal` (`src/ui/app.tsx`) closes after **Add** and shows only a notice. It
does not show settings, the rules state or the repo facts.

## Behavior: the wizard, then a checklist for skipped items

The Add project dialog becomes a short wizard with four steps. Step 1 is the current form.
Each later step writes its result at once through the existing routes, so a closed
dialog never loses a saved choice. The project exists after step 1. **Finish later**
on any step closes the dialog. The defaults stay as they are today.

1. **Source.** The current Git URL and New tabs ([docs/specs/git-hosts.md](git-hosts.md)).
   The Git URL tab accepts any git URL: `https://…`, `git@host:…` or
   `ssh://[user@]host[:port]/…`. Ottr proposes the last path segment without `.git`
   as the project name; the field stays editable. An HTTPS clone that fails with an
   auth error asks for a token for that host. An SSH URL asks you to confirm the
   host-key fingerprints and to pick the global key or a new pending key. **Add** runs
   `POST /api/projects` and goes to step 2.
2. **Rules.** Shows the rules state from the add response:
   - No `AGENTS.md`: the rules interview card is already filed (today's behavior). The step says so and links the card.
   - `AGENTS.md` exists: offer **Align rules now** (`POST .../interview` with `{fix:true}`) or **Skip**.
   - Gitless project: show **Init git repository** first (the existing action).
3. **Automation.** One panel per feature. Each panel says what the feature does, what it costs, and how its result shows on the board:
   - Retro, with the friction filter under it.
   - Fork research, with the GitHub facts (below). The panel is hidden for a project without a GitHub remote.
   - Hold merges of update cards.
   Each checkbox saves through `POST /api/projects/:project/settings` on change.
4. **Runners.** `maxParallel` and `copyExtra` (for example `.env`), with the current values. **Done** saves them, sets `setupChecklist` to `false` and closes the dialog.

**Finish later** on steps 2 to 4 sets `setupChecklist` to `true` and closes the dialog.

### Setting `setupChecklist`

A new project setting `setupChecklist: boolean` (default `false`). It is a row in the
existing `settings` table, so no schema change. `POST /api/projects` sets it to `true`
for the new project. The settings route accepts it as a boolean.

### Checklist on the board

When `setupChecklist` is `true`, the board of the selected project shows a panel
"Finish setting up <project>" above the lanes. It lists only the open items:

- No Rules item: the board already shows the "No AGENTS.md yet" banner with **Start rules interview** above the checklist.
- Retro: open while `retroSince` is `null`. **Turn on** saves `{retro:true}`.
- Fork research: open while `forkResearch` is `false` and the project has a GitHub remote. **Turn on** saves `{forkResearch:true}`.

The panel also has **Open setup** (the wizard at step 2) and **Dismiss** (saves
`setupChecklist: false`). With no open item, the panel does not show.

### Run setup again

The project settings page has a **Run setup again** button. It opens the wizard at step 2
for that project.

### GitHub facts for the fork panel

A new route `GET /api/projects/:project/github` returns:

```ts
{ repo: string; forks: number; active: number; recent: { owner: string; name: string; pushedAt: number }[] }
```

- `forks`: all forks from `listForks` (`src/forks.ts`), the code that the hourly watch already uses.
- `active`: forks with `pushedAt` in the last 90 days.
- `recent`: the five forks with the newest `pushedAt`.

The step shows "12 forks, 3 pushed in the last 90 days" and the five recent forks. If
`active > 0` and Fork research is off, the checkbox starts checked, and the hint says why.
**Next** saves the pre-check. **Finish later** does not, so the checklist keeps the item.
If the call fails, the panel shows the error text and keeps the checkbox unchecked.

## Boundaries and errors

- The wizard never changes a setting that the user did not touch, except the Fork research pre-check when `active > 0`. The user sees and can clear that check before **Next**.
- One new setting key (`setupChecklist`). No new table or column. No schema change.
- A failed settings save shows the error on the step and keeps the dialog open.
- `gh` missing or not logged in: the fork panel shows "GitHub facts unavailable: <error>". The rest of the wizard works.
- A project without a GitHub remote never shows the fork panel or the fork checklist item.
- A host whose key is unknown answers `409 TrustNeeded`; the user confirms the fingerprints, and the request repeats. See [docs/specs/git-hosts.md](git-hosts.md).
- A failed save-time `git ls-remote` test stores no credential; the step shows the redacted error.

## Acceptance checks

- Add a GitHub project with forks. Step 3 shows the fork count, the active count and up to five forks.
- Turn Retro on in step 3, then close the dialog. The settings page shows Retro on.
- Add a project with `AGENTS.md`. Step 2 offers **Align rules now**. A click files one interview card.
- Add a New project without GitHub. Step 3 hides the fork panel.
- Keyboard only: Tab reaches every control, Escape closes, the step list announces "Step 2 of 4".
- Add a project. The board shows the checklist until each item is on or the user dismisses it.
- **Run setup again** on the settings page opens the wizard at step 2.
- `bun run check` and `bun test` pass. A test covers the `active` and `recent` computation and the `setupChecklist` validation.

## Non-goals

- No guided tour or spotlight overlay on the board.
- No guided tour of the board for existing projects. They get **Run setup again** only.
- No ahead/behind counts per fork. `pushedAt` is enough to say "active". Add a compare call when a user asks for it.
- No change to the first-run admin setup (`/api/boot.onboarding`).
