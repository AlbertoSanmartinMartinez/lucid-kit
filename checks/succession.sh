#!/bin/bash
# An agent changes its key, every step a command of its own: one that named a recovery key is handed over with
# that key and not with its own, one that acts for a controller is handed over by the controller, on a machine
# that never asks the hub anything, and one that named nobody hands itself over, unless it was retired first.
# What the first owned is its successor's - a private topic too, with a new group -, whoever writes to it is
# told who stands for it now, and the hub says the same after it is stopped and started.
#
# Usage: succession.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
workdir
HUB="$(url 87)"
cli() { node "$REPO/bin/agenthub.mjs" "$@" 2>&1; } # a command that is nobody's agent: a key kept apart signs with it
start_hub "$REPO" hub "$(port 87)"
DID=$(did_of "$HUB")

# alice names a recovery key, made in a file of its own, and owns a topic that bob reads.
as "$REPO" alice "$HUB" init --name alice > /dev/null
as "$REPO" bob "$HUB" init --name bob > /dev/null
ALICE=$(as "$REPO" alice "$HUB" whoami)
GUARDIAN=$(cli guardian init --guardian "$X/recovery.json" | field guardian)
has "a recovery key is a key of its own" "$GUARDIAN" "did:key:"
hasnot "and not the agent's" "$GUARDIAN" "$ALICE"
OUT=$(as "$REPO" alice "$HUB" guardian name "$GUARDIAN")
has "naming a guardian asks to be confirmed: it cannot be changed" "$OUT" "Repeat with --yes"
OUT=$(as "$REPO" alice "$HUB" guardian name "$GUARDIAN" --yes)
has "alice names its guardian" "$OUT" "\"guardian\": \"$GUARDIAN\""
OTHER=$(cli guardian init --guardian "$X/other.json" | field guardian)
OUT=$(as "$REPO" alice "$HUB" guardian name "$OTHER" --yes)
has "and cannot name another afterwards" "$OUT" "[guardian_named]"
as "$REPO" alice "$HUB" topic create check.news --description "what alice tells" --schema "$SCHEMA" > /dev/null
as "$REPO" bob "$HUB" subscribe check.news > /dev/null
BOB=$(as "$REPO" bob "$HUB" whoami)
as "$REPO" alice "$HUB" topic create check.secret --description "what alice tells bob" --schema "$SCHEMA" --private --members "$BOB" > /dev/null
as "$REPO" bob "$HUB" subscribe check.secret > /dev/null
as "$REPO" alice "$HUB" publish check.secret --type news --data '{"text":"for bob alone"}' > /dev/null
has "bob reads the private topic of alice" "$(as "$REPO" bob "$HUB" inbox)" "for bob alone"

# The key of alice leaks. Whoever took it registers an agent and tries to make it alice's successor.
as "$REPO" mallory "$HUB" init --name alice > /dev/null
MALLORY=$(as "$REPO" mallory "$HUB" whoami)
OUT=$(as "$REPO" alice "$HUB" succession sign "$ALICE" "$MALLORY" --out "$X/stolen.json")
has "the key of alice signs what it is told to" "$OUT" "\"signed_by\": \"$ALICE\""
OUT=$(as "$REPO" mallory "$HUB" succession take "$ALICE" "$X/stolen.json")
has "but the hub does not hand over with it an agent that named a guardian" "$OUT" "[not_the_guardian]"
has "alice is still alice" "$(as "$REPO" bob "$HUB" succession of "$ALICE")" "\"stands_for_it\": \"$ALICE\""

# Its owner makes a new agent and hands alice over to it with the recovery key.
as "$REPO" alice2 "$HUB" init --name alice > /dev/null
ALICE2=$(as "$REPO" alice2 "$HUB" whoami)
OUT=$(cli --hub "$HUB" succession sign "$ALICE" "$ALICE2" --guardian "$X/recovery.json" --out "$X/succession.json")
has "the recovery key signs that alice is handed over" "$OUT" "\"signed_by\": \"$GUARDIAN\""
OUT=$(as "$REPO" mallory "$HUB" succession take "$ALICE" "$X/succession.json")
has "what it signed is for the successor it names, and nobody else" "$OUT" "[invalid_statement]"
OUT=$(as "$REPO" alice2 "$HUB" succession take "$ALICE" "$X/succession.json")
has "the new agent takes over from alice" "$OUT" "\"took_over_from\": \"$ALICE\""
has "and gives the private topic that came with it a new group" "$(tr -d ' \n' <<< "$OUT")" '"reopened":["check.secret"]'

