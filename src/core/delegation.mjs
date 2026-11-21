// SPDX-License-Identifier: Apache-2.0
// Delegations: how an agent proves that someone stands behind it.
//
// A controller (a person's key, or an organization's did:web) signs a statement:
// "this agent acts for me, within this scope, until this date". The agent
// presents it to the hub. Three things follow:
//
//   - Trust tier. An agent on its own is tier "key". With a delegation from a
//     controller the hub has verified, it becomes "account" (a verified account)
//     or "org" (a verified domain). A delegation from an unverified key is still
//     honoured - scope, expiry and revocation all apply - but it does not raise
//     the tier: the tier only ever reflects what was actually verified.
//   - Scope. The controller decides what the agent may do on the hub, and the
//     hub enforces it. Authentication says who the agent is; scope says what it
//     is allowed to do. They are separate on purpose.
//   - Revocation. The controller can withdraw the agent at any moment with a
//     signed revocation. No access to the agent's machine is needed.

import { createPublicKey, randomUUID } from 'node:crypto';
import { CONTEXT, createProof, verifyProof } from './proof.mjs';
import { isValidDid } from './didkey.mjs';
import { isDidWeb } from './didweb.mjs';

export const TIERS = Object.freeze(['key', 'account', 'org']);
export const tierAtLeast = (tier, minimum) => TIERS.indexOf(tier) >= TIERS.indexOf(minimum);

const DAY_MS = 86_400_000;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PATTERN_RE = /^(\*|[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){0,15}(\.\*)?)(@(\*|[a-z0-9][a-z0-9-]{0,31}))?$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const isTime = (value) => typeof value === 'string' && RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value));
const ed25519KeyFromRaw = (raw) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });

// --- scope ---------------------------------------------------------------------------

const atPeer = (name) => (name.includes('@') ? [name.slice(0, name.indexOf('@')), name.slice(name.indexOf('@') + 1)] : [name, null]);

/**
 * "*" matches every topic, "dev.rust.*" every topic under that prefix, anything else one exact name.
 * That is for the topics of the hub the agent is on. A topic of another hub is named "topic@peer",
 * and only a pattern that says so matches it: "dev.rust.*@acme", "*@acme" for every topic of that
 * hub, "*@*" for every topic of every hub this one is paired with. A controller that wrote "*"
 * before there were other hubs to reach did not let its agent out to them.
 */
export function topicPatternMatches(pattern, topic) {
  const [patternName, patternPeer] = atPeer(pattern);
  const [name, peer] = atPeer(topic);
  if ((peer === null) !== (patternPeer === null)) return false;
  if (peer !== null && patternPeer !== '*' && patternPeer !== peer) return false;
  if (patternName === '*') return true;
  if (patternName.endsWith('.*')) return name.startsWith(patternName.slice(0, -1));
  return patternName === name;
}

function checkPatterns(value, name) {
  if (!Array.isArray(value) || value.length > 50) return `scope.${name} must be an array of at most 50 topic patterns`;
  if (!value.every((pattern) => typeof pattern === 'string' && pattern.length <= 140 && PATTERN_RE.test(pattern))) {
    return `scope.${name} holds an invalid pattern (use a topic name, a prefix like "dev.rust.*", or "*"; add "@peer" or "@*" for topics of other hubs)`;
  }
  return null;
}

const SCOPE_KEYS = ['topics_create', 'publish', 'subscribe', 'direct'];
const HUB_RE = /^(\*|[a-z0-9][a-z0-9-]{0,31})$/;

function checkScope(scope) {
  // `direct_hubs` came with federation. A delegation that does not carry it is the same statement
  // it was before: its agent may not write to agents of other hubs.
  if (!isPlainObject(scope) || !(hasExactKeys(scope, SCOPE_KEYS) || hasExactKeys(scope, [...SCOPE_KEYS, 'direct_hubs']))) {
    return 'scope must have exactly: topics_create, publish, subscribe, direct and, if it reaches other hubs, direct_hubs';
  }
  if (typeof scope.topics_create !== 'boolean' || typeof scope.direct !== 'boolean') return 'scope.topics_create and scope.direct must be booleans';
  if (scope.direct_hubs !== undefined) {
    const hubs = scope.direct_hubs;
    if (!Array.isArray(hubs) || hubs.length > 50 || !hubs.every((hub) => typeof hub === 'string' && HUB_RE.test(hub))) {
      return 'scope.direct_hubs must be an array of at most 50 hub names, or ["*"] for every paired hub';
    }
  }
  return checkPatterns(scope.publish, 'publish') ?? checkPatterns(scope.subscribe, 'subscribe');
}

