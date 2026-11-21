// SPDX-License-Identifier: Apache-2.0
// Direct conversations over MLS: names and rules shared by the hub and the SDK.
// Nothing here needs the MLS library.
//
// Two agents talk in one MLS group that holds every reader of both: each agent's own key, if it
// is used, and each of its instances. The group is made once, with everybody in it, and never
// changed. When the readers change (an instance is added or removed) the next sender makes a new
// group, one generation up, and the old one is left behind. The hub keeps, per pair of agents,
// which group is current; it settles who wins when two readers make the next one at the same time.

import { randomBytes } from 'node:crypto';
import { isValidDid } from '../core/didkey.mjs';

export const DIRECT_MLS = 'mls-v1';
const PREFIX = 'agenthub/dm/v1';
const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;

/** The two agents of a conversation in a fixed order, so both sides name it the same way. */
export const dmPair = (a, b) => (a < b ? [a, b] : [b, a]);
export const dmPairKey = (a, b) => dmPair(a, b).join('|');

/** A fresh group id for the conversation between `a` and `b` at `generation`. It says who it is for. */
export function dmGroupId(a, b, generation) {
  return [PREFIX, ...dmPair(a, b), generation, randomBytes(12).toString('base64url')].join('|');
}

/** Returns { pair, generation } if `id` is a well-formed conversation group id, or null. */
export function parseDmGroupId(id) {
  if (typeof id !== 'string' || id.length > 400) return null;
  const [prefix, low, high, generation, nonce, ...rest] = id.split('|');
  if (prefix !== PREFIX || rest.length > 0 || !isValidDid(low) || !isValidDid(high) || !(low < high)) return null;
  if (!/^[1-9]\d{0,8}$/.test(generation ?? '') || !NONCE_RE.test(nonce ?? '')) return null;
  return { pair: [low, high], generation: Number(generation) };
}

/** What ties an MLS ciphertext to the signed envelope that carries it: sender, recipient and event id. */
export const dmAad = (source, recipient, id) => new TextEncoder().encode(`${source}\n${recipient}\n${id}`);
