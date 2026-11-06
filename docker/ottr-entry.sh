#!/bin/sh
# The agent layer (rules, config, skills, plugins) lives in the HOME volume
# (default /root); alate provisions it there, the image carries none.
set -e
# R5-1: workers share the home volume read-write, so a turn can plant anything the board
# reads from it. The board pins its git config, gh config, omp agent dir and the HOME of
# its own omp spawns (GIT_CONFIG_GLOBAL / GH_CONFIG_DIR / PI_CODING_AGENT_DIR /
# OTTR_BOARD_OMP_HOME) to the server-only `board-config` volume at /etc/ottr. A pin inside
# the shared home defeats that: refuse to start before anything is written.
refuse_home_pin() {
	if [ -n "$2" ] && [ -n "$HOME" ]; then
		case "$2" in
		"$HOME" | "$HOME"/*)
			echo "ottr-entry: R5-1: $1=$2 lies in the shared home $HOME; refusing to start" >&2
			exit 1
			;;
		esac
	fi
}
refuse_home_pin GIT_CONFIG_GLOBAL "$GIT_CONFIG_GLOBAL"
refuse_home_pin GH_CONFIG_DIR "$GH_CONFIG_DIR"
refuse_home_pin PI_CODING_AGENT_DIR "$PI_CODING_AGENT_DIR"
refuse_home_pin OTTR_BOARD_OMP_HOME "$OTTR_BOARD_OMP_HOME"
# Repair mode: remove the empty agent.db folder a wrong host path left in the home
# volume. The repair container mounts only the home volume, not the failing agent.db
# bind, so it reaches the folder. It removes ONLY an empty directory: a real or
# missing agent.db has nothing to do, and a non-empty folder is refused untouched.
if [ "${1:-}" = "repair-agent-db" ]; then
	shift
	db="${OTTR_AGENT_DB:-/root/.omp/agent/agent.db}"
	if [ -d "$db" ] && [ -z "$(ls -A "$db")" ]; then
		rmdir "$db"
		echo "ottr-entry: removed the empty folder $db; recreate the stack now" >&2
	elif [ -d "$db" ]; then
		echo "ottr-entry: OTTR_AGENT_DB=$db is a non-empty directory; removing it would delete data — refusing, remove nothing" >&2
		exit 1
	else
		echo "ottr-entry: nothing to repair at OTTR_AGENT_DB=$db (not an empty folder)" >&2
		exit 0
	fi
	exit 0
fi
# Credential mounts: compose interpolates OTTR_OAUTH_DIR and OTTR_AGENT_DB on the host,
# so a wrong host path makes rootful Podman create an empty folder inside the container
# and the stack starts with broken credential mounts that nothing reports. Refuse to
# start before anything is written. Both variables are not inside the container env,
# hence the fixed defaults. README, "Podman", and docs/WORKERS.md, Troubleshooting.
db="${OTTR_AGENT_DB:-/root/.omp/agent/agent.db}"
if [ ! -f "$db" ]; then
	echo "ottr-entry: OTTR_AGENT_DB=$db is not a regular file: a wrong host path made rootful Podman create an empty folder; after fixing the path the home volume keeps that folder and the next recreate fails with 'crun: mount ... agent.db: Not a directory' — repair with docker compose run --rm home-repair. See README, \"Podman\" and docs/WORKERS.md, Troubleshooting; refusing to start" >&2
	exit 1
fi
oauth="${OTTR_OAUTH_DIR:-/root/.omp/oauth}"
if [ ! -d "$oauth" ] || [ -z "$(ls -A "$oauth")" ]; then
	echo "ottr-entry: OTTR_OAUTH_DIR=$oauth is not a non-empty directory: a wrong host path made rootful Podman create an empty folder. Fix the host path and sign in again. See README, \"Podman\" and docs/WORKERS.md, Troubleshooting; refusing to start" >&2
	exit 1
fi
# R5-1: this script never copies from $HOME. A missing pinned git config gets the fixed
# Ottr identity (the one src/app.ts commits with). gh starts empty: its config can name
# commands (browser, pager). The omp agent dir only gets content from the trusted seed,
# the Alate one-off service `board-seed` (docs/WORKERS.md).
if [ -n "$GIT_CONFIG_GLOBAL" ] && [ ! -e "$GIT_CONFIG_GLOBAL" ]; then
	mkdir -p "$(dirname "$GIT_CONFIG_GLOBAL")"
	printf '[user]\n\tname = Ottr\n\temail = ottr@localhost\n' > "$GIT_CONFIG_GLOBAL"
	if [ -f "$HOME/.gitconfig" ]; then
		echo "ottr-entry: R5-1: refused to seed $GIT_CONFIG_GLOBAL from $HOME/.gitconfig (the shared home is worker-writable); wrote the fixed Ottr identity" >&2
	fi
fi
if [ -n "$GH_CONFIG_DIR" ]; then
	mkdir -p "$GH_CONFIG_DIR"
fi
# R5-1: the HOME of the board's own omp spawns, which omp reads plugins and user skills
# from. Nothing is copied from the shared home: only the board-seed one-off fills it.
if [ -n "$OTTR_BOARD_OMP_HOME" ]; then
	mkdir -p "$OTTR_BOARD_OMP_HOME"
fi
if [ -n "$PI_CODING_AGENT_DIR" ]; then
	mkdir -p "$PI_CODING_AGENT_DIR"
	# A seeded agent layer counts as seeded: the board home carries .alate/current
	# (docs/specs/agent-layer-switch.md). -e follows the link, so a broken link
	# still warns.
	if [ ! -e "$PI_CODING_AGENT_DIR/config.yml" ] && [ ! -e "$OTTR_BOARD_OMP_HOME/.alate/current" ]; then
		echo "ottr-entry: R5-1: $PI_CODING_AGENT_DIR is not seeded; refused the shared home $HOME as its source (worker-writable). The board's omp runs without the agent layer until a trusted seed: docker compose run --rm board-seed --repo <owner/name> (docs/WORKERS.md)" >&2
	fi
fi
# Podman injects the host proxy env (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) into every
# container and its NO_PROXY names no compose services, so internal calls
# (http://alate:4570, http://worker-a:8787, http://ottr:<port>) would go to the
# corporate proxy and bounce. Sourced: appends the service names, keeping the
# injected host list. Compose cannot see the injected value; the entry script can.
# Sibling-relative: the image COPYs both scripts to /, and the host-side gate
# scripts/ottr-entry.test.ts runs the script straight from docker/, where the
# sibling also exists.
. "$(dirname "$0")/no-proxy.sh"
exec "$@"
