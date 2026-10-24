# Paperclip as a replacement for omp-task-tracker (2026-09-25)

**Question:** can [Paperclip](https://github.com/paperclipai/paperclip) replace this tracker?

**Answer: no, keep the tracker.** Paperclip is a control plane for "AI companies": org chart, CEO agent, budgets, goals, heartbeats and governance ([README.md:35-37][readme-what]). The tracker's core is missing from it or would have to be built on top:

- omp as the agent;
- a serialized work turn → merge/release turn per project;
- outcomes checked against git;
- native Windows.

Its own README scopes it away from this use: "Not a single-agent tool… If you have one agent, you probably don't need Paperclip" and "Not a code review tool. Paperclip orchestrates work, not pull requests" ([README.md:294-295][readme-not]).

**Sources:** Paperclip's source and docs at commit `bd6caf5` (2026-09-25), plus the GitHub API. Paperclip was not installed or run. Line numbers refer to that commit.

## Facts

- **Maturity:** 84k stars, 15k forks, 5,674 open issues, MIT license. Created 2026-03-02, with releases about weekly (latest v2026.916.1 on 2026-09-21). The top committer has 2,842 commits. (GitHub API, 2026-09-25.)
- **Runs locally:**
  - The default `local_trusted` mode binds to loopback and needs no login ([deployment-modes.md:6-16][modes]).
  - Postgres is embedded and created on first start ([README.md:396][readme-db]).
- **Telemetry is on by default.** Opt out with `PAPERCLIP_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` ([README.md:493-507][readme-telemetry]).
- **Platforms:**
  - The recommended install is for "macOS, Linux, or WSL2" ([INSTALLING.md:8-20][install]).
  - No Windows CI runner was found ([pr-trusted.yml:20-52][ci]).
  - The process-group kill tests are skipped on Windows ([server-utils.test.ts:621-675][pgtest]).

## Requirements from PLAN.md

| # | Requirement | Paperclip | Evidence |
|---|---|---|---|
| R1 | Local only, native Windows | Partly. Local no-login mode exists, but the installer targets WSL2 rather than native Windows, and telemetry is on by default. | [modes], [install], [readme-telemetry] |
| R2 | One board across projects | Partly. There is a company-wide issue list with a Kanban view and a project filter. Statuses are backlog, todo, in_progress, in_review, done, blocked and cancelled; there is no merge stage. | [KanbanBoard.tsx][kanban], [managing-tasks.md:12-18][statuses] |
| R3 | Worktree per task; untracked rules copied in | Partly. An opt-in `git_worktree` strategy runs `git worktree add -b <branch> <path> <baseRef>` under `<repo>/.paperclip/worktrees/`. There is no copy list for untracked files, only a provisioning-command hook. | [workspace-runtime.ts:3542-3571][wt-add], [workspace-runtime.ts:5704-5744][provision] |
| R4 | omp CLI as the agent | No. There are 16 built-in adapters and none is for omp. `pi_local` passes the prompt as the last argument plus `--session <file>` and `--skill`, neither of which omp v18.3.0 lists (omp has `--resume`, `--session-dir` and `--skills`). | [builtin-adapter-types.ts:4-21][adapters], [pi-local execute.ts:666-690][pi-args], `omp --help` |
| R5 | Work turn, then a serialized merge turn; per-project limit | No. There is no two-turn lifecycle and no merge queue. Concurrency is set per agent (1–50), and adapters must not `git push`. | [heartbeat.ts:649-651][concurrency], [execution-workspace-policy.ts:110-135][shared-ws], [AUTHORING.md:16-26][no-push] |
| R6 | No review; "needs you"; Reply resumes; Cancel removes | Partly. See the notes below the table. | [issue-comment-wakeup.ts:1-25][comment-wake], [execution-policy.md:1-27][exec-policy], [execution-workspaces.ts:1281-1288][cleanup], [execution-workspaces.ts:849-928][close-ready], [local-service-supervisor.ts:548-596][win-kill] |
| R7 | Structured outcome, checked with git | Partly. The native Paperclip Runner has finish and block tools plus an evidence classifier, and a separate check looks at git state before closing a workspace. Nothing ties a claimed outcome to git. | [completion-result.ts:178-224][runner-result], [evidence-classifier.ts:233-311][evidence], [execution-workspaces.ts:849-928][close-ready] |
| R8 | Pasted images reach the agent | Partly. Reply images become attachments with a download path; images in a new task end up inside its Markdown text. Delivery to CLI adapters is unconfirmed. | [TaskChatComposer.tsx:662-695][reply-img], [heartbeat.ts:8658-8675][img-ctx], [NewIssueDialog.tsx:680-705][new-img] |
| R9 | Rules interview when `AGENTS.md` is missing | No. The only interview is the one for a company's first task. | [editing-first-task-texts.md:20-38][interview] |
| R10 | Localhost; Host and Origin checks | Partly. A Host allowlist guard exists; the Origin check covers browser-session changes only. | [app.ts:265-274][host-guard], [board-mutation-guard.ts:65-109][origin] |

**R6 in detail:**
- A comment wakes the assigned agent, and agents that support it resume their session. Some wake reasons start a new session.
- Review and approval stages are optional.
- Cancel stops the run, but a worktree is only removed once it is merged and clean, after a cooldown that defaults to 7 days.
- On Windows, a kill signals only the process ID, not its child processes.

## What switching would take

1. **An omp adapter.** It can be an external package loaded as a plugin, without forking Paperclip ([external-adapters.md:1-130][ext-adapters], [types.ts:429-500][adapter-types]). It needs:
   - the prompt on stdin;
   - `--resume` and `--session-dir` for session continuity;
   - `--extension`;
   - `@image` arguments;
   - JSONL parsing and a session codec.

   Estimated size: a few hundred lines plus tests.
2. **A provisioning command per project** that copies `AGENTS.md`, `.omp/` and the extra paths into each worktree.
3. **The two-turn flow and the per-project merge queue,** which are the tracker's core. They would have to be built as a Paperclip plugin or outside Paperclip.
4. **An environment choice:** run Paperclip under WSL2 while omp and the repos live on Windows, or find out whether native Windows works.
5. **Upkeep:** tracking about weekly releases of a project with 5.7k open issues.

For comparison, the tracker's remaining work is phase 7 (a second example project) and the line-ending fix listed under "Risks" in `PLAN.md`.

## Worth borrowing (both copied 2026-09-25)

- **Base-ref resolution:** resolve and refresh the base ref before `git worktree add`, and stop with a clear error when it doesn't resolve ([workspace-runtime.ts:2381-2418, 3542-3545][base-ref]). Copied as `resolveTarget(mainPath, fetch)` in `src/worktree.ts`: the upstream is read from the branch config, fetched before a new worktree, and a missing one stops the card with "!" instead of silently falling back to the local branch. Not copied: Paperclip's auth provider and its mapping of local base branches to `origin/<branch>`.
- **Checks before deleting a worktree:** Paperclip checks commits ahead/behind and merge ancestry first ([execution-workspaces.ts:849-928][close-ready]). Copied as `unsavedWork(worktree, target)`: Done and Cancel keep a worktree with uncommitted changes or commits not on the target and give the card "!"; Cancel then asks a second time and can force. Not copied: the cooldown before cleanup.

[readme-what]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/README.md#L35-L37
[readme-not]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/README.md#L294-L295
[readme-db]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/README.md#L396
[readme-telemetry]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/README.md#L493-L507
[modes]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/docs/deploy/deployment-modes.md#L6-L16
[install]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/doc/INSTALLING.md#L8-L20
[ci]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/.github/workflows/pr-trusted.yml#L20-L52
[pgtest]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/packages/adapter-utils/src/server-utils.test.ts#L621-L675
[kanban]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/ui/src/components/KanbanBoard.tsx
[statuses]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/docs/guides/board-operator/managing-tasks.md#L12-L18
[wt-add]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/workspace-runtime.ts#L3542-L3571
[provision]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/workspace-runtime.ts#L5704-L5744
[adapters]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/adapters/builtin-adapter-types.ts#L4-L21
[pi-args]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/packages/adapters/pi-local/src/server/execute.ts#L666-L690
[concurrency]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/heartbeat.ts#L649-L651
[shared-ws]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/execution-workspace-policy.ts#L110-L135
[no-push]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/packages/adapters/AUTHORING.md#L16-L26
[comment-wake]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/issue-comment-wakeup.ts#L1-L25
[exec-policy]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/docs/guides/execution-policy.md#L1-L27
[cleanup]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/execution-workspaces.ts#L1281-L1288
[win-kill]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/local-service-supervisor.ts#L548-L596
[runner-result]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/packages/paperclip-runner/src/contracts/completion-result.ts#L178-L224
[evidence]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/native-runtime/evidence-classifier.ts#L233-L311
[close-ready]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/execution-workspaces.ts#L849-L928
[reply-img]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/ui/src/components/task-chat/TaskChatComposer.tsx#L662-L695
[img-ctx]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/heartbeat.ts#L8658-L8675
[new-img]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/ui/src/components/NewIssueDialog.tsx#L680-L705
[interview]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/docs/guides/board-operator/editing-first-task-texts.md#L20-L38
[host-guard]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/app.ts#L265-L274
[origin]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/middleware/board-mutation-guard.ts#L65-L109
[ext-adapters]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/docs/adapters/external-adapters.md#L1-L130
[adapter-types]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/packages/adapter-utils/src/types.ts#L429-L500
[base-ref]: https://github.com/paperclipai/paperclip/blob/bd6caf51bb0171b2a699565225d4e93698c25a66/server/src/services/workspace-runtime.ts#L2381-L2418
