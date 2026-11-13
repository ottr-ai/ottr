# Cleanup and hardening in the review

Status: approved by the user (2026-11-04) and implemented in `src/prompts.ts`.

## Decision

Ottr gets no separate cleanup ("gardening") skill. The review that the Review button and each release run already has the same goal. The useful checks of the dropped `server-gardening` skill (agent-data branch `keep/agen-36-server-gardening`, `user/omp/agent/skills/server-gardening/SKILL.md`) become one cleanup section of that review. Hardening is the security half of the same review. It uses the tools that exist, and this spec names the gaps.

## What the review does today

`reviewBody` in `src/prompts.ts` (both buttons) asks for:

- correctness, security, tests, docs, and architecture over the whole repo,
- the README check,
- the full verification, the mutation gate, and the audit, license and scanner gates from AGENTS.md,
- a full `security-audit` skill audit,
- the AI-code lens (unneeded abstraction, speculative scaffolding, dead config, boilerplate),
- the `codebase-design` and `ponytail-audit` architecture lenses.

A second model checks the best-ranked findings. `REVIEW.md` applies only to the work check (`src/prompts.ts` work-check prompt), not to the review.

## Cleanup: what the skill adds

The skill and the review overlap in survey, triage, false-positive removal, and card filing. These checks of the skill are not in the review text:

