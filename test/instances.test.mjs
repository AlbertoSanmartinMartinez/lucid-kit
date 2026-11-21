import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHub } from '../src/hub/server.mjs';
import {
  AgentClient,
  attachCertificate,
  createDelegation,
  createInstanceCertificate,
  createRevocation,
  generateIdentity,
  generateInstanceIdentity,
  loadOrCreateIdentity,
  saveIdentity,
  submitRevocation,
  verifyInstanceCertificate,
} from '../src/sdk/index.mjs';
import { checkInstanceCertificate, INSTANCE_GRACE_MS } from '../src/core/instance.mjs';
import { CONTEXT, createProof, signCard, signEvent, verifyEventEnvelope } from '../src/core/sign.mjs';
import { errorText, GENEROUS, instanceOf, rejects, signedFetch, startHub } from './helpers.mjs';

const DAY = 86_400_000;
const CLI = fileURLToPath(new URL('../bin/agenthub.mjs', import.meta.url));
const TOPIC = 'dev.rust.code-review.requests';
const REVIEW_TOPIC = {
  name: TOPIC,
  description: 'Peticiones de revisión de código Rust (code review requests)',
  schema: { type: 'object', required: ['repo', 'pr'], properties: { repo: { type: 'string' }, pr: { type: 'integer' } } },
};

/** An instance identity built around an existing key, to try keys that have no business being instances. */
const instanceWithKey = (keyHolder, certificate) => attachCertificate({ did: null, instance: { did: keyHolder.did, privateKey: keyHolder.privateKey }, certificate: null, encryption: null }, certificate);

