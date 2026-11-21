import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, seal, x25519RawPublicKey } from '../src/core/hpke.mjs';
import { decryptDirect, encryptDirect, generateEncryptionKey, publicEncryptionKey, checkPublicEncryptionKey } from '../src/core/e2e.mjs';
import { generateIdentity, exportIdentity } from '../src/core/didkey.mjs';
import { signEvent } from '../src/core/sign.mjs';
import { signRequest } from '../src/core/reqsig.mjs';
import { loadOrCreateIdentity, saveIdentity } from '../src/sdk/index.mjs';
import { errorText, rejects, startHub } from './helpers.mjs';

const hex = (value) => Buffer.from(value, 'hex');
const x25519Private = (rawHex) =>
  createPrivateKey({ key: Buffer.concat([hex('302e020100300506032b656e04220420'), hex(rawHex)]), format: 'der', type: 'pkcs8' });

test('HPKE reproduces RFC 9180 test vector A.1.1 (X25519, HKDF-SHA256, AES-128-GCM)', () => {
  const info = hex('4f6465206f6e2061204772656369616e2055726e');
  const ephemeralPrivate = x25519Private('52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736');
  const recipientPrivate = x25519Private('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8');
  const recipientPublic = hex('3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d');
  const plaintext = hex('4265617574792069732074727574682c20747275746820626561757479');
  const aad = hex('436f756e742d30');
  assert.deepEqual(x25519RawPublicKey(recipientPrivate), recipientPublic);

  const sealed = seal({
    recipientPublicKey: recipientPublic,
    info,
    aad,
    plaintext,
    aead: 'aes-128-gcm',
    ephemeral: { privateKey: ephemeralPrivate, publicKey: createPublicKey(ephemeralPrivate) },
  });
  assert.equal(sealed.enc.toString('hex'), '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431');
  assert.equal(sealed.ciphertext.toString('hex'), 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a');
  assert.deepEqual(open({ recipientPrivateKey: recipientPrivate, enc: sealed.enc, info, aad, ciphertext: sealed.ciphertext, aead: 'aes-128-gcm' }), plaintext);
});

test('HPKE refuses the wrong key, context, associated data or a modified ciphertext', () => {
  const recipient = generateEncryptionKey();
  const other = generateEncryptionKey();
  const args = { info: Buffer.from('ctx'), aad: Buffer.from('aad') };
  const sealed = seal({ recipientPublicKey: Buffer.from(recipient.public, 'base64url'), plaintext: Buffer.from('secreto'), ...args });
  const attempt = (changes) => () => open({ recipientPrivateKey: recipient.privateKey, enc: sealed.enc, ciphertext: sealed.ciphertext, ...args, ...changes });

  assert.equal(attempt({})().toString(), 'secreto');
  assert.throws(attempt({ recipientPrivateKey: other.privateKey }));
  assert.throws(attempt({ info: Buffer.from('other') }));
  assert.throws(attempt({ aad: Buffer.from('other') }));
  const flipped = Buffer.from(sealed.ciphertext);
  flipped[0] ^= 1;
  assert.throws(attempt({ ciphertext: flipped }));
  assert.throws(attempt({ ciphertext: sealed.ciphertext.subarray(0, 8) }));
  assert.throws(attempt({ enc: Buffer.alloc(32) }), /invalid public key/); // low-order point

  // Two encryptions of the same message share nothing an observer could correlate.
  const again = seal({ recipientPublicKey: Buffer.from(recipient.public, 'base64url'), plaintext: Buffer.from('secreto'), ...args });
  assert.notDeepEqual(again.enc, sealed.enc);
  assert.notDeepEqual(again.ciphertext, sealed.ciphertext);
});

test('sealed direct messages are bound to sender, recipient and event id', () => {
  const key = generateEncryptionKey();
  const meta = { source: 'did:key:alice', recipient: 'did:key:bob', id: 'm1' };
  const data = encryptDirect({ recipientKey: publicEncryptionKey(key), ...meta, payload: { type: 't', data: { n: 1 } } });
  assert.deepEqual(decryptDirect({ keys: [key], ...meta, data }), { type: 't', data: { n: 1 } });
  assert.throws(() => decryptDirect({ keys: [key], ...meta, source: 'did:key:mallory', data }));
  assert.throws(() => decryptDirect({ keys: [key], ...meta, recipient: 'did:key:carol', data }));
  assert.throws(() => decryptDirect({ keys: [key], ...meta, id: 'm2', data }));
  assert.throws(() => decryptDirect({ keys: [generateEncryptionKey()], ...meta, data }), /no longer holds/);
  assert.throws(() => decryptDirect({ keys: [key], ...meta, data: { ...data, extra: 1 } }), /unexpected fields/);

  assert.equal(checkPublicEncryptionKey(publicEncryptionKey(key)), null);
  assert.match(checkPublicEncryptionKey({ ...publicEncryptionKey(key), kid: 'AAAAAAAAAAA' }), /kid does not match/);
  assert.match(checkPublicEncryptionKey({ alg: 'RSA', kid: key.kid, public: key.public }), /alg/);
});

test('identity files keep their keys private and old ones are upgraded with an encryption key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-id-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = join(dir, 'nested', 'identity.json');
  const created = loadOrCreateIdentity(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const reloaded = loadOrCreateIdentity(file);
  assert.equal(reloaded.did, created.did);
  assert.equal(reloaded.encryption.current.kid, created.encryption.current.kid);

  // An identity file from v0.1 has no encryption section.
  const legacy = join(dir, 'legacy.json');
  const { encryption, ...old } = exportIdentity(generateIdentity());
  writeFileSync(legacy, JSON.stringify(old), { mode: 0o600 });
  const upgraded = loadOrCreateIdentity(legacy);
  assert.equal(upgraded.did, old.did);
  assert.ok(upgraded.encryption.current.kid);
  assert.equal(loadOrCreateIdentity(legacy).encryption.current.kid, upgraded.encryption.current.kid, 'the new key was saved');
  assert.ok(JSON.parse(readFileSync(legacy, 'utf8')).encryption);

  saveIdentity(file, upgraded);
  assert.equal(loadOrCreateIdentity(file).did, upgraded.did);
});

test('a damaged identity file is named in the error, and none of its content is echoed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-id-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'identity.json');
  const exported = exportIdentity(generateIdentity());

  // Break the JSON right at the private key: a parser's own error message would quote the text around that spot.
  const secret = exported.private_key_jwk.d;
  writeFileSync(file, JSON.stringify(exported).replace(`"d":"${secret}"`, `"d":${secret}"`), { mode: 0o600 });
  assert.throws(() => loadOrCreateIdentity(file), (err) => {
    assert.equal(err.message, `cannot load the identity in ${file}: the file is not valid JSON`);
    return true;
  });
  // An interrupted write leaves the file cut short.
  writeFileSync(file, JSON.stringify(exported).slice(0, 120), { mode: 0o600 });
  assert.throws(() => loadOrCreateIdentity(file), { message: `cannot load the identity in ${file}: the file is not valid JSON` });

  // Well-formed JSON that is not this key's identity says what is wrong with it.
  writeFileSync(file, JSON.stringify({ ...exported, did: generateIdentity().did }), { mode: 0o600 });
  assert.throws(() => loadOrCreateIdentity(file), { message: `cannot load the identity in ${file}: identity file is inconsistent: did does not match the key` });
  assert.equal(readFileSync(file, 'utf8').includes(secret), true, 'a file that fails to load is left as it was');
});

