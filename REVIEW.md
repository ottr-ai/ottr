# Review guidance

Guidance for Ottr's own work checks and reviews. The check prompts read this file when it exists; a project can ship its own copy with stricter rules.

- Block on correctness, security, broken or weakened tests, and unmet acceptance items. Style never blocks.
- A blocker needs evidence: a file and line, a failing command, or a failing test. No evidence, no blocker.
- Name the bug class (`off-by-one`, `sql-injection`, …) and list every instance of it, so one fix round clears the whole class.
- A problem the branch did not introduce is pre-existing: record it as a note, never as a blocker.
- Read `AGENTS.md` first and run only the verification it names.
- Skip generated files, lockfiles, and `.tasks/` data.
