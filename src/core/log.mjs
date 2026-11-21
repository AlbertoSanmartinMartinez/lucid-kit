// SPDX-License-Identifier: Apache-2.0
// The transparency log: a hub's public record of every change to its directory.
//
// Who is registered and with what card, who answers for whom, who has been revoked, which
// instances an agent has, who owns each topic and under what contract: every change is an entry,
// the entries are a list that only grows, and the hub signs what that list is - how many entries
// and the root of the Merkle tree over them (a checkpoint). What a hub shows of its directory at
// any moment can then be held against what it has put on record for everybody.
//
// What the log gives, and what it does not:
//   - Whoever reads it from the first entry knows the directory without taking the hub's word for
//     any one answer, and knows that the entries follow from each other: `Directory` applies to
//     each the rules below, and refuses a log that breaks them.
//   - An entry that carries something signed by whoever made the change cannot be made up by the
//     hub: a card, a delegation, a revocation, the certificate of an instance and, from the entry
//     "log.signed" on, the statement (statement.mjs) of the agent that retired, dropped its
//     delegation, removed an instance, or created a topic or changed who may use it. Before that
//     entry - in a log that was started without statements, or from data older than the log -
//     those are the hub's word for what an agent asked of it.
//   - What is still the hub's word: when each thing happened, that a delegation signed in the
//     name of a domain was that domain's, and, in a log that was not signed from its first entry,
//     everything before "log.signed".
//   - A hub can still keep two logs and show each to different readers. Nothing here catches
//     that: it takes readers, or other hubs, comparing the checkpoints they were given.
//   - Whoever has not read it can still be shown what it says of one agent or one topic. The
//     directory is also a map that one hash tells (statemap.mjs), the hub puts that hash on
//     record ("log.state"), and `verifyStateAnswer` checks one name of the map against it. That
//     tells what the log says, not that the log holds: only reading it does.

import { createHash } from 'node:crypto';
import { canonicalize, fitsCanonicalDepth } from './jcs.mjs';
import { isValidDid } from './didkey.mjs';
import { CONTEXT, createProof, isPlainObject, verifyProof } from './proof.mjs';
import { verifyCardEnvelope } from './sign.mjs';
import { verifyDelegation, verifyRevocation } from './delegation.mjs';
import { verifyInstanceCertificate } from './instance.mjs';
import { verifyStatement } from './statement.mjs';
import { verifyAttestation } from './attestation.mjs';
import { TOPIC_NAME_RE } from './topicname.mjs';
import { Frontier, leafHash, verifyInclusion } from './merkle.mjs';
import { StateMap, verifyState } from './statemap.mjs';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const isTime = (value) => typeof value === 'string' && RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value));
const hasExactKeys = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const hashOf = (value) => createHash('sha256').update(canonicalize(value)).digest('hex');

/**
 * A log that does not hold - an entry that does not follow from the ones before, a root that is
 * not the list's, a list that changed (`code` "log_invalid") - or a hub that shows something its
 * log does not say ("log_mismatch").
 */
export class LogError extends Error {
  constructor(message, code = 'log_invalid') {
    super(message);
    this.name = 'LogError';
    this.code = code;
  }
}

// ------------------------------------------------------------------------------ entries

/** What the log keeps of the contract of a topic: a hash of its name, description and schema. */
export const contractHash = ({ name, description, schema }) => hashOf({ name, description, schema });

/** What a reader of the log keeps of a card, to tell whether the one it is shown is the one on record. */
export const cardHash = (card) => hashOf(card);

/** And of a delegation. */
export const delegationHash = (envelope) => hashOf(envelope);

/**
 * The leaf of the tree for an entry: the hash of its canonical JSON. One that has no canonical
 * form - nested deeper than that takes - is not an entry of any log: a LogError.
 */
export function entryLeaf(entry) {
  let canonical;
  try {
    canonical = canonicalize(entry);
  } catch {
    throw new LogError('an entry of the log cannot be hashed: it is nested too deeply');
  }
  return leafHash(Buffer.from(canonical, 'utf8'));
}

