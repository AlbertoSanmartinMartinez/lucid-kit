// SPDX-License-Identifier: Apache-2.0
// Quotas: how much an account may do, by tier. An account is the controller behind the delegations of
// its agents, so every agent it delegates shares it; an agent without a delegation is an account of its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegation, generateIdentity, moderation } from '../src/sdk/index.mjs';
import { DailyCounter, checkQuotas } from '../src/hub/quota.mjs';
import { rejects, instanceOf, startHub } from './helpers.mjs';

const DAY = 86_400_000;

test('a day starts again at midnight UTC, and an account that has used its quota is told when', () => {
  const counter = new DailyCounter();
  const noon = Date.UTC(2026, 10, 15, 12);
  assert.equal([1, 2, 3].map(() => counter.take('acme', 2, noon)).join(), 'true,true,false');
  assert.equal(counter.used('acme', noon), 2);
  assert.equal(counter.take('globex', 2, noon), true, 'each account has its own');
  assert.equal(counter.take('acme', 2, Date.UTC(2026, 10, 15, 23, 59, 59)), false);
  assert.equal(counter.take('acme', 2, Date.UTC(2026, 10, 16)), true, 'the next day it starts again');
  assert.equal(counter.used('acme', noon + DAY), 1);
  assert.equal(DailyCounter.resetsAt(noon), '2026-11-16T00:00:00.000Z');
  assert.equal(counter.take('none', 0, noon), false, 'a quota of 0 lets nothing through');
});

test('an operator writes quotas by tier, and a mistake in them stops the hub from starting', () => {
  assert.equal(checkQuotas(null), null);
  assert.deepEqual(checkQuotas({ key: { sendsPerDay: 10, topics: 0 }, account: { agents: null } }), { key: { sendsPerDay: 10, topics: 0 }, account: {} });
  for (const wrong of [[], 'many', { premium: {} }, { key: { messages: 1 } }, { key: { topics: -1 } }, { key: { topics: 1.5 } }, { key: 'x' }]) {
    assert.throws(() => checkQuotas(wrong), /quotas/, JSON.stringify(wrong));
  }
});

test('the agents of one account share its quota of messages and events; another account has its own', async (t) => {
  const person = generateIdentity(); // a controller the operator verified: its agents are of tier "account"
  const hub = await startHub(t, {
    verifiedControllers: { [person.did]: 'github:somebody' },
    quotas: { key: { sendsPerDay: 1 }, account: { sendsPerDay: 3 } },
  });
  const [one, two, reader, loner] = await Promise.all(['one', 'two', 'reader', 'loner'].map((name) => hub.agent(name)));
  for (const agent of [one, two]) await agent.attachDelegation(createDelegation(person, { subject: agent.did }));
  await one.createTopic({ name: 'acme.news', description: 'News of the account', schema: { type: 'object' } });

  await one.send(reader.did, { type: 'note', data: { n: 1 }, encrypt: false });
  await one.publish('acme.news', { type: 'note', data: { n: 2 } });
  await two.send(reader.did, { type: 'note', data: { n: 3 }, encrypt: false });
  // The fourth of the account, whichever of its agents sends it.
  const refused = await rejects(two.send(reader.did, { type: 'note', data: { n: 4 }, encrypt: false }), 429, 'quota_exceeded');
  assert.equal(refused.details.quota, 'sends_per_day');
  assert.equal(refused.details.limit, 3);
  assert.match(refused.details.resets_at, /T00:00:00\.000Z$/);
  await rejects(one.publish('acme.news', { type: 'note', data: { n: 5 } }), 429, 'quota_exceeded');

  const usage = await two.usage();
  assert.deepEqual({ ...usage, resets_at: undefined }, {
    account: person.did,
    tier: 'account',
    quotas: { sends_per_day: 3, topics: null, agents: null },
    used: { sends_today: 3, topics: 1, agents: 2 },
    resets_at: undefined,
  });

  // An agent without a delegation is an account of its own, with the quota of its tier.
  await loner.send(reader.did, { type: 'note', data: { n: 6 }, encrypt: false });
  await rejects(loner.send(reader.did, { type: 'note', data: { n: 7 }, encrypt: false }), 429, 'quota_exceeded');
  assert.deepEqual((await loner.usage()).used, { sends_today: 1, topics: 0, agents: 1 });
  // Reading is not sending: the reader got everything, and its own quota is untouched.
  assert.equal((await reader.poll()).messages.length, 3, 'the three direct messages that were taken: the event went to a topic it does not follow');
  assert.equal((await reader.usage()).used.sends_today, 0);
  assert.deepEqual((await (await fetch(`${hub.url}/v1/info`)).json()).quotas, { key: { sendsPerDay: 1 }, account: { sendsPerDay: 3 } });
});

