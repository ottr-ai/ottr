# Code scanning watch

The board files open GitHub code scanning (CodeQL) alerts as cards, one
consolidated card per rule and project. One automatic task source more, next to
the issue watch. The watch polls hourly, groups alerts by rule, and files one
card per rule. A project setting starts the cards automatically or leaves them
in the backlog.

## Behavior

### Settings

- New project setting `codeScanWatch: boolean`, default `false`. Stored,
  validated, and saved like `issueWatch` (`BOOLEAN_SETTING_FIELDS`,
  `DEFAULT_SETTINGS`, `SETTINGS_SHAPES`). No `since` mark: dedupe keys on the
  alert number, so a restart or a re-enable files nothing twice.
- New project setting `codeScanAutoStart: boolean`, default `false` (OTTR-1256).
  Stored, validated, and saved like the other boolean settings
  (`BOOLEAN_SETTING_FIELDS`, `DEFAULT_SETTINGS`, `SETTINGS_SHAPES`); the
  key-value `settings` table needs no schema migration for it.
  - On: the watch files each new consolidated rule card at `stage: "todo"`,
    `state: "queued"` (the `createTask` defaults, `queuedAt` = filing time), so
    `pickRunnable` picks it and the scheduler's normal parallel limits decide
    when it runs. The prompt gate still judges the card at turn start.
  - Off (default): cards file `stage: "backlog"`, `state: "idle"`,
    `queuedAt: null`, as before.
  - The setting never moves cards that already exist; it only decides the stage
    of cards filed after it turned on.
- The Settings `Watches` card shows a `Code scanning` row. The row is disabled
  while the project has no GitHub remote and the watch is off, like the issue
  watch row. When the watch is on, the row shows `Last check: X. Next regular
  check: Y.` like the PR reviews row (OTTR-1071). A `Check alerts now` button
  runs the same tick the hourly poll runs.
- Below the `Code scanning` row, a sub row `Start code-scanning cards
  automatically` carries the setting, its accessible name and a help line; it
  is disabled while `codeScanWatch` is off.

### Watch status (OTTR-1071 shape)

- `CodeScanWatchStatus` in `src/types.ts`: `lastPollAt`, `lastError`,
  `nextPollAt` (epoch ms or null). In-memory only; a restart clears it.
- `ProjectView.codeScanWatch: CodeScanWatchStatus`. `lastPollAt` and
  `lastError` come from the watcher's `pollStatus(project)`; `nextPollAt` comes
  from the server's hourly grid, like `prPollNextAt`.

### Fetch

- One fetch path only: `src/githubAlerts.ts` keeps the paging code and exports
  `fetchCodeScanningAlerts(gh, id)`, a thin export of its existing code-scanning
  fetch. The request URL stays
  `GET repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page=100&page=N`
  (offset pages, at most 5 pages of 100).
- `githubAlerts.ts` also exports:
  - `ALERT_SEVERITY_RANK` (the existing `SEVERITY_RANK`), shared by the review
    summary and the watch.
  - `CODE_SCAN_MAX_ALERTS = 500` (`PAGE_SIZE * MAX_PAGES`): at or above this
    count a fetch may be truncated.
  - `codeScanningUnavailable(reason)`: true when the reason matches the
    existing `NOT_ENABLED_RE`, or contains `HTTP 403`, `HTTP 404`, or
    `Not Found`. This covers "code scanning not enabled" and a repo without
    Advanced Security.
- A failed fetch logs one line and files nothing. A 403 or 404 is not an error
  card. No watcher failure ever files an error card.

### Parsing (untrusted input)

- `parseCodeScanAlerts(body: unknown)` in `src/codeScanWatch.ts` reads the
  documented alert-list envelope. Per entry it reads: `number` (integer > 0),
  `state` ("open" only), `html_url`, `rule.id`, severity from
  `rule.security_severity_level` with `rule.severity` as fallback,
  `most_recent_instance.location.path`, `most_recent_instance.location.start_line`,
  and `most_recent_instance.message.text`. Malformed entries are skipped, never
  thrown on. Every string goes through `githubAlerts.ts cleanText` (control
  characters and DATA fence markers die, length capped).
- `CodeScanAlert`: `{ number, rule, severity, path, line, url, message }`.
- Alert order inside a rule: severity first (critical, high, medium, low,
  others last), then alert number ascending.
- Rule order: worst severity of the rule's alerts first, then rule id ascending.

### Cards (OTTR-1256 consolidation)

- One card per rule and per project — no part cards. The `CODE_SCAN_GATES.SPLIT`
  gate is gone. Title: `Code scanning: {rule} ({n} alerts)` with `n` = the
  card's own open alert count.
