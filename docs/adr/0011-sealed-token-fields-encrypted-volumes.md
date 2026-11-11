# 0011. Token fields are sealed and deployments use encrypted volumes

Date: 2026-11-11

## Status

accepted

## Context

Ottr keeps its credentials as plaintext fields of the `config` row in
`.tasks/tracker.db` (src/app.ts, `saveConfig`). The operator enters the GitHub
token, the per-host git tokens, the GitHub App private key, the Alate key, and
the Hindsight token. It also enters the secret env values of Settings → Env.
Each secret env value is the only copy. The board generates the session secret,
the board API key, and the VAPID key pair of Web Push. The per-project
`tasks.db` files hold no credential fields today. The database snapshots (OTTR-790, `docs/specs/db-backup.md`)
copy both databases verbatim, so every snapshot holds the same plaintext. The SSH
keys live as files under `OTTR_SSH_DIR`. The admin password is a salted scrypt
hash (src/auth.ts). Only the Jira connection tokens are sealed today, with the
`SecretBox` (src/secretBox.ts): AES-256-GCM, a key from env `OTTR_SECRET_KEY`, or
the file `.tasks/secret.key` (created once with mode 0600) when the env var is
not set. An operator who copies a database file or a snapshot to another machine
gets every token with it. No recorded decision said why the databases are not
encrypted, or what the operator must do instead (OTTR-736, topics 67 and 72).

## Decision

Two layers protect the data at rest. The user chose both.

1. Field sealing. The token and key fields in `tracker.db` are sealed with the
   existing `SecretBox`, as the Jira tokens already are. This covers the
   operator-entered values and the board-generated ones. The key stays where it
   is today: env `OTTR_SECRET_KEY` wins, and `.tasks/secret.key` next to
   `tracker.db` stays as the fallback. When a field is sealed in `tracker.db`,
   the snapshots hold the sealed value too.
2. Volume advice. The operator runs the state volume, the backup dir, and the
   SSH key dir on an encrypted volume (LUKS, BitLocker, FileVault, or an
   encrypted Docker volume). Field sealing cannot cover the SSH keys, the fork
   mirror caches, the SQLite WAL files, or the theft of the whole volume.

Refused options:

- Docs only (plaintext files and an encrypted volume). A database copy or a
  snapshot that leaves the host stays plaintext.
- Field sealing without the volume advice. The SSH keys, the caches, and the
  WAL files stay plaintext on the volume.
- Whole-file database encryption (SQLCipher or similar). It adds a native
  dependency, and it encrypts the cards and turns that need no protection.
- Secret-manager integrations (Vault, cloud KMS). They are a non-goal for this
  self-hosted, single-host board.

## Consequences

- A follow-up implementation card does the field sealing. It migrates the saved
  plaintext values and names this ADR. Until it ships, `tracker.db` and the
  snapshots stay plaintext, and the README keeps the credential-store warning.
- A lost key, or a changed `OTTR_SECRET_KEY`, makes sealed values unreadable.
  Operator-entered values show the Jira behavior: the field reads unreadable,
  and the operator enters the value again. Nothing is deleted.
- The session secret, the board API key, and the VAPID keys are board-generated.
  The operator cannot enter them again. When their stored value is unreadable,
  the board generates new values, saves them sealed, and stays loginable. The
  operator then copies the new API key to the API clients. New VAPID keys make
  the browsers re-subscribe for Web Push: a subscription binds to the public
  key it registered with.
- A restored snapshot is usable only with its sealing key. The operator backs up
  `.tasks/secret.key` or sets `OTTR_SECRET_KEY` (docs/WORKERS.md).
- The per-project `tasks.db` files hold no credential fields today. A future
  feature that stores a credential in a project database seals it the same way.
- The scrypt password hash stays as it is. It is not a reversible secret.
