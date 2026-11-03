# Text marker for project icons (OTTR-430)

## Problem

A board whose projects all point at GitHub shows the owner's avatar for every
one of them: five projects, five identical icons, nothing to tell them apart
at a glance. An uploaded icon fixes one project but needs an image file, and
the fallback monogram is unreachable while a source icon exists. There is no
way to replace the default icon with a few letters of the user's choice.

## Behavior

1. Project settings gain `iconText: string | null` (default `null`). The
   setting lives in the per-project settings JSON in `tasks.db`
   (server-only state), validated per key by `SETTINGS_SHAPES` like
   `displayName`. No schema migration: `parseSetting` reads a JSON object
   per key, and `parseSettingsPatch` (`src/app.ts`) validates the API patch
   before the store touches it.
2. Precedence in `ProjectTag` (`src/ui/kit.tsx`), first match wins:
   1. `iconText` set (non-empty after trim): the plate shows the marker text,
      no image loads;
   2. uploaded icon: the image shows, as before;
   3. source icon: GitHub owner avatar or host favicon, as before;
   4. monogram of the project label, as before.
   The marker wins over the upload because its purpose is to override
   whatever image would otherwise show; clearing the marker text brings the
   upload back.
3. Validation: `iconText` must be a string or null, at most 4 characters
   after trim, no control characters (`\p{Cc}`); an empty string stores as
   `null`. The settings input caps the length at 4.
4. The settings Icon card gains a "Text marker" row: a text input that saves
   with its own Save button (Enter submits the form), styled like the other
   typed rows. The card's status chip names what currently shows: "Text",
   "Uploaded", or "Default".
5. The plate keeps its fixed height and widens to the text (`.ptag.tag-text`),
   so 3–4 characters never clip.

## Boundaries and error cases

- A save with more than 4 characters (a hand-built API call) gets HTTP 400
  and leaves no half-applied patch.
- A corrupt stored value (wrong shape) falls back to the default `null` in
  `getSettings`, like every setting.
- The marker renders as typed (case and characters preserved); it is
  display-only and never sent to git, prompts, or the API as a project id.

## Acceptance checks

- Setting `iconText` on a project with a GitHub remote replaces the owner
  avatar on the board, in the drawer header, and in the settings preview.
- Clearing the field restores the previous image chain.
- A project with an upload and a marker shows the marker.
- API: 400 on a 5-character value, on a non-string, and on control
  characters; an empty string stores null.
- Store: `iconText` survives a reopen and resets to null.

## Non-goals

- No per-task or per-branch markers.
- No color or style picker for the marker text.
- No change to how `displayName` or the monogram fallback derive.
