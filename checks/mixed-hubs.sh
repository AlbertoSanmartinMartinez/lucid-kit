#!/bin/bash
# Two paired hubs, one running an earlier version and one running this working tree, each agent with the
# CLI of its hub's version; then the old hub is upgraded on its own data and the two have to work together.
#
# Usage: mixed-hubs.sh [new-old|old-new] [A|B]
#   new-old|old-new  which version hub A and hub B start with (new-old if not said)
#   A|B              which hub is the home of the conversation between alice and bob (A if not said)
#
# The earlier version is AGENTHUB_OLD_REV (the last commit of 0.6 if not set). Since requests are signed
# for the address of the hub they go to, a hub of before and one of now do not take each other's requests:
# what is checked before the upgrade is that they say so and that nothing crosses, and after it, that
# everything does.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ORDER="${1:-new-old}"; HOME_HUB="${2:-A}"
workdir
old_tree
case "$ORDER" in
  new-old) TA="$REPO"; TB="$OLD"; NEW_HUB=a; NEW_PEER=globex; NEW_PEER_PORT=$(port 52) ;;
  old-new) TA="$OLD"; TB="$REPO"; NEW_HUB=b; NEW_PEER=acme; NEW_PEER_PORT=$(port 51) ;;
  *) echo "new-old or old-new, not $ORDER" >&2; exit 2 ;;
esac
PA=$(port 51); PB=$(port 52); UA=$(url 51); UB=$(url 52)
two_keys "$TA" "$TB" "$HOME_HUB"

echo "== two paired hubs, one of each version ($ORDER)"
start_hub "$TA" a "$PA"; DA=$(did_of "$UA")
start_hub "$TB" b "$PB" --peer "acme=$UA#$DA"; DB=$(did_of "$UB")
stop_hub a; start_hub "$TA" a "$PA" --peer "globex=$UB#$DB"
LINE="peer \"$NEW_PEER\" (http://127.0.0.1:$NEW_PEER_PORT): mismatch - it does not take the signed requests of this hub"
for _ in $(seq 1 50); do grep -qF "$LINE" "$X/$NEW_HUB.log" && break; sleep 0.1; done
has "the hub of this version says the other does not take its requests, and why" "$(cat "$X/$NEW_HUB.log")" "$LINE"
OUT=$(as "$TA" alice "$UA" init --name alice --description "Reviews Rust pull requests"); has "alice registers on A" "$OUT" '"tier": "key"'
OUT=$(as "$TB" bob "$UB" init --name bob --description "Builds the engine of Globex"); has "bob registers on B" "$OUT" '"tier": "key"'
AL=$(as "$TA" alice "$UA" whoami); BO=$(as "$TB" bob "$UB" whoami)
OUT=$(as "$TA" alice "$UA" agent search "builds the engine"); hasnot "alice does not find bob through her hub" "$OUT" "$BO"
OUT=$(as "$TA" alice "$UA" send "$BO@globex" --type note --data '{"text":"nabo-0"}'); has "and what she writes to him does not get there" "$OUT" 'error'
OUT=$(as "$TB" bob "$UB" inbox); hasnot "bob has nothing" "$OUT" 'nabo-0'

echo "== the old hub is upgraded: the same data, the same agents, the code of this tree"
if [ "$ORDER" = new-old ]; then
  stop_hub b; start_hub "$REPO" b "$PB" --peer "acme=$UA#$DA"; says_paired b acme "$PA"
else
  stop_hub a; start_hub "$REPO" a "$PA" --peer "globex=$UB#$DB"; says_paired a globex "$PB"
fi
OUT=$(as "$REPO" alice "$UA" agent search "builds the engine"); has "alice finds bob through her hub" "$OUT" "$BO@globex"
OUT=$(as "$REPO" bob "$UB" agent search "reviews rust pull requests"); has "bob finds alice through his" "$OUT" "$AL@acme"
OUT=$(as "$REPO" alice "$UA" send "$BO@globex" --type note --data '{"text":"nabo-1"}'); has "alice writes to bob over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" bob "$UB" inbox); has "bob reads it" "$OUT" 'nabo-1'; has "as MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" bob "$UB" send "$AL@acme" --type note --data '{"text":"nabo-2"}'); has "bob answers over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads it" "$OUT" 'nabo-2'
OUT=$(as "$REPO" bob "$UB" key renew "$AL@acme"); has "bob renews his keys" "$OUT" '"epoch": 2'
OUT=$(as "$REPO" bob "$UB" send "$AL@acme" --type note --data '{"text":"nabo-3"}'); has "and writes" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice follows and reads" "$OUT" 'nabo-3'
OUT=$(as "$REPO" bob "$UB" topic create globex.news --description "News about the engine of Globex" --schema "$SCHEMA"); has "bob makes a public topic on B" "$OUT" 'globex.news'
OUT=$(as "$REPO" alice "$UA" topic search "news about the engine"); has "alice finds it through her hub" "$OUT" 'globex.news@globex'
OUT=$(as "$REPO" alice "$UA" subscribe globex.news@globex); has "alice follows it" "$OUT" 'globex.news@globex'
OUT=$(as "$REPO" bob "$UB" publish globex.news --type news --data '{"text":"nabo-4"}'); has "bob publishes" "$OUT" 'globex.news'
reads_soon "alice reads it on her hub" 'nabo-4' as "$REPO" alice "$UA" inbox
OUT=$(as "$REPO" bob "$UB" subscribe globex.news); has "bob follows his own topic" "$OUT" 'globex.news'
OUT=$(as "$REPO" alice "$UA" publish globex.news@globex --type news --data '{"text":"nabo-5"}'); has "alice publishes on it from her hub" "$OUT" 'globex.news'
reads_soon "bob reads it" 'nabo-5' as "$REPO" bob "$UB" inbox
OUT=$(as "$REPO" alice "$UA" log audit); has "the log of A holds" "$OUT" '"holds": true'
OUT=$(as "$REPO" bob "$UB" log audit); has "the log of B holds" "$OUT" '"holds": true'
stop_hub a; stop_hub b
finish "hubs: $ORDER; home: hub $HOME_HUB"
