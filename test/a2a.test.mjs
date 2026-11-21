// SPDX-License-Identifier: Apache-2.0
// The card of an agent as A2A reads one (core/a2a.mjs): made by rule from the card the agent signs
// for its hub, signed by the agent as A2A asks, and served by the hub, which writes none of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2A_BINDING, a2aCard, a2aCardPath, signA2ACard, signedA2ACard, signJws, verifyA2ACard, verifyJws } from '../src/core/a2a.mjs';
import { canonicalize } from '../src/core/jcs.mjs';
import { publicKeyFromDid } from '../src/core/didkey.mjs';
import { signCard } from '../src/core/sign.mjs';
import { solvePow } from '../src/core/pow.mjs';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, generateIdentity, moderation } from '../src/sdk/index.mjs';
import { deadHubUrl, GENEROUS, instanceOf, signedFetch, startHub } from './helpers.mjs';

const served = async (hub, did) => {
  // Asked twice if need be: a hub started again on the port of one just closed can be met by a connection kept from the first.
  const ask = () => fetch(hub.url + a2aCardPath(did));
  const res = await ask().catch(ask);
  const json = await res.json();
  return { status: res.status, headers: res.headers, json, code: json?.error?.code ?? null };
};
const keyId = (did) => `${did}#${did.slice('did:key:'.length)}`;
const header = (did, more = {}) => ({ alg: 'EdDSA', typ: 'JOSE', kid: keyId(did), ...more });
/** A card as an agent would send it, with whatever goes in `a2a`. */
const cardWith = (identity, said, a2a) => signCard({ ...said, did: identity.did, updated_at: '2026-11-16T10:00:00.000Z', ...(a2a === undefined ? {} : { a2a }) }, identity);

/** Registers by hand: what the SDK would not send, the hub has to refuse. */
async function register(hub, identity, card_envelope) {
  const { challenge, difficulty } = await (await fetch(`${hub.url}/v1/challenges`, { method: 'POST' })).json();
  return signedFetch(hub, identity, 'POST', '/v1/agents', { challenge, pow_nonce: solvePow(challenge, identity.did, difficulty), card_envelope });
}

