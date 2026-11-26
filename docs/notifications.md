# Notifications

The server decides which events reach the operating system. Web Push is the only OS channel. Desktop browsers subscribe the same way as phones. The event rules live in `src/notifications.ts`; sending lives in `src/webpush.ts`.

## Event classes

- **Request**: a card enters needs you, or asks a new round of questions.
- **Error**: a turn fails, by the runner's own rule: it exits badly, unless it reported a finished outcome (ready, answered, integrated). A needs-you report followed by a crash still fails. A clean needs-you report stores its hold reason in the same field, and that hold is a Request. A turn ended by a deliberate cancel is no error. If the card then needs you on that same failed turn, in the same frame or a later one, the Error is the only alert; once the card waits, the Error takes the needs-you entry's key, so acknowledging or answering that entry retracts it. Acknowledging that entry also acknowledges the Error's original key, so a delayed copy of the Error push never shows.
- **Complete**: a task enters Done, a question-only card reports its answer, or an automatic PR review completes. Push delivery uses a fixed 10-minute digest.
- **Ops**: a provider appears in `deadSignIns`, an agent-layer seed fails, or Alate provisioning reports an error. These board faults use immediate delivery.

A card produces at most one event per state frame. Error wins over Request, and Request wins over Complete. A new card only alerts when it arrives in needs you or with a failed turn. A class has one notification per device: when it stands for more than one unread alert, it shows the count of them all ("3 tasks need your attention"). The payload names at most 20 of their keys (`partial` marks a larger group), so a push stays far below Web Push's ~4 KB budget; whether a payload is still unread is decided by the server, not by these keys (see Retraction).

### Completion digest

The first eligible Complete event starts a 10-minute window for the board. Later events join that window without changing its deadline.
The bell and task read markers remain immediate. Request, Error, and Ops do not wait for the digest.

The server stores the deadline, events, and eligible devices across restart. A new subscription receives no older events.
A refresh of the same subscription keeps its pending events.
The deadline runs without an open tab or another state change. After restart, an overdue digest becomes eligible after source validation.
Before delivery, the server checks current preferences, project mutes, acknowledgements, and source state.
It excludes cancelled, reopened, acknowledged, superseded, or removed sources. It reads the project store for cards outside the Done window.
A source read failure retains the pending batch and reports the error.
An unreadable project does not stop state frames or urgent pushes from healthy projects.

If a board tab has recent focus at the deadline, the server suppresses the digest. It does not postpone it.
An empty digest sends nothing. A consumed digest does not repeat after restart.
Delivery retains the existing at-most-once attempt policy. A crash after consumption but before delivery can lose an attempt.

### Ops catalogue

| Fault | Shared occurrence key | Recovery |
| --- | --- | --- |
| Provider sign-in failure | `signin:<provider>` | The provider leaves `deadSignIns`. |
| Agent-layer seed failure | `seed-failed:<since>` | The failure clears or its episode changes. |
| Alate provisioning error | `shortKey("provision-error", error)` | Provision succeeds, the pending import clears, or the error changes. |

The bell keeps each existing fault row, its details, and its recovery action. Each row counts once as action-required.
The bell and push use the same key. A row click or "Mark all as read" acknowledges it across devices.
Acknowledgement or recovery retracts the alert. A new failure after recovery can alert again, even with the same key.
Repeated state frames and server restart do not replay existing faults.
Hosted tenants do not receive these host faults. Project mutes do not affect Ops because the faults belong to the board.
Push bodies use fixed descriptions, not raw diagnostic errors or credentials.

## What never pushes

- Notices: updates, drain, behind, orphans, kept worktrees, and pending Alate imports. They stay in the bell.
- The browser-local critical entry.
- Retro cards and cancelled cards. Cancelling a card retracts its live alerts.
- Existing faults and card states on the first frame after the server starts. Pending digests retain their deadlines.
- Any event while a board tab is focused. The event is dropped, not sent later; it still sits in the bell.

