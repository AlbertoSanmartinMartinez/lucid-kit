import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, generateIdentity } from '../src/sdk/index.mjs';
import { checkGrant, createGrant, decryptTopicEvent, encryptTopicEvent, generateTopicKey, openGrant } from '../src/core/groupkey.mjs';
import { publicEncryptionKey } from '../src/core/e2e.mjs';
import { signEvent } from '../src/core/sign.mjs';
import { signRequest } from '../src/core/reqsig.mjs';
import { errorText, GENEROUS, rejects, startHub } from './helpers.mjs';

const TOPIC = 'acme.incidents.private';
const CONTRACT = {
  name: TOPIC,
  description: 'Incidentes internos de Acme, solo para el equipo de guardia',
  schema: { type: 'object', required: ['summary'], additionalProperties: false, properties: { summary: { type: 'string' }, severity: { type: 'integer' } } },
};

/** An owner with a private topic and three other agents: alice (member), bob and carol (not members yet). */
async function scene(t, options) {
  const hub = await startHub(t, options);
  const identities = { owner: generateIdentity(), alice: generateIdentity(), bob: generateIdentity(), carol: generateIdentity() };
  const agents = {};
  for (const [name, identity] of Object.entries(identities)) agents[name] = await hub.agent(name, identity);
  const topic = await agents.owner.createTopic({ ...CONTRACT, private: true, members: [agents.alice.did] });
  return { hub, identities, topic, ...agents };
}

test('grants carry the topic key to one member, and only the owner can issue them', () => {
  const owner = generateIdentity();
  const member = generateIdentity();
  const outsider = generateIdentity();
  const topicKey = generateTopicKey();
  const base = { topic: TOPIC, epoch: 3, member: member.did, memberKey: publicEncryptionKey(member.encryption.current), topicKey };
  const grant = createGrant(owner, base);
  const opening = { keys: [member.encryption.current], topic: TOPIC, owner: owner.did, member: member.did };

  assert.deepEqual(openGrant(grant, opening), topicKey);
  assert.equal(checkGrant(grant, { topic: TOPIC, owner: owner.did, epoch: 3 }), null);
  assert.ok(!JSON.stringify(grant).includes(topicKey.toString('base64url')), 'the key does not travel in the clear');

  // Issued by someone else - the hub, say - sealing a key of their own choosing.
  const forged = createGrant(outsider, base);
  assert.throws(() => openGrant(forged, opening), /not signed by the topic owner/);
  // Moved to another topic, epoch or member: the signature no longer covers it.
  for (const change of [{ topic: 'other.topic.name' }, { epoch: 4 }, { member: outsider.did }]) {
    const moved = { grant: { ...grant.grant, ...change }, proof: grant.proof };
    assert.throws(() => openGrant(moved, { ...opening, ...(change.topic ? { topic: change.topic } : {}), ...(change.member ? { member: change.member } : {}) }), /signature rejected/);
  }
  assert.throws(() => openGrant(grant, { ...opening, member: outsider.did }), /different member/);
  assert.throws(() => openGrant(grant, { ...opening, keys: [outsider.encryption.current] }), /no longer holds/);
  assert.match(checkGrant(grant, { topic: TOPIC, owner: owner.did, epoch: 4 }), /different epoch/);
});

test('topic events open only with the right key, for the topic, epoch, sender and id they were made for', () => {
  const topicKey = generateTopicKey();
  const meta = { topic: TOPIC, source: 'did:key:alice', id: 'e1' };
  const data = encryptTopicEvent({ topicKey, ...meta, epoch: 2, payload: { type: 't', data: { n: 1 } } });
  assert.deepEqual(decryptTopicEvent({ topicKey, ...meta, data }), { type: 't', data: { n: 1 } });
  assert.throws(() => decryptTopicEvent({ topicKey: generateTopicKey(), ...meta, data }));
  assert.throws(() => decryptTopicEvent({ topicKey, ...meta, topic: 'other.topic', data }));
  assert.throws(() => decryptTopicEvent({ topicKey, ...meta, source: 'did:key:mallory', data }));
  assert.throws(() => decryptTopicEvent({ topicKey, ...meta, id: 'e2', data }));
  assert.throws(() => decryptTopicEvent({ topicKey, ...meta, data: { ...data, epoch: 3 } }));
  assert.throws(() => decryptTopicEvent({ topicKey, ...meta, data: { ...data, extra: 1 } }), /exactly/);
  // Encrypting the same payload twice shares neither salt nor ciphertext.
  const again = encryptTopicEvent({ topicKey, ...meta, epoch: 2, payload: { type: 't', data: { n: 1 } } });
  assert.notEqual(again.salt, data.salt);
  assert.notEqual(again.ct, data.ct);
});

