// SPDX-License-Identifier: Apache-2.0
// What the log of a hub says of one agent, or one topic, for whoever has not read the log: the hub
// puts on record what its directory comes to (an entry "log.state", with the root of the map in
// core/statemap.mjs), and shows one name of it with the hashes that tie it to a checkpoint. Every
// reader of the log checks that entry; whoever asks about one name checks the rest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardHash, contractHash, Directory, LogError, replayLog, signCheckpoint, stateName, verifyStateAnswer } from '../src/core/log.mjs';
import { createHub } from '../src/hub/server.mjs';
import { createWitness } from '../src/witness/server.mjs';
import { AgentClient, generateIdentity, memoryStateStore } from '../src/sdk/index.mjs';
import { instanceOf, startHub } from './helpers.mjs';

const NEWS = { name: 'dev.rust.news', description: 'Noticias de Rust', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } };
const HOUR = 3_600_000;
const ACTIVE = { status: 'active', delegation: null, revoked: null, guardian: null, successor: null, predecessor: null };
/** A client that reads none of the log: it keeps no state and follows nothing. */
const light = (hub, name, more = {}) => hub.agent(name, generateIdentity(), { followLog: false, ...more });
/** What the hub answers to somebody that asks by hand. */
const ask = async (hub, query) => {
  const res = await fetch(`${hub.url}/v1/log/state?${query}`);
  const json = await res.json();
  return res.ok ? json : `${res.status} ${json.error.code}`;
};
const states = (hub) => hub.store.log.filter((entry) => entry.type === 'log.state').length;
const refused = async (promise, pattern) => {
  const err = await promise.then(() => null, (thrown) => thrown);
  assert.ok(err instanceof LogError && err.code === 'log_invalid', `not refused: ${err}`);
  if (pattern) assert.match(err.message, pattern);
};

test('a client is shown what the log says of one agent, and checks it without reading the log', async (t) => {
  const hub = await startHub(t);
  const asked = [];
  const alice = await light(hub, 'alice', { fetch: (url, init) => (asked.push(new URL(url).pathname), fetch(url, init)) });
  const bobKey = generateIdentity();
  const bob = await hub.agent('bob', bobKey, { followLog: false });
  assert.equal(states(hub), 0, 'a hub that nobody asks this of writes nothing for it');

  asked.length = 0;
  const said = await alice.logState(stateName.agent(bob.did));
  assert.deepEqual(said.record, { card: cardHash((await alice.getAgent(bob.did)).card), ...ACTIVE });
  assert.deepEqual([said.size, said.witnessed, hub.store.log.at(-1).type, said.at], [hub.store.log.length, false, 'log.state', hub.store.log.at(-1).at]);
  // One question to the hub about the log, and none for its entries.
  assert.deepEqual(asked.filter((path) => path.startsWith('/v1/log')), ['/v1/log/state']);

  // What the log has nothing for, it is shown to have nothing for.
  assert.equal((await alice.logState(stateName.agent(generateIdentity().did))).record, null);
  assert.equal((await alice.logState(stateName.topic(NEWS.name))).record, null);
  assert.equal((await alice.logState('whatever:else')).record, null);

  // A topic, an instance: each under its name, with all the log has for it.
  await bob.createTopic(NEWS);
  assert.deepEqual((await alice.logState(stateName.topic(NEWS.name))).record, { owner: bob.did, contract: contractHash(NEWS), publish: 'any', subscribe: 'any', encryption: null, revision: 0 });
  const laptop = instanceOf(bobKey);
  assert.equal((await alice.logState(stateName.instance(laptop.instance.did))).record, null);
  await hub.client(laptop, { followLog: false }).registerInstance();
  const expires = hub.store.instances.get(laptop.instance.did).certificate.expires_at;
  assert.deepEqual((await alice.logState(stateName.instance(laptop.instance.did))).record, { agent: bob.did, expires_at: expires, removed: false });

  // What changes is what is shown from then on: the entry of the change, and one more for the state.
  const before = hub.store.log.length;
  await bob.retire();
  const after = await alice.logState(stateName.agent(bob.did));
  assert.deepEqual([after.record.status, after.record.revoked.by, after.size], ['revoked', bob.did, before + 2]);
  // Asked again with nothing changed, the log is as long as it was: it does not grow for being asked.
  for (let i = 0; i < 5; i++) await alice.logState(stateName.agent(bob.did));
  await Promise.all([alice.logState(stateName.agent(alice.did)), alice.logState(stateName.topic(NEWS.name)), ask(hub, 'name=agent:x')]);
  assert.equal(hub.store.log.length, before + 2);

  // A name is a name, and a size is one the hub still keeps the state of.
  assert.deepEqual([await ask(hub, ''), await ask(hub, `name=${'x'.repeat(401)}`), await ask(hub, 'name=agent:x&size=nine')], ['400 invalid_parameter', '400 invalid_parameter', '400 invalid_parameter']);
  assert.deepEqual([await ask(hub, 'name=agent:x&size=1'), await ask(hub, `name=agent:x&size=${hub.store.log.length + 5}`)], ['404 state_not_kept', '404 state_not_kept']);
  assert.equal((await ask(hub, `name=agent:x&size=${hub.store.log.length}`)).size, hub.store.log.length);
  await assert.rejects(alice.logState(''), TypeError);
  await assert.rejects(alice.logState(7), TypeError);
});