/** Listens with the SDK and lets a test wait for what arrives. */
function listenTo(client) {
  const messages = [];
  const errors = [];
  const listener = client.listen((message) => void messages.push(message), { onError: (err) => void errors.push(err) });
  const until = async (condition, what = 'condition') => {
    for (let waited = 0; !condition(); waited += 10) {
      if (waited > 3000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { messages, errors, listener, until };
}

const event = (source, extra = {}) => ({ specversion: '1.0', id: 'e-1', source, type: 'x', time: new Date().toISOString(), data: { repo: 'r', pr: 1 }, ...extra });

// ------------------------------------------------------------------ certificates

test('an instance certificate ties one key to one agent, for a limited time', () => {
  const alice = generateIdentity();
  const mallory = generateIdentity();
  const key = generateInstanceIdentity().instance;
  const now = Date.now();
  const envelope = createInstanceCertificate(alice, { instance: key.did, name: 'laptop', days: 30, now });

  assert.deepEqual(Object.keys(envelope.certificate), ['version', 'agent', 'instance', 'name', 'issued_at', 'expires_at']);
  assert.equal(envelope.proof.context, 'agenthub/instance/v1');
  assert.equal(envelope.proof.key_id, alice.did);
  assert.equal(checkInstanceCertificate(envelope, { agent: alice.did, instance: key.did }), null);
  assert.deepEqual(verifyInstanceCertificate(envelope, { agent: alice.did, instance: key.did, now }), { ok: true });

  // It speaks for exactly that agent and that key.
  assert.match(checkInstanceCertificate(envelope, { agent: mallory.did }), /issued by a different agent/);
  assert.match(checkInstanceCertificate(envelope, { instance: generateIdentity().did }), /issued to a different key/);

  // Only the agent can sign it, whatever the proof claims.
  const certificate = { ...envelope.certificate };
  assert.match(checkInstanceCertificate({ certificate, proof: createProof(CONTEXT.INSTANCE, certificate, mallory) }), /not signed by the agent it names/);
  assert.match(checkInstanceCertificate({ certificate, proof: { ...createProof(CONTEXT.INSTANCE, certificate, mallory), key_id: alice.did } }), /signature rejected/);
  // A signature the agent made for something else is not a certificate.
  assert.match(checkInstanceCertificate({ certificate, proof: createProof(CONTEXT.DELEGATION, certificate, alice) }), /different context/);
  assert.match(checkInstanceCertificate({ certificate, proof: { ...createProof(CONTEXT.DELEGATION, certificate, alice), context: CONTEXT.INSTANCE } }), /signature rejected/);

  // Nothing in it can be changed, and nothing can be added.
  const later = new Date(now + 400 * DAY).toISOString();
  assert.match(checkInstanceCertificate({ certificate: { ...certificate, expires_at: later }, proof: envelope.proof }), /signature rejected/);
  assert.match(checkInstanceCertificate({ certificate: { ...certificate, admin: true }, proof: envelope.proof }), /unexpected fields/);
  assert.match(checkInstanceCertificate({ certificate: { ...certificate, version: 2 }, proof: envelope.proof }), /unsupported/);
  assert.match(checkInstanceCertificate(null), /malformed/);
  assert.match(checkInstanceCertificate({ certificate, proof: null }), /not signed/);

  // An agent key is not an instance of itself, and a label is a short label.
  assert.throws(() => createInstanceCertificate(alice, { instance: alice.did }), /instance of itself/);
  assert.throws(() => createInstanceCertificate(alice, { instance: 'did:key:nope' }), /did:key/);
  assert.throws(() => createInstanceCertificate(alice, { instance: key.did, name: '' }), /1-80 characters/);
  assert.throws(() => createInstanceCertificate(alice, { instance: key.did, name: 'x'.repeat(81) }), /1-80 characters/);
  assert.throws(() => createInstanceCertificate(alice, { instance: key.did, days: 0 }), /positive/);
  assert.equal(Object.hasOwn(createInstanceCertificate(alice, { instance: key.did }).certificate, 'name'), false, 'no label unless one is given');

  // Dates. `at` is when the instance says it signed; `now` is when the verifier looks.
  const issued = now;
  const expires = now + 30 * DAY;
  const check = (options) => verifyInstanceCertificate(envelope, { agent: alice.did, instance: key.did, ...options });
  assert.match(check({ at: issued - 5 * 60_000, now }).error, /before the instance certificate was issued/);
  assert.equal(check({ at: issued - 30_000, now }).ok, true, 'clocks may differ a little');
  assert.match(check({ now: expires + 1 }).error, /expired/);
  assert.match(check({ at: expires + 1, now: expires + 1, graceMs: INSTANCE_GRACE_MS }).error, /expired/, 'grace never covers something signed after expiry');
  assert.equal(check({ at: expires - 1000, now: expires + DAY, graceMs: INSTANCE_GRACE_MS }).ok, true, 'signed in time, read a day late');
  assert.match(check({ at: expires - 1000, now: expires + 8 * DAY, graceMs: INSTANCE_GRACE_MS }).error, /expired/);
  assert.match(check({ at: expires - 1000, now: expires + DAY }).error, /expired/, 'no grace unless the verifier allows one');
  assert.match(check({ at: Number.NaN, now }).error, /before the instance certificate was issued/);
  assert.match(check({ now, maxValidityMs: 7 * DAY }).error, /longer than the 7 days allowed/);
});

test('an event signed by an instance proves its agent through the certificate, and through nothing else', () => {
  const alice = generateIdentity();
  const mallory = generateIdentity();
  const laptop = instanceOf(alice, { name: 'laptop' });
  const server = instanceOf(alice, { name: 'server' });

  const envelope = signEvent(event(alice.did), laptop);
  assert.equal(envelope.proof.key_id, laptop.instance.did, 'the instance key signs');
  assert.deepEqual(envelope.proof.certificate, laptop.certificate);
  assert.deepEqual(verifyEventEnvelope(envelope), { ok: true, did: alice.did, instance: laptop.instance.did });
  // Signed with the agent key itself, nothing changes: no instance, no certificate.
  assert.deepEqual(verifyEventEnvelope(signEvent(event(alice.did), alice)), { ok: true, did: alice.did });

  const rejected = (candidate, pattern) => {
    const verdict = verifyEventEnvelope(candidate);
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, pattern);
  };
  // Without the certificate the key speaks only for itself.
  const { certificate, ...bare } = envelope.proof;
  rejected({ event: envelope.event, proof: bare }, /event\.source is not the signer/);
  // The certificate of a sibling instance does not cover this key.
  rejected({ event: envelope.event, proof: { ...bare, certificate: server.certificate } }, /issued to a different key/);
  // A certificate from someone else does not make the key speak for the agent named as source.
  const hired = createInstanceCertificate(mallory, { instance: laptop.instance.did });
  rejected({ event: envelope.event, proof: { ...bare, certificate: hired } }, /issued by a different agent/);
  // Mallory's own key, with a "certificate" she wrote in the agent's name.
  const fake = { version: 1, agent: alice.did, instance: mallory.did, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString() };
  const claimed = event(alice.did); // built once: the proof must be over the very event it travels with
  const forged = { event: claimed, proof: { ...createProof(CONTEXT.EVENT, claimed, mallory), certificate: { certificate: fake, proof: createProof(CONTEXT.INSTANCE, fake, mallory) } } };
  rejected(forged, /not signed by the agent it names/);
  // An instance of one agent cannot write as another agent.
  assert.throws(() => signEvent(event(mallory.did), laptop), /source must be the signer/);
  const asMallory = event(mallory.did);
  rejected({ event: asMallory, proof: { ...createProof(CONTEXT.EVENT, asMallory, laptop.instance), certificate: laptop.certificate } }, /issued by a different agent/);
  // The agent key cannot be dressed up as one of its own instances.
  rejected({ event: envelope.event, proof: { ...createProof(CONTEXT.EVENT, envelope.event, alice), certificate: laptop.certificate } }, /issued to a different key/);
  // Changed after signing.
  rejected({ event: { ...envelope.event, data: { repo: 'evil', pr: 1 } }, proof: envelope.proof }, /signature does not match/);

  // The event has to fall inside the certificate's life, and the certificate must not be long dead.
  const shortLived = generateInstanceIdentity();
  attachCertificate(shortLived, createInstanceCertificate(alice, { instance: shortLived.instance.did, days: 1, now: Date.now() - 3 * DAY }));
  const signedInTime = signEvent(event(alice.did, { time: new Date(Date.now() - 2.5 * DAY).toISOString() }), shortLived);
  rejected(signedInTime, /expired/); // a hub accepting a publication allows no grace
  assert.equal(verifyEventEnvelope(signedInTime, { graceMs: INSTANCE_GRACE_MS }).ok, true, 'a receiver reading late still accepts it');
  rejected(signEvent(event(alice.did), shortLived), /expired/);
  assert.equal(verifyEventEnvelope(signEvent(event(alice.did), shortLived), { graceMs: INSTANCE_GRACE_MS }).ok, false, 'signed after expiry: never');
  rejected(signEvent(event(alice.did, { time: 'not a date' }), laptop), /before the instance certificate was issued/);

  // A card is the agent's own statement about itself: an instance cannot sign one.
  assert.throws(() => signCard({ did: alice.did, name: 'alice' }, laptop), /agent key/);
  // And an instance with no certificate yet cannot sign anything as an agent.
  assert.throws(() => new AgentClient({ identity: generateInstanceIdentity() }), /no certificate/);
});

// ----------------------------------------------------------------------- the hub

test('an instance registers with its certificate and then acts as its agent, with its own key', async (t) => {
  const hub = await startHub(t);
  const reviewerIdentity = generateIdentity();
  const reviewer = await hub.agent('rust-reviewer', reviewerIdentity);
  const builder = await hub.agent('builder');
  await reviewer.createTopic(REVIEW_TOPIC);
  await builder.subscribe(TOPIC);

  const laptopIdentity = instanceOf(reviewerIdentity, { name: 'laptop' });
  const laptop = hub.client(laptopIdentity);
  assert.equal(laptop.did, reviewer.did, 'it is addressed as the agent');
  assert.equal(laptop.instanceDid, laptopIdentity.instance.did);
  // Until it registers, its key means nothing to the hub.
  await rejects(laptop.subscribe(TOPIC), 403, 'not_registered');

  const registered = await laptop.registerInstance();
  assert.equal(registered.agent, reviewer.did);
  assert.equal(registered.did, laptop.instanceDid);
  assert.deepEqual(registered.certificate, laptopIdentity.certificate);
  assert.equal(registered.online, false);

  // What it does, it does as the agent: the subscription is the agent's, and so is the publication.
  await laptop.subscribe(TOPIC);
  assert.deepEqual(await reviewer.subscriptions(), [TOPIC]);
  const receipt = await laptop.publish(TOPIC, { type: 'dev.rust.code-review.request', data: { repo: 'acme/parser', pr: 7 } });
  assert.equal(receipt.delivered_to, 1, 'the agent itself is not a recipient of what its instance published');
  const { messages } = await builder.poll();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender, reviewer.did, 'the sender is the agent, proven through the certificate');
  assert.equal(messages[0].instance, laptop.instanceDid);
  assert.deepEqual(messages[0].data, { repo: 'acme/parser', pr: 7 });
  assert.equal(hub.store.topics.get(TOPIC).events[0].envelope.proof.key_id, laptop.instanceDid);
  assert.equal((await reviewer.poll()).messages.length, 0);
  // An instance can create topics too: it is the agent, within whatever the agent may do.
  await laptop.createTopic({ ...REVIEW_TOPIC, name: 'dev.rust.another.topic' });
  assert.equal((await builder.getTopic('dev.rust.another.topic')).owner, reviewer.did);

  // Anyone can see the instance and check its certificate; searches do not carry the list.
  const seen = await builder.getAgent(reviewer.did);
  assert.deepEqual(seen.instances.map((instance) => instance.did), [laptop.instanceDid]);
  assert.equal(seen.instances[0].certificate.certificate.name, 'laptop');
  assert.equal((await builder.searchAgents('rust-reviewer'))[0].instances, undefined);
  assert.deepEqual((await laptop.instances()).map((instance) => instance.did), [laptop.instanceDid]);

  // Registering again with a newer certificate renews it; the instance stays the same one.
  attachCertificate(laptopIdentity, createInstanceCertificate(reviewerIdentity, { instance: laptop.instanceDid, name: 'laptop', days: 60 }));
  const renewed = await laptop.registerInstance();
  assert.equal(renewed.registered_at, registered.registered_at);
  assert.equal(renewed.certificate.certificate.expires_at, laptopIdentity.certificate.certificate.expires_at);
  assert.equal((await reviewer.instances()).length, 1);

  const info = await builder.info();
  assert.deepEqual(info.instances, { max_per_agent: 10, max_days: 90 });
});

test('the hub turns away instances it has no reason to accept', async (t) => {
  const hub = await startHub(t, { maxInstancesPerAgent: 2, limits: { instance: GENEROUS } });
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob', bobIdentity);
  const register = (identity) => hub.client(identity).registerInstance();
  const put = (signer, certificate) => signedFetch(hub, signer, 'PUT', '/v1/instances/me', { certificate });

  const laptop = instanceOf(aliceIdentity);
  await register(laptop);

  // Somebody else's certificate: the request must be signed by the key the certificate names.
  const thief = generateInstanceIdentity();
  assert.equal((await put(thief.instance, laptop.certificate)).code, 'invalid_certificate');
  // No certificate at all, or not one.
  assert.equal((await put(thief.instance, undefined)).code, 'invalid_certificate');
  assert.equal((await put(thief.instance, { certificate: {}, proof: {} })).code, 'invalid_certificate');
  // Signed by an agent this hub does not know.
  const stranger = generateIdentity();
  await rejects(register(instanceOf(stranger)), 404, 'agent_not_found');
  // Signed by someone other than the agent it names.
  const fake = { version: 1, agent: alice.did, instance: thief.instance.did, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString() };
  assert.equal((await put(thief.instance, { certificate: fake, proof: createProof(CONTEXT.INSTANCE, fake, bobIdentity) })).code, 'invalid_certificate');
  // Valid for longer than the hub honours, already expired, or not valid yet.
  await rejects(register(instanceOf(aliceIdentity, { days: 91 })), 400, 'invalid_certificate');
  await rejects(register(instanceOf(aliceIdentity, { days: 1, now: Date.now() - 2 * DAY })), 400, 'invalid_certificate');
  await rejects(register(instanceOf(aliceIdentity, { days: 1, now: Date.now() + DAY })), 400, 'invalid_certificate');

  // A key is an agent or an instance, never both, and an instance belongs to one agent.
  const bobAsInstance = instanceWithKey(bobIdentity, createInstanceCertificate(aliceIdentity, { instance: bobIdentity.did }));
  await rejects(register(bobAsInstance), 409, 'instance_conflict');
  const shared = instanceWithKey(laptop.instance, createInstanceCertificate(bobIdentity, { instance: laptop.instance.did }));
  await rejects(register(shared), 409, 'instance_conflict');
  assert.equal(hub.store.instances.get(laptop.instance.did).agent, alice.did);
  // The other way round: the key of a registered instance cannot register as a new agent.
  const squat = await signedFetch(hub, laptop.instance, 'POST', '/v1/agents', {});
  assert.equal(`${squat.status} ${squat.code}`, '409 already_registered');

  // A limit on how many, which renewing does not hit.
  await register(instanceOf(aliceIdentity));
  await rejects(register(instanceOf(aliceIdentity)), 403, 'quota_exceeded');
  await register(attachCertificate(laptop, createInstanceCertificate(aliceIdentity, { instance: laptop.instance.did })));
  assert.equal((await alice.instances()).length, 2);
  assert.equal((await bob.instances()).length, 0);

  // A retired agent gets no new instances, and the ones it had are locked out with it.
  const retiredIdentity = generateIdentity();
  const retired = await hub.agent('retired', retiredIdentity);
  const orphan = hub.client(instanceOf(retiredIdentity));
  await orphan.registerInstance();
  await retired.retire();
  await rejects(orphan.subscriptions(), 403, 'agent_revoked');
  await rejects(register(instanceOf(retiredIdentity)), 403, 'agent_revoked');

  // Checking a certificate costs the hub a signature verification: how often one address may ask is limited.
  const strict = await startHub(t, { limits: { instance: { burst: 2, perMinute: 2 } } });
  const carolIdentity = generateIdentity();
  await strict.agent('carol', carolIdentity);
  await strict.client(instanceOf(carolIdentity)).registerInstance();
  await strict.client(instanceOf(carolIdentity)).registerInstance();
  await rejects(strict.client(instanceOf(carolIdentity)).registerInstance(), 429, 'rate_limited');
});

test('an instance acts as the agent but cannot decide who the agent is', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob');
  const laptopIdentity = instanceOf(aliceIdentity);
  const serverIdentity = instanceOf(aliceIdentity);
  const laptop = hub.client(laptopIdentity);
  const server = hub.client(serverIdentity);
  await laptop.registerInstance();
  await server.registerInstance();
  await alice.createTopic(REVIEW_TOPIC);

  // The SDK says so before asking the hub.
  for (const attempt of [
    () => laptop.register({ name: 'hijacked' }),
    () => laptop.updateCard({ name: 'hijacked' }),
    () => laptop.retire(),
    () => laptop.dropDelegation(),
    () => laptop.rotateEncryptionKey(),
    async () => laptop.certifyInstance(generateIdentity().did),
    () => laptop.createTopic({ ...REVIEW_TOPIC, name: 'dev.private.topic', private: true }),
  ]) {
    await assert.rejects(attempt(), /needs the agent key/);
  }
  await assert.rejects(alice.registerInstance(), /only an instance registers/);

  // And the hub refuses the same things when the request is forged by hand with the instance key.
  const asLaptop = (method, path, body) => signedFetch(hub, laptopIdentity.instance, method, path, body);
  const current = await alice.getAgent(alice.did);
  const replayedCard = { card_envelope: { card: current.card, proof: current.proof } };
  for (const [method, path, body] of [
    ['PUT', '/v1/agents/me', replayedCard], // even the agent's own, genuinely signed card
    ['DELETE', '/v1/agents/me'],
    ['PUT', '/v1/agents/me/delegation', { delegation: createDelegation(generateIdentity(), { subject: alice.did }) }],
    ['DELETE', '/v1/agents/me/delegation'],
    ['DELETE', `/v1/instances/${server.instanceDid}`], // a sibling
  ]) {
    const answer = await asLaptop(method, path, body);
    assert.equal(`${answer.status} ${answer.code}`, '403 agent_key_required', `${method} ${path}`);
  }
  assert.equal((await alice.getAgent(alice.did)).status, 'active');
  assert.equal((await alice.instances()).length, 2);

  // The key that signs the request is the key that must have signed the content.
  const post = (signer, envelope) => signedFetch(hub, signer, 'POST', `/v1/topics/${TOPIC}/events`, envelope);
  const body = event(alice.did, { subject: TOPIC });
  assert.equal((await post(laptopIdentity.instance, signEvent({ ...body, id: 'by-agent' }, aliceIdentity))).code, 'signer_mismatch');
  assert.equal((await post(laptopIdentity.instance, signEvent({ ...body, id: 'by-sibling' }, serverIdentity))).code, 'signer_mismatch');
  assert.equal((await post(aliceIdentity, signEvent({ ...body, id: 'by-instance' }, laptopIdentity))).code, 'signer_mismatch');
  // An instance of alice cannot publish as bob, with or without a certificate in the proof.
  const asBob = event(bob.did, { subject: TOPIC, id: 'as-bob' });
  const withCertificate = { event: asBob, proof: { ...createProof(CONTEXT.EVENT, asBob, laptopIdentity.instance), certificate: laptopIdentity.certificate } };
  assert.equal((await post(laptopIdentity.instance, withCertificate)).code, 'invalid_envelope');
  assert.equal((await post(laptopIdentity.instance, { event: asBob, proof: createProof(CONTEXT.EVENT, asBob, laptopIdentity.instance) })).code, 'invalid_envelope');
  assert.equal(hub.store.topics.get(TOPIC).events.length, 0);
  assert.equal((await post(laptopIdentity.instance, signEvent({ ...body, id: 'fine' }, laptopIdentity))).status, 202);

  // What the controller allows the agent is what its instances get: no more.
  const controller = generateIdentity();
  await alice.attachDelegation(createDelegation(controller, { subject: alice.did, scope: { publish: ['ops.*'], direct: false } }));
  await rejects(laptop.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 2 } }), 403, 'out_of_scope');
  await rejects(laptop.send(bob.did, { type: 'x', data: {} }), 403, 'out_of_scope');
  // Its rate limits are the agent's as well: more instances do not mean more messages.
  assert.equal(hub.config.limits.publish.burst, 60);
});

