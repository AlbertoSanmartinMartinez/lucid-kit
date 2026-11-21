#!/bin/bash
# Two hubs in two processes, each with its own data, paired by their operators with --peer, and an agent on
# each of them using the CLI: every command is a new process that reads its MLS state from disk.
#
# Usage: two-hubs.sh [A|B]
#   A|B   which hub is the home of the conversation between the two agents (A if not said)
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
HOME_HUB="${1:-A}"
workdir
PA=$(port 1); PB=$(port 2); UA=$(url 1); UB=$(url 2)
alice() { as "$REPO" alice "$UA" "$@"; }
bob() { as "$REPO" bob "$UB" "$@"; }
bob2() { as "$REPO" bob2 "$UB" "$@"; }
two_keys "$REPO" "$REPO" "$HOME_HUB"

echo "== two hubs, paired by their operators"
start_hub "$REPO" a "$PA"; DA=$(did_of "$UA")
start_hub "$REPO" b "$PB" --peer "acme=$UA#$DA"; DB=$(did_of "$UB")
stop_hub a; start_hub "$REPO" a "$PA" --peer "globex=$UB#$DB"
says_paired a globex "$PB"

echo "== one agent on each"
OUT=$(alice init --name alice --description "Reviews Rust pull requests"); has "alice registers on A" "$OUT" '"tier": "key"'
OUT=$(bob init --name bob --description "Builds the engine of Globex"); has "bob registers on B" "$OUT" '"tier": "key"'
AL=$(alice whoami); BO=$(bob whoami)
if [[ "$AL" < "$BO" ]]; then IS=A; else IS=B; fi
[ "$IS" = "$HOME_HUB" ] && passed "the conversation's home is hub $HOME_HUB" || failed "the conversation's home is hub $IS, and hub $HOME_HUB was asked for"

echo "== alice finds bob through her hub and writes to the address it gives"
OUT=$(alice agent search "builds the engine"); has "the search gives bob's address on globex" "$OUT" "\"address\": \"$BO@globex\""
OUT=$(alice send "$BO@globex" --type note --data '{"text":"zanahoria-1"}'); has "alice's message goes over MLS" "$OUT" "$MLS"
OUT=$(bob inbox); has "bob reads it" "$OUT" 'zanahoria-1'; has "as MLS" "$OUT" "$MLS"; has "and can answer to alice@acme" "$OUT" "\"reply_to\": \"$AL@acme\""
OUT=$(bob send "$AL@acme" --type note --data '{"text":"zanahoria-2"}'); has "bob answers over MLS" "$OUT" "$MLS"
OUT=$(alice inbox); has "alice reads it" "$OUT" 'zanahoria-2'; has "as MLS" "$OUT" "$MLS"

echo "== each renews its keys, and they keep talking"
OUT=$(alice key renew "$BO@globex"); has "alice renews her keys" "$OUT" '"epoch": 2'
OUT=$(alice send "$BO@globex" --type note --data '{"text":"zanahoria-3"}'); has "alice writes after it" "$OUT" "$MLS"
OUT=$(bob inbox); has "bob reads it" "$OUT" 'zanahoria-3'
OUT=$(bob key renew "$AL@acme"); has "bob renews his keys" "$OUT" '"epoch": 3'
OUT=$(bob send "$AL@acme" --type note --data '{"text":"zanahoria-4"}'); has "bob writes after it" "$OUT" "$MLS"
OUT=$(alice inbox); has "alice reads it" "$OUT" 'zanahoria-4'

echo "== what needed a renewal to be opened is opened with the other hub stopped"
OUT=$(bob key renew "$AL@acme"); has "bob renews his keys again" "$OUT" '"epoch": 4'
OUT=$(bob send "$AL@acme" --type note --data '{"text":"zanahoria-4b"}'); has "and writes" "$OUT" "$MLS"
OUT=$(alice key renew "$BO@globex"); has "alice renews hers" "$OUT" '"epoch": 5'
OUT=$(alice send "$BO@globex" --type note --data '{"text":"zanahoria-4c"}'); has "and writes" "$OUT" "$MLS"
stop_hub b
OUT=$(alice inbox); has "alice reads what bob wrote, with hub B stopped" "$OUT" 'zanahoria-4b'
start_hub "$REPO" b "$PB" --peer "acme=$UA#$DA"
stop_hub a
OUT=$(bob inbox); has "bob reads what alice wrote, with hub A stopped" "$OUT" 'zanahoria-4c'
start_hub "$REPO" a "$PA" --peer "globex=$UB#$DB"

