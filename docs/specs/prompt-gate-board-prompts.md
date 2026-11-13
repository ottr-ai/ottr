# Spec: skip the prompt gate's model call for board-written prompts (OTTR-850 P2)

## Goal

The prompt gate (OTTR-823) judges prompts a person wrote. Prompts the board itself
writes (templates, agent-filed finding and proposal cards) are already complete, so
the gate's model call for them is waste: it costs tokens and parks cards the board
filed with every check attached. This change records who wrote a prompt, skips the
gate's model call for board-written prompts, keeps the deterministic "Open
questions" park, and makes each board template and the card-filing tools name their
outside check.

## Behavior

1. New column `prompt_author TEXT NOT NULL DEFAULT 'user'` on `tasks`:
   - lives in `TASKS_DDL` (src/store.ts) and gets the usual `addColumn` ALTER in
     `ProjectStore.open` next to `gate` (before the CHECK rebuilds, so a rebuild
     recreates it from the DDL);
   - existing rows backfill to `user`, so old cards keep today's behavior;
   - `Task`, `ListedTask`, `TaskRow` carry `promptAuthor`; `TaskPatch` accepts it;
     `promptAuthor` is optional on `Task` (absent behaves as `user`), matching the
     other hand-built-fixture-friendly fields.
2. Authorship writes:
   - `ProjectStore.editTask` sets `promptAuthor: "user"`: a user edit of the prompt
     (Edit task route, or Edit before Accept on a held proposal) makes it
     user-authored again.
   - Every createTask site that builds the prompt from a template, or files an
     agent's proposal or finding, sets `promptAuthor: "board"` in the synchronous
     `updateTask` that already follows the create (no await between the create and
     the write, so no scheduler tick sees the row in between):
     - src/turn.ts: retro proposals (fileRetroProposal), review findings and leads
       (fileKeptFindings);
     - src/store.ts: fork result card and fork proposals (createForkResult),
       trending proposals (fileTrendingProposal), pr_review cards.
     - src/ompWatch.ts: fail card and bump card;
     - src/trending.ts: the weekly scout card;
     - src/supervisor.ts: retro card (retroPass), CI merge-push follow-up
       (ciFileFollowUp), Dependabot cards;
     - src/app.ts: update cards and remove cards, the architecture-review card
       (fileArchReview), the rules-interview card, Dependabot refile, the
       board-check card, the release card.
3. Server-side detection for the two routes where the caller decides the text:
   - `POST /api/projects/:project/tasks` serves the user's New task form and the
     agent's create_task tool. The server checks the `x-board-token` header against
     the boot token (`deps.board.token`) or a live VM token — never a client-sent
     flag. A valid token means agent traffic: the card files as `board`; anything
     else files as `user`.
   - `POST .../tasks/:id/follow-up` serves the UI's "Implement steps" button. The
     server compares the posted text with `IMPLEMENT_RECOMMENDATIONS` (moved from
     src/ui/app.tsx to src/prompts.ts so server and UI share one constant). An
     exact match files as `board`; any edited text files as `user`.
4. Gate (src/turn.ts `promptGateTurnStart`): after the deterministic Open questions
   park and before the model call, a `board` prompt with no queued user text
   (`pendingPrompt` null and no accumulated `seen` text) skips the model call and
   logs one line. The order matters:
   - the Open questions park runs first, so a board prompt that carries an Open
     questions section still parks needs_you with no model call (VELV-97,
     VELV-100);
   - queued user text (pendingPrompt from a reply or steer) is judged as today:
     when pending or seen text exists, the model runs on prompt plus user text;
   - board prompts stamp no gate fingerprint, so a later user edit (author flips
     to `user`) runs the gate fresh.
   `gateApplies` keeps its current kind and flag skips.
5. Outside checks named in templates and tools (wording approved by the user on
   2026-11-12 for this card):
   - `IMPLEMENT_RECOMMENDATIONS` gains: "Run the checks that the steps name and
     report their results before you report ready."
   - CI follow-up (supervisor ciFileFollowUp) gains the line: "Check: the failed
     workflow passes again on the merge push." — also in the no-handoff fallback
     prompt.
   - `dependabotPrompt` gains: "Check: the alert shows fixed on GitHub, and the
     project's check and test commands from AGENTS.md pass."
   - `ompBumpCardPrompt` gains: "Check: the image builds with the new pin, and omp
     starts on its bun."
   - the omp fail card (`ompFailCardPrompt`) gains: "Check: the report names, for
     each reason, whether Ottr needed a change, with the command or source line
     that shows it."
   - `trendingScoutPrompt` gains: "Check: every candidate has a recorded verdict
     (proposal, no_fit, or deferred)."
   - create_task and propose_task (extension/tracker.ts, texts mirrored in
     src/prompts.ts `PROPOSE_TOOL_DESCRIPTION` / `REVIEW_PROPOSE_TOOL_DESCRIPTION`):
     the prompt must carry an "Acceptance" section with at least one non-empty
     line. A call without one returns a clear error text and files no card, so the
     agent fixes it in the same turn.

## Boundaries and error cases

- Old databases: `addColumn` backfills `user`; the CHECK rebuilds copy the column
  (it lives in `TASKS_DDL`, so the rebuilds recreate it with its default).
- An old extension (no Acceptance check) can still file agent cards; they skip the
  gate as board prompts. The extension is the enforcement point for the tool
  contract; the server route adds no Acceptance rule, because the same route serves
  the user's New task form, where prompts need no Acceptance section.
- A user who sends the boot token with a hand-built request files board prompts;
  the token is a secret only runners hold, the same trust `agentRefusal` already
  grants.
- Prompts that already sit parked (OTTR-838/839/841/842/843, CLIP-36, VELV-97,
  VELV-100) keep their current asks; the change does not rewrite stored prompts.

## Acceptance checks

1. A card a review filed (create_task / recorded finding) starts its first work
   turn with the gate stub never called.
2. The same card after a user prompt edit (`editTask`) calls the gate.
3. A board prompt with an "Open questions" section parks needs_you with no model
   call.
4. An old-schema database (tasks table without `prompt_author`) opens, and its
   existing rows read `promptAuthor: "user"`.
5. create_task without an Acceptance section returns an error and files no card
   (the test listener's request count stays zero).

## Non-goals

- The gate's rules for user prompts: unchanged.
- Issue cards (fileIssueCard) and Jira cards (fileJiraCards) stay user-authored:
  their prompts embed the issue or ticket text a person wrote, and their
  templates name no outside check, so the gate keeps judging them.
- The wording of src/prompts.ts review/release/interview/grill/board-check
  templates (their cards skip the gate by kind or flag already).
- propose_repo (trending proposal prompts are agent-written and file as backlog
  cards a user starts).
- update/remove card template wording (updates.ts), not in this card's list.
- The cards already parked on the board.
