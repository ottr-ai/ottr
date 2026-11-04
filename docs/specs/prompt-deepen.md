# Spec: Deepen button in the task composer (OTTR-476)

## Goal

An opt-in **Deepen** button in the task composer. It asks a model to rewrite the
draft prompt into a deeper version. The user must accept or edit the rewrite
before the card runs; nothing runs silently. A (?) badge with a pop-over
explains what makes a good prompt and what Deepen does.

This is option C of the OTTR-441 research (`research-report.md`, handoff
`/data/ottr/handoffs/OTTR-476.md`). The rule from that research holds: the user
is the check of intent. The rewrite is a deeper version, never a bigger one.

## Server

### Prompt texts (`src/prompts.ts`, additive only)

- `export const deepenSystem: string` — the rewrite contract for the model:
  - Rewrite the user's task prompt into a deeper version.
  - Answer with only the rewritten prompt text: no preamble, no quotes, no
    markdown fences, no commentary.
  - Keep the user's intent and their words where they carry meaning.
  - Add what a top professional would bring: the goal behind the task
    (altitude), the expert method, the raw material they would start from, the
    tools and methods they would use, and an outside check (a test, a command,
    a number, or another observable result that shows the work is right).
  - The rewrite is a deeper version, never a bigger one: no features, tasks, or
    requirements the user did not ask for; no invented details. Keep the length
    close to the original; cut filler. Write in the language of the original.
- `export function deepenPrompt(text: string): string` — the user message that
  carries the draft: `Rewrite this task prompt:\n\n<text>`.

This adds new exports only. It does not rewrite any existing prompt in
`src/prompts.ts` (AGENTS.md hard stop 3 stays respected).

### Gateway call (`src/deepen.ts`, new module)

