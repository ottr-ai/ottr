# Public-board request limit for costly API routes

## Behavior

- Scope: self-hosted boards that serve a public host through `OMP_TRACKER_PUBLIC_HOSTS`. A request counts only when its Host matches a configured public host (`viaPublicHost`) and hosted mode is off.
- A fixed set of routes that start a model call, a git or GitHub operation, or card creation is limited (list below).
- One sliding-window bucket per source: window 10 minutes, at most 60 requests per source, at most 600 total.
- Source key: the same rule as the login limiter — the first `X-Forwarded-For` hop only from a direct-loopback peer, else the peer address, else `unknown`.
- The check runs inside `api()` after the Host, Origin, and auth walls, before the handler: an unauthorized request burns nothing, and a request that fails a wall never reaches the counter.
- A blocked request answers `429` with `Retry-After` (whole seconds until the binding cap frees a slot, minimum 1) and logs one warn line that names the route pattern only — no ids, no query values, no addresses.
- A blocked request records no hit, so hammering neither extends the block nor grows the array.
- The counter is in-memory in the server process, like `LoginLimiter`. A restart resets it.

## Costly routes

Card creation and turn starts (each schedules agent work):

- `POST /api/projects` (project add: clone or git init)
- `POST /api/projects/order` (queue reschedule can start queued turns)
- `POST /api/projects/:project/queue`
- `POST /api/projects/:project/tasks` (card creation)
- `POST /api/projects/:project/tasks/:id/refile`
- `POST /api/projects/:project/tasks/:id/reply`
- `POST /api/projects/:project/tasks/:id/steer`
- `POST /api/projects/:project/tasks/:id/follow-up`
- `POST /api/projects/:project/tasks/:id/restart-session`
- `POST /api/projects/:project/tasks/:id/rerun-failed-jobs`
- `POST /api/projects/:project/tasks/:id/pr-review/post`
- `POST /api/projects/:project/tasks/:id/merge-anyway`
- `POST /api/projects/:project/tasks/:id/backlog`
- `POST /api/projects/:project/tasks/:id/grill`
- `POST /api/projects/:project/tasks/:id/triage`
- `POST /api/projects/:project/tasks/:id/finish-kept` (the kept-card merge and push)
- `POST /api/projects/:project/release` (release card and push)
- `POST /api/projects/:project/interview`
- `POST /api/projects/:project/trending/verdicts`
- `POST /api/projects/:project/jira/import` (bulk card creation)

Synchronous model calls:

- `POST /api/projects/:project/deepen`
- `POST /api/projects/:project/board-check`
- `POST /api/projects/:project/arch-review`
- `POST /api/projects/:project/release-summary` (git resolve plus summary)
- `POST /api/trending/scan`

Git and GitHub operations:

- `POST /api/projects/:project/push-main`
- `POST /api/projects/:project/init`
- `POST /api/projects/:project/remove`
- `POST /api/projects/:project/prs/check`
- `POST /api/projects/:project/forks/check`
- `GET /api/projects/:project/github` (fork list over the GitHub API)

Cheap routes that only read state or update rows (`/tasks/:id/model`, `/tasks/:id/star`, `/tasks/:id/cancel`, `/tasks/:id/stop`, `/tasks/:id/edit*`, `/tasks/:id/release-notes`, and the polled GETs) stay out of the set on purpose: a limit there would tax normal board use.

## Non-goals

- Hosted mode (control-plane deployments) is untouched: every tenant arrives from the proxy peer, so one source key would bucket tenants together.
- `/api/login` keeps its own login limiter; the two do not share a bucket.
- No new configuration: the limits are constants.
- No DDoS defense: the auth wall handles unauthenticated traffic; this limit shapes an authenticated or public-host client that starts expensive work.

## Acceptance checks

- App test, public-host mount with the API key: 60 costly POSTs from one source pass the walls and answer the handler's own status; the 61st answers `429` with an integer `Retry-After` of at least 1; a second source still passes.
- App test: a non-loopback peer that mints a fresh `X-Forwarded-For` per request stays one bucket (the R2-5 rule).
- App test: the same volume on a loopback mount never answers `429`, and unauthorized requests on the public mount burn nothing.
- App test: `setSystemTime` past the window frees the bucket again.
- Unit tests with an injected clock: the window slides, the per-source and global caps bind independently, `retryAfterS` names the later of the two lift times.

## Alternatives considered

- Match by route pattern inside `api()` against a pattern list — rejected: the list would drift from the route table; tagging each entry keeps membership visible at the definition.
- One bucket per cost class (model, git, creation) — rejected: more constants and tests for little gain on a single-admin board.
- Environment-configurable limits — rejected: unrequested configurability.

## Risks

- A heavy legitimate admin on a public host (bulk card work, an active steering session) can reach 60 requests in 10 minutes. The `429` names the wait in `Retry-After`.
- Worker and agent hosts talk over loopback or the private host, so turn traffic is unaffected. A deployment that points an agent host at a public host would see `429` on verdict filing.