test('every instance receives every message once, with its own stream and its own cursor', async (t) => {
  const hub = await startHub(t);
  const reviewerIdentity = generateIdentity();
  const reviewer = await hub.agent('rust-reviewer', reviewerIdentity);
  const builder = await hub.agent('builder');
  await reviewer.createTopic(REVIEW_TOPIC);
  await reviewer.subscribe(TOPIC);
  const laptop = hub.client(instanceOf(reviewerIdentity, { name: 'laptop' }));
  const server = hub.client(instanceOf(reviewerIdentity, { name: 'server' }));
  await laptop.registerInstance();
  await server.registerInstance();

  await builder.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 1 } });
  await builder.send(reviewer.did, { type: 'note', data: { n: 2 }, encrypt: false });

  const kinds = (result) => result.messages.map((message) => `${message.seq}:${message.kind}`);
  // The agent key and each instance read the same two messages, each from its own inbox.
  assert.deepEqual(kinds(await laptop.poll()), ['1:topic', '2:direct']);
  assert.deepEqual(kinds(await laptop.poll()), [], 'acknowledged for the laptop');
  assert.deepEqual(kinds(await server.poll()), ['1:topic', '2:direct'], 'still there for the server');
  assert.deepEqual(kinds(await reviewer.poll()), ['1:topic', '2:direct'], 'and for the agent key');

  // A new instance starts from now: it does not get what was sent before it existed.
  const tablet = hub.client(instanceOf(reviewerIdentity, { name: 'tablet' }));
  await tablet.registerInstance();
  assert.deepEqual(kinds(await tablet.poll()), []);
  await builder.send(reviewer.did, { type: 'note', data: { n: 3 }, encrypt: false });
  assert.deepEqual(kinds(await tablet.poll()), ['1:direct']);
  assert.deepEqual(kinds(await laptop.poll()), ['3:direct']);

  // Two instances hold a stream each. A second connection of the same instance takes over only that one.
  const onLaptop = listenTo(laptop);
  const onServer = listenTo(server);
  await Promise.all([onLaptop.listener.ready, onServer.listener.ready]);
  assert.equal((await builder.getAgent(reviewer.did)).online, true, 'online through its instances');
  assert.deepEqual((await builder.getAgent(reviewer.did)).instances.map((instance) => instance.online), [true, true, false]);
  const receipt = await builder.send(reviewer.did, { type: 'note', data: { n: 4 }, encrypt: false });
  assert.equal(receipt.recipient_online, true);
  await onLaptop.until(() => onLaptop.messages.length === 1, 'the laptop to receive');
  await onServer.until(() => onServer.messages.some((message) => message.data.n === 4), 'the server to receive');
  assert.deepEqual(onLaptop.messages.map((message) => message.data.n), [4]);
  assert.deepEqual(onServer.messages.map((message) => message.data.n), [3, 4], 'the server had one waiting');

  const laptopAgain = listenTo(hub.client(instanceOf(reviewerIdentity)));
  await rejects(laptopAgain.listener.ready, 403, 'not_registered'); // a certificate alone opens no stream
  const sameLaptop = listenTo(laptop);
  await sameLaptop.listener.ready;
  await onLaptop.until(() => onLaptop.errors.some((err) => err.code === 'stream_replaced'), 'the first laptop stream to be replaced');
  await builder.send(reviewer.did, { type: 'note', data: { n: 5 }, encrypt: false });
  await onServer.until(() => onServer.messages.some((message) => message.data.n === 5), 'the server to keep receiving');
  await sameLaptop.until(() => sameLaptop.messages.some((message) => message.data.n === 5), 'the new laptop stream to receive');
  assert.deepEqual(onServer.errors, []);
});

