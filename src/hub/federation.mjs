// SPDX-License-Identifier: AGPL-3.0-only
// Federation: what one hub needs to talk to another.
//
// A hub has an identity of its own, an Ed25519 key like an agent's, and signs with it every
// request it makes to another hub. Two hubs are paired when the operator of each has given it
// the name it wants to call the other by, its address and its key. Nothing is discovered and
// nobody pairs on its own: a hub answers federation requests only from the keys it was given.
//
// The key matters in one direction and the address in the other. What a peer asks of this hub is
// authenticated by its signature. What this hub asks of a peer goes to the address the operator
// gave, and the answer is believed as far as that address is (TLS): `hello` exists so that an
// operator finds out, when pairing, whether whoever answers there holds the key it was told.
//
// None of this makes a peer trusted for what agents say. Events keep their author's signature,
// and whoever receives one checks it, whichever hubs it came through.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportIdentity, generateIdentity, importIdentity, isValidDid } from '../core/didkey.mjs';
import { CONTEXT, createProof, isPlainObject, verifyProof } from '../core/proof.mjs';
import { PEER_NAME_RE } from '../core/topicname.mjs';

export const FEDERATION_PROTOCOL = 'agenthub-federation/v1';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The key a hub signs with, and its DID. A hub needs no encryption key: it is never the reader of anything. */
const signingPart = ({ did, privateKey }) => ({ did, privateKey });

/**
 * The identity of the hub that keeps its data in `dataDir`: read from there, or made and saved
 * there the first time. A hub that keeps nothing on disk gets a new one every time it starts.
 */
export function loadOrCreateHubIdentity(dataDir, name = 'hub-identity.json') {
  if (!dataDir) return signingPart(generateIdentity());
  const file = join(dataDir, name);
  if (existsSync(file)) {
    try {
      return signingPart(importIdentity(JSON.parse(readFileSync(file, 'utf8'))));
    } catch {
      // The reason is left out on purpose: a parse error can quote the file, and the file holds a private key.
      throw new Error(`cannot load the identity of the hub in ${file}: the file is damaged`);
    }
  }
  const identity = signingPart(generateIdentity());
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(exportIdentity(identity), null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return identity;
}

/**
 * Checks what an operator says about a hub to pair with: { name, url, did }. `name` is how this
 * hub will call it, and how its topics will be named here ("topic@name"). Returns it cleaned up.
 */
export function checkPeer(peer, { own, others = [] }) {
  const bad = (message) => new Error(`invalid peer: ${message}`);
  if (!isPlainObject(peer)) throw bad('it must be { name, url, did }');
  const { name, url, did } = peer;
  if (typeof name !== 'string' || !PEER_NAME_RE.test(name)) throw bad('name must be 1-32 lowercase letters, digits or hyphens');
  if (typeof url !== 'string' || !URL.canParse(url)) throw bad(`the address of "${name}" is not a URL`);
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw bad(`the address of "${name}" must look like https://host:port`);
  if (!isValidDid(did)) throw bad(`the key of "${name}" must be its did:key`);
  if (did === own) throw bad(`"${name}" has the key of this hub: a hub does not pair with itself`);
  if (others.some((other) => other.name === name)) throw bad(`there is already a peer called "${name}"`);
  if (others.some((other) => other.did === did)) throw bad(`the key of "${name}" is already that of another peer`);
  return { name, url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, did };
}

/** A peer as the command line takes it: NAME=URL#DID. */
export function parsePeer(text) {
  const match = /^([^=]+)=(.+)#(did:key:[A-Za-z0-9]+)$/.exec(String(text));
  if (!match) throw new Error('a peer is given as NAME=URL#DID, for example acme=https://hub.acme.example#did:key:z6Mk…');
  return { name: match[1], url: match[2], did: match[3] };
}

/** Whether `value` is fit to be the challenge of a hello. */
export const isChallenge = (value) => typeof value === 'string' && CHALLENGE_RE.test(value);

/**
 * What a hub answers to a peer that asks who it is: a statement, signed with its key, that it is
 * `identity.did` talking to `peer`, with the challenge the peer chose. The challenge keeps an
 * old answer from being passed off as this one, and naming the peer keeps it from being passed on.
 */
export function signHello(identity, { peer, challenge }) {
  const hello = { hub: identity.did, peer, challenge };
  return { hello, proof: createProof(CONTEXT.FEDERATION_HELLO, hello, identity) };
}

/** Checks the answer to a hello. Returns null if `hub` signed it for `peer` and `challenge`, or what is wrong with it. */
export function checkHello(envelope, { hub, peer, challenge }) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.hello)) return 'the answer is not a hello';
  const { hello, proof } = envelope;
  if (hello.hub !== hub) return 'whoever answers at that address is another hub';
  if (hello.peer !== peer || hello.challenge !== challenge) return 'the answer was made for another question';
  const verdict = verifyProof(CONTEXT.FEDERATION_HELLO, hello, proof);
  if (!verdict.ok) return `the answer is not signed as it should be: ${verdict.error}`;
  if (verdict.did !== hub) return 'the answer is signed with another key';
  return null;
}
