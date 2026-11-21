import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, fileStateStore, generateIdentity, memoryStateStore } from '../src/sdk/index.mjs';
import { signEvent } from '../src/core/sign.mjs';
import { applyCommit, changeMembers, createGroup, createUpdate, decryptMessage, encryptMessage, generateKeyPackage, inspectMessage, joinGroup } from '../src/mls/member.mjs';
import { mayInvite, parseTopicGroupId, topicAad, topicGroupId, topicRule } from '../src/mls/topic.mjs';
import { errorText, instanceOf, rejects, signedFetch, startHub, topicStatement } from './helpers.mjs';

const TOPIC = 'acme.incidents.private';
const CONTRACT = {
  name: TOPIC,
  description: 'Incidentes internos de Acme, solo para el equipo de guardia',
  schema: { type: 'object', required: ['summary'], additionalProperties: false, properties: { summary: { type: 'string' }, severity: { type: 'integer' } } },
};
const MLS = { mls: true };
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const incident = (summary) => ({ type: 'incident', data: { summary } });
const summaries = (result) => result.messages.map((message) => message.data.summary);

/** A store that can be photographed: what a thief would walk away with at that moment. */
function observableStore() {
  const store = memoryStateStore();
  return { ...store, snapshot: () => new Map(store.keys().map((key) => [key, Buffer.from(store.get(key))])) };
}

/** An owner and two other agents, all keeping MLS state, on one hub. Nobody has made a topic yet. */
async function scene(t, options) {
  const hub = await startHub(t, options);
  const identities = { owner: generateIdentity(), alice: generateIdentity(), bob: generateIdentity() };
  const stores = { owner: observableStore(), alice: observableStore(), bob: observableStore() };
  const agents = {};
  for (const [name, identity] of Object.entries(identities)) agents[name] = await hub.agent(name, identity, { state: stores[name] });
  const group = () => hub.store.topics.get(TOPIC).mls;
  const epoch = () => hub.store.mlsLog(group().group).epoch;
  /** The last event the hub holds for a reader that has not picked it up yet. */
  const lastFor = (client) => hub.store.pending(client.instanceDid ?? client.did).at(-1).envelope.event;
  return { hub, identities, stores, group, epoch, lastFor, ...agents };
}

test('topic groups: their names, what ties a message to its envelope, and who may change the members', () => {
  const id = topicGroupId(TOPIC, 3);
  assert.deepEqual(parseTopicGroupId(id), { topic: TOPIC, generation: 3 });
  assert.notEqual(id, topicGroupId(TOPIC, 3), 'every group has a name of its own');
  const malformed = [null, 42, '', 'agenthub/dm/v1|a|b|1|AAAAAAAAAAAAAAAA', `${id}|more`, id.replace('|3|', '|0|'), id.replace('|3|', '|x|'), id.slice(0, -1), `agenthub/topic/v1||1|${'A'.repeat(16)}`, 'x'.repeat(500)];
  for (const bad of malformed) assert.equal(parseTopicGroupId(bad), null, String(bad).slice(0, 60));
  const text = (aad) => new TextDecoder().decode(aad);
  assert.equal(text(topicAad(TOPIC, 'did:key:a', 'e1')), `agenthub/topic/v1\n${TOPIC}\ndid:key:a\ne1`);

  const member = (agent, instance = null) => ({ agent, instance, reader: instance ?? agent });
  const rule = topicRule('did:key:owner');
  // The owner's readers decide: anybody in, anybody out.
  assert.equal(rule({ sender: member('did:key:owner'), added: [member('did:key:x')], removed: [member('did:key:y')] }), true);
  assert.equal(rule({ sender: member('did:key:owner', 'did:key:owner-laptop'), added: [member('did:key:x')], removed: [] }), true);
  // Anybody else: its own instances, and nobody else's.
  assert.equal(rule({ sender: member('did:key:a'), added: [member('did:key:a', 'did:key:a-laptop')], removed: [member('did:key:a', 'did:key:a-old')] }), true);
  assert.equal(rule({ sender: member('did:key:a'), added: [member('did:key:x')], removed: [] }), false);
  assert.equal(rule({ sender: member('did:key:a'), added: [], removed: [member('did:key:owner')] }), false);
  assert.equal(rule({ sender: member('did:key:a'), added: [member('did:key:a', 'did:key:a-laptop'), member('did:key:x')], removed: [] }), false, 'one stranger among its own is enough');
  // An invitation: from the owner, or from the agent that is being invited (another of its readers).
  assert.equal(mayInvite('did:key:owner', member('did:key:owner'), 'did:key:a'), true);
  assert.equal(mayInvite('did:key:owner', member('did:key:a', 'did:key:a-laptop'), 'did:key:a'), true);
  assert.equal(mayInvite('did:key:owner', member('did:key:x'), 'did:key:a'), false);
});

test('a private topic over MLS: every reader of its members reads, the hub and everybody else see ciphertext', async (t) => {
  const { hub, identities, stores, owner, alice, bob, group, epoch, lastFor } = await scene(t);
  const laptop = hub.client(instanceOf(identities.alice), MLS);
  await laptop.registerInstance();

  const topic = await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did] });
  assert.deepEqual([topic.encryption, topic.epoch, topic.members, topic.owner], ['mls-v1', 1, 2, owner.did]);
  assert.deepEqual((await owner.info()).topic_encryption, { supported: ['mls-v1', 'group-v1'], max_members: 100, max_group_readers: 50 });
  // One group, with every reader of the two agents: the key of each, and alice's instance.
  assert.deepEqual([group().generation, group().agents, group().members], [1, [owner.did, alice.did], [owner.did, alice.did, laptop.instanceDid]]);
  assert.deepEqual(parseTopicGroupId(group().group), { topic: TOPIC, generation: 1 });

  await alice.subscribe(TOPIC);
  await owner.subscribe(TOPIC);
  const receipt = await owner.publish(TOPIC, incident('disco lleno en db-3'));
  assert.equal(receipt.delivered_to, 1, 'one agent: alice, with her two readers');
  for (const reader of [alice, laptop]) {
    const [got] = (await reader.poll()).messages;
    assert.deepEqual([got.data.summary, got.type, got.encrypted, got.encryption, got.sender, got.topic], ['disco lleno en db-3', 'incident', true, 'mls-v1', owner.did, TOPIC]);
  }
  // Any reader of a member publishes, and it shows which one did.
  await laptop.publish(TOPIC, incident('lo miro yo'));
  const [reply] = (await owner.poll()).messages;
  assert.deepEqual([reply.data.summary, reply.sender, reply.instance], ['lo miro yo', alice.did, laptop.instanceDid]);
  assert.deepEqual((await alice.poll()).messages, [], 'an agent does not receive what it publishes, whichever of its readers did');

  // What the hub holds and hands on: who, where and when, and nothing of what was said. It keeps
  // no history either: the keys that open an event are used once, so it could serve nothing later.
  await owner.publish(TOPIC, incident('resuelto'));
  const stored = lastFor(alice);
  assert.deepEqual([stored.type, stored.encryption, stored.subject, Object.keys(stored.data)], ['agenthub.encrypted', 'mls-v1', TOPIC, ['group', 'message']]);
  assert.deepEqual(await inspectMessage(bytes(stored.data.message)), { wireformat: 'private_message', groupId: group().group, epoch: 1, contentType: 'application' });
  assert.ok(!JSON.stringify(hub.store.pending(alice.did)).includes('resuelto'));
  assert.deepEqual((await owner.topicHistory(TOPIC)).events, []);
  assert.deepEqual(hub.store.topics.get(TOPIC).events, []);
  assert.equal(epoch(), 1, 'nothing so far needed a commit');

  // Who is in it, a member reads from its own state of the group: it does not have to believe the hub.
  const expected = { topic: TOPIC, epoch: 1, members: [owner.did, alice.did], readers: [owner.did, alice.did, laptop.instanceDid] };
  assert.deepEqual(await alice.topicMembers(TOPIC), expected);
  assert.deepEqual(await laptop.topicMembers(TOPIC), expected);

  // An event the hub delivers twice is handed over once, and the second time is not a failure:
  // the key that opened it is gone, as it should be.
  let acknowledge = false;
  const forgetful = async (url, init) => {
    if (!acknowledge && new URL(url).pathname === '/v1/inbox/ack') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    return fetch(url, init);
  };
  const twice = hub.client(identities.alice, { state: stores.alice, fetch: forgetful });
  assert.deepEqual(summaries(await twice.poll()), ['resuelto']);
  const redelivered = await twice.poll();
  assert.deepEqual([redelivered.messages, redelivered.errors], [[], []]);
  acknowledge = true;
  await twice.poll();

  // The contract still holds, checked by whoever publishes.
  await rejects(owner.publish(TOPIC, { type: 'incident', data: { summary: 42 } }), 422, 'schema_validation_failed');
  // Whoever is not a member neither reads nor writes nor finds out who is.
  await rejects(bob.subscribe(TOPIC), 403, 'subscribe_not_allowed');
  await rejects(bob.publish(TOPIC, incident('desde fuera')), 403, 'not_a_member');
  await rejects(bob.topicMembers(TOPIC), 403, 'not_a_member');
  await rejects(bob.addTopicMembers(TOPIC, [bob.did]), 403, 'not_owner');
  await rejects(alice.addTopicMembers(TOPIC, [bob.did]), 403, 'not_owner');
});

