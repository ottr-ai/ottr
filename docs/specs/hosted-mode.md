# Hosted mode

Status: implemented (OTTC-6, hosted Ottr milestone M3); the forwarded-events route of section 8 is OTTR-661. Design source: the ottr-cloud repo,
`docs/hosted-design.md` section 3 and section 5.1.

Hosted mode lets the ottr-cloud control plane run one Ottr server for one tenant behind its
proxy. One env flag turns it on. When the flag is off, no hosted code path runs and the
board behaves as it did before this change (fixed decision 2: self-hosted stays first-class).

## 1. Configuration

The server reads the env once at boot (`readHostedConfig`, `src/hosted.ts`).

| Variable | Required when on | Meaning |
|---|---|---|
| `OTTR_HOSTED` | — | `1` turns hosted mode on. Unset, empty, or `0`: off. Any other value stops the boot. |
| `OTTR_HOSTED_TENANT` | yes | Tenant id: 1-63 characters of `a-z`, `0-9`, `-`, first character a letter or digit. |
| `OTTR_HOSTED_SECRET` | yes | Per-tenant HMAC secret, at least 32 characters. Only this tenant's machines and the control plane hold it. |
| `OTTR_HOSTED_CONTROL_URL` | yes | Control-plane base URL. `https`, or plain `http` to a loopback host. No credentials, query, or fragment. |
| `OTTR_HOSTED_WORK_SUFFIX` | no | Text appended to every work-turn prompt. Empty: nothing is appended. |
| `OTTR_HOSTED_MERGE_SUFFIX` | no | Text appended to every merge-turn prompt. |
| `OTTR_HOSTED_RESUME_SUFFIX` | no | Text appended to a resume prompt (reply or Resume on a parked card). |
| `OTTR_HOSTED_CREDIT_REASON` | no | The `needsReason` of a card parked at zero credit. Default: `DEFAULT_CREDIT_REASON` in `src/hosted.ts`. |

When the flag is `1` and a required variable is missing or invalid, the boot stops with an
error. A half-configured hosted board must never serve requests.

The prompt suffixes come from the control plane. Ottr's checked-in prompts in
`src/prompts.ts` do not change.

## 2. Identity header

The proxy signs every request that it forwards. The control plane signs its own calls to the
tenant, and the tenant signs its calls to the control plane, with the same scheme.

```
X-Ottr-Identity: v1.<tenant>.<role>.<ts>.<nonce>.<sig>
sig = base64url(HMAC-SHA256(secret, "ottr-identity.v1.<tenant>.<role>.<ts>.<nonce>"))
```

