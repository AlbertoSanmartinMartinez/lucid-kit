// What an agent signs when it changes something of its own - a topic, an instance, its delegation,
// its own standing - and what the hub and the SDK do with it. What a reader of the log makes of
// those statements is in log.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { signStatement } from '../src/core/statement.mjs';
import { normalizePolicy } from '../src/core/policy.mjs';
import { AgentClient, createDelegation, generateIdentity, LogError } from '../src/sdk/index.mjs';
import { contractHash } from '../src/core/log.mjs';
import { instanceOf, policyStatement, rejects, signedFetch, startHub, topicStatement } from './helpers.mjs';

const CONTRACT = { name: 'dev.rust.news', description: 'Noticias de Rust para quien quiera', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } };
const DAY = 86_400_000;

test('a policy is written one way, by whoever signs it and by the hub that keeps it', () => {
  const [a, b] = [generateIdentity().did, generateIdentity().did];
  const publish = (value) => normalizePolicy(value, { allowOwner: true });
  assert.deepEqual([publish(undefined), publish('any'), publish('owner'), normalizePolicy('owner', { allowOwner: false })], ['any', 'any', 'owner', null]);
  assert.deepEqual(publish({ allow: [a, b, a], min_tier: 'org' }), { min_tier: 'org', allow: [a, b] });
  assert.deepEqual([publish({ min_tier: 'account' }), publish({ allow: [] })], [{ min_tier: 'account' }, { allow: [] }]);
  const notOne = ['nobody', 7, null, [], {}, { min_tier: 'key' }, { min_tier: 'gold' }, { allow: 'everybody' }, { allow: ['not a did'] }, { allow: [a], except: [b] }, { allow: Array.from({ length: 201 }, () => a) }];
  for (const value of notOne) assert.equal(publish(value), null, JSON.stringify(value).slice(0, 60));
});

