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
`holdWindow` (null for sources 2 and 3), and the new `holdAttempts` counter.
The board shows the reason and the next try time; a reply or Resume clears the
hold and runs the card at once, as today.

A run that settles without a usage-limit death clears `holdAttempts` to 0.
A check that passes clears it too. A usage-limit hold in a check run
(`usageHold`, `holdPatch`) increments it. Rate-limit holds (OTTR-847) leave it.

`usageLimitRule` (classify) no longer parks a card after the automatic
continue: every usage-limit death queues again and the hold gates the retry.
A usage-limit death never parks needs_you.

The quota refresh (`releaseUsageHolds`) releases these holds early when the
report shows the provider not blocked, as today: probe holds carry
`holdProvider`, so they release the same way.

## Store

`tasks.hold_attempts INTEGER NOT NULL DEFAULT 0`, added to `TASK_COLUMNS`,
`TaskRow`, `toListedTask`, and `Task`. Migration: `ProjectStore.addColumn`
in `ProjectStore.open`, ALTER-only after every rebuild, like the hold columns
of OTTR-688. Existing databases converge with 0.

## Non-goals

New quota providers in omp. A "resume all" button. Guessing time zones.
