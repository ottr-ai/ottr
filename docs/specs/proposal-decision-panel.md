# Proposal decision panel

A proposal card (a retro or fork proposal parked at needs_you) gets a decision panel
at the top of its drawer and a Decide entry on the board card, so the user decides in
a few seconds without reading the full prompt.

## Behavior

- Drawer: the panel is the first section of the drawer body, before Lineage and
  Prompt. It holds:
  - the proposal reason line with the source-card link (ProposalReasonLink);
  - five labeled lines from the stored summary: What changes, Why, Gain, Risk,
    Check. Card ids inside Why render as links to those cards;
  - three buttons: Accept (primary, sends the "." reply like today's Accept),
    Edit (opens the prompt editor), Cancel (danger, today's cancel flow with its
    confirm step). Accept and Edit disable while the editor is open;
  - a collapsed "Full prompt" section with the whole prompt.
- The yellow needs-reason box and the standalone Prompt section stay hidden on
  proposal cards; the panel carries both. Other needs-you cards keep the old box.
- Board card: proposal cards get a "Decide" button beside the card body (same click
  rules as the hold-link chips); it opens the drawer, where the panel sits on top.
- Fallback: a proposal without stored fields (older cards, fork proposals) shows the
  first paragraph of the prompt as the summary body; the five labels stay out.
- Edit on a held proposal: /edit and /edit/start accept a todo card in needs_you
  whose needsReason is a proposal reason and that has no turns. Every other
  needs-you card still gets 409. Accept (the reply) clears the prompt-edit hold as
  today.

## Structured fields

- The retro's propose_task tool gains five optional strings: whatChanges, why,
  gain, risk, check. The tool description text changes (hard stop: the exact text
  went to the user on 2026-11-05). The retro prompt itself (retroPrompt) stays
  unchanged.
- The runner captures the five fields from the first valid call: required non-empty
  whatChanges/why/gain/check; risk defaults to "none found"; each field capped at
  400 characters (truncated with "…"). A missing required field stores no summary.
- Storage: tasks.proposal_summary TEXT (JSON), additive ALTER TABLE migration in
  ProjectStore.open; Task.proposalSummary: ProposalSummary | null; invalid or
  wrong-shaped JSON reads as null.

## Error cases

- A proposal whose summary is null renders the fallback; nothing else changes.
- The edit gate keeps 409 for every non-proposal needs_you card.
- Cancel keeps its confirm step; a cancelled card's drawer stays read-only.

## Acceptance checks

- The five lines and the three buttons fit without scrolling at 1280x800 and
  390x844.
- Tests cover: each panel action hits today's endpoint, the no-fields fallback,
  keyboard access (Tab order, accessible names), the edit gate for proposals, the
  migration convergence, and the runner capture rules.
- WCAG 2.1 AA holds; the impeccable detector reports no primary finding.

## Non-goals

- No change to Accept/Cancel server behavior, the composer, or review findings
  (propose_task in review mode keeps its prompt/model/rank/security shape).
- No retro prompt (retroPrompt) wording change.