test('the owner brings agents in and leaves them out: who comes reads from then on, who goes reads no more', async (t) => {
  const { hub, stores, owner, alice, bob, group, epoch, lastFor } = await scene(t);
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did] });
  await alice.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('antes de bob'));
  assert.deepEqual(summaries(await alice.poll()), ['antes de bob']);

  // Bob comes in: a commit, and with it a new epoch. He reads what is said from here on.
  const added = await owner.addTopicMembers(TOPIC, [bob.did]);
  assert.deepEqual([added.topic, added.epoch, added.members, added.readers], [TOPIC, 2, 3, 3]);
  assert.deepEqual([epoch(), group().generation, group().agents, group().members], [2, 1, [owner.did, alice.did, bob.did], [owner.did, alice.did, bob.did]]);
  await bob.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('con bob'));
  assert.deepEqual(summaries(await bob.poll()), ['con bob']);
  assert.deepEqual(summaries(await alice.poll()), ['con bob'], 'alice followed the commit on her own');
  await bob.publish(TOPIC, incident('hola a todos'));
  assert.deepEqual(summaries(await alice.poll()), ['hola a todos']);
  assert.deepEqual((await bob.topicMembers(TOPIC)).members, [owner.did, alice.did, bob.did]);
  assert.deepEqual(await owner.addTopicMembers(TOPIC, [bob.did]), { ...added, group: group().group }, 'bringing in who is already in changes nothing');
  assert.equal(epoch(), 2);

  // Alice goes. Somebody had copied her state while she was in: neither she nor the copy reads what follows.
  const copy = stores.alice.snapshot().get(`group/${group().group}`);
  const removed = await owner.removeTopicMembers(TOPIC, [alice.did]);
  assert.deepEqual([removed.epoch, removed.members], [3, 2]);
  assert.deepEqual([group().agents, group().members], [[owner.did, bob.did], [owner.did, bob.did]]);
  assert.deepEqual(await alice.subscriptions(), [], 'the hub stops delivering to her at once');
  await owner.publish(TOPIC, incident('sin alice'));
  const after = lastFor(bob);
  assert.deepEqual(summaries(await bob.poll()), ['sin alice']);
  assert.deepEqual((await alice.poll()).messages, []);
  await assert.rejects(decryptMessage(copy, bytes(after.data.message), topicAad(TOPIC, owner.did, after.id)), /epoch this member has not reached/);
  const leaving = hub.store.mlsLog(group().group).commits.find((entry) => entry.epoch === 2);
  await assert.rejects(applyCommit(copy, bytes(leaving.message), { mayChange: topicRule(owner.did) }), (err) => err.code === 'left_out');
  await rejects(alice.publish(TOPIC, incident('sigo aquí')), 403, 'not_a_member');
  await rejects(alice.subscribe(TOPIC), 403, 'subscribe_not_allowed');
  // The owner is always a member, whatever it is asked.
  await owner.removeTopicMembers(TOPIC, [owner.did]);
  assert.deepEqual(group().agents, [owner.did, bob.did]);

  // Brought in again, she joins the group as it is now, with a new invitation, and carries on.
  await owner.addTopicMembers(TOPIC, [alice.did]);
  await alice.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('de vuelta'));
  assert.deepEqual(summaries(await alice.poll()), ['de vuelta']);
  await alice.publish(TOPIC, incident('gracias'));
  assert.deepEqual(summaries(await bob.poll()), ['de vuelta', 'gracias']);
  assert.equal(group().generation, 1, 'the same group all along');

  // Somebody invited, left out and invited again before ever looking: only the last invitation counts.
  const dora = await hub.agent('dora', generateIdentity(), MLS);
  await owner.addTopicMembers(TOPIC, [dora.did]);
  await owner.removeTopicMembers(TOPIC, [dora.did]);
  await owner.addTopicMembers(TOPIC, [dora.did]);
  assert.equal(hub.store.welcomes.get(dora.did).length, 1);
  await dora.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('para dora'));
  assert.deepEqual(summaries(await dora.poll()), ['para dora']);
  await owner.removeTopicMembers(TOPIC, [dora.did]);

  // An agent that cannot take part in MLS cannot be a member, and nothing changes for trying.
  const carol = await hub.agent('carol');
  const before = epoch();
  const refused = await rejects(owner.addTopicMembers(TOPIC, [carol.did]), 422, 'member_cannot_mls');
  assert.deepEqual(refused.details.members, [carol.did]);
  await rejects(owner.addTopicMembers(TOPIC, [generateIdentity().did]), 404, 'member_not_found');
  assert.deepEqual([epoch(), group().agents.length], [before, 3]);
});

test('instances come and go without the owner: every agent looks after its own', async (t) => {
  const { hub, identities, owner, alice, bob, group, lastFor } = await scene(t);
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did, bob.did] });
  for (const client of [owner, alice, bob]) await client.subscribe(TOPIC);

  // Alice starts an instance. It is not in the group yet, and it cannot let itself in.
  const tabletStore = observableStore();
  const tablet = hub.client(instanceOf(identities.alice), { state: tabletStore });
  await tablet.registerInstance();
  await rejects(tablet.publish(TOPIC, incident('desde la tableta')), 409, 'not_in_group');
  assert.deepEqual(group().members, [owner.did, alice.did, bob.did]);
  // Alice brings it in herself the next time she writes: it is hers. The owner does nothing.
  await alice.publish(TOPIC, incident('con la tableta'));
  assert.deepEqual(group().members, [owner.did, alice.did, bob.did, tablet.instanceDid]);
  assert.deepEqual((await tablet.poll()).messages, [], 'what its own agent publishes does not come back to it');
  await owner.publish(TOPIC, incident('para todos'));
  assert.deepEqual(summaries(await tablet.poll()), ['para todos']);
  await tablet.publish(TOPIC, incident('ya estoy'));
  assert.deepEqual(
    (await bob.poll()).messages.map((message) => [message.data.summary, message.instance]),
    [
      ['con la tableta', null],
      ['para todos', null],
      ['ya estoy', tablet.instanceDid],
    ],
  );

  // Bob starts a laptop. Alice is the first to write: it is not hers to bring in, and she does not
  // try. Until it is in the group the hub hands it nothing: it could not open it.
  const laptop = hub.client(instanceOf(identities.bob), MLS);
  await laptop.registerInstance();
  await alice.publish(TOPIC, incident('de alice'));
  assert.ok(!group().members.includes(laptop.instanceDid));
  assert.equal(hub.store.pending(laptop.instanceDid).length, 0);
  assert.equal(hub.store.pending(bob.did).length, 1, 'bob\'s own key, which is in the group, does get it');
  // The owner brings in everybody's readers, and does when it next writes.
  await owner.publish(TOPIC, incident('con el portátil de bob'));
  assert.ok(group().members.includes(laptop.instanceDid));
  assert.deepEqual(summaries(await laptop.poll()), ['con el portátil de bob']);

  // The tablet is lost, and alice removes it. Whoever uses the topic next and may, leaves it out
  // of the group: here the owner. A copy of its state reads nothing that is said afterwards.
  const copy = tabletStore.snapshot().get(`group/${group().group}`);
  await alice.removeInstance(tablet.instanceDid);
  await owner.publish(TOPIC, incident('sin la tableta'));
  assert.ok(!group().members.includes(tablet.instanceDid));
  assert.deepEqual((await owner.topicMembers(TOPIC)).readers, [owner.did, alice.did, bob.did, laptop.instanceDid]);
  const last = lastFor(alice);
  await assert.rejects(decryptMessage(copy, bytes(last.data.message), topicAad(TOPIC, owner.did, last.id)), /epoch this member has not reached/);
  assert.deepEqual(summaries(await alice.poll()), ['para todos', 'con el portátil de bob', 'sin la tableta']);

  // An agent leaves out its own lost instance too, when it is the first to notice.
  await bob.removeInstance(laptop.instanceDid);
  await bob.poll();
  await bob.publish(TOPIC, incident('sin mi portátil'));
  assert.deepEqual(group().members, [owner.did, alice.did, bob.did]);
  assert.deepEqual(summaries(await owner.poll()).at(-1), 'sin mi portátil');

  // A member whose only reader goes stays a member, with nobody in the group, and that stops nobody
  // else. Carol's agent key keeps no MLS state: her server is all she has there, until it is removed.
  const carolIdentity = generateIdentity();
  const carol = await hub.agent('carol', carolIdentity);
  const server = hub.client(instanceOf(carolIdentity), MLS);
  await server.registerInstance();
  await owner.addTopicMembers(TOPIC, [carol.did]);
  assert.deepEqual([group().agents.includes(carol.did), group().members.includes(server.instanceDid)], [true, true]);
  await carol.removeInstance(server.instanceDid);
  await owner.publish(TOPIC, incident('sin el servidor de carol'));
  assert.deepEqual([group().agents, group().members], [[owner.did, alice.did, bob.did, carol.did], [owner.did, alice.did, bob.did]]);
  // When she has a reader again, it comes in on its own.
  const replacement = hub.client(instanceOf(carolIdentity), MLS);
  await replacement.registerInstance();
  await carol.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('con el servidor nuevo'));
  assert.deepEqual(summaries(await replacement.poll()), ['con el servidor nuevo']);
});

