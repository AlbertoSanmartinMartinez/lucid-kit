# SPDX-License-Identifier: Apache-2.0
# Mutations of: a hub that pairs itself with another: the address it gives is looked up, and within a time (section 30).
# Run from anywhere: python3 experiments/mutations/pairing.py [text of one description]
from harness import run

mutations = [
    ('src/hub/server.mjs', "const host = hostname.replace(/^\\[(.*)\\]$/, '$1');", "const host = hostname;", 'brackets kept'),
    ('src/hub/server.mjs', "(isIP(host) ? [{ address: host }] : within(", "(false ? [{ address: host }] : within(", 'a written address is looked up'),
    ('src/hub/server.mjs', "within(cfg.peerTimeoutMs, lookupPeer(host, { all: true }))", "lookupPeer(host, { all: true })", 'a lookup is waited for without end'),
    ('src/hub/server.mjs', "!addresses.every(({ address }) => isPublicAddress(address))", "!addresses.some(({ address }) => isPublicAddress(address))", 'one public address is enough'),
]

run(mutations, ['test/pairing.test.mjs'], test_timeout_ms=15000)
