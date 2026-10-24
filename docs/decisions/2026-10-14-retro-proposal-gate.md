# Retro after Done, with a proposal approval gate (2026-10-14)

**Decision:** When the project setting **Retro** (`retroSince`) is on, a supervisor pass
files one retro card about 2 minutes after a card reaches Done. Ottr computes the facts
(cost, tokens, tool calls, tool errors, seconds, the slowest calls, the subagent share,
the CI verdict, user replies) into the retro handoff. The agent only judges: it gives a
verdict, queues at most 3 lessons in Hindsight with `retain`, and proposes at most one
improvement with the `propose_task` tool. Ottr files that proposal as a held card
(`needs_you`). It starts only when you **Accept** (the Resume button, relabeled), or you
edit the prompt or model first, reply with a note, or **Decline** (Cancel). At most 3 open
proposals per project. A new held proposal alerts once.

The plan came from the 2026-10-13 handoff. The work is three cards:
the `retro` skill in the data repo, then retro cards in Ottr, then proposals in Ottr.

## What it reverses

Decision 2026-10-13, U5 ("Losing options") rejected weekly proposal cards in
`needs_you`, to keep proposals off the board. This decision reverses that for retro
proposals, and only for them. A held card is different from the rejected idea:

- One proposal is one task that can run, not a recurring stream of cards.
- The card already has everything a panel would need: Edit, Reply, the model picker and Cancel.
- The gate holds: the scheduler starts only `queued` cards, and a proposal is `needs_you`.
- The cap (3 open per project) and the friction filter bound the count.

## The loop guards

Each guard is code, not a prompt instruction:

| Path | Guard |
|---|---|
| A retro of a retro card | `retroPass` skips cards with the retro marker |
| A proposal starts on its own | Ottr creates proposals held; the scheduler starts only `queued` cards |
| The retro files a card itself | a retro run gets no board token and no `create_task` |
| Auto-tend answers a proposal | `tendFamily` matches only kept-worktree reasons |
| Failed retros multiply | one live retro per project |
| Retros hold an open review | `reviewFindings` stops at retro cards |
| Proposals flood you | one proposal per retro, 3 open per project |
| Accept, then the result gets a retro | allowed: each cycle needs your action |

A retro card never alerts and never fills the Unread block of the Done lane.

## Losing options

| Option | Why it lost |
|---|---|
| `create_task` with a server-side hold | the agent keeps the board token, so it can file a card that starts on its own |
| `--tools` as a sandbox | MCP and extension tools stay; omp adds `learn` and `manage_skill`; a real allowlist needs a second runner on the omp SDK |
| The retro inside the merge turn | it judges its own work, holds the merge slot, and pays the work-model price |
| A resumed session for a retro turn | a new turn kind (a CHECK change, so a table rebuild) and a replay of the full context |
| Approval through `ask` | the gate is a prompt, and approval needs a second paid turn |
| A Proposals panel like the Updates panel | storage, routes and an editor for actions that a held card already has |
| A new `proposed` task state | a CHECK change needs a table rebuild; `needs_you` with a reason gives the same behavior |
| Ottr calls a model API directly | a second provider client and new keys |
| Lessons as managed skills (`learn`) | an uncommitted skill in the shared home blocks Alate provisioning |
| One weekly retro over all tasks | cheaper, but it loses the per-task trigger; the lesson list in each handoff already joins the retros of a project |
| A retro after every task, no filter | 15–37 % on top of a median task for little to learn; it stays one setting away |

## Residual risks

1. **Loopback board API.** A retro run has no board token, but on a desktop board the
   API needs none over loopback. A compromised retro could call the board API through an
   MCP code tool such as `ctx_execute`. Every agent run has this risk today. Fix it in a
   separate card: one token for each run, checked also on loopback for agent requests.
2. **Transcript to memory.** The transcript holds tool output and web text, and the retro
   can read it. Auto-retain stores no tool output, and the facts carry none, but the retro
   adds a path from transcript content into project memory. The rules keep that path small
   and visible: at most 3 lessons, each verbatim in the report, each prefixed
   `[retro <date> <task id>]`. They do not close it.

## Calibration knobs

Tune these after two weeks of runs:

| Knob | Value | Meaning |
|---|---|---|
| Proposal threshold | 1 h or $5 | a loss above this proposes even on a first sighting |
| Proposal cap | 3 open per project | change to one board-wide cap before a full rollout |
| Friction filter | on | a retro runs only with a reply or needs-you episode, more than one work turn, a report error or stop continuation, failed CI, or a cost of $0.50 or more; off gives a retro after every task |
| CI grace | 2 h (`CI_WAIT_MS`) | after it, the retro files with "CI unknown" |

A retro costs a median of about $0.024 on the default model, about 15 % of a median task.
