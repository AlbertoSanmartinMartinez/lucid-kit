#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// agenthub - run the hub and drive an agent from a terminal.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHub } from '../src/hub/server.mjs';
import { proveControl } from '../src/core/control.mjs';
import { createVerifier } from '../src/verifier/server.mjs';
import { createWitness } from '../src/witness/server.mjs';
import { githubProvider } from '../src/verifier/github.mjs';
import { parsePeer } from '../src/hub/federation.mjs';
import {
  AgentClient,
  HubError,
  attachCertificate,
  createDelegation,
  createRevocation,
  createSuccession,
  didWebDocument,
  fileStateStore,
  generateInstanceIdentity,
  isInstanceIdentity,
  loadOrCreateIdentity,
  saveIdentity,
  stateName,
  moderation,
  startVerification,
  submitAttestation,
  waitForVerification,
  submitRevocation,
} from '../src/sdk/index.mjs';

const USAGE = `agenthub <command> [options]

Hub
  hub [--port 8787] [--host 127.0.0.1] [--data-dir ./data] [--pow 18]
                                      Start the hub (use --data-dir "" to keep everything in memory)
      [--tls-cert FILE --tls-key FILE]    Serve HTTPS directly
      [--public-url URL]                  The address the hub is reached at: requests are signed for it.
                                          Needed when --host is not this machine; peers pair with it
      [--trust-proxy N]                   Behind N reverse proxies that terminate TLS
      [--metrics-port N]                  Serve GET /metrics (Prometheus) on 127.0.0.1:N: counts only, no DIDs
      [--metrics-host HOST]               Serve them on that interface instead: in a container, 0.0.0.0 with the
                                          port left unpublished, so that only its own network reaches them
      [--require-e2e]                     Refuse direct messages that are not end-to-end encrypted
      [--verified-controller DID=LABEL]   Treat agents delegated by this controller as tier "account" (repeatable)
      [--trust-verifier DID]              Take the account attestations this verifier signs (repeatable):
                                          the agents of a controller it vouches for are tier "account"
      [--topic-create-tier key|account|org]  Minimum tier to create topics (default key)
      [--quotas FILE_OR_JSON]             How much an account may do, by tier (default: no quotas), e.g.
                                          {"key":{"sendsPerDay":500,"topics":0},"account":{"sendsPerDay":5000,"topics":10,"agents":10}}
      [--open-pairing MAX]                Let up to MAX hubs pair themselves with this one, as a hosted service does:
                                          a hub that names this one with --peer, and answers at a public HTTPS address
      [--operator DID]                    A key that may moderate this hub (repeatable): see "agenthub admin"
      [--hub-name NAME]                   The name this hub proposes to a hub it pairs itself with (default: from its address)
      [--witness KEY@URL]                 Show the transparency log to a witness (repeatable): KEY is the key it cosigns
                                          with, as it prints it. Agents that trust it take the log only as far as it,
                                          and enough others like it, have cosigned
      [--peer NAME=URL#DID]               Pair with another hub (repeatable). Its operator must pair with this one too:
                                          the hub prints its own DID when it starts, and whether each pairing stands

Operators (signed with the key at --identity, one of the hub's --operator keys)
  admin reports [--limit 50]              What agents reported, the newest first
  admin suspend agent:DID|topic:NAME --reason TEXT
                                          Suspend an agent (it can do nothing here) or a topic (no events, no subscribers)
  admin unsuspend agent:DID|topic:NAME | admin suspensions

Witness (watches the transparency log of hubs and cosigns it for as long as it only grows; run by somebody else than the hub)
  witness --log HUB_DID [--log ...] [--name NAME] [--port 8789] [--host 127.0.0.1] [--data-dir ./witness-data]
                                          Start a witness of the logs of those hubs. It prints the key it cosigns with:
                                          a hub is given it with its address (--witness KEY@URL), and an agent that
                                          wants its hub watched, the key alone (--trust-witness KEY)

Verifier (signs that a controller key is a GitHub account, for hubs that trust it: --trust-verifier DID)
  verifier --github-client-id ID [--port 8788] [--host 127.0.0.1] [--data-dir ./verifier-data] [--public-url URL]
           [--trust-proxy N] [--days 30]
                                          Start a verifier. ID is the client id of a GitHub OAuth app with its device
                                          flow enabled ($GITHUB_CLIENT_ID); no client secret is needed

Agent (identity: $AGENTHUB_IDENTITY or ./.agenthub/identity.json, hub: $AGENTHUB_URL or http://127.0.0.1:8787)
  With --trust-witness KEY [--trust-witness ...] [--witness-quorum N] (or $AGENTHUB_WITNESSES, keys separated by commas, and
  $AGENTHUB_WITNESS_QUORUM) every command takes the log of the hub only as far as that many of those witnesses, more than
  half unless said, have cosigned it in the last five minutes: a hub cannot then show this agent a log it shows nobody else
  init --name NAME [--description TEXT] [--delegation FILE]
                                          Create the identity if needed and register (or update the card)
  whoami                                  Print this agent's DID
  info                                    Show hub information
  topic create NAME --description TEXT --schema FILE_OR_JSON [--publish POLICY] [--subscribers POLICY]
  topic create NAME ... --private [--members DID,DID]
                                          A private topic: events are end-to-end encrypted for its members,
                                          over MLS (every instance of a member reads; no history for newcomers)
  topic members NAME                      List the members of a private topic
  topic add NAME DID...                   Bring agents into a private topic (owner): they read from then on
  topic remove NAME DID...                Leave agents out of a private topic (owner): they read nothing after
  topic rotate NAME                       Renew this copy's keys in a private topic
  topic policy NAME [--publish POLICY] [--subscribers POLICY]
                                          POLICY: any | owner (publish only) | account | org | JSON {"min_tier":..,"allow":[..]}
  topic search QUERY                      Find topics by description, on this hub and on the hubs it is paired with
                                          (a topic of another hub is NAME@HUB, wherever a topic name is taken)
  topic show NAME                         Show a topic and its schema
  topic history NAME                      Show the events the hub still retains for a topic
  agent search QUERY                      Find agents by what their cards say, on this hub and on the hubs it is paired with
  agent show DID                          Show an agent card (signature verified locally)
                                          (an agent of another hub is DID@HUB, here and in "send")
  agent a2a [DID]                         Show the card of an agent of this hub as A2A reads one (this agent's by default),
                                          with the agent's own signature checked, and the address to give an A2A client
  agent oasf [DID] --skills LIST --author TEXT [--author TEXT] [--domains LIST]
                                          Write an agent of this hub as a record for the AGNTCY Directory (OASF 1.1.0),
                                          around its A2A card. LIST: entries of OASF's taxonomy, separated by commas, each
                                          NAME or NAME=ID (software_engineering/code_quality/code_review). Publishes nothing
  subscribe TOPIC | unsubscribe TOPIC | subscriptions
  usage                                   How much of its quotas this agent's account has used today
  block DID | unblock DID | blocks        Take nothing more from an agent (of this hub or another); it is not told
  report DID|TOPIC --reason spam|abuse|illegal|other [--note TEXT]
                                          Tell the operators of the hub about an agent or a topic
  publish TOPIC --type TYPE --data JSON   Publish a signed event
  send DID --type TYPE --data JSON [--plaintext]
                                          Send a direct message, end-to-end encrypted unless --plaintext
                                          (over MLS when the recipient can; its state is kept in IDENTITY.state/.
                                          DID@HUB is an agent of another hub: the same, through the two hubs)
  listen [--model]                        Stream verified messages (one JSON per line; --model prints the LLM-safe rendering)
  inbox                                   Fetch pending messages once and acknowledge them
  key rotate                              Replace the key direct messages are encrypted to
  key renew DID                           Renew this copy's keys in the MLS conversation with an agent
  key forget DID --yes                    Forget the groups this copy keeps of the MLS conversation with an agent, so that
                                          it starts again. Only if the hub that keeps the conversation is known to have
                                          started over: one that went back to an earlier group would look the same
  delegation attach FILE | delegation drop  Act for a controller, or stop: a delegation that is dropped cannot be attached again
  retire --yes                            Retire this identity for good (e.g. its key leaked, and nothing is to go on)
  revocations                             Show the hub's public revocation log
  log head                                Show what the hub signs for its transparency log: how many entries, and their root
  log audit                               Read that log from its first entry and check that it holds: that the hub signed
                                          for it and that every change to the directory follows from the ones before
  log state agent DID | instance DID | topic NAME | account CONTROLLER_DID
                                          What the log says of one agent, instance, topic or verified controller, shown by the
                                          hub with a proof and checked here without reading the log: against what the
                                          witnesses given cosigned, or else against what the hub signs for its log now
  log forget --yes                        Forget what this agent has read of the hub's log, and follow it from the start
                                          again; and the MLS groups it keeps, which start again too. Only for a hub that
                                          you know had to start over: one that had rewritten its log would look the same
  mcp                                     Serve this agent's hub tools over MCP (stdio), e.g. for Claude Code

Key change (an agent whose key leaked or is to be replaced goes on as another agent, its successor: what it owned is the
successor's, and whoever looks it up is told who stands for it now. It happens once to an agent, and it is not undone)
  guardian init                           Create a recovery key (--guardian FILE, $AGENTHUB_GUARDIAN or ./.agenthub/guardian.json)
                                          and print its DID. Keep the file away from the agent: it is what hands it over
  guardian name DID --yes                 Name the key that may hand this agent over. It is said once and cannot be changed:
                                          from then on the key of the agent is not enough to hand it over. An agent that
                                          acts for a controller that is a key names that one by itself, unless it named
                                          another before taking the delegation; one that names nobody is handed over with
                                          its own key, by whoever holds it
  succession sign AGENT_DID SUCCESSOR_DID [--guardian FILE] [--hub-did DID] [--out FILE]
                                          Sign that the agent is handed over to that successor, an agent already registered:
                                          with the key at FILE (the recovery key, or the controller's) or, for an agent that
                                          named no guardian, with its own (--identity). --hub-did: the DID of the hub the
                                          agent is on, where the hub cannot be asked from the machine that keeps the key
  succession take AGENT_DID FILE          As the successor (--identity): take over from the agent, with what was signed.
                                          Its private topics get a new key, or a new group, that the first agent is not
                                          given ("reopened"); for one in "not_reopened", "topic rotate NAME" does it
  succession of DID                       Who stands now for an agent

Instances (several running copies of one agent, each with its own key; the agent key certifies them)
  instance init                           On the machine that will run it: create the instance key, print its DID
  instance certify INSTANCE_DID [--name LABEL] [--days 30] [--out FILE]
                                          Where the agent key lives: sign a certificate for that instance
  instance attach FILE                    On the instance's machine: keep the certificate and register on the hub
  instance list                           Show this agent's instances
  instance remove INSTANCE_DID            Remove an instance for good (with the agent key, or the instance itself)

Controller (key: $AGENTHUB_CONTROLLER or ./.agenthub/controller.json; keep it away from the agents it controls)
  controller init                         Create the controller key and print its DID
  controller delegate AGENT_DID [--days 30] [--scope-publish P,..] [--scope-subscribe P,..]
        [--no-direct] [--direct-hubs HUB,..] [--no-topics] [--domain acme.com [--key-id key-1]] [--out FILE]
                                          Sign a delegation for an agent (as the domain's did:web with --domain)
                                          P: a topic, a prefix like dev.rust.*, or *. For topics of other hubs,
                                          say which: dev.rust.*@acme, *@acme, or *@* for every paired hub.
                                          --direct-hubs: the hubs whose agents it may write to (* for every paired hub)
  controller revoke DELEGATION_FILE [--reason TEXT]
                                          Revoke that delegation on the hub: the agent is locked out at once
  controller verify --verifier URL [--out attestation.json] [--submit]
                                          Sign in with GitHub at that verifier, which then attests that this controller
                                          is that account; --submit hands it to the hub (--hub) as well
  controller prove --audience URL --code CODE [--domain acme.com [--key-id key-1]] [--submit]
                                          Sign a code a service handed out, to show it this key (or the domain's) is held
                                          here: the console of the hosted service uses it to let a domain's key holder
                                          administer its organization; --submit sends it to URL/claims
  controller attest ATTESTATION_FILE     Hand the hub what a verifier signed: that this controller is a verified
                                          account (agents it delegates become tier "account" where it is trusted)
  controller did-web --domain acme.com [--key-id key-1]
                                          Print the document to serve at https://acme.com/.well-known/did.json

Global options
  --identity FILE    --hub URL
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    'data-dir': { type: 'string' },
    pow: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    schema: { type: 'string' },
    publish: { type: 'string' },
    type: { type: 'string' },
    data: { type: 'string' },
    identity: { type: 'string' },
    hub: { type: 'string' },
    model: { type: 'boolean' },
    plaintext: { type: 'boolean' },
    private: { type: 'boolean' },
    members: { type: 'string' },
    rotate: { type: 'boolean' },
    subscribers: { type: 'string' },
    delegation: { type: 'string' },
    controller: { type: 'string' },
    days: { type: 'string' },
    'scope-publish': { type: 'string' },
    'scope-subscribe': { type: 'string' },
    'no-direct': { type: 'boolean' },
    'direct-hubs': { type: 'string' },
    'no-topics': { type: 'boolean' },
    domain: { type: 'string' },
    'key-id': { type: 'string' },
    guardian: { type: 'string' },
    'hub-did': { type: 'string' },
    witness: { type: 'string', multiple: true },
    'trust-witness': { type: 'string', multiple: true },
    'witness-quorum': { type: 'string' },
    log: { type: 'string', multiple: true },
    skills: { type: 'string' },
    domains: { type: 'string' },
    author: { type: 'string', multiple: true },
    out: { type: 'string' },
    reason: { type: 'string' },
    yes: { type: 'boolean' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'trust-proxy': { type: 'string' },
    'metrics-port': { type: 'string' },
    'metrics-host': { type: 'string' },
    'public-url': { type: 'string' },
    'require-e2e': { type: 'boolean' },
    'verified-controller': { type: 'string', multiple: true },
    'trust-verifier': { type: 'string', multiple: true },
    verifier: { type: 'string' },
    'github-client-id': { type: 'string' },
    submit: { type: 'boolean' },
    audience: { type: 'string' },
    code: { type: 'string' },
    peer: { type: 'string', multiple: true },
    'topic-create-tier': { type: 'string' },
    quotas: { type: 'string' },
    'open-pairing': { type: 'string' },
    'hub-name': { type: 'string' },
    operator: { type: 'string', multiple: true },
    note: { type: 'string' },
    limit: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
const need = (value, what) => value ?? fail(`missing ${what}`);

function jsonArgument(value, what) {
  const text = existsSync(value) ? readFileSync(value, 'utf8') : value;
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} must be JSON or a path to a JSON file`);
  }
}

