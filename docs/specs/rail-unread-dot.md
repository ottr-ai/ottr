# Rail unread dot counts the board's New cards (OTTR-827)

## Behavior

- The project rail's unread dot counts, per project, the done work cards whose card face shows the New badge.
- A card face shows New when the card is seenable (an answered question, a PR review, done research with a resolved steps report) and no read mark exists: `isUnread` in `src/ui/queue.ts`.
- The rail's read mark keeps OTTR-566's per-completion key `id@doneAt`: a card that returns to Done is New again. Opening a card marks both the plain id and the per-completion key, so the two marks move together.
- Decision: a plain done work card (merged, no question) never counts. It shows nothing on its face, so the dot never lights without a visible cause. Quiet research (no resolved steps), retro and cancelled cards never count either.

## Boundaries and error cases

- The card badge keeps the plain-id key (`isUnread`); the rail keeps the per-completion key (`doneUnread`). They agree because open marks both keys. One standing divergence stays on purpose: an opened steps report keeps its pinned New badge while the dot clears (OTTR-488 x OTTR-566).
- Cards done at or before the server's `seenDoneSince` baseline stay read, so history lights no dot.
- A merged card's drawer open posts no read mark: `doneUnread` no longer fires for it. Stored per-completion keys of merged cards stay harmless leftovers; `/api/seen` still accepts them for older clients.

## Acceptance checks

- Unit (`src/ui/queue.test.ts`): over merged work, answered, PR review, research with steps, research without steps, retro, and cancelled cards, the rail count equals the number of cards whose face shows New.
- UI (`src/ui/app.test.tsx`): a project whose only done card is a merged work card shows no rail dot; an answered unopened card shows both the rail dot and the card badge.
- Screenshots of the rail and a board column after the fix.

## Alternatives considered

- Badge also keyed by `id@doneAt`: rejected. Opening a steps report would clear its pinned New badge and break the OTTR-488 drawer button flow; it reworks every mark path for no acceptance gain.
- Rail keyed by the plain id: rejected. Plain-id marks survive a re-done cycle (PR review cards stay seenable in every stage), so a card that returns to Done would not turn New again; that loses OTTR-566's fix.

## Risks

- A tab on an older client still counts merged cards until it reloads; the state frame carries no version gate for this predicate, so the divergence lasts one refresh at most.
- The tooltip copy changes from "N done unread" to "N unread"; no test pins the old copy.

## Non-goals

- No new read store.
- No server change: `/api/seen` validation and the store decay keep their current key set.