test('removing an instance locks that key out for good and leaves the agent as it was', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob');
  const laptopIdentity = instanceOf(aliceIdentity, { name: 'laptop' });
  const laptop = hub.client(laptopIdentity);
  const server = hub.client(instanceOf(aliceIdentity, { name: 'server' }));
  await laptop.registerInstance();
  await server.registerInstance();
  await bob.send(alice.did, { type: 'note', data: { n: 1 }, encrypt: false });

  // The laptop is lost: the agent removes it. Its open stream ends at once.
  const stream = listenTo(laptop);
  await stream.listener.ready;
  // Nobody else can: not another agent, not for an instance that is not theirs.
  await rejects(bob.removeInstance(laptop.instanceDid), 404, 'instance_not_found');
  await rejects(alice.removeInstance(generateIdentity().did), 404, 'instance_not_found');
  assert.deepEqual(await alice.removeInstance(laptop.instanceDid), { agent: alice.did, did: laptop.instanceDid, removed: true });
  await stream.until(() => stream.errors.some((err) => err.code === 'instance_removed'), 'the stream to be cut');

  // From its very next request the key is refused, and no certificate brings it back.
  await rejects(laptop.poll(), 403, 'instance_removed');
  await rejects(laptop.registerInstance(), 403, 'instance_removed');
  attachCertificate(laptopIdentity, createInstanceCertificate(aliceIdentity, { instance: laptop.instanceDid, days: 60 }));
  await rejects(laptop.registerInstance(), 403, 'instance_removed');
  const envelope = signEvent(event(alice.did, { recipient: bob.did }), laptopIdentity);
  assert.equal((await signedFetch(hub, laptopIdentity.instance, 'POST', '/v1/messages', envelope)).code, 'instance_removed');
  assert.equal(hub.store.inboxes.has(laptop.instanceDid), false, 'what was waiting for it is gone');

  // The agent and its other instance carry on.
  assert.deepEqual((await bob.getAgent(alice.did)).instances.map((instance) => instance.did), [server.instanceDid]);
  assert.equal((await server.poll()).messages.length, 1);
  assert.equal((await alice.poll()).messages.length, 1);
  await server.send(bob.did, { type: 'note', data: {}, encrypt: false });

  // An instance can also remove itself, and only itself.
  assert.equal((await server.removeInstance()).removed, true);
  await rejects(server.poll(), 403, 'instance_removed');
  assert.deepEqual(await alice.instances(), []);
  await assert.rejects(alice.removeInstance(), /which instance/);
});