- `export const DEEPEN_MAX_CHARS = 40000` — cap for a returned rewrite.
- `export function parseDeepened(raw: string): string` — trims, strips one
  markdown-fence wrapper when the whole answer starts with ```` ``` ````, caps
  at `DEEPEN_MAX_CHARS`, throws `RangeError` when the result is empty.
- `export async function deepenDraft(o: {
    prompt: string;
    model?: string | null;
    spawn?: SpawnFn;
    timeoutMs?: number;
  }): Promise<string>` — one `runGateway` call (from `src/forkAnalysis.ts`)
  with the system + user messages, timeout default 120 000 ms, model selector
  `o.model` trimmed or `"@default"` when empty. Returns `parseDeepened(raw)`.

### Route (`src/app.ts`)

`POST /api/projects/:project/deepen`, wired through the normal `api()` walls:

- Body JSON `{ prompt: unknown, model?: unknown }`.
- Unknown project → 404 `unknown project`.
- `prompt` not a string → 400 `prompt must be a string`; trimmed empty or
  longer than 20 000 chars → 400 `prompt must be 1-20000 characters` (same
  copy and cap as the task-create route).
- `model` optional: `modelParam(r.body)`; a 400 Response passes through.
- Calls the deepen seam: `deps.deepen ?? deepenDraft` with the trimmed prompt
  and the model (null when absent).
- Success → 200 `{ deepened: <string> }`.
- The seam throws → `logError("deepen", err)` and 502
  `the model call failed: <err.message>` (or `unknown error` for non-Errors).
- `AppDeps` gains an optional seam
  `deepen?: (prompt: string, model: string | null) => Promise<string>` so
  tests never spawn a real gateway.

The model value is a passthrough selector for the gateway (`"@default"`, an
omp role like `"@plan"`, or a model id from the composer's model picker). The
route does not validate it beyond `modelParam`; a bad selector surfaces as the
gateway error of the 502 path.

## UI (`src/ui`)

### Composer (`ComposeDialog` in `src/ui/app.tsx`)

- New optional prop
  `deepen?: (text: string, model: string) => Promise<{ deepened: string }>`.
  Callers build the POST URL (the dialog does not know the project name).
  `NewTaskDialog` and `FollowUpDialog` pass it
  (`POST /api/projects/:project/deepen` with `{ prompt: text, model: model ||
  undefined }`). The backlog draft dialog does not: a draft runs no agent, and
  the grill session is the interactive path for parked ideas.
- When `deepen` is set, the dialog shows:
  - The (?) badge (`<Help>` from `src/ui/kit.tsx`, the same pop-over the
    settings use) next to the input label. Pop-over text, two short parts:
    what makes a good prompt (state the goal behind the task, what the work
    must not touch, and how to check the result), and what Deepen does (a
    model rewrites the draft with the four deepen questions — expert method,
    raw material, tools, outside check — and the rewrite opens as a diff;
    nothing changes until it is accepted).
  - A **Deepen** button below the textarea, enabled only when the draft text
    is non-empty and no send/deepen call is busy; busy shows a spinner and
    `aria-busy`. It calls the `deepen` prop with the current draft text and
    the picked model. A failure shows an error line of its own (not the
    submit error slot, whose "Not added" copy would be wrong).
  - On success, a review block below the button:
    - The line diff of `original` vs `deepened` (see `lineDiff`), each row
      marked with a `+` / `−` glyph so the signal never rides on color alone.
      When the rewrite differs in no line, the block says so instead.
    - Actions: **Use rewrite** (writes the rewrite into the composer's
      textarea through the normal draft path — the user can keep editing it
      there — and closes the review) and **Discard** (closes the review).
  - Closing the dialog clears the rewrite state and the deepen error, like
    the other draft state.
- Deepen never fires on submit. It is its own button; the submit button keeps
  its exact current behavior.

### Line diff (`src/ui/diff.ts`, additive)

- `export type DiffRow = { kind: "same" | "add" | "del"; text: string }`.
- `export function lineDiff(a: string, b: string): DiffRow[]` — line-level LCS
  over `a.split("\n")` / `b.split("\n")`. When either side exceeds 2000 lines,
  skip the alignment: the whole old text comes back as `del` rows, the whole
  new text as `add` rows (bounded memory, no O(n·m) table).
- The renderer reuses the existing `dl-add` / `dl-del` / `.dl-text` classes of
  the task diff view (`src/ui/app.css`), so the visual language stays the one
  the board already has.

### PromptInput (`src/ui/app.tsx`)

- New optional prop `labelExtra?: ReactNode`, rendered inside the `<label>`
  after the label text. Backward compatible: absent for every existing caller
  except the deepen-enabled composers.

### CSS (`src/ui/app.css`)

- Layout only: the deepen row (button + short hint), the review block, the
  scrollable diff box (max height with overflow), and monospace line text.
  Reuse `--diff-add` / `--crit-*` variables; no new color tokens.

## Error cases

| Case | Result |
|---|---|
| Gateway/model failure | 502 with short reason; dialog shows it; draft stays |
| Empty model answer | `parseDeepened` throws → same 502 path |
| Runaway answer | capped at 40 000 chars |
| Empty draft | Deepen button disabled |
| Rewrite identical to draft | review block reports no line changes |
| Draft over 20 000 chars | route 400s with the standard copy |

## Acceptance checks

1. `bun run check`, `bun test`, and the delta mutation gate pass from the
   worktree root.
2. `bun test` covers: `parseDeepened` (fence strip, cap, empty throw),
   `deepenDraft` (message shapes, model selector, timeout default), the route
   (200/400/404/502, prompt and model validation, seam injection),
   `deepenPrompt`/`deepenSystem` wording contract, `lineDiff`
   (same/add/del/mixed/empty/oversize guard), and render tests for the
   composer (badge, button, review block, disabled states).
3. Rendered proof: the New task dialog shows the badge, the Deepen button, and
   the review diff after a deepen call (screenshots on the card).

## Non-goals

- No automatic rewrite: nothing changes the draft without a click, and no
  card runs a deepen result the user has not accepted.
- No deepen on the backlog draft dialog (the grill session owns that path).
- No persistence of rewrite history, no queueing, no extra model roles.
- No changes to `workPrompt`, `grillPrompt`, or any existing prompt wording.
- No new npm dependencies.