test('the JWS an agent signs is the one of RFC 8037', () => {
  // Appendix A.1 (the key) and A.4 (the signature) of RFC 8037.
  const d = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A';
  const x = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
  const payload = 'Example of Ed25519 signing';
  const expected = {
    protected: 'eyJhbGciOiJFZERTQSJ9',
    signature: 'hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg',
  };
  assert.deepEqual(signJws({ alg: 'EdDSA' }, payload, createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' })), expected);
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  assert.deepEqual(verifyJws(expected, payload, publicKey), { alg: 'EdDSA' });
  assert.equal(verifyJws(expected, 'Example of Ed25519 signing.', publicKey), null);
  assert.equal(verifyJws({ ...expected, protected: Buffer.from('{"alg":"none"}').toString('base64url') }, payload, publicKey), null);
});

test('a card in canonical form is the one the A2A specification shows', () => {
  // Section 8.4.1 of A2A 1.0: its example card with the default values removed, and what is signed of it.
  const card = {
    name: 'Example Agent',
    description: 'An example agent that echoes messages.',
    supportedInterfaces: [{ url: 'https://example.com/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the input.', tags: ['echo'] }],
  };
  assert.equal(
    canonicalize(card),
    '{"capabilities":{"pushNotifications":false,"streaming":false},"defaultInputModes":["text/plain"],"defaultOutputModes":["text/plain"],"description":"An example agent that echoes messages.","name":"Example Agent","skills":[{"description":"Echoes the input.","id":"echo","name":"Echo","tags":["echo"]}],"supportedInterfaces":[{"protocolBinding":"JSONRPC","protocolVersion":"1.0","url":"https://example.com/a2a/v1"}],"version":"1.0.0"}',
  );
});

test('an agent has its card as A2A reads it, signed by itself and served by its hub', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent(null);
  await reviewer.register({ name: 'rust-reviewer', description: 'Revisa código Rust', skills: [{ name: 'code review', description: 'unsafe y rendimiento' }, { name: 'benchmarks' }] });
  const reader = await hub.agent('reader');
  const origin = new URL(hub.url).origin;

  const { status, headers, json: card } = await served(hub, reviewer.did);
  assert.equal(status, 200);
  assert.match(headers.get('cache-control'), /max-age=\d+/);
  assert.match(headers.get('etag'), /^"[A-Za-z0-9_-]+"$/);
  const onRecord = (await reader.getAgent(reviewer.did)).card;
  const { signatures, ...unsigned } = card;
  assert.deepEqual(unsigned, {
    name: 'rust-reviewer',
    description: 'Revisa código Rust',
    supportedInterfaces: [{ url: origin, protocolBinding: A2A_BINDING, tenant: reviewer.did, protocolVersion: '1.0' }],
    version: onRecord.updated_at,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      { id: 'skill-1', name: 'code review', description: 'unsafe y rendimiento', tags: ['code review'] },
      { id: 'skill-2', name: 'benchmarks', description: 'benchmarks', tags: ['benchmarks'] },
    ],
  });

  // Checked the way anybody can, with nothing of this project but JCS: the key is in the signature.
  assert.equal(signatures.length, 1);
  const protectedHeader = JSON.parse(Buffer.from(signatures[0].protected, 'base64url').toString());
  assert.deepEqual(protectedHeader, { alg: 'EdDSA', typ: 'JOSE', kid: keyId(reviewer.did) });
  const input = Buffer.from(`${signatures[0].protected}.${Buffer.from(canonicalize(unsigned)).toString('base64url')}`);
  assert.equal(edVerify(null, input, publicKeyFromDid(protectedHeader.kid.split('#')[0]), Buffer.from(signatures[0].signature, 'base64url')), true);
  assert.deepEqual(verifyA2ACard(card, { did: reviewer.did, hub: hub.url }), { ok: true, did: reviewer.did, hub: origin });
  assert.deepEqual(verifyA2ACard(card), { ok: true, did: reviewer.did, hub: origin });

  // The SDK makes the same card from the one on record, and says where the hub serves it.
  assert.deepEqual(await reader.a2aCard(reviewer.did), card);
  assert.deepEqual(await reviewer.a2aCard(), card);
  assert.equal(reader.a2aCardUrl(reviewer.did), `${hub.url}/a2a/${encodeURIComponent(reviewer.did)}/.well-known/agent-card.json`);
  // The address an A2A client is given ends in a slash: the path of the card is read as relative to it.
  assert.equal(new URL('.well-known/agent-card.json', reader.a2aAddress(reviewer.did)).href, reader.a2aCardUrl(reviewer.did));
  assert.equal(reviewer.a2aAddress(), `${hub.url}/a2a/${encodeURIComponent(reviewer.did)}/`);
  assert.deepEqual((await (await fetch(`${hub.url}/v1/info`)).json()).a2a, { version: '1.0', binding: A2A_BINDING });

  // An agent that said little: A2A wants a description and one skill, and they are what the agent did say.
  const plain = (await served(hub, reader.did)).json;
  assert.equal(plain.description, 'reader');
  assert.deepEqual(plain.skills, [{ id: 'agent', name: 'reader', description: 'reader', tags: ['reader'] }]);
  assert.equal(verifyA2ACard(plain, { did: reader.did, hub: hub.url }).ok, true);

  // A new card is a new A2A card: the agent signs both at once.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reviewer.updateCard({ name: 'rust-auditor' });
  const renamed = (await served(hub, reviewer.did)).json;
  assert.equal(renamed.name, 'rust-auditor');
  assert.notEqual(renamed.version, card.version);
  assert.equal(verifyA2ACard(renamed, { did: reviewer.did, hub: hub.url }).ok, true);
  await reviewer.rotateEncryptionKey();
  assert.equal(verifyA2ACard((await served(hub, reviewer.did)).json, { did: reviewer.did, hub: hub.url }).ok, true);
  // The earlier one still carries a good signature: nothing in A2A says it is not the latest. The
  // SDK does not ask the hub for the card: it makes it from the one in the log.
  assert.equal(verifyA2ACard(card, { did: reviewer.did, hub: hub.url }).ok, true);
  assert.equal((await reader.a2aCard(reviewer.did)).name, 'rust-auditor');
});

