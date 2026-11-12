#!/usr/bin/env bash
# runpair.sh — seed + run two exported tree dirs once per pair, base first then
# final; loop for N pairs. Per run: fresh board, patched server on a pre-picked
# ephemeral port, env-scrubbed start, one load run, then SIGTERM (the server's
# own shutdown handler; never SIGKILL).
#
# Usage:
#   runpair.sh --base <tree dir> --final <tree dir> [--pairs 5] [--runs-root <dir>]
#              [--warmup-ms 10000] [--window-ms 30000]
#
# Outputs under <runs-root>/pair<N>/{base,final}/:
#   board/ (seeded), server.log, records.json, summary.txt, seed.log, run.wall
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=""
FINAL=""
PAIRS=5
RUNS_ROOT=""
WARMUP_MS=10000
WINDOW_MS=30000

while [[ $# -gt 0 ]]; do
	case "$1" in
	--base) BASE="$2"; shift 2 ;;
	--final) FINAL="$2"; shift 2 ;;
	--pairs) PAIRS="$2"; shift 2 ;;
	--runs-root) RUNS_ROOT="$2"; shift 2 ;;
	--warmup-ms) WARMUP_MS="$2"; shift 2 ;;
	--window-ms) WINDOW_MS="$2"; shift 2 ;;
	*) echo "unknown arg $1" >&2; exit 2 ;;
	esac
done
[[ -z "$BASE" || -z "$FINAL" ]] && { echo "need --base and --final tree dirs" >&2; exit 2; }
# Default the run outputs to the OS temp dir: runs/ inside a checkout would
# leave untracked files behind and trip the board's uncommitted-changes banner.
[[ -z "$RUNS_ROOT" ]] && RUNS_ROOT="${TMPDIR:-/tmp}/ottr-gate-runs"
mkdir -p "$RUNS_ROOT"

# Pre-pick one ephemeral port: bind port 0, read the assigned port, release.
free_port() {
	bun -e 'const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") }); console.log(s.port); s.stop(true);'
}

wait_port() {
	# $1 run dir; waits up to 120 s for the HARNESS_PORT banner.
	for _ in $(seq 1 240); do
		if grep -qs '^HARNESS_PORT=[0-9]*$' "$1/server.log"; then return 0; fi
		sleep 0.5
	done
	echo "server did not print HARNESS_PORT in $1/server.log:" >&2
	cat "$1/server.log" >&2
	return 1
}

run_one() {
	# $1 pair number, $2 side name, $3 tree dir
	local pair="$1" side="$2" tree="$3"
	local run_dir="$RUNS_ROOT/pair$pair/$side"
	rm -rf "$run_dir"
	mkdir -p "$run_dir/board"

	local port
	port="$(free_port)"
	bun "$HARNESS/patch-serve.ts" --tree "$tree" --port "$port"

	local t0 t1
	t0="$(date +%s)"
	bun "$HARNESS/seed.ts" --tree "$tree" --board "$run_dir/board" \
		> "$run_dir/seed.log" 2>&1
	tail -3 "$run_dir/seed.log"
	t1="$(date +%s)"
	echo "seed wall: $((t1 - t0)) s ($side pair$pair)"

	# Env-scrubbed server start: only HOME/PATH/TERM pass through, plus the
	# board-scoped vars; OTTR_BACKUP_KEEP=0 disables the backup sweep.
	env -i HOME="$HOME" PATH="$PATH" TERM="${TERM:-xterm}" \
		OTTR_BACKUP_KEEP=0 \
		OMP_TRACKER_ROOTS="$run_dir/board/projects" \
		OTTR_STATE_DIR="$run_dir/board/state" \
		bun "$tree/src/server.harness.ts" > "$run_dir/server.log" 2>&1 &
	local pid=$!

	wait_port "$run_dir"

	bun "$HARNESS/load.ts" --url "http://127.0.0.1:$port" \
		--server-pid "$pid" \
		--warmup-ms "$WARMUP_MS" --window-ms "$WINDOW_MS" \
		--out "$run_dir/records.json"

	kill -TERM "$pid"
	wait "$pid" || true

	bun "$HARNESS/summarize.ts" "$run_dir/records.json" "pair$pair $side" \
		| tee "$run_dir/summary.txt"
}

for ((p = 1; p <= PAIRS; p++)); do
	# Alternate every pair: base first, then final.
	run_one "$p" base "$BASE"
	run_one "$p" final "$FINAL"
done
echo "ALL_PAIRS_DONE pairs=$PAIRS"
