#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# The files somebody who runs their own hub is given (deploy/self-hosted), used the way the guide says
# (docs/SELF-HOSTING.md): docker compose up, with the name the hub is reached at. Then, from another
# container, agents register and talk through Caddy over TLS, the hub is stopped and started again, and
# what it had is still there. The name is hub.localhost, for which Caddy signs the certificate itself.
#
# Usage: self-hosted.sh
# It needs Docker with Compose. It is not one of the checks all.sh runs: those need no Docker.
# AGENTHUB_BASE_IMAGE, if set, is the Node image the hub is built on instead of the one in the Dockerfile.
# The ports 80 and 443 the guide's file publishes are left unpublished (no-ports.yml, written below): the
# check reaches Caddy over the network of the containers, and a machine where something else holds them
# can run it all the same. That they are published is the one thing of the file it does not try.
set -u
export LC_ALL=C
CHECKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$CHECKS/.." && pwd)"
export COMPOSE_PROJECT_NAME=agenthub-self-hosted-check
export HUB_DOMAIN=hub.localhost
PASSED=0
FAILED=0
passed() { echo "ok   - $1"; PASSED=$((PASSED + 1)); }
failed() { echo "FAIL - $1"; FAILED=$((FAILED + 1)); }
shown() { echo "$1" | tail -n 20 | sed 's/^/       | /'; }
has() { if grep -qF -- "$3" <<< "$2"; then passed "$1"; else failed "$1"; echo "       wanted: $3"; shown "$2"; fi; }

command -v docker > /dev/null && docker compose version > /dev/null 2>&1 || { echo "this check needs Docker with Compose" >&2; exit 2; }
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ] || { echo "containers of an earlier run of this check are still there: docker compose -p $COMPOSE_PROJECT_NAME down -v" >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agenthub-self-hosted.XXXXXX")" || exit 2
chmod 755 "$WORK"
cd "$REPO/deploy/self-hosted" || exit 2
printf 'services:\n  caddy:\n    ports: !reset []\n' > "$WORK/no-ports.yml"
export COMPOSE_FILE="docker-compose.yml:$WORK/no-ports.yml"
finish() {
  docker compose down -v --remove-orphans > /dev/null 2>&1
  docker volume rm "${COMPOSE_PROJECT_NAME}_keys" > /dev/null 2>&1
  rm -rf -- "$WORK"
  echo "RESULT: $PASSED passed, $FAILED failed"
  [ "$FAILED" = 0 ]
  exit
}
trap 'docker compose down -v --remove-orphans > /dev/null 2>&1; docker volume rm "${COMPOSE_PROJECT_NAME}_keys" > /dev/null 2>&1; rm -rf -- "$WORK"' EXIT

echo "== docker compose up, as the guide says"
docker compose build --quiet ${AGENTHUB_BASE_IMAGE:+--build-arg "BASE=$AGENTHUB_BASE_IMAGE"} > "$WORK/build.log" 2>&1 || { failed "the image of the hub is built"; shown "$(cat "$WORK/build.log")"; finish; }
if OUT=$(docker compose up -d --wait --wait-timeout 180 2>&1); then passed "the hub and Caddy come up, and the hub says it is healthy"; else failed "the hub and Caddy come up"; shown "$OUT"; shown "$(docker compose logs --no-color --tail 30 2>&1)"; finish; fi
OUT=$(docker compose logs --no-color hub 2>&1)
has "the hub says which its key is, for whoever pairs another hub with it" "$OUT" 'this hub is did:key:'
has "and listens at the name it was given" "$OUT" 'listening on https://hub.localhost'
DID=$(sed -n 's/.*this hub is \(did:key:[A-Za-z0-9]*\).*/\1/p' <<< "$OUT" | head -n 1)

# Caddy makes its own certificate authority for a name like this one; the client is told to trust it.
for _ in $(seq 1 40); do docker compose exec -T caddy test -s /data/caddy/pki/authorities/local/root.crt 2> /dev/null && break; sleep 0.5; done
docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$WORK/root.crt" 2> /dev/null
chmod 644 "$WORK/root.crt"
CADDY=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q caddy)")
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$(docker compose ps -q hub)")
# as WHO command...: one command of the CLI, from a container that reaches the hub only by its name, through Caddy.
as() {
  local who=$1
  shift
  docker run --rm --user 0:0 --network "${COMPOSE_PROJECT_NAME}_default" --add-host "hub.localhost:$CADDY" \
    -e NODE_EXTRA_CA_CERTS=/ca/root.crt -v "$WORK/root.crt:/ca/root.crt:ro" -v "${COMPOSE_PROJECT_NAME}_keys:/keys" \
    --entrypoint node "$IMAGE" bin/agenthub.mjs --identity "/keys/$who.json" --hub https://hub.localhost "$@" 2>&1
}

echo "== agents, through Caddy, over TLS"
OUT=$(as alice init --name alice); has "alice registers at the public name of the hub" "$OUT" '"tier": "key"'
OUT=$(as bob init --name bob); has "bob registers" "$OUT" '"tier": "key"'
BO=$(as bob whoami)
OUT=$(as alice send "$BO" --type note --data '{"text":"rabano-1"}'); has "alice writes to bob over MLS" "$OUT" '"encryption": "mls-v1"'
OUT=$(as bob log audit); has "the log of the hub holds, and is signed by the key the hub said" "$OUT" "\"hub\": \"$DID\""
OUT=$(docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --add-host "hub.localhost:$CADDY" --entrypoint node "$IMAGE" -e "fetch('http://hub.localhost/healthz', { redirect: 'manual' }).then((res) => console.log(res.status, res.headers.get('location')))" 2>&1)
has "plain HTTP is sent on to HTTPS" "$OUT" 'https://hub.localhost/healthz'

echo "== stopped and started again"
docker compose down > /dev/null 2>&1
if OUT=$(docker compose up -d --wait --wait-timeout 180 2>&1); then passed "it comes up again"; else failed "it comes up again"; shown "$OUT"; finish; fi
CADDY=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q caddy)")
has "it is the same hub: its key was in the volume" "$(docker compose logs --no-color hub 2>&1)" "this hub is $DID"
OUT=$(as bob inbox); has "and what was waiting for bob still is" "$OUT" 'rabano-1'
finish
