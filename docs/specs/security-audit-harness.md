# Security audit harness for Ottr reviews

## Assumptions and scope

- Ottr already installs Cloudflare's workflow as `security-audit`. Preserve that skill and its source record.
- The requested agent-data target permits this import from the Ottr card. Keep the agent-data checkout on `main`.
- Use the provisioned third-party path `user/agents/skills/security-audit-harness/`, not the unprovisioned `user/skills/` path.
- Pin the import to Cloudflare commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` from 2026-09-14.
- Keep the upstream MIT license, schema, validators, tests, and companion files. Record each local change and the source pin.
- Change the skill name to `security-audit-harness`. Do not replace `security-audit` or change `src/prompts.ts`.
- The AGENTS.md Review section selects this skill for Ottr's security phase, even when the generic review prompt names `security-audit`.

## Review behavior

Normal reviews use the six-phase workflow with the `quick` profile. Reports state that coverage is partial.
Only an explicit scheduled deep security review uses the `deep` profile. Other review gates remain unchanged.
Guidance questions use guidance mode. They create no run directory or report files.

Before a security finding becomes a proposal or card, the parent writes `findings.json` and `coverage-ledger.json`.
The parent runs both bundled validators. A validator error blocks that conversion until the records pass.
The validators prove the record format, not the security claim. Independent verification still applies.
Audit output stays outside the target repository unless the skill's explicit ignored-directory rule permits an internal path.

- `confirmed`: require a source trace, independent verification, a bounded observed result, and the exact command with its output.
  Keep that command in `execution.instructions` and its output in `execution.observed_result` or a referenced evidence artifact.
  Preserve the fingerprint in the report and proposal. Only these records receive security severity.
- `needs_validation`: report each record once as blocked or unproven, with its fingerprint, exact blocker, and validation plan.
  Assign no severity. If the generic review flow requires a proposal, use its `Needs validation` tag and preserve the same fingerprint.
  Do not present that proposal or a resulting validation task as a confirmed vulnerability.
- `rejected`: retain the record in the audit output. Create no proposal or card for it.

## Execution limits and errors

Source review stays read-only. Target-controlled execution is optional, not a prerequisite for source review.
Before execution, require every OS-enforced control in the skill: no external network, an allowlisted empty environment, and scratch-only writes.
Also require a read-only target and toolchain, resource limits, and the skill's safe artifact promotion controls.
A container or microVM label alone proves none of these controls.
If any required control is absent, do not execute target code. Keep an affected source-grounded candidate as `needs_validation`.
State the exact missing control. Never replace it with a broader host test or weaken the evidence requirement.
If the renamed skill is absent, report the Alate import and provision prerequisite. Do not silently use another skill.
Do not add credentials to the skill, fixtures, source records, or reports. Use only synthetic evidence in validator checks.

## Acceptance checks

1. A fresh omp session loads `security-audit-harness` and answers a security question in guidance mode without audit artifacts.
2. The session discovers both `security-audit` and `security-audit-harness` with no duplicate skill name.
3. On Node 24.21.0, both validators accept small valid JSON fixtures and reject changed invalid fixtures.
4. The SkillSpector static gate accepts the imported folder after explicit triage of any false positives.
5. The Ottr AGENTS.md copies match the agent-data source byte for byte.
6. After `bun install --frozen-lockfile`, `bun run check` and `bun test` exit zero.

## Non-goals

No change to the review scheduler, database, proposal API, live prompt text, worker image, or built-in skill.
No new dependency, automatic deep audit, sandbox implementation, push, Alate import, or worker provision.
