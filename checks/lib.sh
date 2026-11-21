# Shared by the checks in this directory. Sourced, not run.
#
# Every check starts real hub processes on this machine and talks to them with the CLI, one process per
# command, the way a person would. The rules they keep:
#   - a hub is stopped by its PID, never by a pattern that could match somebody else's process;
#   - a check refuses to start if something already answers on a port it is about to use, and makes sure
#     that the process it started is the one answering: a hub left behind by an earlier run would make
#     every check talk to the wrong hub and say whatever that one says;
#   - whatever a check started is stopped when it ends, however it ends.
# Do not pipe a check through `head`: the pipe closes, the script dies and its hubs are left running.

set -u
export LC_ALL=C # DIDs are compared here the way the hubs compare them: byte by byte

CHECKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$CHECKS/.." && pwd)"
PORT_BASE="${AGENTHUB_CHECK_PORT:-18800}"
# The last commit of version 0.6, which is what the checks that need an earlier version were written against.
# It is not in this repository, which starts at 1.0.0: until the version after it, those checks are run by
# hand with AGENTHUB_OLD_TREE, and all.sh leaves them out. Then this becomes v1.0.0.
OLD_REV="${AGENTHUB_OLD_REV:-5f03832098df52d4453a5af957bb9ad298799645}"
OLD=""
POW=8 # registering costs a proof of work; these hubs ask for a small one

PASSED=0
FAILED=0
STARTED=""
OWN_TMP=""
X=""

MLS='"encryption": "mls-v1"'
HPKE='"encryption": "hpke-v1"'
SCHEMA='{"type":"object","required":["text"],"properties":{"text":{"type":"string"}}}'

for tool in node curl; do
  command -v "$tool" > /dev/null || { echo "this check needs $tool" >&2; exit 2; }
done

# Where a check keeps the data of its hubs, what they print and the keys of its agents. With
# AGENTHUB_CHECK_DIR it is that directory, which must not exist yet and is left there afterwards. Without,
# a temporary one, removed if every check passes and left for reading if one fails.
workdir() {
  if [ -n "${AGENTHUB_CHECK_DIR:-}" ]; then
    [ -e "$AGENTHUB_CHECK_DIR" ] && { echo "refusing to reuse $AGENTHUB_CHECK_DIR" >&2; exit 2; }
    mkdir -p "$AGENTHUB_CHECK_DIR" || exit 2
    X="$(cd "$AGENTHUB_CHECK_DIR" && pwd)"
  else
    OWN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agenthub-check.XXXXXX")" || exit 2
    X="$OWN_TMP"
  fi
  trap interrupted EXIT
}

url() { echo "http://127.0.0.1:$((PORT_BASE + $1))"; }
port() { echo "$((PORT_BASE + $1))"; }
# The hubs of a check are on this machine: a proxy set in the environment has nothing to do with them.
answers() { curl -s -o /dev/null --noproxy 127.0.0.1 --max-time 2 "$1/v1/info"; }
wait_up() { for _ in $(seq 1 100); do answers "$1" && return 0; sleep 0.1; done; return 1; }
gone() { for _ in $(seq 1 100); do kill -0 "$1" 2> /dev/null || return 0; sleep 0.1; done; return 1; }
did_of() { curl -s --noproxy 127.0.0.1 "$1/v1/info" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).hub.did))'; }
# field PATH: of the JSON it reads, the value at that path (a.b.c).
field() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v)})' "$1"; }
# get URL: what one of the processes of a check answers there.
get() { curl -s --noproxy 127.0.0.1 --max-time 5 "$1"; }