test('direct messages are encrypted end to end: the hub relays what it cannot read', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  const secret = 'la-clave-del-repositorio-privado';

  const receipt = await builder.send(reviewer.did, { type: 'dev.rust.secret-question', data: { text: secret } });
  assert.equal(receipt.duplicate, false);

  // Everything the hub holds about that message: no content, not even the real type.
  const [stored] = hub.store.pending(reviewer.did);
  assert.equal(stored.envelope.event.type, 'agenthub.encrypted');
  assert.equal(stored.envelope.event.encryption, 'hpke-v1');
  assert.deepEqual(Object.keys(stored.envelope.event.data).sort(), ['alg', 'ct', 'enc', 'kid']);
  const everythingTheHubHas = JSON.stringify([...hub.store.inboxes]);
  assert.ok(!everythingTheHubHas.includes(secret));
  assert.ok(!everythingTheHubHas.includes('secret-question'));
  // ...while it still knows who wrote to whom, which is what lets it apply limits.
  assert.equal(stored.envelope.event.source, builder.did);
  assert.equal(stored.envelope.event.recipient, reviewer.did);

  const { messages, errors } = await reviewer.poll();
  assert.equal(errors.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].encrypted, true);
  assert.equal(messages[0].sender, builder.did);
  assert.equal(messages[0].type, 'dev.rust.secret-question');
  assert.deepEqual(messages[0].data, { text: secret });
  assert.match(messages[0].toModelContext(), /trust="untrusted"/);

  // The published key is part of the card the agent signs.
  const card = (await builder.getAgent(reviewer.did)).card;
  assert.equal(card.encryption_key.alg, 'X25519');
  assert.deepEqual((await builder.info()).direct_encryption.supported, ['mls-v1', 'hpke-v1']);
});

