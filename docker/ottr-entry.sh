#!/bin/sh
# The agent layer (rules, config, skills, plugins) lives in the HOME volume
# (default /root); alate provisions it there, the image carries none.
set -e
# Fleet memory backend (D8): containers with HINDSIGHT_API_URL (compose workers)
# run omp with memory.backend: hindsight; the captured config selects mnemopi,
# which stays the default for direct local spawns outside compose. Only the
# backend line is patched — URL/token reach omp through the environment.
if [ -n "$HINDSIGHT_API_URL" ] && [ -f "$HOME/.omp/agent/config.yml" ]; then
	sed -i 's/^  backend: mnemopi$/  backend: hindsight/' "$HOME/.omp/agent/config.yml"
fi
# R5-1: workers share the home volume read-write, so anything the board reads from it can
# be planted by a turn. The compose file pins the board's global git config and gh config
# to the container filesystem (GIT_CONFIG_GLOBAL / GH_CONFIG_DIR); seed the git config
# once from the provisioned home, skip it when something is mounted at the path on
# purpose. gh deliberately starts empty: its config can name commands (browser, pager),
# so nothing is copied from the shared home.
if [ -n "$GIT_CONFIG_GLOBAL" ] && [ ! -e "$GIT_CONFIG_GLOBAL" ]; then
	mkdir -p "$(dirname "$GIT_CONFIG_GLOBAL")"
	: > "$GIT_CONFIG_GLOBAL"
	if [ -f "$HOME/.gitconfig" ]; then
		cat "$HOME/.gitconfig" >> "$GIT_CONFIG_GLOBAL"
	fi
fi
if [ -n "$GH_CONFIG_DIR" ]; then
	mkdir -p "$GH_CONFIG_DIR"
fi
# R5-1 omp layer: the board's own omp agent dir (PI_CODING_AGENT_DIR) is seeded once from
# the provisioned home when absent — config.yml, the agent.db snapshot and the agent layer
# (skills, extensions, plugins). Runs after the backend flip above, so the seed carries the
# flipped memory backend. A plant made in the shared home after board start never reaches
# the board's own omp; Settings sign-in copies its credentials through to the shared store
# (src/login.ts), so workers keep authenticating. Re-provisioning plus a board restart
# refreshes the seed.
if [ -n "$PI_CODING_AGENT_DIR" ] && [ ! -e "$PI_CODING_AGENT_DIR" ] && [ -d "$HOME/.omp/agent" ]; then
	mkdir -p "$(dirname "$PI_CODING_AGENT_DIR")"
	cp -a "$HOME/.omp/agent" "$PI_CODING_AGENT_DIR"
fi
exec "$@"
