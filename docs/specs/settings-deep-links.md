# Settings deep links

Links that open the settings page and scroll to a section. The board's routing is
path-based (`/settings`, `/settings/<project>`); this spec adds the section part of
the URL and moves the settings links that still speak the removed hash scheme.

## URL shapes

- `/settings#<section-id>` — General, scrolled to the section.
- `/settings/<project>#<section-id>` — that project's page, scrolled to the section.
- `<section-id>` is a TOC id of the target page: a section card id (`git-hosts-section`)
  or a block id (`github-token-block`), percent-encoded at most once, decoded at most once.

## Behavior

- Opening a deep link — cold load, an in-app link, Back/Forward — opens the settings
  page the path names and scrolls to the section once it exists; async sections wait
  the scroll out. The TOC pins the target as current until the user scrolls, like a
  TOC pick.
- An unknown or malformed fragment opens the page normally without scrolling.
- `migrateHash` rewrites a legacy hash URL only when the pathname is `/`. The legacy
  scheme only ever produced root URLs; a fragment on any other path is meaningful and
  stays.
- Programmatic settings navigation (`settingsNavigate`) pushes the URL as a history
  entry and walks the app's popstate path, so the view and drawer state change exactly
  like a Back/Forward entry.

## Links that move to the path scheme

- The settings sidebar's General and project anchors render real path hrefs; a plain
  click navigates in-app, a middle or modifier click opens the href.
- `openSettingsSection(sectionId, view)` navigates via `settingsNavigate` and keeps
  its scroll poll. Every existing caller (advisory "Open settings" buttons, setup
  hints, the project drawer's token hint, the TOC) gains a working cross-view link.
- After a project rename, the settings page moves to the renamed project's path.
- After removing a project, the settings page moves to `/settings`.
- Server warning lines linkify phrases of the form `Settings → <label>` and
  `Settings - <label>` (separators `→`, `->`, `-`, `–`, `—`). A label resolves by
  exact match against the General page's TOC labels, sections and blocks. A chain
  like `Settings → GitHub → GitHub token` links the whole phrase to the deepest
  resolved id. An unresolvable label stays plain text. The existing `https://` rule
  is unchanged. An internal link navigates in-tab on a plain click; middle and
  modifier clicks open the href, so the URL must be a real deep link.

## Error cases

- A fragment decoding failure is ignored, not fatal.
- A fragment naming a section that is not on the current settings page is ignored.
- The path still selects the page; the fragment only selects the section.

## Acceptance checks

- `route.test.ts`: legacy hashes migrate at `/` and nowhere else; `settingsNavigate`
  pushes the exact path (plus fragment) and dispatches `popstate`.
- `settings.test.tsx`: a rendered settings page with `#git-hosts-section` pins the
  matching TOC row (`aria-current="location"`) and scrolls to it; a popstate to
  another fragment moves the pin; `openSettingsSection` pushes `path#fragment`.
- `app.test.tsx`: `warningLinks` renders the GitHub App check message's
  `Settings - GitHub App` as an anchor to `/settings#github-app-block` with the
  trailing period outside, and the renamed-card label `Settings - Git hosts` of a
  stored notice still links to `/settings#git-hosts-section`; a nested arrow chain links to the block id; an unknown
  label stays text; `https://` links keep `target="_blank"`.
- Browser: a cold `/settings#git-hosts-section` lands on General at GitHub; the
  advisory link opens it; the sidebar switches pages; Back walks the entries.

## Non-goals

- No server changes. No project-page labels in the warning dictionary. No new
  dependency. No README change (the README documents settings by name, not by URL).
