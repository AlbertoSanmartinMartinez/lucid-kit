// SPDX-License-Identifier: Apache-2.0
// Per-request signatures.
//
// Every authenticated request is signed with the agent key over
//   "agenthub/request/v2" \n METHOD \n ORIGIN \n PATH?QUERY \n TIMESTAMP_MS \n NONCE \n SHA256(body)
// There are no bearer tokens: nothing the hub hands out can be stolen and
// reused, and a captured request cannot be replayed (timestamp window + nonce).
//
// ORIGIN is the address the client is talking to (scheme, host and port: https://hub.example.com),
// so that a request is good for one hub only. Without it, a hub that received a request could replay
// it, within the timestamp window, on another hub where the same agent is registered. The hub takes
// only requests signed for its own address, and TLS is what proves to the client that the server it
// talks to is that address: the hub has nothing else to prove. Version 1 signed no origin; those
// requests are refused.

import { createHash, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { publicKeyFromDid } from './didkey.mjs';

export const HEADERS = Object.freeze({
  DID: 'x-agenthub-did',
  TIMESTAMP: 'x-agenthub-timestamp',
  NONCE: 'x-agenthub-nonce',
  SIGNATURE: 'x-agenthub-signature',
  ORIGIN: 'x-agenthub-origin', // the origin the request is signed for, so that the hub can say which it was
});

export const REQUEST_SIGNATURE = 'agenthub/request/v2';

/**
 * The origin of an http(s) address as it is signed: the scheme, the host in lower case and the port
 * unless it is the scheme's default ("https://Hub.Example.com:443/x" -> "https://hub.example.com").
 * Null for anything else.
 */
export function originOf(address) {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function signingInput(method, origin, path, timestamp, nonce, body) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return Buffer.from([REQUEST_SIGNATURE, method.toUpperCase(), origin, path, String(timestamp), nonce, bodyHash].join('\n'), 'utf8');
}

/** Returns the headers that authenticate `method url` with the given body. `url` is absolute: the hub it is for is part of it. */
export function signRequest(identity, method, url, body = Buffer.alloc(0), now = Date.now()) {
  const origin = originOf(url);
  if (origin === null) throw new TypeError('a request is signed for an absolute http(s) address');
  const { pathname, search } = new URL(url);
  const nonce = randomBytes(16).toString('base64url');
  const signature = edSign(null, signingInput(method, origin, pathname + search, now, nonce, body), identity.privateKey);
  return {
    [HEADERS.DID]: identity.did,
    [HEADERS.TIMESTAMP]: String(now),
    [HEADERS.NONCE]: nonce,
    [HEADERS.ORIGIN]: origin,
    [HEADERS.SIGNATURE]: signature.toString('base64url'),
  };
}

/** Whether `signature` is `did`'s over that request, signed for `origin`. Whose address `origin` is, is for the caller to check. */
export function verifyRequest({ did, method, origin, path, timestamp, nonce, signature, body }) {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    if (typeof origin !== 'string' || originOf(origin) !== origin) return false;
    return edVerify(
      null,
      signingInput(method, origin, path, timestamp, nonce, body),
      publicKeyFromDid(did),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
