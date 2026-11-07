# Notifications

The server decides which events reach the operating system. Web Push is the only OS channel. Desktop browsers subscribe the same way as phones. The event rules live in `src/notifications.ts`; sending lives in `src/webpush.ts`.

## Event classes

- **Request**: a card enters needs you, or asks a new round of questions.
- **Error**: a turn fails: it ends with an error and without a reported outcome. A turn that reported needs you stores its hold reason in the same field, and that hold is a Request. A turn ended by a deliberate cancel is no error. If the card then needs you on that same failed turn, in the same frame or a later one, the Error is the only alert; once the card waits, the Error takes the needs-you entry's key, so acknowledging or answering that entry retracts it. Acknowledging that entry also acknowledges the Error's original key, so a delayed copy of the Error push never shows.
- **Complete**: a card enters Done, or a question-only card reports its answer.

A card produces at most one event per state frame. Error wins over Request, and Request wins over Complete. A new card only alerts when it arrives in needs you or with a failed turn. A class has one notification per device: when it stands for more than one unread alert, it shows a count ("3 tasks need your attention") and its keys list every alert it counts.

## What never pushes

- Notices: updates, drain, behind, orphans, kept, alate pending, sign-in advisories. They stay in the bell.
- The browser-local critical entry.
- Retro cards and cancelled cards. Cancelling a card retracts its live alerts.
- The first frame after the server starts.
- Any event while a board tab is focused. The event is dropped, not sent later; it still sits in the bell.

The GitHub token expiry reminder (once a day, 30 days before expiry and through the last two weeks) follows the same rules: it goes to devices with Request on, never while a board tab is focused, and a held reminder leaves its day open so the next daily check tries again. Project mutes do not apply; the token belongs to the board.

## Preferences

Preferences live in the global store (`tracker.db`):

- `push_subs`: each subscription carries `classes`, the Request, Error and Complete switches for that device. A subscription without them gets all three on.
- `notify_muted_projects`: projects that never push, on any device. The bell still lights for them.
- `inbox_seen`: acknowledged bell entry keys, shared by every device.
- `notify_live_alerts`: alerts pushed and not yet retracted, plus retractions waiting for an Apple device. A restart keeps them, so the first frame after boot retracts what resolved while the board was down, and later acknowledgements still retract older alerts.

Set them under **Settings → Notifications**. OS notifications need HTTPS, for example `tailscale serve`.

## Routes

- `POST /api/push/subscribe`: subscribe a device. A re-subscribe keeps its classes.
- `GET /api/notifications/prefs?endpoint=…`: the device's classes and the muted projects.
- `POST /api/notifications/prefs`: `{ endpoint, classes }` or `{ mutedProjects }`.
- `POST /api/presence`: `{ tab, focused }` focus heartbeat.
- `GET /api/inbox/seen`: acknowledged keys (the service worker reads this).
- `POST /api/inbox/seen`: `{ keys }` to add, `{ taskIds }` to acknowledge cards, `{ drop }` to remove.

## Acknowledgement

Opening the bell panel acknowledges nothing. An entry is acknowledged when you click its row or link, open its card, or press "Mark all as read". The server prunes task keys whose cause has cleared, so a recurrence lights the bell again. The board drops other cleared keys; browser-local entries (an error or notice in one tab) are dropped only by the tab that showed them. Keys stay short: a needs-you key names its ask round by a hash, and a long notice body (an error text, an id list) is hashed too. The seen route refuses a key over 2000 characters with 400.

## Presence

Each board tab sends a heartbeat every 20 s while it is visible and focused, and a final unfocused post when it blurs, hides, or closes. Push holds while any tab's last heartbeat is younger than 60 s. The server keeps presence in memory only.

## Retraction

When an alert's cause clears, or you acknowledge it, the server sends a data-only `clear` push with the class tags that device has no live alert left in. Retraction is per device: an alert a device never got (class off, project muted) neither keeps nor clears its tags. The service worker closes matching notifications. Every alert push also carries the tags to close first, minus the classes that same pass alerts (a new alert replaces its class's notification itself); an alert whose own class was due for retraction carries `replace`. Before it shows an alert, the service worker checks `/api/inbox/seen`. If every key is already acknowledged it shows nothing and tidies the class instead: with `replace` it closes the tag, otherwise it closes each same-tag notification whose keys are all acknowledged.

Platform caveats:

- Apple push (Safari, iOS) revokes subscriptions that receive pushes without a visible notification, so clear pushes skip Apple endpoints. The server keeps the pending tags per Apple device and sends them with the next alert push to that device, which closes the stale notifications before it shows the new one. Until that next alert, the old notification stays.
- Chrome may show a generic "site updated in the background" notice for a silent push. Retraction on Chrome is best-effort too.
