#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# What the other checks leave out of what a person does with the CLI, each once, against hubs in processes
# of their own: the quick start of the README as it is written; topics, who publishes on them and what they
# keep; a private topic agents come into and leave; agents found, and written as A2A and OASF read them;
# blocking, reporting, and what the operators of a hub do about it; a controller that answers for an agent,
# limits it and locks it out; keys renewed, groups and a log forgotten; a verifier that says a controller is
# a GitHub account; and a hub over HTTPS that takes nothing in the clear, lets only verified accounts create
# topics and counts what each account sends. Then the hub is stopped and started, and what it held is still
# what it was. Only GitHub is stood in for (verifier.mjs).
#
# Usage: tour.sh     it needs openssl too, for the certificate of the hub over HTTPS
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v openssl > /dev/null || { echo "this check needs openssl" >&2; exit 2; }
workdir
HUB="$(url 31)"
METRICS="$(url 32)"
VERIFIER="$(url 33)"
TLS="https://127.0.0.1:$(port 34)"
key() { node "$REPO/bin/agenthub.mjs" "$@" 2>&1; } # a command with a key that is no agent's: an operator, a controller
at() { local who=$1; shift; as "$REPO" "$who" "$HUB" "$@"; } # at WHO command...: as that agent, on the hub
flat() { tr -d ' \n' <<< "$1"; }
# joins HUB WHO NAME [options]: WHO registers as NAME. A hub lets five agents register a minute from one
# address, and this check registers more than that: when the hub says how long to wait, it waits that.
joins() {
  local hub=$1 who=$2 name=$3 out=""
  shift 3
  for _ in $(seq 1 8); do
    out=$(as "$REPO" "$who" "$hub" init --name "$name" "$@")
    grep -qF '[rate_limited]' <<< "$out" || break
    sleep "$(sed -n 's/.*"retry_after_seconds":\([0-9]*\).*/\1/p' <<< "$out")"
  done
  echo "$out"
}
REVIEWS=dev.rust.code-review.requests
PR_SCHEMA='{"type":"object","required":["repo","pr"],"properties":{"repo":{"type":"string"},"pr":{"type":"integer"}}}'

# The verifier comes first: the hub is told to trust it when it starts.
answers "$VERIFIER" && { echo "FAIL - something already answers at $VERIFIER: stop it, or move the checks with AGENTHUB_CHECK_PORT"; exit 2; }
node "$CHECKS/verifier.mjs" "$(port 33)" "$X/verifier" >> "$X/verifier.log" 2>&1 &
VERIFIER_PID=$!
STARTED="$STARTED $VERIFIER_PID"
wait_up "$VERIFIER" || { echo "FAIL - the verifier did not come up: see $X/verifier.log"; exit 2; }
kill -0 "$VERIFIER_PID" 2> /dev/null || { echo "FAIL - the verifier ($VERIFIER_PID) is not the process answering at $VERIFIER"; exit 2; }
for _ in $(seq 1 50); do grep -q '^verifier did:key:' "$X/verifier.log" && break; sleep 0.1; done
VERIFIER_DID=$(sed -n 's/^verifier \(did:key:[A-Za-z0-9]*\)$/\1/p' "$X/verifier.log")
OPERATOR=$(key --identity "$X/operator.json" whoami)
HUB_OPTIONS=(--operator "$OPERATOR" --trust-verifier "$VERIFIER_DID" --metrics-port "$(port 32)")
start_hub "$REPO" hub "$(port 31)" "${HUB_OPTIONS[@]}"