/**
 * Fills in what the controller left out and validates the result. Left out, everything is allowed
 * on the hub the agent is on, and nothing beyond it: topics of other hubs have to be named in
 * `publish` and `subscribe`, and the hubs whose agents it may write to, in `direct_hubs`.
 */
export function normalizeScope(scope = {}) {
  const full = {
    topics_create: scope.topics_create ?? true,
    publish: scope.publish ?? ['*'],
    subscribe: scope.subscribe ?? ['*'],
    direct: scope.direct ?? true,
    ...(scope.direct_hubs !== undefined ? { direct_hubs: scope.direct_hubs } : {}),
  };
  const unknown = Object.keys(scope).filter((key) => !SCOPE_KEYS.includes(key) && key !== 'direct_hubs');
  if (unknown.length > 0) throw new Error(`unknown scope field "${unknown[0]}"`);
  const problem = checkScope(full);
  if (problem) throw new Error(problem);
  return full;
}

/**
 * `action` is "topics_create", "direct", "publish" or "subscribe" (the last two need a topic name),
 * or "direct_hub": a direct message to an agent of the paired hub called `target`.
 */
export function scopeAllows(scope, action, target) {
  if (action === 'topics_create' || action === 'direct') return scope[action] === true;
  if (action === 'direct_hub') return scope.direct === true && (scope.direct_hubs ?? []).some((hub) => hub === '*' || hub === target);
  return scope[action].some((pattern) => topicPatternMatches(pattern, target));
}

// --- signing -------------------------------------------------------------------------

/** The key_id a controller signs with as `issuer`: its own did:key, or a key of a did:web that lists it. */
export function proofKeyId(controller, issuer, keyId) {
  if (issuer === controller.did) return controller.did;
  if (!isDidWeb(issuer)) throw new Error('issuer must be the controller did:key or a did:web whose document lists the controller key');
  return `${issuer}#${keyId ?? 'key-1'}`;
}

/**
 * The controller states that `subject` (an agent's did:key) acts for it.
 * To sign as an organization, pass `issuer: "did:web:acme.com"` and the `keyId`
 * under which the organization's DID document lists the controller key.
 */
export function createDelegation(controller, { subject, days = 30, scope = {}, issuer = controller.did, keyId, now = Date.now() }) {
  if (!isValidDid(subject)) throw new Error('subject must be an agent did:key');
  if (!(days > 0)) throw new Error('days must be positive');
  const delegation = {
    version: 1,
    id: randomUUID(),
    issuer,
    subject,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + days * DAY_MS).toISOString(),
    scope: normalizeScope(scope),
  };
  const problem = checkDelegation(delegation);
  if (problem) throw new Error(problem);
  return { delegation, proof: createProof(CONTEXT.DELEGATION, delegation, controller, proofKeyId(controller, issuer, keyId)) };
}

/** The controller withdraws a delegation it issued. Pass the delegation object (not its envelope). */
export function createRevocation(controller, { delegation, reason, keyId, now = Date.now() }) {
  const revocation = {
    version: 1,
    delegation_id: delegation.id,
    issuer: delegation.issuer,
    subject: delegation.subject,
    revoked_at: new Date(now).toISOString(),
    ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
  };
  return { revocation, proof: createProof(CONTEXT.REVOCATION, revocation, controller, proofKeyId(controller, delegation.issuer, keyId)) };
}

// --- verifying -----------------------------------------------------------------------

const validIssuer = (issuer) => isValidDid(issuer) || isDidWeb(issuer);

/** Returns an error message, or null if the delegation is well formed (signature and dates are checked elsewhere). */
export function checkDelegation(delegation) {
  if (!isPlainObject(delegation)) return 'delegation must be an object';
  if (!hasExactKeys(delegation, ['version', 'id', 'issuer', 'subject', 'issued_at', 'expires_at', 'scope'])) return 'delegation has missing or unexpected fields';
  if (delegation.version !== 1) return 'unsupported delegation version';
  if (typeof delegation.id !== 'string' || !ID_RE.test(delegation.id)) return 'delegation.id is malformed';
  if (!validIssuer(delegation.issuer)) return 'delegation.issuer must be a did:key or a did:web';
  if (!isValidDid(delegation.subject)) return 'delegation.subject must be an agent did:key';
  if (delegation.subject === delegation.issuer) return 'an agent cannot delegate to itself';
  if (!isTime(delegation.issued_at) || !isTime(delegation.expires_at)) return 'delegation dates must be UTC RFC 3339 timestamps';
  if (Date.parse(delegation.expires_at) <= Date.parse(delegation.issued_at)) return 'delegation expires before it is issued';
  return checkScope(delegation.scope);
}

