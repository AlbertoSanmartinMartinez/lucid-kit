// SPDX-License-Identifier: AGPL-3.0-only
// Hub state.
//
// Everything lives in memory and every mutation is first appended to a
// write-ahead journal (journal.jsonl). On startup the last snapshot is loaded
// and the journal replayed, so a restart loses nothing that was acknowledged.
// Each operation carries a sequence number; the snapshot records the last one
// it contains, which makes replay idempotent even after a crash mid-compaction.
//
// Delivery model: fan-out on write. Publishing appends one entry to the inbox
// of every subscriber; each inbox has its own sequence and is pruned when its
// reader acknowledges. That gives at-least-once delivery and offline catch-up
// without one broker consumer per agent.
//
// An agent is read by its own key and by each of its instances. Every one of
// those readers has an inbox of its own, so each sees every message once and
// none can acknowledge on behalf of another.

import fs from 'node:fs';
import path from 'node:path';
import { MerkleTree } from '../core/merkle.mjs';
import { contractHash, entryLeaf, STATED_ENTRY_TYPES } from '../core/log.mjs';
import { fitsCanonicalDepth } from '../core/jcs.mjs';
import { parseDmGroupId } from '../mls/dm.mjs';
import { parseTopicGroupId } from '../mls/topic.mjs';

export function seenKey(event) {
  return `${event.source}|${event.id}`;
}

/** An operation that cannot be put on record, and so is not carried out at all. */
export class NotRecordable extends Error {}

// What goes on record is hashed in its canonical form, which takes JSON only so deep. These carry
// a signed event, which may be as deep as its own signature allows and leaves nothing on record.
const CARRIES_AN_EVENT = new Set(['event.publish', 'event.relay', 'dm.send']);

/** Which conversation, or which topic, a group is of, by its name; null for a name that says neither. */
const conversationOf = (group) => {
  const pair = parseDmGroupId(group)?.pair.join('|');
  if (pair) return `dm ${pair}`;
  const topic = parseTopicGroupId(group)?.topic;
  return topic ? `topic ${topic}` : null;
};

export class Store {
  constructor({ dataDir = null, topicRetention = 200, inboxCap = 1000, seenCap = 50_000, compactEvery = 5000 } = {}) {
    this.dataDir = dataDir;
    this.topicRetention = topicRetention;
    this.inboxCap = inboxCap;
    this.seenCap = seenCap;
    this.compactEvery = compactEvery;

    this.agents = new Map(); // did -> { did, card, proof, registered_at, updated_at, status, delegation, revoked }
    this.topics = new Map(); // name -> { name, description, schema, publish, subscribe, encryption, epoch, grants, owner, created_at, seq, events[] }
    this.subs = new Map(); // topic name -> Set<did>
    this.agentSubs = new Map(); // did -> Set<topic name>
    this.instances = new Map(); // instance did -> { did, agent, certificate, proof, registered_at }
    this.agentInstances = new Map(); // agent did -> Set<instance did>
    this.removedInstances = new Set(); // instance DIDs removed for good: they can never come back
    this.inboxes = new Map(); // reader did (an agent, or one of its instances) -> { next, dropped, items[] }
    // MLS. The hub relays all of it without being able to open any of it.
    this.keyPackages = new Map(); // reader did -> [KeyPackage, ...] oldest first; published so the reader can be added to groups while away
    this.dmGroups = new Map(); // "<lower did>|<higher did>" -> { group, generation, members[], previous, earlier[], created_by, created_at }
    this.mlsLogs = new Map(); // group id -> { epoch, commits: [{ epoch, message }] }: the commit that ended each epoch, in order
    this.mlsCopies = new Map(); // conversation kept by another hub -> [{ group, epoch, commits }]: what that hub gave of the commits of its last groups
    // Federation. A paired hub that follows topics of this one reads them from an inbox, like an agent.
    this.peers = new Set(); // DIDs of the hubs that have an inbox here
    // Abuse. What agents block, what they report, and what the operators of this hub suspended.
    this.blocks = new Map(); // agent did -> Set of the DIDs it takes nothing from
    this.reports = []; // [{ id, by, target, reason, note, at }], the newest last
    this.suspended = new Map(); // "agent:<did>" or "topic:<name>" -> { by, reason, at }
    this.pairings = new Map(); // name -> { name, url, did, at }: hubs that paired themselves with this one (open pairing), kept across restarts
    this.remoteTopics = new Map(); // "topic@peer" -> { name, followed_at }: topics of other hubs that agents of this one follow
    // The transparency log: every change to the directory, in order, for anybody to read (core/log.mjs).
    this.log = []; // its entries
    this.logTree = new MerkleTree(); // and the tree over them, which the hub signs the root of
    this.recording = true; // false only while loading data that was written before there was a log
    this.logSignedFrom = null; // the entry at which the log said that, from there on, every change carries the statement of whoever made it
    this.welcomes = new Map(); // reader did -> [{ group, welcome }]: invitations it has not picked up yet
    this.seen = new Set(); // "<source>|<id>" of accepted events, for deduplication
    this.revocations = []; // public log: { seq, did, at, by, reason, revocation }
    this.revokedDelegations = new Set(); // "<issuer>|<delegation id>" withdrawn by their issuer
    this.attestations = new Map(); // controller did -> { account, verifier, issued_at, expires_at, envelope }: `account` is a reference; the newest that a trusted verifier signed

    this.opCount = 0;
    this.journalOps = 0;
    this.fd = null;
  }

