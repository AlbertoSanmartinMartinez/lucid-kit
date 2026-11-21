// SPDX-License-Identifier: Apache-2.0
// Instances: several running copies of one agent, each with its own key.
//
// An agent is a logical identity: its did:key, its card, whoever delegates to
// it. An instance is one process or device acting as that agent. Each instance
// generates its own Ed25519 key, and the agent signs a certificate for it:
// "this key acts as me, until this date". The instance then signs its requests
// and its events with its own key and shows the certificate.
//
// What this buys:
//   - The agent key does not have to be where the agent runs. It certifies
//     instances and can then stay somewhere safer.
//   - Losing one machine means removing one instance. The agent keeps its
//     identity, its topics and the other instances.
//   - A stolen instance key is worth something only until the certificate
//     expires, even against a hub that never learns of the removal.
//
// What it does not do: an instance holds no encryption key of the agent, so on
// its own it cannot read end-to-end encrypted content. That is what MLS is for,
// with every instance as a member of the group.

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { CONTEXT, createProof, isPlainObject, verifyProof } from './proof.mjs';
import { didFromPublicKeyBytes, isValidDid } from './didkey.mjs';

const DAY_MS = 86_400_000;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** How long after a certificate expires a receiver still accepts what was signed while it was valid: delivery can lag. */
export const INSTANCE_GRACE_MS = 7 * DAY_MS;

const hasExactKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const isTime = (value) => typeof value === 'string' && RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value));

const didOf = (privateKey) => didFromPublicKeyBytes(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url'));

// --- instance identities ---------------------------------------------------------------

/**
 * An instance identity is { did, instance: { did, privateKey }, certificate, encryption: null }.
 *   did          the agent it acts as; null until a certificate is attached.
 *   instance     the instance's own key, which signs everything it sends.
 *   certificate  the agent's signed statement that this key acts for it.
 */
export function generateInstanceIdentity() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { did: null, instance: { did: didOf(privateKey), privateKey }, certificate: null, encryption: null };
}

export const isInstanceIdentity = (identity) => Boolean(identity?.instance);

/** Stores the certificate in the identity. Throws if it was not issued to this instance key. */
export function attachCertificate(identity, envelope) {
  const problem = checkInstanceCertificate(envelope, { instance: identity.instance.did });
  if (problem) throw new Error(problem);
  identity.did = envelope.certificate.agent;
  identity.certificate = { certificate: envelope.certificate, proof: envelope.proof };
  return identity;
}

export function exportInstanceIdentity(identity) {
  return {
    agent: identity.did,
    instance: { did: identity.instance.did, private_key_jwk: identity.instance.privateKey.export({ format: 'jwk' }) },
    certificate: identity.certificate,
  };
}

export function importInstanceIdentity(data) {
  const privateKey = createPrivateKey({ key: data.instance.private_key_jwk, format: 'jwk' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('instance key must be Ed25519');
  const did = didOf(privateKey);
  if (data.instance.did && data.instance.did !== did) throw new Error('identity file is inconsistent: instance did does not match the key');
  const identity = { did: null, instance: { did, privateKey }, certificate: null, encryption: null };
  return data.certificate ? attachCertificate(identity, data.certificate) : identity;
}

// --- certificates ----------------------------------------------------------------------

/** The agent states that the key behind `instance` (a did:key) acts as it for `days` days. `name` is a public label. */
export function createInstanceCertificate(agent, { instance, name, days = 30, now = Date.now() }) {
  if (!(days > 0)) throw new Error('days must be positive');
  const certificate = {
    version: 1,
    agent: agent.did,
    instance,
    ...(name === undefined ? {} : { name }),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + days * DAY_MS).toISOString(),
  };
  const envelope = { certificate, proof: createProof(CONTEXT.INSTANCE, certificate, agent) };
  const problem = checkInstanceCertificate(envelope);
  if (problem) throw new Error(problem);
  return envelope;
}

/**
 * Returns an error message, or null if the envelope is a certificate the named agent really signed
 * (for `agent` and `instance`, when given). Dates are checked by verifyInstanceCertificate().
 */
export function checkInstanceCertificate(envelope, { agent, instance } = {}) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.certificate)) return 'instance certificate is malformed';
  const { certificate, proof } = envelope;
  const { name, ...required } = certificate;
  if (!hasExactKeys(required, ['version', 'agent', 'instance', 'issued_at', 'expires_at'])) return 'instance certificate has missing or unexpected fields';
  if (certificate.version !== 1) return 'unsupported instance certificate version';
  if (!isValidDid(certificate.agent) || !isValidDid(certificate.instance)) return 'instance certificate must name an agent and an instance by did:key';
  if (certificate.agent === certificate.instance) return 'an agent key cannot be an instance of itself';
  if (Object.hasOwn(certificate, 'name') && (typeof name !== 'string' || name.trim().length < 1 || name.length > 80)) return 'instance name must be 1-80 characters';
  if (!isTime(certificate.issued_at) || !isTime(certificate.expires_at)) return 'instance certificate dates must be UTC RFC 3339 timestamps';
  if (Date.parse(certificate.expires_at) <= Date.parse(certificate.issued_at)) return 'instance certificate expires before it is issued';
  if (agent !== undefined && certificate.agent !== agent) return 'instance certificate was issued by a different agent';
  if (instance !== undefined && certificate.instance !== instance) return 'instance certificate was issued to a different key';
  if (!isPlainObject(proof) || proof.key_id !== certificate.agent) return 'instance certificate is not signed by the agent it names';
  const verdict = verifyProof(CONTEXT.INSTANCE, certificate, proof);
  return verdict.ok ? null : `instance certificate signature rejected: ${verdict.error}`;
}

/**
 * Checks the certificate and its dates. Returns { ok: true } or { ok: false, error }. Never throws.
 *
 *   at       the moment the instance claims to have signed (an event's `time`); defaults to `now`.
 *            It must fall inside the certificate's validity.
 *   graceMs  how long after expiry something signed in time is still accepted. A hub checking a live
 *            request passes 0. A receiver reading its inbox allows for delivery lag; the grace is what
 *            bounds a stolen key against a hub that keeps relaying for it.
 *   maxValidityMs  rejects certificates that outlive what the verifier is willing to honour.
 */
export function verifyInstanceCertificate(envelope, { agent, instance, at, now = Date.now(), graceMs = 0, clockSkewMs = 60_000, maxValidityMs = Infinity } = {}) {
  const problem = checkInstanceCertificate(envelope, { agent, instance });
  if (problem) return { ok: false, error: problem };
  const issued = Date.parse(envelope.certificate.issued_at);
  const expires = Date.parse(envelope.certificate.expires_at);
  const signedAt = at ?? now;
  if (expires - issued > maxValidityMs) return { ok: false, error: `instance certificate is valid for longer than the ${Math.round(maxValidityMs / DAY_MS)} days allowed` };
  if (!Number.isFinite(signedAt) || signedAt < issued - clockSkewMs) return { ok: false, error: 'signed before the instance certificate was issued' };
  if (signedAt > expires) return { ok: false, error: 'instance certificate has expired' };
  if (now > expires + graceMs) return { ok: false, error: 'instance certificate has expired' };
  return { ok: true };
}