| Check | Example from the OTTR-446 pass |
| --- | --- |
| Dead code: unused exports and files (the project's dead-code tool) | 12 knip exports in `src/app.ts`, `src/workers.ts` |
| Docs and comments that disagree with the code: routes, flags, env vars, commands, line references | `docs/how-it-works.md` routes, `stryker.config.mjs` line range, README `check` list |
| Swallowed errors and success-shaped defaults | `src/supervisor.ts:426` `.catch(() => 0)` (OTTR-456) |
| Network calls with no timeout, unclosed resources, unbounded growth | token expiry probe in `src/app.ts` |
| Duplicated logic | fork and PR watcher `tick` (fixed in OTTR-446) |
| A duplicate or dead-code gate that the project has but nothing runs | `bun run audit:quality` is red on main and no workflow runs it (OTTR-459) |

The skill's fix flow (fix five items, commit) does not move. The review stays read-only.

`docs/ARCH-REVIEWS.md` item 4 ("Quality reports: duplicate and dead code, cognitive complexity, and the host's open alerts") describes checks that `reviewBody` does not ask for. The proposed text below makes that item true.

## Hardening: what exists

| Layer | Tool | Where |
| --- | --- | --- |
| Each review | `security-audit` skill, full audit mode | `reviewBody` |
| Each review | audit, license and scanner gates from AGENTS.md | `reviewBody` |
| Each review | second-model check keeps confirmed high and critical security findings above the cap of 10 | `REVIEW_PROPOSE_TOOL_DESCRIPTION`, review check |
| Ottr merge turn | `diff-security-review` skill on the branch diff | Ottr `AGENTS.md` step 4 (local file) |
| Every turn | `codeguard-1-hardcoded-credentials`, `llm-app-security`, global rules 4, 5, 25 | agent-data rules |
| Matched files | `codeguard-0-*` rules | agent-data rules, listed only, loaded on demand |
| Ottr CI | `bun audit`, gitleaks, zizmor (each push); Trivy, OWASP ZAP (weekly) | `.github/workflows/ci.yml`, `audit.yml` |
| On request | `claude-security` skill (scan, diff scan, patch) | agent-data skills, no prompt names it |

## Hardening: gaps

1. **The merge turn of other projects has no security review.** `mergePrompt` does not name `diff-security-review`. Only Ottr's local AGENTS.md does. The AGENTS.md files of alate, asset-forge, career-ops, clipshelf, velvarr, mystic-realms and agent-data do not name it.
2. **The review does not apply the `codeguard-0-*` rules.** They are glob-scoped and only listed, and the `security-audit` skill does not read them. A review can miss a rule violation that the rule set names.
3. **The host's alerts are not read.** ARCH-REVIEWS item 4 names Dependabot, code-scanning and secret-scanning alerts, but no prompt asks for them.
4. **No static analysis (SAST) in CI.** CI has secret, workflow, dependency and image scans, but no code scanner (for example CodeQL or Semgrep). This is a gap to record. This spec adds nothing for it.
5. **`claude-security` has no place.** It does the same job as `security-audit` in the review and `diff-security-review` in the merge turn. Keep it as an on-request tool. Do not add it to a prompt.

## Proposed change

Files:

- `src/prompts.ts`: `reviewBody` gains the two paragraphs below. `mergePrompt` gains the one sentence below.
- `src/prompts.test.ts`: one test that the review prompt names the cleanup sweep, the codeguard rules and the host alerts, and that the merge prompt names `diff-security-review`. No test pins full wording.
- `docs/ARCH-REVIEWS.md`: "What the review does" lists the cleanup sweep and the codeguard step.
- Ottr `AGENTS.md` (local only, not committed): the Review section names `bun run audit:quality` as a review gate after OTTR-459 makes it green.

Text for `reviewBody`, after the security audit paragraph:

> Sweep for cleanup too: unused exports and files (run the dead-code and duplicate-code commands that AGENTS.md names, for example `bun run audit:quality`; a failure is a finding), stale TODO notes and commented-out code, comments and docs that disagree with the code (routes, flags, env vars, commands, line references), swallowed errors and success-shaped defaults, network calls with no timeout, unclosed resources, and unbounded in-memory growth. Do not record a pattern that a comment, spec or decision explains as intentional. Record each finding like any other.
>
> For the security audit, also read the codeguard rules (`rule://codeguard-*`) whose globs match the files under review, and record each violation like any other finding. If the gh CLI can read the project host's open Dependabot, code-scanning and secret-scanning alerts, list them in your report details; an open high or critical alert is a finding.

Text for `mergePrompt`, after the verification sentence:

> Before you integrate, run the diff-security-review skill on the branch diff against the target (docs-only diffs skip it); a confirmed high or medium finding blocks the merge: fix it on the branch and re-run the gates, or call report_outcome with needs_you.

## Implicit state-machine lens

The user approved the exact OTTR-842 option A draft on 2026-11-12.
The source is `/data/ottr/handoffs/OTTR-842.md:94-96`.
This adds one inline paragraph to `reviewBody`, not a skill.
Normal reviews, idle reviews and release reviews use the same paragraph.
The lens uses the existing review range and proof policy.
The earlier cleanup and security decisions stay unchanged.

Approved text:

> Review the state machines too: find the fields that hold a lifecycle (a status or stage column, a flag, a nullable timestamp, an in-memory claim set). Start from the fields that the commits under review write, then take the two fields with the most writers. For each field, list every writer and the from-state that it checks. Record as a finding each transition that no guard prevents and no document names (a write after a cancel, two writers with no compare-and-set, a state with no exit, a field pair that no code path may produce), with the call path that reaches it and a test or command that shows it. When the project has a lifecycle document, compare the writers with it and record each difference.

### Scope and proof

- Start with lifecycle fields that the commits under review write.
- Select the two fields with the most writers.
- If fewer than two fields qualify, review those fields only.
- For each selected field, list every writer and its from-state guard, not only writers in the reviewed commits.
- Record each transition that no guard prevents and no document names.
- Check writes after cancel, writers without compare-and-set, states without exits, and invalid field pairs.
- Include the call path and a test or command that shows each finding.
- Record the proof command and its output.
- If the project has a lifecycle document, compare every selected field's writers with it and record each difference.
- Keep the review read-only. Do not change project code or live data to prove a finding.

### Acceptance checks

- Normal, idle and release review prompts contain the exact approved paragraph.
- Prompt tests check the field selection, writer guards, finding criteria, call path, proof and document comparison.
- `docs/ARCH-REVIEWS.md` describes the same scope and read-only proof rules.
- The README names this check and links to the review process.
- Existing review gates and the architecture skill list stay unchanged.

### Non-goals

- No new skill or `requiredSkills` entry.
- No lifecycle model, guard or behavior change.
- No new task lifecycle document.
- No two-review trial.

## Boundaries

- The review stays read-only. The cleanup sweep records findings. It fixes nothing.
- The cap of 10 cards for each review stays. Cleanup findings get a rank like the others, so they do not push out security findings.
- A project AGENTS.md that names its own merge security step wins over the `mergePrompt` sentence.

## Acceptance

- A review card prompt holds the cleanup paragraph and the codeguard and alert sentence.
- A merge card prompt names `diff-security-review`.
- `bun run check` and `bun test` exit 0.

## Non-goals

- No separate cleanup or gardening skill.
- No new scanner in CI.
- No change to the review cap, the second-model check, or the review outcomes.
