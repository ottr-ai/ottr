# Fork research: hourly watch of GitHub forks (2026-10-14)

**Decision:** When the project setting **Fork research** (`forkResearch`) is on, a watcher
polls the project's GitHub forks once an hour. When a fork branch changed since its last
analysis and the quiet gates allow it, Ottr runs one tool-free model call over the new
commits. The result lands as a research card (topic `fork research`, no branch, no
worktree, never scheduled), and interesting findings arrive as at most 3 held proposals
that reuse the retro proposal mechanism: `needs_you` cards with `followUpOf` set to the
result card, started only by Accept. Fork-born tasks hold their merges until you approve
them with a reply, independent of the update-merge hold.

## Poll, not webhook

Upstream GitHub never sees pushes to independent forks: repository webhooks fire only for
the repository they live on, and a fork is a separate repository. Watching forks therefore
needs a poll. The watcher polls hourly and analyzes only on change.

## Gates

Each gate is code, not a prompt instruction:

| Gate | Value |
|---|---|
| Spacing per fork | one analysis per fork per 24 h (`last_run_at`) |
| Rate per project | at most 3 analyses per day (`fork_runs` table) |
| Branch size | skip branches above 500 MB of new commits |
| Fetch timeout | 120 s per fetch |
| Model call timeout | 15 min |
| Retries | 3 consecutive failures pause the branch until a manual check (`POST /api/projects/:project/forks/check`) succeeds |

## The model call is tool-free

The analysis runs through the omp auth-gateway on stdio with no credentials and no tools.
Hostile input (a malicious fork push) stays data in the prompt: the model cannot run
commands, and only the server owns board actions. A secrets scan over the new commits
pauses a suspicious range before the provider call, so nothing sensitive leaves the
machine for analysis. The pause triggers on quoted literal values assigned to credential
names (`password`, `apiKey`, ...); identifier copies (`apiKey = cfg.apiKey`) and
fixture/example values continue, so test fixtures do not stall a real fork. Known token
shapes (AWS, GitHub, Stripe, Google, OpenAI-style, JWT, private key blocks, credentialed
URLs) are redacted in place before the call.

## State

Two tables hold the watch: `fork_branch` (one row per watched branch: head,
`analyzed_head`, pending-since, last run, retries) and `fork_runs` (one row per analysis
attempt, the project rate gate). `createForkResult` writes the result card, its proposals
and the analyzed heads in one transaction, so a restart cannot file the same result twice.

## Merges need approval

A task whose `followUpOf` parent is a fork research card holds at `needs_you` when its
settle reaches `done` or `merging`, with reason `FORK_HOLD_REASON`. A reply approves the
merge (`forkMergeApproved`). The parent existing implies the feature ran, so this hold is
independent of the `forkResearch` toggle: a proposal stays gated after you turn the watch
off.
