# Rail unread dot counts the board's New cards (OTTR-827)

## Behavior

- One rule drives both marks: `isUnread` in `src/ui/queue.ts` decides the card face's New badge and, counted per project, the rail's unread dot. The rail counts a card when and only when its face shows New.
- A card is unread when it is seenable (an answered question, a PR review, done research with a resolved steps report) and its read mark is absent.
- A done work card keys its read mark per completion, `id@doneAt` (OTTR-566): a card that returns to Done is New again even though its plain id stayed marked (a PR review opened in needs_you, then merged; a card answered again after the user read it). A non-done card keys the plain id.
- A card done at or before the server's `seenDoneSince` baseline counts as read on the face as well as the rail, so history lights neither. The baseline is the one scope gate, and it gates both marks alike.
- A done research card with a steps report stays pinned: opening it marks nothing, so its face keeps New and the rail keeps counting it until a drawer button ("Implement steps" / "No further steps") marks it read.
- Decision: a plain done work card (merged, no question) never counts. It shows nothing on its face, so the dot never lights without a visible cause. Quiet research (no resolved steps), retro and cancelled cards never count either.

## Mark paths

- `markRead` (open, drawer close, drawer-open effect, "No further steps") marks the plain id and, for a done work card, the completion key beside it, and posts both.
- `markUnread` removes both keys for a done card and posts both with `unread: true`, so a card the user marks unread re-lights the badge and the dot together.
- `forgetSeen` (a new PR comment wave on a read review) drops the plain id and every `id@<doneAt>` key of the task, so the re-lit badge and dot agree.
- Opening a steps report marks nothing (`autoMarkOnOpen` is false), which is what keeps the report pinned and the dot lit together.

## Boundaries and error cases

- `/api/seen` keeps validating posted ids against the live key set (plain ids of seenable cards, completion keys of done work cards past the baseline); no server rule changes. The store decays keys that stop being live.
- A done card with no completion stamp reads as read (nothing pins it), like a pre-baseline card.
- Cards the server ships with `answered: true` are done and non-retro by construction (app.ts view), so the client's seenable needs no extra retro check.

## Acceptance checks

- Unit (`src/ui/queue.test.ts`): over merged work, answered, PR review, research with steps, research without steps, retro, and cancelled cards, the New set stays equal in four mark states — no marks, plain ids only, completion keys only, both — so a key split cannot make the marks diverge again.
- UI (`src/ui/app.test.tsx`): a project whose only done card is a merged work card shows no rail dot; an answered unopened card shows both the rail dot and the card badge.
- Screenshots of the rail and a board column after the fix.

## Alternatives considered

- Badge keyed by the plain id, rail by the completion key (the state before this spec): rejected. The marks diverge in every state where exactly one key is marked — a card opened before it landed in Done, mark-unread, a new PR comment wave, an opened steps report — which is exactly the bug class this card fixes.
- Rail dropping the baseline so pre-baseline badges keep counting: rejected. History would light every project on first load, the flood OTTR-566's baseline exists to prevent.
- A new read store or a server-side unread count: rejected; the seen set and the client predicate carry the whole rule.

## Risks

- Cards marked read by an older client (plain id only, done after the baseline) re-light once on the new client; opening them re-marks both keys, so the state heals on first open.
- The tooltip copy reads "N unread"; no test pins the old copy.

## Non-goals

- No new read store.
- No server rule change: `/api/seen` validation and the store decay keep their current key set.