test('a private topic: members read and write, the hub and everyone else see ciphertext', async (t) => {
  const { hub, topic, owner, alice, bob } = await scene(t);
  assert.deepEqual([topic.encryption, topic.epoch, topic.members], ['group-v1', 1, 2]);
  assert.deepEqual((await owner.info()).topic_encryption.supported, ['mls-v1', 'group-v1'], 'this client keeps no MLS state, so its private topics use a topic key');

  // Outsiders can find the topic, but not join it, read it, or get a key.
  assert.equal((await bob.searchTopics('incidentes guardia'))[0].name, TOPIC);
  await rejects(bob.subscribe(TOPIC), 403, 'subscribe_not_allowed');
  await rejects(bob.topicHistory(TOPIC), 403, 'subscribe_not_allowed');
  await rejects(bob.topicMembers(TOPIC), 403, 'not_a_member');
  assert.equal((await fetch(`${hub.url}/v1/topics/${TOPIC}/events`)).status, 401);
  await assert.rejects(bob.publish(TOPIC, { type: 'incident', data: { summary: 'x' } }), /holds no key|not_a_member|has not given/);

  await alice.subscribe(TOPIC);
  await owner.subscribe(TOPIC);
  const secret = 'la base de datos de pagos no responde';
  const receipt = await owner.publish(TOPIC, { type: 'acme.incident.opened', data: { summary: secret, severity: 1 } });
  assert.equal(receipt.delivered_to, 1);

  // What the hub holds: who published and when, never what.
  const stored = hub.store.topics.get(TOPIC).events[0].envelope.event;
  assert.equal(stored.source, owner.did);
  assert.equal(stored.type, 'agenthub.encrypted');
  assert.deepEqual(Object.keys(stored.data).sort(), ['alg', 'ct', 'epoch', 'salt']);
  const everything = JSON.stringify([[...hub.store.topics], [...hub.store.inboxes]]);
  assert.ok(!everything.includes(secret) && !everything.includes('acme.incident.opened'));

  const { messages } = await alice.poll();
  assert.equal(messages.length, 1);
  assert.deepEqual([messages[0].encrypted, messages[0].sender, messages[0].type], [true, owner.did, 'acme.incident.opened']);
  assert.deepEqual(messages[0].data, { summary: secret, severity: 1 });

  // Members publish too; the sender's signature still says who wrote each event.
  await alice.publish(TOPIC, { type: 'acme.incident.ack', data: { summary: 'lo miro yo' } });
  const reply = (await owner.poll()).messages[0];
  assert.deepEqual([reply.sender, reply.data.summary], [alice.did, 'lo miro yo']);
  assert.deepEqual((await alice.topicMembers(TOPIC)).members.sort(), [owner.did, alice.did].sort());
  assert.equal((await alice.topicHistory(TOPIC)).events.length, 2);
});

