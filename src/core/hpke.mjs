// SPDX-License-Identifier: Apache-2.0
// HPKE - Hybrid Public Key Encryption (RFC 9180), base mode, single-shot.
//
// Suite: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305.
// This is the public-key encryption building block that MLS itself uses, built
// here on node:crypto primitives only (X25519, HMAC-SHA256, the AEAD ciphers).
// AES-128-GCM is also wired in because the RFC's first test vector uses it.
//
// What it gives: only the holder of the recipient's private key can read the
// message, and each message uses a fresh ephemeral key. What it does not give:
// forward secrecy against a later compromise of the *recipient's* key. That
// needs a ratcheting protocol (MLS), which is the planned replacement.

import { createCipheriv, createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';

const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEADS = {
  'chacha20-poly1305': { id: 0x0003, keyLength: 32, cipher: 'chacha20-poly1305' },
  'aes-128-gcm': { id: 0x0001, keyLength: 16, cipher: 'aes-128-gcm' },
};
const HASH_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const EMPTY = Buffer.alloc(0);
const HPKE_V1 = Buffer.from('HPKE-v1');

const i2osp = (value, length) => {
  const out = Buffer.alloc(length);
  out.writeUIntBE(value, 0, length);
  return out;
};
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(KEM_ID, 2)]);
const hpkeSuite = (aead) => Buffer.concat([Buffer.from('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead.id, 2)]);

// --- HKDF-SHA256, with the labels RFC 9180 adds --------------------------------

const extract = (salt, ikm) => createHmac('sha256', salt.length > 0 ? salt : Buffer.alloc(HASH_LENGTH)).update(ikm).digest();

function expand(prk, info, length) {
  const blocks = [];
  let previous = EMPTY;
  for (let counter = 1; blocks.length * HASH_LENGTH < length; counter++) {
    previous = createHmac('sha256', prk).update(previous).update(info).update(Buffer.from([counter])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const labeledExtract = (suite, salt, label, ikm) => extract(salt, Buffer.concat([HPKE_V1, suite, Buffer.from(label), ikm]));
const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, Buffer.concat([i2osp(length, 2), HPKE_V1, suite, Buffer.from(label), info]), length);

// --- X25519 --------------------------------------------------------------------

export function x25519PublicKeyFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('X25519 public keys are 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

export function x25519RawPublicKey(key) {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
}

function dh(privateKey, peerRaw) {
  // RFC 9180 7.1.4: an all-zero output means the peer sent a low-order point.
  // OpenSSL already refuses to derive in that case; the explicit check covers builds that do not.
  let secret;
  try {
    secret = diffieHellman({ privateKey, publicKey: x25519PublicKeyFromRaw(peerRaw) });
  } catch {
    throw new Error('HPKE: invalid public key');
  }
  if (secret.every((byte) => byte === 0)) throw new Error('HPKE: invalid public key');
  return secret;
}

// --- KEM and key schedule --------------------------------------------------------

function kemSharedSecret(dhOutput, enc, recipientRaw) {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dhOutput);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', Buffer.concat([enc, recipientRaw]), 32);
}

function keySchedule(aead, sharedSecret, info) {
  const suite = hpkeSuite(aead);
  const pskIdHash = labeledExtract(suite, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, 'info_hash', info);
  const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]); // 0x00 = mode_base
  const secret = labeledExtract(suite, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(suite, secret, 'key', context, aead.keyLength),
    nonce: labeledExpand(suite, secret, 'base_nonce', context, NONCE_LENGTH), // sequence number 0
  };
}

function suiteFor(name) {
  const aead = AEADS[name];
  if (!aead) throw new Error(`HPKE: unsupported AEAD ${name}`);
  return aead;
}

/**
 * Encrypts `plaintext` to the holder of `recipientPublicKey` (raw 32 bytes).
 * `info` binds the ciphertext to an application context and `aad` is
 * authenticated but not encrypted. Returns { enc, ciphertext }.
 * `ephemeral` exists only so tests can reproduce the RFC vectors.
 */
export function seal({ recipientPublicKey, info = EMPTY, aad = EMPTY, plaintext, aead = 'chacha20-poly1305', ephemeral }) {
  const suite = suiteFor(aead);
  const { privateKey, publicKey } = ephemeral ?? generateKeyPairSync('x25519');
  const enc = x25519RawPublicKey(publicKey);
  const sharedSecret = kemSharedSecret(dh(privateKey, recipientPublicKey), enc, recipientPublicKey);
  const { key, nonce } = keySchedule(suite, sharedSecret, info);
  const cipher = createCipheriv(suite.cipher, key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { enc, ciphertext };
}

/** Reverses seal(). Throws if the key, info, aad or ciphertext do not match. */
export function open({ recipientPrivateKey, enc, info = EMPTY, aad = EMPTY, ciphertext, aead = 'chacha20-poly1305' }) {
  const suite = suiteFor(aead);
  if (!Buffer.isBuffer(enc) || enc.length !== 32) throw new Error('HPKE: malformed encapsulated key');
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < TAG_LENGTH) throw new Error('HPKE: malformed ciphertext');
  const recipientRaw = x25519RawPublicKey(recipientPrivateKey);
  const sharedSecret = kemSharedSecret(dh(recipientPrivateKey, enc), enc, recipientRaw);
  const { key, nonce } = keySchedule(suite, sharedSecret, info);
  const body = ciphertext.subarray(0, ciphertext.length - TAG_LENGTH);
  const decipher = createDecipheriv(suite.cipher, key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(aad, { plaintextLength: body.length });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
