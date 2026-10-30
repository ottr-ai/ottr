# Automatic PR reviews

A project can let Ottr review its open GitHub pull requests. Ottr files one review card for each PR. The server asks the model for a draft review in one tool-free call, as fork research does. A person edits the draft and clicks Post. Ottr then sends one GitHub review with the `COMMENT` event.

No agent runs over PR code. An agent turn in a checkout of the PR was the first design. The merge security review rejected it: omp loads project config and user MCP tools from the cwd, and no flag turns all of them off. So a PR could run code through the agent.

## Behavior

### Setting

- `ProjectSettings.prReviews: boolean`. The default is `false`.
- `POST /api/projects/:project/settings` accepts `prReviews`. A value that is not a boolean gets 400 `prReviews must be a boolean`.
- The watcher works only when `prReviews` is true and the project has a GitHub repo (`project.github !== null`). In other cases, the watcher makes no `gh` call for the project.
- Project settings show a "PR reviews" checkbox next to "Fork research".

### Watcher (`src/prs.ts`)

- `createPrWatcher({ projects, log, gh?, now?, review?, spawn? })` returns `{ tick(opts?: { manual?: string }): Promise<void> }`. A second `tick` while one runs returns the same promise (single flight). `review` is the model call. It defaults to `runGateway` (`omp auth-gateway stdio`, the fork research path) with the omp role `@plan`. Fork research and other gateway calls keep `@default`. `spawn` replaces the process call of the default review in tests.
- `server.ts` runs `app.prReviewTick()` at start and every hour.
- `POST /api/projects/:project/prs/check` runs `tick({ manual: project })`. An unknown project gets 404. A project with no GitHub repo gets 409.
- Each tick does these steps for each enabled project:
  1. List open PRs: `gh api repos/{repo}/pulls?state=open&per_page=100&page=N` until a short page. A gh failure logs the error and skips the project. Nothing changes.
  2. `parsePullPage(body)` validates each entry as untrusted data. An entry needs a positive integer `number`, a 40-hex lowercase `head.sha`, a boolean `draft`, and `state === "open"`. The title passes `stripInvisible` and is capped at 120 characters. An invalid entry is skipped, never thrown.
  3. Upsert one `pr_review` row for each open PR. A new head sets `head` and `firstSeenAt = now`. The same head keeps `firstSeenAt`.
  4. A row with `state = 'open'` that is not in the list gets one `gh api repos/{repo}/pulls/N` call. `merged_at` set means `merged`, other values mean `closed`.
  5. Review each row that passes all gates (`PR_GATES`):
     - The state is `open` and `draft` is false.
     - No saved draft of this PR has this head (one review for each head SHA, also after heads A, B, then A again).
     - `firstSeenAt <= now - QUIET_MS` (30 min).
     - The card, if it exists, is not cancelled.
     - Review attempts in the last 24 h are fewer than `PROJECT_DAILY_RUNS` (5). The cap stops the tick for that project.
  6. A review does these steps:
     1. `startPrRun` records the attempt. The attempt counts for the cap.
     2. Read the diff with `gh api -H "Accept: application/vnd.github.diff" repos/{repo}/pulls/N`. Then read the PR with `gh api repos/{repo}/pulls/N`. When its `head.sha` is not the gated head, stop: the next tick sees the new head.
     3. Call the model with the fixed `reviewSystemPrompt()` and `reviewUserMessage()`. The user message holds the title, the description (at most 20000 characters) and the diff as labelled DATA blocks. Each block passes `stripInvisible` and `redactSecrets`. A suspicious credential or a message over `PROMPT_CHAR_BUDGET` stops the review.
     4. `parseDraft` strips invisible characters, trims the text, and caps it below 65536 characters. An empty answer stops the review.
     5. `savePrDraft` saves the draft.
     - A failure logs the error. The head stays open for a retry on a later tick, within the cap.

### Store (additive)

