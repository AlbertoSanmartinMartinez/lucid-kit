// SPDX-License-Identifier: Apache-2.0
// Signed requests are good for one hub: the one whose address they were signed for. A hub that receives
// a request cannot replay it on another hub where the same agent is registered, and a client from before
// requests were signed for an address is turned away, not served with what could be replayed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, sign as edSign } from 'node:crypto';
import { createHub } from '../src/hub/server.mjs';
import { generateIdentity } from '../src/sdk/index.mjs';
import { HEADERS, REQUEST_SIGNATURE, signRequest } from '../src/core/reqsig.mjs';
import { startHub } from './helpers.mjs';

const hubKey = () => {
  const key = generateIdentity();
  return { did: key.did, privateKey: key.privateKey };
};
/** Where a test reaches a hub: on this machine, whatever address it says it is reached at. */
const local = (hub) => `http://127.0.0.1:${hub.port}`;
/** Sends `method path` to `hub`, signed by `identity` for the address `signedFor` (the hub's own unless said). */
async function send(hub, identity, method, path, { body, signedFor = hub.url, headers = {} } = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const res = await fetch(local(hub) + path, {
    method,
    headers: { 'content-type': 'application/json', ...signRequest(identity, method, signedFor + path, payload), ...headers },
    body: body === undefined ? undefined : payload,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, code: json?.error?.code ?? null, json };
}
/** What a client of version 0.7 sent: a signature over the request with no address in it, and no origin header. */
function unboundHeaders(identity, method, path, body = Buffer.alloc(0)) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const input = ['agenthub/request/v1', method, path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return {
    [HEADERS.DID]: identity.did,
    [HEADERS.TIMESTAMP]: timestamp,
    [HEADERS.NONCE]: nonce,
    [HEADERS.SIGNATURE]: edSign(null, Buffer.from(input), identity.privateKey).toString('base64url'),
  };
}

test('a request signed for one hub is refused by another where the same agent is registered', async (t) => {
  const a = await startHub(t);
  const b = await startHub(t);
  const identity = generateIdentity();
  await a.agent('alice', identity);
  await b.agent('alice', identity);
  const card = { name: 'alice', description: 'now somebody else' };

  // Hub A captures a request alice signed for it and presents it, untouched, to hub B.
  const forA = signRequest(identity, 'GET', `${a.url}/v1/inbox`);
  const replayed = await fetch(`${b.url}/v1/inbox`, { headers: forA });
  const answer = await replayed.json();
  assert.equal(`${replayed.status} ${answer.error.code}`, '401 wrong_hub');
  assert.ok(answer.error.origins.includes(b.url), 'the refusal says which addresses this hub takes');

  // Changing the address it claims to be for breaks the signature: that is not a way around it.
  const relabelled = await fetch(`${b.url}/v1/inbox`, { headers: { ...forA, [HEADERS.ORIGIN]: b.url } });
  assert.equal((await relabelled.json()).error.code, 'invalid_signature');

  // The same goes for something that changes the directory, and for a request with a body.
  const changed = await send(b, identity, 'PUT', '/v1/agents/me', { body: { card }, signedFor: a.url });
  assert.equal(`${changed.status} ${changed.code}`, '401 wrong_hub');

  // Signed for it, each hub takes it.
  assert.equal((await send(a, identity, 'GET', '/v1/inbox')).status, 200);
  assert.equal((await send(b, identity, 'GET', '/v1/inbox')).status, 200);
});

test('a client from before requests were signed for one hub is turned away with a code that says so', async (t) => {
  const hub = await startHub(t);
  const identity = generateIdentity();
  await hub.agent('alice', identity);
  const res = await fetch(`${hub.url}/v1/inbox`, { headers: unboundHeaders(identity, 'GET', '/v1/inbox') });
  const { error } = await res.json();
  assert.equal(`${res.status} ${error.code}`, '401 unbound_request');
  assert.match(error.message, new RegExp(REQUEST_SIGNATURE));
  // The old signature does not pass by adding the header either: what was signed has no address in it.
  const res2 = await fetch(`${hub.url}/v1/inbox`, { headers: { ...unboundHeaders(identity, 'GET', '/v1/inbox'), [HEADERS.ORIGIN]: hub.url } });
  assert.equal((await res2.json()).error.code, 'invalid_signature');
});

test('which addresses a hub takes: its public one, or the names of this machine for a hub that only listens here', async (t) => {
  const here = await startHub(t);
  const identity = generateIdentity();
  await here.agent('alice', identity);
  const port = new URL(here.url).port;
  const info = await (await fetch(`${here.url}/v1/info`)).json();
  assert.equal(info.requests.signature, REQUEST_SIGNATURE);
  assert.deepEqual(info.requests.origins.sort(), [`http://127.0.0.1:${port}`, `http://[::1]:${port}`, `http://localhost:${port}`].sort());
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal((await send(here, identity, 'GET', '/v1/inbox', { signedFor: `http://${name}:${port}` })).status, 200, name);
  }
  assert.equal((await send(here, identity, 'GET', '/v1/inbox', { signedFor: `http://127.0.0.1:${Number(port) + 1}` })).code, 'wrong_hub');
  assert.equal((await send(here, identity, 'GET', '/v1/inbox', { signedFor: `https://127.0.0.1:${port}` })).code, 'wrong_hub');

  // Behind a proxy, the hub takes the address it is reached at, and only that one.
  const proxied = await startHub(t, { publicUrl: 'https://hub.example.com' });
  const bob = generateIdentity();
  const registered = await send(proxied, bob, 'GET', '/v1/inbox', { signedFor: 'https://hub.example.com' });
  assert.equal(registered.code, 'not_registered', 'signed for its address, the request gets as far as asking who it is');
  assert.equal((await send(proxied, bob, 'GET', '/v1/inbox', { signedFor: local(proxied) })).code, 'wrong_hub', 'its local address is not the one it is reached at');
  assert.deepEqual((await (await fetch(`${local(proxied)}/v1/info`)).json()).requests.origins, ['https://hub.example.com']);

  // A hub that other machines can reach has to be told its address: without it, nobody could sign for it.
  assert.throws(() => createHub({ host: '0.0.0.0', port: 0, quiet: true }), /needs the address it is reached at/);
  assert.throws(() => createHub({ host: '0.0.0.0', port: 0, quiet: true, publicUrl: 'hub.example.com' }), /http\(s\) address/);
});

