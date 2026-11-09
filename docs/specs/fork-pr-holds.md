# Spec: per-commit fork PR holds

Card OTTR-742. **Supersedes the OTTR-700 cursor hold** (`hold_prs` / `hold_base` /
`releaseHolds`, merged to origin/main as 984d2cd and companions): the branch that
carries this spec replaces that design outright; no second hold mechanism stays.
The `hold_prs` / `hold_base` columns remain in `fork_branch` additively only as a
retired migration source (see "Legacy hold conversion").

## Goal

Fork research never analyzes commits that an open pull request into the project
covers, never loses a held commit, and never re-sends work it already analyzed.
The analyzed cursor only moves forward.

## Terms

- **PR head**: the tip SHA of an open PR into the project repo (`listPulls`).
- **pull ref**: `refs/pull/<n>/head` of the project repo, fetched into the fork
  cache as `refs/heads/pr-<n>` (constant `PR_REF = "refs/heads/pr-"`).
- **held commit**: a fork-branch commit covered by a PR head; it stays out of
  analysis ranges.
- **released commit**: a held commit whose PR no longer covers it; it rides the
  next analysis range as an extra commit; its row is deleted once consumed.
- **cursor**: `fork_branch.analyzed_head`; monotonic forward, never rewound.

## Data model

`src/store.ts` SCHEMA gains one new table (no existing table changes, so no
`ALTER` migration is needed for it; `CREATE TABLE IF NOT EXISTS` converges old
databases, same as `trending_verdict`):

```sql
CREATE TABLE IF NOT EXISTS fork_hold (
  fork_id INTEGER NOT NULL,
  branch_hash TEXT NOT NULL,
  sha TEXT NOT NULL,
  pr INTEGER NOT NULL,
  pr_head TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0,1)),
  PRIMARY KEY (fork_id, branch_hash, sha)
);
```

- `pr_head` is the PR head the judgment last used (40-hex, validated on write).
- `released = 1` marks a commit dropped from its PR that waits to ride the next
  analysis range.

`src/types.ts` gains:

```ts
/** One held fork-branch commit with the PR it was judged against. */
export interface ForkHoldState {
	forkId: number;
	branchHash: string;
	/** 40-hex commit sha. */
	sha: string;
	/** PR number the commit was judged against. */
	pr: number;
	/** PR head the judgment used (40-hex). */
	prHead: string;
	/** 1 = dropped from its PR; rides the next analysis range, then the row is deleted. */
	released: number;
}
```

`ForkBranchState` stays unchanged: no hold columns land on `fork_branch`.

### Legacy hold conversion (two steps)

The retired cursor hold kept `fork_branch.hold_prs` (JSON list of `{ n, head }`)
and `hold_base` (the cursor before the first held run); its held commits sit
between `hold_base` and the branch head — a window only git can name. The
conversion therefore runs in two steps and drops nothing:

1. **Store, in `ProjectStore.open`** (one transaction, idempotent): for every
   `fork_branch` row with a non-null `hold_prs`, parse it with the legacy
   parser and seed one `fork_hold` row per entry (`sha` = `pr_head` = the PR
   head, `released = 0`), then clear `hold_prs`. `hold_base` stays: it is the
   expansion window the watcher needs. Malformed JSON converts to nothing.
2. **Watcher, at the first re-judge of that branch**: read `hold_base` via
   `legacyForkHoldBase`, expand `git rev-list <hold_base>..<branch head>` into
   per-commit rows attributed to the first seeded PR whose head reaches the
   commit (fallback: the first seeded entry; rows already present are not
   duplicated), write them with `setForkHolds`, then clear `hold_base` with
   `clearLegacyForkHoldBase`. From then on the branch is an ordinary per-commit
   branch: a PR that resolves releases (or drops) every held commit, so a live
   board loses no held commit. A failed expansion (missing objects) skips and
   keeps `hold_base`, so the next tick retries; the seeded head row still holds
   the PR meanwhile.

The `hold_prs` / `hold_base` columns themselves stay in the `fork_branch` DDL
additively (live databases carry them; dropping them is destructive), marked
retired and never written again. The pre-700 `ALTER` convergence for both
columns stays, so an older database still migrates cleanly.

