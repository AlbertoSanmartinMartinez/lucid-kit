#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# A copy of the data of a hub, made while it runs. Usage: backup.sh DATA_DIR DEST_DIR
#
# The journal is copied before the snapshot, and that order is what makes the copy good: the hub writes
# its snapshot by renaming a whole new file, and empties the journal only after. A snapshot copied after
# the journal is never older than it, so starting from the copy replays the journal on top of the
# snapshot or skips what the snapshot already holds. The other way round, operations could be missing,
# and the hub would refuse to start from the copy. What the hub does after the copy is not in it.
#
# The key of the hub (hub-identity.json) is in the copy: keep the copies as safe as the hub itself.
set -eu
DATA="${1:?usage: backup.sh DATA_DIR DEST_DIR}"
DEST="${2:?usage: backup.sh DATA_DIR DEST_DIR}"
[ -f "$DATA/hub-identity.json" ] || { echo "no hub data in $DATA" >&2; exit 2; }
OUT="$DEST/agenthub-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
chmod 700 "$OUT"
[ -f "$DATA/journal.jsonl" ] && cp "$DATA/journal.jsonl" "$OUT/journal.jsonl"
[ -f "$DATA/snapshot.json" ] && cp "$DATA/snapshot.json" "$OUT/snapshot.json"
cp -p "$DATA/hub-identity.json" "$OUT/hub-identity.json"
echo "$OUT"
