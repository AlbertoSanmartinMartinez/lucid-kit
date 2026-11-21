#!/bin/bash
# An upgrade in place. Two paired hubs and four agents run the code of an earlier version and leave half
# way everything that can be left half way; then the code of this working tree carries on, with the same
# data in each hub and the same state in each agent.
#
# Usage: upgrade.sh [stop|kill] [A|B]
#   stop|kill  how the old hubs end: stopped as an operator would, which leaves a snapshot (stop, if not
#              said), or killed outright, so that the new code has to replay the journal the old code wrote
#   A|B        which hub is the home of the conversation between alice and bob (A if not said)
#
# The earlier version is AGENTHUB_OLD_REV (the last commit of 0.6 if not set). Two things below are what
# 0.6 does and another version may not: see OLD_ACROSS.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
MODE="${1:-stop}"; HOME_HUB="${2:-A}"
case "$MODE" in stop | kill) ;; *) echo "stop or kill, not $MODE" >&2; exit 2 ;; esac
workdir
old_tree
PA=$(port 21); PB=$(port 22); UA=$(url 21); UB=$(url 22)
# What the earlier version does with a direct message to an agent of another hub: 0.6 seals it with HPKE.
OLD_ACROSS="$HPKE"
journal() { wc -l < "$X/$1/journal.jsonl" | tr -d ' '; }
two_keys "$OLD" "$OLD" "$HOME_HUB"

echo "== with the code as it was ($OLD_REV): two hubs, four agents, and what they leave half way"
start_hub "$OLD" a "$PA"; DA=$(did_of "$UA")
start_hub "$OLD" b "$PB" --peer "acme=$UA#$DA"; DB=$(did_of "$UB")
stop_hub a; start_hub "$OLD" a "$PA" --peer "globex=$UB#$DB"
OUT=$(as "$OLD" alice "$UA" init --name alice --description "Reviews Rust pull requests"); has "alice registers on A" "$OUT" '"tier": "key"'
OUT=$(as "$OLD" carol "$UA" init --name carol); has "carol registers on A" "$OUT" '"tier": "key"'
OUT=$(as "$OLD" dave "$UA" init --name dave); has "dave registers on A" "$OUT" '"tier": "key"'
OUT=$(as "$OLD" bob "$UB" init --name bob --description "Builds the engine of Globex"); has "bob registers on B" "$OUT" '"tier": "key"'
AL=$(as "$OLD" alice "$UA" whoami); CA=$(as "$OLD" carol "$UA" whoami); DV=$(as "$OLD" dave "$UA" whoami); BO=$(as "$OLD" bob "$UB" whoami)
OUT=$(as "$OLD" alice "$UA" send "$CA" --type note --data '{"text":"pera-1"}'); has "alice writes to carol over MLS" "$OUT" "$MLS"
OUT=$(as "$OLD" carol "$UA" inbox); has "carol reads it" "$OUT" 'pera-1'
OUT=$(as "$OLD" carol "$UA" send "$AL" --type note --data '{"text":"pera-2"}'); has "carol answers over MLS" "$OUT" "$MLS"
OUT=$(as "$OLD" alice "$UA" inbox); has "alice reads it" "$OUT" 'pera-2'
OUT=$(as "$OLD" alice "$UA" topic create acme.private.plans --description "Plans that only the team reads" --schema "$SCHEMA" --private --members "$CA"); has "alice makes a private topic with carol" "$OUT" 'acme.private.plans'
OUT=$(as "$OLD" carol "$UA" subscribe acme.private.plans); has "carol subscribes" "$OUT" 'acme.private.plans'
OUT=$(as "$OLD" alice "$UA" subscribe acme.private.plans); has "alice subscribes" "$OUT" 'acme.private.plans'
OUT=$(as "$OLD" alice "$UA" publish acme.private.plans --type plan --data '{"text":"pera-3"}'); has "alice publishes on it" "$OUT" '"topic": "acme.private.plans"'
OUT=$(as "$OLD" carol "$UA" inbox); has "carol reads it" "$OUT" 'pera-3'
OUT=$(as "$OLD" alice "$UA" send "$BO@globex" --type note --data '{"text":"pera-4"}'); has "alice writes to bob on the other hub, the way that version does" "$OUT" "$OLD_ACROSS"
OUT=$(as "$OLD" bob "$UB" inbox); has "bob reads it" "$OUT" 'pera-4'
echo "   -- what waits for the new code"
OUT=$(as "$OLD" alice "$UA" key renew "$CA"); has "alice renews her keys in the conversation with carol" "$OUT" '"epoch": 2'
OUT=$(as "$OLD" alice "$UA" send "$CA" --type note --data '{"text":"pera-5"}'); has "and writes to carol, who does not read it yet" "$OUT" "$MLS"
OUT=$(as "$OLD" alice "$UA" send "$DV" --type note --data '{"text":"pera-6"}'); has "alice writes to dave, who has not taken his invitation yet" "$OUT" "$MLS"
OUT=$(as "$OLD" carol "$UA" publish acme.private.plans --type plan --data '{"text":"pera-7"}'); has "carol publishes on the topic, and alice does not read it yet" "$OUT" '"topic": "acme.private.plans"'
if [ "$MODE" = kill ]; then
  note "journal lines the old code leaves for the new one to replay: hub A $(journal a), hub B $(journal b)"
  [ "$(journal a)" -gt 0 ] && [ "$(journal b)" -gt 0 ] && passed "there is a journal to replay on each hub" || failed "a hub left no journal"
  crash_hub a; crash_hub b
else
  stop_hub a; stop_hub b
  [ -s "$X/a/snapshot.json" ] && [ -s "$X/b/snapshot.json" ] && passed "each old hub left a snapshot on its way out" || failed "a hub left no snapshot"
