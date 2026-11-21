// SPDX-License-Identifier: AGPL-3.0-only
// Agent Hub HTTP server.
//
// Public endpoints expose the directory (agents, topics, schemas). Everything
// that acts on behalf of an agent requires a per-request signature (see
// core/reqsig.mjs) made with the agent key or with the key of one of its
// instances (core/instance.mjs). Content - events and direct messages -
// additionally travels in a signed envelope { event, proof } that receivers
// verify on their own, so the hub is never trusted for authorship.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { NotRecordable, Store } from './store.mjs';
import { RateLimiter } from './ratelimit.mjs';
import { isValidDid, publicKeyBytesFromDid } from '../core/didkey.mjs';
import { verifyCardEnvelope, verifyEventEnvelope } from '../core/sign.mjs';
import { isBareProof } from '../core/proof.mjs';
import { DailyCounter, checkQuotas } from './quota.mjs';
import { metricsServer } from './metrics.mjs';
import { HEADERS, REQUEST_SIGNATURE, originOf, signRequest, verifyRequest } from '../core/reqsig.mjs';
import { verifyPow } from '../core/pow.mjs';
import { checkSchema, validate } from '../core/schema.mjs';
import { rank } from '../core/search.mjs';
import { scopeAllows, tierAtLeast, TIERS, verifyDelegation, verifyRevocation } from '../core/delegation.mjs';
import { verifyAttestation } from '../core/attestation.mjs';
import { createDidWebResolver, isDidWeb, isPublicAddress } from '../core/didweb.mjs';
import { lookup } from 'node:dns/promises';
import { checkGrant, checkGroupSealedShape, GROUP_ENCRYPTION } from '../core/groupkey.mjs';
import { checkPublicEncryptionKey, checkSealedShape, DIRECT_ENCRYPTION, ENCRYPTED_EVENT_TYPE } from '../core/e2e.mjs';
import { INSTANCE_GRACE_MS, verifyInstanceCertificate } from '../core/instance.mjs';
import { DIRECT_MLS, dmPair, dmPairKey, parseDmGroupId } from '../mls/dm.mjs';
import { parseTopicGroupId, TOPIC_MLS } from '../mls/topic.mjs';
import { bareTopicName, PEER_NAME_RE, remoteTopicName, splitTopicName, TOPIC_NAME_RE } from '../core/topicname.mjs';
import { agentAddress, splitAgentAddress } from '../core/address.mjs';
import { contractHash, Directory, entryLeaf, signCheckpoint } from '../core/log.mjs';
import { normalizePolicy } from '../core/policy.mjs';
import { verifyStatement } from '../core/statement.mjs';
import { A2A_BINDING, A2A_VERSION, signedA2ACard } from '../core/a2a.mjs';
import { checkpointText, checkSignatures, formatNote, formatVerifier, NOTE_COSIGNATURE, parseSignatures, parseVerifier, signNoteText } from '../core/note.mjs';
import { formatAddCheckpoint } from '../core/witness.mjs';
import { chunksUntil, parseSSE } from '../core/sse.mjs';
import { inspectKeyPackage, inspectMessage } from '../mls/member.mjs';
import { checkHello, checkPeer, FEDERATION_PROTOCOL, isChallenge, loadOrCreateHubIdentity, signHello } from './federation.mjs';

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
export const VERSION = '1.0.0';

const DEFAULTS = {
  host: '127.0.0.1', // local by default: exposing the hub is an explicit decision
  port: 8787,
  metricsPort: null, // a port for GET /metrics (Prometheus), or null for none
  metricsHost: '127.0.0.1', // where that port listens: this machine only, unless its operator says otherwise
  dataDir: null, // null keeps everything in memory
  publicUrl: null,
  powDifficulty: 18, // leading zero bits required to register (~0.5 s of CPU)
  clockSkewMs: 60_000, // accepted distance between request timestamp and hub clock
  eventTimeSkewMs: 10 * 60_000,
  challengeTtlMs: 2 * 60_000,
  maxBodyBytes: 64 * 1024,
  maxSchemaBytes: 16 * 1024,
  maxTopicsPerAgent: 5,
  // How much an account may do, by tier: { key, account, org }, each { sendsPerDay, topics, agents }. See quota.mjs.
  quotas: null,
  // Open pairing: any hub may pair itself with this one, as a hosted service lets hubs do. false, or
  // { maxPeers }: how many hubs may have paired themselves at once. Pairing by the operator is not affected.
  openPairing: false,
  name: null, // how this hub proposes to be called by a hub it pairs itself with; by default, from its address
  maxSubscriptionsPerAgent: 100,
  maxPrivateTopicMembers: 100, // a key rotation must fit in one request
  maxTopicGroupReaders: 50, // readers (agent keys and instances) in the MLS group of a private topic: its invitation carries the whole group
  maxMlsBodyBytes: 256 * 1024, // a request that carries an invitation to the group of a topic
  topicRetention: 200,
  inboxCap: 1000,
  heartbeatMs: 15_000,
  requireDirectEncryption: false, // true: the hub refuses direct messages it could read
  topicCreateMinTier: 'key', // the design reserves topic creation for verified tiers; raise it once controllers are being verified
  maxDelegationDays: 90, // longest validity the hub honours in a delegation
  maxInstancesPerAgent: 10,
  maxKeyPackagesPerReader: 20, // MLS KeyPackages a reader may have waiting to be used
  mlsCommitsKept: 100, // commits of a group the hub keeps for readers that fell behind
  mlsEarlierGroupsKept: 2, // groups before the current one of a conversation whose commits are still kept
  maxInstanceDays: 90, // longest validity the hub honours in an instance certificate
  // Verifiers whose account attestations this hub takes (core/attestation.mjs): their DIDs.
  trustedVerifiers: [],
  // Who may moderate this hub: the DIDs of its operators, whose signed requests reach /v1/admin.
  operators: [],
  verifiedControllers: {}, // controller did:key -> the account the operator verified for it (raises its agents to tier "account")
  resolveDidWeb: null, // how did:web issuers are resolved; defaults to fetching did.json over HTTPS
  identity: null, // the key of this hub; by default the one kept in dataDir, or a new one if there is no dataDir
  peers: [], // hubs this one is paired with, as their operators and this one agreed: [{ name, url, did }]
  peerTimeoutMs: 5000, // how long a hub is given to answer
  maxPeerResponseBytes: 1024 * 1024, // and how much it may answer
  fetch: null, // how other hubs are reached; defaults to the global fetch
  lookup: null, // how the name of a hub that pairs itself is turned into addresses; defaults to the system's
  witnesses: [], // who watches the log of this hub: each "VERIFIER-KEY@URL", or { key, url }
  witnessIntervalMs: 15_000, // how often they are shown what the log is
  peerSearchTimeoutMs: 1500, // a search does not wait longer than this for a paired hub
  remoteTopicTtlMs: 30_000, // how long the contract of a topic of another hub is taken as current
  peerAckDelayMs: 2000, // how long what arrives from another hub piles up before this one says it has it
  peerResyncMs: 10 * 60_000, // how often a hub is told again everything this one follows of it
  maxFollowsPerPeer: 1000, // topics of this hub that another one may follow
  maxConversationsPerPeer: 10_000, // conversations over MLS with the agents of another hub that this one keeps, as their home
  tls: null, // { cert, key } in PEM to serve HTTPS directly
  trustProxy: 0, // number of reverse proxies in front of the hub whose X-Forwarded-For entry is trusted
  quiet: false,
  log: null, // where what the hub tells its operator goes, one line at a time; the console by default
};

const DEFAULT_LIMITS = {
  ip: { burst: 300, perMinute: 600 }, // every request, per IP
  challenge: { burst: 10, perMinute: 20 }, // per IP
  register: { burst: 5, perMinute: 5 }, // per IP
  search: { burst: 60, perMinute: 120 }, // per IP
  publish: { burst: 60, perMinute: 60 }, // per agent
  direct: { burst: 30, perMinute: 30 }, // per agent
  topicCreate: { burst: 5, perMinute: 5 }, // per agent
  delegation: { burst: 10, perMinute: 10 }, // per agent
  revoke: { burst: 20, perMinute: 20 }, // per IP
  attest: { burst: 20, perMinute: 20 }, // per IP: account attestations, each of which leaves an entry in the log
  pairing: { burst: 5, perMinute: 5 }, // per IP: hubs asking to pair themselves with this one
  report: { burst: 10, perMinute: 10 }, // per agent: reports to the operators
  block: { burst: 60, perMinute: 60 }, // per agent: blocking and unblocking
  instance: { burst: 10, perMinute: 10 }, // per IP
  mls: { burst: 60, perMinute: 60 }, // per agent: publishing and claiming KeyPackages, making conversation groups
  // Per agent and per peer. Each claim uses up KeyPackages of the peer's readers: left unchecked, one agent
  // could drain another's and push every new conversation with it onto its last one.
  mlsClaim: { burst: 6, perMinute: 2 },
  federation: { burst: 300, perMinute: 600 }, // per paired hub: what it asks of this one
  // What this hub asks of other hubs for whoever is calling: searching them, showing and following their topics.
  remote: { burst: 60, perMinute: 60 }, // per registered agent
  peerLookup: { burst: 60, perMinute: 120 }, // per paired hub, shared by every caller that is not a registered agent
  log: { burst: 120, perMinute: 240 }, // per IP: reading the transparency log
  // Per agent. Each of these leaves an entry in the transparency log, which is kept for good.
  card: { burst: 20, perMinute: 20 }, // changing its card
  topicPolicy: { burst: 30, perMinute: 30 }, // changing who may use its topics
};

const ATTRIBUTE_NAME_RE = /^[a-z0-9]{1,20}$/;
const EVENT_ID_RE = /^[\x21-\x7b\x7d\x7e]{1,128}$/; // printable ASCII without "|"
const EVENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP_RE = /^\d{13}$/;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * What goes on record with a signature goes with the signature and nothing else. A proof is only
 * checked in the fields that are used, so anything could ride along in it, signed by nobody and
 * kept for good in the log.
 */
function requireBareProof(proof, code, what) {
  if (!isBareProof(proof)) throw new HttpError(400, code, `${what} rejected: its proof has unexpected fields`);
}

/** What is nested more deeply than canonical JSON takes cannot be hashed, and so cannot go on record. */
const tooDeep = () => new HttpError(400, 'nested_too_deeply', 'what this request carries is nested too deeply to be put on record');

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, ...headers });
  res.end(payload);
}

