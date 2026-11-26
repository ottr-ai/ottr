# Ops alerts and completion digest

## Approved scope

OTTR-1156 adds the Ops alert class and a fixed 10-minute completion digest.
The user approved the bell and Web Push channels only.
Quiet hours, notification history, webhooks, email, and new dependencies are non-goals.

## Research basis

- [Jira](https://support.atlassian.com/jira-software-cloud/docs/manage-your-jira-personal-settings/) batches routine email for up to 10 minutes. Important notifications remain immediate.
- [Vercel](https://vercel.com/docs/notifications) supports failure and usage alerts, with preferences for each channel.
- [GitHub](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications) offers event preferences and repository subscriptions.
- [Linear](https://linear.app/docs/notifications) separates inbox state from delivery channels and offers email digests.
- [Slack](https://slack.com/help/articles/214908388-Pause-your-Slack-notifications) supports notification schedules. This task does not add schedules.

Ottr already groups pushes by class, shares acknowledgements across devices, and retracts cleared alerts.
It already sends GitHub token-expiry reminders under Request.
The new digest changes delivery time, not the existing task event rules.

## Assumptions and boundaries

- A board belongs to one operator. Devices share that board's acknowledgements and project mutes.
- Each hosted tenant has its own board store. This task adds no cross-board registry or new authorization route.
- Host operational events remain hidden from hosted tenants, as their existing bell notices do.
- Ops starts enabled for subscribed devices, like the existing classes. Existing false preferences must remain false during the upgrade.
- A focused board tab suppresses new pushes. It does not postpone them.
- Request, Error, and Ops bypass the completion digest but still obey presence and device preferences.
- The bell and task read markers remain immediate. This task adds no completion history or extra completion inbox.
- No SQL table or column changes are necessary. The existing GlobalStore JSON records hold the added state.

## Ops events

The shared model derives these events from existing state fields:

| Source | Occurrence key | Clear condition |
| --- | --- | --- |
| `deadSignIns` | `signin:<provider>` | The provider leaves `deadSignIns`. |
| `seedFailed` | `seed-failed:<since>` | The failure record clears or its episode changes. |
| `alateProvisionError` | Existing `shortKey("provision-error", error)` | Provision succeeds, the pending import clears, or the error changes. |

These are actionable failures, not routine progress notices.
Updates, board-behind notices, drain, pending imports, kept worktrees, and orphan notices do not gain pushes.
Token-expiry reminders retain their current class and schedule.

Ops uses the same occurrence keys in the bell, acknowledgement API, and push registry.
One occurrence sends at most one alert attempt per eligible device until it clears.
After recovery, a new failure can alert again, even when its key matches the earlier episode.
A restart does not replay every existing fault.
Acknowledgement or recovery retracts Ops through the existing per-device sequence rules.
Ops belongs to the board, not a project. Project mutes do not suppress it.
Push bodies use short, fixed descriptions. They do not include raw provisioning errors or credential material.
The bell keeps the existing details and recovery actions, without duplicate rows.

## Completion digest

The first eligible Complete event starts a board-local window of 600,000 milliseconds.
Later eligible Complete events join that window without moving its deadline.
This includes answers, finished cards, and the existing automatic PR-review completion event.
The existing class grouping determines each device's notification text and destination.

The server records each pending event and its eligible subscription identities.
The record preserves the deadline across restart.
A later subscription does not receive events from before its subscription.
Repeated registration of an unchanged endpoint, key pair, and VAPID binding preserves its identity.
Changed keys or VAPID bindings create a new identity.
A subscription that returns after unsubscribe receives no earlier events.

At the deadline, the server checks current subscriptions, class preferences, project mutes, acknowledgements, and source state.
It excludes a cancelled, reopened, acknowledged, superseded, or removed source.
It must read the real project store when a pending card falls outside the board's Done window.
A cancelled card outside the Done window does not remain in the completion-source scan.
A read failure retains pending state and reports the error. It must not claim delivery or silently discard the event.
A failed source read must not stop state frames, seen pruning, or Request, Error, and Ops pushes from healthy projects.
If a board tab has recent focus at delivery time, the due digest is suppressed rather than postponed.
An empty digest sends nothing.

The deadline must run without an open tab or another state change.
Use the existing server lifecycle and serialized notification state, not a second scheduler or database.
After restart, an overdue digest is eligible at the first notification tick after state validation.
A sent digest must not repeat on later ticks or restart.

Delivery retains the existing at-most-once attempt policy.
Persist the consumed batch with the live-alert state before external delivery.
A crash between that commit and delivery can lose an attempt. This task adds no retry service or exactly-once claim.
Existing failure reports, expired-subscription pruning, Apple clear handling, and stale-payload suppression remain in effect.

## Shared implementation contract

`src/notifications.ts` remains browser-safe and owns the shared model.

- Add `"ops"` to `AlertClass`, `ALERT_CLASSES`, and `ALL_CLASSES_ON`.
- Export `COMPLETION_DIGEST_MS = 10 * 60_000`.
- Export `opsEvents(state)`, with `state` limited to `hosted`, `deadSignIns`, `seedFailed`, and `alateProvisionError`.
- `opsEvents` returns `AlertEvent[]`. Ops events use `project: null`, `taskId: null`, `tag: "ops"`, and a board-relative URL.
- Allow those null identities in `AlertEvent` and `LiveAlert`. Card events retain their real identities.
- Extend `clearedAlerts` with the current Ops event keys, so Ops does not use card lookup for retraction.
- Keep existing Request, Error, and Complete event precedence unchanged.
- Normalize legacy subscription classes without resetting existing switches when `ops` is absent.

The server owns pending completion state, its real-store validation, and deadline execution.
The UI imports the shared Ops keys and uses the existing checkbox and notice components.
No raw error string becomes a push body.

## Acceptance checks

1. A real seed-failure file or provider state change produces an immediate Ops push and a bell entry with the same key.
2. A repeated state frame does not repeat that push. Acknowledgement and recovery retract it.
3. Recovery followed by the same failure alerts again. Hosted state exposes no host Ops events.
4. Ops-off devices receive no Ops push. Existing false class switches survive a legacy subscription load.
5. Complete events at the start and near the end of a window produce no push before 600,000 milliseconds.
6. At the deadline, one grouped Complete push reaches each eligible device. A later event starts a new window.
7. Request, Error, and Ops events deliver during a pending completion window.
8. A deadline runs on an otherwise idle board with no open browser tab.
9. Pending completions survive restart with the same deadline. Sent completions do not replay.
10. Read, cancelled, reopened, superseded, muted, unsubscribed, and removed sources do not leak into the digest.
11. A burst larger than the Done window retains eligible older completions through real-store reads.
12. Independent board stores do not share pending events, recipients, or live-alert data. Unknown endpoints remain inaccessible.
13. Property tests cover changed persisted-input normalization with a fixed seed and 100 to 200 runs.
14. The notification settings show Ops and explain the 10-minute Complete delay. Keyboard controls work in a real browser.
15. The bell shows each Ops failure once, with correct new/read state and its existing recovery action.
16. Run the focused tests, UI detector, browser proof, `bun run check`, and `bun test` after the final edit.
17. A project store failure retains the pending digest while healthy projects publish state frames, prune seen keys, and send urgent pushes.
18. A refresh of the same subscription preserves its pending completion. Changed keys and subscriptions after unsubscribe receive no earlier events.
19. Repeated state frames do not read cancelled cards outside the Done window as completion sources.

Mutation testing does not run in this work turn.
