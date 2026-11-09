# omp stats dashboard behind the board login

Settings -> omp usage gets a link, **Launch omp stats dashboard**. The link opens omp's own
dashboard (`omp stats`) in a new tab. The board starts the dashboard on demand, serves it
through its own login, gives it every session transcript of the board, and stops it after
30 minutes without requests.

## Behavior

### Proxy port

- The server binds a second listener on `OTTR_OMP_STATS_PORT` (default `3848`), on the same
  host as the board (`OMP_TRACKER_HOST`). The value `0` or `off` disables the listener.
  An invalid value disables it, and the server logs the reason at boot.
- Default 3848, not 3847: `omp stats` binds 3847 by default. A board on 3847 blocks the
  user's own `omp stats`, and omp's port-conflict probe then reaches the board.
- A bind failure does not stop the board. The server logs the failure and the dashboard
  info (below) carries the error.
- `docker-compose.yml` publishes `127.0.0.1:${OTTR_OMP_STATS_PORT:-3848}` on the same port
  inside the container and sets the env value for the server.

### Guards on every proxy request (same rules as `/api`)

1. Host header: only `127.0.0.1:<port>` and `localhost:<port>` (`hostRefusal(host, port, [])`).
   Other hosts get 403. Public hosts are not served: a separate port does not pass through
   `tailscale serve`.
2. Auth wall: when the peer is not direct loopback (`walled`, with the proxy server's
   `requestIP`), the request needs a valid board session cookie or `X-API-Key`
   (`authorized`). Cookies do not depend on the port, so the board's `ottr.session`
   cookie for `localhost` reaches `localhost:<port>`. Without auth, the proxy answers 401
   with a short HTML page that links to the board sign-in at
   `http://<request hostname>:<board port>/`.
3. Every method other than GET and HEAD needs an Origin of `http://127.0.0.1:<port>` or
   `http://localhost:<port>` (`originRefusal(origin, port, [])`). Others get 403.
   omp itself also demands its `X-Omp-Stats-Action` header on spending POSTs.

### Forwarding

- A request that passes the guards starts the dashboard when it is stopped or failed, and
  counts as activity for the idle clock.
- While the dashboard starts, the proxy answers 503 with an HTML page that refreshes every
  2 seconds and says the current step (copying transcripts, starting omp stats). After a
  failed start, the page shows the error. The next request tries the start again.
- When the dashboard runs, the proxy forwards the method, path, query, body, and headers to
  `http://127.0.0.1:<child port>`. It drops `cookie`, `authorization`, `x-api-key`, `host`,
  and the `x-forwarded-*` and `forwarded` headers. The response streams back with its
  status, headers, and body. The proxy drops `set-cookie` from the response: cookies do not
  depend on the port, so an upstream cookie could replace the board session cookie. It also
  drops `content-length` and `content-encoding`, because `fetch` can decompress the body.
  `/api/events` (server-sent events) has no idle timeout on the proxy listener.
- An upstream fetch error answers 502 with the error text.

### Dashboard process

- Command: `omp stats --port 0 --host 127.0.0.1`. Env: `boardOmpEnv()` plus
  `PI_CODING_AGENT_DIR=<base>/agent`. `TERN_PANE` and `TERN_PANE_SOCKET` are removed, so omp
  never takes over a terminal pane.
- `<base>` is `<boardOmpHome()>/.omp/ottr-stats-dashboard`, mode 0700: the board's
  server-only home, never a worker-writable volume.
- The board reads the child port from the line `Dashboard available at: http://127.0.0.1:<port>`
  on stdout (ANSI codes stripped). No such line within 60 seconds, or an exit before it,
  is a failed start. The error text is the last stderr or stdout line.
- The child exits with the board: the server stops it on `exit`, `SIGINT`, and `SIGTERM`.
- An unexpected child exit sets the state to stopped (exit code 0) or failed (other codes).
  The next request starts it again.
- omp keeps its stats database at `<HOME>/.omp/stats.db` (the board home). The dashboard
  agent dir has no provider sign-in, but the child gets the server env. A provider API key
  in that env (for example `ANTHROPIC_API_KEY`, which compose passes to the server) lets
  omp's paid "Frustration" judge run, paid with that key. Only a request that passes the
  proxy guards can start it, and omp also demands its `X-Omp-Stats-Action` header.