/** What `promise` comes to, or a rejection once `ms` have passed. The work is not stopped: a lookup cannot be. */
function within(ms, promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function sendText(res, status, text) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`);
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        reject(new HttpError(400, 'bad_request', 'request aborted'));
      }
    });
  });
}

function parseJsonObject(buffer) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be valid UTF-8 JSON');
  }
  if (!isPlainObject(value)) throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
  return value;
}

function parseSeq(value, name) {
  if (value === null || value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(String(value))) throw new HttpError(400, 'invalid_parameter', `${name} must be a non-negative integer`);
  return Number(value);
}

function parseLimit(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1) throw new HttpError(400, 'invalid_parameter', 'limit must be a positive integer');
  return Math.min(Number(value), max);
}

/**
 * Text that somebody else chose, as the hub prints it: in quotes, and with nothing left in it that would
 * end the line or mean something to a terminal. What a hub prints is read by its operator and kept in
 * logs: a name must not be able to write lines of its own there.
 */
const printed = (text) => JSON.stringify(String(text).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '?'));

function validateCard(card, did) {
  const bad = (message) => new HttpError(400, 'invalid_card', message);
  if (!isPlainObject(card)) throw bad('card must be an object');
  if (card.did !== did) throw bad('card.did must be the DID that signs the request');
  if (typeof card.name !== 'string' || card.name.trim().length < 1 || card.name.length > 80) throw bad('card.name must be 1-80 characters');
  if (card.description !== undefined && (typeof card.description !== 'string' || card.description.length > 500)) {
    throw bad('card.description must be a string of at most 500 characters');
  }
  if (card.skills !== undefined) {
    if (!Array.isArray(card.skills) || card.skills.length > 20) throw bad('card.skills must be an array of at most 20 skills');
    for (const skill of card.skills) {
      if (!isPlainObject(skill) || typeof skill.name !== 'string' || skill.name.length < 1 || skill.name.length > 80) {
        throw bad('each skill needs a name of 1-80 characters');
      }
      if (skill.description !== undefined && (typeof skill.description !== 'string' || skill.description.length > 300)) {
        throw bad('skill.description must be a string of at most 300 characters');
      }
    }
  }
  if (card.encryption_key !== undefined) {
    const problem = checkPublicEncryptionKey(card.encryption_key);
    if (problem) throw bad(problem);
  }
  if (Buffer.byteLength(JSON.stringify(card)) > 8192) throw bad('card is larger than 8 KB');
}

function validateEvent(event, cfg, now) {
  const bad = (message) => new HttpError(400, 'invalid_event', message);
  if (event.specversion !== '1.0') throw bad('specversion must be "1.0"');
  if (typeof event.id !== 'string' || !EVENT_ID_RE.test(event.id)) throw bad('id must be 1-128 printable ASCII characters (no spaces, no "|")');
  if (typeof event.type !== 'string' || !EVENT_TYPE_RE.test(event.type)) throw bad('type is missing or malformed');
  if (typeof event.time !== 'string' || !RFC3339_RE.test(event.time) || Number.isNaN(Date.parse(event.time))) {
    throw bad('time must be an RFC 3339 timestamp');
  }
  if (Math.abs(Date.parse(event.time) - now) > cfg.eventTimeSkewMs) throw bad('time is too far from the hub clock');
  if (event.datacontenttype !== undefined && event.datacontenttype !== 'application/json') {
    throw bad('datacontenttype must be application/json');
  }
  if (!Object.hasOwn(event, 'data')) throw bad('data is required');
  for (const [name, value] of Object.entries(event)) {
    if (!ATTRIBUTE_NAME_RE.test(name)) throw bad(`attribute name "${name.slice(0, 40)}" is not valid for CloudEvents`);
    if (name === 'data') continue;
    const scalar = typeof value === 'string' || typeof value === 'boolean' || Number.isInteger(value);
    if (!scalar || (typeof value === 'string' && value.length > 512)) throw bad(`attribute "${name}" must be a short string, boolean or integer`);
  }
}

/** A topic access policy as it is kept: "any", "owner" (publish only) or { min_tier, allow }. See core/policy.mjs. */
function parsePolicy(value, name, { allowOwner }) {
  const policy = normalizePolicy(value, { allowOwner });
  if (policy === null) {
    throw new HttpError(400, 'invalid_topic', `${name} must be "any"${allowOwner ? ', "owner"' : ''} or an object with min_tier ("account" or "org") and/or allow (a list of DIDs)`);
  }
  return policy;
}

/** The owner always passes. Otherwise: being on the allow list or reaching the minimum tier is enough. */
function policyAllows(policy, { did, tier, owner }) {
  if (did === owner || policy === 'any') return true;
  if (policy === 'owner') return false;
  return (policy.allow?.includes(did) ?? false) || (policy.min_tier !== undefined && tierAtLeast(tier, policy.min_tier));
}

export function createHub(options = {}) {
  const cfg = { ...DEFAULTS, ...options, limits: { ...DEFAULT_LIMITS, ...(options.limits ?? {}) } };
  const store = new Store({ dataDir: cfg.dataDir, topicRetention: cfg.topicRetention, inboxCap: cfg.inboxCap }).load();
  // From its first entry - or, for a log that was started before agents signed for their changes,
  // from here - the log says that the hub does not speak for them, and its readers hold it to that.
  if (store.logSignedFrom === null) store.commit({ type: 'log.signed', at: new Date().toISOString() });
  const limiter = new RateLimiter();
  const challenges = new Map(); // challenge -> expiry (ms)
  const nonces = new Map(); // "<did>|<nonce>" -> expiry (ms)
  const streams = new Map(); // reader did (an agent key or one of its instances) -> open SSE response
  const lastSeen = new Map(); // did -> ms
  const log = cfg.log ?? (cfg.quiet ? () => {} : (line) => console.log(`[hub] ${line}`));
  const resolveDidWeb = cfg.resolveDidWeb ?? createDidWebResolver();
  const maxValidityMs = cfg.maxDelegationDays * 86_400_000;
  const maxInstanceValidityMs = cfg.maxInstanceDays * 86_400_000;
  if (!TIERS.includes(cfg.topicCreateMinTier)) throw new Error(`topicCreateMinTier must be one of ${TIERS.join(', ')}`);
  // Requests are signed for the address of the hub they are for: one reachable from other machines has to know its own.
  if (cfg.publicUrl == null && !LOOPBACK.includes(cfg.host)) {
    throw new Error('a hub reachable from other machines needs the address it is reached at (publicUrl, --public-url or PUBLIC_URL): requests are signed for it');
  }
  if (cfg.publicUrl != null && originOf(cfg.publicUrl) === null) throw new Error('publicUrl must be an http(s) address');
  let publicUrl = cfg.publicUrl;
  const quotas = checkQuotas(cfg.quotas);
  if (!Array.isArray(cfg.trustedVerifiers) || !cfg.trustedVerifiers.every(isValidDid)) throw new Error('trustedVerifiers must be a list of did:key');
  if (!Array.isArray(cfg.operators) || !cfg.operators.every(isValidDid)) throw new Error('operators must be a list of did:key');
  const sendsToday = new DailyCounter(); // per account
  /**
   * The addresses requests are signed for that this hub takes: the one it is reached at. Without one
   * set by the operator, a hub listening only on this machine takes the names this machine has for itself.
   */
  const ownOrigins = () => {
    const origins = new Set([originOf(publicUrl)].filter(Boolean));
    const port = server.address()?.port;
    if (cfg.publicUrl == null && LOOPBACK.includes(cfg.host) && port) {
      const scheme = cfg.tls ? 'https' : 'http';
      for (const name of ['127.0.0.1', 'localhost', '[::1]']) origins.add(originOf(`${scheme}://${name}:${port}`));
    }
    return origins;
  };
  // Federation: this hub's own key, and the hubs its operator paired it with. See federation.mjs.
  const identity = cfg.identity ?? loadOrCreateHubIdentity(cfg.dataDir);
  // The log of this hub is named by its key, and signed with it: see "witnesses" below.
  const logSigner = { name: identity.did, privateKey: identity.privateKey, key: publicKeyBytesFromDid(identity.did) };
  // Who watches that log: the key each cosigns with, and where it is asked. `size` is how much of the
  // log it has cosigned as far as this hub knows; a witness that is somewhere else says so when asked.
  const witnesses = cfg.witnesses.map((given) => {
    const [, key, url] = typeof given === 'string' ? (/^(.+)@(https?:\/\/[^@\s]+)$/.exec(given) ?? []) : [null, given?.key, given?.url];
    let verifier;
    try {
      verifier = parseVerifier(key);
    } catch {
      throw new Error('a witness is given as VERIFIER-KEY@URL: the key it cosigns with, as it prints it, and its address');
    }
    if (verifier.type !== NOTE_COSIGNATURE) throw new Error('a witness is given by the key it cosigns with, not by the key of a log');
    if (originOf(url) === null) throw new Error('a witness is reached at an http(s) address');
    return { verifier, url: url.replace(/\/+$/, ''), size: 0, problem: null };
  });
  if (new Set(witnesses.map((witness) => formatVerifier(witness.verifier))).size !== witnesses.length) throw new Error('the same witness is given twice');
  let witnessTimer = null;
  const peers = new Map(); // the name this hub calls it by -> { name, url, did, state, checked_at, detail }
  const peerByDid = (did) => [...peers.values()].find((peer) => peer.did === did);
  const addPeer = (given) => {
    const peer = checkPeer(given, { own: identity.did, others: [...peers.values()] });
    // What this hub keeps for another hub, and for a reader of its own, it keeps by their key: one key is not both.
    if (store.agents.has(peer.did) || store.instances.has(peer.did)) throw new Error(`the key of "${peer.name}" is registered on this hub as an agent, or as an instance of one: a hub is not an agent of another`);
    peers.set(peer.name, { ...peer, state: 'unknown', checked_at: null, detail: null });
    return peer;
  };
  for (const peer of cfg.peers) addPeer(peer);
  // The hubs that paired themselves with this one before it stopped. One that clashes with a pairing the
  // operator made since is left out: the operator's word comes first.
  for (const pairing of store.pairings.values()) {
    try {
      addPeer(pairing);
    } catch (err) {
      console.error(`[hub] the pairing with "${pairing.name}" is left out: ${err.message}`);
    }
  }
  if (cfg.openPairing !== false && !(Number.isSafeInteger(cfg.openPairing?.maxPeers) && cfg.openPairing.maxPeers > 0)) throw new Error('openPairing must be false or { maxPeers, privateAddresses? }, maxPeers a whole number above 0');
  /** How this hub proposes to be called by a hub it pairs itself with: its name, or one made of its address. */
  const ownName = () => {
    if (cfg.name) return cfg.name;
    const { hostname, port } = new URL(publicUrl);
    return `${hostname}${port ? `-${port}` : ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '') || 'hub';
  };
  if (cfg.name != null && !PEER_NAME_RE.test(cfg.name)) throw new Error('name must be 1-32 lowercase letters, digits or hyphens');
  const fetchPeer = cfg.fetch ?? globalThis.fetch;
  const lookupPeer = cfg.lookup ?? lookup;

  // ------------------------------------------------------------------ helpers

  const limited = (key, limit) => {
    if (!limiter.take(key, limit)) {
      throw new HttpError(429, 'rate_limited', 'too many requests, slow down', { retry_after_seconds: Math.ceil(60 / limit.perMinute) });
    }
  };

  // --- abuse: blocks, reports and suspensions -------------------------------------------------------
  const suspendedTopic = (topic) => store.suspended.has(`topic:${topic.name}`);
  /** A topic its operators suspended takes nothing more: no events, no new subscribers. */
  const requireLiveTopic = (topic) => {
    if (suspendedTopic(topic)) throw new HttpError(403, 'topic_suspended', 'the operators of this hub suspended this topic');
  };
  /** Whether `agent` takes nothing from `source`. */
  const blocks = (agent, source) => store.blocks.get(agent)?.has(source) ?? false;
  const requireOperator = (ctx) => {
    if (!cfg.operators.includes(ctx.signer)) throw new HttpError(403, 'not_an_operator', 'only the operators of this hub may do this');
  };

  const getTopic = (name) => {
    const topic = store.topics.get(name);
    if (!topic) throw new HttpError(404, 'topic_not_found', `topic "${String(name).slice(0, 128)}" does not exist`);
    return topic;
  };

  const schemaUrl = (name) => `${publicUrl}/v1/topics/${name}/schema`;

  // --- identity tiers -----------------------------------------------------------
  // An expired delegation counts for nothing: the agent is back to being just a key.
  const activeDelegation = (agent, now = Date.now()) =>
    agent.delegation && Date.parse(agent.delegation.envelope.delegation.expires_at) > now ? agent.delegation : null;

  /** Who the hub has verified to be behind this delegation, or null if nobody. */
  const verifiedAs = (active, now = Date.now()) => {
    const { issuer } = active.envelope.delegation;
    if (active.kind === 'web') return issuer; // the domain proved it by serving the DID document
    if (Object.hasOwn(cfg.verifiedControllers, issuer)) return String(cfg.verifiedControllers[issuer]); // the operator checked it by hand
    // A verifier the operator trusts vouched for it, and still does: in force, and still trusted.
    const attested = store.attestations.get(issuer);
    return attested && Date.parse(attested.expires_at) > now && cfg.trustedVerifiers.includes(attested.verifier) ? attested.account : null;
  };

  const tierOf = (agent, now = Date.now()) => {
    const active = activeDelegation(agent, now);
    if (!active) return 'key';
    if (active.kind === 'web') return 'org';
    return verifiedAs(active, now) === null ? 'key' : 'account';
  };

  // --- quotas: how much an account may do (quota.mjs) ---
  /** The account an agent is part of: the controller behind its delegation, or the agent itself if it has none. */
  const accountOf = (agent, now = Date.now()) => activeDelegation(agent, now)?.envelope.delegation.issuer ?? agent.did;
  const quotaOf = (agent, now = Date.now()) => quotas?.[tierOf(agent, now)] ?? {};
  const overQuota = (status, quota, limit, message, extra = {}) => new HttpError(status, 'quota_exceeded', message, { quota, limit, ...extra });
  const topicsOfAccount = (account, now) => {
    let count = 0;
    for (const topic of store.topics.values()) {
      const owner = store.agents.get(topic.owner);
      if (owner && accountOf(owner, now) === account) count++;
    }
    return count;
  };
  const agentsOfAccount = (account, now, except = null) => {
    let count = 0;
    for (const agent of store.agents.values()) if (agent.status === 'active' && agent.did !== except && accountOf(agent, now) === account && agent.did !== account) count++;
    return count;
  };
  /** One more message or event for the account of the agent that sends it, if its quota allows it. */
  const chargeSend = (agent, now = Date.now()) => {
    const limit = quotaOf(agent, now).sendsPerDay;
    // Counted with no quota too: what an account does is what its operator is told (GET /v1/usage).
    if (!sendsToday.take(accountOf(agent, now), limit ?? Infinity, now)) {
      throw overQuota(429, 'sends_per_day', limit, `this account may send ${limit} messages and events a day`, { resets_at: DailyCounter.resetsAt(now) });
    }
  };
  /** Whether the account of an agent may own one more topic. */
  const requireTopicRoom = (agent, now = Date.now()) => {
    const limit = quotaOf(agent, now).topics;
    if (limit !== undefined && topicsOfAccount(accountOf(agent, now), now) >= limit) throw overQuota(403, 'topics', limit, `this account may own ${limit} topics`);
  };
  /** Whether the controller behind `delegation` may have one more agent acting for it: `did`, which is about to present it. */
  const requireAgentRoom = (did, delegation, now = Date.now()) => {
    const tier = tierOf({ delegation }, now);
    const limit = quotas?.[tier]?.agents;
    const account = delegation.envelope.delegation.issuer;
    if (limit !== undefined && agentsOfAccount(account, now, did) >= limit) throw overQuota(403, 'agents', limit, `this controller may have ${limit} agents acting for it`);
  };

  /** Authentication says who the agent is; the scope its controller signed says what it may do here. */
  /** `target` is the topic for "publish" and "subscribe", and the paired hub for "direct_hub". */
  const requireScope = (ctx, action, target) => {
    const active = activeDelegation(ctx.agent);
    if (active && !scopeAllows(active.envelope.delegation.scope, action, target)) {
      const what = action === 'direct_hub' ? `direct messages to agents of the hub "${target}"` : `"${action}"${target ? ` on ${target}` : ''}`;
      throw new HttpError(403, 'out_of_scope', `the delegation of this agent does not allow ${what}`);
    }
  };

  /**
   * Members of a private topic. With a topic key they are exactly those the owner gave the current
   * key to. Over MLS they are the agents the owner said are in when it last changed the group.
   */
  const membersOf = (topic) => topic.grants[topic.epoch] ?? {};
  const memberAgents = (topic) => (topic.encryption === TOPIC_MLS ? (topic.mls?.agents ?? []) : Object.keys(membersOf(topic)));
  const isMember = (topic, did) => memberAgents(topic).includes(did);
  /** Where a private topic is: the generation of its key or, over MLS, the epoch of its group. 0 = not set up yet. */
  const topicEpoch = (topic) => (topic.encryption === TOPIC_MLS ? (topic.mls ? store.mlsLog(topic.mls.group).epoch : 0) : topic.epoch);

  const mayRead = (topic, agent, now = Date.now()) => {
    if (agent.status === 'revoked') return false;
    if (topic.encryption) return isMember(topic, agent.did);
    return policyAllows(topic.subscribe, { did: agent.did, tier: tierOf(agent, now), owner: topic.owner });
  };

  /**
   * Verifies a delegation presented by `did` and returns what the store keeps about it. `now` is
   * when: the entry it leaves in the log has to carry that same time, which is when it was good.
   * Checking one signed in the name of a domain can take a while.
   */
  const checkDelegationFor = async (did, envelope, now) => {
    const verdict = await verifyDelegation(envelope, { resolveDidWeb, now, maxValidityMs, clockSkewMs: cfg.clockSkewMs });
    if (!verdict.ok) {
      throw verdict.unresolved
        ? new HttpError(502, 'issuer_unresolved', `delegation rejected: ${verdict.error}`)
        : new HttpError(400, 'invalid_delegation', `delegation rejected: ${verdict.error}`);
    }
    const { delegation, proof } = envelope;
    requireBareProof(proof, 'invalid_delegation', 'delegation');
    if (delegation.subject !== did) throw new HttpError(400, 'invalid_delegation', 'this delegation was issued to a different agent');
    if (store.isDelegationRevoked(delegation)) throw new HttpError(403, 'delegation_revoked', 'this delegation cannot be presented again: its issuer revoked it, or this agent dropped it');
    return { envelope: { delegation, proof }, kind: verdict.kind };
  };

  /** Ends the stream of one reader, telling it why. */
  const cutStream = (reader, event) => {
    const res = streams.get(reader);
    if (!res) return;
    streams.delete(reader);
    res.write(`event: ${event}\ndata: {}\n\n`);
    res.end();
  };

  /** An agent is online while its own key or any of its instances holds a stream. */
  const isOnline = (did) => store.readersOf(did).some((reader) => streams.has(reader));

  /**
   * Retires an agent identity for good and cuts its live connections, those of its instances included.
   * It goes on record with what makes it so: the `revocation` of its controller, or its own `statement`.
   */
  const revokeAgent = (did, { by, reason = null, revocation = null, statement = null }) => {
    const result = store.commit({ type: 'agent.revoke', did, by, reason, revocation, statement, at: new Date().toISOString() });
    for (const reader of store.readersOf(did)) cutStream(reader, 'revoked');
    log(`revoked ${did} (by ${by}${reason ? `: ${printed(reason)}` : ''}); ${result.purged} undelivered message(s) dropped`);
    return result;
  };

  const topicView = (topic, { withSchema = true } = {}) => ({
    name: topic.name,
    description: topic.description,
    owner: topic.owner,
    publish: topic.publish,
    subscribe: topic.subscribe,
    encryption: topic.encryption,
    hub: identity.did, // the hub this topic lives on: its events say so, and it is the same from every hub that reaches it
    ...(topic.encryption ? { epoch: topicEpoch(topic), members: memberAgents(topic).length } : {}),
    created_at: topic.created_at,
    subscribers: store.subs.get(topic.name).size,
    last_seq: topic.seq,
    revision: topic.revision, // how many changes its owner has signed for: the next one says one more
    schema_url: schemaUrl(topic.name),
    ...(withSchema ? { schema: topic.schema } : {}),
  });

  const instanceView = (instance) => ({
    did: instance.did,
    // The certificate travels whole: anyone can check that the agent signed it without trusting the hub.
    certificate: { certificate: instance.certificate, proof: instance.proof },
    registered_at: instance.registered_at,
    online: streams.has(instance.did),
  });

  const agentView = (agent, { withInstances = false } = {}) => {
    const active = activeDelegation(agent);
    return {
      did: agent.did,
      tier: tierOf(agent),
      status: agent.status,
      card: agent.card,
      proof: agent.proof,
      // The delegation travels whole, so anyone can check the controller's signature without trusting the hub.
      controller: active ? { did: active.envelope.delegation.issuer, verified_as: verifiedAs(active) } : null,
      delegation: active ? active.envelope : null,
      ...(agent.revoked ? { revoked: agent.revoked } : {}),
      // Who may hand it over to a successor, whom it was handed over to, and whom it took over from: each is in the log.
      guardian: agent.guardian ?? null,
      succeeded_by: agent.successor ?? null,
      predecessor: agent.predecessor ?? null,
      registered_at: agent.registered_at,
      updated_at: agent.updated_at,
      online: isOnline(agent.did),
      last_seen: lastSeen.has(agent.did) ? new Date(lastSeen.get(agent.did)).toISOString() : null,
      ...(withInstances ? { instances: store.instancesOf(agent.did).map(instanceView) } : {}),
    };
  };

  /**
   * The A2A card an agent signed for this hub (core/a2a.mjs), or null if its card carries no signature
   * that is its own over exactly that. A hub that only listens on this machine answers to more than one
   * name: the card is the one for the name the agent signed.
   */
  const ownA2ACard = (card) => {
    for (const origin of ownOrigins()) {
      const signed = signedA2ACard(card, origin);
      if (signed) return signed;
    }
    return null;
  };
  /** An agent that brings a signature of its A2A card brings the one for this hub: no other would ever be served. */
  const requireOwnA2A = (card) => {
    if (card.a2a !== undefined && ownA2ACard(card) === null) {
      throw new HttpError(400, 'invalid_card', 'card.a2a is not the signature of this agent over its A2A card on this hub');
    }
  };

  const agentText = (agent) => {
    const skills = (agent.card.skills ?? []).map((skill) => `${skill.name} ${skill.description ?? ''}`).join(' ');
    return `${agent.card.name} ${agent.card.name} ${agent.card.description ?? ''} ${skills}`;
  };

  const writeItem = (res, item) => res.write(`id: ${item.seq}\nevent: message\ndata: ${JSON.stringify(item)}\n\n`);

  /** Pushes freshly enqueued inbox entries to the readers that are connected right now. */
  const push = (deliveries) => {
    for (const { items } of deliveries) {
      for (const { reader, item } of items) {
        const res = streams.get(reader);
        if (!res) continue;
        if (res.writableLength > 8 * 1024 * 1024) {
          res.destroy(); // reader is not keeping up; it will reconnect and catch up from its inbox
          continue;
        }
        writeItem(res, item);
      }
    }
  };

  const ackUpTo = (reader, seq) => {
    const inbox = store.inboxes.get(reader);
    const bounded = Math.min(seq, inbox.next - 1);
    if (inbox.items.length > 0 && inbox.items[0].seq <= bounded) store.commit({ type: 'inbox.ack', did: reader, seq: bounded });
  };

  /** Some things only the agent key may do: an instance acts as the agent, it does not decide who the agent is. */
  const requireAgentKey = (ctx) => {
    if (ctx.instance) throw new HttpError(403, 'agent_key_required', 'this must be signed with the agent key, not with the key of an instance');
  };

  /**
   * The statement a request carries for the change it asks for (core/statement.mjs), in its clean
   * form. It has to say exactly `says`, for this hub, and be signed with the key that signed the
   * request: it goes on record as what that agent said, for anybody to check.
   */
  const acceptStatement = (ctx, kind, says) => {
    const envelope = ctx.body.length > 0 ? ctx.json().statement : undefined;
    const verdict = verifyStatement(kind, envelope, { hub: identity.did, says });
    if (!verdict.ok) throw new HttpError(400, 'invalid_statement', `the statement of this change is rejected: ${verdict.error}`);
    // No relaying what another key of the agent signed, as with what it publishes.
    if (verdict.signer !== ctx.signer) throw new HttpError(403, 'signer_mismatch', 'the statement must be signed with the same key as the request');
    return { statement: envelope.statement, proof: envelope.proof };
  };

  /** An agent that was handed over takes nothing more: whoever writes to it is told so, and to whom, which is in its record. */
  const refuseSucceeded = (agent) => {
    if (agent?.successor) throw new HttpError(404, 'recipient_succeeded', 'the recipient was handed over to a successor: it is that one to write to now', { successor: agent.successor });
  };
  /** What is for an agent that is not there to take it is refused. */
  const requireRecipient = (did) => {
    const agent = store.agents.get(did);
    if (agent?.status === 'active') return;
    refuseSucceeded(agent);
    throw new HttpError(404, 'recipient_not_found', 'the recipient is not registered on this hub');
  };

  /** Checks a signed envelope sent by the authenticated agent and returns its clean form. */
  const acceptEnvelope = (ctx, now) => {
    const body = ctx.json();
    const verdict = verifyEventEnvelope(body, { now });
    if (!verdict.ok) throw new HttpError(400, 'invalid_envelope', `envelope rejected: ${verdict.error}`);
    if (verdict.did !== ctx.did) throw new HttpError(403, 'signer_mismatch', 'the envelope must be signed by the agent making the request');
    // The key that signed the request is the one that must have signed the content: no relaying for another instance.
    if ((verdict.instance ?? null) !== ctx.instance) throw new HttpError(403, 'signer_mismatch', 'the envelope must be signed with the same key as the request');
    validateEvent(body.event, cfg, now);
    return { event: body.event, proof: body.proof };
  };

  // ------------------------------------------------------------------- routes

  const routes = [];
  /** `maxBody` raises the size limit of the request for the few routes that carry something large. */
  const route = (method, pattern, auth, handler, { maxBody } = {}) => routes.push({ method, parts: pattern.split('/').slice(1), auth, handler, maxBody });

  route('GET', '/healthz', false, () => ({ body: { ok: true } }));

  route('GET', '/v1/info', false, () => ({
    body: {
      name: 'agent-hub',
      version: VERSION,
      protocol: 'agenthub/v1',
      // Requests are signed for the address of the hub: these are the ones this hub takes.
      requests: { signature: REQUEST_SIGNATURE, origins: [...ownOrigins()] },
      quotas, // per tier, null if this hub sets none: see GET /v1/usage for an account's
      server_time: new Date().toISOString(),
      pow_difficulty: cfg.powDifficulty,
      tiers: TIERS,
      topic_create_min_tier: cfg.topicCreateMinTier,
      max_delegation_days: cfg.maxDelegationDays,
      direct_encryption: { supported: [DIRECT_MLS, DIRECT_ENCRYPTION], required: cfg.requireDirectEncryption },
      topic_encryption: { supported: [TOPIC_MLS, GROUP_ENCRYPTION], max_members: cfg.maxPrivateTopicMembers, max_group_readers: cfg.maxTopicGroupReaders },
      instances: { max_per_agent: cfg.maxInstancesPerAgent, max_days: cfg.maxInstanceDays },
      // What the operator of another hub needs to pair with this one, besides its address.
      hub: { did: identity.did },
      // The agents that signed one have their card as A2A reads it at /a2a/<did>/.well-known/agent-card.json.
      a2a: { version: A2A_VERSION, binding: A2A_BINDING },
      federation: { protocol: FEDERATION_PROTOCOL, peers: peers.size, open_pairing: cfg.openPairing !== false },
      // The transparency log: every change to the directory, signed for by the hub with the key above.
      // `signed_from`: the entry from which each change carries the statement of the agent that made it.
      // `origin` is how its checkpoints name it for witnesses (GET /v1/log/note), and `witnesses` who this
      // hub shows them to: whom to believe is for whoever reads the log to decide, not for the hub to say.
      log: { entries: store.log.length, signed_from: store.logSignedFrom, origin: identity.did, witnesses: witnesses.map((witness) => formatVerifier(witness.verifier)) },
      limits: {
        max_body_bytes: cfg.maxBodyBytes,
        max_topics_per_agent: cfg.maxTopicsPerAgent,
        max_subscriptions_per_agent: cfg.maxSubscriptionsPerAgent,
        topic_retention_events: cfg.topicRetention,
        inbox_capacity: cfg.inboxCap,
        clock_skew_ms: cfg.clockSkewMs,
      },
      stats: { agents: store.agents.size, topics: store.topics.size, online: streams.size },
    },
  }));

  // --- registration -----------------------------------------------------------

  route('POST', '/v1/challenges', false, (ctx) => {
    limited(`challenge:${ctx.ip}`, cfg.limits.challenge);
    const now = Date.now();
    if (challenges.size > 10_000) {
      for (const [challenge, expiry] of challenges) if (expiry < now) challenges.delete(challenge);
      if (challenges.size > 10_000) throw new HttpError(503, 'busy', 'too many outstanding challenges, retry shortly');
    }
    const challenge = randomBytes(16).toString('base64url');
    challenges.set(challenge, now + cfg.challengeTtlMs);
    return { status: 201, body: { challenge, difficulty: cfg.powDifficulty, expires_at: new Date(now + cfg.challengeTtlMs).toISOString() } };
  });

  route('POST', '/v1/agents', 'key', async (ctx) => {
    limited(`register:${ctx.ip}`, cfg.limits.register);
    if (ctx.agent) throw new HttpError(409, 'already_registered', 'this agent is already registered; use PUT /v1/agents/me to update its card');
    if (peerByDid(ctx.did)) throw new HttpError(409, 'hub_conflict', 'this key is the key of a hub that this one is paired with; a hub is not an agent of another');
    const body = ctx.json();
    const expiry = challenges.get(body.challenge);
    if (typeof body.challenge !== 'string' || expiry === undefined || expiry < Date.now()) {
      throw new HttpError(400, 'invalid_challenge', 'unknown or expired challenge; request a new one');
    }
    challenges.delete(body.challenge); // single use, whatever happens next
    if (!verifyPow(body.challenge, ctx.did, body.pow_nonce, cfg.powDifficulty)) {
      throw new HttpError(400, 'invalid_proof_of_work', 'proof of work does not meet the required difficulty');
    }
    const verdict = verifyCardEnvelope(body.card_envelope);
    if (!verdict.ok) throw new HttpError(400, 'invalid_card', `card rejected: ${verdict.error}`);
    requireBareProof(body.card_envelope.proof, 'invalid_card', 'card');
    validateCard(body.card_envelope.card, ctx.did);
    requireOwnA2A(body.card_envelope.card);
    const now = Date.now();
    const delegation = body.delegation === undefined ? null : await checkDelegationFor(ctx.did, body.delegation, now);
    if (delegation) requireAgentRoom(ctx.did, delegation, now);
    const at = new Date(now).toISOString();
    store.commit({ type: 'agent.put', did: ctx.did, card: body.card_envelope.card, proof: body.card_envelope.proof, at });
    if (delegation) store.commit({ type: 'agent.delegation', did: ctx.did, ...delegation, at });
    log(`registered ${ctx.did} (${printed(body.card_envelope.card.name)}, tier ${tierOf(store.agents.get(ctx.did))})`);
    return { status: 201, body: agentView(store.agents.get(ctx.did)) };
  });

  route('PUT', '/v1/agents/me', 'registered', (ctx) => {
    requireAgentKey(ctx);
    limited(`card:${ctx.did}`, cfg.limits.card);
    const body = ctx.json();
    const verdict = verifyCardEnvelope(body.card_envelope);
    if (!verdict.ok) throw new HttpError(400, 'invalid_card', `card rejected: ${verdict.error}`);
    requireBareProof(body.card_envelope.proof, 'invalid_card', 'card');
    validateCard(body.card_envelope.card, ctx.did);
    requireOwnA2A(body.card_envelope.card);
    store.commit({ type: 'agent.put', did: ctx.did, card: body.card_envelope.card, proof: body.card_envelope.proof, at: new Date().toISOString() });
    return { body: agentView(store.agents.get(ctx.did)) };
  });

  // --- delegation and revocation ------------------------------------------------

  route('PUT', '/v1/agents/me/delegation', 'registered', async (ctx) => {
    requireAgentKey(ctx);
    limited(`delegation:${ctx.did}`, cfg.limits.delegation);
    const now = Date.now();
    const delegation = await checkDelegationFor(ctx.did, ctx.json().delegation, now);
    if (store.agents.get(ctx.did)?.status !== 'active') throw new HttpError(403, 'agent_revoked', 'this agent has been revoked');
    requireAgentRoom(ctx.did, delegation, now);
    store.commit({ type: 'agent.delegation', did: ctx.did, ...delegation, at: new Date(now).toISOString() });
    const agent = store.agents.get(ctx.did);
    log(`${ctx.did} now acts for ${delegation.envelope.delegation.issuer} (tier ${tierOf(agent)})`);
    return { body: agentView(agent) };
  });

  // How much of its quotas the account of an agent has used. An account is the controller behind the
  // agent's delegation, shared by every agent it delegates; or the agent itself, if it has none.
  route('GET', '/v1/usage', 'registered', (ctx) => {
    const now = Date.now();
    const account = accountOf(ctx.agent, now);
    const quota = quotaOf(ctx.agent, now);
    const limit = (name) => quota[name] ?? null;
    return {
      body: {
        account,
        tier: tierOf(ctx.agent, now),
        quotas: { sends_per_day: limit('sendsPerDay'), topics: limit('topics'), agents: limit('agents') },
        used: { sends_today: sendsToday.used(account, now), topics: topicsOfAccount(account, now), agents: account === ctx.agent.did ? 1 : agentsOfAccount(account, now) },
        resets_at: DailyCounter.resetsAt(now),
      },
    };
  });

  // --- blocks: an agent takes nothing more from a DID, of this hub or of another ---
  const MAX_BLOCKS = 1000;
  const blockTarget = (ctx) => {
    const did = ctx.params.did;
    if (!isValidDid(did)) throw new HttpError(400, 'invalid_parameter', 'what is blocked is the DID of an agent');
    if (did === ctx.did) throw new HttpError(400, 'invalid_parameter', 'an agent does not block itself');
    return did;
  };
  route('PUT', '/v1/blocks/:did', 'registered', (ctx) => {
    limited(`block:${ctx.did}`, cfg.limits.block);
    const did = blockTarget(ctx);
    if (!blocks(ctx.did, did)) {
      if ((store.blocks.get(ctx.did)?.size ?? 0) >= MAX_BLOCKS) throw new HttpError(403, 'quota_exceeded', `an agent blocks at most ${MAX_BLOCKS} others`);
      store.commit({ type: 'block.put', agent: ctx.did, blocked: did });
    }
    return { body: { blocked: did } };
  });
  route('DELETE', '/v1/blocks/:did', 'registered', (ctx) => {
    limited(`block:${ctx.did}`, cfg.limits.block);
    const did = blockTarget(ctx);
    if (blocks(ctx.did, did)) store.commit({ type: 'block.drop', agent: ctx.did, blocked: did });
    return { body: { unblocked: did } };
  });
  route('GET', '/v1/blocks', 'registered', (ctx) => ({ body: { blocked: [...(store.blocks.get(ctx.did) ?? [])] } }));

  // --- reports: an agent tells the operators of this hub about an agent or a topic ---
  const REPORT_REASONS = ['spam', 'abuse', 'illegal', 'other'];
  route('POST', '/v1/reports', 'registered', (ctx) => {
    limited(`report:${ctx.did}`, cfg.limits.report);
    const body = ctx.json();
    const target = body.target;
    const isTarget = typeof target === 'string' && (isValidDid(target) || TOPIC_NAME_RE.test(target));
    if (!isTarget) throw new HttpError(400, 'invalid_report', 'target is the DID of an agent or the name of a topic of this hub');
    if (!REPORT_REASONS.includes(body.reason)) throw new HttpError(400, 'invalid_report', `reason is one of ${REPORT_REASONS.join(', ')}`);
    if (body.event !== undefined && (typeof body.event !== 'string' || !EVENT_ID_RE.test(body.event))) throw new HttpError(400, 'invalid_report', 'event is the id of an event');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) throw new HttpError(400, 'invalid_report', 'note is a text of up to 500 characters');
    const report = {
      id: randomBytes(9).toString('base64url'),
      by: ctx.did,
      target,
      reason: body.reason,
      event: body.event ?? null,
      note: body.note?.replace(/[\u0000-\u001f\u007f]/g, ' ') ?? null,
      at: new Date().toISOString(),
    };
    store.commit({ type: 'report.put', report, keep: 10_000 });
    return { status: 201, body: { id: report.id } };
  });

  // --- moderation: what the operators of this hub do. What it suspends is the hub's own decision about
  // who uses it, like its quotas: it is not on the transparency log, which says who is who, not who may come in.
  route('GET', '/v1/admin/reports', 'signed', (ctx) => {
    requireOperator(ctx);
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 50, 500);
    return { body: { reports: store.reports.slice(-limit).reverse() } };
  });
  const moderationTarget = (ctx) => {
    const target = ctx.params.target;
    const [kind, ...rest] = target.split(':');
    const name = rest.join(':');
    const ok = (kind === 'agent' && isValidDid(name)) || (kind === 'topic' && TOPIC_NAME_RE.test(name));
    if (!ok) throw new HttpError(400, 'invalid_parameter', 'what is suspended is "agent:<did>" or "topic:<name>"');
    return target;
  };
  route('PUT', '/v1/admin/suspensions/:target', 'signed', (ctx) => {
    requireOperator(ctx);
    const target = moderationTarget(ctx);
    const reason = ctx.json().reason;
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 500) throw new HttpError(400, 'invalid_parameter', 'reason is a text of 1 to 500 characters');
    store.commit({ type: 'moderation.put', target, by: ctx.signer, reason, at: new Date().toISOString() });
    if (target.startsWith('agent:')) {
      const did = target.slice('agent:'.length);
      for (const reader of [did, ...store.instancesOf(did).map((instance) => instance.did ?? instance)]) cutStream(reader, 'suspended');
    }
    log(`${target} suspended by ${ctx.signer}`);
    return { body: { suspended: target } };
  });
  route('DELETE', '/v1/admin/suspensions/:target', 'signed', (ctx) => {
    requireOperator(ctx);
    const target = moderationTarget(ctx);
    if (store.suspended.has(target)) store.commit({ type: 'moderation.drop', target });
    log(`${target} no longer suspended (by ${ctx.signer})`);
    return { body: { unsuspended: target } };
  });
  // What an account has used of its quotas, for the operators: what GET /v1/usage tells each agent of its own.
  route('GET', '/v1/admin/accounts/:account', 'signed', (ctx) => {
    requireOperator(ctx);
    const account = ctx.params.account;
    // A controller is a did:key, or the did:web of an organization.
    if (!isValidDid(account) && !(isDidWeb(account) && account.length <= 300)) throw new HttpError(400, 'invalid_parameter', 'an account is the DID of a controller, or of an agent with no delegation');
    const now = Date.now();
    const agents = [...store.agents.values()].filter((agent) => agent.status === 'active' && accountOf(agent, now) === account).map((agent) => agent.did);
    return { body: { account, agents, used: { sends_today: sendsToday.used(account, now), topics: topicsOfAccount(account, now), agents: agents.length }, resets_at: DailyCounter.resetsAt(now) } };
  });

  route('GET', '/v1/admin/suspensions', 'signed', (ctx) => {
    requireOperator(ctx);
    return { body: { suspended: [...store.suspended].map(([target, held]) => ({ target, ...held })) } };
  });

  // The agent says which delegation it drops, and that one cannot be presented again. One that has
  // run out is not held any more: there is nothing to drop.
  route('DELETE', '/v1/agents/me/delegation', 'registered', (ctx) => {
    requireAgentKey(ctx);
    const held = activeDelegation(ctx.agent)?.envelope.delegation;
    if (held) {
      const statement = acceptStatement(ctx, 'delegation.drop', { agent: ctx.did, issuer: held.issuer, delegation_id: held.id });
      store.commit({ type: 'agent.delegation', did: ctx.did, envelope: null, statement, at: new Date().toISOString() });
    }
    return { body: agentView(ctx.agent) };
  });

  // An agent can retire its own identity, e.g. when it suspects its key has leaked.
  route('DELETE', '/v1/agents/me', 'registered', (ctx) => {
    requireAgentKey(ctx);
    const statement = acceptStatement(ctx, 'retire', { agent: ctx.did });
    revokeAgent(ctx.did, { by: ctx.did, reason: 'retired by the agent itself', statement });
    return { body: agentView(ctx.agent) };
  });

  // --- guardian and succession ----------------------------------------------------
  // An agent is its key. One whose key is lost or stolen can go on as another agent, its successor:
  // the handing over is signed and on record, so whoever knew the first can tell that the second is
  // it. Who may sign it is the guardian the agent named - a key kept apart, or its controller's - or
  // the agent itself if it named none: with a guardian, whoever steals the key of the agent cannot
  // hand it over. The rules are in core/log.mjs; a hub cannot make any of this up.

  route('PUT', '/v1/agents/me/guardian', 'registered', (ctx) => {
    requireAgentKey(ctx);
    limited(`card:${ctx.did}`, cfg.limits.card);
    const { guardian } = ctx.json();
    if (!isValidDid(guardian) || guardian === ctx.did) throw new HttpError(400, 'invalid_guardian', 'a guardian is a did:key, and another than the one of the agent');
    if (ctx.agent.guardian) throw new HttpError(409, 'guardian_named', 'this agent has already named its guardian: it is named once');
    const statement = acceptStatement(ctx, 'agent.guardian', { agent: ctx.did, guardian });
    store.commit({ type: 'agent.guardian', did: ctx.did, guardian, statement, at: new Date().toISOString() });
    log(`${ctx.did} named its guardian`);
    return { body: agentView(ctx.agent) };
  });

  // Asked by the successor, which brings what whoever may hand the agent over signed, and signs that it takes it.
  route('POST', '/v1/agents/me/succession', 'registered', (ctx) => {
    requireAgentKey(ctx);
    limited(`card:${ctx.did}`, cfg.limits.card);
    const body = ctx.json();
    const handed = isValidDid(body.agent) ? store.agents.get(body.agent) : undefined;
    if (!handed) throw new HttpError(404, 'agent_not_found', 'no agent is registered with that DID');
    if (handed.did === ctx.did) throw new HttpError(400, 'invalid_succession', 'an agent is not its own successor');
    if (handed.successor) throw new HttpError(409, 'already_succeeded', 'that agent has already been handed over');
    if (ctx.agent.predecessor) throw new HttpError(409, 'already_a_successor', 'this agent has already taken over from another');
    // The key of an agent that was retired may be anybody's by now: only a guardian it named before hands it over.
    if (handed.status !== 'active' && !handed.guardian) throw new HttpError(409, 'agent_retired', 'that agent was retired and had named no guardian: it cannot be handed over any more');
    // An agent the operators stopped is not got going again under another key: they are asked first.
    if (store.suspended.has(`agent:${handed.did}`)) throw new HttpError(403, 'agent_suspended', 'the operators of this hub suspended that agent');
    const says = { agent: handed.did, successor: ctx.did };
    const given = verifyStatement('agent.succeed', body.statement, { hub: identity.did, says });
    if (!given.ok) throw new HttpError(400, 'invalid_statement', `the statement that hands the agent over is rejected: ${given.error}`);
    if (given.signer !== (handed.guardian ?? handed.did)) {
      throw new HttpError(403, 'not_the_guardian', handed.guardian ? 'that agent named a guardian: only it can hand the agent over' : 'that agent named no guardian: it is handed over with its own key');
    }
    const taken = verifyStatement('succession.accept', body.acceptance, { hub: identity.did, says });
    if (!taken.ok) throw new HttpError(400, 'invalid_statement', `the statement that takes the agent over is rejected: ${taken.error}`);
    if (taken.signer !== ctx.signer) throw new HttpError(403, 'signer_mismatch', 'the statement must be signed with the same key as the request');
    const bare = ({ statement, proof }) => ({ statement, proof });
    store.commit({ type: 'agent.succeed', did: handed.did, successor: ctx.did, by: given.signer, statement: bare(body.statement), acceptance: bare(body.acceptance), at: new Date().toISOString() });
    for (const reader of store.readersOf(handed.did)) cutStream(reader, 'revoked');
    log(`${handed.did} was handed over to ${ctx.did}${handed.guardian ? ', by its guardian' : ''}`);
    return { status: 201, body: agentView(ctx.agent) };
  });

  // --- instances ----------------------------------------------------------------
  // An instance registers itself: the request is signed with its own key (proof that it holds it)
  // and carries the certificate its agent signed (proof that the agent wants it). The agent key is
  // not needed here, which is the point: it does not have to live where the agent runs.

  route('PUT', '/v1/instances/me', 'signed', (ctx) => {
    limited(`instance:${ctx.ip}`, cfg.limits.instance);
    const envelope = ctx.json().certificate;
    const now = Date.now(); // the entry this leaves in the log carries the time the certificate was checked at
    const verdict = verifyInstanceCertificate(envelope, { instance: ctx.signer, now, maxValidityMs: maxInstanceValidityMs, clockSkewMs: cfg.clockSkewMs });
    if (!verdict.ok) throw new HttpError(400, 'invalid_certificate', `certificate rejected: ${verdict.error}`);
    const { certificate, proof } = envelope;
    requireBareProof(proof, 'invalid_certificate', 'certificate');
    const agent = store.agents.get(certificate.agent);
    if (!agent) throw new HttpError(404, 'agent_not_found', 'the agent that signed this certificate is not registered on this hub');
    if (agent.status !== 'active') throw new HttpError(403, 'agent_revoked', 'the agent that signed this certificate has been revoked');
    if (store.removedInstances.has(ctx.signer)) throw new HttpError(403, 'instance_removed', 'this instance was removed; an instance key that was removed cannot come back');
    if (store.agents.has(ctx.signer)) throw new HttpError(409, 'instance_conflict', 'this key is registered as an agent; it cannot also be an instance');
    if (peerByDid(ctx.signer)) throw new HttpError(409, 'hub_conflict', 'this key is the key of a hub that this one is paired with; a hub is not an instance of an agent');
    const existing = store.instances.get(ctx.signer);
    if (existing && existing.agent !== agent.did) throw new HttpError(409, 'instance_conflict', 'this key is already an instance of another agent');
    if (!existing && store.instancesOf(agent.did).length >= cfg.maxInstancesPerAgent) {
      throw new HttpError(403, 'quota_exceeded', `an agent can have at most ${cfg.maxInstancesPerAgent} instances`);
    }
    store.commit({ type: 'instance.put', did: ctx.signer, agent: agent.did, certificate, proof, at: new Date(now).toISOString() });
    if (!existing) log(`instance ${ctx.signer} registered for ${agent.did}${certificate.name ? ` (${printed(certificate.name)})` : ''}`);
    return { status: existing ? 200 : 201, body: { agent: agent.did, ...instanceView(store.instances.get(ctx.signer)) } };
  });

  // Removing an instance is for good. The agent key can remove any of its instances; an instance can remove itself.
  route('DELETE', '/v1/instances/:did', 'registered', (ctx) => {
    const instance = store.instances.get(ctx.params.did);
    if (!instance || instance.agent !== ctx.did) throw new HttpError(404, 'instance_not_found', 'this agent has no such instance');
    if (ctx.instance !== null && ctx.instance !== instance.did) requireAgentKey(ctx);
    const statement = acceptStatement(ctx, 'instance.remove', { agent: ctx.did, instance: instance.did });
    store.commit({ type: 'instance.remove', did: instance.did, by: ctx.signer, statement, at: new Date().toISOString() });
    cutStream(instance.did, 'removed');
    log(`instance ${instance.did} of ${ctx.did} removed (by ${ctx.signer})`);
    return { body: { agent: ctx.did, did: instance.did, removed: true } };
  });

  // An attestation authenticates itself, like a revocation: what matters is the verifier's signature, not who
  // delivers it. A verifier hands it to the controller it vouches for, which hands it to whichever hubs it likes.
  route('POST', '/v1/attestations', false, (ctx) => {
    limited(`attest:${ctx.ip}`, cfg.limits.attest);
    const body = ctx.json();
    const verdict = verifyAttestation(body);
    if (!verdict.ok) throw new HttpError(400, 'invalid_attestation', `attestation rejected: ${verdict.error}`);
    requireBareProof(body.proof, 'invalid_attestation', 'attestation');
    if (!cfg.trustedVerifiers.includes(verdict.verifier)) throw new HttpError(403, 'verifier_not_trusted', 'this hub does not take the attestations of that verifier');
    const now = Date.now();
    if (Date.parse(verdict.issued_at) > now + cfg.clockSkewMs) throw new HttpError(400, 'invalid_attestation', 'attestation rejected: it was issued in the future');
    if (Date.parse(verdict.expires_at) <= now) throw new HttpError(400, 'attestation_expired', 'this attestation has run out: ask the verifier for a new one');
    if (peerByDid(verdict.controller)) throw new HttpError(409, 'hub_conflict', 'that key is the key of a hub this one is paired with');
    const held = store.attestations.get(verdict.controller);
    // Each one that is taken stays in the log: one that is not newer than the last changes nothing.
    if (!held || Date.parse(held.issued_at) < Date.parse(verdict.issued_at)) {
      store.commit({ type: 'controller.attest', envelope: { attestation: body.attestation, proof: body.proof }, at: new Date(now).toISOString() });
      log(`${verdict.controller} is a verified account, as ${verdict.verifier} attests until ${verdict.expires_at}`);
    }
    const current = store.attestations.get(verdict.controller);
    return { body: { controller: verdict.controller, account: current.account, expires_at: current.expires_at, recorded: current.issued_at === verdict.issued_at } };
  });

  // Revocations authenticate themselves: what matters is the issuer's signature, not who delivers them.
  // That is the point - the controller needs no access to the agent's machine, or to its key.
  route('POST', '/v1/revocations', false, async (ctx) => {
    limited(`revoke:${ctx.ip}`, cfg.limits.revoke);
    const body = ctx.json();
    const verdict = await verifyRevocation(body, { resolveDidWeb });
    if (!verdict.ok) {
      throw verdict.unresolved
        ? new HttpError(502, 'issuer_unresolved', `revocation rejected: ${verdict.error}`)
        : new HttpError(400, 'invalid_revocation', `revocation rejected: ${verdict.error}`);
    }
    const { revocation, proof } = body;
    requireBareProof(proof, 'invalid_revocation', 'revocation');
    const agent = store.agents.get(revocation.subject);
    const current = agent?.delegation?.envelope.delegation;
    const applies = agent?.status === 'active' && current?.id === revocation.delegation_id && current.issuer === revocation.issuer;
    if (applies) {
      revokeAgent(agent.did, { by: revocation.issuer, reason: revocation.reason ?? null, revocation: { revocation, proof } });
    } else if (!store.isDelegationRevoked({ issuer: revocation.issuer, id: revocation.delegation_id })) {
      // Not the delegation the agent is using (or not attached yet): remember it so it can never be presented.
      store.commit({ type: 'delegation.revoke', issuer: revocation.issuer, delegation_id: revocation.delegation_id, revocation: { revocation, proof }, at: new Date().toISOString() });
    }
    return { status: applies ? 201 : 200, body: { delegation_id: revocation.delegation_id, subject: revocation.subject, agent_revoked: applies } };
  });

  route('GET', '/v1/revocations', false, (ctx) => {
    const after = parseSeq(ctx.url.searchParams.get('after'), 'after') ?? 0;
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 100, 500);
    return { body: { revocations: store.revocations.filter((entry) => entry.seq > after).slice(0, limit), last_seq: store.revocations.at(-1)?.seq ?? 0 } };
  });

  // --- directory --------------------------------------------------------------

  /** The agents of this hub that can be found, as something to search among: { text, view }. Oldest first. */
  const searchableAgents = () => [...store.agents.values()].filter((agent) => agent.status === 'active' && !store.suspended.has(`agent:${agent.did}`)).map((agent) => ({ text: agentText(agent), view: agentView(agent) }));

  // With `local=1` only the agents of this hub. Otherwise also those of the hubs it is paired
  // with: each says which hub it is on, and the address to write to it at ("did@peer").
  route('GET', '/v1/agents', 'optional', async (ctx) => {
    limited(`search:${ctx.ip}`, cfg.limits.search);
    const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 200);
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 10, 50);
    const elsewhere = ctx.url.searchParams.get('local') !== '1' && peers.size > 0;
    const { found, unreachable } = elsewhere ? await searchPeers(ctx, REMOTE_AGENTS, query, limit) : { found: [], unreachable: [] };
    const own = searchableAgents();
    const agents = query.trim() ? matching(query, [...own, ...found]) : [...own.reverse(), ...found].map(({ view }) => view);
    return { body: { agents: agents.slice(0, limit), ...(unreachable.length > 0 ? { unreachable } : {}) } };
  });

  route('GET', '/v1/agents/:did', 'optional', async (ctx) => {
    const remote = remoteAddress(ctx.params.did);
    if (remote) return { body: await remoteAgent(remote, ctx) };
    const agent = store.agents.get(ctx.params.did);
    if (!agent) throw new HttpError(404, 'agent_not_found', 'no agent is registered with that DID');
    return { body: agentView(agent, { withInstances: true }) };
  });

  // The card of an agent of this hub as A2A reads one, at the path an A2A client makes from "the
  // address of the agent" (`<hub>/a2a/<did>`). Only what the agent signed for this hub is served:
  // the hub writes none of it, and an agent it would not show in a search has none.
  route('GET', '/a2a/:did/.well-known/agent-card.json', false, (ctx) => {
    const agent = store.agents.get(ctx.params.did);
    if (!agent) throw new HttpError(404, 'agent_not_found', 'no agent is registered with that DID');
    const card = agent.status === 'active' && !store.suspended.has(`agent:${agent.did}`) ? ownA2ACard(agent.card) : null;
    if (!card) throw new HttpError(404, 'no_a2a_card', 'this hub serves no A2A card for that agent');
    const etag = createHash('sha256').update(JSON.stringify(card)).digest('base64url').slice(0, 22);
    return { body: card, headers: { 'cache-control': 'public, max-age=300', etag: `"${etag}"` } };
  });

  /** A topic of this hub as something to search among: { text, view }. */
  const searchable = (topic) => ({ text: `${topic.name} ${topic.name} ${topic.description}`, view: topicView(topic, { withSchema: false }) });

  /** The entries that match `query`, best first. An entry is { text, view }: what comes back is the view, with its score. */
  const matching = (query, entries) => rank(query, entries.map(({ text, view }) => ({ text, ref: view }))).map(({ ref, score }) => ({ ...ref, score }));

  /** The topics of this hub that match `query`, best first; all of them, newest first, if there is no query. */
  const searchTopics = (query, admit = () => true) => {
    const entries = [...store.topics.values()].filter((topic) => admit(topic) && !suspendedTopic(topic)).map(searchable);
    return query.trim() ? matching(query, entries) : entries.reverse().map(({ view }) => view);
  };

  // With `local=1` only the topics of this hub. Otherwise also those of the hubs it is paired
  // with, named "topic@peer": what an agent here can follow there.
  route('GET', '/v1/topics', 'optional', async (ctx) => {
    limited(`search:${ctx.ip}`, cfg.limits.search);
    const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 200);
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 10, 50);
    if (ctx.url.searchParams.get('local') === '1' || peers.size === 0) return { body: { topics: searchTopics(query).slice(0, limit) } };
    const { found, unreachable } = await searchPeers(ctx, REMOTE_TOPICS, query, limit);
    // What the other hubs found is ranked here, with this hub's own and by this hub: how well a
    // topic matches is not something to take from the hub that wants it found.
    const own = [...store.topics.values()].filter((topic) => !suspendedTopic(topic)).map(searchable);
    const topics = query.trim() ? matching(query, [...own, ...found]) : [...own.reverse(), ...found].map(({ view }) => view);
    return { body: { topics: topics.slice(0, limit), ...(unreachable.length > 0 ? { unreachable } : {}) } };
  });

  route('GET', '/v1/topics/:name', 'optional', async (ctx) => {
    const remote = remoteName(ctx.params.name);
    return { body: remote ? await remoteTopic(remote, ctx) : topicView(getTopic(ctx.params.name)) };
  });

  route('GET', '/v1/topics/:name/schema', 'optional', async (ctx) => {
    const remote = remoteName(ctx.params.name);
    return { body: remote ? (await remoteTopic(remote, ctx)).schema : getTopic(ctx.params.name).schema, headers: { 'content-type': 'application/schema+json; charset=utf-8' } };
  });

  route('GET', '/v1/topics/:name/events', 'optional', async (ctx) => {
    const remote = remoteName(ctx.params.name);
    if (remote) {
      // The history of a topic is kept by the hub it lives on: this one asks for it. What comes back
      // is passed on as that hub gave it, for whoever reads it to check, as with anything a hub says.
      const after = parseSeq(ctx.url.searchParams.get('after'), 'after') ?? 0;
      const limit = parseLimit(ctx.url.searchParams.get('limit'), 50, 200);
      rationed(ctx, remote.peer);
      const history = await peerAnswer(remote.peer, 'GET', `/v1/federation/topics/${encodeURIComponent(remote.topic)}/events?after=${after}&limit=${limit}`);
      const events = Array.isArray(history.events) ? history.events.filter(isPlainObject).slice(0, limit) : [];
      return { body: { topic: remote.name, last_seq: count(history.last_seq), events } };
    }
    const topic = getTopic(ctx.params.name);
    if (topic.subscribe !== 'any' || topic.encryption) {
      if (!ctx.agent) throw new HttpError(401, 'unauthenticated', 'this topic restricts who can read it: sign the request as a registered agent');
      if (!mayRead(topic, ctx.agent)) throw new HttpError(403, 'subscribe_not_allowed', 'this topic restricts who can read it');
    }
    const after = parseSeq(ctx.url.searchParams.get('after'), 'after') ?? 0;
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 50, 200);
    return { body: { topic: topic.name, last_seq: topic.seq, events: topic.events.filter((entry) => entry.seq > after).slice(0, limit) } };
  });

  // --- topics -----------------------------------------------------------------

  route('POST', '/v1/topics', 'registered', (ctx) => {
    limited(`topic:${ctx.did}`, cfg.limits.topicCreate);
    const body = ctx.json();
    const bad = (message) => new HttpError(400, 'invalid_topic', message);
    if (typeof body.name !== 'string' || body.name.length > 128 || !TOPIC_NAME_RE.test(body.name)) {
      throw bad('name must be dot-separated lowercase segments, e.g. "dev.rust.code-review.requests"');
    }
    if (body.name.startsWith('agenthub.')) throw bad('the "agenthub." namespace is reserved');
    if (typeof body.description !== 'string' || body.description.trim().length < 10 || body.description.length > 500) {
      throw bad('description must be 10-500 characters: it is what other agents search on');
    }
    const publish = parsePolicy(body.publish, 'publish', { allowOwner: true });
    const subscribe = parsePolicy(body.subscribe, 'subscribe', { allowOwner: false });
    const encryption = body.encryption ?? null;
    if (encryption !== null && encryption !== GROUP_ENCRYPTION && encryption !== TOPIC_MLS) throw bad(`encryption must be "${TOPIC_MLS}", "${GROUP_ENCRYPTION}" or absent`);
    if (encryption && subscribe !== 'any') throw bad('a private topic is read by the members its owner chooses; it takes no subscribe policy');
    requireScope(ctx, 'topics_create');
    if (!tierAtLeast(ctx.tier, cfg.topicCreateMinTier)) {
      throw new HttpError(403, 'tier_too_low', `creating topics on this hub requires tier "${cfg.topicCreateMinTier}"; this agent is "${ctx.tier}"`);
    }
    if (!isPlainObject(body.schema)) throw bad('schema must be a JSON Schema object');
    if (Buffer.byteLength(JSON.stringify(body.schema)) > cfg.maxSchemaBytes) throw bad(`schema is larger than ${cfg.maxSchemaBytes} bytes`);
    const problems = checkSchema(body.schema);
    if (problems.length > 0) throw new HttpError(400, 'unsupported_schema', 'the schema uses features this hub does not validate', { problems: problems.slice(0, 20) });
    if (store.topics.has(body.name)) throw new HttpError(409, 'topic_exists', `topic "${body.name}" already exists`);
    if (store.topicsOwnedBy(ctx.did) >= cfg.maxTopicsPerAgent) {
      throw new HttpError(403, 'quota_exceeded', `an agent can own at most ${cfg.maxTopicsPerAgent} topics`);
    }
    requireTopicRoom(ctx.agent);
    // Its owner signs what the topic is: its contract, who may use it and how it is encrypted.
    let contract;
    try {
      contract = contractHash(body);
    } catch {
      throw tooDeep(); // a schema can carry anything in a "const": one that cannot be hashed is the contract of no topic
    }
    const statement = acceptStatement(ctx, 'topic.create', { topic: body.name, owner: ctx.did, contract, publish, subscribe, encryption });
    store.commit({
      type: 'topic.create',
      name: body.name,
      description: body.description,
      schema: body.schema,
      publish,
      subscribe,
      encryption,
      owner: ctx.did,
      statement,
      at: new Date().toISOString(),
    });
    log(`topic ${body.name} created by ${ctx.did}`);
    return { status: 201, body: topicView(store.topics.get(body.name)) };
  });

  // The owner can change who may publish and subscribe; the schema stays fixed.
  route('PUT', '/v1/topics/:name/policy', 'registered', (ctx) => {
    const topic = getTopic(ctx.params.name);
    if (topic.owner !== ctx.did) throw new HttpError(403, 'not_owner', 'only the owner can change the policy of a topic');
    limited(`policy:${ctx.did}`, cfg.limits.topicPolicy);
    const body = ctx.json();
    const publish = body.publish === undefined ? topic.publish : parsePolicy(body.publish, 'publish', { allowOwner: true });
    const subscribe = body.subscribe === undefined ? topic.subscribe : parsePolicy(body.subscribe, 'subscribe', { allowOwner: false });
    if (topic.encryption && subscribe !== 'any') throw new HttpError(400, 'invalid_topic', 'the members of a private topic are chosen by its owner, not by a subscribe policy');
    // Subscribers the new policy leaves out stop receiving right away.
    // Other hubs follow a topic only while anybody may read it.
    const leftOut = (did) => (store.peers.has(did) ? subscribe !== 'any' : !policyAllows(subscribe, { did, tier: tierOf(store.agents.get(did)), owner: topic.owner }));
    const removed = topic.encryption ? [] : [...store.subs.get(topic.name)].filter(leftOut);
    // Its owner signs what it changes, and only that: null for the policy it leaves as it is.
    // Each statement is the next change of the topic: one made for the topic as it was before
    // another change is told apart, to be made again.
    const revision = topic.revision + 1;
    const given = body.statement?.statement?.revision;
    if (Number.isSafeInteger(given) && given !== revision) {
      throw new HttpError(409, 'stale_statement', 'the topic has changed since this statement was made: read the topic and make it again', { revision: topic.revision });
    }
    const changes = { publish: body.publish === undefined ? null : publish, subscribe: body.subscribe === undefined ? null : subscribe };
    const statement = acceptStatement(ctx, 'topic.policy', { topic: topic.name, owner: topic.owner, contract: contractHash(topic), encryption: topic.encryption, ...changes, revision });
    store.commit({ type: 'topic.policy', name: topic.name, publish, subscribe, removed, statement, at: new Date().toISOString() });
    return { body: { ...topicView(topic), unsubscribed: removed.length } };
  });

  // --- private topics: key distribution -------------------------------------------
  // The owner uploads grants (the topic key sealed to each member). The hub checks that
  // the owner signed them and serves each member its own; it never sees the key.

  const getPrivateTopic = (name) => {
    const topic = getTopic(name);
    if (!topic.encryption) throw new HttpError(400, 'not_private', 'this topic is not encrypted');
    return topic;
  };

  /** A private topic whose members hold a topic key. One that uses MLS has no such key. */
  const getKeyedTopic = (name) => {
    const topic = getPrivateTopic(name);
    if (topic.encryption !== GROUP_ENCRYPTION) throw new HttpError(400, 'not_keyed', 'this topic uses MLS: it has a group, not a key that its owner hands out');
    return topic;
  };

  route('PUT', '/v1/topics/:name/keys', 'registered', (ctx) => {
    const topic = getKeyedTopic(ctx.params.name);
    if (topic.owner !== ctx.did) throw new HttpError(403, 'not_owner', 'only the owner distributes the key of a private topic');
    const { epoch, grants } = ctx.json();
    // Same epoch: more members get the current key. Next epoch: a new key, for exactly the members listed.
    if (!Number.isSafeInteger(epoch) || epoch < 1 || (epoch !== topic.epoch && epoch !== topic.epoch + 1)) {
      throw new HttpError(409, 'stale_epoch', `epoch must be ${Math.max(topic.epoch, 1)} to add members or ${topic.epoch + 1} to rotate the key`, { epoch: topic.epoch });
    }
    if (!Array.isArray(grants) || grants.length < 1 || grants.length > cfg.maxPrivateTopicMembers) {
      throw new HttpError(400, 'invalid_grant', `grants must be a list of 1 to ${cfg.maxPrivateTopicMembers} grants`);
    }
    const accepted = {};
    for (const envelope of grants) {
      const problem = checkGrant(envelope, { topic: topic.name, owner: ctx.did, epoch });
      if (problem) throw new HttpError(400, 'invalid_grant', problem);
      const { member } = envelope.grant;
      if (store.agents.get(member)?.status !== 'active') throw new HttpError(404, 'member_not_found', `${member} is not an active agent on this hub`);
      accepted[member] = { grant: envelope.grant, proof: envelope.proof };
    }
    const rotating = epoch === topic.epoch + 1;
    if (rotating && accepted[ctx.did] === undefined) throw new HttpError(400, 'invalid_grant', 'a new key must also be granted to the owner');
    const members = new Set([...(rotating ? [] : Object.keys(membersOf(topic))), ...Object.keys(accepted)]);
    if (members.size > cfg.maxPrivateTopicMembers) {
      throw new HttpError(403, 'quota_exceeded', `a private topic can have at most ${cfg.maxPrivateTopicMembers} members`);
    }
    // Whoever is left without the new key stops receiving at once.
    const removed = rotating ? [...store.subs.get(topic.name)].filter((did) => accepted[did] === undefined) : [];
    store.commit({ type: 'topic.keys', name: topic.name, epoch, grants: accepted, removed });
    if (rotating) log(`topic ${topic.name} rotated to epoch ${epoch} (${members.size} members, ${removed.length} unsubscribed)`);
    return { body: { topic: topic.name, epoch, members: members.size, unsubscribed: removed.length } };
  });

  route('GET', '/v1/topics/:name/keys', 'registered', (ctx) => {
    const topic = getKeyedTopic(ctx.params.name);
    const grants = Object.values(topic.grants).map((byMember) => byMember[ctx.did]).filter(Boolean);
    if (grants.length === 0) throw new HttpError(403, 'not_a_member', 'the owner of this topic has not given this agent a key');
    return { body: { topic: topic.name, owner: topic.owner, epoch: topic.epoch, grants } };
  });

  route('GET', '/v1/topics/:name/members', 'registered', (ctx) => {
    const topic = getPrivateTopic(ctx.params.name);
    if (!isMember(topic, ctx.did) && topic.owner !== ctx.did) throw new HttpError(403, 'not_a_member', 'only members can list the members of a private topic');
    // Over MLS a member also learns which readers are in the group: its own state says the same, and that is what it believes.
    return { body: { topic: topic.name, epoch: topicEpoch(topic), members: memberAgents(topic), ...(topic.mls ? { readers: topic.mls.members } : {}) } };
  });

  route('PUT', '/v1/topics/:name/subscription', 'registered', async (ctx) => {
    const remote = remoteName(ctx.params.name);
    if (remote) return { body: await followRemote(ctx, remote) };
    const topic = getTopic(ctx.params.name);
    const current = store.agentSubs.get(ctx.did);
    if (!current?.has(topic.name)) {
      requireLiveTopic(topic);
      requireScope(ctx, 'subscribe', topic.name);
      if (!mayRead(topic, ctx.agent)) throw new HttpError(403, 'subscribe_not_allowed', 'this topic restricts who can subscribe');
      if ((current?.size ?? 0) >= cfg.maxSubscriptionsPerAgent) {
        throw new HttpError(403, 'quota_exceeded', `at most ${cfg.maxSubscriptionsPerAgent} subscriptions per agent`);
      }
      store.commit({ type: 'sub.add', did: ctx.did, topic: topic.name });
    }
    return { body: { topic: topic.name, subscribed: true } };
  });

  route('DELETE', '/v1/topics/:name/subscription', 'registered', async (ctx) => {
    // A topic of another hub is left by its name alone: the pairing it was followed through may be gone.
    if (String(ctx.params.name).includes('@')) return { body: await unfollowRemote(ctx, ctx.params.name) };
    const topic = getTopic(ctx.params.name);
    if (store.agentSubs.get(ctx.did)?.has(topic.name)) store.commit({ type: 'sub.remove', did: ctx.did, topic: topic.name });
    return { body: { topic: topic.name, subscribed: false } };
  });

  route('GET', '/v1/subscriptions', 'registered', (ctx) => ({ body: { topics: store.subscriptionsOf(ctx.did) } }));

  // --- messaging --------------------------------------------------------------

  route('POST', '/v1/topics/:name/events', 'registered', async (ctx) => {
    const remote = remoteName(ctx.params.name);
    if (remote) return publishRemote(ctx, remote);
    const topic = getTopic(ctx.params.name);
    requireLiveTopic(topic);
    limited(`publish:${ctx.did}`, cfg.limits.publish);
    const now = Date.now();
    chargeSend(ctx.agent, now);
    const envelope = acceptEnvelope(ctx, now);
    const { event } = envelope;
    if (event.subject !== topic.name) throw new HttpError(400, 'invalid_event', 'subject must be the topic name');
    if (event.recipient !== undefined) throw new HttpError(400, 'invalid_event', 'topic events must not carry a recipient');
    // An event may say which hub's topic it is for. If it does, it has to be this one.
    if (event.hub !== undefined && event.hub !== identity.did) throw new HttpError(400, 'invalid_event', 'this event was written for a topic of another hub');
    if (topic.encryption) {
      // The hub cannot read these, so it cannot check the schema: members do, after decrypting.
      if (event.encryption !== topic.encryption) {
        throw new HttpError(400, 'invalid_event', topic.encryption === TOPIC_MLS ? 'events on this topic must be encrypted over MLS, for its group' : 'events on this topic must be encrypted with its topic key');
      }
      if (event.type !== ENCRYPTED_EVENT_TYPE) throw new HttpError(400, 'invalid_event', `encrypted events must have type "${ENCRYPTED_EVENT_TYPE}"`);
      if (topic.encryption === GROUP_ENCRYPTION) {
        const problem = checkGroupSealedShape(event.data);
        if (problem) throw new HttpError(400, 'invalid_event', problem);
      }
    } else if (event.encryption !== undefined) {
      throw new HttpError(400, 'invalid_event', 'events on public topics are not encrypted');
    }
    checkDataschema(event, topic);
    requireScope(ctx, 'publish', topic.name);
    if (!policyAllows(topic.publish, { did: ctx.did, tier: ctx.tier, owner: topic.owner })) {
      throw new HttpError(403, 'publish_not_allowed', topic.publish === 'owner' ? 'only the owner can publish to this topic' : 'this topic restricts who can publish');
    }
    if (topic.encryption === TOPIC_MLS) {
      // Whoever publishes is a reader in the group, and what it publishes is a message of that group, of the epoch it is in.
      if (!topic.mls?.members.includes(ctx.reader)) throw new HttpError(403, 'publish_not_allowed', 'only readers in the group of a private topic can publish to it');
      await checkMlsMessage(event.data, topic.mls, 'this topic');
    } else if (topic.encryption) {
      if (!isMember(topic, ctx.did)) throw new HttpError(403, 'publish_not_allowed', 'only members can publish to a private topic');
      if (event.data.epoch !== topic.epoch) {
        throw new HttpError(409, 'stale_epoch', 'the key of this topic has been rotated; fetch the current one and encrypt again', { epoch: topic.epoch });
      }
    } else {
      const errors = validate(topic.schema, event.data);
      if (errors.length > 0) throw new HttpError(422, 'schema_validation_failed', 'data does not match the topic schema', { errors });
    }
    if (store.hasSeen(event)) return { body: { id: event.id, topic: topic.name, duplicate: true } };
    // Checked again at delivery time: a subscriber whose tier has lapsed since it subscribed gets nothing.
    const recipients = recipientsOf(topic, ctx.did, now);
    const readers = topic.mls ? { readers: topic.mls.members } : {}; // over MLS, only the readers in the group could open it
    const result = store.commit({ type: 'event.publish', topic: topic.name, envelope, recipients, ...readers, tier: ctx.tier, at: new Date(now).toISOString() });
    push(result.deliveries);
    return { status: 202, body: { id: event.id, topic: topic.name, seq: result.seq, duplicate: false, delivered_to: result.deliveries.length } };
  });

  // --- MLS: direct conversations ------------------------------------------------------------
  // The hub is the Delivery Service of MLS, and no more: it keeps the KeyPackages readers publish,
  // says which group is current for a pair of agents, and hands each reader its invitation. It
  // reads what MLS leaves in the clear (kind, group) and never holds a key.

  const base64Bytes = (value, what, code = 'invalid_mls') => {
    if (typeof value !== 'string' || value.length < 1 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, code, `${what} must be base64url`);
    return new Uint8Array(Buffer.from(value, 'base64url'));
  };

  /** Whether `reader` is an instance whose certificate has run out: its agent no longer answers for that key. */
  const lapsed = (reader, now = Date.now()) => {
    const instance = store.instances.get(reader);
    return Boolean(instance) && Date.parse(instance.certificate.expires_at) <= now;
  };
  /** The readers an agent has now: its own key, and its instances that have a certificate in force. */
  const standingReaders = (did) => store.readersOf(did).filter((reader) => !lapsed(reader));
  /** The readers of an agent that can be put in a group right now: those with a KeyPackage waiting. */
  const mlsReaders = (did) => standingReaders(did).filter((reader) => (store.keyPackages.get(reader)?.length ?? 0) > 0);

  const getPeer = (ctx) => {
    const peer = store.agents.get(ctx.params.did);
    refuseSucceeded(peer); // a conversation with it is one with its successor now, and that is another conversation
    if (!peer || peer.status !== 'active') throw new HttpError(404, 'agent_not_found', 'no active agent is registered with that DID');
    if (peer.did === ctx.did) throw new HttpError(400, 'invalid_parameter', 'an agent has no conversation with itself');
    return peer;
  };

  // How many KeyPackages the hub holds for the reader, and which: each by its reference, so that
  // the reader can tell whether it still has the secret that goes with it. One that no longer
  // verifies - it has expired - has none.
  route('GET', '/v1/mls/key-packages', 'registered', async (ctx) => {
    const held = store.keyPackages.get(ctx.reader) ?? [];
    const refs = await Promise.all(
      held.map((entry) =>
        inspectKeyPackage(base64Bytes(entry, 'a key package')).then(
          (owner) => owner.ref,
          () => null,
        ),
      ),
    );
    return { body: { count: held.length, refs } };
  });

  route('POST', '/v1/mls/key-packages', 'registered', async (ctx) => {
    limited(`mls:${ctx.did}`, cfg.limits.mls);
    const { key_packages: list, replace = false } = ctx.json();
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) throw new HttpError(400, 'invalid_key_package', 'key_packages must be a list of 1 to 10 KeyPackages');
    if (typeof replace !== 'boolean') throw new HttpError(400, 'invalid_key_package', 'replace must be true or false');
    for (const entry of list) {
      let owner;
      try {
        owner = await inspectKeyPackage(base64Bytes(entry, 'a key package', 'invalid_key_package'));
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(400, 'invalid_key_package', `key package rejected: ${err.message}`);
      }
      // A reader publishes its own and nobody else's: whoever adds it to a group must end up talking to it.
      if (owner.agent !== ctx.did || owner.reader !== ctx.reader) throw new HttpError(403, 'invalid_key_package', 'a key package is published by the member it belongs to');
    }
    // With `replace` the ones the hub held for this reader go: it says it can no longer open them.
    const result = store.commit({ type: 'mls.keys.add', reader: ctx.reader, packages: list, replace, cap: cfg.maxKeyPackagesPerReader });
    return { status: 201, body: { count: result.count } };
  });

  /** The name of a group has to say which conversation it is of - `pair`, the two agents in order - and which generation. */
  const checkGroupName = (group, pair, generation) => {
    const parsed = parseDmGroupId(group);
    if (!parsed || parsed.pair.join('|') !== pair || parsed.generation !== generation) throw new HttpError(400, 'invalid_group', 'the group id does not name this conversation and generation');
  };
  /**
   * A name is the name of one group. The epoch a group is in is kept by its name, and a second
   * group that took the name would take that record with it. A hub that this one is paired with
   * can say that an agent is its own, and so name a group for the two agents of a conversation
   * that is kept here under nobody's name: it does not get to give it the name of theirs.
   */
  const requireUnusedName = (group) => {
    if (store.mlsLogs.has(group)) throw new HttpError(400, 'invalid_group', 'that group id is already the name of a group');
  };

  const conversationView = (ctx, peer) => {
    const current = store.dmGroups.get(dmPairKey(ctx.did, peer.did));
    return {
      peer: peer.did,
      group: current?.group ?? null,
      generation: current?.generation ?? 0,
      epoch: current ? store.mlsLog(current.group).epoch : 0, // goes up by one with every commit; a sender must be at it
      members: current?.members ?? [],
      // Who could be in the conversation right now. When this differs from `members`, the next sender makes a new group.
      own_readers: mlsReaders(ctx.did),
      peer_readers: mlsReaders(peer.did),
    };
  };

  // `:did` is an agent of this hub or, as "did@hub", one of a hub it is paired with: see further down.
  route('GET', '/v1/mls/dm/:did', 'registered', (ctx) => {
    const across = acrossHubs(ctx);
    return across ? acrossView(ctx, across).then((body) => ({ body })) : { body: conversationView(ctx, getPeer(ctx)) };
  });

  // Takes one KeyPackage of every reader that should be in the conversation, except the one asking.
  route('POST', '/v1/mls/dm/:did/key-packages', 'registered', (ctx) => {
    limited(`mls:${ctx.did}`, cfg.limits.mls);
    const across = acrossHubs(ctx);
    if (across) return claimAcross(ctx, across);
    requireScope(ctx, 'direct');
    const peer = getPeer(ctx);
    limited(`mls-claim:${ctx.did}:${peer.did}`, cfg.limits.mlsClaim);
    const readers = [...mlsReaders(ctx.did), ...mlsReaders(peer.did)].filter((reader) => reader !== ctx.reader);
    const { claimed } = store.commit({ type: 'mls.keys.claim', readers });
    return { body: { key_packages: readers.map((reader) => ({ reader, key_package: claimed[reader] })) } };
  });

  // Makes the next group of a conversation. Only one reader can win each generation: the others
  // are told to fetch the conversation again, and find their invitation to the group that won.
  route('PUT', '/v1/mls/dm/:did', 'registered', async (ctx) => {
    limited(`mls:${ctx.did}`, cfg.limits.mls);
    const across = acrossHubs(ctx);
    if (across) return createAcross(ctx, across);
    requireScope(ctx, 'direct');
    const peer = getPeer(ctx);
    const { group, generation, members, welcome } = ctx.json();
    const pair = dmPairKey(ctx.did, peer.did);
    const current = store.dmGroups.get(pair);
    if (generation !== (current?.generation ?? 0) + 1) {
      throw new HttpError(409, 'stale_generation', 'this conversation already has that group or a newer one; fetch it again', { generation: current?.generation ?? 0, group: current?.group ?? null });
    }
    checkGroupName(group, pair, generation);
    const own = standingReaders(ctx.did);
    const theirs = standingReaders(peer.did);
    const wellFormed = Array.isArray(members) && members.length <= own.length + theirs.length && new Set(members).size === members.length && members.every((member) => own.includes(member) || theirs.includes(member));
    if (!wellFormed || !members.includes(ctx.reader) || !members.some((member) => theirs.includes(member))) {
      throw new HttpError(400, 'invalid_group', 'members must be readers of the two agents, with whoever makes the group and at least one reader of the other side');
    }
    await checkInvitation(welcome, members.filter((member) => member !== ctx.reader)); // everybody in it but whoever made it
    requireUnusedName(group);
    store.commit({ type: 'mls.dm.create', pair, group, generation, members, welcome, recipients: members.filter((member) => member !== ctx.reader), keep_earlier: cfg.mlsEarlierGroupsKept, by: ctx.reader, at: new Date().toISOString() });
    return { status: 201, body: conversationView(ctx, peer) };
  });

  // Commits move a group from one epoch to the next, and only one can end each epoch. The hub is
  // what makes that true: it takes the first commit for the current epoch and turns the rest away.
  // It cannot tell whether the commit is valid - members find out when they apply it.
  /** What any hub can see of a commit: that it is one, and of that group. Returns the epoch it would end. */
  const commitEpoch = async (group, message) => {
    let seen;
    try {
      seen = await inspectMessage(base64Bytes(message, 'message'));
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, 'invalid_mls', `commit rejected: ${err.message}`);
    }
    if (seen.wireformat !== 'private_message' || seen.contentType !== 'commit' || seen.groupId !== group) throw new HttpError(400, 'invalid_mls', 'message must be an MLS commit of that group');
    return seen.epoch;
  };

  /** Takes a commit of `by` to the group that is current in a conversation (`current`, as the store keeps it), if it is the one that ends its epoch. */
  const takeCommit = async (current, { group, message }, by) => {
    if (!current || group !== current.group) throw new HttpError(409, 'stale_group', 'this conversation has no such group, or a newer one; fetch it again', { group: current?.group ?? null, generation: current?.generation ?? 0 });
    if (!current.members.includes(by)) throw new HttpError(403, 'not_a_member', 'only a member of the group can commit to it');
    const ends = await commitEpoch(group, message);
    const { epoch } = store.mlsLog(group);
    if (ends !== epoch) throw new HttpError(409, 'stale_epoch', 'another commit already ended that epoch; apply it and try again', { epoch });
    const result = store.commit({ type: 'mls.commit', group, message, keep: cfg.mlsCommitsKept });
    return { status: 201, body: { group, epoch: result.epoch } };
  };

  /** The commits of a group of a conversation (`current`) from epoch `from`: of its current group, or of one of those just before it. */
  const commitsOf = (current, group = current?.group, from = 1) => {
    if (!current || (group !== current.group && !(current.earlier ?? []).includes(group))) {
      throw new HttpError(404, 'group_not_found', 'this conversation has no such group, or its commits are no longer kept');
    }
    const log = store.mlsLog(group);
    return { body: { group, epoch: log.epoch, commits: log.commits.filter((entry) => entry.epoch >= from) } };
  };

  route('POST', '/v1/mls/dm/:did/commits', 'registered', async (ctx) => {
    limited(`mls:${ctx.did}`, cfg.limits.mls);
    const across = acrossHubs(ctx);
    if (across) return commitAcross(ctx, across);
    requireScope(ctx, 'direct');
    return takeCommit(store.dmGroups.get(dmPairKey(ctx.did, getPeer(ctx).did)), ctx.json(), ctx.reader);
  });

  // The commits a reader has not applied yet: every one from the epoch it is in. `group` is the
  // current group of the conversation unless it names one of those just before it.
  route('GET', '/v1/mls/dm/:did/commits', 'registered', (ctx) => {
    const group = ctx.url.searchParams.get('group') ?? undefined;
    const from = parseSeq(ctx.url.searchParams.get('from'), 'from') ?? 1;
    const across = acrossHubs(ctx);
    if (across) return commitsAcross(ctx, across, group, from, parseSeq(ctx.url.searchParams.get('until'), 'until'));
    return commitsOf(store.dmGroups.get(dmPairKey(ctx.did, getPeer(ctx).did)), group, from);
  });

  route('GET', '/v1/mls/welcomes', 'registered', (ctx) => ({ body: { welcomes: store.welcomes.get(ctx.reader) ?? [] } }));

  route('POST', '/v1/mls/welcomes/ack', 'registered', (ctx) => {
    const { group } = ctx.json();
    if (typeof group !== 'string' || group.length > 400) throw new HttpError(400, 'invalid_parameter', 'group must be a group id');
    if ((store.welcomes.get(ctx.reader) ?? []).some((entry) => entry.group === group)) store.commit({ type: 'mls.welcome.ack', reader: ctx.reader, group });
    return { body: { acked: group } };
  });

  // --- MLS: conversations with agents of other hubs -----------------------------------------
  // The same group as between two agents of one hub, with every reader of both. Which group is
  // current, and which commit ended each epoch, has to be said in one place: the hub of the agent
  // whose DID sorts first is the home of the conversation, and the other hub asks it whatever its
  // own agent asks. Each hub keeps the KeyPackages and the invitations of its own readers, and
  // knows no others. A hub keeps what it has with the agents of each paired hub apart from what
  // it has with those of any other, and from what is between its own: whatever a paired hub does
  // can only touch conversations with agents it says are its own.

  /** `:did` as "did@hub": the agent of a paired hub that the request is about. Null if it is an agent of this hub. */
  const acrossHubs = (ctx) => {
    const across = remoteAddress(ctx.params.did);
    if (!across) return null;
    if (across.did === ctx.did) throw new HttpError(400, 'invalid_parameter', 'an agent has no conversation with itself');
    requireScope(ctx, 'direct_hub', across.peer.name);
    return across;
  };
  /** How this hub keeps the conversation of its agent `local` with the agent `remote` of the hub `peer`. */
  const acrossKey = (local, remote, peer) => `${dmPairKey(local, remote)}@${peer.did}`;
  /** Whether this hub is the home of that conversation: the hub of the agent that sorts first. */
  const isHome = (local, remote) => dmPair(local, remote)[0] === local;
  /**
   * A conversation that this hub does not keep yet takes a place among those it keeps with the
   * agents of that hub, and there are only so many. Who the agents of another hub are is its word,
   * and it costs it nothing to name one more: without this, a paired hub could have this one keep
   * conversations without end. A conversation that is kept goes on, whatever becomes of the rest.
   */
  const requireRoom = (current, peer, among = store.dmGroups) => {
    if (current) return;
    let kept = 0;
    for (const key of among.keys()) if (key.endsWith(`@${peer.did}`)) kept += 1;
    if (kept >= cfg.maxConversationsPerPeer) throw new HttpError(403, 'quota_exceeded', `this hub keeps at most ${cfg.maxConversationsPerPeer} conversations with the agents of another hub`);
  };
  const mlsPath = (did, rest = '') => `/v1/federation/mls/dm/${encodeURIComponent(did)}${rest}`;

  // What is done to a conversation here is done one thing at a time: asking the other hub takes a
  // while, and two readers making the next group at once must not both find that there is none.
  // Whoever is at it may be waiting for the other hub, and a hub that is slow to answer does not
  // get to hold more than a few of those who come behind: the rest are told to come back.
  const turns = new Map(); // conversation -> { last, waiting }: the last thing being done to it, and how many are at it or wait
  const inTurnOf = (key, work) => {
    const turn = turns.get(key) ?? { last: Promise.resolve(), waiting: 0 };
    if (turn.waiting >= 5) return Promise.reject(new HttpError(429, 'rate_limited', 'too much is being done to that conversation at once: try again in a while'));
    turns.set(key, turn);
    turn.waiting += 1;
    const done = turn.last.then(work).finally(() => {
      turn.waiting -= 1;
      if (turn.waiting === 0) turns.delete(key);
    });
    turn.last = done.catch(() => {});
    return done;
  };

  // What another hub says is taken only in the shape it should have.
  const readersFrom = (given) => (Array.isArray(given) ? [...new Set(given.filter(isValidDid))].slice(0, 50) : []);
  const conversationFrom = (given, pair) => {
    if (!isPlainObject(given) || parseDmGroupId(given.group)?.pair.join('|') !== pair || parseDmGroupId(given.group).generation !== given.generation) return null;
    if (!Number.isSafeInteger(given.epoch) || given.epoch < 1) return null;
    return { group: given.group, generation: given.generation, epoch: given.epoch, members: readersFrom(given.members) };
  };
  /** The KeyPackages another hub hands out of its agent `agent`: those that are one, of the reader it says, and of a reader of that agent and no other. */
  const keyPackagesFrom = async (given, agent) => {
    const taken = [];
    for (const entry of (Array.isArray(given) ? given : []).slice(0, 50)) {
      if (!isPlainObject(entry) || !isValidDid(entry.reader) || typeof entry.key_package !== 'string' || entry.key_package.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(entry.key_package)) continue;
      const owner = await inspectKeyPackage(new Uint8Array(Buffer.from(entry.key_package, 'base64url'))).catch(() => null);
      if (owner?.agent === agent && owner.reader === entry.reader) taken.push({ reader: entry.reader, key_package: entry.key_package });
    }
    return taken;
  };

  /** What the hub of the other agent says of the conversation: its readers and, if it is the home, the group. One that knows nothing of this has nobody to talk to over MLS. */
  const askAcross = (ctx, { did, peer }) =>
    peerAnswer(peer, 'GET', mlsPath(did, `?with=${encodeURIComponent(ctx.did)}`)).catch((err) => {
      if (err.code !== 'not_found') throw err;
      return {}; // a hub from before conversations crossed hubs
    });

  const acrossView = async (ctx, { did, peer }) => {
    rationed(ctx, peer); // what is asked of the other hub comes out of the allowance of whoever asks
    const there = await askAcross(ctx, { did, peer });
    const kept = store.dmGroups.get(acrossKey(ctx.did, did, peer));
    const current = isHome(ctx.did, did) ? kept && { ...kept, epoch: store.mlsLog(kept.group).epoch } : conversationFrom(there.conversation, dmPairKey(ctx.did, did));
    return {
      peer: did,
      group: current?.group ?? null,
      generation: current?.generation ?? 0,
      epoch: current?.epoch ?? 0,
      members: current?.members ?? [],
      own_readers: mlsReaders(ctx.did),
      peer_readers: readersFrom(there.readers),
    };
  };

  /** One KeyPackage of each reader of the two agents but the one asking: those of the other agent, from its hub. */
  const claimAcross = async (ctx, { did, peer }) => {
    rationed(ctx, peer);
    limited(`mls-claim:${ctx.did}:${did}`, cfg.limits.mlsClaim);
    // The other hub first: if it does not answer, none of this agent's own are used up for nothing.
    const theirs = await keyPackagesFrom((await peerAnswer(peer, 'POST', mlsPath(did, '/key-packages'), { with: ctx.did })).key_packages, did);
    const own = mlsReaders(ctx.did).filter((reader) => reader !== ctx.reader);
    const { claimed } = store.commit({ type: 'mls.keys.claim', readers: own });
    return { body: { key_packages: [...own.map((reader) => ({ reader, key_package: claimed[reader] })), ...theirs] } };
  };

  /**
   * The next group of a conversation across hubs, as whoever makes it describes it. `mine` are
   * the readers that the agent of this hub has: the members that are not among them are taken to
   * be of the other agent, which only its hub can tell. Returns the members of each side.
   */
  const checkGroupAcross = async ({ group, generation, members, welcome, by }, pair, mine) => {
    checkGroupName(group, pair, generation);
    const wellFormed = Array.isArray(members) && members.length <= 100 && new Set(members).size === members.length && members.every(isValidDid);
    const here = wellFormed ? members.filter((member) => mine.includes(member)) : [];
    const there = wellFormed ? members.filter((member) => !mine.includes(member)) : [];
    if (!wellFormed || !members.includes(by) || here.length === 0 || there.length === 0) {
      throw new HttpError(400, 'invalid_group', 'members must be readers of the two agents, with whoever makes the group and at least one reader of each side');
    }
    // Who the readers of the other agent are is the word of its hub. An instance that an agent of
    // this hub removed, or whose certificate has run out, is one of nobody's, whoever says so.
    if (members.some((member) => store.removedInstances.has(member) || lapsed(member))) {
      throw new HttpError(400, 'invalid_group', 'one of the members is an instance that was removed, or whose certificate has run out');
    }
    await checkInvitation(welcome, members.filter((member) => member !== by)); // everybody in it but whoever made it
    return { here, there };
  };

  const staleGeneration = (current) => new HttpError(409, 'stale_generation', 'this conversation already has that group or a newer one; fetch it again', { generation: current?.generation ?? 0, group: current?.group ?? null });

  /** A reader of an agent of this hub makes the next group of its conversation with an agent of another. */
  const createAcross = async (ctx, { did, peer }) => {
    rationed(ctx, peer);
    const { group, generation, members, welcome } = ctx.json();
    const made = { group, generation, members, welcome, by: ctx.reader };
    const { here } = await checkGroupAcross(made, dmPairKey(ctx.did, did), store.readersOf(ctx.did));
    const key = acrossKey(ctx.did, did, peer);
    const invited = here.filter((reader) => reader !== ctx.reader);
    const tell = () => peerAnswer(peer, 'PUT', mlsPath(did), { with: ctx.did, ...made });
    if (!isHome(ctx.did, did)) {
      // The other hub says whether this is the next group. If it is, the readers of this agent get their invitations here.
      await tell();
      store.commit({ type: 'mls.welcome.put', group, welcome, readers: invited, from: peer.did });
      return { status: 201, body: { peer: did, group, generation } };
    }
    return inTurnOf(key, async () => {
      const current = store.dmGroups.get(key);
      if (generation !== (current?.generation ?? 0) + 1) throw staleGeneration(current);
      requireRoom(current, peer);
      // The readers of the other agent get their invitations from their own hub, which is told first:
      // a group that nobody there could be asked into is not made.
      await tell();
      requireRoom(current, peer); // again: others may have taken the last places while that hub answered
      requireUnusedName(group);
      store.commit({ type: 'mls.dm.create', pair: key, group, generation, members, welcome, recipients: invited, from: peer.did, keep_earlier: cfg.mlsEarlierGroupsKept, by: ctx.reader, at: new Date().toISOString() });
      return { status: 201, body: { peer: did, group, generation } };
    });
  };

  /** Whether `group` names a group of the conversation between those two agents, whichever generation it is of. */
  const namesConversation = (group, local, remote) => parseDmGroupId(group)?.pair.join('|') === dmPairKey(local, remote);

  const commitAcross = async (ctx, { did, peer }) => {
    if (isHome(ctx.did, did)) return takeCommit(store.dmGroups.get(acrossKey(ctx.did, did, peer)), ctx.json(), ctx.reader);
    rationed(ctx, peer);
    const { group, message } = ctx.json();
    // Whether it ends an epoch is for the home of the conversation to say. What is handed on to it
    // is what any hub can tell is a commit of a group of this conversation, and nothing else.
    if (!namesConversation(group, ctx.did, did)) throw new HttpError(400, 'invalid_group', 'the group id does not name this conversation');
    await commitEpoch(group, message);
    const taken = await peerAnswer(peer, 'POST', mlsPath(did, '/commits'), { with: ctx.did, group, message, by: ctx.reader });
    return { status: 201, body: { group, epoch: count(taken.epoch) } };
  };

  // --- what the hub that is not the home keeps of a conversation -------------------------------
  // To open a message a reader may need the commits that renewed the keys since it last looked.
  // Where this hub is not the home of the conversation those are on another hub, and a reader
  // would have to wait for that hub with the whole of its inbox behind. So this hub keeps a copy
  // of them, as the home gives them, and takes a message from the home only when it has the
  // commits up to the epoch of that message. Opening what was received never needs another hub.

  /** What this hub keeps of the commits of `group`, of a conversation whose home is another hub (`key`): { epoch, commits }, or null. */
  const copied = (key, group) => (store.mlsCopies.get(key) ?? []).find((entry) => entry.group === group) ?? null;

  /** The commits another hub gives, as far as they are what they should be: one after the other, each a commit of `group` that ends the epoch it says. */
  const commitsFrom = async (given, group) => {
    const taken = [];
    for (const entry of (Array.isArray(given) ? given : []).slice(0, cfg.mlsCommitsKept)) {
      if (!isPlainObject(entry) || !Number.isSafeInteger(entry.epoch) || typeof entry.message !== 'string') break;
      if (taken.length > 0 && entry.epoch !== taken.at(-1).epoch + 1) break;
      if ((await commitEpoch(group, entry.message).catch(() => null)) !== entry.epoch) break;
      taken.push({ epoch: entry.epoch, message: entry.message });
    }
    return taken;
  };

  /**
   * Asks the home of a conversation for the commits of `group` that this hub does not have, and
   * keeps them: up to epoch `upTo`, or all there are. The home gives so many in one answer, and
   * is asked again from where they end.
   */
  const copyCommits = async ({ local, remote, peer }, group, upTo = Infinity) => {
    const key = acrossKey(local, remote, peer);
    for (let asked = 0; asked < 20; asked++) {
      const have = copied(key, group);
      const from = have?.epoch ?? 1;
      if (from >= upTo) return;
      const query = `?with=${encodeURIComponent(local)}&group=${encodeURIComponent(group)}&from=${from}`;
      const said = await peerAnswer(peer, 'GET', mlsPath(remote, `/commits${query}`));
      const commits = (await commitsFrom(said.commits, group)).filter((entry) => entry.epoch >= from);
      if (commits.length === 0) return;
      requireRoom(store.mlsCopies.has(key), peer, store.mlsCopies);
      // If the home no longer has them from where this hub left off, what it has now is what there is.
      store.commit({ type: 'mls.copy', key, group, from: commits[0].epoch, commits, keep: cfg.mlsCommitsKept, keep_groups: cfg.mlsEarlierGroupsKept + 1 });
    }
  };

  /**
   * The commits of a group for a reader of this hub. Where this hub is the home, it has them.
   * Where it is not: to read, a reader says how far it needs them (`until`) and gets what this
   * hub keeps, with no other hub asked; to write, it needs them all, and the home is asked.
   */
  const commitsAcross = async (ctx, { did, peer }, group, from, until) => {
    if (isHome(ctx.did, did)) return commitsOf(store.dmGroups.get(acrossKey(ctx.did, did, peer)), group, from);
    // The other hub is not asked for the commits of what is no group of this conversation.
    if (group !== undefined && !namesConversation(group, ctx.did, did)) throw new HttpError(404, 'group_not_found', 'this conversation has no such group, or its commits are no longer kept');
    const parties = { local: ctx.did, remote: did, peer };
    let named = group;
    if (until === undefined || named === undefined) {
      rationed(ctx, peer);
      if (named === undefined) {
        // Which group is current is for the home to say.
        named = (await peerAnswer(peer, 'GET', mlsPath(did, `/commits?with=${encodeURIComponent(ctx.did)}&from=${from}`))).group;
        if (!namesConversation(named, ctx.did, did)) throw new HttpError(502, 'peer_unreachable', `the hub "${peer.name}" did not give a usable answer`);
      }
      await copyCommits(parties, named);
    }
    const kept = copied(acrossKey(ctx.did, did, peer), named);
    return { body: { group: named, epoch: kept?.epoch ?? 1, commits: (kept?.commits ?? []).filter((entry) => entry.epoch >= from) } };
  };

  // What a paired hub asks about a conversation between an agent of its own (`with`) and one of
  // this hub (`:did`). Who its agents are is its word. This hub takes it, and keeps whatever
  // comes of it under that hub: it never reaches what this hub has with anybody else.

  /** The agent of this hub that a paired hub asks about, and the agent of its own that it asks for. */
  const acrossParties = (ctx, other) => {
    const agent = store.agents.get(ctx.params.did);
    if (agent?.status !== 'active') throw new HttpError(404, 'agent_not_found', 'no agent is registered with that DID');
    if (!isValidDid(other) || other === agent.did) throw new HttpError(400, 'invalid_parameter', '"with" must be the DID of the other agent of the conversation');
    return { local: agent.did, remote: other, key: acrossKey(agent.did, other, ctx.peer), home: isHome(agent.did, other) };
  };
  const requireHome = ({ home }) => {
    if (!home) throw new HttpError(400, 'invalid_parameter', 'that conversation is not kept by this hub: its home is the hub of the other agent');
  };

  route('GET', '/v1/federation/mls/dm/:did', 'peer', (ctx) => {
    const { local, key, home } = acrossParties(ctx, ctx.url.searchParams.get('with'));
    const kept = store.dmGroups.get(key);
    const conversation = kept ? { group: kept.group, generation: kept.generation, epoch: store.mlsLog(kept.group).epoch, members: kept.members } : null;
    return { body: { readers: mlsReaders(local), ...(home ? { conversation } : {}) } };
  });

  route('POST', '/v1/federation/mls/dm/:did/key-packages', 'peer', (ctx) => {
    const { local } = acrossParties(ctx, ctx.json().with);
    // Each claim uses up KeyPackages of the readers of this agent. A paired hub is allowed so many,
    // whichever of its agents it says it asks for.
    limited(`mls-claim:${ctx.peer.did}:${local}`, cfg.limits.mlsClaim);
    const readers = mlsReaders(local);
    const { claimed } = store.commit({ type: 'mls.keys.claim', readers });
    return { body: { key_packages: readers.map((reader) => ({ reader, key_package: claimed[reader] })) } };
  });

  // The next group of a conversation, made by a reader of the agent of the other hub - then this
  // hub is told so that it says whether it is the next one, if it is the home - or made here and
  // settled by the other hub, the home, which tells this one so that its readers are asked in.
  route('PUT', '/v1/federation/mls/dm/:did', 'peer', async (ctx) => {
    const { with: other, group, generation, members, welcome, by } = ctx.json();
    const parties = acrossParties(ctx, other);
    limited(`mls:${ctx.peer.did}:${parties.local}`, cfg.limits.mls);
    const { here } = await checkGroupAcross({ group, generation, members, welcome, by }, dmPairKey(parties.local, parties.remote), store.readersOf(parties.local));
    // Whoever made it is a reader of the other agent: a hub does not make groups in the name of the readers of this one.
    if (here.includes(by)) throw new HttpError(400, 'invalid_group', 'a group that another hub tells of is made by a reader of its own agent');
    if (!parties.home) {
      store.commit({ type: 'mls.welcome.put', group, welcome, readers: here, from: ctx.peer.did });
      return { status: 201, body: { group, generation } };
    }
    return inTurnOf(parties.key, () => {
      const current = store.dmGroups.get(parties.key);
      if (generation !== (current?.generation ?? 0) + 1) throw staleGeneration(current);
      requireRoom(current, ctx.peer);
      requireUnusedName(group);
      store.commit({ type: 'mls.dm.create', pair: parties.key, group, generation, members, welcome, recipients: here, from: ctx.peer.did, keep_earlier: cfg.mlsEarlierGroupsKept, by, at: new Date().toISOString() });
      return { status: 201, body: { group, generation } };
    });
  });

  route('POST', '/v1/federation/mls/dm/:did/commits', 'peer', (ctx) => {
    const { with: other, group, message, by } = ctx.json();
    const parties = acrossParties(ctx, other);
    requireHome(parties);
    limited(`mls:${ctx.peer.did}:${parties.local}`, cfg.limits.mls);
    // A hub commits for the readers of its own agent: not for those of this one, nor for an instance that an agent of this hub removed.
    if (store.readersOf(parties.local).includes(by) || store.removedInstances.has(by)) throw new HttpError(403, 'not_a_member', 'only a member of the group can commit to it');
    return takeCommit(store.dmGroups.get(parties.key), { group, message }, by);
  });

  route('GET', '/v1/federation/mls/dm/:did/commits', 'peer', (ctx) => {
    const parties = acrossParties(ctx, ctx.url.searchParams.get('with'));
    requireHome(parties);
    const { body } = commitsOf(store.dmGroups.get(parties.key), ctx.url.searchParams.get('group') ?? undefined, parseSeq(ctx.url.searchParams.get('from'), 'from') ?? 1);
    // A hub takes only so much from another in one answer: it is given the first commits that fit,
    // and asks for the rest from where these end.
    let size = 0;
    const fit = body.commits.filter((entry, at) => (size += entry.message.length) <= cfg.maxPeerResponseBytes / 2 || at === 0);
    return { body: { ...body, commits: fit } };
  });

  // --- MLS: private topics ------------------------------------------------------------------
  // A private topic over MLS is one group with every reader of every member agent, and it is
  // changed with commits rather than made again. The owner says which agents are members; every
  // agent looks after its own instances. The hub keeps what it is told about who is in, holds
  // whoever tells it to those two rules, orders the commits and hands out the invitations. What a
  // commit really does it cannot see: the members check that themselves when they apply it.

  const getMlsTopic = (name) => {
    const topic = getTopic(name);
    if (topic.encryption !== TOPIC_MLS) throw new HttpError(400, 'not_mls', 'this topic does not use MLS');
    return topic;
  };

  const requireGroupAccess = (topic, ctx) => {
    if (ctx.did !== topic.owner && !isMember(topic, ctx.did)) throw new HttpError(403, 'not_a_member', 'this agent is not a member of this private topic: only its members publish to it, read it or ask about its group');
  };

  const topicGroupView = (topic, alsoAgents = []) => {
    const current = topic.mls;
    const agents = current?.agents ?? [topic.owner];
    return {
      topic: topic.name,
      owner: topic.owner,
      group: current?.group ?? null,
      generation: current?.generation ?? 0,
      epoch: topicEpoch(topic), // goes up by one with every commit; whoever publishes must be at it
      agents, // the member agents, as the owner last said
      members: current?.members ?? [], // the readers in the group, as whoever changed it last said
      // The readers each agent has that can be put in a group right now. When they differ from
      // `members`, somebody entitled to brings the group up to date the next time it uses the topic.
      readers: Object.fromEntries([...new Set([...agents, ...alsoAgents])].map((did) => [did, mlsReaders(did)])),
      // Readers that cannot follow the group and ask to be left out and brought in again.
      rejoin: current?.rejoin ?? [],
    };
  };

  /** The list in a query parameter or a body field: distinct strings, not too many. */
  const didList = (value, what, max) => {
    if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== 'string' || entry.length > 200) || new Set(value).size !== value.length) {
      throw new HttpError(400, 'invalid_group', `${what} must be a list of at most ${max} different DIDs`);
    }
    return value;
  };

  // `agents` asks for the readers of agents that are not members yet: only the owner has a use for it.
  route('GET', '/v1/topics/:name/mls', 'registered', (ctx) => {
    const topic = getMlsTopic(ctx.params.name);
    requireGroupAccess(topic, ctx);
    const asked = ctx.url.searchParams.get('agents');
    const also = asked ? didList(asked.split(','), 'agents', cfg.maxPrivateTopicMembers) : [];
    if (also.length > 0 && ctx.did !== topic.owner) throw new HttpError(403, 'not_owner', 'only the owner asks about agents that are not members');
    for (const did of also) if (store.agents.get(did)?.status !== 'active') throw new HttpError(404, 'member_not_found', `${did} is not an active agent on this hub`);
    return { body: topicGroupView(topic, also) };
  });

  // Takes one KeyPackage of each of the readers named, to bring them into the group. The owner
  // takes anybody's; any other member, only those of its own agent.
  route('POST', '/v1/topics/:name/mls/key-packages', 'registered', (ctx) => {
    limited(`mls:${ctx.did}`, cfg.limits.mls);
    const topic = getMlsTopic(ctx.params.name);
    requireGroupAccess(topic, ctx);
    const readers = didList(ctx.json().readers, 'readers', cfg.maxTopicGroupReaders);
    if (readers.length === 0 || readers.includes(ctx.reader)) throw new HttpError(400, 'invalid_group', 'readers must name at least one reader, and not the one asking');
    const agents = new Set();
    for (const reader of readers) {
      const agent = store.agentOf(reader);
      if (!agent) throw new HttpError(404, 'member_not_found', `${reader} is not a reader of an active agent on this hub`);
      if (ctx.did !== topic.owner && agent !== ctx.did) throw new HttpError(403, 'not_owner', 'only the owner of a topic takes key packages of other agents');
      agents.add(agent);
    }
    for (const agent of agents) limited(`mls-claim:${ctx.did}:${agent}`, cfg.limits.mlsClaim);
    // An instance whose certificate has run out is no longer brought into a group: none of its KeyPackages is handed out.
    const { claimed } = store.commit({ type: 'mls.keys.claim', readers: readers.filter((reader) => !lapsed(reader)) });
    return { body: { key_packages: readers.filter((reader) => claimed[reader] !== undefined).map((reader) => ({ reader, key_package: claimed[reader] })) } };
  });

  /**
   * Who is in the group of a topic, as a request says: member agents, and readers that belong to
   * them. Whoever makes or changes the group is in it, so its agent is a member: the owner always
   * is, since only the owner says which agents are.
   */
  const checkGroupMembers = (ctx, agents, members) => {
    const bad = (message) => new HttpError(400, 'invalid_group', message);
    didList(agents, 'agents', cfg.maxPrivateTopicMembers);
    didList(members, 'members', cfg.maxTopicGroupReaders);
    for (const did of agents) if (store.agents.get(did)?.status !== 'active') throw new HttpError(404, 'member_not_found', `${did} is not an active agent on this hub`);
    if (!members.includes(ctx.reader)) throw bad('whoever makes or changes a group is in it');
    for (const reader of members) if (!agents.includes(store.agentOf(reader))) throw bad(`${reader} is not a reader of a member agent`);
  };

  /** The invitation that goes with a group or a commit: for exactly the readers it says, or none at all. */
  const checkInvitation = async (welcome, invited) => {
    if (invited.length === 0) {
      if (welcome !== undefined && welcome !== null) throw new HttpError(400, 'invalid_mls', 'there is an invitation and nobody to invite');
      return;
    }
    let seen;
    try {
      seen = await inspectMessage(base64Bytes(welcome, 'welcome'));
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, 'invalid_mls', `welcome rejected: ${err.message}`);
    }
    if (seen.wireformat !== 'welcome' || seen.recipients !== invited.length) throw new HttpError(400, 'invalid_mls', 'the welcome must invite exactly the readers brought in');
  };

  /** Subscribers that stop being members stop receiving at once. */
  const subscribersLeftOut = (topic, agents) => [...store.subs.get(topic.name)].filter((did) => !agents.includes(did));

  // Makes the group of a topic: the first one, or the next when the one there is can no longer be
  // used (the owner lost its state, or a commit nobody could apply got in). Only the owner does.
  route(
    'PUT',
    '/v1/topics/:name/mls',
    'registered',
    async (ctx) => {
      limited(`mls:${ctx.did}`, cfg.limits.mls);
      const topic = getMlsTopic(ctx.params.name);
      if (ctx.did !== topic.owner) throw new HttpError(403, 'not_owner', 'only the owner makes the group of a private topic');
      const { group, generation, agents, members, welcome } = ctx.json();
      const current = topic.mls;
      if (generation !== (current?.generation ?? 0) + 1) {
        throw new HttpError(409, 'stale_generation', 'this topic already has that group or a newer one; fetch it again', { generation: current?.generation ?? 0, group: current?.group ?? null });
      }
      const parsed = parseTopicGroupId(group);
      if (!parsed || parsed.topic !== topic.name || parsed.generation !== generation) throw new HttpError(400, 'invalid_group', 'the group id does not name this topic and generation');
      checkGroupMembers(ctx, agents, members);
      const invited = members.filter((reader) => reader !== ctx.reader);
      await checkInvitation(welcome, invited);
      store.commit({
        type: 'mls.topic.create',
        name: topic.name,
        group,
        generation,
        agents,
        members,
        welcome: welcome ?? null,
        invited,
        removed: subscribersLeftOut(topic, agents),
        keep_earlier: cfg.mlsEarlierGroupsKept,
        by: ctx.reader,
        at: new Date().toISOString(),
      });
      log(`topic ${topic.name}: group of generation ${generation} made (${agents.length} agents, ${members.length} readers)`);
      return { status: 201, body: topicGroupView(topic) };
    },
    { maxBody: cfg.maxMlsBodyBytes },
  );

  // A commit to the group of a topic. One ends each epoch, as in a conversation. A commit that
  // changes who is in the group says what the group looks like afterwards: `members`, `invited`
  // with their `welcome` and, from the owner alone, `agents`. One that says nothing renews keys.
  route(
    'POST',
    '/v1/topics/:name/mls/commits',
    'registered',
    async (ctx) => {
      limited(`mls:${ctx.did}`, cfg.limits.mls);
      const topic = getMlsTopic(ctx.params.name);
      const current = topic.mls;
      const body = ctx.json();
      const { group, message } = body;
      if (!current || group !== current.group) throw new HttpError(409, 'stale_group', 'this topic has no such group, or a newer one; fetch it again', { group: current?.group ?? null, generation: current?.generation ?? 0 });
      if (!current.members.includes(ctx.reader)) throw new HttpError(403, 'not_a_member', 'only a member of the group can commit to it');
      let seen;
      try {
        seen = await inspectMessage(base64Bytes(message, 'message'));
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(400, 'invalid_mls', `commit rejected: ${err.message}`);
      }
      if (seen.wireformat !== 'private_message' || seen.contentType !== 'commit' || seen.groupId !== group) throw new HttpError(400, 'invalid_mls', 'message must be an MLS commit of that group');
      const { epoch } = store.mlsLog(group);
      if (seen.epoch !== epoch) throw new HttpError(409, 'stale_epoch', 'another commit already ended that epoch; apply it and try again', { epoch });

      let change = {};
      if (['agents', 'members', 'invited', 'welcome'].some((field) => body[field] !== undefined)) {
        const isOwner = ctx.did === topic.owner;
        if (!isOwner && body.agents !== undefined) throw new HttpError(403, 'not_owner', 'only the owner decides which agents are members of a private topic');
        const agents = body.agents ?? current.agents;
        checkGroupMembers(ctx, agents, body.members);
        const invited = didList(body.invited ?? [], 'invited', cfg.maxTopicGroupReaders);
        if (invited.includes(ctx.reader) || invited.some((reader) => !body.members.includes(reader))) throw new HttpError(400, 'invalid_group', 'whoever is invited is in the group, and is not whoever invites');
        const added = body.members.filter((reader) => !current.members.includes(reader));
        if (added.some((reader) => !invited.includes(reader))) throw new HttpError(400, 'invalid_group', 'every reader brought into the group needs an invitation');
        if (!isOwner) {
          // Anybody but the owner looks after the readers of its own agent, and no others. A reader
          // that reads for nobody any more - an instance that was removed - anyone may drop.
          const left = current.members.filter((reader) => !body.members.includes(reader));
          if ([...invited, ...added].some((reader) => store.agentOf(reader) !== ctx.did) || left.some((reader) => ![ctx.did, null].includes(store.agentOf(reader)))) {
            throw new HttpError(403, 'not_owner', 'a member brings in and leaves out the readers of its own agent, and nobody else');
          }
        }
        await checkInvitation(body.welcome, invited);
        change = { agents, members: body.members, welcome: body.welcome ?? null, invited, removed: subscribersLeftOut(topic, agents) };
      }
      const result = store.commit({ type: 'mls.topic.commit', name: topic.name, group, message, keep: cfg.mlsCommitsKept, ...change });
      return { status: 201, body: { group, epoch: result.epoch } };
    },
    { maxBody: cfg.maxMlsBodyBytes },
  );

  // A reader that cannot follow the group - it lost its state, or fell further behind than the
  // commits the hub keeps - asks to be let in again. Whoever may change that reader in the group
  // does it the next time it uses the topic: the owner for anybody, an agent for its own.
  route('POST', '/v1/topics/:name/mls/rejoin', 'registered', (ctx) => {
    limited(`mls:${ctx.did}`, cfg.limits.mls);
    const topic = getMlsTopic(ctx.params.name);
    requireGroupAccess(topic, ctx);
    const current = topic.mls;
    const { group } = ctx.json();
    if (!current || group !== current.group) throw new HttpError(409, 'stale_group', 'this topic has no such group, or a newer one; fetch it again', { group: current?.group ?? null, generation: current?.generation ?? 0 });
    if (!mlsReaders(ctx.did).includes(ctx.reader)) throw new HttpError(409, 'no_key_package', 'publish a key package first: without one nobody can bring this reader in');
    if (!(current.rejoin ?? []).includes(ctx.reader)) store.commit({ type: 'mls.topic.rejoin', name: topic.name, reader: ctx.reader, cap: cfg.maxTopicGroupReaders });
    return { body: { topic: topic.name, group, asked: true } };
  });

  // The commits of the group of a topic that a reader has not applied yet.
  route('GET', '/v1/topics/:name/mls/commits', 'registered', (ctx) => {
    const topic = getMlsTopic(ctx.params.name);
    requireGroupAccess(topic, ctx);
    const current = topic.mls;
    const group = ctx.url.searchParams.get('group') ?? current?.group;
    if (!current || (group !== current.group && !(current.earlier ?? []).includes(group))) {
      throw new HttpError(404, 'group_not_found', 'this topic has no such group, or its commits are no longer kept');
    }
    const from = parseSeq(ctx.url.searchParams.get('from'), 'from') ?? 1;
    const { epoch, commits } = store.mlsLog(group);
    return { body: { group, epoch, commits: commits.filter((entry) => entry.epoch >= from) } };
  });

  /**
   * What the hub can check of a message sent over MLS, in a conversation or on a topic: that it is
   * one, of the group that is current there (`current`: { group, previous? }) and of its epoch.
   */
  const checkMlsMessage = async (data, current, where) => {
    const bad = (message) => new HttpError(400, 'invalid_event', message);
    if (!isPlainObject(data) || Object.keys(data).length !== 2 || typeof data.group !== 'string') throw bad('encrypted data must have exactly: group, message');
    // Which group is current, and its epoch, is for the hub that keeps the conversation to say. A
    // hub that only hands the message on to the one that does - `current` is then false - looks at
    // what any hub can see of it, and no further.
    const kept = current !== false;
    // The group before the current one is still accepted in a conversation: a message may have been on its way when the new one was made.
    if (kept && (!current || (data.group !== current.group && data.group !== (current.previous ?? null)))) {
      throw new HttpError(409, 'stale_group', `${where} has no such group, or a newer one; fetch it and encrypt again`, { group: current?.group ?? null, generation: current?.generation ?? 0 });
    }
    let seen;
    try {
      seen = await inspectMessage(base64Bytes(data.message, 'message', 'invalid_event'));
    } catch (err) {
      throw err instanceof HttpError ? err : bad(`MLS message rejected: ${err.message}`);
    }
    if (seen.wireformat !== 'private_message' || seen.contentType !== 'application' || seen.groupId !== data.group) throw bad('data.message must be an MLS application message of that group');
    if (!kept) return seen;
    // A message must be of the epoch its group is in: whoever sends it has applied every commit so far,
    // so what it sends is protected by the newest keys and not by ones that may have leaked since.
    const { epoch } = store.mlsLog(data.group);
    if (seen.epoch !== epoch) throw new HttpError(409, 'stale_epoch', 'the keys of this group were renewed; apply the commits and encrypt again', { epoch });
  };

  const checkMlsDirect = (ctx, event) => checkMlsMessage(event.data, store.dmGroups.get(dmPairKey(ctx.did, event.recipient)), 'this conversation');

  route('POST', '/v1/messages', 'registered', async (ctx) => {
    limited(`direct:${ctx.did}`, cfg.limits.direct);
    requireScope(ctx, 'direct');
    const now = Date.now();
    chargeSend(ctx.agent, now);
    const envelope = acceptEnvelope(ctx, now);
    const { event } = envelope;
    if (typeof event.recipient !== 'string' || !isValidDid(event.recipient)) {
      throw new HttpError(400, 'invalid_event', 'direct messages need a "recipient" attribute holding a DID');
    }
    if (event.recipient === ctx.did) throw new HttpError(400, 'invalid_event', 'an agent cannot message itself');
    if (event.subject !== undefined) throw new HttpError(400, 'invalid_event', 'direct messages must not carry a subject');
    // A message may say which hub its recipient is on. If that is another hub, it goes there.
    if (event.hub !== undefined && event.hub !== identity.did) return sendRemote(ctx, envelope);
    if (event.encryption !== undefined) {
      // The hub cannot read the content; it only checks that it has the shape of a sealed message.
      if (event.encryption !== DIRECT_ENCRYPTION && event.encryption !== DIRECT_MLS) throw new HttpError(400, 'invalid_event', `unsupported encryption "${String(event.encryption).slice(0, 40)}"`);
      if (event.type !== ENCRYPTED_EVENT_TYPE) throw new HttpError(400, 'invalid_event', `encrypted messages must have type "${ENCRYPTED_EVENT_TYPE}"`);
      requireRecipient(event.recipient);
      if (event.encryption === DIRECT_MLS) {
        await checkMlsDirect(ctx, event);
      } else {
        const problem = checkSealedShape(event.data);
        if (problem) throw new HttpError(400, 'invalid_event', problem);
      }
    } else if (cfg.requireDirectEncryption) {
      throw new HttpError(403, 'encryption_required', 'this hub only relays end-to-end encrypted direct messages');
    }
    requireRecipient(event.recipient);
    if (store.hasSeen(event)) return { body: { id: event.id, recipient: event.recipient, duplicate: true } };
    // One that the recipient blocked is taken and dropped: whoever is blocked is not told.
    if (blocks(event.recipient, ctx.did)) return { status: 202, body: { id: event.id, recipient: event.recipient, duplicate: false, recipient_online: false } };
    const result = store.commit({ type: 'dm.send', envelope, tier: ctx.tier, at: new Date(now).toISOString() });
    push(result.deliveries);
    return { status: 202, body: { id: event.id, recipient: event.recipient, duplicate: false, recipient_online: isOnline(event.recipient) } };
  });

  // --- transparency log ---------------------------------------------------------------------
  // Every change to the directory is an entry of a list that only grows, and the hub signs for
  // what that list is. Anybody can read it whole and check that it holds: see core/log.mjs.

  const hex = (hash) => hash.toString('hex');
  /** A count given in the query: `fallback` if it is not there. */
  const countParam = (ctx, name, fallback) => parseSeq(ctx.url.searchParams.get(name), name) ?? fallback;

  // --- witnesses ------------------------------------------------------------------------------
  // Whoever follows the log of this hub knows that what it reads follows from what it read before.
  // It does not know that everybody else is shown the same. Witnesses are for that: services run by
  // others (src/witness/), which this hub shows its checkpoint to every few seconds and which cosign
  // it only if it follows from the one they cosigned last. A reader that asks for witnesses takes the
  // log only as far as enough of them have cosigned it (sdk/follower.mjs). The formats are C2SP's,
  // so a witness need not be of this project (core/note.mjs, core/witness.mjs).

  /** The log now, as the checkpoint this hub signs for witnesses and for anybody: three lines and its signature. */
  const ownCheckpoint = () => {
    const { size, root } = store.logHead();
    const text = checkpointText({ origin: identity.did, size, root });
    return { size, text, line: signNoteText(text, logSigner) };
  };
  let witnessed = null; // the last checkpoint a witness cosigned, with what they signed: { size, text, lines }
  let witnessing = null; // the round under way, if any

  /** Asks one witness to cosign a checkpoint. Returns its signature lines, or throws saying why there are none. */
  async function cosignedBy(witness, { size, text, line }) {
    // It is asked from where this hub believes it is. If it is somewhere else it says where, and it is asked once more from there.
    for (let attempt = 0; attempt < 2; attempt++) {
      const old = witness.size;
      if (old > size) throw new Error(`it has cosigned ${old} entries of this log, more than the log has now: a log that went back is not cosigned`);
      const body = formatAddCheckpoint({ old, proof: old === 0 ? [] : store.logTree.consistencyProof(old, size), note: formatNote(text, [line]) });
      const res = await fetchPeer(`${witness.url}/add-checkpoint`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body, redirect: 'error', signal: AbortSignal.timeout(cfg.peerTimeoutMs) });
      const answer = await readPeerAnswer(res);
      if (res.status === 409) {
        const at = /^(0|[1-9][0-9]{0,15})\n$/.exec(answer)?.[1];
        if (at === undefined) throw new Error('it says it is elsewhere and not where');
        witness.size = Number(at);
        continue;
      }
      if (res.status !== 200) throw new Error(`it answered ${res.status}`);
      const lines = parseSignatures(answer).filter((given) => given.name === witness.verifier.name && given.id.equals(witness.verifier.id));
      if (checkSignatures(text, lines, { witnesses: [witness.verifier] }).cosigned.length !== 1) throw new Error('its answer carries no cosignature of its key');
      witness.size = size;
      return lines;
    }
    throw new Error('it keeps saying it is elsewhere');
  }

  /**
   * Shows the log as it is now to every witness, and keeps what they cosigned. One round at a time.
   * Returns how many cosigned. A round nobody cosigned leaves the one before it in place: it is older,
   * and it is still something a reader can check.
   */
  function witnessNow() {
    if (witnesses.length === 0) return Promise.resolve(0);
    witnessing ??= (async () => {
      // What they cosign ends where the log says the state of its directory, so that whoever takes
      // the log only as far as they cosigned it can still be shown one name of that state.
      await stateNow();
      const checkpoint = ownCheckpoint();
      const answers = await Promise.all(
        witnesses.map((witness) =>
          cosignedBy(witness, checkpoint).catch((err) => {
            // Said once for each change of what is wrong, not every round.
            if (witness.problem !== err.message) log(`witness ${printed(witness.verifier.name)} (${witness.url}) did not cosign: ${printed(err.message)}`);
            witness.problem = err.message;
            return null;
          }),
        ),
      );
      for (const [at, lines] of answers.entries()) {
        if (lines && witnesses[at].problem) log(`witness ${printed(witnesses[at].verifier.name)} cosigns again`);
        if (lines) witnesses[at].problem = null;
      }
      const lines = answers.filter(Boolean).flat();
      if (lines.length > 0) witnessed = { size: checkpoint.size, text: checkpoint.text, lines: [checkpoint.line, ...lines] };
      return answers.filter(Boolean).length;
    })().finally(() => {
      witnessing = null;
    });
    return witnessing;
  }

  // The log as a checkpoint of C2SP, signed by this hub: the last one its witnesses cosigned, with
  // their cosignatures, or, on a hub that has none, what the log is now. A hub that has witnesses and
  // nothing cosigned yet has nothing to show here.
  route('GET', '/v1/log/note', false, (ctx) => {
    limited(`log:${ctx.ip}`, cfg.limits.log);
    if (witnesses.length > 0 && witnessed === null) throw new HttpError(404, 'not_witnessed', 'no witness has cosigned the log of this hub yet');
    const { text, lines } = witnessed ?? (({ text: now, line }) => ({ text: now, lines: [line] }))(ownCheckpoint());
    return { text: formatNote(text, lines) };
  });

  // What the log is now, signed with the key of the hub. Signed afresh each time, so it also says when.
  route('GET', '/v1/log/checkpoint', false, (ctx) => {
    limited(`log:${ctx.ip}`, cfg.limits.log);
    return { body: signCheckpoint(identity, store.logHead()) };
  });

  route('GET', '/v1/log/entries', false, (ctx) => {
    limited(`log:${ctx.ip}`, cfg.limits.log);
    const from = countParam(ctx, 'from', 0);
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 100, 200);
    return { body: { from, size: store.log.length, entries: store.log.slice(from, from + limit) } };
  });

  // Proof that the entry at `index` is in the log as it was with `size` entries.
  route('GET', '/v1/log/inclusion', false, (ctx) => {
    limited(`log:${ctx.ip}`, cfg.limits.log);
    const size = countParam(ctx, 'size', store.log.length);
    const index = countParam(ctx, 'index');
    if (index === undefined || size > store.log.length || index >= size) throw new HttpError(400, 'invalid_parameter', 'index must be an entry of the log at that size, and size one the log has reached');
    return { body: { index, size, leaf: hex(entryLeaf(store.log[index])), proof: store.logTree.inclusionProof(index, size).map(hex) } };
  });

  // Proof that the log as it was with `first` entries is the beginning of the log with `second`.
  route('GET', '/v1/log/consistency', false, (ctx) => {
    limited(`log:${ctx.ip}`, cfg.limits.log);
    const second = countParam(ctx, 'second', store.log.length);
    const first = countParam(ctx, 'first');
    if (first === undefined || second > store.log.length || first > second) throw new HttpError(400, 'invalid_parameter', 'first and second must be sizes the log has reached, first no greater than second');
    return { body: { first, second, proof: store.logTree.consistencyProof(first, second).map(hex) } };
  });

  // --- the state of the directory, for whoever has not read the log --------------------------------
  // Reading the log tells everything, and costs as much as the log is long. Whoever only wants to
  // know what it says of one agent, or one topic, is shown that and nothing else: the directory is
  // also a map that one hash tells (core/statemap.mjs), this hub puts that hash on record in an
  // entry of its own ("log.state"), and what the map has under one name comes with the hashes that
  // tie it to that entry, and that entry to a checkpoint of the log. The entry is written when
  // somebody asks and something has changed since the last, and before each round of witnesses:
  // a log nobody asks this of does not grow for it.
  //
  // The hub works the state out the way any reader does, with the rules of the log over its own
  // entries, so there is one way of telling what a directory comes to and not two.
  const told = new Directory({ hub: identity.did }); // the directory as this hub's own log tells it, as far as it has been read here
  const views = []; // { size, view }: the state where the log said it, the latest last
  const VIEWS_KEPT = 32; // more than the rounds of witnesses that fit in the time a cosignature counts for
  let telling = Promise.resolve();

  /** The state of the directory at the head of the log, { size, view }, with the entry that says it written if it was not. One at a time. */
  function stateNow() {
    const next = telling.then(async () => {
      for (;;) {
        while (told.size < store.log.length) {
          const entry = store.log[told.size];
          await told.apply(entry);
          if (entry.type === 'log.state') {
            views.push({ size: told.size, view: told.stateView() });
            if (views.length > VIEWS_KEPT) views.shift();
          }
        }
        // Nothing is waited for from here to the answer: the log is as long as it was a line ago.
        if (store.log.at(-1)?.type === 'log.state') return views.at(-1);
        store.commit({ type: 'log.state', state: told.stateRoot, at: new Date().toISOString() });
      }
    });
    telling = next.catch(() => {});
    return next;
  }

  // What the directory has under one name, or that it has nothing, as the log says it: at the head
  // of the log or, with `size`, where the log said its state with that many entries, if this hub
  // still keeps it - what its witnesses last cosigned, it does. core/log.mjs (verifyStateAnswer)
  // says how the answer is checked.
  route('GET', '/v1/log/state', false, async (ctx) => {
    limited(`log:${ctx.ip}`, cfg.limits.log);
    const name = ctx.url.searchParams.get('name');
    if (typeof name !== 'string' || name.length === 0 || name.length > 400) throw new HttpError(400, 'invalid_parameter', 'name must be a name of the directory, like agent:DID or topic:NAME');
    const size = countParam(ctx, 'size');
    const at = size === undefined ? await stateNow() : views.find((kept) => kept.size === size);
    if (!at) throw new HttpError(404, 'state_not_kept', 'this hub keeps no state of its directory for the log at that size: ask without a size, or for the size its witnesses last cosigned');
    const { kept, proof } = at.view.prove(name);
    return {
      body: {
        name,
        size: at.size,
        checkpoint: signCheckpoint(identity, { size: at.size, root: store.logTree.root(at.size) }),
        entry: store.log[at.size - 1],
        inclusion: store.logTree.inclusionProof(at.size - 1, at.size).map(hex),
        record: kept === undefined ? null : JSON.parse(kept),
        proof,
      },
    };
  });

  // --- federation ---------------------------------------------------------------------------
  // What this hub and the hubs it is paired with say to each other. See federation.mjs.

  /** Reads the answer of another hub, up to a size: it is not trusted to be short. */
  const readPeerAnswer = async (res) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > cfg.maxPeerResponseBytes) throw new Error('answer too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  /**
   * Asks something of a paired hub, signed with the key of this one. Returns { status, json }:
   * `json` is null if the answer was not JSON. Throws 502 "peer_unreachable" if it does not answer.
   */
  const askPeer = async (peer, method, path, body, timeoutMs = cfg.peerTimeoutMs) => {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...signRequest(identity, method, peer.url + path, payload) };
    try {
      // Redirects are not followed: a signed request goes to the address the operator gave, and nowhere else.
      const res = await fetchPeer(peer.url + path, { method, headers, body: body === undefined ? undefined : payload, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const text = await readPeerAnswer(res);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON: the caller sees null */
      }
      return { status: res.status, json };
    } catch {
      throw new HttpError(502, 'peer_unreachable', `the hub "${peer.name}" does not answer`);
    }
  };

  /**
   * Finds out whether the pairing with `name` stands: whether whoever answers at its address
   * holds the key the operator was given, and knows this hub in turn. Returns the peer with its
   * `state`: "paired", "refused" (it does not know this hub), "mismatch" (it is not who it should
   * be) or "unreachable".
   */
  /** Asks a hub who it is, at the address it was given: null if it is the hub of that key, talking to this one; why not, if not. */
  const helloFrom = async (peer) => {
    const challenge = randomBytes(18).toString('base64url');
    let answer;
    try {
      answer = await askPeer(peer, 'GET', `/v1/federation/hello?challenge=${challenge}`);
    } catch {
      return { state: 'unreachable', detail: 'it does not answer at that address' };
    }
    if (answer.status === 403 && answer.json?.error?.code === 'not_a_peer') return { state: 'refused', detail: 'it is not paired with this hub: its operator has to add this hub too' };
    // Only the code is looked at: what another hub writes is not repeated, not even to the operator.
    if (answer.status === 401 && answer.json?.error?.code === 'wrong_hub') return { state: 'mismatch', detail: 'it is reached at another address than the one it was paired with: pair it with the one it gives in /v1/info' };
    if (answer.status === 401) return { state: 'mismatch', detail: 'it does not take the signed requests of this hub: it may be of a version from before requests were signed for one hub' };
    if (answer.status !== 200) return { state: 'unreachable', detail: `it answered ${answer.status}` };
    const problem = checkHello(answer.json, { hub: peer.did, peer: identity.did, challenge });
    return problem ? { state: 'mismatch', detail: problem } : null;
  };

  /** Whether a hub lets others pair themselves with it, as it says in /v1/info. Its answer is read as data. */
  const opensPairing = async (peer) => {
    try {
      const res = await fetchPeer(`${peer.url}/v1/info`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(cfg.peerTimeoutMs) });
      return res.ok && JSON.parse(await readPeerAnswer(res))?.federation?.open_pairing === true;
    } catch {
      return false;
    }
  };

  const checkPairing = async (name) => {
    const peer = peers.get(name);
    if (!peer) throw new Error(`there is no peer called "${name}"`);
    const settle = (state, detail = null) => {
      Object.assign(peer, { state, detail, checked_at: new Date().toISOString() });
      return { name: peer.name, did: peer.did, url: peer.url, state, detail };
    };
    let problem = await helloFrom(peer);
    // A hub that lets others pair themselves with it, and has not paired with this one: this one asks.
    if (problem?.state === 'refused' && (await opensPairing(peer))) {
      const asked = await askPeer(peer, 'POST', '/v1/federation/pairings', { name: ownName(), url: publicUrl }).catch(() => null);
      if (asked?.status === 200 || asked?.status === 201) problem = await helloFrom(peer);
      else if (asked) problem = { state: 'refused', detail: `it lets hubs pair themselves with it, but not this one (${typeof asked.json?.error?.code === 'string' && /^[a-z_]{1,40}$/.test(asked.json.error.code) ? asked.json.error.code : asked.status})` };
    }
    return problem ? settle(problem.state, problem.detail) : settle('paired');
  };

  // A hub pairs itself with this one, if its operator opened it to that. The hub signs the request with
  // its key, and proves that it answers at the address it gives: asked there who it is, it answers with
  // that key, to this hub, for a challenge of this hub. For that, it must have paired with this one first.
  route('POST', '/v1/federation/pairings', 'signed', async (ctx) => {
    if (cfg.openPairing === false) throw new HttpError(403, 'pairing_closed', 'this hub pairs only with the hubs its operator names');
    limited(`pairing:${ctx.ip}`, cfg.limits.pairing);
    const existing = peerByDid(ctx.signer);
    if (existing) return { body: { name: existing.name, hub: identity.did } };
    const body = ctx.json();
    let peer;
    try {
      peer = checkPeer({ name: body.name, url: body.url, did: ctx.signer }, { own: identity.did, others: [...peers.values()] });
    } catch (err) {
      throw new HttpError(409, 'pairing_conflict', err.message);
    }
    if (store.agents.has(peer.did) || store.instances.has(peer.did)) throw new HttpError(409, 'hub_conflict', 'that key is registered on this hub as an agent, or as an instance of one');
    if (store.pairings.size >= cfg.openPairing.maxPeers) throw new HttpError(403, 'quota_exceeded', 'this hub takes no more hubs that pair themselves with it');
    // Whoever has a key can ask, and this hub then talks to the address given: only to one on the internet,
    // over HTTPS, and not to this hub's own network. (A test, or a network of one's own, can allow others.)
    if (!cfg.openPairing.privateAddresses) {
      const { protocol, hostname } = new URL(peer.url);
      // An address written out is itself, and is not asked about: with its brackets, an IPv6 one would be
      // looked up as a name. A name is asked about for as long as a hub is given to answer, and no longer.
      const host = hostname.replace(/^\[(.*)\]$/, '$1');
      const resolved = () => (isIP(host) ? [{ address: host }] : within(cfg.peerTimeoutMs, lookupPeer(host, { all: true })).catch(() => []));
      const addresses = protocol === 'https:' ? await resolved() : [];
      if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
        throw new HttpError(400, 'invalid_peer_address', 'a hub that pairs itself with this one is reached over HTTPS at a public address');
      }
    }
    const problem = await helloFrom(peer);
    if (problem) throw new HttpError(409, 'pairing_unconfirmed', problem.state === 'refused' ? 'pair with this hub first (with its address and key), then ask' : `the hub at that address did not answer as the hub of that key (${problem.state})`);
    if (peerByDid(peer.did) || peers.has(peer.name)) throw new HttpError(409, 'pairing_conflict', 'another hub took that name or key meanwhile');
    store.commit({ type: 'pairing.put', name: peer.name, url: peer.url, did: peer.did, at: new Date().toISOString() });
    addPeer(peer);
    Object.assign(peers.get(peer.name), { state: 'paired', checked_at: new Date().toISOString() });
    log(`hub "${peer.name}" (${peer.url}, ${peer.did}) paired itself with this one`);
    return { status: 201, body: { name: peer.name, hub: identity.did } };
  });

  // A paired hub asks who this one is. The answer is signed, for it alone and for this question.
  route('GET', '/v1/federation/hello', 'peer', (ctx) => {
    const challenge = ctx.url.searchParams.get('challenge');
    if (!isChallenge(challenge)) throw new HttpError(400, 'invalid_parameter', 'challenge must be 16 to 64 base64url characters');
    return { body: { protocol: FEDERATION_PROTOCOL, ...signHello(identity, { peer: ctx.peer.did, challenge }) } };
  });

  // The hubs this one is paired with, for its agents: their names are how their topics are named here.
  route('GET', '/v1/federation/peers', 'registered', () => ({
    body: { hub: identity.did, peers: [...peers.values()].map(({ name, did, url, state, checked_at: checkedAt }) => ({ name, did, url, state, checked_at: checkedAt })) },
  }));

  // --- federation: topics across hubs -------------------------------------------------------
  //
  // An agent of this hub can follow and publish to the public topics of a hub this one is paired
  // with. Here such a topic is named "topic@peer". This hub stands between its agents and the hub
  // the topic lives on: it asks that hub for the contract of the topic, follows the topic with its
  // own key and hands on to its agents what arrives, and forwards what they publish. The hub the
  // topic lives on applies the contract and the rules of the topic, as to anything published there.
  //
  // Only topics that anybody may read travel this way. One with a subscribe policy, or a private
  // one, would need the other hub to be trusted with its rules. And there are no hops: a hub
  // reaches the topics of the hubs it is paired with, not those of their peers.

  /** A topic of this hub that other hubs may follow: public, and read by anybody. */
  const federated = (topic) => !topic.encryption && topic.subscribe === 'any';

  /** Who receives an event published on `topic` by `source`: its subscribers here, and the paired hubs that follow it. */
  const recipientsOf = (topic, source, now) =>
    [...store.subs.get(topic.name)].filter((did) => {
      if (did === source) return false;
      if (store.peers.has(did)) return Boolean(peerByDid(did)); // a hub that is no longer paired gets nothing
      const agent = store.agents.get(did);
      return Boolean(agent) && mayRead(topic, agent, now) && !blocks(did, source);
    });

  /** An event may point to the schema of its topic. If it does, it is to this topic's. */
  const checkDataschema = (event, topic) => {
    if (event.dataschema === undefined) return;
    let pathname = null;
    try {
      pathname = new URL(event.dataschema).pathname;
    } catch {
      /* handled below */
    }
    if (pathname !== `/v1/topics/${topic.name}/schema`) throw new HttpError(400, 'invalid_event', 'dataschema does not point to the schema of this topic');
  };

  /** The parts of the name "topic@peer": { topic, peer }. A refusal if that is not what `name` is. */
  const remoteParts = (name) => {
    const split = splitTopicName(name);
    if (!split) throw new HttpError(404, 'topic_not_found', `"${String(name).slice(0, 128)}" is not the name of a topic`);
    return split;
  };

  /** If `name` is "topic@peer", what it names: { name, topic, peer }. Null for a topic of this hub. */
  const remoteName = (name) => {
    if (!String(name).includes('@')) return null;
    const split = remoteParts(name);
    const peer = peers.get(split.peer);
    if (!peer) throw new HttpError(404, 'peer_not_found', `this hub is not paired with a hub it calls "${split.peer}"`);
    return { name, topic: split.topic, peer };
  };

  const REFUSAL_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
  // Why another hub turns something away, in the words of this one.
  const REFUSALS = {
    topic_not_found: 'it has no such topic that other hubs can follow',
    publish_not_allowed: 'the topic restricts who can publish, and there this agent is a key nobody answers for: a delegation shown to this hub does not count on another',
    schema_validation_failed: 'data does not match the topic schema',
    invalid_event: 'it does not take this event on that topic',
    invalid_envelope: 'it does not take the signature of this event',
    agent_revoked: 'this agent has been revoked there',
    agent_suspended: 'the operators of that hub suspended this agent there',
    topic_suspended: 'the operators of that hub suspended that topic',
    rate_limited: 'too much is being asked of it: try again in a while',
    quota_exceeded: 'it already keeps as much for this hub as it allows: topics that this one follows, or conversations with its agents',
    agent_not_found: 'it has no such agent',
    recipient_not_found: 'the recipient is not registered there',
    recipient_succeeded: 'the recipient was handed over to a successor there',
    encryption_required: 'it only takes direct messages that are encrypted end to end',
    stale_generation: 'the conversation already has that group or a newer one',
    stale_group: 'the conversation has no such group, or a newer one',
    stale_epoch: 'the keys of the group were renewed: apply the commits and try again',
    not_a_member: 'only a member of the group can do that',
    group_not_found: 'the conversation has no such group, or its commits are no longer kept',
    invalid_group: 'it does not take that group for the conversation',
    invalid_mls: 'it does not take that as what MLS should carry there',
    not_found: 'it has nothing there to ask for',
    commits_unavailable: 'it could not get from this hub the commits that its readers would need to open that message',
  };

  /**
   * Asks a paired hub and returns what it answered. If it refused, throws a refusal with the same
   * status and code, so that an agent learns why its event was turned away where the topic lives.
   * Only the code is taken from the other hub, and only if it is one of those this hub knows a
   * hub to give: the words are this hub's. What an agent, or the model behind it, reads as an
   * error of its own hub is never text that another hub wrote, nor a code that it made up. The
   * refusal says which hub it comes from (`peer`, in its details).
   */
  const peerAnswer = async (peer, method, path, body, timeoutMs) => {
    const { status, json } = await askPeer(peer, method, path, body, timeoutMs);
    if (status >= 200 && status < 300 && isPlainObject(json)) return json;
    const given = isPlainObject(json) && isPlainObject(json.error) ? json.error.code : null;
    const code = typeof given === 'string' && REFUSAL_CODE_RE.test(given) ? given : null;
    if (status === 403 && code === 'not_a_peer') throw new HttpError(502, 'peer_refused', `the hub "${peer.name}" is not paired with this one: its operator has to add this hub too`);
    // It did not take the request as coming from this hub. Whoever is calling can do nothing about that.
    if (status === 401 && code) throw new HttpError(502, 'peer_refused', `the hub "${peer.name}" did not accept the request of this one (${code}): the clocks of the two hubs may be too far apart`);
    if (status >= 400 && status < 500 && code) {
      // A code this hub knows is passed on, with the hub it speaks of: whoever reads it must not
      // take it for something this hub says of them. Any other is the other hub's own word, and
      // what this one answers is only that it was turned away.
      if (Object.hasOwn(REFUSALS, code)) throw new HttpError(status, code, `the hub "${peer.name}" refused: ${REFUSALS[code]}`, { peer: peer.name });
      throw new HttpError(502, 'peer_refused', `the hub "${peer.name}" refused, with a reason this one does not know`, { peer: peer.name });
    }
    throw new HttpError(502, 'peer_unreachable', `the hub "${peer.name}" did not give a usable answer`);
  };

  /**
   * What this hub asks of a paired hub for whoever is calling comes out of an allowance: each
   * registered agent has its own, and callers that are not registered share one per hub. A hub
   * allows another so much and no more: without this, anybody could use that up with lookups, and
   * with it what the agents of this hub publish there.
   */
  const rationed = (ctx, peer) => (ctx.agent ? limited(`remote:${ctx.did}`, cfg.limits.remote) : limited(`lookup:${peer.name}`, cfg.limits.peerLookup));

  /** A count as another hub gives it: what it says, if that is a count. */
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

  /** The address a hub gives for the schema of its topic `name`, if it is one and it points there. */
  const schemaUrlOf = (given, name) => {
    if (typeof given !== 'string' || given.length > 500 || !URL.canParse(given)) return null;
    const url = new URL(given);
    const plain = /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    return plain && url.pathname.endsWith(`/v1/topics/${name}/schema`) ? url.href : null;
  };

  /**
   * What a paired hub says about one of its topics, as this hub shows it to its agents: under the
   * name "topic@peer", and with nothing in it that was not expected. Null if it is not a topic
   * that travels, or does not look like one.
   */
  const remoteView = (peer, given) => {
    if (!isPlainObject(given) || typeof given.name !== 'string' || given.name.length > 128 || !TOPIC_NAME_RE.test(given.name)) return null;
    if (given.encryption || given.subscribe !== 'any') return null;
    if (typeof given.description !== 'string' || !isValidDid(given.owner)) return null;
    const schemaUrl = schemaUrlOf(given.schema_url, given.name);
    if (!schemaUrl) return null;
    let publish;
    try {
      publish = parsePolicy(given.publish, 'publish', { allowOwner: true });
    } catch {
      return null;
    }
    const view = {
      name: remoteTopicName(given.name, peer.name),
      description: given.description.slice(0, 500),
      owner: given.owner,
      publish,
      subscribe: 'any',
      encryption: null,
      hub: peer.did, // as the operator of this hub was told when pairing, not as the other hub says
      peer: peer.name,
      created_at: typeof given.created_at === 'string' && RFC3339_RE.test(given.created_at) ? given.created_at : null,
      subscribers: count(given.subscribers),
      last_seq: count(given.last_seq),
      schema_url: schemaUrl,
    };
    if (given.schema === undefined) return view;
    // The schema is what its agents will check events against: it has to be one they can.
    if (!isPlainObject(given.schema) || Buffer.byteLength(JSON.stringify(given.schema)) > cfg.maxSchemaBytes || checkSchema(given.schema).length > 0) return null;
    return { ...view, schema: given.schema };
  };

  const remoteViews = new Map(); // "topic@peer" -> { view, expires }

  /**
   * The contract of a topic of another hub, as that hub gives it now or gave it a moment ago. If
   * it has to be asked for, that comes out of the allowance of whoever `ctx` says is calling.
   */
  const remoteTopic = async (remote, ctx) => {
    const cached = remoteViews.get(remote.name);
    if (cached && cached.expires > Date.now()) return cached.view;
    if (ctx) rationed(ctx, remote.peer);
    const view = remoteView(remote.peer, await peerAnswer(remote.peer, 'GET', `/v1/federation/topics/${encodeURIComponent(remote.topic)}`));
    if (!view || view.name !== remote.name || view.schema === undefined) throw new HttpError(502, 'peer_unreachable', `the hub "${remote.peer.name}" did not give a usable answer`);
    remoteViews.set(remote.name, { view, expires: Date.now() + cfg.remoteTopicTtlMs });
    if (remoteViews.size > 1000) remoteViews.delete(remoteViews.keys().next().value);
    return view;
  };

  /**
   * What a paired hub says of one of its agents, as this hub shows it: the card, if it carries the
   * signature of the agent and is one this hub would have taken, and where the agent is. Null
   * otherwise. To this hub an agent of another is a key: the delegation goes along for whoever
   * wants to check the signature of its controller, but who that controller is, this hub has not checked.
   */
  const remoteAgentView = (peer, given) => {
    if (!isPlainObject(given) || !isValidDid(given.did) || given.status !== 'active') return null;
    if (!verifyCardEnvelope({ card: given.card, proof: given.proof }).ok) return null;
    try {
      validateCard(given.card, given.did);
    } catch {
      return null;
    }
    const envelope = given.delegation;
    const delegated = isPlainObject(envelope) && isPlainObject(envelope.delegation) && typeof envelope.delegation.issuer === 'string' && Buffer.byteLength(JSON.stringify(envelope)) <= 8192;
    const time = (value) => (typeof value === 'string' && RFC3339_RE.test(value) ? value : null);
    return {
      did: given.did,
      address: agentAddress(given.did, peer.name),
      hub: peer.did, // as the operator of this hub was told when pairing, not as the other hub says
      peer: peer.name,
      tier: 'key',
      status: 'active',
      card: given.card,
      proof: given.proof,
      controller: delegated ? { did: envelope.delegation.issuer.slice(0, 300), verified_as: null } : null,
      delegation: delegated ? envelope : null,
      registered_at: time(given.registered_at),
      updated_at: time(given.updated_at),
    };
  };

  /** If `address` is "did@peer", what it names: { did, peer }. Null for an agent of this hub. */
  const remoteAddress = (address) => {
    if (!String(address).includes('@')) return null;
    const split = splitAgentAddress(address);
    if (!split) throw new HttpError(404, 'agent_not_found', 'that is not the address of an agent');
    const peer = peers.get(split.peer);
    if (!peer) throw new HttpError(404, 'peer_not_found', `this hub is not paired with a hub it calls "${split.peer}"`);
    return { did: split.did, peer };
  };

  /** An agent of another hub, as that hub gives it now. Asking for it comes out of the allowance of whoever is calling. */
  const remoteAgent = async ({ did, peer }, ctx) => {
    rationed(ctx, peer);
    const view = remoteAgentView(peer, await peerAnswer(peer, 'GET', `/v1/federation/agents/${encodeURIComponent(did)}`));
    if (!view || view.did !== did) throw new HttpError(502, 'peer_unreachable', `the hub "${peer.name}" did not give a usable answer`);
    return view;
  };

  // What can be searched for on a paired hub: where it is asked for, what the answer lists it
  // under, how each entry is shown here and the text it is ranked by.
  const REMOTE_TOPICS = { path: '/v1/federation/topics', list: 'topics', show: remoteView, text: (view) => `${bareTopicName(view.name)} ${bareTopicName(view.name)} ${view.description}` };
  const REMOTE_AGENTS = { path: '/v1/federation/agents', list: 'agents', show: remoteAgentView, text: agentText };

  /**
   * Asks every paired hub for its topics or its agents that match, as entries to rank: { text, view }.
   * A hub that does not answer in time is left out, and named. So is one that the caller's allowance does not reach.
   */
  const searchPeers = async (ctx, what, query, limit) => {
    const answers = await Promise.all(
      [...peers.values()].map(async (peer) => {
        try {
          rationed(ctx, peer);
          const answer = await peerAnswer(peer, 'GET', `${what.path}?q=${encodeURIComponent(query)}&limit=${limit}`, undefined, cfg.peerSearchTimeoutMs);
          const views = (Array.isArray(answer[what.list]) ? answer[what.list].slice(0, limit) : []).map((given) => what.show(peer, given)).filter(Boolean);
          return { peer, found: views.map((view) => ({ text: what.text(view), view })) };
        } catch {
          return { peer, found: null };
        }
      }),
    );
    return {
      found: answers.flatMap(({ found }) => found ?? []),
      unreachable: answers.filter(({ found }) => found === null).map(({ peer }) => peer.name),
    };
  };

  // What this hub follows of another, that hub is told whole: the complete list every time, when it
  // changes, when the stream between the two is opened, and every so often. A message that is lost,
  // or a hub that forgets, puts the two out of step only until the next message. And the messages
  // to one hub go one at a time, each with the list as it is when it leaves: two that crossed on
  // the way would leave the other hub with the older list.

  /** The topics of `peer` that this hub follows, by the names they have here. */
  const followsOf = (peer) => [...store.remoteTopics.keys()].filter((name) => splitTopicName(name)?.peer === peer.name);

  const peerTurns = new Map(); // peer name -> { last, waiting }: the last message to it about what is followed, and how many wait behind
  const inTurnWith = (peer, exchange) => {
    const turns = peerTurns.get(peer.name) ?? { last: Promise.resolve(), waiting: 0 };
    peerTurns.set(peer.name, turns);
    // A hub that is slow to answer does not get to hold up more than a few of those who ask through this one.
    if (turns.waiting >= 10) return Promise.reject(new HttpError(502, 'peer_unreachable', `the hub "${peer.name}" is slow to answer: try again in a while`));
    turns.waiting += 1;
    const turn = turns.last.then(exchange).finally(() => {
      turns.waiting -= 1;
    });
    turns.last = turn.catch(() => {});
    return turn;
  };

  /** Tells `peer` everything this hub follows of it, and `also`. Returns what that hub says this one follows now. */
  const sendFollows = async (peer, also = []) => {
    const topics = [...new Set([...followsOf(peer).map(bareTopicName), ...also])];
    const answer = await peerAnswer(peer, 'PUT', '/v1/federation/follows', { topics });
    return Array.isArray(answer.followed) ? answer.followed : [];
  };

  const tellFollows = (peer) => inTurnWith(peer, () => sendFollows(peer));

  /** Starts following a topic of another hub for an agent of this one. */
  const followRemote = async (ctx, remote) => {
    const subscribed = () => store.agentSubs.get(ctx.did);
    const withinQuota = () => {
      if ((subscribed()?.size ?? 0) >= cfg.maxSubscriptionsPerAgent) throw new HttpError(403, 'quota_exceeded', `at most ${cfg.maxSubscriptionsPerAgent} subscriptions per agent`);
    };
    if (subscribed()?.has(remote.name)) return { topic: remote.name, subscribed: true };
    requireScope(ctx, 'subscribe', remote.name);
    withinQuota();
    if (store.remoteTopics.has(remote.name)) {
      store.commit({ type: 'sub.add', did: ctx.did, topic: remote.name });
    } else {
      // The first agent here to follow it: this hub asks the other for the topic, and to be sent what is published on it.
      rationed(ctx, remote.peer);
      await remoteTopic(remote);
      await inTurnWith(remote.peer, async () => {
        if (!store.remoteTopics.has(remote.name)) {
          const followed = await sendFollows(remote.peer, [remote.topic]);
          // Meanwhile the operator may have ended the pairing, and what was followed through it went with it.
          if (peers.get(remote.peer.name) !== remote.peer) throw new HttpError(404, 'peer_not_found', `this hub is not paired with a hub it calls "${remote.peer.name}"`);
          if (!followed.includes(remote.topic)) throw new HttpError(404, 'topic_not_found', `the hub "${remote.peer.name}" has no topic "${remote.topic}" that other hubs can follow`);
        }
        if (subscribed()?.has(remote.name)) return;
        withinQuota(); // again: other subscriptions of this agent may have gone through while this one waited
        if (!store.remoteTopics.has(remote.name)) store.commit({ type: 'remote.follow', name: remote.name, at: new Date().toISOString() });
        store.commit({ type: 'sub.add', did: ctx.did, topic: remote.name });
      });
    }
    ensureRelay(remote.peer);
    return { topic: remote.name, subscribed: true };
  };

  /** Stops following a topic of another hub for an agent of this one. `name` is "topic@peer". */
  const unfollowRemote = async (ctx, name) => {
    const peer = peers.get(remoteParts(name).peer);
    if (store.agentSubs.get(ctx.did)?.has(name)) {
      store.commit({ type: 'sub.remove', did: ctx.did, topic: name });
      if (store.subs.get(name).size === 0) {
        // Nobody here follows it any more, so this hub stops too. If the other hub is not told now -
        // it does not answer, or this agent has had it asked too much - it is told with the next
        // message, and what it sends of the topic until then is dropped on arrival.
        store.commit({ type: 'remote.unfollow', name });
        if (peer && limiter.take(`remote:${ctx.did}`, cfg.limits.remote)) await tellFollows(peer).catch(() => {});
      }
    }
    return { topic: name, subscribed: false };
  };

  /** Forwards what an agent of this hub publishes to a topic of another. The hub the topic lives on decides what becomes of it. */
  const publishRemote = async (ctx, remote) => {
    limited(`publish:${ctx.did}`, cfg.limits.publish);
    chargeSend(ctx.agent);
    const envelope = acceptEnvelope(ctx, Date.now());
    const { event } = envelope;
    if (event.subject !== remote.topic) throw new HttpError(400, 'invalid_event', 'subject must be the name the topic has on its own hub, without "@"');
    if (event.recipient !== undefined) throw new HttpError(400, 'invalid_event', 'topic events must not carry a recipient');
    // It says which hub's topic it is for. That is what keeps anybody from taking it to a topic of the same name somewhere else.
    if (event.hub !== remote.peer.did) throw new HttpError(400, 'invalid_event', `an event for a topic of "${remote.peer.name}" must carry hub: "${remote.peer.did}"`);
    requireScope(ctx, 'publish', remote.name);
    // The data is checked against the contract before it leaves, so that whoever publishes is told
    // what is wrong with it by its own hub. The hub the topic lives on checks it again, and decides.
    const errors = validate((await remoteTopic(remote)).schema, event.data);
    if (errors.length > 0) throw new HttpError(422, 'schema_validation_failed', 'data does not match the topic schema', { errors });
    const receipt = await peerAnswer(remote.peer, 'POST', `/v1/federation/topics/${encodeURIComponent(remote.topic)}/events`, envelope);
    return {
      status: 202,
      body: { id: event.id, topic: remote.name, ...(Number.isSafeInteger(receipt.seq) ? { seq: receipt.seq } : {}), duplicate: receipt.duplicate === true, delivered_to: count(receipt.delivered_to) },
    };
  };

  /**
   * What a hub checks of a direct message that goes to another hub or comes from one: it goes
   * over MLS, sealed to the card of its recipient or, where this hub lets it, in the clear.
   * `local` is the agent of this hub in it, `remote` the one of the hub `peer`. Over MLS, the
   * home of their conversation holds it to the group and the epoch that are current; the other
   * hub cannot.
   */
  const checkDirectBetweenHubs = async (event, { local, remote, peer }) => {
    if (event.encryption === undefined) {
      if (cfg.requireDirectEncryption) throw new HttpError(403, 'encryption_required', 'this hub only relays end-to-end encrypted direct messages');
      return;
    }
    if (event.encryption !== DIRECT_ENCRYPTION && event.encryption !== DIRECT_MLS) throw new HttpError(400, 'invalid_event', `unsupported encryption "${String(event.encryption).slice(0, 40)}"`);
    if (event.type !== ENCRYPTED_EVENT_TYPE) throw new HttpError(400, 'invalid_event', `encrypted messages must have type "${ENCRYPTED_EVENT_TYPE}"`);
    if (event.encryption === DIRECT_MLS) {
      // What the message says of itself - its group and its epoch - is returned: the hub that is not the home goes by it.
      return checkMlsMessage(event.data, isHome(local, remote) && store.dmGroups.get(acrossKey(local, remote, peer)), 'this conversation');
    }
    const problem = checkSealedShape(event.data);
    if (problem) throw new HttpError(400, 'invalid_event', problem);
  };

  /**
   * Forwards a direct message to an agent of a paired hub: the hub the message says its recipient
   * is on. That hub decides what becomes of it.
   */
  const sendRemote = async (ctx, envelope) => {
    const { event } = envelope;
    const peer = peerByDid(event.hub);
    if (!peer) throw new HttpError(404, 'peer_not_found', 'this message is for an agent of a hub that this one is not paired with');
    requireScope(ctx, 'direct_hub', peer.name);
    await checkDirectBetweenHubs(event, { local: ctx.did, remote: event.recipient, peer });
    const receipt = await peerAnswer(peer, 'POST', '/v1/federation/messages', envelope);
    return { status: 202, body: { id: event.id, recipient: event.recipient, hub: peer.did, duplicate: receipt.duplicate === true } };
  };

  // What this hub follows of a peer arrives through one stream per peer, read with this hub's key.
  const relays = new Map(); // peer name -> { controller, done }
  let closing = false;
  const pause = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  /**
   * One entry from the stream of a peer: an event of one of its topics. It is handed on to the
   * agents of this hub that follow the topic, if it is what it should be. That is checked here to
   * keep junk out of their inboxes; each of them checks it again on its own.
   */
  const relayItem = (peer, item) => {
    if (!isPlainObject(item) || item.kind !== 'topic' || typeof item.topic !== 'string') return;
    const name = remoteTopicName(item.topic, peer.name);
    if (!store.remoteTopics.has(name)) return; // not followed, or not any more
    const verdict = verifyEventEnvelope(item.envelope, { graceMs: INSTANCE_GRACE_MS });
    if (!verdict.ok) return;
    const { event, proof } = item.envelope;
    if (event.subject !== item.topic || event.hub !== peer.did || event.recipient !== undefined || event.encryption !== undefined) return;
    try {
      validateEvent(event, { ...cfg, eventTimeSkewMs: Infinity }, Date.now()); // it may have waited: its time is not held against it
    } catch {
      return;
    }
    if (store.hasSeen(event)) return;
    const recipients = [...store.subs.get(name)].filter((did) => did !== verdict.did);
    const hubNote = { received_at: new Date().toISOString(), via: peer.name, ...(Number.isSafeInteger(item.hub?.topic_seq) ? { topic_seq: item.hub.topic_seq } : {}) };
    const result = store.commit({ type: 'event.relay', topic: name, envelope: { event, proof }, recipients, hub: hubNote });
    push(result.deliveries);
  };

  /** Follows the stream of a peer for as long as this hub follows something of it. */
  const runRelay = async (peer, signal) => {
    let backoff = 500;
    let lastSeq;
    let acked;
    let ackTimer = null;
    let arriving = null; // whether the stream is open: the operator is told when that changes
    const report = (open) => {
      if (arriving === open) return;
      arriving = open;
      log(open ? `peer "${peer.name}": receiving what this hub follows of it` : `peer "${peer.name}": what this hub follows of it is not arriving; trying again`);
    };
    // Whatever has put the two hubs out of step is put right the next time this one says what it follows.
    const again = () => tellFollows(peer).catch(() => {});
    const resync = setInterval(again, cfg.peerResyncMs);
    resync.unref?.();
    const ack = async () => {
      ackTimer = null;
      if (lastSeq === undefined || lastSeq === acked) return;
      const seq = lastSeq;
      await askPeer(peer, 'POST', '/v1/federation/inbox/ack', { seq }).then(
        ({ status }) => {
          if (status === 200) acked = seq;
        },
        () => {}, // the next connection acknowledges with ?after=
      );
    };
    const wanted = () => !signal.aborted && peers.get(peer.name) === peer && followsOf(peer).length > 0;
    while (wanted()) {
      try {
        const path = lastSeq === undefined ? '/v1/federation/stream' : `/v1/federation/stream?after=${lastSeq}`;
        const headers = { accept: 'text/event-stream', ...signRequest(identity, 'GET', peer.url + path) };
        const res = await fetchPeer(peer.url + path, { headers, redirect: 'error', signal });
        if (!res.ok) throw new Error(`the hub answered ${res.status}`);
        backoff = 500;
        report(true);
        again(); // it may have forgotten, or missed what it was last told
        for await (const frame of parseSSE(chunksUntil(res.body, signal))) {
          if (frame.event !== 'message') break; // replaced or removed: start over
          let item = null;
          try {
            item = JSON.parse(frame.data);
          } catch {
            continue;
          }
          relayItem(peer, item);
          if (Number.isSafeInteger(item?.seq)) lastSeq = item.seq;
          if (ackTimer === null) {
            ackTimer = setTimeout(ack, cfg.peerAckDelayMs);
            ackTimer.unref?.();
          }
        }
      } catch {
        /* not reachable, or cut: try again after a pause */
      }
      if (!wanted()) break;
      report(false);
      await pause(backoff, signal);
      backoff = Math.min(backoff * 2, 10_000);
    }
    clearInterval(resync);
    clearTimeout(ackTimer);
  };

  /** Makes sure the stream of `peer` is being followed, if this hub follows anything of it. */
  const ensureRelay = (peer) => {
    if (closing || !peer || relays.has(peer.name) || followsOf(peer).length === 0) return;
    const controller = new AbortController();
    const entry = { controller, done: null };
    entry.done = runRelay(peer, controller.signal).finally(() => {
      if (relays.get(peer.name) === entry) relays.delete(peer.name);
    });
    relays.set(peer.name, entry);
  };

  /** Ends the pairing with a hub: what this one followed of it goes, and so does what it followed here. */
  const removePeer = (name) => {
    const peer = peers.get(name);
    if (!peer) return false;
    peers.delete(name);
    relays.get(name)?.controller.abort();
    for (const remote of [...store.remoteTopics.keys()]) {
      if (splitTopicName(remote)?.peer === name) store.commit({ type: 'remote.unfollow', name: remote });
    }
    if (store.peers.has(peer.did)) {
      cutStream(peer.did, 'removed');
      store.commit({ type: 'peer.leave', did: peer.did });
    }
    if (store.pairings.get(name)?.did === peer.did) store.commit({ type: 'pairing.drop', name });
    return true;
  };

  // What a paired hub may ask about the topics of this one, and do with them.

  const getFederatedTopic = (name) => {
    const topic = store.topics.get(name);
    if (!topic || !federated(topic)) throw new HttpError(404, 'topic_not_found', `this hub has no topic "${String(name).slice(0, 128)}" that other hubs can follow`);
    return topic;
  };

  route('GET', '/v1/federation/topics', 'peer', (ctx) => {
    const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 200);
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 10, 50);
    return { body: { topics: searchTopics(query, federated).slice(0, limit) } };
  });

  route('GET', '/v1/federation/topics/:name', 'peer', (ctx) => ({ body: topicView(getFederatedTopic(ctx.params.name)) }));

  route('GET', '/v1/federation/topics/:name/events', 'peer', (ctx) => {
    const topic = getFederatedTopic(ctx.params.name);
    const after = parseSeq(ctx.url.searchParams.get('after'), 'after') ?? 0;
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 50, 200);
    return { body: { topic: topic.name, last_seq: topic.seq, events: topic.events.filter((entry) => entry.seq > after).slice(0, limit) } };
  });

  // The paired hub says what it follows of this one: every topic, every time. It is left following
  // just that, or as much of it as can be followed, and is sent what is published there, to an
  // inbox of its own. It says it whole so that a message that was lost, or a hub that forgot, puts
  // the two out of step only until the next one.
  route(
    'PUT',
    '/v1/federation/follows',
    'peer',
    (ctx) => {
      const { topics } = ctx.json();
      if (!Array.isArray(topics) || !topics.every((name) => typeof name === 'string' && name.length <= 128 && TOPIC_NAME_RE.test(name))) {
        throw new HttpError(400, 'invalid_parameter', 'topics must be the names of the topics of this hub that the other follows');
      }
      if (topics.length > cfg.maxFollowsPerPeer) throw new HttpError(403, 'quota_exceeded', `a hub follows at most ${cfg.maxFollowsPerPeer} topics of another`);
      const { did } = ctx.peer;
      const wanted = new Set(topics.filter((name) => store.topics.has(name) && federated(store.topics.get(name))));
      if (!store.peers.has(did)) store.commit({ type: 'peer.join', did });
      const current = [...(store.agentSubs.get(did) ?? [])];
      for (const name of current) if (!wanted.has(name)) store.commit({ type: 'sub.remove', did, topic: name });
      for (const name of wanted) if (!current.includes(name)) store.commit({ type: 'sub.add', did, topic: name });
      return { body: { followed: [...wanted] } };
    },
    { maxBody: cfg.maxFollowsPerPeer * 140 + 1024 },
  );

  route('GET', '/v1/federation/stream', 'peer', (ctx) => {
    if (!store.peers.has(ctx.peer.did)) store.commit({ type: 'peer.join', did: ctx.peer.did });
    return openStream(ctx, ctx.peer.did);
  });

  route('POST', '/v1/federation/inbox/ack', 'peer', (ctx) => {
    const seq = ctx.json().seq;
    if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'invalid_parameter', 'seq must be a non-negative integer');
    if (store.peers.has(ctx.peer.did)) ackUpTo(ctx.peer.did, seq);
    return { body: { acked: seq } };
  });

  // An event that an agent of the paired hub publishes to a topic of this one. The paired hub
  // vouches for nothing: the event carries its author's signature, and the topic's rules are
  // applied to the author as this hub knows it.
  route('POST', '/v1/federation/topics/:name/events', 'peer', (ctx) => {
    const topic = getFederatedTopic(ctx.params.name);
    requireLiveTopic(topic);
    const now = Date.now();
    const body = ctx.json();
    const verdict = verifyEventEnvelope(body, { now });
    if (!verdict.ok) throw new HttpError(400, 'invalid_envelope', `envelope rejected: ${verdict.error}`);
    const { event, proof } = body;
    validateEvent(event, cfg, now);
    const author = verdict.did;
    if (store.suspended.has(`agent:${author}`)) throw new HttpError(403, 'agent_suspended', 'the operators of this hub suspended that agent');
    const known = store.agents.get(author);
    if (known?.status === 'revoked') throw new HttpError(403, 'agent_revoked', 'this agent has been revoked on this hub');
    if (event.subject !== topic.name) throw new HttpError(400, 'invalid_event', 'subject must be the topic name');
    if (event.recipient !== undefined) throw new HttpError(400, 'invalid_event', 'topic events must not carry a recipient');
    if (event.encryption !== undefined) throw new HttpError(400, 'invalid_event', 'events on public topics are not encrypted');
    // Unlike an event published here in person, one that comes through another hub has to say it was written for this one.
    if (event.hub !== identity.did) throw new HttpError(400, 'invalid_event', 'an event that comes through another hub must say it is for a topic of this one');
    checkDataschema(event, topic);
    // What this hub knows of the author. A delegation presented to another hub does not travel yet: to this one it is a bare key.
    const tier = known ? tierOf(known, now) : 'key';
    if (!policyAllows(topic.publish, { did: author, tier, owner: topic.owner })) {
      throw new HttpError(403, 'publish_not_allowed', topic.publish === 'owner' ? 'only the owner can publish to this topic' : 'this topic restricts who can publish');
    }
    const errors = validate(topic.schema, event.data);
    if (errors.length > 0) throw new HttpError(422, 'schema_validation_failed', 'data does not match the topic schema', { errors });
    if (store.hasSeen(event)) return { body: { id: event.id, topic: topic.name, duplicate: true } };
    // An author has its own allowance here, whatever hub it comes through. It is charged last, for
    // an event that is about to be taken and that only its author could have written. Charged any
    // earlier, a paired hub could use it up by sending again what the author had already published.
    limited(`publish:${author}`, cfg.limits.publish);
    const recipients = recipientsOf(topic, author, now);
    const result = store.commit({ type: 'event.publish', topic: topic.name, envelope: { event, proof }, recipients, tier, via: ctx.peer.name, at: new Date(now).toISOString() });
    push(result.deliveries);
    return { status: 202, body: { id: event.id, topic: topic.name, seq: result.seq, duplicate: false, delivered_to: result.deliveries.length } };
  });

  // The agents of this hub, for a paired hub to show to its own: the same that anybody can see here.
  route('GET', '/v1/federation/agents', 'peer', (ctx) => {
    const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 200);
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 10, 50);
    const own = searchableAgents();
    return { body: { agents: (query.trim() ? matching(query, own) : own.reverse().map(({ view }) => view)).slice(0, limit) } };
  });

  route('GET', '/v1/federation/agents/:did', 'peer', (ctx) => {
    const agent = store.agents.get(ctx.params.did);
    if (agent?.status !== 'active') throw new HttpError(404, 'agent_not_found', 'no agent is registered with that DID');
    return { body: agentView(agent) };
  });

  // A direct message that an agent of the paired hub sends to an agent of this one. As with an
  // event for a topic, the paired hub vouches for nothing: the message carries the signature of
  // its author, and says that it is for an agent of this hub.
  route('POST', '/v1/federation/messages', 'peer', async (ctx) => {
    const now = Date.now();
    const body = ctx.json();
    const verdict = verifyEventEnvelope(body, { now });
    if (!verdict.ok) throw new HttpError(400, 'invalid_envelope', `envelope rejected: ${verdict.error}`);
    const { event, proof } = body;
    validateEvent(event, cfg, now);
    const author = verdict.did;
    if (store.suspended.has(`agent:${author}`)) throw new HttpError(403, 'agent_suspended', 'the operators of this hub suspended that agent');
    const known = store.agents.get(author);
    if (known?.status === 'revoked') throw new HttpError(403, 'agent_revoked', 'this agent has been revoked on this hub');
    if (typeof event.recipient !== 'string' || !isValidDid(event.recipient)) throw new HttpError(400, 'invalid_event', 'direct messages need a "recipient" attribute holding a DID');
    if (event.recipient === author) throw new HttpError(400, 'invalid_event', 'an agent cannot message itself');
    if (event.subject !== undefined) throw new HttpError(400, 'invalid_event', 'direct messages must not carry a subject');
    if (event.hub !== identity.did) throw new HttpError(400, 'invalid_event', 'a message that comes through another hub must say it is for an agent of this one');
    requireRecipient(event.recipient);
    const seen = await checkDirectBetweenHubs(event, { local: event.recipient, remote: author, peer: ctx.peer });
    if (store.hasSeen(event)) return { body: { id: event.id, recipient: event.recipient, duplicate: true } };
    // The author's own allowance, charged last: see what is said of it where events for topics come in.
    limited(`direct:${author}`, cfg.limits.direct);
    // Over MLS, where the hub it comes from is the home of the conversation: whoever opens it may
    // need the commits that renewed the keys up to its epoch, and they are there. They are asked
    // for now, while that hub is at hand, and the message is taken only once they are here: what
    // waits in an inbox never waits for another hub. (`seen`: what the message says of itself,
    // which is all there is to go by where this hub does not keep the conversation.)
    if (seen) {
      const parties = { local: event.recipient, remote: author, peer: ctx.peer };
      const key = acrossKey(parties.local, parties.remote, parties.peer);
      const short = () => (copied(key, event.data.group)?.epoch ?? 1) < seen.epoch;
      if (short()) {
        limited(`mls:${ctx.peer.did}:${event.recipient}`, cfg.limits.mls);
        await copyCommits(parties, event.data.group, seen.epoch).catch((err) => {
          if (err.code === 'quota_exceeded') throw err;
        });
        if (short()) throw new HttpError(409, 'commits_unavailable', 'the commits that renewed the keys of that group up to the epoch of this message were not to be had from the hub it comes from');
      }
    }
    if (blocks(event.recipient, author)) return { status: 202, body: { id: event.id, recipient: event.recipient, duplicate: false } };
    const result = store.commit({ type: 'dm.send', envelope: { event, proof }, tier: known ? tierOf(known, now) : 'key', via: ctx.peer.name, at: new Date(now).toISOString() });
    push(result.deliveries);
    return { status: 202, body: { id: event.id, recipient: event.recipient, duplicate: false } };
  });

  // --- inbox ------------------------------------------------------------------

  /** Opens the stream of `reader`'s inbox on this request: what is waiting first, then what arrives. */
  const openStream = (ctx, reader, onClose = () => {}) => {
    const after = parseSeq(ctx.url.searchParams.get('after'), 'after');
    if (after !== undefined) ackUpTo(reader, after);

    // One live stream per reader: a second connection with the same key takes over. Different
    // instances of an agent are different readers, and each keeps its own stream.
    cutStream(reader, 'replaced');
    const { res } = ctx;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const item of store.pending(reader)) writeItem(res, item); // backlog first, then live pushes
    streams.set(reader, res);
    // `res` (not `req`) signals the end of the connection: `req` closes as soon as the request is read.
    res.on('close', () => {
      if (streams.get(reader) === res) streams.delete(reader);
      onClose();
    });
    return undefined; // the response stays open
  };

  route('GET', '/v1/stream', 'registered', (ctx) => openStream(ctx, ctx.reader, () => lastSeen.set(ctx.did, Date.now())));

  route('GET', '/v1/inbox', 'registered', (ctx) => {
    const after = parseSeq(ctx.url.searchParams.get('after'), 'after');
    const limit = parseLimit(ctx.url.searchParams.get('limit'), 50, 200);
    if (after !== undefined) ackUpTo(ctx.reader, after);
    const pending = store.pending(ctx.reader);
    return { body: { items: pending.slice(0, limit), pending: pending.length, dropped: store.inboxes.get(ctx.reader).dropped } };
  });

  route('POST', '/v1/inbox/ack', 'registered', (ctx) => {
    const seq = ctx.json().seq;
    if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'invalid_parameter', 'seq must be a non-negative integer');
    ackUpTo(ctx.reader, seq);
    return { body: { acked: seq, pending: store.pending(ctx.reader).length } };
  });

  // --------------------------------------------------------------- dispatching

  function matchRoute(method, pathname) {
    const parts = pathname.split('/').slice(1);
    let pathMatched = false;
    for (const candidate of routes) {
      if (candidate.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const expected = candidate.parts[i];
        if (expected.startsWith(':')) {
          try {
            params[expected.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
          }
          if (ok && params[expected.slice(1)] === '') ok = false;
        } else if (expected !== parts[i]) {
          ok = false;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (candidate.method === method) return { route: candidate, params };
    }
    throw pathMatched
      ? new HttpError(405, 'method_not_allowed', `${method} is not supported on this path`)
      : new HttpError(404, 'not_found', 'no such endpoint');
  }

  function authenticate(ctx, level) {
    const header = (name) => {
      const value = ctx.req.headers[name];
      return typeof value === 'string' ? value : '';
    };
    const did = header(HEADERS.DID);
    const timestamp = header(HEADERS.TIMESTAMP);
    const nonce = header(HEADERS.NONCE);
    const signature = header(HEADERS.SIGNATURE);
    const origin = header(HEADERS.ORIGIN);
    const deny = (code, message, extra) => new HttpError(401, code, message, extra);

    if (!did || !timestamp || !nonce || !signature) throw deny('unauthenticated', 'this endpoint requires a signed request');
    // A client from before requests were signed for one hub: what it signs could be replayed on another.
    if (!origin) throw deny('unbound_request', `this hub takes only requests signed for its address (${REQUEST_SIGNATURE}): update the client`);
    if (!isValidDid(did) || !TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce)) throw deny('unauthenticated', 'malformed authentication headers');
    const now = Date.now();
    if (Math.abs(now - Number(timestamp)) > cfg.clockSkewMs) {
      throw deny('timestamp_out_of_range', 'request timestamp is too far from the hub clock', { server_time: new Date(now).toISOString() });
    }
    const valid = verifyRequest({ did, method: ctx.req.method, origin, path: ctx.req.url, timestamp, nonce, signature, body: ctx.body });
    if (!valid) throw deny('invalid_signature', 'request signature does not verify');
    // Signed by whoever it says, for another address: replayed by a hub it was sent to, or sent here by mistake.
    if (!ownOrigins().has(origin)) throw deny('wrong_hub', 'this request was signed for another address', { origins: [...ownOrigins()] });
    const replayKey = `${did}|${nonce}`;
    if (nonces.has(replayKey)) throw deny('replayed_request', 'this request was already processed');

    ctx.signer = did; // the key that signed the request: the agent's own, or one of its instances
    if (level === 'peer') {
      // Another hub. It is answered only if the operator of this one paired them: there is no registering as a peer.
      const peer = peerByDid(did);
      if (!peer) throw new HttpError(403, 'not_a_peer', 'this hub is not paired with whoever signed the request');
      nonces.set(replayKey, now + 2 * cfg.clockSkewMs);
      limited(`federation:${did}`, cfg.limits.federation);
      ctx.peer = peer;
      return;
    }
    if (level === 'signed') {
      // Enough for an instance presenting its certificate: who it acts for is what the handler works out.
      nonces.set(replayKey, now + 2 * cfg.clockSkewMs);
      return;
    }

    // The signer is the agent itself, or an instance acting as its agent.
    let agent = store.agents.get(did) ?? null;
    let instance = null;
    if (!agent) {
      instance = store.instances.get(did) ?? null;
      if (instance) {
        // Checked on every request, like a delegation: an expired certificate carries no authority.
        if (Date.parse(instance.certificate.expires_at) <= now) {
          throw new HttpError(403, 'instance_expired', 'the certificate of this instance has expired; ask the agent for a new one', { expired_at: instance.certificate.expires_at });
        }
        agent = store.agents.get(instance.agent);
      } else if (store.removedInstances.has(did)) {
        throw new HttpError(403, 'instance_removed', 'this instance was removed by its agent');
      }
    }
    if (level === 'registered' && !agent) throw new HttpError(403, 'not_registered', 'register this agent first (POST /v1/agents)');
    // Checked on every request: a revoked agent is locked out from its very next call.
    if (agent?.status === 'revoked') throw new HttpError(403, 'agent_revoked', 'this agent has been revoked', { revoked_at: agent.revoked.at, revoked_by: agent.revoked.by });
    nonces.set(replayKey, now + 2 * cfg.clockSkewMs);
    if (agent) lastSeen.set(agent.did, now);
    ctx.did = agent?.did ?? did;
    ctx.instance = instance ? did : null;
    ctx.reader = did; // whose inbox and stream this request reads
    ctx.agent = agent;
    ctx.tier = agent ? tierOf(agent, now) : null;
    if (agent && store.suspended.has(`agent:${agent.did}`)) throw new HttpError(403, 'agent_suspended', 'the operators of this hub suspended this agent');
  }

  /** Behind `trustProxy` reverse proxies, the client is that many entries from the end of X-Forwarded-For. */
  function clientIp(req) {
    if (cfg.trustProxy > 0) {
      const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
      const candidate = chain[chain.length - cfg.trustProxy];
      if (candidate && isIP(candidate)) return candidate;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  async function handle(req, res) {
    const ip = clientIp(req);
    limited(`ip:${ip}`, cfg.limits.ip);
    let url;
    try {
      url = new URL(req.url, 'http://hub.invalid');
    } catch {
      throw new HttpError(400, 'bad_request', 'malformed URL');
    }
    const { route: matched, params } = matchRoute(req.method, url.pathname);
    const body = await readBody(req, matched.maxBody ?? cfg.maxBodyBytes);
    let parsed;
    const ctx = { req, res, url, params, ip, body, signer: null, did: null, instance: null, reader: null, agent: null, tier: null, json: () => (parsed ??= parseJsonObject(body)) };
    if (matched.auth === 'optional') {
      if (req.headers[HEADERS.DID] !== undefined) authenticate(ctx, 'key');
    } else if (matched.auth) {
      authenticate(ctx, matched.auth);
    }
    const result = await matched.handler(ctx);
    if (result?.text !== undefined) sendText(res, result.status ?? 200, result.text);
    else if (result !== undefined) sendJson(res, result.status ?? 200, result.body, result.headers);
  }

  const startedAt = Date.now();
  const answered = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  /** How things stand, in counts: what the metrics say (metrics.mjs). */
  const standing = () => {
    const agents = { active: 0, revoked: 0 };
    for (const agent of store.agents.values()) agents[agent.status] = (agents[agent.status] ?? 0) + 1;
    const pairings = {};
    for (const peer of peers.values()) pairings[peer.state] = (pairings[peer.state] ?? 0) + 1;
    let inboxEntries = 0;
    for (const inbox of store.inboxes.values()) inboxEntries += inbox.items.length;
    return {
      agents,
      instances: store.instances.size,
      topics: store.topics.size,
      inboxEntries,
      streams: streams.size,
      peers: pairings,
      logEntries: store.log.length,
      suspended: store.suspended.size,
      reports: store.reports.length,
      requests: answered,
      operations: store.opCount,
      uptime: Math.round((Date.now() - startedAt) / 1000),
    };
  };
  const metrics = cfg.metricsPort === null ? null : metricsServer(standing);

  const onRequest = (req, res) => {
    res.once('finish', () => {
      const status = `${String(res.statusCode)[0]}xx`;
      if (Object.hasOwn(answered, status)) answered[status] += 1;
    });
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      // What the store turned away before writing anything down is said to whoever sent it.
      const failure = err instanceof NotRecordable ? tooDeep() : err;
      if (failure instanceof HttpError) {
        const headers = failure.status === 413 ? { connection: 'close' } : {};
        sendJson(res, failure.status, { error: { code: failure.code, message: failure.message, ...failure.extra } }, headers);
      } else {
        console.error('[hub] unexpected error', err);
        sendJson(res, 500, { error: { code: 'internal_error', message: 'unexpected error' } });
      }
    });
  };
  const server = cfg.tls ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key }, onRequest) : http.createServer(onRequest);

  const heartbeat = setInterval(() => {
    for (const res of streams.values()) res.write(': keep-alive\n\n');
  }, cfg.heartbeatMs);
  const janitor = setInterval(() => {
    const now = Date.now();
    for (const [key, expiry] of nonces) if (expiry < now) nonces.delete(key);
    for (const [challenge, expiry] of challenges) if (expiry < now) challenges.delete(challenge);
    limiter.sweep();
  }, 30_000);
  heartbeat.unref();
  janitor.unref();

  const hub = {
    store,
    config: cfg,
    /** The DID of this hub: what the operator of another needs, with its address, to pair with it. */
    did: identity.did,
    /** Pairs this hub with another: { name, url, did }. The other only answers once its operator has done the same. */
    addPeer: (given) => {
      const peer = addPeer(given);
      ensureRelay(peers.get(peer.name)); // if this hub was following something of it before, it picks that up again
      return peer;
    },
    removePeer,
    checkPairing,
    witnessNow,
    get url() {
      return publicUrl;
    },
    get port() {
      return server.address()?.port ?? null;
    },
    get metricsPort() {
      return metrics?.address()?.port ?? null;
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, resolve);
      });
      if (metrics) {
        // On this machine only, unless the operator says where: what is scraped from here is for them.
        await new Promise((resolve, reject) => {
          metrics.once('error', reject);
          metrics.listen(cfg.metricsPort, cfg.metricsHost, resolve);
        });
        if (!LOOPBACK.includes(cfg.metricsHost)) log(`metrics on ${cfg.metricsHost}:${metrics.address().port}, reachable from other machines: they are counts and name nobody, but they are for the operator. Keep that port closed to everybody else.`);
      }
      const loopback = LOOPBACK.includes(cfg.host);
      publicUrl ??= `${cfg.tls ? 'https' : 'http'}://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${server.address().port}`;
      log(`listening on ${publicUrl} (data: ${cfg.dataDir ?? 'memory only'}, pow: ${cfg.powDifficulty} bits, tls: ${cfg.tls ? 'yes' : 'no'})`);
      if (!loopback && !cfg.tls && cfg.trustProxy === 0) {
        log('WARNING: reachable from other machines over plain HTTP. Serve TLS (tls option) or put a TLS-terminating proxy in front (trustProxy option).');
      }
      log(`this hub is ${identity.did}: with its address, that is what the operator of another hub needs to pair with it`);
      if (witnesses.length > 0) {
        // The first round now, without holding up the start for it, and one every so often after.
        const round = () => witnessNow().catch((err) => log(`the witnesses could not be asked: ${printed(err.message)}`));
        round();
        witnessTimer = setInterval(round, cfg.witnessIntervalMs);
        witnessTimer.unref?.();
        log(`the log is shown to ${witnesses.length} witness${witnesses.length === 1 ? '' : 'es'}: ${witnesses.map((witness) => witness.verifier.name).join(', ')}`);
      }
      const unpaired = new Set([...store.remoteTopics.keys()].map((name) => splitTopicName(name).peer).filter((name) => !peers.has(name)));
      for (const name of unpaired) log(`agents of this hub follow topics of "${name}", a hub it is not paired with now: nothing arrives from there until it is`);
      // Whether each pairing stands is told to the operator, without holding up the start for it.
      for (const peer of peers.values()) {
        ensureRelay(peer); // what this hub followed of it before stopping, it follows again
        checkPairing(peer.name).then(
          ({ state, detail }) => log(`peer "${peer.name}" (${peer.url}): ${state}${detail ? ` - ${detail}` : ''}`),
          () => {},
        );
      }
      return hub;
    },
    async close() {
      closing = true;
      const following = [...relays.values()];
      for (const { controller } of following) controller.abort();
      await Promise.all(following.map(({ done }) => done));
      clearInterval(heartbeat);
      clearInterval(janitor);
      clearInterval(witnessTimer);
      for (const res of streams.values()) res.end();
      streams.clear();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      if (metrics?.listening) await new Promise((resolve) => metrics.close(() => resolve()));
      store.close();
    },
  };
  return hub;
}
