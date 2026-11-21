#!/bin/bash
# The A2A cards of the agents of a hub of this working tree, read and verified by the official A2A SDK
# (@a2a-js/sdk): found where an A2A client looks for them, signed in a way its verifier takes, and
# refused by it with a word changed. The SDK is this directory's own dependency: install it first with
#   (cd checks/a2a-client && npm ci)
#
# Usage: run.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ -d "$CHECKS/a2a-client/node_modules/@a2a-js/sdk" ] || { echo "the A2A SDK is not installed: (cd checks/a2a-client && npm ci)" >&2; exit 2; }
workdir
HUB="$(url 81)"
start_hub "$REPO" hub "$(port 81)"

as "$REPO" reviewer "$HUB" init --name rust-reviewer --description "Revisa código Rust: unsafe, rendimiento — 日本語" > /dev/null
as "$REPO" builder "$HUB" init --name builder > /dev/null
REVIEWER=$(as "$REPO" reviewer "$HUB" whoami)
BUILDER=$(as "$REPO" builder "$HUB" whoami)
NOBODY=$(as "$REPO" nobody "$HUB" whoami)
# Skills are said from code: the CLI registers a name and a description.
node --input-type=module -e '
  const { AgentClient, loadOrCreateIdentity } = await import(process.argv[1] + "/src/sdk/index.mjs");
  const client = new AgentClient({ hubUrl: process.argv[3], identity: loadOrCreateIdentity(process.argv[2]) });
  await client.updateCard({ name: "rust-reviewer", description: "Revisa código Rust: unsafe, rendimiento — 日本語", skills: [{ name: "code review", description: "unsafe y rendimiento" }, { name: "benchmarks" }] });
  await client.close();
' "$REPO" "$X/reviewer.json" "$HUB" || failed "the reviewer could not say its skills"

OUT=$(as "$REPO" builder "$HUB" agent a2a "$REVIEWER")
has "the CLI shows the card of another agent, checked, and the address an A2A client is given" "$OUT" "\"address\": \"$HUB/a2a/"
has "the card the CLI shows carries the signature of its agent" "$OUT" '"signatures"'
OUT=$(as "$REPO" builder "$HUB" agent a2a "$NOBODY")
has "the CLI says so when there is no card" "$OUT" "this hub has no A2A card for that agent"

node "$CHECKS/a2a-client/verify.mjs" "$HUB" "$REVIEWER" "$BUILDER" "$NOBODY" > "$X/verify.txt" 2>&1
ENDED=$?
cat "$X/verify.txt"
PASSED=$((PASSED + $(grep -c '^ok   - ' "$X/verify.txt")))
FAILED=$((FAILED + $(grep -c '^FAIL - ' "$X/verify.txt")))
[ "$ENDED" != 0 ] && failed "the verification ended with $ENDED before finishing"
stop_hub hub
finish