- `role`: `owner` (a browser request that the proxy authenticated), `control` (the control
  plane), `tenant` (this board's own calls to the control plane).
- `ts`: Unix time in seconds. The board accepts `|now - ts| <= 60`.
- `nonce`: 16-128 characters of base64url (`A-Z a-z 0-9 _ -`). The signer makes a new nonce
  for each request.
- The board checks, in this order: shape, HMAC (constant time), tenant, time window, nonce.
  The board keeps each accepted nonce until its header expires and refuses a second use. The
  nonce cache holds at most 100 000 live nonces. When it is full, the board refuses new
  headers (fail closed).
- Code: `signIdentity`, `verifyIdentity`, `NonceCache` in `src/auth.ts`.
- At boot the server removes `OTTR_HOSTED_SECRET` from its env. It also writes zeros over the
  secret's entry in its startup env block, which `/proc/<pid>/environ` shows to every
  same-user process (repository checks included). If the entry is still readable after that,
  the boot stops (`takeHostedConfig`, `scrubProcEnviron` in `src/hosted.ts`).

Proxy obligations (the board relies on them):

1. Remove every `X-Ottr-Identity` header that a client sends.
2. Do the SSO session check, the `Origin` (CSRF) check, and the `Host` check before it signs.
   A signed `owner` request skips the board's own Host allowlist and Origin wall.
3. Sign `owner` for browser traffic only. Never forward a client request with role `control`.

## 3. Request wall in hosted mode

| Request | Result |
|---|---|
| Valid `owner` header | Authorized like a signed-in admin, except the routes below. |
| Valid `control` header | Only `/api/hosted/*` control routes. Other routes: 403. |
| Valid `tenant` header | 403 on every route. |
| Valid boot token or per-turn VM token (`x-board-token`) | The agent rules of today: file cards only (`agentRefusal`). VM routes (`/git/*`, `/llm`, `/hindsight`) keep their own token checks. |
| No header, or a forged, expired, or replayed header | 401. This includes direct loopback: the loopback bypass is off. |
| `/api/setup`, `/api/login`, `/api/logout`, API-key reveal and regenerate, session registry routes, provider sign-in routes | 404, also with a valid header. |

Session cookies and `X-API-Key` give no access in hosted mode. Provider sign-ins (`omp login`)
are off, and the board lends no provider OAuth token to turns (`LENT_ENV`): hosted model access
uses API keys only.

The state payload carries `hosted: true`, and `onboarding` is always false. The `/api/boot`
payload also carries `hosted: true`, so the UI knows the mode before the first state frame.
When the flag is off, the `/api/boot` payload has no `hosted` key.

## 4. Control-plane calls (tenant to control plane)

Each call carries `X-Ottr-Identity` with role `tenant`. The base path is
`<OTTR_HOSTED_CONTROL_URL>/v1/tenants/<tenant>`. Client: `controlPlaneHooks` in `src/hosted.ts`.

| Call | Body | Answer | Use |
|---|---|---|---|
| `POST /metering` | `MeteringRecord` (JSON) | any 2xx | The cumulative usage of one agent run: interim records while the run is active, then one final record at turn settle. Fire-and-forget: a failure is logged and never blocks the run or the settle. The board does not retry. |
| `GET /credit` | — | `{"ok": boolean}` | The pre-claim credit gate. |
| `POST /git-token` | `{"project": string, "remote": string}` | `{"token": string, "expiresAt": ISO-8601}`, or 404 when the project has no token | The per-project git credential (section 6). |

`MeteringRecord`:

```json
{
  "tenant": "t1", "project": "app", "taskId": "APP-7", "turnId": 31,
  "kind": "work", "role": "default", "model": "anthropic/claude-opus-5-5",
  "run": 0, "final": true,
  "usage": { "input": 1200, "output": 340, "cacheRead": 9000, "cacheWrite": 0, "cost": 0.0412 },
  "outcome": "ready", "title": "Add a hello.txt file"
}
```

- `kind`: the turn kind (`work`, `merge`, and the other turn kinds).
- `role`: the model role that resolved the run's model. The work or merge run uses `default`
  (also when the card or session names its own model). The second-model check run uses its check role
  (`critic` or `adversary`).
- `run`: the index of the run in its turn. The first agent run of the turn is `0`, the next
  is `1`, and so on (a check retry is a new run). `(project, taskId, turnId, kind, role, run)`
  names one agent run, and each record of that run has the same key.
- `final`: `false` for an interim record, `true` for the record at turn settle.
- `usage`: the sum over the run's assistant messages so far, from omp's `message_end` events.
  `cost` is the USD value that omp reports, `0` when omp reports none.

Interim records: while a run is active, the board sends an interim record after an assistant
`message_end` that changed the run's usage. Each run sends at most one interim record in each
2 seconds (`METERING_INTERVAL_MS` in `src/hosted.ts`). A change inside the interval goes out at
the end of the interval, with the newest usage. No interim record goes out after the run ends:
the final record at turn settle carries the last usage. A final record goes out also for a
stopped or failed run. The control plane books only the increase over the highest cumulative
usage that it saw for the run, so a late or repeated record never counts twice. Code:
`interimMeter` in `src/turn.ts`, fed by the run sink's `onUsage` (`src/runner.ts`).
- `outcome` (M10, optional): the card outcome the board shows after the settle (`ready`,
  `answered`, `integrated`, `needs_you`, and `queued` for a card the settle requeues). It
  rides the work/merge run's record only; a check run's record carries neither this field
  nor `title`. A parked card (credit stop, stop, tracker error, check blockers) sends
  `needs_you` even when the run reported none. A card the settle requeues (a dependency
  hold, steering, a queued rebase retry) waits on the board's queue, so its `needs_you` row
  outcome ships as `queued`. The control plane answers 400 `invalid_record` for a value
  outside `/^[a-z_]{1,40}$/`, so the settle sends no outcome when no valid value exists.
- `title` (M10, optional): the card prompt's first line, trimmed and cut to 200 characters,
  on the same record. An empty line sends nothing.

## 5. Credit gate and stop

- Credit gate: before a turn starts, the board calls `GET /credit`. The call comes right after
  the scheduler's synchronous claim and before the title, the worktree, or a run. A call before
  the claim would let one schedule tick pass all queued cards through the run caps. Work and
  merge turns both pass the gate.
  - `ok: false`: the card parks `needs_you` with the credit reason. No turn starts.
  - The call fails: the card goes back to `queued` with `holdUntil` 60 seconds later and a
    reason that says the credit check failed. The scheduler tries again after the hold.
- Mid-turn stop: the control plane calls `POST /api/hosted/stop` on the tenant (role
  `control`). The board stops these turns (`creditStop`, `src/turn.ts`):
  - A running work or merge run: `stopTurn` behavior. The agent stops, the worktree, branch,
    and omp session stay, and the card parks `needs_you` with the credit reason.
  - A running second-model check run (the work check or the review findings check): the
    board kills it. The check does not start its second attempt, and the card parks
    `needs_you` with the credit reason. The worktree, branch, and omp session stay.
  - A turn between its claim and its run (title, worktree, packages), or between its run and
    its check: the board marks the turn. At its next model dispatch point, the turn starts no
    model and the card parks `needs_you` with the credit reason.

  The answer is `{"stopped": <count>}`, with all three types in the count. After the credit
  park, no later write of the turn changes the reason or puts the card back in the queue. A
  marked turn that settles before a dispatch point (for example, its run ended before the
  kill) settles with its own outcome.
- Credit hold: the stop also sets a hold for the board. While the hold is set, no turn starts
  a model run: before each work or merge run, each check attempt (also the second attempt),
  and each title call, a turn that sees the hold parks `needs_you` with the credit reason. A
  gate call that starts after the stop and answers `ok: true` clears the hold. A gate answer
  from a call that started before the stop does not clear it. The delayed retry of a failed
  title call is also a model call: when it fires while the hold is set, it does not run.
- Resume after a top-up: the owner replies `Resume` (or any reply) on the parked card. The
  card goes back to the queue. The gate asks `GET /credit` again before the turn starts, so a
  card never runs while the balance is zero.
- Release after a top-up: the control plane calls `POST /api/hosted/release` on the tenant
  (role `control`). The board (`creditRelease`, `src/turn.ts`):
  1. Clears the credit hold, with the same effect as a gate answer `ok: true`. It changes no
     other stop state.
  2. Finds each `needs_you` card whose reason is the credit reason. The credit stop and the
     credit gate both park cards with this reason.
  3. Queues each of these cards as an owner `Resume` does (`replyPatch`, also used by the reply
     route): the continue prompt `.`, and no reason or hold. A stopped card resumes the same
     omp session on the kept worktree. A card that the gate parked starts its turn.
  4. Writes the `.` as board text (`pendingBy: "supervisor"`), not as a user message. Thus
     an active usage-limit hold still holds a released card. A steer that the owner queued
     before the release keeps its author.

  The answer is `{"released": <count>}`. Each queued turn still passes the credit gate. A
  second call finds no parked card and answers `{"released": 0}`. A stopped turn that has not
  settled yet when the release comes is not in the count: it parks after the release, and the
  owner resumes it. A card in its credit gate when the release comes is also not in the count.
  If its gate call started before the release and answers `ok: false`, the card does not
  park. It goes back to the queue with no hold, and the gate asks again. With the flag off,
  the route answers 404 like each hosted route.

## 6. Per-project git credential

When hosted mode is on, the network-git credential resolver asks `POST /git-token` for the
project that owns the command's directory. The Add-project clone does the same before the
project exists: it asks for the project name being added, with the remote it clones. It
caches each token until 5 minutes before `expiresAt`. It does not use the board-global host
tokens, the server SSH key, or the global `GH_TOKEN`. The secret-redaction list holds only
the tokens that the board minted for the project of that command. Workers still get no git
credential, and `checkPinnedRemote` still refuses a changed push URL.
gh calls (releases, pull requests) use the same minted token and run with an empty
`GH_CONFIG_DIR`, so gh never falls back to a stored board login. A 401 or 403 on the
Add-project clone gets no GitHub API diagnostic: that probe uses only board-global tokens.

## 7. Settings and System

When hosted mode is on, the UI hides these host-level surfaces:

- Board → Runners, Board → Projects order.
- Access → API key, Access → Session, Access → omp usage.
- Git and secrets → Git hosts, the whole card: GitHub host, GitHub token, GitHub App, Other
  host tokens, and Global SSH key. Hosted git uses only the per-project control-plane tokens
  (section 6), so no setting on this card has an effect.
- Agents → Provider sign-in, Model roles, Alate, Hindsight. The operator manages the model
  roles.
- Project → Updates (CI watch, Dependabot, PR reviews, issue watch, trending).
- The provider quota in the app bar and in its detail popover. Provider quota is the
  operator's concern.
- The `/system` page and its navigation entry, and the worker drain and image update surfaces.
- The setup dialog, the login screen, and sign-out controls.
- Every link or button that opens a hidden card.

The tenant keeps: Notifications, Env values, the project cards, and every board surface.

Details:

- One list in `src/ui/settings.tsx` (`hostedHidden`, `pageToc`) controls the hidden cards. The
  TOC drops each hidden card and block, and a group without cards disappears. A block hides
  with its card. With the list of today, the Access and Agents groups disappear, and Git and
  secrets keeps only Env.
- `HostedContext` (`src/ui/settings.tsx`) gives the mode to the board components. A link to a
  settings card renders only when `hostedHidden` keeps its target:
  - A server warning shows a phrase that names a hidden card as plain text.
  - The board shows no "GitHub features off" advisory, which names the Git hosts card.
  - The Overview shows no setup rows that open the Alate card.
  - The Add project dialog shows no Open settings button. Its hint says only to uncheck the
    repo box.
  - The inbox shows no Alate import notice and no provider sign-in notice.
- A deep link to a hidden card opens the settings page without a scroll.
- `/system` in hosted mode shows the Overview, like a view that names no project.
- The Overview has no Setup tab (the Provisioning panel) and does not poll `/api/provisioning`.
  A selection of the Setup tab falls back to the Now tab.
- The inbox shows no update hold, update available, or restart wait notice. A queued card's
  status line still names an update hold.
- A lost session shows the offline banner, not the login page. The account menu has no
  "Signed in as" line and no Sign out.

## 8. Forwarded GitHub events

The control plane calls `POST /api/hosted/github-event` on the tenant when GitHub wakes it with
a webhook event. The control plane already verified the event's GitHub signature; the tenant
receives the raw payload. The route exists only when hosted mode is on; with the flag off the
route answers 404 like every other hosted route.

- Identity: role `control`, verified by the section 3 wall exactly like `/api/hosted/stop`.
  `owner` answers 403, `tenant` answers 403, a forged, expired or replayed header answers 401.
  The route adds no check of its own.
- Headers: `X-GitHub-Event` and `X-GitHub-Delivery` (GitHub's webhook headers, forwarded as
  they arrived). A missing `X-GitHub-Delivery` answers 400.
- Body: the raw GitHub JSON payload. The route reads only `repository.full_name`. A body over
  GitHub's documented webhook ceiling (25 MiB) answers 413; the control plane's single retry
  repeats it, so such an event drops and the next periodic poll covers it. A body that does not
  parse as a JSON object answers 400.
- Dedupe: the control plane retries once after a failed connection or a 502/503, so the tenant
  dedupes on `X-GitHub-Delivery`. The cache is in-memory and bounded (4096 ids, the oldest
  evicted). A redelivered id answers 2xx and kicks nothing. The id counts only after the body
  parses, so a retry after a 400 is never swallowed.

Watches:

| Events | Watch |
|---|---|
| `push`, `check_suite`, `workflow_run` | CI watch: the supervisor's tick for the matching project (the periodic worker sweep does not run on a kick) |
| `pull_request`, `pull_request_review` | PR review watch |
| `issues`, `issue_comment` | issue watch |

- Matching: a project matches when its GitHub remote's `owner/repo` equals the payload's
  `repository.full_name`. Every matching project gets the kick. An unknown event, a payload
  without a repository, and no matching project all answer 2xx and do nothing (no-op).
- Timing: the kicks run before the answer; each watch runs for the matching project only (the
  watchers' per-project `manual` scope) and each is single-flight, so a kick that lands while a
  poll is running is a no-op and the running poll covers the event. The answer is `{"ok":true}`
  on every handled case.
- Self-host: with the flag off nothing changes; the per-project tick filter the kick uses is
  additive and unused.

## 9. Non-goals

- No change to `src/prompts.ts`.
- No credit ledger, prices, or balance display in ottr: the control plane owns them (M6).
- No GitHub App install flow: the control plane mints the tokens (M4).
- No change to the boot-token and per-turn VM token paths.
- No payload slimming or event filtering beyond `repository.full_name` — the control plane
  forwards GitHub's payload as it arrived and GitHub's event stream decides what kicks.