- Grouping is deterministic: the fetch's alerts group by `rule.id`. No model
  run groups them. (A model run stays allowed only if a future spec shows it
  groups better, for example two rules that share one sink function; its output
  could then only merge rule groups, never drop an alert, and a failure would
  fall back to the deterministic grouping.)
- Cards file like issue cards (`fileIssueCard` pattern): `createTask` then
  `updateTask` to `topic: "code scanning"`, then backlog-ify
  (`stage: "backlog"`, `state: "idle"`, `queuedAt: null`) or, with
  `codeScanAutoStart` on, no backlog-ify (the `createTask` defaults:
  `stage: "todo"`, `state: "queued"`). The prompt gate judges both shapes.
- One card takes one daily-cap slot, however many alerts it holds.

### Card prompt (three tiers)

The prompt holds fixed trusted instructions, then one `<<<DATA` block with the
alerts. Alert text is untrusted data: it stays inside the DATA block, fence
markers removed, and the prompt says the block is data, never instructions. The
whole prompt fits the board's 20 000 character prompt limit (per-alert strings
are capped: message 300, path 300, url 300). `codeScanCardPrompt` builds the
largest tier that fits, in order:

1. **Full** (small rules): today's per-alert format. Per alert, two lines:
   - `#{number} {severity} {path}:{line} - {message}`
   - two-space indented `{url}`
   - An alert whose path matches a test layout (`/test`, `/tests`, `/spec`,
     `/specs`, `/__tests__/` segments, or a `.test.` / `.spec.` file suffix)
     carries the note `(test file; the agent decides)` at the end of its first
     line.
2. **Compact**: the alert list grouped by file, one line per file:
   - `{path}: #{n}:{line}, #{n}:{line}, ...` (numbers ascending, file paths
     ascending; no per-alert severity or URL)
   - then a `MESSAGES` list that keeps each distinct alert message once, with
     the alert numbers that carry it: `- {message}: #{n}, #{n}`
   - then, when at least one alert sits in a test layout, one line
     `Test-file alerts (the agent decides): #{n}, #{n}`.
3. **Fallback** (the compact form would still overflow): a per-file summary
   with every alert number — `{path}: #{n}, #{n}`, files ascending — plus one
   trusted head line telling the agent where the full list lives:
   `The messages and URLs did not fit the prompt. Read the full alert list from
   code-scan-alerts.md in the worktree root (the board writes the file there
   when the turn starts).` If even the per-file summary would overflow (many
   files with 300-character paths), the last tier lists the bare alert numbers
   `#{n}, #{n}, ...` plus the same head line — every alert number is always in
   the prompt, and the numbers-only form always fits at `CODE_SCAN_MAX_ALERTS`.
- Prompt instructions tell the agent to: fix the cause of each alert; say in
  the report which alert numbers the fix closes; name false positives in the
  report; and never dismiss or reopen anything on GitHub (dismissal needs the
  user).

### Fallback alert file