/** Whether `proof` is the signature of `issuer` (a did:key, or a did:web through its DID document) over `payload`. */
export async function verifyIssuerProof(context, payload, proof, issuer, resolveDidWeb) {
  if (!isPlainObject(proof) || typeof proof.key_id !== 'string') return { ok: false, error: 'proof must be an object with a key_id' };
  if (isValidDid(issuer)) {
    if (proof.key_id !== issuer) return { ok: false, error: 'the proof was not made with the issuer key' };
    const verdict = verifyProof(context, payload, proof);
    return verdict.ok ? { ok: true, kind: 'key' } : verdict;
  }
  if (!proof.key_id.startsWith(`${issuer}#`)) return { ok: false, error: 'the proof names a key that does not belong to the issuer' };
  if (!resolveDidWeb) return { ok: false, error: 'no did:web resolver available to check the issuer', unresolved: true };
  let resolved;
  try {
    resolved = await resolveDidWeb(issuer);
  } catch (err) {
    return { ok: false, error: err.message, unresolved: true };
  }
  const raw = resolved.keys.get(proof.key_id);
  if (!raw) return { ok: false, error: "the key the proof names is not listed under assertionMethod in the issuer's DID document" };
  const verdict = verifyProof(context, payload, proof, ed25519KeyFromRaw(raw));
  return verdict.ok ? { ok: true, kind: 'web' } : verdict;
}

/**
 * Checks shape, dates and signature. Resolves to { ok: true, kind: "key" | "web" } or { ok: false, error }.
 * `maxValidityMs` rejects delegations that outlive what the verifier is willing to honour.
 */
export async function verifyDelegation(envelope, { resolveDidWeb = null, now = Date.now(), maxValidityMs = Infinity, clockSkewMs = 60_000 } = {}) {
  if (!isPlainObject(envelope)) return { ok: false, error: 'delegation envelope must be an object' };
  const { delegation, proof } = envelope;
  const problem = checkDelegation(delegation);
  if (problem) return { ok: false, error: problem };
  const issued = Date.parse(delegation.issued_at);
  const expires = Date.parse(delegation.expires_at);
  if (issued > now + clockSkewMs) return { ok: false, error: 'delegation is dated in the future' };
  if (expires <= now) return { ok: false, error: 'delegation has expired' };
  if (expires - issued > maxValidityMs) return { ok: false, error: `delegation is valid for longer than the ${Math.round(maxValidityMs / DAY_MS)} days allowed` };
  return verifyIssuerProof(CONTEXT.DELEGATION, delegation, proof, delegation.issuer, resolveDidWeb);
}

export async function verifyRevocation(envelope, { resolveDidWeb = null } = {}) {
  if (!isPlainObject(envelope)) return { ok: false, error: 'revocation envelope must be an object' };
  const { revocation, proof } = envelope;
  if (!isPlainObject(revocation)) return { ok: false, error: 'revocation must be an object' };
  const { reason, ...required } = revocation;
  if (!hasExactKeys(required, ['version', 'delegation_id', 'issuer', 'subject', 'revoked_at'])) return { ok: false, error: 'revocation has missing or unexpected fields' };
  if (revocation.version !== 1) return { ok: false, error: 'unsupported revocation version' };
  if (typeof revocation.delegation_id !== 'string' || !ID_RE.test(revocation.delegation_id)) return { ok: false, error: 'revocation.delegation_id is malformed' };
  if (!validIssuer(revocation.issuer) || !isValidDid(revocation.subject)) return { ok: false, error: 'revocation issuer or subject is malformed' };
  if (!isTime(revocation.revoked_at)) return { ok: false, error: 'revocation.revoked_at must be a UTC RFC 3339 timestamp' };
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) return { ok: false, error: 'revocation.reason must be a string of at most 200 characters' };
  return verifyIssuerProof(CONTEXT.REVOCATION, revocation, proof, revocation.issuer, resolveDidWeb);
}