test('the hub takes a change only with the statement of the agent that makes it, signed with the key that asks', async (t) => {
  const hub = await startHub(t);
  const elsewhere = await startHub(t); // another hub: what is signed for one means nothing on the other
  const controller = generateIdentity();
  const ids = { alice: generateIdentity(), bob: generateIdentity() };
  const alice = await hub.agent('alice', ids.alice);
  const bob = await hub.agent('bob', ids.bob);
  ids.laptop = instanceOf(ids.alice, { name: 'laptop' });
  ids.server = instanceOf(ids.alice, { name: 'server' });
  const laptop = hub.client(ids.laptop);
  await laptop.registerInstance();
  const server = hub.client(ids.server);
  await server.registerInstance();
  const laptopKey = ids.laptop.instance;
  const say = (kind, says, signer, to = hub.did) => signStatement(kind, says, { hub: to, signer });
  const ask = (signer, method, path, body) => signedFetch(hub, signer, method, path, body);
  /** What the hub answers, and whether it left anything on record. */
  const answered = async (request) => {
    const before = hub.store.log.length;
    const { status, code } = await request;
    return [status, code, hub.store.log.length - before];
  };
  const REFUSED = [400, 'invalid_statement', 0];
  const NOT_THE_SAME_KEY = [403, 'signer_mismatch', 0];
  const last = () => hub.store.log.at(-1);

  // --- Creating a topic.
  const create = (signer, body, statement) => answered(ask(signer, 'POST', '/v1/topics', { ...body, statement }));
  const mine = (body, options) => topicStatement(hub, ids.alice, body, options);
  assert.deepEqual(await create(ids.alice, CONTRACT, undefined), REFUSED, 'as a client from before would ask');
  assert.deepEqual(await create(ids.alice, CONTRACT, 'I, alice'), REFUSED);
  assert.deepEqual(await create(ids.alice, CONTRACT, mine({ ...CONTRACT, publish: 'owner' })), REFUSED, 'she signed for other policies');
  assert.deepEqual(await create(ids.alice, CONTRACT, mine({ ...CONTRACT, description: 'Otra cosa distinta de la que se pide' })), REFUSED, 'for another contract');
  assert.deepEqual(await create(ids.alice, CONTRACT, mine({ ...CONTRACT, name: 'dev.rust.another' })), REFUSED, 'for another topic');
  const underAnotherName = say('topic.create', { topic: 'dev.rust.another', owner: alice.did, contract: contractHash(CONTRACT), publish: 'any', subscribe: 'any', encryption: null }, ids.alice);
  assert.deepEqual(await create(ids.alice, CONTRACT, underAnotherName), REFUSED, 'the same contract, under another name');
  // What she would sign to change a topic does not create one.
  assert.deepEqual(await create(ids.alice, CONTRACT, policyStatement(hub, ids.alice, CONTRACT, { publish: 'any', subscribe: 'any' }, 0)), REFUSED);
  assert.deepEqual(await create(ids.alice, CONTRACT, mine({ ...CONTRACT, subscribe: { min_tier: 'org' } })), REFUSED);
  assert.deepEqual(await create(ids.alice, CONTRACT, mine({ ...CONTRACT, encryption: 'mls-v1' })), REFUSED, 'for one that is encrypted');
  assert.deepEqual(await create(ids.alice, CONTRACT, topicStatement(elsewhere, ids.alice, CONTRACT)), REFUSED, 'for another hub');
  assert.deepEqual(await create(ids.alice, CONTRACT, topicStatement(hub, ids.bob, CONTRACT)), REFUSED, 'bob says it is his');
  const padded = mine(CONTRACT);
  assert.deepEqual(await create(ids.alice, CONTRACT, { ...padded, proof: { ...padded.proof, note: 'more' } }), REFUSED);
  // Signed by another key than the one that asks, even one that speaks for the same agent.
  assert.deepEqual(await create(ids.alice, CONTRACT, mine(CONTRACT, { signer: ids.bob })), NOT_THE_SAME_KEY);
  assert.deepEqual(await create(ids.alice, CONTRACT, mine(CONTRACT, { signer: laptopKey })), NOT_THE_SAME_KEY);
  assert.deepEqual(await create(laptopKey, CONTRACT, mine(CONTRACT)), NOT_THE_SAME_KEY);
  // A policy is signed as the hub keeps it: with its repeats, it is not what goes on record.
  const twice = { ...CONTRACT, name: 'dev.rust.twice', publish: { allow: [bob.did, bob.did] } };
  assert.deepEqual(await create(ids.alice, twice, mine(twice)), REFUSED);
  assert.deepEqual(await create(ids.alice, twice, mine({ ...twice, publish: { allow: [bob.did] } })), [201, null, 1]);
  // What is wrong with the topic itself is still said first, and in the hub's words.
  assert.deepEqual(await create(ids.alice, { ...CONTRACT, publish: 'nobody' }, mine(CONTRACT)), [400, 'invalid_topic', 0]);
  await rejects(alice.createTopic({ ...CONTRACT, publish: 'nobody' }), 400, 'invalid_topic');
  await rejects(alice.createTopic({ name: CONTRACT.name, description: CONTRACT.description }), 400, 'invalid_topic');

  // As it should be: from the agent key, and from an instance, which signs with its own. What
  // goes on record is the statement and its proof, and nothing that came along with them.
  assert.deepEqual(await create(ids.alice, CONTRACT, { ...mine(CONTRACT), note: 'more' }), [201, null, 1]);
  assert.deepEqual([last().type, last().owner, last().statement.proof.key_id, last().statement.proof.context, (await bob.getTopic(CONTRACT.name)).revision], ['topic.create', alice.did, alice.did, 'agenthub/topic/v1', 0]);
  assert.deepEqual(Object.keys(last().statement), ['statement', 'proof']);
  const viaSdk = await laptop.createTopic({ ...CONTRACT, name: 'dev.rust.laptop', publish: { allow: [bob.did, bob.did] }, subscribe: { min_tier: 'org', allow: [bob.did, bob.did] } });
  assert.deepEqual([viaSdk.owner, viaSdk.publish, viaSdk.subscribe, viaSdk.revision, last().statement.proof.key_id], [alice.did, { allow: [bob.did] }, { min_tier: 'org', allow: [bob.did] }, 0, laptop.instanceDid]);
  assert.deepEqual(last().statement.statement, { version: 1, hub: hub.did, topic: 'dev.rust.laptop', owner: alice.did, contract: last().contract, publish: { allow: [bob.did] }, subscribe: { min_tier: 'org', allow: [bob.did] }, encryption: null });

  // --- Changing who may use it. The owner says what changes, and it is the next change of the topic.
  const path = `/v1/topics/${CONTRACT.name}/policy`;
  const change = (signer, changes, statement) => answered(ask(signer, 'PUT', path, { ...changes, statement }));
  const said = (changes, revision, { topic = CONTRACT, ...options } = {}) => policyStatement(hub, ids.alice, topic, changes, revision, options);
  const STALE = [409, 'stale_statement', 0];
  const close = { publish: 'owner' };
  const forOrgs = { subscribe: { min_tier: 'org' } };
  assert.deepEqual(await change(ids.alice, close, undefined), REFUSED);
  assert.deepEqual(await change(ids.alice, close, said({ publish: 'any' }, 1)), REFUSED, 'she signed for another change');
  assert.deepEqual(await change(ids.alice, close, said(close, '1')), REFUSED, 'a revision is a number');
  assert.deepEqual(await change(ids.alice, close, said({ ...close, ...forOrgs }, 1)), REFUSED, 'she signed for more than is asked');
  assert.deepEqual(await change(ids.alice, { ...close, ...forOrgs }, said(close, 1)), REFUSED, 'more is asked than she signed for');
  assert.deepEqual(await change(ids.alice, close, said({ ...close, subscribe: 'any' }, 1)), REFUSED, 'saying that a policy stays is not the same as not saying');
  assert.deepEqual(await change(ids.alice, close, said(close, 1, { topic: { ...CONTRACT, description: 'Otra cosa distinta de la que se acordó' } })), REFUSED, 'she meant a topic with another contract');
  assert.deepEqual(await change(ids.alice, close, said(close, 1, { topic: { ...CONTRACT, encryption: 'mls-v1' } })), REFUSED);
  assert.deepEqual(await change(ids.alice, close, said(close, 1, { topic: twice })), REFUSED, 'what she signed about another topic of hers');
  const underOtherName = say('topic.policy', { topic: twice.name, owner: alice.did, contract: contractHash(CONTRACT), encryption: null, publish: 'owner', subscribe: null, revision: 1 }, ids.alice);
  assert.deepEqual(await change(ids.alice, close, underOtherName), REFUSED);
  assert.deepEqual(await change(ids.alice, close, said(close, 1, { signer: laptopKey })), NOT_THE_SAME_KEY);
  assert.deepEqual(await change(ids.alice, close, policyStatement(elsewhere, ids.alice, CONTRACT, close, 1)), REFUSED);
  assert.deepEqual(await change(ids.bob, close, said(close, 1, { signer: ids.bob })), [403, 'not_owner', 0]);
  assert.deepEqual(await change(ids.alice, close, policyStatement(hub, ids.bob, CONTRACT, close, 1, { signer: ids.alice })), REFUSED, 'she signed that the topic is of somebody else');
  // What she signed to create it does not change it.
  const created = hub.store.log.find((entry) => entry.type === 'topic.create' && entry.name === CONTRACT.name).statement;
  assert.deepEqual(await change(ids.alice, { publish: 'any', subscribe: 'any' }, created), REFUSED);
  assert.deepEqual(await change(ids.alice, close, said(close, 1)), [200, null, 1]);
  assert.deepEqual([(await bob.getTopic(CONTRACT.name)).publish, (await bob.getTopic(CONTRACT.name)).revision], ['owner', 1]);
  // On record: what she said changes, and null for what she left as it was.
  assert.deepEqual([last().publish, last().subscribe, last().statement.proof.context], ['owner', null, 'agenthub/topic-policy/v1']);
  assert.deepEqual(last().statement.statement, { version: 1, hub: hub.did, topic: CONTRACT.name, owner: alice.did, contract: contractHash(CONTRACT), encryption: null, publish: 'owner', subscribe: null, revision: 1 });
  // What she signed before does not put it back: this last one, a second time.
  assert.deepEqual(await change(ids.alice, close, last().statement), STALE);
  // Two of her keys change it at once, each from the topic as it read it: the second is told to make its change again.
  assert.deepEqual(await change(ids.alice, { publish: 'any' }, said({ publish: 'any' }, 2)), [200, null, 1]);
  const late = await ask(laptopKey, 'PUT', path, { ...forOrgs, statement: said(forOrgs, 2, { signer: laptopKey }) });
  assert.deepEqual([late.status, late.code, late.json.error.revision], [409, 'stale_statement', 2]);
  const again = await laptop.setTopicPolicy(CONTRACT.name, { subscribe: { min_tier: 'org', allow: [bob.did, bob.did] } });
  assert.deepEqual([again.publish, again.subscribe, again.revision, last().statement.proof.key_id], ['any', { min_tier: 'org', allow: [bob.did] }, 3, laptop.instanceDid]);
  // What is not said to change stays as it was, and nothing is signed about it.
  const closedAgain = await alice.setTopicPolicy(CONTRACT.name, { publish: { allow: [bob.did, bob.did] } });
  assert.deepEqual([closedAgain.publish, closedAgain.subscribe, closedAgain.revision], [{ allow: [bob.did] }, { min_tier: 'org', allow: [bob.did] }, 4]);
  assert.deepEqual([last().statement.statement.publish, last().statement.statement.subscribe], [{ allow: [bob.did] }, null]);
  const reopened = await alice.setTopicPolicy(CONTRACT.name, { subscribe: 'any' });
  assert.deepEqual([reopened.publish, reopened.subscribe, last().statement.statement.publish, last().statement.statement.subscribe, last().statement.statement.revision], [{ allow: [bob.did] }, 'any', null, 'any', 5]);
  const both = await alice.setTopicPolicy(CONTRACT.name, { publish: 'owner', subscribe: { min_tier: 'account' } });
  assert.deepEqual([both.publish, both.subscribe, both.revision], ['owner', { min_tier: 'account' }, 6]);
  await rejects(bob.setTopicPolicy(CONTRACT.name, { publish: 'any' }), 403, 'not_owner');
  await rejects(alice.setTopicPolicy('dev.rust.nothing', { publish: 'any' }), 404, 'topic_not_found');
  // What is no policy is said to be none: it does not pass for "leave it as it is".
  await rejects(alice.setTopicPolicy(CONTRACT.name, { publish: 'nobody' }), 400, 'invalid_topic');
  await rejects(alice.setTopicPolicy(CONTRACT.name, { subscribe: 'owner' }), 400, 'invalid_topic');
  assert.equal((await bob.getTopic(CONTRACT.name)).revision, 6);

  // --- Removing an instance. The agent, or the instance itself.
  const remove = (signer, instance, statement) => answered(ask(signer, 'DELETE', `/v1/instances/${instance}`, statement && { statement }));
  const removal = (instance, signer, to) => say('instance.remove', { agent: alice.did, instance }, signer, to);
  assert.deepEqual(await remove(ids.alice, laptop.instanceDid, undefined), REFUSED);
  assert.deepEqual(await remove(ids.alice, laptop.instanceDid, removal(server.instanceDid, ids.alice)), REFUSED, 'she signed to remove the other one');
  assert.deepEqual(await remove(ids.alice, laptop.instanceDid, removal(laptop.instanceDid, ids.alice, elsewhere.did)), REFUSED);
  assert.deepEqual(await remove(ids.alice, laptop.instanceDid, removal(laptop.instanceDid, laptopKey)), NOT_THE_SAME_KEY);
  assert.deepEqual(await remove(laptopKey, laptop.instanceDid, removal(laptop.instanceDid, ids.alice)), NOT_THE_SAME_KEY);
  assert.deepEqual(await remove(ids.server.instance, laptop.instanceDid, removal(laptop.instanceDid, ids.server.instance)), [403, 'agent_key_required', 0], 'not by a sibling');
  assert.equal((await alice.instances()).length, 2, 'both are still there');
  assert.deepEqual(await remove(laptopKey, laptop.instanceDid, removal(laptop.instanceDid, laptopKey)), [200, null, 1]);
  assert.deepEqual([last().type, last().by, last().statement.proof.key_id], ['instance.remove', laptop.instanceDid, laptop.instanceDid]);
  assert.deepEqual(await alice.removeInstance(server.instanceDid), { agent: alice.did, did: server.instanceDid, removed: true });
  assert.deepEqual([last().by, last().statement.statement, (await alice.instances()).length], [alice.did, { version: 1, hub: hub.did, agent: alice.did, instance: server.instanceDid }, 0]);

  // --- Dropping a delegation. The agent says which, and that one does not come back.
  const drop = (statement) => answered(ask(ids.bob, 'DELETE', '/v1/agents/me/delegation', statement && { statement }));
  const dropping = (held, signer = ids.bob, to) => say('delegation.drop', { agent: bob.did, issuer: held.issuer, delegation_id: held.id }, signer, to);
  assert.deepEqual(await drop(undefined), [200, null, 0], 'bob holds none: there is nothing to drop, and nothing to sign');
  const first = createDelegation(controller, { subject: bob.did });
  await bob.attachDelegation(first);
  assert.deepEqual(await drop(undefined), REFUSED);
  assert.deepEqual(await drop(dropping({ ...first.delegation, id: 'another' })), REFUSED);
  assert.deepEqual(await drop(dropping(first.delegation, ids.bob, elsewhere.did)), REFUSED);
  assert.deepEqual(await drop(dropping(first.delegation, ids.alice)), NOT_THE_SAME_KEY);
  assert.equal((await alice.getAgent(bob.did)).controller.did, controller.did, 'he still acts for his controller');
  const after = await bob.dropDelegation();
  assert.deepEqual([after.delegation, after.controller, last().statement.statement], [null, null, { version: 1, hub: hub.did, agent: bob.did, issuer: controller.did, delegation_id: first.delegation.id }]);
  const gone = await rejects(bob.attachDelegation(first), 403, 'delegation_revoked');
  assert.match(gone.message, /its issuer revoked it, or this agent dropped it/);
  // With another from his controller he acts for it again. What he signed to drop the first is of no use on this one.
  const second = createDelegation(controller, { subject: bob.did });
  await bob.attachDelegation(second);
  assert.deepEqual(await drop(dropping(first.delegation)), REFUSED);
  assert.equal((await bob.dropDelegation()).delegation, null);
  // One that has run out is not held any more: there is nothing to drop.
  const lapsed = createDelegation(controller, { subject: bob.did, days: 1, now: Date.now() - 2 * DAY });
  hub.store.commit({ type: 'agent.delegation', did: bob.did, envelope: lapsed, kind: 'key', at: new Date(Date.now() - 2 * DAY).toISOString() });
  assert.deepEqual(await drop(dropping(lapsed.delegation)), [200, null, 0]);
  assert.equal((await bob.dropDelegation()).delegation, null);

  // --- Retiring. Only the agent, and only with its own words for this hub.
  const retire = (signer, statement) => answered(ask(signer, 'DELETE', '/v1/agents/me', statement && { statement }));
  const retirement = (identity, signer = identity, to) => say('retire', { agent: identity.did }, signer, to);
  assert.deepEqual(await retire(ids.bob, undefined), REFUSED);
  assert.deepEqual(await retire(ids.bob, retirement(ids.alice)), REFUSED, 'what alice signed about herself');
  assert.deepEqual(await retire(ids.bob, retirement(ids.bob, ids.alice)), NOT_THE_SAME_KEY);
  // He is on the other hub too, and retires there. What he signed for that one is of no use here.
  const there = await elsewhere.agent('bob', ids.bob);
  await there.retire();
  const elsewhereSaid = elsewhere.store.log.at(-1).statement;
  assert.deepEqual([elsewhereSaid.statement, await retire(ids.bob, elsewhereSaid)], [{ version: 1, hub: elsewhere.did, agent: bob.did }, REFUSED]);
  assert.equal((await alice.getAgent(bob.did)).status, 'active', 'after all that, he is still here');
  assert.deepEqual([(await bob.retire()).status, last().type, last().by, last().statement.statement], ['revoked', 'agent.revoke', bob.did, { version: 1, hub: hub.did, agent: bob.did }]);
});

