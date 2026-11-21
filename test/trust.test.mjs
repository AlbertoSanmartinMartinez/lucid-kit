import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, HubError, generateIdentity, submitRevocation } from '../src/sdk/index.mjs';
import { createDelegation, createRevocation, normalizeScope, scopeAllows, topicPatternMatches, verifyDelegation, verifyRevocation } from '../src/core/delegation.mjs';
import { createDidWebResolver, didWebDocument, didWebUrl, documentKeys, isPublicAddress, parseDidWeb } from '../src/core/didweb.mjs';
import { CONTEXT, createProof } from '../src/core/sign.mjs';
import { GENEROUS, rejects, startHub } from './helpers.mjs';

const DAY = 86_400_000;
const OPEN = { description: 'A topic used by the trust tests', schema: { type: 'object' } };
const ACME = 'did:web:acme.com';

/** A did:web resolver that serves documents from memory instead of the network. */
function fakeWeb(documents) {
  const requested = [];
  const resolve = createDidWebResolver({
    fetchDocument: async (url) => {
      requested.push(url);
      if (!documents[url]) throw new Error('the server answered 404');
      return documents[url];
    },
  });
  return Object.assign(resolve, { requested });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** A revocation of `delegation` signed by someone else but claiming to come from its issuer. */
function forgedRevocation(signer, delegation) {
  const revocation = { version: 1, delegation_id: delegation.id, issuer: delegation.issuer, subject: delegation.subject, revoked_at: new Date().toISOString() };
  return { revocation, proof: { ...createProof(CONTEXT.REVOCATION, revocation, signer), key_id: delegation.issuer } };
}

// ------------------------------------------------------------------------- core

test('topic patterns and scopes', () => {
  assert.ok(topicPatternMatches('*', 'any.topic'));
  assert.ok(topicPatternMatches('dev.rust.*', 'dev.rust.code-review.requests'));
  assert.ok(!topicPatternMatches('dev.rust.*', 'dev.rustacean.news'));
  assert.ok(!topicPatternMatches('dev.rust.*', 'dev.rust'));
  assert.ok(topicPatternMatches('dev.rust', 'dev.rust'));
  // Topics of other hubs are named "topic@peer", and a pattern reaches them only if it says so.
  assert.ok(!topicPatternMatches('*', 'any.topic@acme'), 'a controller that wrote "*" did not let its agent out to other hubs');
  assert.ok(!topicPatternMatches('dev.rust.*', 'dev.rust.news@acme'));
  assert.ok(!topicPatternMatches('dev.rust.news', 'dev.rust.news@acme'));
  assert.ok(topicPatternMatches('dev.rust.*@acme', 'dev.rust.news@acme'));
  assert.ok(topicPatternMatches('dev.rust.news@acme', 'dev.rust.news@acme'));
  assert.ok(!topicPatternMatches('dev.rust.*@acme', 'dev.rust.news@other'));
  assert.ok(!topicPatternMatches('dev.rust.*@acme', 'ops.alerts@acme'));
  assert.ok(topicPatternMatches('*@acme', 'ops.alerts@acme'));
  assert.ok(!topicPatternMatches('*@acme', 'ops.alerts@other'));
  assert.ok(topicPatternMatches('*@*', 'ops.alerts@other'));
  assert.ok(topicPatternMatches('dev.rust.*@*', 'dev.rust.news@other'));
  assert.ok(!topicPatternMatches('*@*', 'ops.alerts'), 'nor does a pattern for other hubs reach the topics of this one');
  assert.ok(!topicPatternMatches('*@acme', 'ops.alerts'));

  assert.deepEqual(normalizeScope(), { topics_create: true, publish: ['*'], subscribe: ['*'], direct: true });
  const scope = normalizeScope({ publish: ['dev.rust.*'], direct: false });
  assert.ok(scopeAllows(scope, 'publish', 'dev.rust.news'));
  assert.ok(!scopeAllows(scope, 'publish', 'ops.alerts'));
  assert.ok(scopeAllows(scope, 'subscribe', 'ops.alerts'));
  assert.ok(!scopeAllows(scope, 'direct'));
  assert.throws(() => normalizeScope({ publish: ['Not A Pattern'] }), /invalid pattern/);
  assert.throws(() => normalizeScope({ admin: true }), /unknown scope field/);

  // Direct messages to agents of other hubs: only to the hubs the controller names. A delegation
  // that says nothing of them is the statement it always was, and does not let its agent out.
  assert.ok(scopeAllows(normalizeScope(), 'direct'));
  assert.ok(!scopeAllows(normalizeScope(), 'direct_hub', 'acme'), 'a controller that said nothing of other hubs did not let its agent write to them');
  assert.deepEqual(Object.keys(normalizeScope({ direct_hubs: undefined })), ['topics_create', 'publish', 'subscribe', 'direct']);
  const abroad = normalizeScope({ direct_hubs: ['acme'] });
  assert.deepEqual([scopeAllows(abroad, 'direct_hub', 'acme'), scopeAllows(abroad, 'direct_hub', 'globex'), scopeAllows(abroad, 'direct')], [true, false, true]);
  assert.ok(scopeAllows(normalizeScope({ direct_hubs: ['*'] }), 'direct_hub', 'globex'));
  assert.ok(!scopeAllows(normalizeScope({ direct: false, direct_hubs: ['*'] }), 'direct_hub', 'acme'), 'no direct messages at all');
  for (const junk of ['acme', [42], ['Acme'], ['acme@b'], ['a'.repeat(33)], Array.from({ length: 51 }, (_, n) => `hub-${n}`)]) {
    assert.throws(() => normalizeScope({ direct_hubs: junk }), /direct_hubs/, JSON.stringify(junk).slice(0, 40));
  }
});

test('delegations verify, and every way of bending one is caught', async () => {
  const controller = generateIdentity();
  const agent = generateIdentity();
  const envelope = createDelegation(controller, { subject: agent.did, days: 30, scope: { publish: ['dev.rust.*'] } });
  assert.deepEqual(await verifyDelegation(envelope), { ok: true, kind: 'key' });

  const bent = (change) => {
    const copy = structuredClone(envelope);
    change(copy);
    return verifyDelegation(copy);
  };
  // Widening the scope, redirecting it to another agent or extending it breaks the signature.
  assert.match((await bent((e) => (e.delegation.scope.publish = ['*']))).error, /signature does not match/);
  assert.match((await bent((e) => (e.delegation.subject = generateIdentity().did))).error, /signature does not match/);
  assert.match((await bent((e) => (e.delegation.expires_at = new Date(Date.now() + 900 * DAY).toISOString()))).error, /signature does not match/);
  // Letting the agent out to other hubs after the fact breaks it too. Said when signing, it holds - if it is said properly.
  assert.match((await bent((e) => (e.delegation.scope.direct_hubs = ['*']))).error, /signature does not match/);
  const abroad = createDelegation(controller, { subject: agent.did, scope: { direct_hubs: ['acme'] } });
  assert.deepEqual([await verifyDelegation(abroad), abroad.delegation.scope.direct_hubs], [{ ok: true, kind: 'key' }, ['acme']]);
  const vague = structuredClone(abroad);
  vague.delegation.scope.direct_hubs = 'everywhere';
  vague.proof = createProof(CONTEXT.DELEGATION, vague.delegation, controller);
  assert.match((await verifyDelegation(vague)).error, /direct_hubs/);
  // Signed by someone who is not the issuer.
  const impostor = generateIdentity();
  assert.match((await bent((e) => (e.proof = createProof(CONTEXT.DELEGATION, e.delegation, impostor)))).error, /not made with the issuer key/);
  // A signature made for another purpose is not a delegation.
  assert.match((await bent((e) => (e.proof = { ...createProof(CONTEXT.EVENT, e.delegation, controller) }))).error, /different context/);
  assert.match((await bent((e) => (e.delegation.extra = 1))).error, /unexpected fields/);

  const expired = createDelegation(controller, { subject: agent.did, days: 1, now: Date.now() - 2 * DAY });
  assert.match((await verifyDelegation(expired)).error, /expired/);
  const future = createDelegation(controller, { subject: agent.did, now: Date.now() + DAY });
  assert.match((await verifyDelegation(future)).error, /future/);
  const long = createDelegation(controller, { subject: agent.did, days: 365 });
  assert.match((await verifyDelegation(long, { maxValidityMs: 90 * DAY })).error, /longer than the 90 days/);
  assert.throws(() => createDelegation(controller, { subject: controller.did }), /cannot delegate to itself/);
  assert.throws(() => createDelegation(controller, { subject: 'did:web:acme.com' }), /agent did:key/);

  const revocation = createRevocation(controller, { delegation: envelope.delegation, reason: 'laptop lost' });
  assert.deepEqual(await verifyRevocation(revocation), { ok: true, kind: 'key' });
  assert.match((await verifyRevocation(forgedRevocation(impostor, envelope.delegation))).error, /signature does not match/);
  assert.throws(() => createRevocation(impostor, { delegation: envelope.delegation }), /issuer must be/, 'the library will not even sign it');
  // A delegation signature cannot be replayed as a revocation.
  assert.equal((await verifyRevocation({ revocation: revocation.revocation, proof: { ...envelope.proof, context: CONTEXT.REVOCATION } })).ok, false);
});

test('did:web: identifiers map to HTTPS URLs and never to private places', () => {
  assert.equal(didWebUrl('did:web:acme.com'), 'https://acme.com/.well-known/did.json');
  assert.equal(didWebUrl('did:web:acme.com:teams:infra'), 'https://acme.com/teams/infra/did.json');
  assert.equal(didWebUrl('did:web:id.acme.co.uk%3A8443'), 'https://id.acme.co.uk:8443/.well-known/did.json');
  for (const bad of [
    'did:web:localhost', 'did:web:127.0.0.1', 'did:web:10.0.0.1%3A8080', 'did:web:router.local', 'did:web:db.internal',
    'did:web:acme', 'did:web:ACME.com', 'did:web:acme.com:..:secret', 'did:web:acme.com/path', 'did:web:acme.com%3A99999',
    'did:web:-bad.com', 'did:key:z6Mk', 42,
  ]) {
    assert.throws(() => parseDidWeb(bad), `${bad} should be rejected`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.ok(isPublicAddress(address), address);
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::1', 'example.com',
  ]) {
    assert.ok(!isPublicAddress(address), address);
  }
});

test('did:web: only the keys the document authorizes for assertions count', async () => {
  const controller = generateIdentity();
  const stranger = generateIdentity();
  const document = didWebDocument(ACME, controller.did);
  const [[keyId, raw]] = [...documentKeys(document, ACME)];
  assert.equal(keyId, `${ACME}#key-1`);
  assert.equal(raw.length, 32);

  const multibase = (identity) => identity.did.slice('did:key:'.length);
  const jwk = (identity) => ({ kty: 'OKP', crv: 'Ed25519', x: identity.privateKey.export({ format: 'jwk' }).x });
  const mixed = {
    id: ACME,
    verificationMethod: [
      { id: `${ACME}#listed`, controller: ACME, publicKeyMultibase: multibase(controller) },
      { id: '#relative', controller: ACME, publicKeyJwk: jwk(controller) },
      { id: `${ACME}#not-for-assertions`, controller: ACME, publicKeyMultibase: multibase(stranger) },
      { id: `${ACME}#foreign-controller`, controller: 'did:web:evil.com', publicKeyMultibase: multibase(stranger) },
      { id: 'did:web:evil.com#key-1', controller: ACME, publicKeyMultibase: multibase(stranger) },
      { id: `${ACME}#rsa`, controller: ACME, publicKeyJwk: { kty: 'RSA', n: 'x', e: 'AQAB' } },
    ],
    assertionMethod: [`${ACME}#listed`, '#relative', `${ACME}#foreign-controller`, 'did:web:evil.com#key-1', `${ACME}#rsa`, `${ACME}#missing`],
  };
  assert.deepEqual([...documentKeys(mixed, ACME).keys()], [`${ACME}#listed`, `${ACME}#relative`]);
  assert.throws(() => documentKeys({ ...document, id: 'did:web:other.com' }, ACME), /does not describe this DID/);

  // The resolver caches documents and failures, and refuses a document served for the wrong DID.
  const web = fakeWeb({ 'https://acme.com/.well-known/did.json': document, 'https://liar.com/.well-known/did.json': document });
  assert.equal((await web(ACME)).keys.size, 1);
  await web(ACME);
  assert.equal(web.requested.length, 1, 'second resolution came from the cache');
  await assert.rejects(web('did:web:liar.com'), /does not describe this DID/);
  await assert.rejects(web('did:web:missing.com'), /answered 404/);
  await assert.rejects(web('did:web:localhost'), /not a valid did:web/);

  // A delegation signed as the organization verifies only against the organization's document.
  const agent = generateIdentity();
  const delegation = createDelegation(controller, { subject: agent.did, issuer: ACME });
  assert.equal(delegation.proof.key_id, `${ACME}#key-1`);
  assert.deepEqual(await verifyDelegation(delegation, { resolveDidWeb: web }), { ok: true, kind: 'web' });
  assert.equal((await verifyDelegation(delegation)).unresolved, true, 'without a resolver it cannot be checked');
  const usurper = createDelegation(stranger, { subject: agent.did, issuer: ACME });
  assert.match((await verifyDelegation(usurper, { resolveDidWeb: web })).error, /signature does not match/);
  const otherKey = createDelegation(controller, { subject: agent.did, issuer: ACME, keyId: 'key-9' });
  assert.match((await verifyDelegation(otherKey, { resolveDidWeb: web })).error, /not listed under assertionMethod/);
});

// -------------------------------------------------------------------------- hub

test('tiers reflect only what was verified: key, account and org', async (t) => {
  const person = generateIdentity();
  const anonymous = generateIdentity();
  const org = generateIdentity();
  const web = fakeWeb({ 'https://acme.com/.well-known/did.json': didWebDocument(ACME, org.did) });
  const hub = await startHub(t, { resolveDidWeb: web, verifiedControllers: { [person.did]: 'github:alberto' } });
  const delegated = async (name, controller, extra = {}) => {
    const identity = generateIdentity();
    const client = await hub.agent(null, identity);
    return { client, registered: await client.register({ name }, { delegation: createDelegation(controller, { subject: identity.did, ...extra }) }) };
  };

  const plain = await hub.agent('plain');
  assert.equal((await plain.getAgent(plain.did)).tier, 'key');
  assert.equal((await plain.getAgent(plain.did)).controller, null);

  // A delegation from a key nobody verified is honoured, but proves nothing about who is behind it.
  const backed = await delegated('backed-by-unknown', anonymous);
  assert.equal(backed.registered.tier, 'key');
  assert.deepEqual(backed.registered.controller, { did: anonymous.did, verified_as: null });

  const personal = await delegated('alberto-laptop', person);
  assert.equal(personal.registered.tier, 'account');
  assert.equal(personal.registered.controller.verified_as, 'github:alberto');

  const corporate = await delegated('acme-builder', org, { issuer: ACME });
  assert.equal(corporate.registered.tier, 'org');
  assert.deepEqual(corporate.registered.controller, { did: ACME, verified_as: ACME });

  // Readers get the whole delegation and check the controller's signature themselves.
  const seen = await plain.getAgent(personal.client.did);
  assert.equal(seen.delegation.delegation.issuer, person.did);
  assert.equal(seen.controller.checked_locally, true);
  assert.equal((await plain.getAgent(corporate.client.did)).controller.checked_locally, false, 'needs a did:web resolver');
  const careful = new AgentClient({ hubUrl: hub.url, resolveDidWeb: web });
  assert.equal((await careful.getAgent(corporate.client.did)).controller.checked_locally, true);

  // The tier travels with what each agent publishes.
  await plain.createTopic({ name: 'test.tiers.topic', ...OPEN });
  await plain.subscribe('test.tiers.topic');
  await corporate.client.publish('test.tiers.topic', { type: 't', data: {} });
  await personal.client.send(plain.did, { type: 't', data: {} });
  assert.deepEqual((await plain.poll()).messages.map((message) => message.hub.tier), ['org', 'account']);

  // Dropping the delegation takes the agent back to being just a key.
  assert.equal((await corporate.client.dropDelegation()).tier, 'key');
  assert.deepEqual((await corporate.client.info()).tiers, ['key', 'account', 'org']);
});

test('the hub refuses delegations that are not valid for the agent presenting them', async (t) => {
  const web = fakeWeb({});
  const hub = await startHub(t, { resolveDidWeb: web, maxDelegationDays: 90 });
  const controller = generateIdentity();
  const identity = generateIdentity();
  const agent = await hub.agent('agent', identity);
  const make = (options) => createDelegation(controller, { subject: identity.did, ...options });

  await rejects(agent.attachDelegation(createDelegation(controller, { subject: generateIdentity().did })), 400, 'invalid_delegation');
  await rejects(agent.attachDelegation(make({ days: 1, now: Date.now() - 2 * DAY })), 400, 'invalid_delegation');
  await rejects(agent.attachDelegation(make({ days: 365 })), 400, 'invalid_delegation');
  const widened = make({ scope: { publish: ['dev.*'] } });
  widened.delegation.scope.publish = ['*'];
  await rejects(agent.attachDelegation(widened), 400, 'invalid_delegation');
  await rejects(agent.attachDelegation({ delegation: 'nope' }), 400, 'invalid_delegation');
  await rejects(agent.attachDelegation(make({ issuer: 'did:web:unreachable.com' })), 502, 'issuer_unresolved');
  assert.equal((await agent.getAgent(agent.did)).controller, null, 'nothing was attached');

  // A new agent registering with a bad delegation is not registered at all.
  const other = await hub.agent(null);
  await rejects(other.register({ name: 'other' }, { delegation: make({}) }), 400, 'invalid_delegation');
  assert.equal(await agent.getAgent(other.did), null);

  assert.equal((await agent.attachDelegation(make({ days: 90 }))).controller.did, controller.did);
});

test('scope: the controller decides what its agent may do, and the hub enforces it', async (t) => {
  const hub = await startHub(t);
  const owner = await hub.agent('owner');
  await owner.createTopic({ name: 'dev.rust.reviews', ...OPEN });
  await owner.createTopic({ name: 'dev.rust.news', ...OPEN });
  await owner.createTopic({ name: 'ops.alerts.critical', ...OPEN });

  const controller = generateIdentity();
  const identity = generateIdentity();
  const agent = await hub.agent(null, identity);
  const scope = { topics_create: false, publish: ['dev.rust.*'], subscribe: ['dev.rust.reviews'], direct: false };
  const registered = await agent.register({ name: 'scoped' }, { delegation: createDelegation(controller, { subject: identity.did, scope }) });
  assert.deepEqual(registered.delegation.delegation.scope, scope);

  await agent.publish('dev.rust.reviews', { type: 't', data: {} });
  await agent.publish('dev.rust.news', { type: 't', data: {} });
  await agent.subscribe('dev.rust.reviews');
  const denied = await rejects(agent.publish('ops.alerts.critical', { type: 't', data: {} }), 403, 'out_of_scope');
  assert.match(denied.message, /does not allow "publish" on ops\.alerts\.critical/);
  await rejects(agent.subscribe('dev.rust.news'), 403, 'out_of_scope');
  await rejects(agent.send(owner.did, { type: 't', data: {} }), 403, 'out_of_scope');
  await rejects(agent.createTopic({ name: 'dev.rust.mine', ...OPEN }), 403, 'out_of_scope');

  // The scope restricts sending, not being reachable.
  await owner.send(agent.did, { type: 't', data: { hello: true } });
  assert.deepEqual((await agent.poll()).messages.map((message) => message.data), [{ hello: true }]);
});

test('topic policies: who may publish, who may subscribe, and restricted history', async (t) => {
  const person = generateIdentity();
  const hub = await startHub(t, { verifiedControllers: { [person.did]: 'github:alberto' } });
  const owner = await hub.agent('owner');
  const plain = await hub.agent('plain');
  const guest = await hub.agent('guest');
  const verifiedIdentity = generateIdentity();
  const verified = await hub.agent(null, verifiedIdentity);
  await verified.register({ name: 'verified' }, { delegation: createDelegation(person, { subject: verifiedIdentity.did }) });

  // Publishing reserved to verified accounts, reading open to all.
  await owner.createTopic({ name: 'test.verified.publishers', ...OPEN, publish: { min_tier: 'account' } });
  await rejects(plain.publish('test.verified.publishers', { type: 't', data: {} }), 403, 'publish_not_allowed');
  await verified.publish('test.verified.publishers', { type: 't', data: {} });
  await owner.publish('test.verified.publishers', { type: 't', data: {} });
  await plain.subscribe('test.verified.publishers');

  // A restricted topic: only verified accounts and one named guest may read it.
  const restricted = 'test.members.only';
  const created = await owner.createTopic({ name: restricted, ...OPEN, subscribe: { min_tier: 'account', allow: [guest.did] } });
  assert.deepEqual(created.subscribe, { min_tier: 'account', allow: [guest.did] });
  await rejects(plain.subscribe(restricted), 403, 'subscribe_not_allowed');
  await verified.subscribe(restricted);
  await guest.subscribe(restricted);
  const receipt = await owner.publish(restricted, { type: 't', data: { n: 1 } });
  assert.equal(receipt.delivered_to, 2);

  // Its history is not public either.
  assert.equal((await fetch(`${hub.url}/v1/topics/${restricted}/events`)).status, 401);
  await rejects(plain.topicHistory(restricted), 403, 'subscribe_not_allowed');
  assert.equal((await guest.topicHistory(restricted)).events.length, 1);
  assert.equal((await fetch(`${hub.url}/v1/topics/test.verified.publishers/events`)).status, 200, 'open topics stay publicly readable');
  assert.equal((await new AgentClient({ hubUrl: hub.url }).topicHistory('test.verified.publishers')).events.length, 2, 'even for an unregistered key');

  // Eligibility is checked again on delivery: a subscriber whose verification lapses stops receiving.
  await verified.dropDelegation();
  assert.equal((await owner.publish(restricted, { type: 't', data: { n: 2 } })).delivered_to, 1);

  // Only the owner changes the policy; tightening it removes whoever no longer fits.
  await rejects(plain.setTopicPolicy(restricted, { subscribe: 'any' }), 403, 'not_owner');
  const tightened = await owner.setTopicPolicy(restricted, { subscribe: { allow: [] }, publish: 'owner' });
  assert.equal(tightened.unsubscribed, 2);
  assert.equal(tightened.subscribers, 0);
  assert.equal(tightened.publish, 'owner');
  assert.equal((await owner.publish(restricted, { type: 't', data: { n: 3 } })).delivered_to, 0);
  assert.deepEqual((await guest.poll()).messages.map((message) => message.data.n), [1, 2]);

  for (const policy of ['everyone', { min_tier: 'key' }, { min_tier: 'root' }, { allow: ['not-a-did'] }, {}, { admins: true }, 'owner']) {
    await rejects(owner.createTopic({ name: 'test.bad.policy', ...OPEN, subscribe: policy }), 400, 'invalid_topic');
  }
});

test('a hub can reserve topic creation for verified tiers', async (t) => {
  const person = generateIdentity();
  const hub = await startHub(t, { topicCreateMinTier: 'account', verifiedControllers: { [person.did]: 'github:alberto' } });
  const plain = await hub.agent('plain');
  const denied = await rejects(plain.createTopic({ name: 'test.plain.topic', ...OPEN }), 403, 'tier_too_low');
  assert.match(denied.message, /requires tier "account"; this agent is "key"/);
  await plain.attachDelegation(createDelegation(person, { subject: plain.did }));
  assert.equal((await plain.createTopic({ name: 'test.plain.topic', ...OPEN })).owner, plain.did);
  assert.equal((await plain.info()).topic_create_min_tier, 'account');
  assert.throws(() => createHub({ topicCreateMinTier: 'root' }), /topicCreateMinTier/);
});

test('revocation: the controller retires its agent without touching the agent', async (t) => {
  const hub = await startHub(t);
  const controller = generateIdentity();
  const identity = generateIdentity();
  const laptop = await hub.agent(null, identity);
  const delegation = createDelegation(controller, { subject: identity.did });
  await laptop.register({ name: 'laptop-agent', description: 'runs on a laptop that will be stolen' }, { delegation });
  const peer = await hub.agent('peer');
  await peer.createTopic({ name: 'test.revocation.topic', ...OPEN });
  await peer.subscribe('test.revocation.topic');
  await laptop.subscribe('test.revocation.topic');

  const streamErrors = [];
  const listener = laptop.listen(() => {}, { onError: (err) => streamErrors.push(err) });
  await listener.ready;
  // What the thief sends before anyone notices is still waiting in the peer's inbox...
  await laptop.send(peer.did, { type: 't', data: { text: 'send me the credentials' } });
  await laptop.publish('test.revocation.topic', { type: 't', data: { forged: true } });
  assert.equal(hub.store.pending(peer.did).length, 2);

  // Someone who is not the controller cannot revoke it, whatever they sign.
  const stranger = generateIdentity();
  await assert.rejects(
    submitRevocation(hub.url, forgedRevocation(stranger, delegation.delegation)),
    (err) => err instanceof HubError && err.code === 'invalid_revocation',
  );
  const unrelated = createRevocation(stranger, { delegation: { ...delegation.delegation, issuer: stranger.did } });
  assert.equal((await submitRevocation(hub.url, unrelated)).agent_revoked, false);
  assert.equal((await peer.getAgent(laptop.did)).status, 'active');

  // The controller revokes from anywhere: no agent identity, only its signature.
  const result = await submitRevocation(hub.url, createRevocation(controller, { delegation: delegation.delegation, reason: 'laptop stolen' }));
  assert.deepEqual(result, { delegation_id: delegation.delegation.id, subject: laptop.did, agent_revoked: true });

  // ...and is dropped: the live stream is cut, the identity is locked out and unreachable.
  await settle();
  assert.deepEqual(streamErrors.map((err) => err.code), ['agent_revoked']);
  assert.equal(hub.store.pending(peer.did).length, 0);
  const locked = await rejects(laptop.send(peer.did, { type: 't', data: {} }), 403, 'agent_revoked');
  assert.equal(locked.details.revoked_by, controller.did);
  await rejects(laptop.subscriptions(), 403, 'agent_revoked');
  await rejects(laptop.register({ name: 'back-again' }), 403, 'agent_revoked');
  await rejects(peer.send(laptop.did, { type: 't', data: {} }), 404, 'recipient_not_found');
  assert.equal((await peer.publish('test.revocation.topic', { type: 't', data: {} })).delivered_to, 0);

  const view = await peer.getAgent(laptop.did);
  assert.equal(view.status, 'revoked');
  assert.equal(view.revoked.by, controller.did);
  assert.equal(view.revoked.reason, 'laptop stolen');
  assert.deepEqual(await peer.searchAgents('laptop stolen'), [], 'revoked agents leave the directory');

  // The revocation is public and carries the controller's signature, so anyone can check it.
  const { revocations, last_seq: lastSeq } = await peer.revocations();
  assert.equal(lastSeq, 1);
  assert.equal(revocations[0].did, laptop.did);
  assert.deepEqual(await verifyRevocation(revocations[0].revocation), { ok: true, kind: 'key' });

  // Submitting it again changes nothing.
  assert.equal((await submitRevocation(hub.url, createRevocation(controller, { delegation: delegation.delegation }))).agent_revoked, false);
});

test('a revoked delegation can never be presented, and an agent can retire itself', async (t) => {
  const hub = await startHub(t);
  const controller = generateIdentity();
  const agent = await hub.agent('agent');

  // Revoked before the agent ever used it.
  const early = createDelegation(controller, { subject: agent.did });
  assert.equal((await submitRevocation(hub.url, createRevocation(controller, { delegation: early.delegation }))).agent_revoked, false);
  await rejects(agent.attachDelegation(early), 403, 'delegation_revoked');
  // Another delegation from the same controller is unaffected.
  assert.equal((await agent.attachDelegation(createDelegation(controller, { subject: agent.did }))).controller.did, controller.did);

  const peer = await hub.agent('peer');
  const retired = await agent.retire();
  assert.equal(retired.status, 'revoked');
  assert.equal(retired.revoked.by, agent.did);
  await rejects(agent.updateCard({ name: 'still-here' }), 403, 'agent_revoked');
  assert.equal((await peer.revocations()).revocations[0].revocation, null, 'self-retirement carries no controller signature');
});

test('delegations, revocations and policies survive a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agenthub-trust-'));
  const options = { port: 0, quiet: true, powDifficulty: 8, dataDir, limits: { register: GENEROUS, challenge: GENEROUS, topicCreate: GENEROUS } };
  const controller = generateIdentity();
  const identities = { kept: generateIdentity(), gone: generateIdentity(), owner: generateIdentity() };
  const delegations = Object.fromEntries(Object.entries(identities).map(([name, identity]) => [name, createDelegation(controller, { subject: identity.did })]));
  try {
    let hub = await createHub(options).listen();
    const connect = (name) => new AgentClient({ hubUrl: hub.url, identity: identities[name] });
    for (const name of Object.keys(identities)) await connect(name).register({ name }, { delegation: delegations[name] });
    await connect('owner').createTopic({ name: 'test.persisted.topic', ...OPEN, subscribe: { allow: [identities.kept.did] }, publish: 'owner' });
    await connect('kept').subscribe('test.persisted.topic');
    await submitRevocation(hub.url, createRevocation(controller, { delegation: delegations.gone.delegation, reason: 'gone' }));
    const unused = createDelegation(controller, { subject: identities.kept.did });
    await submitRevocation(hub.url, createRevocation(controller, { delegation: unused.delegation }));
    await hub.close();

    hub = await createHub(options).listen();
    const kept = connect('kept');
    const view = await kept.getAgent(identities.kept.did);
    assert.equal(view.controller.did, controller.did);
    assert.equal(view.delegation.delegation.id, delegations.kept.delegation.id);
    assert.equal((await kept.getAgent(identities.gone.did)).status, 'revoked');
    await rejects(connect('gone').subscriptions(), 403, 'agent_revoked');
    await rejects(kept.attachDelegation(unused), 403, 'delegation_revoked');
    assert.equal((await kept.revocations()).revocations.length, 1);
    const topic = await kept.getTopic('test.persisted.topic');
    assert.deepEqual([topic.publish, topic.subscribe], ['owner', { allow: [identities.kept.did] }]);
    assert.equal((await connect('owner').publish('test.persisted.topic', { type: 't', data: {} })).delivered_to, 1);
    await hub.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- deployment

test('behind a proxy, limits follow the forwarded client address only when told to trust it', async (t) => {
  const tight = { limits: { challenge: { burst: 2, perMinute: 1 } } };
  const ask = async (hub, forwardedFor) => (await fetch(`${hub.url}/v1/challenges`, { method: 'POST', headers: { 'x-forwarded-for': forwardedFor } })).status;

  const proxied = await startHub(t, { ...tight, trustProxy: 1 });
  assert.deepEqual([await ask(proxied, '203.0.113.7'), await ask(proxied, '203.0.113.7'), await ask(proxied, '203.0.113.7')], [201, 201, 429]);
  assert.equal(await ask(proxied, '198.51.100.9'), 201, 'another client has its own budget');
  assert.equal(await ask(proxied, '198.51.100.9, 203.0.113.7'), 429, 'a client cannot escape by prepending addresses');

  const direct = await startHub(t, tight);
  assert.deepEqual([await ask(direct, '1.1.1.1'), await ask(direct, '2.2.2.2'), await ask(direct, '3.3.3.3')], [201, 201, 429]);
});

test('the hub serves HTTPS when given a certificate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
  } catch {
    t.skip('openssl is not available to create a test certificate');
    return;
  }
  const cert = readFileSync(join(dir, 'cert.pem'));
  const hub = await startHub(t, { tls: { cert, key: readFileSync(join(dir, 'key.pem')) } });
  assert.match(hub.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  const body = await new Promise((resolve, reject) => {
    https
      .get(`${hub.url}/v1/info`, { ca: cert }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(JSON.parse(text)));
      })
      .on('error', reject);
  });
  assert.equal(body.name, 'agent-hub');
  await assert.rejects(fetch(hub.url.replace('https', 'http') + '/healthz'), 'plain HTTP is not served on the TLS port');
});