// ------------------------------------------------------------------------------ checkpoints

/** The hub's statement of what its log is: so many entries, with this root. */
export function signCheckpoint(identity, { size, root, at = new Date().toISOString() }) {
  const checkpoint = { hub: identity.did, size, root: root.toString('hex'), at };
  return { checkpoint, proof: createProof(CONTEXT.LOG_CHECKPOINT, checkpoint, identity) };
}

/**
 * Checks a checkpoint: its shape and the signature of the hub it names - `hub`, if the caller
 * knows which hub it should be. Returns { ok: true, hub, size, root, at } with the root as bytes,
 * or { ok: false, error }.
 */
export function verifyCheckpoint(envelope, { hub } = {}) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.checkpoint)) return { ok: false, error: 'a checkpoint is { checkpoint, proof }' };
  const { checkpoint, proof } = envelope;
  if (!hasExactKeys(checkpoint, ['hub', 'size', 'root', 'at'])) return { ok: false, error: 'checkpoint has missing or unexpected fields' };
  if (!isValidDid(checkpoint.hub)) return { ok: false, error: 'checkpoint.hub must be the DID of the hub' };
  if (hub !== undefined && checkpoint.hub !== hub) return { ok: false, error: 'the checkpoint is of another hub' };
  if (!Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0) return { ok: false, error: 'checkpoint.size must be a count' };
  if (typeof checkpoint.root !== 'string' || !HASH_RE.test(checkpoint.root)) return { ok: false, error: 'checkpoint.root must be a SHA-256 hash in hex' };
  if (!isTime(checkpoint.at)) return { ok: false, error: 'checkpoint.at must be a UTC RFC 3339 timestamp' };
  const verdict = verifyProof(CONTEXT.LOG_CHECKPOINT, checkpoint, proof);
  if (!verdict.ok) return { ok: false, error: `checkpoint signature rejected: ${verdict.error}` };
  if (verdict.did !== checkpoint.hub) return { ok: false, error: 'the checkpoint is not signed by the hub it names' };
  return { ok: true, hub: checkpoint.hub, size: checkpoint.size, root: Buffer.from(checkpoint.root, 'hex'), at: checkpoint.at };
}

// ------------------------------------------------------------------------------ what the log says

const FIELDS = {
  'agent.card': ['did', 'card', 'proof'],
  'agent.delegation': ['did', 'envelope', 'kind'],
  'agent.revoke': ['did', 'by', 'reason', 'revocation'],
  'delegation.revoke': ['issuer', 'delegation_id', 'revocation'],
  'instance.add': ['agent', 'instance', 'certificate', 'proof'],
  'instance.remove': ['agent', 'instance', 'by'],
  'topic.create': ['name', 'owner', 'contract', 'publish', 'subscribe', 'encryption'],
  'topic.policy': ['name', 'publish', 'subscribe'],
  'controller.attest': ['controller', 'account', 'attestation'],
  'agent.guardian': ['did', 'guardian'],
  'agent.succeed': ['did', 'successor', 'acceptance'],
  'log.signed': [],
  'log.state': ['state'],
};

/** The kinds of entry a log holds. */
export const LOG_ENTRY_TYPES = Object.keys(FIELDS);

/**
 * The entries that, once the log says "log.signed", also carry a `statement`: the one of the
 * agent that made the change, or null where the change comes signed some other way - a delegation
 * that is presented, an agent that its controller revokes.
 */
export const STATED_ENTRY_TYPES = new Set(['agent.delegation', 'agent.revoke', 'instance.remove', 'topic.create', 'topic.policy', 'agent.guardian', 'agent.succeed']);