test('a hub serves no A2A card that it would have to write itself', async (t) => {
  const operator = generateIdentity();
  const hub = await startHub(t, { operators: [operator.did] });
  const reader = await hub.agent('reader');

  // Nobody there.
  const nobody = generateIdentity().did;
  assert.deepEqual([(await served(hub, nobody)).status, (await served(hub, nobody)).code], [404, 'agent_not_found']);
  assert.equal(await reader.a2aCard(nobody), null);
  assert.equal((await served(hub, 'not-a-did')).code, 'agent_not_found');

  // An agent whose client signs no A2A card: its card is on record, and the hub does not make one of it.
  const old = generateIdentity();
  assert.equal((await register(hub, old, cardWith(old, { name: 'old-client' }))).status, 201);
  assert.deepEqual([(await served(hub, old.did)).status, (await served(hub, old.did)).code], [404, 'no_a2a_card']);
  assert.equal(await reader.a2aCard(old.did), null);
  assert.equal((await reader.getAgent(old.did)).card.name, 'old-client');

  // An agent the hub would not show in a search has no card to show outside either.
  const spammer = await hub.agent('spammer');
  const desk = moderation(hub.url, operator);
  assert.equal((await served(hub, spammer.did)).status, 200);
  await desk.suspend(`agent:${spammer.did}`, 'spam');
  assert.equal((await served(hub, spammer.did)).code, 'no_a2a_card');
  await desk.unsuspend(`agent:${spammer.did}`);
  assert.equal((await served(hub, spammer.did)).status, 200);

  // Nor has one that retired.
  const leaver = await hub.agent('leaver');
  assert.equal((await served(hub, leaver.did)).status, 200);
  await leaver.retire();
  assert.equal((await served(hub, leaver.did)).code, 'no_a2a_card');
  assert.equal(await reader.a2aCard(leaver.did), null);

  // What the hub has on record changed behind the agent's back: there is no signature for that.
  const victim = await hub.agent('victim');
  const record = hub.store.agents.get(victim.did).card;
  record.name = 'impostor';
  assert.equal((await served(hub, victim.did)).code, 'no_a2a_card');
  await assert.rejects(reader.a2aCard(victim.did), /fails verification/);
  record.name = 'victim'; // the card is also in the log of the hub, which has to hold when the test ends
  assert.equal((await served(hub, victim.did)).status, 200);
});

test('a hub does not take as the A2A signature of an agent one that is not', async (t) => {
  const hub = await startHub(t);
  const mallory = generateIdentity();
  const said = { name: 'honest', description: 'does things' };
  const full = (identity) => ({ ...said, did: identity.did, updated_at: '2026-11-16T10:00:00.000Z' });
  const payload = (identity, hubUrl = hub.url) => canonicalize(a2aCard(full(identity), hubUrl));
  const attempt = async (identity, a2a) => {
    const answer = await register(hub, identity, cardWith(identity, said, a2a));
    return answer.status === 201 ? 201 : `${answer.status} ${answer.code}`;
  };

  // The real thing, made by hand: what the others are measured against.
  const honest = generateIdentity();
  assert.equal(await attempt(honest, signA2ACard(full(honest), hub.url, honest)), 201);
  assert.equal((await served(hub, honest.did)).status, 200);

  // Signed by somebody else, under their own name or under the agent's.
  const a = generateIdentity();
  assert.equal(await attempt(a, signJws(header(mallory.did), payload(a), mallory.privateKey)), '400 invalid_card');
  assert.equal(await attempt(a, signJws(header(a.did), payload(a), mallory.privateKey)), '400 invalid_card');
  // The agent's own key, saying it is another's.
  assert.equal(await attempt(a, signJws(header(mallory.did), payload(a), a.privateKey)), '400 invalid_card');
  // Signed for another hub: a card is for one address.
  assert.equal(await attempt(a, signA2ACard(full(a), 'https://other-hub.example', a)), '400 invalid_card');
  // Signed over something the card does not say.
  assert.equal(await attempt(a, signA2ACard({ ...full(a), name: 'trusted-bank' }, hub.url, a)), '400 invalid_card');
  assert.equal(await attempt(a, signA2ACard({ ...full(a), updated_at: '2020-01-01T00:00:00.000Z' }, hub.url, a)), '400 invalid_card');
  // Not EdDSA, or not a signature at all.
  assert.equal(await attempt(a, signJws({ ...header(a.did), alg: 'none' }, payload(a), a.privateKey)), '400 invalid_card');
  const good = signA2ACard(full(a), hub.url, a);
  for (const broken of ['signed', null, [], {}, { protected: good.protected }, { ...good, signature: 'AAAA' }, { ...good, protected: 'not base64url!' }, { ...good, header: { kid: 'x' } }, { ...good, protected: 'A'.repeat(401) }]) {
    assert.equal(await attempt(a, broken), '400 invalid_card', JSON.stringify(broken));
  }
  // None of that left anything behind, and the same agent can still come in.
  assert.equal((await served(hub, a.did)).code, 'agent_not_found');
  assert.equal(await attempt(a, good), 201);

  // The same holds for a card that replaces another.
  const update = (a2a) => signedFetch(hub, a, 'PUT', '/v1/agents/me', { card_envelope: cardWith(a, { name: 'renamed' }, a2a) });
  assert.equal((await update(good)).code, 'invalid_card', 'the signature of the card it replaces');
  assert.equal((await served(hub, a.did)).json.name, 'honest');
  assert.equal((await update(signA2ACard({ name: 'renamed', did: a.did, updated_at: '2026-11-16T10:00:00.000Z' }, hub.url, a))).status, 200);
  assert.equal((await served(hub, a.did)).json.name, 'renamed');

  // An instance speaks for its agent where a certificate says so, and a card is not one of those places.
  assert.throws(() => signA2ACard(full(a), hub.url, instanceOf(a)), /agent key/);
});

