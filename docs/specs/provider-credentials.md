# Provider credentials: one sign-in for each store

Status: accepted (OTTR-183). This spec replaces the write-through copy of
`shareProviderCredentials`.

## Problem

The board and the workers use two omp credential stores:

- The board store: `$PI_CODING_AGENT_DIR/agent.db`. In compose, this is
  `/etc/ottr/home/.omp/agent/agent.db` on the `board-config` volume. Only the
  server mounts this volume.
- The worker store: `$HOME/.omp/agent/agent.db`. In compose, this is
  `/root/.omp/agent/agent.db` in the shared home. Every worker mounts it, and a
  turn can write to it.

Before this change, a Settings sign-in wrote the board store, and the board then
copied the provider rows into the worker store. Then the two stores held the same
refresh token. The provider rotates the refresh token at each refresh, so the
first store that refreshed made the token in the other store invalid. The other
store then failed with `invalid_grant`, and the worker turns stopped with
`No API key found for anthropic`. This occurred on 24 Oct, two times on 25 Oct,
and on 26 Oct 2026.

## Behavior

### Two stores, two logins

When the two stores are different files, a Settings sign-in runs two
independent `omp login <provider>` processes, one after the other:

1. Step 1, the board store. omp runs with `HOME=boardOmpHome()` and
   `PI_CODING_AGENT_DIR` set to the board agent dir. omp writes the credential
   into the board store itself.
2. Step 2, the worker store. The board creates a new scratch agent dir for this
   step only (see "Scratch dir"). omp runs with `HOME=boardOmpHome()`,
   `PI_CODING_AGENT_DIR` set to the scratch dir, and no `XDG_DATA_HOME`,
   `XDG_STATE_HOME` or `XDG_CACHE_HOME`. omp writes the credential into the
   scratch store. Then the board writes that credential into the worker store
   (see "Adopt"). Then the board removes the scratch dir.

Each step has its own OAuth authorization. Thus each store gets its own refresh
token family, and a refresh in one store does not change the other store.

The user completes both authorizations in one Settings flow:

- Step 2 starts only after step 1 exits with code 0.
- When the provider's redirect of step 1 reaches the board, the board gives the
  address to omp. When step 2 prints its sign-in URL in time, the board sends
  the browser to that URL. Otherwise, the board sends the browser back to
  Settings.
- Settings shows the step (1 of 2, 2 of 2) and the store of the step, and a link
  to the sign-in page of the current step.
- The flow is `ok: true` only when both steps succeed. A failure in step 1 stops
  the flow, and step 2 does not start.

### One store

When the two paths are the same file (a native install without a pin), the
sign-in runs one `omp login` for that store, as before.

### Scratch dir

- The board creates the scratch dir with `mkdtemp` next to the board agent dir
  (`dirname(boardDir)`), with mode `0700`. In compose, this is
  `/etc/ottr/home/.omp/.ottr-login-*` on the `board-config` volume.
- The board refuses to make the scratch dir inside the worker home
  (`$HOME`). Then step 2 fails with an error message.
- The board removes the scratch dir after step 2 in all cases: success, omp
  failure, an adopt failure, cancel, the time-out, and a new start.

### Adopt

The board writes the new credential into the worker store with `bun:sqlite`. No
omp code runs for this.

- The board reads the active `auth_credentials` rows of the scratch store. These
  rows come only from the login of step 2. No rows means an error.
- The board writes each row into the worker store as one `INSERT` with bound
  values: `provider`, `credential_type`, `data`, `identity_key`, and the time.
- Before the insert, in the same transaction, the board marks the rows that the
  new row replaces as `replaced by newer credential`. These are the rows of the
  same provider with the same `identity_key` (the same account), and, for a new
  OAuth row, the API key rows of the provider. This follows omp's own login
  (`upsertAuthCredential`). Rows of other accounts stay.
- The board never reads the `data` column of the worker store, never copies a
  worker-store row into the board, and never resolves or runs a key value from
  the worker store.

### Status

`GET /api/provider-login` returns the sign-ins of each store:

```ts
stores: Array<{
  store: "board" | "workers";
  signIns: SignIn[] | null; // null when the store cannot be read
  error: string | null;
}>
```

A one-store install returns one entry, `board`. Settings shows, for each
provider, the state of each store: active, or needs sign-in.

### Logout

`POST /api/provider-login/logout` marks the provider's rows `deleted by user` in
each store. A missing worker store counts as zero rows. The response is
`{ removed: { board: number, workers?: number } }`.

## Error cases

- omp exits with a code other than 0 in a step: the flow is `ok: false`. The
  output of that step shows omp's error.
- The worker store does not exist when step 1 ends: step 2 does not start, and
  the flow is `ok: false` with a message that names the path. The board does not
  create the worker store.
- The scratch store holds no active credential after step 2, or the insert
  fails: the flow is `ok: false` with the message in the output.
- A store that cannot be read in `GET`: that store's `error` holds the message.

## Security boundary

- The board never runs `omp login`, omp model discovery, or other omp code with
  a worker-writable directory (the shared home, `/root/.omp/agent`) as its agent
  dir or its `HOME`. omp login loads `config.yml` and extensions from its agent
  dir, and model discovery can resolve `!command` keys from its store.
- The board store and the worker store never hold the same refresh token. No
  credential row moves between the two stores in either direction.

## Acceptance checks

- A test with two store files: a refresh that rotates the token in the board
  store leaves the worker store's row and token unchanged, and the reverse.
- A test that a sign-in runs omp login once for each store, with a different
  agent dir, and that the two stores then hold different refresh tokens.
- A test that the scratch dir is gone after a successful step 2 and after a
  failed step 2.
- A test that logout clears the provider in both stores.
- `bun run check` and `bun test` pass.

## Non-goals

- omp's auth broker (OTTR-171). A worker could store a `!command` API key
  through the broker, and the board would run it.
- A sign-in for only one of the two stores.
- Changes to Alate, to the role settings, to `src/prompts.ts`, or to the
  tracker schema.
- A new npm dependency.

## Open risk

anthropics/claude-code#20310 (closed as stale, not confirmed) reports that a
login of the same Claude account on a second device made the token of the first
device invalid. If this is true for Anthropic, step 2 makes the board's token of
step 1 invalid. Evidence against it:

- omp gives each login its own PKCE authorization-code grant
  (`pi-catalog` `rules/auth/anthropic.kdl`), and its comment on
  `ANTHROPIC_OAUTH_GRANT_TTL_MS` calls each login a separate grant family.
- The Claude Code error reference names only "signed out everywhere" and an
  admin as causes of a revoked token.
- OpenAI's Codex CI guide tells users to keep one `auth.json` for each runner,
  and names a shared copy as the cause of the failure.

Check after the first sign-in: Settings must show both stores as active after
the next refresh of each store (about 8 hours for Anthropic).