test('only the owner decides who is a member: the hub holds members to that, and members hold the hub to it', async (t) => {
  const { hub, identities, stores, owner, alice, bob, group, epoch } = await scene(t);
  const malloryIdentity = generateIdentity();
  const mallory = await hub.agent('mallory', malloryIdentity, MLS);
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did, bob.did] });
  for (const client of [owner, alice, bob]) await client.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('uno'));
  assert.deepEqual([summaries(await alice.poll()), summaries(await bob.poll())], [['uno'], ['uno']]);
  const first = group().group;
  const path = `/v1/topics/${TOPIC}/mls`;
  const asAlice = (method, route, body) => signedFetch(hub, identities.alice, method, route, body);

  // Alice's software misbehaves: it wants mallory in. The hub will not hand it mallory's key packages...
  assert.equal((await asAlice('POST', `${path}/key-packages`, { readers: [mallory.did] })).code, 'not_owner');
  // ...so mallory gives it one directly, and it makes a real commit that brings her in. Told what
  // the commit does, the hub turns it away.
  const hers = await generateKeyPackage(malloryIdentity);
  const rogue = await changeMembers(stores.alice.get(`group/${first}`), { add: [hers.bytes] });
  const honest = { group: first, message: b64(rogue.commit), members: [...group().members, mallory.did], invited: [mallory.did], welcome: b64(rogue.welcome) };
  assert.equal((await asAlice('POST', `${path}/commits`, honest)).code, 'invalid_group', 'mallory is not a reader of a member agent');
  assert.equal((await asAlice('POST', `${path}/commits`, { ...honest, agents: [...group().agents, mallory.did] })).code, 'not_owner');
  assert.equal(epoch(), 1);
  // Told nothing - as if it only renewed keys - the hub takes it: it cannot see inside a commit.
  assert.equal((await asAlice('POST', `${path}/commits`, { group: first, message: b64(rogue.commit) })).status, 201);
  assert.deepEqual([epoch(), group().members.includes(mallory.did)], [2, false]);

  // The members can see inside it, and none of them goes along. For bob the group is now of no use.
  await rejects(bob.publish(TOPIC, incident('dos')), 409, 'not_in_group');
  // Mallory holds an invitation that opens. It says who made it, and by the rule of the topic that is nobody who could.
  const joined = await joinGroup(malloryIdentity, rogue.welcome, hers.secret);
  assert.deepEqual([joined.inviter.agent, mayInvite(owner.did, joined.inviter, mallory.did)], [alice.did, false]);
  // The owner cannot follow either, and it is the one who can do something about it: it makes the
  // group again, with the members there were. Mallory is not among them.
  await owner.publish(TOPIC, incident('tres'));
  assert.deepEqual([group().generation, group().agents, group().members], [2, [owner.did, alice.did, bob.did], [owner.did, alice.did, bob.did]]);
  assert.deepEqual(summaries(await bob.poll()), ['tres']);
  await bob.publish(TOPIC, incident('cuatro'));
  assert.deepEqual(summaries(await owner.poll()), ['cuatro']);
  // In the group she forked, mallory reads what alice's software sends there and nothing else: nobody else is in it.
  const forked = await encryptMessage(rogue.state, new TextEncoder().encode('solo para mallory'), new Uint8Array());
  assert.equal(new TextDecoder().decode((await decryptMessage(joined.state, forked.message, new Uint8Array())).plaintext), 'solo para mallory');

  // A hub that lies. Carol is brought in by the owner, and before she opens her invitation the hub
  // shows her another one: to a group with the right name that alice made. She does not go in.
  const carolIdentity = generateIdentity();
  const carolStore = memoryStateStore();
  const carol = await hub.agent('carol', carolIdentity, { state: carolStore });
  await owner.addTopicMembers(TOPIC, [carol.did]);
  const fakeGroup = topicGroupId(TOPIC, 3);
  const fake = await createGroup(identities.alice, fakeGroup, [bytes(hub.store.keyPackages.get(carol.did)[0])]);
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const lying = async (url, init) => {
    const res = await fetch(url, init);
    const route = new URL(url).pathname;
    if (init.method !== 'GET') return res;
    if (route === '/v1/mls/welcomes') return reply({ welcomes: [{ group: fakeGroup, welcome: b64(fake.welcome) }] });
    if (route === path) return reply({ ...(await res.json()), group: fakeGroup, generation: 3, epoch: 1 });
    return res;
  };
  const deceived = hub.client(carolIdentity, { state: carolStore, fetch: lying });
  await assert.rejects(deceived.publish(TOPIC, incident('para el grupo falso')), /the invitation to the group of acme\.incidents\.private was made by did:key:\S+, who neither owns the topic nor is this agent/);
  assert.equal(carolStore.get(`group/${fakeGroup}`), null, 'nothing of that group was kept');
  // With the hub telling the truth she joins the real one.
  await carol.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('cinco'));
  assert.deepEqual(summaries(await carol.poll()), ['cinco']);

  // Who owns a topic, a reader writes down with its group. After a restart, a hub that names
  // somebody else - who could then invite and expel at will - is not believed.
  const renamed = async (url, init) => {
    const res = await fetch(url, init);
    return init.method === 'GET' && new URL(url).pathname === `/v1/topics/${TOPIC}` ? reply({ ...(await res.json()), owner: mallory.did }) : res;
  };
  const restarted = hub.client(identities.bob, { state: stores.bob, fetch: renamed, followLog: false });
  await assert.rejects(restarted.publish(TOPIC, incident('seis')), /the hub names an owner of acme\.incidents\.private that is not the one this client trusts, did:key:/);
  const unread = await restarted.poll();
  assert.deepEqual([unread.messages.length, unread.errors.length > 0], [0, true], 'nor does it read what such a hub hands it');
  // A reader that follows the log of the hub catches the same lie sooner: the log says who owns the topic.
  const following = hub.client(identities.bob, { state: stores.bob, fetch: renamed });
  await assert.rejects(following.publish(TOPIC, incident('siete')), (err) => err.code === 'log_mismatch' && /the hub shows an owner of acme\.incidents\.private that is not the one in its log, which is did:key:/.test(err.message));
});

