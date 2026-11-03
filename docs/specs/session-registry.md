# Session registry

The board's login is a stateless signed cookie: `signSession`/`verifySession` in
`src/auth.ts` HMAC the admin name and an expiry with the one `sessionSecret`.
The server keeps no record of logins, so Settings cannot list sessions or
revoke one; "Sign out everywhere" works only by rotating `sessionSecret`
(`POST /api/settings/session-secret`). This spec adds a small registry of
login sessions in the board config, so the user sees each login and can end
one.

## Behavior

### Registry

- The config object (the `gstore` `"config"` row that already holds `admin`
  and `sessionSecret`) gains `sessions`: an array of entries, one per login.
- Entry shape: `{ id, label, createdAt, lastSeen, exp }` — epoch-ms numbers
  for the times, `id` a 24-hex random value, `label` a short client string.
- `label` comes from the request's `User-Agent`: `<browser> on <OS>`, e.g.
  "Chrome on Linux", "Firefox on Windows", "Safari on iPhone". The parser
  knows the common browsers (Firefox, Edge, Chrome, Chromium, Opera, Safari)
  and operating systems (Windows, macOS, Linux, Android, iOS, ChromeOS) and
  names curl/other tools by their product token. Anything unrecognized is
  "Unknown browser"/"Unknown OS". The full User-Agent string is never stored.
- `lastSeen` is coarse: updated at most once per minute per entry. The check
  that runs on every authed request compares against the stored value and
  persists only when 60 s or more have passed.
- `exp` mirrors the token's own expiry (`createdAt + SESSION_MS`).
- Cap: at most 50 entries. When a login would make 51, the entry with the
  oldest `lastSeen` (least recently active) is dropped first, so the cap
  never evicts a live session ahead of a stale one.
- Entries whose `exp` has passed are dropped lazily: when a new entry is
  added and when the list is served. Malformed entries in a restored config
  (wrong shape) are dropped at load.

### Token

- New logins mint a session id and sign it into the token:
  `encodedName.id.exp.hmac`. Splitting still runs from the end, so names with
  dots or semicolons stay safe.
- `verifySession(secret, token)` returns `{ name, id }` on success and `null`
  on tampered/expired/garbled tokens. `id` is `null` for legacy three-part
  tokens. `signSession` takes the id as an optional argument.
- The auth wall (`authorized()` in `src/app.ts`) checks, in order: signature,
  expiry (inside `verifySession`), and — for a token that carries an id —
  that an entry with that id is still in the registry. A revoked or dropped
  id means 401.
- **Legacy tokens (the stated choice):** tokens issued before this change
  carry no id and stay valid until their natural expiry. They are not listed
  and cannot be revoked one by one; "Sign out everywhere" still kills them at
  once, because it rotates the secret. This avoids logging out every existing
  browser on deploy, and it weakens nothing: before this change every token
  behaved exactly this way.

### Routes

All routes run through the same `api()` wrapper as the other settings routes:
Origin wall on non-GET, host wall, auth wall (session cookie or
`X-API-Key`).

- `GET /api/settings/sessions` → `{ sessions: [...] }`, newest activity
  first. Each item: `{ id, label, createdAt, lastSeen, current }`. `current`
  is true only for the entry matching the caller's own cookie token id; an
  API-key caller gets no `current` on any row.
- `DELETE /api/settings/sessions/:id` → `{ ok: true }` and the entry is
  removed. Unknown id → 404 `{ error: "no such session" }`.
- `POST /api/settings/session-secret` (existing): rotates the secret as
  today and also clears the registry, so no ghost rows survive the rotation.
- `POST /api/logout` (existing): additionally removes the caller's own entry
  when its cookie carries a valid id. It stays an open route: without a
  valid cookie it only clears the cookie, as today.
- `POST /api/setup` and `POST /api/login` (existing): create an entry and
  sign its id into the cookie they set.

### UI (Settings → Session)

- The Session card lists the sessions as rows: client label, a "This
  browser" mark on the current one, when it was last seen, when it signed
  in. Each row carries a "Log out" button on its right.
- "Log out" asks through a confirmation first (the card's established
  `window.confirm` pattern). Confirming revokes the entry; revoking the
  current session then behaves like the account menu's Log out (cookie gone,
  reload into the login gate). Revoking another session refreshes the list.
- Rows follow the settings row conventions (36 px rhythm, quiet secondary
  text, steel only as the interaction edge; the destructive button keeps the
  danger style of the neighboring sections).
- "Sign out everywhere" stays in the card with its existing confirmation and
  behavior.

## Threat model

- Goal: a stolen or lost login (copied cookie, borrowed device, forgotten
  session) can be ended from the board without touching the other logins.
- The registry is revocation state, not a new trust root. The signed cookie
  plus `sessionSecret` stay the only proof of identity; the registry can only
  narrow access (an entry removed = that token refused). It cannot widen
  anything.
- `label` is derived from attacker-controllable input, but it is display
  text, bounded to a short string, and never the raw User-Agent. It must be
  rendered as text like any other server string.
- Session ids are 96 bits of CSPRNG output: not guessable, not enumerable.
- The coarse `lastSeen` leaks at most "this session made a request in the
  last minute" — no finer than before to any observer of the config file,
  which README already documents as a plaintext credential store.
- "Sign out everywhere" remains the stronger, coarser switch: it clears the
  registry and rotates the secret, so copied cookies and legacy tokens all
  die together.

## Error cases

- Revoked or pruned id on an otherwise valid token → 401 at the auth wall.
- `DELETE` with an id that is not in the registry → 404.
- Cross-origin mutation → 403 `forbidden origin` (unchanged Origin wall).
- Unauthenticated request on a walled host → 401 (unchanged).
- Config holding a broken `sessions` value → load keeps only well-formed
  entries; the board boots as before.
- Session list fetch failure in the UI → the card shows a short failure line
  instead of rows and keeps "Sign out everywhere" usable.

## Acceptance checks

1. Two logins produce two rows; the caller's own row carries "This browser".
2. Revoking one session makes that browser's next request fail with 401;
   the other session keeps working.
3. "Sign out everywhere" revokes everything: registry cleared, old cookies
   dead (secret rotated), legacy tokens dead too.
4. Logout in the account menu removes the caller's own entry.
5. A legacy three-part token still verifies until expiry and dies on
   rotation.
6. The cap holds at 50 with the least recently active entry dropped.
7. Expired entries disappear from the list and cannot authorize.
8. The routes answer 401 without a session or key, 403 on a cross-origin
   mutation, and the list marks exactly one row `current` for a cookie
   caller.
9. `bun run check` and `bun test` pass.

## Non-goals

- Multi-user support; the board keeps its single admin.
- Per-session IP, geo, or device fingerprint tracking beyond the UA label.
- Notifying a revoked browser (it learns on its next request, via 401).
- A server-side session store outside the existing config row; no schema
  change to `src/store.ts`.
- Revoking by label, age, or all-but-current as separate endpoints.
- New rate limits; the existing login limiter and walls stay as they are.