fi

echo "== with the code as it is now, on the same data and the same state of each agent"
start_hub "$REPO" a "$PA" --peer "globex=$UB#$DB"; start_hub "$REPO" b "$PB" --peer "acme=$UA#$DA"
OUT=$(as "$REPO" carol "$UA" inbox); has "carol reads what was waiting for her, following the renewal" "$OUT" 'pera-5'
OUT=$(as "$REPO" dave "$UA" inbox); has "dave takes the invitation that was waiting and reads" "$OUT" 'pera-6'
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads what carol published" "$OUT" 'pera-7'
OUT=$(as "$REPO" carol "$UA" send "$AL" --type note --data '{"text":"pera-8"}'); has "carol writes over MLS" "$OUT" "$MLS"; hasnot "and nobody takes the group they had for a hub going back" "$OUT" 'rollback'
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads it" "$OUT" 'pera-8'
OUT=$(as "$REPO" alice "$UA" send "$CA" --type note --data '{"text":"pera-9"}'); has "alice writes over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" carol "$UA" inbox); has "carol reads it" "$OUT" 'pera-9'
OUT=$(as "$REPO" carol "$UA" key renew "$AL"); has "carol renews her keys" "$OUT" '"epoch": 3'
OUT=$(as "$REPO" carol "$UA" send "$AL" --type note --data '{"text":"pera-10"}'); has "and writes" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice follows and reads" "$OUT" 'pera-10'
OUT=$(as "$REPO" dave "$UA" send "$AL" --type note --data '{"text":"pera-11"}'); has "dave answers alice over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads it" "$OUT" 'pera-11'
OUT=$(as "$REPO" alice "$UA" publish acme.private.plans --type plan --data '{"text":"pera-12"}'); has "alice publishes on the private topic" "$OUT" '"topic": "acme.private.plans"'
OUT=$(as "$REPO" carol "$UA" inbox); has "carol reads it" "$OUT" 'pera-12'
OUT=$(as "$REPO" carol "$UA" publish acme.private.plans --type plan --data '{"text":"pera-13"}'); has "carol publishes on it" "$OUT" '"topic": "acme.private.plans"'
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads it" "$OUT" 'pera-13'
OUT=$(as "$REPO" alice "$UA" send "$BO@globex" --type note --data '{"text":"pera-14"}'); has "alice writes to bob on the other hub: over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" bob "$UB" inbox); has "bob reads it" "$OUT" 'pera-14'; has "as MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" bob "$UB" send "$AL@acme" --type note --data '{"text":"pera-15"}'); has "bob answers over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads it" "$OUT" 'pera-15'
OUT=$(as "$REPO" bob "$UB" key renew "$AL@acme"); has "bob renews his keys in the conversation across" "$OUT" '"epoch": 2'
OUT=$(as "$REPO" bob "$UB" send "$AL@acme" --type note --data '{"text":"pera-16"}'); has "and writes" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice follows across hubs and reads" "$OUT" 'pera-16'
OUT=$(as "$REPO" alice "$UA" key renew "$BO@globex"); has "alice renews hers" "$OUT" '"epoch": 3'
OUT=$(as "$REPO" alice "$UA" send "$BO@globex" --type note --data '{"text":"pera-17"}'); has "and writes" "$OUT" "$MLS"
OUT=$(as "$REPO" bob "$UB" inbox); has "bob follows across hubs and reads" "$OUT" 'pera-17'
OUT=$(as "$REPO" alice "$UA" log audit); has "the log of A holds" "$OUT" '"holds": true'
OUT=$(as "$REPO" bob "$UB" log audit); has "the log of B holds" "$OUT" '"holds": true'

echo "== stopped and started once more"
stop_hub a; stop_hub b
start_hub "$REPO" a "$PA" --peer "globex=$UB#$DB"; start_hub "$REPO" b "$PB" --peer "acme=$UA#$DA"
OUT=$(as "$REPO" alice "$UA" send "$CA" --type note --data '{"text":"pera-18"}'); has "alice writes to carol over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" carol "$UA" inbox); has "carol reads it" "$OUT" 'pera-18'
OUT=$(as "$REPO" bob "$UB" send "$AL@acme" --type note --data '{"text":"pera-19"}'); has "bob writes to alice over MLS" "$OUT" "$MLS"
OUT=$(as "$REPO" alice "$UA" inbox); has "alice reads it" "$OUT" 'pera-19'
stop_hub a; stop_hub b

# What each hub holds in the end, read from the snapshot it wrote on its way out.
holds() {
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const generations = (s.dm_groups ?? []).map(([, kept]) => kept.generation);
    console.log(`conversations ${generations.length} generations ${[...new Set(generations)].join(",") || "none"} copies ${(s.mls_copies ?? []).length}`);' "$X/$1/snapshot.json"
}
HA=$(holds a); HB=$(holds b)
note "hub A holds: $HA"; note "hub B holds: $HB"
if [ "$HOME_HUB" = A ]; then AT_HOME=$HA; AWAY=$HB; else AT_HOME=$HB; AWAY=$HA; fi
has "every conversation of hub A is in the group it had: none was made again" "$HA" 'generations 1 '
if [ "$HOME_HUB" = A ]; then has "hub A, the home, keeps the conversation of alice and bob too" "$HA" 'conversations 3 '; else has "hub B, the home, keeps the conversation of alice and bob" "$HB" 'conversations 1 generations 1 '; fi
has "the hub that is not the home keeps a copy of its commits" "$AWAY" 'copies 1'
has "and the home needs none" "$AT_HOME" 'copies 0'
finish "old hubs: $MODE; home: hub $HOME_HUB"
