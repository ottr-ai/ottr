# Jira import: list tickets with JQL, select some or all, import them as cards

## Goal
A user writes a JQL query on a project board, sees the matching Jira tickets, selects all or some of them, and imports each selected ticket as one card in that project. The import is read-only toward Jira.

Write the spec first as `docs/specs/jira-import.md` (behavior, error cases, acceptance checks, non-goals: this text), then implement against it. Follow AGENTS.md (schema changes are additive with a migration in `ProjectStore.open`; no new npm dependency without approval; UI keeps WCAG 2.1 AA; screenshot proofs for UI).

## 1. Jira connections (board level, several, named)
- The board holds a list of named Jira connections (for example "work", "client"). Manage them in the board settings UI: add, edit, test, delete.
- Fields of a connection: unique name, site URL, deployment type (Cloud or Data Center), email (Cloud only), token, optional list of custom field IDs (for example `customfield_10042`) to put into card prompts.
- Site URL rules: `https://` only; any host, also private and internal hosts. Refuse a URL with user info, a query, or a fragment. Normalize it to its origin plus an optional context path (for example `https://jira.corp/jira`), with no trailing slash. In hosted mode (the hosted-mode flag on), refuse hosts that resolve to private, loopback, or link-local addresses (SSRF guard), and check the resolved address at each request, not only at save. The request then connects to the address that the check approved (no second DNS lookup), so a DNS change between the check and the connection cannot reach a private address. TLS still checks the certificate against the site's hostname (`pinnedFetch` in `src/jira.ts`).
- Every Jira request: 15-second timeout; redirects are not followed (a 3xx is an error that names the `Location`), so a redirect cannot bypass the SSRF guard or carry the token to another host.
- Type detection: when the user enters the URL, the board server calls `GET <site>/rest/api/2/serverInfo` without auth and reads `deploymentType`: "Cloud" means Cloud; "Server" or "DataCenter" means Data Center. When that call fails (network error, 401/403, non-JSON) or `deploymentType` is missing or has any other value, the form shows the reason and a manual Cloud / Data Center select. The user can always change the detected type.
- Auth: Cloud uses Basic auth with email + API token and REST v3 (`POST /rest/api/3/search/jql`, token-based paging with `nextPageToken`). Data Center uses `Authorization: Bearer <personal access token>` and REST v2 (`POST /rest/api/2/search` with `startAt`/`maxResults`; POST so long JQL does not hit URL length limits).
- "Test" button: calls `/rest/api/<v>/myself` with the credential and shows the display name or the error.
- Token storage (n8n model): encrypt each token with AES-256-GCM from `node:crypto` (random 12-byte IV per value, auth tag stored). The key comes from env `OTTR_SECRET_KEY` (32 bytes, base64 or hex). When the env var is not set, the board creates a random key file next to the board store on first use, with file mode 0600, and uses it after that. Each stored value records a key ID: the first 16 hex characters of SHA-256 of the key. Decrypt uses only the current key; a value whose key ID differs counts as unreadable (no old-key lookup in this task). The API never returns the token to the browser (write-only field: the form shows "set" and an empty field that replaces the token only when filled). Logs and error texts never contain the token.
- Lost key: when a stored token cannot be decrypted (key file lost, `OTTR_SECRET_KEY` changed), the connection shows "token unreadable, enter it again". Searches and imports for projects that use it fail with that message. Nothing is deleted and the board still starts.
- Delete: refuse to delete a connection while any project uses it. The error lists those projects.

## 2. Project setting
- Each project has a Jira connection picker in its settings: "none" (default) or one named connection.
- Each project stores its last JQL query: the board saves it after each search that Jira accepts (not on each key stroke, not after a failed search). The import dialog opens with it filled in. There is no list of saved queries.

## 3. Import dialog
- Entry point: an "Import from Jira" button in the project board header. It shows only when the project has a Jira connection set.
- The dialog has: a JQL text field, a Search button, a result list with one checkbox per ticket, a "select all" checkbox, a stage choice (Backlog or Todo, Backlog is the default), and an Import button.
- Search: runs the JQL through the board server (the browser never calls Jira). Page size 50. A "Load more" button gets the next page and appends it. "Select all" selects the importable rows loaded at that moment; rows that a later "Load more" adds start unselected. A new search clears the selection.
- Each row shows: key (link to the ticket in Jira), summary, issue type, status, priority.
- Already imported tickets (see section 5) show as "already imported" with a link to the card, and their checkbox is disabled.
- Errors: a JQL error from Jira (400 with `errorMessages`) shows the Jira message in the dialog. 401/403 shows "check the connection's credentials". A network error or timeout shows the cause. Zero hits shows "no tickets match".
- Import: files one card per selected ticket in the chosen stage, in one store transaction. No count limit. A ticket that the in-transaction re-check finds already imported (a race) is skipped (`skipped`), and the rest are filed. A ticket that Jira no longer returns at import time (deleted, or the credential lost access) is not filed and is reported apart (`unavailable`), never as already imported. After import, the dialog stays open, shows "Filed N cards", plus "M skipped: already imported" when M > 0 and "K not available in Jira (deleted or no access): KEY, …" when K > 0, and refreshes the loaded rows so the imported tickets show as already imported.