test('an instance sends out of the quota of its agent account', async (t) => {
  const hub = await startHub(t, { quotas: { key: { sendsPerDay: 2 } } });
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const reader = await hub.agent('reader');
  const copy = hub.client(instanceOf(aliceIdentity));
  await copy.registerInstance();
  await copy.send(reader.did, { type: 'note', data: { n: 1 }, encrypt: false });
  await alice.send(reader.did, { type: 'note', data: { n: 2 }, encrypt: false });
  await rejects(copy.send(reader.did, { type: 'note', data: { n: 3 }, encrypt: false }), 429, 'quota_exceeded');
  assert.equal((await copy.usage()).account, alice.did);
});

test('an account owns so many topics, and a controller has so many agents acting for it', async (t) => {
  const person = generateIdentity();
  const hub = await startHub(t, {
    verifiedControllers: { [person.did]: 'github:somebody' },
    quotas: { key: { topics: 0 }, account: { topics: 1, agents: 1 } },
  });
  const [one, two, loner] = await Promise.all(['one', 'two', 'loner'].map((name) => hub.agent(name)));
  const topic = (name) => ({ name, description: `The topic ${name}`, schema: { type: 'object' } });
  const refused = await rejects(loner.createTopic(topic('loner.topic')), 403, 'quota_exceeded');
  assert.equal(refused.details.quota, 'topics');

  await one.attachDelegation(createDelegation(person, { subject: one.did }));
  await one.createTopic(topic('acme.first'));
  await rejects(one.createTopic(topic('acme.second')), 403, 'quota_exceeded');

  // A second agent of the same controller does not fit; when the first drops its delegation, it does.
  const crowded = await rejects(two.attachDelegation(createDelegation(person, { subject: two.did })), 403, 'quota_exceeded');
  assert.equal(crowded.details.quota, 'agents');
  await one.dropDelegation();
  await two.attachDelegation(createDelegation(person, { subject: two.did }));
  // The topic stays with its owner, which is now an account of its own (tier "key", no topics allowed).
  assert.equal((await two.usage()).used.topics, 0);
  await two.createTopic(topic('acme.again'));

  // Registering with a delegation counts the same way.
  const late = generateIdentity();
  const lateClient = hub.client(late);
  const atRegister = await rejects(lateClient.register({ name: 'late' }, { delegation: createDelegation(person, { subject: late.did }) }), 403, 'quota_exceeded');
  assert.equal(atRegister.details.quota, 'agents');
});

test('a hub with no quotas lets an account do as much as its rate limits allow', async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = await Promise.all([hub.agent('alice'), hub.agent('bob')]);
  for (let n = 0; n < 5; n++) await alice.send(bob.did, { type: 'note', data: { n }, encrypt: false });
  assert.deepEqual((await alice.usage()).quotas, { sends_per_day: null, topics: null, agents: null });
  assert.equal((await alice.usage()).used.sends_today, 5, 'what an account sends is counted even with no quota');
});

test('the operators read what an account has used, and nobody else does', async (t) => {
  const operator = generateIdentity();
  const person = generateIdentity();
  const hub = await startHub(t, { operators: [operator.did], verifiedControllers: { [person.did]: 'github:somebody' } });
  const [one, two, reader] = await Promise.all(['one', 'two', 'reader'].map((name) => hub.agent(name)));
  for (const agent of [one, two]) await agent.attachDelegation(createDelegation(person, { subject: agent.did }));
  await one.send(reader.did, { type: 'note', data: {}, encrypt: false });
  await two.createTopic({ name: 'acme.board', description: 'The board of the account', schema: { type: 'object' } });
  const seen = await moderation(hub.url, operator).account(person.did);
  assert.deepEqual({ ...seen, agents: seen.agents.sort(), resets_at: undefined }, { account: person.did, agents: [one.did, two.did].sort(), used: { sends_today: 1, topics: 1, agents: 2 }, resets_at: undefined });
  await rejects(moderation(hub.url, person).account(person.did), 403, 'not_an_operator');
});
