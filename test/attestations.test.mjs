// SPDX-License-Identifier: Apache-2.0
// Account attestations: a verifier the operator trusts vouches that a controller is an account (with
// GitHub, say), and the agents that controller delegates are of tier "account". The hub asks no
// provider, and what it took is on its log.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttestation, createDelegation, generateIdentity, submitAttestation, verifyAttestation } from '../src/sdk/index.mjs';
import { accountReference } from '../src/core/attestation.mjs';

const SECRET = Buffer.alloc(32, 7);
const ref = (account) => accountReference(SECRET, account);
import { CONTEXT, createProof } from '../src/core/proof.mjs';
import { Directory, replayLog } from '../src/core/log.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient } from '../src/sdk/index.mjs';
import { rejects, startHub } from './helpers.mjs';

const DAY = 86_400_000;

test('an attestation says who vouches that a controller is which account, and nothing else passes for one', () => {
  const verifier = generateIdentity();
  const controller = generateIdentity().did;
  const envelope = createAttestation(verifier, { controller, account: ref('github:1234'), days: 30 });
  assert.deepEqual(Object.keys(envelope.attestation), ['version', 'verifier', 'controller', 'account', 'issued_at', 'expires_at']);
  const verdict = verifyAttestation(envelope);
  assert.equal(verdict.ok, true);
  assert.deepEqual([verdict.verifier, verdict.controller, verdict.account], [verifier.did, controller, ref('github:1234')]);
  assert.ok(!JSON.stringify(envelope).includes('1234'), 'which account it is, is not in it');
  assert.equal(ref('github:1234'), ref('github:1234'), 'the same account has the same reference');
  assert.notEqual(ref('github:1234'), accountReference(Buffer.alloc(32, 8), 'github:1234'), 'and another under another secret');
  assert.throws(() => accountReference(Buffer.alloc(16), 'github:1'), /32 bytes/);

  const resigned = (change, signer = verifier) => {
    const attestation = { ...envelope.attestation, ...change };
    return { attestation, proof: createProof(CONTEXT.ACCOUNT_ATTESTATION, attestation, signer) };
  };
  const mallory = generateIdentity();
  const cases = {
    'another account, same signature': { attestation: { ...envelope.attestation, account: 'github:1' }, proof: envelope.proof },
    'signed by someone who is not the verifier it names': resigned({}, mallory),
    'naming a verifier that did not sign it': resigned({ verifier: mallory.did }),
    'signed in the context of something else': { attestation: envelope.attestation, proof: createProof(CONTEXT.DELEGATION, envelope.attestation, verifier) },
    'an organization, which proves its domain instead': resigned({ controller: 'did:web:acme.com' }),
    'a reference of another shape': resigned({ account: 'ref:short' }),
    'the account in the clear': resigned({ account: 'github:1234' }),
    'with the login of the account': resigned({ name: 'alice' }),
    'for more than 90 days': resigned({ expires_at: new Date(Date.parse(envelope.attestation.issued_at) + 91 * DAY).toISOString() }),
    'that ends before it starts': resigned({ expires_at: envelope.attestation.issued_at }),
    'with one field more': resigned({ tier: 'org' }),
    'of another version': resigned({ version: 2 }),
  };
  for (const [what, forged] of Object.entries(cases)) assert.equal(verifyAttestation(forged).ok, false, what);
  assert.throws(() => createAttestation(verifier, { controller, account: ref('github:1234'), days: 91 }), RangeError);
});

test('the agents of a controller that a trusted verifier vouches for are of tier "account", while it is in force', async (t) => {
  const verifier = generateIdentity();
  const hub = await startHub(t, { trustedVerifiers: [verifier.did], quotas: { key: { topics: 0 }, account: { topics: 2 } } });
  const person = generateIdentity();
  const agent = await hub.agent('agent');
  await agent.attachDelegation(createDelegation(person, { subject: agent.did }));
  assert.equal((await agent.usage()).tier, 'key', 'a delegation from a controller nobody vouched for raises nothing');

  const answer = await submitAttestation(hub.url, createAttestation(verifier, { controller: person.did, account: ref('github:1234') }));
  assert.deepEqual({ ...answer, expires_at: undefined }, { controller: person.did, account: ref('github:1234'), expires_at: undefined, recorded: true });
  assert.equal((await agent.usage()).tier, 'account');
  const card = await agent.getAgent(agent.did);
  assert.deepEqual(card.controller, { did: person.did, verified_as: ref('github:1234'), checked_locally: true });
  await agent.createTopic({ name: 'alice.notes', description: 'Notes of a verified account', schema: { type: 'object' } });

  // The same one again changes nothing and leaves nothing more on the log; an older one neither.
  const size = hub.store.log.length;
  const again = await submitAttestation(hub.url, createAttestation(verifier, { controller: person.did, account: ref('github:1234'), now: Date.now() - 60_000 }));
  assert.equal(again.recorded, false);
  assert.equal(hub.store.log.length, size);

  // The log says who vouched for whom, and a reader checks the verifier's signature itself.
  const entry = hub.store.log.find((logged) => logged.type === 'controller.attest');
  assert.deepEqual([entry.controller, entry.account, entry.attestation.attestation.verifier], [person.did, ref('github:1234'), verifier.did]);
  const { directory } = await replayLog(hub.store.log, { hub: hub.did });
  assert.equal(directory.accounts.get(person.did).account, ref('github:1234'));
  assert.equal(Directory.fromJSON(directory.toJSON()).accounts.get(person.did).verifier, verifier.did);
});

