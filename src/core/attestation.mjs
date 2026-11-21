// SPDX-License-Identifier: Apache-2.0
// Account attestations: how a hub learns that a controller is a verified account without asking anyone.
//
// A verifier - a small service that the operator of a hub trusts, such as one that signs people in with
// GitHub - checks that whoever holds a controller key also holds an account somewhere, and signs:
// "the controller did:key:... is the account ref:..., until this date". Anybody can hand
// that to a hub: the hub checks that it is signed by a verifier its operator named, and from then on
// the agents that controller delegates are of tier "account". The hub talks to no provider, and keeps
// on record, in its transparency log, who vouched for whom.
//
// What it says and what it does not:
//   - The verifier vouches that the controller key and the account are the same person's. The hub and
//     the readers of its log can check that the verifier signed it; whether that verifier is worth
//     trusting is the operator's choice (`trustedVerifiers`), and readers can make their own.
//   - `account` does not say which account: it is a reference ("ref:..."), an HMAC of the account
//     ("github:1234") under a secret of the verifier (`accountReference`). Attestations end up in a
//     transparency log, which is public and is never erased: with the account in the clear, anybody
//     could tie a controller key to a person for good. With the reference, only whoever holds the secret
//     - the verifier, and the console of the service that runs it - can. The reference is the same for
//     the same account every time, so the agents of one account still add up, for quotas and for the
//     console. It is pseudonymous, not anonymous: whoever holds the secret can tie it back.
//   - It runs out: an account can be closed or change hands. A verifier signs one for 90 days at most.

import { createHmac, randomBytes } from 'node:crypto';
import { CONTEXT, createProof, isPlainObject, verifyProof } from './proof.mjs';
import { isValidDid } from './didkey.mjs';
import { originOf } from './reqsig.mjs';

const DAY_MS = 86_400_000;
export const MAX_ATTESTATION_DAYS = 90;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const REFERENCE_RE = /^ref:[A-Za-z0-9_-]{43}$/; // an HMAC-SHA256, base64url
const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,19}:[A-Za-z0-9._-]{1,100}$/; // provider:stable id, as in "github:1234"
const KEYS = ['version', 'verifier', 'controller', 'account', 'issued_at', 'expires_at'];

/**
 * The reference an attestation carries for `account` ("github:1234"): the same for the same account and
 * secret, and nothing that says which account it is to whoever does not hold the secret (32 bytes or more).
 */
export function accountReference(secret, account) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new TypeError('the secret of account references is 32 bytes or more');
  if (typeof account !== 'string' || !ACCOUNT_RE.test(account)) throw new TypeError('an account is "provider:id", as in "github:1234"');
  return `ref:${createHmac('sha256', secret).update(`agenthub/account-reference/v1\n${account}`).digest('base64url')}`;
}
export const isAccountReference = (value) => typeof value === 'string' && REFERENCE_RE.test(value);
const isTime = (value) => typeof value === 'string' && RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value));
const hasExactKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));

/** What a verifier signs: that `controller` is the account with the reference `account` (accountReference), for `days` days. */
export function createAttestation(verifier, { controller, account, days = 30, now = Date.now() }) {
  if (!Number.isFinite(days) || days <= 0 || days > MAX_ATTESTATION_DAYS) throw new RangeError(`an attestation lasts more than 0 and at most ${MAX_ATTESTATION_DAYS} days`);
  const attestation = {
    version: 1,
    verifier: verifier.did,
    controller,
    account,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + days * DAY_MS).toISOString(),
  };
  const problem = checkShape(attestation);
  if (problem) throw new TypeError(problem);
  return { attestation, proof: createProof(CONTEXT.ACCOUNT_ATTESTATION, attestation, verifier) };
}

