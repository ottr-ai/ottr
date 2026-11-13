# Usage-limit probe hold (OTTR-880)

A card whose run or check dies at a provider usage limit waits and continues by
itself, also when the quota report shows no exhausted window.

## Behavior

The settle of a run that `hitUsageLimit` matches stamps a hold on the queued
card. The hold time comes from the first source that applies:

1. The quota report's exhausted window reset (`usageResetFor`), as today.
2. A reset time in the error text (`will reset at <time>`), only when the time
   names an explicit zone (UTC, GMT, `Z`, or a numeric offset). A zoneless time
   (Z.AI writes Beijing time) stays unused: the board never guesses a zone.
3. A probe interval: now + 30m, then 1h, 2h, 4h, 6h. The interval grows with
   the card's consecutive usage-limit holds and stops at 6h.

The hold carries `holdProvider` (the run's provider, `providerOf(model)`),
`holdWindow` (null for sources 2 and 3), `holdAttempts`, and the new
`holdSetAt` stamp (when the hold was set). The board shows the reason and the
next try time; a reply or Resume clears the hold and runs the card at once,
as today.

A run that settles without a usage-limit death clears `holdAttempts` to 0.
A check that passes clears it too. A usage-limit hold in a check run
(`usageHold`, `holdPatch`) increments it. Rate-limit holds (OTTR-847) leave it.

`usageLimitRule` (classify) no longer parks a card after the automatic
continue: every usage-limit death queues again and the hold gates the retry.
A usage-limit death never parks needs_you.

## Early release (the quota refresh)

`releaseUsageHolds` releases a hold early only with recovery evidence: an
earlier refresh — after the hold was set (`holdSetAt`) — saw a blocking
window of the hold's provider (100% used with a future reset at that time),
and the current refresh shows no blocking window. Both halves use the same
`providerBlocked` test, each at its own refresh time: a stale row at 100%
whose reset passed or is unnamed is not evidence, because it reads as free
in the current report too.
app.ts keeps the previous report in memory and passes it to the refresh.

A hold stamped from a silent report (a probe hold, an error-named reset) has
no such evidence at first: it waits holdUntil. It becomes releasable only
after a refresh has seen the provider blocked and a later one sees it free.
Without this rule the same silent report that made the hold would release it
at the next refresh, and the retry would loop about every 5 minutes.

## Store

`tasks.hold_attempts INTEGER NOT NULL DEFAULT 0` and
`tasks.hold_set_at INTEGER` (when the hold was stamped), added to
`TASK_COLUMNS`, `TaskRow`, `toListedTask`, and `Task`. Migration:
`ProjectStore.addColumn` in `ProjectStore.open`, ALTER-only after every
rebuild, like the hold columns of OTTR-688. Existing databases converge.

## Non-goals

New quota providers in omp. A "resume all" button. Guessing time zones.
