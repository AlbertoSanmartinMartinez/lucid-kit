# SPDX-License-Identifier: Apache-2.0
# Mutations of: the A2A card of an agent: its signature, and what a hub serves of it (docs/HANDOFF.md, section 28).
# Run from anywhere: python3 experiments/mutations/a2a.py [text of one description]
from harness import run

mutations = [
    ('src/core/a2a.mjs', "return header && signerOf(header) === card.did ? {", "return header ? {", 'hub: kid of somebody else'),
    ('src/core/a2a.mjs', "if (!isPlainObject(header) || header.alg !== JWS_ALG) return null;", "if (!isPlainObject(header)) return null;", 'alg not checked'),
    ('src/core/a2a.mjs', "return header !== null && signerOf(header) === reached.tenant;", "return header !== null;", 'verify: kid not checked'),
    ('src/core/a2a.mjs', "    if (did !== undefined && reached.tenant !== did) return { ok: false, error: 'the card is of another agent' };\n", "", 'verify: expected agent not checked'),
    ('src/core/a2a.mjs', "    if (hub !== undefined && reached.url !== originOf(hub)) return { ok: false, error: 'the card was signed for another hub' };\n", "", 'verify: expected hub not checked'),
    ('src/core/a2a.mjs', "  if (Object.keys(value).length !== 2) return 'a2a has unexpected fields';\n", "", 'unsigned fields ride along'),
    ('src/core/a2a.mjs', "signatures.length > MAX_SIGNATURES", "false", 'verify: any number of signatures'),
    ('src/core/a2a.mjs', "    if (originOf(reached.url) !== reached.url) return { ok: false, error: 'the card does not name its hub by its address' };\n", "", 'verify: hub not an address'),
    ('src/core/a2a.mjs', "if (identity.instance) throw new Error('an A2A card is signed with the agent key, not by an instance');", "", 'instance signs'),
    ('src/hub/server.mjs', "    validateCard(body.card_envelope.card, ctx.did);\n    requireOwnA2A(body.card_envelope.card);\n    const now = Date.now();", "    validateCard(body.card_envelope.card, ctx.did);\n    const now = Date.now();", 'hub: registration takes any a2a'),
    ('src/hub/server.mjs', "    requireOwnA2A(body.card_envelope.card);\n    store.commit({ type: 'agent.put'", "    store.commit({ type: 'agent.put'", 'hub: update takes any a2a'),
    ('src/hub/server.mjs', "const card = agent.status === 'active' && !store.suspended.has(`agent:${agent.did}`) ? ownA2ACard(agent.card) : null;", "const card = agent.status === 'active' ? ownA2ACard(agent.card) : null;", 'hub: suspended agent served'),
    ('src/hub/server.mjs', "const card = agent.status === 'active' && !store.suspended.has(`agent:${agent.did}`) ? ownA2ACard(agent.card) : null;", "const card = !store.suspended.has(`agent:${agent.did}`) ? ownA2ACard(agent.card) : null;", 'hub: retired agent served'),
    ('src/sdk/index.mjs', "card: agent && agent.status === 'active' ? signedA2ACard(agent.card, this.hubUrl) : null };", "card: agent ? signedA2ACard(agent.card, this.hubUrl) : null };", 'sdk: retired agent has a card'),
]

run(mutations, ['test/a2a.test.mjs'], test_timeout_ms=60000)
