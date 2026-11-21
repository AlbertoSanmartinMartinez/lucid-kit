// SPDX-License-Identifier: Apache-2.0
// The card of an agent as an A2A Agent Card (A2A 1.0, section 8), signed by the agent.
//
// A2A is how agents built by different people describe themselves and call one another. An agent of
// a hub does not serve A2A's operations: it is written to through its hub, signed and encrypted.
// What it can do is describe itself in the form A2A clients, catalogs and other registries read:
// who it is, what it does, and where it is reached. An A2A client that does not speak the protocol
// of the hub can read that card and check who signed it. It cannot call the agent.
//
// The A2A card is not written by anybody: it follows, by the rule below, from the card the agent
// already signs for its hub and from the address of that hub. So there is one description of an
// agent and not two that could differ, and the hub keeps nothing new: only the signature, which
// travels in the agent's card (`a2a`) and so is covered by the proof of that card and by the log.
//
// The signature is the one A2A asks for: a JWS (RFC 7515) made with EdDSA (RFC 8037) over the card
// in canonical form (JCS, RFC 8785) without its `signatures`. Its `kid` is the agent's did:key as
// a DID URL, so the key is in the signature itself and nothing has to be fetched to check it.
//
// What it guarantees: whoever holds the card and knows the DID of the agent can tell that the agent
// said this of itself, for this hub. A hub cannot write a card for an agent, change one, or serve
// on its own address the one an agent signed for another hub.
// What it does not: that the card is the latest one (A2A has nothing for that; the log of the hub
// has), nor anything to a reader that takes the key from wherever the hub points it to instead of
// from the DID it was looking for.
//
// This is the only thing an agent key signs as a JWS. What it signs elsewhere is
// `<context> "\n" JCS(payload)` (proof.mjs), and the input of a JWS is base64url text with one dot
// in it: neither can be taken for the other.

import { sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalize } from './jcs.mjs';
import { isValidDid, publicKeyFromDid } from './didkey.mjs';
import { isPlainObject } from './proof.mjs';
import { originOf } from './reqsig.mjs';

/**
 * How an agent of a hub is reached, as A2A names a binding that is not one of its own three: by a
 * URI. Provisional until the project has a domain to hang it from; a change of it is a new binding,
 * and every card has to be signed again.
 */
export const A2A_BINDING = 'urn:agenthub:binding:v1';
/** The version of A2A whose Agent Card this is. */
export const A2A_VERSION = '1.0';
export const A2A_CARD_PATH = '.well-known/agent-card.json';

const JWS_ALG = 'EdDSA';
const PROTECTED_RE = /^[A-Za-z0-9_-]{1,400}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/; // 64 bytes, base64url, no padding
const MAX_SIGNATURES = 5;

/** A2A wants these said, and not empty: what an agent left unsaid is said with what it did say. */
const said = (value, otherwise) => (typeof value === 'string' && value.length > 0 ? value : otherwise);

/**
 * The A2A card of the agent of `card` on the hub at `hub`, without signatures. Every value is
 * copied as it is: nothing here depends on how a version of Node reads a character, so the agent
 * and the hub always arrive at the same bytes.
 */
export function a2aCard(card, hub) {
  const origin = originOf(hub);
  if (origin === null) throw new TypeError('the hub of an A2A card is an http(s) address');
  const description = said(card.description, card.name);
  const skills = (card.skills ?? []).map((skill, i) => ({
    id: `skill-${i + 1}`,
    name: skill.name,
    description: said(skill.description, skill.name),
    tags: [skill.name],
  }));
  return {
    name: card.name,
    description,
    // The hub is the address, and the agent is who is asked for there.
    supportedInterfaces: [{ url: origin, protocolBinding: A2A_BINDING, tenant: card.did, protocolVersion: A2A_VERSION }],
    version: said(card.updated_at, '1'),
    // Said, and not left empty: A2A's own SDK leaves an empty object out of what is signed, and the
    // specification keeps it. Neither does that to a value that is given, and both of these are true.
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    // A2A asks for one skill at least: an agent that lists none has the one its description tells.
    skills: skills.length > 0 ? skills : [{ id: 'agent', name: card.name, description, tags: [card.name] }],
  };
}

/**
 * The address of an agent on its hub for an A2A client, as a path: what the client puts
 * ".well-known/agent-card.json" after to find the card. It ends in a slash because A2A's own client
 * for JavaScript reads that path as relative to it: without the slash, the agent is lost from it.
 */
export const a2aAddressPath = (did) => `/a2a/${encodeURIComponent(did)}/`;
/** Where a hub serves the A2A card of an agent, as a path. */
export const a2aCardPath = (did) => `${a2aAddressPath(did)}${A2A_CARD_PATH}`;

