#!/bin/bash
# A copy of the data of a hub made while it runs, with deploy/self-hosted/backup.sh, and a hub started
# from it on another port: the same key, the same agents, the same topics, a log that holds, and what was
# waiting in an inbox still waiting.
#
# Usage: backup.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
workdir
PA=$(port 71); UA=$(url 71); PB=$(port 72); UB=$(url 72)

echo "== a hub with something in it, copied while it runs"
start_hub "$REPO" a "$PA"; DID=$(did_of "$UA")
OUT=$(as "$REPO" alice "$UA" init --name alice); has "alice registers" "$OUT" '"tier": "key"'
OUT=$(as "$REPO" bob "$UA" init --name bob); has "bob registers" "$OUT" '"tier": "key"'
BO=$(as "$REPO" bob "$UA" whoami)
OUT=$(as "$REPO" alice "$UA" topic create acme.notes --description "Notes of the team" --schema "$SCHEMA"); has "alice makes a topic" "$OUT" 'acme.notes'
OUT=$(as "$REPO" alice "$UA" send "$BO" --type note --data '{"text":"rabano-1"}'); has "alice writes to bob over MLS, who does not read it yet" "$OUT" "$MLS"
BACKUP=$(bash "$REPO/deploy/self-hosted/backup.sh" "$X/a" "$X/backups") && passed "the copy is made: $(ls "$BACKUP" | tr '\n' ' ')" || failed "the copy failed"
[ "$(stat -c %a "$BACKUP" 2> /dev/null || stat -f %Lp "$BACKUP")" = 700 ] && passed "only its owner can read it: it holds the key of the hub" || failed "the copy can be read by others"
OUT=$(as "$REPO" alice "$UA" send "$BO" --type note --data '{"text":"rabano-2"}'); has "after the copy, alice writes again" "$OUT" "$MLS"
stop_hub a

echo "== a hub started from the copy"
cp -r "$BACKUP" "$X/b"
start_hub "$REPO" b "$PB"
[ "$(did_of "$UB")" = "$DID" ] && passed "it is the same hub: the same key" || failed "it has another key"
OUT=$(as "$REPO" bob "$UB" agent show "$(as "$REPO" alice "$UB" whoami)"); has "alice is there" "$OUT" '"name": "alice"'
OUT=$(as "$REPO" bob "$UB" topic show acme.notes); has "and her topic" "$OUT" 'Notes of the team'
OUT=$(as "$REPO" bob "$UB" inbox); has "bob reads what was waiting before the copy" "$OUT" 'rabano-1'; hasnot "and not what came after it" "$OUT" 'rabano-2'
OUT=$(as "$REPO" bob "$UB" log audit); has "the log holds" "$OUT" '"holds": true'
OUT=$(as "$REPO" bob "$UB" send "$(as "$REPO" alice "$UB" whoami)" --type note --data '{"text":"rabano-3"}'); has "bob answers" "$OUT" "$MLS"
stop_hub b
finish