# start_hub TREE NAME PORT [hub options]: the hub of the code in TREE, with its data in $X/NAME.
start_hub() {
  local tree=$1 name=$2 port=$3 at="http://127.0.0.1:$3"
  shift 3
  if answers "$at"; then
    echo "FAIL - something already answers at $at: stop it, or move the checks with AGENTHUB_CHECK_PORT"
    exit 2
  fi
  node "$tree/bin/agenthub.mjs" hub --port "$port" --data-dir "$X/$name" --pow "$POW" "$@" >> "$X/$name.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$X/$name.pid"
  STARTED="$STARTED $pid"
  wait_up "$at" || { echo "FAIL - hub $name did not come up: see $X/$name.log"; exit 2; }
  kill -0 "$pid" 2> /dev/null || { echo "FAIL - hub $name ($pid) is not the process answering at $at"; exit 2; }
}
# The way an operator stops a hub: it writes what it holds to disk on its way out.
stop_hub() {
  local pid
  pid=$(cat "$X/$1.pid")
  kill "$pid"
  gone "$pid" || failed "hub $1 ($pid) did not stop"
}
# The way a machine loses one: nothing is written on the way out, and the next start replays the journal.
crash_hub() {
  local pid
  pid=$(cat "$X/$1.pid")
  kill -9 "$pid"
  gone "$pid" || failed "hub $1 ($pid) did not die"
  wait "$pid" 2> /dev/null
}
stop_all() {
  local pid
  for pid in $STARTED; do kill -0 "$pid" 2> /dev/null && kill "$pid"; done
  for pid in $STARTED; do gone "$pid" || echo "hub $pid is still running" >&2; done
  STARTED=""
}
# A check that ends before finish(): its hubs are stopped, and it says where it left what it had.
interrupted() {
  stop_all
  [ -n "$OWN_TMP" ] && [ -d "$OWN_TMP" ] || return
  # No hub of this check got to run: there is nothing in there worth reading.
  if ! ls "$OWN_TMP"/*.log > /dev/null 2>&1; then rm -rf -- "$OWN_TMP"; return; fi
  echo "the check did not finish; what it left is in $OWN_TMP" >&2
}
# The hub says whether each pairing stands a moment after it starts answering.
says_paired() { # says_paired NAME PEER PEERPORT
  local line="peer \"$2\" (http://127.0.0.1:$3): paired"
  for _ in $(seq 1 50); do grep -qF "$line" "$X/$1.log" && break; sleep 0.1; done
  has "hub $1 says it is paired with $2" "$(cat "$X/$1.log")" "$line"
}

# as TREE WHO HUB command...: one CLI command of the code in TREE, as the agent whose key is $X/WHO.json.
as() {
  local tree=$1 who=$2 hub=$3
  shift 3
  node "$tree/bin/agenthub.mjs" --identity "$X/$who.json" --hub "$hub" "$@" 2>&1
}

passed() { echo "ok   - $1"; PASSED=$((PASSED + 1)); }
failed() { echo "FAIL - $1"; FAILED=$((FAILED + 1)); }
shown() { echo "$1" | head -14 | sed 's/^/       | /'; }
has() { # has WHAT OUTPUT TEXT: the output has that text
  if grep -qF -- "$3" <<< "$2"; then passed "$1"; else failed "$1"; echo "       wanted: $3"; shown "$2"; fi
}
hasnot() { # hasnot WHAT OUTPUT TEXT: the output does not have it
  if grep -qF -- "$3" <<< "$2"; then failed "$1"; echo "       not wanted: $3"; shown "$2"; else passed "$1"; fi
}
note() { echo "     $1"; }
# reads_soon WHAT TEXT command...: what crosses from one hub to another on a stream arrives a moment later,
# so the command is tried again for a few seconds, until its output has the text. Only for commands that read.
reads_soon() {
  local what=$1 text=$2 out=""
  shift 2
  for _ in $(seq 1 25); do
    out=$("$@")
    grep -qF -- "$text" <<< "$out" && break
    sleep 0.2
  done
  has "$what" "$out" "$text"
}

# two_keys TREE_OF_ALICE TREE_OF_BOB HOME: the keys of alice and bob, made so that the conversation between
# them has its home where it is asked. The home is the hub of the agent whose DID comes first, alice is on
# hub A and bob on hub B: for HOME=A alice gets the key that comes first, for HOME=B bob does.
two_keys() {
  local first second
  case "$3" in A | B) ;; *) echo "the home is A or B, not $3" >&2; exit 2 ;; esac
  first=$(as "$1" alice "$(url 0)" whoami)
  second=$(as "$2" bob "$(url 0)" whoami)
  if { [[ "$first" < "$second" ]] && [ "$3" = B ]; } || { [[ "$second" < "$first" ]] && [ "$3" = A ]; }; then
    mv "$X/alice.json" "$X/swap.json" && mv "$X/bob.json" "$X/alice.json" && mv "$X/swap.json" "$X/bob.json"
  fi
}

# old_tree: the code of the earlier version, ready to run. Sets OLD. It is AGENTHUB_OLD_TREE if that is set
# (a directory that holds that code and what it depends on); if not, the code as it was at OLD_REV, taken
# out of this repository into $X/old.
old_tree() {
  if [ -n "${AGENTHUB_OLD_TREE:-}" ]; then
    [ -f "$AGENTHUB_OLD_TREE/bin/agenthub.mjs" ] || { echo "there is no bin/agenthub.mjs in $AGENTHUB_OLD_TREE" >&2; exit 2; }
    OLD="$(cd "$AGENTHUB_OLD_TREE" && pwd)"
    OLD_REV="the code in $OLD"
    return
  fi
  command -v git > /dev/null || { echo "this check needs git, or the earlier version in AGENTHUB_OLD_TREE" >&2; exit 2; }
  git -C "$REPO" cat-file -e "$OLD_REV^{commit}" 2> /dev/null || git -C "$REPO" fetch --quiet --depth 1 origin "$OLD_REV" 2> /dev/null \
    || { echo "FAIL - $OLD_REV is not in this clone and could not be fetched"; exit 2; }
  OLD="$X/old"
  mkdir -p "$OLD"
  (set -o pipefail; git -C "$REPO" archive "$OLD_REV" | tar -x -C "$OLD") || { echo "FAIL - could not take $OLD_REV out of the repository"; exit 2; }
  local same='const d=(f)=>JSON.stringify(JSON.parse(require("fs").readFileSync(f,"utf8")).dependencies??{});process.exit(d(process.argv[1])===d(process.argv[2])?0:1)'
  if [ -d "$REPO/node_modules" ] && node -e "$same" "$REPO/package.json" "$OLD/package.json"; then
    ln -s "$REPO/node_modules" "$OLD/node_modules"
  else
    (cd "$OLD" && npm ci --omit=dev --silent) || { echo "FAIL - could not install what $OLD_REV depends on"; exit 2; }
  fi
}

# finish [WORDS]: stops what is left, says how it went and ends with 0 only if every check passed.
finish() {
  stop_all
  trap - EXIT
  if [ "$FAILED" = 0 ]; then
    echo "RESULT: all $PASSED checks passed${1:+ ($1)}"
    [ -n "$OWN_TMP" ] && rm -rf -- "$OWN_TMP"
    exit 0
  fi
  echo "RESULT: $FAILED of $((PASSED + FAILED)) checks FAILED${1:+ ($1)}; what the run left is in $X"
  exit 1
}
