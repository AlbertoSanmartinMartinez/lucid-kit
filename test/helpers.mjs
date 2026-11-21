// Shared by the test files: a hub on a random port with relaxed limits, and a message collector.

import { createServer } from 'node:net';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, HubError, attachCertificate, createInstanceCertificate, generateIdentity, generateInstanceIdentity } from '../src/sdk/index.mjs';
import { signRequest } from '../src/core/reqsig.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/core/jcs.mjs';
import { contractHash, directoryState, replayLog } from '../src/core/log.mjs';
import { stateRoot } from '../src/core/statemap.mjs';
import { signStatement } from '../src/core/statement.mjs';

export const GENEROUS = { burst: 10_000, perMinute: 10_000 };

// When a test file hangs, the runner ends it after a minute and says which file, and nothing else. It
// happened on GitHub, on one version of Node, in files that pass everywhere else every time. So a file
// that is still running after 40 seconds says what it is waiting for: the test it is in, the requests
// that have not been answered, and what keeps the process busy (a lookup, a socket, a timer).
const waiting = new Map();
let running = 'no test that started a hub';
const plainFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = { what: `${init?.method ?? 'GET'} ${String(input?.url ?? input).slice(0, 200)}`, since: Date.now() };
  waiting.set(request, true);
  return plainFetch(input, init).finally(() => waiting.delete(request));
};
setTimeout(() => {
  const now = Date.now();
  const busy = {};
  for (const kind of process.getActiveResourcesInfo()) busy[kind] = (busy[kind] ?? 0) + 1;
  console.error(`[watchdog] this file is still running after 40 s, in: ${running}`);
  console.error(`[watchdog] requests not answered: ${[...waiting.keys()].map(({ what, since }) => `${what} (${now - since} ms)`).join('; ') || 'none'}`);
  console.error(`[watchdog] what keeps the process busy: ${JSON.stringify(busy)}`);
}, 40_000).unref();

/** The address of a hub that is not there: a local port that was free a moment ago, with nothing listening on it. */
export async function deadHubUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

export async function startHub(t, options = {}) {
  running = t.name;
  const hub = await createHub({
    port: 0,
    quiet: true,
    powDifficulty: 8,
    ...options,
    limits: { register: GENEROUS, challenge: GENEROUS, topicCreate: GENEROUS, instance: GENEROUS, mls: GENEROUS, mlsClaim: GENEROUS, ...(options.limits ?? {}) },
  }).listen();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await hub.close();
    // Whatever a test did, a hub must not have put on record what the rules of its own log refuse:
    // every reader that follows that log would turn away from the hub for good.
    const { directory } = await replayLog(hub.store.log, { hub: hub.did });
    // And the map a reader keeps of the directory as it goes is the map of what the directory holds:
    // no rule of the log changes something without saying so, or the state the hub puts on record
    // would be that of another directory.
    const whole = stateRoot(directoryState(directory).map(([name, record]) => [name, createHash('sha256').update(canonicalize(record)).digest()]));
    assert.equal(directory.stateRoot, whole.toString('hex'), 'the state of the directory, kept entry by entry, is not that of what it holds');
  });
  /** `options` go to AgentClient: { mls: true } for a client that keeps MLS state in memory, { state } for a store. */
  hub.agent = async (name, identity = generateIdentity(), options = {}) => {
    const client = new AgentClient({ hubUrl: hub.url, identity, ...options });
    clients.push(client);
    if (name) await client.register({ name });
    return client;
  };
  /** A client for any identity (an instance's, for one), closed with the hub. Registers nothing. */
  hub.client = (identity, options = {}) => {
    const client = new AgentClient({ hubUrl: hub.url, identity, ...options });
    clients.push(client);
    return client;
  };
  return hub;
}

/** An instance identity for the agent behind `agentIdentity`: a fresh key, and the agent's certificate for it. */
export function instanceOf(agentIdentity, options = {}) {
  const identity = generateInstanceIdentity();
  return attachCertificate(identity, createInstanceCertificate(agentIdentity, { instance: identity.instance.did, ...options }));
}

/**
 * The statement of its owner that goes with a new topic, for a test that asks the hub by hand:
 * what the SDK signs when it creates one. `signer` is the key that signs, when that is not the
 * owner's own.
 */
export function topicStatement(hub, owner, { name, description, schema, publish = 'any', subscribe = 'any', encryption = null }, { signer = owner } = {}) {
  const says = { topic: name, owner: owner.did, contract: contractHash({ name, description, schema }), publish, subscribe, encryption };
  return signStatement('topic.create', says, { hub: hub.did, signer });
}

/**
 * And the one that goes with a change of who may use it: `changes` are { publish, subscribe },
 * each given only if it changes, and `revision` says which change of the topic this is.
 */
export function policyStatement(hub, owner, { name, description, schema, encryption = null }, { publish = null, subscribe = null }, revision, { signer = owner } = {}) {
  const says = { topic: name, owner: owner.did, contract: contractHash({ name, description, schema }), encryption, publish, subscribe, revision };
  return signStatement('topic.policy', says, { hub: hub.did, signer });
}

/** A raw request signed by `signer` ({ did, privateKey }): what the SDK would refuse to send, the hub must refuse to accept. */
export async function signedFetch(hub, signer, method, path, body) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const res = await fetch(hub.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...signRequest(signer, method, hub.url + path, payload) },
    body: body === undefined ? undefined : payload,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, code: json?.error?.code ?? null };
}

/** Resolves if `promise` rejects with the given HTTP status and error code; fails the test otherwise. */
export async function rejects(promise, status, code) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HubError && err.status === status && err.code === code) return err;
    throw new Error(`expected ${status} ${code}, got ${err.status ?? ''} ${err.code ?? err.message}`);
  }
  throw new Error(`expected ${status} ${code}, but the call succeeded`);
}

export const errorText = (err) => err.message.replace(/^discarded inbox entry \d+: /, '');
