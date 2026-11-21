#!/bin/bash
# A hub of one version and the CLI of the other: an earlier version and this working tree. Since requests
# are signed for the address of the hub they go to, neither takes the requests of the other, and each
# has to say so; with the CLI updated, the same agents carry on.
#
# Usage: mixed-clients.sh
# The earlier version is AGENTHUB_OLD_REV (the last commit of 0.6 if not set).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
workdir
old_tree

echo "== a hub of this version, agents on the old CLI"
start_hub "$REPO" d "$(port 62)"; UD=$(url 62)
OUT=$(as "$OLD" gina "$UD" init --name gina); has "the old CLI is turned away, with the code that says why" "$OUT" 'unbound_request'
hasnot "and gina is not registered" "$(as "$REPO" gina "$UD" agent show "$(as "$REPO" gina "$UD" whoami)")" '"name": "gina"'
OUT=$(as "$REPO" gina "$UD" init --name gina); has "with the CLI updated, the same key registers" "$OUT" '"tier": "key"'
OUT=$(as "$REPO" hugo "$UD" init --name hugo); has "and so does another" "$OUT" '"tier": "key"'
HU=$(as "$REPO" hugo "$UD" whoami)
OUT=$(as "$REPO" gina "$UD" send "$HU" --type note --data '{"text":"col-1"}'); has "gina writes over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" hugo "$UD" inbox); has "hugo reads it" "$OUT" 'col-1'
stop_hub d

echo "== an old hub, agents on the new CLI"
start_hub "$OLD" c "$(port 61)"; UC=$(url 61)
OUT=$(as "$REPO" erin "$UC" init --name erin); has "the old hub does not take what the new CLI signs" "$OUT" 'invalid_signature'
OUT=$(as "$OLD" erin "$UC" init --name erin); has "with the CLI of its version, the same key registers" "$OUT" '"tier": "key"'
stop_hub c
finish