test('hubs sign what they ask each other for the address of the other, and a pairing with the wrong one says so', async (t) => {
  const keyA = hubKey();
  const a = await startHub(t, { identity: keyA });
  const b = await startHub(t, { identity: hubKey() });
  const c = await startHub(t, { identity: hubKey() });
  for (const other of [b, c]) {
    a.addPeer({ name: other === b ? 'b' : 'c', url: other.url, did: other.did });
    other.addPeer({ name: 'a', url: a.url, did: a.did });
  }
  assert.equal((await a.checkPairing('b')).state, 'paired');
  assert.equal((await a.checkPairing('c')).state, 'paired');

  // What hub A asked of hub B, presented by B to hub C, which is paired with A too: refused.
  const path = `/v1/federation/hello?challenge=${'x'.repeat(24)}`;
  const forB = signRequest(keyA, 'GET', b.url + path);
  assert.equal((await fetch(b.url + path, { headers: forB })).status, 200, 'B takes it');
  const replayed = await fetch(c.url + path, { headers: signRequest(keyA, 'GET', b.url + path) });
  assert.equal(`${replayed.status} ${(await replayed.json()).error.code}`, '401 wrong_hub');

  // A hub reached at another address than the one it was paired with: its peer is told what is wrong.
  const behind = await startHub(t, { identity: hubKey(), publicUrl: 'https://behind.example.com' });
  behind.addPeer({ name: 'a', url: a.url, did: a.did });
  a.addPeer({ name: 'behind', url: local(behind), did: behind.did });
  const pairing = await a.checkPairing('behind');
  assert.equal(pairing.state, 'mismatch');
  assert.match(pairing.detail, /another address/);
});
