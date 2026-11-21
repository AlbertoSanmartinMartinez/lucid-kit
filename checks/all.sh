#!/bin/bash
# Every check of this directory, one after another, in each of its variants. Several minutes.
# Prints one line per run and ends with 0 only if every one of them ran and passed.
#
# Usage: all.sh
# With AGENTHUB_CHECK_DIR, what each run prints and leaves is kept there (run-1.txt, run-1/, ...).
set -u
CHECKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP="${AGENTHUB_CHECK_DIR:-}"
if [ -n "$KEEP" ]; then
  [ -e "$KEEP" ] && { echo "refusing to reuse $KEEP" >&2; exit 2; }
  mkdir -p "$KEEP" || exit 2
  OUT="$(cd "$KEEP" && pwd)"
else
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/agenthub-checks.XXXXXX")" || exit 2
fi
RUNS=0
FAILED=0
NOT_RUN=0

run() { # run NAME script [arguments]
  local name=$1 file="$OUT/run-$((RUNS + 1)).txt"
  shift
  RUNS=$((RUNS + 1))
  [ -n "$KEEP" ] && export AGENTHUB_CHECK_DIR="$OUT/run-$RUNS"
  if bash "$@" > "$file" 2>&1; then
    echo "ok   - $name: $(grep '^RESULT: ' "$file" | sed 's/^RESULT: //')"
    return
  fi
  FAILED=$((FAILED + 1))
  echo "FAIL - $name: $(grep '^RESULT: ' "$file" | sed 's/^RESULT: //')"
  { grep -A6 '^FAIL - ' "$file" || tail -5 "$file"; } | sed 's/^/       /'
  echo "       all it printed: $file"
}

for home in A B; do run "two hubs, home in $home" "$CHECKS/two-hubs.sh" "$home"; done
# upgrade.sh, mixed-hubs.sh and mixed-clients.sh are not run until the version after 1.0.0: they take the
# earlier version out of the history, and this repository starts at 1.0.0. Then OLD_REV (lib.sh) becomes
# v1.0.0 and what they expect of the earlier version is written again. Until then, AGENTHUB_OLD_TREE runs
# them by hand against the code of 0.6.
run "a backup taken while the hub runs" "$CHECKS/backup.sh"
run "a witness, a hub and its agents" "$CHECKS/witness.sh"
run "an agent that changes its key" "$CHECKS/succession.sh"
run "everything else a person does with the CLI" "$CHECKS/tour.sh"
if [ -d "$CHECKS/mcp-client/node_modules/@modelcontextprotocol/sdk" ]; then
  run "the official MCP client" "$CHECKS/mcp-client/run.sh"
else
  NOT_RUN=$((NOT_RUN + 1))
  echo "NOT RUN - the official MCP client: install it with (cd checks/mcp-client && npm ci)"
fi
if [ -d "$CHECKS/a2a-client/node_modules/@a2a-js/sdk" ]; then
  run "the official A2A SDK" "$CHECKS/a2a-client/run.sh"
else
  NOT_RUN=$((NOT_RUN + 1))
  echo "NOT RUN - the official A2A SDK: install it with (cd checks/a2a-client && npm ci)"
fi

# What the runs printed is worth keeping only if one of them failed, or if it was asked for.
[ "$FAILED" = 0 ] && [ -z "$KEEP" ] && rm -rf -- "$OUT"
if [ "$FAILED" = 0 ] && [ "$NOT_RUN" = 0 ]; then
  echo "RESULT: all $RUNS runs passed"
  exit 0
fi
if [ "$FAILED" = 0 ]; then
  echo "RESULT: the $RUNS runs that were run passed, and $NOT_RUN NOT RUN"
else
  echo "RESULT: $FAILED of $RUNS runs FAILED$([ "$NOT_RUN" = 0 ] || echo ", and $NOT_RUN not run")"
fi
exit 1
