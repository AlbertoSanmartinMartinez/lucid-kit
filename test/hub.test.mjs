import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, HubError, generateIdentity, submitRevocation } from '../src/sdk/index.mjs';
import { CONTEXT, createProof, signCard, signEvent } from '../src/core/sign.mjs';
import { signRequest, HEADERS } from '../src/core/reqsig.mjs';
import { solvePow, verifyPow } from '../src/core/pow.mjs';
import { replayLog } from '../src/core/log.mjs';
import { deadHubUrl } from './helpers.mjs';

const TOPIC = 'dev.rust.code-review.requests';
const REVIEW_TOPIC = {
  name: TOPIC,
  description: 'Peticiones de revisión de código Rust (code review requests)',
  schema: {
    type: 'object',
    required: ['repo', 'pr'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', maxLength: 200 },
      pr: { type: 'integer', minimum: 1 },
      focus: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['unsafe', 'performance', 'style'] } },
    },
  },
};
const GENEROUS = { burst: 10_000, perMinute: 10_000 };

async function startHub(t, options = {}) {
  const hub = await createHub({
    port: 0,
    quiet: true,
    powDifficulty: 8,
    ...options,
    limits: { register: GENEROUS, challenge: GENEROUS, topicCreate: GENEROUS, ...(options.limits ?? {}) },
  }).listen();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await hub.close();
    await replayLog(hub.store.log, { hub: hub.did }); // whatever the test did, the log of the hub holds
  });
  hub.agent = async (name, identity = generateIdentity()) => {
    const client = new AgentClient({ hubUrl: hub.url, identity });
    clients.push(client);
    if (name) await client.register({ name });
    return client;
  };
  return hub;
}