const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A client of `hub` that is answered by `lie(url, init)` whenever that returns something. */
const clientOf = (hub, identity, { lie = () => null, ...options } = {}) =>
  new AgentClient({ hubUrl: hub.url, identity, ...options, fetch: async (url, init) => (await lie(new URL(url), init)) ?? fetch(url, init) });

test('a statement is made for the hub the client knows it is talking to', async (t) => {
  const hub = await startHub(t);
  const other = generateIdentity().did;
  const topic = (n) => ({ ...CONTRACT, name: `dev.rust.news${n}` });
  let asked = 0;
  /** A hub that says of itself what `said` makes of the truth. */
  const saying = (said) => async (url, init) => {
    if (url.pathname !== '/v1/info') return null;
    asked += 1;
    return answer(said(await (await fetch(url, init)).json()));
  };
  const truth = (info) => info;
  const anotherHub = (info) => ({ ...info, hub: { did: other } });

  // It asks the hub which hub it is, once, and signs for that.
  const alice = clientOf(hub, generateIdentity(), { lie: saying(truth) });
  await alice.register({ name: 'alice' });
  await alice.createTopic(topic(1));
  await alice.setTopicPolicy(topic(1).name, { publish: 'owner' });
  assert.deepEqual([asked, hub.store.log.at(-1).statement.statement.hub], [1, hub.did]);

  // A hub that does not say which it is gets a statement made for no hub, and so no change.
  for (const said of [(info) => ({ ...info, hub: undefined }), (info) => ({ ...info, hub: { did: 'somebody' } })]) {
    const lost = clientOf(hub, generateIdentity(), { lie: saying(said) });
    await lost.register({ name: 'lost' });
    await rejects(lost.createTopic(topic(2)), 400, 'invalid_statement');
  }
  // One that names another: what the client signs is for that other, and of no use to this one.
  const misled = clientOf(hub, generateIdentity(), { lie: saying(anotherHub) });
  await misled.register({ name: 'misled' });
  await rejects(misled.createTopic(topic(2)), 400, 'invalid_statement');
  await rejects(misled.retire(), 400, 'invalid_statement');

  // A client that was told which hub this is, or that follows its log, signs for the one it knows, whatever it is told now.
  const told = clientOf(hub, generateIdentity(), { lie: saying(anotherHub), hubDid: hub.did });
  await told.register({ name: 'told' });
  assert.equal((await told.createTopic(topic(3))).owner, told.did);
  const follower = clientOf(hub, generateIdentity(), { lie: saying(anotherHub), followLog: true });
  await follower.register({ name: 'follower' }); // by now it has read the log, and holds to the hub that signed for it
  assert.deepEqual([follower.followedHub, (await follower.createTopic(topic(4))).owner], [hub.did, follower.did]);
});