## Store API

```ts
// Holds of one fork, any order.
listForkHolds(forkId: number): ForkHoldState[];

// Replaces ALL hold rows of one branch with `rows` in one transaction.
setForkHolds(
	forkId: number,
	branchHash: string,
	rows: Array<{ sha: string; pr: number; prHead: string; released: boolean }>,
): void;

// The retired cursor-hold base of one branch, for the legacy conversion above.
legacyForkHoldBase(forkId: number, branchHash: string): string | null;
clearLegacyForkHoldBase(forkId: number, branchHash: string): void;
```

`deleteForkBranchesNotIn(ids)` also deletes `fork_hold` rows whose `fork_id` is
absent from `ids` (same statements pattern as the `fork_branch` deletes).

`createForkResult`'s `analyzed` entries gain an optional `consumed?: string[]`
(list of hold shas). In the same transaction that advances the cursor, it
deletes the branch's `fork_hold` rows whose `sha` is in `consumed`.

Fixture tests in `src/store.test.ts`: (1) a legacy database without the
`fork_hold` table converges on open and round-trips `setForkHolds`;
(2) `setForkHolds` replace-all; (3) `deleteForkBranchesNotIn` prunes holds of
absent forks and clears all on empty ids; (4) `createForkResult` deletes
consumed rows in-transaction and leaves non-consumed rows; (5) a database in
the retired cursor-hold shape (with a `hold_prs` JSON row) converges on open:
the entry seeds a `fork_hold` row, `hold_prs` clears, and a malformed JSON row
converts to nothing; (6) a database without the retired columns gains them
additively.

## prs.ts addition

```ts
/**
 * State of a PR the open list no longer shows: whether it merged and its final head SHA.
 * Returns null while GitHub still reports the PR open. Throws on a gh failure or a
 * malformed body, so callers never guess a state.
 */
export async function pullState(
	repo: string,
	n: number,
	gh: GhFn,
): Promise<{ merged: boolean; head: string } | null>;
```

Implementation: `gh(["api", `repos/${repo}/pulls/${n}`])`; `state === "open"` →
null; `state === "closed"` with a 40-hex `head.sha` → `{ merged: merged_at is a
non-empty string, head }`; anything else throws. `GhFn` is the existing
`forks.ts` type shape (args, timeoutMs optional, `{ code, stdout, stderr }`) —
import it the same way `listPulls` does. Tests in `src/prs.test.ts`: open →
null; closed merged → `{ merged: true, head }`; closed unmerged → `merged:
false`; gh failure throws; malformed body throws.

## forks.ts engine

### rangeCommits

```ts
export async function rangeCommits(
	cachePath: string,
	analyzedHead: string | null,
	head: string,
	upstreamHead: string,
	git: GitFn,
	exclude: string[] = [],
): Promise<{ shas: string[]; merges: string[] }>
```

Base behavior unchanged when `exclude` is empty. Each exclude ref removes its
covered commits from `shas` and `merges`: a range commit is covered by ref R
when it is absent from `rev-list --no-merges --cherry-pick --right-only R...head`
(patch-equal counts as covered, matching the cherry-pick semantics); merges are
covered when `--merges base..head ^R` drops them.

### collectRange

```ts
export async function collectRange(o: {
	cachePath: string;
	mainPath: string;
	fork: ForkInfo;
	branches: Array<{
		branchHash: string;
		branch: string;
		head: string;
		analyzedHead: string | null;
		/** The branch's released hold shas; they ride this range as extra commits. */
		released?: string[];
	}>;
	git: GitFn;
	exclude?: Array<{ n: number; head: string }>;
}): Promise<{
	range: ForkRange;
	/** Newly covered commits per branch hash, to store as unreleased hold rows. */
	holds: Map<string, Array<{ sha: string; pr: number; prHead: string }>>;
	/** Released shas per branch hash that the upstream intersection dropped. */
	filteredReleased: Map<string, string[]>;
}>
```

Per branch: run the base range logic, then attribute each covered commit to the
first exclude entry (ascending `n`) that covers it and record it in `holds`
with that entry's `n`/`head` as `pr`/`prHead`. Released extras join `shas`
before the upstream intersection; the ones the intersection drops land in
`filteredReleased` (their content reached upstream some other way). Coverage
uses the cache refs `PR_REF + n`, which the watcher fetched beforehand.

