# SPDX-License-Identifier: Apache-2.0
# Mutations of: the state of the directory in the log, and what a hub answers about one name of it (section 34).
# Run from anywhere: python3 experiments/mutations/logstate.py [text of one description]
from harness import run

L, H, K, F = 'src/core/log.mjs', 'src/hub/server.mjs', 'src/sdk/index.mjs', 'src/sdk/follower.mjs'
WIDE = ['test/logstate.test.mjs', 'test/log.test.mjs', 'test/succession.test.mjs', 'test/attestations.test.mjs', 'test/trust.test.mjs']
NARROW = ['test/logstate.test.mjs']
WITNESS = ['test/logstate.test.mjs', 'test/witness.test.mjs']
mutations = [
    (L, "      if (entry.state !== this.stateRoot) fail('the state it gives is not that of the directory at this point');\n", "", 'log: any state is taken', NARROW),
    (L, "      this.agents.set(entry.did, { status: 'active', delegation: null, revoked: null, ...known, card: cardHash(entry.card) });\n      this.#saidOf('agent', entry.did);\n", "      this.agents.set(entry.did, { status: 'active', delegation: null, revoked: null, ...known, card: cardHash(entry.card) });\n", 'log: a card that the state does not tell', WIDE),
    (L, "        agent.delegation = null;\n        this.#saidOf('agent', entry.did);\n", "        agent.delegation = null;\n", 'log: a dropped delegation that the state does not tell', WIDE),
    (L, "expires_at: delegation.expires_at };\n      this.#saidOf('agent', entry.did);\n", "expires_at: delegation.expires_at };\n", 'log: a delegation that the state does not tell', WIDE),
    (L, "      agent.revoked = { by: entry.by, at: entry.at };\n      this.#saidOf('agent', entry.did);\n", "      agent.revoked = { by: entry.by, at: entry.at };\n", 'log: a revoked agent that the state does not tell', WIDE),
    (L, "    this.revokedDelegations.add(`${issuer}|${id}`);\n    this.#said(stateName.delegation(issuer, id), REVOKED);\n", "    this.revokedDelegations.add(`${issuer}|${id}`);\n", 'log: a revoked delegation that the state does not tell', WIDE),
    (L, "      agent.guardian = entry.guardian;\n      this.#saidOf('agent', entry.did);\n", "      agent.guardian = entry.guardian;\n", 'log: a guardian that the state does not tell', WIDE),
    (L, "      this.#saidOf('agent', entry.did);\n      this.#saidOf('agent', entry.successor);\n", "      this.#saidOf('agent', entry.did);\n", 'log: a successor that the state does not tell', WIDE),
    (L, "      this.#saidOf('agent', entry.did);\n      this.#saidOf('agent', entry.successor);\n", "      this.#saidOf('agent', entry.successor);\n", 'log: an agent handed over that the state does not tell', WIDE),
    (L, "        topic.owner = entry.successor;\n        this.#saidOf('topic', name);\n", "        topic.owner = entry.successor;\n", 'log: a topic that changed hands and the state does not tell', WIDE),
    (L, "      this.#saidOf('account', entry.controller);\n", "", 'log: an account that the state does not tell', WIDE),
    (L, "removed: false });\n      this.#saidOf('instance', entry.instance);\n", "removed: false });\n", 'log: an instance that the state does not tell', WIDE),
    (L, "      known.removed = true;\n      this.#saidOf('instance', entry.instance);\n", "      known.removed = true;\n", 'log: a removed instance that the state does not tell', WIDE),
    (L, "revision: 0 });\n      this.#saidOf('topic', name);\n", "revision: 0 });\n", 'log: a topic that the state does not tell', WIDE),
    (L, "      if (subscribe !== null) topic.subscribe = subscribe;\n      this.#saidOf('topic', entry.name);\n", "      if (subscribe !== null) topic.subscribe = subscribe;\n", 'log: a policy that the state does not tell', WIDE),
    (L, "    for (const [name, record] of directoryState(directory)) directory.#said(name, record);\n", "", 'log: a directory taken up again without its map', NARROW),
    (L, "guardian: agent.guardian ?? null, successor: agent.successor ?? null,", "successor: agent.successor ?? null,", 'log: the record of an agent without its guardian', WIDE),
    (L, "  if (!isPlainObject(entry) || !hasExactKeys(entry, ['n', 'at', 'type', 'state']) || entry.type !== 'log.state' || entry.n !== size - 1) fail(", "  if (!isPlainObject(entry) || !hasExactKeys(entry, ['n', 'at', 'type', 'state']) || entry.type !== 'log.state') fail(", 'answer: the entry of another place in the log', NARROW),
    (L, "  if (hashes === null || !verifyInclusion({ index: size - 1, size, leaf, proof: hashes, root })) fail('its entry is not the last of the log at that size');\n", "", 'answer: an entry that is not in the log', NARROW),
    (L, "  if (!verifyState(Buffer.from(entry.state, 'hex'), name, value, proof)) fail(", "  if (false) fail(", 'answer: a record the state does not have', NARROW),
    (L, "    if (record !== null) value = createHash('sha256').update(canonicalize(record)).digest();", "    if (record !== null) value = createHash('sha256').update(JSON.stringify(record)).digest();", 'answer: a record hashed as it comes', NARROW),
    (H, "        if (store.log.at(-1)?.type === 'log.state') return views.at(-1);\n        store.commit(", "        if (false) return views.at(-1);\n        store.commit(", 'hub: an entry each time it is asked', NARROW),
    (H, "      await stateNow();\n      const checkpoint = ownCheckpoint();", "      const checkpoint = ownCheckpoint();", 'hub: witnesses shown a log that does not end in its state', NARROW),
    (H, "            if (views.length > VIEWS_KEPT) views.shift();\n", "", 'hub: every state kept for ever', NARROW),
    (H, "    const at = size === undefined ? await stateNow() : views.find((kept) => kept.size === size);", "    const at = await stateNow();", 'hub: asked for one size, answers for another', NARROW),
    (H, "        record: kept === undefined ? null : JSON.parse(kept),", "        record: kept === undefined ? {} : JSON.parse(kept),", 'hub: something where there is nothing', NARROW),
    (H, "    if (typeof name !== 'string' || name.length === 0 || name.length > 400) throw new HttpError(400, 'invalid_parameter', 'name must be a name of the directory, like agent:DID or topic:NAME');\n", "", 'hub: any name', NARROW),
    (K, "      const signed = verifyCheckpoint(answer?.checkpoint, { hub });", "      const signed = verifyCheckpoint(answer?.checkpoint);", 'sdk: a checkpoint anybody signed', NARROW),
    (K, "    let trusted = cosigned;\n    if (!trusted) {", "    let trusted = null;\n    if (!trusted) {", 'sdk: with witnesses, the word of the hub', NARROW),
    (K, "    const cosigned = this.#follower?.asksForWitnesses ? await this.#follower.cosigned(hub) : null;", "    const cosigned = null;", 'sdk: witnesses never asked', NARROW),
    (F, "    if (checkpoint.origin !== hub || !seen.byLog) throw new LogError('the cosigned checkpoint the hub shows is not one of its own log');\n", "", 'follower: a checkpoint the hub did not sign', WITNESS),
    (F, "    if (lately.length < this.#quorum) {", "    if (false) {", 'follower: no quorum asked', WITNESS),
    (F, "    const lately = seen.cosigned.filter(({ time }) => time <= now + CLOCK_SKEW_S && now - time <= this.#witnessMaxAgeMs / 1000);", "    const lately = seen.cosigned.filter(({ time }) => time <= now + CLOCK_SKEW_S);", 'follower: a cosignature of any age', WITNESS),
    (F, "    if (checkpoint.size < this.#witnessedSize) throw new LogError(`the hub showed ${this.#witnessedSize} entries of its log cosigned and now shows ${checkpoint.size}`);\n", "", 'follower: shown less cosigned than before', WITNESS),
]

run(mutations, NARROW)
