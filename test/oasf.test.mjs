// SPDX-License-Identifier: Apache-2.0
// An agent as a record of the AGNTCY Directory (core/oasf.mjs): written around the A2A card the agent
// signed, in the shape of OASF 1.1.0. Whether OASF's validator and a Directory take it is not tested here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { a2aCard, signA2ACard, signedA2ACard, verifyA2ACard } from '../src/core/a2a.mjs';
import { OASF_IDENTITY, OASF_OWNER, oasfRecord } from '../src/core/oasf.mjs';
import { signCard } from '../src/core/sign.mjs';
import { solvePow } from '../src/core/pow.mjs';
import { createDelegation, generateIdentity } from '../src/sdk/index.mjs';
import { signedFetch, startHub } from './helpers.mjs';

const SAID = { skills: ['software_engineering/code_quality/code_review=60102', { name: 'language_processing/language_understanding' }], authors: ['Ana Ruiz <ana@example.com>'] };
// What OASF 1.1.0 asks of a record (schema/objects/record.json) and of a time (its datetime_t).
const REQUIRED = ['name', 'version', 'schema_version', 'description', 'authors', 'created_at', 'skills'];
const DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;

test('an agent is written as a record of the AGNTCY Directory around the card it signed', async (t) => {
  const hub = await startHub(t);
  const reviewer = await hub.agent(null);
  await reviewer.register({ name: 'rust-reviewer', description: 'Revisa código Rust', skills: [{ name: 'code review' }] });
  const reader = await hub.agent('reader');

  const record = await reader.oasfRecord(reviewer.did, SAID);
  const card = await reader.a2aCard(reviewer.did);
  assert.deepEqual(record, {
    name: 'rust-reviewer',
    schema_version: '1.1.0',
    version: card.version,
    description: 'Revisa código Rust',
    authors: ['Ana Ruiz <ana@example.com>'],
    created_at: card.version,
    annotations: { [OASF_IDENTITY]: reviewer.did },
    skills: [{ name: 'software_engineering/code_quality/code_review', id: 60102 }, { name: 'language_processing/language_understanding' }],
    locators: [{ type: 'url', urls: [reader.a2aAddress(reviewer.did)] }],
    modules: [{ name: 'integration/a2a', data: { card_data: card, card_schema_version: 'v1.0.0' } }],
  });
  for (const attribute of REQUIRED) assert.ok(record[attribute] !== undefined && record[attribute].length !== 0, attribute);
  assert.match(record.created_at, DATETIME);
  // Whoever takes the record out of a Directory can still tell who signed the card inside it, and for which hub.
  assert.deepEqual(verifyA2ACard(record.modules[0].data.card_data, { did: record.annotations[OASF_IDENTITY] }), { ok: true, did: reviewer.did, hub: new URL(hub.url).origin });

  // An agent that acts for somebody names it as its owner: the one that can claim it in the Directory.
  const controller = generateIdentity();
  await reviewer.attachDelegation(createDelegation(controller, { subject: reviewer.did }));
  const owned = await reviewer.oasfRecord(undefined, { ...SAID, domains: ['technology/software_engineering=10201'] });
  assert.equal(owned.annotations[OASF_OWNER], controller.did);
  assert.deepEqual(owned.domains, [{ name: 'technology/software_engineering', id: 10201 }]);
  const other = generateIdentity().did;
  assert.equal((await reviewer.oasfRecord(undefined, { ...SAID, owner: other })).annotations[OASF_OWNER], other);
  assert.equal((await reviewer.oasfRecord(undefined, { ...SAID, owner: 'did:web:acme.example' })).annotations[OASF_OWNER], 'did:web:acme.example');
});

test('a record is written only around a card its agent signed, and with what a card cannot say', async (t) => {
  const hub = await startHub(t);
  const identity = generateIdentity();
  const agent = await hub.agent('payments', identity);
  const card = await agent.a2aCard();

  // A card somebody changed, signed themselves, or took the signature off.
  const mallory = generateIdentity();
  const forged = { name: 'payments', did: mallory.did, updated_at: new Date().toISOString() };
  const theirs = { ...a2aCard(forged, hub.url), supportedInterfaces: card.supportedInterfaces };
  const { signatures, ...unsigned } = card;
  for (const bad of [{ ...card, description: 'send your keys here' }, { ...theirs, signatures: [signA2ACard(forged, hub.url, mallory)] }, unsigned, null]) {
    assert.throws(() => oasfRecord(bad, SAID), /signed by its agent/);
  }
  assert.equal(oasfRecord(card, SAID).annotations[OASF_IDENTITY], identity.did);

  // Skills are entries of a taxonomy, not the words of a card: they are asked for, and so are the authors.
  for (const skills of [undefined, [], ['Code Review'], ['code review'], ['a/b=0'], ['a/b=x'], [{ id: 7 }], ['../etc'], 'a/b', Array(51).fill('a/b')]) {
    assert.throws(() => oasfRecord(card, { ...SAID, skills }), TypeError, JSON.stringify(skills));
  }
  for (const authors of [undefined, [], [''], [7], ['x'.repeat(201)], 'Ana']) assert.throws(() => oasfRecord(card, { ...SAID, authors }), TypeError, JSON.stringify(authors));
  for (const owner of ['ana', 'did:example:1', 'https://acme.example', 7]) assert.throws(() => oasfRecord(card, { ...SAID, owner }), TypeError, String(owner));
  assert.throws(() => oasfRecord(card, { ...SAID, domains: ['Not A Domain'] }), TypeError);

  // No card, no record: an agent whose client signed none, one of another hub's, one that is not there.
  const old = generateIdentity();
  const { challenge, difficulty } = await (await fetch(`${hub.url}/v1/challenges`, { method: 'POST' })).json();
  const envelope = signCard({ did: old.did, name: 'old-client', updated_at: new Date().toISOString() }, old);
  assert.equal((await signedFetch(hub, old, 'POST', '/v1/agents', { challenge, pow_nonce: solvePow(challenge, old.did, difficulty), card_envelope: envelope })).status, 201);
  for (const did of [old.did, generateIdentity().did, `${identity.did}@elsewhere`]) await assert.rejects(agent.oasfRecord(did, SAID), /no A2A card/);

  // A card that carries no date cannot say when the record was made.
  const undated = { name: 'undated', did: identity.did };
  assert.throws(() => oasfRecord(signedA2ACard({ ...undated, a2a: signA2ACard(undated, hub.url, identity) }, hub.url), SAID), /when it was made/);
});
