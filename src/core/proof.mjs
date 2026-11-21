// SPDX-License-Identifier: Apache-2.0
// Detached proofs over JSON documents.
//
// A signed document travels as { <payload>, proof }. The signature covers
//   <context> "\n" JCS(<payload>)
// where <context> is a domain-separation string, so a signature made for one
// purpose (an event) can never be replayed as another (an agent card).
// The proof lives *outside* the signed payload, so there is no ambiguity about
// which bytes are signed.

import { sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalize } from './jcs.mjs';
import { publicKeyFromDid } from './didkey.mjs';

export const CONTEXT = Object.freeze({
  EVENT: 'agenthub/event/v1',
  CARD: 'agenthub/agent-card/v1',
  DELEGATION: 'agenthub/delegation/v1',
  REVOCATION: 'agenthub/revocation/v1',
  TOPIC_GRANT: 'agenthub/topic-grant/v1',
  INSTANCE: 'agenthub/instance/v1',
  FEDERATION_HELLO: 'agenthub/federation-hello/v1',
  LOG_CHECKPOINT: 'agenthub/log-checkpoint/v1',
  TOPIC: 'agenthub/topic/v1',
  TOPIC_POLICY: 'agenthub/topic-policy/v1',
  INSTANCE_REMOVAL: 'agenthub/instance-removal/v1',
  RETIREMENT: 'agenthub/retirement/v1',
  DELEGATION_DROP: 'agenthub/delegation-drop/v1',
  ACCOUNT_ATTESTATION: 'agenthub/account-attestation/v1',
  VERIFICATION_REQUEST: 'agenthub/verification-request/v1',
  CONTROL_PROOF: 'agenthub/control-proof/v1',
  GUARDIAN: 'agenthub/guardian/v1',
  SUCCESSION: 'agenthub/succession/v1',
  SUCCESSION_ACCEPTANCE: 'agenthub/succession-acceptance/v1',
});

const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/; // 64 bytes, base64url, no padding
const PROOF_KEYS = ['algorithm', 'canonicalization', 'context', 'key_id', 'signature'];

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether `proof` carries what a proof is made of and nothing else. A proof is checked in the
 * fields that are used: whatever else rides in it is signed by nobody. Where a proof is kept for
 * good and shown to everybody - in the transparency log of a hub - that is asked for.
 */
export function isBareProof(proof) {
  return isPlainObject(proof) && Object.keys(proof).every((key) => PROOF_KEYS.includes(key));
}

function signingInput(context, payload) {
  return Buffer.from(`${context}\n${canonicalize(payload)}`, 'utf8');
}

/** `keyId` defaults to the signer's did:key; a did:web controller names one of its document keys instead. */
export function createProof(context, payload, identity, keyId = identity.did) {
  const signature = edSign(null, signingInput(context, payload), identity.privateKey);
  return {
    algorithm: 'Ed25519',
    canonicalization: 'JCS',
    context,
    key_id: keyId,
    signature: signature.toString('base64url'),
  };
}

/**
 * Returns { ok: true, did } or { ok: false, error }. Never throws.
 * The key is derived from `proof.key_id` (a did:key) unless `publicKey` is given,
 * which is how proofs made with a did:web document key are checked.
 */
export function verifyProof(context, payload, proof, publicKey = null) {
  try {
    if (!isPlainObject(payload)) return { ok: false, error: 'payload must be an object' };
    if (!isPlainObject(proof)) return { ok: false, error: 'proof must be an object' };
    if (proof.algorithm !== 'Ed25519') return { ok: false, error: 'unsupported proof algorithm' };
    if (proof.canonicalization !== 'JCS') return { ok: false, error: 'unsupported canonicalization' };
    if (proof.context !== context) return { ok: false, error: 'proof was made for a different context' };
    if (typeof proof.signature !== 'string' || !SIGNATURE_RE.test(proof.signature)) {
      return { ok: false, error: 'malformed signature' };
    }
    if (typeof proof.key_id !== 'string' || proof.key_id.length > 300) return { ok: false, error: 'malformed key_id' };
    const key = publicKey ?? publicKeyFromDid(proof.key_id);
    const valid = edVerify(null, signingInput(context, payload), key, Buffer.from(proof.signature, 'base64url'));
    return valid ? { ok: true, did: proof.key_id } : { ok: false, error: 'signature does not match' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