test('a hub that lies about the group of a topic is not believed', async (t) => {
  const { hub, identities, stores, owner, alice, bob, group, epoch } = await scene(t);
  const mallory = await hub.agent('mallory', generateIdentity(), MLS);
  const OTHER = 'acme.other.private';
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did, bob.did] });
  await owner.createTopic({ ...CONTRACT, name: OTHER, private: true, members: [alice.did, mallory.did] });
  for (const client of [owner, alice, bob]) await client.subscribe(TOPIC);
  await alice.subscribe(OTHER);
  await owner.publish(TOPIC, incident('uno'));
  await owner.publish(OTHER, incident('otro'));
  assert.deepEqual([summaries(await alice.poll()), summaries(await bob.poll())], [['uno', 'otro'], ['uno']]);
  const other = hub.store.topics.get(OTHER).mls.group;
  const view = `/v1/topics/${TOPIC}/mls`;
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  /** A client for `name` on a hub that answers GET `route` with `rewrite(what it would have answered)`. */
  const deceived = (name, route, rewrite, method = 'GET') =>
    hub.client(identities[name], {
      state: stores[name],
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        return init.method === method && new URL(url).pathname === route ? reply(rewrite(await res.json())) : res;
      },
    });

  // "The group of this topic is that one": the group of another topic of the same owner, which
  // alice is in, and so is mallory. What alice writes here must not be read there.
  const swapped = deceived('alice', view, (real) => ({ ...real, group: other, generation: 1, epoch: 1 }));
  await assert.rejects(swapped.publish(TOPIC, incident('para quien no debe')), /the hub names a group that is not of acme\.incidents\.private/);
  assert.equal(hub.store.pending(mallory.did).length, 0);

  // An event that says it is of another group. Alice's software, which is in both, encrypts in the
  // other one and the hub delivers it here. Whoever reads looks at which group it claims first.
  const stray = { specversion: '1.0', id: 'stray-1', source: alice.did, type: 'agenthub.encrypted', time: new Date().toISOString(), subject: TOPIC, encryption: 'mls-v1' };
  const sealed = await encryptMessage(stores.alice.get(`group/${other}`), new TextEncoder().encode(JSON.stringify(incident('colado'))), topicAad(TOPIC, alice.did, stray.id));
  hub.store.commit({ type: 'event.publish', topic: TOPIC, envelope: signEvent({ ...stray, data: { group: other, message: b64(sealed.message) } }, identities.alice), recipients: [owner.did], tier: 'key', at: new Date().toISOString() });
  const strayed = await owner.poll();
  assert.deepEqual([strayed.messages, strayed.errors.map(errorText)], [[], ['cannot decrypt (that group is not the group of this topic)']]);

  // An invitation to one group handed over as the invitation to another. Carol is invited to both
  // topics and has opened neither: the hub gives her the one to the other topic as if it were to this.
  const carolIdentity = generateIdentity();
  identities.carol = carolIdentity;
  stores.carol = memoryStateStore();
  const carol = await hub.agent('carol', carolIdentity, { state: stores.carol });
  await owner.addTopicMembers(TOPIC, [carol.did]);
  await owner.addTopicMembers(OTHER, [carol.did]);
  const toOther = hub.store.welcomes.get(carol.did).find((entry) => entry.group === other).welcome;
  const mislabelled = deceived('carol', '/v1/mls/welcomes', () => ({ welcomes: [{ group: group().group, welcome: toOther }] }));
  await assert.rejects(mislabelled.publish(TOPIC, incident('x')), /the invitation is to a different group than the hub said/);
  assert.equal(stores.carol.get(`group/${group().group}`), null);
  await carol.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('dos'));
  assert.deepEqual(summaries(await carol.poll()), ['dos'], 'the real invitation still opens');

  // A key package of somebody who is not to be a member, slipped in among those the owner asked for.
  const dave = await hub.agent('dave', generateIdentity(), MLS);
  const before = epoch();
  const generous = deceived('owner', `${view}/key-packages`, (real) => ({ key_packages: [...real.key_packages, { reader: mallory.did, key_package: hub.store.keyPackages.get(mallory.did)[0] }] }), 'POST');
  await assert.rejects(generous.addTopicMembers(TOPIC, [dave.did]), /the hub handed out a key package that does not belong to this topic/);
  // Or one of the right reader that is somebody else's key.
  const swappedKeys = deceived('owner', `${view}/key-packages`, (real) => ({ key_packages: real.key_packages.map((entry) => ({ ...entry, key_package: hub.store.keyPackages.get(mallory.did)[0] })) }), 'POST');
  await assert.rejects(swappedKeys.addTopicMembers(TOPIC, [dave.did]), /the hub handed out a key package that does not belong to this topic/);
  // Or one that is of the agent asked about, under the name of another of its readers: the hub is
  // not making sense, and nothing is built on what it says.
  const daveIdentity = generateIdentity();
  const erin = await hub.agent('erin', daveIdentity, MLS);
  const erinLaptop = hub.client(instanceOf(daveIdentity), MLS);
  await erinLaptop.registerInstance();
  const laptopPackage = hub.store.keyPackages.get(erinLaptop.instanceDid)[0];
  const misnamed = deceived('owner', `${view}/key-packages`, (real) => ({ key_packages: real.key_packages.map((entry) => (entry.reader === erin.did ? { ...entry, key_package: laptopPackage } : entry)) }), 'POST');
  await assert.rejects(misnamed.addTopicMembers(TOPIC, [erin.did]), /the hub handed out a key package that does not belong to this topic/);
  assert.deepEqual([epoch(), group().members.includes(mallory.did), group().agents.includes(dave.did), group().agents.includes(erin.did)], [before, false, false, false]);

  // Or one of the agent asked about, of a reader that was not asked for: an instance that the agent
  // removed, which the hub no longer lists and hands out all the same. Only the readers asked for get in.
  const frankIdentity = generateIdentity();
  const frank = await hub.agent('frank', frankIdentity, MLS);
  const frankOldIdentity = instanceOf(frankIdentity);
  const frankOld = hub.client(frankOldIdentity, MLS);
  await frankOld.registerInstance();
  await frank.removeInstance(frankOld.instanceDid);
  const unasked = { reader: frankOld.instanceDid, key_package: b64((await generateKeyPackage(frankOldIdentity)).bytes) };
  const lavish = deceived('owner', `${view}/key-packages`, (real) => ({ key_packages: [...real.key_packages, unasked] }), 'POST');
  await lavish.addTopicMembers(TOPIC, [frank.did]);
  assert.deepEqual([group().agents.includes(frank.did), group().members.includes(frank.did), group().members.includes(frankOld.instanceDid)], [true, true, false]);

  // A reader left out of the list of its own agent's readers does not, for that, leave itself out.
  const omitted = deceived('alice', view, (real) => ({ ...real, readers: { ...real.readers, [alice.did]: [] } }));
  await omitted.publish(TOPIC, incident('sigo dentro'));
  assert.ok(group().members.includes(alice.did));
  assert.deepEqual(summaries(await bob.poll()), ['dos', 'sigo dentro']);

  // Who is in the topic, a reader in the group takes from the group and not from the hub.
  const padded = deceived('bob', `/v1/topics/${TOPIC}/members`, (real) => ({ ...real, members: [...real.members, mallory.did], readers: [...real.readers, mallory.did] }));
  assert.deepEqual((await padded.topicMembers(TOPIC)).members, [owner.did, alice.did, bob.did, carol.did, frank.did]);

  // The owner loses its state and makes the group again: the topic is at its second group, and
  // alice keeps both. A hub that takes her back to the first - where whoever was in it then
  // reads, with the keys there were then - or to none, is not followed there.
  const earlier = { group: group().group, generation: 1, epoch: epoch() };
  await alice.poll();
  stores.owner.delete(`group/${earlier.group}`);
  await owner.publish(TOPIC, incident('tres'));
  assert.deepEqual([group().generation, summaries(await alice.poll())], [2, ['tres']]);
  for (const said of [earlier, { group: null, generation: 0, epoch: 0 }]) {
    const back = deceived('alice', view, (real) => ({ ...real, ...said }));
    const refused = await rejects(back.publish(TOPIC, incident('hacia atrás')), 409, 'mls_rollback_refused');
    assert.equal(refused.fromHub, false);
  }
  assert.deepEqual(summaries(await bob.poll()), ['tres'], 'and nothing was published on the way');
});

