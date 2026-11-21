// SPDX-License-Identifier: Apache-2.0
// Signed notes, checkpoints and cosignatures as C2SP writes them (c2sp.org/signed-note,
// tlog-checkpoint, tlog-cosignature).
//
// A checkpoint is what a transparency log says it is - whose log, how many entries, the root of
// the tree over them - as three lines of text signed by the log. A cosignature is what a witness
// adds to it: its own signature over those lines and the time, which says that the log it was
// shown then was the one it had been shown before, with more entries after it. A log that kept
// two lists for two readers could have only one of them cosigned by a witness that does its job.
//
// These are the formats the public witnesses of other transparency logs speak, so a hub can be
// watched by witnesses that are none of this project's, and its own witness can watch other logs.
//
// What is signed here is not what proof.mjs signs. A proof is over `<context> "\n" JCS(object)`,
// whose second line starts with "{". The text of a checkpoint has a count on its second line, and
// what a witness signs starts with "cosignature/v1": no key that signs both can have one taken for
// the other.
//
// Ed25519 only: the log signs the note text (signature type 0x01) and a witness signs a
// timestamped cosignature (0x04). C2SP's newer ML-DSA-44 cosignatures are not here.

import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

export const NOTE_ED25519 = 0x01;
export const NOTE_COSIGNATURE = 0x04;
const MAX_SIGNATURES = 32;
const MAX_NOTE_BYTES = 16 * 1024;
const NAME_RE = /^[^\s+\p{Cc}]{1,255}$/u; // a key name, a cosigner name, an origin: no spaces, no plus, no control characters
const DECIMAL_RE = /^(0|[1-9][0-9]{0,15})$/;
const COSIGNATURE_PREFIX = 'cosignature/v1\n';

const canonicalBase64 = (text) => {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
};

/** An Ed25519 public key from its 32 bytes. */
export const publicKeyFromBytes = (bytes) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bytes).toString('base64url') }, format: 'jwk' });
/** And its 32 bytes from the key. */
export const publicKeyBytes = (key) => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');

/** The four bytes a signature line names its key by, with the name. */
export function noteKeyId(name, type, key) {
  return createHash('sha256').update(Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0x0a, type]), key])).digest().subarray(0, 4);
}

/** A key that verifies, as it is given to whoever has to trust it: `name+id+base64(type || key)`. */
export function formatVerifier({ name, type, key }) {
  return `${name}+${noteKeyId(name, type, key).toString('hex')}+${Buffer.concat([Buffer.from([type]), key]).toString('base64')}`;
}

/** Reads one: { name, type, key, id }. Throws a TypeError if it is not a verifier key of a kind this speaks. */
export function parseVerifier(text) {
  const parts = typeof text === 'string' ? text.split('+') : [];
  // The base64 at the end can have plus signs of its own: the name and the id cannot.
  const [name, id, ...rest] = parts;
  const material = canonicalBase64(rest.join('+'));
  if (parts.length < 3 || !NAME_RE.test(name) || !/^[0-9a-f]{8}$/.test(id) || !material || material.length !== 33) throw new TypeError('a verifier key is NAME+ID+KEY, as c2sp.org/signed-note writes one');
  const [type, key] = [material[0], material.subarray(1)];
  if (type !== NOTE_ED25519 && type !== NOTE_COSIGNATURE) throw new TypeError('a verifier key of a kind this does not speak: only Ed25519 ones, of a log (01) or of a witness (04)');
  if (noteKeyId(name, type, key).toString('hex') !== id) throw new TypeError('the id of a verifier key is not the one its name and key give');
  return { name, type, key, id: Buffer.from(id, 'hex') };
}

/** A note: its text, a blank line and its signature lines. `signatures` are { name, id, signature }, the last two as bytes. */
export function formatNote(text, signatures) {
  return `${text}\n${signatures.map(({ name, id, signature }) => `— ${name} ${Buffer.concat([id, signature]).toString('base64')}\n`).join('')}`;
}

/** Just the signature lines, as a witness answers with them. */
export const formatSignatures = (signatures) => formatNote('', signatures).slice(1);

/**
 * Reads a note: { text, signatures: [{ name, id, signature }] }. It checks how it is written, not
 * who signed it. Throws a TypeError if it is not a note.
 */
export function parseNote(note) {
  if (typeof note !== 'string' || Buffer.byteLength(note) > MAX_NOTE_BYTES) throw new TypeError('a note is text, of a size');
  if (/[\u0000-\u0009\u000b-\u001f]/.test(note) || !note.isWellFormed()) throw new TypeError('a note is well-formed text with no control characters in it');
  const split = note.lastIndexOf('\n\n');
  if (split === -1) throw new TypeError('a note is a text, a blank line and its signatures');
  const text = note.slice(0, split + 1);
  const lines = note.slice(split + 2).split('\n');
  if (text.length < 2 || lines.pop() !== '' || lines.length < 1 || lines.length > MAX_SIGNATURES) throw new TypeError('a note ends in its signature lines, one at least, each ended by a newline');
  return { text, signatures: lines.map(parseSignatureLine) };
}

