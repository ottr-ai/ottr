# Notifications

The server decides which events reach the operating system. Web Push is the only OS channel. Desktop browsers subscribe the same way as phones. The event rules live in `src/notifications.ts`; sending lives in `src/webpush.ts`.

## Event classes

- **Request**: a card enters needs you, or asks a new round of questions.
- **Error**: a turn ends with an error. If the card then needs you, the error alert replaces the request for that frame.
- **Complete**: a card enters Done, or a question-only card reports its answer.

A card produces at most one event per state frame. Error wins over Request, and Request wins over Complete. A new card only alerts when it arrives in needs you or with a failed turn. Several events of one class go out as one summary push ("3 tasks need your attention").

## What never pushes

- Notices: updates, drain, behind, orphans, kept, alate pending, sign-in advisories. They stay in the bell.
- The browser-local critical entry.
- Retro cards.
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

Opening the bell panel acknowledges nothing. An entry is acknowledged when you click its row or link, open its card, or press "Mark all as read". The server prunes task keys whose cause has cleared, so a recurrence lights the bell again.

## Presence

Each board tab sends a heartbeat every 20 s while it is visible and focused, and a final unfocused post when it blurs, hides, or closes. Push holds while any tab's last heartbeat is younger than 60 s. The server keeps presence in memory only.

## Retraction

When an alert's cause clears, or you acknowledge it, the server sends a data-only `clear` push with the class tags that have no live alert left. The service worker closes matching notifications. Every alert push also carries the tags to close first, minus the classes that same pass alerts (a new alert replaces its class's notification itself). Before it shows an alert, the service worker checks `/api/inbox/seen` and shows nothing if every key is already acknowledged.

Platform caveats:

- Apple push (Safari, iOS) revokes subscriptions that receive pushes without a visible notification, so clear pushes skip Apple endpoints. The server keeps the pending tags per Apple device and sends them with the next alert push to that device, which closes the stale notifications before it shows the new one. Until that next alert, the old notification stays.
- Chrome may show a generic "site updated in the background" notice for a silent push. Retraction on Chrome is best-effort too.