test('an expired certificate carries no authority, and a renewed one restores it', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob');
  // Issued 30 days ago minus a moment: it runs out during the test.
  const laptopIdentity = instanceOf(aliceIdentity, { days: 30, now: Date.now() - 30 * DAY + 1200 });
  const expiring = laptopIdentity.certificate;
  const laptop = hub.client(laptopIdentity);
  await laptop.registerInstance();
  await laptop.send(bob.did, { type: 'note', data: { n: 1 }, encrypt: false });

  await new Promise((resolve) => setTimeout(resolve, 1300));
  const refused = await rejects(laptop.send(bob.did, { type: 'note', data: { n: 2 }, encrypt: false }), 403, 'instance_expired');
  assert.equal(refused.details.expired_at, expiring.certificate.expires_at);
  await rejects(laptop.poll(), 403, 'instance_expired');
  assert.equal((await bob.getAgent(alice.did)).instances.length, 1, 'still listed: it is expired, not removed');

  // The agent signs a new certificate for the same key, the instance registers it, and it works again.
  attachCertificate(laptopIdentity, createInstanceCertificate(aliceIdentity, { instance: laptop.instanceDid }));
  await laptop.registerInstance();
  await laptop.send(bob.did, { type: 'note', data: { n: 3 }, encrypt: false });
  // But it has to sign with the new one: content under the expired certificate is refused even now.
  const stale = signEvent(event(alice.did, { recipient: bob.did, id: 'stale' }), { ...laptopIdentity, certificate: expiring });
  assert.equal((await signedFetch(hub, laptopIdentity.instance, 'POST', '/v1/messages', stale)).code, 'invalid_envelope');

  const { messages, errors } = await bob.poll();
  assert.deepEqual(messages.map((message) => message.data.n), [1, 3], 'the first was signed in time: bob still accepts it after the expiry');
  assert.deepEqual(errors, []);
});