The GitHub token expiry reminder (once a day, 30 days before expiry and through the last two weeks) follows the same rules: it goes to devices with Request on, never while a board tab is focused, and a held reminder leaves its day open so the next daily check tries again. Project mutes do not apply; the token belongs to the board.

## Preferences

Preferences live in the global store (`tracker.db`):

- `push_subs`: each subscription carries `classes`, the Request, Error, Complete, and Ops switches for that device. A subscription without preferences gets all four enabled. When legacy preferences lack Ops, Ops starts enabled and the other switches keep their saved values.
- `notify_muted_projects`: projects that never push, on any device. The bell still lights for them.
- `inbox_seen`: acknowledged bell entry keys, shared by every device.
- `notify_live_alerts`: live alerts, pending Apple retractions, sequence numbers, and the pending completion digest. A restart preserves the deadline and recipients. It also preserves the information needed to retract resolved or acknowledged alerts.

Set them under **Settings → Notifications**. OS notifications need HTTPS, for example `tailscale serve`.

## Routes

- `POST /api/push/subscribe`: subscribe a device. A re-subscribe keeps its classes.
- `GET /api/notifications/prefs?endpoint=…`: the device's classes and the muted projects.
- `POST /api/notifications/prefs`: `{ endpoint, classes }` or `{ mutedProjects }`.
- `POST /api/presence`: `{ tab, focused }` focus heartbeat.
- `GET /api/inbox/seen`: acknowledged keys.
- `GET /api/notifications/live?endpoint=…`: per class, how many alerts this device still has live and the sequence number of the last alert sent to it (the service worker reads this).
- `POST /api/inbox/seen`: `{ keys }` to add, `{ taskIds }` to acknowledge cards, `{ drop }` to remove.

## Acknowledgement

Opening the bell panel acknowledges nothing. An entry is acknowledged when you click its row or link, open its card, or press "Mark all as read". The server prunes task keys whose cause has cleared, so a recurrence lights the bell again. The board drops other cleared keys; browser-local entries (an error or notice in one tab) are dropped only by the tab that showed them. Keys stay short: a needs-you key names its ask round by a hash, and a long notice body (an error text, an id list) is hashed too. The seen route refuses a key over 2000 characters with 400.

## Presence

Each board tab sends a heartbeat every 20 s while it is visible and focused, and a final unfocused post when it blurs, hides, or closes. Push holds while any tab's last heartbeat is younger than 60 s. The server keeps presence in memory only.

## Retraction

When an alert's cause clears, or you acknowledge it, the server retracts the class tags that device has no live alert left in. Retraction is per device: an alert a device never got (class off, project muted) neither keeps nor clears its tags. The server numbers each alert payload per device and class.

The service worker treats the server as the authority. On every push it reads `/api/notifications/live` for its own subscription and closes every class with no live alert. An alert shows only while its class still has a live alert on the device and it is the newest alert sent for that class, so a resolved, acknowledged or superseded payload never shows, however late or out of order it arrives, grouped or not. Push handlers run one at a time, so a slow handler never overwrites a newer one's result. State lives on the server, so a worker restart loses nothing.

When the server cannot be reached (offline, signed out), the worker falls back to its own history, kept per subscription in the Cache API so a worker restart keeps it: the highest retraction bound it ever got per class (from a clear, the bounds an alert carries, or a class the server reported dead) and the newest alert number it knows of (one it showed, or the last number the server reported as sent, live or not). Offline, an alert shows only when its number is above that bound, not older than the newest known, and not older than a notification still up; a retraction closes notifications whose own number is at or below its bound. A re-subscribe starts a fresh history, because the server numbers each subscription from 1.

Platform caveats:

- Apple push (Safari, iOS) revokes subscriptions that receive pushes without a visible notification, so clear pushes skip Apple endpoints. The server keeps the pending bounds per Apple device and sends them with the next alert push to that device, which closes the stale notifications before it shows the new one. Until that next alert, the old notification stays.
- Chrome may show a generic "site updated in the background" notice for a silent push. Retraction on Chrome is best-effort too.
