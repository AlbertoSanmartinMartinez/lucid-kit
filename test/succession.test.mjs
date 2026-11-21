// SPDX-License-Identifier: Apache-2.0
// An agent is its key. One whose key is lost, stolen or simply changed goes on as another agent, its
// successor: the handing over is signed and on record. Who may sign it is the guardian the agent
// named - a key kept apart, or that of its controller - or the agent itself if it named none.
// These are the rules of that, in the hub, in the log and in the SDK, and what a thief, a hub and an
// agent that wants out of a block get from it: nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signStatement } from '../src/core/statement.mjs';
import { replayLog, LogError } from '../src/core/log.mjs';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, createDelegation, createSuccession, generateIdentity, HubError, memoryStateStore, moderation } from '../src/sdk/index.mjs';
import { instanceOf, rejects, signedFetch, startHub } from './helpers.mjs';

const NEWS = { name: 'dev.rust.news', description: 'Noticias de Rust', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } };
const following = { followLog: true };
/** An agent on `hub` under a new key, with a client that follows the log. */
const join_ = (hub, name, identity = generateIdentity()) => hub.agent(name, identity, following);
const code = (promise) => promise.then(() => 'done', (err) => (err instanceof HubError ? `${err.status} ${err.code}` : `${err.name}: ${err.message}`));

test('an agent that changes its key goes on as its successor, and whoever knew it can tell', async (t) => {
  const hub = await startHub(t);
  const old = await join_(hub, 'alice');
  const bob = await join_(hub, 'bob');
  await old.createTopic({ ...NEWS, publish: 'owner' });
  await bob.subscribe(NEWS.name);

  // The new key registers like any agent. The old one signs that it is handed over to it, and the new one takes it.
  const alice = await join_(hub, 'alice');
  const handed = await old.handOver(alice.did);
  const taken = await alice.takeOver(old.did, handed);
  assert.deepEqual([taken.did, taken.predecessor, taken.status, taken.succeeded_by], [alice.did, old.did, 'active', null]);

  // Whoever knew the first is told who stands for it now, and that is in the log, not the hub's word.
  const seen = await bob.getAgent(old.did);
  assert.deepEqual([seen.status, seen.succeeded_by, seen.revoked.by], ['revoked', alice.did, old.did]);
  assert.deepEqual([await bob.standsFor(old.did), await bob.standsFor(alice.did), await bob.standsFor(generateIdentity().did)], [alice.did, alice.did, null]);
  const entry = hub.store.log.at(-1);
  assert.deepEqual([entry.type, entry.did, entry.successor, entry.statement.proof.key_id, entry.acceptance.proof.key_id], ['agent.succeed', old.did, alice.did, old.did, alice.did]);
  const { directory } = await replayLog(structuredClone(hub.store.log), { hub: hub.did });
  assert.deepEqual([directory.agents.get(old.did).successor, directory.agents.get(alice.did).predecessor, directory.agents.get(old.did).status], [alice.did, old.did, 'revoked']);

  // What it owned is the successor's: the topic, in the hub and in the log, and the say over it.
  assert.deepEqual([(await bob.getTopic(NEWS.name)).owner, directory.topics.get(NEWS.name).owner], [alice.did, alice.did]);
  await alice.publish(NEWS.name, { type: 'news', data: { title: 'the same agent, another key' } });
  assert.equal((await bob.poll()).messages[0].data.title, 'the same agent, another key');
  assert.equal((await alice.setTopicPolicy(NEWS.name, { publish: 'any' })).publish, 'any');
  // The first is an agent that was retired: it does nothing more, and what is written to it is not taken.
  assert.equal(await code(old.updateCard({ name: 'alice' })), '403 agent_revoked');
  const err = await bob.send(old.did, { type: 'hello', data: {}, encrypt: false }).catch((thrown) => thrown);
  assert.deepEqual([err.status, err.code, err.details.successor, err.fromHub], [404, 'recipient_succeeded', alice.did, true]);
  // The same whichever way it is written: sealed to its card, or over MLS by a client that keeps conversations.
  const carol = await hub.agent('carol', generateIdentity(), { ...following, state: memoryStateStore() });
  for (const writer of [bob, carol]) {
    const refused = await writer.send(old.did, { type: 'hello', data: {} }).catch((thrown) => thrown);
    assert.deepEqual([refused.code, refused.details?.successor], ['recipient_succeeded', alice.did]);
  }
  await bob.send(alice.did, { type: 'hello', data: {}, encrypt: false });
  assert.equal((await alice.poll()).messages.length, 1);

  // It happens once to an agent, and no agent takes over from two. But the successor can be handed over in its turn.
  const third = await join_(hub, 'alice');
  assert.equal(await code(third.takeOver(old.did, await old.handOver(third.did))), '409 already_succeeded');
  const other = await join_(hub, 'other');
  assert.equal(await code(alice.takeOver(other.did, await other.handOver(alice.did))), '409 already_a_successor');
  await third.takeOver(alice.did, await alice.handOver(third.did));
  assert.deepEqual([await bob.standsFor(old.did), (await bob.getTopic(NEWS.name)).owner], [third.did, third.did]);
  await replayLog(structuredClone(hub.store.log), { hub: hub.did });
});

