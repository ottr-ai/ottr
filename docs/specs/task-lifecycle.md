# Task lifecycle in the current code

## Scope and assumptions

This reference describes source baseline `3c937b96e13df94053650072e212ed2166136a98`. It records current producers and checks, not a proposed transition whitelist.

The task row has three separate lifecycle fields: `stage`, `state`, and `cancelledAt`. A turn outcome is an input to classification, not a task state.

The tables distinguish a writer's own checks from checks in its callers. A snapshot check does not become an atomic store predicate. An omitted field stays unchanged unless the store applies a documented side effect. In particular, every table row preserves `cancelledAt` unless that row explicitly changes it.

The source links use locations at the reference commit. This document changes no runtime behavior, schema, prompt, guard, skill, or recorded decision.

Related references provide design context, not proof of transition enforcement. See [PR mode](pr-mode.md), [PR reviews](pr-reviews.md), [ADR 0002](../adr/0002-ff-only-linear-history-server-only-pushes.md), [ADR 0003](../adr/0003-tasks-db-additive-migrations.md), [ADR 0007](../adr/0007-merge-target-is-a-project-setting.md), and [ADR 0008](../adr/0008-pr-mode-per-project.md). The source links below define the current enforcement.

## Fields and store enforcement

[`Stage` and `RunState`, `src/types.ts:10-26`](../../src/types.ts#L10-L26) define these values.

| Field | Value | Current use |
| --- | --- | --- |
| `stage` | `todo` | A new work card waits for its first turn. Held proposals can also remain here. |
| `stage` | `in_progress` | Work, replies, and most work-related parks use this stage. |
| `stage` | `merging` | A merge turn, a PR wait, or a review/findings wait uses this stage. |
| `stage` | `done` | A completion producer sets this stage. Cancellation does not require it. |
| `stage` | `backlog` | An idea waits here. A user can queue a grill without promotion to `todo`. |
| `state` | `queued` | The row waits for scheduler selection. Holds and dependencies can delay selection. |
| `state` | `preparing` | The turn loop claims the row before its first await. |
| `state` | `running` | The session callback marks the row. A second-model check can retain this state. |
| `state` | `needs_you` | A producer parks the row for a reply or another user action. |
| `state` | `idle` | The row has no queued run or user park. Done, cancelled, backlog, PR, and held-review paths use it. |

[`Task`, `src/types.ts:388-448`](../../src/types.ts#L388-L448) stores both enum fields and the nullable cancellation timestamp. `cancelledAt !== null` is the cancellation latch. There is no `cancelled` enum value. `publishing` is an in-memory set, not a `RunState`.

`TurnKind` is `work | merge`. `OutcomeStatus` is `ready | answered | integrated | needs_you`. [`Next`, `src/types.ts:717-738`](../../src/types.ts#L717-L738) carries the proposed stage, state, reason, and optional resume fields.

### Accepted pairs are not a pipeline whitelist

[`TASKS_DDL`, `src/store.ts:108-145`](../../src/store.ts#L108-L145) has one CHECK for `stage` and another for `state`. It has no CHECK for a stage/state pair. All 25 pairs below pass those two CHECKs.

| `stage` / `state` | `queued` | `preparing` | `running` | `needs_you` | `idle` |
| --- | --- | --- | --- | --- | --- |
| `todo` | Accepted | Accepted | Accepted | Accepted | Accepted |
| `in_progress` | Accepted | Accepted | Accepted | Accepted | Accepted |
| `merging` | Accepted | Accepted | Accepted | Accepted | Accepted |
| `done` | Accepted | Accepted | Accepted | Accepted | Accepted |
| `backlog` | Accepted | Accepted | Accepted | Accepted | Accepted |

"Accepted" means only that the pair passes these store CHECKs. It does not mean that the scheduler selects it or a normal producer creates it. The nullable `cancelled_at` column adds no terminal-state constraint. The store can accept another stage/state patch while the latch remains non-null.

### Store methods

| Method and source | Actual enforcement and side effects |
| --- | --- |
| [`createTask`, `store.ts:3258-3292`](../../src/store.ts#L3258-L3292) | Inserts `todo/queued`. It sets `createdAt`, `updatedAt`, and `queuedAt` to the current time. The omitted cancellation column defaults to null. It allocates a unique ID, rejects an empty explicit ID, and records create/state events. It has no prior row or transition check. |
| [`TaskPatch`, `store.ts:818-831`](../../src/store.ts#L818-L831) | Allows stage, state, and cancellation patches. It excludes ID, project, creation/update/done timestamps, kind, and revision. |
| [`TASK_COLUMNS`, `store.ts:835-902`](../../src/store.ts#L835-L902) | Selects supported patch columns. The builder binds values. Unknown object keys do not supply SQL columns. `undefined` leaves a column unchanged. An explicit null clears a nullable column. |
| [`updateTask`, `store.ts:3334-3337`](../../src/store.ts#L3334-L3337) | Calls `runTaskUpdate` without an expected revision. Its SQL predicate checks only the ID. It does not reject a current stage, state, or cancellation latch. |
| [`updateTaskIfCurrent`, `store.ts:3343-3349`](../../src/store.ts#L3343-L3349) | Adds a revision comparison. This is compare-and-swap on revision only, not a transition or cancellation check. A stale write returns `{ ok: false, task }` without a patch. |
| [`runTaskUpdate`, `store.ts:3386-3430`](../../src/store.ts#L3386-L3430) | Requires an existing ID or throws `unknown task`. It updates `updatedAt` and normally increments revision, including metadata-only patches. The SQL predicates at lines 3413 and 3417 contain no stage/state/latch test. |
| Same builder, lines 3397-3401 | Every successful builder patch with `stage: "done"` stamps `doneAt`, including `done` to `done`. A stale revision predicate prevents the whole patch. The builder does not clear `doneAt` when a card leaves done. |
| Same builder, lines 3424-3428 | Records stage/state events only when a successful patch changes the respective value. There is no cancellation event in this path. |
| [`editTask`, `store.ts:3297-3316`](../../src/store.ts#L3297-L3316) | Changes prompt/title and clears hold columns. It changes none of the three lifecycle fields. Its optional revision guard does not add a lifecycle rule. |
| [`claimPromptHold` and `releasePromptHold`, `store.ts:3351-3378`](../../src/store.ts#L3351-L3378) | Change hold columns through the same builder with no revision increment. Claim can compare a supplied revision. Release does not. Both still update `updatedAt`. Neither changes lifecycle fields. |
| [`reorderQueue`, `store.ts:3432-3447`](../../src/store.ts#L3432-L3447) | Requires an exact permutation of current queue IDs. It changes `queuedAt` only. |

`queuedAt` is caller-managed. `state: "queued"` alone does not stamp it. Writers below explicitly show where a queue timestamp changes. The builder's revision rules do not cover every direct SQL metadata repair listed later.

## Entry path and read-side selection

[`server.ts:861-867`](../../src/server.ts#L861-L867) calls `recoverRestarted()` once, then `schedule()` at boot and every five seconds. It calls the supervisor every minute.

[`schedule`, `turn.ts:2840-2866`](../../src/turn.ts#L2840-L2866) starts the lost-run sweep before capacity checks. [`dispatchRunnable`, `turn.ts:2741-2763`](../../src/turn.ts#L2741-L2763) calls `pickRunnable`, then `runTurn`. [`dispatchProject`, `turn.ts:2767-2783`](../../src/turn.ts#L2767-L2783) also starts held-review settlement when the board is not drained.

After normal project dispatch, `schedule` also calls `pickScout`, then directly calls `runTurn` for its result at [`turn.ts:2863-2865`](../../src/turn.ts#L2863-L2865). [`pickScout` and `pickProjectScout`, `turn.ts:2787-2838`](../../src/turn.ts#L2787-L2838) apply global capacity and the board-wide active-scout exclusion. `pickProjectScout` calls `pickLowPriority`.

These are selection rules, not store write guards:

| Selector | Actual selection checks |
| --- | --- |
| [`queueOrder`, `scheduler.ts:57-67`](../../src/scheduler.ts#L57-L67) | Requires a null cancellation latch and `queued`. Orders by `queuedAt`, with `createdAt` as fallback and tie-breaker. |
| [`pickRunnable`, `scheduler.ts:683-725`](../../src/scheduler.ts#L683-L725) | Counts uncancelled preparing/running cards against capacity. Queued candidates must pass the drain-only ID and `holdUntil` checks. |
| [`mergeSlot`, `scheduler.ts:605-623`](../../src/scheduler.ts#L605-L623) | Requires `merging`, no preparing/running merge, no `mergeHold`, and no `depHold`. |
| [`grillSlot`, `scheduler.ts:627-639`](../../src/scheduler.ts#L627-L639) | Requires `backlog`, a free slot, and no preparing/running backlog card. |
| [`workSlotReady`, `scheduler.ts:643-660`](../../src/scheduler.ts#L643-L660) | Allows only `todo` or `in_progress`. Excludes trending scouts. A fresh todo needs rules unless it is an interview. Dependencies must permit the run. |
| [`pickLowPriority`, `scheduler.ts:732-752`](../../src/scheduler.ts#L732-L752) | Selects a trending scout only after normal work. Requires capacity, queued/null latch, todo/in-progress stage, drain/hold checks, and no dependency hold. |

[`claimTurn`, `turn.ts:3520-3571`](../../src/turn.ts#L3520-L3571) rechecks queued/null latch and local ownership, but not every picker rule. Direct `runTurn()` callers therefore depend on caller-side selection. The store does not enforce those assumptions.

## Creation, imports, and proposals

Every creation row below first uses `createTask` and its `todo/queued`, null-latch defaults. "Retains defaults" means that no later lifecycle patch occurs in that branch. Creation helpers have no old-row stage/state to validate. [`promptAuthor`, `types.ts:411-414`](../../src/types.ts#L411-L414) is a server-set field with default `user`. Helpers mark board-authored prompts through metadata patches. The field affects the gate bypass, not lifecycle defaults.

| Producer and call path | Branch checks | Lifecycle result and limits |
| --- | --- | --- |
| Ordinary route: `handlePOSTProjectsTasksByProject` calls `validateTaskCreate`, `createTask`, and `applyTaskCreateExtras`. [`app.ts:10586-10686`](../../src/app.ts#L10586-L10686) | Requires a registered non-gitless project, valid prompt/model/links/dependencies, and decoded images. `backlog !== true`. | Retains defaults. Creation occurs at line 10675. Extras at lines 10645 and 10651 change lineage/dependencies only. |
| Same route, `applyTaskCreateExtras`. [`app.ts:10633-10658`](../../src/app.ts#L10633-L10658) | The fresh card exists and `backlog === true`. | Write at line 10653 sets `backlog/idle`, `queuedAt: null`. It has no separate row-state or cancellation check. |
| `fileUpdateCards` calls `createUpdateCards`. [`app.ts:2930-2991`](../../src/app.ts#L2930-L2991) | Selected update IDs must be fileable and not already covered. The selection rejects duplicates. | Creation at line 2967 retains defaults. Line 2968 stores update IDs only. |
| `fileRemoveCard`. [`app.ts:2995-3008`](../../src/app.ts#L2995-L3008) | Requires a fileable removed update and no open card for that update. | Creation at line 3004 retains defaults. Line 3005 stores update IDs only. |
| Manual architecture-review route or `fileFirstDueArchReview` calls `fileArchReview`. [`app.ts:3373-3446`](../../src/app.ts#L3373-L3446), [`3465-3474`](../../src/app.ts#L3465-L3474), [`7850-7867`](../../src/app.ts#L7850-L7867) | Requires a non-gitless project and target. After target/history/alert awaits, `reviewBlocked` must return null and delta must exist. Automatic filing also requires `archReviewDue`. | Creation at line 3428 uses kind `review` and retains defaults. Line 3440 stores base only. No await separates the final guard and creation. |
| Rules routes call `startInterview`. [`app.ts:5279-5298`](../../src/app.ts#L5279-L5298) | If rules exist and `fix` is false, it creates nothing. A live interview also prevents creation. `liveCardOf` checks kind, null latch, and stage other than done. [`scheduler.ts:73-80`](../../src/scheduler.ts#L73-L80) | Creation at line 5291 uses kind `interview` and retains defaults. |
| `handlePOSTProjectsBoardByProject`. [`app.ts:7831-7848`](../../src/app.ts#L7831-L7848) | Requires a registered non-gitless project. Reuses the prior board-check card only while uncancelled and not done. | Otherwise line 7842 creates a default card. The board-check marker is not a lifecycle field. |
| Release route calls `createReleaseCard`. [`app.ts:10793-10879`](../../src/app.ts#L10793-L10879) | Requires the release plan, semver checks, valid overrides, and no `releaseBlocked` or plan blocker. | Creation at line 10859 retains defaults. Line 10871 stores base/version/notes. The route awaits `resolveReleaseOverrides` before creation and does not repeat its blocker check. |
| Follow-up route calls `followUpFacts`, then `landFollowUp`, then `createFollowUp`. [`app.ts:9601-9687`](../../src/app.ts#L9601-L9687) | Requires an uncancelled done source, valid text/model, target, and images. The source check precedes an awaited model check. | Creation at line 9631 retains defaults. The code does not re-read the source after that await. Handoff success changes metadata only at line 9566. [`app.ts:9538-9591`](../../src/app.ts#L9538-L9591) |
| Dependabot refile route. [`app.ts:7120-7161`](../../src/app.ts#L7120-L7161) | Requires a cancelled source, a recognized Dependabot first line, and no uncancelled card for the same PR. A done uncancelled card also blocks. | Line 7149 creates a new default row. Line 7150 copies source-PR fields only. The old latch stays on the source. |
| Fork scanner calls `createForkResult`, research-result branch. [`forks.ts:1190-1216`](../../src/forks.ts#L1190-L1216), [`store.ts:2572-2602`](../../src/store.ts#L2572-L2602) | The scanner supplies a parsed result. The store transaction creates a fresh row at line 2592. The store method repeats no scan eligibility check. | Line 2594 sets `done/idle`, research/report/title/topic. The store stamps `doneAt`. |
| Same transaction, each fork proposal. [`store.ts:2603-2612`](../../src/store.ts#L2603-L2612) | The scanner truncates proposals to five. It supplies no proposals when its open-proposal count is at least three. These are caller checks, not store checks. [`forks.ts:1196-1216`](../../src/forks.ts#L1196-L1216) | Line 2604 creates each child. Line 2605 sets `state: needs_you` and a fork-proposal reason. Stage remains `todo`, and the creation queue timestamp remains. |
| Trending verdict route calls `fileTrending`, then `fileTrendingProposal`. [`app.ts:10427-10458`](../../src/app.ts#L10427-L10458), [`store.ts:2687-2767`](../../src/store.ts#L2687-L2767) | In one transaction, `checkTrendingJudgement` requires kind trending, null latch, stage other than done, valid repo, and no final prior verdict. The filed count must remain below cap. | Line 2738 creates the child. Line 2740 sets `backlog/idle`, null queue time, lineage, and optional title. No separate child-state check follows creation. |
| Issue watcher: `scanProject` calls `fileCandidateCards`, then `fileIssueCard`. [`issues.ts:238-311`](../../src/issues.ts#L238-L311), [`store.ts:2874-2901`](../../src/store.ts#L2874-L2901) | Scanner checks the enabled watch/start mark after network awaits. It excludes PRs, old issues, tracked labels, existing watch rows, and items beyond the daily cap. The store repeats none of those filters. | Store line 2881 creates. Line 2882 sets `backlog/idle`, null queue time. A duplicate `issue_watch` insert rolls the transaction back. This uniqueness check is not a lifecycle guard. |
| Jira `importIssues` or `boardImport` calls `fileJiraCards`, backlog branch. [`jiraRoutes.ts:383-439`](../../src/jiraRoutes.ts#L383-L439), [`503-511`](../../src/jiraRoutes.ts#L503-L511), [`573-592`](../../src/jiraRoutes.ts#L573-L592), [`store.ts:2903-2952`](../../src/store.ts#L2903-L2952) | Routes accept only backlog or todo. The store transaction skips site/key entries whose task still exists, even when that task is done or cancelled. | Line 2935 creates. The spread at lines 2936-2944 sets `backlog/idle`, null queue time only when `o.stage === "backlog"`. |
| Same Jira writer, todo branch. [`store.ts:2930-2945`](../../src/store.ts#L2930-L2945) | The key is new and `o.stage !== "backlog"`. Routes constrain this to todo. | The empty spread retains `todo/queued`. The patch stores title/topic only. Todo imports trigger scheduling. |
| Retro settlement calls `fileRetroProposal`. [`turn.ts:8238-8321`](../../src/turn.ts#L8238-L8321) | Requires a retro identity, planned done stage, a proposal, a known target project, and fewer than three open unstarted retro proposals. It inherits normal settlement's earlier guard. It has no new parent-state/latch check. | Line 8272 creates in the chosen store. Line 8296 sets `state: needs_you`, proposal reason/summary, lineage/model/prompt. Stage remains todo. A failed handoff uses the proposal prompt, not cancellation. |
| Review settlement calls `fileKeptFindings`, confirmed finding. [`turn.ts:8691-8718`](../../src/turn.ts#L8691-L8718) | Requires no check failure and a fresh existing parent with null latch. No parent stage/state check occurs here. | Line 8710 creates a default child. Line 8711 adds lineage/model only. |
| Same writer, unverified lead. [`turn.ts:8719-8794`](../../src/turn.ts#L8719-L8794) | Requires an existing fresh parent with null latch. An exact `Fingerprint: <value>` line enables same-project dedupe. Open matches prevent creation and receive a details note. Cancelled matches prevent creation. Done matches permit a new lead. Lowest ID breaks ties within each group. | Line 8759 creates only an unmatched or returned lead. Line 8764 sets `backlog/idle`, null queue time, board authorship, lineage/model, and unverified-lead details. Each new lead joins the same-pass index. No successful second-model verdict is required. |
| Supervisor `retroPass`. [`supervisor.ts:1183-1220`](../../src/supervisor.ts#L1183-L1220), [`1265-1300`](../../src/supervisor.ts#L1265-L1300) | Requires an uncancelled done source in the retro window, past grace, not freshly pushed, supported kind, usable retro facts, and no prior retro child. It rechecks the live-retro exclusion before creation. | Line 1286 creates kind retro at defaults. Line 1294 adds lineage only. No await follows the final live-retro check. |
| Supervisor `ciPass` calls `ciFileFollowUp`. [`supervisor.ts:1505-1561`](../../src/supervisor.ts#L1505-L1561), [`1603-1637`](../../src/supervisor.ts#L1603-L1637) | Requires a watched push and failed CI, no same-push or open same-check follow-up, and no same-card PR-head reply. Log fetch follows dedupe. There is no fresh parent/latch check before creation. | Line 1530 creates a default child. Line 1554 stores prompt/lineage. A best-effort handoff failure does not cancel it. |
| Supervisor `dependabotPass` calls `dependabotFileCards`. [`supervisor.ts:1645-1702`](../../src/supervisor.ts#L1645-L1702), [`1710-1743`](../../src/supervisor.ts#L1710-L1743) | Requires a usable repo, poll window, parsed open PR, no sufficiently new prior card, successful head fetch, and readable SHA. Done/cancelled prior cards also dedupe. The card snapshot precedes fetch awaits. | Line 1684 creates at defaults. Line 1687 stores source-PR fields. No fresh card-list check occurs after the awaits. |
| omp watch `reviewReleases` calls `fileFailCard`. [`ompWatch.ts:421-496`](../../src/ompWatch.ts#L421-L496) | Caller requires a repo, active watch, failed compatibility verdict, and another active-watch check after the review await. The helper has no extra lifecycle guard. | Line 469 creates at defaults. Line 479 changes title/topic only. |
| omp watch `fileBumpCard`. [`ompWatch.ts:499-545`](../../src/ompWatch.ts#L499-L545) | Requires a bump target, no open bump card, a version newer than the prior bump, and an active watch. | Line 528 creates at defaults. Line 533 changes title/topic only. |
| Trending scan calls `fileScoutCard`. [`trending.ts:417-475`](../../src/trending.ts#L417-L475), [`554-570`](../../src/trending.ts#L554-L570) | The scan supplies candidates for an eligible project. The helper refuses an empty candidate list and writes the bundle before creation. | Line 453 creates kind trending at defaults. Line 466 changes title/topic only. |

### PR review cards are a separate producer

PR review cards do not run through the ordinary work/merge turn pipeline. [`reviewOnce`, `prs.ts:1210-1305`](../../src/prs.ts#L1210-L1305) fetches the expected head, builds context, starts a review run, parses the model draft, then calls `savePrDraft`.

| Writer and caller path | Branch checks | Patch and limits |
| --- | --- | --- |
| `savePrDraft`, new card. [`store.ts:3152-3190`](../../src/store.ts#L3152-L3190) | Requires an existing PR-review row. Creates when that row has no surviving card. | Line 3166 creates kind `pr_review`. The spread in line 3167, at line 3176, sets `in_progress/idle`. Queue time becomes null. The transaction then calls `syncPrCard`. |
| `savePrDraft`, existing card. [`store.ts:3165-3190`](../../src/store.ts#L3165-L3190) | Requires only the PR-review row and an existing linked card. No stage/state/latch check guards the metadata patch. | The alternate spread keeps stage/state/latch. It changes prompt/draft/summary and nulls queue time, then calls `syncPrCard`. A cancelled existing card can receive this metadata. |
| `syncPrCard`, unposted open draft. [`store.ts:3203-3226`](../../src/store.ts#L3203-L3226) | Re-reads the PR row and card. Requires a card link, an existing card, null latch, and a difference in stage/state/reason. `row.state === "open"`, details exist, and posted head differs from reviewed head. | Dynamic `want` consumed at line 3225 sets `in_progress/needs_you` and `PR_REVIEW_WAITING`. No prior-stage/state restriction occurs. |
| `syncPrCard`, all other PR-row states. [`store.ts:3208-3226`](../../src/store.ts#L3208-L3226) | Same existence/null-latch/difference checks. The open-unposted-draft condition is false. | The other `want` branch sets `done/idle`, null reason. It can move a prior done card back to waiting on a later open draft through the first branch. |

`syncPrCard` callers are `savePrDraft`, [`closeGonePulls`, `prs.ts:988-1015`](../../src/prs.ts#L988-L1015), the convergence loop in [`scanProject`, `prs.ts:1081-1103`](../../src/prs.ts#L1081-L1103), and successful [`handlePOSTProjectsTasksPrPostByProjectAndId`, `app.ts:9254-9263`](../../src/app.ts#L9254-L9263).

[`dueReviewRows`, `prs.ts:1019-1035`](../../src/prs.ts#L1019-L1035) excludes closed/draft/already-reviewed/recent heads and cancelled cards before the model call. `runDueReviews` applies the daily cap at [`prs.ts:1060-1079`](../../src/prs.ts#L1060-L1079). These are earlier caller checks, not an atomic latch predicate in `savePrDraft`.

The post caller adds its own earlier guard. [`claimPrPostCard` and its refusal helpers, `app.ts:9127-9163`](../../src/app.ts#L9127-L9163) require a linked PR-review card, GitHub repo, null latch, draft details, and open PR. They check the requested reviewed head and claim that head before external awaits. [`claimPrPost`, `store.ts:3072-3084`](../../src/store.ts#L3072-L3084) atomically checks open PR state, the reviewed head, and a different posted head. Its SQL does not check the task latch.

[`handlePOSTProjectsTasksPrPostByProjectAndId`, `app.ts:9198-9263`](../../src/app.ts#L9198-L9263) posts approval only with `prReviewApprove` and a non-blocking latest run. Otherwise it posts a comment. The route does not repeat its task-liveness check between the claim and the external post. A successful post changes PR-row metadata, then calls `syncPrCard`. That helper separately re-reads the task before its lifecycle patch.

## Claim, preparation, dispatch, and recovery writers

All writers in this section use unguarded `updateTask`. A "fresh" guard means a synchronous read before that patch, not a revision predicate.

| Writer and call path | Branch checks | Lifecycle patch and unchanged fields |
| --- | --- | --- |
| `runTurn` calls `claimTurn`. [`turn.ts:3520-3571`](../../src/turn.ts#L3520-L3571) | Registered project, fresh queued task, null latch, no local running key, and no start-gate hold. | Line 3561 sets preparing and clears reason/ask. Stage and queue time stay. Kind is merge only for stage merging, otherwise work. No independent dependency/allowed-stage/picker hold check occurs. |
| `creditGate`, check throws. [`turn.ts:1873-1911`](../../src/turn.ts#L1873-L1911) | After `creditOk` fails, fresh row must exist, remain preparing, and have null latch. | Line 1903 sets queued, a one-minute credit-check hold, null provider/window, failure reason, and the claimed ask. Stage and queue time stay. |
| `creditGate`, no credit after a newer release. [`turn.ts:1896-1920`](../../src/turn.ts#L1896-L1920) | Same fresh guard. The release counter changed during the call. | Line 1914 sets queued and clears hold/provider/window. It restores the claimed ask. Stage, reason, and queue time stay. |
| `creditGate`, no credit without a newer release. [`turn.ts:1896-1928`](../../src/turn.ts#L1896-L1928) | Same fresh guard. No exception and no intervening release. | Line 1923 sets needs-you and the hosted credit reason. Stage and queue time stay. A true credit answer returns without this fresh read. |
| Model gates call `creditBlockedRun`. [`turn.ts:3677-3697`](../../src/turn.ts#L3677-L3697) | Hosted mode and an active credit hold/stop mark. The patch also needs a fresh existing null-latch row in preparing or running. | Line 3692 sets needs-you and the credit reason. Stage and queue time stay. `creditStop` itself marks/kills runs at [`turn.ts:9553-9608`](../../src/turn.ts#L9553-L9608). |
| `promptGateTurnStart` calls `parkGate`, deterministic open questions. [`turn.ts:3797-3823`](../../src/turn.ts#L3797-L3823), [`3966-3983`](../../src/turn.ts#L3966-L3983) | Gate applies. No pending answer or prior seen text exists, and the prompt has open questions. This check precedes the board-authored prompt bypass. | Line 3977 sets needs-you, reason, ask, and gate metadata. Stage stays. `parkGate` has no internal state/latch read. |
| Same writer, model gate failure. [`turn.ts:3834-3869`](../../src/turn.ts#L3834-L3869), [`3966-3983`](../../src/turn.ts#L3966-L3983) | Two model attempts leave an error or no check. | Same patch call with an error reason, null ask, and error gate signature. No fresh state/latch check follows the model awaits. |
| Same writer, model questions or missing outside check. [`turn.ts:3870-3963`](../../src/turn.ts#L3870-L3963), [`3966-3983`](../../src/turn.ts#L3966-L3983) | The effective result has questions or lacks its outside-check point. Fact questions first permit a repository lookup and one new gate call. A failed lookup or call retains the first result and prior seen text. | Same patch call stores questions and retry/escalation data. Successful fact answers enter seen text and parked gate metadata. Repeated failures add Start anyway. No fresh state/latch check follows these awaits. |
| `settleHuskWorktree` calls `settleLandedHusk`. [`turn.ts:4192-4295`](../../src/turn.ts#L4192-L4295) | Non-special existing task worktree is a husk. `huskLandedFacts` proves the non-base head is on target and then checks fresh null latch. | Line 4284 sets done/idle, clears reason/ask/pending prompt/images/hold head, and records Git facts. It awaits those facts after the cancellation read and does not repeat the read. |
| Same husk path calls `parkHuskWorktree`. [`turn.ts:4218-4237`](../../src/turn.ts#L4218-L4237), [`4365-4376`](../../src/turn.ts#L4365-L4376) | Facts pass the null-latch read, no landed proof exists, no changed branch head permits rebuild, and the selected head differs from base. | Line 4372 sets needs-you with the lost-work reason. Stage stays. The helper has no further read. Other husk branches rebuild metadata only. |
| Routing calls `parkBeforeRun`. [`turn.ts:4636-4730`](../../src/turn.ts#L4636-L4730), [`4794-4804`](../../src/turn.ts#L4794-L4804) | Missing worker/model or failed credential setup supplies a reason. The helper requires a fresh existing null-latch preparing row. | Line 4803 sets needs-you and reason. Stage stays. |
| Routing calls `gateUsageStart`. [`turn.ts:4994-5035`](../../src/turn.ts#L4994-L5035) | User-authored pending text bypasses quota lookup. Otherwise a known usage reset, no credit stop, and a fresh null-latch preparing row permit the patch. | Line 5023 sets queued, queue time, reset/provider/window, and reason. Stage stays. A no-hold result does not add a fresh cancellation check. |
| Session callback calls `dispatchSessionEntry`, first work session. [`turn.ts:5196-5211`](../../src/turn.ts#L5196-L5211) | Fresh preparing row, null latch, work kind, current stage todo. | Line 5204 sets running/session ID. Its spread also sets in-progress. Queue time stays. |
| Same callback, other session. [`turn.ts:5196-5211`](../../src/turn.ts#L5196-L5211) | Same preparing/null-latch checks, but not work-plus-todo. | Same call sets running/session ID without a stage patch. The callback occurs after spawn. It does not guard the external spawn itself. |
| `dispatchTurnRun` calls `vmAcceptance`, busy response. [`turn.ts:5299-5329`](../../src/turn.ts#L5299-L5329) | Worker refuses as busy. A fresh row must still be preparing with null latch. | Line 5322 sets queued and restores the original reason/ask. Stage and queue time stay. |
| `runTurn` catch calls `settleTurnError`. [`turn.ts:3369-3400`](../../src/turn.ts#L3369-L3400) | Any caught preparation/dispatch/settle error. No current state/latch check occurs. | Line 3395 sets needs-you and `Tracker error: ...`. Stage stays. It first finishes an open turn row when one exists. |
| `recoverRestarted` or periodic lost sweep calls `settleLostTurn`. [`turn.ts:2056-2095`](../../src/turn.ts#L2056-L2095) | Finishes an open turn row if supplied, then requires a fresh existing null-latch task. It awaits resume Git reads after that guard. | Line 2088 sets queued, reason, resume prompt, and author. Stage and queue time stay. It does not recheck state or cancellation after the await. |
| Lost work-check sweep calls `settleLostCheck`. [`turn.ts:2100-2128`](../../src/turn.ts#L2100-L2128) | Fresh task exists with null latch. `checkKey` ends in `:workcheck`. | Line 2112 sets in-progress/needs-you, lost-check reason, and an error log record. No fresh stage/state test occurs. |
| Lost review-check sweep calls the same helper. [`turn.ts:2100-2135`](../../src/turn.ts#L2100-L2135) | Same existence/null-latch check. The check key is not a work check. | Line 2130 sets in-progress/needs-you and the lost-review-check reason. No fresh stage/state test occurs. |
| Boot `restartSweepTask` calls `finishPushedMergeAtBoot`. [`turn.ts:2190-2274`](../../src/turn.ts#L2190-L2274) | In-flight caller snapshot, merging stage, null latch, branch/worktree, turn with PID, origin target/URL, successful fetch, readable tips, and remote containment proof. | Line 2245 sets done/idle, null reason, commits/head, and conditional push SHA. No fresh cancellation/state read follows the Git awaits. Line 2259 changes uncommitted-file metadata only. |
| Boot `restartSweepTask`, stranded PR merge. [`turn.ts:2278-2294`](../../src/turn.ts#L2278-L2294) | Before the in-flight filter, snapshot has null latch, `merging/idle`, no PR number, and current PR-mode setting. No await separates the condition and patch. | Line 2291 sets needs-you and the stranded-merge reason. Stage, branch, worktree, PR fields, and queue time stay. It does not queue or ship a turn. |

[`gateApplies`, `turn.ts:3495-3515`](../../src/turn.ts#L3495-L3515) requires work kind. It excludes interview, grill, scout, retro, review, release, and board-check identities. It also excludes research cards, source-PR cards, and `pr_review` kind. Start gates cover VM health/configuration/drain/busy delay, or classic-pool/local drain and low temporary space at [`turn.ts:3582-3639`](../../src/turn.ts#L3582-L3639).

`promptGateTurnStart` compares the prompt, permitted handoff text, pending text, and prior seen text before its fingerprint bypass. See [`turn.ts:3769-3796`](../../src/turn.ts#L3769-L3796). A board-authored prompt bypasses the model only without pending or seen text, after the deterministic question check. See [`turn.ts:3825-3833`](../../src/turn.ts#L3825-L3833). A passing model gate stores only gate metadata at [`turn.ts:3910-3931`](../../src/turn.ts#L3910-L3931). Fact lookup does not add a lifecycle guard.

Boot first checks the stranded PR case above. It then considers only preparing/running snapshots for lost-turn recovery. A live local PID or rebound detached run can retain ownership. [`restartSweepTask`, `turn.ts:2295-2344`](../../src/turn.ts#L2295-L2344) tries remote-push completion before lost-run requeue. If the original snapshot has a latch, it repeats `cancel` after lost settlement.

Periodic [`collectLostRun`, `turn.ts:2522-2533`](../../src/turn.ts#L2522-L2533) also selects preparing/running snapshots. [`collectLostRow`, `turn.ts:2486-2519`](../../src/turn.ts#L2486-L2519) protects live loop ownership and live PIDs. [`collectLostCheck`, `turn.ts:2436-2462`](../../src/turn.ts#L2436-L2462) detects dead or absent check PIDs. [`settleLostRows` and `settleLostChecks`, `turn.ts:2551-2610`](../../src/turn.ts#L2551-L2610) re-read tasks and call the writers above.

Detached completion calls [`settleDetached`, `turn.ts:2005-2017`](../../src/turn.ts#L2005-L2017), which delegates to `settleLostTurn`. At boot, [`rebindDetachedRestart`, `turn.ts:2143-2174`](../../src/turn.ts#L2143-L2174) requires a null-latch snapshot and an open PID-null turn. It matches the worktree against worker runs. A running match creates a local watcher without a task patch. A finished match uses `settleDetached`.

## Work and merge outcome classification

[`classify`, `runner.ts:874-888`](../../src/runner.ts#L874-L888) starts with stage backlog for a grill, in-progress for work, or merging for merge. Call this the base stage below. It does not read the task store or the cancellation latch.

[`CLASSIFY_RULES`, `runner.ts:857-869`](../../src/runner.ts#L857-L869) tries rules in the order below. The first non-null result wins. Each repeated-failure branch precedes that rule's first-failure branch.

| Order and producer | Exact branch condition | Produced `Next` |
| --- | --- | --- |
| 1. [`provisionRule`, `runner.ts:533-542`](../../src/runner.ts#L533-L542) | Provision drift is non-empty. | Base stage/needs-you with the drift reason. |
| 2. [`killedRule`, `runner.ts:544-545`](../../src/runner.ts#L544-L545) | Result is killed. Normal turn settlement usually intercepts this first. | Base stage/needs-you. |
| 3a. [`backgroundWaitRule`, `runner.ts:551-566`](../../src/runner.ts#L551-L566) | Exit code zero, no terminal end, prior error starts with `BACKGROUND_WAIT`. | Base stage/needs-you. |
| 3b. Same rule and source | Same run shape without that prior error. | Base stage/queued with an automatic foreground-continue prompt. |
| 4a. [`workerLostRule`, `runner.ts:570-583`](../../src/runner.ts#L570-L583) | `workerLost === true` and prior error starts with `WORKER_LOST`. | Base stage/needs-you. |
| 4b. Same rule and source | Worker lost without that prior error. | Base stage/queued with `.`. |
| 5. [`deathRule`, `runner.ts:691-719`](../../src/runner.ts#L691-L719) | Nonzero exit or absent terminal end, and outcome absent or needs-you. | Tries the OOM rule, then 5a through 5f below, then base stage/needs-you with death context. |
| 5 OOM, repeated. [`oomRule`, `runner.ts:669-687`](../../src/runner.ts#L669-L687) | `oomKilled === true` and prior error starts with `OOM_KILL`. | Base stage/needs-you with the memory limit when known. |
| 5 OOM, first. Same rule and source | `oomKilled === true` without that prior error. | Base stage/queued with `.` and the automatic-continue reason. |
| 5a. [`providerRejectionRule`, `runner.ts:595-623`](../../src/runner.ts#L595-L623) | No session/outcome, empty stderr, no provider error, and images exist. | Base stage/queued with `quarantineImages`. |
| 5b. Same rule and source | Same empty failure without images, and an HTTP-400 log hit exists. | Base stage/needs-you with the provider rejection evidence. Without a hit, it returns null. |
| 5c. [`modelRestoreRule`, `runner.ts:628-643`](../../src/runner.ts#L628-L643) | Prior error starts with `MODEL_RESTORE`. | Base stage/needs-you. |
| 5d. Same rule and source | No repeated restore error, but death context names a model-restore failure. | Base stage/queued. Prompt replay comes from a later wrapper. |
| 5e. [`usageLimitRule`, `runner.ts:650-664`](../../src/runner.ts#L650-L664) | Usage limit hit and prior error starts with `QUOTA_LIMIT`. | Base stage/needs-you. |
| 5f. Same rule and source | Usage limit hit without that prior error. | Base stage/queued with `.`. |
| 6. [`approvalRefusedRule`, `runner.ts:721-727`](../../src/runner.ts#L721-L727) | Approval refused. | Base stage/needs-you. |
| 7. [`askedRule`, `runner.ts:731-746`](../../src/runner.ts#L731-L746) | Non-empty tool ask and no outcome, or outcome needs-you. A successful terminal outcome makes the ask moot. | Base stage/needs-you, reason and saved ask. |
| 8. [`grillIdleRule`, `runner.ts:751-757`](../../src/runner.ts#L751-L757) | Grill and outcome ready or answered. | Backlog/idle, null reason. |
| 9a. [`integratedRule`, `runner.ts:780-801`](../../src/runner.ts#L780-L801) | Work reports integrated and Git already proves integration. | Base stage/needs-you with the out-of-turn-merge reason. |
| 9b. Same rule and source | Work reports integrated without that proof. | Base stage/needs-you with the work-turn refusal. |
| 9c. Same rule and source | Merge reports integrated and Git proves integration. | Done/idle, null reason. |
| 9d. Same rule and source | Merge reports integrated without proof. | Base stage/needs-you. |
| 10a. [`workOutcomeRule` / `workReadyNext`, `runner.ts:804-818,838-845`](../../src/runner.ts#L804-L845) | Work ready, not grill, clean tree, commits ahead greater than zero. | Merging/queued, null reason. |
| 10b. Same ready helper and source | Prior branch did not match, zero commits ahead, Git integrated. | Done/idle, null reason. |
| 10c. Same ready helper and source | Other work ready facts. | Base stage/needs-you. |
| 10d. [`workAnsweredNext`, `runner.ts:821-836`](../../src/runner.ts#L821-L836) | Work answered, zero commits ahead. | Done/idle, null reason. |
| 10e. Same answered helper and source | Nonzero commits, clean tree, research not true. | Merging/queued, null reason. |
| 10f. Same answered helper and source | Other answered facts. | Base stage/needs-you. |
| 11. [`mergeOutcomeRule`, `runner.ts:847-854`](../../src/runner.ts#L847-L854) | Non-work ready or answered. | Base stage/needs-you for unexpected outcome. |
| Fallback a. [`receiptFallback`, `runner.ts:765-774`](../../src/runner.ts#L765-L774) | No outcome, work, research true, report exists. | Done/idle, null reason. |
| Fallback b. Same fallback and source | Prior branch did not match, work, not grill, clean commits ahead. | Merging/queued, null reason. This branch does not test research. |
| Fallback c. Same fallback and source | Prior branches did not match, merge, Git integrated. | Done/idle, null reason. |
| Fallback d. Same fallback and source | No outcome and none of those facts. | Base stage/needs-you for missing report outcome. |
| Final [`classify`, `runner.ts:885-888`](../../src/runner.ts#L885-L888) | A non-null outcome reaches the end, normally needs-you. | Base stage/needs-you with trimmed question, or summary. |

The pure classifier's `workReadyNext` has no research guard. A direct `classify` call can therefore map research-ready work with clean commits ahead to merging/queued. This does not describe the complete normal ready path.

Before classification, [`readRunReport`, `turn.ts:5652-5688`](../../src/turn.ts#L5652-L5688) rewrites a research-ready outcome to answered unless it qualifies as a demotion candidate. The candidate requires research, no report, no report error, a ready outcome, and no interview/grill/release identity. [`classifyTurnEnd`, `turn.ts:7086-7096`](../../src/turn.ts#L7086-L7096) clears research only when that candidate also has clean commits ahead. Normal ready settlement thus either normalizes the outcome or demotes the card before its merge classification.

`receiptFallback` also permits research without a report and with clean commits ahead to enter merging/queued. No-outcome results do not qualify for that ready-only demotion. This remains an end-to-end classification path while research stays true. The receipt comment says research never merges, but this branch does not enforce that statement. Later wrappers still apply.

## Settlement order, PR shipping, and effective patches

[`settleTurnRun`, `turn.ts:5551-5573`](../../src/turn.ts#L5551-L5573) runs these steps in order:

1. Read the outcome and report.
2. Handle killed or cancelled results.
3. Inspect the tree, copy screenshots, and quarantine untracked files.
4. Ship merge work.
5. Classify the result and apply push recovery.
6. Apply `stabilizeNext`, `guardUiShot`, and `planSettleWrite` in that order.
7. Finish the turn row after `settleCancelled` checks the current card.
8. Plan checks and write the initial card patch.
9. File a retro proposal, run review/work checks, and write deferred state.
10. Apply done metadata and worktree cleanup.

[`readTurnOutcome`, `turn.ts:5579-5590`](../../src/turn.ts#L5579-L5590) stops a late result when the lost-run sweep marked its entry abandoned. The classifier alone is therefore not the effective stored transition.

### Merge push and PR shipping

[`shipMergeTurn`, `turn.ts:5987-5997`](../../src/turn.ts#L5987-L5997) runs only for merge kind without interview, grill, or release identity. Normal mode calls `auditMergeHold` without its own fresh cancellation or outcome-status check. PR mode calls `shipPrCard`, which applies the separate ownership check below.

The normal push path audits approved heads, refuses another held tip, and skips a proved remote-landed push. See [`auditMergeHold` and `holdApprovedHead`, `turn.ts:6784-6868`](../../src/turn.ts#L6784-L6868). A mismatch records a later park and can reset the local branch at [`parkHeldMismatch`, `turn.ts:6875-6907`](../../src/turn.ts#L6875-L6907).

[`pushMergeTarget`, `turn.ts:6915-6935`](../../src/turn.ts#L6915-L6935) tries one retry only when the failure is not rejected/refused, the origin branch/URL exists, and a fetch proves fast-forward. [`retryFailedPush`, `turn.ts:7002-7064`](../../src/turn.ts#L7002-L7064) supplies those checks. [`markPushedRun`, `turn.ts:6943-6973`](../../src/turn.ts#L6943-L6973) changes an agent needs-you report to integrated only when its text matches `GIT_AUTH_FAILURE`. That change is an in-memory outcome change, not a direct task patch.

Every PR `prNext` below overrides classifier output in [`classifyTurnEnd`, `turn.ts:7094-7115`](../../src/turn.ts#L7094-L7115). Error rows produce merging/needs-you. Success rows produce merging/idle.

[`canShipPr`, `turn.ts:6054-6061`](../../src/turn.ts#L6054-L6061) requires a fresh existing row, null latch, and running or preparing state. It does not compare stage, revision, or turn ID. A kept cancellation clears the latch but leaves needs-you, so this predicate still rejects it.

| Producer and branch | Actual guard or result | Direct write or deferred `prNext` |
| --- | --- | --- |
| [`shipPrCard`, `turn.ts:6074-6087`](../../src/turn.ts#L6074-L6087), absent outcome | `canShipPr` passes, merge/PR-mode caller, outcome null. | Missing-report park. Other non-integrated outcomes produce no `prNext`. |
| Same helper, [`turn.ts:6088-6117`](../../src/turn.ts#L6088-L6117), route selection | Integrated outcome. Stored source number takes priority. Otherwise legacy resolution runs and `canShipPr` repeats after its await. | Source matches use `shipSourcePrCard`. No match needs push/open hooks. Missing hooks supply the unwired-ship park. |
| [`shipSourcePrCard`, `turn.ts:6128-6156`](../../src/turn.ts#L6128-L6156), missing head or tip | Initial `canShipPr` passes. `refreshedSourceHead` supplies the source head. Null head parks. After the tip await, `canShipPr` repeats. Null tip or empty branch parks. | Missing-source-head or unreadable-tip park. |
| Same helper, [`turn.ts:6157-6184`](../../src/turn.ts#L6157-L6184), no fixes | `canShipPr` repeats after tree comparison. Equal tips/trees adopt. Otherwise zero commits beyond the source adopt. A non-null count also permits the merge-tree proof below. | `adoptSourcePr` writes metadata only. It supplies merging/idle through `prNext`. |
| [`commitsBeyondHead` and `bumpReproducesCard`, `turn.ts:6215-6252`](../../src/turn.ts#L6215-L6252) | Count uses the card checkout when it exists, otherwise the project checkout. Reproduction needs readable source parent/target tip, a clean merge tree, and equality with the card tree. | A null count, failed proof, or Git error cannot prove that fixes are absent. These helpers write no task field. |
| `shipSourcePrCard`, extra fixes. [`turn.ts:6185-6208`](../../src/turn.ts#L6185-L6208) | After ancestry lookup, `canShipPr` repeats. A source-head descendant on origin, not Dependabot-owned, uses `pushToSourcePr`. Dependabot uses `openFollowUpPr`. Other sources use `parkOnSourcePr`. | The selected helper decides metadata, `prNext`, and the follow-up exception below. |
| [`refreshedSourceHead`, `turn.ts:6259-6287`](../../src/turn.ts#L6259-L6287) | Stored head must exist. Missing fetch hook/repo or failed fetch retains it. A readable changed fetched SHA replaces it. No fresh ownership check occurs inside this helper after fetch/SHA awaits. | Line 6281 stores source-head metadata only. It also updates the local source reference. |
| [`resolveLegacyDependabotPr`, `turn.ts:6293-6353`](../../src/turn.ts#L6293-L6353) | Initial `canShipPr`, usable repo, matching first line. Missing fetch hook parks. `canShipPr` repeats after fetch and SHA reads. | Fetch failure or null SHA parks. A readable SHA returns a Dependabot source reference. No match returns the ordinary PR route. |
| [`adoptSourcePr`, `turn.ts:6359-6380`](../../src/turn.ts#L6359-L6380) | Fresh `canShipPr` must pass immediately before the synchronous write. | Line 6366 stores PR number/URL/head and clears follow-up PR fields. It preserves stage/state/reason and `pushSha`. Then it sets merging/idle `prNext`. |
| [`pushToSourcePr`, `turn.ts:6384-6418`](../../src/turn.ts#L6384-L6418) | `canShipPr` passes. Missing hook/head ref parks. Null pinned origin returns without a park. Otherwise pushes to the source ref, then repeats `canShipPr`. | Push failure supplies `logPrPushFailure`. Success calls guarded `adoptSourcePr`. |
| [`openFollowUpPr`, `turn.ts:6428-6501`](../../src/turn.ts#L6428-L6501), preparation/push | Caller previously passed `canShipPr`. Missing push hook or origin parks. Successful push needs a usable repo. Base is the source head ref only for a descendant with that ref, otherwise the target. | Push failure uses `logPrPushFailure`. Missing repo supplies its park. No internal ownership check follows any await. |
| Same helper, [`turn.ts:6502-6552`](../../src/turn.ts#L6502-L6552), API result | Missing/failed open hook parks. Success attempts a source comment. A missing or failed comment does not park. | Line 6531 directly writes merging/idle, null reason, source PR fields, null `pushSha`, and follow-up PR fields. It also sets merging/idle `prNext`. This writer lacks a fresh ownership check. |
| [`parkOnSourcePr` and `commentSourcePr`, `turn.ts:6558-6614`](../../src/turn.ts#L6558-L6614) | Comment helper checks `canShipPr` after hosted credential lookup and after the comment. Park helper checks it again after the helper returns. | Line 6569 stores source metadata only. Then `prNext` parks with the manual-transfer reason. Comment failure logs but does not prevent the park. |
| [`openPullRequest`, `turn.ts:6619-6658`](../../src/turn.ts#L6619-L6658) | `canShipPr` repeats after integration proof and tip reads. No proof leaves classification in control. Null tip/empty branch or null origin parks. | A proved readable branch enters `pushPrBranch`. |
| [`pushPrBranch`, `turn.ts:6661-6689`](../../src/turn.ts#L6661-L6689) | Pinned origin exists. `canShipPr` passes immediately before and after the push. | Push failure uses `logPrPushFailure`. Success calls `openPrCard`. |
| [`logPrPushFailure`, `turn.ts:6693-6713`](../../src/turn.ts#L6693-L6713) | Called after a failed/rejected push. It adds no independent ownership check. | Sets push-error `prNext` only. |
| [`openPrCard`, `turn.ts:6716-6777`](../../src/turn.ts#L6716-L6777) | Missing repo parks. `canShipPr` passes after hosted credential lookup and after the open request. Failed open parks. | Line 6761 stores PR fields and `pushSha` only. It preserves stage/state/reason and supplies merging/idle `prNext`. |

Ordinary opening and source adoption retain turn ownership until `finishTurnRow`. `writeSettledCard` writes their final lifecycle state through `prNext`. They do not directly move the card to idle. `openFollowUpPr` remains an exception. Its earlier lifecycle patch can make `settleCancelled` reject its own result as non-live. Its missing fresh checks also leave a source-level cancellation gap. These statements describe code paths, not a reproduced race.

An outbound operation can finish after cancellation if it already started. A later ownership check cannot reverse that operation. The final-settle guard also cannot reverse the follow-up helper's earlier direct task patch.

### Ordered wrappers that produce or replace `Next`

These helpers do not themselves make a guarded lifecycle write. Their `Next` reaches `writeSettledCard`, or the deferred `writePostCheckState` below. Unless stated otherwise, they have no current-state/latch test.

| Order and producer | Branch condition | Effective replacement |
| --- | --- | --- |
| `classifyTurnEnd`. [`turn.ts:7073-7116`](../../src/turn.ts#L7073-L7116) | A research-ready demotion candidate has clean commits ahead and no report. | Clears research as metadata at line 7091, then classifies as work. A non-null `prNext` overrides classification. |
| `stampUsageHold`. [`turn.ts:7123-7147`](../../src/turn.ts#L7123-L7147) | Queued next, pending prompt exists, usage-limit result, known reset. | Keeps stage/state. Adds reset/provider/window and an automatic-continue reason. |
| `recoverMergePush` / `parkFailedPush`. [`turn.ts:7212-7242`](../../src/turn.ts#L7212-L7242) | Push error exists and automatic recovery conditions fail. Recovery needs rejection, no hold tip, an origin target branch, and fewer than two retries. | Merging/needs-you with push/recheck/rule context. No push error keeps the input. |
| `rebaseRecoveredPush`, fetch failure. [`turn.ts:7246-7267`](../../src/turn.ts#L7246-L7267) | Eligible rejected push, but no URL or fetch fails. | Merging/needs-you. |
| Same helper, rebase conflict. [`turn.ts:7271-7283`](../../src/turn.ts#L7271-L7283) | Rebase returns failure with conflict. | Calls `queueRebaseTurn`. |
| Same helper, non-conflict rebase failure. [`turn.ts:7284-7297`](../../src/turn.ts#L7284-L7297) | Rebase fails without conflict. | Merging/needs-you. It spends no retry count. |
| `runRebaseGates`, failed gates. [`turn.ts:7355-7371`](../../src/turn.ts#L7355-L7371) | Rebase succeeds but merge gates fail. | Calls `queueRebaseTurn`. |
| Same helper, failed retry push. [`turn.ts:7375-7400`](../../src/turn.ts#L7375-L7400) | Gates pass but retry push fails or rejects. | Calls `queueRebaseTurn`. A pushed or skipped result keeps the original `Next`. |
| `queueRebaseTurn`, failed refetch. [`turn.ts:7303-7328`](../../src/turn.ts#L7303-L7328) | Origin refetch fails or has no pinned URL. | Merging/needs-you. No retry count changes. |
| Same helper, successful refetch. [`turn.ts:7329-7351`](../../src/turn.ts#L7329-L7351) | Refetch succeeds. | Merging/queued with retry prompt plus pending steering. Metadata line 7337 increments `pushRetries`. |
| `stabilizeNext`, mismatch. [`turn.ts:7422-7435`](../../src/turn.ts#L7422-L7435) | Merge-hold mismatch exists. | In-progress/needs-you. Later steering/dependency/kind wrappers can still replace it. |
| `quarantineTurnImages`. [`turn.ts:7494-7523`](../../src/turn.ts#L7494-L7523) | `quarantineImages` true and file quarantine throws. | Work becomes in-progress/needs-you. Merge becomes merging/needs-you. Success changes image metadata at line 7506 and keeps `Next`. |
| `requeueModelRestore`. [`turn.ts:7528-7549`](../../src/turn.ts#L7528-L7549) | Queued `MODEL_RESTORE` retry. | Keeps stage/state. Replays sent/pending text and its author. |
| `settleSteered`. [`turn.ts:7553-7566`](../../src/turn.ts#L7553-L7566) | Fresh pending prompt exists and this is not a model-restore retry. | Work becomes in-progress/queued. Merge becomes merging/queued. Reason clears. This read does not check the latch. |
| `settleReportedDeps` / `parkBadDep`. [`turn.ts:7573-7599`](../../src/turn.ts#L7573-L7599) | Reported dependencies exist and validation finds a bad ID. | Same next stage/needs-you. Bad IDs do not enter dependency metadata. |
| `queueDepHold`. [`turn.ts:7603-7633`](../../src/turn.ts#L7603-L7633) | Valid dependencies, outcome needs-you, next needs-you, and no `Next.asked`. | Same next stage/queued with dependency marker/reason. It records valid dependencies at line 7587 first. |
| `parkCardKind`, review commit. [`turn.ts:7639-7647`](../../src/turn.ts#L7639-L7647) | Review identity and next stage merging. | In-progress/needs-you with review or release-review refusal. |
| Same helper, scout commit. [`turn.ts:7648-7657`](../../src/turn.ts#L7648-L7657) | Scout identity and next stage merging. | In-progress/needs-you. |
| `parkReviewDone`, findings hold. [`turn.ts:7664-7683`](../../src/turn.ts#L7664-L7683) | Review next stage done, then unchecked unfiled stored findings, current recorded findings, or `findingsHold` supplies a hold. | Merging/idle with unchecked-findings or findings hold reason. |
| Same helper, immediate release failure. [`turn.ts:7684-7702`](../../src/turn.ts#L7684-L7702) | No findings hold, release identity/version, publisher returns an error. | In-progress/needs-you. Successful publish keeps the done `Next`. The publish claim governs cancellation separately. |
| `guardUiShot`, first omission. [`turn.ts:7711-7745`](../../src/turn.ts#L7711-L7745) | Plain non-research work, no current/prior shots, changed UI files, no existing reason/steering, and no earlier warning. | In-progress/queued with screenshot prompt. |
| Same helper, repeated omission. [`turn.ts:7727-7751`](../../src/turn.ts#L7727-L7751) | Same conditions, but an earlier warning exists. | In-progress/needs-you. Existing reason/steering keeps its result. |
| `planSettleWrite` / `parkUnreadableReport`. [`turn.ts:7755-7761`](../../src/turn.ts#L7755-L7761), [`7781-7788`](../../src/turn.ts#L7781-L7788) | Unreadable report, not a release, and next not queued. | In-progress/needs-you. |
| `archiveReport`. [`turn.ts:7835-7852`](../../src/turn.ts#L7835-L7852) | Research, not interview, next not queued, done stage, missing report. | In-progress/needs-you. Other archive branches keep `Next` and set report/steps metadata. |
| `planSettleWrite`, unsaved work. [`turn.ts:7768-7797`](../../src/turn.ts#L7768-L7797) | Planned done, non-review/interview/scout/research, and `unsavedWork` returns a reason. | Work becomes in-progress/needs-you. Merge becomes merging/needs-you with a kept-worktree reason. |
| Same helper, checkout violation. [`turn.ts:7805-7826`](../../src/turn.ts#L7805-L7826) | Work, captured checkout baseline, null planned reason, and checkout guard returns a violation. | In-progress/needs-you. |
| `planMergeHolds`, direct hold. [`turn.ts:7904-7951`](../../src/turn.ts#L7904-L7951) | Work heading to done/merging. Update hold needs update IDs plus setting. Fork hold needs fork ancestry, not retro, and setting or an existing unspent hold. Missing/different approved head yields a hold. | In-progress/needs-you. `holdReasonFor` tries update before fork at [`turn.ts:8000-8013`](../../src/turn.ts#L8000-L8013). A proved landed approval skips the hold. |
| Same helper, deferred hold. Same source | Same hold, next merging, and `isWorkCard` true. | Keeps merging `Next` for the work check. Stores in-progress/needs-you in `holdPark` for the later guarded write. |

`stabilizeNext` also renames an unreachable-branch reason and enriches dispatch/temporary-space reasons without a lifecycle change. Its exact internal order appears at [`turn.ts:7422-7490`](../../src/turn.ts#L7422-L7490). It logs an OOM reason with the worker hostname when the dispatch handle has a URL. See [`turn.ts:7459-7472`](../../src/turn.ts#L7459-L7472). This log adds no task patch.

### Writers that consume the final plan

| Writer and caller path | Actual guard | Patch branch |
| --- | --- | --- |
| `settleKilledRun`, called before shipping/classification. [`turn.ts:5724-5743`](../../src/turn.ts#L5724-L5743) | Intercepts killed results or a truthy current cancellation timestamp. Finishes the turn row. Its optional task patch requires a stop reason and a fresh existing null-latch task. No current stage/state test occurs. | Line 5738 sets needs-you and stop reason. Stage stays. A cancel without that stop/null-latch combination causes no task patch. |
| `finishTurnRow` calls `settleCancelled`. [`turn.ts:8033-8086`](../../src/turn.ts#L8033-L8086) | Fresh task must exist, have null latch, and remain running or preparing. Otherwise it finishes the turn row as cancelled and skips normal card settlement. | No lifecycle patch occurs in this helper. It supplies an earlier caller-side check, not an atomic guard for `writeSettledCard`. |
| `writeSettledCard`, no deferred check. [`turn.ts:8132-8162`](../../src/turn.ts#L8132-L8162), [`8189-8230`](../../src/turn.ts#L8189-L8230) | `checkWillRun` false. The helper has no own check. The caller uses `await finishTurnRow` at [`turn.ts:5565-5567`](../../src/turn.ts#L5565-L5567). That await separates its earlier fresh check from this unguarded write, although `finishTurnRow` is synchronous. | Line 8190 spreads `Next.stage/state/needsReason`. Queued uses `st.now`; nonqueued restores the starting task's queue time. A defined usage hold also enters the patch. It does not clear unrelated holds automatically. |
| Same writer, deferred check. Same source | `checkWillRun` true. | `settledCardState` returns `{}`. Line 8190 changes no stage/state/reason/queue fields. It still stores text, shots, ask, pending prompt, report/Git/hold metadata. |
| `writePostCheckState`, normal final state. [`turn.ts:9332-9360`](../../src/turn.ts#L9332-L9360) | Check was planned. Fresh task exists, has null latch, and remains running or preparing. No stage/revision comparison occurs. `holdPark` null. | Line 9344 writes `Next.stage/state`, reason, and queue time only for queued. A merging review recomputes its reason from live finding children, with `FINDINGS_HOLD` fallback. |
| Same writer, deferred merge hold. Same source | Same fresh guard, but `holdPark` exists. | Line 9344 writes that in-progress/needs-you park and its approval-head columns. A check send-back/failure already changed state, so this guard skips it. |

`writeSettledCard` preserves an undefined pending prompt. It defaults a newly written prompt's author to supervisor. It clears an absent ask through `next.asked ?? null`. Those metadata rules do not add a stage/state/latch guard.

## Work checks and review checks

[`planTurnChecks`, `turn.ts:8099-8128`](../../src/turn.ts#L8099-L8128) decides which checks defer state. Review selection needs review identity, unchecked findings, and next merging or needs-you. It combines stored/current findings and removes prompts with an existing linked child. Work selection needs [`isWorkCard`, `turn.ts:7956-7967`](../../src/turn.ts#L7956-L7967) and next merging. That predicate excludes research, review, release, interview, grill, scout, and retro cards.

The work check defaults on. [`prepareWorkCheck`, `turn.ts:8842-8848`](../../src/turn.ts#L8842-L8848) reads head, then requires only an enabled switch, an existing row, and null latch. Despite its comment, it does not test current state. [`routeWorkCheck`, `turn.ts:8854-8898`](../../src/turn.ts#L8854-L8898) skips an unchanged non-null checked head only when no blocker remains. It includes later human turns and stored direction in the next check.

The review check also defaults on. [`runReviewCheck`, `turn.ts:8330-8388`](../../src/turn.ts#L8330-L8388) separates `Needs validation` leads before selection. [`selectFindings`, `scheduler.ts:757-773`](../../src/scheduler.ts#L757-L773) selects the first ten ranked findings plus all later high/critical findings. If the switch is off, selected confirmed findings still file without a model check. The review check does not require a fresh task-state/latch test before its model call.

Both checks try at most twice. A usage limit skips the retry. A rate-limit hold requires a wait greater than 60 seconds and at most 24 hours. See [`reviewCheckLoop`, `turn.ts:8478-8543`](../../src/turn.ts#L8478-L8543), [`workCheckAttempts`, `turn.ts:9006-9080`](../../src/turn.ts#L9006-L9080), and [`turn.ts:1197-1203`](../../src/turn.ts#L1197-L1203). [`awaitCheckAttempt`, `turn.ts:8579-8598`](../../src/turn.ts#L8579-L8598) checks hosted credit before and after each model run. [`awaitCheckRun`, `turn.ts:8635-8651`](../../src/turn.ts#L8635-L8651) stops if the lost-check sweep took ownership.

| Writer and branch | Actual checks | Lifecycle patch |
| --- | --- | --- |
| `settleReviewCheckFailure`, no reset hold. [`turn.ts:8655-8676`](../../src/turn.ts#L8655-L8676) | Check failed, hold null, fresh parent exists with null latch. No state/stage check occurs. | Line 8671 sets in-progress/needs-you and the failed-check reason. |
| `parkReviewCheckHold`. [`turn.ts:8680-8686`](../../src/turn.ts#L8680-L8686) | Failure has a hold. `holdPatch` re-reads and requires an existing null-latch running/preparing row. [`turn.ts:1841-1865`](../../src/turn.ts#L1841-L1865) | Dynamic patch at line 8685 sets in-progress/queued, queue time, hold/reason, and resume text/author. If `holdPatch` returns null, no patch occurs. |
| `sendWorkCheckBack`, divergence. [`turn.ts:8905-8946`](../../src/turn.ts#L8905-L8946) | A valid verdict has blockers and `workCheckDiverged(runs)` is true. Uses the task snapshot from before check awaits. | Line 8925 sets in-progress/needs-you, divergence reason/ask, log/head/report. No fresh state/latch check occurs. |
| Same writer, cap. [`turn.ts:8947-8962`](../../src/turn.ts#L8947-L8962) | Not divergent, send-back count at least `WORK_CHECK_MAX_SENDBACKS`, currently four. | Line 8948 sets in-progress/needs-you, cap reason/ask, log/head/report. No fresh state/latch check occurs. |
| Same writer, send-back. [`turn.ts:8963-8982`](../../src/turn.ts#L8963-L8982) | Not divergent and count below four. | Line 8963 sets in-progress/queued, queue time, supervisor prompt, null reason, incremented count, log/head/report. No fresh state/latch check occurs. |
| `parkFailedWorkCheck`, no hold. [`turn.ts:9269-9308`](../../src/turn.ts#L9269-L9308) | Failed attempts or usage limit, no hold. No fresh task-state/latch check occurs. | Spread in line 9286 sets in-progress/needs-you and error reason, plus an error log. |
| Same writer, valid hold. Same source and [`holdPatch`, `turn.ts:1841-1865`](../../src/turn.ts#L1841-L1865) | Hold exists. `holdPatch` requires fresh null-latch running/preparing row. | Same call spreads in-progress/queued plus queue/hold/resume fields. It also writes the error log. |
| Same writer, rejected hold. Same source | Hold exists, but `holdPatch` returns null. | The null spread changes no lifecycle field. The error-log patch still occurs. It does not fall back to a needs-you patch. |

[`applyWorkCheckVerdict`, `turn.ts:9191-9264`](../../src/turn.ts#L9191-L9264) writes only log/head/count/report metadata at line 9255 when blockers are empty. It does not re-read cancellation after the check. Blockers use the three `sendWorkCheckBack` branches above. [`writePostCheckState`, `turn.ts:9332-9360`](../../src/turn.ts#L9332-L9360) supplies the separate fresh final-state guard.

Review child creation has its own fresh parent-latch checks in `fileKeptFindings`, as listed under creation. The review summary write at line 8823 requires a successful check path and a fresh null-latch parent at lines 8796-8798. [`turn.ts:8796-8831`](../../src/turn.ts#L8796-L8831) The later `findingsCheckedAt` stamp at line 8386 checks `checkFailed === null`, but adds no new cancellation read.

## Held reviews, release waits, and publishing

A held review uses `merging/idle` plus a non-null reason. This is distinct from a PR ship wait at merging/idle with null reason. It is also distinct from a PR review draft at in-progress/needs-you.

[`settleReviews`, `turn.ts:3204-3222`](../../src/turn.ts#L3204-L3222) requires a project target. It uses a tick snapshot, excludes cancelled cards from merge-in-flight checks, and waits while a merge can push. [`heldReviewCard`, `turn.ts:3041-3061`](../../src/turn.ts#L3041-L3061) requires merging/idle, a reason, review kind, base, and null latch. [`settleHeldReview`, `turn.ts:3175-3196`](../../src/turn.ts#L3175-L3196) claims local `settling` and `preparing` sets. Those claims do not write task state.

[`reviewFindings`, `scheduler.ts:141-157`](../../src/scheduler.ts#L141-L157) follows finding children and dependencies before the review's `doneAt` cutoff. [`findingOpen`, `scheduler.ts:163-171`](../../src/scheduler.ts#L163-L171) excludes cancelled, done, and backlog findings. Both the review-done hold and `reviewHoldFor` use this predicate. See [`scheduler.ts:198-213`](../../src/scheduler.ts#L198-L213). An unverified backlog lead therefore does not retain a completed review's merge hold.

| Writer and branch | Actual guard | Lifecycle patch |
| --- | --- | --- |
| `settleReviewCard`, unchecked findings. [`turn.ts:3127-3149`](../../src/turn.ts#L3127-L3149) | No open `findingsHold`. Current row exists, stored findings exist, and `findingsCheckedAt` is null. | Line 3143 sets in-progress/needs-you with `UNCHECKED_FINDINGS_HOLD`. It does not call the cancellation predicate or recheck stage/state. |
| Same writer, plain review completes. [`turn.ts:3150-3172`](../../src/turn.ts#L3150-L3172) | No findings hold or unchecked-findings branch. Snapshot has no release version. After Git/status awaits, cancellation callback must be false. | Line 3161 sets done/idle, null reason, files/commits/head. The callback checks only the current latch/existence, not stage/state. |
| `settleReleaseCard`, unchecked findings. [`turn.ts:3065-3086`](../../src/turn.ts#L3065-L3086) | Current row exists, stored findings exist, no checked stamp. | Line 3080 sets in-progress/needs-you with unchecked-findings reason. No cancellation callback or stage/state check occurs here. |
| Same writer, missing worktree. [`turn.ts:3087-3097`](../../src/turn.ts#L3087-L3097) | Snapshot worktree null. | Returns without a lifecycle patch. |
| Same writer, publish fails. [`turn.ts:3089-3105`](../../src/turn.ts#L3089-L3105) | Worktree exists, publisher returns error, and cancellation callback is false after await. | Line 3099 sets in-progress/needs-you and release error. No stage/state recheck occurs. |
| Same writer, publish succeeds. [`turn.ts:3106-3123`](../../src/turn.ts#L3106-L3123) | Publisher succeeds. After Git/status awaits, cancellation callback is false. | Line 3114 sets done/idle, null reason, release summary, files/commits/head. No stage/state recheck occurs. |

[`publishReleaseCard`, `turn.ts:2977-3038`](../../src/turn.ts#L2977-L3038) reads fresh settings and supplies `claimPublish` to the tag publisher or release command. The claim re-reads `cancelledAt` immediately before publish. Missing or cancelled cards reject the claim. A valid claim adds `project/task` to `publishing`.

[`cancel`, `turn.ts:9809-9812`](../../src/turn.ts#L9809-L9812) refuses while that claim exists. `settleHeldReview` clears it in its finally block at line 3194. The normal turn path clears it in [`releaseRunClaim`, `turn.ts:3464-3491`](../../src/turn.ts#L3464-L3491). There is no persisted publishing state. Normal merge shipping has no equivalent cancellation claim. Most PR paths instead use repeated `canShipPr` reads. The follow-up PR exception appears above.

## Reply, backlog, grill, restart, and steering

[`resolveTask`, `app.ts:5266-5277`](../../src/app.ts#L5266-L5277) checks project registration, gitless mode, task-ID shape, and existence. It does not check stage, state, or cancellation.

[`applyUserEdit`, `app.ts:5124-5149`](../../src/app.ts#L5124-L5149) uses unguarded update at line 5132 when `revision` is absent. A supplied positive integer revision uses `updateTaskIfCurrent` at line 5139. [`staleEditResponse`, `app.ts:5158-5173`](../../src/app.ts#L5158-L5173) gives stale edits priority over later state refusals. Only the listed edit paths use that optional revision guard.

| Producer and call path | Actual guard | Lifecycle patch and limits |
| --- | --- | --- |
| Backlog route calls `backlogToTodo`. [`app.ts:9288-9325`](../../src/app.ts#L9288-L9325), [`9349-9364`](../../src/app.ts#L9349-L9364) | Route checks null latch. Helper requires backlog/idle and no pending prompt. Body read precedes row resolution. | Line 9313 sets todo/queued, queue time, null hold/reason/ask, optional refined prompt/model. No CAS. |
| Same route calls `backlogToPark`. [`app.ts:9327-9364`](../../src/app.ts#L9327-L9364) | Null latch, todo/queued, no pending prompt. | Line 9339 sets backlog/idle, null queue time/reason/hold. No CAS. |
| Grill route. [`app.ts:9367-9400`](../../src/app.ts#L9367-L9400) | Null latch, backlog/idle, no pending prompt. It then awaits the body. | Line 9390 sets queued, queue time, null hold/reason/ask, optional model. Stage remains backlog. No fresh read follows the body await. |
| Restart-session route. [`app.ts:7675-7701`](../../src/app.ts#L7675-L7701) | Requires needs-you and a session ID. It has no cancellation or stage check. | Line 7688 sets queued/time, clears session/images/ask/hold/reason, and stores supervisor `LOST_SESSION`. Stage/latch stay. |
| Steer-cancel route through `applyUserEdit`, queued follow-on. [`app.ts:7246-7298`](../../src/app.ts#L7246-L7298) | Null latch, optional current revision, pending text not `.`. Current state queued and stage not todo. | The spread at lines 7286-7292 adds needs-you and its reason. It also clears pending text/author/images. Writes through line 5132 or 5139. Stage stays. |
| Same steer-cancel route, other state/stage. Same source | Same common guards, but not queued-plus-non-todo. | The empty lifecycle spread preserves state/stage/latch. Only pending metadata clears. |
| Merge-anyway route calls `mergeAnywayPatch`. [`app.ts:9764-9797`](../../src/app.ts#L9764-L9797), [`scheduler.ts:1217-1231`](../../src/scheduler.ts#L1217-L1231) | Null latch, stage in-progress, state not running/preparing, open blockers, trimmed reason 1-2000 characters. | Dynamic call at line 9794 sets merging/queued/time, null pending prompt/author/reason/ask, and blocker overrides. No CAS. |
| Reply route calls `workCheckAskReply`, merge choice. [`app.ts:9899-9923`](../../src/app.ts#L9899-L9923) | Inherits uncancelled needs-you reply checks. Also requires a cap/divergence reason, saved ask, blockers, no images, and exact merge text. | Line 9917 applies the same `mergeAnywayPatch`. No independent stage check occurs here. |
| Same ask path calls `applyWorkCheckSendBack`. [`app.ts:9837-9895`](../../src/app.ts#L9837-L9895), [`9899-9937`](../../src/app.ts#L9899-L9937) | Same ask eligibility. Cap requires exact send-back choice. Divergence accepts a new direction or approach choice. Its cancel choice delegates to `cancel` instead. | Line 9878 sets queued/time, supervisor prompt/count, null hold/reason/ask. Stage stays. It can stamp direction in the blocker log. No fresh read or CAS occurs. |
| Reply calls `holdApprovalReply`. [`app.ts:9940-9994`](../../src/app.ts#L9940-L9994) | Inherits uncancelled needs-you reply checks. Requires stored hold head, matching update/fork/mismatch hold, exact approval text, and no images. | Line 9979 sets merging/queued/time, null hold/reason/ask, spends hold head, and sets the relevant approval head. No fresh read or CAS occurs. |
| Reply calls `gateStartReply`. [`app.ts:10000-10034`](../../src/app.ts#L10000-L10034) | Inherits uncancelled needs-you reply checks. Gate parked, Start anyway text, no images. | Line 10013 sets queued/time, null reason/ask, and a passed fingerprint. Stage and `holdUntil` stay. No fresh read or CAS occurs. |
| Plain reply calls `replyPatch`. [`app.ts:10036-10114`](../../src/app.ts#L10036-L10114), [`turn.ts:1330-1351`](../../src/turn.ts#L1330-L1351) | Null latch, needs-you, valid non-empty text or images, text at most 20000 characters. Earlier ask/approval/gate branches did not handle it. | Spread at line 10105 sets queued/time, null hold/reason/ask, combined text/images and author. Stage stays. The route awaits the ask helper and does not re-read before later reply patches. |
| Hosted `creditRelease` calls `releaseParkedCards`. [`turn.ts:9615-9652`](../../src/turn.ts#L9615-L9652) | Hosted release selects needs-you snapshots with null latch and exact credit reason. | Line 9627 uses `replyPatch(t, ".", [], "supervisor")`. Stage stays. No stage restriction or CAS occurs. |

PR-review replies branch before the ordinary needs-you test. [`prReviewReply`, `app.ts:9800-9830`](../../src/app.ts#L9800-L9830) requires an open linked PR, valid text, no images, and daily capacity. It requests a new draft, not a queued task turn.

Steering itself is metadata-only. [`steerStateRefusal` and `applySteer`, `app.ts:9403-9455`](../../src/app.ts#L9403-L9455) accept running/preparing/queued cards through the route's null-latch guard. `applySteer` appends pending text/images and clears the hold at line 9436 without a lifecycle patch. `settleSteered` later turns that pending text into a queued `Next`.

## Cancellation, stop, and kept worktrees

The cancellation latch is independent of stage/state. Cancellation is not universally terminal in the writer layer.

| Writer and call path | Actual guard | Patch and limits |
| --- | --- | --- |
| App cancel route delegates to `cancel`. [`app.ts:7093-7117`](../../src/app.ts#L7093-L7117), [`turn.ts:9803-9822`](../../src/turn.ts#L9803-L9822) | Valid route task, or boot recovery caller. `cancel` refuses only an active publish claim before its first patch. It has no stage/state/null-latch requirement. | Line 9812 sets `cancelledAt: Date.now()` before awaits. It does not change stage/state then. The store throws for a missing ID. |
| `cancel` calls `disposeCancelledWorktree`, kept branch. [`turn.ts:9672-9726`](../../src/turn.ts#L9672-L9726) | After kill and task re-read, a worktree exists. The verdict checks unsaved work only without force, outside done, and without a release version. A non-husk tree with unsaved work, or no known target/base, enters this branch. | Line 9716 explicitly clears `cancelledAt` to null, sets needs-you, kept-cancel reason, and kept files. Stage stays. The verdict/status awaits have no final fresh task check. |
| `cancel`, removable/no-worktree branch. [`turn.ts:9822-9836`](../../src/turn.ts#L9822-L9836) | Kept branch did not return. Removes the worktree if applicable and attempts remote branch deletion. | Line 9834 sets idle only. It preserves stage, cancellation timestamp, reason, and queue time. No post-await stage/state/latch predicate occurs. |
| Fresh ordinary-card image failure, `saveTaskImages`. [`app.ts:10561-10584`](../../src/app.ts#L10561-L10584) | Image save or image metadata update throws after creation. | Line 10577 directly sets timestamp latch and idle. Stage remains todo. It does not call `cancel` or apply worktree disposal. |
| Fresh follow-up image failure, `followUpImages`. [`app.ts:9518-9537`](../../src/app.ts#L9518-L9537) | Images exist and save throws. | Line 9531 directly sets timestamp latch and idle. Stage remains todo. No row-state check or `cancel` call occurs. |
| Fresh follow-up handoff failure, `followUpHandoff`. [`app.ts:9539-9591`](../../src/app.ts#L9539-L9591) | Handoff write or child metadata patch throws. | Line 9582 directly sets timestamp latch and idle. Stage remains todo. No row-state check or `cancel` call occurs. |
| App stop or hosted stop calls `stopTurn`, detached branch. [`turn.ts:9491-9547`](../../src/turn.ts#L9491-L9547) | `stopTurn` requires an existing null-latch task and a live handle or detached watch. | `stopDetachedRun` awaits remote kill, finishes an open turn, then line 9512 sets needs-you/reason. Stage/latch stay. It does not re-read after kill. |
| Same `stopTurn`, local branch. Same source | Same existence/null-latch/handle checks. | Records a stop reason and kills the handle. It makes no direct task patch. `settleKilledRun` supplies the guarded needs-you patch listed above. |
| Finish-kept route calls `finishKept`. [`app.ts:7651-7662`](../../src/app.ts#L7651-L7662), [`turn.ts:9892-9972`](../../src/turn.ts#L9892-L9972) | Existing row, needs-you, stage merging or in-progress, kept reason, no local running entry, target/integration proof, and valid file choices. It does not test `cancelledAt`. | After file/worktree/Git awaits, line 9960 sets done/idle, null reason, empties kept files, and records files/commits/head. No fresh state/latch check occurs. The latch stays unchanged. |

`disposeCancelledWorktree` is the production path here that clears a prior cancellation timestamp. A kept-cancel result is therefore a live needs-you card, not an idle cancelled card. The three direct creation-error writers do not use this decision path.

[`keptWorktreeVerdict`, `turn.ts:9672-9696`](../../src/turn.ts#L9672-L9696) treats forced, done, and release-card disposal as removable. For a husk, it preserves an unproved branch rather than marking the worktree as kept. [`checkKeptWorktree`, `turn.ts:9864-9887`](../../src/turn.ts#L9864-L9887) supplies finish-kept's proof. A real worktree needs `isIntegrated`. A missing/husk worktree needs a branch and `branchMergedOrGone`.

## Supervisor passes

[`projectPasses`, `supervisor.ts:2404-2421`](../../src/supervisor.ts#L2404-L2421) takes one initial task list. For each snapshot, it calls cleanup, reclassify, hygiene, CI, then retro. It then calls auto-tend if enabled, Dependabot, and PR passes. PR settlement takes another task list.

[`wentStale`, `supervisor.ts:147-156`](../../src/supervisor.ts#L147-L156) re-reads the row. It rejects missing rows, changed state/reason/latch, or any pending prompt. It does not compare stage, revision, branch, worktree, PR number, or push SHA. It is not an absolute null-latch guard. A snapshot that already has a cancellation timestamp can pass if the compared values stay equal.

| Writer and call path | Actual guard | Lifecycle patch |
| --- | --- | --- |
| `reclassifyPass` calls `applyReclassify`, queued result. [`supervisor.ts:585-607`](../../src/supervisor.ts#L585-L607), [`699-722`](../../src/supervisor.ts#L699-L722), [`754-802`](../../src/supervisor.ts#L754-L802) | Snapshot needs-you, reason, null latch, no ask, not research/release, branch/base/target. Last ended turn matches a Git-proof reason/outcome. Fresh Git classification returns queued. `wentStale` passes before the call. No stage check occurs. | Line 709 sets in-progress/queued/time, null reason, supervisor `.`. It resumes work instead of skipping the work check or merge holds. |
| Same helper, done result. [`supervisor.ts:723-749`](../../src/supervisor.ts#L723-L749) | Same candidate/turn/facts checks. `Next.stage` done. After commits/status awaits, `wentStale` passes again. | Line 737 sets done/idle, null reason, commits/files. |
| `hygienePass`, stranded PR merge. [`supervisor.ts:838-852`](../../src/supervisor.ts#L838-L852), [`911-932`](../../src/supervisor.ts#L911-L932) | Candidate is an old needs-you kept-worktree snapshot with a worktree on disk. PR mode, null latch, merging stage, and no PR number require `wentStale` to pass. | Line 921 sets needs-you and the stranded-merge reason before cleanup. It preserves stage, branch, worktree, files, PR fields, and queue time. |
| `hygienePass`, ordinary cleanup. [`supervisor.ts:818-852`](../../src/supervisor.ts#L818-L852), [`933-959`](../../src/supervisor.ts#L933-L959) | Same old kept-worktree candidate, except the stranded branch did not return. Linked checkout, readable status, no tracked changes, and no ahead commits must permit cleanup. `wentStale` passes before quarantine and after removal. No absolute null-latch/stage check occurs. | Line 948 sets idle, null reason/worktree, and empty kept files. Stage/latch stay. |
| `tendPass` calls `tendScan`, then `tendSend`. [`supervisor.ts:1010-1087`](../../src/supervisor.ts#L1010-L1087), [`1124-1179`](../../src/supervisor.ts#L1124-L1179) | Snapshot null latch, no release version, needs-you supported reason, new park episode, and a tend plan. Storm, durable card, arrival, and project-hour budgets permit the send. | Line 1147 sets queued/time, supervisor text, empty pending images, null reason/ask. Stage/latch/hold stay. No fresh row read or `wentStale` occurs before the patch. |
| `ciPass` calls `ciPrHeadReply`. [`supervisor.ts:1404-1443`](../../src/supervisor.ts#L1404-L1443), [`1603-1637`](../../src/supervisor.ts#L1603-L1637) | Push SHA exists, CI failed, snapshot merging with PR number, and not running/preparing merging. After log await, `wentStale` passes. No absolute null-latch check occurs. | Line 1427 sets in-progress/queued/time, supervisor prompt, null reason/push SHA. It can act on an already-cancelled unchanged snapshot. |
| `prPass` calls `prSettleMerging`, then `settlePrCard`, closed unmerged. [`supervisor.ts:1973-2010`](../../src/supervisor.ts#L1973-L2010), [`2301-2363`](../../src/supervisor.ts#L2301-L2363) | PR mode/repo/poll checks pass. Fresh list selects merging, PR number, null latch, state not queued/preparing/running. Per-PR read says closed and unmerged. `wentStale` passes. | Line 1998 sets in-progress/needs-you, close reason, null push SHA. |
| Same PR pass calls `prConflictVerdict`, conflict. [`supervisor.ts:2016-2059`](../../src/supervisor.ts#L2016-L2059) | Same PR-pass selection, open PR, idle snapshot, `mergeable === false`, and `wentStale` passes. | Dynamic call at line 2028 sets needs-you and exact conflict reason. Stage remains merging. |
| Same conflict writer, conflict clears. Same source | Open PR, needs-you with exact conflict reason, `mergeable === true`, and `wentStale` passes. Null verdict writes nothing. | Other branch at line 2028 sets idle and null reason. Stage remains merging. |
| PR merged path calls `finishPrMerge`, then `prPinDone`. [`supervisor.ts:1809-1830`](../../src/supervisor.ts#L1809-L1830), [`1869-1898`](../../src/supervisor.ts#L1869-L1898), [`1980-1989`](../../src/supervisor.ts#L1980-L1989) | Same PR-pass selection, merged PR with non-null merge commit, target available. `wentStale` passes before and after status capture. | Line 1822 sets done/idle, null reason, files, and push SHA only when merge commit equals fetched origin tip. Otherwise push SHA becomes null. |
| `settleFollowUpPr`, unresolved delivery. [`supervisor.ts:2097-2112`](../../src/supervisor.ts#L2097-L2112), [`2133-2196`](../../src/supervisor.ts#L2133-L2196) | PR-pass selection permits the snapshot. Follow-up and source both merged with commits, but neither delivery proof below applies. Exact-reason repeat guard and `wentStale` must pass. | Line 2183 sets in-progress/needs-you, unresolved-delivery reason, and null push SHA. Branch and follow-up fields stay. |
| Same helper, source closed. [`supervisor.ts:2197-2216`](../../src/supervisor.ts#L2197-L2216) | Follow-up merged with a commit. Source is neither open nor merged with a commit. `wentStale` and exact-reason repeat guard pass. | Line 2203 sets in-progress/needs-you, source-close reason, and null push SHA. Follow-up fields stay. |
| Same helper, follow-up closed. [`supervisor.ts:2217-2236`](../../src/supervisor.ts#L2217-L2236) | Follow-up is neither open nor merged with a commit. Exact-reason repeat guard and `wentStale` pass. | Line 2224 sets in-progress/needs-you, follow-up-close reason, and null push SHA. Follow-up fields stay. |
| `settleOpenFollowUpsSource`. [`supervisor.ts:2242-2270`](../../src/supervisor.ts#L2242-L2270) | Follow-up remains listed open. Source lookup succeeds and reports neither merged nor open. Exact-reason repeat guard and `wentStale` pass. | Line 2258 sets in-progress/needs-you, source-close reason, and null push SHA. Follow-up fields stay. |

[`prSettleMerging`, `supervisor.ts:2301-2342`](../../src/supervisor.ts#L2301-L2342) first selects uncancelled merging cards outside queued/preparing/running. A carry park with Dependabot ownership and the rebase marker calls `prRebaseAnswer`, even without a recorded PR number. An adopted PR then follows the single-PR or follow-up path. Failed PR reads produce no lifecycle write.

[`prFollowUp`, `supervisor.ts:2275-2296`](../../src/supervisor.ts#L2275-L2296) checks the unlisted PR first, then conflict verdicts for open PRs while a fresh row still has follow-up fields. Those verdicts use the same state/reason and `wentStale` guards above. The four follow-up parks move to in-progress, so later merge-watch windows exclude them until a reply and another merge turn.

[`settleFollowUpPr`, `supervisor.ts:2113-2174`](../../src/supervisor.ts#L2113-L2174) clears follow-up fields when that PR merged and the source remains open. The synchronous metadata patch requires `wentStale`. If both merged, a target-based follow-up pins the later commit. A tie or unreadable time selects the follow-up commit. Otherwise delivery requires a stored source head ref and readable times with the follow-up strictly earlier. That branch pins the source commit. Both proof paths call `finishPrMerge` and its guarded done writer above.

The supervisor creation writers appear in the creation table. `cleanupPass` removes worktrees only and has no task lifecycle patch. It selects done or cancelled cards with worktrees, checks unsaved work, then uses `wentStale`. [`supervisor.ts:119-123`](../../src/supervisor.ts#L119-L123), [`529-573`](../../src/supervisor.ts#L529-L573)

## Metadata and direct SQL inventory

These writers do not change `stage`, `state`, or `cancelledAt`, except where a branch above explicitly adds those fields. Metadata changes can still affect scheduling, checks, and revision conflicts.

| File and writer | Locations and fields |
| --- | --- |
| App quota refresh, `releaseUsageHolds` | [`app.ts:519-555`](../../src/app.ts#L519-L555), patch line 545. Clears hold/provider/window after provider availability checks. It does not queue a card. |
| App update/review/creation helpers | `createUpdateCards` line 2968, `fileRemoveCard` line 3005, `fileArchReview` line 3440. Sources appear in the creation table. They store update IDs or base. |
| App user-edit wrapper | [`applyUserEdit`, `app.ts:5124-5149`](../../src/app.ts#L5124-L5149), writes at 5132/5139. Model route uses it at [`app.ts:7163-7200`](../../src/app.ts#L7163-L7200). Steering text edit uses it at [`app.ts:7202-7244`](../../src/app.ts#L7202-L7244). Steer cancellation's conditional lifecycle branch appears above. Release-note edits use the same wrapper at [`app.ts:8878-8916`](../../src/app.ts#L8878-L8916). They require a null latch, release version, and idle/needs-you state. The optional revision check precedes those refusals. |
| App research/star/triage | [`handlePOSTProjectsTasksUnmarkByProjectAndId`, `app.ts:7592-7608`](../../src/app.ts#L7592-L7608), write 7607. [`handlePOSTProjectsTasksStarByProjectAndId`, `app.ts:7703-7716`](../../src/app.ts#L7703-L7716), write 7714. [`triagePatch` / triage route, `app.ts:10144-10179`](../../src/app.ts#L10144-L10179), dynamic write 10177. The last patch contains priority/close-candidate only. |
| App steering and child metadata | `applySteer` line 9436, `followUpHandoff` line 9566, `saveTaskImages` line 10574, `applyTaskCreateExtras` lines 10645/10651, Dependabot refile line 7150, and `createReleaseCard` line 10871. Linked source ranges and error branches appear above. |
| Turn claim/gate metadata | [`claimTurn`, `turn.ts:3544-3565`](../../src/turn.ts#L3544-L3565), reason-only write 3557. [`promptGateTurnStart`, `turn.ts:3910-3931`](../../src/turn.ts#L3910-L3931), gate-only write 3922. |
| Turn title helpers | [`generateSessionTitle`, `turn.ts:4041-4083`](../../src/turn.ts#L4041-L4083) uses `nameTask` and title holds, not lifecycle patches. |
| Turn worktree and diff helpers | [`createTurnWorktree`, `turn.ts:4141-4175`](../../src/turn.ts#L4141-L4175), patch 4163. [`rebuildHuskAtBase`, `turn.ts:4330-4362`](../../src/turn.ts#L4330-L4362), patch 4348. [`captureMergeDiff`, `turn.ts:4378-4413`](../../src/turn.ts#L4378-L4413), patch 4402. They store branch/base/worktree or diff fields. |
| Turn prompt consumption | [`consumeTurnPending`, `turn.ts:5338-5360`](../../src/turn.ts#L5338-L5360), patch 5351. Removes only the prompt/images that this turn consumed. |
| Turn report and plan metadata | [`readRunReport`, `turn.ts:5652-5673`](../../src/turn.ts#L5652-L5673), writes 5657/5660. `classifyTurnEnd` line 7091, `queueRebaseTurn` line 7337, `quarantineTurnImages` line 7506, `settleReportedDeps` line 7587. Linked wrapper ranges above show their guards. |
| Turn check metadata | `runReviewCheck` line 8386, confirmed child metadata line 8711, `writeReviewFindingsCard` line 8823, `applyWorkCheckVerdict` line 9255. Sources appear in the check/creation sections. Fingerprint-match details at [`turn.ts:8738-8742`](../../src/turn.ts#L8738-L8742) change no lifecycle field. Rejected hold spread at line 9286 is metadata-only, as specified above. |
| Turn done metadata | [`stampReleaseVersion` and `removeDoneWorktree`, `turn.ts:9400-9460`](../../src/turn.ts#L9400-L9460), writes 9418/9422/9445. They stamp verified version/push and files. Boot completion also writes files at [`turn.ts:2259-2261`](../../src/turn.ts#L2259-L2261). |
| Turn PR metadata | `refreshedSourceHead` line 6281, `adoptSourcePr` line 6366, `parkOnSourcePr` line 6569, and `openPrCard` line 6761. Exact guards and source ranges appear in the PR table. `openFollowUpPr` line 6531 also changes lifecycle fields. |
| Supervisor metadata | Retro lineage line 1294, CI child prompt/lineage line 1554, CI stop push clear line 1619, Dependabot source fields line 1687, PR release stamp line 1763. [`supervisor.ts:1286-1300`](../../src/supervisor.ts#L1286-L1300), [`1505-1561`](../../src/supervisor.ts#L1505-L1561), [`1603-1621`](../../src/supervisor.ts#L1603-L1621), [`1684-1696`](../../src/supervisor.ts#L1684-L1696), [`1747-1765`](../../src/supervisor.ts#L1747-L1765). CI stop uses `wentStale`. Release stamp checks integrated report, origin equality, and tag SHA, but no fresh task read after tag lookup. |
| Supervisor PR metadata | [`prRebaseAnswer`, `supervisor.ts:2065-2091`](../../src/supervisor.ts#L2065-L2091), line 2082, changes only reason after a matching bot comment and `wentStale`. The caller requires the carry-park marker. [`settleFollowUpPr`, `supervisor.ts:2113-2138`](../../src/supervisor.ts#L2113-L2138), line 2118, clears only follow-up PR fields under the guard above. |
| Other production modules | omp watch title/topic at [`ompWatch.ts:469-483`](../../src/ompWatch.ts#L469-L483) and [`528-537`](../../src/ompWatch.ts#L528-L537). Trending title/topic at [`trending.ts:453-470`](../../src/trending.ts#L453-L470). Boot release repair at [`server.ts:466-489`](../../src/server.ts#L466-L489), writes 484/488, selects done/null-base/null-latch snapshots and stamps or clears only release version. |
| Store import metadata | Jira todo branch line 2936 and existing PR-draft branch line 3167. Sources and dynamic spreads appear above. |
| Store queue/prompt methods | [`editTask`, `store.ts:3297-3316`](../../src/store.ts#L3297-L3316), prompt-hold methods at [`3351-3378`](../../src/store.ts#L3351-L3378), and queue reorder write at [`3437-3447`](../../src/store.ts#L3437-L3447). |

### Direct SQL that does not introduce production transitions

| Writer | Effect and boundary |
| --- | --- |
| [`ProjectStore.rebuildTasksOnCheck`, `store.ts:1377-1413`](../../src/store.ts#L1377-L1413) | Copies named columns to a rebuilt table in one transaction. It checks row counts and rolls back on error. It preserves stage/state/latch values rather than classifying a new transition. The legacy-state rebuild caller includes those columns at [`store.ts:1759-1772`](../../src/store.ts#L1759-L1772). |
| [`ProjectStore.open`, `store.ts:1733-1747`](../../src/store.ts#L1733-L1747) | Backfills null `doneAt` on done rows from the latest turn end. Rewrites legacy PR-conflict reason text. Neither operation changes stage/state/latch. |
| Store context/topic/reason/kind backfills | Direct metadata SQL at [`store.ts:1274-1277`](../../src/store.ts#L1274-L1277), [`1434-1435`](../../src/store.ts#L1434-L1435), [`1480-1532`](../../src/store.ts#L1480-L1532), and [`2078-2087`](../../src/store.ts#L2078-L2087). These do not change the three lifecycle fields. |
| [`nameTask`, `store.ts:2349-2354`](../../src/store.ts#L2349-L2354) | Sets only a null session title. This direct SQL does not use the revision builder. |
| [`captureTaskContext`, `store.ts:3561-3574`](../../src/store.ts#L3561-L3574) | Stores context tokens from a usable session snapshot. It changes no lifecycle field. |
| [`appendReviewFinding`, `store.ts:3886-3907`](../../src/store.ts#L3886-L3907) | A new finding clears `findingsCheckedAt` in its transaction. It changes no lifecycle field. |

`startTurn`, `finishTurn`, PR-review run methods, and PR-row setters modify separate records. Their result can drive a later task writer, but their own writes are not task transitions.

### Fixture-only direct SQL

[`insertTaskRow`, `scripts/demo-data.ts:482-546`](../../scripts/demo-data.ts#L482-L546) inserts stage/state/cancellation values from fixture specifications. [`scripts/card-shot.ts:122-144`](../../scripts/card-shot.ts#L122-L144) calls that fixture writer and directly changes a seeded PR card to idle at line 134. These are demo/screenshot data paths, not production transition producers. Their timestamp and uncommitted-file patches also remain fixture metadata. Tests can write artificial pairs to probe store behavior. Such pairs do not add a production lifecycle rule.

## Boundaries and error cases

- Store enum CHECKs reject values outside each enum. They do not reject an unusual pair or a change after cancellation.
- Unknown task updates throw. A stale revision write refuses without a patch. Most internal lifecycle writers do not use revision checks.
- A state-only queue patch can retain an old or null queue time. A stage-only or state-only patch preserves the other lifecycle fields.
- A successful builder patch with stage done stamps `doneAt` again. A later move away from done leaves that timestamp.
- A cancellation request can temporarily leave a timestamp latch with the prior running/preparing state before disposal finishes.
- A kept cancellation clears that latch. Direct creation-error cancellation does not use kept-worktree logic.
- Several writers check a snapshot or a latch before awaits. Their later patch does not gain an atomic guard from that earlier check.
- `wentStale` compares selected values, not revision or all lifecycle metadata. An already-cancelled snapshot can pass where the caller lacks a null-latch guard.
- Most PR ship actions and metadata writes repeat a fresh ownership check. The follow-up helper lacks those checks and directly changes lifecycle state.
- Release publication has a separate in-memory claim. The claim blocks the cancel helper, not arbitrary store patches.
- A failed or blocked check can retain running/preparing until its own failure/hold/deferred writer executes. No extra check enum exists.
- Normal settlement treats a failed commits-ahead read as zero. Its cleanliness and integration failures become false. [`settleGitFacts`, `turn.ts:7151-7200`](../../src/turn.ts#L7151-L7200)
- Supervisor reclassification instead treats a failed commits-ahead read as unknown and makes no transition. [`reclassifyFacts`, `supervisor.ts:653-696`](../../src/supervisor.ts#L653-L696)
- An unchecked-findings park in held review settlement lacks a cancellation callback check. Later success/failure paths use the callback but do not compare stage/state.

These statements describe current enforcement gaps and boundaries. They do not authorize additional transitions or propose fixes.

## Acceptance and document verification

The reference is complete when a reviewer can trace each production lifecycle write to its patch and actual guard.

1. Compare the five Stage and five RunState values with `types.ts` and the two store CHECKs.
2. Read the store methods before the producer tables.
3. Match every production `createTask` call and lifecycle-bearing `updateTask` or `updateTaskIfCurrent` patch to a producer row. Map metadata-only writes where they affect lifecycle selection or freshness.
4. Expand variable patches, conditional spreads, `want`, `replyPatch`, `mergeAnywayPatch`, `Next`, and `holdPatch` before classifying a call.
5. Trace each caller check through its awaits to the exact write.
6. Distinguish a fresh read, a snapshot assumption, a local claim, and an SQL revision predicate.
7. Compare direct task SQL with the maintenance and fixture tables.
8. Confirm the cancellation set, kept-cancel clear, direct error-cancel, and idle-disposal branches separately.
9. Confirm that no table presents the 25 accepted enum pairs as a normal pipeline whitelist.
10. Check the diff scope before acceptance. This spec adds no runtime, schema, prompt, guard, ADR, skill, or test change.

For repository acceptance, run `bun install --frozen-lockfile`, then `bun run check`, then `bun test`. Mutation gates do not apply to this docs-only work turn. This document requires no new permanent test or mutation setup.

## Non-goals

- Add a transition whitelist or make cancellation universally terminal.
- Change `updateTask`, `updateTaskIfCurrent`, revision semantics, SQL CHECKs, or timestamps.
- Repair freshness gaps, classify additional outcomes, or change scheduler selection.
- Change work/review checks, PR behavior, release publication, prompts, or supervisor policy.
- Combine this reference with the separate review-lens change.
- Treat historical handoffs, ADR intent, or older specs as proof of current enforcement.
