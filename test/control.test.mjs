// SPDX-License-Identifier: Apache-2.0
// Proof of control: whoever holds the key of a controller - its did:key, or a key of its did:web - shows a
// service, at that service's address, with a code the service handed out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { proveControl, verifyControl } from '../src/core/control.mjs';
import { createDidWebResolver, didWebDocument } from '../src/core/didweb.mjs';
import { CONTEXT, createProof } from '../src/core/proof.mjs';
import { generateIdentity } from '../src/sdk/index.mjs';

const SERVICE = 'https://console.example.com';
const CODE = 'c'.repeat(24);
const ACME = 'did:web:acme.com';

test('a controller proves it holds its key, as a did:key or as a did:web, to one service', async () => {
  const org = generateIdentity();
  const resolveDidWeb = createDidWebResolver({ fetchDocument: async (url) => (url === 'https://acme.com/.well-known/did.json' ? didWebDocument(ACME, org.did) : Promise.reject(new Error('404'))) });
  const options = { origins: [SERVICE], resolveDidWeb };

  const own = await verifyControl(proveControl(org, { audience: `${SERVICE}/claims`, code: CODE }), options);
  assert.deepEqual(own, { ok: true, issuer: org.did, code: CODE, kind: 'key' });
  const web = await verifyControl(proveControl(org, { audience: SERVICE, code: CODE, issuer: ACME, keyId: 'key-1' }), options);
  assert.deepEqual(web, { ok: true, issuer: ACME, code: CODE, kind: 'web' });

  const mallory = generateIdentity();
  const good = proveControl(org, { audience: SERVICE, code: CODE, issuer: ACME });
  const resigned = (change, signer = org, keyId = `${ACME}#key-1`) => {
    const control = { ...good.control, ...change };
    return { control, proof: createProof(CONTEXT.CONTROL_PROOF, control, signer, keyId) };
  };
  const refused = {
    'a key the domain does not list': proveControl(mallory, { audience: SERVICE, code: CODE, issuer: ACME }),
    'another domain, same signature': { control: { ...good.control, issuer: 'did:web:other.com' }, proof: good.proof },
    'another code, same signature': { control: { ...good.control, code: 'd'.repeat(24) }, proof: good.proof },
    'for another service': resigned({ audience: 'https://evil.example.com' }),
    'too old': resigned({ at: new Date(Date.now() - 11 * 60_000).toISOString() }),
    'signed for something else': { control: good.control, proof: createProof(CONTEXT.DELEGATION, good.control, org, `${ACME}#key-1`) },
    'with a field more': resigned({ role: 'admin' }),
  };
  for (const [what, envelope] of Object.entries(refused)) assert.equal((await verifyControl(envelope, options)).ok, false, what);
  assert.throws(() => proveControl(org, { audience: 'ftp://x', code: CODE }), /http/);
  assert.throws(() => proveControl(org, { audience: SERVICE, code: 'short' }), /code/);
});
