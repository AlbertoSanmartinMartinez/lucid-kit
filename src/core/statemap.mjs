// SPDX-License-Identifier: Apache-2.0
// A map that one hash tells: names to values, and a root that is another as soon as a name is added
// or a value changed. Whoever holds the root can be shown, with a handful of hashes, what the map
// has under one name - or that it has nothing there - without being given the rest of the map.
// It is what lets the state of one agent be checked against the log of a hub by somebody who has
// not read the log.
//
// The map is a binary tree over the SHA-256 of each name, taken bit by bit from the first:
//   - a part of the tree with no name in it is 32 zero bytes;
//   - a part with one name in it is that name's leaf, SHA-256(0x00 || SHA-256(name) || value),
//     however deep the part is;
//   - a part with more is SHA-256(0x01 || L || R), where L is the part with the names whose next
//     bit is 0 and R the part with those whose next bit is 1.
// A value is 32 bytes: the hash of whatever the map keeps under the name. The root is the tree
// with every name in it, so it depends on what the map holds and not on the order in which it
// came to hold it. A leaf starts with 0x00 and an inner node with 0x01, as in the tree of the
// log (merkle.mjs), so that one is never passed off as the other.
//
// A proof for a name is the other half of each fork on the way down to where the name is, or
// would be. Down there is the leaf of the name; or nothing; or the leaf of another name, alone in
// that part of the tree, which leaves no room for this one. For one root there is one answer:
// the same name cannot be shown both to be there and not, nor with two values, without two
// inputs of SHA-256 that hash alike.
//
// What it does not tell. That the root is the right one: a proof ties an answer to a root, and
// where the root comes from - who signed it, who else was shown the same - is for whoever uses
// this to say. Nor how many names there are, nor anything about the others. Names never leave:
// there is no taking one out.
//
// This tree is this project's own. It is the usual sparse Merkle tree with the parts that hold a
// single name cut short, so that a proof is as long as the logarithm of how many names there are
// and not 256 hashes; it follows no published format, because none was at hand to follow.

import { createHash } from 'node:crypto';

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);
const DEPTH = 256; // a path is a SHA-256
const HEX_RE = /^[0-9a-f]{64}$/;

/** The root of a map with nothing in it. */
export const EMPTY_STATE = Buffer.alloc(32);

const isHash = (value) => Buffer.isBuffer(value) && value.length === 32;
const pathOf = (name) => sha256(Buffer.from(name, 'utf8'));
/** Bit `depth` of a path, counting from the first bit of its first byte. */
const bit = (path, depth) => (path[depth >> 3] >> (7 - (depth & 7))) & 1;

// A part of the tree: null for nothing, a leaf { path, value, kept, hash } or a fork { left, right, hash }.
// None is ever changed once made: a map that moves on shares with what it was whatever stayed the same.
const hashOf = (part) => (part === null ? EMPTY_STATE : part.hash);
const leafOf = (path, value, kept) => ({ path, value, kept, hash: sha256(LEAF, path, value) });
const forkOf = (left, right) => ({ left, right, hash: sha256(NODE, hashOf(left), hashOf(right)) });
const isLeaf = (part) => part.path !== undefined;

/** Two leaves of different names that both belong at `depth`: forks down to where their paths part. */
function apart(one, other, depth) {
  const [here, there] = [bit(one.path, depth), bit(other.path, depth)];
  if (here !== there) return here ? forkOf(other, one) : forkOf(one, other);
  const below = apart(one, other, depth + 1);
  return here ? forkOf(null, below) : forkOf(below, null);
}

/** The part of the tree at `depth` once `leaf` is in it. */
function withLeaf(part, leaf, depth) {
  if (part === null) return leaf;
  if (isLeaf(part)) return part.path.equals(leaf.path) ? leaf : apart(part, leaf, depth);
  return bit(leaf.path, depth) ? forkOf(part.left, withLeaf(part.right, leaf, depth + 1)) : forkOf(withLeaf(part.left, leaf, depth + 1), part.right);
}

/** What the tree under `top` has for `name`: { value, kept, proof }, `value` null if the name is not there. */
function proveIn(top, name) {
  const path = pathOf(name);
  const siblings = [];
  let part = top;
  for (let depth = 0; part !== null && !isLeaf(part); depth++) {
    const right = bit(path, depth);
    siblings.push(hashOf(right ? part.left : part.right).toString('hex'));
    part = right ? part.right : part.left;
  }
  if (part !== null && part.path.equals(path)) return { value: part.value, kept: part.kept, proof: { siblings, other: null } };
  return { value: null, kept: undefined, proof: { siblings, other: part === null ? null : { path: part.path.toString('hex'), value: part.value.toString('hex') } } };
}

