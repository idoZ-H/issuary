#!/usr/bin/env bash
# Signal-safe launcher for `wrangler dev`.
#
# Why this exists: `wrangler dev` spawns `workerd` child processes. If wrangler
# dies ungracefully (terminal/SSH window closed -> SIGHUP, or a crash), those
# workerd children get orphaned to PID 1 and leak, eating gigabytes of RAM.
#
# This wrapper traps the signals that normally cause the leak and sweeps any
# leftover workerd belonging to THIS project on exit. wrangler stays attached to
# your terminal, so its interactive hotkeys still work.
#
# Use:  npm run dev   (package.json points here)
set -uo pipefail
cd "$(dirname "$0")"

WORKERD="$PWD/node_modules/@cloudflare/workerd-linux-64/bin/workerd"

cleanup() {
  trap - INT TERM HUP EXIT
  # Sweep any workerd from this project that wrangler didn't reap.
  pkill -f "$WORKERD" 2>/dev/null || true
}
trap cleanup INT TERM HUP EXIT

# Run the real dev server in the foreground (keeps wrangler's interactive keys).
npm run dev:raw
