// SPDX-License-Identifier: Apache-2.0
// End-to-end encryption of direct messages.
//
// Every agent owns an X25519 key pair besides its Ed25519 identity key. The
// public half travels in the agent card, which the agent signs, so the hub
// cannot swap it for a key of its own. A sender seals { type, data } to that
// key with HPKE and puts the result in the `data` of an ordinary signed event:
// the hub still sees who writes to whom (it needs that to apply limits), but
// not what is said - not even the real event type.
//
// The ciphertext is bound (as AEAD associated data) to the sender, the
// recipient and the event id. Nobody can lift a ciphertext into an envelope
// of their own and pass the content off as theirs.

import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { open, seal, x25519RawPublicKey } from './hpke.mjs';

export const DIRECT_ENCRYPTION = 'hpke-v1';
export const DIRECT_ALG = 'HPKE-X25519-SHA256-CHACHA20POLY1305';
export const ENCRYPTED_EVENT_TYPE = 'agenthub.encrypted';
export const MAX_PREVIOUS_KEYS = 2;

const INFO = Buffer.from('agenthub/dm/v1');
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[A-Za-z0-9_-]{11}$/; // 8 bytes
const PUBLIC_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes

const keyIdOf = (publicRaw) => createHash('sha256').update(publicRaw).digest().subarray(0, 8).toString('base64url');
const associatedData = (source, recipient, id) => Buffer.from(`${source}\n${recipient}\n${id}`, 'utf8');

function fromPrivateKey(privateKey) {
  const raw = x25519RawPublicKey(privateKey);
  return { kid: keyIdOf(raw), public: raw.toString('base64url'), privateKey };
}

/** An encryption key is { kid, public, privateKey }; only { alg, kid, public } is ever published. */
export function generateEncryptionKey() {
  return fromPrivateKey(generateKeyPairSync('x25519').privateKey);
}

export const exportEncryptionKey = (key) => ({ private_key_jwk: key.privateKey.export({ format: 'jwk' }) });
export const importEncryptionKey = (data) => fromPrivateKey(createPrivateKey({ key: data.private_key_jwk, format: 'jwk' }));

/** The entry an agent publishes in its card. */
export const publicEncryptionKey = (key) => ({ alg: 'X25519', kid: key.kid, public: key.public });

/** Returns an error message, or null if `value` is a well-formed published encryption key. */
export function checkPublicEncryptionKey(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'encryption_key must be an object';
  if (value.alg !== 'X25519') return 'encryption_key.alg must be "X25519"';
  if (typeof value.public !== 'string' || !PUBLIC_RE.test(value.public)) return 'encryption_key.public must be 32 bytes in base64url';
  if (value.kid !== keyIdOf(Buffer.from(value.public, 'base64url'))) return 'encryption_key.kid does not match the key';
  if (Object.keys(value).length !== 3) return 'encryption_key has unexpected fields';
  return null;
}

/** Returns an error message, or null if `data` has the shape of an encrypted direct-message payload. */
export function checkSealedShape(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'encrypted data must be an object';
  if (data.alg !== DIRECT_ALG) return `encrypted data.alg must be "${DIRECT_ALG}"`;
  if (typeof data.kid !== 'string' || !KID_RE.test(data.kid)) return 'encrypted data.kid is malformed';
  if (typeof data.enc !== 'string' || !PUBLIC_RE.test(data.enc)) return 'encrypted data.enc is malformed';
  if (typeof data.ct !== 'string' || data.ct.length < 22 || !B64URL_RE.test(data.ct)) return 'encrypted data.ct is malformed';
  if (Object.keys(data).length !== 4) return 'encrypted data has unexpected fields';
  return null;
}

/** Seals `payload` (any JSON value) so that only `recipientKey`'s owner can read it. */
export function encryptDirect({ recipientKey, source, recipient, id, payload }) {
  const problem = checkPublicEncryptionKey(recipientKey);
  if (problem) throw new Error(problem);
  const { enc, ciphertext } = seal({
    recipientPublicKey: Buffer.from(recipientKey.public, 'base64url'),
    info: INFO,
    aad: associatedData(source, recipient, id),
    plaintext: Buffer.from(JSON.stringify(payload), 'utf8'),
  });
  return { alg: DIRECT_ALG, kid: recipientKey.kid, enc: enc.toString('base64url'), ct: ciphertext.toString('base64url') };
}

/** Opens what encryptDirect() produced, using whichever of `keys` it was sealed to. Throws on any mismatch. */
export function decryptDirect({ keys, source, recipient, id, data }) {
  const problem = checkSealedShape(data);
  if (problem) throw new Error(problem);
  const key = keys.find((candidate) => candidate.kid === data.kid);
  if (!key) throw new Error('sealed to a key this agent no longer holds');
  const plaintext = open({
    recipientPrivateKey: key.privateKey,
    enc: Buffer.from(data.enc, 'base64url'),
    info: INFO,
    aad: associatedData(source, recipient, id),
    ciphertext: Buffer.from(data.ct, 'base64url'),
  });
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
}