says_the_same() { # says_the_same WHEN: what anybody is told about alice and what was hers
  has "$1, whoever looks alice up is told who stands for it" "$(as "$REPO" bob "$HUB" succession of "$ALICE")" "\"stands_for_it\": \"$ALICE2\""
  local shown
  shown=$(as "$REPO" bob "$HUB" agent show "$ALICE")
  has "$1, the first agent is retired" "$shown" '"status": "revoked"'
  has "$1, and says who took over" "$shown" "\"succeeded_by\": \"$ALICE2\""
  has "$1, the topic of alice is its successor's" "$(as "$REPO" bob "$HUB" topic show check.news)" "\"owner\": \"$ALICE2\""
  has "$1, whoever writes to alice is told to write to its successor" "$(as "$REPO" bob "$HUB" send "$ALICE" --type hello --data '{"text":"are you there"}')" "[recipient_succeeded] {\"successor\":\"$ALICE2\"}"
}
says_the_same "handed over"
OUT=$(as "$REPO" alice2 "$HUB" publish check.news --type news --data '{"text":"the same agent, another key"}')
hasnot "the successor publishes on the topic it now owns" "$OUT" "error:"
has "and who read alice reads its successor" "$(as "$REPO" bob "$HUB" inbox)" "the same agent, another key"
OUT=$(as "$REPO" alice "$HUB" publish check.news --type news --data '{"text":"with the key that leaked"}')
has "the key that leaked does nothing more here" "$OUT" "[agent_revoked]"
as "$REPO" alice2 "$HUB" publish check.secret --type news --data '{"text":"for bob, from the new key"}' > /dev/null
OUT=$(as "$REPO" bob "$HUB" inbox)
has "bob reads the private topic from the successor" "$OUT" "for bob, from the new key"
has "over MLS, in the group the successor made" "$OUT" "$MLS"
has "whose members are bob and the successor" "$(as "$REPO" bob "$HUB" topic members check.secret)" "$ALICE2"
hasnot "and not the first agent" "$(as "$REPO" bob "$HUB" topic members check.secret)" "$ALICE\""
as "$REPO" alice3 "$HUB" init --name alice > /dev/null
ALICE3=$(as "$REPO" alice3 "$HUB" whoami)
cli --hub "$HUB" succession sign "$ALICE" "$ALICE3" --guardian "$X/recovery.json" --out "$X/again.json" > /dev/null
OUT=$(as "$REPO" alice3 "$HUB" succession take "$ALICE" "$X/again.json")
has "an agent is handed over once" "$OUT" "[already_succeeded]"

stop_hub hub
start_hub "$REPO" hub "$(port 87)"
says_the_same "after the hub is stopped and started"
has "and the log of the hub holds, with the guardian and the handing over in it" "$(as "$REPO" bob "$HUB" log audit)" '"holds": true'

# An agent that acts for a controller is guarded by it without saying so. The controller signs where its key
# is kept, which need not reach the hub: it is told the DID of the hub.
CONTROLLER=$(cli controller init --controller "$X/controller.json" | field controller)
WORKER=$(as "$REPO" worker "$HUB" whoami)
cli controller delegate "$WORKER" --controller "$X/controller.json" --out "$X/delegation.json" > /dev/null
OUT=$(as "$REPO" worker "$HUB" init --name worker --delegation "$X/delegation.json")
has "an agent registers for its controller" "$OUT" "\"did\": \"$CONTROLLER\""
has "and the controller is its guardian" "$(as "$REPO" bob "$HUB" agent show "$WORKER")" "\"guardian\": \"$CONTROLLER\""
WORKER2=$(as "$REPO" worker2 "$HUB" whoami)
cli controller delegate "$WORKER2" --controller "$X/controller.json" --out "$X/delegation2.json" > /dev/null
as "$REPO" worker2 "$HUB" init --name worker --delegation "$X/delegation2.json" > /dev/null
OUT=$(cli --hub http://127.0.0.1:1 succession sign "$WORKER" "$WORKER2" --guardian "$X/controller.json" --hub-did "$DID" --out "$X/worker.json")
has "the controller signs the handing over without asking the hub anything" "$OUT" "\"signed_by\": \"$CONTROLLER\""
OUT=$(as "$REPO" worker2 "$HUB" succession take "$WORKER" "$X/worker.json")
has "and the agent it delegated anew takes over" "$OUT" "\"took_over_from\": \"$WORKER\""

# An agent that named nobody is handed over with its own key.
as "$REPO" carol "$HUB" init --name carol > /dev/null
as "$REPO" carol2 "$HUB" init --name carol > /dev/null
CAROL=$(as "$REPO" carol "$HUB" whoami)
CAROL2=$(as "$REPO" carol2 "$HUB" whoami)
cli --hub "$HUB" succession sign "$CAROL" "$CAROL2" --guardian "$X/other.json" --out "$X/not-hers.json" > /dev/null
OUT=$(as "$REPO" carol2 "$HUB" succession take "$CAROL" "$X/not-hers.json")
has "a key the agent never named hands nothing over" "$OUT" "[not_the_guardian]"
as "$REPO" carol "$HUB" succession sign "$CAROL" "$CAROL2" --out "$X/carol.json" > /dev/null
OUT=$(as "$REPO" carol2 "$HUB" succession take "$CAROL" "$X/carol.json")
has "an agent that named no guardian hands itself over" "$OUT" "\"took_over_from\": \"$CAROL\""

# One that named nobody and was retired stays retired: the key that would hand it over may be anybody's.
# (Two agents from before, which are nobody's successor yet: a hub takes few new agents a minute from one address.)
as "$REPO" mallory "$HUB" succession sign "$MALLORY" "$ALICE3" --out "$X/retired.json" > /dev/null
as "$REPO" mallory "$HUB" retire --yes > /dev/null
OUT=$(as "$REPO" alice3 "$HUB" succession take "$MALLORY" "$X/retired.json")
has "an agent that was retired with no guardian is not handed over" "$OUT" "[agent_retired]"
has "the log of the hub holds after all of it" "$(as "$REPO" bob "$HUB" log audit)" '"holds": true'
stop_hub hub
finish