### Watcher tick (per project, per fork), ordered

1. Read `fork_branch` rows of the fork. Skip the fork when no row has hold rows
   and no row is pending (`head !== analyzedHead`) — `listPulls` stays uncalled.
2. `pulls = listPulls(repo, gh)` once per project, on first need; on failure log
   and stop the project's fork loop (never act on a partial list).
3. **Pull-ref fetch, before any judgment**: `ensureCache`, then one `fetchFork`
   with `+refs/pull/<n>/head:refs/heads/pr-<n>` for every open pull, plus every
   held PR that needs a coverage proof against a final head (`merged` with
   `prHead !== head`). The upstream URL is
   `${githubHost().webBase}/${repo}.git` guarded by `REPO_RE`. This runs
   ungated so step 4's `merge-base` checks always find the objects; the
   branches' own refspecs fetch later, inside the gated run section.
4. **Re-judge holds** (runs ungated, before the run gates; writes persist even
   when the run is later gated off). Per branch with hold rows, first the
   legacy expansion of the "Legacy hold conversion" section, then, per hold
   row, in this order; released rows are skipped:
   - PR `pr` in `pulls` (open), `cur = pulls[pr].head`:
     - `cur === prHead` → row unchanged.
     - `cur !== prHead` → coverage re-judge (below).
   - PR not in `pulls`: ask `pullState(repo, pr)` once per PR per tick, cached in
     a Map. On throw: log, leave the row unchanged. On null (GitHub still open —
     a race): leave the row unchanged. On `{ merged: true, head }`:
     - `prHead === head` (merged with the held head) → **drop the row**; no
       analysis. Covers squash merges and merges the local checkout has not
       pulled.
     - `prHead !== head` (merged with another head) → coverage vs the final head
       (below): provably covered → drop the row; provably not covered → release;
       git failure (objects missing) → drop the row (unprovable; the PR carried
       the work).
   - `{ merged: false }` (closed unmerged) → coverage re-judge (below).
   - **Coverage re-judge**: `git merge-base --is-ancestor <sha> <ref>` in the
     cache; exit 0 = covered, exit 1 = not covered, other exit = failure. The
     ref for an open PR is its pull ref (fetched in step 3); for a merged PR's
     final head it is the `pr-<n>` ref fetched for the proof.
     - Covered by the current (or final) head → keep the row, update `prHead`
       to that head.
     - Not covered → check the other open PR heads ascending by number; the
       first that covers the sha re-points the row (`pr`, `prHead` = that PR).
       None covers → `released = 1` (row kept, `pr`/`prHead` unchanged).
   - Write each changed branch with one `setForkHolds` carrying the branch's
     full next row set.
5. `pending` = rows with `head !== analyzedHead` OR with released hold rows
   (released commits are pending analysis work, so they reach the gated run
   without waiting for unrelated pushes; a released-only branch has
   `firstPendingAt` null, which the quiet gate reads as waited-its-whole-life).
   Gates exactly as the base (fork run spacing, retries pause, quiet/max-wait,
   project daily cap), same order.
6. Inside the gated run section: fetch the pending branches' own refspecs
   (`+refs/heads/<branch>:refs/heads/<branchHash>`) into the cache.
7. `collectRange` with `exclude` = the open pulls (`n`, `head`) and each
   branch's `released` shas from `listForkHolds`.
8. **Empty-range fast path**: when every pending branch has an empty filtered
   range (`range.commits.length === 0 && range.merges.length === 0`): no
   `recordForkRun`, no `analyze`, no card. Per pending branch: `setForkHolds`
   (new holds from step 7 merged over surviving rows; remaining released rows
   omitted — they are all consumed: analyzed earlier or dropped by the upstream
   filter), and `saveForkBranch` with `analyzedHead = head`,
   `firstPendingAt = null`, `lastError = null`, `retries = 0`. Continue with
   the next fork.