Each project has its own store, so the PR number is the key inside it.

- Table `pr_review`: `number INTEGER PRIMARY KEY, task_id TEXT, head TEXT NOT NULL, first_seen_at INTEGER NOT NULL, reviewed_head TEXT, posted_head TEXT, state TEXT NOT NULL CHECK (state IN ('open','closed','merged')), draft INTEGER NOT NULL, title TEXT NOT NULL, post_error TEXT`.
- Table `pr_review_runs`: `id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL, started_at INTEGER NOT NULL, head TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0`. Each row is one attempt. `done = 1` marks a saved draft, so the done rows are the history of reviewed heads.
- Both tables are in `SCHEMA` (`CREATE TABLE IF NOT EXISTS`), so an old database gets them on open.
- `savePrDraft({ run, number, head, draft, prompt })` runs in one transaction:
  - No card yet: create a card with kind `pr_review`, title `PR review: #N <title>`, topic `pr review`.
  - The card gets stage `done`, state `idle`, the draft as its `details`, and a one-line summary. A card that exists gets the new prompt.
  - Set `task_id` and `reviewed_head`, clear `post_error`, and set `done = 1` on the run. Other columns stay, because the save runs after the model call.
- A `pr_review` card has no turns, no branch and no worktree. The scheduler never runs it, and the supervisor files no retro for it.

### Post

- `TaskView.prReview` holds `{ number, url, state, reviewedHead, postedHead, postError }` for a `pr_review` card.
- The drawer shows the draft (the card's `details`) in an editable text box and a Post button.
- `POST /api/projects/:project/tasks/:id/pr-review/post { body }`:
  - `body` must be a non-empty string of at most 65536 characters, else 400.
  - The card must be kind `pr_review`, in `done/idle`, and have `details`, else 409.
  - The PR state must be `open`, else 409 with the state.
  - `postedHead === reviewedHead` gets 409 `already posted for this head`.
  - Before the gh call, one SQL statement claims the head: it sets `posted_head = reviewed_head` only when the PR is open and the head is not posted. A second Post of the same head loses the claim and gets 409. So two concurrent Posts send one review.
  - Ottr runs `gh api repos/{repo}/pulls/N/reviews -X POST -f event=COMMENT -f body=<body> -f commit_id=<reviewedHead>`.
  - A gh failure (a nonzero exit or a spawn error, for example gh missing) restores the earlier `posted_head`, stores the error in `post_error`, and returns 502.
  - The route and the watcher change only their own columns after an await. A Post never changes `state`, and the watcher writes only `state` for a vanished PR.
- The Post button is disabled with a reason when the PR is closed or merged, when the head is already posted, or when no draft exists.

## Boundaries

- The only GitHub write is the Post click. The watcher reads only.
- No agent runs over PR code. The model gets the PR only as data and has no tools.
- `event` is always `COMMENT`. Ottr never sends `APPROVE` or `REQUEST_CHANGES`.
- Schema changes are additive only.

## Acceptance checks

- The toggle is off by default. With the toggle off or no GitHub repo, the watcher makes no `gh` call.
- A new non-draft PR files one card after the quiet gate. A draft PR files nothing until it is ready.
- A new push updates the same card after the quiet gate. An unchanged head adds nothing.
- A failed model call counts for the cap and retries later. A head that moves during the review saves no draft.
- The sixth review start in 24 h waits.
- Malformed entries are skipped. A gh failure is logged.
- The model message holds the PR fields only as DATA blocks after the fixed system prompt.
- Post sends one `COMMENT` review with the edited body and the reviewed head as `commit_id`. A second Post on the same head gets 409. A new reviewed head opens Post again.
- A closed or merged PR disables Post and stops new reviews.

## Non-goals

- Inline line comments.
- Running PR tests or CI.
- GitHub webhooks.
- A post without a click.
- `APPROVE` or `REQUEST_CHANGES` events.