test('a hub keeps the state of its log where it last said it, not everywhere it ever did', async (t) => {
  const hub = await startHub(t, { limits: { card: { burst: 1000, perMinute: 1000 } } });
  const alice = await light(hub, 'alice');
  const sizes = [];
  for (let round = 0; round < 40; round++) {
    await alice.updateCard({ name: 'alice', description: `round ${round}` });
    sizes.push((await alice.logState(stateName.agent(alice.did))).size);
  }
  assert.equal(states(hub), 40);
  const kept = await Promise.all(sizes.map(async (size) => typeof (await ask(hub, `name=agent:x&size=${size}`)) !== 'string'));
  // The last ones, the one of now among them; the first are gone, and asking for them says so.
  assert.deepEqual([kept.slice(0, 8), kept.slice(8)], [Array(8).fill(false), Array(32).fill(true)]);
  assert.equal(await ask(hub, `name=agent:x&size=${sizes[0]}`), '404 state_not_kept');
  // Each still tells what the directory was then.
  const then = await ask(hub, `name=${encodeURIComponent(stateName.agent(alice.did))}&size=${sizes[10]}`);
  const now = await ask(hub, `name=${encodeURIComponent(stateName.agent(alice.did))}&size=${sizes[39]}`);
  assert.notEqual(then.record.card, now.record.card);
  assert.deepEqual(verifyStateAnswer(then, { name: stateName.agent(alice.did), size: sizes[10], root: hub.store.logTree.root(sizes[10]) }).record, then.record);
});