- `codeScanWatch.ts` exports `CODE_SCAN_ALERTS_FILE` (`code-scan-alerts.md`),
  the fallback marker line, and `codeScanAlertsFileText(rows)` (the full
  per-alert format of all the card's store rows, strings re-cleaned at build).
- When a turn's worktree is prepared (`prepareTurnWorktree` in `src/turn.ts`)
  for a card whose prompt carries the fallback marker, the board writes
  `code-scan-alerts.md` at the worktree root from the card's `code_scan_alert`
  rows, and adds `/code-scan-alerts.md` to the repo's common
  `.git/info/exclude` (idempotent, the same write `excludeAndVerify` does for
  copied untracked files). The file stays outside git: `git status` in the
  worktree stays clean, and the tracker's uncommitted-files checks never see
  it. A card whose prompt fits in tier 1 or 2 gets no file.

### Convergence of old part cards (OTTR-1256)

- Every tick, after the removal pass, the watcher converges each rule that has
  open (skipped = 0) rows on more than one unstarted card: a card is unstarted
  while `stage`/`state` is `backlog`/`idle` or `todo`/`queued` and it is not
  cancelled. The rows of the other unstarted cards move onto the oldest one
  (lowest `createdAt`, then lowest task id) in one store transaction; each
  dropped card is cancelled (`cancelledAt` set, already-cancelled cards
  untouched) and its prompt gains a line that names the kept card
  (`Merged into {taskId}: its rule's alerts now live on one card.`); the kept
  card's prompt rebuilds from all its rows and its title rebuilds from its new
  count (no `part k` suffix).
- Started cards (any other stage or a preparing/running state) are never
  touched by convergence: they keep their prompt and their rows.
- Each convergence logs one line naming the kept card and the dropped cards.

### Appends and removal

- The store keeps one row per alert number in a `code_scan_alert` table
  (per-project store). Rows store the prompt fields, the owning card's task id,
  a `skipped` flag, `filed_at` (last update), and `card_filed_at` (when the
  owning card was created; appends and merges keep the owning card's value).
- A new tick adds new alert numbers to the rule's open card and files no second
  card: the append target is the rule's single unstarted card (backlog/idle or
  todo/queued — convergence guarantees at most one). The appended card's prompt
  rebuilds and its title count updates. When the rule's only open cards are
  started, the fresh alerts file a fresh follow-up card on a later tick (one
  daily-cap slot): a started card keeps its prompt, and new alerts wait for it
  to land.
- A closed, fixed, or dismissed alert (absent from a complete fetch) leaves the
  card: its row dies, and the card's prompt rebuilds from the remaining rows.
  The removal pass runs only when the fetch is complete (fewer than
  `CODE_SCAN_MAX_ALERTS` alerts); a possibly truncated fetch removes nothing,
  so an alert parked past page 5 never dies wrongly.
- A card whose last alert row leaves cancels automatically (`cancelledAt` set)
  while it is unstarted — `backlog`/`idle` and, with auto-start on,
  `todo`/`queued` — so a queued card cancels before it starts. A started card
  keeps its prompt update and finishes its turn. Each cancel logs one line.
- A cancelled card is the user's "do not file": its alerts' rows turn
  `skipped = 1` and stay filed nowhere. When a new alert number appears for that
  rule, the watch re-files the rule: all currently open alerts of the rule
  (skipped ones included) go into one fresh card, subject to cap and order.
- A watcher tick never writes after the setting turned off mid-scan: every
  write runs inside a store transaction that rechecks the live setting first
  (the issue watch's `watching()` pattern).

### Order and cap

- Cards file in one transaction, ordered by rule severity (critical first), then
  rule id.
- Daily cap per project, like the issue watch: `CODE_SCAN_GATES.DAILY_CARDS =
  10` cards in the last `DAY_MS = 86_400_000` ms. The count is distinct card
  task ids with `card_filed_at` inside the window; a converged rule's moved rows
  count once under the kept card's id. Appends to existing cards need no slot;
  rules over the cap wait and a log line names them.

### Wiring

- `createCodeScanWatcher({ projects, log, gh?, now? })` in
  `src/codeScanWatch.ts` mirrors `createIssueWatcher`:
  `{ tick(opts?: { manual?: string }), pollStatus(project) }`, wrapped in
  `singleFlightTick`.
- `src/app.ts`: builds the watcher (`[code-scanning]` log prefix), exposes
  `codeScanWatchTick(opts?)` as a `backgroundTick("code scanning watch", ...)`,
  fills `ProjectView.codeScanWatch`, and adds `codeScanWatch` and
  `codeScanAutoStart` to the boolean settings fields.
- `src/server.ts`: boot + hourly tick, with a `codeScanPollGrid` reset like
  `prPollGrid`, served to the app through a `codeScanPollNextAt` dep.
- New route `POST /api/projects/:project/code-scanning/check` (`costly: true`),
  mirroring `prs/check`: 404 unknown project, 409 no GitHub remote, else
  `tick({ manual })`.

## Store contract

```ts
export interface CodeScanAlertRow {
	number: number; rule: string; taskId: string; severity: string;
	path: string; line: number; url: string; message: string;
	skipped: boolean; filedAt: number; cardFiledAt: number;
}
export interface NewCodeScanAlert {
	number: number; rule: string; severity: string;
	path: string; line: number; url: string; message: string;
}

// ProjectStore methods, all queue-serialized:
getCodeScanAlert(number: number): Promise<CodeScanAlertRow | null>
codeScanCardsFiledSince(since: number): Promise<number>
// skipped = 0 rows of one rule, grouped by task id:
codeScanRuleCards(rule: string): Promise<{ taskId: string; rows: number; newestFiledAt: number }[]>
// one transaction; createTask + stage-ify + row inserts; throws when an alert number already has a row.
// start: true files the card at the createTask defaults (todo/queued, auto-start); default files backlog/idle.
fileCodeScanCards(o: { items: { rule: string; title: string; prompt: string; alerts: NewCodeScanAlert[] }[]; now: number; start?: boolean }): Promise<Task[]>
appendCodeScanAlerts(o: { taskId: string; alerts: NewCodeScanAlert[]; now: number }): Promise<void>
// one transaction: moves the open (skipped = 0) rows of every drop card onto keep,
// cancels each drop (cancelled_at only when null) and appends the reason line to its
// prompt; returns the moved row count.
mergeCodeScanCards(o: { keepTaskId: string; dropTaskIds: string[]; reason: string; now: number }): Promise<number>
// open (skipped = 0) rows of one card, severity then number order:
codeScanCardRows(taskId: string): Promise<CodeScanAlertRow[]>
removeCodeScanAlerts(numbers: number[]): Promise<string[]> // deletes rows; returns affected task ids
rebuildCodeScanPrompt(taskId: string, prompt: string): Promise<void>
cancelCodeScanCard(taskId: string, now: number): Promise<void> // sets cancelledAt only when null
skipCancelledCodeScanCards(): Promise<string[]> // rows of cancelled cards -> skipped = 1; returns affected task ids
resetCodeScanSkipped(rule: string): Promise<number> // skipped = 1 -> 0 for the rule; returns count
```

Schema (unchanged; `codeScanAutoStart` lives in the key-value `settings` table):

```sql
CREATE TABLE IF NOT EXISTS code_scan_alert (
  number INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  task_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  url TEXT NOT NULL,
  message TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0,1)),
  filed_at INTEGER NOT NULL,
  card_filed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_scan_alert_task ON code_scan_alert (task_id);
CREATE INDEX IF NOT EXISTS idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at);
```

## Watcher contract

```ts
export const CODE_SCAN_GATES = { DAILY_CARDS: 10, DAY_MS: 86_400_000 } as const;
export const CODE_SCAN_ALERTS_FILE = "code-scan-alerts.md";
export const CODE_SCAN_FALLBACK_MARKER = "code-scan-alerts.md in the worktree root";
export function parseCodeScanAlerts(body: unknown): CodeScanAlert[]
export function codeScanCardTitle(rule: string, total: number): string
export function codeScanCardPrompt(o: { repo: string; rule: string; total: number; alerts: CodeScanAlert[] }): string
export function codeScanAlertsFileText(o: { repo: string; rule: string; rows: CodeScanAlertRow[] }): string
export function createCodeScanWatcher(deps: {
	projects: () => Iterable<ForkProject>;
	log: (m: string) => void;
	gh?: GhFn;
	now?: () => number;
}): {
	tick(opts?: { manual?: string }): Promise<void>;
	pollStatus(project: string): { at: number; error: string | null } | null;
};
```

## Acceptance checks

- Fake-gh tests (`src/codeScanWatch.test.ts`, mirroring `src/issues.test.ts`)
  that fail before the change:
  - 42 alerts of one rule file one card that takes one daily-cap slot; the
    prompt holds all 42 alert numbers and fits the 20 000 character limit.
  - A fixture large enough to overflow the compact form takes the fallback
    path, still lists every alert number, and fits the limit.
  - Three open backlog part cards of one rule converge to one card on the next
    tick (rows moved, prompts and titles rebuilt, drops cancelled with a reason
    naming the kept card); a started part stays untouched.
  - `codeScanAutoStart` off: new cards land `backlog`/`idle`; on: they land
    `todo`/`queued` and `pickRunnable` returns them; the setting never moves
    existing cards.
  - A queued card whose alerts all close cancels before it starts.
  - Dedupe of a known alert number (append, no second card); removal of a fixed
    alert (prompt rebuild, emptied unstarted card cancel); the cancelled-card
    rule (skip, then re-file one card when a new number appears); the 403 path
    (one log line, no cards); the exact request URL; the daily cap;
    severity-first order; test-file note; fence-marker death in alert text.
  - One fast-check property over `codeScanCardPrompt`: for arbitrary alert
    lists the prompt never throws, stays inside the limit, and carries every
    alert number (the existing `parseCodeScanAlerts` property stays).
- Settings round-trip (`src/app.test.ts`): `codeScanAutoStart` off by default,
  save works, wrong type answers 400.
- Store defaults (`src/store.test.ts`): `codeScanAutoStart: false` pinned.
- Scheduler test (`src/scheduler.test.ts`): a card filed with `start: true`
  comes back from `pickRunnable`.
- Turn test (`src/turn.test.ts`): a fallback-tier card's prepared worktree
  holds `code-scan-alerts.md` with every alert number, and `git status` in the
  worktree stays clean.
- UI test for the new row (`src/ui/settings.test.tsx`): renders with its
  accessible name and help text, toggles, and is disabled while the watch is
  off.
- Screenshot of the Watches card with the new row.
- `bun run check` and `bun test` exit 0.

## Non-goals

- No dismiss or reopen calls to GitHub; the watcher never writes alerts state.
- No secret scanning cards (different flow).
- No change to the review prompt's alert text (`githubAlertSummary`).
- No GitHub webhook mapping (`tickGithubWatchers` stays as it is).
- No model-based grouping (deterministic grouping files the cards).