test('receivers check the certificate themselves: a hub cannot vouch for an instance', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob');
  const mallory = generateIdentity();
  const laptop = instanceOf(aliceIdentity);
  const at = new Date().toISOString();
  const base = { specversion: '1.0', source: alice.did, type: 'x', time: at, recipient: bob.did, data: { amount: 1 } };

  // Plays the dishonest hub: files entries straight into bob's inbox, skipping every server-side check.
  const inbox = hub.store.inboxes.get(bob.did);
  const slip = (envelope) => inbox.items.push({ seq: inbox.next++, kind: 'direct', hub: { tier: 'key', received_at: at }, envelope });

  // Mallory's key, with a certificate she signed in alice's name.
  const fake = { version: 1, agent: alice.did, instance: mallory.did, issued_at: at, expires_at: new Date(Date.now() + DAY).toISOString() };
  const first = { ...base, id: 'forged-certificate' };
  slip({ event: first, proof: { ...createProof(CONTEXT.EVENT, first, mallory), certificate: { certificate: fake, proof: createProof(CONTEXT.INSTANCE, fake, mallory) } } });
  // A real instance of alice, whose certificate the hub "forgot" to pass on.
  const { certificate, ...bare } = signEvent({ ...base, id: 'no-certificate' }, laptop).proof;
  slip({ event: { ...base, id: 'no-certificate' }, proof: bare });
  // A real instance of mallory, passed off as one of alice's.
  const hers = instanceOf(mallory);
  const third = { ...base, id: 'wrong-agent' };
  slip({ event: third, proof: { ...createProof(CONTEXT.EVENT, third, hers.instance), certificate: hers.certificate } });
  // An instance whose certificate ran out long ago, with the date of the event moved back to fit.
  const dead = instanceOf(aliceIdentity, { days: 1, now: Date.now() - 30 * DAY });
  slip(signEvent({ ...base, id: 'long-expired', time: new Date(Date.now() - 29.5 * DAY).toISOString() }, dead));
  // And one that is exactly what it claims to be.
  slip(signEvent({ ...base, id: 'genuine' }, laptop));

  const { messages, errors } = await bob.poll();
  assert.deepEqual(messages.map((message) => [message.id, message.sender, message.instance]), [['genuine', alice.did, laptop.instance.did]]);
  assert.deepEqual(errors.map(errorText).map((text) => text.replace(/^.*: /, '')), [
    'instance certificate is not signed by the agent it names',
    'event.source is not the signer',
    'instance certificate was issued by a different agent',
    'instance certificate has expired',
  ]);

  // The directory is checked the same way: an instance the hub lists must carry a certificate its agent signed.
  await hub.client(laptop).registerInstance();
  assert.equal((await bob.getAgent(alice.did)).instances.length, 1);
  const lyingHub = async (url, init) => {
    const res = await fetch(url, init);
    if (!String(url).includes('/v1/agents/')) return res;
    const body = await res.json();
    body.instances.push({ ...body.instances[0], did: mallory.did, certificate: { certificate: fake, proof: createProof(CONTEXT.INSTANCE, fake, mallory) } });
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  const deceived = new AgentClient({ hubUrl: hub.url, identity: generateIdentity(), fetch: lyingHub });
  await assert.rejects(deceived.getAgent(alice.did), /an instance of did:key:\S+ that fails verification: instance certificate is not signed by the agent it names/);
});