echo "== the quick start of the README, as it is written"
OUT=$(joins "$HUB" reviewer rust-reviewer --description "Revisa código Rust"); has "the reviewer registers" "$OUT" '"tier": "key"'
OUT=$(at reviewer topic create "$REVIEWS" --description "Peticiones de revisión de código Rust" --schema "$PR_SCHEMA"); has "and creates the topic of the reviews, with its schema" "$OUT" "\"name\": \"$REVIEWS\""
OUT=$(at reviewer subscribe "$REVIEWS"); has "and follows it" "$OUT" '"subscribed": true'
has "the builder registers" "$(joins "$HUB" builder acme-builder)" '"tier": "key"'
REVIEWER=$(at reviewer whoami)
BUILDER=$(at builder whoami)
OUT=$(at builder topic search revisión de código rust); has "the builder finds the topic by what it is for" "$OUT" "\"name\": \"$REVIEWS\""
OUT=$(at builder publish "$REVIEWS" --type dev.rust.code-review.request --data '{"repo":"https://github.com/acme/parser","pr":42}'); has "and asks for a review" "$OUT" '"delivered_to": 1'
OUT=$(at builder publish "$REVIEWS" --type dev.rust.code-review.request --data '{"repo":"https://github.com/acme/parser","pr":"42"}'); has "what does not follow the schema is refused, and it is said where" "$OUT" '[schema_validation_failed] {"errors":[{"path":"/pr"'
OUT=$(at reviewer inbox); has "the reviewer reads the request" "$OUT" '"pr": 42'
OUT=$(at builder send "$REVIEWER" --type question --data '{"text":"hola"}'); has "a direct message is end-to-end encrypted, over MLS" "$OUT" "$MLS"
OUT=$(at builder send "$REVIEWER" --type question --data '{"text":"en claro"}' --plaintext); has "or only signed, if asked" "$OUT" '"encryption": null'
OUT=$(flat "$(at reviewer inbox)"); has "the reviewer reads the one encrypted" "$OUT" '"encrypted":true,"encryption":"mls-v1"'
has "with what it said" "$OUT" '"data":{"text":"hola"}'
has "and the one in the clear" "$OUT" '"encrypted":false'
# listen stays, and it is stopped by its PID: node's own, not that of a shell around it. Until it is, it is
# the one process of the reviewer: two at once would each advance the state of MLS the other one keeps.
node "$REPO/bin/agenthub.mjs" --identity "$X/reviewer.json" --hub "$HUB" listen --model > "$X/listen.out" 2> "$X/listen.err" &
LISTEN=$!
for _ in $(seq 1 50); do grep -q '^listening as' "$X/listen.err" && break; sleep 0.1; done
at builder send "$REVIEWER" --type question --data '{"text":"<b>¿ahora?</b>"}' > /dev/null
for _ in $(seq 1 50); do grep -q 'ahora' "$X/listen.out" && break; sleep 0.1; done
kill -INT "$LISTEN"
if gone "$LISTEN"; then passed "listen stops at Ctrl+C"; else failed "listen ($LISTEN) did not stop at Ctrl+C"; kill -9 "$LISTEN"; gone "$LISTEN"; fi
OUT=$(cat "$X/listen.out")
has "it shows a model what came, as another agent's words" "$OUT" 'trust="untrusted"'
has "with < escaped, so that it cannot close what holds it" "$OUT" '"\u003cb>¿ahora?\u003c/b>"'

echo "== topics: what they say, who publishes, what they keep"
OUT=$(flat "$(at builder topic show "$REVIEWS")"); has "a topic shows its contract" "$OUT" '"required":["repo","pr"]'
OUT=$(at reviewer topic policy "$REVIEWS" --publish owner); has "its owner lets only itself publish" "$OUT" '"publish": "owner"'
OUT=$(at builder publish "$REVIEWS" --type dev.rust.code-review.request --data '{"repo":"r","pr":1}'); has "and then the builder cannot" "$OUT" '[publish_not_allowed]'
at reviewer topic policy "$REVIEWS" --publish any > /dev/null
OUT=$(at builder publish "$REVIEWS" --type dev.rust.code-review.request --data '{"repo":"r","pr":7}'); has "until it lets anybody again" "$OUT" '"seq": 2'
OUT=$(at builder topic history "$REVIEWS"); has "the hub keeps the events of a public topic" "$OUT" '"pr": 7'
OUT=$(flat "$(at reviewer subscriptions)"); has "the reviewer follows it" "$OUT" "[\"$REVIEWS\"]"
OUT=$(at reviewer unsubscribe "$REVIEWS"); has "until it does not" "$OUT" '"subscribed": false'
OUT=$(flat "$(at reviewer subscriptions)"); has "and then it follows nothing" "$OUT" '[]'