test('with a guardian, whoever steals the key of an agent cannot hand it over', async (t) => {
  const operator = generateIdentity();
  const hub = await startHub(t, { operators: [operator.did] });
  const identity = generateIdentity();
  const alice = await join_(hub, 'alice', identity);
  const guardian = generateIdentity(); // a key kept somewhere else: it is on no hub
  const reader = await join_(hub, 'reader');

  // Named once, with the agent's own key.
  const guarded = await alice.nameGuardian(guardian.did);
  assert.deepEqual([guarded.guardian, hub.store.log.at(-1).type, (await reader.getAgent(alice.did)).guardian], [guardian.did, 'agent.guardian', guardian.did]);

  // The thief has the key of the agent, and so everything the agent can do. It cannot name another guardian...
  const thief = hub.client(identity);
  const theirs = generateIdentity();
  assert.equal(await code(thief.nameGuardian(theirs.did)), '409 guardian_named');
  // ...nor hand the agent over to a key of its own, with the agent's key or with any other.
  const puppet = await join_(hub, 'alice');
  assert.equal(await code(puppet.takeOver(alice.did, await thief.handOver(puppet.did))), '403 not_the_guardian');
  assert.equal(await code(puppet.takeOver(alice.did, createSuccession(theirs, { hub: hub.did, agent: alice.did, successor: puppet.did }))), '403 not_the_guardian');
  // A new card does not unsay who guards it, and retiring the agent does not keep its guardian from handing it over.
  await thief.updateCard({ name: 'alice (really)' });
  assert.equal(hub.store.agents.get(alice.did).guardian, guardian.did);
  await thief.retire();

  // What the guardian signs is for one agent, one successor and one hub.
  const fresh = await join_(hub, 'alice');
  const forPuppet = createSuccession(guardian, { hub: hub.did, agent: alice.did, successor: puppet.did });
  assert.equal(await code(fresh.takeOver(alice.did, forPuppet)), '400 invalid_statement');
  assert.equal(await code(fresh.takeOver(alice.did, createSuccession(guardian, { hub: generateIdentity().did, agent: alice.did, successor: fresh.did }))), '400 invalid_statement');
  assert.equal(await code(fresh.takeOver(reader.did, createSuccession(guardian, { hub: hub.did, agent: alice.did, successor: fresh.did }))), '400 invalid_statement');
  // Nobody is made a successor without signing for it: a request of one agent with the acceptance of another.
  const good = createSuccession(guardian, { hub: hub.did, agent: alice.did, successor: fresh.did });
  const says = { agent: alice.did, successor: fresh.did };
  const acceptedBy = (signer) => signStatement('succession.accept', says, { hub: hub.did, signer });
  const ask = (who, body) => signedFetch(hub, who, 'POST', '/v1/agents/me/succession', body).then(({ status, code: said }) => `${status} ${said}`);
  assert.equal(await ask(theirs, { agent: alice.did, statement: good, acceptance: acceptedBy(theirs) }), '403 not_registered'); // a key that is no agent here
  const freshKey = generateIdentity();
  const waiting = await join_(hub, 'alice', freshKey);
  const forWaiting = createSuccession(guardian, { hub: hub.did, agent: alice.did, successor: waiting.did });
  assert.equal(await ask(freshKey, { agent: alice.did, statement: forWaiting, acceptance: signStatement('succession.accept', { agent: alice.did, successor: waiting.did }, { hub: hub.did, signer: theirs }) }), '403 signer_mismatch');
  assert.equal(await ask(freshKey, { agent: alice.did, statement: forWaiting }), '400 invalid_statement');
  assert.equal(await ask(freshKey, { agent: alice.did, statement: forWaiting, acceptance: forWaiting }), '400 invalid_statement');
  assert.equal(await ask(freshKey, { agent: waiting.did, statement: forWaiting, acceptance: acceptedBy(freshKey) }), '400 invalid_succession');
  assert.equal(await ask(freshKey, { agent: generateIdentity().did, statement: forWaiting, acceptance: acceptedBy(freshKey) }), '404 agent_not_found');
  assert.equal(await ask(freshKey, { agent: 'alice', statement: forWaiting, acceptance: acceptedBy(freshKey) }), '404 agent_not_found');
  // An agent the operators of the hub stopped is not got going again under another key.
  const desk = moderation(hub.url, operator);
  await desk.suspend(`agent:${alice.did}`, 'spam, while it was in the wrong hands');
  assert.equal(await code(fresh.takeOver(alice.did, good)), '403 agent_suspended');
  await desk.unsuspend(`agent:${alice.did}`);
  assert.equal(hub.store.agents.get(alice.did).successor, undefined, 'none of that handed it over');

  // The guardian hands it over to the key its owner made, though the thief retired it first.
  const taken = await fresh.takeOver(alice.did, good);
  assert.deepEqual([taken.predecessor, (await reader.getAgent(alice.did)).succeeded_by, await reader.standsFor(alice.did)], [alice.did, fresh.did, fresh.did]);
  assert.deepEqual([hub.store.log.at(-1).statement.proof.key_id, hub.store.agents.get(alice.did).revoked.by], [guardian.did, alice.did]);
  await replayLog(structuredClone(hub.store.log), { hub: hub.did });

  // A guardian is a key, another than the agent's, and is named by the agent: not by an instance of its.
  const bob = await join_(hub, 'bob');
  for (const bad of [bob.did, 'did:web:acme.example', 'guardian', null]) assert.equal(await code(bob.nameGuardian(bad)), '400 invalid_guardian', String(bad));
  const bobs = generateIdentity();
  const carol = await join_(hub, 'carol', bobs);
  const laptopKey = instanceOf(bobs);
  const laptop = hub.client(laptopKey);
  await laptop.registerInstance();
  await assert.rejects(laptop.nameGuardian(guardian.did), /agent key/);
  await assert.rejects(laptop.handOver(fresh.did), /agent key/);
  await assert.rejects(laptop.takeOver(bob.did, good), /agent key/);
  assert.equal(carol.did, bobs.did);
  // Nor does the hub take either from an instance that asks by hand, whatever it signs.
  const byHand = laptopKey.instance;
  const sayAs = (kind, said) => signStatement(kind, said, { hub: hub.did, signer: byHand });
  const named = await signedFetch(hub, byHand, 'PUT', '/v1/agents/me/guardian', { guardian: guardian.did, statement: sayAs('agent.guardian', { agent: carol.did, guardian: guardian.did }) });
  const took = await signedFetch(hub, byHand, 'POST', '/v1/agents/me/succession', { agent: bob.did, statement: await bob.handOver(carol.did), acceptance: sayAs('succession.accept', { agent: bob.did, successor: carol.did }) });
  assert.deepEqual([named.status, named.code, took.status, took.code], [403, 'agent_key_required', 403, 'agent_key_required']);
  assert.deepEqual([hub.store.agents.get(carol.did).guardian, hub.store.agents.get(bob.did).successor], [undefined, undefined]);

  // An agent that named nobody and was retired - by its owner, when its key leaked - stays retired: the key
  // that would hand it over is the one that leaked. Nor does that key name a guardian now.
  const leaked = generateIdentity();
  const dave = await join_(hub, 'dave', leaked);
  await dave.retire();
  const stolen = hub.client(leaked);
  const heir = await join_(hub, 'dave');
  assert.equal(await code(heir.takeOver(dave.did, await stolen.handOver(heir.did))), '409 agent_retired');
  assert.equal(await code(stolen.nameGuardian(theirs.did)), '403 agent_revoked');
  assert.equal(await reader.standsFor(dave.did), dave.did);
  await replayLog(structuredClone(hub.store.log), { hub: hub.did });
});