  // ---------------------------------------------------------------- persistence

  load() {
    if (!this.dataDir) return this;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const snapshotPath = path.join(this.dataDir, 'snapshot.json');
    const journalPath = path.join(this.dataDir, 'journal.jsonl');

    if (fs.existsSync(snapshotPath)) this.#restore(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')));

    let replayed = 0;
    if (fs.existsSync(journalPath)) {
      for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
        if (!line) continue;
        let op;
        try {
          op = JSON.parse(line);
        } catch {
          break; // a torn final line from a crash mid-write: nothing after it was acknowledged
        }
        if (op.n <= this.opCount) continue; // already contained in the snapshot
        // What comes next has to be the operation after the last one there is. One that is not means
        // operations went missing - a journal and a snapshot from different moments, as a careless
        // backup leaves - and going on would build a state that never was.
        if (op.n !== this.opCount + 1) throw new Error(`the journal in ${this.dataDir} does not follow on from its snapshot: operation ${this.opCount + 1} is missing`);
        this.#apply(op);
        this.opCount = op.n;
        replayed++;
      }
    }
    this.fd = fs.openSync(journalPath, 'a');
    const unrecorded = !this.recording;
    if (unrecorded) this.#recordDirectory();
    if (replayed > 0 || unrecorded) this.compact();
    return this;
  }

  /**
   * Journals the operation, then applies it. Returns whatever the operation produces.
   *
   * An operation that could not be applied whole must not get as far as the journal: it would be
   * there for good, failing again each time the hub starts. Anything that came from outside and
   * is nested too deeply to be put on record is turned away here, whatever let it through.
   */
  commit(op) {
    if (!CARRIES_AN_EVENT.has(op.type) && !fitsCanonicalDepth(op)) throw new NotRecordable('nested too deeply to be put on record');
    const record = { n: this.opCount + 1, ...op };
    if (this.fd !== null) fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    this.opCount = record.n;
    const result = this.#apply(record);
    if (this.fd !== null && ++this.journalOps >= this.compactEvery) this.compact();
    return result;
  }

  compact() {
    if (this.fd === null) return;
    const snapshotPath = path.join(this.dataDir, 'snapshot.json');
    fs.writeFileSync(snapshotPath + '.tmp', JSON.stringify(this.#serialize()));
    fs.renameSync(snapshotPath + '.tmp', snapshotPath);
    fs.ftruncateSync(this.fd, 0);
    this.journalOps = 0;
  }

  close() {
    if (this.fd === null) return;
    this.compact();
    fs.closeSync(this.fd);
    this.fd = null;
  }

  #serialize() {
    return {
      version: 1,
      last_op: this.opCount,
      agents: [...this.agents.values()],
      topics: [...this.topics.values()],
      subs: [...this.subs].map(([topic, dids]) => [topic, [...dids]]),
      instances: [...this.instances.values()],
      removed_instances: [...this.removedInstances],
      inboxes: [...this.inboxes],
      key_packages: [...this.keyPackages],
      dm_groups: [...this.dmGroups],
      mls_logs: [...this.mlsLogs],
      mls_copies: [...this.mlsCopies],
      peers: [...this.peers],
      pairings: [...this.pairings.values()],
      blocks: [...this.blocks].map(([agent, blocked]) => [agent, [...blocked]]),
      reports: this.reports,
      suspended: [...this.suspended],
      remote_topics: [...this.remoteTopics.values()],
      welcomes: [...this.welcomes],
      seen: [...this.seen],
      revocations: this.revocations,
      revoked_delegations: [...this.revokedDelegations],
      attestations: [...this.attestations],
      log: this.log,
    };
  }

  #restore(snapshot) {
    if (snapshot.version !== 1) throw new Error(`unsupported snapshot version ${snapshot.version}`);
    this.opCount = snapshot.last_op;
    // Snapshots written by 0.1 lack the fields added since; give them their defaults.
    for (const agent of snapshot.agents) this.agents.set(agent.did, { status: 'active', delegation: null, revoked: null, ...agent });
    for (const topic of snapshot.topics) this.topics.set(topic.name, { subscribe: 'any', encryption: null, epoch: 0, grants: {}, mls: null, revision: 0, ...topic });
    this.revocations = snapshot.revocations ?? [];
    this.revokedDelegations = new Set(snapshot.revoked_delegations ?? []);
    this.attestations = new Map(snapshot.attestations ?? []);
    for (const [topic, dids] of snapshot.subs) {
      this.subs.set(topic, new Set(dids));
      for (const did of dids) this.#subsOf(did).add(topic);
    }
    for (const instance of snapshot.instances ?? []) {
      this.instances.set(instance.did, instance);
      this.#instancesOf(instance.agent).add(instance.did);
    }
    this.removedInstances = new Set(snapshot.removed_instances ?? []);
    for (const [did, inbox] of snapshot.inboxes) this.inboxes.set(did, inbox);
    this.keyPackages = new Map(snapshot.key_packages ?? []);
    this.dmGroups = new Map(snapshot.dm_groups ?? []);
    this.mlsLogs = new Map(snapshot.mls_logs ?? []);
    this.mlsCopies = new Map(snapshot.mls_copies ?? []);
    this.peers = new Set(snapshot.peers ?? []);
    this.pairings = new Map((snapshot.pairings ?? []).map((pairing) => [pairing.name, pairing]));
    this.blocks = new Map((snapshot.blocks ?? []).map(([agent, blocked]) => [agent, new Set(blocked)]));
    this.reports = snapshot.reports ?? [];
    this.suspended = new Map(snapshot.suspended ?? []);
    for (const remote of snapshot.remote_topics ?? []) {
      this.remoteTopics.set(remote.name, remote);
      if (!this.subs.has(remote.name)) this.subs.set(remote.name, new Set());
    }
    this.welcomes = new Map(snapshot.welcomes ?? []);
    this.seen = new Set(snapshot.seen);
    if (snapshot.log) {
      for (const entry of snapshot.log) this.#append(entry);
    } else {
      // Written before there was a log, and so was whatever its journal adds. Nothing is put on
      // record while that is loaded: the directory goes on record whole, once it is all here.
      this.recording = false;
    }
  }

  // ------------------------------------------------------------- transparency log

  #append(entry) {
    const leaf = entryLeaf(entry); // first: the list and the tree over it never get out of step
    this.log.push(entry);
    this.logTree.append(leaf);
    if (entry.type === 'log.signed') this.logSignedFrom = entry.n;
  }

  /**
   * Puts a change to the directory on record: the next entry of the log. Once the log is signed,
   * a change that an agent makes goes with its `statement`, and one that comes signed some other
   * way says that it has none.
   */
  #record(type, at, fields, statement = null) {
    if (!this.recording) return;
    const stated = this.logSignedFrom !== null && STATED_ENTRY_TYPES.has(type);
    this.#append({ n: this.log.length, at: at ?? null, type, ...fields, ...(stated ? { statement } : {}) });
  }

  /**
   * Puts on record a directory that was built before there was a log: each agent with the card it
   * has now, its instances, the delegation it holds, each topic, each revocation. What it does
   * not tell is what came before: earlier cards, instances that were removed. Nobody signed a
   * statement for any of it: it goes in before the log says that it is signed.
   */
  #recordDirectory() {
    this.recording = true;
    const latest = (...times) => times.filter(Boolean).sort().at(-1) ?? null;
    for (const agent of this.agents.values()) this.#record('agent.card', agent.updated_at, { did: agent.did, card: agent.card, proof: agent.proof });
    for (const instance of this.instances.values()) {
      // A certificate that was renewed is younger than its instance: the entry is dated when both were there.
      const at = latest(instance.registered_at, instance.certificate.issued_at);
      this.#record('instance.add', at, { agent: instance.agent, instance: instance.did, certificate: instance.certificate, proof: instance.proof });
    }
    for (const agent of this.agents.values()) {
      if (agent.delegation) this.#record('agent.delegation', agent.delegation.attached_at, { did: agent.did, envelope: agent.delegation.envelope, kind: agent.delegation.kind });
    }
    for (const topic of this.topics.values()) {
      this.#record('topic.create', topic.created_at, { name: topic.name, owner: topic.owner, contract: contractHash(topic), publish: topic.publish, subscribe: topic.subscribe, encryption: topic.encryption ?? null });
    }
    const revoked = new Set();
    for (const agent of this.agents.values()) {
      if (agent.status !== 'revoked') continue;
      const revocation = this.revocations.find((entry) => entry.did === agent.did)?.revocation ?? null;
      if (revocation) revoked.add(`${revocation.revocation.issuer}|${revocation.revocation.delegation_id}`);
      this.#record('agent.revoke', agent.revoked.at, { did: agent.did, by: agent.revoked.by, reason: agent.revoked.reason ?? null, revocation });
    }
    for (const key of this.revokedDelegations) {
      if (revoked.has(key)) continue;
      const cut = key.lastIndexOf('|');
      this.#record('delegation.revoke', null, { issuer: key.slice(0, cut), delegation_id: key.slice(cut + 1), revocation: null });
    }
  }

  /** What the log is now: how many entries, and the root of the tree over them. */
  logHead() {
    return { size: this.log.length, root: this.logTree.root() };
  }

  // ------------------------------------------------------------------- queries

  hasSeen(event) {
    return this.seen.has(seenKey(event));
  }

  pending(did) {
    return this.inboxes.get(did)?.items ?? [];
  }

  subscriptionsOf(did) {
    return [...(this.agentSubs.get(did) ?? [])];
  }

  topicsOwnedBy(did) {
    let count = 0;
    for (const topic of this.topics.values()) if (topic.owner === did) count++;
    return count;
  }

  #subsOf(did) {
    let set = this.agentSubs.get(did);
    if (!set) this.agentSubs.set(did, (set = new Set()));
    return set;
  }

  #instancesOf(agent) {
    let set = this.agentInstances.get(agent);
    if (!set) this.agentInstances.set(agent, (set = new Set()));
    return set;
  }

  /** The instances registered for an agent, oldest first. */
  instancesOf(agent) {
    return [...(this.agentInstances.get(agent) ?? [])].map((did) => this.instances.get(did));
  }

  /** Everyone that reads an agent's messages: the agent key itself, then each of its instances. */
  readersOf(agent) {
    return [agent, ...(this.agentInstances.get(agent) ?? [])];
  }

  /** The active agent a reader reads for - itself, or the agent of that instance - or null if it reads for none. */
  agentOf(reader) {
    const did = this.instances.get(reader)?.agent ?? reader;
    return this.agents.get(did)?.status === 'active' ? did : null;
  }

  /**
   * Retires an agent for good: it stops receiving, and what it sent that nobody has read yet is
   * dropped. Returns { seq, purged }: its place in the list of revocations, and how much was dropped.
   */
  #retire(op) {
    // The identity is retired for good: it stops receiving, and what it sent but nobody has read yet is dropped.
    const agent = this.agents.get(op.did);
    agent.status = 'revoked';
    agent.revoked = { at: op.at, by: op.by, reason: op.reason ?? null };
    for (const topic of this.#subsOf(op.did)) this.subs.get(topic).delete(op.did);
    this.agentSubs.delete(op.did);
    for (const reader of this.readersOf(op.did)) {
      this.inboxes.get(reader).items = [];
      this.#forgetMls(reader);
    }
    // It stops being a member of private topics. It may still hold their current keys: owners
    // should rotate. Over MLS that happens on its own: the owner leaves its readers out of the
    // group the next time it does anything in the topic.
    for (const topic of this.topics.values()) {
      delete topic.grants[topic.epoch]?.[op.did];
      if (topic.mls?.agents.includes(op.did)) {
        const gone = this.readersOf(op.did);
        topic.mls = { ...topic.mls, agents: topic.mls.agents.filter((did) => did !== op.did), members: topic.mls.members.filter((reader) => !gone.includes(reader)) };
      }
    }
    let purged = 0;
    for (const inbox of this.inboxes.values()) {
      const kept = inbox.items.filter((item) => item.envelope.event.source !== op.did);
      purged += inbox.items.length - kept.length;
      inbox.items = kept;
    }
    if (op.revocation) this.#rememberRevokedDelegation(op.revocation.revocation);
    const seq = (this.revocations.at(-1)?.seq ?? 0) + 1;
    this.revocations.push({ seq, did: op.did, at: op.at, by: op.by, reason: op.reason ?? null, revocation: op.revocation ?? null });
    if (this.revocations.length > 100_000) this.revocations.shift();
    return { seq, purged };
  }

  // ---------------------------------------------------------------- operations

  #apply(op) {
    switch (op.type) {
      case 'agent.put': {
        const previous = this.agents.get(op.did);
        this.agents.set(op.did, {
          did: op.did,
          card: op.card,
          proof: op.proof,
          registered_at: previous?.registered_at ?? op.at,
          updated_at: op.at,
          status: previous?.status ?? 'active',
          delegation: previous?.delegation ?? null,
          revoked: previous?.revoked ?? null,
          // Who guards it and whom it took over from are not said in a card, and a new card does not unsay them.
          ...(previous?.guardian ? { guardian: previous.guardian } : {}),
          ...(previous?.predecessor ? { predecessor: previous.predecessor } : {}),
        });
        if (!this.inboxes.has(op.did)) this.inboxes.set(op.did, { next: 1, dropped: 0, items: [] });
        this.#record('agent.card', op.at, { did: op.did, card: op.card, proof: op.proof });
        return {};
      }
      case 'agent.delegation': {
        // kind: "key" (signed by a did:key controller) or "web" (signed by a key of a resolved did:web document)
        this.agents.get(op.did).delegation = op.envelope ? { envelope: op.envelope, kind: op.kind, attached_at: op.at } : null;
        // One that its agent drops with a statement is gone for good, like one its issuer revokes.
        if (!op.envelope && op.statement) this.#rememberRevokedDelegation(op.statement.statement);
        this.#record('agent.delegation', op.at, { did: op.did, envelope: op.envelope ?? null, kind: op.envelope ? op.kind : null }, op.statement);
        return {};
      }
      case 'agent.revoke': {
        const result = this.#retire(op);
        this.#record('agent.revoke', op.at, { did: op.did, by: op.by, reason: op.reason ?? null, revocation: op.revocation ?? null }, op.statement);
        return result;
      }
      case 'agent.guardian': {
        // Who may hand this agent over to a successor from now on: said once (core/log.mjs).
        this.agents.get(op.did).guardian = op.guardian;
        this.#record('agent.guardian', op.at, { did: op.did, guardian: op.guardian }, op.statement);
        return {};
      }
      case 'agent.succeed': {
        // The agent is handed over to its successor. If it was still in use it is retired like any
        // other; what it owned becomes the successor's, and whoever had blocked it has blocked the
        // successor too: nobody gets out of a block by handing itself over.
        const agent = this.agents.get(op.did);
        const result = agent.status === 'active' ? this.#retire({ did: op.did, at: op.at, by: op.by, reason: 'handed over to a successor' }) : { purged: 0 };
        agent.successor = op.successor;
        this.agents.get(op.successor).predecessor = op.did;
        for (const topic of this.topics.values()) if (topic.owner === op.did) topic.owner = op.successor;
        for (const blocked of this.blocks.values()) if (blocked.has(op.did)) blocked.add(op.successor);
        const own = this.blocks.get(op.did);
        if (own) this.blocks.set(op.successor, new Set([...(this.blocks.get(op.successor) ?? []), ...own]));
        this.#record('agent.succeed', op.at, { did: op.did, successor: op.successor, acceptance: op.acceptance }, op.statement);
        return result;
      }
      case 'controller.attest': {
        // A verifier the operator trusts vouched that this controller is an account: see core/attestation.mjs.
        const { controller, account, verifier, issued_at: issuedAt, expires_at: expiresAt } = op.envelope.attestation;
        this.attestations.set(controller, { account, verifier, issued_at: issuedAt, expires_at: expiresAt, envelope: op.envelope });
        this.#record('controller.attest', op.at, { controller, account, attestation: op.envelope });
        return {};
      }
      case 'delegation.revoke': {
        this.#rememberRevokedDelegation(op);
        this.#record('delegation.revoke', op.at, { issuer: op.issuer, delegation_id: op.delegation_id, revocation: op.revocation ?? null });
        return {};
      }
      case 'instance.put': {
        // Also how a certificate is renewed: same instance, a newer certificate.
        const previous = this.instances.get(op.did);
        this.instances.set(op.did, { did: op.did, agent: op.agent, certificate: op.certificate, proof: op.proof, registered_at: previous?.registered_at ?? op.at });
        this.#instancesOf(op.agent).add(op.did);
        // A new instance starts with an empty inbox: it does not get what was sent before it existed.
        if (!this.inboxes.has(op.did)) this.inboxes.set(op.did, { next: 1, dropped: 0, items: [] });
        this.#record('instance.add', op.at, { agent: op.agent, instance: op.did, certificate: op.certificate, proof: op.proof });
        return {};
      }
      case 'instance.remove': {
        const instance = this.instances.get(op.did);
        this.#record('instance.remove', op.at, { agent: instance.agent, instance: op.did, by: op.by }, op.statement);
        this.instances.delete(op.did);
        this.agentInstances.get(instance.agent)?.delete(op.did);
        this.inboxes.delete(op.did);
        this.#forgetMls(op.did);
        this.removedInstances.add(op.did); // none is ever forgotten: the log holds that it does not come back
        return {};
      }
      case 'topic.create': {
        this.topics.set(op.name, {
          name: op.name,
          description: op.description,
          schema: op.schema,
          publish: op.publish,
          subscribe: op.subscribe ?? 'any',
          encryption: op.encryption ?? null, // for private topics: "mls-v1", or "group-v1" with a key the owner hands out
          epoch: 0, // group-v1: generation of the topic key; 0 = the owner has not distributed one yet
          grants: {}, // group-v1: epoch -> { member did -> grant signed by the owner }. Sealed: the hub cannot open them.
          mls: null, // mls-v1: { group, generation, agents[], members[], earlier[] } once the owner has made the group
          revision: 0, // how many changes its owner has signed for
          owner: op.owner,
          created_at: op.at,
          seq: 0,
          events: [],
        });
        this.subs.set(op.name, new Set());
        this.#record('topic.create', op.at, { name: op.name, owner: op.owner, contract: contractHash(op), publish: op.publish, subscribe: op.subscribe ?? 'any', encryption: op.encryption ?? null }, op.statement);
        return {};
      }
      case 'topic.keys': {
        const topic = this.topics.get(op.name);
        topic.epoch = op.epoch;
        topic.grants[op.epoch] = { ...(topic.grants[op.epoch] ?? {}), ...op.grants };
        const epochs = Object.keys(topic.grants).map(Number).sort((a, b) => a - b);
        while (epochs.length > 20) delete topic.grants[epochs.shift()]; // older epochs outlive the retained history anyway
        this.#unsubscribe(op.name, op.removed);
        return {};
      }
      case 'topic.policy': {
        const topic = this.topics.get(op.name);
        topic.publish = op.publish;
        topic.subscribe = op.subscribe;
        this.#unsubscribe(op.name, op.removed);
        // What goes on record is what its owner said changes: null for what it left as it was.
        // One made before owners signed for their changes says how both were left.
        const said = op.statement?.statement;
        if (said) topic.revision = said.revision;
        this.#record('topic.policy', op.at, { name: op.name, publish: said ? said.publish : op.publish, subscribe: said ? said.subscribe : op.subscribe }, op.statement);
        return {};
      }
      case 'log.signed': {
        // From here on the hub does not speak for its agents: what one of them changes goes on record with its statement.
        this.#record('log.signed', op.at, {});
        return {};
      }
      case 'log.state': {
        // What the directory comes to at this point, as the root of its map (core/log.mjs): the hub
        // worked it out from its own log before asking for this, and every reader will again.
        this.#record('log.state', op.at, { state: op.state });
        return {};
      }
      case 'sub.add': {
        this.subs.get(op.topic).add(op.did);
        this.#subsOf(op.did).add(op.topic);
        return {};
      }
      case 'sub.remove': {
        this.subs.get(op.topic).delete(op.did);
        this.#subsOf(op.did).delete(op.topic);
        return {};
      }
      case 'event.publish': {
        const topic = this.topics.get(op.topic);
        this.#remember(op.envelope.event);
        topic.seq += 1;
        // `via`: the paired hub it came through, by the name this hub gives it, if it was not published here in person.
        const hub = { tier: op.tier, received_at: op.at, topic_seq: topic.seq, ...(op.via ? { via: op.via } : {}) };
        // What was said over MLS is not kept as history: the keys that open it are used once, so
        // nobody could read it later, not even who already has.
        if (!topic.mls) {
          topic.events.push({ seq: topic.seq, envelope: op.envelope, hub });
          if (topic.events.length > this.topicRetention) topic.events.shift();
        }
        // The hub decides who receives (policy, tier) before committing and records the decision,
        // so replaying the journal reproduces it exactly. Journals from 0.1 carry no list: all subscribers.
        const recipients = op.recipients ?? [...this.subs.get(op.topic)].filter((did) => did !== op.envelope.event.source);
        // `readers`, when given, are the only readers that get it: those in the MLS group of the topic.
        const deliveries = recipients.map((did) => this.#enqueue(did, { kind: 'topic', topic: op.topic, envelope: op.envelope, hub }, op.readers));
        return { seq: topic.seq, deliveries };
      }
      case 'peer.join': {
        // A paired hub starts following topics of this one: it gets an inbox to read them from.
        this.peers.add(op.did);
        if (!this.inboxes.has(op.did)) this.inboxes.set(op.did, { next: 1, dropped: 0, items: [] });
        return {};
      }
      case 'block.put': {
        const blocked = this.blocks.get(op.agent) ?? new Set();
        blocked.add(op.blocked);
        this.blocks.set(op.agent, blocked);
        return {};
      }
      case 'block.drop':
        this.blocks.get(op.agent)?.delete(op.blocked);
        if (this.blocks.get(op.agent)?.size === 0) this.blocks.delete(op.agent);
        return {};
      case 'report.put':
        this.reports.push(op.report);
        if (this.reports.length > op.keep) this.reports.splice(0, this.reports.length - op.keep); // the oldest go
        return {};
      case 'moderation.put':
        this.suspended.set(op.target, { by: op.by, reason: op.reason, at: op.at });
        return {};
      case 'moderation.drop':
        this.suspended.delete(op.target);
        return {};
      case 'pairing.put':
        this.pairings.set(op.name, { name: op.name, url: op.url, did: op.did, at: op.at });
        return {};
      case 'pairing.drop':
        this.pairings.delete(op.name);
        return {};
      case 'peer.leave': {
        for (const topic of this.#subsOf(op.did)) this.subs.get(topic)?.delete(op.did);
        this.agentSubs.delete(op.did);
        // The inbox goes with the hub, unless that key is also a reader of this one: a hub does not
        // let that happen any more, but a state from before may hold one, and what is sent to a
        // reader has to find its inbox.
        if (!this.agents.has(op.did) && !this.instances.has(op.did)) this.inboxes.delete(op.did);
        this.peers.delete(op.did);
        return {};
      }
      case 'remote.follow': {
        // The first agent of this hub subscribes to a topic of another: from now on this hub follows it.
        this.remoteTopics.set(op.name, { name: op.name, followed_at: op.at });
        this.subs.set(op.name, new Set());
        return {};
      }
      case 'remote.unfollow': {
        for (const did of this.subs.get(op.name) ?? []) this.#subsOf(did).delete(op.name);
        this.subs.delete(op.name);
        this.remoteTopics.delete(op.name);
        return {};
      }
      case 'event.relay': {
        // An event of a topic of another hub, handed on to the agents of this one that follow it.
        // Nothing is kept as history: that belongs to the hub the topic lives on.
        this.#remember(op.envelope.event);
        const deliveries = op.recipients.map((did) => this.#enqueue(did, { kind: 'topic', topic: op.topic, envelope: op.envelope, hub: op.hub }));
        return { deliveries };
      }
      case 'dm.send': {
        this.#remember(op.envelope.event);
        // `via`: the paired hub it came through, by the name this hub gives it, if its sender is not an agent of this one.
        const hub = { tier: op.tier, received_at: op.at, ...(op.via ? { via: op.via } : {}) };
        return { deliveries: [this.#enqueue(op.envelope.event.recipient, { kind: 'direct', envelope: op.envelope, hub })] };
      }
      case 'mls.keys.add': {
        // `replace`: the reader can no longer open the ones it had here, so they go.
        const packages = [...(op.replace ? [] : (this.keyPackages.get(op.reader) ?? [])), ...op.packages];
        this.keyPackages.set(op.reader, packages.slice(-op.cap)); // beyond the cap the oldest go
        return { count: this.keyPackages.get(op.reader).length };
      }
      case 'mls.keys.claim': {
        // One KeyPackage per reader, used once. The last one stays ("last resort"): a reader that has
        // run out can still be added, at the price of that one being reused until it publishes more.
        const claimed = {};
        for (const reader of op.readers) {
          const packages = this.keyPackages.get(reader);
          if (!packages?.length) continue;
          claimed[reader] = packages.length > 1 ? packages.shift() : packages[0];
        }
        return { claimed };
      }
      case 'mls.dm.create': {
        const current = this.dmGroups.get(op.pair);
        // The groups before this one, newest first. Their commits are kept for a while: a reader may
        // still be opening what was sent in them. Beyond that they go.
        const earlier = current ? [current.group, ...(current.earlier ?? [])] : [];
        for (const forgotten of earlier.splice(op.keep_earlier ?? 2)) this.mlsLogs.delete(forgotten);
        this.dmGroups.set(op.pair, { group: op.group, generation: op.generation, members: op.members, previous: current?.group ?? null, earlier, created_by: op.by, created_at: op.at });
        this.mlsLogs.set(op.group, { epoch: 1, commits: [] }); // a group is born at epoch 1
        // `from`: the paired hub the other agent of the conversation is on, if it is not an agent of this one.
        for (const reader of op.recipients) this.#invite(reader, op.group, op.welcome, op.from);
        return {};
      }
      case 'mls.welcome.put': {
        // Invitations to a group that another hub keeps the record of: a conversation with one of its agents.
        for (const reader of op.readers) this.#invite(reader, op.group, op.welcome, op.from);
        return {};
      }
      case 'mls.topic.create': {
        const topic = this.topics.get(op.name);
        const earlier = topic.mls ? [topic.mls.group, ...(topic.mls.earlier ?? [])] : [];
        for (const forgotten of earlier.splice(op.keep_earlier)) this.mlsLogs.delete(forgotten);
        topic.mls = { group: op.group, generation: op.generation, agents: op.agents, members: op.members, earlier, created_by: op.by, created_at: op.at };
        this.mlsLogs.set(op.group, { epoch: 1, commits: [] });
        for (const reader of op.invited) this.#invite(reader, op.group, op.welcome);
        this.#unsubscribe(op.name, op.removed);
        return {};
      }
      case 'mls.topic.commit': {
        const topic = this.topics.get(op.name);
        const log = this.mlsLog(op.group);
        this.mlsLogs.set(op.group, { epoch: log.epoch + 1, commits: [...log.commits, { epoch: log.epoch, message: op.message }].slice(-op.keep) });
        // A commit that changes who is in the group says so: `members` (and, from the owner, `agents`) afterwards.
        if (op.members) {
          // Whoever asked to be let in again and now has an invitation, or is no longer in, is not waiting any more.
          const rejoin = (topic.mls.rejoin ?? []).filter((reader) => op.members.includes(reader) && !op.invited.includes(reader));
          topic.mls = { ...topic.mls, agents: op.agents, members: op.members, rejoin };
          for (const reader of op.invited) this.#invite(reader, op.group, op.welcome);
          this.#unsubscribe(op.name, op.removed);
        }
        return { epoch: log.epoch + 1 };
      }
      case 'mls.copy': {
        // Commits of a group of a conversation whose home is another hub, as that hub gave them:
        // kept for the readers of this one, which then need no other hub to open what they are sent.
        // They go on from the ones there were, if they start where those ended; if not, they are what there is.
        const groups = this.mlsCopies.get(op.key) ?? [];
        const had = groups.find((entry) => entry.group === op.group);
        const commits = had && had.epoch === op.from ? [...had.commits, ...op.commits] : op.commits;
        const copy = { group: op.group, epoch: op.from + op.commits.length, commits: commits.slice(-op.keep) };
        this.mlsCopies.set(op.key, [...groups.filter((entry) => entry.group !== op.group), copy].slice(-op.keep_groups));
        return {};
      }
      case 'mls.commit': {
        const log = this.mlsLog(op.group);
        this.mlsLogs.set(op.group, { epoch: log.epoch + 1, commits: [...log.commits, { epoch: log.epoch, message: op.message }].slice(-op.keep) });
        return { epoch: log.epoch + 1 };
      }
      case 'mls.topic.rejoin': {
        // A reader that cannot follow the group asks whoever may to leave it out and bring it in again.
        const topic = this.topics.get(op.name);
        topic.mls = { ...topic.mls, rejoin: [...(topic.mls.rejoin ?? []), op.reader].slice(-op.cap) };
        return {};
      }
      case 'mls.welcome.ack': {
        const pending = (this.welcomes.get(op.reader) ?? []).filter((entry) => entry.group !== op.group);
        if (pending.length > 0) this.welcomes.set(op.reader, pending);
        else this.welcomes.delete(op.reader);
        return {};
      }
      case 'inbox.ack': {
        const inbox = this.inboxes.get(op.did);
        let count = 0;
        while (count < inbox.items.length && inbox.items[count].seq <= op.seq) count++;
        inbox.items.splice(0, count);
        return { acked: count };
      }
      default:
        throw new Error(`unknown operation ${op.type}`);
    }
  }

  /** Where a group is: the epoch it is in and the commits that brought it there. One made before commits existed has none. */
  mlsLog(group) {
    return this.mlsLogs.get(group) ?? { epoch: 1, commits: [] };
  }

  /**
   * Leaves `reader` an invitation to `group`. An earlier one to the same group is of no use any
   * more: it is replaced. A reader that never comes back does not pile them up forever: only so
   * many are kept. Those that come with a conversation with an agent of another hub (`from`: that
   * hub) are counted apart, hub by hub: however many one hub sends, they do not crowd out what
   * did not come from it. (One invitation takes the place of another only by naming the same
   * group, and the name of a group is not one to guess: see `dmGroupId`.)
   */
  #invite(reader, group, welcome, from = null) {
    const others = (this.welcomes.get(reader) ?? []).filter((entry) => entry.group !== group);
    const origin = (entry) => entry.from ?? null;
    const same = [...others.filter((entry) => origin(entry) === from), { group, welcome, ...(from === null ? {} : { from }) }];
    // When there are too many, the one that goes is the oldest of whichever conversation, or
    // topic, has most of them waiting: whoever makes one group after another with a reader pushes
    // out its own, not what somebody else is waiting for that reader to open.
    const whose = (entry) => conversationOf(entry.group) ?? entry.group;
    for (const room = from === null ? 50 : 20; same.length > room; ) {
      const waiting = new Map();
      for (const entry of same) waiting.set(whose(entry), (waiting.get(whose(entry)) ?? 0) + 1);
      const most = Math.max(...waiting.values());
      same.splice(same.findIndex((entry) => waiting.get(whose(entry)) === most), 1);
    }
    this.welcomes.set(reader, [...others.filter((entry) => origin(entry) !== from), ...same]);
  }

  #unsubscribe(topic, dids) {
    for (const did of dids ?? []) {
      this.subs.get(topic).delete(did);
      this.#subsOf(did).delete(topic);
    }
  }

  /** A reader that is gone needs no invitations, and nobody should add it to a group again. */
  #forgetMls(reader) {
    this.keyPackages.delete(reader);
    this.welcomes.delete(reader);
  }

  /** None is ever forgotten: the log holds that a delegation that was revoked, or dropped, is not presented again. */
  #rememberRevokedDelegation({ issuer, delegation_id }) {
    this.revokedDelegations.add(`${issuer}|${delegation_id}`);
  }

  isDelegationRevoked({ issuer, id }) {
    return this.revokedDelegations.has(`${issuer}|${id}`);
  }

  #remember(event) {
    this.seen.add(seenKey(event));
    if (this.seen.size > this.seenCap) this.seen.delete(this.seen.values().next().value);
  }

  /** One entry for the agent `did`, copied into the inbox of each of its readers. */
  #enqueue(did, entry, only) {
    const readers = only ? this.readersOf(did).filter((reader) => only.includes(reader)) : this.readersOf(did);
    const items = readers.map((reader) => {
      const inbox = this.inboxes.get(reader);
      const item = { seq: inbox.next++, ...entry };
      inbox.items.push(item);
      if (inbox.items.length > this.inboxCap) {
        inbox.items.shift(); // this reader has been away too long: its oldest undelivered entry is dropped
        inbox.dropped += 1;
      }
      return { reader, item };
    });
    return { did, items };
  }
}
