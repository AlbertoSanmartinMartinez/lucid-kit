#!/bin/bash
# The MCP server of this working tree, used the way an MCP host uses it: two server processes, each with
# its own identity, driven by the official MCP client against a hub that asks for the proof of work a hub
# asks for by default. The client is this directory's own dependency: install it first with
#   (cd checks/mcp-client && npm ci)
#
# Usage: run.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ -d "$CHECKS/mcp-client/node_modules/@modelcontextprotocol/sdk" ] || { echo "the MCP client is not installed: (cd checks/mcp-client && npm ci)" >&2; exit 2; }
workdir
POW=18
start_hub "$REPO" hub "$(port 41)"
mkdir "$X/ids"
node "$CHECKS/mcp-client/flow.mjs" "$REPO" "$X/ids" "$(url 41)" > "$X/flow.txt" 2>&1
ENDED=$?
cat "$X/flow.txt"
PASSED=$(grep -c '^ok   - ' "$X/flow.txt")
FAILED=$(grep -c '^FAIL - ' "$X/flow.txt")
# A flow that stopped half way failed, whatever the checks it got to say.
[ "$ENDED" != 0 ] && [ "$FAILED" = 0 ] && failed "the flow ended with $ENDED before finishing"
stop_hub hub
finish