test('an agent that acts for a controller is guarded by it', async (t) => {
  const hub = await startHub(t);
  const controller = generateIdentity();
  const identity = generateIdentity();
  const alice = hub.client(identity, following);
  const registered = await alice.register({ name: 'alice' }, { delegation: createDelegation(controller, { subject: identity.did }) });
  assert.deepEqual([registered.guardian, registered.controller.did], [controller.did, controller.did]);
  assert.deepEqual(hub.store.log.slice(-2).map((entry) => entry.type), ['agent.delegation', 'agent.guardian']);

  // Dropping the delegation, or presenting that of another controller, does not change who guards it.
  await alice.dropDelegation();
  const another = generateIdentity();
  const moved = await alice.attachDelegation(createDelegation(another, { subject: identity.did }));
  assert.deepEqual([moved.controller.did, moved.guardian], [another.did, controller.did]);
  // So the thief of its key cannot hand it over by bringing a controller of its own...
  const puppet = await join_(hub, 'alice');
  assert.equal(await code(puppet.takeOver(alice.did, createSuccession(another, { hub: hub.did, agent: alice.did, successor: puppet.did }))), '403 not_the_guardian');
  assert.equal(await code(puppet.takeOver(alice.did, await alice.handOver(puppet.did))), '403 not_the_guardian');
  // ...and the controller that first answered for it can.
  const fresh = await join_(hub, 'alice');
  await fresh.takeOver(alice.did, createSuccession(controller, { hub: hub.did, agent: alice.did, successor: fresh.did }));
  assert.equal(await fresh.standsFor(alice.did), fresh.did);
  // The successor is a new agent: it acts for nobody until a controller says so, and names its own guardian.
  assert.deepEqual([(await fresh.getAgent(fresh.did)).tier, (await fresh.getAgent(fresh.did)).guardian, (await fresh.getAgent(fresh.did)).delegation], ['key', null, null]);

  // An agent that means to be guarded by a key of its own names it first, or says so when it presents the delegation.
  const own = generateIdentity();
  const bob = await join_(hub, 'bob');
  await bob.nameGuardian(own.did);
  assert.equal((await bob.attachDelegation(createDelegation(controller, { subject: bob.did }))).guardian, own.did);
  const carol = await join_(hub, 'carol');
  assert.equal((await carol.attachDelegation(createDelegation(controller, { subject: carol.did }), { guardian: false })).guardian, null);
  const dave = hub.client(generateIdentity(), following);
  assert.equal((await dave.register({ name: 'dave' }, { delegation: createDelegation(controller, { subject: dave.did }), guardian: false })).guardian, null);
  await replayLog(structuredClone(hub.store.log), { hub: hub.did });
});