test('the hub checks what it can of the group of a topic: who makes it, who is in it, and what each commit says it does', async (t) => {
  const hub = await startHub(t, { maxTopicGroupReaders: 4 });
  const ids = { owner: generateIdentity(), alice: generateIdentity(), bob: generateIdentity(), carol: generateIdentity(), mallory: generateIdentity() };
  const clients = {};
  for (const [name, identity] of Object.entries(ids)) clients[name] = await hub.agent(name, identity);
  const as = (identity) => (method, route, body) => signedFetch(hub, identity, method, route, body);
  const path = `/v1/topics/${TOPIC}/mls`;
  const did = Object.fromEntries(Object.entries(ids).map(([name, identity]) => [name, identity.did]));
  /** Publishes one KeyPackage for `identity` and returns it with its secret. */
  const packageOf = async (identity) => {
    const made = await generateKeyPackage(identity);
    const signer = identity.instance ?? identity;
    assert.equal((await signedFetch(hub, signer, 'POST', '/v1/mls/key-packages', { key_packages: [b64(made.bytes)] })).status, 201);
    return made;
  };
  const packages = {};
  for (const name of ['owner', 'alice', 'bob', 'carol', 'mallory']) packages[name] = await packageOf(ids[name]);

  // A topic says how it is encrypted when it is made, and that does not change.
  assert.equal((await as(ids.owner)('POST', '/v1/topics', { ...CONTRACT, name: 'acme.other.topic', encryption: 'rot13' })).code, 'invalid_topic');
  assert.equal((await as(ids.owner)('POST', '/v1/topics', { ...CONTRACT, name: 'acme.other.topic', encryption: 'mls-v1', subscribe: { min_tier: 'org' } })).code, 'invalid_topic');
  const private_ = { ...CONTRACT, encryption: 'mls-v1' };
  const created = await as(ids.owner)('POST', '/v1/topics', { ...private_, statement: topicStatement(hub, ids.owner, private_) });
  assert.deepEqual([created.status, created.json.encryption, created.json.epoch, created.json.members], [201, 'mls-v1', 0, 0]);
  // It has no key for its owner to hand out.
  assert.equal((await as(ids.owner)('PUT', `/v1/topics/${TOPIC}/keys`, { epoch: 1, grants: [] })).code, 'not_keyed');
  assert.equal((await as(ids.owner)('GET', `/v1/topics/${TOPIC}/keys`)).code, 'not_keyed');
  assert.equal((await as(ids.owner)('GET', '/v1/topics/acme.missing.topic/mls')).code, 'topic_not_found');

  // Before the group exists: the owner sees who could be in it, and nobody can publish.
  const empty = { topic: TOPIC, owner: did.owner, group: null, generation: 0, epoch: 0, agents: [did.owner], members: [], readers: { [did.owner]: [did.owner] }, rejoin: [] };
  assert.deepEqual((await as(ids.owner)('GET', path)).json, empty);
  assert.deepEqual((await as(ids.owner)('GET', `${path}?agents=${did.alice},${did.bob}`)).json.readers, { [did.owner]: [did.owner], [did.alice]: [did.alice], [did.bob]: [did.bob] });
  assert.equal((await as(ids.owner)('GET', `${path}?agents=${generateIdentity().did}`)).code, 'member_not_found');
  assert.equal((await as(ids.alice)('GET', path)).code, 'not_a_member');
  assert.equal((await as(ids.alice)('GET', `${path}/commits`)).code, 'not_a_member');
  assert.equal((await as(ids.owner)('GET', `${path}/commits`)).code, 'group_not_found');

  // Key packages for the group: the owner takes them from anybody, one per reader, and not its own.
  const claim = (identity, readers) => as(identity)('POST', `${path}/key-packages`, { readers });
  assert.equal((await claim(ids.owner, [])).code, 'invalid_group');
  assert.equal((await claim(ids.owner, 'everybody')).code, 'invalid_group');
  assert.equal((await claim(ids.owner, [did.owner])).code, 'invalid_group');
  assert.equal((await claim(ids.owner, [did.alice, did.alice])).code, 'invalid_group');
  assert.equal((await claim(ids.owner, [generateIdentity().did])).code, 'member_not_found');
  assert.equal((await claim(ids.alice, [did.bob])).code, 'not_a_member');
  const handed = (await claim(ids.owner, [did.alice, did.bob])).json.key_packages;
  assert.deepEqual(handed, [
    { reader: did.alice, key_package: b64(packages.alice.bytes) },
    { reader: did.bob, key_package: b64(packages.bob.bytes) },
  ]);

  // Making the group: only the owner, for the next generation, with an id that names the topic,
  // member agents that exist, readers that are theirs, and an invitation for each reader but its maker.
  const group = topicGroupId(TOPIC, 1);
  const made = await createGroup(ids.owner, group, [packages.alice.bytes, packages.bob.bytes]);
  const good = { group, generation: 1, agents: [did.owner, did.alice, did.bob], members: [did.owner, did.alice, did.bob], welcome: b64(made.welcome) };
  const make = (identity, changes) => as(identity)('PUT', path, { ...good, ...changes });
  assert.equal((await make(ids.alice, {})).code, 'not_owner');
  assert.equal((await make(ids.owner, { generation: 2 })).code, 'stale_generation');
  assert.equal((await make(ids.owner, { group: topicGroupId('acme.other.topic', 1) })).code, 'invalid_group');
  assert.equal((await make(ids.owner, { group: topicGroupId(TOPIC, 2) })).code, 'invalid_group');
  assert.equal((await make(ids.owner, { group: 'whatever' })).code, 'invalid_group');
  assert.equal((await make(ids.owner, { agents: [did.alice, did.bob] })).code, 'invalid_group', 'the owner is always a member: it is in the group it makes');
  assert.equal((await make(ids.owner, { agents: [did.owner, did.alice, generateIdentity().did] })).code, 'member_not_found');
  assert.equal((await make(ids.owner, { agents: 'all' })).code, 'invalid_group');
  assert.equal((await make(ids.owner, { members: [did.owner, did.alice, did.mallory] })).code, 'invalid_group', 'a reader of an agent that is not a member');
  assert.equal((await make(ids.owner, { members: [did.alice, did.bob] })).code, 'invalid_group', 'whoever makes it is in it');
  assert.equal((await make(ids.owner, { members: [did.owner, did.alice, did.alice] })).code, 'invalid_group');
  assert.equal((await make(ids.owner, { agents: [did.owner, did.alice, did.bob, did.carol, did.mallory], members: [did.owner, did.alice, did.bob, did.carol, did.mallory] })).code, 'invalid_group', 'more readers than a group holds here');
  assert.equal((await make(ids.owner, { welcome: undefined })).code, 'invalid_mls');
  assert.equal((await make(ids.owner, { welcome: b64(packages.alice.bytes) })).code, 'invalid_mls', 'a KeyPackage is not an invitation');
  assert.equal((await make(ids.owner, { members: [did.owner, did.alice] })).code, 'invalid_mls', 'an invitation for somebody who is not in it');
  const done = await make(ids.owner, {});
  assert.deepEqual([done.status, done.json.group, done.json.generation, done.json.epoch, done.json.agents, done.json.members], [201, group, 1, 1, good.agents, good.members]);
  const again = await make(ids.owner, {});
  assert.deepEqual([again.status, again.code, again.json.error.generation, again.json.error.group], [409, 'stale_generation', 1, group]);
  // Each reader invited finds its invitation, and nobody else does.
  const invitations = async (identity) => (await as(identity)('GET', '/v1/mls/welcomes')).json.welcomes.map((entry) => entry.group);
  assert.deepEqual([await invitations(ids.alice), await invitations(ids.bob), await invitations(ids.mallory), await invitations(ids.owner)], [[group], [group], [], []]);
  const states = { owner: made.state, alice: (await joinGroup(ids.alice, made.welcome, packages.alice.secret)).state, bob: (await joinGroup(ids.bob, made.welcome, packages.bob.secret)).state };

  // Commits: one per epoch, from readers in the group, and each says what it does to the group.
  const commit = (identity, body) => as(identity)('POST', `${path}/commits`, { group, ...body });
  const renewal = await createUpdate(states.alice);
  const elsewhere = await createUpdate((await createGroup(ids.alice, 'another/group', [])).state);
  assert.equal((await commit(ids.mallory, { message: b64(renewal.commit) })).code, 'not_a_member');
  assert.equal((await commit(ids.alice, { group: topicGroupId(TOPIC, 1), message: b64(renewal.commit) })).code, 'stale_group');
  assert.equal((await commit(ids.alice, { message: b64(elsewhere.commit) })).code, 'invalid_mls');
  assert.equal((await commit(ids.alice, { message: b64(made.welcome) })).code, 'invalid_mls');
  assert.equal((await commit(ids.alice, { message: 'not base64!' })).code, 'invalid_mls');
  // What a member may say its commit does: nothing about other agents' readers, nothing about which agents are members.
  const say = (changes) => commit(ids.alice, { message: b64(renewal.commit), members: good.members, ...changes });
  assert.equal((await say({ agents: good.agents })).code, 'not_owner');
  assert.equal((await say({ members: [did.owner, did.alice] })).code, 'not_owner', 'bob is not hers to leave out');
  assert.equal((await say({ members: [...good.members, did.carol] })).code, 'invalid_group', 'carol is not a reader of a member agent');
  assert.equal((await say({ members: [did.owner, did.bob] })).code, 'invalid_group', 'whoever commits stays in');
  assert.equal((await say({ members: 'everybody' })).code, 'invalid_group');
  assert.equal((await say({ invited: [did.carol] })).code, 'invalid_group', 'invited, and not in the group');
  assert.equal((await say({ invited: [did.alice] })).code, 'invalid_group', 'nobody invites itself');
  assert.equal((await say({ invited: [did.bob] })).code, 'not_owner', 'an invitation for a reader that is not hers');
  assert.equal((await say({ welcome: b64(made.welcome) })).code, 'invalid_mls', 'an invitation and nobody to invite');
  assert.equal((await commit(ids.alice, { message: b64(renewal.commit), invited: [] })).code, 'invalid_group', 'saying anything means saying who is in');
  assert.equal(hub.store.mlsLog(group).epoch, 1, 'none of that moved the group');
  const first = await commit(ids.alice, { message: b64(renewal.commit) });
  assert.deepEqual([first.status, first.json], [201, { group, epoch: 2 }]);
  const late = await commit(ids.bob, { message: b64((await createUpdate(states.bob)).commit) });
  assert.deepEqual([late.status, late.code, late.json.error.epoch], [409, 'stale_epoch', 2]);
  states.alice = renewal.state;
  const rule = { mayChange: topicRule(did.owner) };
  states.owner = (await applyCommit(states.owner, renewal.commit, rule)).state;
  states.bob = (await applyCommit(states.bob, renewal.commit, rule)).state;

  // The owner changes who is a member. Carol comes in and bob goes: bob, who was subscribed, stops receiving.
  await clients.bob.subscribe(TOPIC);
  await clients.alice.subscribe(TOPIC);
  assert.deepEqual((await claim(ids.owner, [did.carol])).json.key_packages.length, 1);
  const change = await changeMembers(states.owner, { add: [packages.carol.bytes], remove: [did.bob] });
  const after = { agents: [did.owner, did.alice, did.carol], members: [did.owner, did.alice, did.carol] };
  const told = { message: b64(change.commit), ...after, invited: [did.carol], welcome: b64(change.welcome) };
  assert.equal((await commit(ids.owner, { ...told, invited: [] })).code, 'invalid_group', 'carol is brought in without an invitation');
  assert.equal((await commit(ids.owner, { ...told, welcome: undefined })).code, 'invalid_mls');
  assert.equal((await commit(ids.owner, { ...told, agents: [did.owner, did.alice] })).code, 'invalid_group', 'carol is in the group and her agent is not a member');
  assert.deepEqual((await commit(ids.owner, told)).json, { group, epoch: 3 });
  const view = (await as(ids.alice)('GET', path)).json;
  assert.deepEqual([view.epoch, view.agents, view.members, Object.keys(view.readers)], [3, after.agents, after.members, after.agents]);
  assert.deepEqual([await invitations(ids.carol), await clients.bob.subscriptions(), await clients.alice.subscriptions()], [[group], [], [TOPIC]]);
  assert.equal((await as(ids.bob)('GET', path)).code, 'not_a_member');
  assert.equal((await as(ids.bob)('GET', `${path}/commits`)).code, 'not_a_member');
  assert.equal((await commit(ids.bob, { message: b64((await createUpdate(states.bob)).commit) })).code, 'not_a_member');
  states.owner = change.state;
  states.alice = (await applyCommit(states.alice, change.commit, rule)).state;
  states.carol = (await joinGroup(ids.carol, change.welcome, packages.carol.secret)).state;

  // A member looks after its own instances: alice takes her laptop's key package and brings it in.
  const laptop = instanceOf(ids.alice);
  await hub.client(laptop).registerInstance();
  const laptopPackage = await packageOf(laptop);
  assert.equal((await claim(ids.alice, [did.carol])).code, 'not_owner', 'not somebody else\'s');
  assert.deepEqual((await claim(ids.alice, [laptop.instance.did])).json.key_packages, [{ reader: laptop.instance.did, key_package: b64(laptopPackage.bytes) }]);
  const own = await changeMembers(states.alice, { add: [laptopPackage.bytes] });
  const withLaptop = [...after.members, laptop.instance.did];
  assert.deepEqual((await commit(ids.alice, { message: b64(own.commit), members: withLaptop, invited: [laptop.instance.did], welcome: b64(own.welcome) })).json, { group, epoch: 4 });
  assert.deepEqual((await as(ids.owner)('GET', path)).json.members, withLaptop);
  states.alice = own.state;
  states.owner = (await applyCommit(states.owner, own.commit, rule)).state;
  // Four readers is all this hub lets a group hold: nobody else gets in.
  assert.equal((await commit(ids.owner, { message: b64((await createUpdate(states.owner)).commit), agents: [...after.agents, did.mallory], members: [...withLaptop, did.mallory], invited: [did.mallory], welcome: b64(own.welcome) })).code, 'invalid_group');

  // The log, for the members: every commit from the epoch a reader says it is in.
  const log = (identity, query = '') => as(identity)('GET', `${path}/commits${query}`);
  assert.deepEqual((await log(ids.carol)).json.commits.map((entry) => entry.epoch), [1, 2, 3]);
  assert.deepEqual((await log(ids.carol, '?from=3')).json, { group, epoch: 4, commits: [{ epoch: 3, message: b64(own.commit) }] });
  assert.equal((await log(ids.carol, '?group=nope')).code, 'group_not_found');
  assert.equal((await log(ids.carol, '?from=x')).code, 'invalid_parameter');
  assert.equal((await log(ids.mallory)).code, 'not_a_member');

  // Events: from a reader in the group, an application message of that group, of the epoch it is in.
  const event = (identity, data, extra = {}) =>
    as(identity)('POST', `/v1/topics/${TOPIC}/events`, signEvent({ specversion: '1.0', id: `e-${Math.random()}`, source: identity.did, type: 'agenthub.encrypted', time: new Date().toISOString(), subject: TOPIC, encryption: 'mls-v1', ...extra, data }, identity));
  const sealed = async (state) => b64((await encryptMessage(state, new Uint8Array([1]), new Uint8Array())).message);
  const published = await event(ids.owner, { group, message: await sealed(states.owner) });
  assert.deepEqual([published.status, published.json.delivered_to], [202, 1], 'alice is the only other member subscribed');
  assert.equal((await event(ids.owner, { group, message: await sealed(change.state) })).code, 'stale_epoch', 'of the epoch before');
  assert.equal((await event(ids.owner, { group, message: b64((await createUpdate(states.owner)).commit) })).code, 'invalid_event', 'a commit does not travel as an event');
  assert.equal((await event(ids.owner, { group, message: await sealed(elsewhere.state) })).code, 'invalid_event', 'of some other group');
  assert.equal((await event(ids.owner, { group: topicGroupId(TOPIC, 1), message: await sealed(states.owner) })).code, 'stale_group');
  assert.equal((await event(ids.owner, { group, message: await sealed(states.owner), more: 1 })).code, 'invalid_event');
  assert.equal((await event(ids.owner, { group, message: await sealed(states.owner) }, { encryption: 'group-v1' })).code, 'invalid_event');
  assert.equal((await event(ids.owner, { group, message: await sealed(states.owner) }, { type: 'incident' })).code, 'invalid_event');
  assert.equal((await event(ids.bob, { group, message: await sealed(states.bob) })).code, 'publish_not_allowed');
  assert.equal((await event(ids.mallory, { group, message: await sealed(states.owner) })).code, 'publish_not_allowed');
  // Only the readers in the group receive: alice's key and her laptop, once it is in. Nothing is kept as history.
  assert.deepEqual([hub.store.pending(did.alice).length, hub.store.pending(laptop.instance.did).length, hub.store.topics.get(TOPIC).events.length], [1, 1, 0]);

  // A request that carries an invitation may be larger than the rest. One that is larger still is not read.
  const big = (size) => ({ message: 'A'.repeat(size) });
  assert.equal((await commit(ids.owner, big(100_000))).code, 'invalid_mls', 'read, and found not to be a commit');
  assert.equal((await commit(ids.owner, big(300_000))).code, 'payload_too_large');
  assert.equal((await as(ids.owner)('POST', `/v1/mls/dm/${did.alice}/commits`, { group, ...big(100_000) })).code, 'payload_too_large');
});