/** Listens with the SDK and lets a test wait until N messages have arrived. */
function collect(client) {
  const messages = [];
  const errors = [];
  let wake = () => {};
  const listener = client.listen(
    (message) => {
      messages.push(message);
      wake();
    },
    {
      onError: (err) => {
        errors.push(err);
        wake();
      },
    },
  );
  const waitFor = async (count, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (messages.length < count) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${count} messages (got ${messages.length})`);
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, Math.min(left, 50));
      });
    }
    return messages;
  };
  return { messages, errors, listener, waitFor };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function signedFetch(hub, identity, method, path, body, mutate = (request) => request) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const request = mutate({
    headers: { 'content-type': 'application/json', ...signRequest(identity, method, hub.url + path, payload) },
    body: payload,
  });
  const res = await fetch(hub.url + path, { method, headers: request.headers, body: body === undefined ? undefined : request.body });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const rejects = (promise, status, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof HubError, `expected a HubError, got ${err}`);
    assert.equal(`${err.status} ${err.code}`, `${status} ${code}`);
    return true;
  });

// ---------------------------------------------------------------------------

test('registration needs a fresh challenge, real work and a card signed by the same key', async (t) => {
  const hub = await startHub(t, { powDifficulty: 12 });
  const identity = generateIdentity();
  const card_envelope = signCard({ did: identity.did, name: 'reviewer' }, identity);
  const challenge = async () => (await (await fetch(`${hub.url}/v1/challenges`, { method: 'POST' })).json()).challenge;
  const register = (body, who = identity) => signedFetch(hub, who, 'POST', '/v1/agents', body);

  // No work done.
  let c = await challenge();
  let bogus = 0;
  while (verifyPow(c, identity.did, String(bogus), 12)) bogus++;
  assert.equal((await register({ challenge: c, pow_nonce: String(bogus), card_envelope })).json.error.code, 'invalid_proof_of_work');

  // The challenge was consumed by the failed attempt, even with a correct solution.
  assert.equal((await register({ challenge: c, pow_nonce: solvePow(c, identity.did, 12), card_envelope })).json.error.code, 'invalid_challenge');
  assert.equal((await register({ challenge: 'made-up', pow_nonce: '1', card_envelope })).json.error.code, 'invalid_challenge');

  // A card signed by someone else.
  const other = generateIdentity();
  c = await challenge();
  const stolen = await register({ challenge: c, pow_nonce: solvePow(c, other.did, 12), card_envelope }, other);
  assert.equal(stolen.json.error.code, 'invalid_card');

  // The real thing.
  c = await challenge();
  const ok = await register({ challenge: c, pow_nonce: solvePow(c, identity.did, 12), card_envelope });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.tier, 'key');

  c = await challenge();
  const again = await register({ challenge: c, pow_nonce: solvePow(c, identity.did, 12), card_envelope });
  assert.equal(again.status, 409);
});

test('the SDK registers, updates its card, and verifies the cards it reads', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');

  const seen = await builder.getAgent(reviewer.did);
  assert.equal(seen.card.name, 'rust-reviewer');
  assert.equal(seen.online, false);
  assert.equal(await builder.getAgent(generateIdentity().did), null);

  await reviewer.register({ name: 'rust-reviewer', description: 'Revisa código Rust', skills: [{ name: 'code review', description: 'unsafe y rendimiento' }] });
  assert.equal((await builder.getAgent(reviewer.did)).card.description, 'Revisa código Rust');
  assert.equal((await builder.searchAgents('revisar codigo rust'))[0].did, reviewer.did);

  // A hub that serves a card not signed by its owner is caught by the SDK.
  const signed = hub.store.agents.get(reviewer.did).card.name;
  hub.store.agents.get(reviewer.did).card.name = 'impostor';
  await assert.rejects(builder.getAgent(reviewer.did), /fails verification/);
  hub.store.agents.get(reviewer.did).card.name = signed; // the card is also in the log of the hub, which has to hold when the test ends
});

test('requests must be signed, fresh and unmodified', async (t) => {
  const hub = await startHub(t, { clockSkewMs: 5000 });
  const identity = generateIdentity();
  await hub.agent('signer', identity);
  const body = { ...REVIEW_TOPIC };

  const unsigned = await fetch(`${hub.url}/v1/topics`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(unsigned.status, 401);

  const swapped = await signedFetch(hub, identity, 'POST', '/v1/topics', body, (request) => ({
    ...request,
    body: Buffer.from(JSON.stringify({ ...body, name: 'evil.topic' })),
  }));
  assert.equal(swapped.json.error.code, 'invalid_signature');

  const stale = await signedFetch(hub, identity, 'POST', '/v1/topics', body, (request) => {
    const old = signRequest(identity, 'POST', `${hub.url}/v1/topics`, request.body, Date.now() - 60_000);
    return { ...request, headers: { ...request.headers, ...old } };
  });
  assert.equal(stale.json.error.code, 'timestamp_out_of_range');

  const stranger = await signedFetch(hub, generateIdentity(), 'POST', '/v1/topics', body);
  assert.equal(`${stranger.status} ${stranger.json.error.code}`, '403 not_registered');

  // A captured request cannot be replayed, even though its signature is valid.
  let captured;
  const first = await signedFetch(hub, identity, 'PUT', '/v1/agents/me', { card_envelope: signCard({ did: identity.did, name: 'signer' }, identity) }, (request) => (captured = request));
  assert.equal(first.status, 200);
  const replay = await fetch(`${hub.url}/v1/agents/me`, { method: 'PUT', headers: captured.headers, body: captured.body });
  assert.equal((await replay.json()).error.code, 'replayed_request');

  const garbage = await signedFetch(hub, identity, 'POST', '/v1/topics', undefined, (request) => ({
    ...request,
    headers: { ...request.headers, [HEADERS.DID]: 'did:key:zNotAKey' },
  }));
  assert.equal(garbage.status, 401);
});

test('topics: contract registration, discovery and quotas', async (t) => {
  const hub = await startHub(t, { maxTopicsPerAgent: 2 });
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');

  const created = await reviewer.createTopic(REVIEW_TOPIC);
  assert.equal(created.owner, reviewer.did);
  assert.equal(created.schema_url, `${hub.url}/v1/topics/${TOPIC}/schema`);
  assert.deepEqual(await (await fetch(created.schema_url)).json(), REVIEW_TOPIC.schema);

  await rejects(builder.createTopic(REVIEW_TOPIC), 409, 'topic_exists');
  await rejects(builder.createTopic({ ...REVIEW_TOPIC, name: 'NotValid' }), 400, 'invalid_topic');
  await rejects(builder.createTopic({ ...REVIEW_TOPIC, name: 'agenthub.internal' }), 400, 'invalid_topic');
  await rejects(builder.createTopic({ ...REVIEW_TOPIC, name: 'a.b', description: 'short' }), 400, 'invalid_topic');
  const unsupported = await builder.createTopic({ ...REVIEW_TOPIC, name: 'a.b', schema: { type: 'string', pattern: '^(a+)+$' } }).catch((err) => err);
  assert.equal(unsupported.code, 'unsupported_schema');
  assert.match(unsupported.details.problems[0], /pattern/);

  await builder.createTopic({ name: 'geo.weather.alerts', description: 'Alertas meteorológicas por ciudad', schema: { type: 'object' } });
  const found = await builder.searchTopics('revisión de código en Rust');
  assert.equal(found[0].name, TOPIC);
  assert.equal(found.some((topic) => topic.name === 'geo.weather.alerts'), false);
  assert.equal((await builder.searchTopics('')).length, 2);

  await builder.createTopic({ name: 'x.second', description: 'second topic of the builder', schema: {} });
  await rejects(builder.createTopic({ name: 'x.third', description: 'one more than the quota', schema: {} }), 403, 'quota_exceeded');
  await rejects(builder.getTopic('does.not.exist'), 404, 'topic_not_found');
});

test('publish: subscribers get a verified event, the publisher gets no echo', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  const bystander = await hub.agent('bystander');
  await reviewer.createTopic(REVIEW_TOPIC);
  await reviewer.subscribe(TOPIC);
  await reviewer.subscribe(TOPIC); // idempotent
  await builder.subscribe(TOPIC);
  assert.deepEqual(await reviewer.subscriptions(), [TOPIC]);

  const inbox = { reviewer: collect(reviewer), builder: collect(builder), bystander: collect(bystander) };
  await Promise.all(Object.values(inbox).map((entry) => entry.listener.ready));
  assert.equal((await builder.getAgent(reviewer.did)).online, true);

  const data = { repo: 'https://github.com/acme/parser', pr: 42, focus: ['unsafe', 'performance'] };
  const receipt = await builder.publish(TOPIC, { type: 'dev.rust.code-review.request', data });
  assert.equal(receipt.delivered_to, 1);
  assert.equal(receipt.seq, 1);

  const [message] = await inbox.reviewer.waitFor(1);
  assert.equal(message.kind, 'topic');
  assert.equal(message.topic, TOPIC);
  assert.equal(message.sender, builder.did);
  assert.equal(message.type, 'dev.rust.code-review.request');
  assert.deepEqual(message.data, data);
  assert.equal(message.event.dataschema, `${hub.url}/v1/topics/${TOPIC}/schema`);
  assert.equal(message.hub.tier, 'key');
  assert.match(message.toModelContext(), /trust="untrusted"/);

  await settle();
  assert.equal(inbox.builder.messages.length, 0, 'no echo to the publisher');
  assert.equal(inbox.bystander.messages.length, 0, 'not subscribed, not delivered');
  assert.deepEqual(inbox.reviewer.errors, []);

  await reviewer.unsubscribe(TOPIC);
  assert.equal((await builder.publish(TOPIC, { type: 'dev.rust.code-review.request', data })).delivered_to, 0);

  // Retained history is public and carries the same signed envelopes.
  const history = await (await fetch(`${hub.url}/v1/topics/${TOPIC}/events`)).json();
  assert.equal(history.events.length, 2);
  assert.equal(history.events[0].envelope.event.id, message.id);
});

test('publish: the hub enforces the topic contract', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  await reviewer.createTopic(REVIEW_TOPIC);
  await reviewer.createTopic({ name: 'dev.rust.announcements', description: 'Only the owner announces here', schema: { type: 'object' }, publish: 'owner' });

  const invalid = await builder.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 'forty-two', extra: 1 } }).catch((err) => err);
  assert.equal(`${invalid.status} ${invalid.code}`, '422 schema_validation_failed');
  assert.deepEqual(invalid.details.errors.map((error) => error.path).sort(), ['/extra', '/pr']);

  await rejects(builder.publish('dev.rust.announcements', { type: 'x', data: {} }), 403, 'publish_not_allowed');
  assert.equal((await reviewer.publish('dev.rust.announcements', { type: 'x', data: {} })).seq, 1);
  await rejects(builder.publish('no.such.topic', { type: 'x', data: {} }), 404, 'topic_not_found');

  // An event signed for one topic cannot be posted to another.
  const identity = generateIdentity();
  await hub.agent('raw', identity);
  const event = (overrides) => ({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: identity.did,
    type: 'x',
    time: new Date().toISOString(),
    subject: TOPIC,
    data: { repo: 'r', pr: 1 },
    ...overrides,
  });
  const post = (topic, ev) => signedFetch(hub, identity, 'POST', `/v1/topics/${topic}/events`, signEvent(ev, identity));
  assert.equal((await post(TOPIC, event())).status, 202);
  assert.equal((await post(TOPIC, event({ subject: 'dev.rust.announcements' }))).json.error.code, 'invalid_event');
  assert.equal((await post(TOPIC, event({ time: '2020-01-01T00:00:00Z' }))).json.error.code, 'invalid_event');
  assert.equal((await post(TOPIC, event({ specversion: '0.3' }))).json.error.code, 'invalid_event');
  assert.equal((await post(TOPIC, event({ Recipient: 'x' }))).json.error.code, 'invalid_event');
  assert.equal((await post(TOPIC, event({ dataschema: 'https://elsewhere.example/schema' }))).json.error.code, 'invalid_event');
  const noData = event();
  delete noData.data;
  assert.equal((await post(TOPIC, noData)).json.error.code, 'invalid_event');
});

test('authorship cannot be forged or borrowed', async (t) => {
  const hub = await startHub(t);
  const victimIdentity = generateIdentity();
  const attackerIdentity = generateIdentity();
  const victim = await hub.agent('victim', victimIdentity);
  await hub.agent('attacker', attackerIdentity);
  const reviewer = await hub.agent('rust-reviewer');
  await reviewer.createTopic(REVIEW_TOPIC);
  await reviewer.subscribe(TOPIC);
  const inbox = collect(reviewer);
  await inbox.listener.ready;

  const event = {
    specversion: '1.0',
    id: 'forged-1',
    source: victimIdentity.did,
    type: 'x',
    time: new Date().toISOString(),
    subject: TOPIC,
    data: { repo: 'r', pr: 1 },
  };
  const path = `/v1/topics/${TOPIC}/events`;

  // 1. The attacker signs an event that claims to come from the victim.
  const forged = { event, proof: createProof(CONTEXT.EVENT, event, attackerIdentity) };
  assert.equal((await signedFetch(hub, attackerIdentity, 'POST', path, forged)).json.error.code, 'invalid_envelope');

  // 2. The attacker relabels the proof as the victim's.
  const relabeled = { event, proof: { ...forged.proof, key_id: victimIdentity.did } };
  assert.equal((await signedFetch(hub, attackerIdentity, 'POST', path, relabeled)).json.error.code, 'invalid_envelope');

  // 3. The attacker re-submits a genuine envelope captured from the victim.
  const genuine = signEvent(event, victimIdentity);
  const borrowed = await signedFetch(hub, attackerIdentity, 'POST', path, genuine);
  assert.equal(`${borrowed.status} ${borrowed.json.error.code}`, '403 signer_mismatch');

  await settle();
  assert.equal(inbox.messages.length, 0);

  // The same envelope sent by its real author goes through.
  assert.equal((await signedFetch(hub, victimIdentity, 'POST', path, genuine)).status, 202);
  assert.equal((await inbox.waitFor(1))[0].sender, victim.did);
});

test('retries are idempotent: a repeated event id is delivered once', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  await reviewer.createTopic(REVIEW_TOPIC);
  await reviewer.subscribe(TOPIC);
  const inbox = collect(reviewer);
  await inbox.listener.ready;

  const data = { repo: 'r', pr: 7 };
  const first = await builder.publish(TOPIC, { type: 'x', data, id: 'attempt-1' });
  const second = await builder.publish(TOPIC, { type: 'x', data, id: 'attempt-1' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  await builder.publish(TOPIC, { type: 'x', data, id: 'attempt-2' });

  const messages = await inbox.waitFor(2);
  await settle();
  assert.deepEqual(messages.map((message) => message.id), ['attempt-1', 'attempt-2']);

  const dm1 = await builder.send(reviewer.did, { type: 'x', data: {}, id: 'dm-1' });
  const dm2 = await builder.send(reviewer.did, { type: 'x', data: {}, id: 'dm-1' });
  assert.deepEqual([dm1.duplicate, dm2.duplicate], [false, true]);
});

test('direct messages reach only their recipient, signed by the sender', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  const bystander = await hub.agent('bystander');
  const inbox = { builder: collect(builder), bystander: collect(bystander) };
  await Promise.all(Object.values(inbox).map((entry) => entry.listener.ready));

  const receipt = await reviewer.send(builder.did, { type: 'dev.rust.code-review.question', data: { text: '¿Qué rama reviso?' } });
  assert.equal(receipt.recipient_online, true);
  const [message] = await inbox.builder.waitFor(1);
  assert.equal(message.kind, 'direct');
  assert.equal(message.topic, null);
  assert.equal(message.sender, reviewer.did);
  assert.equal(message.event.recipient, builder.did);
  assert.deepEqual(message.data, { text: '¿Qué rama reviso?' });

  await settle();
  assert.equal(inbox.bystander.messages.length, 0);

  await rejects(reviewer.send(generateIdentity().did, { type: 'x', data: {} }), 404, 'recipient_not_found');
  await rejects(reviewer.send(reviewer.did, { type: 'x', data: {} }), 400, 'invalid_event');
  await rejects(reviewer.send('not-a-did', { type: 'x', data: {}, encrypt: false }), 400, 'invalid_event');
});

test('an agent that was offline catches up, and acknowledged messages are not resent', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builder = await hub.agent('builder');
  await reviewer.createTopic(REVIEW_TOPIC);
  await reviewer.subscribe(TOPIC);

  // Nobody is listening yet.
  const offline = await builder.send(reviewer.did, { type: 'x', data: { n: 1 } });
  assert.equal(offline.recipient_online, false);
  await builder.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 2 } });
  assert.equal(hub.store.pending(reviewer.did).length, 2);

  const firstSession = collect(reviewer);
  const messages = await firstSession.waitFor(2);
  assert.deepEqual(messages.map((message) => [message.seq, message.kind]), [[1, 'direct'], [2, 'topic']]);
  await firstSession.listener.close(); // flushes the acknowledgement
  assert.equal(hub.store.pending(reviewer.did).length, 0);

  await builder.send(reviewer.did, { type: 'x', data: { n: 3 } });
  const secondSession = collect(reviewer);
  const later = await secondSession.waitFor(1);
  await settle();
  assert.deepEqual(later.map((message) => message.data), [{ n: 3 }]);

  // Polling is the non-streaming alternative.
  await secondSession.listener.close();
  await builder.send(reviewer.did, { type: 'x', data: { n: 4 } });
  const polled = await reviewer.poll();
  assert.deepEqual(polled.messages.map((message) => message.data), [{ n: 4 }]);
  assert.deepEqual((await reviewer.poll()).messages, []);
});

test('a second connection of the same agent takes over the stream', async (t) => {
  const hub = await startHub(t);
  const identity = generateIdentity();
  const first = await hub.agent('twin', identity);
  const second = await hub.agent(null, identity);
  const sender = await hub.agent('sender');

  const a = collect(first);
  await a.listener.ready;
  const b = collect(second);
  await b.listener.ready;
  await settle();
  assert.equal(a.errors.at(-1)?.code, 'stream_replaced');

  await sender.send(identity.did, { type: 'x', data: { n: 1 } });
  await b.waitFor(1);
  await settle();
  assert.equal(a.messages.length, 0);
});

test('the SDK discards entries a dishonest hub tries to slip in', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent('rust-reviewer');
  const builderIdentity = generateIdentity();
  const builder = await hub.agent('builder', builderIdentity);
  await reviewer.createTopic(REVIEW_TOPIC);
  const at = new Date().toISOString();
  const base = { specversion: '1.0', source: builderIdentity.did, type: 'x', time: at };

  // Plays the dishonest hub: files an entry straight into the reviewer's inbox, skipping every server-side check.
  const inbox = hub.store.inboxes.get(reviewer.did);
  const slip = (entry) => inbox.items.push({ seq: inbox.next++, hub: { tier: 'key', received_at: at }, ...entry });

  // Altered after signing.
  const altered = signEvent({ ...base, id: 'a', recipient: reviewer.did, data: { amount: 1 } }, builderIdentity);
  altered.event.data.amount = 1_000_000;
  slip({ kind: 'direct', envelope: altered });
  // Genuine, but addressed to someone else.
  slip({ kind: 'direct', envelope: signEvent({ ...base, id: 'b', recipient: builder.did, data: {} }, builderIdentity) });
  // Genuine and signed for the topic, but violating its schema.
  slip({ kind: 'topic', topic: TOPIC, envelope: signEvent({ ...base, id: 'c', subject: TOPIC, data: { repo: 1 } }, builderIdentity) });
  // Signed for another topic and replayed into this one.
  slip({ kind: 'topic', topic: TOPIC, envelope: signEvent({ ...base, id: 'd', subject: 'other.topic', data: { repo: 'r', pr: 1 } }, builderIdentity) });
  // And one honest message, to prove the rest of the inbox still gets through.
  await builder.send(reviewer.did, { type: 'x', data: { honest: true } });

  const { messages, errors } = await reviewer.poll();
  assert.deepEqual(messages.map((message) => message.data), [{ honest: true }]);
  assert.deepEqual(
    errors.map((err) => err.message.replace(/^discarded inbox entry \d+: /, '').replace(/ \(.*$/, '')),
    [
      'signature does not match',
      'direct message was not addressed to this agent',
      'payload does not match the topic schema',
      'event was not signed for this topic',
    ],
  );
  assert.ok(errors.every((err) => err.code === 'invalid_message'));
});

test('rate limits and size limits hold', async (t) => {
  const hub = await startHub(t, { limits: { direct: { burst: 3, perMinute: 1 } }, maxBodyBytes: 2048 });
  const a = await hub.agent('a');
  const b = await hub.agent('b');
  for (let i = 0; i < 3; i++) await a.send(b.did, { type: 'x', data: { i } });
  const limited = await a.send(b.did, { type: 'x', data: {} }).catch((err) => err);
  assert.equal(`${limited.status} ${limited.code}`, '429 rate_limited');
  assert.ok(limited.details.retry_after_seconds > 0);
  // Limits are per agent: b is unaffected.
  assert.equal((await b.send(a.did, { type: 'x', data: {} })).duplicate, false);

  await rejects(b.send(a.did, { type: 'x', data: { blob: 'x'.repeat(4096) } }), 413, 'payload_too_large');
});

test('state survives a clean restart and a crash', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agenthub-test-'));
  const options = { port: 0, quiet: true, powDifficulty: 8, dataDir };
  const reviewerIdentity = generateIdentity();
  const builderIdentity = generateIdentity();
  const running = [];
  const boot = async () => {
    const hub = await createHub(options).listen();
    running.push(hub);
    return {
      hub,
      reviewer: new AgentClient({ hubUrl: hub.url, identity: reviewerIdentity }),
      builder: new AgentClient({ hubUrl: hub.url, identity: builderIdentity }),
    };
  };

  try {
    let { hub, reviewer, builder } = await boot();
    await reviewer.register({ name: 'rust-reviewer' });
    await builder.register({ name: 'builder' });
    await reviewer.createTopic(REVIEW_TOPIC);
    await reviewer.subscribe(TOPIC);
    await builder.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 1 }, id: 'before-restart' });
    await builder.send(reviewer.did, { type: 'x', data: { n: 2 } });
    await hub.close();
    running.pop();

    // Second run: restored from the snapshot written on shutdown.
    ({ hub, reviewer, builder } = await boot());
    assert.equal((await reviewer.getAgent(builder.did)).card.name, 'builder');
    assert.deepEqual(await reviewer.subscriptions(), [TOPIC]);
    assert.equal((await reviewer.getTopic(TOPIC)).last_seq, 1);
    assert.equal((await builder.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 1 }, id: 'before-restart' })).duplicate, true);
    await builder.publish(TOPIC, { type: 'x', data: { repo: 'r', pr: 3 } });

    // Third run: the second hub "crashes" (it never shuts down), so recovery has to come from the journal.
    hub.store.fd = null; // from here on the crashed instance must not touch the data directory
    ({ hub, reviewer, builder } = await boot());
    const { messages } = await reviewer.poll();
    assert.deepEqual(
      messages.map((message) => [message.seq, message.kind, message.data]),
      [
        [1, 'topic', { repo: 'r', pr: 1 }],
        [2, 'direct', { n: 2 }],
        [3, 'topic', { repo: 'r', pr: 3 }],
      ],
    );
  } finally {
    await Promise.all(running.map((hub) => hub.close()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unknown routes, wrong methods and bad JSON get clean errors', async (t) => {
  const hub = await startHub(t);
  const identity = generateIdentity();
  await hub.agent('a', identity);
  assert.equal((await fetch(`${hub.url}/nope`)).status, 404);
  assert.equal((await fetch(`${hub.url}/v1/info`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${hub.url}/v1/topics/%E0%A4%A`)).status, 404);
  assert.equal((await (await fetch(`${hub.url}/healthz`)).json()).ok, true);
  assert.equal((await (await fetch(`${hub.url}/v1/info`)).json()).protocol, 'agenthub/v1');
  assert.equal((await fetch(`${hub.url}/v1/topics?limit=abc`)).status, 400);

  const notJson = Buffer.from('{nope');
  const res = await fetch(`${hub.url}/v1/topics`, {
    method: 'POST',
    headers: signRequest(identity, 'POST', `${hub.url}/v1/topics`, notJson),
    body: notJson,
  });
  assert.equal((await res.json()).error.code, 'invalid_json');

  // Deeply nested payloads are refused instead of exhausting the stack.
  let nested = {};
  for (let i = 0; i < 500; i++) nested = { a: nested };
  const deep = { event: { specversion: '1.0', id: '1', source: identity.did, type: 'x', time: new Date().toISOString(), data: nested }, proof: {} };
  deep.proof = { algorithm: 'Ed25519', canonicalization: 'JCS', context: CONTEXT.EVENT, key_id: identity.did, signature: 'A'.repeat(86) };
  const deepRes = await signedFetch(hub, identity, 'POST', '/v1/messages', deep);
  assert.equal(`${deepRes.status} ${deepRes.json.error.code}`, '400 invalid_envelope');
});

