// SPDX-License-Identifier: Apache-2.0
// Signed events and agent cards.
//
// Both travel as { <payload>, proof } (see proof.mjs). An event is signed either
// with the agent key itself, or with the key of one of its instances, in which
// case the proof carries the certificate that ties that key to the agent.

import { CONTEXT, createProof, isPlainObject, verifyProof } from './proof.mjs';
import { verifyInstanceCertificate } from './instance.mjs';

export { CONTEXT, createProof, verifyProof } from './proof.mjs';

/**
 * Signs a CloudEvent whose `source` is the agent's DID. `identity` is the agent's own identity,
 * or an instance identity: then the instance key signs and its certificate goes in the proof.
 */
export function signEvent(event, identity) {
  const clean = JSON.parse(JSON.stringify(event)); // sign exactly what will travel as JSON
  if (clean.source !== identity.did) throw new Error('event.source must be the signer DID');
  if (!identity.instance) return { event: clean, proof: createProof(CONTEXT.EVENT, clean, identity) };
  if (!identity.certificate) throw new Error('this instance has no certificate from its agent yet');
  return { event: clean, proof: { ...createProof(CONTEXT.EVENT, clean, identity.instance), certificate: identity.certificate } };
}

/**
 * Returns { ok: true, did } - `did` being the agent in `event.source`, cryptographically verified -
 * or { ok: false, error }. For an event signed by an instance the result also carries `instance`.
 * `now` and `graceMs` only matter for instance certificates (see verifyInstanceCertificate).
 */
export function verifyEventEnvelope(envelope, { now = Date.now(), graceMs = 0 } = {}) {
  if (!isPlainObject(envelope)) return { ok: false, error: 'envelope must be an object' };
  const result = verifyProof(CONTEXT.EVENT, envelope.event, envelope.proof);
  if (!result.ok) return result;
  const { event, proof } = envelope;
  if (proof.certificate === undefined) {
    if (event.source !== result.did) return { ok: false, error: 'event.source is not the signer' };
    return result;
  }
  // Signed by an instance key: only the agent's certificate makes that key speak for `event.source`.
  const verdict = verifyInstanceCertificate(proof.certificate, { agent: event.source, instance: proof.key_id, at: Date.parse(event.time), now, graceMs });
  if (!verdict.ok) return { ok: false, error: `event.source is not the signer, and its certificate does not cover it: ${verdict.error}` };
  return { ok: true, did: event.source, instance: proof.key_id };
}

export function signCard(card, identity) {
  const clean = JSON.parse(JSON.stringify(card));
  if (clean.did !== identity.did) throw new Error('card.did must be the signer DID');
  if (identity.instance) throw new Error('an agent card is signed with the agent key, not by an instance');
  return { card: clean, proof: createProof(CONTEXT.CARD, clean, identity) };
}

export function verifyCardEnvelope(envelope) {
  if (!isPlainObject(envelope)) return { ok: false, error: 'card envelope must be an object' };
  const result = verifyProof(CONTEXT.CARD, envelope.card, envelope.proof);
  if (!result.ok) return result;
  if (envelope.card.did !== result.did) return { ok: false, error: 'card.did is not the signer' };
  return result;
}
