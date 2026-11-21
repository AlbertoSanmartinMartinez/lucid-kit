// SPDX-License-Identifier: Apache-2.0
// Open pairing: a hub whose operator opened it lets any hub pair itself with it, as a hosted service does.
// The hub that asks has to answer, at the address it gives, as the hub of the key that signed the request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.mjs';
import { generateIdentity } from '../src/sdk/index.mjs';
import { signRequest } from '../src/core/reqsig.mjs';
import { GENEROUS, startHub } from './helpers.mjs';

const hubKey = () => {
  const key = generateIdentity();
  return { did: key.did, privateKey: key.privateKey };
};
const OPEN = { maxPeers: 3, privateAddresses: true }; // the tests run on this machine
const TOPIC = { name: 'dev.rust.reviews', description: 'Rust code reviews', schema: { type: 'object' } };

/** What `key` asks `hub` to pair it with, as `{ name, url }`. */
async function askToPair(hub, key, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const res = await fetch(`${hub.url}/v1/federation/pairings`, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(key, 'POST', `${hub.url}/v1/federation/pairings`, payload) }, body: payload });
  return { status: res.status, code: (await res.json()).error?.code ?? null };
}

test('a hub pairs itself with one that opened pairing, and then the two work as if their operators had paired them', async (t) => {
  const service = await startHub(t, { identity: hubKey(), openPairing: OPEN });
  const ownKey = hubKey();
  const own = await startHub(t, { identity: ownKey, name: 'acme' });
  assert.equal((await (await fetch(`${service.url}/v1/info`)).json()).federation.open_pairing, true);

  // The operator of the hub of its own names the service, as always; nobody touches the service.
  own.addPeer({ name: 'cloud', url: service.url, did: service.did });
  assert.equal((await own.checkPairing('cloud')).state, 'paired');
  assert.deepEqual(service.store.pairings.get('acme'), { name: 'acme', url: own.url, did: own.did, at: service.store.pairings.get('acme').at });
  assert.equal((await service.checkPairing('acme')).state, 'paired');

  // Its agents use the topics of the service, as with any pairing.
  const owner = await service.agent('owner');
  await owner.createTopic(TOPIC);
  const visitor = await own.agent('visitor');
  const { topics: found } = await visitor.searchTopicsEverywhere('rust code reviews');
  assert.ok(found.some((topic) => topic.name === `${TOPIC.name}@cloud`));

  // Asking again changes nothing: the hub keeps the name it had.
  assert.deepEqual(await askToPair(service, ownKey, { name: 'acme2', url: own.url }), { status: 200, code: null });
  assert.deepEqual([...service.store.pairings.keys()], ['acme']);
});

test('a hub that has not opened pairing pairs only with the hubs its operator names', async (t) => {
  const closed = await startHub(t, { identity: hubKey() });
  const other = await startHub(t, { identity: hubKey(), name: 'other' });
  other.addPeer({ name: 'closed', url: closed.url, did: closed.did });
  assert.equal((await other.checkPairing('closed')).state, 'refused');
  assert.equal(closed.store.pairings.size, 0);
  assert.deepEqual(await askToPair(closed, hubKey(), { name: 'x', url: other.url }), { status: 403, code: 'pairing_closed' });
});

test('nobody pairs itself in the name of another hub, or of an address it does not answer at', async (t) => {
  const service = await startHub(t, { identity: hubKey(), openPairing: OPEN, limits: { pairing: { burst: 100, perMinute: 100 } } });
  const honestKey = hubKey();
  const honest = await startHub(t, { identity: honestKey, name: 'honest' });
  honest.addPeer({ name: 'cloud', url: service.url, did: service.did });
  const mallory = hubKey();

  // The address of a hub that has not paired with the service: it answers that it is not paired.
  const stranger = await startHub(t, { identity: hubKey() });
  assert.deepEqual(await askToPair(service, mallory, { name: 'stranger', url: stranger.url }), { status: 409, code: 'pairing_unconfirmed' });
  // The address of a hub that has paired with the service: it answers, but with its own key, not mallory's.
  assert.deepEqual(await askToPair(service, mallory, { name: 'honest', url: honest.url }), { status: 409, code: 'pairing_unconfirmed' });
  assert.equal(service.store.pairings.size, 0);

  // The honest one pairs itself; nobody else can take its name or its key afterwards.
  assert.equal((await honest.checkPairing('cloud')).state, 'paired');
  const impostor = await startHub(t, { identity: mallory });
  impostor.addPeer({ name: 'cloud', url: service.url, did: service.did });
  assert.deepEqual(await askToPair(service, mallory, { name: 'honest', url: impostor.url }), { status: 409, code: 'pairing_conflict' });
  assert.deepEqual(await askToPair(service, mallory, { name: 'bad name!', url: impostor.url }), { status: 409, code: 'pairing_conflict' });
  // The key of an agent of the service is not a hub.
  const agentKey = generateIdentity();
  await service.agent('agent', agentKey);
  assert.deepEqual(await askToPair(service, agentKey, { name: 'agent-hub', url: impostor.url }), { status: 409, code: 'hub_conflict' });
});