echo "== both hubs stop and start again from what they keep on disk"
WAS_A=$(cat "$X/a.pid"); WAS_B=$(cat "$X/b.pid")
stop_hub a; stop_hub b
start_hub "$REPO" a "$PA" --peer "globex=$UB#$DB"; start_hub "$REPO" b "$PB" --peer "acme=$UA#$DA"
[ "$WAS_A" != "$(cat "$X/a.pid")" ] && [ "$WAS_B" != "$(cat "$X/b.pid")" ] && passed "they are new processes" || failed "the hubs did not restart"
OUT=$(alice send "$BO@globex" --type note --data '{"text":"zanahoria-5"}'); has "alice writes over MLS, in the same conversation" "$OUT" "$MLS"
OUT=$(bob inbox); has "bob reads it" "$OUT" 'zanahoria-5'; has "as MLS" "$OUT" "$MLS"
OUT=$(bob send "$AL@acme" --type note --data '{"text":"zanahoria-6"}'); has "bob answers over MLS" "$OUT" "$MLS"
OUT=$(alice inbox); has "alice reads it" "$OUT" 'zanahoria-6'

echo "== bob runs a second copy: the conversation moves to a group that has it"
I2=$(bob2 instance init | grep -o 'did:key:[A-Za-z0-9]*' | head -1)
OUT=$(bob instance certify "$I2" --name laptop --out "$X/cert.json"); has "bob certifies the copy" "$OUT" "$I2"
OUT=$(bob2 instance attach "$X/cert.json"); has "the copy registers on B" "$OUT" "$I2"
OUT=$(alice send "$BO@globex" --type note --data '{"text":"zanahoria-7"}'); has "alice writes over MLS" "$OUT" "$MLS"
OUT=$(bob inbox); has "bob reads it" "$OUT" 'zanahoria-7'
OUT=$(bob2 inbox); has "and so does his second copy" "$OUT" 'zanahoria-7'; has "as MLS" "$OUT" "$MLS"
OUT=$(bob2 send "$AL@acme" --type note --data '{"text":"zanahoria-8"}'); has "the copy answers over MLS" "$OUT" "$MLS"
OUT=$(alice inbox); has "alice reads it" "$OUT" 'zanahoria-8'; has "and sees which copy wrote it" "$OUT" "\"instance\": \"$I2\""
OUT=$(bob instance remove "$I2"); has "bob removes the copy" "$OUT" "$I2"
OUT=$(alice send "$BO@globex" --type note --data '{"text":"zanahoria-9"}'); has "alice writes over MLS" "$OUT" "$MLS"
OUT=$(bob inbox); has "bob reads it" "$OUT" 'zanahoria-9'
OUT=$(bob2 inbox); hasnot "and the removed copy does not" "$OUT" 'zanahoria-9'

echo "== what is left"
OUT=$(alice log audit); has "the log of A holds" "$OUT" '"holds": true'
OUT=$(bob log audit); has "the log of B holds" "$OUT" '"holds": true'
stop_hub a; stop_hub b
OUT=$(grep -rl zanahoria "$X/a" "$X/b" "$X/a.log" "$X/b.log" 2> /dev/null)
[ -z "$OUT" ] && passed "neither hub kept or printed a word of what they said" || failed "plaintext on a hub: $OUT"
NA=$(cat "$X/a/journal.jsonl" "$X/a/snapshot.json" 2> /dev/null | grep -c 'agenthub/dm/v1')
NB=$(cat "$X/b/journal.jsonl" "$X/b/snapshot.json" 2> /dev/null | grep -c 'agenthub/dm/v1')
if [ "$HOME_HUB" = A ]; then AT_HOME=$NA; else AT_HOME=$NB; fi
[ "$AT_HOME" -gt 0 ] && passed "the home keeps the conversation's group (records that mention it: hub A $NA, hub B $NB)" || failed "the home did not keep the group (hub A $NA, hub B $NB)"
[ -d "$X/alice.json.state" ] && passed "alice keeps her MLS state on disk" || failed "alice kept no state"
finish "home: hub $HOME_HUB"