// The directory as a map that one hash tells (statemap.mjs): the name each thing goes under, and
// the record kept there, whose hash - of its canonical JSON - is the value of the map. A record
// says all the directory has for that name, each field always there:
//   agent:<did>                  { card, status, delegation, revoked, guardian, successor, predecessor }
//   instance:<did>               { agent, expires_at, removed }
//   topic:<name>                 { owner, contract, publish, subscribe, encryption, revision }
//   account:<controller did>     { account, verifier, issued_at, expires_at }
//   delegation:<issuer>|<id>     { revoked: true } - one that can no longer be presented
// A name that is not there is one the directory has nothing for.
export const stateName = {
  agent: (did) => `agent:${did}`,
  instance: (did) => `instance:${did}`,
  topic: (name) => `topic:${name}`,
  account: (controller) => `account:${controller}`,
  delegation: (issuer, id) => `delegation:${issuer}|${id}`,
};
const stateRecord = {
  agent: (agent) => ({ card: agent.card, status: agent.status, delegation: agent.delegation ?? null, revoked: agent.revoked ?? null, guardian: agent.guardian ?? null, successor: agent.successor ?? null, predecessor: agent.predecessor ?? null }),
  instance: ({ agent, expires_at, removed }) => ({ agent, expires_at, removed }),
  topic: ({ owner, contract, publish, subscribe, encryption, revision }) => ({ owner, contract, publish, subscribe, encryption, revision: revision ?? 0 }),
  account: ({ account, verifier, issued_at, expires_at }) => ({ account, verifier, issued_at, expires_at }),
};
const HELD = { agent: 'agents', instance: 'instances', topic: 'topics', account: 'accounts' }; // where the directory holds each kind
const REVOKED = { revoked: true };

/**
 * The directory as the log tells it: the result of taking its entries one by one, each checked
 * against the ones before. `apply` throws a LogError for an entry that does not hold, and the
 * directory is then left as it was.
 *
 * The rules are the ones an honest hub keeps whatever its settings: who signed what, and what
 * can follow what. Its quotas and limits are not checked here.
 */
export class Directory {
  hub; // the DID of the hub whose log this is: the statements in it are made for that hub
  size = 0; // entries taken so far
  signedFrom = null; // the entry from which every change carries the statement of whoever made it; null while the log has not said so
  agents = new Map(); // did -> { card, status, delegation, revoked, guardian, successor, predecessor }: `card` is cardHash of its card on record; the last three are absent until said
  instances = new Map(); // instance did -> { agent, expires_at, removed }
  topics = new Map(); // name -> { owner, contract, publish, subscribe, encryption, revision }: `revision` counts the changes its owner has signed for
  accounts = new Map(); // controller did -> { account, verifier, issued_at, expires_at }: the last attestation that it is a verified account
  revokedDelegations = new Set(); // "<issuer>|<id>": delegations that can no longer be presented - revoked by their issuer, or dropped by their agent
  // All of the above as a map that one hash tells (statemap.mjs): under the name of each agent,
  // instance, topic, account and revoked delegation, the hash of what this directory has for it.
  // It is what a "log.state" entry of the log gives the root of, and what whoever has not read the
  // log is given proofs from. It is worked out from the rest: it is never put away with it.
  #state = new StateMap();

  constructor({ hub = null } = {}) {
    this.hub = hub;
  }

  /** The root of the directory as a map, in hex: what the log says its state is, where it says so. */
  get stateRoot() {
    return this.#state.root.toString('hex');
  }

  /** The directory as it is now, to prove from later: { root, prove(name) } (statemap.mjs), where what is kept with each value is the record, as canonical JSON. */
  stateView() {
    return this.#state.view();
  }