test('an open hub talks only to public HTTPS addresses, unless its operator allows others, and takes so many hubs', async (t) => {
  const strict = await startHub(t, { identity: hubKey(), openPairing: { maxPeers: 5 } });
  for (const url of ['http://127.0.0.1:1', 'https://127.0.0.1:1', 'https://localhost:1', 'https://10.0.0.1', 'https://[::1]:1']) {
    assert.deepEqual(await askToPair(strict, hubKey(), { name: 'local', url }), { status: 400, code: 'invalid_peer_address' }, url);
  }

  // An address written out is not asked about, IPv6 in its brackets included: it is public or it is not.
  // A name is, and one that never comes back is not waited for longer than a hub is.
  const asked = [];
  const reached = [];
  const names = { 'slow.example': new Promise(() => {}), 'inside.example': [{ address: '10.1.2.3', family: 4 }], 'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] };
  const lookup = (name) => {
    asked.push(name);
    return Promise.resolve(names[name] ?? [{ address: '93.184.216.34', family: 4 }]);
  };
  const nobodyThere = async (url) => {
    reached.push(new URL(url).host);
    throw new Error('nobody answers');
  };
  const careful = await startHub(t, { identity: hubKey(), openPairing: { maxPeers: 5 }, lookup, fetch: nobodyThere, peerTimeoutMs: 200, limits: { pairing: GENEROUS } });
  for (const url of ['https://127.0.0.1:1', 'https://[::1]:1', 'https://[fd00::1]', 'https://[::ffff:10.0.0.1]']) {
    assert.deepEqual(await askToPair(careful, hubKey(), { name: 'local', url }), { status: 400, code: 'invalid_peer_address' }, url);
  }
  assert.deepEqual(asked, []);
  // A public one passes, and the hub goes on to ask whoever is there: nobody, here.
  for (const url of ['https://[2606:4700:4700::1111]:8443', 'https://93.184.216.34']) {
    assert.deepEqual(await askToPair(careful, hubKey(), { name: 'far', url }), { status: 409, code: 'pairing_unconfirmed' }, url);
  }
  assert.deepEqual([asked, reached], [[], ['[2606:4700:4700::1111]:8443', '93.184.216.34']]);
  assert.deepEqual(await askToPair(careful, hubKey(), { name: 'named', url: 'https://hub.example' }), { status: 409, code: 'pairing_unconfirmed' });
  for (const host of ['inside.example', 'mixed.example']) {
    assert.deepEqual(await askToPair(careful, hubKey(), { name: 'named', url: `https://${host}` }), { status: 400, code: 'invalid_peer_address' }, host);
  }
  const before = Date.now();
  assert.deepEqual(await askToPair(careful, hubKey(), { name: 'slow', url: 'https://slow.example' }), { status: 400, code: 'invalid_peer_address' });
  assert.ok(Date.now() - before < 5000, 'a name that does not resolve in time is given up on');
  assert.deepEqual(asked, ['hub.example', 'inside.example', 'mixed.example', 'slow.example']);
  assert.deepEqual(reached.slice(2), ['hub.example']);

  const small = await startHub(t, { identity: hubKey(), openPairing: { maxPeers: 1, privateAddresses: true } });
  for (const [index, name] of ['first', 'second'].entries()) {
    const hub = await startHub(t, { identity: hubKey(), name });
    hub.addPeer({ name: 'small', url: small.url, did: small.did });
    const { state, detail } = await hub.checkPairing('small');
    if (index === 0) assert.equal(state, 'paired');
    else assert.deepEqual([state, detail], ['refused', 'it lets hubs pair themselves with it, but not this one (quota_exceeded)']);
  }
  assert.throws(() => createHub({ port: 0, quiet: true, openPairing: { maxPeers: 0 } }), /openPairing/);
  assert.throws(() => createHub({ port: 0, quiet: true, openPairing: true }), /openPairing/);
});

test('the hubs that paired themselves are still paired after a restart, until the operator removes them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-pairing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = hubKey();
  const boot = () => createHub({ port: 0, quiet: true, powDifficulty: 8, dataDir: dir, identity: key, openPairing: OPEN }).listen();
  const own = await startHub(t, { identity: hubKey(), name: 'acme' });

  let service = await boot();
  try {
    own.addPeer({ name: 'cloud', url: service.url, did: service.did });
    assert.equal((await own.checkPairing('cloud')).state, 'paired');
  } finally {
    await service.close();
  }
  service = await boot();
  try {
    assert.equal((await service.checkPairing('acme')).state, 'paired', 'the service remembers it');
    assert.equal(service.removePeer('acme'), true);
    assert.equal(service.store.pairings.size, 0);
  } finally {
    await service.close();
  }
  service = await boot();
  try {
    await assert.rejects(service.checkPairing('acme'), /no peer called "acme"/);
  } finally {
    await service.close();
  }
});