test('a hub cannot make up a guardian or a handing over: whoever reads its log refuses them', async (t) => {
  const hub = await startHub(t);
  const ids = { alice: generateIdentity(), bob: generateIdentity(), guardian: generateIdentity(), mallory: generateIdentity() };
  const alice = await hub.agent('alice', ids.alice);
  const bob = await hub.agent('bob', ids.bob);
  const laptopId = instanceOf(ids.alice);
  await hub.client(laptopId).registerInstance();
  const mallory = await hub.agent('mallory', ids.mallory);
  const say = (kind, says, signer, to = hub.did) => signStatement(kind, says, { hub: to, signer });
  const base = structuredClone(hub.store.log);
  const read = async (log, ...more) => (await replayLog([...log, ...more.map((fields, i) => ({ n: log.length + i, at: new Date().toISOString(), ...fields }))], { hub: hub.did })).directory;
  const refused = async (log, ...more) => {
    const err = await read(log, ...more).then(() => null, (thrown) => thrown);
    assert.ok(err instanceof LogError && err.code === 'log_invalid', `the log was taken as good: ${JSON.stringify(more.at(-1)).slice(0, 120)}`);
    return err.message.replace(/^entry \d+ of the log does not hold: /, '');
  };

  // --- A guardian.
  const guards = (did, guardian, signer, to) => ({ type: 'agent.guardian', did, guardian, statement: say('agent.guardian', { agent: did, guardian }, signer, to) });
  const named = guards(alice.did, ids.guardian.did, ids.alice);
  assert.equal((await read(base, named)).agents.get(alice.did).guardian, ids.guardian.did);
  assert.match(await refused(base, guards(alice.did, ids.mallory.did, ids.mallory)), /names its guardian with its own key/);
  assert.match(await refused(base, guards(alice.did, ids.mallory.did, laptopId.instance)), /names its guardian with its own key/);
  assert.match(await refused(base, guards(alice.did, ids.mallory.did, ids.alice, generateIdentity().did)), /statement it carries does not hold/);
  assert.match(await refused(base, { ...named, guardian: ids.mallory.did }), /statement it carries does not hold/);
  assert.match(await refused(base, guards(alice.did, alice.did, ids.alice)), /another than the agent's own/);
  assert.match(await refused(base, { ...named, statement: null }), /statement it carries does not hold/);
  assert.match(await refused(base, guards(generateIdentity().did, ids.guardian.did, ids.alice)), /not registered/);
  // Named once: a second naming, by the agent or by whoever has its key, is no entry of a log.
  assert.match(await refused(base, named, guards(alice.did, ids.mallory.did, ids.alice)), /already named its guardian/);

  // --- A handing over.
  const hands = (did, successor, signer, taker, to) => ({
    type: 'agent.succeed', did, successor,
    statement: say('agent.succeed', { agent: did, successor }, signer, to),
    acceptance: say('succession.accept', { agent: did, successor }, taker, to),
  });
  const over = await read(base, hands(alice.did, bob.did, ids.alice, ids.bob));
  assert.deepEqual([over.agents.get(alice.did).successor, over.agents.get(alice.did).status, over.agents.get(bob.did).predecessor], [bob.did, 'revoked', alice.did]);
  // Without a guardian it is the agent's own key that hands it over, and not that of an instance, of the successor or of the hub.
  for (const signer of [ids.mallory, ids.bob, laptopId.instance]) assert.match(await refused(base, hands(alice.did, bob.did, signer, ids.bob)), /handed over with its own key/);
  // With one, it is the guardian and nobody else: not the agent, which is what a thief would hold.
  assert.equal((await read(base, named, hands(alice.did, bob.did, ids.guardian, ids.bob))).agents.get(alice.did).successor, bob.did);
  for (const signer of [ids.alice, ids.mallory, ids.bob]) assert.match(await refused(base, named, hands(alice.did, bob.did, signer, ids.bob)), /handed over by it/);
  // The successor signs for it, itself.
  for (const taker of [ids.alice, ids.mallory, ids.guardian]) assert.match(await refused(base, hands(alice.did, bob.did, ids.alice, taker)), /did not sign that it takes over/);
  assert.match(await refused(base, { ...hands(alice.did, bob.did, ids.alice, ids.bob), acceptance: null }), /did not sign that it takes over/);
  const swapped = hands(alice.did, bob.did, ids.alice, ids.bob);
  assert.match(await refused(base, { ...swapped, acceptance: swapped.statement }), /did not sign that it takes over/);
  assert.match(await refused(base, { ...swapped, statement: swapped.acceptance }), /statement it carries does not hold/);
  // What was signed for one successor, or for another hub, is not used for this.
  assert.match(await refused(base, { ...hands(alice.did, mallory.did, ids.alice, ids.mallory), successor: bob.did }), /statement it carries does not hold/);
  assert.match(await refused(base, hands(alice.did, bob.did, ids.alice, ids.bob, generateIdentity().did)), /statement it carries does not hold/);
  // The successor is another agent, registered and in use; nobody is handed over twice, and nobody takes over from two.
  assert.match(await refused(base, hands(alice.did, alice.did, ids.alice, ids.alice)), /another agent, registered and not revoked/);
  const stranger = generateIdentity();
  assert.match(await refused(base, hands(alice.did, stranger.did, ids.alice, stranger)), /another agent, registered and not revoked/);
  assert.match(await refused(base, hands(stranger.did, bob.did, stranger, ids.bob)), /not registered/);
  const retired = { type: 'agent.revoke', did: bob.did, by: bob.did, reason: null, revocation: null, statement: say('retire', { agent: bob.did }, ids.bob) };
  assert.match(await refused(base, retired, hands(alice.did, bob.did, ids.alice, ids.bob)), /another agent, registered and not revoked/);
  const first = hands(alice.did, bob.did, ids.alice, ids.bob);
  assert.match(await refused(base, first, hands(alice.did, mallory.did, ids.alice, ids.mallory)), /already been handed over/);
  assert.match(await refused(base, first, hands(mallory.did, bob.did, ids.mallory, ids.bob)), /already taken over from another/);
  // An agent that was retired is still handed over by the guardian it had named: that is how one comes back from
  // a key that leaked. With no guardian it is not: the key that would sign is the one that leaked.
  const gone = { type: 'agent.revoke', did: alice.did, by: alice.did, reason: null, revocation: null, statement: say('retire', { agent: alice.did }, ids.alice) };
  assert.equal((await read(base, named, gone, hands(alice.did, bob.did, ids.guardian, ids.bob))).agents.get(alice.did).successor, bob.did);
  assert.match(await refused(base, gone, hands(alice.did, bob.did, ids.alice, ids.bob)), /retired and had named no guardian/);
  assert.match(await refused(base, gone, named), /revoked/);

  // --- A log from before agents signed for their changes carries neither: they would be the hub's word.
  const before = base.filter((entry) => entry.type !== 'log.signed').map(({ statement, ...entry }, n) => ({ ...entry, n }));
  const { statement: unsaid, ...bare } = named;
  assert.match(await refused(before, bare), /only in a log whose changes are signed/);
  const { statement: unsigned, ...bareOver } = first;
  assert.match(await refused(before, bareOver), /only in a log whose changes are signed/);
});

test('what follows an agent to its successor, and what does not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-succession-'));
  const controller = generateIdentity();
  const options = { dataDir: dir, verifiedControllers: { [controller.did]: 'acme' } };
  // A hub that is stopped here, half way, and started again over the same data.
  let hub = await createHub({ port: 0, quiet: true, powDifficulty: 8, ...options }).listen();
  let running = hub;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await running?.close();
  });
  const client = (identity) => {
    const made = new AgentClient({ hubUrl: hub.url, identity, ...following });
    clients.push(made);
    return made;
  };
  const ids = { old: generateIdentity(), fresh: generateIdentity(), carol: generateIdentity(), dave: generateIdentity() };
  const old = client(ids.old);
  await old.register({ name: 'spammer' }, { delegation: createDelegation(controller, { subject: ids.old.did }) });
  const carol = client(ids.carol);
  await carol.register({ name: 'carol' });
  const dave = client(ids.dave);
  await dave.register({ name: 'dave' });
  await carol.createTopic(NEWS);
  await old.subscribe(NEWS.name);
  await old.block(dave.did);
  await carol.block(old.did);
  assert.equal((await carol.getAgent(old.did)).tier, 'account');

  const fresh = client(ids.fresh);
  await fresh.register({ name: 'spammer' });
  await fresh.takeOver(old.did, createSuccession(controller, { hub: hub.did, agent: old.did, successor: fresh.did }));

  // Whoever had blocked the first has blocked the second: nobody gets out of a block by handing itself over.
  assert.deepEqual([(await carol.blocked()).sort(), await fresh.blocked()], [[old.did, fresh.did].sort(), [dave.did]]);
  await fresh.send(carol.did, { type: 'offer', data: {}, encrypt: false });
  assert.equal((await carol.poll()).messages.length, 0);
  // What it had by being who it was does not follow it: who it acted for, what it was subscribed to.
  const now = await carol.getAgent(fresh.did);
  assert.deepEqual([now.tier, now.delegation, now.guardian, await fresh.subscriptions()], ['key', null, null, []]);

  // All of it is kept: stopped and started, the hub has the same agents, the same log, and the same blocks.
  const head = hub.store.logHead();
  await Promise.all(clients.splice(0).map((made) => made.close()));
  await hub.close();
  running = null;
  hub = await startHub(t, options);
  t.after(() => rmSync(dir, { recursive: true, force: true })); // after the hub that writes there has closed
  assert.deepEqual([hub.store.logHead().size, hub.store.logHead().root.equals(head.root)], [head.size, true]);
  const stored = hub.store.agents;
  assert.deepEqual([stored.get(old.did).successor, stored.get(old.did).guardian, stored.get(fresh.did).predecessor, stored.get(old.did).status], [fresh.did, controller.did, old.did, 'revoked']);
  assert.deepEqual([...hub.store.blocks.get(carol.did)].sort(), [old.did, fresh.did].sort());
  const reader = hub.client(ids.dave, following);
  assert.equal(await reader.standsFor(old.did), fresh.did);
  // A new card of the successor does not unsay whom it took over from.
  const again = hub.client(ids.fresh, following);
  assert.equal((await again.updateCard({ name: 'spammer', description: 'the same one' })).predecessor, old.did);
  await replayLog(structuredClone(hub.store.log), { hub: hub.did });

  // A hub that tells a reader that somebody else stands for an agent now is caught by the reader that follows its log.
  const mallory = generateIdentity().did;
  const lied = new AgentClient({
    hubUrl: hub.url, identity: generateIdentity(), ...following,
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      if (new URL(url).pathname !== `/v1/agents/${encodeURIComponent(ids.carol.did)}`) return res;
      return new Response(JSON.stringify({ ...(await res.json()), status: 'revoked', succeeded_by: mallory }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => lied.close());
  await assert.rejects(lied.standsFor(ids.carol.did), (err) => err instanceof LogError && err.code === 'log_mismatch');
});

// A private topic goes with its owner too, and it is the one thing that cannot simply change hands: whoever
// had the key of the first owner could read it. The successor gives it a new key, or a new group.
const SECRET = { name: 'acme.incidents.private', description: 'Incidentes', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } };
const titles = async (client) => (await client.poll()).messages.map((message) => message.data.title);