test('the contract of a private topic is enforced by its members, since the hub cannot read it', async (t) => {
  const { hub, identities, owner, alice } = await scene(t);
  await owner.subscribe(TOPIC);

  // An honest sender is stopped by its own SDK before anything is encrypted.
  const local = await rejects(alice.publish(TOPIC, { type: 't', data: { summary: 42 } }), 422, 'schema_validation_failed');
  assert.equal(local.details.errors[0].path, '/summary');
  assert.equal(hub.store.topics.get(TOPIC).seq, 0, 'nothing reached the hub');

  // A member that skips the check gets its event relayed - the hub cannot tell - and discarded on arrival.
  const post = async (event) => {
    const full = { specversion: '1.0', source: alice.did, time: new Date().toISOString(), subject: TOPIC, ...event };
    const body = Buffer.from(JSON.stringify(signEvent(full, identities.alice)));
    const path = `/v1/topics/${TOPIC}/events`;
    const res = await fetch(hub.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(identities.alice, 'POST', hub.url + path, body) }, body });
    return { status: res.status, code: (await res.json()).error?.code };
  };
  const topicKey = openGrant(hub.store.topics.get(TOPIC).grants[1][alice.did], {
    keys: [identities.alice.encryption.current], topic: TOPIC, owner: owner.did, member: alice.did,
  });
  const seal = (id, payload, epoch = 1) => encryptTopicEvent({ topicKey, topic: TOPIC, epoch, source: alice.did, id, payload });
  const encrypted = { type: 'agenthub.encrypted', encryption: 'group-v1' };
  assert.equal((await post({ ...encrypted, id: 'bad-schema', data: seal('bad-schema', { type: 't', data: { summary: 42 } }) })).status, 202);
  const { messages, errors } = await owner.poll();
  assert.equal(messages.length, 0);
  assert.match(errorText(errors[0]), /does not match the topic schema/);

  // What the hub can and does check: that it is encrypted, well formed and for the current key.
  assert.deepEqual(await post({ id: 'clear', type: 't', data: { summary: 'in the clear' } }), { status: 400, code: 'invalid_event' });
  assert.deepEqual(await post({ ...encrypted, id: 'shape', data: { summary: 'not sealed' } }), { status: 400, code: 'invalid_event' });
  assert.deepEqual(await post({ ...encrypted, id: 'type', type: 'leaky.type', data: seal('type', {}) }), { status: 400, code: 'invalid_event' });
  assert.deepEqual(await post({ ...encrypted, id: 'old', data: seal('old', { type: 't', data: { summary: 's' } }, 7) }), { status: 409, code: 'stale_epoch' });
});

test('adding a member shares the current key; removing one rotates it', async (t) => {
  const { hub, identities, owner, alice, bob, carol } = await scene(t);
  await alice.subscribe(TOPIC);
  await owner.publish(TOPIC, { type: 't', data: { summary: 'antes de bob' } });

  // Only the owner manages members.
  await rejects(alice.addTopicMembers(TOPIC, [bob.did]), 403, 'not_owner');
  const added = await owner.addTopicMembers(TOPIC, [bob.did]);
  assert.deepEqual([added.epoch, added.members], [1, 3]);
  await bob.subscribe(TOPIC);
  // Same epoch, same key: bob can read what the hub still retains of it.
  assert.equal((await bob.topicHistory(TOPIC)).events.length, 1);
  await owner.publish(TOPIC, { type: 't', data: { summary: 'con bob' } });
  assert.deepEqual((await bob.poll()).messages.map((m) => m.data.summary), ['con bob']);
  await alice.poll();

  // Alice leaves: epoch 2, a key she never receives.
  const aliceOldKey = openGrant(hub.store.topics.get(TOPIC).grants[1][alice.did], {
    keys: [identities.alice.encryption.current], topic: TOPIC, owner: owner.did, member: alice.did,
  });
  const removed = await owner.removeTopicMembers(TOPIC, [alice.did]);
  assert.deepEqual(removed, { topic: TOPIC, epoch: 2, members: 2, unsubscribed: 1 });
  assert.deepEqual((await bob.topicMembers(TOPIC)).members.sort(), [owner.did, bob.did].sort());

  const receipt = await owner.publish(TOPIC, { type: 't', data: { summary: 'sin alice' } });
  assert.equal(receipt.delivered_to, 1);
  assert.equal((await alice.poll()).messages.length, 0);
  await rejects(alice.subscribe(TOPIC), 403, 'subscribe_not_allowed');
  await rejects(alice.topicHistory(TOPIC), 403, 'subscribe_not_allowed');
  await rejects(alice.publish(TOPIC, { type: 't', data: { summary: 'sigo aquí' } }), 403, 'publish_not_allowed');
  // Even with a copy of everything the hub stores, her old key opens nothing from the new epoch.
  const latest = hub.store.topics.get(TOPIC).events.at(-1).envelope.event;
  assert.equal(latest.data.epoch, 2);
  assert.throws(() => decryptTopicEvent({ topicKey: aliceOldKey, topic: TOPIC, source: latest.source, id: latest.id, data: latest.data }));
  assert.equal(hub.store.topics.get(TOPIC).grants[2][alice.did], undefined);

  // Bob still holds the epoch-1 key in memory: his SDK notices the rotation and fetches the new one.
  await bob.publish(TOPIC, { type: 't', data: { summary: 'bob tras la rotación' } });
  assert.deepEqual((await bob.poll()).messages.map((m) => m.data.summary), ['sin alice']);
  await owner.subscribe(TOPIC);

  // Adding with { rotate: true } gives the newcomer nothing from before.
  const joined = await owner.addTopicMembers(TOPIC, [carol.did], { rotate: true });
  assert.deepEqual([joined.epoch, joined.members], [3, 3]);
  await carol.subscribe(TOPIC);
  const history = await carol.topicHistory(TOPIC);
  assert.ok(history.events.length >= 4);
  await owner.publish(TOPIC, { type: 't', data: { summary: 'con carol' } });
  assert.deepEqual((await carol.poll()).messages.map((m) => m.data.summary), ['con carol']);
  // Carol can list the old ciphertext, but holds no grant for the epochs it was encrypted in.
  assert.equal(history.events[0].envelope.event.data.epoch, 1);
  const grants = hub.store.topics.get(TOPIC).grants;
  assert.deepEqual(Object.keys(grants).filter((epoch) => grants[epoch][carol.did]), ['3']);

  assert.equal((await owner.rotateTopicKey(TOPIC)).epoch, 4);
  await rejects(owner.addTopicMembers(TOPIC, [generateIdentity().did]), 404, 'recipient_not_found');
});