test('the keys of a topic group are renewed like those of a conversation, and whoever was away catches up', async (t) => {
  const hub = await startHub(t);
  const stores = { alice: observableStore(), bob: observableStore() };
  const owner = await hub.agent('owner', generateIdentity(), MLS);
  const alice = await hub.agent('alice', generateIdentity(), { state: stores.alice, renewKeysAfter: { messages: 2 } });
  const bob = await hub.agent('bob', generateIdentity(), { state: stores.bob, renewKeysAfter: { messages: 1 } });
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did, bob.did] });
  for (const client of [owner, alice, bob]) await client.subscribe(TOPIC);
  const { group } = hub.store.topics.get(TOPIC).mls;
  const epoch = () => hub.store.mlsLog(group).epoch;
  const lastFor = (client) => hub.store.pending(client.did).at(-1).envelope.event;

  await owner.publish(TOPIC, incident('uno'));
  assert.deepEqual(summaries(await alice.poll()), ['uno']);
  // Somebody copies alice's state. She renews her keys when asked to: the copy reads no further.
  const copy = stores.alice.snapshot().get(`group/${group}`);
  assert.deepEqual(await alice.rotateTopicKey(TOPIC), { topic: TOPIC, epoch: 2, members: 3 });
  await owner.publish(TOPIC, incident('dos'));
  const second = lastFor(alice);
  assert.equal((await inspectMessage(bytes(second.data.message))).epoch, 2, 'the owner followed the renewal before writing');
  await assert.rejects(decryptMessage(copy, bytes(second.data.message), topicAad(TOPIC, owner.did, second.id)), /epoch this member has not reached/);
  assert.deepEqual(summaries(await alice.poll()), ['dos']);

  // She renews on her own after publishing so many times: here two, so before the third.
  await alice.publish(TOPIC, incident('a1'));
  await alice.publish(TOPIC, incident('a2'));
  assert.equal(epoch(), 2);
  await alice.publish(TOPIC, incident('a3'));
  assert.equal(epoch(), 3);
  // Reading does not count on a topic: bob, who would renew after one message, has read five and renewed nothing.
  const read = await bob.poll();
  assert.deepEqual([summaries(read), read.errors], [['uno', 'dos', 'a1', 'a2', 'a3'], []]);
  assert.equal(epoch(), 3);
  // He was two renewals behind and followed them as he read. Writing, he is where everybody is.
  await bob.publish(TOPIC, incident('b1'));
  assert.deepEqual(summaries(await owner.poll()), ['a1', 'a2', 'a3', 'b1']);
  // His count is of what he writes: one message, so the next one renews first.
  await bob.publish(TOPIC, incident('b2'));
  assert.equal(epoch(), 4);
  assert.deepEqual(summaries(await alice.poll()), ['b1', 'b2']);
  assert.equal(hub.store.topics.get(TOPIC).mls.generation, 1);
});

