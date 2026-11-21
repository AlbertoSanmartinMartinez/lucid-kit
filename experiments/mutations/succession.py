# SPDX-License-Identifier: Apache-2.0
# Mutations of: an agent that changes its key: the guardian, the handing over and what follows the successor (section 33).
# Run from anywhere: python3 experiments/mutations/succession.py [text of one description]
from harness import run

L, H, ST, K = 'src/core/log.mjs', 'src/hub/server.mjs', 'src/hub/store.mjs', 'src/sdk/index.mjs'
mutations = [
    # the rules of the log
    (L, "      if (agent.guardian) fail('the agent had already named its guardian');\n", "", 'log: a guardian named twice'),
    (L, "if (!isValidDid(entry.guardian) || entry.guardian === entry.did) fail('a guardian is a key, and another than the agent\\'s own');", "if (!isValidDid(entry.guardian)) fail('x');", 'log: an agent its own guardian'),
    (L, "if (this.#stated('agent.guardian', entry, { agent: entry.did, guardian: entry.guardian }, fail) !== entry.did) fail('an agent names its guardian with its own key');", "this.#stated('agent.guardian', entry, { agent: entry.did, guardian: entry.guardian }, fail);", 'log: a guardian named by any key'),
    (L, "    'agent.guardian': (entry, fail) => {\n      if (this.signedFrom === null) fail('a guardian is named only in a log whose changes are signed');\n", "    'agent.guardian': (entry, fail) => {\n", 'log: a guardian in an unsigned log'),
    (L, "      if (agent.successor) fail('the agent had already been handed over');\n", "", 'log: handed over twice'),
    (L, "      if (agent.status !== 'active' && !agent.guardian) fail('an agent that was retired and had named no guardian is not handed over');\n", "", 'log: a retired agent with no guardian handed over'),
    (L, "if (!successor || successor.status !== 'active' || entry.successor === entry.did) fail(", "if (!successor || entry.successor === entry.did) fail(", 'log: a revoked successor'),
    (L, "if (!successor || successor.status !== 'active' || entry.successor === entry.did) fail(", "if (!successor || successor.status !== 'active') fail(", 'log: an agent its own successor'),
    (L, "      if (successor.predecessor) fail('the successor had already taken over from another agent');\n", "", 'log: a successor of two'),
    (L, "const authority = agent.guardian ?? entry.did;", "const authority = entry.did;", 'log: the agent hands itself over though it has a guardian'),
    (L, "if (this.#stated('agent.succeed', entry, says, fail) !== authority) fail(", "if (false && this.#stated('agent.succeed', entry, says, fail) !== authority) fail(", 'log: a handing over nobody signed'),
    (L, "if (!taken.ok || taken.signer !== entry.successor) fail('the successor did not sign that it takes over');", "if (!taken.ok) fail('the successor did not sign that it takes over');", 'log: an acceptance by somebody else'),
    (L, "if (!taken.ok || taken.signer !== entry.successor) fail('the successor did not sign that it takes over');", "", 'log: no acceptance'),
    (L, "        topic.owner = entry.successor;\n        this.#saidOf('topic', name);\n", "", 'log: topics stay with the first'),
    (L, "      successor.predecessor = entry.did;\n", "", 'log: the successor has no predecessor'),
    # the hub
    (H, "    if (ctx.agent.guardian) throw new HttpError(409, 'guardian_named', 'this agent has already named its guardian: it is named once');\n", "", 'hub: a guardian named twice'),
    (H, "if (!isValidDid(guardian) || guardian === ctx.did) throw new HttpError(400, 'invalid_guardian'", "if (false) throw new HttpError(400, 'invalid_guardian'", 'hub: any guardian'),
    (H, "    if (handed.successor) throw new HttpError(409, 'already_succeeded', 'that agent has already been handed over');\n", "", 'hub: handed over twice'),
    (H, "    if (ctx.agent.predecessor) throw new HttpError(409, 'already_a_successor', 'this agent has already taken over from another');\n", "", 'hub: a successor of two'),
    (H, "    if (handed.status !== 'active' && !handed.guardian) throw new HttpError(409, 'agent_retired', 'that agent was retired and had named no guardian: it cannot be handed over any more');\n", "", 'hub: a retired agent with no guardian'),
    (H, "    if (store.suspended.has(`agent:${handed.did}`)) throw new HttpError(403, 'agent_suspended', 'the operators of this hub suspended that agent');\n", "", 'hub: a suspended agent handed over'),
    (H, "if (given.signer !== (handed.guardian ?? handed.did)) {", "if (given.signer !== handed.did && given.signer !== handed.guardian) {", 'hub: the agent hands itself over though it has a guardian'),
    (H, "if (given.signer !== (handed.guardian ?? handed.did)) {", "if (false) {", 'hub: handed over by anybody'),
    (H, "    if (taken.signer !== ctx.signer) throw new HttpError(403, 'signer_mismatch', 'the statement must be signed with the same key as the request');\n    const bare", "    const bare", 'hub: an acceptance by another key'),
    (H, "    if (handed.did === ctx.did) throw new HttpError(400, 'invalid_succession', 'an agent is not its own successor');\n", "", 'hub: an agent its own successor'),
    (H, "    refuseSucceeded(agent);\n    throw new HttpError(404, 'recipient_not_found'", "    throw new HttpError(404, 'recipient_not_found'", 'hub: a message to a handed-over agent does not say'),
    (H, "    refuseSucceeded(peer); // a conversation with it is one with its successor now, and that is another conversation\n", "", 'hub: an MLS conversation with a handed-over agent does not say'),
    (H, "  route('PUT', '/v1/agents/me/guardian', 'registered', (ctx) => {\n    requireAgentKey(ctx);\n", "  route('PUT', '/v1/agents/me/guardian', 'registered', (ctx) => {\n", 'hub: an instance names the guardian'),
    (H, "  route('POST', '/v1/agents/me/succession', 'registered', (ctx) => {\n    requireAgentKey(ctx);\n", "  route('POST', '/v1/agents/me/succession', 'registered', (ctx) => {\n", 'hub: an instance takes over'),
    (H, "    recipient_succeeded: 'the recipient was handed over to a successor there',\n", "", 'hub: what another hub says of a handed-over recipient is not passed on'),
    # the store
    (ST, "          ...(previous?.guardian ? { guardian: previous.guardian } : {}),\n", "", 'store: a new card forgets the guardian'),
    (ST, "          ...(previous?.predecessor ? { predecessor: previous.predecessor } : {}),\n", "", 'store: a new card forgets the predecessor'),
    (ST, "        for (const topic of this.topics.values()) if (topic.owner === op.did) topic.owner = op.successor;\n", "", 'store: topics stay with the first'),
    (ST, "        for (const blocked of this.blocks.values()) if (blocked.has(op.did)) blocked.add(op.successor);\n", "", 'store: out of a block by handing over'),
    (ST, "        if (own) this.blocks.set(op.successor, new Set([...(this.blocks.get(op.successor) ?? []), ...own]));\n", "", 'store: its own blocks do not follow'),
    # the SDK
    (K, "    return shown.guardian || !isValidDid(issuer) ? shown : this.nameGuardian(issuer);", "    return shown;", 'sdk: the controller is not named guardian'),
    (K, "    return shown.guardian || !isValidDid(issuer) ? shown : this.nameGuardian(issuer);", "    return !isValidDid(issuer) ? shown : this.nameGuardian(issuer);", 'sdk: names the controller over a guardian it has'),
    (K, "        if (!(await this.#handedOver(trusted, topic.owner))) throw new Error(`the hub names an owner of ${name} that is not the one this client trusts, ${trusted}`);\n", "", 'sdk: any new owner of a topic is taken'),
    (K, "    let current = directory?.agents.get(from)?.successor;\n", "    let current = to;\n", 'sdk: handed over on the word of the hub'),
    (K, "      const closed = view.group !== null && view.generation <= (this.#stored(scope.record)?.closed ?? 0);", "      const closed = false;", 'sdk: writes in the group the first owner made'),
    (K, "    const arriving = agents.filter((did) => did !== this.did && !view.agents.includes(did));\n    this.#requireReaders(arriving, others.map(", "    const arriving = agents.filter((did) => !view.agents.includes(did));\n    this.#requireReaders(arriving, others.map(", 'sdk: the successor cannot make the group'),
    (K, "      const scope = await this.#topicScope(name, { fresh: this.#state.get(`group/${group}`) === null });", "      const scope = await this.#topicScope(name);", 'sdk: opens an invitation without looking at who owns the topic'),
    (K, "        const now = (await this.#topic(name, { fresh: true })).owner;\n        if (now !== owner) open(now);\n", "", 'sdk: a reader of a topic key never learns it changed hands'),
    (K, "      if (!agent.succeeded_by) return current;", "      if (true) return current;", 'sdk: standsFor does not follow'),
    (K, "        if (scope.owner === before || scope.owner !== view.owner) throw new Error(`the hub names an owner of ${name} that is not the one this client has, ${before}`);\n", "", 'sdk: writes for an owner the hub names and the topic does not have'),
    (K, "    const inherited = [...((await this.directory())?.topics ?? [])].filter(([, topic]) => topic.owner === agent && topic.encryption !== null).map(([name]) => name);", "    const inherited = [];", 'sdk: the successor reopens nothing'),
]

run(mutations, ['test/succession.test.mjs', 'test/federation.test.mjs'])