test('every reader of the log checks the state the hub put on record', async (t) => {
  const hub = await startHub(t);
  const alice = await light(hub, 'alice');
  const owner = generateIdentity();
  const bob = await hub.agent('bob', owner, { followLog: false });
  await bob.createTopic(NEWS);
  await hub.client(instanceOf(owner)).registerInstance();
  await alice.logState(stateName.agent(bob.did));
  await bob.setTopicPolicy(NEWS.name, { publish: 'owner' });
  await alice.logState(stateName.topic(NEWS.name));
  assert.equal(states(hub), 2);

  // Read from its first entry, the log holds, and the state it gives each time is that of the directory then.
  const log = structuredClone(hub.store.log);
  const { directory } = await replayLog(log, { hub: hub.did });
  assert.equal(log.at(-1).state, directory.stateRoot);
  const first = log.findIndex((entry) => entry.type === 'log.state');
  assert.equal(log[first].state, (await replayLog(log.slice(0, first), { hub: hub.did })).directory.stateRoot);
  assert.notEqual(log[first].state, log.at(-1).state);

  // A state that is not that of the directory at that point is no entry of a log: another, an earlier one, one made up.
  const made = (state, n = log.length) => ({ n, at: new Date().toISOString(), type: 'log.state', state });
  for (const state of [log[first].state, '0'.repeat(64), 'f'.repeat(64), directory.stateRoot.toUpperCase(), null, 7]) {
    await refused(replayLog([...log, made(state)], { hub: hub.did }), /not that of the directory at this point/);
  }
  await refused(replayLog([...log.slice(0, -1), made(log[first].state, log.length - 1)], { hub: hub.did }), /not that of the directory at this point/);
  await refused(replayLog([...log, { ...made(directory.stateRoot), more: 1 }], { hub: hub.did }), /missing or unexpected fields/);
  await refused(replayLog([...log, { n: log.length, at: null, type: 'log.state' }], { hub: hub.did }), /missing or unexpected fields/);
  // The right one, as often as the hub cares to say it, is.
  await replayLog([...log, made(directory.stateRoot), made(directory.stateRoot, log.length + 1)], { hub: hub.did });

  // A client that does read the log takes those entries like any other, and one that kept what it had read goes on from there.
  const state = memoryStateStore();
  const readerKey = generateIdentity();
  const reader = await hub.agent('reader', readerKey, { state });
  assert.equal((await reader.getTopic(NEWS.name)).publish, 'owner');
  await bob.setTopicPolicy(NEWS.name, { publish: 'any' });
  await alice.logState(stateName.topic(NEWS.name));
  const again = hub.client(readerKey, { state });
  assert.equal((await again.getTopic(NEWS.name)).publish, 'any');
  assert.equal((await again.directory()).stateRoot, hub.store.log.at(-1).state);
  // What it kept is put away without the map, and taken up again with it.
  const kept = (await again.directory()).toJSON();
  assert.equal(Directory.fromJSON(structuredClone(kept), { hub: hub.did }).stateRoot, hub.store.log.at(-1).state);
  assert.ok(!JSON.stringify(kept).includes(hub.store.log.at(-1).state));
});