test('whoever changes a topic signs for what it changes, not for what the hub shows it', async (t) => {
  // To say which topic it means and which change this is, the owner asks the hub. A hub that lies
  // in that answer gets nothing it can use: no other policy, no other topic, no change for later.
  const hub = await startHub(t);
  const identity = generateIdentity();
  const honest = await hub.agent('alice', identity);
  await honest.createTopic({ ...CONTRACT, publish: 'owner', subscribe: { min_tier: 'org' } });
  const shown = async (url, init) => (await fetch(url, init)).json();
  /** An owner whose hub shows the topic as `lie` makes of the truth. */
  const owner = (lie, options = {}) =>
    clientOf(hub, identity, { ...options, lie: async (url, init) => (url.pathname === `/v1/topics/${CONTRACT.name}` && (init?.method ?? 'GET') === 'GET' ? answer(lie(await shown(url, init))) : null) });
  const real = () => hub.store.topics.get(CONTRACT.name);
  const last = () => hub.store.log.at(-1);

  // It shows her that anybody may read. She only says who may publish: who reads is left as it really was.
  const opened = (topic) => ({ ...topic, subscribe: 'any' });
  await owner(opened).setTopicPolicy(CONTRACT.name, { publish: 'any' });
  assert.deepEqual([real().publish, real().subscribe, last().statement.statement.subscribe], ['any', { min_tier: 'org' }, null]);
  // It shows her another contract under the name of her topic. What she signs is about that other one, and of no use here.
  const swapped = (topic) => ({ ...topic, schema: { type: 'object' } });
  await rejects(owner(swapped).setTopicPolicy(CONTRACT.name, { publish: 'owner' }), 400, 'invalid_statement');
  const encrypted = (topic) => ({ ...topic, encryption: 'mls-v1' });
  await rejects(owner(encrypted).setTopicPolicy(CONTRACT.name, { publish: 'owner' }), 400, 'invalid_statement');
  // It shows her a later revision, to hold her change until the topic gets there. The hub that keeps the log does not take it now.
  const later = (topic) => ({ ...topic, revision: topic.revision + 3 });
  await rejects(owner(later).setTopicPolicy(CONTRACT.name, { publish: 'owner' }), 409, 'stale_statement');
  assert.deepEqual([real().publish, real().revision], ['any', 1]);
  // An owner that follows the log of its hub does not sign at all for a topic that is not as the log has it.
  for (const lie of [opened, swapped, encrypted, later]) {
    await assert.rejects(owner(lie, { followLog: true }).setTopicPolicy(CONTRACT.name, { publish: 'owner' }), (err) => err instanceof LogError && err.code === 'log_mismatch');
  }
  assert.match(await owner(later, { followLog: true }).getTopic(CONTRACT.name).then(() => '', (err) => err.message), /^the hub shows a revision of dev\.rust\.news that is not the one in its log$/);
  assert.equal(hub.store.log.length, 4, 'what the hub keeps of all that: her card, the topic and the one change she made');
});