test('a topic over MLS survives restarts of the hub and of its members, and an owner that lost its state makes the group again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-topic-'));
  const options = { port: 0, quiet: true, powDifficulty: 8, dataDir: join(dir, 'hub') };
  const ids = { owner: generateIdentity(), alice: generateIdentity(), bob: generateIdentity() };
  const running = [];
  // New client objects every time, as after a restart of each process: all they share is what is on disk.
  const clients = (hub, stateOf = (name) => `${name}.state`) =>
    Object.fromEntries(Object.entries(ids).map(([name, identity]) => [name, new AgentClient({ hubUrl: hub.url, identity, state: fileStateStore(join(dir, stateOf(name))) })]));
  const boot = async (stateOf) => {
    const hub = await createHub(options).listen();
    running.push(hub);
    return { hub, ...clients(hub, stateOf) };
  };
  try {
    let { hub, owner, alice, bob } = await boot();
    for (const [name, client] of Object.entries({ owner, alice, bob })) await client.register({ name });
    await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did] });
    await alice.subscribe(TOPIC);
    await owner.subscribe(TOPIC);
    await owner.publish(TOPIC, incident('uno'));
    const mls = () => hub.store.topics.get(TOPIC).mls;
    const snapshot = () => structuredClone({ mls: mls(), log: hub.store.mlsLog(mls().group) });

    // The hub shuts down and comes back from its snapshot; every client is a new process.
    const before = snapshot();
    await Promise.all(running.splice(0).map((old) => old.close()));
    ({ hub, owner, alice, bob } = await boot());
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(summaries(await alice.poll()), ['uno']);
    await alice.publish(TOPIC, incident('dos'));
    assert.deepEqual(summaries(await owner.poll()), ['dos']);

    // Bob comes in, and this time the hub crashes: what it knew of the group has to come back from the journal.
    await owner.addTopicMembers(TOPIC, [bob.did]);
    await bob.subscribe(TOPIC);
    await owner.publish(TOPIC, incident('tres'));
    // Somebody is waiting to be let in again when it happens: that has to come back too.
    assert.equal((await signedFetch(hub, ids.alice, 'POST', `/v1/topics/${TOPIC}/mls/rejoin`, { group: mls().group })).status, 200);
    const crashed = snapshot();
    hub.store.fd = null; // from here on the crashed hub must not touch the data directory
    ({ hub, owner, alice, bob } = await boot());
    assert.deepEqual(snapshot(), crashed);
    assert.deepEqual([mls().agents.length, mls().generation, hub.store.mlsLog(mls().group).epoch, mls().rejoin], [3, 1, 2, [ids.alice.did]]);
    assert.deepEqual([summaries(await bob.poll()), summaries(await alice.poll())], [['tres'], ['tres']]);
    await bob.publish(TOPIC, incident('cuatro'));
    assert.deepEqual(summaries(await alice.poll()), ['cuatro']);

    // The owner loses its state: disk gone, identity kept. It cannot use the group any more, and it
    // is the one who can make another. Its next message does, with the members there were.
    const previous = mls().group;
    owner = new AgentClient({ hubUrl: hub.url, identity: ids.owner, state: fileStateStore(join(dir, 'owner-again.state')) });
    const lost = await owner.poll();
    assert.deepEqual([lost.messages, lost.errors.map(errorText)], [[], ['cannot decrypt (this reader is not in the group of the topic, or cannot follow it)']]);
    await owner.publish(TOPIC, incident('he vuelto'));
    assert.deepEqual([mls().generation, mls().earlier, mls().agents.length, mls().members.length], [2, [previous], 3, 3]);
    assert.deepEqual([summaries(await alice.poll()), summaries(await bob.poll())], [['he vuelto'], ['he vuelto']]);
    await alice.publish(TOPIC, incident('bienvenido'));
    assert.deepEqual(summaries(await owner.poll()), ['bienvenido']);
    assert.deepEqual((await bob.topicMembers(TOPIC)).members, [ids.owner.did, ids.alice.did, ids.bob.did]);
  } finally {
    await Promise.all(running.map((hub) => hub.close()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reader that cannot follow the group asks to be let in again, and whoever may lets it', async (t) => {
  const { hub, identities, stores, owner, alice, bob, group, epoch } = await scene(t, { mlsCommitsKept: 2 });
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did, bob.did] });
  for (const client of [owner, alice, bob]) await client.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('uno'));
  assert.deepEqual([summaries(await alice.poll()), summaries(await bob.poll())], [['uno'], ['uno']]);
  const waiting = () => group().rejoin ?? [];
  const path = `/v1/topics/${TOPIC}/mls`;

  // Bob loses his state: disk gone, identity kept. As far as everybody else knows he is in the
  // group, and he can do nothing in it. He says so to the hub, once.
  const amnesic = hub.client(identities.bob, { state: memoryStateStore() });
  const refused = await rejects(amnesic.publish(TOPIC, incident('dos')), 409, 'not_in_group');
  assert.match(refused.message, /It has asked to be let in/);
  assert.deepEqual(waiting(), [bob.did]);
  // Alice writes next. He is not hers to bring back, and she does not try. He cannot open it.
  await alice.publish(TOPIC, incident('de alice'));
  assert.deepEqual([waiting(), epoch()], [[bob.did], 1]);
  const missed = await amnesic.poll();
  assert.deepEqual([missed.messages, missed.errors.map(errorText)], [[], ['cannot decrypt (this reader is not in the group of the topic, or cannot follow it)']]);
  // The owner, the next time it uses the topic, leaves him out and brings him in again in one
  // commit, with a KeyPackage of the state he has now. He reads from there on, in the same group.
  await owner.publish(TOPIC, incident('tres'));
  assert.deepEqual([epoch(), waiting(), group().members, group().generation], [2, [], [owner.did, alice.did, bob.did], 1]);
  assert.deepEqual(summaries(await amnesic.poll()), ['tres']);
  await amnesic.publish(TOPIC, incident('he vuelto'));
  assert.deepEqual(summaries(await alice.poll()), ['tres', 'he vuelto']);

  // Falling too far behind ends the same way, and whoever only listens asks too. This hub keeps
  // two commits per group, and alice is away for three.
  for (let renewal = 0; renewal < 3; renewal++) await owner.rotateTopicKey(TOPIC);
  await owner.publish(TOPIC, incident('cuatro'));
  const behind = await alice.poll();
  assert.deepEqual([behind.messages, behind.errors.map(errorText), waiting()], [[], ['cannot decrypt (this reader is not in the group of the topic, or cannot follow it)'], [alice.did]]);
  await owner.publish(TOPIC, incident('cinco'));
  assert.deepEqual([waiting(), summaries(await alice.poll())], [[], ['cinco']]);

  // An agent lets its own readers back in, without its owner: alice's laptop loses its state, and
  // alice is the next to write.
  const laptopIdentity = instanceOf(identities.alice);
  const laptop = hub.client(laptopIdentity, MLS);
  await laptop.registerInstance();
  await alice.publish(TOPIC, incident('con el portátil'));
  assert.ok(group().members.includes(laptop.instanceDid));
  const forgetful = hub.client(laptopIdentity, { state: memoryStateStore() });
  await rejects(forgetful.publish(TOPIC, incident('x')), 409, 'not_in_group');
  assert.deepEqual(waiting(), [laptop.instanceDid]);
  await alice.publish(TOPIC, incident('otra vez dentro'));
  assert.deepEqual(waiting(), []);
  await owner.publish(TOPIC, incident('seis'));
  assert.deepEqual(summaries(await forgetful.poll()), ['seis']);

  // What the hub takes as such a request: from a reader of a member, about the group there is,
  // with a KeyPackage to be brought back with. Asking twice is asking once.
  const mallory = generateIdentity();
  await hub.agent('mallory', mallory, MLS);
  const ask = (signer, body = { group: group().group }) => signedFetch(hub, signer, 'POST', `${path}/rejoin`, body);
  assert.equal((await ask(mallory)).code, 'not_a_member');
  assert.equal((await ask(identities.bob, { group: topicGroupId(TOPIC, 1) })).code, 'stale_group');
  const bare = instanceOf(identities.bob);
  await hub.client(bare).registerInstance(); // an instance that keeps no MLS state, and so has published no KeyPackage
  const without = await ask(bare.instance);
  assert.equal(`${without.status} ${without.code}`, '409 no_key_package');
  assert.deepEqual([(await ask(identities.bob)).json, (await ask(identities.bob)).status, waiting()], [{ topic: TOPIC, group: group().group, asked: true }, 200, [bob.did]]);
  assert.deepEqual((await signedFetch(hub, identities.alice, 'GET', path)).json.rejoin, [bob.did], 'the members see who is waiting');

  // A hub that says somebody is waiting who is not there to be brought back, or is not whose to
  // bring: nothing is done about them. Alice is told about bob and about a stranger; the owner, about a stranger and itself.
  const told = (name, rejoin) =>
    hub.client(identities[name], {
      state: stores[name],
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        if (init.method !== 'GET' || new URL(url).pathname !== path) return res;
        return new Response(JSON.stringify({ ...(await res.json()), rejoin }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
  const at = epoch();
  await told('alice', [bob.did, mallory.did]).publish(TOPIC, incident('siete'));
  assert.equal(epoch(), at, 'alice changed nothing');
  hub.store.topics.get(TOPIC).mls.rejoin = [];
  await told('owner', [mallory.did, owner.did]).publish(TOPIC, incident('ocho'));
  assert.equal(epoch(), at, 'nor did the owner');

  // Nor is anybody left out to be brought back when there is nothing to bring it back with: the
  // hub says alice is waiting, and hands the owner no KeyPackage of hers.
  const stingy = hub.client(identities.owner, {
    state: stores.owner,
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      const route = new URL(url).pathname;
      const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init.method === 'GET' && route === path) return reply({ ...(await res.json()), rejoin: [alice.did] });
      if (init.method === 'POST' && route === `${path}/key-packages`) return reply({ key_packages: [] });
      return res;
    },
  });
  await stingy.publish(TOPIC, incident('nueve'));
  assert.deepEqual([epoch(), group().members.includes(alice.did)], [at, true]);
  assert.deepEqual(summaries(await alice.poll()).at(-1), 'nueve', 'alice is where she was, and reads');

  // Whoever was waiting and is left out of the topic is no longer waiting.
  await ask(identities.bob);
  await owner.removeTopicMembers(TOPIC, [bob.did]);
  assert.deepEqual([waiting(), group().agents.includes(bob.did)], [[], false]);
});