### Idle stop

- The server ticks every 60 seconds. When the dashboard runs and no proxy request
  arrived for 30 minutes (`OMP_STATS_IDLE_MS`), the board stops the child (SIGTERM).
- An open `/api/events` stream does not count as activity. When the child stops, the
  stream ends and the page shows that it lost the connection. A reload starts it again.

### Session transcripts ("all board sessions")

`omp stats` reads one sessions dir, `<agent dir>/sessions/<folder>/<file>.jsonl`, and it
lists only real directories and real files: a symlink is skipped. So the board keeps a
mirror under `<base>/agent/sessions`:

- Sources, the same as the omp usage card: the board store
  (`<boardOmpHome>/.omp/agent/sessions`), the workers' store (`~/.omp/agent/sessions`) when
  it is another dir, and each project's `store.sessionsDir`.
- A store keeps its folder layout: each subfolder maps to the mirror folder of the same
  name. Two stores with the same folder name share it (file names are unique).
- A project dir (flat: the files sit directly in it) maps to the folder
  `--ottr--<project>`. omp shows it as `/ottr/<project>`. Characters other than
  `A-Za-z0-9._-` in the name become `-`.
- Only regular `.jsonl` files are copied (`lstat`): a symlink or other special file in a
  source is skipped, so a worker cannot make the board copy a file outside the session dirs.
  Folder names `.`, `..`, and names that start with `.omp-gc-compress-` are skipped.
- Copy rule per file: the target is missing or larger than the source -> copy the whole
  file. The target is smaller -> append the source bytes from the target size to the
  source size (transcripts only grow). Same size -> no write.
- The mirror never deletes a file. A transcript that a source deletes stays in the mirror.
- The board refreshes the mirror before each start and on each 60-second tick while the
  dashboard runs. omp's file watcher on the mirror ingests the new bytes.
- A source dir that does not exist is skipped. A read or copy error on one file is
  recorded and the other files continue. The start does not fail on file errors.
- Cost: the mirror is a second copy of every transcript on the board home's disk.

### Settings link

- `GET /api/settings/omp-stats/dashboard` (behind `api()`) answers
  `OmpStatsDashboardInfo = { port: number | null; error: string | null }`: `port` is the
  listening proxy port, null when disabled or not bound. `error` is the bind error or the
  disabled reason.
- The omp usage card shows the link `Launch omp stats dashboard` (new tab,
  `rel="noopener noreferrer"`) to `http://<location.hostname>:<port>/`, with the caption
  "omp's own dashboard with charts and session traces. The board starts it on demand and
  stops it after 30 minutes without use."
- When `location.hostname` is not `localhost` or `127.0.0.1`, the card shows no link and
  says that the dashboard opens only from the board on localhost.
- When `port` is null, the card shows no link and shows the `error` text.

## Acceptance checks

- Mirror: a store folder and a flat project dir appear under the mirror with the folder
  names above. A grown source appends only the new bytes. A symlinked source file is not
  copied. A second run with no source change writes nothing.
- Process: the port parse accepts the omp line with and without ANSI codes. A fake child
  that prints the line reaches `running`. A fake child that exits first reaches `failed`
  with its last output line. The idle tick stops a child after 30 minutes without
  `touch`, and not before.
- Proxy: a wrong Host gets 403. A walled request without a session gets 401. A POST with a
  foreign Origin gets 403. An authorized GET reaches a fake upstream with the path and
  query and without the cookie header.
- UI: the card shows the link with the port from the info endpoint; on a non-loopback
  host or with a null port, it shows the caption instead.
- Smoke: a real board on temp state opens the dashboard page through the proxy port.

## Non-goals

- The dashboard on public hosts (`OMP_TRACKER_PUBLIC_HOSTS`) and in hosted mode
  (`OTTR_HOSTED`). A hosted board binds no proxy, and the info endpoint answers
  `{ port: null, error: "not available in hosted mode" }`: the hosted wall has no loopback
  or cookie grant, and the proxy port would offer both.
- Provider sign-in for omp's Frustration judge inside the dashboard, and removing provider
  API keys from the dashboard env.
- Removing mirror files for deleted transcripts.
- Changes to the omp usage numbers that the card itself shows.
