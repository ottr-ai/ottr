# Late commits on the release Approve step

A release review is pinned to one commit (the card's base). The publish tags the target's
head at approval time (`src/turn.ts` publishReleaseCard, `src/release.ts` publishRelease),
so every commit between the reviewed commit and that head ships in the tag. Today the user
sees them only after the publish, listed as one "## Late fixes" block, even when a commit
landed outside the board during the review (example: Release v0.3.0 reviewed `a6f601f`;
`a939296` "feat: align settings pages…" landed after the pin and shipped unreviewed,
labeled a fix).

## Behavior

- While a release card waits for approval (state `needs_you`, not cancelled), the drawer
  detail carries `lateCommits`: the commits in `<base>..<target head>`, the same range
  `publishRelease` lists. The drawer shows a "Commits since the review" section directly
  above the Approve action: short sha, subject, and a text mark. A commit that is the merge
  of a card the review filed (a finding card) is marked "review fix"; every other commit is
  marked "not reviewed". No late commits: the section stays hidden.
- Attribution: each done finding card stamps `merge_head` (the integration target head at
  its Done write, the same moment `commits` is stamped). The finding heads, in done order,
  cut the range into segments: commits after the previous anchor (the reviewed commit for
  the first segment) up to and including a finding head belong to that finding's merge.
  Every other commit is not reviewed.
- The drawer repolls every 5 s while the card waits, so the list follows the target while
  it moves.
- The publish behavior stays: the tag goes on the head, the review fixes stay in. The
  planned notes gain the late commits grouped by Conventional Commit type — `feat` under
  "## New features", `fix` under "## Bug fixes", everything else (including subjects
  without a type) under "## Other changes" — each not-reviewed commit with
  ` (not reviewed)` after its subject. The "## Late fixes" heading goes away. With no late
  commits the notes stay exactly as today.
- A late commit whose body carries `Supersedes: <sha>` (or the `Reverts:`/`This reverts
  commit` forms) drops the named commit's bullet while the canceller is in effect — the
  same rule the planned notes already apply (`droppedCommits`), now over the late range.

## Boundaries

- Non-goals: a tag pinned to the reviewed commit; a block on late commits; changes to the
  release-command path (a release command owns its own notes; Ottr passes only the planned
  notes file, unchanged).
- The mark needs `merge_head`, so finding cards that finished before this change (null)
  mark their commits "not reviewed" — under-labeling stays visible, never falsely
  reassuring.
- A commit pushed from outside the board between the reviewed commit and the first
  finding's merge sits inside the first segment and shows as "review fix" (ponytail; later
  segments are exact because each finding head anchors them).
- The list reads the target head without a fetch, so an outside push appears after the
  next fetch (any release action or board merge updates the remote-tracking ref; board
  moves show within the 5 s poll).
- `merge_head` is additive (`ALTER TABLE tasks ADD COLUMN merge_head TEXT`, idempotent
  backfill in `ProjectStore.open`); no CHECK constraint changes, so no table rebuild.

## Acceptance

- `src/release.test.ts`: a real git fixture with a reviewed commit, one finding-card merge
  (`fix:`) and one outside `feat:` commit after it — the notes put the feat under
  "## New features" with ` (not reviewed)`, the fix under "## Bug fixes" without a mark;
  a late `Supersedes:` trailer drops the named commit's bullet; with no late commits the
  notes come back unchanged.
- `src/app.test.ts`: the drawer route returns `lateCommits` (sha, subject, marks) for a
  waiting release card over a real repo and omits it for other cards.
- `src/ui/app.test.tsx`: the drawer lists both commits above the Approve action and marks
  only the outside commit "not reviewed"; with no late commits no section renders.
- `src/store.test.ts`: `mergeHead` round-trips and survives a store reopen.
- `bun run check` and `bun test` exit 0. Rendered proof of the drawer section for the card.