test('a hub that forges a grant or swaps the owner does not get a member to use its key', async (t) => {
  const { hub, identities, owner, alice } = await scene(t);
  const hubKey = generateTopicKey(); // a key the hub knows
  const mallory = generateIdentity();
  const aliceKey = publicEncryptionKey(identities.alice.encryption.current);
  const record = hub.store.topics.get(TOPIC);

  // 1. The hub replaces alice's grant with one sealing its own key, signed by a key it controls.
  record.grants[1][alice.did] = createGrant(mallory, { topic: TOPIC, epoch: 1, member: alice.did, memberKey: aliceKey, topicKey: hubKey });
  await assert.rejects(alice.publish(TOPIC, { type: 't', data: { summary: 'secreto' } }), /holds no key/);
  assert.equal(record.seq, 0, 'alice encrypted nothing under the forged key');

  // 2. It also claims mallory owns the topic. A client that knows the real owner refuses...
  record.owner = mallory.did;
  const careful = new AgentClient({ hubUrl: hub.url, identity: identities.alice });
  careful.trustTopicOwner(TOPIC, owner.did);
  await assert.rejects(careful.publish(TOPIC, { type: 't', data: { summary: 'secreto' } }), /this client trusts/);
  // ...and so does one that had already seen the real owner.
  await assert.rejects(alice.publish(TOPIC, { type: 't', data: { summary: 'secreto' } }), /holds no key|this client trusts/);
  assert.equal(record.seq, 0);
  await careful.close();
});

