// SPDX-License-Identifier: Apache-2.0
// Private topics: events encrypted with a key that only the topic's members hold.
//
// The owner of a private topic generates a random 32-byte topic key and hands it
// to each member in a *grant*: the key sealed (HPKE) to that member's encryption
// key, in a statement signed by the owner. The hub stores and serves the grants,
// but cannot open them, and cannot forge one: members only accept grants signed
// by the topic owner. Events are encrypted with a key derived from the topic key
// and travel in an ordinary signed envelope, so authorship is still proven by the
// sender's signature even though every member shares the topic key.
//
// Removing a member means a new key (a new *epoch*) granted to everyone who
// stays. The removed member keeps what it could already read and gets nothing new.
//
// This is deliberately simpler than MLS and weaker in two ways: within an epoch
// there is no forward secrecy (whoever obtains the topic key reads the whole
// epoch), and recovering from a compromised member requires the owner to rotate.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { open, seal } from './hpke.mjs';
import { checkPublicEncryptionKey, checkSealedShape, DIRECT_ALG } from './e2e.mjs';
import { CONTEXT, createProof, verifyProof } from './proof.mjs';
import { isValidDid } from './didkey.mjs';

export const GROUP_ENCRYPTION = 'group-v1';
export const GROUP_ALG = 'HKDF-SHA256+CHACHA20POLY1305';

const GRANT_INFO = Buffer.from('agenthub/topic-key/v1');
const EVENT_INFO = Buffer.from('agenthub/topic-event/v1');
const ZERO_NONCE = Buffer.alloc(12); // safe: every message is encrypted under its own derived key
const TAG_LENGTH = 16;
const SALT_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const validEpoch = (epoch) => Number.isSafeInteger(epoch) && epoch >= 1;

export const generateTopicKey = () => randomBytes(32);

// --- grants: handing the topic key to a member -----------------------------------

const grantAad = ({ topic, epoch, member }, owner) => Buffer.from(`${topic}\n${epoch}\n${member}\n${owner}`, 'utf8');

/** The owner seals `topicKey` to one member and signs the statement. */
export function createGrant(owner, { topic, epoch, member, memberKey, topicKey }) {
  const problem = checkPublicEncryptionKey(memberKey);
  if (problem) throw new Error(problem);
  if (!Buffer.isBuffer(topicKey) || topicKey.length !== 32) throw new Error('topic keys are 32 bytes');
  const header = { topic, epoch, member };
  const { enc, ciphertext } = seal({
    recipientPublicKey: Buffer.from(memberKey.public, 'base64url'),
    info: GRANT_INFO,
    aad: grantAad(header, owner.did),
    plaintext: topicKey,
  });
  const grant = { ...header, sealed: { alg: DIRECT_ALG, kid: memberKey.kid, enc: enc.toString('base64url'), ct: ciphertext.toString('base64url') } };
  return { grant, proof: createProof(CONTEXT.TOPIC_GRANT, grant, owner) };
}

/**
 * Returns an error message, or null if the envelope is a grant for `topic`, signed by `owner`
 * (and for `epoch` / `member`, when given). The hub runs this to refuse junk; members run it
 * so that nobody but the owner - the hub included - can hand them a key.
 */
export function checkGrant(envelope, { topic, owner, epoch, member }) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.grant)) return 'grant envelope is malformed';
  const { grant, proof } = envelope;
  if (!hasExactKeys(grant, ['topic', 'epoch', 'member', 'sealed'])) return 'grant has missing or unexpected fields';
  if (grant.topic !== topic) return 'grant is for a different topic';
  if (!validEpoch(grant.epoch) || (epoch !== undefined && grant.epoch !== epoch)) return 'grant is for a different epoch';
  if (!isValidDid(grant.member) || (member !== undefined && grant.member !== member)) return 'grant is for a different member';
  const problem = checkSealedShape(grant.sealed);
  if (problem) return `grant.sealed: ${problem}`;
  const verdict = verifyProof(CONTEXT.TOPIC_GRANT, grant, proof);
  if (!verdict.ok) return `grant signature rejected: ${verdict.error}`;
  if (verdict.did !== owner) return 'grant is not signed by the topic owner';
  return null;
}

/** Verifies a grant and returns the topic key inside it. `keys` are the member's own encryption keys. */
export function openGrant(envelope, { keys, topic, owner, member }) {
  const problem = checkGrant(envelope, { topic, owner, member });
  if (problem) throw new Error(problem);
  const { grant } = envelope;
  const key = keys.find((candidate) => candidate.kid === grant.sealed.kid);
  if (!key) throw new Error('grant is sealed to a key this agent no longer holds');
  const topicKey = open({
    recipientPrivateKey: key.privateKey,
    enc: Buffer.from(grant.sealed.enc, 'base64url'),
    info: GRANT_INFO,
    aad: grantAad(grant, owner),
    ciphertext: Buffer.from(grant.sealed.ct, 'base64url'),
  });
  if (topicKey.length !== 32) throw new Error('grant does not hold a topic key');
  return topicKey;
}

// --- events -------------------------------------------------------------------------

const eventAad = (topic, epoch, source, id) => Buffer.from(`${topic}\n${epoch}\n${source}\n${id}`, 'utf8');
const messageKey = (topicKey, salt) => Buffer.from(hkdfSync('sha256', topicKey, salt, EVENT_INFO, 32));

/** Returns an error message, or null if `data` has the shape of an encrypted topic payload. */
export function checkGroupSealedShape(data) {
  if (!isPlainObject(data) || !hasExactKeys(data, ['alg', 'epoch', 'salt', 'ct'])) return 'encrypted data must have exactly: alg, epoch, salt, ct';
  if (data.alg !== GROUP_ALG) return `encrypted data.alg must be "${GROUP_ALG}"`;
  if (!validEpoch(data.epoch)) return 'encrypted data.epoch must be a positive integer';
  if (typeof data.salt !== 'string' || !SALT_RE.test(data.salt)) return 'encrypted data.salt must be 32 bytes in base64url';
  if (typeof data.ct !== 'string' || data.ct.length < 22 || !B64URL_RE.test(data.ct)) return 'encrypted data.ct is malformed';
  return null;
}

/** Encrypts `payload` for the members of `topic`, bound to the epoch, the sender and the event id. */
export function encryptTopicEvent({ topicKey, topic, epoch, source, id, payload }) {
  const salt = randomBytes(32);
  const cipher = createCipheriv('chacha20-poly1305', messageKey(topicKey, salt), ZERO_NONCE, { authTagLength: TAG_LENGTH });
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  cipher.setAAD(eventAad(topic, epoch, source, id), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { alg: GROUP_ALG, epoch, salt: salt.toString('base64url'), ct: ct.toString('base64url') };
}

/** Reverses encryptTopicEvent(). Throws if the key, the binding or the ciphertext do not match. */
export function decryptTopicEvent({ topicKey, topic, source, id, data }) {
  const problem = checkGroupSealedShape(data);
  if (problem) throw new Error(problem);
  const raw = Buffer.from(data.ct, 'base64url');
  if (raw.length < TAG_LENGTH) throw new Error('encrypted data.ct is malformed');
  const body = raw.subarray(0, raw.length - TAG_LENGTH);
  const decipher = createDecipheriv('chacha20-poly1305', messageKey(topicKey, Buffer.from(data.salt, 'base64url')), ZERO_NONCE, { authTagLength: TAG_LENGTH });
  decipher.setAAD(eventAad(topic, data.epoch, source, id), { plaintextLength: body.length });
  decipher.setAuthTag(raw.subarray(raw.length - TAG_LENGTH));
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
}