function checkShape(attestation) {
  if (!isPlainObject(attestation) || !hasExactKeys(attestation, KEYS)) return 'an attestation has exactly the fields version, verifier, controller, account, issued_at and expires_at';
  if (attestation.version !== 1) return 'unsupported attestation version';
  if (!isValidDid(attestation.verifier)) return 'verifier must be a did:key';
  if (!isValidDid(attestation.controller)) return 'controller must be a did:key: an organization is verified by its domain, not by an attestation';
  if (!isAccountReference(attestation.account)) return 'account must be a reference to it ("ref:..."), never the account itself: an attestation goes on a public record';
  if (!isTime(attestation.issued_at) || !isTime(attestation.expires_at)) return 'issued_at and expires_at must be UTC RFC 3339 timestamps';
  const lasts = Date.parse(attestation.expires_at) - Date.parse(attestation.issued_at);
  if (lasts <= 0 || lasts > MAX_ATTESTATION_DAYS * DAY_MS) return `an attestation lasts more than 0 and at most ${MAX_ATTESTATION_DAYS} days`;
  return null;
}

/**
 * Checks the shape of an attestation and the signature of the verifier it names. Whether it is still in
 * force, and whether that verifier is trusted, is for whoever checks it to decide: they depend on its
 * clock and its choice. Returns { ok, verifier, controller, account, issued_at, expires_at } or { ok: false, error }.
 */
export function verifyAttestation(envelope) {
  if (!isPlainObject(envelope)) return { ok: false, error: 'an attestation comes as { attestation, proof }' };
  const { attestation, proof } = envelope;
  const problem = checkShape(attestation);
  if (problem) return { ok: false, error: problem };
  const verdict = verifyProof(CONTEXT.ACCOUNT_ATTESTATION, attestation, proof);
  if (!verdict.ok) return { ok: false, error: `signature rejected: ${verdict.error}` };
  if (verdict.did !== attestation.verifier) return { ok: false, error: 'the attestation is not signed by the verifier it names' };
  const { verifier, controller, account, issued_at: issuedAt, expires_at: expiresAt } = attestation;
  return { ok: true, verifier, controller, account, issued_at: issuedAt, expires_at: expiresAt };
}

// ------------------------------------------------------------------------------ asking a verifier

// To ask a verifier for an attestation, a controller signs a request with its key: that is what ties
// the account that signs in afterwards to that key. The request names the address of the verifier it
// is for, as requests to a hub do (reqsig.mjs), and is good for a few minutes and once.

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const REQUEST_KEYS = ['version', 'controller', 'verifier', 'nonce', 'at'];

/** The request of `controller` (its identity) to the verifier at `verifierUrl`. */
export function createVerificationRequest(controller, { verifierUrl, now = Date.now() }) {
  const verifier = originOf(verifierUrl);
  if (verifier === null) throw new TypeError('a verifier is asked at an http(s) address');
  const request = { version: 1, controller: controller.did, verifier, nonce: randomBytes(16).toString('base64url'), at: new Date(now).toISOString() };
  return { request, proof: createProof(CONTEXT.VERIFICATION_REQUEST, request, controller) };
}

/**
 * Checks a request for a verifier whose addresses are `origins`: signed by the controller it names, for
 * one of them, and made within `maxAgeMs`. Whether its nonce was used before is for the verifier to keep.
 */
export function verifyVerificationRequest(envelope, { origins, now = Date.now(), maxAgeMs = 5 * 60_000 }) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.request)) return { ok: false, error: 'a request comes as { request, proof }' };
  const { request, proof } = envelope;
  if (!hasExactKeys(request, REQUEST_KEYS) || request.version !== 1) return { ok: false, error: 'a request has exactly the fields version, controller, verifier, nonce and at' };
  if (!isValidDid(request.controller)) return { ok: false, error: 'controller must be a did:key' };
  if (typeof request.nonce !== 'string' || !NONCE_RE.test(request.nonce)) return { ok: false, error: 'nonce must be 16 to 64 base64url characters' };
  if (!isTime(request.at)) return { ok: false, error: 'at must be a UTC RFC 3339 timestamp' };
  const verdict = verifyProof(CONTEXT.VERIFICATION_REQUEST, request, proof);
  if (!verdict.ok) return { ok: false, error: `signature rejected: ${verdict.error}` };
  if (verdict.did !== request.controller) return { ok: false, error: 'the request is not signed by the controller it names' };
  if (!origins.includes(request.verifier)) return { ok: false, error: 'the request is for another verifier', wrongVerifier: true };
  if (Math.abs(now - Date.parse(request.at)) > maxAgeMs) return { ok: false, error: 'the request is too old, or from the future' };
  return { ok: true, controller: request.controller, nonce: request.nonce };
}

