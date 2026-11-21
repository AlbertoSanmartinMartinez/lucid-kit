#!/bin/bash
# A witness, a hub that shows it its log and agents that ask for it, each a process of its own: the hub's
# checkpoint comes back cosigned, an agent that trusts the witness works and one that trusts a witness the
# hub does not have is refused, what the log says of one agent is shown and checked with none of the log
# read, the witness remembers what it cosigned when it is stopped and started, and a hub that comes back
# with less than it had is not cosigned again.
#
# Usage: witness.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
workdir
HUB="$(url 85)"
WITNESS="$(url 86)"

# start_witness HUB_DID: the witness of this tree, with its data in $X/witness, watching the log of that hub.
start_witness() {
  if curl -s -o /dev/null --noproxy 127.0.0.1 --max-time 2 "$WITNESS/healthz"; then
    echo "FAIL - something already answers at $WITNESS: stop it, or move the checks with AGENTHUB_CHECK_PORT"
    exit 2
  fi
  node "$REPO/bin/agenthub.mjs" witness --log "$1" --name witness.example/check --port "$(port 86)" --data-dir "$X/witness" >> "$X/witness.log" 2>&1 &
  WITNESS_PID=$!
  STARTED="$STARTED $WITNESS_PID"
  for _ in $(seq 1 100); do curl -s -o /dev/null --noproxy 127.0.0.1 --max-time 2 "$WITNESS/healthz" && break; sleep 0.1; done
  kill -0 "$WITNESS_PID" 2> /dev/null || { echo "FAIL - the witness did not come up: see $X/witness.log"; exit 2; }
}
stop_witness() {
  kill "$WITNESS_PID"
  gone "$WITNESS_PID" || failed "the witness ($WITNESS_PID) did not stop"
}
# The hub shows its log to its witnesses as it starts: a moment later, what they cosigned is there.
cosigned_soon() { # cosigned_soon WHAT SIZE: the note of the hub is of that many entries, with the witness's line
  local out=""
  for _ in $(seq 1 50); do
    out=$(get "$HUB/v1/log/note")
    [ "$(sed -n 2p <<< "$out")" = "$2" ] && grep -q '^— witness.example/check ' <<< "$out" && break
    sleep 0.1
  done
  if [ "$(sed -n 2p <<< "$out")" = "$2" ] && grep -q '^— witness.example/check ' <<< "$out"; then passed "$1"; else failed "$1"; echo "       wanted $2 entries, cosigned"; shown "$out"; fi
}

# The log of a hub is named by its key, so the hub comes up once to say which it is.
start_hub "$REPO" hub "$(port 85)"
DID=$(did_of "$HUB")
stop_hub hub

start_witness "$DID"
KEY=$(get "$WITNESS/v1/info" | field verifier)
has "the witness says the key it cosigns with, under the name it was given" "$KEY" "witness.example/check+"
has "and which logs it watches" "$(get "$WITNESS/v1/info")" "$DID"

start_hub "$REPO" hub "$(port 85)" --witness "$KEY@$WITNESS"
has "the hub says who watches its log" "$(get "$HUB/v1/info" | field log.witnesses)" "$KEY"
OUT=$(as "$REPO" alice "$HUB" --trust-witness "$KEY" init --name alice)
has "an agent that asks for the witness registers" "$OUT" '"name": "alice"'
OUT=$(AGENTHUB_WITNESSES="$KEY" as "$REPO" bob "$HUB" init --name bob)
has "and so does one told its witnesses by the environment" "$OUT" '"name": "bob"'
ALICE=$(as "$REPO" alice "$HUB" whoami)
OUT=$(AGENTHUB_WITNESSES="$KEY" as "$REPO" bob "$HUB" agent show "$ALICE")
has "what the hub shows one of the other is held to the log the witness cosigned" "$OUT" '"name": "alice"'