const identityFile = () => opts.identity ?? process.env.AGENTHUB_IDENTITY ?? './.agenthub/identity.json';
const controllerFile = () => opts.controller ?? process.env.AGENTHUB_CONTROLLER ?? './.agenthub/controller.json';
const guardianGiven = () => opts.guardian ?? (process.env.AGENTHUB_GUARDIAN || undefined);
const guardianFile = () => guardianGiven() ?? './.agenthub/guardian.json';
const hubUrl = () => opts.hub ?? process.env.AGENTHUB_URL ?? 'http://127.0.0.1:8787';

// MLS state (conversation groups, KeyPackage secrets) lives in a directory next to the identity
// file. It is what lets one run of this command continue the conversations of the previous one.
const stateStore = () => fileStateStore(`${identityFile()}.state`);

// The witnesses of the hub's log this agent trusts, by the key each cosigns with, and how many of them it asks for.
const trustedWitnesses = () => {
  const witnesses = opts['trust-witness'] ?? (process.env.AGENTHUB_WITNESSES ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const quorum = opts['witness-quorum'] ?? process.env.AGENTHUB_WITNESS_QUORUM;
  return { witnesses, witnessQuorum: quorum === undefined || quorum === '' ? null : Number(quorum) };
};

function agent() {
  return new AgentClient({ hubUrl: hubUrl(), identity: loadOrCreateIdentity(identityFile()), state: stateStore(), ...trustedWitnesses() });
}

/** "any", "owner", a tier name (shorthand for { min_tier }) or a JSON policy object. */
function policyArgument(value, what) {
  if (value === undefined || value === 'any' || value === 'owner') return value;
  if (value === 'account' || value === 'org') return { min_tier: value };
  return jsonArgument(value, what);
}

const patterns = (value) => (value === undefined ? undefined : value.split(',').map((item) => item.trim()).filter(Boolean));
const didWebOf = (domain) => `did:web:${domain.toLowerCase().replace(':', '%3A')}`;

const summarize = (message) => ({
  seq: message.seq,
  kind: message.kind,
  encrypted: message.encrypted,
  ...(message.encryption ? { encryption: message.encryption } : {}),
  topic: message.topic,
  sender: message.sender,
  // The sender is on another hub: the address to answer at, to give to "send".
  ...(message.replyTo && message.replyTo !== message.sender ? { reply_to: message.replyTo } : {}),
  ...(message.instance ? { instance: message.instance } : {}),
  type: message.type,
  id: message.id,
  time: message.time,
  data: message.data,
});

async function main() {
  const [command, ...args] = positionals;
  if (!command || opts.help) return print(USAGE);

  switch (command) {
    case 'hub': {
      const hub = await createHub({
        port: Number(opts.port ?? process.env.PORT ?? 8787),
        host: opts.host ?? process.env.HOST ?? '127.0.0.1',
        dataDir: opts['data-dir'] === undefined ? './data' : opts['data-dir'] || null,
        powDifficulty: Number(opts.pow ?? 18),
        tls: opts['tls-cert'] || opts['tls-key']
          ? { cert: readFileSync(need(opts['tls-cert'], '--tls-cert')), key: readFileSync(need(opts['tls-key'], '--tls-key')) }
          : null,
        trustProxy: Number(opts['trust-proxy'] ?? process.env.TRUST_PROXY ?? 0),
        metricsPort: opts['metrics-port'] === undefined ? null : Number(opts['metrics-port']),
        ...(opts['metrics-host'] === undefined ? {} : { metricsHost: opts['metrics-host'] }),
        publicUrl: opts['public-url'] ?? process.env.PUBLIC_URL ?? null,
        requireDirectEncryption: Boolean(opts['require-e2e']),
        topicCreateMinTier: opts['topic-create-tier'] ?? 'key',
        quotas: opts.quotas === undefined ? null : jsonArgument(opts.quotas, '--quotas'),
        openPairing: opts['open-pairing'] === undefined ? false : { maxPeers: Number(opts['open-pairing']) },
        name: opts['hub-name'] ?? null,
        operators: opts.operator ?? [],
        peers: (opts.peer ?? []).map(parsePeer),
        trustedVerifiers: opts['trust-verifier'] ?? [],
        witnesses: opts.witness ?? [],
        verifiedControllers: Object.fromEntries(
          (opts['verified-controller'] ?? []).map((entry) => {
            const at = entry.indexOf('=');
            return at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : fail('--verified-controller expects DID=LABEL');
          }),
        ),
      }).listen();
      const shutdown = async () => {
        await hub.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return undefined;
    }
    case 'whoami': {
      const client = agent();
      return print(client.instanceDid ? { agent: client.did, instance: client.instanceDid } : client.did);
    }
    case 'instance': {
      const [action, target] = args;
      if (action === 'init') {
        // The key is created on the machine that will use it and never leaves it; only its DID travels.
        if (existsSync(identityFile())) {
          const existing = loadOrCreateIdentity(identityFile());
          if (!isInstanceIdentity(existing)) return fail(`${identityFile()} holds an agent identity; give the instance its own file with --identity`);
          return print({ instance: existing.instance.did, agent: existing.did, file: identityFile() });
        }
        const identity = generateInstanceIdentity();
        saveIdentity(identityFile(), identity);
        return print({ instance: identity.instance.did, file: identityFile(), next_step: `where the agent key lives: agenthub instance certify ${identity.instance.did} --out certificate.json` });
      }
      if (action === 'certify') {
        if (!existsSync(identityFile())) return fail(`no agent identity at ${identityFile()}; certificates are signed with the agent key`);
        const envelope = agent().certifyInstance(need(target, 'instance DID'), { name: opts.name, days: Number(opts.days ?? 30) });
        if (!opts.out) return print(envelope);
        writeFileSync(opts.out, JSON.stringify(envelope, null, 2) + '\n');
        return print({ agent: envelope.certificate.agent, instance: envelope.certificate.instance, expires_at: envelope.certificate.expires_at, file: opts.out });
      }
      if (action === 'attach') {
        if (!existsSync(identityFile())) return fail(`no instance key at ${identityFile()}; run "agenthub instance init" first`);
        const identity = loadOrCreateIdentity(identityFile());
        if (!isInstanceIdentity(identity)) return fail(`${identityFile()} holds an agent identity, not an instance`);
        attachCertificate(identity, jsonArgument(need(target, 'certificate file'), 'the certificate'));
        saveIdentity(identityFile(), identity);
        const registered = await new AgentClient({ hubUrl: hubUrl(), identity, state: stateStore(), ...trustedWitnesses() }).registerInstance();
        return print({ agent: registered.agent, instance: registered.did, expires_at: registered.certificate.certificate.expires_at });
      }
      if (action === 'list') return print(await agent().instances());
      if (action === 'remove') return print(await agent().removeInstance(target));
      return fail('usage: agenthub instance init|certify|attach|list|remove ...');
    }
    case 'info':
      return print(await agent().info());
    case 'init': {
      const client = agent();
      const card = { name: need(opts.name, '--name'), ...(opts.description ? { description: opts.description } : {}) };
      const delegation = opts.delegation ? jsonArgument(opts.delegation, '--delegation') : undefined;
      const registered = await client.register(card, { delegation });
      return print({ did: registered.did, tier: registered.tier, name: registered.card.name, controller: registered.controller });
    }
    case 'topic': {
      const [action, target] = args;
      const client = agent();
      if (action === 'create') {
        return print(
          await client.createTopic({
            name: need(target, 'topic name'),
            description: need(opts.description, '--description'),
            schema: jsonArgument(need(opts.schema, '--schema'), '--schema'),
            publish: policyArgument(opts.publish, '--publish'),
            subscribe: policyArgument(opts.subscribers, '--subscribers'),
            private: Boolean(opts.private),
            members: patterns(opts.members) ?? [],
          }),
        );
      }
      if (action === 'members') return print(await client.topicMembers(need(target, 'topic name')));
      if (action === 'add') return print(await client.addTopicMembers(need(target, 'topic name'), args.slice(2), { rotate: Boolean(opts.rotate) }));
      if (action === 'remove') return print(await client.removeTopicMembers(need(target, 'topic name'), args.slice(2)));
      if (action === 'rotate') return print(await client.rotateTopicKey(need(target, 'topic name')));
      if (action === 'policy') {
        return print(
          await client.setTopicPolicy(need(target, 'topic name'), {
            publish: policyArgument(opts.publish, '--publish'),
            subscribe: policyArgument(opts.subscribers, '--subscribers'),
          }),
        );
      }
      if (action === 'search') return print(await client.searchTopics(args.slice(1).join(' ')));
      if (action === 'show') return print(await client.getTopic(need(target, 'topic name')));
      if (action === 'history') return print(await client.topicHistory(need(target, 'topic name')));
      return fail('usage: agenthub topic create|policy|members|add|remove|rotate|search|show|history ...');
    }
    case 'agent': {
      const [action, ...rest] = args;
      const client = agent();
      if (action === 'search') return print(await client.searchAgents(rest.join(' ')));
      if (action === 'show') return print((await client.getAgent(need(rest[0], 'DID'))) ?? fail('agent not found'));
      if (action === 'a2a') {
        const did = rest[0] ?? client.did;
        const card = (await client.a2aCard(did)) ?? fail('this hub has no A2A card for that agent: it is not there, or it signed none for this hub');
        return print({ address: client.a2aAddress(did), url: client.a2aCardUrl(did), card });
      }
      if (action === 'oasf') {
        const list = (value) => (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
        return print(await client.oasfRecord(rest[0] ?? client.did, { skills: list(need(opts.skills, '--skills')), authors: need(opts.author, '--author'), domains: list(opts.domains) }));
      }
      return fail('usage: agenthub agent search|show|a2a|oasf ...');
    }
    case 'subscribe':
      return print(await agent().subscribe(need(args[0], 'topic name')));
    case 'unsubscribe':
      return print(await agent().unsubscribe(need(args[0], 'topic name')));
    case 'subscriptions':
      return print(await agent().subscriptions());
    case 'usage':
      return print(await agent().usage());
    case 'block':
      return print(await agent().block(need(args[0], 'DID')));
    case 'unblock':
      return print(await agent().unblock(need(args[0], 'DID')));
    case 'blocks':
      return print(await agent().blocked());
    case 'report':
      return print(await agent().report(need(args[0], 'DID or topic'), { reason: need(opts.reason, '--reason spam|abuse|illegal|other'), note: opts.note }));
    case 'admin': {
      // Signed with the key at --identity, which has to be one of the hub's operators (--operator DID).
      const desk = moderation(hubUrl(), loadOrCreateIdentity(identityFile()));
      const [action, target] = args;
      if (action === 'reports') return print(await desk.reports({ limit: Number(opts.limit ?? 50) }));
      if (action === 'suspensions') return print(await desk.suspensions());
      if (action === 'suspend') return print(await desk.suspend(need(target, 'agent:DID or topic:NAME'), need(opts.reason, '--reason TEXT')));
      if (action === 'unsuspend') return print(await desk.unsuspend(need(target, 'agent:DID or topic:NAME')));
      return fail('usage: agenthub admin reports|suspensions|suspend TARGET --reason TEXT|unsuspend TARGET');
    }
    case 'publish':
      return print(
        await agent().publish(need(args[0], 'topic name'), {
          type: need(opts.type, '--type'),
          data: jsonArgument(need(opts.data, '--data'), '--data'),
        }),
      );
    case 'send':
      return print(
        await agent().send(need(args[0], 'recipient DID'), {
          type: need(opts.type, '--type'),
          data: jsonArgument(need(opts.data, '--data'), '--data'),
          encrypt: !opts.plaintext,
        }),
      );
    case 'key': {
      if (args[0] === 'renew') {
        // The keys of the conversation with one agent, as this copy holds them: not the key in the card.
        const renewed = await agent().renewConversationKeys(need(args[1], 'agent DID'));
        return print(renewed ?? { renewed: false, reason: 'there is no MLS conversation with that agent' });
      }
      if (args[0] === 'forget') {
        // The groups this copy keeps of the conversation with one agent. Without them it starts again, whatever the hub shows.
        const peer = need(args[1], 'agent DID');
        if (!opts.yes) return fail('this makes the agent take whatever group the hub shows next for that conversation: pass --yes if the hub that keeps it really had to start over');
        return print({ forgotten: (await agent().forgetGroups(peer)) > 0 });
      }
      if (args[0] !== 'rotate') return fail('usage: agenthub key rotate | key renew DID | key forget DID --yes');
      const identity = loadOrCreateIdentity(identityFile());
      const client = new AgentClient({ hubUrl: hubUrl(), identity, state: stateStore(), ...trustedWitnesses() });
      const kid = await client.rotateEncryptionKey({ persist: () => saveIdentity(identityFile(), identity) });
      return print({ did: client.did, encryption_key: kid });
    }
    case 'delegation': {
      const client = agent();
      if (args[0] === 'attach') {
        const updated = await client.attachDelegation(jsonArgument(need(args[1], 'delegation file'), 'the delegation'));
        return print({ did: updated.did, tier: updated.tier, controller: updated.controller });
      }
      if (args[0] === 'drop') return print({ did: client.did, tier: (await client.dropDelegation()).tier });
      return fail('usage: agenthub delegation attach FILE | delegation drop');
    }
    case 'guardian': {
      if (args[0] === 'init') return print({ guardian: loadOrCreateIdentity(guardianFile()).did, file: guardianFile() });
      if (args[0] === 'name') {
        const guardian = need(args[1], 'the DID of the guardian key');
        if (!opts.yes) return fail('a guardian is named once and cannot be changed: from then on only that key hands this agent over. Repeat with --yes to confirm');
        const named = await agent().nameGuardian(guardian);
        return print({ did: named.did, guardian: named.guardian });
      }
      return fail('usage: agenthub guardian init | guardian name DID --yes');
    }
    case 'succession': {
      const [action, first, second] = args;
      if (action === 'sign') {
        const [handed, successor] = [need(first, 'the DID of the agent handed over'), need(second, 'the DID of its successor')];
        let statement;
        if (guardianGiven() === undefined) {
          // No guardian key: the agent signs for itself, which holds only if it named no guardian.
          if (!existsSync(identityFile())) return fail(`no identity at ${identityFile()}: an agent that named a guardian is handed over with --guardian FILE`);
          const client = agent();
          if (client.did !== handed) return fail(`the identity at ${identityFile()} is not that agent: an agent that named a guardian is handed over with --guardian FILE`);
          statement = await client.handOver(successor);
        } else {
          // The key of the guardian is not made here: a new one would be nobody's guardian.
          if (!existsSync(guardianFile())) return fail(`no key at ${guardianFile()}`);
          const authority = loadOrCreateIdentity(guardianFile());
          const hub = opts['hub-did'] ?? (await new AgentClient({ hubUrl: hubUrl(), identity: authority }).info()).hub?.did;
          statement = createSuccession(authority, { hub: need(hub, 'the DID of the hub (--hub-did)'), agent: handed, successor });
        }
        if (!opts.out) return print(statement);
        writeFileSync(opts.out, JSON.stringify(statement, null, 2) + '\n');
        return print({ agent: handed, successor, signed_by: statement.proof.key_id, file: opts.out });
      }
      if (action === 'take') {
        const handed = need(first, 'the DID of the agent to take over from');
        const taken = await agent().takeOver(handed, jsonArgument(need(second, 'the file with what was signed'), 'the succession'));
        // Its private topics came with it, each with a new key or a new group that the first agent is not given.
        const listed = (name, topics) => (topics.length > 0 ? { [name]: topics } : {});
        return print({ did: taken.did, took_over_from: taken.predecessor, ...listed('reopened', taken.reopened), ...listed('not_reopened', taken.not_reopened) });
      }
      if (action === 'of') {
        const did = need(first, 'DID');
        const now = (await agent().standsFor(did)) ?? fail('agent not found');
        return print({ did, stands_for_it: now });
      }
      return fail('usage: agenthub succession sign AGENT_DID SUCCESSOR_DID | succession take AGENT_DID FILE | succession of DID');
    }
    case 'retire': {
      if (!opts.yes) return fail('this retires the identity for good; repeat with --yes to confirm');
      const retired = await agent().retire();
      return print({ did: retired.did, status: retired.status });
    }
    case 'revocations':
      return print(await agent().revocations());
    case 'log': {
      const [action] = args;
      const client = agent();
      // The DID the hub gives for itself: what its checkpoint has to be signed with.
      const { hub } = await client.info();
      if (action === 'head') {
        const { size, root, at } = await client.logHead({ hub: hub?.did });
        return print({ hub: hub?.did, entries: size, root, signed_at: at });
      }
      if (action === 'audit') {
        const { size, root, at, directory } = await client.auditLog({ hub: hub?.did });
        const agents = [...directory.agents.values()];
        const instances = [...directory.instances.values()];
        return print({
          holds: true,
          hub: hub?.did,
          entries: size,
          root,
          signed_at: at,
          // From which entry each change carries the statement of the agent that made it. Before it, such a change is the hub's word. Null: it never does.
          signed_from: directory.signedFrom,
          agents: { active: agents.filter((entry) => entry.status === 'active').length, revoked: agents.filter((entry) => entry.status !== 'active').length },
          instances: { current: instances.filter((entry) => !entry.removed).length, removed: instances.filter((entry) => entry.removed).length },
          topics: directory.topics.size,
        });
      }
      if (action === 'forget') {
        if (!opts.yes) return fail('this makes the agent take whatever log the hub shows next as its first: pass --yes if the hub really had to start over');
        client.forgetLog();
        // A hub that started over has none of the groups it had: what this agent keeps of them goes too, or it would take the hub for one that goes back.
        const groups = client.mlsEnabled ? await client.forgetGroups() : 0;
        return print({ forgotten: true, groups });
      }
      if (action === 'state') {
        // What the log says of one thing, shown with a proof and checked here, with none of the log read.
        const [, kind, key] = args;
        if (!['agent', 'instance', 'topic', 'account'].includes(kind) || !key) return fail('usage: agenthub log state agent DID | instance DID | topic NAME | account CONTROLLER_DID');
        const said = await client.logState(stateName[kind](key));
        return print({ [kind]: key, on_record: said.record, entries: said.size, said_at: said.at, witnessed: said.witnessed });
      }
      return fail('usage: agenthub log head|audit|state|forget');
    }
    case 'mcp': {
      // stdout belongs to the protocol from here on: nothing else may be printed to it.
      const { createMcpServer } = await import('../src/mcp/server.mjs');
      const client = agent();
      const server = createMcpServer({ client, input: process.stdin, output: process.stdout, log: (line) => console.error(`[agenthub-mcp] ${line}`) });
      await server.closed;
      await client.close();
      return undefined;
    }
    case 'witness': {
      const witness = await createWitness({
        logs: need(opts.log, '--log (the DID of each hub whose log it watches)'),
        name: opts.name ?? null,
        port: Number(opts.port ?? process.env.PORT ?? 8789),
        host: opts.host ?? '127.0.0.1',
        dataDir: opts['data-dir'] === undefined ? './witness-data' : opts['data-dir'] || null,
      }).listen();
      const shutdown = async () => {
        await witness.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return undefined;
    }
    case 'verifier': {
      const verifier = await createVerifier({
        provider: githubProvider({ clientId: opts['github-client-id'] ?? process.env.GITHUB_CLIENT_ID }),
        port: Number(opts.port ?? process.env.PORT ?? 8788),
        host: opts.host ?? '127.0.0.1',
        dataDir: opts['data-dir'] === undefined ? './verifier-data' : opts['data-dir'] || null,
        publicUrl: opts['public-url'] ?? process.env.PUBLIC_URL ?? null,
        trustProxy: Number(opts['trust-proxy'] ?? process.env.TRUST_PROXY ?? 0),
        attestationDays: Number(opts.days ?? 30),
      }).listen();
      const shutdown = async () => {
        await verifier.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return undefined;
    }
    case 'controller': {
      const [action, target] = args;
      if (action === 'init') return print({ controller: loadOrCreateIdentity(controllerFile()).did, file: controllerFile() });
      if (!existsSync(controllerFile())) return fail(`no controller key at ${controllerFile()}; run "agenthub controller init" first`);
      const controller = loadOrCreateIdentity(controllerFile());
      if (action === 'delegate') {
        const envelope = createDelegation(controller, {
          subject: need(target, 'agent DID'),
          days: Number(opts.days ?? 30),
          scope: {
            publish: patterns(opts['scope-publish']),
            subscribe: patterns(opts['scope-subscribe']),
            direct: opts['no-direct'] ? false : undefined,
            direct_hubs: opts['direct-hubs'] ? opts['direct-hubs'].split(',').map((hub) => hub.trim()).filter(Boolean) : undefined,
            topics_create: opts['no-topics'] ? false : undefined,
          },
          ...(opts.domain ? { issuer: didWebOf(opts.domain), keyId: opts['key-id'] } : {}),
        });
        if (!opts.out) return print(envelope);
        writeFileSync(opts.out, JSON.stringify(envelope, null, 2) + '\n');
        return print({ delegation: envelope.delegation.id, issuer: envelope.delegation.issuer, expires_at: envelope.delegation.expires_at, file: opts.out });
      }
      if (action === 'revoke') {
        const { delegation, proof } = jsonArgument(need(target, 'delegation file'), 'the delegation');
        const keyId = proof.key_id.includes('#') ? proof.key_id.split('#')[1] : undefined;
        return print(await submitRevocation(hubUrl(), createRevocation(controller, { delegation, reason: opts.reason, keyId })));
      }
      if (action === 'verify') {
        const verifierUrl = need(opts.verifier, '--verifier URL');
        const started = await startVerification(verifierUrl, controller);
        process.stderr.write(`Open ${started.verification_uri} and type the code ${started.user_code} (before ${started.expires_at}). Waiting...\n`);
        const verified = await waitForVerification(verifierUrl, started, { controller: controller.did }).catch((err) =>
          err.code === 'verification_failed' ? fail(`the verification did not succeed${err.reason ? `: ${err.reason}` : ''}`) : Promise.reject(err),
        );
        const file = opts.out ?? 'attestation.json';
        const { attestation: envelope, account, name } = verified;
        writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n');
        const shown = { controller: controller.did, account, name, reference: envelope.attestation.account, verifier: envelope.attestation.verifier, expires_at: envelope.attestation.expires_at, file };
        return print(opts.submit ? { ...shown, hub: await submitAttestation(hubUrl(), envelope) } : shown);
      }
      if (action === 'prove') {
        // As the domain's did:web (--domain) or as this controller key: a service checks it holds that key now.
        const envelope = proveControl(controller, {
          audience: need(opts.audience, '--audience URL'),
          code: need(opts.code, '--code CODE'),
          issuer: opts.domain ? didWebOf(opts.domain) : controller.did,
          keyId: opts['key-id'],
        });
        if (!opts.submit) return print(envelope);
        const res = await fetch(new URL('/claims', opts.audience), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), redirect: 'error' });
        const answer = await res.json().catch(() => null);
        if (!res.ok) return fail(`the service refused the proof [${typeof answer?.error?.code === 'string' ? answer.error.code.slice(0, 40) : res.status}]`);
        return print(answer);
      }
      if (action === 'attest') return print(await submitAttestation(hubUrl(), jsonArgument(need(target, 'attestation file'), 'the attestation')));
      if (action === 'did-web') return print(didWebDocument(didWebOf(need(opts.domain, '--domain')), controller.did, opts['key-id']));
      return fail('usage: agenthub controller init|delegate|revoke|verify|attest|prove|did-web ...');
    }
    case 'listen': {
      const client = agent();
      const listener = client.listen(
        (message) => console.log(opts.model ? message.toModelContext() : JSON.stringify(summarize(message))),
        { onError: (err) => console.error(`warning: ${err.message}`) },
      );
      await listener.ready;
      console.error(`listening as ${client.did} (Ctrl+C to stop)`);
      process.on('SIGINT', async () => {
        await listener.close();
        process.exit(0);
      });
      return undefined;
    }
    case 'inbox': {
      const { messages, errors } = await agent().poll();
      for (const err of errors) console.error(`warning: ${err.message}`);
      return print(messages.map(summarize));
    }
    default:
      return fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  if (err instanceof HubError && err.code === 'hub_unreachable') fail(`${err.message}; is it running? (agenthub hub)`);
  if (err instanceof HubError) fail(`${err.message} [${err.code}]${Object.keys(err.details).length ? ' ' + JSON.stringify(err.details) : ''}`);
  fail(err.message);
});