const checkEntry = (name, value) => {
  if (typeof name !== 'string') throw new TypeError('a name is a string');
  if (!isHash(value)) throw new TypeError('a value is 32 bytes');
};

/** A map that keeps its tree, so that its root and its proofs cost as much as the tree is deep and not as much as the map is large. */
export class StateMap {
  #top = null;

  /** The hash that tells the whole map. */
  get root() {
    return hashOf(this.#top);
  }

  /**
   * Puts `value`, 32 bytes, under `name`: a name that was there has that value from now on.
   * `kept` is whatever the caller wants to find again with the value - what it is the hash of,
   * say. It is given back by `prove` and is no part of the tree: it must not be changed afterwards.
   */
  set(name, value, kept = undefined) {
    checkEntry(name, value);
    this.#top = withLeaf(this.#top, leafOf(pathOf(name), Buffer.from(value), kept), 0);
  }

  /**
   * What the map has under `name`, and the proof of it for whoever holds its root:
   * { value, kept, proof }. If it has nothing there, `value` is null and the proof is of that.
   */
  prove(name) {
    if (typeof name !== 'string') throw new TypeError('a name is a string');
    return proveIn(this.#top, name);
  }

  /** The map as it is at this moment, { root, prove(name) }, for proofs asked for after it has moved on. It costs nothing to take and nothing to keep but what has changed since. */
  view() {
    const top = this.#top;
    return { root: hashOf(top), prove: (name) => proveIn(top, name) };
  }
}

/** The root of the map with those entries, [name, value] each, worked out from the definition and nothing else. */
export function stateRoot(entries) {
  const leaves = [];
  const seen = new Set();
  for (const [name, value] of entries) {
    checkEntry(name, value);
    if (seen.has(name)) throw new TypeError('a name is in a map once');
    seen.add(name);
    leaves.push({ path: pathOf(name), value });
  }
  const part = (list, depth) => {
    if (list.length === 0) return EMPTY_STATE;
    if (list.length === 1) return sha256(LEAF, list[0].path, list[0].value);
    return sha256(NODE, part(list.filter((leaf) => !bit(leaf.path, depth)), depth + 1), part(list.filter((leaf) => bit(leaf.path, depth)), depth + 1));
  };
  return part(leaves, 0);
}

const isProof = (proof) =>
  proof !== null &&
  typeof proof === 'object' &&
  Object.keys(proof).length === 2 &&
  Array.isArray(proof.siblings) &&
  proof.siblings.length <= DEPTH &&
  proof.siblings.every((hash) => typeof hash === 'string' && HEX_RE.test(hash)) &&
  (proof.other === null ||
    (typeof proof.other === 'object' &&
      Object.keys(proof.other ?? {}).length === 2 &&
      typeof proof.other.path === 'string' &&
      HEX_RE.test(proof.other.path) &&
      typeof proof.other.value === 'string' &&
      HEX_RE.test(proof.other.value)));

/**
 * Whether `proof` shows that the map of root `root` has `value` under `name` or, with `value`
 * null, that it has nothing under it. The proof is as `prove` gives it and as it travels: hashes
 * in hex. Anything that is not such a proof shows nothing. Never throws.
 */
export function verifyState(root, name, value, proof) {
  if (!isHash(root) || typeof name !== 'string' || (value !== null && !isHash(value)) || !isProof(proof)) return false;
  const path = pathOf(name);
  const depth = proof.siblings.length;
  let hash;
  if (value !== null) {
    if (proof.other !== null) return false;
    hash = sha256(LEAF, path, value);
  } else if (proof.other === null) {
    hash = EMPTY_STATE;
  } else {
    // Another name where this one would be, alone in that part of the tree. That it is the part
    // this name belongs to needs no looking at: the hashes are folded along the path of this
    // name, and the root only comes out if the leaf of the other sits on that path.
    const other = Buffer.from(proof.other.path, 'hex');
    if (other.equals(path)) return false;
    hash = sha256(LEAF, other, Buffer.from(proof.other.value, 'hex'));
  }
  for (let level = depth - 1; level >= 0; level--) {
    const sibling = Buffer.from(proof.siblings[level], 'hex');
    hash = bit(path, level) ? sha256(NODE, sibling, hash) : sha256(NODE, hash, sibling);
  }
  return hash.equals(root);
}