test('key distribution: only the owner, only signed grants, only for agents that exist', async (t) => {
  const { hub, identities, owner, alice, bob } = await scene(t, { maxPrivateTopicMembers: 3 });
  const put = async (identity, body) => {
    const payload = Buffer.from(JSON.stringify(body));
    const path = `/v1/topics/${TOPIC}/keys`;
    const res = await fetch(hub.url + path, { method: 'PUT', headers: { 'content-type': 'application/json', ...signRequest(identity, 'PUT', hub.url + path, payload) }, body: payload });
    return { status: res.status, code: (await res.json()).error?.code };
  };
  const grantFor = (signer, member, epoch) =>
    createGrant(signer, { topic: TOPIC, epoch, member: member.did, memberKey: publicEncryptionKey(member.encryption.current), topicKey: generateTopicKey() });

  assert.deepEqual(await put(identities.alice, { epoch: 1, grants: [grantFor(identities.alice, identities.bob, 1)] }), { status: 403, code: 'not_owner' });
  assert.deepEqual(await put(identities.owner, { epoch: 1, grants: [grantFor(identities.alice, identities.bob, 1)] }), { status: 400, code: 'invalid_grant' });
  assert.deepEqual(await put(identities.owner, { epoch: 5, grants: [grantFor(identities.owner, identities.bob, 5)] }), { status: 409, code: 'stale_epoch' });
  assert.deepEqual(await put(identities.owner, { epoch: 1, grants: [grantFor(identities.owner, identities.bob, 2)] }), { status: 400, code: 'invalid_grant' });
  assert.deepEqual(await put(identities.owner, { epoch: 2, grants: [grantFor(identities.owner, identities.bob, 2)] }), { status: 400, code: 'invalid_grant' }, 'a rotation must include the owner');
  assert.deepEqual(await put(identities.owner, { epoch: 1, grants: [grantFor(identities.owner, generateIdentity(), 1)] }), { status: 404, code: 'member_not_found' });
  assert.deepEqual(await put(identities.owner, { epoch: 1, grants: [] }), { status: 400, code: 'invalid_grant' });

  await owner.addTopicMembers(TOPIC, [bob.did]);
  const carol = (await owner.searchAgents('carol'))[0].did;
  await rejects(owner.addTopicMembers(TOPIC, [carol]), 403, 'quota_exceeded');

  // Public topics have no keys, and private ones take no subscribe policy.
  await owner.createTopic({ name: 'acme.public.topic', description: 'A public topic for contrast', schema: { type: 'object' } });
  await rejects(owner.addTopicMembers('acme.public.topic', [alice.did]), 400, 'not_private');
  await rejects(owner.setTopicPolicy(TOPIC, { subscribe: { min_tier: 'org' } }), 400, 'invalid_topic');
  assert.equal((await owner.setTopicPolicy(TOPIC, { publish: 'owner' })).publish, 'owner');
  await rejects(alice.publish(TOPIC, { type: 't', data: { summary: 'ya no puedo' } }), 403, 'publish_not_allowed');
});

test('a revoked member drops out of private topics, and private topics survive a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agenthub-private-'));
  const options = { port: 0, quiet: true, powDifficulty: 8, dataDir, limits: { register: GENEROUS, challenge: GENEROUS, topicCreate: GENEROUS } };
  const identities = { owner: generateIdentity(), alice: generateIdentity(), bob: generateIdentity() };
  try {
    let hub = await createHub(options).listen();
    const connect = (name) => new AgentClient({ hubUrl: hub.url, identity: identities[name] });
    for (const name of Object.keys(identities)) await connect(name).register({ name });
    await connect('owner').createTopic({ ...CONTRACT, private: true, members: [identities.alice.did, identities.bob.did] });
    await connect('alice').subscribe(TOPIC);
    await connect('owner').publish(TOPIC, { type: 't', data: { summary: 'persistido' } });
    await connect('bob').retire();
    assert.deepEqual((await connect('owner').topicMembers(TOPIC)).members.sort(), [identities.owner.did, identities.alice.did].sort());
    await hub.close();

    hub = await createHub(options).listen();
    const alice = connect('alice'); // a new process: no key in memory, it is fetched and opened again
    const topic = await alice.getTopic(TOPIC);
    assert.deepEqual([topic.encryption, topic.epoch, topic.members], ['group-v1', 1, 2]);
    assert.deepEqual((await alice.poll()).messages.map((m) => m.data.summary), ['persistido']);
    await alice.publish(TOPIC, { type: 't', data: { summary: 'tras reiniciar' } });
    assert.equal((await connect('owner').rotateTopicKey(TOPIC)).epoch, 2);
    await hub.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