test('a hub that answers something its log does not say is not believed', async (t) => {
  const hubKey = generateIdentity();
  const hub = await startHub(t, { identity: hubKey });
  const mallory = generateIdentity();
  const bob = await light(hub, 'bob');
  const carol = await light(hub, 'carol');
  await carol.createTopic(NEWS);
  let lie = (answer) => answer;
  const alice = await light(hub, 'alice', {
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      if (new URL(url).pathname !== '/v1/log/state' || !res.ok) return res;
      return new Response(JSON.stringify(await lie(await res.json(), new URL(url))), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const name = stateName.agent(bob.did);
  const honest = await alice.logState(name);
  const other = await ask(hub, `name=${encodeURIComponent(stateName.agent(carol.did))}`);
  const nobody = await ask(hub, `name=${encodeURIComponent(stateName.agent(mallory.did))}`);
  const lies = {
    'another record': (answer) => ({ ...answer, record: { ...answer.record, status: 'revoked', revoked: { by: bob.did, at: null } } }),
    'a guardian nobody named': (answer) => ({ ...answer, record: { ...answer.record, guardian: mallory.did } }),
    'nothing, where there is something': (answer) => ({ ...answer, record: null }),
    'nothing, with the proof of a name that has nothing': (answer) => ({ ...answer, record: null, proof: nobody.proof }),
    'the record of another agent': (answer) => ({ ...answer, record: other.record }),
    'the record and the proof of another agent': (answer) => ({ ...answer, record: other.record, proof: other.proof }),
    'a record that is no record': (answer) => ({ ...answer, record: 'active' }),
    'a state of its own making': (answer) => ({ ...answer, entry: { ...answer.entry, state: '0'.repeat(64) } }),
    'an entry that is not where the log says its state': (answer) => ({ ...answer, entry: hub.store.log[answer.size - 2] }),
    'an entry from elsewhere in the log': (answer) => ({ ...answer, entry: { ...answer.entry, n: answer.entry.n - 1 } }),
    'an entry with more in it': (answer) => ({ ...answer, entry: { ...answer.entry, more: 1 } }),
    'no proof that the entry is in the log': (answer) => ({ ...answer, inclusion: [] }),
    'a proof for another entry': (answer) => ({ ...answer, inclusion: hub.store.logTree.inclusionProof(0, answer.size).map((hash) => hash.toString('hex')) }),
    'a checkpoint it signed for a list that is not this one': (answer) => ({ ...answer, checkpoint: signCheckpoint(hubKey, { size: answer.size, root: Buffer.alloc(32, 7) }) }),
    'a checkpoint it signed for the log at another size': (answer) => ({ ...answer, checkpoint: signCheckpoint(hubKey, { size: answer.size - 1, root: hub.store.logTree.root(answer.size - 1) }) }),
    'a checkpoint somebody else signed': (answer) => ({ ...answer, checkpoint: signCheckpoint(mallory, { size: answer.size, root: Buffer.from(answer.checkpoint.checkpoint.root, 'hex') }) }),
    'no checkpoint': ({ checkpoint, ...answer }) => answer,
    'nothing at all': () => ({}),
  };
  for (const [what, told] of Object.entries(lies)) {
    lie = told;
    const err = await alice.logState(name).then(() => null, (thrown) => thrown);
    assert.ok(err instanceof LogError, `${what}: ${err}`);
  }
  lie = (answer) => answer;
  assert.deepEqual(await alice.logState(name), honest);
  // The same record with its fields in another order is the same record.
  lie = (answer) => ({ ...answer, record: Object.fromEntries(Object.entries(answer.record).reverse()) });
  assert.deepEqual((await alice.logState(name)).record, honest.record);
  lie = (answer) => answer;

  // The answer about one name is no answer about another, however good.
  const { checkpoint } = other;
  const trusted = { size: checkpoint.checkpoint.size, root: Buffer.from(checkpoint.checkpoint.root, 'hex') };
  assert.deepEqual(verifyStateAnswer(other, { name: stateName.agent(carol.did), ...trusted }).record, other.record);
  assert.throws(() => verifyStateAnswer(other, { name, ...trusted }), LogError);
  // Nor one about the log at another size, or under another root.
  assert.throws(() => verifyStateAnswer(other, { name: stateName.agent(carol.did), ...trusted, size: trusted.size - 1 }), LogError);
  assert.throws(() => verifyStateAnswer(other, { name: stateName.agent(carol.did), ...trusted, root: Buffer.alloc(32) }), LogError);
  for (const bad of [null, 'answer', [], { ...other, proof: null }, { ...other, entry: null }, { ...other, inclusion: 'none' }, { ...other, inclusion: ['xyz'] }]) {
    assert.throws(() => verifyStateAnswer(bad, { name: stateName.agent(carol.did), ...trusted }), LogError);
  }
  assert.throws(() => verifyStateAnswer(other, { name: stateName.agent(carol.did), size: 0, root: trusted.root }), LogError);
});

test('with witnesses, what the log says of an agent is held to the log they cosigned', async (t) => {
  const key = generateIdentity();
  const witness = await createWitness({ port: 0, quiet: true, logs: [key.did] }).listen();
  t.after(() => witness.close());
  const hub = await startHub(t, { identity: key, witnesses: [`${witness.verifier}@${witness.url}`], witnessIntervalMs: HOUR });
  const trusting = { witnesses: [witness.verifier] };
  assert.equal(await hub.witnessNow(), 1);
  const asked = [];
  const alice = await hub.agent('alice', generateIdentity(), { ...trusting, fetch: (url, init) => (asked.push(new URL(url).pathname + new URL(url).search), fetch(url, init)) });
  const bob = await hub.agent('bob', generateIdentity(), trusting);

  // What they cosign ends where the log says its state, so one name of it can be shown under their word.
  assert.equal(await hub.witnessNow(), 1);
  const cosigned = hub.store.log.length;
  assert.equal(hub.store.log.at(-1).type, 'log.state');
  asked.length = 0;
  const said = await alice.logState(stateName.agent(bob.did));
  assert.deepEqual([said.record.status, said.size, said.witnessed], ['active', cosigned, true]);
  assert.deepEqual(asked, ['/v1/log/note', `/v1/log/state?name=${encodeURIComponent(stateName.agent(bob.did))}&size=${cosigned}`]);

  // The log goes on. What is shown is still the log that was cosigned: the change is there at the next round, not before.
  await bob.retire();
  assert.deepEqual([(await alice.logState(stateName.agent(bob.did))).record.status, (await alice.logState(stateName.agent(bob.did))).size], ['active', cosigned]);
  assert.equal(await hub.witnessNow(), 1);
  const later = await alice.logState(stateName.agent(bob.did));
  assert.deepEqual([later.record.status, later.size, later.witnessed], ['revoked', hub.store.log.length, true]);
  // A round with nothing new writes nothing.
  const length = hub.store.log.length;
  assert.equal(await hub.witnessNow(), 1);
  assert.equal(hub.store.log.length, length);

  // A hub that answers for another size than the one cosigned, or signs a checkpoint of its own for it, gets nowhere.
  const lied = hub.client(generateIdentity(), {
    ...trusting,
    fetch: async (url, init) => {
      const at = new URL(url);
      if (at.pathname !== '/v1/log/state') return fetch(url, init);
      at.searchParams.delete('size'); // asked about the log that was cosigned, it answers about the log as it is now
      return fetch(at, init);
    },
  });
  await alice.updateCard({ name: 'alice', description: 'after the witnesses looked' });
  await refused(lied.logState(stateName.agent(alice.did)), /does not carry the entry where the log says its state at that size/);
  assert.notEqual((await alice.logState(stateName.agent(alice.did))).size, hub.store.log.length);

  // A client that trusts a witness this hub does not have is shown nothing it can believe.
  const elsewhere = await createWitness({ port: 0, quiet: true, logs: [key.did], name: 'witness.example/elsewhere' }).listen();
  t.after(() => elsewhere.close());
  const wary = hub.client(generateIdentity(), { witnesses: [elsewhere.verifier] });
  const err = await wary.logState(stateName.agent(bob.did)).then(() => null, (thrown) => thrown);
  assert.ok(err instanceof LogError && err.code === 'log_unwitnessed', String(err));
});

test('the state the hub put on record is there after it is stopped and started', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-logstate-'));
  const options = { dataDir: dir };
  const first = await createHub({ port: 0, quiet: true, powDifficulty: 8, ...options }).listen();
  let running = first;
  t.after(async () => {
    await running?.close();
  });
  const identity = generateIdentity();
  const alice = new AgentClient({ hubUrl: first.url, identity, followLog: false });
  await alice.register({ name: 'alice' });
  const before = await alice.logState(stateName.agent(alice.did));
  await alice.updateCard({ name: 'alice', description: 'changed' });
  const changed = await alice.logState(stateName.agent(alice.did));
  assert.notEqual(before.record.card, changed.record.card);
  const log = structuredClone(first.store.log);
  await alice.close();
  await first.close();
  running = null;

  const hub = await startHub(t, options);
  t.after(() => rmSync(dir, { recursive: true, force: true })); // after the hub that writes there has closed
  assert.deepEqual(hub.store.log, log);
  const again = hub.client(identity, { followLog: false, hubDid: hub.did });
  // Asked with nothing changed, it answers from the entry it had written, and writes no other.
  const now = await again.logState(stateName.agent(alice.did));
  assert.deepEqual([now.record, now.size, hub.store.log.length], [changed.record, changed.size, log.length]);
  // And still keeps the state of the log where it said it before.
  const earlier = await ask(hub, `name=${encodeURIComponent(stateName.agent(alice.did))}&size=${before.size}`);
  assert.deepEqual(earlier.record, before.record);
  assert.deepEqual(verifyStateAnswer(earlier, { name: stateName.agent(alice.did), size: before.size, root: hub.store.logTree.root(before.size) }).record, before.record);
  // A client that was told its hub is another takes nothing this one signs.
  const told = hub.client(identity, { followLog: false, hubDid: generateIdentity().did });
  await refused(told.logState(stateName.agent(alice.did)), /not one the hub signed/);
});