function parseSignatureLine(line) {
  const match = /^— (\S+) (\S+)$/u.exec(line);
  const bytes = match && NAME_RE.test(match[1]) ? canonicalBase64(match[2]) : null;
  if (!bytes || bytes.length < 5) throw new TypeError('a signature line is an em dash, the name of the key and the signature in base64');
  return { name: match[1], id: bytes.subarray(0, 4), signature: bytes.subarray(4) };
}

/** Reads the signature lines a witness answers with. */
export function parseSignatures(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_NOTE_BYTES || !text.endsWith('\n')) throw new TypeError('signature lines, each ended by a newline');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_SIGNATURES) throw new TypeError('too many signature lines');
  return lines.map(parseSignatureLine);
}

// ------------------------------------------------------------------------------ checkpoints

/** The text of a checkpoint: what a log is, in three lines. `root` as bytes. */
export function checkpointText({ origin, size, root }) {
  if (!NAME_RE.test(origin)) throw new TypeError('the origin of a log has no spaces, plus signs or control characters');
  if (!Number.isSafeInteger(size) || size < 0 || !Buffer.isBuffer(root) || root.length !== 32) throw new TypeError('a checkpoint is of a count and a SHA-256 root');
  return `${origin}\n${size}\n${root.toString('base64')}\n`;
}

/** Reads the text of a checkpoint: { origin, size, root, extensions }. Throws a TypeError if it is not one. */
export function parseCheckpoint(text) {
  const lines = typeof text === 'string' && text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
  const [origin, size, root, ...extensions] = lines;
  const hash = lines.length >= 3 ? canonicalBase64(root) : null;
  if (!hash || hash.length !== 32 || !NAME_RE.test(origin) || !DECIMAL_RE.test(size) || !Number.isSafeInteger(Number(size)) || extensions.some((line) => line === '')) {
    throw new TypeError('a checkpoint is an origin, a count and a root in base64, each on its line');
  }
  return { origin, size: Number(size), root: hash, extensions };
}

/** The signature line of a log over the text of its checkpoint. `key` is its public key as 32 bytes. */
export function signNoteText(text, { name, privateKey, key }) {
  return { name, id: noteKeyId(name, NOTE_ED25519, key), signature: edSign(null, Buffer.from(text, 'utf8'), privateKey) };
}

/** What a witness signs: the text of the checkpoint, and when. */
const cosignatureInput = (text, time) => Buffer.from(`${COSIGNATURE_PREFIX}time ${time}\n${text}`, 'utf8');

/** The cosignature of a witness over the text of a checkpoint, at `time` (seconds since 1970). */
export function cosign(text, { name, privateKey, key }, time = Math.floor(Date.now() / 1000)) {
  const stamp = Buffer.alloc(8);
  stamp.writeBigUInt64BE(BigInt(time));
  return { name, id: noteKeyId(name, NOTE_COSIGNATURE, key), signature: Buffer.concat([stamp, edSign(null, cosignatureInput(text, time), privateKey)]) };
}

const isBy = (line, verifier) => line.name === verifier.name && line.id.equals(verifier.id ?? noteKeyId(verifier.name, verifier.type, verifier.key));

/**
 * What the signature lines of a note say about its text, for the keys the caller knows: `log`, a
 * verifier of kind 01, and `witnesses`, verifiers of kind 04. Lines of keys it does not know are
 * passed over, as the format asks; a line that names a key it knows and does not verify makes the
 * whole note worthless (a TypeError). Returns { byLog, cosigned: [{ name, time }] }, each witness once,
 * with its latest time.
 */
export function checkSignatures(text, signatures, { log = null, witnesses = [] } = {}) {
  let byLog = false;
  const times = new Map();
  for (const line of signatures) {
    if (log && isBy(line, log)) {
      if (line.signature.length !== 64 || !edVerify(null, Buffer.from(text, 'utf8'), publicKeyFromBytes(log.key), line.signature)) throw new TypeError('the signature of the log on the note does not verify');
      byLog = true;
      continue;
    }
    const witness = witnesses.find((known) => isBy(line, known));
    if (!witness) continue;
    const time = line.signature.length === 72 ? Number(line.signature.readBigUInt64BE(0)) : NaN;
    if (!Number.isSafeInteger(time) || !edVerify(null, cosignatureInput(text, time), publicKeyFromBytes(witness.key), line.signature.subarray(8))) throw new TypeError('the cosignature of a witness on the note does not verify');
    times.set(witness.name, Math.max(time, times.get(witness.name) ?? 0));
  }
  return { byLog, cosigned: [...times].map(([name, time]) => ({ name, time })) };
}