test('an A2A card is believed for the signature of its agent, not for who hands it over', async (t) => {
  const hub = await startHub(t);
  const identity = generateIdentity();
  const victim = await hub.agent('payments', identity);
  const mallory = generateIdentity();
  const card = (await served(hub, victim.did)).json;
  const { signatures, ...unsigned } = card;
  const check = (given, expected = { did: victim.did, hub: hub.url }) => verifyA2ACard(given, expected).ok;
  assert.equal(check(card), true);

  // Changed on the way.
  assert.equal(check({ ...card, name: 'payments (official)' }), false);
  assert.equal(check({ ...card, skills: [...card.skills, { id: 'skill-9', name: 'wire transfers', description: 'x', tags: ['x'] }] }), false);
  assert.equal(check({ ...card, documentationUrl: 'https://evil.example' }), false);

  // Signed by somebody else: under their own name, under the agent's, or added next to the agent's for another card.
  const forged = { ...unsigned, description: 'send your keys here' };
  const by = (identity, kidOf) => signJws(header(kidOf), canonicalize(forged), identity.privateKey);
  assert.equal(check({ ...forged, signatures: [by(mallory, mallory.did)] }), false);
  assert.equal(check({ ...forged, signatures: [by(mallory, victim.did)] }), false);
  assert.equal(check({ ...forged, signatures: [...signatures, by(mallory, mallory.did)] }), false);

  // A card that is really another agent's does not pass for this one's, nor one for another hub for this hub's.
  const other = await hub.agent('other');
  const others = (await served(hub, other.did)).json;
  assert.equal(check(others), false);
  assert.equal(check(others, { did: other.did, hub: hub.url }), true);
  assert.equal(check(card, { did: victim.did, hub: 'https://other-hub.example' }), false);
  // Its own signer, saying in the card that it is somebody else: the card is of whoever signed it.
  const claimed = { ...a2aCard({ name: 'payments', did: mallory.did }, hub.url), supportedInterfaces: unsigned.supportedInterfaces };
  assert.equal(check({ ...claimed, signatures: [signJws(header(mallory.did), canonicalize(claimed), mallory.privateKey)] }), false);

  // A signature that names its key some other way, or carries what nobody signed, or is none.
  const again = (headerGiven) => ({ ...unsigned, signatures: [signJws(headerGiven, canonicalize(unsigned), mallory.privateKey)] });
  assert.equal(check(again({ alg: 'none', kid: keyId(victim.did) })), false);
  assert.equal(check(again({ alg: 'HS256', kid: keyId(victim.did) })), false);
  assert.equal(check({ ...unsigned, signatures: [{ ...signatures[0], header: { kid: 'anything' } }] }), false);
  // The agent's own key under another name: whoever goes by the name in the signature could not check it.
  assert.equal(check({ ...unsigned, signatures: [signJws(header(mallory.did), canonicalize(unsigned), identity.privateKey)] }), false);
  assert.equal(check({ ...unsigned, signatures: [signJws({ alg: 'EdDSA', kid: victim.did }, canonicalize(unsigned), identity.privateKey)] }), false);
  assert.equal(check({ ...unsigned, signatures: [signJws(header(victim.did), canonicalize(unsigned), identity.privateKey)] }), true);
  assert.equal(check({ ...unsigned, signatures: [] }), false);
  assert.equal(check(unsigned), false);
  assert.equal(check({ ...unsigned, signatures: Array(6).fill(signatures[0]) }), false);
  for (const junk of [null, 'card', [], 7]) assert.equal(check(junk), false);
  // No way of reaching it through a hub, or a hub that is not an address, or an agent that is not a key.
  assert.equal(check({ ...card, supportedInterfaces: [{ url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }), false);
  const signedAs = (changed) => ({ ...changed, signatures: [signJws(header(victim.did), canonicalize(changed), identity.privateKey)] });
  const elsewhere = (url) => signedAs({ ...unsigned, supportedInterfaces: [{ ...unsigned.supportedInterfaces[0], url }] });
  assert.equal(verifyA2ACard(elsewhere('https://hub.example')).ok, true);
  for (const url of ['https://hub.example/agents', 'hub.example', 'HTTPS://HUB.EXAMPLE', 'ftp://hub.example']) assert.equal(verifyA2ACard(elsewhere(url)).ok, false, url);
  assert.equal(verifyA2ACard(signedAs({ ...unsigned, supportedInterfaces: [{ ...unsigned.supportedInterfaces[0], tenant: 'payments' }] })).ok, false);
});

test('an A2A card is for one hub: at another address, or on another hub, it is signed again', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-a2a-'));
  const port = Number(new URL(await deadHubUrl()).port);
  const identity = generateIdentity();
  // A hub over the same data each time, stopped here and not when the test ends.
  let running = null;
  t.after(() => running?.close());
  const start = async (options) => (running = await createHub({ quiet: true, powDifficulty: 8, dataDir: dir, ...options }).listen());
  const stop = async () => {
    await running.close();
    running = null;
  };

  // It is in the card, so it is in what the hub keeps: stopped and started, the hub still serves it.
  let hub = await start({ port });
  const before = new AgentClient({ hubUrl: hub.url, identity });
  await before.register({ name: 'keeper' });
  await before.close();
  const first = (await served(hub, identity.did)).json;
  assert.equal(verifyA2ACard(first, { did: identity.did, hub: hub.url }).ok, true);
  await stop();
  hub = await start({ port });
  assert.deepEqual((await served(hub, identity.did)).json, first);
  await stop();

  // The same hub at another address: the card was signed for the old one, and the agent signs it anew.
  hub = await startHub(t, { dataDir: dir });
  t.after(() => rmSync(dir, { recursive: true, force: true })); // after the hub that writes there has closed
  assert.notEqual(hub.url, first.supportedInterfaces[0].url);
  assert.equal((await served(hub, identity.did)).code, 'no_a2a_card');
  const keeper = hub.client(identity);
  assert.equal(await keeper.a2aCard(), null);
  await keeper.updateCard({ name: 'keeper' });
  const second = (await served(hub, identity.did)).json;
  assert.equal(second.supportedInterfaces[0].url, hub.url);
  assert.equal(verifyA2ACard(second, { did: identity.did, hub: hub.url }).ok, true);
  assert.equal(verifyA2ACard(first, { did: identity.did, hub: hub.url }).ok, false);

  // An agent of another hub: its card says where it is, and this hub serves no A2A card for it.
  const far = await startHub(t, { limits: { federation: GENEROUS } });
  hub.addPeer({ name: 'far', url: far.url, did: far.did });
  far.addPeer({ name: 'near', url: hub.url, did: hub.did });
  const bob = await far.agent('bob');
  const seen = await keeper.getAgent(`${bob.did}@far`);
  assert.equal(verifyA2ACard(signedA2ACard(seen.card, far.url), { did: bob.did, hub: far.url }).ok, true);
  assert.equal(signedA2ACard(seen.card, hub.url), null);
  assert.equal(await keeper.a2aCard(`${bob.did}@far`), null);
  assert.equal((await served(hub, bob.did)).code, 'agent_not_found');
  assert.equal((await served(far, bob.did)).status, 200);
});