test('sending in the clear is an explicit choice, and a hub can refuse it', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');

  await builder.send(reviewer.did, { type: 'note', data: { text: 'visible' }, encrypt: false });
  const { messages } = await reviewer.poll();
  assert.equal(messages[0].encrypted, false);
  assert.deepEqual(messages[0].data, { text: 'visible' });

  // A recipient without a published key cannot be written to by accident in the clear.
  const legacyIdentity = generateIdentity();
  const legacy = await hub.agent(null, legacyIdentity);
  const { challenge, difficulty } = await (await fetch(`${hub.url}/v1/challenges`, { method: 'POST' })).json();
  const { solvePow } = await import('../src/core/pow.mjs');
  const { signCard } = await import('../src/core/sign.mjs');
  const body = Buffer.from(
    JSON.stringify({
      challenge,
      pow_nonce: solvePow(challenge, legacy.did, difficulty),
      card_envelope: signCard({ did: legacy.did, name: 'legacy-agent' }, legacyIdentity),
    }),
  );
  const registered = await fetch(`${hub.url}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest(legacyIdentity, 'POST', `${hub.url}/v1/agents`, body) },
    body,
  });
  assert.equal(registered.status, 201);
  await rejects(builder.send(legacy.did, { type: 'x', data: {} }), 422, 'recipient_cannot_decrypt');
  await builder.send(legacy.did, { type: 'x', data: {}, encrypt: false });

  await rejects(builder.send(generateIdentity().did, { type: 'x', data: {} }), 404, 'recipient_not_found');

  const strict = await startHub(t, { requireDirectEncryption: true });
  const a = await strict.agent('a');
  const b = await strict.agent('b');
  await rejects(a.send(b.did, { type: 'x', data: {}, encrypt: false }), 403, 'encryption_required');
  await a.send(b.did, { type: 'x', data: { ok: true } });
  assert.deepEqual((await b.poll()).messages[0].data, { ok: true });
});

test('the hub checks the shape of sealed messages and keeps public topics unencrypted', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const identity = generateIdentity();
  const builder = await hub.agent('builder', identity);
  await reviewer.createTopic({ name: 'test.open.topic', description: 'A topic used by the tests', schema: { type: 'object' } });

  const post = async (path, event) => {
    const body = Buffer.from(JSON.stringify(signEvent({ specversion: '1.0', source: identity.did, time: new Date().toISOString(), ...event }, identity)));
    const res = await fetch(hub.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(identity, 'POST', hub.url + path, body) }, body });
    return { status: res.status, code: (await res.json()).error?.code };
  };
  const sealed = encryptDirect({
    recipientKey: (await builder.getAgent(reviewer.did)).card.encryption_key,
    source: identity.did,
    recipient: reviewer.did,
    id: 'ok',
    payload: { type: 't', data: {} },
  });
  const direct = { recipient: reviewer.did, encryption: 'hpke-v1', type: 'agenthub.encrypted' };

  assert.deepEqual(await post('/v1/messages', { ...direct, id: 'ok', data: sealed }), { status: 202, code: undefined });
  assert.deepEqual(await post('/v1/messages', { ...direct, id: 'a', data: { text: 'not sealed' } }), { status: 400, code: 'invalid_event' });
  assert.deepEqual(await post('/v1/messages', { ...direct, id: 'b', data: sealed, type: 'leaky.real.type' }), { status: 400, code: 'invalid_event' });
  assert.deepEqual(await post('/v1/messages', { ...direct, id: 'c', data: sealed, encryption: 'rot13' }), { status: 400, code: 'invalid_event' });
  assert.deepEqual(
    await post('/v1/topics/test.open.topic/events', { id: 'd', type: 't', subject: 'test.open.topic', encryption: 'hpke-v1', data: {} }),
    { status: 400, code: 'invalid_event' },
  );
});

test('a ciphertext lifted into someone else\'s envelope does not open', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  const malloryIdentity = generateIdentity();
  await hub.agent('mallory', malloryIdentity);

  await builder.send(reviewer.did, { type: 'offer', data: { price: 100 }, id: 'offer-1' });
  const original = hub.store.pending(reviewer.did)[0].envelope.event;

  // Mallory (or the hub) copies the ciphertext and signs it as her own message.
  const stolen = signEvent({ ...original, source: malloryIdentity.did }, malloryIdentity);
  const body = Buffer.from(JSON.stringify(stolen));
  const res = await fetch(`${hub.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest(malloryIdentity, 'POST', `${hub.url}/v1/messages`, body) },
    body,
  });
  assert.equal(res.status, 202, 'the hub cannot tell: the envelope is well formed');

  const { messages, errors } = await reviewer.poll();
  assert.deepEqual(messages.map((message) => [message.sender, message.data]), [[builder.did, { price: 100 }]]);
  assert.equal(errors.length, 1);
  assert.match(errorText(errors[0]), /^cannot decrypt/);
});

