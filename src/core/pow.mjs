// SPDX-License-Identifier: Apache-2.0
// Proof of work for registration.
//
// Creating a key is free, so registering one costs a little CPU: find a nonce
// such that SHA-256("agenthub/pow/v1\n<challenge>\n<did>\n<nonce>") starts with
// `difficulty` zero bits. Irrelevant for one honest agent, expensive for
// someone minting thousands of identities. The DID is part of the input, so
// work cannot be shared between identities.

import { createHash } from 'node:crypto';

const CONTEXT = 'agenthub/pow/v1';

function powHash(challenge, did, nonce) {
  return createHash('sha256').update(`${CONTEXT}\n${challenge}\n${did}\n${nonce}`).digest();
}

export function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function solvePow(challenge, did, difficulty) {
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(powHash(challenge, did, String(nonce))) >= difficulty) return String(nonce);
  }
}

export function verifyPow(challenge, did, nonce, difficulty) {
  if (typeof nonce !== 'string' || !/^[0-9]{1,20}$/.test(nonce)) return false;
  return leadingZeroBits(powHash(challenge, did, nonce)) >= difficulty;
}