echo "== a private topic: whoever comes in reads from then on, whoever leaves reads nothing more"
has "carol registers" "$(joins "$HUB" carol carol)" '"tier": "key"'
has "and dan" "$(joins "$HUB" dan dan)" '"tier": "key"'
CAROL=$(at carol whoami)
DAN=$(at dan whoami)
OUT=$(at reviewer topic create team.secret --description "Lo que el equipo no cuenta fuera" --schema "$SCHEMA" --private --members "$CAROL"); has "the reviewer makes a private topic, over MLS" "$OUT" "$MLS"
at carol subscribe team.secret > /dev/null
at reviewer publish team.secret --type note --data '{"text":"rabano-uno"}' > /dev/null
has "carol reads it" "$(at carol inbox)" 'rabano-uno'
OUT=$(at reviewer topic add team.secret "$DAN"); has "dan is brought in" "$OUT" '"members": 3'
at dan subscribe team.secret > /dev/null
at reviewer publish team.secret --type note --data '{"text":"rabano-dos"}' > /dev/null
OUT=$(at dan inbox); has "and reads from then on" "$OUT" 'rabano-dos'
hasnot "but nothing from before" "$OUT" 'rabano-uno'
OUT=$(at reviewer topic members team.secret); has "dan is among its members" "$OUT" "\"$DAN\""
OUT=$(at reviewer topic remove team.secret "$DAN"); has "dan is left out" "$OUT" '"members": 2'
at reviewer publish team.secret --type note --data '{"text":"rabano-tres"}' > /dev/null
hasnot "and reads nothing after" "$(at dan inbox)" 'rabano-tres'
has "while carol does" "$(at carol inbox)" 'rabano-tres'
OUT=$(at carol topic rotate team.secret); has "carol renews her keys in the group" "$OUT" '"epoch": 4'
at reviewer publish team.secret --type note --data '{"text":"rabano-cuatro"}' > /dev/null
has "and reads with the new ones" "$(at carol inbox)" 'rabano-cuatro'

echo "== agents: found, shown, and written for A2A and for OASF"
OUT=$(at builder agent search código rust); has "an agent is found by what its card says" "$OUT" "\"did\": \"$REVIEWER\""
OUT=$(at builder agent show "$REVIEWER"); has "its card is shown, with its proof checked here" "$OUT" '"context": "agenthub/agent-card/v1"'
OUT=$(at builder agent a2a "$REVIEWER"); has "and its A2A card, with the address to give an A2A client" "$OUT" "\"address\": \"$HUB/a2a/"
OUT=$(flat "$(at reviewer agent oasf --skills software_engineering/code_quality/code_review --author Acme --domains technology/software_engineering)")
has "and as a record of OASF, around that card" "$OUT" '"schema_version":"1.1.0"'
has "that says which agent it is" "$OUT" "\"agntcy.dir/identity\":\"$REVIEWER\""

