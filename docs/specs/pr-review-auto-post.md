# Automatic posting of PR reviews

A project can post each finished PR review draft to GitHub by itself. The
setting `prReviewManualPost` keeps the old behavior on by default: a draft
waits, a person edits it and clicks Post. With the setting off, the board
posts the draft through the same code path the Post click uses. The event
choice, the head claim, and the error handling are the Post click's.

This spec extends [pr-reviews.md](pr-reviews.md). pr-reviews.md keeps the
watcher, the draft runs, the Post route, and the store details.

## Setting

- `ProjectSettings.prReviewManualPost: boolean`. The default is `true`.
- `DEFAULT_SETTINGS` in `src/store.ts` holds the default, and
  `SETTINGS_SHAPES` declares `"boolean"`, so an older database with no stored
  value reads `true`: the default is the migration.
- `POST /api/projects/:project/settings` accepts `prReviewManualPost` in the
  boolean list. A value that is not a boolean gets 400
  `prReviewManualPost must be a boolean`.
- Project settings show a checkbox under the PR review rows, named
  `Only post reviews after manual approval`, with the description
  `Turn off to let the board post each review draft by itself.` The row is
  disabled until `prReviews` is on, like the approve and request-changes
  rows. The settings search reads the row through its `settingKey`.

## Behavior

- The hook point is the watcher's draft save (`reviewOnce` in `src/prs.ts`).
  When a run saves a draft and the project's `prReviewManualPost` is `false`,
  the watcher calls the `postDraft` seam once for the saved draft.
- The seam lives in `src/app.ts`, beside the Post route. It runs the same
  steps in the same order as the Post click:
  1. Read the project's entry, the card, and the row; stop quietly when the
     project or card is gone.
  2. Claim the head with `claimPrPostCard`: the same state refusals, the same
     atomic claim, and the same event choice (`REQUEST_CHANGES` when
     `prReviewRequestChanges` is on and the run found blocking findings,
     `APPROVE` when `prReviewApprove` is on and the run was clean, else
     `COMMENT`; an unknown verdict never approves or requests changes).
  3. Send the review through `postReviewViaApp` first, then
     `postReviewViaGh`: the same 422 downsizing, the same footer and inline
     comments, the same `commit_id`.
  4. Parse the result, dismiss a superseded request-changes review, store
     `posted_url`/`posted_login`/`posted_event`, baseline the comment watch,
     and call `syncPrCard`. While the PR stays open, the card leaves `needs_you` for the posted wait (`in_progress/idle`, reason `PR_REVIEW_POSTED`); a close or merge during the post lands it at `done/idle`.
     The post also resolves the fixed findings' review threads (see
     "Resolve fixed threads" in [pr-reviews.md](pr-reviews.md)).
- One post per head. The claim decides: a second run for the same head loses
  the claim and posts nothing. The one-draft-per-head review gate already
  keeps the watcher from re-reviewing a posted head.
- The automatic post records `posted_via = 'auto'`; the Post click records
  `posted_via = 'user'`. The column is `pr_review.posted_via TEXT`, additive
  in the `SCHEMA` text and migrated in `ProjectStore.open` with the
  `posted_event` pattern. `savePrReview` never writes it.
- A failed automatic post releases the claim and stores the error in
  `post_error` (the Post click's failure path). The card stays at
  `needs_you` with the error and the draft, so the user can post by hand.
  The watcher logs `[pr] <project>: #N auto-post failed: <reason>`; a
  refusal (409) logs the same line and changes nothing.
- The automatic post takes no daily-cap slot: the cap counts model runs, and
  the post is not one.

## Turning the setting off

- Drafts that already wait for a click stay waiting. The setting applies to
  the next finished review run; a later re-review of a waiting head runs one
  (the reply flow or a force-push) and that run's draft posts by itself.
- Turning the setting on again changes nothing for posted heads.

## Notification

- A project with `prReviewNotify` off notifies nothing, as before.
- When an automatic post completes, the frame's complete event says that the
  board posted the review. `AlertCardInput` carries `prPosted`: the PR URL
  when the row's last post is the board's and still current
  (`posted_via = 'auto'`, `posted_head === reviewed_head`, PR `open`),
  else null.
  - The push body is `Ottr posted the review on GitHub`; the payload URL is
    the PR URL, so the push opens the pull request. Without the URL the
    event falls back to the card drawer.
  - The bell's PR review activity group gains a row for a stamped card:
    project, `PR #N`, and the text `Ottr posted the review on GitHub`, as an
    external link to the PR. The row's key is `pr:<taskId>:posted`; it
    counts in the alarm line and clears when the stamp clears (a new head, a
    manual post, a closed PR). The seen prune keeps the key only while the
    stamp is current.
- A manual Post raises no complete event: the user posted the review.

## Acceptance checks

- `DEFAULT_SETTINGS.prReviewManualPost` is `true`; a fresh store and a
  reopened store read `true`; a stored value persists across reopen; a
  non-boolean value gets 400 `prReviewManualPost must be a boolean`.
- Fake-gh tests:
  - Setting on (the default): a finished run saves the draft and sends no
    reviews POST without a click.
  - Setting off: a finished run sends exactly one POST
    `repos/<owner>/<repo>/pulls/N/reviews` with the reviewed head as
    `commit_id`; a clean run with `prReviewApprove` on sends event
    `APPROVE`; a blocking run with `prReviewRequestChanges` on sends
    `REQUEST_CHANGES`; both off send `COMMENT`.
  - A second run for the same head (the reply flow) sends no second review.
  - A failed post (gh exit 1) parks the card: `post_error` holds the error,
    the card stays `needs_you` with the draft, and the claim is released.
  - The card of a successful automatic post sits at the posted wait (`in_progress/idle`, reason `PR_REVIEW_POSTED`) with a stored `posted_url`; it reaches `done/idle` when the PR merges or closes.
- A live database gains `posted_via` on open; a fresh database creates it
  with the table. `savePrReview` never clears it.
- The auto-posted card's complete event (`prPostedEvent`, keyed by the posted head) carries the auto-post body and the PR URL; it fires whatever place the card takes. A manual post raises no event: the user posted the review, and the card stays on the board at the posted wait. With `prReviewNotify` off the auto-post event does not fire.
- The bell shows the posted row with the external PR link; the alarm count
  includes it; opening the seen set clears the new mark.

## Non-goals

- Merging PRs, dismissing reviews beyond the existing request-changes rule,
  and the wording of the review prompt.
- A retry loop for a failed automatic post: the next review run for the head
  is the retry, and only a person can ask for one (the draft gate holds).
- Posting drafts of closed or merged PRs.
- The add-project wizard gains no checkbox for the setting; new projects use
  the default.
