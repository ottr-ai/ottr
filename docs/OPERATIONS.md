# Operations

How to run one Ottr host: what "board up" means, what to do when the board is
down, how to restore the databases, and how to write up an incident. One host
has one operator, so this page stays short. The guide for the compose stack is
[docs/WORKERS.md](WORKERS.md).

## What "board up" means

The board is up when all of these are true:

- `docker compose ps` lists the server and every worker as `healthy`.
- The server answers its health check, `GET /api/boot` (compose runs it every
  30 s; `docker-compose.yml`).
- Every worker answers `GET /healthz` on its port (`WORKER_PORT`, default 8787).

From the host: `curl -fsS http://127.0.0.1:8080/api/boot`. The board binds to
loopback only, and the port is `OTTR_PORT` (default 8080).

Uptime target: the board answers at least 99% of the minutes in a month, about
7 hours of downtime in a 30-day month. This target fits a self-hosted app on one
host with one operator: `restart: always` covers crashes, not a lost host or
disk. No code measures this target today. Check `docker compose ps` and the
logs by hand.

## When the board is down

1. See the state:
   - `docker compose ps` names the unhealthy or restarting container.
   - `docker compose logs server` shows the boot line and the refusal messages.
   - The boot line `ottr-entry: pinned: image=..., oauth dir=..., agent db=...`
     shows the live deploy values even when the start is refused
     (`docker/ottr-entry.sh`).
2. Known causes and their fixes:
   - **A second live board holds a database.** The log says `refusing to start`
     with a `StoreLockedError`: "`<path>` is held by another live instance"
     (`src/dblock.ts`). Stop the other instance, then start this stack again.
   - **A wrong `OTTR_AGENT_DB` or `OTTR_OAUTH_DIR` host path.** The entry script
     refuses the start with an `ottr-entry:` message: the agent db path must name
     a file, the oauth dir path must name a directory. An empty oauth dir only
     warns: the host omp can keep every sign-in in agent.db. After you fix the
     path, a `Not a directory` mount error can loop. Run
     `docker compose run --rm home-repair`, then `docker compose up -d`
     ([docs/WORKERS.md](WORKERS.md), "Troubleshooting").
   - **A project database failed at boot.** The log says `skipping project <name>`
     or `could not move project database <name> ... move it by hand`
     (`src/server.ts`). The board still starts, and the message points to
     [docs/WORKERS.md](WORKERS.md). An adoption that meets a live second board
     refuses the start, like a lock.
   - **A worker died.** No action: the server sees the lost connection
     (`workerLost`) and the card resumes with a new turn, and `restart: always`
     starts the container again ([docs/WORKERS.md](WORKERS.md), "Crash
     recovery"). After a manual `docker stop` or `docker kill`, Docker suppresses
     that policy. `docker start <worker>` starts the worker again.
3. Start the stack again:
   - Rebuild and start: `docker compose up -d --build`.
   - Restart only the board: `docker compose stop server`, then
     `docker compose up -d`.
   - The one-shot update stops and starts one runner at a time
     ([docs/WORKERS.md](WORKERS.md), "Updates").

## Restore

The board makes a snapshot each day and keeps the newest `OTTR_BACKUP_KEEP`
(default 7). Snapshots live on the `ottr-backup` volume, or on the host path in
`OTTR_BACKUP_MOUNT`. The restore steps are in [docs/WORKERS.md](WORKERS.md),
"Backups and restore"; this page does not repeat them.

Rule: start the restore before `OTTR_BACKUP_KEEP` days go by. Retention removes
the older snapshots, and after a lost `ottr-state` volume the new empty board
also makes snapshots. When you restore late, `latest` can name that empty
snapshot: give the stamp of a snapshot from before the loss.

## Incidents

Fill this template. Keep the filled copy in the tracker card that you open for
the incident: the card keeps the turn transcripts beside it. When the fix
produces a durable rule, add the rule to `AGENTS.md` with the card IDs (the
pattern of its enforcement map). The retro of a task collects its lessons too
(`src/retro.ts`).

```markdown
## Incident <UTC date>: <one line>
- What happened:
- Impact: cards, turns, data
- Timeline: detection to recovery, times in UTC
- Cause:
- What detected it: log line, health check, or user report
- Fix:
- Prevention: the rule or the test that now prevents it
- Cards: <card IDs>
```