test('an instance cannot read what is sealed to its agent, and says so', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob');
  const laptop = hub.client(instanceOf(aliceIdentity));
  await laptop.registerInstance();
  await alice.createTopic({ name: 'acme.team.private', description: 'Canal privado del equipo', schema: { type: 'object' }, private: true, members: [bob.did] });
  await alice.subscribe('acme.team.private');

  // Sealed to the agent's key, which lives with the agent identity: the instance does not have it.
  await bob.send(alice.did, { type: 'secret', data: { text: 'solo para alice' } });
  await bob.publish('acme.team.private', { type: 'note', data: { text: 'para el equipo' } });
  const atAgent = await alice.poll();
  assert.deepEqual(atAgent.messages.map((message) => [message.kind, message.encrypted, message.data.text]), [['direct', true, 'solo para alice'], ['topic', true, 'para el equipo']]);
  const atInstance = await laptop.poll();
  assert.deepEqual(atInstance.messages, []);
  assert.deepEqual(atInstance.errors.map(errorText), [
    'cannot decrypt (this instance does not hold the encryption key of its agent)',
    'cannot decrypt (this instance does not hold the encryption key of its agent)',
  ]);
  await assert.rejects(laptop.publish('acme.team.private', { type: 'note', data: { text: 'x' } }), /does not hold the encryption key of its agent/);

  // Sealing to somebody else needs no key of one's own: an instance can send encrypted messages.
  const sent = await laptop.send(bob.did, { type: 'reply', data: { text: 'recibido' } });
  assert.equal(hub.store.pending(bob.did).at(-1).envelope.event.type, 'agenthub.encrypted');
  const [reply] = (await bob.poll()).messages;
  assert.deepEqual([reply.id, reply.sender, reply.instance, reply.encrypted, reply.data.text], [sent.id, alice.did, laptop.instanceDid, true, 'recibido']);
});

test('revoking the agent cuts off every one of its instances', async (t) => {
  const hub = await startHub(t);
  const controller = generateIdentity();
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const delegation = createDelegation(controller, { subject: alice.did });
  await alice.attachDelegation(delegation);
  const laptop = hub.client(instanceOf(aliceIdentity));
  await laptop.registerInstance();
  const stream = listenTo(laptop);
  await stream.listener.ready;

  await submitRevocation(hub.url, createRevocation(controller, { delegation: delegation.delegation, reason: 'cuenta comprometida' }));
  await stream.until(() => stream.errors.some((err) => err.code === 'agent_revoked'), 'the instance stream to be cut');
  await rejects(laptop.poll(), 403, 'agent_revoked');
  await rejects(alice.poll(), 403, 'agent_revoked');
});

test('instances survive a restart, and removed ones stay removed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agenthub-test-'));
  const options = { port: 0, quiet: true, powDifficulty: 8, dataDir };
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const laptopIdentity = instanceOf(aliceIdentity, { name: 'laptop' });
  const serverIdentity = instanceOf(aliceIdentity, { name: 'server' });
  const running = [];
  const boot = async () => {
    const hub = await createHub(options).listen();
    running.push(hub);
    const client = (identity) => new AgentClient({ hubUrl: hub.url, identity });
    return { hub, alice: client(aliceIdentity), bob: client(bobIdentity), laptop: client(laptopIdentity), server: client(serverIdentity) };
  };
  try {
    let { hub, alice, bob, laptop, server } = await boot();
    await alice.register({ name: 'alice' });
    await bob.register({ name: 'bob' });
    await laptop.registerInstance();
    await server.registerInstance();
    await bob.send(alice.did, { type: 'note', data: { n: 1 }, encrypt: false });
    await alice.removeInstance(server.instanceDid);
    await hub.close();
    running.pop();

    // Second run, restored from the snapshot written on shutdown.
    ({ hub, alice, bob, laptop, server } = await boot());
    assert.deepEqual((await bob.getAgent(alice.did)).instances.map((instance) => instance.certificate.certificate.name), ['laptop']);
    await rejects(server.poll(), 403, 'instance_removed');
    await rejects(server.registerInstance(), 403, 'instance_removed');
    await bob.send(alice.did, { type: 'note', data: { n: 2 }, encrypt: false });

    // Third run: the second hub never shuts down, so everything since has to come back from the journal.
    const tabletIdentity = instanceOf(aliceIdentity, { name: 'tablet' });
    await new AgentClient({ hubUrl: hub.url, identity: tabletIdentity }).registerInstance();
    await bob.send(alice.did, { type: 'note', data: { n: 3 }, encrypt: false });
    hub.store.fd = null; // from here on the crashed instance must not touch the data directory
    ({ hub, alice, bob, laptop, server } = await boot());
    assert.deepEqual((await laptop.poll()).messages.map((message) => [message.seq, message.data.n]), [[1, 1], [2, 2], [3, 3]]);
    assert.deepEqual((await new AgentClient({ hubUrl: hub.url, identity: tabletIdentity }).poll()).messages.map((message) => [message.seq, message.data.n]), [[1, 3]]);
    assert.deepEqual((await alice.poll()).messages.map((message) => message.data.n), [1, 2, 3]);
    assert.deepEqual((await alice.instances()).map((instance) => instance.certificate.certificate.name), ['laptop', 'tablet']);
    await rejects(server.poll(), 403, 'instance_removed');
  } finally {
    await Promise.all(running.map((hub) => hub.close()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- files and the CLI

test('instance identity files keep the instance key private and refuse a certificate meant for another key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-instance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alice = generateIdentity();
  const file = join(dir, 'nested', 'instance.json');

  const fresh = generateInstanceIdentity();
  saveIdentity(file, fresh);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const pending = loadOrCreateIdentity(file);
  assert.deepEqual([pending.did, pending.instance.did, pending.certificate, pending.encryption], [null, fresh.instance.did, null, null]);

  attachCertificate(pending, createInstanceCertificate(alice, { instance: pending.instance.did, name: 'ci' }));
  saveIdentity(file, pending);
  const ready = loadOrCreateIdentity(file);
  assert.equal(ready.did, alice.did);
  assert.equal(ready.certificate.certificate.name, 'ci');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).encryption, undefined, 'an instance holds no encryption key of its agent');
  assert.equal(signEvent(event(alice.did), ready).proof.key_id, fresh.instance.did, 'the reloaded key is the same key');

  // A certificate for some other key is refused when attached and when found in a file.
  const other = createInstanceCertificate(alice, { instance: generateInstanceIdentity().instance.did });
  assert.throws(() => attachCertificate(generateInstanceIdentity(), other), /issued to a different key/);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), certificate: other }), { mode: 0o600 });
  assert.throws(() => loadOrCreateIdentity(file), { message: `cannot load the identity in ${file}: instance certificate was issued to a different key` });
});