## 4. Card content
- Title: `<KEY>: <summary>`, redacted and cut to 120 characters, the same way as `cardTitle` in `src/issues.ts`.
- Prompt: a fixed header that names the source and the ticket link (`<site>/browse/<KEY>`), then each item below as a fenced untrusted DATA block, cleaned the same way as `issueCardPrompt` in `src/issues.ts` (strip invisible characters, redact, remove DATA fence markers):
  - summary
  - description, converted to Markdown: Cloud ADF (headings, paragraphs, lists, code blocks, links, emphasis, tables as plain rows) and Data Center wiki markup (`h1.`, `*`/`#` lists, `{code}`, `[text|url]`, `*bold*`, `_italic_`). An unknown node or markup becomes its plain text.
  - fixed fields: issue type, status, priority, labels, components, parent or epic key
  - each custom field ID that the connection lists: its value as text (string, number, option value, array joined, ADF converted). An empty or missing field is skipped.
- Prompt limit: cut the summary and each fixed-field and custom-field value to 2000 characters, then cut the description so the whole prompt fits the 20000-character card prompt limit, with a "(truncated; read the full ticket in Jira)" marker. If the prompt is still too long with an empty description, drop custom fields from the last one back and add a "(fields omitted)" marker. Header + summary + the six fixed fields stay below 20000 after these cuts, so import never fails only for size.
- No comments, attachments, or worklogs.

## 5. Duplicate tracking
- Per project, record (site host + context path, issue key) → card id for each imported ticket.
- A ticket counts as already imported while its card exists, whatever its stage, including cancelled. When the card is deleted, the record no longer matches, so the ticket can be imported again. The board has no card delete action today: "deleted" means the task row is gone (`getTask(id) === null`). A stale record for a missing task is replaced by the next import of that ticket.
- Storage: the per-project table `jira_imports (site, issue_key, task_id, filed_at)`, primary key `(site, issue_key)`. Board connections live in the board store key `jira-connections`. The token key file is `.tasks/secret.key` next to `tracker.db`.
- The match uses the site, not the connection name: a second connection to the same site sees the same tickets as imported.
- The import call re-checks on the server inside the transaction, so a double click or two open dialogs cannot file one ticket twice.

## Acceptance checks
1. A Cloud connection (email + token) and a Data Center connection (PAT) both save, test, search, and import. Tests stub Jira over HTTP and assert the exact method and URL: Cloud `POST /rest/api/3/search/jql`, Data Center `POST /rest/api/2/search`, plus the correct `Authorization` header.
2. serverInfo detection picks the type. A failing serverInfo shows the manual select.
3. An `http://` site URL, or one with user info, a query, or a fragment, is refused. In hosted mode, a host that resolves to 127.0.0.1, 10.x, 192.168.x, or 169.254.x is refused at save and at request time. A 3xx answer from Jira is an error and the board sends no second request. A stub that does not answer within 15 seconds gives a timeout error.
4. The stored token in the DB is not the plain token. The settings API response never contains it. A changed `OTTR_SECRET_KEY` makes the connection show "token unreadable" without a crash. A missing env var creates a 0600 key file once and reuses it.
5. Deleting a connection that a project uses fails and names the project.
6. Paging: 120 hits show 50, then 100, then 120 after two "Load more" clicks, and then "Load more" disappears.
7. Importing 3 of 5 tickets into Backlog files 3 backlog cards with the right titles and prompts. Todo files todo cards.
8. A second search shows the 3 tickets as already imported, not selectable. A cancelled card still blocks. After a card is deleted, its ticket is selectable again.
9. Two parallel import calls for one ticket file one card.
10. ADF and wiki markup fixtures convert to the expected Markdown. Ticket text that holds `DATA>>>` cannot close its block. A long description is cut and the prompt stays at or below 20000 characters.
11. A property-based test (fast-check, if already present; else a seeded loop) for the ADF and wiki converters and the prompt builder: no exception on random input, no fence marker in output, length within limit.
12. The dialog opens with the project's last JQL. A JQL syntax error shows Jira's message.
13. `bun run check` and `bun test` pass. Screenshot proofs of the settings form and the import dialog.

## Boundaries and non-goals
- Read-only toward Jira: no labels, comments, transitions, or other writes. Write-back is a non-goal.
- No automatic or scheduled import; the user starts each import.
- No sync after import: a later change to the ticket does not change the card, and a card change does not change the ticket.
- No comments, attachments, or worklogs in the prompt.
- No named saved JQL queries; only the last JQL per project.
- No OAuth 2.0 (3LO) apps; only API token (Cloud) and PAT (Data Center).
- No key-rotation UI (the key ID only makes a later rotation possible).
- No new npm dependency (use `fetch` and `node:crypto`); if one seems needed, stop and ask.

## Risks
- SSRF: the board server fetches a user-given URL. Self-host allows internal hosts on purpose. Hosted mode blocks them.
- Prompt injection: ticket text is untrusted and goes into agent prompts. Keep it inside cleaned DATA blocks.
- A lost key file makes all tokens unreadable: the README must tell users to back up the key file or set `OTTR_SECRET_KEY`.
- Jira Cloud deprecated `/rest/api/3/search` for `/rest/api/3/search/jql`. Use the new one.