9. `recordForkRun`, then `analyze(range, buildPrior(store))`.
10. On success: `covered = new Set(result.commits)`. Cursor per range head:
    - deferred result: the last covered commit of that branch; a branch with
      zero range commits advances its cursor to its head (its work is held).
    - otherwise: the branch head.
    Consumed released rows per branch = (released rows ∩ covered); rows in
    `filteredReleased` are consumed unconditionally (their content arrived
    upstream). Step 10's `setForkHolds` per pending branch merges the new holds
    over the surviving rows and KEEPS released∩covered rows: `createForkResult`
    and its transaction are their only deletion point, so a failed card
    creation cannot lose them. `filteredReleased` rows are omitted from the
    set. Then `createForkResult` runs with the `consumed` lists (its
    transaction advances cursors and deletes consumed rows).
11. On throw: the base failure path (retries+1, `lastError`, log). Hold writes
    from step 4 persist: PR state changes are facts independent of run success.

### Invariants

- **Forward-only cursor**: `analyzed_head` is only ever set to a branch head
  observed after the old cursor, or to a covered descendant of it. Nothing in
  the engine rewinds it.
- A commit is never analyzed while an unreleased hold row covers it, and never
  lost: released rows survive a failed run and retry.
- `listForkHolds` results are the only hold source; no hold state lives on
  `fork_branch`.

## Acceptance checks

`bun run check` and `bun test` exit 0. Tests in `src/forks.test.ts` with real
git fixtures (harness as today; the gh stub dispatches on URL: `repos/o/r/forks`
for the fork list, `repos/o/r/pulls?state=open` for `listPulls`,
`repos/o/r/pulls/<n>` for `pullState`). The behavior tests main already carries
stay and must stay green — they pin the two behaviors this design keeps:
held work of an open PR stays out, and held work comes back when the PR closes
unmerged, drops it, or merges with another head. The store fixtures of the
"Legacy hold conversion" section run in `src/store.test.ts`.

1. **Direct PR branch + squash merge files nothing**: fork branch `feat` is the
   open PR #5 head. Tick 1: commits held, cursor advances to the head, no card,
   no analyze call. GitHub reports the PR merged at the same head; tick 2: hold
   rows gone, no card, still no analyze call (upstream gains only an unrelated
   squash commit with a different sha).
2. **Direct PR branch + merge not pulled locally files nothing**: as above, but
   `pullState` reports `{ merged: true, head: prHead }` while the local main
   fixture never receives the merge. Tick: hold rows dropped, no card.
3. **PR append with unrelated analyzed work does not resend that work**: commit
   A on `feat` analyzed (one card, cursor at A). A PR opens with head A+B:
   next tick holds B, advances the cursor to B, analyze-call count stays 1,
   card count stays 1. A further append to C re-judges B (covered by C, the
   row's `prHead` becomes C), holds C, and still calls analyze once.
4. **A PR that drops a held commit gets that commit analyzed**: PR #5 head B is
   held (cursor at B). The PR force-pushes a rebased head D that lacks B:
   tick releases B (not covered by D or any other open PR), holds D, and the
   run analyzes B (card contains B's subject; B's hold row is deleted after the
   successful run; D's row survives).
5. **Closed-unmerged PR gets its held commits analyzed**: PR #5 head B held;
   `pullState` reports `{ merged: false, head: B }`: tick releases B and the
   run analyzes it.
6. **PR whose held commit is covered by another open PR stays out**: hold on B
   via PR #5; PR #6 (other head covering B) opens as #5 closes: B re-points to
   #6, stays held, no analysis.
7. Existing fork watcher tests stay green unchanged in intent (their gh stubs
   return no pulls, so no hold logic engages; `rangeCommits`/`collectRange`
   default args keep their current shapes).

## Non-goals

- Back-holding commits a merged PR's final head covers that were never held
  (already analyzed work stays analyzed).
- Cross-fork hold sharing: holds are per fork branch, as the table key shows;
  the upstream cherry-pick intersection absorbs patch-equal duplicates.
- pullState failures are retried on later ticks, never queued or alerted.
- No UI changes; no new dependencies; no changes to `ForkBranchState`,
  `ForkRange`, `ForkCommit`, or `ForkAnalysisResult`.
- Perf: one `rev-list` per open PR per run; held PR counts are small; no cache.