  /** What the directory has under one name goes into the map as it is now: every rule says so of whatever it changed. */
  #said(name, record) {
    const text = canonicalize(record);
    this.#state.set(name, createHash('sha256').update(text).digest(), text);
  }
  #saidOf(kind, key) {
    this.#said(stateName[kind](key), stateRecord[kind](this[HELD[kind]].get(key)));
  }
  #revoked(issuer, id) {
    this.revokedDelegations.add(`${issuer}|${id}`);
    this.#said(stateName.delegation(issuer, id), REVOKED);
  }

  /** Whether `reader` reads for `agent`, as far as the log tells: the agent's own key, or an instance of its that has not been removed. */
  isReader(agent, reader) {
    if (this.agents.get(agent)?.status !== 'active') return false;
    if (reader === agent) return true;
    const instance = this.instances.get(reader);
    return Boolean(instance) && instance.agent === agent && !instance.removed;
  }

  /** The directory as something to put away, and to take up again with `Directory.fromJSON`. Whose log it is, is not part of it. */
  toJSON() {
    return structuredClone({ size: this.size, signed_from: this.signedFrom, agents: [...this.agents], instances: [...this.instances], topics: [...this.topics], accounts: [...this.accounts], revoked_delegations: [...this.revokedDelegations] });
  }

  /** `saved` becomes the directory's own: what `toJSON` gives is a copy, and is fit for it. `hub` is the hub whose log it was read from. */
  static fromJSON(saved, { hub = null } = {}) {
    const directory = new Directory({ hub });
    directory.size = saved.size;
    directory.signedFrom = saved.signed_from ?? null; // one put away before logs said so had not been told
    directory.agents = new Map(saved.agents);
    directory.instances = new Map(saved.instances);
    directory.topics = new Map(saved.topics.map(([name, topic]) => [name, { revision: 0, ...topic }])); // one put away before topics had revisions
    directory.accounts = new Map(saved.accounts ?? []); // one put away before attestations were on record had none
    directory.revokedDelegations = new Set(saved.revoked_delegations);
    for (const [name, record] of directoryState(directory)) directory.#said(name, record);
    return directory;
  }

  /** Takes the next entry of the log. */
  async apply(entry) {
    const fail = (why) => {
      throw new LogError(`entry ${this.size} of the log does not hold: ${why}`);
    };
    if (!isPlainObject(entry) || entry.n !== this.size) fail('it is not the entry that comes next');
    // What cannot be written down canonically cannot be hashed, compared or checked: it is no entry of a log.
    if (!fitsCanonicalDepth(entry)) fail('it is nested too deeply');
    if (typeof entry.type !== 'string' || !Object.hasOwn(FIELDS, entry.type)) fail('it is not a kind of entry this reader knows');
    const fields = this.signedFrom !== null && STATED_ENTRY_TYPES.has(entry.type) ? [...FIELDS[entry.type], 'statement'] : FIELDS[entry.type];
    if (!hasExactKeys(entry, ['n', 'at', 'type', ...fields])) fail(`it has missing or unexpected fields for "${entry.type}"`);
    if (entry.at !== null && !isTime(entry.at)) fail('its time is not a UTC RFC 3339 timestamp');
    await this.#rules[entry.type](entry, fail);
    this.size += 1;
  }

  #active(did, fail) {
    const agent = this.agents.get(did);
    if (!agent) fail('it is about an agent that is not registered');
    if (agent.status !== 'active') fail('it is about an agent that has been revoked');
    return agent;
  }

  /**
   * The statement an entry carries: it has to say `says`, for the hub this log is of. Returns the
   * key that signed it. Whether that key may say it is for each rule to tell.
   */
  #stated(kind, entry, says, fail) {
    const verdict = verifyStatement(kind, entry.statement, { hub: this.hub, says });
    if (!verdict.ok) fail(`the statement it carries does not hold: ${verdict.error}`);
    return verdict.signer;
  }

  #rules = {
    'log.signed': (entry, fail) => {
      // Said once, and for good: there is no going back to the hub's word.
      if (this.signedFrom !== null) fail('the log had already said that its changes are signed');
      this.signedFrom = entry.n;
    },

    // The hub says what the directory comes to at this point, as the root of its map. It changes
    // nothing; it is there for whoever has not read the log, who is shown one name of the map and
    // can tell that it belongs under this root. Every reader that did read the log works the
    // root out and refuses a log that gives another.
    'log.state': (entry, fail) => {
      if (entry.state !== this.stateRoot) fail('the state it gives is not that of the directory at this point');
    },

    'agent.card': (entry, fail) => {
      const verdict = verifyCardEnvelope({ card: entry.card, proof: entry.proof });
      if (!verdict.ok || verdict.did !== entry.did) fail('the card does not carry the signature of its agent');
      const known = this.agents.get(entry.did);
      if (known && known.status !== 'active') fail('a revoked agent does not change its card');
      if (this.instances.has(entry.did)) fail('the key of an instance is not an agent');
      this.agents.set(entry.did, { status: 'active', delegation: null, revoked: null, ...known, card: cardHash(entry.card) });
      this.#saidOf('agent', entry.did);
    },

    'agent.delegation': async (entry, fail) => {
      const agent = this.#active(entry.did, fail);
      const signed = this.signedFrom !== null;
      if (entry.envelope === null) {
        if (entry.kind !== null) fail('a delegation that is dropped has no kind');
        if (signed) {
          // The agent says which one it drops, with its own key. That one is then gone for good, so
          // that what it signed cannot be used on it a second time.
          const held = agent.delegation;
          if (held === null) fail('it drops the delegation of an agent that holds none');
          const signer = this.#stated('delegation.drop', entry, { agent: entry.did, issuer: held.issuer, delegation_id: held.id }, fail);
          if (signer !== entry.did) fail('a delegation is dropped by the agent that holds it, with its own key');
          this.#revoked(held.issuer, held.id);
        }
        agent.delegation = null;
        this.#saidOf('agent', entry.did);
        return;
      }
      if (signed && entry.statement !== null) fail('a delegation that is presented comes with no statement: its issuer signed it');
      // Checked as of when it was presented: a delegation that has since run out was good then.
      // How far ahead of its own clock a hub lets one be dated is for the hub to say, not for this.
      const verdict = await verifyDelegation(entry.envelope, { now: entry.at === null ? undefined : Date.parse(entry.at), clockSkewMs: Infinity });
      if (!verdict.ok && !verdict.unresolved) fail(`the delegation does not verify: ${verdict.error}`);
      // One signed in the name of a domain can only be checked against what that domain publishes now. It is taken on the hub's word.
      if (verdict.ok ? entry.kind !== verdict.kind : entry.kind !== 'web') fail('the delegation is not of the kind the entry says');
      const { delegation } = entry.envelope;
      if (delegation.subject !== entry.did) fail('the delegation was issued to another agent');
      if (this.revokedDelegations.has(`${delegation.issuer}|${delegation.id}`)) fail('the delegation had been revoked, or dropped');
      agent.delegation = { issuer: delegation.issuer, id: delegation.id, kind: entry.kind, hash: delegationHash(entry.envelope), expires_at: delegation.expires_at };
      this.#saidOf('agent', entry.did);
    },

    'agent.revoke': async (entry, fail) => {
      const agent = this.#active(entry.did, fail);
      if (entry.reason !== null && (typeof entry.reason !== 'string' || entry.reason.length > 200)) fail('the reason is not a short text');
      const signed = this.signedFrom !== null;
      if (entry.revocation === null) {
        if (entry.by !== entry.did) fail('without a revocation of its controller, an agent is retired only by itself');
        // Before the log is signed, the hub's word: the agent asked for it with a signed request.
        if (signed && this.#stated('retire', entry, { agent: entry.did }, fail) !== entry.did) fail('an agent retires with its own key');
      } else {
        if (signed && entry.statement !== null) fail('an agent that its controller revokes makes no statement');
        const verdict = await verifyRevocation(entry.revocation);
        if (!verdict.ok && !verdict.unresolved) fail(`the revocation does not verify: ${verdict.error}`);
        const { revocation } = entry.revocation;
        if (revocation.subject !== entry.did || revocation.issuer !== entry.by) fail('the revocation is of another agent, or by another controller');
        if (agent.delegation?.issuer !== revocation.issuer || agent.delegation?.id !== revocation.delegation_id) fail('the revocation is not of the delegation the agent holds');
        this.#revoked(revocation.issuer, revocation.delegation_id);
      }
      agent.status = 'revoked';
      agent.revoked = { by: entry.by, at: entry.at };
      this.#saidOf('agent', entry.did);
    },

    'delegation.revoke': async (entry, fail) => {
      if (typeof entry.issuer !== 'string' || typeof entry.delegation_id !== 'string') fail('it does not say which delegation');
      if (entry.revocation !== null) {
        const verdict = await verifyRevocation(entry.revocation);
        if (!verdict.ok && !verdict.unresolved) fail(`the revocation does not verify: ${verdict.error}`);
        const { revocation } = entry.revocation;
        if (revocation.issuer !== entry.issuer || revocation.delegation_id !== entry.delegation_id) fail('the revocation is of another delegation');
      }
      this.#revoked(entry.issuer, entry.delegation_id);
    },

    // An agent says who may hand it over to a successor: a key kept apart, or that of its controller.
    // Said once, with its own key, and for good. Whoever takes the key of the agent afterwards cannot
    // name another, and so cannot hand the agent over to itself.
    'agent.guardian': (entry, fail) => {
      if (this.signedFrom === null) fail('a guardian is named only in a log whose changes are signed');
      const agent = this.#active(entry.did, fail);
      if (agent.guardian) fail('the agent had already named its guardian');
      if (!isValidDid(entry.guardian) || entry.guardian === entry.did) fail('a guardian is a key, and another than the agent\'s own');
      if (this.#stated('agent.guardian', entry, { agent: entry.did, guardian: entry.guardian }, fail) !== entry.did) fail('an agent names its guardian with its own key');
      agent.guardian = entry.guardian;
      this.#saidOf('agent', entry.did);
    },

    // An agent is handed over to another: from here on, whoever knew the first is to deal with the
    // second. Signed by the guardian the agent named, or by the agent itself if it named none, and by
    // the successor, which takes it. It happens once to an agent, and no agent succeeds two. The first
    // is left as an agent that was retired, if it was not one already, and what it owned is the second's.
    'agent.succeed': (entry, fail) => {
      if (this.signedFrom === null) fail('an agent is handed over only in a log whose changes are signed');
      const agent = this.agents.get(entry.did);
      if (!agent) fail('it is about an agent that is not registered');
      if (agent.successor) fail('the agent had already been handed over');
      // The key of an agent that was retired may be anybody's by now: that is often why it was. Only a guardian named before hands it over.
      if (agent.status !== 'active' && !agent.guardian) fail('an agent that was retired and had named no guardian is not handed over');
      const successor = this.agents.get(entry.successor);
      if (!successor || successor.status !== 'active' || entry.successor === entry.did) fail('the successor is another agent, registered and not revoked');
      if (successor.predecessor) fail('the successor had already taken over from another agent');
      const says = { agent: entry.did, successor: entry.successor };
      const authority = agent.guardian ?? entry.did;
      if (this.#stated('agent.succeed', entry, says, fail) !== authority) fail(agent.guardian ? 'an agent that named a guardian is handed over by it' : 'an agent that named no guardian is handed over with its own key');
      const taken = verifyStatement('succession.accept', entry.acceptance, { hub: this.hub, says });
      if (!taken.ok || taken.signer !== entry.successor) fail('the successor did not sign that it takes over');
      if (agent.status === 'active') {
        agent.status = 'revoked';
        agent.revoked = { by: authority, at: entry.at };
      }
      agent.successor = entry.successor;
      successor.predecessor = entry.did;
      this.#saidOf('agent', entry.did);
      this.#saidOf('agent', entry.successor);
      for (const [name, topic] of this.topics) {
        if (topic.owner !== entry.did) continue;
        topic.owner = entry.successor;
        this.#saidOf('topic', name);
      }
    },

    // A verifier vouched that a controller is an account. Who signed it can be checked here; whether that
    // verifier is to be trusted is up to whoever reads. It was put on record while it was in force.
    'controller.attest': (entry, fail) => {
      const verdict = verifyAttestation(entry.attestation);
      if (!verdict.ok) fail(`the attestation does not verify: ${verdict.error}`);
      if (verdict.controller !== entry.controller || verdict.account !== entry.account) fail('the attestation is of another controller or account');
      if (entry.at === null || Date.parse(entry.at) > Date.parse(verdict.expires_at)) fail('it was put on record after the attestation ran out');
      const previous = this.accounts.get(entry.controller);
      if (previous && Date.parse(previous.issued_at) >= Date.parse(verdict.issued_at)) fail('an attestation is put on record only if it is newer than the last one of its controller');
      this.accounts.set(entry.controller, { account: entry.account, verifier: verdict.verifier, issued_at: verdict.issued_at, expires_at: verdict.expires_at });
      this.#saidOf('account', entry.controller);
    },

    'instance.add': (entry, fail) => {
      this.#active(entry.agent, fail);
      const known = this.instances.get(entry.instance);
      if (known?.removed) fail('an instance that was removed does not come back');
      if (known && known.agent !== entry.agent) fail('the instance belongs to another agent');
      if (this.agents.has(entry.instance)) fail('the key of an agent is not an instance');
      const at = entry.at === null ? undefined : Date.parse(entry.at);
      const verdict = verifyInstanceCertificate({ certificate: entry.certificate, proof: entry.proof }, { agent: entry.agent, instance: entry.instance, at, now: at, clockSkewMs: Infinity });
      if (!verdict.ok) fail(`the certificate of the instance does not verify: ${verdict.error}`);
      this.instances.set(entry.instance, { agent: entry.agent, expires_at: entry.certificate.expires_at, removed: false });
      this.#saidOf('instance', entry.instance);
    },

    'instance.remove': (entry, fail) => {
      const known = this.instances.get(entry.instance);
      if (!known || known.removed) fail('it removes an instance that is not there');
      if (known.agent !== entry.agent) fail('the instance belongs to another agent');
      // Who asked: the agent, or the instance itself. Before the log is signed, that is the hub's word.
      if (entry.by !== entry.agent && entry.by !== entry.instance) fail('an instance is removed by its agent or by itself');
      if (this.signedFrom !== null && this.#stated('instance.remove', entry, { agent: entry.agent, instance: entry.instance }, fail) !== entry.by) {
        fail('the statement is not signed by whoever the entry says removed the instance');
      }
      known.removed = true;
      this.#saidOf('instance', entry.instance);
    },

    'topic.create': (entry, fail) => {
      if (typeof entry.name !== 'string' || entry.name.length > 128 || !TOPIC_NAME_RE.test(entry.name)) fail('it does not name a topic');
      if (this.topics.has(entry.name)) fail('the topic already exists');
      this.#active(entry.owner, fail);
      if (typeof entry.contract !== 'string' || !HASH_RE.test(entry.contract)) fail('the contract is not a hash');
      if (entry.encryption !== null && typeof entry.encryption !== 'string') fail('it does not say how the topic is encrypted');
      const { name, owner, contract, publish, subscribe, encryption } = entry;
      // Its owner says what the topic is, with its own key or that of one of its instances. Before the log is signed, the hub's word.
      if (this.signedFrom !== null && !this.isReader(owner, this.#stated('topic.create', entry, { topic: name, owner, contract, publish, subscribe, encryption }, fail))) {
        fail('the statement is not signed by the owner of the topic, or by an instance of its');
      }
      this.topics.set(name, { owner, contract, publish, subscribe, encryption, revision: 0 });
      this.#saidOf('topic', name);
    },

    'topic.policy': (entry, fail) => {
      const topic = this.topics.get(entry.name);
      if (!topic) fail('it changes a topic that does not exist');
      const { publish, subscribe } = entry;
      if (this.signedFrom !== null) {
        // Its owner says what changes, of the topic with this contract, and it is the next change
        // of that topic: one from before cannot be put back. Before the log is signed, the hub's word.
        const revision = topic.revision + 1;
        const says = { topic: entry.name, owner: topic.owner, contract: topic.contract, encryption: topic.encryption, publish, subscribe, revision };
        if (!this.isReader(topic.owner, this.#stated('topic.policy', entry, says, fail))) fail('the statement is not signed by the owner of the topic, or by an instance of its');
        topic.revision = revision;
      }
      // Null: its owner left that one as it was.
      if (publish !== null) topic.publish = publish;
      if (subscribe !== null) topic.subscribe = subscribe;
      this.#saidOf('topic', entry.name);
    },
  };
}

/** Every name of the directory as a map, with the record it has under each: [name, record] pairs. What its map is made from, from nothing. */
export function directoryState(directory) {
  return [
    ...Object.keys(HELD).flatMap((kind) => [...directory[HELD[kind]]].map(([key, held]) => [stateName[kind](key), stateRecord[kind](held)])),
    ...[...directory.revokedDelegations].map((key) => [`delegation:${key}`, REVOKED]),
  ];
}

/**
 * Checks what a hub answers about one name of its directory (GET /v1/log/state) against a
 * checkpoint of its log that the caller has reason to believe: `size` and `root`, signed by the
 * hub and, for whoever asks for them, cosigned by witnesses. The answer has to carry the last
 * entry of the log at that size, which has to be the one where the hub says the state of its
 * directory, and what the directory has under `name` - or that it has nothing - as that state
 * tells it. Returns { record, at }: the record as the log has it, null for nothing, and the time
 * the hub gave that entry. Throws a LogError for an answer that shows no such thing.
 *
 * What it tells: that the log of that checkpoint says this of the name. Not that the log holds:
 * that every entry before follows from the ones before it is for whoever reads them all, and a
 * hub that put a state on record that is not that of its directory has every such reader refuse
 * its log from there on.
 */
export function verifyStateAnswer(answer, { name, size, root }) {
  const fail = (why) => {
    throw new LogError(`what the hub answers about the state of its directory does not hold: ${why}`);
  };
  if (!isPlainObject(answer) || !Number.isSafeInteger(size) || size < 1) fail('there is nothing to check it against');
  const { entry, inclusion, record, proof } = answer;
  if (!isPlainObject(entry) || !hasExactKeys(entry, ['n', 'at', 'type', 'state']) || entry.type !== 'log.state' || entry.n !== size - 1) fail('it does not carry the entry where the log says its state at that size');
  if (typeof entry.state !== 'string' || !HASH_RE.test(entry.state)) fail('the state it gives is not a hash');
  const hashes = Array.isArray(inclusion) && inclusion.every((hash) => typeof hash === 'string' && HASH_RE.test(hash)) ? inclusion.map((hash) => Buffer.from(hash, 'hex')) : null;
  let leaf;
  try {
    leaf = entryLeaf(entry);
  } catch {
    fail('its entry cannot be hashed');
  }
  if (hashes === null || !verifyInclusion({ index: size - 1, size, leaf, proof: hashes, root })) fail('its entry is not the last of the log at that size');
  if (record !== null && !isPlainObject(record)) fail('what it gives for the name is not a record');
  let value = null;
  try {
    if (record !== null) value = createHash('sha256').update(canonicalize(record)).digest();
  } catch {
    fail('what it gives for the name cannot be hashed');
  }
  if (!verifyState(Buffer.from(entry.state, 'hex'), name, value, proof)) fail(record === null ? 'it does not show that the directory has nothing under that name' : 'it does not show that the directory has that under the name');
  return { record, at: entry.at };
}

/**
 * Reads `entries` as the log of the hub `hub` from its first entry and returns what they come to:
 * the directory they tell, and the size and root of the tree over them. Throws a LogError at the
 * first entry that does not hold.
 */
export async function replayLog(entries, { hub = null } = {}) {
  const directory = new Directory({ hub });
  const frontier = new Frontier();
  for (const entry of entries) {
    await directory.apply(entry);
    frontier.append(entryLeaf(entry));
  }
  return { directory, size: frontier.size, root: frontier.root() };
}
