// SPDX-License-Identifier: Apache-2.0
// did:key identifiers for Ed25519 keys.
//
// did:key:z<base58btc(0xed 0x01 || 32-byte public key)>
// The identifier *is* the public key, so anyone can verify a signature
// without asking the hub (or anyone else) for key material.

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { exportEncryptionKey, generateEncryptionKey, importEncryptionKey, MAX_PREVIOUS_KEYS } from './e2e.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]));
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export function base58Encode(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = buf.length > 0 ? BigInt('0x' + buf.toString('hex')) : 0n;
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(str) {
  if (typeof str !== 'string' || str.length > 128) throw new Error('invalid base58 string');
  let n = 0n;
  for (const char of str) {
    const digit = ALPHABET_MAP.get(char);
    if (digit === undefined) throw new Error('invalid base58 character');
    n = n * 58n + digit;
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

export function didFromPublicKeyBytes(raw) {
  if (raw.length !== 32) throw new Error('Ed25519 public keys are 32 bytes');
  return 'did:key:z' + base58Encode(Buffer.concat([ED25519_MULTICODEC, Buffer.from(raw)]));
}

/** Returns the raw 32-byte public key, or throws if the DID is not a canonical Ed25519 did:key. */
export function publicKeyBytesFromDid(did) {
  if (typeof did !== 'string' || !DID_RE.test(did)) throw new Error('not an Ed25519 did:key');
  const decoded = base58Decode(did.slice('did:key:z'.length));
  if (decoded.length !== 34 || !decoded.subarray(0, 2).equals(ED25519_MULTICODEC)) {
    throw new Error('not an Ed25519 did:key');
  }
  const raw = decoded.subarray(2);
  // Reject non-canonical encodings so one key has exactly one identifier.
  if (didFromPublicKeyBytes(raw) !== did) throw new Error('non-canonical did:key');
  return raw;
}

export function isValidDid(did) {
  try {
    publicKeyBytesFromDid(did);
    return true;
  } catch {
    return false;
  }
}

export function publicKeyFromDid(did) {
  const raw = publicKeyBytesFromDid(did);
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

function didFromKeyObject(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return didFromPublicKeyBytes(Buffer.from(jwk.x, 'base64url'));
}

/**
 * An identity is { did, privateKey, encryption }.
 *   privateKey  Ed25519, signs everything the agent says; the DID is its public half.
 *   encryption  { current, previous[] } X25519 keys that direct messages are sealed to.
 * Private keys never leave the process that owns them.
 */
export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { did: didFromKeyObject(publicKey), privateKey, encryption: { current: generateEncryptionKey(), previous: [] } };
}

/** Gives an identity created before encryption existed its encryption keys. Returns true if it changed. */
export function ensureEncryptionKeys(identity) {
  if (identity.encryption?.current) return false;
  identity.encryption = { current: generateEncryptionKey(), previous: [] };
  return true;
}

/** Replaces the current encryption key, keeping the last few so in-flight messages still open. */
export function rotateEncryptionKey(identity) {
  ensureEncryptionKeys(identity);
  const { current, previous } = identity.encryption;
  identity.encryption = { current: generateEncryptionKey(), previous: [current, ...previous].slice(0, MAX_PREVIOUS_KEYS) };
  return identity.encryption.current;
}

export function exportIdentity(identity) {
  const data = { did: identity.did, private_key_jwk: identity.privateKey.export({ format: 'jwk' }) };
  if (identity.encryption?.current) {
    data.encryption = {
      current: exportEncryptionKey(identity.encryption.current),
      previous: identity.encryption.previous.map(exportEncryptionKey),
    };
  }
  return data;
}

export function importIdentity(data) {
  const privateKey = createPrivateKey({ key: data.private_key_jwk, format: 'jwk' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('identity key must be Ed25519');
  const did = didFromKeyObject(createPublicKey(privateKey));
  if (data.did && data.did !== did) throw new Error('identity file is inconsistent: did does not match the key');
  const encryption = data.encryption
    ? { current: importEncryptionKey(data.encryption.current), previous: (data.encryption.previous ?? []).map(importEncryptionKey) }
    : null;
  return { did, privateKey, encryption };
}