test('an instance whose certificate runs out is left out of the group of a topic, whatever the hub goes on listing', async (t) => {
  const { hub, identities, stores, owner, alice, group } = await scene(t);
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did] });
  await alice.subscribe(TOPIC);
  // An instance of alice with a certificate that has three seconds left.
  const briefIdentity = instanceOf(identities.alice, { days: 1, now: Date.now() - 86_400_000 + 3000 });
  const expires = Date.parse(briefIdentity.certificate.certificate.expires_at);
  const brief = hub.client(briefIdentity, MLS);
  await brief.registerInstance();
  await brief.poll(); // which leaves its KeyPackages on the hub
  await owner.publish(TOPIC, incident('uno'));
  assert.equal(group().members.includes(brief.instanceDid), true);
  const itsKeyPackage = hub.store.keyPackages.get(brief.instanceDid)[0];
  while (Date.now() <= expires + 20) await new Promise((resolve) => setTimeout(resolve, 50));
  // The hub goes on listing it among the readers of alice, and hands out a KeyPackage of it to
  // whoever would bring it in. The certificate says until when alice answers for that key: it is
  // left out, it is not brought back, and the topic goes on without it.
  const view = `/v1/topics/${TOPIC}/mls`;
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const listing = hub.client(identities.owner, {
    state: stores.owner,
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      const { pathname } = new URL(url);
      if (!res.ok) return res;
      if (init.method === 'GET' && pathname === view) return reply(((real) => ({ ...real, readers: { ...real.readers, [alice.did]: [alice.did, brief.instanceDid] } }))(await res.json()));
      if (init.method === 'POST' && pathname === `${view}/key-packages`) return reply({ key_packages: [...(await res.json()).key_packages, { reader: brief.instanceDid, key_package: itsKeyPackage }] });
      return res;
    },
  });
  await listing.publish(TOPIC, incident('dos'));
  assert.deepEqual([group().members.includes(brief.instanceDid), group().members.includes(alice.did)], [false, true]);
  await listing.publish(TOPIC, incident('tres'));
  assert.deepEqual([group().members.includes(brief.instanceDid), summaries(await alice.poll())], [false, ['uno', 'dos', 'tres']]);
  // And the hub, when it says what is so, does not list it, and hands out nothing of it.
  const honest = await signedFetch(hub, identities.owner, 'GET', view);
  const handed = await signedFetch(hub, identities.owner, 'POST', `${view}/key-packages`, { readers: [brief.instanceDid] });
  assert.deepEqual([honest.json.readers[alice.did], handed.status, handed.json.key_packages], [[alice.did], 200, []]);
});

test('an agent that is revoked is left out of the group the next time its owner uses the topic', async (t) => {
  const { hub, stores, owner, alice, bob, group, lastFor } = await scene(t);
  await owner.createTopic({ ...CONTRACT, private: true, members: [alice.did, bob.did] });
  for (const client of [alice, bob]) await client.subscribe(TOPIC);
  await owner.publish(TOPIC, incident('uno'));
  assert.deepEqual(summaries(await bob.poll()), ['uno']);
  const copy = stores.bob.snapshot().get(`group/${group().group}`);

  // Bob's identity is retired - its key leaked, say. The hub stops counting it as a member at once...
  await bob.retire();
  assert.deepEqual([group().agents, group().members], [[owner.did, alice.did], [owner.did, alice.did]]);
  // ...but its keys are still good for the group as it is, until somebody changes it. The owner does,
  // without being asked, as soon as it uses the topic.
  await owner.publish(TOPIC, incident('dos'));
  assert.equal(hub.store.mlsLog(group().group).epoch, 2);
  assert.deepEqual((await owner.topicMembers(TOPIC)).readers, [owner.did, alice.did]);
  const second = lastFor(alice);
  await assert.rejects(decryptMessage(copy, bytes(second.data.message), topicAad(TOPIC, owner.did, second.id)), /epoch this member has not reached/);
  assert.deepEqual(summaries(await alice.poll()), ['uno', 'dos']);
});

test('without MLS state a private topic uses a topic key, and nobody is moved to the weaker scheme behind its back', async (t) => {
  const hub = await startHub(t);
  const bobIdentity = generateIdentity();
  const owner = await hub.agent('owner', generateIdentity(), MLS);
  const alice = await hub.agent('alice'); // keeps no MLS state
  const bob = await hub.agent('bob', bobIdentity, MLS);
  const named = (name) => ({ ...CONTRACT, name, private: true });

  // An owner with MLS state makes its private topics over MLS. A member that cannot take part is
  // a reason to stop and say so, not to quietly use something weaker for everybody.
  const refused = await rejects(owner.createTopic({ ...named('acme.one.private'), members: [alice.did] }), 422, 'member_cannot_mls');
  assert.deepEqual(refused.details.members, [alice.did]);
  // The topic exists, with nobody but its owner in it: the owner goes on from there.
  assert.deepEqual([(await owner.getTopic('acme.one.private')).encryption, hub.store.topics.get('acme.one.private').mls], ['mls-v1', null]);
  await owner.addTopicMembers('acme.one.private', [bob.did]);
  assert.deepEqual(hub.store.topics.get('acme.one.private').mls.agents, [owner.did, bob.did]);
  // Asked for a topic key, it uses one, and alice reads.
  const keyed = await owner.createTopic({ ...named('acme.two.private'), encryption: 'group', members: [alice.did] });
  assert.equal(keyed.encryption, 'group-v1');
  await alice.subscribe('acme.two.private');
  await owner.publish('acme.two.private', incident('con clave de topic'));
  assert.deepEqual((await alice.poll()).messages.map((message) => [message.data.summary, message.encryption]), [['con clave de topic', 'group-v1']]);

  // A client without MLS state makes its topics with a topic key, and cannot be asked for more.
  assert.equal((await alice.createTopic({ ...named('acme.three.private'), members: [owner.did] })).encryption, 'group-v1');
  await rejects(alice.createTopic({ ...named('acme.four.private'), encryption: 'mls' }), 422, 'mls_unavailable');
  await assert.rejects(alice.createTopic({ ...named('acme.five.private'), encryption: 'rot13' }), /encryption is "mls" or "group"/);
  assert.equal(hub.store.topics.has('acme.four.private') || hub.store.topics.has('acme.five.private'), false, 'neither was made');

  // A member whose client keeps no MLS state still gets the events of a topic over MLS. It cannot
  // open them, nor publish, and it is told why.
  await bob.subscribe('acme.one.private');
  await owner.publish('acme.one.private', incident('sobre MLS'));
  const stateless = hub.client(bobIdentity);
  const unread = await stateless.poll();
  assert.deepEqual([unread.messages, unread.errors.map(errorText)], [[], ['cannot decrypt (this client keeps no MLS state)']]);
  await rejects(stateless.publish('acme.one.private', incident('x')), 422, 'mls_unavailable');
});

test('an instance of the owner runs a private topic: the agent key does not have to be there', async (t) => {
  const hub = await startHub(t);
  const ownerIdentity = generateIdentity();
  await hub.agent('owner', ownerIdentity); // the agent key registers the agent, and is put away
  const server = hub.client(instanceOf(ownerIdentity), MLS);
  await server.registerInstance();
  const alice = await hub.agent('alice', generateIdentity(), MLS);

  const topic = await server.createTopic({ ...CONTRACT, private: true, members: [alice.did] });
  assert.deepEqual([topic.encryption, topic.owner, topic.members], ['mls-v1', ownerIdentity.did, 2]);
  const { mls } = hub.store.topics.get(TOPIC);
  assert.deepEqual(mls.members, [server.instanceDid, alice.did], 'the agent key keeps no MLS state, so it is not in the group');
  await alice.subscribe(TOPIC);
  await server.publish(TOPIC, incident('desde el servidor'));
  const [got] = (await alice.poll()).messages;
  assert.deepEqual([got.data.summary, got.sender, got.instance, got.encryption], ['desde el servidor', ownerIdentity.did, server.instanceDid, 'mls-v1']);
  // With a topic key that is not possible: handing out the key takes the key of the agent.
  await assert.rejects(server.createTopic({ ...CONTRACT, name: 'acme.keyed.private', private: true, encryption: 'group' }), /needs the agent key/);
});
