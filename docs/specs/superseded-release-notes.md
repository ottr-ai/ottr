# Superseded commits leave the release notes

Planned release notes kept bullets for commits whose effect a later commit removed: OTTR-330 hand-edited the planned v0.2.0 notes for this. The filter (`TRAILER`, `droppedCommits` in `src/release.ts`) fires only on `Supersedes:`/`Reverts:`/`Fixes:` body lines, and replacement commits carried none. The fix is commit discipline, not a content heuristic: a commit that replaces an earlier commit's change references it with a `Supersedes: <sha>` body line. The work prompt teaches the rule; the notes filter (already shipped) enforces it.

## Behavior

- `workPrompt` in `src/prompts.ts` gains one instruction, next to its commit line: a commit that replaces an earlier commit's change instead of fixing it references the replaced commit with a `Supersedes: <sha>` body line, and the release notes drop the named commit's bullet.
- `src/release.ts` does not change. The existing filter drops the named commit while the superseding commit stays in effect; a revert of the superseder restores the original; a `Supersedes:` line never folds the superseding commit itself, so a breaking replacement keeps its bullet and the major version step.
- No content heuristic: a later commit over the same files without a trailer keeps both bullets. Renames, partial rewrites, and follow-up fixes stay in the notes unless a trailer says otherwise.

## Boundaries

- Only direct trailer links count. A superseder of a superseder (A ← B ← C) drops B; A stays, because its canceller B is no longer in effect. The same rule holds for revert chains.
- One commit may carry several `Supersedes:` lines when its change replaces several commits' effects; each named commit drops.
- `Supersedes:` accepts abbreviated (7 hex digits or more) or full shas, case-insensitive, like the other trailers.
- Commits without trailers keep their bullets. Hand edits on the release card stay available for released history that predates the discipline.

## Acceptance

- `src/prompts.test.ts` pins the trailer instruction in `workPrompt`.
- `src/release.test.ts`: a `Supersedes: <sha>` trailer drops the referenced commit (the existing "trailers drop superseded and reverted commits and fold in-range fixes" test pins this); a later commit over the same feature without a trailer keeps both bullets; a breaking replacement keeps its breaking bullet and steps the major version.
- `src/release.test.ts` plans a release over a real git fixture history in which one commit replaces another's change: the notes hold the replacement's bullet and no longer list the replaced one.
- `bun run check` and `bun test` pass from the worktree root.

## Non-goals

- Detecting overwritten files in `src/release.ts` (the rejected option A heuristic).
- Backfilling `Supersedes:` lines onto released history; released notes are frozen except for hand edits on the release card.
- Changes to the merge, release, review, or reply prompts.
