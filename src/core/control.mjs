// SPDX-License-Identifier: Apache-2.0
// Proof of control: a controller shows a service that it holds its key now.
//
// The service hands out a code, fresh and for one use; the controller signs it, with the address of the
// service it is for, with its key - its own did:key, or a key that the DID document of its did:web lists,
// the way an organization signs delegations. The service checks the signature, that the address is its
// own and that the code is one it handed out and has not seen back. It is how the console of the hosted
// service lets whoever holds the key of an organization's domain administer that organization there.
//
// What it says: whoever signed holds that key at that moment. Nothing more: not who they are, and not for
// how long they will hold it.

import { CONTEXT, isPlainObject } from './proof.mjs';
import { createProof } from './proof.mjs';
import { isValidDid } from './didkey.mjs';
import { isDidWeb } from './didweb.mjs';
import { originOf } from './reqsig.mjs';
import { proofKeyId, verifyIssuerProof } from './delegation.mjs';

const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const KEYS = ['version', 'issuer', 'audience', 'code', 'at'];
const hasExactKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));

/** `controller` signs `code` for the service at `audience`, as `issuer` (its did:key, or a did:web with `keyId`). */
export function proveControl(controller, { audience, code, issuer = controller.did, keyId, now = Date.now() }) {
  const origin = originOf(audience);
  if (origin === null) throw new TypeError('a proof of control is for the http(s) address of a service');
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new TypeError('the code is the one the service handed out');
  const control = { version: 1, issuer, audience: origin, code, at: new Date(now).toISOString() };
  return { control, proof: createProof(CONTEXT.CONTROL_PROOF, control, controller, proofKeyId(controller, issuer, keyId)) };
}

/**
 * Checks a proof of control for a service whose addresses are `origins`: shape, freshness (`maxAgeMs`) and
 * the signature of its issuer, through `resolveDidWeb` for a did:web. Whether the code is one the service
 * handed out, and unused, is for the service. Resolves to { ok, issuer, code } or { ok: false, error }.
 */
export async function verifyControl(envelope, { origins, resolveDidWeb = null, now = Date.now(), maxAgeMs = 10 * 60_000 }) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.control)) return { ok: false, error: 'a proof of control comes as { control, proof }' };
  const { control, proof } = envelope;
  if (!hasExactKeys(control, KEYS) || control.version !== 1) return { ok: false, error: 'a proof of control has exactly the fields version, issuer, audience, code and at' };
  if (typeof control.issuer !== 'string' || !(isValidDid(control.issuer) || isDidWeb(control.issuer))) return { ok: false, error: 'issuer must be a did:key or a did:web' };
  if (typeof control.code !== 'string' || !CODE_RE.test(control.code)) return { ok: false, error: 'malformed code' };
  if (typeof control.at !== 'string' || !RFC3339_RE.test(control.at) || Number.isNaN(Date.parse(control.at))) return { ok: false, error: 'at must be a UTC RFC 3339 timestamp' };
  if (!origins.includes(control.audience)) return { ok: false, error: 'it is for another service' };
  if (Math.abs(now - Date.parse(control.at)) > maxAgeMs) return { ok: false, error: 'it is too old, or from the future' };
  const verdict = await verifyIssuerProof(CONTEXT.CONTROL_PROOF, control, proof, control.issuer, resolveDidWeb);
  if (!verdict.ok) return verdict;
  return { ok: true, issuer: control.issuer, code: control.code, kind: verdict.kind };
}