test('rotating the encryption key keeps messages in flight readable, then retires old keys', async (t) => {
  const hub = await startHub(t);
  const reviewerIdentity = generateIdentity();
  const reviewer = await hub.agent('rust-reviewer', reviewerIdentity);
  const builder = await hub.agent('builder');
  const firstKid = reviewerIdentity.encryption.current.kid;

  await builder.send(reviewer.did, { type: 'x', data: { n: 1 } }); // builder now caches the first key
  let persisted = 0;
  const secondKid = await reviewer.rotateEncryptionKey({ persist: () => persisted++ });
  assert.equal(persisted, 1);
  assert.notEqual(secondKid, firstKid);
  const card = (await builder.getAgent(reviewer.did)).card;
  assert.equal(card.encryption_key.kid, secondKid);
  assert.equal(card.name, 'rust-reviewer', 'the rest of the card is untouched');

  await builder.send(reviewer.did, { type: 'x', data: { n: 2 } }); // still sealed to the first key, from the cache
  assert.equal(hub.store.pending(reviewer.did)[1].envelope.event.data.kid, firstKid);
  const fresh = await hub.agent('fresh-sender');
  await fresh.send(reviewer.did, { type: 'x', data: { n: 3 } });
  assert.equal(hub.store.pending(reviewer.did)[2].envelope.event.data.kid, secondKid);
  assert.deepEqual((await reviewer.poll()).messages.map((message) => message.data.n), [1, 2, 3]);

  // After enough rotations the first key is gone, and so is the ability to read what was sealed to it.
  await reviewer.rotateEncryptionKey();
  await reviewer.rotateEncryptionKey();
  await builder.send(reviewer.did, { type: 'x', data: { n: 4 } });
  const { messages, errors } = await reviewer.poll();
  assert.equal(messages.length, 0);
  assert.match(errorText(errors[0]), /no longer holds/);
});