test('the CLI takes an instance from its key to the hub: init, certify, attach, list, remove', async (t) => {
  const hub = await startHub(t);
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentFile = join(dir, 'agent.json');
  const instanceFile = join(dir, 'instance.json');
  const certificateFile = join(dir, 'certificate.json');
  const run = async (identity, ...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args, '--identity', identity, '--hub', hub.url]);
    return JSON.parse(stdout);
  };
  const fails = async (identity, ...args) => {
    const failure = await promisify(execFile)(process.execPath, [CLI, ...args, '--identity', identity, '--hub', hub.url]).then(() => null, (err) => err);
    assert.ok(failure, `expected "${args.join(' ')}" to fail`);
    return failure.stderr;
  };

  const agent = await run(agentFile, 'init', '--name', 'rust-reviewer');
  // On the machine that will run the instance: a key, and nothing it can do yet.
  const created = await run(instanceFile, 'instance', 'init');
  assert.match(created.instance, /^did:key:z6Mk/);
  assert.match(created.next_step, /instance certify/);
  assert.match(await fails(instanceFile, 'subscriptions'), /no certificate from its agent yet/);
  assert.match(await fails(agentFile, 'instance', 'init'), /holds an agent identity/);
  // Where the agent key lives: a certificate for that key.
  const signed = await run(agentFile, 'instance', 'certify', created.instance, '--name', 'laptop', '--days', '10', '--out', certificateFile);
  assert.deepEqual([signed.agent, signed.instance], [agent.did, created.instance]);
  assert.match(await fails(instanceFile, 'instance', 'certify', created.instance), /needs the agent key|no certificate/);
  // Back on the instance: keep the certificate and register.
  const attached = await run(instanceFile, 'instance', 'attach', certificateFile);
  assert.deepEqual([attached.agent, attached.instance], [agent.did, created.instance]);
  assert.deepEqual(await run(instanceFile, 'whoami'), { agent: agent.did, instance: created.instance });
  assert.deepEqual(await run(instanceFile, 'subscriptions'), []);
  assert.match(await fails(instanceFile, 'init', '--name', 'hijacked'), /needs the agent key/);

  const listed = await run(agentFile, 'instance', 'list');
  assert.deepEqual(listed.map((instance) => [instance.did, instance.certificate.certificate.name]), [[created.instance, 'laptop']]);
  assert.deepEqual(await run(agentFile, 'instance', 'remove', created.instance), { agent: agent.did, did: created.instance, removed: true });
  assert.match(await fails(instanceFile, 'subscriptions'), /instance_removed/);
});

test('what an agent calls itself cannot write lines of its own in what the hub prints', async (t) => {
  // What a hub prints is read by its operator, in a terminal or in whatever keeps its logs. A name is an
  // agent's to choose, and so are the name of an instance and the reason of a revocation.
  const lines = [];
  const hub = await startHub(t, { log: (line) => lines.push(line) });
  const escape = String.fromCharCode(27);
  const forged = `mallory\n[hub] this hub is did:key:z6MkForged ${escape}[2J\u2028\u202e`;
  const key = generateIdentity();
  const mallory = await hub.agent(forged, key);
  assert.equal((await mallory.getAgent(mallory.did)).card.name, forged, 'the name is the one the agent chose: it is its card, and it signed it');
  const copy = hub.client(instanceOf(key, { name: `laptop\r\n[hub] revoked everybody` }));
  await copy.registerInstance();
  const controller = generateIdentity();
  const delegated = await hub.agent('delegated');
  const delegation = createDelegation(controller, { subject: delegated.did });
  await delegated.attachDelegation(delegation);
  await submitRevocation(hub.url, createRevocation(controller, { delegation: delegation.delegation, reason: `no reason\n[hub] registered did:key:z6MkForged` }));

  const told = lines.filter((line) => /mallory|laptop|no reason/.test(line));
  assert.equal(told.length, 3, 'the registration, the instance and the revocation are each told');
  for (const line of lines) assert.ok(!/[\p{C}\p{Zl}\p{Zp}]/u.test(line), `a line the hub prints has something in it that is not text: ${JSON.stringify(line)}`);
  assert.ok(told[0].includes('"mallory?[hub] this hub is did:key:z6MkForged ?[2J??"'), 'what was chosen is shown, in quotes, as one line');
  assert.equal(lines.filter((line) => /^this hub is |^revoked everybody|^registered did:key:z6MkForged/.test(line)).length, 1, 'and the only line that says which hub this is, is the hub\'s own');
});