test('a hub that says a change is done and leaves it off the record is caught by the agent that made it', async (t) => {
  // The agent removes an instance that was stolen, say. A hub that answers "done" and records
  // nothing would leave everybody else listening to that instance, and the agent none the wiser.
  const hub = await startHub(t);
  const controller = generateIdentity();
  const ids = { alice: generateIdentity(), newcomer: generateIdentity() };
  const honest = await hub.agent('alice', ids.alice);
  ids.laptop = instanceOf(ids.alice, { name: 'laptop' });
  ids.tablet = instanceOf(ids.alice, { name: 'tablet' });
  await hub.client(ids.laptop).registerInstance();
  await honest.createTopic(CONTRACT);
  await honest.attachDelegation(createDelegation(controller, { subject: honest.did }));
  const view = async () => (await fetch(`${hub.url}/v1/agents/${encodeURIComponent(honest.did)}`)).json();
  const topic = async () => (await fetch(`${hub.url}/v1/topics/${CONTRACT.name}`)).json();
  const now = new Date().toISOString();
  const sent = (init) => JSON.parse(Buffer.from(init.body).toString('utf8'));
  /** For each change: the request the hub swallows, and what it answers instead of doing it. */
  const swallowed = {
    'PUT /v1/agents/me': async (init) => ({ ...(await view()), ...sent(init).card_envelope }),
    'PUT /v1/agents/me/delegation': async (init) => ({ ...(await view()), delegation: sent(init).delegation }),
    'DELETE /v1/agents/me/delegation': async () => ({ ...(await view()), delegation: null, controller: null }),
    'DELETE /v1/agents/me': async () => ({ ...(await view()), status: 'revoked', revoked: { at: now, by: honest.did, reason: null } }),
    [`DELETE /v1/instances/${ids.laptop.instance.did}`]: async () => ({ agent: honest.did, did: ids.laptop.instance.did, removed: true }),
    'PUT /v1/instances/me': async (init) => ({ agent: honest.did, did: ids.tablet.instance.did, certificate: sent(init).certificate, registered_at: now, online: false }),
    'POST /v1/topics': async (init) => ({ ...(await topic()), name: sent(init).name, revision: 0 }),
    [`PUT /v1/topics/${CONTRACT.name}/policy`]: async (init) => ({ ...(await topic()), publish: sent(init).publish, revision: 1, unsubscribed: 0 }),
    'POST /v1/agents': async (init) => ({ ...(await view()), did: ids.newcomer.did, ...sent(init).card_envelope, delegation: null, controller: null }),
  };
  const lie = async (url, init) => {
    const made = swallowed[`${init?.method ?? 'GET'} ${decodeURIComponent(url.pathname)}`];
    return made ? answer(await made(init)) : null;
  };
  const follow = (identity) => clientOf(hub, identity, { lie, followLog: true });
  const alice = follow(ids.alice);
  const changes = [
    ['a new card', () => alice.updateCard({ name: 'alice', description: 'Otra descripción distinta' }), /a card of did:key:\S+ that is not the one in its log/],
    ['a delegation presented', () => alice.attachDelegation(createDelegation(controller, { subject: alice.did })), /a delegation of did:key:\S+ that is not the one in its log/],
    ['a delegation dropped', () => alice.dropDelegation(), /a delegation of did:key:\S+ that is not the one in its log/],
    ['an instance removed', () => alice.removeInstance(ids.laptop.instance.did), /an instance of did:key:\S+ as removed that its log does not have as removed/],
    ['an instance registered', () => follow(ids.tablet).registerInstance(), /an instance of did:key:\S+ as registered that is not in its log/],
    ['a topic created', () => alice.createTopic({ ...CONTRACT, name: 'dev.rust.unrecorded' }), /a topic, dev\.rust\.unrecorded, that is not in its log/],
    ['a topic changed', () => alice.setTopicPolicy(CONTRACT.name, { publish: 'owner' }), /a policy of dev\.rust\.news that is not the one in its log/],
    ['a retirement', () => alice.retire(), /a status of did:key:\S+ that is not the one in its log, which has it as active/],
    ['a registration', () => follow(ids.newcomer).register({ name: 'newcomer' }), /an agent, did:key:\S+, that is not in its log/],
  ];
  const size = hub.store.log.length;
  for (const [what, change, said] of changes) {
    const err = await change().then(() => null, (thrown) => thrown);
    assert.ok(err instanceof LogError && err.code === 'log_mismatch', `${what}: the agent took the hub at its word (${err})`);
    assert.match(err.message, said, what);
  }
  assert.equal(hub.store.log.length, size, 'none of it was done');
  // A client that does not follow the log has nothing to hold the hub to, and takes its word.
  const trusting = clientOf(hub, ids.alice, { lie });
  assert.deepEqual(await trusting.removeInstance(ids.laptop.instance.did), { agent: honest.did, did: ids.laptop.instance.did, removed: true });
  // With a hub that does what it says, each of them goes through and is on record.
  const real = clientOf(hub, ids.alice, { followLog: true });
  await real.updateCard({ name: 'alice', description: 'Otra descripción distinta' });
  await real.dropDelegation();
  await real.attachDelegation(createDelegation(controller, { subject: real.did }));
  await real.removeInstance(ids.laptop.instance.did);
  await clientOf(hub, ids.tablet, { followLog: true }).registerInstance();
  await real.createTopic({ ...CONTRACT, name: 'dev.rust.recorded' });
  await real.setTopicPolicy(CONTRACT.name, { publish: 'owner' });
  await clientOf(hub, ids.newcomer, { followLog: true }).register({ name: 'newcomer' });
  assert.equal((await real.retire()).status, 'revoked');
  assert.equal(hub.store.log.length, size + 9);
});