for (const [kind, state] of [['a topic key', () => ({})], ['MLS', () => ({ state: memoryStateStore() })]]) {
  test(`a private topic over ${kind} goes with its owner to the successor, which shuts the first out of it`, async (t) => {
    const hub = await startHub(t);
    const member = (name, more = {}) => hub.agent(name, generateIdentity(), { ...following, ...state(), ...more });
    const old = await member('owner');
    const alice = await member('alice');
    const bob = await member('bob');
    const blind = await member('blind', { followLog: false }); // a member that does not follow the log of the hub
    const topic = await old.createTopic({ ...SECRET, private: true, members: [alice.did, blind.did] });
    assert.equal(topic.encryption, state().state ? 'mls-v1' : 'group-v1');
    for (const reader of [alice, blind]) await reader.subscribe(SECRET.name);
    await old.publish(SECRET.name, { type: 'incident', data: { title: 'before' } });
    assert.deepEqual([await titles(alice), await titles(blind)], [['before'], ['before']]);

    const fresh = await member('owner');
    const taken = await fresh.takeOver(old.did, await old.handOver(fresh.did));
    assert.deepEqual([taken.reopened, taken.not_reopened], [[SECRET.name], []]);
    // Its members are those it had, with the successor where the first was.
    const listed = await fresh.topicMembers(SECRET.name);
    assert.deepEqual([...listed.members].sort(), [fresh.did, alice.did, blind.did].sort());
    if (listed.readers) assert.ok(!listed.readers.includes(old.did), 'the readers of the first owner are not in the group its successor made');

    // What is written from now on is read by whoever can tell that the topic changed hands: the log says so.
    await fresh.subscribe(SECRET.name);
    await fresh.publish(SECRET.name, { type: 'incident', data: { title: 'after' } });
    assert.deepEqual(await titles(alice), ['after']);
    await alice.publish(SECRET.name, { type: 'incident', data: { title: 'from alice' } });
    assert.deepEqual(await titles(fresh), ['from alice']);
    // A member that does not follow the log has only the word of the hub for it, and a hub could give a topic
    // to anybody that way: it takes nothing from the new owner, and writes nothing.
    assert.deepEqual(await titles(blind), []);
    await assert.rejects(blind.publish(SECRET.name, { type: 'incident', data: { title: 'from blind' } }), /not the one this client (trusts|has)/);
    assert.deepEqual(await titles(alice), []);

    // Who is in it is the successor's to say from now on.
    await fresh.addTopicMembers(SECRET.name, [bob.did]);
    await bob.subscribe(SECRET.name);
    await bob.publish(SECRET.name, { type: 'incident', data: { title: 'from bob' } });
    assert.deepEqual([await titles(alice), await titles(fresh)], [['from bob'], ['from bob']]);
    await fresh.removeTopicMembers(SECRET.name, [alice.did]);
    await fresh.publish(SECRET.name, { type: 'incident', data: { title: 'without alice' } });
    assert.deepEqual([await titles(bob), await titles(alice)], [['without alice'], []]);
    // The owner a client has changes for a handing over that the log tells of, and for nothing else.
    bob.trustTopicOwner(SECRET.name, alice.did);
    await assert.rejects(bob.publish(SECRET.name, { type: 'incident', data: { title: 'for another owner' } }), /not the one this client trusts/);
    await replayLog(structuredClone(hub.store.log), { hub: hub.did });
  });
}