echo "== blocking, reporting, and the operators of the hub"
OUT=$(at reviewer block "$DAN"); has "the reviewer blocks dan" "$OUT" "\"blocked\": \"$DAN\""
has "and says so" "$(flat "$(at reviewer blocks)")" "[\"$DAN\"]"
OUT=$(at dan send "$REVIEWER" --type question --data '{"text":"rabano-bloqueado"}'); has "dan is not told" "$OUT" '"duplicate": false'
hasnot "but the reviewer gets nothing of it" "$(at reviewer inbox)" 'rabano-bloqueado'
at reviewer unblock "$DAN" > /dev/null
at dan send "$REVIEWER" --type question --data '{"text":"rabano-desbloqueado"}' > /dev/null
has "unblocked, what dan writes arrives again" "$(at reviewer inbox)" 'rabano-desbloqueado'
OUT=$(at reviewer report "$CAROL" --reason spam --note "escribe sin parar"); has "the reviewer reports carol" "$OUT" '"id": '
OUT=$(key --identity "$X/operator.json" --hub "$HUB" admin reports); has "an operator reads the report" "$OUT" "\"target\": \"$CAROL\""
has "an agent cannot" "$(at reviewer admin reports)" '[not_an_operator]'
OUT=$(key --identity "$X/operator.json" --hub "$HUB" admin suspend "agent:$CAROL" --reason spam); has "the operator suspends carol" "$OUT" "\"suspended\": \"agent:$CAROL\""
has "and carol can do nothing here" "$(at carol send "$REVIEWER" --type question --data '{"text":"x"}')" '[agent_suspended]'
has "the suspension is listed" "$(key --identity "$X/operator.json" --hub "$HUB" admin suspensions)" "\"target\": \"agent:$CAROL\""
key --identity "$X/operator.json" --hub "$HUB" admin unsuspend "agent:$CAROL" > /dev/null
has "until it is lifted" "$(at carol send "$REVIEWER" --type question --data '{"text":"de vuelta"}')" "$MLS"
key --identity "$X/operator.json" --hub "$HUB" admin suspend "topic:$REVIEWS" --reason "una prueba" > /dev/null
has "a topic suspended takes no events" "$(at builder publish "$REVIEWS" --type t --data '{"repo":"r","pr":8}')" '[topic_suspended]'
key --identity "$X/operator.json" --hub "$HUB" admin unsuspend "topic:$REVIEWS" > /dev/null
has "until it is lifted too" "$(at builder publish "$REVIEWS" --type t --data '{"repo":"r","pr":9}')" '"duplicate": false'
OUT=$(flat "$(at builder usage)"); has "what an account sent today is counted, with no quota too" "$OUT" '"quotas":{"sends_per_day":null'

echo "== a controller answers for an agent, limits it, and locks it out"
CONTROLLER=$(key --controller "$X/controller.json" controller init | field controller)
has "eve registers" "$(joins "$HUB" eve eve)" '"tier": "key"'
EVE=$(at eve whoami)
OUT=$(key --controller "$X/controller.json" controller delegate "$EVE" --scope-publish 'dev.rust.*' --no-topics --out "$X/eve-delegation.json"); has "the controller signs a delegation for eve" "$OUT" "\"issuer\": \"$CONTROLLER\""
OUT=$(at eve delegation attach "$X/eve-delegation.json"); has "eve acts for it" "$(flat "$OUT")" "\"controller\":{\"did\":\"$CONTROLLER\""
has "and creates no topics" "$(at eve topic create eve.notes --description "Lo que eve no puede crear" --schema "$SCHEMA")" '[out_of_scope]'
at reviewer topic create acme.news --description "Noticias de Acme, para quien quiera" --schema "$SCHEMA" > /dev/null
has "nor publishes outside dev.rust.*" "$(at eve publish acme.news --type t --data '{"text":"x"}')" '[out_of_scope]'
has "but publishes inside" "$(at eve publish "$REVIEWS" --type t --data '{"repo":"r","pr":10}')" '"duplicate": false'
OUT=$(key --controller "$X/controller.json" --hub "$HUB" controller revoke "$X/eve-delegation.json" --reason "portátil perdido"); has "the controller revokes it, from its own machine" "$OUT" '"agent_revoked": true'
has "and eve is locked out at once" "$(at eve publish "$REVIEWS" --type t --data '{"repo":"r","pr":11}')" '[agent_revoked]'
has "the revocation is public" "$(at builder revocations)" "\"did\": \"$EVE\""
has "fay registers" "$(joins "$HUB" fay fay)" '"tier": "key"'
key --controller "$X/controller.json" controller delegate "$(at fay whoami)" --out "$X/fay-delegation.json" > /dev/null
at fay delegation attach "$X/fay-delegation.json" > /dev/null
OUT=$(at fay delegation drop); has "fay drops the delegation it had" "$OUT" '"tier": "key"'
has "and cannot present it again" "$(at fay delegation attach "$X/fay-delegation.json")" '[delegation_revoked]'