const keyIdOf = (did) => `${did}#${did.slice('did:key:'.length)}`;
const signingInput = (protectedHeader, payload) => Buffer.from(`${protectedHeader}.${Buffer.from(payload).toString('base64url')}`, 'ascii');

/** A JWS over `payload` (a string or bytes) as A2A carries one: { protected, signature }. */
export function signJws(header, payload, privateKey) {
  const protectedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  return { protected: protectedHeader, signature: edSign(null, signingInput(protectedHeader, payload), privateKey).toString('base64url') };
}

/** The protected header of `jws` if its signature over `payload` is `publicKey`'s, or null. Never throws. */
export function verifyJws(jws, payload, publicKey) {
  try {
    if (checkA2ASignature(jws) !== null) return null;
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8'));
    if (!isPlainObject(header) || header.alg !== JWS_ALG) return null;
    return edVerify(null, signingInput(jws.protected, payload), publicKey, Buffer.from(jws.signature, 'base64url')) ? header : null;
  } catch {
    return null;
  }
}

/** Returns an error message, or null if `value` has the shape of the signature an agent carries in its card. */
export function checkA2ASignature(value) {
  if (!isPlainObject(value)) return 'a2a must be an object';
  if (typeof value.protected !== 'string' || !PROTECTED_RE.test(value.protected)) return 'a2a.protected must be a base64url header of at most 400 characters';
  if (typeof value.signature !== 'string' || !SIGNATURE_RE.test(value.signature)) return 'a2a.signature must be 64 bytes in base64url';
  if (Object.keys(value).length !== 2) return 'a2a has unexpected fields';
  return null;
}

/** The signature of an agent over its A2A card on the hub at `hub`: what goes in its card as `a2a`. */
export function signA2ACard(card, hub, identity) {
  if (identity.instance) throw new Error('an A2A card is signed with the agent key, not by an instance');
  if (card.did !== identity.did) throw new Error('card.did must be the signer DID');
  return signJws({ alg: JWS_ALG, typ: 'JOSE', kid: keyIdOf(identity.did) }, canonicalize(a2aCard(card, hub)), identity.privateKey);
}

/** The agent a JWS header names as its signer, if it names it the only way an agent key is named here. */
function signerOf(header) {
  if (typeof header.kid !== 'string' || header.kid.length > 300) return null;
  const [did, fragment, ...rest] = header.kid.split('#');
  return rest.length === 0 && isValidDid(did) && header.kid === keyIdOf(did) && fragment !== undefined ? did : null;
}

/**
 * The A2A card of `card` on the hub at `hub` with the signature the agent put in its card, or null
 * if the card carries none or it is not the agent's own over exactly that. What a hub serves.
 */
export function signedA2ACard(card, hub) {
  try {
    if (!isPlainObject(card) || card.a2a === undefined) return null;
    const unsigned = a2aCard(card, hub);
    const header = verifyJws(card.a2a, canonicalize(unsigned), publicKeyFromDid(card.did));
    return header && signerOf(header) === card.did ? { ...unsigned, signatures: [{ protected: card.a2a.protected, signature: card.a2a.signature }] } : null;
  } catch {
    return null;
  }
}

/**
 * Checks an A2A card as it arrives from anywhere. { ok: true, did, hub } if one of its signatures is
 * that of the agent the card itself names as reached at `hub`: `did` is that agent, verified.
 * With `did` or `hub` given, the card has to be that agent's, or for that hub. { ok: false, error }
 * otherwise. Never throws.
 */
export function verifyA2ACard(served, { did, hub } = {}) {
  try {
    if (!isPlainObject(served)) return { ok: false, error: 'an A2A card is an object' };
    const { signatures, ...unsigned } = served;
    if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > MAX_SIGNATURES) return { ok: false, error: 'the card carries no signature, or too many' };
    const interfaces = Array.isArray(unsigned.supportedInterfaces) ? unsigned.supportedInterfaces : [];
    const reached = interfaces.find((entry) => isPlainObject(entry) && entry.protocolBinding === A2A_BINDING);
    if (!reached) return { ok: false, error: 'the card does not say its agent is reached through a hub' };
    if (!isValidDid(reached.tenant)) return { ok: false, error: 'the card does not name its agent' };
    if (did !== undefined && reached.tenant !== did) return { ok: false, error: 'the card is of another agent' };
    if (originOf(reached.url) !== reached.url) return { ok: false, error: 'the card does not name its hub by its address' };
    if (hub !== undefined && reached.url !== originOf(hub)) return { ok: false, error: 'the card was signed for another hub' };
    const payload = canonicalize(unsigned);
    const key = publicKeyFromDid(reached.tenant);
    const signed = signatures.some((jws) => {
      const header = verifyJws(jws, payload, key);
      return header !== null && signerOf(header) === reached.tenant;
    });
    return signed ? { ok: true, did: reached.tenant, hub: reached.url } : { ok: false, error: 'no signature on the card is that of its agent' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