# What the log says of one agent, shown by the hub with a proof and checked by a client that reads none of the
# log: against what the hub signs, or against what the witness cosigned, which is the log of a moment ago
# until the hub shows it to the witness again (every fifteen seconds).
OUT=$(as "$REPO" alice "$HUB" log state agent "$ALICE")
has "what the log says of one agent is shown, and checked without reading the log" "$OUT" '"status": "active"'
has "by a client that asks for no witness, against what the hub signs for its log now" "$OUT" '"witnessed": false'
has "what the log has nothing for is shown too" "$(as "$REPO" alice "$HUB" log state topic nothing.here)" '"on_record": null'
NOW=$(get "$HUB/v1/info" | field log.entries)
for _ in $(seq 1 250); do [ "$(get "$HUB/v1/log/note" | sed -n 2p)" -ge "$NOW" ] && break; sleep 0.1; done
OUT=$(as "$REPO" bob "$HUB" --trust-witness "$KEY" log state agent "$ALICE")
has "by one that asks for the witness, against the log the witness cosigned" "$OUT" '"witnessed": true'
has "which says the same of alice" "$OUT" '"status": "active"'

OUT=$(as "$REPO" carol "$HUB" --trust-witness "$KEY" --witness-quorum 2 whoami)
has "more witnesses asked for than given is said, not guessed" "$OUT" "quorum"

# A witness nobody runs for this hub, made up here: an agent that asks for it gets nothing from the hub.
OTHER=$(node --input-type=module -e '
  const { generateKeyPairSync } = await import("node:crypto");
  const { formatVerifier, NOTE_COSIGNATURE, publicKeyBytes } = await import(process.argv[1] + "/src/core/note.mjs");
  console.log(formatVerifier({ name: "witness.example/other", type: NOTE_COSIGNATURE, key: publicKeyBytes(generateKeyPairSync("ed25519").publicKey) }));' "$REPO")
OUT=$(as "$REPO" dave "$HUB" --trust-witness "$OTHER" init --name dave)
has "an agent that asks for a witness the hub does not have is refused" "$OUT" "0 of the witnesses this client trusts cosigned the log of the hub lately"
hasnot "and is not registered on the way" "$(as "$REPO" alice "$HUB" agent search dave)" '"name": "dave"'
has "nor is it shown what the log says of an agent" "$(as "$REPO" dave "$HUB" --trust-witness "$OTHER" log state agent "$ALICE")" "0 of the witnesses this client trusts cosigned the log of the hub lately"

# Stopped and started, the witness is the same witness and remembers the log: the hub, stopped and started
# too, shows it what it has now, and gets it cosigned from where the witness was.
SIZE=$(get "$HUB/v1/info" | field log.entries)
stop_hub hub
stop_witness
start_witness "$DID"
has "the witness has the same key after it is stopped and started" "$(get "$WITNESS/v1/info" | field verifier)" "$KEY"
start_hub "$REPO" hub "$(port 85)" --witness "$KEY@$WITNESS"
cosigned_soon "and cosigns the log as it is now, from what it remembered" "$SIZE"
has "what it keeps is the size it cosigned" "$(cat "$X/witness/witness-state.json")" "\"size\": $SIZE"

# The hub comes back with less than it had: the same key, and a log that starts over.
stop_hub hub
mkdir "$X/back"
cp "$X/hub/hub-identity.json" "$X/back/"
start_hub "$REPO" back "$(port 85)" --witness "$KEY@$WITNESS"
has "it is the same hub by its key" "$(did_of "$HUB")" "$DID"
for _ in $(seq 1 50); do grep -q "did not cosign" "$X/back.log" && break; sleep 0.1; done
has "the witness does not cosign a log that went back, and the hub says why" "$(cat "$X/back.log")" "a log that went back is not cosigned"
has "the hub has nothing cosigned to show" "$(get "$HUB/v1/log/note")" "not_witnessed"
OUT=$(as "$REPO" erin "$HUB" --trust-witness "$KEY" init --name erin)
has "and an agent that asks for the witness takes nothing from it" "$OUT" "no checkpoint of its log that a witness has cosigned"
OUT=$(as "$REPO" frank "$HUB" init --name frank)
has "one that asks for no witness is none the wiser" "$OUT" '"name": "frank"'
stop_hub back
stop_witness
finish
