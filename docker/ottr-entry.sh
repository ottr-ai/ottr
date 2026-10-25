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
	if [ ! -e "$PI_CODING_AGENT_DIR/config.yml" ]; then
		echo "ottr-entry: R5-1: $PI_CODING_AGENT_DIR is not seeded; refused the shared home $HOME as its source (worker-writable). The board's omp runs without the agent layer until a trusted seed: docker compose run --rm board-seed --repo <owner/name> (docs/WORKERS.md)" >&2
	fi
fi
# Fleet memory backend (D8): containers with HINDSIGHT_API_URL (compose workers and the
# board) run omp with memory.backend: hindsight; the captured config selects mnemopi,
# which stays the default for direct local spawns outside compose. Patches the shared
# $HOME/.omp/agent/config.yml (workers) and the board's pinned
# $PI_CODING_AGENT_DIR/config.yml, so a fresh seed gets the flip at the next start. Only
# the backend line is patched — URL/token reach omp through the environment.
if [ -n "$HINDSIGHT_API_URL" ]; then
	for cfg in "$HOME/.omp/agent/config.yml" ${PI_CODING_AGENT_DIR:+"$PI_CODING_AGENT_DIR/config.yml"}; do
		if [ -f "$cfg" ]; then
			sed -i 's/^  backend: mnemopi$/  backend: hindsight/' "$cfg"
		fi
	done
fi
exec "$@"