test('a hub takes attestations only from the verifiers its operator named, in force, and as they were signed', async (t) => {
  const trusted = generateIdentity();
  const stranger = generateIdentity();
  const hub = await startHub(t, { trustedVerifiers: [trusted.did] });
  const controller = generateIdentity().did;
  const make = (verifier, options = {}) => createAttestation(verifier, { controller, account: ref('github:42'), ...options });

  await rejects(submitAttestation(hub.url, make(stranger)), 403, 'verifier_not_trusted');
  await rejects(submitAttestation(hub.url, make(trusted, { now: Date.now() - 31 * DAY })), 400, 'attestation_expired');
  await rejects(submitAttestation(hub.url, make(trusted, { now: Date.now() + 10 * 60_000 })), 400, 'invalid_attestation');
  const tampered = make(trusted);
  tampered.attestation.account = ref('github:1');
  await rejects(submitAttestation(hub.url, tampered), 400, 'invalid_attestation');
  const padded = make(trusted);
  padded.proof.note = 'rides along';
  await rejects(submitAttestation(hub.url, padded), 400, 'invalid_attestation');
  assert.equal(hub.store.log.filter((entry) => entry.type === 'controller.attest').length, 0, 'none of them went on record');
  assert.equal(hub.store.attestations.size, 0);

  // A newer one replaces the account it says.
  await submitAttestation(hub.url, make(trusted, { now: Date.now() - 1000 }));
  await submitAttestation(hub.url, make(trusted, { account: ref('github:43') }));
  assert.equal(hub.store.attestations.get(controller).account, ref('github:43'));
});

test('an attestation stops counting when it runs out, or when the operator stops trusting its verifier, and survives a restart', async (t) => {
  const verifier = generateIdentity();
  const person = generateIdentity();
  const agentIdentity = generateIdentity();
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-attest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Each start on a port of its own: a client that kept a connection to the one before would not reach the next.
  const boot = (trustedVerifiers) => createHub({ port: 0, quiet: true, powDifficulty: 8, dataDir: dir, trustedVerifiers }).listen();
  const tierOf = async (hub) => {
    const client = new AgentClient({ hubUrl: hub.url, identity: agentIdentity });
    try {
      return (await client.usage()).tier;
    } finally {
      await client.close();
    }
  };

  let hub = await boot([verifier.did]);
  try {
    const agent = new AgentClient({ hubUrl: hub.url, identity: agentIdentity });
    await agent.register({ name: 'agent' });
    await agent.attachDelegation(createDelegation(person, { subject: agent.did }));
    await agent.close();
    await submitAttestation(hub.url, createAttestation(verifier, { controller: person.did, account: ref('github:7') }));
    assert.equal(await tierOf(hub), 'account');
  } finally {
    await hub.close();
  }

  // Started again from its data: the attestation is still there, and still counts.
  hub = await boot([verifier.did]);
  try {
    assert.equal(await tierOf(hub), 'account');
  } finally {
    await hub.close();
  }
  // The operator no longer trusts that verifier: what it signed counts no more, though it stays on the log.
  hub = await boot([]);
  try {
    assert.equal(await tierOf(hub), 'key');
    assert.equal(hub.store.log.filter((entry) => entry.type === 'controller.attest').length, 1);
    await replayLog(hub.store.log, { hub: hub.did });
  } finally {
    await hub.close();
  }

  // One that runs out stops counting when it does.
  hub = await boot([verifier.did]);
  try {
    await submitAttestation(hub.url, createAttestation(verifier, { controller: person.did, account: ref('github:7'), days: 1.5 / 86_400 }));
    assert.equal(await tierOf(hub), 'account');
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(await tierOf(hub), 'key');
    await replayLog(hub.store.log, { hub: hub.did });
  } finally {
    await hub.close();
  }
});

test('a log that puts on record an attestation it could not have taken does not hold', async (t) => {
  const verifier = generateIdentity();
  const hub = await startHub(t, { trustedVerifiers: [verifier.did] });
  const person = generateIdentity();
  await submitAttestation(hub.url, createAttestation(verifier, { controller: person.did, account: ref('github:9'), days: 1 }));
  const log = hub.store.log;
  const at = log.findIndex((entry) => entry.type === 'controller.attest');
  const honest = log[at];
  const replaced = (change) => [...log.slice(0, at), { ...structuredClone(honest), ...change }];
  const broken = {
    'another account than the one attested': replaced({ account: 'github:1' }),
    'another controller': replaced({ controller: generateIdentity().did }),
    'put on record after it ran out': replaced({ at: new Date(Date.parse(honest.attestation.attestation.expires_at) + 1000).toISOString() }),
    'with no time': replaced({ at: null }),
    'signed by nobody': replaced({ attestation: { ...honest.attestation, proof: { ...honest.attestation.proof, signature: 'A'.repeat(86) } } }),
    'the same one twice': [...log.slice(0, at + 1), { ...structuredClone(honest), n: at + 1 }],
  };
  for (const [what, entries] of Object.entries(broken)) {
    await assert.rejects(replayLog(entries, { hub: hub.did }), (err) => err.code === 'log_invalid', what);
  }
  await replayLog(log, { hub: hub.did });
});
