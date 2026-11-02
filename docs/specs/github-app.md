# PR review posts through a GitHub App

A posted PR review should show on GitHub as `ottr[bot]` with the bot badge, not under the
person's GitHub identity. The user registers a GitHub App once and pastes its App ID and
PEM private key into Ottr. Ottr then mints short-lived installation tokens and posts
reviews with them. The REVIEW_FOOTER stays: the badge says who posted, the footer says a
person clicked Post. Spec: [pr-reviews.md](pr-reviews.md).

## Config (board-wide, in the tracker db)

- The `config` blob in the GlobalStore gains `githubApp: { id: string; key: string } | null`.
  Same trust level as `githubToken`: plaintext at rest, never served back after save.
- `id` is the numeric GitHub App ID, 1 to 32 digits. `key` is a PEM RSA private key,
  at most 20000 characters.
- On save and on boot the pair passes `validateAppCredentials` (src/githubApp.ts). A saved
  pair that no longer parses is dropped at boot, like a malformed git token row; the boot
  log names the drop without the key.
- The key joins the `gitSecrets()` set, so every `redact()` call in the app covers it.

## API

- `gitHostsView()` gains `githubApp: { id: string; fingerprint: string; check: AppCheck | null } | null`.
  It never returns the key. The fingerprint is `SHA256:` plus base64 without padding over
  the SHA-256 digest of the public key's SPKI DER encoding.
- `POST /api/git-hosts/github-app` with `{ id, key }`. A non-numeric `id` gets 400
  `app id must be the numeric GitHub App ID`. A key that does not parse as a PEM RSA
  private key gets 400 `the private key must be a PEM RSA private key`. On success the
  config is saved, the token cache is reset, and the view is returned.
- `DELETE /api/git-hosts/github-app` clears the pair, resets the cache, returns the view.

## Token mint (src/githubApp.ts, no new npm dependency)

- `signAppJwt(appId, keyObject, now)`: RS256 JWT, header `{"alg":"RS256","typ":"JWT"}`,
  claims `iat = now - 60` and `exp = iat + 600` (lifetime 10 minutes at most),
  `iss = appId`. Signed with node:crypto over `RSA-SHA256`.
- `AppTokenSource.tokenFor(owner, repo)`:
  1. Returns the cached token of this `owner/repo` while `now < expiresAt - 5 min`. Each
     token is scoped to one repo, so the cache holds one entry per repo.
  2. `GET https://api.github.com/repos/{owner}/{repo}/installation` with the app JWT.
     A 404 answers `null` (no installation). Another failure throws an error whose text
     holds only the status and GitHub's `message` field, never the key.
  3. `POST https://api.github.com/app/installations/{id}/access_tokens` with
     `{ repositories: [repo], permissions: { pull_requests: "write" } }` and caches
     `{ token, expiresAt }` from `expires_at`. A missing or unparsable `expires_at`
     means no cache entry.
- Fetches go through one injectable seam (`githubAppFetch`, default `noRedirectFetch`).
- Concurrency: two simultaneous posts may each mint; the cache only saves calls.

## Install check (`checkAppInstalls`, `appCheckWarning`)

- The board's 30-second sampler (`sampleStats`) runs the check when an app is set and the
  last check is older than 10 minutes, or when the set of board repos changed. A save of
  the pair runs it before the answer; a delete clears it.
- Board repos: `ownerRepo(e.github)` of each project with a GitHub remote, sorted, unique.
- `GET /app` with the app JWT gives `name` and `html_url` (https only, else null). A non-2xx
  answer stops the check with `app lookup answered <status>`.
- `GET /repos/{owner}/{repo}/installation` for each repo: 404 adds the repo to `missing`.
  Another non-2xx answer stops the check with `installation lookup for <repo> answered <status>`.
- `AppCheck = { at, name, url, repos, missing, error }`. No field holds the key.
- `state.warnings` gains one line while the app is set and the check has an error or a
  missing repo. The error line wins. The missing line names the app, the repos and
  `<url>/installations/new`.
- Settings → Git hosts shows the app name (a link to `url`), then one line: "Installed on all
  N board repos", "Not installed on …" with an install link, or "Check failed: …".
- Cost: 1 + one call per repo every 10 minutes, far below the app rate limit.

## Post route

`POST /api/projects/:project/tasks/:id/pr-review/post` keeps every gate, the claim,
the release and the `post_error` handling it has today. The GitHub call changes:

- With an app configured and an installation found: direct fetch POST to
  `https://api.github.com/repos/{repo}/pulls/{number}/reviews`, JSON body
  `{ event: "COMMENT", body: <body + REVIEW_FOOTER>, commit_id: <reviewedHead> }`,
  `Authorization: Bearer <installation token>`. The board token and `gh` stay unused.
- With no app configured, or an installation 404: today's `gh` call with the board token.
- Another app-path failure (bad key, GitHub 5xx, network): 502 like a gh failure —
  the claim is released, `post_error` stores the redacted error, no fallback post.
- Success parses `html_url` (https://github.com/ prefix only) and `user.login`
  (string of 1 to 100 characters, else null) from the response of either path.
- The response is `{ ok: true, login, via }` with `via: "app" | "token"` — the fallback
  is reported here.

## Store (additive)

- `pr_review` gains `posted_login TEXT`: DDL in `SCHEMA` plus a
  `PRAGMA table_info` migration in `ProjectStore.open` (the `posted_url` pattern).
- `setPrPostedUrl(number, url, login = null)` writes both columns in one statement.
- `PrReviewRow` and `PrReviewView` gain `postedLogin: string | null`.

## UI

- Settings → Git hosts gains a "GitHub App" block under "GitHub token": when unset, an
  App ID field and a write-only private-key textarea with Save; when set, the App ID,
  `key set`, the fingerprint, and Replace and Remove actions. The key is never shown.
- The PR review drawer appends `· Posted as <login>` to the posted label when a login
  is stored. This covers both identities: `ottr[bot]` marks an app post, the person's
  login marks a fallback post.

## Docs

- README: a "GitHub App" settings row and the one-time setup steps (register the app,
  no webhook, `Pull requests: Read and write` plus `Metadata: Read`, generate a key,
  install it on the repos to review, paste App ID and key). Name it "Ottr" or
  "Ottr-<owner>" when taken.
- pr-reviews.md: the Post section describes the app token, the fallback and the identity
  model, and links this spec.

## Acceptance checks

- The JWT has the right header, `iss = appId`, `iat = now - 60`, and an `exp` of at most
  10 minutes; a test verifies the signature with the test key pair's public key.
- App configured and installation found: the post call carries the installation token,
  and the board token's `gh` path stays unused (the fake fetch records the auth).
- No app, or no installation (404): the post uses the board token and the response
  reports `via: "token"`.
- The private key never appears in any API response, log line or error text: a
  fixed-seed fast-check property over random error paths asserts this against the
  responses and the git-hosts view.
- `bun run check` and `bun test` exit 0.

## Non-goals

- Moving merge pushes, releases or CI reads to the app.
- GitHub webhooks; a post without a click; `APPROVE` or `REQUEST_CHANGES` events.
- Storing the token cache anywhere but memory.