test('a hub that does not answer is reported as such, with its address, instead of a bare "fetch failed"', async () => {
  const url = await deadHubUrl();
  const client = new AgentClient({ hubUrl: url });
  const err = await client.info().then(() => null, (problem) => problem);
  assert.ok(err instanceof HubError, `expected a HubError, got ${err}`);
  assert.equal(`${err.status} ${err.code}`, '0 hub_unreachable');
  assert.equal(err.message, `cannot reach the hub at ${url} (ECONNREFUSED)`);
  assert.ok(err.cause instanceof TypeError, 'the original error is kept for whoever wants to dig');
  await rejects(client.register({ name: 'nobody-home' }), 0, 'hub_unreachable');
  await rejects(submitRevocation(url, {}), 0, 'hub_unreachable');

  // A stream keeps retrying, as it would through a restart of the hub, and says why it is waiting.
  const errors = [];
  const listener = client.listen(() => {}, { onError: (problem) => errors.push(problem) });
  for (let waited = 0; errors.length === 0 && waited < 3000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  await listener.close();
  assert.equal(errors[0]?.code, 'hub_unreachable');

  // An address that could never work is refused when the client is created, not on its first request.
  for (const bad of ['no-es-una-url', '127.0.0.1:8787', 'ftp://hub.example', '']) {
    assert.throws(() => new AgentClient({ hubUrl: bad }), /the hub URL must look like http:\/\/host:port/, bad);
  }
  assert.equal(new AgentClient({ hubUrl: 'https://hub.example/' }).hubUrl, 'https://hub.example');
});

test('an error says whether its words are the hub\'s or this client\'s own', async (t) => {
  // Whoever shows an error to a model has to know: a hub does not get to speak to the model of an agent.
  const hub = await startHub(t);
  const alice = await hub.agent('alice');
  const stranger = await hub.agent(null); // never registered
  // What a hub answered: to a request, to a revocation that anybody can send, and to whoever asks for its stream.
  const refused = await alice.subscribe('dev.rust.nothing').catch((err) => err);
  const revocation = await submitRevocation(hub.url, { not: 'a revocation' }).catch((err) => err);
  const listener = stranger.listen(() => {});
  const unheard = await listener.ready.catch((err) => err);
  await listener.close();
  for (const err of [refused, revocation, unheard]) assert.ok(err instanceof HubError);
  assert.deepEqual([refused.code, refused.fromHub, revocation.code, revocation.fromHub, unheard.code, unheard.fromHub], ['topic_not_found', true, 'invalid_revocation', true, 'not_registered', true]);
  // What this client says by itself: that the hub cannot be reached, or that it cannot do what was asked.
  const unreachable = await new AgentClient({ hubUrl: await deadHubUrl() }).info().catch((err) => err);
  const noMls = await alice.send(stranger.did, { type: 'note', data: {}, encrypt: 'mls' }).catch((err) => err);
  assert.deepEqual([unreachable.code, unreachable.fromHub, noMls.code, noMls.fromHub], ['hub_unreachable', false, 'mls_unavailable', false]);
});