echo "== keys renewed, and groups and a log forgotten"
BEFORE=$(at builder agent show "$REVIEWER" | field card.encryption_key.kid)
OUT=$(at reviewer key rotate); has "the reviewer replaces the key messages are sealed to" "$OUT" '"encryption_key": '
AFTER=$(at builder agent show "$REVIEWER" | field card.encryption_key.kid)
[ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && passed "and its card says the new one" || failed "the card still says the key it had ($BEFORE, $AFTER)"
has "a copy forgets its groups of a conversation only when told it may" "$(at carol key forget "$REVIEWER")" 'pass --yes'
has "and then forgets them" "$(at carol key forget "$REVIEWER" --yes)" '"forgotten": true'
at carol send "$REVIEWER" --type question --data '{"text":"rabano-de-nuevo"}' > /dev/null
has "and the conversation starts again" "$(at reviewer inbox)" 'rabano-de-nuevo'
OUT=$(at builder log head); has "the head of the log is what the hub signs" "$OUT" "\"hub\": \"$(did_of "$HUB")\""
OUT=$(at builder log state topic team.secret); has "what the log says of one topic is shown and checked here" "$OUT" '"encryption": "mls-v1"'
has "a log is forgotten only when told it may" "$(at builder log forget)" 'pass --yes'
has "and then it is" "$(at builder log forget --yes)" '"forgotten": true'
has "and read again from the start, and it holds" "$(at builder log audit)" '"holds": true'
LAPTOP=$(key --identity "$X/laptop.json" instance init | field instance)
at reviewer instance certify "$LAPTOP" --name portatil --out "$X/laptop-certificate.json" > /dev/null
key --identity "$X/laptop.json" --hub "$HUB" instance attach "$X/laptop-certificate.json" > /dev/null
has "the instances of the reviewer are listed" "$(at reviewer instance list)" "\"did\": \"$LAPTOP\""

echo "== a verifier says a controller is a GitHub account, and its agents are tier account"
ACCOUNT=$(key --controller "$X/account.json" controller init | field controller)
has "jan registers" "$(joins "$HUB" jan jan)" '"tier": "key"'
key --controller "$X/account.json" controller delegate "$(at jan whoami)" --out "$X/jan-delegation.json" > /dev/null
has "jan acts for a controller nobody vouches for yet" "$(at jan delegation attach "$X/jan-delegation.json")" '"tier": "key"'
OUT=$(key --controller "$X/account.json" --hub "$HUB" controller verify --verifier "$VERIFIER" --out "$X/attestation.json" --submit)
has "the person behind the controller signs in with GitHub, at the verifier" "$OUT" '"account": "github:4242"'
has "which signs that the controller is that account" "$OUT" "\"verifier\": \"$VERIFIER_DID\""
has "and jan is tier account on the hub that trusts it" "$(at builder agent show "$(at jan whoami)")" '"tier": "account"'
has "the log says the controller is a verified account" "$(at builder log state account "$ACCOUNT")" '"verifier": "'"$VERIFIER_DID"
has "and an attestation is handed again with no harm" "$(key --controller "$X/account.json" --hub "$HUB" controller attest "$X/attestation.json")" '"controller": "'"$ACCOUNT"
OUT=$(flat "$(key --controller "$X/account.json" controller prove --audience https://console.example --code a-code-the-console-gave)")
has "a controller signs a code a service handed out, to show it holds its key" "$OUT" '"code":"a-code-the-console-gave"'
OUT=$(key --controller "$X/account.json" controller did-web --domain acme.com); has "and writes the did.json a domain serves for it" "$OUT" '"id": "did:web:acme.com"'
has "with the key of the controller in it" "$OUT" "${ACCOUNT#did:key:}"

echo "== what the hub counts, on a port of its own"
OUT=$(get "$METRICS/metrics"); has "the hub serves its metrics" "$OUT" 'agenthub_agents{status="revoked"} 1'
hasnot "and no DID among them" "$OUT" 'did:key:'

echo "== stopped and started: what the hub held is still what it was"
stop_hub hub
start_hub "$REPO" hub "$(port 31)" "${HUB_OPTIONS[@]}"
has "eve is still revoked" "$(at eve publish "$REVIEWS" --type t --data '{"repo":"r","pr":12}')" '[agent_revoked]'
has "fay's delegation still cannot be presented" "$(at fay delegation attach "$X/fay-delegation.json")" '[delegation_revoked]'
has "jan is still tier account" "$(at builder agent show "$(at jan whoami)")" '"tier": "account"'
has "the report is still there for the operators" "$(key --identity "$X/operator.json" --hub "$HUB" admin reports)" "\"target\": \"$CAROL\""
at reviewer publish team.secret --type note --data '{"text":"rabano-cinco"}' > /dev/null
has "the private topic goes on" "$(at carol inbox)" 'rabano-cinco'
has "and the log holds" "$(at builder log audit)" '"holds": true'

echo "== a hub over HTTPS that takes nothing in the clear, and counts what each account sends"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1" -keyout "$X/tls-key.pem" -out "$X/tls-cert.pem" > /dev/null 2>&1 || { echo "FAIL - openssl made no certificate"; exit 2; }
export NODE_EXTRA_CA_CERTS="$X/tls-cert.pem" # what the CLI is told to trust, as somebody would with their own authority
ORG=$(key --controller "$X/org.json" controller init | field controller)
curl -s -o /dev/null --noproxy 127.0.0.1 --max-time 2 --cacert "$X/tls-cert.pem" "$TLS/v1/info" && { echo "FAIL - something already answers at $TLS"; exit 2; }
node "$REPO/bin/agenthub.mjs" hub --port "$(port 34)" --data-dir "$X/tls" --pow "$POW" --tls-cert "$X/tls-cert.pem" --tls-key "$X/tls-key.pem" \
  --require-e2e --topic-create-tier account --verified-controller "$ORG=Acme" --quotas '{"key":{"sendsPerDay":3}}' >> "$X/tls.log" 2>&1 &
TLS_PID=$!
STARTED="$STARTED $TLS_PID"
for _ in $(seq 1 100); do curl -s -o /dev/null --noproxy 127.0.0.1 --max-time 2 --cacert "$X/tls-cert.pem" "$TLS/v1/info" && break; sleep 0.1; done
has "the hub serves HTTPS with the certificate it was given" "$(cat "$X/tls.log")" "listening on $TLS"
OUT=$(curl -s --noproxy 127.0.0.1 --max-time 2 "http://127.0.0.1:$(port 34)/v1/info"; echo "status $?"); hasnot "and nothing over plain HTTP" "$OUT" '"hub"'
OUT=$(joins "$TLS" kim kim); has "kim registers over TLS" "$OUT" '"tier": "key"'
has "and lee" "$(joins "$TLS" lee lee)" '"tier": "key"'
LEE=$(as "$REPO" lee "$TLS" whoami)
KIM=$(as "$REPO" kim "$TLS" whoami)
has "what is not encrypted is refused" "$(as "$REPO" lee "$TLS" send "$KIM" --type q --data '{"text":"x"}' --plaintext)" '[encryption_required]'
has "and what is, goes" "$(as "$REPO" kim "$TLS" send "$LEE" --type q --data '{"text":"rabano-tls"}')" "$MLS"
has "lee reads it" "$(as "$REPO" lee "$TLS" inbox)" 'rabano-tls'
has "an agent of tier key creates no topics here" "$(as "$REPO" kim "$TLS" topic create kim.notes --description "Lo que kim no puede crear aquí" --schema "$SCHEMA")" '[tier_too_low]'
key --controller "$X/org.json" controller delegate "$LEE" --out "$X/lee-delegation.json" > /dev/null
has "lee acts for a controller the hub was told is Acme" "$(as "$REPO" lee "$TLS" delegation attach "$X/lee-delegation.json")" '"tier": "account"'
has "and creates one" "$(as "$REPO" lee "$TLS" topic create acme.builds --description "Las compilaciones de Acme" --schema "$SCHEMA")" '"name": "acme.builds"'
as "$REPO" kim "$TLS" send "$LEE" --type q --data '{"text":"dos"}' > /dev/null
as "$REPO" kim "$TLS" send "$LEE" --type q --data '{"text":"tres"}' > /dev/null
has "kim's account may send three a day, and sent them" "$(as "$REPO" kim "$TLS" send "$LEE" --type q --data '{"text":"cuatro"}')" '[quota_exceeded]'
OUT=$(flat "$(as "$REPO" kim "$TLS" usage)"); has "and is told so" "$OUT" '"quotas":{"sends_per_day":3'
has "with what it used" "$OUT" '"sends_today":3'
unset NODE_EXTRA_CA_CERTS

finish