test('nothing more is written in the group the first owner made, even before its successor makes another', async (t) => {
  const hub = await startHub(t);
  const member = (name, more = {}) => hub.agent(name, generateIdentity(), { ...following, state: memoryStateStore(), ...more });
  const old = await member('owner');
  const alice = await member('alice');
  await old.createTopic({ ...SECRET, private: true, members: [alice.did] });
  await alice.subscribe(SECRET.name);
  await alice.publish(SECRET.name, { type: 'incident', data: { title: 'while it was the first owner\'s' } });
  const group = hub.store.topics.get(SECRET.name).mls.group;

  // A successor that does not follow the log cannot tell which topics came with the agent: it reopens none by itself.
  const fresh = await member('owner', { followLog: false });
  const taken = await fresh.takeOver(old.did, await old.handOver(fresh.did));
  assert.deepEqual([taken.reopened, taken.not_reopened, hub.store.topics.get(SECRET.name).mls.group], [[], [], group]);
  // The group on the hub is still the one the first owner made, with its readers in it. A member does not write there.
  assert.equal(await code(alice.publish(SECRET.name, { type: 'incident', data: { title: 'for whoever has the old key' } })), '409 not_in_group');
  assert.equal(hub.store.topics.get(SECRET.name).mls.group, group);
  // Until the successor does anything in the topic, which makes the next group.
  await fresh.rotateTopicKey(SECRET.name);
  assert.notEqual(hub.store.topics.get(SECRET.name).mls.group, group);
  await fresh.subscribe(SECRET.name);
  await alice.publish(SECRET.name, { type: 'incident', data: { title: 'for the successor' } });
  assert.deepEqual(await titles(fresh), ['for the successor']);

  // A hub that names another owner where it tells the group of the topic, and not where it tells the topic,
  // has nobody writing for that owner: who owns a topic is not taken from there.
  let lying = false;
  const carol = await member('carol', {
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      if (!lying || new URL(url).pathname !== `/v1/topics/${encodeURIComponent(SECRET.name)}/mls`) return res;
      return new Response(JSON.stringify({ ...(await res.json()), owner: alice.did }), { status: res.status, headers: { 'content-type': 'application/json' } });
    },
  });
  await fresh.addTopicMembers(SECRET.name, [carol.did]);
  await carol.publish(SECRET.name, { type: 'incident', data: { title: 'from carol' } });
  lying = true;
  await assert.rejects(carol.publish(SECRET.name, { type: 'incident', data: { title: 'for the owner the hub made up' } }), /not the one this client has/);
  assert.deepEqual(await titles(fresh), ['from carol']);
});
