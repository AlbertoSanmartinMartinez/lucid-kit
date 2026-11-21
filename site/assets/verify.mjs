// SPDX-License-Identifier: Apache-2.0
// What the landing page does with the signed event at its top: checks its signature in the browser,
// the same way every LUCID client checks an event, and with nothing but the event and its proof.
//
// It is the protocol's own check, written again without Node: the canonical form of the event (JCS,
// RFC 8785), the public key taken out of the agent's did:key, and an Ed25519 signature over
// "<context>\n<canonical event>" (src/core/proof.mjs and src/core/sign.mjs). test/site.test.mjs
// holds it to the core's own verification, so the two cannot drift apart.
//
// It checks an event signed by the agent's own key, which is what the page shows. One signed by an
// instance of the agent also carries a certificate (src/core/instance.mjs), and is not for this page.

export const EVENT_CONTEXT = 'agenthub/event/v1';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

/** The canonical form of a JSON value (RFC 8785), as src/core/jcs.mjs writes it. */
export function canonicalize(value, depth = 0) {
  if (depth > 64) throw new TypeError('JCS: value is nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite numbers are not valid JSON');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, depth + 1)).join(',')}]`;
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported value of type ${typeof value}`);
  }
}

function base58Decode(text) {
  let number = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new TypeError('not base58');
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number % 256n));
    number /= 256n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0); // each leading "1" is a leading zero byte
  }
  return Uint8Array.from(bytes);
}

/** The 32 bytes of the Ed25519 public key a did:key is made of. Throws for anything else. */
export function publicKeyOfDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z') || did.length > 128) throw new TypeError('not a did:key');
  const bytes = base58Decode(did.slice('did:key:z'.length));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new TypeError('not the did:key of an Ed25519 key');
  return bytes.slice(2);
}

function base64urlDecode(text) {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(plain + '='.repeat((4 - (plain.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether this browser (or runtime) can check an Ed25519 signature with WebCrypto. Some older ones
 * cannot; the page says so instead of pretending.
 */
export async function canVerify(subtle = globalThis.crypto?.subtle) {
  if (!subtle) return false;
  try {
    await subtle.importKey('raw', new Uint8Array(32).fill(1), { name: 'Ed25519' }, false, ['verify']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a signed event, { event, proof }, signed with the key of the agent in `event.source`.
 * Returns { ok: true, did } or { ok: false, reason }: "malformed" for what is not a signed event at
 * all, and "forged" for one whose signature does not match what it says.
 */
export async function verifyEvent(envelope, subtle = globalThis.crypto?.subtle) {
  if (!isObject(envelope) || !isObject(envelope.event) || !isObject(envelope.proof)) return { ok: false, reason: 'malformed' };
  const { event, proof } = envelope;
  if (proof.algorithm !== 'Ed25519' || proof.canonicalization !== 'JCS' || proof.context !== EVENT_CONTEXT) return { ok: false, reason: 'malformed' };
  if (typeof proof.signature !== 'string' || !SIGNATURE_RE.test(proof.signature)) return { ok: false, reason: 'malformed' };
  let key;
  let signed;
  try {
    key = await subtle.importKey('raw', publicKeyOfDid(proof.key_id), { name: 'Ed25519' }, false, ['verify']);
    signed = new TextEncoder().encode(`${proof.context}\n${canonicalize(event)}`);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const valid = await subtle.verify({ name: 'Ed25519' }, key, base64urlDecode(proof.signature), signed);
  // A good signature by a key that is not the one the event says it is from is no better than a bad one.
  if (!valid || event.source !== proof.key_id) return { ok: false, reason: 'forged' };
  return { ok: true, did: proof.key_id };
}
